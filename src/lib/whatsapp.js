// WhatsApp messaging via Twilio's REST API. Used by the escalation workflow
// to send reminders / warnings to users whose performance score has dropped.
// Skips gracefully (returns { skipped, reason }) when Twilio env vars are
// unset so the rest of the system keeps working without a paid account.
const crypto = require('crypto');
const { query } = require('./db');

async function sendWhatsApp(to, message, { user_id = null, message_type = 'reminder' } = {}) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) {
    return { skipped: true, reason: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM must all be set' };
  }
  if (!to) return { skipped: true, reason: 'no recipient number provided' };

  const normalize = n => {
    const s = String(n).trim();
    return s.startsWith('whatsapp:') ? s : 'whatsapp:' + s;
  };
  const toNumber = normalize(to);
  const fromNumber = normalize(from);

  const params = new URLSearchParams({ From: fromNumber, To: toNumber, Body: message });
  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');

  let status = 'pending', sid_msg = null, errorMsg = null;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      status = 'error';
      errorMsg = data.message || `Twilio ${res.status}`;
    } else {
      status = data.status || 'queued';
      sid_msg = data.sid;
    }
  } catch (e) {
    status = 'error';
    errorMsg = e.message;
  }

  // Always log the attempt regardless of outcome
  try {
    await query(
      `INSERT INTO whatsapp_log (id, user_id, to_number, message_type, message, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [crypto.randomUUID(), user_id, to, message_type, message, status + (errorMsg ? ': ' + errorMsg.slice(0, 180) : '')]
    );
  } catch { /* logging errors must not break the agent */ }

  if (errorMsg) return { error: errorMsg, status };
  return { success: true, status, message_sid: sid_msg };
}

module.exports = { sendWhatsApp };
