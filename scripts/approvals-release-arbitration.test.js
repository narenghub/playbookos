// ── IS THE RELEASE CLAIM STILL ONE ARBITRATED STATEMENT? ─────────────────────
//
//   node --test scripts/approvals-release-arbitration.test.js
//
// Spec A milestone 6 last mile, item 2 (concurrency safety).
//
// ── WHY THIS LIVES UNDER scripts/ AND NOT BESIDE THE ROUTE ───────────────────
//
// It has to NAME `office_approvals` in SQL in order to assert the shape of the accessor's UPDATE.
// scripts/check-office-scope-discipline.js forbids that outside the accessor and the schema, and
// its rule is explicit: "Product code may never be exempt. The only permitted exemptions under
// src/ are the accessor and the schema; everything else exempt must be a script." A control that
// observes the raw table in order to prove something about it is exactly the validator category
// that rule admits — so it moved here rather than widening the exemption, which is what the rule
// is there to prevent.
//
// ── WHAT IT PROTECTS, AND WHY A BEHAVIOURAL TEST IS NOT ENOUGH ───────────────
//
// src/api/approvals-dispatch.test.js fires ten simultaneous dispatch requests and asserts one
// send. It runs against a double that models the claim correctly — so it proves the ROUTE is safe
// GIVEN an arbitrated claim, not that the claim is arbitrated.
//
// That distinction is load-bearing here. Mutating the idempotency key to a random value does NOT
// break the ten-click test, which means ten-clicks-send-once rests entirely on this one UPDATE. A
// refactor to SELECT-then-UPDATE would reopen exactly the window it exists to close, and every
// behavioural test in this repository would still pass.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

test('4d. the PRODUCTION release claim is one arbitrated statement', () => {
  // The concurrency test above runs against a double that models the claim correctly. This asserts
  // the real one is still the thing being modelled — and it matters more than usual, because the
  // R4 mutation showed that randomising the idempotency key does NOT break the concurrency test.
  // Ten-clicks-send-once rests entirely on this UPDATE; a refactor to SELECT-then-UPDATE would
  // reopen exactly the window it exists to close, and every test here would still pass.
  const LEX = require('./js-lex');
  const code = LEX.blankCommentsOnly(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'office', 'scope.js'), 'utf8'));

  const i = code.indexOf('async function claimApprovalRelease');
  assert.notStrictEqual(i, -1, 'claimApprovalRelease has been renamed or removed');
  const body = code.slice(i, code.indexOf('\n}', i));

  assert.match(body, /UPDATE office_approvals/, 'the claim is no longer an UPDATE');
  assert.match(body, /release_claimed_at IS NULL/,
    'the UPDATE no longer decides on release_claimed_at being NULL, so two executors could both claim');
  assert.match(body, /RETURNING/,
    'the claim does not RETURN the row, so the caller cannot tell whether IT won the claim');
  assert.ok(!/SELECT[\s\S]*UPDATE office_approvals/.test(body),
    'a SELECT now precedes the UPDATE — if the decision moved into application code, two '
    + 'concurrent dispatches can both believe they claimed it');
});
