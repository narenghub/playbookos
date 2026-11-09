// ── THE HARVEST JOB ──────────────────────────────────────────────────────────
//
// One implementation, used by BOTH the cron in server.js and scripts/harvest-sam-gov.js. Keeping
// them on one path is the point: a scheduled job that drifts from the command an operator runs by
// hand is a job nobody can reproduce when it misbehaves at 3am.
//
// Returns a result object rather than printing or exiting, so the caller decides what a failure
// means — an exit code for the CLI, an alert for the cron.

'use strict';

const SGS = require('./sam-sgs');
const T = require('../office/opportunity-tracker');

const COMPANY_SQL = `SELECT id, slug, display_name AS name
                       FROM companies WHERE slug = $1 AND status = 'active' LIMIT 1`;

/**
 * Harvest active biddable SAM.gov notices and import them.
 *
 * @param {Function} q      the database query function
 * @param {object}   opts   { log, dryRun, harvestOpts }
 * @returns {{ok: boolean, stats: object, outcome?: object, batchId?: string, error?: string}}
 */
async function runHarvestAndImport(q, { log = () => {}, dryRun = false, harvestOpts = {} } = {}) {
  const { rows, stats } = await SGS.harvest({ log, ...harvestOpts });

  // ZERO RECORDS SEEN IS A FAILURE, NOT AN EMPTY DAY.
  //
  // Every NAICS code queried here has standing federal activity measured in hundreds of notices.
  // Seeing none of them means the route moved, the response shape changed, or the host started
  // refusing us — all of which produce an empty board that looks exactly like a quiet market.
  // This is the single check that keeps an undocumented dependency honest, and it is the reason
  // this harvester is allowed to exist at all.
  if (stats.recordsSeen === 0) {
    return {
      ok: false,
      stats,
      error: 'harvest saw ZERO records across every NAICS code — the route or its response shape '
           + `has changed. Verify ${SGS.SGS_SEARCH} by hand before trusting the board.`,
    };
  }

  if (dryRun) return { ok: true, stats, dryRun: true, rows };

  const slug = process.env.PRPA_COMPANY_SLUG || 'abiozen';

  // Descriptions we already hold are CARRIED FORWARD onto the row, not left blank.
  //
  // importRecords computes a content hash that INCLUDES the description. Sending an empty one for
  // a notice whose text we already stored would read as a change, raise a false amendment, and
  // replace the stored text with nothing — losing the very thing this fetch exists to collect.
  // So the stored description is copied onto the row first, and only the genuinely missing ones
  // are fetched. One request per notice is affordable for a backlog once; it is not affordable
  // every three hours forever.
  const have = new Set();
  try {
    const held = await q(
      `SELECT notice_id, description FROM federal_opportunities
        WHERE is_current AND description IS NOT NULL AND btrim(description) <> ''`);
    const byId = new Map(held.rows.map((r) => [r.notice_id, r.description]));
    for (const row of rows) {
      const existing = byId.get(row.NoticeId);
      if (existing) { row.Description = existing; have.add(row.NoticeId); }
    }
  } catch { /* table absent: fetch everything, which is correct on a fresh database */ }

  // Most descriptions arrive with the search result itself. This only chases the few that did not
  // — a notice whose text the index omitted — and skips anything already carrying one.
  const needing = rows.filter((r) => !String(r.Description || '').trim() && !have.has(r.NoticeId));
  log(`  descriptions: ${rows.length - needing.length} present · fetching ${needing.length} missing`);
  stats.descriptions = await SGS.fetchDescriptions(needing, { have, log });
  log(`    fetched ${stats.descriptions.fetched} · skipped ${stats.descriptions.skipped} `
    + `· none published ${stats.descriptions.empty} · failed ${stats.descriptions.failed}`);
  const c = await q(COMPANY_SQL, [slug]);
  if (!c.rows.length) {
    return { ok: false, stats, error: `no active company with slug "${slug}"` };
  }

  const r = await T.importCsv(q, {
    companyId: c.rows[0].id,
    importedBy: 'harvest@playbookos',
    csvText: SGS.toCsv(rows),
    source: 'url',
    sourceDetail: `automated harvest ${new Date().toISOString()} from ${SGS.SGS_SEARCH} `
      + '(SAM.gov web UI backend, no API key, UNDOCUMENTED — see src/lib/connectors/sam-sgs.js)',
  });

  // ── CLOSE WHAT HAS EXPIRED ─────────────────────────────────────────────────
  //
  // A notice arrives open and stays open in our database forever, because status comes from the
  // source and the source stops mentioning a notice once it closes. So a solicitation whose own
  // deadline passed last night still reads `open` this morning — measured 2026-11-09, where the
  // soonest deadline on the board was already in the past.
  //
  // That is not cosmetic. It inflates the pipeline with work nobody can win, and the owner's
  // instruction is explicit: an expired contract is nothing we can act on.
  //
  // Narrow on purpose. Only rows that are current, only ones still marked open, only ones whose
  // deadline is both present and genuinely in the past. A NULL deadline is never swept — unknown
  // is not expired. `awarded` and `cancelled` are left alone: they are more specific than
  // `closed` and this sweep knows nothing that would justify overwriting them.
  stats.expired = 0;
  try {
    const swept = await q(
      `UPDATE federal_opportunities
          SET status = 'closed'
        WHERE is_current
          AND status = 'open'
          AND response_deadline IS NOT NULL
          AND response_deadline < NOW()
        RETURNING solicitation_number`);
    stats.expired = swept.rowCount;
    if (swept.rowCount) {
      log(`  expired: closed ${swept.rowCount} past-deadline solicitation(s)`);
    }
  } catch (e) {
    // A failed sweep must not fail a harvest that otherwise succeeded — the imported rows are
    // still correct and still worth keeping. Reported, never swallowed silently.
    stats.expiredError = e.message;
    log(`  expired: sweep FAILED — ${e.message}`);
  }

  return {
    ok: true,
    stats,
    batchId: r.batchId,
    outcome: r.outcome,
    unmatchedHeaders: r.unmatchedHeaders || [],
  };
}

module.exports = { runHarvestAndImport };
