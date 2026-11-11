#!/usr/bin/env node
// ── ONE CONSTRAINT, ONE TRANSACTION, BOUNDED LOCKS ───────────────────────────
//
//   railway ssh --service playbookos 'node /app/scripts/migrate-inquiry-direction-check.js'
//   railway ssh --service playbookos 'node /app/scripts/migrate-inquiry-direction-check.js --apply'
//
// Read-only unless --apply. Sends nothing. Touches exactly one constraint on exactly one table.
//
// `--service playbookos` is not optional and the path must be absolute: the CLI's linked service in
// this project is Postgres, where there is no node and no /app, and a bare `railway ssh` fails with
// `node: command not found`, which reads as a broken deploy and is nothing of the kind.
//
// ── WHY THIS EXISTS RATHER THAN `node scripts/migrate.js` ────────────────────
//
// S2 needs ONE change in production: inquiry_messages.direction must admit 'outbound_pending', so a
// buyer letter waiting on a human can be recorded as the draft it is rather than as sent mail.
//
// scripts/migrate.js would apply it — along with 53 other schema steps and, by default, THREE SEED
// STEPS. One of those seeds is seedMoleculePricing(), which INSERTs into molecule_pricing: the
// table every quotation takes its price from, and the table the new identity gate compares a
// buyer's CAS against. It is ON CONFLICT DO NOTHING so it cannot overwrite a price, but it can add
// new quotable molecules to production. That is a business-data write inside something named like a
// schema migration. runAll also upserts the company row.
//
// `--no-seeds` suppresses the seeds and nothing else; the other 53 steps still run, each
// autocommit, with no transaction and no lock timeout anywhere in the chain. For a single
// constraint on a live database that is more surface than the change deserves.
//
// ── THE LOCK IS THE WHOLE RISK ───────────────────────────────────────────────
//
// ADD CONSTRAINT takes ACCESS EXCLUSIVE on inquiry_messages and validates every row. With no
// lock_timeout — which is what the main chain has — a conflicting lock makes that ALTER wait
// INDEFINITELY, and every query arriving behind it queues too. A brief change becomes a table-wide
// stall, which is the 2026-09-30 shape again: nothing errors, everything hangs.
//
// So both timeouts are set on the SESSION as soon as the connection is made, and again SET LOCAL
// inside the transaction. The ALTER fails fast and rolls back rather than blocking the table, and a
// failure here costs one re-run.
//
// SESSION-WIDE, and that was not the first version. The first version set them only inside the
// transaction — and the disposable-database harness hung for five minutes against a held
// ACCESS EXCLUSIVE lock. The reason is the survey: counting rows takes ACCESS SHARE, which the
// blocker also conflicts with, so the script stalled in its own READ-ONLY reporting phase, before
// it had set any bound at all. The script had the exact failure it exists to prevent, and only a
// test against a real server with a real lock could have shown it.
//
// ── AND THE ROLLBACK MUST NOT LIE ────────────────────────────────────────────
//
// Narrowing the constraint back requires no rows to hold 'outbound_pending'. The tempting way to
// get there is UPDATE … SET direction='outbound', and that would relabel undelivered drafts as sent
// mail — destroying the exact distinction this migration exists to create. --rollback therefore
// REFUSES while any such row exists and never writes to the data. CEO decision 2026-11-11.

'use strict';

const TABLE = 'inquiry_messages';
const CONSTRAINT = 'inquiry_messages_direction_check';
const ALLOWED = ['inbound', 'outbound', 'outbound_pending'];
const PRIOR = ['inbound', 'outbound'];
const NEW_VALUE = 'outbound_pending';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const APPLY = has('apply');
const ROLLBACK = has('rollback');
const LOCK_TIMEOUT = arg('lock-timeout', '5s');
const STATEMENT_TIMEOUT = arg('statement-timeout', '30s');

const say = (s = '') => console.log(s);
const ok = (s) => console.log(`  ok    ${s}`);
const bad = (s) => console.error(`  FAIL  ${s}`);

const definition = (values) => `CHECK (direction IN (${values.map((v) => `'${v}'`).join(',')}))`;

/** The constraint as the SERVER holds it, or null. Never inferred from its name. */
async function current(q) {
  const r = await q(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND rel.relname = $1 AND c.conname = $2`, [TABLE, CONSTRAINT]);
  return r.rows[0] ? r.rows[0].def : null;
}

async function survey(q) {
  const def = await current(q);
  const dist = (await q(
    `SELECT direction, COUNT(*)::int AS n FROM ${TABLE} GROUP BY direction ORDER BY n DESC`)).rows;
  const total = dist.reduce((a, r) => a + r.n, 0);
  // Rows the NEW predicate would reject. NULL is excluded deliberately: a CHECK passes on NULL,
  // so a null direction is not an incompatible value and counting it would invent a blocker.
  const bad1 = (await q(
    `SELECT COUNT(*)::int AS n FROM ${TABLE}
      WHERE direction IS NOT NULL AND direction <> ALL ($1::text[])`, [ALLOWED])).rows[0].n;
  const pending = (await q(
    `SELECT COUNT(*)::int AS n FROM ${TABLE} WHERE direction = $1`, [NEW_VALUE])).rows[0].n;
  const size = (await q(
    `SELECT pg_size_pretty(pg_total_relation_size($1)) AS s`, [`public.${TABLE}`])).rows[0].s;
  const owner = (await q(
    `SELECT pg_get_userbyid(rel.relowner) AS owner, current_user AS me,
            current_database() AS db,
            pg_has_role(current_user, rel.relowner, 'USAGE') AS can_alter
       FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND rel.relname = $1`, [TABLE])).rows[0];
  // ── WHO ELSE IS HOLDING SOMETHING ────────────────────────────────────────
  //
  // Surveyed here so the read-only mode answers the whole precheck in one place. A long-running
  // transaction is the single condition that turns this migration from a 65 ms change into a
  // table-wide stall, and an operator who has to run a separate query for it is an operator who
  // sometimes does not.
  const active = (await q(
    `SELECT pid, state, now() - xact_start AS age, left(query, 60) AS q
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
      ORDER BY xact_start NULLS LAST`)).rows;
  return { def, dist, total, incompatible: bad1, pending, size, owner, active };
}

const admits = (def, value) => !!def && String(def).includes(value);

async function main() {
  if (APPLY && ROLLBACK) {
    console.error('--apply and --rollback are mutually exclusive');
    process.exit(2);
  }

  const { Pool } = require('pg');
  const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('no MIGRATION_DATABASE_URL or DATABASE_URL');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

  // ONE client for the whole run, bounded before it is used for anything. A pool would hand out a
  // fresh unbounded connection per query, so the session SET would not apply to the query that
  // needed it — which is how the survey came to be unbounded in the first version.
  let session;
  try {
    session = await pool.connect();
    await session.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
    await session.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
  } catch (e) {
    console.error(`cannot connect or cannot bound the session: ${(e && e.message) || e}`);
    await pool.end().catch(() => {});
    process.exit(2);
  }
  const q = (sql, params) => session.query(sql, params);

  // ONE exit path. pool.end() BLOCKS until every checked-out client is returned, so an exit that
  // forgot to release the shared session hung the script — including its READ-ONLY mode, which
  // changes nothing and should be the safest thing here. Found by the disposable-database harness
  // on a clean fixture with no lock at all.
  const finish = async (code) => {
    try { session.release(); } catch (_) { /* already released */ }
    try { await pool.end(); } catch (_) { /* nothing to close */ }
    process.exit(code);
  };

  let failed = 0;
  try {
    const who = (await q(
      `SELECT current_user AS role, current_database() AS db,
              has_database_privilege(current_user, current_database(), 'CREATE') AS can_create`)).rows[0];

    say(`\n── ${TABLE}.${CONSTRAINT}${APPLY || ROLLBACK ? '' : '   ** READ-ONLY — pass --apply to change it **'}\n`);
    say(`   role ${who.role} · database ${who.db} · CREATE ${who.can_create ? 'yes' : 'NO'}`);
    say(`   server ${String((await q('SELECT version() v')).rows[0].v).split(' on ')[0]}`);

    let before;
    try {
      before = await survey(q);
    } catch (e) {
      const m = (e && e.message) || String(e);
      if (/lock timeout|statement timeout|canceling statement/i.test(m)) {
        bad(`even READING ${TABLE} timed out (${m}). Something holds a conflicting lock on it. `
          + 'NOTHING was changed. Find the holder and re-run:\n'
          + '          SELECT pid, state, now()-xact_start AS age, left(query,80) FROM pg_stat_activity\n'
          + "           WHERE datname = current_database() AND state <> 'idle' ORDER BY xact_start;");
        say('');
        await finish(1);
      }
      throw e;
    }
    say(`   table owner ${before.owner.owner} · ALTER permitted: ${before.owner.can_alter ? 'yes' : 'NO'}`);
    say(`   size ${before.size} · ${before.total} row(s)`);
    for (const d of before.dist) say(`     ${String(d.direction === null ? '(null)' : d.direction).padEnd(18)} ${d.n}`);
    say(`   incompatible with the new predicate: ${before.incompatible}`);
    say(`   rows already '${NEW_VALUE}': ${before.pending}`);
    say(`   other active sessions: ${before.active.length}`);
    for (const a of before.active) {
      say(`     pid ${a.pid} ${a.state} age=${a.age || '?'} ${a.q}`);
    }
    if (before.active.length) {
      say('     ^ a long-running transaction here will block the ALTER; the bound makes it fail');
      say('       fast rather than stall the table, but it is worth clearing first');
    }
    say(`\n   current  ${before.def || '(no such constraint)'}`);
    say(`   target   ${definition(ROLLBACK ? PRIOR : ALLOWED)}`);

    // ── IDEMPOTENCE, DECIDED FROM THE SERVER'S OWN DEFINITION ──────────────
    const atTarget = ROLLBACK
      ? (before.def && !admits(before.def, NEW_VALUE))
      : admits(before.def, NEW_VALUE);
    if (atTarget) {
      say(`\n   ALREADY ${ROLLBACK ? 'NARROWED' : 'APPLIED'} — nothing to do.\n`);
      await finish(0);
    }

    // ── PRECONDITIONS ───────────────────────────────────────────────────────
    if (!before.owner.can_alter) {
      bad(`${who.role} is not a member of ${before.owner.owner}, which owns ${TABLE} — ALTER TABLE `
        + 'requires ownership. Point MIGRATION_DATABASE_URL at the owning role.');
      failed += 1;
    }
    if (!ROLLBACK && before.incompatible > 0) {
      bad(`${before.incompatible} row(s) hold a direction the new predicate rejects. The ALTER would `
        + 'fail validation. List them before going further:\n'
        + `        SELECT DISTINCT direction FROM ${TABLE} WHERE direction IS NOT NULL `
        + `AND direction NOT IN (${ALLOWED.map((v) => `'${v}'`).join(',')});`);
      failed += 1;
    }
    if (ROLLBACK && before.pending > 0) {
      // THE REFUSAL THAT MATTERS. Getting to a narrower constraint would mean rewriting these rows
      // to 'outbound', which says a letter nobody received was sent.
      bad(`${before.pending} row(s) hold '${NEW_VALUE}'. Narrowing the constraint would require `
        + 'relabelling undelivered drafts as sent mail, which destroys the distinction this '
        + 'migration exists to create. REFUSING, and no data has been touched.');
      failed += 1;
    }
    if (failed) { say(''); await finish(1); }

    if (!APPLY && !ROLLBACK) {
      say(`\n   WOULD, in ONE transaction with lock_timeout=${LOCK_TIMEOUT} and `
        + `statement_timeout=${STATEMENT_TIMEOUT}:`);
      say(`     ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT};`);
      say(`     ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} ${definition(ALLOWED)};`);
      say('\n   Re-run with --apply.\n');
      await finish(0);
    }

    // ── THE CHANGE ──────────────────────────────────────────────────────────
    const client = session;
    try {
      await client.query('BEGIN');
      // SET LOCAL, so both bounds die with the transaction and cannot leak into the session.
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await client.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
      await client.query(
        `ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} ${definition(ROLLBACK ? PRIOR : ALLOWED)}`);

      // Postcondition INSIDE the transaction. If the server did not produce what was asked for,
      // this rolls back rather than committing and reporting success.
      const inTx = await current((s, p) => client.query(s, p));
      const want = ROLLBACK ? !admits(inTx, NEW_VALUE) : admits(inTx, NEW_VALUE);
      if (!want) {
        await client.query('ROLLBACK');
        bad(`after the ALTER the constraint reads ${inTx || '(absent)'}, which is not the target. `
          + 'Rolled back; nothing changed.');
        await finish(1);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* already gone */ }
      const m = (e && e.message) || String(e);
      bad(`the transaction was rolled back: ${m}`);
      if (/lock timeout|canceling statement due to lock timeout/i.test(m)) {
        say(`\n        A conflicting lock held ${TABLE} for longer than ${LOCK_TIMEOUT}. NOTHING`);
        say('        changed, and the table was never blocked behind this ALTER. Find the holder');
        say('        and re-run:');
        say('          SELECT pid, state, now()-xact_start AS age, left(query,80) FROM pg_stat_activity');
        say("           WHERE datname = current_database() AND state <> 'idle' ORDER BY xact_start;");
      }
      say('');
      await finish(1);
    }

    // ── READ BACK ON A FRESH CONNECTION, POST-COMMIT ────────────────────────
    // Not from the transaction that wrote it: that proves what was sent, not what was committed.
    const after = await survey(q);
    say('');
    ok(`committed — ${after.def}`);
    const good = ROLLBACK ? !admits(after.def, NEW_VALUE) : admits(after.def, NEW_VALUE);
    if (!good) { bad('the committed definition is not the target'); failed += 1; }
    if (after.total !== before.total) {
      bad(`row count changed from ${before.total} to ${after.total} — this migration writes no data`);
      failed += 1;
    }
    if (!ROLLBACK && after.pending !== before.pending) {
      bad(`'${NEW_VALUE}' row count changed from ${before.pending} to ${after.pending}`);
      failed += 1;
    }
    if (!failed) {
      ok(`${after.total} row(s) unchanged — no data was written`);
      say(`\n   Deploy may now proceed. The server's readiness check will accept this schema.\n`);
    } else {
      say('');
    }
  } catch (e) {
    bad((e && e.message) || String(e));
    failed += 1;
  }

  await finish(failed ? 1 : 0);
}

module.exports = { TABLE, CONSTRAINT, ALLOWED, PRIOR, NEW_VALUE, definition, current, survey, admits };

if (require.main === module) {
  main().catch((e) => {
    console.error('migrate-inquiry-direction-check failed:', (e && e.message) || e);
    process.exit(1);
  });
}
