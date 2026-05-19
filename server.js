// server.js — PlaybookOS main server
require('dotenv').config();
const { initDB, initPhase2, migrateSchemas, query } = require('./src/lib/db'); initDB().then(() => initPhase2()).then(() => migrateSchemas()).catch(e => console.error("DB init error:", e.message));
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { syncGitHubAllDevs, runWeeklyAnalysis } = require('./src/lib/jobs');
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
