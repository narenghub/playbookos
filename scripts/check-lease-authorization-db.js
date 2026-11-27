#!/usr/bin/env node
// ── AUTHORIZATION AT EVERY BOUNDARY OF A LEASE, NOT ONLY AT CLAIM ───────────
//
// Owner, Workstream A.6 and A.7: *"Complete objective classification, data provenance, initiation,
// planning, delegation, enqueue, claim, retry, recovery and result submission authorization."* and
// *"Test authorization withdrawal during active leases. Verify renewal, payload retrieval, result
// submission and downstream effects independently."*
//
// **What the measurement found before any of this was written.** Migration 62 gated at CLAIM, and
// that was the whole of it. Withdrawing a company's authorization while a worker held a lease had
// no effect anywhere:
//
//   company unmarked synthetic   renewal ALLOWED   result ACCEPTED   task COMPLETED
//   company SUSPENDED            renewal ALLOWED   result ACCEPTED
//   identity revoked             renewal refused   result refused     (already correct)
//
// Revocation of the IDENTITY was sound because `releaseLeasesOfWorker` closes its leases. The
// COMPANY's authorization was enforced on no boundary but the first. B3.18's `phase-guard` asks
// those questions at every phase boundary of the office cycle — and the worker lease path is a
// second road to the same effects, which is why a guard on one road is a statement about that road.
//
// Each section below withdraws authorization by a DIFFERENT route and checks each surface
// independently, as the owner asked, with a control that the same operation succeeds while
// authorization holds.
//
// The verdict is the exit status.

'use strict';

process.env.ADMIN_EMAIL = 'lease@lease.invalid';
process.env.ADMIN_PASSWORD = `l-${require('crypto').randomBytes(16).toString('hex')}`;
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
    cluster = PG.create({ label: 'lease-authorization' });
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
    const IDENT = require('../src/lib/worker/identity');
    const LEASES = require('../src/lib/worker/leases');
    const SYN = require('../src/lib/worker/synthetic-isolation');
    await IDENT.migrateWorkerIdentity(query);
    await LEASES.migrateWorkerTasks(query);

    const CO = `lz-co-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$2,'active')`,
      [CO, 'Lease Co']);
    await SYN.setCompanySynthetic(CO, true, { query });

    const enrol = async (label) => {
      const t = await IDENT.createEnrollmentToken({ label }, { query });
      const e = await IDENT.consumeEnrollmentToken(
        { token: t.token, hostFingerprint: label }, { query });
      if (!e || e.ok !== true) throw new Error(`enrolment failed: ${JSON.stringify(e)}`);
      return e.workerId;
    };
    const WORKER = await enrol('lz-worker');

    let n = 0;
    const enqueue = async () => {
      n += 1;
      const r = await LEASES.enqueueTask({
        taskType: 'synthetic.echo', payload: { echo: `lz-${n}` },
        intentKey: `lz-${n}-${crypto.randomUUID().slice(0, 8)}`,
        companyId: CO, createdBy: 'check-lease-authorization',
      }, { query });
      if (!r || !r.ok) throw new Error(`enqueue failed: ${JSON.stringify(r)}`);
      return r.taskId;
    };
    const claim = () => LEASES.claimTask({ workerId: WORKER }, { query });
    const beat = (runId) => LEASES.heartbeat({ workerId: WORKER, runId }, { query });
    const submit = (runId, echo) => LEASES.submitResult(
      { workerId: WORKER, runId, status: 'SUCCEEDED', output: { echo } }, { query });

    // ═══ 0. THE CONTROL FIRST ═══════════════════════════════════════════════
    section('0. CONTROL — the whole lifecycle succeeds while authorization holds');

    const t0 = await enqueue();
    const c0 = await claim();
    if (c0.ok && c0.taskId === t0) ok('claim succeeds'); else bad(`claim: ${JSON.stringify(c0)}`);
    const b0 = await beat(c0.runId);
    if (b0 && b0.ok === true) ok('renewal succeeds'); else bad(`renewal: ${JSON.stringify(b0)}`);
    const s0 = await submit(c0.runId, 'lz-1');
    if (s0 && s0.ok === true) ok('result submission succeeds'); else bad(`result: ${JSON.stringify(s0)}`);
    const st0 = await query('SELECT state FROM worker_tasks WHERE id = $1', [t0]);
    if (st0.rows[0].state === 'COMPLETED') {
      ok('and the task reaches COMPLETED — so every refusal below is the gate, not a broken path');
    } else {
      bad(`the authorized task ended ${st0.rows[0].state}`);
    }

    // ═══ 1. THE CLASSIFICATION IS WITHDRAWN MID-LEASE ═══════════════════════
    section('1. the company stops being synthetic while the lease is held');

    const t1 = await enqueue();
    const c1 = await claim();
    if (!c1.ok) throw new Error(`could not claim: ${JSON.stringify(c1)}`);
    if (JSON.stringify(c1.payload) === JSON.stringify({ echo: 'lz-2' })) {
      note('PAYLOAD RETRIEVAL: the worker already holds the payload from the moment it claimed — '
        + 'there is no later fetch to refuse, which is why the result path has to assume the work '
        + 'may already have happened');
    }
    await SYN.setCompanySynthetic(CO, false, { query });

    const b1 = await beat(c1.runId);
    if (b1 && b1.ok === false && b1.code === 'authorization_withdrawn') {
      ok('RENEWAL is refused as authorization_withdrawn');
    } else {
      bad(`renewal after unmarking returned ${JSON.stringify(b1 && (b1.code || b1))}`);
    }
    if (b1 && b1.cancel === true) {
      ok('and it carries cancel:true, the signal the worker already knows how to obey');
    } else {
      bad('the refusal does not tell the worker to stop');
    }

    const s1 = await submit(c1.runId, 'lz-2');
    if (s1 && s1.ok === false && s1.code === 'authorization_withdrawn') {
      ok('RESULT SUBMISSION is refused');
    } else {
      bad(`result after unmarking returned ${JSON.stringify(s1 && (s1.code || s1))}`);
    }
    const st1 = await query(
      'SELECT state, resolution_note FROM worker_tasks WHERE id = $1', [t1]);
    if (st1.rows[0].state === 'NEEDS_RESOLUTION') {
      ok('DOWNSTREAM EFFECT: the task is NEEDS_RESOLUTION, not COMPLETED and not silently dropped');
    } else {
      bad(`the task ended ${st1.rows[0].state}`);
    }
    if (/was NOT stored/.test(st1.rows[0].resolution_note || '')
        && /may already have been performed/.test(st1.rows[0].resolution_note || '')) {
      ok('and the note says the output was not stored and the work may already have happened');
    } else {
      bad(`the resolution note is ${JSON.stringify(st1.rows[0].resolution_note)}`);
    }
    // The output must genuinely not be stored — measured, not promised.
    const stored = await query(
      `SELECT COUNT(*)::int n FROM worker_results WHERE run_id = $1`, [c1.runId]);
    if (stored.rows[0].n === 0) {
      ok('no result row exists for the withdrawn lease — the payload was not ingested');
    } else {
      bad('a result row was stored for a company whose authorization had been withdrawn');
    }
    await SYN.setCompanySynthetic(CO, true, { query });

    // ═══ 2. THE COMPANY IS SUSPENDED MID-LEASE ══════════════════════════════
    section('2. the company is suspended while the lease is held');

    const t2 = await enqueue();
    const c2 = await claim();
    if (!c2.ok) throw new Error(`could not claim: ${JSON.stringify(c2)}`);
    await query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [CO]);
    const b2 = await beat(c2.runId);
    const s2 = await submit(c2.runId, 'lz-3');
    if (b2 && b2.code === 'authorization_withdrawn' && /suspended/.test(b2.detail || '')) {
      ok('renewal is refused AND the reason names the suspension, not the classification');
    } else {
      bad(`suspension produced ${JSON.stringify(b2 && (b2.code || b2))}`);
    }
    if (s2 && s2.code === 'authorization_withdrawn') {
      ok('and the result is refused for the same reason');
    } else {
      bad(`the result after suspension returned ${JSON.stringify(s2 && (s2.code || s2))}`);
    }
    await query(`UPDATE companies SET status = 'active' WHERE id = $1`, [CO]);
    void t2;

    // ═══ 3. ENQUEUE, AND THE DATABASE IS WHAT REFUSES IT ════════════════════
    section('3. ENQUEUE for a suspended company is refused by the database');

    await query(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [CO]);
    let enqueueRefused = false;
    let byDatabase = false;
    try { await enqueue(); } catch (e) {
      enqueueRefused = true;
      byDatabase = /suspend|not active|active_company/i.test(e.message);
    }
    if (enqueueRefused) {
      ok(`new work cannot be created for a suspended company${byDatabase ? ' — refused by the trigger' : ''}`);
    } else {
      bad('a task was enqueued for a suspended company');
    }
    await query(`UPDATE companies SET status = 'active' WHERE id = $1`, [CO]);

    // ═══ 4. RETRY AND RECOVERY GO BACK THROUGH THE SAME GATE ════════════════
    section('4. a recovered task is re-claimed through the claim filter, not around it');

    const t4 = await enqueue();
    const c4 = await claim();
    if (!c4.ok) throw new Error(`could not claim: ${JSON.stringify(c4)}`);
    // Abandon the lease the way the reaper does, then withdraw the classification, then let the
    // worker try again. Recovery must not be a side door.
    await query(
      `UPDATE agent_runs SET state = 'FAILED', ended_at = NOW() WHERE run_id = $1`, [c4.runId]);
    await query(
      `UPDATE worker_tasks SET state = 'PENDING' WHERE id = $1`, [t4]);
    await SYN.setCompanySynthetic(CO, false, { query });
    const reclaim = await claim();
    if (reclaim && reclaim.ok === false) {
      ok(`a recovered task cannot be re-claimed once the classification is withdrawn (${reclaim.code})`);
    } else {
      bad(`recovery let the worker back in: ${JSON.stringify(reclaim && reclaim.taskId)}`);
    }
    await SYN.setCompanySynthetic(CO, true, { query });
    const reclaim2 = await claim();
    if (reclaim2 && reclaim2.ok === true) {
      ok('CONTROL: and it CAN be re-claimed once the classification is restored');
    } else {
      bad(`re-claim after restoring returned ${JSON.stringify(reclaim2 && reclaim2.code)}`);
    }

    // ═══ 5. AN UNREADABLE AUTHORIZATION IS A REFUSAL ════════════════════════
    section('5. an authorization that cannot be read does not hold');

    const t5 = await enqueue();
    const c5 = await claim();
    if (!c5.ok) throw new Error(`could not claim: ${JSON.stringify(c5)}`);
    let callCount = 0;
    const flaky = async (sql, params) => {
      callCount += 1;
      // Let the lease lookup through, then break the authorization read specifically.
      if (/FROM companies/.test(sql)) throw new Error('connection refused');
      return query(sql, params);
    };
    const b5 = await LEASES.heartbeat(
      { workerId: WORKER, runId: c5.runId }, { query: flaky });
    if (b5 && b5.ok === false && b5.code === 'authorization_unreadable') {
      ok('an unreadable company row refuses the renewal, distinctly from a withdrawn one');
    } else {
      bad(`an unreadable authorization produced ${JSON.stringify(b5 && (b5.code || b5))}`);
    }
    void t5;
    void callCount;

    // ═══ 6. IDENTITY REVOCATION STILL WORKS ═════════════════════════════════
    section('6. revocation, heartbeat and rotation behaviour preserved (A.8)');

    const t6 = await enqueue();
    const c6 = await claim();
    if (!c6.ok) throw new Error(`could not claim: ${JSON.stringify(c6)}`);
    await IDENT.revokeWorker(WORKER, { reason: 'lease authorization check' }, { query });
    const b6 = await beat(c6.runId);
    if (b6 && b6.ok === false) {
      ok(`a revoked identity cannot renew its lease (${b6.code})`);
    } else {
      bad('a revoked identity renewed its lease');
    }
    const s6 = await submit(c6.runId, 'lz-x');
    if (s6 && s6.ok === false) {
      ok(`and cannot submit a result (${s6.code})`);
    } else {
      bad('a revoked identity submitted a result');
    }
    const freed = await query('SELECT state FROM worker_tasks WHERE id = $1', [t6]);
    if (freed.rows[0].state !== 'COMPLETED') {
      ok(`the task did not complete (${freed.rows[0].state})`);
    } else {
      bad('a revoked identity completed its task');
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
  } finally {
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ LEASE AUTHORIZATION AT EVERY BOUNDARY ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  authorization holds across the lease lifecycle (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
