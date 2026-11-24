#!/usr/bin/env node
// ── AUTONOMOUS EXECUTION NEEDS A FINITE AUTHORIZED BUDGET (B2.5a) ───────────
//
//   node scripts/check-finite-budget-db.js   exit 0 = every ruled property holds
//                                            exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner instruction, 2026-11-24:
//
//   "Close the null-budget gap before enabling dynamic autonomous execution. A missing budget must
//    refuse autonomous execution unless a separately authorized, named, time-bounded and audited
//    exception exists. Test concurrent budget consumption, delegated child runs, retry costs and
//    aggregate objective-level limits. A child agent must not create a new budget that bypasses its
//    parent's authorized spending limit."
//
// ── THE TWO GAPS THIS CLOSED ────────────────────────────────────────────────
//
// 1. A NULL BUDGET MEANT UNMETERED. `enforceHierarchy` skipped its objective block entirely when no
//    objective budget was configured and returned `{ allow: true, objective: null }`. So an
//    autonomous run against an objective with no budget was permitted and unmetered, bounded only
//    by the enterprise DAILY cap — which is a shared ceiling, not that objective's authorization.
//    The tracker had recorded "a null ceiling means unmetered, not zero" as a passing assertion
//    without noting that this was the consequence.
//
// 2. THE BUDGET WAS A CALLER-SUPPLIED PARAMETER. `objectiveBudgetUsd` was an argument.
//    src/lib/office/ai.js passed `ctx.budgetUsd` and its comment claimed "There is no parameter
//    through which a caller could raise its own ceiling" — true of that call site, false of the
//    signature. Any other caller, including a delegated child agent, could pass a larger number.
//    That is the owner's child-bypass requirement, and a comment does not close it. The parameter
//    is gone; the budget is read off the resolved objective context.
//
// Both are asserted here against a real database, because the aggregation is SQL — "what has this
// objective spent" is a SUM over office_cost_ledger, and a stubbed query would be asserting that
// my own stub adds up the way I think Postgres does.
//
// NO URL OVERRIDE: this INSERTs objectives, cost rows and budget exceptions. Fixtures by id.

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
  cluster = DISPOSABLE.create({ label: 'finbud' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  finite budgets not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'finbud-bootstrap@finbud.invalid';
process.env.ADMIN_PASSWORD = `finbud-${crypto.randomBytes(16).toString('hex')}`;

const WATCHDOG_MS = Number(process.env.FINBUD_CHECK_TIMEOUT_MS || 240_000);
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
  const ids = { companies: [], objectives: [], exceptions: [], costs: [] };
  const uid = (p) => `finbud-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    console.log('  ..    schema up\n');

    const scope = require('../src/lib/office/scope');
    const CTX = require('../src/lib/office/context');
    const budget = require('../src/lib/office/budget');
    const door = CTX.contextForTests__TEST_ONLY;

    const A = uid('co');
    await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [A]);
    ids.companies.push(A);

    const mkObjective = async (label, budgetUsd) => {
      const id = uid(label);
      await scope.createObjective({
        id, companyId: A, objective: label, priority: 'P2',
        kpiMetric: 'x', kpiTarget: 1, deadline: '2026-12-31', budgetUsd,
        autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: 'ceo',
      }, deps);
      ids.objectives.push(id);
      return id;
    };

    // ── 0. THE TABLE AND ITS GUARANTEES ────────────────────────────────────
    const cols = (await q(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'office_budget_exceptions'`)).rows;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    for (const c of ['granted_by', 'reason', 'effective_from', 'effective_to']) {
      if (byName[c] === 'NO') ok(`office_budget_exceptions.${c} is NOT NULL`);
      else bad(`${c} is nullable — an exception must be named and time-bounded`, byName[c]);
    }
    note('effective_to NOT NULL is what makes it time-bounded: an exception that never expires is '
      + 'a policy change wearing an exception\'s clothes.');

    // ── 1. A FINITE BUDGET BEHAVES AS BEFORE ───────────────────────────────
    const budgeted = await mkObjective('budgeted', 10);
    const ctxB = door({ companyId: A, objectiveId: budgeted, budgetUsd: 10 });
    const d1 = await budget.enforceHierarchy(ctxB, { objectiveId: budgeted, capUsd: 1e9 }, deps);
    if (d1.allow && d1.objective && d1.objective.budgetUsd === 10) {
      ok('a finite objective budget with headroom ALLOWS, and reports the budget it enforced');
    } else bad('a budgeted objective was refused', d1);

    // ── 2. NO BUDGET REFUSES AUTONOMOUS EXECUTION ──────────────────────────
    const unbudgeted = await mkObjective('unbudgeted', null);
    const ctxN = door({ companyId: A, objectiveId: unbudgeted });   // no budgetUsd at all
    const d2 = await budget.enforceHierarchy(ctxN, { objectiveId: unbudgeted, capUsd: 1e9 }, deps);
    if (!d2.allow && d2.needsBudgetOrException) {
      ok('NO objective budget REFUSES autonomous execution — it is no longer unmetered under the '
        + 'shared enterprise cap');
    } else bad('an objective with no budget permitted autonomous execution', d2);
    if (!d2.allow && d2.scope === 'objective') ok('and it refuses at the OBJECTIVE scope, so the reason is actionable');
    else bad('refused at the wrong scope', d2.scope);

    // ── 2a. WHAT "AUTONOMOUS" MEANS, ON THE SAME BUDGETLESS OBJECTIVE ──────
    //
    // The refusal above belongs to UNATTENDED spend. A release of an action a named human has
    // already approved is not that, and if it were refused the only way to send an approved email
    // would be to invent a budget figure — a check pressuring the next operator toward a worse fix.
    //
    // So the distinction is asserted here, on ONE objective, in BOTH directions. The pair is the
    // point: a single assertion either way would be satisfied by the gate being uniformly strict or
    // uniformly lax, and neither is the property. Changing one without the other makes these two
    // disagree, which is how the next person finds out.
    const dAuto = await budget.enforceHierarchy(
      ctxN, { objectiveId: unbudgeted, capUsd: 1e9, autonomous: true }, deps);
    const dHuman = await budget.enforceHierarchy(
      ctxN, { objectiveId: unbudgeted, capUsd: 1e9, autonomous: false }, deps);
    if (!dAuto.allow && dHuman.allow) {
      ok('on the SAME budgetless objective: autonomous execution is refused, and an explicitly '
        + 'non-autonomous call is allowed — the rule is about unattended spend, not about budgets '
        + 'being mandatory');
    } else bad('the autonomous/non-autonomous distinction does not hold',
      JSON.stringify({ autonomous: dAuto.allow, human: dHuman.allow }));

    // And the release gate — the one real non-autonomous caller — must actually be declared so,
    // because that is the call site the property depends on. Read from the source rather than
    // inferred from a successful release, which could succeed for other reasons.
    const relSrc = budget.consequentialReleaseGate.toString();
    if (/autonomous:\s*false/.test(relSrc)) {
      ok('consequentialReleaseGate declares itself non-autonomous at the call site, so a '
        + 'human-approved release is not blocked by a missing objective budget');
      note('the enterprise daily cap and refuseOnUnmeasured still apply to it in full');
    } else bad('the release gate does not declare its autonomy, so it inherits the strict default '
      + 'and a human-approved action cannot be released without a budget figure');

    // ── 3. A CHILD CANNOT RAISE ITS OWN CEILING ────────────────────────────
    //
    // The parameter is gone, so this is now structural rather than a matter of the parameter being
    // ignored. Asserted by inspecting the function's declared arguments: a reviewer reading the
    // signature sees no way in, and so does this check.
    const src = budget.enforceHierarchy.toString();
    const sig = src.slice(0, src.indexOf(')') + 1);
    if (!/objectiveBudgetUsd/.test(sig)) {
      ok('enforceHierarchy accepts NO budget parameter — a delegated child agent has nothing to '
        + 'pass, which is what closes the bypass rather than a promise in a comment');
    } else bad('the budget is still caller-supplied', sig);

    // And behaviourally: a child context derived from the parent cannot carry a bigger budget,
    // because deriveContext re-seals the parent's fields and the company cannot change.
    const parent = door({ companyId: A, objectiveId: budgeted, budgetUsd: 10 });
    const child = CTX.deriveContext(parent, { runId: 'finbud-child-run' });
    if (child.budgetUsd === 10) {
      ok('a derived CHILD context inherits the parent\'s budget — it does not get a fresh one');
    } else bad('a child context changed the budget', child.budgetUsd);

    // ── 4. AGGREGATE OBJECTIVE-LEVEL LIMITS, AND RETRY COSTS ───────────────
    //
    // An objective's budget is a TOTAL for its life, not a per-call allowance. Retries are the
    // case that makes this matter: three attempts at $4 each is $12 against a $10 objective, and
    // each individual charge looks affordable.
    // The REAL columns: `id` is BIGSERIAL (so it is returned, not supplied), the timestamp is `at`
    // not `created_at`, and the call is identified by provider/model rather than a capability. Read
    // off the schema after guessing wrong — the kind of guess a stubbed query would have accepted.
    // A cost row references a RUN of the same company, via
    // `fk_office_cost_run_company FOREIGN KEY (run_id, company_id) MATCH FULL` — the kernel's
    // welding, which is why a cost row cannot be attributed to a company that did not run it. So
    // the fixture opens real runs rather than inventing uuids.
    const mkRun = async (objectiveId) => {
      const runId = crypto.randomUUID();
      await q(
        `INSERT INTO agent_runs (run_id, root_run_id, company_id, objective_id, trigger, product,
                                 state, workflow, agent)
         VALUES ($1,$1,$2,$3,'office','internal','SUCCEEDED','finbud-fixture','finbud-agent')`,
        [runId, A, objectiveId]);
      return runId;
    };

    const chargeCost = async (objectiveId, usd, runId = null) => {
      const rid = runId || await mkRun(objectiveId);
      const r = await q(
        `INSERT INTO office_cost_ledger (company_id, objective_id, run_id, provider, model,
                                         cost_usd, cost_known, at)
         VALUES ($1,$2,$3,'anthropic','claude-haiku-4-5',$4,TRUE,NOW())
         RETURNING id`,
        [A, objectiveId, rid, usd]);
      ids.costs.push(r.rows[0].id);
      return r.rows[0].id;
    };
    await chargeCost(budgeted, 4);
    const afterOne = await budget.enforceHierarchy(ctxB, { objectiveId: budgeted, capUsd: 1e9 }, deps);
    if (afterOne.allow) ok('retry 1 of 3: $4 of $10 spent, still allowed');
    else bad('a budgeted objective refused with headroom remaining', afterOne);
    await chargeCost(budgeted, 4);
    const afterTwo = await budget.enforceHierarchy(ctxB, { objectiveId: budgeted, capUsd: 1e9 }, deps);
    if (afterTwo.allow) ok('retry 2 of 3: $8 of $10 spent, still allowed');
    else bad('refused at $8 of $10', afterTwo);
    await chargeCost(budgeted, 4);
    const afterThree = await budget.enforceHierarchy(ctxB, { objectiveId: budgeted, capUsd: 1e9 }, deps);
    if (!afterThree.allow && afterThree.scope === 'objective') {
      ok('retry 3 of 3: $12 of $10 — REFUSED. Retry costs AGGREGATE against the objective total, '
        + 'so three individually affordable attempts cannot exceed it together');
    } else bad('aggregated retry costs did not exhaust the objective budget', afterThree);

    // ── 5. CHILD RUNS AGGREGATE AGAINST THE PARENT OBJECTIVE ───────────────
    //
    // The delegation case. A child run is a different run_id, so its spend must still count against
    // the SAME objective or delegation becomes a way to multiply the budget.
    const delegated = await mkObjective('delegated', 6);
    const ctxD = door({ companyId: A, objectiveId: delegated, budgetUsd: 6 });
    const parentRun = await mkRun(delegated);
    const childRun = await mkRun(delegated);
    await chargeCost(delegated, 3, parentRun);
    await chargeCost(delegated, 3, childRun);   // a genuinely DIFFERENT run — the delegated child
    const afterChild = await budget.enforceHierarchy(ctxD, { objectiveId: delegated, capUsd: 1e9 }, deps);
    if (!afterChild.allow && afterChild.scope === 'objective') {
      ok('a DELEGATED CHILD run\'s spend counts against the parent objective — two runs of $3 '
        + 'exhaust a $6 objective, so delegation does not multiply the budget');
    } else bad('child run spend did not aggregate against the objective', afterChild);

    // ── 6. CONCURRENT CONSUMPTION ──────────────────────────────────────────
    //
    // Ten simultaneous enforcement decisions against an exhausted objective must all refuse. This
    // is the weaker of the two concurrency properties and the honest one to claim: enforcement
    // READS the ledger, so two callers can both be told "yes" before either charges. The charge
    // itself is where serialisation lives, and sync-run.test.js already proves the UPDATE carries
    // its own guard ("calls are charged BEFORE they are made, and the guard is in the UPDATE
    // itself"). Claiming more than that here would be a measurement standing in for the property.
    const decisions = await Promise.all(Array.from({ length: 10 }, () =>
      budget.enforceHierarchy(ctxD, { objectiveId: delegated, capUsd: 1e9 }, deps)));
    const allowed = decisions.filter((d) => d.allow).length;
    if (allowed === 0) ok('10 CONCURRENT decisions against an exhausted objective: all 10 refuse');
    else bad(`${allowed} of 10 concurrent decisions were allowed against an exhausted objective`, allowed);
    note('Enforcement reads the ledger, so it cannot serialise two callers by itself — the charge '
      + 'does, and its guard is in the UPDATE (proved in sync-run.test.js).');

    // ── 7. THE EXCEPTION: NAMED, TIME-BOUNDED, AUDITED ─────────────────────
    const exId = uid('exc');
    await q(
      `INSERT INTO office_budget_exceptions
         (id, company_id, objective_id, granted_by, reason, effective_from, effective_to)
       VALUES ($1,$2,$3,'naren@abiozen.com','fixture: approved unmetered window',
               NOW() - INTERVAL '1 minute', NOW() + INTERVAL '1 hour')`,
      [exId, A, unbudgeted]);
    ids.exceptions.push(exId);
    const d7 = await budget.enforceHierarchy(ctxN, { objectiveId: unbudgeted, capUsd: 1e9 }, deps);
    if (d7.allow && d7.budgetException && d7.budgetException.id === exId) {
      ok('an ACTIVE named exception permits it, and the decision carries who granted it and when '
        + 'it expires — so the audit trail travels with the permission');
    } else bad('an active exception did not permit execution', d7);

    // ── 8. AN EXPIRED OR REVOKED EXCEPTION IS NOT AN EXCEPTION ─────────────
    await q(`UPDATE office_budget_exceptions SET effective_to = NOW() - INTERVAL '1 second' WHERE id = $1`, [exId]);
    const d8 = await budget.enforceHierarchy(ctxN, { objectiveId: unbudgeted, capUsd: 1e9 }, deps);
    if (!d8.allow) ok('an EXPIRED exception refuses again — time-bounded means it stops working');
    else bad('an expired exception still permitted unmetered execution', d8);

    await q(`UPDATE office_budget_exceptions SET effective_to = NOW() + INTERVAL '1 hour',
             revoked_at = NOW(), revoked_by = 'naren@abiozen.com' WHERE id = $1`, [exId]);
    const d8b = await budget.enforceHierarchy(ctxN, { objectiveId: unbudgeted, capUsd: 1e9 }, deps);
    if (!d8b.allow) ok('a REVOKED exception refuses even while inside its window');
    else bad('a revoked exception still permitted unmetered execution', d8b);

    // ── 9. THE DATABASE REFUSES A MALFORMED EXCEPTION ──────────────────────
    const refuses = async (sql, params) => {
      try { await q(sql, params); return null; } catch (e) { return e.code; }
    };
    const noEnd = await refuses(
      `INSERT INTO office_budget_exceptions (id, company_id, objective_id, granted_by, reason, effective_to)
       VALUES ($1,$2,$3,'x','y',NULL)`, [uid('bad1'), A, unbudgeted]);
    if (noEnd === '23502') ok('the DATABASE refuses an exception with no expiry — not merely this module');
    else bad('an open-ended exception was accepted', noEnd);

    const backwards = await refuses(
      `INSERT INTO office_budget_exceptions (id, company_id, objective_id, granted_by, reason,
                                             effective_from, effective_to)
       VALUES ($1,$2,$3,'x','y', NOW(), NOW() - INTERVAL '1 hour')`, [uid('bad2'), A, unbudgeted]);
    if (backwards === '23514') ok('and an exception whose window ends before it starts');
    else bad('a backwards window was accepted', backwards);

    const blank = await refuses(
      `INSERT INTO office_budget_exceptions (id, company_id, objective_id, granted_by, reason, effective_to)
       VALUES ($1,$2,$3,'x','   ', NOW() + INTERVAL '1 hour')`, [uid('bad3'), A, unbudgeted]);
    if (blank === '23514') ok('and an exception with a blank reason — it must say why');
    else bad('a blank reason was accepted', blank);

    const halfRevoked = await refuses(
      `UPDATE office_budget_exceptions SET revoked_by = NULL WHERE id = $1`, [exId]);
    if (halfRevoked === '23514') ok('and a revocation that records no actor');
    else bad('a revocation with no actor was accepted', halfRevoked);

    // ── 10. AN EXCEPTION CANNOT CROSS COMPANIES ────────────────────────────
    const B = uid('co-other');
    await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [B]);
    ids.companies.push(B);
    const cross = await refuses(
      `INSERT INTO office_budget_exceptions (id, company_id, objective_id, granted_by, reason, effective_to)
       VALUES ($1,$2,$3,'x','cross-company',NOW() + INTERVAL '1 hour')`,
      [uid('bad4'), B, unbudgeted]);
    if (cross === '23503') {
      ok('the composite FK refuses an exception for ANOTHER company\'s objective — the database '
        + 'stops it, not the accessor');
    } else bad('a cross-company exception was accepted', cross);

    // ── 11. AN UNREADABLE EXCEPTION IS NOT AN EXCEPTION ────────────────────
    const blindDeps = { query: async (text, params) => {
      if (/office_budget_exceptions/i.test(text)) throw new Error('forced: exceptions unreadable');
      return q(text, params);
    } };
    const d11 = await budget.enforceHierarchy(ctxN, { objectiveId: unbudgeted, capUsd: 1e9 }, blindDeps);
    if (!d11.allow && /could not be read/.test(d11.reason || '')) {
      ok('when the exception record cannot be READ, execution is refused — an outage is not '
        + 'permission, the same rule the membership accessor follows');
    } else bad('an unreadable exception table permitted execution', d11);

    // ── 12. CRITICAL, RECOVERY AND OBSERVABILITY STAY EXEMPT ───────────────
    //
    // Unchanged on purpose: "an accounting limit must not become an outage". The new refusal must
    // not have turned a missing budget into a way to silence the alert channel.
    for (const criticality of ['critical', 'recovery', 'observability']) {
      const d = await budget.enforceHierarchy(ctxN, { objectiveId: unbudgeted, criticality, capUsd: 0.000001 }, deps);
      if (d.allow && d.exempt) ok(`${criticality} work is still never refused by a spend limit`);
      else bad(`${criticality} work was refused — an accounting limit became an outage`, d);
    }
  } catch (e) {
    bad('the check threw', e && (e.stack || e.message));
  } finally {
    try {
      for (const id of ids.exceptions) await q(`DELETE FROM office_budget_exceptions WHERE id = $1`, [id]).catch(() => {});
      await q(`DELETE FROM office_budget_exceptions WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      for (const id of ids.costs) await q(`DELETE FROM office_cost_ledger WHERE id = $1`, [id]).catch(() => {});
      await q(`DELETE FROM office_cost_ledger WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      await q(`DELETE FROM agent_runs WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      for (const id of ids.objectives) await q(`DELETE FROM objectives WHERE id = $1`, [id]).catch(() => {});
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]).catch(() => {});
      const left = (await q(`SELECT COUNT(*)::int n FROM objectives WHERE id = ANY($1)`,
        [ids.objectives])).rows[0].n;
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
    console.log('\nFAIL  autonomous execution does not yet require a finite authorized budget.');
    process.exit(1);
  }
  console.log('\nPASS  B2.5a: autonomous execution requires a finite authorized budget; a missing one '
    + 'refuses unless a named, time-bounded, audited and non-revoked exception says otherwise; '
    + 'retry and delegated-child costs aggregate against the objective total; the budget is read '
    + 'from the resolved context so no caller can raise its own ceiling; an unreadable exception is '
    + 'not permission; and critical, recovery and observability work is still never refused.');
  process.exit(0);
})();
