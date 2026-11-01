#!/usr/bin/env node
// ── K1 COMPANY ISOLATION, AGAINST A REAL POSTGRES ────────────────────────────
//
//   scripts/check-office-isolation-db.js  → exit 0 = cross-company work is refused BY THE
//                                           DATABASE, not by a rule somebody remembered
//
// ── WHY THIS CHECK CANNOT BE A UNIT TEST ─────────────────────────────────────
//
// The entire K1 claim is that isolation is a property of the DATA rather than of the query:
// composite foreign keys with MATCH FULL, plus a BEFORE INSERT trigger. Every one of those is
// a server-side object. A stubbed `query` would accept all eleven attacks below and report
// success, which is the precise failure the programme has already paid for — "a test fixture
// more permissive than production can certify code that cannot execute against production".
//
// So: two fixture companies in a real server, eleven adversarial proofs, six mutation controls.
//
// ── THE MUTATION CONTROLS ARE THE POINT ──────────────────────────────────────
//
// A passing isolation test proves nothing on its own: a test that asserts "the insert was
// refused" also passes when the insert was refused for an unrelated reason, and it keeps passing
// after somebody removes the constraint if the row was never insertable anyway. Each control
// below disables ONE real mechanism, proves the attack THEN SUCCEEDS, and restores it.
//
// M2 matters most. MATCH SIMPLE is the PostgreSQL DEFAULT for a composite foreign key, and under
// it the constraint passes if ANY column is NULL — so on a legacy-nullable company_id, pointing
// objective_id at another company's objective while leaving company_id NULL walks straight
// through. Without M2, a future migration that omits two words re-opens that hole and every
// other assertion in this file still passes.
//
// ── CLEANUP ──────────────────────────────────────────────────────────────────
//
// Fixtures are recorded by id as they are created and deleted by exactly those ids in a finally.
// Never by timestamp, never by pattern, never "recent". The post-condition asserted is MY ROWS
// ARE GONE — never that a table is empty, which is a statement that becomes false the moment the
// product is used and whose obvious fix is a wider DELETE.
//
// Needs a server: set OFFICE_PG_URL, or let it start a throwaway cluster if initdb is on PATH.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};

// ── GET A SERVER ────────────────────────────────────────────────────────────
const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/office-iso-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55993' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55993 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55993`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.OFFICE_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set OFFICE_PG_URL or install initdb)');
  console.log('SKIP  K1 isolation not executed against a server — this check needs one');
  process.exit(0);
}

const CTX_FILE = path.join(__dirname, '..', 'src', 'lib', 'office', 'context.js');
const SCOPE_FILE = path.join(__dirname, '..', 'src', 'lib', 'office', 'scope.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Reload a module and everything that depends on it, so a mutated file is actually the one under
// test. Without this the cached copy answers and the mutation control silently proves nothing.
function freshOffice() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('src', 'lib', 'office'))) delete require.cache[k];
  }
  return {
    context: require('../src/lib/office/context'),
    scope: require('../src/lib/office/scope'),
  };
}

// Did the server refuse? Returns the error, or null if the write went through.
async function refused(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);

  const ids = { companies: [], objectives: [], runs: [], exceptions: [], approvals: [], outcomes: [], costs: [] };
  const uid = (p) => `${p}-${crypto.randomUUID()}`;

  const { migrateRuns } = require('../src/lib/runs');
  const { migrateOffice, KERNEL_TABLES } = require('../src/lib/office/schema');

  // Insert a run directly: createRun() predates K1 and knows nothing about companies, which is
  // exactly why the trigger below has to be symmetric rather than blanket-NOT NULL.
  async function mkRun({ companyId, objectiveId }) {
    const runId = crypto.randomUUID();
    await q(
      `INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state, objective_id, company_id)
       VALUES ($1,$1,'check','internal','CREATED',$2,$3)`,
      [runId, objectiveId, companyId]
    );
    ids.runs.push(runId);
    return runId;
  }

  try {
    // ── 1. SCHEMA ────────────────────────────────────────────────────────────
    await migrateRuns(q);
    await migrateOffice(q);
    ok('migrateOffice applies against a real server (composite FKs with MATCH FULL)');
    await migrateOffice(q);
    ok('migrateOffice is idempotent — it runs on every boot');

    // The weld must actually be MATCH FULL. Asserting behaviour is not enough: a future migration
    // could drop to MATCH SIMPLE and most behavioural assertions would still pass.
    const fkRow = (await q(
      `SELECT confmatchtype FROM pg_constraint WHERE conname = 'fk_agent_runs_objective_company'`
    )).rows[0];
    if (!fkRow) bad('composite FK fk_agent_runs_objective_company is absent');
    else if (fkRow.confmatchtype !== 'f') bad(`composite FK is not MATCH FULL (confmatchtype=${fkRow.confmatchtype})`);
    else ok('composite FK on (objective_id, company_id) exists and is MATCH FULL');

    for (const t of KERNEL_TABLES.filter((x) => x !== 'objectives')) {
      const r = (await q(
        `SELECT a.attnotnull FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attname = 'company_id'`, [t]
      )).rows[0];
      if (!r) bad(`${t} has no company_id`);
      else if (!r.attnotnull) bad(`${t}.company_id is NULLABLE — kernel tables must require it from creation`);
      else ok(`${t}.company_id is NOT NULL from creation`);
    }

    // ── 2. TWO COMPANIES ─────────────────────────────────────────────────────
    const A = uid('co-a'), B = uid('co-b');
    for (const id of [A, B]) {
      await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$2,$3)`, [id, id, id]);
      ids.companies.push(id);
    }
    ok('two isolated fixture companies created');

    const OA = uid('obj-a'), OB = uid('obj-b');
    for (const [oid, co] of [[OA, A], [OB, B]]) {
      await q(
        `INSERT INTO objectives (id, company_id, objective, priority, autonomy_tier, approval_policy, status, created_by)
         VALUES ($1,$2,'fixture objective','P1','bounded','all_consequential','active','check')`,
        [oid, co]
      );
      ids.objectives.push(oid);
    }
    const RA = await mkRun({ companyId: A, objectiveId: OA });
    const RB = await mkRun({ companyId: B, objectiveId: OB });
    ok('one active objective and one run per company');

    const { context, scope } = freshOffice();
    const ctxA = await context.resolveCompanyContext({ runId: RA }, { query: q });
    const ctxB = await context.resolveCompanyContext({ runId: RB }, { query: q });
    if (ctxA.companyId !== A || ctxB.companyId !== B) bad('context resolution returned the wrong company');
    else ok('context resolves each run to its own company');

    // ── THE COMPANY IDENTIFIER IS IMMUTABLE ────────────────────────────────
    //
    // Found missing on 1 Nov: the foreign keys only refuse an id change ONCE SOMETHING REFERENCES
    // IT, so a just-created, unreferenced company had a freely mutable id — and that id is the
    // isolation boundary every composite FK depends on. Tested here, on a fixture, because the
    // probe that found it ran against PRODUCTION expecting a refusal that never came.
    const unref = uid('co-unref');
    await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [unref]);
    ids.companies.push(unref);
    const idErr = await refused(() => q(`UPDATE companies SET id = $2 WHERE id = $1`, [unref, `${unref}-moved`]));
    if (!idErr) {
      bad('an UNREFERENCED company id was changed — every composite FK depends on it being stable');
      ids.companies.push(`${unref}-moved`);
    } else ok(`an unreferenced company id cannot be changed (${idErr.code}) — not merely protected by being referenced`);
    const renamed = await refused(() => q(
      `UPDATE companies SET display_name = 'Renamed', slug = $2 WHERE id = $1`, [unref, `${unref}-slug`]));
    if (renamed) bad(`renaming a company was refused — the guard is too broad: ${renamed.message}`);
    else ok('display_name and slug remain changeable — only the identifier is frozen');

    // ── 3. P1 — A objective cannot execute as B ──────────────────────────────
    let e = await refused(() => mkRun({ companyId: B, objectiveId: OA }));
    if (!e) bad('P1 a run under company B ATTACHED to company A objective');
    else ok(`P1 A objective cannot execute as B — refused (${e.code || 'error'})`);

    // ── 4. P2 — A run cannot attach to B objective (the mirror) ──────────────
    e = await refused(() => mkRun({ companyId: A, objectiveId: OB }));
    if (!e) bad('P2 a run under company A ATTACHED to company B objective');
    else ok(`P2 A run cannot attach to B objective — refused (${e.code || 'error'})`);

    // ── 5. P3/P4/P5/P6 — kernel records cannot cross ────────────────────────
    // Each uses company A's context against company B's RUN. The (run_id, company_id) pair does
    // not exist in agent_runs, so the composite FK refuses it. Nothing in scope.js checks this.
    const crossers = [
      ['P5 budget', () => scope.recordCost(ctxA, { runId: RB, provider: 'anthropic', model: 'm', costUsd: 1, costKnown: true }, { query: q })],
      ['P3 approval', () => scope.requestApproval(ctxA, { id: uid('ap'), runId: RB, actionKind: 'x', actionPayload: {}, reason: 'r' }, { query: q })],
      ['P4 exception', () => scope.openException(ctxA, { id: uid('ex'), runId: RB, source: 's', reason: 'r', severity: 'high' }, { query: q })],
      ['P6 outcome', () => scope.recordOutcome(ctxA, { id: uid('oc'), runId: RB, outcome: 'achieved' }, { query: q })],
    ];
    for (const [label, attack] of crossers) {
      const err = await refused(attack);
      if (!err) bad(`${label} CROSSED — company A filed a record against company B's run`);
      else ok(`${label} cannot be filed against the other company's run — refused by the database`);
    }

    // And the legitimate version of each must work, or the refusals above prove nothing: a write
    // that always fails would pass every assertion in this section.
    const exA = uid('ex'), apA = uid('ap'), ocA = uid('oc');
    // costKnown is now REQUIRED by recordCost (K5 C1): a cost filed without it would be an
    // unmeasured call recorded as free, so the accessor refuses to guess.
    await scope.recordCost(ctxA, { runId: RA, provider: 'anthropic', model: 'm', tokensInput: 10, tokensOutput: 5, costUsd: 0.25, costKnown: true }, { query: q });
    const exRow = await scope.openException(ctxA, { id: exA, runId: RA, source: 'check', reason: 'fixture', severity: 'high', slaHours: 4 }, { query: q });
    ids.exceptions.push(exA);
    await scope.requestApproval(ctxA, { id: apA, runId: RA, actionKind: 'send', actionPayload: { to: 'x' }, reason: 'fixture' }, { query: q });
    ids.approvals.push(apA);
    await scope.recordOutcome(ctxA, { id: ocA, runId: RA, outcome: 'achieved', businessEffect: 'fixture' }, { query: q });
    ids.outcomes.push(ocA);
    if (exRow && exRow.status === 'open') ok('the legitimate same-company write of each record SUCCEEDS (the refusals above are specific, not blanket)');
    else bad('a legitimate same-company kernel write failed — every refusal above is uninformative');

    // ── 6. P7 — company-scoped reads do not return the other company's rows ──
    const objsA = await scope.listObjectives(ctxA, { query: q });
    if (objsA.some((o) => o.id === OB)) bad('P7 company A listed company B objective');
    else if (!objsA.some((o) => o.id === OA)) bad('P7 company A could not see its OWN objective — the read is broken, not scoped');
    else ok('P7 company-scoped reads return own rows and not the other company\'s');

    const exB = await scope.listOpenExceptions(ctxB, { query: q });
    if (exB.some((x) => x.id === exA)) bad('P7 company B listed company A exception');
    else ok('P7 the exception queue is company-scoped');

    const spendB = await scope.spendToday(ctxB, { query: q });
    if (Number(spendB.usd) !== 0) bad(`P7 company B sees company A spend (${spendB.usd})`);
    else ok('P7 spend is company-scoped — B sees 0 after A spent 0.25');
    const spendA = await scope.spendToday(ctxA, { query: q });
    if (Number(spendA.usd) <= 0) bad('P7 company A cannot see its own spend — the read is broken, not scoped');
    else ok(`P7 company A sees its own spend (${spendA.usd})`);

    // ── 7. P8 — changing a query parameter cannot cross the boundary ─────────
    const stolen = await scope.getObjective(ctxA, OB, { query: q });
    if (stolen) bad('P8 substituting the other company\'s objective id RETURNED IT');
    else ok('P8 substituting another company\'s id in a parameter returns nothing, not that row');

    const notMine = await scope.resolveException(ctxB, { id: exA, resolvedBy: 'b', resolution: 'stolen' }, { query: q });
    if (notMine) bad('P4 company B RESOLVED company A exception by id');
    else ok('P4 company B cannot resolve company A exception by guessing its id');

    // ── 8. P9 — an agent does not choose which company it acts for ──────────
    // The structural claim: there is no parameter through which a company can be supplied.
    const hostile = await context.resolveCompanyContext(
      { runId: RA, companyId: B, company_id: B, company: B }, { query: q }
    );
    if (hostile.companyId !== A) bad(`P9 agent-supplied company OVERRODE the execution context (got ${hostile.companyId})`);
    else ok('P9 agent-supplied company_id is not consulted — context came from the run');

    if (context.resolveCompanyContext.length > 2) bad('P9 resolveCompanyContext grew extra parameters — re-audit for a company argument');
    else ok('P9 resolveCompanyContext takes no company parameter (structural, not defensive)');

    // A hand-rolled look-alike context must be refused, since that is what an attacker builds.
    const forged = await refused(() => scope.listObjectives({ companyId: B }, { query: q }));
    if (!forged) bad('P9 a forged plain-object context was ACCEPTED by the accessor');
    else ok('P9 a forged (unfrozen) context is refused by assertContext');

    // ── 9. P10/P11 — legacy rows, and new kernel writes ─────────────────────
    const legacy = await mkRun({ companyId: null, objectiveId: null });
    ok('P10 a legacy run with no company is still permitted (history is not broken)');

    const noCtx = await refused(() => context.resolveCompanyContext({ runId: legacy }, { query: q }));
    if (!noCtx) bad('P10 a legacy run with no company RESOLVED to a context');
    else if (noCtx.code !== 'NO_COMPANY_CONTEXT') bad(`P10 legacy run failed for the wrong reason: ${noCtx.message}`);
    else ok('P10 a legacy run grants NO context — it cannot borrow a company');

    e = await refused(() => mkRun({ companyId: null, objectiveId: OA }));
    if (!e) bad('P11 a new run with an objective but NO company was accepted');
    else ok('P11 a new run naming an objective without a company is refused');

    e = await refused(() => mkRun({ companyId: A, objectiveId: null }));
    if (!e) bad('P11 a new run with a company but no objective was accepted (asymmetric)');
    else ok('P11 the requirement is symmetric — company without objective is refused too');

    // P12 — a both-NULL run is PERMITTED (P10), so the design's safety rests on it being INERT.
    // Contextlessness alone is not enough: a direct INSERT bypassing context.js must also fail,
    // or the legacy shape is a back door into the kernel. The pair (legacy run, company A) does
    // not exist in agent_runs, so every kernel FK refuses it.
    e = await refused(() => q(
      `INSERT INTO office_cost_ledger (company_id, run_id, provider, model, cost_usd)
       VALUES ($1,$2,'anthropic','m',1)`, [A, legacy]
    ));
    if (!e) bad('P12 a kernel cost row ATTACHED to a companyless legacy run — the legacy shape is a back door');
    else ok('P12 a companyless legacy run is inert: kernel records cannot attach to it even by direct INSERT');

    // ── 10. REGRESSION: EXISTING WRITERS, WITH K1 APPLIED ───────────────────
    // check-run-identity-db.js and check-run-canary-db.js build their own fixture and never apply
    // the office schema, so they prove existing writers survive WITHOUT the composite FK present.
    // Production will have it. The regression that actually matters is the REAL writer against a
    // database that has been migrated — anything less certifies code that cannot run in production.
    const { ledger } = require('../src/lib/run-ledger');
    const L = ledger({ query: q, onDurabilityFailure: () => {} });
    const legit = await L.createRun({ trigger: 'cron', product: 'internal', workflow: 'k1-regression' });
    if (legit && legit.runId) {
      ids.runs.push(legit.runId);
      ok('REGRESSION the real createRun() still creates a run with the K1 schema applied (no existing writer breaks)');
    } else {
      bad('REGRESSION the real createRun() failed with the K1 schema applied — an existing production writer is broken', JSON.stringify(legit));
    }

    // And the forward-compatibility boundary, asserted rather than assumed: createRun accepts an
    // objectiveId but has no company parameter, so it CANNOT create office work. That is correct
    // today (it means no existing caller can half-create kernel work) and it is the exact gap K4
    // adoption has to close. Recorded as a passing assertion so the day someone adds a company
    // parameter, this line tells them which design decision they are changing.
    const halfKernel = await refused(() =>
      L.createRun({ trigger: 'cron', product: 'internal', objectiveId: OA }));
    if (!halfKernel) bad('REGRESSION createRun() created a run naming an objective with NO company — the kernel can be half-entered');
    else ok('REGRESSION createRun() cannot create office work: it has no company parameter, so naming an objective is refused (the K4 gap, asserted not assumed)');

    // ── 11. MUTATION CONTROLS ───────────────────────────────────────────────
    console.log('  --    mutation controls: disable each mechanism, prove the attack then succeeds');

    // M1 — drop the composite FK. The cross-company attach must then succeed. MATCH FULL on this
    // one constraint is now the whole enforcement story for agent_runs (see schema.js), so this
    // control also establishes that there is no second mechanism quietly doing the work.
    await q(`ALTER TABLE agent_runs DROP CONSTRAINT fk_agent_runs_objective_company`);
    const leaked = await refused(() => mkRun({ companyId: A, objectiveId: OB }));
    if (leaked) bad('M1 with the composite FK DROPPED the cross-company run was still refused — the FK is not what is protecting us', leaked.message);
    else ok('M1 dropping the composite FK lets company A attach to company B objective — the FK is load-bearing');

    // M3 (here, because it shares M1's dropped state) — with the FK gone, BOTH mixed-NULL cases
    // are admitted. This is the control that removed the original company-required trigger: it
    // showed the trigger's condition was exactly MATCH FULL's condition, enforcing nothing extra.
    const mixedA = await refused(() => mkRun({ companyId: null, objectiveId: OB }));
    const mixedB = await refused(() => mkRun({ companyId: A, objectiveId: null }));
    if (mixedA || mixedB) bad('M3 with the FK dropped a mixed-NULL run was still refused — something else is enforcing this and is unaccounted for',
      (mixedA || mixedB).message);
    else ok('M3 with the FK dropped BOTH mixed-NULL shapes are admitted — MATCH FULL is the sole mechanism, and the removed trigger was redundant');

    // M2a — restore MATCH FULL: the one-NULL evasion must fail again, with no trigger present.
    await q(`ALTER TABLE agent_runs
               ADD CONSTRAINT fk_agent_runs_objective_company
               FOREIGN KEY (objective_id, company_id) REFERENCES objectives (id, company_id)
               MATCH FULL NOT VALID`);
    const evadeFull = await refused(() => mkRun({ companyId: null, objectiveId: OB }));
    if (!evadeFull) bad('M2a MATCH FULL did NOT refuse the objective-set/company-NULL evasion');
    else ok('M2a MATCH FULL alone refuses the one-NULL evasion — no trigger involved');

    // M2b — the same FK as MATCH SIMPLE (the PostgreSQL default). The evasion must now succeed.
    await q(`ALTER TABLE agent_runs DROP CONSTRAINT fk_agent_runs_objective_company`);
    await q(`ALTER TABLE agent_runs
               ADD CONSTRAINT fk_agent_runs_objective_company
               FOREIGN KEY (objective_id, company_id) REFERENCES objectives (id, company_id)
               MATCH SIMPLE NOT VALID`);
    const evadeSimple = await refused(() => mkRun({ companyId: null, objectiveId: OB }));
    if (evadeSimple) bad('M2b under MATCH SIMPLE the evasion was still refused — MATCH FULL may not be what blocks it', evadeSimple.message);
    else ok('M2b under MATCH SIMPLE (the DEFAULT) the one-NULL evasion SUCCEEDS — MATCH FULL is the clause doing the work');

    // Restore the real schema and re-prove.
    await q(`ALTER TABLE agent_runs DROP CONSTRAINT fk_agent_runs_objective_company`);
    await migrateOffice(q);
    const reFk = (await q(`SELECT confmatchtype FROM pg_constraint WHERE conname='fk_agent_runs_objective_company'`)).rows[0];
    if (!reFk || reFk.confmatchtype !== 'f') bad('restore failed — the MATCH FULL composite FK is not back in place');
    else ok('restore: the MATCH FULL composite FK is back');
    e = await refused(() => mkRun({ companyId: A, objectiveId: OB }));
    if (!e) bad('after restore the cross-company run was accepted');
    else ok('after restore the cross-company run is refused again');

    // M4 — let context.js accept a caller-supplied company. P9 must then fail.
    const ctxBefore = sha(CTX_FILE);
    const ctxSrc = fs.readFileSync(CTX_FILE, 'utf8');
    const ctxNeedle = `  return Object.freeze({
    companyId: row.company_id,`;
    if (!ctxSrc.includes(ctxNeedle)) {
      bad('M4 could not locate the context return in context.js — the mutation control is stale and proves nothing');
    } else {
      fs.writeFileSync(CTX_FILE, ctxSrc.replace(ctxNeedle, `  return Object.freeze({
    companyId: arguments[0].companyId || row.company_id,`));
      try {
        const mutated = freshOffice();
        const over = await mutated.context.resolveCompanyContext({ runId: RA, companyId: B }, { query: q });
        if (over.companyId === B) ok('M4 a context that reads a caller-supplied company DOES get overridden — P9 is testing the real behaviour');
        else bad('M4 the mutated context still ignored the supplied company — P9 may be passing for an unrelated reason');
      } finally {
        fs.writeFileSync(CTX_FILE, ctxSrc);
      }
    }
    if (sha(CTX_FILE) !== ctxBefore) bad('M4 context.js was NOT restored byte-for-byte');
    else ok('M4 context.js restored, verified by content hash');

    // M5 — drop the accessor's company predicate. P8 must then leak.
    const scopeBefore = sha(SCOPE_FILE);
    const scopeSrc = fs.readFileSync(SCOPE_FILE, 'utf8');
    const scopeNeedle = `      WHERE company_id = $1 AND id = $2\`,
    [ctx.companyId, objectiveId]`;
    if (!scopeSrc.includes(scopeNeedle)) {
      bad('M5 could not locate getObjective\'s predicate in scope.js — the mutation control is stale and proves nothing');
    } else {
      // Drop BOTH the predicate and its parameter. An earlier version removed only the predicate
      // and left $1 bound, which Postgres rejects with "could not determine data type of
      // parameter $1" — so the mutation errored instead of leaking, and the control proved
      // nothing while appearing to run.
      fs.writeFileSync(SCOPE_FILE, scopeSrc.replace(scopeNeedle, `      WHERE id = $1\`,
    [objectiveId]`));
      try {
        const mutated = freshOffice();
        const leak = await mutated.scope.getObjective(ctxA, OB, { query: q });
        if (leak) ok('M5 removing the company predicate leaks the other company\'s objective — the predicate is load-bearing');
        else bad('M5 the unscoped read returned nothing — P8 may be passing because the row is unreachable anyway');
      } finally {
        fs.writeFileSync(SCOPE_FILE, scopeSrc);
      }
    }
    if (sha(SCOPE_FILE) !== scopeBefore) bad('M5 scope.js was NOT restored byte-for-byte');
    else ok('M5 scope.js restored, verified by content hash');

    // Re-prove P8 against the restored file, so the suite does not end on a mutated module.
    const reFresh = freshOffice();
    const reStolen = await reFresh.scope.getObjective(ctxA, OB, { query: q });
    if (reStolen) bad('after restore P8 still leaks');
    else ok('after restore P8 holds again');

  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    // ── CLEANUP: only rows I created, by explicit id ───────────────────────
    try {
      for (const id of ids.outcomes) await q(`DELETE FROM office_outcomes WHERE id = $1`, [id]);
      for (const id of ids.approvals) await q(`DELETE FROM office_approvals WHERE id = $1`, [id]);
      for (const id of ids.exceptions) await q(`DELETE FROM office_exceptions WHERE id = $1`, [id]);
      for (const id of ids.runs) await q(`DELETE FROM office_cost_ledger WHERE run_id = $1`, [id]);

      // agent_run_events is append-only BY TRIGGER, which is the point of it — so removing my own
      // fixture events means disabling that trigger and PUTTING IT BACK, exactly as
      // check-run-identity-db.js does. The re-enable is asserted below rather than assumed: a
      // check that leaves the append-only guard off has quietly disarmed the evidence trail for
      // every run after it.
      await q(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`);
      try {
        for (const id of ids.runs) await q(`DELETE FROM agent_run_events WHERE run_id = $1`, [id]);
        for (const id of ids.runs) await q(`DELETE FROM agent_runs WHERE run_id = $1`, [id]);
      } finally {
        await q(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`);
      }
      const trgBack = (await q(
        `SELECT tgenabled FROM pg_trigger WHERE tgname = 'trg_agent_run_events_append_only'`
      )).rows[0];
      if (!trgBack || trgBack.tgenabled === 'D') bad('the append-only trigger was left DISABLED after cleanup');
      else ok('the append-only trigger on agent_run_events is enabled again after cleanup');
      for (const id of ids.objectives) await q(`DELETE FROM objectives WHERE id = $1`, [id]);
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]);

      // Assert MY FIXTURES ARE GONE — never that a table is empty.
      const leaks = [];
      const mine = async (table, col, list) => {
        if (!list.length) return;
        const r = await q(`SELECT COUNT(*)::int n FROM ${table} WHERE ${col} = ANY($1)`, [list]);
        if (r.rows[0].n) leaks.push(`${table}: ${r.rows[0].n} of my rows remain`);
      };
      await mine('companies', 'id', ids.companies);
      await mine('objectives', 'id', ids.objectives);
      await mine('agent_runs', 'run_id', ids.runs);
      await mine('office_exceptions', 'id', ids.exceptions);
      await mine('office_approvals', 'id', ids.approvals);
      await mine('office_outcomes', 'id', ids.outcomes);
      if (leaks.length) bad('fixture cleanup leaked', leaks.join('\n'));
      else ok('cleanup: every fixture row I created is gone (by id)');
    } catch (e) {
      bad('cleanup failed', e.message);
    }
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail ? `\nFAIL  ${fail} K1 isolation assertion(s) failed` : '\nPASS  K1 company isolation refused every cross-company attack, and each mechanism is load-bearing');
  process.exit(fail ? 1 : 0);
})();
