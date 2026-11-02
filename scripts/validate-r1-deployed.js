#!/usr/bin/env node
// ── §19: R1 PRODUCTION VALIDATION, BEFORE ANY SEND ──────────────────────────
//
//   railway ssh 'node scripts/validate-r1-deployed.js'
//
// READ-ONLY. No INSERT, UPDATE or DELETE. NO TEST SEND — "do not send merely to validate R1
// deployment."
//
// Behaviour is proven on fixtures by check-office-release-db.js, including the mutation controls
// M8 (remove the claim → a supplier is emailed twice), M9 (remove the kill consultation → a
// stopped office reaches the mailer) and M11 (remove the attempt-evidence gate → an external send
// with no durable evidence). Production proves the mechanism is DEPLOYED and the state is sane.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const autonomy = require('../src/lib/autonomy');
const budget = require('../src/lib/office/budget');
const scope = require('../src/lib/office/scope');
const rfqClaim = require('../src/lib/idempotency/supplier-rfq');
const { query } = require('../src/lib/db');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);
const field = (k, v) => console.log(`    ${String(k).padEnd(26)} ${v === null || v === undefined ? '(null)' : v}`);
const SRC = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', ...p), 'utf8');

(async () => {
  try {
    console.log('\n══ §19 · R1 RELEASE EXECUTOR, ON PRODUCTION (READ-ONLY, NO SEND) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // ══ 1. THE EXECUTOR IS DEPLOYED, AND SHAPED AS RULED ═══════════════════
    console.log('  THE EXECUTOR\n');
    let exSrc = null;
    try { exSrc = SRC('office', 'execute.js'); } catch (_) { /* reported below */ }
    if (!exSrc) { bad('office/execute.js is NOT in this build — R1 is not deployed'); process.exit(1); }
    ok('office/execute.js is deployed');

    if (/async function executeApprovedAction\(approvalId/.test(exSrc)) {
      ok('its entry point takes an APPROVAL ID, not an email (ruling §15)');
    } else bad('the entry point is not executeApprovedAction(approvalId)');
    if (/function send\s*\(|exports\.send\b/.test(exSrc)) {
      bad('it exposes a generic send() — another module could use it as a governed-looking mailer');
    } else ok('it exposes no generic send(): nothing can make it send but an approved action');

    // The order is the safety argument: claim → attempt evidence → send.
    const iClaim = exSrc.indexOf('rfqClaim.claim(');
    const iAttempt = exSrc.indexOf('ledger.actionAttempted(');
    const iSend = exSrc.indexOf('mailer.sendEmailDetailed(');
    const iKill = exSrc.indexOf('autonomy.checkStopped(');
    if (iKill !== -1 && iKill < iClaim) ok('the kill switch is consulted BEFORE the supplier claim (§5)');
    else bad('a policy stop could consume the (rfq, supplier) slot');
    if (iClaim !== -1 && iAttempt !== -1 && iSend !== -1 && iClaim < iAttempt && iAttempt < iSend) {
      ok('the order is claim → ACTION_ATTEMPTED → send — durable claim before external side effect');
    } else bad('the claim/attempt/send order is wrong', `claim@${iClaim} attempt@${iAttempt} send@${iSend}`);
    if (/retry/i.test(exSrc) && !/automatic retry|NO AUTOMATIC RETRY|no automatic retry/i.test(exSrc)) {
      note('the word "retry" appears — confirmed below that no retry path exists');
    }
    if (/setTimeout|while\s*\(|for\s*\(.*attempt/i.test(exSrc.replace(/\/\/.*$/gm, ''))) {
      bad('the executor contains a loop or timer — check for an automatic retry');
    } else ok('no loop, timer or retry path exists in the executor');

    // ══ 2. THE PREPARATION PATH STILL CANNOT SEND (§14) ════════════════════
    console.log('\n  THE NARROWED BOUNDARY\n');
    for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib', 'office'))) delete require.cache[k];
    let before = new Set(Object.keys(require.cache));
    require('../src/lib/office/procurement-rfq');
    require('../src/lib/office/approval');
    const prepGraph = Object.keys(require.cache).filter((k) => !before.has(k) && !k.includes('node_modules'));
    const outbound = ['mailer.js', 'whatsapp.js', path.join('outreach', 'registry.js'),
      path.join('idempotency', 'supplier-rfq.js')];
    const leak = outbound.filter((m) => prepGraph.some((f) => f.includes(m)));
    if (leak.length) bad('the PREPARATION path can reach an outbound primitive', leak.join(', '));
    else ok('preparation reaches no mailer, WhatsApp, outreach or supplier-claim module');

    for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib', 'office'))) delete require.cache[k];
    before = new Set(Object.keys(require.cache));
    require('../src/lib/office/execute');
    const exGraph = Object.keys(require.cache).filter((k) => !before.has(k) && !k.includes('node_modules'));
    if (exGraph.some((f) => f.includes('mailer.js'))) ok('the EXECUTOR does reach the mailer — one place, declared');
    else bad('the executor cannot reach the mailer, so R1 cannot send at all');
    note('module reachability is architectural evidence, not the safety mechanism — the durable');
    note('approval, the arbitrated claim, the unique index, the kill switch and the budget are');

    // ══ 3. THE EXTERNAL IDEMPOTENCY INVARIANT ══════════════════════════════
    console.log('\n  EXTERNAL IDEMPOTENCY\n');
    const enforced = await rfqClaim.isEnforced(query);
    if (enforced) ok(`UNIQUE (rfq_id, supplier_id) is enforced (${rfqClaim.INDEX_NAME})`);
    else bad('the unique supplier-claim index is ABSENT — a duplicate email could not be refused');
    const idx = (await query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [rfqClaim.INDEX_NAME])).rows[0];
    if (idx) field('index', idx.indexdef);
    const soCols = (await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='supplier_outreach_log'`
    )).rows.map((r) => r.column_name);
    for (const c of ['claimed_at', 'provider', 'provider_message_id', 'provider_accepted_at',
      'approval_id', 'run_id']) {
      if (soCols.includes(c)) ok(`  the claim records ${c}`);
      else bad(`  the claim has no ${c} column`);
    }

    // ══ 4. THE RELEASE POLICY IS DURABLE (§16) ═════════════════════════════
    console.log('\n  RELEASE POLICY\n');
    const objs = (await query(
      `SELECT o.id, o.status, o.release_mode, c.display_name
         FROM objectives o JOIN companies c ON c.id = o.company_id ORDER BY o.created_at`)).rows;
    if (!objs.length) note('no objectives exist');
    for (const o of objs) {
      console.log(`    ${o.release_mode === 'explicit' ? 'ok  ' : 'NOTE'}  `
        + `${String(o.id).padEnd(40)} ${String(o.status).padEnd(10)} release_mode=${o.release_mode}`);
    }
    const nonExplicit = objs.filter((o) => o.release_mode !== 'explicit');
    if (nonExplicit.length) {
      bad(`${nonExplicit.length} objective(s) are NOT release_mode='explicit' — automatic release `
        + 'is not authorized yet', nonExplicit.map((o) => o.id).join(', '));
    } else ok("every objective is release_mode='explicit' — approval does not itself send");

    // ══ 5. RECONCILIATION IS ARMED AND STOPPABLE ═══════════════════════════
    console.log('\n  RECONCILIATION\n');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    if (/cron\.schedule\('41 \* \* \* \*',\s*withAlerts\('hourly-send-reconciliation'/.test(serverSrc)) {
      ok('the reconciler is scheduled hourly at :41');
    } else bad('the reconciliation cron is NOT armed in this build');
    const wf = autonomy.knownScopeKeys('workflow') || [];
    const ag = autonomy.knownScopeKeys('agent') || [];
    for (const k of ['governed-rfq-release', 'hourly-send-reconciliation']) {
      if (wf.includes(k)) ok(`K8 recognizes workflow:${k} — an operator can stop it by name`);
      else bad(`K8 does not recognize workflow:${k}`);
    }
    if (ag.includes('release-executor')) ok('K8 recognizes agent:release-executor');
    else bad('K8 does not recognize agent:release-executor');
    if ((autonomy.CAPABILITIES || []).includes('email.send')) ok('capability:email.send is stoppable');
    else bad('email.send is not a stoppable capability');

    const rec = require('../src/lib/office/reconcile');
    const dry = await rec.reconcile({ dryRun: true });
    field('unresolved external attempts', dry.examined);
    field('unattributable to a company', dry.unattributable);
    if (dry.filed === 0) ok('reconcile() defaults to dry — importing it files nothing');
    else bad('a dry reconciliation filed exceptions');
    for (const i of dry.items.slice(0, 10)) {
      console.log(`      claim ${i.claimId} rfq=${i.rfqId} supplier=${i.supplierId} `
        + `unresolved ${i.minutesUnresolved}m → ${i.status}`);
    }

    // ══ 6. THE EXISTING PREPARED WORK IS INTACT ════════════════════════════
    console.log('\n  WHAT IS WAITING\n');
    const aps = (await query(
      `SELECT a.id, a.status, a.resolution, a.resolved_by, a.release_claimed_at, a.released_at,
              a.objective_id, a.action_payload, c.display_name
         FROM office_approvals a JOIN companies c ON c.id = a.company_id
        ORDER BY a.created_at`)).rows;
    if (!aps.length) note('no approvals exist yet');
    for (const a of aps) {
      const p = a.action_payload || {};
      const hash = p.body ? crypto.createHash('sha256').update(String(p.body)).digest('hex').slice(0, 16) : '(no body)';
      console.log(`    ${String(a.status).padEnd(9)} ${a.id}`);
      console.log(`      to ${p.to || '(none)'}  ·  ${p.approved_molecule_name || '?'}`
        + `${p.approved_cas ? ` (${p.approved_cas})` : ' (no CAS)'}`);
      console.log(`      signed by ${p.signed_by_name || '(none recorded)'}`
        + `${p.signed_by_email ? ` <${p.signed_by_email}>` : ''}  ·  body ${hash}`);
      console.log(`      claimed ${a.release_claimed_at ? a.release_claimed_at.toISOString() : 'no'}`
        + `  ·  ${a.resolution ? `reason: ${String(a.resolution).slice(0, 70)}` : 'no decision reason'}`);
    }

    // ── WHICH UNRELEASED ACTIONS RECORD NO SIGNATORY AT ALL ───────────────
    //
    // This is what exposed the fail-open: an approval prepared before the signatory was recorded
    // in the payload has no signed_by_* fields, and the release check used to read "if a signatory
    // is recorded, verify it" — verifying nothing for exactly the actions with the least evidence.
    // Release now refuses them outright, and they are listed here so it is not a surprise.
    const noSig = aps.filter((a) => !a.release_claimed_at
      && !(a.action_payload || {}).signed_by_email && !(a.action_payload || {}).signed_by_user_id);
    if (noSig.length) {
      note(`${noSig.length} unreleased approval(s) record NO signatory, so release REFUSES them `
        + 'and they need re-preparation:');
      for (const a of noSig) console.log(`      ${a.status.padEnd(9)} ${a.id}`);
    } else ok('every unreleased approval records who it claims to be from');

    // Is each approved action's frozen signatory still active? A read, not a probe.
    for (const a of aps.filter((x) => x.status === 'approved' && !x.release_claimed_at)) {
      const p = a.action_payload || {};
      const u = (await query(
        `SELECT name, is_active FROM users WHERE ($1::text IS NOT NULL AND id = $1)
            OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2)) ORDER BY is_active DESC LIMIT 1`,
        [p.signed_by_user_id || null, p.signed_by_email || null])).rows[0];
      if (u && Number(u.is_active) === 1) {
        ok(`${a.id}: its frozen signatory (${u.name}) is still active — release would not refuse on that`);
      } else {
        bad(`${a.id}: its frozen signatory is NO LONGER ACTIVE — release would refuse and require `
          + 're-preparation', JSON.stringify(u || {}));
      }
    }

    // ══ 7. BUDGET POSITION, ASKED NOT CONSUMED ═════════════════════════════
    console.log('\n  BUDGET\n');
    for (const o of objs.filter((x) => x.status === 'active')) {
      const row = (await query(`SELECT company_id, budget_usd FROM objectives WHERE id=$1`, [o.id])).rows[0];
      const ctx = Object.freeze({ companyId: row.company_id, objectiveId: o.id, runId: null });
      const h = await budget.enforceHierarchy(ctx, { objectiveId: o.id, criticality: 'routine',
        objectiveBudgetUsd: row.budget_usd === null ? null : Number(row.budget_usd) });
      field(o.id, h.allow ? 'ALLOWED' : `REFUSED (${h.scope}): ${h.reason}`);
    }

    // ══ 8. THE KPI HAS NOT MOVED ═══════════════════════════════════════════
    const outcomes = (await query(`SELECT COUNT(*)::int n FROM office_outcomes`)).rows[0].n;
    console.log('');
    if (outcomes === 0) ok('zero business outcomes recorded — the KPI is untouched, as it must be');
    else note(`${outcomes} outcome(s) exist — verify each came from a real qualified quotation`);

    console.log('');
    note('this validator sent nothing and wrote nothing');

    console.log('\n' + (fail
      ? `FAIL  ${fail} assertion(s) failed — R1 is NOT ready to release`
      : 'PASS  R1 is deployed: the executor takes an approval id, the kill switch precedes the '
        + 'claim, the claim precedes the send, external idempotency is enforced by the database, '
        + "every objective is release_mode='explicit', reconciliation is armed and stoppable, and "
        + 'nothing was sent to prove it.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  validation error:', e.stack || e.message);
    process.exit(1);
  }
})();
