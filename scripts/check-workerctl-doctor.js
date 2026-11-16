#!/usr/bin/env node
// ── THE DIAGNOSTIC MUST NOT REPORT A TOOL'S CHATTER AS A VALUE ──────────────
//
//   node scripts/check-workerctl-doctor.js; echo "EXIT=$?"
//
// Found on the first run of `workerctl doctor` on real hardware, 2026-11-15. With no plist present,
// `PlistBuddy -c Print …` writes
//
//     File Doesn't Exist, Will Create: /Users/<you>/Library/LaunchAgents/ai.playnexa.worker.plist
//
// to STDOUT — not stderr — and exits 0. The old code captured that with `2>/dev/null || true` and
// passed it to the diagnostic as BOTH the API base URL and the worker id. The diagnostic then
// reported `baseUrlConfigured: true` for a URL that was an error message, and ran a Keychain lookup
// against an account name made of English prose.
//
// Nothing crashed. That is the point: it produced a confident, detailed, wrong report. A tool that
// prints chatter on stdout and exits 0 is not a tool whose output you may assume is a value.
//
// `plist_value` is tested directly by sourcing workerctl with WORKERCTL_LIB=1, so this verifies the
// shell logic rather than inspecting it.
//
// EXIT 0 the sanitiser holds · 1 it does not

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CTL = path.join(__dirname, '..', 'installer', 'macos', 'workerctl');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 220)}`); };
const head = (m) => console.log(`\n  ── ${m} ──\n`);

/**
 * Calls plist_value with a stubbed PlistBuddy. The stub is installed at a path the function will
 * reach by overriding the function itself is not possible in shell, so instead we drive the
 * function with a fake $PLIST and a fake PlistBuddy via a wrapper that shadows /usr/libexec.
 *
 * Simpler and more faithful: we re-declare PlistBuddy as a shell function in the sourced context.
 * `plist_value` calls it by absolute path, so the test defines a function with that exact name.
 */
function plistValue({ key, shape, plistExists, stdout, exitCode = 0 }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wctl-'));
  const plist = path.join(home, 'Library', 'LaunchAgents', 'ai.playnexa.worker.plist');
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  if (plistExists) fs.writeFileSync(plist, '<plist/>');

  // A stub binary at the absolute path plist_value calls. We cannot write to /usr/libexec, so the
  // script is run with a PLIST pointing into the temp dir and PlistBuddy shadowed through a
  // function of the same absolute name — bash permits a function named with slashes when invoked
  // via a variable, so instead we patch the one line for the duration of the test.
  const src = fs.readFileSync(CTL, 'utf8');
  const stub = path.join(home, 'plistbuddy-stub');
  // The stdout bytes go to a FILE and the stub cats it. An earlier version used
  // `printf '%s' "<json>"`, which does not interpret \n — so a test for trailing-newline handling
  // actually fed a literal backslash-n and "failed" against correct code. The stub must emit the
  // exact bytes, or it is testing itself.
  const payload = path.join(home, 'plistbuddy-stdout');
  fs.writeFileSync(payload, String(stdout));
  fs.writeFileSync(stub, `#!/bin/sh\ncat ${JSON.stringify(payload)}\nexit ${exitCode}\n`);
  fs.chmodSync(stub, 0o755);

  const patched = src.replace(/\/usr\/libexec\/PlistBuddy/g, stub);
  if (patched === src) {
    bad('could not substitute PlistBuddy — its invocation has changed',
      'this check can no longer reach plist_value');
    return { out: null };
  }
  const script = path.join(home, 'workerctl-under-test');
  fs.writeFileSync(script, patched);

  const r = spawnSync('bash', ['-c',
    `WORKERCTL_LIB=1 PLIST=${JSON.stringify(plist)} . ${JSON.stringify(script)}; `
    + `PLIST=${JSON.stringify(plist)}; plist_value ${JSON.stringify(key)} ${JSON.stringify(shape)}`],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 20_000 });

  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  return { out: r.stdout === undefined ? null : r.stdout, stderr: r.stderr, status: r.status };
}

console.log('\n══ workerctl doctor: value sanitisation ══');

head('1. the exact failure seen on hardware');

const URL_SHAPE = '^https?://[A-Za-z0-9._:-]+';
const WID_SHAPE = '^wkr_[0-9a-f]{32}$';
const CHATTER = "File Doesn't Exist, Will Create: /Users/someone/Library/LaunchAgents/ai.playnexa.worker.plist";

// The real case: no plist at all. PlistBuddy is not even called now, so nothing can be captured.
const noPlist = plistValue({ key: 'WORKER_API_BASE_URL', shape: URL_SHAPE, plistExists: false, stdout: CHATTER });
if (noPlist.out === '') ok('with no plist, the URL comes back EMPTY (PlistBuddy is not called at all)');
else bad('chatter was captured as the URL', JSON.stringify(noPlist.out));

const noPlistWid = plistValue({ key: 'WORKER_ID', shape: WID_SHAPE, plistExists: false, stdout: CHATTER });
if (noPlistWid.out === '') ok('and the worker id comes back EMPTY');
else bad('chatter was captured as the worker id', JSON.stringify(noPlistWid.out));

// Belt and braces: even WITH a plist, if PlistBuddy emits that sentence it must be rejected.
const chatterAnyway = plistValue({ key: 'WORKER_API_BASE_URL', shape: URL_SHAPE, plistExists: true, stdout: CHATTER });
if (chatterAnyway.out === '') ok('and the sentence is rejected even when a plist DOES exist');
else bad('chatter passed through with a plist present', JSON.stringify(chatterAnyway.out));

head('2. a wrong-shaped value is discarded, not passed on');

for (const [name, key, shape, value] of [
  ['a URL that is not a URL', 'WORKER_API_BASE_URL', URL_SHAPE, 'not-a-url'],
  ['an ftp URL', 'WORKER_API_BASE_URL', URL_SHAPE, 'ftp://example.com'],
  ['a worker id of the wrong length', 'WORKER_ID', WID_SHAPE, 'wkr_abc'],
  ['a worker id with non-hex characters', 'WORKER_ID', WID_SHAPE, `wkr_${'z'.repeat(32)}`],
  ['a worker id missing its prefix', 'WORKER_ID', WID_SHAPE, 'a'.repeat(32)],
  ['an empty value', 'WORKER_ID', WID_SHAPE, ''],
]) {
  const r = plistValue({ key, shape, plistExists: true, stdout: value });
  if (r.out === '') ok(`${name} is discarded`);
  else bad(`${name} was passed through`, JSON.stringify(r.out));
}

head('3. a correct value still gets through');

const goodUrl = plistValue({ key: 'WORKER_API_BASE_URL', shape: URL_SHAPE, plistExists: true,
  stdout: 'https://m7-dev.up.railway.app' });
if (goodUrl.out === 'https://m7-dev.up.railway.app') {
  ok('a valid https URL is returned unchanged');
} else bad('a valid URL was lost', JSON.stringify(goodUrl.out));

const goodWid = plistValue({ key: 'WORKER_ID', shape: WID_SHAPE, plistExists: true,
  stdout: `wkr_${'a1b2'.repeat(8)}` });
if (goodWid.out === `wkr_${'a1b2'.repeat(8)}`) ok('a valid worker id is returned unchanged');
else bad('a valid worker id was lost', JSON.stringify(goodWid.out));

// Trailing whitespace and a newline are what PlistBuddy actually emits around a real value.
const padded = plistValue({ key: 'WORKER_ID', shape: WID_SHAPE, plistExists: true,
  stdout: `  wkr_${'a1b2'.repeat(8)}  \n` });
if (padded.out === `wkr_${'a1b2'.repeat(8)}`) ok('surrounding whitespace and newline are trimmed');
else bad('a padded value was not trimmed', JSON.stringify(padded.out));

const crlf = plistValue({ key: 'WORKER_ID', shape: WID_SHAPE, plistExists: true,
  stdout: `wkr_${'a1b2'.repeat(8)}\r\n` });
if (crlf.out === `wkr_${'a1b2'.repeat(8)}`) ok('a carriage return is stripped');
else bad('CRLF was not handled', JSON.stringify(crlf.out));

head('4. a non-zero exit yields nothing, whatever it printed');

const failed = plistValue({ key: 'WORKER_ID', shape: WID_SHAPE, plistExists: true,
  stdout: `wkr_${'a1b2'.repeat(8)}`, exitCode: 1 });
if (failed.out === '') ok('a failing PlistBuddy yields no value even when it printed one');
else bad('a value was taken from a failed call', JSON.stringify(failed.out));

console.log();
if (fail) {
  console.log(`FAIL  ${fail} sanitisation problem(s). workerctl doctor can report a tool's`);
  console.log('      chatter as a configured value.');
  process.exit(1);
}
console.log('PASS  workerctl doctor discards PlistBuddy chatter, wrong-shaped values and the output');
console.log('      of a failed call, and passes a correct value through unchanged. The failure this');
console.log('      locks down was found on real hardware and reported nothing as broken — it just');
console.log('      answered confidently and wrongly.');
process.exit(0);
