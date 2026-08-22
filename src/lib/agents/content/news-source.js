// Content pipeline — NewsAPI source adapter (PURE: no DB, no LLM), mirroring the
// clinicaltrials.js fetch/parse split. NewsAPI is used (not RSS) so no XML parser dependency
// is needed — research-agent.js:215 already proves the pattern.
//
//   fetchItems(query, since) -> { items:[raw], error? }   — never throws
//   parseItem(raw)           -> { source_ref, title, url, published_at, summary }
//
// source_ref is the article URL — stable per item — so the orchestrator can dedup via
// ON CONFLICT (product, source_ref).

const NEWSAPI_URL = 'https://newsapi.org/v2/everything';
const USER_AGENT = 'PlaybookOS-Content/1.0 (+https://playbook.abiozen.com)';

// Fetch recent articles for a query. `since` is an optional ISO date (YYYY-MM-DD or full
// ISO) → NewsAPI `from`. The key travels in the X-Api-Key HEADER, never the URL/query string.
async function fetchItems(query, since, { apiKey = process.env.NEWSAPI_KEY, pageSize = 20 } = {}) {
  if (!apiKey) return { items: [], error: 'NEWSAPI_KEY not configured' };
  const params = new URLSearchParams({
    q: String(query || ''),
    language: 'en',
    sortBy: 'publishedAt',
    pageSize: String(Math.min(100, Math.max(1, pageSize))),
  });
  if (since) params.set('from', String(since));

  let res;
  try {
    res = await fetch(`${NEWSAPI_URL}?${params.toString()}`, {
      headers: { 'X-Api-Key': apiKey, 'User-Agent': USER_AGENT },
    });
  } catch (e) {
    return { items: [], error: 'NewsAPI request failed: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { items: [], error: `NewsAPI ${res.status}: ${String(t).slice(0, 200)}` };
  }
  let body;
  try { body = await res.json(); }
  catch (e) { return { items: [], error: 'NewsAPI response not JSON: ' + (e && e.message ? e.message : String(e)) }; }

  return { items: Array.isArray(body.articles) ? body.articles : [] };
}

// Flatten one NewsAPI article to the normalized shape. Pure; never throws.
function parseItem(raw) {
  const url = raw && raw.url ? String(raw.url).trim() : null;
  return {
    source_ref: url,                                          // stable dedup key
    title: String((raw && raw.title) || '').trim(),
    url,
    published_at: (raw && raw.publishedAt) ? String(raw.publishedAt) : null,
    summary: (String((raw && (raw.description || raw.content)) || '').trim()) || null,
  };
}

module.exports = { fetchItems, parseItem, NEWSAPI_URL };
