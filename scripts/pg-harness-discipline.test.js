// ── NO HARNESS MAY DECIDE FOR ITSELF WHERE POSTGRES IS, OR WHAT A SKIP MEANS ──
//
//   node --test scripts/pg-harness-discipline.test.js
//
// Thirty-five harnesses each carried their own copy of the Postgres search path and their own idea
// of what a missing Postgres meant. By 2026-11-03 one missing dependency produced three different
// verdicts in a single run on the CEO's Mac: 33 skipped and reported `ok`, 2 found Postgres and
// crashed on `role "postgres" does not exist`, and 2 more reported a failure. Thirty-one of forty-
// four preflight steps claimed a pass having executed nothing.
//
// Fixing thirty-five copies fixes today. This fails the build instead, so a thirty-sixth harness
// cannot reintroduce any of the three defects:
//
//   1. its own search path          — drifted, and could not be corrected in one place
//   2. a bare `initdb -A trust`     — superuser named after the OS user, so `postgres@` only
//                                     resolves on a machine where the harness runs as root
//   3. exit 0 when it did not run   — non-execution reported as success
//
// WHY A SWEEP AND NOT A LIST OF FIXES: the same reason as departed-authority.test.js. The defect was
// found by grepping for a string across files nobody had a list of, and nothing stopped the next one.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

// ── THE PREDICATES, AS PURE FUNCTIONS ──────────────────────────────────────
// Pure so the negative controls below can run them against PLANTED source instead of against the
// repository. A scanner only ever tested on a clean tree is a scanner nobody has seen say no.

const startsACluster = (src) => src.includes('initdb -D');

// A hardcoded server-binary directory. The shared module is the one place these may appear.
const OWN_SEARCH_PATH = [
  /^const BIN\s*=\s*\[/m,
  /'\/usr\/lib\/postgresql\//,
  /'\/opt\/homebrew\/opt\/postgresql/,
  /'\/usr\/local\/opt\/postgresql/,
  /'\/usr\/pgsql-/,
];
const declaresOwnSearchPath = (src) => OWN_SEARCH_PATH.some((re) => re.test(src));

// An initdb invocation that sets its auth method without naming the superuser.
const hasBareInitdb = (src) => /initdb\b[^\n]*-A trust(?![^\n]*INITDB_FLAGS)/.test(src)
  && !/initdb -D \$\{base\}\/data \$\{INITDB_FLAGS\}/.test(src);

// Non-execution reported as success: a "no Postgres" branch that exits 0.
function skipExitsZero(src) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/skip\s+no Postgres available|SKIP\s+no local postgres/i.test(lines[i])) continue;
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      if (/process\.exit\(0\)/.test(lines[j])) return true;
    }
  }
  return false;
}

function signalsNonExecution(src) {
  return /process\.exit\(EXIT_NOT_EXECUTED\)/.test(src) || /notExecuted\(/.test(src);
}

// Executable harnesses only. A `.test.js` file is excluded for the same reason departed-authority
// .test.js excludes them: the negative controls below PLANT `const BIN = [...]`, a bare
// `initdb -A trust` and a skip-then-`exit 0` on purpose, and a sweep that flagged its own fixtures
// would have to be narrowed until it stopped detecting the real thing. (It did flag itself first
// time out, which is the cheapest possible proof that the predicates fire.)
function harnesses() {
  return fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'lib')
    .map((f) => path.join(SCRIPTS, f))
    .filter((f) => { try { return startsACluster(fs.readFileSync(f, 'utf8')); } catch (_) { return false; } });
}

// ── THE SWEEP ──────────────────────────────────────────────────────────────

test('every disposable-cluster harness uses the shared Postgres discovery', () => {
  const findings = [];
  const files = harnesses();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    if (!src.includes("require('./lib/pg-cluster')")) findings.push(`${rel}: does not use the shared module`);
    if (declaresOwnSearchPath(src)) findings.push(`${rel}: declares its own Postgres search path`);
  }
  // Non-vacuity: if the file list collapses, this passes by reading nothing — the failure mode of
  // every grep-based check, and the reason the 33 skipping harnesses went unnoticed for so long.
  assert.ok(files.length >= 30, `the sweep found only ${files.length} harnesses — it has stopped working`);
  assert.deepEqual(findings, [],
    `\n${findings.length} harness(es) decide for themselves where Postgres lives.\n\n`
    + 'There is one search path, in scripts/lib/pg-cluster.js. A private copy cannot be corrected\n'
    + 'when a platform moves, and that is how 33 harnesses came to search Linux-only directories\n'
    + 'on a Mac and report a pass for every containment control in the gate.\n\n'
    + findings.join('\n'));
});

test('every initdb names its superuser explicitly', () => {
  const findings = [];
  const files = harnesses();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (hasBareInitdb(src)) findings.push(`${path.relative(ROOT, file)}: initdb without an explicit -U`);
  }
  assert.ok(files.length >= 30, `the sweep found only ${files.length} harnesses`);
  assert.deepEqual(findings, [],
    `\n${findings.length} harness(es) run initdb without naming the superuser.\n\n`
    + 'initdb defaults the bootstrap superuser to the INVOKING OS USER. These harnesses connect as\n'
    + '`postgresql://postgres@...`, so a bare initdb only resolves on a machine where the harness\n'
    + 'happens to run as root and su to postgres. Use ${INITDB_FLAGS}.\n\n'
    + findings.join('\n'));
});

test('no harness reports a pass when it did not execute', () => {
  const findings = [];
  const files = harnesses();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    if (skipExitsZero(src)) findings.push(`${rel}: exits 0 on the no-Postgres path`);
    if (!signalsNonExecution(src)) findings.push(`${rel}: has no non-execution signal at all`);
  }
  assert.ok(files.length >= 30, `the sweep found only ${files.length} harnesses`);
  assert.deepEqual(findings, [],
    `\n${findings.length} harness(es) can report success without running.\n\n`
    + 'A check that did not execute must exit EXIT_NOT_EXECUTED (3), which preflight reports as\n'
    + 'INCOMPLETE. Exit 0 means "I proved this". On 2026-11-03 it meant that 31 times over, falsely.\n\n'
    + findings.join('\n'));
});

// ── THE NEGATIVE CONTROLS ──────────────────────────────────────────────────
// Without these, all three sweeps above pass on a repository where the predicates match nothing —
// and would keep passing if a predicate were widened until it could never fire.

test('the sweep detects a harness that declares its own search path', () => {
  for (const planted of [
    "const BIN = ['/usr/lib/postgresql/16/bin', '/usr/bin'];",
    "const dirs = ['/opt/homebrew/opt/postgresql@16/bin'];",
    "const p = '/usr/pgsql-16/bin';",
  ]) {
    assert.ok(declaresOwnSearchPath(planted), `a private search path was not detected: ${planted}`);
  }
  // And the shared module's own list is the one place it is allowed, so the predicate must be
  // applied to harnesses only — assert the module would otherwise trip it, which is why it is excluded.
  const mod = fs.readFileSync(path.join(SCRIPTS, 'lib', 'pg-cluster.js'), 'utf8');
  assert.ok(declaresOwnSearchPath(mod), 'the shared module no longer contains the search path');
  assert.ok(!harnesses().some((f) => f.includes(`lib${path.sep}pg-cluster.js`)),
    'the shared module is being swept as if it were a harness');
});

test('the sweep detects a bare initdb and accepts the shared flags', () => {
  assert.ok(hasBareInitdb('run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);'),
    'a bare initdb was not detected');
  assert.ok(hasBareInitdb('run(`initdb -D /tmp/x -A trust -E UTF8`);'),
    'a bare initdb with extra flags was not detected');
  assert.ok(!hasBareInitdb('run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);'),
    'the shared flags were misreported as a bare initdb');
});

test('the sweep detects non-execution reported as exit 0', () => {
  const planted = [
    "  console.log('  skip  no Postgres available (set X_PG_URL or install initdb)');",
    "  process.exit(0);",
  ].join('\n');
  assert.ok(skipExitsZero(planted), 'a skip-then-exit-0 was not detected');

  const corrected = planted.replace('process.exit(0)', 'process.exit(EXIT_NOT_EXECUTED)');
  assert.ok(!skipExitsZero(corrected), 'the corrected form was still flagged');
  assert.ok(signalsNonExecution(corrected), 'the corrected form was not recognised as signalling');

  // An exit 0 far away from the skip branch is a normal successful exit and must not be flagged,
  // or the predicate would fire on every harness and stop meaning anything.
  const unrelated = `${planted.split('\n')[0]}\n  process.exit(EXIT_NOT_EXECUTED);\n`
    + `${'\n'.repeat(20)}if (!fail) process.exit(0);`;
  assert.ok(!skipExitsZero(unrelated), 'a normal success exit was flagged as a false skip');
});

test('the reserved exit code is 3 and is defined in exactly one place', () => {
  const mod = fs.readFileSync(path.join(SCRIPTS, 'lib', 'pg-cluster.js'), 'utf8');
  assert.match(mod, /const EXIT_NOT_EXECUTED = 3;/, 'the reserved code moved or changed');
  const verdict = fs.readFileSync(path.join(SCRIPTS, 'lib', 'verdict.sh'), 'utf8');
  assert.match(verdict, /PF_EXIT_NOT_EXECUTED=3/, 'the aggregator no longer agrees on the reserved code');
  // The two halves must agree. If a harness says 3 and the aggregator looks for something else, a
  // skip becomes a FAIL — survivable — but if the aggregator looked for 0 it would become a pass.
  const harnessCode = (mod.match(/const EXIT_NOT_EXECUTED = (\d+);/) || [])[1];
  const aggCode = (verdict.match(/PF_EXIT_NOT_EXECUTED=(\d+)/) || [])[1];
  assert.equal(harnessCode, aggCode, 'the harnesses and the aggregator disagree about the reserved exit code');
});
