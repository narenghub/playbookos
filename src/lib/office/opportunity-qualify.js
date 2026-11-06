// ── DOES ABIOZEN QUALIFY FOR THIS OPPORTUNITY? ───────────────────────────────
//
// Ruling 21 priority 2. Match an opportunity against Abiozen's VERIFIED capabilities, and
// "clearly distinguish verified capabilities from catalog listings, supplier relationships, and
// predictions. Do not mark Abiozen qualified without sufficient supporting evidence."
//
// Three verdicts: QUALIFIED, NOT_QUALIFIED, NEEDS_REVIEW. Every one carries reasons. QUALIFIED
// additionally carries the capability ids it relied on, and the database refuses a QUALIFIED
// assessment with an empty evidence array — so the claim cannot be made without naming its basis.
//
// ── THE THREE THINGS THIS ENGINE WILL NOT DO ─────────────────────────────────
//
// 1. It will not treat an INDICATIVE capability as sufficient. A catalog listing says we have
//    advertised a molecule, not that we hold it. A supplier relationship says somebody has
//    supplied us before, not that they will again at this quantity by this date. A synthesis
//    prediction is a model's opinion. Each of those produces NEEDS_REVIEW with the missing
//    evidence named — never QUALIFIED.
//
// 2. It will not infer a capability from a NAICS code. A NAICS match says the procurement is in
//    our industry; it is a RELEVANCE signal, not evidence. The code decides which business line
//    to look under; the capability registry decides whether we can do it.
//
// 3. It will not authorize a bid. The verdict is an input to a human decision and the schema has
//    no column that could be mistaken for authorization. Committing the company happens in
//    fulfillment_authorizations, which has its own trigger requiring a real, active, admin-tier
//    user. A QUALIFIED verdict on fifty opportunities authorizes nothing.
//
// ── THE DISQUALIFICATION THAT IS NOT PERMANENT ───────────────────────────────
//
// Ruling 15 item 9: "Do not treat an unrenewed future expiration as permanently disqualifying an
// opportunity that could become eligible after renewal." Abiozen's SAM.gov registration expires
// 2026-12-30. An opportunity whose deadline falls after that is NOT disqualified — it is
// NEEDS_REVIEW with "registration must be renewed first" as the named gap, because renewing is a
// business action and the opportunity becomes eligible the moment it happens.
'use strict';

const { INDICATIVE_CLASSES, SUFFICIENT_CLASSES } = require('./intake-schema');
const { BIDDABLE_NOTICE_TYPES } = require('./opportunity-schema');

// Dates are coerced through one shared helper — see src/lib/office/iso-day.js for why the naive
// String(date).slice(0, 10) is wrong and what it cost here twice.
const { isoDay } = require('./iso-day');

// Abiozen's SAM.gov entity registration expiry, from the federal-contracting record. A date, not a
// guess: if it is wrong, the fix is the record, not this constant.
const SAM_REGISTRATION_EXPIRES = '2026-12-30';

// NAICS → business line. RELEVANCE ONLY. Membership here means "look under this line for
// evidence", never "we can do this".
const NAICS_LINES = Object.freeze({
  325199: ['molecule_commerce', 'custom_synthesis'],   // other basic organic chemical mfg
  325411: ['molecule_commerce', 'custom_synthesis'],   // medicinal and botanical mfg
  325412: ['molecule_commerce', 'custom_synthesis'],   // pharmaceutical preparation mfg
  325413: ['molecule_commerce', 'analytical_services'],// in-vitro diagnostic substance mfg
  325414: ['molecule_commerce'],                       // biological product mfg
  325998: ['molecule_commerce'],                       // all other misc chemical products
  424210: ['scientific_fulfillment'],                  // drugs and druggists' sundries wholesalers
  423450: ['scientific_fulfillment'],                  // medical/lab equipment wholesalers
  541380: ['analytical_services'],                     // testing laboratories
  541713: ['custom_synthesis', 'analytical_services'], // R&D in nanotechnology
  541714: ['analytical_services', 'custom_synthesis'], // R&D in biotechnology
  541715: ['analytical_services', 'custom_synthesis'], // R&D in physical/engineering/life sciences
  541990: ['analytical_services'],                     // other professional/scientific services
});

// PSC → business line. Same caveat.
const PSC_LINES = Object.freeze({
  6505: ['molecule_commerce', 'scientific_fulfillment'], // drugs and biologicals
  6506: ['molecule_commerce'],
  6508: ['molecule_commerce'],
  6509: ['molecule_commerce'],
  6510: ['scientific_fulfillment'],                      // surgical dressings
  6550: ['molecule_commerce', 'analytical_services'],    // in-vitro diagnostic substances
  6640: ['analytical_services', 'scientific_fulfillment'], // laboratory equipment and supplies
  6810: ['molecule_commerce'],                           // chemicals
  6820: ['molecule_commerce'],                           // dyes
  6830: ['molecule_commerce'],                           // gases
  6850: ['molecule_commerce'],                           // misc chemical specialties
  8730: ['molecule_commerce'],                           // chemicals (older code)
});

// Keyword fallback, used only when there is no NAICS or PSC. Weakest signal, and labelled as such
// in the reasons so a reviewer knows the line was inferred from prose.
const KEYWORD_LINES = [
  [/\b(custom synth|synthes|route scouting|scale[- ]up|cGMP intermediate)/i, 'custom_synthesis'],
  [/\b(assay|HPLC|LC-MS|GC-MS|method validat|stability stud|bioanalytic|analytical testing|CRO)\b/i, 'analytical_services'],
  [/\b(reference standard|research chemical|API|active pharmaceutical ingredient|reagent|molecule|compound library)\b/i, 'molecule_commerce'],
  [/\b(laboratory suppl|consumable|distribut|fulfil|warehous)/i, 'scientific_fulfillment'],
];

// Set-aside types that require a certification Abiozen would have to hold. If the opportunity is
// reserved and the certification is absent from the registry, we are not eligible — and that is a
// hard NOT_QUALIFIED, because unlike a registration it cannot be fixed before the deadline.
const SET_ASIDE_CERTS = [
  [/8\s*\(?a\)?/i, '8(a) Business Development program certification'],
  [/hubzone/i, 'HUBZone certification'],
  [/sdvosb|service[- ]disabled/i, 'Service-Disabled Veteran-Owned Small Business certification'],
  [/\bvosb\b|veteran[- ]owned/i, 'Veteran-Owned Small Business certification'],
  [/wosb|women[- ]owned/i, 'Women-Owned Small Business certification'],
  [/edwosb|economically disadvantaged/i, 'Economically Disadvantaged WOSB certification'],
  [/\bain\b|indian (economic )?enterprise|buy indian/i, 'Indian Economic Enterprise status'],
];

/** Which business lines this opportunity plausibly falls under, and how we decided. */
function relevantLines(opp) {
  const lines = new Set();
  const basis = [];
  if (opp.naics_code && NAICS_LINES[Number(opp.naics_code)]) {
    for (const l of NAICS_LINES[Number(opp.naics_code)]) lines.add(l);
    basis.push(`NAICS ${opp.naics_code} maps to ${NAICS_LINES[Number(opp.naics_code)].join(', ')}`);
  }
  if (opp.psc_code && PSC_LINES[Number(opp.psc_code)]) {
    for (const l of PSC_LINES[Number(opp.psc_code)]) lines.add(l);
    basis.push(`PSC ${opp.psc_code} maps to ${PSC_LINES[Number(opp.psc_code)].join(', ')}`);
  }
  if (!lines.size) {
    const hay = `${opp.title || ''} ${opp.description || ''}`;
    for (const [re, line] of KEYWORD_LINES) {
      if (re.test(hay)) { lines.add(line); basis.push(`title/description matched ${line} by keyword — WEAKEST signal, no NAICS or PSC was given`); }
    }
  }
  return { lines: [...lines], basis };
}

/**
 * Assess one opportunity.
 *
 * @param {object} opp              a normalized opportunity record
 * @param {Array}  capabilities     rows from verified_capabilities: {id, kind, evidence_class, business_line, name, valid_until}
 * @param {object} [opts]           { today, samRegistrationExpires, registrationRenewed }
 * @returns {{verdict, business_lines, reasons, missing_requirements, evidence_capability_ids}}
 */
function assess(opp, capabilities, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const samExpiry = opts.samRegistrationExpires || SAM_REGISTRATION_EXPIRES;
  const renewed = !!opts.registrationRenewed;

  const reasons = [];
  const missing = [];
  const evidence = [];
  let needsReview = false;

  // ── 1. is this even a thing to bid on? ────────────────────────────────────
  if (!BIDDABLE_NOTICE_TYPES.includes(opp.notice_type)) {
    const label = {
      award: 'this is an AWARD notice — the contract is already decided',
      sources_sought: 'this is a SOURCES SOUGHT notice — a reply is market research, not a bid',
      presolicitation: 'this is a PRESOLICITATION — not yet biddable, worth watching',
      special_notice: 'this is a SPECIAL NOTICE — informational',
      justification: 'this is a sole-source JUSTIFICATION — the award is pre-decided',
      intent_to_bundle: 'this is an INTENT TO BUNDLE notice',
      unknown: 'the source did not say what kind of notice this is, and it was not inferred',
    }[opp.notice_type] || `notice type is ${opp.notice_type}`;
    // 'unknown' is reviewable; the rest are decided facts about the notice.
    if (opp.notice_type === 'unknown' || opp.notice_type === 'presolicitation') {
      return {
        verdict: 'NEEDS_REVIEW', business_lines: [], reasons: [label],
        missing_requirements: ['a confirmed notice type from the source record'],
        evidence_capability_ids: [],
      };
    }
    return {
      verdict: 'NOT_QUALIFIED', business_lines: [], reasons: [label],
      missing_requirements: [], evidence_capability_ids: [],
    };
  }

  // ── 2. has the deadline already passed? ───────────────────────────────────
  const deadlineDay = isoDay(opp.response_deadline);
  if (opp.response_deadline && deadlineDay) {
    const dl = deadlineDay;
    if (dl < today) {
      return {
        verdict: 'NOT_QUALIFIED', business_lines: [],
        reasons: [`the response deadline (${dl}) has passed`],
        missing_requirements: [], evidence_capability_ids: [],
      };
    }
  } else {
    needsReview = true;
    reasons.push('no response deadline could be read from the source');
    missing.push('a response deadline, confirmed against the original notice');
  }
  if (opp.response_deadline && !opp.deadline_confirmed_at) {
    needsReview = true;
    reasons.push('the deadline has not been confirmed by a person against the original notice');
    missing.push('human confirmation of the response deadline');
  }

  // ── 3. set-aside eligibility ──────────────────────────────────────────────
  // A reserved procurement needs a certification. Unlike a lapsed registration this cannot be
  // fixed before a deadline, so a missing certification is a hard no rather than a review.
  if (opp.set_aside) {
    for (const [re, certName] of SET_ASIDE_CERTS) {
      if (!re.test(opp.set_aside)) continue;
      const held = capabilities.find((c) => (c.kind === 'certification' || c.kind === 'accreditation')
        && new RegExp(certName.split(' ')[0], 'i').test(c.name || '')
        && SUFFICIENT_CLASSES.includes(c.evidence_class));
      if (held) { evidence.push(held.id); reasons.push(`set-aside "${opp.set_aside}" is met by ${held.name}`); }
      else {
        return {
          verdict: 'NOT_QUALIFIED', business_lines: [],
          reasons: [`reserved under set-aside "${opp.set_aside}", and no verified ${certName} is on record`],
          missing_requirements: [certName],
          evidence_capability_ids: [],
        };
      }
    }
  }

  // ── 4. which of Abiozen's lines could serve this? ─────────────────────────
  const { lines, basis } = relevantLines(opp);
  reasons.push(...basis);
  if (!lines.length) {
    return {
      verdict: 'NOT_QUALIFIED', business_lines: [],
      reasons: ['no NAICS, PSC or description signal places this inside any Abiozen business line'],
      missing_requirements: [], evidence_capability_ids: [],
    };
  }

  // ── 5. the actual question: is there SUFFICIENT evidence under those lines? ─
  const servedLines = [];
  for (const line of lines) {
    const forLine = capabilities.filter((c) => !c.business_line || c.business_line === line);
    // The live table's column is `valid_to`; v4 and the fixtures use `valid_until`. Accept either
    // rather than silently reading undefined, which would make an expired capability look current.
    const validTo = (c) => c.valid_to || c.valid_until || null;
    // An UNCLASSIFIED capability is not sufficient. verified_capabilities carried no evidence_class
    // until v4 added one, so a null here means "nobody has judged how strongly this is evidenced"
    // — which must read as not-sufficient, never as sufficient-by-default.
    const sufficient = forLine.filter((c) => SUFFICIENT_CLASSES.includes(c.evidence_class)
      && (!validTo(c) || (isoDay(validTo(c)) || '9999-12-31') >= today));
    const indicative = forLine.filter((c) => INDICATIVE_CLASSES.includes(c.evidence_class));
    const expired = forLine.filter((c) => SUFFICIENT_CLASSES.includes(c.evidence_class)
      && validTo(c) && (isoDay(validTo(c)) || '9999-12-31') < today);

    if (sufficient.length) {
      servedLines.push(line);
      for (const c of sufficient) evidence.push(c.id);
      reasons.push(`${line}: ${sufficient.length} verified capabilit${sufficient.length === 1 ? 'y' : 'ies'} `
        + `(${sufficient.map((c) => `${c.name || c.id} [${c.evidence_class}]`).join('; ')})`);
    } else if (expired.length) {
      needsReview = true;
      reasons.push(`${line}: the only sufficient evidence has EXPIRED `
        + `(${expired.map((c) => `${c.name || c.id} valid until ${isoDay(validTo(c))}`).join('; ')})`);
      missing.push(`${line}: renewed evidence — the record exists but is out of date`);
    } else if (forLine.some((c) => !c.evidence_class)) {
      needsReview = true;
      const un = forLine.filter((c) => !c.evidence_class);
      reasons.push(`${line}: ${un.length} capabilit${un.length === 1 ? 'y has' : 'ies have'} no evidence class `
        + `(${un.map((c) => c.name || c.id).join('; ')}). Unclassified is not sufficient — nobody has `
        + 'judged how strongly these are evidenced.');
      missing.push(`${line}: an evidence class on ${un.map((c) => c.name || c.id).join('; ')}`);
    } else if (indicative.length) {
      needsReview = true;
      reasons.push(`${line}: only INDICATIVE evidence exists `
        + `(${indicative.map((c) => `${c.name || c.id} [${c.evidence_class}]`).join('; ')}). `
        + 'A catalog listing, a supplier relationship and a synthesis prediction are each a reason '
        + 'to look, not a reason to commit.');
      missing.push(`${line}: sufficient evidence — one of ${SUFFICIENT_CLASSES.join(', ')}`);
    } else {
      reasons.push(`${line}: no capability of any class is on record`);
      missing.push(`${line}: any verified capability at all`);
    }
  }

  // ── 6. the registration, which is a renewable gap and not a disqualification ─
  if (deadlineDay) {
    const dl = deadlineDay;
    if (dl > samExpiry && !renewed) {
      needsReview = true;
      reasons.push(`the response deadline (${dl}) falls after the SAM.gov registration expiry `
        + `(${samExpiry}). This is NOT a disqualification — the opportunity becomes eligible as `
        + 'soon as the registration is renewed.');
      missing.push(`SAM.gov entity registration renewed beyond ${dl}`);
    }
  }

  // ── 7. the verdict ────────────────────────────────────────────────────────
  if (!servedLines.length) {
    return {
      verdict: 'NEEDS_REVIEW', business_lines: lines, reasons,
      missing_requirements: missing.length ? missing : ['sufficient verified evidence under at least one business line'],
      evidence_capability_ids: [],
    };
  }
  if (needsReview || missing.length) {
    return { verdict: 'NEEDS_REVIEW', business_lines: servedLines, reasons, missing_requirements: missing, evidence_capability_ids: [...new Set(evidence)] };
  }
  return { verdict: 'QUALIFIED', business_lines: servedLines, reasons, missing_requirements: [], evidence_capability_ids: [...new Set(evidence)] };
}

module.exports = {
  isoDay,
  SAM_REGISTRATION_EXPIRES,
  NAICS_LINES,
  PSC_LINES,
  KEYWORD_LINES,
  SET_ASIDE_CERTS,
  relevantLines,
  assess,
};
