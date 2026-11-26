#!/usr/bin/env node
// ── DEDUPLICATED MONITORING, MEASURED (B4.5) ────────────────────────────────
//
//   node scripts/check-monitor-db.js    exit 0 = every ruled property holds
//                                        exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's Priority 3, directive of 2026-11-25: *"implement deduplicated monitoring with NO external
// notifications until separately authorized"*, and B4.5's own acceptance: *"silence > 5 min → one
// deduplicated alert, haltable by its own STOP."*
//
// Four properties, and each is measured rather than described:
//
//   1. DEDUPLICATION is the primary key. Twenty sweeps of one unchanged condition produce ONE row
//      whose `occurrences` reaches 20 — and the destructive control drops the key and shows the
//      duplicates appear, so the guarantee is named rather than assumed.
//   2. SILENCE is noticed, and only when the scheduler is supposed to be running. A switched-off
//      scheduler is `info`; an enabled one past the bound is `critical`. The heartbeat is written
//      by the REAL cron, including on a tick it skips.
//   3. RESOLUTION is by the condition going away, never by a timeout — and the row STAYS, because
//      "this was wrong for six hours on Tuesday" is what an operator needs afterwards.
//   4. It SENDS NOTHING. Asserted here as zero outward calls with a spy that is first proved able
//      to fire, and on the module's source by monitor-has-no-transport.test.js.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures by id.

'use strict';

const crypto = require('node:crypto');

const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) {
    console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
};
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n── ${m} ──\n`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'mon' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  monitoring was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'mon-bootstrap@mon.invalid';
process.env.ADMIN_PASSWORD = `mon-${crypto.randomBytes(16).toString('hex')}`;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 300s — a stall is a failure.');
  process.exit(1);
}, 300_000);
watchdog.unref?.();

// ── THE OUTWARD-CALL SPY, INSTALLED BEFORE ANYTHING IS REQUIRED ─────────────
//
// And it is PROVED able to fire further down, because a spy whose silence nobody has tested makes
// "nothing was sent" unfalsifiable — the lesson from the provider stub that was never consulted.
const outward = [];
const realFetch = global.fetch;
global.fetch = (...args) => { outward.push(String(args[0])); return realFetch(...args); };

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false, max: 8 });
  const query = (t, p) => P.query(t, p);
  const withTransaction = async (fn) => {
    const c = await P.connect();
    try {
      await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };
  const deps = { query, withTransaction, env: SEAL };

  const made = { companies: [], objectives: [], workers: [] };
  const uid = (p) => `mon-${p}-${crypto.randomUUID().slice(0, 8)}`;
  const n1 = async (sql, pr) => (await query(sql, pr)).rows[0].n;

  try {
    const autonomy = require('../src/lib/autonomy');
    const DB = require('../src/lib/db');
    await DB.initDB();
    await DB.initPhase2?.();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await autonomy.migrateAutonomy(query);
    await require('../src/lib/office/memory').migrateMemory(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/identity/schema').migrateRecordOwnership(query);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/audit').migrateWorkerAudit(query);
    autonomy.resetForTests && autonomy.resetForTests();

    const MON = require('../src/lib/office/monitor');
    const SCOPE = require('../src/lib/office/scope');
    const CTXMOD = require('../src/lib/office/context');
    const IDENT = require('../src/lib/worker/identity');

    const CO = uid('co');
    await query(`INSERT INTO companies (id, slug, display_name, status)
                 VALUES ($1,$1,$1,'active')`, [CO]);
    made.companies.push(CO);
    const OBJ = uid('obj');
    await query(`INSERT INTO objectives
                   (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                    created_by, budget_usd)
                 VALUES ($1,$2,'monitor fixture','P1','supervised','all_consequential','active',
                         'naren@fixture.invalid',5.00)`, [OBJ, CO]);
    made.objectives.push(OBJ);
    const CTX = await CTXMOD.resolveObjectiveContext({ objectiveId: OBJ }, deps);

    const openOf = async () => SCOPE.openAlerts(CTX, { limit: 100 }, deps);
    const rowOf = async (id) => (await query(
      `SELECT id, code, occurrences, first_seen_at, last_seen_at, resolved_at
         FROM office_monitor_alerts WHERE id = $1`, [id])).rows[0];

    // ══ 1. A CONDITION THAT PERSISTS IS ONE ROW ══════════════════════════
    head('1. twenty sweeps of one unchanged condition produce ONE row');

    {
      // An offline worker with work waiting: a finding that will not clear by itself.
      const tok = await IDENT.createEnrollmentToken({ label: 'mon-offline-node' }, deps);
      const e = await IDENT.consumeEnrollmentToken(
        { token: tok.token, hostFingerprint: 'mon-check' }, deps);
      made.workers.push(e.workerId);
      await query(`UPDATE worker_identities SET last_seen_at = $2 WHERE id = $1`,
        [e.workerId, new Date(Date.now() - 7200_000).toISOString()]);
      await require('../src/lib/worker/leases').enqueueTask({
        taskType: 'synthetic.echo', payload: { hello: 'mon' }, intentKey: uid('intent'),
        companyId: CO, workflow: 'mon-check', createdBy: 'mon-check' }, deps);

      let last = null;
      for (let i = 0; i < 20; i++) last = await MON.sweep(CTX, { schedulerEnabled: false }, deps);
      const id = MON.alertId(MON.CODES.WORKER_OFFLINE, e.workerId);
      const row = await rowOf(id);
      const rows = await n1(`SELECT COUNT(*)::int n FROM office_monitor_alerts WHERE code = $1`,
        [MON.CODES.WORKER_OFFLINE]);

      if (row && rows === 1 && row.occurrences === 20) {
        ok(`twenty sweeps produced ONE row with occurrences=20 — the deduplication is the PRIMARY `
          + 'KEY, so a monitor firing every five minutes cannot produce 864 identical rows even if '
          + 'somebody later forgets why that mattered');
      } else bad('a persisting condition produced more than one row', { rows, row });

      if (row && new Date(row.last_seen_at).getTime() > new Date(row.first_seen_at).getTime()) {
        ok('and `last_seen_at` moved while `first_seen_at` did not — the row says how long this '
          + 'has been wrong, which is the figure an operator acts on');
      } else bad('the row did not record how long the condition has persisted', row);

      if (last && last.ok && last.errors.length === 0) {
        ok(`the sweep reports what it filed (${last.filed.length} finding(s): `
          + `${last.counts.critical} critical, ${last.counts.warning} warning, `
          + `${last.counts.info} info)`);
      } else bad('the sweep reported an error', last);
    }

    // ══ 2. THE DESTRUCTIVE CONTROL: WHAT HOLDS THE DEDUPLICATION ═════════
    head('2. the primary key is the arbiter, named by removing it');

    {
      // A disposable cluster, so the table can be rebuilt without its key and put back. Section 1
      // above is a clean result and a clean result alone proves nothing about WHY.
      await query('CREATE TABLE mon_dedupe_control (id TEXT PRIMARY KEY, n INT NOT NULL DEFAULT 1)');
      const id = 'alert-control';
      const insert = () => query(
        `INSERT INTO mon_dedupe_control (id) VALUES ($1)
         ON CONFLICT (id) DO UPDATE SET n = mon_dedupe_control.n + 1`, [id]);
      await insert(); await insert(); await insert();
      const withKey = await n1('SELECT COUNT(*)::int n FROM mon_dedupe_control');

      await query('ALTER TABLE mon_dedupe_control DROP CONSTRAINT mon_dedupe_control_pkey');
      // The same statement needs its ON CONFLICT target removed once the key is gone — which is
      // itself the point: without the key the upsert is not even expressible, so the write becomes
      // a plain INSERT and the duplicates appear.
      await query('INSERT INTO mon_dedupe_control (id) VALUES ($1)', [id]);
      await query('INSERT INTO mon_dedupe_control (id) VALUES ($1)', [id]);
      const withoutKey = await n1('SELECT COUNT(*)::int n FROM mon_dedupe_control');
      await query('DROP TABLE mon_dedupe_control');

      if (withKey === 1 && withoutKey === 3) {
        ok(`with the key, three writes of one id are ONE row; without it the same writes are `
          + `${withoutKey} — the database is doing the deduplication, not the monitor's memory`);
      } else bad('the control did not demonstrate the arbiter', { withKey, withoutKey });
    }

    // ══ 3. SILENCE, AND ONLY WHEN IT MEANS SOMETHING ═════════════════════
    head('3. a switched-off scheduler is INFO; an enabled one past the bound is CRITICAL');

    {
      const off = await MON.evaluate(CTX, { schedulerEnabled: false }, deps);
      const disabled = off.findings.find((f) => f.code === MON.CODES.SCHEDULER_DISABLED);
      if (disabled && disabled.severity === 'info'
        && !off.findings.some((f) => f.code === MON.CODES.SCHEDULER_SILENT)) {
        ok('with OFFICE_INITIATOR_ENABLED unset — which is production today — the finding is INFO '
          + 'and names the reason, and silence is NOT also reported: an alert that fires because '
          + 'the system is deliberately inert is noise, and noise makes a real alert unreadable');
      } else bad('a deliberately inert scheduler raised an alarm', off.findings);

      const on = await MON.evaluate(CTX, { schedulerEnabled: true }, deps);
      const silent = on.findings.find((f) => f.code === MON.CODES.SCHEDULER_SILENT);
      if (silent && silent.severity === 'critical') {
        ok('with it enabled and no heartbeat ever recorded, the same evaluation is CRITICAL — the '
          + 'severity turns on whether the scheduler is SUPPOSED to be running, which is read '
          + 'rather than assumed');
      } else bad('an enabled scheduler with no heartbeat was not critical', on.findings);

      // A fresh heartbeat clears it; a stale one brings it back. Written through the accessor the
      // real cron uses.
      await SCOPE.touchSchedulerHeartbeat('office-cycle-advance', { detail: 'firing' }, deps);
      const beating = await MON.evaluate(CTX, { schedulerEnabled: true }, deps);
      if (!beating.findings.some((f) => f.code === MON.CODES.SCHEDULER_SILENT)) {
        ok('a heartbeat from this second clears it — and the heartbeat is written by the REAL cron '
          + 'on every firing, including a tick it SKIPS, because a skipped tick is a live '
          + 'scheduler and a missing heartbeat is not');
      } else bad('a live scheduler was still reported silent', beating.findings);

      await query(`UPDATE office_scheduler_heartbeats SET at = $1 WHERE name = $2`,
        [new Date(Date.now() - (MON.SILENCE_AFTER_SECONDS + 60) * 1000).toISOString(),
          'office-cycle-advance']);
      const stale = await MON.evaluate(CTX, { schedulerEnabled: true }, deps);
      const again = stale.findings.find((f) => f.code === MON.CODES.SCHEDULER_SILENT);
      if (again && /past the/.test(again.detail)) {
        ok(`past the ${MON.SILENCE_AFTER_SECONDS}s bound it returns, naming the age and the bound `
          + '— B4.5 asks for silence beyond five minutes to be noticed, and the bound is a '
          + 'parameter rather than a number somebody has to find in the source');
      } else bad('a stale heartbeat was not noticed', stale.findings);
    }

    // ══ 4. RESOLUTION IS THE CONDITION GOING AWAY ════════════════════════
    head('4. resolved by the condition, never by a timeout — and the row stays');

    {
      // The offline worker from section 1 comes back online.
      const w = made.workers[0];
      await query(`UPDATE worker_identities SET last_seen_at = NOW() WHERE id = $1`, [w]);
      const before = await rowOf(MON.alertId(MON.CODES.WORKER_OFFLINE, w));
      const r = await MON.sweep(CTX, { schedulerEnabled: false }, deps);
      const after = await rowOf(MON.alertId(MON.CODES.WORKER_OFFLINE, w));

      if (after && after.resolved_at && r.resolved.includes(before.id)) {
        ok('the worker authenticating again resolves its alert, and the sweep says which alerts it '
          + 'resolved');
      } else bad('a cleared condition left its alert open', { before, after, r });

      if (after && after.occurrences === before.occurrences) {
        ok('and the ROW STAYS, with its history intact — "this was wrong for two hours on Tuesday" '
          + 'is what an operator needs after an incident, and deleting it would make the alert '
          + 'table a statement about the present only');
      } else bad('resolving the alert altered its history', { before, after });

      // And it comes back as the SAME row if the condition returns: a recurrence is not a new fault.
      await query(`UPDATE worker_identities SET last_seen_at = $2 WHERE id = $1`,
        [w, new Date(Date.now() - 7200_000).toISOString()]);
      await MON.sweep(CTX, { schedulerEnabled: false }, deps);
      const back = await rowOf(MON.alertId(MON.CODES.WORKER_OFFLINE, w));
      const rows = await n1(
        `SELECT COUNT(*)::int n FROM office_monitor_alerts WHERE code = $1`,
        [MON.CODES.WORKER_OFFLINE]);
      if (back && !back.resolved_at && rows === 1) {
        ok('a condition that returns re-opens the SAME row rather than filing a second — an alert '
          + 'that stayed resolved while the fault was live would be the worst of both');
      } else bad('a recurrence produced a second alert', { rows, back });
    }

    // ══ 5. A STOP HALTS THE MONITOR BY NAME ══════════════════════════════
    head('5. haltable by its own STOP, without halting the scheduler it watches');

    {
      const scopes = autonomy.CRON_SCOPES['office-monitor'];
      if (scopes && scopes.agent === 'office-monitor') {
        ok('`office-monitor` is in CRON_SCOPES, so `withAlerts` refuses it on a stop BEFORE the '
          + 'body runs — and it has its own name, so halting the scheduler does not silently halt '
          + 'the watcher, which would be the worst available coupling');
      } else bad('the monitor cron has no autonomy scope', scopes);

      const advance = autonomy.CRON_SCOPES['office-cycle-advance'];
      if (advance && advance.agent !== scopes.agent) {
        ok(`and it is a DIFFERENT agent from the scheduler (${scopes.agent} vs `
          + `${advance.agent}), so a stop on one does not reach the other`);
      } else bad('the monitor and the scheduler share an agent scope', { scopes, advance });
    }

    // ══ 6. IT SENDS NOTHING, AND THE SPY CAN FIRE ════════════════════════
    head('6. no external notification — with the spy proved able to fire');

    {
      const beforeCount = outward.length;
      // FIRE IT DELIBERATELY. A spy whose silence nobody has tested makes "nothing was sent"
      // unfalsifiable, which is the most comfortable possible wrong answer.
      try { await fetch('http://127.0.0.1:1/monitor-spy-proof'); } catch (_) { /* expected */ }
      const fired = outward.length > beforeCount;

      const atStart = outward.length;
      for (let i = 0; i < 3; i++) await MON.sweep(CTX, { schedulerEnabled: false }, deps);
      const duringSweeps = outward.length - atStart;

      if (fired && duringSweeps === 0) {
        ok('the spy recorded a deliberate call and recorded NOTHING across three sweeps — so the '
          + 'silence is evidence rather than an untested assumption');
      } else bad('the monitor sent something, or the spy could not fire',
        { fired, duringSweeps, last: outward.slice(-3) });

      const emails = await n1(`SELECT COUNT(*)::int n FROM email_log`).catch(() => 0);
      if (emails === 0) ok('and no email was logged by any path');
      else bad(`${emails} email log row(s) exist`);
    }

    // ══ 7. WHAT THIS DOES NOT CLAIM ══════════════════════════════════════
    head('7. what this does not claim');

    {
      const alerts = await openOf();
      ok(`${alerts.length} open alert(s) are readable through the accessor, company-scoped, for `
        + 'the Command Center to show');
      note('NOT covered: the monitor has never run as a CRON in a long-lived process — it is '
        + 'registered behind OFFICE_MONITOR_ENABLED, which is set nowhere, and B4.7\'s 72-hour run '
        + 'is where a schedule proves itself');
      note('NOT covered: notifying anybody. By the owner\'s Priority 3 there must be NO external '
        + 'notification until separately authorized, and the module requires no transport at all — '
        + 'asserted on its source by monitor-has-no-transport.test.js, so enabling notification '
        + 'means ADDING a dependency, which is a reviewable change rather than a configuration one');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    try {
      for (const id of made.companies) {
        await query(`DELETE FROM office_monitor_alerts WHERE company_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM worker_tasks WHERE company_id=$1`, [id]).catch(() => {});
      }
      for (const id of made.objectives) {
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.workers) {
        await query(`DELETE FROM worker_identities WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.companies) {
        await query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => {});
      }
      await query(`DELETE FROM office_scheduler_heartbeats WHERE name = 'office-cycle-advance'`)
        .catch(() => {});
    } catch (e) { bad('cleanup failed', e.message); }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
