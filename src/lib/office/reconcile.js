// PlayNexa AI Office — R1 reconciliation: unresolved external attempts become visible incidents.
//
// ── WHAT IT DOES, AND THE MUCH LONGER LIST OF WHAT IT MUST NOT ──────────────
//
// It finds supplier claims that were written, never confirmed, and are older than the expected
// confirmation window. For each one it files exactly one durable exception saying so.
//
// It NEVER (ruling §12):
//
//   · resends anything
//   · marks a claim 'sent' based on age
//   · marks a claim 'failed' based on age
//   · deletes a claim
//   · manufactures a provider acknowledgement
//
// Age is a CADENCE, not evidence. Fifteen minutes without a confirmation does not mean the email
// failed, and it does not mean it succeeded — it means nobody knows, and that the not-knowing has
// lasted longer than it should. Saying exactly that, durably, is the whole job.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
//
// Platform invariant 2: every consequential autonomous writer needs an independently observable
// reconciliation. Claim-before-send converts a crash from "silently maybe sent" into a durable
// known-unknown — but a known-unknown nobody reads is just a row. Without this, the entire safety
// argument for the claim ordering terminates in a table nobody queries.
//
// ── ONE INCIDENT PER CLAIM, NOT ONE PER SCAN (ruling §13) ───────────────────
//
// The exception id is derived from the claim id, so repeated firings collide on the primary key
// and leave the SAME open incident rather than manufacturing a new critical alert every hour. An
// alert channel that cries every hour about one unresolved email is an alert channel people mute.
'use strict';

const scope = require('./scope');
const rfqClaim = require('../idempotency/supplier-rfq');

const WORKFLOW = 'hourly-send-reconciliation';

/**
 * Report unresolved external attempts. Read-mostly: the only write is an exception per claim.
 *
 * @param {object} opts { olderThanMinutes, limit, dryRun }
 * `dryRun` defaults TRUE, the same shape as recovery.reap — the acting mode belongs to the caller,
 * so importing this module can never file anything by itself.
 */
async function reconcile({ olderThanMinutes = 15, limit = 200, dryRun = true } = {}, deps = {}) {
  const query = (deps && deps.query) || require('../db').query;

  const unresolved = (await rfqClaim.unresolved(query, { olderThanMinutes })).slice(0, limit);
  const out = { examined: unresolved.length, filed: 0, alreadyOpen: 0, unattributable: 0,
    dryRun, items: [] };

  for (const c of unresolved) {
    // The company comes from the APPROVAL that authorized the attempt. An office exception is
    // company-scoped by K1, so a claim that cannot be attributed to a company cannot become one —
    // and inventing an attribution to make the report tidy would be worse than reporting the gap.
    const owner = await scope.bootstrapApprovalOwner(c.approval_id || null, deps);

    const item = {
      claimId: c.id, rfqId: c.rfq_id, supplierId: c.supplier_id, to: c.email_sent_to,
      claimedAt: c.claimed_at, error: c.error || null,
      approvalId: c.approval_id || null,
      minutesUnresolved: Math.round((Date.now() - new Date(c.claimed_at).getTime()) / 60000),
    };

    if (!owner) {
      // Pre-R1 claims from the legacy procurement path have no approval, so they have no office
      // company context. Counted and reported, never guessed at.
      out.unattributable += 1;
      item.status = 'unattributable_to_a_company';
      out.items.push(item);
      continue;
    }

    const exceptionId = `ex-unresolved-send-${c.id}`;
    item.exceptionId = exceptionId;

    if (dryRun) {
      item.status = 'would_file';
      out.items.push(item);
      continue;
    }

    const ctx = Object.freeze({
      companyId: owner.company_id, objectiveId: owner.objective_id, runId: owner.run_id,
    });
    try {
      await scope.openException(ctx, {
        id: exceptionId,
        runId: owner.run_id,
        source: 'office/reconcile',
        severity: 'critical',
        slaHours: 4,
        reason: `external supplier attempt ${c.id} has remained UNRESOLVED for `
          + `${item.minutesUnresolved} minutes. A durable claim exists for `
          + `(rfq ${c.rfq_id}, supplier ${c.supplier_id} → ${c.email_sent_to}) and no provider `
          + 'acknowledgement was ever recorded. This is NOT evidence that the email failed, and '
          + 'NOT evidence that it was delivered — the outcome is unknown and a human must '
          + 'establish what the supplier actually received. Nothing has been resent.'
          + (c.error ? ` Recorded error: ${c.error}` : ''),
      }, deps);
      out.filed += 1;
      item.status = 'filed';
    } catch (e) {
      if (e && e.code === '23505') {
        // Already filed for this claim. The same incident stays open rather than becoming a new
        // one — this collision IS the deduplication.
        out.alreadyOpen += 1;
        item.status = 'already_open';
      } else {
        item.status = `could_not_file: ${e.message}`;
        console.error(`[office/reconcile] ${c.id}: ${e.message}`);
      }
    }
    out.items.push(item);
  }

  return out;
}

module.exports = { reconcile, WORKFLOW };
