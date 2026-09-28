// Booking qualifier tests — run with:  node --test src/lib/agents/prospecting/qualify.test.js
// httpText injected via deps; no real sites fetched. signatures/terms are REQUIRED — every
// call passes the golf set explicitly, imported from config (never redefined here).
const { test } = require('node:test');
const assert = require('node:assert');
const { qualifyFacility, detect, detectAll, findBookingLink, classifyUnreachable } = require('./qualify');
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

// ── reachability: qualifyFacility surfaces reachable + unreachableReason ─────────
// The whole point of the fix: a reached-no-signature site and a never-reached site both have
// platform:null, but must be distinguishable so dead links don't sort into the prime pool.
test('reached, no signature → reachable:true, no reason', async () => {
  const http = async () => ({ text: '<p>call us to book</p>' }); // homepage fetched, no signature, no book link
  const r = await q('https://live.com', { deps: { httpText: http } });
  assert.equal(r.platform, null);
  assert.equal(r.reachable, true);
  assert.equal(r.unreachableReason, null);
});

test('platform found (homepage) → reachable:true', async () => {
  const http = async () => ({ text: '<script src="https://app.foreupsoftware.com/a.js"></script>' });
  const r = await q('https://club.com', { deps: { httpText: http } });
  assert.equal(r.platform, 'foreup');
  assert.equal(r.reachable, true);
  assert.equal(r.unreachableReason, null);
});

test('platform found via book link → reachable:true (homepage was reached)', async () => {
  const http = async ({ url }) => url === 'https://club.com'
    ? { text: '<a href="/reserve">Reserve a tee time</a>' }
    : { text: '<iframe src="https://club.chronogolf.com/widget"></iframe>' };
  const r = await q('https://club.com', { deps: { httpText: http } });
  assert.equal(r.platform, 'chronogolf');
  assert.equal(r.reachable, true);
});

test('403 → reachable:false, reason 403', async () => {
  const r = await q('https://dead.com', { deps: { httpText: async () => ({ error: 'HTTP 403', status: 403 }) } });
  assert.equal(r.reachable, false);
  assert.equal(r.unreachableReason, '403');
});

test('other HTTP error (500) → reachable:false, reason http_error', async () => {
  const r = await q('https://err.com', { deps: { httpText: async () => ({ error: 'HTTP 500', status: 500 }) } });
  assert.equal(r.reachable, false);
  assert.equal(r.unreachableReason, 'http_error');
});

test('timeout → reachable:false, reason timeout', async () => {
  const r = await q('https://slow.com', { deps: { httpText: async () => ({ error: 'request timed out after 7000ms', timedOut: true }) } });
  assert.equal(r.reachable, false);
  assert.equal(r.unreachableReason, 'timeout');
});

test('network throw (dns/conn) → reachable:false, reason dns', async () => {
  const r = await q('https://nxdomain.com', { deps: { httpText: async () => ({ error: 'request failed: getaddrinfo ENOTFOUND nxdomain.com' }) } });
  assert.equal(r.reachable, false);
  assert.equal(r.unreachableReason, 'dns');
});

test('2xx but empty body → reachable:false, reason empty', async () => {
  const r = await q('https://blank.com', { deps: { httpText: async () => ({ text: '', status: 200 }) } });
  assert.equal(r.reachable, false);
  assert.equal(r.unreachableReason, 'empty');
});

test('throwing fetch (caught) → reachable:false, reason http_error', async () => {
  const r = await q('https://x.com', { deps: { httpText: async () => { throw new Error('boom'); } } });
  assert.equal(r.reachable, false);
  assert.equal(r.unreachableReason, 'http_error');
  assert.match(r.evidence, /qualify error: boom/);
});

test('no website → reachable:null (not applicable)', async () => {
  const r = await q('', { deps: { httpText: async () => ({ text: 'x' }) } });
  assert.equal(r.reachable, null);
  assert.equal(r.unreachableReason, null);
});

test('classifyUnreachable maps each httpText failure shape', () => {
  assert.equal(classifyUnreachable({ error: 'request timed out after 7000ms', timedOut: true }), 'timeout');
  assert.equal(classifyUnreachable({ error: 'HTTP 403', status: 403 }), '403');
  assert.equal(classifyUnreachable({ error: 'HTTP 404', status: 404 }), 'http_error');
  assert.equal(classifyUnreachable({ error: 'HTTP 503', status: 503 }), 'http_error');
  assert.equal(classifyUnreachable({ error: 'request failed: ECONNREFUSED' }), 'dns');
  assert.equal(classifyUnreachable({ error: 'body read failed: x', status: 200 }), 'empty');
  assert.equal(classifyUnreachable({}), 'empty');
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

test('every product declares EXACTLY ONE prime axis, and linkabl is the inverted one', () => {
  // The polarity is data, not prose. golf/beauty: a booking platform means they already solved
  // scheduling, so prime = none. linkabl: an ATS means real requisition volume, so prime = has one.
  // Getting this backwards points a whole sales list at the wrong half of the market.
  //
  // acbm introduced a SECOND axis: prime there is "the site is bad" (high site_score), which
  // primeSignal's vocabulary cannot express. So the invariant is no longer "everyone declares
  // primeSignal" but the stricter "everyone declares exactly one axis, and never both" — a
  // product silent about how prime is defined is the actual bug this test exists to catch.
  const { PRODUCT_CONFIG } = require('./config');
  for (const [key, cfg] of Object.entries(PRODUCT_CONFIG)) {
    const hasSignal = cfg.primeSignal !== undefined;
    const hasBy = cfg.primeBy !== undefined;
    assert.ok(hasSignal !== hasBy, `${key} must declare exactly one of primeSignal / primeBy (got primeSignal=${JSON.stringify(cfg.primeSignal)}, primeBy=${JSON.stringify(cfg.primeBy)})`);
    if (hasSignal) {
      assert.ok(['platform', 'no-platform'].includes(cfg.primeSignal),
        `${key} primeSignal must be 'platform' or 'no-platform', got ${JSON.stringify(cfg.primeSignal)}`);
    } else {
      assert.ok(['site_score'].includes(cfg.primeBy),
        `${key} primeBy must be a known axis, got ${JSON.stringify(cfg.primeBy)}`);
    }
  }
  assert.equal(getConfig('golfnex').primeSignal, 'no-platform');
  assert.equal(getConfig('favly').primeSignal, 'no-platform');
  assert.equal(getConfig('linkabl').primeSignal, 'platform');
  // acbm deliberately has NO primeSignal: routes.js:4410 would otherwise read it as
  // 'no-platform' and the page's prime filter would mean "no CMS detected".
  assert.equal(getConfig('acbm').primeSignal, undefined);
  assert.equal(getConfig('acbm').primeBy, 'site_score');
});

test('acbm shipping config: 3 experiment-backed subtypes, all IL regions, capped', () => {
  const a = getConfig('acbm');
  assert.deepEqual(a.states, ['IL']);
  assert.equal(a.regions, undefined, 'no metro override — the segment scales by adding metros');
  assert.equal(a.callCap, 150);       // 3 × 13 × ≤3 pages ≈ 117 calls
  assert.deepEqual(a.subtypes.map(s => s.key), ['machine_shop', 'funeral', 'pharmacy']);
  // Dropped by the 2026-09-28 experiment: auto_repair (review bands show no site-quality signal)
  // and daycare (already marketed). Never included: salons/golf — favly and golfnex own those.
  const terms = a.subtypes.map(s => s.term.toLowerCase()).join(' ');
  assert.doesNotMatch(terms, /salon|barber|spa|golf|driving range|auto repair|daycare/);
  assert.ok(a.signatures.length >= 10 && a.bookingLinkTerms.length >= 1);
});

test('acbm reject patterns cover chains and hospital systems, but NOT review count', () => {
  const pats = getConfig('acbm').rejectNamePatterns;
  assert.ok(Array.isArray(pats) && pats.length >= 10);
  for (const needle of ['walgreens', 'cvs', 'health system', 'hospital']) {
    assert.ok(pats.includes(needle), `missing reject pattern: ${needle}`);
  }
  // machine shops average 5 reviews — a review-count floor would reject the best segment.
  assert.ok(!pats.some(p => /review|rating|count/.test(p)));
  assert.equal(getConfig('acbm').minRatingCount, undefined);
});

// ── detectAll — every signal present, not just the first ────────────────────────
test('detectAll returns EVERY matching platform where detect() returns one', () => {
  const html = '<script src="https://static1.squarespace.com/x.js"></script><a href="/wp-content/themes/t">t</a> powered by weebly';
  const sigs = [
    { platform: 'squarespace', key: 'static1.squarespace' },
    { platform: 'wordpress', key: 'wp-content' },
    { platform: 'weebly', key: 'weebly' },
  ];
  assert.equal(detect(html, sigs).platform, 'squarespace');           // unchanged: first/highest only
  const all = detectAll(html, sigs);
  assert.deepEqual(all.map(h => h.platform), ['squarespace', 'wordpress', 'weebly']);
  assert.deepEqual(all.map(h => h.confidence), ['high', 'medium', 'low']);
});

test('detectAll counts a multi-key platform ONCE, at its highest confidence', () => {
  const html = '<script src="//parastorage.com/a.js"></script> see wix.com for details';
  const sigs = [{ platform: 'wix', key: 'wix.com' }, { platform: 'wix', key: 'parastorage.com' }];
  const all = detectAll(html, sigs);
  assert.equal(all.length, 1);
  assert.equal(all[0].confidence, 'high');
  assert.equal(all[0].key, 'parastorage.com');
});

test('detectAll: no matches → [], and missing signatures throws loudly', () => {
  assert.deepEqual(detectAll('<html>nothing</html>', [{ platform: 'wix', key: 'wix.com' }]), []);
  assert.throws(() => detectAll('<html/>', []), /non-empty signatures array is required/);
  assert.throws(() => detectAll('<html/>'), /non-empty signatures array is required/);
});
