#!/usr/bin/env node
// ── §15: PREPARE EXACTLY ONE REAL GOVERNED SUPPLIER RFQ, THEN STOP ──────────
//
//   railway ssh 'node scripts/office-prepare-first-rfq.js --rfq=<id> --supplier=<id>'
//
// IT DOES NOT SEND. The governed path has no send capability at all — no mailer, WhatsApp,
// outreach or supplier-claim module is reachable from it, which validate-k7-k9-deployed.js asserts
// on the require graph. What this produces is a PENDING approval carrying the exact communication,
// and then it stops.
//
//   The next decision is human: APPROVE / REJECT the first governed supplier RFQ.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
//
//   · an objective that is not active, or no longer matches the approved proposal
//   · an RFQ the identity guard will not allow — and the guard is consulted for real here, so a
//     decision IS persisted, unlike the read-only candidate listing
//   · a supplier that does not exist, or has no contact address
//   · A SUPPLIER WHO ALREADY HOLDS AN RFQ FOR THIS MOLECULE, unless --allow-duplicate is passed.
//
// That last one is not an identity question — the guard has no opinion about it, because nothing
// about the identity is wrong. Every RFQ on production is already status='sent', so without this
// check the first governed supplier action could silently be a SECOND real communication to a
// supplier who already ignored the first, and the supplier would be the one to discover it.
// Fail closed, with an explicit override, because a duplicate is a commercial harm that cannot be
// taken back once released.
'use strict';

const rfqMod = require('../src/lib/office/procurement-rfq');
const guard = require('../src/lib/procurement/rfq-identity-guard');
const scope = require('../src/lib/office/scope');
const budget = require('../src/lib/office/budget');
const { query } = require('../src/lib/db');

const OBJECTIVE_ID = 'obj-abiozen-first-governed-rfq';

const argv = process.argv.slice(2);
const arg = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const RFQ_ID = arg('rfq');
const SUPPLIER_ID = arg('supplier');
const ALLOW_DUPLICATE = argv.includes('--allow-duplicate');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(22)} ${v === null || v === undefined ? '(null)' : v}`);
const stop = (why, detail) => {
  console.log('\n  ══ STOP ══\n');
  console.log(`  ${why}\n`);
  if (detail) console.log(`${String(detail).split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  console.log('  Nothing was prepared and nothing was sent.\n');
  process.exit(1);
};

(async () => {
  try {
    console.log('\n══ §15 · PREPARE ONE GOVERNED SUPPLIER RFQ (PREPARES, DOES NOT SEND) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    if (!RFQ_ID || !SUPPLIER_ID) {
      stop('--rfq=<id> and --supplier=<id> are both required.',
        'The molecule and the supplier are a commercial and scientific decision, so this script\n'
        + 'does not choose either. To see the candidates and what the identity guard would say:\n\n'
        + "  railway ssh 'node scripts/office-rfq-candidates.js'");
    }

    // ══ 1. THE OBJECTIVE MUST BE ACTIVE AND STILL THE APPROVED ONE ═════════
    const company = (await query(`SELECT id, display_name FROM companies WHERE slug='abiozen'`)).rows[0];
    if (!company) stop('no abiozen company exists.');
    const obj = (await query(
      `SELECT id, objective, kpi_metric, kpi_target, budget_usd, status, autonomy_tier, approval_policy
         FROM objectives WHERE id = $1 AND company_id = $2`, [OBJECTIVE_ID, company.id])).rows[0];
    if (!obj) stop(`objective ${OBJECTIVE_ID} does not exist.`);
    if (obj.status !== 'active') {
      stop(`the objective is "${obj.status}", not active.`,
        'Activate it first, as its own deliberate command:\n\n'
        + "  railway ssh 'node scripts/office-activate-objective.js'");
    }
    if (obj.kpi_metric !== 'qualified_supplier_quotes_received' || Number(obj.budget_usd) !== 10) {
      stop('the objective no longer matches the approved proposal.',
        `kpi_metric="${obj.kpi_metric}" budget=$${obj.budget_usd}`);
    }
    ok(`objective ${OBJECTIVE_ID} is active and matches the approved proposal`);
    field('autonomy tier', obj.autonomy_tier);
    field('approval policy', obj.approval_policy);

    // ══ 2. THE RFQ AND THE SUPPLIER ════════════════════════════════════════
    const rfq = (await query(
      `SELECT id, molecule_name, cas_number, target_quantity, target_purity, gmp_required, status
         FROM rfq_requests WHERE id = $1`, [RFQ_ID])).rows[0];
    if (!rfq) stop(`no RFQ with id ${RFQ_ID}.`);
    const sup = (await query(
      `SELECT id, name, country, contact_email, contact_name, gmp_certified
         FROM suppliers WHERE id = $1`, [SUPPLIER_ID])).rows[0];
    if (!sup) stop(`no supplier with id ${SUPPLIER_ID}.`);
    if (!sup.contact_email) {
      stop(`${sup.name} has no contact address.`,
        'An unverified destination for a real supplier communication is not an acceptable input.');
    }
    console.log('');
    field('RFQ', `${rfq.id}`);
    field('filed molecule', rfq.molecule_name);
    field('filed CAS', rfq.cas_number || '(none)');
    field('quantity', rfq.target_quantity || '(unspecified)');
    field('purity', rfq.target_purity || '(unspecified)');
    field('GMP required', rfq.gmp_required ? 'yes' : 'no');
    field('RFQ status', rfq.status);
    field('supplier', `${sup.name} (${sup.country || '?'})`);
    field('contact', `${sup.contact_name ? `${sup.contact_name}, ` : ''}${sup.contact_email}`);
    field('supplier GMP', sup.gmp_certified ? 'certified' : 'not certified');

    // ══ 3. THE DUPLICATE CHECK ═════════════════════════════════════════════
    const already = (await query(
      `SELECT o.supplier_id, s.name, o.status, o.sent_at
         FROM supplier_outreach_log o LEFT JOIN suppliers s ON s.id = o.supplier_id
        WHERE o.rfq_id = $1 ORDER BY o.sent_at`, [RFQ_ID])).rows;
    const sameSupplier = already.filter((a) => a.supplier_id === SUPPLIER_ID);
    console.log('');
    if (sameSupplier.length) {
      if (!ALLOW_DUPLICATE) {
        stop(`${sup.name} ALREADY HOLDS an RFQ for ${rfq.molecule_name}.`,
          sameSupplier.map((a) => `sent ${String(a.sent_at).slice(0, 10)} — status ${a.status}`).join('\n')
          + '\n\nPreparing this would make the first governed supplier action a SECOND real\n'
          + 'communication to a supplier who already has the first. The identity guard has no\n'
          + 'opinion about that, because nothing about the identity is wrong.\n\n'
          + 'If a deliberate follow-up IS what you want, say so explicitly:\n\n'
          + `  railway ssh 'node scripts/office-prepare-first-rfq.js --rfq=${RFQ_ID} `
          + `--supplier=${SUPPLIER_ID} --allow-duplicate'`);
      }
      note(`--allow-duplicate given: ${sup.name} already holds an RFQ for this molecule, and this `
        + 'is a deliberate follow-up');
    } else if (already.length) {
      ok(`${sup.name} has NOT been contacted for this RFQ — this is a new supplier action`);
      note(`${already.length} other supplier(s) already hold an RFQ for ${rfq.molecule_name}: `
        + already.map((a) => a.name || a.supplier_id).join(', '));
    } else {
      ok('no supplier has been contacted for this RFQ at all — this is the first');
    }

    // ══ 3b. WHO WOULD SIGN IT — BEFORE ANY MONEY IS SPENT ══════════════════
    //
    // Shown here rather than only in the report, because on 2 Nov 2026 two real RFQs were prepared
    // signed by a Procurement Director who had left the organisation. Seeing the signature block
    // before the provider is called is the difference between noticing and paying to notice.
    const signatory = await rfqMod.resolveSignatory({});
    console.log('');
    if (!signatory) {
      stop('there is no active signatory, so nobody this RFQ could honestly be from.',
        'renderGovernedRFQ would refuse with no_active_signatory. Someone active must hold\n'
        + 'procurement_director, procurement_team, admin or super_admin in `users`.\n\n'
        + "  railway ssh 'node scripts/office-signatory.js'   — who the system considers");
    }
    field('would be signed by', `${signatory.name}, ${signatory.title} <${signatory.email}>`);
    field('resolved from role', `${signatory.role} (user ${signatory.id})`);
    field('why this person', signatory.why || '(not stated)');
    for (const sk of signatory.skipped || []) {
      field('  SKIPPED', `${sk.name || '(no name)'} <${sk.email || 'no email'}> — ${sk.role} — ${sk.reason}`);
    }
    note('the supplier would reply to that address — if it is wrong, stop now and fix Team Management');

    // ── A FALLBACK PAST PROCUREMENT IS THE "UNEXPECTED" CASE (ruling §6) ────
    //
    // "If the resolved person is unexpected: STOP. Do not generate the RFQ." The resolver cannot
    // know what the CEO expects — but it knows when it had to pass over the procurement roles
    // entirely, which is exactly when a human should look before money is spent. Explicit
    // acknowledgement, not a warning that scrolls past.
    if (signatory.fallback && !argv.includes('--signatory-ok')) {
      stop(`the signatory FELL BACK past procurement to ${signatory.name} (${signatory.role}).`,
        `${signatory.why}\n\n`
        + (signatory.skipped || []).map((sk) => `skipped: ${sk.name} (${sk.role}) — ${sk.reason}`).join('\n')
        + '\n\nThat may be correct — a letter from the company principal is honest — but it is not\n'
        + 'the ordinary case, so it is confirmed rather than assumed. If the procurement roles\n'
        + 'should be filled instead, do that in Team Management first.\n\n'
        + 'To proceed with this signatory deliberately, add --signatory-ok:\n\n'
        + `  railway ssh 'node scripts/office-prepare-first-rfq.js --rfq=${RFQ_ID} `
        + `--supplier=${SUPPLIER_ID} --signatory-ok'`);
    }

    // ══ 3c. THE FULL RECIPIENT SET, BEFORE THE PROVIDER IS INVOKED ════════
    //
    //   "Before invoking the provider, print: supplier; supplier destination; molecule/form;
    //    canonical CAS; quantity/specification; signatory name/title/email; To; CC; BCC; reason
    //    for every copied recipient. Expected CC for this workflow: Naresh/Naren only. If any
    //    unexpected recipient appears: STOP BEFORE PROVIDER INVOCATION."
    //
    // This is printed here, by the operator-facing script, AS WELL AS being enforced inside
    // prepareGovernedRFQ. Two different jobs: the kernel gate refuses an unauthorized recipient
    // whatever calls it, and this block puts the whole addressed envelope in front of a human
    // while it still costs nothing to change. The first real preparation showed why — the copy
    // list was correct in policy terms and wrong in fact, and nobody saw it until after the
    // letter existed and a rejection record had to be written.
    const copyTo = await rfqMod.resolveCopyContacts({}, signatory);
    const recipientViolation = rfqMod.verifyRecipientPolicy({
      to: sup.contact_email, cc: copyTo, bcc: [], signatory, supplier: sup,
    });

    // decide(), NOT guardSend(): the canonical CAS is read here only to show it, and guardSend
    // would persist an identity decision for a letter that may never be generated. The real,
    // recorded decision is made inside runGovernedProcurement below.
    const preview = await guard.decide(query, rfq);

    console.log('\n  ── THE ADDRESSED ENVELOPE (nothing has been generated or sent yet) ──\n');
    field('supplier', sup.name);
    field('supplier destination', sup.contact_email || '(none — nowhere to send)');
    field('molecule / form', preview.approved_name || rfq.molecule_name);
    field('canonical CAS', preview.approved_cas || '(none approved)');
    field('quantity / spec', `${rfq.target_quantity || '?'} at ${rfq.target_purity || '?'}`
      + `${Number(rfq.gmp_required) === 1 ? ', GMP required' : ''}`);
    field('signatory', `${signatory.name}, ${signatory.title} <${signatory.email}>`);
    field('To', sup.contact_email || '(none)');
    field('CC', copyTo.length ? copyTo.map((c) => `${c.name} <${c.email}>`).join(', ') : '(none)');
    field('BCC', '(none — this workflow sends no blind copies)');
    if (!copyTo.length) {
      note('NO copied recipient resolved. That is a valid letter, but the expected CC for this '
        + 'workflow is the company principal — check Team Management if that is a surprise.');
    }
    for (const c of copyTo) {
      field('  why copied', `${c.email} — ${c.why || '(no reason recorded)'}`);
    }

    if (recipientViolation) {
      stop(`the recipient set is NOT what this workflow permits (${recipientViolation.reason}).`,
        `${recipientViolation.detail}\n\n`
        + 'STOPPED BEFORE PROVIDER INVOCATION. No AI call was made, nothing was spent, and no\n'
        + 'approval was prepared — so there is nothing to reject and nothing to preserve.\n\n'
        + 'Platform administrative authority is not communication-recipient authority. Fix the\n'
        + 'user records in Team Management, then run this again.');
    }
    ok('the recipient set matches the policy for this workflow: supplier + the company principal');

    // ══ 4. WHAT THE BUDGET WOULD ALLOW, BEFORE SPENDING ════════════════════
    const bctx = Object.freeze({ companyId: company.id, objectiveId: OBJECTIVE_ID, runId: null });
    const before = await budget.enforceHierarchy(bctx, {
      objectiveId: OBJECTIVE_ID, criticality: 'routine', objectiveBudgetUsd: Number(obj.budget_usd),
    });
    console.log('');
    field('budget decision', before.allow ? 'ALLOWED' : `REFUSED (${before.scope}): ${before.reason}`);
    if (!before.allow) {
      stop('the budget would refuse this work before the provider is reached.', before.reason);
    }
    ok('the budget permits this work');

    // ══ 5. PREPARE. THE GUARD DECIDES FOR REAL AND THE DECISION IS KEPT ════
    console.log('\n  ── preparing through the governed path ──\n');
    const out = await rfqMod.runGovernedProcurement({
      objectiveId: OBJECTIVE_ID,
      rfqId: RFQ_ID,
      supplierId: SUPPLIER_ID,
      trigger: 'manual',
      triggerDetail: `§15 first governed supplier RFQ (prepared by office-prepare-first-rfq.js)`,
    });

    if (!out.ok) {
      // A refusal here is the system working. It is reported in full, not softened.
      console.log(`  REFUSED — ${out.refusal}\n`);
      if (out.guard_reason) field('guard reason', out.guard_reason);
      if (out.detail) field('detail', out.detail);
      if (out.decision_id) field('identity decision', out.decision_id);
      if (out.exception_id) field('exception queued', out.exception_id);
      if (out.runId) field('run', out.runId);
      console.log('\n  Nothing was prepared and nothing was sent. The refusal is the outcome.\n');
      console.log(out.refusal === 'identity_guard_refused'
        ? '  The identity of this RFQ is contested or unresolvable, so no supplier communication\n'
          + '  may be built from it — and the legacy generator is NOT a fallback.\n'
        : '');
      process.exit(1);
    }

    // ══ 6. THE REPORT §15 ASKS FOR ═════════════════════════════════════════
    console.log('  PREPARED — PENDING A HUMAN DECISION\n');
    field('supplier', `${sup.name} <${sup.contact_email}>`);
    field('molecule (approved)', out.identity.approved_name);
    field('approved CAS', out.identity.approved_cas || 'NONE — deliberately omitted');
    field('filed CAS', out.identity.filed_cas || '(none)');
    field('quantity', rfq.target_quantity || '(unspecified)');
    field('purity', rfq.target_purity || '(unspecified)');
    field('identity decision', out.identity.decision_id);
    if (out.signatory) {
      field('signed by', `${out.signatory.name}, ${out.signatory.title} <${out.signatory.email}>`);
      field('signatory user id', out.signatory.id || '(none)');
      field('copied to', (out.copyTo || []).length
        ? out.copyTo.map((c) => `${c.name} <${c.email}>`).join(', ')
        : '(nobody — the letter has one contact)');
      field('why that signatory', out.signatory.why || '(not stated)');
    }
    field('objective', out.objectiveId);
    field('run', out.runId);
    field('workflow / agent', `${out.workflow} / ${out.agent}`);
    field('run state', out.runState);
    field('approval id', out.approvalId);
    field('approval status', out.status);
    field('SENT', out.sent === false ? 'NO — nothing was transmitted' : 'UNEXPECTED');

    if (out.ai) {
      field('AI provider / model', `${out.ai.provider || '?'} / ${out.ai.model || '?'}`);
      field('AI cost', out.ai.costKnown === false || out.ai.cost_known === false
        ? 'UNKNOWN — consequential release is fail-closed'
        : `$${Number(out.ai.costUsd ?? out.ai.cost_usd ?? 0).toFixed(8)}`);
    }

    const spend = await scope.spendForObjective(bctx, OBJECTIVE_ID);
    field('objective spend', `$${Number(spend.usd).toFixed(8)} of $${obj.budget_usd}`
      + ` over ${spend.calls} call(s), ${spend.unknown_calls} unmeasured`);
    // §12 asks for enterprise daily spend at the boundary too, and the first report omitted it.
    const ent = await scope.spendToday(bctx);
    field('enterprise today', `$${Number(ent.usd).toFixed(8)} of $${budget.DAILY_CAP_USD}`
      + ` over ${ent.calls} call(s), ${ent.unknown_calls} unmeasured`);

    // ── THE EXACT COMMUNICATION ────────────────────────────────────────────
    console.log('\n  ── THE EXACT COMMUNICATION AWAITING APPROVAL ──\n');
    console.log(`  SUBJECT: ${out.subject}\n`);
    console.log(String(out.body).split('\n').map((l) => `  │ ${l}`).join('\n'));
    console.log('');

    // ── PROVENANCE ─────────────────────────────────────────────────────────
    const p = await scope.provenance(bctx, out.runId);
    console.log('\n  ── PROVENANCE CHAIN ──\n');
    if (!p) bad('provenance cannot answer for this run');
    else {
      console.log(`    objective   ${p.objective.id}  "${p.objective.objective}"`);
      console.log(`    set by      ${p.objective.created_by}  ·  KPI ${p.objective.kpi_metric}`
        + ` target ${p.objective.kpi_target}  ·  budget $${p.objective.budget_usd}`);
      console.log(`    run         ${p.run.run_id}  ${p.run.workflow}/${p.run.agent}  ${p.run.state}`);
      for (const c of p.ai_calls) {
        console.log(`    AI          ${c.provider}/${c.model}  ${c.tokens_input}→${c.tokens_output} tok  `
          + `${c.cost_known ? `$${Number(c.cost_usd).toFixed(8)}` : 'cost UNKNOWN'}`);
      }
      console.log(`    AI total    $${Number(p.ai_cost.measured_usd).toFixed(8)}`
        + `${p.ai_cost.lower_bound ? ' (LOWER BOUND — an unmeasured call exists)' : ''}`);
      for (const a of p.approvals) {
        console.log(`    approval    ${a.id}  ${a.action_kind}  ${a.status}  owner ${a.owner_user_id}`);
      }
      console.log(`    outcomes    ${p.outcomes.length}`);
      console.log(`    exceptions  ${p.exceptions.length}`);
      for (const e of p.exceptions) {
        console.log(`      ${e.severity}  ${e.source}  ${e.status}  ${String(e.reason).slice(0, 80)}`);
      }
    }

    // ══ 7. ASSERT THE BOUNDARY HELD ════════════════════════════════════════
    console.log('');
    if (out.status === 'pending') ok('the action is PENDING — it cannot release until a human approves it');
    else bad(`the action is "${out.status}", not pending`);
    if (out.sent === false) ok('nothing was transmitted');
    else bad('the path reported a send');

    const outcomes = (await query(
      `SELECT COUNT(*)::int n FROM office_outcomes WHERE objective_id = $1`, [OBJECTIVE_ID])).rows[0].n;
    if (outcomes === 0) {
      ok('no outcome recorded — a prepared RFQ is not a received quotation, and the KPI stays 0');
    } else bad(`${outcomes} outcome(s) recorded for an RFQ that has not even been sent`);

    const sent = (await query(
      `SELECT COUNT(*)::int n FROM supplier_outreach_log WHERE rfq_id = $1 AND supplier_id = $2`,
      [RFQ_ID, SUPPLIER_ID])).rows[0].n;
    if (sent === (sameSupplier.length)) ok('the supplier outreach log is unchanged — no claim was made');
    else bad(`the outreach log changed: ${sameSupplier.length} → ${sent}`);

    console.log('\n' + (fail ? `FAIL  ${fail} assertion(s) failed` :
      'PASS  one governed supplier RFQ is PREPARED and PENDING. Nothing was sent.\n\n'
      + '  ══ THE NEXT DECISION IS YOURS ══\n\n'
      + `  APPROVE or REJECT approval ${out.approvalId}.\n\n`
      + '  Read the communication above. Approving records your decision; it does not transmit,\n'
      + '  because no send capability exists in this build yet.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  preparation error:', e.stack || e.message);
    process.exit(1);
  }
})();
