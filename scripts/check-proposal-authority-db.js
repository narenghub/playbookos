#!/usr/bin/env node
// ── A MODEL-GENERATED PROPOSAL CANNOT WIDEN ANYTHING ────────────────────────
//
//   node scripts/check-proposal-authority-db.js   exit 0 = none of the four can be widened
//                                                 exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's Priority 5, 2026-11-26: *"Verify model-generated proposals cannot expand permissions,
// company access, capabilities or financial authority."*
//
// ── WHY THIS NEEDS A DATABASE, WHICH IS ITSELF THE FIRST FINDING ───────────
//
// I wrote this as a pure unit test first, handing `propose()` a frozen `{companyId, objectiveId}`.
// `assertContext` refused it by name: *"A frozen object with a companyId is not a resolved context
// — and neither is a COPY of a real one."*
//
// That refusal IS the company-access answer, and it is stronger than anything this file could have
// asserted about field names: a proposal cannot name a company because **nothing** can name a
// company. The context must be resolved from stored state, so the question "whose data does this
// plan touch" is answered by the database before a proposal is read. So the check resolves real
// contexts for two real companies and works through the real path.
//
// ── THE FOUR NOUNS FAIL DIFFERENTLY ────────────────────────────────────────
//
//   permissions        — a step's consequential flag and its approval requirement
//   company access     — whose data the plan reads and whose budget it spends
//   capabilities       — what a dispatched task may ask a worker to DO (exec:gui, exec:hardware)
//   financial authority— the budget the plan may spend against, and the payload it signs
//
// The model is simulated by handing the parser exactly what a compromised or confused one would
// return, which is the only thing a model can do here. No provider is reached.
//
// NO URL OVERRIDE: its own disposable cluster; every fixture created by id and removed by id.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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
  cluster = DISPOSABLE.create({ label: 'propauth' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  proposal authority was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'prop-bootstrap@prop.invalid';
process.env.ADMIN_PASSWORD = `prop-${crypto.randomBytes(16).toString('hex')}`;

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
  const deps = { query, withTransaction };

  const made = { companies: [], objectives: [] };
  const uid = (p) => `prop-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const DB = require('../src/lib/db');
    await DB.initDB();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);

    const DEC = require('../src/lib/office/decomposition');
    const CTXMOD = require('../src/lib/office/context');
    const SRC = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'office', 'decomposition.js'), 'utf8');

    const newCompany = async (label) => {
      const id = uid(label);
      await query(`INSERT INTO companies (id, slug, display_name, status)
                   VALUES ($1,$1,$1,'active')`, [id]);
      made.companies.push(id);
      return id;
    };
    const newObjective = async (companyId, label) => {
      const id = uid(label);
      await query(`INSERT INTO objectives
                     (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                      created_by, budget_usd)
                   VALUES ($1,$2,$3,'P1','supervised','all_consequential','active',
                           'naren@fixture.invalid',5.00)`,
        [id, companyId, `proposal authority: ${label}`]);
      made.objectives.push(id);
      return id;
    };

    const CO_A = await newCompany('co-a');
    const OBJ_A = await newObjective(CO_A, 'a');
    const CO_B = await newCompany('co-b');
    const OBJ_B = await newObjective(CO_B, 'b');

    const CTX = await CTXMOD.resolveObjectiveContext({ objectiveId: OBJ_A }, deps);

    /** The one legal step, so every hostile variant differs by exactly the hostile part. */
    const LEGAL = () => ({ stepType: 'observe.objective_state', args: {} });
    const propose = (candidates) => {
      try { return DEC.propose(CTX, { candidates }); }
      catch (e) { return { ok: false, refused: 'threw', detail: e.message }; }
    };
    const codeOf = (r) => r.refused || r.code || null;

    // ══ 0. THE BASELINE ══════════════════════════════════════════════════
    head('0. the legal baseline is accepted, so a refusal below is the hostile part');

    {
      const r = propose([LEGAL()]);
      if (r.ok && r.plan && r.plan.steps && r.plan.steps.length === 1) {
        ok('one legal step produces a plan with one step');
      } else bad('the baseline proposal was refused', { code: codeOf(r), detail: r.detail });
    }

    // ══ 1. COMPANY ACCESS ════════════════════════════════════════════════
    head('1. company access: a proposal cannot name a company, because nothing can');

    {
      // THE STRONGEST FORM FIRST: a context cannot be fabricated at all. This is why a pure unit
      // test of this file is impossible, and it is a better answer than any field check.
      let threw = null;
      try {
        DEC.propose(Object.freeze({ companyId: CO_B, objectiveId: OBJ_B, runId: null }),
          { candidates: [LEGAL()] });
      } catch (e) { threw = e.message; }
      if (threw && /not produced by|resolved context/.test(threw)) {
        ok('a FABRICATED context is refused by assertContext — the company is read from stored '
          + 'state, so "whose data does this plan touch" is settled before a proposal is read');
      } else bad('a fabricated context was accepted', threw);

      // And a COPY of a real one, with the company swapped, which is the subtler attempt.
      let threw2 = null;
      try {
        DEC.propose({ ...CTX, companyId: CO_B }, { candidates: [LEGAL()] });
      } catch (e) { threw2 = e.message; }
      if (threw2 && /COPY of a real one|not produced by/.test(threw2)) {
        ok('and a COPY of a resolved context with the company swapped is refused too — spreading '
          + 'a context produces a new object, which is not the object that was resolved');
      } else bad('a copied-and-edited context was accepted', threw2);

      for (const field of ['companyId', 'company_id']) {
        const r = propose([{ ...LEGAL(), [field]: CO_B }]);
        if (!r.ok && codeOf(r) === 'proposal_asserted_authorization') {
          ok(`a step supplying ${field} is refused by name as an attempt to authorize itself`);
        } else bad(`a step supplying ${field} was accepted`, { code: codeOf(r) });
      }
    }

    // ══ 2. PERMISSIONS ═══════════════════════════════════════════════════
    head('2. permissions: a proposal cannot declare itself safe or approved');

    {
      const fields = ['consequential', 'requiresApproval', 'requires_approval', 'approved',
        'verdict', 'status', 'autonomyTier', 'autonomy_tier'];
      const refusedAll = [];
      for (const field of fields) {
        const r = propose([{ ...LEGAL(), [field]: false }]);
        refusedAll.push({ field, code: codeOf(r),
          named: !!(r.detail && new RegExp(field).test(r.detail)) });
      }
      const wrong = refusedAll.filter(
        (x) => x.code !== 'proposal_asserted_authorization' || !x.named);
      if (!wrong.length) {
        ok(`all ${fields.length} permission fields are refused as proposal_asserted_authorization, `
          + 'and each refusal NAMES the field — an operator has to be able to see what was '
          + 'attempted, not just that something was');
      } else bad('a permission field was not refused by name', wrong);

      // ── ORDER MATTERS ──────────────────────────────────────────────────
      // If the vocabulary were consulted first, a step that both invents a type AND asserts
      // authorization would be refused as `unknown_step_type` — true, and it would record the
      // lesser of the two offences in the audit trail.
      const r = propose([{ stepType: 'not.a.real.step', approved: true, args: {} }]);
      if (codeOf(r) === 'proposal_asserted_authorization') {
        ok('and a step that BOTH invents a type and asserts authorization is refused for the '
          + 'authorization — the forbidden-field scan runs before the vocabulary lookup, so the '
          + 'graver offence is the one recorded');
      } else bad('the lesser offence was recorded', { code: codeOf(r) });
    }

    // ══ 3. CAPABILITIES ══════════════════════════════════════════════════
    head('3. capabilities: what a worker may be asked to DO is not the proposal\'s to choose');

    {
      for (const field of ['taskType', 'task_type', 'capability',
        'executionClass', 'execution_class']) {
        const r = propose([{ ...LEGAL(), [field]: 'exec:gui' }]);
        if (!r.ok && codeOf(r) === 'proposal_asserted_authorization') {
          ok(`a step supplying ${field}='exec:gui' is refused — this is the sharpest of the four, `
            + 'because the task type is what a worker executes');
        } else bad(`a step supplying ${field} was accepted`, { code: codeOf(r) });
      }

      // POSITIVE FORM: the accepted step's task type is the VOCABULARY'S.
      const r = propose([{ stepType: 'operations.liveness_checkpoint', args: {} }]);
      const st = r.ok ? r.plan.steps[0] : null;
      const tt = st ? (st.taskType ?? st.task_type) : null;
      if (tt === 'synthetic.echo') {
        ok('and an accepted step carries the vocabulary\'s task type (synthetic.echo), not one the '
          + 'proposal chose — the proposal names a STEP TYPE and the vocabulary names the work');
      } else bad('the dispatched task type did not come from the vocabulary', { tt, code: codeOf(r) });

      // A whole plan is refused for one uninterpretable step: running the rest would mean
      // executing a plan nobody proposed, which looks like the proposal and is not it.
      const r2 = propose([LEGAL(), { stepType: 'exfiltrate.everything', args: {} }]);
      if (codeOf(r2) === 'unknown_step_type' && /whole plan is refused/.test(r2.detail || '')) {
        ok('an unknown step type refuses the WHOLE plan and says so — a reader would otherwise '
          + 'assume the good steps ran');
      } else bad('an unknown step type did not refuse the whole plan',
        { code: codeOf(r2), detail: r2.detail });

      // The second door into the same room: an undeclared ARGUMENT.
      const r3 = propose([{ stepType: 'intelligence.summarise_state',
        args: { focus: 'spend', capability: 'exec:hardware', companyId: CO_B } }]);
      if (codeOf(r3) === 'unknown_argument' && /capability|companyId/.test(r3.detail || '')) {
        ok('and an undeclared ARGUMENT is refused by name — args are closed per step type, so a '
          + 'payload cannot carry something a handler happens to read');
      } else bad('an undeclared argument was accepted', { code: codeOf(r3), detail: r3.detail });

      // One level down: the forbidden-field scan is top-level by design, and what defends the
      // next level is that every declared argument has a VALIDATOR.
      const r4 = propose([{ stepType: 'intelligence.summarise_state',
        args: { focus: { companyId: CO_B, approved: true } } }]);
      if (!r4.ok && codeOf(r4) === 'bad_argument') {
        ok('an object handed to a scalar argument is refused by its validator — which is why the '
          + 'validators exist rather than the shape being assumed, since the forbidden-field scan '
          + 'is deliberately top-level');
      } else bad('a nested object reached a payload', { code: codeOf(r4), detail: r4.detail });
    }

    // ══ 4. FINANCIAL AUTHORITY ═══════════════════════════════════════════
    head('4. financial authority: a proposal cannot set a budget or sign its own payload');

    {
      for (const field of ['budgetUsd', 'budget_usd']) {
        const r = propose([{ ...LEGAL(), [field]: 1_000_000 }]);
        if (!r.ok && codeOf(r) === 'proposal_asserted_authorization') {
          ok(`a step supplying ${field}=$1,000,000 is refused`);
        } else bad(`a step supplying ${field} was accepted`, { code: codeOf(r) });
      }

      for (const field of ['payload', 'payloadDigest', 'payload_digest', 'intentKey', 'intent_key']) {
        const r = propose([{ ...LEGAL(), [field]: 'anything' }]);
        if (!r.ok && codeOf(r) === 'proposal_asserted_authorization') {
          ok(`a step supplying ${field} is refused — the payload is what a worker acts on and the `
            + 'digest is what proves it was not changed, so setting either would be signing its '
            + 'own work');
        } else bad(`a step supplying ${field} was accepted`, { code: codeOf(r) });
      }

      const r = propose([{ stepType: 'intelligence.summarise_state', args: { focus: 'spend' } }]);
      const p = r.ok ? r.plan.steps[0].payload : null;
      if (p && Object.keys(p).length === 1 && p.focus === 'spend') {
        ok('and the payload is computed by the vocabulary from the validated arguments — exactly '
          + 'the keys payloadFor put there, and nothing else');
      } else bad('the payload has a key the vocabulary did not produce', p);
    }

    // ══ 5. THE SHAPE OF THE SURFACE, AND THE CONTROLS ════════════════════
    head('5. the surface is bounded, and the lists that do the work are not empty');

    {
      const empty = propose([]);
      const many = propose(Array.from({ length: 500 }, LEGAL));
      if (codeOf(empty) === 'empty_proposal' && codeOf(many) === 'too_many_steps') {
        ok('an empty proposal is not a plan, and an unbounded one is refused — a plan that does '
          + 'nothing and a plan of five hundred steps are both things a confused model produces');
      } else bad('the size bounds do not hold',
        { empty: codeOf(empty), many: codeOf(many) });

      const junkRefused = [null, 'a string', 42, [], {}].map(
        (j) => ({ j: JSON.stringify(j) ?? 'undefined', ok: propose([j]).ok }));
      if (junkRefused.every((x) => x.ok !== true)) {
        ok('malformed steps are refused rather than coerced into something executable');
      } else bad('malformed input was accepted', junkRefused);

      // ── CONTROL: the lists that do the work are frozen and non-empty ───
      //
      // Without this, every assertion above could pass against an implementation whose forbidden
      // list had been emptied — each hostile step would then be refused for some other reason, or
      // not at all, and the codes would quietly change.
      const m = SRC.match(/const FORBIDDEN_PROPOSAL_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/);
      const fields = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
      const nouns = [['permissions', 'approved'], ['company access', 'companyId'],
        ['capabilities', 'taskType'], ['financial authority', 'budgetUsd']];
      const missing = nouns.filter(([, f]) => !fields.includes(f));
      if (fields.length >= 15 && !missing.length) {
        ok(`the forbidden-field list holds ${fields.length} names and still covers all four nouns `
          + '(approved · companyId · taskType · budgetUsd), so it cannot lose a whole category '
          + 'without this failing');
      } else bad('the forbidden-field list has lost coverage',
        { n: fields.length, missing: missing.map((x) => x[0]) });

      if (/const STEP_VOCABULARY = Object\.freeze\(\{/.test(SRC)
        && /const FORBIDDEN_PROPOSAL_FIELDS = Object\.freeze\(\[/.test(SRC)) {
        ok('and both are Object.freeze — a closed vocabulary that can be extended at runtime is '
          + 'not closed, and a forbidden list that can be emptied is not a list');
      } else bad('the vocabulary or the forbidden list is not frozen');
    }

    // ══ 6. WHAT THIS DOES NOT ESTABLISH ══════════════════════════════════
    head('6. the boundary of this check');

    note('NOT established: that a model cannot influence WHICH objective is planned. Initiation '
      + 'chooses that from stored schedule state and a model never sees the choice.');
    note('NOT established: that a model cannot cause spend by VOLUME. It cannot raise a cap, but a '
      + 'plan of entirely permitted steps still costs money — that is what the pre-call hold and '
      + 'B3.14\'s aggregate caps bound, not this.');
    note('NOT established: anything about a model-generated proposal reaching a DIFFERENT surface, '
      + 'such as approval text, a briefing or an email body. This covers PLAN proposals only.');
    note('NOT established: that the model cannot be prompted into producing a legal plan that is '
      + 'simply wrong. Independent validation (B3.18) is what judges the RESULT; this judges what '
      + 'the plan is allowed to ASK FOR.');
    note('every fixture here was created by id and is removed by id below.');
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try {
      for (const id of made.objectives) {
        await query(`DELETE FROM office_plan_steps WHERE plan_id IN
                       (SELECT id FROM office_plans WHERE objective_id = $1)`, [id]).catch(() => {});
        await query(`DELETE FROM office_plans WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
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
