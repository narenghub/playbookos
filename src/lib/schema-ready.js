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
  // inquiry_messages — added 2026-11-11 with the direction CHECK below. Without the table, that
  // constraint probe finds nothing and reports "the constraint is absent", which sends a reader
  // looking for a missing ALTER instead of a missing CREATE. It also belongs here on its own
  // merits: the inquiry agent writes to it on every message, inbound and outbound.
  'inquiry_messages',
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
  // outreach.partner_id — added after 2026-11-06, because this check would not have caught the
  // defect that day. migrate-outreach-partner-scope.js was not in the migrator chain, so a
  // migrator-built database had no partner_id, and src/lib/outreach/index.js upserts with
  // ON CONFLICT (entity_type, entity_id, COALESCE(partner_id, 0)) — which fails outright without it.
  //
  // The server would have started, answered /health 200 with db: connected, and failed every outreach
  // status change. That is the 2026-09-30 shape exactly: green from outside, broken in use. A boot
  // readiness check that lists only the newest release's columns will keep being surprised by the
  // one before it, so a column the application cannot run without belongs here whatever its age.
  ['outreach', 'partner_id'],
]);

// ── A CHECK CONSTRAINT IS THE THIRD WAY A MIGRATION APPLIES ONLY PARTLY ─────
//
// Tables and columns are covered above. A CHECK is neither, and this one is load-bearing: S2 makes
// every buyer-directed message wait for a human, and records the draft as
// direction='outbound_pending'. Deploy that code against an unwidened constraint and the server
// starts, answers /health 200 with db: connected, and silently fails to record a draft that an
// operator is being asked to approve.
//
// That is the shape the note above describes about outreach.partner_id — "green from outside,
// broken in use" — and the same shape as 2026-09-30. So the constraint is asserted at boot, by its
// definition rather than its existence: a constraint of the right NAME that forbids the value is
// exactly as broken as a missing one.
const REQUIRED_CHECK_VALUES = Object.freeze([
  ['inquiry_messages', 'inquiry_messages_direction_check', 'outbound_pending'],
]);

/**
 * Check the schema. Reads only.
 *
 * @returns {{ready: boolean, missingTables: string[], missingColumns: string[],
 *            staleConstraints: string[], error?: string}}
 */
async function check(q) {
  const missingTables = [];
  const missingColumns = [];
  const staleConstraints = [];
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
    for (const [t, name, value] of REQUIRED_CHECK_VALUES) {
      if (missingTables.includes(t)) continue;
      // pg_get_constraintdef gives the clause as the server holds it, so this cannot be fooled by
      // a constraint that exists under the right name with the wrong predicate.
      const r = await q(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
           JOIN pg_class rel ON rel.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = 'public' AND rel.relname = $1 AND c.conname = $2`, [t, name]);
      const def = r.rows[0] && r.rows[0].def;
      if (!def) staleConstraints.push(`${t}.${name} is absent`);
      else if (!String(def).includes(value)) {
        staleConstraints.push(`${t}.${name} does not admit '${value}'`);
      }
    }
  } catch (e) {
    return { ready: false, missingTables, missingColumns, staleConstraints, error: e.message };
  }
  return {
    ready: !missingTables.length && !missingColumns.length && !staleConstraints.length,
    missingTables, missingColumns, staleConstraints,
  };
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
    log('[boot] schema check: ready — required tables, columns and check constraints all present '
      + '(no DDL executed)');
    return r;
  }
  err('[boot] SCHEMA NOT READY — refusing to start.');
  if (r.error) err(`[boot]   the check itself failed: ${r.error}`);
  for (const t of r.missingTables) err(`[boot]   missing table:  ${t}`);
  for (const c of r.missingColumns) err(`[boot]   missing column: ${c}`);
  // Reported in its own words. "stale constraint" and "missing column" send a reader to different
  // places, and a constraint that exists with the wrong predicate would otherwise be invisible.
  for (const c of r.staleConstraints) err(`[boot]   stale constraint: ${c}`);
  err('[boot]');
  err('[boot] Migrations are no longer run at boot (ENG-003). Run them as the migrator role:');
  err('[boot]     node scripts/migrate.js');
  err('[boot]');
  err('[boot] Starting without the schema would give a server that answers /health with 200 while');
  err('[boot] every request fails — which is what the 2026-09-30 outage looked like from outside.');
  exit(1);
  return r;
}

module.exports = { check, assertReadyOrExit, REQUIRED_TABLES, REQUIRED_COLUMNS,
  REQUIRED_CHECK_VALUES };
