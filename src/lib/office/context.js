// PlayNexa AI Office — authoritative company context.
//
// THE RULE THIS FILE EXISTS TO ENFORCE:
//   "an agent does not get to choose which company it is acting for."
//
// Company context comes from the authorized execution context and from nothing else. The way
// that is enforced here is deliberately structural rather than defensive:
//
//   resolveCompanyContext HAS NO COMPANY PARAMETER.
//
// Not optional, not validated, not preferred-over, not logged-and-ignored — there is no argument
// through which a caller or an agent could express a company at all. A hostile company_id in
// agent-supplied JSON cannot be accepted because there is nowhere to put it. A validation check
// would have been a weaker design: it would have had to be remembered, and it could be relaxed
// by a later caller who had a reason.
//
// FAIL CLOSED. No resolvable context means no kernel write, consistent with the RFQ identity
// guard's decision_not_persisted behaviour. In particular a LEGACY run — one whose company_id is
// NULL because it predates K1 — resolves to NO CONTEXT. Legacy runs cannot borrow a company by
// accident, and the kernel cannot be entered through the back door of an old execution.
//
// The returned context is frozen so a downstream caller cannot rewrite it in place and hand a
// different company to the next function.
//
// RLS-READINESS, WITHOUT AN RLS CLAIM. If a non-superuser application role is ever introduced,
// this function is the single place a `SET LOCAL app.company_id` would be issued. Nothing today
// depends on that and nothing here claims row-level security is in force — it is not: the
// application connects as a superuser, which bypasses RLS even under FORCE ROW LEVEL SECURITY.

function lazyQuery() {
  return require('../db').query;
}

class NoCompanyContext extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoCompanyContext';
    this.code = 'NO_COMPANY_CONTEXT';
  }
}

// Resolve the authoritative context for a run. { runId } only — see the header.
async function resolveCompanyContext({ runId }, deps = {}) {
  const query = deps.query || lazyQuery();
  if (!runId) throw new NoCompanyContext('resolveCompanyContext requires a runId');

  const res = await query(
    `SELECT run_id, company_id, objective_id FROM agent_runs WHERE run_id = $1`,
    [runId]
  );
  const row = res.rows[0];
  if (!row) throw new NoCompanyContext(`no run ${runId}`);

  if (!row.company_id) {
    throw new NoCompanyContext(
      `run ${runId} carries no company identity (legacy or non-office run) — ` +
      `autonomous-office work refuses rather than assuming a company`
    );
  }

  return Object.freeze({
    companyId: row.company_id,
    objectiveId: row.objective_id || null,
    runId: row.run_id,
  });
}

// Resolve the context for an objective directly, for the creation of a run against it. Again:
// the company is READ from the objective, never supplied alongside it.
async function resolveObjectiveContext({ objectiveId }, deps = {}) {
  if (!objectiveId) throw new NoCompanyContext('resolveObjectiveContext requires an objectiveId');

  // The table name lives in the accessor, not here — see scope.js's note on the one deliberately
  // unscoped read. Keeping it there means check-office-scope-discipline.js needs no exemption for
  // this file, so any future query added here is caught rather than silently permitted.
  const row = await require('./scope').bootstrapObjectiveForContext(objectiveId, deps);
  if (!row) throw new NoCompanyContext(`no objective ${objectiveId}`);

  // An objective that is not active is not a licence to execute. Reported as no context rather
  // than as a permitted run with a flag, because a flag is something a caller can ignore.
  if (row.status !== 'active') {
    throw new NoCompanyContext(
      `objective ${objectiveId} is ${row.status}, not active — no autonomous execution context`
    );
  }

  return Object.freeze({
    companyId: row.company_id,
    objectiveId: row.id,
    autonomyTier: row.autonomy_tier,
    approvalPolicy: row.approval_policy,
    budgetUsd: row.budget_usd === null ? null : Number(row.budget_usd),
  });
}

// Guard for the kernel write path. Anything handed to a kernel writer must be a context this
// module produced, not an object that merely has the right shape — a plain object with a
// companyId is exactly what an attacker or a careless caller would construct.
function assertContext(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new NoCompanyContext('kernel write requires a resolved company context');
  if (!Object.isFrozen(ctx)) throw new NoCompanyContext('company context must be the frozen object from resolveCompanyContext');
  if (!ctx.companyId) throw new NoCompanyContext('resolved context carries no companyId');
  return ctx;
}

// ── READ CONTEXT FOR A HUMAN SESSION ────────────────────────────────────────
//
// WHY THIS HAD TO EXIST AT ALL. resolveCompanyContext resolves a company from an agent RUN, and
// that is correct for agent work: every agent action belongs to a run, and the run carries the
// company. A person opening a dashboard has no run. src/api/routes.js called
// resolveCompanyContext({ userId }) — a field this module does not accept — so it threw
// "requires a runId" on every request, and ALL FIVE PRPA endpoints returned HTTP 500. They had
// never once been exercised against the real backend; the dashboard's tests all ran against
// stubbed responses, which is precisely why nobody noticed.
//
// THE PART THAT IS NOT A BUG. There is no user-to-company mapping anywhere in this system: not a
// column on users, not a membership table, nothing. So "which company is this person looking at?"
// has no stored answer, and inventing one would be the guess that ruling 7 item 3 forbids —
// applied at read time rather than at migration time, but the same mistake.
//
// SO THIS RESOLVES ONLY WHEN THE ANSWER IS UNAMBIGUOUS:
//
//   exactly one company   → that company. There is nothing to choose between.
//   zero companies        → refuse. The kernel is not configured.
//   two or more           → REFUSE, and say so. With no mapping, picking one would show a person
//                           another tenant's pipeline, prices and review queue. "The first row"
//                           is not a tenancy model.
//
// The refusal is the feature. It keeps the single-tenant deployment working today and turns the
// day a second company appears into a loud, immediate failure rather than a silent cross-tenant
// read. When that day comes the fix is a real user-to-company mapping, which is a ruling, not a
// patch here.
async function resolveCompanyForReadSession({ userId }, deps = {}) {
  const query = deps.query || lazyQuery();
  if (!userId) throw new NoCompanyContext('a read session requires a userId');

  const { rows } = await query(
    `SELECT id FROM companies WHERE status = 'active' ORDER BY created_at, id`,
  );

  if (rows.length === 0) {
    throw new NoCompanyContext(
      'no active company exists, so there is no pipeline to show. This is a configuration gap, '
      + 'not an empty result: the office kernel has not been given a company.',
    );
  }
  if (rows.length > 1) {
    throw new NoCompanyContext(
      `${rows.length} active companies exist and this system has no user-to-company mapping, so `
      + 'which one this person may see is UNKNOWN. Refusing rather than showing a tenant that may '
      + 'not be theirs. Resolving this needs a membership model, not a default.',
    );
  }
  return Object.freeze({
    companyId: rows[0].id,
    objectiveId: null,
    // Named so a reader of a log or a stack can tell this apart from a run-derived context. A
    // read session must never be handed to a kernel WRITER; assertContext guards the write path
    // and this object is deliberately not produced by resolveCompanyContext.
    source: 'read_session',
    userId,
  });
}

module.exports = {
  resolveCompanyContext,
  resolveObjectiveContext,
  resolveCompanyForReadSession,
  assertContext,
  NoCompanyContext,
};
