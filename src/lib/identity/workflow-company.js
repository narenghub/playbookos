// ── WHICH COMPANY A SCHEDULED WORKFLOW ACTS FOR ─────────────────────────────
//
// THE SOLE ACCESSOR for `workflow_companies`. No other module may read or write that table in SQL;
// scripts/check-identity-accessor-discipline.js fails the build if one does. Same reason as the
// membership accessor: a six-condition authorization predicate kept correct by discipline is not
// kept correct, so callers never write it because they are never given the table name.
//
// ── WHY THIS TABLE EXISTS (owner decision 2026-11-24, Option A) ─────────────
//
// Agent work resolves its company from the run row. A person's session resolves it from their
// membership. A CRON has neither — no authenticated subject, no run — and the sends that matter
// most for the operating loop are crons: the 7am CEO briefing, the 8am assignments, the 6pm
// coaching mail. Without a company they cannot be internal, so they stay stopped regardless of
// what else is fixed.
//
// This is the bridge. Option B migrates those workflows into governed runs, and each mapping is
// retired as its governed replacement is verified.
//
// ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
//
//   · no default company, and no "the only active company" — that is the guess office/context.js
//     refused to make for read sessions, and it would be the same guess here
//   · no email-domain derivation — the inference that stopped all company email on 2026-11-03
//   · no caller-supplied company — the caller names a WORKFLOW; the company is read from a row
//   · no choosing between several — a workflow authorized for two companies has two rows and is
//     executed once per company, so ambiguity is a refusal rather than a selection. The scheduler
//     fans out; the resolver never picks.
//
// ── EVERY REFUSAL IS ACTIONABLE ─────────────────────────────────────────────
//
// Owner requirement 4: a missing, ambiguous, revoked or suspended mapping must refuse AND produce
// an actionable audit record. So refusals here are structured values — `{ ok: false, code, detail,
// workflow, candidates }` — not bare throws and not booleans. A caller can file the code, and an
// operator reading it learns which of the four it was and what to do about it. `unresolvable`
// after an outage is not the same operational problem as `not_mapped`, and a single "no company"
// would have hidden that difference.

'use strict';

const q = (deps) => (deps && deps.query) || require('../db').query;

/** Returned by readers when the question could not be answered at all. See membership.js. */
const UNKNOWN = null;

const REFUSAL = Object.freeze({
  NOT_MAPPED: 'not_mapped',
  AMBIGUOUS: 'ambiguous',
  UNRESOLVABLE: 'unresolvable',
});

// A live mapping: active, not revoked, inside its window, and pointing at an ACTIVE company. A
// suspended or archived company authorizes nothing, exactly as in the membership predicate — the
// two rules are deliberately the same shape so neither drifts into being the lenient one.
// $1 is the instant to evaluate at, or NULL meaning "now" — and "now" is the DATABASE's now, for
// the reason set out at length over company-membership.js's own LIVE predicate: `effective_from` is
// written by Postgres NOW() with microsecond precision, a JavaScript Date carries only
// milliseconds, and a client-supplied default therefore excluded a row it had itself just written
// in 142 of 200 measured trials. Two clocks, one comparison, and the faster clock wrote the column.
const LIVE = `
       wc.status = 'active'
   AND wc.revoked_at IS NULL
   AND wc.effective_from <= COALESCE($1::timestamptz, NOW())
   AND (wc.effective_to IS NULL OR wc.effective_to > COALESCE($1::timestamptz, NOW()))
   AND c.status = 'active'
`;

const FROM = `
  FROM workflow_companies wc
  JOIN companies c ON c.id = wc.company_id
`;

/**
 * Every company this workflow is currently authorized to act for.
 *
 * @returns {Promise<string[]|null>} company ids, ascending; null when unknowable.
 */
async function companiesForWorkflow(workflow, { at = null, ...deps } = {}) {
  if (!workflow) return [];
  try {
    const r = await q(deps)(
      `SELECT wc.company_id AS id ${FROM}
       WHERE wc.workflow = $2 AND ${LIVE}
       ORDER BY wc.company_id`,
      [at, String(workflow)]);
    return r.rows.map((x) => x.id);
  } catch (_) {
    return UNKNOWN;
  }
}

/**
 * The ONE company this scheduled workflow acts for, or a structured refusal.
 *
 * @returns {Promise<{ok:true, companyId:string}|{ok:false, code:string, detail:string,
 *   workflow:string, candidates:string[]}>}
 */
async function resolveWorkflowCompany(workflow, opts = {}) {
  const ids = await companiesForWorkflow(workflow, opts);

  if (ids === UNKNOWN) {
    return { ok: false, code: REFUSAL.UNRESOLVABLE, workflow: String(workflow), candidates: [],
      detail: 'the workflow-to-company mapping could not be read, so which company this workflow '
        + 'acts for is UNKNOWN. Refusing rather than assuming: an unreadable mapping table is not '
        + 'an unmapped workflow, and the two need different operator action.' };
  }
  if (ids.length === 0) {
    return { ok: false, code: REFUSAL.NOT_MAPPED, workflow: String(workflow), candidates: [],
      detail: `no active company mapping exists for workflow "${workflow}". A scheduled workflow `
        + 'acts for a company only when an authorized administrator has said so — there is no '
        + 'default company and none is inferred from a sender address. Map it explicitly, or leave '
        + 'it unmapped and it will keep refusing.' };
  }
  if (ids.length > 1) {
    return { ok: false, code: REFUSAL.AMBIGUOUS, workflow: String(workflow), candidates: ids,
      detail: `workflow "${workflow}" is authorized for ${ids.length} companies (${ids.join(', ')}). `
        + 'A single execution must not span companies, so the scheduler runs it once PER company '
        + 'with that company resolved — it does not choose one here.' };
  }
  return { ok: true, companyId: ids[0] };
}

// ── WRITES: A MAPPING IS AN AUTHORIZATION, SO SOMEBODY OWNS IT ──────────────
//
// Both writers go through the membership accessor's actor check, so "who may map a workflow to a
// company" has exactly one answer in this system rather than a second, slightly different one
// here. Authority is company-scoped: an administrator of Adifice cannot point a workflow at
// ABIOZEN. There is deliberately no self-grant exemption to re-state, because a workflow is not a
// person — the actor rule that applies is the company one.

function manager() { return require('./company-membership'); }

async function mapWorkflowToCompany({ workflow, companyId, grantedBy, grantedReason = null,
  effectiveFrom = null, effectiveTo = null, id = null }, deps = {}) {
  for (const [k, v] of Object.entries({ workflow, companyId, grantedBy })) {
    if (!v) throw new Error(`mapWorkflowToCompany requires ${k} — a mapping with no ${k} is an authorization nobody owns`);
  }
  await manager().assertActorMayManage({ actorUserId: grantedBy, companyId }, deps);

  const rowId = id || `wfc-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const r = await q(deps)(
    `INSERT INTO workflow_companies
       (id, workflow, company_id, status, effective_from, effective_to, granted_by, granted_reason)
     VALUES ($1,$2,$3,'active',COALESCE($4, NOW()),$5,$6,$7)
     RETURNING id, workflow, company_id, status, effective_from, effective_to`,
    [rowId, String(workflow), String(companyId), effectiveFrom, effectiveTo,
      String(grantedBy), grantedReason]);
  return r.rows[0];
}

/**
 * Withdraw one mapping. Scoped by construction: it names a company, so it cannot reach another.
 *
 * `retiredForGovernedRun` marks the Option B case — this workflow now runs as a governed run, so
 * the bridge is no longer needed. Recorded separately because "retired because the real thing
 * works now" and "revoked because it should not have been authorized" are different facts, and a
 * reader six months from now cannot tell them apart from a timestamp.
 */
async function unmapWorkflow({ workflow, companyId, revokedBy, revokedReason = null,
  retiredForGovernedRun = false }, deps = {}) {
  for (const [k, v] of Object.entries({ workflow, companyId, revokedBy })) {
    if (!v) throw new Error(`unmapWorkflow requires ${k}`);
  }
  await manager().assertActorMayManage({ actorUserId: revokedBy, companyId }, deps);

  const r = await q(deps)(
    `UPDATE workflow_companies
        SET status = 'revoked', revoked_at = NOW(), revoked_by = $3, revoked_reason = $4,
            retired_for_governed_run = $5
      WHERE workflow = $1 AND company_id = $2 AND status = 'active'
      RETURNING id, workflow, company_id, retired_for_governed_run`,
    [String(workflow), String(companyId), String(revokedBy), revokedReason,
      Boolean(retiredForGovernedRun)]);
  return { revoked: r.rows.length, rows: r.rows };
}

/** Every live mapping, for the reviewable proposal and for an operator reading current state. */
async function allMappings({ at = null, ...deps } = {}) {
  try {
    const r = await q(deps)(
      `SELECT wc.workflow, wc.company_id AS "companyId", wc.granted_by AS "grantedBy",
              wc.granted_reason AS "grantedReason", wc.effective_from AS "effectiveFrom"
       ${FROM}
       WHERE ${LIVE}
       ORDER BY wc.workflow, wc.company_id`,
      [at]);
    return r.rows;
  } catch (_) {
    return UNKNOWN;
  }
}

module.exports = {
  companiesForWorkflow,
  resolveWorkflowCompany,
  mapWorkflowToCompany,
  unmapWorkflow,
  allMappings,
  REFUSAL,
  UNKNOWN,
  LIVE,
  FROM,
};
