async function sendEmail({ to, subject, html, triggerType }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || key.includes('REPLACE')) {
    console.log('Email skipped - no RESEND_API_KEY configured');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'PlaybookOS <onboarding@resend.dev>', to, subject, html })
    });
    console.log('Email sent to:', to);
    return true;
  } catch(e) {
    console.error('Email error:', e.message);
    return false;
  }
}
module.exports = { sendEmail };
