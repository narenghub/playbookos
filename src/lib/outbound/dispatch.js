// ── ONE ROAD OUT. ────────────────────────────────────────────────────────────
//
//   const { dispatch } = require('./outbound/dispatch');
//
// Spec A milestone 5. Every outbound message to a person outside this company passes through
// dispatch() or it does not go.
//
// ── WHAT THIS FIXES ──────────────────────────────────────────────────────────
//
// Today there are two shapes of buyer-facing send, and only one is governed.
//
//   GOVERNED (inquiry-agent):
//     prepareBuyerEmail → a human approves → releaseBuyerEmail → frozen message + digest
//                       → sendEmailDetailed({ …, approvalId, expectedDigest })
//
//   UNGOVERNED (outreach-agent, cphi-runner):
//     own ledger attempt → assertSendAllowed → g.gmail.users.messages.send(…)
//
// The second has no approval boundary and no digest binding, and it does not go through the mailer
// at all — it talks to Gmail directly. Those two senders are what reached 25 real people between
// 3 and 10 November, and they are why `capability:email.send` holds ALL platform email today:
// with no per-path boundary, the only way to stop one sender was to silence every sender,
// including the 6pm scores, the briefings and the operator alerts.
//
// ── THE ONE DECISION THAT MATTERS HERE ───────────────────────────────────────
//
// In mailer.js, `approvalId` and `expectedDigest` are OPTIONAL parameters. That was deliberate and
// correct at the time — 55 callers had no approval boundary and inventing one for them inside the
// transport would have been a different change. But optional means the dangerous path is the
// default: a caller who simply does not pass them gets an ungoverned send.
//
// Here they are MANDATORY for any external recipient. Not "checked when supplied" — REQUIRED.
// A caller that omits them is refused before anything else happens. That inversion is the whole
// point of this module, and everything below is in service of it.
//
// ── CREDENTIAL ISOLATION ─────────────────────────────────────────────────────
//
// dispatch() takes no API key, no token, no password, and reads none from the environment. It
// resolves a TRANSPORT BY NAME from a registry and calls `send(message)`. The credential lives
// with the transport, which is today an in-process adapter and is intended to become a separate
// sender service holding the only copy of the provider credential. When that lands, nothing in
// this file changes: the registry entry is swapped for a client, and the application can no longer
// reach a provider even if every other control fails.
//
// ── FAIL CLOSED, EVERYWHERE ──────────────────────────────────────────────────
//
// Unknown transport, unclassifiable recipient, missing approval, digest mismatch, unreadable kill
// state, unavailable ledger, duplicate claim — every one of these REFUSES. There is no path
// through this function that reaches a provider without the approval, the digest and the gate all
// having been checked, and no parameter that can skip any of them.

'use strict';

const GATE = require('../email-gate');
const LEDGER = require('./ledger');
const RECIPIENTS = require('./recipients');
// The canonical approval binding (B7.6). The ledger's digestOf is an audit fingerprint; this is
// what authorizes a send. Both roads — here and mailer.js — use this one module.
const DIGEST = require('./approval-digest');
// B7.7. For the Resend road the envelope IS the message; for the Gmail road `raw` is, and Gmail
// derives its recipients from the headers inside those bytes. This module reads them.
const MIME = require('./mime-authorization');
// B7.9. Whether this platform may send AS the identity in the From line, for this company, through
// this provider account. B7.6b BINDS from/replyTo/provider account to an approval; this is whether
// they were authorized in the first place.
const SENDER = require('./sender-identity');

// ── THE TRANSPORT REGISTRY ──────────────────────────────────────────────────
//
// Name → { send(message) → { ok, id, error, providerResponded } }. A transport NEVER decides
// authorization; by the time it is called, every check has passed. Keeping it that dumb is what
// makes it safe to move out of process later.
const TRANSPORTS = Object.create(null);

function registerTransport(name, impl) {
  if (typeof name !== 'string' || !name) throw new Error('a transport needs a name');
  if (!impl || typeof impl.send !== 'function') throw new Error(`transport ${name} has no send()`);
  TRANSPORTS[name] = impl;
}

function knownTransports() {
  return Object.keys(TRANSPORTS).sort();
}

// ── THE PAYLOAD DIGEST ──────────────────────────────────────────────────────
//
// Computed from the bytes about to leave, not from what the caller claims to be sending.
//
// It DELEGATES to the ledger's digestOf, and the first draft of this file did not — it wrote its
// own sha256 over a slightly different string. That is the defect mailer.js names in the comment
// above its own approvedDigestOf: "a second implementation of the same hash is how a binding check
// quietly stops binding." Concretely, a message frozen by the approval boundary would have hashed
// one way at release and another way here, so every approved external send would have been refused
// as tampered — or, with the comparison written the other way round, none would have been bound at
// all. One expression of "the bytes that are leaving", and the test suite asserts the two agree.
// CANONICAL v2 since B7.6, and it still DELEGATES rather than hashing locally — now to
// approval-digest.js, the module mailer.js uses. The two roads therefore agree by construction,
// and the test suite asserts they produce the identical string for the same message. That
// assertion is what made this change safe to make at all: migrate one producer and leave the
// other, and every approved external send on the other road refuses.
function payloadDigest({ to, subject, html, text = null, cc = null, bcc = null,
  from = null, replyTo = null, companyId = null, attachments = null, raw = null,
  transport = null, mailbox = null }) {
  return DIGEST.approvalDigest({
    companyId, from, replyTo,
    // providerAccountOf, NOT a local expression. This call site had its own — `resend:<from>` —
    // while the sender service, recomputing the same binding in another process, used the bare
    // transport name. Both v2, both defensible, and every external send over that road refused
    // with what looked like a tampering alarm. One definition, in the digest module.
    providerAccount: DIGEST.providerAccountOf({ transport, mailbox, from }),
    to, cc, bcc, subject, html, text, attachments, raw,
  });
}

// ── THE DIGEST OF WHAT ACTUALLY LEAVES ──────────────────────────────────────
//
// payloadDigest above covers `to`, `subject` and `html`, which for the Resend path IS the message.
// The Gmail path is different: the bytes transmitted are `raw`, a prepared RFC822 blob, and
// `to`/`subject`/`html` are then only a description of it. Binding the description would leave the
// thing itself unbound — alter `raw`, keep the headers consistent, and the check passes while a
// different message goes. Found while writing the Gmail transport, which is the first caller where
// the two can differ.
//
// So the comparison is always against the payload that will be handed to the transport. With no
// `raw` this is byte-identical to payloadDigest, which keeps the mailer/approval-boundary path
// unchanged and is asserted by the test suite.
// CANONICAL v2 since B7.6. `raw` is now a FIELD OF THE ONE DEFINITION rather than a second hash
// shape — the previous version smuggled it in as `subject: 'raw:'+subject, html: raw`, which meant
// a with-raw message and a without-raw message were hashed by two different recipes. Two recipes
// is how a producer and a consumer each stay internally consistent and still disagree.
//
// With no `raw` this is byte-identical to payloadDigest, which keeps the mailer/approval-boundary
// path unchanged, and the test suite asserts that identity rather than trusting this sentence.
function transmittedDigest(message, { transport = null, companyId = null } = {}) {
  const { to, subject, html, text, cc, bcc, from, replyTo, raw, mailbox,
    attachments } = message || {};
  return payloadDigest({ to, subject, html, text, cc, bcc, from, replyTo, attachments, raw,
    // The transport and the company come from the DISPATCH CALL, not from the message. A message
    // is data a caller hands over; which transport carries it and which company is making the
    // send are decisions the governed path owns, and binding a caller-supplied value would let the
    // caller choose what its own approval covers.
    transport: transport || (message && message.transport) || null,
    companyId: companyId !== null ? companyId : ((message && message.companyId) || null),
    mailbox });
}

/**
 * Record a refusal that happens BEFORE the ledger would normally open.
 *
 * Step 5's comment says why refusals are ledgered at all: *"a refusal nobody can audit is
 * indistinguishable from a bug, and the containment evidence is built from these rows."* A B7.7
 * refusal is the single most interesting row this road can produce — somebody handed it a message
 * whose bytes name a recipient nothing judged — and it would otherwise be the one refusal with no
 * record, purely because the check has to run before the classification.
 *
 * Best-effort, and deliberately so: a security refusal must never become a ledger error. If the
 * ledger cannot be reached the send is still refused, and the only thing lost is the row.
 */
async function recordRefusal({ ledger, deps, message, transport, workflow, agent, companyId,
  approvalId, idempotencyKey, why, scope }) {
  try {
    const att = await ledger.beginAttempt({
      transport, provider: transport,
      to: message.to, subject: message.subject, html: message.html,
      workflow, agent, companyId, approvalId,
      claimRef: idempotencyKey,
      correlationId: idempotencyKey ? dispatchIdFor(idempotencyKey) : null,
      consequential: true,
    }, deps.ledgerDeps);
    if (att && att.ok && typeof att.blocked === 'function') await att.blocked(why, scope);
  } catch (_) { /* the refusal stands either way */ }
}

const refuse = (phase, error, extra = {}) => ({
  ok: false, id: null, phase, error, providerResponded: false, dispatched: false, ...extra,
});

/**
 * The only governed road to an outbound provider.
 *
 * @param {object}  m                  the message: { to, subject, html, from?, replyTo?, cc? }
 * @param {string}  transport          a registered transport name
 * @param {string}  idempotencyKey     stable per logical message; a repeat is refused, not resent
 * @param {string}  [approvalId]       REQUIRED when any recipient is external
 * @param {string}  [expectedDigest]   REQUIRED when any recipient is external
 * @param {string}  [workflow]         kill-switch scope
 * @param {string}  [agent]            kill-switch scope
 * @param {string}  [companyId]
 * @param {object}  [deps]             { gate, ledger, recipients, env, transports } for tests
 */
async function dispatch({
  message, transport, idempotencyKey,
  approvalId = null, expectedDigest = null,
  workflow = null, agent = null, companyId = null,
} = {}, deps = {}) {
  const env = deps.env || process.env;
  const gate = deps.gate || GATE;
  const ledger = deps.ledger || LEDGER;
  const recipients = deps.recipients || RECIPIENTS;
  const registry = deps.transports || TRANSPORTS;

  // Populate the registry on first use. Required lazily and only when the caller did not supply
  // its own registry, so importing this module does not pull googleapis into every process, a
  // test can register fakes without the real transports loading, and the require cycle between
  // this file and ./transports resolves in one direction only.
  if (!deps.transports) {
    try { require('./transports').registerDefaults(); } catch (e) {
      // A transport that cannot even be loaded must not read as "unknown transport" further down,
      // which would send a reader looking for a typo in a name that is perfectly correct.
      return refuse('refused_before_request',
        `the transport registry could not be loaded (${e.message}) — nothing was sent`);
    }
  }

  // ── 1. THE CALL ITSELF MUST BE WELL FORMED ────────────────────────────────
  if (!message || typeof message !== 'object') {
    return refuse('refused_before_request', 'dispatch requires a message object');
  }
  // `cc` and `bcc` are READ here, not merely spread onto the transport. The JSDoc has advertised
  // `cc` since this file was written and the code did not read it, which the recipient-coverage
  // scanner reported as a note: a caller supplying one had it silently dropped from every
  // authorization decision while the transports that happen to forward only explicit fields kept
  // it from reaching a provider. That made the hole depend on the transport rather than on the
  // gate, which is the wrong thing for it to depend on.
  const { to, subject, html, raw, cc = null, bcc = null } = message;
  // A BODY IN EITHER FORM. This required `html` specifically, which is right for the Resend path
  // and wrong for every Gmail one: there the body is `raw`, a prepared RFC822 blob, and `html` is
  // at best a copy of it. The deliverability probe passes raw with an empty html and would have
  // been refused as malformed on every run — a check that rejected a perfectly well-formed
  // message because it was well-formed in the other shape.
  if (!to || !subject || !(html || raw)) {
    return refuse('refused_before_request',
      'a message needs a recipient, a subject and a body (html or raw) — a partial message is not '
      + 'a draft, it is a bug');
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return refuse('refused_before_request',
      'dispatch requires an idempotencyKey: without one a retry cannot be told from a second message');
  }

  // ── 2. THE TRANSPORT MUST BE KNOWN ────────────────────────────────────────
  //
  // By name, from the registry. An unknown name is refused rather than defaulted — defaulting a
  // transport is how a message ends up leaving by a road nobody audited.
  const impl = registry[transport];
  if (!impl) {
    return refuse('refused_before_request',
      `unknown transport ${JSON.stringify(transport)}; registered: ${Object.keys(registry).sort().join(', ') || '(none)'}`);
  }

  // ── 2a. B7.7: THE BYTES NAME THE RECIPIENTS, SO THE BYTES ARE JUDGED ──────
  //
  // This must come BEFORE the classification below, and that ordering is the whole fix. The
  // classification decides whether an approval is MANDATORY. Judge the envelope `to` of a message
  // whose real recipients live in `raw`, and a blob addressed to a stranger under an envelope
  // addressed to a colleague needs no approval, acquires no digest, and leaves. It is before the
  // ledger for the same reason, so the refusal is recorded by hand rather than by being late.
  //
  // mime-authorization refuses malformed, ambiguous, conflicting and group-syntax headers, and
  // requires the recipient set in the bytes to be EXACTLY the envelope's. Nothing is stripped or
  // rewritten: a send whose destination is in question is refused, not repaired.
  let authorizedRecipients = null;
  let bytesSender = null;
  if (raw) {
    const verdict = MIME.authorizeRawMessage(message);
    if (!verdict.ok) {
      const why = `the raw message could not be authorized (${verdict.code}): ${verdict.reason}. `
        + 'Nothing was transmitted.';
      await recordRefusal({ ledger, deps, message, transport, workflow, agent, companyId,
        approvalId, idempotencyKey, why, scope: `mime:${verdict.code}` });
      return refuse('refused_before_request', why,
        { mimeVerdict: verdict.code, stopped: true });
    }
    authorizedRecipients = verdict.recipients;
    // The identity the TRANSMITTED BYTES claim. B7.7 has just established that this is the single
    // From header of the message and that the envelope, where it declares one, agrees — so this is
    // the identity to ask B7.9 about. Asking about the envelope `from` instead would ask about a
    // description of the message rather than the message.
    bytesSender = verdict.sender;
  }

  // ── 3. INSIDE OR OUTSIDE? THIS DECIDES WHETHER APPROVAL IS MANDATORY ──────
  //
  // Refused if it cannot be decided. "I could not tell whether this leaves the company" is not a
  // reason to send it.
  //
  // Judged over `to`, `cc`, `bcc` AND, when there is one, the recipient set read out of `raw` —
  // not `to` alone, which is what this was. `to` alone is the B7.2 defect on this road: an email
  // addressed to a colleague with an outside address in `cc` was classified internal, so the
  // approval requirement in step 4 never fired. email-gate.js has judged all three fields since
  // B7.2; dispatch handed it one of them.
  //
  // With `raw` present the two sets are equal by the check above, so the union is either of them.
  // It is written as a union anyway: a later change that relaxes the equality must not silently
  // narrow what gets classified.
  const everyRecipient = authorizedRecipients
    ? [...new Set([...MIME.envelopeAddresses(to, cc, bcc), ...authorizedRecipients])]
    : [to, cc, bcc].filter((x) => x !== null && x !== undefined);
  let external;
  try {
    external = recipients.isExternal(everyRecipient, env);
  } catch (e) {
    return refuse('refused_before_request',
      `the recipients could not be classified as inside or outside the company (${e.message})`);
  }

  // ── 4. THE INVERSION: APPROVAL AND DIGEST ARE REQUIRED, NOT OPTIONAL ──────
  if (external && (!approvalId || !expectedDigest)) {
    return refuse('refused_before_request',
      'an external recipient requires BOTH an approvalId and an expectedDigest. This is not a '
      + 'check that fires when they are supplied — they are required, and a caller that omits '
      + 'them is refused. Prepare the message through the approval boundary and release it.',
      { external: true, needsApproval: true });
  }

  // ── 4a. B7.9: IS THIS PLATFORM AUTHORIZED TO SEND AS THIS IDENTITY? ───────
  //
  // mailer.js:116 says what the old answer was, and has always said it: *"Any address on an
  // AUTHORIZED domain works, because the domain (not the individual address) is what Resend
  // authorizes."* That is a DELIVERABILITY fact about the provider standing in for a company
  // authorization. With the domain as the only check, any caller could send as naren@abiozen.com,
  // or as a departed director whose address is still on the domain.
  //
  // SCOPE, STATED HONESTLY: this is enforced here, on the governed external road, and NOT in
  // mailer.js, which has 55 internal callers that pass no `from` at all and rely on the platform
  // default. Covering them is the B7.9 remainder and it is recorded as such — enforcing it here
  // first is the bounded change, on the path where a wrong sender reaches a customer.
  //
  // Only for EXTERNAL sends, for the same reason approval is only mandatory for them: an internal
  // briefing from the platform default is not the hazard. An external message carries the identity
  // out of the building.
  if (external) {
    let senderVerdict;
    try {
      // WHICH FIELD CARRIES THE IDENTITY DEPENDS ON THE ROAD, and getting this wrong refused
      // every Gmail send. On the Resend road the sender is `from`, defaulted by the mailer. On the
      // Gmail road there is often no `from` at all: the identity is the `mailbox` whose credential
      // carries the message, and the `From:` header inside `raw`. Asking only about `from` reported
      // `sender_unestablished` for a send whose identity is established twice over.
      //
      // Order: the bytes first (what will actually appear in the From line, already parsed and
      // cross-checked against the envelope by B7.7), then the envelope, then the mailbox.
      senderVerdict = await (deps.senderIdentity || SENDER).authorizedSender({
        from: bytesSender || message.from || message.mailbox || null,
        replyTo: message.replyTo || null,
        companyId,
        // providerAccountOf, NOT a local expression. One definition, in the digest module — the
        // lesson of the two processes that each computed `resend:<from>` and the bare transport
        // name and refused every external send as tampering.
        providerAccount: DIGEST.providerAccountOf({ transport, mailbox: message.mailbox,
          from: message.from || null }),
      }, deps.senderDeps);
    } catch (e) {
      senderVerdict = { ok: false, code: 'sender_authorization_unknown',
        reason: `the sender declarations could not be consulted (${e.message})` };
    }
    if (!senderVerdict.ok) {
      const why = `this platform is not authorized to send as this identity `
        + `(${senderVerdict.code}): ${senderVerdict.reason}. Nothing was transmitted.`;
      await recordRefusal({ ledger, deps, message, transport, workflow, agent, companyId,
        approvalId, idempotencyKey, why, scope: `sender:${senderVerdict.code}` });
      return refuse('refused_before_request', why,
        { senderVerdict: senderVerdict.code, stopped: true });
    }
  }

  // ── 5. THE LEDGER OPENS BEFORE AUTHORIZATION IS DECIDED ───────────────────
  //
  // So a REFUSAL is as durable as a send. A refusal nobody can audit is indistinguishable from a
  // bug, and the containment evidence is built from these rows.
  // transport and companyId come from the dispatch call, so the binding covers which provider
  // account carries the message and which company is making the send — neither of which a caller
  // can choose by putting a field in `message`.
  const actualDigest = transmittedDigest(message, { transport, companyId });

  // ── THE STABLE DISPATCH IDENTIFIER ────────────────────────────────────────
  //
  // One logical submission, one id, written to correlation_id by BOTH layers. The application and
  // the sender service each keep their own audit row — separate responsibilities, neither removed —
  // and this is what lets a report tell "two records of one submission" from "two submissions".
  //
  // DERIVED from the idempotency key, not random. A random id per call would correlate the two
  // layers of ONE attempt and nothing more; derived, a retry under the same key lands on the same
  // correlation, so one key is one transmission by construction rather than by arithmetic. It is
  // hashed rather than used raw because the key is caller-supplied and correlation_id is indexed:
  // a bounded, opaque value keeps the index predictable and keeps recipient-shaped strings out of
  // a column that is read in bulk.
  const dispatchId = dispatchIdFor(idempotencyKey);
  let att;
  try {
    att = await ledger.beginAttempt({
      transport, provider: transport, to, subject, html,
      workflow, agent, companyId, approvalId,
      claimRef: idempotencyKey,
      correlationId: dispatchId,
      consequential: true,
    }, deps.ledgerDeps);
  } catch (e) {
    return refuse('refused_before_request', `the outbound ledger could not be reached (${e.message})`);
  }
  if (!att || !att.ok) {
    return refuse('refused_before_request',
      `the outbound ledger refused the attempt: ${(att && att.error) || 'no record created'}`);
  }

  // ── 6. IDEMPOTENCY — A REPEAT IS REFUSED, NEVER RESENT ────────────────────
  //
  // Gmail cannot unsend and Resend cannot either. If a prior attempt under this key already
  // CLAIMED responsibility, the honest answer is "this may already have gone", and sending again
  // to find out is the duplicate-RFQ defect wearing a different hat.
  // NOT `if (typeof ledger.priorClaim === 'function')`. That is what this was, and the real ledger
  // had no priorClaim — so the duplicate check existed in the tests, where the fake ledger supplied
  // one, and did nothing whatsoever in production. A control that is present in the double and
  // absent in the thing that runs is worse than no control, because it reads as covered.
  if (typeof ledger.priorClaim !== 'function') {
    await att.blocked('the ledger cannot answer whether this was already sent', 'idempotency_unknown');
    return refuse('refused_before_request',
      'this ledger provides no priorClaim(), so a duplicate cannot be distinguished from a first '
      + 'attempt — failing closed rather than risking a second send');
  }
  let prior;
  try {
    prior = await ledger.priorClaim(idempotencyKey, { excludeId: att.id }, deps.ledgerDeps);
  } catch (e) {
    await att.blocked(`idempotency could not be established (${e.message})`, 'idempotency_unknown');
    return refuse('refused_before_request',
      `whether this message was already sent could not be established (${e.message})`);
  }
  if (prior) {
    await att.blocked(`duplicate of ${prior.id} (${prior.outcome})`, 'duplicate_dispatch');
    return refuse('refused_duplicate',
      `a message with this idempotencyKey already reached ${prior.outcome}; not sending again`,
      { duplicateOf: prior.id, priorOutcome: prior.outcome });
  }

  // ── 7. THE APPROVAL MUST COVER THESE EXACT BYTES ──────────────────────────
  //
  // Checked here, at the last possible moment, against the bytes about to be transmitted. A
  // boundary that freezes a payload still has a joint between release and transmission, and
  // whatever carries it could carry something else.
  //
  // compareDigests, not `!==`, and for the same three reasons as mailer.js: a v1 approval cannot
  // establish the complete message and must be refused as needing FRESH APPROVAL rather than
  // reported as tampering; an actual digest that is not v2 means a producer was left behind and
  // two definitions of "the message" must never authorize a send; and only the third case is an
  // ordinary mismatch. A string comparison collapses all three into one unhelpful answer.
  if (expectedDigest) {
    const verdict = DIGEST.compareDigests({ approved: expectedDigest, actual: actualDigest });
    if (!verdict.ok) {
      const why = `the approved payload digest ${expectedDigest} cannot authorize the message about `
        + `to be sent (${actualDigest}): ${verdict.code} — ${verdict.detail}. Nothing was transmitted.`;
      await att.blocked(why, `approval:digest_${verdict.code}`);
      return refuse('digest_mismatch', why,
        { stopped: true, approvalId, expectedDigest, actualDigest,
          digestVerdict: verdict.code, needsFreshApproval: verdict.code === 'legacy_version' });
    }
  }

  // ── 8. THE POLICY GATE. UNCONDITIONAL. ────────────────────────────────────
  //
  // No parameter of this function can prevent this call from happening — the lesson of C-4, where
  // a caller-supplied flag replaced the gate result with `{ allowed: true }`.
  let decision;
  try {
    decision = await gate.assertSendAllowed({
      capability: 'email.send', workflow, agent, company: companyId,
      // All three recipient fields, and the addresses read out of `raw` folded into `to` when there
      // is one. assertSendAllowed has judged `to`+`cc`+`bcc` since B7.2 (`ALL_RECIPIENT_FIELDS`);
      // this call site passed `to` alone, so the coverage that fix built was never reached from the
      // governed road. The gate cannot judge a field it is not given.
      to: authorizedRecipients ? [...authorizedRecipients, to] : to,
      cc, bcc,
      approvalId, digest: actualDigest,
    }, deps.gateDeps);
  } catch (e) {
    await att.blocked(`the authorization gate could not be consulted (${e.message})`,
      'authorization_undetermined');
    return refuse('refused_before_request',
      `the authorization gate could not be consulted (${e.message}) — failing closed`);
  }
  if (!decision || !decision.allowed) {
    const why = (decision && decision.reason) || 'the gate returned no decision';
    await att.blocked(why, (decision && decision.scope) || 'authorization_undetermined');
    return refuse('stopped_by_policy', why, { stopped: true });
  }

  // ── 9. CLAIM, THEN TRANSMIT ───────────────────────────────────────────────
  //
  // Durable responsibility BEFORE the provider call. A crash between here and the response leaves
  // a row saying an attempt was made and its outcome is unknown — which is the truth, and is what
  // stops the next run reading "never attempted" and sending a second time.
  // ── THE CLAIM IS THE ARBITRATION POINT, AND ITS ANSWER IS OBEYED ──────────
  //
  // priorClaim() above gives the honest reason for the ordinary case, but it cannot be the
  // guarantee: two concurrent dispatches can both read "no prior claim" before either writes. The
  // claim itself decides, in one statement, against a unique index — and a gate whose answer is
  // computed and ignored is not a gate, which is the finding this repository has already recorded
  // once about assertSendAllowed.
  const claimed = await att.claim();
  if (!claimed || !claimed.ok) {
    return refuse(claimed && claimed.lost ? 'refused_duplicate' : 'refused_before_request',
      claimed && claimed.lost
        ? 'another attempt under this idempotencyKey claimed responsibility first; not sending again'
        : `responsibility could not be recorded (${(claimed && claimed.error) || 'unknown'}) — nothing was sent`,
      claimed && claimed.lost ? { concurrentClaim: true } : {});
  }

  let result;
  try {
    // ── THE ENVELOPE A TRANSPORT RECEIVES ───────────────────────────────────
    //
    // idempotencyKey and companyId belong here, and were MISSING. In-process transports ignore the
    // envelope entirely, so every unit test passed; the out-of-process sender client reads it to
    // build its request, forwarded `undefined` as the idempotency key, and the service refused
    // every real send as malformed. Found only by running the two together over a socket — neither
    // side's own suite could see it, because each was correct about itself.
    result = await impl.send({
      ...message,
      _dispatch: { approvalId, digest: actualDigest, workflow, agent, idempotencyKey, companyId,
        dispatchId },
    });
  } catch (e) {
    // The request may have reached the provider before this threw. OUTCOME_UNKNOWN, never
    // "failed" — the two differ in exactly the way that decides whether a retry is safe.
    await att.unknown(e.message);
    return { ok: false, id: null, phase: 'transport_unknown', error: e.message,
      providerResponded: false, dispatched: true, transport };
  }

  if (result && result.ok) {
    await att.accepted(result.id || null);
    return { ok: true, id: result.id || null, phase: 'provider_accepted', error: null,
      providerResponded: true, dispatched: true, transport, approvalId, digest: actualDigest,
      dispatchId,
      // Provider-specific facts the caller needs and dispatch must not interpret — a Gmail
      // threadId, for instance, which the agent stores and threads its next follow-up onto.
      meta: (result && result.meta) || null };
  }
  await att.rejected((result && result.error) || 'the transport reported no result');
  return { ok: false, id: null, phase: 'provider_rejected',
    error: (result && result.error) || 'the transport reported no result',
    providerResponded: !!(result && result.providerResponded), dispatched: true, transport };
}

/**
 * The stable identifier for one logical submission. Exported so reports and controls agree.
 *
 * `idempotencyHash`, NOT `digestOf`. This was `digestOf({ to: 'dispatch', subject: key, html: '' })`
 * — never a message digest, but it meant one function served both "these are the bytes a human
 * approved" and "this is a dedupe key". Moving the approval binding to v2 would then have silently
 * changed every dispatch id, and dispatch ids are what duplicate detection and the reports join
 * on. Two purposes, two functions; this one is deliberately unchanged by B7.6.
 */
function dispatchIdFor(idempotencyKey) {
  return LEDGER.idempotencyHash(idempotencyKey);
}

module.exports = { dispatch, registerTransport, knownTransports, payloadDigest,
                   transmittedDigest, dispatchIdFor, TRANSPORTS };
