#!/usr/bin/env node
// ── AGGREGATE FINANCIAL CONCURRENCY ACROSS OBJECTIVES AND COMPANIES ─────────
//
//   node scripts/check-aggregate-spend-concurrency-db.js   exit 0 = both aggregates bound
//                                                          exit 3 = NOT EXECUTED (no Postgres)
//
// Owner's Priority 5, 2026-11-26: *"Complete B3.14 aggregate financial concurrency across
// objectives and companies."* Acceptance criterion 19.
//
// ── WHAT WAS ALREADY VERIFIED, AND WHAT THIS FOUND ─────────────────────────
//
// B2.5b verified concurrency for ONE objective: ten concurrent holds against a $1.00 ceiling, three
// granted. That held because `reserveSpend` locks the objective row and compares inside the
// statement.
//
// Two things it did not cover, and writing this is what showed how bad the second was:
//
//   1. **Across DIFFERENT OBJECTIVES of one company.** Two concurrent holds lock DIFFERENT
//      objective rows, so nothing serialized them against the company's daily cap — and that cap
//      was checked in `budget.js`, outside the transaction, as a read then a decision. Exactly the
//      check-then-act B2.5b removed from the objective ceiling and left in place one level up.
//
//   2. **Across COMPANIES there was no cap at all.** `scope.spendToday` filters on `company_id`,
//      and `budget.js` compares its result against a limit its own comment calls *"the $100/day
//      enterprise"* cap. It is a **per-company** cap. The cross-company total was computed by no
//      code and constrained by no limit: ten companies at $100 each made the platform's daily
//      exposure $1,000, and nothing in the system could so much as report the figure. The tracker
//      had this as "not yet verified across companies"; it was not a verification gap, it was a
//      missing control.
//
// Both are now enforced INSIDE the hold transaction, under a fixed lock order, and measured here
// with a destructive control for each so a pass names the mechanism.
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
  cluster = DISPOSABLE.create({ label: 'aggspend' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  aggregate spend concurrency was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'agg-bootstrap@agg.invalid';
process.env.ADMIN_PASSWORD = `agg-${crypto.randomBytes(16).toString('hex')}`;
// Small caps, so the arithmetic is readable and a breach is one call away rather than a thousand.
process.env.OFFICE_COMPANY_DAILY_CAP_USD = '1.00';
process.env.OFFICE_PLATFORM_DAILY_CAP_USD = '1.50';

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 300s — a stall is a failure, not a slow pass.');
  process.exit(1);
}, 300_000);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false, max: 16 });
  const query = (t, p) => P.query(t, p);
  const withTransaction = async (fn) => {
    const c = await P.connect();
    try {
      await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const deps = { query, withTransaction };

  const made = { companies: [], objectives: [] };
  const uid = (p) => `agg-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const DB = require('../src/lib/db');
    await DB.initDB();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);

    const SCOPE = require('../src/lib/office/scope');

    const newCompany = async (label) => {
      const id = uid(label);
      await query(`INSERT INTO companies (id, slug, display_name, status)
                   VALUES ($1,$1,$1,'active')`, [id]);
      made.companies.push(id);
      return id;
    };

    /** An objective with a budget GENEROUS enough that only the daily caps can refuse. */
    const newObjective = async (companyId, label, budget) => {
      const id = uid(label);
      await query(`INSERT INTO objectives
                     (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                      created_by, budget_usd)
                   VALUES ($1,$2,$3,'P1','supervised','all_consequential','active',
                           'naren@fixture.invalid',$4)`,
        [id, companyId, `aggregate spend: ${label}`, budget]);
      made.objectives.push(id);
      return id;
    };

    /** A run, because `office_budget_reservations.run_id` is NOT NULL. */
    const newRun = async (companyId, objectiveId) => {
      const runId = crypto.randomUUID();
      await query(`INSERT INTO agent_runs
                     (run_id, root_run_id, agent, product, trigger, state, attempt,
                      objective_id, company_id)
                   VALUES ($1,$1,'agg-check','playbookos','manual','RUNNING',1,$2,$3)`,
        [runId, objectiveId, companyId]);
      return runId;
    };

    // ── CONTEXTS ARE RESOLVED, NOT CONSTRUCTED ─────────────────────────
    //
    // My first version built `{companyId, objectiveId, resolved: true}` and `assertContext`
    // refused it by name: *"A frozen object with a companyId is not a resolved context — and
    // neither is a COPY of a real one."* It is right to, and it is the guard this whole file is
    // about: a caller that can choose its own company is a caller that can choose whose budget to
    // spend. So each context is resolved from its objective, through the real resolver, once, and
    // cached — resolving per hold would serialize the race I am trying to create.
    const CTXMOD = require('../src/lib/office/context');
    const ctxCache = new Map();
    const ctxFor = async (objectiveId) => {
      if (!ctxCache.has(objectiveId)) {
        ctxCache.set(objectiveId,
          await CTXMOD.resolveObjectiveContext({ objectiveId }, deps));
      }
      return ctxCache.get(objectiveId);
    };

    /** N concurrent holds, launched together so they genuinely race. */
    const race = async (n, fn) => {
      const results = await Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
      const granted = results.filter((r) => r && r.ok);
      return { results, granted, refused: results.filter((r) => r && !r.ok) };
    };

    // ══ 1. THE SHAPE OF THE CONTEXT, FIRST ═══════════════════════════════
    head('1. the harness can take a hold at all (so a refusal below means something)');

    const CO_A = await newCompany('co-a');
    const OBJ_A1 = await newObjective(CO_A, 'a1', 10.00);
    const OBJ_A2 = await newObjective(CO_A, 'a2', 10.00);
    const RUN_A1 = await newRun(CO_A, OBJ_A1);
    const RUN_A2 = await newRun(CO_A, OBJ_A2);

    {
      const r = await SCOPE.reserveSpend(await ctxFor(OBJ_A1), {
        id: uid('warm'), objectiveId: OBJ_A1, runId: RUN_A1, maxUsd: 0.10,
        reason: 'harness warm-up hold',
      }, deps);
      if (r && r.ok && r.dailyCaps) {
        ok(`a $0.10 hold is granted and reports the aggregate headroom it was granted against `
          + `(company worst case $${r.dailyCaps.company.worstCaseUsd.toFixed(2)} of `
          + `$${r.dailyCaps.company.capUsd}, platform $`
          + `${r.dailyCaps.platform.worstCaseUsd.toFixed(2)} of ${r.dailyCaps.platform.capUsd})`);
      } else bad('the harness could not take a hold at all', r);
      await query(`DELETE FROM office_budget_reservations WHERE id = $1`,
        [r && r.reservation ? r.reservation.id : null]).catch(() => {});
    }

    // ══ 2. ACROSS DIFFERENT OBJECTIVES OF ONE COMPANY ════════════════════
    head('2. concurrent holds on DIFFERENT objectives, against the company daily cap');

    {
      // $1.00 company cap. Ten concurrent $0.30 holds, alternating between TWO objectives — so
      // the objective lock cannot be what bounds them: each objective has a $10 budget and five
      // $0.30 holds is $1.50, well inside it. Only the company daily cap can refuse.
      // Both contexts resolved BEFORE the race, so the holds genuinely overlap.
      await ctxFor(OBJ_A1); await ctxFor(OBJ_A2);
      const r = await race(10, (i) => SCOPE.reserveSpend(
        ctxCache.get(i % 2 ? OBJ_A2 : OBJ_A1), {
          id: uid(`co-${i}`),
          objectiveId: i % 2 ? OBJ_A2 : OBJ_A1,
          runId: i % 2 ? RUN_A2 : RUN_A1,
          maxUsd: 0.30,
          reason: `concurrent hold ${i} across two objectives of one company`,
        }, deps).catch((e) => ({ ok: false, code: 'threw', detail: e.message })));

      const held = Number((await query(
        `SELECT COALESCE(SUM(max_usd),0)::float8 n FROM office_budget_reservations
          WHERE company_id = $1 AND state = 'held'`, [CO_A])).rows[0].n);

      // 3 × $0.30 = $0.90 ≤ $1.00; a fourth would be $1.20.
      if (r.granted.length === 3 && Math.abs(held - 0.90) < 0.0001) {
        ok(`exactly 3 of 10 concurrent holds were granted — $${held.toFixed(2)} held against the `
          + '$1.00 company daily cap, with the holds spread over TWO objectives whose own budgets '
          + 'were nowhere near full, so the objective lock is demonstrably not what bounded them');
      } else bad('the company daily cap did not bound concurrent holds across objectives',
        { granted: r.granted.length, held, codes: r.refused.map((x) => x.code) });

      const byCode = r.refused.filter((x) => x.code === 'would_exceed_company_daily_cap');
      if (byCode.length === 7) {
        ok('and all 7 refusals name the COMPANY DAILY cap specifically — not the objective budget, '
          + 'which is the distinction an operator needs to act on');
      } else bad('refusals did not name the company daily cap',
        r.refused.map((x) => x.code));

      if (r.refused.every((x) => /under a lock/.test(String(x.detail || '')))) {
        ok('and each refusal says it was decided under a lock, which is the claim being made: not '
          + '"a check rejected this" but "two concurrent calls cannot both pass"');
      } else bad('a refusal did not state its serialization', r.refused[0]);
    }

    // ══ 3. ACROSS COMPANIES, AGAINST THE PLATFORM CAP ════════════════════
    head('3. concurrent holds in DIFFERENT companies, against the platform daily cap');

    {
      // $0.90 is already held in company A. The platform cap is $1.50, so $0.60 of platform
      // headroom remains — and company B's own daily cap ($1.00) and objective budget ($10) are
      // both untouched, so ONLY the platform cap can refuse. That is the case that had no control
      // at all before B3.14.
      const CO_B = await newCompany('co-b');
      const OBJ_B1 = await newObjective(CO_B, 'b1', 10.00);
      const RUN_B1 = await newRun(CO_B, OBJ_B1);

      const ctxB = await ctxFor(OBJ_B1);
      const r = await race(8, (i) => SCOPE.reserveSpend(ctxB, {
        id: uid(`plat-${i}`), objectiveId: OBJ_B1, runId: RUN_B1, maxUsd: 0.25,
        reason: `concurrent hold ${i} in a second company`,
      }, deps).catch((e) => ({ ok: false, code: 'threw', detail: e.message })));

      const allHeld = Number((await query(
        `SELECT COALESCE(SUM(max_usd),0)::float8 n FROM office_budget_reservations
          WHERE state = 'held'`)).rows[0].n);
      const bHeld = Number((await query(
        `SELECT COALESCE(SUM(max_usd),0)::float8 n FROM office_budget_reservations
          WHERE company_id = $1 AND state = 'held'`, [CO_B])).rows[0].n);

      // $0.90 + 2 × $0.25 = $1.40 ≤ $1.50; a third would be $1.65.
      if (r.granted.length === 2 && allHeld <= 1.5 + 1e-9 && Math.abs(bHeld - 0.50) < 0.0001) {
        ok(`exactly 2 of 8 were granted: $${allHeld.toFixed(2)} held ACROSS BOTH COMPANIES against `
          + `the $1.50 platform cap, while company B holds only $${bHeld.toFixed(2)} of its own `
          + '$1.00 — so what refused the other six is a limit that spans companies, which before '
          + 'today no code computed');
      } else bad('the platform cap did not bound holds across companies',
        { granted: r.granted.length, allHeld, bHeld, codes: r.refused.map((x) => x.code) });

      if (r.refused.every((x) => x.code === 'would_exceed_platform_daily_cap')) {
        ok('and every refusal names the PLATFORM cap, distinguishing it from the company cap that '
          + 'was nowhere near breached — the two are different exposures and a shared message '
          + 'would send somebody to the wrong one');
      } else bad('refusals did not name the platform cap', r.refused.map((x) => x.code));

      // ── THE AGGREGATE IS READABLE, AND READABLE ONLY AS AN AGGREGATE ────
      const agg = await SCOPE.spendTodayAllCompanies(deps);
      if (agg && Number(agg.held) >= 1.39 && Number(agg.held) <= 1.51) {
        ok(`the platform aggregate is readable on its own ($${Number(agg.held).toFixed(2)} held) — `
          + 'an enterprise question cannot be answered by a company-scoped accessor, and this one '
          + 'is scoped to the platform deliberately and says so');
      } else bad('the platform aggregate did not report the holds', agg);

      if (!Object.keys(agg).some((k) => /company_id|objective|run/.test(k))) {
        ok('and it returns ONLY aggregates — no company\'s rows reach a caller through it, so the '
          + 'one unscoped accessor cannot become a cross-company read');
      } else bad('the platform aggregate leaked per-company rows', Object.keys(agg));

      // ── DESTRUCTIVE CONTROL: raise the platform cap, and the refusals go ──
      //
      // Without this, every assertion above would also pass on an implementation that refused
      // everything after the second hold for some unrelated reason.
      const before = r.granted.length;
      delete require.cache[require.resolve('../src/lib/office/scope')];
      process.env.OFFICE_PLATFORM_DAILY_CAP_USD = '9.00';
      const SCOPE2 = require('../src/lib/office/scope');
      const again = await SCOPE2.reserveSpend(ctxB, {
        id: uid('plat-control'), objectiveId: OBJ_B1, runId: RUN_B1, maxUsd: 0.25,
        reason: 'control: the same hold with the platform cap raised',
      }, deps);
      if (again && again.ok) {
        ok(`control: with the platform cap raised to $9.00 the IDENTICAL hold is granted — so the `
          + `${8 - before} refusals above were that cap and not the fixture, the objective budget, `
          + 'or the lock itself');
      } else bad('the same hold was refused even with the cap raised', again);
      process.env.OFFICE_PLATFORM_DAILY_CAP_USD = '1.50';
      delete require.cache[require.resolve('../src/lib/office/scope')];
    }

    // ══ 4. THE LOCK ORDER IS SINGULAR ════════════════════════════════════
    head('4. one lock order, asserted on the source');

    {
      // Two transactions taking the same locks in different orders deadlock, and the only defence
      // is that there is exactly ONE order. That is a property of the source, not of a run: a run
      // that happens not to deadlock proves nothing about one that would.
      const fs = require('node:fs');
      const path = require('node:path');
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'lib', 'office', 'scope.js'), 'utf8');
      const body = src.slice(src.indexOf('async function reserveSpend'));
      const end = body.indexOf('\nasync function settleSpend');
      const fn = body.slice(0, end > 0 ? end : body.length);

      const iPlat = fn.indexOf('pg_advisory_xact_lock(hashtext($1))');
      const iCo = fn.indexOf('PLATFORM_SPEND_LOCK}:${ctx.companyId}');
      const iObj = fn.indexOf('FOR UPDATE');
      if (iPlat > 0 && iCo > iPlat && iObj > iCo) {
        ok('platform lock, then company lock, then the objective FOR UPDATE — in that order and '
          + 'only that order, which is what makes the deadlock question answerable by reading');
      } else bad('the lock order is not platform → company → objective', { iPlat, iCo, iObj });

      // Counted as SQL, not as text: the bare name also appears in the comment above the calls
      // explaining why the lock is transaction-scoped, and a pattern that counts that is measuring
      // prose. `SELECT pg_advisory_xact_lock` is the executable shape.
      const locks = (fn.match(/SELECT pg_advisory_xact_lock/g) || []).length;
      if (locks === 2) {
        ok('exactly two advisory locks are taken, both transaction-scoped — released on commit, '
          + 'rollback or a dropped connection, so there is no path that leaks one');
      } else bad(`${locks} advisory lock call(s) in reserveSpend`, locks);

      if (!/pg_advisory_lock\s*\(/.test(fn)) {
        ok('and no SESSION-scoped advisory lock anywhere in it — one of those survives a rollback '
          + 'and would wedge every spend hold in the database until the connection died');
      } else bad('a session-scoped advisory lock is taken');
    }

    // ══ 5. WHAT THIS DOES NOT ESTABLISH ══════════════════════════════════
    head('5. the boundary of this check');

    note('NOT established: that any cap is a PROVEN MAXIMUM CHARGE. These bound what the system '
      + 'will HOLD and therefore what it will dispatch; the held figure is a conservative estimate '
      + 'of a call\'s cost, and a conservative estimate is not a proven maximum. B3.15 — the '
      + 'per-call held-vs-measured reconciliation against the provider\'s own usage — is what '
      + 'would close that, and it has not run.');
    note('NOT established: anything about provider-side spending controls. Whether the provider '
      + 'enforces a hard limit is a separate question with separate evidence, and no paid call has '
      + 'been made.');
    note('NOT established: these caps in production. $100 company / $250 platform are the defaults '
      + 'in code; neither OFFICE_COMPANY_DAILY_CAP_USD nor OFFICE_PLATFORM_DAILY_CAP_USD is set in '
      + 'Railway, and nothing here has been deployed.');
    note('the platform-wide lock serializes ALL spend holds, which costs throughput. At the '
      + 'volumes in question — the live-model exercise is twenty calls — that is the right trade, '
      + 'and it is a deliberate one rather than an oversight.');
    note('every fixture here was created by id and is removed by id below.');
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try {
      for (const id of made.objectives) {
        await query(`DELETE FROM office_budget_reservations WHERE objective_id=$1`, [id])
          .catch(() => {});
        await query(`DELETE FROM office_cost_ledger WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM agent_runs WHERE objective_id=$1`, [id]).catch(() => {});
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
