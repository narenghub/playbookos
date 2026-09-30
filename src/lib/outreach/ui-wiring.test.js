// THE OUTREACH UI IS CURRENTLY ROLLED BACK. This file records that, and what has to come back.
//   node --test src/lib/outreach/ui-wiring.test.js
//
// On 2026-09-30 the outreach UI took production down: `async function outreachPage()` was inserted inside
// the `const pages = { ... }` object literal, so the main inline script failed to parse and the whole SPA
// rendered nothing. public/index.html was rolled back to ac749f9; everything server-side was kept.
//
// So the assertions here are inverted on purpose. They assert the SCHEMA AND API are intact (they are, and
// they are what the fix will attach to) and that the UI is absent — because a test file full of green
// assertions about controls that are not on the page would be worse than no test at all.
//
// WHEN THE FIX LANDS: set UI_RESTORED = true and the original assertions come back. They are not deleted,
// because they are the specification of what "wired" means.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { ENTITIES } = require('./registry');

const SRC = fs.readFileSync(__dirname + '/../../../public/index.html', 'utf8');
const count = (re) => (SRC.match(re) || []).length;

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
  const set = SRC.slice(SRC.indexOf('window.orSet = async function'), SRC.indexOf('function orAdjustBar'));
  assert.ok(!/pages\[/.test(set), 'saving must not re-render the list');
  assert.match(set, /sel\.value = prev/, 'a failed save puts the control back');
  assert.match(set, /res\.error/, "and shows the server's words");
  for (const flag of ['ppOneSubtype', 'apOneSubtype']) {
    assert.ok(count(new RegExp(flag, 'g')) >= 4, `${flag}: cell, header and colspans must all honour it`);
  }
  const page = SRC.slice(SRC.indexOf('async function outreachPage()'), SRC.indexOf("pages['outreach'] = outreachPage"));
  assert.match(page, /res\.silent/, 'the silence is rendered');
});

// The placement check lives in src/lib/spa-parses.test.js, which owns the structural knowledge of the file
// (and where the same naive brace-counting bug had to be fixed twice). Duplicating it here meant two copies
// of a fragile parser, so this file no longer tries.
