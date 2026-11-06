// ── CAN ABIOZEN ACTUALLY FULFIL THIS? ────────────────────────────────────────
//
// Ruling 24 items 3, 4 and 6. Eligibility and fulfilment are different questions, and the ranking
// engine conflated them: 36C25627Q0074 scored well because it is unrestricted, matches NAICS
// 325413, and says "reagent" — and it is unfulfillable, because the deliverable is 1,500
// proprietary Roche SKUs we have no channel to.
//
//   ELIGIBLE     = the Government would accept a quote from us
//   FEASIBLE     = we could actually deliver the thing
//
// A notice can be perfectly eligible and completely unfulfillable. That combination is the most
// expensive one on the board, because nothing stops you spending a week on it.
//
// ── THE SEVEN CHECKS ─────────────────────────────────────────────────────────
//
// Each returns 'ok' | 'blocked' | 'unknown', and UNKNOWN NEVER READS AS PASS. Most will be
// unknown, because we hold no supplier quotes and no capability evidence — and an unknown that
// scored like a pass is how a ranking becomes a recommendation it cannot support.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
// It does not assume a chemical supplier can fulfil an OEM diagnostic order (ruling 24 item 6).
// BLD, ChemScene and ChemSync are small-molecule and research-chemical catalogue houses. Roche
// Ventana, Abbott Architect, Beckman, Cepheid and bioMérieux consumables are proprietary in-vitro
// diagnostic products formulated for a specific instrument. The distinction is categorical rather
// than commercial: these are not products that exist in a chemical catalogue at any price.
'use strict';

const { isoDay } = require('./iso-day');

// Manufacturers whose clinical-diagnostic consumables are OEM-proprietary. Appearing in a notice
// does not prove a restriction — it proves the deliverable is that manufacturer's product, which
// is the thing we cannot source.
const OEM_DIAGNOSTIC_MANUFACTURERS = Object.freeze([
  'roche', 'ventana', 'abbott', 'architect', 'alinity', 'beckman', 'coulter', 'siemens healthineers',
  'sysmex', 'ortho clinical', 'cepheid', 'genexpert', 'biomerieux', 'bio-merieux', 'vitek',
  'hologic', 'diagenode', 'bio-rad', 'biorad', 'illumina', 'qiagen', 'stago', 'werfen',
  'instrumentation laboratory', 'diasorin', 'quidel', 'luminex', 'nanostring',
]);

// Instrument and hardware manufacturers — a different unfulfillable class. Supplying these needs a
// dealer agreement, not a chemical supply chain.
const INSTRUMENT_MANUFACTURERS = Object.freeze([
  'netzsch', 'spectra-physics', 'teledyne', 'agilent', 'waters corporation', 'shimadzu',
  'perkinelmer', 'bruker', 'jeol', 'zeiss', 'leica', 'olympus', 'nikon', 'fluke', 'mettler',
  'thermo scientific', 'thermo fisher', 'hach', 'ge healthcare', 'millipore',
]);

// What Abiozen's supply channel actually reaches. From the supply-channel record: BLD onboarded,
// ChemSync onboarding, ChemScene a major supplier — all small-molecule / research-chemical.
const SUPPLY_CHANNEL = Object.freeze({
  partners: ['BLD (BLDpharm)', 'ChemSync (onboarding)', 'ChemScene'],
  reaches: ['research_chemical', 'generic_api', 'reference_standard'],
  does_not_reach: [
    'oem_diagnostic_consumable', 'instrument_hardware', 'medical_device',
    // Ruling 24 item 6: "Distinguish research chemicals from proprietary clinical diagnostic
    // consumables." A clinical diagnostic consumable is instrument-matched and validated as part of
    // a regulated assay system. Whether or not a notice happens to name the OEM, a research-chemical
    // catalogue does not stock it — the Roche case is this class with the manufacturer named, not a
    // different kind of problem.
    'clinical_diagnostic_consumable',
    // Requires an NRC or Agreement State radioactive materials licence, and an isotope with a
    // half-life measured in hours cannot be shipped through a catalogue supply chain at all.
    'radiopharmaceutical',
  ],
});

const PRODUCT_CLASSES = Object.freeze([
  'research_chemical', 'generic_api', 'reference_standard', 'lab_consumable_generic',
  'oem_diagnostic_consumable', 'clinical_diagnostic_consumable', 'radiopharmaceutical',
  'instrument_hardware', 'analytical_service', 'cro_service', 'facility_service',
  'unrelated', 'unknown',
]);

// Business lines Abiozen declares. A notice whose deliverable sits outside all of them is not a
// supply problem to solve, it is somebody else's trade — and saying so is more useful than leaving
// it UNKNOWN at the top of the board.
const DECLARED_BUSINESS = Object.freeze([
  'molecule_commerce', 'custom_synthesis', 'scientific_fulfillment',
  'analytical_services', 'cro_services',
]);

const CLASS_PATTERNS = [
  // Radiopharmaceuticals before everything: FDG and the diagnostic isotopes read as "6505
  // pharmaceutical" to every other pattern, and the constraint that decides them is neither the
  // molecule nor the price but the licence and the half-life.
  ['radiopharmaceutical', /\b(radiopharmaceutical|radioisotope|fluorodeoxyglucose|\bFDG\b|F[- ]?18\b|Tc[- ]?99m?\b|technetium|I[- ]?131\b|Lu[- ]?177\b|gallium[- ]?68|PET (tracer|radio)|radioactive materials licen[cs]e)/i],

  // Clinical diagnostic consumables before the generic-chemical patterns. "Reagent" matches
  // research_chemical, so a VA coagulation or flow-cytometry reagent buy would otherwise be read as
  // something ChemScene could ship (ruling 24 item 6).
  ['clinical_diagnostic_consumable', /\b(flow cytometry reagent|coagulation (testing|reagent)|immunoassay|ELISA kit|IHC|immunohistochem|in situ hybridi|blood bank|hematology (control|reagent)|clinical (analy[sz]er|chemistry) (reagent|consumable)|diagnostic (reagent|assay|test kit)|calibrator(s)? and control|assay (cartridge|kit)|CLIA[- ]waived|reference (and esoteric )?laborator)/i],

  // Services next: a notice asking us to PERFORM testing is not a supply problem.
  ['cro_service', /\b(clinical (trial|stud)|GLP|GCP|contract research|study (report|protocol)|preclinical|toxicolog(y|ical) stud|data coordinat(ing|ion) center)/i],
  ['analytical_service', /\b(testing services|analysis services|laborator(y|ies) (testing|services|analysis)|method validation|stability (stud|testing)|sample analysis|water (quality )?(testing|analysis)|effluent|DNA sequencing|sequencing service|embedding and sectioning|histolog|mineralogy|X-ray diffraction|image analys|groundwater monitoring|quantitative analysis of)/i],

  // Facility and site services. Not Abiozen's trade at all, and currently the largest single source
  // of UNKNOWN rows sitting high on the board.
  ['facility_service', /\b(medical gas (testing|certification)|husbandry|animal (care|facility) service|boiler|steam (and|&) water testing|HVAC|elevator|pest control|grounds maintenance|janitorial|calibration services for (facility|plant)|fire (alarm|suppression)|deicer|de-icing|snow removal)/i],
  ['reference_standard', /\b(reference standard|USP (reference|standard)|certified reference material|\bCRM\b|calibration standard|proficiency (test|sample))/i],
  ['generic_api', /\b(active pharmaceutical ingredient|\bAPI\b|bulk drug substance|injection, USP|ophthalmic solution|tablets?, USP|generic drug)/i],
  ['research_chemical', /\b(research chemical|custom synthes|synthesis and distribution|compound librar|building block|intermediate|reagent grade chemical|solvent|\bacid\b|\bhydroxide\b|organic chemical)/i],
  // "tip" on its own matched the acronym TIP (NSF's Directorate for Technology, Innovation and
  // Partnerships) and classified a research funding announcement as a consumables buy. A
  // three-letter word is not a product class; the tip has to be a pipette tip.
  ['lab_consumable_generic', /\b(pipette|pipet(te)? tips?|glassware|microscope slide|culture media|microbiological media|agar|petri|centrifuge tube|nitrile glove|consumable supplies|laboratory suppl)/i],

  // Clearly another industry. A 541715 "R&D" NAICS or a 541380 "testing" NAICS is wide enough to
  // cover buildings, airfields and marine coatings, and a notice that matched a business line on
  // that basis alone is the item-3 failure in a quieter form.
  ['unrelated', /\b(building envelope|new construction|buildings industry|home ?builder|HVAC|weatheri[sz]ation|airfield|runway|aircraft|avionics|corrosion (science|control|engineering)|marine coating|shipboard|munition|ordnance|textile|uniform|furniture|vehicle (maintenance|fleet)|information technology services|software (development|licen[cs])|cloud (hosting|migration)|staff augmentation)/i],
  ['instrument_hardware', /\b(instrument|analyzer|spectrometer|chromatograph system|printer|laser|dilatometer|microscope|incubator|freezer|centrifuge|workstation|software (and|&) hardware)/i],
];

/** Classify what the notice is actually buying. Unknown when the text does not say. */
function classifyProduct(opp) {
  const hay = `${opp.title || ''} ${opp.description || ''}`;
  const oem = OEM_DIAGNOSTIC_MANUFACTURERS.find((m) => new RegExp(`\\b${m}\\b`, 'i').test(hay));
  const instrument = INSTRUMENT_MANUFACTURERS.find((m) => new RegExp(`\\b${m}\\b`, 'i').test(hay));

  // A named diagnostic OEM plus consumable language is the Roche/Abbott case, and it dominates:
  // the product class is decided by WHOSE product it is, not by what category the words suggest.
  if (oem && /\b(reagent|consumable|assay|cartridge|kit|stainer|analyzer suppl)/i.test(hay)) {
    return { product_class: 'oem_diagnostic_consumable', manufacturer: oem, basis: `names ${oem} with consumable language` };
  }
  if (instrument) {
    return { product_class: 'instrument_hardware', manufacturer: instrument, basis: `names instrument manufacturer ${instrument}` };
  }
  for (const [cls, re] of CLASS_PATTERNS) {
    if (re.test(hay)) {
      const m = hay.match(re);
      return { product_class: cls, manufacturer: oem || null, basis: `matched "${String(m[0]).slice(0, 42)}"` };
    }
  }
  if (oem) return { product_class: 'oem_diagnostic_consumable', manufacturer: oem, basis: `names ${oem}` };
  return { product_class: 'unknown', manufacturer: null, basis: 'the notice text does not say what is being bought' };
}

/**
 * The seven checks ruling 24 item 4 names. Each is explicit, each can be UNKNOWN, and UNKNOWN
 * never counts as a pass.
 *
 * @param {object} opp         tracker row
 * @param {object} ctx         { capabilities, verification, supplierQuotes, today }
 */
function assessFeasibility(opp, ctx = {}) {
  const today = ctx.today || new Date().toISOString().slice(0, 10);
  const caps = ctx.capabilities || [];
  const verified = (ctx.verification && ctx.verification[opp.solicitation_number]) || null;
  const quotes = ctx.supplierQuotes || {};
  const { product_class, manufacturer, basis } = classifyProduct(opp);
  const checks = {};
  const blockers = [];
  const unknowns = [];

  const set = (name, status, detail) => {
    checks[name] = { status, detail };
    if (status === 'blocked') blockers.push(`${name}: ${detail}`);
    if (status === 'unknown') unknowns.push(`${name}: ${detail}`);
  };

  // 1. PROPRIETARY OEM PRODUCT
  if (product_class === 'oem_diagnostic_consumable') {
    set('proprietary_oem', 'blocked',
      `the deliverable is ${manufacturer ? `${manufacturer}'s` : 'a named manufacturer\'s'} proprietary `
      + 'diagnostic consumable. Abiozen has no channel to it, and a chemical supplier cannot source it '
      + 'at any price — these products do not exist in a chemical catalogue');
  } else if (product_class === 'clinical_diagnostic_consumable') {
    // The distinction ruling 24 item 6 asks for, stated at the point it changes the answer.
    set('proprietary_oem', 'blocked',
      'the deliverable is a clinical diagnostic consumable — instrument-matched and validated as part '
      + 'of a regulated assay system, not a research chemical. '
      + (manufacturer ? `The notice names ${manufacturer}. ` : 'The notice does not name the manufacturer, which does not help: ')
      + 'these are supplied by the diagnostics OEM or its authorised distributors, and a '
      + 'research-chemical catalogue does not stock them');
  } else if (product_class === 'radiopharmaceutical') {
    set('proprietary_oem', 'blocked',
      'the deliverable is a radiopharmaceutical. Two independent barriers: it requires an NRC or '
      + 'Agreement State radioactive materials licence, which Abiozen does not hold, and a '
      + 'short half-life isotope must be produced near the point of use — neither is a sourcing problem');
  } else if (product_class === 'facility_service' || product_class === 'unrelated') {
    set('proprietary_oem', 'blocked',
      `the deliverable is ${product_class === 'unrelated' ? 'in another industry' : 'a facility or site service'}, `
      + `outside every declared Abiozen business line (${DECLARED_BUSINESS.join(', ')}). `
      + `${basis}. It is not a supply question`);
  } else if (product_class === 'instrument_hardware') {
    set('proprietary_oem', 'blocked',
      `the deliverable is instrument hardware${manufacturer ? ` (${manufacturer})` : ''}, which needs a `
      + 'dealer agreement rather than a chemical supply chain');
  } else if (product_class === 'unknown') {
    set('proprietary_oem', 'unknown', 'the notice does not say what is being bought; read it before assuming it is sourceable');
  } else {
    set('proprietary_oem', 'ok', `product class ${product_class} — ${basis}`);
  }

  // 2. MANUFACTURER AUTHORIZATION WHERE REQUIRED
  if (verified && /OEM|authoriz|letter of authorization/i.test(verified.bar || '')) {
    set('oem_authorization', 'blocked', `the notice requires it: ${String(verified.bar).slice(0, 90)}`);
  } else if (/letter of authorization|authorized (dealer|distributor|reseller)|852\.212-71|gray market/i
    .test(`${opp.title || ''} ${opp.description || ''}`)) {
    set('oem_authorization', 'blocked', 'the notice text requires OEM authorization, which Abiozen does not hold');
  } else if (product_class === 'oem_diagnostic_consumable') {
    set('oem_authorization', 'unknown',
      'the notice does not require an authorization letter, but the product is OEM-proprietary. '
      + 'Absence of the clause is not a supply route — verify before relying on it');
  } else {
    set('oem_authorization', 'ok', 'no manufacturer authorization is required by the notice');
  }

  // 3. SUPPLIER AVAILABILITY
  if (SUPPLY_CHANNEL.does_not_reach.includes(product_class)) {
    set('supplier_availability', 'blocked',
      `no Abiozen supply partner reaches ${product_class}. Channel: ${SUPPLY_CHANNEL.partners.join(', ')} — all small-molecule/research-chemical`);
  } else if (SUPPLY_CHANNEL.reaches.includes(product_class)) {
    set('supplier_availability', quotes[opp.solicitation_number] ? 'ok' : 'unknown',
      quotes[opp.solicitation_number]
        ? 'a supplier quote is on record'
        : `${product_class} is within the channel's reach in principle, but NO SUPPLIER QUOTE EXISTS for this requirement`);
  } else if (product_class === 'facility_service' || product_class === 'unrelated') {
    set('supplier_availability', 'blocked',
      `${product_class === 'unrelated' ? 'Another industry\'s work' : 'A facility service'}, outside `
      + 'Abiozen\'s declared business lines — there is no supply channel to reach because there is no '
      + 'product here to source');
  } else if (product_class === 'analytical_service' || product_class === 'cro_service') {
    set('supplier_availability', 'unknown', 'a service, not a supply — feasibility depends on in-house capability, checked below');
  } else {
    set('supplier_availability', 'unknown', 'product class unresolved, so supplier reach cannot be judged');
  }

  // 4. MINIMUM ORDER QUANTITIES
  const qtyHay = `${opp.title || ''} ${opp.description || ''}`;
  const moq = qtyHay.match(/minimum (order|quantity|purchase)[^.]{0,60}/i);
  if (moq) set('minimum_order_quantity', 'unknown', `the notice states: "${moq[0].slice(0, 80)}" — compare against supplier MOQ, which we do not have`);
  else set('minimum_order_quantity', 'unknown', 'no quantities stated in the notice, and no supplier MOQ on record — neither side of the comparison exists');

  // 5. FULFILMENT LEAD TIME
  const firstDelivery = verified && verified.first_delivery_required;
  const deliveryWindow = qtyHay.match(/within (\d+) (business )?days/i);
  const dLeft = opp.response_deadline
    ? Math.round((Date.parse(`${isoDay(opp.response_deadline)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5)
    : null;
  if (firstDelivery) {
    const days = Math.round((Date.parse(firstDelivery) - Date.parse(today)) / 864e5);
    set('fulfilment_lead_time', days < 30 ? 'blocked' : 'unknown',
      `first delivery required in ${days} day(s) and no supply route exists to build in that time`);
  } else if (deliveryWindow) {
    set('fulfilment_lead_time', 'unknown',
      `the notice requires delivery ${deliveryWindow[0]}; our lead time for this product is UNKNOWN`);
  } else if (dLeft !== null && dLeft <= 7) {
    set('fulfilment_lead_time', 'unknown', `${dLeft} day(s) to respond — too little to establish a supply route from a standing start`);
  } else {
    set('fulfilment_lead_time', 'unknown', 'no delivery schedule read from the notice, and no supplier lead time on record');
  }

  // 6. REQUIRED CERTIFICATIONS
  const certText = qtyHay.match(/\b(ISO[\s/]?\d{4,5}|CLIA|CAP[- ]accredit|NELAP|ELAP|GLP|GCP|cGMP|FDA[- ]approved|510\(k\)|DEA registration|state licen[cs]e)\b/i);
  const heldCerts = caps.filter((c) => ['accreditation', 'certification', 'regulatory_authorization'].includes(c.kind));
  if (certText && !heldCerts.length) {
    set('required_certifications', 'blocked',
      `the notice references ${certText[0]} and Abiozen holds NO verified certification or accreditation of any kind`);
  } else if (certText) {
    set('required_certifications', 'unknown', `the notice references ${certText[0]}; check scope against what is held`);
  } else if (!heldCerts.length) {
    set('required_certifications', 'unknown',
      'no certification requirement read from the notice, but the registry is empty so none could be met if one appears');
  } else {
    set('required_certifications', 'ok', `${heldCerts.length} verified certification(s) on record`);
  }

  // 7. ESTIMATED GROSS MARGIN
  const haveValue = opp.estimated_value_usd !== null && opp.estimated_value_usd !== undefined;
  const haveCost = !!quotes[opp.solicitation_number];
  if (haveValue && haveCost) {
    const q = quotes[opp.solicitation_number];
    const margin = (opp.estimated_value_usd - q.cost) / opp.estimated_value_usd;
    set('estimated_gross_margin', margin > 0 ? 'ok' : 'blocked', `${(margin * 100).toFixed(1)}% from a recorded quote`);
    checks.estimated_gross_margin.value = margin;
  } else {
    set('estimated_gross_margin', 'unknown',
      !haveValue && !haveCost
        ? 'neither a contract value nor a supplier cost exists — margin is not estimable, and a number here would be invented'
        : !haveValue ? 'the SAM index carries no estimated value for this notice' : 'no supplier quote, so there is no cost side');
  }

  // ── verdict ──────────────────────────────────────────────────────────────
  // NOT_FEASIBLE when something is blocked. Otherwise UNPROVEN — never "feasible", because with an
  // empty capability registry and no supplier quotes nothing can currently be proved fulfillable.
  const verdict = blockers.length ? 'NOT_FEASIBLE'
    : unknowns.length ? 'UNPROVEN' : 'FEASIBLE';

  return {
    verdict, product_class, manufacturer, classification_basis: basis,
    checks, blockers, unknowns,
    // A score in [0,1] for ranking. Blocked collapses it; unknowns hold it well below the top.
    confidence: blockers.length ? 0
      : Math.max(0, 1 - (unknowns.length / Object.keys(checks).length)),
  };
}

module.exports = {
  OEM_DIAGNOSTIC_MANUFACTURERS,
  INSTRUMENT_MANUFACTURERS,
  SUPPLY_CHANNEL,
  PRODUCT_CLASSES,
  classifyProduct,
  assessFeasibility,
};
