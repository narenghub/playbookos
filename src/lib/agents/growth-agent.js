const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { getAppId, getSearchKey, getAnalyticsKey } = require('../algolia-keys');
const { sendEmail } = require('../mailer');
const { getCEOUser } = require('../agent-core');
const { sendCronAlert } = require('../cron-alerts');

const DAY_MS = 86400000;
const isoDate = d => d.toISOString().slice(0, 10);

function algoliaHeaders(appId, apiKey) {
  return {
    'X-Algolia-Application-Id': appId,
    'X-Algolia-API-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

async function syncAlgoliaSearchData({ days = 7 } = {}) {
  const appId = getAppId();
  // Search-term endpoints (/2/searches*) use the search key; the click and
  // conversion endpoints use the analytics key. Note: every analytics.algolia.com
  // /2 endpoint — including /searches — requires the `analytics` ACL, so a key
  // supplied as ALGOLIA_SEARCH_KEY still needs that ACL (or leave it unset to
  // fall back to ALGOLIA_API_KEY).
  const searchKey = getSearchKey();
  const analyticsKey = getAnalyticsKey();
  // Unified catalog index — defaults to abiozen_products if the env var is unset.
  const indexName = process.env.ALGOLIA_INDEX_NAME || 'abiozen_products';
  if (!appId || (!searchKey && !analyticsKey)) {
    return { skipped: true, reason: 'Algolia env vars not set (ALGOLIA_APP_ID and ALGOLIA_SEARCH_KEY / ALGOLIA_ANALYTICS_KEY / ALGOLIA_API_KEY)' };
  }

  const endDate = isoDate(new Date());
  const startDate = isoDate(new Date(Date.now() - days * DAY_MS));
  const dateQuery = `startDate=${startDate}&endDate=${endDate}`;
  const base = 'https://analytics.algolia.com/2';
  const searchHeaders = algoliaHeaders(appId, searchKey);
  const analyticsHeaders = algoliaHeaders(appId, analyticsKey);

  async function safeFetch(path, headers, fallback) {
    try {
      const res = await fetch(`${base}${path}`, { headers });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { _error: `Algolia ${res.status} on ${path}: ${body.slice(0, 200)}`, ...fallback };
      }
      return res.json();
    } catch (e) {
      return { _error: e.message, ...fallback };
    }
  }

  const idx = encodeURIComponent(indexName);
  const [noResultsRaw, topQueriesRaw, conversionRaw, clickRaw] = await Promise.all([
    safeFetch(`/searches/noResults?index=${idx}&limit=20&${dateQuery}`, searchHeaders, { searches: [] }),
    safeFetch(`/searches?index=${idx}&limit=20&${dateQuery}`, searchHeaders, { searches: [] }),
    safeFetch(`/conversions/conversionRate?index=${idx}&${dateQuery}`, analyticsHeaders, {}),
    safeFetch(`/clicks/clickThroughRate?index=${idx}&${dateQuery}`, analyticsHeaders, {}),
  ]);

  return {
    period: { start: startDate, end: endDate, days },
    no_result: (noResultsRaw.searches || []).map(s => ({ query: s.search, count: s.count, nb_hits: s.nbHits || 0 })),
    top_queries: (topQueriesRaw.searches || []).map(s => ({ query: s.search, count: s.count, nb_hits: s.nbHits })),
    conversion_rate: conversionRaw.rate ?? null,
    tracked_searches: conversionRaw.trackedSearchCount ?? null,
    click_through_rate: clickRaw.rate ?? null,
    errors: [noResultsRaw, topQueriesRaw, conversionRaw, clickRaw].map(r => r._error).filter(Boolean),
  };
}

// Exchange the long-lived OAuth refresh token for a short-lived access token.
// The refresh token is minted once via a browser consent flow (see
// .env.example) using a Google account that already has access to the
// abiozen.com Search Console property, and does not expire under normal use.
async function getGSCAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    return { error: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN must all be set' };
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `OAuth token endpoint ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    if (!data.access_token) return { error: 'OAuth token response had no access_token' };
    return { access_token: data.access_token };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchGSCData({ siteUrl, days = 30 } = {}) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    return { skipped: true, reason: 'GOOGLE_REFRESH_TOKEN not set' };
  }

  const token = await getGSCAccessToken();
  if (token.error) {
    return { skipped: true, reason: `GSC OAuth failed: ${token.error}` };
  }

  const target = siteUrl || process.env.GSC_SITE_URL || 'sc-domain:abiozen.com';
  // The searchAnalytics API requires ISO YYYY-MM-DD dates — it does not accept
  // relative strings like "30 days ago" — so the trailing 30-day window is
  // computed here.
  const endDate = isoDate(new Date());
  const startDate = isoDate(new Date(Date.now() - days * DAY_MS));

  try {
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(target)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate, dimensions: ['query', 'page'], rowLimit: 50 }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { skipped: true, reason: `GSC API ${res.status}: ${body.slice(0, 200)}`, site: target };
    }
    const data = await res.json();
    return {
      site: target,
      period: { start: startDate, end: endDate, days },
      rows: (data.rows || []).map(r => ({
        query: r.keys?.[0] || '',
        page: r.keys?.[1] || '',
        clicks: r.clicks || 0,
        impressions: r.impressions || 0,
        ctr: r.ctr || 0,
        position: r.position || 0,
      })),
    };
  } catch (e) {
    return { skipped: true, reason: e.message };
  }
}

async function generateSEORecommendations({ dryRun = false } = {}) {
  const algolia = await syncAlgoliaSearchData();
  const gsc = await fetchGSCData();

  const skus = (await query(`SELECT name, category FROM skus WHERE is_active=1`)).rows;
  const haveNames = skus.map(s => s.name.toLowerCase());

  // Aggregate candidates from both signals, keyed by query string
  const candidates = new Map();
  function bump(query, fields) {
    const key = (query || '').toLowerCase().trim();
    if (!key) return;
    const existing = candidates.get(key) || { query: query.trim(), algolia_no_result_count: 0, algolia_top_query_count: 0, gsc_impressions: 0, gsc_clicks: 0, gsc_ctr: 0, gsc_position: 0 };
    Object.assign(existing, { ...existing, ...fields });
    candidates.set(key, existing);
  }

  if (!algolia.skipped) {
    for (const q of algolia.no_result || []) bump(q.query, { algolia_no_result_count: q.count });
    for (const q of algolia.top_queries || []) {
      if (q.nb_hits === 0) bump(q.query, { algolia_no_result_count: (candidates.get(q.query.toLowerCase().trim())?.algolia_no_result_count || 0) + (q.count || 0) });
      else bump(q.query, { algolia_top_query_count: q.count });
    }
  }
  if (!gsc.skipped) {
    for (const r of gsc.rows || []) {
      bump(r.query, { gsc_impressions: r.impressions, gsc_clicks: r.clicks, gsc_ctr: r.ctr, gsc_position: r.position });
    }
  }

  // Filter out queries that already match a SKU we sell
  const alreadyHave = q => haveNames.some(n => n.includes(q.toLowerCase()) || q.toLowerCase().includes(n));

  const candidateList = Array.from(candidates.values())
    .filter(c => !alreadyHave(c.query))
    .map(c => ({
      ...c,
      composite_score: (c.algolia_no_result_count || 0) * 10 + (c.gsc_impressions || 0),
    }))
    .sort((a, b) => b.composite_score - a.composite_score)
    .slice(0, 30);

  let claudeText = '[dry-run] Claude SEO recommendations skipped';
  let topMolecules = [];

  // Run Claude on every real (non-dry) invocation — including when no demand
  // candidates were captured — so a manual POST /api/growth/analyze always
  // returns a real Claude response rather than the dry-run placeholder.
  if (!dryRun) {
    const sample = candidateList.length
      ? candidateList.map((c, i) =>
          `${i + 1}. "${c.query}" — Algolia no-result count: ${c.algolia_no_result_count || 0}, GSC impressions: ${c.gsc_impressions || 0}, GSC clicks: ${c.gsc_clicks || 0}, position: ${(c.gsc_position || 0).toFixed(1)}`
        ).join('\n')
      : '(No internal-search or Google Search Console demand signals were captured for this period.)';
    const catalog = skus.slice(0, 30).map(s => s.name).join(', ');

    const prompt = `You are the Growth Intelligence agent for Abiozen LLC, a US-based pharmaceutical API distribution company targeting $10M revenue by Dec 31, 2026.

The data below combines two demand signals from outside the catalog:
- Algolia internal-search queries that returned zero or few results (these are buyers ON the marketplace who searched and could not find something)
- Google Search Console queries showing impressions on abiozen.com (people searching Google, our site appearing, but not necessarily converting)

DEMAND-SIGNAL CANDIDATES (top 30 by composite score):
${sample}

CURRENT CATALOG SAMPLE: ${catalog}

Identify the TOP 10 pharmaceutical molecules buyers are searching for but cannot find at Abiozen. Filter strictly:
- Only real pharmaceutical molecules, APIs, or research peptides (e.g. Semaglutide, Tirzepatide, BPC-157, generic API names).
- Exclude generic words, navigational queries ("contact", "pricing"), brand names that we already sell, vendor names, and noise.
- A query with high Algolia no-result count is a stronger signal than equal GSC impressions, because it represents on-site buyer intent that we lost.

Return EXACTLY a JSON array (no other text), maximum 10 items:
[{"molecule":"Compound name","demand_signal":"high|medium|low","search_count":N,"rationale":"1 short sentence"}]

If fewer than 10 real molecules can be identified in the candidates, return fewer items. Do not invent molecules.`;
    claudeText = await runClaudeAnalysis(prompt);
    try {
      const match = claudeText.match(/\[[\s\S]*\]/);
      if (match) topMolecules = JSON.parse(match[0]);
    } catch (e) {
      // Leave topMolecules empty; raw claudeText is preserved
    }
  }

  const result = {
    generated_at: new Date().toISOString(),
    algolia,
    gsc,
    candidates: candidateList,
    top_molecules: topMolecules,
    raw_recommendations: claudeText,
  };

  if (!dryRun) {
    await query(
      `INSERT INTO ai_analyses (id, analysis_type, period_key, content) VALUES ($1, 'growth_intelligence', $2, $3)`,
      [crypto.randomUUID(), isoDate(new Date()).slice(0, 7), JSON.stringify(result)]
    );
  }

  return result;
}

// ── Weekly Market Intelligence engine ────────────────────────────────────────
// Generates 150 molecules/week — 100 non-GMP research chemicals + 50 GMP generic
// APIs — deduped against molecule_history (best-effort, name+CAS) so nothing
// repeats, cross-checked against the catalog, stored, with sourcing tasks queued
// for Palash and a summary emailed to the CEO. CAS numbers are AI-generated and
// must be verified by Palash before sourcing.
const MI_MODEL = 'claude-opus-4-7';

// Monday (UTC) of the given date's week, as YYYY-MM-DD.
function mondayOf(date = new Date()) {
  const d = new Date(date);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow);
  return isoDate(d);
}

// One Claude call that must return a JSON array — same raw-fetch shape as the
// rest of the codebase (no SDK). Non-streaming with bounded max_tokens; callers
// keep each batch small (<=~26 items) so the response stays well under the
// timeout/size envelope. Returns { items, error } and never throws.
async function callClaudeJsonArray(prompt, { maxTokens = 8000 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { items: [], error: 'ANTHROPIC_API_KEY not configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MI_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { items: [], error: `Claude ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return { items: [], error: 'no JSON array in Claude response' };
    return { items: JSON.parse(match[0]) };
  } catch (e) {
    return { items: [], error: e.message };
  }
}

const miNorm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const miNormCas = s => String(s || '').replace(/[^0-9-]/g, '').trim();
function molKey(m) {
  const cas = miNormCas(m.cas_number);
  return cas ? `cas:${cas}` : `name:${miNorm(m.molecule_name || m.name)}`;
}
function parseMoney(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 100 research chemicals = 5 batches of 20, each nudged toward a category pair so
// the 10 target categories are covered without one oversized call.
const RESEARCH_BATCHES = [
  'heterocyclic intermediates, peptide building blocks',
  'chiral auxiliaries, cross-coupling reagents',
  'fluorinated compounds, protecting group reagents',
  'catalysts, specialty solvents',
  'isotope-labeled compounds, natural product derivatives',
];
// 50 GMP APIs split into 2 batches, preserving the spec's per-area proportions.
const GMP_BATCHES = [
  { n: 24, areas: 'GLP-1/Obesity/Diabetes (10 — highest demand), Oncology/Cancer (8), Cardiovascular/Hypertension (6)' },
  { n: 26, areas: 'CNS/Neurological/Psychiatry (6), Hormones/HRT/Endocrinology (5), Antibiotics/Anti-infectives (5), Pain Management (4), Respiratory (3), Dermatology (3)' },
];

function researchPrompt(count, categories, demandSignals, excludeList) {
  return `You are a pharmaceutical market intelligence expert. Generate exactly ${count} unique research chemicals in high demand in the US biotech/pharma market this week. These must be non-GMP research-grade chemicals used in drug discovery, synthesis, and laboratory research.

Emphasize these categories this batch: ${categories}.

Internal demand signals (Abiozen on-site searches + Google + prior analyses) for context:
${demandSignals || '(no strong internal signals this week — use your market knowledge)'}

Requirements:
- Each must have a real CAS number (best effort — CAS numbers will be verified before sourcing).
- Each must be commercially sourceable from APAC/China/India suppliers.
- Do NOT include any molecule in this already-assigned list: ${excludeList || '(none)'}
- Return ONLY a JSON array, exactly ${count} items, no duplicates, no prose:
[{"name":"","cas_number":"","category":"","typical_purity":"","typical_price_per_kg":"","primary_use_case":"","target_buyer_segment":"","demand_driver":"","apac_supplier_availability":"high|medium|low"}]`;
}

function gmpPrompt(count, areas, demandSignals, excludeList) {
  return `You are a pharmaceutical API market intelligence expert. Generate exactly ${count} unique generic pharmaceutical APIs (GMP grade) in high demand in the US market this week.

Cover these therapeutic areas with the indicated counts: ${areas}.

Internal demand signals for context:
${demandSignals || '(no strong internal signals this week — use your market knowledge)'}

Requirements:
- Each must be a real generic API with expired or expiring patents.
- Each must have a real CAS number (best effort — verified before sourcing).
- Each must be manufacturable by qualified APAC CDMOs.
- Do NOT include any molecule in this already-assigned list: ${excludeList || '(none)'}
- Return ONLY a JSON array, exactly ${count} items, no duplicates, no prose:
[{"name":"","cas_number":"","therapeutic_area":"","gmp_grade":"","typical_purity":"","usp_ep_compliant":"","typical_price_per_kg":"","market_size_usd_millions":"","patent_status":"","primary_manufacturers_region":"","demand_driver":"","compounding_eligible":"yes|no"}]`;
}

async function runMarketIntelligence({ dryRun = false, weekStart } = {}) {
  const week = weekStart || mondayOf();
  const errors = [];

  // 1. Demand signals — GSC + Algolia + recent analyses (each independently skippable)
  const algolia = await syncAlgoliaSearchData().catch(e => ({ skipped: true, reason: e.message }));
  const gsc = await fetchGSCData().catch(e => ({ skipped: true, reason: e.message }));
  const signalLines = [];
  if (algolia && !algolia.skipped) {
    for (const q of (algolia.no_result || []).slice(0, 15)) signalLines.push(`on-site no-result: "${q.query}" (${q.count}x)`);
    for (const q of (algolia.top_queries || []).slice(0, 10)) signalLines.push(`on-site top search: "${q.query}" (${q.count}x)`);
  }
  if (gsc && !gsc.skipped) {
    for (const r of (gsc.rows || []).slice(0, 25)) if ((r.impressions || 0) > 0) signalLines.push(`Google: "${r.query}" (${r.impressions} impr)`);
  }
  const demandSignals = signalLines.slice(0, 40).join('\n');

  // 2. Rolling 12-week exclusion list (names only, capped to bound prompt size)
  const twelveWeeksAgo = isoDate(new Date(Date.now() - 12 * 7 * DAY_MS));
  const recentRows = (await query(
    `SELECT molecule_name FROM molecule_history WHERE week_start >= $1 ORDER BY created_at DESC LIMIT 1500`,
    [twelveWeeksAgo]
  )).rows;
  const excludeList = recentRows.map(r => r.molecule_name).join(', ').slice(0, 12000);

  // 3. Rolling 12-week dedup set (name + CAS) — matches the exclusion window above.
  //    Bounding to 12 weeks (rather than all history) lets molecules resurface once
  //    they age out, so the weekly list keeps repopulating toward the 150 target
  //    instead of starving as the catalog grows.
  const seen = new Set();
  for (const r of (await query(`SELECT molecule_name, cas_number FROM molecule_history WHERE week_start >= $1`, [twelveWeeksAgo])).rows) {
    seen.add(molKey({ molecule_name: r.molecule_name, cas_number: r.cas_number }));
  }

  // 4. Generate research chemicals (100 = 5 x 20), deduping as we go
  const research = [];
  for (const cats of RESEARCH_BATCHES) {
    const { items, error } = await callClaudeJsonArray(researchPrompt(20, cats, demandSignals, excludeList), { maxTokens: 8000 });
    if (error) errors.push(`research(${cats}): ${error}`);
    for (const m of (items || [])) {
      const k = molKey(m);
      if (!m.name || seen.has(k)) continue;
      seen.add(k);
      research.push(m);
    }
  }

  // 5. Generate GMP APIs (50 = 24 + 26)
  const gmp = [];
  for (const b of GMP_BATCHES) {
    const { items, error } = await callClaudeJsonArray(gmpPrompt(b.n, b.areas, demandSignals, excludeList), { maxTokens: 9000 });
    if (error) errors.push(`gmp(${b.areas.slice(0, 28)}…): ${error}`);
    for (const m of (items || [])) {
      const k = molKey(m);
      if (!m.name || seen.has(k)) continue;
      seen.add(k);
      gmp.push(m);
    }
  }

  // 6. Catalog cross-check
  const skuNames = (await query(`SELECT name FROM skus WHERE is_active=1`)).rows.map(s => miNorm(s.name)).filter(Boolean);
  const inCatalog = name => {
    const n = miNorm(name);
    return n && skuNames.some(s => s.includes(n) || n.includes(s)) ? 1 : 0;
  };

  // 7. Assemble rows (rank = generation order within each group; Claude returns
  //    roughly demand-ordered, good enough for a v1 priority proxy)
  const rows = [];
  research.forEach((m, i) => rows.push({
    gmp_status: 'non_gmp', rank: i + 1, molecule_name: m.name, cas_number: m.cas_number || null,
    category: m.category || null, therapeutic_area: null,
    estimated_value: (parseMoney(m.typical_price_per_kg) || 0) * 25, // 25kg MOQ proxy
    in_catalog: inCatalog(m.name), details: m,
  }));
  gmp.forEach((m, i) => rows.push({
    gmp_status: 'gmp', rank: i + 1, molecule_name: m.name, cas_number: m.cas_number || null,
    category: null, therapeutic_area: m.therapeutic_area || null,
    estimated_value: parseMoney(m.market_size_usd_millions), // $M market size
    in_catalog: inCatalog(m.name), details: m,
  }));

  const summary = {
    generated_at: new Date().toISOString(), week_start: week, model: MI_MODEL,
    research_count: research.length, gmp_count: gmp.length, total: rows.length,
    in_catalog: rows.filter(r => r.in_catalog).length,
    new_opportunities: rows.filter(r => !r.in_catalog).length,
    errors,
  };

  if (dryRun) {
    return { ...summary, dryRun: true, sampleResearch: research.slice(0, 3), sampleGmp: gmp.slice(0, 3) };
  }

  // 8. Store all molecules
  for (const r of rows) {
    await query(
      `INSERT INTO molecule_history
         (id, molecule_name, cas_number, category, gmp_status, therapeutic_area, week_start,
          sourcing_status, in_catalog, rank, estimated_value, details_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11)`,
      [crypto.randomUUID(), r.molecule_name, r.cas_number, r.category, r.gmp_status, r.therapeutic_area, week,
       r.in_catalog, r.rank, r.estimated_value, JSON.stringify(r.details)]
    );
  }

  // 9. Procurement tasks — top 20 research + top 10 GMP → approval_queue for Palash.
  const palash = (await query(
    `SELECT id FROM users WHERE is_active=1 AND (LOWER(name) LIKE '%palash%' OR role='procurement')
     ORDER BY (LOWER(name) LIKE '%palash%') DESC LIMIT 1`
  )).rows[0];
  const palashId = palash ? palash.id : null;

  // Dedup guard: collect molecules that already have a market-intelligence task
  // queued for THIS week (from any prior/overlapping run in the last 14 days), so
  // re-runs don't re-queue the same molecule. We add to this set as we insert, so
  // it also dedups within this run.
  const queuedThisWeek = new Set();
  for (const r of (await query(
    `SELECT action_payload FROM approval_queue
     WHERE agent_name='market-intelligence' AND created_at::timestamptz >= NOW() - INTERVAL '14 days'`
  )).rows) {
    try { const p = JSON.parse(r.action_payload); if (p && p.week_start === week && p.molecule) queuedThisWeek.add(miNorm(p.molecule)); } catch (e) { /* ignore */ }
  }

  let tasksQueued = 0, tasksSkipped = 0;
  const queueTask = async (r, actionType, priority, task) => {
    const key = miNorm(r.molecule_name);
    if (queuedThisWeek.has(key)) { tasksSkipped++; return; } // already queued this week — skip
    queuedThisWeek.add(key);
    await query(
      `INSERT INTO approval_queue (id, agent_name, action_type, action_payload, requested_for_user_id, status, priority)
       VALUES ($1,'market-intelligence',$2,$3,$4,'pending',$5)`,
      [crypto.randomUUID(), actionType, JSON.stringify({ task, molecule: r.molecule_name, cas: r.cas_number, gmp_status: r.gmp_status, week_start: week }), palashId, priority]
    );
    tasksQueued++;
  };

  for (const r of rows.filter(x => x.gmp_status === 'non_gmp').slice(0, 20)) {
    const d = r.details || {};
    const task = `Source ${r.molecule_name} (CAS: ${r.cas_number || 'VERIFY'}) — ${r.category || 'research chemical'} — Target: 25kg MOQ, 99%+ purity, COA required. APAC supplier availability: ${d.apac_supplier_availability || 'unknown'}. Estimated value: $${Math.round(r.estimated_value || 0).toLocaleString()}. Verify CAS before sourcing.`;
    await queueTask(r, 'source_molecule', 'MEDIUM', task);
  }
  for (const r of rows.filter(x => x.gmp_status === 'gmp').slice(0, 10)) {
    const task = `Source GMP API: ${r.molecule_name} (CAS: ${r.cas_number || 'VERIFY'}) — ${r.therapeutic_area || 'API'} — DMF/CEP required. Target: 1kg sample + bulk quote. Estimated market value: $${r.estimated_value ?? '?'}M. Verify CAS before sourcing.`;
    await queueTask(r, 'source_gmp_api', 'HIGH', task);
  }
  summary.tasks_queued = tasksQueued;
  summary.tasks_skipped_duplicate = tasksSkipped;

  // 10. Snapshot summary for quick reads / weeks-tracked count
  await query(
    `INSERT INTO ai_analyses (id, analysis_type, period_key, content) VALUES ($1, 'market_intelligence', $2, $3)`,
    [crypto.randomUUID(), week, JSON.stringify(summary)]
  );

  // 11. Email the CEO
  try {
    const ceo = await getCEOUser();
    const to = ceo?.email || process.env.CEO_EMAIL;
    if (to) {
      const topR = research.slice(0, 5)
        .map((m, i) => `<li>${i + 1}. <b>${m.name}</b> (${m.cas_number || 'CAS?'}) — ${m.category || ''}${m.demand_driver ? ' · ' + m.demand_driver : ''}</li>`).join('');
      const topG = [...gmp]
        .sort((a, b) => (parseMoney(b.market_size_usd_millions) || 0) - (parseMoney(a.market_size_usd_millions) || 0))
        .slice(0, 5)
        .map((m, i) => `<li>${i + 1}. <b>${m.name}</b> (${m.therapeutic_area || ''}) — $${m.market_size_usd_millions || '?'}M market</li>`).join('');
      const base = process.env.BASE_URL || 'https://playbook.abiozen.com';
      await sendEmail({
        to,
        subject: `Market Intelligence — Week of ${week} — ${rows.length} Molecules Identified`,
        html: `<div style="font-family:Arial;max-width:640px;line-height:1.6;color:#333">
  <h2 style="color:#1B3A6B;margin:0 0 4px">Market Intelligence — Week of ${week}</h2>
  <p>${research.length} research chemicals (non-GMP) + ${gmp.length} GMP APIs identified.</p>
  <p><b>${summary.in_catalog}</b> already in catalog · <b>${summary.new_opportunities}</b> new opportunities · <b>${tasksQueued}</b> sourcing tasks queued for Palash's review.</p>
  <h3 style="color:#0D7377;margin:16px 0 4px">Top 5 research chemicals</h3><ul>${topR || '<li>none</li>'}</ul>
  <h3 style="color:#0D7377;margin:16px 0 4px">Top 5 GMP APIs by market size</h3><ul>${topG || '<li>none</li>'}</ul>
  <p style="font-size:12px;color:#a00">⚠ CAS numbers are AI-generated and must be verified by Palash before sourcing.</p>
  <p><a href="${base}/#market-intelligence">Open Market Intelligence →</a></p>
</div>`,
      });
    }
  } catch (e) {
    errors.push(`email: ${e.message}`);
  }

  // 12. Shortfall alarm — a completed run that produced far fewer than the 150 target
  //     usually means dedup starvation or generation trouble. Claude errors are
  //     collected (not thrown), so without this the weekly list can quietly shrink
  //     with no alert. Turn under-production into a visible page.
  const SHORTFALL_FLOOR = 120;
  if (rows.length < SHORTFALL_FLOOR) {
    try {
      await sendCronAlert('market-intelligence', new Error(
        `under-produced: ${rows.length} of 150 molecules this week (${research.length} research + ${gmp.length} GMP) for week ${week}`
      ));
    } catch (e) {
      errors.push(`shortfall-alert: ${e.message}`);
    }
  }

  return summary;
}

module.exports = { syncAlgoliaSearchData, fetchGSCData, generateSEORecommendations, runMarketIntelligence };
