// ── THE M7.6 ACCEPTANCE DRIVER'S OWN SAFEGUARDS ─────────────────────────────
//
//   node --test scripts/m7-6-driver-guards.test.js
//
// This driver cancels tasks, sets a STOP, creates and revokes an identity and ages runs. The
// refusals that keep it away from production are the only thing between it and a database somebody
// cares about, so they are tested rather than trusted — the same discipline check-m7-5-guards.js
// applies to its predecessor.
//
// Every assertion here is structural, because the driver cannot be executed without a live
// development database and a running worker on the office iMac. That is a reason to check what CAN
// be checked before a hardware window opens, not a reason to check nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DRIVER = path.join(__dirname, 'm7-6-dev-driver.js');
const SRC = fs.readFileSync(DRIVER, 'utf8');
/** Comment lines stripped, so a guard never trips over the prose that documents it. */
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── IT CANNOT RUN AGAINST PRODUCTION ───────────────────────────────────────

test('DECISIVE: the driver refuses production hosts, production NODE_ENV and an unconfirmed database', () => {
  for (const host of ['postgres.railway.internal', 'interchange.proxy.rlwy.net']) {
    assert.ok(SRC.includes(host), `${host} is not in the refusal list`);
  }
  assert.match(CODE, /NODE_ENV === 'production'/);
  assert.match(CODE, /M7_6_DEV_CONFIRM !== 'yes'/);
  // The refusal must happen before anything that can reach a database is required.
  const refusalAt = CODE.indexOf('refuseIfProduction()');
  const poolAt = CODE.indexOf("require('pg')");
  assert.ok(refusalAt < poolAt && refusalAt !== -1,
    'the production refusal must run before pg is required, not after');
});

test('the refusal is subdomain-aware, not an equality test', () => {
  // `host === bad` alone would let a subdomain of a production host through.
  assert.match(CODE, /endsWith\(`\.\$\{bad\}`\)/);
});

// ── GOVERNANCE IS NOT REACHED AROUND ───────────────────────────────────────

test('DECISIVE: no overrideReason and no retry-governance bypass', () => {
  assert.ok(!/overrideReason/.test(CODE), 'the driver must not pass overrideReason');
  assert.ok(!/retry_override_reason/.test(CODE), 'nor write the override column');
});

test('R2 proves the guard by being refused BY it, not by asserting around it', () => {
  // The scenario inserts a retry with no reason and requires the database to raise. A test that
  // supplied the reason would be exercising the happy path and calling it a guard.
  const r2 = SRC.slice(SRC.indexOf('R2 / R3 / R6'));
  assert.match(r2, /INSERT INTO agent_runs/);
  assert.ok(!/retry_override_reason/.test(r2.slice(0, r2.indexOf('R6:'))),
    'R2 must not supply an override reason');
});

// ── THE 42 STOPs ───────────────────────────────────────────────────────────

test('DECISIVE: the containment inventory is compared before and after by identity', () => {
  assert.match(CODE, /stopsAtStart/, 'the inventory must be captured before anything');
  assert.match(CODE, /stopInventory\(\)/);
  assert.match(CODE, /inv\.join\('\|'\) === stopsAtStart\.join\('\|'\)/,
    'a count comparison would miss a swap; the identities must match');
});

test('only the fixture STOP is ever written or deleted', () => {
  const inserts = [...CODE.matchAll(/INSERT INTO autonomy_stops[\s\S]{0,200}?\]/g)].map((m) => m[0]);
  assert.equal(inserts.length, 1, 'exactly one place may write a STOP');
  assert.match(inserts[0], /m7-6-dev-driver/, 'the fixture STOP must be attributable to this driver');
  const deletes = [...CODE.matchAll(/DELETE FROM autonomy_stops[^`]*/g)].map((m) => m[0]);
  for (const d of deletes) {
    assert.match(d, /scope_type\s*=\s*\$1\s+AND\s+scope_key\s*=\s*\$2/,
      `a STOP delete must name its exact composite key: ${d}`);
  }
});

// ── CLEANUP: BY ID, AND NEVER THE AUDIT ────────────────────────────────────

test('DECISIVE: every DELETE names a recorded identity', () => {
  const KEYED = /WHERE\s+[\w.]+\s*=\s*\$1\s*$/i;
  const KEYED_ANY = /WHERE\s+[\w.]+\s*=\s*ANY\(\$1\)\s*$/i;
  const COMPOSITE = /WHERE\s+scope_type\s*=\s*\$1\s+AND\s+scope_key\s*=\s*\$2\s*$/i;
  const lines = CODE.split('\n').filter((l) => /DELETE FROM/i.test(l));
  assert.ok(lines.length >= 6, `expected several deletes, found ${lines.length}`);
  for (const l of lines) {
    const sql = (l.match(/DELETE FROM[^`]*/i) || [''])[0].trim();
    const keyed = KEYED.test(sql) || COMPOSITE.test(sql)
      || (KEYED_ANY.test(sql) && /\[made\.\w+\]/.test(l));
    assert.ok(keyed, `not keyed to a recorded identity: ${sql}`);
  }
});

test('DECISIVE: no time-window or pattern delete', () => {
  // The 2026-09-30 defect: `DELETE ... WHERE created_at > NOW() - INTERVAL '10 minutes'`.
  for (const l of CODE.split('\n').filter((x) => /DELETE FROM/i.test(x))) {
    assert.ok(!/INTERVAL/i.test(l), `a time-window delete: ${l.trim()}`);
    assert.ok(!/LIKE/i.test(l), `a pattern delete: ${l.trim()}`);
  }
});

test('DECISIVE: audit evidence is never deleted', () => {
  for (const table of ['worker_audit', 'agent_run_events', 'autonomy_events', 'worker_identities']) {
    assert.ok(!new RegExp(`DELETE FROM ${table}`, 'i').test(CODE),
      `the driver deletes from ${table}, which is evidence`);
  }
  assert.ok(!/DELETE FROM agent_runs/i.test(CODE),
    'agent_runs that emitted events cannot be deleted; attempting it reports a leak that is not one');
});

test('cleanup verifies every table it deletes from', () => {
  const body = CODE.slice(CODE.indexOf('async function cleanup()'));
  const written = new Set([...body.matchAll(/DELETE FROM ([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase()));
  const checked = new Set([...body.matchAll(/survivors\('([a-z0-9_]+)'/g)].map((m) => m[1].toLowerCase()));
  const missing = [...written].filter((t) => !checked.has(t));
  assert.deepEqual(missing, [], `deleted but never verified: ${missing.join(', ')}`);
});

test('cleanup swallows no exception', () => {
  const body = CODE.slice(CODE.indexOf('async function cleanup()'));
  assert.ok(!/catch\s*\(\s*_\s*\)\s*\{\s*\}/.test(body.replace(/pool\.end\(\)\.catch\([^)]*\)/g, '')),
    'an empty catch is how a failing delete stays invisible');
  assert.match(body, /errors\.push/);
});

// ── NO FALSE PASS, NO SILENT UNTESTED ──────────────────────────────────────

test('DECISIVE: worker behaviour is judged from worker_audit, not from absences', () => {
  // The M7.5 lesson: "no result row" is satisfied by a worker that aborted AND by one that
  // finished and was refused. worker_audit is written only by the HTTP routes.
  assert.match(CODE, /workerEndpointCalls\(/);
  assert.match(CODE, /deniedClaims\(/);
  assert.match(CODE, /workerClaimAt\(/);
  assert.match(CODE, /BEHAVIOUR\.judgeCancellation\(/);
  assert.match(CODE, /BEHAVIOUR\.judgeStop\(/);
  // And the inputs must come FROM those helpers, not from literals.
  assert.match(CODE, /workerResultAttempts:\s*resultCalls/);
  assert.match(CODE, /deniedClaimAttempts:\s*refusedClaims/);
});

test('DECISIVE: every UNTESTED carries a reason', () => {
  const calls = [...SRC.matchAll(/untested\(\s*'([^']+)'\s*,/g)];
  assert.ok(calls.length >= 5, `expected several UNTESTED paths, found ${calls.length}`);
  // The signature is untested(id, what, why) — three arguments, so a reason cannot be omitted.
  assert.match(CODE, /const untested = \(id, m, why\)/);
  assert.match(CODE, /String\(why\)\.split/, 'the reason must be printed, not merely accepted');
});

test('UNTESTED fails the gate — it is not a softer pass', () => {
  assert.match(CODE, /fail === 0 && untestedCount === 0/);
  assert.match(CODE, /process\.exit\(fail \? 1 : 3\)/);
});

test('DECISIVE: a liveness probe gates the hardware scenarios', () => {
  // Six scenarios once reported product FAILs against a worker that was not running.
  //
  // The first version of this asserted /workerIsPolling\(workerId\)/ anywhere in the source — and
  // PASSED when the call site was replaced with `{ polling: true }`, because the FUNCTION
  // DEFINITION still matched. A guard that matches a definition is satisfied by dead code.
  assert.match(CODE, /await workerIsPolling\(workerId\)/, 'the probe must be CALLED');
  assert.match(CODE, /if \(!live\.polling\)/, 'and its result must gate the run');
  assert.match(CODE, /return 3;/, 'an absent worker must end the run as incomplete, not as a pass');
  assert.match(CODE, /last_seen_at did not advance/);
});

test('CONTROL: a hardcoded liveness result is still detectable', () => {
  const faked = 'const live = { polling: true };';
  assert.ok(!/await workerIsPolling\(workerId\)/.test(faked),
    'if this stops discriminating, the assertion above has gone blind again');
});

// ── DIAGNOSTICS BEFORE CLEANUP ─────────────────────────────────────────────

test('DECISIVE: diagnostics run before cleanup, and are bounded', () => {
  const diagAt = CODE.indexOf('async function diagnose(');
  const cleanAt = CODE.indexOf('async function cleanup()');
  assert.ok(diagAt !== -1 && diagAt < cleanAt);
  // Called from failure paths, not only defined.
  const calls = [...CODE.matchAll(/await diagnose\(/g)];
  assert.ok(calls.length >= 5, `diagnose is called ${calls.length} time(s); failures must explain themselves`);
  // Bounded: the queries are LIMITed, so a diagnostic cannot print a table.
  const body = CODE.slice(diagAt, cleanAt);
  assert.ok((body.match(/LIMIT/gi) || []).length >= 2, 'diagnostic queries must be bounded');
});

// ── THE REVOCATION FIXTURE ─────────────────────────────────────────────────

test('DECISIVE: S6 revokes a FIXTURE identity, never the operational worker', () => {
  const s6 = SRC.slice(SRC.indexOf('S6. a revoked identity'), SRC.indexOf('S7. the output bound'));
  assert.match(s6, /createEnrollmentToken/, 'it must create its own identity');
  assert.match(s6, /revokeWorker\(fixtureId/, 'and revoke THAT one');
  assert.ok(!/revokeWorker\(workerId/.test(s6),
    'revoking the operational worker is the defect this scenario exists to avoid — three '
    + 'operational identities were burned that way during M7.5');
  assert.ok(!/revokeWorker\(workerId/.test(CODE), 'nor anywhere else in the driver');
});

test('S6 carries a control, so the refusal is not always true', () => {
  const s6 = SRC.slice(SRC.indexOf('S6. a revoked identity'), SRC.indexOf('S7. the output bound'));
  assert.match(s6, /beforeRevoke/, 'the identity must be shown permitted BEFORE revocation');
});

// ── PER-RUN ISOLATION ──────────────────────────────────────────────────────

test('DECISIVE: no hardcoded intent key; every one is namespaced per plan', () => {
  const literals = CODE.match(/'m76-[a-z][a-z0-9-]*'/g) || [];
  assert.deepEqual(literals, [], `hardcoded intent keys: ${literals.join(', ')}`);
  // The two fixtures that bypass the planner still randomise their own keys.
  const adhoc = [...CODE.matchAll(/`m76-\$\{([^}]+)\}-(\w+)`/g)].map((m) => m[1]);
  for (const expr of adhoc) {
    assert.match(expr, /randomBytes|planId/,
      `an ad-hoc intent key must be random or plan-scoped, got \${${expr}}`);
  }
});

test('the planner namespaces keys under a random plan id', () => {
  const PLANNER = require('../src/lib/m76/planner');
  const a = PLANNER.plan({ goalId: 'g', text: "today's operations report", asOf: '2026-11-20', factCount: 2 });
  const b = PLANNER.plan({ goalId: 'g', text: "today's operations report", asOf: '2026-11-20', factCount: 2 });
  assert.notEqual(a.plan.planId, b.plan.planId);
  const keys = new Set([...a.plan.steps, ...b.plan.steps].map((s) => s.intentKey));
  assert.equal(keys.size, 4, 'two runs must not share an intent key');
});

// ── NO OUTBOUND ────────────────────────────────────────────────────────────

test('DECISIVE: the driver requires no outbound primitive', () => {
  const requires = [...SRC.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const r of requires) {
    assert.ok(!/mailer|whatsapp|services\/sender|node-fetch|office\/execute/.test(r),
      `the driver requires ${r}`);
  }
  assert.ok(!/\bfetch\s*\(/.test(CODE), 'the driver calls fetch()');
  // A REQUIRE of it, not the word: `child_process` appears inside S3's own forbidden-list regex,
  // and the first version of this assertion flagged the driver for containing the check that
  // forbids it. That is the third time today a guard has tripped over the text documenting it.
  assert.ok(!/require\((['"])node:?child_process\1\)/.test(CODE),
    'the driver requires child_process and can spawn a process');
});

// ── BUDGETS CAN SATISFY THEIR OWN CONDITIONS ───────────────────────────────

test('DECISIVE: the abandoned-lease wait ages past the DECLARED ceiling', () => {
  // M7.5 scenario 7 waited 240s for a 5-minute ceiling and could never pass.
  const fn = CODE.slice(CODE.indexOf('async function resolveAbandonedLease'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /max_runtime_minutes/, 'the ceiling must be read from the row, not assumed');
  assert.match(body, /ceiling \+ 10/, 'and the run aged past it with a margin');
});

test('the mid-flight fixtures outlive one heartbeat interval', () => {
  // Cancellation and STOP are delivered in a heartbeat response at ~50s. A shorter task finishes
  // first and the signal is never delivered — which is what made the M7.5 20-second fixtures
  // measure the refusal path instead of the cancellation path.
  const delays = [...CODE.matchAll(/delayMs:\s*([0-9_]+)/g)].map((m) => Number(m[1].replace(/_/g, '')));
  assert.ok(delays.length >= 2, `expected mid-flight fixtures, found ${delays.length}`);
  for (const d of delays) {
    assert.ok(d >= 55_000, `a ${d}ms task cannot receive a signal delivered at ~50s`);
  }
});

// ── COVERAGE ───────────────────────────────────────────────────────────────

test('DECISIVE: every required scenario id appears', () => {
  const required = [
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7',
    'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9',
    'R1', 'R2', 'R3', 'R4', 'R5', 'R6',
  ];
  for (const id of required) {
    assert.match(SRC, new RegExp(`'${id}[a-c]?'`),
      `scenario ${id} is not reported by the driver`);
  }
});

test('the driver is not in migrate-all and applies no schema of its own', () => {
  assert.ok(!/CREATE TABLE/i.test(CODE), 'the acceptance driver must not create schema');
  assert.ok(!/DROP TABLE/i.test(CODE), 'nor drop any');
  assert.match(CODE, /information_schema\.tables/,
    'it must REFUSE when the pilot tables are absent rather than creating them');
});
