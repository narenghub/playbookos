#!/usr/bin/env node
// ── PUT A PRICE ON P1 AND P2. ─────────────────────────────────────────────────
//
//   node scripts/set-sitenex-prices.js                      → dry run, shows current vs proposed
//   node scripts/set-sitenex-prices.js --execute            → writes
//   node scripts/set-sitenex-prices.js --p1=3500 --p1-monthly=149 ...
//
// `sitenex_packages.setup_fee_cents` and `monthly_cents` have been NULL since the packages were first
// seeded, deliberately: everything that reads a package refuses to render rather than print $0,
// so a missing price fails loudly instead of quoting free work. The consequence is that ACBM Partners
// cannot quote at all, and §4.5 of the partner agreement obliges supplying a range.
//
// WHY THIS IS A SCRIPT AND NOT A MIGRATION. A price is a commercial decision, not a schema fact. It
// changes without the schema changing, it has to be reversible, and the one thing it must never do
// is move silently — a package whose price changed between two quotes is an argument with a client.
// So: dry run by default, prints the current value beside the proposed one, and names every row it
// would touch before it touches it.
//
// WHAT THIS DOES NOT DO. It does not touch `active`. P3 stays inactive and unpriced on purpose: it
// is a 16-week web-plus-mobile build whose market is an order of magnitude above P1/P2, and a number
// in that column is an invitation to quote it on a phone call. Pricing P3 is a separate decision
// with a separate conversation.
'use strict';

const { initDB, query } = require('../src/lib/db');

const EXECUTE = process.argv.includes('--execute');
const dollars = (flag, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!hit) return dflt;
  const n = Number(hit.split('=')[1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${flag} must be a non-negative number of dollars`);
  return n;
};

// Defaults are the recommendation, not a decision. Override any of them on the command line.
const PROPOSED = {
  P1: { setup: dollars('p1', 3500), monthly: dollars('p1-monthly', 149) },
  P2: { setup: dollars('p2', 3950), monthly: dollars('p2-monthly', 149) },
};

const money = (cents) => (cents == null ? '— not priced —' : `$${(cents / 100).toLocaleString('en-US')}`);

async function main() {
  await initDB();

  const before = (await query(
    `SELECT code, name, active, typical_weeks, setup_fee_cents, monthly_cents
       FROM sitenex_packages ORDER BY code`)).rows;

  console.log('── SiteNex package prices\n');
  console.log('   code  name       wk  active  setup now        → proposed      monthly now    → proposed');
  for (const p of before) {
    const prop = PROPOSED[p.code];
    console.log(
      `   ${p.code.padEnd(5)} ${String(p.name).padEnd(10)} ${String(p.typical_weeks || '').padStart(2)}  ` +
      `${p.active ? 'yes   ' : 'no    '}  ${money(p.setup_fee_cents).padEnd(16)} ` +
      `${prop ? ('→ ' + `$${prop.setup.toLocaleString('en-US')}`).padEnd(14) : 'unchanged'.padEnd(14)} ` +
      `${money(p.monthly_cents).padEnd(14)} ${prop ? '→ $' + prop.monthly.toLocaleString('en-US') : 'unchanged'}`);
  }

  // A package nobody can see cannot be quoted, so a price on an inactive row is noise at best.
  const inactivePriced = before.filter((p) => !p.active && PROPOSED[p.code]);
  if (inactivePriced.length) {
    console.log(`\n   ⚠ ${inactivePriced.map((p) => p.code).join(', ')} is inactive — pricing it does not make it sellable.`);
  }

  // The contents of P2 include "Everything in Launch (P1)" plus three more deliverables, so P2 is a
  // strict superset. A superset priced BELOW its subset is a contradiction ACBM Partners would
  // have to explain on a call, and the explanation does not exist.
  if (PROPOSED.P1 && PROPOSED.P2 && PROPOSED.P2.setup < PROPOSED.P1.setup) {
    console.log(`\n   ✗ P2 ($${PROPOSED.P2.setup}) is priced BELOW P1 ($${PROPOSED.P1.setup}), but P2's`);
    console.log(`     included list is "Everything in Launch (P1)" plus content migration, a 301`);
    console.log(`     redirect map and a before/after report. A superset cannot cost less.`);
    console.log(`     Either raise P2 or change what P2 includes. Refusing to write.`);
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log('\n   DRY RUN — nothing written. Re-run with --execute.');
    console.log('   Flags: --p1= --p1-monthly= --p2= --p2-monthly=  (dollars, not cents)\n');
    return;
  }

  for (const [code, p] of Object.entries(PROPOSED)) {
    const r = await query(
      `UPDATE sitenex_packages
          SET setup_fee_cents = $2, monthly_cents = $3
        WHERE code = $1
        RETURNING code`,
      [code, Math.round(p.setup * 100), Math.round(p.monthly * 100)]);
    if (!r.rows.length) console.log(`   ⚠ no package row with code ${code} — nothing updated`);
  }

  const after = (await query(
    `SELECT code, setup_fee_cents, monthly_cents FROM sitenex_packages
      WHERE code = ANY($1) ORDER BY code`, [Object.keys(PROPOSED)])).rows;
  console.log('\n   written:');
  for (const p of after) {
    console.log(`      ${p.code}  setup ${money(p.setup_fee_cents)}  ·  monthly ${money(p.monthly_cents)}`);
  }
  // Read back rather than trusting the UPDATE's own word: the whole reason the NULLs were safe is
  // that readers refuse to render them, so a half-written price is worse than none.
  const stillNull = after.filter((p) => p.setup_fee_cents == null || p.monthly_cents == null);
  if (stillNull.length) {
    console.log(`\n   ✗ ${stillNull.map((p) => p.code).join(', ')} still holds a NULL price. Readers will refuse to render it.`);
    process.exit(1);
  }
  console.log('\n   ACBM Partners can now quote P1 and P2. P3 remains unpriced and inactive.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('set-sitenex-prices failed:', e && e.message ? e.message : e);
  process.exit(1);
});
