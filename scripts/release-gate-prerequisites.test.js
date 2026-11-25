// ── CAN THE RELEASE GATE SAY YES? (Decision 5, 2026-11-25) ──────────────────
//
// `check-release-blockers.js --releasing` currently refuses, and it should: 1 open blocker and 23
// unsatisfied prerequisites. But a gate that refuses EVERYTHING is indistinguishable from a gate
// that works, and the refusal would prove nothing. So this exercises the prerequisite evaluator
// against a registry built per case — satisfied and unsatisfied — so that every verdict it can
// reach is shown to be reachable.
//
// It runs the real script as a child process against a temporary ROOT, because the thing under test
// is the script's exit code and the paths it resolves, not a function it happens to export.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REAL_ROOT = path.join(__dirname, '..');

/**
 * Build a throwaway tree that looks enough like the repo for the gate: docs/security/,
 * scripts/preflight.sh, scripts/check-release-blockers.js (copied), plus any checker files a case
 * wants to exist.
 */
function sandbox({ registry, preflight = '', checkers = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relgate-'));
  fs.mkdirSync(path.join(root, 'docs', 'security'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'security', 'release-blockers.json'),
    JSON.stringify(registry, null, 2));
  fs.writeFileSync(path.join(root, 'scripts', 'preflight.sh'), preflight);
  for (const c of checkers) {
    const abs = path.join(root, c);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// a checker that exists\n');
  }
  fs.copyFileSync(path.join(REAL_ROOT, 'scripts', 'check-release-blockers.js'),
    path.join(root, 'scripts', 'check-release-blockers.js'));
  return root;
}

function run(root, args = []) {
  try {
    const stdout = execFileSync(process.execPath,
      [path.join(root, 'scripts', 'check-release-blockers.js'), ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const EMPTY_GROUPS = {
  blockers: [],
  communication_release_prerequisites: { items: [] },
  restoration_prerequisites: { items: [] },
};

test('the gate CAN pass: no blockers and every prerequisite satisfied', () => {
  const root = sandbox({
    registry: {
      blockers: [],
      communication_release_prerequisites: {
        items: [{ id: 'X1', title: 'verified by a wired checker',
          verified_by: { checker: 'scripts/check-x1.js' } }],
      },
      restoration_prerequisites: {
        items: [{ id: 'X2', title: 'verified by an attestation',
          verified_by: { attestation: { actor: 'naren', date: '2026-11-25', scope: 'production restore' } } }],
      },
    },
    preflight: 'pf_step "x1" node scripts/check-x1.js\n',
    checkers: ['scripts/check-x1.js'],
  });
  const r = run(root, ['--releasing']);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.code, 0, `the gate refused a fully satisfied registry:\n${r.out}`);
  assert.match(r.out, /every prerequisite is satisfied/);
});

test('a checker that does not exist does NOT satisfy a prerequisite', () => {
  const root = sandbox({
    registry: {
      ...EMPTY_GROUPS,
      communication_release_prerequisites: {
        items: [{ id: 'X1', title: 'names a missing file',
          verified_by: { checker: 'scripts/check-absent.js' } }],
      },
    },
    preflight: 'pf_step "x" node scripts/check-absent.js\n',
  });
  const r = run(root, ['--releasing']);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /which does not exist/);
});

test('a checker that exists but is NOT wired into preflight does not satisfy it either', () => {
  const root = sandbox({
    registry: {
      ...EMPTY_GROUPS,
      communication_release_prerequisites: {
        items: [{ id: 'X1', title: 'exists, never runs',
          verified_by: { checker: 'scripts/check-orphan.js' } }],
      },
    },
    preflight: '# preflight that never mentions it\n',
    checkers: ['scripts/check-orphan.js'],
  });
  const r = run(root, ['--releasing']);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /NOT wired into preflight/);
  assert.match(r.out, /documentation with a filename/);
});

test('a PARTIAL checker blocks, and says what is missing', () => {
  const root = sandbox({
    registry: {
      ...EMPTY_GROUPS,
      communication_release_prerequisites: {
        items: [{ id: 'X1', title: 'tripwire only',
          verified_by: { checker: 'scripts/check-x1.js', partial: 'the call-site migration is undone' } }],
      },
    },
    preflight: 'pf_step "x1" node scripts/check-x1.js\n',
    checkers: ['scripts/check-x1.js'],
  });
  const r = run(root, ['--releasing']);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /PARTIAL — the call-site migration is undone/);
});

test('an attestation missing actor, date or scope does not satisfy it', () => {
  for (const partialAttestation of [
    { date: '2026-11-25', scope: 's' },
    { actor: 'naren', scope: 's' },
    { actor: 'naren', date: '2026-11-25' },
  ]) {
    const root = sandbox({
      registry: {
        ...EMPTY_GROUPS,
        restoration_prerequisites: {
          items: [{ id: 'X2', title: 'half-attested',
            verified_by: { attestation: partialAttestation } }],
        },
      },
    });
    const r = run(root, ['--releasing']);
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, JSON.stringify(partialAttestation));
    assert.match(r.out, /attested without/);
  }
});

test('a MISSING prerequisite list blocks — an absent list is not an empty one', () => {
  const root = sandbox({
    registry: { blockers: [], communication_release_prerequisites: { items: [] } },
  });
  const r = run(root, ['--releasing']);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /restoration prerequisite list is missing/);
  assert.match(r.out, /an absent list is not an empty one/);
});

test('bare mode REPORTS and exits 0 even while everything is unsatisfied', () => {
  const root = sandbox({
    registry: {
      ...EMPTY_GROUPS,
      restoration_prerequisites: { items: [{ id: 'X', title: 'unmeasured', verified_by: null }] },
    },
  });
  const r = run(root, []);
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(r.code, 0, 'bare mode is a push gate and must not fail the branch');
  assert.match(r.out, /this is a push gate, not a release gate/);
});

test('the REAL registry names B7.18, B7.22 and B7.24 in BOTH lists, per Decision 5', () => {
  const doc = JSON.parse(fs.readFileSync(
    path.join(REAL_ROOT, 'docs', 'security', 'release-blockers.json'), 'utf8'));
  const comm = doc.communication_release_prerequisites.items.map((i) => i.id);
  const rest = doc.restoration_prerequisites.items.map((i) => i.id);
  for (const id of ['B7.18', 'B7.22', 'B7.24']) {
    assert.ok(comm.includes(id), `${id} is missing from the communication release prerequisites`);
    assert.ok(rest.includes(id), `${id} is missing from the restoration prerequisites`);
  }
  // And the real gate must currently REFUSE, because these are open. If this ever passes, either
  // the work is done or the registry has been emptied — and the test above proves the gate can
  // tell those apart.
  const r = run(REAL_ROOT, ['--releasing']);
  assert.equal(r.code, 1, 'the real gate should refuse while these prerequisites are unmeasured');
});
