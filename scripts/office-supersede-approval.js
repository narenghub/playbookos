#!/usr/bin/env node
// ── SUPERSEDE AN APPROVED ACTION THAT CAN NO LONGER BE EXECUTED AS PREPARED ──
//
//   railway ssh 'node scripts/office-supersede-approval.js --approval=<id> --reason="..." [--apply]'
//
// WITHOUT --apply IT IS A DRY RUN: it reads the approval, shows what would change, and writes
// NOTHING. `--apply` performs the single authorized transition.
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
//
//   rejected    the proposed action reached the human decision boundary and the decision-maker
//               declined it.
//   superseded  the action WAS approved, and before external execution a later governance,
//               identity, policy, configuration or factual correction made that approved action
//               no longer executable as prepared.
//
// Both facts are true of the action this script was written for: the CEO approved that exact
// payload at that time, AND a newly enforced sender-provenance invariant later made it ineligible
// for release. Reusing 'rejected' would rewrite the first to represent the second.
//
// THE ONLY TRANSITION IT CAN PERFORM is `approved + never externally claimed → superseded`,
// arbitrated in a single SQL statement that also consults supplier_outreach_log — because
// release_claimed_at being NULL is the control plane's belief, while the outreach log is where an
// external attempt is actually recorded, by a different code path at a different moment.
//
// pending → superseded, rejected → superseded, superseded → anything, and claimed or released →
// superseded are all impossible, and none of them are impossible because this script declines to
// try: the UPDATE's own predicate refuses them.
//
// IT NEVER TOUCHES THE PAYLOAD. The approval's `resolution` — the approver's own words — is left
// exactly as it was, and the supersession is recorded in its own fields beside it. The defective
// absence of a sender remains part of the historical record, which is the point.
'use strict';

const crypto = require('crypto');
const scope = require('../src/lib/office/scope');
const { query } = require('../src/lib/db');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(22)} ${v}`);

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

/** Canonical JSON: keys sorted at every depth, so the digest depends on content not key order. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
const digestOf = (p) => crypto.createHash('sha256').update(canonical(p)).digest('hex');

(async () => {
  try {
    const APPROVAL_ID = arg('approval');
    const REASON = arg('reason');
    const ACTOR = arg('actor', 'naren');
    const APPLY = argv.includes('--apply');

    if (!APPROVAL_ID) { console.error('usage: --approval=<id> --reason="..." [--actor=<who>] [--apply]'); process.exit(2); }
    if (!REASON || REASON.trim().length < 12) {
      console.error('--reason="..." is required, at least 12 characters: a terminal status nobody');
      console.error('can account for later is worth little more than no record.');
      process.exit(2);
    }

    console.log(`\n══ SUPERSEDE AN APPROVED ACTION ${APPLY ? '(APPLYING)' : '(DRY RUN — WRITES NOTHING)'} ══\n`);
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    const row = await scope.bootstrapApprovalForExecution(APPROVAL_ID);
    if (!row) { console.error(`  no approval ${APPROVAL_ID}\n`); process.exit(1); }
    const p = row.action_payload || {};
    const before = digestOf(p);

    field('approval id', row.id);
    field('company', row.company_id);
    field('objective', row.objective_id);
    field('run', row.run_id);
    field('action kind', row.action_kind);
    field('current status', row.status);
    field('approved by / at', `${row.resolved_by || '(none)'} / ${row.resolved_at || '(none)'}`);
    field('approval resolution', row.resolution || '(none)');
    field('payload sha256', before);
    field('supplier', `${p.supplier_name || '(none)'} (${p.supplier_id || 'no id'})`);
    field('FROM', p.from || '(NONE RECORDED)');
    field('To / CC', `${p.to || '(none)'} / ${(p.cc || []).join(', ') || '(none)'}`);

    // ── THE PRECONDITIONS, READ BEFORE ANYTHING IS ATTEMPTED ───────────────
    console.log('');
    if (row.status === 'approved') ok('status is approved — the only status this transition accepts');
    else bad(`status is "${row.status}"; only an APPROVED action can be superseded. A pending one `
      + 'must be approved or rejected, and rejected/superseded are terminal');

    if (!row.release_claimed_at && !row.released_at) ok('no executor has claimed the right to attempt this');
    else bad('this approval has already been CLAIMED for release — supersession is too late',
      `${row.release_claimed_at || row.released_at}`);

    const claims = (await query(
      `SELECT id, status, sent_at, claimed_at FROM supplier_outreach_log
        WHERE approval_id = $1 OR (rfq_id = $2 AND supplier_id = $3)`,
      [APPROVAL_ID, p.rfq_id || null, p.supplier_id || null])).rows;
    field('external claim', claims.length ? claims.map((c) => `${c.id} ${c.status}`).join('; ') : 'NONE');
    if (!claims.length) ok('and the outreach log agrees: no external attempt exists for this pair');
    else bad(`${claims.length} external claim row(s) exist — the outside world may already have been reached`);

    const attempts = (await query(
      `SELECT COUNT(*)::int n FROM agent_run_events
        WHERE run_id = $1 AND kind = 'ACTION_ATTEMPTED'`, [row.run_id])).rows[0].n;
    field('ACTION_ATTEMPTED', attempts ? `${attempts} — AN ATTEMPT WAS MADE` : 'NONE');
    if (!attempts) ok('and no attempt evidence exists on its run');
    else bad(`${attempts} ACTION_ATTEMPTED event(s) on this run`);

    if (fail) {
      console.log(`\nFAIL  ${fail} precondition(s) failed. Nothing was changed.\n`);
      process.exit(1);
    }

    console.log('\n  WHAT WOULD CHANGE\n');
    field('status', `approved  →  superseded`);
    field('previous_status', `(none)  →  approved`);
    field('superseded_by', ACTOR);
    field('superseded_reason', REASON.trim());
    note('action_payload, resolution, resolved_by and resolved_at are NOT touched: the original');
    note('decision evidence is preserved and the supersession is recorded beside it.');

    if (!APPLY) {
      console.log('\n  DRY RUN — nothing was written. Re-run with --apply to perform it.\n');
      process.exit(0);
    }

    // ── THE SINGLE AUTHORIZED TRANSITION ───────────────────────────────────
    const ctx = Object.freeze({
      companyId: row.company_id, objectiveId: row.objective_id, runId: row.run_id,
    });
    const done = await scope.supersedeApproval(ctx, {
      approvalId: APPROVAL_ID, supersededBy: ACTOR, reason: REASON.trim(),
    });

    if (!done) {
      // The predicate refused. Say what the row looks like now rather than guessing why.
      const now = await scope.bootstrapApprovalForExecution(APPROVAL_ID);
      bad('the transition was REFUSED by its own arbitration — nothing changed',
        `status=${now && now.status} release_claimed_at=${now && now.release_claimed_at}`);
      console.log('\nFAIL  not superseded.\n');
      process.exit(1);
    }

    console.log('');
    ok(`recorded: SUPERSEDED by ${done.superseded_by}`);
    field('previous status', done.previous_status);
    field('superseded at', done.superseded_at);
    field('supersession reason', done.superseded_reason);
    field('original resolution', done.resolution || '(none)');
    field('originally approved by', `${done.resolved_by || '(none)'} / ${done.resolved_at || '(none)'}`);

    if (done.resolution === row.resolution) ok('the original approval resolution is PRESERVED, not overwritten');
    else bad('the original resolution changed', `${row.resolution} → ${done.resolution}`);
    if (done.previous_status === 'approved') ok('and the transition records what it came from');
    else bad('previous_status was not recorded', String(done.previous_status));

    const after = (await scope.bootstrapApprovalForExecution(APPROVAL_ID));
    if (digestOf(after.action_payload) === before) {
      ok(`the frozen payload is BYTE-FOR-BYTE unchanged (${before.slice(0, 16)}…)`);
    } else bad('THE PAYLOAD CHANGED', `${before} → ${digestOf(after.action_payload)}`);

    const claimsAfter = (await query(
      `SELECT COUNT(*)::int n FROM supplier_outreach_log
        WHERE approval_id = $1 OR (rfq_id = $2 AND supplier_id = $3)`,
      [APPROVAL_ID, p.rfq_id || null, p.supplier_id || null])).rows[0].n;
    if (claimsAfter === 0) ok('no supplier claim was created — supersession is not an action');
    else bad(`${claimsAfter} claim row(s) appeared`);

    console.log(fail
      ? `\nFAIL  ${fail} assertion(s) failed after the transition.\n`
      : '\nPASS  SUPERSEDED. This action is terminal and can never release: release requires '
        + 'status="approved".\n      The business intent is NOT consumed — the same (RFQ, supplier) '
        + 'may be prepared again as a\n      new attempt with its own immutable payload and approval id.\n');
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error(`\nFAIL  ${e.stack || e.message}\n`);
    process.exit(1);
  }
})();
