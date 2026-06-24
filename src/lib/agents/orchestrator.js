// Orchestrator — routes the morning briefing to specialized agents based on
// team segment and user timezone. Each cron fires one segment at the local
// time that matches that team's morning.
const crypto = require('crypto');
const { query } = require('../db');
const { mondayOf } = require('./goal-engine');
const { createDailyTask, logAgentActivity, enqueueApproval, getCEOUser, businessToday } = require('../agent-core');
const { sendEmail } = require('../mailer');
const { sendWhatsApp } = require('../whatsapp');
const { runCEOBriefing } = require('./ceo-agent');
const { runProcurementBriefing } = require('./procurement-agent');
const { runSalesBriefing } = require('./sales-agent');
const { runHRBriefing } = require('./hr-agent');

const AGENT = 'orchestrator';

// Create daily tasks for users in the given roles from their behind weekly KPIs.
// Skips a user who already has tasks for today so re-runs are idempotent.
async function generateKpiTasks(roles) {
  const today = businessToday();
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

// ── Performance Accountability System ────────────────────────────────────────

// Map a non-director role to the role of the director who manages them. Returns
// null when there is no director (e.g. dev_team has no dev_director — those
// users escalate to admin/CEO).
function getDirectorRole(roleKey) {
  if (['sales_team', 'account_manager'].includes(roleKey)) return 'sales_director';
  if (roleKey === 'procurement_team') return 'procurement_director';
  if (roleKey === 'recruitment_team') return 'recruitment_director';
  return null;
}

// Daily 4-component performance score per user. 100 points total:
//   40 — task_completion_score: completed/assigned x 40
//   30 — kpi_progress_score: weekly KPI actual/target x 30
//   20 — activity_score: did they log any activity today?
//   10 — response_score: did they complete any task today?
// Streak counters update from the previous day's row.
async function runPerformanceCheck({ dryRun = false, date } = {}) {
  const today = date || businessToday();
  const weekStart = mondayOf(new Date(today)).toISOString().slice(0, 10);
  const users = (await query(
    `SELECT id, name, role FROM users
     WHERE is_active=1 AND COALESCE(excluded_from_scoring, FALSE) = FALSE
     ORDER BY name`
  )).rows;

  const scored = [];
  for (const u of users) {
    // Component 1 — task completion.
    // Denominator (tasks_assigned): tasks assigned for this date by task_date,
    //   including ones still pending — they keep dragging the ratio on their due day.
    // Numerator (tasks_completed): tasks marked completed whose status change landed
    //   on this date, judged by daily_tasks.updated_at converted to America/Chicago
    //   (NOT task_date). So a task assigned Jun 1 but completed Jun 2 credits Jun 2,
    //   not Jun 1. updated_at is NULL for never-touched tasks, so a pending task can
    //   never count as done. The outer WHERE pulls the union of both sets so a task
    //   completed late (task_date != scored date) is still visible to the numerator.
    const t = (await query(
      `SELECT
         COUNT(*) FILTER (
           WHERE status='completed'
             AND (updated_at AT TIME ZONE 'America/Chicago')::date = $2::date
         )::int done,
         COUNT(*) FILTER (WHERE task_date::date = $2::date)::int total
       FROM daily_tasks
       WHERE user_id=$1
         AND (task_date::date = $2::date
              OR (status='completed'
                  AND (updated_at AT TIME ZONE 'America/Chicago')::date = $2::date))`,
      [u.id, today]
    )).rows[0];
    const tasks_assigned = t.total, tasks_completed = t.done;
    // Cap the ratio at 1.0: with the new windowing, completing leftovers from prior
    // days can push tasks_completed above tasks_assigned for the day — credit it, but
    // never let task_completion_score exceed its 40-point weight.
    const task_completion_score = tasks_assigned > 0
      ? Math.round(Math.min(1, tasks_completed / tasks_assigned) * 40)
      : 0;

    // Component 2 — KPI progress this week
    const k = (await query(
      `SELECT COALESCE(SUM(kpi_target),0) tgt, COALESCE(SUM(kpi_actual),0) act
       FROM weekly_kpis WHERE user_id=$1 AND week_start=$2`, [u.id, weekStart]
    )).rows[0];
    const weekly_kpi_pct = Number(k.tgt) > 0
      ? Math.min(100, Math.round((Number(k.act) / Number(k.tgt)) * 100))
      : 0;
    const kpi_progress_score = Math.round((weekly_kpi_pct / 100) * 30);

    // Component 3 — activity. A manual activity_logs entry today satisfies this,
    // OR (Issue 2 fix) completing at least one task today now also counts as activity,
    // so finishing assigned work no longer leaves activity at 0. Max still 20.
    const a = parseInt((await query(
      `SELECT COUNT(*) c FROM activity_logs WHERE user_id=$1 AND log_date=$2`, [u.id, today]
    )).rows[0].c, 10);
    const activity_score = (a > 0 || tasks_completed > 0) ? 20 : 0;

    // Component 4 — response (any task completed today)
    const response_score = tasks_completed > 0 ? 10 : 0;

    const total_score = task_completion_score + kpi_progress_score + activity_score + response_score;

    // Streaks — read the user's most recent prior row (before today)
    const prev = (await query(
      `SELECT total_score, consecutive_days_below_60, consecutive_days_above_80
       FROM performance_scores
       WHERE user_id=$1 AND score_date < $2 AND COALESCE(is_weekly_summary,0)=0
       ORDER BY score_date DESC LIMIT 1`, [u.id, today]
    )).rows[0];
    const prevBelow = (prev && prev.consecutive_days_below_60) || 0;
    const prevAbove = (prev && prev.consecutive_days_above_80) || 0;
    const consecutive_days_below_60 = total_score < 60 ? prevBelow + 1 : 0;
    const consecutive_days_above_80 = total_score > 80 ? prevAbove + 1 : 0;

    if (!dryRun) {
      await query(
        `INSERT INTO performance_scores
           (id, user_id, score_date, score_0_to_100, total_score,
            task_completion_score, kpi_progress_score, activity_score, response_score,
            tasks_assigned, tasks_completed, weekly_kpi_pct,
            consecutive_days_below_60, consecutive_days_above_80,
            is_weekly_summary, created_at)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,NOW())
         ON CONFLICT (user_id, score_date) DO UPDATE
           SET score_0_to_100 = EXCLUDED.score_0_to_100,
               total_score = EXCLUDED.total_score,
               task_completion_score = EXCLUDED.task_completion_score,
               kpi_progress_score = EXCLUDED.kpi_progress_score,
               activity_score = EXCLUDED.activity_score,
               response_score = EXCLUDED.response_score,
               tasks_assigned = EXCLUDED.tasks_assigned,
               tasks_completed = EXCLUDED.tasks_completed,
               weekly_kpi_pct = EXCLUDED.weekly_kpi_pct,
               consecutive_days_below_60 = EXCLUDED.consecutive_days_below_60,
               consecutive_days_above_80 = EXCLUDED.consecutive_days_above_80`,
        [crypto.randomUUID(), u.id, today, total_score,
         task_completion_score, kpi_progress_score, activity_score, response_score,
         tasks_assigned, tasks_completed, weekly_kpi_pct,
         consecutive_days_below_60, consecutive_days_above_80]
      );
    }

    scored.push({
      user_id: u.id, name: u.name, role: u.role, total_score,
      task_completion_score, kpi_progress_score, activity_score, response_score,
      tasks_assigned, tasks_completed, weekly_kpi_pct,
      consecutive_days_below_60, consecutive_days_above_80,
    });
  }

  // Sunday weekly summary — average of the last 5 daily scores
  if (!dryRun && new Date(today).getUTCDay() === 0) {
    for (const u of users) {
      const rows = (await query(
        `SELECT total_score FROM performance_scores
         WHERE user_id=$1 AND score_date >= $2 AND score_date <= $3 AND COALESCE(is_weekly_summary,0)=0
         ORDER BY score_date DESC LIMIT 5`,
        [u.id, weekStart, today]
      )).rows;
      if (!rows.length) continue;
      const avg = Math.round(rows.reduce((s, r) => s + (Number(r.total_score) || 0), 0) / rows.length);
      await query(
        `INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100, total_score, is_weekly_summary, notes, created_at)
         VALUES ($1, $2, $3, $4, $4, 1, $5, NOW())
         ON CONFLICT (user_id, score_date) DO UPDATE
           SET total_score = EXCLUDED.total_score,
               score_0_to_100 = EXCLUDED.score_0_to_100,
               is_weekly_summary = 1, notes = EXCLUDED.notes`,
        [crypto.randomUUID(), u.id, today, avg, 'weekly avg of ' + rows.length + ' days']
      );
    }
  }

  if (!dryRun) {
    await logAgentActivity({
      agent_name: 'orchestrator', action_type: 'performance_check',
      reasoning: `Scored ${scored.length} users for ${today}.`,
      source_kpi: 'kpi-vision', confidence_score: 90,
      output_summary: `Avg ${Math.round(scored.reduce((s, x) => s + x.total_score, 0) / (scored.length || 1))} across ${scored.length} users`,
    });
  }
  return { date: today, count: scored.length, scored };
}

// Escalation tiers — read each user's latest score + streak and send the
// appropriate notifications. Idempotent: runs after runPerformanceCheck and
// uses the freshly-written row.
async function runEscalationCheck({ dryRun = false, date } = {}) {
  const today = date || businessToday();

  // Weekend skip — hold escalation noise on Sat/Sun (business day derived from
  // `today`, already the America/Chicago date). Scores are still written by
  // runPerformanceCheck; we just don't fire alerts.
  const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0=Sun ... 6=Sat
  if (dow === 0 || dow === 6) {
    if (!dryRun) await logAgentActivity({
      agent_name: 'orchestrator', action_type: 'escalation_check',
      reasoning: `Skipped — weekend (${today}).`,
      source_kpi: 'kpi-vision', output_summary: 'weekend skip',
    });
    return { date: today, count: 0, actions: [], skipped: 'weekend' };
  }

  const ceo = await getCEOUser();
  // Ramp-up grace: exclude accounts younger than 7 days from all escalation
  // levels so freshly-onboarded users aren't alerted while ramping.
  const rows = (await query(`
    SELECT p.*, u.name, u.role, u.email, u.whatsapp_number
    FROM performance_scores p JOIN users u ON u.id = p.user_id
    WHERE p.score_date = $1 AND COALESCE(p.is_weekly_summary,0)=0 AND u.is_active=1
      AND COALESCE(u.excluded_from_scoring, FALSE) = FALSE
      AND (u.created_at IS NULL OR u.created_at::timestamptz <= NOW() - INTERVAL '7 days')
  `, [today])).rows;

  const actions = [];
  const ceoDigest = []; // L3/L4 CEO-bound items → one digest email at the end
  for (const r of rows) {
    const score = Number(r.total_score) || 0;
    const days_below = Number(r.consecutive_days_below_60) || 0;
    const tasks_phrase = `${r.tasks_assigned - r.tasks_completed} task(s) pending`;
    let level = 0;

    if (score < 50 && days_below >= 5) level = 4;
    else if (score < 60 && days_below >= 3) level = 3;
    else if (score < 60 && days_below >= 2) level = 2;
    else if (score < 70 && days_below >= 1) level = 1;
    if (level === 0) continue;

    const userMsg = `Hi ${r.name} — your performance score today is ${score}/100. ${tasks_phrase}. Please review your KPIs and finish today's pending tasks.`;

    if (!dryRun) {
      if (level === 1) {
        // Reminder to the user
        if (r.email) await sendEmail({ to: r.email, subject: `Performance reminder — ${score}/100 today`, html: `<p>${userMsg}</p><p style="color:#666;font-size:12px">View your tasks at ${process.env.BASE_URL || 'https://playbookos-production.up.railway.app'}/#my-tasks</p>` });
        if (r.whatsapp_number) await sendWhatsApp(r.whatsapp_number, userMsg, { user_id: r.user_id, message_type: 'reminder' });
      } else if (level === 2) {
        // Warning to user + notify their director
        if (r.email) await sendEmail({ to: r.email, subject: `⚠️ Performance warning — ${score}/100 for ${days_below} days`, html: `<p>${userMsg}</p><p>This is day ${days_below} below target. Your manager has been notified.</p>` });
        if (r.whatsapp_number) await sendWhatsApp(r.whatsapp_number, '⚠️ ' + userMsg, { user_id: r.user_id, message_type: 'warning' });
        const dirRole = getDirectorRole(r.role);
        if (dirRole) {
          const directors = (await query(`SELECT email FROM users WHERE role=$1 AND is_active=1`, [dirRole])).rows;
          for (const d of directors) {
            if (d.email) await sendEmail({ to: d.email, subject: `Team alert: ${r.name} below target for ${days_below} days`, html: `<p><strong>${r.name}</strong> (${r.role}) scored ${score}/100 today — ${days_below} days below 60.</p><p>${tasks_phrase}, weekly KPI ${r.weekly_kpi_pct}%.</p>` });
          }
        }
        await logAgentActivity({
          agent_name: 'orchestrator', action_type: 'performance_warning',
          user_id: r.user_id, reasoning: `${r.name} day ${days_below} below 60 (score ${score}).`,
          source_kpi: 'kpi-vision', confidence_score: 90,
          output_summary: 'Warning sent to user + director (level 2).',
          requires_approval: true,
        });
      } else if (level === 3) {
        ceoDigest.push({ name: r.name, role: r.role, score, days_below, level: 3, weekly_kpi_pct: r.weekly_kpi_pct });
        if (r.email) await sendEmail({ to: r.email, subject: `Performance escalation — ${score}/100`, html: `<p>${userMsg}</p><p>Day ${days_below} below 60 — this has been escalated to leadership for review.</p>` });
        if (r.whatsapp_number) await sendWhatsApp(r.whatsapp_number, '🚨 Day ' + days_below + ' below target. Escalated to leadership.', { user_id: r.user_id, message_type: 'escalation' });
        await enqueueApproval({
          agent_name: 'orchestrator', action_type: 'performance_review',
          action_payload: { user: r.name, user_id: r.user_id, score, days_below, weekly_kpi_pct: r.weekly_kpi_pct, reasoning: `${r.name} day ${days_below} below 60` },
          requested_for_user_id: ceo ? ceo.id : null, priority: 'HIGH',
        });
      } else if (level === 4) {
        ceoDigest.push({ name: r.name, role: r.role, score, days_below, level: 4, weekly_kpi_pct: r.weekly_kpi_pct });
        await enqueueApproval({
          agent_name: 'orchestrator', action_type: 'performance_critical',
          action_payload: { user: r.name, user_id: r.user_id, score, days_below },
          requested_for_user_id: ceo ? ceo.id : null, priority: 'HIGH',
        });
      }
    }

    actions.push({ user_id: r.user_id, name: r.name, role: r.role, score, days_below, level });
  }

  // One digest email to the CEO covering every L3/L4 item, instead of one mail
  // per user. User-direct and director-direct emails already went out above.
  if (!dryRun && ceo?.email && ceoDigest.length) {
    ceoDigest.sort((a, b) => b.level - a.level || a.score - b.score); // critical first, then lowest score
    const crit = ceoDigest.filter(d => d.level === 4).length;
    const rowsHtml = ceoDigest.map(d =>
      `<tr>
         <td style="padding:4px 8px">${d.level === 4 ? '🚨 ' : ''}${d.name}</td>
         <td style="padding:4px 8px;color:#666">${d.role}</td>
         <td style="padding:4px 8px;font-weight:700;color:${d.score < 50 ? '#dc2626' : '#EF9F27'}">${d.score}/100</td>
         <td style="padding:4px 8px">day ${d.days_below} below target</td>
         <td style="padding:4px 8px">KPI ${d.weekly_kpi_pct}%</td>
         <td style="padding:4px 8px">L${d.level}</td>
       </tr>`).join('');
    await sendEmail({
      to: ceo.email,
      subject: `PlaybookOS — ${ceoDigest.length} performance escalation${ceoDigest.length === 1 ? '' : 's'} for ${today}${crit ? ` (${crit} critical)` : ''}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:680px;color:#1a1a2e">
        <h2 style="font-size:18px;color:#1B3A6B;margin:0 0 4px">Performance escalations — ${today}</h2>
        <p style="font-size:13px;color:#444;margin:0 0 12px">${ceoDigest.length} team member(s) need review.${crit ? ` <strong>${crit} critical.</strong>` : ''}</p>
        <table style="border-collapse:collapse;font-size:13px;width:100%">
          <thead><tr style="background:#f1f5f9;text-align:left">
            <th style="padding:4px 8px">Name</th><th style="padding:4px 8px">Role</th><th style="padding:4px 8px">Score</th>
            <th style="padding:4px 8px">Streak</th><th style="padding:4px 8px">Weekly KPI</th><th style="padding:4px 8px">Level</th>
          </tr></thead><tbody>${rowsHtml}</tbody></table>
        <p style="font-size:11px;color:#888;margin-top:12px">L3 = 3+ days below 60 · L4 = 5+ days below 50. Individual users and their directors were notified separately.</p>
      </div>`,
    });
  }

  if (!dryRun && actions.length) {
    await logAgentActivity({
      agent_name: 'orchestrator', action_type: 'escalation_check',
      reasoning: `Fired ${actions.length} escalation(s) for ${today}.`,
      source_kpi: 'kpi-vision', confidence_score: 90,
      output_summary: actions.map(a => `${a.name} L${a.level} (${a.score})`).join(' | ').slice(0, 300),
    });
  }
  return { date: today, count: actions.length, actions };
}

module.exports = { runMorningBriefing, generateKpiTasks, runPerformanceCheck, runEscalationCheck, getDirectorRole };
