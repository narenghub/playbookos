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
    // A second company, so "another company cannot take a hold here" has a real other company
    // rather than a made-up id the foreign key would reject for the wrong reason.
    const B_CO = uid('co-b');
    await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [B_CO]);
    ids.companies.push(B_CO);

    const mkObjective = async (label, budgetUsd) => {
      const id = uid(label);
      await scope.createObjective({
        id, companyId: A, objective: label, priority: 'P2',
        kpiMetric: 'x', kpiTarget: 1, deadline: '2026-12-31', budgetUsd,
        autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: 'ceo',
      }, deps);
      // ACTIVE. createObjective leaves an objective in `draft`, and reserveSpend refuses to hold
      // money against one that is not active — spend is not authorized against work the CEO has
      // not switched on. The earlier sections used enforceHierarchy, which does not read status,
      // so this fixture gap only surfaced when the reservation path arrived.
      await q(`UPDATE objectives SET status = 'active' WHERE id = $1`, [id]);
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

    // ── 2a. NO CALLER-CONTROLLED AUTONOMY CLASSIFICATION (B2.5b) ───────────
    //
    // Owner instruction, 2026-11-25: *"No caller-controlled autonomy classification that bypasses
    // the finite-budget requirement."*
    //
    // The first version of this gate took `autonomous = true` and the release gate passed false.
    // That IS a caller-controlled bypass: any caller could pass it, and the one that most wanted
    // to would be the one that should not. The flag is now module-private, and which of two named
    // functions a caller calls is the declaration.
    //
    // Asserted on the SIGNATURES, so a reintroduced parameter fails here rather than being noticed
    // in review — and on the call-site COUNT, because the non-spending entry point is only correct
    // while exactly one place names it.
    const spendSig = budget.enforceHierarchy.toString().slice(0, 300);
    const nonSpendSig = budget.assessWithoutSpending.toString().slice(0, 300);
    if (!/autonomous/i.test(spendSig) && !/autonomous/i.test(nonSpendSig)) {
      ok('neither exported budget entry point takes an autonomy flag — the classification is not '
        + 'a parameter a caller can set');
    } else bad('an autonomy flag is back on the public surface',
      JSON.stringify({ spendSig, nonSpendSig }));

    const fs = require('node:fs');
    const path = require('node:path');
    const REPO = path.join(__dirname, '..');
    const namesNonSpending = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(path.join(dir, e.name)); continue; }
        if (!/\.js$/.test(e.name)) continue;
        const f = path.join(dir, e.name);
        const text = fs.readFileSync(f, 'utf8');
        // Strip comments so prose about the function is not counted as a call of it — the lesson
        // from validate-k5 grepping its own documentation.
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        if (/\bassessWithoutSpending\s*\(/.test(code)) namesNonSpending.push(path.relative(REPO, f));
      }
    };
    walk(path.join(REPO, 'src'));
    walk(path.join(REPO, 'scripts'));
    // This file is excluded too, and only this file: it calls the function in order to assert the
    // distinction above. A check that counted itself would be unsatisfiable, and one that excluded
    // any file would be unfalsifiable — so the exclusion list is exactly two paths, both named.
    const ALLOWED_TO_NAME_IT = ['src/lib/office/budget.js', 'scripts/check-finite-budget-db.js'];
    const callers = namesNonSpending.filter((f) => !ALLOWED_TO_NAME_IT.includes(f));
    if (callers.length === 0) {
      ok('the non-spending gate is called from exactly one module — budget.js itself, by '
        + 'consequentialReleaseGate — and nowhere else');
      note(`the files naming it at all: ${namesNonSpending.join(', ') || '(only via the export)'}`);
    } else bad('the non-spending gate has other callers, each of which skips the finite-budget '
      + 'requirement', callers.join(', '));

    // Both directions still hold, on the same budgetless objective — but now the direction is
    // chosen by WHICH FUNCTION is called, not by an argument.
    const dSpend = await budget.enforceHierarchy(ctxN, { objectiveId: unbudgeted, capUsd: 1e9 }, deps);
    const dNoSpend = await budget.assessWithoutSpending(ctxN, { objectiveId: unbudgeted, capUsd: 1e9 }, deps);
    if (!dSpend.allow && dNoSpend.allow) {
      ok('on the SAME budgetless objective: a SPENDING operation is refused and a non-spending one '
        + 'is permitted — the rule bounds new charges, it does not make budgets mandatory for '
        + 'transmitting something already approved');
      note('a human approval is not treated as financial authorization: every dollar of AI spend '
        + 'on that run was already bounded by a hold taken before the call');
    } else bad('the spending/non-spending distinction does not hold',
      JSON.stringify({ spending: dSpend.allow, nonSpending: dNoSpend.allow }));

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
    // ══════════════════════════════════════════════════════════════════════
    // B2.5b — A HOLD BEFORE THE MONEY IS SPENT
    //
    // Owner question, 2026-11-25: "The report says a child spent past the objective ceiling and
    // the next delegation refused. Investigate whether this was a deliberately injected test
    // condition or an actual permitted overspend."
    //
    // IT WAS AN INJECTED CONDITION, and the distinction matters. check-office-delegation-db.js
    // INSERTed a cost row directly into office_cost_ledger; no provider call happened and nothing
    // was permitted to overspend. What that assertion proved was AGGREGATION — a child's cost
    // counts against the parent objective — and nothing about whether the spend could have been
    // prevented.
    //
    // The owner's follow-on is the real gap, and it was real: `governedCall` asked the budget,
    // then called the provider, then recorded the cost. Check-then-act, with two holes — two
    // concurrent calls both passed the same check, and the check never asked whether there was
    // headroom for THIS call, so one call against a $0.05 objective could cost $5 and the refusal
    // arrived on the call after it.
    //
    // Everything below is about the fix: an atomic hold for the WORST CASE, taken before the
    // provider is reached, reconciled afterwards.
    // ══════════════════════════════════════════════════════════════════════

    console.log('\n  ── 13. a real metered call is bounded BEFORE the provider is reached ──\n');

    const ai = require('../src/lib/office/ai');
    const objMetered = await mkObjective('metered', 0.02);
    const meteredRun = await mkRun(objMetered);
    const meteredCtx = door({ companyId: A, objectiveId: objMetered, runId: meteredRun,
      budgetUsd: 0.02 });

    // THE SPY IS THE ASSERTION, AND IT HAS TO BE INSTALLED WHERE THE CODE LOOKS.
    //
    // The first version passed `{ llm: spy }` in deps. office/ai.js requires `../llm` at module
    // load and never reads one from deps, so the spy was never installed: the real provider ran,
    // failed for want of a key, and `providerCalls` stayed 0 — which made "the provider was never
    // reached" pass while measuring nothing at all. The positive control below is what exposed it.
    //
    // So the module's own export is replaced, and restored in a finally. "It produced no output"
    // is not evidence that nothing was attempted — the 31 Oct lesson.
    const llmModule = require('../src/lib/llm');
    const realCallClaude = llmModule.callClaude;
    let providerCalls = 0;
    llmModule.callClaude = async ({ maxTokens }) => {
      providerCalls += 1;
      const outputTokens = Math.min(16, Number(maxTokens) || 16);
      return { text: 'spy reply', json: null, model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 40, output_tokens: outputTokens },
        ...llmModule.costOf('claude-haiku-4-5-20251001',
          { input_tokens: 40, output_tokens: outputTokens }) };
    };
    const spyDeps = { query: q };

    // A call whose WORST CASE exceeds the objective's $0.02: 8192 output tokens of haiku is
    // $0.04096 at list price, so the hold cannot fit.
    const refusedCall = await ai.governedCall(meteredCtx, {
      capability: 'fast', prompt: 'x'.repeat(100), maxTokens: 8192,
      agent: 'test-agent', workflow: 'finbud', purpose: 'worst case over the ceiling',
    }, spyDeps);
    if (!refusedCall.ok && refusedCall.refusedBy === 'budget') {
      ok('a call whose MAXIMUM POSSIBLE charge exceeds the objective budget is refused');
    } else bad('an over-ceiling call was not refused', JSON.stringify({
      ok: refusedCall.ok, refusedBy: refusedCall.refusedBy, error: refusedCall.error }));
    if (providerCalls === 0) {
      ok('and THE PROVIDER WAS NEVER REACHED — the spy would have recorded it');
      note('this is the difference the owner asked about: the limit now acts before the spend, '
        + 'not on the call after it');
    } else bad('the provider was called despite the refusal', providerCalls);
    const noRows = (await q(`SELECT COUNT(*)::int n FROM office_cost_ledger WHERE run_id = $1`,
      [meteredRun])).rows[0].n;
    if (noRows === 0) ok('and no cost row was filed for a call that never happened');
    else bad('a refused call left a cost row', noRows);

    // The SAME objective, the same code path, a call whose worst case fits: 64 output tokens of
    // haiku is $0.00032. The positive control — without it, a gate that refused everything would
    // satisfy every assertion above.
    const smallCall = await ai.governedCall(meteredCtx, {
      capability: 'fast', prompt: 'x'.repeat(100), maxTokens: 64,
      agent: 'test-agent', workflow: 'finbud', purpose: 'worst case inside the ceiling',
    }, spyDeps);
    if (providerCalls === 1 && smallCall.refusedBy !== 'budget') {
      ok('POSITIVE CONTROL: a call whose worst case FITS reaches the provider on the same '
        + 'objective — the refusal is about the magnitude, not a gate that refuses everything');
    } else bad('the positive control did not reach the provider',
      JSON.stringify({ providerCalls, refusedBy: smallCall.refusedBy }));

    // And the bound itself: the hold must never be smaller than what the call could cost.
    const llmReal = require('../src/lib/llm');
    const [inR, outR] = llmReal.ratesFor(llmReal.resolveModel('fast'));
    const trueWorstCase = (Math.ceil(100 / 4) + 0) * inR + 64 * outR;
    const heldFor = (await q(
      `SELECT max_usd::float8 AS m FROM office_budget_reservations
        WHERE run_id = $1 ORDER BY held_at DESC LIMIT 1`, [meteredRun])).rows[0];
    if (heldFor && heldFor.m >= trueWorstCase) {
      ok(`the hold ($${heldFor.m.toFixed(6)}) is at least the true worst case `
        + `($${trueWorstCase.toFixed(6)}) — it over-estimates, which is the only safe direction`);
    } else bad('the hold was smaller than the call could cost', JSON.stringify({ heldFor, trueWorstCase }));

    llmModule.callClaude = realCallClaude;
    if (llmModule.callClaude === realCallClaude) ok('the provider spy was removed again');
    else bad('the llm module was left stubbed');

    console.log('\n  ── 14. the hold is ATOMIC under concurrency ──\n');

    // $1.00, and ten simultaneous holds of $0.30. Exactly three can fit. Check-then-act lets more
    // than three through; a row lock does not. This is the assertion the previous design could
    // not have passed.
    const objRace = await mkObjective('race', 1.00);
    const raceRun = await mkRun(objRace);
    const raceCtx = door({ companyId: A, objectiveId: objRace, runId: raceRun, budgetUsd: 1.00 });
    const attempts = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      scope.reserveSpend(raceCtx, { id: uid(`race-${i}`), objectiveId: objRace, runId: raceRun,
        maxUsd: 0.30, reason: `concurrent attempt ${i}` }, deps)));
    const granted = attempts.filter((r) => r.ok).length;
    if (granted === 3) {
      ok(`exactly 3 of 10 simultaneous $0.30 holds were granted against a $1.00 budget`);
      note('check-then-act would have granted more than three; the holds serialize on the '
        + 'objectives row');
    } else bad(`${granted} of 10 concurrent holds were granted; 3 fit in $1.00`,
      JSON.stringify(attempts.map((r) => r.ok ? 'ok' : r.code)));
    const refusedForSize = attempts.filter((r) => !r.ok
      && r.code === 'would_exceed_objective_budget').length;
    if (refusedForSize === 7) {
      ok('and the other 7 were refused for exceeding the budget, each naming its worst case');
    } else bad('the refusals had the wrong reason',
      JSON.stringify(attempts.filter((r) => !r.ok).map((r) => r.code)));

    const exposure = await scope.reservationState(raceCtx, objRace, deps);
    if (Number(exposure.live_held).toFixed(2) === '0.90' && exposure.live_count === 3) {
      ok('live exposure is $0.90 across 3 holds, with nothing yet charged');
    } else bad('the exposure is wrong', JSON.stringify(exposure));

    console.log('\n  ── 15. reconciliation after completion, and after failure ──\n');

    // Settle one of the three to its REAL cost of $0.01. That frees $0.29 of headroom, so a
    // fourth $0.30 hold now fits where it did not a moment ago.
    const first = attempts.find((r) => r.ok);
    const settled = await scope.settleSpend(raceCtx, {
      reservationId: first.reservation.id, costUsd: 0.01, costKnown: true }, deps);
    if (settled && settled.state === 'settled' && Number(settled.settled_cost_usd) === 0.01) {
      ok('a completed call settles its hold to the measured cost');
    } else bad('the settlement did not record the real cost', JSON.stringify(settled));
    await q(`INSERT INTO office_cost_ledger
               (company_id, run_id, objective_id, provider, model, tokens_input, tokens_output,
                cost_usd, cost_known, agent, workflow)
             VALUES ($1,$2,$3,'anthropic','m',10,10,0.01,TRUE,'a','finbud')`,
      [A, raceRun, objRace]);
    const afterSettle = await scope.reserveSpend(raceCtx, { id: uid('race-after'),
      objectiveId: objRace, runId: raceRun, maxUsd: 0.30, reason: 'after one settled cheaply' }, deps);
    if (afterSettle.ok) {
      ok('and the headroom it over-reserved comes back: a fourth $0.30 hold now fits');
      note('$0.90 held → $0.01 charged + $0.60 held + $0.30 new = $0.91 of $1.00');
    } else bad('the settled headroom was not returned', JSON.stringify(afterSettle));

    const second = attempts.filter((r) => r.ok)[1];
    const released = await scope.releaseSpend(raceCtx, { reservationId: second.reservation.id }, deps);
    if (released && released.state === 'released') {
      ok('a call that never reached the provider RELEASES its hold in full');
    } else bad('the release did not happen', JSON.stringify(released));

    // An unmeasured call settles with NO dollar figure. Writing 0 would make "zero spend"
    // ambiguous — the same C1 rule the cost ledger follows.
    const third = attempts.filter((r) => r.ok)[2];
    const unmeasured = await scope.settleSpend(raceCtx, {
      reservationId: third.reservation.id, costUsd: null, costKnown: false }, deps);
    if (unmeasured && unmeasured.settled_cost_known === false
        && unmeasured.settled_cost_usd === null) {
      ok('an UNMEASURED call settles with no dollar amount and says so — not with $0');
    } else bad('an unmeasured settlement recorded a figure', JSON.stringify(unmeasured));

    let settleTwice = null;
    try {
      settleTwice = await scope.settleSpend(raceCtx, {
        reservationId: first.reservation.id, costUsd: 99, costKnown: true }, deps);
    } catch (e) { settleTwice = { threw: e.message }; }
    if (settleTwice === null) {
      ok('a hold cannot be settled twice — the UPDATE matches only a held row, so a double '
        + 'settlement changes nothing rather than charging twice');
    } else bad('a hold was settled twice', JSON.stringify(settleTwice));

    console.log('\n  ── 16. a crashed process cannot consume the budget for ever ──\n');

    const objCrash = await mkObjective('crash', 0.50);
    const crashRun = await mkRun(objCrash);
    const crashCtx = door({ companyId: A, objectiveId: objCrash, runId: crashRun, budgetUsd: 0.50 });
    const doomed = await scope.reserveSpend(crashCtx, { id: uid('doomed'), objectiveId: objCrash,
      runId: crashRun, maxUsd: 0.50, reason: 'a hold whose process is about to die' }, deps);
    if (doomed.ok) ok('a hold consuming the whole budget is taken');
    else bad('the fixture hold was refused', JSON.stringify(doomed));

    const blockedWhileLive = await scope.reserveSpend(crashCtx, { id: uid('blocked'),
      objectiveId: objCrash, runId: crashRun, maxUsd: 0.50,
      reason: 'a second hold while the first is live' }, deps);
    if (!blockedWhileLive.ok && blockedWhileLive.code === 'would_exceed_objective_budget') {
      ok('and while it is LIVE a second hold for the same money is refused');
    } else bad('a live hold did not block a second one', JSON.stringify(blockedWhileLive));

    // Age the hold by moving its window into the past. Deterministic, where a short TTL plus a
    // sleep is a race — and a flaky assertion measures nothing.
    await q(`UPDATE office_budget_reservations
                SET held_at = NOW() - INTERVAL '2 hours', expires_at = NOW() - INTERVAL '1 hour'
              WHERE id = $1`, [doomed.reservation.id]);
    const afterExpiry = await scope.reserveSpend(crashCtx, { id: uid('recovered'),
      objectiveId: objCrash, runId: crashRun, maxUsd: 0.50,
      reason: 'after the abandoned hold expired' }, deps);
    if (afterExpiry.ok) {
      ok('once its window passes the abandoned hold stops counting, and the budget is usable again');
      note('the predicate is `expires_at > NOW()` in SQL, so this is true BEFORE any reaper runs — '
        + 'a reaper that has to be punctual to keep a budget correct is a schedule, not a guarantee');
    } else bad('an expired hold permanently consumed the budget', JSON.stringify(afterExpiry));

    const reaped = await scope.expireStaleReservations(crashCtx, deps);
    if (reaped.includes(doomed.reservation.id)) {
      ok('and the reaper then corrects the RECORD, marking it expired — bookkeeping, not the '
        + 'mechanism');
    } else bad('the reaper did not mark the abandoned hold', JSON.stringify(reaped));

    console.log('\n  ── 17. parent and child hold against ONE ceiling ──\n');

    const objShared = await mkObjective('shared', 0.60);
    const sharedParentRun = await mkRun(objShared);
    const sharedChildRun = await mkRun(objShared);
    const parentCtx2 = door({ companyId: A, objectiveId: objShared, runId: sharedParentRun, budgetUsd: 0.60 });
    const childCtx2 = door({ companyId: A, objectiveId: objShared, runId: sharedChildRun, budgetUsd: 0.60 });
    const both = await Promise.all([
      scope.reserveSpend(parentCtx2, { id: uid('p-hold'), objectiveId: objShared,
        runId: sharedParentRun, maxUsd: 0.40, reason: 'parent run work' }, deps),
      scope.reserveSpend(childCtx2, { id: uid('c-hold'), objectiveId: objShared,
        runId: sharedChildRun, maxUsd: 0.40, reason: 'delegated child work' }, deps),
    ]);
    const bothGranted = both.filter((r) => r.ok).length;
    if (bothGranted === 1) {
      ok('a parent and its delegated child compete for the SAME $0.60: one $0.40 hold is granted '
        + 'and the other refused');
      note('this is the property the earlier injected-cost assertion only gestured at — it is now '
        + 'enforced before either call reaches a provider, concurrently, by the database');
    } else bad(`${bothGranted} of 2 concurrent parent/child holds were granted`,
      JSON.stringify(both.map((r) => r.ok ? 'ok' : r.code)));

    console.log('\n  ── 18. what the DATABASE refuses about a hold ──\n');

    const objC = await mkObjective('constraints', 5);
    const cRun = await mkRun(objC);
    const cases = [
      ['a $0 hold', `INSERT INTO office_budget_reservations
          (id, company_id, objective_id, run_id, max_usd, reason, expires_at)
         VALUES ($1,$2,$3,$4,0,'nothing', NOW() + INTERVAL '1 hour')`, '23514'],
      ['a window that runs backwards', `INSERT INTO office_budget_reservations
          (id, company_id, objective_id, run_id, max_usd, reason, expires_at)
         VALUES ($1,$2,$3,$4,1,'backwards', NOW() - INTERVAL '1 hour')`, '23514'],
      ['a blank reason', `INSERT INTO office_budget_reservations
          (id, company_id, objective_id, run_id, max_usd, reason, expires_at)
         VALUES ($1,$2,$3,$4,1,'   ', NOW() + INTERVAL '1 hour')`, '23514'],
      ['a HELD row that already carries a settlement', `INSERT INTO office_budget_reservations
          (id, company_id, objective_id, run_id, max_usd, reason, expires_at, state,
           settled_at, settled_cost_usd, settled_cost_known)
         VALUES ($1,$2,$3,$4,1,'open and closed at once', NOW() + INTERVAL '1 hour','held',
                 NOW(), 1, TRUE)`, '23514'],
      ['a RELEASED row that claims a cost', `INSERT INTO office_budget_reservations
          (id, company_id, objective_id, run_id, max_usd, reason, expires_at, state,
           settled_at, settled_cost_usd, settled_cost_known)
         VALUES ($1,$2,$3,$4,1,'released but charged', NOW() + INTERVAL '1 hour','released',
                 NOW(), 1, TRUE)`, '23514'],
      ['a SETTLED row with no measurement verdict', `INSERT INTO office_budget_reservations
          (id, company_id, objective_id, run_id, max_usd, reason, expires_at, state, settled_at)
         VALUES ($1,$2,$3,$4,1,'settled, unknowably', NOW() + INTERVAL '1 hour','settled', NOW())`,
        '23514'],
    ];
    for (const [label, sql, want] of cases) {
      let code = null;
      try { await q(sql, [uid('bad'), A, objC, cRun]); } catch (e) { code = e.code; }
      if (code === want) ok(`the database refuses ${label} (${code})`);
      else bad(`${label} was accepted`, code);
    }

    let crossCompanyHold = null;
    try {
      await q(`INSERT INTO office_budget_reservations
                 (id, company_id, objective_id, run_id, max_usd, reason, expires_at)
               VALUES ($1,$2,$3,$4,1,'another company''s run', NOW() + INTERVAL '1 hour')`,
        [uid('cross'), A, objC, await mkRun(await mkObjective('other-co-obj', 5))]);
      crossCompanyHold = 'accepted';
    } catch (e) { crossCompanyHold = e.code; }
    if (crossCompanyHold === '23503' || crossCompanyHold === '23514') {
      ok(`and refuses a hold whose objective and run do not agree (${crossCompanyHold})`);
    } else note(`same-company fixture: the cross-company case is covered by the MATCH FULL FK, `
      + `asserted in check-office-delegation-db.js (${crossCompanyHold})`);

    const noScope = await scope.reserveSpend(
      door({ companyId: B_CO, objectiveId: objC, runId: cRun }),
      { id: uid('wrong-co'), objectiveId: objC, runId: cRun, maxUsd: 1,
        reason: 'company B reaching for company A objective' }, deps);
    if (!noScope.ok && noScope.code === 'objective_not_in_company_scope') {
      ok('and a context for another company cannot take a hold against this objective at all');
    } else bad('a cross-company hold was taken', JSON.stringify(noScope));

  } catch (e) {
    bad('the check threw', e && (e.stack || e.message));
  } finally {
    try {
      for (const id of ids.exceptions) await q(`DELETE FROM office_budget_exceptions WHERE id = $1`, [id]).catch(() => {});
      await q(`DELETE FROM office_budget_exceptions WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      for (const id of ids.costs) await q(`DELETE FROM office_cost_ledger WHERE id = $1`, [id]).catch(() => {});
      await q(`DELETE FROM office_cost_ledger WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      await q(`DELETE FROM office_budget_reservations WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
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
