const crypto = require('crypto');
const { assertSendAllowed } = require('./email-gate');
const CONTENT_DAY = require('./outbound/content-day');
const SENDER = require('./outbound/sender-identity');
const DIGEST_MOD = require('./outbound/approval-digest');
const LEDGER = require('./outbound/ledger');
// The CANONICAL approval digest (B7.6). Separate module from the ledger because the ledger's
// digestOf is an audit fingerprint and this is an authorization binding — one function serving
// both is how the binding quietly stopped binding.
const DIGEST = require('./outbound/approval-digest');

// NAMED, NOT INLINE, so the transport is discoverable by structure rather than by string.
// scripts/check-email-transport-coverage.js blanks string literals before matching — otherwise a
// provider URL inside a comment or a log line would register as a call site — which made this one,
// the oldest and best-governed transport in the repository, invisible to its own coverage check.
// An identifier survives the blanking; a string literal does not.
const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const { query } = require('./db');

// ── THE SENDER DOMAIN ─────────────────────────────────────────────────────────
//
// The default sender was `PlayNexa <naren@abiozen.com>` and it had been FAILING SINCE 4 AUGUST 2026.
// The Resend key is alive and restricted to sending; it is authorized for adificetechnologies.com and
// NOT for abiozen.com:
//
//   403  This API key is not authorized to send emails from abiozen.com
//
// 1,113 internal emails were lost to that over eight weeks — the 6pm score, the coaching emails, the
// briefings — and nothing surfaced it, because sendEmail() returns false and writes a row to email_log
// that nobody reads. The silence was the worse half of the bug; see alertSendFailure below.
//
// MAIL_FROM overrides this. Keep it on a domain the key is actually authorized for, or the same
// failure returns.
// One definition, shared with outbound/sender-identity.js, which must treat it as a declared
// platform identity. Reading it across the require cycle between these two modules returned
// undefined silently — see outbound/platform-sender.js.
const { PLATFORM_DEFAULT_FROM: DEFAULT_FROM } = require('./outbound/platform-sender');
function defaultFrom(env = process.env) {
  return env.MAIL_FROM || DEFAULT_FROM;
}

// STILL BROKEN, and it needs the Resend dashboard rather than code: the two senders that speak to
// people OUTSIDE the company are on abiozen.com, deliberately, because they are Abiozen's —
//   procurement-agent.js  supplier RFQs as palash@abiozen.com
//   inquiry-agent.js      buyer replies as sales@abiozen.com
// Those keep 403ing until abiozen.com is authorized for this key. Changing THEIR sender would be
// wrong: a supplier should not receive an Abiozen RFQ from a different company's domain.

async function logEmail({ to, subject, status, errorMessage }) {
  try {
    await query(
      `INSERT INTO email_log (id, to_email, subject, status, error_message) VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), to, subject, status, errorMessage || null]
    );
  } catch(e) { console.error('email_log write failed:', e.message); }
}

// A send failure that is CONFIGURATION, not one bad address, must be visible.
//
// This is the actual lesson of the eight-week outage: every layer did the right local thing (return
// false, log the row, do not crash the caller) and the aggregate was silence. A domain authorization
// failure will never fix itself and affects EVERY email, so it goes to the notifications bell where
// somebody sees it.
//
// product NULL = platform-wide, which requires the 'internal' pseudo-product (see products/held.js) —
// so staff see it and a partner account never does. Deduped to one per kind per day: the 6pm agent
// alone would otherwise write a row per recipient per evening.
async function alertSendFailure({ domain, detail }) {
  try {
    const title = `Email sending is broken for ${domain}`;
    const dup = await query(
      `SELECT 1 FROM notifications WHERE kind = 'email_channel' AND title = $1
         AND created_at > NOW() - INTERVAL '20 hours' LIMIT 1`, [title]);
    if (dup.rows.length) return;
    await query(
      `INSERT INTO notifications (product, kind, severity, title, body, link_page, created_at)
       VALUES (NULL, 'email_channel', 'error', $1, $2, 'settings', NOW())`,
      [title, `Resend refused every send from ${domain}. This is an API-key authorization problem, not a `
        + `bad recipient — no email from this domain is being delivered, and it will not recover on its own. `
        + `Authorize the domain on the Resend key, or point MAIL_FROM at a domain that is. Resend said: ${detail}`]);
    console.error(`[mailer] ALERT RAISED — sending from ${domain} is unauthorized: ${detail}`);
  } catch (e) {
    // An alert that cannot be written must not break the send path. Logged loudly instead.
    console.error(`[mailer] could not raise the send-failure alert: ${e.message}`);
  }
}

// ── ATTACHMENTS ───────────────────────────────────────────────────────────────
//
// Resend takes `attachments: [{ filename, content }]` with `content` BASE64 over the JSON API. A Buffer
// is accepted by their SDK but not by the raw endpoint, which is what this uses, so a Buffer is encoded
// here rather than at every call site — a caller that forgot would send `{"0":80,"1":75,...}`, which
// arrives as a file that will not open.
//
// 25 MB is Resend's documented limit for the whole message, and base64 inflates by a third. A send that
// would exceed it is refused HERE with a clear reason, because the provider's own error for an oversized
// message is generic and arrives after the upload.
const MAX_ATTACH_BYTES = 18 * 1024 * 1024;

function encodeAttachments(attachments) {
  if (!attachments) return { ok: true, list: null };
  if (!Array.isArray(attachments)) return { ok: false, error: 'attachments must be an array' };
  const list = [];
  let total = 0;
  for (const a of attachments) {
    if (!a || !a.filename || a.content == null) {
      return { ok: false, error: 'every attachment needs a filename and content' };
    }
    const buf = Buffer.isBuffer(a.content) ? a.content
      : (typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : null);
    if (!buf) return { ok: false, error: `attachment ${a.filename}: content must be a Buffer or base64` };
    if (!buf.length) return { ok: false, error: `attachment ${a.filename} is empty` };
    total += buf.length;
    list.push({ filename: String(a.filename), content: buf.toString('base64') });
  }
  if (total > MAX_ATTACH_BYTES) {
    return { ok: false, error: `attachments total ${(total / 1048576).toFixed(1)} MB, over the ${MAX_ATTACH_BYTES / 1048576} MB limit` };
  }
  return { ok: true, list };
}

// `from` / `replyTo` are optional overrides. Any address on an AUTHORIZED domain works, because the
// domain (not the individual address) is what Resend authorizes — verified by probe: both
// no-reply@ and playnexa@adificetechnologies.com were accepted with the same key.
//
// RETURNS { ok, id, error }. sendEmail() below keeps the boolean contract its 55 callers rely on; this
// exists because a caller that has to PROVE what it sent needs the provider's message id, and a boolean
// cannot carry one. Deliberately NOT done by changing sendEmail's return type to an object: every
// existing `if (await sendEmail(...))` would then be unconditionally true and every failure path in the
// codebase would go quiet — which is the exact shape of the eight-week outage this file already documents.
// ── workflow / agent ARE OPTIONAL AND ADDITIVE ──────────────────────────────
//
// The kill switch has always supported workflow and agent scopes; this function never passed them,
// so the ONLY scope that could reach an email was `capability:email.send` — which is every email
// in the platform. Containing one ungoverned external sender therefore meant silencing the 6pm
// scores, the briefings and the team tasks along with it.
//
// A caller that declares its workflow can now be stopped by name. A caller that declares nothing
// behaves exactly as before, so this adds precision without moving anything that already worked:
// an undeclared send is still covered by the capability and global scopes.
/**
 * The digest of a message as the approval boundary computes it — CANONICAL v2.
 *
 * Exported so the controls can drive it, and so there is ONE expression of "the bytes that are
 * leaving" rather than one here and another in buyer-email-approval.js.
 *
 * ── WHAT CHANGED, AND WHY IT HAD TO ──────────────────────────────────────────
 *
 * This used to be `LEDGER.digestOf({ to, subject, html })`, which bound the recipients in TO, the
 * subject and one body. It bound neither CC nor BCC — and on 2026-11-24 the gate was found not to
 * be reading CC either, so an outside address could be added to a message after approval and
 * nothing in the system would have noticed. It bound no company, so an approval for one company
 * authorized the same bytes sent as another. It bound no sender identity and no provider account,
 * so from/reply-to were caller-controlled and unbound. And `html || text` meant the text
 * alternative could be swapped freely.
 *
 * Every one of those fields reaches the recipient. A binding that omits them is a measurement
 * standing in for the property it claims to check.
 *
 * ── THE SENDER IS RESOLVED BEFORE THE DIGEST, NOT AFTER ──────────────────────
 *
 * `from` defaults inside deliverAuthorized (`from || defaultFrom()`). If the digest were computed
 * from the raw argument, every send that relies on the default would bind `from=null` while the
 * provider received a real address — the digest would have a sender field in it and still not bind
 * the sender. So sendEmailDetailed resolves the sender first and passes the resolved value both
 * here and onward. The default is left in place downstream as idempotent defence.
 *
 * `providerAccount` carries NO SECRET. It is the transport and the sending identity
 * (`resend:<from>`), never the API key: a key must not become a hash input that travels with
 * approval records and log lines.
 */
function approvedDigestOf({ to, subject, html, text = null, cc = null, bcc = null,
  from = null, replyTo = null, companyId = null, attachments = null }) {
  return DIGEST.approvalDigest({
    companyId, from, replyTo,
    // providerAccountOf, not a local expression: three producers each wrote their own and two of
    // them disagreed across a process boundary. The transport here is always Resend.
    providerAccount: DIGEST.providerAccountOf({ transport: 'resend', from }),
    to, cc, bcc, subject, html, text, attachments,
  });
}

// ── EVERYTHING AFTER A SEND HAS BEEN AUTHORIZED ──────────────────────────────
//
// MODULE-PRIVATE. NOT EXPORTED. Contains NO authorization logic, and has no way to express one.
//
// This exists because the alert path and the ordinary path share a provider call, a ledger row
// and a result shape, and the previous way of sharing them was a second positional argument on the
// EXPORTED sendEmailDetailed:
//
//     const gate = internal.alertAlreadyAuthorized ? { allowed: true } : await assertSendAllowed(...)
//
// Any of the 22 modules that import this file could pass it and transmit with no kill switch, no
// approval boundary, no recipient restriction and no digest check. The comment beside it said no
// existing caller could reach it, which was true of the callers that existed and is not a
// mechanism. There is no test that would have caught a new one.
//
// A module-private Symbol as the key would have closed the forgery and left the exported function
// still holding a bypass mode. Extracting the shared half instead means there is no bypass to
// reach, by any key: the gate in sendEmailDetailed is not conditional on anything a caller can
// supply, because the branch no longer exists.
//
// The body below is a MOVE, not a rewrite — byte-identical to what sendEmailDetailed ran after its
// gate — so provider behaviour, email_log, the ledger transitions and the returned object are
// unchanged. `att` is PASSED IN rather than re-created: the claim must be written against the same
// row the caller opened, or a refusal and its send would be two different attempts.
async function deliverAuthorized({ to, subject, html, from, replyTo, cc, attachments }, att) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log('No RESEND_API_KEY');
    await logEmail({ to, subject, status: 'failed', errorMessage: 'RESEND_API_KEY not configured' });
    return { ok: false, id: null, error: 'RESEND_API_KEY not configured',
      phase: 'refused_before_request', providerResponded: false };
  }
  const enc = encodeAttachments(attachments);
  if (!enc.ok) {
    // Refused before the request, and still logged: an attachment problem is a send that did not happen,
    // and email_log is where somebody looks for that.
    await logEmail({ to, subject, status: 'failed', errorMessage: enc.error });
    return { ok: false, id: null, error: enc.error, phase: 'refused_before_request',
      providerResponded: false };
  }
  try {
    const sender = from || defaultFrom();
    const body = { from: sender, to, subject, html };
    if (replyTo) body.reply_to = replyTo;
    if (cc) body.cc = cc;
    if (enc.list) body.attachments = enc.list;
    // CLAIMED before the provider call. A crash between here and the response leaves a row saying
    // an attempt was made and its outcome is unknown — which is the truth, and is what stops the
    // next run reading "never attempted" and sending a second time.
    // claim() now ARBITRATES and reports, so its answer must be read here too: a second attempt
    // under the same claimRef loses the claim and must not reach Resend.
    const claimed = await att.claim();
    if (claimed && claimed.ok === false) {
      return { ok: false, id: null, error: claimed.error, stopped: false,
        providerResponded: false, dispatched: false,
        duplicate: !!claimed.lost };
    }
    const res = await fetch(RESEND_EMAILS_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    const ok = !!data.id;
    // The attachment CONTENT is never logged — it is base64 of a document, it would be megabytes, and the
    // interesting facts are the filename and the size.
    console.log('Email result:', JSON.stringify(data),
      enc.list ? `(${enc.list.length} attachment(s): ${enc.list.map(a => a.filename).join(', ')})` : '');
    if (ok) await att.accepted(data.id);
    else await att.rejected(data.message || JSON.stringify(data));
    if (!ok) {
      // "not authorized to send emails from X" is the one failure that is about the CHANNEL rather than
      // the message, so it is the one that gets escalated out of the log.
      const m = /not authorized to send emails from ([^"'\s]+)/i.exec(String(data.message || ''));
      if (m) await alertSendFailure({ domain: m[1], detail: JSON.stringify(data) });
    }
    // The provider RESPONDED. Whether it accepted or rejected, the answer is definite — this is
    // not a case where acceptance "cannot be ruled out".
    return { ok, id: data.id || null, error: ok ? null : (data.message || JSON.stringify(data)),
      phase: ok ? 'provider_accepted' : 'provider_rejected', providerResponded: true,
      provider: 'resend' };
  } catch(e) {
    // ── THE KNOWN UNKNOWN ────────────────────────────────────────────────────
    //
    // fetch threw, or the response body could not be parsed. The request may have reached Resend
    // and been accepted before this failed. Collapsing this into the same state as a definite
    // provider rejection is exactly what ruling §11 forbids: one means nothing was sent, the other
    // means nobody knows, and a retry decision differs completely between them.
    console.error('Email error:', e.message);
    // OUTCOME_UNKNOWN, not failed. The comment above says this is the known unknown; the row said
    // 'failed', which is a claim that nothing was sent. The two differ in exactly the way that
    // decides whether a retry is safe, and the ledger now records the difference instead of
    // flattening it. Never eligible for automatic retry.
    await att.unknown(e.message);
    return { ok: false, id: null, error: e.message, phase: 'transport_unknown',
      providerResponded: false, provider: 'resend' };
  }
}

async function sendEmailDetailed({ to, subject, html, from, replyTo, cc, attachments,
  capability = 'email.send', workflow = null, agent = null, companyContext = null,
  approvalId = null, expectedDigest = null,
  // B7.13. Deliberately NOT defaulted: an absent declaration is refused, because a default would
  // make every existing caller opt out by forgetting and the control decorative. A message that
  // genuinely concerns no business day declares CONTENT_DAY.TIMELESS, which somebody has to type.
  contentDay = undefined,
  // B7.13: WHY a message concerns no business day, from a closed vocabulary. Threaded rather than
  // defaulted for the same reason contentDay is: a default would let any caller declare itself
  // timeless, which is the replay bypass in one word.
  timelessKind = null,
  // B7.13 provenance: a POINTER to a persisted business record, from which the day is READ. A
  // caller may supply this or `contentDay`, never both — see outbound/content-day.js.
  contentDayFrom = null },
// ── deps IS A SECOND ARGUMENT, NOT PART OF THE MESSAGE ─────────────────────
//
// B7.9a needs `authorizedSender`, which reads `users` to honour the deactivated-account override
// that outranks every declaration — so it refuses when there is no database, correctly. The
// database-free tests of this file need a seam, and `dispatch.js` already established its shape:
// `deps.senderIdentity`, in a SEPARATE argument. That separation is the whole point. A seam carried
// inside the message options would let any caller hand the mailer its own authorizer, which is a
// bypass wearing the clothes of a test fixture — and the 37 production callers all pass one
// argument, so they cannot reach it.
deps = {}) {
  // ── THE KILL SWITCH, BEFORE THE PROVIDER CALL ────────────────────────────
  //
  // Placed here rather than at each of the ~37 routes and 37 crons that can cause an email, so
  // every path is covered and a path added tomorrow is covered by default.
  //
  // The return contract is deliberately unchanged: { ok:false, id:null, error }. sendEmail() still
  // returns false and its 55 callers are untouched — changing the shape here is how the eight-week
  // outage documented above would be re-created. What makes a policy stop distinguishable from an
  // ordinary send failure is not the return value but the record: email_log gets
  // status='stopped_by_policy' where somebody looks for a send, and autonomy_events gets a REFUSED
  // row that cannot later be read as a provider problem.
  //
  // ── ONE EXEMPTION, AND WHY IT IS NOT A LOOPHOLE ──────────────────────────
  //
  // `email.alert` — the cron-failure channel — is checked as NON-consequential, which means a
  // global/company/agent/workflow stop does not silence it, and neither does an unreadable
  // kill-state. It remains stoppable by an explicit `capability:email.alert` stop.
  //
  // Without this the oversight channel dies with the database: Postgres goes down, every cron is
  // halted fail-closed, the alert explaining that is ALSO refused, and a total outage becomes
  // silence plus a console line. That is precisely the failure commit 1eba5e9 fixed this morning,
  // re-created by the safety control.
  //
  // It is narrow by construction, not by promise: an alert goes only to ALERT_EMAIL/ADMIN_EMAIL
  // from a fixed template, so the exemption cannot carry autonomous business email. And it reuses
  // the approved THINKING-vs-ACTING rule rather than inventing a bypass — telling a human what
  // broke is observability, in the same class as analysis, not autonomous action.
  // ── THE GATE LIVES IN src/lib/email-gate.js, NOT HERE ────────────────────
  //
  // It was inline, and inline was the problem: it covered every caller of THIS file and nothing
  // else, while two Gmail transports sent with no kill-switch check at all. One shared decision
  // function means the three transports cannot drift, and a scanner can assert that every provider
  // call site passes through it — which a comment cannot.
  //
  // The exemption is also checked there rather than asserted: `email.alert` is honoured only when
  // the recipient is an operator address, so an ordinary message cannot relabel itself as an alert
  // and transmit through a global stop. That was previously true only of the one caller that used
  // it, and enforced nowhere.
  // ── THE EXEMPTION CANNOT BE REQUESTED ────────────────────────────────────
  //
  // A caller-supplied `email.alert` is DOWNGRADED here, every time, with no way to opt out. The
  // capability was an ordinary parameter, so any code in this repository could pass it with an
  // arbitrary recipient and arbitrary HTML and transmit straight through a CEO hold. It was
  // documented as narrow and enforced nowhere.
  //
  // The exemption is now reachable only through sendOperatorAlert() below, which takes a TYPE and
  // FIELDS — no `to`, no `html`, no `subject`, no `capability`. A caller cannot express the
  // dangerous message, so there is nothing to validate. CEO authorization 2026-11-10 item B.
  const effectiveCapability = capability === 'email.alert' ? 'email.send' : capability;
  if (effectiveCapability !== capability) {
    console.warn(`[email] a caller requested capability '${capability}' directly; downgraded to `
      + `'email.send'. Operator alerts go through sendOperatorAlert().`);
  }
  // The downgrade now has NO exception. It used to be paired with a note saying transmitAlert had
  // already passed the gate and was therefore exempt from everything below — which described the
  // bypass as though the bypass were the safeguard. transmitAlert no longer calls this function at
  // all: it gates, opens its own attempt, and calls deliverAuthorized(). So every caller that
  // reaches this line is gated here, and the question of who is exempt does not arise.
  // ── THE LEDGER ATTEMPT OPENS BEFORE AUTHORIZATION IS DECIDED ─────────────
  //
  // So that a REFUSAL is recorded as durably as a send. A refusal that leaves no row is a decision
  // nobody can audit, and the whole point of the containment evidence is being able to say which
  // attempts were refused and why.
  //
  // It also fails CLOSED: no record, no consequential send. Observability mail is the documented
  // exception, for the same reason the kill switch exempts it.
  // THE SENDER AND THE BINDING, COMPUTED BEFORE THE LEDGER ROW IS OPENED.
  //
  // Order matters for two separate reasons, both learned the hard way.
  //
  // `from` defaults inside deliverAuthorized (`from || defaultFrom()`). Computing the binding from
  // the raw argument would bind `from=null` on every send that relies on the default, while the
  // provider received a real address — a digest with a sender field in it that does not bind the
  // sender. So the sender is resolved ONCE, here, and the resolved value goes to the binding, to
  // the ledger and to the transport.
  //
  // And the binding is computed before `beginAttempt` so the ledger's `payload_digest` IS the
  // canonical digest rather than the v1 fingerprint. Otherwise the audit row and the approval it
  // names describe the same message in two different languages.
  const resolvedFrom = from || defaultFrom();
  const actualDigest = approvedDigestOf({
    to, cc, bcc: null, subject, html, text: null,
    from: resolvedFrom, replyTo: replyTo || null,
    companyId: companyContext && companyContext.companyId ? companyContext.companyId : null,
    attachments,
  });

  const att = await LEDGER.beginAttempt({
    transport: 'resend', provider: 'resend', to, subject, html,
    // ALWAYS consequential. This was `!internal.alertAlreadyAuthorized`, so a caller could
    // downgrade the ledger's own classification of its send in the same argument that skipped
    // the gate. The alert path opens its own non-consequential attempt in transmitAlert().
    workflow, agent, approvalId, consequential: true, payloadDigest: actualDigest,
  });
  if (!att.ok) {
    return { ok: false, id: null, error: att.error, phase: 'refused_before_request',
      providerResponded: false, stopped: false };
  }

  // ── IS THE ARTEFACT THAT WAS APPROVED THE ARTEFACT THAT IS LEAVING? ──────
  //
  // An approval boundary that freezes a payload still has one joint: between the release of the
  // frozen text and the provider call, SOMETHING has to carry it, and whatever carries it could
  // carry something else. "A human approved email A, email B went out, and the row says approved
  // either way" is the failure, and it is not hypothetical — office/approval.js exists because the
  // old queue recorded approvals for actions already taken.
  //
  // So the binding is checked HERE, at the last possible moment, against the same digest function
  // the ledger uses. Not in the agent: a check upstream of the transport leaves exactly the window
  // it is meant to close. The caller states the digest it had approved; this recomputes it from
  // the bytes actually about to be transmitted, and refuses if they differ.
  //
  // Opt-in by parameter, because 55 callers have no approval boundary and inventing one for them
  // here would be a different change. When a digest IS supplied, it is enforced absolutely — there
  // is no mode in which a mismatch proceeds.
  // Computed unconditionally now, not only when an expectedDigest was supplied: the approval gate
  // in email-gate.js needs it for EVERY external send in order to tie an approval to these bytes.
  if (expectedDigest) {
    // compareDigests, not `!==`. A string comparison answers "do these differ" and cannot tell
    // apart the three cases that need different handling, which is why it was replaced:
    //
    //   legacy_version     the approval carries a v1 digest. It bound TO, the subject and one
    //                      body, so it CANNOT establish the company, sender, provider account,
    //                      CC/BCC, both bodies or attachments of the message it supposedly
    //                      authorized. It is REFUSED and fresh approval is required. Nothing about
    //                      the message has necessarily changed — the approval was never specific
    //                      enough to show that it hadn't. Accepting it "because the bytes look the
    //                      same" would mean honouring a binding that does not bind, which is the
    //                      whole defect B7.6 exists to close.
    //   actual_not_current a PRODUCER has not been migrated. Refused rather than compared: two
    //                      different definitions of "the message" must never authorize a send.
    //   mismatch           the ordinary case — the bytes changed after approval.
    //
    // This refusal is safe to make strictly because `capability/email.send` is STOPPED in
    // production and has been since 2026-11-03, so no live approval is in flight behind it. A
    // stored v1 approval becomes a re-approval request, not a lost send.
    const verdict = DIGEST.compareDigests({ approved: expectedDigest, actual: actualDigest });
    if (!verdict.ok) {
      const why = `approved payload digest ${expectedDigest} cannot authorize the message about to `
        + `be sent (${actualDigest}): ${verdict.code} — ${verdict.detail}. Nothing was transmitted.`;
      console.error(`[DIGEST ${verdict.code.toUpperCase()}] ${approvalId || '(no approval id)'}: ${why}`);
      await att.blocked(why, `approval:digest_${verdict.code}`);
      return { ok: false, id: null, error: why, phase: 'digest_mismatch',
        digestVerdict: verdict.code, needsFreshApproval: verdict.code === 'legacy_version',
        providerResponded: false, stopped: true, approvalId, expectedDigest, actualDigest };
    }
  }

  // UNCONDITIONAL. No parameter of this function can prevent this call from happening.
  //
  // `cc` is passed because deliverAuthorized transmits it (body.cc, line ~190) and until
  // 2026-11-24 the gate was called with `to` alone — so an outside address in cc reached the
  // provider without ever being classified, and the external-approval boundary never saw it. Any
  // field below that reaches the provider must appear in this call; that is the whole contract of
  // this line, and check-email-gate-recipient-coverage.js is what keeps it true.
  // ── companyContext: WHO THIS SEND IS BY, AND WHY IT IS NOT OPTIONAL ──────
  //
  // `cc` is passed because deliverAuthorized transmits it and the gate was once called with `to`
  // alone, so an outside address in cc reached the provider unclassified.
  //
  // `companyContext` is passed because "internal" is now scoped to a company: an active employee
  // of Adifice is not internal to a send ABIOZEN is making. It must be the BRANDED object from
  // office/context.js — a run context, an authenticated read session, or a mapped scheduled
  // workflow. A caller that has none gets no internal recipients at all, every address falls to
  // the approval boundary, and an unapproved internal send refuses.
  //
  // THAT IS WHY CALLERS MUST THREAD IT, and why they cannot be left alone: until a caller supplies
  // one, its internal mail does not go out. Fail-closed is the correct default here — the
  // alternative is sending as whichever company the caller named — but it is a state to finish
  // moving through, not to sit in.
  // ── B7.13: DATED CONTENT MAY NOT ARRIVE LATE ─────────────────────────────
  //
  // Before the kill switch rather than after, because this is the cheaper and blunter question and
  // a message whose content is three weeks old should not consume an authorization decision. The
  // measured risk is NOT a backlog flushing — there is no path in this repository that enumerates
  // refused rows and re-attempts them — it is a human releasing an old approval, or a cron firing
  // against a stale row, so that a message saying "your tasks for 5 November" lands on 1 December.
  // That is worse than silence, because it is wrong rather than absent, and it lands on four
  // people at once.
  const day = await CONTENT_DAY.assertContentDayCurrent(
    { contentDay, contentDayFrom, timelessKind, capability: effectiveCapability },
    deps.contentDayDeps);
  if (!day.allowed) {
    console.warn(`[CONTENT_DAY_REFUSED] email to ${to}: ${day.reason}`);
    await att.blocked(day.reason, `content_day:${day.code}`);
    return { ok: false, id: null, error: day.reason, stopped: true, phase: day.code,
      providerResponded: false };
  }

  // ── B7.9a: THE SENDER IS AN AUTHORIZED IDENTITY, ON THE INTERNAL ROAD TOO ─
  //
  // B7.9 enforced this in `dispatch` for EXTERNAL sends and said so: *"mailer.js's 55 internal
  // callers are NOT covered — that is B7.9a."* This is that road. The defect it closes is written
  // in this file's own history: for as long as the domain was the only check, any caller could send
  // as `palash@abiozen.com` — the departed Procurement Director whose address appearing on the
  // outside of a customer letter this repository has already recorded once.
  //
  // MEASURED before wiring it, against an empty `sender_identities` table: the platform default
  // (MAIL_FROM / RESEND_FROM) is authorized through the narrowed env fallback, so existing internal
  // sends keep working; an undeclared address is refused; and `palash@abiozen.com` is refused. So
  // enforcement closes the hole without silently stopping the internal loop — which is the only
  // reason it can land before the owner declares the production identities.
  let senderVerdict;
  try {
    senderVerdict = await (deps.senderIdentity || SENDER).authorizedSender({
      from: resolvedFrom,
      replyTo: replyTo || null,
      companyId: (companyContext && companyContext.companyId) || null,
      // providerAccountOf, not a local expression: the lesson of two processes that each computed
      // their own `resend:<from>` and refused every external send as tampering.
      // The BARE address. `resolvedFrom` may be `Name <addr>`, and passing the display form
      // produced `resend:playnexa <no-reply@…>` — a provider account matching no declaration, so
      // every send refused for a reason that was about my call rather than about the sender.
      providerAccount: DIGEST_MOD.providerAccountOf({
        transport: 'resend', from: SENDER.oneAddress(resolvedFrom) || resolvedFrom }),
    }, deps.senderDeps);
  } catch (e) {
    // Unreadable declarations are a refusal, not a pass. An authorization that cannot be consulted
    // is not an authorization that holds.
    senderVerdict = { ok: false, code: 'sender_authorization_unknown',
      reason: `the sender declarations could not be consulted (${e.message})` };
  }
  if (!senderVerdict.ok) {
    const why = `this platform is not authorized to send as ${resolvedFrom} `
      + `(${senderVerdict.code}): ${senderVerdict.reason}`;
    console.warn(`[SENDER_NOT_AUTHORIZED] email to ${to}: ${why}`);
    await att.blocked(why, `sender:${senderVerdict.code}`);
    return { ok: false, id: null, error: why, stopped: true, phase: senderVerdict.code,
      providerResponded: false };
  }

  const gate = await assertSendAllowed({ capability: effectiveCapability, workflow, agent, to, cc,
    companyContext, approvalId, digest: actualDigest });
  if (!gate.allowed) {
    console.warn(`[STOPPED_BY_POLICY] email to ${to}: ${gate.reason}`);
    // BLOCKED, with the scope that blocked it — the database refuses the row without one. The
    // return shape deliberately does not change, because 55 callers read it as a boolean.
    // gate.scope, not a locally rebuilt string: an approval refusal has no stop row, and the old
    // fallback would have filed it as an unreadable kill switch.
    await att.blocked(gate.reason, gate.scope || 'authorization_undetermined');
    return { ok: false, id: null, error: gate.reason, stopped: true, phase: 'stopped_by_policy',
      providerResponded: false };
  }

  // The gate above has run. Nothing below decides authorization.
  // `from: resolvedFrom`, not `from`. The digest above bound resolvedFrom; handing the raw `from`
  // down here would let defaultFrom() be applied a second time, and the ONE thing a binding must
  // guarantee is that the value it hashed is the value that goes.
  return deliverAuthorized({ to, subject, html, from: resolvedFrom, replyTo, cc, attachments }, att);
}

// The original contract, unchanged: a boolean. Every existing caller keeps working.
async function sendEmail(opts) {
  const r = await sendEmailDetailed(opts);
  return r.ok;
}

// ── SEND, AND SAY SO WHEN IT DOES NOT ────────────────────────────────────────
//
// sendEmail returns false and does not throw. That is the right local behaviour — a refused
// message must not crash a cron halfway through work it has already done — and it has one
// consequence that has cost this project dearly: a caller that ignores the boolean cannot tell a
// delivered message from a refused one. 1,113 emails were lost over eight weeks exactly that way,
// and the post-mortem's own words are "every layer did the right local thing and the aggregate
// was silence".
//
// Seventeen call sites still dropped it. Rather than seventeen hand-written console.errors that
// each say something slightly different, there is one wrapper, so every failure is reported in
// the same findable shape with the provider's own reason attached.
//
// It returns the boolean, so a caller that wants to branch still can. What it removes is the
// option of not knowing.
//
// `context` is what the operator needs in order to find it: which job, about what. "procurement
// weekly summary", not "email".
async function sendEmailOrReport(opts, context) {
  const r = await sendEmailDetailed(opts);
  if (!r.ok) {
    // One line, one tag, everything needed to act: what it was, who it was for, why it failed,
    // and how far it got. `phase` distinguishes "refused before we tried" from "the provider
    // never answered", which are different problems with different fixes.
    console.error(
      `[EMAIL FAIL] ${context || 'unlabelled send'} → ${opts && opts.to} `
      + `· "${opts && opts.subject}" · ${r.phase || 'unknown phase'} · ${r.error || 'no reason given'}`);
  }
  return r.ok;
}


// ── THE ONE PRIVILEGED PATH ──────────────────────────────────────────────────
//
// It takes a TYPE from a fixed set and a bag of FIELDS. Everything that makes a message dangerous
// — recipient, subject, body — is constructed by src/lib/alerts.js from a template it owns, with
// every field escaped. There is no parameter through which a caller can put chosen content in
// front of an operator under an exemption that bypasses a hold.
//
// It calls the transport directly rather than going through sendEmailDetailed, because that
// function now downgrades `email.alert` unconditionally — which is the point, and would silence
// this path too.
async function sendOperatorAlert({ type, fields = {} }, deps = {}) {
  const ALERTS = deps.alerts || require('./alerts');
  const built = ALERTS.buildAlert({ type, fields }, { env: deps.env || process.env });
  if (!built.ok) {
    console.error(`[ALERT NOT SENT] ${type}: ${built.error}`);
    return { ok: false, id: null, error: built.error, phase: 'refused_before_request',
      providerResponded: false };
  }
  // Non-consequential by construction, not by request: this is the one call site in the repository
  // that passes 'email.alert', and the content it carries was built above rather than supplied.
  return transmitAlert(built.message, { type });
}

// Separated so the alert path cannot be reached by passing a capability, and so the downgrade in
// sendEmailDetailed cannot swallow it. Everything else about a send — the provider, the log, the
// result shape — is shared.
async function transmitAlert({ to, subject, html }, { type = null } = {}) {
  // B7.13 on the SECOND road. `sendOperatorAlert` does not route through `sendEmailDetailed` —
  // measured when reconciling the 37 call sites — so a control placed only there would have left
  // this path untouched. An operator alert concerns no business day by nature, so it declares
  // TIMELESS here rather than asking each of its callers: the declaration is still explicit, and
  // it is made once, in the function whose whole purpose is system alerts.
  const alertDay = await CONTENT_DAY.assertContentDayCurrent(
    { contentDay: CONTENT_DAY.TIMELESS, timelessKind: 'operator_alert',
      capability: 'email.alert' });
  if (!alertDay.allowed) {
    return { ok: false, id: null, error: alertDay.reason, phase: alertDay.code,
      providerResponded: false };
  }

  // B7.9a on the alert road. An alert is still sent AS somebody, and an unauthorized identity on
  // an alert is the same defect as on a briefing — with the added hazard that this is the channel
  // an operator trusts. Platform scope, because an alert belongs to no company.
  //
  // `built` is NOT in scope here — it belongs to `sendOperatorAlert`, one frame up — and my first
  // version referenced `built.message.from`, threw, was caught by the handler below, and refused
  // EVERY alert. Three tests caught it by asserting the provider was invoked exactly once and
  // getting zero. `transmitAlert` is handed no sender at all, so the identity is the platform
  // default, which is what the declaration check below is given.
  const alertFrom = defaultFrom();
  let alertSender;
  try {
    alertSender = await SENDER.authorizedSender({
      from: alertFrom,
      companyId: null,
      providerAccount: DIGEST_MOD.providerAccountOf({
        transport: 'resend', from: SENDER.oneAddress(alertFrom) || alertFrom }),
    });
  } catch (e) {
    alertSender = { ok: false, code: 'sender_authorization_unknown', reason: e.message };
  }
  if (!alertSender.ok) {
    return { ok: false, id: null, phase: alertSender.code,
      error: `the alert channel is not authorized to send as this identity `
        + `(${alertSender.code}): ${alertSender.reason}`,
      providerResponded: false };
  }

  const gate = await assertSendAllowed({ capability: 'email.alert', to });
  if (!gate.allowed) {
    // A deliberate `capability:email.alert` stop still silences alerts. The exemption is from a
    // GLOBAL hold, not from oversight of the alert channel itself.
    console.warn(`[STOPPED_BY_POLICY] operator alert: ${gate.reason}`);
    try { await logEmail({ to: String(to), subject, status: 'stopped_by_policy', errorMessage: gate.reason }); } catch (_) {}
    return { ok: false, id: null, error: gate.reason, stopped: true, phase: 'stopped_by_policy',
      providerResponded: false };
  }
  // The provider call, the email_log row and the result shape are shared with every other send —
  // duplicating them here would be a second, quieter mailer. So this path opens its OWN ledger
  // attempt and calls the shared second half directly. It does NOT route through
  // sendEmailDetailed: that function's gate is now unconditional by design, and the gate it would
  // run is `email.send` (the alert capability is downgraded there), which the global STOP refuses.
  // The authorization for this send is the `email.alert` gate ABOVE, eight lines up, and it is the
  // only one that applies.
  const att = await LEDGER.beginAttempt({
    transport: 'resend', provider: 'resend', to, subject, html,
    // ── PROVENANCE, WITHOUT TOUCHING THE EXEMPTION ──────────────────────────
    //
    // These were both null, so an alert appeared in the ledger as a PROVIDER_ACCEPTED row
    // attributable only by transport — and an alert is the one send that still happens under a
    // total hold, which makes it the one whose provenance matters most. The 2026-11-11 row found
    // during containment verification was exactly that: real, correct, and identifiable only by
    // elimination.
    //
    // This changes NOTHING about authorization. The gate above is still `email.alert`, still the
    // only one that applies here, and a deliberate `capability:email.alert` stop still silences
    // this path. Only the row is more legible.
    workflow: 'operator-alert',
    agent: type ? `alert:${type}` : 'alert:unspecified',
    approvalId: null,
    // DELIBERATELY NO claimRef. The claim-uniqueness index covers claim_ref, so giving alerts one
    // would make a second alert of the same kind collide with the first and be refused — turning a
    // provenance improvement into a mechanism that silences the channel that reports breakage.
    // Alerts are not idempotent by key and must not be made to look as though they are.
    // Operator alerts are not consequential: nobody outside the operator addresses receives them,
    // and the recipient restriction is what makes that true rather than a claim.
    consequential: false,
  });
  if (!att.ok) {
    return { ok: false, id: null, error: att.error, phase: 'refused_before_request',
      providerResponded: false, stopped: false };
  }
  return deliverAuthorized({ to, subject, html }, att);
}

module.exports = { CONTENT_DAY, sendEmail, sendEmailDetailed, sendEmailOrReport, encodeAttachments, MAX_ATTACH_BYTES,
                   defaultFrom, DEFAULT_FROM, alertSendFailure, sendOperatorAlert,
                   approvedDigestOf };
