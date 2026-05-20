const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');
const { getWarmLeads } = require('./customer-agent');

const DAY_MS = 86400000;
const fmt = n => '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

async function getApolloRepliesTotal() {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.apollo.io/v1/emailer_campaigns/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({ per_page: 25 })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.emailer_campaigns || []).reduce((s, c) => s + (c.unique_replied || 0), 0);
  } catch { return null; }
}

async function gatherBriefingData() {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  const yesterdayISO = new Date(today.getTime() - DAY_MS).toISOString().slice(0, 10);
  const thisMonth = todayISO.slice(0, 7);

  const newOrders = (await query(
    `SELECT id, order_date, amount, buyer_type, product_category, notes, created_at
     FROM orders WHERE created_at >= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC`
  )).rows;

  const todayRev = parseFloat((await query(
    `SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text = $1`, [todayISO]
  )).rows[0].v);
  const yesterdayRev = parseFloat((await query(
    `SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text = $1`, [yesterdayISO]
  )).rows[0].v);

  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const monthlyTarget = parseFloat((await query(
    `SELECT target_value FROM targets WHERE period_type='monthly' AND period_key=$1 AND metric='revenue'`,
    [thisMonth]
  )).rows[0]?.target_value || 0);
  const dailyTarget = monthlyTarget / daysInMonth;
  const monthlyActual = parseFloat((await query(
    `SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text LIKE $1`, [thisMonth + '%']
  )).rows[0].v);

  const teamPerf = (await query(`
    SELECT
      COALESCE(ROUND(AVG(score_0_to_100)), 0)::int as avg_score,
      COALESCE(MIN(score_0_to_100), 0)::int as min_score,
      COALESCE(MAX(score_0_to_100), 0)::int as max_score,
      COUNT(*)::int as scored_count,
      COUNT(*) FILTER (WHERE score_0_to_100 < 60)::int as low_count,
      COUNT(*) FILTER (WHERE escalated_to_admin = 1)::int as escalations
    FROM performance_scores WHERE score_date = $1`, [yesterdayISO]
  )).rows[0];

  const flaggedUsers = (await query(`
    SELECT u.name, u.role, p.score_0_to_100, p.escalated_to_admin
    FROM performance_scores p JOIN users u ON u.id = p.user_id
    WHERE p.score_date = $1 AND (p.score_0_to_100 < 60 OR p.escalated_to_admin = 1)
    ORDER BY p.score_0_to_100 ASC`, [yesterdayISO]
  )).rows;

  const apolloRepliesTotal = await getApolloRepliesTotal();
  let apolloRepliesDelta = null;
  if (apolloRepliesTotal !== null) {
    const priorBriefing = (await query(
      `SELECT content FROM ai_analyses WHERE analysis_type='daily_briefing' ORDER BY created_at DESC LIMIT 1`
    )).rows[0];
    if (priorBriefing) {
      try {
        const prior = JSON.parse(priorBriefing.content);
        if (typeof prior.snapshot?.apollo_replies_total === 'number') {
          apolloRepliesDelta = apolloRepliesTotal - prior.snapshot.apollo_replies_total;
        }
      } catch {}
    }
  }

  const newSkus = (await query(
    `SELECT id, name, category, supplier, sale_price FROM skus WHERE created_at >= NOW() - INTERVAL '24 hours' ORDER BY created_at DESC`
  )).rows;

  const ghStats = (await query(
    `SELECT
       COALESCE(SUM(commits), 0)::int as commits,
       COALESCE(SUM(prs_merged), 0)::int as prs_merged,
       COALESCE(SUM(prs_opened), 0)::int as prs_opened,
       COUNT(DISTINCT github_username)::int as active_devs
     FROM github_stats WHERE stat_date = $1`, [yesterdayISO]
  )).rows[0];

  const upcomingMilestones = (await query(`
    SELECT id, name, target_date, description
    FROM milestones
    WHERE target_date::date <= (NOW() + INTERVAL '7 days')::date AND status = 'pending'
    ORDER BY target_date`
  )).rows;

  const warmLeads = (await getWarmLeads({ limit: 3 })).map(l => ({
    name: l.name, company: l.company, segment: l.segment, score: l.score, signals: l.signals,
  }));

  return {
    warm_leads: warmLeads,
    snapshot: {
      date: todayISO,
      orders_24h: newOrders.length,
      today_revenue: todayRev,
      yesterday_revenue: yesterdayRev,
      daily_target: Math.round(dailyTarget),
      daily_target_pct_yesterday: dailyTarget > 0 ? Math.round((yesterdayRev / dailyTarget) * 100) : 0,
      monthly_target: monthlyTarget,
      monthly_actual: monthlyActual,
      monthly_pct: monthlyTarget > 0 ? Math.round((monthlyActual / monthlyTarget) * 100) : 0,
      team_avg_score: teamPerf.avg_score,
      team_low_count: teamPerf.low_count,
      team_escalations: teamPerf.escalations,
      team_scored: teamPerf.scored_count,
      apollo_replies_total: apolloRepliesTotal,
      apollo_replies_delta: apolloRepliesDelta,
      new_skus_24h: newSkus.length,
      commits_yesterday: ghStats.commits,
      prs_merged_yesterday: ghStats.prs_merged,
      active_devs_yesterday: ghStats.active_devs,
    },
    new_orders: newOrders,
    new_skus: newSkus,
    flagged_users: flaggedUsers,
    upcoming_milestones: upcomingMilestones,
  };
}

function buildPrompt(data) {
  const s = data.snapshot;
  const ordersList = data.new_orders.length
    ? data.new_orders.slice(0, 5).map(o => `  - ${o.order_date} ${o.product_category || '-'} ${o.buyer_type || '-'} ${fmt(o.amount)}`).join('\n')
    : '  (none)';
  const flagged = data.flagged_users.length
    ? data.flagged_users.map(u => `  - ${u.name} (${u.role}): score ${u.score_0_to_100}${u.escalated_to_admin ? ' [ESCALATED]' : ''}`).join('\n')
    : '  (none)';
  const milestones = data.upcoming_milestones.length
    ? data.upcoming_milestones.map(m => `  - ${m.name} due ${m.target_date}`).join('\n')
    : '  (none in next 7 days)';
  const warmLeadsText = (data.warm_leads || []).length
    ? data.warm_leads.map(l => `  - ${l.name || '(unknown)'} at ${l.company || ''} (${l.segment || 'unknown'}): warmth ${l.score}/100, ${l.signals.join(', ') || 'no signals'}`).join('\n')
    : '  (no warm leads — buyer_engagement empty)';
  const apolloLine = s.apollo_replies_total === null
    ? 'not available'
    : `${s.apollo_replies_total} cumulative` + (s.apollo_replies_delta !== null ? ` (delta since last briefing: ${s.apollo_replies_delta >= 0 ? '+' : ''}${s.apollo_replies_delta})` : ' (first briefing; no delta yet)');

  return `You are the Command Center for Abiozen LLC, a US-based pharmaceutical API distribution company targeting $10M revenue by Dec 31, 2026. You write the 7am briefing for Naresh, the CEO. The briefing must be crisp and fact-based with zero fluff.

LAST 24 HOURS SNAPSHOT:
- New orders: ${s.orders_24h}
- Yesterday revenue: ${fmt(s.yesterday_revenue)} (daily target ~${fmt(s.daily_target)}, ${s.daily_target_pct_yesterday}%)
- Today revenue so far: ${fmt(s.today_revenue)}
- Month-to-date: ${fmt(s.monthly_actual)} of ${fmt(s.monthly_target)} target (${s.monthly_pct}%)
- Team scores yesterday: avg ${s.team_avg_score} across ${s.team_scored} scored, ${s.team_low_count} below 60, ${s.team_escalations} escalations
- Apollo replies: ${apolloLine}
- New SKUs added: ${s.new_skus_24h}
- Dev velocity yesterday: ${s.commits_yesterday} commits, ${s.prs_merged_yesterday} PRs merged across ${s.active_devs_yesterday} devs

Recent orders sample:
${ordersList}

Flagged team members (yesterdays scores):
${flagged}

Pending milestones due within 7 days:
${milestones}

Top 3 warm leads from outreach (highest engagement warmth):
${warmLeadsText}

Write the briefing in EXACTLY this format. No greetings, no headers, no sign-off:

WHAT'S GOING WELL
1. [one specific fact with numbers from above]
2. [one specific fact]
3. [one specific fact]

WHAT'S AT RISK
1. [one specific risk with magnitude in numbers]
2. [one specific risk]
3. [one specific risk]

ACTIONS FOR TODAY
1. [verb] [specific action] - owner: [name or role] - success: [measurable criterion]
2. [same structure]
3. [same structure]

Rules:
- Every line must reference an actual number or specific item from the data above.
- No hedging words. Direct statements only.
- Each action names an owner (Naresh, Palash, sales, marketing, qc, devs) and a verifiable success criterion.
- One sentence per numbered line, max.
- If a section truly has fewer than 3 items worth listing, write "(none today)" for the missing lines rather than padding.

Return ONLY the formatted briefing.`;
}

function renderBriefingEmail(data, briefingText) {
  const s = data.snapshot;
  const yesterdayColor = s.daily_target_pct_yesterday >= 100 ? '#1D9E75' : s.daily_target_pct_yesterday >= 50 ? '#EF9F27' : '#E24B4A';
  const teamColor = s.team_avg_score >= 70 ? '#1D9E75' : s.team_avg_score >= 50 ? '#EF9F27' : '#E24B4A';
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">
  <div style="background:#1B3A6B;padding:20px;border-radius:8px 8px 0 0;color:#fff">
    <h2 style="margin:0;font-size:20px">Daily Briefing — ${s.date}</h2>
    <p style="margin:6px 0 0;color:#9FE1CB;font-size:13px">Command Center · Abiozen LLC</p>
  </div>
  <div style="border:1px solid #e0e0e0;border-top:none;padding:20px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:12px">
      <tr>
        <td style="padding:10px;background:#f5f5f5;border-radius:6px;text-align:center;width:25%">
          <div style="color:#666">Yesterday</div>
          <div style="font-size:18px;font-weight:700;color:${yesterdayColor}">${fmt(s.yesterday_revenue)}</div>
          <div style="font-size:10px;color:#666">${s.daily_target_pct_yesterday}% of ${fmt(s.daily_target)} target</div>
        </td>
        <td style="width:6px"></td>
        <td style="padding:10px;background:#f5f5f5;border-radius:6px;text-align:center;width:25%">
          <div style="color:#666">Month-to-date</div>
          <div style="font-size:18px;font-weight:700;color:#1B3A6B">${fmt(s.monthly_actual)}</div>
          <div style="font-size:10px;color:#666">${s.monthly_pct}% of ${fmt(s.monthly_target)}</div>
        </td>
        <td style="width:6px"></td>
        <td style="padding:10px;background:#f5f5f5;border-radius:6px;text-align:center;width:25%">
          <div style="color:#666">Team score</div>
          <div style="font-size:18px;font-weight:700;color:${teamColor}">${s.team_avg_score}</div>
          <div style="font-size:10px;color:#666">${s.team_escalations} escalation${s.team_escalations === 1 ? '' : 's'}</div>
        </td>
        <td style="width:6px"></td>
        <td style="padding:10px;background:#f5f5f5;border-radius:6px;text-align:center;width:25%">
          <div style="color:#666">Dev velocity</div>
          <div style="font-size:18px;font-weight:700;color:#1B3A6B">${s.commits_yesterday}c · ${s.prs_merged_yesterday}p</div>
          <div style="font-size:10px;color:#666">${s.active_devs_yesterday} devs active</div>
        </td>
      </tr>
    </table>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:18px;line-height:1.7;font-size:13px;white-space:pre-wrap;font-family:Georgia,serif">${briefingText}</div>
    ${(data.warm_leads || []).length ? `
    <div style="margin-top:20px">
      <div style="font-size:13px;font-weight:700;color:#0D7377;margin-bottom:8px">Top 3 warm leads — sales call list</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr style="background:#1B3A6B;color:#fff"><th style="padding:6px 8px;text-align:left">Name</th><th style="padding:6px 8px;text-align:left">Company</th><th style="padding:6px 8px;text-align:left">Segment</th><th style="padding:6px 8px;text-align:right">Warmth</th></tr>
        ${data.warm_leads.map((l, i) => `<tr style="background:${i % 2 ? '#fff' : '#f8fafc'}"><td style="padding:6px 8px">${l.name || '(unknown)'}</td><td style="padding:6px 8px">${l.company || '—'}</td><td style="padding:6px 8px;color:#666">${l.segment || '—'}</td><td style="padding:6px 8px;text-align:right;font-weight:700;color:${l.score >= 70 ? '#1D9E75' : l.score >= 40 ? '#EF9F27' : '#666'}">${l.score}/100</td></tr>`).join('')}
      </table>
    </div>` : ''}
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
    <p style="font-size:11px;color:#888;margin:0">View full dashboard: ${process.env.BASE_URL || 'http://localhost:3000'}</p>
  </div>
</div>`;
}

async function generateDailyBriefing({ dryRun = false } = {}) {
  const data = await gatherBriefingData();
  const briefingText = dryRun
    ? '[dry-run] Claude briefing generation skipped'
    : await runClaudeAnalysis(buildPrompt(data));

  const result = {
    generated_at: new Date().toISOString(),
    snapshot: data.snapshot,
    new_orders: data.new_orders,
    new_skus: data.new_skus,
    flagged_users: data.flagged_users,
    upcoming_milestones: data.upcoming_milestones,
    briefing_text: briefingText,
  };

  if (!dryRun) {
    await query(
      `INSERT INTO ai_analyses (id, analysis_type, period_key, content) VALUES ($1, 'daily_briefing', $2, $3)`,
      [crypto.randomUUID(), data.snapshot.date, JSON.stringify(result)]
    );
    const admin = (await query("SELECT email FROM users WHERE role='admin' AND is_active=1 LIMIT 1")).rows[0];
    const recipient = admin?.email || 'naren@abiozen.com';
    const sent = await sendEmail({
      to: recipient,
      subject: `Daily Briefing — ${data.snapshot.date} (yesterday ${data.snapshot.daily_target_pct_yesterday}% of target)`,
      html: renderBriefingEmail(data, briefingText),
    });
    result.emailed_to = recipient;
    result.emailed = sent;
  }

  return result;
}

module.exports = { generateDailyBriefing };
