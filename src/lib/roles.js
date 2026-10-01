const { query } = require('./db');

// Enterprise role taxonomy — single source of truth. Each role carries:
//   level       1 = highest authority, ascending = lower
//   domain      groups directors with their teams
//   data_scope  all | team | own | own+revenue | readonly
//   pages       sidebar pages visible ('*' = all)
//   tiers       API permission tiers → access ('rw'|'r'|'w'|'own')
//   metrics     activity-log metrics this role tracks
//   baseline    daily effort baseline for performance scoring
//
// API tiers: self, sales, procurement, revenue, technical, intelligence, goals, admin, sitenex.
//
// 'sitenex' is the first tier that exists for an OUTSIDE account rather than an internal function. It
// gates only the SiteNex referral surface. It is deliberately narrow and deliberately read-only for the
// partner role: every sitenex route is a GET today, so 'rw' would pre-authorise a write route that does
// not exist yet — which is how a latent hole gets built.
// Custom roles (POST /api/roles) extend this set but get no tiers (self-only).
const ALL_PAGES = [
  'dashboard', 'command-center', 'ai-insights', 'agent-control', 'decision-engine', 'performance',
  'my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones',
  'revenue', 'sales-pipeline', 'reorder-agent', 'inquiry-agent', 'apollo-outreach',
  'market-intelligence', 'procurement-agent', 'meet-agent', 'research-agent', 'seo-intelligence', 'seo-content', 'linkedin-content', 'email-engine',
  'team', 'sku-economics', 'data-pipeline', 'execution-graph', 'settings',
];

const BUILT_IN_ROLES = {
  super_admin: {
    display_name: 'Super Admin',
    level: 1, domain: 'global', data_scope: 'all',
    pages: '*',
    tiers: { self: 'rw', sales: 'rw', procurement: 'rw', revenue: 'rw', technical: 'rw', intelligence: 'rw', goals: 'rw', admin: 'rw', sitenex: 'rw' },
    metrics: [],
    baseline: 3,
  },
  admin: {
    display_name: 'Admin',
    level: 2, domain: 'global', data_scope: 'all',
    pages: '*',
    tiers: { self: 'rw', sales: 'rw', procurement: 'rw', revenue: 'rw', technical: 'rw', intelligence: 'rw', goals: 'rw', admin: 'rw', sitenex: 'rw' },
    metrics: ['team_reviews', 'orders_entered'],
    baseline: 3,
  },
  sales_director: {
    display_name: 'Sales Director',
    level: 3, domain: 'sales', data_scope: 'team',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'revenue', 'sales-pipeline', 'reorder-agent', 'inquiry-agent', 'apollo-outreach', 'linkedin-content', 'email-engine', 'team', 'performance'],
    tiers: { self: 'rw', sales: 'rw', revenue: 'r', intelligence: 'r', goals: 'r' },
    metrics: ['team_reviews', 'deals_reviewed', 'forecast_updates'],
    baseline: 7,
  },
  recruitment_director: {
    display_name: 'Recruitment Director',
    level: 3, domain: 'recruitment', data_scope: 'team',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'team', 'performance'],
    tiers: { self: 'rw', intelligence: 'r', goals: 'r' },
    metrics: ['team_reviews', 'offers_approved', 'pipeline_reviews'],
    baseline: 3,
  },
  procurement_director: {
    display_name: 'Procurement Director',
    level: 3, domain: 'procurement', data_scope: 'team',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'market-intelligence', 'sku-economics', 'team', 'performance'],
    tiers: { self: 'rw', procurement: 'rw', revenue: 'r', intelligence: 'r', goals: 'r' },
    metrics: ['team_reviews', 'suppliers_approved', 'market_analyses'],
    baseline: 3,
  },
  account_manager: {
    display_name: 'Account Manager',
    level: 4, domain: 'sales', data_scope: 'own+revenue',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'revenue'],
    tiers: { self: 'rw', sales: 'r', revenue: 'rw' },
    metrics: ['accounts_managed', 'quotes_sent', 'orders_processed'],
    baseline: 12,
  },
  business_dev: {
    // BD managers who work Clinical Demand Intelligence: keep their sales tools
    // (sales:own) + full Clinical Demand Intelligence access (intelligence:rw).
    // Scoped — NO admin/settings/team/financial tiers.
    display_name: 'Business Development',
    level: 4, domain: 'sales', data_scope: 'own',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'apollo-outreach'],
    tiers: { self: 'rw', sales: 'own', intelligence: 'rw' },
    metrics: ['outreach_emails', 'accounts_managed', 'quotes_sent'],
    baseline: 12,
  },
  sales_team: {
    display_name: 'Sales Team',
    level: 5, domain: 'sales', data_scope: 'own',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'apollo-outreach'],
    tiers: { self: 'rw', sales: 'own' },
    metrics: ['outreach_emails', 'calls_made', 'demos_completed', 'orders_closed'],
    baseline: 31,
  },
  recruitment_team: {
    display_name: 'Recruitment Team',
    level: 5, domain: 'recruitment', data_scope: 'own',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones'],
    // procurement:'r' is here for ONE reason: the CPHI Milan page. Its reads are gated
    // requireAnyTier('intelligence','procurement') and enforce.js is tighten-only, so the tier
    // gate still runs after the resolver — without a tier the route rejects this role however
    // the nav is configured. 'r', never 'rw': this role has no business writing procurement.
    //
    // The tier does NOT hand them the procurement surface. The resolver decides for
    // recruitment_team (it is in PERMISSIONS_ENFORCE_ROLES) and its template grants ONLY the
    // three CPHI features — see the DELIBERATE DEVIATION block in permissions/templates.js
    // before re-deriving anything.
    tiers: { self: 'rw', procurement: 'r' },
    metrics: ['candidates_screened', 'interviews_scheduled', 'offers_made', 'hires_completed'],
    baseline: 6,
  },
  procurement_team: {
    display_name: 'Procurement Team',
    level: 5, domain: 'procurement', data_scope: 'own',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'sku-economics', 'market-intelligence'],
    tiers: { self: 'rw', procurement: 'own' },
    metrics: ['molecules_sourced', 'suppliers_contacted', 'coas_collected', 'rfqs_sent'],
    baseline: 11,
  },
  dev_team: {
    display_name: 'Dev Team',
    level: 5, domain: 'engineering', data_scope: 'own+technical',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'data-pipeline', 'execution-graph', 'apollo-outreach', 'linkedin-content', 'seo-intelligence', 'seo-content'],
    tiers: { self: 'rw', technical: 'rw', sales: 'r', intelligence: 'r' },
    metrics: ['prs_merged', 'commits', 'features_deployed', 'bugs_fixed'],
    baseline: 11,
  },
  seo_specialist: {
    display_name: 'SEO Specialist',
    level: 5, domain: 'marketing', data_scope: 'own',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'seo-intelligence', 'seo-content', 'market-intelligence'],
    tiers: { self: 'rw', intelligence: 'r' },
    metrics: ['keywords_optimized', 'pages_indexed', 'backlinks_built', 'content_published'],
    baseline: 8,
  },
  // ── the first OUTSIDE role ───────────────────────────────────────────────────
  // A partner is not staff. This role exists so that nothing about an outside account
  // is inherited from a role designed for someone who works here.
  //
  // What it holds: the 'sitenex' tier, read-only, and nothing else but 'self'. No sales, no intelligence,
  // no procurement, no admin. It is not in any NAV family that carries an internal section, and its
  // permission template lists four features — Deals and Packages, page + route.
  //
  // What it does NOT get, and each is a separate refusal:
  //   (SiteNex Prospects was in this list until 2026-10-01, when territories arrived. A partner now sees
  //    the prospects in the patch we granted them — territoryScopeSql, which fails CLOSED, so no grant
  //    means no rows. It left this list because the answer stopped being "none" and became "theirs".)
  //   'internal'       never granted in user_products, so the product boundary refuses every
  //                    platform-wide route independently of all of the above.
  //   the bell         notifications need the 'intelligence' tier, which this role has not got, so
  //                    the bell is simply not rendered (index.html:1016) — the same as sales_team.
  //
  // pages is listed explicitly rather than falling through to the default, which includes the company
  // playbook and milestones.
  partner: {
    display_name: 'Partner',
    level: 6, domain: 'partner', data_scope: 'readonly',
    // Kept in step with the nav by partner-role.test.js. sitenex-prospects joined on 2026-10-01 (scoped to
    // territory) and sitenex-contracts on 2026-09-30; both were missing here while being drawn, which is the
    // kind of drift a second allowlist invites.
    pages: ['sitenex-prospects', 'sitenex-deals', 'sitenex-packages', 'sitenex-contracts',
            'my-tasks', 'my-activity'],
    tiers: { self: 'rw', sitenex: 'r' },
    // external:true is the SWITCH THAT TURNS OFF EVERYTHING WE DO TO OUR OWN STAFF. See
    // EXTERNAL_ROLES below for what it governs and why it is a property of the role rather than a
    // column somebody has to remember to tick.
    external: true,
    metrics: [],
    baseline: 1,
  },
  support_team: {
    display_name: 'Support Team',
    level: 6, domain: 'support', data_scope: 'readonly',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'revenue'],
    tiers: { self: 'rw', sales: 'r', revenue: 'r' },
    metrics: ['customers_assisted', 'issues_resolved', 'orders_reviewed'],
    baseline: 25,
  },
};

// ── EXTERNAL ROLES — what we do to our own staff and must not do to a partner ─────────────────
//
// PlaybookOS measures and manages the people in it. An account with external:true is someone we do
// NOT employ, so none of that applies, and several parts of it would be actively damaging:
//
//   performance scoring      they do no work we measure, so they sit at 0
//   the daily score email    a partner being emailed their productivity score
//   the escalation ladder    five days at 0 escalates to L4 — Naresh emailing a partner about their
//                            "critically low productivity" is not a good look for a partnership
//   weekly KPI assignment    goal_cascades rows aimed at a role that has no cascade anyway
//   AI daily task assignment we do not set a partner's agenda
//   meeting action items     they are not in our standups
//
// WHY A ROLE PROPERTY AND NOT users.excluded_from_scoring. That column exists and still works — the
// invite handler sets it for an external role, so every query that filters on it keeps behaving. But a
// column is per-account state that somebody has to remember to set, and "remember to tick the box or
// the partner gets coaching emails" is not a boundary. The role knows what it is; the queries ask the
// role. The column is the belt, this is the braces.
const EXTERNAL_ROLES = Object.entries(BUILT_IN_ROLES)
  .filter(([, def]) => def.external === true).map(([key]) => key);

// A custom role (POST /api/roles) gets no tiers and no definition here, so it is NOT external —
// treating an unknown role as external would silently stop scoring anyone on a new role.
function isExternalRole(roleKey) {
  return EXTERNAL_ROLES.includes(roleKey);
}

// SQL fragment excluding external roles, for the queries that sweep every active user.
//   `... WHERE is_active=1 ${excludeExternalSql('u')}`
// Inlined as a literal rather than parameterised so it drops into queries that already number their
// params (several of these run with $1 already bound). Safe because role keys are code-defined, never
// user input — asserted below so a future role with a quote or space fails loudly at require time
// instead of producing broken SQL.
for (const key of EXTERNAL_ROLES) {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new Error(`external role key "${key}" is not a bare identifier — excludeExternalSql inlines it into SQL`);
  }
}
function excludeExternalSql(alias = '') {
  if (!EXTERNAL_ROLES.length) return '';
  const col = alias ? `${alias}.role` : 'role';
  return ` AND COALESCE(${col}, '') NOT IN (${EXTERNAL_ROLES.map(r => `'${r}'`).join(', ')})`;
}

function getMetricsSync(roleKey) {
  return BUILT_IN_ROLES[roleKey]?.metrics || [];
}

function getBaselineSync(roleKey) {
  return BUILT_IN_ROLES[roleKey]?.baseline || BUILT_IN_ROLES.admin.baseline;
}

function isBuiltIn(roleKey) {
  return !!BUILT_IN_ROLES[roleKey];
}

// API tier access for a role: 'rw' | 'r' | 'w' | 'own' | null.
function getRoleTier(roleKey, tier) {
  return BUILT_IN_ROLES[roleKey]?.tiers?.[tier] || null;
}

// The whole tier map for a role, for the client to filter its own nav with. Returned by /auth/me and
// /auth/login so the nav never has to fetch its inputs separately — see the comment on /auth/me.
// A custom role has no definition here and gets {}, which means "no tiers", which is correct: a custom
// role holds none. Never null, so the caller cannot mistake "no tiers" for "unknown".
function roleTiers(roleKey) {
  return { ...(BUILT_IN_ROLES[roleKey]?.tiers || {}) };
}

// Sidebar pages a role can see: '*' or an array.
function getRolePages(roleKey) {
  return BUILT_IN_ROLES[roleKey]?.pages || ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones'];
}

// Full catalog including custom_roles rows. Custom rows get no tiers/pages.
async function getAllRoles() {
  const out = {};
  for (const [k, v] of Object.entries(BUILT_IN_ROLES)) {
    out[k] = { ...v, built_in: true, custom: false };
  }
  try {
    const customRows = (await query(
      'SELECT role_name, display_name, metrics_json FROM custom_roles ORDER BY role_name'
    )).rows;
    for (const r of customRows) {
      let metrics = [];
      try { metrics = JSON.parse(r.metrics_json) || []; } catch {}
      out[r.role_name] = {
        display_name: r.display_name || r.role_name,
        level: 5, domain: 'custom', data_scope: 'own',
        pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones'],
        tiers: { self: 'rw' },
        metrics,
        baseline: 5,
        built_in: !!BUILT_IN_ROLES[r.role_name],
        custom: true,
      };
    }
  } catch (e) {
    // custom_roles may not exist yet on first boot; built-ins still returned
  }
  return out;
}

module.exports = {
  EXTERNAL_ROLES, isExternalRole, excludeExternalSql, BUILT_IN_ROLES, ALL_PAGES, getAllRoles, getMetricsSync, getBaselineSync, isBuiltIn, getRoleTier, roleTiers, getRolePages };
