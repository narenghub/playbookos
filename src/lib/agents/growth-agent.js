const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { getAppId, getSearchKey, getAnalyticsKey } = require('../algolia-keys');

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

module.exports = { syncAlgoliaSearchData, fetchGSCData, generateSEORecommendations };
