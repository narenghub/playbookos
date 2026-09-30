// THE CONTROL IS ON EVERY LIST — or this test says which ones it is not on.
//   node --test src/lib/outreach/ui-wiring.test.js
//
// "One implementation" is a claim about the UI as much as the schema, and the way it stops being true is
// quietly: a list gets added, or one of the seven never gets wired, and nobody notices because each page
// looks fine on its own. So the wiring is asserted per entity type, and WIRED is the list of the ones
// genuinely done — a gap has to be written down here to pass, which makes it visible in review rather
// than discovered by somebody looking for a dropdown that is not there.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { ENTITIES } = require('./registry');

const SRC = fs.readFileSync(__dirname + '/../../../public/index.html', 'utf8');
const count = (re) => (SRC.match(re) || []).length;

// Wired and verified. NOT YET: study (clinical-demand-intelligence), exhibitor (cphi-milan),
// lead (sales-pipeline) — three renderers that are not plain tables (a detail panel, two tables, and a
// card layout), deliberately left for their own pass rather than rushed.
const WIRED = ['prospect', 'institution', 'establishment'];
const PENDING = ['study', 'exhibitor', 'lead'];

test('the wired lists have all three pieces: load, cell, and bar', () => {
  for (const t of WIRED) {
    assert.ok(count(new RegExp(`orLoad\\('${t}'`, 'g')) >= 1, `${t}: orLoad missing`);
    assert.ok(count(new RegExp(`orCell\\('${t}'`, 'g')) >= 1, `${t}: orCell missing`);
    assert.ok(count(new RegExp(`orBar\\('${t}'`, 'g')) >= 1, `${t}: orBar missing`);
  }
});

test('WIRED + PENDING accounts for every entity type — no type is simply forgotten', () => {
  assert.deepEqual([...WIRED, ...PENDING].sort(), Object.keys(ENTITIES).sort());
});

test('a PENDING list really is unwired, so the note cannot go stale', () => {
  // If somebody wires one and forgets to move it out of PENDING, this fails and tells them to.
  for (const t of PENDING) {
    assert.equal(count(new RegExp(`orCell\\('${t}'`, 'g')), 0,
      `${t} appears to be wired now — move it from PENDING to WIRED`);
  }
});

test('the prospect control is on BOTH prospect pages', () => {
  // One entity type, two lists — the golfnex/favly/linkabl view and the SiteNex one.
  assert.equal(count(/orCell\('prospect'/g), 2);
  assert.equal(count(/orBar\('prospect'/g), 2);
});

test('the dropdown reads the vocabulary from the server, not a second copy', () => {
  assert.match(SRC, /API\('\/outreach\/vocabulary'\)/, 'orVocab must fetch it');
  const cell = SRC.slice(SRC.indexOf('function orCell('), SRC.indexOf('window.orSet'));
  assert.match(cell, /OR\.vocab && OR\.vocab\.statuses/, 'and orCell must use what it fetched');
});

test('saving does not re-render the list', () => {
  const set = SRC.slice(SRC.indexOf('window.orSet = async function'), SRC.indexOf('function orAdjustBar'));
  assert.ok(!/pages\[/.test(set), 'orSet must not call a page function — that loses scroll and filters');
  assert.match(set, /orAdjustBar/, 'it adjusts the bar in place instead');
});

test('a failed save puts the control back and shows the SERVER\'s words', () => {
  const set = SRC.slice(SRC.indexOf('window.orSet = async function'), SRC.indexOf('function orAdjustBar'));
  assert.match(set, /sel\.value = prev/, 'the dropdown must not lie about a save that failed');
  assert.match(set, /res\.error/, 'and the reason shown is the server\'s, not a guess');
});

test('orSet and orNote are on window — an inline handler resolves against it', () => {
  // Annex B does not hoist an async function out of a block, which is exactly what silently broke the
  // Agent Control Run button.
  assert.match(SRC, /window\.orSet = async function orSet\(/);
  assert.match(SRC, /window\.orNote = async function orNote\(/);
});

test('the row click cannot swallow the dropdown on a clickable row', () => {
  // Both prospect lists open a detail panel when the row is clicked. Without stopPropagation, using the
  // dropdown would also open the panel.
  const cells = [...SRC.matchAll(/orCell\('prospect', it\.id\)/g)].map(m => SRC.slice(Math.max(0, m.index - 160), m.index));
  assert.equal(cells.length, 2);
  for (const before of cells) {
    assert.match(before, /stopPropagation/, 'the outreach cell must stop the row click');
  }
});

test('the Outreach page exists, is reachable, and renders the silence', () => {
  assert.match(SRC, /pages\['outreach'\] = outreachPage/);
  assert.match(SRC, /\{id:'outreach', label:'Outreach'/, 'it has a nav entry');
  const page = SRC.slice(SRC.indexOf('async function outreachPage()'), SRC.indexOf("pages['outreach'] = outreachPage"));
  assert.match(page, /res\.silent/, 'the silence is rendered');
  assert.match(page, /Silence — no outreach at all/, 'and named plainly');
  assert.match(page, /outreach\/overview\?days=/, 'from the one overview call');
  for (const bit of ['By person', 'By list', 'By status moved to']) {
    assert.ok(page.includes(bit), `the page must show "${bit}"`);
  }
});
