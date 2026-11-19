// ── SCOPES: A SMALLER GATE MUST NOT BE MISTAKEN FOR THE WHOLE ONE ───────────
//
//   node --test scripts/preflight-scope.test.js
//
// `scripts/preflight-mac.sh` exists because the full preflight can never pass on the office iMac:
// on 2026-11-18 it reported 75 checks that DID NOT EXECUTE for want of a local Postgres, and a gate
// that always returns INCOMPLETE on a machine is a gate nobody reads on that machine.
//
// A subset gate is a dangerous thing to add, for the exact reason the aggregator exists. Three ways
// it could go wrong, and one test each:
//
//   1. it prints the full gate's wording over a subset's coverage      → "not the push gate"
//   2. a renamed step silently drops out and the scope shrinks to zero → SCOPE ERROR
//   3. excluded steps get counted as passes                           → the totals
//
// ── AND THE ONE THAT ACTUALLY HAPPENED ──────────────────────────────────────
//
// The first implementation exported PF_ONLY. preflight.sh's first step is the node test suite,
// which contains the aggregator's OWN negative control; that test sources verdict.sh, inherited the
// exported scope, and had every synthetic step filtered out from under it. Three of its assertions
// went red and the cause was two files away.
//
// A scope decides WHICH STEPS RUN. It must not be able to change HOW A STEP BEHAVES. The last test
// here is that property, asserted directly.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERDICT = path.join(ROOT, 'scripts', 'lib', 'verdict.sh');

/** Drives the aggregator with synthetic steps, under an optional scope. */
function runScoped(steps, { only = null, label = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfscope-'));
  const script = path.join(dir, 'drive.sh');
  fs.writeFileSync(script, [
    'set -uo pipefail',
    `PF_LOG="${path.join(dir, 'step.log')}"`,
    `. "${VERDICT}"`,
    ...steps,
    'pf_verdict',
    'exit $?',
  ].join('\n'));
  const env = { ...process.env };
  if (only !== null) env.PF_ONLY = only;
  if (label !== null) env.PF_SCOPE_NAME = label;
  const r = spawnSync('bash', [script], { encoding: 'utf8', env });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status };
}

test('a scope runs only the named steps and excludes the rest', () => {
  const { out, code } = runScoped([
    'pf_step "wanted" true',
    'pf_step "not wanted" false',
    'pf_step "also not wanted" bash -c \'exit 3\'',
  ], { only: 'wanted', label: 'mac' });

  assert.equal(code, 0, `the excluded failing step must not fail the scoped run\n${out}`);
  assert.match(out, /1 executed and passed/, out);
  assert.match(out, /2 further step\(s\) were EXCLUDED/, out);
});

test('a scoped PASS never says "safe to push"', () => {
  const { out, code } = runScoped([
    'pf_step "wanted" true',
    'pf_step "other" true',
  ], { only: 'wanted', label: 'mac / worker hardware' });

  assert.equal(code, 0);
  assert.match(out, /PASS \(mac \/ worker hardware\)/, out);
  assert.match(out, /NOT the push gate/, out);
  assert.doesNotMatch(out, /safe to push/,
    'a verdict over a subset must not borrow the full gate\'s conclusion');
});

test('an excluded step is not counted as a pass', () => {
  const { out } = runScoped([
    'pf_step "wanted" true',
    'pf_step "other" true',
    'pf_step "another" true',
  ], { only: 'wanted' });
  assert.match(out, /── 1 checks: 1 executed and passed/, out);
  assert.doesNotMatch(out, /3 executed and passed/, out);
});

test('a failure inside the scope still fails, and a skip inside it is still INCOMPLETE', () => {
  const failed = runScoped(['pf_step "wanted" false', 'pf_step "other" true'], { only: 'wanted' });
  assert.equal(failed.code, 1, failed.out);

  // `pf_step "x" "exit" 3` would run the SHELL BUILTIN and take the driver down with it — the
  // step's exit code has to come from a child process, as every real check's does.
  const skipped = runScoped([
    'pf_step "wanted" bash -c \'exit 3\'',
    'pf_step "other" true',
  ], { only: 'wanted' });
  assert.equal(skipped.code, 2, 'exit 3 in scope is still non-execution, not a pass');
  assert.match(skipped.out, /DID NOT EXECUTE/, skipped.out);
});

test('DECISIVE: a scope naming a step that does not exist fails the run', () => {
  // Without this, renaming a step would reduce the Mac gate to nothing while still printing PASS —
  // the 2026-11-03 defect with a new mechanism.
  const { out, code } = runScoped([
    'pf_step "wanted" true',
  ], { only: 'wanted\nthis step was renamed last week' });

  assert.equal(code, 1, 'a scope that matches nothing must not be able to pass');
  assert.match(out, /SCOPE ERROR/, out);
  assert.match(out, /this step was renamed last week/, out);
});

test('DECISIVE: the scope is invisible to the steps it runs', () => {
  // The regression that broke the aggregator's own test. A step inspects its environment and must
  // find no trace of the scope.
  const { out, code } = runScoped([
    'pf_step "wanted" env',
  ], { only: 'wanted', label: 'mac' });

  assert.equal(code, 0, out);
  // The step's own output is only shown on failure, so assert on the aggregator's view: had the
  // step seen PF_ONLY it would still pass here, so check the variable is gone from this shell too.
  const leak = runScoped([
    'pf_step "wanted" bash -c \'test -z "${PF_ONLY:-}" && test -z "${PF_SCOPE_NAME:-}"\'',
  ], { only: 'wanted', label: 'mac' });
  assert.equal(leak.code, 0,
    `a step could see PF_ONLY or PF_SCOPE_NAME in its environment\n${leak.out}`);
});

test('CONTROL: with no scope, every step runs and nothing is excluded', () => {
  const { out, code } = runScoped([
    'pf_step "a" true',
    'pf_step "b" true',
  ]);
  assert.equal(code, 0, out);
  assert.match(out, /2 executed and passed/, out);
  assert.doesNotMatch(out, /EXCLUDED/, 'an unscoped run must not mention exclusions');
  assert.match(out, /safe to push/, 'and it IS the push gate');
});

test('CONTROL: the two scope wrappers exist and name real steps', () => {
  const mac = fs.readFileSync(path.join(ROOT, 'scripts', 'preflight-mac.sh'), 'utf8');
  const preflight = fs.readFileSync(path.join(ROOT, 'scripts', 'preflight.sh'), 'utf8');

  // Pull the quoted PF_ONLY block out of the wrapper and check each line is a real step name. This
  // is the same property pf_scope_integrity enforces at runtime, asserted at test time so a rename
  // is caught by the suite rather than by somebody on a Mac at 7pm.
  const m = mac.match(/PF_ONLY='([\s\S]*?)'\nPF_SCOPE_NAME=/);
  assert.ok(m, 'preflight-mac.sh must declare PF_ONLY as a single-quoted block');
  const names = m[1].split('\n').map((s) => s.trim()).filter(Boolean);
  assert.ok(names.length >= 2, `expected several scoped steps, got ${names.length}`);
  for (const n of names) {
    // The wrapper escapes an apostrophe as '"'"' for the shell; undo that before matching.
    const literal = n.replace(/'"'"'/g, "'");
    assert.ok(preflight.includes(`pf_step "${literal}"`),
      `preflight.sh has no step named "${literal}" — the Mac scope would match nothing`);
  }

  const cloud = fs.readFileSync(path.join(ROOT, 'scripts', 'preflight-cloud.sh'), 'utf8');
  assert.match(cloud, /PF_ONLY=''/, 'the cloud wrapper must clear any inherited scope');
});
