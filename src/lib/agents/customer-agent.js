const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');

// Score 0-100 from Apollo-style engagement signals stored in buyer_engagement.
// Raw scoring: open=+20, click=+30, reply=+50, >=3 opens=+10, reply within 24h
// of latest send=+20. Cap at 100. Designed so a single click+open lands around
// 50 (warm), a reply lands around 70 (hot), and a fast reply tops 90+.
async function scoreLeadWarmth(contactEmail) {
  const events = (await query(
    `SELECT event_type, event_at FROM buyer_engagement WHERE contact_email=$1 ORDER BY event_at DESC`,
    [contactEmail]
  )).rows;

  if (events.length === 0) return { email: contactEmail, score: 0, signals: [], event_count: 0 };

  let score = 0;
  const signals = [];

  const sends   = events.filter(e => e.event_type === 'sent');
  const opens   = events.filter(e => e.event_type === 'opened');
  const clicks  = events.filter(e => e.event_type === 'clicked');
  const replies = events.filter(e => e.event_type === 'replied');

  if (opens.length > 0)   { score += 20; signals.push(`${opens.length} email open${opens.length > 1 ? 's' : ''}`); }
  if (clicks.length > 0)  { score += 30; signals.push(`${clicks.length} click${clicks.length > 1 ? 's' : ''}`); }
  if (replies.length > 0) { score += 50; signals.push(`${replies.length} repl${replies.length > 1 ? 'ies' : 'y'}`); }

  if (opens.length >= 3) { score += 10; signals.push('multiple opens (+10 bonus)'); }

  if (replies.length > 0 && sends.length > 0) {
    const latestSend = new Date(sends[0].event_at);
    const earliestReplyAfterSend = [...replies].reverse().find(r => new Date(r.event_at) >= latestSend);
    if (earliestReplyAfterSend) {
      const hoursDelta = (new Date(earliestReplyAfterSend.event_at) - latestSend) / 3600000;
      if (hoursDelta <= 24) {
        score += 20;
        signals.push(`fast reply (${Math.round(hoursDelta)}h, +20 bonus)`);
      }
    }
  }

  return {
    email: contactEmail,
    score: Math.min(score, 100),
    signals,
    event_count: events.length,
    last_event_at: events[0]?.event_at || null,
  };
}

async function getWarmLeads({ limit = 10 } = {}) {
  const contacts = (await query(`
    SELECT DISTINCT bc.email, bc.name, bc.title, bc.company, bc.segment, bc.phone, bc.last_contacted
    FROM buyer_contacts bc
    JOIN buyer_engagement be ON be.contact_email = bc.email
  `)).rows;

  if (contacts.length === 0) return [];

  const scored = [];
  for (const c of contacts) {
    const result = await scoreLeadWarmth(c.email);
    scored.push({ ...c, score: result.score, signals: result.signals, event_count: result.event_count, last_event_at: result.last_event_at });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function generateOutreachRecommendations({ dryRun = false } = {}) {
  const leads = await getWarmLeads({ limit: 10 });
  if (leads.length === 0) {
    return { skipped: true, reason: 'no engagement data in buyer_engagement — populate via Apollo webhook to get recommendations', leads: [], recommendations: [] };
  }

  const recentCategories = (await query(`
    SELECT product_category, COUNT(*)::int as orders, COALESCE(SUM(amount),0)::float as revenue
    FROM orders WHERE order_date::text >= (NOW() - INTERVAL '30 days')::date::text
    GROUP BY product_category ORDER BY revenue DESC LIMIT 5
  `)).rows;

  const leadsText = leads.map((l, i) =>
    `${i + 1}. ${l.name || '(unknown)'} — ${l.title || ''} at ${l.company || ''} — segment: ${l.segment || 'unknown'} — warmth ${l.score}/100 — signals: ${l.signals.join(', ') || 'none'}`
  ).join('\n');

  const categoriesText = recentCategories.length
    ? recentCategories.map(r => `- ${r.product_category || '(uncategorized)'}: ${r.orders} orders, $${r.revenue.toLocaleString()}`).join('\n')
    : '(no recent orders)';

  const prompt = `You are the Customer Agent for Abiozen LLC, a US-based pharmaceutical API distribution company. Your job is to tell the sales team exactly who to call today and what to open with.

TOP 10 WARM LEADS (sorted by engagement warmth, last 30 days of behavior):
${leadsText}

RECENT BEST-SELLING CATEGORIES (last 30 days, for talking-point context):
${categoriesText}

For each warm lead above, generate ONE specific outreach recommendation. Return EXACTLY a JSON array (no commentary, no markdown fences):

[
  {
    "email": "...",
    "name": "...",
    "company": "...",
    "warmth": NUMBER,
    "priority": "high|medium|low",
    "molecule_focus": "the specific molecule to lead with",
    "talking_points": ["1-2 sentence specifics — what to mention, why now"],
    "channel": "call|email|linkedin"
  }
]

Rules:
- Lead with the molecule most likely to convert for that segment (compounding_pharmacy -> GLP-1 / hormones; research_lab -> peptides; generic_manufacturer -> APIs; university -> research compounds).
- Talking points must be specific and reference either their segment or a recent best-selling category. No "discuss our products".
- Priority: high if warmth >= 70, medium 40-69, low below 40.
- Channel: call for warmth >= 70 (warm enough for a phone call), email for 40-69, linkedin for lower.
- Maximum 10 items. Match the order of the warm leads list above.

Return ONLY the JSON array.`;

  let raw = '[dry-run] Claude outreach recommendations skipped';
  let recommendations = [];

  if (!dryRun) {
    raw = await runClaudeAnalysis(prompt);
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) recommendations = JSON.parse(match[0]);
    } catch (e) {
      // Keep raw, leave recommendations empty
    }
  }

  const result = {
    generated_at: new Date().toISOString(),
    leads,
    recommendations,
    recent_categories: recentCategories,
    raw_response: raw,
  };

  if (!dryRun) {
    await query(
      `INSERT INTO ai_analyses (id, analysis_type, period_key, content) VALUES ($1, 'outreach_recommendations', $2, $3)`,
      [crypto.randomUUID(), new Date().toISOString().slice(0, 10), JSON.stringify(result)]
    );
  }

  return result;
}

module.exports = { scoreLeadWarmth, getWarmLeads, generateOutreachRecommendations };
