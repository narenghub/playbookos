#!/usr/bin/env node
// ── THE UNIFIED AUTHORIZATION BOUNDARY (Decision 1, 2026-11-25) ─────────────
//
//   node scripts/check-authz-boundary-db.js   exit 0 = every ruled property holds
//                                             exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner decision: *"BRIDGE, DO NOT RETIRE."* With requirements:
//
//   - No second competing company authorization model.
//   - No assumption that product or tenant identifiers are company identifiers.
//   - Resolve product-to-company relationships through explicit, authorized mappings.
//   - Do not invent a human user for an autonomous execution.
//   - Preserve existing user permissions and product-specific restrictions.
//   - Derive autonomous authority from the authorized objective, run and agent context.
//   - Independently enforce company scope, capability permissions, STOP controls, approvals,
//     revocation and budgets.
//   - Reject ambiguous, missing, suspended or revoked mappings.
//   - Preserve existing security behavior for every legacy caller.
//   - "Audit existing gate.js callers before changing behavior. Add compatibility, cross-company,
//      revoked-authorization, STOP and mutation tests."
//
// Each of those is an assertion below, and the five named test classes are sections 5 to 9.
//
// ── THE AUDIT, WHICH CAME FIRST ─────────────────────────────────────────────
//
// Section 1 re-measures it on every run rather than quoting what I found once: gate.js has no
// production callers. If that ever stops being true the migration risk changes, and this check is
// where that would surface.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures deleted by id.

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
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);

const REPO = path.join(__dirname, '..');

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'authz' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the authorization boundary not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'authz-bootstrap@authz.invalid';
process.env.ADMIN_PASSWORD = `authz-${crypto.randomBytes(16).toString('hex')}`;

const WATCHDOG_MS = Number(process.env.AUTHZ_CHECK_TIMEOUT_MS || 240_000);
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
  const ids = { companies: [], objectives: [], runs: [], mappings: [] };
  const uid = (p) => `authz-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await require('../src/lib/authz/product-company').migrateProductCompanies(q);
    console.log('  ..    schema up\n');

    const BOUNDARY = require('../src/lib/authz/boundary');
    const PC = require('../src/lib/authz/product-company');
    const scope = require('../src/lib/office/scope');
    const CTX = require('../src/lib/office/context');
    const autonomy = require('../src/lib/autonomy');
    const door = CTX.contextForTests__TEST_ONLY;

    const A = uid('co-a');
    const B = uid('co-b');
    for (const c of [A, B]) {
      await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [c]);
      ids.companies.push(c);
    }
    const mkObjective = async (company, { budgetUsd = 100, tier = 'supervised',
      status = 'active', policy = 'all_consequential' } = {}) => {
      const id = uid('obj');
      await scope.createObjective({
        id, companyId: company, objective: `authz fixture ${id}`, priority: 'P2',
        kpiMetric: 'x', kpiTarget: 1, deadline: '2026-12-31', budgetUsd,
        autonomyTier: tier, approvalPolicy: policy, createdBy: 'ceo',
      }, deps);
      await q(`UPDATE objectives SET status = $2 WHERE id = $1`, [id, status]);
      ids.objectives.push(id);
      return id;
    };
    const mkRun = async (company, objectiveId) => {
      const runId = crypto.randomUUID();
      await q(`INSERT INTO agent_runs (run_id, root_run_id, company_id, objective_id, trigger,
                                       product, state, workflow, agent)
               VALUES ($1,$1,$2,$3,'office','internal','RUNNING','authz-wf','executive-agent')`,
        [runId, company, objectiveId]);
      ids.runs.push(runId);
      return runId;
    };
    const mapProduct = async (product, company, { status = 'active', from = null, to = null } = {}) => {
      const id = uid('map');
      await q(`INSERT INTO product_companies
                 (id, product, company_id, status, authorized_by, reason, effective_from, effective_to)
               VALUES ($1,$2,$3,$4,'naren','authz check fixture',
                       COALESCE($5::timestamptz, NOW() - INTERVAL '1 minute'), $6)`,
        [id, product, company, status, from, to]);
      ids.mappings.push(id);
      return id;
    };

    // ══ 1. THE AUDIT: WHO CALLS gate.js? ══════════════════════════════════
    console.log('── 1. the caller audit the owner asked for, re-measured ──\n');

    const strip = (text) => text
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const callers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(path.join(dir, e.name)); continue; }
        if (!/\.js$/.test(e.name)) continue;
        const f = path.join(dir, e.name);
        const rel = path.relative(REPO, f);
        if (rel === 'src/lib/agents/gate.js') continue;
        const code = strip(fs.readFileSync(f, 'utf8'));
        if (/\b(callAgent|callTool)\s*\(/.test(code) || /require\(['"][^'"]*agents\/gate['"]\)/.test(code)) {
          callers.push(rel);
        }
      }
    };
    walk(path.join(REPO, 'src'));
    walk(path.join(REPO, 'scripts'));
    if (fs.existsSync(path.join(REPO, 'server.js'))) {
      const code = strip(fs.readFileSync(path.join(REPO, 'server.js'), 'utf8'));
      if (/\b(callAgent|callTool)\s*\(/.test(code)) callers.push('server.js');
    }
    const productionCallers = callers.filter((f) => !/\.test\.js$/.test(f) && !/^scripts\//.test(f));
    if (productionCallers.length === 0) {
      ok('gate.js has NO production callers — the only code exercising it is its own test suite');
      note(`every file naming callAgent/callTool at all: ${callers.join(', ') || '(none)'}`);
      note('so "preserve existing security behaviour for every legacy caller" has one caller to '
        + 'preserve, and section 5 preserves it. This is a finding, not a licence: gate.js is NOT '
        + 'retired, per the decision');
    } else bad('gate.js now has production callers — the migration risk has changed',
      productionCallers.join(', '));

    // ══ 2. A PRODUCT IS NOT A COMPANY ═════════════════════════════════════
    console.log('\n── 2. a product identifier is not a company identifier ──\n');

    const unmapped = await PC.companyForProduct('golfnex', deps);
    if (!unmapped.ok && unmapped.reason === 'missing') {
      ok('an unmapped product resolves to NO company — it is not assumed to BE one');
      note('gate.js used to pass `product` into the kill switch\'s company slot, so "golfnex" was '
        + 'treated as a company id');
    } else bad('an unmapped product resolved to a company', JSON.stringify(unmapped));

    await mapProduct('golfnex', A);
    const mapped = await PC.companyForProduct('golfnex', deps);
    if (mapped.ok && mapped.companyId === A && mapped.authorizedBy === 'naren') {
      ok('an explicitly authorized mapping resolves, and names who authorized it');
    } else bad('the explicit mapping did not resolve', JSON.stringify(mapped));

    // ══ 3. EVERY NON-ANSWER IS A REFUSAL, AND THEY ARE DISTINGUISHED ══════
    console.log('\n── 3. ambiguous, missing, suspended, revoked, expired, unreadable ──\n');

    await mapProduct('golfnex', B);
    const ambiguous = await PC.companyForProduct('golfnex', deps);
    if (!ambiguous.ok && ambiguous.reason === 'ambiguous' && ambiguous.companies.length === 2) {
      ok('TWO active mappings is AMBIGUOUS and refuses, naming both companies — which one it acts '
        + 'for is a decision, not a derivation');
    } else bad('two active mappings did not refuse', JSON.stringify(ambiguous));

    await q(`UPDATE product_companies SET status = 'revoked' WHERE product = 'golfnex' AND company_id = $1`, [B]);
    const backToOne = await PC.companyForProduct('golfnex', deps);
    if (backToOne.ok && backToOne.companyId === A) {
      ok('revoking one of the two leaves a single live mapping, and it resolves again');
    } else bad('revocation did not disambiguate', JSON.stringify(backToOne));

    await mapProduct('favly', A, { status: 'suspended' });
    const suspended = await PC.companyForProduct('favly', deps);
    if (!suspended.ok && suspended.reason === 'suspended') {
      ok('a SUSPENDED mapping refuses, and says it is suspended rather than missing');
      note('a deliberate pause and a configuration gap call for different responses');
    } else bad('a suspended mapping did not refuse distinctly', JSON.stringify(suspended));

    await mapProduct('sitenex', A, { status: 'revoked' });
    const revoked = await PC.companyForProduct('sitenex', deps);
    if (!revoked.ok && revoked.reason === 'revoked') ok('a REVOKED mapping refuses, distinctly');
    else bad('a revoked mapping did not refuse distinctly', JSON.stringify(revoked));

    await mapProduct('aros', A, { to: new Date(Date.now() - 1000).toISOString() });
    const expired = await PC.companyForProduct('aros', deps);
    if (!expired.ok && expired.reason === 'expired') ok('a mapping outside its window refuses, distinctly');
    else bad('an expired mapping did not refuse distinctly', JSON.stringify(expired));

    const blind = { query: async (t, p) => {
      if (/product_companies/i.test(t)) throw new Error('mapping table unreadable (fixture)');
      return q(t, p);
    } };
    const unreadable = await PC.companyForProduct('golfnex', blind);
    if (!unreadable.ok && unreadable.reason === 'unknown') {
      ok('an UNREADABLE mapping is UNKNOWN, not missing — an outage is not an attribution');
    } else bad('an unreadable mapping was reported as absent', JSON.stringify(unreadable));

    // ══ 4. NO INVENTED USER, EITHER DIRECTION ═════════════════════════════
    console.log('\n── 4. nobody is invented ──\n');

    const noUser = await BOUNDARY.authorizeHumanToolCall({
      product: 'golfnex', featureKey: 'intelligence.content.run', toolName: 'content-pipeline',
    }, deps);
    if (!noUser.allowed && noUser.decision_rule === 'no_actor') {
      ok('the human path refuses an unauthenticated caller rather than inventing a person');
      note('an autonomous run has no user; it is told to use the other door');
    } else bad('the human path proceeded without a user', JSON.stringify(noUser));

    const bSrc = fs.readFileSync(path.join(REPO, 'src', 'lib', 'authz', 'boundary.js'), 'utf8');
    const agentFn = bSrc.slice(bSrc.indexOf('async function authorizeAgentAction'),
      bSrc.indexOf('{', bSrc.indexOf('async function authorizeAgentAction')));
    if (!/user|companyId|product/.test(agentFn)) {
      ok('authorizeAgentAction takes no user, no companyId and no product — all three would be '
        + 'things to fabricate, so there is nothing to fabricate');
      note(`its signature: ${agentFn.replace(/\s+/g, ' ').trim()}`);
    } else bad('the agent path accepts an identity parameter', agentFn.replace(/\s+/g, ' ').trim());

    // ══ 5. COMPATIBILITY — the legacy caller's behaviour is preserved ══════
    console.log('\n── 5. compatibility: the legacy path decides as it did ──\n');

    const USER = { id: 'u-authz', email: 'u@authz.invalid', role: 'admin' };
    const allowResolver = async () => ({ allowed: true, rule: 7, explain: 'permitted' });
    const denyResolver = async () => ({ allowed: false, rule: 8, explain: 'no rule matched' });
    const noStop = { autonomy: { checkStopped: async () => null, recordRefusal: () => {} } };

    const legacyAllow = await BOUNDARY.authorizeHumanToolCall({
      user: USER, product: 'golfnex', featureKey: 'intelligence.content.run',
      toolName: 'content-pipeline' },
      { ...deps, ...noStop, resolve: allowResolver });
    if (legacyAllow.allowed && legacyAllow.decision_rule === 7) {
      ok('a permitted user is ALLOWED, and the resolver\'s own rule id is carried through');
    } else bad('a permitted user was refused', JSON.stringify(legacyAllow));

    const legacyDeny = await BOUNDARY.authorizeHumanToolCall({
      user: USER, product: 'golfnex', featureKey: 'intelligence.content.run',
      toolName: 'content-pipeline' },
      { ...deps, ...noStop, resolve: denyResolver });
    if (!legacyDeny.allowed && legacyDeny.decision_rule === 8) {
      ok('a denied user is DENIED, with the resolver\'s rule id — the user\'s own permissions and '
        + 'the product\'s restrictions still decide');
    } else bad('a denied user was allowed', JSON.stringify(legacyDeny));

    const resolverBroken = await BOUNDARY.authorizeHumanToolCall({
      user: USER, product: 'golfnex', featureKey: 'intelligence.content.run',
      toolName: 'content-pipeline' },
      { ...deps, ...noStop, resolve: async () => { throw new Error('resolver down'); } });
    if (!resolverBroken.allowed) {
      ok('a resolver error FAILS CLOSED, as it did before');
    } else bad('a resolver error allowed the call', JSON.stringify(resolverBroken));

    // An unmapped product does not refuse the human path. It is recorded, so the gap is visible.
    const unmappedHuman = await BOUNDARY.authorizeHumanToolCall({
      user: USER, product: 'linkabl', featureKey: 'intelligence.content.run',
      toolName: 'content-pipeline' },
      { ...deps, ...noStop, resolve: allowResolver });
    if (unmappedHuman.allowed && unmappedHuman.company_resolution === 'unresolved:missing') {
      ok('an UNMAPPED product does not break the human path — it is allowed on the user\'s own '
        + 'permissions, and the unresolved company is RECORDED rather than assumed');
      note('refusing here would break callers whose authority never depended on a company; '
        + 'recording it is how the gap becomes visible instead of invisible');
    } else bad('an unmapped product changed the human decision', JSON.stringify(unmappedHuman));

    if (legacyAllow.company_resolution === `mapped:${A}`) {
      ok('and a mapped product records WHICH company it resolved to');
    } else bad('the resolution was not recorded', legacyAllow.company_resolution);

    // ══ 6. CROSS-COMPANY ══════════════════════════════════════════════════
    console.log('\n── 6. cross-company ──\n');

    const objA = await mkObjective(A);
    const runA = await mkRun(A, objA);
    const ctxA = door({ companyId: A, objectiveId: objA, runId: runA, budgetUsd: 100,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential' });

    const agentOk = await BOUNDARY.authorizeAgentAction(ctxA, {
      capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent' },
      { ...deps, ...noStop });
    if (agentOk.allowed && agentOk.company === A) {
      ok('POSITIVE CONTROL: an autonomous action under an active objective is allowed, and its '
        + 'company is DERIVED from the context');
    } else bad('the autonomous positive control was refused', JSON.stringify(agentOk));

    const objB = await mkObjective(B);
    const ctxAforB = door({ companyId: A, objectiveId: objB, runId: runA, budgetUsd: 100 });
    const cross = await BOUNDARY.authorizeAgentAction(ctxAforB, {
      capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent' },
      { ...deps, ...noStop });
    if (!cross.allowed && cross.decision_rule === 'objective_not_in_company_scope') {
      ok('company A cannot act under company B\'s objective — the scoped read returns nothing, and '
        + 'nothing is a refusal');
    } else bad('a cross-company autonomous action was allowed', JSON.stringify(cross));

    let fakeCtxRefused = null;
    try {
      const r = await BOUNDARY.authorizeAgentAction(
        Object.freeze({ companyId: A, objectiveId: objA, runId: runA }),
        { capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent' },
        { ...deps, ...noStop });
      fakeCtxRefused = r.decision_rule;
    } catch (e) { fakeCtxRefused = 'threw'; }
    if (fakeCtxRefused === 'no_company_context') {
      ok('a hand-built context — frozen, right shape, right ids — is refused: trust is object '
        + 'identity, not shape');
    } else bad('a fabricated context was accepted', fakeCtxRefused);

    // ══ 7. REVOKED AUTHORIZATION ══════════════════════════════════════════
    console.log('\n── 7. revoked authorization ──\n');

    const objRevoked = await mkObjective(A);
    const runRevoked = await mkRun(A, objRevoked);
    const ctxRevoked = door({ companyId: A, objectiveId: objRevoked, runId: runRevoked,
      budgetUsd: 100, autonomyTier: 'supervised', approvalPolicy: 'all_consequential' });
    const beforeRevoke = await BOUNDARY.authorizeAgentAction(ctxRevoked, {
      capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent' },
      { ...deps, ...noStop });
    if (beforeRevoke.allowed) ok('POSITIVE CONTROL: allowed while the objective is active');
    else bad('the pre-revocation control was refused', JSON.stringify(beforeRevoke));

    await q(`UPDATE objectives SET status = 'cancelled' WHERE id = $1`, [objRevoked]);
    const afterRevoke = await BOUNDARY.authorizeAgentAction(ctxRevoked, {
      capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent' },
      { ...deps, ...noStop });
    if (!afterRevoke.allowed && afterRevoke.decision_rule === 'authorization_revoked') {
      ok('cancelling the objective WITHDRAWS the authority mid-flight, on a context that was '
        + 'already minted — the check reads stored state, not the context\'s copy of it');
    } else bad('a revoked objective still authorized action', JSON.stringify(afterRevoke));

    // ══ 8. STOP CONTROLS, INCLUDING THE COMPATIBILITY KEY ═════════════════
    console.log('\n── 8. STOP controls ──\n');

    autonomy.resetForTests?.();
    const stopSet = await autonomy.stop({ scope_type: 'company', scope_key: A,
      reason: 'authz check: a company-scoped halt', actor: 'authz-check' }, { deps });
    if (stopSet && stopSet.ok !== false) ok('a company-scoped stop was accepted (checked, not assumed)');
    else bad('the fixture stop was refused', JSON.stringify(stopSet));
    autonomy.resetForTests?.();

    const stoppedAgent = await BOUNDARY.authorizeAgentAction(ctxA, {
      capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent' }, deps);
    if (!stoppedAgent.allowed && stoppedAgent.decision_rule === 'autonomy_stop') {
      ok('the autonomous path is refused by a stop on its company');
    } else bad('a company stop did not halt autonomous action', JSON.stringify(stoppedAgent));

    // THE COMPATIBILITY PATH. A production stop row written through gate.js carries the PRODUCT in
    // the company slot. If the boundary only asked about the resolved company, that row would stop
    // matching — an operator's halt would silently stop halting.
    const stoppedHumanByCompany = await BOUNDARY.authorizeHumanToolCall({
      user: USER, product: 'golfnex', featureKey: 'intelligence.content.run',
      toolName: 'content-pipeline' }, { ...deps, resolve: allowResolver });
    if (!stoppedHumanByCompany.allowed && stoppedHumanByCompany.stopped_by_policy) {
      ok('and the human path is refused by that same company stop, via the resolved mapping');
    } else bad('the human path ignored the company stop', JSON.stringify(stoppedHumanByCompany));

    await autonomy.resume({ scope_type: 'company', scope_key: A,
      reason: 'authz check: fixture cleanup', actor: 'authz-check' }, { deps });
    autonomy.resetForTests?.();

    // THE COMPATIBILITY CASE, MODELLED AS IT ACTUALLY EXISTS.
    //
    // A FINDING worth stating: autonomy.stop() now REFUSES a company scope key that is not a known
    // company — K8's guard, "a stop that accepts a nonexistent scope and reports success is false
    // safety evidence". So a NEW product-keyed stop cannot be written through the API at all, and
    // the first version of this assertion failed for that reason rather than for the one it meant
    // to test.
    //
    // What the compatibility path protects is therefore HISTORICAL rows — written before K8, or
    // inserted directly — and that is what this fixture is: the row as it would already be sitting
    // in production, put there without going through today's validation.
    await q(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
             VALUES ('company','golfnex','a legacy stop keyed on the PRODUCT, as gate.js wrote them','authz-check')
             ON CONFLICT (scope_type, scope_key) DO UPDATE SET reason = EXCLUDED.reason`);
    const legacyRow = (await q(`SELECT 1 FROM autonomy_stops
                                 WHERE scope_type='company' AND scope_key='golfnex'`)).rows.length;
    if (legacyRow === 1) ok('a historical product-keyed stop row exists (checked, not assumed)');
    else bad('the legacy stop fixture was not written');
    autonomy.resetForTests?.();

    const stoppedByLegacyKey = await BOUNDARY.authorizeHumanToolCall({
      user: USER, product: 'golfnex', featureKey: 'intelligence.content.run',
      toolName: 'content-pipeline' }, { ...deps, resolve: allowResolver });
    if (!stoppedByLegacyKey.allowed && stoppedByLegacyKey.stopped_by_policy) {
      ok('an EXISTING product-keyed stop still halts the human path — the compatibility ask is '
        + 'additive, so this boundary refuses wherever the old gate refused and in more cases, '
        + 'never fewer');
      note('K8 prevents NEW product-keyed stops, so this path protects historical rows only — '
        + 'which is exactly the set that would have silently stopped halting');
    } else bad('a legacy product-keyed stop stopped halting — an operator\'s halt was silently '
      + 'dropped', JSON.stringify(stoppedByLegacyKey));
    await q(`DELETE FROM autonomy_stops WHERE scope_type='company' AND scope_key='golfnex'`);
    autonomy.resetForTests?.();

    const blindStops = { query: async (t, p) => {
      if (/autonomy_stops/i.test(t)) throw new Error('stops unreadable (fixture)');
      return q(t, p);
    } };
    const unreadableStop = await BOUNDARY.authorizeAgentAction(ctxA, {
      capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent' }, blindStops);
    if (!unreadableStop.allowed && unreadableStop.decision_rule === 'autonomy_stop_unreadable') {
      ok('an UNREADABLE stop state refuses on both paths — a decision taken while the kill state '
        + 'cannot be read is a decision taken without consulting it');
    } else bad('an unreadable kill switch was treated as clear', JSON.stringify(unreadableStop));
    autonomy.resetForTests?.();

    // ══ 9. APPROVALS AND BUDGETS ARE CONSULTED, NOT REIMPLEMENTED ═════════
    console.log('\n── 9. approvals and budgets stay where they live ──\n');

    const consequential = await BOUNDARY.authorizeAgentAction(ctxA, {
      capability: 'email.send', workflow: 'authz-wf', agent: 'executive-agent',
      consequential: true }, { ...deps, ...noStop });
    if (!consequential.allowed && consequential.decision_rule === 'needs_released_approval') {
      ok('a consequential autonomous action is refused here and pointed at the release path — this '
        + 'boundary does not substitute for an approval');
    } else bad('a consequential action was authorized by the boundary alone',
      JSON.stringify(consequential));

    const objNoBudget = await mkObjective(A, { budgetUsd: null });
    const runNoBudget = await mkRun(A, objNoBudget);
    const ctxNoBudget = door({ companyId: A, objectiveId: objNoBudget, runId: runNoBudget });
    const metered = await BOUNDARY.authorizeAgentAction(ctxNoBudget, {
      capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent',
      maxUsd: 0.01, reason: 'a metered action on a budgetless objective' },
      { ...deps, ...noStop });
    if (!metered.allowed && metered.decision_rule === 'budget_refused') {
      ok('a METERED action is refused on an objective with no authorized budget (B2.5b, via '
        + 'office/budget.js rather than a second implementation)');
    } else bad('a metered action was allowed with no budget', JSON.stringify(metered));

    const meteredOk = await BOUNDARY.authorizeAgentAction(ctxA, {
      capability: 'llm.call', workflow: 'authz-wf', agent: 'executive-agent',
      maxUsd: 0.01, reason: 'a metered action within budget' }, { ...deps, ...noStop });
    if (meteredOk.allowed && meteredOk.reservation) {
      ok('and within budget it returns the HOLD the caller must settle — the hold is the only road '
        + 'to a metered call');
    } else bad('a within-budget metered action returned no hold', JSON.stringify(meteredOk));

    const bRequires = [...bSrc.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    const reimplements = bRequires.filter((r) => /permissions\/resolve/.test(r));
    if (bRequires.some((r) => /office\/budget/.test(r))
        && bRequires.some((r) => /office\/scope/.test(r))
        && bRequires.some((r) => /office\/context/.test(r))
        && reimplements.length <= 1) {
      ok('the boundary CONSULTS office/budget, office/scope and office/context, and reaches the '
        + 'existing permissions resolver — it is a bridge, not a second model');
      note(`its dependency set: ${[...new Set(bRequires)].join(', ')}`);
    } else bad('the boundary does not compose the existing kernel', JSON.stringify(bRequires));

    // ══ 10. MUTATION: each control is load-bearing ════════════════════════
    console.log('\n── 10. mutation controls ──\n');

    const GATE = path.join(REPO, 'src', 'lib', 'agents', 'gate.js');
    const gateSrc = fs.readFileSync(GATE, 'utf8');
    if (/require\('\.\.\/authz\/boundary'\)/.test(gateSrc)) {
      ok('gate.js reaches the unified boundary — Gate 3 is satisfied by traversal of the boundary, '
        + 'not by this filename');
    } else bad('gate.js does not traverse the boundary');
    if (!/doResolve|checkStopped/.test(strip(gateSrc))) {
      ok('and it no longer contains its own resolve or kill-switch call — the logic MOVED rather '
        + 'than being duplicated, which is how legacy behaviour is preserved by construction');
    } else bad('gate.js still has its own authorization logic, so there are two of them');

    const mutations = [
      ['the company-stop ask removed from the human path',
        '  if (companyId) asks.push({ company: companyId, agent: actorAgent || undefined, capability: toolName });',
        '  if (false) asks.push({ company: companyId });'],
      ['the compatibility product-key ask removed',
        '  asks.push({ company: product, agent: actorAgent || undefined, capability: toolName });',
        '  if (false) asks.push({ company: product });'],
      ['the revocation check removed from the agent path',
        "    if (objective.status !== 'active') {",
        "    if (false && objective.status !== 'active') {"],
    ];
    const BFILE = path.join(REPO, 'src', 'lib', 'authz', 'boundary.js');
    const originalB = fs.readFileSync(BFILE, 'utf8');
    for (const [label, from, to] of mutations) {
      if (!originalB.includes(from)) { bad(`mutation control is stale: ${label}`); continue; }
      fs.writeFileSync(BFILE, originalB.replace(from, to));
      delete require.cache[require.resolve('../src/lib/authz/boundary')];
      const mutated = require('../src/lib/authz/boundary');
      let stillRefuses = null;
      try {
        if (/revocation/.test(label)) {
          const r = await mutated.authorizeAgentAction(ctxRevoked, { capability: 'llm.call',
            workflow: 'authz-wf', agent: 'executive-agent' }, { ...deps, ...noStop });
          stillRefuses = !r.allowed;
        } else {
          autonomy.resetForTests?.();
          const key = /product-key/.test(label) ? 'golfnex' : A;
          // Inserted directly for the same reason as the fixture above: K8 refuses a product key
          // through the API, and the row this mutation is about is a historical one.
          await q(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
                   VALUES ('company',$1,$2,'authz-check')
                   ON CONFLICT (scope_type, scope_key) DO UPDATE SET reason = EXCLUDED.reason`,
            [key, `authz mutation: ${label}`]);
          autonomy.resetForTests?.();
          const r = await mutated.authorizeHumanToolCall({ user: USER, product: 'golfnex',
            featureKey: 'intelligence.content.run', toolName: 'content-pipeline' },
            { ...deps, resolve: allowResolver });
          stillRefuses = !r.allowed;
          await q(`DELETE FROM autonomy_stops WHERE scope_type='company' AND scope_key=$1`, [key]);
          autonomy.resetForTests?.();
        }
      } finally {
        fs.writeFileSync(BFILE, originalB);
        delete require.cache[require.resolve('../src/lib/authz/boundary')];
        require('../src/lib/authz/boundary');
      }
      if (stillRefuses === false) ok(`MUTATION: with ${label}, the action is ALLOWED — the control is load-bearing`);
      else bad(`MUTATION: with ${label}, it still refused — that control proves nothing`, stillRefuses);
    }
    const restored = fs.readFileSync(BFILE, 'utf8');
    if (restored === originalB) ok('boundary.js restored byte-for-byte after the mutations');
    else bad('boundary.js was left mutated');

    console.log('');
  } catch (e) {
    bad('the check itself threw', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    try {
      await q(`DELETE FROM office_budget_reservations WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      await q(`DELETE FROM office_cost_ledger WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      for (const id of ids.mappings) await q(`DELETE FROM product_companies WHERE id = $1`, [id]).catch(() => {});
      for (const id of ids.runs) await q(`DELETE FROM agent_runs WHERE run_id = $1`, [id]).catch(() => {});
      for (const id of ids.objectives) await q(`DELETE FROM objectives WHERE id = $1`, [id]).catch(() => {});
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]).catch(() => {});
      const leftMaps = (await q(`SELECT COUNT(*)::int n FROM product_companies WHERE id = ANY($1)`,
        [ids.mappings])).rows[0].n;
      const leftObjs = (await q(`SELECT COUNT(*)::int n FROM objectives WHERE id = ANY($1)`,
        [ids.objectives])).rows[0].n;
      if (leftMaps === 0 && leftObjs === 0) ok('cleanup: my fixtures are gone');
      else bad('cleanup leaked fixtures', { mappings: leftMaps, objectives: leftObjs });
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    cluster.destroy();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the unified authorization boundary does not yet hold.');
    process.exit(1);
  }
  console.log('\nPASS  Decision 1: one authorization boundary serves both human-initiated product '
    + 'operations and autonomous runs; a product is resolved to a company only through an explicit '
    + 'authorized mapping, and every non-answer refuses by name; no user is invented for an '
    + 'autonomous execution and no company is invented for a product; legacy decisions are '
    + 'unchanged and existing product-keyed stops still halt; company scope, capability, STOP, '
    + 'revocation, approvals and budgets are each enforced by the module that owns them; and every '
    + 'control is mutation-proved load-bearing.');
  process.exit(0);
})();
