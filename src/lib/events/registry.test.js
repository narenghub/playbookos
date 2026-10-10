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

test('SCOPE has four tabs: three products plus the labs we recruit', () => {
  // Order is tab order. qc_lab sits before linkable because labs are a real population in that
  // room and LinkAble, researched, is zero there.
  assert.deepStrictEqual(rolesFor('scope-europe-2026'), ['abiozen', 'aros', 'qc_lab', 'linkable']);
});

test('three SCOPE tabs are what a company BUYS, and one is what we buy', () => {
  // The distinction that earns qc_lab its own tab rather than a row inside Abiozen: on three tabs
  // money flows towards us, on the fourth it flows away. Mixing those in one list means walking up
  // to a booth with the pitch pointing the wrong way.
  for (const key of ['abiozen', 'aros', 'linkable']) {
    const note = roleDef('scope-europe-2026', key).note;
    assert.ok(/buy|subscri|purchas/i.test(note), `${key} should describe what they buy: "${note}"`);
  }
  assert.match(roleDef('scope-europe-2026', 'qc_lab').note, /recruit/i,
    'qc_lab is a company we recruit, not one that buys from us');
});

test('CPHI keeps its four roles untouched', () => {
  assert.deepStrictEqual(rolesFor('cphi-milan-2026'),
    ['supplier', 'platform_partner', 'qc_lab', 'buyer']);
});

test('a role key shared between events must be DECLARED, with a reason', () => {
  // This test used to forbid sharing outright, reasoning that "one event's rows would answer the
  // other's query". That was wrong: rows are keyed (event_slug, role, holder_normalized) and every
  // query filters on both, so the partition already prevents it.
  //
  // The real risk is a key that MEANS different things on different floors, which a blanket ban
  // cannot distinguish from a key that correctly means the same thing — and banning the second kind
  // forces a duplicate key for one concept, which is the drift this registry exists to end.
  //
  // So sharing is allowed when declared in SHARED_ROLE_KEYS with the reason. Undeclared still fails.
  const { SHARED_ROLE_KEYS } = require('./registry');
  const seen = new Map();
  for (const e of EVENTS) {
    for (const r of e.roles) {
      if (seen.has(r.key)) {
        assert.ok(SHARED_ROLE_KEYS[r.key],
          `"${r.key}" appears in both ${seen.get(r.key)} and ${e.slug} but is not declared in ` +
          'SHARED_ROLE_KEYS. If the two floors mean the same thing by it, declare it there with ' +
          'the reason. If they mean different things, it needs two keys.');
        assert.ok(SHARED_ROLE_KEYS[r.key].length > 40,
          `the reason given for sharing "${r.key}" is too short to be a reason`);
      }
      seen.set(r.key, e.slug);
    }
  }
});

test('every declared shared key is actually shared', () => {
  // The drift that bit verify-classic-nav-parity.js twice: an entry left behind after the thing it
  // described was removed, so the file documents a situation that no longer exists.
  const { SHARED_ROLE_KEYS } = require('./registry');
  for (const key of Object.keys(SHARED_ROLE_KEYS)) {
    const events = EVENTS.filter((e) => e.roles.some((r) => r.key === key)).map((e) => e.slug);
    assert.ok(events.length >= 2,
      `"${key}" is declared as shared but appears only in ${events.join(', ') || 'no event'} — ` +
      'remove the declaration rather than leaving it to describe a situation that has gone.');
  }
});

test('qc_lab is the shared key, and it means the same on both floors', () => {
  assert.ok(rolesFor('cphi-milan-2026').includes('qc_lab'));
  assert.ok(rolesFor('scope-europe-2026').includes('qc_lab'));
  // Both notes must describe RECRUITING a lab, never selling to it. A lab we sell testing to is a
  // different role (CPHI's `buyer`), and conflating them is the pitch arriving backwards at a booth.
  for (const slug of ['cphi-milan-2026', 'scope-europe-2026']) {
    const note = roleDef(slug, 'qc_lab').note;
    assert.match(note, /recruit/i, `${slug}/qc_lab must describe recruiting the lab`);
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
