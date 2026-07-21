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
// API tiers: self, sales, procurement, revenue, technical, intelligence, goals, admin.
// Custom roles (POST /api/roles) extend this set but get no tiers (self-only).
const ALL_PAGES = [
  'dashboard', 'command-center', 'ai-insights', 'agent-control', 'decision-engine', 'performance',
  'my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones',
  'revenue', 'sales-pipeline', 'apollo-outreach',
  'market-intelligence', 'procurement-agent', 'meet-agent', 'research-agent', 'seo-intelligence', 'seo-content', 'linkedin-content', 'email-engine',
  'team', 'sku-economics', 'data-pipeline', 'execution-graph', 'settings',
];

const BUILT_IN_ROLES = {
  super_admin: {
    display_name: 'Super Admin',
    level: 1, domain: 'global', data_scope: 'all',
    pages: '*',
    tiers: { self: 'rw', sales: 'rw', procurement: 'rw', revenue: 'rw', technical: 'rw', intelligence: 'rw', goals: 'rw', admin: 'rw' },
    metrics: [],
    baseline: 3,
  },
  admin: {
    display_name: 'Admin',
    level: 2, domain: 'global', data_scope: 'all',
    pages: '*',
    tiers: { self: 'rw', sales: 'rw', procurement: 'rw', revenue: 'rw', technical: 'rw', intelligence: 'rw', goals: 'rw', admin: 'rw' },
    metrics: ['team_reviews', 'orders_entered'],
    baseline: 3,
  },
  sales_director: {
    display_name: 'Sales Director',
    level: 3, domain: 'sales', data_scope: 'team',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'revenue', 'sales-pipeline', 'apollo-outreach', 'linkedin-content', 'email-engine', 'team', 'performance'],
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
    tiers: { self: 'rw' },
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
  support_team: {
    display_name: 'Support Team',
    level: 6, domain: 'support', data_scope: 'readonly',
    pages: ['my-tasks', 'my-kpis', 'my-performance', 'my-activity', 'playbook', 'milestones', 'revenue'],
    tiers: { self: 'rw', sales: 'r', revenue: 'r' },
    metrics: ['customers_assisted', 'issues_resolved', 'orders_reviewed'],
    baseline: 25,
  },
};

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

module.exports = { BUILT_IN_ROLES, ALL_PAGES, getAllRoles, getMetricsSync, getBaselineSync, isBuiltIn, getRoleTier, getRolePages };
