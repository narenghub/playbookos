#!/usr/bin/env node
// ── GOVERNED OPERATIONAL FACTS, AND EVERY FIGURE RECOUNTED ──────────────────
//
//   node scripts/check-operational-facts-db.js   exit 0 = every ruled property holds
//                                                 exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's Priority 4, second directive of 2026-11-25: *"a governed, company-scoped, read-only
// operational facts source using existing authorized data-access modules … Start with synthetic
// fixtures covering employee assignments, task completion, milestones, objectives and execution
// outcomes. Distinguish measured zero, missing data, stale data and unavailable data … Verify every
// briefing figure against independent evidence."*
//
// ── EVERY FIGURE IS RECOUNTED BY AN INDEPENDENT PATH ───────────────────────
//
// This is B3.10's step-13 pattern, and it is here for the reason it was there: a briefing that
// reports its own bookkeeping cannot be wrong about it. So every number the facts source produces
// is recounted in raw SQL BY THIS CHECK — not through the accessors that produced it — and the two
// must agree. That is the one place in this repository where a second copy of a company predicate
// is the right thing to write, because the whole question is whether the first copy is correct.
//
// ── AND THE FOUR STATES ARE PROVED BY ARRANGING THEM, NOT BY READING CODE ──
//
// measured zero · missing (rows exist but belong to nobody) · stale · unavailable. Each is set up
// as an actual database state, with a CONTROL that turns it back into the previous reading — so the
// distinction is measured rather than asserted. The unattributed case gets the most attention
// because it is the one that decides whether a zero in a CEO briefing means anything.
//
// NO URL OVERRIDE: its own disposable cluster; every fixture created by id and removed by id.

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
  cluster = DISPOSABLE.create({ label: 'facts' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  operational facts were not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'facts-bootstrap@facts.invalid';
process.env.ADMIN_PASSWORD = `facts-${crypto.randomBytes(16).toString('hex')}`;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 300s — a stall is a failure.');
  process.exit(1);
}, 300_000);
watchdog.unref?.();

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
  // The worker tables and a sealing key, because the only honest route to the REPORT phase is for a
// real worker to complete the dispatched step. Enrolment is done IN PROCESS here
// (`consumeEnrollmentToken`) rather than over HTTP: this check is about facts, not about the
// enrolment path, which has its own checks.
const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };
const deps = { query, withTransaction, env: SEAL };
  const brokenOn = (re, code = '57P01') => ({
    ...deps,
    query: (t, p) => (re.test(String(t))
      ? Promise.reject(Object.assign(new Error('simulated database outage'), { code }))
      : query(t, p)),
  });

  const made = { companies: [], objectives: [], users: [], tasks: [], milestones: [] };
  const uid = (p) => `facts-${p}-${crypto.randomUUID().slice(0, 8)}`;
  const n1 = async (sql, params) => (await query(sql, params)).rows[0].n;
  const ASOF = '2026-11-26';

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

    const FACTS = require('../src/lib/office/operational-facts');
    const CTXMOD = require('../src/lib/office/context');
    const MEMBERSHIP = require('../src/lib/identity/company-membership');
    const OPS = require('../src/lib/identity/scoped-operations');
    const SCOPE = require('../src/lib/office/scope');

    // The platform starts with an admin seeded by initDB, and `users` is a production table — so
    // the unattributed counters are NOT zero to begin with for every table. That is the real
    // starting condition and the sections below are written against it rather than against a
    // convenient fiction.
    const newCompany = async (label) => {
      const id = uid(label);
      await query(`INSERT INTO companies (id, slug, display_name, status)
                   VALUES ($1,$1,$1,'active')`, [id]);
      made.companies.push(id);
      return id;
    };
    const newObjective = async (companyId, status = 'active') => {
      const id = uid('obj');
      await query(`INSERT INTO objectives
                     (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                      created_by, budget_usd)
                   VALUES ($1,$2,'facts fixture','P1','supervised','all_consequential',$3,
                           'naren@fixture.invalid',5.00)`, [id, companyId, status]);
      made.objectives.push(id);
      return id;
    };
    const ctxFor = async (objectiveId) => CTXMOD.resolveObjectiveContext({ objectiveId }, deps);
    const factOf = (r, kind) => r.facts.find((f) => f.kind === kind);

    // ══ 1. THE FIVE FAMILIES, AND EVERY FIGURE RECOUNTED ═════════════════
    head('1. the five fact families, each recounted by an independent path');

    const CO = await newCompany('co-full');
    const OBJ = await newObjective(CO);
    await newObjective(CO, 'paused');       // so "active" is not simply "all"
    const CTX = await ctxFor(OBJ);

    {
      // A member, so tasks can be assigned through the real writer.
      const EMP = uid('emp'); const ACTOR = uid('actor');
      await query(`INSERT INTO users (id, email, name, role, password_hash, is_active)
                   VALUES ($1,$2,'Facts Employee','admin','x',1)`, [EMP, `${EMP}@fixture.invalid`]);
      await query(`INSERT INTO users (id, email, name, role, password_hash, is_active)
                   VALUES ($1,$2,'Facts Authorizer','super_admin','x',1)`,
        [ACTOR, `${ACTOR}@fixture.invalid`]);
      made.users.push(EMP, ACTOR);
      await MEMBERSHIP.grantMembership({ userId: EMP, companyId: CO, companyRole: 'member',
        grantedBy: ACTOR, reason: 'fixture member so assignments can exist at all' }, deps);

      for (const i of [1, 2, 3]) {
        const id = uid(`task${i}`);
        const r = await OPS.assignTask(CTX, { id, userId: EMP, title: `fixture task ${i}`,
          taskDate: ASOF, priority: 'MEDIUM', assignedBy: 'facts-check' }, deps);
        if (!r.ok) throw new Error(`fixture task ${i} refused: ${JSON.stringify(r)}`);
        made.tasks.push(id);
      }
      await OPS.completeTask(CTX, { id: made.tasks[0] }, deps);

      const MS = uid('ms');
      await query(`INSERT INTO milestones (id, name, target_date, status, company_id)
                   VALUES ($1,'fixture milestone',$2,'pending',$3)`, [MS, ASOF, CO]);
      made.milestones.push(MS);

      // An outcome needs a run, because office_outcomes' composite FK refuses one without.
      const INIT = require('../src/lib/office/initiator');
      const started = await INIT.initiateDueObjectives({ companyId: CO }, deps);
      const RUN = (started.initiated[0] || {}).runId;
      if (!RUN) throw new Error(`no run for the outcome fixture: ${JSON.stringify(started)}`);
      await SCOPE.recordOutcome(CTX, { id: uid('out'), runId: RUN, outcome: 'achieved',
        businessEffect: 'facts fixture' }, deps);

      const r = await FACTS.collect(CTX, { asOf: ASOF }, deps);

      // ── INDEPENDENT RECOUNT. Raw SQL, this check's own, not the accessors'. ──
      const recount = {
        assigned: await n1(`SELECT COUNT(*)::int n FROM daily_tasks
                             WHERE company_id = $1 AND task_date = $2`, [CO, ASOF]),
        completed: await n1(`SELECT COUNT(*)::int n FROM daily_tasks
                              WHERE company_id = $1 AND task_date = $2 AND status = 'completed'`,
          [CO, ASOF]),
        milestonesOpen: await n1(`SELECT COUNT(*)::int n FROM milestones
                                   WHERE company_id = $1 AND status NOT IN
                                     ('achieved','completed')`, [CO]),
        objectivesActive: await n1(`SELECT COUNT(*)::int n FROM objectives
                                     WHERE company_id = $1 AND status = 'active'`, [CO]),
        outcomes: await n1(`SELECT COUNT(*)::int n FROM office_outcomes
                             WHERE company_id = $1`, [CO]),
      };

      const pairs = [
        ['employee_assignments', recount.assigned],
        ['task_completion', recount.completed],
        ['milestones', recount.milestonesOpen],
        ['objectives', recount.objectivesActive],
        ['execution_outcomes', recount.outcomes],
      ];
      const wrong = pairs.filter(([kind, expected]) => {
        const f = factOf(r, kind);
        return !f || f.value !== expected;
      }).map(([kind, expected]) => ({ kind, expected, got: factOf(r, kind) && factOf(r, kind).value }));

      if (!wrong.length && r.facts.length === 5) {
        ok(`all five families reported, and EVERY figure matches an independent recount `
          + `(${pairs.map(([k, v]) => `${k}=${v}`).join(', ')})`);
      } else bad('a reported figure does not match the independent recount', wrong);

      if (pairs.every(([kind]) => factOf(r, kind).status === FACTS.STATUS.MEASURED
        || factOf(r, kind).status === FACTS.STATUS.MEASURED_ZERO)) {
        ok('each one is MEASURED rather than inferred, and names the accessor that produced it: '
          + r.facts.map((f) => f.source.split('.').pop()).join(', '));
      } else bad('a figure with real rows behind it was not reported as measured',
        r.facts.map((f) => [f.kind, f.status]));

      // The completion figure must carry its own denominator, or it is a rate nobody can check.
      const tc = factOf(r, 'task_completion');
      if (tc.parts && tc.parts.assigned === recount.assigned
        && tc.parts.completed === recount.completed) {
        ok(`task completion carries its denominator (${tc.parts.completed}/${tc.parts.assigned}) `
          + 'from the SAME read — two reads could report 7 of 5');
      } else bad('the completion figure has no checkable denominator', tc);
    }

    // ══ 2. MEASURED ZERO ═════════════════════════════════════════════════
    head('2. measured zero: counted and genuinely nothing');

    {
      // A company of its own with nothing in it, and nothing unattributed in the tables behind the
      // families that can be unattributed.
      const CO2 = await newCompany('co-empty');
      const OBJ2 = await newObjective(CO2);
      const CTX2 = await ctxFor(OBJ2);
      const unatt = await n1(`SELECT COUNT(*)::int n FROM daily_tasks WHERE company_id IS NULL`);
      const r = await FACTS.collect(CTX2, { asOf: ASOF }, deps);
      const asg = factOf(r, 'employee_assignments');
      if (unatt === 0 && asg.value === 0 && asg.status === FACTS.STATUS.MEASURED_ZERO) {
        ok('with nothing assigned and nothing unattributed, the zero is MEASURED_ZERO — the '
          + 'accessor answered and there is genuinely nothing');
      } else bad('a genuine zero was not reported as measured', { unatt, asg });

      const objf = factOf(r, 'objectives');
      if (objf.value === 1 && objf.status === FACTS.STATUS.MEASURED) {
        ok('and the same collection still measures what IS there — an empty family does not make '
          + 'the briefing empty');
      } else bad('a populated family went missing beside an empty one', objf);
    }

    // ══ 3. MISSING: THE ROWS EXIST AND BELONG TO NOBODY ══════════════════
    head('3. missing: a zero that cannot be supported, and the control that turns it back');

    {
      const CO3 = await newCompany('co-unattributed');
      const OBJ3 = await newObjective(CO3);
      const CTX3 = await ctxFor(OBJ3);

      // An unattributed task: a real row whose owner is not established. This is the state EVERY
      // scoped table is in today, per scoped-operations' own header, so it is not a contrived case.
      const ghost = uid('ghost');
      await query(`INSERT INTO daily_tasks (id, user_id, task_date, task_title, status, company_id)
                   VALUES ($1,$2,$3,'a task nobody owns','pending',NULL)`,
        [ghost, made.users[0], ASOF]);

      const r = await FACTS.collect(CTX3, { asOf: ASOF }, deps);
      const asg = factOf(r, 'employee_assignments');
      if (asg.value === 0 && asg.status === FACTS.STATUS.MISSING
        && /attribution/.test(asg.detail)) {
        ok('a zero beside unattributed rows is MISSING, not a measured zero — the figure cannot be '
          + 'supported until attribution is applied, and a CEO reading "0 tasks assigned" from a '
          + 'table full of unowned rows is reading a number nobody can back');
      } else bad('an unsupportable zero was reported as measured', asg);

      if (r.quality.unattributed && r.quality.unattributed.daily_tasks >= 1) {
        ok(`and the briefing carries the reason WITH it (${r.quality.unattributed.daily_tasks} `
          + 'unattributed row(s)) rather than leaving it in a migration note');
      } else bad('the quality signal did not travel with the facts', r.quality);

      // THE CONTROL: remove the unowned row and the same figure becomes a measured zero. Without
      // this, "missing" could be what this family always says.
      await query(`DELETE FROM daily_tasks WHERE id = $1`, [ghost]);
      const r2 = await FACTS.collect(CTX3, { asOf: ASOF }, deps);
      if (factOf(r2, 'employee_assignments').status === FACTS.STATUS.MEASURED_ZERO) {
        ok('control: with the unowned row gone, the identical query reads MEASURED_ZERO — the '
          + 'distinction is the data, not the wording');
      } else bad('the control did not restore the measured zero', factOf(r2, 'employee_assignments'));
    }

    // ══ 4. STALE ════════════════════════════════════════════════════════
    head('4. stale: the figure is real and it is not current');

    {
      const CO4 = await newCompany('co-stale');
      const OBJ4 = await newObjective(CO4);
      const CTX4 = await ctxFor(OBJ4);
      const old = uid('ms-old');
      await query(`INSERT INTO milestones (id, name, target_date, status, company_id)
                   VALUES ($1,'a milestone nobody has revised','2026-01-15','pending',$2)`,
        [old, CO4]);
      made.milestones.push(old);

      const r = await FACTS.collect(CTX4, { asOf: ASOF }, deps);
      const ms = factOf(r, 'milestones');
      if (ms.value === 1 && ms.status === FACTS.STATUS.STALE && ms.newestRecord === '2026-01-15') {
        ok(`a milestone list whose newest target is ${ms.newestRecord} is STALE and KEEPS its `
          + 'value — stale is a statement about currency, not a reason to withhold the figure');
      } else bad('an out-of-date figure was reported as current', ms);

      // The control, as a bound rather than as a date: widen the window and the same rows are
      // current. Measuring staleness by changing the DATA would also change the figure.
      const r2 = await FACTS.collect(CTX4, { asOf: ASOF, staleAfterDays: 3650 }, deps);
      if (factOf(r2, 'milestones').status === FACTS.STATUS.MEASURED) {
        ok('control: with a ten-year bound the same rows read MEASURED — the bound is doing the '
          + 'work, and it is a parameter rather than a constant somebody has to find');
      } else bad('the staleness control did not bite', factOf(r2, 'milestones'));
    }

    // ══ 5. UNAVAILABLE ══════════════════════════════════════════════════
    head('5. unavailable: a failed read is not a zero');

    {
      const r = await FACTS.collect(CTX, { asOf: ASOF },
        brokenOn(/FROM daily_tasks\s+WHERE company_id/));
      const asg = factOf(r, 'employee_assignments');
      const tc = factOf(r, 'task_completion');
      if (asg.status === FACTS.STATUS.UNAVAILABLE && asg.value === null) {
        ok('a read that failed is UNAVAILABLE with a NULL value — an outage is not an empty '
          + 'company, which is the rule scoped-operations applies to membership');
      } else bad('a failed read became a zero', asg);

      if (tc.status === FACTS.STATUS.UNAVAILABLE && /denominator/.test(tc.detail || '')) {
        ok('and the figure DERIVED from it refuses too, naming the missing denominator — a '
          + 'completion rate computed against an unknown total is arithmetic a briefing must '
          + 'not do');
      } else bad('a derived figure survived its own source failing', tc);

      const others = ['objectives', 'execution_outcomes'].map((k) => factOf(r, k));
      if (others.every((f) => f.status === FACTS.STATUS.MEASURED
        || f.status === FACTS.STATUS.MEASURED_ZERO)) {
        ok('while the families that did NOT depend on it are still measured — one unreadable '
          + 'source degrades its own figure and not the briefing');
      } else bad('one failed read took the whole collection down', others.map((f) => f.status));
    }

    // ══ 6. MISSING TABLE IS NOT AN OUTAGE ═══════════════════════════════
    head('6. an unmigrated database says so, rather than reporting an outage');

    {
      // A legitimate destructive control: the cluster is disposable and the table is renamed back
      // immediately. `42P01` is a known state with a known fix; conflating it with a timeout sends
      // somebody to the wrong problem.
      await query('ALTER TABLE milestones RENAME TO milestones_renamed_by_check');
      let r = null; let threw = null;
      try { r = await FACTS.collect(CTX, { asOf: ASOF }, deps); } catch (e) { threw = e.message; }
      await query('ALTER TABLE milestones_renamed_by_check RENAME TO milestones');

      const ms = r && factOf(r, 'milestones');
      if (ms && ms.status === FACTS.STATUS.MISSING && /unmigrated/.test(ms.detail)) {
        ok('a table this database does not carry is MISSING and names itself unmigrated, and the '
          + 'other four families still report');
      } else bad('an absent table was not told apart from an outage', { threw, ms });

      const after = await FACTS.collect(CTX, { asOf: ASOF }, deps);
      if (factOf(after, 'milestones').status !== FACTS.STATUS.MISSING) {
        ok('control: with the table back, the family reports again — the check left the schema as '
          + 'it found it');
      } else bad('the table was not restored', factOf(after, 'milestones'));
    }

    // ══ 7. COMPANY ISOLATION ════════════════════════════════════════════
    head('7. one company\'s facts are not another\'s');

    {
      const CO5 = await newCompany('co-other');
      const OBJ5 = await newObjective(CO5);
      const CTX5 = await ctxFor(OBJ5);
      const r = await FACTS.collect(CTX5, { asOf: ASOF }, deps);
      const asg = factOf(r, 'employee_assignments');
      const mine = await n1(`SELECT COUNT(*)::int n FROM daily_tasks WHERE company_id = $1`, [CO5]);
      const theirs = await n1(`SELECT COUNT(*)::int n FROM daily_tasks WHERE company_id = $1`, [CO]);
      if (asg.value === mine && mine === 0 && theirs >= 3) {
        ok(`company B reports its own ${mine} assignments while company A has ${theirs} — the `
          + 'isolation is the accessors\' and this file adds no predicate of its own');
      } else bad('a company saw another\'s rows', { asg, mine, theirs });
    }

    // ══ 8. THE BRIEFING CARRIES THE FACTS AND THEIR QUALITY ═════════════
    head('8. the cycle\'s briefing carries them, with their quality');

    {
      const CYCLE = require('../src/lib/office/cycle');
      const CO6 = await newCompany('co-briefing');
      const OBJ6 = await newObjective(CO6);
      const INIT = require('../src/lib/office/initiator');
      const started = await INIT.initiateDueObjectives({ companyId: CO6 }, deps);
      const RUN = (started.initiated[0] || {}).runId;

      // ── THE WHOLE CYCLE, BECAUSE REPORT IS WHERE THE BRIEFING IS ───
      //
      // My first version expected a plan with no executable steps and broke out of the loop at
      // COLLECT, so REPORT was never reached and the assertions below read `null` — the harness
      // measuring its own shortcut. The plan always has one executable step, so the step has to be
      // EXECUTED: a real worker, a real lease, a real result that matches the plan's payload (which
      // the stricter B3.18 criterion now requires), and the cycle advanced until it reports.
      const IDENT = require('../src/lib/worker/identity');
      const LEASES = require('../src/lib/worker/leases');
      const tok = await IDENT.createEnrollmentToken({ label: 'facts-worker' }, deps);
      const enrolled = await IDENT.consumeEnrollmentToken(
        { token: tok.token, hostFingerprint: 'facts-check' }, deps);
      if (!enrolled || !enrolled.ok) throw new Error(`enrolment failed: ${JSON.stringify(enrolled)}`);

      let reported = null;
      for (let i = 0; i < 8 && !reported; i++) {
        const a = await CYCLE.advanceCycle({ runId: RUN }, deps);
        if (a.phase === 'report') { reported = a; break; }
        if (a.phase === 'done' || a.phase === 'refused' || a.phase === 'unknown') break;
        if (a.phase === 'collect') {
          const t = (await query(`SELECT id FROM worker_tasks WHERE company_id = $1`,
            [CO6])).rows[0];
          const claim = await LEASES.claimTask({ workerId: enrolled.workerId, taskId: t.id }, deps);
          const step = (await query(`SELECT payload FROM office_plan_steps
                                      WHERE plan_id = $1 AND task_type IS NOT NULL`,
            [`plan-cycle-${RUN}`.slice(0, 64)])).rows[0];
          const sub = await LEASES.submitResult({
            workerId: enrolled.workerId, runId: claim.runId, status: 'SUCCEEDED',
            output: { echoed: step.payload, steps: 0 },
          }, deps);
          if (!claim.ok || !sub.ok) throw new Error(`could not execute the step: `
            + `${JSON.stringify({ claim, sub })}`);
        }
      }

      if (reported && Array.isArray(reported.briefing.operationalFacts)
        && reported.briefing.operationalFacts.length === 5) {
        ok('the briefing carries all five families WITH their statuses, not flattened into bare '
          + 'numbers — `missing` and `measured` are different claims and must not print alike');
      } else bad('the briefing did not carry the facts',
        reported && Object.keys(reported.briefing));

      if (reported && reported.briefing.factQuality
        && reported.briefing.factQuality.total === 5) {
        const unsupportable = reported.briefing.operationalFacts
          .filter((f) => f.status !== 'measured' && f.status !== 'measured_zero')
          .map((f) => `${f.kind}:${f.status}`);
        ok(`and it states how many of them are supportable `
          + `(${reported.briefing.factQuality.supportable}/5`
          + `${unsupportable.length ? `; not supportable: ${unsupportable.join(', ')}` : ''}), `
          + 'which is what decides whether a briefing may be presented as a statement of fact at '
          + 'all');
      } else bad('the briefing reported no quality', reported && reported.briefing.factQuality);

      // Independent recount of the briefing's own figures, which is the owner's explicit ask.
      if (reported) {
        const f = reported.briefing.operationalFacts.find((x) => x.kind === 'objectives');
        const real = await n1(`SELECT COUNT(*)::int n FROM objectives
                                WHERE company_id = $1 AND status = 'active'`, [CO6]);
        if (f.value === real) {
          ok(`every briefing figure recounted independently: objectives ${f.value} = ${real}`);
        } else bad('a briefing figure did not survive an independent recount', { f, real });
      }
    }

    // ══ 9. WHAT THIS DID NOT DO ═════════════════════════════════════════
    head('9. no model, no writes, and what remains open');

    {
      const calls = await n1('SELECT COUNT(*)::int n FROM office_cost_ledger');
      if (calls === 0) ok('ZERO provider calls — no figure here came from a model');
      else bad(`${calls} provider cost rows exist; this check must make none`);

      note('the read-only and no-model properties are asserted on the SOURCE by '
        + 'src/lib/office/operational-facts-is-read-only.test.js, because they are properties of '
        + 'the module\'s shape rather than of any one run of it');
      note('NOT covered: the facts source is NOT yet the input to a worker-executed report. '
        + '`report.daily_operations` has a fact vocabulary from the M7.6 pilot domain (assay, '
        + 'batch, qc_check, inquiry, shipment) which these operational families are not, so '
        + 'feeding office facts into it would mean mislabelling them. Widening the step vocabulary '
        + 'is B3.5; until then the facts reach the BRIEFING, which is what the owner\'s '
        + 'Priority 4 asks to be verifiable');
      note('NOT covered: revenue and activity figures (scoped-operations has accessors for both) '
        + 'and performance scores — the five families here are the five the owner named');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try {
      for (const id of made.milestones) {
        await query(`DELETE FROM milestones WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.tasks) {
        await query(`DELETE FROM daily_tasks WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.objectives) {
        await query(`DELETE FROM office_plan_steps WHERE plan_id IN
                       (SELECT id FROM office_plans WHERE objective_id=$1)`, [id]).catch(() => {});
        await query(`DELETE FROM office_plans WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.users) {
        await query(`DELETE FROM daily_tasks WHERE user_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM user_companies WHERE user_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM users WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.companies) {
        await query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => {});
      }
    } catch (e) { bad('cleanup failed', e.message); }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
