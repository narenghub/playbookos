// Shared utilities for the PlaybookOS AI Agent System.
// Every agent action is recorded in agent_activity_log before it executes;
// high-impact actions are routed to approval_queue instead of auto-running.
const crypto = require('crypto');
const { query } = require('./db');

// Today's date as YYYY-MM-DD in America/Chicago (the business timezone), so "today"
// is stable for the team regardless of the server's UTC offset. en-CA → YYYY-MM-DD.
function businessToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Write one row to agent_activity_log. Returns the new row id. This MUST be
// called before an agent action takes effect so the activity feed is complete.
async function logAgentActivity({
  agent_name,
  action_type,
  user_id = null,
  reasoning = '',
  source_kpi = null,
  confidence_score = null,
  output_summary = '',
  requires_approval = false,
}, client = null) {
  const id = crypto.randomUUID();
  const exec = client ? (sql, params) => client.query(sql, params) : query;
  await exec(
    `INSERT INTO agent_activity_log
       (id, agent_name, action_type, user_id, reasoning, source_kpi,
        confidence_score, output_summary, requires_approval, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [
      id, agent_name, action_type, user_id, reasoning, source_kpi,
      confidence_score == null ? null : Math.round(confidence_score),
      output_summary, requires_approval ? 1 : 0,
    ]
  );
  return id;
}

// Decide whether an action is high-impact and must go through human approval.
// High-impact = procurement spend over $1,000, outreach to a new buyer segment,
// or any hiring / coaching-escalation recommendation.
function isHighImpact({ action_type = '', action_payload = {} } = {}) {
  const t = String(action_type).toLowerCase();
  const p = action_payload || {};
  const spend = Number(p.amount || p.estimated_value || p.spend || 0);
  if ((t.includes('procurement') || t.includes('sourcing') || t.includes('purchase')) && spend > 1000) {
    return true;
  }
  if (t.includes('outreach') && (p.new_segment === true || p.is_new_segment === true)) {
    return true;
  }
  if (t.includes('hir') || t.includes('recruit') || t.includes('escalat') || t.includes('reassign')) {
    return true;
  }
  return false;
}

// Push an action onto the approval_queue (status 'pending'). Returns the row id.
async function enqueueApproval({
  agent_name,
  action_type,
  action_payload = {},
  requested_for_user_id = null,
  priority = 'MEDIUM',
}) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO approval_queue
       (id, agent_name, action_type, action_payload, requested_for_user_id, status, priority, created_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,NOW())`,
    [id, agent_name, action_type, JSON.stringify(action_payload), requested_for_user_id, priority]
  );
  return id;
}

// Create a daily_tasks row for a user. Returns the row id.
async function createDailyTask({
  user_id,
  task_date = businessToday(),
  task_title,
  task_description = '',
  priority = 'MEDIUM',
  source_kpi = null,
  agent_name = null,
  reasoning = '',
  comment = null,
}, client = null) {
  const id = crypto.randomUUID();
  const pri = ['HIGH', 'MEDIUM', 'LOW'].includes(String(priority).toUpperCase())
    ? String(priority).toUpperCase()
    : 'MEDIUM';
  // Optional admin assignment comment — write-once context the assignee sees on
  // the task. Distinct from last_comment (status-change comments). Mirrors the
  // comment pattern: trim, whitespace-only → null, hard cap 500 (defense in depth;
  // the endpoints already 400 on >500).
  let assignComment = null;
  if (comment != null) {
    const t = String(comment).trim();
    assignComment = t.length ? t.slice(0, 500) : null;
  }
  const exec = client ? (sql, params) => client.query(sql, params) : query;
  await exec(
    `INSERT INTO daily_tasks
       (id, user_id, task_date, task_title, task_description, priority, status,
        source_kpi, agent_name, reasoning, assign_comment, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,NOW())`,
    [id, user_id, task_date, task_title, task_description, pri, source_kpi, agent_name, reasoning, assignComment]
  );
  return id;
}

// Resolve the CEO user (the briefing target). Prefers super_admin, then admin.
async function getCEOUser() {
  const row = (await query(
    `SELECT id, email, name, role, timezone FROM users
     WHERE is_active=1 AND role IN ('super_admin','admin')
     ORDER BY CASE role WHEN 'super_admin' THEN 0 ELSE 1 END, created_at
     LIMIT 1`
  )).rows[0];
  return row || null;
}

// Extract the outermost JSON value from a Claude response string. Picks
// whichever bracket appears first ({ for objects, [ for arrays) so a prompt
// that asks for an object containing arrays doesn't get its inner array
// extracted by mistake — the previous behaviour was checking arrays first,
// which broke every agent returning {headline, body, hashtags:[...]} or
// {summary, wins:[], risks:[], actions:[]} shapes (CEO, sales, LinkedIn).
function parseClaudeJSON(text) {
  if (!text) return null;
  // Strip ```json ... ``` code fences if present
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  if (firstBrace === -1 && firstBracket === -1) return null;
  let start, closeChar;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace; closeChar = '}';
  } else {
    start = firstBracket; closeChar = ']';
  }
  const end = cleaned.lastIndexOf(closeChar);
  if (end === -1 || end < start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

module.exports = {
  businessToday,
  logAgentActivity,
  isHighImpact,
  enqueueApproval,
  createDailyTask,
  getCEOUser,
  parseClaudeJSON,
};
