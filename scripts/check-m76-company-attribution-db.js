#!/usr/bin/env node
// ── THE PILOT'S COMPANY COMES FROM A REVIEWED MAPPING ───────────────────────
//
// Owner, Workstream A.5: *"Correct m76/pipeline.js company attribution using reviewed persisted
// workflow-company mappings. Use synthetic development mappings for verification. Do not infer a
// company from a label, email domain or default company."* and *"Verify that hardware-required
// synthetic tasks execute under the correct company scope while cloud workers cannot claim them."*
//
// `pilot.test.js` injects a stub resolver because it runs with no database at all. This is the
// check that the real resolution works: a real `workflow_companies` row, written by the real
// `mapWorkflowToCompany` with a real administrator, and the three refusals attempted rather than
// described.
//
// The last section is the one the owner asked for by name: a hardware task attributed to the
// synthetic pilot company, claimable by the hardware worker and NOT by a cloud worker — the two
// facts that together make "correct company scope" mean something.
//
// The verdict is the exit status.

'use strict';

process.env.ADMIN_EMAIL = 'm76ca@m76.invalid';
process.env.ADMIN_PASSWORD = `m-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m) => { fail += 1; lines.push(`  FAIL  ${m}`); };
const note = (m) => lines.push(`  --    ${m}`);
const section = (t) => lines.push('', `── ${t} ──`, '');

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'm76-company-attribution' });
  } catch (e) {
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  process.env.DATABASE_URL = cluster.url;

  const DB = require('../src/lib/db');
  const { query } = DB;

  try {
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);

    const WC = require('../src/lib/identity/workflow-company');
    const POLICY = require('../src/lib/m76/policy');
    const SYN = require('../src/lib/worker/synthetic-isolation');
    const LEASES = require('../src/lib/worker/leases');
    const IDENT = require('../src/lib/worker/identity');
    const WORKFLOW = POLICY.PILOT_WORKFLOW;

    // ═══ 1. UNMAPPED REFUSES, AND SAYS WHICH OF THE THREE IT IS ═════════════
    section('1. with no mapping, the pilot dispatches nothing');

    const unmapped = await WC.resolveWorkflowCompany(WORKFLOW, { query });
    if (unmapped.ok === false && unmapped.code === 'not_mapped') {
      ok('an unmapped workflow refuses as not_mapped — distinct from unreadable and from ambiguous');
    } else {
      bad(`resolveWorkflowCompany returned ${JSON.stringify(unmapped)}`);
    }
    if (/no default company and none is inferred/.test(unmapped.detail || '')) {
      ok('and the refusal says there is no default company, rather than quietly choosing one');
    } else {
      bad('the refusal does not state that nothing is inferred');
    }

    // ═══ 2. A REVIEWED SYNTHETIC MAPPING ════════════════════════════════════
    section('2. a mapping written by a real administrator, for a synthetic company');

    const ADMIN = 'm76ca-admin';
    await query(
      `INSERT INTO users (id, email, name, role, is_active, password_hash)
       VALUES ($1,$2,$1,'super_admin',1,'x')`, [ADMIN, `${ADMIN}@m76.invalid`]);
    const PILOT_CO = `m76-pilot-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$2,'active')`,
      [PILOT_CO, 'M7.6 Pilot (synthetic)']);
    await SYN.setCompanySynthetic(PILOT_CO, true, { query });

    // The real writer, which goes through the membership actor check — so this mapping is a
    // reviewed act and not a row somebody inserted.
    await WC.mapWorkflowToCompany({
      workflow: WORKFLOW, companyId: PILOT_CO, grantedBy: ADMIN,
      grantedReason: 'M7.6 development pilot, synthetic company',
    }, { query });

    const resolved = await WC.resolveWorkflowCompany(WORKFLOW, { query });
    if (resolved.ok === true && resolved.companyId === PILOT_CO) {
      ok('the pilot workflow now resolves to the synthetic pilot company');
    } else {
      bad(`resolution returned ${JSON.stringify(resolved)}`);
    }

    // Nothing was inferred: a DIFFERENT workflow with no mapping still refuses, so section 2 is
    // not measuring a default that happens to exist.
    const other = await WC.resolveWorkflowCompany('some-other-workflow', { query });
    if (other.ok === false) {
      ok('CONTROL: another workflow still refuses — the mapping is per workflow, not a global default');
    } else {
      bad(`an unmapped sibling workflow resolved to ${JSON.stringify(other)}`);
    }

    // ═══ 3. AMBIGUITY IS A REFUSAL, NOT A CHOICE ════════════════════════════
    section('3. two mappings refuse rather than picking one');

    const SECOND_CO = `m76-second-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$2,'active')`,
      [SECOND_CO, 'Second Co']);
    await WC.mapWorkflowToCompany({
      workflow: WORKFLOW, companyId: SECOND_CO, grantedBy: ADMIN,
      grantedReason: 'deliberate ambiguity, for this assertion',
    }, { query });
    const ambiguous = await WC.resolveWorkflowCompany(WORKFLOW, { query });
    if (ambiguous.ok === false && ambiguous.code === 'ambiguous'
        && (ambiguous.candidates || []).length === 2) {
      ok('two active mappings refuse as ambiguous and NAME both candidates');
    } else {
      bad(`two mappings produced ${JSON.stringify(ambiguous)}`);
    }
    await WC.unmapWorkflow({
      workflow: WORKFLOW, companyId: SECOND_CO, revokedBy: ADMIN,
      revokedReason: 'restoring the single mapping',
    }, { query });
    const single = await WC.resolveWorkflowCompany(WORKFLOW, { query });
    if (single.ok === true && single.companyId === PILOT_CO) {
      ok('and unmapping the second restores a single resolution');
    } else {
      bad(`after unmapping, resolution is ${JSON.stringify(single)}`);
    }

    // ═══ 4. AN UNREADABLE MAPPING IS NOT AN UNMAPPED WORKFLOW ═══════════════
    section('4. an unreadable mapping table refuses differently');

    const broken = await WC.resolveWorkflowCompany(WORKFLOW, {
      query: () => { throw new Error('connection refused'); } });
    if (broken.ok === false && broken.code === 'unresolvable') {
      ok('an unreadable table is `unresolvable`, not `not_mapped` — they need different action');
    } else {
      bad(`an unreadable mapping produced ${JSON.stringify(broken)}`);
    }

    // ═══ 5. THE PILOT DISPATCHES UNDER THAT COMPANY ═════════════════════════
    section('5. dispatchPlan attributes its tasks to the resolved company');

    // Enqueue the way the pipeline now does — the company resolved, not passed by a caller.
    // THE TYPE, AND WHY IT IS THIS ONE. The registry holds exactly ONE HARDWARE_REQUIRED type —
    // `synthetic.crash_test` — because `desktop.capture_once` is GUI_SESSION_REQUIRED and demands
    // `exec:gui`, which must not be granted to any identity until B4.4c. So the owner's
    // "hardware-required synthetic tasks execute under the correct company scope" is verified at
    // CLAIM time with the one type that qualifies.
    //
    // **Nothing is executed and no hardware is touched.** This is a disposable local cluster with
    // no worker process running: `claimTask` takes a lease and returns a payload, and that is all
    // that happens here. Execution of this type is separately gated behind four arming conditions
    // (`WORKER_ALLOW_CRASH_TEST`, a development environment assertion, a confirmation string and a
    // matching worker id), none of which is satisfied, and no deliberate hardware crash is
    // authorized or performed.
    const intent = `m76ca-${crypto.randomUUID().slice(0, 8)}`;
    const enq = await LEASES.enqueueTask({
      taskType: 'synthetic.crash_test',
      payload: { reason: 'company attribution fixture — claimed, never executed' },
      intentKey: intent,
      workflow: WORKFLOW,
      companyId: single.companyId,
      createdBy: 'm76-pilot',
    }, { query });
    if (!enq || !enq.ok) throw new Error(`could not enqueue: ${JSON.stringify(enq)}`);
    const row = await query(
      'SELECT company_id, workflow FROM worker_tasks WHERE id = $1', [enq.taskId]);
    if (row.rows[0].company_id === PILOT_CO) {
      ok('a pilot task carries the resolved company — no longer NULL, which is what broke isolation');
    } else {
      bad(`the task's company_id is ${row.rows[0].company_id}`);
    }

    // ═══ 6. THE HARDWARE WORKER CLAIMS IT; A CLOUD WORKER CANNOT ════════════
    section('6. correct company scope, and cloud workers still cannot take hardware work');

    // The hardware identity stays RESTRICTED — the owner forbade widening it — and claims this
    // task because the company is marked synthetic. That is the whole point of A.5: attribution
    // rather than widening.
    const hwTok = await IDENT.createEnrollmentToken({
      label: 'm76-imac-hardware', capabilities: ['exec:hardware'], createdBy: ADMIN,
    }, { query });
    const hw = await IDENT.consumeEnrollmentToken(
      { token: hwTok.token, hostFingerprint: 'imac' }, { query });
    if (hw.ok !== true) throw new Error(`hardware enrolment failed: ${JSON.stringify(hw)}`);
    if (hw.syntheticOnly === true) {
      ok('the hardware identity is RESTRICTED — it was not widened to make this work');
    } else {
      bad('the hardware identity came out unrestricted, which is what the owner forbade');
    }

    const cloudTok = await IDENT.createEnrollmentToken(
      { label: 'm76-cloud', capabilities: [] }, { query });
    const cloud = await IDENT.consumeEnrollmentToken(
      { token: cloudTok.token, hostFingerprint: 'cloud' }, { query });
    if (cloud.ok !== true) throw new Error(`cloud enrolment failed: ${JSON.stringify(cloud)}`);

    const cloudTry = await LEASES.claimTask({ workerId: cloud.workerId }, { query });
    if (cloudTry && cloudTry.ok === false) {
      ok(`a cloud worker cannot claim the hardware task (${cloudTry.code})`);
    } else {
      bad(`a cloud worker claimed hardware work: ${JSON.stringify(cloudTry && cloudTry.taskId)}`);
    }

    const hwTry = await LEASES.claimTask({ workerId: hw.workerId }, { query });
    if (hwTry && hwTry.ok === true && hwTry.taskId === enq.taskId) {
      ok('the hardware worker DOES claim it, under the synthetic pilot company');
    } else {
      bad(`the hardware worker could not claim it: ${JSON.stringify(hwTry && (hwTry.code || hwTry))}`);
    }

    // And the decisive negative: unmark the company and the same hardware worker is closed out,
    // which proves section 6 measured the attribution rather than the capability.
    await SYN.setCompanySynthetic(PILOT_CO, false, { query });
    const intent2 = `m76ca2-${crypto.randomUUID().slice(0, 8)}`;
    const enq2 = await LEASES.enqueueTask({
      taskType: 'synthetic.crash_test', payload: { reason: 'second' }, intentKey: intent2,
      workflow: WORKFLOW, companyId: PILOT_CO, createdBy: 'm76-pilot',
    }, { query });
    if (!enq2 || !enq2.ok) throw new Error(`could not enqueue the second task: ${JSON.stringify(enq2)}`);
    const afterUnmark = await LEASES.claimTask({ workerId: hw.workerId }, { query });
    if (afterUnmark && afterUnmark.ok === false) {
      ok('with the company no longer synthetic, even the hardware worker is refused — the gate is '
        + 'the company, not the capability');
    } else {
      bad(`after unmarking, the hardware worker still claimed ${JSON.stringify(afterUnmark && afterUnmark.taskId)}`);
    }
    const executed = await query(
      `SELECT COUNT(*)::int n FROM worker_results`).catch(() => ({ rows: [{ n: 0 }] }));
    if (executed.rows[0].n === 0) {
      ok('and ZERO results exist — nothing was executed, measured rather than asserted');
    } else {
      bad(`${executed.rows[0].n} result row(s) exist, so something executed`);
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
  } finally {
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ THE PILOT\'S COMPANY ATTRIBUTION ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  company attribution holds (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
