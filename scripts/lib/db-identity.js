// ── IS THIS PRODUCTION'S DATA? ASK THE DATABASE, NOT THE HOSTNAME ───────────
//
// Lives under scripts/lib/, NOT src/lib/worker/. It was written there first and a standing test
// caught it: that tree is what runs on the Mac, and this module names `email.send`, `email_log` and
// `outreach_sends` as things to DETECT. A scanner cannot tell a detection string from an outbound
// path, and the worker runtime should not gain a module it never loads. This is a
// development-environment concern and belongs with the development scripts.
//
// Every M7 development script refused a production database by matching its HOSTNAME. On
// 2026-11-16 that turned out to be the wrong question, and the wrong answer in both directions.
//
// Railway's private DNS is scoped to a project and environment. `postgres.railway.internal` inside
// playnexa-m7-dev resolves to the DEVELOPMENT Postgres and physically cannot reach production's.
// The blocklist treated that string as production because it was written assuming one global
// namespace. The cost of the mistake was not theoretical: the workaround on offer was to give the
// development database a public internet address, which is a permanent weakening of a real system
// to satisfy a check that was aimed at the wrong thing.
//
// And in the other direction, a hostname proves nothing about content. A development database
// restored from a production dump has a development hostname and production's data in it.
//
// So this asks the database what it contains. That answer holds whatever URL was used — a private
// name, a public proxy, or `localhost` at the end of a `railway connect` tunnel.
//
// ── WHAT COUNTS AS IDENTIFIED ───────────────────────────────────────────────
//
// `development` is claimed ONLY for a database that is empty, or that holds nothing but the tables
// the M7 worker itself creates. Everything else is `unidentified` — not "probably fine". The
// caller refuses on anything that is not `development`, so the default for an unrecognised shape
// is to stop, not to proceed.
//
// Nothing here writes. Every statement is a SELECT.

'use strict';

// Tables that exist only in a real PlaybookOS database. Finding any of them POPULATED means this is
// not a scratch database, whatever it is called.
const PRODUCTION_TABLES = ['users', 'orders', 'email_log', 'targets', 'buyer_contacts',
  'apollo_sequences', 'outreach_sends', 'agent_activity_log'];

// The three STOP rows that are production's containment. Their presence means this database either
// IS production or was restored from it — either way, not somewhere to run a migration.
const PRODUCTION_STOPS = [
  ['capability', 'email.send'],
  ['workflow', 'legacy-inquiry-buyer-email'],
  ['workflow', 'legacy-supplier-rfq-email'],
];

// Every table the six development migrations create. HAND-WRITTEN, which is a liability: the first
// version of this list was short by seven tables, because it was written from memory rather than
// from the migrations. scripts/check-db-identity-db.js now runs those migrations and fails if the
// result is not covered here, so the list cannot drift silently again — a missing entry makes a
// freshly migrated database read as `unidentified` and refuses every subsequent run.
const M7_TABLES = [
  // autonomy
  'autonomy_stops', 'autonomy_events',
  // runs
  'agent_runs', 'agent_run_events',
  // office
  'companies', 'objectives', 'office_approvals', 'office_cost_ledger',
  'office_exceptions', 'office_outcomes', 'office_recoveries',
  // M7.1 / M7.2 / M7.3
  'worker_identities', 'worker_enrollment_tokens', 'worker_request_nonces',
  'worker_tasks', 'worker_results', 'worker_audit',
];

const VERDICT = Object.freeze({
  DEVELOPMENT: 'development',
  PRODUCTION_FINGERPRINT: 'production_fingerprint',
  UNIDENTIFIED: 'unidentified',
  CANNOT_TELL: 'cannot_tell',
});

/**
 * Inspects the connected database and reports what it is. Read-only.
 *
 * Returns { verdict, findings[], tables, detail } and never throws for an ordinary failure —
 * a database that cannot be inspected is `cannot_tell`, which the caller must treat as a refusal
 * rather than as permission.
 */
async function identifyDatabase(query) {
  const findings = [];
  let tables = [];

  try {
    const r = await query(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`);
    tables = r.rows.map((x) => x.tablename);
  } catch (e) {
    return { verdict: VERDICT.CANNOT_TELL, findings: [], tables: [],
      detail: `the table list could not be read: ${String(e.message).slice(0, 160)}` };
  }

  // ── 1. PRODUCTION'S CONTAINMENT ROWS ──────────────────────────────────────
  if (tables.includes('autonomy_stops')) {
    try {
      const stops = await query(
        `SELECT scope_type, scope_key FROM autonomy_stops
          WHERE (scope_type, scope_key) IN (($1,$2),($3,$4),($5,$6))`,
        PRODUCTION_STOPS.flat());
      if (stops.rows.length) {
        findings.push(`${stops.rows.length} of production's three STOP rows are present `
          + `(${stops.rows.map((s) => `${s.scope_type}|${s.scope_key}`).join(', ')})`);
      }
    } catch (e) {
      return { verdict: VERDICT.CANNOT_TELL, findings, tables,
        detail: `autonomy_stops could not be inspected: ${String(e.message).slice(0, 160)}` };
    }
  }

  // ── 2. POPULATED BUSINESS TABLES ──────────────────────────────────────────
  //
  // Presence alone is not the test: `scripts/migrate.js` creates these empty, and somebody may have
  // run it here by mistake without any data landing. ROWS are what make it somebody's real data.
  for (const t of PRODUCTION_TABLES) {
    if (!tables.includes(t)) continue;
    try {
      // A LIMIT 1 existence probe rather than COUNT(*): on a large production table a full count is
      // slow, and the question is only whether anything is in there.
      const r = await query(`SELECT 1 AS present FROM ${t} LIMIT 1`);
      if (r.rows.length) findings.push(`${t} exists and contains data`);
    } catch (e) {
      return { verdict: VERDICT.CANNOT_TELL, findings, tables,
        detail: `${t} could not be inspected: ${String(e.message).slice(0, 160)}` };
    }
  }

  if (findings.length) {
    return { verdict: VERDICT.PRODUCTION_FINGERPRINT, findings, tables,
      detail: 'this database carries production\'s fingerprint' };
  }

  // ── 3. POSITIVE IDENTIFICATION ────────────────────────────────────────────
  //
  // Not "no fingerprint found, carry on". Something must affirmatively say development.
  const unexpected = tables.filter((t) => !M7_TABLES.includes(t));
  if (tables.length === 0) {
    return { verdict: VERDICT.DEVELOPMENT, findings, tables,
      detail: 'the database is empty — nothing has been created here yet' };
  }
  if (unexpected.length === 0) {
    return { verdict: VERDICT.DEVELOPMENT, findings, tables,
      detail: `${tables.length} table(s), all of them created by the M7 worker subsystem` };
  }

  return {
    verdict: VERDICT.UNIDENTIFIED,
    findings,
    tables,
    detail: `${unexpected.length} table(s) that are neither empty nor part of M7: `
      + `${unexpected.slice(0, 8).join(', ')}${unexpected.length > 8 ? ', …' : ''}`,
  };
}

/**
 * The caller's gate. Prints what was found and returns true only for `development`.
 *
 * `log` is injectable so the three scripts can present it in their own style, and so the tests can
 * capture it rather than parsing stdout.
 */
async function assertDevelopmentDatabase(query, { log = console.log } = {}) {
  const id = await identifyDatabase(query);

  if (id.verdict === VERDICT.DEVELOPMENT) {
    log(`  ok    the database is identified as DEVELOPMENT — ${id.detail}`);
    return { ok: true, ...id };
  }

  log('');
  log(`  REFUSED — the database could not be positively identified as development.`);
  log(`  verdict: ${id.verdict}`);
  log(`  ${id.detail}`);
  for (const f of id.findings) log(`    · ${f}`);
  log('');
  if (id.verdict === VERDICT.PRODUCTION_FINGERPRINT) {
    log('  This looks like production, or a restore of it. Nothing will be migrated or written.');
    log('  Check which DATABASE_URL is set. Do NOT override this.');
  } else if (id.verdict === VERDICT.CANNOT_TELL) {
    log('  The database could not be inspected, so NOTHING is concluded — which is a refusal,');
    log('  not permission. Fix the connection and run this again.');
  } else {
    log('  The tables here belong to neither an empty database nor the M7 worker subsystem.');
    log('  If this really is a scratch database, the safe move is to delete and recreate it');
    log('  rather than to widen this check.');
  }
  return { ok: false, ...id };
}

module.exports = {
  VERDICT, PRODUCTION_TABLES, PRODUCTION_STOPS, M7_TABLES,
  identifyDatabase, assertDevelopmentDatabase,
};
