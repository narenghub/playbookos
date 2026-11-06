// ── WHAT BOOT DOES INSTEAD OF MIGRATING ──────────────────────────────────────
//
// ENG-003. `server.js` used to apply about a dozen migrations at boot, which is why the application
// needed DDL and therefore ran as a superuser. This replaces that with a READ: are the tables the
// application needs present?
//
// Every query here is a `SELECT`. No CREATE, no ALTER, no INSERT. A role with SELECT on the
// application's tables and nothing else can run all of it — which is the whole point, and is what
// `scripts/check-startup-without-ddl.js` proves by booting it as exactly such a role.
//
// ── IT FAILS CLOSED, LOUDLY ──────────────────────────────────────────────────
//
// If the schema is missing, the application exits non-zero with the command to run. The alternative
// — start anyway and let every request 500 — is how the 2026-09-30 outage looked from the outside:
// a healthy-looking server in front of an application that could not work. `/health` returning 200
// while nothing functions is the specific failure this repository has already paid for once.
//
// ── to_regclass, NOT information_schema ──────────────────────────────────────
//
// `to_regclass('public.x')` is one call, respects search_path, and returns NULL rather than raising
// for a missing relation. An `information_schema.tables` query would also work but needs a row-count
// comparison to distinguish "absent" from "present but unreadable", and unreadable is the case that
// matters for a restricted role.

'use strict';

// Tables the application cannot serve a request without. Deliberately not "every table": a table
// used by one optional agent should not stop the server, and listing all ~60 would make this a
// second schema definition to keep in sync.
const REQUIRED_TABLES = Object.freeze([
  // auth and the shell. notifications and outreach are here because the SPA requests both on
  // EVERY page load — /api/notifications and /api/outreach/tasks — and on a freshly migrated
  // database they 500'd, because the scripts that create them were in no migration chain and were
  // run by hand. A readiness check that omits them would call that database ready.
  'users', 'activity_logs', 'notifications', 'outreach',
  // the office kernel every company-welded table references
  'companies',
  // PRPA — the product this release is for
  'federal_opportunities', 'opportunity_import_batches', 'opportunity_assessments',
  'opportunity_bid_reviews', 'opportunity_duplicate_candidates', 'opportunity_audit_events',
  'verified_capabilities',
]);

// Columns whose absence means a migration applied only partly — the case a table-existence check
// alone reports as healthy. `is_biddable` is the one that matters most: it is a generated column
// added by v4, and without it the review queue silently treats everything as not biddable.
const REQUIRED_COLUMNS = Object.freeze([
  ['federal_opportunities', 'is_biddable'],
  ['federal_opportunities', 'deadline_confirmed_at'],
  ['federal_opportunities', 'version_seq'],
  ['opportunity_assessments', 'evidence_basis'],
  ['verified_capabilities', 'evidence_class'],
]);

/**
 * Check the schema. Reads only.
 *
 * @returns {{ready: boolean, missingTables: string[], missingColumns: string[], error?: string}}
 */
async function check(q) {
  const missingTables = [];
  const missingColumns = [];
  try {
    for (const t of REQUIRED_TABLES) {
      const r = await q(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${t}`]);
      if (!r.rows[0] || r.rows[0].present !== true) missingTables.push(t);
    }
    // Skip the column check for a table that is absent — "is_biddable is missing" is noise when the
    // whole table is missing, and it would triple the output of a fresh database.
    for (const [t, c] of REQUIRED_COLUMNS) {
      if (missingTables.includes(t)) continue;
      const r = await q(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
         ) AS present`, [t, c]);
      if (!r.rows[0] || r.rows[0].present !== true) missingColumns.push(`${t}.${c}`);
    }
  } catch (e) {
    return { ready: false, missingTables, missingColumns, error: e.message };
  }
  return { ready: !missingTables.length && !missingColumns.length, missingTables, missingColumns };
}

/**
 * Check, report, and exit non-zero if the schema is not ready.
 *
 * Called by server.js in place of the old migration chain. `exit` is injectable so the checker can
 * assert the failure path without killing its own process.
 */
async function assertReadyOrExit(q, { log = console.log, err = console.error, exit = process.exit } = {}) {
  const r = await check(q);
  if (r.ready) {
    log('[boot] schema check: ready — all required tables and columns present (no DDL executed)');
    return r;
  }
  err('[boot] SCHEMA NOT READY — refusing to start.');
  if (r.error) err(`[boot]   the check itself failed: ${r.error}`);
  for (const t of r.missingTables) err(`[boot]   missing table:  ${t}`);
  for (const c of r.missingColumns) err(`[boot]   missing column: ${c}`);
  err('[boot]');
  err('[boot] Migrations are no longer run at boot (ENG-003). Run them as the migrator role:');
  err('[boot]     node scripts/migrate.js');
  err('[boot]');
  err('[boot] Starting without the schema would give a server that answers /health with 200 while');
  err('[boot] every request fails — which is what the 2026-09-30 outage looked like from outside.');
  exit(1);
  return r;
}

module.exports = { check, assertReadyOrExit, REQUIRED_TABLES, REQUIRED_COLUMNS };
