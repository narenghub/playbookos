'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  EVENTS, defaultEventSlug, getEvent, isEvent, allRoleKeys, rolesFor, roleDef, isRoleOf, publicEvents,
} = require('./registry');

// ── THE DEFAULT EVENT IS A DATE QUESTION, NOT A CONSTANT ────

test('the default is the nearest upcoming event', () => {
  // 9 Oct 2026: CPHI finished on the 8th, SCOPE opens on the 13th.
  assert.strictEqual(defaultEventSlug('2026-10-09'), 'scope-europe-2026');
});

test('an event still running is the default on its own last day', () => {
  // On 8 Oct someone is standing on the CPHI floor. Opening on SCOPE would be wrong.
  assert.strictEqual(defaultEventSlug('2026-10-08'), 'cphi-milan-2026');
  assert.strictEqual(defaultEventSlug('2026-10-14'), 'scope-europe-2026');
});

test('before both, the earlier one wins', () => {
  assert.strictEqual(defaultEventSlug('2026-09-01'), 'cphi-milan-2026');
});

test('after everything, fall back to the most recent rather than nothing', () => {
  // An empty page reads as a broken page. A stale one at least says what it is.
  assert.strictEqual(defaultEventSlug('2027-06-01'), 'scope-europe-2026');
});

test('defaultEventSlug always returns a real event', () => {
  for (const d of ['2020-01-01', '2026-10-09', '2030-12-31', Date.now(), new Date()]) {
    assert.ok(isEvent(defaultEventSlug(d)), `${d} produced a slug that is not an event`);
  }
});

// ── SCOPE'S ROLES ARE NOT CPHI'S RELABELLED ────

test('SCOPE has the three tabs by what the company buys from us', () => {
  assert.deepStrictEqual(rolesFor('scope-europe-2026'), ['abiozen', 'aros', 'linkable']);
});

test('CPHI keeps its four roles untouched', () => {
  assert.deepStrictEqual(rolesFor('cphi-milan-2026'),
    ['supplier', 'platform_partner', 'qc_lab', 'buyer']);
});

test('no role is shared between a supply event and a demand event', () => {
  // If a key appeared in both, one event's rows would answer the other's query — the two floors ask
  // opposite questions, so a shared role would mix sellers into a buyer list.
  const cphi = new Set(rolesFor('cphi-milan-2026'));
  for (const r of rolesFor('scope-europe-2026')) {
    assert.ok(!cphi.has(r), `"${r}" is in both events`);
  }
});

test('a role belongs only to its own event', () => {
  assert.ok(isRoleOf('scope-europe-2026', 'abiozen'));
  assert.ok(!isRoleOf('cphi-milan-2026', 'abiozen'));
  assert.ok(!isRoleOf('scope-europe-2026', 'supplier'));
});

test('allRoleKeys covers every role of every event, deduplicated', () => {
  const keys = allRoleKeys();
  for (const e of EVENTS) for (const r of e.roles) {
    assert.ok(keys.includes(r.key), `${r.key} missing from allRoleKeys`);
  }
  assert.strictEqual(keys.length, new Set(keys).size, 'allRoleKeys has duplicates');
});

// ── EVERY ROLE MUST SAY WHERE ITS RANKING COMES FROM ────

test('every role declares a basis and a note', () => {
  // The page prints the note. A role whose rank comes from nowhere must SAY it comes from nowhere,
  // or the list implies a confidence the data cannot carry — which is how the CPHI buyer tab
  // ended up looking authoritative while returning dairies.
  const allowed = ['dmf', 'demand', 'establishment', 'none'];
  for (const e of EVENTS) for (const r of e.roles) {
    assert.ok(allowed.includes(r.basis), `${e.slug}/${r.key} has basis "${r.basis}"`);
    assert.ok(r.note && r.note.length > 20, `${e.slug}/${r.key} needs a real note`);
    assert.ok(r.label && r.label.length, `${e.slug}/${r.key} needs a label`);
  }
});

test('a basis of none is admitted in the note, not hidden', () => {
  for (const e of EVENTS) for (const r of e.roles) {
    if (r.basis !== 'none') continue;
    assert.ok(/no ranking signal|no data|alphabetical/i.test(r.note),
      `${e.slug}/${r.key} has no ranking data but its note does not say so: "${r.note}"`);
  }
});

// ── SHAPE AND SANITY ────

test('every event has a slug, name, city and a sane date range', () => {
  for (const e of EVENTS) {
    assert.ok(/^[a-z0-9-]+$/.test(e.slug), `bad slug: ${e.slug}`);
    assert.ok(e.name && e.city, `${e.slug} missing name or city`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.starts), `${e.slug} starts is not ISO: ${e.starts}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.ends), `${e.slug} ends is not ISO: ${e.ends}`);
    assert.ok(e.ends >= e.starts, `${e.slug} ends before it starts`);
    assert.ok(['supply', 'demand'].includes(e.kind), `${e.slug} kind is "${e.kind}"`);
    assert.ok(e.roles.length >= 1, `${e.slug} has no roles`);
  }
});

test('slugs are unique', () => {
  const slugs = EVENTS.map((e) => e.slug);
  assert.strictEqual(slugs.length, new Set(slugs).size);
});

test('role keys are unique within an event', () => {
  for (const e of EVENTS) {
    const keys = e.roles.map((r) => r.key);
    assert.strictEqual(keys.length, new Set(keys).size, `${e.slug} repeats a role key`);
  }
});

test('getEvent and isEvent agree, and junk is refused', () => {
  for (const bad of ['', null, undefined, 'nope', 'CPHI-Milan-2026', 'scope', 0]) {
    assert.strictEqual(isEvent(bad), false, `${JSON.stringify(bad)} accepted as an event`);
    assert.strictEqual(getEvent(bad), null);
  }
  assert.ok(getEvent('scope-europe-2026'));
});

test('rolesFor and roleDef are safe on an unknown event', () => {
  assert.deepStrictEqual(rolesFor('nope'), []);
  assert.strictEqual(roleDef('nope', 'abiozen'), null);
  assert.strictEqual(roleDef('scope-europe-2026', 'nope'), null);
  assert.strictEqual(isRoleOf('nope', 'abiozen'), false);
});

test('publicEvents carries what the front end needs and nothing it should not invent', () => {
  const pub = publicEvents();
  assert.strictEqual(pub.length, EVENTS.length);
  for (const e of pub) {
    for (const k of ['slug', 'name', 'city', 'starts', 'ends', 'kind', 'roles']) {
      assert.ok(k in e, `publicEvents is missing ${k}`);
    }
    for (const r of e.roles) {
      for (const k of ['key', 'label', 'basis', 'note']) {
        assert.ok(k in r, `role ${r.key} is missing ${k} — the page would draw a tab with no note`);
      }
    }
  }
});

test('publicEvents does not hand out a mutable reference to the registry', () => {
  const pub = publicEvents();
  pub[0].name = 'MUTATED';
  pub[0].roles[0].label = 'MUTATED';
  assert.notStrictEqual(EVENTS[0].name, 'MUTATED');
  assert.notStrictEqual(EVENTS[0].roles[0].label, 'MUTATED');
});

// ── SCOPE EUROPE 2026, AS VERIFIED AGAINST scopesummiteurope.com ON 9 OCT 2026 ────

test('SCOPE Europe 2026 is Barcelona, 13-14 October', () => {
  const e = getEvent('scope-europe-2026');
  assert.strictEqual(e.city, 'Barcelona');
  assert.strictEqual(e.starts, '2026-10-13');
  assert.strictEqual(e.ends, '2026-10-14');
  assert.strictEqual(e.kind, 'demand', 'SCOPE attendees run trials — they buy from us, not to us');
});
