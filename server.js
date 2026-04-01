// server.js — PlaybookOS main server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { getDb, syncGitHubForUser, analyzeTeamProgress, getTarget, sendEmail } = require('./src/lib/core');
const routes = require('./src/api/routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', routes);

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── CRON JOBS ─────────────────────────────────────────────────────────────────

// Daily 8 AM: sync GitHub for all dev users
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] GitHub sync starting...');
  const db = getDb();
  const devUsers = db.prepare(`SELECT * FROM users WHERE role='dev' AND github_username IS NOT NULL AND is_active=1`).all();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (const u of devUsers) {
    await syncGitHubForUser(u, yesterday);
  }
  console.log(`[CRON] GitHub sync done — ${devUsers.length} users`);
});

// Monday 9 AM: weekly AI analysis + email to admin
cron.schedule('0 9 * * 1', async () => {
  console.log('[CRON] Weekly AI analysis...');
  const db = getDb();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date LIKE ?`).get(thisMonth + '%').v;
  const monthTarget = getTarget('monthly', thisMonth, 'revenue') || 1200000;

  const teamRows = db.prepare(`
    SELECT u.name, u.role, a.metric, SUM(a.value) as total
    FROM activity_logs a JOIN users u ON u.id=a.user_id
    WHERE a.log_date BETWEEN date('now','-7 days') AND date('now')
    GROUP BY u.id, a.metric
  `).all();

  const teamText = teamRows.map(r => `${r.name} (${r.role}): ${r.metric} = ${r.total}`).join('\n') || 'No activity logged.';
  const analysis = await analyzeTeamProgress({ period: thisMonth, revenue: monthRevenue, revenueTarget: monthTarget, teamActivity: teamText, behindMetrics: monthRevenue < monthTarget * 0.8 ? 'Revenue behind' : '' });

  db.prepare(`INSERT INTO ai_analyses (id,analysis_type,period_key,content) VALUES (?,?,?,?)`)
    .run(require('crypto').randomUUID(), 'weekly_cron', thisMonth, analysis);

  const adminUser = db.prepare(`SELECT * FROM users WHERE role='admin' LIMIT 1`).get();
  if (adminUser) {
    const pct = monthTarget > 0 ? Math.round((monthRevenue / monthTarget) * 100) : 0;
    await sendEmail({
      to: adminUser.email,
      subject: `PlaybookOS Weekly Report — ${thisMonth} (${pct}% of target)`,
      triggerType: 'weekly_report',
      html: `
        <div style="font-family:Arial;max-width:600px;margin:0 auto">
          <div style="background:#1B3A6B;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="color:#fff;margin:0">Abiozen Weekly Report</h2>
            <p style="color:#9FE1CB;margin:4px 0 0">${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
          </div>
          <div style="padding:20px;border:1px solid #eee;border-top:none">
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
              <tr>
                <td style="padding:10px;background:#f5f5f5;border-radius:4px;text-align:center">
                  <div style="font-size:12px;color:#666">Month revenue</div>
                  <div style="font-size:22px;font-weight:bold;color:#1B3A6B">$${monthRevenue.toLocaleString()}</div>
                  <div style="font-size:12px;color:#0D7377">target: $${monthTarget.toLocaleString()} (${pct}%)</div>
                </td>
              </tr>
            </table>
            <h3 style="color:#0D7377">AI Analysis</h3>
            <p style="line-height:1.7;color:#333">${analysis}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
            <p style="font-size:12px;color:#888">View full dashboard: ${process.env.BASE_URL || 'http://localhost:3000'}</p>
          </div>
        </div>
      `
    });
  }
  console.log('[CRON] Weekly analysis done');
});

// Daily 6 PM: check milestone triggers
cron.schedule('0 18 * * *', async () => {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/triggers/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer system` }
    });
  } catch {}
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║         ABIOZEN PLAYBOOKOS — RUNNING             ║
╠══════════════════════════════════════════════════╣
║  URL:    http://localhost:${PORT}                   ║
║  API:    http://localhost:${PORT}/api               ║
║                                                  ║
║  First time? Run: node scripts/setup-db.js       ║
╚══════════════════════════════════════════════════╝
  `);
});
