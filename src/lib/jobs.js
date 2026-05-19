const crypto = require('crypto');
const { query } = require('./db');
const { syncGitHubForUser, analyzeTeamProgress } = require('./core');
const { sendEmail } = require('./mailer');

async function syncGitHubAllDevs() {
  const devUsers = (await query(
    `SELECT * FROM users WHERE role='dev' AND github_username IS NOT NULL AND is_active=1`
  )).rows;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (const u of devUsers) {
    await syncGitHubForUser(u, yesterday);
  }
  return { users: devUsers.length, date: yesterday };
}

function weeklyReportHtml({ monthRevenue, monthTarget, pct, analysis }) {
  return `
    <div style="font-family:Arial;max-width:600px;margin:0 auto">
      <div style="background:#1B3A6B;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0">Abiozen Weekly Report</h2>
        <p style="color:#9FE1CB;margin:4px 0 0">${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
      </div>
      <div style="padding:20px;border:1px solid #eee;border-top:none">
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <tr><td style="padding:10px;background:#f5f5f5;border-radius:4px;text-align:center">
            <div style="font-size:12px;color:#666">Month revenue</div>
            <div style="font-size:22px;font-weight:bold;color:#1B3A6B">$${monthRevenue.toLocaleString()}</div>
            <div style="font-size:12px;color:#0D7377">target: $${monthTarget.toLocaleString()} (${pct}%)</div>
          </td></tr>
        </table>
        <h3 style="color:#0D7377">AI Analysis</h3>
        <p style="line-height:1.7;color:#333">${analysis}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
        <p style="font-size:12px;color:#888">View full dashboard: ${process.env.BASE_URL || 'http://localhost:3000'}</p>
      </div>
    </div>
  `;
}

async function runWeeklyAnalysis({ dryRun = false } = {}) {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthRevenue = parseFloat(
    (await query(
      `SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text LIKE $1`,
      [thisMonth + '%']
    )).rows[0].v
  );
  const targetRow = await query(
    `SELECT target_value FROM targets WHERE period_type='monthly' AND period_key=$1 AND metric='revenue'`,
    [thisMonth]
  );
  const monthTarget = parseFloat(targetRow.rows[0]?.target_value) || 1200000;

  const teamRows = (await query(`
    SELECT u.name, u.role, a.metric, SUM(a.value) as total
    FROM activity_logs a JOIN users u ON u.id=a.user_id
    WHERE a.log_date >= (NOW() - INTERVAL '7 days')::date::text
    GROUP BY u.id, u.name, u.role, a.metric
  `)).rows;

  const teamText = teamRows.map(r => `${r.name} (${r.role}): ${r.metric} = ${r.total}`).join('\n') || 'No activity logged.';
  const behindMetrics = monthRevenue < monthTarget * 0.8 ? 'Revenue behind' : '';
  const pct = monthTarget > 0 ? Math.round((monthRevenue / monthTarget) * 100) : 0;

  let analysis = '[dry run] Claude analysis and email skipped';
  let emailed = false;

  if (!dryRun) {
    analysis = await analyzeTeamProgress({ period: thisMonth, revenue: monthRevenue, revenueTarget: monthTarget, teamActivity: teamText, behindMetrics });
    await query(
      `INSERT INTO ai_analyses (id,analysis_type,period_key,content) VALUES ($1,$2,$3,$4)`,
      [crypto.randomUUID(), 'weekly_cron', thisMonth, analysis]
    );
    const adminUser = (await query(`SELECT * FROM users WHERE role='admin' LIMIT 1`)).rows[0];
    if (adminUser) {
      emailed = await sendEmail({
        to: adminUser.email,
        subject: `PlaybookOS Weekly Report — ${thisMonth} (${pct}% of target)`,
        html: weeklyReportHtml({ monthRevenue, monthTarget, pct, analysis })
      });
    }
  }

  return { thisMonth, monthRevenue, monthTarget, pct, teamRowCount: teamRows.length, analysisChars: analysis?.length || 0, emailed, dryRun };
}

async function checkMilestoneTriggers({ dryRun = false } = {}) {
  const yearRev = parseFloat(
    (await query(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date LIKE '2026%'`)).rows[0].v
  );
  const triggered = [];
  if (yearRev >= 100000) {
    const ms = (await query(`SELECT * FROM milestones WHERE name LIKE '%Account Manager%'`)).rows[0];
    if (ms && ms.status === 'pending') {
      if (!dryRun) {
        await query(`UPDATE milestones SET status='in_progress' WHERE id=$1`, [ms.id]);
        const admin = (await query(`SELECT * FROM users WHERE role='admin' LIMIT 1`)).rows[0];
        if (admin) {
          await sendEmail({
            to: admin.email,
            subject: 'Trigger: $100K revenue — Hire Account Manager now',
            html: `<div style="font-family:Arial;padding:24px"><h2>Milestone Trigger</h2><p>Revenue: $${yearRev.toLocaleString()}</p><p>Action: Begin account manager hiring immediately.</p></div>`
          });
        }
      }
      triggered.push('$100K milestone triggered');
    }
  }
  return { yearRev, triggered, dryRun };
}

module.exports = { syncGitHubAllDevs, runWeeklyAnalysis, checkMilestoneTriggers };
