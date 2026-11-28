// ── POSITIVE IDENTIFICATION OF AN ISOLATED DEVELOPMENT DATABASE ──────────────
//
// Owner's directive of 2026-11-27: *"Require positive development database identification before
// registry access or enrollment."*
//
// ── WHY THIS IS NOT scripts/lib/db-identity.js ───────────────────────────────
//
// `scripts/lib/db-identity.js` is the richer check and remains the one every development SCRIPT
// uses. It is deliberately under `scripts/`, and its own header says why it must not move:
//
//   *"that tree is what runs on the Mac, and this module names `email.send`, `email_log` and
//    `outreach_sends` as things to DETECT. A scanner cannot tell a detection string from an
//    outbound path."*
//
// The enrollment sink lives in `src/lib/worker/identity.js`, so importing that module here would
// drag those detection strings into `src/` and trip the standing scanner that caught it before.
//
// So this asks the POSITIVE question instead, which needs no business-table names at all:
//
//   is every table in this database one that a declared development schema module creates?
//
// A database holding anything else is `undeclared` and refused. That is strictly a positive
// identification — something must affirmatively say development, which is the same stance
// `db-identity.js` takes in its step 3 — and it names no production table anywhere, so the scanner
// has nothing to misread. It is also the stronger formulation: a check that enumerates what is
// ALLOWED cannot be defeated by a table nobody thought to blocklist.
//
// It does NOT replace `db-identity.js`. That module additionally detects production's three STOP
// rows and populated business tables, which catches a development database restored from a
// production dump. Scripts must keep calling it. This is the narrower in-process gate the sink can
// reach.
//
// ── THE DECLARED SET, AND WHY FOUR NAMES ARE WRITTEN BY HAND ─────────────────
//
// Most development schema modules export their `DDL`, so their tables are derived from the
// statements themselves and cannot drift. Four cannot be derived: `src/lib/autonomy.js` and
// `src/lib/runs.js` export `migrateAutonomy` / `migrateRuns` and no DDL array, so there is nothing
// to parse without executing them.
//
// A hand-written list is a liability and this project has already paid for one — `db-identity.js`
// records that its own list *"was short by seven tables, because it was written from memory rather
// than from the migrations."* So the same remedy applies: `scripts/check-dev-operator-registry-db.js`
// runs the real migrations against a disposable Postgres and fails if anything they create is not
// covered here. The list cannot go stale silently; the test turns red the moment it does.

'use strict';

/**
 * Tables created by the two development schema modules that export no DDL array.
 * Covered by scripts/check-dev-operator-registry-db.js, which runs the migrations and compares.
 */
const UNDERIVABLE_TABLES = Object.freeze([
  // src/lib/autonomy.js — migrateAutonomy
  'autonomy_stops', 'autonomy_events',
  // src/lib/runs.js — migrateRuns
  'agent_runs', 'agent_run_events',
]);

/** Modules whose exported DDL declares the rest. */
function declaredModules() {
  return [
    require('../office/schema'),
    require('../m76/schema'),
    require('./identity-schema'),
    require('./task-schema'),
    require('./audit'),
    require('./dev-operators-schema'),
  ];
}

/** Every table name a declared development schema module creates. */
function declaredTables() {
  const out = new Set(UNDERIVABLE_TABLES);
  for (const m of declaredModules()) {
    for (const raw of [].concat((m && m.DDL) || [])) {
      for (const match of String(raw)
        .matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) {
        out.add(match[1].toLowerCase());
      }
    }
  }
  return out;
}

/**
 * Reports whether the connected database is an isolated development database. Read-only.
 *
 * Never throws for an ordinary failure: a database that cannot be inspected is `cannot_tell`, which
 * the caller must treat as a refusal rather than as permission — the same contract
 * `db-identity.js` sets, and for the same reason.
 *
 * @returns {{ok: boolean, verdict: string, undeclared: string[], tables: string[], detail: string}}
 */
async function identifyIsolatedDevelopment(query) {
  let tables;
  try {
    const r = await query(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`);
    tables = r.rows.map((x) => String(x.tablename).toLowerCase());
  } catch (e) {
    return { ok: false, verdict: 'cannot_tell', undeclared: [], tables: [],
      detail: `the table list could not be read: ${String(e && e.message).slice(0, 160)}` };
  }

  const declared = declaredTables();
  const undeclared = tables.filter((t) => !declared.has(t));

  if (undeclared.length) {
    return {
      ok: false,
      verdict: 'undeclared',
      undeclared,
      tables,
      detail: `${undeclared.length} table(s) that no declared development schema module creates: `
        + `${undeclared.slice(0, 8).join(', ')}${undeclared.length > 8 ? ', …' : ''}`,
    };
  }

  return {
    ok: true,
    verdict: 'isolated_development',
    undeclared: [],
    tables,
    detail: tables.length
      ? `${tables.length} table(s), every one of them declared by a development schema module`
      : 'the database is empty — nothing has been created here yet',
  };
}

module.exports = {
  identifyIsolatedDevelopment, declaredTables, UNDERIVABLE_TABLES,
};
