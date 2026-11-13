// ── THE OUTBOUND EXECUTION LEDGER ────────────────────────────────────────────
//
//   const att = await beginAttempt({ transport, provider, to, subject, workflow, agent, ... });
//   if (!att.ok) return;                       // fail-closed: no record, no consequential send
//   await att.blocked(reason, scope)           // policy refused — nothing was transmitted
//   await att.claim()                          // durable responsibility, BEFORE the provider call
//   await att.accepted(messageId) | .rejected(error) | .unknown(error)
//
// One record per attempt, for every transport. CEO authorization 2026-11-10, S1.1.
//
// ── WHY THE RECORD COMES BEFORE THE PROVIDER CALL ────────────────────────────
//
// If the row is written after, a crash between the send and the write leaves a message that went
// and no evidence that it did. The next run reads "not attempted" and sends again — which is
// exactly the duplicate-RFQ defect P0.3 fixed in supplier_outreach_log, in a different place.
//
// So `claim()` happens first and is durable. A row that says CLAIMED and never progressed is the
// honest description of a crash mid-send: something may have left and nobody knows. That is worth
// far more than silence, and it is why OUTCOME_UNKNOWN exists as a state rather than being folded
// into failure.
//
// ── FAIL CLOSED, AND WHAT THAT COSTS ─────────────────────────────────────────
//
// If the ledger cannot be written, a CONSEQUENTIAL message is refused. "Logging failure cannot
// silently permit transmission" is item 5 of the authorization, and it is the same rule the kill
// switch already applies to an unreadable kill-state: no invariant, no consequential action.
//
// Observability mail (`consequential: false`) is the documented exception, for the same reason the
// kill switch exempts it — the channel that reports breakage must not be taken out by breakage.
// Its failure to record is logged loudly and it proceeds.

'use strict';

const crypto = require('crypto');
const SCHEMA = require('./ledger-schema');

let _query = null;
function q(deps) {
  if (deps && deps.query) return deps.query;
  if (!_query) _query = require('../db').query;
  return _query;
}

/**
 * A digest of what is being sent — never the body.
 *
 * It answers the only question an audit needs about content: is the artefact that was approved the
 * artefact that went? Comparing two digests answers it; storing the HTML does not, and storing the
 * HTML is how a log becomes a copy of everyone's correspondence.
 */
function digestOf({ to, subject, html, text }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([to, subject, html || text || '']))
    .digest('hex')
    .slice(0, 32);
}

// Has the migration been applied? Cached per process after the first successful check: this is
// consulted on every send and the answer only changes when somebody runs a migration.
let schemaReady = null;
async function hasSchema(deps = {}) {
  if (schemaReady === true) return true;
  try {
    const r = await q(deps)(
      `SELECT COUNT(*)::int n FROM information_schema.columns
        WHERE table_name = $1 AND column_name = ANY($2)`,
      [SCHEMA.TABLE, SCHEMA.ADDED_COLUMNS]);
    schemaReady = r.rows[0].n === SCHEMA.ADDED_COLUMNS.length;
    return schemaReady;
  } catch (e) {
    console.error(`[ledger] could not determine schema state: ${e && e.message}`);
    return false;
  }
}

// Test seam. Production never calls this; the controls do, because a cached "ready" from one
// fixture database must not leak into the next.
function _resetSchemaCache() { schemaReady = null; }

/**
 * Open an attempt. Returns { ok, id, correlationId, blocked, claim, accepted, rejected, unknown }.
 *
 * `ok:false` means NOTHING MAY BE SENT — the record could not be created and the message is
 * consequential. The caller must return without touching a provider.
 */
async function beginAttempt({
  transport, provider, to, subject, html, text,
  workflow = null, agent = null, companyId = null, approvalId = null, claimRef = null,
  consequential = true, correlationId = null,
} = {}, deps = {}) {
  if (!transport) throw new Error('beginAttempt requires a transport: an unattributed send is unauditable');
  const id = crypto.randomUUID();
  const corr = correlationId || crypto.randomUUID();
  const recipients = Array.isArray(to) ? to.join(', ') : String(to == null ? '' : to);

  const write = async (fields) => {
    try {
      const cols = Object.keys(fields);
      await q(deps)(
        `UPDATE ${SCHEMA.TABLE} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...cols.map((c) => fields[c])]);
      return true;
    } catch (e) {
      console.error(`[ledger] ${transport} attempt ${id}: ${e && e.message}`);
      return false;
    }
  };

  const ready = await hasSchema(deps);
  if (!ready) {
    const why = `the outbound ledger schema is not applied (run scripts/migrate-outbound-ledger.js)`;
    if (consequential) {
      console.error(`[LEDGER FAIL-CLOSED] ${transport} → ${recipients}: ${why}. NOTHING WAS SENT.`);
      return { ok: false, id: null, correlationId: corr, error: why };
    }
    console.error(`[ledger] ${why} — proceeding because this message is observability, not action`);
  }

  if (ready) {
    try {
      await q(deps)(
        `INSERT INTO ${SCHEMA.TABLE}
           (id, to_email, subject, status, transport, provider, workflow, agent, company_id,
            correlation_id, outcome, approval_id, payload_digest, claim_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PREPARED',$11,$12,$13)`,
        [id, recipients, subject || '(no subject)', 'prepared', transport, provider || null,
          workflow, agent, companyId, corr, approvalId, digestOf({ to: recipients, subject, html, text }),
          claimRef]);
    } catch (e) {
      console.error(`[ledger] could not open an attempt for ${transport}: ${e && e.message}`);
      if (consequential) {
        return { ok: false, id: null, correlationId: corr,
          error: `the outbound ledger refused the attempt record: ${e && e.message}` };
      }
    }
  }

  return {
    ok: true,
    id,
    correlationId: corr,
    // Policy refused. The scope is MANDATORY — the database refuses a BLOCKED row without one,
    // because a refusal nobody can explain is indistinguishable from a bug.
    blocked: (reason, scope) => write({
      outcome: 'BLOCKED', status: 'stopped_by_policy',
      stop_scope: scope || 'unspecified', error_message: reason || null,
    }),
    // ── DURABLE RESPONSIBILITY, AND THE ARBITRATION POINT ──────────────────
    //
    // Returns { ok: true } if THIS attempt took responsibility, { ok: false, lost: true } if
    // another attempt under the same claim_ref already had it. THE CALLER MUST CHECK, and must not
    // touch a provider on ok:false — twelve concurrent dispatches under one key passed priorClaim
    // together and four of them sent, which is what this return value exists to prevent.
    //
    // The decision is the partial unique index on claim_ref, in one statement, because two
    // transactions can both read "no prior claim" before either writes. A unique violation here is
    // not an error to log and continue past: it is the answer.
    claim: async () => {
      try {
        const r = await q(deps)(
          `UPDATE ${SCHEMA.TABLE} SET outcome = 'CLAIMED', status = 'claimed', claimed_at = NOW()
            WHERE id = $1 RETURNING id`, [id]);
        if (!r.rows.length) {
          return { ok: false, lost: false,
            error: 'the attempt row vanished before it could be claimed' };
        }
        return { ok: true };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (/duplicate key|unique constraint|idx_email_log_one_claim_per_ref/i.test(msg)) {
          console.warn(`[ledger] ${transport} attempt ${id}: another attempt already holds `
            + `claim ${recipients ? '' : ''}${JSON.stringify(claimRef)} — refusing`);
          return { ok: false, lost: true,
            error: 'another attempt under this idempotency key already claimed responsibility' };
        }
        // Any other failure means responsibility was NOT recorded. A consequential send must not
        // proceed on an unrecorded claim, so this is a refusal too, not a warning.
        console.error(`[ledger] ${transport} attempt ${id}: claim failed: ${msg}`);
        return { ok: false, lost: false, error: `the claim could not be recorded: ${msg}` };
      }
    },
    accepted: (messageId) => write({
      outcome: 'PROVIDER_ACCEPTED', status: 'sent',
      provider_message_id: messageId || null, provider_responded_at: new Date(),
    }),
    rejected: (error) => write({
      outcome: 'PROVIDER_REJECTED', status: 'failed',
      error_message: String(error || '').slice(0, 1000), provider_responded_at: new Date(),
    }),
    // The provider did not answer, or answered without an id. NEVER retried automatically.
    unknown: (error) => write({
      outcome: 'OUTCOME_UNKNOWN', status: 'unknown',
      error_message: String(error || '').slice(0, 1000),
    }),
  };
}

/**
 * Has a message under this claim_ref already got far enough that it may have left?
 *
 * Spec A milestone 5 needs this to make dispatch idempotent, and "idempotent" here means a repeat
 * is REFUSED, not retried: Gmail cannot unsend and nor can Resend.
 *
 * What counts as "may have left" is deliberately wider than MAY_HAVE_LEFT. That list is for
 * reports and holds PROVIDER_ACCEPTED and OUTCOME_UNKNOWN. A row sitting at CLAIMED is a process
 * that claimed responsibility and then stopped — a crash mid-send — and the honest reading of it
 * is "something may have gone and nobody knows", which is exactly the case where sending again to
 * find out turns one uncertain message into two real ones. RECONCILED is included for the same
 * reason: a human established what happened, and a machine must not re-open that on its own.
 *
 * So the refusing set is everything except DEFINITELY_NOT_SENT, computed by subtraction from
 * OUTCOMES rather than listed by hand — an outcome added later is then unsafe by default instead
 * of silently permitted.
 *
 * THROWS if the answer cannot be established (schema absent, query failure). The caller must treat
 * a throw as a refusal: returning null here would read as "no prior claim" and permit the send.
 *
 * @returns {Promise<{id,outcome,status,claimedAt}|null>} the prior row, or null if there is none
 */
const UNSAFE_TO_REPEAT = Object.freeze(
  SCHEMA.OUTCOMES.filter((o) => !SCHEMA.DEFINITELY_NOT_SENT.includes(o)));

async function priorClaim(claimRef, { excludeId = null } = {}, deps = {}) {
  if (!claimRef) throw new Error('priorClaim requires a claimRef');

  const ready = await hasSchema(deps);
  if (!ready) {
    throw new Error('the outbound ledger schema is not applied, so a duplicate cannot be ruled out');
  }

  const r = await q(deps)(
    `SELECT id, outcome, status, claimed_at
       FROM ${SCHEMA.TABLE}
      WHERE claim_ref = $1
        AND outcome = ANY($2)
        AND ($3::text IS NULL OR id::text <> $3)
      ORDER BY claimed_at DESC NULLS LAST
      LIMIT 1`,
    [claimRef, UNSAFE_TO_REPEAT, excludeId]);

  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { id: row.id, outcome: row.outcome, status: row.status, claimedAt: row.claimed_at };
}

/**
 * Coverage and execution, reported SEPARATELY (authorization item 4).
 *
 * "This transport has never been observed" and "this transport sent nothing" are different facts,
 * and a report that cannot tell them apart invites reading an unmonitored sender as a quiet one.
 * A transport with no rows is reported UNKNOWN, never zero.
 */
async function executionByTransport(transports, { sinceISO } = {}, deps = {}) {
  const rows = await q(deps)(
    `SELECT transport, outcome, COUNT(*)::int n
       FROM ${SCHEMA.TABLE}
      WHERE sent_at >= $1 AND transport IS NOT NULL
      GROUP BY transport, outcome`, [sinceISO]);

  // ── ONE PROVIDER SUBMISSION IS ONE TRANSMISSION ───────────────────────────
  //
  // Counting rows double-counts every send, and that became true the moment the sender moved out
  // of process: the application writes its own audit row and the service writes its own, by
  // design, because they are separate audit responsibilities and neither may be removed. Two
  // records, one submission.
  //
  // So transmissions are counted on DISTINCT correlation_id, which dispatch() sets to a stable
  // identifier derived from the idempotency key and passes to the service, which writes the same
  // value. One logical submission therefore has one correlation across both rows, and a retry
  // under the same key lands on the same correlation too.
  //
  // A row with correlation_id NULL cannot be correlated with anything, so it counts ON ITS OWN —
  // COUNT(DISTINCT col) ignores NULLs, which would silently drop it, and a dropped send is the one
  // direction a containment report must never err in. Hence the explicit NULL arm.
  const submissions = await q(deps)(
    `SELECT transport,
            COUNT(DISTINCT correlation_id) FILTER (WHERE correlation_id IS NOT NULL)
              + COUNT(*) FILTER (WHERE correlation_id IS NULL) AS n
       FROM ${SCHEMA.TABLE}
      WHERE sent_at >= $1 AND transport IS NOT NULL
        AND outcome = ANY($2)
      GROUP BY transport`,
    [sinceISO, SCHEMA.MAY_HAVE_LEFT]);

  const submitted = new Map(submissions.rows.map((r) => [r.transport, Number(r.n) || 0]));

  // ── THE GAP BETWEEN THE TWO BUCKETS ───────────────────────────────────────
  //
  // CLAIMED is in NEITHER MAY_HAVE_LEFT nor DEFINITELY_NOT_SENT, and that is right — it means
  // responsibility was taken and what happened next is unknown. But it also meant a crashed
  // mid-send was INVISIBLE to this report: counted as neither sent nor not-sent, so a transport
  // that died between the claim and the response read as NO_TRANSMISSION while a message may have
  // gone. Found by simulating exactly that state.
  //
  // Unresolved claims are therefore counted and reported SEPARATELY. Not folded into transmissions
  // — "one provider submission is one transmission" and a claim is not a submission — and not
  // dropped either. RECONCILED is the outcome a reconciliation job writes when it resolves one.
  const unresolved = await q(deps)(
    `SELECT transport,
            COUNT(DISTINCT correlation_id) FILTER (WHERE correlation_id IS NOT NULL)
              + COUNT(*) FILTER (WHERE correlation_id IS NULL) AS n
       FROM ${SCHEMA.TABLE}
      WHERE sent_at >= $1 AND transport IS NOT NULL
        AND outcome = 'CLAIMED'
      GROUP BY transport`, [sinceISO]);
  const unresolvedBy = new Map(unresolved.rows.map((r) => [r.transport, Number(r.n) || 0]));

  const seen = new Map();
  for (const r of rows.rows) {
    if (!seen.has(r.transport)) seen.set(r.transport, {});
    seen.get(r.transport)[r.outcome] = r.n;
  }

  return transports.map((t) => {
    const counts = seen.get(t) || null;
    if (!counts) {
      return { transport: t, observed: false, state: 'UNKNOWN',
        why: 'no ledger rows — this transport has not been observed, which is NOT the same as having sent nothing' };
    }
    // Rows that may have left, which is what it has always been, and is now reported as what it
    // is: a count of RECORDS, not of messages.
    const rowsMayHaveLeft = SCHEMA.MAY_HAVE_LEFT.reduce((a, k) => a + (counts[k] || 0), 0);
    const blocked = counts.BLOCKED || 0;
    const transmissions = submitted.get(t) || 0;

    return {
      transport: t, observed: true, counts, blocked,
      // THE ANSWER TO "how many messages may have reached somebody".
      transmissions,
      // The record count, kept and renamed rather than removed: the gap between the two is how a
      // reader notices that a layer stopped writing its row.
      rows_may_have_left: rowsMayHaveLeft,
      // Retained under its original name because existing callers and checks read it, and it must
      // keep meaning the same thing to them — but it now carries the de-duplicated figure, which
      // is what every one of those callers was trying to ask for.
      may_have_left: transmissions,
      audit_records_per_submission: transmissions > 0
        ? Number((rowsMayHaveLeft / transmissions).toFixed(2)) : null,
      // Claims nobody resolved. A crash mid-send leaves one, and it must not read as silence.
      unresolved_claims: unresolvedBy.get(t) || 0,
      state: transmissions > 0
        ? 'TRANSMITTED'
        : ((unresolvedBy.get(t) || 0) > 0
          ? 'UNRESOLVED_CLAIM'
          : (blocked > 0 ? 'BLOCKED_ONLY' : 'NO_TRANSMISSION')),
    };
  });
}

/**
 * Every submission in the window, with the rows that recorded it. For reconciliation and for the
 * controls that assert reporting matches reality.
 *
 * One entry per correlation_id, so `length` is the number of provider submissions that may have
 * left. An uncorrelated row appears as its own entry, for the reason given above.
 */
async function submissionsByCorrelation({ sinceISO, transports = null } = {}, deps = {}) {
  const res = await q(deps)(
    `SELECT COALESCE(correlation_id, 'uncorrelated:' || id::text) AS correlation,
            transport,
            COUNT(*)::int AS records,
            MIN(sent_at) AS first_seen,
            ARRAY_AGG(DISTINCT outcome) AS outcomes,
            ARRAY_AGG(DISTINCT claim_ref) FILTER (WHERE claim_ref IS NOT NULL) AS claim_refs
       FROM ${SCHEMA.TABLE}
      WHERE sent_at >= $1
        AND outcome = ANY($2)
        AND ($3::text[] IS NULL OR transport = ANY($3))
      GROUP BY correlation, transport
      ORDER BY first_seen`,
    [sinceISO, SCHEMA.MAY_HAVE_LEFT, transports]);
  return res.rows.map((r) => ({
    correlation: r.correlation, transport: r.transport, records: r.records,
    outcomes: r.outcomes || [], claim_refs: r.claim_refs || [], first_seen: r.first_seen,
  }));
}

module.exports = {
  beginAttempt, priorClaim, executionByTransport, submissionsByCorrelation,
  digestOf, hasSchema, _resetSchemaCache,
  UNSAFE_TO_REPEAT,
  OUTCOMES: SCHEMA.OUTCOMES, MAY_HAVE_LEFT: SCHEMA.MAY_HAVE_LEFT,
  DEFINITELY_NOT_SENT: SCHEMA.DEFINITELY_NOT_SENT,
};
