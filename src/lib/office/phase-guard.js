// PlayNexa AI Office — REVALIDATION AT EVERY PHASE BOUNDARY.
//
// Owner's Priority 3, second directive of 2026-11-25: *"Revalidate authorization at sensitive
// phase boundaries."* Same requirement as B7.24, one layer up.
//
// ── WHY A RUN'S OWN EXISTENCE IS NOT A STANDING AUTHORIZATION ────────────────
//
// The unattended cycle advances one phase per tick, and the ticks are minutes or hours apart. A
// run that was authorized at 06:00 can reach DISPATCH at 06:01 and REPORT at 06:04, and in between
// any of these can have changed:
//
//   · the COMPANY can be suspended or revoked
//   · the OBJECTIVE can be paused, completed or cancelled
//   · a STOP can be activated — globally, for this company, for this workflow, for this agent
//
// Before B3.18, advancement asked NONE of these again. `resolveObjectiveContext` re-read the
// objective's status on every tick (so a paused objective did stop the cycle, by accident of how
// the context is built) but `bootstrapObjectiveForContext` does not read the COMPANY's status at
// all — the initiator reads `c.status` when it decides what to start, and nothing read it ever
// again. So a company whose authorization was revoked mid-flight kept being acted for: more work
// enqueued, an employee task assigned, memory written under its name.
//
// And the paused-objective case stopped the cycle in the worst available way: the context refused,
// `advanceCycle` returned `{ok:false, reason:'no resolvable company context'}`, nothing durable was
// written, and the run stayed in the live set — so the scheduler re-selected it and re-refused it
// every tick, for ever. A refusal that leaves no trace and never ends is an indefinite phase loop
// wearing the clothes of a safety check.
//
// ── WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT ────────────────
//
// It ASKS. It writes nothing and ends nothing: the caller decides what a refusal means for the run,
// because "what to do about it" is policy and this is a predicate. Every refusal carries a stable
// `code` so the caller's durable record names the reason rather than paraphrasing it.
//
// FAIL-CLOSED on every unreadable answer. An unreadable company status is not an active company; an
// unreadable kill state is a refusal, which is `checkStopped`'s own behaviour for a consequential
// caller and is why this asks as one.
//
// It does NOT re-check the budget. Budget is enforced where money is committed — `authorizeSpend`
// takes an atomic hold before a provider is reached (B2.5b) — and a second opinion here would be a
// competing copy of that rule, which is the thing the kernel exists to avoid. What this guard
// protects is the authority to act for a company at all.

const CODES = Object.freeze({
  NO_CONTEXT: 'no_resolved_context',
  COMPANY_UNREADABLE: 'company_authorization_unreadable',
  COMPANY_MISSING: 'company_no_longer_exists',
  COMPANY_NOT_ACTIVE: 'company_authorization_withdrawn',
  OBJECTIVE_UNREADABLE: 'objective_status_unreadable',
  OBJECTIVE_MISSING: 'objective_no_longer_exists',
  OBJECTIVE_NOT_ACTIVE: 'objective_not_active',
  STOPPED: 'stopped_by_policy',
});

/**
 * May this run take its next phase?
 *
 * @returns {{ok: true}} or {{ok: false, code, detail, stop?}}
 */
async function revalidate(ctx, { workflow, agent, phase = null } = {}, deps = {}) {
  if (!ctx || !ctx.companyId) {
    return { ok: false, code: CODES.NO_CONTEXT,
      detail: 'no resolved company context, so no authority to act' };
  }
  const scope = deps.scope || require('./scope');
  const autonomy = deps.autonomy || require('../autonomy');

  // ── 1. THE COMPANY ────────────────────────────────────────────────────────
  // Through the accessor, which owns the table name. The status is read EVERY phase rather than
  // carried on the context: a value copied onto a context at 06:00 is a statement about 06:00.
  let company;
  try {
    company = await scope.companyAuthorization(ctx, deps);
  } catch (e) {
    return { ok: false, code: CODES.COMPANY_UNREADABLE,
      detail: `company authorization could not be read (${e.message}) — an outage is not an `
        + 'authorization' };
  }
  if (!company) {
    return { ok: false, code: CODES.COMPANY_MISSING,
      detail: `company ${ctx.companyId} no longer exists` };
  }
  if (company.status !== 'active') {
    return { ok: false, code: CODES.COMPANY_NOT_ACTIVE,
      detail: `company ${ctx.companyId} is ${company.status}, not active — its authorization has `
        + 'been withdrawn since this run began' };
  }

  // ── 2. THE OBJECTIVE ──────────────────────────────────────────────────────
  // Scoped by company AND id, which is stricter than the bootstrap read the context uses: an
  // objective whose company somehow differs from the context's is not this run's objective.
  if (ctx.objectiveId) {
    let objective;
    try {
      objective = await scope.objectiveAuthorization(ctx, deps);
    } catch (e) {
      return { ok: false, code: CODES.OBJECTIVE_UNREADABLE,
        detail: `objective status could not be read (${e.message})` };
    }
    if (!objective) {
      return { ok: false, code: CODES.OBJECTIVE_MISSING,
        detail: `objective ${ctx.objectiveId} no longer exists under company ${ctx.companyId}` };
    }
    if (objective.status !== 'active') {
      return { ok: false, code: CODES.OBJECTIVE_NOT_ACTIVE,
        detail: `objective ${ctx.objectiveId} is ${objective.status}, not active` };
    }
  }

  // ── 3. THE KILL SWITCH, ASKED AS A CONSEQUENTIAL CALLER ──────────────────
  // Company-scoped as well as workflow- and agent-scoped, so a STOP on THIS company halts its
  // cycle without halting another company's. `consequential: true` is the default and is what
  // makes an unreadable kill state a refusal rather than a shrug.
  const stop = await autonomy.checkStopped({
    capability: 'office.advance',
    company: ctx.companyId,
    workflow,
    agent,
  }, { consequential: true, deps });
  if (stop) {
    return { ok: false, code: CODES.STOPPED, stop,
      detail: `halted by a ${stop.scope_type} stop${stop.scope_key ? ` (${stop.scope_key})` : ''}`
        + `${stop.reason ? `: ${stop.reason}` : ''}`,
      unknown: !!stop.unknown,
      phase };
  }

  return { ok: true };
}

module.exports = { revalidate, CODES };
