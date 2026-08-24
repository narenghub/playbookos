// Booking qualifier tests — run with:  node --test src/lib/agents/prospecting/qualify.test.js
// httpText injected via deps; no real sites fetched.
const { test } = require('node:test');
const assert = require('node:assert');
const { qualifyFacility, detect, findBookingLink, SIGNATURES } = require('./qualify');

test('detect finds every signature key (low tier via text mention)', () => {
  for (const s of SIGNATURES) {
    const r = detect('welcome ... ' + s.key + ' ... footer');
    assert.equal(r.platform, s.platform, 'key ' + s.key);
  }
});

test('confidence tiers: script/iframe src = high, link href = medium, text = low', () => {
  assert.equal(detect('<script src="https://app.foreupsoftware.com/x.js"></script>').confidence, 'high');
  assert.equal(detect('<iframe src="https://widget.chronogolf.com/"></iframe>').confidence, 'high');
  assert.equal(detect('<a href="https://foo.teesnap.net/book">Book</a>').confidence, 'medium');
  assert.equal(detect('Reservations powered by GolfNow').confidence, 'low');
  assert.deepEqual({ p: detect('nothing here').platform }, { p: null });
});

test('detect picks the HIGHEST confidence when several appear', () => {
  const html = '<a href="https://x.golfnow.com">book</a><script src="https://app.foreupsoftware.com/a.js"></script>';
  const r = detect(html);
  assert.equal(r.confidence, 'high');
  assert.equal(r.platform, 'foreup');
});

test('findBookingLink resolves relative URLs and skips mailto/#/about', () => {
  assert.equal(findBookingLink('<a href="/tee-times">Book a Tee Time</a>', 'https://club.com'), 'https://club.com/tee-times');
  assert.equal(findBookingLink('<a href="https://book.club.com/">Reserve</a>', 'https://club.com'), 'https://book.club.com/');
  assert.equal(findBookingLink('<a href="mailto:x@y.com">book</a>', 'https://club.com'), null);
  assert.equal(findBookingLink('<a href="/about">About us</a>', 'https://club.com'), null);
});

test('qualifyFacility — homepage signature (high), no follow needed', async () => {
  const http = async () => ({ text: '<script src="https://app.foreupsoftware.com/a.js"></script>' });
  const r = await qualifyFacility('https://club.com', { deps: { httpText: http } });
  assert.equal(r.platform, 'foreup');
  assert.equal(r.confidence, 'high');
});

test('qualifyFacility — FOLLOWS one book link to a subdomain widget', async () => {
  const http = async ({ url }) => {
    if (url === 'https://club.com') return { text: '<a href="/reserve">Reserve a tee time</a>' }; // homepage: no signature
    return { text: '<iframe src="https://club.chronogolf.com/widget"></iframe>' };                // book page has it
  };
  const r = await qualifyFacility('https://club.com', { deps: { httpText: http } });
  assert.equal(r.platform, 'chronogolf');
  assert.equal(r.confidence, 'high');
  assert.match(r.evidence, /via book link https:\/\/club\.com\/reserve/);
});

test('qualifyFacility — no signature anywhere → platform null', async () => {
  const http = async ({ url }) => url === 'https://club.com'
    ? { text: '<a href="/reserve">Reserve</a>' }
    : { text: '<p>call us to book</p>' };
  const r = await qualifyFacility('https://club.com', { deps: { httpText: http } });
  assert.equal(r.platform, null);
  assert.match(r.evidence, /no signature/);
});

test('dead site / 403 → platform null, NOT an error, no throw', async () => {
  const http = async () => ({ error: 'HTTP 403', status: 403 });
  let r;
  await assert.doesNotReject(async () => { r = await qualifyFacility('https://dead.com', { deps: { httpText: http } }); });
  assert.equal(r.platform, null);
  assert.match(r.evidence, /homepage unreachable/);
});

test('timeout → platform null, no throw', async () => {
  const http = async () => ({ error: 'request timed out after 15000ms', timedOut: true });
  const r = await qualifyFacility('https://slow.com', { deps: { httpText: http } });
  assert.equal(r.platform, null);
  assert.match(r.evidence, /unreachable/);
});

test('non-HTML body (e.g. JSON) → platform null cleanly', async () => {
  const http = async () => ({ text: '{"ok":true}', contentType: 'application/json' });
  const r = await qualifyFacility('https://api.com', { deps: { httpText: http } });
  assert.equal(r.platform, null);
});

test('a THROWING fetch is caught (never throws)', async () => {
  const http = async () => { throw new Error('boom'); };
  let r;
  await assert.doesNotReject(async () => { r = await qualifyFacility('https://x.com', { deps: { httpText: http } }); });
  assert.equal(r.platform, null);
  assert.match(r.evidence, /qualify error: boom/);
});

test('no website → null without fetching', async () => {
  let called = false; const http = async () => { called = true; return { text: '' }; };
  const r = await qualifyFacility('', { deps: { httpText: http } });
  assert.equal(r.platform, null);
  assert.equal(called, false);
});
