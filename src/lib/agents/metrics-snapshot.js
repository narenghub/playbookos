const crypto = require('crypto');
const { query } = require('../db');

const DAY_MS = 86400000;
const isoDate = d => d.toISOString().slice(0, 10);

// Snapshots the day that just ENDED (yesterday in UTC at midnight-cron firing time).
// The 7am briefing reads the most recent snapshot as "today's reference baseline".
async function takeMetricsSnapshot({ dryRun = false, dateOverride = null } = {}) {
  const snapshotDate = dateOverride || isoDate(new Date(Date.now() - DAY_MS));
  const sevenDaysAgo = isoDate(new Date(new Date(snapshotDate + 'T00:00:00Z').getTime() - 7 * DAY_MS));

  const revenueActual = parseFloat((await query(
    `SELECT COALESCE(SUM(amount), 0) as v FROM orders WHERE order_date::text = $1`,
    [snapshotDate]
  )).rows[0].v);

  const month = snapshotDate.slice(0, 7);
  const monthlyTarget = parseFloat((await query(
    `SELECT target_value FROM targets WHERE period_type='monthly' AND period_key=$1 AND metric='revenue'`,
    [month]
  )).rows[0]?.target_value || 0);
  const [yr, mo] = snapshotDate.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  const dailyTarget = monthlyTarget / daysInMonth;
  const revenuePct = dailyTarget > 0 ? Math.round((revenueActual / dailyTarget) * 100) : 0;

  const teamAvgScore = parseInt((await query(
    `SELECT COALESCE(ROUND(AVG(score_0_to_100)), 0)::int as v FROM performance_scores WHERE score_date=$1`,
    [snapshotDate]
  )).rows[0].v);

  // top_sku is parsed from order notes (`product: NAME`) because orders has no sku_id FK
  const recentOrdersWithNotes = (await query(
    `SELECT notes, amount FROM orders WHERE order_date::text >= $1 AND order_date::text <= $2 AND notes ILIKE '%product:%'`,
    [sevenDaysAgo, snapshotDate]
  )).rows;
  const skuMap = new Map();
  for (const r of recentOrdersWithNotes) {
    const m = r.notes.match(/product:\s*([^·\n]+)/i);
    if (m) {
      const name = m[1].trim();
      skuMap.set(name, (skuMap.get(name) || 0) + parseFloat(r.amount || 0));
    }
  }
  const topSku = Array.from(skuMap.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const topSegmentRow = (await query(
    `SELECT buyer_type FROM orders
     WHERE order_date::text >= $1 AND order_date::text <= $2 AND buyer_type IS NOT NULL
     GROUP BY buyer_type ORDER BY SUM(amount) DESC LIMIT 1`,
    [sevenDaysAgo, snapshotDate]
  )).rows[0];
  const topBuyerSegment = topSegmentRow?.buyer_type || null;

  const apolloEmailsSent = parseInt((await query(
    `SELECT COUNT(*)::int as v FROM buyer_engagement WHERE event_type='sent' AND event_at::date::text = $1`,
    [snapshotDate]
  )).rows[0].v);

  const replyStats = (await query(
    `SELECT
       COUNT(*) FILTER (WHERE event_type='sent')::int as sent,
       COUNT(*) FILTER (WHERE event_type='replied')::int as replied
     FROM buyer_engagement WHERE event_at::date::text >= $1 AND event_at::date::text <= $2`,
    [sevenDaysAgo, snapshotDate]
  )).rows[0];
  const apolloReplyRate = replyStats.sent > 0 ? (replyStats.replied / replyStats.sent) * 100 : 0;

  const linkedinPipelineCount = parseInt((await query(
    `SELECT COUNT(*)::int as v FROM linkedin_outreach`
  )).rows[0].v);

  const warmLeadsCount = parseInt((await query(
    `SELECT COUNT(DISTINCT contact_email)::int as v FROM buyer_engagement
     WHERE event_type IN ('clicked', 'replied') AND event_at::date::text >= $1`,
    [sevenDaysAgo]
  )).rows[0].v);

  const skusAddedThisWeek = parseInt((await query(
    `SELECT COUNT(*)::int as v FROM skus WHERE created_at >= NOW() - INTERVAL '7 days'`
  )).rows[0].v);

  const githubCommitsThisWeek = parseInt((await query(
    `SELECT COALESCE(SUM(commits), 0)::int as v FROM github_stats WHERE stat_date >= $1 AND stat_date <= $2`,
    [sevenDaysAgo, snapshotDate]
  )).rows[0].v);

  const snapshot = {
    snapshot_date: snapshotDate,
    revenue_actual: revenueActual,
    revenue_target: dailyTarget,
    revenue_pct: revenuePct,
    team_avg_score: teamAvgScore,
    top_sku: topSku,
    top_buyer_segment: topBuyerSegment,
    apollo_emails_sent: apolloEmailsSent,
    apollo_reply_rate: parseFloat(apolloReplyRate.toFixed(2)),
    linkedin_pipeline_count: linkedinPipelineCount,
    warm_leads_count: warmLeadsCount,
    skus_added_this_week: skusAddedThisWeek,
    github_commits_this_week: githubCommitsThisWeek,
  };

  if (!dryRun) {
    await query(
      `INSERT INTO metrics_snapshots (id, snapshot_date, revenue_actual, revenue_target, revenue_pct, team_avg_score, top_sku, top_buyer_segment, apollo_emails_sent, apollo_reply_rate, linkedin_pipeline_count, warm_leads_count, skus_added_this_week, github_commits_this_week)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (snapshot_date) DO UPDATE SET
         revenue_actual = EXCLUDED.revenue_actual,
         revenue_target = EXCLUDED.revenue_target,
         revenue_pct = EXCLUDED.revenue_pct,
         team_avg_score = EXCLUDED.team_avg_score,
         top_sku = EXCLUDED.top_sku,
         top_buyer_segment = EXCLUDED.top_buyer_segment,
         apollo_emails_sent = EXCLUDED.apollo_emails_sent,
         apollo_reply_rate = EXCLUDED.apollo_reply_rate,
         linkedin_pipeline_count = EXCLUDED.linkedin_pipeline_count,
         warm_leads_count = EXCLUDED.warm_leads_count,
         skus_added_this_week = EXCLUDED.skus_added_this_week,
         github_commits_this_week = EXCLUDED.github_commits_this_week`,
      [
        crypto.randomUUID(), snapshot.snapshot_date, snapshot.revenue_actual, snapshot.revenue_target, snapshot.revenue_pct,
        snapshot.team_avg_score, snapshot.top_sku, snapshot.top_buyer_segment,
        snapshot.apollo_emails_sent, snapshot.apollo_reply_rate, snapshot.linkedin_pipeline_count,
        snapshot.warm_leads_count, snapshot.skus_added_this_week, snapshot.github_commits_this_week,
      ]
    );
  }

  return snapshot;
}

const ANOMALY_LABELS = {
  revenue_actual: 'Daily revenue',
  team_avg_score: 'Team average score',
  apollo_emails_sent: 'Apollo emails sent',
  apollo_reply_rate: 'Apollo reply rate',
  linkedin_pipeline_count: 'LinkedIn pipeline',
  warm_leads_count: 'Warm leads count',
  skus_added_this_week: 'SKUs added (7d)',
  github_commits_this_week: 'GitHub commits (7d)',
};

async function detectAnomalies({ thresholdPct = 30 } = {}) {
  const rows = (await query(
    `SELECT * FROM metrics_snapshots ORDER BY snapshot_date DESC LIMIT 8`
  )).rows;
  if (rows.length < 4) {
    return { anomalies: [], baseline_size: Math.max(rows.length - 1, 0), note: 'insufficient baseline (need 4+ days of snapshots)' };
  }
  const today = rows[0];
  const baseline = rows.slice(1);
  const anomalies = [];
  for (const [field, label] of Object.entries(ANOMALY_LABELS)) {
    const values = baseline.map(b => parseFloat(b[field]) || 0);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    if (avg === 0) continue;
    const todayVal = parseFloat(today[field]) || 0;
    const deltaPct = ((todayVal - avg) / avg) * 100;
    if (Math.abs(deltaPct) > thresholdPct) {
      anomalies.push({
        metric: field,
        label,
        today: todayVal,
        baseline_avg: parseFloat(avg.toFixed(2)),
        delta_pct: parseFloat(deltaPct.toFixed(1)),
        direction: deltaPct > 0 ? 'up' : 'down',
      });
    }
  }
  // Sort by absolute delta so the biggest swings appear first
  anomalies.sort((a, b) => Math.abs(b.delta_pct) - Math.abs(a.delta_pct));
  return { anomalies, baseline_size: baseline.length, snapshot_date: today.snapshot_date };
}

module.exports = { takeMetricsSnapshot, detectAnomalies };
