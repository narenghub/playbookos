// ── NO SEND MAY DROP ITS RESULT ──────────────────────────────────────────────
//
//   node --test scripts/email-result-handled.test.js
//
// sendEmail returns FALSE on failure and deliberately does not throw (src/lib/mailer.js). That is
// a reasonable local decision — a refused message should not crash a cron mid-way through work it
// has already done — and it has one consequence that must be enforced everywhere: a caller that
// ignores the return value cannot tell a delivered message from a refused one.
//
// ── WHY THIS IS A TEST AND NOT A CODE REVIEW NOTE ────────────────────────────
//
// 1,113 emails were lost over eight weeks. The post-mortem in mailer.js puts it exactly: "every
// layer did the right local thing (return false, log the row, do not crash the caller) and the
// aggregate was silence."
//
// Two of these were found and fixed on 2026-10-27, including the ALERT path itself — the one
// whose entire job is to break silence. Seventeen remained. A written rule did not stop the
// count growing; a failing test will.
//
// ── WHAT COUNTS AS HANDLING IT ───────────────────────────────────────────────
//
// Assigning it, testing it, returning it, passing it onward — or calling sendEmailOrReport,
// which exists precisely so a caller that has nothing useful to do with the boolean still cannot
// fail silently: it logs [EMAIL FAIL] with the recipient, the subject, the provider's reason and
// the phase it reached. What does not count is a bare `await sendEmail(...)` as its own
// statement, which is the only shape this refuses.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

// Comments necessarily discuss the forbidden shape — this file's own subject is that shape, and
// mailer.js and cron-alerts.js explain it at length. Scanning them would fail on the prose
// describing the rule, which has broken five source-reading tests in this repository already.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

test('every sendEmail call does something with its result', () => {
  const offenders = [];

  for (const file of walk(ROOT)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const lines = code.split('\n');
    lines.forEach((line, i) => {
      // The forbidden shape: `await sendEmail(` beginning a statement, with nothing receiving it.
      // `const ok = await sendEmail(`, `if (await sendEmail(`, `return await sendEmail(` and
      // `results.push(await sendEmail(` all have something to the left of the await and pass.
      if (!/\bawait\s+sendEmail\s*\(/.test(line)) return;
      const before = line.slice(0, line.indexOf('await'));
      const handled = /[=({[,]\s*$/.test(before.trim() + ' ') || /\breturn\b/.test(before);
      if (!handled) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }

  assert.deepStrictEqual(offenders, [],
    `${offenders.length} send(s) drop the result, so a refused message is indistinguishable from `
    + `a delivered one. Use sendEmailOrReport(opts, context) unless the boolean is genuinely `
    + `needed:\n  ${offenders.join('\n  ')}`);
});

test('the reporting wrapper exists and returns the boolean', () => {
  // The fix for all seventeen call sites rests on this function. If it is removed or stops
  // returning the result, every one of them silently reverts to the behaviour this file forbids.
  const mailer = require('../src/lib/mailer');
  assert.strictEqual(typeof mailer.sendEmailOrReport, 'function',
    'sendEmailOrReport is gone — the seventeen call sites now report nothing');

  const src = stripComments(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8'));
  const body = src.slice(src.indexOf('async function sendEmailOrReport'));
  assert.match(body.slice(0, 700), /EMAIL FAIL/, 'the wrapper no longer logs a findable failure');
  assert.match(body.slice(0, 700), /return r\.ok/, 'the wrapper no longer returns the result');
});

test('the rule is reachable — the scanner actually reads source', () => {
  // A scanner whose walk is broken reports zero offenders and passes forever. This asserts it is
  // genuinely looking at the files that contain the calls.
  const files = walk(ROOT);
  assert.ok(files.length > 50, `the walk found only ${files.length} files`);
  const withSends = files.filter((f) => /\bsendEmail\s*\(/.test(stripComments(fs.readFileSync(f, 'utf8'))));
  assert.ok(withSends.length > 3,
    `only ${withSends.length} file(s) appear to send email — the scanner is probably not working`);
});

test('a bare send is detected when one is synthesised', () => {
  // Negative control. The assertion above passing means nothing unless it would fail on a real
  // offender, and the only honest way to know is to feed it one.
  const sample = [
    'async function f() {',
    '  await sendEmail({ to: "x", subject: "y" });',
    '  const ok = await sendEmail({ to: "a" });',
    '  if (await sendEmail({ to: "b" })) return;',
    '  return await sendEmail({ to: "c" });',
    '}',
  ].join('\n');

  const bare = [];
  sample.split('\n').forEach((line, i) => {
    if (!/\bawait\s+sendEmail\s*\(/.test(line)) return;
    const before = line.slice(0, line.indexOf('await'));
    const handled = /[=({[,]\s*$/.test(before.trim() + ' ') || /\breturn\b/.test(before);
    if (!handled) bare.push(i + 1);
  });

  assert.deepStrictEqual(bare, [2], `expected only line 2 to be bare, got ${JSON.stringify(bare)}`);
});
