// Clinical Demand Intelligence — Orchestrator (Step 6).
//
// Ties the four pure modules together and owns ALL side effects: pagination,
// the watermark, the per-run cost fuse, rate limiting, confidence filtering, and
// persistence into clinical_studies + study_molecules. The modules never write.
//
// Flow per run: watermark → fetch freshest-first → for each new study: persist
// shell (dedup by nct_id) → classify (all) → if drug/biologic intervention:
// infer molecules → drop null/low-confidence → catalog-match → persist.
//
// Isolation guarantees (spec v1.0): additive only, reads existing tables read-only,
// never throws to the caller (per-study errors collected in summary.errors), and
// NOT feature-flag-gated here — the cron (Step 8) and routes (Step 7) gate it, so
// this stays directly callable for the admin endpoint and tests.
const crypto = require('crypto');
const { query } = require('../../db');
const { logAgentActivity } = require('../../agent-core');
const ct = require('./clinicaltrials');
const { classifyStudy } = require('./classify');
const { inferMolecules } = require('./infer-molecules');
const { matchCatalog } = require('./catalog-match');

const AGENT_NAME = 'clinical-demand-intelligence';

// Conservative STANDARD sonnet-5 rates (ignore the intro discount on purpose →
// over-estimate spend → the cost fuse trips earlier, never later).
const USD_PER_INPUT_TOKEN = 3.00 / 1e6;
const USD_PER_OUTPUT_TOKEN = 15.00 / 1e6;
const EST_PER_STUDY_USD = 0.05; // rough classify+infer upper bound for the pre-study gate

function envNum(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function costOf(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) * USD_PER_INPUT_TOKEN + (usage.output_tokens || 0) * USD_PER_OUTPUT_TOKEN;
}

// Watermark = newest study date we already hold. Dates are TEXT YYYY-MM-DD, so
// MAX() is chronological. Advances automatically as rows persist (no separate write).
async function getWatermark() {
  try {
    const r = await query('SELECT MAX(last_update_post_date) AS wm FROM clinical_studies');
    return (r.rows[0] && r.rows[0].wm) || null;
  } catch { return null; }
}

// Process one parsed study: persist shell → classify → (gated) infer → match → persist.
// Mutates `summary` counters; throws only on unexpected DB errors (caller catches).
async function processStudy(study, ctx) {
  const { dryRun, minConf, rateMs, track, summary } = ctx;

  // 1. Persist the study shell, deduped by nct_id. If the row already exists we
  //    skip all downstream work (no re-classify, no repeat spend).
  let studyId;
  if (dryRun) {
    studyId = 'dry-run';
  } else {
    studyId = crypto.randomUUID();
    const ins = await query(
      `INSERT INTO clinical_studies
        (id, nct_id, brief_title, official_title, overall_status, phase, study_type,
         conditions, interventions, molecules_mentioned, lead_sponsor_name, sponsor_type,
         collaborators, institution, enrollment_count, locations_countries, start_date,
         first_posted_date, last_update_post_date, expected_completion, raw_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (nct_id) DO NOTHING
       RETURNING id`,
      [studyId, study.nct_id, study.brief_title, study.official_title, study.overall_status,
       study.phase, study.study_type, JSON.stringify(study.conditions || []),
       JSON.stringify(study.interventions || []), JSON.stringify(study.molecules_mentioned || []),
       study.lead_sponsor_name, study.sponsor_type, JSON.stringify(study.collaborators || []),
       study.institution, study.enrollment_count, JSON.stringify(study.locations_countries || []),
       study.start_date, study.first_posted_date, study.last_update_post_date,
       study.expected_completion, JSON.stringify(study.raw_protocol || {})]);
    if (!ins.rows.length) return; // already ingested — nothing new to do
  }
  summary.studies_new++;

  // 2. Classify EVERY new study (cheap; therapeutic_area is valuable even for non-drug).
  const cls = await classifyStudy(study);
  track(cls.usage);
  await sleep(rateMs);
  if (cls.error) {
    summary.errors.push({ stage: 'classify', nct_id: study.nct_id, error: cls.error });
  } else if (!dryRun) {
    await query(
      `UPDATE clinical_studies SET therapeutic_area=$1, disease=$2, biomarkers=$3,
         classification_summary=$4, classification_confidence=$5, classify_prompt_version=$6,
         classified_at=NOW() WHERE id=$7`,
      [cls.therapeutic_area, cls.disease, JSON.stringify(cls.biomarkers || []),
       cls.summary, cls.confidence, cls.prompt_version, studyId]);
  }

  // 3. Molecule inference — GATED on a structural drug/biologic intervention
  //    (locked decision: non-drug studies persist with an empty molecule list).
  if (!ct.hasDrugIntervention(study)) return;

  const inf = await inferMolecules(study, cls.error ? {} : cls);
  track(inf.usage);
  await sleep(rateMs);
  if (inf.error) { summary.errors.push({ stage: 'infer', nct_id: study.nct_id, error: inf.error }); return; }

  // 4. Drop null/low-confidence → catalog-match → persist (deduped per study).
  for (const mol of inf.molecules) {
    if (typeof mol.confidence !== 'number' || mol.confidence < minConf) {
      summary.molecules_dropped_low_confidence++;
      continue;
    }
    const cm = await matchCatalog(mol);
    if (cm.catalog_match_status === 'catalog_match') summary.catalog_matches++;
    else if (cm.catalog_match_status === 'sourcing_opportunity') summary.sourcing_opportunities++;

    if (!dryRun) {
      await query(
        `INSERT INTO study_molecules
          (id, study_id, nct_id, molecule_name, cas_number, molecule_type,
           inference_rationale, inference_confidence, catalog_match_status,
           matched_sku_id, matched_source, infer_prompt_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (study_id, LOWER(molecule_name)) DO NOTHING`,
        [crypto.randomUUID(), studyId, study.nct_id, mol.molecule_name, mol.cas_number,
         mol.molecule_type, mol.rationale, mol.confidence, cm.catalog_match_status,
         cm.matched_sku_id, cm.matched_source, inf.prompt_version]);
    }
    summary.molecules_persisted++;
  }
}

// Public entry point. Always callable (flag-gating lives at cron/route layer).
// Returns a summary object; never throws.
async function runResearchIntelIngest({ maxStudies = 50, dryRun = false } = {}) {
  const cap = envNum('RESEARCH_INTEL_DAILY_USD_CAP', 2.00);
  const minConf = envNum('RESEARCH_INTEL_MIN_CONFIDENCE', 0.5);
  const rateMs = envNum('RESEARCH_INTEL_RATE_MS', 150);

  const summary = {
    studies_processed: 0,
    studies_new: 0,
    molecules_persisted: 0,
    molecules_dropped_low_confidence: 0,
    catalog_matches: 0,
    sourcing_opportunities: 0,
    cost_usd: 0,
    tokens: { input: 0, output: 0 },
    watermark_before: null,
    watermark_after: null,
    dry_run: !!dryRun,
    errors: [],
  };

  const watermark = await getWatermark();
  summary.watermark_before = watermark;

  const track = (usage) => {
    if (!usage) return;
    summary.tokens.input += usage.input_tokens || 0;
    summary.tokens.output += usage.output_tokens || 0;
    summary.cost_usd += costOf(usage);
  };
  const ctx = { dryRun, minConf, rateMs, track, summary };

  let pageToken = null, stop = false;
  try {
    while (!stop && summary.studies_new < maxStudies) {
      const page = await ct.fetchStudiesPage({ pageToken, pageSize: Math.min(50, maxStudies) });
      if (page.error) { summary.errors.push({ stage: 'fetch', error: page.error }); break; }
      if (!page.studies.length) break;

      for (const raw of page.studies) {
        if (summary.studies_new >= maxStudies) { stop = true; break; }

        const study = ct.parseStudy(raw);
        if (!study.nct_id) continue;
        if (!ct.keepStudy(study)) continue; // skip Phase-4-only

        // Watermark early-stop (live runs only): desc sort ⇒ all following are
        // older/already-ingested. dryRun ignores it so tests always see fresh data.
        if (!dryRun && watermark && study.last_update_post_date && study.last_update_post_date < watermark) {
          stop = true; break;
        }

        // Cost fuse: stop BEFORE spending on a study that could blow the cap.
        if (summary.cost_usd + EST_PER_STUDY_USD > cap) {
          summary.errors.push({ stage: 'cost_cap', error: `cost cap $${cap} reached (spent $${summary.cost_usd.toFixed(3)})` });
          stop = true; break;
        }

        summary.studies_processed++;
        try {
          await processStudy(study, ctx);
        } catch (e) {
          summary.errors.push({ stage: 'study', nct_id: study.nct_id, error: e.message });
        }
      }
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
  } catch (e) {
    summary.errors.push({ stage: 'run', error: e.message });
  }

  summary.watermark_after = dryRun ? watermark : await getWatermark();
  summary.cost_usd = Number(summary.cost_usd.toFixed(4));

  if (!dryRun) {
    try {
      await logAgentActivity({
        agent_name: AGENT_NAME,
        action_type: 'ingest',
        reasoning: `Ingested ${summary.studies_new} new ClinicalTrials.gov studies`,
        output_summary: `new=${summary.studies_new} molecules=${summary.molecules_persisted} `
          + `dropped=${summary.molecules_dropped_low_confidence} matches=${summary.catalog_matches} `
          + `opps=${summary.sourcing_opportunities} cost=$${summary.cost_usd} errors=${summary.errors.length}`,
      });
    } catch { /* logging must never break the run */ }
  }
  return summary;
}

module.exports = { runResearchIntelIngest, AGENT_NAME };
