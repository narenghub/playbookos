const crypto = require('crypto');
const { Pool } = require('pg');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');
const { fetchGSCData, syncAlgoliaSearchData } = require('./growth-agent');
const { getAppId, getSearchKey, getAnalyticsKey } = require('../algolia-keys');
const { logAgentActivity } = require('../agent-core');

// CAS numbers that have generated SEO content but NO matching product in the
// abiozen catalog — never pushed (they'd match nothing anyway). Semaglutide and
// Retatrutide, per the pre-push match analysis (113/115 matched on CAS).
const SEO_PUSH_EXCLUDE_CAS = new Set(['910463-68-5', '2381089-83-2']);

const isoDate = d => d.toISOString().slice(0, 10);

// Persists weekly GSC snapshots. Each Monday cron run adds (or updates) one row
// per query keyed on (query, recorded_date), so the table accumulates a weekly
// time series. The recorded_date is the day the snapshot was taken — the GSC
// data inside each row aggregates the trailing 7 days as returned by fetchGSCData.
async function trackKeywordRankings({ dryRun = false } = {}) {
  const gsc = await fetchGSCData();
  if (gsc.skipped) return { skipped: true, reason: gsc.reason, tracked: 0 };

  const top50 = (gsc.rows || []).slice(0, 50);
  if (top50.length === 0) return { skipped: true, reason: 'GSC returned 0 rows for the trailing window', tracked: 0 };

  const today = isoDate(new Date());
  let inserted = 0;

  if (!dryRun) {
    for (const r of top50) {
      try {
        await query(
          `INSERT INTO seo_rankings (id, query, page, impressions, clicks, position, ctr, recorded_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (query, recorded_date) DO UPDATE
             SET impressions = EXCLUDED.impressions,
                 clicks = EXCLUDED.clicks,
                 position = EXCLUDED.position,
                 ctr = EXCLUDED.ctr`,
          [crypto.randomUUID(), r.query, null, r.impressions || 0, r.clicks || 0, r.position || 0, r.ctr || 0, today]
        );
        inserted++;
      } catch (e) {
        // single-row failure shouldn't kill the whole sync
        console.error('[seo-agent] row insert failed for query=' + r.query + ':', e.message);
      }
    }
  }

  return { tracked: top50.length, persisted: inserted, period: gsc.period, recorded_date: today, dryRun };
}

// "Content gap": queries Abiozen already shows up for in Google, but rank too
// low and convert too little. These represent traffic we could capture by
// improving the existing page rather than building a new one.
async function identifyContentGaps() {
  const gsc = await fetchGSCData();
  if (gsc.skipped) return { skipped: true, reason: gsc.reason, gaps: [] };

  const gaps = (gsc.rows || [])
    .filter(r => (r.impressions || 0) >= 100 && (r.position || 0) > 10 && (r.ctr || 0) < 0.02)
    .map(r => ({
      query: r.query,
      impressions: r.impressions || 0,
      clicks: r.clicks || 0,
      position: parseFloat((r.position || 0).toFixed(1)),
      ctr_pct: parseFloat(((r.ctr || 0) * 100).toFixed(2)),
      // Opportunity score = traffic potential / current rank penalty
      opportunity_score: Math.round((r.impressions || 0) / Math.max(1, r.position || 1)),
    }))
    .sort((a, b) => b.opportunity_score - a.opportunity_score)
    .slice(0, 10);

  return { count: gaps.length, period: gsc.period, gaps };
}

function renderSEOTasksEmail(tasks) {
  const priorityColor = p => p === 'high' ? '#E24B4A' : p === 'medium' ? '#EF9F27' : '#666';
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">
  <div style="background:#854d0e;padding:20px;border-radius:8px 8px 0 0;color:#fff">
    <h2 style="margin:0;font-size:20px">This week — ${tasks.length} SEO content tasks</h2>
    <p style="margin:6px 0 0;color:#fde047;font-size:13px">Ranked by impression × position-penalty opportunity score</p>
  </div>
  <div style="border:1px solid #e0e0e0;border-top:none;padding:20px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#1B3A6B;color:#fff">
        <th style="padding:8px;text-align:left">#</th>
        <th style="padding:8px;text-align:left">Task</th>
        <th style="padding:8px;text-align:left">Page type</th>
        <th style="padding:8px;text-align:left">Priority</th>
      </tr>
      ${tasks.map((t, i) => `<tr style="background:${i % 2 ? '#fff' : '#f8fafc'}">
        <td style="padding:6px 8px;font-weight:700;color:#1B3A6B">${i + 1}</td>
        <td style="padding:6px 8px">${(t.task || '').replace(/[<>]/g, '')}</td>
        <td style="padding:6px 8px;color:#666;font-size:12px">${(t.page_type || '').replace(/[<>]/g, '')}</td>
        <td style="padding:6px 8px;font-weight:700;color:${priorityColor(t.priority)};text-transform:capitalize">${(t.priority || 'medium').replace(/[<>]/g, '')}</td>
      </tr>`).join('')}
    </table>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
    <p style="font-size:11px;color:#888;margin:0">View SEO Intelligence dashboard: ${process.env.BASE_URL || 'http://localhost:3000'}</p>
  </div>
</div>`;
}

async function generateSEOTasksForTeam({ dryRun = false } = {}) {
  const gapsResult = await identifyContentGaps();
  if (gapsResult.skipped) return { skipped: true, reason: gapsResult.reason, tasks: [] };
  if (gapsResult.gaps.length === 0) return { skipped: true, reason: 'no content gaps in current GSC window', tasks: [] };

  const skus = (await query(`SELECT name, category FROM skus WHERE is_active=1`)).rows;
  const skuNames = skus.map(s => s.name);

  const gapsText = gapsResult.gaps
    .map((g, i) => `${i + 1}. "${g.query}" — ${g.impressions} impressions, position ${g.position}, CTR ${g.ctr_pct}% (opportunity ${g.opportunity_score})`)
    .join('\n');
  const catalogText = skuNames.slice(0, 40).join(', ');

  const prompt = `You are the SEO content strategist for Abiozen LLC, a US-based pharmaceutical API distribution company. Your job: turn ranking gaps into concrete writing tasks for the SEO specialist on the team.

CONTENT GAPS (queries where Abiozen ranks past page 1 with <2% CTR despite >=100 impressions):
${gapsText}

CURRENT CATALOG (sample of active SKU names — for matching gap queries to real molecules):
${catalogText}

For each gap that maps to a real molecule in the catalog, generate ONE specific writing task. Return EXACTLY a JSON array (no commentary, no markdown fences):

[
  {
    "task": "Write product description for Semaglutide targeting query 'buy semaglutide API USA'",
    "query": "...",
    "molecule": "...",
    "page_type": "product_description | category_page | blog_post | landing_page",
    "priority": "high | medium | low"
  }
]

Rules:
- Each task must reference a real molecule from the catalog above. Skip gaps that don't map to a catalog item (those are catalog-expansion opportunities, not SEO tasks).
- Task field must be specific. NOT "Improve SEO". Use the form: "Write [page_type] for [molecule] targeting query '[query]'".
- Priority: high if impressions >= 500, medium 100-499, low below 100.
- Maximum 10 tasks. If fewer real-molecule matches exist, return fewer.

Return ONLY the JSON array.`;

  let raw = '[dry-run] Claude SEO task generation skipped';
  let tasks = [];

  if (!dryRun) {
    raw = await runClaudeAnalysis(prompt);
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) tasks = JSON.parse(match[0]);
    } catch (e) { /* leave tasks empty; raw preserved */ }
  }

  const result = {
    generated_at: new Date().toISOString(),
    gap_window: gapsResult.period,
    gaps: gapsResult.gaps,
    tasks,
    raw_response: raw,
  };

  if (!dryRun) {
    await query(
      `INSERT INTO ai_analyses (id, analysis_type, period_key, content) VALUES ($1, 'seo_tasks', $2, $3)`,
      [crypto.randomUUID(), isoDate(new Date()), JSON.stringify(result)]
    );

    if (tasks.length > 0) {
      const seoUsers = (await query(
        `SELECT email, name FROM users WHERE role='seo_specialist' AND is_active=1 AND email IS NOT NULL`
      )).rows;
      if (seoUsers.length > 0) {
        const html = renderSEOTasksEmail(tasks);
        for (const u of seoUsers) {
          await sendEmail({
            to: u.email,
            subject: `This week — ${tasks.length} SEO tasks ranked by traffic opportunity`,
            html,
          });
        }
        result.emailed_to = seoUsers.map(u => u.email);
      }
    }
  }

  return result;
}

// Returns queries where buyers searched in Algolia and got zero results, AFTER
// removing anything that fuzzy-matches a SKU we already carry. The remainder
// is what the catalog is missing — closely related to procurement priorities.
async function trackAlgoliaNoResults() {
  const algolia = await syncAlgoliaSearchData();
  if (algolia.skipped) return { skipped: true, reason: algolia.reason, missing: [] };

  const skus = (await query(`SELECT name FROM skus WHERE is_active=1`)).rows.map(s => (s.name || '').toLowerCase());
  const matchesCatalog = q => {
    const ql = q.toLowerCase();
    return skus.some(name => name && (name.includes(ql) || ql.includes(name)));
  };

  const missing = (algolia.no_result || [])
    .filter(q => q.query && !matchesCatalog(q.query))
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, 20)
    .map(q => ({ query: q.query, no_result_count: q.count }));

  return { period: algolia.period, missing_count: missing.length, missing };
}

// ── Catalog SEO landing-page generator ───────────────────────────────────────
// One SEO product page per molecule in the Algolia catalog, stored in
// seo_content. URL: /store/product/<category-slug>/<molecule-slug>/. Pages use
// claude-haiku-4-5 (cheap, fast — fine for SEO copy).
const SEO_MODEL = 'claude-haiku-4-5-20251001';

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/%/g, ' percent ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}
function productUrl(category, name) {
  return `/store/product/${slugify(category || 'api')}/${slugify(name)}/`;
}

// Browse the Algolia catalog index for all product records (name + cas + purity
// + category + is_gmp). Read-only; returns [] if Algolia isn't configured.
async function fetchCatalogProducts() {
  const appId = getAppId();
  const key = getSearchKey() || getAnalyticsKey();
  const index = process.env.ALGOLIA_INDEX_NAME || 'abiozen_products';
  if (!appId || !key) return { products: [], error: 'Algolia env not configured' };
  try {
    const res = await fetch(`https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/query`, {
      method: 'POST',
      headers: { 'X-Algolia-Application-Id': appId, 'X-Algolia-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '', hitsPerPage: 1000, attributesToRetrieve: ['name', 'cas_number', 'purity', 'category', 'is_gmp'] }),
    });
    if (!res.ok) return { products: [], error: `Algolia ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
    const data = await res.json();
    const products = (data.hits || [])
      .map(h => ({
        name: (h.name || '').trim(),
        cas_number: (h.cas_number || '').toString().trim(),
        purity: h.purity != null ? String(h.purity) : '99',
        category: (h.category || 'API').trim(),
        is_gmp: !!h.is_gmp,
      }))
      .filter(p => p.name);
    return { products };
  } catch (e) { return { products: [], error: e.message }; }
}

// Generate one SEO landing page via Claude and upsert into seo_content.
async function generateSeoPage(product) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured' };
  const { name, cas_number, purity, category, is_gmp } = product;
  const grade = is_gmp ? 'GMP grade' : 'research grade';
  const url = productUrl(category, name);

  const prompt = `You are an SEO content writer for Abiozen LLC, a US-based pharmaceutical API distribution company. Generate a complete, SEO-optimized product landing page for the molecule below.

Molecule: ${name}
CAS number: ${cas_number || '(not provided — omit CAS-specific claims if blank)'}
Purity: ${purity}%
Grade: ${grade}
Category: ${category}

Target these Google search keywords naturally in the copy and headings:
- "buy ${name} API USA"
- "${name} bulk supplier"
- "${name} GMP grade pharmaceutical"
- "${cas_number} supplier"

Return EXACTLY one JSON object and nothing else (no markdown fences, no commentary):
{
  "title": "Buy ${name} API | ${purity}% Pure | US Stock | Abiozen",
  "meta_desc": "buyer-intent meta description, 160 characters MAXIMUM, includes the molecule name",
  "content_html": "valid HTML string for the page body",
  "schema_json": { schema.org Product JSON-LD object }
}

Requirements for "content_html":
- One <h1> combining the molecule name with availability (e.g. "${name} — In US Stock").
- A ~300-word description: what the molecule is, its uses/applications, and why source it from Abiozen (US stock, fast lead time, COA & SDS, ${grade}).
- A specifications <table> with rows for: CAS Number (${cas_number || 'available on request'}), Purity (${purity}%), Grade (${grade}), Storage (a sensible default such as "Cool, dry place, away from light").
- A clear call-to-action: a "Request Quote" button/link pointing to mailto:naren@abiozen.com (e.g. <a href="mailto:naren@abiozen.com?subject=Quote%20request%3A%20${encodeURIComponent(name)}" ...>Request Quote</a>).
- An <h2>Frequently Asked Questions</h2> with 3-5 buyer questions (pricing, MOQ, lead time, documentation) each with a <p> answer.
Requirements for "schema_json": valid schema.org "Product" JSON-LD — "@context", "@type":"Product", name, description, an identifier using the CAS number when present, brand "Abiozen LLC", and an "offers" object (availability InStock, priceCurrency USD; do NOT invent a specific price — use "offers" with "availability" and a "url").
Do NOT invent specific prices, lot numbers, or medical/regulatory claims. Keep language factual and conservative. Return ONLY the JSON object.`;

  let content;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: SEO_MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return { error: `Claude ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}` };
    const data = await res.json();
    const raw = (data.content?.[0]?.text || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    content = JSON.parse(match ? match[0] : raw);
  } catch (e) { return { error: e.message }; }
  if (!content.title || !content.content_html) return { error: 'missing title/content_html' };

  const schemaStr = content.schema_json != null
    ? (typeof content.schema_json === 'string' ? content.schema_json : JSON.stringify(content.schema_json))
    : null;
  await query(
    `INSERT INTO seo_content (id, molecule_name, cas_number, title, meta_desc, content_html, schema_json, category, slug, url, purity, generated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (molecule_name, cas_number) DO UPDATE
       SET title=EXCLUDED.title, meta_desc=EXCLUDED.meta_desc, content_html=EXCLUDED.content_html,
           schema_json=EXCLUDED.schema_json, category=EXCLUDED.category, slug=EXCLUDED.slug,
           url=EXCLUDED.url, purity=EXCLUDED.purity, generated_at=NOW()`,
    [crypto.randomUUID(), name, cas_number || '', content.title || null, content.meta_desc || null,
     content.content_html || null, schemaStr, category, slugify(name), url, purity]
  );
  return { ok: true, molecule: name, url };
}

// Generate (or refresh) SEO pages for every molecule in the catalog. Sequential
// to stay within rate limits; skips molecules already generated unless force=true.
async function generateCatalogSeoPages({ force = false, limit = 0 } = {}) {
  const { products, error } = await fetchCatalogProducts();
  if (error) return { error, total: 0, generated: 0, skipped: 0, failed: 0 };
  const existing = new Set();
  if (!force) {
    for (const r of (await query(`SELECT molecule_name, cas_number FROM seo_content`)).rows) {
      existing.add(`${(r.molecule_name || '').toLowerCase()}|${r.cas_number || ''}`);
    }
  }
  const list = limit > 0 ? products.slice(0, limit) : products;
  let generated = 0, skipped = 0, failed = 0; const errors = [];
  for (const p of list) {
    if (!force && existing.has(`${p.name.toLowerCase()}|${p.cas_number || ''}`)) { skipped++; continue; }
    const r = await generateSeoPage(p);
    if (r.ok) generated++;
    else { failed++; errors.push(`${p.name}: ${r.error}`); }
  }
  return { total: products.length, attempted: list.length, generated, skipped, failed, errors: errors.slice(0, 20) };
}

// ── Push SEO content to the live abiozen product DB ───────────────────────────
// Writes PlaybookOS seo_content into the abiozen `products` table (a separate DB
// reached via ABIOZEN_DATABASE_URL, same connection the Algolia sync uses),
// matched on cas_number. Populates meta_title / meta_description / seo_content_html
// / schema_json — the four columns added by store migration 0041. Idempotent: an
// UPDATE keyed on CAS just re-writes the same values on a re-run.
//
// A CAS can map to more than one product row (e.g. multiple pack forms); all of
// them get the SEO, so `updated` (product rows written) may exceed `matched`
// (seo_content rows that hit at least one product).
async function pushSeoContentToAbiozen({ dryRun = false } = {}) {
  const abiozenUrl = process.env.ABIOZEN_DATABASE_URL;
  const out = { total: 0, eligible: 0, matched: 0, updated: 0, skipped_no_cas: 0, skipped_excluded: 0, unmatched: [], errors: [] };
  if (!abiozenUrl) { out.errors.push('ABIOZEN_DATABASE_URL is not configured'); return out; }

  const rows = (await query(
    `SELECT molecule_name, cas_number, title, meta_desc, content_html, schema_json
     FROM seo_content ORDER BY molecule_name`
  )).rows;
  out.total = rows.length;

  const eligible = [];
  for (const r of rows) {
    const cas = String(r.cas_number || '').trim();
    if (!cas) { out.skipped_no_cas++; continue; }
    if (SEO_PUSH_EXCLUDE_CAS.has(cas)) { out.skipped_excluded++; continue; }
    eligible.push({ ...r, cas });
  }
  out.eligible = eligible.length;
  if (dryRun) return { ...out, dryRun: true };

  const pool = new Pool({ connectionString: abiozenUrl, ssl: { rejectUnauthorized: false } });
  try {
    for (const r of eligible) {
      try {
        const res = await pool.query(
          `UPDATE products
             SET meta_title = $1, meta_description = $2, seo_content_html = $3, schema_json = $4
           WHERE TRIM(cas_number) = $5`,
          [
            (r.title || '').slice(0, 200),     // varchar(200)
            (r.meta_desc || '').slice(0, 300), // varchar(300)
            r.content_html || null,
            r.schema_json || null,
            r.cas,
          ]
        );
        if (res.rowCount > 0) { out.matched++; out.updated += res.rowCount; }
        else out.unmatched.push(`${r.molecule_name} (cas ${r.cas})`);
      } catch (e) { out.errors.push(`${r.molecule_name}: ${e.message}`); }
    }
  } finally {
    await pool.end();
  }

  await logAgentActivity({
    agent_name: 'seo-agent', action_type: 'seo_content_pushed', user_id: null,
    reasoning: `Pushed SEO content to abiozen products: ${out.matched}/${out.eligible} molecules matched, ${out.updated} product rows updated. `
      + `Skipped ${out.skipped_excluded} excluded + ${out.skipped_no_cas} without CAS. ${out.unmatched.length} eligible had no matching product. ${out.errors.length} errors.`,
    source_kpi: 'kpi-sg-marketing',
    confidence_score: out.errors.length ? 60 : 90,
    output_summary: `matched=${out.matched} updated=${out.updated} skipped=${out.skipped_excluded + out.skipped_no_cas} unmatched=${out.unmatched.length} errors=${out.errors.length}`,
  }).catch(e => console.error('[seo-agent] push audit failed:', e.message));

  return out;
}

module.exports = {
  trackKeywordRankings, identifyContentGaps, generateSEOTasksForTeam, trackAlgoliaNoResults,
  fetchCatalogProducts, generateSeoPage, generateCatalogSeoPages, slugify, productUrl,
  pushSeoContentToAbiozen,
};
