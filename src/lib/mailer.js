const crypto = require('crypto');
const { query } = require('./db');

async function logEmail({ to, subject, status, errorMessage }) {
  try {
    await query(
      `INSERT INTO email_log (id, to_email, subject, status, error_message) VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), to, subject, status, errorMessage || null]
    );
  } catch(e) { console.error('email_log write failed:', e.message); }
}

async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log('No RESEND_API_KEY');
    await logEmail({ to, subject, status: 'failed', errorMessage: 'RESEND_API_KEY not configured' });
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'PlaybookOS <naren@abiozen.com>', to, subject, html })
    });
    const data = await res.json();
    const ok = !!data.id;
    console.log('Email result:', JSON.stringify(data));
    await logEmail({ to, subject, status: ok ? 'sent' : 'failed', errorMessage: ok ? null : JSON.stringify(data) });
    return ok;
  } catch(e) {
    console.error('Email error:', e.message);
    await logEmail({ to, subject, status: 'failed', errorMessage: e.message });
    return false;
  }
}
module.exports = { sendEmail };
