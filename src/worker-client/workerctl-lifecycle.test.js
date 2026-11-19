// ── DEFECTS 7 AND 8 — THE INSTALL RACE AND THE UNVERIFIED STOP ──────────────
//
// Both were found by running the installer on the office iMac on 2026-11-18, and neither could
// have been found here, because `launchctl`, `security`, `pgrep -u` and `uname -s = Darwin` do not
// exist on the build machine. That is exactly why the installer carried a header saying it had
// never executed on Apple hardware.
//
// The answer is not "test it on a Mac" — a test that only runs on the operator's machine runs
// once. It is to put the platform behind a PATH shim, so the REAL script, unmodified, executes
// its real control flow against a launchd whose timing this file decides.
//
//   DEFECT 7  cmd_install booted out a running agent and bootstrapped immediately. launchd had
//             not finished, bootstrap failed `5: Input/output error`, and because `wrote $PLIST`
//             had already printed, the machine kept a NEW plist with NO agent loaded.
//
//   DEFECT 8  cmd_stop printed "stopped" straight after bootout, without checking anything. It
//             said "stopped" while status showed `state = SIGTERMed, pid = 5277, last exit code
//             = (never exited)`.
//
// ── WHAT MAKES THESE TESTS WORTH HAVING ─────────────────────────────────────
//
// The decisive assertion is NEGATIVE: when teardown never completes, `bootstrap` must not appear
// in the shim's call log at all. The pre-fix script would call it every time. A test that only
// checked the exit code would pass against the defect, because the old script also exited
// non-zero — it just did the damage first.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WORKERCTL = path.join(__dirname, '..', '..', 'installer', 'macos', 'workerctl');

/**
 * A fake macOS. `printLoaded` is how many further `launchctl print` calls report the label as
 * loaded before it starts reporting 113; `pgrepAlive` the same for the worker process. Timing is
 * therefore a parameter of the test rather than a property of the machine running it.
 */
function harness({
  printLoaded = 0, pgrepAlive = 0, bootstrapExit = 0, keychain = 0, admin = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workerctl-shim-'));
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'state');
  fs.mkdirSync(bin); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'print_loaded'), String(printLoaded));
  fs.writeFileSync(path.join(state, 'pgrep_alive'), String(pgrepAlive));
  const log = path.join(root, 'calls.log');
  fs.writeFileSync(log, '');

  const sh = (name, body) => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
  };

  // A countdown file, so each call can answer differently without this file knowing when the
  // script will ask.
  const countdown = (file, whenPositive, whenZero) => `
n=$(cat "${path.join(state, file)}" 2>/dev/null || echo 0)
if [ "$n" -gt 0 ]; then echo "$((n-1))" > "${path.join(state, file)}"; ${whenPositive}; fi
${whenZero}`;

  sh('uname', 'echo Darwin');
  sh('id', `case "\${1:-}" in
  -u) echo 501 ;;
  -un) echo ${admin ? 'naresh' : 'pnxworker'} ;;
  -Gn) echo "${admin ? 'staff admin' : 'staff pnxworker'}" ;;
  *) echo 501 ;;
esac`);
  // Stands in for enroll.js's interpreter. Records the LENGTH of the token it was handed, never
  // the token — the same rule the real flow follows.
  sh('node', `echo "node args=$* token_len=\${#WORKER_ENROLL_TOKEN}" >> "${log}"; exit 0`);
  sh('launchctl', `echo "launchctl $*" >> "${log}"
case "\${1:-}" in
  print) ${countdown('print_loaded',
    `printf '\\tstate = SIGTERMed\\n\\tpid = 4242\\n\\tlast exit code = (never exited)\\n'; exit 0`,
    'exit 113')} ;;
  bootout) exit 0 ;;
  bootstrap) exit ${bootstrapExit} ;;
  *) exit 0 ;;
esac`);
  sh('pgrep', `echo "pgrep $*" >> "${log}"
${countdown('pgrep_alive', 'echo 4242; exit 0', 'exit 1')}`);
  sh('security', `echo "security $*" >> "${log}"; exit ${keychain}`);
  sh('plutil', 'exit 0');
  // Real sleeps would make this suite take minutes. The loops are bounded by the countdowns and
  // by the timeout env vars, not by wall clock.
  sh('sleep', `echo "sleep $*" >> "${log}"; exit 0`);

  const exec = (args, input) => {
    const r = spawnSync('bash', [WORKERCTL, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        WORKERCTL_TEARDOWN_TIMEOUT_S: '3',
        WORKERCTL_STOP_TIMEOUT_S: '3',
      },
      encoding: 'utf8',
      ...(input === undefined ? {} : { input }),
    });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, calls: fs.readFileSync(log, 'utf8') };
  };

  const run = (...args) => exec(args);
  const runInput = (input, ...args) => exec(args, input);

  const tokenFile = (contents) => {
    const p = path.join(root, 'token.txt');
    fs.writeFileSync(p, contents, { mode: 0o600 });
    return p;
  };

  return { run, runInput, tokenFile, root, log };
}

// ── DEFECT 8: STOP MUST VERIFY ──────────────────────────────────────────────

test('stop waits for the label AND the process, then reports the pid that exited', () => {
  // Loaded for two more polls, process alive for two more polls after the initial sample.
  const { run } = harness({ printLoaded: 2, pgrepAlive: 3 });
  const r = run('stop');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^stopped \(pid\(s\) 4242 exited after \d+s\)/m, r.out);
});

test('stop FAILS when the process outlives the unloaded job', () => {
  // The label goes immediately; the process never does. Pre-fix this printed "stopped".
  const { run } = harness({ printLoaded: 0, pgrepAlive: 9999 });
  const r = run('stop');
  assert.equal(r.code, 1, 'a worker still running is not a successful stop');
  assert.match(r.out, /NOT stopped: worker process\(es\) still running/, r.out);
  assert.doesNotMatch(r.out, /^stopped/m, 'it must not also claim to have stopped');
});

test('stop FAILS when launchd never releases the label, and says what launchd reports', () => {
  const { run } = harness({ printLoaded: 9999 });
  const r = run('stop');
  assert.equal(r.code, 1);
  assert.match(r.out, /NOT stopped: launchd still holds/, r.out);
  assert.match(r.out, /state = SIGTERMed/, 'the diagnostics must quote launchctl, not paraphrase it');
});

test('stop on an idle machine says so rather than inventing a pid', () => {
  const { run } = harness({ printLoaded: 0, pgrepAlive: 0 });
  const r = run('stop');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /stopped \(nothing was running\)/, r.out);
});

// ── DEFECT 7: INSTALL MUST NOT BOOTSTRAP INTO A DOMAIN THAT STILL HOLDS THE LABEL ──

const install = (h) => h.run('install', 'https://dev.example.com', 'wkr_'.concat('a'.repeat(32)));

test('install waits out a slow teardown and only then bootstraps', () => {
  const h = harness({ printLoaded: 3 });
  const r = install(h);
  assert.equal(r.code, 0, r.out);

  const lines = r.calls.split('\n').filter(Boolean);
  const bootout = lines.findIndex((l) => l.startsWith('launchctl bootout'));
  const bootstrap = lines.findIndex((l) => l.startsWith('launchctl bootstrap'));
  assert.ok(bootout >= 0, 'a loaded agent must be booted out');
  assert.ok(bootstrap > bootout, 'bootstrap must come after bootout');

  const pollsBetween = lines
    .slice(bootout, bootstrap)
    .filter((l) => l.startsWith('launchctl print')).length;
  assert.ok(pollsBetween >= 2,
    `bootstrap must be preceded by polling until the label is gone; saw ${pollsBetween} poll(s)`);
});

test('DECISIVE: when teardown never finishes, bootstrap is NEVER attempted', () => {
  const h = harness({ printLoaded: 9999 });
  const r = install(h);
  assert.notEqual(r.code, 0, 'a stuck teardown is an install failure');
  assert.doesNotMatch(r.calls, /launchctl bootstrap/,
    'the pre-fix script bootstrapped regardless and failed with EIO — that must not happen again');
  assert.match(r.out, /launchd has not released/, r.out);
  // The plist IS written by then, and the operator has to be told, or they are left with a new
  // plist and no running agent and no idea.
  assert.match(r.out, /The new plist IS written/, r.out);
});

test('install reports a genuine bootstrap failure as itself, not as the race', () => {
  const h = harness({ printLoaded: 0, bootstrapExit: 5 });
  const r = install(h);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not the teardown race/, r.out);
  assert.match(r.out, /print-disabled/, 'it should point at the other known cause');
});

// ── CONTROLS ────────────────────────────────────────────────────────────────

test('CONTROL: with nothing loaded, install bootstraps without needing a bootout', () => {
  // If the new gate were simply blocking, this would fail — which is what makes the negative
  // assertion above mean something.
  const h = harness({ printLoaded: 0 });
  const r = install(h);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, /launchctl bootstrap/, 'the happy path must still load the agent');
  assert.match(r.out, /loaded ai\.playnexa\.worker/, r.out);
});

test('CONTROL: the Keychain check still runs, and its two outcomes differ', () => {
  const present = install(harness({ keychain: 0 }));
  assert.match(present.out, /The Keychain holds a secret for wkr_/, present.out);

  const absent = install(harness({ keychain: 44 }));
  assert.match(absent.out, /WARNING: there is NO Keychain secret/, absent.out);
});

// ── THE RENDERED PLIST: EXPLICIT ENVIRONMENT, AND ARMING THAT IS NEVER DEFAULT ──
//
// The dev worker carried `NODE_ENV=production` while talking to the development API. That is kept
// deliberately (it is node's optimization flag, and changing it would make the dev worker stop
// resembling the certified thing), so the repo's own label is a separate variable that nothing
// infers. These tests pin the part that matters: a default install can neither claim to be
// development nor arm the crash handshake.

const plistOf = (h) => fs.readFileSync(
  path.join(h.root, 'Library', 'LaunchAgents', 'ai.playnexa.worker.plist'), 'utf8',
);

test('a default install labels the worker production and arms nothing', () => {
  const h = harness({ printLoaded: 0 });
  assert.equal(install(h).code, 0);
  const plist = plistOf(h);
  assert.match(plist, /<key>PLAYNEXA_WORKER_ENV<\/key>\s*<string>production<\/string>/);
  assert.doesNotMatch(plist, /WORKER_ALLOW_CRASH_TEST/,
    'an install that was not asked to arm the crash test must not contain the key at all');
  assert.doesNotMatch(plist, /__ENV_EXTRA__|__WORKER_ENV__/, 'every placeholder must be substituted');
});

test('--env development labels it development and still arms nothing', () => {
  const h = harness({ printLoaded: 0 });
  const r = h.run('install', 'https://dev.example.com', `wkr_${'a'.repeat(32)}`, '--env', 'development');
  assert.equal(r.code, 0, r.out);
  const plist = plistOf(h);
  assert.match(plist, /<key>PLAYNEXA_WORKER_ENV<\/key>\s*<string>development<\/string>/);
  assert.doesNotMatch(plist, /WORKER_ALLOW_CRASH_TEST/, 'the environment label alone must not arm it');
  assert.match(r.out, /environment : development/, r.out);
});

test('--crash-test arms it with this worker\'s own id, not a boolean', () => {
  const h = harness({ printLoaded: 0 });
  const wid = `wkr_${'b'.repeat(32)}`;
  const r = h.run('install', 'https://dev.example.com', wid, '--env=development', '--crash-test');
  assert.equal(r.code, 0, r.out);
  const plist = plistOf(h);
  assert.match(plist, new RegExp(`<key>WORKER_ALLOW_CRASH_TEST</key>\\s*<string>${wid}</string>`),
    'arming must be per-identity so a leftover variable cannot arm a different worker');
  assert.doesNotMatch(plist, /WORKER_ALLOW_CRASH_TEST<\/key>\s*<string>(true|yes|1)<\/string>/);
  assert.match(r.out, /crash test {2}: ARMED/, r.out);
});

test('--crash-test is refused without --env development, and writes nothing', () => {
  const h = harness({ printLoaded: 0 });
  const r = h.run('install', 'https://dev.example.com', `wkr_${'c'.repeat(32)}`, '--crash-test');
  assert.notEqual(r.code, 0, 'arming a production-labelled worker must be refused');
  assert.match(r.out, /--crash-test requires --env development/, r.out);
  assert.ok(!fs.existsSync(path.join(h.root, 'Library', 'LaunchAgents', 'ai.playnexa.worker.plist')),
    'the refusal must happen before anything is written');
});

test('an unrecognised --env value is refused rather than passed through', () => {
  const h = harness({ printLoaded: 0 });
  const r = h.run('install', 'https://dev.example.com', `wkr_${'d'.repeat(32)}`, '--env', 'dev');
  assert.notEqual(r.code, 0, '"dev" is not "development"; a near-miss must not silently become one');
  assert.match(r.out, /must be exactly 'development' or 'production'/, r.out);
});

// ── GETTING THE TOKEN IN, AFTER THE CLIPBOARD COST US THREE ATTEMPTS ────────
//
// 2026-11-18: a silent `read -rs` was the only way in. zsh re-enables bracketed paste at every
// prompt, so disabling it once did nothing; one attempt delivered 112 bytes — the token plus 43
// bytes of adjacent screen text — and because the read echoes nothing, a mangled paste was
// indistinguishable from a good one until the API answered. Three attempts, one wasted token.

const TOKEN = `wet_${'a1b2c3d4'.repeat(8)}`;        // 4 + 64 = 68, the real shape

test('--token-file extracts the token by shape out of surrounding junk', () => {
  const h = harness();
  const f = h.tokenFile(`TOKEN_BEGIN\n${TOKEN}\nTOKEN_END\nexpires: 2026-11-19T00:00:00Z\n`);
  const r = h.run('enroll', 'https://dev.example.com', '--token-file', f);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, /token_len=68/, 'exactly the 68-character token must reach enroll.js');
  assert.doesNotMatch(r.out, new RegExp(TOKEN), 'and the token must not be echoed');
  assert.match(r.out, /read a 68-character token/, r.out);
});

test('--token-file with no token in it refuses, and reports a size rather than contents', () => {
  const h = harness();
  const f = h.tokenFile('Pasted the wrong thing entirely\nsome log output\n');
  const r = h.run('enroll', 'https://dev.example.com', '--token-file', f);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no enrollment token found/, r.out);
  assert.match(r.out, /byte\(s\)/, 'it should say how big the file was');
  assert.doesNotMatch(r.calls, /node args=/, 'nothing may be sent to the API');
});

test('a mangled interactive paste is refused on LENGTH, before the token is spent', () => {
  const h = harness();
  const r = h.runInput('00~wet_short\n', 'enroll', 'https://dev.example.com');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /characters; an enrollment token is 68/, r.out);
  assert.match(r.out, /the token is unspent/, r.out);
  assert.doesNotMatch(r.calls, /node args=/,
    'the whole point is that nothing reaches the API, so nothing is consumed');
});

test('CONTROL: a well-formed interactive paste still works', () => {
  const h = harness();
  const r = h.runInput(`${TOKEN}\n`, 'enroll', 'https://dev.example.com');
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, /token_len=68/);
});

test('enroll accepts its flags in any order, and an optional worker id by shape', () => {
  const h = harness();
  const f = h.tokenFile(TOKEN);
  const wid = `wkr_${'f'.repeat(32)}`;
  const r = h.run('enroll', 'https://dev.example.com', '--token-file', f, wid);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, new RegExp(`node args=.*${wid}`), 'the id must be forwarded to enroll.js');
});

// ── THE WORKER ACCOUNT MUST NOT BE AN ADMIN ─────────────────────────────────

test('install and enroll both refuse to run as a member of the admin group', () => {
  const h = harness({ admin: true });

  const i = install(h);
  assert.notEqual(i.code, 0, 'a privileged install must be refused');
  assert.match(i.out, /in the 'admin' group/, i.out);
  assert.ok(!fs.existsSync(path.join(h.root, 'Library', 'LaunchAgents', 'ai.playnexa.worker.plist')),
    'and it must refuse before writing anything');

  const e = h.run('enroll', 'https://dev.example.com', '--token-file', h.tokenFile(TOKEN));
  assert.notEqual(e.code, 0, 'a privileged enrolment must be refused too');
  assert.doesNotMatch(e.calls, /node args=/, 'no secret may be exchanged under an admin account');
});

test('CONTROL: the shim is driving the real script, not a copy of it', () => {
  const src = fs.readFileSync(WORKERCTL, 'utf8');
  assert.match(src, /^cmd_stop\(\)/m, 'the fixture must be the real installer');
  assert.match(src, /wait_for_teardown/, 'and must contain the function under test');
  assert.ok(src.length > 5_000);
});
