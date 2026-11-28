// ── THE iMac MONITOR CANNOT ACQUIRE A CREDENTIAL (E) ────────────────────────
//
// Owner's approval of 2026-11-27: *"Use read-only, development-scoped access."* And, in the
// directive that approved the monitoring, *"Do not require me to distribute DATABASE_URL to another
// machine."*
//
// A monitor that merely HAPPENS not to read a credential today satisfies that sentence and not its
// purpose. So the property asserted here is a property of the file's SHAPE: the sampler requires no
// database client, no mailer and no `DATABASE_URL`, so acquiring any of them means ADDING a
// dependency — a reviewable change rather than a configuration one. Same reasoning as
// `monitor-has-no-transport.test.js`, which is the sibling this follows.
//
// ── COMMENTS AND STRING LITERALS ARE BLANKED BEFORE THE SCAN ────────────────
//
// The sampler's own prose explains at length why it does NOT read `DATABASE_URL`, and names the
// variable three times doing so. A scan of raw text would therefore fail on the documentation that
// exists to justify the property — and, worse, a scan that skipped those lines by a line-shaped
// filter would report a clean file for the wrong reason. (That happened once while writing this:
// a `grep -v '^\s*[0-9]+://'` intended to drop URLs dropped every numbered comment line instead,
// and reported zero matches in a file with three.) So the stripping is explicit and is itself
// checked by a negative control below.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'imac-continuity-sampler.js');

// Lifted from `monitor-has-no-transport.test.js` rather than written afresh, so the two scanners
// cannot disagree about what counts as code. Its one known limitation, found the hard way while
// writing this file: it treats `//` as a comment unless preceded by a colon, so a regex literal
// written `/^https:\/\//` truncates the line it is on. The sampler therefore uses
// `startsWith('https://')` instead, and the last assertion in this file is what catches a
// regression — a mis-lexed file loses the production refusal, and that assertion fails.
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""');
}

test('the file exists and is parseable', () => {
  assert.ok(fs.existsSync(FILE), `${FILE} is missing`);
  // Parsed rather than merely read: a file that does not compile cannot be said to hold or not hold
  // a dependency.
  assert.doesNotThrow(() => new (require('node:vm').Script)(
    `(function(){${fs.readFileSync(FILE, 'utf8').replace(/^#!.*\n/, '')}})`,
  ));
});

test('the stripper actually removes comments — negative control', () => {
  const stripped = stripCommentsAndStrings("const a = 1; // DATABASE_URL\nconst b = 'DATABASE_URL';");
  assert.ok(!/DATABASE_URL/.test(stripped),
    'the stripper left a commented or quoted occurrence behind, so every assertion below would be '
    + 'measuring the wrong text');
  // And the converse: it must NOT remove real code, or the assertions would pass vacuously.
  assert.match(stripCommentsAndStrings('require("pg")'), /require/);
});

test('the sampler documents why it holds no DATABASE_URL — in comments', () => {
  const raw = fs.readFileSync(FILE, 'utf8');
  assert.ok(/DATABASE_URL/.test(raw),
    'the sampler should EXPLAIN why it does not read DATABASE_URL; a file silent about the '
    + 'constraint invites the next person to add one');
});

test('no DATABASE_URL, no database client, no transport in executable code', () => {
  const code = stripCommentsAndStrings(fs.readFileSync(FILE, 'utf8'));

  assert.ok(!/\bDATABASE_URL\b/.test(code),
    'the iMac sampler must not read DATABASE_URL: the owner forbade distributing it to another '
    + 'machine, and the development database has no public address to reach anyway');

  for (const bad of [/require\(\s*['"]pg['"]\s*\)/, /\bnew\s+Pool\b/, /\bnew\s+Client\b/]) {
    assert.ok(!bad.test(code), `the sampler must hold no database client (matched ${bad})`);
  }

  for (const bad of [/mailer/i, /nodemailer/i, /\bresend\b/i, /sendMail/]) {
    assert.ok(!bad.test(code), `the sampler must hold no transport (matched ${bad})`);
  }
});

test('its requires are limited to the node standard library', () => {
  const raw = fs.readFileSync(FILE, 'utf8');
  const mods = [...raw.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'expected at least one require, so this assertion is not vacuous');
  for (const m of mods) {
    assert.ok(m.startsWith('node:'),
      `the sampler requires ${m}; it must depend on the node standard library only, so that it can `
      + 'run on the office iMac with no install step and no credential');
  }
});

// ── THE MONITOR MUST NOT BE MISTAKEN FOR THE WORKER ────────────────────────
//
// `src/worker-client/run.js` answers "is a worker running on this machine?" with
// `pgrep -u <uid> -f WORKER_PROCESS_PATTERN`, where the pattern is the string
// `worker-client/run.js`. That is a substring match against the full command line of every process
// the user owns. So a monitor whose own path contained that substring would be counted as a running
// worker by the worker's own doctor — on the one machine where both run, and where the owner's
// condition is that the existing worker not be affected at all.
//
// This is the kind of coupling that is invisible until the two files sit on the same host.
test('the sampler cannot be counted as a worker process by the worker itself', () => {
  const { WORKER_PROCESS_PATTERN } = require('../src/worker-client/run.js');
  assert.equal(typeof WORKER_PROCESS_PATTERN, 'string');
  assert.ok(WORKER_PROCESS_PATTERN.length > 0);
  assert.ok(!FILE.includes(WORKER_PROCESS_PATTERN),
    `the sampler's path ${FILE} contains ${WORKER_PROCESS_PATTERN}, so the worker's own liveness `
    + 'check would count this monitor as a worker');
});

test('it refuses a production api host', () => {
  const code = stripCommentsAndStrings(fs.readFileSync(FILE, 'utf8'));
  assert.match(code, /playbookos-production/,
    'the refusal must be in executable code, not only described in a comment');
});
