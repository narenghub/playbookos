// ── IS THIS OPPORTUNITY ANYTHING TO DO WITH ABIOZEN? ─────────────────────────
//
// A separate question from opportunity-qualify.js, and asked first.
//
//   RELEVANCE  — is this procurement in our business at all?        (this file)
//   QUALIFICATION — do we hold evidence we can deliver it?          (opportunity-qualify.js)
//
// They were conflated, and the cost was visible: of 149 live solicitations, 69 were R&D for
// defense systems — metal castings, test ranges, ship simulators — every one of them sitting in
// the owner's review queue as NEEDS_REVIEW, indistinguishable from the VA laboratory contract
// that was actually worth bidding. A queue where 7 in 10 items are noise is a queue nobody reads,
// and a board nobody reads is worse than no board.
//
// ── WHY NOT JUST FILTER ON NAICS ─────────────────────────────────────────────
//
// Because NAICS says what kind of company, not what is being bought, and the real data proves it
// both ways:
//
//   541715  R&D in physical/engineering/life sciences — 115 of our 149 records. It holds
//           "2027 NIAID DMID Omnibus BAA" AND "Advanced Metal Castings R&D". One code, two
//           completely different businesses.
//   541380  Testing laboratories — holds "Laboratory Analysis of Water Samples" AND
//           "USNS KAISER Ultrasonic Gauging Hull Special Survey". Also "TDA Isolated Phase Bus
//           and Duct Inspection". A testing-laboratory NAICS on a hull survey.
//
// So NAICS is kept as a weak corroborating signal only. The work is done by PSC — the Product
// Service Code, which describes what the government is buying — corroborated or vetoed by the
// solicitation text, which we already store for 147 of 149 records.
//
// ── WHY PSC ALONE IS NOT ENOUGH EITHER ───────────────────────────────────────
//
// The PSC family is a strong prior, not an answer. Observed, in our own live data:
//
//   H389  "AMS Designated Laboratory Meat Testing Services"        — ours
//   H219  "USNS KAISER Ultrasonic Gauging Hull Special Survey"     — not ours
//
// Same H family (quality control, testing and inspection). One is a laboratory contract and one
// is a diver with a thickness gauge. Only the words separate them. Hence: prior from the PSC
// family, then evidence from the text to confirm, then vetoes for the physical-plant work that
// keeps turning up under laboratory codes.
//
// ── WHAT THIS MODULE WILL NOT DO ─────────────────────────────────────────────
//
// 1. It will not delete or hide anything. NOT_RELEVANT is a stored verdict carrying its reasons,
//    not a silent drop. If this engine is wrong about a contract, the owner can see that it was
//    wrong and why — which is the only way it ever gets fixed.
// 2. It will not claim capability. A high relevance score says "this is our kind of work", never
//    "we can do it". That remains opportunity-qualify.js's question, answered against the
//    verified-capability registry.
// 3. It will not invent a line. Where the signals support no business line, the verdict is
//    NOT_RELEVANT with "no business line could be identified" — not a guess at the nearest one.
'use strict';

const { BUSINESS_LINES } = require('./intake-schema');

// ── THE PRIOR: PSC FAMILY ────────────────────────────────────────────────────
//
// Keyed on the first two characters of the PSC. Every entry below is annotated with a real title
// observed in production on 2026-11-09, so the next person can check the judgement rather than
// trust it. `base` is the starting score out of 100; `lines` are the candidate business lines.
//
// A base of 0 does not disqualify — strong text evidence can still carry a record to MARGINAL.
// What a 0 does is refuse to carry it on the code alone.
const PSC_FAMILY = Object.freeze({
  // ── R&D (A-family). Overwhelmingly defence and engineering. One exception that matters. ──
  AN: { base: 70, lines: ['analytical_services', 'custom_synthesis'],
    note: 'R&D, medical — "2027 NIAID DMID Omnibus BAA", "BARDA DRIVe EZ-BAA", "ARPA-H EHI"' },
  AC: { base: 0, lines: [], note: 'R&D, defense systems — "Advanced Metal Castings R&D"' },
  AG: { base: 0, lines: [], note: 'R&D, building/construction — "Building America SME Support"' },
  AH: { base: 0, lines: [], note: 'R&D, civil works — "ERDC Civil Works Strategic"' },
  AR: { base: 0, lines: [], note: 'R&D, space — "CSO for Space Domain Awareness"' },
  AS: { base: 0, lines: [], note: 'R&D, transport/exploratory — "ITS4US Deployment Accelerator"' },
  // General science: a mixed bag that only the text can resolve. "SBIR FY26 Phase I BAA" may carry
  // biomedical topics; "ARMY APPLICATIONS LABORATORY BAA" does not. Low prior, decided by evidence.
  AJ: { base: 20, lines: ['analytical_services', 'custom_synthesis'],
    note: 'R&D, general science — "SBIR FY26 Phase I BAA" vs "2026 ERDC BAA"' },

  // ── Special studies and analysis (B-family). Laboratory analysis lives here. ──
  B5: { base: 55, lines: ['analytical_services'],
    note: 'studies/analysis — "Sample Analysis, Maurepas cyanotoxin", "Laboratory Analysis of Water Samples"' },

  // ── Medical services (Q-family). The core of the analytical line. ──
  Q3: { base: 85, lines: ['analytical_services'],
    note: 'medical laboratory testing — "New Reference Lab Testing | VISN 15" (the one that qualified)' },
  Q5: { base: 70, lines: ['analytical_services'],
    note: 'medical services — "NWI Offsite Pathology Services"' },

  // ── Quality control, testing and inspection (H-family). Genuinely split; text decides. ──
  H3: { base: 25, lines: ['analytical_services'],
    note: 'test and inspection — "AMS Designated Laboratory Meat Testing" vs "Isolated Phase Bus and Duct Inspection"' },
  H9: { base: 35, lines: ['analytical_services'],
    note: 'other inspection — "Biological Sampling and Analysis, Pharmacy Clean Room"' },
  H2: { base: 0, lines: [], note: 'equipment inspection — "USNS KAISER Ultrasonic Gauging Hull Survey"' },

  // ── Goods. When the government buys the molecule itself. ──
  65: { base: 85, lines: ['molecule_commerce'],
    note: 'drugs, biologicals, in-vitro diagnostics, laboratory supplies' },
  68: { base: 80, lines: ['molecule_commerce'],
    note: 'chemicals, dyes, gases, chemical specialties' },
  87: { base: 60, lines: ['molecule_commerce'], note: 'agricultural chemicals (older coding)' },

  // ── Known-irrelevant service families, named so the reason is specific. ──
  J0: { base: 0, lines: [], note: 'equipment maintenance — "Granite Surface Plate Calibration"' },
  F1: { base: 10, lines: ['analytical_services'],
    note: 'environmental services — "D AND D LABORATORY STEAM & WATER TESTING"' },
  R4: { base: 0, lines: [], note: 'professional services — "Watercraft and Ship Simulator Support"' },
});

// ── CORROBORATION: NAICS ─────────────────────────────────────────────────────
//
// Deliberately small weights. NAICS can nudge a record across a boundary; it can never carry one
// on its own, because 541715 alone would carry 115 of 149 straight into the queue.
const NAICS_BONUS = Object.freeze({
  325411: 20, 325412: 20, 325413: 18, 325414: 15, 325199: 15, 325998: 12,
  621511: 20, 541380: 10, 541714: 12, 541713: 8, 541715: 4, 541940: 8,
  424210: 15, 423450: 10,
});

// ── EVIDENCE: what the solicitation actually says ────────────────────────────
//
// Each pattern carries the line it supports and what it is worth. Weights are small on purpose —
// evidence accumulates, so a genuine laboratory solicitation trips several of these, while a
// passing mention of "analysis" in a shipbuilding notice trips one.
const EVIDENCE = Object.freeze([
  // Analytical / CRO services
  [/\b(clinical|reference|diagnostic|pathology|toxicolog\w*|microbiolog\w*)\s+(lab|laborator)/i, 14, 'analytical_services'],
  [/\b(specimen|sample)\s+(collection|analysis|testing|handling|transport)/i, 12, 'analytical_services'],
  [/\b(assay|bioassay|immunoassay|ELISA|PCR|qPCR|sequencing)\b/i, 12, 'analytical_services'],
  [/\b(HPLC|UPLC|LC-MS|GC-MS|ICP-MS|mass spectrometr\w*|chromatograph\w*)\b/i, 14, 'analytical_services'],
  [/\b(method validation|stability stud\w*|bioanalytical|potency testing|sterility testing)\b/i, 14, 'analytical_services'],
  [/\b(CLIA|CAP[- ]accredited|ISO[\/ ]?IEC 17025|GLP|good laboratory practice)\b/i, 12, 'analytical_services'],
  [/\b(contract research organization|CRO)\b/i, 10, 'analytical_services'],

  // Molecules and chemistry
  [/\b(CAS\s*(no\.?|number|#)?\s*\d{2,7}-\d{2}-\d)\b/i, 18, 'molecule_commerce'],
  [/\b(active pharmaceutical ingredient|\bAPI\b|drug substance|drug product)\b/i, 14, 'molecule_commerce'],
  [/\b(reference standard|certified reference material|analytical standard)\b/i, 14, 'molecule_commerce'],
  [/\b(reagent|compound librar\w*|research chemical|fine chemical|excipient)\b/i, 10, 'molecule_commerce'],
  [/\b(impurit\w*|metabolite|isotope[- ]labell?ed|deuterated)\b/i, 12, 'molecule_commerce'],

  // Synthesis
  [/\b(custom synthesis|contract manufactur\w*|route scouting|process chemistry)\b/i, 16, 'custom_synthesis'],
  [/\b(synthes\w+|scale[- ]?up|kilo ?lab|cGMP intermediate|peptide synthesis)\b/i, 12, 'custom_synthesis'],
  [/\b(preclinical|IND[- ]enabling|formulation development)\b/i, 10, 'custom_synthesis'],

  // Discovery / target work — the molecule platform's own territory, which is the
  // scientific_intelligence line, not synthesis. A sponsor asking which molecule to pursue is
  // buying the answer, not the compound.
  [/\b(target identification|target validation|hit[- ]to[- ]lead|lead optimi[sz]ation)\b/i, 14, 'scientific_intelligence'],
  [/\b(drug discovery|therapeutic candidate|mechanism of action)\b/i, 12, 'scientific_intelligence'],
  [/\b(disease[- ]target association|literature surveillance|evidence synthesis)\b/i, 10, 'scientific_intelligence'],

  // Fulfilment. NOTE: there is no 'scientific_fulfillment' business line — BUSINESS_LINES holds
  // exactly four values and that is not one of them, though opportunity-qualify.js maps several
  // NAICS codes to it. Supplying material IS molecule_commerce, so that is where this belongs.
  [/\b(laboratory suppl\w*|consumables|cold chain|controlled substance storage)\b/i, 10, 'molecule_commerce'],
  [/\b(distribut\w+ agreement|wholesale|drop[- ]ship)\b/i, 8, 'molecule_commerce'],
]);

// ── VETOES: physical-plant work wearing a laboratory code ────────────────────
//
// These keep appearing under NAICS 541380 and the H family. A veto subtracts hard, because the
// failure they prevent — a hull survey in a pharmaceutical bid queue — is the exact thing that
// made the board unreadable. Each is tied to a real observed title.
const VETOES = Object.freeze([
  [/\b(hull|vessel|shipboard|watercraft|USNS|ultrasonic gauging)\b/i, 60, 'marine or vessel work'],
  [/\b(HVAC|duct|boiler|steam plant|chiller|phase bus|switchgear)\b/i, 55, 'building plant work'],
  [/\b(simulator|training range|test range|live[- ]fire|munition|weapon|missile|warhead)\b/i, 70, 'defense systems work'],
  [/\b(metal casting|forging|machining|welding|composite structure)\b/i, 60, 'materials or manufacturing engineering'],
  [/\b(pavement|bridge|roadway|dredg\w+|levee|culvert)\b/i, 60, 'civil engineering work'],
  [/\b(janitorial|custodial|groundskeeping|landscap\w+|snow removal)\b/i, 70, 'facilities services'],
  [/\b(calibration of|surface plate|torque wrench|gauge block)\b/i, 40, 'instrument calibration, not analysis'],
  [/\b(software development|cybersecurity|help desk|IT support|cloud migration)\b/i, 55, 'information technology work'],
  [/\b(construction|renovation|roof replacement|demolition)\b/i, 65, 'construction work'],
]);

// Score boundaries. RELEVANT goes to the owner's queue; MARGINAL is visible but separated;
// NOT_RELEVANT is recorded with its reasons and kept off the board.
const RELEVANT_AT = 60;
const MARGINAL_AT = 30;

const VERDICTS = Object.freeze(['RELEVANT', 'MARGINAL', 'NOT_RELEVANT']);

function familyKey(psc) {
  if (!psc) return null;
  return String(psc).trim().toUpperCase().slice(0, 2) || null;
}

function clamp(n) {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Assess whether an opportunity is Abiozen's kind of work.
 *
 * Pure: no database, no network, no clock. Everything it concludes is derived from the record
 * passed in, which is what makes the verdicts reproducible and the tests meaningful.
 *
 * @param {object} opp  psc_code, naics_code, title, description
 * @returns {{verdict:string, score:number, lines:string[], reasons:string[], vetoes:string[]}}
 */
function assessRelevance(opp) {
  const o = opp || {};
  const psc = o.psc_code ? String(o.psc_code).trim().toUpperCase() : null;
  const naics = o.naics_code ? String(o.naics_code).trim() : null;
  const text = `${o.title || ''}\n${o.description || ''}`;

  const reasons = [];
  const vetoes = [];
  const lines = new Set();
  let score = 0;

  // 1. PSC family prior.
  const fam = familyKey(psc);
  const prior = fam ? PSC_FAMILY[fam] : null;
  if (prior) {
    score += prior.base;
    for (const l of prior.lines) lines.add(l);
    reasons.push(prior.base > 0
      ? `PSC ${psc} (${fam}): ${prior.note} [+${prior.base}]`
      : `PSC ${psc} (${fam}) carries no weight: ${prior.note} [+0]`);
  } else if (psc) {
    reasons.push(`PSC ${psc} is not a family this engine recognises — decided on text alone [+0]`);
  } else {
    reasons.push('no PSC code on the record — decided on text alone [+0]');
  }

  // 2. NAICS corroboration.
  if (naics && NAICS_BONUS[naics]) {
    score += NAICS_BONUS[naics];
    reasons.push(`NAICS ${naics} corroborates [+${NAICS_BONUS[naics]}]`);
  } else if (naics) {
    reasons.push(`NAICS ${naics} is outside our codes [+0]`);
  }

  // 3. Evidence from the solicitation text.
  let evidenceHits = 0;
  for (const [re, weight, line] of EVIDENCE) {
    const m = text.match(re);
    if (!m) continue;
    evidenceHits += 1;
    score += weight;
    lines.add(line);
    reasons.push(`text: "${String(m[0]).slice(0, 48)}" supports ${line} [+${weight}]`);
  }
  if (!evidenceHits) {
    reasons.push('no supporting term found anywhere in the title or solicitation text [+0]');
  }

  // 4. Vetoes. Applied last so they can always overrule an accumulated score.
  for (const [re, penalty, label] of VETOES) {
    const m = text.match(re);
    if (!m) continue;
    score -= penalty;
    vetoes.push(`${label} — "${String(m[0]).slice(0, 32)}" [-${penalty}]`);
  }

  score = clamp(score);

  // A line is required. A score with no identifiable line is not relevance, it is a coincidence
  // of vocabulary, and promoting it would put work we have no business doing in front of the
  // owner with a confident number attached.
  const lineList = [...lines].filter((l) => BUSINESS_LINES.includes(l)).sort();
  let verdict;
  if (!lineList.length) {
    verdict = 'NOT_RELEVANT';
    reasons.push('no business line could be identified — relevance cannot be asserted without one');
    score = Math.min(score, MARGINAL_AT - 1);
  } else if (score >= RELEVANT_AT) {
    verdict = 'RELEVANT';
  } else if (score >= MARGINAL_AT) {
    verdict = 'MARGINAL';
  } else {
    verdict = 'NOT_RELEVANT';
  }

  return { verdict, score, lines: lineList, reasons, vetoes };
}

module.exports = {
  assessRelevance,
  PSC_FAMILY,
  NAICS_BONUS,
  EVIDENCE,
  VETOES,
  VERDICTS,
  RELEVANT_AT,
  MARGINAL_AT,
};
