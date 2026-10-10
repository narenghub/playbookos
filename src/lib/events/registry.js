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
        note: 'Buys molecules and the QC testing around them. The CRO/CDMO names are on the floor; the sponsors behind them are attendees, and each row carries the studies and patients it is running so the opening line is theirs, not ours.' },
      // AROS is the Autonomous Regulatory Operating System — regulatory and compliance tracking.
      // Its buyers are therefore SPONSOR COMPANIES, who carry the FDA regulatory file for their own
      // trials. An earlier version of this seeded the 25 eClinical platforms exhibiting at SCOPE,
      // which was wrong twice over: they are competitors, and they are not who carries a regulatory
      // burden. `demand` is right here because trial volume IS the compliance surface.
      { key: 'aros',     label: 'AROS',    basis: 'demand',
        note: 'Sponsor companies that carry their own FDA regulatory and compliance file, and would buy an AROS subscription to track it. More trials, more countries and later phase means more compliance surface — which is the pitch and also the ranking. Not the eClinical platforms exhibiting here: those are competitors.' },
      // EMPLOYMENT agencies — firms that place people into jobs — not patient-recruitment firms,
      // which enrol patients into trials. Adjacent words, different business, and seeding the second
      // kind here filled the tab with 16 companies that would never buy a recruiting OS.
      // ── THE TAB NARESH'S ORLANDO TRIP ARGUED FOR ────
      //
      // At SCOPE Orlando he found "so many labs and buyers, clinical institutes who run CRO and
      // support CRO". Those people are DELEGATES, not exhibitors, which is why the 61-sponsor list
      // looked so thin — and it is the same reason the Abiozen buyers are attendees.
      //
      // A lab is a different conversation from everything else on this page: we are RECRUITING it
      // into LabConnect, not selling to it. Same meaning as CPHI's qc_lab, so the same key — see
      // SHARED_ROLE_KEYS below for why sharing one is safe and why the guard that forbade it was
      // reasoning from the wrong thing.
      { key: 'qc_lab',   label: 'QC Partners', basis: 'none',
        note: 'Analytical and QC laboratories to recruit into LabConnect — we are buying their capacity, not selling to them. Sourced from the labs register rather than the sponsor list, because labs attend SCOPE as delegates and barely exhibit. No ranking signal beyond activity and whether we hold a contact, so order is shape, not quality.' },
      { key: 'linkable', label: 'LinkAble', basis: 'none',
        note: 'Staffing and employment agencies that would subscribe to the recruiting OS — firms whose product is placing PEOPLE INTO JOBS, not patient recruitment and not functional service providers who staff a trial as delivery. None is a published SCOPE sponsor: all 61 were checked and not one places people, because SCOPE exhibitors sell software, data, logistics and lab services TO trial sponsors. So this list is RESEARCHED rather than taken off the floor, the same way the research institutions and the QC labs are, and like them nobody here is a confirmed attendee — the check is the attendee app on site. No ranking signal exists in the data for these, so there is no computed order: each row instead states in its own note how squarely clinical placement is that firm\'s core business — a judgement made by hand at research time, which is why it is written out rather than turned into a score. The sponsors and CROs on the other tabs are LinkAble\'s DEMAND side — they have the jobs — not its subscribers.' },
    ],
  },
];

// ── ROLE KEYS SHARED BETWEEN EVENTS, DELIBERATELY ────
//
// A test used to assert that NO role key appeared in both a supply event and a demand event, on the
// reasoning that "a shared role would mix sellers into a buyer list". THAT REASONING WAS WRONG, and
// it is worth recording why rather than quietly deleting the test.
//
// Rows are keyed `(event_slug, role, holder_normalized)` and every query filters on event_slug AND
// role, so CPHI's qc_lab rows and SCOPE's qc_lab rows can never answer each other's question. The
// partition was already doing the job the guard thought it was doing.
//
// The REAL risk is different and the guard could not see it: a key that means one thing on one
// floor and something else on another. `qc_lab` does not have that problem — a QC laboratory is a
// LabConnect recruit at both shows, which is exactly why it should be ONE key rather than a second
// one invented to satisfy a test. Two keys for one concept is the drift this registry exists to end.
//
// So sharing is allowed, but only when it is declared here with the reason. An undeclared shared key
// still fails, because the next one may be the case where the meanings really do diverge.
const SHARED_ROLE_KEYS = {
  qc_lab: 'An analytical/QC laboratory is a LabConnect recruit on both floors — we buy its capacity, ' +
          'never sell to it. One concept, one key; the (event_slug, role) partition keeps the rows apart.',
};

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
  SHARED_ROLE_KEYS,
  defaultEventSlug,
  getEvent,
  isEvent,
  allRoleKeys,
  rolesFor,
  roleDef,
  isRoleOf,
  publicEvents,
};
