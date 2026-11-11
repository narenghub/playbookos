// ── ONE AUTHORIZATION ROAD TO EVERY EMAIL PROVIDER ───────────────────────────
//
//   const gate = await assertSendAllowed({ capability, workflow, agent, to });
//   if (!gate.allowed) { /* do not call the provider */ }
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// The kill switch was enforced inside src/lib/mailer.js, immediately before the Resend call. That
// was the right place for Resend and it covered every caller of mailer.js — around 37 routes and 37
// crons — which is why it reads as complete.
//
// It is not complete. TWO MORE TRANSPORTS exist, both sending through Gmail rather than Resend:
//
//   src/lib/campaigns/cphi-runner.js   gmail.users.messages.send   cron '5 * * * 1-5'   (hourly)
//   src/lib/agents/outreach-agent.js   gmail.users.messages.send   cron '10 9 * * 1-5'
//
// Neither consulted the kill switch at all. Each was gated only by an environment variable —
// CPHI_FOLLOWUP_ENABLED and OUTREACH_ENABLED — read at the cron and turned into a local EXECUTE
// flag. A row in autonomy_stops, INCLUDING A GLOBAL STOP, did not reach either of them. The global
// stop was therefore not global, and no honest statement about email containment could be made.
//
// The guard that should have caught it, scripts/check-legacy-email-containment-db.js, runs in
// preflight as "each legacy external sender stops on its own, by name" — and its names were
// `inquiry-agent` and `procurement-agent`, both Resend. It contained no reference to Gmail. Real
// evidence, partial coverage, and a name that invites reading it as complete.
//
// ── THE PATTERN, WHICH IS WORTH MORE THAN THE BUG ────────────────────────────
//
// This is the SECOND instance of this defect class found in one day. The first: eight agents called
// the Anthropic API directly rather than through llm.js, so they sat outside the `llm.call` kill
// switch, and stopping model spend stopped three callers while leaving eight running (d0c19ee).
//
// Same shape both times — a capability gate enforced at one chokepoint while other code reaches the
// provider by a different road. The useful question about a capability is therefore not "is there a
// gate" but "is the gate the ONLY road", and that is a question a scanner can answer and a comment
// cannot. scripts/check-email-transport-coverage.js is that scanner.
//
// ── FAIL CLOSED, WITH ONE NAMED EXCEPTION ────────────────────────────────────
//
// If the stop state cannot be read, this refuses. An unreadable kill switch is an unestablished
// authorization, and an external effect is not the thing to do while unsure. That inverts mailer's
// previous behaviour for ordinary mail — it used to send on an unreadable kill state — and the
// inversion is deliberate: CEO authorization of 2026-11-10 requires "a fail-closed policy if
// authorization cannot be determined."
//
// The exception is the observability channel; see OBSERVABILITY below.

'use strict';

const { classifyRecipients } = require('./outbound/recipients');

// Capabilities that survive a global stop. Exactly one, and it is not a promise — see the recipient
// constraint, which is what makes it narrow by construction.
const OBSERVABILITY = new Set(['email.alert']);

// ── THE SECOND GATE: NOTHING LEAVES THE COMPANY WITHOUT A HUMAN DECISION ─────
//
// CEO decision 2026-11-11, priority 1: "Enforce the same immutable approval boundary at every
// buyer-directed transmission path. A caller must not evade approval by changing workflow labels
// or transport."
//
// S2 put the boundary inside the inquiry agent. That closed one road and left two open, and both
// evasions were available by construction:
//
//   TRANSPORT — outreach-queue.js builds queue rows carrying inquiries.buyer_email, and
//   outreach-agent.js mails them through gmail.users.messages.send. The same buyers, a different
//   transport, no approval. One of the two transports that produced the 25-message breach.
//
//   LABEL — `workflow` is a string the caller picks. Passing 'outreach' rather than
//   'legacy-inquiry-buyer-email' changed which stops applied and which boundary was believed to
//   be in force.
//
// So this check is keyed on the RECIPIENT, which no caller chooses, and it lives HERE, in the
// function scripts/check-email-transport-coverage.js already proves all four transports pass
// through. A transport added next month inherits it; a relabelled workflow does not escape it.
//
// ── IT VERIFIES THE APPROVAL. IT DOES NOT TAKE THE CALLER'S WORD ─────────────
//
// A boolean parameter would re-create the exact defect that made `capability: 'email.alert'` a
// loophole: an assurance the caller supplies about itself. So the caller passes an approvalId and
// the digest of the bytes it is about to transmit, and this READS the approval row: it must exist,
// be approved, be RELEASED, and its frozen payload must hash to the same digest.
//
// Fail closed on every uncertainty, including an unreadable database. An external commercial
// message is not the thing to send while unsure.
/**
 * Is there a released approval authorising exactly these bytes?
 *
 * The SQL lives in src/lib/office/scope.js, which owns every kernel table name. It was here
 * first, written as `FROM ${APPROVAL_TABLE}` — and the scope-discipline scanner did not flag it,
 * because a constant hides a table name from a text search. That is the same indirection this
 * programme keeps finding in its own code, arrived at by accident, and it is why the check now
 * also refuses a product file that merely names a kernel table in a constant.
 *
 * @returns {{ok:true} | {ok:false, reason:string, detail:string}}
 */
async function verifyReleasedApproval({ approvalId, digest }, deps = {}) {
  const scope = deps.scope || require('./office/scope');
  try {
    return await scope.verifyReleasedApprovalForDigest({ approvalId, digest }, deps);
  } catch (e) {
    // The accessor fails closed internally; this covers the case where it cannot be reached at
    // all — a load error, a missing export — which is still an unverifiable authorization.
    return { ok: false, reason: 'approval_unreadable',
      detail: `the approval accessor could not be reached (${e && e.message})` };
  }
}

/**
 * Recipients the observability exemption may reach.
 *
 * ── THE RELABEL BYPASS THIS CLOSES ─────────────────────────────────────────
 *
 * The exemption was documented as narrow: "an alert goes only to ALERT_EMAIL/ADMIN_EMAIL from a
 * fixed template, so the exemption cannot carry autonomous business email." That was TRUE of the
 * one caller that used it, and enforced nowhere. `sendEmailDetailed` accepts `capability` as an
 * ordinary parameter, so any caller — today's, or one added next month by someone who read the
 * comment as a guarantee — could pass `capability: 'email.alert'` with an arbitrary recipient and
 * arbitrary HTML and transmit straight through a global stop.
 *
 * Narrow by convention is not narrow. The exemption now holds only when the recipient is an
 * operator address; anything else claiming to be an alert is treated as the ordinary consequential
 * send it actually is, and is stopped like one.
 */
function operatorRecipients(env = process.env) {
  return new Set([env.ALERT_EMAIL, env.ADMIN_EMAIL]
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase()));
}

function recipientsOf(to) {
  const list = Array.isArray(to) ? to : [to];
  return list.filter(Boolean).map((s) => String(s).trim().toLowerCase());
}

/**
 * Is this send authorized right now?
 *
 * @returns {{allowed:boolean, reason:string|null, stop:object|null, exempt:boolean}}
 *
 * NEVER THROWS. Every caller is a cron or a route in the middle of work, and an exception thrown
 * from an authorization check is an outage in the thing being authorized. A failure to EVALUATE is
 * reported as a refusal, which is the fail-closed half of the contract.
 */
async function assertSendAllowed({ capability = 'email.send', workflow = null, agent = null,
  company = null, to = null, approvalId = null, digest = null } = {}, deps = {}) {
  const env = deps.env || process.env;

  // The exemption is claimed, then CHECKED. A message claiming to be an alert while addressed
  // somewhere else is not an alert.
  const claimsExempt = OBSERVABILITY.has(capability);
  let exempt = false;
  if (claimsExempt) {
    const operators = operatorRecipients(env);
    const rcpts = recipientsOf(to);
    // No configured operator address means the exemption cannot be verified, so it is not granted.
    // An alert that cannot prove where it is going is an ordinary send.
    exempt = operators.size > 0 && rcpts.length > 0 && rcpts.every((r) => operators.has(r));
  }

  try {
    const { checkStopped, recordRefusal } = deps.autonomy || require('./autonomy');
    const blocked = await checkStopped({
      capability,
      ...(workflow ? { workflow } : {}),
      ...(agent ? { agent } : {}),
      ...(company ? { company } : {}),
    }, { consequential: !exempt });

    if (blocked) {
      const reason = `STOPPED_BY_POLICY: ${blocked.scope_type}`
        + `${blocked.scope_key ? `:${blocked.scope_key}` : ''} — ${blocked.reason}`;
      try {
        recordRefusal({ stop: blocked, what: capability, detail: { workflow, agent } });
      } catch (_) { /* the refusal record must not become the reason a refusal fails */ }
      return { allowed: false, reason, stop: blocked, exempt,
        // The scope string the ledger needs, built HERE rather than at each of the three call
        // sites. Each built its own from gate.stop and fell back to 'authorization_undetermined'
        // when it was null — so an approval refusal, which has no stop row, was about to be
        // recorded as an unreadable kill switch. A refusal filed under the wrong cause is the
        // containment-report failure of 10 November in miniature.
        scope: `${blocked.scope_type}${blocked.scope_key ? `:${blocked.scope_key}` : ''}` };
    }

    // ── NO STOP IN FORCE. DOES ANYONE OUTSIDE THE COMPANY RECEIVE THIS? ────
    //
    // Checked AFTER the kill switch, deliberately. When both would refuse, "a CEO hold is in
    // force" is the useful answer and "no approval was presented" is a distraction — and a
    // caller that fixed the approval would still be stopped.
    //
    // The observability exemption passes through: an operator alert is verified by this file to
    // be addressed to ALERT_EMAIL/ADMIN_EMAIL, which are company addresses, so it is internal by
    // the recipient rule as well. It gets no second pass here.
    const rcpt = classifyRecipients(to, env);
    if (rcpt.external.length && !exempt) {
      const appr = await verifyReleasedApproval({ approvalId, digest }, deps);
      if (!appr.ok) {
        const where = rcpt.external.join(', ');
        const why2 = `EXTERNAL_WITHOUT_APPROVAL: ${appr.reason} — ${appr.detail}`;
        console.warn(`[approval-gate] refusing ${capability} to ${where}: ${why2}`);
        try {
          const { recordRefusal } = deps.autonomy || require('./autonomy');
          recordRefusal({
            stop: { scope_type: 'approval', scope_key: appr.reason, reason: appr.detail },
            what: capability,
            detail: { workflow, agent, external: rcpt.external, approvalId: approvalId || null },
          });
        } catch (_) { /* the refusal record must not become the reason a refusal fails */ }
        return { allowed: false, reason: why2, stop: null, exempt: false,
          scope: `approval:${appr.reason}`,
          approvalRefusal: appr.reason, external: rcpt.external };
      }
    }

    return { allowed: true, reason: null, stop: null, exempt };
  } catch (e) {
    const why = e && e.message ? e.message : String(e);
    // ── A CODE FAULT IS NOT AN UNREADABLE DATABASE ────────────────────────
    //
    // Found by causing one: a missing require in this file threw a ReferenceError, which this
    // catch reported as "the kill switch could not be read". The refusal was correct and
    // fail-closed, and the DIAGNOSIS sent the reader to Postgres for a bug in a require
    // statement. During an incident that is an hour spent in the wrong place.
    //
    // Still fail closed, either way. Only the stated cause changes.
    const codeFault = e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError;
    const cause = codeFault
      ? `a FAULT IN THE AUTHORIZATION CODE ITSELF, not a database problem — ${e.name}: ${why}`
      : `the kill switch could not be read — ${why}`;
    if (exempt) {
      // The one case where an unreadable kill state does not stop the message. Postgres goes down,
      // every cron halts fail-closed, and the alert explaining that must still leave — otherwise a
      // total outage becomes silence plus a console line.
      console.error(`[kill-switch] ${cause}; sending anyway (observability)`);
      return { allowed: true, reason: null, stop: null, exempt: true };
    }
    console.error(`[kill-switch] REFUSING ${capability}: ${cause}`);
    return {
      allowed: false,
      reason: `AUTHORIZATION_UNDETERMINED: ${cause}`,
      stop: null,
      exempt: false,
      scope: 'authorization_undetermined',
    };
  }
}

module.exports = { assertSendAllowed, OBSERVABILITY, operatorRecipients, recipientsOf,
  verifyReleasedApproval };
