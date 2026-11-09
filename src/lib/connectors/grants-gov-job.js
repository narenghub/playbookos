// ── THE GRANTS.GOV HARVEST JOB ───────────────────────────────────────────────
//
// One implementation, used by BOTH the cron in server.js and scripts/harvest-grants-gov.js, for
// the reason sam-sgs-job.js gives: a scheduled job that drifts from the command an operator runs
// by hand is a job nobody can reproduce when it misbehaves at 3am.
//
// The adapter (grants-gov.js) and the persistence layer (sync-run.js) already existed and were
// already correct. Nothing called either of them, so `funding_opportunities` held zero rows while
// the connector displayed as ACTIVE. This file is the missing join.
//
// ── ONLY LIVE, OPEN OPPORTUNITIES ────────────────────────────────────────────
//
// Owner instruction, 2026-11-09: "make sure live real contract should be we extract". So the
// search asks for oppStatuses 'posted' and nothing else.
//
// That one word does real work. The API's own default is "forecasted|posted", and a FORECAST IS
// NOT AN OPPORTUNITY — it is an agency saying it intends to publish something later, usually with
// an empty closeDate. In the first probe of this API, five of ten hits were forecasts. Harvesting
// the default would have filled the board with announcements nobody can apply to, each displaying
// a blank deadline that reads like "no deadline" rather than "not real yet".
//
// The adapter derives biddability in the schema as a generated column rather than trusting a
// field, so even a forecast that slipped through could not present itself as submittable. This is
// the belt to that braces.
//
// ── WHY A RUN, AND WHY AN OBJECTIVE ──────────────────────────────────────────
//
// Ingestion writes through sync-run.js, which requires a frozen company context, which comes only
// from an objective. The kernel enforces that with a composite MATCH FULL foreign key: agent work
// cannot be attributed to a company without also naming the stated objective it serves.
//
// So this harvest runs against obj-abiozen-federal-contracts. Attaching it to the pre-existing
// supplier-RFQ objective would have worked and been wrong — every federal record in the system
// filed under an objective it has nothing to do with, invisible until somebody audited it.
//
// ── THE INTENT KEY IS PER FIRING, NOT PER DAY ────────────────────────────────
//
// beginObjectiveRun defaults to a DAY-slot intent key, which makes a second run of the same
// workflow against the same objective on the same day a declined duplicate. Correct for a daily
// review; fatal for a job that runs several times a day — every firing after the first would be
// silently declined and the board would look stale for no visible reason. cronIntentKey carries a
// minute slot, so each firing is its own intent while a double-fire of the same minute is still
// refused.
'use strict';

const G = require('./grants-gov');
const sync = require('./sync-run');
const { beginObjectiveRun } = require('../office/run');
const { cronIntentKey } = require('../runs');

const OBJECTIVE_ID = 'obj-abiozen-federal-contracts';
const SOURCE_KEY = 'grants_gov';

// Keywords, one search each. Chosen to cover the four business lines rather than to maximise
// volume: a keyword that returns thousands of records returns thousands of irrelevant ones, and
// relevance is decided downstream by opportunity-relevance.js, not by how wide the net was.
const DEFAULT_KEYWORDS = Object.freeze([
  'pharmaceutical',
  'analytical laboratory',
  'drug discovery',
  'custom synthesis',
  'clinical laboratory testing',
  'active pharmaceutical ingredient',
]);

const ROWS_PER_SEARCH = 50;

/**
 * Harvest live grants.gov funding opportunities into funding_opportunities.
 *
 * @param {object} opts  { log, dryRun, keywords, rows, now }
 * @returns {{ok: boolean, stats: object, error?: string}}
 */
async function runGrantsHarvest({
  log = () => {},
  dryRun = false,
  keywords = DEFAULT_KEYWORDS,
  rows = ROWS_PER_SEARCH,
  now = new Date(),
  deps = {},
} = {}) {
  // Collaborators are injectable so the decisions this file makes — posted-only, forecast
  // exclusion, zero-records-is-a-failure, stop-on-ceiling — can be tested without a database or a
  // network. The defaults are the real ones; a test supplies fakes, nothing else does.
  const search = deps.search || ((body) => G.fetchSearch(body));
  const startRun = deps.beginObjectiveRun || beginObjectiveRun;
  const S = deps.sync || sync;

  const stats = {
    keywords: keywords.length,
    searched: 0,
    seen: 0,
    normalized: 0,
    skipped: 0,
    inserted: 0,
    updated: 0,
    forecastsExcluded: 0,
    errors: [],
  };

  // ── 1. A RUN, DERIVED FROM THE OBJECTIVE ─────────────────────────────────
  const begun = await startRun({
    objectiveId: OBJECTIVE_ID,
    trigger: 'cron',
    triggerDetail: 'grants-gov-harvest',
    workflow: 'federal-funding-harvest',
    agent: 'grants-gov-connector',
    product: 'abiozen',
    intentKey: cronIntentKey('grants-gov-harvest', now),
  }, deps);

  if (begun.duplicate) {
    // Another firing of the same minute already owns this intent. Declined, not failed.
    log('  declined: another run already owns this intent');
    return { ok: true, stats, declined: true };
  }

  const ctx = begun.context;
  log(`  run ${String(begun.runId).slice(0, 8)}… · objective ${OBJECTIVE_ID}`);

  // ── 2. OPEN THE SYNC ─────────────────────────────────────────────────────
  // beginSync refuses a connector that is not activated, and refuses manual_assisted sources
  // outright. Those refusals are the point and are not caught here — a refusal must reach the
  // caller, not be logged and shrugged off.
  const { syncId } = await S.beginSync(ctx, { sourceKey: SOURCE_KEY, runId: begun.runId }, deps);

  try {
    const collected = [];
    for (const keyword of keywords) {
      // Charge BEFORE the call, never after. Counting afterwards discovers the overrun by
      // receiving a 429 mid-page, which is exactly the half-finished state the watermark rule
      // exists to protect against.
      const charge = await S.chargeCalls(ctx, syncId, 1, deps);
      if (!charge.allowed) {
        log(`  ceiling reached before "${keyword}" — stopping, not retrying`);
        await S.endSyncUnsuccessfully(ctx, syncId,
          { status: 'ceiling_reached', error: `daily call ceiling ${charge.ceiling} reached` }, deps);
        return { ok: false, stats, error: 'daily call ceiling reached' };
      }

      let res;
      try {
        res = await search(G.buildSearchRequest({
          keyword,
          rows,
          startRecordNum: 0,
          // LIVE ONLY. See the header: the API default would include forecasts.
          oppStatuses: 'posted',
        }));
      } catch (e) {
        stats.errors.push(`${keyword}: ${e.message}`);
        log(`  "${keyword}" FAILED — ${e.message}`);
        continue;
      }

      stats.searched += 1;
      stats.seen += res.hits.length;
      log(`  "${keyword}": ${res.hits.length} of ${res.hitCount == null ? '?' : res.hitCount}`);

      for (const hit of res.hits) {
        // Belt to the schema's braces. A forecast reaching this point would mean the API ignored
        // oppStatuses, which is worth knowing about rather than silently storing.
        if (String(hit.docType || '').toLowerCase() === 'forecast'
            || String(hit.oppStatus || '').toLowerCase() === 'forecasted') {
          stats.forecastsExcluded += 1;
          continue;
        }
        collected.push(G.normalizeSearchHit(hit, { companyId: ctx.companyId }));
      }
    }

    // ZERO RECORDS SEEN IS A FAILURE, NOT AN EMPTY DAY.
    //
    // Measured 2026-11-09: "pharmaceutical" alone returns 24 posted opportunities and "analytical
    // laboratory" returns 292. These keywords have standing federal activity. Zero across all of
    // them means the request shape changed or the host stopped answering — and an empty harvest
    // reported as success is indistinguishable from "nothing was posted today", which is the
    // calm, plausible, completely wrong answer.
    if (stats.searched > 0 && stats.seen === 0) {
      await S.endSyncUnsuccessfully(ctx, syncId,
        { status: 'failed', error: 'every search returned zero records' }, deps);
      return {
        ok: false,
        stats,
        error: 'grants.gov returned zero records across every keyword — the request shape or the '
             + 'host has changed. Verify by hand before trusting the board.',
      };
    }
    if (stats.searched === 0) {
      await S.endSyncUnsuccessfully(ctx, syncId,
        { status: 'failed', error: 'no search completed' }, deps);
      return { ok: false, stats, error: 'no grants.gov search completed — see errors' };
    }

    const usable = collected.filter((n) => n && !n.skip);
    stats.normalized = usable.length;
    stats.skipped = collected.length - usable.length;

    if (dryRun) {
      await S.endSyncUnsuccessfully(ctx, syncId,
        { status: 'failed', error: 'dry run — no rows written' }, deps);
      return { ok: true, stats, dryRun: true };
    }

    const up = await S.upsertFundingOpportunities(ctx, syncId, collected, deps);
    stats.inserted = up.inserted;
    stats.updated = up.updated;

    // The watermark moves only here, only on success.
    await S.completeSync(ctx, syncId,
      { highWaterMark: now.toISOString().slice(0, 10) }, deps);

    log(`  ingested: ${up.inserted} new · ${up.updated} updated · ${stats.skipped} skipped`);
    return { ok: true, stats };
  } catch (e) {
    // A thrown error must close the run, or the sync sits 'running' forever and the next firing
    // reads a watermark that was never earned.
    try {
      await S.endSyncUnsuccessfully(ctx, syncId, { status: 'failed', error: e.message }, deps);
    } catch { /* the original error is the one that matters */ }
    return { ok: false, stats, error: e.message };
  }
}

module.exports = {
  runGrantsHarvest,
  OBJECTIVE_ID,
  SOURCE_KEY,
  DEFAULT_KEYWORDS,
  ROWS_PER_SEARCH,
};
