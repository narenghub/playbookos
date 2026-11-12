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
    // Durable responsibility, before the provider call.
    claim: () => write({ outcome: 'CLAIMED', status: 'claimed', claimed_at: new Date() }),
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
    const mayHaveLeft = SCHEMA.MAY_HAVE_LEFT.reduce((a, k) => a + (counts[k] || 0), 0);
    const blocked = counts.BLOCKED || 0;
    return {
      transport: t, observed: true, counts, blocked, may_have_left: mayHaveLeft,
      state: mayHaveLeft > 0 ? 'TRANSMITTED' : (blocked > 0 ? 'BLOCKED_ONLY' : 'NO_TRANSMISSION'),
    };
  });
}

module.exports = {
  beginAttempt, priorClaim, executionByTransport, digestOf, hasSchema, _resetSchemaCache,
  UNSAFE_TO_REPEAT,
  OUTCOMES: SCHEMA.OUTCOMES, MAY_HAVE_LEFT: SCHEMA.MAY_HAVE_LEFT,
  DEFINITELY_NOT_SENT: SCHEMA.DEFINITELY_NOT_SENT,
};
