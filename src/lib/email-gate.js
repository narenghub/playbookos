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

// Capabilities that survive a global stop. Exactly one, and it is not a promise — see the recipient
// constraint, which is what makes it narrow by construction.
const OBSERVABILITY = new Set(['email.alert']);

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
  company = null, to = null } = {}, deps = {}) {
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
      return { allowed: false, reason, stop: blocked, exempt };
    }
    return { allowed: true, reason: null, stop: null, exempt };
  } catch (e) {
    const why = e && e.message ? e.message : String(e);
    if (exempt) {
      // The one case where an unreadable kill state does not stop the message. Postgres goes down,
      // every cron halts fail-closed, and the alert explaining that must still leave — otherwise a
      // total outage becomes silence plus a console line.
      console.error(`[kill-switch] unreadable for ${capability}; sending anyway (observability): ${why}`);
      return { allowed: true, reason: null, stop: null, exempt: true };
    }
    console.error(`[kill-switch] unreadable for ${capability}; REFUSING the send: ${why}`);
    return {
      allowed: false,
      reason: `AUTHORIZATION_UNDETERMINED: the kill switch could not be read — ${why}`,
      stop: null,
      exempt: false,
    };
  }
}

module.exports = { assertSendAllowed, OBSERVABILITY, operatorRecipients, recipientsOf };
