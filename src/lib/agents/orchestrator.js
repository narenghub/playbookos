// Orchestrator — routes the morning briefing to specialized agents based on
// team segment and user timezone. Each cron fires one segment at the local
// time that matches that team's morning.
const { query } = require('../db');
const { mondayOf } = require('./goal-engine');
const { createDailyTask, logAgentActivity } = require('../agent-core');
const { runCEOBriefing } = require('./ceo-agent');
const { runProcurementBriefing } = require('./procurement-agent');
const { runSalesBriefing } = require('./sales-agent');
const { runHRBriefing } = require('./hr-agent');

const AGENT = 'orchestrator';

// Create daily tasks for users in the given roles from their behind weekly KPIs.
// Skips a user who already has tasks for today so re-runs are idempotent.
async function generateKpiTasks(roles) {
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = mondayOf(new Date()).toISOString().slice(0, 10);
  const users = (await query(
    `SELECT id, name, role FROM users WHERE is_active=1 AND role = ANY($1)`, [roles]
  )).rows;
  let created = 0;
  for (const u of users) {
    const existing = parseInt((await query(
      `SELECT COUNT(*) c FROM daily_tasks WHERE user_id=$1 AND task_date=$2`, [u.id, today]
    )).rows[0].c, 10);
    if (existing > 0) continue;
    const kpis = (await query(
      `SELECT kpi_name, kpi_target, kpi_actual, kpi_unit FROM weekly_kpis
       WHERE user_id=$1 AND week_start=$2 AND status <> 'met'
       ORDER BY kpi_actual::float / NULLIF(kpi_target,0) ASC LIMIT 3`,
      [u.id, weekStart]
    )).rows;
    for (const k of kpis) {
      await createDailyTask({
        user_id: u.id, task_date: today,
        task_title: `Advance KPI: ${k.kpi_name}`,
        task_description: `Weekly target ${k.kpi_target}${k.kpi_unit ? ' ' + k.kpi_unit : ''}, currently ${k.kpi_actual}. Move this forward today.`,
        priority: 'MEDIUM', source_kpi: k.kpi_name, agent_name: AGENT,
        reasoning: `Auto-generated: this weekly KPI is behind target for ${u.name}.`,
      });
      created++;
    }
  }
  return { role_users: users.length, tasks_created: created };
}

// Run the morning briefing for one segment. Segments:
//   ceo            — CEO briefing (7am CST)
//   procurement_ist— procurement team, India morning (9am IST / 10:30pm CST)
//   dev_seo_ist    — dev + SEO team, India afternoon (1pm IST / 1:30am CST)
//   us_team        — US team (8am CST); also HR review on Mondays
//   all            — every segment (used by the manual trigger endpoint)
async function runMorningBriefing({ segment = 'all' } = {}) {
  const out = { segment, generated_at: new Date().toISOString(), ran: [] };
  const isMonday = new Date().getDay() === 1;
  const safe = async (label, fn) => {
    try { out[label] = await fn(); out.ran.push(label); }
    catch (e) { out[label] = { error: e.message }; }
  };

  if (segment === 'ceo' || segment === 'all') {
    await safe('ceo', () => runCEOBriefing());
  }
  if (segment === 'procurement_ist' || segment === 'all') {
    await safe('procurement', () => runProcurementBriefing());
    await safe('procurement_tasks', () => generateKpiTasks(['procurement_team', 'procurement_director']));
  }
  if (segment === 'dev_seo_ist' || segment === 'all') {
    await safe('dev_seo_tasks', () => generateKpiTasks(['dev_team', 'seo_specialist']));
  }
  if (segment === 'us_team' || segment === 'all') {
    await safe('sales', () => runSalesBriefing());
    await safe('us_team_tasks', () => generateKpiTasks(
      ['sales_team', 'account_manager', 'support_team', 'recruitment_team', 'recruitment_director']));
  }
  if ((segment === 'us_team' || segment === 'all') && isMonday) {
    await safe('hr', () => runHRBriefing());
  }

  await logAgentActivity({
    agent_name: AGENT, action_type: 'morning_briefing',
    reasoning: `Orchestrated the '${segment}' morning briefing; ran: ${out.ran.join(', ') || 'none'}.`,
    source_kpi: 'kpi-vision', confidence_score: 90,
    output_summary: `Segment '${segment}' briefing complete — ${out.ran.length} sub-routines ran.`,
  });
  return out;
}

module.exports = { runMorningBriefing, generateKpiTasks };
