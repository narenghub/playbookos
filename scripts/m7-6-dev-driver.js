#!/usr/bin/env node
// ── M7.6 HARDWARE ACCEPTANCE DRIVER ─────────────────────────────────────────
//
//   M7_6_DEV_CONFIRM=yes node scripts/m7-6-dev-driver.js --worker wkr_<32 hex>
//   echo $?      # 0 = accepted · 1 = a scenario failed · 3 = incomplete, nothing claimed
//
// F1–F7 functional · S1–S9 security and policy · R1–R6 recovery and governance.
//
// ── WHAT FOUR M7.5 ACCEPTANCE RUNS TAUGHT, APPLIED HERE FROM THE START ─────
//
//   1. A measurement is not the property. "No result row exists" is satisfied both by a worker
//      that aborted and by one that finished and was refused. Where the property IS worker
//      behaviour, the evidence is `worker_audit` — written only by the HTTP route layer, so this
//      driver's own in-process calls cannot appear in it.
//   2. Three verdicts, not two. UNTESTED means the evidence could not discriminate. It is not a
//      softer FAIL and it is never silent: every one prints its reason and fails the gate.
//   3. A wait must be able to satisfy its own condition. Scenario 7 of M7.5 waited 240s for a
//      5-minute ceiling and could never pass. Every budget here is derived, not guessed.
//   4. Diagnostics BEFORE cleanup. A failed scenario's rows are the only thing that explains it.
//   5. Per-run intent keys. The planner namespaces every key under a random plan id, so one run
//      can never inherit another's attempt history.
//   6. Never delete audit evidence. `agent_run_events` is append-only by trigger and `agent_runs`
//      that emitted events cannot be deleted. Cleanup reports them as retained, not as leaks.
//
// ── WHAT THIS DRIVER DOES NOT DO ───────────────────────────────────────────
//
//   • no `overrideReason`, ever. R2 asserts the database's retry guard by being refused by it.
//   • no STOP outside its own fixture scope, and the 42 containment STOPs are compared before and
//     after by exact identity.
//   • no outbound anything. The pilot has no mailer, no WhatsApp, no fetch in its require graph.
//   • it does NOT revoke the operational identity. S6 revokes a FIXTURE identity it creates, which
//     is the correction M7.5 scenario 8 still needs — three operational identities were burned
//     that way.
//   • R1 (crash recovery) requires the crash test to be ARMED for this exact worker. Unarmed, it
//     reports UNTESTED with the arming command, loudly.

'use strict';

const crypto = require('crypto');

// ── REFUSALS, BEFORE ANYTHING IS REQUIRED THAT TOUCHES A DATABASE ──────────

const PRODUCTION_HOSTS = ['postgres.railway.internal', 'interchange.proxy.rlwy.net'];

function refuseIfProduction() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('REFUSED: DATABASE_URL is not set. Point it at the DEVELOPMENT database.');
    process.exit(2);
  }
  let host = '';
  let name = '';
  try {
    const u = new URL(raw);
    host = u.hostname;
    name = u.pathname.replace(/^\//, '');
  } catch (_) {
    console.error('REFUSED: DATABASE_URL is not a URL this script can inspect.');
    process.exit(2);
  }
  for (const bad of PRODUCTION_HOSTS) {
    if (host === bad || host.endsWith(`.${bad}`)) {
      console.error(`REFUSED: ${host} is a production host. This script cancels tasks, sets a STOP,`);
      console.error('creates and revokes an identity, and ages runs. None of that near production.');
      process.exit(2);
    }
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('REFUSED: NODE_ENV=production. Unset it or run this on the development server.');
    process.exit(2);
  }
  if (process.env.M7_6_DEV_CONFIRM !== 'yes') {
    console.error('REFUSED: set M7_6_DEV_CONFIRM=yes to confirm this is the development database.');
    console.error(`         host=${host} database=${name || '(unnamed)'}`);
    process.exit(2);
  }
  return { host, name };
}

const TARGET = refuseIfProduction();

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const query = (sql, params) => pool.query(sql, params);
const one = async (sql, params) => (await query(sql, params)).rows[0] || null;
const deps = { query };

const LEASES = require('../src/lib/worker/leases');
const IDENTITY = require('../src/lib/worker/identity');
const AUTH = require('../src/lib/worker/auth');
const TYPES = require('../src/lib/worker/task-types');
const PLANNER = require('../src/lib/m76/planner');
const POLICY = require('../src/lib/m76/policy');
const PIPELINE = require('../src/lib/m76/pipeline');
const SYNTHETIC = require('../src/lib/m76/synthetic');
const BEHAVIOUR = require('./lib/m75-worker-behaviour');

// ── VERDICTS ────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
let untestedCount = 0;
const results = [];

const head = (m) => console.log(`\n  ── ${m} ──\n`);
const note = (m) => console.log(`  --    ${m}`);
const ok = (id, m) => { pass += 1; results.push({ id, verdict: 'PASS', m }); console.log(`  ok    ${id}: ${m}`); };
const bad = (id, m, d) => {
  fail += 1; results.push({ id, verdict: 'FAIL', m });
  console.log(`  FAIL  ${id}: ${m}`);
  if (d) String(d).split('\n').forEach((l) => console.log(`          ${l.slice(0, 220)}`));
};
const untested = (id, m, why) => {
  untestedCount += 1; results.push({ id, verdict: 'UNTESTED', m });
  console.log(`  UNTESTED  ${id}: ${m}`);
  String(why).split('\n').forEach((l) => console.log(`          ${l.slice(0, 220)}`));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Budgets derived from the system's own numbers, never guessed. */
// S6's throwaway identity. Deliberately NOT prefixed `m76-`: a guard that scans this file for
// intent keys once read the label `m76-fixture-revocation` as one, and a label is not an intent key.
const FIXTURE_IDENTITY_LABEL = 'fixture-revocation';

// ── S6'S SIGNED HTTP PROBE ──────────────────────────────────────────────────
//
// Reaches the development worker API this driver runs beside, in the same container. 127.0.0.1 is
// deliberate: the probe must hit THIS deployment's authentication layer, not whatever a public
// hostname currently resolves to.
//
// /api/worker/heartbeat with the nil run id is the minimal authenticated call — it authenticates,
// finds no live lease, and answers 409 lease_not_live. That makes a successful authentication
// distinguishable from a refused one by the CODE rather than by the status alone, which matters
// because 'revoked' and 'lease_not_live' are both refusals of the request and only one of them is
// a refusal of the identity.
const S6_PROBE_PATH = '/api/worker/heartbeat';
const S6_NIL_RUN_ID = '00000000-0000-0000-0000-000000000000';
/** Codes that mean the IDENTITY was rejected, as opposed to the request being unsatisfiable. */
const AUTH_REJECTION_CODES = Object.freeze([
  'unsigned', 'malformed_worker_id', 'malformed_nonce', 'stale_signature',
  'unknown_worker', 'revoked', 'bad_signature', 'replayed_nonce',
  'unsupported_scheme', 'identity_unavailable',
]);

/**
 * One signed request as a real worker would send it. `secret` is used here and is never returned,
 * logged or stored — the caller gets only the status, the code and whether authentication passed.
 */
async function signedAuthProbe(workerId, secret) {
  const body = JSON.stringify({ runId: S6_NIL_RUN_ID });
  const headers = AUTH.signRequest(secret, {
    workerId,
    method: 'POST',
    path: S6_PROBE_PATH,
    timestamp: Date.now(),
    // 32 lowercase hex, which SCHEMA.NONCE_SHAPE requires and a UUID would fail. A fresh one per
    // probe, because the nonce is committed on every attempt whatever the outcome — the same
    // signed request twice would be refused as a replay, which would read as a revocation.
    nonce: require('node:crypto').randomBytes(16).toString('hex'),
    body,
  });
  const port = Number(process.env.PORT) || 3100;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${S6_PROBE_PATH}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });
    let payload = null;
    try { payload = await res.json(); } catch (_) { payload = null; }
    const code = payload && payload.code ? String(payload.code) : null;
    return {
      reachable: true,
      status: res.status,
      code,
      // Authenticated means the identity was accepted. A 409 lease_not_live is the expected answer
      // for a valid identity with no live lease, and is therefore a PASS of the auth layer.
      authenticated: !AUTH_REJECTION_CODES.includes(code),
      error: null,
    };
  } catch (e) {
    return { reachable: false, status: null, code: null, authenticated: false, error: String(e.message).slice(0, 120) };
  }
}

const HEARTBEAT_MS = 50_000;          // max(15s, ceiling/6) for a 5-minute ceiling
const REPORT_GRACE_MS = 15_000;
const signalBudget = () => HEARTBEAT_MS + REPORT_GRACE_MS + 10_000;
const claimBudget = () => 60_000;

async function until(label, fn, { timeoutMs = claimBudget(), everyMs = 500 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { ok: true, value: v, ms: Date.now() - started, label };
    if (Date.now() - started > timeoutMs) return { ok: false, ms: Date.now() - started, label };
    await sleep(everyMs);
  }
}

// ── FIXTURES THIS RUN CREATED ───────────────────────────────────────────────

const made = {
  goalIds: [], planIds: [], intentKeys: [], taskIds: [], stops: [], identities: [],
};

async function setStop(scopeType, scopeKey, reason) {
  const handle = { scopeType, scopeKey };
  made.stops.push(handle);          // recorded BEFORE the insert, so a throw cannot orphan it
  await query(
    `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
     VALUES ($1,$2,$3,'m7-6-dev-driver') ON CONFLICT (scope_type, scope_key) DO NOTHING`,
    [scopeType, scopeKey, reason]);
  return handle;
}
async function clearStop(h) {
  await query(`DELETE FROM autonomy_stops WHERE scope_type=$1 AND scope_key=$2`,
    [h.scopeType, h.scopeKey]);
  made.stops = made.stops.filter((s) => s !== h);
}
const stopInventory = async () => (await query(`SELECT scope_type, scope_key FROM autonomy_stops`))
  .rows.map((r) => `${r.scope_type}:${r.scope_key}`).sort();

/** worker_audit is written only by the HTTP routes, so it is evidence about the WORKER. */
async function workerEndpointCalls(runId, kind, workerId) {
  const r = await one(
    `SELECT COUNT(*)::int n FROM worker_audit
      WHERE run_id = $1 AND worker_id = $2 AND endpoint LIKE $3`,
    [runId, workerId, `%worker/${kind}`]);
  return Number(r.n);
}
async function workerClaimAt(taskId, workerId) {
  const r = await one(
    `SELECT at FROM worker_audit WHERE task_id = $1 AND worker_id = $2
       AND outcome = 'GRANTED' AND endpoint LIKE $3 ORDER BY at ASC LIMIT 1`,
    [taskId, workerId, '%worker/claim']);
  return r && r.at ? new Date(r.at).getTime() : null;
}
async function deniedClaims(since, workerId, code = 'stopped') {
  const r = await one(
    `SELECT COUNT(*)::int n FROM worker_audit
      WHERE worker_id = $1 AND outcome = 'DENIED' AND code = $2
        AND endpoint LIKE $3 AND at >= $4`,
    [workerId, code, '%worker/claim', since]);
  return Number(r.n);
}
async function workerLastSeen(workerId) {
  const r = await one(`SELECT last_seen_at FROM worker_identities WHERE id = $1`, [workerId]);
  return r && r.last_seen_at ? new Date(r.last_seen_at).getTime() : null;
}
async function workerIsPolling(workerId) {
  const before = await workerLastSeen(workerId);
  await sleep(8_000);
  const after = await workerLastSeen(workerId);
  return { polling: before !== null && after !== null && after > before, before, after };
}

/**
 * BOUNDED DIAGNOSTICS, printed before any cleanup. A scenario that failed is explained by the rows
 * it left; reconstructing them afterwards was shown to be unreliable across the M7.5 runs.
 */
async function diagnose(intentKey) {
  const t = await one(
    `SELECT id, state, task_type, cancel_requested_at FROM worker_tasks WHERE intent_key = $1`,
    [intentKey]);
  const r = await one(
    `SELECT run_id, state, attempt, started_at, heartbeat_at, ended_at FROM agent_runs
      WHERE intent_key = $1 ORDER BY started_at DESC LIMIT 1`, [intentKey]);
  const res = t ? await one(
    `SELECT status, output FROM worker_results WHERE task_id = $1`, [t.id]) : null;
  console.log(`          DIAGNOSTIC ${intentKey}`);
  console.log(`            task   ${t ? `${t.id} ${t.state} (${t.task_type})` : 'none'}`);
  console.log(`            run    ${r ? `${r.run_id} ${r.state} attempt=${r.attempt}` : 'none'}`);
  console.log(`            result ${res ? `${res.status} ${JSON.stringify(res.output).slice(0, 120)}` : 'none'}`);
  if (t && r) {
    const a = await one(
      `SELECT endpoint, outcome, code, COUNT(*)::int n FROM worker_audit
        WHERE run_id = $1 GROUP BY 1,2,3 ORDER BY n DESC LIMIT 5`, [r.run_id]);
    if (a) console.log(`            audit  ${a.endpoint} ${a.outcome} ${a.code || ''} x${a.n}`);
  }
}

/** Drive an abandoned lease to its documented disposition, ageing past its DECLARED ceiling. */
async function resolveAbandonedLease(intentKey, taskId) {
  const run = await one(
    `SELECT run_id, max_runtime_minutes FROM agent_runs
      WHERE intent_key = $1 ORDER BY started_at DESC LIMIT 1`, [intentKey]);
  if (!run) return { task: null, run: null, ceiling: null };
  const ceiling = run.max_runtime_minutes != null ? Number(run.max_runtime_minutes) : 15;
  await query(
    `UPDATE agent_runs SET started_at = NOW() - ($2::int * INTERVAL '1 minute'),
                           heartbeat_at = NOW() - ($2::int * INTERVAL '1 minute')
      WHERE run_id = $1`, [run.run_id, ceiling + 10]);
  await require('../src/lib/office/recovery').reap({ dryRun: false, limit: 50 }, deps);
  await LEASES.reflectAbandonedLeases({}, deps);
  const t = await one(`SELECT state FROM worker_tasks WHERE id = $1`, [taskId]);
  const r2 = await one(
    `SELECT state FROM agent_runs WHERE intent_key = $1 ORDER BY started_at DESC LIMIT 1`,
    [intentKey]);
  return { task: t && t.state, run: r2 && r2.state, ceiling };
}

// ── PLANNING HELPERS ────────────────────────────────────────────────────────

const GOAL_TEXT = "Produce today's ABIOZEN scientific operations report";
const AS_OF = new Date().toISOString().slice(0, 10);
const FACT_COUNT = 60;

async function newPlan({ seed = 'm76', factCount = FACT_COUNT, text = GOAL_TEXT } = {}) {
  const g = await PIPELINE.recordGoal({ text, requestedBy: 'm7-6-dev-driver' }, deps);
  made.goalIds.push(g.goalId);
  const r = PLANNER.plan({ goalId: g.goalId, text, asOf: AS_OF, seed, factCount });
  if (!r.ok) return { refused: r };
  made.planIds.push(r.plan.planId);
  for (const s of r.plan.steps) made.intentKeys.push(s.intentKey);
  return { plan: r.plan, goalId: g.goalId };
}

async function persistAndDispatch(plan, workerId) {
  await PIPELINE.recordPlan(plan, { state: 'VALIDATED' }, deps);
  const v = await POLICY.validatePlan(plan, { workerId }, deps);
  if (!v.ok) return { refused: v };
  const d = await PIPELINE.dispatchPlan(plan, { workerId, validated: true }, deps);
  for (const x of d.dispatched) made.taskIds.push(x.taskId);
  return { dispatched: d };
}

// ── THE RUN ─────────────────────────────────────────────────────────────────

async function main() {
  const workerId = (() => {
    const i = process.argv.indexOf('--worker');
    return i === -1 ? null : process.argv[i + 1];
  })();
  if (!/^wkr_[0-9a-f]{32}$/.test(String(workerId))) {
    console.error('usage: --worker wkr_<32 hex>   (the LIVE identity the iMac is installed with)');
    process.exit(2);
  }

  console.log(`\n══ M7.6 ACCEPTANCE — dev database ${TARGET.host}/${TARGET.name} ══`);
  console.log(`   driving worker ${workerId}, which must be RUNNING on the office iMac now.`);
  console.log(`   as-of ${AS_OF}, ${FACT_COUNT} synthetic facts\n`);

  // Preconditions, stated rather than assumed.
  const w = await IDENTITY.findWorker(workerId, deps);
  if (!w) { console.log('  REFUSED: that worker id is not enrolled.\n'); return 3; }
  if (w.revoked_at) { console.log('  REFUSED: that identity is already revoked.\n'); return 3; }
  ok('P1', `the identity is LIVE (${w.label || 'unlabelled'})`);

  const tables = await one(
    `SELECT COUNT(*)::int n FROM information_schema.tables
      WHERE table_schema='public' AND table_name = ANY($1)`, [PIPELINE.SCHEMA.TABLES]);
  if (Number(tables.n) !== PIPELINE.SCHEMA.TABLES.length) {
    console.log(`  REFUSED: ${tables.n}/${PIPELINE.SCHEMA.TABLES.length} pilot tables exist. `
      + 'Run scripts/m76-migrate-dev.js --apply first.\n');
    return 3;
  }
  ok('P2', `all ${tables.n} pilot tables exist`);

  const stopsAtStart = await stopInventory();
  note(`${stopsAtStart.length} autonomy STOP(s) present before this run`);

  const live = await workerIsPolling(workerId);
  if (!live.polling) {
    untested('P3', 'no worker was polling',
      `last_seen_at did not advance over 8s (${live.before ? new Date(live.before).toISOString() : 'never'}`
      + ` → ${live.after ? new Date(live.after).toISOString() : 'never'}). Every hardware scenario `
      + 'below would be unknown rather than passed, so the run stops here.');
    return 3;
  }
  ok('P4', 'the worker is polling — hardware scenarios can be judged');

  // ════════════════ F1–F2: GOAL → PLAN → DISPATCH ════════════════
  head('F1–F2. a goal becomes a bounded plan, and the plan is dispatched');
  const first = await newPlan();
  if (first.refused) { bad('F1', 'the planner refused a recognised goal', JSON.stringify(first.refused)); return 1; }
  const plan = first.plan;
  const shape = PLANNER.validateShape(plan);
  if (!shape.length && plan.steps.length === 2) {
    ok('F1', `plan ${plan.planId}: ${plan.steps.map((s) => s.stepType).join(' → ')}`);
  } else bad('F1', 'the plan does not validate', shape.join('; '));

  const disp = await persistAndDispatch(plan, workerId);
  if (disp.refused) { bad('F2', 'policy refused a valid plan', JSON.stringify(disp.refused.refusals)); return 1; }
  const tasksFor = await query(
    `SELECT intent_key, task_type FROM worker_tasks WHERE intent_key = ANY($1) ORDER BY intent_key`,
    [plan.steps.map((s) => s.intentKey)]);
  if (tasksFor.rows.length === 2) ok('F2', 'one task per step, under this plan\'s own intent keys');
  else bad('F2', `${tasksFor.rows.length} task(s) for 2 steps`);

  // ════════════════ F3–F5: EXECUTION, VALIDATION, REPORT ════════════════
  head('F3–F5. the iMac executes, the server validates, the report is assembled');
  const done = await until('both steps report', async () => {
    const r = await one(
      `SELECT COUNT(*)::int n FROM worker_results wr
         JOIN worker_tasks wt ON wt.id = wr.task_id
        WHERE wt.intent_key = ANY($1) AND wr.status = 'SUCCEEDED'`,
      [plan.steps.map((s) => s.intentKey)]);
    return Number(r.n) === 2 ? r : null;
  }, { timeoutMs: 180_000, everyMs: 2_000 });

  if (!done.ok) {
    for (const s of plan.steps) await diagnose(s.intentKey);
    bad('F3', 'the iMac did not complete both steps', `waited ${done.ms}ms`);
  } else {
    ok('F3', `both steps executed on the iMac and reported (${Math.round(done.ms / 1000)}s)`);

    const asm = await PIPELINE.assemble(plan, { expectedFactCount: FACT_COUNT }, deps);
    if (!asm.ok) {
      for (const s of plan.steps) await diagnose(s.intentKey);
      bad('F4', `the report was not assembled: ${asm.reason}`, (asm.detail || []).join('\n'));
    } else {
      ok('F4', 'the report body passed INDEPENDENT server-side validation');
      const ev = asm.evidence;
      const complete = ev.steps.every((s) => s.taskId && s.runId && s.workerId);
      if (complete && ev.auditRows > 0) {
        ok('F5', `report ${asm.reportId} — ${ev.steps.length} step(s), every one with task, run and `
          + `worker id, ${ev.auditRows} audit row(s)`);
        note(`totals: ${JSON.stringify(asm.body.totals)} over ${asm.body.factCount} facts`);
      } else {
        bad('F5', 'the report evidence is incomplete', JSON.stringify(ev.steps));
      }
    }
  }

  // ════════════════ F6: IDEMPOTENT RE-DISPATCH ════════════════
  head('F6. re-dispatching the same plan creates nothing new');
  const before6 = await one(
    `SELECT COUNT(*)::int n FROM worker_tasks WHERE intent_key = ANY($1)`,
    [plan.steps.map((s) => s.intentKey)]);
  const again = await PIPELINE.dispatchPlan(plan, { workerId, validated: true }, deps);
  const after6 = await one(
    `SELECT COUNT(*)::int n FROM worker_tasks WHERE intent_key = ANY($1)`,
    [plan.steps.map((s) => s.intentKey)]);
  // `reused` is asserted, not only the count. A count that does not move is satisfied both by
  // adoption and by a dispatch that quietly did nothing — and on 2026-11-23 this scenario's
  // earlier form could not distinguish either from a THROW, which propagated out of main and
  // ended the run at exit 3 before R1 ever ran.
  const allReused = again.dispatched.length === 2 && again.dispatched.every((d) => d.reused === true);
  if (Number(before6.n) === Number(after6.n) && allReused) {
    ok('F6', `still ${after6.n} task(s) after a second dispatch, both steps reported reused — `
      + 'uq_worker_tasks_intent refused the duplicates and dispatch adopted the existing tasks');
  } else if (Number(before6.n) !== Number(after6.n)) {
    bad('F6', `task count went ${before6.n} → ${after6.n} on re-dispatch`);
  } else {
    bad('F6', 'the task count held but re-dispatch did not report the steps as reused: '
      + JSON.stringify(again.dispatched.map((d) => ({ s: d.stepId, reused: d.reused }))));
  }

  // ════════════════ F7: DETERMINISTIC REPLAY ════════════════
  head('F7. the same inputs produce a byte-identical report');
  const replay = await newPlan({ seed: 'm76' });
  if (replay.refused) bad('F7', 'the replay plan was refused', JSON.stringify(replay.refused));
  else {
    const d2 = await persistAndDispatch(replay.plan, workerId);
    if (d2.refused) bad('F7', 'policy refused the replay plan', JSON.stringify(d2.refused.refusals));
    else {
      const rep = replay.plan.steps.find((s) => s.taskType === 'report.daily_operations');
      const got = await until('the replay report arrives', async () => {
        const r = await one(
          `SELECT wr.output FROM worker_results wr JOIN worker_tasks wt ON wt.id = wr.task_id
            WHERE wt.intent_key = $1 AND wr.status = 'SUCCEEDED'`, [rep.intentKey]);
        return r || null;
      }, { timeoutMs: 180_000, everyMs: 2_000 });
      const firstRep = plan.steps.find((s) => s.taskType === 'report.daily_operations');
      const original = await one(
        `SELECT wr.output FROM worker_results wr JOIN worker_tasks wt ON wt.id = wr.task_id
          WHERE wt.intent_key = $1`, [firstRep.intentKey]);
      if (!got.ok || !original) {
        if (!got.ok) await diagnose(rep.intentKey);
        untested('F7', 'the replay did not complete',
          'without two reports there is nothing to compare, so determinism is unknown here. '
          + 'It is separately asserted over the handler in its unit tests.');
      } else if (PLANNER.canonical(got.value.output) === PLANNER.canonical(original.output)) {
        ok('F7', 'the second run produced an identical report from identical inputs');
      } else {
        bad('F7', 'the same inputs produced a different report',
          `${PLANNER.canonical(got.value.output).slice(0, 160)}\nvs\n${PLANNER.canonical(original.output).slice(0, 160)}`);
      }
    }
  }

  // ════════════════ S1–S3: THE PLANNER AND POLICY REFUSE ════════════════
  head('S1–S3. a plan outside the vocabulary, a write-capable type, an outbound action');

  const unrecognised = PLANNER.plan({ goalId: 'none', text: 'email every supplier about pricing', asOf: AS_OF });
  if (!unrecognised.ok) ok('S1a', `an unrecognised goal produces no plan (${unrecognised.refused})`);
  else bad('S1a', 'the planner invented a plan for an unrecognised goal');

  const smuggled = JSON.parse(JSON.stringify(plan));
  smuggled.steps.push({
    stepId: 's9', ordinal: 9, stepType: 'operations.send_email', taskType: 'email.send',
    payload: {}, payloadDigest: PLANNER.digestOf({}), intentKey: `m76-${plan.planId}-s9`,
  });
  const vSmuggled = await POLICY.validatePlan(smuggled, { workerId }, deps);
  const refusedWhole = !vSmuggled.ok
    && vSmuggled.refusals.some((r) => /not in the closed vocabulary/.test(r));
  if (refusedWhole) ok('S1b', 'one unknown step refuses the WHOLE plan, not just the step');
  else bad('S1b', 'an unknown step type was not refused', JSON.stringify(vSmuggled.refusals));

  const writey = JSON.parse(JSON.stringify(plan));
  writey.steps[1].taskType = 'proposal.draft_once';
  const vWritey = await POLICY.validatePlan(writey, { workerId }, deps);
  if (!vWritey.ok) {
    ok('S2', `a write-capable task type is refused (readOnly=${TYPES.definitionOf('proposal.draft_once').readOnly})`);
  } else bad('S2', 'policy allowed a type that declares readOnly:false');

  // S3 is architectural: the capability is absent, not merely unused.
  const m76Dir = require('node:path').join(__dirname, '..', 'src', 'lib', 'm76');
  const forbidden = [];
  for (const f of require('node:fs').readdirSync(m76Dir).filter((x) => x.endsWith('.js') && !x.endsWith('.test.js'))) {
    const src = require('node:fs').readFileSync(require('node:path').join(m76Dir, f), 'utf8');
    for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (/mailer|whatsapp|\bllm\b|services\/sender|node-fetch|child_process|office\/execute/.test(m[1])) {
        forbidden.push(`${f} → ${m[1]}`);
      }
    }
  }
  if (!forbidden.length) ok('S3', 'no module under m76/ can reach an outbound primitive');
  else bad('S3', 'the pilot can reach an outbound primitive', forbidden.join('; '));

  // ════════════════ S4 / R5: A STOP, OBSERVED BY THE WORKER ════════════════
  head('S4 / R5. a STOP refuses dispatch, and halts work already running');
  const stopPlan = await newPlan({ seed: 'stopcase' });
  const stopStep = stopPlan.plan.steps.find((s) => s.taskType === 'synthetic.echo');
  // A long echo so the STOP can arrive mid-flight: 60s is the handler's cap and outlives one
  // 50s heartbeat, which is the only channel a STOP travels on.
  stopStep.payload = { hello: 'stop-case', delayMs: 60_000 };
  stopStep.payloadDigest = PLANNER.digestOf(stopStep.payload);
  stopPlan.plan.steps = [stopStep];
  const dStop = await persistAndDispatch(stopPlan.plan, workerId);
  if (dStop.refused) bad('S4', 'the STOP fixture plan was refused before the STOP existed',
    JSON.stringify(dStop.refused.refusals));
  else {
    const claimed = await until('the Mac claims it', async () =>
      await one(`SELECT id FROM worker_tasks WHERE intent_key=$1 AND state='LEASED'`, [stopStep.intentKey]));
    if (!claimed.ok) {
      await diagnose(stopStep.intentKey);
      untested('S4', 'the worker never claimed the STOP fixture', 'nothing about STOP was exercised');
    } else {
      // started_at is selected because R5's timing discriminator needs it — the projected
      // completion of the stopped task is the server's start time plus the handler's 60s delay.
      const run = await one(
        `SELECT run_id, started_at FROM agent_runs WHERE intent_key=$1 AND trigger_detail=$2
          ORDER BY started_at DESC LIMIT 1`, [stopStep.intentKey, workerId]);
      const sid = await setStop('capability', 'worker.execute', 'M7.6 acceptance STOP');
      const stopRow = await one(
        `SELECT set_at FROM autonomy_stops WHERE scope_type=$1 AND scope_key=$2`,
        ['capability', 'worker.execute']);
      const setAt = new Date(stopRow.set_at);

      // Dispatch must now be refused — the policy engine asks the same authority.
      const blocked = await newPlan({ seed: 'blocked' });
      const vBlocked = await POLICY.validatePlan(blocked.plan, { workerId }, deps);
      if (!vBlocked.ok && vBlocked.refusals.some((r) => /stopped at/.test(r))) {
        ok('S4a', 'while stopped, policy refuses to dispatch anything');
      } else bad('S4a', 'dispatch was permitted under a STOP', JSON.stringify(vBlocked.refusals));

      const observed = await until('a heartbeat lands after the STOP', async () => {
        const r = await one(
          `SELECT heartbeat_at FROM agent_runs WHERE intent_key=$1 AND trigger_detail=$2
            ORDER BY started_at DESC LIMIT 1`, [stopStep.intentKey, workerId]);
        return (r && r.heartbeat_at && new Date(r.heartbeat_at) > setAt) ? r : null;
      }, { timeoutMs: signalBudget() });
      const refusedClaims = await deniedClaims(setAt, workerId, 'stopped');
      const resultCalls = run ? await workerEndpointCalls(run.run_id, 'result', workerId) : 0;

      await clearStop(sid);
      const inv = await stopInventory();
      const unchanged = inv.join('|') === stopsAtStart.join('|');

      const probe = await newPlan({ seed: 'resume' });
      const probeStep = probe.plan.steps.find((s) => s.taskType === 'synthetic.echo');
      probe.plan.steps = [probeStep];
      await persistAndDispatch(probe.plan, workerId);
      const resumed = await until('the worker resumes', async () =>
        await one(`SELECT wr.status FROM worker_results wr JOIN worker_tasks wt ON wt.id=wr.task_id
                    WHERE wt.intent_key=$1`, [probeStep.intentKey]),
      { timeoutMs: signalBudget(), everyMs: 1_000 });

      // ── THE SAME DISCRIMINATOR R4 PROVES WORKS ────────────────────────────
      //
      // WHEN the worker took this probe matters, not only that it eventually did. The stopped task
      // was a 60s echo: if the worker picked up new work before that task could have finished on
      // its own, it ABANDONED it. If it picked up afterwards, the task may simply have run out and
      // this run cannot tell a halt from indifference — which is an UNTESTED, and the judge says so.
      //
      // `started_at` is read from the run row rather than timed in this process: the clock that
      // matters is the server's, and a driver-side Date.now() would be measuring the wrong machine.
      const probeTaskRow = await one(
        `SELECT id FROM worker_tasks WHERE intent_key = $1`, [probeStep.intentKey]);
      const resumeClaimedAt = probeTaskRow ? await workerClaimAt(probeTaskRow.id, workerId) : null;
      const projectedStopCompletion = run && run.started_at
        ? new Date(run.started_at).getTime() + 60_000
        : null;

      const v = BEHAVIOUR.judgeStop({
        stopInScope: true,
        inventoryUnchanged: unchanged,
        heartbeatAfterStopAt: observed.ok ? new Date(observed.value.heartbeat_at).getTime() : null,
        workerResultAttempts: resultCalls,
        deniedClaimAttempts: refusedClaims,
        probeStateWhileStopped: 'PENDING',
        resumedCompleted: Boolean(resumed.ok && resumed.value.status === 'SUCCEEDED'),
        resumeClaimedAt: resumeClaimedAt || null,
        projectedCompletionAt: projectedStopCompletion,
      });
      note(`evidence: heartbeat-after-stop=${observed.ok ? 'yes' : 'none'}, `
        + `claims refused as stopped=${refusedClaims}, result-endpoint calls=${resultCalls}, `
        + `resumed=${resumed.ok ? resumed.value.status : 'no'}, took new work at=`
        + `${resumeClaimedAt ? new Date(resumeClaimedAt).toISOString() : 'never'}, `
        + `stopped task would have finished=`
        + `${projectedStopCompletion ? new Date(projectedStopCompletion).toISOString() : 'unknown'}`);
      note(`correlate on the iMac: run ${run && run.run_id} task ${claimed.value.id}`);
      if (v.verdict === BEHAVIOUR.PASS) ok('R5', `the STOP is honoured by the worker — ${v.why}`);
      else if (v.verdict === BEHAVIOUR.UNTESTED) { await diagnose(stopStep.intentKey); untested('R5', 'mid-flight STOP', v.why); }
      else { await diagnose(stopStep.intentKey); bad('R5', 'mid-flight STOP', v.why); }

      if (unchanged) ok('S4b', `the containment inventory is unchanged: ${inv.length} STOP(s)`);
      else bad('S4b', 'the fixture STOP changed the containment inventory');

      const settled = await resolveAbandonedLease(stopStep.intentKey, claimed.value.id);
      if (settled.task === 'NEEDS_RESOLUTION') {
        ok('R5b', `the halted lease resolves to NEEDS_RESOLUTION (ceiling ${settled.ceiling}min)`);
      } else bad('R5b', `the halted lease ended as ${settled.task}`);
    }
  }

  // ════════════════ R4: CANCELLATION, OBSERVED BY THE WORKER ════════════════
  head('R4. cancellation reaches the worker and it stops');
  const cancelPlan = await newPlan({ seed: 'cancelcase' });
  const cStep = cancelPlan.plan.steps.find((s) => s.taskType === 'synthetic.echo');
  cStep.payload = { hello: 'cancel-case', delayMs: 60_000 };
  cStep.payloadDigest = PLANNER.digestOf(cStep.payload);
  cancelPlan.plan.steps = [cStep];
  const dCancel = await persistAndDispatch(cancelPlan.plan, workerId);
  if (dCancel.refused) bad('R4', 'the cancel fixture was refused', JSON.stringify(dCancel.refused.refusals));
  else {
    const claimed = await until('the Mac claims it', async () =>
      await one(`SELECT id FROM worker_tasks WHERE intent_key=$1 AND state='LEASED'`, [cStep.intentKey]));
    if (!claimed.ok) {
      await diagnose(cStep.intentKey);
      untested('R4', 'the worker never claimed the cancel fixture', 'cancellation was not exercised');
    } else {
      const run = await one(
        `SELECT run_id, started_at FROM agent_runs WHERE intent_key=$1 AND trigger_detail=$2
          ORDER BY started_at DESC LIMIT 1`, [cStep.intentKey, workerId]);
      await LEASES.cancelTask(claimed.value.id, { reason: 'M7.6 acceptance cancellation' }, deps);
      const rec = await one(
        `SELECT cancel_requested_at, cancel_reason FROM worker_tasks WHERE id=$1`, [claimed.value.id]);
      const observed = await until('a heartbeat lands after the cancel', async () => {
        const r = await one(
          `SELECT r.heartbeat_at, t.cancel_requested_at FROM agent_runs r
             JOIN worker_tasks t ON t.intent_key = r.intent_key
            WHERE t.id=$1 AND r.trigger_detail=$2 ORDER BY r.started_at DESC LIMIT 1`,
          [claimed.value.id, workerId]);
        return (r && r.heartbeat_at && r.cancel_requested_at
          && new Date(r.heartbeat_at) > new Date(r.cancel_requested_at)) ? r : null;
      }, { timeoutMs: signalBudget() });

      const probe = await newPlan({ seed: 'freeprobe' });
      const pStep = probe.plan.steps.find((s) => s.taskType === 'synthetic.echo');
      probe.plan.steps = [pStep];
      await persistAndDispatch(probe.plan, workerId);
      const freeAt = await until('the worker takes new work', async () =>
        await workerClaimAt(
          (await one(`SELECT id FROM worker_tasks WHERE intent_key=$1`, [pStep.intentKey])).id,
          workerId),
      { timeoutMs: signalBudget(), everyMs: 1_000 });

      let late = null;
      if (run) {
        late = await LEASES.submitResult(
          { workerId, runId: run.run_id, status: 'SUCCEEDED', output: { echoed: {}, steps: 0 } }, deps);
      }
      const resultCalls = run ? await workerEndpointCalls(run.run_id, 'result', workerId) : 0;
      const projected = run ? new Date(run.started_at).getTime() + 60_000 : 0;

      const v = BEHAVIOUR.judgeCancellation({
        recorded: Boolean(rec && rec.cancel_requested_at),
        serverRefusalCode: late && late.ok === false ? late.code : null,
        heartbeatAfterCancelAt: observed.ok ? new Date(observed.value.heartbeat_at).getTime() : null,
        workerResultAttempts: resultCalls,
        probeClaimedAt: freeAt.ok ? freeAt.value : null,
        projectedCompletionAt: projected,
      });
      note(`evidence: result-endpoint calls=${resultCalls}, free at=`
        + `${freeAt.ok ? new Date(freeAt.value).toISOString() : 'never'}, would have finished=`
        + `${new Date(projected).toISOString()}, server refusal=${late && late.code}`);
      note(`correlate on the iMac: run ${run && run.run_id} — expect cancel_signalled then aborted`);
      if (v.verdict === BEHAVIOUR.PASS) ok('R4', `cancellation is honoured by the worker — ${v.why}`);
      else if (v.verdict === BEHAVIOUR.UNTESTED) { await diagnose(cStep.intentKey); untested('R4', 'cancellation', v.why); }
      else { await diagnose(cStep.intentKey); bad('R4', 'cancellation', v.why); }

      const settled = await resolveAbandonedLease(cStep.intentKey, claimed.value.id);
      if (settled.task === 'NEEDS_RESOLUTION') ok('R4b', 'the cancelled lease resolves to NEEDS_RESOLUTION');
      else bad('R4b', `the cancelled lease ended as ${settled.task}`);
    }
  }

  // ════════════════ S5: A TYPE THE WORKER CANNOT RUN ════════════════
  head('S5. a declared type with no handler fails, and produces no report');
  const noHandlerIntent = `m76-${crypto.randomBytes(6).toString('hex')}-nohandler`;
  made.intentKeys.push(noHandlerIntent);
  const nh = await LEASES.enqueueTask(
    { taskType: 'synthetic.sleep', payload: {}, intentKey: noHandlerIntent,
      workflow: POLICY.PILOT_WORKFLOW, createdBy: 'm7-6-dev-driver' }, deps);
  if (nh && nh.taskId) made.taskIds.push(nh.taskId);
  const nhRes = await until('the worker reports a failure', async () =>
    await one(`SELECT status, output FROM worker_results WHERE task_id=$1`, [nh.taskId]),
  { timeoutMs: 90_000, everyMs: 2_000 });
  if (!nhRes.ok) {
    await diagnose(noHandlerIntent);
    untested('S5', 'the worker never reported on the unimplemented type',
      'without a report there is nothing to judge; the worker may not have claimed it');
  } else if (nhRes.value.status === 'FAILED'
      && /no_handler/.test(JSON.stringify(nhRes.value.output))) {
    ok('S5', 'an allowlisted type with no handler is reported FAILED with no_handler, not improvised');
  } else {
    bad('S5', 'the worker did something unexpected with an unimplemented type',
      JSON.stringify(nhRes.value).slice(0, 200));
  }

  // ════════════════ S6: REVOCATION, AGAINST A FIXTURE IDENTITY ════════════════
  head('S6. a revoked identity is refused — tested on a FIXTURE, not the operational worker');
  note('M7.5 scenario 8 revoked the live worker and burned three operational identities. This');
  note('creates its own, revokes that, and leaves the office iMac able to work afterwards.');
  // ── THE ENROLMENT CONTRACT, READ RATHER THAN GUESSED ──────────────────────
  //
  // The 2026-11-23 run reported S6 UNTESTED with `IDENTITY.enrollWorker is not a function`. There
  // is no such export. The module exposes a two-step exchange:
  //
  //   createEnrollmentToken({ syntheticOnly: false, label })  -> { token, expiresAt, label, capabilities }   (throws on no label)
  //   consumeEnrollmentToken({ token }) -> { ok: true, workerId, secret } | { ok: false, code }
  //
  // The old code also tried `tok.token || tok.plaintext || tok.value`, which is the same guess
  // wearing a disguise: a fallback chain across three field names nobody had looked up. It is now
  // `tok.token`, because that is the field.
  //
  // ── WHY THIS GOES OVER HTTP, AND NOT THROUGH claimTask ────────────────────
  //
  // The 2026-11-23 run reported S6 as PASS: `a revoked fixture identity cannot claim
  // (nothing_to_do)`. That pass did not hold, and the code was the tell. Reading the three layers:
  //
  //   LEASES.claimTask            does NOT consult revocation. Its selection is
  //                               `WHERE state='PENDING' AND cancel_requested_at IS NULL` — no
  //                               identity predicate at all. `nothing_to_do` meant the QUEUE WAS
  //                               EMPTY, which is what a valid identity would also have received,
  //                               because cleanup had just drained it.
  //   AUTH.authorizeWorkerAction  does NOT either. It asks autonomy.checkStopped — STOPs, not
  //                               revocation. So the old "before revocation it was permitted"
  //                               control was measuring the wrong thing too.
  //   AUTH.authenticateWorker     DOES, at auth.js step 4, before the secret is even opened.
  //
  // The old assertion was `claimAfter.ok === false`, which an empty queue satisfies, so S6 could
  // not have failed. The database said so independently afterwards: the fixture identity's row read
  // `last seen never`, and last_seen_at advances on EVERY successful authentication — so the
  // enforcement path was never reached even once.
  //
  // So the probe is now a real signed HTTP request to the development worker API, which this driver
  // runs alongside inside the same container. That exercises the layer that enforces revocation,
  // and the router's deny() writes a worker_audit row — giving database evidence of the refusal
  // that is independent of anything this driver reports about itself.
  //
  // ── THE FIXTURE SECRET ────────────────────────────────────────────────────
  //
  // Signing needs the secret, which consumeEnrollmentToken returns here and nowhere else. It is
  // held in a local, passed only to AUTH.signRequest, and never logged, persisted, serialized,
  // added to `made`, or included in any note/assertion/diagnostic. The guards in
  // m7-6-driver-guards.test.js pin that: the single `.secret` read is the scoped exception, and
  // the holding identifier is asserted to appear nowhere near an output call.
  let fixtureId = null;
  let fixtureSecret = null;
  try {
    const tok = await IDENTITY.createEnrollmentToken(
      { label: FIXTURE_IDENTITY_LABEL, createdBy: 'm7-6-acceptance' }, deps);
    const enrolled = await IDENTITY.consumeEnrollmentToken({ token: tok.token }, deps);
    if (!enrolled || enrolled.ok !== true) {
      // A refusal is a code, not an exception — `cannot_seal` in particular means the dev
      // environment lacks the sealing key, which is a configuration answer and not a product one.
      note(`the fixture identity was refused: ${(enrolled && enrolled.code) || 'no result'}`);
    } else {
      fixtureId = enrolled.workerId;
      fixtureSecret = enrolled.secret;      // scoped exception: see the guards test
      made.identities.push(fixtureId);
      note(`fixture identity ${fixtureId} enrolled for this scenario only`);
    }
  } catch (e) {
    note(`the fixture identity could not be enrolled in-process: ${String(e.message).slice(0, 140)}`);
  }
  if (!fixtureId || !fixtureSecret) {
    untested('S6', 'no fixture identity could be created',
      'revocation was NOT tested against the operational worker on purpose — doing so would revoke '
      + 'the identity the iMac is running and require a new enrolment, which is the defect this '
      + 'scenario exists to avoid. The server-side refusal remains covered by src/lib/worker/auth.test.js.');
  } else {
    const before = await signedAuthProbe(fixtureId, fixtureSecret);
    await IDENTITY.revokeWorker(fixtureId, { reason: 'M7.6 acceptance fixture revocation' }, deps);
    const row = await one(
      `SELECT revoked_at, revoked_reason FROM worker_identities WHERE id=$1`, [fixtureId]);
    const after = await signedAuthProbe(fixtureId, fixtureSecret);
    // The independent half: the router audited its own refusal.
    // `at`, not `created_at` — check-driver-sql.js caught that before this ever reached hardware,
    // which is the whole reason it exists. There is also an index on (worker_id, at DESC).
    const audited = await one(
      `SELECT code, http_status, outcome FROM worker_audit
        WHERE worker_id = $1 AND outcome = 'DENIED' AND code = 'revoked'
        ORDER BY at DESC LIMIT 1`, [fixtureId]);

    note(`probe before revocation: HTTP ${before.status} ${before.code || ''} `
      + `(authentication ${before.authenticated ? 'SUCCEEDED' : 'did not succeed'})`);
    note(`probe after revocation : HTTP ${after.status} ${after.code || ''}`);
    note(`worker_audit: ${audited ? `DENIED ${audited.code} (${audited.http_status})` : 'no DENIED revoked row'}`);

    if (!before.reachable || !after.reachable) {
      untested('S6', 'the development worker API could not be reached over HTTP',
        `probe transport failed (${before.error || after.error}); without an authenticated request `
        + 'there is no evidence about the authentication layer, and claimTask does not consult '
        + 'revocation at all, so nothing weaker may stand in for this');
    } else if (!before.authenticated) {
      untested('S6', 'the fixture could not authenticate BEFORE revocation',
        `the pre-revocation control did not pass (HTTP ${before.status} ${before.code}), so a `
        + 'refusal afterwards would not be attributable to revocation. The control is what makes '
        + 'the refusal meaningful');
    } else if (!row || !row.revoked_at) {
      bad('S6', 'the revocation was not recorded', JSON.stringify(row));
    } else if (after.status === 401 && after.code === 'revoked' && audited) {
      ok('S6', `a revoked fixture identity is refused by the authentication layer `
        + `(HTTP 401 revoked), audited as DENIED, and it authenticated successfully before `
        + `revocation (HTTP ${before.status} ${before.code}) — the operational worker ${workerId} `
        + 'is untouched');
    } else if (after.status === 401 && after.code === 'revoked') {
      untested('S6', 'the refusal was not audited',
        'the authentication layer refused the revoked identity, but no DENIED/revoked row was '
        + 'written, so the governance trail does not corroborate it');
    } else {
      bad('S6', 'a revoked identity was NOT refused by the authentication layer',
        `HTTP ${after.status} ${after.code} — revocation is not enforced on the path a real worker uses`);
    }
  }

  // ════════════════ S7: OUTPUT BOUNDS ════════════════
  head('S7. the output bound');
  note('Not re-exercised here. The 64 KB ceiling is enforced in the executor and verified against a');
  note('real worker and database by scripts/check-worker-runtime-db.js (the `rt-big` case), which');
  note('submits an oversized output and asserts refusal. Re-running it from this driver would');
  note('duplicate that coverage without adding evidence — and the report handler cannot exceed the');
  note('bound by construction: five sections, regardless of fact count.');
  ok('S7', 'covered by scripts/check-worker-runtime-db.js, stated rather than silently skipped');

  // ════════════════ S8: NO REPORT FROM UNVALIDATED OUTPUT ════════════════
  head('S8. a malformed result produces no report');
  const badPlan = await newPlan({ seed: 'malformed' });
  if (!badPlan.refused) {
    await PIPELINE.recordPlan(badPlan.plan, { state: 'VALIDATED' }, deps);
    const fake = {
      ...badPlan.plan,
      steps: badPlan.plan.steps.map((s) => ({ ...s })),
    };
    // No dispatch: the point is the SERVER refusing to build a report, so the collected result is
    // absent and assembly must refuse rather than produce a partial artifact.
    const asm = await PIPELINE.assemble(fake, { expectedFactCount: FACT_COUNT }, deps);
    const reportRows = await one(
      `SELECT COUNT(*)::int n FROM m76_reports WHERE plan_id=$1`, [badPlan.plan.planId]);
    if (!asm.ok && Number(reportRows.n) === 0) {
      ok('S8', `assembly refused (${asm.reason}) and wrote no report row`);
    } else bad('S8', 'a report was produced from steps that did not succeed');
  }

  // ════════════════ S9: PAYLOAD TAMPERING ════════════════
  head('S9. the payload that runs is the payload that was validated');
  const tamper = await newPlan({ seed: 'tamper' });
  if (!tamper.refused) {
    await PIPELINE.recordPlan(tamper.plan, { state: 'VALIDATED' }, deps);
    const step = tamper.plan.steps[0];
    await query(
      `UPDATE m76_plan_steps SET payload = $3 WHERE plan_id=$1 AND step_id=$2`,
      [tamper.plan.planId, step.stepId, JSON.stringify({ hello: 'tampered' })]);
    let refused = null;
    try {
      await PIPELINE.dispatchPlan(tamper.plan, { workerId, validated: true }, deps);
    } catch (e) { refused = e.message; }
    const dispatchedAnyway = await one(
      `SELECT COUNT(*)::int n FROM worker_tasks WHERE intent_key = $1`, [step.intentKey]);
    if (refused && /does not match the digest/.test(refused) && Number(dispatchedAnyway.n) === 0) {
      ok('S9', 'a payload altered after validation refuses dispatch, and nothing was enqueued');
    } else {
      bad('S9', 'a tampered payload was dispatched', `${refused || 'no refusal'}; tasks=${dispatchedAnyway.n}`);
    }
  }

  // ════════════════ R2 / R3 / R6: RETRY GOVERNANCE ════════════════
  head('R2 / R3 / R6. retry governance, bounded retries, and escalation');

  // R2: the database's own guard, reached without an override.
  const abandoned = made.intentKeys.find(Boolean);
  const r2run = await one(
    `SELECT run_id, intent_key, state, attempt FROM agent_runs
      WHERE intent_key = ANY($1) AND state = 'ABANDONED' ORDER BY started_at DESC LIMIT 1`,
    [made.intentKeys]);
  if (!r2run) {
    untested('R2', 'no ABANDONED predecessor existed in this run',
      'the retry guard could not be exercised. It is asserted against a real database in '
      + 'scripts/check-worker-leasing-db.js, which builds the predecessor deliberately.');
  } else {
    const elig = LEASES.reattemptEligibility
      ? LEASES.reattemptEligibility(
        (await one(`SELECT task_type FROM worker_tasks WHERE intent_key=$1`, [r2run.intent_key]) || {}).task_type,
        {})
      : null;
    if (elig && elig.ok === false) {
      ok('R2', `a retry over an ABANDONED predecessor is refused without a recorded reason (${elig.code})`);
    } else {
      // Then assert it at the database, which is the layer that cannot be reached around.
      let raised = null;
      try {
        await query(
          `INSERT INTO agent_runs (run_id, root_run_id, trigger, trigger_detail, product, state,
                                   intent_key, attempt, predecessor_run_id, started_at)
           VALUES ($1,$1,'worker',$2,'playbookos','RUNNING',$3,$4,$5,NOW())`,
          [crypto.randomUUID(), workerId, r2run.intent_key, Number(r2run.attempt) + 1, r2run.run_id]);
      } catch (e) { raised = e.message; }
      if (raised && /override|reason/i.test(raised)) {
        ok('R2', 'the database refuses a retry over an ABANDONED predecessor with no reason');
      } else bad('R2', 'a retry over an ABANDONED predecessor was permitted', raised || 'no error raised');
    }
  }

  // R6: the pilot's own cap, on top of that guard.
  const capStep = { taskType: 'report.daily_operations', intentKey: made.intentKeys[0] };
  const may = await PIPELINE.mayRetry(capStep, deps);
  const notRe = await PIPELINE.mayRetry(
    { taskType: 'proposal.draft_once', intentKey: made.intentKeys[0] }, deps);
  if (notRe.ok === false && notRe.reason === 'not_reexecutable') {
    ok('R6a', `a non-reexecutable type is never retried; the pilot cap is ${PIPELINE.MAX_ATTEMPTS} attempts`);
  } else bad('R6a', 'a non-reexecutable type was considered retryable');
  note(`mayRetry on a real step: ${JSON.stringify(may)}`);

  // R3: a validation failure escalates and is not retried.
  const esc = await newPlan({ seed: 'escalate' });
  if (!esc.refused) {
    await PIPELINE.recordPlan(esc.plan, { state: 'VALIDATED' }, deps);
    const r = await PIPELINE.escalate(esc.plan,
      { reason: 'report_failed_validation', detail: ['totals.count did not reconcile'] }, deps);
    const row = await one(`SELECT state, refused_reason FROM m76_plans WHERE plan_id=$1`, [esc.plan.planId]);
    const src = PIPELINE.decisionSource(deps);
    const items = await src.run();
    const mine = items.find((i) => i.id === `m76:${esc.plan.planId}`);
    if (row && row.state === 'ESCALATED' && r.escalated && mine) {
      ok('R3', 'a validation failure escalates to the decision queue instead of retrying');
      note(`decision item: ${mine.title}`);
    } else bad('R3', 'the escalation did not reach the decision queue', JSON.stringify({ row, mine }));
  }

  // ════════════════ R1: CRASH RECOVERY ════════════════
  head('R1. crash recovery');
  const armed = await (async () => {
    // The driver cannot read the iMac's plist. What it CAN do is dispatch the crash task and read
    // what comes back: an unarmed worker refuses and REPORTS, which is unambiguous.
    const intent = `m76-${crypto.randomBytes(6).toString('hex')}-crash`;
    made.intentKeys.push(intent);
    const t = await LEASES.enqueueTask({
      taskType: 'synthetic.crash_test',
      payload: { confirm: 'crash-this-worker', workerId },
      intentKey: intent, workflow: POLICY.PILOT_WORKFLOW, createdBy: 'm7-6-dev-driver',
    }, deps);
    if (t && t.taskId) made.taskIds.push(t.taskId);
    return { intent, taskId: t && t.taskId };
  })();

  const crashOutcome = await until('the worker dies or refuses', async () =>
    await one(`SELECT status, output FROM worker_results WHERE task_id=$1`, [armed.taskId]),
  { timeoutMs: 45_000, everyMs: 2_000 });

  if (crashOutcome.ok && /crash_test_refused/.test(JSON.stringify(crashOutcome.value.output))) {
    untested('R1', 'the worker is not armed for the crash handshake',
      'It refused and reported instead of dying, which is correct behaviour for an unarmed worker '
      + 'and is NOT a product failure. Crash recovery was not exercised. To exercise it, arm the '
      + 'worker on the iMac:\n  workerctl install <url> <wkr_id> --env development --crash-test=90\n'
      + 'Arming needs separate authorization and the window expires on its own.');
  } else if (crashOutcome.ok) {
    bad('R1', 'the crash task completed normally instead of crashing the worker',
      JSON.stringify(crashOutcome.value).slice(0, 200));
  } else {
    const settled = await resolveAbandonedLease(armed.intent, armed.taskId);
    if (settled.task === 'NEEDS_RESOLUTION') {
      ok('R1', `the crashed lease reached NEEDS_RESOLUTION (ceiling ${settled.ceiling}min), run ${settled.run}`);
      const dup = await one(`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1`, [armed.taskId]);
      if (Number(dup.n) === 0) ok('R1b', 'and nothing re-executed it — reexecutable:false honoured');
      else bad('R1b', 'a crashed task was re-executed', `${dup.n} result row(s)`);
      const restart = await newPlan({ seed: 'aftercrash' });
      const rStep = restart.plan.steps.find((s) => s.taskType === 'synthetic.echo');
      restart.plan.steps = [rStep];
      await persistAndDispatch(restart.plan, workerId);
      const alive = await until('the restarted worker takes new work', async () =>
        await one(`SELECT wr.status FROM worker_results wr JOIN worker_tasks wt ON wt.id=wr.task_id
                    WHERE wt.intent_key=$1`, [rStep.intentKey]),
      { timeoutMs: 180_000, everyMs: 2_000 });
      if (alive.ok) ok('R1c', 'control: launchd restarted the worker and it executes NEW work');
      else { await diagnose(rStep.intentKey); bad('R1c', 'the worker never came back'); }
    } else {
      await diagnose(armed.intent);
      untested('R1', 'the crash task neither completed nor settled',
        'whether the worker died cannot be established from this run');
    }
  }

  return null;     // the verdict is computed by the caller
}

// ── CLEANUP: HONEST, PER TABLE, AUDIT PRESERVED ─────────────────────────────

async function cleanup() {
  const deleted = new Map();
  const errors = [];
  const del = async (table, sql, params) => {
    try {
      const r = await query(sql, params);
      deleted.set(table, (deleted.get(table) || 0) + (r.rowCount || 0));
    } catch (e) { errors.push({ table, detail: String(e.message).slice(0, 180) }); }
  };

  const foreign = await query(
    `SELECT intent_key, state FROM agent_runs
      WHERE intent_key LIKE 'm7%' AND NOT (intent_key = ANY($1)) ORDER BY intent_key`,
    [made.intentKeys.length ? made.intentKeys : ['']]);

  for (const id of made.taskIds) {
    await del('worker_results', `DELETE FROM worker_results WHERE task_id = $1`, [id]);
  }
  for (const id of made.taskIds) {
    await del('worker_tasks', `DELETE FROM worker_tasks WHERE id = $1`, [id]);
  }
  for (const s of made.stops) {
    await del('autonomy_stops',
      `DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2`, [s.scopeType, s.scopeKey]);
  }
  for (const id of made.planIds) {
    await del('m76_reports', `DELETE FROM m76_reports WHERE plan_id = $1`, [id]);
    await del('m76_plan_steps', `DELETE FROM m76_plan_steps WHERE plan_id = $1`, [id]);
    await del('m76_plans', `DELETE FROM m76_plans WHERE plan_id = $1`, [id]);
  }
  for (const id of made.goalIds) {
    await del('m76_goals', `DELETE FROM m76_goals WHERE goal_id = $1`, [id]);
  }

  // Verification, by id, for every table written.
  let leaked = 0;
  const survivors = async (table, sql, params) => {
    const r = await one(sql, params);
    if (Number(r.n) > 0) { leaked += Number(r.n); console.log(`    LEAK  ${table}: ${r.n} row(s)`); }
  };
  if (made.taskIds.length) {
    await survivors('worker_tasks', `SELECT COUNT(*)::int n FROM worker_tasks WHERE id = ANY($1)`, [made.taskIds]);
    await survivors('worker_results', `SELECT COUNT(*)::int n FROM worker_results WHERE task_id = ANY($1)`, [made.taskIds]);
  }
  if (made.planIds.length) {
    await survivors('m76_plans', `SELECT COUNT(*)::int n FROM m76_plans WHERE plan_id = ANY($1)`, [made.planIds]);
    await survivors('m76_plan_steps', `SELECT COUNT(*)::int n FROM m76_plan_steps WHERE plan_id = ANY($1)`, [made.planIds]);
    await survivors('m76_reports', `SELECT COUNT(*)::int n FROM m76_reports WHERE plan_id = ANY($1)`, [made.planIds]);
  }
  if (made.goalIds.length) {
    await survivors('m76_goals', `SELECT COUNT(*)::int n FROM m76_goals WHERE goal_id = ANY($1)`, [made.goalIds]);
  }
  for (const s of made.stops) {
    await survivors('autonomy_stops',
      `SELECT COUNT(*)::int n FROM autonomy_stops WHERE scope_type=$1 AND scope_key=$2`,
      [s.scopeType, s.scopeKey]);
  }

  const runRows = made.intentKeys.length ? (await one(
    `SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = ANY($1)`, [made.intentKeys])).n : 0;
  const auditRows = made.taskIds.length ? (await one(
    `SELECT COUNT(*)::int n FROM worker_audit WHERE task_id = ANY($1)`, [made.taskIds])).n : 0;

  const claimable = await one(
    `SELECT COUNT(*)::int n FROM worker_tasks
      WHERE intent_key LIKE 'm76-%' AND state='PENDING' AND cancel_requested_at IS NULL`);

  const after = await query(
    `SELECT intent_key, state FROM agent_runs
      WHERE intent_key LIKE 'm7%' AND NOT (intent_key = ANY($1)) ORDER BY intent_key`,
    [made.intentKeys.length ? made.intentKeys : ['']]);
  const fp = (rows) => rows.map((r) => `${r.intent_key}:${r.state}`).join('|');
  const preserved = fp(foreign.rows) === fp(after.rows);

  console.log('\n  fixture cleanup, by table:');
  for (const t of ['worker_results', 'worker_tasks', 'autonomy_stops',
    'm76_reports', 'm76_plan_steps', 'm76_plans', 'm76_goals']) {
    console.log(`    ${t.padEnd(16)} deleted ${String(deleted.get(t) || 0).padStart(3)}`);
  }
  console.log(`    agent_runs       retained ${runRows} row(s) — a run that emitted any event CANNOT be`);
  console.log('                     deleted: agent_run_events is append-only and its FK has no CASCADE');
  console.log(`    worker_audit     retained ${auditRows} row(s) — the governance trail this run produced`);
  console.log(`    worker_identities retained — including ${made.identities.length} fixture identity(ies)`);
  console.log('                     revoked by S6; a revocation record IS the evidence');
  for (const e of errors) console.log(`    ERROR  ${e.table}: ${e.detail}`);
  console.log(`    claimable m76-% tasks remaining: ${claimable.n}`);
  console.log(`    other runs' records: ${foreign.rows.length} before, ${after.rows.length} after `
    + `— ${preserved ? 'unchanged' : 'CHANGED'}`);

  const clean = !errors.length && !leaked && Number(claimable.n) === 0 && preserved;
  if (!clean) {
    console.log('\n  CLEANUP NOT CLEAN:');
    if (errors.length) console.log(`    ${errors.length} statement(s) failed`);
    if (leaked) console.log(`    ${leaked} fixture row(s) survived`);
    if (Number(claimable.n)) console.log(`    ${claimable.n} claimable task(s) remain`);
    if (!preserved) console.log('    another run\'s records changed — investigate before any rerun');
  }
  return clean;
}

// ── VERDICT ─────────────────────────────────────────────────────────────────

main()
  .then(async () => {
    const clean = await cleanup();
    if (!clean) bad('C1', 'fixture cleanup did not complete', 'see the accounting above');

    console.log('');
    console.log(`  intent keys : ${made.intentKeys.join(', ') || '(none)'}`);
    console.log(`  task ids    : ${made.taskIds.join(', ') || '(none)'}`);
    console.log(`  plan ids    : ${made.planIds.join(', ') || '(none)'}`);
    console.log('');
    const byVerdict = results.reduce((acc, r) => {
      (acc[r.verdict] = acc[r.verdict] || []).push(r.id); return acc;
    }, {});
    for (const v of ['PASS', 'FAIL', 'UNTESTED']) {
      if (byVerdict[v]) console.log(`  ${v.padEnd(9)} ${byVerdict[v].join(', ')}`);
    }
    console.log('');
    if (fail === 0 && untestedCount === 0) {
      console.log('PASS  the office iMac executed a governed, planned, policy-validated workflow on');
      console.log('      synthetic data, honoured cancellation and STOP, refused what it should, and');
      console.log('      produced a report whose every figure is traceable to a task, a run and a');
      console.log('      worker — with no outbound capability anywhere in the path.\n');
      await pool.end().catch(() => {});
      process.exit(0);
    }
    if (fail) console.log(`FAIL  ${fail} scenario expectation(s) did not hold.`);
    if (untestedCount) {
      console.log(`UNTESTED  ${untestedCount} scenario(s) could not be judged. Their preconditions did`);
      console.log('          not hold, so they are neither passed nor failed — they are unknown.');
    }
    console.log('M7.6 is not accepted.\n');
    await pool.end().catch(() => {});
    process.exit(fail ? 1 : 3);
  })
  .catch(async (e) => {
    console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(3);
  });
