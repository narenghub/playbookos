#!/usr/bin/env node
// ── IS THE RFQ IDENTITY GUARD REALLY LIVE, AND COMPATIBLE WITH PRODUCTION? ──
//
//   railway ssh 'node scripts/validate-rfq-guard-deployed.js'
//
// THE VERDICT IS THE EXIT CODE. 0 = every required proof held.
//
// ── WHAT THIS DOES AND DOES NOT WRITE ───────────────────────────────────────
//
// It creates no business data. It emails nobody. It never calls rfqClaim.claim and never
// manufactures a supplier_outreach_log row.
//
// ONE DELIBERATE EXCEPTION, disclosed rather than hidden: proving the append-only trigger
// BEHAVIOURALLY needs a row to attempt an UPDATE and a DELETE against, and the trigger is
// `BEFORE UPDATE OR DELETE ... FOR EACH ROW`, so against an empty table it never fires and a
// zero-row UPDATE succeeds trivially — which would be a check passing for an unrelated reason.
//
// So section 4 inserts one synthetic decision row INSIDE A TRANSACTION THAT IS DELIBERATELY ROLLED
// BACK. The trigger blocks UPDATE and DELETE; it does not block a rollback, so nothing durable is
// written. A permanent row could not be removed afterwards precisely because the table is
// append-only, and leaving validation residue in commercial evidence is not acceptable.
//
// Row counts are measured either side of everything, so "it wrote nothing" is a MEASUREMENT.
'use strict';

const fs = require('fs');
const path = require('path');
const { query, withTransaction } = require('../src/lib/db');
const guard = require('../src/lib/procurement/rfq-identity-guard');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 500)}`); };
const h = (n, t) => out(`\n── ${n}. ${t}`);

// The historical record that must not change. Pre-cutover truth.
const TRAMADOL_FILED_CAS = '27203-92-5';
const TRAMADOL_CANONICAL = '36282-47-0';

async function counts() {
  const r = await query(
    `SELECT (SELECT COUNT(*)::int FROM rfq_identity_decisions) decisions,
            (SELECT COUNT(*)::int FROM supplier_outreach_log) outreach,
            (SELECT COUNT(*)::int FROM rfq_requests) rfqs,
            (SELECT COALESCE(MAX(id),0)::int FROM rfq_identity_decisions) max_decision`);
  return r.rows[0];
}

async function main() {
  out('');
  out('════ RFQ IDENTITY GUARD — DEPLOYMENT VALIDATION ═══════════════════════');
  out('   Creates no business data. Sends no email. Never claims a supplier.');

  let before;
  try { before = await counts(); } catch (e) {
    bad('cannot read the required tables', e.message);
    out(`\nFAIL  ${fail} proof(s) failed`); return 1;
  }
  out(`   before: decisions=${before.decisions} outreach=${before.outreach} rfqs=${before.rfqs}`);

  // ── 1. the deployed code carries the guard ──────────────────────────────
  h(1, 'the guard module is present in the deployed code');
  if (guard && typeof guard.guardSend === 'function' && typeof guard.decide === 'function') {
    ok(`guard module loaded, version ${guard.GUARD_VERSION}`);
  } else { bad('the guard module is absent or incomplete in the deployed code'); }

  // ── 2. the table and its exact shape ────────────────────────────────────
  h(2, 'rfq_identity_decisions exists with the expected schema');
  const EXPECTED = ['id', 'rfq_id', 'decided_at', 'filed_name', 'filed_cas', 'cas_class',
    'resolution', 'molecule_id', 'molecule_ref', 'canonical_cas', 'cas_suppressed', 'eligible',
    'decision', 'refusal_reason', 'approved_name', 'approved_cas', 'guard_version'];
  const cols = (await query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'rfq_identity_decisions' ORDER BY ordinal_position`)).rows;
  if (!cols.length) {
    bad('rfq_identity_decisions DOES NOT EXIST — the boot migration did not run');
  } else {
    const names = cols.map((c) => c.column_name);
    const missing = EXPECTED.filter((c) => !names.includes(c));
    const extra = names.filter((c) => !EXPECTED.includes(c));
    if (!missing.length && !extra.length) ok(`all ${EXPECTED.length} expected columns present, none extra`);
    else bad('schema mismatch', `missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
    for (const c of cols) out(`     ${c.column_name.padEnd(16)} ${c.data_type}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
  }

  // ── 3. the append-only trigger exists AND is enabled ────────────────────
  h(3, 'the append-only trigger is present and enabled');
  const trg = (await query(
    `SELECT t.tgname, t.tgenabled, p.proname
       FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'rfq_identity_decisions'::regclass AND NOT t.tgisinternal`)
    .catch(() => ({ rows: [] }))).rows;
  const appendOnly = trg.find((t) => t.tgname === 'trg_rfq_identity_decisions_append_only');
  if (!appendOnly) bad('the append-only trigger is MISSING');
  else if (appendOnly.tgenabled !== 'O') bad(`the trigger exists but is DISABLED (tgenabled=${appendOnly.tgenabled})`);
  else ok(`trigger ${appendOnly.tgname} → ${appendOnly.proname}(), enabled`);

  // ── 4/5. UPDATE and DELETE are refused — behaviourally, then rolled back ─
  h('4/5', 'UPDATE and DELETE are refused by the database (inside a rolled-back transaction)');
  const SENTINEL = 'validation-rollback-sentinel';
  let updateRefused = false; let deleteRefused = false; let insertedId = null;
  try {
    await withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO rfq_identity_decisions
           (rfq_id, filed_name, filed_cas, cas_class, resolution, eligible, decision,
            refusal_reason, guard_version)
         VALUES ($1,'__validation__',NULL,'absent','not_found',false,'refuse',
                 'identity_unresolved',$2)
         RETURNING id`,
        [`__validation__${Date.now()}`, `${guard.GUARD_VERSION}+validation`]);
      insertedId = ins.rows[0].id;

      await client.query('SAVEPOINT s1');
      try {
        await client.query(`UPDATE rfq_identity_decisions SET decision='allow' WHERE id=$1`, [insertedId]);
      } catch (e) { updateRefused = /append-only/i.test(e.message); }
      await client.query('ROLLBACK TO SAVEPOINT s1');

      await client.query('SAVEPOINT s2');
      try {
        await client.query(`DELETE FROM rfq_identity_decisions WHERE id=$1`, [insertedId]);
      } catch (e) { deleteRefused = /append-only/i.test(e.message); }
      await client.query('ROLLBACK TO SAVEPOINT s2');

      // Force the rollback. withTransaction COMMITS on success, and this row must never persist.
      throw new Error(SENTINEL);
    });
    bad('the validation transaction COMMITTED — a synthetic row may have persisted');
  } catch (e) {
    if (e.message !== SENTINEL) bad('the validation transaction failed unexpectedly', e.message);
  }
  if (updateRefused) ok('UPDATE on a real row is refused by the trigger');
  else bad('UPDATE was NOT refused — the append-only guarantee does not hold');
  if (deleteRefused) ok('DELETE on a real row is refused by the trigger');
  else bad('DELETE was NOT refused — the append-only guarantee does not hold');

  // And prove the rollback worked: the synthetic row must not exist.
  if (insertedId !== null) {
    const left = (await query(
      `SELECT COUNT(*)::int n FROM rfq_identity_decisions WHERE id=$1`, [insertedId])).rows[0].n;
    if (left === 0) ok('the synthetic validation row was rolled back — nothing durable was written');
    else bad(`THE SYNTHETIC ROW PERSISTED at id=${insertedId} and cannot be removed (append-only)`);
  }

  // ── 6. the deployed application has the guard WIRED, not merely present ──
  h(6, 'the deployed RFQ writer refuses unapproved identity facts');
  // Behavioural, and consequential in no way: no database write, no claim, no email. A grep for
  // the require would prove the words are in the file and never that the path is enforced — the
  // same mistake as the territory-grant test that passed by grepping its own query text.
  try {
    const agent = require('../src/lib/agents/procurement-agent');
    let threw = false;
    try {
      await agent.generateRFQEmail(
        { molecule_name: 'Tramadol Hydrochloride', cas_number: TRAMADOL_FILED_CAS },
        { name: 'validation-no-send', contact_email: 'nobody@invalid' }, '__validation__');
    } catch (e) { threw = /approved by rfq-identity-guard/i.test(e.message); }
    if (threw) ok('generateRFQEmail rejects raw RFQ fields — the guard is wired in the deployed code');
    else bad('the deployed renderer ACCEPTED unapproved identity facts — the guard is not wired');
  } catch (e) { bad('could not load the deployed procurement agent', e.message); }

  // ── 7. the historical Tramadol row is unchanged ─────────────────────────
  h(7, 'the July Tramadol RFQ remains historical truth');
  const hist = (await query(
    `SELECT id, molecule_name, cas_number, status, week_start, created_at
       FROM rfq_requests WHERE LOWER(molecule_name) LIKE '%tramadol%'`)).rows;
  if (!hist.length) {
    bad('the historical Tramadol RFQ is MISSING — history appears to have been altered');
  } else {
    for (const r of hist) {
      out(`     ${r.id} ${JSON.stringify(r.molecule_name)} cas=${r.cas_number} status=${r.status} created=${r.created_at}`);
    }
    const t = hist.find((r) => String(r.cas_number) === TRAMADOL_FILED_CAS);
    if (t) ok(`filed CAS is still ${TRAMADOL_FILED_CAS} — preserved, not corrected to ${TRAMADOL_CANONICAL}`);
    else bad(`no Tramadol RFQ carries the historical ${TRAMADOL_FILED_CAS} any more`);
    const sent = hist.filter((r) => ['sent', 'responded', 'compared', 'approved', 'ordered'].includes(r.status));
    out(`     historical rows whose status implies a send: ${sent.length}`);
  }

  // ── 8/9. nothing was created by this validation ─────────────────────────
  h('8/9', 'zero supplier claims and zero emails created by this validation');
  const after = await counts();
  if (after.outreach === before.outreach) ok(`supplier_outreach_log unchanged at ${after.outreach} row(s) — no claim, and no confirmed send`);
  else bad(`supplier_outreach_log changed ${before.outreach} → ${after.outreach}`);
  if (after.decisions === before.decisions) ok(`rfq_identity_decisions unchanged at ${after.decisions} row(s)`);
  else bad(`rfq_identity_decisions changed ${before.decisions} → ${after.decisions}`);
  if (after.rfqs === before.rfqs) ok(`rfq_requests unchanged at ${after.rfqs} row(s) — no fake RFQ created`);
  else bad(`rfq_requests changed ${before.rfqs} → ${after.rfqs}`);
  out('     no email was attempted: this script never calls sendEmail and never reaches a send path.');
  out('     supplier_outreach_log being unchanged is the measurable consequence — rfqClaim.confirm');
  out('     writes there on every successful send, so an unchanged count means none occurred.');

  // ── 10. naturally occurring decisions ───────────────────────────────────
  h(10, 'identity decisions that have occurred naturally since deployment');
  const nat = (await query(
    `SELECT id, rfq_id, decided_at, filed_name, filed_cas, cas_class, resolution,
            decision, refusal_reason, approved_cas, guard_version
       FROM rfq_identity_decisions ORDER BY id DESC LIMIT 25`)).rows;
  if (!nat.length) {
    out('     none. The guard has not been exercised by a real dispatch, and may not be for some');
    out('     time: all six existing RFQs already carry status=sent, so none is pending dispatch.');
    out('     A natural decision therefore requires a NEW RFQ, which only arrives when an');
    out('     approval_queue sourcing row is approved. A guard that never runs is a guard whose');
    out('     live behaviour is never observed, so the Postgres suite remains the behavioural');
    out('     proof until then.');
  } else {
    for (const d of nat) {
      out(`     [${d.id}] ${d.rfq_id} ${d.decision}${d.refusal_reason ? `/${d.refusal_reason}` : ''} `
        + `filed=${JSON.stringify(d.filed_name)} cas=${d.filed_cas || 'none'}(${d.cas_class}) `
        + `approved=${d.approved_cas || 'none'} ${d.decided_at}`);
    }
  }

  // ── 11. the reconciliation runs against the real schema ─────────────────
  h(11, 'the reconciliation executes against the production schema');
  // Run in-process so its own type assumptions meet the real column types. The fixture for this
  // guard originally declared sent_at as TIMESTAMPTZ where production has TEXT, which concealed a
  // COALESCE type error — exactly the class of defect only the real schema can surface.
  let reconCode = null;
  try {
    const recon = require('./rfq-identity-reconcile');
    reconCode = await recon.main();
    if (reconCode === 0) ok('reconciliation executed and reports RECONCILED');
    else bad(`reconciliation executed and reports ${reconCode} failure(s) — see its output above`);
  } catch (e) {
    bad('the reconciliation THREW against the production schema', `${e.message}`);
  }

  out('');
  out('════ DIGEST ═══════════════════════════════════════════════════════════');
  out(`guard_version=${guard.GUARD_VERSION} table=${cols.length ? 'present' : 'MISSING'} `
    + `append_only=${appendOnly && appendOnly.tgenabled === 'O' ? 'enabled' : 'NO'} `
    + `update_refused=${updateRefused} delete_refused=${deleteRefused}`);
  out(`decisions=${after.decisions} outreach=${after.outreach} rfqs=${after.rfqs} `
    + `recon=${reconCode === null ? 'threw' : reconCode} failures=${fail}`);
  out('');
  if (fail) { out(`FAIL  ${fail} required proof(s) failed. The guard is NOT validated.`); return 1; }
  out('PASS  the RFQ identity guard is deployed, schema-compatible and append-only enforced');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { fs.writeSync(2, `VALIDATION FAILED: ${e.message}\n${e.stack}\n`); process.exit(2); });
}

module.exports = { main };
