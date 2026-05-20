const { query } = require('./db');

// Source of truth for role taxonomy across the codebase.
// Add a role here and it shows up in: the my-activity metric dropdown,
// the invite dropdown, the goal-cascade Claude prompt, the performance
// score baseline, and GET /api/roles. Custom roles added via POST
// /api/roles extend (not replace) this set.
const BUILT_IN_ROLES = {
  admin: {
    display_name: 'Admin',
    metrics: ['orders_entered', 'revenue_closed', 'team_reviews'],
    baseline: 3,
  },
  dev: {
    display_name: 'Developer',
    metrics: ['prs_merged', 'commits', 'features_deployed', 'bugs_fixed'],
    baseline: 8,
  },
  procurement_lead: {
    display_name: 'Procurement Lead',
    metrics: ['molecules_sourced', 'suppliers_contacted', 'coas_collected', 'rfqs_sent', 'purchase_orders_placed'],
    baseline: 15,
  },
  customer_engagement: {
    display_name: 'Customer Engagement',
    metrics: ['quotes_sent', 'accounts_created', 'leads_followed_up', 'orders_closed', 'response_time_hrs'],
    baseline: 20,
  },
  lead_chemist: {
    display_name: 'Lead Chemist',
    metrics: ['orders_repacked', 'labels_printed', 'shipments_dispatched', 'qc_checks_completed'],
    baseline: 12,
  },
  logistics: {
    display_name: 'Logistics',
    metrics: ['pickups_completed', 'transfers_completed', 'inbound_receipts_logged'],
    baseline: 8,
  },
  recruitment: {
    display_name: 'Recruitment',
    metrics: ['candidates_screened', 'interviews_scheduled', 'offers_made', 'hires_completed'],
    baseline: 5,
  },
  hr_accounts: {
    display_name: 'HR & Accounts',
    metrics: ['payroll_processed', 'employee_issues_resolved', 'invoices_processed'],
    baseline: 4,
  },
  seo_specialist: {
    display_name: 'SEO Specialist',
    metrics: ['keywords_optimized', 'pages_indexed', 'backlinks_built', 'ranking_improvements', 'content_published'],
    baseline: 10,
  },
  platform_ops: {
    display_name: 'Platform Ops',
    metrics: ['issues_resolved', 'deployments_completed', 'uptime_pct', 'tickets_closed'],
    baseline: 6,
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

// Returns the full role catalog including any custom_roles rows.
// Custom rows that share a key with a built-in extend (override) the built-in.
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
        metrics,
        baseline: out[r.role_name]?.baseline || 5,
        built_in: !!BUILT_IN_ROLES[r.role_name],
        custom: true,
      };
    }
  } catch (e) {
    // custom_roles may not exist yet on first boot; built-ins still returned
  }
  return out;
}

module.exports = { BUILT_IN_ROLES, getAllRoles, getMetricsSync, getBaselineSync, isBuiltIn };
