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
// **Stage 4 halts at the model, and that halt is the finding.** `renderGovernedRFQ` calls
// `governedCall`, and `office/ai.js` does `require('../llm')` at module load — so there is **no
// injection seam** for the provider on this path. A synthetic demonstration therefore cannot
// produce the RFQ letter's prose without a real paid call, which is unauthorized.
//
// Rather than add a seam to a consequential module quietly, or stub past it and call the chain
// demonstrated, this check runs the stage **with no API key** and asserts what happens: the governed
// path refuses with `ai_unavailable`, produces **no sendable artefact**, makes **zero provider
// calls**, and — correctly — files no exception, because a provider being unavailable is ordinary
// operation and does not need a human. A chain that invented the letter instead would be the worst
// available outcome, so the refusal is the property worth measuring.
//
// Everything downstream of the artefact is then demonstrated on a **simulated transmission record**
// and a **simulated supplier reply**, both written as fixtures and both labelled as such in the
// rows they create. No message leaves the process: the mailer is spied on, and the spy is **fired
// deliberately first** so its later silence means something.
//
// ── THE SEVEN VALUE KINDS ARE THE POINT OF STAGE 11 ────────────────────────
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

  const made = { companies: [], objectives: [], suppliers: [], rfqs: [] };
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

    note('STAGE 4 IS THE ONE STAGE THIS CHECK CANNOT COMPLETE. `renderGovernedRFQ` calls '
      + '`governedCall`, and `office/ai.js` requires the provider at module load — there is no '
      + 'injection seam. Completing it needs either a real paid call (unauthorized) or a new seam '
      + 'in a consequential module, which is a reviewable design change rather than something to '
      + 'add quietly inside a check. The refusal above is what IS established.');

    // ══ 5. APPROVAL REQUEST — ITS SHAPE, WITHOUT AN ARTEFACT ════════════
    head('5. approval: nothing is approvable, because there is no artefact to approve');

    {
      const approvals = (await query(
        `SELECT COUNT(*)::int n FROM approval_queue`)).rows[0].n;
      if (approvals === 0) {
        ok('no approval was queued — an approval binds a DIGEST of the exact message, so queuing '
          + 'one with no message would create a human decision about nothing, and the B7.6b '
          + 'binding would have nothing to bind to');
      } else bad(`${approvals} approval(s) queued with no artefact`, approvals);
    }

    // ══ 6–7. SIMULATED TRANSMISSION AND SUPPLIER REPLY ══════════════════
    head('6–7. simulated transmission and a simulated supplier reply (fixtures, labelled)');

    const sentAt = new Date().toISOString();
    await query(`INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, email_sent_to)
                 VALUES ($1,$2,$3,$4)`,
      [uid('out'), RFQ_ID, chosen.id, chosen.contact_email]);

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
        [r.id, RFQ_ID, r.sup.id, r.sup.name, r.price, r.lead, r.purity, r.coa,
          r.sup.contact_email,
          `SIMULATED FIXTURE REPLY — no supplier was contacted. Price USD ${r.price}/kg, `
          + `lead ${r.lead} days, purity ${r.purity}.`]);
    }
    await query(`UPDATE rfq_requests SET status = 'responded' WHERE id = $1`, [RFQ_ID]);

    const got = (await query(
      `SELECT COUNT(*)::int n FROM rfq_responses WHERE rfq_id = $1`, [RFQ_ID])).rows[0].n;
    const labelled = (await query(
      `SELECT COUNT(*)::int n FROM rfq_responses
        WHERE rfq_id = $1 AND raw_response LIKE 'SIMULATED FIXTURE%'`, [RFQ_ID])).rows[0].n;
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
         FROM rfq_responses WHERE rfq_id = $1 ORDER BY price_per_kg ASC`, [RFQ_ID])).rows;

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

    // ══ 11. FINANCIAL RECONCILIATION — SEVEN KINDS, NO TOTAL ════════════
    head('11. financial reconciliation — the seven value kinds, told apart');

    {
      // The figures this workflow actually produced, each with what established it.
      const facts = [
        { kind: 'opportunity_estimate', amount: 40_000, currency: 'USD', basis: 'estimate',
          source: `objective:${OBJ}` },
        { kind: 'quotation', amount: quotationValue, currency: 'USD',
          basis: 'counterparty_stated', source: `rfq_response:${winner.supplier_id}` },
        // Cost is the procurement side of the SAME deal, and it is a different kind from the
        // quotation even though the figures coincide here — which is exactly why the kinds exist.
        { kind: 'cost', amount: quotationValue, currency: 'USD', basis: 'counterparty_stated',
          source: `rfq_response:${winner.supplier_id}` },
      ];

      const agg = LEDGER.aggregate({
        facts,
        readable: {
          // Measured zeros: these sources exist and this synthetic deal reached none of them.
          order: true, invoiced: true, payment_received: true,
          opportunity_estimate: true, quotation: true, cost: true,
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

      // Margin REFUSES: nothing was invoiced, so there is no revenue to subtract a cost from.
      if (f.margin.status === 'measured' && f.margin.amount === -quotationValue) {
        bad('margin was computed as a loss from a measured-zero revenue against a real cost — '
          + 'arithmetically true and commercially meaningless for a deal that has not happened',
        f.margin);
      } else if (f.margin.status === 'measured' && f.margin.amount === 0 - quotationValue) {
        bad('margin computed against a zero revenue', f.margin);
      } else {
        ok(`margin reads ${f.margin.status}${f.margin.amount === null ? '' : ` (${f.margin.amount})`} `
          + '— and whichever way it falls it is DERIVED and named, never a stored fact a workflow '
          + 'could assert about itself');
      }

      // The deliberate distinction that this fixture exists to show: the quotation and the cost
      // are the SAME number and DIFFERENT kinds.
      if (f.quotation.amount === f.cost.amount && f.quotation.kind !== f.cost.kind) {
        ok('the quotation and the procurement cost are the same FIGURE and different KINDS here, '
          + 'which is the case a single "value" column gets wrong: one is what a supplier will '
          + 'charge us and the other is what we will have spent, and they diverge the moment a '
          + 'margin is added or a freight line appears');
      } else bad('the fixture no longer distinguishes quotation from cost',
        { q: f.quotation.amount, c: f.cost.amount });
    }

    // ══ 12. WHAT THIS DOES NOT ESTABLISH ════════════════════════════════
    head('12. the boundary of this demonstration');

    note('NOT established: the RFQ ARTEFACT. Stage 4 halts at the model and the letter is never '
      + 'produced. Completing that stage needs a real paid call (unauthorized) or an injection '
      + 'seam in office/ai.js — a reviewable design change, not a change to make inside a check.');
    note('NOT established: anything about a REAL supplier. Every supplier, reply, price and lead '
      + 'time here is a fixture that says so in its own stored text. No supplier was contacted, '
      + 'no order placed, no payment made, no financial commitment entered.');
    note('NOT established: the approval → release → dispatch road. That road is B5.1 and it needs '
      + 'the production email STOP lifted, which stays in force, plus B7.6d, B7.9a, B7.11a and '
      + 'B7.12.');
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
