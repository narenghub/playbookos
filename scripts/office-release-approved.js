#!/usr/bin/env node
// ── THE SECOND HUMAN ACT: RELEASE AN APPROVED SUPPLIER ACTION ───────────────
//
//   railway ssh 'node scripts/office-release-approved.js --approval=<id> --i-authorize-release'
//
// THIS SENDS A REAL EMAIL TO A REAL SUPPLIER. It is the only script in the repository that can.
//
// ── WHY TWO ACTS FOR THE FIRST SEND ────────────────────────────────────────
//
// Ruling: approval means "this exact frozen communication is authorized for release"; it does not,
// for the first production send, itself cause external delivery. So `release_mode='explicit'` is
// stored on the objective, the executor reads it, and this script is the second act.
//
// That policy is DURABLE, not the absence of a caller: promotion to release-on-approval is a
// deliberate configuration change with evidence behind it, and until then an autonomous caller is
// refused by the stored policy rather than by nobody having wired it up.
//
// ── WHAT IT SHOWS BEFORE IT SENDS ──────────────────────────────────────────
//
// The exact frozen communication, its signatory, the budget position, and a content hash — read
// from the immutable approval row. Nothing is re-rendered. A human releasing a letter they have
// not read is the failure mode this boundary exists to prevent, so the letter is printed every
// time, however long it is.
//
// ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
//
// No retry, ever. No second attempt for a (rfq, supplier) pair that already holds an
// external-attempt identity. No sending without the explicit flag. No choosing an approval for you.
'use strict';

const crypto = require('crypto');
const { query } = require('../src/lib/db');

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const APPROVAL_ID = arg('approval');
const BY = arg('by') || 'naren';
const AUTHORIZED = argv.includes('--i-authorize-release');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(24)} ${v === null || v === undefined ? '(null)' : v}`);
const stop = (why, detail) => {
  console.log('\n  ══ STOP ══\n');
  console.log(`  ${why}\n`);
  if (detail) console.log(`${String(detail).split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  console.log('  NOTHING WAS SENT.\n');
  process.exit(1);
};

(async () => {
  try {
    console.log('\n══ RELEASE AN APPROVED SUPPLIER ACTION — THIS SENDS A REAL EMAIL ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    if (!APPROVAL_ID) {
      stop('--approval=<id> is required.',
        "Pending approvals:\n  railway ssh 'node scripts/office-pending-approvals.js'");
    }

    const row = (await query(
      `SELECT a.id, a.company_id, a.objective_id, a.run_id, a.action_kind, a.action_payload,
              a.status, a.resolution, a.resolved_by, a.resolved_at, a.release_claimed_at,
              a.released_at, o.release_mode, o.budget_usd, o.status AS objective_status,
              c.display_name
         FROM office_approvals a
         JOIN objectives o ON o.id = a.objective_id AND o.company_id = a.company_id
         JOIN companies c ON c.id = a.company_id
        WHERE a.id = $1`, [APPROVAL_ID])).rows[0];
    if (!row) stop(`no approval with id ${APPROVAL_ID}.`);

    const p = row.action_payload || {};
    const bodyHash = p.body ? crypto.createHash('sha256').update(String(p.body)).digest('hex') : null;

    console.log('  WHAT YOU ARE ABOUT TO SEND\n');
    field('approval', row.id);
    field('company', row.display_name);
    field('objective', `${row.objective_id} (${row.objective_status})`);
    field('run', row.run_id);
    field('approved by', `${row.resolved_by} at ${row.resolved_at && row.resolved_at.toISOString()}`);
    field('approval reason', String(row.resolution || '(none recorded)').slice(0, 160));
    field('release mode', row.release_mode);
    field('destination', p.to || '(none)');
    field('supplier', p.supplier_name || p.supplier_id || '(none)');
    field('approved molecule', p.approved_molecule_name || '(none)');
    field('approved CAS', p.approved_cas || 'NONE — deliberately omitted');
    field('identity decision', p.identity_decision_id || '(none)');
    field('signatory', p.signed_by_name
      ? `${p.signed_by_name}, ${p.signed_by_title} <${p.signed_by_email}>` : '(none recorded)');
    field('body sha256', bodyHash || '(no body)');
    console.log(`\n  SUBJECT: ${p.subject || '(none)'}\n`);
    if (p.body) console.log(String(p.body).split('\n').map((l) => `  │ ${l}`).join('\n'));
    console.log('');

    if (row.status !== 'approved') {
      stop(`this action is "${row.status}", not approved.`,
        row.status === 'pending'
          ? 'Approve it first — approval and release are separate acts:\n\n'
            + `  railway ssh 'node scripts/office-decide-approval.js --approval=${APPROVAL_ID} `
            + '--approve --reason="..."\''
          : null);
    }
    if (row.release_claimed_at || row.released_at) {
      stop('an executor has ALREADY taken responsibility for this action.',
        `claimed at ${(row.release_claimed_at || row.released_at).toISOString()}.\n\n`
        + 'A second attempt is not permitted. What needs resolving is the outcome of the first\n'
        + 'attempt — check the supplier claim and any open exception. Do not try to send again.');
    }

    if (!AUTHORIZED) {
      stop('this would send a real email to a real supplier, so it needs explicit authorization.',
        'Read the communication above. If it is exactly what should go out, authorize it by name:\n\n'
        + `  railway ssh 'node scripts/office-release-approved.js --approval=${APPROVAL_ID} `
        + "--i-authorize-release'");
    }

    // ══ THE SEND ═══════════════════════════════════════════════════════════
    console.log('  ── releasing through the governed executor ──\n');
    const executor = require('../src/lib/office/execute');
    const r = await executor.executeApprovedAction(APPROVAL_ID, {
      releasedBy: BY, requireExplicitRelease: true,
    });

    // ══ THE REPORT ═════════════════════════════════════════════════════════
    console.log('');
    field('kill/policy decision', r.refusal === 'stopped_by_policy' ? `STOPPED — ${r.detail}` : 'permitted');
    field('release claimed by', r.releaseClaimedBy || '(not claimed)');
    field('supplier claim id', r.claimId || '(none written)');
    field('ACTION_ATTEMPTED', r.actionAttempted ? 'persisted before the send' : 'NOT persisted');
    field('provider', r.provider || '(none)');
    field('provider phase', r.providerPhase || '(none)');
    field('provider message id', r.providerMessageId || '(none returned)');
    field('SENT', r.sent === true ? 'YES — the provider accepted it'
      : r.sent === null ? 'UNKNOWN — acceptance cannot be ruled out' : 'NO');
    field('exception', r.exception_id || '(none)');
    field('KPI touched', r.kpiTouched === false ? 'no — a send is not a quotation' : '(n/a)');

    // Spend and KPI, read back rather than asserted.
    const spend = (await query(
      `SELECT COALESCE(SUM(cost_usd) FILTER (WHERE cost_known),0)::float8 AS usd,
              COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE NOT cost_known)::int AS unknown
         FROM office_cost_ledger WHERE objective_id = $1`, [row.objective_id])).rows[0];
    field('objective spend', `$${Number(spend.usd).toFixed(8)} of $${row.budget_usd}`
      + ` over ${spend.calls} call(s), ${spend.unknown} unmeasured`);
    const outcomes = (await query(
      `SELECT COUNT(*)::int n FROM office_outcomes WHERE objective_id = $1`, [row.objective_id])).rows[0].n;
    field('business outcomes', `${outcomes} — the KPI moves only on a real qualified quotation`);

    // The claim, read from the database rather than from the executor's own report.
    if (r.claimId) {
      const c = (await query(
        `SELECT status, claimed_at, sent_at, provider, provider_message_id, provider_accepted_at, error
           FROM supplier_outreach_log WHERE id = $1`, [r.claimId])).rows[0];
      console.log('\n  THE DURABLE CLAIM, READ BACK\n');
      field('status', c && c.status);
      field('claimed at', c && c.claimed_at && c.claimed_at.toISOString());
      field('provider accepted at', c && c.provider_accepted_at && c.provider_accepted_at.toISOString());
      field('provider message id', c && c.provider_message_id);
      if (c && c.error) field('recorded error', c.error);
      if (c && c.status === 'pending') {
        note('status is still PENDING — this attempt is UNRESOLVED and the hourly reconciler will');
        note('report it as such. That is not a failure and not a success: nobody knows yet.');
      }
    }

    console.log('');
    if (r.ok && r.sent === true) {
      ok('the provider accepted the message');
      note('provider acceptance is not delivery, not a read, and not a quotation');
      console.log('\nPASS  one governed supplier RFQ was released. STOP HERE.\n');
      console.log('  Do not send a second. Do not promote to automatic release. The next decision');
      console.log('  is the promotion ruling, after this evidence is reviewed.\n');
      process.exit(0);
    }
    if (r.knownUnknown) {
      bad('the outcome is a KNOWN UNKNOWN — provider acceptance cannot be ruled out', r.detail);
      console.log('\n  Do NOT retry. A human must establish what the supplier actually received.\n');
      process.exit(1);
    }
    bad(`not released: ${r.refusal}`, r.detail);
    console.log('\n  NOTHING WAS SENT' + (r.claimWritten
      ? ', but a durable claim exists and will be reconciled.\n' : '.\n'));
    process.exit(1);
  } catch (e) {
    console.error('\nFAIL  release error:', e.stack || e.message);
    console.error('\n  The outcome of any in-flight attempt is UNKNOWN. Check the supplier claim');
    console.error('  before considering any further action. Do not retry blindly.\n');
    process.exit(1);
  }
})();
