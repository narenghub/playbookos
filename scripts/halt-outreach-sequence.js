#!/usr/bin/env node
// ── TAKE ONE OUTREACH SEQUENCE OUT OF THE SCHEDULER, BY ID ───────────────────
//
//   railway ssh --service playbookos 'node /app/scripts/halt-outreach-sequence.js \
//     --email=someone@example.com --expect-status=active --expect-need=custom_synthesis \
//     --expect-step=1 --reason="..."'
//
//   ... the same line plus --execute
//
// Dry run unless --execute. Sends nothing, ever — this file imports a database and nothing else.
// `--service playbookos` is not optional; the CLI's linked service in this project is Postgres,
// where there is no node and no /app.
//
// ── WHY THIS IS NOT scripts/halt-contact.js ──────────────────────────────────
//
// halt-contact.js halts a CPHI campaign: cphi_followup_state, keyed on a cphi_exhibitor_contacts
// id. The need-based outreach runner keeps its state somewhere else entirely —
// outreach_state (channel, ref) — and does not look at the CPHI tables. Running halt-contact.js
// against an outreach recipient reports "no contact" and halts nothing, which reads like a
// successful no-op.
//
// ── WHY EVERY EXPECTATION IS A REQUIRED FLAG ─────────────────────────────────
//
// This repository has already been bitten by the opposite. verify-product-revocation-live.js
// encoded live account state as an implicit assumption, wrote on the strength of it, and the write
// landed when a human had changed that account underneath it. The lesson recorded in CLAUDE.md is
// that an expectation built from live state goes stale and "the script finds out by writing."
//
// So the state this change is authorized against — status, need, step — is passed in explicitly
// and compared before anything is written. There are no defaults, because a defaulted expectation
// is an unasserted one: it would silently match whatever it found. If production does not look the
// way the authorization says it looks, that is the interesting finding, and this exits non-zero
// having written nothing.
//
// ── AND WHY THE SCHEDULER CHECK READS THE SCHEDULER ──────────────────────────
//
// "The scheduler will not select it" is the actual claim being made, and the honest way to support
// it is to look at the scheduler rather than at this author's memory of it. After the write, this
// reads src/lib/agents/outreach-agent.js and confirms the skip on status 'halted' is still there,
// ahead of the step and due-date logic. If that line is gone or moved, the verification REPORTS
// THAT rather than printing a verdict it cannot support.
'use strict';

const fs = require('fs');
const path = require('path');
const { initDB, query, withTransaction } = require('../src/lib/db');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : undefined;
};

const EMAIL = arg('email') === undefined ? undefined : String(arg('email')).trim().toLowerCase();
const EXPECT_STATUS = arg('expect-status');
const EXPECT_NEED = arg('expect-need');
const EXPECT_STEP = arg('expect-step');
const REASON = arg('reason');
const EXECUTE = has('execute');

const say = (s = '') => console.log(s);

// An abort is a throw, so withTransaction rolls back. Nothing partial can be left behind.
class Abort extends Error {}
const abort = (m) => { throw new Abort(m); };

const REQUIRED = [
  ['--email', EMAIL], ['--expect-status', EXPECT_STATUS], ['--expect-need', EXPECT_NEED],
  ['--expect-step', EXPECT_STEP], ['--reason', REASON],
];

/**
 * Does the runner still skip a halted sequence, and does it do so before the due-date logic?
 *
 * Returns a verdict object rather than a boolean: "could not determine" is a distinct outcome from
 * "no", and collapsing the two is how a report comes to state more than it knows.
 */
function schedulerSkipsHalted(file = path.join(__dirname, '..', 'src', 'lib', 'agents', 'outreach-agent.js')) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { verdict: 'UNDETERMINED', detail: `could not read ${file}: ${e.message}` };
  }
  const halted = src.indexOf(`st.status === 'halted'`);
  if (halted < 0) {
    return {
      verdict: 'NO',
      detail: "the runner no longer contains a skip on st.status === 'halted' — halting this row "
            + 'does NOT take it out of the queue, and this containment must be reconsidered',
    };
  }
  // The skip has to be reached before the step and due-date branches, or a halted row could still
  // be queued by an earlier path.
  const due = src.indexOf('skipped.notDue');
  const step = src.indexOf('skipped.done');
  if (due >= 0 && halted > due) {
    return { verdict: 'NO', detail: 'the halted skip now sits AFTER the due-date branch' };
  }
  if (step >= 0 && halted > step) {
    return { verdict: 'NO', detail: 'the halted skip now sits AFTER the step branch' };
  }
  return {
    verdict: 'YES',
    detail: "src/lib/agents/outreach-agent.js skips st.status === 'halted' unconditionally, before "
          + 'both the step and due-date branches',
  };
}

async function main() {
  const missing = REQUIRED.filter(([, v]) => v === undefined || v === '').map(([n]) => n);
  if (missing.length) {
    console.error(`\nmissing required flag(s): ${missing.join(', ')}\n`);
    console.error('Every expectation is required on purpose — a defaulted expectation matches');
    console.error('whatever it finds, which is the opposite of a guard. See the header.\n');
    process.exit(2);
  }
  const expectStep = Number(EXPECT_STEP);
  if (!Number.isInteger(expectStep)) {
    console.error(`--expect-step must be an integer, got ${JSON.stringify(EXPECT_STEP)}`);
    process.exit(2);
  }

  await initDB();

  // ── THE COLUMN THAT RECORDS WHY ───────────────────────────────────────────
  // Refuse rather than silently halt without a recorded cause.
  const col = (await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'outreach_state' AND column_name = 'halted_reason'`)).rows.length;
  if (!col) {
    console.error('\noutreach_state.halted_reason does not exist — a status change with no recorded');
    console.error('cause is indistinguishable from a bug later. Run first:');
    console.error("  railway ssh --service playbookos 'node /app/scripts/migrate-outreach-sequences.js'\n");
    process.exit(1);
  }

  say(`\n── halt one outreach sequence${EXECUTE ? '' : '   ** DRY RUN — nothing will be written **'}\n`);

  // ── BEFORE: READ AND VERIFY ───────────────────────────────────────────────
  // Matched on the address, then pinned to the primary key. The authorization names a recipient;
  // the write must name a row.
  const found = (await query(
    `SELECT id, channel, ref, email, need, step_sent, status, next_due_at, halted_reason,
            thread_id, last_rfc822_id, refs_chain, replied_at, last_sent_at, created_at, updated_at
       FROM outreach_state WHERE LOWER(email) = $1 ORDER BY id`, [EMAIL])).rows;

  if (!found.length) {
    console.error(`no outreach_state row with email ${EMAIL} — nothing halted, nothing written`);
    process.exit(1);
  }
  if (found.length > 1) {
    console.error(`${found.length} outreach_state rows share ${EMAIL} (ids ${found.map((r) => r.id).join(', ')}).`);
    console.error('This script changes exactly one row and will not guess which. Aborting.');
    process.exit(1);
  }
  const before = found[0];

  // The provider record for this subject, read-only, so the report can show it is untouched.
  const sends = (await query(
    `SELECT id, step, to_email, subject, rfc822_id, thread_id, confirmed, sent_at
       FROM outreach_sends WHERE channel = $1 AND ref = $2 ORDER BY step, id`,
    [before.channel, before.ref])).rows;

  say('   BEFORE');
  say(`     id            ${before.id}      (primary key — the write is pinned to this)`);
  say(`     channel/ref   ${before.channel} / ${before.ref}`);
  say(`     recipient     ${before.email}`);
  say(`     workflow      need=${before.need}`);
  say(`     status        ${before.status}`);
  say(`     step_sent     ${before.step_sent}`);
  say(`     next step     ${before.next_due_at ? `${before.next_due_at.toISOString()} (would send)` : 'none scheduled'}`);
  say(`     halted_reason ${before.halted_reason || '(none)'}`);
  say(`     last_sent_at  ${before.last_sent_at ? before.last_sent_at.toISOString() : '(never)'}`);
  say(`     thread        ${before.thread_id || '(none)'}`);
  say(`     messages      ${sends.length} row(s) in outreach_sends`);
  for (const s of sends) {
    say(`       step ${s.step}  ${s.sent_at.toISOString()}  rfc822=${s.rfc822_id || '(none)'}  confirmed=${s.confirmed}`);
  }

  const mismatches = [];
  if (before.status !== EXPECT_STATUS) mismatches.push(`status is '${before.status}', expected '${EXPECT_STATUS}'`);
  if (before.need !== EXPECT_NEED) mismatches.push(`need is '${before.need}', expected '${EXPECT_NEED}'`);
  if (before.step_sent !== expectStep) mismatches.push(`step_sent is ${before.step_sent}, expected ${expectStep}`);

  if (mismatches.length) {
    say('');
    console.error('   STATE DOES NOT MATCH THE AUTHORIZATION — nothing written:');
    for (const m of mismatches) console.error(`     · ${m}`);
    console.error('\n   Somebody or something changed this row since the authorization was written.');
    console.error('   That is the finding. Re-confirm the intended change before re-running.\n');
    process.exit(1);
  }
  say('\n   ✓ live state matches every stated expectation (status, need, step)');

  if (!EXECUTE) {
    say('\n   WOULD SET  status → halted');
    say(`   WOULD SET  halted_reason → ${REASON}`);
    say('   UNCHANGED  step_sent, next_due_at, thread_id, last_rfc822_id, refs_chain,');
    say('              replied_at, last_sent_at, created_at, and every outreach_sends row');
    const pre = schedulerSkipsHalted();
    say(`\n   scheduler would skip a halted row: ${pre.verdict} — ${pre.detail}`);
    say('\n   Re-run with --execute to apply.\n');
    process.exit(0);
  }

  // ── THE WRITE ─────────────────────────────────────────────────────────────
  const after = await withTransaction(async (client) => {
    // Lock the row and re-read inside the transaction. The check above ran outside it; between
    // then and now the runner, the bounce job or reply-sync could have moved this row, and a guard
    // that was true a moment ago is not a guard.
    const locked = (await client.query(
      `SELECT id, status, need, step_sent FROM outreach_state WHERE id = $1 FOR UPDATE`,
      [before.id])).rows;
    if (locked.length !== 1) abort(`row ${before.id} disappeared between read and write`);
    const l = locked[0];
    if (l.status !== EXPECT_STATUS || l.need !== EXPECT_NEED || l.step_sent !== expectStep) {
      abort(`row ${before.id} changed under the lock: now status='${l.status}', need='${l.need}', `
          + `step_sent=${l.step_sent}`);
    }

    // Pinned to the id AND to the expected status, so a concurrent change loses the race rather
    // than being overwritten. Only three columns are assigned; everything else is evidence.
    const upd = await client.query(
      `UPDATE outreach_state
          SET status = 'halted', halted_reason = $3, updated_at = NOW()
        WHERE id = $1 AND status = $2
        RETURNING id, status, halted_reason, step_sent, next_due_at, thread_id, last_rfc822_id,
                  refs_chain, replied_at, last_sent_at, created_at, updated_at, email, need`,
      [before.id, EXPECT_STATUS, REASON]);

    if (upd.rowCount !== 1) {
      abort(`UPDATE affected ${upd.rowCount} row(s), expected exactly 1`);
    }

    // Belt and braces: nothing outside this id may have moved. If this count is anything but zero
    // the transaction is rolled back and the report says so.
    const others = (await client.query(
      `SELECT COUNT(*)::int n FROM outreach_state
        WHERE status = 'halted' AND id <> $1 AND halted_reason = $2`, [before.id, REASON])).rows[0].n;
    if (others !== 0) abort(`${others} other row(s) carry this reason — aborting`);

    return upd.rows[0];
  }).catch((e) => {
    console.error(`\n   ABORTED, rolled back, nothing written: ${e.message}\n`);
    process.exit(1);
  });

  // ── AFTER: READ BACK ON A FRESH CONNECTION ────────────────────────────────
  // Not from the RETURNING clause of the transaction that wrote it — that proves what was sent,
  // not what was committed.
  const committed = (await query(
    `SELECT id, email, need, status, step_sent, next_due_at, halted_reason, thread_id,
            last_rfc822_id, last_sent_at, created_at
       FROM outreach_state WHERE id = $1`, [before.id])).rows[0];
  const sendsAfter = (await query(
    `SELECT COUNT(*)::int n, COUNT(rfc822_id)::int with_id
       FROM outreach_sends WHERE channel = $1 AND ref = $2`,
    [before.channel, before.ref])).rows[0];

  say('\n   AFTER (read back on a new connection, post-commit)');
  say(`     id            ${committed.id}`);
  say(`     recipient     ${committed.email}`);
  say(`     workflow      need=${committed.need}`);
  say(`     status        ${committed.status}`);
  say(`     halted_reason ${committed.halted_reason}`);
  say(`     step_sent     ${committed.step_sent}   (unchanged — halting is not un-sending)`);
  say(`     next_due_at   ${committed.next_due_at ? committed.next_due_at.toISOString() : 'none'}`
    + '   (left as evidence of what would have happened)');
  say(`     thread        ${committed.thread_id || '(none)'}`);
  say(`     messages      ${sendsAfter.n} row(s), ${sendsAfter.with_id} with a provider id`);

  const preserved = [];
  if (committed.step_sent !== before.step_sent) preserved.push('step_sent CHANGED');
  if (String(committed.thread_id) !== String(before.thread_id)) preserved.push('thread_id CHANGED');
  if (String(committed.last_rfc822_id) !== String(before.last_rfc822_id)) preserved.push('last_rfc822_id CHANGED');
  if (sendsAfter.n !== sends.length) preserved.push('outreach_sends row count CHANGED');
  if (committed.status !== 'halted') preserved.push(`status is '${committed.status}', not 'halted'`);

  say('');
  if (preserved.length) {
    console.error('   ⚠️  POST-CONDITION FAILURES:');
    for (const p of preserved) console.error(`     · ${p}`);
    process.exit(1);
  }
  say('   ✓ history, provider ids and incident evidence all intact');

  const post = schedulerSkipsHalted();
  say(`\n   WILL THE SCHEDULER SELECT THIS ROW?  ${post.verdict === 'YES' ? 'NO' : 'UNRESOLVED'}`);
  say(`     ${post.detail}`);
  if (post.verdict !== 'YES') {
    console.error('\n   The row is halted, but this script could not confirm from the scheduler');
    console.error('   source that halted rows are skipped. The database change is committed and');
    console.error('   correct; the CONTAINMENT CLAIM is unverified. Do not report it as verified.\n');
    process.exit(1);
  }

  say('\n   Note: OUTREACH_ENABLED=false and the email.send kill switch are the other two');
  say('   controls on this path. This halt is the third and the only one that survives a flag');
  say('   being turned back on.');
  say('\n   Undo: set status back to active and clear halted_reason, deliberately and by id.\n');
}

// Exported for scripts/halt-outreach-sequence.test.js, which drives it against mutated copies of
// the runner. `require.main` keeps the import side-effect-free: requiring this file must not open a
// database connection or write anything.
module.exports = { schedulerSkipsHalted };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('halt-outreach-sequence failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
