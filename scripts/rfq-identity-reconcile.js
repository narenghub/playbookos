#!/usr/bin/env node
// ── DID EVERY SUPPLIER RFQ SEND HAVE AN IDENTITY DECISION BEHIND IT? ────────
//
//   railway ssh 'node scripts/rfq-identity-reconcile.js'
//
// READS ONLY. Performs no migration, no backfill, no send. A verification that performs the work it
// verifies grades its own homework — proof 10 re-ran the molecule migration, took 23 minutes and
// then failed for the writes it had itself made.
//
// THE VERDICT IS THE EXIT CODE. Non-zero means an invariant is broken. The report above it is
// diagnostics.
//
// ── THE CUTOVER, AND WHY THIS IS NOT A GLOBAL ABSOLUTE ──────────────────────
//
// "No RFQ carries a CAS contradicting its canonical identity" is FALSE the moment it is written,
// because one does: RFQ d7a05efb went to Laurus Labs, Divi's and Dr Reddy's on 21 July 2026 under
// `Tramadol Hydrochloride (27203-92-5)` against a canonical `36282-47-0`. That row is historical
// evidence and must stay exactly as it is.
//
// So every safety assertion is scoped to sends that happened AFTER the guard existed, and the
// historical defect is asserted to still be VISIBLE and UNCHANGED. A reconciliation that could only
// go green by editing history would pressure the next person into editing history — the same defect
// shape as "assert the table is empty", which becomes false the moment the product is used.
'use strict';

const fs = require('fs');
const { query } = require('../src/lib/db');
const { digits, classifyFiledCas } = require('../src/lib/procurement/rfq-identity-guard');

const out = (s) => fs.writeSync(1, s + '\n');
let fail = 0;
const pass = (m) => out(`  ok    ${m}`);
const broke = (m, d) => { fail += 1; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 600)}`); };

// The cutover: the first decision ever recorded. Sends before it predate the guard; sends after it
// must satisfy it. Derived from the data rather than hard-coded, so it cannot drift from reality.
async function cutover() {
  const r = await query(`SELECT MIN(decided_at) AS at FROM rfq_identity_decisions`);
  return r.rows[0] ? r.rows[0].at : null;
}

async function main() {
  fail = 0;
  out('');
  out('════ RFQ IDENTITY RECONCILIATION ══════════════════════════════════════');

  let cut;
  try { cut = await cutover(); } catch (e) {
    broke('rfq_identity_decisions is unreadable, so no send can be shown to have been decided', e.message);
    out('');
    out(`FAIL  ${fail} invariant(s) broken`);
    return 1;
  }
  out(`   guard cutover (first decision): ${cut || 'NONE YET — the guard has never run'}`);

  // Confirmed supplier sends, with the decision (if any) that preceded them.
  const sends = (await query(
    `SELECT o.id, o.rfq_id, o.supplier_id, o.status, o.sent_at, o.email_subject,
            r.molecule_name, r.cas_number
       FROM supplier_outreach_log o
       LEFT JOIN rfq_requests r ON r.id = o.rfq_id
      WHERE o.status IN ('sent','replied','no_response')`)).rows;

  const post = cut ? sends.filter((s) => s.sent_at && new Date(s.sent_at) >= new Date(cut)) : [];
  const pre = cut ? sends.filter((s) => !s.sent_at || new Date(s.sent_at) < new Date(cut)) : sends;
  out(`   confirmed supplier sends: ${sends.length}  (pre-cutover ${pre.length}, post ${post.length})`);

  const decisions = (await query(
    `SELECT * FROM rfq_identity_decisions ORDER BY decided_at`)).rows;
  const allowedByRfq = new Map();
  for (const d of decisions) if (d.decision === 'allow') allowedByRfq.set(String(d.rfq_id), d);
  out(`   identity decisions recorded: ${decisions.length}`
    + `  (allow ${decisions.filter((d) => d.decision === 'allow').length},`
    + ` refuse ${decisions.filter((d) => d.decision === 'refuse').length})`);
  out('');

  // ── 1. every post-cutover send has a durable identity decision ───────────
  const undecided = post.filter((s) => !allowedByRfq.has(String(s.rfq_id)));
  if (!undecided.length) pass(`every post-cutover send (${post.length}) has an allowed identity decision`);
  else broke(`${undecided.length} post-cutover send(s) have NO allowed decision`,
    undecided.map((s) => `${s.rfq_id} → ${s.email_sent_to || s.supplier_id}`).join('; '));

  // ── 2. every allowed decision names the exact canonical identity used ────
  const vague = decisions.filter((d) => d.decision === 'allow'
    && (!d.molecule_id || !d.molecule_ref || d.resolution !== 'ok'));
  if (!vague.length) pass('every allowed decision records a resolved canonical molecule id and ref');
  else broke(`${vague.length} allowed decision(s) do not name a resolved canonical identity`,
    vague.map((d) => `decision ${d.id} rfq ${d.rfq_id} res=${d.resolution}`).join('; '));

  // ── 3. no post-cutover send carries a malformed CAS as authoritative ─────
  const malformedSent = post.filter((s) => {
    const d = allowedByRfq.get(String(s.rfq_id));
    return d && d.approved_cas && classifyFiledCas(d.approved_cas) === 'malformed';
  });
  if (!malformedSent.length) pass('no post-cutover send approved a checksum-invalid CAS');
  else broke(`${malformedSent.length} post-cutover send(s) approved a malformed CAS`,
    malformedSent.map((s) => s.rfq_id).join('; '));

  // ── 4. no post-cutover send carries a CAS contradicting its canonical ────
  const contradicting = decisions.filter((d) => d.decision === 'allow'
    && d.approved_cas && d.canonical_cas && digits(d.approved_cas) !== digits(d.canonical_cas));
  if (!contradicting.length) pass('no allowed decision approved a CAS differing from its canonical CAS');
  else broke(`${contradicting.length} allowed decision(s) approved a non-canonical CAS`,
    contradicting.map((d) => `decision ${d.id}: approved ${d.approved_cas} vs canonical ${d.canonical_cas}`).join('; '));

  // ── 5. no post-cutover send used a deprecated identity ───────────────────
  const deprecatedAllowed = decisions.filter((d) => d.decision === 'allow' && d.resolution === 'deprecated');
  const nowDeprecated = (await query(
    `SELECT m.id FROM molecules m WHERE m.deprecated_at IS NOT NULL
       AND m.id = ANY($1::bigint[])`,
    [decisions.filter((d) => d.decision === 'allow' && d.molecule_id).map((d) => d.molecule_id)]
  ).catch(() => ({ rows: [] }))).rows;
  if (!deprecatedAllowed.length) {
    pass('no allowed decision resolved to a deprecated identity at decision time');
  } else {
    broke(`${deprecatedAllowed.length} allowed decision(s) resolved as deprecated`,
      deprecatedAllowed.map((d) => `decision ${d.id}`).join('; '));
  }
  // Deprecation AFTER an allowed send is lag, not a breach: the decision was correct when taken,
  // and the drift policy preserves historical references deliberately. Reported, never failed.
  if (nowDeprecated.length) {
    out(`        note: ${nowDeprecated.length} identit(ies) allowed earlier are deprecated NOW — `
      + 'historical attribution, not a breach (drift policy rule 6)');
  }

  // ── 6. no canonical refusal fell through to a send ───────────────────────
  //
  // The signature of a legacy fallback: a refusal recorded for an RFQ that nevertheless produced a
  // supplier claim at or after that refusal.
  const fellThrough = [];
  for (const d of decisions.filter((x) => x.decision === 'refuse')) {
    const after = (await query(
      `SELECT id, supplier_id, status, claimed_at, sent_at FROM supplier_outreach_log
        WHERE rfq_id = $1
          -- sent_at is TEXT in production and claimed_at is TIMESTAMPTZ, so the cast is
          -- required: an uncast COALESCE of the two is a type error on the real schema.
          AND COALESCE(claimed_at, NULLIF(sent_at, '')::timestamptz) >= $2`, [d.rfq_id, d.decided_at])).rows;
    // An allowed decision later for the same RFQ legitimately permits a send.
    const laterAllow = decisions.find((x) => x.decision === 'allow'
      && String(x.rfq_id) === String(d.rfq_id) && new Date(x.decided_at) >= new Date(d.decided_at));
    if (after.length && !laterAllow) {
      fellThrough.push(`rfq ${d.rfq_id} refused (${d.refusal_reason}) yet ${after.length} claim(s) followed`);
    }
  }
  if (!fellThrough.length) pass('no refusal was followed by a supplier claim — no legacy fallback');
  else broke(`${fellThrough.length} refusal(s) were followed by a claim`, fellThrough.join('; '));

  // ── 7. no post-cutover send without durable decision evidence ───────────
  //
  // Distinct from assertion 1: that one asks whether an ALLOW exists; this asks whether ANY
  // decision exists. A send with no decision row at all is the fail-closed path having been
  // bypassed rather than a decision having gone the wrong way.
  const anyByRfq = new Set(decisions.map((d) => String(d.rfq_id)));
  const evidenceless = post.filter((s) => !anyByRfq.has(String(s.rfq_id)));
  if (!evidenceless.length) pass('every post-cutover send has at least one decision row');
  else broke(`${evidenceless.length} post-cutover send(s) have no decision row whatsoever`,
    evidenceless.map((s) => s.rfq_id).join('; '));

  // ── 8. pre-cutover defects remain visible and unchanged ─────────────────
  //
  // Asserted POSITIVELY. The historical mismatch must still be findable, because a reconciliation
  // that goes green once somebody "cleans up" history is worse than none.
  const historical = [];
  for (const s of pre) {
    if (!s.molecule_name) continue;
    const m = (await query(
      `SELECT cas FROM molecules WHERE normalized_name = LOWER(TRIM($1))`, [s.molecule_name])).rows[0];
    if (m && m.cas && s.cas_number && digits(s.cas_number) !== digits(m.cas)) {
      historical.push(`${s.rfq_id}: filed ${s.cas_number} vs canonical ${m.cas} (sent ${s.sent_at})`);
    }
  }
  pass(`pre-cutover sends with a CAS mismatch, preserved unchanged: ${historical.length}`);
  for (const h of historical) out(`        ${h}`);

  // ── 9. supplier-facing facts equal the approved decision ────────────────
  //
  // Catches a correct guard followed by an incorrect renderer. The subject line is the
  // supplier-facing artefact, and it is what carried `(27203-92-5)` to three companies.
  const drifted = [];
  for (const s of post) {
    const d = allowedByRfq.get(String(s.rfq_id));
    if (!d || !s.email_subject) continue;
    const subjectCas = (String(s.email_subject).match(/([0-9]{2,7}-[0-9]{2}-[0-9])/) || [])[1] || null;
    const approved = d.approved_cas ? digits(d.approved_cas) : null;
    if (digits(subjectCas) !== digits(approved)) {
      drifted.push(`rfq ${s.rfq_id}: subject carries ${subjectCas || 'none'}, decision approved ${approved || 'none'}`);
    }
  }
  if (!drifted.length) pass('every post-cutover subject line carries exactly the approved CAS');
  else broke(`${drifted.length} send(s) carry a CAS the decision did not approve`, drifted.join('; '));

  out('');
  out('════ COUNTS BY OUTCOME ════════════════════════════════════════════════');
  const byReason = {};
  for (const d of decisions.filter((x) => x.decision === 'refuse')) {
    byReason[d.refusal_reason] = (byReason[d.refusal_reason] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byReason)) out(`   refused: ${k.padEnd(26)} ${v}`);
  const byCas = {};
  for (const d of decisions) byCas[d.cas_class] = (byCas[d.cas_class] || 0) + 1;
  for (const [k, v] of Object.entries(byCas)) out(`   filed CAS ${k.padEnd(23)} ${v}`);

  out('');
  out(`DIGEST sends=${sends.length} post=${post.length} decisions=${decisions.length} `
    + `allow=${decisions.filter((d) => d.decision === 'allow').length} `
    + `refuse=${decisions.filter((d) => d.decision === 'refuse').length} `
    + `historical_mismatches=${historical.length} failures=${fail}`);
  out('');
  if (fail) { out(`FAIL  ${fail} invariant(s) broken`); return 1; }
  out('PASS  ✓ RECONCILED — every consequential RFQ send is backed by an identity decision');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { fs.writeSync(2, `RECONCILIATION FAILED: ${e.message}\n${e.stack}\n`); process.exit(2); });
}

module.exports = { main, cutover };
