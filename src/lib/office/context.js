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
// ── THAT MAPPING NOW EXISTS (owner ruling 2026-11-24, B7.8) ─────────────────
//
// The paragraph above said: "when that day comes the fix is a real user-to-company mapping, which
// is a ruling, not a patch here." The ruling arrived and the mapping is `user_companies`, reached
// only through src/lib/identity/company-membership.js. So this no longer asks "how many companies
// exist" — a question whose answer was never about this person — but "which companies is THIS
// PERSON currently authorized for":
//
//   unreadable membership   → REFUSE. Unknowable is not "none", and it is certainly not "all".
//   zero authorized         → REFUSE. Not a member of anything is not a licence to read anything.
//   exactly one             → that company.
//   two or more, none asked → REFUSE, and name the authorized ones so the caller can offer a
//                             choice. "The first row" is still not a tenancy model.
//   a company was asked for → granted ONLY if it is among this person's live memberships.
//
// ── THE REQUESTED COMPANY IS CHECKED, NOT TRUSTED (req 4) ───────────────────
//
// `requestedCompanyId` comes from a request parameter, which means it comes from whoever is
// talking to us. It is never used as the answer; it is used as a LOOKUP KEY into the memberships
// this module just read from the database. Passing another tenant's id gets a refusal naming it,
// not that tenant's pipeline. This is also why the parameter is not merged into the returned
// context before validation — an object assembled first and checked second is how a check gets
// skipped on one branch.
//
// ── NOTHING HERE IS CACHED, AND THAT IS A REQUIREMENT (req 5, req 6) ────────
//
// Membership is resolved on EVERY call. A deactivation or a revocation therefore takes effect on
// the next request without anyone invalidating anything, because there is nothing to invalidate.
// `resolvedAt` is stamped on the context so a consumer that holds one can tell how old its
// authorization is, and so a queued task carrying a context cannot pass itself off as freshly
// authorized — a queued task must re-resolve before it acts, which is the dispatch-time
// revalidation rule rather than a property of this object.
//
// ── A NOTE FOR DEPLOYMENT, STATED RATHER THAN DISCOVERED ────────────────────
//
// There are no membership rows yet. Until a reviewed backfill grants them, every read session
// refuses — including the five PRPA dashboard endpoints. That is the ruled behaviour ("No
// automatic membership grants based on email domain"; "Do not infer or grant production
// memberships automatically"), not an oversight: inventing a membership here would be the same
// guess the old code refused to make, moved one layer down. The refusal names the remedy.
async function resolveCompanyForReadSession({ userId, requestedCompanyId = null }, deps = {}) {
  if (!userId) throw new NoCompanyContext('a read session requires a userId');

  const MEMBERSHIP = deps.membership || require('../identity/company-membership');
  const held = await MEMBERSHIP.membershipsOf(userId, deps);

  if (held === MEMBERSHIP.UNKNOWN) {
    throw new NoCompanyContext(
      'company membership could not be read, so which companies this person may see is UNKNOWN. '
      + 'Refusing rather than guessing: an unreadable membership table is not an empty one.',
    );
  }
  if (held.length === 0) {
    throw new NoCompanyContext(
      `${userId} holds no active company membership, so there is no pipeline to show. If this is a `
      + 'new deployment, memberships have not been granted yet — they are granted explicitly by an '
      + 'authorized administrator (src/lib/identity/company-membership.js grantMembership), never '
      + 'inferred from an email domain or defaulted to the only company.',
    );
  }

  let chosen;
  if (requestedCompanyId) {
    chosen = held.find((m) => m.companyId === String(requestedCompanyId));
    if (!chosen) {
      throw new NoCompanyContext(
        `${userId} is not an authorized member of ${requestedCompanyId}. A company named in a `
        + 'request is a lookup key against this person\'s memberships, never the answer.',
      );
    }
  } else if (held.length === 1) {
    [chosen] = held;
  } else {
    throw new NoCompanyContext(
      `${userId} is authorized for ${held.length} companies `
      + `(${held.map((m) => m.companyId).join(', ')}) and selected none. Which one to show must be `
      + 'chosen explicitly — picking one would show a tenant they did not ask for.',
    );
  }

  return Object.freeze({
    companyId: chosen.companyId,
    companyRole: chosen.companyRole,
    objectiveId: null,
    // Named so a reader of a log or a stack can tell this apart from a run-derived context. A
    // read session must never be handed to a kernel WRITER; assertContext guards the write path
    // and this object is deliberately not produced by resolveCompanyContext.
    source: 'read_session',
    userId,
    resolvedAt: new Date().toISOString(),
    authorizedCompanyIds: Object.freeze(held.map((m) => m.companyId)),
  });
}

module.exports = {
  resolveCompanyContext,
  resolveObjectiveContext,
  resolveCompanyForReadSession,
  assertContext,
  NoCompanyContext,
};
