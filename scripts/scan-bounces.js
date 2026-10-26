#!/usr/bin/env node
// ── FIND THE DELIVERY FAILURES AND RECORD THEM ───────────────────────────────
//
//   railway ssh 'node scripts/scan-bounces.js'              # dry run
//   railway ssh 'node scripts/scan-bounces.js --execute'
//   railway ssh 'node scripts/scan-bounces.js --days=14 --execute'
//
// ── WHY THIS EXISTS, AND WHY IT IS URGENT ────────────────────────────────────
//
// send-outreach.js refuses to start above a 5% bounce rate. It computes that rate from
// outreach_bounces — a table nothing wrote to. So the gate read 0 bounces in 8 sends, reported
// 0.0%, and allowed the batch. It would have reported 0.0% and allowed the batch if every single
// address had failed.
//
// That is the exact defect this campaign has been finding all day in other places: a check that
// cannot fail is indistinguishable from a check that passes, and the output looks identical. The
// guard was written and the thing that feeds it was not, so the safety property was decorative
// from the moment it shipped.
//
// Bounce rate is also not a tidy metric here. sales@abiozen.com took six weeks of warmup and is
// the only mailbox with any sending reputation. The 25 addresses came out of published paper
// affiliations, and academics move — a professor who left for another institution three years ago
// still has a paper with the old address on it. A meaningful share of hard bounces is plausible,
// and finding out AFTER the whole list has gone is how the domain gets burned.
//
// ── HOW A BOUNCE ARRIVES ─────────────────────────────────────────────────────
//
// As an ordinary message to the sending mailbox from a postmaster address, carrying the failed
// recipient somewhere in its body or headers. There is no API that says "this send bounced", so
// this walks recent mail from the usual daemons and matches the addresses it finds against the
// ones we actually wrote to.
//
// MATCHED AGAINST outreach_sends, never guessed: a bounce naming an address we never emailed is
// somebody else's problem arriving in a shared mailbox, and recording it would poison the rate
// that decides whether the next batch is allowed to go.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { gmailClientFor } = require('../src/lib/gmail/client');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EXECUTE = has('execute');
const FROM = arg('mailbox', 'sales@abiozen.com');
const DAYS = Math.max(1, Math.min(90, parseInt(arg('days', '14'), 10) || 14));

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

// The senders a bounce actually comes from. Narrow on purpose: a wide net would match a human
// writing "delivery failed" and record a bounce that never happened.
const DAEMONS = ['mailer-daemon@*', 'postmaster@*', 'noreply-dmarc-support@*'];

// Hard vs soft decides what to do about it. A hard bounce means the address is wrong and must
// never be written to again; a soft one is a full mailbox or a greylist and may clear.
// ── A THREE-DIGIT NUMBER IS NOT A STATUS CODE ────
// The first version matched a bare /55[0-9]/, which classified "We need 550 grams of the
// compound" as a hard bounce. A bounce quotes the original exchange, so a buyer's own reply ends
// up inside the haystack — and a reply read as a delivery failure would stop that person's
// sequence permanently, which is the worst outcome available here.
//
// The second attempt allowed "550 <Capitalised word>" as well, which still matched "550 grams"
// — the whole regex carries the `i` flag, so [A-Z] matches lower case too. Case cannot carry
// meaning in a case-insensitive pattern, and relying on it was the kind of mistake that looks
// correct when read.
//
// So a numeric code only counts when an enhanced status follows it (550 5.1.1 …). "550 No such
// user here" is still caught, by the phrase list below rather than by the number. The cost is
// missing a bare "Remote server returned: 550" with no wording at all, which is rare — and a
// missed bounce is far safer here than a reply misread as a delivery failure.
const CODE_HARD = String.raw`(?:^|[^\d.])5[0-5]\d\s+\d\.\d\.\d|\b5\.1\.[12]\b`;
const CODE_SOFT = String.raw`(?:^|[^\d.])4[0-5]\d\s+\d\.\d\.\d|\b4\.2\.2\b`;

const HARD = new RegExp(`${CODE_HARD}|does ?n'?o?t? exist|no such user|user unknown|unknown user|address rejected|recipient rejected|mailbox unavailable|account (has been )?disabled|no longer (with|at)`, 'i');
const SOFT = new RegExp(`${CODE_SOFT}|over quota|quota exceeded|mailbox full|temporar|greylist|try again later`, 'i');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

async function main() {
  await initDB();

  // Only addresses we actually wrote to. A bounce for anything else is not ours to count.
  const ours = new Map();
  for (const r of (await query('SELECT DISTINCT LOWER(to_email) e FROM outreach_sends')).rows) {
    ours.set(r.e, true);
  }
  say(`\n── bounce scan · ${EXECUTE ? 'recording' : 'dry run'} · ${FROM} · last ${DAYS} days\n`);
  say(`   ${ours.size} address(es) we have written to`);
  if (!ours.size) {
    say('\n   Nothing sent yet, so nothing can have bounced.\n');
    return;
  }

  const g = await gmailClientFor(FROM);
  if (g.error) throw new Error(`cannot read ${FROM}: ${g.error}`);

  const after = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
  const q = `(${DAEMONS.map((d) => `from:${d}`).join(' OR ')}) after:${after}`;

  const list = await g.gmail.users.messages.list({ userId: 'me', q, maxResults: 200 });
  const ids = (list.data.messages || []).map((m) => m.id);
  say(`   ${ids.length} message(s) from a postmaster in that window\n`);

  const found = [];
  const unmatched = [];

  for (const id of ids) {
    let msg;
    try {
      msg = await g.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    } catch (e) { say(`   ⚠ could not read ${id}: ${e.message}`); continue; }

    const headers = Object.fromEntries(
      (msg.data.payload.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    const body = collectText(msg.data.payload);
    const hay = `${headers.subject || ''}\n${body}`;

    const kind = HARD.test(hay) ? 'hard' : (SOFT.test(hay) ? 'soft' : 'unknown');

    // Every address mentioned anywhere, intersected with the ones we wrote to.
    const mentioned = new Set((hay.match(EMAIL_RE) || []).map((e) => e.toLowerCase()));
    const hits = [...mentioned].filter((e) => ours.has(e));

    if (!hits.length) {
      unmatched.push(headers.subject || '(no subject)');
      continue;
    }
    for (const e of hits) {
      found.push({ email: e, kind, detail: (headers.subject || '').slice(0, 180), id });
    }
  }

  if (!found.length) {
    say('   No bounces matched an address we wrote to.');
  } else {
    say('   ══ BOUNCES ═════════════════════════════════════════════════════════');
    for (const f of found) say(`      ${pad(f.kind, 9)}${pad(f.email, 40)}${f.detail}`);
  }
  if (unmatched.length) {
    say(`\n   ${unmatched.length} postmaster message(s) named no address of ours — not counted.`);
  }

  // ── THE RATE THAT GATES THE NEXT BATCH ────
  const sent = (await query('SELECT COUNT(*)::int n FROM outreach_sends')).rows[0].n;
  const distinct = new Set(found.map((f) => f.email)).size;
  const rate = sent ? distinct / sent : 0;
  say(`\n   ${distinct} address(es) bounced out of ${sent} send(s) — ${(rate * 100).toFixed(1)}%`);
  if (rate > 0.05) {
    say('   ⚠ over 5%. send-outreach will refuse to continue until the remaining addresses are');
    say('     verified. sales@abiozen.com took six weeks to warm and is the only warmed mailbox.');
  }

  if (!EXECUTE) {
    say('\n   DRY RUN — nothing recorded. Re-run with --execute.\n');
    return;
  }

  let recorded = 0;
  for (const f of found) {
    // Idempotent on (email, detail): re-running the scan must not inflate the rate, which would
    // eventually gate the campaign on its own repetition.
    const r = await query(
      `INSERT INTO outreach_bounces (email, kind, detail)
       SELECT $1, $2, $3
        WHERE NOT EXISTS (
          SELECT 1 FROM outreach_bounces
           WHERE LOWER(email) = LOWER($1) AND COALESCE(detail,'') = COALESCE($3,''))
       RETURNING id`, [f.email, f.kind, f.detail]);
    recorded += r.rowCount || 0;
  }
  say(`\n   ✅ ${recorded} new bounce(s) recorded (${found.length - recorded} already known).`);

  // A hard bounce means the address is wrong. Stop that sequence so no follow-up is attempted.
  const hard = [...new Set(found.filter((f) => f.kind === 'hard').map((f) => f.email))];
  if (hard.length) {
    const u = await query(
      `UPDATE outreach_state SET status='bounced', updated_at=NOW()
        WHERE LOWER(email) = ANY($1) AND status <> 'bounced'`, [hard]);
    say(`   ${u.rowCount} sequence(s) stopped on a hard bounce.`);
  }
  say('');
}

/** Every text/* part of a MIME tree, decoded. A bounce often hides the address in a nested part. */
function collectText(part, acc = []) {
  if (!part) return acc.join('\n');
  if (part.body && part.body.data && /^text\//.test(part.mimeType || '')) {
    try { acc.push(Buffer.from(part.body.data, 'base64').toString('utf8')); } catch (_) { /* skip */ }
  }
  for (const p of part.parts || []) collectText(p, acc);
  return acc.join('\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('scan-bounces failed:', e && e.message ? e.message : e);
  process.exit(1);
});
