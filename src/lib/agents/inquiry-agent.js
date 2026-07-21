// GMP Inquiry Agent — handles the full B2B inquiry-to-order conversation for GMP
// API molecules autonomously via email: acknowledges the inquiry, answers pricing/
// documentation/compliance/lead-time questions, sends formal quotes, and escalates
// to a human when asked or when the deal is large.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('../mailer');
const { sendWhatsApp } = require('../whatsapp');
const { logAgentActivity, parseClaudeJSON } = require('../agent-core');

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
async function logMessage(inquiryId, m) {
  await query(
    `INSERT INTO inquiry_messages (id, inquiry_id, direction, sender_name, sender_email, subject, body_text, body_html, sent_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
    [crypto.randomUUID(), inquiryId, m.direction, m.sender_name || null, m.sender_email || null, m.subject || null, m.body_text || null, m.body_html || null]);
}
async function sendAndLog(inquiry, { subject, body, cc }) {
  const html = htmlWrap(body);
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
      `📩 New GMP inquiry: ${data.buyer_name || 'Buyer'} at ${data.buyer_company || '?'} for ${molecule || 'a molecule'} — ${qty ? qty + unit : 'qty TBD'}`,
      { user_id: naresh.id || null, message_type: 'gmp_inquiry' }).catch(() => {});
  }
  await logAgentActivity({ agent_name: AGENT, action_type: 'inquiry_received', user_id: null,
    reasoning: `New GMP inquiry from ${data.buyer_company || data.buyer_email} for ${molecule} (${priority}).`,
    source_kpi: 'kpi-sg-sales', output_summary: `inquiry=${id} molecule=${molecule} priority=${priority}` }).catch(() => {});
  return id;
}

// ── Function 2 — first response ───────────────────────────────────────────────
async function sendFirstResponse(inquiryId) {
  const inq = (await query('SELECT * FROM inquiries WHERE id=$1', [inquiryId])).rows[0];
  if (!inq) return { error: 'inquiry not found' };
  const pricing = await findPricing(inq.molecule_name, inq.cas_number);
  const priceLine = pricing ? `${pricing.price_per_kg_usd >= 1000 ? '$' + Number(pricing.price_per_kg_usd).toLocaleString() : '$' + pricing.price_per_kg_usd}/kg` : 'available on request';
  const lead = pricing?.lead_time_days || 30;
  const prompt = `Write a professional first response email for a GMP pharmaceutical API inquiry.

Buyer: ${inq.buyer_name || 'there'} at ${inq.buyer_company || 'your organization'}
Molecule: ${inq.molecule_name} (CAS: ${inq.cas_number || 'to confirm'})
Quantity requested: ${inq.quantity_requested ? inq.quantity_requested + inq.quantity_unit : 'to confirm'}
We have this molecule available. Pricing starts at ${priceLine}.

Write an email that:
1. Acknowledges their inquiry warmly and professionally
2. Confirms we have the molecule in GMP grade
3. Asks these qualifying questions naturally: intended use (compounding/research/manufacturing); required documentation (USP/EP grade, GMP cert, DMF, COA format); delivery timeline needed; destination country (for export compliance); whether they need a 1-5 g evaluation sample first
4. Mentions our standard lead time of ${lead} days
5. Is warm but professional — pharma industry tone; under 200 words
Do not commit to a specific final price or a documentation guarantee you cannot verify — keep pricing as "starting at". Return ONLY the email body as plain text, ending with:

Abiozen Sales Team
Abiozen LLC
sales@abiozen.com`;
  const { text, error } = await callClaude(prompt, { maxTokens: 900 });
  if (!text) return { error: error || 'no body' };
  const subject = `Re: GMP API Inquiry — ${inq.molecule_name} | Abiozen LLC`;
  await sendAndLog(inq, { subject, body: text });
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
  const { data } = await callClaude(
    `You are the Abiozen GMP sales agent handling an email inquiry for ${inq.molecule_name}. Analyse the buyer's latest reply and the thread, then decide the next step.

Thread:
${history}

Buyer's latest reply:
"""${String(emailText).slice(0, 3000)}"""

We have this molecule GMP-grade${pricing ? `, price starting ~$${pricing.price_per_kg_usd}/kg, lead ${pricing.lead_time_days}d, DMF ${pricing.dmf_available ? 'available' : 'on request'}` : ''}.

Return ONLY JSON:
{"intent":"ready_for_quote|needs_human|still_qualifying","reason":"one line","reply_body":"the email body to send them next — answer their questions using ONLY facts stated above; do not invent prices/docs; if quoting is next, keep it brief and say a formal quote follows"}`,
    { maxTokens: 1200, json: true });
  const intent = data?.intent || 'still_qualifying';
  const replyBody = data?.reply_body || 'Thank you for your reply — a member of our team will follow up shortly.';

  let action = intent;
  if (dryRun) return { intent, reason: data?.reason, reply_preview: replyBody.slice(0, 300) };

  if (intent === 'needs_human') {
    await escalateToHuman(inquiryId, data?.reason || 'buyer requested a human');
    action = 'escalated';
  } else if (intent === 'ready_for_quote') {
    await sendAndLog(inq, { subject: `Re: GMP API Inquiry — ${inq.molecule_name}`, body: replyBody });
    await generateQuote(inquiryId);
    action = 'quoted';
  } else {
    await sendAndLog(inq, { subject: `Re: GMP API Inquiry — ${inq.molecule_name}`, body: replyBody });
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

  const prompt = `Write a formal pharmaceutical API quotation email from Abiozen LLC. Return ONLY the email body as plain text (no subject).

Buyer: ${inq.buyer_name || 'Procurement Team'} at ${inq.buyer_company || 'the buyer'}
Molecule: ${inq.molecule_name} (CAS ${inq.cas_number || 'to confirm'}), GMP grade
Quantity: ${qtyKg} kg
Unit price: $${unitPrice.toLocaleString()}/kg
API subtotal: $${apiTotal.toLocaleString()}
Documentation fee (COA/GMP cert): $${DOC_FEE}
Total: $${total.toLocaleString()} (shipping billed separately, TBD by destination)
Lead time: ${pricing.lead_time_days} days
Valid until: ${validUntil} (30 days)
Payment terms: 50% advance, 50% before shipment.

Format as a clean formal quotation with clear line items (API price, documentation fee, shipping TBD), the validity date, and payment terms. Add a bank-details placeholder line "[Bank wire details provided on order confirmation]". Do NOT invent bank numbers. End with:

Palash Das
Procurement Director
Abiozen LLC
palash@abiozen.com`;
  const { text } = await callClaude(prompt, { maxTokens: 1400 });
  const body = (text || `Please find our quotation for ${inq.molecule_name}: ${qtyKg}kg at $${unitPrice}/kg, total $${total}. Valid until ${validUntil}.`)
    + (needsApproval ? '' : '');
  const subject = `Quotation — ${inq.molecule_name} (${qtyKg}kg) | Abiozen LLC`;
  await sendAndLog(inq, { subject, body, cc: ['palash@abiozen.com', 'naren@abiozen.com'] });
  await query(`UPDATE inquiries SET status='quote_sent', order_value_usd=$1, updated_at=NOW() WHERE id=$2`, [total, inquiryId]);

  if (needsApproval || total > ESCALATE_ABOVE) {
    const naresh = await getNaresh();
    if (naresh.whatsapp_number) await sendWhatsApp(naresh.whatsapp_number,
      `💰 Large GMP quote sent: ${inq.buyer_company || inq.buyer_email} — ${inq.molecule_name} ${qtyKg}kg = $${total.toLocaleString()}${needsApproval ? ' (>10kg — review pricing)' : ''}`,
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
  await sendAndLog(inq, { subject: `Re: GMP API Inquiry — ${inq.molecule_name}`,
    body: `Thank you for your message. I'm connecting you with one of our specialists who will personally follow up on your ${inq.molecule_name} requirement within 24 hours.\n\nWe appreciate your interest in working with Abiozen.\n\nAbiozen Sales Team\nAbiozen LLC\nsales@abiozen.com` });
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
  await sendAndLog(inquiry, { subject: `Re: GMP API Inquiry — ${inquiry.molecule_name}`, body: `Hi ${inquiry.buyer_name || 'there'},\n\n${stage[1]}\n\nAbiozen Sales Team\nAbiozen LLC\nsales@abiozen.com` });
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
async function seedMoleculePricing() {
  const existing = (await query('SELECT COUNT(*)::int c FROM molecule_pricing')).rows[0].c;
  if (existing > 0) return { seeded: 0, skipped: existing };
  let seeded = 0;
  for (const [name, cas, price, minG, lead, dmf, reg] of PRICING_SEED) {
    const samplePrice = Math.max(150, Math.round((price / 1000) * 5 * 1.5)); // ~5g at a premium
    await query(
      `INSERT INTO molecule_pricing (id, molecule_name, cas_number, gmp_grade, purity, price_per_kg_usd,
         min_quantity_g, lead_time_days, sample_available, sample_price_usd, gmp_certified, dmf_available,
         coa_available, sds_available, regulatory_status, storage_conditions, shelf_life_months, active, created_at, updated_at)
       VALUES ($1,$2,$3,'GMP','99%+',$4,$5,$6,1,$7,1,$8,1,1,$9,'Store at 2-8°C, protect from light',36,1,NOW(),NOW())
       ON CONFLICT (LOWER(molecule_name)) DO NOTHING`,
      [crypto.randomUUID(), name, cas, price, minG, lead, samplePrice, dmf, reg]);
    seeded++;
  }
  await logAgentActivity({ agent_name: AGENT, action_type: 'pricing_seeded', reasoning: `Seeded ${seeded} GMP molecule prices.`, source_kpi: 'kpi-sg-sales', output_summary: `seeded=${seeded}` }).catch(() => {});
  return { seeded, skipped: 0 };
}

module.exports = {
  receiveInquiry, sendFirstResponse, processInboundReply, generateQuote, escalateToHuman,
  handleFollowUp, runInquiryAgent, seedMoleculePricing, findPricing, classifyBuyer,
};
