#!/usr/bin/env node
// ── R1 RELEASE EXECUTOR: BEHAVIOURAL PROOF ON A THROWAWAY CLUSTER ───────────
//
//   node scripts/check-office-release-db.js        exit 0 = the executor holds
//
// The module under test is the ONLY one in the office that can send to an external party, so every
// refusal path is exercised here, where a wrong prediction costs nothing. Production proves the
// mechanism is deployed and never performs a test send (Rule 7).
//
// THE MAILER IS A SPY, NOT A STUB. Several assertions are "the mailer was never called", which a
// stub returning success cannot distinguish from "called and succeeded". The spy counts calls, so
// "no claim, no mailer" is measured rather than inferred.
//
// ── THE CASES (ruling §18) ─────────────────────────────────────────────────
//
//   pending approval                      → no claim, no mailer
//   rejected approval                     → no claim, no mailer
//   inactive frozen signatory             → no claim, no mailer, exception, re-preparation
//   unknown cost                          → no claim, no mailer
//   objective budget exhausted            → no claim, no mailer
//   kill switch on email.send             → no claim, no mailer, slot NOT consumed
//   idempotency index absent              → no claim, no mailer
//   claim conflict                        → no mailer, no second send, previous claim untouched
//   ACTION_ATTEMPTED cannot persist       → no mailer
//   provider rejects definitively         → claim 'failed', exception, no retry
//   transport unknown                     → claim stays UNRESOLVED, exception, no retry
//   provider accepts                      → claim 'sent', provider id persisted, ACTION_SUCCEEDED
//   release_mode='explicit'               → an autonomous caller is refused by stored policy
//   second release of the same approval   → refused, no second mailer call
//   the KPI                               → never touched by a send
//   reconciliation                        → exactly ONE open exception per unresolved claim
//
//   M8  remove the supplier claim         → the same (rfq, supplier) is sent twice
//   M9  remove the kill consultation      → a stopped office still reaches the mailer
//   M10 claim AFTER the send              → an external effect with no durable claim
//   M11 remove the ACTION_ATTEMPTED gate  → sending without durable attempt evidence
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').slice(0, 10).map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

let temp = null;
function startCluster() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync(path.join('/var/tmp', 'r1rel-'));
  const run = (c) => execFileSync('bash', ['-c', c], { stdio: 'pipe' });
  try {
    if (process.getuid && process.getuid() === 0) {
      execFileSync('bash', ['-c', `chown -R postgres ${base}`], { stdio: 'pipe' });
      run(`su postgres -c "PATH=${dir}:\\$PATH initdb -D ${base}/data ${INITDB_FLAGS}"`);
      run(`su postgres -c "PATH=${dir}:\\$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55983 -c listen_addresses=' start -w"`);
    } else {
      run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
      run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55983 -c listen_addresses=' start -w`);
    }
  } catch (e) {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    return null;
  }
  temp = { base, dir };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55983&sslmode=disable`;
}
function stopCluster() {
  if (!temp) return;
  const c = process.getuid && process.getuid() === 0
    ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
    : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`;
  try { execFileSync('bash', ['-c', c], { stdio: 'pipe' }); } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
  temp = null;
}

console.log('\nR1 release executor\n');
const url = startCluster();
if (!url) { console.log('  skip  no Postgres available'); process.exit(EXIT_NOT_EXECUTED); }
process.env.DATABASE_URL = url;
process.env.RESEND_API_KEY = 'test-key';

const REPO = path.resolve(__dirname, '..');
const EXF = path.join(REPO, 'src', 'lib', 'office', 'execute.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const fresh = (rel) => { delete require.cache[path.join(REPO, rel)]; };
const freshOffice = () => {
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib', 'office'))) delete require.cache[k];
};

(async () => {
  const { query: q } = require('../src/lib/db');
  let mailerSpy;
  try {
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await q(`CREATE TABLE IF NOT EXISTS supplier_outreach_log (
      id TEXT PRIMARY KEY, rfq_id TEXT, supplier_id TEXT, email_sent_to TEXT, email_subject TEXT,
      email_body TEXT, sent_at TEXT, replied_at TEXT, reply_text TEXT, status TEXT DEFAULT 'sent')`);
    await require('../src/lib/idempotency/supplier-rfq').migrate(q);
    await q(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT NOW())`);
    await q(`INSERT INTO users (id,email,name,role,is_active)
             VALUES ('u-dir','dir@fixture.invalid','Fixture Director','procurement_director',1)`);

    const scope = require('../src/lib/office/scope');
    const { ledger } = require('../src/lib/run-ledger');
    const L = ledger({ query: q, onDurabilityFailure: () => {} });
    const deps = { query: q };


    // A spy, so "the mailer was never called" is measurable.
    const makeSpy = (impl) => {
      const spy = { calls: [], sendEmailDetailed: async (o) => { spy.calls.push(o); return impl(o); } };
      return spy;
    };
    const accepts = () => makeSpy(async () => ({ ok: true, id: 'resend-msg-1',
      phase: 'provider_accepted', providerResponded: true, provider: 'resend' }));
    const rejects = () => makeSpy(async () => ({ ok: false, id: null, error: 'domain not verified',
      phase: 'provider_rejected', providerResponded: true, provider: 'resend' }));
    const transportUnknown = () => makeSpy(async () => ({ ok: false, id: null,
      error: 'socket hang up', phase: 'transport_unknown', providerResponded: false, provider: 'resend' }));

    // One objective + one prepared, approved action per case.
    let n = 0;
    const prepare = async ({ releaseMode = 'explicit', signatoryActive = true, cost = 0.001,
      costKnown = true, budget = 10, rfqId = null, supplierId = null, approve = true,
      recordSignatory = true,
      // ── THE FROZEN SENDER ─────────────────────────────────────────────────
      // Present by DEFAULT, because every case in this harness measures something else and a
      // missing sender would now refuse them all before they reached their own gate — the
      // gate-contamination pattern. The knobs exist for the sender cases themselves.
      recordSender = true, senderEmail = 'dir@fixture.invalid',
      senderName = 'Fixture Director' } = {}) => {
      n += 1;
      // ── ONE COMPANY PER CASE, AND THE REASON IS THE POINT ─────────────────
      //
      // consequentialReleaseGate refuses when spend cannot be PROVEN, and that question is asked
      // per company per day. So the unknown-cost case's single unmeasured row made every later
      // release in this harness refuse with budget_enterprise — correct production behaviour,
      // fail-closed, and it masked everything after it. The same masking as M4 and M7.
      //
      // Isolating per company removes the unrelated reason instead of weakening the gate.
      const CO = `co-r1-${n}`;
      await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [CO]);
      const OID = `r1-obj-${n}`;
      await scope.createObjective({ id: OID, companyId: CO, objective: `R1 fixture ${n}`,
        priority: 'P3', kpiMetric: 'qualified_supplier_quotes_received', kpiTarget: 1,
        deadline: '2026-12-31', budgetUsd: budget, autonomyTier: 'supervised',
        approvalPolicy: 'all_consequential', createdBy: 'test' }, deps);
      await q(`UPDATE objectives SET status='active', release_mode=$2 WHERE id=$1`, [OID, releaseMode]);
      const ctx0 = Object.freeze({ companyId: CO, objectiveId: OID, runId: null });
      const begun = await require('../src/lib/office/run').beginObjectiveRun({
        objectiveId: OID, trigger: 'manual', workflow: 'governed-rfq-generation',
        agent: 'procurement-agent', intentKey: `r1-${n}` }, deps);
      await L.startRun(begun.runId);
      const ctx = begun.context;
      // `undefined` means record nothing; `null` with costKnown:false means record an UNMEASURED
      // call. The first version guarded on `cost !== null`, so the unknown-cost case recorded no
      // row at all and the run's spend was trivially provable — the fixture asserted a refusal
      // that could never happen, and the executor was right to release.
      if (cost !== undefined) {
        await scope.recordCost(ctx, { runId: begun.runId, provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001', tokensInput: 100, tokensOutput: 100,
          costUsd: costKnown ? cost : null, costKnown, agent: 'procurement-agent',
          workflow: 'governed-rfq-generation' }, deps);
      }
      const apId = `ap-r1-${n}`;
      await scope.requestApproval(ctx, {
        id: apId, runId: begun.runId, actionKind: 'send_rfq_email',
        actionPayload: {
          rfq_id: rfqId || `rfq-${n}`, supplier_id: supplierId || `sup-${n}`,
          supplier_name: `Fixture Supplier ${n}`, to: `s${n}@fixture.invalid`,
          subject: `RFQ — fixture ${n}`, body: `Dear supplier,\n\nPlease quote.\n\nFixture Director`,
          cc: ['principal@fixture.invalid'],
          approved_molecule_name: 'Candidatium', approved_cas: '36282-47-0',
          identity_decision_id: `dec-${n}`,
          ...(recordSignatory ? {
            signed_by_name: 'Fixture Director', signed_by_title: 'Procurement Director',
            signed_by_email: 'dir@fixture.invalid', signed_by_user_id: 'u-dir',
          } : {}),
          ...(recordSender ? {
            from: `${senderName} <${senderEmail}>`, from_email: senderEmail,
            from_name: senderName, from_user_id: 'u-dir',
          } : {}),
        },
        reason: 'R1 fixture: a supplier communication requires human approval',
        ownerUserId: 'u-dir',
      }, deps);
      if (approve) {
        await scope.decideApproval(ctx, { id: apId, decision: 'approved', resolvedBy: 'ceo',
          resolution: 'R1 fixture approval, recorded with a reason' }, deps);
      }
      if (!signatoryActive) await q(`UPDATE users SET is_active=0 WHERE id='u-dir'`);
      return { apId, OID, runId: begun.runId, ctx, CO };
    };
    const reactivate = () => q(`UPDATE users SET is_active=1 WHERE id='u-dir'`);
    const claims = async (apId) => (await q(
      `SELECT COUNT(*)::int n FROM supplier_outreach_log WHERE approval_id=$1`, [apId])).rows[0].n;

    const exec = (spy) => {
      freshOffice();
      const m = require('../src/lib/office/execute');
      return (apId, opts = {}) => m.executeApprovedAction(apId,
        { releasedBy: 'naren', requireExplicitRelease: true, ...opts },
        { query: q, mailer: spy, ledger: L });
    };

    // ══ REFUSALS THAT MUST NOT CLAIM AND MUST NOT CALL THE MAILER ══════════
    note('every internal gate must refuse BEFORE any external identity is consumed');

    {
      const { apId } = await prepare({ approve: false });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      if (!r.ok && r.refusal === 'not_approved') ok('a PENDING approval is refused');
      else bad('a pending approval was released', JSON.stringify(r).slice(0, 180));
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad(`  claim/mailer leaked: claims=${await claims(apId)} mailerCalls=${mailerSpy.calls.length}`);
    }

    {
      const { apId, ctx } = await prepare({ approve: false });
      await scope.decideApproval(ctx, { id: apId, decision: 'rejected', resolvedBy: 'ceo',
        resolution: 'rejected in the fixture on purpose' }, deps);
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      if (!r.ok && r.refusal === 'not_approved') ok('a REJECTED approval is refused');
      else bad('a rejected approval was released', JSON.stringify(r).slice(0, 180));
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad('  claim/mailer leaked on a rejected approval');
    }

    {
      const { apId } = await prepare({ signatoryActive: false });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      await reactivate();
      if (!r.ok && r.refusal === 'signatory_no_longer_active') {
        ok('an INACTIVE frozen signatory is refused');
        if (r.needs_repreparation) ok('  and re-preparation is required, not substitution');
        else bad('  it refused without requiring re-preparation');
        if (r.exception_id) ok('  with a durable exception'); else bad('  no exception filed');
      } else bad('a letter from an inactive signatory was released', JSON.stringify(r).slice(0, 180));
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad('  claim/mailer leaked on an inactive signatory');
    }

    {
      // ── AN APPROVAL THAT RECORDS NO SIGNATORY AT ALL ─────────────────────
      //
      // The real case: two production approvals were prepared before the signatory was recorded in
      // the payload. The release check read "if a signatory is recorded, verify it", so for
      // exactly those — the actions with the LEAST evidence about who they claim to be from — it
      // verified nothing. Both are signed in their body by somebody who has left.
      const { apId } = await prepare({ recordSignatory: false });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      if (!r.ok && r.refusal === 'signatory_not_recorded') {
        ok('an approval recording NO signatory is REFUSED — absence is not permission');
        if (r.needs_repreparation) ok('  and re-preparation is required');
        else bad('  it refused without requiring re-preparation');
        if (r.exception_id) ok('  with a durable exception'); else bad('  no exception filed');
      } else bad('a letter with no recorded signatory was released', JSON.stringify(r).slice(0, 200));
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad('  claim/mailer leaked on a letter with no recorded signatory');
    }

    {
      const { apId } = await prepare({ cost: null, costKnown: false });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      // THE EXACT REASON, not a pattern that several gates would satisfy. `/unmeasured|budget/`
      // would have passed on budget_enterprise, budget_objective or unmeasured_ai_cost — three
      // independent controls — so it proved only that SOMETHING refused. That is Gate
      // Contamination / False Attribution, and this file has produced it four times.
      if (!r.ok && r.refusal === 'unmeasured_ai_cost') ok('UNKNOWN COST is refused BY THE COST GATE');
      else bad(`expected unmeasured_ai_cost, got "${r.refusal}" — a different control refused, so `
        + 'the cost gate was never measured', JSON.stringify(r).slice(0, 180));
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad('  claim/mailer leaked on unknown cost');
    }

    {
      const { apId } = await prepare({ budget: 0.01, cost: 0.02 });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      // Specifically the OBJECTIVE scope. `/budget/` would also pass on budget_enterprise, which
      // is a different cap and a different claim.
      if (!r.ok && r.refusal === 'budget_objective') {
        ok('an EXHAUSTED OBJECTIVE budget is refused by the objective cap');
      } else bad(`expected budget_objective, got "${r.refusal}" — the objective cap was not what `
        + 'refused', JSON.stringify(r).slice(0, 180));
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad('  claim/mailer leaked on an exhausted budget');
    }

    // ══ THE KILL SWITCH MUST NOT CONSUME THE SLOT (ruling §5) ══════════════
    {
      const { apId } = await prepare();
      const autonomy = require('../src/lib/autonomy');
      await autonomy.stop({ scope_type: 'capability', scope_key: 'email.send',
        reason: 'R1 fixture: prove a policy stop does not burn the supplier slot', actor: 'test' });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      if (!r.ok && r.refusal === 'stopped_by_policy') ok('a KILL SWITCH on email.send refuses the release');
      else bad('a stopped office released anyway', JSON.stringify(r).slice(0, 180));
      if (mailerSpy.calls.length === 0) ok('  the mailer was never called');
      else bad('  the mailer was called under a policy stop');
      if (await claims(apId) === 0) ok('  AND NO CLAIM WAS WRITTEN — the (rfq, supplier) slot is not consumed');
      else bad('  a policy stop consumed the external-attempt identity');
      await autonomy.resume({ scope_type: 'capability', scope_key: 'email.send',
        reason: 'R1 fixture complete — releasing the halt', actor: 'test' });
      // The same approval must now be releasable: the stop cost nothing permanent.
      mailerSpy = accepts();
      const again = await exec(mailerSpy)(apId);
      if (again.ok && again.sent === true) ok('  and after the resume the SAME action releases normally');
      else bad('  the stop left the action permanently unreleasable', JSON.stringify(again).slice(0, 180));
    }

    // ══ THE HAPPY PATH ═════════════════════════════════════════════════════
    note('provider acceptance: the claim, the provider id, and the terminal event');
    let happy;
    {
      // An explicit, shared pair, so the conflict and M8 cases can target it WITHOUT updating an
      // immutable payload. The first version wrote `rfq-${n}` at the CALL site, where n was still
      // the previous case's number — so the duplicate already held the right pair and the UPDATE
      // that was supposed to point it there was a silent no-op the immutability trigger allowed.
      // The test passed for the wrong reason; M8, which used a genuinely different pair, was
      // correctly refused by the trigger and that is what exposed it.
      happy = await prepare({ rfqId: 'rfq-shared', supplierId: 'sup-shared' });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(happy.apId);
      if (r.ok && r.sent === true) ok('an approved action with every gate passed is SENT');
      else bad('the happy path did not send', JSON.stringify(r).slice(0, 220));
      if (mailerSpy.calls.length === 1) ok('  the mailer was called exactly once');
      else bad(`  the mailer was called ${mailerSpy.calls.length} times`);
      const sent = mailerSpy.calls[0] || {};
      if (sent.to === `s${n}@fixture.invalid`) ok('  to the frozen destination');
      else bad('  wrong destination', sent.to);
      if (sent.subject === `RFQ — fixture ${n}`) ok('  with the frozen subject');
      else bad('  the subject was changed', sent.subject);
      if (/Please quote/.test(String(sent.html))) ok('  and the frozen body');
      else bad('  the body was not the frozen one');
      if (sent.replyTo === 'dir@fixture.invalid') ok('  replies addressed to the frozen signatory');
      else bad('  wrong reply-to', sent.replyTo);
      // The copy list comes from the frozen payload, never re-resolved at release.
      if (Array.isArray(sent.cc) && sent.cc.length === 1 && sent.cc[0] === 'principal@fixture.invalid') {
        ok('  and copied to the FROZEN copy list, not one re-resolved at release');
      } else bad('  the frozen copy list was not transmitted', JSON.stringify(sent.cc));

      const c = (await q(`SELECT status, provider, provider_message_id, provider_accepted_at, run_id
                            FROM supplier_outreach_log WHERE approval_id=$1`, [happy.apId])).rows[0];
      if (c && c.status === 'sent') ok('  the claim is confirmed sent');
      else bad('  the claim was not confirmed', c && c.status);
      if (c && c.provider_message_id === 'resend-msg-1' && c.provider === 'resend') {
        ok('  the provider message id is persisted (ruling §9)');
      } else bad('  the provider id was not persisted', JSON.stringify(c || {}));
      if (c && c.provider_accepted_at) ok('  with the acceptance timestamp');
      else bad('  no acceptance timestamp');

      const ev = (await q(`SELECT kind FROM agent_run_events WHERE run_id=$1 ORDER BY id`,
        [happy.runId])).rows.map((x) => x.kind);
      const ia = ev.indexOf('ACTION_ATTEMPTED'), is = ev.indexOf('ACTION_SUCCEEDED');
      if (ia !== -1 && is !== -1 && ia < is) ok('  ACTION_ATTEMPTED precedes ACTION_SUCCEEDED');
      else bad('  the attempt/success ordering is wrong', ev.join(' → '));

      const outc = (await q(`SELECT COUNT(*)::int n FROM office_outcomes WHERE objective_id=$1`,
        [happy.OID])).rows[0].n;
      if (outc === 0) ok('  NO business outcome — a send is not a quotation, and the KPI stays 0');
      else bad(`  ${outc} outcome(s) recorded for a mere send`);
    }

    // ══ A SECOND RELEASE OF THE SAME APPROVAL ══════════════════════════════
    {
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(happy.apId);
      if (!r.ok && r.refusal === 'already_claimed') ok('a SECOND release of the same approval is refused');
      else bad('the same approval released twice', JSON.stringify(r).slice(0, 180));
      if (mailerSpy.calls.length === 0) ok('  and the mailer was not called again');
      else bad('  the mailer was called on a second release');
    }

    // ══ A CLAIM CONFLICT — ANOTHER APPROVAL FOR THE SAME (RFQ, SUPPLIER) ═══
    {
      const dup = await prepare({ rfqId: 'rfq-shared', supplierId: 'sup-shared' });
      const pair = { rfq_id: 'rfq-shared', supplier_id: 'sup-shared' };
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(dup.apId);
      if (!r.ok && r.refusal === 'already_claimed_externally') {
        ok('a CLAIM CONFLICT refuses: this supplier already holds this RFQ');
      } else bad('a duplicate supplier send was permitted', JSON.stringify(r).slice(0, 200));
      if (mailerSpy.calls.length === 0) ok('  the mailer was never called');
      else bad('  a duplicate reached the mailer');
      const stillOne = (await q(`SELECT COUNT(*)::int n FROM supplier_outreach_log
                                   WHERE rfq_id=$1 AND supplier_id=$2`, [pair.rfq_id, pair.supplier_id])).rows[0].n;
      if (stillOne === 1) ok('  and the previous claim is untouched — not deleted to make room');
      else bad(`  the claim table now holds ${stillOne} rows for that pair`);
    }

    // ══ PROVIDER REJECTS DEFINITIVELY ══════════════════════════════════════
    {
      const f = await prepare();
      mailerSpy = rejects();
      const r = await exec(mailerSpy)(f.apId);
      if (!r.ok && r.refusal === 'send_failed_definitively') ok('a DEFINITE provider rejection is recorded as a failure');
      else bad('a provider rejection was mishandled', JSON.stringify(r).slice(0, 200));
      const c = (await q(`SELECT status, error FROM supplier_outreach_log WHERE approval_id=$1`, [f.apId])).rows[0];
      if (c && c.status === 'failed') ok('  the claim is marked failed — acceptance IS ruled out here');
      else bad('  the claim status is wrong', c && c.status);
      if (r.exception_id) ok('  a critical exception was filed'); else bad('  no exception');
      if (mailerSpy.calls.length === 1) ok('  and NO automatic retry');
      else bad(`  the mailer was called ${mailerSpy.calls.length} times — something retried`);
    }

    // ══ THE KNOWN UNKNOWN ══════════════════════════════════════════════════
    note('transport failure where provider acceptance cannot be ruled out (ruling §8 window B)');
    let unknownCase;
    {
      unknownCase = await prepare();
      mailerSpy = transportUnknown();
      const r = await exec(mailerSpy)(unknownCase.apId);
      if (!r.ok && r.refusal === 'send_outcome_unknown' && r.knownUnknown) {
        ok('a transport failure is a KNOWN UNKNOWN, not a failure');
      } else bad('an ambiguous transport failure was classified definitively', JSON.stringify(r).slice(0, 200));
      if (r.sent === null) ok('  sent is reported as null — neither true nor false');
      else bad('  sent was asserted as a boolean', String(r.sent));
      const c = (await q(`SELECT status, error FROM supplier_outreach_log WHERE approval_id=$1`,
        [unknownCase.apId])).rows[0];
      if (c && c.status === 'pending') ok('  the claim STAYS unresolved — not failed, not sent');
      else bad('  the claim was resolved to a state nobody knows', c && c.status);
      if (c && /KNOWN UNKNOWN/.test(c.error || '')) ok('  and says so in the recorded error');
      else bad('  the error does not record the uncertainty', c && c.error);
      if (mailerSpy.calls.length === 1) ok('  no retry'); else bad('  something retried');
    }

    // ══ RECONCILIATION: ONE INCIDENT PER CLAIM (ruling §12, §13) ═══════════
    {
      const reconcile = require('../src/lib/office/reconcile');
      // Age the unresolved claim past the window rather than waiting 15 minutes.
      await q(`UPDATE supplier_outreach_log SET claimed_at = NOW() - INTERVAL '30 minutes'
                 WHERE status='pending'`);
      const dry = await reconcile.reconcile({ dryRun: true }, deps);
      if (dry.filed === 0 && dry.examined > 0) ok(`reconcile() defaults to dry: ${dry.examined} examined, 0 filed`);
      else bad('the reconciler filed in dry mode', JSON.stringify(dry).slice(0, 160));

      const first = await reconcile.reconcile({ dryRun: false }, deps);
      if (first.filed >= 1) ok(`the reconciler files an exception per unresolved claim (${first.filed})`);
      else bad('nothing was filed for an unresolved claim', JSON.stringify(first).slice(0, 200));

      const second = await reconcile.reconcile({ dryRun: false }, deps);
      if (second.filed === 0 && second.alreadyOpen >= 1) {
        ok('a second scan files NOTHING NEW — one incident per claim, not one per scan');
      } else bad('repeated scans multiply incidents', JSON.stringify(second).slice(0, 200));

      const exs = (await q(`SELECT COUNT(*)::int n FROM office_exceptions
                              WHERE source='office/reconcile'`)).rows[0].n;
      if (exs === first.filed) ok(`exactly ${exs} reconciliation exception(s) exist in total`);
      else bad(`${exs} exceptions exist but ${first.filed} were reported filed`);

      // It must not have touched the claim at all.
      const c = (await q(`SELECT status, sent_at, provider_accepted_at FROM supplier_outreach_log
                            WHERE approval_id=$1`, [unknownCase.apId])).rows[0];
      if (c.status === 'pending' && !c.sent_at && !c.provider_accepted_at) {
        ok('and it changed nothing: no resend, no status change, no manufactured acknowledgement');
      } else bad('the reconciler altered the claim', JSON.stringify(c));
    }

    // ══ §16: THE POLICY IS DURABLE ═════════════════════════════════════════
    {
      const e = await prepare({ releaseMode: 'explicit' });
      mailerSpy = accepts();
      // An autonomous caller — one that did NOT come through the human release path.
      const r = await exec(mailerSpy)(e.apId, { requireExplicitRelease: false });
      if (!r.ok && r.refusal === 'explicit_release_required') {
        ok("release_mode='explicit' refuses an autonomous caller by STORED POLICY");
      } else bad('an autonomous caller released under explicit policy', JSON.stringify(r).slice(0, 200));
      if (mailerSpy.calls.length === 0 && await claims(e.apId) === 0) ok('  no claim, no mailer');
      else bad('  the autonomous refusal still consumed something');

      // And on_approval permits it — so the refusal above is the policy, not an accident.
      await q(`UPDATE objectives SET release_mode='on_approval' WHERE id=$1`, [e.OID]);
      mailerSpy = accepts();
      const r2 = await exec(mailerSpy)(e.apId, { requireExplicitRelease: false });
      if (r2.ok && r2.sent === true) ok("  and release_mode='on_approval' permits it — the policy is what decides");
      else bad('  on_approval did not permit an autonomous release', JSON.stringify(r2).slice(0, 200));
    }

    // ══ IDEMPOTENCY INDEX ABSENT → REFUSE ═════════════════════════════════
    {
      const g = await prepare();
      const INDEX = require('../src/lib/idempotency/supplier-rfq').INDEX_NAME;
      await q(`DROP INDEX IF EXISTS ${INDEX}`);
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(g.apId);
      if (!r.ok && r.refusal === 'idempotency_not_enforced') {
        ok('without the UNIQUE index the executor REFUSES — no invariant, no consequential action');
      } else bad('it sent with duplicate protection absent', JSON.stringify(r).slice(0, 200));
      if (mailerSpy.calls.length === 0) ok('  the mailer was never called');
      else bad('  it reached the mailer with no duplicate protection');
      await require('../src/lib/idempotency/supplier-rfq').migrate(q);
    }

    // ══ ACTION_ATTEMPTED CANNOT PERSIST → DO NOT SEND (ruling §10) ═════════
    {
      const h = await prepare();
      mailerSpy = accepts();
      const brokenLedger = {
        actionAttempted: async () => { throw new Error('fixture: event store unavailable'); },
        actionSucceeded: async () => ({ ok: true }), actionFailed: async () => ({ ok: true }),
      };
      freshOffice();
      const m = require('../src/lib/office/execute');
      const r = await m.executeApprovedAction(h.apId, { releasedBy: 'naren' },
        { query: q, mailer: mailerSpy, ledger: brokenLedger });
      if (!r.ok && r.refusal === 'attempt_evidence_not_persisted') {
        ok('if ACTION_ATTEMPTED cannot be persisted, NOTHING IS SENT');
      } else bad('it sent without durable attempt evidence', JSON.stringify(r).slice(0, 200));
      if (mailerSpy.calls.length === 0) ok('  the mailer was never called');
      else bad('  the mailer was called with no attempt evidence');
      const c = (await q(`SELECT status, error FROM supplier_outreach_log WHERE approval_id=$1`, [h.apId])).rows[0];
      if (c && c.status === 'pending') ok('  and the claim is kept as an unresolved attempt identity');
      else bad('  the claim was not kept', c && c.status);
    }

    // ══ THE SENDER IS PART OF THE APPROVED COMMUNICATION (sender ruling §12) ══
    //
    // R1 called the mailer with NO `from`, so the sender fell through to mailer.defaultFrom() —
    // `MAIL_FROM || 'PlayNexa <no-reply@adificetechnologies.com>'` — and MAIL_FROM is unset in
    // production. The first governed supplier RFQ would have left from another company's domain
    // over a signature reading Abiozen LLC. No human approved that sender and none could have: it
    // was not in the payload they read.
    //
    // EVERY CASE HERE ASSERTS no claim AND no mailer call, because a sender defect is knowable
    // from the payload alone. A refusal after the claim consumes the supplier permanently —
    // markFailed leaves the row and the unique index has no exclusion for it — which is exactly
    // how a copy-list defect cost Aurobindo and a departed signatory cost MSN.
    note('the sender is frozen, is the signatory, and no deployment default can supply it');

    {
      // 1. A RECORDED VALID SENDER → ELIGIBLE, and the mailer receives THAT value.
      const { apId } = await prepare({ rfqId: 'rfq-sender-ok', supplierId: 'sup-sender-ok' });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      if (r.ok && r.sent) ok('a recorded valid sender RELEASES');
      else bad('a valid sender did not release', JSON.stringify(r));
      const call = mailerSpy.calls[0];
      if (call && call.from === 'Fixture Director <dir@fixture.invalid>') {
        ok('and the mailer is given the FROZEN sender, explicitly');
      } else bad('the mailer did not receive the frozen sender', JSON.stringify(call && call.from));
      // THE FALLBACK MUST BE UNREACHABLE: `from` is never undefined on this path, so
      // mailer.defaultFrom() cannot supply the identity of a governed action.
      if (call && call.from !== undefined && call.from !== null && call.from !== '') {
        ok('`from` is never absent at the mailer boundary — defaultFrom() is unreachable from R1');
      } else bad('R1 reached the mailer with no sender, so the legacy default would supply it');
    }

    {
      // 2. MISSING SENDER → sender_not_recorded. This is the state of every approval prepared
      //    before the sender became part of the payload, including the approved Hetero one.
      const { apId } = await prepare({ recordSender: false,
        rfqId: 'rfq-nosender', supplierId: 'sup-nosender' });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      if (r.refusal === 'sender_not_recorded') ok('a payload with NO sender refuses sender_not_recorded');
      else bad('a senderless payload was not refused by name', JSON.stringify(r));
      if (r.needs_repreparation === true) ok('  and says re-preparation is required');
      else bad('  it does not say the action needs re-preparing');
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad(`  claim/mailer leaked: claims=${await claims(apId)} calls=${mailerSpy.calls.length}`);
      const ex = (await q(`SELECT id FROM office_exceptions WHERE id = $1`,
        [`ex-send-nosender-${apId}`])).rows[0];
      if (ex) ok('  and a durable exception names this approval specifically');
      else bad('  no exception was filed, or it collapsed onto a shared id');
    }

    {
      // 3. SENDER DIFFERENT FROM THE SIGNATORY → refuse. An alias on the right domain is still
      //    the wrong identity: a reply must reach the person who signed.
      const { apId } = await prepare({ senderEmail: 'procurement@fixture.invalid',
        senderName: 'Procurement', rfqId: 'rfq-notsig', supplierId: 'sup-notsig' });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      if (r.refusal === 'sender_is_not_the_signatory') {
        ok('a sender that is not the signatory refuses, even on the SAME authorized domain');
      } else bad('an alias sender was not refused', JSON.stringify(r));
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad(`  claim/mailer leaked: claims=${await claims(apId)} calls=${mailerSpy.calls.length}`);
    }

    {
      // 4. SENDER OUTSIDE THE COMPANY BOUNDARY → refuse. THE PRODUCTION CASE: the sender R1 would
      //    have used was `no-reply@adificetechnologies.com` on an Abiozen letter.
      const { apId } = await prepare({ senderEmail: 'no-reply@adificetechnologies.invalid',
        senderName: 'PlayNexa', rfqId: 'rfq-otherdomain', supplierId: 'sup-otherdomain' });
      mailerSpy = accepts();
      const r = await exec(mailerSpy)(apId);
      if (r.refusal === 'sender_is_not_the_signatory'
          || r.refusal === 'sender_outside_company_boundary') {
        ok(`a sender at ANOTHER COMPANY'S DOMAIN refuses (${r.refusal}) — the production default `
          + 'would have been exactly this');
      } else bad('an out-of-domain sender was not refused', JSON.stringify(r));
      if (mailerSpy.calls.length === 0 && await claims(apId) === 0) ok('  no claim, no mailer call');
      else bad(`  claim/mailer leaked: claims=${await claims(apId)} calls=${mailerSpy.calls.length}`);
    }

    {
      // 5. CHANGING MAIL_FROM CANNOT CHANGE THE GOVERNED SENDER. Not an argument about the code —
      //    the variable is actually set to something conspicuous and the spy is asked what arrived.
      const saved = process.env.MAIL_FROM;
      process.env.MAIL_FROM = 'Hijack <attacker@elsewhere.invalid>';
      try {
        const { apId } = await prepare({ rfqId: 'rfq-envproof', supplierId: 'sup-envproof' });
        mailerSpy = accepts();
        const r = await exec(mailerSpy)(apId);
        const call = mailerSpy.calls[0];
        if (r.ok && call && call.from === 'Fixture Director <dir@fixture.invalid>') {
          ok('setting MAIL_FROM does NOT change the governed sender — the payload wins because it '
            + 'is the APPROVED sender');
        } else if (call && /attacker/.test(String(call.from))) {
          bad('MAIL_FROM OVERRODE THE APPROVED SENDER — deployment configuration is deciding the '
            + 'external identity of an approved communication', String(call.from));
        } else bad('the env case did not measure the sender', JSON.stringify({ r, from: call && call.from }));
      } finally {
        if (saved === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = saved;
      }
    }

    {
      // 6. TWO APPROVED ATTEMPTS FOR ONE PAIR → ONE SEND. The intent/attempt separation lets a
      //    REJECTED preparation be replaced, and this is the proof it did not also open a second
      //    external send: the claim's unique index is what stops it, not the approval id.
      const a = await prepare({ rfqId: 'rfq-two-attempts', supplierId: 'sup-two-attempts' });
      const b = await prepare({ rfqId: 'rfq-two-attempts', supplierId: 'sup-two-attempts' });
      if (a.apId !== b.apId) ok('two preparation attempts for one pair get DIFFERENT approval ids');
      else bad('the two attempts share an approval id');
      mailerSpy = accepts();
      const r1 = await exec(mailerSpy)(a.apId);
      const spy2 = accepts();
      const r2 = await exec(spy2)(b.apId);
      if (r1.ok && r1.sent) ok('the first attempt sends');
      else bad('the first attempt did not send', JSON.stringify(r1));
      if (!r2.ok && spy2.calls.length === 0) {
        ok(`the second approved attempt for the SAME pair is refused (${r2.refusal}) and the `
          + 'mailer is never called — relaxing the approval identity did NOT relax the send');
      } else bad('a second approved attempt for the same pair reached the mailer', JSON.stringify(r2));
    }

    // ══ MUTATION CONTROLS ══════════════════════════════════════════════════
    note('mutation controls: disable each mechanism, prove the defect returns');
    const before = sha(EXF);
    const src = fs.readFileSync(EXF, 'utf8');

    // M8 — remove the supplier claim. The same (rfq, supplier) becomes sendable twice.
    {
      const anchor = '  if (!claimId) {';
      if (!src.includes(anchor)) bad('M8 could not locate the claim-conflict branch — stale');
      else {
        fs.writeFileSync(EXF, src.replace(anchor, '  if (false) {'));
        try {
          // The same pair the happy path already claimed, set at creation — the payload is
          // immutable and rightly refuses being repointed afterwards.
          const a = await prepare({ rfqId: 'rfq-shared', supplierId: 'sup-shared' });
          mailerSpy = accepts();
          const r = await exec(mailerSpy)(a.apId);
          if (mailerSpy.calls.length === 1 && r.sent === true) {
            ok('M8 without the claim conflict check, a supplier is emailed TWICE about one RFQ — the claim is load-bearing');
          } else bad('M8 the duplicate did not get through, so the check was not measured',
            JSON.stringify({ calls: mailerSpy.calls.length, r: r.refusal }));
        } finally { fs.writeFileSync(EXF, src); freshOffice(); }
      }
      if (sha(EXF) !== before) bad('M8 execute.js was NOT restored'); else ok('M8 execute.js restored, verified by hash');
    }

    // M9 — remove the kill-switch consultation. A stopped office reaches the mailer.
    {
      const anchor = '    if (blocked) {';
      if (!src.includes(anchor)) bad('M9 could not locate the kill-switch branch — stale');
      else {
        fs.writeFileSync(EXF, src.replace(anchor, '    if (false) {'));
        try {
          const a = await prepare();
          const autonomy = require('../src/lib/autonomy');
          await autonomy.stop({ scope_type: 'capability', scope_key: 'email.send',
            reason: 'M9 control: prove the kill consultation is load-bearing', actor: 'test' });
          mailerSpy = accepts();
          const r = await exec(mailerSpy)(a.apId);
          // The mailer stub bypasses mailer.js's own internal stop check, which is the point: this
          // measures the EXECUTOR's consultation, not the mailer's.
          if (mailerSpy.calls.length === 1) {
            ok('M9 without the executor\'s kill consultation, a STOPPED office reaches the mailer — it is load-bearing');
          } else bad('M9 the stopped office still did not reach the mailer, so nothing was measured',
            JSON.stringify({ calls: mailerSpy.calls.length, refusal: r.refusal }));
          await autonomy.resume({ scope_type: 'capability', scope_key: 'email.send',
            reason: 'M9 control complete — releasing the halt', actor: 'test' });
        } finally { fs.writeFileSync(EXF, src); freshOffice(); }
      }
      if (sha(EXF) !== before) bad('M9 execute.js was NOT restored'); else ok('M9 execute.js restored, verified by hash');
    }

    // M11 — remove the ACTION_ATTEMPTED gate. Sending without durable attempt evidence.
    {
      const anchor = "    return { ...report, ok: false, refusal: 'attempt_evidence_not_persisted', detail: e.message,";
      if (!src.includes(anchor)) bad('M11 could not locate the attempt-evidence gate — stale');
      else {
        fs.writeFileSync(EXF, src.replace(anchor, "    report.attemptEvidenceSkipped = true; if (false) return { ...report, ok: false, refusal: 'attempt_evidence_not_persisted', detail: e.message,"));
        try {
          const a = await prepare();
          mailerSpy = accepts();
          const brokenLedger = {
            actionAttempted: async () => { throw new Error('fixture: event store unavailable'); },
            actionSucceeded: async () => ({ ok: true }), actionFailed: async () => ({ ok: true }),
          };
          freshOffice();
          const m = require('../src/lib/office/execute');
          await m.executeApprovedAction(a.apId, { releasedBy: 'naren' },
            { query: q, mailer: mailerSpy, ledger: brokenLedger });
          if (mailerSpy.calls.length === 1) {
            ok('M11 without the gate, an external send happens with NO durable attempt evidence — the gate is load-bearing');
          } else bad('M11 nothing was sent, so the gate was not measured', `calls=${mailerSpy.calls.length}`);
        } finally { fs.writeFileSync(EXF, src); freshOffice(); }
      }
      if (sha(EXF) !== before) bad('M11 execute.js was NOT restored'); else ok('M11 execute.js restored, verified by hash');
    }

    // M12 — remove the frozen-sender requirement. The mailer must then be reached with NO `from`,
    // which is the exact production state: mailer.defaultFrom() supplies the identity of a
    // governed external action, and MAIL_FROM is unset so it resolves to another company's domain.
    {
      let before = sha(EXF); const src = fs.readFileSync(EXF, 'utf8');
      // ALL THREE SENDER GATES ARE DISABLED TOGETHER, and that is a finding rather than a
      // convenience. Disabling only the first left the SECOND one refusing — frozenSenderEmail is
      // null, so `sameAsSignatory` is falsy and the release still stopped. That is defence in
      // depth working, and it also means a single-predicate mutation measures nothing here. So the
      // control removes the sender verification AS A WHOLE, which is the requirement being tested:
      // without it, does the external identity come from deployment configuration?
      const anchors = [
        '  if (!frozenSender || !frozenSenderEmail) {',
        '  if (!sameAsSignatory) {',
        '  if (!senderDomain || senderDomain !== signatoryDomain) {',
      ];
      const missing = anchors.filter((a) => !src.includes(a));
      if (missing.length) bad('M12 could not locate every sender gate — the control is stale', missing.join('\n'));
      else {
        let mutated = src;
        for (const a of anchors) mutated = mutated.replace(a, '  if (false) {');
        fs.writeFileSync(EXF, mutated);
        try {
          const { apId } = await prepare({ recordSender: false,
            rfqId: 'rfq-m12-sender', supplierId: 'sup-m12-sender' });
          mailerSpy = accepts();
          const r = await exec(mailerSpy)(apId);
          const call = mailerSpy.calls[0];
          if (r.ok && call && (call.from === undefined || call.from === null)) {
            ok('M12 without the gate, a senderless payload reaches the mailer with NO `from` — the '
              + 'legacy MAIL_FROM default would supply the external identity. The gate is load-bearing');
          } else if (!r.ok) {
            bad('M12 the release still refused with the gate removed, so the gate was not what '
              + 'blocks a senderless payload', r.refusal);
          } else bad('M12 the mutation did not measure the sender', JSON.stringify(call && call.from));
        } finally {
          fs.writeFileSync(EXF, src);
          freshOffice();
        }
      }
      if (sha(EXF) !== before) bad('M12 execute.js was NOT restored'); else ok('M12 execute.js restored, verified by hash');
    }

    note('M10 (claim after send) is not mutated: moving the claim below the mailer is a structural');
    note('rewrite rather than a predicate removal. The ORDER is asserted on the source instead.');
    {
      const iClaim = src.indexOf('rfqClaim.claim(');
      const iAttempt = src.indexOf('ledger.actionAttempted(');
      const iSend = src.indexOf('mailer.sendEmailDetailed(');
      if (iClaim !== -1 && iAttempt !== -1 && iSend !== -1 && iClaim < iAttempt && iAttempt < iSend) {
        ok('the source order is claim → ACTION_ATTEMPTED → send, and nothing else between');
      } else bad('the claim/attempt/send ordering is wrong in the source',
        `claim@${iClaim} attempt@${iAttempt} send@${iSend}`);
    }

    console.log('\n' + (fail ? `FAIL  ${fail} R1 assertion(s) failed` :
      'PASS  R1 holds: every internal gate refuses before an external identity is consumed, the '
      + 'claim precedes the send, an ambiguous failure stays a known unknown, nothing retries, and '
      + 'a send never becomes a business outcome.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  R1 harness error:', e.stack || e.message);
    process.exit(1);
  } finally {
    stopCluster();
  }
})();
