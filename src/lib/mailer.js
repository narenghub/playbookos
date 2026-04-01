const { Resend } = require('resend');

async function sendEmail({ to, subject, html, triggerType }) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'PlaybookOS <onboarding@resend.dev>',
      to,
      subject,
      html
    });
    console.log('Email sent to:', to);
    return true;
  } catch(e) {
    console.error('Email error:', e.message);
    return false;
  }
}

module.exports = { sendEmail };
