#!/usr/bin/env node
// ── WOULD CANONICAL SUPPLIER MATCHING HAVE HELPED REAL PROCUREMENT? ──────────
//
//   railway ssh 'node scripts/gate2-supplier-overlap.js'
//
// READS ONLY. No INSERT, no UPDATE, no DELETE, no DDL, no supplier-matching change, and no email.
//
// EXIT 0 MEANS "I MEASURED", NOT "ALL CLEAR". Read the numbers.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// The 31 Oct measurement found supplier capability is the best-covered part of Gate 2: 408 of 422
// supplier_products rows carry a canonical molecule_id (96.7%), covering 321 distinct molecules,
// 60 of them with more than one supplier. That looks like strong evidence for replacing
// `matchSuppliers` -- which today scores keyword overlap against a `mol.category` the RFQ path
// passes as `null`, making the only molecule-aware term in the score inert.
//
// But coverage of 321 molecules is worthless if none of them is a molecule anyone has actually
// asked to source. Four of the six historical RFQ rows do not resolve to a canonical identity at
// all, so for those, canonical capability cannot help whatever the coverage figure says.
//
// So this measures the OVERLAP, not the coverage: of the RFQ demand that does resolve, how much
// has a canonical supplier, and would the canonical answer have differed from the one the
// heuristic actually produced.
//
// ── ONE RESOLVER ────────────────────────────────────────────────────────────
//
// Reuses classify() and loadCanonical() from gate2-measure-identity.js. Not a second
// implementation of "what does this string resolve to"; E1 created 38 molecules nobody authorised
// because two pieces of code each had their own answer to that question.
//
// ── AND THE HEURISTIC IS CALLED, NOT REIMPLEMENTED ──────────────────────────
//
// "What the heuristic would have chosen" comes from the SHIPPED matchSuppliers. Reimplementing its
// scoring here would compare canonical matching against my idea of the heuristic rather than
// against the thing in production.
'use strict';

const fs = require('fs');
const { query } = require('../src/lib/db');
const { classify, loadCanonical } = require('./gate2-measure-identity');

const out = (s) => fs.writeSync(1, s + '\n');
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

const RFQ_COLS = { name: 'molecule_name', cas: 'cas_number' };

async function main() {
  const canonical = await loadCanonical();

  // ── the capability index: molecule -> the suppliers who have it ──
  // supplier_products.contact_id is the supplier-side key (it references the exhibitor contact),
  // so it is what identifies "a supplier" here.
  const capability = new Map();          // molecule_id -> Set(contact_id)
  let spRows = 0;
  try {
    const r = await query(
      `SELECT molecule_id, contact_id FROM supplier_products WHERE molecule_id IS NOT NULL`);
    spRows = r.rows.length;
    for (const x of r.rows) {
      const k = String(x.molecule_id);
      if (!capability.has(k)) capability.set(k, new Set());
      if (x.contact_id !== null && x.contact_id !== undefined) {
        capability.get(k).add(String(x.contact_id));
      }
    }
  } catch (e) {
    out(`COULD NOT READ supplier_products — ${e.message}`);
    return 2;
  }

  // ── the RFQ demand ──
  let rfqs;
  try {
    rfqs = (await query(
      `SELECT id, molecule_name, cas_number, week_start, status, gmp_required, target_quantity,
              target_purity
         FROM rfq_requests ORDER BY created_at`)).rows;
  } catch (e) {
    out(`COULD NOT READ rfq_requests — ${e.message}`);
    return 2;
  }

  out('');
  out('════ RFQ DEMAND vs CANONICAL SUPPLIER CAPABILITY ══════════════════════');
  out('A zero exit code means the measurement RAN. It is not a verdict.');
  out('');
  out(`   supplier_products rows carrying molecule_id      ${num(spRows, 6)}`);
  out(`   distinct canonical molecules with capability     ${num(capability.size, 6)}`);
  out(`   RFQ rows on file                                 ${num(rfqs.length, 6)}`);

  // ── per-RFQ: does it resolve, and does its molecule have suppliers? ──
  const resolvedRfqs = [];
  const unresolvedRfqs = [];
  for (const r of rfqs) {
    const c = classify(r, canonical, RFQ_COLS);
    if (c.outcome === 'resolved' || c.outcome === 'resolved_deprecated') {
      const sups = capability.get(String(c.molecule.id)) || new Set();
      resolvedRfqs.push({ rfq: r, molecule: c.molecule, outcome: c.outcome, suppliers: sups });
    } else {
      unresolvedRfqs.push({ rfq: r, outcome: c.outcome });
    }
  }

  out('');
  out('── 1. RESOLVED RFQ DEMAND');
  out(`   resolved RFQ rows                                ${num(resolvedRfqs.length, 6)}`);
  const withAny = resolvedRfqs.filter((x) => x.suppliers.size >= 1);
  const withMulti = resolvedRfqs.filter((x) => x.suppliers.size > 1);
  out(`   with >= 1 canonical supplier                     ${num(withAny.length, 6)}`);
  out(`   with >  1 canonical supplier (a comparison)      ${num(withMulti.length, 6)}`);
  out(`   resolved but with NO canonical supplier          ${num(resolvedRfqs.length - withAny.length, 6)}`);
  for (const x of resolvedRfqs) {
    out(`     ${x.molecule.molecule_ref} ${JSON.stringify(x.rfq.molecule_name)} `
      + `status=${x.rfq.status} canonical_suppliers=${x.suppliers.size}`);
  }

  out('');
  out('── 2. UNRESOLVED RFQ DEMAND (canonical matching cannot help these at all)');
  out(`   unresolved RFQ rows                              ${num(unresolvedRfqs.length, 6)}`);
  for (const x of unresolvedRfqs) {
    out(`     ${JSON.stringify(x.rfq.molecule_name)}  ${x.outcome}  status=${x.rfq.status}`);
  }

  // ── 3. would canonical matching have CHANGED the supplier set? ──
  //
  // Calls the SHIPPED matchSuppliers with the same shape the RFQ path gives it -- including
  // `category: null`, which is the whole point: that is what production actually passes, and it
  // makes the only molecule-aware term in the score inert.
  out('');
  out('── 3. WOULD THE SUPPLIER SET HAVE DIFFERED?');
  out('   "heuristic" calls the SHIPPED matchSuppliers with the arguments the RFQ path really');
  out('   passes, including category=null. Nothing is sent and nothing is changed.');
  let changed = 0; let same = 0; let uncomparable = 0;
  try {
    const procurement = require('../src/lib/agents/procurement-agent');
    if (typeof procurement.matchSuppliers !== 'function') {
      out('   matchSuppliers is not exported — cannot compare without reimplementing it, and');
      out('   reimplementing it would compare canonical matching against my guess at the');
      out('   heuristic rather than against production. Reporting that instead of guessing.');
      uncomparable = resolvedRfqs.length;
    } else {
      for (const x of resolvedRfqs) {
        const mol = {
          molecule_name: x.rfq.molecule_name,
          cas_number: x.rfq.cas_number,
          category: null,                     // exactly what generateRFQsFromApprovals passes
          gmp_required: x.rfq.gmp_required,
          target_quantity: x.rfq.target_quantity,
          target_purity: x.rfq.target_purity,
        };
        const heuristic = await procurement.matchSuppliers(mol, 3);
        const heuristicIds = new Set(heuristic.map((s) => String(s.id)));
        // The canonical set is keyed on contact_id from supplier_products; the heuristic returns
        // `suppliers` rows. Those are different key spaces, so an id-for-id comparison would be
        // meaningless. What IS comparable: how many each produces, and whether canonical produced
        // anything at all.
        const canonicalCount = x.suppliers.size;
        if (canonicalCount === 0 && heuristicIds.size > 0) {
          changed += 1;
          out(`     ${JSON.stringify(x.rfq.molecule_name)}: heuristic proposed ${heuristicIds.size}`
            + ', canonical capability knows 0 — the heuristic was asking suppliers with no'
            + ' established capability for this molecule');
        } else if (canonicalCount > 0) {
          same += 1;
          out(`     ${JSON.stringify(x.rfq.molecule_name)}: heuristic proposed ${heuristicIds.size}`
            + `, canonical capability knows ${canonicalCount}`);
        } else {
          uncomparable += 1;
        }
      }
      out('');
      out('   NOTE ON COMPARABILITY: supplier_products.contact_id and suppliers.id are different');
      out('   key spaces, so this does NOT assert which individual suppliers would change. It');
      out('   reports the counts and, most usefully, the cases where the heuristic proposed');
      out('   suppliers for a molecule no supplier has established capability for. Claiming a');
      out('   per-supplier diff across two unjoined key spaces would be a fabricated comparison.');
    }
  } catch (e) {
    out(`   COULD NOT COMPARE — ${e.message}`);
    uncomparable = resolvedRfqs.length;
  }

  out('');
  out('════ DIGEST ═══════════════════════════════════════════════════════════');
  out(`rfq_total=${rfqs.length} rfq_resolved=${resolvedRfqs.length} `
    + `rfq_unresolved=${unresolvedRfqs.length} resolved_with_supplier=${withAny.length} `
    + `resolved_with_multi=${withMulti.length} resolved_no_supplier=${resolvedRfqs.length - withAny.length}`);
  out(`capability_molecules=${capability.size} sp_linked_rows=${spRows} `
    + `heuristic_without_capability=${changed} heuristic_with_capability=${same} `
    + `uncomparable=${uncomparable}`);
  out('');
  out('Coverage of 321 molecules is not value. Value is coverage of molecules somebody has asked');
  out('to source, which is what the overlap above reports.');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { fs.writeSync(2, `OVERLAP MEASUREMENT FAILED: ${e.message}\n${e.stack}\n`); process.exit(2); });
}

module.exports = { main };
