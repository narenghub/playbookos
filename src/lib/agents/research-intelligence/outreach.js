// Clinical Demand Intelligence — Phase 3 outreach generation (pure, never-throws).
//
// Given a study + one enriched contact + the study's molecules, writes a SHORT,
// personalized, MANUAL-COPY plain-text email (no HTML template — a human copies it
// and sends from sales@abiozen.com). Role-aware framing (procurement vs R&D/CMC) and
// status-aware framing (catalog_match "we supply" vs sourcing_opportunity "we can
// source"). Reuses the email-engine VERIFIED-FACTS anti-hallucination discipline.
//
// Returns { subject, body, referenced_molecules, prompt_version, model } on success,
// { skipped, ... } when there is nothing actionable to pitch, or { error, ... } on any
// failure. Never throws. The signature is appended deterministically (the model is told
// NOT to write one) so it is always exact.
const { parseClaudeJSON, extractClaudeText } = require('../../agent-core');

const OUTREACH_MODEL = 'claude-opus-4-8';
const OUTREACH_PROMPT_VERSION = 'outreach-v1';
const MAX_TOKENS = 1500;
const MAX_MOLECULES = 5;

const SIGNATURE = 'Best regards,\n\nBusiness Development\nAbiozen LLC\nsales@abiozen.com';

const ROLE_FRAMING = {
  procurement: 'Procurement / sourcing — emphasize supply reliability, US-based distribution, and a willingness to provide documentation and a quote on request.',
  rd_cmc: 'R&D / CMC / drug-substance — emphasize technical fit: APIs, reference standards, impurities/metabolites for analytical and PK work, and early-phase quantities.',
  other: 'General contact — keep it brief and offer to connect them with the right person for sourcing.',
};

// Actionable = we can actually pitch it (in catalog or sourceable). 'unknown' is not.
function isActionable(m) {
  return m && (m.catalog_match_status === 'catalog_match' || m.catalog_match_status === 'sourcing_opportunity');
}

// Prioritize + cap: catalog_match before sourcing_opportunity (strongest pitch first),
// then by molecule_type (api/reference_standard lead), then by inference_confidence desc.
function selectMolecules(molecules) {
  const statusRank = { catalog_match: 0, sourcing_opportunity: 1 };
  const typeRank = { api: 0, reference_standard: 1, metabolite: 2, impurity: 3, intermediate: 4, tool_compound: 5, other: 6 };
  return (molecules || []).filter(isActionable).slice().sort((a, b) => {
    const s = (statusRank[a.catalog_match_status] ?? 9) - (statusRank[b.catalog_match_status] ?? 9);
    if (s) return s;
    const t = (typeRank[a.molecule_type] ?? 9) - (typeRank[b.molecule_type] ?? 9);
    if (t) return t;
    const ca = (typeof a.inference_confidence === 'number') ? a.inference_confidence : 0;
    const cb = (typeof b.inference_confidence === 'number') ? b.inference_confidence : 0;
    return cb - ca;
  }).slice(0, MAX_MOLECULES);
}

function buildPrompt(study, contact, molecules) {
  const first = (contact.first_name || String(contact.full_name || '').split(' ')[0] || 'there').trim();
  const frame = ROLE_FRAMING[contact.role_category] || ROLE_FRAMING.other;
  const molLines = molecules.map(m => {
    const status = m.catalog_match_status === 'catalog_match'
      ? 'Abiozen CURRENTLY SUPPLIES this — may be offered as available'
      : 'SOURCING OPPORTUNITY — Abiozen can SOURCE/quote this; NEVER claim current stock';
    return `- ${m.molecule_name}${m.cas_number ? ' (CAS ' + m.cas_number + ')' : ''} [${m.molecule_type}] — ${status}`;
  }).join('\n');

  return `You are writing a SHORT, personalized B2B sourcing email for Abiozen LLC, a US-based pharmaceutical API & specialty-chemical distributor. The recipient is a real person at a company running a clinical trial. A person at Abiozen will send it MANUALLY — write a genuine person-to-person note, not a marketing blast.

RECIPIENT:
Name: ${contact.full_name || first}
Title: ${contact.title || '(unknown)'}
Company: ${contact.organization_name || study.lead_sponsor_name || '(their company)'}
Role focus: ${frame}

PUBLIC TRIAL CONTEXT (the genuine reason for reaching out — reference it specifically):
Trial: ${study.nct_id || '(no id)'} — ${study.brief_title || ''}
Phase: ${study.phase || 'n/a'} · Indication: ${study.disease || study.therapeutic_area || 'n/a'}
Sponsor: ${study.lead_sponsor_name || contact.organization_name || ''}

MOLECULES YOU MAY MENTION (the ONLY molecules allowed — do not invent or add any others):
${molLines}

STRICT RULES (anti-hallucination — breaking any makes the email unusable):
- Reference ONLY the molecules listed above. Never invent molecules, quantities, or CAS numbers.
- Never state or imply a PRICE, delivery timeline, GMP status, COA/SDS availability, or any certification — offer to discuss specifics instead.
- For "SOURCING OPPORTUNITY" molecules, never claim stock — say we can source/quote.
- Do not claim any prior relationship, meeting, or correspondence.
- The only facts you may assert: the public trial (by NCT id), the molecule names above, and that Abiozen is a US API & specialty-chemical distributor.

WRITE:
- One short email, ~90-130 words, 2-3 short paragraphs.
- Greeting using the first name: "Hi ${first},".
- Para 1: reference the specific trial (${study.nct_id || 'the trial'}) and why it prompted the note.
- Para 2: connect it to the molecule(s) above and how Abiozen can help (supply or source), tailored to their role.
- Close with a low-friction CTA (a quick reply, a short call, or "happy to share specs/a quote").
- Do NOT write a signature or sign-off — it is appended separately. End after the CTA line.
- Plain text only. No emoji, no ALL CAPS, no exclamation marks, no markdown.

Subject line: under 70 characters, specific, references the molecule or trial. No "Re:", no emoji.

Return ONLY this JSON, no prose, no code fences:
{"subject":"...","body":"greeting + paragraphs as plain text with \\n line breaks, NO signature","referenced_molecules":["exact molecule name","..."]}`;
}

// Generate one outreach email. study/contact/molecules are plain objects. Never throws.
async function generateOutreach(study, contact, molecules, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  const base = { prompt_version: OUTREACH_PROMPT_VERSION, model: OUTREACH_MODEL };
  const selected = selectMolecules(molecules);
  if (!selected.length) return { skipped: 'no actionable molecules', molecules_available: (molecules || []).length, ...base };
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured', ...base };
  if (!contact || !(contact.full_name || contact.first_name)) return { error: 'contact name required', ...base };

  const prompt = buildPrompt(study, contact, selected);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: OUTREACH_MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch (e) { return { error: 'Claude request failed: ' + e.message, ...base }; }
  if (!res.ok) return { error: `Claude ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, ...base };

  const respBody = await res.json();
  const data = parseClaudeJSON(extractClaudeText(respBody));
  if (!data || !data.subject || !data.body) return { error: 'unparseable outreach JSON', ...base };

  // Signature is deterministic — append it (model was told not to write one).
  let body = String(data.body).trim();
  if (!/sales@abiozen\.com/i.test(body)) body += '\n\n' + SIGNATURE;

  // referenced_molecules: intersect the model's claim with what we actually gave it
  // (guards against invented names); fall back to the selected set.
  const selectedNames = selected.map(m => m.molecule_name);
  const lc = new Set(selectedNames.map(n => n.toLowerCase()));
  let referenced = Array.isArray(data.referenced_molecules)
    ? data.referenced_molecules.map(String).filter(n => lc.has(n.toLowerCase()))
    : [];
  if (!referenced.length) referenced = selectedNames;

  return {
    subject: String(data.subject).trim().slice(0, 200),
    body,
    referenced_molecules: referenced,
    molecules_available: (molecules || []).length,   // total molecules passed in
    molecules_referenced: referenced.length,          // how many made it into the email
    usage: respBody.usage || null,                    // {input_tokens, output_tokens} for cost tracking
    ...base,
  };
}

module.exports = { generateOutreach, buildPrompt, selectMolecules, SIGNATURE, ROLE_FRAMING, OUTREACH_MODEL, OUTREACH_PROMPT_VERSION, MAX_MOLECULES };
