// ── RANK THE COMPANIES WHO RUN TRIALS, NOT THE COMPANIES WHO MAKE THINGS. ─────
//
// CPHI ranks a SUPPLIER by what it can sell us: how many of our top-demand molecules it holds a DMF
// for. SCOPE Europe is the opposite floor. Nobody there sells an API; they run clinical trials, so
// the question is what they NEED and whether we can supply it.
//
// `clinical_studies` already answers that, and it is the right register for it — unlike
// `fda_establishments`, which was asked the same question at CPHI and answered with dairies,
// poultry farms and hand-sanitizer makers, because "registered to make something" is not
// "developing a drug". `sponsor_type = 'INDUSTRY'` IS "developing a drug", by ClinicalTrials.gov's
// own definition of leadSponsor.class.
//
// ── THE COLUMN THAT MATTERS AT A BOOTH ────
//
// Not the score. The MOLECULES. A ranked list tells you who to walk up to; the molecule list tells
// you what to say when you get there — "you have three recruiting studies on leuprolide; we have
// three DMF holders for it and a price". That sentence is the entire product. So every row carries
// its molecules, and `sourceable` counts the ones we can actually supply today rather than every
// molecule the sponsor touches, because promising the rest is how a first meeting becomes the last.
//
// ── WHAT THE SCORE IS AND IS NOT ────
//
// It reuses the weights in src/lib/dmf/demand.js so the two sides of the platform rank on the same
// arithmetic, with one addition: molecules we can source, weighted heavily, because a sponsor
// running twenty trials on nothing we stock is worth less to us than one running three on material
// we hold. The weights are a judgement, not a measurement — the honest use of the number is to
// order a list you will work top-down, not to decide anything on its own.
'use strict';

// The tiered fold the CPHI exhibitor matcher uses. Reused deliberately: a sponsor name from
// ClinicalTrials.gov ("Takeda Development Center Americas, Inc.") and a name on a SCOPE stand
// ("Takeda") diverge exactly the way an FDA holder and a CPHI stand do, and that file already
// encodes three bugs' worth of hard-won handling — brand token not always first, the
// distinctiveness guard belonging to prefix only, possessives collapsing before punctuation.
const { normalizeCompany, companyCore, bestMatch, reviewStatusFor } = require('../cphi/match-company');

// A sourceable molecule is worth more than a study, because it is the thing we can actually quote.
// Set against `studies * 3` from demand.js: one molecule we stock outweighs two extra trials.
const SOURCEABLE_WEIGHT = 7;

// Sponsor names that are not companies. ClinicalTrials.gov classes some government and academic
// bodies as INDUSTRY through collaboration, and a few consortium names come through the lead-sponsor
// field. These never become sales targets, and leaving them in makes the top of the list look wrong
// in exactly the way the CPHI buyer tab did.
const NOT_A_BUYER = [
  'national cancer institute', 'national institutes of health', 'nih', 'nhs',
  'world health organization', 'european commission', 'european medicines agency',
  'department of veterans affairs', 'us department of', 'ministry of health',
];

function looksLikeBuyer(name) {
  const n = normalizeCompany(name);
  if (!n || n.length < 3) return false;
  return !NOT_A_BUYER.some((bad) => n.includes(normalizeCompany(bad)));
}

// SQL for the sponsor ranking. Takes NO parameters: it is purely a read of our own trial data, and
// the show-floor tie-in happens in JS afterwards (see attachExhibitors below) because the company
// fold is a JavaScript function Postgres cannot call. The molecule merge needed the same split for
// the same reason.
//
// `sourceable` is a molecule this sponsor studies for which we hold EITHER an auto-confirmed DMF
// match or an active price row. Those are the two things that make a molecule quotable; a molecule
// in a trial and nowhere else is demand we cannot serve yet, counted separately as `unsourced`.
function sponsorRankSql({ limit = 100, minStudies = 1 } = {}) {
  return `
    WITH sponsor_studies AS (
      SELECT cs.id study_id,
             cs.lead_sponsor_name sponsor,
             cs.phase, cs.enrollment_count, cs.overall_status,
             cs.therapeutic_area, cs.locations_countries
        FROM clinical_studies cs
       WHERE cs.sponsor_type = 'INDUSTRY'
         AND cs.lead_sponsor_name IS NOT NULL
         AND length(btrim(cs.lead_sponsor_name)) > 2
    ),
    -- Every molecule each sponsor touches, with whether we can quote it. LEFT JOINs because the
    -- interesting rows include molecules we hold nothing for.
    sponsor_molecules AS (
      SELECT ss.sponsor,
             LOWER(sm.molecule_name) mkey,
             MIN(sm.molecule_name) molecule,
             BOOL_OR(dm.dmf_number IS NOT NULL) has_dmf,
             BOOL_OR(pr.id IS NOT NULL) has_price
        FROM sponsor_studies ss
        JOIN study_molecules sm ON sm.study_id = ss.study_id
        LEFT JOIN molecule_dmf_matches dm
               ON LOWER(dm.molecule_name) = LOWER(sm.molecule_name)
              AND dm.review_status = 'auto_confirmed'
        LEFT JOIN molecule_pricing pr
               ON LOWER(pr.molecule_name) = LOWER(sm.molecule_name)
              AND pr.active = 1
       GROUP BY ss.sponsor, 2
    ),
    agg AS (
      SELECT ss.sponsor,
             COUNT(DISTINCT ss.study_id)::int studies,
             COUNT(DISTINCT ss.study_id) FILTER (WHERE ss.phase = 'Phase 3')::int ph3,
             COUNT(DISTINCT ss.study_id) FILTER (WHERE ss.phase = 'Phase 2')::int ph2,
             COUNT(DISTINCT ss.study_id) FILTER (WHERE ss.overall_status = 'RECRUITING')::int recruiting,
             COALESCE(SUM(DISTINCT ss.enrollment_count), 0)::int patients,
             MIN(ss.therapeutic_area) therapeutic_area
        FROM sponsor_studies ss
       GROUP BY 1
    ),
    mols AS (
      SELECT sponsor,
             COUNT(*)::int molecules,
             COUNT(*) FILTER (WHERE has_dmf OR has_price)::int sourceable,
             COUNT(*) FILTER (WHERE NOT (has_dmf OR has_price))::int unsourced,
             -- Quotable ones first and alphabetical within each group, so the drawer reads the same
             -- way every time and the openers are at the top.
             COALESCE(json_agg(json_build_object(
                        'molecule', molecule,
                        'sourceable', (has_dmf OR has_price),
                        'has_dmf', has_dmf,
                        'has_price', has_price)
                      ORDER BY (has_dmf OR has_price) DESC, molecule), '[]') molecule_list
        FROM sponsor_molecules
       GROUP BY 1
    )
    SELECT a.sponsor,
           a.studies, a.ph3, a.ph2, a.recruiting, a.patients, a.therapeutic_area,
           COALESCE(m.molecules, 0)::int   molecules,
           COALESCE(m.sourceable, 0)::int  sourceable,
           COALESCE(m.unsourced, 0)::int   unsourced,
           COALESCE(m.molecule_list, '[]') molecule_list,
           -- The same weights as src/lib/dmf/demand.js, plus sourceable molecules.
           (a.studies * 3 + a.ph3 * 5 + a.ph2 * 2
            + least(a.patients / 500.0, 20)
            + COALESCE(m.sourceable, 0) * ${SOURCEABLE_WEIGHT})::numeric(10,2) score
      FROM agg a
      LEFT JOIN mols m ON m.sponsor = a.sponsor
     WHERE a.studies >= ${Number(minStudies) || 1}
     ORDER BY score DESC, a.sponsor
     LIMIT ${Number(limit) || 100}`;
}

// ── THE SHOW-FLOOR TIE-IN ────
//
// Attach booth and hall to each ranked sponsor, and re-sort so whoever is actually standing in
// Barcelona comes first. A sponsor we rank highly but cannot find on the exhibitor list STILL
// APPEARS, with `exhibiting: false` — that gap is a research task (are they attending under a
// parent company's name?), not a reason to hide a company running trials on molecules we stock.
//
// `tier` and `review_status` come straight from the CPHI matcher, which means a prefix or token
// match arrives gated exactly as it does there: good enough to start a conversation at a booth,
// not good enough to put on a contract. The UI must print the tier for anything below `core`.
function attachExhibitors(rows, exhibitors) {
  // bestMatch wants {name, booth} and returns {tier, name, booth}. Keep a lookup back to the full
  // row so hall, id and the exhibiting flag survive the round trip.
  const byName = new Map();
  const candidates = [];
  for (const x of exhibitors || []) {
    const name = x && (x.exhibitor_name || x.holder);
    if (!name) continue;
    byName.set(name, x);
    candidates.push({ name, booth: x.booth || null });
  }

  const out = (rows || []).map((r) => {
    const m = candidates.length ? bestMatch(r.sponsor, candidates) : null;
    if (!m) {
      return { ...r, exhibiting: false, booth: null, hall: null, exhibitor_name: null,
               exhibitor_match_id: null, match_tier: null, review_status: null };
    }
    const hit = byName.get(m.name) || {};
    return {
      ...r,
      // A row on the exhibitor table that has not been marked absent counts as present: the table
      // is built by looking companies up, so a row existing at all means we found them listed.
      exhibiting: hit.exhibiting !== false,
      booth: m.booth || hit.booth || null,
      hall: hit.hall || null,
      exhibitor_name: m.name,
      exhibitor_match_id: hit.id != null ? hit.id : null,
      match_tier: m.tier,
      review_status: reviewStatusFor(m.tier),
    };
  });

  return out.sort((a, b) =>
    (b.exhibiting ? 1 : 0) - (a.exhibiting ? 1 : 0) ||
    Number(b.score) - Number(a.score) ||
    String(a.sponsor).localeCompare(String(b.sponsor)));
}

// Drop the sponsors that are not companies we could sell to. Applied in JS rather than SQL so the
// exclusion list stays readable and testable next to the reason it exists.
function onlyBuyers(rows) {
  return (rows || []).filter((r) => r && looksLikeBuyer(r.sponsor));
}

module.exports = {
  sponsorRankSql,
  attachExhibitors,
  onlyBuyers,
  looksLikeBuyer,
  normalizeCompany,
  companyCore,
  SOURCEABLE_WEIGHT,
  NOT_A_BUYER,
};
