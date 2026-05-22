// KPI Engine — Layer 1 of the AI Agent System.
// Decomposes the $10M vision into strategic goals, team KPIs and daily tasks,
// scores individuals, and surfaces bottlenecks and cross-team dependencies.
const { query } = require('./db');
const { mondayOf } = require('./agents/goal-engine');

const isoWeek = d => mondayOf(new Date(d)).toISOString().slice(0, 10);
const isoDay = d => new Date(d).toISOString().slice(0, 10);

// Full goal decomposition: Vision -> Strategic Goals -> Team KPIs -> Daily Tasks.
async function getKPIHierarchy() {
  const rows = (await query(`SELECT * FROM kpi_hierarchy ORDER BY level, name`)).rows;

  const totalRevenue = parseFloat((await query(
    `SELECT COALESCE(SUM(amount),0) v FROM orders WHERE COALESCE(status,'confirmed') <> 'cancelled'`
  )).rows[0].v);
  const activeSkus = parseInt((await query(
    `SELECT COUNT(*) c FROM skus WHERE is_active=1`
  )).rows[0].c, 10);

  const liveValue = node => {
    if (node.metric === 'revenue') return totalRevenue;
    if (node.metric === 'skus_sourced') return activeSkus;
    return Number(node.current_value) || 0;
  };

  const byId = {};
  rows.forEach(r => {
    const n = {
      id: r.id, level: r.level, name: r.name, metric: r.metric,
      target_value: Number(r.target_value) || 0,
      current_value: liveValue(r),
      owner_role: r.owner_role, period: r.period, children: [],
    };
    n.pct = n.target_value > 0 ? Math.round((n.current_value / n.target_value) * 100) : 0;
    byId[r.id] = n;
  });
  let vision = null;
  rows.forEach(r => {
    const node = byId[r.id];
    if (r.parent_id && byId[r.parent_id]) byId[r.parent_id].children.push(node);
    else if (r.level === 'vision') vision = vision || node;
  });

  const weekStart = isoWeek(new Date());
  const teamKpis = (await query(`
    SELECT kpi_name,
           COALESCE(SUM(kpi_target),0) AS target,
           COALESCE(SUM(kpi_actual),0) AS actual,
           COUNT(*)::int AS assigned
    FROM weekly_kpis WHERE week_start=$1
    GROUP BY kpi_name ORDER BY kpi_name`, [weekStart]
  )).rows.map(r => {
    const target = Number(r.target) || 0, actual = Number(r.actual) || 0;
    return {
      kpi_name: r.kpi_name, target, actual, assigned: r.assigned,
      pct: target > 0 ? Math.round((actual / target) * 100) : 0,
    };
  });

  const today = isoDay(new Date());
  const dt = (await query(`
    SELECT
      COUNT(*)::int total,
      COUNT(*) FILTER (WHERE status='completed')::int completed,
      COUNT(*) FILTER (WHERE status='in_progress')::int in_progress,
      COUNT(*) FILTER (WHERE status='pending')::int pending
    FROM daily_tasks WHERE task_date=$1`, [today]
  )).rows[0];

  return {
    generated_at: new Date().toISOString(),
    vision,
    strategic_goals: vision ? vision.children : [],
    team_kpis: teamKpis,
    daily_tasks: {
      date: today,
      total: dt.total, completed: dt.completed,
      in_progress: dt.in_progress, pending: dt.pending,
    },
  };
}

// Score a user 0-100 for a given date — actual vs target across their weekly
// KPIs, falling back to the performance_scores snapshot when no KPIs exist.
async function calculateKPIScore(userId, date = isoDay(new Date())) {
  const weekStart = isoWeek(date);
  const kpis = (await query(
    `SELECT kpi_name, kpi_target, kpi_actual FROM weekly_kpis WHERE user_id=$1 AND week_start=$2`,
    [userId, weekStart]
  )).rows;
  if (kpis.length > 0) {
    const pcts = kpis.map(k => {
      const t = Number(k.kpi_target) || 0, a = Number(k.kpi_actual) || 0;
      return t > 0 ? Math.min(100, (a / t) * 100) : 0;
    });
    const score = Math.round(pcts.reduce((s, p) => s + p, 0) / pcts.length);
    return { user_id: userId, date, week_start: weekStart, score, source: 'weekly_kpis', kpi_count: kpis.length };
  }
  const perf = (await query(
    `SELECT score_0_to_100 FROM performance_scores WHERE user_id=$1 AND score_date=$2`,
    [userId, date]
  )).rows[0];
  if (perf) {
    return { user_id: userId, date, score: perf.score_0_to_100, source: 'performance_scores', kpi_count: 0 };
  }
  return {
    user_id: userId, date, score: 0, source: 'none', kpi_count: 0,
    reason: 'no weekly KPIs or performance score for this user/date',
  };
}

// Identify which KPIs are most behind across every team this week.
async function getBottlenecks({ limit = 5 } = {}) {
  const weekStart = isoWeek(new Date());
  const teamRows = (await query(`
    SELECT kpi_name,
           COALESCE(SUM(kpi_target),0) target,
           COALESCE(SUM(kpi_actual),0) actual,
           COUNT(*)::int assigned
    FROM weekly_kpis WHERE week_start=$1
    GROUP BY kpi_name`, [weekStart]
  )).rows.map(r => {
    const target = Number(r.target) || 0, actual = Number(r.actual) || 0;
    return {
      kpi: r.kpi_name, level: 'team_kpi', target, actual,
      pct: target > 0 ? Math.round((actual / target) * 100) : 0,
      gap: Math.max(0, target - actual), assigned: r.assigned,
    };
  });
  const bottlenecks = teamRows
    .filter(r => r.target > 0)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, limit);
  return {
    week_start: weekStart, generated_at: new Date().toISOString(),
    count: bottlenecks.length, bottlenecks,
  };
}

// Map the procurement -> sales -> marketplace -> SEO chain and flag blockers
// where one team's lag is constraining the next.
async function getCrossTeamDependencies() {
  // created_at is declared TEXT DEFAULT NOW() in the schema, so a bare
  // `created_at >= NOW() - INTERVAL ...` comparison errors with
  // "operator does not exist: text >= timestamp with time zone". Cast on the
  // left so this works whether the column is TEXT (ISO timestamp strings) or
  // already TIMESTAMPTZ (an older migration's column type).
  const since7 = `NOW() - INTERVAL '7 days'`;
  const skusAdded7d = parseInt((await query(
    `SELECT COUNT(*) c FROM skus WHERE created_at::timestamptz >= ${since7}`)).rows[0].c, 10);
  const pendingCoa = parseInt((await query(
    `SELECT COUNT(*) c FROM skus WHERE is_active=1 AND COALESCE(coa_status,'pending') <> 'approved'`)).rows[0].c, 10);
  const activeSkus = parseInt((await query(
    `SELECT COUNT(*) c FROM skus WHERE is_active=1`)).rows[0].c, 10);
  const orders7d = parseInt((await query(
    `SELECT COUNT(*) c FROM orders WHERE created_at::timestamptz >= ${since7}`)).rows[0].c, 10);
  let seoContent = 0;
  try {
    seoContent = parseInt((await query(`SELECT COUNT(*) c FROM seo_content`)).rows[0].c, 10);
  } catch { /* seo_content may not exist on an old schema */ }

  const procOk = skusAdded7d >= 5;
  const salesOk = orders7d >= 1;
  const marketplaceOk = activeSkus >= 1;
  const seoOk = seoContent >= 1;

  const chain = [
    { stage: 'Procurement', status: procOk ? 'green' : 'red', metric: skusAdded7d,
      detail: `${skusAdded7d} SKUs sourced in the last 7 days, ${pendingCoa} awaiting COA` },
    { stage: 'Sales', status: salesOk ? 'green' : 'amber', metric: orders7d,
      detail: `${orders7d} orders booked in the last 7 days` },
    { stage: 'Marketplace', status: marketplaceOk ? 'green' : 'red', metric: activeSkus,
      detail: `${activeSkus} active SKUs listed` },
    { stage: 'SEO', status: seoOk ? 'green' : 'amber', metric: seoContent,
      detail: `${seoContent} SEO product pages generated` },
  ];

  const blockers = [];
  if (!procOk) {
    blockers.push({
      severity: 'high',
      summary: 'Procurement delay → Sales constrained → Marketplace under-stocked',
      detail: `Only ${skusAdded7d} SKUs sourced in the last 7 days — sales has fewer products to sell and the catalog is not growing.`,
    });
  }
  if (pendingCoa > 0) {
    blockers.push({
      severity: pendingCoa > 20 ? 'high' : 'medium',
      summary: `${pendingCoa} SKUs blocked on COA → cannot be listed → no SEO page`,
      detail: `${pendingCoa} active SKUs lack an approved COA, so they cannot go live on the marketplace or receive an SEO page.`,
    });
  }
  if (!seoOk && activeSkus > 0) {
    blockers.push({
      severity: 'medium',
      summary: `Marketplace has ${activeSkus} SKUs but 0 SEO pages → no organic demand capture`,
      detail: 'Products are listed but no SEO content has been generated, so they are invisible to organic search.',
    });
  }

  return {
    generated_at: new Date().toISOString(),
    chain, blockers, healthy: blockers.length === 0,
  };
}

module.exports = { getKPIHierarchy, calculateKPIScore, getBottlenecks, getCrossTeamDependencies };
