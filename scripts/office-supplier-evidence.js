#!/usr/bin/env node
// ── SUPPLIER-SELECTION EVIDENCE FOR ONE RFQ ─────────────────────────────────
//
//   railway ssh 'node scripts/office-supplier-evidence.js --rfq=<rfq id>'
//
// READ-ONLY. It issues no INSERT, UPDATE or DELETE and writes nothing anywhere — not even an
// identity decision row (see below).
//
// ── WHY THIS EXISTS, AND HOW IT DIFFERS FROM office-rfq-candidates.js ──────
//
//   "Select the strongest legitimate remaining supplier from the eligible set, rather than simply
//    the first unused name. Apply the existing supplier-selection evidence and choose the best
//    legitimate match."
//
// office-rfq-candidates.js deliberately ranks nothing: it answers "which RFQ/supplier pairs would
// the governed path accept", and for the first governed action the choice was the CEO's alone.
// This answers a different question — "of the pairs it would accept, which supplier does the
// evidence already in this database most support" — and it prints the EVIDENCE, not only the
// conclusion, so the ordering can be disagreed with.
//
// The evidence classes, the ordering and the DMF tier acceptance all live in
// src/lib/office/supplier-evidence.js, where check-supplier-evidence-sql.js executes the SQL
// against a real Postgres and asserts the ORDER. This file only reads and prints.
//
// ── WHY decide() AND NEVER guardSend() ─────────────────────────────────────
//
// guardSend() PERSISTS an identity decision. Reading identity in order to report it must not add
// a row to the one table whose purpose is to record why a real supplier was contacted. decide()
// is the same logic without the write.
//
// It does not prepare, send, claim, approve or choose. The decision stays a human's.
'use strict';

const guard = require('../src/lib/procurement/rfq-identity-guard');
const ev = require('../src/lib/office/supplier-evidence');
const { query } = require('../src/lib/db');

const arg = (k, d = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);

(async () => {
  try {
    const rfqId = arg('rfq');
    if (!rfqId) {
      console.error('usage: office-supplier-evidence.js --rfq=<rfq id>');
      process.exit(2);
    }

    console.log('\n══ SUPPLIER-SELECTION EVIDENCE (READ-ONLY — NOTHING IS WRITTEN) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    const rfq = (await query(ev.SQL.rfq, [rfqId])).rows[0];
    if (!rfq) { console.error(`  no RFQ ${rfqId}\n`); process.exit(1); }

    // READ FROM decide()'s OWN CONTRACT, not from memory. `decision` is lowercase 'allow'/'refuse'
    // and the approved CAS is `approved_cas` — the CANONICAL value or null, never the filed one.
    // Reading guardSend()'s field names off a decide() result is how a candidate listing once
    // printed "REFUSE — undefined" for all six RFQs: it did not crash, it produced a plausible and
    // entirely wrong summary.
    const d = await guard.decide(query, rfq);
    const approvedName = d.approved_name || null;
    const approvedCas = d.approved_cas || null;

    console.log(`  RFQ               ${rfq.id}`);
    console.log(`  filed molecule    ${rfq.molecule_name}`);
    console.log(`  filed CAS         ${rfq.cas_number || '(none)'}`);
    console.log(`  identity decision ${d.decision}${d.refusal_reason ? ` (${d.refusal_reason})` : ''}`);
    console.log(`  approved molecule ${approvedName || '(none)'}`);
    console.log(`  approved CAS      ${approvedCas || '(none approved)'}`);
    console.log(`  quantity / purity ${rfq.target_quantity || '?'} / ${rfq.target_purity || '?'}`);
    console.log(`  GMP required      ${Number(rfq.gmp_required) === 1 ? 'YES' : 'no'}\n`);

    if (d.decision !== 'allow') {
      console.log('  the identity guard would REFUSE this RFQ, so no supplier is eligible for it.');
      console.log('  supplier evidence is not reported for an RFQ whose identity is contested.\n');
      process.exit(1);
    }

    const [suppliers, consumed, replies, approvals] = await Promise.all([
      query(ev.SQL.suppliers).then((r) => r.rows),
      query(ev.SQL.consumed, [rfqId]).then((r) => r.rows),
      query(ev.SQL.replies).then((r) => r.rows),
      ev.approvalsForRfq(rfqId),
    ]);

    // "searched and found nothing" and "could not search" are DIFFERENT ANSWERS. Conflating them
    // is how a drug-product maker once got filed as a buyer on a search that never ran, so an
    // unreadable dmf_holders is reported as UNAVAILABLE and never as "no DMF".
    let dmfRows = []; let dmfAvailable = true;
    try {
      const [eq, like] = ev.dmfTerms(approvedName);
      dmfRows = (await query(ev.SQL.dmf, [eq, like])).rows;
    } catch (e) {
      dmfAvailable = false;
      console.log(`  --    dmf_holders could not be read (${String(e.message).split('\n')[0]})`);
      console.log('        DMF evidence is UNAVAILABLE, which is not the same as absent\n');
    }

    const rows = ev.buildEvidence({ rfq, suppliers, consumed, replies, dmfRows, approvals });
    const ordered = ev.rankEvidence(rows);
    const blocked = rows.filter((r) => !r.eligible);

    console.log('  ── ELIGIBLE SUPPLIERS AND THEIR EVIDENCE ──\n');
    console.log(`  ${pad('supplier', 30)}${pad('GMP', 5)}${pad('rel', 5)}${pad('resp', 6)}`
      + `${pad('ord', 5)}${pad('replies', 9)}DMF (active type II, this molecule)`);
    for (const r of rows.filter((x) => x.eligible)) {
      const s = r.supplier;
      const dmfTxt = !dmfAvailable ? 'unavailable'
        : r.dmfSafe.length ? r.dmfSafe.map((x) => `#${x.dmf_number} (${x.tier})`).join(', ')
          : r.dmfWeak.length
            ? `none accepted — ${r.dmfWeak.length} weak-tier NOT counted: `
              + r.dmfWeak.map((x) => `#${x.dmf_number} "${x.holder}" (${x.tier})`).join(', ')
            : 'none';
      console.log(`  ${pad(s.name, 30)}${pad(Number(s.gmp_certified) === 1 ? 'yes' : 'NO', 5)}`
        + `${pad(s.reliability_score, 5)}${pad(`${s.avg_response_days}d`, 6)}`
        + `${pad(s.total_orders, 5)}${pad(`${r.replied}/${r.sent}`, 9)}${dmfTxt}`);
    }
    if (!rows.some((x) => x.eligible)) console.log('  (none)');

    console.log('\n  ── NOT ELIGIBLE ──');
    for (const r of blocked) console.log(`  ${pad(r.supplier.name, 30)}${r.ineligibleBecause}`);
    if (!blocked.length) console.log('  (none)');

    // The rule is stated BEFORE the result, so the ordering can be checked against it rather than
    // taken on trust.
    console.log('\n  ── THE ORDERING RULE ──');
    ev.ORDERING_RULE.forEach((line, i) => console.log(`  ${i + 1}  ${line}`));
    console.log('  Compared IN THAT ORDER: a typed default must not outvote an FDA filing.\n');

    console.log('  ── EVIDENCE-ORDERED ──');
    ordered.forEach((r, i) => {
      console.log(`  ${i + 1}. ${pad(r.supplier.name, 28)} ${ev.reasonsFor(r, { dmfAvailable }).join(' · ')}`);
    });

    if (!ordered.length) {
      console.log('  (none — the eligible supplier pool for this RFQ is EXHAUSTED)\n');
      process.exit(1);
    }

    const top = ordered[0];
    console.log(`\n  STRONGEST BY EVIDENCE   ${top.supplier.name}  <${top.supplier.contact_email}>`);
    console.log(`  supplier id             ${top.supplier.id}`);
    if (!dmfAvailable) {
      console.log('  --    the strongest class of evidence could not be read, so this ordering rests on');
      console.log('        the platform\'s own columns only. Treat it as weaker than it looks.');
    } else if (!top.dmfSafe.length && dmfRows.length) {
      console.log(`  --    ${dmfRows.length} active type II DMF(s) exist for this molecule but none matched`);
      console.log('        an eligible supplier at a tier safe enough to act on.');
    }
    if (ordered.length > 1 && ev.compareEvidence(top, ordered[1]) === 0) {
      console.log('  --    THE TOP TWO ARE TIED ON EVERY EVIDENCE CLASS — this ordering does not');
      console.log('        distinguish them, so the choice between them is not evidence-led.');
    }
    console.log('\n  THIS IS EVIDENCE, NOT A DECISION. Nothing was prepared, claimed or sent.\n');
    process.exit(0);
  } catch (e) {
    console.error(`\nFAIL  ${e.stack || e.message}\n`);
    process.exit(1);
  }
})();
