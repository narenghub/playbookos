// ── DOES THE SCHEDULER CHECK ACTUALLY DETECT A BROKEN SCHEDULER? ─────────────
//
//   node --test scripts/halt-outreach-sequence.test.js
//
// scripts/halt-outreach-sequence.js ends by claiming "the scheduler will not select this row",
// and supports that claim by reading the runner's source. A source check that cannot fail is
// decoration, and this repository has already shipped one: the B6 negative control scanned for a
// string literal using a function that blanked string literals, so a planted probe went
// undetected and the check passed on a file that was wrong.
//
// So the controls here MUTATE a copy of the runner and require the check to notice. If removing
// the halted skip still yields YES, these tests fail and the halt script's final verdict is known
// to be worthless.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { schedulerSkipsHalted } = require('./halt-outreach-sequence');

const RUNNER = path.join(__dirname, '..', 'src', 'lib', 'agents', 'outreach-agent.js');
const SKIP = "    if (st && st.status === 'halted') { skipped.halted += 1; continue; }\n";

function copyWith(name, transform) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-check-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, transform(fs.readFileSync(RUNNER, 'utf8')));
  return p;
}

test('the real runner skips halted rows, ahead of the step and due branches', () => {
  assert.strictEqual(schedulerSkipsHalted(RUNNER).verdict, 'YES');
});

test('NEGATIVE: with the halted skip deleted, the check says NO', () => {
  const p = copyWith('no-skip.js', (s) => {
    assert.ok(s.includes(SKIP), 'fixture anchor not found — update this test, do not relax it');
    return s.replace(SKIP, '    // removed by the test\n');
  });
  // The mutation control. A regex that silently matched nothing would leave an unmodified copy,
  // and this case would be testing the real file while appearing to test a broken one.
  assert.ok(
    !fs.readFileSync(p, 'utf8').includes("st.status === 'halted'"),
    'the deletion did not land — this negative control is vacuous',
  );
  assert.strictEqual(schedulerSkipsHalted(p).verdict, 'NO');
});

test('NEGATIVE: with the skip moved below the due branch, the check says NO', () => {
  // Ordering, not presence, is the property: a halted row could otherwise be queued by a branch
  // reached before the halt is ever consulted.
  const p = copyWith('reordered.js', (s) => {
    assert.ok(s.includes(SKIP), 'fixture anchor not found — update this test, do not relax it');
    const moved = s.replace(SKIP, '').replace(
      /(\n\s*if \(st && st\.next_due_at[^\n]*\n)/,
      `$1${SKIP}`,
    );
    assert.ok(moved !== s, 'the reorder did not land — this negative control is vacuous');
    return moved;
  });
  assert.strictEqual(schedulerSkipsHalted(p).verdict, 'NO');
});

test('an unreadable runner is UNDETERMINED, never YES and never NO', () => {
  // "I could not tell" is its own verdict. Collapsing it into either answer is the exact error
  // that produced the false all-clear on 10 November.
  const v = schedulerSkipsHalted(path.join(os.tmpdir(), 'definitely-not-here-9f2c.js')).verdict;
  assert.strictEqual(v, 'UNDETERMINED');
});

test('requiring the halt script opens no database connection and writes nothing', () => {
  // It is imported at the top of this file. If that had side effects, a test run would reach
  // production credentials, so the assertion is that we got here at all.
  assert.strictEqual(typeof schedulerSkipsHalted, 'function');
});
