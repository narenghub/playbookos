#!/usr/bin/env node
// ── THE CANARY, UNDER CONTROLLED FAILURE ─────────────────────────────────────
//
//   scripts/check-run-canary-db.js   → exit 0 = every injected failure behaves as approved
//
// Before the real daily-8utc-github-sync occurrence is allowed to carry ledger instrumentation,
// each failure mode is demonstrated deliberately. The one that matters most is the first: if the
// durable identity cannot be created, the body must never be ENTERED — proven with a spy, because
// "it produced no output" is not evidence, and a system producing no output while every monitor
// read green is exactly the 2026-09-30 outage.
//
// Needs a server: set CANARY_PG_URL, or let it start a throwaway cluster if initdb is on PATH.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { ledger, instrumentedRun } = require('../src/lib/run-ledger');
const runs = require('../src/lib/runs');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 240)}`); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() { for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; } return null; }
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/canary-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55971' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55971 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55971`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.CANARY_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set CANARY_PG_URL or install initdb)');
  console.log('SKIP  canary failure injection not executed — this check needs a server');
  process.exit(0);
}

const WORKFLOW = 'daily-8utc-github-sync';
const NO_STOP = { checkStopped: async () => null, recordRefusal: () => {} };

(async () => {
  const { Pool } = require('pg');
  const A = new Pool({ connectionString: url, ssl: false });
  const B = new Pool({ connectionString: url, ssl: false });
  const aq = (t, p) => A.query(t, p);
  const bq = (t, p) => B.query(t, p);
  const slot = (mi) => new Date(2026, 9, 28, 8, mi);   // nominal 08:mi, as node-cron would hand it

  try {
    await require('../src/lib/autonomy').migrateAutonomy(aq);
    await runs.migrateRuns(aq);

    // ── 1. LEDGER UNAVAILABLE BEFORE EXECUTION ─────────────────────────────
    // The body must never be entered. Spy, not inference.
    let entered = 0;
    const broken = async () => { throw new Error('connection terminated unexpectedly'); };
    const r1 = await instrumentedRun(
      { workflow: WORKFLOW, product: 'internal', firedAt: slot(0) },
      async () => { entered += 1; return 'should never happen'; },
      { query: broken, autonomy: NO_STOP },
    );
    if (entered === 0) ok('ledger unavailable: the github-sync body was NEVER ENTERED (spy proves it)');
    else bad('THE BODY EXECUTED with no durable run identity');
    if (r1.ran === false && r1.reason === 'ledger_unavailable') ok('the refusal is reported as ledger_unavailable, not as success');
    else bad('wrong refusal shape', JSON.stringify(r1));

    // ── 2. SUCCESSFUL EXECUTION ────────────────────────────────────────────
    let ran = 0;
    const r2 = await instrumentedRun(
      { workflow: WORKFLOW, product: 'internal', firedAt: slot(1) },
      async () => { ran += 1; return { devs: 3 }; },
      { query: aq, autonomy: NO_STOP },
    );
    if (ran === 1 && r2.ran && r2.state === 'SUCCEEDED') ok('success: CREATED → RUNNING → SUCCEEDED, body ran exactly once');
    else bad('the success path is wrong', JSON.stringify({ ran, r2 }));
    const run2 = await bq(`SELECT state, started_at, ended_at, intent_key, attempt, workflow, product
                             FROM agent_runs WHERE run_id=$1`, [r2.runId]);
    const g = run2.rows[0];
    if (g.started_at && g.ended_at && g.started_at <= g.ended_at) ok('start and end timestamps are both durable and ordered');
    else bad('timestamps missing or inverted', JSON.stringify(g));
    if (g.intent_key === `cron:${WORKFLOW}:2026-10-28T08:01` && g.attempt === 1 && g.workflow === WORKFLOW) {
      ok('the intent key is the scheduled slot, attempt 1, correct workflow');
    } else bad('identity wrong', JSON.stringify(g));
    const tl = (await bq(`SELECT kind FROM agent_run_events WHERE run_id=$1 ORDER BY id`, [r2.runId])).rows.map((x) => x.kind);
    if (JSON.stringify(tl) === JSON.stringify(['RUN_CREATED', 'RUN_STARTED', 'RUN_ENDED'])) {
      ok('the event timeline is RUN_CREATED → RUN_STARTED → RUN_ENDED');
    } else bad('timeline wrong', tl.join(' → '));

    // ── 3. BODY FAILURE ────────────────────────────────────────────────────
    let threw = false;
    try {
      await instrumentedRun(
        { workflow: WORKFLOW, product: 'internal', firedAt: slot(2) },
        async () => { throw new Error('github api 503'); },
        { query: aq, autonomy: NO_STOP },
      );
    } catch (e) { threw = /github api 503/.test(e.message); }
    if (threw) ok('a body failure still propagates, so withAlerts alerts exactly as today');
    else bad('the body error did not propagate — a failure would now be silent');
    const f = await bq(`SELECT state, ended_at FROM agent_runs WHERE intent_key=$1`, [`cron:${WORKFLOW}:2026-10-28T08:02`]);
    if (f.rows[0] && f.rows[0].state === 'FAILED' && f.rows[0].ended_at) ok('body failure: CREATED → RUNNING → FAILED, never SUCCEEDED');
    else bad('a failed body did not end FAILED', JSON.stringify(f.rows[0] || null));

    // ── 4. POLICY STOP ─────────────────────────────────────────────────────
    await aq(`INSERT INTO autonomy_stops (scope_type, scope_key, reason)
              VALUES ('workflow', $1, 'canary check: scoped stop covering the github sync')`, [WORKFLOW]);
    const autonomy = require('../src/lib/autonomy');
    autonomy.resetForTests();
    let stopEntered = 0;
    const r4 = await instrumentedRun(
      { workflow: WORKFLOW, product: 'internal', firedAt: slot(3) },
      async () => { stopEntered += 1; },
      { query: aq, listen: () => {} },
    );
    if (stopEntered === 0) ok('policy stop: the body was never entered');
    else bad('THE BODY RAN while a scoped stop covered it');
    if (r4.reason === 'stopped_by_policy') ok('the outcome is reported as stopped_by_policy');
    else bad('wrong outcome for a policy stop', JSON.stringify(r4));
    const s4 = await bq(
      `SELECT r.state, e.reason, e.action FROM agent_runs r
         LEFT JOIN autonomy_events e ON e.id = r.stopped_by WHERE r.run_id=$1`, [r4.runId]);
    if (s4.rows[0] && s4.rows[0].state === 'STOPPED_BY_POLICY' && /canary check: scoped stop/.test(s4.rows[0].reason || '')) {
      ok('STOPPED_BY_POLICY is linked to the exact P0.2 refusal that caused it');
    } else bad('the stop link is missing', JSON.stringify(s4.rows[0] || null));
    await aq(`DELETE FROM autonomy_stops WHERE scope_type='workflow' AND scope_key=$1`, [WORKFLOW]);
    autonomy.resetForTests();

    // ── 5. DUPLICATE SCHEDULED TRIGGER ─────────────────────────────────────
    // Two processes on the same slot. One accepted; the other declines as duplicate and is NOT
    // reported as FAILED — a false "workflow failed" alert would be worse than the duplicate.
    let bodyRuns = 0;
    const both = await Promise.all([
      instrumentedRun({ workflow: WORKFLOW, product: 'internal', firedAt: slot(4) },
        async () => { bodyRuns += 1; }, { query: aq, autonomy: NO_STOP }),
      instrumentedRun({ workflow: WORKFLOW, product: 'internal', firedAt: slot(4) },
        async () => { bodyRuns += 1; }, { query: bq, autonomy: NO_STOP }),
    ]);
    const accepted = both.filter((x) => x.ran).length;
    const dupes = both.filter((x) => x.reason === 'duplicate_intent').length;
    if (accepted === 1 && dupes === 1) ok('duplicate trigger: one execution accepted, one declined as duplicate_intent');
    else bad('duplicate trigger handling wrong', JSON.stringify(both));
    if (bodyRuns === 1) ok('the body ran exactly once across both processes');
    else bad(`the body ran ${bodyRuns} times for one scheduled slot`);
    if (!both.some((x) => x.reason === 'ledger_unavailable' || x.state === 'FAILED')) {
      ok('the declined execution is NOT reported as a failure');
    } else bad('a duplicate was reported as a failure', JSON.stringify(both));
    const dupRows = await bq(`SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key=$1`,
      [`cron:${WORKFLOW}:2026-10-28T08:04`]);
    if (dupRows.rows[0].n === 1) ok('exactly one run row exists for the slot');
    else bad(`${dupRows.rows[0].n} run rows for one slot`);

    // ── 6. DURABILITY CLASSES BEHAVE DIFFERENTLY ───────────────────────────
    const L = ledger({ query: aq });
    // CRITICAL: actionAttempted must THROW when it cannot be persisted, so the caller does not act.
    const Lbroken = ledger({ query: async () => { throw new Error('disk full'); }, onDurabilityFailure: () => {} });
    let attemptThrew = false;
    try { await Lbroken.actionAttempted(r2.runId, { actionKind: 'email.send' }); }
    catch (_) { attemptThrew = true; }
    if (attemptThrew) ok('CRITICAL: actionAttempted throws when it cannot be persisted');
    else bad('actionAttempted swallowed a failure — a consequential action could proceed unrecorded');
    // TELEMETRY: a heartbeat failure is silent and returns false.
    const hb = await Lbroken.heartbeat(r2.runId);
    if (hb === false) ok('TELEMETRY: a failed heartbeat returns false and never throws');
    else bad('heartbeat did not degrade quietly');
    // OPERATIONAL: a failure is reported, loudly, and does not throw.
    let reported = null;
    const Lop = ledger({ query: async () => { throw new Error('disk full'); }, onDurabilityFailure: (w, e) => { reported = `${w}: ${e.message}`; } });
    const res = await Lop.startRun(r2.runId);
    if (res.ok === false && /disk full/.test(reported || '')) ok('OPERATIONAL: a failure is surfaced through onDurabilityFailure and does not throw');
    else bad('an operational durability failure was swallowed', JSON.stringify({ res, reported }));

    // PARTIAL is derived from the events, not guessed by the caller.
    const p = await L.createRun({ trigger: 'manual', product: 'internal', workflow: 'mixed', intentKey: 'canary:mixed' });
    await L.startRun(p.runId);
    await L.actionAttempted(p.runId, { actionKind: 'email.send', subjectRef: 'a' });
    await L.actionSucceeded(p.runId, { actionKind: 'email.send', subjectRef: 'a' });
    await L.actionAttempted(p.runId, { actionKind: 'email.send', subjectRef: 'b' });
    await L.actionFailed(p.runId, { actionKind: 'email.send', subjectRef: 'b', error: 'bounced' });
    const fin = await L.finish(p.runId, {});
    if (fin.state === 'PARTIAL') ok('a run with one success and one failure is derived as PARTIAL');
    else bad(`mixed outcomes produced ${fin.state}, expected PARTIAL`);

    // An attempted action with no acknowledgement is UNKNOWN_OUTCOME, not failed.
    const u = await L.createRun({ trigger: 'manual', product: 'internal', workflow: 'unknown', intentKey: 'canary:unknown' });
    await L.startRun(u.runId);
    await L.actionAttempted(u.runId, { actionKind: 'email.send', subjectRef: 'ghost' });
    await L.finish(u.runId, { state: 'ABANDONED' });
    const un = await L.unresolvedActions();
    if (un.some((x) => x.subject_ref === 'ghost') && !un.some((x) => x.subject_ref === 'a')) {
      ok('reconciliation lists the unacknowledged action and not the acknowledged one');
    } else bad('reconciliation wrong', JSON.stringify(un.map((x) => x.subject_ref)));

    // ── 7. RESTART VISIBILITY ──────────────────────────────────────────────
    const child = spawnSync(process.execPath, ['-e', `
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.U, ssl: false });
      const { ledger } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'run-ledger.js'))});
      (async () => {
        const L = ledger({ query: (t,p) => pool.query(t,p) });
        const run = await L.getRun(process.env.R);
        const tl = await L.timeline(process.env.R);
        const un = await L.unresolvedActions();
        console.log(JSON.stringify({ state: run && run.state, intent: run && run.intent_key,
          kinds: tl.map(e => e.kind), unresolved: un.map(x => x.subject_ref) }));
        await pool.end();
      })().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
    `], { env: { ...process.env, U: url, R: r2.runId }, encoding: 'utf8', timeout: 30000 });
    let v = null;
    try { v = JSON.parse(String(child.stdout).trim()); } catch (_) {}
    if (v && v.state === 'SUCCEEDED' && v.intent === `cron:${WORKFLOW}:2026-10-28T08:01`) {
      ok('a SEPARATE PROCESS reconstructs the run with no in-process state');
    } else bad('cross-process read failed', `${child.stdout}${child.stderr}`);
    if (v && v.unresolved.includes('ghost')) ok('the known-unknown is visible from another process too');
    else bad('the unresolved action was not visible cross-process');

    // ── CLEANUP: only what this check created ──────────────────────────────
    const mine = (await aq(
      `SELECT run_id FROM agent_runs WHERE intent_key LIKE $1 OR intent_key LIKE $2`,
      [`cron:${WORKFLOW}:2026-10-28T08:%`, 'canary:%'])).rows.map((x) => x.run_id);
    await aq(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`);
    await aq(`DELETE FROM agent_run_events WHERE run_id = ANY($1)`, [mine]);
    await aq(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`);
    await aq(`DELETE FROM agent_runs WHERE run_id = ANY($1)`, [mine]);
    const left = await bq(`SELECT COUNT(*)::int n FROM agent_runs WHERE run_id = ANY($1)`, [mine]);
    if (left.rows[0].n === 0) ok('fixture runs removed by explicit id');
    else bad(`${left.rows[0].n} fixture run(s) left behind`);
    const trg = await bq(`SELECT tgenabled FROM pg_trigger WHERE tgname='trg_agent_run_events_append_only'`);
    if (trg.rows[0] && trg.rows[0].tgenabled === 'O') ok('the append-only trigger is enabled again');
    else bad('append-only was left disabled');
  } catch (e) {
    bad('threw', e && e.stack ? e.stack : e);
  } finally {
    await A.end().catch(() => {});
    await B.end().catch(() => {});
    stopTemp();
  }

  if (fail) { console.log(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  the canary fails closed, never fakes success, and a duplicate is not a failure');
})();
