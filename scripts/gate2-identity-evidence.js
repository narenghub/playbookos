#!/usr/bin/env node
// ── THE EVIDENCE BEHIND ONE CONTESTED COMMERCIAL IDENTITY ────────────────────
//
//   railway ssh 'node scripts/gate2-identity-evidence.js tramadol'
//
// READS ONLY. No INSERT, no UPDATE, no DELETE, no DDL. Run it against production.
//
// EXIT 0 MEANS "I MEASURED", NOT "ALL CLEAR". The findings are in the text and in the DIGEST line.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// The 31 Oct measurement found one CAS contradiction in `rfq_requests`:
//
//   "Tramadol Hydrochloride"  row CAS 27203-92-5  vs  ABZ-Mol-000378 canonical CAS 36282-47-0
//
// Which number is correct is NOT a question this script answers, and not one to answer from
// recall. It gathers what the database can show — where the canonical CAS came from, what the
// source rows actually said, and whether that RFQ reached a supplier — so a person rules from
// evidence. I have already, in this programme, stated a molecule id from nothing and described two
// molecules as having nothing linked when six rows pointed at them. A registry number asserted
// from memory is the defect this gate exists to prevent.
//
// ── THE QUESTION THAT IS NOT ABOUT SCHEMA ───────────────────────────────────
//
// If the RFQ was emailed, suppliers were asked to quote a substance under a registry number the
// canonical catalogue disagrees with. That is a live commercial exposure and gets its own ruling,
// not a line in a migration plan. `supplier_outreach_log` is the authoritative record of a send:
// `rfq_requests.status` is only moved to 'sent' when at least one email landed AND the row was
// still 'pending', so status alone can be stale in both directions.
//
// ── COLUMN NAMES COME FROM THE CATALOGUE, NOT FROM ME ───────────────────────
//
// Every table is inspected via information_schema and queried with the columns it really has. A
// guessed column name already cost this programme a live run — `column "canonical_name" does not
// exist` after I wrote a query from memory — and here one bad identifier would lose the whole
// result over an SSH connection that failed three separate ways on 31 Oct. Each section is also
// guarded on its own, so a partial run is still worth reading.
'use strict';

const fs = require('fs');
const { query } = require('../src/lib/db');

const out = (s) => fs.writeSync(1, s + '\n');
const err = (s) => fs.writeSync(2, s + '\n');

const needle = (process.argv[2] || '').trim();
if (!needle) {
  err('usage: node scripts/gate2-identity-evidence.js <molecule name substring>');
  err('  no default, deliberately: a script that runs against production should not be able to');
  err('  investigate the wrong substance because an argument was forgotten.');
  process.exit(2);
}
const like = `%${needle.toLowerCase()}%`;

async function columnsOf(table) {
  const r = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
  return r.rows.map((x) => x.column_name);
}

// The first candidate column that the table really has.
function pick(cols, candidates) {
  for (const c of candidates) if (cols.includes(c)) return c;
  return null;
}

function printRows(rows, cols) {
  if (!rows.length) { out('     (none)'); return; }
  for (const r of rows) {
    const parts = cols.filter((c) => r[c] !== null && r[c] !== undefined && String(r[c]) !== '')
      .map((c) => `${c}=${JSON.stringify(r[c])}`);
    out(`     ${parts.join('  ')}`);
  }
}

// label, table, the columns to search, and the columns worth printing.
async function section(label, table, searchCandidates, showCandidates, { limit = 40 } = {}) {
  out('');
  out(`── ${label}  (${table})`);
  let cols;
  try {
    cols = await columnsOf(table);
  } catch (e) { out(`   COULD NOT INSPECT — ${e.message}`); return []; }
  if (!cols.length) { out('   TABLE DOES NOT EXIST'); return []; }

  const searchCol = pick(cols, searchCandidates);
  if (!searchCol) {
    out(`   no searchable column among [${searchCandidates.join(', ')}]; table has [${cols.join(', ')}]`);
    return [];
  }
  const show = showCandidates.filter((c) => cols.includes(c));
  const select = show.length ? show.join(', ') : searchCol;
  try {
    const r = await query(
      `SELECT ${select} FROM ${table} WHERE LOWER(${searchCol}) LIKE $1 LIMIT ${limit}`, [like]);
    out(`   searched on ${searchCol}; ${r.rows.length} row(s)`);
    printRows(r.rows, show.length ? show : [searchCol]);
    return r.rows;
  } catch (e) { out(`   QUERY FAILED — ${e.message}`); return []; }
}

async function main() {
  out('');
  out('════ IDENTITY EVIDENCE ════════════════════════════════════════════════');
  out(`   subject: names containing ${JSON.stringify(needle)}`);
  out('   READS ONLY. Exit 0 means the evidence was gathered, not that anything is fine.');

  // ── 1. the canonical molecule, and how its CAS was derived ──
  const mols = await section('canonical molecule', 'molecules',
    ['normalized_name', 'preferred_name'],
    ['id', 'molecule_ref', 'preferred_name', 'normalized_name', 'cas', 'cas_suppressed_reason',
      'substance_form', 'parent_molecule_id', 'derived_base_name', 'source', 'derivation_method',
      'verification_status', 'deprecated_at', 'deprecated_reason', 'collected_at']);

  // ── 2. recorded contests and quarantine evidence ──
  await section('conflicts and quarantine', 'molecule_conflicts',
    ['filed_name', 'conflict_key'],
    ['id', 'kind', 'filed_name', 'conflict_key', 'detail', 'source_table', 'source_row_ids',
      'detected_at', 'resolved_at', 'resolution']);

  // ── 3. what the SOURCE rows actually said ──
  await section('study evidence', 'study_molecules',
    ['molecule_name'], ['id', 'study_id', 'molecule_name', 'cas_number', 'molecule_id',
      'catalog_match_status', 'inference_confidence']);
  await section('supplier evidence', 'supplier_products',
    ['product_name'], ['id', 'event_slug', 'contact_id', 'product_name', 'cas', 'molecule_id']);
  await section('research-interest evidence', 'research_interests',
    ['value', 'normalized'], ['id', 'lab_id', 'kind', 'value', 'normalized', 'cas', 'molecule_id']);

  // ── 4. aliases pointing at it ──
  await section('curated aliases', 'molecule_aliases',
    ['alias'], ['id', 'molecule_id', 'alias', 'alias_type', 'source', 'collected_at']);

  // ── 5. the commercial rows ──
  const rfqs = await section('the RFQ(s)', 'rfq_requests',
    ['molecule_name'], ['id', 'molecule_name', 'cas_number', 'target_quantity', 'target_purity',
      'gmp_required', 'week_start', 'status', 'priority', 'approval_id', 'created_at']);
  await section('inquiries naming it', 'inquiries',
    ['molecule_name'], ['id', 'molecule_name', 'cas_number', 'buyer_company', 'buyer_email',
      'status', 'created_at']);
  await section('quotes naming it', 'inquiry_quotes',
    ['molecule_name'], ['id', 'inquiry_id', 'molecule_name', 'cas_number', 'quantity_kg',
      'unit_price_usd', 'total_price_usd', 'status', 'created_at']);
  await section('priced catalogue row', 'molecule_pricing',
    ['molecule_name'], ['id', 'molecule_name', 'cas_number', 'price_per_kg_usd', 'active']);

  // ── 6. DID IT REACH A SUPPLIER? ──
  //
  // supplier_outreach_log is the authoritative send record. rfq_requests.status is set only when
  // at least one email landed AND the row was still 'pending', so it can be stale either way.
  out('');
  out('════ DID THE RFQ REACH A SUPPLIER? ════════════════════════════════════');
  const rfqIds = rfqs.map((r) => r.id).filter(Boolean);
  let sendRows = [];
  let responseRows = [];
  if (!rfqIds.length) {
    out('   no RFQ rows matched, so there is nothing to have been sent');
  } else {
    try {
      const cols = await columnsOf('supplier_outreach_log');
      const show = ['id', 'rfq_id', 'supplier_id', 'email_sent_to', 'email_subject', 'status',
        'claimed_at', 'sent_at', 'replied_at', 'error'].filter((c) => cols.includes(c));
      const r = await query(
        `SELECT ${show.join(', ')} FROM supplier_outreach_log WHERE rfq_id = ANY($1)`, [rfqIds]);
      sendRows = r.rows;
      out('');
      out(`── supplier_outreach_log for ${rfqIds.length} RFQ id(s): ${r.rows.length} row(s)`);
      printRows(r.rows, show);
    } catch (e) { out(`   supplier_outreach_log QUERY FAILED — ${e.message}`); }

    try {
      const cols = await columnsOf('rfq_responses');
      const show = ['id', 'rfq_id', 'supplier_name', 'price_per_kg', 'lead_time_days', 'created_at']
        .filter((c) => cols.includes(c));
      const r = await query(
        `SELECT ${show.join(', ')} FROM rfq_responses WHERE rfq_id = ANY($1)`, [rfqIds]);
      responseRows = r.rows;
      out('');
      out(`── rfq_responses (a reply PROVES a send): ${r.rows.length} row(s)`);
      printRows(r.rows, show);
    } catch (e) { out(`   rfq_responses QUERY FAILED — ${e.message}`); }
  }

  // ── the verdict on the send, by evidence class ──
  const confirmedSent = sendRows.filter((r) => ['sent', 'replied', 'no_response'].includes(r.status));
  const attempted = sendRows.filter((r) => ['pending', 'failed'].includes(r.status));
  const statusSaysSent = rfqs.filter(
    (r) => ['sent', 'responded', 'compared', 'approved', 'ordered'].includes(r.status));

  let verdict;
  if (confirmedSent.length || responseRows.length) verdict = 'REACHED_SUPPLIERS';
  else if (statusSaysSent.length) verdict = 'STATUS_SAYS_SENT_NO_LOG';
  else if (attempted.length) verdict = 'ATTEMPTED_NOT_CONFIRMED';
  else verdict = 'NOT_SENT';

  out('');
  out('── verdict on the send');
  out(`   outreach rows confirming a send      ${confirmedSent.length}`);
  out(`   supplier replies on file             ${responseRows.length}`);
  out(`   outreach rows claimed but unsent     ${attempted.length}`);
  out(`   RFQ rows whose status implies sent   ${statusSaysSent.length}`);
  out(`   VERDICT                              ${verdict}`);

  if (verdict === 'REACHED_SUPPLIERS') {
    out('');
    out('╔══════════════════════════════════════════════════════════════════════╗');
    out('║  ISOLATED COMMERCIAL-SAFETY FINDING                                  ║');
    out('╚══════════════════════════════════════════════════════════════════════╝');
    out('   An RFQ whose filed CAS contradicts the canonical identity REACHED SUPPLIERS.');
    out('   Suppliers were asked to quote a substance under a registry number the catalogue');
    out('   disagrees with. This is not a schema question and must not be folded into Gate 2.');
    out('   It needs its own ruling, and nothing here has changed either number.');
  } else if (verdict === 'STATUS_SAYS_SENT_NO_LOG') {
    out('');
    out('   The RFQ status implies a send but no outreach row records one. Either the send');
    out('   predates the outreach log, or a send happened whose record was lost — which is the');
    out('   exact window the idempotency claim was built to close. Treat as POSSIBLY SENT.');
  }

  // ── a line that survives a dropped connection ──
  const m = mols[0] || {};
  out('');
  out('════ DIGEST ═══════════════════════════════════════════════════════════');
  out(`subject=${JSON.stringify(needle)} molecules=${mols.length} `
    + `ref=${m.molecule_ref || 'none'} canonical_cas=${m.cas || 'NULL'} `
    + `suppressed=${m.cas_suppressed_reason ? 'yes' : 'no'} deprecated=${m.deprecated_at ? 'yes' : 'no'}`);
  out(`rfqs=${rfqs.length} send_verdict=${verdict} confirmed_sends=${confirmedSent.length} `
    + `replies=${responseRows.length}`);
  out('');
  out('Nothing above adjudicates which CAS is correct. That is a human ruling, from this evidence.');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { err(`EVIDENCE GATHERING FAILED: ${e.message}\n${e.stack}`); process.exit(2); });
}

module.exports = { main, columnsOf, pick };
