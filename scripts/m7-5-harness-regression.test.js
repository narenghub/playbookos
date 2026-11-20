// ── THE FOUR DEFECTS THAT ABORTED THE THIRD HARDWARE ACCEPTANCE RUN ─────────
//
//   node --test scripts/m7-5-harness-regression.test.js
//
// Every test here reproduces a defect that was found by running the harness against real hardware,
// twenty minutes into a run, after an operator had armed a crash test and was sitting watching.
// That is the most expensive possible place to find any of them, and all four were findable here.
//
//   scenario 3  waited for a state transition the implementation deliberately refuses to make
//   scenario 4  had a wait condition and a pass condition that contradicted each other
//   scenario 7  read a column that does not exist
//   cleanup     claimed success for two tables it never checked, over a swallowed exception
//
// These are source-level tests, because the defects are in the harness rather than in the product
// and because three of the four are statements that only execute against a live database on a
// separate machine. A structural test that runs in one second is not a weaker test than a hardware
// run here: it is the only test that runs BEFORE the hardware run.
//
// Each test carries a CONTROL that feeds the original defective text through the same assertion and
// requires it to fail. Without that, a test asserting the absence of a string passes just as well
// when the string, the file, or the test's own premise has quietly changed.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DRIVER_PATH = path.join(__dirname, 'm7-5-dev-driver.js');
const SRC = fs.readFileSync(DRIVER_PATH, 'utf8');

/** The source of one scenario, from its head() to the next one's. */
function scenario(n) {
  const start = SRC.indexOf(`head('${n}.`);
  assert.notEqual(start, -1, `scenario ${n} not found — has the driver been restructured?`);
  const next = SRC.indexOf(`head('${n + 1}.`, start);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

/** The body of cleanup(). */
function cleanupBody() {
  const start = SRC.indexOf('async function cleanup() {');
  assert.notEqual(start, -1, 'cleanup() not found');
  const end = SRC.indexOf('\nasync function setStop', start);
  assert.notEqual(end, -1, 'could not find the end of cleanup()');
  return SRC.slice(start, end);
}

/** Strip comment lines, so a test never trips over the prose documenting it. */
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── SCENARIO 3 — CANCELLATION ───────────────────────────────────────────────

test('scenario 3 does not demand a CANCELLED transition the design refuses to make', () => {
  const s = code(scenario(3));
  // leases.js cancelTask only flips PENDING -> CANCELLED. A LEASED task stays LEASED on purpose:
  // "Flipping it to CANCELLED here would claim the worker had stopped, which nothing has
  // established." The 2026-11-19 run spent 75 seconds waiting for that and reported a product FAIL.
  assert.ok(!/state === 'CANCELLED'/.test(s),
    'scenario 3 must not wait for state === CANCELLED');
  assert.ok(!/reach(ed)? CANCELLED/.test(s),
    'nor report failure for not reaching CANCELLED');
});

test('CONTROL: the original scenario 3 predicate still fails that assertion', () => {
  const original = `
    const stopped = await until('it stops', async () => {
      const r = await one(\`SELECT state FROM worker_tasks WHERE id=$1\`, [t2.taskId]);
      return r && r.state === 'CANCELLED' ? r : null;
    }, { timeoutMs: signalBudget() });
    if (stopped.ok) ok('the task is CANCELLED');
    else await badTimeout('the task did not reach CANCELLED', stopped, t2.taskId);`;
  assert.ok(/state === 'CANCELLED'/.test(original),
    'if this control ever stops matching, the test above has become vacuous');
});

test('scenario 3 asserts the contract that DOES hold: recorded, observed, refused, resolved', () => {
  const s = code(scenario(3));
  assert.match(s, /cancel_requested_at/, 'the cancellation must be asserted as durably recorded');
  assert.match(s, /cancel_reason/, 'with its reason');
  assert.match(s, /heartbeat_at/,
    'the worker observing the cancel is a heartbeat landing after it — nothing weaker is evidence');
  assert.match(s, /submitResult/,
    'the server-side refusal must be asserted by ATTEMPTING a submission');
  assert.match(s, /resolveAbandonedLease/,
    '"still LEASED" must be distinguished from "LEASED for ever"');
  // The refusal CODE moved into the judge on 2026-11-20, because a correct server refusal must
  // not be able to rescue a scenario whose worker evidence is missing. Asserted where it now
  // lives, so this test tracks the architecture instead of a string that used to be here.
  assert.match(s, /BEHAVIOUR\.judgeCancellation/, 'the verdict must come from the judge');
  const judge = fs.readFileSync(path.join(__dirname, 'lib/m75-worker-behaviour.js'), 'utf8');
  assert.match(judge, /serverRefusalCode !== 'cancelled'/,
    'and the judge must still require the documented refusal code');
});

test('scenario 3 gives the cancel long enough to be delivered at all', () => {
  const s = code(scenario(3));
  // Cancellation arrives inside a heartbeat RESPONSE. The interval is max(15s, ceiling/6) = 50s
  // for the 5-minute ceiling, so a 20-second task finishes before any heartbeat is due and the
  // cancellation path is never exercised — the test would be measuring the refusal path instead.
  //
  // The delay is a named constant now, because the same number also sets the projected completion
  // the worker has to beat. Two copies of it would be two chances to disagree.
  const named = /const CANCEL_DELAY_MS = ([0-9_]+)/.exec(SRC);
  assert.ok(named, 'scenario 3 must declare its delay as a constant');
  const ms = Number(named[1].replace(/_/g, ''));
  assert.ok(ms >= 55_000, `the task must outlive one heartbeat interval; got ${ms}`);
  assert.match(s, /delayMs: CANCEL_DELAY_MS/, 'and the task must actually use it');
  assert.match(s, /CANCEL_DELAY_MS/, 'as must the projected completion the worker must beat');
});

// ── THE WORKER-BEHAVIOUR EVIDENCE (added 2026-11-20) ────────────────────────

test('DECISIVE: scenarios 3 and 4 judge the WORKER, not only the server', () => {
  // The gap the owner caught: zero result rows is satisfied both by a worker that aborted and by
  // one that finished and was refused, and the submitResult assertion is this driver submitting
  // as the worker — a statement about the server.
  // The first version of this test matched /worker_audit|.../ anywhere in the scenario — and
  // PASSED after the audit query was deleted, because a note() log line mentions "worker_audit"
  // in its text. A test satisfied by a log message is the same defect it was written to catch, so
  // the required CALLS are named explicitly below.
  const required = {
    3: [/await workerEndpointCalls\(/, /await workerClaimAt\(/, /BEHAVIOUR\.judgeCancellation\(/],
    4: [/await deniedClaims\(/, /await workerEndpointCalls\(/, /BEHAVIOUR\.judgeStop\(/],
  };
  for (const n of [3, 4]) {
    const s = code(scenario(n));
    for (const re of required[n]) {
      assert.match(s, re, `scenario ${n} must actually call ${re} — only the real worker's HTTP `
        + 'requests appear in worker_audit, so this is its only evidence about the worker');
    }
    assert.match(s, /untested\(/,
      `scenario ${n} must be able to answer UNTESTED when the evidence cannot discriminate`);
  }

  // And the judge's inputs must be ASSIGNED FROM the helpers. Matching the call anywhere in the
  // scenario was not enough: hardcoding `deniedClaimAttempts = 1` passed, because the helper was
  // still called a few lines above inside the wait. The evidence has to be the thing that decides.
  assert.match(code(scenario(3)), /workerResultAttempts\s*=\s*run2[\s\S]{0,120}workerEndpointCalls\(/,
    'scenario 3 must take its attempt count from worker_audit, not a literal');
  assert.match(code(scenario(4)), /deniedClaimAttempts\s*=\s*await deniedClaims\(/,
    'scenario 4 must take its refused-claim count from worker_audit, not a literal');
  assert.match(code(scenario(4)), /workerResultAttempts3\s*=\s*run3[\s\S]{0,120}workerEndpointCalls\(/,
    'and its result-attempt count likewise');
});

test('CONTROL: a scenario that only MENTIONS the audit fails the test above', () => {
  // The exact shape that slipped through: the word present in a log line, the query gone.
  const pretend = "note(`result-endpoint calls (worker_audit; not the driver)`); const n = 0;";
  assert.ok(!/await workerEndpointCalls\(/.test(pretend),
    'if this ever matches, the assertion above has gone back to matching prose');
});

test('scenario 3 corroborates with a follow-up task, and 4 with a resume', () => {
  const s3 = code(scenario(3));
  assert.match(s3, /cancel-probe/, 'a worker that aborted is free before the task would have ended');
  assert.match(s3, /workerClaimAt/, 'and the claim timestamp is when it became free');
  const s4 = code(scenario(4));
  assert.match(s4, /stop-probe/, 'a task offered during the STOP must stay PENDING');
  assert.match(s4, /resumedCompleted/, 'and the resume is the control against a dead worker');
});

test('the audit helpers cannot be contaminated by the driver itself', () => {
  // worker_audit is written in the HTTP route layer only. If the library started writing it, the
  // driver's own in-process LEASES calls would appear as worker activity and the discriminator
  // would silently invert.
  const routes = fs.readFileSync(path.join(__dirname, '../src/api/worker.routes.js'), 'utf8');
  assert.match(routes, /AUDIT\.record/, 'the route layer must be what records the audit');
  const leases = fs.readFileSync(path.join(__dirname, '../src/lib/worker/leases.js'), 'utf8');
  assert.ok(!/INSERT INTO worker_audit/i.test(leases),
    'if leases.js ever writes worker_audit, scenarios 3 and 4 need rethinking: this driver calls '
    + 'leases.js directly, so its own submissions would become "worker" evidence');
});

// ── SCENARIO 4 — STOP ───────────────────────────────────────────────────────

test('scenario 4 does not accept a result row as proof the worker stopped', () => {
  const s = code(scenario(4));
  // The 2026-11-19 defect: the wait accepted "a result row exists" and the pass required "no
  // result row". The only quick way to satisfy the wait was the thing that failed the test.
  const waits = s.match(/await until\([\s\S]*?\}, \{ timeoutMs[^}]*\}\);/g) || [];
  for (const w of waits) {
    const countsResults = /COUNT\(\*\)[\s\S]*worker_results/.test(w);
    assert.ok(!countsResults,
      'a wait condition must not treat the existence of a result as the stop signal, because '
      + 'the pass condition requires there to be none:\n' + w.slice(0, 300));
  }
});

test('CONTROL: the original scenario 4 wait still fails that assertion', () => {
  const original = `
    const halted = await until('the worker stops', async () => {
      const r = await one(\`SELECT COUNT(*)::int n FROM worker_results WHERE task_id=$1\`, [t3.taskId]);
      const t = await one(\`SELECT state FROM worker_tasks WHERE id=$1\`, [t3.taskId]);
      return (t && t.state !== 'LEASED') || Number(r.n) > 0 ? { t, r } : null;
    }, { timeoutMs: signalBudget() });`;
  assert.ok(/COUNT\(\*\)[\s\S]*worker_results/.test(original),
    'the control must still exhibit the defect, or the test above proves nothing');
});

test('scenario 4 asserts the STOP in the scope the worker path actually consults', () => {
  const s = code(scenario(4));
  // Reading back the row just inserted would only prove the INSERT worked. Asking the authority
  // the way heartbeat() asks it proves the STOP applies to this worker.
  assert.match(s, /authorizeWorkerAction/,
    'the STOP must be verified through the same authority call heartbeat() makes');
  assert.match(s, /'stopped'/, 'and the documented submitResult refusal code asserted');
  assert.match(s, /stopInventory/,
    'the pre-existing containment STOPs must be compared before and after, not counted loosely');
});

test('the driver imports the authority it calls', () => {
  // Found while writing scenario 4: the new assertion called AUTH.authorizeWorkerAction and the
  // driver had no AUTH import. It would have thrown ReferenceError on hardware — the same class
  // of defect as the missing column, one module down.
  assert.match(SRC, /const AUTH = require\('\.\.\/src\/lib\/worker\/auth'\)/,
    'scenario 4 calls AUTH.authorizeWorkerAction; the require must exist');
  const auth = require('../src/lib/worker/auth');
  assert.equal(typeof auth.authorizeWorkerAction, 'function',
    'and the function must actually be exported under that name');
});

// ── SCENARIO 7 — CRASH RECOVERY ─────────────────────────────────────────────

test('scenario 7 reads the failure from output, not from a column that does not exist', () => {
  const s = code(scenario(7));
  assert.ok(!/error\s+FROM\s+worker_results/i.test(s),
    'worker_results has no `error` column — this is the statement that aborted the run');
  assert.match(s, /SELECT status, output FROM worker_results/,
    'the failure detail lives inside output');
});

test('worker_results genuinely has no error column, per the schema the app creates', () => {
  // The assertion above is about a string in a file. This one is about the schema, so that the
  // test cannot keep passing after the column is added for some other reason.
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'src/lib/worker/task-schema.js'), 'utf8');
  const block = /CREATE TABLE IF NOT EXISTS worker_results \(([\s\S]*?)\n\s*\)/.exec(ddl);
  assert.ok(block, 'worker_results DDL not found');
  assert.ok(!/^\s*error\s/m.test(block[1]),
    'if worker_results ever gains an error column, revisit scenario 7 deliberately');
  assert.match(block[1], /output\s+JSONB/, 'and output is where the failure detail goes');
});

test('scenario 7 keeps the protections it is testing', () => {
  const s = code(scenario(7));
  assert.ok(!/overrideReason/.test(s), 'no governance bypass');
  assert.match(s, /reexecutable:false|did not re-execute|re-executed/,
    'the non-re-execution assertion must survive');
  assert.match(s, /crash-control|crash_control/,
    'and the control proving launchd brought the worker back');
});

// ── CLEANUP — THE REPORTING DEFECT ──────────────────────────────────────────

test('cleanup swallows no exceptions', () => {
  const body = cleanupBody();
  assert.ok(!/catch\s*\(\s*_\s*\)\s*\{\s*\}/.test(body),
    'an empty catch is how the agent_runs foreign-key failure stayed invisible for three runs');
  assert.match(body, /errors\.push/, 'a failed statement must be recorded');
});

test('DECISIVE: every table cleanup deletes from is also verified', () => {
  const body = cleanupBody();
  const deletedFrom = new Set(
    [...body.matchAll(/DELETE FROM ([a-z_]+)/g)].map((m) => m[1]));
  const verified = new Set(
    [...body.matchAll(/survivors\('([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(deletedFrom.size >= 4, `expected several tables, found ${[...deletedFrom]}`);
  const unchecked = [...deletedFrom].filter((t) => !verified.has(t));
  assert.deepEqual(unchecked, [],
    'these tables are written and never verified, which is exactly what produced '
    + '"every fixture was removed" while agent_runs rows survived: ' + unchecked.join(', '));
});

test('CONTROL: the original cleanup fails both of those assertions', () => {
  const original = `
  for (const id of made.taskIds) {
    try { await query(\`DELETE FROM worker_results WHERE task_id = $1\`, [id]); } catch (_) {}
    try { await query(\`DELETE FROM worker_tasks WHERE id = $1\`, [id]); } catch (_) {}
  }
  for (const k of made.intentKeys) {
    try { await query(\`DELETE FROM agent_runs WHERE intent_key = $1\`, [k]); } catch (_) {}
  }`;
  assert.ok(/catch\s*\(\s*_\s*\)\s*\{\s*\}/.test(original), 'control must still show the empty catch');
  const deletedFrom = [...original.matchAll(/DELETE FROM ([a-z_]+)/g)].map((m) => m[1]);
  const verified = [...original.matchAll(/survivors\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(deletedFrom.length > verified.length,
    'and must still delete from more tables than it verifies');
});

test('cleanup deletes children before parents, because the FK has no CASCADE', () => {
  const body = cleanupBody();
  const iEvents = body.indexOf('DELETE FROM agent_run_events');
  const iRuns = body.indexOf('DELETE FROM agent_runs');
  assert.ok(iEvents !== -1 && iRuns !== -1, 'both deletes must exist');
  assert.ok(iEvents < iRuns,
    'agent_run_events references agent_runs with no ON DELETE CASCADE, so the child goes first');

  const runs = fs.readFileSync(path.join(__dirname, '..', 'src/lib/runs.js'), 'utf8');
  const fk = /run_id\s+UUID NOT NULL REFERENCES agent_runs\(run_id\)([^\n]*)/.exec(runs);
  assert.ok(fk, 'the agent_run_events FK must still be there');
  assert.ok(!/ON DELETE CASCADE/i.test(fk[1]),
    'if a CASCADE is ever added, this ordering requirement can be relaxed deliberately');
});

test('cleanup reports per table, and never claims more than it verified', () => {
  const body = cleanupBody();
  assert.match(body, /fixture cleanup, by table/, 'the accounting must be printed');
  assert.match(body, /retained/, 'records kept on purpose must be named as retained');
  assert.match(body, /claimable/, 'and no claimable acceptance task may be left behind');
  // "Retained by design" must be distinguishable from "leaked", or the report misleads in the
  // direction of reassurance.
  assert.match(SRC, /RETAINED_BY_DESIGN/);
  assert.match(SRC, /worker_audit/, 'the audit trail is retained deliberately, with a reason');
});

test('cleanup touches no other run\'s records, and proves it by comparison', () => {
  const body = cleanupBody();
  assert.match(body, /NOT \(intent_key = ANY\(\$2\)\)/,
    'other runs\' records must be snapshotted before and compared after');
  assert.match(body, /preserved/, 'and the comparison must gate the verdict');
  // The ABANDONED rows from previous runs are protecting their own intents. Deleting them is
  // explicitly out of scope.
  assert.ok(!/DELETE FROM agent_runs WHERE intent_key LIKE/.test(body),
    'never a LIKE-pattern delete across acceptance runs');
  assert.ok(!/ABANDONED/.test(body) || !/DELETE[\s\S]{0,80}ABANDONED/.test(body),
    'and never a delete selected by state');
});

// ── THE SYSTEMIC CHECK IS WIRED IN ──────────────────────────────────────────

test('DECISIVE: the SQL checker rejects the statement that aborted the run', () => {
  const checker = require('./check-driver-sql');
  const tables = checker.catalogFromDDL();
  const findings = [];
  checker.checkStatement(
    { sql: 'SELECT status, error FROM worker_results WHERE task_id=$1', line: 0 },
    tables, '(test)', findings);
  assert.ok(findings.some((f) => /error/.test(f.detail)),
    'the checker must reject the real defect, or it is decoration');

  const clean = [];
  checker.checkStatement(
    { sql: 'SELECT status, output FROM worker_results WHERE task_id=$1', line: 0 },
    tables, '(test)', clean);
  assert.deepEqual(clean, [], 'and must accept the corrected statement');
});

test('the SQL checker covers the driver, and finds statements in it', () => {
  const checker = require('./check-driver-sql');
  assert.ok(checker.TARGETS.includes('scripts/m7-5-dev-driver.js'));
  const { findings, perFile } = checker.run(checker.catalogFromDDL());
  const driver = perFile.find((f) => f.file === 'scripts/m7-5-dev-driver.js');
  assert.ok(driver && driver.n > 20,
    `the driver's SQL must be extracted, not silently skipped (found ${driver && driver.n})`);
  const hard = findings.filter((f) => f.kind !== 'INTERPOLATED');
  assert.deepEqual(hard, [], `unresolved SQL identifiers: ${JSON.stringify(hard, null, 2)}`);
});
