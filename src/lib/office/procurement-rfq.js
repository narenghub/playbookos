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
const scope = require('./scope');

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
    const refusal = ai.accounted === false ? 'ai_not_accounted' : 'ai_unavailable';
    // An unaccounted AI call is a governance failure, not a transient hiccup: it means spend
    // happened outside the budget's knowledge. A provider being unavailable is ordinary and does
    // not need a human, so only the accounting failure is queued.
    const exceptionId = refusal === 'ai_not_accounted'
      ? await fileException(ctx, { rfqId, severity: 'high', source: 'office/procurement-rfq',
        reason: `AI cost evidence could not be persisted for RFQ ${rfqId || '(unknown)'}, so the generated text was withheld. Spend may have occurred outside the budget: ${ai.error}`,
      }, deps)
      : null;
    return { ok: false, refusal, body: null, subject, ai, detail: ai.error, exception_id: exceptionId };
  }

  const violation = identityContainment(ai.text, { approvedCas, filedCas });
  if (violation) {
    // THIS MUST REACH A HUMAN. A model attempting to state a chemical identity the identity
    // decision refused is the 21 July failure mode caught one layer earlier — a refusal that
    // vanished into a return value would mean nobody ever learns the model tried.
    const exceptionId = await fileException(ctx, {
      rfqId, severity: 'critical', source: 'office/procurement-rfq',
      reason: `generated RFQ text contradicted the approved chemical identity and was refused: ${violation}`,
    }, deps);
    return { ok: false, refusal: 'ai_contradicted_approved_identity', body: null, subject, ai,
      detail: violation, exception_id: exceptionId };
  }

  return { ok: true, subject, body: ai.text, ai,
    approved_by_decision: approvedMol.__approvedByDecision };
}

// File a durable exception, adopting the K1 queue rather than inventing a second one. Never throws:
// the refusal must stand even if the queue is unavailable, and a queue failure is reported loudly
// rather than converted into a successful render.
async function fileException(ctx, { rfqId, severity, source, reason }, deps = {}) {
  const id = `ex-rfq-${ctx.runId}-${rfqId || 'unknown'}`;
  try {
    await scope.openException(ctx, {
      id, runId: ctx.runId, source, reason, severity,
      slaHours: severity === 'critical' ? 4 : 24,
    }, deps);
    return id;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[office/procurement-rfq] refusal recorded in the result but NOT queued: ${e.message}`);
    return null;
  }
}

// ── THE GOVERNED PROCUREMENT PATH (ruling §6) ───────────────────────────────
//
//   approved canonical identity facts → governed AI renderer → identity containment →
//   prepared action → blocking approval → release
//
// THE LEGACY GENERATOR IS NOT A FALLBACK. "Governed refusal → exception/review, not → legacy
// generator." So this function has no reference to generateRFQEmail at all: a refusal cannot fall
// back to it even by a future edit, because the symbol is not in scope here.
//
// IT PREPARES AND STOPS. It never sends, never claims a supplier, and returns the prepared
// communication with its approval id. Releasing it is a separate call that requires a recorded
// human decision and passes the fail-closed cost gate.
//
// Identity authority is the SAME object the live send path uses — guardSend from
// rfq-identity-guard — so the governed path cannot drift to a softer notion of "approved".
async function prepareGovernedRFQ(ctx, { rfqId, supplier }, deps = {}) {
  assertContext(ctx);
  const query = (deps && deps.query) || require('../db').query;
  // Injectable so the governed path is testable without the full molecule registry, but the
  // DEFAULT is the same object the live send path uses — the governed path must not be able to
  // drift to a softer notion of "approved".
  const guard = (deps && deps.guard) || require('../procurement/rfq-identity-guard');

  const rfq = (await query(
    `SELECT id, molecule_name, cas_number, target_quantity, target_purity, gmp_required, status
       FROM rfq_requests WHERE id = $1`, [rfqId]
  )).rows[0];
  if (!rfq) return { ok: false, refusal: 'no_such_rfq', rfqId };

  // The identity decision, persisted. A refusal here is the guard working: the RFQ's identity is
  // contested or unresolvable and no communication may be built from it.
  const decided = await guard.guardSend(query, rfq);
  if (!decided.allow) {
    const exceptionId = await fileException(ctx, {
      rfqId, severity: 'critical', source: 'office/procurement-rfq',
      reason: `RFQ ${rfqId} refused by the identity guard (${decided.reason}) — no supplier `
        + 'communication may be built from contested identity, and the legacy generator is NOT a fallback',
    }, deps);
    return { ok: false, refusal: 'identity_guard_refused', guard_reason: decided.reason,
      decision_id: decided.decisionId, exception_id: exceptionId, rfqId };
  }

  const approvedMol = {
    ...decided.approved,
    target_quantity: rfq.target_quantity,
    target_purity: rfq.target_purity,
    gmp_required: rfq.gmp_required,
  };

  const rendered = await renderGovernedRFQ(ctx, {
    approvedMol, supplier, rfqId, filedCas: rfq.cas_number,
  }, deps);
  if (!rendered.ok) {
    // Already queued by renderGovernedRFQ where it warrants a human. NO LEGACY FALLBACK.
    return { ok: false, refusal: rendered.refusal, detail: rendered.detail,
      exception_id: rendered.exception_id || null, ai: rendered.ai || null, rfqId };
  }

  // Prepared, not sent. The approval carries the EXACT communication, and the payload is immutable
  // from here, so what a human reads is what would go out.
  const approval = require('./approval');
  const prepared = await approval.prepare(ctx, {
    id: `ap-rfq-${rfqId}-${supplier.id || supplier.name}`,
    actionKind: 'send_rfq_email',
    actionPayload: {
      rfq_id: rfqId,
      supplier_id: supplier.id || null,
      supplier_name: supplier.name,
      to: supplier.contact_email || null,
      subject: rendered.subject,
      body: rendered.body,
      approved_molecule_name: approvedMol.molecule_name,
      approved_cas: approvedMol.cas_number || null,
      identity_decision_id: decided.decisionId,
    },
    reason: `supervised autonomy: a supplier communication for RFQ ${rfqId} requires human `
      + `approval before release. Identity decision ${decided.decisionId} approved `
      + `"${approvedMol.molecule_name}"${approvedMol.cas_number ? ` (${approvedMol.cas_number})` : ' with no CAS'}.`,
    ownerUserId: 'palash',
  }, deps);

  return {
    ok: true, rfqId,
    approvalId: prepared.approvalId,
    status: prepared.status,
    subject: rendered.subject,
    body: rendered.body,
    supplier,
    identity: {
      decision_id: decided.decisionId,
      approved_name: approvedMol.molecule_name,
      approved_cas: approvedMol.cas_number || null,
      filed_cas: rfq.cas_number || null,
    },
    ai: rendered.ai,
  };
}

module.exports = { renderGovernedRFQ, prepareGovernedRFQ, identityContainment, casTokens,
  fileException, AGENT, WORKFLOW };
