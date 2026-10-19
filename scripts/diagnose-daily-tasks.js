#!/usr/bin/env node
// ── WHY NOBODY IS GETTING ASSIGNED TASKS ─────────────────────────────────────
//
//   railway ssh 'node scripts/diagnose-daily-tasks.js'
//   railway ssh 'node scripts/diagnose-daily-tasks.js --days=14'
//
// Read-only. Writes nothing, creates no tasks, sends no email.
//
// ── THE FAILURE IT EXISTS TO NAME ───────────────────────────────────────────
//
// A team member reported that self-assigned tasks have not worked "for a long time", and every
// obvious check says the system is healthy: the cron is registered, it fires, and it logs
//
//     [CRON] US team briefing done — ran: sales, us_team_tasks
//
// That line is printed whether it created forty tasks or none. generateKpiTasks() builds tasks
// ONLY from weekly_kpis rows that are behind target; a user with no KPI rows for the current week
// produces zero tasks and returns successfully. Nothing errors, nothing alerts, and the log reads
// exactly as it does on a good day.
//
// Two more ways to get silence, both invisible from the log:
//
//   · ROLE NOT IN ANY SEGMENT. The segment lists in orchestrator.js are allowlists. sales_director,
//     admin and super_admin appear in none of them, so those users can never be assigned anything
//     no matter how many KPIs they have.
//   · ALREADY HAS A TASK TODAY. generateKpiTasks skips a user entirely if they already have any
//     task for today — by design, but it means a single manually assigned task suppresses the
//     whole day's generation for that person.
//
// And one that hides an actual error: runMorningBriefing wraps each sub-routine in a try/catch
// that records the error on the result object and simply omits that label from `ran`. A thrown
// exception therefore shows up as a SHORTER log line, not as a failure.
//
// This script answers, per person: are you eligible, do you have KPIs, and did you get tasks.
'use strict';

const { initDB, query } = require('../src/lib/db');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const DAYS = Math.max(1, Math.min(90, parseInt(arg('days', '14'), 10) || 14));

// The segment lists, copied from src/lib/agents/orchestrator.js. Kept here deliberately rather
// than imported: the point is to compare what the orchestrator COVERS against who exists, and an
// import would hide a divergence by construction.
const SEGMENTS = {
  'procurement_ist  (22:30 CST daily)': ['procurement_team', 'procurement_director'],
  'dev_seo_ist      (01:30 CST daily)': ['dev_team', 'seo_specialist'],
  'us_team          (08:00 CST Mon-Fri)': ['sales_team', 'account_manager', 'support_team',
    'recruitment_team', 'recruitment_director', 'sales_director', 'business_dev'],
};
const COVERED = new Set(Object.values(SEGMENTS).flat());

// Roles that are SUPPOSED to receive nothing, so the report can tell "excluded on purpose" from
// "forgotten". Those two looked identical before — which is how business_dev went unnoticed.
const EXEMPT = {
  super_admin: 'gets the 07:00 CEO briefing instead',
  admin: 'administrative, no KPIs of their own',
  partner: 'external — we do not set a partner\'s agenda',
};

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

function mondayOf(d) {
  const x = new Date(d);
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

async function main() {
  await initDB();

  const todayRow = (await query(
    `SELECT (NOW() AT TIME ZONE 'America/Chicago')::date::text AS d`)).rows[0];
  const today = todayRow.d;
  const weekStart = mondayOf(new Date(today));

  say(`\n── daily task assignment · diagnosis  (read-only)`);
  say(`   business date ${today} (America/Chicago) · week starting ${weekStart}\n`);

  // ── 1. WHO IS ELIGIBLE AT ALL ────
  const users = (await query(
    `SELECT id, name, email, role, is_active FROM users WHERE is_active = 1 ORDER BY role, name`)).rows;

  const uncovered = users.filter((u) => !COVERED.has(u.role) && !EXEMPT[u.role]);
  const byDesign = users.filter((u) => !COVERED.has(u.role) && EXEMPT[u.role]);
  say(`   ${users.length} active user(s)\n`);
  say('   SEGMENT COVERAGE');
  for (const [label, roles] of Object.entries(SEGMENTS)) {
    const n = users.filter((u) => roles.includes(u.role)).length;
    say(`      ${pad(label, 38)} ${n} user(s)   [${roles.join(', ')}]`);
  }
  if (byDesign.length) {
    say(`\n   ${byDesign.length} user(s) receive no tasks BY DESIGN:`);
    for (const u of byDesign) say(`        ${pad(u.name, 24)} ${pad(u.role, 20)} ${EXEMPT[u.role]}`);
  }
  if (uncovered.length) {
    say(`\n   ⚠ ${uncovered.length} active user(s) are in NO segment and can never be assigned a task:`);
    for (const u of uncovered) say(`        ${pad(u.name, 24)} ${pad(u.role, 20)} ${u.email}`);
    say(`      The segment lists in orchestrator.js are allowlists. A role missing from all three`);
    say(`      produces no error and no task — it is simply never looked at. src/lib/agents/`);
    say(`      task-segment-coverage.test.js now fails at commit time on exactly this.`);
  } else {
    say(`\n   ✓ every non-exempt active user is in a segment`);
  }
  say();

  // ── 2. DO THEY HAVE THE FUEL — weekly_kpis ────
  //
  // This is the one that matters. generateKpiTasks turns KPIs into tasks; with no KPI rows for
  // the week it creates nothing and reports success.
  let kpiTable = true;
  let kpis = [];
  try {
    kpis = (await query(
      `SELECT user_id, COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status <> 'met')::int behind
         FROM weekly_kpis WHERE week_start = $1 GROUP BY user_id`, [weekStart])).rows;
  } catch (e) { kpiTable = false; say(`   ⚠ weekly_kpis unreadable: ${e.message}\n`); }

  const kpiBy = Object.fromEntries(kpis.map((k) => [k.user_id, k]));

  if (kpiTable) {
    const anyWeek = (await query(
      `SELECT week_start, COUNT(*)::int c, COUNT(DISTINCT user_id)::int users
         FROM weekly_kpis GROUP BY 1 ORDER BY 1 DESC LIMIT 6`)).rows;
    say('   WEEKLY KPIs — the only thing that becomes a task');
    if (!anyWeek.length) {
      say(`      ✗ weekly_kpis is EMPTY. Nothing can generate a task.`);
    } else {
      for (const w of anyWeek) {
        const mark = w.week_start === weekStart ? '→' : ' ';
        say(`      ${mark} week ${w.week_start}   ${pad(w.c, 5)} row(s)   ${w.users} user(s)`);
      }
      if (!anyWeek.some((w) => w.week_start === weekStart)) {
        say(`\n      ✗ NOTHING for the current week (${weekStart}).`);
        say(`        Weekly KPIs are written by the goal engine, Mondays 08:00 UTC:`);
        say(`          assignWeeklyKPIsForAll() in the weekly-mon-8utc-goal-engine cron.`);
        say(`        Until that runs for a week, every task generator that week produces zero`);
        say(`        tasks and reports success.`);
      }
    }
    say();
  }

  // ── 3. WHAT ACTUALLY LANDED ────
  const recent = (await query(
    `SELECT task_date::text AS d, COUNT(*)::int c,
            COUNT(*) FILTER (WHERE agent_name IS NOT NULL)::int by_agent,
            COUNT(DISTINCT user_id)::int users
       FROM daily_tasks
      WHERE task_date::date >= ($1::date - $2::int)
      GROUP BY 1 ORDER BY 1 DESC`, [today, DAYS])).rows;

  say(`   TASKS CREATED, LAST ${DAYS} DAYS`);
  if (!recent.length) say(`      ✗ none at all`);
  for (const r of recent) {
    say(`      ${r.d}   ${pad(r.c, 4)} task(s)   ${pad(r.by_agent, 4)} by an agent   ${r.users} user(s)`);
  }
  const agentTotal = recent.reduce((a, r) => a + r.by_agent, 0);
  if (recent.length && agentTotal === 0) {
    say(`\n      ⚠ every task in this window was created by hand. The agent has generated none.`);
  }
  say();

  // ── 4. PER PERSON ────
  say('   PER PERSON — eligible? has KPIs? got tasks?');
  say(`      ${pad('name', 22)}${pad('role', 20)}${pad('segment', 10)}${pad('kpis wk', 9)}${pad('tasks today', 12)}tasks ${DAYS}d`);
  for (const u of users) {
    const seg = COVERED.has(u.role) ? 'yes' : (EXEMPT[u.role] ? 'n/a' : 'NO');
    const k = kpiBy[u.id];
    const kTxt = !kpiTable ? '?' : (k ? `${k.behind}/${k.total}` : '0');
    const t = (await query(
      `SELECT COUNT(*) FILTER (WHERE task_date::date = $2::date)::int today,
              -- "window" is a RESERVED WORD in Postgres; as a bare alias it breaks the parse
              -- with "syntax error at or near FROM", which points at the wrong line entirely.
              COUNT(*) FILTER (WHERE task_date::date >= ($2::date - $3::int))::int recent
         FROM daily_tasks WHERE user_id = $1`, [u.id, today, DAYS])).rows[0];
    say(`      ${pad(u.name, 22)}${pad(u.role, 20)}${pad(seg, 10)}${pad(kTxt, 9)}${pad(t.today, 12)}${t.recent}`);
  }
  say();

  // ── 5. DID THE BRIEFING ACTUALLY RUN ────
  let acts = [];
  try {
    acts = (await query(
      `SELECT created_at, reasoning, output_summary FROM agent_activity_log
        WHERE action_type = 'morning_briefing'
        ORDER BY created_at DESC LIMIT 10`)).rows;
  } catch (_) { /* table may not exist on an older deploy */ }

  say('   LAST 10 MORNING BRIEFINGS (from agent_activity_log)');
  if (!acts.length) {
    say(`      ✗ none logged. Either the cron has not fired since the log existed, or the process`);
    say(`        is not running the schedule at all.`);
  }
  for (const a of acts) {
    const when = String(a.created_at).slice(0, 19).replace('T', ' ');
    say(`      ${when}  ${a.reasoning}`);
  }
  say();

  // ── 6. THE READ ────
  say('   WHAT THIS MEANS');
  const noKpiThisWeek = kpiTable && !kpis.length;
  if (noKpiThisWeek) {
    say(`      ✗ No weekly KPIs exist for ${weekStart}, so NOTHING can be generated this week.`);
    say(`        Fix the cause, not the symptom: run the goal engine so KPIs exist.`);
    say(`          railway ssh 'node -e "require(\\"./src/lib/kpi-engine\\").assignWeeklyKPIsForAll().then(console.log)"'`);
    say(`        Then the generator will have something to turn into tasks:`);
    say(`          POST /api/agent/tasks/generate   (or wait for the 08:00 CST weekday cron)`);
  } else if (kpiTable && kpis.length) {
    say(`      KPIs exist for this week (${kpis.length} user(s)). If tasks are still missing, the`);
    say(`      likely causes in order are: the person's role is in no segment (see above); they`);
    say(`      already had a task today, which makes the generator skip them entirely; or the`);
    say(`      sub-routine threw and was swallowed — runMorningBriefing records the error on its`);
    say(`      result and omits the label from "ran" rather than raising it.`);
  }
  if (uncovered.length) {
    say(`      ✗ ${uncovered.length} active user(s) are in no segment and will never be assigned anything.`);
  }
  say();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('diagnose-daily-tasks failed:', e && e.message ? e.message : e);
  process.exit(1);
});
