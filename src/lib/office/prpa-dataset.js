// ── WHAT THE DATA IN THE TRACKER ACTUALLY IS ─────────────────────────────────
//
// Ruling 27 item 4: "Preserve the 253 real opportunity records as a reproducible development
// dataset. Do not silently treat them as a live, continuously updated production feed."
//
// The records ARE real — harvested from SAM.gov on 2026-11-06, with the fixtures and their hashes
// committed so any run can be reproduced. What they are not is current. Nothing refreshes them: no
// cron, no poller, no background job, because ruling 22 item 8 keeps the endpoint they came from an
// attended manual source.
//
// The risk this module exists to prevent is specific and it is not hypothetical. A board of real
// solicitation numbers with real deadlines looks exactly like a live feed. Somebody opens it in
// three weeks, sees a deadline of 2026-11-16, and believes they still have time — when the deadline
// has passed and the only reason the row is there is that it was harvested once. So every endpoint
// that serves these rows serves `describe()` alongside them, and the dashboard shows it where it
// cannot be missed.
//
// When a live feed exists, this is the module that changes: `mode` becomes 'live', `as_of` comes
// from the last successful harvest, and the banner changes with it. Until then it says what is true.

'use strict';

const { isoDay } = require('./iso-day');

// The harvest these records came from. Both files are committed, and their sha256 is recorded by the
// import batch, so "reproducible" is checkable rather than asserted.
const HARVEST = Object.freeze({
  harvested_at: '2026-11-06',
  source: 'sam.gov/api/prod/sgs/v1/search/',
  source_kind: 'SAM.gov web UI backend — UNDOCUMENTED internal endpoint, no API key',
  fixtures: Object.freeze([
    Object.freeze({
      file: 'fixtures/sam-opportunities-real-2026-11-06.csv',
      rows: 82,
      note: 'wave 1 — the chemistry/lab-targeted harvest',
    }),
    Object.freeze({
      file: 'fixtures/sam-opportunities-wave2-2026-11-06.csv',
      rows: 182,
      note: 'wave 2 — broader harvest across 13 NAICS and 14 PSC codes; 442 harvested, 178 kept',
    }),
    Object.freeze({
      file: 'fixtures/opportunity-descriptions-2026-11-06.json',
      rows: 81,
      note: 'notice bodies from /opps/v2/opportunities/<noticeId> — the search index carries none',
    }),
  ]),
  // 82 + 182 = 264 raw rows; 11 notices appear in both harvests and dedupe on import.
  raw_rows: 264,
  imported_records: 253,
});

// Fields SAM's search index does not reliably populate. Ruling 22 item 6 and ruling 27 item 3 both
// ask for a clear line between confirmed and unconfirmed, and this is that line, in one place.
const UNCONFIRMED_FIELDS = Object.freeze([
  Object.freeze({
    field: 'agency',
    why: 'left empty by the search index for some notices; the full record exposes only an '
      + 'organisation id that does not resolve to a name, so it is reported unstated rather than guessed',
  }),
  Object.freeze({
    field: 'set_aside',
    why: 'can be EMPTY for a notice that IS set aside — N0010426REJ97 carries "NOTICE OF TOTAL SMALL '
      + 'BUSINESS SET-ASIDE" in its text with the field blank. A blank field is not a statement that '
      + 'a notice is unrestricted, and the ranking raises SET_ASIDE_UNVERIFIED when they disagree',
  }),
  Object.freeze({
    field: 'response_deadline',
    why: 'harvested, not verified. Until a human confirms it against the official notice, '
      + 'deadline_confirmed_at is null and is_biddable is false by generated column',
  }),
  Object.freeze({
    field: 'estimated_value_usd',
    why: 'rarely present in the notice at all; absent is absent, never estimated',
  }),
  Object.freeze({
    field: 'description',
    why: 'the search index returns an empty Description for every record. Where a body was fetched '
      + 'separately it is present; where it was not, the product class is UNKNOWN and says so',
  }),
]);

/**
 * What the board must say about itself. Served with every list, detail, queue and import response.
 */
function describe(now = new Date()) {
  const today = isoDay(now);
  const days = Math.max(0, Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${HARVEST.harvested_at}T00:00:00Z`)) / 864e5,
  ));
  return {
    mode: 'development_dataset',
    is_live_feed: false,
    label: 'DEVELOPMENT DATASET — real SAM.gov records, harvested once, NOT a live feed',
    as_of: HARVEST.harvested_at,
    age_days: days,
    // The sentence a person needs when they open this three weeks from now.
    staleness_warning: days === 0
      ? 'Harvested today.'
      : `These records were harvested ${days} day(s) ago and have NOT been refreshed since. `
        + 'Deadlines shown may already have passed. Verify every deadline against the official '
        + 'notice before acting on it.',
    refresh: 'manual only — there is no scheduled or background harvest, by design',
    harvest: HARVEST,
    unconfirmed_fields: UNCONFIRMED_FIELDS,
    reproduce: 'node scripts/rank-opportunities.js --wave all   (ranks the committed fixtures)',
  };
}

// The importer the scheduled harvester writes as. Matching on it is how this file tells an
// automated harvest from a human pasting a CSV — the distinction the banner is about.
const AUTOMATED_IMPORTER = 'harvest@playbookos';

/**
 * What the board must say about itself, READ FROM WHAT ACTUALLY HAPPENED.
 *
 * describe() above is pure and therefore cannot know whether anything has been harvested since the
 * fixtures were committed. Until 2026-11-09 that was fine, because nothing ever was. Then the
 * three-hourly harvester shipped and the banner kept announcing "harvested once, NOT a live feed …
 * refresh: manual only — there is no scheduled or background harvest, by design" above 149 records
 * that had arrived automatically that morning. Every clause of it was false, stated with the same
 * confidence as the true ones, which is the fastest way to teach somebody to stop reading banners.
 *
 * So the live state is read from opportunity_import_batches rather than asserted from a constant.
 * A database with no automated batch still gets the fixture description, which is correct for a
 * fresh install and for anyone who has only ever imported by hand.
 */
async function describeLive(q, now = new Date()) {
  let row = null;
  try {
    row = (await q(
      `SELECT MAX(imported_at) AS last_at, COUNT(*)::int AS runs
         FROM opportunity_import_batches
        WHERE imported_by = $1`, [AUTOMATED_IMPORTER])).rows[0];
  } catch {
    // The table does not exist yet (fresh database, migrations not applied). Not an error here:
    // the fixture description is the honest answer when there is nothing to read.
    return describe(now);
  }
  if (!row || !row.last_at) return describe(now);

  const hours = Math.max(0, (now.getTime() - new Date(row.last_at).getTime()) / 36e5);
  // The schedule is every three hours. Twice that with nothing new means the harvester is not
  // running, and the board must say so rather than quietly ageing.
  const stale = hours > 6.5;
  return {
    mode: 'live_harvest',
    is_live_feed: true,
    label: 'LIVE — real SAM.gov solicitations, harvested automatically every three hours',
    as_of: isoDay(new Date(row.last_at)),
    last_harvest_at: new Date(row.last_at).toISOString(),
    harvest_runs: row.runs,
    age_hours: Math.round(hours * 10) / 10,
    staleness_warning: stale
      ? `The last automatic harvest was ${Math.round(hours)} hours ago, and the schedule is every `
        + 'three. The harvester may have stopped — check the deploy logs before trusting this board '
        + 'to be current.'
      : null,
    refresh: 'automatic — every three hours, via the SAM.gov web interface (undocumented route; '
      + 'it can change without notice, and the job fails loudly rather than returning an empty board)',
    // Deadline confirmation is unchanged and still required: harvesting a deadline is not the same
    // as a person checking it against the official notice.
    unconfirmed_fields: UNCONFIRMED_FIELDS,
    reproduce: 'node scripts/harvest-sam-gov.js --dry-run   (harvests and reports, writes nothing)',
  };
}

module.exports = { describe, describeLive, HARVEST, UNCONFIRMED_FIELDS, AUTOMATED_IMPORTER };
