const { sendEmail } = require('./mailer');

// Wraps a cron callback so thrown exceptions trigger an alert email
// to ALERT_EMAIL (fallback ADMIN_EMAIL) and never bubble. Phase 1 only
// catches throws — soft errors logged via try/catch inside the body
// are NOT alerted on.
function withAlerts(name, fn) {
  return async () => {
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
  const ok = await sendEmail({ to, subject, html });
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
