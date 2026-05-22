// CEO Agent — daily executive briefing for the CEO.
// Pulls revenue vs target, team health, risks/wins and pending approvals,
// then has Claude rank the 5 highest-revenue-impact actions for today.
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');
const { getKPIHierarchy, getBottlenecks, getCrossTeamDependencies } = require('../kpi-engine');
const { logAgentActivity, createDailyTask, getCEOUser, parseClaudeJSON } = require('../agent-core');

const AGENT = 'ceo-agent';
const fmt = n => '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

function renderEmail(r) {
  const list = (arr, color) => (arr.length ? arr : ['(none today)'])
    .map((x, i) => `<div style="font-size:13px;margin:4px 0;color:#1a1a2e">${i + 1}. ${x}</div>`).join('');
  const actions = (r.actions || []).map((a, i) =>
    `<div style="border-left:3px solid #1B3A6B;padding:6px 10px;margin:6px 0;background:#f8fafc">
       <div style="font-weight:700;font-size:13px">${i + 1}. ${a.action || ''}</div>
       <div style="font-size:11px;color:#666">owner: ${a.owner || '—'} · impact: ${a.revenue_impact || '—'} · success: ${a.success_criterion || '—'} · confidence: ${a.confidence ?? '—'}</div>
     </div>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">
    <div style="background:#1B3A6B;padding:20px;border-radius:8px 8px 0 0;color:#fff">
      <h2 style="margin:0;font-size:20px">CEO Briefing — ${r.date}</h2>
      <p style="margin:6px 0 0;color:#9FE1CB;font-size:13px">${fmt(r.vision.current)} of ${fmt(r.vision.target)} · ${r.vision.pct}% to the $10M vision</p>
    </div>
    <div style="border:1px solid #e0e0e0;border-top:none;padding:20px">
      <p style="font-size:14px;line-height:1.6">${r.summary || ''}</p>
      <div style="font-size:13px;font-weight:700;color:#1D9E75;margin-top:14px">WINS</div>${list(r.wins)}
      <div style="font-size:13px;font-weight:700;color:#E24B4A;margin-top:14px">RISKS</div>${list(r.risks)}
      <div style="font-size:13px;font-weight:700;color:#1B3A6B;margin-top:14px">5 ACTIONS FOR TODAY (ranked by revenue impact)</div>${actions}
      <p style="font-size:11px;color:#888;margin-top:16px">${r.pending_approvals} approval(s) pending · team avg score ${r.team_avg_score}</p>
    </div>
  </div>`;
}

async function runCEOBriefing({ dryRun = false } = {}) {
  const ceo = await getCEOUser();
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  const hierarchy = await getKPIHierarchy();
  const bottlenecks = await getBottlenecks({ limit: 5 });
  const deps = await getCrossTeamDependencies();

  const monthlyTarget = parseFloat((await query(
    `SELECT target_value FROM targets WHERE period_type='monthly' AND period_key=$1 AND metric='revenue'`,
    [thisMonth])).rows[0]?.target_value || 0);
  const monthlyActual = parseFloat((await query(
    `SELECT COALESCE(SUM(amount),0) v FROM orders WHERE order_date::text LIKE $1`,
    [thisMonth + '%'])).rows[0].v);

  const teamScores = (await query(`
    SELECT u.name, u.role, p.score_0_to_100
    FROM performance_scores p JOIN users u ON u.id=p.user_id
    WHERE p.score_date = (SELECT MAX(score_date) FROM performance_scores)
    ORDER BY p.score_0_to_100 ASC`)).rows;
  const avgScore = teamScores.length
    ? Math.round(teamScores.reduce((s, r) => s + r.score_0_to_100, 0) / teamScores.length) : 0;

  const pendingApprovals = (await query(
    `SELECT agent_name, action_type, priority FROM approval_queue WHERE status='pending' ORDER BY created_at DESC`
  )).rows;

  const vision = hierarchy.vision || { current_value: monthlyActual, target_value: 10000000, pct: 0 };

  const prompt = `You are the CEO Agent for Abiozen LLC, a US pharmaceutical API distributor targeting $10M revenue by Dec 31, 2026. Write today's executive briefing for ${ceo?.name || 'the CEO'}.

VISION PROGRESS: ${fmt(vision.current_value)} of ${fmt(vision.target_value)} (${vision.pct}%)
THIS MONTH: ${fmt(monthlyActual)} of ${fmt(monthlyTarget)} target
TEAM: avg score ${avgScore} across ${teamScores.length} scored members
MOST-BEHIND KPIS:
${bottlenecks.bottlenecks.map(b => `  - ${b.kpi}: ${b.pct}% (${b.actual}/${b.target})`).join('\n') || '  (none)'}
CROSS-TEAM BLOCKERS:
${deps.blockers.map(b => `  - [${b.severity}] ${b.summary}`).join('\n') || '  (none)'}
PENDING APPROVALS: ${pendingApprovals.length}

Return EXACTLY a JSON object, no other text:
{"summary":"2-3 sentence executive summary","wins":["win 1","win 2","win 3"],"risks":["risk 1","risk 2","risk 3"],"actions":[{"action":"specific action","owner":"name or role","revenue_impact":"high|medium|low","success_criterion":"measurable","confidence":85}]}
Provide EXACTLY 5 actions, ranked most revenue-impactful first. Every line must cite a number from the data above. Do not invent figures.`;

  let parsed = { summary: '', wins: [], risks: [], actions: [] };
  if (!dryRun) {
    const raw = await runClaudeAnalysis(prompt);
    const j = parseClaudeJSON(raw);
    if (j) parsed = {
      summary: j.summary || '',
      wins: Array.isArray(j.wins) ? j.wins : [],
      risks: Array.isArray(j.risks) ? j.risks : [],
      actions: Array.isArray(j.actions) ? j.actions.slice(0, 5) : [],
    };
  }

  const taskIds = [];
  if (!dryRun && ceo) {
    for (let i = 0; i < parsed.actions.length; i++) {
      const a = parsed.actions[i];
      const priority = i < 2 ? 'HIGH' : i < 4 ? 'MEDIUM' : 'LOW';
      const id = await createDailyTask({
        user_id: ceo.id, task_date: today,
        task_title: a.action || `CEO action ${i + 1}`,
        task_description: `Owner: ${a.owner || 'CEO'} · Success: ${a.success_criterion || '—'} · Revenue impact: ${a.revenue_impact || '—'}`,
        priority, source_kpi: 'kpi-vision', agent_name: AGENT,
        reasoning: `Ranked #${i + 1} of 5 by revenue impact in today's CEO briefing.`,
      });
      taskIds.push(id);
    }
    await logAgentActivity({
      agent_name: AGENT, action_type: 'ceo_briefing', user_id: ceo.id,
      reasoning: `Generated the executive briefing and ${parsed.actions.length} revenue-ranked actions for ${ceo.name}.`,
      source_kpi: 'kpi-vision',
      confidence_score: parsed.actions.length
        ? Math.round(parsed.actions.reduce((s, a) => s + (Number(a.confidence) || 70), 0) / parsed.actions.length)
        : 60,
      output_summary: (parsed.summary || 'CEO briefing generated').slice(0, 300),
    });
  }

  const result = {
    generated_at: new Date().toISOString(), date: today,
    ceo: ceo ? { id: ceo.id, name: ceo.name, email: ceo.email } : null,
    vision: { current: vision.current_value, target: vision.target_value, pct: vision.pct },
    month: { actual: monthlyActual, target: monthlyTarget },
    team_avg_score: avgScore, pending_approvals: pendingApprovals.length,
    ...parsed, task_ids: taskIds,
  };

  if (!dryRun && ceo?.email) {
    result.emailed = await sendEmail({
      to: ceo.email,
      subject: `CEO Briefing — ${today} · ${vision.pct}% to $10M`,
      html: renderEmail(result),
    });
    result.emailed_to = ceo.email;
  }
  return result;
}

module.exports = { runCEOBriefing };
