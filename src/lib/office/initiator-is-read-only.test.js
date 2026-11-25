// ── A SCHEDULER THAT CAN GRANT AUTHORITY IS NOT A SCHEDULER ─────────────────
//
//   node --test src/lib/office/initiator-is-read-only.test.js
//
// The dependency plan's rule, restated in the owner's §6 of 2026-11-25:
//
//   *"Initiation consumes existing authority and creates none."*
//
// The risk is not that somebody activates an objective from here on purpose. It is
// that six weeks from now an objective is sitting in `draft` on a Monday morning, the scheduler
// skips it, somebody is annoyed, and activating it from here looks like a one-line fix. These
// assertions make that a deliberate act: it means deleting a test that says why it must not happen.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { blankCommentsOnly } = require('../../../scripts/js-lex');

const FILE = require.resolve('./initiator.js');
const raw = fs.readFileSync(FILE, 'utf8');
// Comments BLANKED, not stripped: line numbers survive, and prose ABOUT what the module must not
// do cannot satisfy — or trip — an assertion about what it does. The lesson from validate-k5
// grepping its own documentation.
const code = blankCommentsOnly(raw);

test('1. it never writes to objectives', () => {
  // Activating, pausing, re-tiering or funding an objective are all the CEO's acts.
  assert.doesNotMatch(code, /UPDATE\s+objectives/i);
  assert.doesNotMatch(code, /INSERT\s+INTO\s+objectives/i);
  assert.doesNotMatch(code, /DELETE\s+FROM\s+objectives/i);
  assert.doesNotMatch(code, /setObjectiveStatus\s*\(/);
  assert.doesNotMatch(code, /createObjective\s*\(/);
});

test('2. it never creates or raises a budget', () => {
  // An objective with no finite budget is SKIPPED, not funded. B2.5a refuses an unfunded
  // autonomous run, so funding one here would invent the authorization that refusal requires.
  // `SET … budget_usd`, not a bare `budget_usd =`. The loose form matched `o.budget_usd === null`
  // — a COMPARISON, which this module must do — so the assertion was failing on correct code and
  // would have been "fixed" by deleting it. An assertion that cannot tell a read from a write is
  // not an assertion about writes.
  assert.doesNotMatch(code, /\bSET\b[^;]{0,200}budget_usd/i);
  assert.doesNotMatch(code, /budget_usd\s*:\s*[^=]/);
  assert.doesNotMatch(code, /INSERT\s+INTO\s+office_budget_exceptions/i);
  assert.doesNotMatch(code, /UPDATE\s+office_budget_exceptions/i);
  assert.doesNotMatch(code, /reserveSpend\s*\(/);
});

test('3. it never grants a capability, a membership, or a tier', () => {
  assert.doesNotMatch(code, /grantMembership\s*\(/);
  assert.doesNotMatch(code, /autonomy_tier\s*=/);
  assert.doesNotMatch(code, /INSERT\s+INTO\s+user_companies/i);
  assert.doesNotMatch(code, /verified_capabilities/);
});

test('4. it never lifts a STOP', () => {
  // It may READ the kill switch — it must, to fail closed — and may not resume one.
  assert.match(code, /checkStopped\s*\(/, 'the initiator does not consult the kill switch at all');
  assert.doesNotMatch(code, /\bresume\s*\(/);
  assert.doesNotMatch(code, /DELETE\s+FROM\s+autonomy_stops/i);
});

test('5. the ONLY write it performs is through the run ledger', () => {
  // Stated positively, so a future INSERT to some other table is visible as a new statement rather
  // than as an absence.
  const writes = [...code.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/gi)]
    .map((m) => m[2].toLowerCase());
  assert.deepStrictEqual(writes, [],
    `the initiator issues its own write statement(s) to: ${writes.join(', ')}. Every write it is `
    + 'allowed to cause goes through beginObjectiveRun, which owns the run ledger.');
  assert.match(code, /beginObjectiveRun\s*\(/);
});

test('6. only the supervised tier is authorized, and the constant says so', () => {
  const I = require('./initiator');
  assert.strictEqual(I.AUTHORIZED_TIER, 'supervised');
  // 'bounded' must not creep in: B3.3 refuses it for delegation, so initiating a bounded objective
  // would open a run whose first delegation cannot happen.
  assert.doesNotMatch(code, /'bounded'/);
});

test('7. it does not rebuild duplicate prevention', () => {
  // `uq_agent_runs_one_active` is the arbiter. A second check here would be correct only while
  // every future writer remembers it, and a forgotten check fails silently — the reasoning
  // runs.js already records about advisory locks.
  assert.doesNotMatch(code, /COUNT\(\*\)[\s\S]{0,80}agent_runs/i);
  assert.doesNotMatch(code, /FROM\s+agent_runs/i);
  assert.match(code, /duplicate/,
    'it must at least OBSERVE the duplicate verdict, or a scheduler firing twice is invisible');
});

test('8. the day slot is a BUSINESS day, not the UTC default', () => {
  // objectiveIntentKey defaults to a UTC day. Since B7.23 the crons fire in America/Chicago, and
  // 23:00 and 01:00 Chicago on consecutive business days share one UTC day — so the default would
  // decline the second business day's run as a duplicate.
  assert.match(code, /businessToday\s*\(/);
  assert.match(code, /bd=/, 'the business day is not part of the intent key');
});
