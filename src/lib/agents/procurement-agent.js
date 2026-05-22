// Procurement Agent — daily sourcing briefing.
// Pulls market-intelligence demand, sourcing gaps and pending COAs, then has
// Claude propose 5 sourcing tasks. Because sourcing is high-impact spend, every
// task is routed to the approval queue for the CEO to review before it is sent.
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { logAgentActivity, enqueueApproval, getCEOUser, parseClaudeJSON } = require('../agent-core');

const AGENT = 'procurement-agent';

async function runProcurementBriefing({ dryRun = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const ceo = await getCEOUser();

  // Latest growth-intelligence analysis — molecules buyers search for but we lack.
  let topMolecules = [];
  const gi = (await query(
    `SELECT content FROM ai_analyses WHERE analysis_type='growth_intelligence' ORDER BY created_at DESC LIMIT 1`
  )).rows[0];
  if (gi) {
    try { topMolecules = (JSON.parse(gi.content).top_molecules || []).slice(0, 10); } catch {}
  }

  const pendingCoa = (await query(
    `SELECT name, COALESCE(coa_status,'pending') coa_status FROM skus
     WHERE is_active=1 AND COALESCE(coa_status,'pending') <> 'approved'
     ORDER BY name LIMIT 15`
  )).rows;
  const activeSkus = parseInt((await query(
    `SELECT COUNT(*) c FROM skus WHERE is_active=1`)).rows[0].c, 10);

  const demandText = topMolecules.length
    ? topMolecules.map((m, i) => `  ${i + 1}. ${m.molecule || m.name || '?'} — demand ${m.demand_signal || m.demand || '?'}, ${m.rationale || ''}`).join('\n')
    : '  (no growth-intelligence demand signals available yet)';
  const coaText = pendingCoa.length
    ? pendingCoa.map(c => `  - ${c.name} (COA: ${c.coa_status})`).join('\n')
    : '  (none)';

  const prompt = `You are the Procurement Agent for Abiozen LLC, a US pharmaceutical API distributor. Generate today's sourcing plan for the procurement team.

CATALOG: ${activeSkus} active SKUs.
BUYER DEMAND — molecules searched for but not yet sourced:
${demandText}
SKUs WITH PENDING COA (cannot be listed until resolved):
${coaText}

Return EXACTLY a JSON array of 5 sourcing tasks, no other text:
[{"molecule":"name","cas":"CAS number or empty","task":"specific sourcing action","rationale":"why this matters for revenue","estimated_value":1500,"priority":"HIGH|MEDIUM|LOW","confidence":80}]
estimated_value is the approximate USD spend to source the molecule. Prioritise high-demand molecules we do not yet carry. Do not invent CAS numbers — leave empty if unknown.`;

  let tasks = [];
  if (!dryRun) {
    const raw = await runClaudeAnalysis(prompt);
    const j = parseClaudeJSON(raw);
    if (Array.isArray(j)) tasks = j.slice(0, 5);
  }

  const queued = [];
  if (!dryRun) {
    for (const t of tasks) {
      const payload = {
        molecule: t.molecule || '', cas: t.cas || '',
        task: t.task || '', rationale: t.rationale || '',
        estimated_value: Number(t.estimated_value) || 0,
        amount: Number(t.estimated_value) || 0,
      };
      const approvalId = await enqueueApproval({
        agent_name: AGENT, action_type: 'procurement_sourcing_task',
        action_payload: payload, requested_for_user_id: ceo ? ceo.id : null,
        priority: ['HIGH', 'MEDIUM', 'LOW'].includes(String(t.priority).toUpperCase())
          ? String(t.priority).toUpperCase() : 'MEDIUM',
      });
      await logAgentActivity({
        agent_name: AGENT, action_type: 'procurement_sourcing_task',
        user_id: ceo ? ceo.id : null,
        reasoning: t.rationale || `Source ${t.molecule} based on buyer demand signals.`,
        source_kpi: 'kpi-sg-procurement',
        confidence_score: Number(t.confidence) || 70,
        output_summary: `Sourcing task queued for approval: ${t.task || t.molecule} (~$${payload.estimated_value}).`,
        requires_approval: true,
      });
      queued.push({ approval_id: approvalId, ...payload, priority: t.priority });
    }
  }

  return {
    generated_at: new Date().toISOString(), date: today,
    demand_molecules: topMolecules.length, pending_coa: pendingCoa.length,
    tasks_queued: queued.length, queued,
    note: 'All sourcing tasks were placed in the approval queue for CEO review before assignment.',
  };
}

module.exports = { runProcurementBriefing };
