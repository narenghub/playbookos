// ── NO SUPPLIER RFQ SENDS A CAS THE CANONICAL IDENTITY DOES NOT SUPPORT ─────
//
// Interim send-time guard, authorised 31 Oct 2026. The invariant:
//
//   > No consequential supplier RFQ may send a CAS unless the canonical identity supports that CAS
//   > for the exact substance and form being requested.
//
// ── THE INCIDENT THIS EXISTS FOR ────────────────────────────────────────────
//
// On 21 July 2026, RFQ d7a05efb reached Laurus Labs, Divi's and Dr Reddy's with the subject
//
//   RFQ — Tramadol Hydrochloride (27203-92-5) — Abiozen LLC
//
// `27203-92-5` is Tramadol. `36282-47-0` is Tramadol Hydrochloride, and is what the canonical
// identity ABZ-Mol-000378 carries from two agreeing study rows. The filed name and the filed number
// named different FORMS, and both numbers pass the CAS checksum — so the quote guard's checksum
// test (commit 9e85b95) would have waved this through.
//
// That is why this is a different control. A checksum answers "could this be a CAS number". It
// cannot answer "does this CAS belong to the substance and form being requested", and that is the
// only question that matters at a supplier boundary.
//
// ── WHY A NEW TABLE, AFTER INSPECTING THE ALTERNATIVES ──────────────────────
//
// Adoption before duplication. Five existing mechanisms were inspected:
//
//   agent_run_events       append-only and exactly the right shape, but `run_id UUID NOT NULL
//                          REFERENCES agent_runs(run_id)`. RFQ dispatch does not run inside an
//                          agent run, and the run ledger is deliberately still a ONE-cron canary
//                          ("wiring 37 jobs before knowing that would defeat it"). Adopting it
//                          means wiring a second consequential job into infrastructure whose own
//                          evaluation is unfinished — a larger change than this guard.
//   agent_activity_log     free-text reasoning/output_summary, created_at TEXT, and no append-only
//                          trigger. A reconciliation cannot assert against prose.
//   supplier_outreach_log  right subject (rfq_id, supplier_id) but its semantics are claim-and-send.
//                          Writing a decision there would conflate "we decided" with "we claimed",
//                          which is the exact distinction gate2-identity-evidence.js relies on to
//                          tell a send from an attempt.
//   molecule_conflicts     append-only and identity-shaped, but it is E1's quarantine evidence
//                          keyed on identity with a constrained `kind`. Send decisions there would
//                          pollute the evidence base Gate 1 closed on.
//   execution_steps        unrelated: project plan steps.
//
// So the TABLE is new and the MECHANISM is adopted: the same append-only trigger pattern as
// lead_outcomes, autonomy_events and agent_run_events. The database refuses the rewrite, so no
// future call path can quietly revise why a supplier was or was not contacted.
//
// ── WHAT THIS GUARD DOES NOT DO ─────────────────────────────────────────────
//
// It decides nothing about chemistry. It calls resolveForNewUse() and compares. It does not
// normalise names, does not consult form-word vocabularies, does not derive a base, and above all
// DOES NOT WALK parent_molecule_id looking for a CAS, an identity, an alias or eligibility. A
// shared parent is the reason Tramadol and Tramadol Hydrochloride look interchangeable and exactly
// the reason they are not.
//
// It also adds no column to rfq_requests. That is Gate 2 schema and is not authorised.
'use strict';

const { resolveForNewUse } = require('../molecules/canonical');
const { validCas } = require('../catalogue/cas');

// Recorded on every decision, so a reconciliation can tell which logic produced a verdict after the
// logic changes. A decision with no version is a decision nobody can interpret later.
const GUARD_VERSION = 'rfq-identity-guard/1';

const DECISIONS = ['allow', 'refuse'];
const CAS_CLASSES = ['absent', 'valid', 'malformed'];
const REFUSAL_REASONS = [
  'identity_unresolved',      // nothing canonical answers to the filed name
  'identity_deprecated',      // the identity exists and may not be used for new work
  'cas_disputed',             // filed CAS is well-formed and disagrees with the canonical CAS
  'decision_not_persisted',   // the evidence could not be written: fail closed
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS rfq_identity_decisions (
     id              BIGSERIAL PRIMARY KEY,
     rfq_id          TEXT NOT NULL,
     decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

     -- what was filed, preserved verbatim as evidence. Never corrected here.
     filed_name      TEXT,
     filed_cas       TEXT,
     cas_class       TEXT NOT NULL CHECK (cas_class IN ('absent','valid','malformed')),

     -- what the canonical authority said
     resolution      TEXT NOT NULL CHECK (resolution IN ('ok','deprecated','not_found')),
     molecule_id     BIGINT,
     molecule_ref    TEXT,
     canonical_cas   TEXT,
     cas_suppressed  TEXT,
     eligible        BOOLEAN NOT NULL,

     -- the verdict, and the supplier-facing facts it approves
     decision        TEXT NOT NULL CHECK (decision IN ('allow','refuse')),
     refusal_reason  TEXT,
     approved_name   TEXT,
     approved_cas    TEXT,
     guard_version   TEXT NOT NULL,

     CONSTRAINT rfq_identity_decisions_refusal_shape CHECK (
       (decision = 'refuse' AND refusal_reason IS NOT NULL AND approved_cas IS NULL)
       OR (decision = 'allow' AND refusal_reason IS NULL)
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rfq_identity_decisions_rfq
     ON rfq_identity_decisions (rfq_id, decided_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rfq_identity_decisions_allowed
     ON rfq_identity_decisions (rfq_id) WHERE decision = 'allow'`,

  // ── APPEND-ONLY EVIDENCE ─────────────────────────────────────────────────
  // The same mechanism as lead_outcomes, autonomy_events and agent_run_events. Why a supplier was
  // or was not contacted is a commercial fact; the database refuses to let it be rewritten.
  `CREATE OR REPLACE FUNCTION rfq_identity_decisions_append_only() RETURNS trigger AS $fn$
     BEGIN
       RAISE EXCEPTION 'rfq_identity_decisions is append-only: a send decision may not be altered or deleted';
     END; $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_rfq_identity_decisions_append_only ON rfq_identity_decisions`,
  `CREATE TRIGGER trg_rfq_identity_decisions_append_only
     BEFORE UPDATE OR DELETE ON rfq_identity_decisions
     FOR EACH ROW EXECUTE FUNCTION rfq_identity_decisions_append_only()`,
];

async function migrate(query) {
  for (const stmt of DDL) await query(stmt);
  return { table: 'rfq_identity_decisions', appendOnly: true };
}

/** Digits only, so `27203-92-5` and ` 27203-92-5 ` compare equal and formatting is not a dispute. */
function digits(cas) {
  return String(cas === null || cas === undefined ? '' : cas).replace(/[^0-9-]/g, '').trim();
}

/**
 * absent | valid | malformed — the three states a filed CAS can be in.
 *
 * `malformed` is NOT a weaker form of `valid`. A checksum-invalid string cannot be a registry
 * number, so there is nothing for it to agree or disagree with; it is discarded as evidence. A
 * checksum-VALID value that disagrees is a possible substance or form disagreement, which is the
 * harder and more dangerous case.
 */
function classifyFiledCas(filed) {
  const v = digits(filed);
  if (!v) return 'absent';
  return validCas(v) ? 'valid' : 'malformed';
}

/**
 * The decision. Reads; writes nothing.
 *
 * @param q    query function, injectable so this is testable and transaction-safe
 * @param rfq  the rfq_requests row — molecule_name and cas_number are read, nothing else
 */
async function decide(q, rfq) {
  const filedName = rfq && rfq.molecule_name !== undefined ? rfq.molecule_name : null;
  const filedCas = rfq && rfq.cas_number !== undefined ? rfq.cas_number : null;
  const casClass = classifyFiledCas(filedCas);

  const base = {
    rfq_id: rfq ? rfq.id : null,
    filed_name: filedName,
    filed_cas: filedCas === undefined ? null : filedCas,
    cas_class: casClass,
    guard_version: GUARD_VERSION,
    molecule_id: null,
    molecule_ref: null,
    canonical_cas: null,
    cas_suppressed: null,
    approved_name: null,
    approved_cas: null,
  };

  const r = await resolveForNewUse(q, filedName);

  // ── unresolved: refuse. No fallback to the filed name or the filed CAS. ──
  if (r.status === 'not_found') {
    return { ...base, resolution: 'not_found', eligible: false,
      decision: 'refuse', refusal_reason: 'identity_unresolved' };
  }

  // ── deprecated: refuse. Amendment 2 of the drift policy. ────────────────
  if (r.status === 'deprecated') {
    return { ...base,
      resolution: 'deprecated', eligible: false,
      molecule_id: r.molecule.id, molecule_ref: r.molecule.molecule_ref,
      canonical_cas: r.molecule.cas || null,
      cas_suppressed: r.molecule.cas_suppressed_reason || null,
      decision: 'refuse', refusal_reason: 'identity_deprecated' };
  }

  // ── resolved and eligible ───────────────────────────────────────────────
  const m = r.molecule;
  const canonicalCas = digits(m.cas) || null;
  const resolved = { ...base,
    resolution: 'ok', eligible: true,
    molecule_id: m.id, molecule_ref: m.molecule_ref,
    canonical_cas: m.cas || null,
    cas_suppressed: m.cas_suppressed_reason || null };

  // A well-formed filed CAS that disagrees with the canonical one is a possible substance or form
  // disagreement. THIS IS THE TRAMADOL CASE, and no checksum-only path may turn it green.
  if (casClass === 'valid' && canonicalCas && digits(filedCas) !== canonicalCas) {
    return { ...resolved, decision: 'refuse', refusal_reason: 'cas_disputed' };
  }

  // Allowed. The approved CAS is the CANONICAL one or nothing — never the filed value.
  //
  //   agreeing valid filed CAS  -> canonical CAS (identical by the test above)
  //   malformed filed CAS       -> canonical CAS. Not "the malformed value corrected": the filed
  //                               value was discarded as evidence, the identity was established
  //                               independently, and the identity supplies its own CAS.
  //   absent filed CAS          -> canonical CAS if the identity has one
  //   canonical CAS withheld    -> NO CAS. Decision 1 suppressed it because it was contested, so
  //                               sending the filed value would publish exactly what Decision 1
  //                               exists to withhold. The communication simply omits it.
  //
  // `approved_name` is the canonical display name, so the supplier-facing identity is the one the
  // authority approved rather than the string somebody filed.
  return { ...resolved,
    decision: 'allow', refusal_reason: null,
    approved_name: m.preferred_name || filedName,
    approved_cas: m.cas || null };
}

/** Append-only insert. Returns the decision id. Throws if the evidence cannot be written. */
async function persist(q, d) {
  const r = await q(
    `INSERT INTO rfq_identity_decisions
       (rfq_id, filed_name, filed_cas, cas_class, resolution, molecule_id, molecule_ref,
        canonical_cas, cas_suppressed, eligible, decision, refusal_reason, approved_name,
        approved_cas, guard_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, decided_at`,
    [d.rfq_id, d.filed_name, d.filed_cas, d.cas_class, d.resolution, d.molecule_id, d.molecule_ref,
      d.canonical_cas, d.cas_suppressed, d.eligible, d.decision, d.refusal_reason, d.approved_name,
      d.approved_cas, d.guard_version]);
  return r.rows[0];
}

/**
 * The send-time boundary. Decide, persist, then answer.
 *
 * MUST be called before rfqClaim.claim: the claim writes a `pending` row to supplier_outreach_log,
 * so claiming first and refusing after would leave a record of an attempt that policy had already
 * forbidden — and that row is what the evidence tooling reads to decide whether a send happened.
 *
 * FAILS CLOSED. If the decision cannot be persisted there is no durable evidence, and the standing
 * rule is: no durable evidence, no consequential action. `email wasn't sent` is not evidence that a
 * guard ran.
 *
 * @returns {{allow:boolean, reason:string|null, decisionId:number|null, approved:object|null,
 *            decision:object}}
 */
async function guardSend(q, rfq) {
  const d = await decide(q, rfq);
  let saved = null;
  try {
    saved = await persist(q, d);
  } catch (e) {
    return {
      allow: false,
      reason: 'decision_not_persisted',
      persistError: e.message,
      decisionId: null,
      approved: null,
      decision: { ...d, decision: 'refuse', refusal_reason: 'decision_not_persisted' },
    };
  }
  if (d.decision !== 'allow') {
    return { allow: false, reason: d.refusal_reason, decisionId: saved.id, approved: null, decision: d };
  }
  // The approved facts, carrying the decision id. generateRFQEmail REFUSES anything without it, so
  // a renderer cannot quietly go back to the filed RFQ fields after the guard approved the
  // canonical ones.
  return {
    allow: true,
    reason: null,
    decisionId: saved.id,
    approved: {
      __approvedByDecision: saved.id,
      molecule_name: d.approved_name,
      cas_number: d.approved_cas,
    },
    decision: d,
  };
}

module.exports = {
  GUARD_VERSION, DECISIONS, CAS_CLASSES, REFUSAL_REASONS, DDL,
  migrate, classifyFiledCas, digits, decide, persist, guardSend,
};
