// Booking qualifier tests — run with:  node --test src/lib/agents/prospecting/qualify.test.js
// httpText injected via deps; no real sites fetched. signatures/terms are REQUIRED — every
// call passes the golf set explicitly, imported from config (never redefined here).
const { test } = require('node:test');
const assert = require('node:assert');
const { qualifyFacility, detect, findBookingLink } = require('./qualify');
const { getConfig } = require('./config');

const GOLF = getConfig('golfnex');
const SIG = GOLF.signatures;               // the golf signature set, from config
const TERMS = GOLF.bookingLinkTerms;       // ['book','tee time','reserve','booking']
const q = (website, over = {}) => qualifyFacility(website, { signatures: SIG, bookingLinkTerms: TERMS, ...over });

test('detect finds every signature key (low tier via text mention)', () => {
  for (const s of SIG) {
    assert.equal(detect('welcome ... ' + s.key + ' ... footer', SIG).platform, s.platform, 'key ' + s.key);
  }
});

test('confidence tiers: script/iframe src = high, link href = medium, text = low', () => {
  assert.equal(detect('<script src="https://app.foreupsoftware.com/x.js"></script>', SIG).confidence, 'high');
  assert.equal(detect('<iframe src="https://widget.chronogolf.com/"></iframe>', SIG).confidence, 'high');
  assert.equal(detect('<a href="https://foo.teesnap.net/book">Book</a>', SIG).confidence, 'medium');
  assert.equal(detect('Reservations powered by GolfNow', SIG).confidence, 'low');
  assert.equal(detect('nothing here', SIG).platform, null);
});

test('detect picks the HIGHEST confidence when several appear', () => {
  const html = '<a href="https://x.golfnow.com">book</a><script src="https://app.foreupsoftware.com/a.js"></script>';
  const r = detect(html, SIG);
  assert.equal(r.confidence, 'high');
  assert.equal(r.platform, 'foreup');
});

test('findBookingLink resolves relative URLs and skips mailto/#/about', () => {
  assert.equal(findBookingLink('<a href="/tee-times">Book a Tee Time</a>', 'https://club.com', TERMS), 'https://club.com/tee-times');
  assert.equal(findBookingLink('<a href="https://book.club.com/">Reserve</a>', 'https://club.com', TERMS), 'https://book.club.com/');
  assert.equal(findBookingLink('<a href="mailto:x@y.com">book</a>', 'https://club.com', TERMS), null);
  assert.equal(findBookingLink('<a href="/about">About us</a>', 'https://club.com', TERMS), null);
});

test('qualifyFacility — homepage signature (high), no follow needed', async () => {
  const http = async () => ({ text: '<script src="https://app.foreupsoftware.com/a.js"></script>' });
  const r = await q('https://club.com', { deps: { httpText: http } });
  assert.equal(r.platform, 'foreup');
  assert.equal(r.confidence, 'high');
});

test('qualifyFacility — FOLLOWS one book link to a subdomain widget', async () => {
  const http = async ({ url }) => {
    if (url === 'https://club.com') return { text: '<a href="/reserve">Reserve a tee time</a>' };
    return { text: '<iframe src="https://club.chronogolf.com/widget"></iframe>' };
  };
  const r = await q('https://club.com', { deps: { httpText: http } });
  assert.equal(r.platform, 'chronogolf');
  assert.equal(r.confidence, 'high');
  assert.match(r.evidence, /via book link https:\/\/club\.com\/reserve/);
});

test('qualifyFacility — no signature anywhere → platform null', async () => {
  const http = async ({ url }) => url === 'https://club.com'
    ? { text: '<a href="/reserve">Reserve</a>' }
    : { text: '<p>call us to book</p>' };
  const r = await q('https://club.com', { deps: { httpText: http } });
  assert.equal(r.platform, null);
  assert.match(r.evidence, /no signature/);
});

test('dead site / 403 → platform null, NOT an error, no throw', async () => {
  const http = async () => ({ error: 'HTTP 403', status: 403 });
  let r;
  await assert.doesNotReject(async () => { r = await q('https://dead.com', { deps: { httpText: http } }); });
  assert.equal(r.platform, null);
  assert.match(r.evidence, /homepage unreachable/);
});

test('timeout → platform null, no throw', async () => {
  const http = async () => ({ error: 'request timed out after 15000ms', timedOut: true });
  const r = await q('https://slow.com', { deps: { httpText: http } });
  assert.equal(r.platform, null);
  assert.match(r.evidence, /unreachable/);
});

test('non-HTML body (e.g. JSON) → platform null cleanly', async () => {
  const http = async () => ({ text: '{"ok":true}', contentType: 'application/json' });
  const r = await q('https://api.com', { deps: { httpText: http } });
  assert.equal(r.platform, null);
});

test('a THROWING fetch is caught (runtime failure → result, never throws)', async () => {
  const http = async () => { throw new Error('boom'); };
  let r;
  await assert.doesNotReject(async () => { r = await q('https://x.com', { deps: { httpText: http } }); });
  assert.equal(r.platform, null);
  assert.match(r.evidence, /qualify error: boom/);
});

test('no website → null without fetching', async () => {
  let called = false; const http = async () => { called = true; return { text: '' }; };
  const r = await q('', { deps: { httpText: http } });
  assert.equal(r.platform, null);
  assert.equal(called, false);
});

// ── signatures/terms are REQUIRED — missing config is a LOUD error, not silent golf ──
test('detect() WITHOUT signatures THROWS (no silent golf default)', () => {
  assert.throws(() => detect('<script src="https://app.foreupsoftware.com/a.js"></script>'), /signatures array is required/);
  assert.throws(() => detect('x', []), /signatures array is required/);
});

test('qualifyFacility() WITHOUT signatures THROWS loudly — the prevented failure mode', async () => {
  let fetched = false; const http = async () => { fetched = true; return { text: 'x' }; };
  await assert.rejects(() => qualifyFacility('https://salon.com', { deps: { httpText: http } }), /signatures .*are required/);
  await assert.rejects(() => qualifyFacility('https://salon.com', { signatures: SIG, deps: { httpText: http } }), /bookingLinkTerms .*are required/);
  assert.equal(fetched, false, 'a misconfigured call never touches the network');
});

test('findBookingLink() WITHOUT terms THROWS', () => {
  assert.throws(() => findBookingLink('<a href="/book">Book</a>', 'https://x.com'), /terms.*required/);
});

// ── config sanity (golf + favly) ────────────────────────────────────────────────
test('golfnex config: 13 signatures detect all 13 platforms via detect(html, sigs)', () => {
  assert.equal(SIG.length, 13);
  for (const s of SIG) assert.equal(detect(`<html> ... ${s.key} ... </html>`, SIG).platform, s.platform);
});

test('getConfig shapes: golfnex + favly present; unknown → null', () => {
  assert.equal(getConfig('golfnex').subtypes.length, 3);
  const f = getConfig('favly');
  assert.ok(f, 'favly config now exists');
  assert.ok(Array.isArray(f.subtypes) && f.subtypes.length >= 3);
  assert.ok(Array.isArray(f.signatures) && f.signatures.length >= 10);
  assert.deepEqual(f.bookingLinkTerms, ['book', 'appointment', 'schedule', 'reserve']);
  assert.deepEqual(f.states, ['IL']);
  assert.equal(getConfig('nope'), null);
});
