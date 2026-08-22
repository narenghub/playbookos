// Clinical Demand Intelligence — Study Classification (classify-v1).
//
// PURE function: takes a parsed study (from clinicaltrials.parseStudy) and asks
// claude-sonnet-5 to extract therapeutic area / disease / biomarkers / summary and
// whether it's a drug-interventional study. NO DB writes — the orchestrator
// persists the result onto clinical_studies (therapeutic_area, disease, biomarkers,
// classification_summary, classification_confidence, classify_prompt_version).
//
// PHASE is deliberately NOT classified here — it's authoritative from
// clinicaltrials.js (CT.gov's structured phase enum). Always trust the source.
const { callClaude } = require('../../llm');

const CLASSIFY_MODEL = 'claude-sonnet-5';
const CLASSIFY_PROMPT_VERSION = 'classify-v1';

const THERAPEUTIC_AREAS = [
  'Oncology', 'Metabolic/Endocrine', 'Cardiovascular', 'Neurology/CNS',
  'Infectious Disease', 'Immunology/Inflammation', 'Respiratory',
  'Dermatology', 'Rare Disease', 'Other',
];

function buildPrompt(study) {
  const conditions = (study.conditions || []).join(', ');
  const interventions = (study.interventions || []).map(i => `${i.type || '?'}: ${i.name || ''}`).join('; ');
  return `You are a pharmaceutical research analyst for Abiozen LLC, a US API & specialty-chemical distributor. Classify the clinical study below into structured fields. Use ONLY the information given — do not invent facts.

STUDY:
Title: ${study.brief_title || '(none)'}
Conditions: ${conditions || '(none)'}
Interventions: ${interventions || '(none)'}
Lead sponsor: ${study.lead_sponsor_name || '(unknown)'} (${study.sponsor_type || 'unknown'})
Study type: ${study.study_type || '(unknown)'}

Return ONLY this JSON, no prose, no code fences:
{
  "therapeutic_area": "one of: ${THERAPEUTIC_AREAS.join(', ')}",
  "disease": "the specific indication (e.g. 'Type 2 Diabetes', 'Non-small cell lung cancer') or null",
  "biomarkers": ["string", "..."],
  "summary": "1-2 sentence plain-language summary of what is being tested",
  "is_drug_interventional": true,
  "confidence": 0.0
}

Rules:
- biomarkers = [] if none are stated.
- disease = null if no specific indication is clear.
- confidence 0-1 reflects how clearly the study text supports the classification.
- Set is_drug_interventional=false if the study tests a device, behavior, procedure, diet, or supplement rather than a drug/biologic.`;
}

// Classify one study. Returns a normalized object (never throws) or { error }.
// The result carries `prompt_version` for A/B tracking regardless of outcome.
async function classifyStudy(study, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured', prompt_version: CLASSIFY_PROMPT_VERSION };
  const prompt = buildPrompt(study);
  const r = await callClaude({ model: CLASSIFY_MODEL, prompt, maxTokens: 700, expectJson: true, apiKey });
  if (r.error) return { error: r.error, prompt_version: CLASSIFY_PROMPT_VERSION };
  const data = r.json;
  if (!data) return { error: 'unparseable classification JSON', prompt_version: CLASSIFY_PROMPT_VERSION };

  return {
    therapeutic_area: THERAPEUTIC_AREAS.includes(data.therapeutic_area) ? data.therapeutic_area : 'Other',
    disease: (data.disease && String(data.disease).trim()) ? String(data.disease).trim().slice(0, 300) : null,
    biomarkers: Array.isArray(data.biomarkers) ? data.biomarkers.map(String).map(s => s.trim()).filter(Boolean) : [],
    summary: String(data.summary || '').slice(0, 1000),
    is_drug_interventional: data.is_drug_interventional !== false, // default true unless explicitly false
    confidence: typeof data.confidence === 'number' ? Math.min(1, Math.max(0, data.confidence)) : null,
    usage: r.usage, // {input_tokens, output_tokens} — orchestrator sums for cost cap
    prompt_version: CLASSIFY_PROMPT_VERSION,
    model: CLASSIFY_MODEL,
  };
}

module.exports = { classifyStudy, buildPrompt, CLASSIFY_MODEL, CLASSIFY_PROMPT_VERSION, THERAPEUTIC_AREAS };
