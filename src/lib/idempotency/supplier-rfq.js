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
async function claim(query, { rfqId, supplierId, email, subject }) {
  const id = crypto.randomUUID();
  try {
    await query(
      `INSERT INTO supplier_outreach_log
         (id, rfq_id, supplier_id, email_sent_to, email_subject, status, claimed_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
      [id, rfqId, supplierId, email || null, subject || null],
    );
    return id;
  } catch (e) {
    if (e.code === '23505') return null;   // already claimed — not an error
    throw e;
  }
}

// The send landed. Records the body only now, because a body stored against a send that never
// happened is a claim about correspondence that does not exist.
async function confirm(query, id, { subject, body }) {
  await query(
    `UPDATE supplier_outreach_log
        SET status = 'sent', sent_at = NOW()::text, email_subject = COALESCE($2, email_subject),
            email_body = $3
      WHERE id = $1`,
    [id, subject || null, body || null],
  );
}

// The send did not land. The claim is KEPT, not deleted: deleting it would reopen the window and let
// the next run try again with no record that the first attempt may have reached the supplier.
// A kept 'failed' claim is a known-unknown, which is the whole point.
async function markFailed(query, id, reason) {
  await query(`UPDATE supplier_outreach_log SET status = 'failed', error = $2 WHERE id = $1`,
    [id, String(reason || '').slice(0, 500)]);
}

// Claims whose outcome is unknown: the send was attempted and nothing came back to say what
// happened. These must be looked at by a human before anything retries them.
async function unresolved(query, { olderThanMinutes = 15 } = {}) {
  const r = await query(
    `SELECT id, rfq_id, supplier_id, email_sent_to, claimed_at, error
       FROM supplier_outreach_log
      WHERE status = 'pending' AND claimed_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY claimed_at`, [String(olderThanMinutes)]);
  return r.rows;
}

module.exports = { INDEX_NAME, migrate, isEnforced, claim, confirm, markFailed, unresolved };
