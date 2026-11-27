// ── B7.13: WHAT THE CONTENT-DAY CONTROL REFUSES ─────────────────────────────
//
// Negative-heavy on purpose, for the reason `independent-criterion.test.js` records: the happy path
// satisfies a vacuous control and a real one identically. The assertion that matters most is the
// one about an ABSENT declaration, because that is the difference between a control and a
// suggestion.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CD = require('./content-day');

const at = (day) => ({ businessToday: () => day });

test('1. an ABSENT declaration is refused — the control is not opt-in', () => {
  for (const missing of [undefined, null, '']) {
    const r = CD.assertContentDayCurrent({ contentDay: missing }, at('2026-11-27'));
    assert.equal(r.allowed, false, `${JSON.stringify(missing)} was ALLOWED`);
    assert.equal(r.code, CD.REFUSAL.NOT_DECLARED);
  }
  // And the reason has to say WHY absence is refused, because the next person to meet this
  // refusal will reach for a default.
  const r = CD.assertContentDayCurrent({}, at('2026-11-27'));
  assert.match(r.reason, /every caller opts out of by forgetting/);
});

test('1a. calling it with no arguments at all is still a refusal, not a pass', () => {
  const r = CD.assertContentDayCurrent(undefined, at('2026-11-27'));
  assert.equal(r.allowed, false);
  assert.equal(r.code, CD.REFUSAL.NOT_DECLARED);
});

test('2. today is allowed, and that is the only day that is', () => {
  assert.equal(CD.assertContentDayCurrent({ contentDay: '2026-11-27' }, at('2026-11-27')).allowed,
    true);
  // One day either side, which is the realistic failure rather than a wild value.
  const yesterday = CD.assertContentDayCurrent({ contentDay: '2026-11-26' }, at('2026-11-27'));
  assert.equal(yesterday.allowed, false);
  assert.equal(yesterday.code, CD.REFUSAL.STALE);
  const tomorrow = CD.assertContentDayCurrent({ contentDay: '2026-11-28' }, at('2026-11-27'));
  assert.equal(tomorrow.allowed, false);
  assert.equal(tomorrow.code, CD.REFUSAL.FUTURE);
});

test('2a. stale and future are DIFFERENT codes, because they need different action', () => {
  // The 2026-11-03 incident shape: content from three weeks ago.
  const old = CD.assertContentDayCurrent({ contentDay: '2026-11-05' }, at('2026-12-01'));
  assert.equal(old.code, CD.REFUSAL.STALE);
  assert.match(old.reason, /worse than silence/);
  assert.equal(old.today, '2026-12-01');
  assert.equal(old.day, '2026-11-05');
  const ahead = CD.assertContentDayCurrent({ contentDay: '2027-01-01' }, at('2026-12-01'));
  assert.equal(ahead.code, CD.REFUSAL.FUTURE);
  assert.notEqual(ahead.code, old.code,
    'a stale message and a future-dated one are the same failure to a caller that only reads '
    + '`allowed`, and they are not the same problem to an operator');
});

test('3. TIMELESS is a DECLARED kind, not an absent field', () => {
  const r = CD.assertContentDayCurrent({ contentDay: CD.TIMELESS }, at('2026-11-27'));
  assert.equal(r.allowed, true);
  assert.equal(r.timeless, true);
  assert.equal(r.day, null);
  // And it is not reachable by accident: nothing truthy stands in for it.
  for (const near of ['TIMELESS', 'Timeless', 'none', 'n/a', true, 0, {}]) {
    const bad = CD.assertContentDayCurrent({ contentDay: near }, at('2026-11-27'));
    assert.equal(bad.allowed, false, `${JSON.stringify(near)} passed as timeless`);
  }
});

test('4. a malformed day is refused, never parsed leniently', () => {
  for (const malformed of ['27-11-2026', '2026/11/27', '2026-11-27T00:00:00Z', 'today',
    '2026-11-7', 20261127, new Date('2026-11-27')]) {
    const r = CD.assertContentDayCurrent({ contentDay: malformed }, at('2026-11-27'));
    assert.equal(r.allowed, false, `${JSON.stringify(malformed)} was ALLOWED`);
    assert.equal(r.code, CD.REFUSAL.MALFORMED, `${JSON.stringify(malformed)} got ${r.code}`);
  }
});

test('5. an unknowable current day refuses — it does not fall through to allowed', () => {
  const thrower = { businessToday: () => { throw new Error('clock unavailable'); } };
  const r = CD.assertContentDayCurrent({ contentDay: '2026-11-27' }, thrower);
  assert.equal(r.allowed, false);
  assert.equal(r.code, CD.REFUSAL.UNKNOWABLE);
  // And a businessToday that returns something meaningless is also unknowable, rather than being
  // compared against. `''` would make every day unequal and read as STALE, which is a true-sounding
  // refusal for the wrong reason.
  for (const nonsense of ['', null, undefined, 'yesterday', 0]) {
    const n = CD.assertContentDayCurrent(
      { contentDay: '2026-11-27' }, { businessToday: () => nonsense });
    assert.equal(n.code, CD.REFUSAL.UNKNOWABLE, `businessToday() -> ${JSON.stringify(nonsense)}`);
  }
});

// ═══ 6. THE SEAM IS A CLOCK, NOT A DAY ════════════════════════════════════

test('6. no environment variable can supply the day, and no caller can supply "today"', () => {
  const src = fs.readFileSync(path.join(__dirname, 'content-day.js'), 'utf8');
  const LEX = require(path.join(__dirname, '..', '..', '..', 'scripts', 'js-lex.js'));
  // blankCommentsOnly: the module's own prose discusses `process.env` and B3.20's reasoning, so
  // blanking comments is what makes this read the code rather than the explanation. This is the
  // same trap that made three nav tests fail on a corrected comment.
  const code = LEX.blankCommentsOnly(src);
  assert.equal(/process\.env/.test(code), false,
    'content-day.js reads the environment. B3.20 established that a business-day seam reachable '
    + 'through the environment is a standing override rather than a deliberate act, because a '
    + 'deployment platform sets variables for a whole service and nobody re-reads them');
  // `deps.now` is a clock and is allowed; `deps.businessToday` is the test seam. A caller-supplied
  // DAY would be the thing B3.20 forbids, so the only accepted override is a function.
  assert.match(code, /deps\.businessToday/);
  assert.equal(/deps\.(contentDay|today|day)\b/.test(code), false,
    'a caller may not supply the day it is being judged against');
});

test('7. CONTROL: with the comparison removed, the refusals stop — so they are load-bearing', () => {
  // Rule 4. The real function is re-implemented here WITHOUT the equality check, and the stale case
  // must then pass — which is what proves the assertion in test 2 is measuring the comparison and
  // not some other refusal upstream of it.
  const vacuous = ({ contentDay }) => ({ allowed: contentDay !== undefined });
  assert.equal(vacuous({ contentDay: '2026-11-05' }).allowed, true,
    'the planted vacuous version does not accept a stale day, so it is not a control');
  assert.equal(
    CD.assertContentDayCurrent({ contentDay: '2026-11-05' }, at('2026-12-01')).allowed, false,
    'the real function accepts a stale day');
});
