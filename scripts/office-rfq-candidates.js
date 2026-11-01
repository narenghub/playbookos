#!/usr/bin/env node
// ── §15 PREPARATION: WHAT COULD BE THE FIRST GOVERNED RFQ ───────────────────
//
//   railway ssh 'node scripts/office-rfq-candidates.js'
//
// READ-ONLY. It lists the RFQs and suppliers that the governed path WOULD accept, so the first
// real governed supplier action is chosen by a human from real data rather than by whatever the
// code happened to find first.
//
// ── WHY IT USES decide() AND NEVER guardSend() ──────────────────────────────
//
// guardSend() PERSISTS an identity decision row. Running it across every candidate RFQ to build a
// list would write a decision for each one — decisions that no communication was ever built from,
// in the one table whose whole purpose is to record why a real supplier was contacted. decide() is
// the same logic without the write, so this listing issues no INSERT, UPDATE or DELETE at all.
//
// ── WHY A HUMAN PICKS ───────────────────────────────────────────────────────
//
// Supplier selection is a commercial decision and molecule selection carries the identity risk
// this programme exists to contain — the Tramadol RFQ reached three suppliers carrying a CAS for
// the wrong form. So this script RANKS NOTHING and RECOMMENDS NOTHING. It reports what each
// candidate is and what the identity guard would say about it. The choice is the CEO's.
'use strict';

const guard = require('../src/lib/procurement/rfq-identity-guard');
const { query } = require('../src/lib/db');

const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);

(async () => {
  try {
    console.log('\n══ §15 · CANDIDATES FOR THE FIRST GOVERNED SUPPLIER RFQ (READ-ONLY) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // ── THE RFQs ───────────────────────────────────────────────────────────
    const rfqs = (await query(
      `SELECT id, molecule_name, cas_number, target_quantity, target_purity, gmp_required,
              status, priority, week_start, created_at
         FROM rfq_requests ORDER BY created_at DESC LIMIT 40`)).rows;

    console.log(`  RFQ REQUESTS (${rfqs.length} most recent)\n`);
    if (!rfqs.length) {
      console.log('    none — there is no RFQ to prepare, and one would have to be created first\n');
    } else {
      console.log(`    ${pad('id', 22)}${pad('molecule', 34)}${pad('filed CAS', 14)}`
        + `${pad('qty', 10)}${pad('status', 11)}GUARD WOULD`);
      console.log(`    ${'-'.repeat(22)}${'-'.repeat(34)}${'-'.repeat(14)}${'-'.repeat(10)}${'-'.repeat(11)}${'-'.repeat(30)}`);

      let eligible = 0;
      for (const r of rfqs) {
        let verdict;
        try {
          // decide(), NOT guardSend(): no decision row is written for a candidate nobody chose.
          const d = await guard.decide(query, r);
          if (d.allow) {
            eligible++;
            const cas = d.approved && d.approved.cas_number;
            verdict = `ALLOW as "${(d.approved && d.approved.molecule_name) || '?'}"`
              + (cas ? ` (${cas})` : ' with NO CAS');
          } else {
            verdict = `REFUSE — ${d.reason}`;
          }
        } catch (e) {
          verdict = `could not decide: ${e.message.slice(0, 40)}`;
        }
        console.log(`    ${pad(r.id, 22)}${pad(String(r.molecule_name).slice(0, 32), 34)}`
          + `${pad(r.cas_number || '(none)', 14)}${pad(r.target_quantity || '', 10)}`
          + `${pad(r.status, 11)}${verdict}`);
      }
      console.log(`\n    ${eligible} of ${rfqs.length} would be ALLOWED by the identity guard.`);
      console.log('    A REFUSE is the guard working: that RFQ\'s identity is contested or');
      console.log('    unresolvable, and no supplier communication may be built from it.\n');
    }

    // ── THE SUPPLIERS ──────────────────────────────────────────────────────
    const sup = (await query(
      `SELECT id, name, country, region, contact_email, contact_name, gmp_certified,
              reliability_score, total_orders
         FROM suppliers ORDER BY name LIMIT 60`)).rows;
    const reachable = sup.filter((s) => s.contact_email);

    console.log(`  SUPPLIERS (${sup.length} total, ${reachable.length} with a contact address)\n`);
    if (!reachable.length) {
      console.log('    none has a contact_email — the governed path refuses a supplier with no');
      console.log('    address, because an unverified destination for a real communication is not');
      console.log('    an acceptable input. One would have to be filled in first.\n');
    } else {
      console.log(`    ${pad('id', 18)}${pad('name', 34)}${pad('country', 12)}${pad('GMP', 5)}contact`);
      console.log(`    ${'-'.repeat(18)}${'-'.repeat(34)}${'-'.repeat(12)}${'-'.repeat(5)}${'-'.repeat(34)}`);
      for (const s of reachable) {
        console.log(`    ${pad(s.id, 18)}${pad(String(s.name).slice(0, 32), 34)}`
          + `${pad(s.country || '', 12)}${pad(s.gmp_certified ? 'yes' : 'no', 5)}${s.contact_email}`);
      }
      console.log('');
    }

    const unreachable = sup.filter((s) => !s.contact_email);
    if (unreachable.length) {
      console.log(`    ${unreachable.length} supplier(s) have NO contact address and would be refused:`);
      console.log(`      ${unreachable.map((s) => s.name).slice(0, 8).join(', ')}`
        + `${unreachable.length > 8 ? ` … and ${unreachable.length - 8} more` : ''}\n`);
    }

    // ── WHAT HAS ALREADY BEEN CONTACTED ────────────────────────────────────
    //
    // Relevant because "exactly one" means one NEW action, and because the historical Tramadol
    // outreach is preserved rather than cleaned up — it must not be mistaken for a fresh send.
    const prior = (await query(
      `SELECT rfq_id, supplier_id, email_sent_to, status, sent_at
         FROM supplier_outreach_log ORDER BY sent_at DESC NULLS LAST LIMIT 10`)).rows;
    console.log(`  SUPPLIER OUTREACH ALREADY ON RECORD (${prior.length} most recent)\n`);
    if (!prior.length) console.log('    none\n');
    else {
      for (const p of prior) {
        console.log(`    ${pad(p.rfq_id, 22)}${pad(p.supplier_id, 16)}${pad(p.status, 12)}`
          + `${pad(p.sent_at || '', 24)}${p.email_sent_to || ''}`);
      }
      console.log('\n    Historical rows are preserved deliberately and are NOT re-sends.\n');
    }

    console.log('  --    this listing issued no INSERT, UPDATE or DELETE and persisted no identity decision');
    console.log('  --    it ranks nothing and recommends nothing: the molecule and the supplier are a');
    console.log('  --    commercial and scientific decision, not the model\'s\n');
    console.log('  To prepare exactly one, once the objective is active:\n');
    console.log("    railway ssh 'node scripts/office-prepare-first-rfq.js --rfq=<id> --supplier=<id>'\n");
    process.exit(0);
  } catch (e) {
    console.error('\nFAIL  listing error:', e.stack || e.message);
    process.exit(1);
  }
})();
