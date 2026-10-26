#!/usr/bin/env node
// ── WHERE IS THE MONEY, AND WHERE DOES IT STOP? ──────────────────────────────
//
//   railway ssh 'node scripts/revenue-pipeline.js'
//
// Read-only.
//
// ── WHY THIS REPORT EXISTS ───────────────────────────────────────────────────
//
// Every other report in this repo measures a part: trials ingested, contacts emailed, products
// classified, labs found. Each can look healthy while no money moves, because they all measure
// EFFORT rather than DEMAND. This one asks a single question of every revenue path: is there a
// buyer in it, and if not, which step is empty?
//
// The distinction that matters, and the one the other reports cannot see:
//
//   SUPPLY SIDE  — suppliers, labs, partners. People who want to sell TO us or build WITH us.
//                  Cheap to accumulate, genuinely useful, and worth nothing by itself.
//   DEMAND SIDE  — buyers. People with a budget who want something FROM us.
//
// A pipeline can be full of the first and empty of the second, and every dashboard will look busy.
// So each section below is labelled, and the summary counts them separately.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { COUNTS_SQL } = require('../src/lib/revenue/demand');

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

async function count(sql, params = []) {
  try { return (await query(sql, params)).rows[0]; } catch (e) { return { err: e.message }; }
}
const n = (r, k = 'n') => (r && r.err ? '—' : (r ? r[k] : '—'));

async function main() {
  await initDB();
  say('\n── revenue pipeline · where the money is, and where it stops\n');

  // ── DEMAND: the only section that can produce revenue on its own ────
  say('   ══ DEMAND SIDE — buyers with a budget ═══════════════════════════════');

  // The rule for what counts as a buyer lives in src/lib/revenue/demand.js, imported rather than
  // written here, so this report and every other one answer "how many buyers" identically — and
  // so check-demand-count-sql.js can execute the same predicate against a real Postgres.
  const inq = await count(COUNTS_SQL);
  const quo = await count(`SELECT COUNT(*)::int n,
      COALESCE(SUM(total_price_usd),0)::numeric total FROM inquiry_quotes`);
  const rfq = await count('SELECT COUNT(*)::int n FROM rfq_requests');
  const ord = await count('SELECT COUNT(*)::int n FROM orders');
  const led = await count(`SELECT COUNT(*)::int n,
      COUNT(*) FILTER (WHERE status = 'won')::int won,
      COALESCE(SUM(estimated_value) FILTER (WHERE status <> 'lost'),0)::numeric pipeline FROM leads`);
  const del = await count('SELECT COUNT(*)::int n FROM lead_deliveries');

  say(`      ${pad('inquiries — REAL, EXTERNAL', 46)} ${n(inq, 'external')}   [last 30d: ${n(inq, 'external_30d')}]`);
  say(`      ${pad('  └ excluded: classified spam', 46)} ${n(inq, 'spam')}`);
  say(`      ${pad('  └ excluded: our own addresses/companies', 46)} ${n(inq, 'ours')}`);
  say(`      ${pad('  └ rows in the table altogether', 46)} ${n(inq, 'all_rows')}   ← do not quote this one`);
  say(`      ${pad('quotes issued', 46)} ${n(quo)}   [$${Number(n(quo, 'total') || 0).toLocaleString()}]`);
  say(`      ${pad('RFQs raised to suppliers', 46)} ${n(rfq)}`);
  say(`      ${pad('orders', 46)} ${n(ord)}`);
  say(`      ${pad('replies classified as leads', 46)} ${n(led)}   [won: ${n(led, 'won')}, pipeline $${Number(n(led, 'pipeline') || 0).toLocaleString()}]`);
  say(`      ${pad('leads delivered to a customer', 46)} ${n(del)}`);

  // ── SUPPLY: valuable, and not revenue ────
  say('\n   ══ SUPPLY SIDE — people who sell to us or partner with us ═══════════');
  const sup = await count('SELECT COUNT(*)::int n FROM suppliers');
  const prod = await count(`SELECT COUNT(*)::int n,
      COUNT(*) FILTER (WHERE review_status = 'approved')::int approved FROM supplier_products`);
  const labs = await count('SELECT COUNT(*)::int n FROM labs');
  say(`      ${pad('suppliers', 46)} ${n(sup)}`);
  say(`      ${pad('supplier products', 46)} ${n(prod)}   [approved: ${n(prod, 'approved')}]`);
  say(`      ${pad('QC labs', 46)} ${n(labs)}`);

  // ── AUDIENCE: reachable people who are not yet buyers ────
  say('\n   ══ AUDIENCE — reachable, not yet asked to buy ═══════════════════════');
  const rl = await count(`SELECT COUNT(*)::int n,
      (SELECT COUNT(*)::int FROM research_people WHERE email IS NOT NULL) mailable FROM research_labs`);
  const ev = await count(`SELECT event_slug, COUNT(*)::int n FROM cphi_exhibitor_contacts
    WHERE email IS NOT NULL AND email <> '' GROUP BY 1 ORDER BY 1`);
  const st = await count('SELECT COUNT(*)::int n FROM clinical_studies');
  say(`      ${pad('funded research labs', 46)} ${n(rl)}   [with an address: ${n(rl, 'mailable')}]`);
  say(`      ${pad('clinical studies (the demand-intel product)', 46)} ${n(st)}`);
  try {
    const rows = (await query(`SELECT event_slug, COUNT(*)::int n,
        COUNT(*) FILTER (WHERE id IN (SELECT contact_id FROM cphi_followup_sends))::int contacted
      FROM cphi_exhibitor_contacts WHERE email IS NOT NULL AND email <> ''
      GROUP BY 1 ORDER BY 1`)).rows;
    for (const r of rows) {
      say(`      ${pad(`event contacts · ${r.event_slug}`, 46)} ${r.n}   [contacted: ${r.contacted}]`);
    }
  } catch (_) { /* table shape differs */ }

  // ── THE READ ────
  say('\n   ══ WHAT THIS MEANS ══════════════════════════════════════════════════');
  const inquiries = Number(n(inq, 'external')) || 0;
  const orders = Number(n(ord)) || 0;
  const quotes = Number(n(quo)) || 0;

  if (!inquiries && !orders) {
    say('      No inquiries and no orders. Nobody has asked to buy anything.');
    say('      Every number in the supply and audience sections is a cost until that changes.');
    say('');
    say('      The gap is not data and not software. It is that no reachable buyer has been');
    say('      asked to buy. The audience section above lists people who could be asked today.');
  } else if (inquiries && !quotes) {
    say(`      ${inquiries} inquiry(ies) and zero quotes. Demand arrived and was not priced.`);
    say('      This is the most expensive failure available: the hard part already happened.');
  } else if (quotes && !orders) {
    say(`      ${quotes} quote(s) and no orders. Pricing or lead time is losing the business,`);
    say('      or nobody followed up. Ask the ones who did not buy why — that answer is worth');
    say('      more than another thousand contacts.');
  } else {
    say(`      ${inquiries} inquiries → ${quotes} quotes → ${orders} orders.`);
    say('      Work the conversion between the two weakest adjacent numbers.');
  }
  say('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('revenue-pipeline failed:', e && e.message ? e.message : e);
  process.exit(1);
});
