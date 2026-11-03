// ── THE AGGREGATOR IS ITSELF A CHECK, SO IT GETS CHECKED ────────────────────
//
//   node --test scripts/preflight-verdict.test.js
//
// On 2026-11-03 `scripts/preflight.sh` printed `ok` for 31 of 44 steps on the CEO's Mac while those
// steps executed nothing, and ended with a verdict derived from "did anything exit non-zero?". The
// individual harnesses were not the defect. THE AGGREGATOR WAS. It had no way to say "this did not
// run", so non-execution arrived dressed as success and the word PASS went over the top of it.
//
// An aggregator that cannot be tested will not be. So the aggregation lives in
// scripts/lib/verdict.sh, and this drives it with SYNTHETIC steps whose exit codes are chosen by the
// test — `true`, `exit 1`, `exit 3` — rather than with real checks. Real checks would make this a
// test of Postgres availability on whatever machine happened to run it, which is the class of
// accident being fixed.
//
// ── AND IT CARRIES ITS OWN MUTATION CONTROL ────────────────────────────────
//
// Rule 8: a refusal test must prove WHICH control refused. The last test here mutates verdict.sh to
// treat exit 3 as a pass — reintroducing the exact 2026-11-03 defect — and asserts the verdict flips
// to PASS/0. Without that, every assertion below would keep passing if the skip branch were deleted
// and non-execution silently became success again.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERDICT = path.join(ROOT, 'scripts', 'lib', 'verdict.sh');

// Run a step list against an aggregator and return { out, code }. `steps` are literal pf_step lines.
function runVerdict(steps, aggregator = VERDICT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfverdict-'));
  const script = path.join(dir, 'drive.sh');
  fs.writeFileSync(script, [
    'set -uo pipefail',
    `PF_LOG="${path.join(dir, 'step.log')}"`,
    `. "${aggregator}"`,
    ...steps,
    'pf_verdict',
    'exit $?',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8' });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status };
}

test('every step passing is PASS, and the only verdict that exits 0', () => {
  const { out, code } = runVerdict([
    'pf_step "alpha" true',
    'pf_step "beta" true',
  ]);
  assert.match(out, /PASS/, out);
  assert.equal(code, 0, `a clean run must exit 0\n${out}`);
  assert.match(out, /2 executed and passed/, out);
  // The old aggregator used `FAILED=()` with `set -u`, and on bash 3.2 — /bin/bash on every macOS —
  // `${#FAILED[@]}` on an EMPTY array is an unbound-variable error. So THIS path, the only one that
  // says "safe to push", was the one path that had never run on the CEO's Mac. If this test ever
  // fails with "unbound variable", arrays have come back.
  assert.doesNotMatch(out, /unbound variable/, `the clean path must not depend on array expansion\n${out}`);
});

test('a step that DID NOT EXECUTE is INCOMPLETE, never a pass', () => {
  const { out, code } = runVerdict([
    'pf_step "alpha" true',
    'pf_step "did not run" sh -c "exit 3"',
    'pf_step "beta" true',
  ]);
  assert.match(out, /INCOMPLETE/, out);
  assert.notEqual(code, 0, `a run containing a non-executed check must NOT exit 0\n${out}`);
  assert.equal(code, 2, `non-execution is its own exit code\n${out}`);
  assert.match(out, /did not run/, `the verdict must NAME what did not execute\n${out}`);
  assert.match(out, /DO NOT PUSH/, out);
  assert.doesNotMatch(out, /^PASS/m, `PASS must not appear over a run that proved nothing\n${out}`);
  // And it must be counted apart from the passes, not folded in with them.
  assert.match(out, /2 executed and passed · 0 failed · 1 did not execute/, out);
});

test('a real failure is FAIL, and outranks non-execution', () => {
  const { out, code } = runVerdict([
    'pf_step "broken" sh -c "exit 1"',
    'pf_step "did not run" sh -c "exit 3"',
  ]);
  assert.match(out, /FAIL/, out);
  assert.equal(code, 1, `a disproved check exits 1\n${out}`);
  assert.match(out, /broken/, out);
  // A failure must not hide the skip. Both facts are true and the operator needs both: fixing the
  // failure would otherwise reveal an INCOMPLETE nobody had been told about.
  assert.match(out, /did not run/, `a failing run must still report what did not execute\n${out}`);
});

test('any non-zero exit code that is not 3 is a failure, not a skip', () => {
  // 2 and 127 are real exit codes a broken step produces — a missing interpreter, a crash. None of
  // them may be read as "did not execute"; only the reserved 3 means that.
  for (const rc of [2, 4, 127]) {
    const { out, code } = runVerdict([`pf_step "rc${rc}" sh -c "exit ${rc}"`]);
    assert.equal(code, 1, `exit ${rc} must be FAIL, not INCOMPLETE\n${out}`);
    assert.doesNotMatch(out, /INCOMPLETE/, `exit ${rc} was misread as non-execution\n${out}`);
  }
});

test('MUTATION CONTROL: if the skip branch stops detecting non-execution, these tests go red', () => {
  // Reintroduce the 2026-11-03 defect in a COPY: treat exit 3 as a pass. If the assertions above
  // would survive this, they are not measuring the branch they claim to measure.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfmutate-'));
  const mutated = path.join(dir, 'verdict.sh');
  const src = fs.readFileSync(VERDICT, 'utf8');
  const needle = '  elif [ "$pf_rc" -eq "$PF_EXIT_NOT_EXECUTED" ]; then';
  assert.ok(src.includes(needle), 'the skip branch anchor is gone — this mutation would measure nothing');
  // The mutation must TAKE. A mutation that silently fails to apply is a control that proves nothing,
  // which is how two supersession controls measured nothing on 2 Nov.
  const broken = src.replace(
    new RegExp(`${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?  else\\n`),
    '  else\n',
  );
  assert.notEqual(broken, src, 'the mutation did not apply');
  assert.ok(!broken.includes(needle), 'the skip branch is still present after mutation');
  fs.writeFileSync(mutated, broken);

  const { out, code } = runVerdict(['pf_step "did not run" sh -c "exit 3"'], mutated);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  // With the branch gone, exit 3 falls through to the failure arm: still not a pass, but no longer
  // distinguishable from a real defect. That difference is the whole point of the third verdict.
  assert.doesNotMatch(out, /INCOMPLETE/,
    'the mutated aggregator still reported INCOMPLETE — the branch under test is not the one doing the work');
  assert.notEqual(code, 2, 'the mutated aggregator still produced the non-execution exit code');
});

test('MUTATION CONTROL: treating a skip as a pass is detected, not tolerated', () => {
  // The harsher mutation, and the actual historical bug: count exit 3 as `ok`. The aggregator then
  // reports PASS over a run that executed nothing — exactly what the CEO's Mac printed 31 times.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfmutate2-'));
  const mutated = path.join(dir, 'verdict.sh');
  const src = fs.readFileSync(VERDICT, 'utf8');
  const broken = src.replace('PF_EXIT_NOT_EXECUTED=3', 'PF_EXIT_NOT_EXECUTED=999');
  assert.notEqual(broken, src, 'the mutation did not apply');
  fs.writeFileSync(mutated, broken);

  const { out, code } = runVerdict(['pf_step "did not run" sh -c "exit 3"'], mutated);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  assert.notEqual(code, 2, 'with the reserved code changed, exit 3 can no longer mean non-execution');
  assert.doesNotMatch(out, /INCOMPLETE/, out);
});

test('preflight.sh uses the shared aggregator and declares no private one', () => {
  const pf = fs.readFileSync(path.join(ROOT, 'scripts', 'preflight.sh'), 'utf8');
  assert.match(pf, /\.\s+"\$HERE\/lib\/verdict\.sh"/, 'preflight.sh does not source the tested aggregator');
  assert.match(pf, /^pf_verdict$/m, 'preflight.sh does not end in the tested verdict');
  assert.doesNotMatch(pf, /^step\s*\(\)/m, 'preflight.sh has grown a private step() again');
  assert.doesNotMatch(pf, /^FAILED=\(\)/m, 'the bash-3.2-unsafe array is back');
  // Every step must go through the aggregator. One raw invocation is a check whose verdict is lost.
  const viaAggregator = (pf.match(/^pf_step /gm) || []).length;
  assert.ok(viaAggregator >= 40, `only ${viaAggregator} steps run through the aggregator`);
  assert.equal((pf.match(/^step /gm) || []).length, 0, 'a step bypasses the aggregator');
});
