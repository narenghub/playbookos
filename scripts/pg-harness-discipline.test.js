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

// ── THE TWO RULES, ASSERTED WHERE INITDB NOW LIVES ─────────────────────────
//
// After B7.20b, ~75 harnesses no longer run `initdb` themselves: they obtain a cluster from
// `scripts/lib/pg-disposable.js`. The two properties the sweeps above check for each harness —
// one shared Postgres discovery, and a superuser named explicitly — did not stop mattering when
// the code moved. They became properties of ONE file, which is better, and a sweep that kept
// scanning the old population would have reported green over an empty set.
test('the disposable utility itself obeys the rules the harnesses obey', () => {
  const util = path.join(SCRIPTS, 'lib', 'pg-disposable.js');
  assert.ok(fs.existsSync(util),
    'scripts/lib/pg-disposable.js is gone. Every migrated harness obtains its cluster from it, so '
    + 'this is not a rename to absorb silently.');
  const src = fs.readFileSync(util, 'utf8');

  assert.ok(src.includes("require('./pg-cluster')"),
    'pg-disposable.js does not use the shared Postgres discovery in scripts/lib/pg-cluster.js. '
    + 'There is one search path. A private copy in the module that every harness now depends on '
    + 'is strictly worse than the 33 private copies this rule was written for.');

  assert.ok(!declaresOwnSearchPath(src),
    'pg-disposable.js declares its own server-binary directory list.');

  assert.ok(/initdb\b/.test(src),
    'pg-disposable.js no longer runs initdb — then it is not what creates the clusters any more, '
    + 'and this test is asserting a property of the wrong file.');

  assert.ok(!hasBareInitdb(src),
    'pg-disposable.js runs initdb without naming the superuser. initdb defaults the bootstrap '
    + 'superuser to the INVOKING OS USER, and every connection string it hands out says '
    + '`postgresql://postgres@...`, so a bare initdb resolves only where the process happens to '
    + 'run as root and su to postgres.');

  assert.ok(/INITDB_FLAGS/.test(src),
    'pg-disposable.js does not use INITDB_FLAGS, which is the one place the superuser and the auth '
    + 'method are named.');
});

// ── AND THE SAME DEFECT ON THE CLIENT SIDE ─────────────────────────────────
//
// `-U postgres` in INITDB_FLAGS fixes the SERVER's idea of the superuser's name. It does nothing for
// the psql, pg_restore and pg_dump calls that then connect to it: those default the ROLE to the
// invoking OS user independently. scripts/verify-restore.js was written after the 2026-11-03 lesson,
// uses the shared module, uses INITDB_FLAGS — and still passed no -U on any of its five client
// calls. In a container it runs as root and `su postgres`, so the role matched by coincidence, every
// run was green, and the first time it ran on the CEO's Mac it died on
// `role "nboda3230" does not exist` — the identical message pg-cluster.js's header was written about.
//
// The lesson had been recorded as a COMMENT in the shared module. A comment cannot fail a build, so
// the next script reproduced the bug while importing the file that explains it. This is the check
// that was missing.
//
// Only template literals that actually address the disposable cluster count. The signature of one is
// unambiguous — it interpolates the cluster's socket, port or bin directory — and it keeps prose,
// log labels and the documented production `pg_dump "$DATABASE_URL"` out of the sweep without an
// exemption list.
const CLIENT = /\b(psql|pg_restore|pg_dump|createdb|dropdb|pg_isready)\b/;
const ADDRESSES_CLUSTER = /-h \$\{sock\}|-p \$\{PGPORT\}|PATH=\$\{dir\}/;
const NAMES_A_ROLE = /\s-U\s+\S|postgres@|-U\$\{/;

function roleLessClientCalls(src) {
  const bad = [];
  // Comments first: a commented-out example is not an invocation.
  const code = src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  for (const lit of code.match(/`(?:[^`\\]|\\.)*`/g) || []) {
    if (!CLIENT.test(lit) || !ADDRESSES_CLUSTER.test(lit)) continue;
    if (!NAMES_A_ROLE.test(lit)) bad.push(lit.replace(/\s+/g, ' ').slice(0, 120));
  }
  return bad;
}

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
// ── TWO POPULATIONS, BECAUSE B7.20b SPLIT THEM ──────────────────────────────
//
// Until 2026-11-26 every harness started a cluster the same way: its own `initdb -D`. B7.20b
// migrated 51 of them onto `scripts/lib/pg-legacy-harness.js`, which is backed by the verified
// lifecycle utility — so those files no longer contain `initdb` at all.
//
// The non-vacuity floor caught that immediately: the sweep's population fell from 76 to 25 and
// three tests failed with *"the sweep found only 25 harnesses — it has stopped working."* **That
// guard was right and lowering its floor would have been the wrong fix** — it would have quietly
// narrowed the sweep to the files that had not been migrated, which is the shape of defect this
// whole file exists to prevent.
//
// So the population is widened instead. A file is a harness if it obtains a disposable cluster BY
// ANY ROUTE, and the rules are applied where they mean something:
//
//   · own search path / bare initdb  → only to files that run `initdb` THEMSELVES. A migrated file
//     has no search path and no initdb to get wrong; the utility owns both, in one place.
//   · **non-execution reported as a pass → to EVERY harness**, migrated or not. That is the defect
//     that reported 31 false passes on 2026-11-03, and migrating a cluster harness does nothing
//     whatever to prevent it.
// REQUIRING the module is not OBTAINING a cluster. `pg-cleanup.js` requires `pg-disposable` to
// INVENTORY clusters it did not create, and the first draft of this predicate flagged it — a sweep
// that cannot tell a creator from a reader would have to be narrowed until it stopped finding the
// real thing. The call is what matters.
const obtainsACluster = (src) => startsACluster(src)
  || /\bDISPOSABLE\.create\(/.test(src)
  || /\bcreate\(\s*\{\s*label:/.test(src)
  || /\bstartTemp\(/.test(src);

function executableScripts() {
  return fs.readdirSync(SCRIPTS)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'lib')
    .map((f) => path.join(SCRIPTS, f));
}

/** Files that run their own `initdb` — the raw-harness rules apply to these. */
function rawHarnesses() {
  return executableScripts()
    .filter((f) => { try { return startsACluster(fs.readFileSync(f, 'utf8')); } catch (_) { return false; } });
}

/** Every file that gets a cluster, however it gets one. */
function harnesses() {
  return executableScripts()
    .filter((f) => { try { return obtainsACluster(fs.readFileSync(f, 'utf8')); } catch (_) { return false; } });
}

// ── THE SWEEP ──────────────────────────────────────────────────────────────

test('every disposable-cluster harness uses the shared Postgres discovery', () => {
  const findings = [];
  const files = rawHarnesses();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    if (!src.includes("require('./lib/pg-cluster')")) findings.push(`${rel}: does not use the shared module`);
    if (declaresOwnSearchPath(src)) findings.push(`${rel}: declares its own Postgres search path`);
  }
  // ── THE SWEEP FOLLOWED THE CODE, AND THE RULE MOVED WITH IT ──────────────
  //
  // This floor was 20 and it FAILED, exactly as its own comment said it would: B7.20b's migration
  // took the raw-harness population from ~28 to 2, and a sweep over 2 files is close to vacuous.
  // Lowering the floor to 2 and leaving it there would have been the wrong repair — the rule would
  // still read almost nothing while reporting green.
  //
  // So the rule is now asserted in BOTH places, and neither is optional:
  //
  //   · over whatever raw harnesses remain, because a file that runs its own initdb is still that
  //     file's problem. Two remain, both deliberately: `check-db-tls-verification.js` needs a
  //     cluster with `ssl=on` and a generated certificate, which pg-disposable does not build and
  //     should not learn to; and `check-pg-harness-lifecycle-db.js` must construct the legacy pair
  //     VERBATIM in order to demonstrate that it leaks, so migrating it would delete the evidence.
  //   · over `scripts/lib/pg-disposable.js` itself, below — which is where `initdb` now actually
  //     happens for every other harness in the repository. Asserting the property across a
  //     population that has moved into one module is how a sweep comes to guard nothing.
  assert.ok(files.length >= 2,
    `the raw-harness sweep found only ${files.length} files. Two are expected and deliberate; if `
    + 'they have been migrated or renamed, this rule and the per-file assertions above have '
    + 'nothing left to read and the utility-level assertions below are the whole guarantee — say '
    + 'so here rather than leaving a sweep that passes by reading nothing');
  assert.deepEqual(files.map((f) => path.basename(f)).sort(),
    ['check-db-tls-verification.js', 'check-pg-harness-lifecycle-db.js'],
    'the set of files running their own initdb changed. A NEW raw harness is the copy-paste this '
    + 'migration existed to stop: use scripts/lib/pg-legacy-harness.js, which presents the same '
    + 'startTemp/stopTemp contract over the utility. A REMOVED one means this list is stale.');
  assert.deepEqual(findings, [],
    `\n${findings.length} harness(es) decide for themselves where Postgres lives.\n\n`
    + 'There is one search path, in scripts/lib/pg-cluster.js. A private copy cannot be corrected\n'
    + 'when a platform moves, and that is how 33 harnesses came to search Linux-only directories\n'
    + 'on a Mac and report a pass for every containment control in the gate.\n\n'
    + findings.join('\n'));
});

test('every initdb names its superuser explicitly', () => {
  const findings = [];
  // Raw harnesses only: a migrated file runs no initdb, and the utility's INITDB_FLAGS is the one
  // place the superuser is named.
  const files = rawHarnesses();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (hasBareInitdb(src)) findings.push(`${path.relative(ROOT, file)}: initdb without an explicit -U`);
  }
  // Same floor and same reason as the sweep above; the utility's own initdb is asserted below.
  assert.ok(files.length >= 2, `the raw-harness sweep found only ${files.length} files`);
  assert.deepEqual(findings, [],
    `\n${findings.length} harness(es) run initdb without naming the superuser.\n\n`
    + 'initdb defaults the bootstrap superuser to the INVOKING OS USER. These harnesses connect as\n'
    + '`postgresql://postgres@...`, so a bare initdb only resolves on a machine where the harness\n'
    + 'happens to run as root and su to postgres. Use ${INITDB_FLAGS}.\n\n'
    + findings.join('\n'));
});

// THE SWEEP MUST FOLLOW THE CODE. The restore logic was extracted from verify-restore.js into
// scripts/lib/restore.js so a second harness could not become a second copy — and that extraction
// moved the psql and pg_restore calls OUT of the set this file scans, because harnesses() looks at
// scripts/*.js only. The sweep would have kept passing while guarding nothing, which is the
// failure mode it exists to prevent. Caught by the non-vacuity control below, which is the whole
// reason that control is there.
function clientCallFiles() {
  const libDir = path.join(SCRIPTS, 'lib');
  const lib = fs.existsSync(libDir)
    ? fs.readdirSync(libDir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .map((f) => path.join(libDir, f))
    : [];
  return [...harnesses(), ...lib];
}

test('every psql / pg_restore call against a disposable cluster names its role', () => {
  const findings = [];
  const files = clientCallFiles();
  for (const file of files) {
    for (const call of roleLessClientCalls(fs.readFileSync(file, 'utf8'))) {
      findings.push(`${path.relative(ROOT, file)}: ${call}`);
    }
  }
  assert.ok(files.length >= 30, `the sweep found only ${files.length} harnesses`);
  assert.deepEqual(findings, [],
    `\n${findings.length} client call(s) connect to a disposable cluster without naming the role.\n\n`
    + 'The cluster\'s only superuser is `postgres` (INITDB_FLAGS). psql and pg_restore default the\n'
    + 'role to the INVOKING OS USER, which is a separate decision from initdb\'s. Run as root with an\n'
    + '`su postgres` wrapper the two coincide and the omission is invisible; run as a person it is\n'
    + '`role "<username>" does not exist` on the first call. Pass -U postgres.\n\n'
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

test('the client sweep detects the real bug and leaves prose alone', () => {
  // THE REAL THING, verbatim from verify-restore.js as it was when it failed on the Mac.
  for (const planted of [
    'sh(`PATH=${dir}:$PATH psql -h ${sock} -p ${PGPORT} -d postgres -c "CREATE DATABASE restored"`, true);',
    'sh(`PATH=${dir}:$PATH pg_restore --no-owner --exit-on-error -h ${sock} -p ${PGPORT} -d restored x`);',
    'sh(`gunzip -c x | PATH=${dir}:$PATH psql -v ON_ERROR_STOP=1 -h ${sock} -p ${PGPORT} -d restored`);',
    'sh(`PATH=${dir}:$PATH psql -tAq -h ${sock} -p ${PGPORT} -d restored -c ${JSON.stringify(sql)}`);',
  ]) {
    assert.equal(roleLessClientCalls(planted).length, 1, `a role-less client call was not detected: ${planted}`);
  }
  // The corrected forms, in both orderings a person might write them.
  for (const fixed of [
    'sh(`PATH=${dir}:$PATH psql -U postgres -h ${sock} -p ${PGPORT} -d postgres -c "x"`);',
    'sh(`PATH=${dir}:$PATH psql -tAq -U postgres -h ${sock} -p ${PGPORT} -d restored -c "x"`);',
    'sh(`PATH=${dir}:$PATH pg_restore -U postgres --no-owner -h ${sock} -p ${PGPORT} -d restored x`);',
  ]) {
    assert.deepEqual(roleLessClientCalls(fixed), [], `a corrected call was still flagged: ${fixed}`);
  }

  // AND THE FALSE POSITIVES THAT WOULD HAVE MADE THIS SWEEP UNUSABLE. Each of these is real text
  // from verify-restore.js. A check that fires on a log label gets an exemption list, and an
  // exemption list is where the next real finding goes to be ignored.
  for (const innocent of [
    "console.log(`  format    : ${isCustom ? 'custom (PGDMP) → pg_restore' : 'gzipped SQL → gunzip | psql'}`);",
    "note('pg_restore exiting 0 proves the bytes moved. This proves the thing you need in a disaster.');",
    'const usage = `  pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f prod.dump`;',
    '  // sh(`PATH=${dir}:$PATH psql -h ${sock} -d restored`); an old line, commented out',
    'const url = `postgresql://postgres@localhost/restored?host=${sock}&port=${PGPORT}`;',
  ]) {
    assert.deepEqual(roleLessClientCalls(innocent), [], `prose or a safe form was flagged: ${innocent}`);
  }

  // Non-vacuity, pointed at WHEREVER the implementation currently lives rather than at a file
  // name. The calls started in verify-restore.js and were extracted to lib/restore.js; hardcoding
  // either path means this control silently stops guarding the real code the next time it moves.
  // So: find the file that actually makes these calls, and prove the sweep fires on it.
  const holders = clientCallFiles().filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return /pg_restore -U postgres/.test(src) && /-h \$\{(sock|base)\}/.test(src);
  });
  assert.ok(holders.length >= 1,
    'no file in the swept set makes a pg_restore call against a disposable cluster any more — '
    + 'either the restore logic moved outside scripts/, or this control has stopped guarding it');
  for (const f of holders) {
    const live = fs.readFileSync(f, 'utf8');
    assert.deepEqual(roleLessClientCalls(live), [],
      `${path.relative(ROOT, f)} has role-less client calls again`);
    const reverted = live.replace(/ -U postgres/g, '');
    assert.ok(roleLessClientCalls(reverted).length >= 3,
      `with -U stripped the sweep no longer finds the bug in ${path.relative(ROOT, f)} — `
      + 'the predicate has stopped working');
  }
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
