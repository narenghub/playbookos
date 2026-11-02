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
      // Widths match the data: these ids are 36-character UUIDs, and the first version padded
      // them to 22, so every column after the id was shunted out of alignment and unreadable.
      console.log(`    ${pad('id', 38)}${pad('molecule', 32)}${pad('filed CAS', 14)}`
        + `${pad('qty', 6)}${pad('status', 10)}GUARD WOULD`);
      console.log(`    ${'-'.repeat(37)} ${'-'.repeat(31)} ${'-'.repeat(13)} ${'-'.repeat(5)} ${'-'.repeat(9)} ${'-'.repeat(40)}`);

      let eligible = 0;
      let uninterpretable = 0;
      for (const r of rfqs) {
        let verdict;
        try {
          // decide(), NOT guardSend(): no decision row is written for a candidate nobody chose.
          //
          // THE SHAPE MATTERS, AND READING THE WRONG ONE PRODUCED A FALSE REPORT ONCE.
          // decide() returns { decision: 'allow'|'refuse', refusal_reason, approved_name,
          // approved_cas, resolution, ... }. guardSend() returns { allow, reason, approved,
          // decisionId } — a DIFFERENT shape. The first version of this script read guardSend's
          // fields off decide's result, so `d.allow` was undefined, every row printed
          // "REFUSE — undefined", and the summary announced that none of six RFQs was eligible.
          // That is a false finding about production data, and it would have sent somebody into
          // the molecule registry looking for a problem that may not exist.
          const d = await guard.decide(query, r);

          // An ABSENT verdict is not a refusal. If the shape is not what this script expects, it
          // says so instead of inferring — inferring is precisely what went wrong before.
          if (!d || typeof d.decision !== 'string') {
            uninterpretable++;
            verdict = `VERDICT NOT INTERPRETABLE — no 'decision' field (keys: ${d ? Object.keys(d).join(',').slice(0, 40) : 'null'})`;
          } else if (d.decision === 'allow') {
            eligible++;
            verdict = `ALLOW as "${d.approved_name || '?'}"`
              + (d.approved_cas ? ` (${d.approved_cas})` : ' with NO CAS')
              + (d.cas_suppressed ? ' [canonical CAS withheld]' : '');
          } else {
            verdict = `REFUSE — ${d.refusal_reason || '(no reason given)'}`
              + (d.resolution && d.resolution !== 'ok' ? ` [${d.resolution}]` : '')
              + (d.refusal_reason === 'cas_disputed' && d.canonical_cas
                ? ` — filed ${r.cas_number} vs canonical ${d.canonical_cas}` : '');
          }
        } catch (e) {
          uninterpretable++;
          verdict = `could not decide: ${e.message.slice(0, 50)}`;
        }
        console.log(`    ${pad(r.id, 38)}${pad(String(r.molecule_name).slice(0, 30), 32)}`
          + `${pad(r.cas_number || '(none)', 14)}${pad(r.target_quantity || '', 6)}`
          + `${pad(r.status, 10)}${verdict}`);
      }
      if (uninterpretable) {
        console.log(`\n    ${uninterpretable} verdict(s) COULD NOT BE INTERPRETED — that is a defect in this`);
        console.log('    script or a change in the guard\'s return shape, NOT a statement about the RFQ.');
      }

      // ── WHO HAS ALREADY BEEN CONTACTED FOR EACH ELIGIBLE RFQ ─────────────
      //
      // Because "exactly one" means one NEW supplier action. Every one of these RFQs is already
      // status='sent': the legacy path contacted suppliers for them in July. Preparing a governed
      // RFQ for the same (molecule, supplier) pair would be a SECOND real communication to a
      // supplier who already has the first — which the identity guard has no opinion about, since
      // nothing about the identity is wrong. It is a commercial duplicate, so it is surfaced here
      // rather than discovered by the supplier.
      const eligibleIds = [];
      for (const r of rfqs) {
        try {
          const d = await guard.decide(query, r);
          if (d && d.decision === 'allow') eligibleIds.push(r);
        } catch (_) { /* already reported above */ }
      }
      if (eligibleIds.length) {
        console.log('\n  ALREADY CONTACTED, PER ELIGIBLE RFQ\n');
        for (const r of eligibleIds) {
          const prior = (await query(
            `SELECT o.supplier_id, s.name, o.status, o.sent_at
               FROM supplier_outreach_log o LEFT JOIN suppliers s ON s.id = o.supplier_id
              WHERE o.rfq_id = $1 ORDER BY o.sent_at`, [r.id])).rows;
          console.log(`    ${r.molecule_name}  (${r.id})`);
          if (!prior.length) {
            console.log('      no supplier has been contacted for this RFQ — any supplier is a NEW action\n');
          } else {
            for (const p of prior) {
              console.log(`      ALREADY SENT  ${pad(p.name || p.supplier_id, 34)}${pad(p.status, 13)}`
                + `${String(p.sent_at || '').slice(0, 10)}`);
            }
            console.log(`      → ${prior.length} supplier(s) already hold an RFQ for this molecule.`);
            console.log('        Choosing one of them makes the first governed action a DUPLICATE.\n');
          }
        }
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
      console.log(`    ${pad('id', 38)}${pad('name', 34)}${pad('country', 9)}${pad('GMP', 5)}contact`);
      console.log(`    ${'-'.repeat(37)} ${'-'.repeat(33)} ${'-'.repeat(8)} ${'-'.repeat(4)} ${'-'.repeat(34)}`);
      for (const s of reachable) {
        console.log(`    ${pad(s.id, 38)}${pad(String(s.name).slice(0, 32), 34)}`
          + `${pad(s.country || '', 9)}${pad(s.gmp_certified ? 'yes' : 'no', 5)}${s.contact_email}`);
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
        console.log(`    ${pad(p.rfq_id, 38)}${pad(p.supplier_id, 38)}${pad(p.status, 12)}`
          + `${pad(String(p.sent_at || '').slice(0, 19), 21)}${p.email_sent_to || ''}`);
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
