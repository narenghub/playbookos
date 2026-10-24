#!/usr/bin/env node
// ── RECORD WHAT WE GAVE, AND WHAT HAPPENED ───────────────────────────────────
//
//   # funnel by source — the question the whole platform exists to answer
//   railway ssh 'node scripts/lead-outcome.js --report'
//   railway ssh 'node scripts/lead-outcome.js --report --customer=mural-health'
//
//   # record a delivery (reason is required)
//   railway ssh 'node scripts/lead-outcome.js --deliver --customer=mural-health \
//      --type=clinical_study --ref=NCT01234567 --source=trial-feed \
//      --reason="recruiting, 1,200 participants, EU, changed 3 days ago" --execute'
//
//   # record what happened (append-only; correcting means appending, not editing)
//   railway ssh 'node scripts/lead-outcome.js --outcome=responded --delivery=42 --execute'
//   railway ssh 'node scripts/lead-outcome.js --outcome=won --delivery=42 --revenue=8500 --execute'
//   railway ssh 'node scripts/lead-outcome.js --outcome=wrong_contact --delivery=43 \
//      --reason="person left the company" --execute'
//
// Dry run unless --execute.
//
// ── WHY THE REJECTIONS MATTER AS MUCH AS THE WINS ────────────────────────────
//
// It is tempting to record only the good outcomes, because those are the ones worth telling people
// about. But "wrong_contact — person left the company" and "not_relevant — we already serve them"
// are the rows that will eventually teach the scoring which sources and signals are worth
// anything. A funnel with only wins in it cannot tell you what to stop doing.
//
// So a rejection reason is a first-class field, and the report shows losses beside wins rather
// than quietly filtering them out.
'use strict';

const { initDB, query } = require('../src/lib/db');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EXECUTE = has('execute');
const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

// The order a lead moves through. Used only for display, so the funnel reads as a funnel.
const FUNNEL = ['viewed', 'useful', 'contacted', 'responded', 'meeting_booked', 'qualified',
  'opportunity_created', 'won'];
const REJECTIONS = ['not_relevant', 'wrong_company', 'wrong_contact', 'lost'];

async function report() {
  const CUSTOMER = arg('customer', '');
  const where = CUSTOMER ? 'WHERE customer_key = $1' : '';
  const params = CUSTOMER ? [CUSTOMER] : [];

  const tot = (await query(
    `SELECT COUNT(*)::int n, COUNT(DISTINCT customer_key)::int customers
       FROM lead_deliveries ${where}`, params)).rows[0];

  say(`\n── lead outcomes${CUSTOMER ? ` · ${CUSTOMER}` : ''}\n`);
  say(`   ${tot.n} delivery(ies) to ${tot.customers} customer(s)`);
  if (!tot.n) {
    say('\n   Nothing delivered yet. Until deliveries are recorded, every score the platform');
    say('   computes is a hypothesis with nothing to check it against.\n');
    return;
  }

  // ── THE FUNNEL ────
  const states = (await query(
    `SELECT COALESCE(current_outcome, '(no outcome recorded)') s, COUNT(*)::int n
       FROM lead_current_state ${where} GROUP BY 1`, params)).rows;
  const byState = Object.fromEntries(states.map((r) => [r.s, r.n]));

  say('\n   FUNNEL');
  for (const s of FUNNEL) {
    const n = byState[s] || 0;
    const bar = '█'.repeat(Math.min(40, Math.round((n / tot.n) * 40)));
    say(`      ${pad(s, 20)} ${pad(n, 6)} ${bar}`);
  }
  const rejected = REJECTIONS.reduce((a, s) => a + (byState[s] || 0), 0);
  const none = byState['(no outcome recorded)'] || 0;
  say(`      ${pad('— rejected', 20)} ${pad(rejected, 6)}`);
  say(`      ${pad('— no outcome yet', 20)} ${pad(none, 6)}`);
  if (none === tot.n) {
    say('\n   ⚠ every delivery is still waiting for an outcome. The table is recording what we');
    say('     sent but nothing about whether it worked, which is half a ground truth.');
  }

  // ── WHY LEADS ARE REJECTED ────
  const why = (await query(
    `SELECT o.outcome, COALESCE(o.reason, '(no reason given)') reason, COUNT(*)::int n
       FROM lead_outcomes o JOIN lead_deliveries d ON d.id = o.delivery_id
      ${CUSTOMER ? 'WHERE d.customer_key = $1' : ''}
        ${CUSTOMER ? 'AND' : 'WHERE'} o.outcome IN (${REJECTIONS.map((r) => `'${r}'`).join(',')})
      GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`, params)).rows;
  if (why.length) {
    say('\n   WHY LEADS WERE REJECTED  (this is what improves the pipeline)');
    for (const r of why) say(`      ${pad(r.n, 5)} ${pad(r.outcome, 16)} ${r.reason}`);
  }

  // ── WHICH SOURCE ACTUALLY PRODUCES REVENUE ────
  // The question the architecture exists to answer, asked as plainly as the data allows.
  const bySource = (await query(`
    SELECT d.source,
           COUNT(*)::int delivered,
           COUNT(*) FILTER (WHERE s.current_outcome = 'responded')::int responded,
           COUNT(*) FILTER (WHERE s.current_outcome IN ('qualified','opportunity_created'))::int qualified,
           COUNT(*) FILTER (WHERE s.current_outcome = 'won')::int won,
           COALESCE(SUM(s.revenue_value) FILTER (WHERE s.current_outcome = 'won'), 0) revenue
      FROM lead_deliveries d
      JOIN lead_current_state s ON s.delivery_id = d.id
     ${where ? where.replace('customer_key', 'd.customer_key') : ''}
     GROUP BY d.source ORDER BY revenue DESC, delivered DESC`, params)).rows;

  say('\n   BY SOURCE');
  say(`      ${pad('source', 26)}${pad('sent', 7)}${pad('replied', 9)}${pad('qualified', 11)}${pad('won', 6)}revenue`);
  for (const r of bySource) {
    say(`      ${pad(r.source, 26)}${pad(r.delivered, 7)}${pad(r.responded, 9)}`
      + `${pad(r.qualified, 11)}${pad(r.won, 6)}${Number(r.revenue).toLocaleString()}`);
  }
  say('\n   A source with deliveries and no outcomes is not performing badly — it is unmeasured.');
  say('   Those are different, and only one of them is fixable by changing the pipeline.\n');
}

async function main() {
  await initDB();
  if (has('report') || argv.length === 0) { await report(); process.exit(0); }

  // ── RECORD A DELIVERY ────
  if (has('deliver')) {
    const reason = arg('reason', '');
    if (!reason) {
      console.error('--reason is required. A lead we cannot explain is not a lead we should send.');
      process.exit(1);
    }
    const row = {
      customer: arg('customer', ''), type: arg('type', ''), ref: arg('ref', ''),
      source: arg('source', ''), campaign: arg('campaign', null),
      evidence: arg('evidence', null), method: arg('method', 'csv'),
      confidence: arg('confidence', null),
    };
    for (const k of ['customer', 'type', 'ref', 'source']) {
      if (!row[k]) { console.error(`--${k} is required`); process.exit(1); }
    }
    say(`\n   deliver  ${row.customer} ← ${row.type}:${row.ref}  (source ${row.source})`);
    say(`   reason   ${reason}`);
    if (!EXECUTE) { say('\n   DRY RUN — re-run with --execute.\n'); process.exit(0); }
    const r = await query(`
      INSERT INTO lead_deliveries
        (customer_key, campaign_key, subject_type, subject_ref, source, reason,
         evidence_url, confidence, delivery_method)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [row.customer, row.campaign, row.type, row.ref, row.source, reason,
      row.evidence, row.confidence, row.method]);
    say(`\n   ✅ delivery ${r.rows[0].id} recorded.\n`);
    process.exit(0);
  }

  // ── RECORD AN OUTCOME ────
  const outcome = arg('outcome', '');
  if (outcome) {
    const id = parseInt(arg('delivery', ''), 10);
    if (!Number.isFinite(id)) { console.error('--delivery=<id> is required'); process.exit(1); }
    const d = (await query('SELECT * FROM lead_current_state WHERE delivery_id = $1', [id])).rows[0];
    if (!d) { console.error(`no delivery ${id}`); process.exit(1); }

    say(`\n   delivery ${id}  ·  ${d.customer_key}  ·  ${d.subject_type}:${d.subject_ref}`);
    say(`   current: ${d.current_outcome || '(none)'}  ·  ${d.outcome_events} event(s) recorded`);
    say(`   adding:  ${outcome}${arg('revenue', '') ? ` · revenue ${arg('revenue', '')}` : ''}`);
    if (arg('reason', '')) say(`   reason:  ${arg('reason', '')}`);
    if (!EXECUTE) { say('\n   DRY RUN — re-run with --execute.\n'); process.exit(0); }

    await query(`
      INSERT INTO lead_outcomes (delivery_id, outcome, revenue_value, reason, recorded_by)
      VALUES ($1,$2,$3,$4,$5)`,
    [id, outcome, arg('revenue', null), arg('reason', null), arg('by', 'lead-outcome.js')]);
    say('\n   ✅ appended. Earlier events are untouched — that history is the point.\n');
    process.exit(0);
  }

  console.error('nothing to do. --report, --deliver or --outcome=<state>');
  process.exit(1);
}

main().catch((e) => {
  console.error('lead-outcome failed:', e && e.message ? e.message : e);
  process.exit(1);
});
