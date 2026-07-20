// Sales Agent — daily sales briefing.
// Pulls Apollo sequence performance, warm leads and reply-rate trends, then has
// Claude produce a "call these people, say this" list plus follow-up tasks that
// are assigned to the sales team.
const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { getWarmLeads } = require('./customer-agent');
const { logAgentActivity, createDailyTask, parseClaudeJSON, businessToday, getCEOUser } = require('../agent-core');
const { sendWhatsApp } = require('../whatsapp');

const AGENT = 'sales-agent';
const CLAUDE_MODEL = 'claude-opus-4-8';

// Nominal pipeline value per classification. Leads carry no real deal size (Apollo
// replies don't include one), so "pipeline value" is an ESTIMATE from these
// weights — a HOT lead is worth more than a WARM one. Overridable per lead via
// PUT /api/leads/:id (estimated_value). Documented as a heuristic, not real
// booked value, wherever it surfaces.
const LEAD_VALUE = { HOT: 25000, WARM: 8000, COLD: 0 };

// Direct Claude call (parsed JSON or raw text). Kept local so classification can
// run on the hourly cron without the daily-briefing haiku default.
async function callClaude(prompt, { maxTokens = 1200, json = true } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { data: null, text: null, error: 'ANTHROPIC_API_KEY not configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return { data: null, text: null, error: `Claude ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const text = (await res.json()).content?.[0]?.text || '';
    return { data: json ? parseClaudeJSON(text) : null, text };
  } catch (e) { return { data: null, text: null, error: e.message }; }
}

// Apollo's own reply classifier (reply_class) → our HOT/WARM/COLD buckets. Used
// as a fallback when the reply body text can't be retrieved so a lead is still
// bucketed sensibly rather than dropped.
function apolloReplyClassToBucket(rc) {
  const c = String(rc || '').toLowerCase();
  if (/(willing_to_meet|interested|meeting|positive)/.test(c)) return 'HOT';
  if (/(question|objection|referral|info|maybe|neutral)/.test(c)) return 'WARM';
  if (/(not_interested|unsubscribe|wrong_person|no_longer|ooo|out_of_office|negative)/.test(c)) return 'COLD';
  return null;
}

// Map a free-text sales follow-up title to the real weekly_kpis.kpi_name it
// advances, so completing it credits the KPI component (the rollup keys on
// source_kpi = kpi_name). sales_team KPIs: calls_made, demos_completed,
// orders_closed, outreach_emails. Checked specific-first — the outreach set has
// broad catch words ("contact", "reach out") that would otherwise swallow
// call/demo/order tasks. No match → null (conservative: no credit beats a wrong one).
function mapSalesKpi(title) {
  const t = String(title || '').toLowerCase();
  if (/call|phone|dial/.test(t)) return 'calls_made';
  if (/demo|presentation|walkthrough/.test(t)) return 'demos_completed';
  if (/close|order|deal|quote|proposal/.test(t)) return 'orders_closed';
  if (/email|outreach|apollo|linkedin|reach out|contact/.test(t)) return 'outreach_emails';
  return null;
}

async function runSalesBriefing({ dryRun = false } = {}) {
  const today = businessToday();

  const sequences = (await query(
    `SELECT molecule_name, buyer_segment, emails_sent, replies, orders_generated, status
     FROM apollo_sequences WHERE COALESCE(status,'active')='active'
     ORDER BY emails_sent DESC LIMIT 10`
  )).rows;
  const totalSent = sequences.reduce((s, r) => s + (r.emails_sent || 0), 0);
  const totalReplies = sequences.reduce((s, r) => s + (r.replies || 0), 0);
  const replyRate = totalSent > 0 ? ((totalReplies / totalSent) * 100).toFixed(1) : '0.0';

  let warmLeads = [];
  try { warmLeads = await getWarmLeads({ limit: 5 }); } catch {}

  const salesUsers = (await query(
    `SELECT id, name FROM users WHERE role IN ('sales_team','account_manager') AND is_active=1 ORDER BY name`
  )).rows;

  const seqText = sequences.length
    ? sequences.map(s => `  - ${s.molecule_name || '?'} (${s.buyer_segment || '?'}): ${s.emails_sent || 0} sent, ${s.replies || 0} replies, ${s.orders_generated || 0} orders`).join('\n')
    : '  (no active Apollo sequences)';
  const leadText = warmLeads.length
    ? warmLeads.map(l => `  - ${l.name || '(unknown)'} at ${l.company || '?'} (${l.segment || '?'}): warmth ${l.score}/100, ${(l.signals || []).join(', ') || 'no signals'}`).join('\n')
    : '  (no warm leads in buyer_engagement)';

  const prompt = `You are the Sales Agent for Abiozen LLC, a US pharmaceutical API distributor. Write today's sales briefing.

APOLLO SEQUENCES: ${totalSent} emails sent, ${totalReplies} replies (${replyRate}% reply rate)
${seqText}
WARM LEADS (highest engagement first):
${leadText}

Return EXACTLY a JSON object, no other text:
{"call_list":[{"name":"who to call","company":"company","pitch":"one specific sentence to open with"}],"follow_ups":[{"task":"specific follow-up action","priority":"HIGH|MEDIUM|LOW","reasoning":"why","confidence":80}]}
Provide up to 3 call_list entries (use the warm leads) and up to 5 follow_ups. Every entry must reference a real lead or sequence above. Do not invent contacts.`;

  let parsed = { call_list: [], follow_ups: [] };
  if (!dryRun) {
    const raw = await runClaudeAnalysis(prompt);
    const j = parseClaudeJSON(raw);
    if (j) parsed = {
      call_list: Array.isArray(j.call_list) ? j.call_list.slice(0, 3) : [],
      follow_ups: Array.isArray(j.follow_ups) ? j.follow_ups.slice(0, 5) : [],
    };
  }

  const assigned = [];
  if (!dryRun && salesUsers.length) {
    for (let i = 0; i < parsed.follow_ups.length; i++) {
      const f = parsed.follow_ups[i];
      const owner = salesUsers[i % salesUsers.length];
      const id = await createDailyTask({
        user_id: owner.id, task_date: today,
        task_title: f.task || `Sales follow-up ${i + 1}`,
        task_description: f.reasoning || '',
        priority: f.priority || 'MEDIUM',
        source_kpi: mapSalesKpi(f.task), agent_name: AGENT,
        reasoning: f.reasoning || 'Generated from Apollo sequence performance and warm-lead signals.',
      });
      assigned.push({ task_id: id, user: owner.name, task: f.task });
    }
  }

  if (!dryRun) {
    await logAgentActivity({
      agent_name: AGENT, action_type: 'sales_briefing', user_id: null,
      reasoning: `Reply rate ${replyRate}% across ${totalSent} emails; ${warmLeads.length} warm leads. Produced ${parsed.call_list.length} calls and assigned ${assigned.length} follow-ups.`,
      source_kpi: 'kpi-sg-sales',
      confidence_score: parsed.follow_ups.length
        ? Math.round(parsed.follow_ups.reduce((s, f) => s + (Number(f.confidence) || 70), 0) / parsed.follow_ups.length)
        : 60,
      output_summary: `${parsed.call_list.length} calls recommended, ${assigned.length} follow-up tasks assigned to ${salesUsers.length} sales reps.`,
    });
  }

  return {
    generated_at: new Date().toISOString(), date: today,
    apollo: { emails_sent: totalSent, replies: totalReplies, reply_rate_pct: Number(replyRate) },
    warm_leads: warmLeads.length, sales_reps: salesUsers.length,
    call_list: parsed.call_list, follow_ups: parsed.follow_ups, assigned,
  };
}

// ── Reply ingestion & lead management ─────────────────────────────────────────

// Fetch replied outbound messages from Apollo. The spec's
// `GET /emailer_messages?label=replied` does not exist (404); the real endpoint is
// `POST /emailer_messages/search`, which returns outbound sequence messages, so we
// filter client-side on `replied === true`. Each carries the contact (to_name /
// to_email), the sequence (campaign_name / emailer_campaign_id), Apollo's own
// `reply_class`, and — where available — the reply body. Best-effort: returns []
// on any failure so the cron never throws.
async function fetchApolloReplies(apolloKey, { maxPages = 5 } = {}) {
  if (!apolloKey) return { replies: [], error: 'APOLLO_API_KEY not configured' };
  const replies = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch('https://api.apollo.io/api/v1/emailer_messages/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
        body: JSON.stringify({ per_page: 100, page }),
      });
      if (!res.ok) return { replies, error: `Apollo ${res.status}: ${(await res.text()).slice(0, 160)}` };
      const msgs = (await res.json()).emailer_messages || [];
      if (!msgs.length) break;
      for (const m of msgs) if (m.replied === true) replies.push(m);
    }
  } catch (e) { return { replies, error: e.message }; }
  return { replies };
}

// Pull the reply body from whichever field Apollo populated. The account has no
// live replies yet, so the exact field can't be confirmed against real data —
// this checks the plausible candidates in order and falls back to a reply_class-
// derived phrase so Claude still receives a signal. Adjust the candidate list once
// a real reply is observed (verify with GET /emailer_messages/{id} on a replied row).
function extractReplyText(m) {
  const cand = m.reply_body || m.reply_text || m.last_reply_body || m.latest_reply_text || m.inbound_body_text;
  if (cand && String(cand).trim()) return { text: String(cand).trim(), source: 'reply_field' };
  if (m.reply_class) return { text: `[No reply body retrieved from Apollo. Apollo reply_class: ${m.reply_class}]`, source: 'reply_class' };
  return { text: '[No reply body available]', source: 'none' };
}

// Who gets the HOT-lead WhatsApp. Prefers an explicit env override, then the admin
// named Naresh, then any admin with a number, then the CEO user. Returns null (and
// the caller logs) rather than guessing if none has a number.
async function hotLeadRecipient() {
  if (process.env.SALES_ALERT_WHATSAPP) return { name: 'Sales alert', whatsapp_number: process.env.SALES_ALERT_WHATSAPP, id: null };
  const r = (await query(
    `SELECT id, name, whatsapp_number FROM users
     WHERE is_active=1 AND role IN ('admin','super_admin') AND whatsapp_number IS NOT NULL AND whatsapp_number <> ''
     ORDER BY CASE WHEN LOWER(email) LIKE 'naren%' THEN 0 ELSE 1 END, created_at LIMIT 1`
  )).rows[0];
  if (r) return r;
  const ceo = await getCEOUser();
  return ceo && ceo.whatsapp_number ? ceo : null;
}

/**
 * FUNCTION 1 — process Apollo replies into classified leads.
 * Fetches replies, classifies each (HOT/WARM/COLD) via Claude, stores a lead,
 * WhatsApps Naresh on HOT, queues a follow-up draft on WARM. Idempotent: a reply
 * already stored (by apollo_message_id) is skipped, so the hourly cron is safe.
 */
async function processApolloReplies({ dryRun = false } = {}) {
  const started = Date.now();
  const { replies, error: fetchErr } = await fetchApolloReplies(process.env.APOLLO_API_KEY);
  const out = { fetched: replies.length, new_leads: 0, hot: 0, warm: 0, cold: 0, follow_ups: 0, skipped_existing: 0, errors: [] };
  if (fetchErr) out.errors.push('apollo: ' + fetchErr);

  if (dryRun) return { ...out, dryRun: true, elapsed_ms: Date.now() - started };

  let recipient = null;
  for (const m of replies) {
    try {
      const apolloId = m.id;
      if (apolloId) {
        const exists = (await query('SELECT id FROM leads WHERE apollo_message_id=$1', [apolloId])).rows[0];
        if (exists) { out.skipped_existing++; continue; }
      }
      const { text: replyText } = extractReplyText(m);
      const contactName = m.to_name || m.contact_name || '(unknown)';
      const company = m.company_name || (m.to_email ? m.to_email.split('@')[1] : null) || null;

      // Classify. Prefer Claude on the reply body; fall back to Apollo's reply_class.
      let classification = null, summary = '';
      const cls = await callClaude(
        `Classify this reply to a B2B pharmaceutical sourcing outreach email into exactly one bucket.\n\n`
        + `HOT = expressed interest, asked for a quote, requested samples, wants to buy or meet.\n`
        + `WARM = asked a question or wants more information, but no clear buying intent yet.\n`
        + `COLD = not interested, wrong person, asked to unsubscribe, out of office, or negative.\n\n`
        + `Reply from ${contactName}${company ? ' at ' + company : ''}:\n"""${replyText.slice(0, 2000)}"""\n\n`
        + `Return ONLY JSON: {"classification":"HOT|WARM|COLD","summary":"one short sentence on what they said and why"}`,
        { maxTokens: 400 }
      );
      if (cls.data && ['HOT', 'WARM', 'COLD'].includes(cls.data.classification)) {
        classification = cls.data.classification;
        summary = String(cls.data.summary || '').slice(0, 400);
      } else {
        classification = apolloReplyClassToBucket(m.reply_class) || 'WARM';
        summary = `Classified from Apollo reply_class="${m.reply_class || 'unknown'}" (Claude unavailable: ${cls.error || 'no parse'}).`;
        if (cls.error) out.errors.push(`classify ${contactName}: ${cls.error}`);
      }

      const leadId = crypto.randomUUID();
      await query(
        `INSERT INTO leads (id, contact_name, company, email, reply_text, classification,
           source_sequence, apollo_message_id, reply_class, status, estimated_value, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'new',$10,$11,NOW(),NOW())
         ON CONFLICT (apollo_message_id) DO NOTHING`,
        [leadId, contactName, company, m.to_email || null, replyText, classification,
         m.campaign_name || m.emailer_campaign_id || null, apolloId || null, m.reply_class || null,
         LEAD_VALUE[classification] || 0, summary]
      );
      out.new_leads++; out[classification.toLowerCase()]++;

      if (classification === 'HOT') {
        if (recipient === null) recipient = await hotLeadRecipient();
        if (recipient && recipient.whatsapp_number) {
          await sendWhatsApp(recipient.whatsapp_number,
            `🔥 HOT LEAD\n${contactName}${company ? ' · ' + company : ''}\n${m.to_email || ''}\n\n"${replyText.slice(0, 300)}"\n\n${summary}\nReply via Sales Pipeline in PlaybookOS.`,
            { user_id: recipient.id || null, message_type: 'hot_lead' });
        } else {
          out.errors.push('HOT lead but no WhatsApp recipient configured (set SALES_ALERT_WHATSAPP or an admin whatsapp_number)');
        }
      } else if (classification === 'WARM') {
        try {
          await generateFollowUp({ id: leadId, contact_name: contactName, company, email: m.to_email, reply_text: replyText });
          out.follow_ups++;
        } catch (e) { out.errors.push(`follow-up ${contactName}: ${e.message}`); }
      }
    } catch (e) { out.errors.push(`${m.to_name || m.id}: ${e.message}`); }
  }

  await logAgentActivity({
    agent_name: AGENT, action_type: 'apollo_replies_processed', user_id: null,
    reasoning: `Processed ${out.fetched} Apollo replies → ${out.new_leads} new leads (${out.hot} hot, ${out.warm} warm, ${out.cold} cold), ${out.follow_ups} follow-up drafts, ${out.skipped_existing} already known.`
      + (out.errors.length ? ` ${out.errors.length} errors.` : ''),
    source_kpi: 'kpi-sg-sales',
    confidence_score: out.errors.length ? 60 : 90,
    output_summary: `fetched=${out.fetched} new=${out.new_leads} hot=${out.hot} warm=${out.warm} cold=${out.cold} followups=${out.follow_ups}`,
  }).catch(e => console.error('[sales-agent] audit failed:', e.message));

  return { ...out, elapsed_ms: Date.now() - started };
}

/**
 * FUNCTION 2 — draft a personalized follow-up for a lead's reply.
 * Claude writes a response addressing exactly what they asked. Stored in follow_ups
 * as a DRAFT for Naresh to approve/send (not auto-sent — sending on the user's
 * behalf is an approval action). Returns the draft.
 */
async function generateFollowUp(lead) {
  const prompt = `You are a sales rep at Abiozen LLC, a US pharmaceutical API and specialty-chemical distributor. A prospect replied to our outreach. Write a concise, personalized email response that addresses EXACTLY what they asked or raised — do not be generic.\n\n`
    + `Prospect: ${lead.contact_name || 'there'}${lead.company ? ' at ' + lead.company : ''}\n`
    + `Their reply:\n"""${String(lead.reply_text || '').slice(0, 2000)}"""\n\n`
    + `Guidelines: warm but professional, no fluff, one clear next step (a quote, a call, or the specific info they wanted). Do not invent prices, stock, or documentation we may not have — offer to confirm specifics. Under 150 words.\n\n`
    + `Return ONLY JSON: {"subject":"...","body":"plain-text email body with line breaks as \\n"}`;
  const { data, error } = await callClaude(prompt, { maxTokens: 800 });
  const subject = (data && data.subject) ? String(data.subject).slice(0, 300) : `Re: your enquiry — Abiozen`;
  const body = (data && data.body) ? String(data.body) : null;
  if (!body) throw new Error(error || 'no follow-up body from Claude');

  const id = crypto.randomUUID();
  await query(
    `INSERT INTO follow_ups (id, lead_id, subject, body, status, created_at)
     VALUES ($1,$2,$3,$4,'draft',NOW())`,
    [id, lead.id, subject, body]
  );
  await logAgentActivity({
    agent_name: AGENT, action_type: 'follow_up_drafted', user_id: null,
    reasoning: `Drafted follow-up for ${lead.contact_name || 'lead'}${lead.company ? ' at ' + lead.company : ''}.`,
    output_summary: `lead_id=${lead.id} follow_up_id=${id}`,
  }).catch(() => {});
  return { id, lead_id: lead.id, subject, body, status: 'draft' };
}

/**
 * FUNCTION 3 — pipeline summary: leads grouped by status, plus total pipeline
 * value (estimated), conversion rate, and average response time.
 */
async function getLeadPipeline() {
  const rows = (await query(
    `SELECT id, contact_name, company, email, classification, status, source_sequence,
            estimated_value, reply_text, notes, assigned_to, created_at, updated_at
     FROM leads ORDER BY
       CASE classification WHEN 'HOT' THEN 0 WHEN 'WARM' THEN 1 ELSE 2 END,
       updated_at DESC`
  )).rows;

  const STATUSES = ['new', 'contacted', 'qualified', 'closed'];
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, []]));
  for (const r of rows) (byStatus[r.status] || (byStatus[r.status] = [])).push(r);

  const total = rows.length;
  const closed = rows.filter(r => r.status === 'closed').length;
  const qualifiedPlus = rows.filter(r => r.status === 'qualified' || r.status === 'closed').length;
  const pipelineValue = rows
    .filter(r => r.status !== 'closed') // open pipeline
    .reduce((s, r) => s + (Number(r.estimated_value) || 0), 0);

  // Avg response time = created_at → first status change, for leads that moved off
  // 'new' (updated_at > created_at). A proxy for "time to first touch".
  const moved = rows.filter(r => r.status !== 'new' && r.updated_at && r.created_at);
  const avgResponseMs = moved.length
    ? moved.reduce((s, r) => s + (new Date(r.updated_at) - new Date(r.created_at)), 0) / moved.length
    : null;

  return {
    total,
    by_status: byStatus,
    counts: Object.fromEntries(STATUSES.map(s => [s, (byStatus[s] || []).length])),
    hot: rows.filter(r => r.classification === 'HOT').length,
    warm: rows.filter(r => r.classification === 'WARM').length,
    cold: rows.filter(r => r.classification === 'COLD').length,
    pipeline_value_estimate: pipelineValue,
    conversion_rate_pct: total ? Number(((closed / total) * 100).toFixed(1)) : 0,
    qualified_rate_pct: total ? Number(((qualifiedPlus / total) * 100).toFixed(1)) : 0,
    avg_response_hours: avgResponseMs != null ? Number((avgResponseMs / 3600000).toFixed(1)) : null,
    value_is_estimate: true,
  };
}

module.exports = { runSalesBriefing, processApolloReplies, generateFollowUp, getLeadPipeline };
