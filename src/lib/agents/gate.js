// PlaybookOS — Tool-call GATE + AUDIT (E2, steps 2 & 4)
//
// Wires the dormant governance into agent execution AND outbound tool calls, reusing the
// pieces the diagnostic found already-built: resolve() (HTTP-free authz), fireDenial
// (HTTP-agnostic denial log), the contract registry (agent/tool → featureKey/product), and
// the tool_call_audit sink. One authz path, one audit path, two execution strategies:
//   • callAgent — runs a LOCAL registered agent (entry.run(ctx))
//   • callTool  — calls a REMOTE product MCP tool (mcp.js over http.js, private-network only)
// Both funnel through the private gated() spine below.
//
// NEVER THROWS. The audit write is fire-and-forget (swallows sync + async failures), so a
// broken audit table can't affect a result. No spend enforcement yet (cost is recorded, not
// capped). Scope of the remote side: proven with an injected mcp client — there is no live
// GolfNex MCP server yet.

const { getAgent, getRemoteTool } = require('./contract');
const { resolve } = require('../permissions/resolve');
const { fireDenial } = require('../permissions/enforce');
const { getOutboundCredential } = require('../outbound/credentials');
const { callMcpTool } = require('../outbound/mcp');

let _query = null;
function queryFn() { if (!_query) _query = require('../db').query; return _query; }
function nowMs(deps) { return (deps && typeof deps.now === 'function') ? deps.now() : Date.now(); }

// Fire-and-forget audit write — NEVER throws, NEVER awaited. Sync + async failures swallowed.
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
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* swallow */ }
}

// Pull cost/tokens from a summary where the agent exposes them ({ cost_usd, tokens:{input,output} }).
function costFrom(summary) {
  const s = summary || {}, t = s.tokens || {};
  return {
    cost_usd: typeof s.cost_usd === 'number' ? s.cost_usd : null,
    tokens_input: typeof t.input === 'number' ? t.input : null,
    tokens_output: typeof t.output === 'number' ? t.output : null,
  };
}

// ── the shared governance spine ─────────────────────────────────────────────────
// resolve() authorise → on DENY audit(decision='deny') + fireDenial, no execution → on
// ALLOW run execute(), time it, audit the outcome. execute() returns a normalized
// { success, output, error?, cost_usd?, tokens_input?, tokens_output? } and must never throw
// (gated guards it anyway). Returns { allowed, output, audit }.
async function gated(spec) {
  const {
    user, featureKey, product, tenantId = null, toolName, actorAgent = null, args = {},
    idempotencyKey = null, denialMethod = 'AGENT', execute, deps = {},
  } = spec;
  const q = deps.query || queryFn();
  const doResolve = deps.resolve || resolve;
  const doDenial = deps.fireDenial || fireDenial;
  const doAudit = deps.fireAudit || fireAudit;
  const actor_user_id = (user && user.id) || null;
  const role = (user && user.role) || null;

  const base = {
    actor_user_id, actor_agent: actorAgent, product, tenant_id: tenantId,
    tool_name: toolName, feature_key: featureKey || null, args, idempotency_key: idempotencyKey,
    cost_usd: null, tokens_input: null, tokens_output: null, latency_ms: null,
  };

  try {
    // Authorise (reuse resolve; fail CLOSED on a resolver error — audited, not thrown).
    let decision;
    try { decision = await doResolve(user || {}, featureKey, deps.resolveDeps || {}); }
    catch (e) { decision = { allowed: false, rule: null, explain: 'resolver error: ' + (e && e.message ? e.message : String(e)) }; }
    const allowed = !!(decision && decision.allowed === true);

    if (!allowed) {
      const audit = { ...base, result: null, success: false, error: null, decision: 'deny',
        decision_rule: decision ? decision.rule : null, decision_explain: decision ? decision.explain : null };
      doAudit(q, audit);
      try {
        doDenial(q, { user_id: actor_user_id, role, feature_key: featureKey,
          method: denialMethod, path: toolName, resolver_rule: audit.decision_rule, resolver_explain: audit.decision_explain });
      } catch (_) { /* fireDenial is itself never-throws */ }
      return { allowed: false, output: null, audit };
    }

    // Execute the strategy, time it, audit the outcome.
    const t0 = nowMs(deps);
    let ex;
    try { ex = await execute(); }
    catch (e) { ex = { success: false, output: null, error: (e && e.message) ? e.message : String(e) }; }
    ex = ex || {};
    const latency_ms = Math.max(0, Math.round(nowMs(deps) - t0));
    const success = ex.success === true && !ex.error;

    const audit = { ...base, result: ex.output != null ? ex.output : null, success, error: ex.error || null,
      decision: 'allow', decision_rule: decision.rule, decision_explain: decision.explain, latency_ms,
      cost_usd: ex.cost_usd != null ? ex.cost_usd : null,
      tokens_input: ex.tokens_input != null ? ex.tokens_input : null,
      tokens_output: ex.tokens_output != null ? ex.tokens_output : null };
    doAudit(q, audit);
    return { allowed: true, output: ex.output != null ? ex.output : null, audit };
  } catch (e) {
    const audit = { ...base, result: null, success: false,
      error: 'gate error: ' + (e && e.message ? e.message : String(e)),
      decision: 'deny', decision_rule: null, decision_explain: 'unexpected gate error' };
    try { doAudit(q, audit); } catch (_) {}
    return { allowed: false, output: null, audit };
  }
}

// ── callAgent — gate a LOCAL registered agent run ───────────────────────────────
async function callAgent(user, agentName, opts = {}) {
  const { product, args = {}, deps = {}, idempotencyKey = null, tenantId = null } = opts;
  const entry = getAgent(agentName);
  const prod = product || (entry && entry.product) || 'unknown';

  // Unknown agent — deny, never execute (registry concern, handled before the spine).
  if (!entry) {
    const q = deps.query || queryFn();
    const doAudit = deps.fireAudit || fireAudit;
    const audit = { actor_user_id: (user && user.id) || null, actor_agent: agentName, product: prod, tenant_id: tenantId,
      tool_name: agentName, feature_key: null, args, idempotency_key: idempotencyKey,
      result: null, success: false, error: `unknown agent '${agentName}'`, decision: 'deny',
      decision_rule: null, decision_explain: 'agent not in contract registry',
      cost_usd: null, tokens_input: null, tokens_output: null, latency_ms: null };
    doAudit(q, audit);
    return { allowed: false, summary: null, audit };
  }

  const r = await gated({
    user, featureKey: entry.featureKey, product: prod, tenantId, toolName: agentName,
    actorAgent: agentName, args, idempotencyKey, denialMethod: 'AGENT', deps,
    execute: async () => {
      try {
        const summary = await entry.run({ user: user || null, product: prod, deps, args });
        return { success: true, output: summary, ...costFrom(summary) };
      } catch (e) {
        return { success: false, output: null, error: (e && e.message) ? e.message : String(e) };
      }
    },
  });
  return { allowed: r.allowed, summary: r.output, audit: r.audit };
}

// ── callTool — gate a REMOTE product MCP tool call ──────────────────────────────
// Transport failure and JSON-RPC tool error are BOTH success=false, recorded distinctly in
// the audit error field ("transport: …" vs "tool_error: …").
async function callTool(user, opts = {}) {
  const { product, server, toolName, args = {}, tenantId = null, deps = {}, idempotencyKey = null, actorAgent = null, timeoutMs } = opts;
  const q = deps.query || queryFn();
  const doAudit = deps.fireAudit || fireAudit;
  const getTool = deps.getRemoteTool || getRemoteTool;
  const env = deps.env || process.env;

  const tool = getTool(product, toolName, { env });

  // Unknown remote tool — deny, never call out (registry concern, before the spine).
  if (!tool) {
    const audit = { actor_user_id: (user && user.id) || null, actor_agent: actorAgent, product: product || 'unknown', tenant_id: tenantId,
      tool_name: toolName || null, feature_key: null, args, idempotency_key: idempotencyKey,
      result: null, success: false, error: `unknown remote tool '${product}/${toolName}'`, decision: 'deny',
      decision_rule: null, decision_explain: 'tool not in remote-tool registry',
      cost_usd: null, tokens_input: null, tokens_output: null, latency_ms: null };
    doAudit(q, audit);
    return { allowed: false, result: null, audit };
  }

  const serverUrl = server || tool.server;
  const r = await gated({
    user, featureKey: tool.featureKey, product, tenantId, toolName, actorAgent, args, idempotencyKey,
    denialMethod: 'TOOL', deps,
    execute: async () => {
      const getCred = deps.getOutboundCredential || getOutboundCredential;
      const cred = getCred(product, 'mcp', { env });
      if (cred.error) return { success: false, output: null, error: 'credential: ' + cred.error };
      const callMcp = deps.callMcpTool || callMcpTool;
      const meta = { product, tenant_id: tenantId, on_behalf_of: (user && user.id) || null, actor_agent: actorAgent };
      const resp = await callMcp({ serverUrl, credential: cred, toolName, args, meta, timeoutMs, deps });
      if (resp.error) {
        // distinguish an unreachable/HTTP/timeout failure from a tool that ran and errored
        return { success: false, output: null, error: (resp.transport ? 'transport: ' : 'tool_error: ') + resp.error };
      }
      return { success: true, output: resp.result };
    },
  });
  return { allowed: r.allowed, result: r.output, audit: r.audit };
}

module.exports = { callAgent, callTool, gated, fireAudit, costFrom };
