#!/usr/bin/env node
// ── THE UPSERTS THAT MIGRATION B7.21 BROKE ──────────────────────────────────
//
// Found on 27 Nov 2026 by the connected employee operating loop, at the performance-evaluation
// step. `scoreTeamMember` threw:
//
//     there is no unique or exclusion constraint matching the ON CONFLICT specification
//
// **The migration is right and the callers were never re-measured against it.**
// `identity/schema.js` replaces two whole-table unique constraints with PARTIAL unique indexes,
// deliberately and for a good reason (one score per person per day was structurally impossible to
// keep while also scoring a person who works for two companies):
//
//     DROP CONSTRAINT performance_scores_user_id_score_date_key
//     CREATE UNIQUE INDEX … ON performance_scores (user_id, score_date)              WHERE company_id IS NULL
//     CREATE UNIQUE INDEX … ON performance_scores (user_id, score_date, company_id)  WHERE company_id IS NOT NULL
//
// **Postgres will not infer a PARTIAL index from a bare conflict target.** `ON CONFLICT
// (user_id, score_date)` matched the dropped constraint and matches neither index, so every one of
// these statements fails outright — not silently, not occasionally, but on every execution against
// a migrated database:
//
//   · src/lib/core.js — scoreTeamMember, which src/lib/jobs.js runs for EVERY user at the 18:00 CST
//     performance scoring. The whole daily scoring, coaching and escalation chain.
//   · src/lib/agents/orchestrator.js ×2 — runPerformanceCheck's daily row and its weekly summary,
//     reached from POST /api/performance/calculate and from the task route.
//   · src/lib/agents/metrics-snapshot.js — the daily portfolio snapshot, via the same pattern on
//     metrics_snapshots.
//
// **THE DEFECT CLASS, again: a migration verified by its own artefacts.** The B7.21 work proved the
// indexes exist, proved the isolation they provide, and proved the NULL trap was avoided. What it
// did not do is ask which statements had been inferring the constraint it dropped. A schema change
// is not finished when the schema is right; it is finished when every statement that reads or
// writes that shape has been re-measured. Dropping a constraint is a change to every `ON CONFLICT`
// that named it, and those live in different files from the migration.
//
// Each of the four writers inserts NO company_id, so every row it writes is the unattributed
// shape. The conflict target therefore carries the unattributed index's own predicate — which is
// both what Postgres needs to infer the index and a truthful statement of what the writer does.
//
// This check runs the REAL migrator and then the REAL functions. A unit test with a hand-built
// table would have reproduced the old constraint and proved nothing.

'use strict';

process.env.ADMIN_EMAIL = 'upsert-bootstrap@upsert.invalid';
process.env.ADMIN_PASSWORD = `u-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.JWT_SECRET = `upsert-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.NODE_ENV = 'development';
// No ANTHROPIC_API_KEY: the coaching note must be composed without a paid model call.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.RESEND_API_KEY;

const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail += 1;
  lines.push(`  FAIL  ${m}`);
  if (extra !== undefined) lines.push(`          ${String(extra).slice(0, 240)}`);
};
const note = (m) => lines.push(`  --    ${m}`);

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'upsert-after-identity-migration' });
  } catch (e) {
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  process.env.DATABASE_URL = cluster.url;
  const DB = require('../src/lib/db');
  const { query } = DB;

  try {
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);

    // ── 1. THE PRE-MIGRATION STATE: the bare target works ──────────────────
    lines.push('', '── 1. before the migration, the bare conflict target is valid ──', '');
    const preUser = 'pre-migration-user';
    await query(
      `INSERT INTO users (id, email, name, role, is_active, password_hash)
       VALUES ($1,'pre@upsert.invalid',$1,'sales_team',1,'x')`, [preUser]);
    try {
      for (const n of [1, 2]) {
        await query(
          `INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100)
           VALUES ($1,$2,'2026-11-01',$3)
           ON CONFLICT (user_id, score_date) DO UPDATE SET score_0_to_100 = EXCLUDED.score_0_to_100`,
          [crypto.randomUUID(), preUser, 50 + n]);
      }
      ok('the whole-table constraint satisfies ON CONFLICT (user_id, score_date) — this is why '
        + 'four call sites were written that way, and they were correct when written');
    } catch (e) {
      bad('the pre-migration upsert failed, so this check cannot establish the regression', e.message);
    }

    // ── 2. APPLY THE REAL MIGRATION ────────────────────────────────────────
    lines.push('', '── 2. the real migration replaces the constraint with partial indexes ──', '');
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/identity/schema').migrateRecordOwnership(query);

    const cons = await query(
      `SELECT conname FROM pg_constraint WHERE conname = 'performance_scores_user_id_score_date_key'`);
    if (cons.rows.length === 0) {
      ok('performance_scores_user_id_score_date_key is gone, as the migration intends');
    } else {
      bad('the migration did not drop the constraint, so nothing below is measuring B7.21');
    }
    const idx = await query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('performance_scores','metrics_snapshots')
          AND indexdef LIKE '%WHERE%' ORDER BY indexname`);
    const partials = idx.rows.filter((x) => /UNIQUE/.test(x.indexdef));
    if (partials.length === 4) {
      ok(`four PARTIAL unique indexes are in place: ${partials.map((x) => x.indexname).join(', ')}`);
    } else {
      bad(`expected four partial unique indexes, found ${partials.length}`,
        partials.map((x) => x.indexname).join(', '));
    }

    // ── 3. THE FOUR WRITERS, AGAINST THE MIGRATED SCHEMA ───────────────────
    lines.push('', '── 3. the four real writers, run twice each — an upsert must be idempotent ──', '');

    const CO = `upsert-co-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,'Upsert Co','active')`,
      [CO]);
    const U = 'upsert-scored-user';
    await query(
      `INSERT INTO users (id, email, name, role, is_active, password_hash)
       VALUES ($1,'scored@upsert.invalid','Scored Person','sales_team',1,'x')`, [U]);

    const DAY = '2026-11-20';
    const CORE = require('../src/lib/core');

    // (a) core.js scoreTeamMember — the 18:00 CST job, via jobs.js, for every user.
    let r1 = null;
    try {
      await CORE.scoreTeamMember(U, DAY);
      r1 = await CORE.scoreTeamMember(U, DAY);   // twice: the second is the upsert
      ok('core.js scoreTeamMember writes, and re-writes the same day without error');
    } catch (e) {
      bad('core.js scoreTeamMember (the 18:00 scoring for every user) fails on a migrated database',
        e.message);
    }
    const n1 = await query(
      'SELECT COUNT(*)::int n FROM performance_scores WHERE user_id = $1 AND score_date = $2',
      [U, DAY]);
    if (n1.rows[0].n === 1) {
      ok('and leaves exactly ONE row for that person and day — it upserted rather than duplicated');
    } else {
      bad(`scoreTeamMember left ${n1.rows[0].n} rows for one person-day`);
    }

    // (b) + (c) orchestrator's daily row and weekly summary.
    const ORCH = require('../src/lib/agents/orchestrator');
    try {
      await ORCH.runPerformanceCheck({ date: DAY, userId: U, silent: true });
      await ORCH.runPerformanceCheck({ date: DAY, userId: U, silent: true });
      ok('orchestrator runPerformanceCheck writes and re-writes the daily row');
    } catch (e) {
      bad('orchestrator runPerformanceCheck fails on a migrated database', e.message);
    }
    const n2 = await query(
      `SELECT COUNT(*)::int n FROM performance_scores
        WHERE user_id = $1 AND score_date = $2 AND company_id IS NULL`, [U, DAY]);
    if (n2.rows[0].n === 1) {
      ok('and the two writers share the one unattributed row rather than racing to duplicate it');
    } else {
      bad(`${n2.rows[0].n} unattributed rows exist for one person-day`);
    }

    // (d) metrics-snapshot's portfolio row.
    const SNAP = require('../src/lib/agents/metrics-snapshot');
    const snapFn = SNAP.takeMetricsSnapshot;
    if (typeof snapFn === 'function') {
      try {
        await snapFn({});
        await snapFn({});
        ok('metrics-snapshot writes and re-writes the portfolio row');
      } catch (e) {
        bad('metrics-snapshot fails on a migrated database', e.message);
      }
      const n3 = await query(
        'SELECT COUNT(*)::int n FROM metrics_snapshots WHERE company_id IS NULL');
      if (n3.rows[0].n <= 1) {
        ok(`and leaves ${n3.rows[0].n} portfolio row(s) — one per day, not one per run`);
      } else {
        bad(`${n3.rows[0].n} portfolio snapshots exist`);
      }
    } else {
      note(`metrics-snapshot exports ${Object.keys(SNAP).join(', ')} — its entry point is asserted `
        + 'statically below instead');
    }

    // ── 4. THE STATIC GUARD, so the next migration cannot repeat this ──────
    lines.push('', '── 4. no bare conflict target survives against a partially-indexed table ──', '');
    const fs = require('fs');
    const path = require('path');
    const PARTIAL_TABLES = {
      performance_scores: 'company_id IS NULL',
      metrics_snapshots: 'company_id IS NULL',
    };
    const roots = ['src', 'scripts'];
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) files.push(full);
      }
    };
    for (const root of roots) walk(path.join(__dirname, '..', root));

    const offenders = [];
    for (const f of files) {
      if (f.endsWith('check-upsert-after-identity-migration-db.js')) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const [table, predicate] of Object.entries(PARTIAL_TABLES)) {
        const re = new RegExp(`INSERT\\s+INTO\\s+${table}\\b[\\s\\S]{0,1200}?ON CONFLICT\\s*\\(([^)]*)\\)\\s*(WHERE[^D]*)?DO`, 'gi');
        let m;
        while ((m = re.exec(src)) !== null) {
          const hasPredicate = (m[2] || '').toLowerCase().includes(predicate.toLowerCase());
          if (!hasPredicate) {
            offenders.push(`${path.relative(path.join(__dirname, '..'), f)} → ${table} `
              + `ON CONFLICT (${m[1].trim()}) with no WHERE ${predicate}`);
          }
        }
      }
    }
    if (offenders.length === 0) {
      ok(`${files.length} source files scanned: every ON CONFLICT against a partially-indexed `
        + 'table carries the index predicate');
    } else {
      bad(`${offenders.length} bare conflict target(s) remain — each one throws on a migrated `
        + 'database', `\n          ${offenders.join('\n          ')}`);
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
  } finally {
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ UPSERTS AGAINST THE B7.21 PARTIAL INDEXES ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
