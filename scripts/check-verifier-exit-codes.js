#!/usr/bin/env node
'use strict';
// ── DOES A FAILING VERIFIER ACTUALLY EXIT NON-ZERO? ─────────────────────────
//
// On 2026-11-06 `scripts/verify-prod-dashboard.js` printed
//
//     FAIL  login failed with 401
//
// and exited **0**.
//
// The RESULT block that computed the exit code sat at the end of main(), and main() had five early
// `return` statements for exactly the failures that matter most — /health unreachable, login
// rejected, no token. Each one resolved the promise and skipped the exit. CLAUDE.md's first rule is
// that a checker's verdict IS its exit status, because output can be filtered, tailed and skimmed
// and a number cannot. Here the output said FAIL and the number said PASS.
//
// That is the 2026-09-30 defect reproduced inside the scripts written to catch it, and
// `verify-migration-v2-on-restore.js` had the same latent shape — it only ever exited 1 because the
// failures it happened to hit fell through instead of returning early.
//
// ── WHY THIS IS A RUNTIME CHECK AND NOT A GREP ──────────────────────────────
//
// A static scan for `bad(...)` followed by a bare `return` would be guessing at control flow, and
// the predicate would need widening every time a script was restructured until it stopped firing.
// This RUNS each verifier down a path that must fail and reads the exit code. It cannot be fooled
// by how the code is arranged, which is the entire point.
//
// Each case is chosen so the failure happens EARLY, on a `return` path, with no network and no
// database: a file that exists but is not a dump. That is the shape that produced the false green.
//
// Exit: 0 every verifier's failure path exits non-zero · 1 one of them reports a false pass
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 300)}`); };

console.log('\nVERIFIER EXIT CODES — a reported failure must be a non-zero exit\n');

// A file that exists, is readable, and is definitively not a PostgreSQL dump. The scripts under
// test get past their "file not found" guard and fail on the restore, which is an early-return
// path in every one of them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-exit-'));
const notADump = path.join(tmp, 'definitely-not-a.dump');
fs.writeFileSync(notADump, 'this is not a pg_dump archive, it is a sentence\n');

/** Run a script and return { code, out }. A non-zero exit is the expected result here. */
function run(script, args, env) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, script), ...args], {
      env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const CASES = [
  {
    script: 'verify-restore.js',
    args: [notADump],
    env: {},
    why: 'a file that is not a dump must fail the restore',
  },
  {
    script: 'verify-migration-v2-on-restore.js',
    args: [notADump],
    env: {},
    why: 'a file that is not a dump must fail the restore',
  },
  {
    // No network is reached: an unresolvable host fails at /health, which is the first early
    // return in that script and the one whose sibling path produced the false green.
    script: 'verify-prod-dashboard.js',
    args: ['--url', 'https://verifier-exit-check.invalid', '--email', 'nobody@example.invalid'],
    env: { PBO_PASSWORD: 'not-a-real-password', PBO_EMAIL: '' },
    why: 'an unreachable target must fail at /health',
  },
];

for (const c of CASES) {
  const r = run(c.script, c.args, c.env);
  const reportedFailure = /\bFAIL\b/.test(r.out);
  if (!reportedFailure) {
    // The case itself has stopped exercising a failure. That is not a pass — it means this check
    // is no longer testing anything, which is the vacuity trap all over again.
    bad(`${c.script} did not report a failure at all`, `${c.why}; output gave no FAIL line`);
    continue;
  }
  if (r.code === 0) {
    bad(`${c.script} printed FAIL and exited 0 — A FALSE PASS`,
      'the verdict and the exit status disagree, which is the one thing CLAUDE.md forbids');
  } else {
    ok(`${c.script} reported a failure and exited ${r.code}`);
  }
}

// Positive control for the harness: a verifier given a path that does not exist must also be
// non-zero, and must not be mistaken for the case above.
const missing = run('verify-restore.js', [path.join(tmp, 'no-such-file.dump')], {});
if (missing.code !== 0) ok(`a missing file also exits ${missing.code}`);
else bad('a missing dump file exited 0');

// And the control that keeps the harness honest: SKIP must stay distinguishable from PASS.
// verify-prod-dashboard.js with no credentials asserts nothing and must exit 3, not 0 and not 1.
const skipped = run('verify-prod-dashboard.js', ['--url', 'https://verifier-exit-check.invalid'],
  { PBO_EMAIL: '', PBO_PASSWORD: '' });
if (skipped.code === 3) ok('with no credentials it exits 3 (did not execute), not 0');
else bad(`no-credentials run exited ${skipped.code}, expected 3`,
  'a check that asserted nothing must not be reported as a pass OR as a failure');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }

console.log('');
if (fail) {
  console.log(`FAIL  ${fail} verifier(s) can report a failure and exit 0\n`);
  process.exit(1);
}
console.log('PASS  every verifier\'s failure path exits non-zero, and a skip still exits 3\n');
process.exit(0);
