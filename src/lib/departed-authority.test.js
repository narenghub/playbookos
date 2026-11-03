// ── NO DEPARTED PERSON MAY BE LIVE AUTHORITY ────────────────────────────────
//
//   node --test src/lib/departed-authority.test.js
//
// Palash Das left Abiozen. On 3 Nov 2026 the weekly procurement cron was found still sending
// supplier RFQs from, signed by, and reply-to his address — and the mechanism was worse than a
// stale constant:
//
//     SELECT ... WHERE role='procurement_director' AND is_active=1 ...
//     )).rows[0] || { name: 'Palash Das', email: 'palash@abiozen.com', id: null };
//
// The query filtered on `is_active=1`, so DEACTIVATING HIM MADE THE HARDCODED IDENTITY MORE LIKELY
// TO BE USED, not less. Removing someone from the organization selected the fallback. Nothing
// failed, nothing warned, and the only thing preventing delivery was that `abiozen.com` was
// unauthorized in Resend — a provider rejection, which is not a control.
//
// A second instance bound ownership to his NAME and preferred it over the role:
//
//     WHERE is_active=1 AND (LOWER(name) LIKE '%palash%' OR role='procurement')
//     ORDER BY (LOWER(name) LIKE '%palash%') DESC
//
// A third put him in the CC of quotations sent to CUSTOMERS. A fourth instructed the briefing model
// to assign him as an action owner. A fifth seeded him as an execution-step owner on every boot.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
//   Palash may exist in HISTORY. He must not exist as LIVE AUTHORITY.
//
// So this test does NOT ban the string. Banning it would delete the evidence — the comments that
// record what happened, the fixtures that reproduce it, the incident documentation. It bans the
// string in the places that can EXECUTE: a live code line that could make him a sender, signatory,
// reply-to, recipient, owner, escalation target, prompt identity or fallback.
//
// WHY A SWEEP AND NOT A LIST OF FIXES. The five instances were in five different files found by
// grepping for a name. Nothing stopped a sixth. This fails the build instead.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// People who have left and must not be resolvable as live authority. Adding a name here is the
// one step required when somebody departs, and the suite then proves no live path can name them.
const DEPARTED = [
  { name: 'Palash Das', patterns: [/palash/i] },
];

// Executable surfaces. Deliberately NOT the whole repo: tests, fixtures, validators, docs and
// migration scripts legitimately contain history, and sanitizing them would destroy the record.
const LIVE_DIRS = [
  path.join('src', 'lib', 'agents'),
  path.join('src', 'lib'),
  path.join('src', 'api'),
];
const LIVE_FILES = [path.join('public', 'index.html'), 'server.js'];

// A line is EVIDENCE rather than execution when it cannot run: a comment, or a string that exists
// to assert about history. Everything else that names a departed person is a finding.
function isCommentOrDoc(line, ext) {
  const t = line.trim();
  if (ext === '.html') {
    // Only a whole-line HTML comment counts; an inline one could hide live markup after it.
    return t.startsWith('<!--') && t.endsWith('-->');
  }
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--');
}

function collect(dir, out, recurse) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (recurse) collect(full, out, recurse); continue; }
    if (!/\.(js|html)$/.test(e.name)) continue;
    if (e.name.endsWith('.test.js')) continue;          // fixtures preserve history by design
    out.push(full);
  }
}

function liveFiles() {
  const out = [];
  for (const d of LIVE_DIRS) collect(path.join(ROOT, d), out, d.endsWith('agents'));
  for (const f of LIVE_FILES) out.push(path.join(ROOT, f));
  return [...new Set(out)];
}

test('no departed person appears on an executable line in live code', () => {
  const findings = [];
  let scanned = 0;
  for (const file of liveFiles()) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    scanned++;
    const ext = path.extname(file);
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const person of DEPARTED) {
        if (!person.patterns.some((re) => re.test(lines[i]))) continue;
        if (isCommentOrDoc(lines[i], ext)) continue;
        findings.push(`${path.relative(ROOT, file)}:${i + 1}\n      ${lines[i].trim().slice(0, 150)}`);
      }
    }
  }

  // Non-vacuity: if the file list collapses (a refactor, a bad join) this test would pass by
  // reading nothing at all — the failure mode of every grep-based check.
  assert.ok(scanned >= 15, `the sweep scanned only ${scanned} live files — it has stopped working`);

  assert.deepEqual(findings, [],
    `\n${findings.length} executable line(s) name a departed person.\n\n`
    + 'A departed person may appear in comments, tests, fixtures and documentation — that is the\n'
    + 'historical record and must be preserved. They may NOT appear on a line that runs, because\n'
    + 'such a line can make them a sender, signatory, reply-to, recipient, owner, escalation\n'
    + 'target, prompt identity or fallback.\n\n'
    + 'Resolve the person from the organizational record instead, and FAIL CLOSED when nobody\n'
    + 'holds the role. Do not substitute a different hardcoded human.\n\n'
    + findings.join('\n'));
});

test('the sweep actually detects a planted executable occurrence', () => {
  // The negative control. Without it, the test above passes for a comment-only repository and
  // would keep passing if isCommentOrDoc were widened until nothing was ever a finding.
  const planted = [
    `const sender = 'palash@abiozen.com';`,
    `  to: 'Palash Das <palash@abiozen.com>',`,
    `  cc: ['palash@abiozen.com'],`,
  ];
  for (const line of planted) {
    assert.ok(!isCommentOrDoc(line, '.js'),
      `a planted executable line was classified as a comment: ${line}`);
    assert.ok(DEPARTED[0].patterns.some((re) => re.test(line)),
      `the pattern did not match a planted occurrence: ${line}`);
  }
  // And prose genuinely is treated as evidence.
  for (const line of [
    `// it was \`palash@abiozen.com\` until a Procurement Director left`,
    `   * Palash Das was the original signatory`,
    `<!-- queued for Palash -->`,
  ]) {
    const ext = line.trim().startsWith('<!--') ? '.html' : '.js';
    assert.ok(isCommentOrDoc(line, ext), `a comment was treated as executable: ${line}`);
  }
});

test('an inline HTML comment does not hide live markup after it', () => {
  // `<!-- x --> <div onclick="send('palash@abiozen.com')">` must NOT be excused. The HTML branch
  // requires the whole line to be a comment for exactly this reason.
  const sneaky = `<!-- note --> <div onclick="send('palash@abiozen.com')"></div>`;
  assert.ok(!isCommentOrDoc(sneaky, '.html'),
    'an inline HTML comment excused the live markup following it');
});
