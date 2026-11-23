// ── THE STATE REPORT MUST BE ABLE TO SEE THE M7.6 PILOT ─────────────────────
//
//   node --test scripts/state-report-pilot-visibility.test.js
//
// On 2026-11-23 this report was used to close out an M7.6 acceptance run. It said `23 run(s)`
// before the run and `23 run(s)` after, which reads as proof that nothing was disturbed. It was
// proof of nothing: every query matched `m75-%`, and the pilot's intent keys are `m76-...`. The
// counter could not see M7.6 in either direction.
//
// That left the driver's own cleanup summary as the sole evidence of M7.6 audit retention — a
// component reporting on itself. This file pins the fix: a SEPARATE m76 section, and M7.5's
// counters still meaning exactly what they meant.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPORT = path.join(__dirname, 'm7-5-state-report.js');
const SRC = fs.readFileSync(REPORT, 'utf8');
/** Comment lines stripped, so a guard never trips over the prose documenting it. */
const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// ── THE EXISTING M7.5 COUNTERS ARE UNCHANGED ────────────────────────────────

test("DECISIVE: the M7.5 prefix still means M7.5 and nothing else", () => {
  assert.match(CODE, /ACCEPTANCE_INTENT_PREFIX\s*=\s*'m75-'/,
    'widening this constant would silently change what every M7.5 figure counts');
  // The dangerous "fix" would have been ACCEPTANCE_INTENT_PREFIX = 'm7', which matches both and
  // makes the M7.5 numbers quietly include M7.6. Explicitly refused.
  assert.ok(!/ACCEPTANCE_INTENT_PREFIX\s*=\s*'m7-?'/.test(CODE),
    'the M7.5 prefix must not be broadened to cover both');
});

test('the M7.5 task and run queries still bind to the M7.5 prefix', () => {
  const uses = [...CODE.matchAll(/\$\{ACCEPTANCE_INTENT_PREFIX\}%/g)];
  assert.ok(uses.length >= 2,
    'the M7.5 task list and run list must each still filter on the M7.5 prefix');
});

// ── AND M7.6 IS NOW VISIBLE, SEPARATELY ─────────────────────────────────────

test('DECISIVE: a distinct pilot prefix exists and is used', () => {
  assert.match(CODE, /PILOT_INTENT_PREFIX\s*=\s*'m76-'/);
  const uses = [...CODE.matchAll(/\$\{PILOT_INTENT_PREFIX\}%/g)];
  assert.ok(uses.length >= 4,
    `the pilot section must filter tasks, runs, audit and events — found ${uses.length} use(s)`);
});

test('DECISIVE: audit retention is reported from the audit tables themselves', () => {
  // The whole point. Without these two the report still could not corroborate the driver's claim
  // that it retained the governance trail.
  assert.match(CODE, /FROM worker_audit/, 'worker_audit must be counted');
  assert.match(CODE, /FROM agent_run_events/, 'agent_run_events must be counted');
  assert.match(CODE, /retained, append-only/, 'and labelled as retained rather than as a total');
});

test('the pilot section reports claimable pilot tasks, the 2026-11-18 hazard', () => {
  assert.match(CODE, /claimable m76 tasks/);
  assert.match(CODE, /CLAIMABLE\.includes/,
    'claimability must come from the shared CLAIMABLE list, not a second hand-written one');
});

test('the two sections are labelled so neither figure can be read as the other', () => {
  assert.match(SRC, /M7\.6 pilot \(counted separately; the figures above are M7\.5 only\)/,
    'an operator reading this report must not have to know which prefix each number came from');
});

// ── IT IS STILL READ-ONLY, AND STILL IDENTIFIES THE DATABASE ────────────────

test('DECISIVE: the added queries write nothing', () => {
  // The file has its own runtime self-check; this is the static half, and it runs in CI where the
  // report itself cannot (no development database).
  //
  // These patterns match STATEMENTS, not words. The first version of this test looked for the bare
  // word 'INSERT ' and failed — on the report's own forbidden-verb list, which is executable code
  // and quite correctly contains the string 'INSERT '. A guard that fires on the sentence
  // describing the rule rather than on a violation of it is noise, and this repo has produced that
  // exact bug twice now.
  const writes = [
    [/\bINSERT\s+INTO\b/i, 'INSERT INTO'],
    [/\bUPDATE\s+\w+\s+SET\b/i, 'UPDATE … SET'],
    [/\bDELETE\s+FROM\b/i, 'DELETE FROM'],
    [/\bTRUNCATE\s+\w/i, 'TRUNCATE'],
    [/\bDROP\s+(TABLE|INDEX|COLUMN)\b/i, 'DROP'],
    [/\bALTER\s+TABLE\b/i, 'ALTER TABLE'],
    [/\bCREATE\s+(TABLE|INDEX)\b/i, 'CREATE'],
  ];
  for (const [re, label] of writes) {
    assert.ok(!re.test(CODE), `the state report must contain no ${label} statement`);
  }
});

test('CONTROL: that write check can actually fail', () => {
  // Otherwise the test above is satisfied by a regex that matches nothing, which is how a guard
  // quietly stops guarding.
  const tampered = `${CODE}\n await query('DELETE FROM worker_tasks WHERE 1=1');`;
  assert.ok(/\bDELETE\s+FROM\b/i.test(tampered), 'the pattern must catch a real write');
});

test('DECISIVE: it refuses to report on a database it cannot identify as development', () => {
  // Reporting is harmless; reporting while believing a production database is the dev one is how
  // an operator ends up acting on the wrong numbers.
  assert.match(CODE, /db-identity|identifyDatabase/,
    'the report must gate on the development-identification check');
  assert.match(CODE, /DATABASE_URL/,
    'and read the real database rather than any fixture');
});
