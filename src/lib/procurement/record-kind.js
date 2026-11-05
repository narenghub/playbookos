'use strict';
// ── SIX KINDS OF RECORD, AND ONLY ONE OF THEM IS A CONTRACT YOU CAN BID ──────
//
// Pure. No database, no network.
//
// ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
//
// PRPA ingests from sources whose records look alike in a list and mean entirely different things.
// Flattening them is not a cosmetic error: it manufactures a pipeline. The Grants.gov probe already
// showed the shape of it — 9 of the first 30 live records were FORECASTS, and a forecast rendered
// as a live opportunity is 30% of a dashboard that does not exist.
//
// The costliest confusion is not the forecast, though. It is SOURCES SOUGHT.
//
//   A sources-sought notice (and an RFI) is MARKET RESEARCH. The government is asking who exists.
//   There is no award, no price to win, and no bid to submit. Responding is often valuable — it is
//   how a NAICS code and a small-business set-aside get shaped before the solicitation is written —
//   but a response is a CAPABILITY STATEMENT, not an offer.
//
//   Treat it as biddable and the agent produces a priced bid against something that cannot be won,
//   consuming a supplier quote and an approval to do it. It also looks, from the outside, like a
//   company that does not know how federal procurement works.
//
// So biddability is not a property any caller may assert. It is derived here, from the record kind
// plus the facts that kind requires, and the funding/procurement separation is kept as well:
// a grant is never procurement revenue (ruling), and a historical award is not an opportunity at
// all — it is evidence about a buyer.

// ── the taxonomy ────────────────────────────────────────────────────────────

const RECORD_KINDS = Object.freeze({
  // A real solicitation: RFP, RFQ, IFB, a combined synopsis/solicitation. An offer is expected.
  solicitation: {
    source: 'sam.gov',
    biddable: true,
    responseArtifact: 'priced offer',
    revenueChannel: 'procurement',
    note: 'the only kind from which a priced bid may be produced',
  },
  // Market research. A response is a capability statement.
  sources_sought: {
    source: 'sam.gov',
    biddable: false,
    responseArtifact: 'capability statement (no price)',
    revenueChannel: 'none',
    note: 'the government is asking who exists. There is no award and nothing to win. A priced bid '
        + 'here spends a supplier quote and an approval on an impossibility.',
  },
  // Same as above in substance; kept distinct because the notice types are distinct on SAM.gov and
  // collapsing them would lose the ability to report on either.
  rfi: {
    source: 'sam.gov',
    biddable: false,
    responseArtifact: 'information response (no price)',
    revenueChannel: 'none',
    note: 'request for information — market research, not a solicitation',
  },
  // Grants.gov. Separate pipeline by ruling.
  grant_opportunity: {
    source: 'grants.gov',
    biddable: false,
    responseArtifact: 'grant application',
    revenueChannel: 'grant',
    note: 'an application, not an offer, and never procurement revenue — including when '
        + 'fundingInstrument is "Procurement Contract"',
  },
  // A plan. No deadline, nothing to respond to yet.
  forecast: {
    source: 'grants.gov | sam.gov',
    biddable: false,
    responseArtifact: 'none — watch and wait',
    revenueChannel: 'none',
    note: 'a stated intention to fund or buy. 9 of the first 30 live Grants.gov records were these.',
  },
  // NIH RePORTER / ClinicalTrials.gov / Europe PMC derived. A buyer who may need something.
  research_lead: {
    source: 'nih reporter | clinicaltrials.gov | europe pmc',
    biddable: false,
    responseArtifact: 'approved outreach (gated)',
    revenueChannel: 'direct_sales',
    note: 'AI-derived demand. The brief is explicit: this "must not be presented as a confirmed '
        + 'buyer requirement". It is a lead, and outreach is behind the email HOLD.',
  },
  // USAspending. Already awarded, to somebody else.
  historical_award: {
    source: 'usaspending',
    biddable: false,
    responseArtifact: 'none',
    revenueChannel: 'none',
    note: 'already awarded. It is evidence about what an agency buys and who from — never an '
        + 'opportunity, and its obligated amounts are not anybody\'s pipeline.',
  },
});

const KIND_NAMES = Object.freeze(Object.keys(RECORD_KINDS));
const BIDDABLE_KINDS = Object.freeze(KIND_NAMES.filter((k) => RECORD_KINDS[k].biddable));

// ── classification from a SAM.gov notice type ───────────────────────────────
//
// SAM.gov's own vocabulary, lower-cased. Deliberately NOT a fuzzy match: an unrecognised notice
// type returns null and the caller must treat that as unknown rather than defaulting. A default of
// `solicitation` would make every new notice type biddable, which is the failure mode in the
// expensive direction.
const SAM_NOTICE_TYPES = Object.freeze({
  'solicitation': 'solicitation',
  'combined synopsis/solicitation': 'solicitation',
  'presolicitation': 'forecast',
  'sources sought': 'sources_sought',
  'special notice': 'rfi',
  'request for information': 'rfi',
  'rfi': 'rfi',
  'intent to bundle requirements (dod- funded)': 'rfi',
  'award notice': 'historical_award',
  'justification and approval (j&a)': 'historical_award',
  'fair opportunity / limited sources justification': 'historical_award',
  'sale of surplus property': 'rfi',
  'foreign government standard': 'rfi',
});

/**
 * Classify a SAM.gov notice type string. Returns null when unrecognised — never a default.
 */
function kindFromSamNoticeType(noticeType) {
  if (noticeType == null) return null;
  const k = String(noticeType).trim().toLowerCase();
  if (!k) return null;
  return SAM_NOTICE_TYPES[k] || null;
}

/**
 * Classify a Grants.gov record from the two fields that decide it, both measured live.
 * docType is 'synopsis' | 'forecast'; oppStatus is 'posted' | 'forecasted' | 'closed' | 'archived'.
 */
function kindFromGrantsGov({ docType, oppStatus } = {}) {
  const dt = String(docType || '').toLowerCase();
  const st = String(oppStatus || '').toLowerCase();
  if (dt === 'forecast' || st === 'forecasted') return 'forecast';
  if (dt === 'synopsis') return 'grant_opportunity';
  return null;
}

/**
 * Is this record biddable, and if not, why not?
 *
 * Biddability requires BOTH a biddable kind AND the facts that kind needs. A solicitation with no
 * response deadline is not biddable: either the deadline passed and was not recorded, or it was
 * never published — and in neither case may something be submitted against it.
 *
 * Returns { biddable, reason, kind } and never throws, so a caller cannot route around it with a
 * try/catch.
 */
function biddability(record = {}) {
  const kind = record.recordKind || null;
  if (!kind) {
    return { biddable: false, kind: null, reason: 'record kind is unknown; an unclassified record is never biddable' };
  }
  const spec = RECORD_KINDS[kind];
  if (!spec) {
    return { biddable: false, kind, reason: `"${kind}" is not a known record kind` };
  }
  if (!spec.biddable) {
    return {
      biddable: false,
      kind,
      reason: `a ${kind.replace(/_/g, ' ')} is not biddable — the expected response is a `
        + `${spec.responseArtifact}. ${spec.note}`,
    };
  }
  if (!record.responseDeadline) {
    return {
      biddable: false,
      kind,
      reason: 'a solicitation with no recorded response deadline is not biddable: the deadline was '
        + 'either never published or not captured, and neither permits a submission',
    };
  }
  return { biddable: true, kind, reason: `${kind} with a recorded response deadline` };
}

/**
 * Which revenue channel may this record's value ever be counted in?
 * 'none' means it has no place in any pipeline total.
 */
function revenueChannel(kind) {
  const spec = RECORD_KINDS[kind];
  return spec ? spec.revenueChannel : 'none';
}

module.exports = {
  RECORD_KINDS,
  KIND_NAMES,
  BIDDABLE_KINDS,
  SAM_NOTICE_TYPES,
  kindFromSamNoticeType,
  kindFromGrantsGov,
  biddability,
  revenueChannel,
};
