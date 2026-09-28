// PlaybookOS — PRODUCT BOUNDARY, part 1: the route → product map.
//
// THIS FILE IS THE SECURITY MODEL WRITTEN DOWN. Read it as such.
//
// Every mounted Express route is classified here. Keyed by `METHOD /path` using the same
// METHOD + path convention as the permissions registry (registry.js `ref` fields), so there is
// one convention to learn rather than two. Express params appear as written (`:id`).
//
// VALUES
//   'shared'          genuinely neutral: safe for anyone with a login. Health, auth, own-account
//                     self-service, notifications, the SPA shell. The role/tier gate still runs.
//   'internal'        not about one product, but NOT safe for an outside account: the user list,
//                     role administration, meeting notes, integrations, agent plumbing. 'internal'
//                     is a PSEUDO-PRODUCT in user_products — every internal user is granted it by
//                     the backfill; a partner account simply is not.
//                     Why this is separate from 'shared': "safe because a partner role would carry
//                     no tiers" leans on a role definition nobody has written. Someone grants a
//                     tier for a good reason in four months and the user list becomes reachable,
//                     with no moment where anyone decided that. Two gates that fail INDEPENDENTLY
//                     is the point — a tier mistake must not be sufficient to become an exposure.
//                     Deliberately NOT called 'platform': that is already a nav product key, and
//                     conflating a nav grouping with a security class is how this gets confusing.
//   '<product>'       abiozen | golfnex | favly | linkabl | aros | acbm. The caller must hold
//                     that product in user_products.
//   'param:product'   the product is in the request — query `?product=`, or `body.product`. The
//                     resolver reads it and checks THAT product. A request naming no product
//                     resolves to the route's documented default (see PARAM_DEFAULT below).
//   'param:agent'     `/agent/mission-control/:key/run` runs an agent by key, and agents belong to
//                     different products, so the product comes from AGENT_PRODUCT below. That
//                     lookup can itself yield 'param:product' (the prospecting agent), so
//                     resolution is NESTED and must resolve THROUGH to a real product — never
//                     compare the literal string 'param:product' against user_products.
//   'row:<table>.<col>'  the request carries no product at all; the ROW does. Fetch the row by
//                     :id and read that column. Used by `GET|PUT /api/prospects/:id`, where a
//                     guessed id would otherwise read — or with PUT, MODIFY — another product's
//                     data. Generic on purpose, so acbm_deals/:id and friends reuse it.
//
// ABSENCE IS NOT NEUTRALITY. A route missing from this map is UNCLASSIFIED, which the
// completeness test fails on. Collapsing "neutral" and "nobody has looked at this yet" into the
// same state is exactly what makes a completeness test rot — so 'shared' is always explicit.
//
// WILDCARDS. `'GET /api/apollo/*': 'abiozen'` covers a whole prefix where every route under it
// has the same product. Where a prefix is MIXED (`/api/events/*`, `/api/prospects/*`) the routes
// are listed individually, because that is where a wildcard would quietly mis-classify a route
// added later. Exact keys always win over wildcards; the longest wildcard wins among wildcards.
//
// A NOTE ON 'shared' AND FUTURE PARTNER ACCOUNTS. Because the role/tier gate still applies,
// marking internal routes 'shared' does not expose them to an outside account TODAY — a partner
// role would carry no tiers and `requireTier` would refuse. It does mean the product boundary is
// not the only thing standing between a partner and, say, `/api/users`. When a partner role is
// created, check BOTH layers, and consider whether the internal 'shared' block below should
// become its own value.

// ── genuinely neutral: safe for anyone with a login ───────────────────────────
const SHARED = [
  // app shell + infrastructure
  'GET /health', 'GET /sitemap.xml', 'GET *',
  // authentication and own account
  'POST /api/auth/login', 'POST /api/auth/accept-invite', 'GET /api/auth/me', 'PUT /api/auth/password',
  'PUT /api/users/profile',
  // self-service: a user's own tasks, KPIs, performance, activity
  'GET /api/activity/my', 'POST /api/activity', 'GET /api/dashboard/my',
  'GET /api/agent/tasks/my', 'PUT /api/agent/tasks/:id',
  'GET /api/goals/my-week', 'GET /api/performance/my', 'PUT /api/kpis/:id/progress',
  // own notifications
  'GET /api/notifications', 'PUT /api/notifications/:id/read', 'POST /api/notifications/read-all',
];

// ── internal: not one product's, but not for an outside account either ────────
// A pseudo-product in user_products. Granted to every internal user by the backfill; a partner
// account is simply never granted it, so a tier mistake alone cannot expose any of this.
const INTERNAL = [
  // people, roles, access
  'GET /api/users', 'POST /api/users/invite', 'PUT /api/users/:id', 'DELETE /api/users/:id',
  'PUT /api/users/:id/toggle-status', 'POST /api/users/send-onboarding', 'POST /api/users/send-task-nudge',
  'POST /api/admin/users/:user_id/edit-name', 'POST /api/admin/users/:user_id/reset-password',
  'GET /api/admin/adoption', 'GET /api/roles', 'POST /api/roles',
  // company targets + milestones
  'GET /api/targets', 'POST /api/targets', 'GET /api/milestones', 'PUT /api/milestones/:id',
  'DELETE /api/milestones/duplicates',
  // team management: performance, goals, activity, task assignment
  'GET /api/activity/team', 'GET /api/performance/team', 'GET /api/performance/scores',
  'GET /api/performance/alerts', 'GET /api/performance/history/:userId', 'POST /api/performance/calculate',
  'GET /api/employee-activity/:user_id', 'GET /api/goals/team-week', 'POST /api/goals/assign-kpis',
  'POST /api/goals/cascade', 'GET /api/agent/tasks/team', 'POST /api/agent/tasks/assign',
  'POST /api/agent/tasks/generate', 'POST /api/agent/tasks/ai-generate', 'POST /api/agent/tasks/ai-commit',
  // agent plumbing and integrations
  'GET /api/agent/activity', 'GET /api/agent/approvals', 'PUT /api/agent/approvals/:id',
  'GET /api/agent/dependencies', 'GET /api/agent/mission-control', 'GET /api/agent/overview',
  'GET /api/execution-steps', 'PUT /api/execution-steps/:id',
  'GET /api/decision-rules', 'POST /api/decision-rules/evaluate', 'POST /api/triggers/check',
  'POST /api/github/sync', 'GET /api/integrations',
  // the company's own meeting notes and standups
  'GET /api/meetings', 'GET /api/meetings/:id', 'GET /api/meetings/:id/tasks', 'GET /api/meetings/dashboard',
  'GET /api/meetings/workspace-activity', 'POST /api/meetings/:id/transcript', 'POST /api/meetings/poll-gemini',
  'POST /api/meetings/run', 'POST /api/meetings/standup', 'POST /api/meetings/sync-workspace',
  'POST /api/meetings/upload-transcript', 'PUT /api/meetings/tasks/:id',
];

// ── Abiozen: the pharma business — revenue, buyers, molecules, its own marketing ──
const ABIOZEN = [
  // revenue, orders, catalogue, company metrics
  'GET /api/orders', 'POST /api/orders', 'POST /api/orders/webhook',
  'GET /api/skus', 'POST /api/skus', 'GET /api/skus/export', 'POST /api/skus/bulk-upload',
  'GET /api/dashboard/summary', 'GET /api/dashboard/export',
  'GET /api/metrics/today', 'GET /api/metrics/history', 'GET /api/revenue/intelligence',
  'GET /api/briefing/latest', 'GET /api/ai/latest', 'POST /api/ai/analyze',
  // buyers, leads, inquiries, reorders
  'GET /api/customers/warm-leads', 'GET /api/customers/outreach-today', 'POST /api/customers/engagement-event',
  'GET /api/leads/*', 'POST /api/leads/*', 'PUT /api/leads/*', 'GET /api/leads',
  'GET /api/inquiry/*', 'POST /api/inquiry/*', 'PUT /api/inquiry/*', 'GET /api/inquiry',
  'GET /api/reorder/*', 'POST /api/reorder/*', 'PUT /api/reorder/*',
  // outbound: Apollo, the email engine, sequence templates
  'GET /api/apollo/*', 'POST /api/apollo/*', 'GET /api/sequences/templates',
  'GET /api/email-engine/*', 'POST /api/email-engine/*', 'PUT /api/email-engine/*',
  // market + research intelligence, clinical demand, institutions, patents
  'GET /api/market/*', 'POST /api/market/*', 'PUT /api/market/*',
  'GET /api/research/*', 'POST /api/research/*', 'PUT /api/research/*',
  'GET /api/research-intelligence/*', 'POST /api/research-intelligence/*',
  'GET /api/institutions', 'GET /api/growth/intelligence', 'POST /api/growth/analyze',
  // supply side: procurement, suppliers, CPHI, Algolia sync of the Abiozen catalogue
  'GET /api/procurement/*', 'POST /api/procurement/*', 'PUT /api/procurement/*',
  'GET /api/events/cphi/exhibitors', 'GET /api/events/cphi/thin-supply', 'PUT /api/events/cphi/exhibitors/:id',
  'POST /api/algolia/sync', 'POST /api/algolia/sync-abiozen',
  // Abiozen's own store SEO and LinkedIn presence
  'GET /api/seo/*', 'POST /api/seo/*',
  'GET /api/linkedin/*', 'POST /api/linkedin/*', 'PUT /api/linkedin/*',
];

// ── per-product ───────────────────────────────────────────────────────────────
const GOLFNEX = [
  // Content Studio is GolfNex's content pipeline.
  'GET /api/content', 'GET /api/content/:id', 'PUT /api/content/:id', 'POST /api/content/run',
];
const AROS = ['GET /api/aros/establishments'];
const ACBM = [
  // The ACBM screens. Wildcarded deliberately: everything under /api/acbm is ACBM by
  // construction, and a new route there needs no map edit to be correctly classified.
  'GET /api/acbm/*', 'POST /api/acbm/*', 'PUT /api/acbm/*',
];

// ── the product is in the request ─────────────────────────────────────────────
// /api/prospects serves golfnex, favly, linkabl AND acbm off one table, selected by `product`.
const PARAM_PRODUCT = [
  'GET /api/prospects', 'POST /api/prospects/run', 'POST /api/prospects/qualify',
  // Per-product event ingestion: the product comes from the Bearer secret in event_sources, which
  // the resolver reads from the body's product field (ingest.js validates the pair).
  'POST /api/events/ingest',
];
// What a `param:product` route means when the request names no product. These mirror the
// handlers' own defaults so the boundary agrees with the code rather than guessing: routes.js
// defaults `product` to 'golfnex' in all five prospects handlers.
const PARAM_DEFAULT = {
  'GET /api/prospects': 'golfnex',
  'POST /api/prospects/run': 'golfnex', 'POST /api/prospects/qualify': 'golfnex',
  'POST /api/events/ingest': null,
};

// ── the ROW carries the product ───────────────────────────────────────────────
// These take no product in the request: the :id identifies the row and the row knows its product.
// PUT is the worse of the two — a guessed id would not merely read another product's prospect, it
// would MODIFY it — so both are resolved by looking the row up. Neither may reach enforce mode
// without this lookup working.
const ROW_PRODUCT = {
  'GET /api/prospects/:id': 'row:prospects.product',
  'PUT /api/prospects/:id': 'row:prospects.product',
};
const ROUTE_PRODUCT = {};
for (const r of SHARED) ROUTE_PRODUCT[r] = 'shared';
for (const r of INTERNAL) ROUTE_PRODUCT[r] = 'internal';
for (const r of ABIOZEN) ROUTE_PRODUCT[r] = 'abiozen';
for (const r of GOLFNEX) ROUTE_PRODUCT[r] = 'golfnex';
for (const r of AROS) ROUTE_PRODUCT[r] = 'aros';
for (const r of ACBM) ROUTE_PRODUCT[r] = 'acbm';
for (const r of PARAM_PRODUCT) ROUTE_PRODUCT[r] = 'param:product';
for (const [r, v] of Object.entries(ROW_PRODUCT)) ROUTE_PRODUCT[r] = v;
// Running an agent by key: the agent decides the product.
ROUTE_PRODUCT['POST /api/agent/mission-control/:key/run'] = 'param:agent';

// Agent key → product, for 'param:agent'. Keys are the REAL MC_RUNNERS keys from
// routes.js:3717 — note the '-agent' suffixes; an earlier draft of this map invented shorter
// names and the test that should have caught it was reading the wrong block of the file.
// An unlisted key is UNRESOLVABLE, which fails closed.
const AGENT_PRODUCT = {
  'ceo-agent':           'internal',   // the CEO briefing is company-wide, not one product's
  'meet-agent':          'internal',   // internal meeting notes
  'market-intelligence': 'abiozen',
  'email-engine':        'abiozen',
  'sales-agent':         'abiozen',
  'procurement-agent':   'abiozen',
  'research-agent':      'abiozen',
  'reorder-agent':       'abiozen',
  'inquiry-agent':       'abiozen',
};

const PRODUCTS = ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'acbm'];
// 'internal' is a pseudo-product: it lives in user_products alongside the real ones, so the
// backfill and any future grant/revoke work identically for it.
const PSEUDO_PRODUCTS = ['internal'];
// Everything the backfill must grant. Derived from the map itself, not a second hand-kept list.
const GRANTABLE = [...PRODUCTS, ...PSEUDO_PRODUCTS];
const ROW_FORM = /^row:([a-z_]+)\.([a-z_]+)$/;
const VALUES = new Set(['shared', 'internal', 'param:product', 'param:agent', ...PRODUCTS,
  ...Object.values(ROW_PRODUCT)]);

// Resolve `METHOD /path` against the map. Exact key first, then the LONGEST matching wildcard, so
// an exact entry can always override a prefix. Returns null when unclassified — never 'shared'.
function classifyRoute(method, path) {
  const key = `${String(method).toUpperCase()} ${path}`;
  if (ROUTE_PRODUCT[key]) return ROUTE_PRODUCT[key];
  let best = null, bestLen = -1;
  for (const [pattern, value] of Object.entries(ROUTE_PRODUCT)) {
    if (!pattern.endsWith('/*')) continue;
    const [pm, ppath] = pattern.split(' ');
    if (pm !== String(method).toUpperCase()) continue;
    const prefix = ppath.slice(0, -1);              // keep the trailing slash
    if (key.endsWith(' ' + ppath.slice(0, -2))) { if (prefix.length > bestLen) { best = value; bestLen = prefix.length; } continue; }
    if (path.startsWith(prefix) && prefix.length > bestLen) { best = value; bestLen = prefix.length; }
  }
  return best;
}

module.exports = { ROUTE_PRODUCT, AGENT_PRODUCT, PARAM_DEFAULT, ROW_PRODUCT, ROW_FORM,
  PRODUCTS, PSEUDO_PRODUCTS, GRANTABLE, VALUES, classifyRoute,
  SHARED, INTERNAL, ABIOZEN, GOLFNEX, AROS, ACBM, PARAM_PRODUCT };
