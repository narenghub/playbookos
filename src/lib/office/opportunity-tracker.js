// ── THE TRACKER: IMPORT, DEDUPLICATE, ASSESS, FILTER, EXPORT ─────────────────
//
// Ruling 21 priorities 1–3. The product, not a description of it.
//
// Everything here takes a `q(sql, params)` function rather than opening its own connection, so the
// same code runs against a disposable cluster in the demo and against a real database later
// without a flag that changes behaviour between them.
'use strict';

const crypto = require('crypto');
const { parseCsv, toExcelCsv } = require('./opportunity-csv');
const { mapHeaders, normalizeRow } = require('./opportunity-normalize');
const { assess } = require('./opportunity-qualify');

const id = (p) => `${p}-${crypto.randomBytes(8).toString('hex')}`;

// ── DEDUPLICATION, IN THREE TIERS ───────────────────────────────────────────
//
// Ruling 21 item 5: detect duplicates and amendments without losing historical versions.
//
//   Tier 1 — same solicitation number, same content hash → ALREADY HAVE IT. No new row.
//            This is what makes re-importing yesterday's file harmless.
//   Tier 2 — same solicitation number, DIFFERENT content hash → AMENDMENT. New version row,
//            previous row demoted, nothing deleted.
//   Tier 3 — different solicitation number, suspiciously similar → RECORDED FOR A HUMAN.
//            Not merged. Two numbers that look alike may be a reissue or two real procurements,
//            and the system is not entitled to that judgement.

/** Cheap token-overlap similarity on titles. Deliberately simple and deliberately only advisory. */
function titleSimilarity(a, b) {
  const tok = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const A = tok(a); const B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / Math.max(A.size, B.size);
}

async function createBatch(q, { companyId, source, importedBy, sourceDetail, sourceSha256, notes }) {
  const bid = id('batch');
  await q(
    `INSERT INTO opportunity_import_batches
       (id, company_id, source, imported_by, source_detail, source_sha256, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [bid, companyId, source, importedBy, sourceDetail, sourceSha256 || null, notes || null]);
  return bid;
}

/**
 * Import normalized records into the tracker, applying all three dedup tiers.
 * Returns a per-record outcome, because "imported 40" without saying which were new, which were
 * amendments and which were already held is not an answer a person can act on.
 */
async function importRecords(q, { companyId, batchId, records, duplicateThreshold = 0.82 }) {
  const outcome = { inserted: [], amended: [], unchanged: [], duplicateCandidates: [], rejected: [] };

  for (const rec of records) {
    // Tier 1 / Tier 2: look for this solicitation number.
    const existing = (await q(
      `SELECT id, version_seq, content_hash, is_current
         FROM federal_opportunities
        WHERE company_id = $1 AND solicitation_number = $2
        ORDER BY version_seq DESC`,
      [companyId, rec.solicitation_number])).rows;

    if (existing.some((e) => e.content_hash === rec.content_hash)) {
      outcome.unchanged.push(rec.solicitation_number);
      continue;                                            // Tier 1: idempotent
    }

    const oid = id('opp');
    const isAmendment = existing.length > 0;
    const nextSeq = isAmendment ? Math.max(...existing.map((e) => e.version_seq)) + 1 : 1;

    if (isAmendment) {
      // Demote the current row FIRST. The partial unique index would otherwise refuse the insert,
      // which is the index doing its job: there can only be one current version.
      const cur = existing.find((e) => e.is_current);
      if (cur) {
        await q(
          `UPDATE federal_opportunities SET is_current = false, superseded_by = $3
             WHERE id = $1 AND company_id = $2`,
          [cur.id, companyId, oid]);
      }
    }

    await q(
      `INSERT INTO federal_opportunities
         (id, company_id, import_batch_id, solicitation_number, notice_id, version_seq,
          is_current, content_hash, title, agency, sub_agency, office, naics_code, psc_code,
          set_aside, contract_type, estimated_value_usd, posted_date, response_deadline,
          deadline_has_time, deadline_source_text, notice_type, status, source_url, description,
          place_of_performance)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25)`,
      [oid, companyId, batchId, rec.solicitation_number, rec.notice_id, nextSeq, rec.content_hash,
        rec.title, rec.agency, rec.sub_agency, rec.office, rec.naics_code, rec.psc_code,
        rec.set_aside, rec.contract_type, rec.estimated_value_usd, rec.posted_date,
        rec.response_deadline, rec.deadline_has_time, rec.deadline_source_text, rec.notice_type,
        rec.status, rec.source_url, rec.description, rec.place_of_performance]);

    (isAmendment ? outcome.amended : outcome.inserted).push(
      { solicitation_number: rec.solicitation_number, id: oid, version: nextSeq });

    // Tier 3: advisory only.
    const others = (await q(
      `SELECT id, solicitation_number, title, agency, response_deadline
         FROM federal_opportunities
        WHERE company_id = $1 AND is_current AND solicitation_number <> $2`,
      [companyId, rec.solicitation_number])).rows;
    for (const o of others) {
      const sim = titleSimilarity(rec.title, o.title);
      if (sim < duplicateThreshold) continue;
      const sameAgency = (o.agency || '') === (rec.agency || '');
      if (!sameAgency) continue;
      await q(
        `INSERT INTO opportunity_duplicate_candidates
           (id, company_id, opportunity_id, other_id, similarity, basis)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (company_id, opportunity_id, other_id) DO NOTHING`,
        [id('dup'), companyId, oid, o.id, sim.toFixed(3),
          `same agency and ${(sim * 100).toFixed(0)}% title overlap, different solicitation numbers `
          + `(${rec.solicitation_number} vs ${o.solicitation_number}) — NOT merged, for a human to decide`]);
      outcome.duplicateCandidates.push({ a: rec.solicitation_number, b: o.solicitation_number, similarity: Number(sim.toFixed(3)) });
    }
  }
  await q(
    `UPDATE opportunity_import_batches
        SET row_count = $2, accepted_count = $3, rejected_count = $4
      WHERE id = $1`,
    [batchId, records.length, outcome.inserted.length + outcome.amended.length, outcome.rejected.length]);
  return outcome;
}

/** Import from CSV text. Returns { batchId, outcome, issues, unmatchedHeaders }. */
async function importCsv(q, { companyId, importedBy, csvText, sourceDetail, source = 'csv' }) {
  const { headers, rows } = parseCsv(csvText);
  const { mapping, unmatched } = mapHeaders(headers);
  if (!mapping.solicitation_number && !mapping.notice_id) {
    throw new Error('this CSV has no column that could be a solicitation number or notice id; '
      + `headers were: ${headers.join(', ')}`);
  }
  const sha = crypto.createHash('sha256').update(csvText).digest('hex');
  const batchId = await createBatch(q, {
    companyId, source, importedBy, sourceDetail, sourceSha256: sha,
    notes: unmatched.length ? `unmapped columns: ${unmatched.join(', ')}` : null,
  });

  const records = []; const issues = []; const rejected = [];
  for (const row of rows) {
    const r = normalizeRow(row, mapping);
    if (r.rejected) { rejected.push({ row: row.__row, issues: r.issues }); continue; }
    if (r.issues.length) issues.push({ solicitation_number: r.record.solicitation_number, issues: r.issues });
    records.push(r.record);
  }
  const outcome = await importRecords(q, { companyId, batchId, records });
  outcome.rejected = rejected;
  await q(`UPDATE opportunity_import_batches SET rejected_count = $2 WHERE id = $1`, [batchId, rejected.length]);
  return { batchId, outcome, issues, unmatchedHeaders: unmatched, sha256: sha };
}

/** Confirm a deadline. Until this happens is_biddable stays false, by generated column. */
async function confirmDeadline(q, { companyId, opportunityId, confirmedBy }) {
  const r = await q(
    `UPDATE federal_opportunities
        SET deadline_confirmed_by = $3, deadline_confirmed_at = NOW()
      WHERE id = $1 AND company_id = $2 AND response_deadline IS NOT NULL
      RETURNING id, is_biddable`,
    [opportunityId, companyId, confirmedBy]);
  return r.rows[0] || null;
}

/** Assess every current opportunity against the capability registry, recording each verdict. */
async function assessAll(q, { companyId, assessedBy, capabilities, opts = {} }) {
  const opps = (await q(
    `SELECT * FROM federal_opportunities WHERE company_id = $1 AND is_current ORDER BY response_deadline NULLS LAST`,
    [companyId])).rows;
  const results = [];
  for (const opp of opps) {
    const a = assess(opp, capabilities, opts);
    await q(
      `INSERT INTO opportunity_assessments
         (id, company_id, opportunity_id, assessed_by, verdict, business_lines, reasons,
          missing_requirements, evidence_capability_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id('asmt'), companyId, opp.id, assessedBy, a.verdict, a.business_lines, a.reasons,
        a.missing_requirements, a.evidence_capability_ids]);
    results.push({ ...a, opportunity: opp });
  }
  return results;
}

// ── FILTERING (ruling 21 item 4) ────────────────────────────────────────────
/**
 * @param {object} f  { agency, naics, psc, noticeType, verdict, deadlineBefore, deadlineAfter,
 *                      biddableOnly, businessLine }
 */
async function listOpportunities(q, companyId, f = {}) {
  const where = ['o.company_id = $1', 'o.is_current'];
  const params = [companyId];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('$?', `$${params.length}`)); };

  if (f.agency) add('o.agency ILIKE $?', `%${f.agency}%`);
  if (f.naics) add('o.naics_code = $?', f.naics);
  if (f.psc) add('o.psc_code = $?', f.psc);
  if (f.noticeType) add('o.notice_type = $?', f.noticeType);
  if (f.deadlineBefore) add('o.response_deadline <= $?', f.deadlineBefore);
  if (f.deadlineAfter) add('o.response_deadline >= $?', f.deadlineAfter);
  if (f.biddableOnly) where.push('o.is_biddable');

  // The latest assessment per opportunity, so filtering by qualification status is possible
  // without the caller reasoning about assessment history.
  let sql = `
    SELECT o.*, a.verdict, a.business_lines, a.reasons, a.missing_requirements,
           a.evidence_capability_ids, a.assessed_at
      FROM federal_opportunities o
      LEFT JOIN LATERAL (
        SELECT * FROM opportunity_assessments s
         WHERE s.opportunity_id = o.id AND s.company_id = o.company_id
         ORDER BY s.assessed_at DESC LIMIT 1) a ON true
     WHERE ${where.join(' AND ')}`;
  if (f.verdict) { params.push(f.verdict); sql += ` AND a.verdict = $${params.length}`; }
  if (f.businessLine) { params.push(f.businessLine); sql += ` AND $${params.length} = ANY(a.business_lines)`; }
  sql += ' ORDER BY o.response_deadline NULLS LAST, o.solicitation_number';
  return (await q(sql, params)).rows;
}

// ── EXPORT (ruling 21 item 3) ───────────────────────────────────────────────
// Original identifiers and source links kept, per the ruling. `text: true` forces Excel to treat
// the value as text so a numeric solicitation number keeps its leading zeros.
const EXPORT_COLUMNS = [
  { key: 'solicitation_number', label: 'Solicitation Number', text: true },
  { key: 'notice_id', label: 'Notice ID', text: true },
  { key: 'title', label: 'Title' },
  { key: 'agency', label: 'Agency' },
  { key: 'sub_agency', label: 'Sub-Agency' },
  { key: 'office', label: 'Office' },
  { key: 'notice_type', label: 'Notice Type' },
  { key: 'naics_code', label: 'NAICS', text: true },
  { key: 'psc_code', label: 'PSC', text: true },
  { key: 'set_aside', label: 'Set-Aside' },
  { key: 'contract_type', label: 'Contract Type' },
  { key: 'estimated_value_usd', label: 'Estimated Value (USD)' },
  { key: 'posted_date', label: 'Posted Date', value: (r) => (r.posted_date ? String(r.posted_date).slice(0, 10) : '') },
  {
    key: 'response_deadline',
    label: 'Response Deadline',
    value: (r) => {
      if (!r.response_deadline) return '';
      const iso = new Date(r.response_deadline).toISOString();
      return r.deadline_has_time ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : iso.slice(0, 10);
    },
  },
  { key: 'deadline_has_time', label: 'Deadline Has Time', value: (r) => (r.deadline_has_time ? 'yes' : 'DATE ONLY - CONFIRM') },
  { key: 'deadline_source_text', label: 'Deadline As Published' },
  { key: 'deadline_confirmed_at', label: 'Deadline Confirmed', value: (r) => (r.deadline_confirmed_at ? 'yes' : 'NOT CONFIRMED') },
  { key: 'status', label: 'Status' },
  { key: 'is_biddable', label: 'Biddable', value: (r) => (r.is_biddable ? 'yes' : 'no') },
  { key: 'verdict', label: 'Abiozen Qualification', value: (r) => r.verdict || 'NOT ASSESSED' },
  { key: 'business_lines', label: 'Business Lines', value: (r) => (r.business_lines || []).join('; ') },
  { key: 'missing_requirements', label: 'Missing Requirements', value: (r) => (r.missing_requirements || []).join(' | ') },
  { key: 'reasons', label: 'Assessment Reasons', value: (r) => (r.reasons || []).join(' | ') },
  { key: 'version_seq', label: 'Version' },
  { key: 'source_url', label: 'Source Link' },
];

function exportCsv(rows) {
  return toExcelCsv(EXPORT_COLUMNS, rows);
}

module.exports = {
  titleSimilarity,
  createBatch,
  importRecords,
  importCsv,
  confirmDeadline,
  assessAll,
  listOpportunities,
  exportCsv,
  EXPORT_COLUMNS,
};
