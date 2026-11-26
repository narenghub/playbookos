// ── GOVERNED, COMPANY-SCOPED, READ-ONLY OPERATIONAL FACTS (B3.19) ───────────
//
// Owner's Priority 4, second directive of 2026-11-25: *"Implement a governed, company-scoped,
// read-only operational facts source using existing authorized data-access modules. Start with
// synthetic fixtures covering employee assignments, task completion, milestones, objectives and
// execution outcomes. Distinguish measured zero, missing data, stale data and unavailable data. Do
// not allow model-generated facts to substitute for authoritative operational records. Verify every
// briefing figure against independent evidence."*
//
// ── IT COMPOSES THE EXISTING ACCESSORS AND WRITES NO SQL ───────────────────
//
// Every figure here comes from `identity/scoped-operations.js` or `office/scope.js` — the two
// modules that own these tables and their company predicates. This file contains no SQL at all,
// which is not a stylistic choice: a facts source that wrote its own queries would be a second copy
// of the company filter, and `check-identity-accessor-discipline.js` exists because this repository
// has already learned what a second copy costs.
//
// It is READ-ONLY by construction, not by promise: there is no writer on its surface, nothing it
// calls writes, and `operational-facts-is-read-only.test.js` asserts that on the source.
//
// ── NO MODEL MAY SUPPLY A FACT ─────────────────────────────────────────────
//
// This module requires no provider, no `office/ai`, no `llm`, and takes no text input. A fact here
// is a figure read from an operational record, with the accessor that produced it named in the
// fact. The owner's constraint is that *model-generated facts must not substitute for authoritative
// operational records*, and the way to honour that is for the facts path to have no seam a model
// could reach — not a rule saying it must not.
//
// ── THE FOUR STATES, AND WHY THEY ARE NOT FOUR WAYS OF SAYING ZERO ─────────
//
//   measured       the accessor answered, and the figure is > 0
//   measured_zero  the accessor answered, the figure is 0, and nothing is hiding behind it
//   missing        the figure cannot be supported: the table is not present in this database, or
//                  the rows exist but their OWNERSHIP IS NOT ESTABLISHED, so they belong to nobody
//   stale          the figure is real and the newest record behind it is older than the bound
//   unavailable    the read failed, or an accessor reported that it could not tell
//
// The third is the one that matters most here, and it is not a theoretical case. From
// `scoped-operations.js`'s own header: *"until B7.21's attribution is applied, every function here
// returns NOTHING. A briefing built on them would be empty rather than wrong."* A zero reported as
// a measured zero while four thousand unattributed rows sit in the same table is a figure the
// briefing cannot support — and reporting it as "measured: 0" would be this repository's recurring
// defect in its most expensive form, since that number is what a CEO reads. So a zero is only a
// MEASURED zero when `unattributedCounts` says there is nothing unattributed in the table behind
// it. Otherwise it is `missing`, and it names how many rows are waiting on attribution.

'use strict';

/** The five fact families the owner named. Frozen: an unknown kind is a programming error. */
const KINDS = Object.freeze([
  'employee_assignments',
  'task_completion',
  'milestones',
  'objectives',
  'execution_outcomes',
]);

const STATUS = Object.freeze({
  MEASURED: 'measured',
  MEASURED_ZERO: 'measured_zero',
  MISSING: 'missing',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
});

/** How old the newest record behind a figure may be before the figure is STALE. */
const DEFAULT_STALE_AFTER_DAYS = 7;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const fact = (o) => Object.freeze({
  kind: o.kind,
  label: o.label,
  value: o.value === undefined ? null : o.value,
  unit: o.unit || 'count',
  status: o.status,
  source: o.source,             // the accessor that produced it, named for the reader
  detail: o.detail || null,
  newestRecord: o.newestRecord || null,
  parts: o.parts ? Object.freeze(o.parts) : null,
});

const daysBetween = (aIso, bMs) => {
  const t = Date.parse(aIso);
  if (!Number.isFinite(t)) return null;
  return (bMs - t) / 86_400_000;
};

/**
 * Classify a counted figure. The ONE place the four states are decided, so they cannot drift
 * between fact families.
 *
 * @param {number}  n                the figure
 * @param {number}  unattributed     rows in the same table whose ownership is not established
 * @param {?string} newestIso        the newest record behind the figure, if the family has dates
 */
function classify(n, { unattributed = 0, newestIso = null, staleAfterDays, now }) {
  if (n === 0) {
    if (unattributed > 0) {
      return { status: STATUS.MISSING,
        detail: `0 rows are attributed to this company while ${unattributed} row(s) in the same `
          + 'table have no owner — the figure cannot be supported until attribution is applied '
          + '(B7.18a/B7.21), and reporting it as a measured zero would be a number nobody can back' };
    }
    return { status: STATUS.MEASURED_ZERO,
      detail: 'the accessor answered and there is genuinely nothing — measured, not absent' };
  }
  if (newestIso) {
    const age = daysBetween(newestIso, now);
    if (age !== null && age > staleAfterDays) {
      return { status: STATUS.STALE,
        detail: `the newest record behind this figure is ${Math.floor(age)} day(s) old, past the `
          + `${staleAfterDays}-day bound — the figure is real and it is not current` };
    }
  }
  return { status: STATUS.MEASURED, detail: null };
}

/**
 * Collect this company's operational facts as of a business day.
 *
 * @returns {{asOf, companyId, measuredAt, facts: Array, quality: object}}
 */
async function collect(ctx, { asOf, staleAfterDays = DEFAULT_STALE_AFTER_DAYS } = {}, deps = {}) {
  if (!DAY.test(String(asOf || ''))) {
    throw new Error('operational-facts.collect requires asOf as YYYY-MM-DD: a figure with no '
      + 'as-of day cannot be reported, and guessing today here would hide a caller that lost it');
  }
  const OPS = deps.scopedOperations || require('../identity/scoped-operations');
  const scope = deps.scope || require('./scope');
  const now = deps.nowMs ? deps.nowMs() : Date.now();

  // Asked FIRST, because every zero below is interpreted against it. An unreadable answer here
  // does not stop the collection — it makes every zero `unavailable` rather than `measured_zero`,
  // which is the truthful degradation: without it, nothing can tell those two apart.
  let unattributed = null; let unattributedError = null;
  try {
    unattributed = await OPS.unattributedCounts(ctx, deps);
  } catch (e) { unattributedError = e.message; }

  const unattributedFor = (table) => (unattributed ? (unattributed[table] || 0) : 0);
  const facts = [];
  const degraded = [];

  /** Run one family, turning any failure into an `unavailable` fact rather than an exception. */
  const family = async (kind, label, source, fn) => {
    try {
      const r = await fn();
      if (r === null || r === undefined) {
        // `scoped-operations` returns UNKNOWN (null) when membership cannot be read. An outage is
        // not an empty company — its own words — so it must not become a zero here either.
        degraded.push({ kind, reason: 'the accessor could not tell' });
        facts.push(fact({ kind, label, source, value: null, status: STATUS.UNAVAILABLE,
          detail: 'the accessor returned UNKNOWN: it could not establish the figure, which is not '
            + 'the same as the figure being zero' }));
        return;
      }
      facts.push(r);
    } catch (e) {
      // A missing TABLE is `missing`, not `unavailable`: an unmigrated database is a known state
      // with a known fix, and conflating it with an outage sends somebody to the wrong problem.
      const missingTable = e && (e.code === '42P01' || e.code === '42703');
      degraded.push({ kind, reason: missingTable ? 'the table is not present' : e.message });
      facts.push(fact({ kind, label, source, value: null,
        status: missingTable ? STATUS.MISSING : STATUS.UNAVAILABLE,
        detail: missingTable
          ? `this database does not carry the table or column this figure needs (${e.code}) — it `
            + 'is unmigrated, which is a different problem from an outage'
          : `the read failed: ${e.message}` }));
    }
  };

  // ── 1 & 2. EMPLOYEE ASSIGNMENTS AND TASK COMPLETION ──────────────────────
  // One read serves both, because the completion rate must be computed from the SAME rows the
  // assignment count reports. Two reads would let the two figures disagree, and a briefing whose
  // numerator and denominator come from different moments is a briefing that can say 7 of 5.
  let tasks = null;
  await family('employee_assignments', `tasks assigned for ${asOf}`,
    'identity/scoped-operations.tasksFor', async () => {
      tasks = await OPS.tasksFor(ctx, { date: asOf }, deps);
      const n = tasks.length;
      const c = unattributedError
        ? { status: STATUS.UNAVAILABLE,
          detail: `the unattributed-row count could not be read (${unattributedError}), so a zero `
            + 'here cannot be told apart from rows nobody owns yet' }
        : classify(n, { unattributed: unattributedFor('daily_tasks'), staleAfterDays, now });
      return fact({ kind: 'employee_assignments', label: `tasks assigned for ${asOf}`,
        source: 'identity/scoped-operations.tasksFor', value: n, ...c });
    });

  await family('task_completion', `tasks completed of those assigned for ${asOf}`,
    'identity/scoped-operations.tasksFor', async () => {
      if (tasks === null) {
        return fact({ kind: 'task_completion',
          label: `tasks completed of those assigned for ${asOf}`,
          source: 'identity/scoped-operations.tasksFor', value: null,
          status: STATUS.UNAVAILABLE,
          detail: 'the assignment read did not succeed, so there is no denominator — a completion '
            + 'figure computed against an unknown total is the arithmetic a briefing must not do' });
      }
      const done = tasks.filter((t) => t.status === 'completed').length;
      // NOT classified against unattributed rows: the denominator is already the attributed set,
      // so a zero here means "none of this company's own tasks are done", which is measured.
      const status = tasks.length === 0 ? STATUS.MEASURED_ZERO
        : (done === 0 ? STATUS.MEASURED_ZERO : STATUS.MEASURED);
      return fact({ kind: 'task_completion',
        label: `tasks completed of those assigned for ${asOf}`,
        source: 'identity/scoped-operations.tasksFor', value: done, status,
        detail: tasks.length === 0
          ? 'no tasks were assigned for this day, so none could be completed — a measured zero '
            + 'with a stated denominator, not a performance figure'
          : null,
        parts: { assigned: tasks.length, completed: done } });
    });

  // ── 3. MILESTONES ────────────────────────────────────────────────────────
  await family('milestones', 'milestones not yet achieved',
    'identity/scoped-operations.milestonesFor', async () => {
      const ms = await OPS.milestonesFor(ctx, {}, deps);
      const open = ms.filter((m) => m.status !== 'achieved' && m.status !== 'completed');
      // The newest TARGET date, as the freshness signal: a milestone list whose latest target is
      // months in the past is a plan nobody has revised, which is worth saying out loud.
      const newest = ms.map((m) => m.targetDate).filter((d) => DAY.test(String(d))).sort().pop()
        || null;
      const c = unattributedError
        ? { status: STATUS.UNAVAILABLE, detail: `unattributed rows unknown (${unattributedError})` }
        : classify(open.length, { unattributed: unattributedFor('milestones'),
          newestIso: newest, staleAfterDays, now });
      return fact({ kind: 'milestones', label: 'milestones not yet achieved',
        source: 'identity/scoped-operations.milestonesFor', value: open.length, ...c,
        newestRecord: newest,
        parts: { total: ms.length, open: open.length } });
    });

  // ── 4. OBJECTIVES ────────────────────────────────────────────────────────
  // Through the office accessor, which reads the kernel table. Objectives carry a NOT NULL
  // company_id, so there is no unattributed case here — and saying that is better than quietly
  // passing 0 to `classify`, which would make the absence of the concept look like a measurement.
  await family('objectives', 'active objectives', 'office/scope.listObjectives', async () => {
    const objs = await scope.listObjectives(ctx, deps);
    const active = objs.filter((o) => o.status === 'active');
    const c = classify(active.length, { unattributed: 0, staleAfterDays, now });
    return fact({ kind: 'objectives', label: 'active objectives',
      source: 'office/scope.listObjectives', value: active.length, ...c,
      detail: c.detail || 'objectives.company_id is NOT NULL, so no objective can be unattributed',
      parts: { total: objs.length, active: active.length } });
  });

  // ── 5. EXECUTION OUTCOMES ────────────────────────────────────────────────
  await family('execution_outcomes', 'recorded execution outcomes',
    'office/scope.listOutcomes', async () => {
      const outs = await scope.listOutcomes(ctx, {}, deps);
      const achieved = outs.filter((o) => o.outcome === 'achieved').length;
      const newest = outs.length && outs[0].at ? new Date(outs[0].at).toISOString() : null;
      const c = classify(outs.length, { unattributed: 0, newestIso: newest, staleAfterDays, now });
      return fact({ kind: 'execution_outcomes', label: 'recorded execution outcomes',
        source: 'office/scope.listOutcomes', value: outs.length, ...c, newestRecord: newest,
        parts: { total: outs.length, achieved, notAchieved: outs.length - achieved } });
    });

  return Object.freeze({
    asOf,
    companyId: ctx.companyId,
    measuredAt: new Date(now).toISOString(),
    facts: Object.freeze(facts),
    quality: Object.freeze({
      // Stated rather than hidden, because the honest answer to "why is this briefing empty" has
      // to travel WITH the briefing. This is `unattributedCounts`' own reason for existing.
      unattributed: unattributed || null,
      unattributedError,
      degraded: Object.freeze(degraded),
      // A convenience the reader would otherwise have to compute, and the figure that decides
      // whether a briefing may be presented as a statement of fact at all.
      supportable: facts.filter((f) => f.status === STATUS.MEASURED
        || f.status === STATUS.MEASURED_ZERO).length,
      total: facts.length,
    }),
  });
}

module.exports = { collect, KINDS, STATUS, DEFAULT_STALE_AFTER_DAYS, classify };
