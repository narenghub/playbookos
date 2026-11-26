#!/usr/bin/env node
// ── §6: A RUN STARTS BECAUSE A SCHEDULE FIRED ───────────────────────────────
//
//   node scripts/check-office-initiator-db.js   exit 0 = every ruled property holds
//                                               exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's §6 of 2026-11-25: *"Implement the missing scheduled objective initiator… Verify eligible
// objective discovery without a human starting each run, supervised autonomy-tier enforcement,
// durable scheduling and duplicate-initiation prevention."*
//
// B3.10 proved the cycle executes when a checker drives it. The gap this closes is that the checker
// WAS the scheduler. Here nothing names an objective: the initiator is handed a company and finds
// the work itself, and section 2 is the one that matters — four objectives in the database, exactly
// one of them startable, and the initiator has to be the thing that knows which.
//
// Every refusal is paired with a positive control, because an initiator that started nothing would
// satisfy each negative case on its own and would be indistinguishable from a broken scheduler.
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
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'init' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the initiator was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'init-bootstrap@init.invalid';
process.env.ADMIN_PASSWORD = `init-${crypto.randomBytes(16).toString('hex')}`;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 240s — a stall is a failure.');
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, 240_000);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };
  const ids = { companies: [], objectives: [] };
  const uid = (p) => `init-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    console.log('  ..    schema up\n');

    const INIT = require('../src/lib/office/initiator');
    const SCOPE = require('../src/lib/office/scope');

    const A = uid('co-a');
    await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [A]);
    ids.companies.push(A);

    const mkObjective = async ({ label, status = 'active', tier = 'supervised',
      budgetUsd = 1.00 }) => {
      const id = uid(label);
      await q(`INSERT INTO objectives
                 (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                  created_by, budget_usd)
               VALUES ($1,$2,$3,'P1',$4,'all_consequential',$5,'naren@fixture.invalid',$6)`,
        [id, A, `fixture ${label}`, tier, status, budgetUsd]);
      ids.objectives.push(id);
      return id;
    };

    // ══ 1. THE POSITIVE CONTROL ══════════════════════════════════════════
    //
    // If this fails, every refusal below is vacuous: an initiator that starts nothing satisfies
    // all of them while being completely broken.
    console.log('── 1. a run starts with nobody naming the objective (the control) ──\n');

    const startable = await mkObjective({ label: 'startable' });
    {
      const r = await INIT.initiateDueObjectives({ companyId: A }, deps);
      if (r.initiated.length === 1 && r.initiated[0].objectiveId === startable) {
        ok('the initiator DISCOVERED the eligible objective and opened a run for it');
      } else {
        bad('nothing was initiated — every negative case below is vacuous',
          JSON.stringify({ initiated: r.initiated, skipped: r.skipped, refused: r.refused }));
      }
      const row = (await q(
        `SELECT run_id, trigger, workflow, company_id, objective_id, intent_key
           FROM agent_runs WHERE objective_id = $1`, [startable])).rows[0];
      if (row && row.trigger === 'schedule') {
        ok('the run is DURABLE and records that a SCHEDULE started it, not a person');
      } else bad('no durable run row, or it does not say a schedule started it', row);
      if (row && row.company_id === A) {
        ok('and its company came from the objective, which is the only place it can come from');
      } else bad('the run was not welded to the objective\'s company', row);
      if (row && /bd=\d{4}-\d{2}-\d{2}/.test(row.intent_key || '')) {
        ok('the intent key carries an explicit BUSINESS day, not the UTC default (B7.23)');
      } else bad('the intent key has no business-day slot', row && row.intent_key);
    }

    // ══ 2. DISCOVERY IS A DECISION, AND IT IS THE INITIATOR'S ════════════
    console.log('\n── 2. four objectives, one startable — the initiator knows which ──\n');

    const draft = await mkObjective({ label: 'draft', status: 'draft' });
    const paused = await mkObjective({ label: 'paused', status: 'paused' });
    const noneTier = await mkObjective({ label: 'tier-none', tier: 'none' });
    const boundedTier = await mkObjective({ label: 'tier-bounded', tier: 'bounded' });
    const unfunded = await mkObjective({ label: 'unfunded', budgetUsd: null });
    {
      const e = await INIT.eligibleObjectives({ companyId: A }, deps);
      const reasonFor = (id) => (e.skipped.find((s) => s.objectiveId === id) || {}).reason;

      if (reasonFor(draft) === INIT.SKIP.NOT_ACTIVE) {
        ok('a DRAFT objective is skipped — activation is the CEO\'s act, not the scheduler\'s');
      } else bad('a draft objective was not skipped for the right reason', reasonFor(draft));

      if (reasonFor(paused) === INIT.SKIP.NOT_ACTIVE) {
        ok('a PAUSED objective is skipped');
      } else bad('a paused objective was not skipped', reasonFor(paused));

      if (reasonFor(noneTier) === INIT.SKIP.TIER) {
        ok('tier `none` is skipped — it means a human does the work');
      } else bad('tier none was not skipped for the tier reason', reasonFor(noneTier));

      if (reasonFor(boundedTier) === INIT.SKIP.TIER) {
        ok('tier `bounded` is skipped — B3.3 refuses it for delegation, so a bounded run would '
          + 'open and then fail at its first delegation');
      } else bad('tier bounded was not skipped', reasonFor(boundedTier));

      if (reasonFor(unfunded) === INIT.SKIP.NO_BUDGET) {
        ok('an objective with NO finite budget is skipped, not funded (B2.5a)');
      } else bad('an unfunded objective was not skipped for the budget reason', reasonFor(unfunded));

      if (e.eligible.length === 1 && e.eligible[0].objectiveId === startable) {
        ok(`exactly ONE of ${e.considered} objectives is eligible, and it is the right one`);
      } else {
        bad('the eligible set is wrong', JSON.stringify(e.eligible.map((x) => x.objectiveId)));
      }
    }

    // ══ 3. A BUDGET EXCEPTION IS A FINITE BUDGET ═════════════════════════
    console.log('\n── 3. a named exception counts, and only while it is live ──\n');

    {
      const exObj = await mkObjective({ label: 'via-exception', budgetUsd: null });
      const exId = uid('ex');
      // The REAL columns: granted_by, and revocation is revoked_at/revoked_by rather than a
      // status enum. Guessed wrong twice in this batch, and the fix both times was to read the
      // table rather than to assume it mirrors its neighbours.
      await q(`INSERT INTO office_budget_exceptions
                 (id, company_id, objective_id, granted_by, reason,
                  effective_from, effective_to)
               VALUES ($1,$2,$3,'naren@fixture.invalid','fixture exception',
                       NOW() - INTERVAL '1 minute', NOW() + INTERVAL '1 hour')`,
      [exId, A, exObj]);

      let e = await INIT.eligibleObjectives({ companyId: A }, deps);
      if (e.eligible.some((x) => x.objectiveId === exObj && x.viaException)) {
        ok('an objective funded by a live named exception IS eligible, and says so');
      } else bad('a live budget exception did not make an objective eligible');

      await q(`UPDATE office_budget_exceptions
                  SET revoked_at = NOW(), revoked_by = 'naren@fixture.invalid',
                      revoked_reason = 'fixture revocation'
                WHERE id = $1`, [exId]);
      e = await INIT.eligibleObjectives({ companyId: A }, deps);
      if (!e.eligible.some((x) => x.objectiveId === exObj)) {
        ok('and a REVOKED exception stops making it eligible');
      } else bad('a revoked exception still funded an objective');

      await q(`UPDATE office_budget_exceptions
                  SET revoked_at = NULL, revoked_by = NULL, revoked_reason = NULL,
                      effective_from = NOW() - INTERVAL '2 hours',
                      effective_to = NOW() - INTERVAL '1 minute'
                WHERE id = $1`, [exId]);
      e = await INIT.eligibleObjectives({ companyId: A }, deps);
      if (!e.eligible.some((x) => x.objectiveId === exObj)) {
        ok('an EXPIRED exception does not either — the window is evaluated by the database');
      } else bad('an expired exception still funded an objective');
      await q(`DELETE FROM office_budget_exceptions WHERE id = $1`, [exId]);
      await q(`DELETE FROM objectives WHERE id = $1`, [exObj]);
      ids.objectives = ids.objectives.filter((x) => x !== exObj);
    }

    // ══ 4. DUPLICATE INITIATION ══════════════════════════════════════════
    console.log('\n── 4. the schedule may fire twice; the run may not ──\n');

    {
      const again = await INIT.initiateDueObjectives({ companyId: A }, deps);
      if (again.initiated.length === 0 && again.duplicates.length === 1) {
        ok('a second firing initiates NOTHING and reports the duplicate rather than swallowing it');
      } else {
        bad('a second firing was not idempotent, or hid the duplicate',
          JSON.stringify({ initiated: again.initiated.length, duplicates: again.duplicates.length }));
      }
      const n = (await q(`SELECT COUNT(*)::int n FROM agent_runs WHERE objective_id = $1`,
        [startable])).rows[0].n;
      if (n === 1) ok('and the database still holds exactly ONE run for that objective');
      else bad(`${n} runs exist for one objective and one business day`);
    }
    {
      // TEN SIMULTANEOUS firings. The arbiter is `uq_agent_runs_one_active`, a partial unique
      // index — not a check in the initiator — so this is the case a "have I run today?" guard
      // would get wrong: all ten read "no run yet" before any of them writes.
      const conc = await mkObjective({ label: 'concurrent' });
      const results = await Promise.all(Array.from({ length: 10 }, () => INIT
        .initiateDueObjectives({ companyId: A }, deps)));
      const started = results.reduce((n, r) => n
        + r.initiated.filter((x) => x.objectiveId === conc).length, 0);
      const rows = (await q(`SELECT COUNT(*)::int n FROM agent_runs WHERE objective_id = $1`,
        [conc])).rows[0].n;
      if (started === 1 && rows === 1) {
        ok('TEN simultaneous firings produce exactly one run — the index arbitrates, not the code');
      } else {
        bad(`${started} initiations and ${rows} run rows from ten concurrent firings`);
      }
    }

    // ══ 4b. WHICH INDEX PREVENTS WHAT (owner's §2 question, 2026-11-25) ══
    //
    // *"Verify whether the existing one-active-run constraint prevents only concurrent duplicates
    // or also repeated execution after completion. Independently test the intended recurrence and
    // business-date semantics."*
    //
    // It was right to ask, and the answer corrects my own commit message for 13ef7f3, which
    // credited uq_agent_runs_one_active with both jobs. It does not do both:
    //
    //   uq_agent_runs_one_active       partial over (CREATED, RUNNING) → CONCURRENT duplicates
    //   uq_agent_runs_intent_attempt   (intent_key, attempt)          → REPEAT AFTER COMPLETION
    //
    // Both are structural, so the property holds either way; the attribution was wrong, and a
    // wrong attribution is how the next person removes the index that was actually load-bearing.
    console.log('\n── 4b. two indexes, two different jobs ──\n');

    {
      const rerun = await mkObjective({ label: 'rerun' });
      const first = await INIT.initiateDueObjectives({ companyId: A }, deps);
      const key = (first.initiated.find((x) => x.objectiveId === rerun) || {}).intentKey;
      if (!key) bad('the rerun fixture was not initiated');

      // Drive it to a terminal state through the legal transitions — the trigger refuses
      // CREATED → SUCCEEDED directly, which is itself worth knowing.
      await q(`UPDATE agent_runs SET state='RUNNING', started_at=NOW() WHERE intent_key=$1`, [key]);
      await q(`UPDATE agent_runs SET state='SUCCEEDED', ended_at=COALESCE(ended_at, NOW()) WHERE intent_key=$1`, [key]);

      const after = await INIT.initiateDueObjectives({ companyId: A }, deps);
      const startedAgain = after.initiated.filter((x) => x.objectiveId === rerun).length;
      if (startedAgain === 0) {
        ok('after the run COMPLETES, the same business day does NOT start a second run');
      } else {
        bad('a completed run was re-initiated on the same business day — the one-active index is '
          + 'partial over CREATED/RUNNING, so it cannot be what prevents this');
      }

      // WHICH index does the post-completion job is measured in section 9, at the END of this
      // file, because finding out requires DROPPING indexes and a unique index cannot be rebuilt
      // afterwards: the control itself creates the duplicate row that makes it unbuildable, and
      // the runs cannot be deleted because agent_run_events is append-only by trigger. The first
      // version restored them with `.catch(() => {})`, both CREATE INDEX statements failed
      // silently, and section 4c then measured a schema with no uniqueness at all and reported the
      // product's recurrence semantics as broken. Ordering is the fix; a swallowed error was the
      // defect.
    }

    // ══ 4c. RECURRENCE: THE NEXT BUSINESS DAY IS A NEW INTENT ════════════
    console.log('\n── 4c. the intended recurrence ──\n');

    {
      const recur = await mkObjective({ label: 'recur' });
      const RUN = require('../src/lib/office/run');
      const k1 = 'office:office-scheduled-initiation:' + recur + ':bd=2026-11-25';
      const k2 = 'office:office-scheduled-initiation:' + recur + ':bd=2026-11-26';
      const d1 = await RUN.beginObjectiveRun({ objectiveId: recur, trigger: 'schedule',
        workflow: INIT.WORKFLOW, intentKey: k1 }, deps);
      const d1again = await RUN.beginObjectiveRun({ objectiveId: recur, trigger: 'schedule',
        workflow: INIT.WORKFLOW, intentKey: k1 }, deps);
      const d2 = await RUN.beginObjectiveRun({ objectiveId: recur, trigger: 'schedule',
        workflow: INIT.WORKFLOW, intentKey: k2 }, deps);

      if (!d1.duplicate && d1again.duplicate && !d2.duplicate) {
        ok('one run per objective per BUSINESS day: the same day is declined, the next day runs');
      } else {
        bad('the recurrence semantics are not one-per-business-day',
          JSON.stringify({ d1: !!d1.duplicate, same: !!d1again.duplicate, next: !!d2.duplicate }));
      }
      const n = (await q(`SELECT COUNT(*)::int n FROM agent_runs WHERE objective_id = $1`,
        [recur])).rows[0].n;
      if (n === 2) ok(`and exactly two runs exist across two business days`);
      else bad(`${n} runs across two business days`);
    }

    // ══ 5. THE KILL SWITCH, BEFORE A RUN EXISTS ══════════════════════════
    console.log('\n── 5. a STOP prevents the run from being opened at all ──\n');

    {
      const stoppable = await mkObjective({ label: 'stoppable' });
      const AUT = require('../src/lib/autonomy');
      const r = await INIT.initiateDueObjectives({ companyId: A }, {
        ...deps,
        autonomy: { checkStopped: async () => ({ scope_type: 'capability',
          scope_key: 'office.initiate', reason: 'held pending review' }) },
      });
      if (r.initiated.length === 0 && r.refused.length >= 1
          && r.refused.every((x) => x.reason === INIT.SKIP.STOPPED)) {
        ok('a STOP refuses initiation, and it is reported as REFUSED rather than skipped');
      } else {
        bad('a STOP did not refuse initiation', JSON.stringify(r.refused));
      }
      const n = (await q(`SELECT COUNT(*)::int n FROM agent_runs WHERE objective_id = $1`,
        [stoppable])).rows[0].n;
      if (n === 0) ok('and NO run row was created — the stop is checked before the ledger opens');
      else bad(`${n} run rows exist for an objective whose initiation was stopped`);

      // Unreadable kill state must refuse too, not proceed.
      const unreadable = await INIT.initiateDueObjectives({ companyId: A }, {
        ...deps,
        autonomy: { checkStopped: async () => { throw new Error('autonomy unavailable'); } },
      });
      if (unreadable.initiated.length === 0 && unreadable.refused.length >= 1) {
        ok('an UNREADABLE kill state fails closed — asked as a consequential caller');
      } else bad('an unreadable kill state did not fail closed', JSON.stringify(unreadable));
      void AUT;
    }

    // ══ 6. IT CREATES NO AUTHORITY ═══════════════════════════════════════
    console.log('\n── 6. initiation consumes existing authority and creates none ──\n');

    {
      const before = (await q(
        `SELECT id, status, autonomy_tier, budget_usd FROM objectives
          WHERE company_id = $1 ORDER BY id`, [A])).rows;
      await INIT.initiateDueObjectives({ companyId: A }, deps);
      const after = (await q(
        `SELECT id, status, autonomy_tier, budget_usd FROM objectives
          WHERE company_id = $1 ORDER BY id`, [A])).rows;
      if (JSON.stringify(before) === JSON.stringify(after)) {
        ok('no objective changed status, tier or budget across an initiation sweep');
      } else {
        bad('the initiator altered an objective', JSON.stringify({ before, after }));
      }
      const exCount = (await q(`SELECT COUNT(*)::int n FROM office_budget_exceptions
                                 WHERE company_id = $1`, [A])).rows[0].n;
      if (exCount === 0) ok('and it created no budget exception for the unfunded objective');
      else bad(`${exCount} budget exceptions exist after an initiation sweep`);
    }

    // ══ 7. ANOTHER COMPANY'S WORK IS NOT THIS SWEEP'S ════════════════════
    console.log('\n── 7. a sweep for one company does not start another\'s ──\n');

    {
      const B = uid('co-b');
      await q(`INSERT INTO companies (id, slug, display_name, status)
               VALUES ($1,$1,$1,'active')`, [B]);
      ids.companies.push(B);
      const bObj = uid('b-obj');
      await q(`INSERT INTO objectives
                 (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                  created_by, budget_usd)
               VALUES ($1,$2,'company B work','P1','supervised','all_consequential','active',
                       'naren@fixture.invalid',1.00)`, [bObj, B]);
      ids.objectives.push(bObj);

      const r = await INIT.initiateDueObjectives({ companyId: A }, deps);
      if (!r.initiated.some((x) => x.objectiveId === bObj)
          && !r.skipped.some((x) => x.objectiveId === bObj)) {
        ok('company B\'s objective is not even CONSIDERED by a sweep for company A');
      } else bad('a sweep for one company reached another\'s objectives');

      const rb = await INIT.initiateDueObjectives({ companyId: B }, deps);
      if (rb.initiated.length === 1 && rb.initiated[0].objectiveId === bObj) {
        ok('and a sweep for company B starts it (the control)');
      } else bad('company B\'s own sweep did not start its objective', JSON.stringify(rb));
    }

    // ══ 8. AN INACTIVE COMPANY ═══════════════════════════════════════════
    console.log('\n── 8. a suspended company has no autonomous work ──\n');

    {
      const C = uid('co-c');
      await q(`INSERT INTO companies (id, slug, display_name, status)
               VALUES ($1,$1,$1,'suspended')`, [C]);
      ids.companies.push(C);
      const cObj = uid('c-obj');
      await q(`INSERT INTO objectives
                 (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                  created_by, budget_usd)
               VALUES ($1,$2,'suspended co work','P1','supervised','all_consequential','active',
                       'naren@fixture.invalid',1.00)`, [cObj, C]);
      ids.objectives.push(cObj);
      const r = await INIT.initiateDueObjectives({ companyId: C }, deps);
      if (r.initiated.length === 0
          && r.skipped.some((x) => x.reason === INIT.SKIP.COMPANY_INACTIVE)) {
        ok('an active objective of a SUSPENDED company is skipped for the company\'s sake');
      } else bad('a suspended company\'s objective was initiated', JSON.stringify(r));
      void SCOPE;
    }

    // ══ 9. WHICH INDEX PREVENTS WHAT — DESTRUCTIVE, SO IT RUNS LAST ══════
    //
    // These controls DROP indexes and do not restore them. Nothing after this point may rely on
    // the schema, which is why there is nothing after this point.
    console.log('\n── 9. two indexes, two different jobs (destructive controls) ──\n');

    {
      const victim = await mkObjective({ label: 'victim' });
      const f = await INIT.initiateDueObjectives({ companyId: A }, deps);
      const key = (f.initiated.find((x) => x.objectiveId === victim) || {}).intentKey;
      await q(`UPDATE agent_runs SET state='RUNNING', started_at=NOW() WHERE intent_key=$1`, [key]);
      await q(`UPDATE agent_runs SET state='SUCCEEDED', ended_at=COALESCE(ended_at, NOW()) WHERE intent_key=$1`, [key]);

      await q(`DROP INDEX uq_agent_runs_one_active`);
      const a1 = await INIT.initiateDueObjectives({ companyId: A }, deps);
      if (a1.initiated.filter((x) => x.objectiveId === victim).length === 0) {
        ok('with uq_agent_runs_one_active DROPPED a completed intent is STILL declined — so the '
          + 'post-completion case is uq_agent_runs_intent_attempt, not the one-active index');
      } else {
        bad('dropping the one-active index allowed a post-completion repeat, so it WAS the '
          + 'mechanism and the attribution in 13ef7f3 was right after all');
      }

      await q(`DROP INDEX uq_agent_runs_intent_attempt`);
      const a2 = await INIT.initiateDueObjectives({ companyId: A }, deps);
      if (a2.initiated.filter((x) => x.objectiveId === victim).length === 1) {
        ok('with BOTH dropped a second run IS created — there is no application-level fallback, '
          + 'which is the design, and is exactly why crediting the wrong index matters');
      } else {
        bad('with both indexes dropped nothing was created, so the mechanism is not understood');
      }
    }

  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    // ── CLEANUP: ONLY WHAT THIS CREATED, BY ID ──────────────────────────
    try {
      // agent_run_events is append-only by trigger, so runs with events are permanently
      // undeletable. The disposable cluster IS the cleanup for those; the discipline below still
      // applies to everything this check inserted itself.
      for (const id of ids.objectives) {
        await q(`DELETE FROM agent_runs WHERE objective_id = $1`, [id]).catch(() => {});
        await q(`DELETE FROM objectives WHERE id = $1`, [id]).catch(() => {});
      }
      for (const id of ids.companies) {
        await q(`DELETE FROM companies WHERE id = $1`, [id]).catch(() => {});
      }
      const mine = (await q(`SELECT COUNT(*)::int n FROM objectives WHERE id = ANY($1)`,
        [ids.objectives])).rows[0].n;
      if (mine) note(`${mine} fixture objectives survived (runs hold them) — disposable cluster`);
      else ok('every fixture this check created is gone (by id, not by timestamp)');
    } catch (e) {
      bad('cleanup failed', e.message);
    }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`FAIL  ${e.stack || e.message}`);
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
});
