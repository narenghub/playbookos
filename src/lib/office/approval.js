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
async function release(ctx, { approvalId, releasedBy, consequential = true,
  objectiveId = null, objectiveBudgetUsd = null, capUsd = undefined }, deps = {}) {
  assertContext(ctx);
  if (!approvalId) return { released: false, reason: 'no_approval_id' };
  if (!releasedBy) return { released: false, reason: 'no_releasing_actor' };

  // ── THE FROZEN SIGNATORY MUST STILL HOLD AUTHORITY (ruling §8) ───────────
  //
  // The payload freezes who the letter is from, which is right: a human approves THIS message
  // signed by THIS representative, and the frozen text must not be quietly rewritten later.
  //
  // But that leaves a second question. What if the approved signatory LEAVES between approval and
  // release? The letter would then go out over the name of someone who is gone — the very incident
  // this exists because of, arriving by a different route and after a human had legitimately
  // approved it.
  //
  // So the payload is NOT re-derived and NOT rewritten. The authority it asserts is REVALIDATED:
  // is the person this letter claims to be from still active? If not, release refuses, files a
  // durable exception, and the action needs re-preparing and re-approving with the current
  // signatory. That distinction matters — this is not regenerating the communication, it is
  // checking that the authority the frozen communication represents still exists.
  //
  // Non-consequential releases are not gated: they transmit nothing to anybody.
  //
  // CHECKED BEFORE THE COST GATE, deliberately. Both are release preconditions and either can
  // refuse, but when both would, "the person this letter is from has left" is the useful answer
  // and "spend cannot be proven" is a distraction. Ordering it second also made it unmeasurable:
  // the first version of its fixture reported budget_enterprise and the signatory check never ran,
  // which is the same masking that hid mutation control M4.
  if (consequential) {
    const pending = await scope.approvalReleaseState(ctx, approvalId, deps).catch(() => null);
    const payload = pending && pending.action_payload;
    const signedEmail = payload && payload.signed_by_email;
    const signedUserId = payload && payload.signed_by_user_id;

    // ── NO RECORDED SIGNATORY IS A REFUSAL, NOT A SKIP ────────────────────
    //
    // Found by reading production: the two approvals prepared before the signatory fix carry no
    // signed_by_* fields at all, and this check read "if a signatory is recorded, verify it" — so
    // for exactly those actions it verified NOTHING. An approval whose payload cannot say who the
    // letter is from is the case with the LEAST evidence, and it was getting the least scrutiny.
    //
    // It is also not hypothetical: both of those letters are signed, in their body, by a
    // Procurement Director who has left. The control that exists to stop that would have waved
    // them through because the fact it checks was absent.
    //
    // Fail closed. A send whose representative cannot be established requires re-preparation.
    if (!signedEmail && !signedUserId) {
      let exceptionId = null;
      try {
        exceptionId = `ex-release-nosignatory-${approvalId}`;
        await scope.openException(ctx, {
          id: exceptionId, runId: ctx.runId, source: 'office/approval',
          reason: `consequential release of ${approvalId} blocked: its frozen payload records NO `
            + 'signatory, so there is no way to verify that whoever this letter claims to be from '
            + 'still holds authority. The payload is NOT rewritten — this action predates signatory '
            + 'recording and needs re-preparation with the current signatory.',
          severity: 'critical', slaHours: 4,
        }, deps);
      } catch (_) { exceptionId = null; }
      return { released: false, reason: 'signatory_not_recorded',
        detail: 'the approved payload records no signatory, so its authority cannot be verified; '
          + 're-preparation is required',
        needs_repreparation: true, exception_id: exceptionId };
    }

    {
      const query = (deps && deps.query) || require('../db').query;
      const still = (await query(
        `SELECT id, name, email, role, is_active FROM users
          WHERE ($1::text IS NOT NULL AND id = $1) OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2))
          ORDER BY is_active DESC LIMIT 1`,
        [signedUserId || null, signedEmail || null]
      )).rows[0];

      if (!still || Number(still.is_active) !== 1) {
        let exceptionId = null;
        try {
          exceptionId = `ex-release-signatory-${approvalId}`;
          await scope.openException(ctx, {
            id: exceptionId, runId: ctx.runId, source: 'office/approval',
            reason: `consequential release of ${approvalId} blocked: the approved signatory `
              + `${payload.signed_by_name || signedEmail} is no longer active, so this letter would `
              + 'go out over the name of someone who has left. The payload is NOT rewritten — a new '
              + 'preparation and a new human approval are required with the current signatory.',
            severity: 'critical', slaHours: 4,
          }, deps);
        } catch (_) { exceptionId = null; }
        return { released: false, reason: 'signatory_no_longer_active',
          detail: `${payload.signed_by_name || signedEmail} is not an active user; re-preparation required`,
          signatory: { name: payload.signed_by_name || null, email: signedEmail || null },
          needs_repreparation: true, exception_id: exceptionId };
      }
    }
  }

  // ── THE FAIL-CLOSED COST GATE (ruling §9) ────────────────────────────────
  //
  // `consequential` DEFAULTS TO TRUE. A caller that forgets to say what it is doing gets the
  // stricter path, because the direction of that mistake matters: treating a supplier email as
  // non-consequential is unrecoverable, while treating an internal step as consequential merely
  // asks a human.
  //
  // Unknown AI cost does not block the CALL — that would destroy the evidence a human reviews —
  // it blocks the ACT. And a blocked release files an exception rather than returning quietly,
  // because a consequential action that silently did not happen is indistinguishable from one
  // that did.
  if (consequential) {
    const budget = require('./budget');
    let gate;
    try {
      gate = await budget.consequentialReleaseGate(ctx, {
        runId: ctx.runId, objectiveId, objectiveBudgetUsd,
        ...(capUsd === undefined ? {} : { capUsd }),
      }, deps);
    } catch (e) {
      // An unreadable budget is not permission to act.
      return { released: false, reason: 'budget_gate_unavailable', detail: e.message };
    }
    if (!gate.allow) {
      let exceptionId = null;
      try {
        exceptionId = `ex-release-${gate.reason}-${approvalId}`;
        await scope.openException(ctx, {
          id: exceptionId, runId: ctx.runId, source: 'office/approval',
          reason: `consequential release of ${approvalId} blocked (${gate.reason}): ${gate.detail}`,
          severity: 'critical', slaHours: 4,
        }, deps);
      } catch (_) { exceptionId = null; }
      return { released: false, reason: gate.reason, detail: gate.detail, exception_id: exceptionId, gate };
    }
  }

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
  // SUPERSEDED IS TERMINAL AND SAYS SO. The claim predicate already refuses it — it demands
  // status='approved' — so this adds no protection; it adds an answer. "not_approved" for an
  // action a human deliberately superseded reads like a missing approval rather than a completed
  // governance decision, and the operator then looks for the wrong thing.
  if (cur.status === 'superseded') {
    return { released: false, reason: 'superseded', status: cur.status,
      detail: 'this approval was superseded after approval and before any external execution; it '
        + 'is terminal and a new preparation attempt is required' };
  }
  return { released: false, reason: 'not_approved', status: cur.status };
}

module.exports = { prepare, release };
