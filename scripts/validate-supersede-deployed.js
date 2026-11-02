#!/usr/bin/env node
// ── STRUCTURAL VALIDATION OF SUPERSESSION ON PRODUCTION. READ-ONLY. ─────────
//
//   railway ssh 'node scripts/validate-supersede-deployed.js --approval=<id>'
//
// WRITES NOTHING — no INSERT, UPDATE or DELETE, and it supersedes nothing. It answers "is the
// mechanism deployed and correct, and is this approval still in the state the supersession
// assumes", so that the real transition afterwards is an authorized governance operation rather
// than a discovery.
//
// ── WHY IT DOES NOT TRY AND FAIL ───────────────────────────────────────────
//
//   "A production verification must never perform the mutation it predicts will be refused."
//
// A validator that proved the forbidden transitions by ATTEMPTING them against the real approval
// would be betting that record on its own prediction, and the one run where the guard did not
// fire is the run nobody would be expecting. The forbidden transitions are proven behaviourally
// in check-office-supersede-db.js, on a throwaway cluster, where a wrong prediction costs nothing.
//
// Here the arbitration is read as a DEFINITION — the deployed SQL text and the schema constraint —
// and the approval's current state is read without touching it. Reading the shipped source is
// weaker evidence than executing it, and it is the right strength for this question: whether the
// deployed code SAYS the right thing, having already proven elsewhere that what it says is
// load-bearing.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const scope = require('../src/lib/office/scope');
const { query } = require('../src/lib/db');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(24)} ${v}`);

const arg = (k, d = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
const digestOf = (p) => crypto.createHash('sha256').update(canonical(p)).digest('hex');

(async () => {
  try {
    const APPROVAL_ID = arg('approval');
    if (!APPROVAL_ID) { console.error('usage: validate-supersede-deployed.js --approval=<id>'); process.exit(2); }

    console.log('\n══ SUPERSESSION — STRUCTURAL VALIDATION (READ-ONLY) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // ── 1. THE SCHEMA ACCEPTS THE NEW VALUE, AND STILL ACCEPTS THE OLD ONES ─
    console.log('  ── THE MECHANISM IS DEPLOYED ──\n');
    const chk = (await query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conname = 'office_approvals_status_check'`)).rows[0];
    field('status CHECK', chk ? chk.d.replace(/\s+/g, ' ') : '(not found)');
    if (chk && /superseded/.test(chk.d)) ok("the deployed CHECK accepts 'superseded'");
    else bad("the deployed schema does not accept 'superseded' — the migration has not run here");
    for (const s of ['pending', 'approved', 'rejected', 'expired']) {
      if (chk && chk.d.includes(`'${s}'`)) continue;
      bad(`the CHECK no longer accepts '${s}' — the change was not additive`);
    }
    if (chk && ['pending', 'approved', 'rejected', 'expired'].every((s) => chk.d.includes(`'${s}'`))) {
      ok('and still accepts every status it accepted before');
    }

    for (const col of ['superseded_at', 'superseded_by', 'superseded_reason', 'previous_status']) {
      const c = (await query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'office_approvals' AND column_name = $1`, [col])).rows[0];
      if (c) ok(`attribution column ${col} exists`);
      else bad(`attribution column ${col} is missing — the supersession could not be attributed`);
    }

    if (typeof scope.supersedeApproval === 'function') ok('scope.supersedeApproval is deployed');
    else bad('scope.supersedeApproval is not deployed on this build');

    // ── 2. THE ARBITRATION SAYS WHAT IT MUST ────────────────────────────────
    //
    // Read from the SHIPPED SOURCE on this container, not from memory of what was written. The
    // behavioural proof that each predicate is load-bearing is in the fixture harness; this is
    // the check that the deployed text still contains them.
    console.log('\n  ── THE ARBITRATION, AS DEPLOYED ──\n');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'office', 'scope.js'), 'utf8');
    const i = src.indexOf('async function supersedeApproval');
    const body = i === -1 ? '' : src.slice(i, src.indexOf('\nasync function', i + 10));
    if (!body || body.length < 300) {
      bad('could not read the deployed supersedeApproval body — this check is reading nothing');
    } else {
      const want = [
        ["status = 'superseded'", 'it sets the terminal status'],
        ["AND a.status = 'approved'", 'it requires the current status to be approved'],
        ['AND a.release_claimed_at IS NULL', 'it requires no release claim'],
        ['AND a.released_at IS NULL', 'it requires no release'],
        ['NOT EXISTS', 'it consults the outreach log rather than trusting the timestamps alone'],
        ['supplier_outreach_log', 'and that is the table it consults'],
        ['previous_status = a.status', 'it records what the action came from'],
      ];
      for (const [needle, what] of want) {
        if (body.includes(needle)) ok(what);
        else bad(`the deployed arbitration is MISSING: ${needle}`, what);
      }
      // It must not touch the payload or the original decision.
      for (const forbidden of ['action_payload =', 'resolution =', 'resolved_by =', 'resolved_at =']) {
        if (body.includes(forbidden)) {
          bad(`the deployed arbitration ASSIGNS ${forbidden} — supersession must not rewrite the `
            + 'payload or the original decision evidence');
        }
      }
      if (!['action_payload =', 'resolution =', 'resolved_by =', 'resolved_at ='].some((f) => body.includes(f))) {
        ok('and it assigns neither the payload nor the original decision fields');
      }
    }

    // R1 refuses a superseded action STRUCTURALLY: the release claim demands status='approved'.
    const claimBody = (() => {
      const j = src.indexOf('async function claimApprovalRelease');
      return j === -1 ? '' : src.slice(j, src.indexOf('\nasync function', j + 10));
    })();
    if (claimBody.includes("AND status = 'approved'")) {
      ok('the release claim still demands status = approved, so a superseded action cannot release');
    } else bad('the release claim no longer requires an approved status');

    // ── 3. THE APPROVAL IS STILL IN THE STATE THE TRANSITION ASSUMES ────────
    console.log('\n  ── THE APPROVAL, AS IT STANDS NOW ──\n');
    const row = await scope.bootstrapApprovalForExecution(APPROVAL_ID);
    if (!row) { bad(`no approval ${APPROVAL_ID}`); }
    else {
      const p = row.action_payload || {};
      field('approval id', row.id);
      field('status', row.status);
      field('payload sha256', digestOf(p));
      field('FROM', p.from || '(NONE RECORDED)');
      field('release_claimed_at', row.release_claimed_at || '(none)');
      field('released_at', row.released_at || '(none)');
      field('approval resolution', (row.resolution || '(none)').slice(0, 90));

      if (row.status === 'approved') ok('still APPROVED — the only status the transition accepts');
      else bad(`status is "${row.status}"; the transition accepts only approved`);
      if (!row.release_claimed_at && !row.released_at) ok('never claimed and never released');
      else bad('this approval has already been claimed — supersession would be too late');

      const claims = (await query(
        `SELECT COUNT(*)::int n FROM supplier_outreach_log
          WHERE approval_id = $1 OR (rfq_id = $2 AND supplier_id = $3)`,
        [APPROVAL_ID, p.rfq_id || null, p.supplier_id || null])).rows[0].n;
      field('external claim rows', claims);
      if (claims === 0) ok('no supplier claim exists for this approval or its (RFQ, supplier) pair');
      else bad(`${claims} external claim row(s) exist — the outside world may already have been reached`);

      const attempts = (await query(
        `SELECT COUNT(*)::int n FROM agent_run_events
          WHERE run_id = $1 AND kind = 'ACTION_ATTEMPTED'`, [row.run_id])).rows[0].n;
      field('ACTION_ATTEMPTED', attempts);
      if (attempts === 0) ok('no attempt evidence exists on its run');
      else bad(`${attempts} ACTION_ATTEMPTED event(s) — an external attempt was made`);

      // ── 4. THE BUSINESS INTENT WILL SURVIVE IT ──────────────────────────
      const rfqMod = require('../src/lib/office/procurement-rfq');
      const prior = await scope.rfqApprovalsForEligibility(p.rfq_id, {});
      const asIfSuperseded = prior.map((a) => (a.id === APPROVAL_ID
        ? { ...a, status: 'superseded' } : a));
      const blocked = rfqMod.intentBlockedBy(asIfSuperseded, p.supplier_id);
      const nextN = rfqMod.nextAttempt(asIfSuperseded, p.supplier_id);
      console.log('');
      field('attempts on this intent', prior.filter((a) => a.supplier_id === p.supplier_id).length);
      field('next attempt would be', nextN);
      if (!blocked) {
        ok('once superseded, this (RFQ, supplier) is preparable again — the business intent is NOT '
          + 'consumed. Computed from the real prior attempts, with this one treated as superseded');
      } else {
        bad('even superseded, something would still block re-preparation', JSON.stringify(blocked));
      }
      if (nextN > 1) ok(`and the replacement would take a NEW approval identity (attempt ${nextN})`);
      else bad('the attempt number would not advance');

      // The external send's uniqueness is untouched by any of this.
      const idx = (await query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_supplier_outreach_rfq_supplier'`)).rows[0];
      if (idx && /UNIQUE/.test(idx.indexdef) && !/WHERE/.test(idx.indexdef)) {
        ok('and UNIQUE (rfq_id, supplier_id) on the outreach log is unchanged and unconditional');
      } else bad('the external-send uniqueness has changed', idx && idx.indexdef);
    }

    console.log('');
    if (fail) {
      console.log(`FAIL  ${fail} structural assertion(s) failed. Do not perform the supersession.\n`);
      process.exit(1);
    }
    console.log('PASS  the mechanism is deployed and correct, and this approval is still exactly in');
    console.log('      the state the transition assumes. Nothing was written by this check.\n');
    note('the forbidden transitions are proven behaviourally in check-office-supersede-db.js, on a');
    note('throwaway cluster — never attempted against this record.');
    console.log('');
    process.exit(0);
  } catch (e) {
    console.error(`\nFAIL  ${e.stack || e.message}\n`);
    process.exit(1);
  }
})();
