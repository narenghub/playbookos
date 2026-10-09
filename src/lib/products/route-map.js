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
//   '<product>'       abiozen | golfnex | favly | linkabl | aros | sitenex. The caller must hold
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
//                     data. Generic on purpose, so sitenex_deals/:id and friends reuse it.
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

//
// ── AUDIT: WHAT DATA EACH 'shared' ROUTE READS (2026-09-29) ───────────────────
// A 'shared' route means "safe for anyone with a login" — but a ROUTE can be genuinely shared while
// the TABLE behind it is product-bearing. That is not a classification error; it is a second job the
// middleware cannot do, because the boundary decides whether a REQUEST is admitted and never filters
// rows. The notifications leak was exactly this, so every shared route was audited once by hand:
// which tables does its handler read, and does any of them carry a `product` column?
//
// Tables that carry `product`: content_queue, event_sources, ingested_events, notifications,
// outreach, prospects, user_products.
//
//   route                                  tables                              product column?
//   GET  /health                           (none)                              —
//   GET  /sitemap.xml                      (static)                            —
//   GET  *                                 (static SPA)                        —
//   POST /api/auth/login                   users                               no
//   POST /api/auth/accept-invite           users, invites                      no
//   GET  /api/auth/me                      users                               no
//   PUT  /api/auth/password                users                               no
//   PUT  /api/users/profile                users                               no
//   GET  /api/activity/my                  activity_log        (own rows)      no
//   POST /api/activity                     activity_log        (own rows)      no
//   GET  /api/dashboard/my                 tasks, kpis, activity_log (own)     no
//   GET  /api/agent/tasks/my               agent_tasks         (own rows)      no
//   PUT  /api/agent/tasks/:id              agent_tasks                         no
//   GET  /api/goals/my-week                goals, kpis         (own rows)      no
//   GET  /api/performance/my               kpis, activity_log  (own rows)      no
//   PUT  /api/kpis/:id/progress            kpis                                no
//   GET  /api/outreach                     outreach                            YES → scoped
//   PUT  /api/outreach                     outreach + the entity's own table    YES → scoped, row-checked
//   GET  /api/outreach/summary             outreach                            YES → scoped
//   GET  /api/outreach/activity            outreach, outreach_events           YES → scoped
//   GET  /api/outreach/overview            outreach, outreach_events           YES → scoped
//   GET  /api/outreach/history             outreach, outreach_events           YES → scoped
//   GET  /api/outreach/vocabulary          (none — constants)                  —
//   GET  /api/outreach/tasks               outreach, sitenex_deals, sitenex_intake  YES → scoped, partner-scoped
//   GET  /api/notifications                notifications                       YES → scoped
//   PUT  /api/notifications/:id/read       notifications                       YES → scoped
//   POST /api/notifications/read-all       notifications                       YES → scoped
//
// 9 of 26. The other 17 are either user-scoped by `user_id` already or hold no product data at all;
// prospects, content_queue, ingested_events and event_sources appear in no shared handler. The three
// notification routes stay 'shared' — reclassifying them 'internal' would hide a product's own alerts
// from the people running that product — and scope their DATA instead, via
// src/lib/products/held.js (productScopeSql). A NULL product is platform-wide and needs 'internal'.
//
// WHEN ADDING A SHARED ROUTE: if its handler touches a table in the list above, it must scope by
// product in the WHERE clause. The route being shared is not the question; the data is.

// ── genuinely neutral: safe for anyone with a login ───────────────────────────
const SHARED = [
  // app shell + infrastructure
  'GET /health', 'GET /sitemap.xml', 'GET *',
  // THE CLIENT'S INTAKE PAGE, and the one route here that is PUBLIC rather than merely login-safe: a
  // client holding an emailed link has no account at all. Classified explicitly because absence must
  // never mean neutral, and 'shared' for the same reason POST /api/auth/login is — the page itself
  // carries no data, and the token is checked on every API call the page makes.
  //
  // The /api/intake/* routes it calls are deliberately NOT in this map. They are mounted ABOVE this
  // gate in server.js (they have to be — there is no req.user to resolve a product from), so a
  // classification here would be a statement about routes the boundary never sees. What guards them is
  // src/lib/sitenex/intake-mount.test.js, which asserts the mount order and that every path in that
  // router begins with /intake.
  'GET /intake',
  // authentication and own account
  'POST /api/auth/login', 'POST /api/auth/accept-invite', 'GET /api/auth/me', 'PUT /api/auth/password',
  'PUT /api/users/profile',
  // self-service: a user's own tasks, KPIs, performance, activity
  'GET /api/activity/my', 'POST /api/activity', 'GET /api/dashboard/my',
  'GET /api/agent/tasks/my', 'PUT /api/agent/tasks/:id',
  'GET /api/goals/my-week', 'GET /api/performance/my', 'PUT /api/kpis/:id/progress',
  // own notifications
  'GET /api/notifications', 'PUT /api/notifications/:id/read', 'POST /api/notifications/read-all',
  // OUTREACH STATUS. Shared for the same reason as notifications: every list has one of these, the route
  // is safe for anyone with a login, and the `outreach` table carries a product column — so the DATA is
  // scoped (src/lib/outreach uses productScopeSql) and the WRITE additionally checks the product of the
  // ROW it is annotating, which the route's own product cannot express.
  'GET /api/outreach', 'PUT /api/outreach', 'GET /api/outreach/summary',
  'GET /api/outreach/activity', 'GET /api/outreach/overview', 'GET /api/outreach/history',
  'GET /api/outreach/vocabulary',
  // My Tasks, derived from the caller's own outreach rows. 'shared' for the same reason as the rest: the route
  // is safe for anyone with a login and the DATA is scoped by product AND by partner underneath.
  'GET /api/outreach/tasks',
];

// ── internal: not one product's, but not for an outside account either ────────
// A pseudo-product in user_products. Granted to every internal user by the backfill; a partner
// account is simply never granted it, so a tier mistake alone cannot expose any of this.
const INTERNAL = [
  // people, roles, access
  'GET /api/users', 'POST /api/users/invite', 'PUT /api/users/:id', 'DELETE /api/users/:id',
  'PUT /api/users/:id/toggle-status', 'POST /api/users/send-onboarding', 'POST /api/users/send-task-nudge',
  'POST /api/admin/users/:user_id/edit-name', 'POST /api/admin/users/:user_id/reset-password',
  // Product assignment for an existing user. 'internal' rather than anything cleverer: deciding what
  // another account may reach is platform administration, not work on a product.
  'GET /api/users/:id/products', 'PUT /api/users/:id/products',
  // GET /api/roles is the ROLE CATALOG, and it stays internal. It was briefly reclassified 'shared',
  // because buildNav() fetched it on every page load to learn the caller's tiers and a 403 made the nav
  // MORE permissive. The right fix was to stop the nav depending on a separate fetch at all — tiers now
  // arrive on /auth/me — so the only remaining consumer is the team page, which is admin-only.
  'GET /api/admin/adoption', 'GET /api/roles', 'POST /api/roles',
  'GET /api/products/grantable',
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
  // The floor work: which molecules sit behind a holder's count, who was met, and the follow-up.
  // Abiozen, like the rest of the CPHI surface — the event is an Abiozen sourcing trip.
  'GET /api/events/cphi/exhibitors/:id/molecules', 'GET /api/events/cphi/molecule-search',
  'GET /api/events/cphi/contacts', 'POST /api/events/cphi/contacts',
  'PUT /api/events/cphi/exhibitors/:id/meeting', 'POST /api/events/cphi/contacts/:id/email',
  // The generalised event surface. `GET /api/events` is the registry (which events exist, their
  // roles); `/api/events/:slug/sponsors` is the SCOPE Europe target list, ranked from
  // clinical_studies. Abiozen, like the rest of the event work: the trip is an Abiozen trip, and
  // the AROS and LinkAble tabs are prospect lists held in PlayNexa, not the AROS product itself.
  //
  // These must be listed BEFORE any broader '/api/events/*' pattern would be considered, and they
  // are listed concretely because an unclassified route 403s for every user under enforce — which
  // is exactly what the completeness guard caught when these were first mounted.
  'GET /api/events', 'GET /api/events/:slug/sponsors',
  'POST /api/algolia/sync', 'POST /api/algolia/sync-abiozen',
  // Abiozen's own store SEO and LinkedIn presence
  'GET /api/seo/*', 'POST /api/seo/*',
  'GET /api/linkedin/*', 'POST /api/linkedin/*', 'PUT /api/linkedin/*',
  // LabConnect: the QC testing lab directory and each lab's own price list. Abiozen's product, on
  // the same shelf as market intelligence and research institutions — NOT a SiteNex surface, which
  // is why it is here and not in the sitenex list.
  'GET /api/labconnect/*', 'POST /api/labconnect/*', 'PUT /api/labconnect/*',
];

// ── per-product ───────────────────────────────────────────────────────────────
const GOLFNEX = [
  // Content Studio is GolfNex's content pipeline.
  'GET /api/content', 'GET /api/content/:id', 'PUT /api/content/:id', 'POST /api/content/run',
];
const AROS = ['GET /api/aros/establishments'];
const SITENEX = [
  // The SiteNex screens. Wildcarded deliberately: everything under /api/sitenex is SiteNex by
  // construction, and a new route there needs no map edit to be correctly classified.
  'GET /api/sitenex/*', 'POST /api/sitenex/*', 'PUT /api/sitenex/*', 'DELETE /api/sitenex/*',
];

// ── the product is in the request ─────────────────────────────────────────────
// /api/prospects serves golfnex, favly, linkabl AND sitenex off one table, selected by `product`.
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
for (const r of SITENEX) ROUTE_PRODUCT[r] = 'sitenex';
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

const PRODUCTS = ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex'];
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
  SHARED, INTERNAL, ABIOZEN, GOLFNEX, AROS, SITENEX, PARAM_PRODUCT };
