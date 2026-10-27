// server.js — PlaybookOS main server
require('dotenv').config();
const { initDB, initPhase2, migrateSchemas, migrateResearchIntelligence, migrateResearchIntelligencePhase3, query } = require('./src/lib/db'); initDB().then(() => initPhase2()).then(() => migrateSchemas()).then(() => require('./src/lib/autonomy').migrateAutonomy(query).then(() => console.log('[boot] autonomy kill switch: tables + audit trigger ready'))).then(() => require('./src/lib/idempotency/supplier-rfq').migrate(query).then((r) => { if (r.enforced) { console.log('[boot] supplier RFQ: UNIQUE (rfq_id, supplier_id) enforced'); } else { console.error('[boot] CRITICAL: supplier RFQ uniqueness NOT enforced — RFQ sending will refuse until this is resolved.'); console.error(`[boot]   reason: ${r.error}`); for (const d of (r.duplicates || [])) console.error(`[boot]   duplicate: rfq=${d.rfq_id} supplier=${d.supplier_id} rows=${d.n}`); } })).then(() => migrateResearchIntelligence()).then(() => migrateResearchIntelligencePhase3()).then(() => require('./src/lib/agents/procurement-agent').seedSupplierDatabase().then(r => console.log(`[boot] supplier seed: ${r.seeded} added, ${r.skipped} existing`)).catch(e => console.error('[boot] supplier seed failed:', e.message))).then(() => require('./src/lib/agents/research-agent').seedPatentWatch().then(r => console.log(`[boot] patent-watch seed: ${r.seeded} added, ${r.skipped} existing`)).catch(e => console.error('[boot] patent seed failed:', e.message))).then(() => require('./src/lib/agents/inquiry-agent').seedMoleculePricing().then(r => console.log(`[boot] pricing seed: ${r.seeded} added, ${r.skipped} existing`)).catch(e => console.error('[boot] pricing seed failed:', e.message))).catch(e => { console.error("DB init error:", e.message); process.exit(1); });
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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
const { runResearchIntelIngest } = require('./src/lib/agents/research-intelligence');
const { runProcurementAgent, checkNoResponse, seedSupplierDatabase } = require('./src/lib/agents/procurement-agent');
const { runMeetAgent } = require('./src/lib/agents/meet-agent');
const { runResearchAgent, runWeeklyDigest } = require('./src/lib/agents/research-agent');
const { runReorderAgent } = require('./src/lib/agents/reorder-agent');
const { runInquiryAgent, pollSalesEmailbox } = require('./src/lib/agents/inquiry-agent');
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
// Keep the raw request bytes so webhook routes (e.g. Stripe) can verify signatures;
// harmless for every other route, which still receive the parsed JSON body.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1h", etag: true,
  // index:false so '/' is NOT auto-served here — it falls through to serveShell(), which can
  // inject the PlayNexa flag. (Images and fonts keep the 1h cache.)
  index: false,
  // ── THE SPA'S OWN CODE IS NEVER CACHED: .html AND .js ──────────────────────
  //
  // index.html was already no-store, so a front-end deploy cannot lag behind. .js was NOT, and that gap was
  // a live bug: public/sitenex-phase3.js came back `max-age=3600` while the shell came back `no-store`, so a
  // commit that adds a nav entry AND its page function ships them to a browser UP TO AN HOUR APART. The nav
  // arrives immediately and points at a page the cached script has not registered — the same silent-failure
  // shape as the 30 Sep outage, reached by a different route.
  //
  // THE ALTERNATIVE WAS A VERSION QUERY (?v=<commit sha>) on the script src, which would have kept the hour
  // of caching. Not taken, because the injection would have to happen in serveShell — and `/index.html`
  // requested directly is served by THIS static middleware, not by serveShell, so that path would get an
  // unversioned src. That path is the one scripts/smoke-deployed.sh fetches, so the checker and the browser
  // would be looking at different HTML, which is how a check comes to lie.
  //
  // The cost is one 30 KB script per hard page load, not per navigation. Cheap, and symmetrical.
  //
  // .css IS IN THE SAME SET, for the same reason and not an aesthetic one. public/sitenex.css carries the
  // class definitions the SiteNex markup references. Cached for an hour while the markup is not, a deploy
  // that renames a class ships the new HTML to a browser holding the old stylesheet — and the result is a
  // screen that renders as unstyled text with every control still live. That is harder to diagnose than a
  // blank page, because nothing errors.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// Serve the SPA shell, injecting window.PRODUCT_NAV_ENABLED=true when PRODUCT_NAV_ENABLED is set
// so productNavEnabled() defaults on (the PlayNexa console) without the ?productNav query param.
// Flag read once at boot (a Railway env change restarts the process). Rollback = unset the var
// (classic on next boot); ?productNav=0 always forces classic, no deploy/restart needed.
const PRODUCT_NAV_DEFAULT = String(process.env.PRODUCT_NAV_ENABLED) === 'true';
const SHELL_PATH = path.join(__dirname, 'public', 'index.html');
let _shellInjected = null;
function serveShell(res) {
  res.set('Cache-Control', 'no-store');
  if (!PRODUCT_NAV_DEFAULT) return res.sendFile(SHELL_PATH);            // default OFF → byte-identical static shell
  if (_shellInjected == null) {
    const raw = fs.readFileSync(SHELL_PATH, 'utf8');
    _shellInjected = raw.replace('</head>', '<script>window.PRODUCT_NAV_ENABLED=true;</script></head>');
  }
  res.set('Content-Type', 'text/html; charset=utf-8').send(_shellInjected);
}

// `commit` is here so a deploy can be VERIFIED rather than guessed at.
//
// The guess was `uptime < 180`, and it is wrong in the one case that matters: a container that restarted
// for the PREVIOUS deploy also has a low uptime, so the check passes, the next verification runs against
// old code, and reports a false result. That happened — a boundary fix was reported as still broken in
// production when the container simply had not rolled yet.
//
// RAILWAY_GIT_COMMIT_SHA is set by the platform per build, so comparing it to the SHA just pushed is an
// exact answer: `scripts/wait-for-deploy.sh`.
const COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || null;

app.get('/health', async (req, res) => {
  const base = { uptime: process.uptime(), timestamp: new Date().toISOString(), commit: COMMIT };
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', ...base, db: 'connected' });
  } catch (e) {
    res.status(503).json({ status: 'error', ...base, db: 'error', error: e.message });
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

// ── TOKENISED CLIENT INTAKE — mounted HERE, above all three gates, on purpose ──
//
// This is the one unauthenticated write surface in the application: a client holding an emailed link
// uploads their logo and copy against one deal, with no account. It MUST sit above the permissions
// resolver, the permissions enforcer and the product boundary, because all three decide from req.user
// and there is no req.user — the boundary would find /api/intake/* unclassifiable and fail it closed,
// which is right for an authenticated route and a 403 for every client we send a link to.
//
// The token is the authorisation, and it is checked on every single request in that router. The order
// of these four lines is therefore load-bearing, and src/lib/sitenex/intake-scope.test.js asserts it
// by reading this file — along with the thing that would actually be catastrophic, which is somebody
// declaring a path other than /intake/* inside that router and bypassing authentication entirely.
app.use('/api', require('./src/api/sitenex-intake.routes'));

// The client's page. A STANDALONE file, not the SPA: index.html calls checkAuth and would bounce a
// client with no account to a login screen. Served here rather than relying on express.static so the
// link can be BASE_URL/intake with no .html, and so the token can live in the URL FRAGMENT — which is
// never sent to a server, keeping the credential out of access logs and Referer headers.
app.get('/intake', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'public', 'intake.html'));
});

// Permission resolver SHADOW MODE — observes gate-vs-resolver disagreements after each
// request finishes. Off by default (PERMISSIONS_SHADOW_ENABLED); when off it mounts no
// middleware, so zero shadow code runs per request. Never enforces, never alters responses.
require('./src/lib/permissions/shadow').mount(app);

// Permission resolver ENFORCEMENT (staged, per-role). Runs BEFORE the router: for a role
// listed in PERMISSIONS_ENFORCE_ROLES the resolver decides (403 on deny, with the feature
// key + rule in the body); every other role keeps the existing gate. Empty/unset list =
// enforce nothing. Fails OPEN to the existing gate on any resolver error — never locks out.
require('./src/lib/permissions/enforce').mount(app);

// PRODUCT BOUNDARY — a SECOND, independent gate: does the caller hold the product this route
// belongs to? PRODUCT_BOUNDARY_MODE = off | shadow | enforce, defaulting to SHADOW, so this ships
// observing and blocking nothing. In shadow it logs every evaluated request to product_shadow_log
// (the denominator matters: zero would-blocks across 3 requests means nothing, across 40,000 it
// means the route map is right). Only in enforce does it 403 — and there it FAILS CLOSED on an
// unresolvable product, because the completeness test guarantees the map is total, so an
// unresolvable product at runtime means the map and the routes have diverged.
// Mounted before the router (it matches the concrete path back to a route pattern itself) and
// after enforce, so a permissions denial still reads as a permissions denial.
app.use(require('./src/lib/products/boundary').productBoundary());

// API routes
app.use('/api', routes);

// SiteNex Phase 3 — the deal write path, payment schedules and contracts, in their own router.
// ONE LINE, and after the two gates above so both still apply: a new surface has no reason to be added
// to a 5,000-line file where every change makes the next one riskier. Mounted after the main router,
// which is why no path may be declared in both — the first mount wins and the second becomes dead code.
app.use('/api', require('./src/api/sitenex-phase3.routes'));

// LabConnect — the QC testing lab directory, under the abiozen product. Same argument for its own
// router, same ordering constraint: no path may be declared both here and in routes.js, because the
// first mount wins and the second silently becomes dead code.
app.use('/api', require('./src/api/labconnect.routes'));

// SPA fallback ('/' now routes here too, since express.static has index:false)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  serveShell(res);
});

// ── CRON JOBS ─────────────────────────────────────────────────────────────────

// Daily 00:00 UTC: Layer 5 — write a metrics_snapshots row for the day that just ended
cron.schedule('0 0 * * *', withAlerts('daily-0utc-metrics-snapshot', async () => {
  console.log('[CRON] Metrics snapshot starting...');
  const snap = await takeMetricsSnapshot();
  console.log(`[CRON] Metrics snapshot done — ${snap.snapshot_date}: rev=$${snap.revenue_actual} (${snap.revenue_pct}% of daily target), team=${snap.team_avg_score}, anomaly_seed_written`);
}));

// Weekdays 7:00 AM CST: Command Center briefing to admin.
cron.schedule('0 7 * * 1-5', withAlerts('daily-7cst-command-center-briefing', async () => {
  console.log('[CRON] Daily briefing starting...');
  const result = await generateDailyBriefing();
  console.log(`[CRON] Daily briefing done — date=${result.snapshot.date}, emailed=${result.emailed} to ${result.emailed_to}`);
}), { timezone: 'America/Chicago' });

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

// Monday 9:00 AM CST — weekly Market Intelligence: 150 molecules
// (100 research chemicals + 50 GMP APIs). Its own slot, not chained to the 09:00
// UTC weekly analysis, so results land when Naresh and procurement are awake to
// review them. ~2-5 min, 7 Claude calls; withAlerts handles error alerting.
cron.schedule('0 9 * * 1', withAlerts('weekly-mon-9cst-market-intelligence', async () => {
  console.log('[CRON] Market Intelligence starting...');
  const mi = await runMarketIntelligence();
  console.log(`[CRON] Market Intelligence done — ${mi.total} molecules (${mi.research_count} research + ${mi.gmp_count} GMP) for ${mi.week_start}, ${mi.tasks_queued || 0} tasks queued`);
}), { timezone: 'America/Chicago' });

// Monday 9:30 AM CST — AI Email Engine, 30 min after Market Intelligence.
// The offset is load-bearing, not cosmetic: the engine reads the
// molecule_history rows that the 9:00 job writes, so starting earlier (or
// chaining both into one slot) would generate campaigns off last week's feed.
// 10 molecules x 4 segments = 40 campaigns / 80 variants, ~40 Claude calls,
// drawn from GSC + molecule_history + the Algolia marketplace catalog.
cron.schedule('30 9 * * 1', withAlerts('weekly-mon-930cst-email-engine', async () => {
  console.log('[CRON] Email Engine starting...');
  const ee = await runEmailEngine({ topMolecules: 10 });
  console.log(`[CRON] Email Engine done — ${ee.generated} campaigns (${ee.generated * 2} variants) for ${ee.week_start} from ${ee.unique_molecules} molecules, ${ee.skipped} skipped, ${ee.errors.length} errors`);
  if (ee.errors.length) console.warn('[CRON] Email Engine errors:', ee.errors.slice(0, 5));
}), { timezone: 'America/Chicago' });

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
  // Poll sales@abiozen.com for new inquiry emails: open new inquiries (auto-send
  // the AI first response) and route buyer replies into their open threads.
  const r = await pollSalesEmailbox();
  console.log(`[CRON] Sales mailbox poll — ${r.new_inquiries} new, ${r.replies_routed} replies, ${r.skipped} skipped${r.warning ? ' · ' + r.warning : ''}`);
}), CST);

// Noon CST daily — PRODUCT BOUNDARY shadow read, while the boundary is in shadow mode.
// Reports to agent_activity_log + a notification so nobody has to remember to look. Runs in-app
// because the shadow log is only reachable from here: DATABASE_URL is postgres.railway.internal,
// which nothing outside this container can resolve, so a cloud routine would fire and fail.
// SELF-RETIRING: skips unless PRODUCT_BOUNDARY_MODE is 'shadow', so it stops once enforcement is
// decided rather than becoming a daily message nobody reads.
cron.schedule('0 12 * * *', withAlerts('daily-12cst-product-shadow-read', async () => {
  if (String(process.env.PRODUCT_BOUNDARY_MODE || 'shadow').toLowerCase() !== 'shadow') {
    console.log('[CRON] product-boundary shadow read skipped — mode is not shadow');
    return;
  }
  const { productShadowReport, formatShadowReport } = require('./src/lib/products/shadow-report');
  const r = await productShadowReport({ hours: 24 });
  const body = formatShadowReport(r);
  console.log('[CRON] product-boundary shadow read\n' + body);
  const { logAgentActivity } = require('./src/lib/agent-core');
  await logAgentActivity({
    agent_name: 'product-boundary', action_type: 'shadow_read',
    reasoning: body.slice(0, 3000),
    output_summary: `evaluated=${r.totals.evaluated} would_block=${r.totals.would_block} unresolved=${r.totals.unresolved}`.slice(0, 300),
  }).catch(() => {});
  // A would_block or an unresolved route is actionable; a clean read is not worth a notification.
  if (r.totals.would_block > 0 || r.totals.unresolved > 0) {
    await require('./src/lib/notify').notify({
      kind: 'agent_failed',
      severity: r.totals.would_block > 0 ? 'error' : 'warning',
      title: r.totals.would_block > 0
        ? `Product boundary: ${r.totals.would_block} would-block — middleware bug`
        : `Product boundary: ${r.totals.unresolved} unresolved route(s) — map gap`,
      body: body.slice(0, 500), link_page: 'agent-control',
    }).catch(() => {});
  }
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

// Daily 2am CST — Clinical Demand Intelligence: ingest ClinicalTrials.gov studies,
// classify → infer molecules → catalog-match. Flag-gated no-op unless
// RESEARCH_INTEL_ENABLED='true'; orchestrator never throws (returns errors[]).
cron.schedule('0 2 * * *', withAlerts('daily-2cst-research-intel', async () => {
  if (String(process.env.RESEARCH_INTEL_ENABLED).toLowerCase() !== 'true') {
    console.log('[CRON] Clinical Demand Intelligence skipped (RESEARCH_INTEL_ENABLED != true)');
    return;
  }
  console.log('[CRON] Clinical Demand Intelligence starting...');
  const r = await runResearchIntelIngest({ maxStudies: 50, dryRun: false });
  console.log(`[CRON] Clinical Demand Intelligence done — ${r.studies_new} new studies, ${r.molecules_persisted} molecules, ${r.sourcing_opportunities} opps, $${r.cost_usd}, watermark=${r.watermark_after}, ${r.errors.length} errors`);
  if (r.errors.length) console.warn('[CRON] RI errors:', r.errors.slice(0, 5));
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

// Every 2 hours during business hours (9/11/13/15/17 CST, Mon–Fri) — poll Gmail
// for new Gemini meeting-notes emails and auto-process them (1-day lookback so
// each run only touches fresh notes; unread + at-most-once claim make it idempotent).
cron.schedule('0 9,11,13,15,17 * * 1-5', withAlerts('biz-hours-2h-gemini-notes', async () => {
  console.log('[CRON] Gemini notes poll starting...');
  const r = await require('./src/lib/agents/meet-agent').pollGeminiMeetingNotes({ lookbackDays: 1 });
  console.log(`[CRON] Gemini notes done — ${r.processed}/${r.found} processed, ${r.tasks_created} tasks${r.warning ? ' | ' + r.warning : ''}`);
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

// Weekdays 8:00am CST — US team briefing + agent task assignment (HR review on
// Mondays). Already ran in America/Chicago via CST; restricted to weekdays here.
cron.schedule('0 8 * * 1-5', withAlerts('weekdays-8cst-us-team-briefing', async () => {
  console.log('[CRON] US team briefing starting...');
  const r = await runMorningBriefing({ segment: 'us_team' });
  console.log(`[CRON] US team briefing done — ran: ${r.ran.join(', ') || 'none'}`);
}), CST);

// ── Every hour, :05, Mon–Fri — CPHI follow-up sender ─────────────────────────
//
// WHY HOURLY. Every guard in this campaign is already a hard refusal: a UNIQUE claim row per
// (contact, campaign, step) makes a double-send impossible rather than unlikely, stop-on-reply is
// checked immediately before each send, and nobody is mailed outside 09:30–17:00 in their OWN time
// zone. That last one is why this must be hourly: on the first live run 54 of 72 contacts were
// skipped for being outside their window, because India, China and Italy are never all at their
// desks at once. A once-a-day run reaches whoever happens to be awake at that hour and silently
// never reaches the rest.
//
// WHY max 3. A trade-show follow-up should look like a person working through a stack of business
// cards, which is what it is. Three an hour across business hours is roughly that; it also means a
// mistake in the rendering reaches three people before the next run, not seventy-two.
//
// WHY A FLAG. Deploying code must never be the act that starts mailing 72 people who shook Naren's
// hand. Setting CPHI_FOLLOWUP_ENABLED=true in Railway is a deliberate, reversible decision, made
// once, separately from any push — and removing it is how he stops the campaign from his phone
// without a deploy.
// ── WHICH EVENTS THE HOURLY JOBS COVER ───────────────────────────────────────
//
// Both hourly jobs ran exactly ONE event, read from CPHI_FOLLOWUP_EVENT. That was right when CPHI
// Milan was the only campaign. It stopped being right the moment SCOPE Europe started sending, and
// the reply-sync half is the dangerous one: a SCOPE contact who replies is never marked replied,
// so the sequence does not stop and they are chased anyway, four days after answering. Being
// chased after a good reply is the one failure that turns a warm lead cold.
//
// So the jobs iterate a LIST. CPHI_FOLLOWUP_EVENT still works and still wins if set, which keeps
// the existing Railway variable meaningful; otherwise every event with campaign copy is covered.
// A new event added to the registry must be added here too — deliberately, because sending is not
// something to switch on by side effect.
function activeCampaignEvents() {
  const pinned = String(process.env.CPHI_FOLLOWUP_EVENT || '').trim();
  if (pinned) return [pinned];
  return ['cphi-milan-2026', 'scope-europe-2026'];
}

cron.schedule('5 * * * 1-5', withAlerts('hourly-05-cphi-followup', async () => {
  if (String(process.env.CPHI_FOLLOWUP_ENABLED).toLowerCase() !== 'true') return;  // silent: hourly
  const { runFollowups } = require('./src/lib/campaigns/cphi-runner');
  const problems = [];
  // EVERY event with copy, not one. SCOPE Europe's first touches went out by hand on 23 Oct; the
  // rest are due Monday at 09:30 in London, Berlin and Rome — which is 03:30 in Chicago. A campaign
  // that only advances when somebody is awake to type a command is a campaign that stalls, and the
  // send window already guarantees each message lands inside the recipient's own working hours.
  //
  // `max` is PER EVENT, so two events at max 3 is up to six an hour. That is deliberate and small:
  // the sending domain still carries reputation damage from earlier volume.
  for (const event of activeCampaignEvents()) {
  const lines = [];   // per event: one event's log must not be printed under another's heading
  const r = await runFollowups({
    event,
    fromMailbox: process.env.CPHI_FOLLOWUP_FROM || 'naren@abiozen.com',
    max: parseInt(process.env.CPHI_FOLLOWUP_MAX || '3', 10),
    execute: true,
    // ── A WINDOW OVERRIDE THAT EXPIRES BY ITSELF ────
    // On 12 Oct Naren wanted the whole list out the same day: it was Monday, the show finished the
    // previous week, and a follow-up that waits until people drift back into their own business
    // hours arrives after the handshake has gone cold. But 51 of the 72 were in India, China and
    // Europe, hours outside their window, and the manual override could only be run over an ssh
    // session that kept dying.
    //
    // So the override lives here instead — as a DATE, never a boolean. A plain on/off flag set at
    // 22:00 on a Monday is a flag nobody remembers to unset, and the cost of forgetting is mail
    // landing at 3am local for the rest of the campaign, which is the exact tell this system exists
    // to avoid. An expiry means forgetting is harmless: the window comes back on its own.
    ignoreWindow: require('./src/lib/campaigns/send-window')
      .windowOverrideActive(process.env.CPHI_FOLLOWUP_IGNORE_WINDOW_UNTIL),
    log: (s = '') => lines.push(s),
  });
  // Quiet when there is nothing to do — this fires 45 times a week and an hourly "0 sent" buries
  // the run that actually did something. Noisy the moment it sends or fails.
  if (r.sent || r.failed || r.unfiled.length) {
    console.log(`[CRON] follow-up ${event} — ${r.sent} sent, ${r.failed} failed, `
      + `${r.due} were due of ${r.candidates}${r.unfiled.length ? `, ${r.unfiled.length} UNFILED` : ''}`);
    console.log(lines.join('\n'));
  }
  // withAlerts emails on a throw, so the two states that need a human become throws: a send that
  // errored, and a claim row with no Gmail id — the "did that actually send?" case, worth an email
  // precisely because nobody is watching the logs. COLLECTED rather than thrown inside the loop,
  // because one event's bad hour must not silently cancel the other event's whole send.
  if (r.failed) problems.push(`${event}: ${r.failed} send(s) failed — see cphi_followup_sends.error`);
  if (r.unconfirmed) {
    problems.push(`${event}: ${r.unconfirmed} claimed send(s) have no Gmail message id; they may or `
      + `may not have gone. SELECT * FROM cphi_followup_sends WHERE sent_at IS NULL`);
  }
  }
  if (problems.length) throw new Error(problems.join(' · '));
}), CST);

// ── Every hour, :25, every day — find out who has replied ────────────────────
//
// On 13 Oct the delivery audit reported eight CPHI suppliers had replied and the reply queue,
// run a minute later, reported none. Both read honestly: the audit asked Gmail, the queue read
// cphi_followup_state.status — which the runner only writes at the moment it is about to send
// somebody's NEXT step, four days away. Gmail knew; PlaybookOS did not.
//
// The stop-on-reply guard was never at risk, because that check happens immediately before each
// send. What was broken is that a reply — the most important event in this system — stayed
// invisible until a timer fired. A supplier's catalogue sitting unnoticed for four days is the
// campaign's whole value going stale in an inbox.
//
// Every day rather than weekdays: people answer at the weekend, and knowing on Monday morning is
// worth more than the handful of API calls. No flag gates it, because it only READS Gmail and
// moves active → replied; it sends nothing and can wake nobody up.
cron.schedule('25 * * * *', withAlerts('hourly-25-cphi-reply-sync', async () => {
  const mailbox = process.env.CPHI_FOLLOWUP_FROM || 'naren@abiozen.com';
  const { gmailClientFor } = require('./src/lib/gmail/client');
  const { syncReplies } = require('./src/lib/campaigns/reply-sync');
  const { query } = require('./src/lib/db');

  const g = await gmailClientFor(mailbox);
  if (g.error) throw new Error(`CPHI reply sync cannot act as ${mailbox}: ${g.error}`);

  // EVERY event, not one. A reply that is not seen does not stop the sequence.
  const failures = [];
  // ── WHY THIS IS COLLECTED ACROSS EVENTS AND NOT A LOOP-LOCAL ────
  // It was `let r` INSIDE the loop, and the unreadable-thread check below read `r` after the loop
  // closed. `r` is block-scoped, so that line threw `ReferenceError: r is not defined` on EVERY
  // run — including every successful one. The sync itself completed first, so replies were being
  // marked correctly and the job then died on its last statement, which withAlerts turned into an
  // alert email 168 times a week. Alert noise that fires on success is worse than no alert: it
  // trains the reader to ignore the channel, and a real failure arrives looking identical.
  //
  // The warning it was trying to print had therefore never once appeared. An unreadable thread
  // stays ACTIVE, which is the safe side, but the next send skips that person rather than risk
  // writing over a reply — so a persistent one silently removes somebody from the campaign.
  const unknown = [];
  for (const event of activeCampaignEvents()) {
    let r;
    try {
      r = await syncReplies({ gmail: g.gmail, event, fromMailbox: mailbox, query, execute: true });
    } catch (e) {
      // One event's failure must not silently cancel the others' sync — collect and raise at the end.
      failures.push(`${event}: ${e && e.message ? e.message : e}`);
      continue;
    }
    // Quiet unless something changed: this fires 168 times a week.
    if (r.marked) {
      console.log(`[CRON] reply sync ${event} — ${r.marked} newly replied of ${r.checked} active`);
      for (const x of r.replied) console.log(`[CRON]   ↩ ${x.name} — ${x.company} (${x.campaign})`);
    }
    for (const u of r.unknown || []) unknown.push({ ...u, event });
  }
  if (unknown.length) {
    console.warn(`[CRON] reply sync — ${unknown.length} thread(s) unreadable: `
      + unknown.map((x) => `${x.company} (${x.event}: ${x.why})`).join('; '));
  }
  if (failures.length) throw new Error(`reply sync failed for ${failures.join(' · ')}`);
}), CST);

// ── THE LEAD-FINDING AGENT · Mondays 06:20 CST ───────────────────────────────
//
// The outreach agent works the contacts that exist. Something has to find new ones, or the
// campaign empties itself in three weeks and the daily report quietly reports "0 due" forever —
// which looks exactly like a healthy, finished run.
//
// This runs scripts/ingest-research-labs.js, THE SAME SCRIPT a human runs, as a child process
// rather than as an imported function. That is deliberate. Extracting 424 lines into a library
// would create a second path through the same logic, and every defect this campaign has produced
// came from two copies of one rule drifting apart. Spawning the script means there is exactly one
// implementation and the cron exercises it.
//
// Monday before the week's sends, so a grant awarded last week is in the table by Tuesday.
//
// NOT GATED BY A FLAG. It only reads public registries and fills our own tables; nothing it
// writes can send an email, because that needs OUTREACH_ENABLED. One more flag is one more thing
// to set and forget, and the cost of forgetting this one would be a campaign that silently runs
// dry. It is idempotent — labs that already have a contact are skipped — so a repeat run is free.
// ── THE DATA ACCURACY REPORT · Mondays 07:00 CST ─────────────────────────────
//
// Every diagnostic in this repo needs `railway ssh`, and on 26 and 27 October that gateway failed
// twice — once on key verification, once on a connection timeout. A measurement nobody can reach
// is not a measurement, and the accuracy of this data is about to stop being a conversation and
// become a warranty: the moment somebody pays for lead data, "how accurate is this?" has an
// answer with money behind it.
//
// So it arrives by email instead, after the ingest has run, measuring the data as it stands that
// week. Monday 07:00, forty minutes after the ingest at 06:20, which is comfortably longer than
// the ingest takes and before the 09:10 send.
//
// It spawns the same script a human runs, for the reason the ingest does: a second path through
// the same logic is how every defect this month got in.
cron.schedule('0 7 * * 1', withAlerts('weekly-mon-7cst-data-accuracy', async () => {
  const { execFile } = require('child_process');
  const path = require('path');
  const { sendEmail } = require('./src/lib/mailer');

  const out = await new Promise((resolve, reject) => {
    execFile('node', [path.join(__dirname, 'scripts', 'audit-data-accuracy.js')],
      { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${String(stderr || stdout).slice(-2000)}`));
        return resolve(String(stdout || ''));
      });
  });

  console.log('[CRON] data accuracy audit done');

  // Plain text in a <pre>, deliberately. This report's value is that every number sits beside the
  // method that produced it, and reformatting it into a tidy summary is how the caveats get lost
  // — which is the failure the report exists to prevent.
  const esc = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wrong = (out.match(/WRONG INSTITUTION\s+(\d+)/) || [])[1];
  const subject = Number(wrong) > 0
    ? `Data accuracy — ${wrong} address(es) on the WRONG INSTITUTION`
    : `Data accuracy — ${new Date().toISOString().slice(0, 10)}`;

  await sendEmail({
    to: process.env.OUTREACH_REPORT_TO || 'naren@abiozen.com',
    subject,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;color:#15202b">
<p style="margin:0 0 12px 0">Measured, not asserted. VERIFIED = checked against the source ·
UNVERIFIED = cannot be checked from here · WRONG = checked and disagrees.</p>
<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.5;white-space:pre-wrap;background:#f7f8fa;padding:14px;border-radius:6px">${esc}</pre>
</div>`,
  });

  // A row whose address belongs to a different institution would send a confident, personalised
  // letter to a stranger. withAlerts emails on a throw, so that becomes one.
  if (Number(wrong) > 0) {
    throw new Error(`${wrong} research address(es) belong to a different institution than the `
      + 'record says — they must not be emailed until corrected');
  }
}), CST);

cron.schedule('20 6 * * 1', withAlerts('weekly-mon-620cst-research-ingest', async () => {
  const { execFile } = require('child_process');
  const path = require('path');
  const script = path.join(__dirname, 'scripts', 'ingest-research-labs.js');
  const limit = process.env.RESEARCH_INGEST_LIMIT || '200';

  const out = await new Promise((resolve, reject) => {
    execFile('node', [script, `--limit=${limit}`, '--execute'],
      // Generous: it enriches each lab over two external APIs and prints a line per lab, so a
      // hundred-plus network round trips is normal. maxBuffer because that output is long.
      { timeout: 25 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${String(stderr || stdout).slice(-2000)}`));
        return resolve(String(stdout || ''));
      });
  });

  // The last lines carry the WROTE and TOTALS summary; the per-lab lines are noise in a log.
  const tail = out.trimEnd().split('\n').slice(-6).join('\n');
  console.log('[CRON] research ingest done\n' + tail);

  // A run that found nothing new is worth knowing about: it means either the registry has nothing
  // fresh for this topic, or something upstream changed shape. Both need a human eventually, and
  // neither announces itself.
  if (/\+0 lab\(s\), \+0 contact\(s\)/.test(out)) {
    console.warn('[CRON] research ingest added nothing new — worth checking the topic filter '
      + 'if this repeats for a third week');
  }
}), CST);

// ── THE OUTREACH AGENT · weekdays 09:10 CST ──────────────────────────────────
//
// Finds who is due, checks nobody has replied, sends, files, and emails Naren what it did.
//
// WHY 09:10 AND NOT 09:00. Six jobs already fire on the hour. A send that queues behind five
// other Claude calls drifts unpredictably, and these messages are spaced 45-95s apart over eight
// recipients — a start time that slides is a batch that lands at lunch.
//
// WHY WEEKDAYS. The recipients are university faculty and procurement staff. A cold email that
// arrives on Sunday is read on Monday with the weekend's backlog, which is the worst slot there
// is. Follow-ups stay due over the weekend and go out on the Monday.
//
// WHY THE BOUNCE SCAN RUNS FIRST, IN THE SAME JOB. The 5% gate in runOutreach reads
// outreach_bounces. For one batch that table had no writer, so the gate reported 0.0% and would
// have reported 0.0% if every address had failed. Scanning immediately before sending means the
// gate is reading something current rather than something stale — and a hard bounce found this
// morning stops that person's sequence before today's send, not after it.
//
// WHY A FLAG. OUTREACH_ENABLED must be set before anything sends. The same process-environment
// trap described below applies: this is read at fire time, not at boot, but the value comes from
// the environment this process captured at launch, so a variable added after deploy needs a
// redeploy to take effect.
cron.schedule('10 9 * * 1-5', withAlerts('weekday-910cst-outreach-agent', async () => {
  const { runOutreach, scanBounces } = require('./src/lib/agents/outreach-agent');
  const { sendOutreachReport } = require('./src/lib/agents/outreach-report');

  const enabled = String(process.env.OUTREACH_ENABLED || '').toLowerCase() === 'true';
  const max = Math.max(1, Math.min(50, parseInt(process.env.OUTREACH_MAX || '8', 10) || 8));
  const lines = [];
  const log = (s = '') => lines.push(s);

  // Read Gmail and record failures first, so the gate below is current.
  let bounce = null;
  try {
    bounce = await scanBounces({ execute: true, days: 14, log });
  } catch (e) {
    // A scan that cannot run is not a reason to send blind. Raising here means withAlerts emails,
    // and nothing goes out on an unmeasured list.
    throw new Error(`outreach bounce scan failed, so nothing was sent: ${e.message}`);
  }

  if (!enabled) {
    console.log('[CRON] outreach agent — OUTREACH_ENABLED is not true, nothing sent. '
      + `Bounce scan ran: ${bounce.found.length} failure(s) in ${bounce.sent} send(s).`);
    return;
  }

  const run = await runOutreach({ execute: true, max, log });

  // Noisy when it did something, quiet otherwise — this fires 5 times a week and a daily
  // "0 sent" in the log buries the run that mattered.
  if (run.sent || run.failed || run.repliedNow.length || run.unfiled.length || run.stopped) {
    console.log(`[CRON] outreach — ${run.sent} sent, ${run.failed} failed, `
      + `${run.repliedNow.length} replied, ${run.due} due of ${run.routed} routed`
      + `${run.stopped ? ` · HELD: ${run.stopped}` : ''}`);
    console.log(lines.join('\n'));
  }

  // The report goes out even on a quiet day only if something is worth saying; composeOutreachReport
  // decides. A daily "0 sent" for a fortnight trains the reader to ignore the one that matters.
  try {
    await sendOutreachReport({ run, bounce });
  } catch (e) {
    console.warn('[CRON] outreach report could not be emailed:', e.message);
  }

  // The two states that need a human become throws, because nobody is watching the logs: a send
  // that errored, and a claim row with no Gmail id — the "did that actually send?" case.
  const problems = [];
  if (run.failed) problems.push(`${run.failed} send(s) failed`);
  if (run.unconfirmed) {
    problems.push(`${run.unconfirmed} claimed send(s) have no Gmail message id; they may or may `
      + 'not have gone. SELECT * FROM outreach_sends WHERE confirmed = FALSE');
  }
  if (problems.length) throw new Error(problems.join(' · '));
}), CST);

// ── SAY, AT BOOT, WHAT THE CAMPAIGN WILL ACTUALLY DO ─────────────────────────
//
// On 12 Oct the release stalled on something invisible. The code was deployed, the Railway variable
// was set, and `railway ssh 'node -e "...process.env..."'` printed exactly the right values — so
// everything looked correct. It was not: that ssh command spawns a FRESH process, which reads the
// current service config, while the long-running server process captured process.env at launch and
// never sees a later change. The variable had been added seven minutes after this process started.
// The cron therefore had the new code and the old environment, and sent one message instead of
// fifty-three with no error anywhere.
//
// A running process cannot be interrogated from outside about its own environment. So it says so
// itself, once, at boot — where the deploy log puts it next to the commit that produced it.
(() => {
  const { windowOverrideActive } = require('./src/lib/campaigns/send-window');
  const until = process.env.CPHI_FOLLOWUP_IGNORE_WINDOW_UNTIL;
  const on = String(process.env.CPHI_FOLLOWUP_ENABLED).toLowerCase() === 'true';
  const override = windowOverrideActive(until);
  console.log(`[BOOT] CPHI follow-up: ${on ? 'ENABLED' : 'disabled'}`
    + ` · max ${parseInt(process.env.CPHI_FOLLOWUP_MAX || '3', 10)}/run`
    + ` · window ${override ? `OVERRIDDEN until ${until} (sends outside recipient-local hours)`
      : 'enforced (09:30–17:00 recipient-local)'}`
    + `${until && !override ? ` · CPHI_FOLLOWUP_IGNORE_WINDOW_UNTIL="${until}" is set but NOT active` : ''}`);
})();

// ── THE SAME, FOR THE OUTREACH AGENT ─────────────────────────────────────────
//
// Setting OUTREACH_ENABLED in Railway and redeploying LOOKS identical, from outside, to setting it
// and not redeploying — and the second one sends nothing, for ever, with a healthy-looking cron
// that reports "0 sent". That is the 12 Oct failure above, and it cost a whole send.
//
// There is no way to ask a running process what environment it captured, so it states it here,
// once, in the deploy log next to the commit. This line is the only place the answer exists.
(() => {
  const on = String(process.env.OUTREACH_ENABLED || '').toLowerCase() === 'true';
  const max = parseInt(process.env.OUTREACH_MAX || '8', 10) || 8;
  const from = process.env.OUTREACH_FROM || 'sales@abiozen.com';
  const replyTo = process.env.OUTREACH_REPLY_TO || 'naren@abiozen.com';
  const reportTo = process.env.OUTREACH_REPORT_TO || 'naren@abiozen.com';
  console.log(`[BOOT] outreach agent: ${on ? 'ENABLED' : 'DISABLED — nothing will send'}`
    + ` · weekdays 09:10 CST · max ${max}/run`
    + ` · from ${from} · replies to ${replyTo} · report to ${reportTo}`);
  if (!on) {
    console.log('[BOOT]   OUTREACH_ENABLED is not "true" IN THIS PROCESS. If you just set it in '
      + 'Railway, the variable only reaches a process started AFTER the change — redeploy, and '
      + 'this line will say ENABLED.');
  }
  // The research ingest is not flag-gated, so say when it runs rather than leaving somebody to
  // wonder whether it is wired at all.
  console.log(`[BOOT] research ingest: Mondays 06:20 CST · limit `
    + `${process.env.RESEARCH_INGEST_LIMIT || '200'} awards · always on (it sends nothing)`);
})();

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
