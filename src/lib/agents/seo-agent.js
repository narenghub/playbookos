const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');
const { fetchGSCData, syncAlgoliaSearchData } = require('./growth-agent');

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

module.exports = { trackKeywordRankings, identifyContentGaps, generateSEOTasksForTeam, trackAlgoliaNoResults };
