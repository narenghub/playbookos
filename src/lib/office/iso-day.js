// ── ONE DATE COERCION, BECAUSE THE NAIVE ONE HAS NOW BEEN WRONG TWICE ────────
//
// Postgres returns DATE and TIMESTAMPTZ columns as JavaScript Date objects, and
// `String(new Date('2026-01-01')).slice(0, 10)` is "Thu Jan 01" — not an ISO day. Compared against
// an ISO string it sorts by the weekday name: "Thu Jan 01" >= "2026-11-06" is TRUE, because
// 'T' > '2'.
//
// That has produced two real defects in this project, both of which looked like working code:
//
//   · the qualification engine told every opportunity it needed the SAM.gov registration renewed,
//     including ones closing seven weeks before it expires, and its deadline-has-passed check
//     could never fire at all
//   · the capability gap report called a capability that expired on 2026-01-01 COVERED
//
// Neither threw. Both produced confident, plausible, wrong business advice. So the coercion lives
// in one place and every caller imports it, rather than each one re-deriving a line that is easy
// to write and easy to write wrongly.
'use strict';

/** A YYYY-MM-DD string, or null. Accepts a Date, an ISO string, or anything Date can parse. */
function isoDay(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** True when `v` is on or before `day`. Null dates are NOT in the past — they are unknown. */
const onOrBefore = (v, day) => { const i = isoDay(v); return i !== null && i <= day; };
/** True when `v` is on or after `day`. Null dates are NOT in the future either. */
const onOrAfter = (v, day) => { const i = isoDay(v); return i !== null && i >= day; };

module.exports = { isoDay, onOrBefore, onOrAfter };
