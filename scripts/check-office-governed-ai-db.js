#!/usr/bin/env node
// ── K5/K6 + G + H + I + J: THE GOVERNED VERTICAL SLICE ──────────────────────
//
//   scripts/check-office-governed-ai-db.js → exit 0 = the governed chain holds
//
// CEO objective → Executive Agent → governed run → bounded AI → usage/cost evidence →
// RFQ identity authority → blocking approval → outcome → provenance.
//
// ── THE FOUR CLAIMS MOST WORTH DISBELIEVING ─────────────────────────────────
//
// 1. UNKNOWN COST IS NOT ZERO, at every layer. Fixing costOf() alone would have moved the lie
//    down a level: office_cost_ledger.cost_usd was NOT NULL, so an unmeasurable call could only
//    be filed as $0.00. Proven here at the function, the row, the daily total and the provenance.
//
// 2. THE AI CANNOT CHANGE CHEMICAL IDENTITY. The prompt instructs the model not to invent figures;
//    an instruction is not a control. A model that writes a different CAS into the prose has
//    changed the identity of a message to three suppliers — the 21 July failure — and every
//    upstream guard would still pass. The generated text is contained, and the STALE FILED CAS is
//    refused BY NAME.
//
// 3. APPROVAL BLOCKS BEFORE THE ACTION. The pre-existing queue sends and then enqueues. Here
//    release() is the only route to the payload, it refuses anything not approved, and the payload
//    is immutable so what a human read is what executes.
//
// 4. AN UNACCOUNTED AI CALL YIELDS NO USABLE TEXT. If cost evidence cannot be persisted the output
//    is withheld, because an unaccounted call whose text is still usable is a call outside the
//    budget, and a budget with a bypass is not a budget.
//
// No real provider is contacted: global fetch is stubbed so the never-responds and no-usage cases
// are reachable at all. Fixtures are deleted by explicit id; the post-condition is "my fixtures
// are gone", never "the table is empty".
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
const note = (m) => console.log(`  --    ${m}`);

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/office-k56-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55990' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55990 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55990&sslmode=disable`;
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
  console.log('SKIP  governed-AI slice not executed against a server — this check needs one');
  process.exit(0);
}
process.env.DATABASE_URL = url;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'PLACEHOLDER-test-key';

// ── THE PROVIDER STUB ───────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let mode = 'normal';
let lastBody = null;
function okResp(text, usage) {
  return {
    ok: true, status: 200,
    json: async () => ({ content: [{ type: 'text', text }], usage }),
    text: async () => '',
  };
}
globalThis.fetch = async (u, opts) => {
  lastBody = opts && opts.body ? JSON.parse(opts.body) : null;
  if (mode === 'hang') {
    // Never resolves on its own. Rejects only when the AbortController fires, which is the
    // behaviour under test.
    return new Promise((_resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      }
    });
  }
  if (mode === 'no-usage') return okResp('Dear supplier, we would like to request a quotation.', null);
  if (mode === 'http-500') return { ok: false, status: 500, text: async () => 'upstream exploded' };
  if (mode === 'wrong-cas') return okResp('Please quote on this material, CAS 36282-47-0, 25kg.', { input_tokens: 100, output_tokens: 50 });
  if (mode === 'invents-cas') return okResp('Please quote CAS 50-78-2 for this material.', { input_tokens: 100, output_tokens: 50 });
  return okResp('Dear supplier,\n\nAbiozen is sourcing this molecule for its US customers.\n\nPalash Das', { input_tokens: 1000, output_tokens: 500 });
};

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };

  const ids = { companies: [], objectives: [], runs: [], approvals: [] };
  const { migrateRuns } = require('../src/lib/runs');
  const { migrateOffice } = require('../src/lib/office/schema');
  const llm = require('../src/lib/llm');
  const scope = require('../src/lib/office/scope');
  const ai = require('../src/lib/office/ai');
  const approval = require('../src/lib/office/approval');
  const budget = require('../src/lib/office/budget');
  const rfq = require('../src/lib/office/procurement-rfq');
  const { beginObjectiveRun } = require('../src/lib/office/run');
  const { ledger } = require('../src/lib/run-ledger');

  try {
    await migrateRuns(q);
    await migrateOffice(q);
    await require('../src/lib/autonomy').migrateAutonomy(q);
    ok('schema applied (runs + office + autonomy)');

    // ══ SETUP: a CEO objective and a governed run ═══════════════════════════
    const A = `k56-co-${crypto.randomUUID()}`;
    await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [A]);
    ids.companies.push(A);
    const B = `k56-cob-${crypto.randomUUID()}`;
    await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [B]);
    ids.companies.push(B);

    const OA = `k56-obj-${crypto.randomUUID()}`;
    const created = await scope.createObjective({
      id: OA, companyId: A, objective: 'Source Tramadol Hydrochloride for US customers',
      priority: 'P1', kpiMetric: 'suppliers_quoted', kpiTarget: 3, deadline: '2026-12-31',
      budgetUsd: 100, autonomyTier: 'supervised', approvalPolicy: 'all_consequential',
      createdBy: 'ceo',
    }, deps);
    ids.objectives.push(OA);
    const ctxA0 = Object.freeze({ companyId: A, objectiveId: OA, runId: null });
    await scope.setObjectiveStatus(ctxA0, { id: OA, status: 'active' }, deps);
    ok(`CEO objective created and activated (${created.company_id === A ? 'company fixed' : 'WRONG COMPANY'})`);

    const started = await beginObjectiveRun({
      objectiveId: OA, trigger: 'office', workflow: rfq.WORKFLOW, agent: rfq.AGENT,
      maxRuntimeMinutes: 15,
    }, deps);
    if (!started.runId) { bad('could not begin a governed run', JSON.stringify(started)); throw new Error('setup'); }
    ids.runs.push(started.runId);
    const ctx = started.context;
    const L = ledger({ query: q, onDurabilityFailure: () => {} });
    await L.startRun(ctx.runId);
    ok('governed run opened against the objective, company derived from it');

    // ══ C4: CAPABILITY ALIASES, NO PROVIDER SHAPES LEAKING ══════════════════
    mode = 'normal';
    let r = await ai.governedCall(ctx, { capability: 'fast', prompt: 'hello', maxTokens: 50,
      agent: 'test-agent', workflow: 'test-wf' }, deps);
    if (!r.ok) bad(`a normal governed call failed: ${r.error}`);
    else ok('C4 a governed call succeeds through the capability alias');
    if (lastBody && lastBody.model !== llm.MODEL_ALIASES.fast) {
      bad(`the alias did not resolve on the wire (sent "${lastBody && lastBody.model}")`);
    } else ok(`C4 "fast" resolved to the literal pin on the wire (${llm.MODEL_ALIASES.fast})`);
    if (r.model !== llm.MODEL_ALIASES.fast) bad('the literal model id is not returned — a past decision would be inexplicable');
    else ok('C4 the literal model id comes back in the result, so a past decision stays explicable');
    if (r.usage && ('input_tokens' in r.usage || 'output_tokens' in r.usage)) {
      bad('provider wire field names LEAKED into the kernel result (input_tokens/output_tokens)');
    } else if (!r.usage || r.usage.inputTokens !== 1000) {
      bad(`usage was not normalized to kernel field names: ${JSON.stringify(r.usage)}`);
    } else ok('C4 usage is normalized to { inputTokens, outputTokens } — no provider shape leaks');
    if (r.provider !== 'anthropic') bad('the provider is not reported');
    else ok('C4 the selected provider is reported, not assumed');

    // ══ C3: FULL ATTRIBUTION, PERSISTED ════════════════════════════════════
    const costRow = (await q(
      `SELECT company_id, run_id, objective_id, provider, model, agent, workflow,
              tokens_input, tokens_output, cost_usd, cost_known
         FROM office_cost_ledger WHERE id = $1`, [r.cost_row_id]
    )).rows[0];
    if (!costRow) bad('C3 no cost row was persisted for a successful governed call');
    else {
      const missing = [];
      if (costRow.company_id !== A) missing.push('company');
      if (costRow.objective_id !== OA) missing.push('objective');
      if (costRow.run_id !== ctx.runId) missing.push('run');
      if (costRow.workflow !== 'test-wf') missing.push('workflow');
      if (costRow.agent !== 'test-agent') missing.push('agent');
      if (costRow.provider !== 'anthropic') missing.push('provider');
      if (!costRow.model) missing.push('model');
      if (costRow.tokens_input !== 1000 || costRow.tokens_output !== 500) missing.push('usage');
      if (costRow.cost_known !== true) missing.push('cost_known');
      if (missing.length) bad(`C3 attribution incomplete: ${missing.join(', ')}`, JSON.stringify(costRow));
      else ok('C3 every ruled dimension is persisted: company, objective, run, workflow, agent, provider, model, usage, cost');
    }

    // ══ C1: UNKNOWN COST IS NOT ZERO — AT EVERY LAYER ══════════════════════
    // (a) the function
    const u = llm.costOf(null, 'claude-haiku-4-5-20251001');
    if (u.costUsd !== null || u.costKnown !== false) bad('C1 costOf(null) is not UNKNOWN', JSON.stringify(u));
    else ok('C1 (function) absent usage → costUsd null, costKnown false');
    const z = llm.costOf({ input_tokens: 0, output_tokens: 0 }, 'claude-haiku-4-5-20251001');
    if (z.costUsd !== 0 || z.costKnown !== true) bad('C1 a REAL zero is not reported as known-zero');
    else ok('C1 a real zero stays distinguishable from an unknown');

    // (b) the governed call and the row
    mode = 'no-usage';
    const un = await ai.governedCall(ctx, { capability: 'fast', prompt: 'x', maxTokens: 50,
      agent: 'test-agent', workflow: 'unknown-wf' }, deps);
    if (!un.ok) bad(`C1 a successful call with no usage was treated as a failure: ${un.error}`);
    else if (un.costKnown !== false || un.costUsd !== null) bad(`C1 unknown cost leaked as a number: ${JSON.stringify({ c: un.costUsd, k: un.costKnown })}`);
    else ok('C1 (call) a successful response with no usage returns cost UNKNOWN, never 0');
    const unRow = (await q(`SELECT cost_usd, cost_known FROM office_cost_ledger WHERE id=$1`, [un.cost_row_id])).rows[0];
    if (!unRow) bad('C1 the unmeasured call was not recorded at all — it would be invisible to a budget');
    else if (unRow.cost_known !== false || unRow.cost_usd !== null) bad(`C1 (row) unknown stored as ${JSON.stringify(unRow)}`);
    else ok('C1 (row) the unmeasured call is STORED as unknown — cost_usd NULL, cost_known false');

    // (c) the daily total
    const spend = await scope.spendToday(ctx, deps);
    if (Number(spend.unknown_calls) < 1) bad('C1 (total) spendToday does not count unmeasured calls');
    else if (Number(spend.usd) <= 0) bad('C1 (total) measured spend disappeared');
    else ok(`C1 (total) spendToday separates measured $${Number(spend.usd).toFixed(6)} from ${spend.unknown_calls} unmeasured call(s)`);

    // (d) the database refuses an incoherent pair
    let e = null;
    try {
      await q(`INSERT INTO office_cost_ledger (company_id, run_id, provider, model, cost_usd, cost_known)
               VALUES ($1,$2,'anthropic','m',NULL,TRUE)`, [A, ctx.runId]);
    } catch (err) { e = err; }
    if (!e) bad('C1 a row claiming a KNOWN cost with no cost was accepted');
    else ok(`C1 (constraint) the database refuses "known cost" with no cost (${e.code})`);
    e = null;
    try {
      await q(`INSERT INTO office_cost_ledger (company_id, run_id, provider, model, cost_usd, cost_known)
               VALUES ($1,$2,'anthropic','m',1.5,FALSE)`, [A, ctx.runId]);
    } catch (err) { e = err; }
    if (!e) bad('C1 a row carrying a cost while claiming not to know it was accepted');
    else ok('C1 (constraint) the database refuses a cost that claims to be unknown');

    // (e) recordCost refuses an implicit costKnown
    e = null;
    try { await scope.recordCost(ctx, { runId: ctx.runId, provider: 'anthropic', model: 'm', costUsd: 1 }, deps); }
    catch (err) { e = err; }
    if (!e) bad('C1 recordCost accepted a call with no explicit costKnown — a forgotten cost would file as free');
    else ok('C1 recordCost requires an EXPLICIT costKnown rather than inferring it');

    // ══ C2: BOUNDED INVOCATION ═════════════════════════════════════════════
    note('C2: the stubbed provider never responds; only the AbortController can end the call');
    mode = 'hang';
    const t0 = Date.now();
    const hung = await ai.governedCall(ctx, { capability: 'fast', prompt: 'x', maxTokens: 50,
      timeoutMs: 1500, agent: 'test-agent', workflow: 'timeout-wf' }, deps);
    const elapsed = Date.now() - t0;
    if (hung.ok) bad('C2 a never-responding provider produced a successful result');
    else if (!hung.timedOut) bad(`C2 the failure was not reported as a timeout: ${hung.error}`);
    else if (elapsed > 6000) bad(`C2 the abort took ${elapsed}ms — not bounded by the 1500ms ceiling`);
    else ok(`C2 a never-responding provider aborts in ${elapsed}ms (bound 1500ms)`);
    if (hung.costKnown !== false) bad('C2 a timed-out call claims a KNOWN cost — tokens may have been consumed');
    else ok('C2 a timed-out call records cost as UNKNOWN, not zero');
    if (hung.text !== null) bad('C2 a timed-out call returned text');
    else ok('C2 no text is returned from an absent provider result');
    const hungRow = (await q(
      `SELECT cost_known FROM office_cost_ledger WHERE run_id=$1 AND workflow='timeout-wf'`, [ctx.runId]
    )).rows[0];
    if (!hungRow) bad('C2 the timed-out call left NO durable evidence');
    else ok('C2 the timeout is durable evidence in the cost ledger, not just a log line');

    // No consequential downstream action from an absent provider result.
    const approvedMol = {
      molecule_name: 'Tramadol Hydrochloride', cas_number: '36282-47-0',
      target_quantity: '25kg', target_purity: '99%', gmp_required: 0,
      __approvedByDecision: 'decision-fixture-1',
    };
    const supplier = { id: 'sup-1', name: 'Laurus Labs', contact_name: 'Dr Rao', contact_email: 'x@example.invalid' };
    const timedOutRender = await rfq.renderGovernedRFQ(ctx, { approvedMol, supplier, rfqId: 'rfq-1' }, deps);
    if (timedOutRender.ok || timedOutRender.body !== null) bad('C2 a sendable RFQ was produced from a timed-out AI call');
    else ok(`C2 no consequential artefact is produced from an absent provider result (${timedOutRender.refusal})`);

    // Normal response → no regression.
    mode = 'normal';
    const normal = await ai.governedCall(ctx, { capability: 'fast', prompt: 'x', maxTokens: 50 }, deps);
    if (!normal.ok || !normal.text) bad('C2 a normal response regressed after adding the timeout');
    else ok('C2 a normal response still succeeds — the timeout is not a regression');
    const bounded = llm.boundedTimeout;
    if (bounded(0) !== llm.DEFAULT_LLM_TIMEOUT_MS || bounded(Infinity) !== llm.DEFAULT_LLM_TIMEOUT_MS) {
      bad('C2 "unbounded" is expressible — 0 or Infinity did not resolve to the default');
    } else ok('C2 unbounded is not expressible: 0, negative and Infinity all resolve to the default bound');

    // ══ C3 FAIL-CLOSED: NO ACCOUNTING, NO TEXT ═════════════════════════════
    const brokenDeps = { query: async (t, p) => {
      if (/INSERT INTO office_cost_ledger/.test(t)) throw new Error('simulated accounting outage');
      return q(t, p);
    } };
    const unaccounted = await ai.governedCall(ctx, { capability: 'fast', prompt: 'x', maxTokens: 50 }, brokenDeps);
    if (unaccounted.ok) bad('C3 an unaccounted AI call reported success');
    else if (unaccounted.accounted !== false) bad('C3 the accounting failure was not flagged');
    else if (unaccounted.text !== null) bad('C3 TEXT WAS RETURNED for a call that could not be accounted — a budget bypass');
    else ok('C3 an AI call whose cost cannot be persisted withholds its text and reports accounted:false');

    // ══ G: THE AI MAY NOT CHANGE CHEMICAL IDENTITY ═════════════════════════
    mode = 'normal';
    const good = await rfq.renderGovernedRFQ(ctx, { approvedMol, supplier, rfqId: 'rfq-1' }, deps);
    if (!good.ok) bad(`G a compliant generation was refused: ${good.refusal} ${good.detail || ''}`);
    else if (good.subject !== 'RFQ — Tramadol Hydrochloride (36282-47-0) — Abiozen LLC') {
      bad(`G the subject was not built from approved facts: ${good.subject}`);
    } else ok('G a compliant RFQ renders, with the subject built from APPROVED facts');

    // The 21 July failure: the model echoes the stale FILED CAS.
    mode = 'wrong-cas';
    const stale = await rfq.renderGovernedRFQ(ctx, {
      approvedMol: { ...approvedMol, cas_number: '27203-92-5' }, supplier, rfqId: 'rfq-1',
      filedCas: '36282-47-0',
    }, deps);
    if (stale.ok) bad('G the model inserted the stale FILED CAS and the RFQ was still sendable');
    else if (stale.refusal !== 'ai_contradicted_approved_identity') bad(`G refused for the wrong reason: ${stale.refusal}`);
    else if (!/FILED CAS/.test(stale.detail)) bad(`G the refusal does not name the stale filed CAS: ${stale.detail}`);
    else ok('G the stale FILED CAS in generated prose is refused BY NAME (the 21 July failure mode)');

    // K7 LIFECYCLE: the refusal must reach a human, not vanish into a return value. A model that
    // attempted to state a refused chemical identity is exactly what somebody has to see.
    if (!stale.exception_id) bad('H/K7 the identity refusal was NOT queued — nobody would learn the model tried');
    else {
      const exRow = (await q(
        `SELECT company_id, objective_id, run_id, source, severity, status, sla_hours, reason, created_at
           FROM office_exceptions WHERE id = $1`, [stale.exception_id]
      )).rows[0];
      if (!exRow) bad('H/K7 the exception id was returned but no row exists');
      else {
        const gaps = [];
        if (exRow.company_id !== A) gaps.push('company');
        if (exRow.objective_id !== OA) gaps.push('objective');
        if (exRow.run_id !== ctx.runId) gaps.push('run');
        if (!exRow.reason) gaps.push('reason');
        if (exRow.severity !== 'critical') gaps.push('severity');
        if (exRow.status !== 'open') gaps.push('status');
        if (!exRow.sla_hours) gaps.push('sla');
        if (!exRow.created_at) gaps.push('age');
        if (gaps.length) bad(`H/K7 the exception is missing ruled fields: ${gaps.join(', ')}`);
        else ok('H/K7 the identity refusal is queued as a CRITICAL exception with company, objective, run, reason, severity, status, SLA and age');
      }
      // Acknowledgment and resolution complete the lifecycle.
      const listed = await scope.listOpenExceptions(ctx, deps);
      const mineEx = listed.find((x) => x.id === stale.exception_id);
      if (!mineEx) bad('H/K7 the exception is not in the open queue');
      else if (typeof mineEx.age_hours !== 'number' && mineEx.age_hours === undefined) bad('H/K7 the queue does not expose age');
      else ok('H/K7 the exception appears in the company-scoped open queue with an age');
      const resolved = await scope.resolveException(ctx, { id: stale.exception_id,
        resolvedBy: 'naresh', resolution: 'reviewed: model output refused correctly, no send occurred' }, deps);
      if (!resolved || resolved.status !== 'resolved') bad('H/K7 the exception could not be resolved');
      else ok('H/K7 the exception can be resolved by a human, closing the lifecycle');
      const stillOpen = (await scope.listOpenExceptions(ctx, deps)).some((x) => x.id === stale.exception_id);
      if (stillOpen) bad('H/K7 a resolved exception is still in the open queue');
      else ok('H/K7 a resolved exception leaves the open queue');
    }

    // A CAS the model invented from nowhere.
    mode = 'invents-cas';
    const invented = await rfq.renderGovernedRFQ(ctx, { approvedMol, supplier, rfqId: 'rfq-1' }, deps);
    if (invented.ok) bad('G the model invented a CAS and the RFQ was still sendable');
    else ok(`G an invented CAS in generated prose is refused (${invented.refusal})`);

    // No CAS approved → the model may not supply one.
    const noCas = await rfq.renderGovernedRFQ(ctx, {
      approvedMol: { ...approvedMol, cas_number: null }, supplier, rfqId: 'rfq-1',
    }, deps);
    if (noCas.ok) bad('G the model supplied a CAS the identity decision declined to approve');
    else ok('G when NO CAS was approved, a CAS in the prose is refused');

    // Unapproved identity facts cannot be rendered at all.
    const unapproved = await rfq.renderGovernedRFQ(ctx, {
      approvedMol: { molecule_name: 'X', cas_number: '1' }, supplier, rfqId: 'rfq-1',
    }, deps);
    if (unapproved.ok) bad('G raw RFQ fields were rendered without an identity decision');
    else ok(`G identity facts without an approval decision cannot be rendered (${unapproved.refusal})`);

    // The containment function itself, directly — pure and exhaustively checkable.
    if (rfq.identityContainment('no numbers here', { approvedCas: '36282-47-0' }) !== null) bad('G prose with no CAS was refused');
    else ok('G prose containing no registry number is permitted');
    if (rfq.identityContainment('CAS 36282-47-0 confirmed', { approvedCas: '36282-47-0' }) !== null) bad('G the APPROVED CAS was refused');
    else ok('G the approved CAS is permitted in the prose');

    // ══ H: APPROVAL BLOCKS BEFORE THE ACTION ═══════════════════════════════
    mode = 'normal';
    const prepared = await approval.prepare(ctx, {
      actionKind: 'send_rfq_email',
      actionPayload: { subject: good.subject, body: good.body, supplier_id: supplier.id },
      reason: 'supervised autonomy tier: a supplier email requires human approval',
      ownerUserId: 'palash',
    }, deps);
    ids.approvals.push(prepared.approvalId);
    if (prepared.status !== 'pending') bad(`H a prepared action is not pending: ${prepared.status}`);
    else ok('H prepare() records the action as pending and performs nothing');

    // consequential:false ISOLATES the ordering assertions. This run deliberately carries
    // unmeasured AI calls from the C1 section, so the fail-closed cost gate would refuse first and
    // mask whether approval ordering works at all. The gate itself — and that it DEFAULTS to
    // strict — is proven in §9 below on this same run.
    const mech = { consequential: false };
    let rel = await approval.release(ctx, { approvalId: prepared.approvalId, releasedBy: 'agent', ...mech }, deps);
    if (rel.released) bad('H a PENDING approval was released — approval does not block the action');
    else if (rel.reason !== 'not_approved') bad(`H refused for the wrong reason: ${rel.reason}`);
    else ok('H release() refuses a pending approval — the action cannot happen first');

    // The payload a human read must be the payload that executes.
    e = null;
    try {
      await q(`UPDATE office_approvals SET action_payload = $2::jsonb WHERE id = $1`,
        [prepared.approvalId, JSON.stringify({ subject: 'substituted', body: 'different email' })]);
    } catch (err) { e = err; }
    if (!e) bad('H the approval payload was SUBSTITUTED after creation — what was approved is not what releases');
    else ok(`H the approval payload is immutable after creation (${e.code})`);
    e = null;
    try { await q(`UPDATE office_approvals SET action_kind = 'send_payment' WHERE id = $1`, [prepared.approvalId]); }
    catch (err) { e = err; }
    if (!e) bad('H action_kind was changed — approving a draft would become permission to pay');
    else ok('H action_kind is immutable: approving one action is not approving another');

    // A human decides, company-scoped.
    const ctxB = Object.freeze({ companyId: B, objectiveId: null, runId: null });
    if (await scope.decideApproval(ctxB, { id: prepared.approvalId, decision: 'approved', resolvedBy: 'intruder' }, deps)) {
      bad('H company B approved company A action');
    } else ok('H company B cannot approve company A action');

    const decided = await scope.decideApproval(ctx, { id: prepared.approvalId, decision: 'approved', resolvedBy: 'naresh' }, deps);
    if (!decided || decided.status !== 'approved') bad('H the human approval did not take');
    else ok('H a human approves, scoped to their own company');

    if ((await approval.release(ctxB, { approvalId: prepared.approvalId, releasedBy: 'intruder', ...mech }, deps)).released) {
      bad('H company B released company A approved action');
    } else ok('H company B cannot release company A approved action');

    rel = await approval.release(ctx, { approvalId: prepared.approvalId, releasedBy: 'agent', ...mech }, deps);
    if (!rel.released) bad(`H an approved action could not be released: ${rel.reason}`);
    else if (rel.actionPayload.body !== good.body) bad('H the released payload is not the approved one');
    else ok('H release() returns the APPROVED payload, and only after approval');

    const again = await approval.release(ctx, { approvalId: prepared.approvalId, releasedBy: 'agent', ...mech }, deps);
    if (again.released) bad('H the same approval released TWICE — one human decision authorised two sends');
    else ok(`H a second release of the same approval is refused (${again.reason})`);

    // ══ I: THE BUDGET MECHANISM (built, not activated) ══════════════════════
    if (budget.tierFor(0) !== 'ok' || budget.tierFor(0.5) !== 'informational'
        || budget.tierFor(0.75) !== 'warning' || budget.tierFor(0.9) !== 'critical'
        || budget.tierFor(1.0) !== 'exceeded') {
      bad('I the 50/75/90/100 thresholds are wrong');
    } else ok('I thresholds: 50% informational, 75% warning, 90% critical, 100% exceeded');

    const assessed = await budget.assess(ctx, {}, deps);
    if (assessed.capUsd !== 100) bad('I the daily cap is not $100');
    else if (assessed.unknownCalls < 1) bad('I unmeasured calls are not surfaced in the assessment');
    else if (assessed.confident !== false) bad('I the assessment claims confidence despite unmeasured calls');
    else if (!assessed.lowerBound) bad('I measured spend is not labelled a lower bound');
    else ok(`I with ${assessed.unknownCalls} unmeasured call(s) the assessment is NOT confident and spend is a LOWER BOUND`);
    if (assessed.tier === assessed.measuredTier) {
      bad('I unmeasured spend did not raise the tier — it would be treated as free');
    } else ok(`I unmeasured spend RAISES the tier (${assessed.measuredTier} → ${assessed.tier}) without inventing a dollar figure`);

    for (const criticality of budget.NEVER_REFUSED) {
      const en = await budget.enforce(ctx, { criticality, capUsd: 0.000001 }, deps);
      if (!en.allow) bad(`I ${criticality} work was refused by the budget — an accounting limit became an outage`);
    }
    ok(`I ${budget.NEVER_REFUSED.join(', ')} work is never refused by a spend limit`);

    const over = await budget.enforce(ctx, { criticality: 'routine', capUsd: 0.000001 }, deps);
    if (over.allow) bad('I routine autonomous AI was permitted over the cap');
    else ok('I routine autonomous AI is refused at 100% of the cap');

    const strict = await budget.enforce(ctx, { criticality: 'routine', capUsd: 1e9, refuseOnUnmeasured: true }, deps);
    if (strict.allow) bad('I refuseOnUnmeasured did not refuse despite unmeasured calls');
    else ok('I refuseOnUnmeasured refuses when spend cannot be PROVEN under the cap (knob, default off)');
    const lenient = await budget.enforce(ctx, { criticality: 'routine', capUsd: 1e9 }, deps);
    if (!lenient.allow) bad('I the default policy refused on unmeasured spend without being asked to');
    else ok('I by default unmeasured spend raises the tier but does not refuse — activation is yours');

    // ══ J: PROVENANCE ═════════════════════════════════════════════════════
    const outcomeId = `oc-${ctx.runId}`;
    await scope.recordOutcome(ctx, { id: outcomeId, runId: ctx.runId, outcome: 'achieved',
      businessEffect: 'RFQ released to supplier', effectRef: `supplier_outreach_log:${supplier.id}` }, deps);
    await L.finish(ctx.runId, { state: 'SUCCEEDED' });

    const prov = await scope.provenance(ctx, ctx.runId, deps);
    if (!prov) bad('J provenance returned nothing for a governed run');
    else {
      const answers = {
        'which CEO objective': prov.objective && prov.objective.id === OA,
        'what the AI did': prov.ai_calls.length > 0 && prov.ai_calls.every((c) => c.provider && c.model),
        'what it cost': prov.ai_cost.measured_calls > 0,
        'unmeasured calls surfaced': prov.ai_cost.unmeasured_calls > 0 && prov.ai_cost.lower_bound === true,
        'who approved it': prov.approvals.some((x) => x.resolved_by === 'naresh' && x.released_at),
        'what happened': prov.outcomes.some((x) => x.outcome === 'achieved' && x.effect_ref),
      };
      const unanswered = Object.entries(answers).filter(([, v]) => !v).map(([k]) => k);
      if (unanswered.length) bad(`J provenance cannot answer: ${unanswered.join('; ')}`, JSON.stringify(prov.ai_cost));
      else ok('J provenance answers all of: which objective, what the AI did, what it cost, who approved it, what happened');
      if (!prov.ai_cost.lower_bound) bad('J provenance reports a total cost as if it were complete');
      else ok('J provenance reports AI cost as a LOWER BOUND while any call is unmeasured');
    }
    const provB = await scope.provenance(ctxB, ctx.runId, deps);
    if (provB) bad('J company B read company A provenance');
    else ok('J provenance is company-scoped');

    // ══ RULING §5: MODEL FAILURE SEMANTICS ═════════════════════════════════
    note('§5: a configuration defect must not hide as a transient provider failure');
    const cls = ai.classifyProviderFailure;
    const cases = [
      [{ error: 'Claude 404: model not found', status: 404 }, 'model_invalid'],
      [{ error: 'Claude 400: invalid model id', status: 400 }, 'model_invalid'],
      [{ error: 'Claude 401: bad key', status: 401 }, 'auth'],
      [{ error: 'ANTHROPIC_API_KEY not configured' }, 'auth'],
      [{ error: 'Claude 429: slow down', status: 429 }, 'rate_limited'],
      [{ error: 'Claude 503: upstream', status: 503 }, 'transient'],
      [{ error: 'aborted', timedOut: true }, 'timeout'],
    ];
    const misclassified = cases.filter(([r, want]) => cls(r) !== want)
      .map(([r, want]) => `${r.status || r.error}: expected ${want}, got ${cls(r)}`);
    if (misclassified.length) bad('§5 provider failures are misclassified', misclassified.join('\n'));
    else ok('§5 provider failures classify into model_invalid / auth / rate_limited / timeout / transient');
    if (!ai.CONFIG_FAILURES.includes('model_invalid') || !ai.CONFIG_FAILURES.includes('auth')) {
      bad('§5 the configuration-defect classes are wrong');
    } else if (ai.CONFIG_FAILURES.includes('transient') || ai.CONFIG_FAILURES.includes('timeout')) {
      bad('§5 transient failures are classified as configuration defects — the queue would flood');
    } else ok('§5 only configuration defects reach the human queue; transient failures do not flood it');

    // An invalid model must file an exception rather than reading as "no AI result available".
    mode = 'http-500';
    const transientCall = await ai.governedCall(ctx, { capability: 'fast', prompt: 'x', maxTokens: 20,
      agent: 'test-agent', workflow: 'transient-wf' }, deps);
    if (transientCall.needs_human) bad('§5 a 5xx was escalated to a human — ordinary provider failure would flood the queue');
    else if (transientCall.provider_failure !== 'transient') bad(`§5 a 5xx classified as ${transientCall.provider_failure}`);
    else ok('§5 a 5xx is durable evidence but does NOT queue a human');

    // Swap the stub for a hard 404 and PUT IT BACK. An earlier version replaced globalThis.fetch
    // permanently here, so every assertion after this point inherited a 404 — three later checks
    // failed for a reason that had nothing to do with what they were testing.
    const modeStub = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'model: not found' });
    let badModel;
    try {
      badModel = await ai.governedCall(ctx, { capability: 'fast', prompt: 'x', maxTokens: 20,
        agent: 'test-agent', workflow: 'badmodel-wf' }, deps);
    } finally { globalThis.fetch = modeStub; }
    if (badModel.ok) bad('§5 an invalid model produced a successful result');
    else if (badModel.provider_failure !== 'model_invalid') bad(`§5 an invalid model classified as ${badModel.provider_failure}`);
    else if (!badModel.needs_human) bad('§5 an invalid model did not require a human — it would recur for ever as flakiness');
    else if (!badModel.exception_id) bad('§5 an invalid model filed no exception');
    else {
      const exRow = (await q(`SELECT severity, status, reason FROM office_exceptions WHERE id=$1`, [badModel.exception_id])).rows[0];
      if (!exRow) bad('§5 the exception id was returned but no row exists');
      else if (!/will fail identically on every retry/.test(exRow.reason)) bad('§5 the exception does not say the failure is permanent');
      else ok('§5 an invalid/unavailable model files a CRITICAL exception saying it will recur until a human changes it');
    }
    if (badModel.text !== null) bad('§5 an invalid model returned text');
    else ok('§5 no downstream consequential action is possible from a provider failure');

    // ══ RULING §10: BUDGET HIERARCHY — BOTH CAPS ═══════════════════════════
    note('§10: a $10 objective may not consume enterprise headroom');
    const hier = await budget.enforceHierarchy(ctx, { objectiveId: OA, criticality: 'routine',
      capUsd: 1e9, objectiveBudgetUsd: 0.000001 }, deps);
    if (hier.allow) bad('§10 an exhausted OBJECTIVE budget was permitted because enterprise headroom remained');
    else if (hier.scope !== 'objective') bad(`§10 refused at the wrong scope: ${hier.scope}`);
    else ok('§10 an exhausted objective budget refuses even with unlimited enterprise headroom');
    const hier2 = await budget.enforceHierarchy(ctx, { objectiveId: OA, criticality: 'routine',
      capUsd: 0.000001, objectiveBudgetUsd: 1e9 }, deps);
    if (hier2.allow) bad('§10 an exhausted ENTERPRISE cap was permitted because the objective had budget');
    else if (hier2.scope !== 'enterprise') bad(`§10 refused at the wrong scope: ${hier2.scope}`);
    else ok('§10 an exhausted enterprise cap refuses even with objective budget remaining');
    const hier3 = await budget.enforceHierarchy(ctx, { objectiveId: OA, criticality: 'recovery',
      capUsd: 0.000001, objectiveBudgetUsd: 0.000001 }, deps);
    if (!hier3.allow) bad('§10 recovery work was refused by the hierarchy — an accounting limit became an outage');
    else ok('§10 recovery work remains exempt from BOTH caps');

    // ══ RULING §9: UNKNOWN COST FAILS CLOSED AT RELEASE ════════════════════
    note('§9: unknown cost preserves the AI result as evidence but BLOCKS consequential release');
    const gate = await budget.consequentialReleaseGate(ctx, { runId: ctx.runId,
      objectiveId: OA, objectiveBudgetUsd: 1e9, capUsd: 1e9 }, deps);
    if (gate.allow) bad('§9 release was permitted on a run carrying unmeasured AI cost');
    else if (gate.reason !== 'unmeasured_ai_cost') bad(`§9 blocked for the wrong reason: ${gate.reason}`);
    else ok(`§9 consequential release is BLOCKED while ${gate.unmeasured} AI call(s) on the run are unmeasured`);

    mode = 'normal';
    const prepared2 = await approval.prepare(ctx, { id: `ap-gate-${crypto.randomUUID()}`,
      actionKind: 'send_rfq_email', actionPayload: { body: 'x' },
      reason: '§9 control: a consequential release on a run with unmeasured cost' }, deps);
    ids.approvals.push(prepared2.approvalId);
    await scope.decideApproval(ctx, { id: prepared2.approvalId, decision: 'approved', resolvedBy: 'naresh' }, deps);
    const blockedRel = await approval.release(ctx, { approvalId: prepared2.approvalId,
      releasedBy: 'agent', objectiveId: OA, objectiveBudgetUsd: 1e9, capUsd: 1e9 }, deps);
    if (blockedRel.released) bad('§9 an APPROVED consequential action released despite unmeasured AI cost');
    else if (blockedRel.reason !== 'unmeasured_ai_cost') bad(`§9 release blocked for the wrong reason: ${blockedRel.reason}`);
    else if (!blockedRel.exception_id) bad('§9 the blocked release filed no exception — a consequential action that silently did not happen');
    else ok('§9 an approved consequential release is refused on unmeasured cost, and files an exception');
    // Non-consequential work is explicitly NOT gated.
    const nonCons = await approval.release(ctx, { approvalId: prepared2.approvalId,
      releasedBy: 'agent', consequential: false }, deps);
    if (!nonCons.released) bad(`§9 non-consequential release was gated: ${nonCons.reason}`);
    else ok('§9 non-consequential work is not gated — unknown cost may be recorded without an outage');

    // ══ RULING §6: THE GOVERNED PATH HAS NO LEGACY FALLBACK ════════════════
    note('§6: governed refusal → exception/review, never → legacy generator');
    for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib', 'office'))) delete require.cache[k];
    const beforeG = new Set(Object.keys(require.cache));
    const freshRfq = require('../src/lib/office/procurement-rfq');
    const graphG = Object.keys(require.cache).filter((k) => !beforeG.has(k) && !k.includes('node_modules'));
    if (graphG.some((f) => f.includes(path.join('agents', 'procurement-agent.js')))) {
      bad('§6 the governed module can reach the LEGACY procurement agent — a refusal could fall back to it');
    } else ok('§6 the governed module cannot reach the legacy generator at all (asserted on the require graph, not read from a comment)');

    // The fixture table must exist before the FIRST call: prepareGovernedRFQ reads rfq_requests
    // even to discover the RFQ is absent, so creating it later made "no such RFQ" fail as a
    // missing relation instead.
    await q(`CREATE TABLE IF NOT EXISTS rfq_requests (id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT,
             target_quantity TEXT, target_purity TEXT, gmp_required INTEGER DEFAULT 0, status TEXT)`);
    const noRfq = await freshRfq.prepareGovernedRFQ(ctx, { rfqId: 'no-such-rfq', supplier }, deps);
    if (noRfq.ok) bad('§6 a nonexistent RFQ was prepared');
    else ok(`§6 a nonexistent RFQ is refused (${noRfq.refusal})`);

    // A guard refusal must queue and must NOT fall back.
    const refusingGuard = { guardSend: async () => ({ allow: false, reason: 'cas_disputed', decisionId: 'dec-fixture' }) };
    await q(`INSERT INTO rfq_requests (id, molecule_name, cas_number, target_quantity, target_purity, status)
             VALUES ('rfq-k56','Tramadol Hydrochloride','27203-92-5','25kg','99%','pending') ON CONFLICT DO NOTHING`);
    const guardRefused = await freshRfq.prepareGovernedRFQ(ctx, { rfqId: 'rfq-k56', supplier },
      { ...deps, guard: refusingGuard });
    if (guardRefused.ok) bad('§6 an identity-guard refusal still produced a prepared communication');
    else if (guardRefused.refusal !== 'identity_guard_refused') bad(`§6 wrong refusal: ${guardRefused.refusal}`);
    else if (!guardRefused.exception_id) bad('§6 the guard refusal was not queued for review');
    else ok('§6 an identity-guard refusal queues a critical exception and prepares nothing');

    // The happy path prepares an approval carrying the EXACT communication, and sends nothing.
    const allowingGuard = { guardSend: async () => ({ allow: true, reason: null, decisionId: 'dec-ok',
      approved: { molecule_name: 'Tramadol Hydrochloride', cas_number: '36282-47-0', __approvedByDecision: 'dec-ok' } }) };
    const prep = await freshRfq.prepareGovernedRFQ(ctx, { rfqId: 'rfq-k56', supplier },
      { ...deps, guard: allowingGuard });
    if (!prep.ok) bad(`§6 the governed happy path failed: ${prep.refusal} ${prep.detail || ''}`);
    else {
      ids.approvals.push(prep.approvalId);
      if (prep.status !== 'pending') bad(`§6 the prepared action is not pending: ${prep.status}`);
      else if (prep.identity.approved_cas !== '36282-47-0') bad('§6 the approved CAS is not carried');
      else if (prep.identity.filed_cas !== '27203-92-5') bad('§6 the filed CAS is not recorded alongside it');
      else ok('§6 the governed path prepares a PENDING approval carrying the approved identity and the filed CAS');
      const payload = (await q(`SELECT action_payload, action_kind, status FROM office_approvals WHERE id=$1`, [prep.approvalId])).rows[0];
      if (!payload) bad('§6 no approval row was stored');
      else if (payload.action_payload.identity_decision_id !== 'dec-ok') bad('§6 the identity decision id is not in the payload');
      else if (payload.action_payload.subject !== prep.subject || payload.action_payload.body !== prep.body) {
        bad('§6 the stored payload is not the prepared communication');
      } else ok('§6 the stored, immutable payload IS the exact prepared communication and its identity decision');
    }

    // ══ MUTATION CONTROLS ══════════════════════════════════════════════════
    note('mutation controls: disable each mechanism, prove the defect returns');
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const LLM = path.join(__dirname, '..', 'src', 'lib', 'llm.js');
    const RFQF = path.join(__dirname, '..', 'src', 'lib', 'office', 'procurement-rfq.js');
    const SCOPEF = path.join(__dirname, '..', 'src', 'lib', 'office', 'scope.js');
    const fresh = (p2) => { for (const k of Object.keys(require.cache)) if (k.includes(p2)) delete require.cache[k]; };

    // M1 — restore the old "unknown is zero" behaviour.
    let before = sha(LLM); let src = fs.readFileSync(LLM, 'utf8');
    const n1 = `  if (!usage) return { costUsd: null, costKnown: false };`;
    if (!src.includes(n1)) bad('M1 could not locate the unknown-cost branch — the control is stale');
    else {
      fs.writeFileSync(LLM, src.replace(n1, `  if (!usage) return { costUsd: 0, costKnown: true };`));
      try {
        fresh(path.join('src', 'lib', 'llm.js'));
        const mutated = require('../src/lib/llm');
        const bad1 = mutated.costOf(null, 'claude-haiku-4-5-20251001');
        if (bad1.costUsd !== 0 || bad1.costKnown !== true) bad('M1 the mutation did not take');
        else ok('M1 reverting C1 makes an unmeasurable call cost $0.00 and claim to be measured — the fix is load-bearing');
      } finally { fs.writeFileSync(LLM, src); fresh(path.join('src', 'lib', 'llm.js')); }
    }
    if (sha(LLM) !== before) bad('M1 llm.js was NOT restored byte-for-byte');
    else ok('M1 llm.js restored, verified by content hash');

    // M2 — remove the AbortController signal. The hanging call must then NOT terminate.
    before = sha(LLM); src = fs.readFileSync(LLM, 'utf8');
    const n2 = `      signal: controller.signal,`;
    if (!src.includes(n2)) bad('M2 could not locate the abort signal — the control is stale');
    else {
      fs.writeFileSync(LLM, src.replace(n2, ''));
      try {
        fresh(path.join('src', 'lib', 'llm.js'));
        fresh(path.join('src', 'lib', 'office', 'ai.js'));
        const mutatedAi = require('../src/lib/office/ai');
        mode = 'hang';
        const race = await Promise.race([
          mutatedAi.governedCall(ctx, { capability: 'fast', prompt: 'x', timeoutMs: 1200 }, deps).then(() => 'returned'),
          new Promise((res) => setTimeout(() => res('still-hanging'), 3000)),
        ]);
        if (race === 'returned') bad('M2 without the abort signal the call still terminated — the signal may not be what bounds it');
        else ok('M2 without the abort signal a never-responding provider HANGS PAST its ceiling — the signal is load-bearing');
      } finally {
        fs.writeFileSync(LLM, src);
        fresh(path.join('src', 'lib', 'llm.js'));
        fresh(path.join('src', 'lib', 'office', 'ai.js'));
        mode = 'normal';
      }
    }
    if (sha(LLM) !== before) bad('M2 llm.js was NOT restored byte-for-byte');
    else ok('M2 llm.js restored, verified by content hash');

    // M3 — remove the identity containment check.
    before = sha(RFQF); src = fs.readFileSync(RFQF, 'utf8');
    const n3 = `  const violation = identityContainment(ai.text, { approvedCas, filedCas });`;
    if (!src.includes(n3)) bad('M3 could not locate the containment call — the control is stale');
    else {
      fs.writeFileSync(RFQF, src.replace(n3, `  const violation = null;`));
      try {
        fresh(path.join('src', 'lib', 'office', 'procurement-rfq.js'));
        const mutatedRfq = require('../src/lib/office/procurement-rfq');
        mode = 'wrong-cas';
        const leaked = await mutatedRfq.renderGovernedRFQ(ctx, {
          approvedMol: { ...approvedMol, cas_number: '27203-92-5' }, supplier, rfqId: 'rfq-1',
          filedCas: '36282-47-0',
        }, deps);
        if (!leaked.ok) bad('M3 the contradicting CAS was still refused with containment removed', leaked.detail);
        else if (!/36282-47-0/.test(leaked.body)) bad('M3 the mutation did not actually produce the contradicting text');
        else ok('M3 without containment, an RFQ carrying a CAS the identity decision REFUSED becomes sendable — the check is load-bearing');
      } finally {
        fs.writeFileSync(RFQF, src);
        fresh(path.join('src', 'lib', 'office', 'procurement-rfq.js'));
        mode = 'normal';
      }
    }
    if (sha(RFQF) !== before) bad('M3 procurement-rfq.js was NOT restored byte-for-byte');
    else ok('M3 procurement-rfq.js restored, verified by content hash');

    // ══ K5 ACTIVATED: THE GOVERNED CALL IS NOW REFUSED WHEN A CAP IS GONE ═══
    //
    // Before activation `enforce()` had no production caller and nothing was refused. These prove
    // the wiring, on fixtures — per Rule 7 no threshold is ever consumed in production to watch it
    // bite.
    //
    // WHAT THESE PROVE AND WHAT THEY DO NOT. The OBJECTIVE cap is driven end to end through
    // governedCall, because a fixture objective can be given a budget small enough to exhaust for
    // a fraction of a cent. The ENTERPRISE cap is $100/day and is proven at the enforce /
    // enforceHierarchy layer above, not through governedCall, because reaching it end to end would
    // mean spending $100 — and governedCall deliberately exposes NO cap parameter, so a caller
    // cannot raise or lower its own ceiling. That boundary is stated rather than blurred.
    note('K5 ACTIVATED: both caps are now enforced before the provider is reached');
    mode = 'normal';

    // An objective with a budget so small that one stubbed call exhausts it.
    const OTIGHT = `k56-tight-${crypto.randomUUID()}`;
    await scope.createObjective({
      id: OTIGHT, companyId: A, objective: 'Budget activation fixture — tiny budget',
      priority: 'P3', kpiMetric: 'calls', kpiTarget: 1, deadline: '2026-12-31',
      // 0.01, not 0.0001: objectives.budget_usd is NUMERIC(12,2), so anything finer ROUNDS TO
      // $0.00 — and the new $0 guard then refuses everything, which is how this fixture's first
      // version failed. A budget the column cannot represent is not a small budget.
      budgetUsd: 0.01, autonomyTier: 'supervised', approvalPolicy: 'all_consequential',
      createdBy: 'test',
    }, deps);
    ids.objectives.push(OTIGHT);
    await scope.setObjectiveStatus(Object.freeze({ companyId: A, objectiveId: OTIGHT, runId: null }),
      { id: OTIGHT, status: 'active' }, deps);
    const tightRun = await beginObjectiveRun({ objectiveId: OTIGHT, trigger: 'office',
      workflow: 'budget-activation-fixture', agent: 'test-agent', maxRuntimeMinutes: 5 }, deps);
    ids.runs.push(tightRun.runId);
    await L.startRun(tightRun.runId);
    const tightCtx = tightRun.context;

    // First call: inside budget, so it must succeed and be accounted.
    const t1 = await ai.governedCall(tightCtx, { capability: 'fast', prompt: 'hi', maxTokens: 20,
      workflow: 'budget-activation-fixture', agent: 'test-agent' }, deps);
    if (t1.ok) ok('a call within the objective budget proceeds and is accounted');
    else bad('the first in-budget call was refused', t1.error);

    // Now exhaust the budget EXPLICITLY rather than by making ~57 real calls at haiku rates.
    // The cost row is the thing the budget reads, so filing one is the honest way to put the
    // objective over its cap — and it keeps this test independent of provider pricing, which is
    // not the subject under test and would silently change the meaning of a pass.
    const beforeRows = (await q(
      `SELECT COUNT(*)::int n FROM office_cost_ledger WHERE run_id = $1`, [tightRun.runId])).rows[0].n;
    await scope.recordCost(tightCtx, { runId: tightRun.runId, provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001', tokensInput: 1000, tokensOutput: 1000,
      costUsd: 0.02, costKnown: true, agent: 'test-agent', workflow: 'budget-activation-fixture' }, deps);

    const t2 = await ai.governedCall(tightCtx, { capability: 'fast', prompt: 'hi again', maxTokens: 20,
      workflow: 'budget-activation-fixture', agent: 'test-agent' }, deps);
    if (!t2.ok && t2.refusedBy === 'budget' && t2.budgetScope === 'objective') {
      ok(`the next call is REFUSED by the objective cap: ${t2.error}`);
    } else bad('an exhausted objective budget did NOT refuse the governed call', JSON.stringify({ ok: t2.ok, err: t2.error }));

    // A refusal must not file a cost row: nothing reached the provider, so nothing is owed.
    // A DELTA against what was already there, not an absolute count: an absolute becomes false
    // the moment anything else legitimately files a row, and the obvious fix for a failing
    // absolute is to widen it.
    const afterRows = (await q(
      `SELECT COUNT(*)::int n FROM office_cost_ledger WHERE run_id = $1`, [tightRun.runId])).rows[0].n;
    if (afterRows === beforeRows + 1) ok('the refusal filed NO cost row — only the exhausting row I wrote myself');
    else bad(`the refused call changed the ledger: ${beforeRows} → ${afterRows} (expected +1 from my own row only)`);

    // And the text is withheld, not returned with a warning.
    if (t2.text === null) ok('a budget refusal withholds the text rather than returning it with a note');
    else bad('a refused call still returned text');

    // ── NEVER REFUSED: an accounting limit must not become an outage ─────────
    for (const crit of ['critical', 'recovery', 'observability']) {
      const ex = await ai.governedCall(tightCtx, { capability: 'fast', prompt: 'urgent', maxTokens: 20,
        workflow: 'budget-activation-fixture', agent: 'test-agent', criticality: crit }, deps);
      if (ex.ok) ok(`${crit} work still runs with the objective budget exhausted`);
      else bad(`${crit} work was refused by a spend limit — the limit has become an outage`, ex.error);
    }

    // ── THE STRICTER DEFAULT ────────────────────────────────────────────────
    // A caller that forgets to declare criticality must get the REFUSED path, not the exempt one.
    const forgot = await ai.governedCall(tightCtx, { capability: 'fast', prompt: 'x', maxTokens: 20,
      workflow: 'budget-activation-fixture', agent: 'test-agent' }, deps);
    if (!forgot.ok && forgot.refusedBy === 'budget') ok('omitting criticality defaults to routine — refused, not silently exempt');
    else bad('a call with no declared criticality was treated as exempt');

    // ── A $0 OBJECTIVE BUDGET IS NOT UNLIMITED ──────────────────────────────
    // This was a live defect: fraction was `budget > 0 ? spent/budget : 0`, so an objective given
    // exactly $0 produced tier 'ok' and could spend without limit — the strictest budget a CEO can
    // set was the one with no enforcement at all.
    const OZERO = `k56-zero-${crypto.randomUUID()}`;
    await scope.createObjective({
      id: OZERO, companyId: A, objective: 'Zero-budget fixture', priority: 'P3',
      kpiMetric: 'calls', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 0,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: 'test',
    }, deps);
    ids.objectives.push(OZERO);
    await scope.setObjectiveStatus(Object.freeze({ companyId: A, objectiveId: OZERO, runId: null }),
      { id: OZERO, status: 'active' }, deps);
    const zRun = await beginObjectiveRun({ objectiveId: OZERO, trigger: 'office',
      workflow: 'budget-activation-fixture', agent: 'test-agent', maxRuntimeMinutes: 5 }, deps);
    ids.runs.push(zRun.runId);
    await L.startRun(zRun.runId);
    const zeroCall = await ai.governedCall(zRun.context, { capability: 'fast', prompt: 'x', maxTokens: 20,
      workflow: 'budget-activation-fixture', agent: 'test-agent' }, deps);
    if (!zeroCall.ok && zeroCall.refusedBy === 'budget') ok(`a $0 objective budget permits NO spend: ${zeroCall.error}`);
    else bad('a $0 objective budget allowed an AI call — $0 is being read as unlimited');

    // ── THE CEILING IS NOT CALLER-SUPPLIED ──────────────────────────────────
    // The objective's budget is read from the resolved context, which read it from the stored row.
    // An agent passing a bigger number in its spec must not be able to buy itself more room.
    const forged = await ai.governedCall(tightCtx, { capability: 'fast', prompt: 'x', maxTokens: 20,
      workflow: 'budget-activation-fixture', agent: 'test-agent',
      budgetUsd: 1000, objectiveBudgetUsd: 1000, capUsd: 1000 }, deps);
    if (!forged.ok && forged.refusedBy === 'budget') ok('a spec carrying its own budget is ignored — the ceiling comes from the stored objective');
    else bad('a caller raised its own spending ceiling through the spec');

    // M4 — remove the approved predicate from the arbitrated release claim.
    //
    // This control originally mutated approval.js. The predicate has since MOVED to scope.js —
    // the scope-discipline check refused to exempt approval.js as product code — and the control
    // reported itself STALE rather than passing on a file that no longer held the predicate. That
    // is the whole purpose of the staleness branch: a mutation control pointed at the wrong file
    // proves nothing, and silence would have looked like success.
    before = sha(SCOPEF); src = fs.readFileSync(SCOPEF, 'utf8');
    const n4 = `        AND status = 'approved'\n        AND released_at IS NULL`;
    if (!src.includes(n4)) bad('M4 could not locate the approved predicate — the control is stale');
    else {
      fs.writeFileSync(SCOPEF, src.replace(n4, `        AND released_at IS NULL`));
      try {
        fresh(path.join('src', 'lib', 'office', 'scope.js'));
        fresh(path.join('src', 'lib', 'office', 'approval.js'));
        const mutatedApp = require('../src/lib/office/approval');
        const p2 = await mutatedApp.prepare(ctx, { actionKind: 'send_rfq_email_m4',
          actionPayload: { body: 'x' }, reason: 'M4 control: prove the approved predicate is load-bearing' }, deps);
        ids.approvals.push(p2.approvalId);
        // consequential:false isolates the predicate under test. With the gate active this run's
        // unmeasured AI cost refuses first, so the mutation could not be measured at all — the
        // control would report "still refused" and look like the predicate was not load-bearing.
        const leak = await mutatedApp.release(ctx, { approvalId: p2.approvalId, releasedBy: 'agent', consequential: false }, deps);
        if (!leak.released) bad('M4 the pending approval was still refused — the predicate may not be what blocks it');
        else ok('M4 without the approved predicate a PENDING action releases — approval-before-action is load-bearing');
      } finally {
        fs.writeFileSync(SCOPEF, src);
        fresh(path.join('src', 'lib', 'office', 'scope.js'));
        fresh(path.join('src', 'lib', 'office', 'approval.js'));
      }
    }
    if (sha(SCOPEF) !== before) bad('M4 scope.js was NOT restored byte-for-byte');
    else ok('M4 scope.js restored, verified by content hash');

    // M5 — remove the budget gate from the governed call.
    //
    // Activation is only real if its absence is detectable. Without this control, "the budget is
    // active" would rest on a passing test that might be passing for another reason — which is
    // Defect 5 in the verification standard, and the reason Rule 6 exists.
    const AIF = path.join(__dirname, '..', 'src', 'lib', 'office', 'ai.js');
    before = sha(AIF); src = fs.readFileSync(AIF, 'utf8');
    const n5 = '  if (!budgetDecision.allow) {';
    if (!src.includes(n5)) bad('M5 could not locate the budget gate in ai.js — the control is stale');
    else {
      fs.writeFileSync(AIF, src.replace(n5, '  if (false && !budgetDecision.allow) {'));
      try {
        fresh(path.join('src', 'lib', 'office', 'ai.js'));
        const mutatedAi = require('../src/lib/office/ai');
        // The same exhausted objective that was refused a moment ago.
        const leak = await mutatedAi.governedCall(tightCtx, { capability: 'fast', prompt: 'x',
          maxTokens: 20, workflow: 'budget-activation-fixture', agent: 'test-agent' }, deps);
        if (leak.ok) {
          ok('M5 without the gate an EXHAUSTED objective budget still buys AI calls — the gate is load-bearing');
          // Clean up the row the mutated build was able to write.
          await q(`DELETE FROM office_cost_ledger WHERE run_id = $1 AND id = (
                     SELECT MAX(id) FROM office_cost_ledger WHERE run_id = $1)`, [tightRun.runId]);
        } else if (leak.refusedBy === 'budget') {
          bad('M5 the call was STILL refused by the budget with the gate disabled — the control is not '
            + 'measuring what it claims, or the gate exists in a second place');
        } else {
          bad('M5 the call failed for an unrelated reason, so the gate was never measured', leak.error);
        }
      } finally {
        fs.writeFileSync(AIF, src);
        fresh(path.join('src', 'lib', 'office', 'ai.js'));
      }
    }
    if (sha(AIF) !== before) bad('M5 ai.js was NOT restored byte-for-byte');
    else ok('M5 ai.js restored, verified by content hash');

  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    globalThis.fetch = realFetch;
    try {
      for (const id of ids.runs) {
        await q(`DELETE FROM office_outcomes WHERE run_id = $1`, [id]);
        await q(`DELETE FROM office_approvals WHERE run_id = $1`, [id]);
        await q(`DELETE FROM office_exceptions WHERE run_id = $1`, [id]);
        await q(`DELETE FROM office_cost_ledger WHERE run_id = $1`, [id]);
      }
      await q(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`);
      try {
        for (const id of ids.runs) await q(`DELETE FROM agent_run_events WHERE run_id = $1`, [id]);
        for (const id of ids.runs) await q(`DELETE FROM agent_runs WHERE run_id = $1`, [id]);
      } finally {
        await q(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`);
      }
      const trg = (await q(`SELECT tgenabled FROM pg_trigger WHERE tgname='trg_agent_run_events_append_only'`)).rows[0];
      if (!trg || trg.tgenabled === 'D') bad('the append-only trigger was left DISABLED after cleanup');
      for (const id of ids.objectives) await q(`DELETE FROM objectives WHERE id = $1`, [id]);
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]);

      const leaks = [];
      const mine = async (table, col, list) => {
        if (!list.length) return;
        const n = (await q(`SELECT COUNT(*)::int n FROM ${table} WHERE ${col} = ANY($1)`, [list])).rows[0].n;
        if (n) leaks.push(`${table}: ${n} of my rows remain`);
      };
      await mine('agent_runs', 'run_id', ids.runs);
      await mine('objectives', 'id', ids.objectives);
      await mine('companies', 'id', ids.companies);
      await mine('office_approvals', 'id', ids.approvals);
      if (leaks.length) bad('fixture cleanup leaked', leaks.join('\n'));
      else ok('cleanup: every fixture row I created is gone (by id)');
    } catch (e) {
      bad('cleanup failed', e.message);
    }
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} governed-AI assertion(s) failed`
    : '\nPASS  the governed slice holds: AI is bounded and metered, unknown cost is never zero, the '
      + 'model cannot change chemical identity, approval precedes the action, and provenance answers for it');
  process.exit(fail ? 1 : 0);
})();
