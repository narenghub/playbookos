// ── THE SEVEN SOURCES ────────────────────────────────────────────────────────
//
// One function per store, each returning raw decision items for decision-queue.js to normalise and
// order. They are separated from the aggregator so the aggregator can be tested without a database
// and these can be tested without the aggregator's ordering in the way.
//
// ── EVERY QUERY IS SCOPED THE WAY ITS OWN PAGE IS SCOPED ─────────────────────
//
// This surface shows a person work from seven different tiers at once, which makes it the obvious
// place to accidentally widen a read. It does not widen any:
//
//   • company-welded tables (office_approvals, review_tasks) take companyId, which comes from the
//     database via resolveCompany — never from a request parameter.
//   • daily_tasks is filtered to the asking user. A person's task list is theirs.
//   • the cross-tier sources (approval_queue, inquiries, performance escalations) are the ones the
//     existing pages already gate to admins, and the route gates this surface the same way.
//
// ── WHY `where` IS MANDATORY ON EVERY ITEM ───────────────────────────────────
//
// The queue performs nothing. An item that does not name the page owning its decision is a row the
// person cannot act on, so decision-queue.makeItem refuses it rather than rendering a dead end.

'use strict';

// LIMITS, AND WHY THEY ARE NOT SILENT.
//
// A LIMIT that trims rows invisibly is the same defect as a dropped source: the list is shorter and
// nothing looks wrong. Each source asks for CAP + 1 rows; if it gets CAP + 1 it reports the
// overflow as part of the source result, and the queue surfaces it. Nobody is told "12 waiting"
// when 400 are.
const CAP = 50;

function overflowNote(rows, label) {
  return rows.length > CAP
    ? `more than ${CAP} ${label} are waiting — this list is capped, so the count is a floor`
    : null;
}

/**
 * office_approvals — a PREPARED external action held before execution.
 *
 * THIS DOES NOT WRITE ITS OWN SQL, and the first version of it did. office_approvals is a kernel
 * table, and every kernel table name lives in src/lib/office/scope.js — the scope-discipline check
 * refused this file within minutes of it being written, which is the check doing exactly its job.
 * Its message is the argument: "a predicate written at the call site is a predicate somebody can
 * forget." A read that forgot `company_id` here would show one tenant another's held actions.
 *
 * scope.listPendingApprovals already returns precisely these rows, ordered by age, so there was
 * nothing to add to scope.js either.
 *
 * The CAP is therefore applied in JavaScript rather than as a LIMIT. Overflow is still detected and
 * still reported — the accessor returns the full set, so `rows.length > CAP` is if anything a more
 * direct measure than asking for CAP + 1.
 */
async function pendingApprovals(queryFn, { ctx, listPendingApprovals }) {
  const rows = await listPendingApprovals(ctx, { query: queryFn });
  return {
    items: rows.slice(0, CAP).map((row) => ({
      id: `approval:${row.id}`,
      kind: 'approval',
      source: 'office_approvals',
      title: `Approve or reject: ${row.action_kind}`,
      // `reason` is the field approval.prepare() refuses to be created without, precisely because
      // it is what the approver reads. It is the item's whole substance.
      detail: row.reason,
      // An approval holds an action that is already prepared and cannot proceed. Whatever is on
      // the other side of it — a supplier, a contracting officer — is waiting now.
      blocks_external: true,
      created_at: row.created_at,
      owner: row.owner_user_id,
      where: { page: 'agent-control', label: 'Review approval', anchor: row.id },
    })),
    note: overflowNote(rows, 'approvals'),
  };
}

/** approval_queue — an agent proposal awaiting admin review. */
async function pendingAgentActions(queryFn) {
  const r = await queryFn(
    `SELECT id, agent_name, action_type, priority, created_at
       FROM approval_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ${CAP + 1}`);
  return {
    items: r.rows.slice(0, CAP).map((row) => ({
      id: `agent:${row.id}`,
      kind: 'agent_action',
      source: 'approval_queue',
      title: `${row.agent_name} proposes: ${row.action_type}`,
      detail: row.priority ? `priority ${row.priority}` : null,
      // NOT blocking. The header of office/approval.js records what this queue actually is: the
      // orchestrator sends and THEN enqueues, so these rows are a record of things already done.
      // Treating them as holding something back would push real blockers down the list.
      blocks_external: false,
      created_at: row.created_at,
      where: { page: 'agent-control', label: 'Review proposal', anchor: row.id },
    })),
    note: overflowNote(r.rows, 'agent proposals'),
  };
}

/** review_tasks — a blocked qualification criterion on a federal notice. */
async function openReviewTasks(queryFn, { companyId }) {
  const r = await queryFn(
    `SELECT id, title, detail, priority, due_date, status, owner_user_id, created_at
       FROM review_tasks
      WHERE company_id = $1 AND status IN ('open','in_progress','blocked')
      ORDER BY created_at ASC
      LIMIT ${CAP + 1}`, [companyId]);
  return {
    items: r.rows.slice(0, CAP).map((row) => ({
      id: `review:${row.id}`,
      kind: 'review',
      source: 'review_tasks',
      title: row.title,
      detail: [row.detail, row.status === 'blocked' ? 'BLOCKED' : null].filter(Boolean).join(' · ') || null,
      blocks_external: false,
      deadline: row.due_date || null,
      created_at: row.created_at,
      owner: row.owner_user_id,
      where: { page: 'prpa-tracker', label: 'Open review task', anchor: row.id },
    })),
    note: overflowNote(r.rows, 'review tasks'),
  };
}

/** daily_tasks — today's agent-assigned work for the asking person. */
async function myTasks(queryFn, { userId, today }) {
  const r = await queryFn(
    `SELECT id, task_title, task_description, priority, created_at
       FROM daily_tasks
      WHERE user_id = $1 AND task_date = $2 AND status = 'pending'
      ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at ASC
      LIMIT ${CAP + 1}`, [userId, today]);
  return {
    items: r.rows.slice(0, CAP).map((row) => ({
      id: `task:${row.id}`,
      kind: 'task',
      source: 'daily_tasks',
      title: row.task_title,
      detail: row.task_description,
      blocks_external: false,
      created_at: row.created_at,
      owner: userId,
      where: { page: 'my-tasks', label: 'Open task', anchor: row.id },
    })),
    note: overflowNote(r.rows, 'tasks'),
  };
}

/** inquiries — a buyer who wrote in and has had no answer. */
async function awaitingBuyers(queryFn) {
  // 'new' has had no reply at all; 'human_requested' is the inquiry agent handing one back
  // deliberately. Both mean a named person outside the company is waiting.
  const r = await queryFn(
    `SELECT id, molecule_name, buyer_name, buyer_company, status, quantity_requested, quantity_unit, created_at
       FROM inquiries
      WHERE status IN ('new','human_requested')
      ORDER BY created_at ASC
      LIMIT ${CAP + 1}`);
  return {
    items: r.rows.slice(0, CAP).map((row) => {
      const qty = row.quantity_requested
        ? `${row.quantity_requested}${row.quantity_unit || ''}` : null;
      return {
        id: `inquiry:${row.id}`,
        kind: 'inquiry',
        source: 'inquiries',
        title: `Reply to ${row.buyer_name || row.buyer_company || 'a buyer'}`
             + (row.molecule_name ? ` — ${row.molecule_name}` : ''),
        detail: [row.buyer_company, qty, row.status === 'human_requested'
          ? 'the agent handed this back for a person' : null].filter(Boolean).join(' · ') || null,
        blocks_external: true,
        created_at: row.created_at,
        where: { page: 'inquiry-agent', label: 'Open inquiry', anchor: row.id },
      };
    }),
    note: overflowNote(r.rows, 'inquiries'),
  };
}

/** performance_scores — a score that escalated to the CEO. */
async function escalations(queryFn, { today }) {
  const r = await queryFn(
    `SELECT p.id, p.user_id, p.score_0_to_100, p.claude_coaching_note, p.score_date, u.name, u.email
       FROM performance_scores p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.escalated_to_admin = 1 AND p.score_date = $1
      ORDER BY p.score_0_to_100 ASC
      LIMIT ${CAP + 1}`, [today]);
  return {
    items: r.rows.slice(0, CAP).map((row) => ({
      id: `escalation:${row.id}`,
      kind: 'escalation',
      source: 'performance_scores',
      title: `${row.name || row.email || row.user_id} escalated at ${row.score_0_to_100}/100`,
      detail: row.claude_coaching_note,
      blocks_external: false,
      created_at: row.score_date,
      owner: row.user_id,
      where: { page: 'team', label: 'Open performance', anchor: row.user_id },
    })),
    note: overflowNote(r.rows, 'escalations'),
  };
}

/**
 * The federal board — notices whose advice says to act.
 *
 * This does NOT query the tracker. It calls board.buildBoard, which is the one place that decides
 * what is relevant, what is in the actionable window, what it is worth and what to do about it.
 * A separate query here would be a second definition of "needs action" — see the note at the top
 * of board.js for what that has already cost this board.
 */
async function actionableContracts(queryFn, { companyId, now, buildBoard }) {
  const { opportunities } = await buildBoard(queryFn, companyId, { now });
  const acting = opportunities.filter((o) => o.advice && /^(BID NOW|PREPARE)$/.test(o.advice.verdict));
  return {
    items: acting.slice(0, CAP).map((o) => ({
      id: `contract:${o.id}`,
      kind: 'contract',
      source: 'federal_board',
      title: `${o.advice.verdict}: ${o.title}`,
      // The headline ALREADY counts the blockers ("4 things stand between this and a bid"), and
      // each blocked_by entry is a full sentence of reasoning. Joining them produced a four-line
      // paragraph per row and a queue nobody would scan — the opposite of what one list is for.
      // The reasoning is one click away on the notice itself.
      detail: [o.advice.headline, o.agency].filter(Boolean).join(' · ') || null,
      // A closing date is a clock, not somebody waiting. It ranks on the deadline rungs.
      blocks_external: false,
      // An UNCONFIRMED deadline is not used as a date. The board already distinguishes the two,
      // and ranking a notice as "closes in 4 days" on a date nobody verified would put invented
      // urgency at the top of the list — which is the one position where it does most damage.
      deadline: o.deadline_confirmed ? o.response_deadline : null,
      created_at: null,
      where: { page: 'prpa-tracker', label: 'Open notice', anchor: o.id },
    })),
    note: overflowNote(acting, 'contracts needing action'),
  };
}

/**
 * Assemble the source list for decision-queue.collect().
 *
 * Each entry's `run` returns the raw items. The `notes` array collects every overflow warning so
 * the route can report a capped list as capped.
 */
function sourcesFor(queryFn, { ctx, companyId, userId, today, now = new Date(), buildBoard,
  listPendingApprovals, notes = [] }) {
  const wrap = (name, fn) => ({
    name,
    run: async () => {
      const { items, note } = await fn();
      if (note) notes.push({ source: name, note });
      return items;
    },
  });

  return [
    wrap('office_approvals', () => pendingApprovals(queryFn, { ctx, listPendingApprovals })),
    wrap('federal_board', () => actionableContracts(queryFn, { companyId, now, buildBoard })),
    wrap('inquiries', () => awaitingBuyers(queryFn)),
    wrap('review_tasks', () => openReviewTasks(queryFn, { companyId })),
    wrap('approval_queue', () => pendingAgentActions(queryFn)),
    wrap('daily_tasks', () => myTasks(queryFn, { userId, today })),
    wrap('performance_scores', () => escalations(queryFn, { today })),
  ];
}

module.exports = {
  sourcesFor, CAP,
  pendingApprovals, pendingAgentActions, openReviewTasks, myTasks,
  awaitingBuyers, escalations, actionableContracts,
};
