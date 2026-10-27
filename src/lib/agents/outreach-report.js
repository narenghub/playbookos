// ── WHAT THE OUTREACH AGENT DID, IN AN EMAIL ─────────────────────────────────
//
// An agent that runs unattended and reports nothing is worse than a command somebody types,
// because at least the command's output is read. Over two days this campaign shipped a demand
// count that deleted a customer, a department check that dropped 22 of 25 labs, and a bounce gate
// that measured nothing — and every one of them printed a confident, healthy-looking number.
//
// So this report is built around the opposite instinct:
//
//   · it NAMES the people who were skipped and why, rather than counting them. "22 not routed"
//     is what hid the broken department check for a day; "Scott J Miller — department is
//     Department of Chemistry" would have been obvious in one glance.
//   · it prints the OPENING SENTENCE of every email that went out, because that is a factual
//     claim we made about a named person and it is the thing most likely to be wrong.
//   · it says plainly when a number is not evidence. "0 bounces in 8 sends" means nothing unless
//     the scanner has been proven, so the report says which it is.
//
// Sent to Naren because he is the one who can act on it, and nobody reads Railway logs.
'use strict';

const { sendEmail } = require('../mailer');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const P = (s) => `<p style="margin:0 0 12px 0">${s}</p>`;
const H = (s) => `<h3 style="margin:22px 0 8px 0;font-size:15px;color:#15202b">${esc(s)}</h3>`;

/**
 * Compose the daily report. Returns { subject, html, worthSending }.
 *
 * worthSending is false only when NOTHING happened and nothing is wrong — no sends, no replies,
 * no bounces, no failures, nothing unfiled. A daily "0 sent" for weeks trains the reader to
 * ignore the one that matters, which is the same failure in a different costume.
 */
function composeOutreachReport({ run, bounce, date = new Date() }) {
  const sent = run ? run.sent : 0;
  const failed = run ? run.failed : 0;
  const replied = run ? run.repliedNow.length : 0;
  const unfiled = run ? run.unfiled.length : 0;
  const newBounces = bounce ? bounce.recorded : 0;
  const stopped = run && run.stopped;

  const notable = sent || failed || replied || unfiled || newBounces || stopped;

  const day = date.toISOString().slice(0, 10);
  const subject = stopped
    ? `Outreach HELD — ${stopped.split('—')[0].trim()}`
    : `Outreach ${day} — ${sent} sent`
      + `${replied ? `, ${replied} replied` : ''}`
      + `${newBounces ? `, ${newBounces} bounced` : ''}`
      + `${failed ? `, ${failed} FAILED` : ''}`;

  const b = [];

  if (stopped) {
    b.push(P(`<strong>Nothing was sent.</strong> ${esc(stopped)}`));
    b.push(P('The sequences are intact and everyone still due stays due. This clears itself once '
      + 'the bad addresses are out of the list.'));
  }

  // ── WHAT WENT OUT, WITH THE CLAIM WE MADE ────
  if (sent) {
    b.push(H(`${sent} sent`));
    b.push('<table style="border-collapse:collapse;font-size:14px;width:100%">');
    for (const s of run.sentTo) {
      b.push(`<tr><td style="padding:6px 10px 6px 0;vertical-align:top;white-space:nowrap">`
        + `<strong>${esc(s.who)}</strong><br><span style="color:#5b6b7c">${esc(s.need)}/${s.step}</span></td>`
        + `<td style="padding:6px 0;vertical-align:top">${esc(s.subject || '(in-thread)')}<br>`
        + `<span style="color:#5b6b7c">${esc(s.evidence)}</span></td></tr>`);
    }
    b.push('</table>');
    b.push(P('<span style="color:#5b6b7c">The second line of each is the first line of their '
      + 'email — a claim made about that named person. If one is not true, tell me.</span>'));
  }

  if (replied) {
    b.push(H(`${replied} replied — sequence stopped`));
    b.push(P(run.repliedNow.map(esc).join(' · ')));
    b.push(P('<strong>These are the only thing on this page that can become revenue.</strong> '
      + 'Their answers are in sales@abiozen.com.'));
  }

  // ── DELIVERABILITY, STATED HONESTLY ────
  if (bounce) {
    b.push(H('Deliverability'));
    if (!bounce.sent) {
      b.push(P('Nothing has been sent yet, so there is nothing to measure.'));
    } else {
      const pct = (bounce.rate * 100).toFixed(1);
      b.push(P(`${bounce.found.length} failure(s) against ${bounce.sent} send(s) — <strong>${pct}%</strong>`
        + `${bounce.recorded ? `, ${bounce.recorded} newly recorded` : ''}.`));
      if (bounce.stopped) b.push(P(`${bounce.stopped} sequence(s) stopped on a hard bounce.`));
      if (!bounce.scanned) {
        b.push(P('<span style="color:#8a6d3b">No postmaster mail at all in the window. That is '
          + 'consistent with a clean list — and it reads identically to a scanner that cannot see '
          + 'bounces. scripts/verify-bounce-detection.js settles which, by causing one.</span>'));
      }
    }
  }

  // ── WHO WAS NOT WRITTEN TO, BY NAME ────
  if (run && run.declined.length) {
    b.push(H(`${run.declined.length} not written to`));
    b.push(P('<span style="color:#5b6b7c">No evidence, so no email. The reason names the field '
      + 'that is missing — these are fixable, and each one is a funded lab we already found.</span>'));
    b.push('<table style="border-collapse:collapse;font-size:14px">');
    for (const d of run.declined.slice(0, 30)) {
      b.push(`<tr><td style="padding:3px 12px 3px 0"><strong>${esc(d.who)}</strong></td>`
        + `<td style="padding:3px 12px 3px 0;color:#5b6b7c">${esc(d.org || '')}</td>`
        + `<td style="padding:3px 0">${esc(d.why || '')}</td></tr>`);
    }
    b.push('</table>');
    if (run.declined.length > 30) b.push(P(`…and ${run.declined.length - 30} more.`));
  }

  // ── THE THINGS THAT NEED A HUMAN ────
  const problems = [];
  if (failed) problems.push(`${failed} send(s) errored`);
  if (run && run.unconfirmed) {
    problems.push(`${run.unconfirmed} claimed send(s) have no Gmail id — they may or may not have `
      + 'gone. Check the Sent folder before anything is retried.');
  }
  if (unfiled) {
    problems.push(`${unfiled} thread(s) are UNFILED. Reply detection walks labelled threads, so a `
      + 'reply on an unfiled thread will not stop the sequence — that person answers and gets '
      + 'chased anyway.');
  }
  if (problems.length) {
    b.push(H('Needs you'));
    b.push(`<ul style="margin:0 0 12px 0;padding-left:20px">${
      problems.map((p) => `<li style="margin-bottom:6px">${esc(p)}</li>`).join('')}</ul>`);
  }

  // ── WHAT IS WAITING ────
  if (run && !stopped) {
    const s = run.skipped || {};
    const wait = [];
    if (s.notDue) wait.push(`${s.notDue} not yet due`);
    if (s.done) wait.push(`${s.done} finished their sequence`);
    if (s.replied) wait.push(`${s.replied} already replied`);
    if (s.bounced) wait.push(`${s.bounced} stopped on a bounce`);
    if (wait.length) b.push(P(`<span style="color:#5b6b7c">Also: ${esc(wait.join(' · '))}.</span>`));
  }

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#15202b;max-width:720px">
${b.join('\n')}
<p style="margin:20px 0 0 0;color:#8893a0;font-size:13px">PlayNexa outreach agent · sent from ${esc(run ? run.from : '')}</p>
</div>`;

  return { subject, html, worthSending: !!notable };
}

/** Send it, unless nothing happened and nothing is wrong. */
async function sendOutreachReport({ run, bounce, to, date }) {
  const r = composeOutreachReport({ run, bounce, date });
  if (!r.worthSending) return { skipped: 'nothing notable' };
  return sendEmail({ to: to || process.env.OUTREACH_REPORT_TO || 'naren@abiozen.com', subject: r.subject, html: r.html });
}

module.exports = { composeOutreachReport, sendOutreachReport };
