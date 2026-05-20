// server.js — PlaybookOS main server
require('dotenv').config();
const { initDB, initPhase2, migrateSchemas, query } = require('./src/lib/db'); initDB().then(() => initPhase2()).then(() => migrateSchemas()).catch(e => console.error("DB init error:", e.message));
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { syncGitHubAllDevs, runWeeklyAnalysis, scoreAllAndCoach } = require('./src/lib/jobs');
const { analyzeRevenueTrends, getProcurementPriorities } = require('./src/lib/agents/revenue-agent');
const { generateDailyBriefing } = require('./src/lib/agents/briefing-agent');
const routes = require('./src/api/routes');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString(), db: 'connected' });
  } catch (e) {
    res.status(503).json({ status: 'error', uptime: process.uptime(), timestamp: new Date().toISOString(), db: 'error', error: e.message });
  }
});

// API routes
app.use('/api', routes);

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── CRON JOBS ─────────────────────────────────────────────────────────────────

// Daily 7 AM: Command Center briefing to admin
cron.schedule('0 7 * * *', async () => {
  console.log('[CRON] Daily briefing starting...');
  try {
    const result = await generateDailyBriefing();
    console.log(`[CRON] Daily briefing done — date=${result.snapshot.date}, emailed=${result.emailed} to ${result.emailed_to}`);
  } catch (e) {
    console.error('[CRON] Daily briefing error:', e.message);
  }
});

// Daily 8 AM: sync GitHub for all dev users
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] GitHub sync starting...');
  try {
    const result = await syncGitHubAllDevs();
    console.log(`[CRON] GitHub sync done — ${result.users} users for ${result.date}`);
  } catch (e) {
    console.error('[CRON] GitHub sync error:', e.message);
  }
});

// Monday 9 AM: weekly AI analysis + email to admin
cron.schedule('0 9 * * 1', async () => {
  console.log('[CRON] Weekly AI analysis...');
  try {
    const result = await runWeeklyAnalysis();
    console.log(`[CRON] Weekly analysis done — ${result.thisMonth}, $${result.monthRevenue.toLocaleString()} of $${result.monthTarget.toLocaleString()} (${result.pct}%), emailed=${result.emailed}`);
  } catch (e) {
    console.error('[CRON] Weekly analysis error:', e.message);
  }
});

// Monday 9 AM: revenue intelligence + procurement priorities (chained, alongside the weekly analysis)
cron.schedule('0 9 * * 1', async () => {
  console.log('[CRON] Revenue intelligence starting...');
  try {
    const rev = await analyzeRevenueTrends();
    console.log(`[CRON] Revenue intelligence done — ${rev.period.this_month}, trend=${rev.velocity.trend}, ${rev.monthly.pct}% of target`);
  } catch (e) {
    console.error('[CRON] Revenue intelligence error:', e.message);
    return;
  }
  try {
    const proc = await getProcurementPriorities();
    if (proc.skipped) console.log(`[CRON] Procurement priorities skipped — ${proc.reason}`);
    else console.log(`[CRON] Procurement priorities done — ${proc.items.length} SKUs, emailed ${proc.emailed} of ${proc.recipients.length} procurement users`);
  } catch (e) {
    console.error('[CRON] Procurement priorities error:', e.message);
  }
});

// Daily 6 PM: check milestone triggers
cron.schedule('0 18 * * *', async () => {
  const secret = process.env.TRIGGERS_SECRET;
  if (!secret) { console.warn('[CRON] TRIGGERS_SECRET not set, skipping milestone check'); return; }
  try {
    await fetch(`http://localhost:${PORT}/api/triggers/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` }
    });
  } catch {}
});

// Daily 6 PM: AI performance scoring + per-user coaching email
cron.schedule('0 18 * * *', async () => {
  console.log('[CRON] Performance scoring starting...');
  try {
    const result = await scoreAllAndCoach();
    console.log(`[CRON] Performance scoring done — scored ${result.totalUsers}, emailed ${result.sent}, escalations ${result.escalations}`);
  } catch (e) {
    console.error('[CRON] Performance scoring error:', e.message);
  }
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
