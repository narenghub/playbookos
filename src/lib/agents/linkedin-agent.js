// LinkedIn AI Content Engine — generates pharma/biotech posts for the Abiozen
// company page. Drafts go into linkedin_content_queue and require admin approval
// before publishPost() pushes them to the LinkedIn UGC API.
const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');
const { logAgentActivity, getCEOUser, parseClaudeJSON } = require('../agent-core');

const AGENT = 'linkedin-agent';
const MAX_POST_CHARS = 1300;
const REQUIRED_HASHTAGS = ['#Pharmaceuticals', '#API', '#ResearchChemicals', '#Biotech', '#DrugDiscovery'];

const isoDay = d => new Date(d).toISOString().slice(0, 10);

function clampPost(text) {
  if (!text) return '';
  return text.length <= MAX_POST_CHARS ? text : text.slice(0, MAX_POST_CHARS - 1).replace(/\s+\S*$/, '') + '…';
}

function assemblePost({ headline, body, hashtags }) {
  const tagList = Array.isArray(hashtags) ? hashtags : String(hashtags || '').split(/\s+/).filter(Boolean);
  // Always include the core hashtags from the spec (deduplicated, case-insensitive)
  const seen = new Set();
  const allTags = [...tagList, ...REQUIRED_HASHTAGS].filter(t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const tagLine = allTags.map(t => t.startsWith('#') ? t : '#' + t).join(' ');
  const full = [headline, body, tagLine].filter(Boolean).join('\n\n');
  return { full_post: clampPost(full), hashtags: tagLine };
}

async function callClaudeForPost(prompt) {
  const raw = await runClaudeAnalysis(prompt);
  const j = parseClaudeJSON(raw);
  if (!j || typeof j !== 'object') return null;
  return {
    headline: j.headline || '',
    body: j.body || '',
    hashtags: Array.isArray(j.hashtags) ? j.hashtags : [],
  };
}

// 1) Single-molecule product post.
async function generateProductPost(molecule) {
  const m = typeof molecule === 'string' ? { name: molecule } : (molecule || {});
  const name = (m.name || '').trim();
  const cas = (m.cas || m.cas_number || '').trim();
  const purity = (m.purity || '99').toString().trim();
  if (!name) throw new Error('generateProductPost requires a molecule name');

  const prompt = `You are the LinkedIn content writer for Abiozen LLC, a US pharmaceutical API distribution company. Write one LinkedIn post announcing availability of the molecule below.

Molecule: ${name}
CAS number: ${cas || '(not provided)'}
Purity: ${purity}%

Tone: professional pharma/biotech industry, factual, confident, no fluff. Highlight: availability now in US stock, purity, COA available, fast delivery to research and procurement teams. Do NOT invent specific prices, lot numbers, or regulatory claims.

Return EXACTLY a JSON object, no other text:
{"headline":"one-line opener (<=120 chars)","body":"2-4 short paragraphs separated by \\n\\n; total under 900 chars","hashtags":["#Pharma","#API"]}

The full post (headline + body + hashtags) must fit in 1300 characters. Choose 3-5 hashtags that fit the molecule and industry (procurement/research/biotech).`;

  const parsed = await callClaudeForPost(prompt);
  if (!parsed) throw new Error('Claude returned an unparseable LinkedIn post');
  const { full_post, hashtags } = assemblePost(parsed);
  return {
    post_type: 'product',
    headline: parsed.headline,
    body: parsed.body,
    hashtags,
    full_post,
    source_molecule: name,
  };
}

// 2) Weekly market-intelligence post — uses the latest growth-intelligence output
// if no analysisData is passed in.
async function generateMarketIntelligencePost(analysisData) {
  let data = analysisData;
  if (!data) {
    const row = (await query(
      `SELECT content FROM ai_analyses WHERE analysis_type='growth_intelligence' ORDER BY created_at DESC LIMIT 1`
    )).rows[0];
    if (row) { try { data = JSON.parse(row.content); } catch {} }
  }
  const topMolecules = ((data && data.top_molecules) || []).slice(0, 5);
  const candidatesCount = (data && data.candidates) ? data.candidates.length : 0;

  const summary = topMolecules.length
    ? topMolecules.map((m, i) => `${i + 1}. ${m.molecule || m.name || '?'} — demand ${m.demand_signal || m.demand || '?'}`).join('\n')
    : '(no top-molecule data — using a generic market post)';

  const prompt = `You are the LinkedIn content writer for Abiozen LLC. Write this week's market-intelligence LinkedIn post — a confident, industry-credible "what we're seeing in the US pharma market" update from a distributor with visibility into buyer demand.

THIS WEEK'S TOP FAST-MOVING MOLECULES IN US PHARMA (from our internal demand signals across ${candidatesCount} candidate queries):
${summary}

Tone: professional industry analyst voice. Position Abiozen as a market-intelligence leader. The post should drive inbound from procurement managers and lab directors. Do not invent specific prices, regulatory claims, or molecules not listed above.

Return EXACTLY a JSON object, no other text:
{"headline":"one-line opener (<=120 chars)","body":"3-4 short paragraphs separated by \\n\\n; mention 2-3 of the molecules above; total under 900 chars","hashtags":["#Pharma","#API"]}

Full post must fit in 1300 characters.`;

  const parsed = await callClaudeForPost(prompt);
  if (!parsed) throw new Error('Claude returned an unparseable LinkedIn post');
  const { full_post, hashtags } = assemblePost(parsed);
  return {
    post_type: 'market_intelligence',
    headline: parsed.headline,
    body: parsed.body,
    hashtags,
    full_post,
    source_molecule: null,
  };
}

// 3) Monthly company-update post.
async function generateCompanyUpdate(metrics) {
  let m = metrics;
  if (!m) {
    const skusAdded = parseInt((await query(
      `SELECT COUNT(*) c FROM skus WHERE created_at::timestamptz >= NOW() - INTERVAL '30 days'`
    )).rows[0].c, 10);
    const activeSkus = parseInt((await query(
      `SELECT COUNT(*) c FROM skus WHERE is_active=1`
    )).rows[0].c, 10);
    const coaApproved = parseInt((await query(
      `SELECT COUNT(*) c FROM skus WHERE is_active=1 AND coa_status='approved'`
    )).rows[0].c, 10);
    const newHires = parseInt((await query(
      `SELECT COUNT(*) c FROM users WHERE created_at::timestamptz >= NOW() - INTERVAL '30 days'`
    )).rows[0].c, 10);
    m = { skus_added_30d: skusAdded, active_skus: activeSkus, coa_approved: coaApproved, new_hires_30d: newHires };
  }

  const prompt = `You are the LinkedIn content writer for Abiozen LLC. Write this month's company-update LinkedIn post.

METRICS (last 30 days):
- New molecules added to catalog: ${m.skus_added_30d ?? 0}
- Active SKUs in catalog: ${m.active_skus ?? 0}
- SKUs with approved COA: ${m.coa_approved ?? 0}
- New team members: ${m.new_hires_30d ?? 0}

Tone: confident, milestone-celebrating but professional. Highlight catalog growth, delivery speed, quality certifications (COA), and team growth as available. Do not invent metrics not listed above.

Return EXACTLY a JSON object, no other text:
{"headline":"one-line opener (<=120 chars)","body":"3-4 short paragraphs separated by \\n\\n; cite the metrics above; total under 900 chars","hashtags":["#Pharma","#API"]}

Full post must fit in 1300 characters.`;

  const parsed = await callClaudeForPost(prompt);
  if (!parsed) throw new Error('Claude returned an unparseable LinkedIn post');
  const { full_post, hashtags } = assemblePost(parsed);
  return {
    post_type: 'company_update',
    headline: parsed.headline,
    body: parsed.body,
    hashtags,
    full_post,
    source_molecule: null,
  };
}

// Push a queued post to LinkedIn. The row must be approved.
async function publishPost(queueRow) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const orgId = process.env.LINKEDIN_ORGANIZATION_ID;
  if (!token || !orgId) {
    return { skipped: true, reason: 'LINKEDIN_ACCESS_TOKEN and LINKEDIN_ORGANIZATION_ID must both be set' };
  }
  const author = orgId.startsWith('urn:') ? orgId : `urn:li:organization:${orgId}`;
  const text = clampPost(queueRow.full_post || '');
  const body = {
    author,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
    },
  };
  try {
    const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: `LinkedIn API ${res.status}: ${t.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => ({}));
    const postId = res.headers.get('x-restli-id') || data.id || null;
    return { success: true, post_id: postId };
  } catch (e) {
    return { error: e.message };
  }
}

function nextWeekdayDates() {
  // Return the next Mon, Wed, Fri (today inclusive) as YYYY-MM-DD strings.
  const out = {};
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    const dow = d.getUTCDay();
    if (dow === 1 && !out.monday) out.monday = isoDay(d);
    else if (dow === 3 && !out.wednesday) out.wednesday = isoDay(d);
    else if (dow === 5 && !out.friday) out.friday = isoDay(d);
    if (out.monday && out.wednesday && out.friday) break;
  }
  return out;
}

async function insertDraft(post, scheduledFor) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO linkedin_content_queue
       (id, post_type, headline, body, hashtags, full_post, status, scheduled_for, source_molecule, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,NOW())`,
    [id, post.post_type, post.headline, post.body, post.hashtags, post.full_post, scheduledFor, post.source_molecule]
  );
  return id;
}

function renderApprovalEmail(date, drafts) {
  const rows = drafts.map(d =>
    `<div style="border:1px solid #e0e0e0;border-radius:8px;padding:12px;margin:8px 0;background:#fff">
       <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.4px">${d.post_type.replace('_', ' ')} · scheduled ${d.scheduled_for}</div>
       <div style="font-size:13px;font-weight:600;color:#1a1a2e;margin-top:4px">${(d.headline || '').replace(/</g, '&lt;')}</div>
       <pre style="font-family:Arial,sans-serif;white-space:pre-wrap;font-size:12px;color:#333;margin:6px 0 0;line-height:1.5">${(d.full_post || '').replace(/</g, '&lt;')}</pre>
     </div>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">
    <div style="background:#1B3A6B;padding:18px;border-radius:8px 8px 0 0;color:#fff">
      <h2 style="margin:0;font-size:18px">LinkedIn content queue — week of ${date}</h2>
      <p style="margin:6px 0 0;color:#9FE1CB;font-size:12px">${drafts.length} drafts awaiting approval</p>
    </div>
    <div style="border:1px solid #e0e0e0;border-top:none;padding:16px;background:#f8f9fa">${rows}
      <p style="font-size:11px;color:#666;margin-top:12px">Approve / reject / edit each post on the LinkedIn Content page in PlaybookOS.</p>
    </div>
  </div>`;
}

// Monday 10am cron: generates the week's product / market-intel / company-update
// posts, stores them as drafts, and emails the CEO for review.
async function scheduleLinkedInContent({ dryRun = false } = {}) {
  const week = nextWeekdayDates();
  const ceo = await getCEOUser();

  // Pick a molecule for the product post — top growth-intelligence molecule, else
  // the most recently added active SKU.
  let molecule = null;
  const gi = (await query(
    `SELECT content FROM ai_analyses WHERE analysis_type='growth_intelligence' ORDER BY created_at DESC LIMIT 1`
  )).rows[0];
  if (gi) {
    try {
      const parsed = JSON.parse(gi.content);
      const top = (parsed.top_molecules || [])[0];
      if (top) molecule = { name: top.molecule || top.name, cas: top.cas || '' };
    } catch {}
  }
  if (!molecule) {
    const sku = (await query(
      `SELECT name, cas_number, purity FROM skus WHERE is_active=1 ORDER BY created_at DESC LIMIT 1`
    )).rows[0];
    if (sku) molecule = { name: sku.name, cas: sku.cas_number, purity: sku.purity };
  }
  if (!molecule) molecule = { name: 'Semaglutide', cas: '910463-68-2', purity: '99' };

  const drafts = [];
  const safe = async (label, fn, slot) => {
    try {
      const post = await fn();
      const id = dryRun ? null : await insertDraft(post, slot);
      drafts.push({ id, slot_label: label, scheduled_for: slot, ...post });
    } catch (e) {
      drafts.push({ slot_label: label, scheduled_for: slot, error: e.message });
    }
  };

  await safe('Monday — product post', () => generateProductPost(molecule), week.monday);
  await safe('Wednesday — market intelligence', () => generateMarketIntelligencePost(), week.wednesday);
  await safe('Friday — company update', () => generateCompanyUpdate(), week.friday);

  if (!dryRun) {
    await logAgentActivity({
      agent_name: AGENT, action_type: 'linkedin_weekly_schedule',
      user_id: ceo ? ceo.id : null,
      reasoning: `Drafted ${drafts.filter(d => d.id).length} LinkedIn posts for week of ${week.monday}; awaiting approval.`,
      source_kpi: 'kpi-sg-marketing', confidence_score: 75,
      output_summary: drafts.map(d => `${d.slot_label}: ${d.error ? 'ERROR ' + d.error : (d.headline || 'draft created')}`).join(' | '),
    });
    if (ceo?.email) {
      await sendEmail({
        to: ceo.email,
        subject: `LinkedIn content drafts — week of ${week.monday}`,
        html: renderApprovalEmail(week.monday, drafts.filter(d => d.id)),
      });
    }
  }

  return { week, drafts_created: drafts.filter(d => d.id).length, drafts };
}

module.exports = {
  generateProductPost,
  generateMarketIntelligencePost,
  generateCompanyUpdate,
  scheduleLinkedInContent,
  publishPost,
  MAX_POST_CHARS,
};
