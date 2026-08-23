// PlaybookOS — Agent Contract & Registry (E2, step 1)
//
// The first agent abstraction to orchestrate against. A declarative registry where each
// entry is a thin ADAPTER over an EXISTING agent entry point — no existing agent is modified
// and nothing imports this file yet. This replaces "there is no agent abstraction" with one
// uniform, invokable shape the future MCP orchestrator can dispatch through.
//
// Entry shape:
//   { name, product, featureKey, inputSchema, costClass, run(ctx) }
//     name       — unique registry key.
//     product    — REQUIRED on every entry, even where it is constant today. This is the
//                  single most important field: agent_activity_log (and the governance
//                  tables) have NO product column, so attributing runs per-product later
//                  would mean migrating every table. Carry it from day one. For a genuinely
//                  multi-product agent it is the DEFAULT product; a caller may override it
//                  per run via ctx.product.
//     featureKey — a key in src/lib/permissions/registry.js, so authorisation and cost
//                  INHERIT from the permission model rather than being reinvented. Validated
//                  against the registry at load time; an unknown key fails fast.
//     inputSchema— a plain-object description of args (NOT a validation library, for now).
//     costClass  — the registry feature's cost tier, copied for quick reference; verified to
//                  match the referenced feature at load time.
//     run(ctx)   — async ({ user, product, deps, args }) -> summary. Adapts the underlying
//                  entry point. `deps` is injected (following content/index.js, the only
//                  existing agent already in this shape); each adapter also accepts an
//                  injected entry-point via deps (a test seam) so the contract can be
//                  exercised without touching or executing the real agent.

const { FEATURES } = require('../permissions/registry');

const FEATURE_BY_KEY = new Map(FEATURES.map(f => [f.key, f]));

// ── validation (plain, no schema library) ──────────────────────────────────────
function validateEntry(entry) {
  const errs = [];
  if (!entry || typeof entry !== 'object') return ['entry must be an object'];
  if (!entry.name || typeof entry.name !== 'string') errs.push('name is required (non-empty string)');
  if (!entry.product || typeof entry.product !== 'string') errs.push('product is required (non-empty string) on every entry');
  if (!entry.featureKey || typeof entry.featureKey !== 'string') {
    errs.push('featureKey is required (string)');
  } else if (!FEATURE_BY_KEY.has(entry.featureKey)) {
    errs.push(`featureKey '${entry.featureKey}' not found in permissions registry`);
  } else if (entry.costClass != null && entry.costClass !== FEATURE_BY_KEY.get(entry.featureKey).cost) {
    errs.push(`costClass '${entry.costClass}' != registry cost '${FEATURE_BY_KEY.get(entry.featureKey).cost}' for ${entry.featureKey}`);
  }
  if (typeof entry.run !== 'function') errs.push('run must be a function');
  if (entry.inputSchema != null && (typeof entry.inputSchema !== 'object' || Array.isArray(entry.inputSchema))) {
    errs.push('inputSchema must be a plain object');
  }
  return errs;
}

// ── the two registered agents (adapters over existing entry points) ────────────
const REGISTRY = [
  {
    // Reference adapter: content/index.js is already deps-injected + product-aware.
    name: 'content-pipeline',
    product: 'golfnex', // DEFAULT product; multi-product — override per run via ctx.product
    featureKey: 'intelligence.content.run',
    costClass: 'high',
    inputSchema: {
      product: 'string — tenant to run for (e.g. "golfnex"); defaults to ctx.product',
      dryRun: 'boolean — optional; when true, generate but do not persist',
    },
    run: async ({ product, deps = {}, args = {} }) => {
      const impl = deps.runContentPipeline || require('./content').runContentPipeline;
      return impl(product, { dryRun: !!args.dryRun, deps });
    },
  },
  {
    // Proof the contract fits an agent NOT written for it: research-intelligence/index.js
    // is neither deps-injected nor product-aware. The adapter maps ctx -> its options and
    // attributes the run to the fixed product 'abiozen'.
    name: 'research-intelligence',
    product: 'abiozen',
    featureKey: 'intelligence.research_intelligence.run',
    costClass: 'high',
    inputSchema: {
      maxStudies: 'number — optional; default 50 (nightly)',
      dryRun: 'boolean — optional; when true, no persistence',
    },
    run: async ({ deps = {}, args = {} }) => {
      const impl = deps.runResearchIntelIngest || require('./research-intelligence').runResearchIntelIngest;
      const opts = { dryRun: !!args.dryRun };
      if (args.maxStudies != null) opts.maxStudies = args.maxStudies;
      return impl(opts);
    },
  },
];

// ── remote (MCP) tool registry ─────────────────────────────────────────────────
// Keyed { product → { toolName → { featureKey, serverEnv } } }. featureKey references the
// permissions registry (a surface:'mcp_tool' entry) so callTool authorises via the same
// resolve() path as local agents. server URL is read from serverEnv at call time (env-driven,
// private-network URL) — not baked in — mirroring the outbound credential accessor. There is
// no GolfNex MCP server yet, so GOLFNEX_MCP_URL is unset today (callTool then fails as a
// transport error, audited as such).
const REMOTE_TOOLS = {
  golfnex: {
    publish_post: { featureKey: 'golfnex.content.publish_post', serverEnv: 'GOLFNEX_MCP_URL' },
  },
};

function getRemoteTool(product, toolName, { env = process.env } = {}) {
  const t = REMOTE_TOOLS[product] && REMOTE_TOOLS[product][toolName];
  if (!t) return null;
  return { product, toolName, featureKey: t.featureKey, serverEnv: t.serverEnv, server: env[t.serverEnv] || null };
}

// ── build + validate the registry at load (fail fast on a bad entry) ────────────
const AGENTS = new Map();
for (const e of REGISTRY) {
  const errs = validateEntry(e);
  if (errs.length) throw new Error(`Invalid agent registry entry '${e && e.name}': ${errs.join('; ')}`);
  if (AGENTS.has(e.name)) throw new Error(`Duplicate agent name '${e.name}'`);
  AGENTS.set(e.name, e);
}

// validate every remote-tool featureKey against the permissions registry (fail fast)
for (const [product, tools] of Object.entries(REMOTE_TOOLS)) {
  for (const [toolName, t] of Object.entries(tools)) {
    if (!FEATURE_BY_KEY.has(t.featureKey)) {
      throw new Error(`Remote tool '${product}/${toolName}' references unknown featureKey '${t.featureKey}'`);
    }
  }
}

// ── accessors ──────────────────────────────────────────────────────────────────
function getAgent(name) { return AGENTS.get(name) || null; }

// Metadata for every agent, WITHOUT the run function (safe to expose/serialize).
function listAgents() {
  return [...AGENTS.values()].map(({ run, ...meta }) => ({ ...meta }));
}

// The permission-registry feature backing an agent (cost/spend/dangerous/defaultDeny).
function featureFor(name) {
  const e = AGENTS.get(name);
  return e ? (FEATURE_BY_KEY.get(e.featureKey) || null) : null;
}

// Invoke a registered agent through the contract. ctx = { user, product, deps, args }.
// product resolves to ctx.product || the entry's declared product. Throws clearly on an
// unknown name (authorisation via featureKey is the orchestrator's job, not this runner's).
async function runAgent(name, ctx = {}) {
  const entry = AGENTS.get(name);
  if (!entry) throw new Error(`Unknown agent '${name}'. Registered: ${[...AGENTS.keys()].join(', ') || '(none)'}`);
  const product = ctx.product || entry.product;
  return entry.run({ user: ctx.user || null, product, deps: ctx.deps || {}, args: ctx.args || {} });
}

module.exports = { REGISTRY, AGENTS, validateEntry, getAgent, listAgents, featureFor, runAgent, REMOTE_TOOLS, getRemoteTool };
