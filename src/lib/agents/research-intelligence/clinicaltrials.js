// Clinical Demand Intelligence — ClinicalTrials.gov API v2 ingestion.
//
// PURE fetch + parse: this module never writes to the DB and never calls an LLM.
// The orchestrator (index.js) owns pagination limits, the watermark, the daily
// cap, classification, catalog matching, and persistence. Keeping ingestion
// side-effect-free keeps it independently testable and keeps the agent isolated.
//
// The v2 API is public (no key). Query syntax + field paths verified live
// 2026-08-11. Locked decisions (spec v1.0, 2026-08-11):
//   • statuses: RECRUITING / NOT_YET_RECRUITING / ACTIVE_NOT_RECRUITING
//   • NO query.term filter — pull broad, classify with the LLM
//   • sort LastUpdatePostDate:desc (freshest first) → enables a simple watermark
//   • phases Preclinical/1/2/3 (skip Phase-4-only)

const BASE = 'https://clinicaltrials.gov/api/v2/studies';
const UA = { 'User-Agent': 'AbiozenResearchIntel/1.0 (+https://abiozen.com)' };

const STATUSES = ['RECRUITING', 'NOT_YET_RECRUITING', 'ACTIVE_NOT_RECRUITING'];

// Only the protocol modules we consume (keeps each page small/fast).
const FIELDS = [
  'protocolSection.identificationModule',
  'protocolSection.statusModule',
  'protocolSection.sponsorCollaboratorsModule',
  'protocolSection.conditionsModule',
  'protocolSection.designModule',
  'protocolSection.armsInterventionsModule',
  'protocolSection.contactsLocationsModule',
].join(',');

// Rule-based phase from CT.gov's structured phase enum (authoritative — the LLM
// does NOT re-derive this). EARLY_PHASE1/PHASE1 → Phase 1, etc. NA/none → null.
function normalizePhase(phases) {
  const p = (phases || []).map(x => String(x).toUpperCase());
  if (p.includes('PHASE3')) return 'Phase 3';
  if (p.includes('PHASE2')) return 'Phase 2';
  if (p.includes('PHASE1') || p.includes('EARLY_PHASE1')) return 'Phase 1';
  if (p.includes('PHASE4')) return 'Phase 4';
  return null; // NA / not applicable / observational — classification decides relevance
}

// Skip Phase-4-only studies (locked decision #4). A study with no phase (NA) is
// kept — the classifier decides whether it is drug-interventional.
function keepStudy(parsed) {
  return parsed.phase !== 'Phase 4';
}

// Convenience for the orchestrator: does this study have a drug/biological
// intervention (i.e. any molecule demand at all)? Not used to filter here (we
// pull broad per spec) but lets the orchestrator skip LLM inference on pure
// behavioral/device/procedure studies to save budget.
function hasDrugIntervention(parsed) {
  return (parsed.interventions || []).some(i => /DRUG|BIOLOGICAL/i.test(i.type || ''));
}

// Fetch ONE page. Returns { studies:[raw], nextPageToken } or { error }.
async function fetchStudiesPage({ pageToken = null, pageSize = 50 } = {}) {
  const params = new URLSearchParams();
  params.set('filter.overallStatus', STATUSES.join('|')); // pipe = OR (verified live)
  params.set('sort', 'LastUpdatePostDate:desc');
  params.set('pageSize', String(Math.min(1000, Math.max(1, pageSize))));
  params.set('fields', FIELDS);
  if (pageToken) params.set('pageToken', pageToken);
  try {
    const res = await fetch(`${BASE}?${params.toString()}`, { headers: UA });
    if (!res.ok) return { error: `ClinicalTrials.gov ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` };
    const data = await res.json();
    return { studies: data.studies || [], nextPageToken: data.nextPageToken || null };
  } catch (e) {
    return { error: 'ClinicalTrials.gov fetch failed: ' + e.message };
  }
}

// Normalize a raw study into a flat record aligned to the clinical_studies columns.
// Array fields are returned as JS arrays; the orchestrator JSON.stringify's them
// into the TEXT columns (codebase convention). raw_protocol → raw_json.
function parseStudy(raw) {
  const ps = raw.protocolSection || {};
  const idm = ps.identificationModule || {};
  const stm = ps.statusModule || {};
  const spm = ps.sponsorCollaboratorsModule || {};
  const cm = ps.conditionsModule || {};
  const dm = ps.designModule || {};
  const aim = ps.armsInterventionsModule || {};
  const clm = ps.contactsLocationsModule || {};

  const interventions = (aim.interventions || []).map(i => ({ type: i.type || null, name: i.name || null }));
  const molecules_mentioned = interventions
    .filter(i => /DRUG|BIOLOGICAL/i.test(i.type || ''))
    .map(i => i.name).filter(Boolean);
  const countries = [...new Set((clm.locations || []).map(l => l.country).filter(Boolean))];
  const collaborators = (spm.collaborators || []).map(c => c.name).filter(Boolean);
  const institution = (clm.overallOfficials || []).map(o => o.affiliation).find(Boolean) || null;

  return {
    nct_id: idm.nctId || null,
    brief_title: idm.briefTitle || null,
    official_title: idm.officialTitle || null,
    overall_status: stm.overallStatus || null,
    phase: normalizePhase(dm.phases),
    study_type: dm.studyType || null,
    conditions: cm.conditions || [],
    interventions,
    molecules_mentioned,
    lead_sponsor_name: spm.leadSponsor?.name || null,
    sponsor_type: spm.leadSponsor?.class || null,        // INDUSTRY / NIH / OTHER / ...
    collaborators,
    institution,                                         // primary PI institution (overallOfficials.affiliation)
    enrollment_count: dm.enrollmentInfo?.count ?? null,
    locations_countries: countries,
    start_date: stm.startDateStruct?.date || null,
    first_posted_date: stm.studyFirstPostDateStruct?.date || null,
    last_update_post_date: stm.lastUpdatePostDateStruct?.date || null,
    expected_completion: stm.completionDateStruct?.date || stm.primaryCompletionDateStruct?.date || null,
    raw_protocol: ps,                                    // orchestrator stores as raw_json
  };
}

module.exports = {
  fetchStudiesPage, parseStudy, keepStudy, hasDrugIntervention, normalizePhase,
  STATUSES, FIELDS, BASE,
};
