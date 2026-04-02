async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log('No RESEND_API_KEY'); return false; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'PlaybookOS <naren@abiozen.com>', to, subject, html })
    });
    const data = await res.json();
    console.log('Email result:', JSON.stringify(data));
    return data.id ? true : false;
  } catch(e) { console.error('Email error:', e.message); return false; }
}
module.exports = { sendEmail };
