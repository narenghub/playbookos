'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { zoneForPhone, zoneForContact, withinWindow, nextSlot } = require('./send-window');

// ── THE REAL CARDS ──────────────────────────────────────────────────────────────
// Verbatim from claude/cphi-milan-2026-contacts.md. If the parser cannot read the numbers that are
// actually on file, nothing else here matters.

test('every phone number on the day-1 cards resolves to a zone', () => {
  const cards = [
    ['+1 973-307-5179 (office)', 'America/Chicago'],   // TAPI, Quyen Nguyen
    ['+1 609-819-6840', 'America/Chicago'],            // Dr. Reddy's, Ashish Rana
    ['+91 88009 83623', 'Asia/Kolkata'],               // Sun Pharma
    ['+91 8121014746', 'Asia/Kolkata'],                // Hetero
    ['+91 9100902951', 'Asia/Kolkata'],                // Hetero
    ['+91 98856 68398', 'Asia/Kolkata'],               // MSN
    ['+91 9986523071', 'Asia/Kolkata'],                // Biocon
    ['+91 80743 46116', 'Asia/Kolkata'],               // Natco
    ['+91 81698 83026', 'Asia/Kolkata'],               // Gland
    ['+91 7506060937', 'Asia/Kolkata'],                // Emcure
    ['+91 80597 76672', 'Asia/Kolkata'],               // Biophore
    ['+91 9121001944', 'Asia/Kolkata'],                // Matrix
    ['+91 90544 42409', 'Asia/Kolkata'],               // Allchem
    ['+886 965 232 962', 'Asia/Taipei'],               // Formosa
    ['+86 13752911633', 'Asia/Shanghai'],              // Sintaho
  ];
  for (const [phone, expected] of cards) {
    const z = zoneForPhone(phone);
    assert.ok(z, `${phone} did not resolve`);
    assert.strictEqual(z.zone, expected, `${phone} → ${z.zone}, expected ${expected}`);
  }
});

test('+886 is Taiwan, not China — the longest dialling code must win', () => {
  // '86'.startsWith on '886...' would match China first if the list were not ordered by length,
  // putting Formosa Laboratories on the wrong side of the strait and an hour out.
  assert.strictEqual(zoneForPhone('+886 965 232 962').zone, 'Asia/Taipei');
  assert.strictEqual(zoneForPhone('+86 13752911633').zone, 'Asia/Shanghai');
  // Same hazard: +1 must not swallow +44.
  assert.strictEqual(zoneForPhone('+44 20 7946 0958').zone, 'Europe/London');
});

test('a number with no country code resolves to NOTHING, rather than a guess', () => {
  // "98856 68398" written without +91 says nothing about the country. Reading its leading digits
  // as a dialling code would invent a timezone: '9' matches nothing, but '1' would have matched
  // the US for any local number starting with a 1.
  assert.strictEqual(zoneForPhone('98856 68398'), null);
  assert.strictEqual(zoneForPhone('1234567'), null, 'a local number must not be read as +1');
  assert.strictEqual(zoneForPhone(''), null);
  assert.strictEqual(zoneForPhone(null), null);
  assert.strictEqual(zoneForPhone('see LinkedIn'), null);
});

test('mobile is preferred over office, and either is better than none', () => {
  assert.strictEqual(zoneForContact({ phone_mobile: '+91 98856 68398', phone_office: '+1 973-307-5179' }).zone, 'Asia/Kolkata');
  assert.strictEqual(zoneForContact({ phone_office: '+1 973-307-5179' }).zone, 'America/Chicago');
  assert.strictEqual(zoneForContact({}), null);
});

// ── THE WINDOW ──────────────────────────────────────────────────────────────────

const IST = zoneForPhone('+91 98856 68398');
const CST = zoneForPhone('+1 609-819-6840');

test('09:30 US Central is the middle of the night in India — and is refused', () => {
  // The failure this module exists to prevent. Chicago is UTC-6, so 09:30 there is 15:30Z — and
  // 15:30Z is 21:00 in Mumbai.
  //
  // My first version of this test used 14:30Z and called it "09:30 Chicago". It is 08:30, which
  // the window correctly refuses as too early, and the test failed on an assertion I had got
  // wrong rather than on a defect. Worth keeping the note: timezone arithmetic written by hand in
  // a comment is exactly the kind of thing that passes review and is wrong.
  const usMorning = new Date('2026-10-13T15:30:00Z');   // 09:30 Chicago, Tuesday
  const inUS = withinWindow(usMorning, CST);
  assert.ok(inUS.ok, `should be fine for the US contacts — got ${inUS.localTime} ${inUS.reason || ''}`);
  assert.strictEqual(inUS.localTime, '09:30');
  const inIndia = withinWindow(usMorning, IST);
  assert.strictEqual(inIndia.ok, false, 'the same instant must be refused for India');
  assert.strictEqual(inIndia.localTime, '21:00');
  assert.strictEqual(inIndia.reason, 'too late');

  // And the mirror: 04:00Z is 09:30 IST and 22:00 the previous evening in Chicago.
  const indiaMorning = new Date('2026-10-13T04:00:00Z');
  assert.ok(withinWindow(indiaMorning, IST).ok);
  const sameForUS = withinWindow(indiaMorning, CST);
  assert.strictEqual(sameForUS.ok, false, 'there is no single hour that suits both lists');
  assert.strictEqual(sameForUS.localTime, '22:00');
});

test('the window is local, and the local clock is reported for the dry run', () => {
  const w = withinWindow(new Date('2026-10-13T05:00:00Z'), IST);   // 10:30 IST, Tuesday
  assert.ok(w.ok);
  assert.strictEqual(w.localTime, '10:30');
});

test('weekends are refused and named', () => {
  // 2026-10-17 is a Saturday, 2026-10-18 a Sunday.
  assert.strictEqual(withinWindow(new Date('2026-10-17T05:00:00Z'), IST).reason, 'Saturday');
  assert.strictEqual(withinWindow(new Date('2026-10-18T05:00:00Z'), IST).reason, 'Sunday');
});

test('too early and too late are distinguished, because they schedule differently', () => {
  assert.strictEqual(withinWindow(new Date('2026-10-13T02:00:00Z'), IST).reason, 'too early'); // 07:30
  assert.strictEqual(withinWindow(new Date('2026-10-13T13:00:00Z'), IST).reason, 'too late');  // 18:30
});

test('an unknown zone is NOT permission to send', () => {
  // With no zone the honest answer is "I do not know what time it is there", and the caller must
  // decide. Defaulting to send would deliver at an unknown local hour to somebody met in person.
  const w = withinWindow(new Date('2026-10-13T05:00:00Z'), null);
  assert.strictEqual(w.ok, false);
  assert.strictEqual(w.reason, 'zone unknown');
});

// ── SCHEDULING, NOT SKIPPING ────────────────────────────────────────────────────

test('a step due at 2am local is moved to 09:30 local, not dropped', () => {
  const due = new Date('2026-10-13T20:30:00Z');         // 02:00 IST Wednesday
  const slot = nextSlot(due, IST);
  assert.ok(slot, 'a slot must be found');
  const w = withinWindow(slot, IST);
  assert.ok(w.ok, `slot ${slot.toISOString()} is ${w.localTime} — ${w.reason}`);
  assert.strictEqual(w.localTime, '09:30');
  assert.ok(slot > due, 'the slot must be after the due time');
});

test('a step due on Saturday waits for Monday', () => {
  const due = new Date('2026-10-17T05:00:00Z');          // Saturday 10:30 IST
  const slot = nextSlot(due, IST);
  const w = withinWindow(slot, IST);
  assert.ok(w.ok);
  assert.strictEqual(w.day, 1, 'must land on a Monday');
});

test('a time already inside the window is left close to where it was', () => {
  const due = new Date('2026-10-13T05:02:00Z');          // 10:32 IST Tuesday
  const slot = nextSlot(due, IST);
  assert.ok(withinWindow(slot, IST).ok);
  assert.ok(slot.getTime() - due.getTime() < 20 * 60 * 1000, 'should not be pushed far');
});

test('slots land on a quarter hour, so sends do not all carry :00 seconds', () => {
  // A row of emails stamped exactly on the hour is itself a tell.
  const slot = nextSlot(new Date('2026-10-13T20:30:00Z'), IST);
  assert.strictEqual(slot.getUTCSeconds(), 0);
  assert.strictEqual(slot.getUTCMinutes() % 15, 0);
});

test('no zone means no schedule — the caller is not handed a fabricated time', () => {
  assert.strictEqual(nextSlot(new Date(), null), null);
});

// ── THE WINDOW OVERRIDE EXPIRES BY ITSELF ─────────────────────────────────────

const { windowOverrideActive } = require('./send-window');
const AT = (iso) => new Date(iso);

test('a future date turns the override on', () => {
  assert.strictEqual(windowOverrideActive('2026-10-13', AT('2026-10-12T20:00:00Z')), true);
  // Valid through the END of the named day, UTC — "until the 13th" should include the 13th.
  assert.strictEqual(windowOverrideActive('2026-10-13', AT('2026-10-13T23:59:00Z')), true);
});

test('it expires on its own, with no action from anybody', () => {
  // This is the whole point. A boolean flag set at 22:00 on a Monday is a flag nobody unsets, and
  // forgetting it means mail at 3am local for the rest of the campaign.
  assert.strictEqual(windowOverrideActive('2026-10-13', AT('2026-10-14T00:00:01Z')), false);
  assert.strictEqual(windowOverrideActive('2026-10-13', AT('2026-11-01T09:00:00Z')), false);
});

test('"true" does NOT work — somebody will try it', () => {
  for (const v of ['true', 'TRUE', '1', 'yes', 'on', 'forever', 'soon']) {
    assert.strictEqual(windowOverrideActive(v, AT('2026-10-12T20:00:00Z')), false, `"${v}" enabled it`);
  }
});

test('absent, empty and malformed values mean NO override', () => {
  for (const v of [undefined, null, '', '   ', '2026-10', '10-13-2026', '2026/10/13']) {
    assert.strictEqual(windowOverrideActive(v, AT('2026-10-12T20:00:00Z')), false, `${JSON.stringify(v)} enabled it`);
  }
});

test('a date-shaped impossibility is refused, not coerced', () => {
  // Matches the regex but is not a date. Date.parse gives NaN, and NaN comparisons are false in
  // both directions — which happens to be safe here, but is asserted so it stays deliberate.
  assert.strictEqual(windowOverrideActive('2026-13-45', AT('2026-10-12T20:00:00Z')), false);
  assert.strictEqual(windowOverrideActive('0000-00-00', AT('2026-10-12T20:00:00Z')), false);
});

test('whitespace around a real date is tolerated', () => {
  // Pasted into a Railway variable field, a trailing space is likelier than not.
  assert.strictEqual(windowOverrideActive('  2026-10-13  ', AT('2026-10-12T20:00:00Z')), true);
});
