const { sendEmail } = require('./mailer');

// Wraps a cron callback so thrown exceptions trigger an alert email
// to ALERT_EMAIL (fallback ADMIN_EMAIL) and never bubble. Phase 1 only
// catches throws — soft errors logged via try/catch inside the body
// are NOT alerted on.
// `deps` follows the injection pattern already used by src/lib/agents/gate.js: it exists so the
// kill-switch guard can be tested with a spy proving fn() was never REACHED, rather than inferred
// from the absence of output. Production calls pass nothing.
function withAlerts(name, fn, deps = {}) {
  return async () => {
    // ── THE KILL SWITCH, AT THE ONE PLACE ALL 37 CRONS PASS THROUGH ──────────
    //
    // Checked before fn() is called, not inside it: the point is that the body never runs. A cron
    // is treated as consequential, so an unreadable kill-state halts it — and that is the right
    // trade, because a cron that cannot read autonomy_stops almost certainly cannot do its own work
    // either, and the alternative is acting blind.
    //
    // STOPPED_BY_POLICY is its own outcome. It must never read as SUCCESS, and it must never read
    // as a generic failure either — a stop is a decision, and an operator scanning logs after
    // pulling the switch needs to see it took effect rather than guess from an absence.
    try {
      // Only the DB-touching half is injectable. scopesForCron is a pure lookup over a static map,
      // so taking it from a stub would mean a test could accidentally blank the cron's scopes and
      // still pass — the guard would then be tested against scopes nothing in production uses.
      const { scopesForCron } = require('./autonomy');
      const { checkStopped, recordRefusal } = deps.autonomy || require('./autonomy');
      const blocked = await checkStopped(scopesForCron(name), { consequential: true, deps });
      if (blocked) {
        console.warn(`[STOPPED_BY_POLICY] ${name}: ${blocked.scope_type}`
          + `${blocked.scope_key ? `:${blocked.scope_key}` : ''} — ${blocked.reason}`);
        recordRefusal({ stop: blocked, what: `cron:${name}` });
        // A DELIBERATE stop is silent by design: the operator pulled the switch and does not need
        // 37 emails telling them so. An UNKNOWN kill-state is the opposite — nobody asked for it,
        // it halts every scheduled job, and without this it would be visible only in Railway logs.
        // A database outage would otherwise turn into exactly the kind of quiet that this codebase
        // has been bitten by all week.
        if (blocked.unknown) {
          try {
            await sendCronAlert(`${name} (HALTED — kill-state unknown)`,
              new Error(`${blocked.reason}. Every cron is halting fail-closed until the kill switch `
                + `can be read again. This is not an operator stop.`));
          } catch (alertErr) {
            console.error(`[ALERT FAIL] ${name}: ${alertErr.message}`);
          }
        }
        return { stopped_by_policy: true, scope: blocked.scope_type, reason: blocked.reason, unknown: !!blocked.unknown };
      }
    } catch (e) {
      // The switch itself is broken, which is not the same as being stopped. Do not silently run as
      // though autonomy were permitted, and do not silently halt the platform either: alert, and
      // halt this run. checkStopped already fails closed on a database problem, so reaching here
      // means a defect in the switch — which is exactly when a human needs telling.
      console.error(`[STOPPED_BY_POLICY] ${name}: kill-switch check itself failed: ${e.message}`);
      try { await sendCronAlert(`${name} (kill-switch check failed)`, e); } catch (_) {}
      return { stopped_by_policy: true, scope: 'global', reason: `kill-switch check failed: ${e.message}` };
    }

    try {
      await fn();
    } catch (e) {
      try {
        await sendCronAlert(name, e);
      } catch (alertErr) {
        console.error(`[ALERT FAIL] ${name}: ${alertErr.message}`);
      }
      console.error(`[CRON FAIL] ${name}:`, e.message);
    }
  };
}

async function sendCronAlert(cronName, err) {
  const to = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL;
  if (!to) {
    console.error(`[CRON FAIL] ${cronName}: no ALERT_EMAIL/ADMIN_EMAIL configured, skipping alert email`);
    return;
  }
  const errClass = (err && err.constructor && err.constructor.name) || 'Error';
  const errMsg = (err && err.message) || String(err) || 'unknown error';
  const stack = ((err && err.stack) || String(err) || '').slice(0, 2000);
  const startedAt = new Date().toISOString();
  const subject = `[PlaybookOS CRON FAIL] ${cronName} — ${errMsg.slice(0, 80)}`;
  const html = `<div style="font-family:Arial;max-width:680px;color:#333;line-height:1.5">
  <div style="background:#a02020;color:#fff;padding:14px 20px;border-radius:8px 8px 0 0">
    <div style="font-size:12px;opacity:.85">PlaybookOS — cron failure</div>
    <div style="font-size:20px;font-weight:700">${escapeHtml(cronName)}</div>
  </div>
  <div style="padding:20px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px">
    <p style="margin:0 0 8px 0"><strong>Time:</strong> ${startedAt} UTC</p>
    <p style="margin:0 0 8px 0"><strong>Error:</strong> <code>${escapeHtml(errClass)}: ${escapeHtml(errMsg)}</code></p>
    <p style="margin:16px 0 6px 0;font-size:12px;color:#666">Stack trace (truncated to 2000 chars):</p>
    <pre style="background:#f4f4f4;padding:10px;font-family:monospace;font-size:11px;white-space:pre-wrap;overflow-x:auto;margin:0">${escapeHtml(stack)}</pre>
    <p style="margin:16px 0 0 0;font-size:11px;color:#888">Check Railway logs for full context.</p>
  </div>
</div>`;
  // ── THE ALERT PATH MUST NOT BE SILENT, AND IT WAS ────
  //
  // This read `await sendEmail({...})` with the result dropped. sendEmail returns FALSE on failure
  // and deliberately does not throw (mailer.js) — so the `catch (alertErr)` in withAlerts never
  // fired for the ordinary case, and a refused alert left a cron failure as nothing but a
  // console.error line in Railway.
  //
  // That is the exact shape mailer.js was written about after 1,113 emails were lost over eight
  // weeks: "every layer did the right local thing (return false, log the row, do not crash the
  // caller) and the aggregate was silence." Here it is worse than anywhere else, because this is
  // the path whose entire job is to break silence. A monitoring system that can fail quietly is a
  // monitoring system that reports healthy.
  //
  // Thrown, not returned, so withAlerts' own catch logs [ALERT FAIL] with the reason. There is
  // nowhere further to escalate — if email is down, the log is the last channel there is — but a
  // named failure in the log can be found, and a dropped boolean cannot.
  // capability 'email.alert' — observability, not autonomy. See the exemption note in mailer.js: a
  // stop on outbound business email must not silence the channel that reports a cron failing.
  const ok = await sendEmail({ to, subject, html, capability: 'email.alert' });
  if (ok === false) {
    throw new Error(`alert email for "${cronName}" was refused by the mail provider — `
      + `the cron failure itself is above this line and reached nobody`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

module.exports = { withAlerts, sendCronAlert };
