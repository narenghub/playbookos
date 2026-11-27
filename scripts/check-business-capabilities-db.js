#!/usr/bin/env node
// ── B3.5: THE FOUR READ-ONLY CAPABILITIES, RETRIEVED AND EXECUTED FOR REAL ───
//
//   node scripts/check-business-capabilities-db.js    exit 0 = all four traverse
//                                                     exit 3 = NOT EXECUTED (no Postgres)
//
// Owner's requirement 3, 2026-11-26: *"Complete B3.5 with practical read-only business capabilities
// and independent validation criteria. Synthetic echo alone is insufficient for a useful autonomous
// office. Prioritize operational reporting, employee task status, procurement analysis and governed
// business-data retrieval. Reuse existing modules."*
//
// ── WHAT THIS CHECK ADDS OVER THE UNIT TESTS ───────────────────────────────
//
// `src/lib/office/business-capabilities.test.js` establishes that each criterion refuses output
// that lies — an absence reported as a number, an invented employee, a dropped supplier, an altered
// row. It does that on hand-written payloads, which is the right way to test a criterion and says
// nothing about whether a capability can be driven end to end.
//
// So this check, for each of the four:
//
//   1. RETRIEVES from a real database, through the real retriever, on a context resolved from a
//      real objective — the only road by which any of these gets data.
//   2. EXECUTES through `src/worker-client/executor.js` — the real executor, the real handler
//      lookup, the real output bound and the real validateOutput. Not by calling the handler.
//   3. VALIDATES through `office/cycle.js`'s `independentCriterion`, which is what the VALIDATE
//      phase actually calls, rather than through the registry directly.
//
// And three properties that only a database can show:
//
//   · **the retrievers are company-scoped.** Two companies are created with different data and the
//     same retriever is run against each; neither may see the other's rows.
//   · **the retrievers write nothing.** Every table they touch is counted before and after.
//   · **a fabricated context is refused.** `assertContext` must refuse a hand-built object, or a
//     caller that can build a context can choose whose business it reads.

'use strict';

const crypto = require('crypto');
const DISPOSABLE = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => {
  fail += 1; console.log(`  FAIL  ${m}`);
  if (d !== undefined) console.log(`          ${typeof d === 'string' ? d : JSON.stringify(d)}`);
};
const note = (m) => console.log(`  --    ${m}`);
const head = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'bizcap' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the read-only capabilities were NOT exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'bizcap-bootstrap@bizcap.invalid';
process.env.ADMIN_PASSWORD = `bizcap-${crypto.randomBytes(16).toString('hex')}`;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 300s — a stall is a failure, not a slow pass.');
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
  const deps = { query, withTransaction };

  const made = { companies: [], objectives: [], users: [], rfqs: [], suppliers: [] };
  const uid = (p) => `bc-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const DB = require('../src/lib/db');
    await DB.initDB();
    // initPhase2 BEFORE migrateSchemas, and migrateRecordOwnership after the identity schema. This
    // ordering is recorded in check-membership-proposal-db.js and in db.js's own comment about four
    // ALTERs that sat 45 lines above the CREATE TABLE they depended on: `daily_tasks` is created by
    // the phase-2 block, and migrateRecordOwnership ALTERs it to carry `company_id` — which is the
    // column B7.21's task scoping reads, so without it `tasksFor` would be scoping on a column that
    // does not exist. My first version omitted both and failed on `relation "daily_tasks" does not
    // exist` after assignTask had already succeeded against a different table.
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/identity/schema').migrateRecordOwnership(query);

    const BC = require('../src/lib/office/business-capabilities');
    const CYCLE = require('../src/lib/office/cycle');
    const EXEC = require('../src/worker-client/executor');
    const CTXMOD = require('../src/lib/office/context');
    const OPS = require('../src/lib/identity/scoped-operations');

    const TODAY = new Date().toISOString().slice(0, 10);

    // ── TWO COMPANIES, DIFFERENT DATA ──────────────────────────────────────
    const mkCompany = async (label) => {
      const id = uid(label);
      await query(`INSERT INTO companies (id, slug, display_name, status)
                   VALUES ($1,$1,$1,'active')`, [id]);
      made.companies.push(id);
      return id;
    };
    const mkObjective = async (companyId, label) => {
      const id = uid(label);
      await query(`INSERT INTO objectives
                     (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                      created_by, budget_usd)
                   VALUES ($1,$2,$3,'P1','supervised','all_consequential','active',
                           'naren@fixture.invalid',25.00)`,
        [id, companyId, `B3.5 capabilities: ${label}`]);
      made.objectives.push(id);
      return id;
    };
    const mkEmployee = async (companyId, label, role) => {
      const id = uid(label);
      await query(`INSERT INTO users (id,email,name,role,is_active)
                   VALUES ($1,$2,$3,$4,1)`, [id, `${id}@fixture.invalid`, label, role]);
      made.users.push(id);
      // ── THROUGH THE REAL ACCESSOR, NOT A RAW INSERT ───────────────────
      //
      // My first version INSERTed into `user_companies` directly, and
      // `check-identity-accessor-discipline.js` was right to refuse it: *"the live predicate is
      // several conditions long and a second copy of it will drift from this one."* `employeesOf`
      // delegates to `company-membership.js`, so a hand-written fixture row satisfying my idea of
      // that predicate would prove nothing about the one the product applies.
      //
      // `grantMembership` also means this check traverses `assertActorMayManage` and the
      // external-role refusal on the way in, which a raw INSERT skips — so the fixture is built by
      // the same road the product uses. It needs an actor who may manage the company, hence the
      // super-admin authorizer below.
      await MEMBERSHIP.grantMembership({
        userId: id, companyId, companyRole: 'member', grantedBy: AUTHORIZER,
        grantedReason: 'B3.5 read-only capability fixture',
      }, deps);
      return id;
    };

    // One super-admin authorizer for every grantMembership below. `assertActorMayManage` refuses an
    // actor who may not manage the company, which is the point of going through the accessor.
    const MEMBERSHIP = require('../src/lib/identity/company-membership');
    const AUTHORIZER = uid('authorizer');
    await query(`INSERT INTO users (id,email,name,role,is_active)
                 VALUES ($1,$2,'B3.5 Authorizer','super_admin',1)`,
      [AUTHORIZER, `${AUTHORIZER}@fixture.invalid`]);
    made.users.push(AUTHORIZER);

    const CO_A = await mkCompany('co-a');
    const CO_B = await mkCompany('co-b');
    const OBJ_A = await mkObjective(CO_A, 'a');
    const OBJ_B = await mkObjective(CO_B, 'b');

    const ctxA = await CTXMOD.resolveObjectiveContext({ objectiveId: OBJ_A }, deps);
    const ctxB = await CTXMOD.resolveObjectiveContext({ objectiveId: OBJ_B }, deps);

    // Employees and tasks: A gets three employees and four tasks, B gets one and none.
    const a1 = await mkEmployee(CO_A, 'alice', 'sales_team');
    const a2 = await mkEmployee(CO_A, 'bob', 'dev_team');
    const a3 = await mkEmployee(CO_A, 'carol', 'support_team');
    const b1 = await mkEmployee(CO_B, 'dave', 'sales_team');

    // Through the REAL assignTask, so the rows are the rows the product makes.
    const mkTask = async (ctx, userId, title, done) => {
      const id = uid('task');
      const r = await OPS.assignTask(ctx, {
        id, userId, title, taskDate: TODAY, priority: 'MEDIUM',
      }, deps);
      if (done) await OPS.completeTask(ctx, { id }, deps);
      return r;
    };
    await mkTask(ctxA, a1, 'alice task 1', true);
    await mkTask(ctxA, a1, 'alice task 2', false);
    await mkTask(ctxA, a2, 'bob task 1', false);

    // ══ 0. A FABRICATED CONTEXT IS REFUSED ════════════════════════════════
    head('0. a hand-built context cannot read anybody\'s business');

    {
      // The guard this whole file depends on. A caller that can construct a context can choose
      // whose data it retrieves, so the refusal is asserted before anything else is measured.
      const fake = Object.freeze({ companyId: CO_A, objectiveId: OBJ_A, resolved: true });
      let refused = 0;
      for (const key of BC.KEYS) {
        const cap = BC.CAPABILITIES[key];
        try {
          await cap.retrieve(fake, { asOf: TODAY, date: TODAY, dataset: 'milestones',
            rfqId: 'nope' }, deps);
        } catch (_) { refused += 1; }
      }
      if (refused === BC.KEYS.length) {
        ok(`all ${BC.KEYS.length} retrievers refuse a hand-built context — "a frozen object with a `
          + 'companyId is not a resolved context", and without that these four would each be a '
          + 'road to any company\'s data');
      } else {
        bad(`${BC.KEYS.length - refused} retriever(s) accepted a fabricated context`);
      }
    }

    // ══ 1. EACH CAPABILITY: RETRIEVE → EXECUTE → VALIDATE ═════════════════
    head('1. retrieve from the database, execute through the executor, validate through the plan');

    // An RFQ with suppliers, for analysis.procurement.
    const RFQ = uid('rfq');
    await query(`INSERT INTO rfq_requests
                   (id, molecule_name, cas_number, target_quantity, target_purity, gmp_required,
                    week_start, status, priority)
                 VALUES ($1,$2,'000000-00-2','5 kg','99.0%',1,$3,'pending','high')`,
      [RFQ, `Capabilitol-${RFQ.slice(-6)}`, TODAY]);
    made.rfqs.push(RFQ);
    for (const [label, gmp] of [['sup-one', 1], ['sup-two', 0]]) {
      const sid = uid(label);
      // No `status` column on `suppliers` — read off db.js rather than assumed.
      await query(`INSERT INTO suppliers (id, name, country, contact_email, gmp_certified)
                   VALUES ($1,$2,'IN',$3,$4)`,
        [sid, label, `${sid}@fixture.invalid`, gmp]);
      made.suppliers.push(sid);
      await query(`INSERT INTO rfq_responses
                     (id, rfq_id, supplier_id, supplier_name, price_per_kg, currency,
                      lead_time_days, available_quantity, purity_offered, gmp_status,
                      coa_available, response_email, raw_response)
                   VALUES ($1,$2,$3,$4,1000,'USD',30,'5 kg','99.0%','certified',$5,$6,
                           'FIXTURE — no supplier was contacted')`,
        [uid('resp'), RFQ, sid, label, gmp, `${sid}@fixture.invalid`]);
    }

    const ARGS = {
      'report.operational_status': { asOf: TODAY },
      'report.employee_task_status': { date: TODAY },
      'analysis.procurement': { rfqId: RFQ },
      'retrieve.business_data': { dataset: 'milestones', limit: 50 },
    };

    const traversed = [];
    for (const key of BC.KEYS) {
      const cap = BC.CAPABILITIES[key];

      // 1. RETRIEVE — the real retriever, the resolved context, the real database.
      let payload = null;
      try {
        payload = await cap.retrieve(ctxA, ARGS[key], deps);
      } catch (e) {
        bad(`${key}: retrieval threw`, e.message);
        continue;
      }
      if (!payload || payload.capability !== key) {
        bad(`${key}: the retriever produced no payload naming its capability`, payload);
        continue;
      }

      // 2. EXECUTE — through the REAL executor, not by calling the handler. This is what exercises
      //    the handler lookup, the task-type registry, the output bound and validateOutput.
      let r = null;
      try {
        r = await EXEC.execute({ taskType: key, payload, leaseExpiresInMinutes: 5 });
      } catch (e) {
        bad(`${key}: the executor threw`, e.message);
        continue;
      }
      if (r.verdict !== EXEC.VERDICT.SUCCEEDED) {
        bad(`${key}: the executor did not succeed`, { verdict: r.verdict, code: r.code,
          error: r.error, reason: r.reason });
        continue;
      }

      // 3. VALIDATE — through cycle.js's own entry point, which is what VALIDATE calls.
      const v = CYCLE.independentCriterion({ step_id: 's1', task_type: key, payload }, r.output);
      if (v.validated === true) {
        ok(`${key}: retrieved from the database, executed through the executor, and INDEPENDENTLY `
          + `validated — ${v.criterion}`);
        traversed.push(key);
      } else {
        bad(`${key}: the plan could not validate its own capability's output`,
          { criterion: v.criterion, reason: v.reason });
      }
    }

    if (traversed.length === BC.KEYS.length) {
      ok(`all ${BC.KEYS.length} read-only capabilities traverse retrieve → execute → validate. `
        + 'Synthetic echo is no longer the only thing this office can do');
    } else {
      bad(`${BC.KEYS.length - traversed.length} capability/capabilities did not traverse`,
        BC.KEYS.filter((k) => !traversed.includes(k)));
    }

    // ══ 2. THE CRITERIA ARE NOT VACUOUS ON REAL DATA ══════════════════════
    //
    // The control. Every criterion above validated real output, and a criterion that validates
    // everything would look exactly the same. So each one is handed the output of a DIFFERENT
    // capability and must refuse it — on this run's actual payloads, not on fixtures.
    head('2. control — each criterion refuses output from a different capability');

    {
      const outputs = {};
      for (const key of BC.KEYS) {
        const payload = await BC.CAPABILITIES[key].retrieve(ctxA, ARGS[key], deps);
        const r = await EXEC.execute({ taskType: key, payload, leaseExpiresInMinutes: 5 });
        outputs[key] = { payload, output: r.output };
      }
      let crossed = 0; let accepted = [];
      for (const mine of BC.KEYS) {
        for (const theirs of BC.KEYS) {
          if (mine === theirs) continue;
          const v = CYCLE.independentCriterion(
            { step_id: 's1', task_type: mine, payload: outputs[mine].payload },
            outputs[theirs].output);
          crossed += 1;
          if (v.validated === true) accepted.push(`${mine} accepted ${theirs}'s output`);
        }
      }
      if (!accepted.length) {
        ok(`${crossed} cross-pairings, every one REFUSED — so the validations in section 1 are `
          + 'about the output rather than about the criteria being satisfiable by anything');
      } else bad('a criterion validated another capability\'s output', accepted);
    }

    // ══ 2b. THE DATASET ALLOWLIST REFUSES BY NAME, WITH A REAL CONTEXT ════
    //
    // The allowlist IS the governance for `retrieve.business_data`, and it can only be exercised
    // where a resolved context exists — the retriever asserts the context first, so the unit tests
    // never reach this branch. Both halves matter: a name off the list is refused, and a name on it
    // cannot widen its own projection.
    head('2b. the dataset allowlist — a name off the list cannot be retrieved');

    {
      const cap = BC.CAPABILITIES['retrieve.business_data'];
      const forbidden = ['users', 'companies', 'office_budget_reservations', 'user_companies',
        'agent_runs', '../etc/passwd', 'milestones; DROP TABLE users'];
      const accepted = [];
      for (const dataset of forbidden) {
        try {
          await cap.retrieve(ctxA, { dataset }, deps);
          accepted.push(dataset);
        } catch (e) {
          if (!/not an allowlisted dataset/.test(e.message)) accepted.push(`${dataset} (${e.message})`);
        }
      }
      if (!accepted.length) {
        ok(`all ${forbidden.length} non-allowlisted dataset names refused, including the tables a `
          + 'caller would most want — users, companies, the budget reservations — and two '
          + 'injection-shaped names. The allowlist is a closed object, so this is refusal by '
          + 'absence rather than by pattern');
      } else bad('a non-allowlisted dataset was retrieved', accepted);

      // And every allowlisted one works and projects to its declared fields only.
      const leaked = [];
      for (const [dataset, spec] of Object.entries(BC.DATASETS)) {
        const out = await cap.retrieve(ctxA, { dataset }, deps);
        if (JSON.stringify(out.fields) !== JSON.stringify(spec.fields)) {
          leaked.push(`${dataset}: fields ${JSON.stringify(out.fields)}`);
        }
        for (const row of out.rows) {
          for (const k of Object.keys(row)) {
            if (!spec.fields.includes(k)) leaked.push(`${dataset}: row carries ${k}`);
          }
        }
      }
      if (!leaked.length) {
        ok(`and all ${Object.keys(BC.DATASETS).length} allowlisted datasets retrieve, each `
          + 'projected to exactly its declared fields — so there is no projection for a handler to '
          + 'exceed, rather than a check that it did not');
      } else bad('an allowlisted dataset returned fields outside its projection', leaked);
    }

    // ══ 3. THE RETRIEVERS ARE COMPANY-SCOPED ══════════════════════════════
    head('3. the same retriever, two companies — neither sees the other\'s rows');

    {
      const empA = await BC.CAPABILITIES['report.employee_task_status']
        .retrieve(ctxA, { date: TODAY }, deps);
      const empB = await BC.CAPABILITIES['report.employee_task_status']
        .retrieve(ctxB, { date: TODAY }, deps);

      const idsA = new Set(empA.employees.map((e) => e.id));
      const idsB = new Set(empB.employees.map((e) => e.id));

      if (idsA.has(a1) && idsA.has(a2) && idsA.has(a3) && !idsA.has(b1)) {
        ok(`company A's retrieval returns its own ${idsA.size} employees and NOT company B's`);
      } else bad('company A\'s employee retrieval is not scoped', [...idsA]);

      if (idsB.has(b1) && ![a1, a2, a3].some((x) => idsB.has(x))) {
        ok('and company B\'s returns only its own — the scoping is the resolved context\'s, not a '
          + 'filter the caller passed, so there is no argument through which it could be widened');
      } else bad('company B\'s employee retrieval is not scoped', [...idsB]);

      // The tasks too, not just the people: a scoped employee list with unscoped tasks would still
      // leak, and would still pass a check that only looked at the employees.
      const taskOwnersB = new Set(empB.tasks.map((t) => t.user_id));
      if (![a1, a2, a3].some((x) => taskOwnersB.has(x))) {
        ok('and no task belonging to company A appears in company B\'s payload');
      } else bad('company B\'s payload carries company A\'s tasks', [...taskOwnersB]);
    }

    // ══ 4. THEY WRITE NOTHING ═════════════════════════════════════════════
    head('4. read-only, measured — every retriever run again against counted tables');

    {
      const TABLES = ['daily_tasks', 'milestones', 'objectives', 'users', 'companies',
        'rfq_requests', 'rfq_responses', 'suppliers', 'office_plans', 'worker_tasks',
        'agent_runs', 'office_budget_reservations', 'activity_logs', 'performance_scores'];
      const countAll = async () => {
        const out = {};
        for (const t of TABLES) {
          try {
            out[t] = (await query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
          } catch (_) { out[t] = null; }        // a table this schema does not have
        }
        return out;
      };

      const before = await countAll();
      for (const key of BC.KEYS) {
        await BC.CAPABILITIES[key].retrieve(ctxA, ARGS[key], deps);
        await BC.CAPABILITIES[key].retrieve(ctxB, { ...ARGS[key], rfqId: RFQ }, deps);
      }
      const after = await countAll();

      const changed = TABLES.filter((t) => before[t] !== after[t])
        .map((t) => `${t}: ${before[t]} → ${after[t]}`);
      if (!changed.length) {
        ok(`${BC.KEYS.length * 2} retrievals changed no row count in any of ${TABLES.length} `
          + 'tables. These capabilities are declared readOnly in the task registry, and this is '
          + 'the measurement rather than the declaration');
      } else bad('a read-only retriever changed the database', changed);
    }

    // ══ 5. THE REGISTRY AGREES WITH THE EXECUTOR AND THE TASK TYPES ═══════
    head('5. the three registries name the same four capabilities');

    {
      const TYPES = require('../src/lib/worker/task-types');
      const avail = EXEC.capabilities ? EXEC.capabilities() : null;
      const implemented = new Set((avail && avail.implemented) || Object.keys(EXEC.HANDLERS));
      const problems = [];
      for (const key of BC.KEYS) {
        if (!TYPES.isKnown(key)) problems.push(`${key} is not in the task-type registry`);
        if (!implemented.has(key)) problems.push(`${key} has no handler in the executor`);
        const def = TYPES.TASK_TYPES[key];
        if (def && def.readOnly !== true) problems.push(`${key} is not declared readOnly`);
        if (def && def.reexecutable !== true) {
          problems.push(`${key} is not declared reexecutable — a report run twice is the same `
            + 'report, and declaring otherwise blocks recovery after a dead worker for no reason');
        }
      }
      if (!problems.length) {
        ok('all four appear in the task-type registry as readOnly and reexecutable, have a handler '
          + 'in the executor, and have a criterion in the capability registry — three lists that '
          + 'can disagree, asserted to agree');
      } else bad('the registries disagree', problems);
    }

    head('6. the boundary of this check');
    note('NOT established: that these reports are USEFUL. They are correct — every figure is one '
      + 'the database holds and no figure is invented — and whether an operator finds them worth '
      + 'reading is a question for an operator.');
    note('NOT established: anything about writing. All four are read-only by declaration and by '
      + 'the measurement in section 4. An autonomous office that can ACT on a company is a '
      + 'different and much larger authorization.');
    note('NOT established: that a worker in an office can run these. They are CLOUD_ELIGIBLE pure '
      + 'functions, exercised here in this process through the real executor; the hardware path is '
      + 'M7.5/M7.6.');
    note('every fixture here was created by id and is removed by id below.');
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try {
      for (const id of made.rfqs) {
        await query(`DELETE FROM rfq_responses WHERE rfq_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM rfq_requests WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.suppliers) {
        await query(`DELETE FROM suppliers WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.objectives) {
        await query(`DELETE FROM worker_tasks WHERE company_id = ANY($1)`, [made.companies])
          .catch(() => {});
        await query(`DELETE FROM office_plans WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM agent_runs WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.users) {
        await query(`DELETE FROM daily_tasks WHERE user_id=$1`, [id]).catch(() => {});
        // Fixture cleanup by id. `revokeMembership` is deliberately NOT a delete — it preserves
        // history, which is right for production and wrong for a disposable fixture that must
        // leave the cluster as it found it.
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
