#!/usr/bin/env node
// ── THE PRE-RELEASE REPORT. READS EVERY RELEASE PRECONDITION, RELEASES NOTHING ─
//
//   railway ssh 'node scripts/office-pre-release-report.js --approval=<id>'
//
// STRICTLY READ-ONLY. It does not release, does not claim a supplier, does not write
// ACTION_ATTEMPTED, does not call the mailer, and does not decide an approval. It issues no
// INSERT, UPDATE or DELETE of any kind.
//
// ── WHY IT CALLS THE REAL GATES RATHER THAN DESCRIBING THEM ─────────────────
//
// The kill switch (autonomy.checkStopped) and the cost gate (budget.consequentialReleaseGate) are
// both READS — verified: neither contains an INSERT, UPDATE, DELETE or openException call. So this
// report invokes THE SAME FUNCTIONS the release path invokes, and reports their verdicts.
//
// That matters more than it looks. A report that reimplemented those checks would drift from the
// release path silently, and the first time it disagreed would be the run where it falsely
// reassured somebody immediately before a real external send. The one thing this file must never
// do is tell a human a gate will pass when it will not.
//
// What it deliberately does NOT call is approval.release(), because that CLAIMS: it writes
// release_claimed_at and consumes the one-release-per-approval slot. The claim is the act; this is
// the look before the act.
//
// ── WHY THE SIGNATORY IS RE-CHECKED HERE ───────────────────────────────────
//
// The frozen payload records who the letter is from, and release revalidates that the person still
// holds authority — because the signatory can leave between approval and release, which is the
// 2 Nov incident arriving by a different route after a human had legitimately approved. This
// report runs the same check so the answer is known BEFORE release is authorized rather than
// discovered by a refusal.
//
// ── THE PAYLOAD HASH ───────────────────────────────────────────────────────
//
// A canonical (key-sorted) SHA-256 of the frozen action_payload. It is how "the frozen payload is
// unchanged" becomes checkable rather than asserted: the hash printed here is the hash of what a
// human approved, and the same command re-run before release must produce the same digest. The
// database trigger makes the payload immutable; this makes that verifiable from outside.
'use strict';

const crypto = require('crypto');

const scope = require('../src/lib/office/scope');
const budget = require('../src/lib/office/budget');
const autonomy = require('../src/lib/autonomy');
const rfqClaim = require('../src/lib/idempotency/supplier-rfq');
const { ledger: makeLedger } = require('../src/lib/run-ledger');
const { query } = require('../src/lib/db');

// Mirrors execute.js. Named here rather than imported so this report cannot pull the executor
// into the require graph — a read-only script must not be one `require` away from the mailer.
// `ledger` is a FACTORY taking { query }, not a ready object. The symbol check caught this; at
// runtime it would have been a TypeError inside the one script a human reads before a first
// production send.
const ledger = makeLedger({ query });

const WORKFLOW = 'governed-rfq-release';
const AGENT = 'release-executor';

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(22)} ${v}`);

const arg = (k, d = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

/** Canonical JSON: keys sorted at every depth, so the digest depends on content not key order. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

(async () => {
  try {
    const APPROVAL_ID = arg('approval');
    if (!APPROVAL_ID) {
      console.error('usage: office-pre-release-report.js --approval=<id>');
      process.exit(2);
    }

    console.log('\n══ PRE-RELEASE REPORT (READ-ONLY — RELEASES NOTHING) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // office_approvals is a kernel table, so it is read through the accessor that owns the name.
    const a = await scope.bootstrapApprovalForExecution(APPROVAL_ID);
    if (!a) { console.error(`  no approval ${APPROVAL_ID}\n`); process.exit(1); }

    const p = a.action_payload || {};
    const ctx = Object.freeze({
      companyId: a.company_id, objectiveId: a.objective_id, runId: a.run_id,
    });

    // ══ 1. THE APPROVAL ════════════════════════════════════════════════════
    console.log('  ── THE APPROVAL ──\n');
    field('approval id', a.id);
    field('status', a.status);
    field('resolution', a.resolution || '(none recorded)');
    field('resolved by / at', `${a.resolved_by || '(none)'} / ${a.resolved_at || '(none)'}`);
    field('action kind', a.action_kind);
    field('company', a.company_id);
    field('objective', a.objective_id);
    field('run', a.run_id);
    field('release mode', a.release_mode || '(unset)');

    if (a.status === 'approved') ok('status = approved');
    else if (a.status === 'superseded') {
      bad('status is SUPERSEDED — this action was approved and then superseded before any external '
        + 'execution, because a later correction made it no longer executable as prepared. It is '
        + 'terminal: release requires status="approved". A new preparation attempt is required, and '
        + 'the business intent is NOT consumed');
    } else bad(`status is "${a.status}", not approved — release requires approved`);
    if (a.status === 'superseded') {
      field('previous status', a.previous_status || '(not recorded)');
      field('superseded by / at', `${a.superseded_by || '(none)'} / ${a.superseded_at || '(none)'}`);
      field('supersession reason', a.superseded_reason || '(none)');
    }
    if (a.resolution) ok('the resolution is PERSISTED beside the verdict, not only printed');
    else bad('no resolution was persisted');
    if (a.release_mode === 'explicit') {
      ok('release_mode = explicit — approval alone cannot release this; a separate act is required');
    } else {
      bad(`release_mode is "${a.release_mode}" — on 'on_approval' this would release without a `
        + 'second human act, which is NOT what was authorized');
    }

    // ══ 2. THE FROZEN PAYLOAD ══════════════════════════════════════════════
    const digest = crypto.createHash('sha256').update(canonical(p)).digest('hex');
    console.log('\n  ── THE FROZEN PAYLOAD ──\n');
    field('payload sha256', digest);
    note('canonical (key-sorted) digest. Re-run this before release: a different digest means the');
    note('payload changed, which the immutability trigger should have made impossible.');
    field('supplier', `${p.supplier_name || '(none)'} (${p.supplier_id || 'no id'})`);
    // FROM IS DISPLAYED FIRST AND ITS ABSENCE IS A FAILURE. "A pre-release report without FROM is
    // incomplete." The first version of this report omitted it entirely, which is how an approval
    // whose sender would have come from a deployment variable passed every check here.
    field('FROM', p.from || '(NONE RECORDED)');
    field('destination (To)', p.to || '(none)');
    field('CC', (p.cc || []).join(', ') || '(none)');
    field('BCC', (p.bcc || []).length ? (p.bcc || []).join(', ') : '(none — explicitly empty)');
    field('molecule (approved)', p.approved_molecule_name || '(none)');
    field('canonical CAS', p.approved_cas || '(none approved)');
    field('identity decision', p.identity_decision_id ?? '(none)');
    field('subject', p.subject || '(none)');
    field('signatory', `${p.signed_by_name || '?'}, ${p.signed_by_title || '?'} <${p.signed_by_email || '?'}>`);
    field('signatory user id', p.signed_by_user_id || '(none)');

    for (const r of p.recipients || []) {
      field(`  ${r.kind}`, `${r.email} — ${r.relationship || '?'} — ${r.why || '(no reason)'}`);
    }
    if (Array.isArray(p.recipients) && p.recipients.length) ok('every recipient carries a recorded reason');
    else bad('the payload records no recipient provenance');

    // ── THE SENDER, WHICH IS PART OF THE EXTERNAL IDENTITY ────────────────
    if (p.sender_provenance) field('sender provenance', p.sender_provenance);
    if (p.attempt) field('intent / attempt', `${p.intent_key || '(none)'} · attempt ${p.attempt}`);
    if (!p.from || !p.from_email) {
      bad('THE PAYLOAD RECORDS NO SENDER — release would refuse sender_not_recorded. The external '
        + 'identity of this letter would otherwise be supplied by deployment configuration rather '
        + 'than by the human who approved it, and this action needs re-preparation');
    } else if (String(p.from_email).toLowerCase() !== String(p.signed_by_email || '').toLowerCase()) {
      bad(`the frozen sender ${p.from_email} is not the frozen signatory ${p.signed_by_email} — `
        + 'release would refuse sender_is_not_the_signatory');
    } else {
      const sd = String(p.from_email).toLowerCase().split('@')[1];
      const gd = String(p.signed_by_email).toLowerCase().split('@')[1];
      if (sd && sd === gd) ok('the sender is the signatory, inside one company boundary, and frozen');
      else bad(`the sender is at ${sd} but the letter is signed from ${gd} — release would refuse `
        + 'sender_outside_company_boundary');
    }

    // ══ 3. THE RELEASE PRECONDITIONS, AS THE REAL GATES ANSWER THEM ════════
    console.log('\n  ── RELEASE PRECONDITIONS (the same functions release calls) ──\n');

    // (a) THE SIGNATORY MUST STILL HOLD AUTHORITY. Same predicate as approval.release.
    const still = (await query(
      `SELECT id, name, email, role, is_active FROM users
        WHERE ($1::text IS NOT NULL AND id = $1) OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2))
        ORDER BY is_active DESC LIMIT 1`,
      [p.signed_by_user_id || null, p.signed_by_email || null])).rows[0];
    if (!p.signed_by_email && !p.signed_by_user_id) {
      bad('the payload records NO signatory — release would refuse signatory_not_recorded');
    } else if (still && Number(still.is_active) === 1) {
      field('signatory active', `YES — ${still.name} <${still.email}> (${still.role})`);
      ok('the person this letter is from is still active');
    } else {
      field('signatory active', 'NO');
      bad(`${p.signed_by_name || p.signed_by_email} is no longer active — release would refuse `
        + 'signatory_no_longer_active and require re-preparation');
    }

    // (b) THE KILL SWITCH. Read-only. Same scopes execute.js uses.
    let stopped = null; let killReadable = true;
    try {
      stopped = await autonomy.checkStopped({
        capability: 'email.send', workflow: WORKFLOW, agent: AGENT, company: a.company_id,
      }, { consequential: true });
    } catch (e) { killReadable = false; field('kill switch', `UNREADABLE — ${e.message}`); }
    if (!killReadable) {
      bad('the kill switch could not be read — release fails closed (killswitch_unreadable), '
        + 'because an unreadable stop is not permission to act');
    } else if (stopped && stopped.unknown === true) {
      // checkStopped does NOT throw when it cannot read the stops — it RETURNS a synthetic global
      // stop carrying `unknown: true`. An earlier version of this report reported that as "a stop
      // is in force", which tells a human someone deliberately halted sending when in fact the
      // kill state is unknowable. Same distinction R1 draws between provider_rejected and
      // transport_unknown: both block, and conflating them misdirects whoever investigates.
      field('kill switch', `UNKNOWABLE — ${stopped.reason}`);
      bad('the kill state could not be determined, so release FAILS CLOSED (killswitch_unreadable). '
        + 'This is not a deliberate stop — it is the absence of an answer, and the difference '
        + 'matters to whoever investigates');
    } else if (stopped) {
      field('kill switch', `STOPPED — ${stopped.scope_type}:${stopped.scope_key || '(global)'} — ${stopped.reason}`);
      bad('a deliberate stop is in force for email.send on this workflow — release would refuse '
        + 'stopped_by_policy');
    } else {
      field('kill switch', 'CLEAR — no stop in force for email.send on this workflow/agent/company');
      ok('no policy stop blocks a release');
    }

    // (c) THE COST GATE. Read-only.
    let gate = null;
    try {
      gate = await budget.consequentialReleaseGate(ctx, {
        runId: a.run_id, objectiveId: a.objective_id, objectiveBudgetUsd: a.budget_usd,
      });
    } catch (e) { field('budget gate', `UNAVAILABLE — ${e.message}`); }
    if (!gate) {
      bad('the budget gate could not be read — release would refuse budget_gate_unavailable, '
        + 'because an unreadable budget is not permission to act');
    } else if (gate.allow) {
      field('budget gate', `ALLOW${gate.reason ? ` (${gate.reason})` : ''}`);
      ok('the cost of this action is proven and within budget');
    } else {
      field('budget gate', `REFUSE (${gate.reason}) — ${gate.detail || ''}`);
      bad('the budget gate would refuse this release');
    }

    // (d) IDEMPOTENCY MUST BE ENFORCED BY THE DATABASE, not by this script's opinion.
    let enforced = null;
    try { enforced = await rfqClaim.isEnforced(query); } catch (_) { enforced = null; }
    field('idempotency index', enforced === true ? `ENFORCED (${rfqClaim.INDEX_NAME})` : String(enforced));
    if (enforced === true) ok('the unique index exists — a second send of this pair is refused by the database');
    else bad('the idempotency index is NOT enforced — release would refuse idempotency_not_enforced');

    // ══ 4. THE NEGATIVES. NOTHING MAY HAVE HAPPENED YET ════════════════════
    console.log('\n  ── NOTHING HAS HAPPENED YET (the assertions that matter most) ──\n');

    field('release_claimed_at', a.release_claimed_at || '(none)');
    field('released_at', a.released_at || '(none)');
    if (!a.release_claimed_at && !a.released_at) ok('no executor has claimed the right to attempt this');
    else bad('this approval has ALREADY been claimed for release', `${a.release_claimed_at || a.released_at}`);

    // The supplier claim. supplier_outreach_log is not a kernel table, so it is read directly.
    const claimRows = (await query(
      `SELECT id, status, sent_at, claimed_at, provider_message_id, provider_accepted_at
         FROM supplier_outreach_log WHERE rfq_id = $1 AND supplier_id = $2`,
      [p.rfq_id || null, p.supplier_id || null])).rows;
    field('supplier claim', claimRows.length
      ? claimRows.map((c) => `${c.id} ${c.status}`).join('; ') : 'NONE');
    if (!claimRows.length) ok('no supplier claim exists for this (RFQ, supplier) pair');
    else bad(`${claimRows.length} claim row(s) already exist for this pair`);

    // ACTION_ATTEMPTED on this run. Its presence would mean an external attempt was made.
    const events = await ledger.timeline(a.run_id).catch(() => []);
    const attempts = (events || []).filter((e) => e.kind === 'ACTION_ATTEMPTED');
    field('ACTION_ATTEMPTED', attempts.length ? `${attempts.length} — AN ATTEMPT WAS MADE` : 'NONE');
    if (!attempts.length) ok('no ACTION_ATTEMPTED exists — no external attempt has been recorded');
    else bad(`${attempts.length} ACTION_ATTEMPTED event(s) on this run`, JSON.stringify(attempts));

    const unresolved = await ledger.unresolvedActions({ limit: 50 }).catch(() => []);
    field('unresolved attempts', (unresolved || []).length);
    if (!(unresolved || []).length) ok('and no unresolved external attempt exists anywhere');
    else note(`${unresolved.length} unresolved attempt(s) exist on other runs — worth reading before release`);

    // ══ 5. SPEND, EXCEPTIONS, KPI ══════════════════════════════════════════
    console.log('\n  ── SPEND, EXCEPTIONS, KPI ──\n');
    const objSpend = await scope.spendForObjective(ctx, a.objective_id);
    const entSpend = await scope.spendToday(ctx);
    // THE FIELD NAMES ARE { usd, calls, unknown_calls }, read from scope.js rather than recalled.
    // An earlier draft of this file used measured_usd/measured_calls/unmeasured_calls — names from
    // a different function — and would have printed "$0.00000000 over ? call(s)" immediately
    // before a first production send. That is the same defect as reading guardSend()'s fields off
    // a decide() result: no crash, a plausible figure, and entirely wrong.
    field('objective spend', `$${Number(objSpend.usd || 0).toFixed(8)} of `
      + `$${Number(a.budget_usd || 0).toFixed(2)} over ${objSpend.calls} call(s), `
      + `${objSpend.unknown_calls} unmeasured`);
    field('enterprise today', `$${Number(entSpend.usd || 0).toFixed(8)} over `
      + `${entSpend.calls} call(s), ${entSpend.unknown_calls} unmeasured`);
    if (Number(objSpend.unknown_calls) === 0) ok('every AI call on this objective has a known cost');
    else note(`${objSpend.unknown_calls} unmeasured call(s) — the figure above is a LOWER BOUND`);

    const exceptions = await scope.listOpenExceptions(ctx);
    field('open exceptions', (exceptions || []).length);
    for (const e of exceptions || []) note(`${e.id} [${e.severity}] ${e.reason}`.slice(0, 160));
    if (!(exceptions || []).length) ok('no open exception stands against this company');

    // listOutcomes takes (ctx, deps) and is COMPANY-wide — it has no objectiveId parameter, so
    // the filter is applied here. Read from the function, not assumed from its name.
    const allOutcomes = await scope.listOutcomes(ctx).catch(() => []);
    const outcomes = (allOutcomes || []).filter((o) => o.objective_id === a.objective_id);
    field('outcomes (objective)', outcomes.length);
    field('outcomes (company)', (allOutcomes || []).length);

    // getObjective did not project the KPI columns, so the first version of this read went
    // straight to `objectives` — and the scope-discipline check refused it, correctly. The fix was
    // to widen the accessor rather than exempt the script: a KPI name and target are exactly what
    // other readers of an objective will want next, and a second place that knows the column names
    // is a second place to forget the company predicate.
    const kpi = (await scope.getObjective(ctx, a.objective_id).catch(() => null)) || {};
    field('KPI', `${kpi.kpi_metric || '(unnamed)'} = ${outcomes.length === 0 ? '0' : outcomes.length}`
      + `${kpi.kpi_target ? ` of target ${kpi.kpi_target}` : ''}`);
    if (!outcomes.length) {
      ok('the KPI is still 0 — a prepared, approved RFQ is not a received quotation');
    } else bad(`${outcomes.length} outcome(s) exist for an RFQ that has not been sent`);

    // ══ 6. THE VERDICT ═════════════════════════════════════════════════════
    console.log('');
    if (fail) {
      console.log(`FAIL  ${fail} pre-release assertion(s) failed. DO NOT RELEASE.\n`);
      process.exit(1);
    }
    console.log('PASS  approved, unreleased, unclaimed, unattempted. Every release precondition');
    console.log('      currently answers ALLOW, and nothing has been transmitted.\n');
    console.log('  ══ THE NEXT DECISION IS YOURS: RELEASE or HOLD ══\n');
    console.log('  Approval does not transmit this communication. R1 send capability IS deployed,');
    console.log('  but this objective is in explicit release mode, so a separate RELEASE');
    console.log('  authorization is required before any supplier communication is attempted.\n');
    console.log('  This report claimed nothing and sent nothing. The gate verdicts above are read');
    console.log('  AS OF NOW — release re-checks every one of them at the moment it acts.\n');
    process.exit(0);
  } catch (e) {
    console.error(`\nFAIL  ${e.stack || e.message}\n`);
    process.exit(1);
  }
})();
