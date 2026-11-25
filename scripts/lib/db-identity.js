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
  // B2.5a (2026-11-24): named, time-bounded budget exceptions. Listed in the same change that
  // created the table — until it was, a freshly migrated database read as `unidentified` and every
  // subsequent run was refused, which is exactly the drift this check exists to catch.
  'office_budget_exceptions',
  // B2.5b (2026-11-25): pre-spend holds.
  'office_budget_reservations',
  // B3.2 (2026-11-24): decomposed plans and their per-step verdicts.
  'office_plans', 'office_plan_steps',
  // B3.3 (2026-11-24): the dispatch record for one delegation.
  'office_delegations',
  // Decision 1 (2026-11-25): explicit product→company mappings.
  'product_companies',
  // B7.11 / B7.9 (2026-11-25): the outbound declaration tables — which shared mailboxes count as
  // internal, and which identities this platform may send as. Both carry company_id because both
  // answers differ per company.
  'shared_mailboxes', 'sender_identities',
  // M7.1 / M7.2 / M7.3
  'worker_identities', 'worker_enrollment_tokens', 'worker_request_nonces',
  'worker_tasks', 'worker_results', 'worker_audit',
];

// ── THE M7.6 PILOT TABLES ───────────────────────────────────────────────────
//
// Added 2026-11-20, immediately after `m76-migrate-dev.js --apply` made this very check refuse:
//
//     verdict: unidentified
//     4 table(s) that are neither empty nor part of M7: m76_goals, m76_plan_steps, …
//
// which is the failure mode the comment above predicts, and the check behaving correctly: the
// database contained tables it did not recognise, so it declined to call it development rather
// than guessing. Every script that gates on this then refused, which is the right order of events.
//
// IMPORTED, not hand-copied. The list above is hand-written and says so, and that cost seven
// missing entries once. `src/lib/m76/schema.js` is the single declaration of the pilot's tables and
// the migration applies exactly it, so taking the names from there means the two cannot disagree.
//
// This is a narrow addition of a DECLARED set, not the widening the refusal message warns against.
// That warning is about accommodating tables nobody can account for; these are four tables created
// by an authorized development-only migration whose DDL is in the repository.
const M76_PILOT_TABLES = require('../../src/lib/m76/schema').TABLES;

/** Everything a legitimately-migrated development database may contain. */
const EXPECTED_TABLES = [...M7_TABLES, ...M76_PILOT_TABLES];

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
  const unexpected = tables.filter((t) => !EXPECTED_TABLES.includes(t));
  if (tables.length === 0) {
    return { verdict: VERDICT.DEVELOPMENT, findings, tables,
      detail: 'the database is empty — nothing has been created here yet' };
  }
  if (unexpected.length === 0) {
    // Counted separately, so the operator can see at a glance whether the pilot schema is present
    // — "16 tables, all M7" and "20 tables, 4 of them the M7.6 pilot" are different situations.
    const pilot = tables.filter((t) => M76_PILOT_TABLES.includes(t));
    return { verdict: VERDICT.DEVELOPMENT, findings, tables,
      detail: pilot.length
        ? `${tables.length} table(s): ${tables.length - pilot.length} from the M7 worker subsystem `
          + `and ${pilot.length} from the M7.6 development pilot`
        : `${tables.length} table(s), all of them created by the M7 worker subsystem` };
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
  M76_PILOT_TABLES, EXPECTED_TABLES,
  VERDICT, PRODUCTION_TABLES, PRODUCTION_STOPS, M7_TABLES,
  identifyDatabase, assertDevelopmentDatabase,
};
