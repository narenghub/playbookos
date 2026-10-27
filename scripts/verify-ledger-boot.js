#!/usr/bin/env node
// ── WHAT BOOT ACTUALLY CREATED, READ FROM THE DATABASE ───────────────────────
//
//   railway ssh 'node scripts/verify-ledger-boot.js'
//
// Exit 0 = every invariant boot was supposed to install is present and enforcing.
// Exit 1 = something is missing. Exit 2 = supplier RFQ uniqueness is blocked by existing data.
//
// ── WHY THIS EXISTS RATHER THAN READING THE BOOT LOG ─────────────────────────
//
// A boot line says a function returned; it does not say the constraint exists. The two are
// different claims and this week has produced several cases where the reassuring one was true and
// the load-bearing one was not — a migration not wired into boot at all, a script answering a
// different question than the flag asked, a health check reporting "healthy after rotation" with
// nothing rotated.
//
// So this interrogates pg_indexes, pg_trigger and pg_constraint for the real objects. It prints no
// credentials, no email bodies and no message contents: for a blocked RFQ index it prints the
// identifiers, counts, statuses and timestamps a human needs to decide which record to keep, and
// nothing more.
'use strict';

const { query } = require('../src/lib/db');

let fail = 0;
let blocked = false;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };

async function hasTable(name) {
  const r = await query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [name]);
  return r.rows.length > 0;
}
async function indexDef(name) {
  const r = await query(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [name]);
  return r.rows.length ? r.rows[0].indexdef : null;
}
async function triggerEnabled(name) {
  const r = await query(`SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`, [name]);
  return r.rows.length ? r.rows[0].tgenabled : null;
}

(async () => {
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';
  console.log(`\n── boot invariants · commit ${commit}\n`);

  // ── 1. THE RUN LEDGER ──────────────────────────────────────────────────────
  for (const t of ['agent_runs', 'agent_run_events']) {
    if (await hasTable(t)) ok(`table ${t} exists`);
    else bad(`table ${t} is MISSING — migrateRuns did not run here`);
  }

  const active = await indexDef('uq_agent_runs_one_active');
  if (active && /UNIQUE/.test(active) && /CREATED/.test(active) && /RUNNING/.test(active)) {
    ok('uq_agent_runs_one_active is UNIQUE and predicated on the active states');
  } else bad('the active-intent arbiter is missing or not unique', active || '(no such index)');

  const attempt = await indexDef('uq_agent_runs_intent_attempt');
  if (attempt && /UNIQUE/.test(attempt)) ok('uq_agent_runs_intent_attempt is UNIQUE');
  else bad('the attempt-numbering index is missing or not unique', attempt || '(no such index)');

  for (const [trg, label] of [
    ['trg_agent_run_events_append_only', 'agent_run_events append-only'],
    ['trg_agent_runs_retry_guard', 'retry eligibility'],
    ['trg_agent_runs_transition_guard', 'terminal immutability / legal transitions'],
  ]) {
    const e = await triggerEnabled(trg);
    if (e === 'O') ok(`${label} trigger is installed and ENABLED`);
    else if (e === null) bad(`${label} trigger is MISSING`);
    else bad(`${label} trigger exists but is DISABLED (tgenabled=${e})`);
  }

  // The FK from a stopped run to the exact refusal. Added separately from the DDL because it
  // depends on autonomy_events existing, and a hard migration-order dependency breaks a fresh deploy.
  const fk = await query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_stopped_by_fkey'`);
  if (fk.rows.length) ok('agent_runs.stopped_by → autonomy_events foreign key is present');
  else bad('the stopped_by foreign key is missing: a policy-stopped run could not be traced to its refusal');

  // ── 2. THE KILL SWITCH (P0.2), still enforcing ─────────────────────────────
  for (const t of ['autonomy_stops', 'autonomy_events']) {
    if (await hasTable(t)) ok(`table ${t} exists`);
    else bad(`table ${t} is MISSING`);
  }
  const stopTrg = await triggerEnabled('trg_autonomy_stops_audit');
  if (stopTrg === 'O') ok('autonomy stop/resume audit trigger is installed and ENABLED');
  else bad(`autonomy audit trigger is ${stopTrg === null ? 'MISSING' : `DISABLED (${stopTrg})`}`);

  // ── 3. SUPPLIER RFQ UNIQUENESS (P0.3 item 1) ───────────────────────────────
  const rfq = await indexDef('uq_supplier_outreach_rfq_supplier');
  if (rfq && /UNIQUE/.test(rfq)) {
    ok('uq_supplier_outreach_rfq_supplier is UNIQUE — a duplicate supplier RFQ is impossible');
  } else {
    blocked = true;
    console.log('  ✗ CRITICAL  supplier RFQ uniqueness is NOT enforced.');
    console.log('              RFQ sending is refusing, by design. The index cannot be created');
    console.log('              while duplicate pairs exist, and choosing which record to keep is');
    console.log('              a human decision about real correspondence.\n');
    const d = await query(
      `SELECT rfq_id, supplier_id, COUNT(*)::int n,
              MIN(sent_at) AS first_sent, MAX(sent_at) AS last_sent,
              string_agg(DISTINCT COALESCE(status,'(null)'), ', ' ORDER BY COALESCE(status,'(null)')) AS statuses,
              string_agg(id, ', ' ORDER BY id) AS row_ids
         FROM supplier_outreach_log
        WHERE rfq_id IS NOT NULL AND supplier_id IS NOT NULL
        GROUP BY rfq_id, supplier_id HAVING COUNT(*) > 1
        ORDER BY n DESC, rfq_id`);
    console.log(`              ${d.rows.length} duplicate (rfq_id, supplier_id) pair(s):\n`);
    for (const r of d.rows) {
      console.log(`                rfq=${r.rfq_id}  supplier=${r.supplier_id}  rows=${r.n}`);
      console.log(`                  statuses: ${r.statuses}`);
      console.log(`                  sent_at:  ${r.first_sent || '(null)'} … ${r.last_sent || '(null)'}`);
      console.log(`                  row ids:  ${r.row_ids}`);
    }
    console.log('\n              No email subjects or bodies are printed. To see one row in full,');
    console.log('              query supplier_outreach_log by its id.');
    console.log('              Decide which row to keep, remove the others, then redeploy so boot');
    console.log('              can create the index. Nothing here repairs data automatically.\n');
  }

  // ── 4. Is anything already recorded? Informational, not a verdict. ─────────
  if (await hasTable('agent_runs')) {
    const n = await query(`SELECT COUNT(*)::int n FROM agent_runs`);
    const e = await query(`SELECT COUNT(*)::int n FROM agent_run_events`);
    console.log(`\n  note  ledger currently holds ${n.rows[0].n} run(s) and ${e.rows[0].n} event(s).`);
    if (n.rows[0].n === 0) console.log('        Expected to be 0 until the canary is wired — nothing writes to it yet.');
  }

  console.log('');
  if (fail) { console.log(`✗ FAIL — ${fail} invariant(s) missing or disabled.\n`); process.exit(1); }
  if (blocked) { console.log('✗ BLOCKED — the ledger is sound; supplier RFQ uniqueness awaits a human decision.\n'); process.exit(2); }
  console.log('✓ PASS — every invariant boot installs is present and enforcing.\n');
})().catch((e) => { console.error('verify-ledger-boot failed:', e && e.message ? e.message : e); process.exit(1); });
