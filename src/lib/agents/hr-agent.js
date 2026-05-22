// HR Agent — weekly team-health review (Mondays).
// Reviews the last 7 days of performance scores, flags anyone below 60% for
// 3+ days, and has Claude recommend coaching, reassignment or escalation.
// Reassignment/escalation recommendations are routed to the approval queue.
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');
const { logAgentActivity, enqueueApproval, getCEOUser, parseClaudeJSON } = require('../agent-core');

const AGENT = 'hr-agent';

function renderEmail(date, rows, recs) {
  const teamRows = rows.map(r =>
    `<tr><td style="padding:6px 8px">${r.name}</td><td style="padding:6px 8px;color:#666">${r.role}</td>
     <td style="padding:6px 8px;text-align:right;font-weight:700;color:${r.avg < 60 ? '#E24B4A' : r.avg < 75 ? '#EF9F27' : '#1D9E75'}">${r.avg}</td>
     <td style="padding:6px 8px;text-align:right">${r.days_below_60}</td></tr>`).join('');
  const recRows = recs.length
    ? recs.map(r => `<div style="border-left:3px solid #E24B4A;padding:6px 10px;margin:6px 0;background:#fef2f2">
        <strong>${r.user}</strong> — <span style="text-transform:uppercase;font-size:11px">${r.recommendation}</span>
        <div style="font-size:12px;color:#666">${r.reasoning || ''}</div></div>`).join('')
    : '<div style="font-size:13px;color:#1D9E75">No team members flagged this week.</div>';
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">
    <div style="background:#1B3A6B;padding:20px;border-radius:8px 8px 0 0;color:#fff">
      <h2 style="margin:0;font-size:20px">Weekly Team Health — ${date}</h2>
      <p style="margin:6px 0 0;color:#9FE1CB;font-size:13px">HR Agent · Abiozen LLC</p>
    </div>
    <div style="border:1px solid #e0e0e0;border-top:none;padding:20px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">Member</th><th style="padding:6px 8px;text-align:left">Role</th><th style="padding:6px 8px;text-align:right">7-day avg</th><th style="padding:6px 8px;text-align:right">Days &lt;60</th></tr>
        ${teamRows || '<tr><td colspan="4" style="padding:8px;color:#666">No scores recorded in the last 7 days.</td></tr>'}
      </table>
      <div style="font-size:13px;font-weight:700;color:#E24B4A;margin-top:16px">RECOMMENDATIONS</div>
      ${recRows}
    </div>
  </div>`;
}

async function runHRBriefing({ dryRun = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const ceo = await getCEOUser();

  const scores = (await query(`
    SELECT u.id, u.name, u.role, p.score_date, p.score_0_to_100
    FROM performance_scores p JOIN users u ON u.id=p.user_id
    WHERE p.score_date >= (NOW() - INTERVAL '7 days')::date::text
    ORDER BY u.name, p.score_date`
  )).rows;

  const byUser = {};
  for (const s of scores) {
    if (!byUser[s.id]) byUser[s.id] = { id: s.id, name: s.name, role: s.role, scores: [] };
    byUser[s.id].scores.push(s.score_0_to_100);
  }
  const rows = Object.values(byUser).map(u => {
    const avg = u.scores.length ? Math.round(u.scores.reduce((a, b) => a + b, 0) / u.scores.length) : 0;
    const daysBelow = u.scores.filter(x => x < 60).length;
    return { ...u, avg, days_below_60: daysBelow };
  }).sort((a, b) => a.avg - b.avg);

  const flagged = rows.filter(r => r.days_below_60 >= 3);

  let recs = [];
  if (!dryRun && flagged.length) {
    const prompt = `You are the HR Agent for Abiozen LLC. The following team members scored below 60% on 3 or more days in the last 7 days:
${flagged.map(f => `  - ${f.name} (${f.role}): 7-day avg ${f.avg}, ${f.days_below_60} days below 60`).join('\n')}

For each, recommend exactly one of: "coaching", "reassignment", or "escalation".
Return EXACTLY a JSON array, no other text:
[{"user":"name","recommendation":"coaching|reassignment|escalation","reasoning":"one sentence","confidence":80}]`;
    const j = parseClaudeJSON(await runClaudeAnalysis(prompt));
    if (Array.isArray(j)) recs = j;
  }

  if (!dryRun) {
    for (const r of recs) {
      const rec = String(r.recommendation || '').toLowerCase();
      const flaggedUser = flagged.find(f => f.name === r.user);
      await logAgentActivity({
        agent_name: AGENT, action_type: `hr_${rec || 'review'}`,
        user_id: flaggedUser ? flaggedUser.id : null,
        reasoning: r.reasoning || `${r.user} flagged: sustained low performance.`,
        source_kpi: 'kpi-vision', confidence_score: Number(r.confidence) || 70,
        output_summary: `Recommendation for ${r.user}: ${rec}.`,
        requires_approval: rec === 'reassignment' || rec === 'escalation',
      });
      if (rec === 'reassignment' || rec === 'escalation') {
        await enqueueApproval({
          agent_name: AGENT, action_type: `hr_${rec}`,
          action_payload: { user: r.user, user_id: flaggedUser ? flaggedUser.id : null, reasoning: r.reasoning },
          requested_for_user_id: ceo ? ceo.id : null, priority: 'HIGH',
        });
      }
    }
  }

  let emailed = false;
  if (!dryRun && ceo?.email) {
    emailed = await sendEmail({
      to: ceo.email,
      subject: `Weekly Team Health — ${today} · ${flagged.length} flagged`,
      html: renderEmail(today, rows, recs),
    });
  }

  return {
    generated_at: new Date().toISOString(), date: today,
    team_size: rows.length, flagged: flagged.map(f => ({ name: f.name, role: f.role, avg: f.avg, days_below_60: f.days_below_60 })),
    recommendations: recs, emailed,
  };
}

module.exports = { runHRBriefing };
