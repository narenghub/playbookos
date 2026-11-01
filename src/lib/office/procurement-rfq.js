// PlayNexa AI Office — K5/K6 + G: the first governed kernel AI workflow (Candidate B1).
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
//
//   "The AI model must not become chemical identity authority. The approved RFQ identity decision
//    remains authoritative. The AI may generate communication language from approved facts. It may
//    not change molecule identity, canonical CAS, substance/form, quantity, supplier, identity
//    eligibility or approval state. AI text generation sits AFTER scientific/commercial authority,
//    not above it."
//
// The pre-existing code already half-satisfied this by construction: the SUBJECT LINE is built
// from approved facts and never from model output, and generateRFQEmail throws unless it is handed
// facts carrying `__approvedByDecision` from the production-validated RFQ identity guard.
//
// WHAT WAS MISSING, AND IS THE POINT OF THIS FILE. Nothing checked the generated BODY. The prompt
// instructs the model not to invent figures, and an instruction is not a control. A model that
// writes "CAS 36282-47-0" into the prose of an RFQ whose approved identity is 27203-92-5 has
// changed the chemical identity of a message sent to three suppliers — the exact failure of
// 21 July 2026 — and every guard upstream would have passed.
//
// So the generated text is CONTAINED, not trusted:
//
//   • every registry-number-shaped token in the body must equal the APPROVED CAS;
//   • if no CAS was approved, the body may contain NO CAS at all — a model may not supply one the
//     identity decision declined to;
//   • the FILED (unapproved) CAS appearing in the body is refused by name, which preserves the
//     stale-filed-CAS negative control at the generation boundary as well as the decision boundary;
//   • quantity, purity and supplier in the envelope come from approved facts, never from the text.
//
// A violation REFUSES the send. It does not sanitize the text: silently editing a model's output
// to make it compliant would destroy the evidence that it was not.

const { governedCall } = require('./ai');
const { assertContext } = require('./context');

const AGENT = 'procurement-agent';
const WORKFLOW = 'governed-rfq-generation';

// A CAS registry number is 2–7 digits, 2 digits, 1 check digit. Deliberately loose on boundaries
// so a number embedded in prose is still caught; the comparison that follows is exact.
const CAS_SHAPE = /\b(\d{2,7})-(\d{2})-(\d)\b/g;

function casTokens(text) {
  const found = [];
  if (!text) return found;
  let m;
  const re = new RegExp(CAS_SHAPE.source, 'g');
  while ((m = re.exec(String(text))) !== null) found.push(m[0]);
  return found;
}

const digits = (v) => String(v == null ? '' : v).replace(/[^0-9-]/g, '');

/**
 * Check generated prose against the approved identity. Returns null when contained, or a refusal
 * reason. Pure, so it is directly testable without a provider.
 *
 * approvedCas — the CAS the identity decision approved, or null/undefined if it approved none
 * filedCas    — the CAS as filed on the RFQ row, which may be stale or contradictory
 */
function identityContainment(text, { approvedCas, filedCas }) {
  const found = casTokens(text);
  const approved = approvedCas ? digits(approvedCas) : null;
  const filed = filedCas ? digits(filedCas) : null;

  if (!found.length) return null;   // prose with no registry number cannot misstate one

  for (const token of found) {
    const t = digits(token);
    if (approved && t === approved) continue;

    // Named explicitly, because this is the 21 July failure mode and a generic "unapproved CAS"
    // message would not tell an operator that the model echoed the stale filed value.
    if (filed && t === filed && t !== approved) {
      return `generated text contains the FILED CAS ${token}, which the identity decision did not `
        + `approve${approved ? ` (approved: ${approvedCas})` : ' (no CAS was approved)'} — refusing rather than editing the model's output`;
    }
    return approved
      ? `generated text contains CAS ${token}, which is not the approved CAS ${approvedCas}`
      : `generated text contains CAS ${token}, but the identity decision approved NO CAS — a model may not supply one`;
  }
  return null;
}

/**
 * Generate an RFQ email under governance. The caller must already hold identity facts approved by
 * the RFQ identity guard; this function refuses to run on anything else.
 *
 * Returns { ok, subject, body, refusal, ai } — on a refusal `body` is null and nothing may be sent.
 */
async function renderGovernedRFQ(ctx, { approvedMol, supplier, rfqId, filedCas = null }, deps = {}) {
  assertContext(ctx);

  // The upstream authority check, restated here rather than assumed: this module must be unusable
  // with raw RFQ-row fields even if a future caller forgets what approved means.
  if (!approvedMol || approvedMol.__approvedByDecision === undefined || approvedMol.__approvedByDecision === null) {
    return { ok: false, refusal: 'identity_not_approved', body: null, subject: null,
      detail: 'renderGovernedRFQ requires identity facts approved by rfq-identity-guard; it must not re-derive identity from the RFQ row' };
  }
  if (!supplier || !supplier.name) {
    return { ok: false, refusal: 'no_supplier', body: null, subject: null };
  }

  const approvedName = approvedMol.molecule_name;
  const approvedCas = approvedMol.cas_number || null;
  const quantity = approvedMol.target_quantity || '25kg';
  const purity = approvedMol.target_purity || '99%';
  const gmpBlock = approvedMol.gmp_required
    ? '- GMP certificate and DMF availability (this is a GMP-grade requirement)\n' : '';

  // The ENVELOPE is built from approved facts. The model never contributes to it.
  const subject = `RFQ — ${approvedName}${approvedCas ? ` (${approvedCas})` : ''} — Abiozen LLC`;

  const prompt = `Write a professional pharmaceutical procurement RFQ email from a US API distributor to a supplier. Return ONLY the email body as plain text with line breaks (no subject line, no markdown, no preamble).

Supplier: ${supplier.name}${supplier.contact_name ? ' (attn: ' + supplier.contact_name + ')' : ''}
Molecule: ${approvedName}${approvedCas ? ' (CAS ' + approvedCas + ')' : ''}

Request, professionally worded, asking the supplier to quote:
- Price per kg for ${quantity}
- Purity specification (target ${purity})
${gmpBlock}- COA format / availability
- Lead time
- Minimum order quantity
- Sample availability (5-10 g for evaluation)

Tone: concise, courteous, industry-standard B2B pharma procurement. Open with a brief line about Abiozen sourcing this molecule for its US customers. Do NOT invent prices, volumes beyond those stated, or commitments.${approvedCas ? '' : ' Do NOT state any CAS number: none has been approved for this request.'} Close with the signature block exactly:

Palash Das
Procurement Director
Abiozen LLC
palash@abiozen.com`;

  const ai = await governedCall(ctx, {
    capability: 'fast',
    prompt,
    maxTokens: 900,
    agent: AGENT,
    workflow: WORKFLOW,
    purpose: `rfq:${rfqId || 'unknown'}:${supplier.id || supplier.name}`,
  }, deps);

  // An unaccounted or failed AI call produces no sendable artefact. governedCall already withholds
  // text it could not account for; this is the caller honouring that rather than reaching past it.
  if (!ai.ok) {
    return { ok: false, refusal: ai.accounted === false ? 'ai_not_accounted' : 'ai_unavailable',
      body: null, subject, ai, detail: ai.error };
  }

  const violation = identityContainment(ai.text, { approvedCas, filedCas });
  if (violation) {
    return { ok: false, refusal: 'ai_contradicted_approved_identity', body: null, subject, ai,
      detail: violation };
  }

  return { ok: true, subject, body: ai.text, ai,
    approved_by_decision: approvedMol.__approvedByDecision };
}

module.exports = { renderGovernedRFQ, identityContainment, casTokens, AGENT, WORKFLOW };
