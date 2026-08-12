// Clinical Demand Intelligence — Molecule Inference (infer-v1).
//
// PURE function: given a parsed study (from clinicaltrials.parseStudy) plus its
// classification (from classify.js), asks claude-sonnet-5 which specific chemical
// molecules a lab would need to PURCHASE to run the research. NO DB writes — the
// orchestrator persists each molecule into study_molecules and runs catalog match.
//
// Precision over recall: prefer FEWER, high-confidence molecules; [] is valid.
// Never guess a CAS number (null if unknown). Generic/chemical names, not brands.
const { parseClaudeJSON } = require('../../agent-core');

const INFER_MODEL = 'claude-sonnet-5';
const INFER_PROMPT_VERSION = 'infer-v1';

const MOLECULE_TYPES = ['api', 'reference_standard', 'metabolite', 'impurity', 'intermediate', 'tool_compound', 'other'];

function buildPrompt(study, classification) {
  const conditions = (study.conditions || []).join(', ');
  const interventions = (study.interventions || []).map(i => `${i.type || '?'}: ${i.name || ''}`).join('; ');
  const drugs = (study.molecules_mentioned || []).join(', ');
  const c = classification || {};
  return `You are a sourcing analyst for Abiozen LLC, a US API & specialty-chemical distributor. Given the classified clinical study below, infer the specific chemical molecules a lab would likely need to PURCHASE to conduct this research. Only list molecules with a real scientific basis in the study. PRECISION OVER RECALL — prefer FEWER, high-confidence entries over speculation.

STUDY:
Title: ${study.brief_title || '(none)'}
Therapeutic area: ${c.therapeutic_area || '(unknown)'} · Disease: ${c.disease || '(unknown)'} · Phase: ${study.phase || '(unknown)'}
Conditions: ${conditions || '(none)'}
Interventions: ${interventions || '(none)'}
Drug/biologic names mentioned: ${drugs || '(none)'}
Summary: ${c.summary || '(none)'}

Consider each category and include ONLY what is clearly implied:
- primary molecule(s): the drug substance(s)/API(s) under test
- reference_standard: analytical/USP reference standards for the API
- metabolite: known human/animal metabolites relevant to PK/PD work
- impurity: process/degradation impurities requiring qualification
- intermediate: key synthesis intermediates
- tool_compound: biomarker probes and assay reagents used to run the study
- isotope-labeled analogs (deuterated / 13C) where PK/mass-spec work is implied

Return ONLY this JSON, no prose, no code fences:
{
  "molecules": [
    {
      "molecule_name": "generic/chemical name, not a brand name",
      "cas_number": "string or null",
      "molecule_type": "api | reference_standard | metabolite | impurity | intermediate | tool_compound | other",
      "rationale": "one clause: why this molecule is needed for this study",
      "confidence": 0.0
    }
  ]
}

Rules:
- NEVER guess a CAS number — use null if you are not certain.
- Use generic/chemical names, never brand names.
- Empty "molecules": [] is valid when nothing is confidently inferable.
- confidence is 0-1 per molecule; drop anything you would rate below ~0.5.`;
}

// Infer molecules for one study. Returns { molecules:[...], prompt_version, model }
// on success or { error, prompt_version, model } on any failure (never throws).
async function inferMolecules(study, classification, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  const base = { prompt_version: INFER_PROMPT_VERSION, model: INFER_MODEL };
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured', ...base };
  const prompt = buildPrompt(study, classification);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: INFER_MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch (e) { return { error: 'Claude request failed: ' + e.message, ...base }; }
  if (!res.ok) return { error: `Claude ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, ...base };
  const text = (await res.json()).content?.[0]?.text || '';
  const data = parseClaudeJSON(text);
  if (!data || !Array.isArray(data.molecules)) return { error: 'unparseable molecule-inference JSON', ...base };

  const molecules = data.molecules.map(m => ({
    molecule_name: String(m && m.molecule_name || '').trim().slice(0, 300),
    cas_number: (m && typeof m.cas_number === 'string' && m.cas_number.trim()) ? m.cas_number.trim().slice(0, 40) : null,
    molecule_type: MOLECULE_TYPES.includes(m && m.molecule_type) ? m.molecule_type : 'other',
    rationale: String(m && m.rationale || '').trim().slice(0, 500),
    confidence: (m && typeof m.confidence === 'number') ? Math.min(1, Math.max(0, m.confidence)) : null,
  })).filter(m => m.molecule_name); // drop entries with no usable name

  return { molecules, ...base };
}

module.exports = { inferMolecules, buildPrompt, INFER_MODEL, INFER_PROMPT_VERSION, MOLECULE_TYPES };
