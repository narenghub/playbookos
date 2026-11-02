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
// ── THE SIGNATORY: THE ACTIVE HOLDER OF THE ROLE, OR NOBODY ─────────────────
//
// Preference order, and each step is deliberate:
//   1. the active procurement_director — whoever actually holds the job today
//   2. the active procurement team lead — procurement work still has an owner if the directorship
//      is vacant
//   3. the active admin/super_admin (the CEO) — a letter from the company's principal is honest
//   4. NOBODY → the render refuses
//
// `is_active = 1` is the whole point: a row left behind for a departed employee is not a
// signatory. It never falls back to a literal name, because that is the defect this replaces.
const SIGNATORY_TITLES = Object.freeze({
  procurement_director: 'Procurement Director',
  procurement_team: 'Procurement',
  admin: 'Chief Executive Officer',
  super_admin: 'Chief Executive Officer',
});

// Returns null, or { id, name, email, title, role, why, skipped[], fallback }.
//
// `why` and `skipped` exist because of ruling §6: "the human identity must be understandable
// before money is spent on generation." A resolver that returns only a name leaves the operator
// unable to tell a correct selection from a lucky one — and the case that matters is precisely
// when a HIGHER-priority candidate was passed over because they are no longer active.
const PROCUREMENT_ROLES = Object.freeze(['procurement_director', 'procurement_team']);

async function resolveSignatory(deps = {}) {
  const query = (deps && deps.query) || require('../db').query;
  if (deps && deps.signatory) return deps.signatory;   // injectable for fixtures only

  const skipped = [];
  const consider = (rows, role) => {
    for (const r of rows) {
      if (Number(r.is_active) === 1 && r.name && r.email) return r;
      skipped.push({ name: r.name, email: r.email, role,
        reason: Number(r.is_active) === 1 ? 'no name or email on the user row' : 'not active' });
    }
    return null;
  };

  for (const role of PROCUREMENT_ROLES) {
    const rows = (await query(
      `SELECT id, name, email, role, is_active FROM users WHERE role = $1
        ORDER BY is_active DESC, created_at`, [role])).rows;
    const hit = consider(rows, role);
    if (hit) {
      return { id: hit.id, name: hit.name, email: hit.email,
        title: SIGNATORY_TITLES[hit.role] || 'Procurement', role: hit.role,
        why: `active ${hit.role}`, skipped, fallback: false };
    }
  }

  const rows = (await query(
    `SELECT id, name, email, role, is_active FROM users WHERE role IN ('admin','super_admin')
      ORDER BY is_active DESC, CASE WHEN LOWER(email) LIKE 'naren%' THEN 0 ELSE 1 END, created_at`)).rows;
  const ceo = consider(rows, 'admin/super_admin');
  if (ceo) {
    return { id: ceo.id, name: ceo.name, email: ceo.email,
      title: SIGNATORY_TITLES[ceo.role] || 'Chief Executive Officer', role: ceo.role,
      why: `no active procurement_director or procurement_team, so the resolution fell back to an `
        + `active ${ceo.role}`,
      skipped, fallback: true };
  }
  return null;
}

// ── WHO ELSE AT ABIOZEN IS ON THE LETTER ────────────────────────────────────
//
// "Both of us handle it": the signatory signs, and the company's principal is copied so supplier
// replies reach both. The copy contact is RESOLVED FROM A ROLE for the same reason the signatory
// is — hardcoding an address here would recreate, in a different field, precisely the defect that
// put a departed Procurement Director's name on two supplier letters.
//
// A copy contact is a RECIPIENT, not the represented authority. So:
//   · it is frozen into the payload, like everything else a human approves
//   · its absence is NOT a refusal — a letter with one contact is still a valid letter
//   · release revalidates the SIGNATORY only; a copied colleague who has left means an internal
//     bounce, not a letter sent over the name of someone who is gone
//
// The signatory is excluded, so nobody is both signer and copy.
async function resolveCopyContacts(deps = {}, signatory = null) {
  const query = (deps && deps.query) || require('../db').query;
  if (deps && deps.copyContacts) return deps.copyContacts;   // fixtures only

  const rows = (await query(
    `SELECT id, name, email, role FROM users
      WHERE is_active = 1 AND role IN ('admin','super_admin') AND email IS NOT NULL
      ORDER BY CASE WHEN LOWER(email) LIKE 'naren%' THEN 0 ELSE 1 END, created_at`)).rows;

  // EXACTLY ONE. The first version took `.slice(0, 2)` — "the principal, and at most one more" —
  // and on the first real preparation that copied a second admin at a DIFFERENT COMPANY'S DOMAIN
  // onto an Abiozen letter to a supplier. The instruction was "both of us handle it": the
  // signatory signs, the principal is copied. Two people, not a distribution list that grows
  // whenever somebody is given an admin role.
  //
  // super_admin outranks admin, because "the principal" is a specific person and not a permission
  // level that several people may happen to hold.
  const eligible = rows.filter((r) => !signatory || (r.id !== signatory.id
    && String(r.email).toLowerCase() !== String(signatory.email).toLowerCase()));
  const principal = eligible.find((r) => r.role === 'super_admin') || eligible[0] || null;
  return principal
    ? [{ id: principal.id, name: principal.name, email: principal.email, role: principal.role }]
    : [];
}

async function renderGovernedRFQ(ctx, { approvedMol, supplier, rfqId, filedCas = null }, deps = {}) {
  assertContext(ctx);

  // The upstream authority check, restated here rather than assumed: this module must be unusable
  // with raw RFQ-row fields even if a future caller forgets what approved means.
  if (!approvedMol || approvedMol.__approvedByDecision === undefined || approvedMol.__approvedByDecision === null) {
    return { ok: false, refusal: 'identity_not_approved', body: null, subject: null,
      detail: 'renderGovernedRFQ requires identity facts approved by rfq-identity-guard; it must not re-derive identity from the RFQ row' };
  }

  // ── WHO THE COMMUNICATION CLAIMS TO BE FROM IS NOT A CONSTANT ─────────────
  //
  // This signature block was three hardcoded lines inside the prompt: a name, a title and an
  // email address. On 2 Nov 2026 two real supplier RFQs were prepared signed by a Procurement
  // Director who had LEFT THE ORGANIZATION, with his address as the reply-to. Nothing failed,
  // nothing warned, and every future RFQ would have carried his name indefinitely.
  //
  // A person's employment is live data, so it is READ, and read from the same authority the rest
  // of the codebase uses: the active holder of the role in `users`. And it FAILS CLOSED — if no
  // active signatory can be resolved, no communication is rendered at all. Defaulting to a name,
  // any name, is how a departed employee ends up signing a letter to a supplier.
  const signatory = await resolveSignatory(deps);
  if (!signatory) {
    return { ok: false, refusal: 'no_active_signatory', body: null, subject: null,
      detail: 'no active procurement_director (or admin fallback) exists in users, so there is '
        + 'nobody this RFQ can honestly be from — refusing rather than signing a name' };
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

${signatory.name}
${signatory.title}
Abiozen LLC
${signatory.email}`;

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

  return { ok: true, subject, body: ai.text, ai, signatory,
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

  // Resolved AFTER the render, so the copy list cannot influence what the model wrote, and frozen
  // into the payload below with everything else the human approves.
  const copyTo = await resolveCopyContacts(deps, rendered.signatory);

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
      // Frozen into the payload deliberately: the person the supplier would reply to is part of
      // what a human is approving, and it must not be re-derived at release time from a users
      // table that may have changed since.
      signed_by_name: rendered.signatory.name,
      signed_by_title: rendered.signatory.title,
      signed_by_email: rendered.signatory.email,
      // The authoritative identifier, not just the display fields: release revalidates the
      // authority by id first and email second, so a renamed or re-addressed person is still the
      // same person, and two people sharing a name are not confused for one.
      signed_by_user_id: rendered.signatory.id || null,
      signed_by_role: rendered.signatory.role || null,
      // Frozen: who else at Abiozen the supplier's reply reaches. Part of what is approved.
      cc: copyTo.map((c) => c.email),
      cc_names: copyTo.map((c) => c.name),
      cc_user_ids: copyTo.map((c) => c.id),
    },
    reason: `supervised autonomy: a supplier communication for RFQ ${rfqId} requires human `
      + `approval before release. Identity decision ${decided.decisionId} approved `
      + `"${approvedMol.molecule_name}"${approvedMol.cas_number ? ` (${approvedMol.cas_number})` : ' with no CAS'}.`
      + ` Signed by ${rendered.signatory.name} (${rendered.signatory.title}).`,
    // The OWNER is the resolved signatory, not a hardcoded login. An approval queued to a
    // departed employee is an approval nobody will ever make, and it was `ownerUserId: 'palash'`
    // until a Procurement Director left and two real RFQs were queued to him.
    ownerUserId: rendered.signatory.id || rendered.signatory.email,
  }, deps);

  return {
    ok: true, rfqId,
    approvalId: prepared.approvalId,
    status: prepared.status,
    subject: rendered.subject,
    body: rendered.body,
    supplier,
    signatory: rendered.signatory,
    copyTo,
    identity: {
      decision_id: decided.decisionId,
      approved_name: approvedMol.molecule_name,
      approved_cas: approvedMol.cas_number || null,
      filed_cas: rfq.cas_number || null,
    },
    ai: rendered.ai,
  };
}

// ── §12: THE GOVERNED-OFFICE PROCUREMENT ENTRY POINT ────────────────────────
//
// This is the wiring, and it is deliberately a SEPARATE ENTRY POINT rather than a change to the
// existing weekly procurement cron. "Wire renderGovernedRFQ into governed-office procurement only.
// Do not globally replace unrelated procurement execution." The Tuesday cron
// (weekly-tue-9cst-procurement-rfqs) is untouched and still uses the path it always did.
//
// The required chain, and where each link is:
//
//   canonical identity decision  → guardSend, in prepareGovernedRFQ (the SAME authority the live
//                                  send path uses, so the governed path cannot drift to a softer
//                                  notion of "approved")
//   governed AI rendering        → renderGovernedRFQ → office/ai.js governedCall
//   output containment           → identityContainment, which REFUSES rather than sanitising
//   durable cost / provenance    → office_cost_ledger via governedCall; the run carries company
//                                  and objective by K1's composite key
//   prepared action              → office_approvals, payload immutable from insert
//   blocking approval            → status 'pending'; release is a separate recorded decision
//   release                      → NOT HERE. This function prepares and stops.
//
// WHAT IT CANNOT DO. It cannot send: no mailer, no outreach module and no supplier-claim call is
// reachable from this file, which an architectural assertion in the fixture suite checks on the
// require graph rather than trusting this comment. It cannot run against a draft objective —
// beginObjectiveRun resolves the context, which refuses anything but `active`. It cannot run twice
// in a day for one objective: the day-slot intent key makes the second attempt a duplicate, which
// is the wanted behaviour when the deliverable is "exactly one RFQ".
//
// THE SUPPLIER IS NAMED BY THE CALLER AND LOADED FROM THE DATABASE. The AI does not choose it.
// Supplier selection is a commercial decision; letting the renderer pick would put the model in
// authority over who Abiozen contacts, which is the same class of mistake as letting it decide
// chemical identity.
async function runGovernedProcurement({ objectiveId, rfqId, supplierId, trigger = 'manual',
  triggerDetail = null }, deps = {}) {
  if (!objectiveId) throw new Error('runGovernedProcurement requires an objectiveId');
  if (!rfqId) throw new Error('runGovernedProcurement requires an rfqId');
  if (!supplierId) throw new Error('runGovernedProcurement requires a supplierId — the AI does not choose the supplier');

  const query = (deps && deps.query) || require('../db').query;

  // Authoritative supplier facts, read from the row. A caller-supplied email address would be an
  // unverified destination for a real communication.
  const supplier = (await query(
    `SELECT id, name, contact_email, contact_name, country, region FROM suppliers WHERE id = $1`,
    [supplierId]
  )).rows[0];
  if (!supplier) return { ok: false, refusal: 'no_such_supplier', supplierId };
  if (!supplier.contact_email) {
    return { ok: false, refusal: 'supplier_has_no_contact_email', supplierId, supplier_name: supplier.name };
  }

  // ── THE INTENT IS THE (OBJECTIVE, RFQ, SUPPLIER) TRIPLE, NOT THE DAY ──────
  //
  // beginObjectiveRun's default key is `office:<workflow>:<objective>:<date>`, which makes every
  // governed procurement run for one objective the same intent for a whole day. That is wrong
  // here, and the way it is wrong matters: a run REFUSED BY THE IDENTITY GUARD still opened, so it
  // consumed the day's only slot. Picking a cas_disputed RFQ by mistake would then block preparing
  // the correct one until tomorrow — a guard refusal, which is the system working, would lock out
  // the work it was protecting.
  //
  // "Prepare an RFQ for this molecule to this supplier" is the actual unit of intent, and it is
  // the same granularity as the deterministic approval id below. The date stays in the key so a
  // deliberate follow-up to the same supplier on a later day remains possible; preparing the same
  // pair twice in a day is still one intent.
  const { objectiveIntentKey } = require('../runs');
  const dayKey = objectiveIntentKey(WORKFLOW, objectiveId);
  const intentKey = `${dayKey}:${rfqId}:${supplier.id}`;

  const { beginObjectiveRun } = require('./run');
  const begun = await beginObjectiveRun({
    objectiveId, trigger, triggerDetail, workflow: WORKFLOW, agent: AGENT,
    maxRuntimeMinutes: 15, intentKey,
  }, deps);

  if (begun.duplicate) {
    return { ok: false, refusal: 'duplicate_intent', intentKey: begun.intentKey,
      detail: 'a governed procurement run for this objective already exists for today — '
        + 'a second run is not a second intent' };
  }

  const L = (deps && deps.ledger)
    || require('../run-ledger').ledger({ query: (deps && deps.query) || undefined });
  await L.startRun(begun.runId);

  let out;
  try {
    out = await prepareGovernedRFQ(begun.context, { rfqId, supplier }, deps);
  } catch (e) {
    await L.finish(begun.runId, { error: e.message });
    throw e;
  }

  // A governed REFUSAL is the system working, not the run failing — the exception it filed is the
  // deliverable in that case. The terminal state is left to the ledger to DERIVE from the recorded
  // events rather than asserted here, because a caller that names its own terminal state can
  // report success over a run that did nothing (the K2 defect).
  const fin = await L.finish(begun.runId);

  return {
    ...out,
    runId: begun.runId,
    objectiveId,
    companyId: begun.context.companyId,
    workflow: WORKFLOW,
    agent: AGENT,
    runState: fin.state,
    sent: false,     // stated, never inferred: this path has no send capability at all
  };
}

module.exports = { renderGovernedRFQ, prepareGovernedRFQ, runGovernedProcurement,
  resolveSignatory, resolveCopyContacts, identityContainment, casTokens, fileException,
  AGENT, WORKFLOW };
