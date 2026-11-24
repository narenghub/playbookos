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

// ── WHAT MAKES A CONTEXT TRUSTED: A BRAND, NOT A SHAPE ──────────────────────
//
// assertContext below required `Object.isFrozen(ctx)` and a `companyId`, and its own comment said
// the point was to accept only "a context this module produced, not an object that merely has the
// right shape". Those are different claims, and on 2026-11-24 a one-line probe showed it:
//
//   assertContext(Object.freeze({ companyId: 'co-someone-elses-company' }))   // → ACCEPTED
//
// Frozen-ness is something any caller can supply with Object.freeze. It was a measurement standing
// in for the property, guarding the one thing every company-isolation rule rests on — and owner
// requirement 7 is explicit: "Company context must come from trusted authenticated execution
// context, never an arbitrary AI-generated company identifier" and "AI agents cannot manufacture or
// expand company context."
//
// A module-private Symbol cannot be forged from outside: it is not exported, it does not appear in
// JSON, and a caller cannot obtain a reference to it. So a context is trusted when it carries THIS
// symbol, which only the resolvers below can stamp.
// Symbol.for, not Symbol(), and the reason is mechanical rather than a preference. Several
// verification harnesses clear the office modules out of require.cache to exercise a mutated copy
// (`freshOffice()`), and a module-PRIVATE symbol does not survive that: the reloaded instance mints
// a fresh one, so a context branded moments earlier is refused as "not produced by". That produced
// an unbounded tail of harness failures that had nothing to do with authorization.
//
// WHAT THIS COSTS, STATED PLAINLY. A registry symbol can be obtained by any in-process code that
// knows the key, so this is not proof against code that is actively trying. It is proof against
// the thing the requirement names: "AI agents cannot manufacture or expand company context." An
// agent produces text — JSON, a tool argument, an object shape — and text cannot carry a Symbol at
// all, let alone this one. The previous guard, `Object.isFrozen`, failed even that bar.
//
// The remaining gap — in-process code calling Symbol.for with this key — is closed by
// scripts/check-context-brand-usage.js, which fails the build if any file other than this one
// mentions the key.
const BRAND_KEY = 'playnexa.office.companyContext.v1';
const BRAND = Symbol.for(BRAND_KEY);

// ── IDENTITY, NOT A MARK: THE REGISTRY THAT CLOSES SUBSTITUTION ─────────────
//
// The brand alone was not enough, and the gap was recorded rather than fixed: Symbols survive
// object spread, so `Object.freeze({ ...realContext, companyId: 'other' })` carried the brand, was
// frozen, and PASSED. That is context substitution — the most plausible attack here, because it
// needs no knowledge of a key, only a context the caller already legitimately holds.
//
// A WeakSet of the actual objects this module minted answers the right question. Not "does this
// object bear a mark" — a mark copies — but "is this THE object we created". A spread is a new
// object and is not in the set. A hand-built object with the right Symbol is not in the set
// either, so direct brand fabrication dies with the same check.
//
// WHY IT HANGS OFF globalThis. The harnesses clear office modules from require.cache, and a
// module-level WeakSet would be replaced on reload, instantly invalidating every live context —
// the exact failure that pushed the brand from Symbol() to Symbol.for(). The registry therefore
// lives on globalThis under a registry Symbol, so all instances share one set.
//
// WHAT AN ATTACKER WITH IN-PROCESS CODE CAN STILL DO. They can reach globalThis and add their own
// object to the set. Nothing in JavaScript prevents that, and this file does not pretend otherwise.
// What is now closed is the realistic path: copying, spreading or re-freezing a context, and
// fabricating one from the published key. Both are refused by object identity.
const REGISTRY_KEY = Symbol.for('playnexa.office.companyContextRegistry.v1');
if (!globalThis[REGISTRY_KEY]) globalThis[REGISTRY_KEY] = new WeakSet();
const MINTED = globalThis[REGISTRY_KEY];

/**
 * Stamp, freeze, and REGISTER. The only way a trusted context comes into existence.
 *
 * The brand is kept for diagnostics and for a cheap first check; membership of MINTED is what
 * actually confers trust, because object identity cannot be copied.
 */
function sealContext(fields) {
  const ctx = Object.freeze({ ...fields, [BRAND]: true });
  MINTED.add(ctx);
  return ctx;
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

  return sealContext({
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

  return sealContext({
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
  // The brand first: it is the check that cannot be satisfied from outside this module. Frozen-ness
  // and a companyId are still required, but on their own they only prove SHAPE — and a caller that
  // wanted to act for another company would supply exactly that shape.
  // Object IDENTITY first. A spread, a re-freeze, or a hand-built object bearing the right Symbol
  // are all different objects from the ones this module minted, so all three are refused here.
  if (!MINTED.has(ctx)) {
    throw new NoCompanyContext(
      'company context was not produced by src/lib/office/context.js. A frozen object with a '
      + 'companyId is not a resolved context — and neither is a COPY of a real one: spreading a '
      + 'context to change its company produces a new object, which is not the object that was '
      + 'resolved. Resolve one from a run, an objective, an authenticated read session, or a '
      + 'mapped scheduled workflow, so the company is READ from stored state rather than chosen '
      + 'by the caller.');
  }
  if (!Object.isFrozen(ctx)) throw new NoCompanyContext('company context must be frozen');
  if (!ctx.companyId) throw new NoCompanyContext('resolved context carries no companyId');
  return ctx;
}

// ── A SCHEDULED WORKFLOW'S COMPANY, READ FROM STORED CONFIGURATION ──────────
//
// Owner decision 2026-11-24: Option A as the transitional bridge to governed runs. A cron has no
// authenticated subject and no run, so neither resolveCompanyContext nor
// resolveCompanyForReadSession can serve it — and until something can, the 7am briefing, the 8am
// assignments and the 6pm coaching mail cannot be classified as internal and stay stopped.
//
// The caller names a WORKFLOW. The company comes from `workflow_companies`, through its accessor.
// Nothing about the caller's input becomes the company, which is the whole distinction from the
// `companyId` string that dispatch.js accepts today.
//
// Ambiguity REFUSES rather than selecting: a workflow authorized for two companies is executed
// once per company by the scheduler, each with its own resolved context, so one execution never
// spans tenants.
//
// The refusal carries the accessor's structured code (`not_mapped`, `ambiguous`, `unresolvable`)
// on the error, so the caller can file an actionable audit row instead of logging "no company".
async function resolveCompanyForScheduledWorkflow({ workflow }, deps = {}) {
  if (!workflow) throw new NoCompanyContext('a scheduled workflow context requires a workflow name');

  const WF = deps.workflowCompany || require('../identity/workflow-company');
  const r = await WF.resolveWorkflowCompany(workflow, deps);

  if (!r.ok) {
    const e = new NoCompanyContext(
      `scheduled workflow "${workflow}" has no resolved company: ${r.detail}`);
    // Structured, so the scheduler can record WHICH refusal this was. An operator told only "no
    // company" cannot tell an unreadable table from an unmapped workflow, and those need
    // different action.
    e.refusal = r.code;
    e.workflow = r.workflow;
    e.candidates = r.candidates;
    throw e;
  }

  return sealContext({
    companyId: r.companyId,
    objectiveId: null,
    // Named so a log or a stack says what kind of context this is. It is NOT a run context and
    // must not be handed to a kernel writer expecting one; it exists so a scheduled send can be
    // authorized against a company at all.
    source: 'scheduled_workflow',
    workflow: String(workflow),
    resolvedAt: new Date().toISOString(),
  });
}

// ── DERIVING A CONTEXT FROM A TRUSTED ONE ───────────────────────────────────
//
// Legitimate and common: office/run.js resolves a context from an objective, creates a run, and
// must hand onward the same context now carrying the runId. Before the brand it did that with a
// bare `Object.freeze({ ...fields })`, which produced an UNBRANDED copy — so after branding,
// assertContext refused it and three verification harnesses failed with "not produced by". The
// intent was never forgery; there was simply no sanctioned way to say "this context, plus a run".
//
// This is that way, and it has one rule that matters: DERIVATION CANNOT CHANGE THE COMPANY. Adding
// a runId is a refinement; swapping the companyId would be exactly the laundering that branding
// exists to prevent, and it would be indistinguishable from legitimate use if it were permitted
// here.
function deriveContext(base, fields = {}) {
  assertContext(base);
  if ('companyId' in fields && fields.companyId !== base.companyId) {
    throw new NoCompanyContext(
      `a derived context cannot change the company (${base.companyId} → ${fields.companyId}). `
      + 'Resolve a context for that company instead, so the authorization is read from stored '
      + 'state rather than carried across from another company\'s context.');
  }
  return sealContext({ ...stripBrand(base), ...fields });
}

/** The brand is re-applied by sealContext; carrying the old one through a spread is redundant. */
function stripBrand(ctx) {
  const out = {};
  for (const k of Object.keys(ctx)) out[k] = ctx[k];
  return out;
}

// ── A TEST-ONLY DOOR, AND A CHECK THAT KEEPS IT TEST-ONLY ───────────────────
//
// Branding contexts broke 24 assertions that built one with `Object.freeze({ companyId: '…' })` and
// handed it to production code. Those tests were taking a shortcut that no longer works, and they
// were right to break.
//
// Two ways to fix them. Have each test resolve a real context through a stubbed query — most
// faithful, and it touches every one of those files. Or give them one marked door and PROVE it is
// only ever opened by tests, which is the discipline this repository already applies to the kernel
// accessor and the membership table.
//
// This is the door. It is deliberately ugly to type, it says what it is, and
// scripts/check-test-context-usage.js fails the build if any file that is not a `*.test.js`
// references it. The production guarantee is unchanged: a caller cannot forge a context, because
// the Symbol is private and the only function that stamps it is unreachable from shipped code.
function contextForTests__TEST_ONLY(fields) {
  if (!fields || !fields.companyId) {
    throw new Error('contextForTests__TEST_ONLY needs at least a companyId');
  }
  // NOTE ON `budgetUsd`, since B2.5a: a context with no budget now REFUSES autonomous execution,
  // because the alternative — permitting unmetered spend bounded only by a shared enterprise cap —
  // is the gap B2.5a closed. `resolveObjectiveContext` fills this field from the objectives row, so
  // a test context that omits it is LESS COMPLETE than the thing it stands in for and will refuse
  // for a budget reason rather than the reason under test. No default is invented here: this
  // function cannot know the objective's budget without a query, and guessing one would be exactly
  // the caller-supplied ceiling B2.5a removed. Tests that exercise a budgeted path pass it.
  return sealContext({ objectiveId: null, source: 'test', ...fields });
}

/**
 * Is this a context this module produced? Boolean form, for callers that must decide rather than
 * throw — the outbound gate asks this before it will treat anybody as internal.
 */
function isTrustedContext(ctx) {
  return Boolean(ctx) && typeof ctx === 'object' && MINTED.has(ctx)
    && ctx[BRAND] === true && Object.isFrozen(ctx) && Boolean(ctx.companyId);
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

  return sealContext({
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
  resolveCompanyForScheduledWorkflow,
  assertContext,
  isTrustedContext,
  deriveContext,
  contextForTests__TEST_ONLY,
  NoCompanyContext,
};
