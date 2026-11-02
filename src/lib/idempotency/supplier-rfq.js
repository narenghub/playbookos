// ── ONE RFQ PER SUPPLIER PER REQUEST, ENFORCED BY THE DATABASE ───────────────
//
// P0.3 item 1 (G6). The defect this replaces, verified at procurement-agent.js:342-370 on 27 Oct:
//
//   SELECT id FROM supplier_outreach_log WHERE rfq_id=$1 AND supplier_id=$2   ← dedup read
//   …generate the email, then sendEmail()…                                    ← the external action
//   INSERT INTO supplier_outreach_log …                                       ← the record, AFTER
//
// and `supplier_outreach_log` carried only `CREATE INDEX idx_outreach_rfq (rfq_id, status)` — not
// unique. Two ways that double-emails a real supplier:
//
//   1. the send succeeds and the INSERT fails, or the process dies between them. The next run reads
//      "not contacted" and sends again. The lost record IS the duplicate.
//   2. two runs overlap — the weekly Tuesday cron plus a manual POST /api/procurement/run. Both
//      read "not contacted" before either writes. Both send.
//
// A read-then-send check cannot fix either, because the window between the read and the write is
// exactly where both failures live. The fix is the pattern already proven twice in this repo
// (outreach_sends, cphi_followup_sends): INSERT the claim FIRST and let a UNIQUE constraint decide.
// A unique violation is not an error — it is another execution having already claimed the work.
//
// ── WHY THE CODE CHECKS THAT THE INDEX EXISTS ────────────────────────────────
//
// Claim-before-act is worthless without the constraint: the INSERT simply succeeds twice. The index
// cannot be created if the table already holds duplicate (rfq_id, supplier_id) pairs, and that is
// not something boot can resolve on its own — picking which historical duplicate to keep is a
// human decision about real correspondence.
//
// So boot does not crash and does not pretend. It reports, and `isEnforced()` tells the caller the
// invariant is absent, which makes RFQ sending refuse. No invariant, no consequential action — the
// same rule the kill switch applies to an unreadable kill-state.
'use strict';

const crypto = require('crypto');

const INDEX_NAME = 'uq_supplier_outreach_rfq_supplier';

async function migrate(query) {
  // 'pending' is the claim state; 'failed' records an attempt whose send did not land. The original
  // CHECK allowed only ('sent','replied','no_response'), which has no way to say "claimed, outcome
  // not yet known" — the state that makes the window closable at all.
  await query(`ALTER TABLE supplier_outreach_log DROP CONSTRAINT IF EXISTS supplier_outreach_log_status_check`);
  await query(`ALTER TABLE supplier_outreach_log
                 ADD CONSTRAINT supplier_outreach_log_status_check
                 CHECK (status IN ('pending','sent','failed','replied','no_response'))`)
    .catch((e) => { if (!/already exists/i.test(e.message)) throw e; });
  await query(`ALTER TABLE supplier_outreach_log ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
  await query(`ALTER TABLE supplier_outreach_log ADD COLUMN IF NOT EXISTS error TEXT`);
  // ── PROVIDER ACKNOWLEDGEMENT IS ITS OWN FACT (ruling §9) ──────────────────
  //
  // provider acceptance ≠ delivery ≠ supplier read ≠ supplier quotation. These columns record only
  // the first: the outbound provider acknowledged the request and returned an id for it. They are
  // the evidence anchor reconciliation and R2 will need, and they are never invented — if the
  // provider returns no id, the column stays NULL rather than carrying something made up.
  await query(`ALTER TABLE supplier_outreach_log ADD COLUMN IF NOT EXISTS provider TEXT`);
  await query(`ALTER TABLE supplier_outreach_log ADD COLUMN IF NOT EXISTS provider_message_id TEXT`);
  await query(`ALTER TABLE supplier_outreach_log ADD COLUMN IF NOT EXISTS provider_accepted_at TIMESTAMPTZ`);
  await query(`ALTER TABLE supplier_outreach_log ADD COLUMN IF NOT EXISTS approval_id TEXT`);
  await query(`ALTER TABLE supplier_outreach_log ADD COLUMN IF NOT EXISTS run_id UUID`);

  try {
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
                   ON supplier_outreach_log (rfq_id, supplier_id)`);
    return { enforced: true };
  } catch (e) {
    // Duplicates already exist. Name them, so the person who has to decide can see which supplier
    // was emailed twice about which request rather than being handed an error code.
    let dupes = [];
    try {
      const r = await query(`SELECT rfq_id, supplier_id, COUNT(*)::int n
                               FROM supplier_outreach_log
                              WHERE rfq_id IS NOT NULL AND supplier_id IS NOT NULL
                              GROUP BY rfq_id, supplier_id HAVING COUNT(*) > 1
                              ORDER BY n DESC LIMIT 20`);
      dupes = r.rows;
    } catch (_) { /* reporting is best effort; the refusal below is not */ }
    return { enforced: false, error: e.message, duplicates: dupes };
  }
}

// Asked once per run, not per supplier.
async function isEnforced(query) {
  const r = await query(
    `SELECT 1 FROM pg_indexes WHERE indexname = $1 AND indexdef ILIKE '%UNIQUE%'`, [INDEX_NAME]);
  return r.rows.length > 0;
}

/**
 * Claim the right to email this supplier about this RFQ. Returns the claim id, or null when another
 * execution already holds it. Call this BEFORE generating or sending anything.
 */
async function claim(query, { rfqId, supplierId, email, subject, approvalId = null, runId = null }) {
  const id = crypto.randomUUID();
  try {
    // approvalId and runId are recorded ON THE CLAIM so an unresolved external attempt can be
    // traced back to the authorization that permitted it and the run that performed it, without
    // joining through anything that might have changed since.
    await query(
      `INSERT INTO supplier_outreach_log
         (id, rfq_id, supplier_id, email_sent_to, email_subject, status, claimed_at,
          approval_id, run_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), $6, $7)`,
      [id, rfqId, supplierId, email || null, subject || null, approvalId, runId],
    );
    return id;
  } catch (e) {
    if (e.code === '23505') return null;   // already claimed — not an error
    throw e;
  }
}

// The send landed. Records the body only now, because a body stored against a send that never
// happened is a claim about correspondence that does not exist.
async function confirm(query, id, { subject, body, provider = null, providerMessageId = null }) {
  // `status='sent'` means THE PROVIDER ACCEPTED IT. Not that it was delivered, not that anybody
  // read it, and certainly not that a quotation exists. Those are separate facts and two of them
  // are not knowable here at all.
  await query(
    `UPDATE supplier_outreach_log
        SET status = 'sent', sent_at = NOW()::text, email_subject = COALESCE($2, email_subject),
            email_body = $3, provider = $4, provider_message_id = $5,
            provider_accepted_at = NOW()
      WHERE id = $1`,
    [id, subject || null, body || null, provider, providerMessageId],
  );
}

/**
 * The transport failed in a way where PROVIDER ACCEPTANCE CANNOT BE RULED OUT (ruling §8/§11).
 *
 * The claim deliberately STAYS 'pending', so `unresolved()` keeps returning it and the
 * reconciler keeps reporting it as unresolved. Marking it 'failed' would assert that nothing was
 * sent, which is precisely the thing nobody knows — and marking it 'sent' would assert the
 * opposite lie. The error text is recorded beside it so a human reads what actually happened.
 */
async function markUnknown(query, id, reason) {
  await query(
    `UPDATE supplier_outreach_log SET error = $2 WHERE id = $1 AND status = 'pending'`,
    [id, `KNOWN UNKNOWN — provider acceptance cannot be ruled out: ${String(reason || '').slice(0, 400)}`]);
}

// The send DEFINITIVELY did not land: the provider responded and rejected it, or the request was
// refused before it was ever made. Only for failures where acceptance IS ruled out — anything
// ambiguous goes to markUnknown() instead and stays unresolved.
//
// The claim is KEPT, not deleted: deleting it would reopen the (rfq, supplier) window and let the
// next run try again with no record that an attempt was made at all.
async function markFailed(query, id, reason) {
  await query(`UPDATE supplier_outreach_log SET status = 'failed', error = $2 WHERE id = $1`,
    [id, String(reason || '').slice(0, 500)]);
}

// Claims whose outcome is unknown: the send was attempted and nothing came back to say what
// happened. These must be looked at by a human before anything retries them.
async function unresolved(query, { olderThanMinutes = 15 } = {}) {
  const r = await query(
    `SELECT id, rfq_id, supplier_id, email_sent_to, claimed_at, error, approval_id, run_id
       FROM supplier_outreach_log
      WHERE status = 'pending' AND claimed_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY claimed_at`, [String(olderThanMinutes)]);
  return r.rows;
}

module.exports = { INDEX_NAME, migrate, isEnforced, claim, confirm, markFailed,
                   markUnknown, unresolved };
