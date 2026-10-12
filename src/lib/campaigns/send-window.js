// ── WHEN IS IT A REASONABLE HOUR WHERE THE RECIPIENT IS? ──────────────────────
//
// The post-CPHI follow-ups go from Naresh's own mailbox while he travels, and his timezone is
// irrelevant to the people receiving them. Of the fifteen day-1 cards, ten are in India, one in
// Taiwan and one in China. A US business-hours default would deliver most of this list at about
// two in the morning, which is both rude and the clearest possible signal that a machine sent it —
// the exact thing that choosing Gmail over a sequencer was meant to avoid.
//
// ── THE SIGNAL IS THE PHONE NUMBER, WHICH IS ALREADY ON FILE ─────────────────
//
// cphi_exhibitor_contacts has no timezone column and never will have a reliable one. But the cards
// carry dialling codes — +91 98856 68398, +886 965 232 962, +86 13752911633 — and a country code
// is a far better guess at a working day than anything inferred from a company name.
//
// It is a GUESS and is treated as one: a country with several zones gets the zone its commercial
// centre is in, and anything unrecognised returns null so the caller can decide rather than be
// handed a confident wrong answer. That is the same rule marketOfCountry follows for countries it
// cannot place, and for the same reason: on a list somebody acts on, a silent wrong answer is
// worse than an admitted gap.
'use strict';

// Minutes east of UTC, and the IANA name for the record. Only the countries this campaign actually
// reaches, plus the obvious neighbours — a long list of guesses is not more accurate than a short
// list of known ones.
//
// Offsets are STANDARD time. Daylight saving is deliberately ignored: it moves the window by an
// hour twice a year, and an email arriving at 10am instead of 9am is not a defect. Pretending to
// model DST from a dialling code would be false precision.
const DIAL_ZONES = [
  { code: '91', minutes: 330, zone: 'Asia/Kolkata', note: 'India' },
  { code: '886', minutes: 480, zone: 'Asia/Taipei', note: 'Taiwan' },
  { code: '86', minutes: 480, zone: 'Asia/Shanghai', note: 'China' },
  { code: '81', minutes: 540, zone: 'Asia/Tokyo', note: 'Japan' },
  { code: '82', minutes: 540, zone: 'Asia/Seoul', note: 'South Korea' },
  { code: '65', minutes: 480, zone: 'Asia/Singapore', note: 'Singapore' },
  { code: '971', minutes: 240, zone: 'Asia/Dubai', note: 'UAE' },
  { code: '972', minutes: 120, zone: 'Asia/Jerusalem', note: 'Israel' },
  { code: '44', minutes: 0, zone: 'Europe/London', note: 'UK' },
  { code: '353', minutes: 0, zone: 'Europe/Dublin', note: 'Ireland' },
  { code: '351', minutes: 0, zone: 'Europe/Lisbon', note: 'Portugal' },
  { code: '34', minutes: 60, zone: 'Europe/Madrid', note: 'Spain' },
  { code: '33', minutes: 60, zone: 'Europe/Paris', note: 'France' },
  { code: '49', minutes: 60, zone: 'Europe/Berlin', note: 'Germany' },
  { code: '39', minutes: 60, zone: 'Europe/Rome', note: 'Italy' },
  { code: '41', minutes: 60, zone: 'Europe/Zurich', note: 'Switzerland' },
  { code: '31', minutes: 60, zone: 'Europe/Amsterdam', note: 'Netherlands' },
  { code: '32', minutes: 60, zone: 'Europe/Brussels', note: 'Belgium' },
  { code: '45', minutes: 60, zone: 'Europe/Copenhagen', note: 'Denmark' },
  { code: '46', minutes: 60, zone: 'Europe/Stockholm', note: 'Sweden' },
  { code: '48', minutes: 60, zone: 'Europe/Warsaw', note: 'Poland' },
  { code: '420', minutes: 60, zone: 'Europe/Prague', note: 'Czechia' },
  { code: '36', minutes: 60, zone: 'Europe/Budapest', note: 'Hungary' },
  // +1 is the whole of the US and Canada across six zones. Chicago, because that is where Abiozen
  // is and therefore the likeliest counterpart — and because being wrong by two hours inside
  // business hours is harmless, while being wrong by twelve is not.
  { code: '1', minutes: -360, zone: 'America/Chicago', note: 'US/Canada (assumed Central)' },
];
// Longest code first, so +1 cannot swallow +44 and +86 cannot swallow +886.
const ORDERED = [...DIAL_ZONES].sort((a, b) => b.code.length - a.code.length);

/**
 * The timezone guess for a phone number, or null when it cannot be told.
 * Accepts anything the cards actually contain: "+91 98856 68398", "+886 965 232 962",
 * "+1 973-307-5179 (office)".
 */
function zoneForPhone(phone) {
  const raw = String(phone == null ? '' : phone);
  // Only a number written in international form says anything about the country. A bare local
  // number — "98856 68398" — carries no country at all, and reading its leading digits as a
  // dialling code would invent a timezone out of nothing.
  const m = /\+\s*([0-9][0-9\s\-().]*)/.exec(raw);
  if (!m) return null;
  const digits = m[1].replace(/[^0-9]/g, '');
  if (!digits) return null;
  for (const z of ORDERED) {
    if (digits.startsWith(z.code)) return { ...z };
  }
  return null;
}

/** The first zone guess from a list of phone numbers, mobile before office. */
function zoneForContact({ phone_mobile, phone_office } = {}) {
  return zoneForPhone(phone_mobile) || zoneForPhone(phone_office) || null;
}

// A working day, local to the recipient. Narrow on purpose: 09:30 so it does not land in the
// first-thing-in-the-morning triage pile, and 17:00 so it does not look like it was fired off by
// something that does not know what time it is.
const DEFAULT_WINDOW = { startMinutes: 9 * 60 + 30, endMinutes: 17 * 60, days: [1, 2, 3, 4, 5] };

/**
 * Is `at` inside the recipient's working window?
 * Returns { ok, localTime, zone, reason } — `reason` says why not, for the dry run to print.
 *
 * With no zone guess the answer is NOT "send anyway". It is deferred to the caller via
 * ok:false + reason 'zone unknown', because sending at an unknown local hour to somebody you met
 * in person is a worse outcome than sending tomorrow.
 */
function withinWindow(at, zone, window = DEFAULT_WINDOW) {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return { ok: false, reason: 'invalid time' };
  if (!zone) return { ok: false, reason: 'zone unknown', zone: null };

  const localMs = when.getTime() + zone.minutes * 60 * 1000;
  const local = new Date(localMs);
  // getUTC* on a shifted timestamp gives the LOCAL wall clock, without needing a tz database.
  const day = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const hhmm = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  const out = { localTime: hhmm, zone, day };

  if (!window.days.includes(day)) {
    return { ...out, ok: false, reason: day === 0 ? 'Sunday' : (day === 6 ? 'Saturday' : 'non-working day') };
  }
  if (minutes < window.startMinutes) return { ...out, ok: false, reason: 'too early' };
  if (minutes >= window.endMinutes) return { ...out, ok: false, reason: 'too late' };
  return { ...out, ok: true };
}

/**
 * The next moment inside the window, at or after `at`. Used to schedule rather than skip: a step
 * that is due at 2am local should go out at 09:30 local, not be dropped.
 *
 * Steps in 15-minute increments, capped, so a bug cannot spin. Returns null if no slot is found
 * inside ten days, which would mean the window itself is unsatisfiable.
 */
function nextSlot(at, zone, window = DEFAULT_WINDOW) {
  if (!zone) return null;
  let t = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  if (Number.isNaN(t.getTime())) return null;
  const limit = t.getTime() + 10 * 24 * 60 * 60 * 1000;
  // Align to the next quarter hour so sends do not all carry :00 seconds, which is itself a tell.
  t = new Date(Math.ceil(t.getTime() / (15 * 60 * 1000)) * 15 * 60 * 1000);
  while (t.getTime() <= limit) {
    if (withinWindow(t, zone, window).ok) return t;
    t = new Date(t.getTime() + 15 * 60 * 1000);
  }
  return null;
}


// ── A WINDOW OVERRIDE THAT EXPIRES BY ITSELF ─────────────────────────────────
//
// On 12 Oct Naren wanted the whole CPHI list out the same day: it was Monday, the show had finished
// the previous week, and a follow-up that waits for people to drift back into their own business
// hours arrives after the handshake has gone cold. Fifty-one of the seventy-two were in India,
// China and Europe, hours outside their window.
//
// The override is a DATE, never a boolean. A plain on/off flag, set at ten at night on a Monday, is
// a flag nobody remembers to unset — and the cost of forgetting is mail landing at 3am local for
// the rest of the campaign, which is the exact tell this whole module exists to avoid. With an
// expiry, forgetting is harmless: recipient-local hours come back on their own.
//
// Anything that is not a future YYYY-MM-DD means NO override, so every failure mode is the safe
// one. In particular the string "true" does not work, because somebody will try it.
function windowOverrideActive(value, now = new Date()) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const until = Date.parse(`${raw}T23:59:59Z`);
  if (!Number.isFinite(until)) return false;              // e.g. 2026-13-45 matches the shape
  return now.getTime() <= until;
}

module.exports = {
  windowOverrideActive, zoneForPhone, zoneForContact, withinWindow, nextSlot, DEFAULT_WINDOW, DIAL_ZONES };
