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
const { syncAlgoliaSearchData, generateSEORecommendations } = require('./src/lib/agents/growth-agent');
const { cascadeGoals, assignWeeklyKPIsForAll, checkAndRecalc } = require('./src/lib/agents/goal-engine');
const { takeMetricsSnapshot } = require('./src/lib/agents/metrics-snapshot');
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

// Daily 00:00 UTC: Layer 5 — write a metrics_snapshots row for the day that just ended
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Metrics snapshot starting...');
  try {
    const snap = await takeMetricsSnapshot();
    console.log(`[CRON] Metrics snapshot done — ${snap.snapshot_date}: rev=$${snap.revenue_actual} (${snap.revenue_pct}% of daily target), team=${snap.team_avg_score}, anomaly_seed_written`);
  } catch (e) {
    console.error('[CRON] Metrics snapshot error:', e.message);
  }
});

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

// Monday 8 AM: Goal Engine — cascade goals then assign weekly KPIs for all active users
cron.schedule('0 8 * * 1', async () => {
  console.log('[CRON] Goal Engine starting...');
  try {
    const cascade = await cascadeGoals();
    if (cascade.skipped) console.log(`[CRON] Goal cascade skipped — ${cascade.reason}`);
    else console.log(`[CRON] Goal cascade done — annual=${cascade.counts.annual}, quarterly=${cascade.counts.quarterly}, monthly=${cascade.counts.monthly}, weekly=${cascade.counts.weekly}, daily=${cascade.counts.daily}`);
  } catch (e) {
    console.error('[CRON] Goal cascade error:', e.message);
  }
  try {
    const assigned = await assignWeeklyKPIsForAll();
    console.log(`[CRON] Weekly KPI assignment done — ${assigned.total} users for week ${assigned.week_start}`);
  } catch (e) {
    console.error('[CRON] Weekly KPI assignment error:', e.message);
  }
});

// Monday 8 AM: Growth Agent — Algolia search sync then SEO recommendations
cron.schedule('0 8 * * 1', async () => {
  console.log('[CRON] Growth agent starting...');
  try {
    const sync = await syncAlgoliaSearchData();
    if (sync.skipped) console.log(`[CRON] Algolia sync skipped — ${sync.reason}`);
    else console.log(`[CRON] Algolia sync done — ${sync.no_result.length} no-result queries, ${sync.top_queries.length} top queries`);
  } catch (e) {
    console.error('[CRON] Algolia sync error:', e.message);
  }
  try {
    const rec = await generateSEORecommendations();
    console.log(`[CRON] SEO recommendations done — ${rec.top_molecules?.length || 0} molecules identified`);
  } catch (e) {
    console.error('[CRON] SEO recommendations error:', e.message);
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

// Daily 6 PM: Goal Engine — 15% divergence check, auto-recalc if exceeded
cron.schedule('0 18 * * *', async () => {
  console.log('[CRON] Goal divergence check starting...');
  try {
    const result = await checkAndRecalc();
    if (result.skipped) console.log(`[CRON] Divergence check skipped — ${result.reason}`);
    else console.log(`[CRON] Divergence check fired — ${result.month} ${result.direction} by ${result.divergence_pct.toFixed(1)}%, recalc triggered`);
  } catch (e) {
    console.error('[CRON] Goal divergence check error:', e.message);
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
