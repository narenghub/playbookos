// PlaybookOS — Tool-call GATE + AUDIT (E2, step 2)
//
// Wires the dormant governance into agent execution. Reuses the three pieces the diagnostic
// found already-built-and-unused, rather than reinventing any of them:
//   • resolve(user, featureKey)  — HTTP-free authorisation decision (permissions/resolve.js)
//   • fireDenial(query, row)     — HTTP-agnostic denial log (permissions/enforce.js)
//   • the contract registry      — agent → featureKey/product/costClass (agents/contract.js)
// and adds the one thing that was missing: a per-tool-call audit sink (tool_call_audit).
//
//   callAgent(user, agentName, { product, args, deps, idempotencyKey })
//     -> { allowed, summary, audit }
//
// Flow: look up the agent → resolve() authorisation → on DENY audit (decision='deny') +
// fireDenial and return without executing → on ALLOW run(ctx), time it, capture cost/tokens
// from the summary, and audit either outcome (a thrown agent error becomes success=false,
// never a lost call).
//
// NEVER THROWS. The audit write is fire-and-forget (same contract as the shadow hook and
// fireDenial): a failed audit write cannot affect the agent result. Scope: LOCAL agent runs
// only — no spend enforcement, no MCP/outbound, no credential store (those are later steps).

const { getAgent } = require('./contract');
const { resolve } = require('../permissions/resolve');
const { fireDenial } = require('../permissions/enforce');

let _query = null;
function queryFn() { if (!_query) _query = require('../db').query; return _query; }
function nowMs(deps) { return (deps && typeof deps.now === 'function') ? deps.now() : Date.now(); }

// Fire-and-forget audit write — NEVER throws, NEVER awaited by the caller. Sync and async
// failures are both swallowed, so a broken/slow audit table can't affect an agent result.
function fireAudit(query, row) {
  try {
    const p = query(
      `INSERT INTO tool_call_audit
         (actor_user_id, actor_agent, product, tenant_id, tool_name, feature_key, args, result,
          success, error, decision, decision_rule, decision_explain, cost_usd, tokens_input,
          tokens_output, latency_ms, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (product, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [row.actor_user_id || null, row.actor_agent || null, row.product, row.tenant_id || null,
       row.tool_name, row.feature_key || null,
       row.args == null ? null : JSON.stringify(row.args),
       row.result == null ? null : JSON.stringify(row.result),
       !!row.success, row.error || null, row.decision,
       row.decision_rule == null ? null : row.decision_rule, row.decision_explain || null,
       row.cost_usd == null ? null : row.cost_usd,
       row.tokens_input == null ? null : row.tokens_input,
       row.tokens_output == null ? null : row.tokens_output,
       row.latency_ms == null ? null : row.latency_ms, row.idempotency_key || null]
    );
    if (p && typeof p.catch === 'function') p.catch(() => {}); // swallow async failure
  } catch (_) { /* swallow sync failure */ }
}

// Pull cost/tokens from a summary where the agent exposes them (content/RI shape:
// { cost_usd, tokens: { input, output } }). Absent → null; never throws.
function costFrom(summary) {
  const s = summary || {};
  const t = s.tokens || {};
  return {
    cost_usd: typeof s.cost_usd === 'number' ? s.cost_usd : null,
    tokens_input: typeof t.input === 'number' ? t.input : null,
    tokens_output: typeof t.output === 'number' ? t.output : null,
  };
}

async function callAgent(user, agentName, opts = {}) {
  const { product, args = {}, deps = {}, idempotencyKey = null } = opts;
  const q = deps.query || queryFn();
  const doResolve = deps.resolve || resolve;
  const doDenial = deps.fireDenial || fireDenial;
  const doAudit = deps.fireAudit || fireAudit;

  const entry = getAgent(agentName);
  const actor_user_id = (user && user.id) || null;
  const role = (user && user.role) || null;
  const feature_key = entry ? entry.featureKey : null;
  // product is ALWAYS recorded: ctx.product → entry default → 'unknown' (only for a bad name).
  const prod = product || (entry && entry.product) || 'unknown';

  const base = {
    actor_user_id, actor_agent: agentName, product: prod, tenant_id: null,
    tool_name: agentName, feature_key, args, idempotency_key: idempotencyKey,
    cost_usd: null, tokens_input: null, tokens_output: null, latency_ms: null,
  };

  try {
    // 1. Unknown agent — deny, never execute.
    if (!entry) {
      const audit = { ...base, result: null, success: false, error: `unknown agent '${agentName}'`,
        decision: 'deny', decision_rule: null, decision_explain: 'agent not in contract registry' };
      doAudit(q, audit);
      return { allowed: false, summary: null, audit };
    }

    // 2. Authorisation — reuse resolve(); no second permission model. Fail CLOSED if resolve
    //    errors (a governance gate must not execute a spend/dangerous agent when authz is
    //    indeterminate) — recorded, not thrown.
    let decision;
    try {
      decision = await doResolve(user || {}, entry.featureKey, deps.resolveDeps || {});
    } catch (e) {
      decision = { allowed: false, rule: null, explain: 'resolver error: ' + (e && e.message ? e.message : String(e)) };
    }
    const allowed = !!(decision && decision.allowed === true);

    // 3. Deny — audit + existing fireDenial, no execution.
    if (!allowed) {
      const audit = { ...base, result: null, success: false, error: null,
        decision: 'deny', decision_rule: decision ? decision.rule : null,
        decision_explain: decision ? decision.explain : null };
      doAudit(q, audit);
      try {
        doDenial(q, { user_id: actor_user_id, role, feature_key: entry.featureKey,
          method: 'AGENT', path: agentName, resolver_rule: audit.decision_rule, resolver_explain: audit.decision_explain });
      } catch (_) { /* fireDenial is itself never-throws; guard anyway */ }
      return { allowed: false, summary: null, audit };
    }

    // 4. Allow — execute, time, capture cost/tokens. A thrown error → success=false.
    const t0 = nowMs(deps);
    let summary = null, success = true, error = null;
    try {
      summary = await entry.run({ user: user || null, product: prod, deps, args });
    } catch (e) {
      success = false; error = (e && e.message) ? e.message : String(e);
    }
    const latency_ms = Math.max(0, Math.round(nowMs(deps) - t0));
    const cost = costFrom(summary);

    const audit = { ...base, result: summary, success, error,
      decision: 'allow', decision_rule: decision.rule, decision_explain: decision.explain,
      latency_ms, ...cost };
    doAudit(q, audit);
    return { allowed: true, summary, audit };
  } catch (e) {
    // Defensive: the gate itself must never throw. Record what we can, fire-and-forget.
    const audit = { ...base, result: null, success: false,
      error: 'gate error: ' + (e && e.message ? e.message : String(e)),
      decision: 'deny', decision_rule: null, decision_explain: 'unexpected gate error' };
    try { doAudit(q, audit); } catch (_) {}
    return { allowed: false, summary: null, audit };
  }
}

module.exports = { callAgent, fireAudit, costFrom };
