// server.js — PlaybookOS main server
require('dotenv').config();
const { initDB, initPhase2, migrateSchemas, query } = require('./src/lib/db'); initDB().then(() => initPhase2()).then(() => migrateSchemas()).then(() => require('./src/lib/agents/procurement-agent').seedSupplierDatabase().then(r => console.log(`[boot] supplier seed: ${r.seeded} added, ${r.skipped} existing`)).catch(e => console.error('[boot] supplier seed failed:', e.message))).then(() => require('./src/lib/agents/research-agent').seedPatentWatch().then(r => console.log(`[boot] patent-watch seed: ${r.seeded} added, ${r.skipped} existing`)).catch(e => console.error('[boot] patent seed failed:', e.message))).then(() => require('./src/lib/agents/inquiry-agent').seedMoleculePricing().then(r => console.log(`[boot] pricing seed: ${r.seeded} added, ${r.skipped} existing`)).catch(e => console.error('[boot] pricing seed failed:', e.message))).catch(e => { console.error("DB init error:", e.message); process.exit(1); });
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
const { runMorningBriefing, runPerformanceCheck, runEscalationCheck, workdayStatus } = require('./src/lib/agents/orchestrator');
const { runWeeklyLinkedInCampaign } = require('./src/lib/agents/linkedin-agent');
const { runEmailEngine } = require('./src/lib/agents/email-engine');
const { processApolloReplies } = require('./src/lib/agents/sales-agent');
const { runProcurementAgent, checkNoResponse, seedSupplierDatabase } = require('./src/lib/agents/procurement-agent');
const { runMeetAgent } = require('./src/lib/agents/meet-agent');
const { runResearchAgent, runWeeklyDigest } = require('./src/lib/agents/research-agent');
const { runReorderAgent } = require('./src/lib/agents/reorder-agent');
const { runInquiryAgent } = require('./src/lib/agents/inquiry-agent');
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

// Public sitemap for Google — lists the generated catalog landing-page URLs on
// abiozen.com (built from seo_content). Unauthenticated so search engines can fetch it.
app.get('/sitemap.xml', async (req, res) => {
  try {
    const base = process.env.STORE_BASE_URL || 'https://abiozen.com';
    const rows = (await query(`SELECT url, generated_at FROM seo_content WHERE url IS NOT NULL ORDER BY url`)).rows;
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const urls = rows.map(r => {
      const lastmod = (r.generated_at ? String(r.generated_at) : '').slice(0, 10);
      return `  <url><loc>${esc(base + r.url)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>weekly</changefreq></url>`;
    }).join('\n');
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  } catch (e) {
    res.status(500).set('Content-Type', 'text/plain').send('sitemap error: ' + e.message);
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

// Monday 3:30 PM UTC (9:30 AM CST) — AI Email Engine, 30 min after Market
// Intelligence. The offset is load-bearing, not cosmetic: the engine reads the
// molecule_history rows that the 15:00 job writes, so starting earlier (or
// chaining both into one slot) would generate campaigns off last week's feed.
// 10 molecules x 4 segments = 40 campaigns / 80 variants, ~40 Claude calls,
// drawn from GSC + molecule_history + the Algolia marketplace catalog.
cron.schedule('30 15 * * 1', withAlerts('weekly-mon-1530utc-email-engine', async () => {
  console.log('[CRON] Email Engine starting...');
  const ee = await runEmailEngine({ topMolecules: 10 });
  console.log(`[CRON] Email Engine done — ${ee.generated} campaigns (${ee.generated * 2} variants) for ${ee.week_start} from ${ee.unique_molecules} molecules, ${ee.skipped} skipped, ${ee.errors.length} errors`);
  if (ee.errors.length) console.warn('[CRON] Email Engine errors:', ee.errors.slice(0, 5));
}));

// Hourly (:17) — Sales Agent: pull Apollo replies, classify into leads, WhatsApp
// Naresh on HOT, draft follow-ups on WARM. Off-minute so it doesn't pile onto the
// top-of-hour rush; idempotent (dedups on apollo_message_id) so overlap is safe.
cron.schedule('17 * * * *', withAlerts('hourly-17-sales-replies', async () => {
  const r = await processApolloReplies();
  if (r.new_leads || r.errors.length) {
    console.log(`[CRON] Sales replies — fetched ${r.fetched}, ${r.new_leads} new leads (${r.hot} hot, ${r.warm} warm, ${r.cold} cold), ${r.follow_ups} follow-ups, ${r.errors.length} errors`);
    if (r.errors.length) console.warn('[CRON] Sales reply errors:', r.errors.slice(0, 5));
  }
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

// Tuesday 9am CST — Procurement Agent v2: send RFQ emails for molecules approved
// Monday. Runs after the Monday approval window so Palash's approvals are captured.
cron.schedule('0 9 * * 2', withAlerts('weekly-tue-9cst-procurement-rfqs', async () => {
  console.log('[CRON] Procurement Agent starting...');
  const r = await runProcurementAgent();
  console.log(`[CRON] Procurement Agent done — ${r.rfqs_created} RFQs, ${r.emails_sent} supplier emails, ${r.errors.length} errors`);
  if (r.errors.length) console.warn('[CRON] Procurement errors:', r.errors.slice(0, 5));
}), CST);

// Daily 9am CST — Inquiry Agent: send follow-ups + daily summary to Naresh.
cron.schedule('0 9 * * *', withAlerts('daily-9cst-inquiry-agent', async () => {
  console.log('[CRON] Inquiry Agent starting...');
  const r = await runInquiryAgent();
  console.log(`[CRON] Inquiry Agent done — ${r.active_inquiries} active, ${r.follow_ups_sent} follow-ups, ${r.closed} closed`);
}), CST);

// Hourly :45 — placeholder for inbound-reply polling (manual/webhook driven for now).
cron.schedule('45 * * * *', withAlerts('hourly-45-inquiry-poll', async () => {
  // No IMAP poller wired yet; inbound replies arrive via POST /api/inquiry/:id/reply
  // or a future inbound-email webhook. This tick keeps the schedule slot reserved.
}), CST);

// Wednesday 10am CST — Reorder Agent: mid-week reorder sweep of past buyers.
cron.schedule('0 10 * * 3', withAlerts('weekly-wed-10cst-reorder-agent', async () => {
  console.log('[CRON] Reorder Agent (Wed) starting...');
  const r = await runReorderAgent({ topN: 20 });
  console.log(`[CRON] Reorder Agent done — ${r.candidates_found} candidates, ${r.campaigns_created} campaigns, ~$${r.estimated_pipeline} pipeline`);
}), CST);

// Sunday 8pm CST — Reorder Agent: weekend prep for Monday outreach.
cron.schedule('0 20 * * 0', withAlerts('weekly-sun-20cst-reorder-agent', async () => {
  console.log('[CRON] Reorder Agent (Sun) starting...');
  const r = await runReorderAgent({ topN: 20 });
  console.log(`[CRON] Reorder Agent done — ${r.candidates_found} candidates, ${r.campaigns_created} campaigns`);
}), CST);

// Every night 11pm CST — Research Agent: scan PubMed/FDA/patents/trials/news.
cron.schedule('0 23 * * *', withAlerts('nightly-23cst-research-agent', async () => {
  console.log('[CRON] Research Agent starting...');
  const r = await runResearchAgent();
  console.log(`[CRON] Research Agent done — ${r.findings_total} findings (${r.high_relevance} high), ${r.patents_flagged} patents flagged, ${r.errors.length} errors`);
  if (r.errors.length) console.warn('[CRON] Research errors:', r.errors.slice(0, 5));
}), CST);

// Monday 8am CST — weekly research digest to Naresh (from stored findings).
cron.schedule('0 8 * * 1', withAlerts('weekly-mon-8cst-research-digest', async () => {
  const r = await runWeeklyDigest();
  console.log(`[CRON] Research digest — ${r.findings} findings, sent=${r.sent}`);
}), CST);

// Monday 11am CST — Meet Agent: process weekend/Monday-morning standup recordings.
cron.schedule('0 11 * * 1', withAlerts('weekly-mon-11cst-meet-agent', async () => {
  console.log('[CRON] Meet Agent (Mon) starting...');
  const r = await runMeetAgent({ lookbackDays: 3 });
  console.log(`[CRON] Meet Agent done — ${r.meetings_processed} meetings, ${r.tasks_created} tasks${r.warning ? ' | ' + r.warning : ''}`);
}), CST);

// Friday 4pm CST — Meet Agent: process the week's meeting recordings.
cron.schedule('0 16 * * 5', withAlerts('weekly-fri-16cst-meet-agent', async () => {
  console.log('[CRON] Meet Agent (Fri) starting...');
  const r = await runMeetAgent({ lookbackDays: 7 });
  console.log(`[CRON] Meet Agent done — ${r.meetings_processed} meetings, ${r.tasks_created} tasks${r.warning ? ' | ' + r.warning : ''}`);
}), CST);

// Thursday 9am CST — flag RFQ outreach with no supplier response after 48h.
cron.schedule('0 9 * * 4', withAlerts('weekly-thu-9cst-procurement-followup', async () => {
  const r = await checkNoResponse({ hours: 48 });
  console.log(`[CRON] Procurement follow-up — flagged ${r.flagged_no_response} outreach as no_response`);
}), CST);

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

// 7:00am CST — CEO briefing (CEO only), business days only.
// Skips weekends and US federal holidays (isWorkday, evaluated in CST). The cron
// still fires daily; the guard inside decides whether to send.
cron.schedule('0 7 * * *', withAlerts('daily-7cst-ceo-briefing', async () => {
  const status = workdayStatus();
  if (!status.workday) {
    console.log(`[CRON] CEO briefing skipped — ${status.reason} (${businessToday()})`);
    return;
  }
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
