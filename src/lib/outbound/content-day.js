// ── B7.13: THE DAY A MESSAGE'S CONTENT CONCERNS ─────────────────────────────
//
// Approved as one sequenced change with B7.9a and B7.11a. The risk this closes was MEASURED before
// it was designed, and it is not the one the title suggests: **there is no flush-the-backlog path
// in this repository.** A grep over `src/lib/` finds nothing that enumerates refused rows and
// re-attempts them; `OUTCOME_UNKNOWN` is already documented as never eligible for automatic retry;
// and `dispatch` already refuses a repeated `idempotencyKey`.
//
// **So the risk is DATED CONTENT ARRIVING LATE, not a queue emptying.** Nothing has to replay
// anything for a message saying *"your tasks for 5 November"* to land on 1 December — it is enough
// that a human releases an old approval, or that a cron fires against a stale row. That is worse
// than silence, because it is wrong rather than absent, and it lands on four people at once.
//
// The control therefore belongs at the send boundary and is about the CONTENT's business day:
//
//   1. a message DECLARES the business day its content concerns;
//   2. a message whose declared day is not the current business day is REFUSED;
//   3. **a message declaring NO day is refused too** — otherwise the control is opt-in and every
//      existing caller opts out by default, which is the shape that makes a control decorative.
//
// Rule 3 is what makes this a breaking change for the internal callers, and it is the reason the
// owner sequenced it with B7.9a and B7.11a rather than letting it land alone.
//
// ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
//
// **No environment variable, and no caller-supplied "today".** B3.20 spent a whole requirement
// establishing that a business-day seam reachable through the environment is a standing override
// rather than a deliberate act, because a deployment platform sets variables for a whole service
// and nobody re-reads them. The current day comes from `agent-core.businessToday()`, the same
// function the cron layer uses, and the only injection point is `deps.now` — a clock, not a day.
//
// **No grace window.** A window would need a number, the number would be wrong on one side of it,
// and "how late is too late" is exactly the judgement a human should make by re-approving. A
// message that is a day stale is refused and says so; re-declaring it is a deliberate act.
//
// **Timeless messages are a declared KIND, not an exemption.** A password reset or an operator
// alert concerns no business day, and the honest way to say that is `contentDay: TIMELESS` — a
// value somebody typed — rather than an absent field, which is indistinguishable from forgetting.

'use strict';

/** The declaration a message with no business day makes. Explicit, never inferred from absence. */
const TIMELESS = 'timeless';

const REFUSAL = {
  NOT_DECLARED: 'content_day_not_declared',
  MALFORMED: 'content_day_malformed',
  STALE: 'content_day_stale',
  FUTURE: 'content_day_future',
  UNKNOWABLE: 'content_day_unknowable',
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @returns {{allowed: boolean, code?: string, reason?: string, day?: string, timeless?: boolean}}
 */
function assertContentDayCurrent({ contentDay = undefined, capability = null } = {}, deps = {}) {
  // An alert about the system itself concerns no business day and never has. It is listed here
  // rather than left to each caller, because `OBSERVABILITY` already exists for exactly this set
  // and a second list of exempt capabilities would drift from the first.
  if (contentDay === TIMELESS) {
    return { allowed: true, timeless: true, day: null };
  }

  if (contentDay === undefined || contentDay === null || contentDay === '') {
    return {
      allowed: false,
      code: REFUSAL.NOT_DECLARED,
      reason: 'this message declares no business day for its content. A message that concerns a '
        + `specific day must declare it as contentDay: 'YYYY-MM-DD'; one that genuinely concerns `
        + `none must declare contentDay: '${TIMELESS}'. An ABSENT declaration is refused because an `
        + 'optional control is one every caller opts out of by forgetting, and the failure it '
        + `exists to prevent — dated content arriving late — looks exactly like a normal send`
        + (capability ? ` (capability ${capability})` : ''),
    };
  }

  if (typeof contentDay !== 'string' || !DAY.test(contentDay)) {
    return {
      allowed: false,
      code: REFUSAL.MALFORMED,
      reason: `contentDay must be 'YYYY-MM-DD' or '${TIMELESS}', not `
        + `${JSON.stringify(contentDay)}. It is not parsed leniently: a value this function had to `
        + 'guess at is a value nobody declared',
    };
  }

  let today;
  try {
    today = deps.businessToday
      ? deps.businessToday()
      : require('../agent-core').businessToday(deps.now ? deps.now() : undefined);
  } catch (e) {
    // The current business day is the thing this compares against. Unable to establish it means
    // unable to judge, and the direction every gate in this repository fails is closed.
    return {
      allowed: false,
      code: REFUSAL.UNKNOWABLE,
      reason: `the current business day could not be established (${e.message}), so whether this `
        + "message's content is current is unknown — refusing rather than assuming it is",
    };
  }

  if (!DAY.test(String(today))) {
    return {
      allowed: false,
      code: REFUSAL.UNKNOWABLE,
      reason: `businessToday() returned ${JSON.stringify(today)}, which is not a business day — `
        + 'refusing rather than comparing against a value of unknown meaning',
    };
  }

  if (contentDay === today) return { allowed: true, day: contentDay, timeless: false };

  // Past and future are DIFFERENT failures and need different operator action: a stale message
  // wants re-approval with today's content, and a future-dated one is a clock or a fixture problem.
  return contentDay < today
    ? {
      allowed: false,
      code: REFUSAL.STALE,
      reason: `this message's content concerns ${contentDay} and today is ${today}. Dated content `
        + 'arriving late is worse than silence, because it is wrong rather than absent. Re-declare '
        + 'it for today, with content that is about today',
      day: contentDay,
      today,
    }
    : {
      allowed: false,
      code: REFUSAL.FUTURE,
      reason: `this message's content concerns ${contentDay}, which is after today (${today}). `
        + 'A future-dated send is a clock problem or a fixture leaking into a real path, and '
        + 'neither should reach a provider',
      day: contentDay,
      today,
    };
}

module.exports = { assertContentDayCurrent, TIMELESS, REFUSAL };
