// Supplier-selection evidence for one RFQ. PURE + the SQL it reads. NO WRITES ANYWHERE.
//
//   "Select the strongest legitimate remaining supplier from the eligible set, rather than simply
//    the first unused name. Apply the existing supplier-selection evidence and choose the best
//    legitimate match."
//
// This module answers that question and NOTHING ELSE: it reads, shapes and orders evidence. It
// cannot prepare, claim, approve or send, and it holds no reference to anything that can.
//
// ── IT IS A LIBRARY RATHER THAN SCRIPT-LOCAL CODE FOR ONE REASON ───────────
//
// The ordering decides which supplier a real letter goes to. A ranking buried in a script gets
// checked by reading it, and this repository's record on that is poor: a lab query shipped twice
// whose ORDER BY terms were all constant, so it ran alphabetically and led with the wrong sixty
// rows — valid SQL, plausible output, wrong answer. Here the ordering is pure and the SQL is
// exported as text, so check-supplier-evidence-sql.js can execute the statements against a real
// Postgres and assert the ORDER against a population rigged to defeat both the alphabet and the
// platform's own scores.
//
// ── THE EVIDENCE CLASSES, STRONGEST FIRST ──────────────────────────────────
//
//  1. AN ACTIVE TYPE II DMF FOR THE APPROVED MOLECULE, HELD BY THIS SUPPLIER. A Type II DMF is a
//     drug-substance filing, so an active one means this company has told the FDA it makes this
//     API. For an RFQ whose purpose is US supply nothing in the platform's own columns competes.
//  2. GMP certification, when the RFQ requires GMP.
//  3. Demonstrated responsiveness — replies to previous RFQs. Behaviour, not an opinion.
//  4. reliability_score, avg_response_days, total_orders. Defaults until somebody maintains them:
//     a 50 means "nobody has said".
//
// Compared IN THAT ORDER, so a typed default cannot outvote an FDA filing.

const { matchTier, companyCore } = require('../cphi/match-company');
const scope = require('./scope');

// ── ONLY THE SAFE MATCH TIERS COUNT AS EVIDENCE ────────────────────────────
//
// match-company.js's own assessment of the weaker tiers: a `prefix` match is "RIGHT STAND,
// POSSIBLY WRONG ENTITY ... fine for a conversation at the booth, not for a contract", and a
// `token` match is "~50% WRONG". An RFQ is nearer a contract than a conversation.
//
// Weak-tier matches are still RETURNED, labelled, because "there may be a DMF under a name I
// would not accept" is a reason for a human to check — not a reason to act, and not a thing to
// hide either.
const SAFE_TIERS = Object.freeze(['exact', 'core']);

const SQL = Object.freeze({
  rfq: `SELECT id, molecule_name, cas_number, target_quantity, target_purity, gmp_required, status
          FROM rfq_requests WHERE id = $1`,

  suppliers: `SELECT id, name, country, region, contact_email, contact_name, specialties,
                     reliability_score, avg_response_days, gmp_certified, total_orders
                FROM suppliers ORDER BY name`,

  // Consumed pairs for THIS RFQ. Reported rather than filtered silently: "this supplier is gone
  // and here is why" is the useful line, and the reason is now a ruled fact — a (rfq, supplier)
  // pair that holds an outreach row is spent under the current deterministic preparation identity
  // whatever its outcome.
  consumed: `SELECT supplier_id, status, sent_at, claimed_at
               FROM supplier_outreach_log WHERE rfq_id = $1`,

  // Approval-level consumption is READ THROUGH scope.js (rfqApprovalsForEligibility), not with
  // SQL here. office_approvals is a kernel table and the scope-discipline check refused to let
  // this module name it — correctly: that file owns every kernel table name so a predicate cannot
  // be forgotten at a call site. The accessor is deliberately unscoped and documents why.

  // Reply history across ALL RFQs. FILTER rather than SUM(CASE ...) because replied_at IS NULL is
  // the condition, and a CASE over a nullable column is where an off-by-one hides.
  replies: `SELECT supplier_id,
                   COUNT(*)::int                                       AS sent,
                   COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
              FROM supplier_outreach_log
             WHERE sent_at IS NOT NULL
             GROUP BY supplier_id`,

  // Active type II DMFs whose subject matches the APPROVED molecule name — never the filed one,
  // which is exactly what the identity guard exists to distrust.
  //
  // DELIBERATELY COARSE. The holder-to-supplier decision is a TIER decision made in JS and cannot
  // be expressed in SQL, so this narrows and the tiering decides. A miss here costs a real
  // supplier; a surplus row costs one comparison.
  dmf: `SELECT dmf_number, holder, subject, status, dmf_type, submit_date
          FROM dmf_holders
         WHERE status = 'A' AND dmf_type = 'II'
           AND (subject_normalized = ANY($1) OR subject_normalized LIKE ANY($2))`,
});

/** The $1/$2 bindings for SQL.dmf, from the APPROVED molecule name. */
function dmfTerms(approvedName) {
  const n = String(approvedName || '').toLowerCase().trim();
  const terms = [n, companyCore(approvedName)].filter(Boolean);
  const uniq = [...new Set(terms)];
  return [uniq, uniq.map((t) => `%${t}%`)];
}

/** Split a supplier's candidate DMF matches into those safe enough to act on, and the rest. */
function acceptDmf(dmfRows, supplierName) {
  const safe = []; const weak = [];
  for (const r of dmfRows || []) {
    const tier = matchTier(r.holder, supplierName);
    if (!tier) continue;
    (SAFE_TIERS.includes(tier) ? safe : weak).push({ ...r, tier });
  }
  return { safe, weak };
}

/**
 * Shape one evidence row per supplier. Pure.
 *
 * gmpOk is true when the RFQ does not require GMP — an RFQ that does not ask cannot penalise.
 */
function buildEvidence({ rfq, suppliers, consumed = [], replies = [], dmfRows = [], approvals = [] }) {
  const spentBy = new Map((consumed || []).map((c) => [c.supplier_id, c]));
  const replyBy = new Map((replies || []).map((h) => [h.supplier_id, h]));
  // ── ONLY A LIVE OR CONSUMED ATTEMPT MAKES A SUPPLIER INELIGIBLE ─────────
  //
  // A REJECTED attempt no longer blocks: a preparation rejected for a defect in our own code does
  // not spend the business opportunity, which is the whole point of separating a stable (RFQ,
  // supplier) intent from one preparation attempt. Before that separation existed, this listing
  // reported Aurobindo, MSN and nearly Hetero as permanently consumed by defects we had already
  // fixed.
  const blocking = (a) => a.released_at || a.release_claimed_at
    || a.status === 'pending' || a.status === 'approved';
  const apprBy = new Map((approvals || []).filter((a) => a.supplier_id && blocking(a))
    .map((a) => [a.supplier_id, a]));
  const supersededBy = new Map();
  for (const a of approvals || []) {
    if (!a.supplier_id || blocking(a)) continue;
    supersededBy.set(a.supplier_id, (supersededBy.get(a.supplier_id) || 0) + 1);
  }
  const gmpRequired = Number(rfq && rfq.gmp_required) === 1;

  return (suppliers || []).map((s) => {
    const { safe, weak } = acceptDmf(dmfRows, s.name);
    const h = replyBy.get(s.id) || null;
    const spent = spentBy.get(s.id) || null;
    const appr = apprBy.get(s.id) || null;
    return {
      supplier: s,
      spent,
      approval: appr,
      eligible: !spent && !appr && !!s.contact_email,
      ineligibleBecause: spent
        ? `already holds an outreach row for this RFQ (${spent.status}) — consumed under the `
          + 'current deterministic preparation identity'
        : appr
          ? `holds a LIVE approval ${appr.id} for this RFQ (${appr.status}`
            + `${appr.release_claimed_at ? ', claimed for release' : ''}) — supersede or complete it `
            + 'before preparing another attempt for this supplier'
          : (!s.contact_email ? 'no contact_email on the suppliers row' : null),
      supersededAttempts: supersededBy.get(s.id) || 0,
      dmfSafe: safe,
      dmfWeak: weak,
      sent: h ? h.sent : 0,
      replied: h ? h.replied : 0,
      gmpRequired,
      gmpOk: !gmpRequired || Number(s.gmp_certified) === 1,
    };
  });
}

const ORDERING_RULE = Object.freeze([
  'GMP certified, when the RFQ requires GMP',
  'HOW MANY active type II DMFs for the APPROVED molecule, matched at exact or core tier',
  'responsiveness: has replied > never contacted > contacted and never replied, then how often',
  'reliability_score, then avg_response_days, then total_orders, then name',
]);

// The sort key. Lower is better, element by element, so the classes are compared IN ORDER rather
// than summed — a weighted total would let a reliability_score of 95 outvote a missing DMF, which
// is precisely the inversion this ordering exists to prevent.
//
// ── RESPONSIVENESS HAS THREE STATES, NOT TWO ──────────────────────────────
//
// The first version asked only "has it ever replied", which put an untried supplier and one that
// has ignored five RFQs in the SAME class — so the two were tied on every evidence term and the
// NAME TIEBREAK silently decided between them. Its own test caught that, which is the point of
// having rigged one.
//
// A zero denominator is not a zero rate. "0 of 0" is an ABSENCE of evidence; "0 of 5" is NEGATIVE
// evidence, and the two must not rank together:
//
//   0  has replied at least once            positive
//   1  never contacted                      no evidence — neutral
//   2  contacted and never replied          negative evidence
//
// The rate term then only separates suppliers that have a rate at all.
function responsivenessClass(r) {
  if (r.sent > 0 && r.replied > 0) return 0;
  if (r.sent === 0) return 1;
  return 2;
}

// ── DMF EVIDENCE IS COUNTED, NOT A YES/NO ─────────────────────────────────
//
// The first version asked only "does it hold a DMF". On the real Clopidogrel bisulfate population
// that put Hetero Drugs (ONE active type II filing, reliability 84) above MSN Laboratories (FOUR,
// reliability 81): both satisfied the boolean, the class tied, and the decision fell through to
// `reliability_score` — a number nobody has maintained, where every supplier in that list shows 0
// orders and 0 of 0 replies.
//
// So the rule this module states about itself — "a typed default must not outvote an FDA filing" —
// was being violated one level below where it was being checked. Four active drug-substance
// filings for the same molecule is materially stronger evidence than one: it indicates established,
// usually multi-site or multi-route manufacture. The count is the evidence; the score is an
// opinion.
function rankKey(r) {
  const hasHistory = r.sent > 0;
  return [
    r.gmpOk ? 0 : 1,
    -r.dmfSafe.length,
    responsivenessClass(r),
    -(hasHistory ? r.replied / r.sent : 0),
    -(Number(r.supplier.reliability_score) || 0),
    Number(r.supplier.avg_response_days) || 99,
    -(Number(r.supplier.total_orders) || 0),
    String(r.supplier.name || ''),
  ];
}

function compareEvidence(a, b) {
  const A = rankKey(a); const B = rankKey(b);
  for (let i = 0; i < A.length; i += 1) {
    if (A[i] < B[i]) return -1;
    if (A[i] > B[i]) return 1;
  }
  return 0;
}

/** Eligible suppliers, strongest evidence first. Does not mutate its input. */
function rankEvidence(rows) {
  return [...(rows || [])].filter((r) => r.eligible).sort(compareEvidence);
}

/** One line per supplier saying what the evidence actually was. */
function reasonsFor(r, { dmfAvailable = true } = {}) {
  const out = [];
  if (r.gmpRequired) out.push(Number(r.supplier.gmp_certified) === 1 ? 'GMP certified' : 'NOT GMP certified');
  if (!dmfAvailable) out.push('DMF evidence unavailable');
  else if (r.dmfSafe.length) out.push(`${r.dmfSafe.length} active type II DMF(s) for this molecule`);  // the count is the evidence
  else out.push('no accepted DMF for this molecule');
  if (!r.sent) out.push('never contacted before (no responsiveness evidence)');
  else if (!r.replied) out.push(`contacted ${r.sent} time(s) and NEVER replied`);
  else out.push(`replied ${r.replied} of ${r.sent} previous RFQ(s)`);
  out.push(`reliability ${r.supplier.reliability_score}`);
  if (r.supersededAttempts) {
    out.push(`${r.supersededAttempts} superseded preparation attempt(s) — still eligible`);
  }
  return out;
}

/** Approvals that already exist for this RFQ. Delegates to scope.js, which owns the table name. */
function approvalsForRfq(rfqId, deps = {}) {
  return scope.rfqApprovalsForEligibility(rfqId, deps);
}

module.exports = {
  SQL, SAFE_TIERS, ORDERING_RULE, approvalsForRfq,
  dmfTerms, acceptDmf, buildEvidence, responsivenessClass, rankKey, compareEvidence,
  rankEvidence, reasonsFor,
};
