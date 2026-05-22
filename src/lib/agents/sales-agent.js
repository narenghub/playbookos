// Sales Agent — daily sales briefing.
// Pulls Apollo sequence performance, warm leads and reply-rate trends, then has
// Claude produce a "call these people, say this" list plus follow-up tasks that
// are assigned to the sales team.
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { getWarmLeads } = require('./customer-agent');
const { logAgentActivity, createDailyTask, parseClaudeJSON } = require('../agent-core');

const AGENT = 'sales-agent';

async function runSalesBriefing({ dryRun = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);

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
        source_kpi: 'kpi-sg-sales', agent_name: AGENT,
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

module.exports = { runSalesBriefing };
