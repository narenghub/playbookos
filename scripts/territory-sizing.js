#!/usr/bin/env node
// ── HOW BIG IS A TERRITORY BEFORE YOU GRANT IT? ───────────────────────────────
//
//   railway ssh 'node scripts/territory-sizing.js'
//
// READ ONLY. Nothing is written.
//
// There are 1,524 SiteNex prospects, all of them ours (source_partner_id NULL). A territory grant
// is what decides how many of those a partner can see, and the four dimensions —
// region / state / country / subtype — carve the list very differently. "Grant them a region"
// sounds modest and may hand over most of the book; "grant them a subtype" sounds narrow and may
// do the same.
//
// So this prints the actual distribution per dimension, with each value's share of the total, in
// the order a grant decision is made: biggest first, because the biggest is the one worth noticing
// before signing it over. Territories are OR'd, so granting two values hands over the sum.
'use strict';

const { query } = require('../src/lib/db');
const { DIMENSION_COLUMN } = require('../src/lib/products/territory-scope');

// Only OUR leads are gated by territory. A partner's own referrals are always visible to them, so
// counting those here would overstate what a grant actually gives away.
const WHERE = `product = 'sitenex' AND source_partner_id IS NULL`;

async function main() {
  const total = (await query(`SELECT COUNT(*)::int n FROM prospects WHERE ${WHERE}`)).rows[0].n;
  console.log(`── territory sizing · ${total} SiteNex prospects are OURS and therefore territory-gated\n`);
  if (!total) { console.log('   nothing to carve up.'); return; }

  for (const [dimension, column] of Object.entries(DIMENSION_COLUMN)) {
    let rows;
    try {
      rows = (await query(
        `SELECT COALESCE(${column}, '(blank)') v, COUNT(*)::int n
           FROM prospects WHERE ${WHERE}
          GROUP BY 1 ORDER BY 2 DESC, 1`)).rows;
    } catch (e) {
      console.log(`${dimension}: could not read (${e.message})\n`);
      continue;
    }
    console.log(`${dimension}  (${rows.length} distinct value${rows.length === 1 ? '' : 's'})`);
    for (const r of rows.slice(0, 12)) {
      const pct = Math.round((r.n / total) * 100);
      const bar = '█'.repeat(Math.max(1, Math.round(pct / 3)));
      console.log(`   ${String(r.v).slice(0, 28).padEnd(30)} ${String(r.n).padStart(5)}  ${String(pct).padStart(3)}%  ${bar}`);
    }
    if (rows.length > 12) {
      const rest = rows.slice(12).reduce((a, r) => a + r.n, 0);
      console.log(`   ${`… ${rows.length - 12} more values`.padEnd(30)} ${String(rest).padStart(5)}  ${String(Math.round((rest / total) * 100)).padStart(3)}%`);
    }
    // A '(blank)' bucket is worth calling out: those rows match NO value of this dimension, so a
    // territory on it can never reach them whoever holds it.
    const blank = rows.find((r) => r.v === '(blank)');
    if (blank) {
      console.log(`   ⚠ ${blank.n} row(s) have no ${dimension} — unreachable by ANY ${dimension} grant.`);
    }
    console.log();
  }

  console.log('Territories are OR\'d: two grants hand over the sum, not the overlap.');
  console.log('`exclusive` stops a second partner being given the same patch.');
  console.log('\nGrant on the SiteNex Partners page. Decide the share before signing it, not after:');
  console.log('a partner who has seen a lead list cannot un-see it.');
}

main().then(() => process.exit(0))
      .catch((e) => { console.error('sizing error:', e.message); process.exit(1); });
