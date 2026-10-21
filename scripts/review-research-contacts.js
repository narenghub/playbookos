#!/usr/bin/env node
// ── SPOT-CHECK EVERY ADDRESS AGAINST THE PAPER IT CAME FROM ──────────────────
//
//   railway ssh 'node scripts/review-research-contacts.js'
//   railway ssh 'node scripts/review-research-contacts.js --unverified'
//   railway ssh 'node scripts/review-research-contacts.js --suppress=x@y.edu --reason=objection'
//
// Read-only unless --suppress is given.
//
// ── WHY A HUMAN LOOKS BEFORE ANYTHING IS SENT ────────────────────────────────
//
// The attribution rule is now strict, and it was wrong before it was strict: searching for Scott
// Miller at Yale it had accepted sophie.miller@sahmri.com and edward.miller@yale.edu. Tests pin
// those three cases, but a test only covers the failure I already found. The addresses in this
// table were parsed out of prose by a rule I wrote this morning, and the cost of a wrong one is
// not a bad row — it is a scientist receiving commercial mail about a stranger's grant, from a
// domain we cannot afford to burn twice.
//
// So every contact prints with the exact article it was taken from. Open three, read the
// corresponding-author line, confirm the person. Three is enough to catch a systematic error;
// nothing catches it after the send.
'use strict';

const { initDB, query } = require('../src/lib/db');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

async function suppress(email, reason) {
  const e = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) throw new Error(`not an address: ${email}`);
  await query(`INSERT INTO contact_suppression (email, reason, note, added_by)
               VALUES ($1,$2,$3,'review-research-contacts')
               ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason, note = EXCLUDED.note`,
  [e, reason, arg('note', null)]);
  say(`\n   suppressed ${e}  (${reason})`);
  say('   It stays suppressed through re-ingest: the list is keyed on the address, not on a flag');
  say('   on a row that the next refresh would recreate.\n');
}

async function main() {
  await initDB();

  const sup = arg('suppress', null);
  if (sup) {
    await suppress(sup, arg('reason', 'manual'));
    process.exit(0);
  }

  const rows = (await query(`
    SELECT p.id, p.full_name, p.title, p.email, p.email_basis, p.published_for,
           p.source_url AS paper_url,
           l.pi_name, l.institution_name, l.department, l.country,
           l.funding_id, l.funding_end, l.funding_amount, l.focus,
           l.source_url AS award_url,
           (SELECT COUNT(*)::int FROM research_interests i WHERE i.lab_id = l.id) interests,
           (s.email IS NOT NULL) AS suppressed
      FROM research_people p
      JOIN research_labs l ON l.id = p.lab_id
      LEFT JOIN contact_suppression s ON s.email = lower(p.email)
     WHERE p.email IS NOT NULL
     ORDER BY l.funding_amount DESC NULLS LAST`)).rows;

  const labs = (await query(`
    SELECT COUNT(*)::int total,
           COUNT(*) FILTER (WHERE funding_end >= CURRENT_DATE)::int funded,
           COUNT(*) FILTER (WHERE id IN (SELECT lab_id FROM research_people
                                          WHERE email IS NOT NULL))::int reachable
      FROM research_labs`)).rows[0];

  say(`\n── research contacts  (${rows.length} with an address)\n`);
  say(`   ${labs.total} lab(s) · ${labs.funded} with funding still live · ${labs.reachable} reachable`);
  if (labs.total) {
    say(`   reach ${Math.round((labs.reachable / labs.total) * 100)}% — the rest are real customers`);
    say(`   we have to find another way to, which is worth knowing per-lab rather than in aggregate.\n`);
  }

  if (!rows.length) {
    say('   Nothing to review yet. Run the ingest with --execute first.\n');
    process.exit(0);
  }

  // Grouped by institution so a systematic parsing error shows up as a cluster rather than as one
  // odd row among sixty.
  let lastInst = null;
  for (const r of rows) {
    if (r.institution_name !== lastInst) {
      say(`   ── ${r.institution_name}${r.country ? `  (${r.country})` : ''}`);
      lastInst = r.institution_name;
    }
    const amt = r.funding_amount != null ? `$${Number(r.funding_amount).toLocaleString()}` : '—';
    say(`      ${pad(r.full_name, 26)}${pad(r.email, 34)}${r.suppressed ? ' [SUPPRESSED]' : ''}`);
    say(`         ${pad(r.title || '', 20)} ${pad(r.department || '', 24)} ends ${String(r.funding_end || '').slice(0, 10)}  ${amt}  ${r.interests} interest(s)`);
    say(`         basis  ${r.email_basis} — ${r.published_for || ''}`);
    say(`         PAPER  ${r.paper_url || '(none recorded)'}`);
    say(`         AWARD  ${r.award_url || ''}`);
    if (r.focus) say(`         focus  ${String(r.focus).slice(0, 96)}`);
    say();
  }

  // ── WHAT A REVIEWER IS LOOKING FOR ────
  say('   HOW TO CHECK ONE');
  say('      Open the PAPER link. Find the corresponding-author line. The address there must belong');
  say('      to the PI named above — not to a co-author, and not to someone who merely shares the');
  say('      surname. That last case is the one that slipped through before the rule was tightened:');
  say('      a search for Scott Miller at Yale returned addresses for two other Millers.');
  say();
  say('      Wrong?   railway ssh \'node scripts/review-research-contacts.js \\');
  say('                 --suppress=the@address.edu --reason=manual --note="not the PI"\'');
  say();

  // A cheap systematic check that does not need the network: does the local part bear any relation
  // to the PI's name at all? A cluster of failures here means the rule regressed.
  const odd = rows.filter((r) => {
    const local = String(r.email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
    const last = String(r.pi_name || '').toLowerCase().split(/\s+/).pop().replace(/[^a-z]/g, '');
    return last.length > 3 && !local.includes(last.slice(0, 4));
  });
  if (odd.length) {
    say(`   ⚠ ${odd.length} address(es) whose local part does not contain the PI's surname.`);
    say('     Not necessarily wrong — initials-only addresses are legitimate — but check these first:');
    for (const r of odd) say(`        ${pad(r.pi_name, 26)} ${pad(r.email, 34)} ${r.paper_url}`);
    say();
  } else {
    say('   ✓ every address\'s local part contains the PI\'s surname.\n');
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('review-research-contacts failed:', e && e.message ? e.message : e);
  process.exit(1);
});
