// ── THE SCRIPT MUST REFUSE A FLAG IT DOES NOT KNOW ───────────────────────────
//
// Why this test exists. On 27 Oct the deployed copy of verify-rotation.js predated the --snapshot
// flag. Asked for --snapshot=/tmp/fp.json, it matched nothing, fell through to its default mode and
// printed a fifty-line credential report — exit 0, no snapshot written, nothing to say the flag had
// been ignored. Two commands wasted and a fingerprint table disclosed twice, on output that looked
// like success.
//
// The guard is three lines. The value is entirely in it being exercised, so this spawns the real
// script rather than importing anything: the bug was in argument handling at process start, which is
// the one part an import cannot reach.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'verify-rotation.js');

const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8',
  env: { ...process.env, ...env },
  timeout: 20000,
});

test('an unrecognised flag exits non-zero instead of falling through to a default mode', () => {
  for (const bad of ['--snapshtot=/tmp/x.json', '--old=/tmp/secrets.json', '--verbose', '--compair=/tmp/x']) {
    const r = run([bad]);
    assert.notStrictEqual(r.status, 0, `${bad} must not exit 0 — that is the silent fall-through`);
    assert.match(r.stderr, /unrecognised argument/i, `${bad} must say so on stderr`);
    // The decisive assertion: the fall-through printed the credential inventory. Nothing resembling
    // that table may appear when the arguments were not understood.
    assert.doesNotMatch(
      `${r.stdout}${r.stderr}`,
      /DATABASE_URL|ADMIN_PASSWORD|credential inventory/,
      `${bad} must not print the credential list after refusing the argument`,
    );
  }
});

test('--old= is refused by name, because it is the flag the first version had', () => {
  // Not merely unknown: the superseded interface took the live leaked secrets in a file. Someone
  // following an old runbook must get an error, not a report built from a file of real credentials.
  const r = run(['--old=/tmp/whatever.json']);
  assert.strictEqual(r.status, 2);
});

test('two modes at once is refused rather than one silently winning', () => {
  const r = run(['--health', `--snapshot=${path.join(os.tmpdir(), 'nope.json')}`]);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /pick one/i);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'nope.json')), 'must not write a snapshot');
});

test('--snapshot writes a file, prints no fingerprint, and contains no secret value', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vr-')), 'fp.json');
  const SECRET = 'postgresql://u:a-very-distinctive-password-9f3b@h:5432/db';
  const r = run([`--snapshot=${out}`], { DATABASE_URL: SECRET, ADMIN_PASSWORD: 'another-distinctive-7c1a' });

  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(out), 'the snapshot file must exist — its absence was the original defect');

  const printed = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(printed, /a-very-distinctive-password-9f3b|another-distinctive-7c1a/,
    'a secret value must never reach stdout');
  // No bare 12-hex token in the output: that was the fingerprint column, which is a confirmation
  // oracle against a wordlist for a human-chosen password.
  assert.doesNotMatch(printed, /\b[0-9a-f]{12}\b/,
    'no fingerprint may be printed, in any mode');

  const saved = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(saved, /a-very-distinctive-password-9f3b|another-distinctive-7c1a/,
    'the snapshot file must hold digests, never values');
  const parsed = JSON.parse(saved);
  assert.ok(parsed.salt && parsed.fingerprints.DATABASE_URL, 'salt and digests recorded');
  assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600, 'snapshot must be owner-read-only');

  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('every run announces the commit it is running from', () => {
  // The flag guard could not have caught the 27 Oct failure on its own: the OLD file was what ran,
  // and no edit reaches an undeployed file. The commit line is what makes a stale deploy visible.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vr-')), 'fp.json');
  const r = run([`--snapshot=${out}`], { RAILWAY_GIT_COMMIT_SHA: 'abc1234deadbeef', DATABASE_URL: 'x' });
  assert.match(r.stdout, /running from commit abc1234/, 'the commit must appear in the output itself');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});

test('a changed value compares as CHANGED and an unchanged one as UNCHANGED', () => {
  // The guards above are about arguments. This is the actual claim the script makes, and it is worth
  // one direct check: a rotated credential must read CHANGED and a forgotten one must fail the run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-'));
  const out = path.join(dir, 'fp.json');
  // The three credentials marked required-but-not-rotating must be present or --compare fails the
  // run on their absence, which is correct in production and merely noise in a fixture.
  const REQUIRED = { JWT_SECRET: 'j', ANTHROPIC_API_KEY: 'a', RESEND_API_KEY: 'r' };
  const before = {
    ...REQUIRED,
    DATABASE_URL: 'postgresql://u:old@h:5432/db',
    ADMIN_PASSWORD: 'old-admin',
    TRIGGERS_SECRET: 'old-trig',
    PLAYBOOKOS_WEBHOOK_SECRET: 'old-hook',
    ENGAGEMENT_SECRET: 'old-eng',
  };
  assert.strictEqual(run([`--snapshot=${out}`], before).status, 0);

  // All five rotated → pass. The required-but-not-rotating three are left alone deliberately:
  // "unchanged" must be an acceptable verdict for them, or the script would demand rotating keys
  // this round was never about.
  const ROTATES = ['DATABASE_URL', 'ADMIN_PASSWORD', 'TRIGGERS_SECRET',
    'PLAYBOOKOS_WEBHOOK_SECRET', 'ENGAGEMENT_SECRET'];
  const rotated = { ...before };
  for (const k of ROTATES) rotated[k] = `${before[k]}-NEW`;
  const good = run([`--compare=${out}`], rotated);
  assert.strictEqual(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /CHANGED/);

  // One forgotten → must fail, and must name it.
  const partial = { ...rotated, ADMIN_PASSWORD: before.ADMIN_PASSWORD };
  const bad = run([`--compare=${out}`], partial);
  assert.strictEqual(bad.status, 1, 'a credential that did not rotate must fail the run');
  assert.match(bad.stdout, /ADMIN_PASSWORD\s+rotate\s+✗ UNCHANGED/);
  assert.doesNotMatch(`${bad.stdout}${bad.stderr}`, /old-admin/, 'never echo the value');

  fs.rmSync(dir, { recursive: true, force: true });
});
