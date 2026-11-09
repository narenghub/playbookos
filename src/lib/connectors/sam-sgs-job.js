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

  return {
    ok: true,
    stats,
    batchId: r.batchId,
    outcome: r.outcome,
    unmatchedHeaders: r.unmatchedHeaders || [],
  };
}

module.exports = { runHarvestAndImport };
