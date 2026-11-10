// ── THE OPERATOR ALERT INTERFACE ─────────────────────────────────────────────
//
//   await sendOperatorAlert({ type: 'cron_failure', fields: { ... } })
//
// The ONLY way to produce an email that survives a global `email.send` stop.
//
// ── WHY A CAPABILITY LABEL WAS NOT ENOUGH ────────────────────────────────────
//
// `email.alert` is checked as NON-consequential, so a global stop does not silence it. Without
// that, the oversight channel dies with the database: Postgres goes down, every cron halts
// fail-closed, the alert explaining that is ALSO refused, and a total outage becomes silence plus
// a console line.
//
// The exemption was requested by the caller. `capability` was an ordinary parameter of
// sendEmailDetailed, so any code in this repository could pass `capability: 'email.alert'` with an
// arbitrary recipient and arbitrary HTML and transmit straight through a CEO hold. It was
// documented as narrow — "an alert goes only to ALERT_EMAIL/ADMIN_EMAIL from a fixed template" —
// and that was a description of the one caller, enforced nowhere.
//
// A recipient allowlist alone does not fix it either, which is why the CEO authorization of
// 2026-11-10 item B asks for more: an allowlist still lets a caller put ANY BODY in front of an
// operator, under an exemption that bypasses the hold. Containment is about what leaves the
// building, and an arbitrary message to a real mailbox has left the building.
//
// ── SO THE CONTENT IS NOT THE CALLER'S ───────────────────────────────────────
//
// This interface takes a TYPE from a fixed set and a bag of FIELDS. It renders the subject and the
// body itself from a template owned by this file, escapes every field, and resolves the recipient
// from the environment. There is no `to`, no `html`, no `subject`, no `capability` parameter —
// not validated, ABSENT. A caller cannot express the dangerous message, so there is nothing to
// validate.
//
// mailer.sendEmailDetailed, the general path, now DOWNGRADES a caller-supplied `email.alert` to
// `email.send`. The two halves together are what make this real: the privileged capability cannot
// be requested, and the only code that sets it cannot be handed content.

'use strict';

/**
 * Every alert this platform may send. Adding one is a deliberate act with a template beside it.
 *
 * `max` is a per-type daily ceiling. An exemption from the kill switch is also an exemption from
 * the thing that would stop a loop, so a runaway caller could otherwise mail an operator thousands
 * of times during the very incident the hold was declared for.
 */
const ALERT_TYPES = Object.freeze({
  cron_failure: {
    subject: (f) => `⚠️ Cron failed: ${f.cronName || 'unknown job'}`,
    render: (f, esc) => `
      <p style="margin:0 0 8px 0"><strong>Job:</strong> ${esc(f.cronName)}</p>
      <p style="margin:0 0 8px 0"><strong>Time:</strong> ${esc(f.startedAt)} UTC</p>
      <p style="margin:0 0 8px 0"><strong>Error:</strong> <code>${esc(f.errClass)}: ${esc(f.errMsg)}</code></p>
      <p style="margin:16px 0 6px 0;font-size:12px;color:#666">Stack trace (truncated):</p>
      <pre style="background:#f4f4f4;padding:10px;font-family:monospace;font-size:11px;white-space:pre-wrap;overflow-x:auto;margin:0">${esc(f.stack)}</pre>
      <p style="margin:16px 0 0 0;font-size:11px;color:#888">Check Railway logs for full context.</p>`,
    max: 200,
  },
  send_failure: {
    subject: () => '⚠️ Outbound email is failing',
    render: (f, esc) => `
      <p style="margin:0 0 8px 0"><strong>Context:</strong> ${esc(f.context)}</p>
      <p style="margin:0 0 8px 0"><strong>Phase:</strong> ${esc(f.phase)}</p>
      <p style="margin:0 0 8px 0"><strong>Reason:</strong> ${esc(f.reason)}</p>`,
    max: 50,
  },
});

// Fields are escaped, always, with no opt-out. A template cannot accidentally interpolate raw HTML
// because no path through this file passes anything unescaped.
function esc(s) {
  return String(s == null ? '—' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').slice(0, 4000);
}

/**
 * Operator recipients, resolved HERE and never accepted from a caller.
 *
 * Returns [] when nothing is configured, and an alert with no recipient is not sent — rather than
 * being sent to a default that nobody reads, or to whatever the caller suggested.
 */
function operatorRecipients(env = process.env) {
  const seen = new Set();
  for (const v of [env.ALERT_EMAIL, env.ADMIN_EMAIL]) {
    if (v) for (const one of String(v).split(',')) {
      const e = one.trim().toLowerCase();
      if (e) seen.add(e);
    }
  }
  return [...seen];
}

// Per-type daily counters. In-process and deliberately so: this is a loop brake on one container,
// not an audit record. A restart resetting it is acceptable; a database write on the alert path
// during a database outage is not — that is the failure the exemption exists to survive.
const sentToday = new Map();
function dayKey(now) { return now.toISOString().slice(0, 10); }

function rateCheck(type, now) {
  const def = ALERT_TYPES[type];
  const key = `${dayKey(now)}:${type}`;
  const n = (sentToday.get(key) || 0) + 1;
  // Keep the map from growing without bound across days.
  for (const k of sentToday.keys()) if (!k.startsWith(dayKey(now))) sentToday.delete(k);
  sentToday.set(key, n);
  return n <= def.max
    ? { allowed: true, n }
    : { allowed: false, n, reason: `alert type '${type}' hit its daily ceiling of ${def.max}` };
}

/**
 * Build a complete, fixed-shape alert message. Pure — no I/O, so it is testable without a mailer.
 *
 * @returns {{ok:true, message:{to,subject,html}} | {ok:false, error:string}}
 */
function buildAlert({ type, fields = {} }, { env = process.env, now = new Date() } = {}) {
  const def = ALERT_TYPES[type];
  if (!def) {
    return { ok: false, error: `unknown alert type '${type}' — alerts are a fixed set, not a label` };
  }
  const to = operatorRecipients(env);
  if (!to.length) {
    return { ok: false, error: 'no ALERT_EMAIL or ADMIN_EMAIL configured — an alert with no operator '
      + 'recipient is not sent to a guess' };
  }
  const rate = rateCheck(type, now);
  if (!rate.allowed) return { ok: false, error: rate.reason };

  return {
    ok: true,
    message: {
      to,
      subject: def.subject(fields),
      html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px">${def.render(fields, esc)}</div>`,
    },
  };
}

module.exports = { ALERT_TYPES, buildAlert, operatorRecipients, esc, _sentToday: sentToday };
