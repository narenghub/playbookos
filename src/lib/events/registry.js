// ── ONE PLACE THAT KNOWS WHAT AN EVENT IS. ────────────────────────────────────
//
// The CPHI pages were written for one show. `CPHI_EVENT = 'cphi-milan-2026'` appears a dozen times
// in routes.js, `CPHI_ROLES` is fixed to CPHI's four roles, and the role labels live in the front
// end as literals. None of that is wrong for one event; all of it blocks the second.
//
// SCOPE Europe 2026 (Barcelona, 13-14 Oct) is a different KIND of show, which is the real reason
// this needs a registry rather than a second constant:
//
//   CPHI is a SUPPLY floor. Its exhibitors make things; we rank them by what they can sell us, and
//   the question at a booth is "who holds a DMF for this molecule".
//
//   SCOPE is a DEMAND floor. Its attendees RUN CLINICAL TRIALS — clinical operations executives at
//   sponsors, CROs and sites. Nobody there sells us an API. They are the people who BUY from us,
//   and the question at a booth is "what are you running, and what do you need for it".
//
// So the roles are not a relabelling of CPHI's. They are what the company buys FROM US:
//
//   abiozen  — buys molecules, and the QC testing around them
//   aros     — buys an AROS platform subscription
//   linkable — a recruiting agency that buys the LinkAble platform
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ────
//
// It does not touch the AROS codebase. An `aros` role here is a list of companies that might buy an
// AROS subscription, held in PlayNexa, ranked from PlayNexa's own data. That is a prospect list with
// a product name on it, nothing more.
//
// It also does not rename `cphi_exhibitor_matches`. That table is already partitioned by
// `event_slug`, and its unique index is `(event_slug, role, holder_normalized)`, so it stores a
// second event correctly today. The name is a misnomer the moment SCOPE rows land in it — but
// renaming a populated production table to fix a name is a bad trade, so the name stays and this
// comment is the warning.
'use strict';

// A role's `basis` says WHERE its ranking comes from, because the honest answer differs per role and
// the UI must not imply a confidence the data cannot carry. `demand` means the rank is computed from
// clinical_studies — companies we can see running trials. `none` means we hold no ranking signal yet
// and the list is alphabetical until someone works it.
const EVENTS = [
  {
    slug: 'cphi-milan-2026',
    name: 'CPHI Milan 2026',
    city: 'Milan',
    starts: '2026-10-06',
    ends: '2026-10-08',
    kind: 'supply',
    // The order here is the order of the tabs.
    roles: [
      { key: 'supplier',         label: 'Suppliers',        basis: 'dmf',
        note: 'API manufacturers holding an active US Type II DMF for a molecule our pipeline needs.' },
      { key: 'platform_partner', label: 'Partner · Platform', basis: 'none',
        note: 'Sells our platform to its own clients — the EU repeat of the ACBM Partners model. We hold no ranking signal for these, so the list is alphabetical until someone works it.' },
      { key: 'qc_lab',           label: 'Partner · QC',     basis: 'none',
        note: 'Contract analytical labs we recruit into LabConnect. No ranking signal beyond whether the name looks like a lab — order is shape, not quality.' },
      { key: 'buyer',            label: 'Buyers',           basis: 'establishment',
        note: 'Sourced from the FDA establishment register, which is the wrong register for this — see the role note on the page.' },
    ],
  },
  {
    slug: 'scope-europe-2026',
    name: 'SCOPE Europe 2026',
    city: 'Barcelona',
    // 9th Annual Summit for Clinical Ops Executives, InterContinental Barcelona (Fira Center).
    // Workshops run the afternoon of the 12th; the main floor is the 13th and 14th.
    starts: '2026-10-13',
    ends: '2026-10-14',
    kind: 'demand',
    roles: [
      { key: 'abiozen',  label: 'Abiozen', basis: 'demand',
        note: 'Runs clinical trials, so it buys molecules and the QC testing around them. Ranked by the studies we can see it sponsoring.' },
      { key: 'aros',     label: 'AROS',    basis: 'demand',
        note: 'Clinical operations teams who would buy an AROS subscription. Ranked by trial volume as a proxy for operational load — we hold no data on what they use today.' },
      { key: 'linkable', label: 'LinkAble', basis: 'none',
        note: 'Recruiting agencies and site networks who would buy the LinkAble platform. We hold no ranking signal for these yet, so the list is alphabetical — working it is what turns it into a ranking.' },
    ],
  },
];

const BY_SLUG = new Map(EVENTS.map((e) => [e.slug, e]));

// The event a page opens on when none is named. Deliberately the NEAREST UPCOMING event rather than
// a hardcoded slug: on 12 October this must open on SCOPE, not on the show that finished last week.
// Falls back to the most recent past event once everything is behind us, because an empty page is
// worse than a stale one.
function defaultEventSlug(today) {
  const now = (today instanceof Date ? today : new Date(today || Date.now()))
    .toISOString().slice(0, 10);
  const upcoming = EVENTS.filter((e) => e.ends >= now).sort((a, b) => a.starts.localeCompare(b.starts));
  if (upcoming.length) return upcoming[0].slug;
  return EVENTS.slice().sort((a, b) => b.ends.localeCompare(a.ends))[0].slug;
}

function getEvent(slug) {
  return BY_SLUG.get(String(slug || '')) || null;
}

function isEvent(slug) {
  return BY_SLUG.has(String(slug || ''));
}

// Every role key across every event. This is what the CHECK constraint on
// cphi_exhibitor_matches.role must allow — scripts/migrate-cphi-roles.js reads it, so adding a role
// to an event above and running that migration are the only two steps.
function allRoleKeys() {
  const out = [];
  for (const e of EVENTS) for (const r of e.roles) if (!out.includes(r.key)) out.push(r.key);
  return out;
}

function rolesFor(slug) {
  const e = getEvent(slug);
  return e ? e.roles.map((r) => r.key) : [];
}

function roleDef(slug, roleKey) {
  const e = getEvent(slug);
  if (!e) return null;
  return e.roles.find((r) => r.key === roleKey) || null;
}

function isRoleOf(slug, roleKey) {
  return !!roleDef(slug, roleKey);
}

// What the page sends the browser: enough to draw the tabs and the event switcher without the front
// end holding its own copy of any of it.
function publicEvents() {
  return EVENTS.map((e) => ({
    slug: e.slug, name: e.name, city: e.city,
    starts: e.starts, ends: e.ends, kind: e.kind,
    roles: e.roles.map((r) => ({ key: r.key, label: r.label, basis: r.basis, note: r.note })),
  }));
}

module.exports = {
  EVENTS,
  defaultEventSlug,
  getEvent,
  isEvent,
  allRoleKeys,
  rolesFor,
  roleDef,
  isRoleOf,
  publicEvents,
};
