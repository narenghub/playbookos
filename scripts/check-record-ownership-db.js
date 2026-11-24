#!/usr/bin/env node
// ── OPERATIONAL RECORDS BELONG TO A COMPANY (B7.21) ─────────────────────────
//
//   node scripts/check-record-ownership-db.js   exit 0 = every ruled property holds
//                                               exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner instruction, 2026-11-24:
//
//   "Filtering employees alone is insufficient. The underlying tasks, orders, objectives and
//    performance records must also belong to the authorized company. Where legacy records lack
//    company ownership, prepare a reviewed migration and explicit attribution proposal. Do not
//    infer ownership or silently assign ambiguous records to ABIOZEN."
//
// MEASURED BEFORE BUILDING: thirteen operational tables carried no company ownership of any kind —
// daily_tasks, orders, performance_scores, milestones, targets, activity_logs, kpi_hierarchy,
// weekly_kpis, goal_cascades, agent_activity_log, approval_queue, email_log, metrics_snapshots.
// Zero `company_id` columns between them. Scoping only the employee query would have produced a
// workflow that selects the right people and then reads every company's tasks, scores and revenue.
//
// THE PROPERTY THIS CHECK EXISTS FOR, above all others: a row whose company_id is NULL is visible
// to NO company, not to every company. The tempting predicate is
// `company_id = $1 OR company_id IS NULL` — "mine, plus the ones nobody has claimed" — and it would
// hand every company every unattributed record in the platform. Unattributed data is not shared
// data; it is data whose owner is unknown, and the safe reading of an unknown owner is nobody.
//
// NO URL OVERRIDE: this ALTERs core tables and INSERTs into them. A script that can only reach a
// cluster it created cannot have the 2026-09-30 accident where "it will be refused anyway" turned
// out to be a prediction rather than a safeguard. Fixtures are removed by id regardless.

'use strict';

const crypto = require('node:crypto');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'recown' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  record ownership not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'recown-bootstrap@recown.invalid';
process.env.ADMIN_PASSWORD = `recown-${crypto.randomBytes(16).toString('hex')}`;

const WATCHDOG_MS = Number(process.env.RECOWN_CHECK_TIMEOUT_MS || 240_000);
const watchdog = setTimeout(() => {
  console.log(`\n  FAIL  no progress in ${Math.round(WATCHDOG_MS / 1000)}s — a stall is a failure.`);
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };
  const made = { companies: [], users: [], memberships: [], rows: [] };
  const uid = (p) => `recown-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    // THE FULL CORE CHAIN, because the operational tables are spread across three of its steps:
    // initDB creates `orders` and `milestones`; initPhase2 the phase-2 set; and migrateSchemas
    // creates `performance_scores` and `daily_tasks` (db.js:553 and :631). Omitting the last
    // produced `relation "daily_tasks" does not exist` — twice, because I first assumed
    // initPhase2 owned them. The loud failure is correct: 42P01 is not an ignorable code, so a
    // wrong order fails rather than silently skipping the ALTER and leaving every scoped read
    // quietly empty.
    await require('../src/lib/db').initPhase2();
    await require('../src/lib/db').migrateSchemas();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    const SCHEMA = require('../src/lib/identity/schema');
    await SCHEMA.migrateIdentity(q);
    await SCHEMA.migrateRecordOwnership(q);
    console.log('  ..    schema up\n');

    const CTX = require('../src/lib/office/context');
    const MBR = require('../src/lib/identity/company-membership');
    const OPS = require('../src/lib/identity/scoped-operations');
    const POLICY = require('../src/lib/identity/record-ownership');

    // ── 1. THE COLUMNS EXIST, AND ARE NULLABLE ON PURPOSE ──────────────────
    for (const t of ['daily_tasks', 'performance_scores', 'weekly_kpis', 'activity_logs',
      'milestones', 'targets', 'orders', 'metrics_snapshots']) {
      const c = (await q(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'company_id'`, [t])).rows[0];
      if (!c) { bad(`${t} has no company_id column — the migration did not reach it`); continue; }
      if (c.is_nullable === 'YES') ok(`${t}.company_id exists and is NULLABLE`);
      else bad(`${t}.company_id is NOT NULL — the migration forced a value onto legacy rows`, t);
    }
    note('NULLABLE is deliberate: NOT NULL would have required inventing an owner for every '
      + 'existing row, which is the inference the owner forbade.');

    // ── 2. metrics_snapshots KEPT ITS DAILY GUARANTEE ──────────────────────
    //
    // The trap: replacing UNIQUE(snapshot_date) with UNIQUE(snapshot_date, company_id) would have
    // DESTROYED it, because NULLs are distinct in a Postgres unique index and every legacy row has
    // company_id NULL. Both guarantees are asserted here, by trying to break each.
    const dupPortfolio = async () => {
      await q(`INSERT INTO metrics_snapshots (id, snapshot_date) VALUES ($1, '2026-01-01')`, ['recown-snap-a']);
      made.rows.push(['metrics_snapshots', 'recown-snap-a']);
      try {
        await q(`INSERT INTO metrics_snapshots (id, snapshot_date) VALUES ($1, '2026-01-01')`, ['recown-snap-b']);
        made.rows.push(['metrics_snapshots', 'recown-snap-b']);
        return false;
      } catch (e) { return e.code === '23505'; }
    };
    if (await dupPortfolio()) {
      ok('ONE portfolio snapshot per day is still enforced — the NULL-is-distinct trap was avoided');
    } else {
      bad('two portfolio snapshots for one day were accepted: widening the unique key silently '
        + 'destroyed the daily guarantee');
    }

    // ── FIXTURES: TWO COMPANIES, A SHARED EMPLOYEE, AND RECORDS ────────────
    const A = uid('co-abiozen'); const B = uid('co-adifice');
    for (const id of [A, B]) {
      await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [id]);
      made.companies.push(id);
    }
    const mkUser = async (h, role = 'sales_team') => {
      const id = uid(`u-${h}`);
      await q(`INSERT INTO users (id, email, name, role, is_active) VALUES ($1,$2,$3,$4,1)`,
        [id, `${h}@recown.invalid`, h, role]);
      made.users.push(id);
      return id;
    };
    const owner = await mkUser('owner', 'super_admin');
    const grant = async (userId, companyId) => {
      const r = await MBR.grantMembership({
        userId, companyId, companyRole: 'admin', grantedBy: owner, grantedReason: 'fixture',
      }, deps);
      made.memberships.push(r.id);
      return r;
    };

    const onlyA = await mkUser('onlya');
    const shared = await mkUser('shared');       // the Prasanthi case
    await grant(onlyA, A);
    await grant(shared, A);
    await grant(shared, B);

    const ctxA = CTX.contextForTests__TEST_ONLY({ companyId: A });
    const ctxB = CTX.contextForTests__TEST_ONLY({ companyId: B });

    // ── 3. EMPLOYEE SELECTION IS COMPANY-SCOPED, AND SHARED MEANS BOTH ─────
    const empA = await OPS.employeesOf(ctxA, deps);
    const empB = await OPS.employeesOf(ctxB, deps);
    const idsA = (empA || []).map((e) => e.id).sort();
    const idsB = (empB || []).map((e) => e.id).sort();
    if (idsA.includes(onlyA) && idsA.includes(shared)) ok('company A sees its own and the shared employee');
    else bad('company A\'s roster is wrong', idsA);
    if (idsB.includes(shared) && !idsB.includes(onlyA)) {
      ok('company B sees the shared employee and NOT the one who is not its member');
    } else bad('company B\'s roster leaked', idsB);

    // ── 4. THE CENTRAL PROPERTY: AN UNATTRIBUTED ROW IS INVISIBLE ──────────
    //
    // A task assigned to a person who IS a member of company A, but whose own company_id is NULL.
    // If visibility were derived from the assignee, company A would see it — and so would B, since
    // the shared employee belongs to both. It must be seen by neither.
    const orphanTask = uid('task-orphan');
    await q(`INSERT INTO daily_tasks (id, user_id, task_date, task_title, status)
             VALUES ($1,$2,'2026-11-24','orphan task','pending')`, [orphanTask, shared]);
    made.rows.push(['daily_tasks', orphanTask]);

    const tA = await OPS.tasksFor(ctxA, { date: '2026-11-24' }, deps);
    const tB = await OPS.tasksFor(ctxB, { date: '2026-11-24' }, deps);
    if (!tA.some((t) => t.id === orphanTask) && !tB.some((t) => t.id === orphanTask)) {
      ok('an UNATTRIBUTED task is invisible to BOTH companies — not shared, not universal, '
        + 'and not derived from its assignee\'s memberships');
    } else {
      bad('an unattributed task was visible to a company', { A: tA.map((t) => t.id), B: tB.map((t) => t.id) });
    }

    // ── 5. AND AN ATTRIBUTED ROW IS SEEN BY EXACTLY ONE COMPANY ────────────
    const taskA = uid('task-a');
    await q(`INSERT INTO daily_tasks (id, user_id, task_date, task_title, status, company_id)
             VALUES ($1,$2,'2026-11-24','A task','pending',$3)`, [taskA, shared, A]);
    made.rows.push(['daily_tasks', taskA]);
    const tA2 = await OPS.tasksFor(ctxA, { date: '2026-11-24' }, deps);
    const tB2 = await OPS.tasksFor(ctxB, { date: '2026-11-24' }, deps);
    if (tA2.some((t) => t.id === taskA) && !tB2.some((t) => t.id === taskA)) {
      ok('a task attributed to A is seen by A and NOT by B — even though its assignee is a member '
        + 'of both, which is the case assignee-derived scoping would have got wrong');
    } else {
      bad('an attributed task was mis-scoped', { A: tA2.map((t) => t.id), B: tB2.map((t) => t.id) });
    }

    // ── 6. THE SAME FOR SCORES, MILESTONES, REVENUE AND ACTIVITY ───────────
    const scoreA = uid('score-a'); const scoreNull = uid('score-null');
    await q(`INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100, company_id)
             VALUES ($1,$2,'2026-11-24',80,$3)`, [scoreA, shared, A]);
    await q(`INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100)
             VALUES ($1,$2,'2026-11-24',20)`, [scoreNull, shared]);
    made.rows.push(['performance_scores', scoreA], ['performance_scores', scoreNull]);
    const sA = await OPS.scoresFor(ctxA, { date: '2026-11-24' }, deps);
    const sB = await OPS.scoresFor(ctxB, { date: '2026-11-24' }, deps);
    if (sA.length === 1 && sA[0].id === scoreA && sB.length === 0) {
      ok('scores: A sees only its own; B sees none; the unattributed score is invisible to both');
    } else bad('score scoping is wrong', { A: sA.map((x) => x.id), B: sB.map((x) => x.id) });

    // ── THE RESHAPED SCORE CONSTRAINT: BOTH HALVES, EXPLICITLY ─────────────
    //
    // performance_scores carried UNIQUE(user_id, score_date), so a shared employee could not hold
    // one score for ABIOZEN and one for Adifice on the same day. Replacing it with a three-column
    // unique key would have let the same person accumulate unlimited NULL-company scores for one
    // day, because NULLs are distinct in a Postgres unique index. Two partial indexes, so two
    // assertions — proving a constraint change by watching an unrelated test stop failing is the
    // measurement-for-the-property trap.
    const scoreB = uid('score-b');
    try {
      await q(`INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100, company_id)
               VALUES ($1,$2,'2026-11-24',55,$3)`, [scoreB, shared, B]);
      made.rows.push(['performance_scores', scoreB]);
      ok('a SHARED employee can now hold one score per company on the same day — which the old '
        + 'UNIQUE(user_id, score_date) made structurally impossible');
    } catch (e) {
      bad('a second company could not score the shared employee on the same day', e.message);
    }
    let dupSameCompany = false;
    try {
      await q(`INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100, company_id)
               VALUES ($1,$2,'2026-11-24',99,$3)`, [uid('score-dup'), shared, B]);
    } catch (e) { dupSameCompany = e.code === '23505'; }
    if (dupSameCompany) ok('and TWO scores for the same person, day and company are still refused');
    else bad('duplicate per-company scores were accepted — the daily guarantee was lost');
    let dupUnattributed = false;
    try {
      await q(`INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100)
               VALUES ($1,$2,'2026-11-24',11)`, [uid('score-dupnull'), shared]);
    } catch (e) { dupUnattributed = e.code === '23505'; }
    if (dupUnattributed) {
      ok('and the LEGACY shape is intact: one unattributed score per person per day — the '
        + 'NULL-is-distinct trap was avoided here too');
    } else bad('unlimited unattributed scores per person per day were accepted');

    const ordA = uid('ord-a'); const ordNull = uid('ord-null');
    await q(`INSERT INTO orders (id, order_date, amount, company_id) VALUES ($1,'2026-11-24',8500,$2)`, [ordA, A]);
    await q(`INSERT INTO orders (id, order_date, amount) VALUES ($1,'2026-11-24',999999)`, [ordNull]);
    made.rows.push(['orders', ordA], ['orders', ordNull]);
    const revA = await OPS.revenueFor(ctxA, { from: '2026-11-01', to: '2026-11-30' }, deps);
    const revB = await OPS.revenueFor(ctxB, { from: '2026-11-01', to: '2026-11-30' }, deps);
    if (revA.usd === 8500 && revA.orderCount === 1) ok('revenue: A sees exactly its attributed order');
    else bad('company A\'s revenue is wrong', revA);
    if (revB.usd === 0 && revB.orderCount === 0) {
      ok('revenue: B sees ZERO rather than the unattributed $999,999 — a company revenue figure '
        + 'that silently included another company\'s orders would be worse than a zero');
    } else bad('unattributed revenue leaked into a company total', revB);

    const msA = uid('ms-a'); const msNull = uid('ms-null');
    await q(`INSERT INTO milestones (id, name, target_date, status, company_id)
             VALUES ($1,'A milestone','2026-12-31','pending',$2)`, [msA, A]);
    await q(`INSERT INTO milestones (id, name, target_date, status)
             VALUES ($1,'orphan milestone','2026-12-31','pending')`, [msNull]);
    made.rows.push(['milestones', msA], ['milestones', msNull]);
    const mA = await OPS.milestonesFor(ctxA, {}, deps);
    if (mA.length === 1 && mA[0].id === msA) ok('milestones are company-scoped');
    else bad('milestone scoping is wrong', mA.map((x) => x.id));

    const alA = uid('al-a');
    await q(`INSERT INTO activity_logs (id, user_id, log_date, metric, value, company_id)
             VALUES ($1,$2,'2026-11-24','calls',5,$3)`, [alA, shared, A]);
    made.rows.push(['activity_logs', alA]);
    const actB = await OPS.activityFor(ctxB, {}, deps);
    if (actB.length === 0) ok('historical activity is company-scoped — B sees none of A\'s');
    else bad('activity logs leaked', actB.map((x) => x.id));

    // ── 7. NO FUNCTION ACCEPTS A COMPANY ID, AND A SHAPE IS NOT A CONTEXT ──
    const forged = [
      ['a plain frozen object', Object.freeze({ companyId: A })],
      ['a copy with the company changed', Object.freeze({ ...ctxA, companyId: B })],
      ['a bare company id string', A],
    ];
    for (const [label, candidate] of forged) {
      let refused = 0;
      for (const fn of [() => OPS.tasksFor(candidate, {}, deps),
        () => OPS.scoresFor(candidate, {}, deps),
        () => OPS.revenueFor(candidate, {}, deps),
        () => OPS.employeesOf(candidate, deps),
        () => OPS.milestonesFor(candidate, {}, deps),
        () => OPS.activityFor(candidate, {}, deps)]) {
        try { await fn(); } catch (e) { if (e && e.name === 'NoCompanyContext') refused++; }
      }
      if (refused === 6) ok(`all six readers REFUSE ${label}`);
      else bad(`${label} was accepted by ${6 - refused} of 6 readers`, label);
    }

    // ── 8. THE ATTRIBUTION POLICY DECIDES NOTHING BY ITSELF ────────────────
    //
    // deriveOwner returns a verdict. The shared-employee case must come back AMBIGUOUS, because
    // "which company is this task for" is a decision when the person works for two.
    const one = POLICY.deriveOwner({ memberships: [{ companyId: A }] });
    const two = POLICY.deriveOwner({ memberships: [{ companyId: A }, { companyId: B }] });
    const none = POLICY.deriveOwner({ memberships: [] });
    const unknown = POLICY.deriveOwner({ memberships: null });
    if (one.ok && one.companyId === A) ok('policy: one active membership DERIVES the owner');
    else bad('policy failed the single-membership case', one);
    if (!two.ok && two.reason === 'ambiguous') {
      ok('policy: a SHARED employee is AMBIGUOUS — not silently assigned to the first company');
    } else bad('policy resolved an ambiguous record', two);
    if (!none.ok && none.reason === 'no_member') ok('policy: no membership is no_member, not a default');
    else bad('policy invented an owner for a non-member', none);
    if (!unknown.ok && unknown.reason === 'unknown') {
      ok('policy: an unreadable membership is UNKNOWN — an outage is not an attribution');
    } else bad('policy treated an outage as an answer', unknown);

    // Real memberships through the real accessor, so the policy is exercised on live data.
    const derivedOnlyA = POLICY.deriveOwner({ memberships: await MBR.membershipsOf(onlyA, deps) });
    const derivedShared = POLICY.deriveOwner({ memberships: await MBR.membershipsOf(shared, deps) });
    if (derivedOnlyA.ok && derivedOnlyA.companyId === A) ok('against real memberships: the single-company employee derives');
    else bad('real derivation failed', derivedOnlyA);
    if (!derivedShared.ok && derivedShared.reason === 'ambiguous') {
      ok('against real memberships: the shared employee is ambiguous and needs a decision');
    } else bad('the real shared employee was resolved', derivedShared);

    // ── 9. ORDERS CANNOT BE ATTRIBUTED BY ANY RULE, AND THAT IS RECORDED ───
    const orderCols = (await q(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'`))
      .rows.map((r) => r.column_name);
    const subjectish = orderCols.filter((c) => /user|owner|buyer_id|seller|assigned|member/.test(c));
    if (subjectish.length === 0 && POLICY.TABLES.orders.klass === POLICY.CLASS.UNATTRIBUTABLE) {
      ok('orders carry no column naming a person or a company, and the policy records them as '
        + 'UNATTRIBUTABLE rather than guessing — revenue needs explicit owner attribution');
    } else {
      bad('the orders policy and the orders schema disagree', { subjectish, klass: POLICY.TABLES.orders.klass });
    }

    // ── 10. WHAT IS UNATTRIBUTED IS COUNTABLE, NOT HIDDEN ──────────────────
    const counts = await OPS.unattributedCounts(ctxA, deps);
    if (counts.daily_tasks >= 1 && counts.orders >= 1 && counts.performance_scores >= 1) {
      ok('unattributed rows are COUNTABLE — the honest answer to "why is this briefing empty" is '
        + 'available to the briefing, not buried in a migration note');
      note(`counts in this fixture: ${JSON.stringify(counts)}`);
    } else bad('unattributed rows are not countable', counts);
  } catch (e) {
    bad('the check threw', e && (e.stack || e.message));
  } finally {
    try {
      for (const [t, id] of made.rows.reverse()) {
        await q(`DELETE FROM ${t} WHERE id = $1`, [id]).catch(() => {});
      }
      for (const id of made.memberships) await q(`DELETE FROM user_companies WHERE id = $1`, [id]).catch(() => {});
      for (const id of made.users) await q(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
      for (const id of made.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]).catch(() => {});
      const left = (await q(`SELECT COUNT(*)::int n FROM daily_tasks WHERE company_id = ANY($1)`,
        [made.companies])).rows[0].n;
      if (left === 0) ok('cleanup: my fixtures are gone');
      else bad('cleanup leaked fixtures', left);
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    cluster.destroy();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  operational records do not hold every ruled ownership property.');
    process.exit(1);
  }
  console.log('\nPASS  B7.21 foundation: tasks, scores, milestones, revenue and activity belong to a '
    + 'company and are read through one accessor that takes a context and never a company id; an '
    + 'UNATTRIBUTED row is visible to NO company rather than to all; a shared employee\'s record '
    + 'is AMBIGUOUS rather than assigned; orders are recorded as unattributable rather than '
    + 'guessed; and metrics_snapshots kept its one-per-day guarantee through the change.');
  process.exit(0);
})();
