#!/usr/bin/env node
// ── K1 PRODUCTION VALIDATION ─────────────────────────────────────────────────
//
//   railway ssh 'node scripts/validate-k1-deployed.js'   → exit 0 = K1 holds on production
//
// Answers Rulings 3, 5, 6, 7 and 9 of the K1 production ruling, against the real production
// schema and the real production constraints.
//
// ── IT WRITES NOTHING DURABLE ────────────────────────────────────────────────
//
// Every fixture — two companies, two objectives, two runs and the kernel records — is created
// inside ONE transaction that ends in a deliberate ROLLBACK, triggered by a sentinel throw. The
// adversarial writes have to be attempted against the REAL constraints to prove anything (a
// constraint is a server-side object; nothing off-production can stand in for it), and a fixture
// left behind in production could never be deleted — agent_run_events is append-only by trigger.
// So: real constraints, real refusals, nothing persisted. After the rollback the script re-checks
// OUTSIDE the transaction that every fixture id is absent, which is the ruled proof.
//
// ── THE TRAP THIS SCRIPT IS BUILT AROUND ─────────────────────────────────────
//
// In PostgreSQL a failed statement ABORTS the whole transaction: every subsequent statement then
// fails with SQLSTATE 25P02 "current transaction is aborted". A naive version of this script
// would attempt attack 1, see it refused, attempt attack 2, receive 25P02 — and score that as a
// second successful refusal. Six attacks would "pass" while only the first was ever evaluated.
// That is exactly the defect class this programme keeps paying for: a check that passes for an
// unrelated reason is not evidence.
//
// Two defences, both mandatory:
//   1. every attack runs inside its own SAVEPOINT, rolled back to on failure, so the transaction
//      stays usable;
//   2. every refusal is asserted to carry a REAL constraint SQLSTATE (23503 foreign key, 23502
//      not-null, 23514 check). A 25P02 is reported as a BROKEN CHECK, never as a refusal.
//
// ── ON THE COMPANY-REQUIRED TRIGGER ─────────────────────────────────────────
//
// Ruling 5 item 9 asks for evidence that a company-required INSERT trigger exists and is enabled.
// IT DOES NOT EXIST. It was removed during K1 and the removal is recorded in the accepted
// implementation record: mutation control M3 established that its condition was exactly
// MATCH FULL's condition, so it enforced nothing the foreign key did not, and no control could
// show it load-bearing. This script therefore reports the trigger as ABSENT BY DESIGN and proves
// the INVARIANT it was meant to carry instead (section 6). It does not report a trigger it cannot
// find as present, and it does not quietly drop the requirement.
'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../src/lib/db');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

const AUTHORIZED_COMPANY_ID_TABLES = new Set([
  'objectives', 'agent_runs',
  'office_cost_ledger', 'office_approvals', 'office_exceptions', 'office_outcomes',
]);
const REAL_CONSTRAINT_CODES = new Set(['23503', '23502', '23514', '23505']);
const SENTINEL = '__k1_validation_rollback__';

(async () => {
  const fixtures = { companies: [], objectives: [], runs: [] };
  let historical = null;

  try {
    // ══ 1. RULING 3 — PRODUCTION FACTS (READ ONLY) ═════════════════════════
    console.log('\n1. Production facts (read only)\n');

    const pbm = process.env.PRODUCT_BOUNDARY_MODE;
    const per = process.env.PERMISSIONS_ENFORCE_ROLES;
    console.log(`  PRODUCT_BOUNDARY_MODE      = ${pbm === undefined ? '<UNSET>' : JSON.stringify(pbm)}`);
    console.log(`  PERMISSIONS_ENFORCE_ROLES  = ${per === undefined ? '<UNSET>' : JSON.stringify(per)}`);
    // Effective behaviour, from the code's own defaults rather than from a guess.
    const pbmEffective = pbm || 'shadow (code default)';
    const perRoles = (per || '').split(',').map((s) => s.trim()).filter(Boolean);
    console.log(`  → product boundary effective mode : ${pbmEffective}`);
    console.log(`  → product boundary blocks anything: ${/^enforce/i.test(pbm || '') ? 'YES' : 'NO'}`);
    console.log(`  → roles with permissions enforced : ${perRoles.length ? perRoles.join(', ') : 'NONE (enforcing nothing, fails open)'}`);

    const role = (await query(
      `SELECT current_user AS u, usesuper
         FROM pg_user WHERE usename = current_user`
    )).rows[0];
    console.log(`  runtime PostgreSQL role    = ${role ? role.u : 'UNKNOWN'}  superuser=${role ? role.usesuper : 'UNKNOWN'}`);
    if (role && role.usesuper) {
      note('runtime role IS a superuser → row-level security would be BYPASSED, even under FORCE ROW');
      note('LEVEL SECURITY. No RLS claim can be made until a non-superuser application role exists.');
    } else if (role) {
      note('runtime role is NOT a superuser → RLS is available as a future read-side mechanism');
    }

    // ══ 2. RULING 5 — PRODUCTION SCHEMA EVIDENCE ═══════════════════════════
    // Inspected, never inferred from migration success. The boot migration logs and does not fail
    // the boot, so a running server is not evidence that the schema applied.
    console.log('\n2. Production schema (inspected, not inferred)\n');

    for (const t of ['companies', 'objectives', 'office_cost_ledger', 'office_approvals',
      'office_exceptions', 'office_outcomes']) {
      const r = (await query(`SELECT to_regclass($1) AS c`, [t])).rows[0];
      if (r.c) ok(`${t} exists`);
      else bad(`${t} DOES NOT EXIST on production — the K1 migration did not apply`);
    }

    const runCol = (await query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'agent_runs' AND column_name = 'company_id'`
    )).rows[0];
    if (!runCol) bad('agent_runs.company_id does not exist');
    else if (runCol.is_nullable !== 'YES') bad(`agent_runs.company_id is NOT NULL — legacy rows cannot be preserved (is_nullable=${runCol.is_nullable})`);
    else ok('agent_runs.company_id exists and remains NULLABLE for legacy compatibility');

    for (const t of ['office_cost_ledger', 'office_approvals', 'office_exceptions', 'office_outcomes']) {
      const c = (await query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'company_id'`, [t]
      )).rows[0];
      if (!c) bad(`${t}.company_id missing`);
      else if (c.is_nullable !== 'NO') bad(`${t}.company_id is NULLABLE — kernel tables must require it from creation`);
      else ok(`${t}.company_id is NOT NULL from creation`);
    }

    // ── Ruling 5 item 7 — MATCH FULL on every composite FK ────────────────
    // confmatchtype: 'f' = FULL, 's' = SIMPLE, 'p' = PARTIAL. MATCH SIMPLE is the DEFAULT and
    // passes if ANY column is NULL, which on a legacy-nullable company_id is the whole evasion.
    const COMPOSITE_FKS = [
      'fk_agent_runs_objective_company',
      'fk_office_cost_run_company',
      'fk_office_approvals_run_company',
      'fk_office_exceptions_run_company',
      'fk_office_outcomes_run_company',
    ];
    for (const name of COMPOSITE_FKS) {
      const r = (await query(
        `SELECT confmatchtype, convalidated FROM pg_constraint WHERE conname = $1`, [name]
      )).rows[0];
      if (!r) bad(`composite FK ${name} is ABSENT on production`);
      else if (r.confmatchtype !== 'f') bad(`${name} is NOT MATCH FULL (confmatchtype=${r.confmatchtype}) — the one-NULL evasion is open`);
      else ok(`${name} exists and is MATCH FULL${r.convalidated ? '' : ' (NOT VALID: enforces new writes, history not re-examined)'}`);
    }

    for (const name of ['uq_objectives_id_company', 'uq_agent_runs_run_company']) {
      const r = (await query(`SELECT contype FROM pg_constraint WHERE conname = $1`, [name])).rows[0];
      if (!r) bad(`composite UNIQUE ${name} is absent — the FKs above have no target`);
      else ok(`composite UNIQUE ${name} exists`);
    }

    // ── Ruling 5 item 9 — the trigger. Reported honestly. ─────────────────
    const trg = (await query(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgname = 'trg_agent_runs_company_required' AND NOT tgisinternal`
    )).rows[0];
    if (trg) {
      note(`a company-required trigger IS present (tgenabled=${trg.tgenabled}) — unexpected: K1 removed it.`);
      note('Reconcile before relying on it; the accepted record states it was removed as redundant.');
    } else {
      note('company-required INSERT trigger: ABSENT BY DESIGN (ruling 5 item 9 / DoD item 8).');
      note('Removed during K1 — mutation control M3 showed its condition WAS MATCH FULL\'s, so it');
      note('enforced nothing extra and no control could show it load-bearing. The INVARIANT it was');
      note('meant to carry is proven directly in section 6 below instead.');
    }

    // ── Ruling 5 item 10 — nothing outside the authorized scope gained company_id ──
    const withCol = (await query(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'company_id' AND table_schema = 'public'
        ORDER BY table_name`
    )).rows.map((r) => r.table_name);
    const unauthorized = withCol.filter((t) => !AUTHORIZED_COMPANY_ID_TABLES.has(t));
    if (unauthorized.length) bad(`tables OUTSIDE the authorized scope carry company_id: ${unauthorized.join(', ')}`);
    else ok(`company_id appears on exactly the authorized tables (${withCol.length}): ${withCol.join(', ')}`);

    // ══ 3. RULING 7 — HISTORICAL EVIDENCE ═════════════════════════════════
    console.log('\n3. Historical agent_runs (ruling 7)\n');

    // THE CUTOVER, AND WHY THIS IS NOT AN ABSOLUTE COUNT.
    //
    // The first version asserted "zero runs carry a company" across the whole table. That is true
    // today and becomes FALSE the moment K2 creates one legitimate office run — and the obvious
    // fix when it started failing would be to widen or delete the assertion. A check that
    // pressures the next person toward weakening it is worse than no check (CLAUDE.md), and this
    // is the same shape as "assert the table is empty".
    //
    // The invariant that actually matters is bounded: NO RUN THAT PREDATES K1 MAY EVER CARRY A
    // COMPANY. Pre-cutover rows are a closed set — nothing new is created in the past — so this
    // assertion is stable forever, while legitimate post-cutover office runs are counted and
    // reported rather than failed.
    const CUTOVER = '2026-11-01T12:00:00Z';   // after the K1 schema deploy (27f46a4, 11:43Z)

    historical = (await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at < $1::timestamptz)::int AS pre_cutover,
              COUNT(*) FILTER (WHERE created_at < $1::timestamptz AND company_id IS NOT NULL)::int AS pre_attributed,
              COUNT(*) FILTER (WHERE created_at >= $1::timestamptz AND company_id IS NOT NULL)::int AS post_attributed,
              COUNT(*) FILTER (WHERE company_id IS NULL)::int AS null_company
         FROM agent_runs`, [CUTOVER]
    )).rows[0];
    console.log(`  agent_runs total                   = ${historical.total}`);
    console.log(`  created before K1 cutover          = ${historical.pre_cutover}   (${CUTOVER})`);
    console.log(`  …of those, attributed to a company = ${historical.pre_attributed}   (MUST be 0)`);
    console.log(`  post-cutover office runs           = ${historical.post_attributed}   (legitimate K2 work)`);
    console.log(`  company_id IS NULL (any era)       = ${historical.null_company}`);

    if (historical.pre_attributed !== 0) {
      bad(`${historical.pre_attributed} PRE-CUTOVER run(s) carry a company — ownership was assigned to historical rows, which K1 is not authorized to do`);
    } else {
      ok('ZERO pre-K1 runs are attributed to any company — the NULLs are intact historical truth');
    }
    // Immutability makes the above structural rather than merely observed: a legacy run cannot be
    // promoted by UPDATE, so a pre-cutover row that is NULL today can never become attributed.
    const immut = (await query(
      `SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'trg_office_runs_company_immutable' AND NOT tgisinternal`
    )).rows[0];
    if (!immut) bad('trg_office_runs_company_immutable is ABSENT — a legacy run could be promoted into the kernel by a later UPDATE');
    else if (immut.tgenabled === 'D') bad('trg_office_runs_company_immutable is DISABLED');
    else ok('company identity is immutable after insert (trigger present and enabled) — a legacy run can never be promoted');

    // A stable fingerprint of historical run identity and state, ordered deterministically. This
    // is the baseline for FUTURE comparison. It is NOT a before/after comparison, and this script
    // does not pretend to be one — see the honest limitation printed below.
    // Checksum over the CLOSED pre-cutover set. An earlier version checksummed every
    // company-NULL run, which grows every time an ordinary cron runs — so the figure changed
    // daily and could never be compared to anything. The pre-cutover set cannot grow.
    const fp = (await query(
      `SELECT md5(string_agg(run_id::text || '|' || state || '|' || product || '|' ||
                              COALESCE(trigger,'') || '|' || created_at::text, E'\\n'
                              ORDER BY run_id)) AS checksum,
              COUNT(*)::int AS n
         FROM agent_runs WHERE created_at < $1::timestamptz`, [CUTOVER]
    )).rows[0];
    console.log(`  historical identity/state checksum = ${fp.checksum || '(no rows)'}  over ${fp.n} run(s)`);
    note('LIMITATION, stated rather than papered over: a true BEFORE snapshot is unobtainable — the');
    note('migration ran at boot during the deploy, so no pre-migration reading exists. What IS');
    note('established: zero rows attributed, counts reconcile, and the change could not rewrite a');
    note('row by construction — ADD COLUMN with no DEFAULT is a catalog-only change and ADD');
    note('CONSTRAINT ... NOT VALID does not touch existing rows. The checksum above is the baseline');
    note('for every future comparison.');

    // ══ 4-6. RULING 6 — ADVERSARIAL VALIDATION, ROLLBACK-SAFE ═════════════
    console.log('\n4. Adversarial validation against the real production constraints\n');
    note('all of the following happens inside ONE transaction that is deliberately ROLLED BACK');

    const A = `k1val-co-a-${crypto.randomUUID()}`;
    const B = `k1val-co-b-${crypto.randomUUID()}`;
    const OA = `k1val-obj-a-${crypto.randomUUID()}`;
    const OB = `k1val-obj-b-${crypto.randomUUID()}`;
    const RA = crypto.randomUUID();
    const RB = crypto.randomUUID();
    fixtures.companies.push(A, B);
    fixtures.objectives.push(OA, OB);
    fixtures.runs.push(RA, RB);

    try {
      await withTransaction(async (c) => {
        // Attempt `fn` inside a savepoint. Without the savepoint the first refusal aborts the
        // transaction and every later attempt returns 25P02, which would be scored as a refusal.
        let n = 0;
        const attempt = async (fn) => {
          const sp = `k1sp_${++n}`;
          await c.query(`SAVEPOINT ${sp}`);
          try { await fn(); await c.query(`RELEASE SAVEPOINT ${sp}`); return null; }
          catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${sp}`); return e; }
        };
        // A refusal counts ONLY if the server refused for a real constraint reason.
        const refusal = (label, e) => {
          if (!e) { bad(`${label} was ACCEPTED by production — isolation does not hold`); return; }
          if (e.code === '25P02') { bad(`${label} reported "transaction aborted" (25P02) — this check is BROKEN, not passing`, e.message); return; }
          if (!REAL_CONSTRAINT_CODES.has(e.code)) { bad(`${label} failed with ${e.code}, not a constraint violation — refused for an unrelated reason`, e.message); return; }
          ok(`${label} — refused by production (${e.code})`);
        };

        for (const id of [A, B]) {
          await c.query(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [id]);
        }
        for (const [oid, co] of [[OA, A], [OB, B]]) {
          await c.query(
            `INSERT INTO objectives (id, company_id, objective, priority, autonomy_tier, approval_policy, status, created_by)
             VALUES ($1,$2,'k1 production validation fixture','P3','none','all_consequential','active','validate-k1')`,
            [oid, co]
          );
        }
        const mkRun = (rid, co, oid) => c.query(
          `INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state, objective_id, company_id)
           VALUES ($1,$1,'k1-validation','internal','CREATED',$2,$3)`, [rid, oid, co]
        );
        await mkRun(RA, A, OA);
        await mkRun(RB, B, OB);
        ok('two fixture companies, objectives and runs created inside the rolled-back transaction');

        // ── the ruled refusals ──
        refusal('A objective + B run', await attempt(() => mkRun(crypto.randomUUID(), B, OA)));

        refusal('A run + B approval', await attempt(() => c.query(
          `INSERT INTO office_approvals (id, company_id, run_id, action_kind, action_payload, reason)
           VALUES ($1,$2,$3,'x','{}'::jsonb,'r')`, [`k1val-ap-${crypto.randomUUID()}`, A, RB])));

        refusal('A run + B exception', await attempt(() => c.query(
          `INSERT INTO office_exceptions (id, company_id, run_id, source, reason, severity)
           VALUES ($1,$2,$3,'s','r','high')`, [`k1val-ex-${crypto.randomUUID()}`, A, RB])));

        refusal('A run + B cost', await attempt(() => c.query(
          `INSERT INTO office_cost_ledger (company_id, run_id, provider, model, cost_usd)
           VALUES ($1,$2,'anthropic','m',1)`, [A, RB])));

        refusal('A run + B outcome', await attempt(() => c.query(
          `INSERT INTO office_outcomes (id, company_id, run_id, outcome)
           VALUES ($1,$2,$3,'achieved')`, [`k1val-oc-${crypto.randomUUID()}`, A, RB])));

        refusal('one-NULL composite-FK evasion (objective set, company NULL)',
          await attempt(() => mkRun(crypto.randomUUID(), null, OB)));

        refusal('new companyless run naming an objective',
          await attempt(() => mkRun(crypto.randomUUID(), null, OA)));

        refusal('new run with a company but no objective (symmetry)',
          await attempt(() => mkRun(crypto.randomUUID(), A, null)));

        refusal('kernel cost filed against a legacy (companyless) run',
          await attempt(async () => {
            const leg = crypto.randomUUID();
            await c.query(`INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state) VALUES ($1,$1,'k1-validation','internal','CREATED')`, [leg]);
            await c.query(`INSERT INTO office_cost_ledger (company_id, run_id, provider, model, cost_usd) VALUES ($1,$2,'anthropic','m',1)`, [A, leg]);
          }));

        // ── positive controls. Without these every refusal above is uninformative: a write that
        //    always fails satisfies all of them. ──
        console.log('\n5. Same-company positive controls\n');
        const posErrs = [];
        const pos = async (label, fn) => {
          const e = await attempt(fn);
          if (e) { posErrs.push(label); bad(`POSITIVE CONTROL ${label} FAILED — legitimate same-company work is broken`, `${e.code}: ${e.message}`); }
          else ok(`positive control: ${label} succeeds`);
        };
        await pos('A cost against A run', () => c.query(
          `INSERT INTO office_cost_ledger (company_id, run_id, objective_id, provider, model, cost_usd)
           VALUES ($1,$2,$3,'anthropic','m',0.01)`, [A, RA, OA]));
        await pos('A exception against A run', () => c.query(
          `INSERT INTO office_exceptions (id, company_id, run_id, objective_id, source, reason, severity, sla_hours)
           VALUES ($1,$2,$3,$4,'validate-k1','fixture','low',4)`, [`k1val-ex2-${crypto.randomUUID()}`, A, RA, OA]));
        await pos('A approval against A run', () => c.query(
          `INSERT INTO office_approvals (id, company_id, run_id, objective_id, action_kind, action_payload, reason)
           VALUES ($1,$2,$3,$4,'send','{}'::jsonb,'fixture')`, [`k1val-ap2-${crypto.randomUUID()}`, A, RA, OA]));
        await pos('A outcome against A run', () => c.query(
          `INSERT INTO office_outcomes (id, company_id, run_id, objective_id, outcome)
           VALUES ($1,$2,$3,$4,'achieved')`, [`k1val-oc2-${crypto.randomUUID()}`, A, RA, OA]));
        await pos('B work against B run (both directions, not just A)', () => c.query(
          `INSERT INTO office_cost_ledger (company_id, run_id, objective_id, provider, model, cost_usd)
           VALUES ($1,$2,$3,'anthropic','m',0.02)`, [B, RB, OB]));

        // Read scoping, against production rows.
        const seenByA = (await c.query(`SELECT id FROM objectives WHERE company_id = $1`, [A])).rows.map((r) => r.id);
        if (seenByA.includes(OB)) bad('company-scoped read returned the other company\'s objective');
        else if (!seenByA.includes(OA)) bad('company-scoped read could not see its own objective — the read is broken, not scoped');
        else ok('company-scoped read returns own objective and not the other company\'s');

        // Deliberate rollback. Nothing above survives.
        throw new Error(SENTINEL);
      });
      bad('the validation transaction COMMITTED — it was supposed to roll back');
    } catch (e) {
      if (e.message === SENTINEL) ok('validation transaction deliberately ROLLED BACK — nothing durable was written');
      else throw e;
    }

    // ══ 7. FIXTURE ABSENCE, BY EXACT ID ═══════════════════════════════════
    console.log('\n6. Fixture cleanup proof (by exact id — never "is the table empty")\n');
    const gone = async (table, col, list) => {
      const r = await query(`SELECT COUNT(*)::int n FROM ${table} WHERE ${col} = ANY($1)`, [list]);
      if (r.rows[0].n) bad(`${r.rows[0].n} of my fixture rows REMAIN in ${table}`);
      else ok(`${table}: all ${list.length} fixture id(s) absent`);
    };
    await gone('companies', 'id', fixtures.companies);
    await gone('objectives', 'id', fixtures.objectives);
    await gone('agent_runs', 'run_id', fixtures.runs);
    const strays = (await query(
      `SELECT (SELECT COUNT(*)::int FROM office_cost_ledger WHERE provider='anthropic' AND model='m' AND company_id = ANY($1)) AS c,
              (SELECT COUNT(*)::int FROM office_exceptions WHERE source='validate-k1') AS e,
              (SELECT COUNT(*)::int FROM objectives WHERE created_by='validate-k1') AS o`,
      [fixtures.companies]
    )).rows[0];
    if (strays.c || strays.e || strays.o) bad(`validation artefacts survived: cost=${strays.c} exceptions=${strays.e} objectives=${strays.o}`);
    else ok('no validation artefact of any kind survived the rollback');

    // ══ 8. HISTORICAL UNCHANGED AFTER VALIDATION ══════════════════════════
    const after = (await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE created_at < $1::timestamptz AND company_id IS NOT NULL)::int AS pre_attributed
         FROM agent_runs`, [CUTOVER]
    )).rows[0];
    if (after.total !== historical.total) bad(`agent_runs count changed during validation: ${historical.total} → ${after.total}`);
    else ok(`agent_runs count unchanged by validation (${after.total})`);
    if (after.pre_attributed !== 0) bad(`${after.pre_attributed} pre-cutover run(s) now carry a company — validation attributed historical ownership`);
    else ok('still ZERO pre-K1 runs attributed to any company');

  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  }

  console.log(fail
    ? `\nFAIL  ${fail} K1 production assertion(s) failed`
    : '\nPASS  K1 holds on production: cross-company kernel writes are refused by the database, '
      + 'legitimate same-company work succeeds, no historical row was attributed, nothing durable was written');
  process.exit(fail ? 1 : 0);
})();
