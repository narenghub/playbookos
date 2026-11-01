// PlayNexa AI Office — K7 minimum: approval BEFORE the action.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
//   prepared action → durable approval item → human approves → release
//   NEVER: send → ask approval afterward.
//
// The Phase 1 audit found the existing approval queue doing exactly the forbidden thing:
// `orchestrator.js:364-368` sends the escalation email and WhatsApp and THEN enqueues the
// approval. That queue is a record of a thing already done. This module is the opposite shape, and
// the ordering is structural rather than conventional:
//
//   • prepare() stores the complete action payload and returns an id. It performs NOTHING.
//   • release() is the ONLY way to obtain the payload for execution, and it refuses unless the row
//     is `approved`. A caller that wants to act must come through it.
//   • the payload is IMMUTABLE after creation (database trigger), so the artefact a human read is
//     the artefact that gets executed. Without that, approving email text A and releasing email
//     text B would leave a row that reads "approved" either way.
//   • release() marks the row released, so an approval that was granted and never acted on is
//     distinguishable from one that was — and a second release of the same approval is refused,
//     which is what stops one human decision authorising two sends.
//
// ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
//
// It does not decide. `decideApproval` in scope.js is the human's path and is company-scoped, so
// one company cannot approve another's work. It does not notify — K7's full queue, SLA escalation
// and notification wiring are later. The minimum needed for the vertical slice is that a
// consequential action CANNOT HAPPEN without a prior recorded human decision.

const scope = require('./scope');
const { assertContext } = require('./context');

/**
 * Record an action that requires approval. Performs nothing.
 *
 * Returns { approvalId, status: 'pending' }.
 */
async function prepare(ctx, { id, actionKind, actionPayload, reason, ownerUserId = null }, deps = {}) {
  assertContext(ctx);
  if (!ctx.runId) throw new Error('prepare requires a context carrying a runId: an approval must attach to the run that will act');
  if (!actionKind) throw new Error('prepare requires an actionKind');
  if (!reason) throw new Error('prepare requires a reason: it is what the approver reads');
  if (actionPayload === undefined || actionPayload === null) {
    throw new Error('prepare requires the complete actionPayload: an approval of nothing cannot be released into something');
  }

  const approvalId = id || `ap-${ctx.runId}-${actionKind}`;
  const row = await scope.requestApproval(ctx, {
    id: approvalId,
    runId: ctx.runId,
    actionKind,
    actionPayload,
    reason,
    ownerUserId,
  }, deps);
  return { approvalId: row.id, status: row.status, created_at: row.created_at };
}

/**
 * Obtain the approved payload in order to act on it. THE ONLY ROUTE TO EXECUTION.
 *
 * Returns { released: true, actionKind, actionPayload } or { released: false, reason, status }.
 * Never throws for a refusal — a refusal is an expected outcome, and a caller that treats an
 * exception as the only failure mode would act on an undefined payload.
 */
async function release(ctx, { approvalId, releasedBy }, deps = {}) {
  assertContext(ctx);
  if (!approvalId) return { released: false, reason: 'no_approval_id' };
  if (!releasedBy) return { released: false, reason: 'no_releasing_actor' };

  // The arbitrated claim lives in scope.js, which owns every kernel table name. The
  // scope-discipline check refused to exempt this file and was right to: approval.js is product
  // code, and a kernel predicate at the call site is a predicate somebody can forget.
  const r = await scope.claimApprovalRelease(ctx, { approvalId, releasedBy }, deps);

  if (r) {
    return {
      released: true,
      approvalId: r.id,
      actionKind: r.action_kind,
      actionPayload: r.action_payload,
      approvedBy: r.resolved_by,
      approvedAt: r.resolved_at,
    };
  }

  // Nothing was claimed. Say precisely why.
  const cur = await scope.approvalReleaseState(ctx, approvalId, deps);

  if (!cur) return { released: false, reason: 'no_such_approval_for_this_company' };
  if (cur.released_at) {
    return { released: false, reason: 'already_released', status: cur.status,
      released_at: cur.released_at, released_by: cur.released_by };
  }
  return { released: false, reason: 'not_approved', status: cur.status };
}

module.exports = { prepare, release };
