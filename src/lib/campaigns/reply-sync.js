// ── BRING REPLY STATE INTO THE DATABASE, INSTEAD OF DISCOVERING IT TOO LATE ───
//
// On 13 Oct the delivery audit reported eight suppliers had replied, and the reply queue — run a
// minute later — reported nobody had. Both were reading honestly. The audit asked GMAIL. The queue
// read `cphi_followup_state.status`, which the runner only updates at the moment it is about to
// send somebody's next step. Those steps are due in four days, so nothing had looked.
//
// The stop-on-reply guard was never broken by this: the check happens immediately before each
// send, which is exactly where it has to be. But it made every reply INVISIBLE to the rest of the
// system until the sequence next woke up — and a supplier's catalogue sitting unnoticed for four
// days is the whole value of the campaign going stale in an inbox.
//
// Lazy was the wrong shape. A reply is the most important event in this system and it should be
// known within the hour, not when a timer happens to fire.
//
// ── WHY IT ONLY EVER MOVES ACTIVE → REPLIED ──────────────────────────────────
//
// It never clears a reply, never un-halts, never touches step_sent. A thread that was marked
// replied and now looks quiet is not evidence of anything — a message can be moved, archived, or
// deleted by a human — and reviving a stopped sequence on that basis would send a follow-up to
// somebody who already answered, which is the one outcome this campaign is built to prevent.
'use strict';

const { replyState, headerDate } = require('../gmail/thread');

/**
 * Walk the active sequences and mark the ones that have been answered.
 *
 * Options: { gmail, event, fromMailbox, query, execute, log, max }
 * Returns { checked, replied: [...], unknown: [...], marked }
 *
 * `query` is injected rather than imported so this can be exercised without a database.
 */
async function syncReplies(opts = {}) {
  const { gmail, event, fromMailbox } = opts;
  const query = opts.query;
  const execute = !!opts.execute;
  const say = opts.log || (() => {});
  const max = opts.max == null ? 500 : opts.max;

  if (!gmail) throw new Error('a gmail client is required');
  if (!event) throw new Error('an event slug is required');
  if (!fromMailbox) throw new Error('a mailbox is required — replyState needs to know which messages are ours');
  if (typeof query !== 'function') throw new Error('a query function is required');

  const rows = (await query(
    `SELECT st.id, st.thread_id, st.campaign, st.status, c.name, c.company
       FROM cphi_followup_state st
       JOIN cphi_exhibitor_contacts c ON c.id = st.contact_id
      WHERE st.event_slug = $1 AND st.status = 'active' AND st.thread_id IS NOT NULL
      ORDER BY st.id
      LIMIT $2`, [event, max])).rows;

  const out = { checked: 0, replied: [], unknown: [], marked: 0 };

  for (const r of rows) {
    out.checked += 1;
    const rs = await replyState(gmail, r.thread_id, fromMailbox);

    if (rs.replied === null) {
      // Cannot tell. Deliberately not treated as "no reply": that is the error which lets a
      // sequence keep running towards somebody who has already answered.
      out.unknown.push({ ...r, why: rs.error });
      continue;
    }
    if (!rs.replied) continue;

    out.replied.push({ ...r, repliedAt: rs.repliedAt, autoReplies: rs.autoReplies.length });
    if (!execute) continue;

    // replied_at comes from the message where possible, so the queue can be ordered by when the
    // person actually wrote rather than by when this job happened to notice.
    //
    // Through headerDate, NOT raw: the Date header may carry an RFC 5322 comment —
    // "+0800 (GMT+08:00)" — which Postgres refuses outright. That killed the first real run.
    const when = headerDate(rs.repliedAt);
    const res = await query(
      `UPDATE cphi_followup_state
          SET status = 'replied',
              replied_at = COALESCE($2::timestamptz, NOW()),
              updated_at = NOW()
        WHERE id = $1 AND status = 'active'
        RETURNING id`,
      [r.id, when ? when.toISOString() : null]);
    out.marked += res.rowCount;
  }

  say(`   ${out.checked} active sequence(s) checked`
    + ` · ${out.replied.length} have replied`
    + `${execute ? ` · ${out.marked} marked` : ''}`
    + `${out.unknown.length ? ` · ${out.unknown.length} could not be read` : ''}`);

  return out;
}

module.exports = { syncReplies };
