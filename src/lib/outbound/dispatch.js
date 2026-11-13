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
function payloadDigest({ to, subject, html }) {
  return LEDGER.digestOf({
    to: Array.isArray(to) ? to.join(', ') : String(to == null ? '' : to),
    subject, html,
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
function transmittedDigest(message) {
  const { to, subject, html, raw } = message || {};
  const recipients = Array.isArray(to) ? to.join(', ') : String(to == null ? '' : to);
  if (!raw) return LEDGER.digestOf({ to: recipients, subject, html });
  // `raw` is authoritative, and the recipients are kept in the hash so a redirect is caught even
  // if two messages share a body.
  return LEDGER.digestOf({ to: recipients, subject: `raw:${subject || ''}`, html: String(raw) });
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
  const { to, subject, html, raw } = message;
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

  // ── 3. INSIDE OR OUTSIDE? THIS DECIDES WHETHER APPROVAL IS MANDATORY ──────
  //
  // Refused if it cannot be decided. "I could not tell whether this leaves the company" is not a
  // reason to send it.
  let external;
  try {
    external = recipients.isExternal(to, env);
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

  // ── 5. THE LEDGER OPENS BEFORE AUTHORIZATION IS DECIDED ───────────────────
  //
  // So a REFUSAL is as durable as a send. A refusal nobody can audit is indistinguishable from a
  // bug, and the containment evidence is built from these rows.
  const actualDigest = transmittedDigest(message);

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
  if (expectedDigest && actualDigest !== expectedDigest) {
    const why = `the approved payload digest ${expectedDigest} does not match the message about to `
      + `be sent (${actualDigest}) — nothing was transmitted`;
    await att.blocked(why, 'approval:digest_mismatch');
    return refuse('digest_mismatch', why,
      { stopped: true, approvalId, expectedDigest, actualDigest });
  }

  // ── 8. THE POLICY GATE. UNCONDITIONAL. ────────────────────────────────────
  //
  // No parameter of this function can prevent this call from happening — the lesson of C-4, where
  // a caller-supplied flag replaced the gate result with `{ allowed: true }`.
  let decision;
  try {
    decision = await gate.assertSendAllowed({
      capability: 'email.send', workflow, agent, company: companyId, to,
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

/** The stable identifier for one logical submission. Exported so reports and controls agree. */
function dispatchIdFor(idempotencyKey) {
  return LEDGER.digestOf({ to: 'dispatch', subject: idempotencyKey, html: '' });
}

module.exports = { dispatch, registerTransport, knownTransports, payloadDigest,
                   transmittedDigest, dispatchIdFor, TRANSPORTS };
