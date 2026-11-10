// ── THE GATE THAT GUARDS THE GATE ────────────────────────────────────────────
//
//   node --test scripts/ci-gate.test.js
//
// .github/workflows/preflight.yml is the only thing standing between a broken push and
// production, and it can be defeated by one careless character — a `|| true`, a `| tee`, a
// `continue-on-error: true` added to get a red build green on a Friday.
//
// Every assertion here corresponds to a way this project has already been burned:
//
//   2026-09-30  production broke twice in one session from reading the TAIL of a multi-line
//               report instead of its exit status. A pipe makes the gate report the status of
//               the LAST command in the pipe, which is never preflight.
//   2026-11-03  preflight printed `ok` for 31 of 44 steps on a Mac while those steps executed
//               NOTHING. A gate that accepts any exit code other than 0 accepts that outcome.
//
// This is a text test on purpose. Parsing the YAML and inspecting a structure would be tidier
// and would miss a `|| true` appended inside a run block, which is the realistic failure.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'preflight.yml');

test('the workflow exists at all', () => {
  // Deleting the file is the simplest way to remove the gate, and the least likely to be noticed
  // in a diff that also does something else.
  assert.ok(fs.existsSync(WORKFLOW), '.github/workflows/preflight.yml is missing — there is no CI gate');
});

const src = fs.existsSync(WORKFLOW) ? fs.readFileSync(WORKFLOW, 'utf8') : '';

// Comments explain WHY the rules exist and necessarily mention the things the rules forbid.
// Scanning them would fail on the explanation of the rule it is enforcing — a test failing for
// the wrong reason, which this repository has done four times in source-reading tests.
const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('it runs preflight, and runs it bare', () => {
  assert.match(code, /scripts\/preflight\.sh/, 'the workflow does not run preflight');

  // EVERY line that executes it, not the first line that mentions it.
  //
  // The first version of this test took the first non-echo line containing the path, which was
  // the JOB NAME — `name: scripts/preflight.sh` — a line that can never contain a pipe. So it
  // passed against a workflow mutated to `run: scripts/preflight.sh || true`, which is the exact
  // defeat it exists to catch. A negative control found that; reading the test did not.
  //
  // This is the fifth source-scanning test in this repository to match the wrong line. The
  // pattern each time: the thing being searched for appears somewhere harmless first.
  const execLines = code.split('\n')
    .filter((l) => /scripts\/preflight\.sh/.test(l))
    .filter((l) => !/^\s*name:/.test(l))
    .filter((l) => !/echo/.test(l));

  assert.ok(execLines.length >= 1, 'no line actually executes preflight');
  for (const line of execLines) {
    assert.match(line, /^\s*run:/, `preflight appears outside a run step: ${line.trim()}`);
    // A pipe reports the status of the LAST command in it. `cmd | tee log` is green when cmd fails.
    assert.ok(!/\|/.test(line), `preflight is piped, so its exit status is discarded: ${line.trim()}`);
    assert.ok(!/;\s*(true|exit 0)/.test(line), `preflight's status is overridden: ${line.trim()}`);
    assert.ok(!/&&/.test(line), `preflight is chained, which is how 2026-09-30 happened: ${line.trim()}`);
  }
});

test('no step is allowed to fail quietly', () => {
  // continue-on-error turns a red step into a green run. There is no legitimate use of it in a
  // gate whose entire purpose is to go red.
  assert.ok(!/continue-on-error:\s*true/.test(code), 'a step is marked continue-on-error: true');
  assert.ok(!/\bset\s+\+e\b/.test(code), 'a run block disables errexit');
});

test('it fires on push to main', () => {
  // A gate that only runs on pull requests is not a gate in a repository where work is pushed
  // straight to main — which is how this one is operated.
  assert.match(code, /push:/, 'the workflow does not trigger on push');
  const pushBlock = code.slice(code.indexOf('push:'), code.indexOf('push:') + 120);
  assert.match(pushBlock, /main/, 'the push trigger does not include main');
});

test('it needs no secrets — this repository is public', () => {
  // A gate that requires a credential cannot run on a fork's pull request, and a credential in a
  // public repository's CI is a credential one misconfigured workflow away from being printed.
  assert.ok(!/\$\{\{\s*secrets\./.test(code), 'the workflow references a secret');
});

test('it proves a Postgres SERVER is present, not merely initdb', () => {
  // The 2026-11-03 failure in one line: 33 harnesses found initdb on a machine with no postgres
  // binary, returned early, and reported a pass having asserted nothing. Checking for initdb
  // alone reproduces that exact hole in CI.
  assert.match(code, /initdb/, 'nothing verifies a Postgres toolchain is present');
  assert.match(code, /\/postgres"?\s*\]|\/postgres"\s|postgres --version|\$found\/postgres/,
    'the check looks for initdb without also requiring the postgres server binary');
});

test('a hung run cannot occupy a runner forever', () => {
  assert.match(code, /timeout-minutes:\s*\d+/, 'no timeout — a hung suite would run until GitHub kills it');
});

test('the YAML parses', () => {
  // Cheap structural check without adding a dependency: the keys the runner needs must be at the
  // left margin, and tabs are invalid YAML indentation anywhere.
  assert.ok(!/\t/.test(src), 'the workflow contains a tab character, which is invalid YAML');
  for (const key of ['name:', 'on:', 'jobs:']) {
    assert.ok(new RegExp(`^${key}`, 'm').test(src), `${key} is not a top-level key`);
  }
  assert.match(code, /runs-on:\s*ubuntu-latest/);
  assert.match(code, /uses:\s*actions\/checkout@v\d/);
  assert.match(code, /node-version:\s*'?22/);
  // npm ci, not npm install: the lockfile is the input, and a gate that resolves a different
  // dependency tree than production is not testing production.
  assert.match(code, /npm ci/, 'the workflow does not install from the lockfile');
});
