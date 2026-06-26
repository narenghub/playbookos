// server.js — PlaybookOS main server
require('dotenv').config();
const { initDB, initPhase2, migrateSchemas, query } = require('./src/lib/db'); initDB().then(() => initPhase2()).then(() => migrateSchemas()).catch(e => { console.error("DB init error:", e.message); process.exit(1); });
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { withAlerts, sendCronAlert } = require('./src/lib/cron-alerts');
const { syncGitHubAllDevs, runWeeklyAnalysis, scoreAllAndCoach } = require('./src/lib/jobs');
const { analyzeRevenueTrends, getProcurementPriorities } = require('./src/lib/agents/revenue-agent');
const { generateDailyBriefing } = require('./src/lib/agents/briefing-agent');
const { syncAlgoliaSearchData, generateSEORecommendations, runMarketIntelligence } = require('./src/lib/agents/growth-agent');
const { trackKeywordRankings, generateSEOTasksForTeam, trackAlgoliaNoResults } = require('./src/lib/agents/seo-agent');
const { cascadeGoals, assignWeeklyKPIsForAll, checkAndRecalc } = require('./src/lib/agents/goal-engine');
const { takeMetricsSnapshot } = require('./src/lib/agents/metrics-snapshot');
const { runMorningBriefing, runPerformanceCheck, runEscalationCheck } = require('./src/lib/agents/orchestrator');
const { runWeeklyLinkedInCampaign } = require('./src/lib/agents/linkedin-agent');
const { businessToday } = require('./src/lib/agent-core');
const routes = require('./src/api/routes');

// Trailing N business days (America/Chicago), newest first, as YYYY-MM-DD strings.
// Anchor the current Chicago date at 12:00 UTC before subtracting whole days so the
// arithmetic never slips across a calendar boundary (including DST transitions).
function trailingBusinessDays(n) {
  const anchor = new Date(`${businessToday()}T12:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    new Date(anchor.getTime() - i * 86400000).toISOString().slice(0, 10));
}

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
cron.schedule('0 0 * * *', withAlerts('daily-0utc-metrics-snapshot', async () => {
  console.log('[CRON] Metrics snapshot starting...');
  const snap = await takeMetricsSnapshot();
  console.log(`[CRON] Metrics snapshot done — ${snap.snapshot_date}: rev=$${snap.revenue_actual} (${snap.revenue_pct}% of daily target), team=${snap.team_avg_score}, anomaly_seed_written`);
}));

// Daily 7 AM: Command Center briefing to admin
cron.schedule('0 7 * * *', withAlerts('daily-7utc-command-center-briefing', async () => {
  console.log('[CRON] Daily briefing starting...');
  const result = await generateDailyBriefing();
  console.log(`[CRON] Daily briefing done — date=${result.snapshot.date}, emailed=${result.emailed} to ${result.emailed_to}`);
}));

// Monday 8 AM: Goal Engine — cascade goals then assign weekly KPIs for all active users
cron.schedule('0 8 * * 1', withAlerts('weekly-mon-8utc-goal-engine', async () => {
  console.log('[CRON] Goal Engine starting...');
  try {
    const cascade = await cascadeGoals();
    if (cascade.skipped) console.log(`[CRON] Goal cascade skipped — ${cascade.reason}`);
    else console.log(`[CRON] Goal cascade done — annual=${cascade.counts.annual}, quarterly=${cascade.counts.quarterly}, monthly=${cascade.counts.monthly}, weekly=${cascade.counts.weekly}, daily=${cascade.counts.daily}`);
  } catch (e) {
    console.error('[CRON] Goal cascade error:', e.message);
    await sendCronAlert('weekly-mon-8utc-goal-engine/cascade', e);
  }
  try {
    const assigned = await assignWeeklyKPIsForAll();
    console.log(`[CRON] Weekly KPI assignment done — ${assigned.total} users for week ${assigned.week_start}`);
  } catch (e) {
    console.error('[CRON] Weekly KPI assignment error:', e.message);
    await sendCronAlert('weekly-mon-8utc-goal-engine/kpi-assignment', e);
  }
}));

// Monday 8 AM: Growth Agent — Algolia search sync then SEO recommendations
cron.schedule('0 8 * * 1', withAlerts('weekly-mon-8utc-growth-agent', async () => {
  console.log('[CRON] Growth agent starting...');
  try {
    const sync = await syncAlgoliaSearchData();
    if (sync.skipped) console.log(`[CRON] Algolia sync skipped — ${sync.reason}`);
    else console.log(`[CRON] Algolia sync done — ${sync.no_result.length} no-result queries, ${sync.top_queries.length} top queries`);
  } catch (e) {
    console.error('[CRON] Algolia sync error:', e.message);
    await sendCronAlert('weekly-mon-8utc-growth-agent/algolia-sync', e);
  }
  try {
    const rec = await generateSEORecommendations();
    console.log(`[CRON] SEO recommendations done — ${rec.top_molecules?.length || 0} molecules identified`);
  } catch (e) {
    console.error('[CRON] SEO recommendations error:', e.message);
    await sendCronAlert('weekly-mon-8utc-growth-agent/recommendations', e);
  }
}));

// Monday 8 AM: SEO Agent — rank tracking, content-gap tasks for seo_specialist, missing-from-catalog Algolia rollup
cron.schedule('0 8 * * 1', withAlerts('weekly-mon-8utc-seo-agent', async () => {
  console.log('[CRON] SEO Agent starting...');
  try {
    const ranks = await trackKeywordRankings();
    if (ranks.skipped) console.log(`[CRON] SEO rank tracking skipped — ${ranks.reason}`);
    else console.log(`[CRON] SEO rank tracking done — ${ranks.persisted} of ${ranks.tracked} queries persisted at ${ranks.recorded_date}`);
  } catch (e) {
    console.error('[CRON] SEO rank tracking error:', e.message);
    await sendCronAlert('weekly-mon-8utc-seo-agent/rankings', e);
  }
  try {
    const tasks = await generateSEOTasksForTeam();
    if (tasks.skipped) console.log(`[CRON] SEO task generation skipped — ${tasks.reason}`);
    else console.log(`[CRON] SEO tasks generated — ${tasks.tasks?.length || 0} tasks, emailed ${tasks.emailed_to?.length || 0} seo_specialist users`);
  } catch (e) {
    console.error('[CRON] SEO task generation error:', e.message);
    await sendCronAlert('weekly-mon-8utc-seo-agent/tasks', e);
  }
  try {
    const noResults = await trackAlgoliaNoResults();
    if (noResults.skipped) console.log(`[CRON] Algolia no-results check skipped — ${noResults.reason}`);
    else console.log(`[CRON] Algolia no-results — ${noResults.missing_count} unique searched-but-missing molecules`);
  } catch (e) {
    console.error('[CRON] Algolia no-results error:', e.message);
    await sendCronAlert('weekly-mon-8utc-seo-agent/no-results', e);
  }
}));

// Daily 8 AM: sync GitHub for all dev users
cron.schedule('0 8 * * *', withAlerts('daily-8utc-github-sync', async () => {
  console.log('[CRON] GitHub sync starting...');
  const result = await syncGitHubAllDevs();
  console.log(`[CRON] GitHub sync done — ${result.users} users for ${result.date}`);
}));

// Monday 9 AM: weekly AI analysis + email to admin
cron.schedule('0 9 * * 1', withAlerts('weekly-mon-9utc-weekly-analysis', async () => {
  console.log('[CRON] Weekly AI analysis...');
  const result = await runWeeklyAnalysis();
  console.log(`[CRON] Weekly analysis done — ${result.thisMonth}, $${result.monthRevenue.toLocaleString()} of $${result.monthTarget.toLocaleString()} (${result.pct}%), emailed=${result.emailed}`);
}));

// Monday 9 AM: revenue intelligence + procurement priorities (chained, alongside the weekly analysis)
cron.schedule('0 9 * * 1', withAlerts('weekly-mon-9utc-revenue-intel', async () => {
  console.log('[CRON] Revenue intelligence starting...');
  const rev = await analyzeRevenueTrends();
  console.log(`[CRON] Revenue intelligence done — ${rev.period.this_month}, trend=${rev.velocity.trend}, ${rev.monthly.pct}% of target`);
  const proc = await getProcurementPriorities();
  if (proc.skipped) console.log(`[CRON] Procurement priorities skipped — ${proc.reason}`);
  else console.log(`[CRON] Procurement priorities done — ${proc.items.length} SKUs, emailed ${proc.emailed} of ${proc.recipients.length} procurement users`);
}));

// Monday 3 PM UTC (9 AM CST) — weekly Market Intelligence: 150 molecules
// (100 research chemicals + 50 GMP APIs). Its own slot, not chained to the 09:00
// UTC weekly analysis, so results land when Naresh and procurement are awake to
// review them. ~2-5 min, 7 Claude calls; withAlerts handles error alerting.
cron.schedule('0 15 * * 1', withAlerts('weekly-mon-15utc-market-intelligence', async () => {
  console.log('[CRON] Market Intelligence starting...');
  const mi = await runMarketIntelligence();
  console.log(`[CRON] Market Intelligence done — ${mi.total} molecules (${mi.research_count} research + ${mi.gmp_count} GMP) for ${mi.week_start}, ${mi.tasks_queued || 0} tasks queued`);
}));

// Daily 6 PM: check milestone triggers
cron.schedule('0 18 * * *', withAlerts('daily-18utc-milestone-triggers', async () => {
  const secret = process.env.TRIGGERS_SECRET;
  if (!secret) { console.warn('[CRON] TRIGGERS_SECRET not set, skipping milestone check'); return; }
  try {
    await fetch(`http://localhost:${PORT}/api/triggers/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` }
    });
  } catch {}
}));

// Daily 6 PM: AI performance scoring + per-user coaching email.
// Legacy scoreAllAndCoach kept intentionally for daily "Your day at Abiozen" emails.
// runPerformanceCheck (new path below) writes the 4-component score columns but
// does NOT replicate the daily coaching email to every active non-admin user.
// Revisit post-launch — see ADR or June 8 decision.
cron.schedule('0 18 * * *', withAlerts('daily-18utc-performance-scoring', async () => {
  console.log('[CRON] Performance scoring starting...');
  try {
    const result = await scoreAllAndCoach();
    console.log(`[CRON] Performance scoring done — scored ${result.totalUsers}, emailed ${result.sent}, escalations ${result.escalations}`);
  } catch (e) {
    console.error('[CRON] Performance scoring error:', e.message);
    await sendCronAlert('daily-18utc-performance-scoring/legacy-coaching', e);
  }
  // New 4-component scoring + 4-level escalation workflow (Performance Accountability).
  // Recompute the trailing 3 days (today + 2 prior) every run so a task completed a
  // day or two after it was assigned retroactively credits the day it was completed.
  // The score write is idempotent (ON CONFLICT (user_id, score_date) DO UPDATE).
  try {
    let totalScored = 0;
    for (const d of trailingBusinessDays(3)) {
      const score = await runPerformanceCheck({ date: d });
      totalScored += score.count;
      console.log(`[CRON] runPerformanceCheck ${d} done — ${score.count} users scored`);
    }
    console.log(`[CRON] runPerformanceCheck trailing-3 done — ${totalScored} user-days scored`);
    // Escalation reads only the latest day's scores; run it once for today.
    const esc = await runEscalationCheck();
    console.log(`[CRON] runEscalationCheck done — ${esc.count} escalation(s) fired`);
  } catch (e) {
    console.error('[CRON] Performance Accountability error:', e.message);
    await sendCronAlert('daily-18utc-performance-scoring/new-accountability', e);
  }
}));

// Daily 6 PM: Goal Engine — 15% divergence check, auto-recalc if exceeded
cron.schedule('0 18 * * *', withAlerts('daily-18utc-goal-divergence', async () => {
  console.log('[CRON] Goal divergence check starting...');
  const result = await checkAndRecalc();
  if (result.skipped) console.log(`[CRON] Divergence check skipped — ${result.reason}`);
  else console.log(`[CRON] Divergence check fired — ${result.month} ${result.direction} by ${result.divergence_pct.toFixed(1)}%, recalc triggered`);
}));

// ── AI Agent System crons (timezone: America/Chicago / CST) ───────────────────
// The orchestrator routes each segment to its specialized agents at the local
// time that matches that team's morning.
const CST = { timezone: 'America/Chicago' };

// 10:30pm CST — procurement team morning briefing (9am IST next day)
cron.schedule('30 22 * * *', withAlerts('daily-2230cst-procurement-ist-briefing', async () => {
  console.log('[CRON] Procurement IST briefing starting...');
  const r = await runMorningBriefing({ segment: 'procurement_ist' });
  console.log(`[CRON] Procurement IST briefing done — ran: ${r.ran.join(', ') || 'none'}`);
}), CST);

// 1:30am CST — dev + SEO team morning briefing (1pm IST)
cron.schedule('30 1 * * *', withAlerts('daily-130cst-dev-seo-ist-briefing', async () => {
  console.log('[CRON] Dev/SEO IST briefing starting...');
  const r = await runMorningBriefing({ segment: 'dev_seo_ist' });
  console.log(`[CRON] Dev/SEO IST briefing done — ran: ${r.ran.join(', ') || 'none'}`);
}), CST);

// 7:00am CST — CEO briefing (CEO only)
cron.schedule('0 7 * * *', withAlerts('daily-7cst-ceo-briefing', async () => {
  console.log('[CRON] CEO briefing starting...');
  const r = await runMorningBriefing({ segment: 'ceo' });
  console.log(`[CRON] CEO briefing done — ran: ${r.ran.join(', ') || 'none'}`);
}), CST);

// Monday 10:00am CST — drafts the week's LinkedIn content (product / market /
// company-update posts) into linkedin_content_queue and emails the CEO.
cron.schedule('0 10 * * 1', withAlerts('weekly-mon-10cst-linkedin-content', async () => {
  console.log('[CRON] LinkedIn content scheduler starting...');
  const r = await runWeeklyLinkedInCampaign();
  console.log(`[CRON] LinkedIn content scheduler done — ${r.drafts_created} drafts for week of ${r.week.monday}`);
}), CST);

// 8:00am CST — US team briefing + agent task assignment (HR review on Mondays)
cron.schedule('0 8 * * *', withAlerts('daily-8cst-us-team-briefing', async () => {
  console.log('[CRON] US team briefing starting...');
  const r = await runMorningBriefing({ segment: 'us_team' });
  console.log(`[CRON] US team briefing done — ran: ${r.ran.join(', ') || 'none'}`);
}), CST);

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
