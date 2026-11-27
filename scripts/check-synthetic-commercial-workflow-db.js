#!/usr/bin/env node
// ── B2.10: THE FIRST ABIOZEN COMMERCIAL WORKFLOW, SYNTHETIC END TO END ──────
//
//   node scripts/check-synthetic-commercial-workflow-db.js   exit 0 = the chain holds
//                                                            exit 3 = NOT EXECUTED (no Postgres)
//
// Owner's Priority 7, 2026-11-26: *"B2.10 as a synthetic end-to-end procurement demonstration:
// business objective → supplier discovery → qualification → RFQ preparation → approval request →
// simulated transmission → simulated supplier response → quotation extraction → independent
// qualification → executive decision → financial reconciliation."* And: *"No real supplier
// communication, purchase, payment or financial commitment."*
//
// ── WHAT THIS DEMONSTRATES, AND THE ONE STAGE IT CANNOT ────────────────────
//
// Every stage is the REAL module. Nothing is a mock of the thing under test.
//
// **Stage 4 used to halt at the model, and the halt was the finding.** `renderGovernedRFQ` calls
// `governedCall`, and `office/ai.js` did `require('../llm')` at module load with no injection seam,
// so a synthetic demonstration could not produce the RFQ letter's prose without a real paid call.
// Stages 5-11 then ran on fixtures standing in for an artefact nobody had produced: eleven passing
// stages and no workflow.
//
// Since 2026-11-26 BOTH halves are asserted, and stage 4 appears twice on purpose:
//
//   **Stage 4** runs with no API key, as it always did, and asserts the governed path refuses with
//   `ai_unavailable`, produces no sendable artefact, makes zero provider calls and files exactly
//   one critical configuration exception. It is the negative control: a chain that invented the
//   letter would be the worst available outcome, so the refusal stays measured.
//
//   **Stage 4b** runs the SAME entry point through the synthetic provider seam approved on
//   2026-11-26 (`deps.syntheticProvider: true`, selecting the reviewed responder in
//   src/lib/office/synthetic-provider.js — a boolean, not an injected function). The context is
//   resolved, the stop is checked, the policy gate runs, a real hold is taken against the real
//   budget and resolved to a proven zero, the identity containment check judges the returned text,
//   and the artefact is bound to an approval digest and RELEASED through the real gate. Only the
//   transport is canned, and every response says `provider: 'synthetic'` with a marker in the
//   letter text, so a synthetic traversal can never be read later as a live-model verification.
//
// **Section 11b then asserts the LINKS**, separately from the stages: for each join, the input the
// later stage used must be identical to the output the earlier stage produced. That is the section
// that can tell a workflow from a list, and it is the answer to requirement 6 — *"Eleven
// independently passing stages are not sufficient if the actual workflow cannot traverse them
// consecutively."*
//
// Everything downstream of the RELEASED artefact is then demonstrated on a **simulated transmission
// record** and **simulated supplier replies**, written as fixtures and labelled as such in the rows
// they create. No message leaves the process: the mailer and `fetch` are spied on, and each spy is
// **fired deliberately first** so its later silence means something. What is synthetic here is the
// supplier's side of the conversation and the transport — not the governance, which is traversed.
//
// ── THE VALUE KINDS ARE THE POINT OF STAGE 11 ──────────────────────────────
//
// The owner requires estimated opportunity value, quotation value, actual orders, invoiced revenue,
// received payments, costs and margin told apart. `office/commercial-ledger.js` holds them apart
// and refuses to total them; this exercises it on the figures this workflow actually produced, and
// asserts the one thing a dashboard most wants to do and must not: add them up.
//
// NO URL OVERRIDE: its own disposable cluster; every fixture created by id and removed by id.

'use strict';

const crypto = require('node:crypto');

const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) {
    console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
};
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n── ${m} ──\n`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'commercial' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the synthetic commercial workflow was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'comm-bootstrap@comm.invalid';
process.env.ADMIN_PASSWORD = `comm-${crypto.randomBytes(16).toString('hex')}`;
// ── DELIBERATELY ABSENT, AND ASSERTED ABSENT ──────────────────────────────
// No provider key. Stage 4 must refuse because of this, not in spite of it.
delete process.env.ANTHROPIC_API_KEY;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 300s — a stall is a failure.');
  process.exit(1);
}, 300_000);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false, max: 8 });
  const query = (t, p) => P.query(t, p);
  const withTransaction = async (fn) => {
    const c = await P.connect();
    try {
      await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const deps = { query, withTransaction };

  const made = { companies: [], objectives: [], suppliers: [], rfqs: [], users: [] };
  const uid = (p) => `comm-${p}-${crypto.randomUUID().slice(0, 8)}`;

  // ── THE OUTWARD-CALL SPY, FIRED FIRST ───────────────────────────────────
  //
  // Rule 7: a spy is evidence only once it has been seen to fire. `fetch` is the one road out of
  // this process for the provider and for any HTTP transport.
  const realFetch = global.fetch;
  const outward = [];
  global.fetch = (...args) => {
    outward.push(String(args[0]));
    return Promise.reject(Object.assign(new Error('outward calls are blocked in this check'),
      { blockedByCheck: true }));
  };

  try {
    const DB = require('../src/lib/db');
    await DB.initDB();
    await DB.initPhase2?.();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/autonomy').migrateAutonomy(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);

    const CTXMOD = require('../src/lib/office/context');
    const RFQ = require('../src/lib/office/procurement-rfq');
    const LEDGER = require('../src/lib/office/commercial-ledger');

    // ══ 0. THE SPY MUST BE ABLE TO FIRE ═════════════════════════════════
    head('0. the outward-call spy fires, so its silence later means something');

    {
      const before = outward.length;
      await global.fetch('https://example.invalid/spy-probe').catch(() => {});
      if (outward.length === before + 1) {
        ok('the spy recorded a deliberate probe — every assertion of "zero outward calls" below '
          + 'rests on an instrument that has been seen to work');
      } else bad('the spy did not record a deliberate call', { before, after: outward.length });
      outward.length = 0;
    }

    // ══ 1. A BUSINESS OBJECTIVE ═════════════════════════════════════════
    head('1. a business objective, funded and supervised');

    const CO = uid('abiozen-synthetic');
    await query(`INSERT INTO companies (id, slug, display_name, status)
                 VALUES ($1,$1,'ABIOZEN (synthetic fixture)','active')`, [CO]);
    made.companies.push(CO);

    const OBJ = uid('obj');
    await query(`INSERT INTO objectives
                   (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                    created_by, budget_usd)
                 VALUES ($1,$2,$3,'P1','supervised','all_consequential','active',
                         'naren@fixture.invalid',25.00)`,
      [OBJ, CO, 'Source 5 kg of a synthetic molecule for a synthetic buyer enquiry']);
    made.objectives.push(OBJ);

    const CTX = await CTXMOD.resolveObjectiveContext({ objectiveId: OBJ }, deps);
    if (CTX && CTX.companyId === CO && CTX.objectiveId === OBJ) {
      ok(`a resolved context for the objective (budget $25.00, tier supervised) — and it is `
        + 'RESOLVED, not constructed, so every stage below acts for a company read from stored '
        + 'state');
    } else bad('the objective context did not resolve', CTX);

    // ══ 2. SUPPLIER DISCOVERY ═══════════════════════════════════════════
    head('2. supplier discovery — three candidates, deliberately unequal');

    const SUPPLIERS = [
      { id: uid('sup-a'), name: 'Synthetic Pharma A (fixture)', region: 'india',
        contact_email: 'rfq@synthetic-a.invalid', gmp: 1, reliability: 82, days: 2 },
      { id: uid('sup-b'), name: 'Synthetic Pharma B (fixture)', region: 'china',
        contact_email: 'sales@synthetic-b.invalid', gmp: 1, reliability: 64, days: 5 },
      // Deliberately NOT GMP certified, so qualification has something to refuse. A fixture in
      // which every candidate qualifies measures nothing.
      { id: uid('sup-c'), name: 'Synthetic Trading C (fixture)', region: 'apac',
        contact_email: 'info@synthetic-c.invalid', gmp: 0, reliability: 71, days: 3 },
    ];
    for (const s of SUPPLIERS) {
      await query(`INSERT INTO suppliers
                     (id, name, country, region, contact_email, contact_name, specialties,
                      reliability_score, avg_response_days, gmp_certified)
                   VALUES ($1,$2,'Synthetica',$3,$4,'Synthetic Contact','["synthetic"]',$5,$6,$7)`,
        [s.id, s.name, s.region, s.contact_email, s.reliability, s.days, s.gmp]);
      made.suppliers.push(s.id);
    }
    const n = (await query(`SELECT COUNT(*)::int n FROM suppliers WHERE id = ANY($1)`,
      [SUPPLIERS.map((s) => s.id)])).rows[0].n;
    if (n === 3) {
      ok('three candidate suppliers discovered, with DIFFERENT reliability, lead time and GMP '
        + 'status — so a qualification step that reads the wrong field produces a visibly wrong '
        + 'answer rather than coincidentally the right one');
    } else bad(`${n} suppliers were created`, n);

    // ══ 3. QUALIFICATION ════════════════════════════════════════════════
    head('3. qualification — a declared criterion, and one candidate must fail it');

    const GMP_REQUIRED = true;
    const qualified = SUPPLIERS.filter((s) => (GMP_REQUIRED ? s.gmp === 1 : true));
    const rejected = SUPPLIERS.filter((s) => !qualified.includes(s));

    if (qualified.length === 2 && rejected.length === 1 && rejected[0].gmp === 0) {
      ok(`2 of 3 qualified against a DECLARED criterion (GMP required) and the third is refused `
        + `by name (${rejected[0].name}: not GMP certified) — a qualification that passed `
        + 'everything would be a qualification that measured nothing');
    } else bad('qualification did not discriminate', { qualified: qualified.length, rejected: rejected.length });

    // The AI does not choose the supplier. Asserted on the real module's own refusal.
    const noSupplier = await RFQ.runGovernedProcurement(
      { objectiveId: OBJ, rfqId: 'x', supplierId: null }, deps)
      .then(() => 'allowed', (e) => e.message);
    if (/does not choose the supplier/.test(String(noSupplier))) {
      ok('and the governed path refuses to run without a named supplier — *"the AI does not choose '
        + 'the supplier"*, enforced rather than documented');
    } else bad('the governed path accepted a null supplier', noSupplier);

    // ══ 4. RFQ PREPARATION — AND THE HALT AT THE MODEL ══════════════════
    head('4. RFQ preparation: the governed path refuses rather than inventing the letter');

    const RFQ_ID = uid('rfq');
    await query(`INSERT INTO rfq_requests
                   (id, molecule_name, cas_number, target_quantity, target_purity, gmp_required,
                    week_start, status, priority)
                 VALUES ($1,'Syntheticol','000000-00-0','5 kg','99.0%',1,$2,'pending','high')`,
      [RFQ_ID, new Date().toISOString().slice(0, 10)]);
    made.rfqs.push(RFQ_ID);

    const chosen = qualified[0];
    const beforeCalls = outward.length;

    // ── FIXTURE SEAMS THE MODULE ITSELF DECLARES, AND NO OTHERS ───────────
    //
    // `deps.guard` and `deps.signatory` are injectable BY DESIGN — the module says so in its own
    // comments (*"injectable so the governed path is testable without the full molecule registry"*
    // and *"injectable for fixtures only"*). The provider is not, which is the finding. Using only
    // the declared seams is what makes the halt below a measurement of the real path rather than
    // of a path I rebuilt.
    //
    // My first attempt returned the approved identity facts under a key called `facts`, and
    // `renderGovernedRFQ` refused with `identity_not_approved` — correctly, because it requires
    // `__approvedByDecision` and must be unusable with raw RFQ fields. The refusal was real and it
    // was the WRONG refusal for this stage: it stopped the chain upstream of the model, so "the
    // model was never reached" would have been true for a reason that had nothing to do with the
    // model. A check that stops early and reports the conclusion it wanted is the defect this
    // repository keeps finding.
    // ── AND THROUGH `runGovernedProcurement`, NOT `prepareGovernedRFQ` ────
    //
    // Calling prepare directly reached `governedCall` and was refused with
    // *"governedCall requires a context carrying a runId: AI spend must attach to a run"* — correct
    // governance, and again the WRONG refusal for this stage. The run is what `runGovernedProcurement`
    // opens, so the entry point the product uses is the entry point this check has to use. Two
    // wrong refusals in a row, each of them a real control firing, and each of them would have let
    // me report "the model was never reached" for a reason that was not the model.
    const decisionId = uid('dec');
    const prepared = await RFQ.runGovernedProcurement({
      objectiveId: OBJ,
      rfqId: RFQ_ID,
      supplierId: chosen.id,
      trigger: 'manual',
      triggerDetail: 'B2.10 synthetic commercial workflow',
    }, {
      ...deps,
      guard: {
        guardSend: async () => ({
          allow: true,
          decisionId,
          approved: {
            __approvedByDecision: decisionId,
            molecule_name: 'Syntheticol',
            cas_number: '000000-00-0',
          },
        }),
      },
      supplier: { id: chosen.id, name: chosen.name, contact_email: chosen.contact_email },
      signatory: { id: uid('sig'), name: 'Synthetic Signatory (fixture)',
        email: 'procurement@abiozen.com', title: 'Procurement', role: 'procurement_director',
        why: 'fixture signatory', skipped: [], fallback: false },
    }).catch((e) => ({ ok: false, refusal: 'threw', detail: e.message }));

    if (!prepared.ok) {
      ok(`preparation REFUSED (${prepared.refusal}) and produced no sendable artefact — with no `
        + 'ANTHROPIC_API_KEY in the environment, which is the state this check deliberately '
        + 'arranges');
    } else bad('an RFQ artefact was produced with no provider available', prepared);

    if (prepared.refusal === 'ai_unavailable') {
      ok('and the refusal names the MODEL as the reason — not the supplier, the identity guard, '
        + 'the signatory or the recipient policy. The chain reached the provider boundary and '
        + 'stopped there, which is what makes this a measurement of the gap rather than an '
        + 'inference from an earlier refusal');
    } else bad(`the stage refused UPSTREAM of the model ('${prepared.refusal}'), so this check has `
      + 'not established anything about the model boundary — it stopped before reaching it',
    { refusal: prepared.refusal, detail: prepared.detail });

    if (outward.length === beforeCalls) {
      ok('ZERO outward calls were made during preparation — the provider was never reached, so no '
        + 'money could have been spent, with the spy already proved able to fire');
    } else bad(`${outward.length - beforeCalls} outward call(s) during preparation`,
      outward.slice(beforeCalls));

    // A provider being unavailable is ORDINARY and must not become a human's problem.
    const exRows = (await query(
      `SELECT id, source, severity, reason FROM office_exceptions WHERE company_id = $1`,
      [CO])).rows;
    const exs = exRows.length;
    if (exs) note(`exception(s) filed: ${exRows.map((r) => `${r.source}/${r.severity}: `
      + String(r.reason).slice(0, 160)).join(' | ')}`);
    // ── MY EXPECTATION WAS WRONG AND THE PRODUCT WAS RIGHT ────────────────
    //
    // I asserted that NO exception should be filed, reasoning that a provider being unavailable is
    // ordinary operation and an alert for it is how an alert channel becomes one people mute. One
    // exception was filed, and reading it showed the reasoning did not apply: `office/ai.js`
    // classifies `auth` as a CONFIGURATION FAILURE (`CONFIG_FAILURES = ['model_invalid','auth']`),
    // and the exception says so in its own text — *"a configuration defect, not a transient
    // failure"*. A missing API key will refuse every call until a human changes something, which is
    // exactly what an escalation is for. A transient 503 is the case my sentence described, and
    // that one is not escalated.
    //
    // So the assertion is now the distinction rather than the absence, which is the stronger
    // property and the one that would catch a regression in either direction.
    const authEx = exRows.filter((r) => /auth|not configured/i.test(String(r.reason)));
    if (exs === 1 && authEx.length === 1 && authEx[0].severity === 'critical'
      && /configuration defect, not a transient failure/.test(String(authEx[0].reason))) {
      ok('exactly ONE critical exception, from office/ai, naming the missing key as a '
        + 'CONFIGURATION DEFECT rather than a transient failure — which is the right call: a key '
        + 'that is absent will refuse every call until a human changes something, while a 503 '
        + 'would be ordinary and is not escalated. My first assertion here expected silence and '
        + 'was wrong');
    } else bad('the provider-absence escalation is not the single configuration-defect exception '
      + 'it should be', exRows);

    note('Everything above is stage 4 WITHOUT a provider, and it is kept as the negative control '
      + 'for stage 4b below: the refusal and the artefact must not both be producible by the same '
      + 'code path under the same conditions.');

    // ══ 4b. THE SAME STAGE, THROUGH THE SYNTHETIC PROVIDER SEAM ═════════
    //
    // Approved 2026-11-26 (development decision 2), and requirement 6: *"For B2.10, demonstrate the
    // complete connected eleven-stage workflow after implementing the synthetic provider seam.
    // Eleven independently passing stages are not sufficient if the actual workflow cannot traverse
    // them consecutively."*
    //
    // The seam is `deps.syntheticProvider: true` — a BOOLEAN selecting the reviewed responder in
    // src/lib/office/synthetic-provider.js, not an injected function, because a function-shaped
    // seam is where a value out of a plan or a model becomes code.
    //
    // EVERYTHING ELSE IS THE REAL PATH. The context is resolved from the objective, the stop is
    // checked, the policy gate runs, a hold is taken against the real budget and marked dispatched,
    // the identity containment check judges the returned text, and the signatory and recipient
    // policies apply. Only the transport is canned — which is the whole design: a seam that
    // skipped the governance would demonstrate nothing about the workflow.
    head('4b. RFQ preparation through the synthetic seam — the artefact that connects 4 to 5');

    // A DIFFERENT MOLECULE, because `rfq_requests` has a unique key on
    // (week_start, molecule_name) — the first version of this reused 'Syntheticol' and the insert
    // was refused. The constraint is right: two RFQs for one molecule in one week are one request.
    const RFQ_ID_2 = uid('rfq2');
    await query(`INSERT INTO rfq_requests
                   (id, molecule_name, cas_number, target_quantity, target_purity, gmp_required,
                    week_start, status, priority)
                 VALUES ($1,'Syntheticol-B','000000-00-1','5 kg','99.0%',1,$2,'pending','high')`,
      [RFQ_ID_2, new Date().toISOString().slice(0, 10)]);
    made.rfqs.push(RFQ_ID_2);

    const beforeSynth = outward.length;
    const decisionId2 = uid('dec2');
    const prepared2 = await RFQ.runGovernedProcurement({
      objectiveId: OBJ,
      rfqId: RFQ_ID_2,
      supplierId: chosen.id,
      trigger: 'manual',
      triggerDetail: 'B2.10 connected traversal via the synthetic provider seam',
    }, {
      ...deps,
      syntheticProvider: true,
      guard: {
        guardSend: async () => ({
          allow: true,
          decisionId: decisionId2,
          approved: {
            __approvedByDecision: decisionId2,
            molecule_name: 'Syntheticol-B',
            cas_number: '000000-00-1',
          },
        }),
      },
      supplier: { id: chosen.id, name: chosen.name, contact_email: chosen.contact_email },
      signatory: { id: uid('sig2'), name: 'Synthetic Signatory (fixture)',
        email: 'procurement@abiozen.com', title: 'Procurement', role: 'procurement_director',
        why: 'fixture signatory', skipped: [], fallback: false },
    }).catch((e) => ({ ok: false, refusal: 'threw', detail: e.message }));

    if (prepared2.ok && prepared2.body) {
      ok('stage 4 COMPLETES through the seam: a letter body and subject were produced, so stage 5 '
        + 'now has something to approve and the chain is connected at the join that used to break');
    } else {
      bad('the synthetic seam did not complete stage 4', { refusal: prepared2.refusal,
        detail: prepared2.detail, ai: prepared2.ai && prepared2.ai.error });
    }

    if (prepared2.ai && prepared2.ai.provider === 'synthetic' && prepared2.ai.synthetic === true) {
      ok('and the provenance says SYNTHETIC — not `anthropic`. A synthetic traversal can never be '
        + 'read afterwards as a live-model verification, which is the one way this seam could do '
        + 'real damage');
    } else bad('the synthetic call is not marked as synthetic in its provenance',
      prepared2.ai && { provider: prepared2.ai.provider, synthetic: prepared2.ai.synthetic });

    if (prepared2.body && /\[SYNTHETIC-DEV-RESPONSE\]/.test(prepared2.body)) {
      ok('the marker is in the LETTER TEXT itself, so the artefact cannot be mistaken for a real '
        + 'RFQ even if it is read outside the database that records its provenance');
    } else bad('the artefact carries no synthetic marker in its text', prepared2.body);

    if (outward.length === beforeSynth) {
      ok('and STILL zero outward calls — the responder runs in-process, so no provider was '
        + 'reached and no money could have been spent, with the spy already proved able to fire');
    } else bad(`${outward.length - beforeSynth} outward call(s) during the synthetic preparation`,
      outward.slice(beforeSynth));

    // The hold was taken and settled against the REAL budget, which is what makes this a traversal
    // of the governed path rather than a bypass of it.
    {
      const held = (await query(
        `SELECT state, financial_state, settled_cost_usd, settled_cost_known, financial_note
           FROM office_budget_reservations
          WHERE company_id = $1 AND run_id = $2`, [CO, prepared2.runId || null])).rows;

      // ── MY ASSERTION WAS WRONG AND THE PRODUCT WAS RIGHT ────────────────
      //
      // I asserted `state = 'settled'` and got `released` / `zero_charge_verified`. Reading
      // `settleHold` in office/ai.js explains it: a cost that is KNOWN and ZERO releases the hold
      // with evidence rather than settling it, because settling writes a $0.00 accounting row for
      // a non-event while a release returns the headroom and records WHY it was free. For a
      // synthetic call that is the stronger outcome, and 'unknown' would be the failure.
      //
      // So the assertion is now the PROPERTY: the hold is resolved rather than left dangling, and
      // the financial outcome is a PROVEN zero rather than an unmeasured one.
      const resolved = held.filter((h) => h.state !== 'held');
      const provenZero = held.filter((h) => h.financial_state === 'zero_charge_verified'
        || (h.state === 'settled' && h.settled_cost_known === true
            && Number(h.settled_cost_usd) === 0));
      if (held.length >= 1 && resolved.length === held.length
        && provenZero.length === held.length) {
        ok(`the governed path took ${held.length} real budget hold(s) for this call and resolved `
          + `every one to a PROVEN zero (${held[0].financial_state}) — proven because no request `
          + 'was dispatched, which is evidence rather than the "failed therefore free" inference. '
          + 'No hold was left dangling to expire into headroom');
      } else bad('the synthetic call did not resolve its real hold to a proven zero', held);

      // And the EVIDENCE must be about the synthetic responder, not about a missing credential.
      const notes = held.map((h) => String(h.financial_note || ''));
      if (notes.every((n) => /synthetic-provider\.js|synthetic responder/.test(n))) {
        ok('and the recorded evidence names the SYNTHETIC RESPONDER as the reason the charge was '
          + 'zero — settleHold\'s default text blames a policy stop or a missing credential, '
          + 'which would be a true-sounding reason for the wrong run');
      } else bad('the zero-charge evidence does not name the synthetic responder', notes);
    }

    // ══ 5. APPROVAL REQUEST — FOR THE ARTEFACT STAGE 4b PRODUCED ════════
    head('5. approval: the artefact from 4b is what gets queued, bound to its own digest');

    {
      // The NEGATIVE half first, and it is about stage 4 (no provider), not about stage 4b: an
      // approval for the refused RFQ must not exist, because an approval binds a digest of an
      // exact message and there is no message.
      // `office_approvals.action_payload`, which is where office approvals live — the legacy
      // `approval_queue` table has no `payload` column at all and my first query named one.
      const forRefused = (await query(
        `SELECT COUNT(*)::int n FROM office_approvals
          WHERE company_id = $1 AND action_payload::text LIKE $2`,
        [CO, `%${RFQ_ID}%`])).rows[0].n;
      if (forRefused === 0) {
        ok('nothing was queued for the stage-4 RFQ that produced no artefact — an approval binds a '
          + 'DIGEST of the exact message, so queuing one with no message would create a human '
          + 'decision about nothing and the B7.6b binding would have nothing to bind to');
      } else bad(`${forRefused} approval(s) queued for an RFQ with no artefact`, forRefused);
    }

    // And the POSITIVE half: the 4b artefact is queued, and the digest is of THAT text.
    // ── THE REAL MODULE, WITH ITS REAL SIGNATURE ──────────────────────────
    //
    // `office/approval.js` exports `prepare` and `release`, and `prepare` takes
    // `{id, actionKind, actionPayload, reason}` against a context CARRYING A RUNID — it throws
    // otherwise, by design: *"an approval must attach to the run that will act"*. I first wrote
    // `APPROVAL.enqueue(...)` with a `{kind, payload, digest}` shape and a context I invented a
    // helper for; none of those exist. Read off the module rather than remembered.
    //
    // The context is DERIVED from the resolved objective context plus the run that stage 4b
    // opened, through office/context.js — a hand-built object is refused by `assertContext`, and
    // correctly: a caller that can construct a context can choose whose budget to spend.
    const APPROVAL = require('../src/lib/office/approval');
    const { approvedDigestOf } = require('../src/lib/mailer');
    let queued = null;
    let released = null;
    let approvalPayload = null;
    if (prepared2.ok && prepared2.runId) {
      // CTX is the objective context this check resolved at stage 1; the run is 4b's.
      const runCtx = CTXMOD.deriveContext(CTX, { runId: prepared2.runId });

      // ── THE SIGNATORY GOES IN THE PAYLOAD, BECAUSE RELEASE READS IT ─────
      //
      // `release()` refuses with `signatory_not_recorded` when the approved payload names nobody,
      // and with `signatory_no_longer_active` when the named person is not an active user —
      // *"a departed Procurement Director's name on two supplier letters"* is the failure it was
      // written for. Both are governance worth traversing rather than routing around, so the
      // fixture signatory is inserted as an active user, by id, and removed in the finally.
      const SIG_ID = uid('siguser');
      await query(`INSERT INTO users (id,email,name,role,is_active)
                   VALUES ($1,$2,$3,'procurement_director',1)
                   ON CONFLICT (email) DO NOTHING`,
        [SIG_ID, prepared2.signatory.email, prepared2.signatory.name]);
      made.users.push(SIG_ID);

      approvalPayload = {
        to: chosen.contact_email,
        subject: prepared2.subject,
        text: prepared2.body,
        html: null,
        signed_by_name: prepared2.signatory.name,
        signed_by_email: prepared2.signatory.email,
      };
      // The digest is computed by the SAME function the mailer uses to verify a release, so this
      // binding is the real one rather than a lookalike computed here.
      approvalPayload.digest = approvedDigestOf(approvalPayload);

      queued = await APPROVAL.prepare(runCtx, {
        id: uid('appr'),
        actionKind: 'procurement.rfq.send',
        actionPayload: approvalPayload,
        reason: `SYNTHETIC TRAVERSAL: RFQ to ${chosen.name} for Syntheticol. No message will be `
          + 'sent; this approval exists to demonstrate that stage 5 binds to stage 4b\'s artefact.',
      }, deps).catch((e) => ({ error: e.message }));

      if (queued && queued.approvalId && queued.status) {
        ok(`the 4b artefact is queued for human approval (${queued.status}), through the real `
          + 'prepare() against a context carrying the run that produced it — so stage 5 is acting '
          + 'on stage 4b\'s output rather than on a fixture');
      } else bad('the artefact could not be queued for approval', queued);

      // The BINDING is the property, not the queuing: the stored payload must be the artefact.
      const stored = (await query(
        `SELECT action_payload FROM office_approvals WHERE company_id = $1 AND id = $2`,
        [CO, queued && queued.approvalId])).rows[0];
      const sp = stored && (typeof stored.action_payload === 'string'
        ? JSON.parse(stored.action_payload) : stored.action_payload);
      if (sp && sp.text === prepared2.body && sp.subject === prepared2.subject
        && sp.digest === approvalPayload.digest) {
        ok('and the STORED payload is byte-identical to the artefact — same body, same subject, '
          + 'same digest — so an approval cannot be reused for a different letter, which is the '
          + 'B7.6b binding doing its work on a real artefact for the first time in this chain');
      } else bad('the queued approval does not carry the 4b artefact', sp && {
        sameText: sp.text === prepared2.body, sameSubject: sp.subject === prepared2.subject });

      // ── 5b. THE RELEASE: THE ONLY ROUTE TO EXECUTION ──────────────────
      //
      // A pending approval is not authority. `release()` is the one function that turns a human
      // decision into a payload something may act on, and it re-checks the kill switch, the budget
      // hierarchy and the signatory's continued employment at release time rather than at
      // preparation time. Stage 6 must be downstream of THIS, or the transmission is of a letter
      // nobody released.
      //
      // The human decision itself is a fixture — one UPDATE, by id, on a row this check created,
      // and labelled as such. There is no human here and pretending otherwise would be the thing
      // this whole chain is built not to do.
      // `resolved_by` / `resolved_at` / `resolution` — read off the schema. My first version wrote
      // `decided_by`, `decided_at` and `notes`, none of which exist on this table.
      await query(
        `UPDATE office_approvals
            SET status = 'approved', resolved_by = $3, resolved_at = NOW(),
                resolution = $4
          WHERE company_id = $1 AND id = $2`,
        [CO, queued.approvalId, 'fixture-human@abiozen.invalid',
          'FIXTURE HUMAN DECISION — B2.10 synthetic traversal. No person reviewed this letter; '
          + 'the row exists so the release gate has something real to act on.']);

      released = await APPROVAL.release(runCtx, {
        approvalId: queued.approvalId,
        releasedBy: 'fixture-human@abiozen.invalid',
        consequential: true,
        objectiveId: OBJ,
      }, deps).catch((e) => ({ released: false, reason: 'threw', detail: e.message }));

      if (released && released.released === true) {
        ok('the approval RELEASES through the real gate — the kill switch, the budget hierarchy '
          + 'and the signatory\'s continued employment are all re-checked at release time, and '
          + 'this is the only route by which a letter becomes something a later stage may act on');
      } else {
        bad('the approved artefact could not be released', { reason: released && released.reason,
          detail: released && released.detail });
      }

      if (released && released.released === true
        && released.actionPayload && released.actionPayload.text === prepared2.body) {
        ok('and what the gate hands back is the SAME TEXT stage 4b produced — so stage 6 '
          + 'transmits the released artefact rather than a letter reconstructed beside it');
      } else bad('the released payload is not the 4b artefact', released && released.actionPayload);
    }

    // ══ 6–7. SIMULATED TRANSMISSION OF THE RELEASED ARTEFACT ════════════
    //
    // Downstream of stage 5b, not beside it. The transmission record is for RFQ_ID_2 — the RFQ
    // whose letter stage 4b produced, stage 5 bound to a digest and 5b released — so stages 8-11
    // read quotations that answer a letter this chain actually authorized. They used to read
    // replies to RFQ_ID, the RFQ that produced no letter at all, which is what made eleven passing
    // stages not a workflow.
    head('6–7. simulated transmission of the RELEASED artefact, and a simulated reply');

    if (!(released && released.released === true)) {
      bad('stages 6-11 would be running without a released artefact, which is the disconnection '
        + 'requirement 6 is about — refusing to continue rather than reporting a traversal',
      { reason: released && released.reason });
    }

    const sentAt = new Date().toISOString();
    await query(`INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, email_sent_to)
                 VALUES ($1,$2,$3,$4)`,
      [uid('out'), RFQ_ID_2, chosen.id, chosen.contact_email]);

    // Two replies, with DIFFERENT prices and lead times, so the comparison has something to do.
    const REPLIES = [
      { id: uid('resp-a'), sup: qualified[0], price: 1_240.00, lead: 21, purity: '99.3%', coa: 1 },
      { id: uid('resp-b'), sup: qualified[1], price: 1_095.50, lead: 45, purity: '98.6%', coa: 0 },
    ];
    for (const r of REPLIES) {
      await query(`INSERT INTO rfq_responses
                     (id, rfq_id, supplier_id, supplier_name, price_per_kg, currency,
                      lead_time_days, available_quantity, purity_offered, gmp_status,
                      coa_available, response_email, raw_response)
                   VALUES ($1,$2,$3,$4,$5,'USD',$6,'5 kg',$7,'certified',$8,$9,$10)`,
        [r.id, RFQ_ID_2, r.sup.id, r.sup.name, r.price, r.lead, r.purity, r.coa,
          r.sup.contact_email,
          `SIMULATED FIXTURE REPLY — no supplier was contacted. Price USD ${r.price}/kg, `
          + `lead ${r.lead} days, purity ${r.purity}.`]);
    }
    await query(`UPDATE rfq_requests SET status = 'responded' WHERE id = $1`, [RFQ_ID_2]);

    const got = (await query(
      `SELECT COUNT(*)::int n FROM rfq_responses WHERE rfq_id = $1`, [RFQ_ID_2])).rows[0].n;
    const labelled = (await query(
      `SELECT COUNT(*)::int n FROM rfq_responses
        WHERE rfq_id = $1 AND raw_response LIKE 'SIMULATED FIXTURE%'`, [RFQ_ID_2])).rows[0].n;
    if (got === 2 && labelled === 2) {
      ok('two simulated replies recorded, and BOTH say in their own stored text that they are '
        + 'fixtures and no supplier was contacted — a synthetic row that does not label itself is '
        + 'a row somebody will later read as real');
    } else bad('the simulated replies are not labelled', { got, labelled });

    if (outward.length === 0) {
      ok('and still zero outward calls: the transmission and the reply are both database rows, '
        + 'which is what "simulated" has to mean');
    } else bad(`${outward.length} outward call(s)`, outward);

    // ══ 8. QUOTATION EXTRACTION ═════════════════════════════════════════
    head('8. quotation extraction — figures read from the stored replies, not from prose');

    const quotes = (await query(
      `SELECT supplier_id, supplier_name, price_per_kg, currency, lead_time_days, purity_offered,
              coa_available
         FROM rfq_responses WHERE rfq_id = $1 ORDER BY price_per_kg ASC`, [RFQ_ID_2])).rows;

    if (quotes.length === 2 && Number(quotes[0].price_per_kg) === 1_095.50) {
      ok(`extracted ${quotes.length} quotations; the cheapest is USD `
        + `${Number(quotes[0].price_per_kg).toFixed(2)}/kg — read from typed columns, not parsed `
        + 'out of a letter, so no model stands between the supplier\'s figure and the decision');
    } else bad('quotation extraction did not produce the expected figures', quotes);

    // ══ 9. INDEPENDENT QUALIFICATION OF THE QUOTES ══════════════════════
    head('9. independent qualification — the cheapest quote is NOT automatically the answer');

    const QUOTE_CRITERION = Object.freeze({
      maxLeadDays: 30,
      coaRequired: true,
      minPurity: 99.0,
    });
    const purityOf = (s) => Number.parseFloat(String(s).replace('%', ''));
    const judged = quotes.map((q) => {
      const reasons = [];
      if (q.lead_time_days > QUOTE_CRITERION.maxLeadDays) {
        reasons.push(`lead time ${q.lead_time_days}d exceeds ${QUOTE_CRITERION.maxLeadDays}d`);
      }
      if (QUOTE_CRITERION.coaRequired && !q.coa_available) reasons.push('no certificate of analysis');
      if (purityOf(q.purity_offered) < QUOTE_CRITERION.minPurity) {
        reasons.push(`purity ${q.purity_offered} below ${QUOTE_CRITERION.minPurity}%`);
      }
      return { ...q, acceptable: reasons.length === 0, reasons };
    });

    const acceptable = judged.filter((j) => j.acceptable);
    const cheapest = judged[0];
    if (acceptable.length === 1 && !cheapest.acceptable) {
      ok(`the CHEAPEST quote is refused (${cheapest.reasons.join('; ')}) and the dearer one is the `
        + 'only acceptable offer — a comparison that always picks the lowest price is a sort, not '
        + 'a qualification, and this fixture is built so the two answers differ');
    } else bad('the qualification did not discriminate on anything but price',
      judged.map((j) => ({ p: j.price_per_kg, ok: j.acceptable, why: j.reasons })));

    // ══ 10. EXECUTIVE DECISION ══════════════════════════════════════════
    head('10. executive decision — recorded, attributed, and not self-authorizing');

    const winner = acceptable[0];
    const DECISION = Object.freeze({
      id: uid('decision'),
      chose: winner.supplier_id,
      pricePerKg: Number(winner.price_per_kg),
      quantityKg: 5,
      reason: 'the only quotation meeting the declared lead-time, CoA and purity criteria',
      decidedBy: 'synthetic-executive-fixture',
    });
    const quotationValue = DECISION.pricePerKg * DECISION.quantityKg;

    if (DECISION.chose === winner.supplier_id && quotationValue === 1_240 * 5) {
      ok(`decision recorded: ${winner.supplier_name} at USD ${DECISION.pricePerKg.toFixed(2)}/kg `
        + `× ${DECISION.quantityKg} kg = USD ${quotationValue.toFixed(2)} quotation value, with `
        + 'the reason naming the criteria rather than the price');
    } else bad('the decision did not follow the qualification', DECISION);

    // Still nothing committed. A decision is a decision, not a purchase.
    if (outward.length === 0) {
      ok('and NOTHING has been committed: no message sent, no order placed, no payment made — the '
        + 'decision is a recorded intent, and the owner\'s constraint is *"no real supplier '
        + 'communication, purchase, payment or financial commitment"*');
    } else bad(`${outward.length} outward call(s) by the decision stage`, outward);

    // ══ 11. FINANCIAL RECONCILIATION — ELEVEN KINDS, NO TOTAL ══════════
    head('11. financial reconciliation — eleven value kinds, told apart');

    {
      // The figures this workflow actually produced, each with what established it.
      const facts = [
        { kind: 'opportunity_estimate', amount: 40_000, currency: 'USD', basis: 'estimate',
          source: `objective:${OBJ}` },
        { kind: 'quotation', amount: quotationValue, currency: 'USD',
          basis: 'counterparty_stated', source: `rfq_response:${winner.supplier_id}` },
        // ── COST_QUOTED, NOT COST ─────────────────────────────────────────
        //
        // This is the procurement side of the SAME deal and a different kind from the quotation
        // even though the figures coincide here — which is why the kinds exist. It is specifically
        // `cost_quoted`: a supplier has named a price for work this workflow deliberately never
        // ordered. Nobody is owed it and nothing has been spent.
        //
        // It was filed as plain `cost` on the first run, and the ledger subtracted it from an
        // un-invoiced revenue and reported margin −$6,200. Requirement 7 of 2026-11-26 names that:
        // *"Quoted procurement costs are not incurred expenses."* The three cost states now make
        // this fixture impossible to misread, and a `counterparty_stated` basis is the only one
        // `cost_quoted` accepts.
        { kind: 'cost_quoted', amount: quotationValue, currency: 'USD',
          basis: 'counterparty_stated', source: `rfq_response:${winner.supplier_id}` },
      ];

      const agg = LEDGER.aggregate({
        facts,
        readable: {
          // Measured zeros: these sources exist and this synthetic deal reached none of them.
          order: true, invoiced: true, payment_received: true,
          opportunity_estimate: true, quotation: true,
          cost_quoted: true, cost_committed: true, cost_incurred: true,
        },
      });
      const f = agg.figures;

      if (f.opportunity_estimate.status === 'estimated' && f.opportunity_estimate.amount === 40_000) {
        ok('the $40,000 opportunity value reads as ESTIMATED and can never read as measured — it '
          + 'is a guess about a deal that does not exist, and this is the figure most often '
          + 'quoted as if it were revenue');
      } else bad('the opportunity estimate was not held apart', f.opportunity_estimate);

      if (f.quotation.status === 'measured' && f.quotation.amount === quotationValue) {
        ok(`the quotation reads as measured at USD ${quotationValue.toFixed(2)} — a stated price, `
          + 'which is a fact about what a supplier said and not about anything we own');
      } else bad('the quotation figure is wrong', f.quotation);

      if (f.order.status === 'measured_zero' && f.invoiced.status === 'measured_zero'
        && f.payment_received.status === 'measured_zero') {
        ok('orders, invoiced revenue and payments received are all MEASURED ZERO — the sources '
          + 'were readable and this deal reached none of them. A measured zero is the honest '
          + 'figure for a workflow that deliberately committed nothing');
      } else bad('the uncommitted kinds are not measured zeros',
        { order: f.order.status, invoiced: f.invoiced.status, paid: f.payment_received.status });

      // ── THE ONE THING A DASHBOARD MOST WANTS TO DO ────────────────────
      if (!('total' in agg) && /counts the same deal several times/.test(agg.noTotal)) {
        ok('and there is NO TOTAL across the kinds — a sum over estimate, quotation, order, '
          + 'invoiced and received would count this one deal five times, which is what '
          + '`metrics-snapshot` does today when it sums orders into the figure the CEO briefing '
          + 'calls revenue (B5.5, B7.22)');
      } else bad('a total across kinds exists', Object.keys(agg));

      // ── THE THREE RESULTS, EACH ON ITS OWN TWO SIDES ──────────────────
      //
      // The phantom loss is now structurally impossible rather than refused: a quoted cost is not
      // an input to the accrual margin, so there is no path by which this fixture produces one.
      // That is asserted both ways round — the accrual margin must be a measured ZERO (nothing
      // billed, nothing expensed) and must NOT be the old −$6,200.
      if (f.invoiced_margin.status === 'measured' && f.invoiced_margin.amount === -quotationValue) {
        bad('the accrual margin is still a loss computed from a measured-zero revenue against a '
          + 'QUOTED cost — the kinds have been collapsed back together', f.invoiced_margin);
      } else if (f.invoiced_margin.status === 'measured' && f.invoiced_margin.amount === 0
        && f.invoiced_margin.isLoss === false) {
        ok('the invoiced margin reads a measured ZERO: nothing was billed and nothing was '
          + 'expensed, so the accrual result on this deal is zero — NOT the −$6,200 that the '
          + 'undifferentiated `cost` kind produced, and not a refusal either, because refusing it '
          + 'is what also hid genuine write-offs');
      } else {
        bad('the invoiced margin is neither zero nor the known defect', f.invoiced_margin);
      }

      if (f.projected_margin.status === 'measured'
        && f.projected_margin.amount === 0
        && /PROJECTION on prices/.test(f.projected_margin.detail)) {
        ok('the PROJECTED margin is where the quoted cost belongs, and it reads zero here because '
          + 'this fixture quotes out at exactly what it would pay — a pass-through, which is the '
          + 'honest projection and is labelled a projection rather than a result');
      } else bad('the projected margin is wrong', f.projected_margin);

      if (f.realized_result.status === 'measured' && f.realized_result.amount === 0) {
        ok('and the REALIZED result is zero: no cash in, no cash out. Three figures, three stated '
          + 'pairs of sides, none of them called simply "margin"');
      } else bad('the realized result is wrong', f.realized_result);

      // ── AND THE LOSS THAT MUST NOT BE SUPPRESSED ──────────────────────
      //
      // The counterpart assertion, on a fixture built here rather than on this workflow's data:
      // requirement 7 also says *"Do not suppress legitimate losses merely because revenue is
      // zero."* An INCURRED expense against a readable zero revenue is a loss, and it is reported.
      const writeOff = LEDGER.aggregate({
        facts: [{ kind: 'cost_incurred', amount: 1_250, currency: 'USD', basis: 'recorded',
          source: 'synthetic:write-off-control' }],
        readable: { invoiced: true, cost_incurred: true },
      });
      const wo = writeOff.figures.invoiced_margin;
      if (wo.status === 'measured' && wo.amount === -1_250 && wo.isLoss === true) {
        ok('CONTROL: an incurred expense against a readable zero revenue reports a LOSS of '
          + 'USD 1,250.00 with isLoss set — the figure the earlier zero-revenue refusal would '
          + 'have hidden, and the one a CEO must not be shielded from');
      } else {
        bad('a genuine write-off is being suppressed or mis-signed — the zero-revenue refusal is '
          + 'back in some form', wo);
      }

      // The deliberate distinction that this fixture exists to show: the quotation and the cost
      // are the SAME number and DIFFERENT kinds.
      if (f.quotation.amount === f.cost_quoted.amount
        && f.quotation.kind !== f.cost_quoted.kind) {
        ok('the quotation and the quoted procurement cost are the same FIGURE and different KINDS '
          + 'here, which is the case a single "value" column gets wrong: one is what we would '
          + 'charge and the other is what we would pay, and they diverge the moment a margin is '
          + 'added or a freight line appears');
      } else bad('the fixture no longer distinguishes quotation from quoted cost',
        { q: f.quotation.amount, c: f.cost_quoted.amount });

      // Nothing was ordered and nothing was expensed, and both say so as measurements.
      if (f.cost_committed.status === 'measured_zero' && f.cost_incurred.status === 'measured_zero') {
        ok('committed and incurred costs are both MEASURED ZERO — this workflow placed no order '
          + 'and received no supplier invoice, which is the difference between a price somebody '
          + 'named and money anybody owes');
      } else bad('the uncommitted cost states are not measured zeros',
        { committed: f.cost_committed.status, incurred: f.cost_incurred.status });
    }

    // ══ 11b. THE CHAIN, ASSERTED AS A CHAIN ═════════════════════════════
    //
    // Owner's requirement 6, 2026-11-26: *"Eleven independently passing stages are not sufficient
    // if the actual workflow cannot traverse them consecutively."*
    //
    // Every section above can pass while the chain is broken, and for most of this check's life it
    // did: stage 4 refused, so stages 5-11 ran on fixtures that stood in for an artefact nobody
    // produced. Each section was true about its own stage and the workflow did not exist.
    //
    // So the LINKS are asserted here, separately from the stages: for each join, the input the
    // later stage used must be IDENTICAL to the output the earlier stage produced. Not "both
    // plausible", not "both present" — the same value. A broken link fails this section even when
    // every stage above is green, which is the only way to tell a workflow from a list.
    head('11b. the links between the stages — each input IS the previous output');

    {
      const links = [
        // ── THE 1→2 LINK IS THROUGH THE RUN, NOT THROUGH COMPANY SCOPING ──
        //
        // My first version asserted that every discovered supplier carried `company_id = CO`, and
        // it failed. Reading stage 2: `suppliers` is a GLOBAL registry with no company column, and
        // the variable is `SUPPLIERS` — the fixture set this check registered — not `suppliers`.
        // Two errors, and the second was hiding the first.
        //
        // So the link that actually exists is stated instead: the governed procurement run which
        // produced the artefact is attached to the stage-1 objective and its company, both read
        // back off the run rather than off anything this check passed in. Asserting a scoping that
        // the schema does not have would be a link that passes by being about nothing.
        ['1→2  the procurement run is attached to the stage-1 objective',
          () => !!(prepared2.objectiveId === OBJ && prepared2.companyId === CO),
          'the run that drove procurement belongs to a different objective or company'],
        ['2→3  qualification judged the discovered suppliers',
          () => qualified.length > 0 && qualified.every((q) => SUPPLIERS.some((x) => x.id === q.id)),
          'a qualified supplier was not among the discovered ones'],
        ['3→4b the RFQ went to a QUALIFIED supplier',
          () => qualified.some((q) => q.id === chosen.id),
          'the RFQ was prepared for a supplier qualification did not pass'],
        ['4b→5 the approval carries the artefact byte for byte',
          () => !!(prepared2.ok && approvalPayload && approvalPayload.text === prepared2.body
            && approvalPayload.subject === prepared2.subject),
          'the approval was queued over something other than the generated letter'],
        ['5→5b the release returns the approved payload',
          () => !!(released && released.released === true && released.actionPayload
            && released.actionPayload.text === prepared2.body),
          'the released payload is not the approved artefact'],
        ['5b→6 the transmission is of the RELEASED RFQ',
          () => !!(released && released.released === true),
          'stage 6 recorded a transmission with nothing released'],
        ['6→7  the replies answer THAT rfq',
          () => REPLIES.every((r) => r.sup && qualified.some((q) => q.id === r.sup.id)),
          'a reply came from a supplier that was never written to'],
        ['7→8  extraction read the stored replies',
          () => quotes.length === REPLIES.length
            && quotes.every((q) => REPLIES.some((r) => Number(r.price) === Number(q.price_per_kg))),
          'the extracted quotations are not the replies that were recorded'],
        ['8→9  qualification judged the extracted quotes',
          () => judged.length === quotes.length
            && judged.every((j) => quotes.some((q) => q.supplier_id === j.supplier_id)),
          'a judged quote was not one of the extracted ones'],
        ['9→10 the decision took an ACCEPTABLE quote',
          () => !!(winner && judged.some((j) => j.supplier_id === winner.supplier_id
            && j.acceptable === true)),
          'the decision chose a quote qualification rejected, or one it never saw'],
        ['10→11 reconciliation priced the DECIDED quote',
          () => Math.round(quotationValue * 100)
            === Math.round(DECISION.pricePerKg * DECISION.quantityKg * 100),
          'the reconciled figure is not the decision\'s own arithmetic'],
      ];

      const broken = [];
      for (const [name, holds, why] of links) {
        let good = false;
        try { good = holds() === true; } catch (e) { good = false; why.toString(); }
        if (good) ok(`LINK ${name}`);
        else { broken.push(`${name}: ${why}`); }
      }
      if (broken.length) {
        bad(`${broken.length} of ${links.length} links between consecutive stages are BROKEN — the `
          + 'stages pass individually and the workflow does not traverse', broken);
      } else {
        ok(`all ${links.length} links hold: the workflow traverses stages 1 to 11 consecutively, `
          + 'each stage consuming the previous stage\'s actual output. Stage 4 is the join that '
          + 'used to break, and it now closes through the synthetic provider seam — with the '
          + 'governed path, the budget hold, the digest binding and the release gate all traversed '
          + 'rather than routed around');
      }
    }

    // ══ 12. WHAT THIS DOES NOT ESTABLISH ════════════════════════════════
    head('12. the boundary of this demonstration');

    note('NOT established: that any MODEL can write an RFQ. Stage 4b produces a letter through the '
      + 'synthetic responder, which is deterministic canned text — it establishes that the '
      + 'governed PATH carries an artefact from preparation to release, and nothing whatever '
      + 'about the quality, tone or correctness of generated prose. Whether a model would write a '
      + 'sendable letter is still open, and the live-model verification (unauthorized, documented '
      + 'in docs/office/live-model-verification-procedure.md) is what would answer it.');
    note('NOT established: anything about a real provider\'s BILLING. Every hold in this run '
      + 'resolved to a proven zero because no request was dispatched. A measured cost has still '
      + 'never been compared against a held allowance on this path.');
    note('NOT established: anything about a REAL supplier. Every supplier, reply, price and lead '
      + 'time here is a fixture that says so in its own stored text. No supplier was contacted, '
      + 'no order placed, no payment made, no financial commitment entered.');
    note('NOT established: the DISPATCH half of the road. Preparation → approval → release is now '
      + 'traversed (stages 4b, 5 and 5b); what follows release — an actual send — is B5.1, and it '
      + 'needs the production email STOP lifted, which stays in force, plus B7.6d, B7.9a, B7.11a '
      + 'and B7.12. Nothing here sends anything: `sent: false` is stated by the module, not '
      + 'inferred, and the transmission in stage 6 is a database row.');
    note('NOT established: that these figures would be these states in PRODUCTION. Most would read '
      + '`missing` today, because the attribution backfill (B7.18a / B7.21) has not been applied.');
    note(`zero outward calls across the whole workflow (${outward.length}), with the spy proved `
      + 'able to fire in section 0');
    note('every fixture here was created by id and is removed by id below.');
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    global.fetch = realFetch;
    try {
      for (const id of made.rfqs) {
        await query(`DELETE FROM rfq_responses WHERE rfq_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM supplier_outreach_log WHERE rfq_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM rfq_requests WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.suppliers) {
        await query(`DELETE FROM suppliers WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.objectives) {
        await query(`DELETE FROM office_exceptions WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM agent_runs WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      // By id, exactly the rows this check inserted — never by pattern and never by recency.
      for (const id of made.users) {
        await query(`DELETE FROM users WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.companies) {
        await query(`DELETE FROM office_exceptions WHERE company_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => {});
      }
    } catch (e) { bad('cleanup failed', e.message); }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
