// GMP Inquiry Agent — handles the full B2B inquiry-to-order conversation for GMP
// API molecules autonomously via email: acknowledges the inquiry, answers pricing/
// documentation/compliance/lead-time questions, sends formal quotes, and escalates
// to a human when asked or when the deal is large.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('../mailer');
const { sendWhatsApp } = require('../whatsapp');
const { logAgentActivity, parseClaudeJSON } = require('../agent-core');
const { getGoogleAccessToken: getGoogleToken, SCOPES } = require('../google-auth');

const AGENT = 'inquiry-agent';
const MODEL = 'claude-opus-4-8';
const SALES_FROM = 'Abiozen Sales <sales@abiozen.com>';
const DOC_FEE = 150;
const ESCALATE_ABOVE = 50000;
const BASE_URL = () => process.env.BASE_URL || 'https://playbook.abiozen.com';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlWrap = body => `<div style="font-family:Arial;font-size:14px;line-height:1.6;color:#222;white-space:pre-wrap">${esc(body)}</div>`;

async function callClaude(prompt, { maxTokens = 1200, json = false } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { data: null, text: null, error: 'ANTHROPIC_API_KEY not configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return { data: null, text: null, error: `Claude ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const text = (await res.json()).content?.[0]?.text || '';
    return { data: json ? parseClaudeJSON(text) : null, text };
  } catch (e) { return { data: null, text: null, error: e.message }; }
}
async function getUser(role) {
  const r = (await query(`SELECT id, name, email, whatsapp_number FROM users WHERE is_active=1 AND role=$1 ORDER BY created_at LIMIT 1`, [role])).rows[0];
  return r || null;
}
async function getNaresh() {
  const r = (await query(`SELECT id, name, email, whatsapp_number FROM users WHERE is_active=1 AND role IN ('admin','super_admin') ORDER BY CASE WHEN LOWER(email) LIKE 'naren%' THEN 0 ELSE 1 END, created_at LIMIT 1`)).rows[0];
  return r || { name: 'Naresh', email: 'naren@abiozen.com', whatsapp_number: null };
}

// Best-effort buyer-type classification from company name / email domain.
function classifyBuyer(company, email) {
  const t = `${company || ''} ${email || ''}`.toLowerCase();
  if (/compound|pharmacy|503b/.test(t)) return 'compounding_pharmacy';
  if (/\.edu|univ|college|institute|academ/.test(t)) return 'university';
  if (/pharma|labs?|generic|manufactur|api\b/.test(t)) return 'generic_manufacturer';
  if (/research|bio|lab/.test(t)) return 'research_lab';
  return 'other';
}
async function findPricing(molecule, cas) {
  return (await query(
    `SELECT * FROM molecule_pricing WHERE active=1 AND (LOWER(molecule_name)=LOWER($1) OR (cas_number IS NOT NULL AND cas_number=$2)) LIMIT 1`,
    [molecule || '', cas || null]
  )).rows[0] || null;
}
// Stock availability from the SKU catalog (units on hand + demand trend). SKU
// names carry a purity suffix (e.g. "Semaglutide 99%"), so match on the molecule
// as a name prefix as well as exact.
async function findStock(molecule) {
  if (!molecule || String(molecule).trim().length < 3) return null;
  return (await query(
    `SELECT name, units_in_stock, demand_trend, lead_time_days, is_gmp, sale_price
     FROM skus WHERE is_active=1 AND (LOWER(name)=LOWER($1) OR LOWER(name) LIKE LOWER($1) || '%')
     ORDER BY units_in_stock DESC LIMIT 1`,
    [molecule]
  )).rows[0] || null;
}
// Demand context from the last ~12 weeks of Market Intelligence scans.
async function findDemand(molecule, cas) {
  if (!molecule && !cas) return null;
  const r = (await query(
    `SELECT COUNT(*)::int appearances, MIN(rank) best_rank, MAX(week_start) latest_week,
            MAX(therapeutic_area) therapeutic_area, MAX(estimated_value) est_value
     FROM molecule_history
     WHERE (LOWER(molecule_name)=LOWER($1) OR (cas_number IS NOT NULL AND cas_number=$2))
       AND week_start >= to_char((NOW() - INTERVAL '84 days'), 'YYYY-MM-DD')`,
    [molecule || '', cas || null]
  )).rows[0];
  return (r && r.appearances > 0) ? r : null;
}
// Classify a molecule as a GMP/generic API vs a research chemical, to set the
// response's regulatory framing and tone. Prefers the catalog row's flags; falls
// back to a name heuristic when the molecule isn't priced.
function productType(pricing, molecule) {
  if (pricing) return pricing.gmp_certified ? 'gmp_api' : 'research_chemical';
  const t = String(molecule || '').toLowerCase();
  if (/research grade|\bruo\b|\bcatalyst\b|grubbs|xphos|sphos|phosphine|palladium|pd\(|pt\/|ligand|fmoc-|boc-|cbz-|dicarbonate|malonate|boc2o|reagent|building block/.test(t)) return 'research_chemical';
  return 'gmp_api';
}
async function logMessage(inquiryId, m) {
  await query(
    `INSERT INTO inquiry_messages (id, inquiry_id, direction, sender_name, sender_email, subject, body_text, body_html, sent_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
    [crypto.randomUUID(), inquiryId, m.direction, m.sender_name || null, m.sender_email || null, m.subject || null, m.body_text || null, m.body_html || null]);
}
// ── Professional email template ───────────────────────────────────────────────
const LOGO_URL = 'https://playbook.abiozen.com/abiozen-logo.png';
const productTypeLabelFor = (pricing, molecule) => (productType(pricing, molecule) === 'research_chemical' ? 'Research Chemical' : 'GMP API');
// Shared executive voice for all AI-written inquiry emails.
const VOICE = `Voice: confident, specific, and value-focused — executive pharma, never generic, hedging, or fluffy. Where it reads naturally (never forced or in every email), draw on Abiozen's real proof points: ISO 9001 & ISO 27001 certification, rigorous US-based quality control, and an established APAC manufacturing/sourcing network. Never fabricate specifics or over-promise. End with a brief professional sign-off ("Warm regards,\\nAbiozen Sales Team") — do NOT append a postal address, phone, or company block; the email footer already carries that.`;

// AI plain-text body → styled HTML paragraphs for the {EMAIL_BODY_HTML} slot.
function textToHtml(text) {
  return String(text || '').trim()
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('') || '<p style="margin:0;font-size:15px;line-height:1.65;color:#334155"></p>';
}

// World-class responsive email shell. `bodyHtml` is the message body; `specsTable`
// is an optional full <tr>…</tr> spec block (quotes only).
function renderEmail({ moleculeName, cas, productTypeLabel, bodyHtml, specsTable = '' }) {
  const hero = moleculeName ? `
<!-- Molecule Hero -->
<tr><td style="background:#f8fafc;padding:20px 40px;border-bottom:1px solid #e8edf2">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td><p style="margin:0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">Inquiry Reference</p>
<p style="margin:4px 0 0;font-size:20px;font-weight:700;color:#1B3A6B">${esc(moleculeName)}</p>
<p style="margin:4px 0 0;font-size:13px;color:#64748b">CAS: ${esc(cas || 'To be confirmed')} &nbsp;|&nbsp; ${esc(productTypeLabel || 'GMP API')}</p></td>
<td align="right"><span style="background:#E8F5F0;color:#0D7377;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600">&#10003; Available</span></td>
</tr></table>
</td></tr>` : '';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:30px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">

<!-- Header -->
<tr><td style="background:linear-gradient(135deg,#1B3A6B 0%,#0D7377 100%);padding:32px 40px;text-align:center">
<img src="${LOGO_URL}" alt="Abiozen" height="45" style="display:block;margin:0 auto 12px">
<p style="color:rgba(255,255,255,0.85);font-size:13px;margin:0;letter-spacing:1px;text-transform:uppercase">Pharmaceutical API Marketplace</p>
</td></tr>
${hero}
<!-- Body -->
<tr><td style="padding:32px 40px">
${bodyHtml}
</td></tr>
${specsTable}
<!-- CTA -->
<tr><td style="padding:0 40px 32px;text-align:center">
<a href="mailto:sales@abiozen.com" style="background:linear-gradient(135deg,#1D9E75,#0D7377);color:#ffffff;padding:14px 36px;border-radius:30px;font-size:15px;font-weight:700;text-decoration:none;display:inline-block">Reply to Continue &rarr;</a>
</td></tr>

<!-- Footer -->
<tr><td style="background:#f8fafc;border-top:1px solid #e8edf2;padding:24px 40px">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td><p style="margin:0;font-size:13px;font-weight:600;color:#1B3A6B">Abiozen LLC</p>
<p style="margin:4px 0 0;font-size:12px;color:#64748b">1333 Barclay Blvd, Suite 1333, Buffalo Grove, IL 60089</p>
<p style="margin:4px 0 0;font-size:12px;color:#64748b">sales@abiozen.com | abiozen.com</p></td>
<td align="right">
<p style="margin:0;font-size:11px;color:#94a3b8">ISO 9001 Certified</p>
<p style="margin:2px 0 0;font-size:11px;color:#94a3b8">ISO 27001 Certified</p>
</td>
</tr></table>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// Quotation specs table (a full <tr>…</tr> block placed after the body).
function buildSpecsTable({ molecule, cas, grade, purity, quantity, unitPrice, leadTime, docs, total }) {
  const money = n => '$' + Number(n || 0).toLocaleString();
  return `
<!-- Specs Table -->
<tr><td style="padding:0 40px 24px">
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8edf2;border-radius:8px;overflow:hidden">
<tr style="background:#1B3A6B"><td style="padding:10px 16px;color:#fff;font-size:12px;font-weight:600">SPECIFICATION</td><td style="padding:10px 16px;color:#fff;font-size:12px;font-weight:600">DETAILS</td></tr>
<tr style="background:#f8fafc"><td style="padding:10px 16px;font-size:13px;color:#64748b">Molecule</td><td style="padding:10px 16px;font-size:13px;font-weight:600;color:#1B3A6B">${esc(molecule)}</td></tr>
<tr><td style="padding:10px 16px;font-size:13px;color:#64748b">CAS Number</td><td style="padding:10px 16px;font-size:13px;color:#333">${esc(cas || 'To be confirmed')}</td></tr>
<tr style="background:#f8fafc"><td style="padding:10px 16px;font-size:13px;color:#64748b">Grade</td><td style="padding:10px 16px;font-size:13px;color:#333">${esc(grade)}</td></tr>
<tr><td style="padding:10px 16px;font-size:13px;color:#64748b">Purity</td><td style="padding:10px 16px;font-size:13px;color:#333">${esc(purity)}</td></tr>
<tr style="background:#f8fafc"><td style="padding:10px 16px;font-size:13px;color:#64748b">Quantity</td><td style="padding:10px 16px;font-size:13px;color:#333">${esc(quantity)}</td></tr>
<tr><td style="padding:10px 16px;font-size:13px;color:#64748b">Unit Price</td><td style="padding:10px 16px;font-size:13px;font-weight:700;color:#1D9E75">${money(unitPrice)}/kg</td></tr>
<tr style="background:#f8fafc"><td style="padding:10px 16px;font-size:13px;color:#64748b">Lead Time</td><td style="padding:10px 16px;font-size:13px;color:#333">${esc(leadTime)} days</td></tr>
<tr><td style="padding:10px 16px;font-size:13px;color:#64748b">Documentation</td><td style="padding:10px 16px;font-size:13px;color:#333">${esc(docs)}</td></tr>
<tr style="background:#E8F5F0"><td style="padding:12px 16px;font-size:14px;font-weight:700;color:#1B3A6B">Total Estimate</td><td style="padding:12px 16px;font-size:14px;font-weight:700;color:#1D9E75">${money(total)}</td></tr>
</table>
</td></tr>`;
}

async function sendAndLog(inquiry, { subject, body, cc, specsTable = '', productTypeLabel } = {}) {
  if (!productTypeLabel) {
    const p = await findPricing(inquiry.molecule_name, inquiry.cas_number);
    productTypeLabel = productTypeLabelFor(p, inquiry.molecule_name);
  }
  const html = renderEmail({
    moleculeName: inquiry.molecule_name, cas: inquiry.cas_number,
    productTypeLabel, bodyHtml: textToHtml(body), specsTable,
  });
  const ok = await sendEmail({ to: inquiry.buyer_email, subject, html, from: SALES_FROM, replyTo: 'sales@abiozen.com', cc });
  await logMessage(inquiry.id, { direction: 'outbound', sender_name: 'Abiozen Sales', sender_email: 'sales@abiozen.com', subject, body_text: body, body_html: html });
  await query(`UPDATE inquiries SET total_emails_sent=COALESCE(total_emails_sent,0)+1, last_email_at=NOW(), updated_at=NOW() WHERE id=$1`, [inquiry.id]);
  return ok;
}

// ── Function 1 — receive an inquiry ───────────────────────────────────────────
async function receiveInquiry(data) {
  const molecule = data.molecule_name || null;
  const pricing = await findPricing(molecule, data.cas_number);
  const buyerType = data.buyer_type || classifyBuyer(data.buyer_company, data.buyer_email);
  const qty = Number(data.quantity) || null;
  const unit = data.quantity_unit === 'kg' ? 'kg' : 'g';
  const qtyKg = qty ? (unit === 'kg' ? qty : qty / 1000) : null;
  const isHot = /semaglutide|tirzepatide|liraglutide|glp|osimertinib|ibrutinib|lenalidomide|abiraterone|onco/i.test(molecule || '') || (qtyKg && qtyKg > 1);
  const priority = isHot ? 'high' : 'medium';

  const id = crypto.randomUUID();
  await query(
    `INSERT INTO inquiries (id, molecule_name, cas_number, buyer_name, buyer_email, buyer_company, buyer_type,
       country, intended_use, quantity_requested, quantity_unit, status, priority, source, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new',$12,$13,NOW(),NOW())`,
    [id, molecule, data.cas_number || pricing?.cas_number || null, data.buyer_name || null, data.buyer_email || null,
     data.buyer_company || null, buyerType, data.country || null, data.intended_use || null, qty, unit,
     priority, ['abiozen_form', 'email', 'apollo', 'manual'].includes(data.source) ? data.source : 'abiozen_form']);

  // Log the buyer's inbound message (the form message).
  if (data.message) await logMessage(id, { direction: 'inbound', sender_name: data.buyer_name, sender_email: data.buyer_email, subject: `Inquiry: ${molecule || 'GMP API'}`, body_text: data.message });

  // Immediate first response (satisfies the "within 5 minutes" SLA).
  const inquiry = (await query('SELECT * FROM inquiries WHERE id=$1', [id])).rows[0];
  await sendFirstResponse(id).catch(e => console.error('[inquiry] first response failed:', e.message));

  // WhatsApp Naresh.
  const naresh = await getNaresh();
  if (naresh.whatsapp_number) {
    await sendWhatsApp(naresh.whatsapp_number,
      `📩 New inquiry: ${data.buyer_name || 'Buyer'} at ${data.buyer_company || '?'} for ${molecule || 'a molecule'} — ${qty ? qty + unit : 'qty TBD'}`,
      { user_id: naresh.id || null, message_type: 'inquiry' }).catch(() => {});
  }
  await logAgentActivity({ agent_name: AGENT, action_type: 'inquiry_received', user_id: null,
    reasoning: `New inquiry from ${data.buyer_company || data.buyer_email} for ${molecule} (${priority}).`,
    source_kpi: 'kpi-sg-sales', output_summary: `inquiry=${id} molecule=${molecule} priority=${priority}` }).catch(() => {});
  return id;
}

// ── Function 2 — first response ───────────────────────────────────────────────
async function sendFirstResponse(inquiryId) {
  const inq = (await query('SELECT * FROM inquiries WHERE id=$1', [inquiryId])).rows[0];
  if (!inq) return { error: 'inquiry not found' };
  const pricing = await findPricing(inq.molecule_name, inq.cas_number);
  const stock = await findStock(inq.molecule_name);
  const demand = await findDemand(inq.molecule_name, inq.cas_number);
  const type = productType(pricing, inq.molecule_name);
  const isResearch = type === 'research_chemical';
  const purity = pricing?.purity || '98%+';
  const priceLine = pricing ? `${pricing.price_per_kg_usd >= 1000 ? '$' + Number(pricing.price_per_kg_usd).toLocaleString() : '$' + pricing.price_per_kg_usd}/kg` : 'available on request';
  const lead = pricing?.lead_time_days || (isResearch ? 10 : 30);
  const stockLine = stock && stock.units_in_stock > 0
    ? `Stock: we currently hold ${stock.units_in_stock} unit(s) on hand — delivery can be faster than the standard lead time.`
    : `Stock: this is sourced/produced to order — the standard lead time applies.`;
  const demandLine = demand
    ? `Internal demand signal (context only, not for the buyer's eyes): this molecule appeared in ${demand.appearances} recent market-intelligence scan(s)${demand.best_rank ? `, best rank ${demand.best_rank}` : ''}${demand.therapeutic_area ? `, area ${demand.therapeutic_area}` : ''}. Demand is active — you MAY convey a sense that quality supply is in demand, but do NOT fabricate specific scarcity figures or deadlines.`
    : `Internal demand signal: none tracked for this molecule.`;
  const productLine = isResearch
    ? `Product type: RESEARCH CHEMICAL (research/analytical use only, non-GMP). We supply it at ${purity} purity with COA and SDS.`
    : `Product type: GMP / generic pharmaceutical API. We supply it GMP-grade${pricing ? `, ${pricing.dmf_available ? 'DMF available' : 'DMF/CEP on request'}` : ''}, with COA and GMP documentation.`;
  const askBlock = isResearch
    ? `research application; required purity and whether a COA + SDS suffice; quantity and delivery timeline; destination country; whether they'd like a small evaluation quantity first`
    : `intended use (compounding/research/manufacturing); required documentation (USP/EP grade, GMP cert, DMF/CEP, COA format, ICH stability data); delivery timeline; destination country (export compliance); whether they need a 1-5 g evaluation sample first`;
  const toneLine = isResearch
    ? `Tone: efficient, technical, collegial — an academic/R&D audience. Do NOT mention GMP, DMF, CEP or regulatory filings (this is research-use-only). Small quantities (mg-g scale) are welcome and turnaround is quick.`
    : `Tone: formal, professional pharma — a regulatory/procurement audience. Referencing GMP, DMF/CEP and ICH compliance is appropriate.`;
  const prompt = `Write a professional first-response email for a chemical/API inquiry from Abiozen LLC.

Buyer: ${inq.buyer_name || 'there'} at ${inq.buyer_company || 'your organization'}
Molecule: ${inq.molecule_name} (CAS: ${inq.cas_number || 'to confirm'})
Quantity requested: ${inq.quantity_requested ? inq.quantity_requested + inq.quantity_unit : 'to confirm'}
${productLine}
Pricing starts at ${priceLine}. Standard lead time ${lead} days.
${stockLine}
${demandLine}

Write an email that:
1. Acknowledges their inquiry warmly and professionally
2. Confirms availability and the grade we supply (${isResearch ? `research grade, ${purity}, with COA + SDS` : 'GMP grade, with COA + GMP documentation'})
3. Asks these qualifying questions naturally: ${askBlock}
4. Sets delivery expectations from the Stock line above (faster if in stock, otherwise the standard lead time of ${lead} days) — state it honestly, do not promise stock we don't have
5. ${toneLine} Under 200 words.
${VOICE}
Do not commit to a specific final price or a documentation guarantee you cannot verify — keep pricing as "starting at". Return ONLY the email body as plain text.`;
  const { text, error } = await callClaude(prompt, { maxTokens: 900 });
  if (!text) return { error: error || 'no body' };
  const subject = `Re: Inquiry — ${inq.molecule_name} | Abiozen LLC`;
  await sendAndLog(inq, { subject, body: text, productTypeLabel: isResearch ? 'Research Chemical' : 'GMP API' });
  await query(`UPDATE inquiries SET status='in_conversation', updated_at=NOW() WHERE id=$1 AND status='new'`, [inquiryId]);
  return { sent: true };
}

// ── Function 3 — process an inbound reply ─────────────────────────────────────
async function processInboundReply(inquiryId, emailText, { dryRun = false } = {}) {
  const inq = (await query('SELECT * FROM inquiries WHERE id=$1', [inquiryId])).rows[0];
  if (!inq) return { error: 'inquiry not found' };
  if (!dryRun) await logMessage(inquiryId, { direction: 'inbound', sender_name: inq.buyer_name, sender_email: inq.buyer_email, subject: `Re: ${inq.molecule_name}`, body_text: emailText });

  const history = (await query('SELECT direction, body_text FROM inquiry_messages WHERE inquiry_id=$1 ORDER BY created_at', [inquiryId])).rows
    .map(m => `[${m.direction}] ${String(m.body_text || '').slice(0, 500)}`).join('\n');
  const pricing = await findPricing(inq.molecule_name, inq.cas_number);
  const isResearch = productType(pricing, inq.molecule_name) === 'research_chemical';
  const supplyLine = isResearch
    ? `We supply this as a RESEARCH CHEMICAL (research-use-only, non-GMP)${pricing ? `, ${pricing.purity || '98%+'} purity, COA + SDS, price starting ~$${pricing.price_per_kg_usd}/kg, lead ${pricing.lead_time_days}d` : ', COA + SDS available'}. Do NOT reference GMP/DMF/CEP for this product.`
    : `We supply this GMP-grade${pricing ? `, price starting ~$${pricing.price_per_kg_usd}/kg, lead ${pricing.lead_time_days}d, DMF ${pricing.dmf_available ? 'available' : 'on request'}` : ''}.`;
  const { data } = await callClaude(
    `You are the Abiozen sales agent handling an email inquiry for ${inq.molecule_name}. Analyse the buyer's latest reply and the thread, then decide the next step. Match the buyer's context: ${isResearch ? 'research/academic, technical tone' : 'pharma procurement, regulatory tone'}.

Thread:
${history}

Buyer's latest reply:
"""${String(emailText).slice(0, 3000)}"""

${supplyLine}

${VOICE}

Return ONLY JSON:
{"intent":"ready_for_quote|needs_human|still_qualifying","reason":"one line","reply_body":"the email body to send them next, written in the Voice above — answer their questions using ONLY facts stated above; do not invent prices/docs; if quoting is next, keep it brief and say a formal quote follows"}`,
    { maxTokens: 1200, json: true });
  const intent = data?.intent || 'still_qualifying';
  const replyBody = data?.reply_body || 'Thank you for your reply — a member of our team will follow up shortly.';

  let action = intent;
  if (dryRun) return { intent, reason: data?.reason, reply_preview: replyBody.slice(0, 300) };

  if (intent === 'needs_human') {
    await escalateToHuman(inquiryId, data?.reason || 'buyer requested a human');
    action = 'escalated';
  } else if (intent === 'ready_for_quote') {
    await sendAndLog(inq, { subject: `Re: Inquiry — ${inq.molecule_name}`, body: replyBody, productTypeLabel: isResearch ? 'Research Chemical' : 'GMP API' });
    await generateQuote(inquiryId);
    action = 'quoted';
  } else {
    await sendAndLog(inq, { subject: `Re: Inquiry — ${inq.molecule_name}`, body: replyBody, productTypeLabel: isResearch ? 'Research Chemical' : 'GMP API' });
    await query(`UPDATE inquiries SET status='in_conversation', updated_at=NOW() WHERE id=$1`, [inquiryId]);
  }
  await logAgentActivity({ agent_name: AGENT, action_type: 'inquiry_reply_handled', user_id: null,
    reasoning: `Handled reply on inquiry ${inquiryId}: ${action}.`, source_kpi: 'kpi-sg-sales', output_summary: `inquiry=${inquiryId} action=${action}` }).catch(() => {});
  return { intent, action };
}

// ── Function 4 — generate + send a formal quote ───────────────────────────────
async function generateQuote(inquiryId) {
  const inq = (await query('SELECT * FROM inquiries WHERE id=$1', [inquiryId])).rows[0];
  if (!inq) return { error: 'inquiry not found' };
  const pricing = await findPricing(inq.molecule_name, inq.cas_number);
  if (!pricing) return { error: 'no pricing for this molecule' };

  const qty = Number(inq.quantity_requested) || (pricing.min_quantity_g || 1000) / 1000;
  const qtyKg = inq.quantity_unit === 'kg' ? qty : qty / 1000;
  const grams = qtyKg * 1000;
  // Quantity discount tiers.
  let mult = 1, tier = 'small';
  let needsApproval = false;
  if (grams <= 10) { mult = 1.5; tier = 'sample'; }
  else if (grams <= 100) { mult = 1.0; tier = 'small'; }
  else if (grams < 1000) { mult = 0.9; tier = 'medium'; }
  else { mult = 0.85; tier = 'bulk'; if (qtyKg > 10) needsApproval = true; }
  const unitPrice = Math.round(Number(pricing.price_per_kg_usd) * mult);
  const apiTotal = Math.round(unitPrice * qtyKg);
  const total = apiTotal + DOC_FEE;
  const validUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const quoteId = crypto.randomUUID();
  await query(
    `INSERT INTO inquiry_quotes (id, inquiry_id, molecule_name, cas_number, quantity_kg, unit_price_usd,
       total_price_usd, lead_time_days, valid_until_date, gmp_docs_included, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'sent',NOW())`,
    [quoteId, inquiryId, inq.molecule_name, inq.cas_number, qtyKg, unitPrice, total, pricing.lead_time_days, validUntil]);

  const isResearch = productType(pricing, inq.molecule_name) === 'research_chemical';
  const gradeLabel = isResearch ? `research grade, ${pricing.purity || '98%+'}` : 'GMP grade';
  const docsLine = isResearch ? 'COA + SDS' : `COA + GMP cert (DMF/CEP ${pricing.dmf_available ? 'available' : 'on request'})`;
  const signatory = isResearch
    ? 'Warm regards,\nAbiozen Sales Team'
    : 'Palash Das\nProcurement Director, Abiozen LLC\npalash@abiozen.com';
  const prompt = `Write the COVER NOTE for a formal ${isResearch ? 'research-chemical' : 'pharmaceutical API'} quotation from Abiozen LLC. A full specification & pricing TABLE is rendered directly below your text, so do NOT re-list every line item or repeat all the numbers. Return ONLY the cover-note body as plain text (no subject).

Context (shown in the table below your note):
Buyer: ${inq.buyer_name || (isResearch ? 'Research Team' : 'Procurement Team')} at ${inq.buyer_company || 'the buyer'}
Molecule: ${inq.molecule_name} (CAS ${inq.cas_number || 'to confirm'}), ${gradeLabel}
Quantity ${qtyKg} kg · Unit price $${unitPrice.toLocaleString()}/kg · Total $${total.toLocaleString()} (shipping TBD by destination) · Lead time ${pricing.lead_time_days} days · Valid until ${validUntil}
${isResearch ? 'RESEARCH CHEMICAL (research-use-only) — do NOT reference GMP, DMF, CEP or ICH.' : 'GMP API — referencing GMP documentation and DMF/CEP is appropriate.'}

Write a concise, confident cover note (120-160 words) that greets the buyer, presents the quotation and points them to the specification table below, states payment terms (50% advance, 50% before shipment), notes shipping is quoted separately by destination, and includes a bank-details placeholder line "[Bank wire details provided on order confirmation]" (do NOT invent bank numbers).
${VOICE}
End with:

${signatory}`;
  const { text } = await callClaude(prompt, { maxTokens: 1200 });
  const body = text || `Dear ${inq.buyer_name || 'Buyer'},\n\nPlease find our quotation for ${inq.molecule_name} (${qtyKg} kg) in the specification table below. Total estimate $${total.toLocaleString()}, valid until ${validUntil}. Payment terms: 50% advance, 50% before shipment; shipping is quoted separately by destination.\n[Bank wire details provided on order confirmation]\n\n${signatory}`;
  const specsTable = buildSpecsTable({
    molecule: inq.molecule_name, cas: inq.cas_number, grade: gradeLabel,
    purity: pricing.purity || '98%+', quantity: `${qtyKg} kg`, unitPrice,
    leadTime: pricing.lead_time_days, docs: docsLine, total,
  });
  const subject = `Quotation — ${inq.molecule_name} (${qtyKg}kg) | Abiozen LLC`;
  await sendAndLog(inq, { subject, body, specsTable, productTypeLabel: isResearch ? 'Research Chemical' : 'GMP API', cc: isResearch ? ['naren@abiozen.com'] : ['palash@abiozen.com', 'naren@abiozen.com'] });
  await query(`UPDATE inquiries SET status='quote_sent', order_value_usd=$1, updated_at=NOW() WHERE id=$2`, [total, inquiryId]);

  if (needsApproval || total > ESCALATE_ABOVE) {
    const naresh = await getNaresh();
    if (naresh.whatsapp_number) await sendWhatsApp(naresh.whatsapp_number,
      `💰 Large quote sent: ${inq.buyer_company || inq.buyer_email} — ${inq.molecule_name} ${qtyKg}kg = $${total.toLocaleString()}${needsApproval ? ' (>10kg — review pricing)' : ''}`,
      { user_id: naresh.id || null, message_type: 'large_quote' }).catch(() => {});
  }
  return { quote_id: quoteId, unit_price: unitPrice, total, tier, needs_approval: needsApproval };
}

// ── Function 5 — escalate to a human ──────────────────────────────────────────
async function escalateToHuman(inquiryId, reason = 'buyer requested a human') {
  const inq = (await query('SELECT * FROM inquiries WHERE id=$1', [inquiryId])).rows[0];
  if (!inq) return { error: 'inquiry not found' };
  await query(`UPDATE inquiries SET status='human_requested', updated_at=NOW() WHERE id=$1`, [inquiryId]);
  const value = inq.order_value_usd || 0;
  const naresh = await getNaresh();
  if (naresh.whatsapp_number) await sendWhatsApp(naresh.whatsapp_number,
    `🚨 URGENT: Inquiry escalated to human — ${inq.buyer_name || 'Buyer'} at ${inq.buyer_company || '?'} for ${inq.molecule_name} — Est. value: $${Number(value).toLocaleString()}. Reason: ${reason}`,
    { user_id: naresh.id || null, message_type: 'inquiry_escalation' }).catch(() => {});

  // Full conversation to Palash.
  const msgs = (await query('SELECT direction, sender_name, body_text, created_at FROM inquiry_messages WHERE inquiry_id=$1 ORDER BY created_at', [inquiryId])).rows;
  const thread = msgs.map(m => `<div style="margin:8px 0;padding:8px;background:${m.direction === 'inbound' ? '#eff6ff' : '#f8fafc'};border-radius:6px"><strong>${m.direction === 'inbound' ? '⬅ ' + esc(m.sender_name || 'Buyer') : '➡ Abiozen'}</strong><div style="font-size:12px;white-space:pre-wrap;margin-top:4px">${esc(String(m.body_text || '').slice(0, 1500))}</div></div>`).join('');
  const palash = await getUser('procurement_director');
  if (palash) await sendEmail({ to: palash.email, cc: 'naren@abiozen.com',
    subject: `Escalated GMP inquiry — ${inq.buyer_company || inq.buyer_email} — ${inq.molecule_name}`,
    html: `<div style="font-family:Arial;max-width:680px"><h2 style="color:#991B1B">Inquiry escalated to human</h2>
      <p style="font-size:14px"><strong>Buyer:</strong> ${esc(inq.buyer_name)} at ${esc(inq.buyer_company)} (${esc(inq.buyer_email)})<br>
      <strong>Molecule:</strong> ${esc(inq.molecule_name)} · <strong>Qty:</strong> ${esc(inq.quantity_requested)}${esc(inq.quantity_unit)} · <strong>Est. value:</strong> $${Number(value).toLocaleString()}<br>
      <strong>Reason:</strong> ${esc(reason)}</p>
      <h3 style="color:#1B3A6B">Conversation</h3>${thread}
      <p style="margin-top:12px"><a href="${BASE_URL()}/#inquiry-agent" style="background:#0D7377;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open Inquiry Agent →</a></p></div>` }).catch(() => {});

  // Reassure the buyer.
  await sendAndLog(inq, { subject: `Re: Inquiry — ${inq.molecule_name}`,
    body: `Thank you for your message. I'm connecting you with one of our specialists who will personally follow up on your ${inq.molecule_name} requirement within 24 hours.\n\nWe appreciate your interest in working with Abiozen.\n\nWarm regards,\nAbiozen Sales Team` });
  await logAgentActivity({ agent_name: AGENT, action_type: 'inquiry_escalated', user_id: null, reasoning: `Escalated inquiry ${inquiryId}: ${reason}.`, source_kpi: 'kpi-sg-sales', output_summary: `inquiry=${inquiryId}` }).catch(() => {});
  return { escalated: true };
}

// ── Function 6 — timed follow-ups ─────────────────────────────────────────────
async function handleFollowUp(inquiry) {
  if (!inquiry.last_email_at) return null;
  const days = Math.floor((Date.now() - new Date(inquiry.last_email_at).getTime()) / 86400000);
  const sent = inquiry.total_emails_sent || 0;
  // Only chase inquiries still open and awaiting the buyer.
  if (!['in_conversation', 'quote_sent'].includes(inquiry.status)) return null;
  let stage = null;
  if (days >= 21) { await query(`UPDATE inquiries SET status='closed', updated_at=NOW() WHERE id=$1`, [inquiry.id]); return { inquiry: inquiry.id, action: 'closed_inactive' }; }
  else if (days >= 14 && sent < 4) stage = ['final', `Are you still looking for ${inquiry.molecule_name}? If your requirement has changed we'll close this out, but we're glad to help whenever you're ready.`];
  else if (days >= 7 && sent < 3) stage = ['value', `Following up on ${inquiry.molecule_name} — demand for this molecule remains steady, so I wanted to keep your quote current. Happy to refresh pricing or documentation details whenever it's useful.`];
  else if (days >= 3 && sent < 2) stage = ['gentle', `Just checking that you received our response on ${inquiry.molecule_name}. I'm here if you have any questions on grade, documentation, or lead time.`];
  if (!stage) return null;
  await sendAndLog(inquiry, { subject: `Re: Inquiry — ${inquiry.molecule_name}`, body: `Hi ${inquiry.buyer_name || 'there'},\n\n${stage[1]}\n\nWarm regards,\nAbiozen Sales Team` });
  return { inquiry: inquiry.id, action: 'follow_up_' + stage[0] };
}

// ── Function 7 — daily orchestration ──────────────────────────────────────────
async function runInquiryAgent({ dryRun = false } = {}) {
  const open = (await query(`SELECT * FROM inquiries WHERE status IN ('in_conversation','quote_sent')`)).rows;
  const out = { active_inquiries: 0, follow_ups_sent: 0, closed: 0, quotes_week: 0, orders: 0, escalations: 0, errors: [] };
  for (const inq of open) {
    try {
      if (!dryRun) {
        const r = await handleFollowUp(inq);
        if (r?.action === 'closed_inactive') out.closed++;
        else if (r?.action?.startsWith('follow_up')) out.follow_ups_sent++;
      }
    } catch (e) { out.errors.push(`${inq.id}: ${e.message}`); }
  }
  const stats = (await query(`SELECT
      COUNT(*) FILTER (WHERE status IN ('new','in_conversation','quote_sent','human_requested'))::int active,
      COUNT(*) FILTER (WHERE status='human_requested')::int escalations,
      COUNT(*) FILTER (WHERE status='order_placed')::int orders FROM inquiries`)).rows[0];
  out.active_inquiries = stats.active; out.escalations = stats.escalations; out.orders = stats.orders;
  out.quotes_week = (await query(`SELECT COUNT(*)::int c FROM inquiry_quotes WHERE created_at >= (NOW() - INTERVAL '7 days')::text`)).rows[0].c;

  if (!dryRun) {
    const naresh = await getNaresh();
    await sendEmail({ to: naresh.email, subject: `GMP Inquiry Agent — daily summary`,
      html: `<div style="font-family:Arial;max-width:560px"><h2 style="color:#1B3A6B">Inquiry Agent — daily summary</h2>
        <ul style="font-size:14px;line-height:1.7">
          <li><strong>${out.active_inquiries}</strong> active inquiries</li>
          <li><strong>${out.quotes_week}</strong> quotes sent this week</li>
          <li><strong>${out.orders}</strong> orders placed</li>
          <li><strong>${out.escalations}</strong> awaiting human</li>
          <li>${out.follow_ups_sent} follow-ups sent, ${out.closed} closed inactive today</li>
        </ul><p><a href="${BASE_URL()}/#inquiry-agent" style="background:#0D7377;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open Inquiry Agent →</a></p></div>` }).catch(e => out.errors.push('email: ' + e.message));
    await logAgentActivity({ agent_name: AGENT, action_type: 'inquiry_agent_run', reasoning: `${out.active_inquiries} active, ${out.follow_ups_sent} follow-ups, ${out.closed} closed.`, source_kpi: 'kpi-sg-sales', output_summary: `active=${out.active_inquiries} followups=${out.follow_ups_sent}` }).catch(() => {});
  }
  return out;
}

// ── Function 8 — poll the sales mailbox for new inquiry emails ────────────────
// Reads UNREAD, inquiry-like messages at sales@abiozen.com via the Gmail REST
// API (same Google OAuth refresh-token flow as GSC/Meet), extracts buyer +
// molecule + quantity with Claude, and either opens a new inquiry (auto-sends
// the AI first response) or routes a reply from a known buyer into its existing
// conversation. Degrades gracefully: the shared GOOGLE_REFRESH_TOKEN is
// GSC-scoped, so Gmail may 401/403 for lack of scope — then it returns a warning
// and never throws.
// Matched client-side (substring, case-insensitive) so multi-word phrases and
// the "Contact Form: …" subject the abiozen contact form sends both match.
const INQUIRY_SUBJECT_KEYWORDS = [
  'quote', 'quote request', 'inquiry', 'enquiry', 'rfq', 'request', 'api', 'molecule',
  'contact', 'product', 'form', 'submission', 'new message', 'message', 'pricing', 'sample', 'order',
];
// Gmail API userId: 'me' resolves to the impersonated mailbox (sales@abiozen.com).
const GMAIL_USER = () => process.env.SALES_GMAIL_USER || 'me';
const SALES_MAILBOX = () => process.env.SALES_MAILBOX_EMAIL || 'sales@abiozen.com';

// Service-account token (DWD, impersonating the sales mailbox) with refresh-token
// fallback. Needs gmail.readonly (read) + gmail.modify (mark read).
async function getGoogleAccessToken() {
  return getGoogleToken({ subject: SALES_MAILBOX(), scopes: [SCOPES.gmailReadonly, SCOPES.gmailModify] });
}
function b64urlDecode(d) { return Buffer.from(String(d || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
function gmailHeader(payload, name) {
  const h = (payload?.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}
function extractGmailBody(payload) {
  const walk = p => {
    if (!p) return '';
    if (p.mimeType === 'text/plain' && p.body?.data) return b64urlDecode(p.body.data);
    if (p.parts) { for (const sub of p.parts) { const t = walk(sub); if (t) return t; } }
    if (p.mimeType === 'text/html' && p.body?.data) return b64urlDecode(p.body.data).replace(/<[^>]+>/g, ' ');
    if (p.body?.data) return b64urlDecode(p.body.data);
    return '';
  };
  return String(walk(payload) || '').replace(/\r/g, '').slice(0, 8000);
}
function parseFromHeader(v) {
  if (!v) return { name: null, email: null };
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: (m[1] || '').trim() || null, email: m[2].trim().toLowerCase() };
  const e = v.match(/([^\s<]+@[^\s>]+)/);
  return { name: null, email: e ? e[1].trim().toLowerCase() : v.trim().toLowerCase() };
}
// Find the open inquiry an inbound email is a reply to: first by Gmail thread (a
// prior processed message in the same thread already mapped to an inquiry), then
// by From/Reply-To address matching an open inquiry's buyer_email.
const OPEN_STATUSES = "('new','in_conversation','quote_sent','human_requested')";
async function matchReplyInquiry(candidateEmails, threadId) {
  if (threadId) {
    const t = (await query(
      `SELECT i.id FROM processed_emails p JOIN inquiries i ON i.id=p.inquiry_id
       WHERE p.thread_id=$1 AND p.inquiry_id IS NOT NULL AND i.status IN ${OPEN_STATUSES}
       ORDER BY p.processed_at DESC LIMIT 1`, [threadId])).rows[0];
    if (t) return t.id;
  }
  for (const em of (candidateEmails || [])) {
    const r = (await query(
      `SELECT id FROM inquiries WHERE LOWER(buyer_email)=LOWER($1) AND status IN ${OPEN_STATUSES} ORDER BY created_at DESC LIMIT 1`,
      [em])).rows[0];
    if (r) return r.id;
  }
  return null;
}

async function pollSalesEmailbox({ dryRun = false, maxMessages = 40 } = {}) {
  const out = {
    listed: 0, checked: 0, new_inquiries: 0, replies_routed: 0,
    skipped_seen: 0, skipped_subject: 0, skipped_internal: 0, skipped_no_sender: 0,
    skipped_not_inquiry: 0, skipped_no_buyer: 0, skipped: 0, samples: [], errors: [],
  };
  const tok = await getGoogleAccessToken();
  if (tok.error) {
    out.warning = `Gmail poll skipped — ${tok.error}. Check the service account (DWD) can impersonate ${SALES_MAILBOX()}.`;
    await pollLog(out, dryRun); return out;
  }

  const user = encodeURIComponent(GMAIL_USER());
  // Fetch recent unread and filter subjects CLIENT-SIDE: multi-word keywords match
  // by substring, and empty-subject emails are still processed (a server-side
  // subject: query would exclude them and tokenize awkwardly).
  const q = encodeURIComponent('is:unread newer_than:7d');
  let list;
  try {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${user}/messages?q=${q}&maxResults=${maxMessages}`, { headers: { Authorization: 'Bearer ' + tok.access_token } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      out.warning = `Gmail list ${res.status}: ${body}. Check the Gmail API is enabled in the service account's Cloud project and that DWD can impersonate ${SALES_MAILBOX()}.`;
      await pollLog(out, dryRun); return out;
    }
    list = await res.json();
  } catch (e) { out.errors.push('list: ' + e.message); await pollLog(out, dryRun); return out; }

  const msgRefs = list.messages || [];
  out.listed = msgRefs.length;
  const sample = (subject, from, decision) => { if (out.samples.length < 12) out.samples.push({ subject: (subject || '(no subject)').slice(0, 60), from: from || '?', decision }); };

  for (const mref of msgRefs) {
    const gmailId = mref.id;
    const threadId = mref.threadId || null;
    try {
      // Idempotency: claim each id once (at-most-once), recording its Gmail thread
      // so later messages in the thread route to the same inquiry. Already-seen →
      // skip cheaply. Skips below stay claimed (not re-processed) but unread.
      if (!dryRun) {
        const claimed = await query(`INSERT INTO processed_emails (id, source, thread_id, processed_at) VALUES ($1,'gmail',$2,NOW()) ON CONFLICT (id) DO NOTHING RETURNING id`, [gmailId, threadId]);
        if (!claimed.rows.length) { out.skipped_seen++; continue; }
      }
      out.checked++;
      const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${user}/messages/${gmailId}?format=full`, { headers: { Authorization: 'Bearer ' + tok.access_token } });
      if (!detailRes.ok) { out.errors.push(`${gmailId}: get ${detailRes.status}`); continue; }
      const msg = await detailRes.json();
      const subject = gmailHeader(msg.payload, 'Subject');
      const from = parseFromHeader(gmailHeader(msg.payload, 'From'));
      const replyTo = parseFromHeader(gmailHeader(msg.payload, 'Reply-To'));
      const body = extractGmailBody(msg.payload) || msg.snippet || '';

      // REPLY DETECTION — runs BEFORE the subject filter, because a known buyer
      // replying is always relevant whatever the subject line reads. Matches on the
      // Gmail thread, then the From / Reply-To address vs an open inquiry.
      const candidateEmails = [from.email, replyTo.email].filter(e => e && !/@abiozen\.com$/i.test(e));
      const replyInquiryId = await matchReplyInquiry(candidateEmails, threadId);
      if (replyInquiryId) {
        if (dryRun) { out.replies_routed++; sample(subject, candidateEmails[0] || from.email, 'reply(dry)'); continue; }
        await processInboundReply(replyInquiryId, `Subject: ${subject}\n\n${body}`);
        await query(`UPDATE processed_emails SET inquiry_id=$1 WHERE id=$2`, [replyInquiryId, gmailId]).catch(() => {});
        out.replies_routed++; sample(subject, candidateEmails[0] || from.email, 'reply');
        await markGmailRead(user, gmailId, tok.access_token, dryRun);
        continue;
      }

      // Subject filter (non-replies only): keep if empty/None OR contains a keyword.
      // A non-matching subject is inbox spam/noise — mark it read (after logging the
      // sample) so it leaves the unread window and doesn't crowd out real RFQs.
      const subjLower = String(subject || '').toLowerCase();
      const subjEmpty = !subject || !subject.trim();
      if (!subjEmpty && !INQUIRY_SUBJECT_KEYWORDS.some(k => subjLower.includes(k))) {
        out.skipped_subject++; sample(subject, from.email, 'skip:subject-no-keyword');
        await markGmailRead(user, gmailId, tok.access_token, dryRun);
        continue;
      }
      if (!from.email) { out.skipped_no_sender++; sample(subject, null, 'skip:no-sender'); continue; }

      // Relay detection (contact-form/website): the buyer is in the BODY, not From.
      const internal = /@abiozen\.com$/i.test(from.email);
      const relaySender = /^(noreply|no-reply|do-not-reply|contact|mailer|forms?|website|wordpress|notifications?|hello|info)@/i.test(from.email);
      const contactFormBody = /inquiry type\s*:/i.test(body) || (/\bname\s*:/i.test(body) && /\bemail\s*:\s*[^\s@]+@[^\s]+/i.test(body));
      const isRelay = relaySender || contactFormBody;
      if (internal && !isRelay) { out.skipped_internal++; sample(subject, from.email, 'skip:internal'); continue; }

      const { data } = await callClaude(
        `Extract structured fields from this inbound sales email to a chemical/API supplier (Abiozen). The product may be a RESEARCH CHEMICAL or a PHARMACEUTICAL API — both are valid inquiries.

From header: ${gmailHeader(msg.payload, 'From')}
Subject: ${subject || '(no subject)'}
Body:
"""${body.slice(0, 4000)}"""

This may be a RELAYED contact-form/website email — if the From is a system address (noreply@, contact@, an abiozen.com address) or the body contains "Inquiry Type:", "Name:", "Email:" lines, the REAL buyer's name and email are IN THE BODY; extract those. Never use an @abiozen.com address as the buyer.

Return ONLY JSON:
{"is_inquiry": true, "buyer_name": "buyer's name or null", "buyer_email": "the buyer's own email (from the body for relays, else the From address); never an @abiozen.com address", "buyer_company": "company or null", "molecule_name": "the molecule/chemical/API they want, or null", "cas_number": "if stated else null", "quantity": number or null, "quantity_unit": "g|kg", "intended_use": "research|compounding|manufacturing|null", "country": "if stated else null", "message": "one-line summary of the request"}
Set "is_inquiry": false ONLY if this is clearly NOT a buyer inquiry (newsletter, auto-reply, spam, internal notice).`,
        { maxTokens: 700, json: true });

      if (!data || data.is_inquiry === false) { out.skipped_not_inquiry++; sample(subject, from.email, 'skip:not-inquiry'); continue; }

      let buyerEmail = (data.buyer_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.buyer_email).trim())) ? String(data.buyer_email).trim().toLowerCase() : null;
      if (!buyerEmail && !isRelay) buyerEmail = from.email;
      if (!buyerEmail || /@abiozen\.com$/i.test(buyerEmail)) { out.skipped_no_buyer++; sample(subject, from.email, 'skip:no-buyer-email'); continue; }

      const openByBuyer = (await query(
        `SELECT id FROM inquiries WHERE LOWER(buyer_email)=LOWER($1) AND status IN ('new','in_conversation','quote_sent','human_requested') ORDER BY created_at DESC LIMIT 1`,
        [buyerEmail])).rows[0];
      if (openByBuyer) {
        if (dryRun) { out.replies_routed++; sample(subject, buyerEmail, 'reply(dry)'); continue; }
        await processInboundReply(openByBuyer.id, `Subject: ${subject}\n\n${body}`);
        await query(`UPDATE processed_emails SET inquiry_id=$1 WHERE id=$2`, [openByBuyer.id, gmailId]).catch(() => {});
        out.replies_routed++; sample(subject, buyerEmail, 'reply');
        await markGmailRead(user, gmailId, tok.access_token, dryRun);
        continue;
      }
      if (dryRun) { out.new_inquiries++; sample(subject, buyerEmail, 'new(dry)'); continue; }

      const inquiryId = await receiveInquiry({
        molecule_name: data.molecule_name || null,
        cas_number: data.cas_number || null,
        buyer_name: data.buyer_name || (isRelay ? null : from.name) || null,
        buyer_email: buyerEmail,
        buyer_company: data.buyer_company || null,
        quantity: data.quantity || null,
        quantity_unit: data.quantity_unit === 'kg' ? 'kg' : 'g',
        intended_use: data.intended_use || null,
        country: data.country || null,
        message: data.message || body.slice(0, 500),
        source: 'email',
      });
      await query(`UPDATE processed_emails SET inquiry_id=$1 WHERE id=$2`, [inquiryId, gmailId]).catch(() => {});
      out.new_inquiries++; sample(subject, buyerEmail, 'new_inquiry');
      await markGmailRead(user, gmailId, tok.access_token, dryRun);
    } catch (e) { out.errors.push(`${gmailId}: ${e.message}`); }
  }

  out.skipped = out.skipped_subject + out.skipped_internal + out.skipped_no_sender + out.skipped_not_inquiry + out.skipped_no_buyer;
  await pollLog(out, dryRun);
  return out;
}

// Log a detailed poll summary to agent_activity_log: what was found and why each
// message was skipped (subject samples + decisions), for debugging the mailbox.
async function pollLog(out, dryRun) {
  if (dryRun) return;
  if (!out.checked && !out.warning && !(out.errors && out.errors.length)) return; // nothing new to report
  const reasons = [];
  if (out.skipped_subject) reasons.push(`${out.skipped_subject} subject-no-keyword`);
  if (out.skipped_not_inquiry) reasons.push(`${out.skipped_not_inquiry} not-inquiry`);
  if (out.skipped_internal) reasons.push(`${out.skipped_internal} internal`);
  if (out.skipped_no_buyer) reasons.push(`${out.skipped_no_buyer} no-buyer-email`);
  if (out.skipped_no_sender) reasons.push(`${out.skipped_no_sender} no-sender`);
  const samples = (out.samples || []).map(s => `"${s.subject}" <${s.from}> → ${s.decision}`).join(' | ');
  const reasoning = `Polled ${SALES_MAILBOX()}: listed ${out.listed} unread, ${out.checked} new, ${out.skipped_seen} already-seen. Created ${out.new_inquiries} inquiries, routed ${out.replies_routed} replies. Skipped: ${reasons.join(', ') || 'none'}.${out.warning ? ' WARNING: ' + out.warning : ''}${out.errors && out.errors.length ? ' ERRORS: ' + out.errors.slice(0, 5).join('; ') : ''}${samples ? ' Samples: ' + samples : ''}`.slice(0, 3000);
  await logAgentActivity({
    agent_name: AGENT, action_type: 'sales_mailbox_polled', user_id: null,
    reasoning, source_kpi: 'kpi-sg-sales',
    output_summary: `listed=${out.listed} new=${out.checked} inq=${out.new_inquiries} replies=${out.replies_routed} skip=${out.skipped}${out.warning ? ' WARN' : ''}`.slice(0, 300),
  }).catch(() => {});
}

// Best-effort: drop the UNREAD label (needs gmail.modify scope). Non-fatal.
async function markGmailRead(user, gmailId, accessToken, dryRun) {
  if (dryRun) return;
  try {
    await fetch(`https://gmail.googleapis.com/gmail/v1/users/${user}/messages/${gmailId}/modify`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    });
  } catch (_) {}
}

// ── PART 2 — molecule pricing seed (20 GMP APIs) ──────────────────────────────
// [name, cas, price/kg, minGrams, leadDays, dmfAvailable, regStatus]
const PRICING_SEED = [
  ['Semaglutide', '910463-68-5', 85000, 1, 45, 1, 'DMF available'],
  ['Tirzepatide', '2023788-19-2', 95000, 1, 60, 0, 'DMF pending'],
  ['Liraglutide', '204656-20-2', 45000, 1, 30, 1, 'DMF available'],
  ['Metformin HCl', '1115-70-4', 25, 1000, 14, 1, 'DMF available'],
  ['Sitagliptin', '486460-32-6', 850, 100, 21, 1, 'DMF available'],
  ['Empagliflozin', '864070-44-0', 1200, 100, 21, 0, 'GMP'],
  ['Dapagliflozin', '461432-26-8', 1100, 100, 21, 0, 'GMP'],
  ['Apixaban', '503612-47-3', 450, 100, 14, 1, 'DMF available'],
  ['Rivaroxaban', '366789-02-8', 380, 100, 14, 0, 'GMP'],
  ['Atorvastatin', '134523-00-5', 65, 1000, 14, 1, 'DMF available'],
  ['Rosuvastatin', '287714-41-4', 85, 500, 14, 0, 'GMP'],
  ['Lisinopril', '76547-98-3', 45, 1000, 10, 1, 'DMF available'],
  ['Amlodipine', '88150-42-9', 35, 1000, 10, 0, 'GMP'],
  ['Omeprazole', '73590-58-6', 28, 1000, 10, 1, 'DMF available'],
  ['Ciprofloxacin HCl', '86393-32-0', 55, 1000, 14, 1, 'DMF available'],
  ['Azithromycin', '83905-01-5', 75, 500, 14, 0, 'GMP'],
  ['Osimertinib', '1421373-65-0', 12000, 10, 30, 0, 'GMP'],
  ['Ibrutinib', '936563-96-1', 8500, 10, 30, 0, 'GMP'],
  ['Lenalidomide', '191732-72-6', 15000, 5, 45, 0, 'GMP'],
  ['Abiraterone', '154229-18-2', 2800, 100, 21, 1, 'DMF available'],
];
// Top 20 research chemicals (research-use-only, non-GMP). [name, price/kg, minGrams, leadDays, purity]
const RESEARCH_PRICING_SEED = [
  ['4-Fluoroacetophenone', 85, 100, 7, '98%'],
  ['Semaglutide (research grade)', 12000, 1, 14, '98%'],
  ['Fmoc-L-Lysine(Boc)-OH', 450, 100, 10, '98%'],
  ['SPhos', 6500, 10, 14, '98%'],
  ['Grubbs Catalyst 2nd Gen', 45000, 1, 21, '98%'],
  ['Pd(OAc)2', 18000, 5, 14, '98%'],
  ['XPhos Pd G3', 95000, 1, 21, '98%'],
  ['Fmoc-AEEA-OH', 1200, 50, 10, '98%'],
  ['Berberine Chloride', 450, 500, 7, '98%'],
  ['Curcumin 98%', 180, 1000, 7, '98%'],
  ['Paclitaxel', 55000, 0.1, 30, '99%'],
  ['Artemisinin', 950, 100, 14, '98%'],
  ['Resveratrol 98%', 380, 500, 7, '98%'],
  ['Testosterone Cypionate', 2800, 100, 14, '98%'],
  ['BPC-157', 8500, 1, 21, '98%'],
  ['TB-500', 12000, 1, 21, '98%'],
  ['Dimethyl Malonate', 25, 5000, 7, '99%'],
  ['Di-tert-butyl dicarbonate (Boc2O)', 45, 1000, 7, '99%'],
  ['Fmoc-L-Histidine(Trt)-OH', 750, 100, 10, '98%'],
  ['Camptothecin', 4500, 0.1, 30, '98%'],
];
// Idempotent: inserts any missing GMP + research rows (ON CONFLICT DO NOTHING on
// LOWER(molecule_name)), so it safely tops up the catalog on every boot.
async function seedMoleculePricing() {
  let seeded = 0;
  for (const [name, cas, price, minG, lead, dmf, reg] of PRICING_SEED) {
    const samplePrice = Math.max(150, Math.round((price / 1000) * 5 * 1.5)); // ~5g at a premium
    const r = await query(
      `INSERT INTO molecule_pricing (id, molecule_name, cas_number, gmp_grade, purity, price_per_kg_usd,
         min_quantity_g, lead_time_days, sample_available, sample_price_usd, gmp_certified, dmf_available,
         coa_available, sds_available, regulatory_status, storage_conditions, shelf_life_months, active, created_at, updated_at)
       VALUES ($1,$2,$3,'GMP','99%+',$4,$5,$6,1,$7,1,$8,1,1,$9,'Store at 2-8°C, protect from light',36,1,NOW(),NOW())
       ON CONFLICT (LOWER(molecule_name)) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), name, cas, price, minG, lead, samplePrice, dmf, reg]);
    if (r.rows.length) seeded++;
  }
  for (const [name, price, minG, lead, purity] of RESEARCH_PRICING_SEED) {
    const samplePrice = Math.max(120, Math.round((price / 1000) * Math.min(minG, 5) * 1.5));
    const r = await query(
      `INSERT INTO molecule_pricing (id, molecule_name, cas_number, gmp_grade, purity, price_per_kg_usd,
         min_quantity_g, lead_time_days, sample_available, sample_price_usd, gmp_certified, dmf_available,
         coa_available, sds_available, regulatory_status, storage_conditions, shelf_life_months, active, created_at, updated_at)
       VALUES ($1,$2,NULL,'RUO',$3,$4,$5,$6,1,$7,0,0,1,1,'Research Use Only','Store cool & dry, protect from light',36,1,NOW(),NOW())
       ON CONFLICT (LOWER(molecule_name)) DO NOTHING RETURNING id`,
      [crypto.randomUUID(), name, purity, price, minG, lead, samplePrice]);
    if (r.rows.length) seeded++;
  }
  const total = PRICING_SEED.length + RESEARCH_PRICING_SEED.length;
  if (seeded) await logAgentActivity({ agent_name: AGENT, action_type: 'pricing_seeded', reasoning: `Seeded ${seeded} molecule prices (GMP + research).`, source_kpi: 'kpi-sg-sales', output_summary: `seeded=${seeded}` }).catch(() => {});
  return { seeded, skipped: total - seeded };
}

module.exports = {
  receiveInquiry, sendFirstResponse, processInboundReply, generateQuote, escalateToHuman,
  handleFollowUp, runInquiryAgent, seedMoleculePricing, findPricing, classifyBuyer,
  pollSalesEmailbox, findStock, findDemand,
};
