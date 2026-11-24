#!/usr/bin/env node
// ── STOP COVERAGE, REPORTED WITHOUT TOUCHING A ROW ──────────────────────────
//
//   node scripts/report-stop-inventory.js
//   echo $?     # 0 = the report ran · 2 = it could not run
//
// STRICTLY READ-ONLY, and in three independent ways rather than by assertion:
//
//   1. every statement runs inside `BEGIN TRANSACTION READ ONLY`, so POSTGRES refuses a write
//      even if this file is later changed to attempt one. That is the one guarantee that does not
//      depend on anybody reading this comment.
//   2. a self-check at the bottom of this file fails the run if the source ever contains a write
//      STATEMENT. It matches statements, not words — an earlier guard elsewhere in this repo
//      searched for the bare word 'INSERT ' and tripped on its own forbidden-verb list.
//   3. the pool is opened with a statement timeout, so a report cannot hold a lock on production.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// On 2026-11-23 I proposed running `scripts/check-autonomy-stop-db.js` against PRODUCTION to take
// a STOP inventory, and described it as read-only. It is not. It is the kill switch's correctness
// check, meant for a throwaway cluster, and among other things it executes:
//
//     INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by) VALUES ('global','',…)
//     DELETE FROM autonomy_stops WHERE scope_type='global'
//     INSERT INTO autonomy_stops (scope_type, scope_key, reason) VALUES ('capability','email.send',…)
//
// A global STOP halts all autonomy. Running that against production to "look at" the inventory
// would have caused the outage it was meant to guard against. The owner's instruction — verify the
// script is genuinely read-only BEFORE execution — is what caught it.
//
// So: reading production is a different job from testing the kill switch, and it gets its own
// file with its own guarantees.
//
// ── WHAT IT REPORTS ─────────────────────────────────────────────────────────
//
//   1. registered scopes, from autonomy.knownScopeKeys() — the authoritative registry
//   2. existing STOP rows
//   3. scopes with NO stop row (coverage gaps)
//   4. which workflows are therefore currently ENABLED
//   5. the external-action capabilities and whether each is stopped
//   6. a dev/prod containment comparison when a second URL is supplied
//
// It reports. It decides nothing, and it exits 0 whatever it finds, so a non-zero exit always
// means the report itself failed to run.

'use strict';

const AUTONOMY = require('../src/lib/autonomy');

const SCOPE_TYPES_TO_LIST = ['capability', 'workflow', 'agent'];

/** Capabilities that can affect the world outside this system. */
const EXTERNAL_ACTION_CAPABILITIES = ['email.send', 'whatsapp.send'];

function usage(msg) {
  if (msg) console.error(`\n${msg}`);
  console.error(`
usage:
  DATABASE_URL=... node scripts/report-stop-inventory.js
  DATABASE_URL=... COMPARE_DATABASE_URL=... node scripts/report-stop-inventory.js

The second form adds a dev/prod containment comparison. Neither URL is printed.
`);
  process.exit(2);
}

/**
 * Opens a READ ONLY transaction and runs `fn` inside it. The transaction is the real guarantee:
 * Postgres itself refuses INSERT/UPDATE/DELETE/DDL in this mode, so a future edit to this file
 * cannot quietly start writing.
 */
async function readOnly(url, fn) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: url,
    max: 1,
    // A report must never hold a lock on production.
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const out = await fn((sql, params) => client.query(sql, params));
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the transaction is already gone */ }
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

// ── THE GOVERNANCE SCHEMA THIS REPORT DEPENDS ON ────────────────────────────
//
// Added after the first production run of this script errored with
// `relation "autonomy_stops" does not exist`. A report that dies on the absence of the thing it
// was asked about is less useful than one that says what is absent — and that absence turned out
// to be the most important thing the run had to tell anybody.
//
// `pg_tables`/`tablename`, not information_schema: a stub written against information_schema once
// returned an empty table list here and four assertions passed for the wrong reason.
const GOVERNANCE_TABLES = [
  'autonomy_stops', 'autonomy_events',       // the kill switch and its history
  'agent_runs', 'agent_run_events',          // the run ledger
  'approval_queue',                          // the approval boundary
  'worker_identities', 'worker_tasks', 'worker_audit',   // M7
];

async function tablePresence(q) {
  const r = await q(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [GOVERNANCE_TABLES]);
  const present = new Set(r.rows.map((x) => x.tablename));
  return GOVERNANCE_TABLES.map((t) => ({ table: t, present: present.has(t) }));
}

/** Reads the stop rows and the host identity. Nothing else. */
async function gather(q) {
  const where = await q('SELECT current_database() AS db, inet_server_addr()::text AS addr');
  const schema = await tablePresence(q);
  const missing = schema.filter((s) => !s.present).map((s) => s.table);

  // Without the kill-switch table there is nothing to inventory, and saying so IS the answer.
  if (missing.includes('autonomy_stops')) {
    return { where: where.rows[0] || {}, stops: null, events: null, schema, missing };
  }

  const stops = await q(
    `SELECT scope_type, scope_key, reason, set_by, set_at
       FROM autonomy_stops
      ORDER BY scope_type, scope_key`);
  // Present only if the kernel has been migrated; absence is information, not an error.
  let events = null;
  try {
    const r = await q('SELECT COUNT(*)::int AS n FROM autonomy_events');
    events = r.rows[0] ? r.rows[0].n : null;
  } catch (_) { events = null; }

  // Refusals, grouped. `action` and `scope_type`/`scope_key` are the recorded columns; the shape
  // comes from the DDL in autonomy.js, not from memory.
  let refusals = null;
  if (events !== null) {
    try {
      const byScope = await q(
        `SELECT scope_type, scope_key, COUNT(*)::int AS n,
                MIN(at) AS first_at, MAX(at) AS last_at
           FROM autonomy_events
          WHERE action = 'REFUSED'
          GROUP BY scope_type, scope_key
          ORDER BY n DESC`);
      const byAction = await q(
        `SELECT action, COUNT(*)::int AS n FROM autonomy_events GROUP BY action ORDER BY n DESC`);
      refusals = { byScope: byScope.rows, byAction: byAction.rows };
    } catch (_) { refusals = null; }
  }
  return { where: where.rows[0] || {}, stops: stops.rows, events, schema, missing, refusals };
}

function fmtScope(s) {
  return s.scope_key ? `${s.scope_type}/${s.scope_key}` : s.scope_type;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) usage('DATABASE_URL is not set.');

  const primary = await readOnly(url, gather);

  console.log('\n══ STOP INVENTORY (read-only) ══\n');
  console.log(`  database : ${primary.where.db || '(unknown)'}`);

  // ── GOVERNANCE SCHEMA ────────────────────────────────────────────────────
  console.log('\n── governance schema ──');
  for (const s of primary.schema) {
    console.log(`  ${s.table.padEnd(20)} ${s.present ? 'present' : 'ABSENT'}`);
  }

  if (primary.stops === null) {
    console.log(`\n  THE KILL SWITCH TABLE IS ABSENT from this database.`);
    console.log('  There is no STOP inventory to report, because there is no table to hold one.');
    console.log('\n  What that means, from autonomy.js checkStopped():');
    console.log('    a missing table makes kill-state UNKNOWABLE, and the code FAILS CLOSED —');
    console.log('    every CONSEQUENTIAL action returns a synthetic global stop reading');
    console.log('    "kill-state could not be determined ... refusing consequential action".');
    console.log('    Read-only analysis continues (consequential:false returns null).');
    console.log('\n  So any path that consults the kill switch is refusing here, and any path that');
    console.log('  does NOT consult it is running with no kill switch at all. Which of those is');
    console.log('  true for a given workflow is the thing to establish next, per workflow.');
    console.log(`\n  Registered scopes that therefore have NO enforceable stop:`);
    for (const type of SCOPE_TYPES_TO_LIST) {
      const known = AUTONOMY.knownScopeKeys(type) || [];
      console.log(`    ${type.padEnd(12)} ${known.length}`);
    }
    console.log('\nread-only report complete. No row was inserted, updated or deleted.\n');
    return;
  }

  console.log(`\n  rows     : ${primary.stops.length} stop row(s)`);
  console.log(`  history  : ${primary.events === null ? 'autonomy_events not present' : `${primary.events} event(s)`}`);

  // ── 1 + 2 + 3. REGISTERED SCOPES, STOPS, AND THE GAPS ────────────────────
  const held = new Set(primary.stops.map(fmtScope));
  const summary = {};
  for (const type of SCOPE_TYPES_TO_LIST) {
    const known = AUTONOMY.knownScopeKeys(type) || [];
    const stopped = known.filter((k) => held.has(`${type}/${k}`));
    const open = known.filter((k) => !held.has(`${type}/${k}`));
    summary[type] = { known, stopped, open };
    console.log(`\n── ${type} ──`);
    console.log(`  registered : ${known.length}`);
    console.log(`  stopped    : ${stopped.length}`);
    console.log(`  NO stop    : ${open.length}${open.length ? '  <-- these are currently ENABLED' : ''}`);
    if (open.length) {
      for (const k of open) console.log(`      ${k}`);
    }
  }

  // ── STOP ROWS THAT PROTECT NOTHING ───────────────────────────────────────
  //
  // Found while testing this report against a fixture: a row for `workflow/ceo-briefing` matched
  // no registered scope, because the registered name is `daily-7cst-ceo-briefing`. A stop on a
  // name nothing checks is indistinguishable, in a row count, from a stop that works — and
  // counting rows is exactly how somebody would conclude that containment is in place.
  const registered = new Set();
  for (const type of SCOPE_TYPES_TO_LIST) {
    for (const k of AUTONOMY.knownScopeKeys(type) || []) registered.add(`${type}/${k}`);
  }
  const orphans = primary.stops.filter((s) => {
    if (s.scope_type === 'global') return false;          // no key, always meaningful
    if (s.scope_type === 'company') return false;         // free text by design
    return !registered.has(fmtScope(s));
  });
  console.log('\n── stop rows matching NO registered scope ──');
  if (!orphans.length) console.log('  none — every stop row names a scope that is actually checked');
  else {
    console.log(`  ${orphans.length} row(s) stop a name nothing checks. These protect nothing:`);
    for (const s of orphans) console.log(`      ${fmtScope(s)}`);
  }

  // A global stop would halt everything regardless of the above, so it is reported separately.
  const globalStop = primary.stops.find((s) => s.scope_type === 'global');
  console.log(`\n── global ──\n  ${globalStop ? 'A GLOBAL STOP IS SET — all autonomy is halted' : 'no global stop'}`);

  // ── 5. EXTERNAL-ACTION CAPABILITIES ──────────────────────────────────────
  console.log('\n── external-action capabilities ──');
  for (const cap of EXTERNAL_ACTION_CAPABILITIES) {
    const row = primary.stops.find((s) => s.scope_type === 'capability' && s.scope_key === cap);
    console.log(`  ${cap.padEnd(16)} ${row ? 'STOPPED' : 'ENABLED  <-- can act outside this system'}`);
  }

  // ── 4. THE EXISTING ROWS, IN FULL ────────────────────────────────────────
  if (primary.stops.length) {
    console.log('\n── stop rows ──');
    for (const s of primary.stops) {
      console.log(`  ${fmtScope(s).padEnd(44)} set_by=${s.set_by || '(null)'}  ${new Date(s.set_at).toISOString()}`);
      if (s.reason) console.log(`      reason: ${String(s.reason).slice(0, 110)}`);
    }
  }

  // ── WHAT THE STOPS HAVE ACTUALLY BEEN STOPPING ───────────────────────────
  //
  // A stop row says what is forbidden. It does not say whether anything tried. Those are different
  // facts and only one of them tells you whether a workflow has been silently refused for weeks.
  //
  // Added because `capability/email.send` has been stopped in production since 2026-11-03, and the
  // daily CEO briefing calls mailer.sendEmail, which gates through email-gate.assertSendAllowed.
  // `email.send` is NOT in that gate's OBSERVABILITY exemption (only `email.alert` is), and
  // matchStop applies capability stops even to non-consequential checks. So the briefing should
  // have been generated and stored every morning and never delivered. This section is how to find
  // out, instead of inferring it from a page that shows a stored briefing.
  if (primary.refusals) {
    console.log('\n── refusals recorded (autonomy_events) ──');
    if (!primary.refusals.byScope.length) {
      console.log('  none — nothing has been refused, which means either nothing tried');
      console.log('  or the paths that tried do not consult the kill switch at all');
    } else {
      for (const r of primary.refusals.byScope) {
        console.log(`  ${(r.scope_type + (r.scope_key ? `/${r.scope_key}` : '')).padEnd(34)}`
          + ` ${String(r.n).padStart(5)} refusal(s)   first ${r.first_at && new Date(r.first_at).toISOString().slice(0, 10)}`
          + `  last ${r.last_at && new Date(r.last_at).toISOString().slice(0, 10)}`);
      }
    }
    if (primary.refusals.byAction.length) {
      console.log('\n  all event actions:');
      for (const a of primary.refusals.byAction) {
        console.log(`    ${String(a.action).padEnd(20)} ${String(a.n).padStart(5)}`);
      }
    }
  }

  // ── 6. DEV / PROD COMPARISON ─────────────────────────────────────────────
  if (process.env.COMPARE_DATABASE_URL) {
    const other = await readOnly(process.env.COMPARE_DATABASE_URL, gather);
    const otherHeld = new Set(other.stops.map(fmtScope));
    const onlyHere = [...held].filter((k) => !otherHeld.has(k));
    const onlyThere = [...otherHeld].filter((k) => !held.has(k));
    console.log('\n── containment comparison ──');
    console.log(`  this database  : ${primary.stops.length} stop(s) (${primary.where.db})`);
    console.log(`  other database : ${other.stops.length} stop(s) (${other.where.db})`);
    console.log(`  only here      : ${onlyHere.length}${onlyHere.length ? ' — ' + onlyHere.slice(0, 8).join(', ') : ''}`);
    console.log(`  only there     : ${onlyThere.length}${onlyThere.length ? ' — ' + onlyThere.slice(0, 8).join(', ') : ''}`);
  }

  console.log('\nread-only report complete. No row was inserted, updated or deleted.\n');
}

// ── THE READ-ONLY CLAIM, ENFORCED RATHER THAN ASSERTED ──────────────────────
//
// The READ ONLY transaction is the guarantee. This is the second line of defence, and it exists
// because a reader of this file should not have to trust the comment at the top.
//
// It matches write STATEMENTS, not bare verbs: this file's own prose necessarily contains the
// words INSERT and DELETE while documenting what check-autonomy-stop-db.js does, and a guard that
// fires on its own documentation is noise. That mistake has been made three times in this
// repository already.
// A GUARD MUST NOT SCAN ITSELF. The first version of this function did, and fired immediately on
// the string literal 'INSERT INTO' in its own label column — three lines below a comment noting
// that this exact mistake had already been made three times. So the scanned region ends where the
// guard begins, marked by the sentinel below and asserted to exist.
const SELF_CHECK_SENTINEL = '/* ---- guard begins: not scanned ---- */';
/* ---- guard begins: not scanned ---- */
(function selfCheck() {
  const src = require('fs').readFileSync(__filename, 'utf8');
  const cut = src.indexOf(SELF_CHECK_SENTINEL, src.indexOf(SELF_CHECK_SENTINEL) + 1);
  if (cut === -1) {
    console.error('\nREFUSED: the guard sentinel is missing, so the scanned region is unknown.');
    process.exit(2);
  }
  const scanned = src.slice(0, cut);
  const code = scanned.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const writes = [
    [/\bINSERT\s+INTO\b/i, 'INSERT INTO'],
    [/\bUPDATE\s+\w+\s+SET\b/i, 'UPDATE … SET'],
    [/\bDELETE\s+FROM\b/i, 'DELETE FROM'],
    [/\bTRUNCATE\s+\w/i, 'TRUNCATE'],
    [/\bDROP\s+(TABLE|INDEX|FUNCTION|TRIGGER)\b/i, 'DROP'],
    [/\bALTER\s+TABLE\b/i, 'ALTER TABLE'],
    [/\bCREATE\s+(TABLE|INDEX|FUNCTION|TRIGGER|ROLE)\b/i, 'CREATE'],
    [/\bGRANT\b/i, 'GRANT'],
  ];
  for (const [re, label] of writes) {
    if (re.test(code)) {
      console.error(`\nREFUSED: this file contains a ${label} statement. It is a read-only report.`);
      process.exit(2);
    }
  }
  // And the transaction must actually be opened in READ ONLY mode.
  if (!/BEGIN TRANSACTION READ ONLY/.test(code)) {
    console.error('\nREFUSED: the read-only transaction is missing. Postgres is the guarantee, not this check.');
    process.exit(2);
  }
})();

main().catch((e) => {
  console.error(`\nERROR ${(e && e.message) || e}`);
  process.exit(2);
});
