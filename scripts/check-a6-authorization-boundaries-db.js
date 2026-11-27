#!/usr/bin/env node
// ── A.6: THE CLASSIFICATION AT EVERY AUTHORIZATION BOUNDARY ─────────────────
//
// Owner, 2026-11-27: *"Complete objective classification, trusted synthetic data provenance,
// mixed-data protection, initiation, planning, delegation, enqueue, retry and recovery
// authorization. Verify concurrency protection between authorization validation, lineage
// resolution, retry creation, result persistence and downstream effects."*
//
// ── WHAT A.6 TURNED OUT TO BE, MEASURED BEFORE BUILDING ────────────────────
//
// Migration 62 added the synthetic/real classification: `companies.is_synthetic` and
// `worker_identities.synthetic_only`, failing closed in opposite directions. A grep for who
// consults them answered the question A.6 was really asking:
//
//     src/lib/worker/leases.js              10
//     src/lib/worker/identity.js             ·
//     src/lib/worker/grant-immutability.js   ·
//     src/lib/office/initiator.js            0
//     src/lib/office/decomposition.js        0
//     src/lib/office/delegation.js           0
//
// The classification lived entirely in the worker layer. The office layer — initiation, planning,
// delegation — had never heard of it, and `enqueueTask` took `companyId` from its caller and
// validated NOTHING about it: not existence, not status. `worker_tasks.company_id` is `TEXT` with
// no foreign key, so the database did not either.
//
// **That column is the isolation boundary.** It is what the claim filter selects on and what
// `companyStillAuthorizes` re-reads at every lease boundary. The entire isolation argument rests on
// it, and it was the one value taken on trust from whoever called.
//
// The sharpest consequence is for an UNRESTRICTED worker. The claim filter reads
// `$4::boolean IS NOT TRUE OR company_id IN (SELECT id FROM companies WHERE is_synthetic)`, so a
// worker that is not synthetic-only skips the subquery entirely — a task naming a company that does
// not exist was claimable by it, with the refusal arriving later from a heartbeat. Exactly the shape
// the owner ruled on for the suspended-company retry: a row that can never legitimately complete.
//
// So this check measures the boundary at the sink where each row is created, and §6 measures the
// concurrency the owner named. No consequential operation runs: the task types are `synthetic.*`,
// nothing executes, and no provider is called.

'use strict';

process.env.ADMIN_EMAIL = 'a6-bootstrap@a6.invalid';
process.env.ADMIN_PASSWORD = `a-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.JWT_SECRET = `a6-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail += 1;
  lines.push(`  FAIL  ${m}`);
  if (extra !== undefined) lines.push(`          ${String(extra).slice(0, 300)}`);
};
const note = (m) => lines.push(`  --    ${m}`);
const step = (t) => lines.push('', `── ${t} ──`, '');

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'a6-authorization-boundaries' });
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
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/synthetic-isolation').installSyntheticIsolation(query);
    await require('../src/lib/worker/grant-immutability').installGrantImmutability(query)
      .catch(() => {});

    const LEASES = require('../src/lib/worker/leases');
    const SYN = require('../src/lib/worker/synthetic-isolation');
    const CTX = require('../src/lib/office/context');
    const SCOPE = require('../src/lib/office/scope');
    const DELEG = require('../src/lib/office/delegation');
    const { fixtureAdmin } = require('./lib/fixture-admin');

    const SYNTH = `a6-synth-${crypto.randomUUID().slice(0, 8)}`;
    const REAL = `a6-real-${crypto.randomUUID().slice(0, 8)}`;
    const GONE = `a6-never-existed-${crypto.randomUUID().slice(0, 8)}`;
    for (const [id, name] of [[SYNTH, 'A6 synthetic co'], [REAL, 'A6 real co']]) {
      await query(
        `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$2,'active')`,
        [id, name]);
    }
    await SYN.setCompanySynthetic(SYNTH, true, { query });
    const admin = await fixtureAdmin(query);

    // ══ 1. OBJECTIVE CLASSIFICATION IS AUTHORITATIVE, NOT DECLARED ═════════
    step('1. the classification is READ from stored state and cannot be asserted by a caller');

    const cls = await query(
      'SELECT id, is_synthetic FROM companies WHERE id = ANY($1) ORDER BY id', [[SYNTH, REAL]]);
    const synthRow = cls.rows.find((r) => r.id === SYNTH);
    const realRow = cls.rows.find((r) => r.id === REAL);
    if (synthRow.is_synthetic === true && realRow.is_synthetic === false) {
      ok('one company is synthetic and one is real — and REAL is the default, so a company nobody '
        + 'classified is treated as real rather than exposed');
    } else {
      bad('the fixture classification is wrong', JSON.stringify(cls.rows));
    }
    for (const bogus of ['true', 1, 'yes', null, undefined, {}]) {
      const r = await SYN.setCompanySynthetic(REAL, bogus, { query })
        .then((x) => x).catch((e) => ({ refused: e.message }));
      if (r && (r.refused || r.ok === false)) continue;
      bad(`setCompanySynthetic accepted ${JSON.stringify(bogus)} — a truthy string is not a `
        + 'classification');
    }
    ok('setCompanySynthetic refuses every non-boolean — a truthy string cannot classify a company');
    const unchanged = await query(
      'SELECT is_synthetic FROM companies WHERE id = $1', [REAL]);
    if (unchanged.rows[0].is_synthetic === false) {
      ok('and the real company is still real after six refused attempts');
    } else {
      bad('a refused classification attempt changed the row', unchanged.rows[0]);
    }

    // ══ 2. ENQUEUE: THE ISOLATION BOUNDARY IS VERIFIED AT THE SINK ═════════
    step('2. enqueue — the company on a task is checked where the row is created');

    // NOTE THE FIELD NAME. `leases.js`'s refuse() returns `{ok:false, code, detail}`, while
    // `delegation.js`'s returns `{ok:false, refused: code}`. Two refusal vocabularies in one
    // codebase, and asserting the wrong one reads every correct refusal as a permission — which is
    // how the first run of this section reported three product defects that were my own assertions.
    const enq = (companyId, taskType = 'synthetic.echo') => LEASES.enqueueTask({
      taskType, payload: {}, companyId,
      intentKey: `a6-${crypto.randomUUID()}`, workflow: 'a6-workflow', createdBy: 'a6-fixture',
    }, { query });

    const good = await enq(SYNTH);
    if (good.ok === true) {
      ok('a task for an existing active company is enqueued');
    } else {
      bad('the positive control failed, so nothing below measures anything', JSON.stringify(good));
    }
    const ghost = await enq(GONE);
    if (ghost.ok === false && ghost.code === 'unknown_company') {
      ok('a task naming a company that DOES NOT EXIST is refused — this was previously accepted, '
        + 'and an unrestricted worker would have claimed it because its claim filter skips the '
        + 'company subquery entirely');
    } else {
      bad('a task for a nonexistent company was enqueued', JSON.stringify(ghost).slice(0, 220));
    }
    await query('UPDATE companies SET status = $2 WHERE id = $1', [REAL, 'suspended']);
    const susp = await enq(REAL);
    if (susp.ok === false && susp.code === 'company_not_active') {
      ok('and a task for a SUSPENDED company is refused — enqueuing it would create work no '
        + 'worker may legitimately complete');
    } else {
      bad('a task for a suspended company was enqueued', JSON.stringify(susp).slice(0, 220));
    }
    await query('UPDATE companies SET status = $2 WHERE id = $1', [REAL, 'active']);
    const nullCo = await enq(null);
    if (nullCo.ok === true) {
      ok('a task with NO company is still permitted — it concerns nobody\'s data, and the claim '
        + 'filter excludes it from every restricted worker because NULL IN (…) is never true');
    } else {
      bad('a null-company task was refused, which would break every unattributed task',
        JSON.stringify(nullCo).slice(0, 220));
    }
    const unverifiable = await LEASES.enqueueTask({
      taskType: 'synthetic.echo', payload: {}, companyId: SYNTH,
      intentKey: `a6-${crypto.randomUUID()}`, workflow: 'a6', createdBy: 'a6',
    }, { query: async () => { throw new Error('connection terminated unexpectedly'); } });
    if (unverifiable.ok === false && unverifiable.code === 'company_unverifiable') {
      ok('an UNVERIFIABLE company is refused too — an outage is not a verified boundary');
    } else {
      bad('an unverifiable company was enqueued', JSON.stringify(unverifiable).slice(0, 220));
    }

    // ══ 3. THE DATABASE DOES NOT BACK THIS, AND THAT IS WORTH STATING ══════
    step('3. what the schema guarantees, measured rather than assumed');

    const fk = await query(
      `SELECT COUNT(*)::int n FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'worker_tasks' AND tc.constraint_type = 'FOREIGN KEY'
          AND k.column_name = 'company_id'`);
    if (fk.rows[0].n === 0) {
      note('worker_tasks.company_id has NO foreign key to companies. The check in §2 is therefore '
        + 'the ONLY thing standing between a caller and an unresolvable isolation boundary — a '
        + 'direct INSERT still bypasses it. An FK would make it structural; adding one needs the '
        + 'orphan population measured first, which §3b does, and a migration the owner has not '
        + 'authorized.');
      ok('the absence is RECORDED rather than left for the next reader to assume otherwise');
    } else {
      ok(`worker_tasks.company_id now has a foreign key (${fk.rows[0].n}) — stronger than §2's `
        + 'application check, and §2 becomes the early, legible refusal');
    }
    const orphans = await query(
      `SELECT COUNT(*)::int n FROM worker_tasks t
        WHERE t.company_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = t.company_id)`);
    if (orphans.rows[0].n === 0) {
      ok(`§3b: ZERO orphaned company references in worker_tasks — so an FK could be added without `
        + 'a backfill, which is the fact an operator needs before proposing one');
    } else {
      note(`§3b: ${orphans.rows[0].n} orphaned company reference(s) exist — an FK would be refused `
        + 'until they are resolved. Reported, not resolved: deleting rows to satisfy a constraint '
        + 'is the destructive cleanup this repo forbids.');
    }

    // ══ 4. INITIATION, PLANNING AND DELEGATION NEED A MINTED CONTEXT ═══════
    step('4. the office boundaries take a context they cannot be handed');

    const OBJ = `a6-obj-${crypto.randomUUID().slice(0, 8)}`;
    await SCOPE.createObjective({
      id: OBJ, companyId: SYNTH, objective: 'A6 boundary fixture', priority: 'P2',
      kpiMetric: 'a6', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 1,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: admin,
    }, { query });
    // Activated through the accessor, not by raw SQL — check-office-scope-discipline.js refused
    // the UPDATE, and it is right that a check has no claim on being special. Objectives are born
    // draft and activation needs a context, so: a run on the objective, a COMPANY context resolved
    // from that run, and setObjectiveStatus. Which is also the real sequence.
    const actLedger = require('../src/lib/run-ledger').ledger({ query });
    const actRun = await actLedger.createRun({
      trigger: 'check', triggerDetail: 'a6 activation', workflow: 'a6-workflow', agent: 'a6',
      product: 'playbookos', companyId: SYNTH, objectiveId: OBJ,
      intentKey: `a6-act-${crypto.randomUUID().slice(0, 8)}`,
    });
    const actCtx = await CTX.resolveCompanyContext({ runId: actRun.runId }, { query });
    await SCOPE.setObjectiveStatus(actCtx, { id: OBJ, status: 'active' }, { query });
    const realCtx = await CTX.resolveObjectiveContext({ objectiveId: OBJ }, { query });
    if (CTX.isTrustedContext(realCtx) && realCtx.companyId === SYNTH) {
      ok('a resolved objective context is trusted and carries the company READ from the objective');
    } else {
      bad('the context did not resolve', realCtx && { companyId: realCtx.companyId });
    }
    // A HAND-BUILT context with the right shape, and a COPY of a real one. Both refused.
    const forged = Object.freeze({ companyId: REAL, objectiveId: OBJ, autonomyTier: 'bounded',
      approvalPolicy: 'none', budgetUsd: 999 });
    const copied = Object.freeze({ ...realCtx, companyId: REAL });
    for (const [what, ctx] of [['a hand-built object', forged], ['a COPY with the company changed', copied]]) {
      const refused = await SCOPE.listObjectives(ctx, { query })
        .then(() => null).catch((e) => e);
      if (refused && /not produced by|was not produced|context/i.test(refused.message || '')) {
        ok(`${what} is refused by the accessor — shape is not authority, and a spread is a new object`);
      } else {
        bad(`${what} was accepted as a context`, refused && refused.message);
      }
    }
    const delegated = await DELEG.delegate(forged, {
      toAgent: 'procurement-agent', callingAgent: 'a6-fixture',
      reason: 'attempting delegation from a forged context',
    }, { query }).then((r) => r).catch((e) => ({ threw: e.message }));
    if (delegated && (delegated.ok === false || delegated.threw)) {
      ok('and delegation refuses a forged context too — so initiation, planning and delegation all '
        + 'rest on a context that must be READ from stored state');
    } else {
      bad('delegation accepted a forged context', JSON.stringify(delegated).slice(0, 220));
    }

    // ══ 5. MIXED DATA: DELEGATION CANNOT CROSS THE CLASSIFICATION ══════════
    step('5. mixed-data protection — a delegation has no company argument to cross with');

    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'lib', 'office', 'delegation.js'), 'utf8');
    const sig = src.slice(src.indexOf('async function delegate('),
      src.indexOf('async function delegate(') + 240);
    if (!/companyId/.test(sig)) {
      ok('delegate() takes NO companyId — the child\'s company is derived from the parent context, '
        + 'so there is no argument with which to cross a classification boundary');
    } else {
      bad('delegate() accepts a companyId, so a caller can choose the child\'s company', sig);
    }
    const dbGuard = await query(
      `SELECT COUNT(*)::int n FROM information_schema.table_constraints
        WHERE table_name = 'office_delegations'
          AND constraint_name = 'office_delegations_parent_same_company'`);
    if (dbGuard.rows[0].n === 1) {
      ok('and the DATABASE ties a delegation\'s company to its parent run under MATCH FULL — the '
        + 'single-company chain is a constraint, not a convention');
    } else {
      bad('office_delegations_parent_same_company is absent, so the chain is unenforced');
    }

    // ══ 6. CONCURRENCY: WITHDRAWAL RACING RESULT PERSISTENCE ═══════════════
    step('6. authorization withdrawal racing result persistence and its downstream effect');

    const IDENT = require('../src/lib/worker/identity');
    const tok = await IDENT.createEnrollmentToken({
      label: 'a6-worker', capabilities: ['exec:hardware'], syntheticOnly: false, createdBy: admin,
    }, { query });
    const en = await IDENT.consumeEnrollmentToken(
      { token: tok.token, hostFingerprint: 'a6' }, { query });
    const W = en.workerId;

    const raced = await LEASES.enqueueTask({
      taskType: 'synthetic.echo', payload: {}, companyId: SYNTH,
      intentKey: `a6-race-${crypto.randomUUID()}`, workflow: 'a6', createdBy: 'a6',
    }, { query });
    const claim = await LEASES.claimTask({ workerId: W, taskId: raced.taskId }, { query });
    if (claim.ok === true) {
      ok('a task is leased, so there is a live lease for the withdrawal to race');
    } else {
      bad('the lease could not be established', JSON.stringify(claim).slice(0, 200));
    }
    // Withdraw while the lease is held, then submit. The result must NOT be persisted as an outcome.
    await query('UPDATE companies SET status = $2 WHERE id = $1', [SYNTH, 'suspended']);
    const submitted = await LEASES.submitResult({
      workerId: W, runId: claim.runId, taskId: raced.taskId, status: 'SUCCEEDED',
      output: { did: 'work that must not be ingested' },
    }, { query });
    if (submitted && submitted.ok !== true) {
      ok(`a result submitted after withdrawal is refused (${submitted.code || submitted.reason})`);
    } else {
      bad('a result was accepted after authorization was withdrawn',
        JSON.stringify(submitted).slice(0, 220));
    }
    const stored = await query(
      'SELECT COUNT(*)::int n FROM worker_results WHERE task_id = $1', [raced.taskId]);
    if (stored.rows[0].n === 0) {
      ok('and NO result row was persisted — the output is not stored, which is the downstream '
        + 'effect that matters: an ingested result would move a KPI');
    } else {
      bad(`${stored.rows[0].n} result row(s) were persisted despite the refusal`);
    }
    const taskAfter = await query(
      'SELECT state, resolution_note FROM worker_tasks WHERE id = $1', [raced.taskId]);
    if (taskAfter.rows[0].state === 'NEEDS_RESOLUTION') {
      ok('and the task is NEEDS_RESOLUTION, not FAILED — the work may well have happened, and the '
        + 'truthful state is that nobody knows');
    } else {
      note(`the task is ${taskAfter.rows[0].state}; what matters is that the output was not stored`);
    }
    await query('UPDATE companies SET status = $2 WHERE id = $1', [SYNTH, 'active']);

    // ══ 7. AND THE RETRY OF THAT WORK IS STILL GATED ═══════════════════════
    step('7. the retry of an unknown-outcome task remains refused');

    const RECOVERY = require('../src/lib/office/recovery');
    const retried = await RECOVERY.retryRun(
      claim.runId, { overrideReason: 'a recorded judgement about the raced submission' },
      { query });
    if (retried.retried === false) {
      ok(`and a retry of the raced run is refused (${retried.reason}) — the chain holds from `
        + 'enqueue through claim, withdrawal, submission and retry');
    } else {
      bad('the raced work was retried', JSON.stringify(retried).slice(0, 220));
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 6).join('\n'));
  } finally {
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ A.6: THE CLASSIFICATION AT EVERY AUTHORIZATION BOUNDARY ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
