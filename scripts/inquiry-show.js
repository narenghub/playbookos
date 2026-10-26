#!/usr/bin/env node
// ── THE FEW REAL ENQUIRIES, IN FULL ──────────────────────────────────────────
//
//   railway ssh 'node scripts/inquiry-show.js'
//   railway ssh 'node scripts/inquiry-show.js --id=12'
//   railway ssh 'node scripts/inquiry-show.js --all'          # include the spam
//
// Read-only.
//
// ── WHY A SECOND INQUIRY REPORT ──────────────────────────────────────────────
//
// triage-inquiries.js counts and classifies. That was enough to discover the thing worth knowing —
// of 37 inquiries, twenty are form spam and four are our own test records — but a count cannot be
// replied to. Answering somebody needs the whole record: what they actually wrote, which address
// it came from, what quantity, and whether anyone has already written back.
//
// So this prints the full row for the handful that are plausibly real, and hides the rest behind
// --all. The filter is deliberately crude and stated in the output, because a report that silently
// decides which customers are worth showing is worse than one that shows everything.
'use strict';

const { initDB, query } = require('../src/lib/db');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const say = (s = '') => console.log(s);

// ── WHAT COUNTS AS NOT-REAL ────
// Internal addresses and our own companies: every one of the four inquiries that looked quotable
// turned out to be a test record from qa-buyer@abiozen.com or naresh.boda143@gmail.com under
// "ABIOZEN LLC", "abc" and "Adifice Technologies". Those are ours, and counting them as demand is
// how a dashboard flatters its owner.
const OURS = /@abiozen\.com$|naresh\.boda|@adificetechnologies\.com$/i;
const OUR_CO = /^(abiozen|adifice|abc)\b/i;

async function main() {
  await initDB();

  const cols = (await query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'inquiries' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);

  const rows = (await query(`
    SELECT i.*, (SELECT COUNT(*)::int FROM inquiry_quotes q WHERE q.inquiry_id = i.id) quotes
      FROM inquiries i ORDER BY i.created_at DESC`)).rows;

  const ID = arg('id', '');
  const age = (d) => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);

  function verdict(r) {
    if (String(r.status || '') === 'spam') return 'spam (classified)';
    const em = String(r.buyer_email || '');
    const co = String(r.buyer_company || '');
    if (OURS.test(em) || OUR_CO.test(co)) return 'ours (internal/test)';
    return 'EXTERNAL';
  }

  let shown = rows;
  if (ID) shown = rows.filter((r) => String(r.id) === String(ID));
  else if (!has('all')) shown = rows.filter((r) => verdict(r) === 'EXTERNAL');

  say(`\n── inquiries · ${rows.length} total · showing ${shown.length}`
    + `${ID ? ` (id ${ID})` : has('all') ? ' (all)' : ' (external only — --all shows spam and test rows)'}\n`);

  for (const r of shown) {
    say(`   ══ #${r.id} · ${age(r.created_at)} days old · ${verdict(r)} ═══════════════════`);
    for (const c of cols) {
      const v = r[c];
      if (v == null || v === '') continue;
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      // Long free text (the actual message) gets its own indented block rather than one wide line.
      if (s.length > 70) {
        say(`      ${c}:`);
        for (const line of s.split(/\r?\n/)) say(`         ${line}`);
      } else {
        say(`      ${c.padEnd(22)} ${s}`);
      }
    }
    say(`      ${'quotes issued'.padEnd(22)} ${r.quotes}`);
    say('');
  }

  if (!has('all') && !ID) {
    const skipped = rows.length - shown.length;
    say(`   ${skipped} row(s) hidden: classified spam, or from our own addresses and companies.`);
    say('   --all prints them, so nothing here is hidden by a rule you cannot see.\n');
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('inquiry-show failed:', e && e.message ? e.message : e);
  process.exit(1);
});
