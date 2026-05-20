const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');

const DAY_MS = 86400000;
const isoDate = d => d.toISOString().slice(0, 10);

// Monday of the week containing `date`, in UTC. Returns a Date at 00:00 UTC.
function mondayOf(date) {
  const d = new Date(date);
  const utcDay = d.getUTCDay(); // 0=Sun
  const offsetToMonday = (utcDay === 0 ? -6 : 1 - utcDay);
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetToMonday));
  return m;
}

// Per-role metric vocabularies match public/index.html my-activity page.
const ROLE_METRICS = {
  dev:         ['prs_merged', 'commits', 'features_deployed', 'bugs_fixed'],
  procurement: ['skus_priced', 'coas_collected', 'suppliers_contacted', 'vendors_onboarded'],
  sales:       ['outreach_emails', 'calls_made', 'demos_completed', 'orders_closed', 'revenue_closed'],
  marketing:   ['campaigns_sent', 'leads_generated', 'content_published', 'conferences_attended'],
  qc:          ['coas_issued', 'tests_completed', 'reports_generated', 'samples_processed'],
  admin:       ['orders_entered', 'revenue_closed', 'team_reviews'],
};

function inferUnit(metric) {
  if (metric === 'revenue' || metric === 'revenue_closed') return '$';
  if (metric.includes('emails')) return 'emails';
  if (metric === 'commits') return 'commits';
  if (metric.startsWith('prs')) return 'PRs';
  if (metric.includes('calls')) return 'calls';
  if (metric.includes('demos')) return 'demos';
  if (metric.includes('orders')) return 'orders';
  return 'count';
}

async function cascadeGoals({ dryRun = false } = {}) {
  const today = new Date();
  const todayISO = isoDate(today);
  const year = todayISO.slice(0, 4);

  const annualTargets = (await query(
    "SELECT metric, target_value FROM targets WHERE period_type='annual' AND period_key=$1",
    [year]
  )).rows;
  if (annualTargets.length === 0) {
    return { skipped: true, reason: `no annual targets found in targets table for ${year}` };
  }

  const team = (await query(
    `SELECT id, name, role FROM users WHERE is_active=1 AND role IS NOT NULL ORDER BY role, name`
  )).rows;
  const teamByRole = {};
  for (const u of team) {
    teamByRole[u.role] = teamByRole[u.role] || [];
    teamByRole[u.role].push(u);
  }
  if (team.length === 0) {
    return { skipped: true, reason: 'no active users' };
  }

  const existingMonthly = (await query(
    `SELECT period_key, metric, target_value FROM targets WHERE period_type='monthly' AND period_key LIKE $1 ORDER BY period_key`,
    [year + '-%']
  )).rows;

  // Build Claude prompt
  const annualText = annualTargets.map(t => `- ${t.metric}: $${parseFloat(t.target_value).toLocaleString()}`).join('\n');
  const teamText = Object.entries(teamByRole)
    .map(([role, users]) => `- ${role}: ${users.length} (${users.map(u => u.name).join(', ')})`)
    .join('\n');
  const monthlyText = existingMonthly.length
    ? existingMonthly.map(t => `- ${t.period_key}: ${t.metric} = $${parseFloat(t.target_value).toLocaleString()}`).join('\n')
    : '(none seeded — generate monthly distribution yourself)';
  const metricsText = Object.entries(ROLE_METRICS)
    .filter(([role]) => teamByRole[role])
    .map(([role, metrics]) => `- ${role}: ${metrics.join(', ')}`)
    .join('\n');

  const prompt = `You are the Goal Engine for Abiozen LLC, a US-based pharmaceutical API distribution company targeting $10M revenue by Dec 31, 2026. Cascade the annual targets into quarterly summaries and per-role weekly KPIs that collectively ladder up to the revenue target.

ANNUAL TARGETS for ${year}:
${annualText}

TEAM ROSTER (active):
${teamText}

EXISTING MONTHLY REVENUE TARGETS (do not override, use as input):
${monthlyText}

ROLE-SPECIFIC METRIC VOCABULARY (only use metrics from the role's list):
${metricsText}

Return EXACTLY this JSON structure (no commentary, no markdown fences, no other text):

{
  "quarterly": [
    {"period_key": "${year}-Q1", "period_start": "${year}-01-01", "period_end": "${year}-03-31", "metric": "revenue", "target_value": 0},
    {"period_key": "${year}-Q2", "period_start": "${year}-04-01", "period_end": "${year}-06-30", "metric": "revenue", "target_value": 0},
    {"period_key": "${year}-Q3", "period_start": "${year}-07-01", "period_end": "${year}-09-30", "metric": "revenue", "target_value": 0},
    {"period_key": "${year}-Q4", "period_start": "${year}-10-01", "period_end": "${year}-12-31", "metric": "revenue", "target_value": 0}
  ],
  "weekly_per_role": [
    {"role": "sales", "metric": "outreach_emails", "weekly_target": 100, "rationale": "1 short sentence"},
    {"role": "sales", "metric": "demos_completed", "weekly_target": 10, "rationale": "1 short sentence"}
  ]
}

Rules:
- Each quarterly target_value = sum of monthly revenue targets in that quarter from the list above. If no monthly seed exists for a quarter, distribute the remaining annual target across uncovered quarters with seasonality weighting (lower in Q1/Q4 holidays).
- weekly_per_role: 2 to 4 KPIs per role from that role's metric vocabulary above. Numbers must collectively justify roughly $50K to $80K of weekly revenue once the team is operational. Use only role names that appear in the team roster.
- Sales KPIs especially must be quantitatively connected to revenue: e.g. if average deal size is ~$5K and close rate is 10%, then ~10 demos per week is needed for ~$5K closed.
- Numbers should be ambitious but realistic for a ~${team.length}-person team.

Return ONLY the JSON object.`;

  let cascade;
  let raw = null;
  if (dryRun) {
    cascade = { quarterly: [], weekly_per_role: [] };
  } else {
    raw = await runClaudeAnalysis(prompt);
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON object found');
      cascade = JSON.parse(match[0]);
    } catch (e) {
      return { skipped: true, reason: `Failed to parse Claude JSON: ${e.message}`, raw };
    }
  }

  const counts = { annual: 0, quarterly: 0, monthly: 0, weekly: 0, daily: 0 };

  if (!dryRun) {
    // Delete future auto-generated rows (preserve history + manual overrides)
    await query(
      `DELETE FROM goal_cascades WHERE auto_generated=1 AND period_end >= $1`,
      [todayISO]
    );

    // Annual rows (one per metric in the targets table)
    const annualIdByMetric = {};
    for (const t of annualTargets) {
      const id = crypto.randomUUID();
      annualIdByMetric[t.metric] = id;
      await query(
        `INSERT INTO goal_cascades (id, parent_goal_id, level, metric, target_value, period_start, period_end, assigned_to_role, assigned_to_user_id, auto_generated)
         VALUES ($1, NULL, 'annual', $2, $3, $4, $5, NULL, NULL, 1)`,
        [id, t.metric, parseFloat(t.target_value), `${year}-01-01`, `${year}-12-31`]
      );
      counts.annual++;
    }

    // Quarterly rows from Claude
    const quarterIdByKey = {};
    for (const q of cascade.quarterly || []) {
      const id = crypto.randomUUID();
      quarterIdByKey[q.period_key] = id;
      const metric = q.metric || 'revenue';
      await query(
        `INSERT INTO goal_cascades (id, parent_goal_id, level, metric, target_value, period_start, period_end, assigned_to_role, assigned_to_user_id, auto_generated)
         VALUES ($1, $2, 'quarterly', $3, $4, $5, $6, NULL, NULL, 1)`,
        [id, annualIdByMetric[metric] || null, metric, parseFloat(q.target_value) || 0, q.period_start, q.period_end]
      );
      counts.quarterly++;
    }

    // Monthly rows from existing monthly targets seed
    const monthlyIdByKey = {};
    for (const m of existingMonthly) {
      const monthDate = new Date(m.period_key + '-01T00:00:00Z');
      const monthEnd = isoDate(new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)));
      const qNum = Math.ceil((monthDate.getUTCMonth() + 1) / 3);
      const quarterKey = `${year}-Q${qNum}`;
      const id = crypto.randomUUID();
      monthlyIdByKey[m.period_key] = { id, target: parseFloat(m.target_value), metric: m.metric };
      await query(
        `INSERT INTO goal_cascades (id, parent_goal_id, level, metric, target_value, period_start, period_end, assigned_to_role, assigned_to_user_id, auto_generated)
         VALUES ($1, $2, 'monthly', $3, $4, $5, $6, NULL, NULL, 1)`,
        [id, quarterIdByKey[quarterKey] || null, m.metric, parseFloat(m.target_value), m.period_key + '-01', monthEnd]
      );
      counts.monthly++;
    }

    // Weekly rows per role from Claude — emit for current week + next 12 weeks
    const startMonday = mondayOf(today);
    const weeklyKeysForCurrentWeek = [];
    for (let i = 0; i < 13; i++) {
      const weekStart = new Date(startMonday.getTime() + i * 7 * DAY_MS);
      const weekEnd = new Date(weekStart.getTime() + 6 * DAY_MS);
      const weekStartISO = isoDate(weekStart);
      const weekEndISO = isoDate(weekEnd);
      const monthKey = weekStartISO.slice(0, 7);
      const monthRow = monthlyIdByKey[monthKey];

      for (const w of cascade.weekly_per_role || []) {
        if (!teamByRole[w.role]) continue;
        if (!ROLE_METRICS[w.role]?.includes(w.metric)) continue; // strict: must be valid role+metric
        const id = crypto.randomUUID();
        await query(
          `INSERT INTO goal_cascades (id, parent_goal_id, level, metric, target_value, period_start, period_end, assigned_to_role, assigned_to_user_id, auto_generated)
           VALUES ($1, $2, 'weekly', $3, $4, $5, $6, $7, NULL, 1)`,
          [id, monthRow?.id || null, w.metric, parseFloat(w.weekly_target) || 0, weekStartISO, weekEndISO, w.role]
        );
        counts.weekly++;
        if (i === 0) weeklyKeysForCurrentWeek.push({ id, role: w.role, metric: w.metric, target: parseFloat(w.weekly_target) || 0, week_start: weekStartISO });
      }
    }

    // Daily rows for the current week (Mon-Fri, 5 business days)
    for (const w of weeklyKeysForCurrentWeek) {
      const dailyTarget = w.target / 5;
      for (let d = 0; d < 5; d++) {
        const dayDate = isoDate(new Date(mondayOf(today).getTime() + d * DAY_MS));
        const id = crypto.randomUUID();
        await query(
          `INSERT INTO goal_cascades (id, parent_goal_id, level, metric, target_value, period_start, period_end, assigned_to_role, assigned_to_user_id, auto_generated)
           VALUES ($1, $2, 'daily', $3, $4, $5, $5, $6, NULL, 1)`,
          [id, w.id, w.metric, dailyTarget, dayDate, w.role]
        );
        counts.daily++;
      }
    }
  }

  return {
    cascade_parsed: !dryRun,
    counts,
    annual_metrics: annualTargets.map(t => t.metric),
    team_by_role: Object.fromEntries(Object.entries(teamByRole).map(([r, us]) => [r, us.length])),
    quarterly_provided: (cascade.quarterly || []).length,
    weekly_per_role_provided: (cascade.weekly_per_role || []).length,
    dryRun,
  };
}

async function assignWeeklyKPIs(userId, weekStart) {
  const user = (await query(`SELECT id, name, role FROM users WHERE id=$1`, [userId])).rows[0];
  if (!user || !user.role) return { skipped: true, reason: 'user not found or no role', user_id: userId };

  const weeklyGoals = (await query(
    `SELECT metric, target_value FROM goal_cascades
     WHERE level='weekly' AND assigned_to_role=$1 AND period_start=$2`,
    [user.role, weekStart]
  )).rows;

  if (weeklyGoals.length === 0) {
    return { user_id: userId, role: user.role, week_start: weekStart, skipped: true, reason: 'no weekly cascade for this role/week' };
  }

  for (const g of weeklyGoals) {
    await query(
      `INSERT INTO weekly_kpis (id, user_id, week_start, kpi_name, kpi_target, kpi_unit, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_progress')
       ON CONFLICT (user_id, week_start, kpi_name) DO UPDATE
       SET kpi_target = EXCLUDED.kpi_target, kpi_unit = EXCLUDED.kpi_unit`,
      [crypto.randomUUID(), userId, weekStart, g.metric, parseFloat(g.target_value), inferUnit(g.metric)]
    );
  }

  return { user_id: userId, role: user.role, week_start: weekStart, kpis_created: weeklyGoals.length };
}

async function assignWeeklyKPIsForAll({ dryRun = false } = {}) {
  const weekStart = isoDate(mondayOf(new Date()));
  const users = (await query(`SELECT id, name, role FROM users WHERE is_active=1 AND role IS NOT NULL`)).rows;
  if (dryRun) {
    return { dryRun: true, week_start: weekStart, would_process: users.length };
  }
  const results = [];
  for (const u of users) {
    try {
      results.push(await assignWeeklyKPIs(u.id, weekStart));
    } catch (e) {
      results.push({ user_id: u.id, error: e.message });
    }
  }
  return { week_start: weekStart, total: users.length, results };
}

module.exports = { cascadeGoals, assignWeeklyKPIs, assignWeeklyKPIsForAll, mondayOf, ROLE_METRICS };
