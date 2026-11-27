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

test('1. an ABSENT declaration is refused — the control is not opt-in', async () => {
  for (const missing of [undefined, null, '']) {
    const r = await CD.assertContentDayCurrent({ contentDay: missing }, at('2026-11-27'));
    assert.equal(r.allowed, false, `${JSON.stringify(missing)} was ALLOWED`);
    assert.equal(r.code, CD.REFUSAL.NOT_DECLARED);
  }
  // And the reason has to say WHY absence is refused, because the next person to meet this
  // refusal will reach for a default.
  const r = await CD.assertContentDayCurrent({}, at('2026-11-27'));
  assert.match(r.reason, /every caller opts out of by forgetting/);
});

test('1a. calling it with no arguments at all is still a refusal, not a pass', async () => {
  const r = await CD.assertContentDayCurrent(undefined, at('2026-11-27'));
  assert.equal(r.allowed, false);
  assert.equal(r.code, CD.REFUSAL.NOT_DECLARED);
});

test('2. today is allowed, and that is the only day that is', async () => {
  assert.equal((await CD.assertContentDayCurrent({ contentDay: '2026-11-27' }, at('2026-11-27'))).allowed,
    true);
  // One day either side, which is the realistic failure rather than a wild value.
  const yesterday = await CD.assertContentDayCurrent({ contentDay: '2026-11-26' }, at('2026-11-27'));
  assert.equal(yesterday.allowed, false);
  assert.equal(yesterday.code, CD.REFUSAL.STALE);
  const tomorrow = await CD.assertContentDayCurrent({ contentDay: '2026-11-28' }, at('2026-11-27'));
  assert.equal(tomorrow.allowed, false);
  assert.equal(tomorrow.code, CD.REFUSAL.FUTURE);
});

test('2a. stale and future are DIFFERENT codes, because they need different action', async () => {
  // The 2026-11-03 incident shape: content from three weeks ago.
  const old = await CD.assertContentDayCurrent({ contentDay: '2026-11-05' }, at('2026-12-01'));
  assert.equal(old.code, CD.REFUSAL.STALE);
  assert.match(old.reason, /worse than silence/);
  assert.equal(old.today, '2026-12-01');
  assert.equal(old.day, '2026-11-05');
  const ahead = await CD.assertContentDayCurrent({ contentDay: '2027-01-01' }, at('2026-12-01'));
  assert.equal(ahead.code, CD.REFUSAL.FUTURE);
  assert.notEqual(ahead.code, old.code,
    'a stale message and a future-dated one are the same failure to a caller that only reads '
    + '`allowed`, and they are not the same problem to an operator');
});

test('3. TIMELESS requires a NAMED kind — it is not a free choice', async () => {
  // THE BYPASS THE OWNER ASKED ABOUT. As first written, any caller could pass TIMELESS and a
  // three-week-old briefing would go out: the whole control, opt-out by one word.
  const bare = await CD.assertContentDayCurrent({ contentDay: CD.TIMELESS }, at('2026-11-27'));
  assert.equal(bare.allowed, false, 'TIMELESS with no declared kind was ALLOWED');
  assert.equal(bare.code, CD.REFUSAL.TIMELESS_NOT_PERMITTED);
  assert.match(bare.reason, /one word away from being switched off/);

  // A named kind from the closed vocabulary is allowed.
  const named = await CD.assertContentDayCurrent(
    { contentDay: CD.TIMELESS, timelessKind: 'account_lifecycle' }, at('2026-11-27'));
  assert.equal(named.allowed, true);
  assert.equal(named.timeless, true);
  assert.equal(named.day, null);
  assert.equal(named.timelessKind, 'account_lifecycle');

  // An INVENTED kind is refused, which is what makes the vocabulary closed rather than decorative.
  for (const invented of ['daily_briefing', 'performance_score', 'anything', '', null, true]) {
    const r = await CD.assertContentDayCurrent(
      { contentDay: CD.TIMELESS, timelessKind: invented }, at('2026-11-27'));
    assert.equal(r.allowed, false, `timelessKind ${JSON.stringify(invented)} was ACCEPTED`);
  }

  // And TIMELESS itself is not reachable by accident: nothing truthy stands in for the literal.
  for (const near of ['TIMELESS', 'Timeless', 'none', 'n/a', true, 0, {}]) {
    const bad = await CD.assertContentDayCurrent(
      { contentDay: near, timelessKind: 'account_lifecycle' }, at('2026-11-27'));
    assert.equal(bad.allowed, false, `${JSON.stringify(near)} passed as timeless`);
  }
});

test('3a. DATED BUSINESS CONTENT IS NOT IN THE VOCABULARY, and that is the point', async () => {
  // The list is the control. If a future edit adds a dated kind to it, this assertion goes red —
  // which is the only thing standing between "a reviewed list" and "a list somebody appended to".
  for (const dated of ['daily_briefing', 'briefing', 'assignment', 'task_assignment',
    'performance_score', 'coaching', 'escalation', 'daily_report', 'weekly_review']) {
    assert.equal(CD.TIMELESS_KINDS.has(dated), false,
      `${dated} is in TIMELESS_KINDS. Dated business content declaring itself timeless is exactly `
      + 'the replay bypass B7.13 exists to prevent');
  }
  // And the vocabulary is not empty, or the assertion above would hold vacuously.
  assert.ok(CD.TIMELESS_KINDS.size >= 4, 'the vocabulary is too small to be the real one');
});

test('3b. a current reply ABOUT a historical record is still allowed — it declares TODAY', async () => {
  // The owner's constraint: "Legitimate current replies concerning historical records must remain
  // possible under current authorization." A reply written today about November's numbers is
  // content about today's correspondence, so it declares today and passes. The control forbids a
  // message claiming to BE about a past day arriving now — not referring to the past.
  const reply = await CD.assertContentDayCurrent({ contentDay: '2026-12-01' }, at('2026-12-01'));
  assert.equal(reply.allowed, true,
    'a reply sent today, however old the records it discusses, declares today and must send');
});

test('4. a malformed day is refused, never parsed leniently', async () => {
  for (const malformed of ['27-11-2026', '2026/11/27', '2026-11-27T00:00:00Z', 'today',
    '2026-11-7', 20261127, new Date('2026-11-27')]) {
    const r = await CD.assertContentDayCurrent({ contentDay: malformed }, at('2026-11-27'));
    assert.equal(r.allowed, false, `${JSON.stringify(malformed)} was ALLOWED`);
    assert.equal(r.code, CD.REFUSAL.MALFORMED, `${JSON.stringify(malformed)} got ${r.code}`);
  }
});

test('5. an unknowable current day refuses — it does not fall through to allowed', async () => {
  const thrower = { businessToday: () => { throw new Error('clock unavailable'); } };
  const r = await CD.assertContentDayCurrent({ contentDay: '2026-11-27' }, thrower);
  assert.equal(r.allowed, false);
  assert.equal(r.code, CD.REFUSAL.UNKNOWABLE);
  // And a businessToday that returns something meaningless is also unknowable, rather than being
  // compared against. `''` would make every day unequal and read as STALE, which is a true-sounding
  // refusal for the wrong reason.
  for (const nonsense of ['', null, undefined, 'yesterday', 0]) {
    const n = await CD.assertContentDayCurrent(
      { contentDay: '2026-11-27' }, { businessToday: () => nonsense });
    assert.equal(n.code, CD.REFUSAL.UNKNOWABLE, `businessToday() -> ${JSON.stringify(nonsense)}`);
  }
});

// ═══ 6. THE SEAM IS A CLOCK, NOT A DAY ════════════════════════════════════

test('6. no environment variable can supply the day, and no caller can supply "today"', async () => {
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

test('7. CONTROL: with the comparison removed, the refusals stop — so they are load-bearing', async () => {
  // Rule 4. The real function is re-implemented here WITHOUT the equality check, and the stale case
  // must then pass — which is what proves the assertion in test 2 is measuring the comparison and
  // not some other refusal upstream of it.
  const vacuous = ({ contentDay }) => ({ allowed: contentDay !== undefined });
  assert.equal(vacuous({ contentDay: '2026-11-05' }).allowed, true,
    'the planted vacuous version does not accept a stale day, so it is not a control');
  assert.equal(
    (await CD.assertContentDayCurrent({ contentDay: '2026-11-05' }, at('2026-12-01'))).allowed, false,
    'the real function accepts a stale day');
});

// ══ 8. TRUSTED PERSISTED PROVENANCE (contentDayFrom) ══════════════════════
//
// The weakness this closes was written in the module before it was built: a caller that lies about
// its kind, or simply computes the wrong day, is not stopped by a function that only sees what the
// caller passed. So the caller supplies a POINTER and the day is read from the row.

const rowsFor = (day) => ({
  query: async (sql, params) => {
    assert.match(sql, /SELECT task_date AS day FROM daily_tasks WHERE id = \$1/,
      'the column and table must come from the allowlist, not from the caller');
    assert.deepEqual(params, ['task-1'], 'the id must be parameterised, never interpolated');
    return { rows: day === null ? [] : [{ day }] };
  },
  businessToday: () => '2026-11-27',
});

test('8. the day is READ FROM THE RECORD, not taken from the caller', async () => {
  const r = await CD.assertContentDayCurrent(
    { contentDayFrom: { kind: 'daily_task', id: 'task-1' } }, rowsFor('2026-11-27'));
  assert.equal(r.allowed, true);
  assert.equal(r.day, '2026-11-27');
  assert.equal(r.derivedFrom, 'daily_tasks.task_date');
});

test('8a. DECISIVE: a record whose day is STALE is still refused', async () => {
  // Deriving from a trusted row does not make the row current. This is the whole point: the record
  // is trusted as the SOURCE of the day, not as permission to send about it today.
  const r = await CD.assertContentDayCurrent(
    { contentDayFrom: { kind: 'daily_task', id: 'task-1' } }, rowsFor('2026-11-05'));
  assert.equal(r.allowed, false);
  assert.equal(r.code, CD.REFUSAL.STALE);
  assert.equal(r.derivedFrom, 'daily_tasks.task_date',
    'the refusal still says where the day came from, which is what an operator needs');
});

test('8b. declaring a day AND pointing at a record is refused', async () => {
  // With both, whichever the code prefers becomes the real control — a question nobody would think
  // to ask until it mattered.
  const r = await CD.assertContentDayCurrent(
    { contentDay: '2026-11-27', contentDayFrom: { kind: 'daily_task', id: 'task-1' } },
    rowsFor('2026-11-05'));
  assert.equal(r.allowed, false);
  assert.equal(r.code, CD.REFUSAL.BOTH_SUPPLIED);
});

test('8c. an unknown record kind, a missing row and an unreadable table each refuse by name', async () => {
  const unknown = await CD.assertContentDayCurrent(
    { contentDayFrom: { kind: 'invoices', id: 'x' } }, rowsFor('2026-11-27'));
  assert.equal(unknown.code, CD.REFUSAL.RECORD_KIND_UNKNOWN);

  const missing = await CD.assertContentDayCurrent(
    { contentDayFrom: { kind: 'daily_task', id: 'task-1' } }, rowsFor(null));
  assert.equal(missing.code, CD.REFUSAL.RECORD_NOT_FOUND);

  const broken = await CD.assertContentDayCurrent(
    { contentDayFrom: { kind: 'daily_task', id: 'task-1' } },
    { query: async () => { throw new Error('connection refused'); } });
  assert.equal(broken.code, CD.REFUSAL.RECORD_UNREADABLE);

  const noDay = await CD.assertContentDayCurrent(
    { contentDayFrom: { kind: 'daily_task', id: 'task-1' } }, rowsFor('not-a-day'));
  assert.equal(noDay.code, CD.REFUSAL.RECORD_NO_DAY);
});

test('8d. the caller cannot choose the COLUMN — that is the bypass it would be', async () => {
  // A caller that could name the column could name `created_at` on a row written today and make
  // any stale message current. The allowlist pins table AND column together.
  for (const kind of Object.keys(CD.DERIVABLE_RECORDS)) {
    const spec = CD.DERIVABLE_RECORDS[kind];
    assert.ok(spec.table && spec.column, `${kind} must pin both table and column`);
    assert.equal(/created_at|updated_at|now/i.test(spec.column), false,
      `${kind} derives its day from ${spec.column}, which moves with the row rather than `
      + 'describing the business day its content concerns');
  }
  // And a caller-supplied column is simply not read: the shape has no place for one.
  const r = await CD.assertContentDayCurrent(
    { contentDayFrom: { kind: 'daily_task', id: 'task-1', column: 'created_at' } },
    rowsFor('2026-11-27'));
  assert.equal(r.allowed, true, 'the extra field must be ignored, not honoured');
  assert.equal(r.derivedFrom, 'daily_tasks.task_date');
});

// ── THE CONSTANT COMES FROM THE MODULE THAT OWNS IT ─────────────────────────
//
// Seven product call sites used to read it as `require('../mailer').CONTENT_DAY.TIMELESS` — a
// constant fetched through a module that merely re-exports it, evaluated inside an argument list at
// call time. `mailer.js` does export it, so this worked in production and looked fine.
//
// It broke the moment anything replaced the mailer in the require cache, which is the standard way
// this repo proves "no email was attempted": check-rfq-identity-guard-db.js installs a four-key
// spy, and `undefined.TIMELESS` threw a TypeError that surfaced as "harness error" on the one
// preflight step whose subject is that an unsupported CAS never reaches a supplier. The guard was
// intact; the instrument could not reach it.
//
// It is also the `platform-sender.js` lesson a second time: a value read ACROSS a module boundary
// that does not own it is a value that can be absent without anyone saying so. The constant lives
// in this module, and every caller requires this module.
test('no product file reads CONTENT_DAY through the mailer', () => {
  // This file lives in src/lib/outbound/, so the repository root is THREE levels up. Two resolved
  // to src/ and made the walk scan src/src/ — caught by the test failing rather than by the scan
  // quietly finding no files, which is what a `try` around readdirSync would have produced.
  const root = path.join(__dirname, '..', '..', '..');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) files.push(full);
    }
  };
  walk(path.join(root, 'src'));

  const offenders = [];
  for (const f of files) {
    // mailer.js itself may of course hold and re-export it; everyone else requires this module.
    if (f === path.join(root, 'src', 'lib', 'mailer.js')) continue;
    const src = fs.readFileSync(f, 'utf8');
    const re = /require\((['"])[^'"]*mailer\1\)\s*\.\s*CONTENT_DAY/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${path.relative(root, f)}:${line}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `these read CONTENT_DAY through the mailer, so any mailer spy makes them throw: `
    + `${offenders.join(', ')}. Require src/lib/outbound/content-day directly.`);
});

test('and the constant is reachable from content-day itself', () => {
  assert.strictEqual(require('./content-day').TIMELESS, 'timeless',
    'the value the seven call sites now read');
});
