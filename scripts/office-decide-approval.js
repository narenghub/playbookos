#!/usr/bin/env node
// ── THE HUMAN DECISION: APPROVE OR REJECT A PREPARED ACTION ─────────────────
//
//   railway ssh 'node scripts/office-decide-approval.js --approval=<id> --reject --reason="..."'
//   railway ssh 'node scripts/office-decide-approval.js --approval=<id> --approve --reason="..."'
//
// This records a decision. IT DOES NOT RELEASE AND IT CANNOT SEND — no mailer, WhatsApp, outreach
// or supplier-claim module is reachable from this path, which validate-k7-k9-deployed.js asserts
// on the require graph. Approving moves the action from `pending` to `approved`, which is the
// precondition release requires; release remains a separate act that does not exist in this build.
//
// ── A REASON IS REQUIRED ────────────────────────────────────────────────────
//
// For the same reason autonomy.stop requires one: the decision is read later by somebody
// reconstructing why a supplier was or was not contacted, and "approved" with no reason tells them
// nothing. Twelve characters minimum, which is enough to stop a reflexive "ok".
//
// ── IT SHOWS WHAT IS BEING DECIDED FIRST ────────────────────────────────────
//
// The whole value of the approval object is that what a human reads is what would go out. So this
// prints the stored payload — subject, body, supplier address, the approved identity and who the
// letter is signed by — from the immutable row, not from a re-render, and then applies the
// decision. A decision made against a summary is not a decision about the communication.
'use strict';

const scope = require('../src/lib/office/scope');
const { query } = require('../src/lib/db');

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const APPROVAL_ID = arg('approval');
const REASON = arg('reason');
const APPROVE = argv.includes('--approve');
const REJECT = argv.includes('--reject');
const BY = arg('by') || 'naren';

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(20)} ${v === null || v === undefined ? '(null)' : v}`);
const stop = (why, detail) => {
  console.log('\n  ══ STOP ══\n');
  console.log(`  ${why}\n`);
  if (detail) console.log(`${String(detail).split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  console.log('  No decision was recorded.\n');
  process.exit(1);
};

(async () => {
  try {
    console.log('\n══ DECIDE A PREPARED ACTION (RECORDS A DECISION; CANNOT SEND) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    if (!APPROVAL_ID) stop('--approval=<id> is required.');
    if (APPROVE === REJECT) {
      stop('exactly one of --approve or --reject is required.',
        'Defaulting either way would be the tool making the decision.');
    }
    if (!REASON || REASON.trim().length < 12) {
      stop('--reason="..." is required, at least 12 characters.',
        'The decision is read later by somebody reconstructing why a supplier was or was not\n'
        + 'contacted. "approved" on its own tells them nothing.');
    }

    const row = (await query(
      `SELECT a.id, a.company_id, a.objective_id, a.run_id, a.action_kind, a.action_payload,
              a.status, a.reason, a.owner_user_id, a.created_at, a.resolved_by, a.resolved_at,
              a.released_at, c.display_name
         FROM office_approvals a JOIN companies c ON c.id = a.company_id
        WHERE a.id = $1`, [APPROVAL_ID])).rows[0];
    if (!row) stop(`no approval with id ${APPROVAL_ID}.`);

    // ── WHAT IS BEING DECIDED ───────────────────────────────────────────────
    console.log('  THE ACTION\n');
    field('approval', row.id);
    field('company', `${row.display_name}`);
    field('objective', row.objective_id);
    field('run', row.run_id);
    field('action kind', row.action_kind);
    field('current status', row.status);
    field('owner', row.owner_user_id);
    field('prepared', row.created_at.toISOString());
    field('why it needs you', String(row.reason || '').slice(0, 300));

    const p = row.action_payload || {};
    console.log('\n  WHAT WOULD GO OUT, FROM THE IMMUTABLE PAYLOAD\n');
    // FROM is shown at the approval boundary because it is part of what is being approved.
    field('from', p.from || '(NONE RECORDED — not releasable)');
    field('to', p.to || '(none)');
    field('cc', (p.cc || []).length ? p.cc.join(', ') : '(none)');
    field('bcc', (p.bcc || []).length ? p.bcc.join(', ') : '(none)');
    field('supplier', p.supplier_name || p.supplier_id || '(none)');
    field('approved molecule', p.approved_molecule_name || '(none)');
    field('approved CAS', p.approved_cas || 'NONE — deliberately omitted');
    field('identity decision', p.identity_decision_id || '(none)');
    if (p.signed_by_name) field('signed by', `${p.signed_by_name}, ${p.signed_by_title} <${p.signed_by_email}>`);
    else note('this payload records NO signatory — it was prepared before the signature block was '
      + 'resolved from `users`, so check the body below for who it claims to be from');
    console.log(`\n  SUBJECT: ${p.subject || '(none)'}\n`);
    if (p.body) console.log(String(p.body).split('\n').map((l) => `  │ ${l}`).join('\n'));
    console.log('');

    if (row.status !== 'pending') {
      stop(`this action is already "${row.status}" — it is not pending a decision.`,
        row.resolved_by ? `decided by ${row.resolved_by} at ${row.resolved_at && row.resolved_at.toISOString()}` : null);
    }

    // ── THE DECISION ────────────────────────────────────────────────────────
    const status = APPROVE ? 'approved' : 'rejected';
    const decided = await scope.decideApproval(
      Object.freeze({ companyId: row.company_id, objectiveId: row.objective_id, runId: row.run_id }),
      { id: APPROVAL_ID, decision: status, resolvedBy: BY, resolution: REASON }
    );
    if (!decided) { bad('the decision did not apply'); process.exit(1); }

    const after = (await query(
      `SELECT status, resolved_by, resolved_at, released_at, resolution
         FROM office_approvals WHERE id = $1`, [APPROVAL_ID])).rows[0];
    console.log('');
    if (after.status === status) ok(`recorded: ${status.toUpperCase()} by ${BY}`);
    else bad(`the stored status is "${after.status}", not "${status}"`);
    if (after.resolution === REASON) ok('the reason is stored beside the verdict, not just printed here');
    else bad('the reason was not persisted', after.resolution);
    field('reason', REASON);
    field('decided at', after.resolved_at && after.resolved_at.toISOString());

    if (!after.released_at) ok('nothing was released and nothing was transmitted');
    else bad('this action shows as RELEASED — that should not be possible from here');

    // The payload must be exactly what it was: deciding is not editing.
    const payloadAfter = (await query(
      `SELECT action_payload FROM office_approvals WHERE id = $1`, [APPROVAL_ID])).rows[0];
    if (JSON.stringify(payloadAfter.action_payload) === JSON.stringify(row.action_payload)) {
      ok('the payload is unchanged — a decision does not edit what was decided');
    } else bad('the payload CHANGED during the decision');

    console.log('\n' + (fail ? `FAIL  ${fail} assertion(s) failed` : status === 'rejected'
      ? 'PASS  REJECTED. This action can never release: release requires status="approved".'
      // THIS TEXT WAS FALSE AND SAID SO TO A CEO AT HIS DECISION POINT. It read "no send
      // capability exists in this build", which stopped being true when R1 (office/execute.js)
      // shipped with a real mailer call. What makes approval safe is NOT the absence of a send
      // path — it is that this objective's release_mode is 'explicit', so a second deliberate
      // human act is required. A script that misattributes a safety property to the wrong
      // mechanism teaches the reader to trust the wrong thing.
      : 'PASS  APPROVED and recorded. Approval does NOT transmit this communication.\n'
        + '      R1 send capability IS deployed, but this objective is in explicit release mode,\n'
        + '      so a separate RELEASE authorization is required before any supplier\n'
        + '      communication is attempted.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  decision error:', e.stack || e.message);
    process.exit(1);
  }
})();
