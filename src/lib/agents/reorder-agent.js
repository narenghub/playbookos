// Reorder Agent — finds past buyers likely ready to reorder, writes personalized
// reorder campaigns, and pushes them to Apollo as (inactive) sequences for Naresh
// to approve — recurring revenue from existing customers.
//
// DATA NOTE: the `orders` table carries no buyer identity (no email/name), so
// buyer accounts are built primarily from `leads` (real contacts from the Sales
// Pipeline / Apollo replies) plus any manually-added buyers; `orders` contributes
// aggregate revenue context only. As real orders with buyer emails accumulate,
// syncBuyersFromOrders picks them up (it defensively reads an email column if one
// exists).
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('../mailer');
const { logAgentActivity, parseClaudeJSON } = require('../agent-core');
const { publishSequenceToApollo } = require('./email-engine');

const AGENT = 'reorder-agent';
const MODEL = 'claude-opus-4-8';
const BASE_URL = () => process.env.BASE_URL || 'https://playbook.abiozen.com';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const jarr = v => { try { return JSON.parse(v || '[]'); } catch { return []; } };

async function callClaude(prompt, { maxTokens = 900 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { text: null, error: 'ANTHROPIC_API_KEY not configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return { text: null, error: `Claude ${res.status}: ${(await res.text()).slice(0, 160)}` };
    return { text: (await res.json()).content?.[0]?.text || '' };
  } catch (e) { return { text: null, error: e.message }; }
}
async function getNaresh() {
  const r = (await query(`SELECT id, name, email FROM users WHERE is_active=1 AND role IN ('admin','super_admin') ORDER BY CASE WHEN LOWER(email) LIKE 'naren%' THEN 0 ELSE 1 END, created_at LIMIT 1`)).rows[0];
  return r || { name: 'Naresh', email: 'naren@abiozen.com', id: null };
}

// Infer a buyer_type from a lead's source_sequence / segment text.
function inferBuyerType(text) {
  const t = String(text || '').toLowerCase();
  if (/compounding/.test(t)) return 'compounding_pharmacy';
  if (/research|lab/.test(t)) return 'research_lab';
  if (/universit|academ/.test(t)) return 'university';
  if (/generic|manufactur/.test(t)) return 'generic_manufacturer';
  return 'research_lab';
}
// Pull the molecule out of a campaign name like "Metformin — Compounding Pharmacy — Week…".
function moleculeFrom(sourceSeq) {
  const m = String(sourceSeq || '').split(/[—-]/)[0].trim();
  return m && m.length > 2 ? m : null;
}

// ── Function 1 — sync buyers from orders (+ leads) ────────────────────────────
async function syncBuyersFromOrders() {
  const buyers = new Map(); // key: lower(email)
  const add = (email, patch) => {
    const k = norm(email);
    if (!k || !email) return;
    const cur = buyers.get(k) || { email, contact_name: null, company_name: null, buyer_type: null, molecules: new Set(), dates: [], total_spent: 0, total_orders: 0 };
    if (patch.contact_name && !cur.contact_name) cur.contact_name = patch.contact_name;
    if (patch.company_name && !cur.company_name) cur.company_name = patch.company_name;
    if (patch.buyer_type && !cur.buyer_type) cur.buyer_type = patch.buyer_type;
    if (patch.molecule) cur.molecules.add(patch.molecule);
    if (patch.date) cur.dates.push(patch.date);
    if (patch.spent) cur.total_spent += Number(patch.spent) || 0;
    cur.total_orders += patch.orders || 0;
    buyers.set(k, cur);
  };

  // Leads = real contact identities (the Sales Pipeline). Every lead with an email
  // is a buyer/prospect; a WARM/HOT lead's source_sequence names the molecule.
  const leads = (await query(`SELECT email, contact_name, company, source_sequence, classification, created_at FROM leads WHERE email IS NOT NULL`)).rows;
  for (const l of leads) {
    add(l.email, {
      contact_name: l.contact_name, company_name: l.company,
      buyer_type: inferBuyerType(l.source_sequence), molecule: moleculeFrom(l.source_sequence),
      date: l.created_at, orders: 1,
    });
  }
  // Orders — defensive: only attributes to a buyer if an email column exists (it
  // does not today; contributes aggregate revenue via the dashboard instead).
  const orderCols = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name='orders'`)).rows.map(r => r.column_name);
  const emailCol = ['buyer_email', 'email', 'customer_email'].find(c => orderCols.includes(c));
  if (emailCol) {
    const orders = (await query(`SELECT ${emailCol} AS email, amount, order_date, product_category, buyer_type FROM orders WHERE ${emailCol} IS NOT NULL`)).rows;
    for (const o of orders) add(o.email, { molecule: o.product_category, date: o.order_date, spent: o.amount, orders: 1, buyer_type: o.buyer_type });
  }

  let synced = 0;
  for (const b of buyers.values()) {
    const dates = b.dates.filter(Boolean).map(d => new Date(d)).filter(d => !isNaN(d)).sort((a, z) => a - z);
    const last = dates.length ? dates[dates.length - 1].toISOString().slice(0, 10) : null;
    const first = dates.length ? dates[0].toISOString().slice(0, 10) : null;
    // reorder frequency: avg gap between order dates when 2+.
    let freq = null;
    if (dates.length >= 2) {
      let gap = 0; for (let i = 1; i < dates.length; i++) gap += (dates[i] - dates[i - 1]) / 86400000;
      freq = Math.round(gap / (dates.length - 1));
    }
    const mols = [...b.molecules].filter(Boolean);
    const existing = (await query('SELECT id FROM buyer_accounts WHERE LOWER(email)=LOWER($1)', [b.email])).rows[0];
    if (existing) {
      await query(
        `UPDATE buyer_accounts SET contact_name=COALESCE($1,contact_name), company_name=COALESCE($2,company_name),
           buyer_type=COALESCE($3,buyer_type), total_orders=$4, total_spent_usd=$5, molecules_purchased=$6,
           last_order_date=COALESCE($7,last_order_date), reorder_frequency_days=COALESCE($8,reorder_frequency_days), updated_at=NOW()
         WHERE id=$9`,
        [b.contact_name, b.company_name, b.buyer_type, b.total_orders, b.total_spent, JSON.stringify(mols), last, freq, existing.id]);
    } else {
      await query(
        `INSERT INTO buyer_accounts (id, contact_name, company_name, email, buyer_type, first_order_date,
           last_order_date, total_orders, total_spent_usd, molecules_purchased, preferred_molecules,
           reorder_frequency_days, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,'active',NOW(),NOW())`,
        [crypto.randomUUID(), b.contact_name, b.company_name, b.email, b.buyer_type, first, last,
         b.total_orders, b.total_spent, JSON.stringify(mols), freq]);
    }
    synced++;
  }
  await logAgentActivity({ agent_name: AGENT, action_type: 'buyers_synced', reasoning: `Synced ${synced} buyer accounts from leads/orders.`, source_kpi: 'kpi-sg-sales', output_summary: `synced=${synced}` }).catch(() => {});
  return { buyers_synced: synced };
}

// ── Function 2 — identify reorder candidates ──────────────────────────────────
async function identifyReorderCandidates({ topN = 20 } = {}) {
  const buyers = (await query(`SELECT * FROM buyer_accounts WHERE status='active'`)).rows;
  const topMol = new Set((await query(
    `SELECT LOWER(molecule_name) m FROM molecule_history WHERE week_start=(SELECT MAX(week_start) FROM molecule_history) ORDER BY COALESCE(rank,9999) LIMIT 10`
  )).rows.map(r => r.m));
  const now = Date.now();
  const candidates = [];
  for (const b of buyers) {
    if (!b.last_order_date) continue;
    const daysSince = Math.round((now - new Date(b.last_order_date).getTime()) / 86400000);
    let score = daysSince <= 60 && daysSince >= 30 ? 90
      : daysSince > 60 && daysSince <= 90 ? 70
      : daysSince > 90 && daysSince <= 120 ? 50
      : daysSince > 120 ? 30
      : daysSince < 30 ? 40 : 30; // <30 days: too soon, low score
    if ((b.total_orders || 0) >= 3) score += 10;
    if (b.buyer_type === 'compounding_pharmacy') score += 5;
    const mols = jarr(b.molecules_purchased);
    const molecule = mols[0] || null;
    if (molecule && topMol.has(norm(molecule))) score += 10;
    // -20 if already in an active reorder campaign (proxy for "in an active Apollo sequence")
    const active = (await query(`SELECT id FROM reorder_campaigns WHERE buyer_id=$1 AND campaign_status IN ('email_sent','replied')`, [b.id])).rows[0];
    if (active) score -= 20;
    candidates.push({ buyer: b, molecule, daysSince, score: Math.min(100, Math.max(0, score)) });
  }
  candidates.sort((a, z) => z.score - a.score);
  return candidates.slice(0, topN);
}

// ── Function 3 — reorder email (Claude) ───────────────────────────────────────
async function generateReorderEmail(buyer, molecule, daysSince) {
  const prompt = `Write a warm, personalized reorder email for a pharmaceutical buyer.

Buyer: ${buyer.contact_name || 'there'} at ${buyer.company_name || 'your organization'}
They previously purchased: ${molecule || 'a molecule from Abiozen'}
Days since last purchase: ${daysSince}
Buyer type: ${buyer.buyer_type || 'research lab'}

Write a professional but warm email that:
- References their previous purchase naturally (not salesy)
- Mentions a relevant market update for this molecule (only if genuinely likely, e.g. steady demand; do NOT invent a specific patent event or price)
- Offers competitive pricing and quick turnaround
- Asks if they need a replenishment quote
- Is under 150 words

Return ONLY the email body as plain text with line breaks. End with exactly:

Sales Team
Abiozen LLC
sales@abiozen.com`;
  const { text, error } = await callClaude(prompt, { maxTokens: 700 });
  const subject = molecule ? `Time to restock ${molecule}? — Abiozen` : `Ready for a reorder? — Abiozen`;
  return { subject, body: text || null, error };
}

// ── Function 4 — create the reorder sequence in Apollo (inactive) ─────────────
async function createReorderSequenceInApollo(buyer, campaign) {
  const apolloKey = process.env.APOLLO_API_KEY;
  if (!apolloKey) return { ok: false, error: 'APOLLO_API_KEY not configured' };
  const html = body => `<div style="font-family:Arial;font-size:14px;line-height:1.6;color:#222;white-space:pre-wrap">${esc(body)}</div>`;
  const nudge1 = `Hi ${buyer.contact_name || 'there'}, just following up on ${campaign.molecule_name || 'your previous order'} — happy to send a quick replenishment quote whenever you're ready.\n\nSales Team\nAbiozen LLC`;
  const nudge2 = `Hi ${buyer.contact_name || 'there'}, last note on this — if ${campaign.molecule_name || 'a reorder'} is still on your radar we can turn around pricing same day. Just reply here.\n\nSales Team\nAbiozen LLC`;
  const payload = {
    name: `Reorder — ${campaign.molecule_name || 'molecule'} — ${buyer.company_name || 'buyer'} — ${new Date().toISOString().slice(0, 10)}`,
    permissions: 'team_can_use', active: false,
    emailer_steps: [
      { position: 1, wait_days: 0, type: 'auto_email', subject: campaign.email_subject, body_html: html(campaign.email_body) },
      { position: 2, wait_days: 5, type: 'auto_email', subject: `Re: ${campaign.email_subject}`, body_html: html(nudge1) },
      { position: 3, wait_days: 10, type: 'auto_email', subject: `Re: ${campaign.email_subject}`, body_html: html(nudge2) },
    ],
  };
  return publishSequenceToApollo(payload, apolloKey);
}

// ── Function 5 — orchestration ────────────────────────────────────────────────
async function runReorderAgent({ dryRun = false, topN = 20 } = {}) {
  const sync = await syncBuyersFromOrders();
  const candidates = await identifyReorderCandidates({ topN });
  const out = { buyers_analyzed: sync.buyers_synced, candidates_found: candidates.length, campaigns_created: 0, estimated_pipeline: 0, dryRun, errors: [] };

  const created = [];
  for (const c of candidates) {
    try {
      const { subject, body, error } = await generateReorderEmail(c.buyer, c.molecule, c.daysSince);
      if (!body) { out.errors.push(`${c.buyer.company_name || c.buyer.email}: ${error || 'no email body'}`); continue; }
      const campaignId = crypto.randomUUID();
      const orderValue = Math.round(Number(c.buyer.total_spent_usd) / Math.max(1, c.buyer.total_orders)) || 5000; // avg past order as pipeline proxy
      let apolloSeq = null;
      if (!dryRun) {
        const apollo = await createReorderSequenceInApollo(c.buyer, { molecule_name: c.molecule, email_subject: subject, email_body: body });
        if (apollo.ok) apolloSeq = apollo.sequenceId;
        else out.errors.push(`${c.buyer.company_name || c.buyer.email}: Apollo — ${apollo.stage || ''} ${apollo.detail || apollo.error || ''}`.slice(0, 160));
      }
      if (!dryRun) {
        await query(
          `INSERT INTO reorder_campaigns (id, buyer_id, molecule_name, last_purchase_date, days_since_purchase,
             reorder_probability, campaign_status, apollo_sequence_id, email_subject, email_body, order_value_usd, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
          [campaignId, c.buyer.id, c.molecule, c.buyer.last_order_date, c.daysSince, c.score,
           apolloSeq ? 'email_sent' : 'pending', apolloSeq, subject, body, orderValue]);
      }
      out.campaigns_created++;
      out.estimated_pipeline += orderValue;
      created.push({ company: c.buyer.company_name, contact: c.buyer.contact_name, molecule: c.molecule, daysSince: c.daysSince, score: c.score, apollo: !!apolloSeq });
    } catch (e) { out.errors.push(`${c.buyer.company_name || c.buyer.id}: ${e.message}`); }
  }

  if (!dryRun && created.length) {
    const naresh = await getNaresh();
    const rows = created.map(c => `<li style="margin:4px 0"><strong>${esc(c.company || c.contact || 'Buyer')}</strong> — ${esc(c.molecule || 'reorder')} · ${c.daysSince}d since purchase · <span style="color:${c.score >= 90 ? '#166534' : c.score >= 70 ? '#B45309' : '#718096'};font-weight:700">${c.score}</span>${c.apollo ? ' · <span style="color:#0D7377">in Apollo</span>' : ''}</li>`).join('');
    await sendEmail({ to: naresh.email, subject: `Reorder Agent — ${created.length} campaigns created for review`,
      html: `<div style="font-family:Arial;max-width:640px"><div style="background:#1B3A6B;padding:16px 22px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0">Reorder Agent</h2><p style="color:#9FE1CB;margin:4px 0 0;font-size:13px">${created.length} reorder campaigns · ~$${out.estimated_pipeline.toLocaleString()} estimated pipeline</p></div>
        <div style="padding:18px 22px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
          <p style="font-size:14px">Reorder candidates and drafted campaigns:</p><ul style="padding-left:18px">${rows}</ul>
          <p style="font-size:13px;color:#991B1B"><strong>Review and activate these sequences in Apollo before they send</strong> — they were created inactive.</p>
          <p><a href="${BASE_URL()}/#reorder-agent" style="background:#0D7377;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open Reorder Agent →</a></p></div></div>` }).catch(e => out.errors.push('email: ' + e.message));
  }

  await logAgentActivity({ agent_name: AGENT, action_type: 'reorder_agent_run', user_id: null,
    reasoning: `Analyzed ${out.buyers_analyzed} buyers, found ${out.candidates_found} candidates, created ${out.campaigns_created} campaigns (~$${out.estimated_pipeline} pipeline).`,
    source_kpi: 'kpi-sg-sales', confidence_score: out.errors.length ? 60 : 90,
    output_summary: `buyers=${out.buyers_analyzed} candidates=${out.candidates_found} campaigns=${out.campaigns_created} dryRun=${dryRun}` }).catch(() => {});
  return out;
}

module.exports = {
  runReorderAgent, syncBuyersFromOrders, identifyReorderCandidates, generateReorderEmail,
  createReorderSequenceInApollo,
};
