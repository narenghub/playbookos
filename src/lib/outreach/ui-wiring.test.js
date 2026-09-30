// WHAT "WIRED" MEANS for the outreach UI.
//   node --test src/lib/outreach/ui-wiring.test.js
//
// HISTORY WORTH KEEPING: on 2026-09-30 this UI took production down. `async function outreachPage()` was
// inserted INSIDE the `const pages = { ... }` object literal, which is a syntax error, so the main inline
// script failed to parse and the whole SPA rendered nothing — while /health stayed green and the container
// logs stayed empty, because a client-side parse failure leaves no server trace. index.html was rolled back,
// then fixed by declaring the function before the literal and attaching it after with pages['outreach'] =.
//
// For the duration of the rollback this file asserted the UI's ABSENCE rather than going green over controls
// that were not on the page. UI_RESTORED is still computed from the source rather than hardcoded, so it
// remains true in either direction: the inverted branch is what runs if the helpers ever disappear again.
//
// The placement check itself lives in src/lib/spa-parses.test.js, which owns the structural knowledge of
// index.html.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { ENTITIES } = require('./registry');

const SRC = fs.readFileSync(__dirname + '/../../../public/index.html', 'utf8');
const count = (re) => (SRC.match(re) || []).length;

// Every slice of index.html goes through this. A hand-written SRC.slice(indexOf(a), indexOf(b)) returns ''
// when b appears BEFORE a, and every assertion over the result then passes or fails for a reason that has
// nothing to do with the code: the channel check asserted "exactly two selects", got 0, and the two selects
// were right there in the function. orBar is simply defined above orCell. A bound that is wrong must throw,
// not yield an empty string.
function between(startNeedle, endNeedle) {
  const a = SRC.indexOf(startNeedle);
  assert.notEqual(a, -1, `not found in index.html: ${startNeedle}`);
  const b = SRC.indexOf(endNeedle, a + startNeedle.length);
  assert.notEqual(b, -1, `not found after ${startNeedle}: ${endNeedle}`);
  const slice = SRC.slice(a, b);
  assert.ok(slice.length > 0, `empty slice between ${startNeedle} and ${endNeedle}`);
  return slice;
}

// Flip to true in the commit that restores the UI. Every assertion below reads it.
const UI_RESTORED = /function heldProductKeys|window\.orSet/.test(SRC) && /function orCell\(/.test(SRC);

// When restored: prospect/institution/establishment/study/exhibitor get a control. `lead` never does —
// leads.status is already an outreach lifecycle, see the block comment in registry.js.
const SHOULD_WIRE = ['prospect', 'institution', 'establishment', 'study', 'exhibitor'];
const NEVER_WIRE = ['lead'];

test('SHOULD_WIRE + NEVER_WIRE still accounts for every entity type', () => {
  assert.deepEqual([...SHOULD_WIRE, ...NEVER_WIRE].sort(), Object.keys(ENTITIES).sort());
});

test('the entity NOT to wire carries its reason, so it cannot become "forgotten"', () => {
  for (const t of NEVER_WIRE) {
    assert.ok(ENTITIES[t].hasOwnLifecycle, `${t} needs a recorded reason in registry.js`);
  }
  for (const t of SHOULD_WIRE) {
    assert.ok(!ENTITIES[t].hasOwnLifecycle, `${t} claims its own lifecycle but is meant to get a control`);
  }
});

test('the API and schema survived the rollback — the fix has something to attach to', () => {
  const routes = fs.readFileSync(__dirname + '/../../api/routes.js', 'utf8');
  for (const r of ["router.get('/outreach'", "router.put('/outreach'", "router.get('/outreach/summary'",
                   "router.get('/outreach/activity'", "router.get('/outreach/overview'",
                   "router.get('/outreach/history'", "router.get('/outreach/vocabulary'"]) {
    assert.ok(routes.includes(r), `${r} must still exist`);
  }
  const mod = require('./index');
  for (const fn of ['statusFor', 'setStatus', 'summary', 'activity', 'overview', 'history']) {
    assert.equal(typeof mod[fn], 'function', `${fn} must still be exported`);
  }
});

test(UI_RESTORED ? 'the UI is wired' : 'the UI is absent, as expected after the rollback', () => {
  if (!UI_RESTORED) {
    // Assert the absence, so this test starts failing the moment somebody re-adds the helpers without
    // flipping this file back to the real assertions.
    assert.equal(count(/function orCell\(/g), 0, 'orCell is back — restore the real assertions in this file');
    assert.equal(count(/pages\['outreach'\]/g), 0, 'the Outreach page is back — same');
    return;
  }
  // ── the real specification of "wired", restored with the UI ──
  for (const t of SHOULD_WIRE) {
    assert.ok(count(new RegExp(`orLoad\\('${t}'`, 'g')) >= 1, `${t}: orLoad missing`);
    assert.ok(count(new RegExp(`orCell\\('${t}'`, 'g')) >= 1, `${t}: orCell missing`);
    assert.ok(count(new RegExp(`orBar\\('${t}'`, 'g')) >= 1, `${t}: orBar missing`);
  }
  for (const t of NEVER_WIRE) {
    assert.equal(count(new RegExp(`orCell\\('${t}'`, 'g')), 0, `${t} must NOT get a control`);
  }
  assert.equal(count(/orCell\('prospect'/g), 2, 'both prospect pages');
  assert.match(SRC, /API\('\/outreach\/vocabulary'\)/, 'the dropdown reads the server vocabulary');
  assert.match(SRC, /window\.orSet = async function orSet\(/, 'orSet must be an explicit global');
  assert.match(SRC, /window\.orNote = async function orNote\(/);
  const set = between('window.orSet = async function', 'function orAdjustBar');
  assert.ok(!/pages\[/.test(set), 'saving must not re-render the list');
  assert.match(set, /sel\.value = prev/, 'a failed save puts the control back');
  assert.match(set, /res\.error/, "and shows the server's words");
  for (const flag of ['ppOneSubtype', 'apOneSubtype']) {
    assert.ok(count(new RegExp(flag, 'g')) >= 4, `${flag}: cell, header and colspans must all honour it`);
  }
  const page = between('async function outreachPage()', "pages['outreach'] = outreachPage");
  assert.match(page, /res\.silent/, 'the silence is rendered');
});

// ── TWO FIELDS means TWO CONTROLS ───────────────────────────────────────────────
test('every wired row gets a channel control alongside the status one', () => {
  if (!UI_RESTORED) return;
  // The split is only real in the UI if channel has its own control. One dropdown whose options mixed
  // stages and methods is exactly the design this was built to avoid.
  assert.match(SRC, /window\.orSetChannel = async function orSetChannel\(/,
    'channel must be an explicit global — an async function declaration in a block is NOT hoisted, which is'
    + ' the bug that silently broke every Agent Control Run button');
  assert.match(SRC, /or-chan-\$\{entityType\}-\$\{id\}/, 'the channel control needs its own id per row');
  const cell = between('function orCell(', 'window.orSet = async function');
  assert.equal((cell.match(/<select/g) || []).length, 2, 'exactly two selects: the status and the channel');
  assert.match(cell, /orChannels\(\)/, 'the channel options come from the server vocabulary, not a literal');
  assert.match(cell, /orStatusKeys\(\)/, 'and so do the status options');
});

test('setting a channel goes through the SAME write path as a status change', () => {
  if (!UI_RESTORED) return;
  // A second endpoint for channel would be a second place to enforce scoping. It re-sends the current
  // status instead, so one route, one product check, one event.
  const fn = between('window.orSetChannel = async function orSetChannel(', 'window.orNote = async function orNote(');
  assert.match(fn, /status/, 'it re-sends the current status');
  assert.ok(!/fetch\(/.test(fn), 'and uses the shared API helper rather than its own fetch');
});

test('the funnel bar renders the SERVER order, and shows the empty stages up to the furthest reached', () => {
  if (!UI_RESTORED) return;
  const bar = between('function orBar(', 'function orCell(');
  // "1,522 not contacted · 2 contacted · 0 quote sent · 0 won" only reads as a pipeline if the zeroes
  // between the live stages are drawn. Dropping them would hide the drop-off, which is the thing to act on.
  assert.match(bar, /lastLive/, 'the bar tracks the furthest stage reached so the gaps before it still show');
  assert.ok(!/\.sort\(\)/.test(bar), 'never an alphabetical sort — contacted would come before not_contacted');
});

// The placement check lives in src/lib/spa-parses.test.js, which owns the structural knowledge of the file
// (and where the same naive brace-counting bug had to be fixed twice). Duplicating it here meant two copies
// of a fragile parser, so this file no longer tries.
