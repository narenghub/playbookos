// ── WHICH COMPANY DOES A RECORD BELONG TO? (B7.21) ──────────────────────────
//
// Owner instruction, 2026-11-24:
//
//   "Filtering employees alone is insufficient. The underlying tasks, orders, objectives and
//    performance records must also belong to the authorized company. Where legacy records lack
//    company ownership, prepare a reviewed migration and explicit attribution proposal. Do not
//    infer ownership or silently assign ambiguous records to ABIOZEN."
//
// This module is that policy, written as data so a tool can act on it and a person can review it.
// It decides nothing by itself: it says, per table, HOW ownership could be established and whether
// a legacy row can be attributed at all.
//
// ── THE MEASUREMENT THAT MADE IT NECESSARY ──────────────────────────────────
//
// THIRTEEN operational tables carry no company ownership of any kind: daily_tasks, orders,
// performance_scores, milestones, targets, activity_logs, kpi_hierarchy, weekly_kpis,
// goal_cascades, agent_activity_log, approval_queue, email_log, metrics_snapshots. Zero
// `company_id` columns between them. So scoping the employee query would have produced a workflow
// that selects the right people and then reads every company's tasks, scores and revenue.
//
// ── THE THREE CLASSES, AND WHY THE THIRD IS NOT A FAILURE ───────────────────
//
//   DERIVABLE      the row names a person, and that person has exactly ONE active membership. The
//                  attribution follows, and a human still reviews it.
//   AMBIGUOUS      the row names a person with TWO OR MORE active memberships — a shared employee,
//                  which is exactly what `user_companies` exists to express. Prasanthi is an admin
//                  of ABIOZEN and of Adifice; a task of hers belongs to one of them and the row
//                  does not say which. This needs a decision per row or per rule, never a default.
//   UNATTRIBUTABLE nothing in the row identifies a company, by any route.
//
// UNATTRIBUTABLE is the honest answer for `orders`, and it is worth stating plainly: an order row is
// `(order_date, amount, buyer_type, product_category, status, notes)`. There is no buyer id, no
// seller, no owner, no SKU reference — nothing that names a company. Revenue cannot be attributed
// by any rule this file could write. It requires the owner to say which orders were whose, or a new
// source of truth, and until then those rows belong to no company.
//
// `metrics_snapshots` is worse than unattributable: it is UNIQUE(snapshot_date), one row per day
// for the whole platform, built by summing orders and averaging performance scores across every
// company. An aggregate cannot be split back into its parts. Those rows are PORTFOLIO-level and
// always were; the correct migration labels them so rather than pretending they were ABIOZEN's.
//
// ── THE SECURITY PROPERTY THAT MATTERS MOST ─────────────────────────────────
//
// A row whose `company_id` is NULL is NOT visible to every company. It is visible to NONE. That is
// the opposite of the usual instinct — an unscoped row feels like shared data — and it is the only
// safe reading: "ownership not yet established" must never mean "owned by whoever asks". Every
// query in src/lib/identity/scoped-operations.js therefore requires a non-null match, and
// scripts/check-record-ownership-db.js asserts that an unattributed row is invisible rather than
// universal.

'use strict';

/** How a table's ownership can be established. */
const CLASS = Object.freeze({
  DERIVABLE: 'derivable',
  AMBIGUOUS_BY_NATURE: 'ambiguous_by_nature',
  UNATTRIBUTABLE: 'unattributable',
  PORTFOLIO: 'portfolio',
});

/**
 * The operational tables the eight areas in the owner's instruction actually read, with how each
 * one's ownership is established.
 *
 * `via` names the column that could point at a company, and `through` how. A table with `via: null`
 * cannot be attributed by any rule — that is a finding, not an omission.
 */
const TABLES = Object.freeze({
  // ── Task assignment and ownership ──
  daily_tasks: {
    area: 'task assignment and ownership',
    via: 'user_id',
    through: 'the assignee\'s active membership',
    klass: CLASS.DERIVABLE,
    note: 'A task assigned to a shared employee is AMBIGUOUS per row, not per table: the class '
      + 'here is the best case, and the proposal tool reports the actual split.',
  },
  // ── Performance scoring, coaching and escalation ──
  performance_scores: {
    area: 'performance scoring, coaching and escalation',
    via: 'user_id',
    through: 'the scored employee\'s active membership',
    klass: CLASS.DERIVABLE,
    note: 'A score is about a person\'s work FOR a company, and for a shared employee one day can '
      + 'hold work for two. That was STRUCTURALLY IMPOSSIBLE until B7.21: the table carried '
      + 'UNIQUE(user_id, score_date), so Prasanthi\'s Tuesday could only ever have one score, '
      + 'belonging to whichever workflow wrote first. Now two partial unique indexes: one '
      + 'unattributed score per person per day, and one per person per company per day.',
  },
  weekly_kpis: {
    area: 'performance scoring',
    via: 'user_id',
    through: 'the employee\'s active membership',
    klass: CLASS.DERIVABLE,
  },
  // ── Historical records and reporting ──
  activity_logs: {
    area: 'historical records and reporting',
    via: 'user_id',
    through: 'the logging employee\'s active membership',
    klass: CLASS.DERIVABLE,
  },
  // ── Objectives and milestones ──
  milestones: {
    area: 'objectives and milestones',
    via: 'owner_id',
    through: 'the owner\'s active membership',
    klass: CLASS.AMBIGUOUS_BY_NATURE,
    note: '`owner_id` is NULLABLE, so a milestone with no owner has nothing to derive from. A '
      + 'company milestone is also a company-level fact in its own right — it may belong to a '
      + 'company whose employee does not own it — so this needs explicit assignment.',
  },
  targets: {
    area: 'objectives and milestones',
    via: 'user_id',
    through: 'the target holder\'s active membership',
    klass: CLASS.AMBIGUOUS_BY_NATURE,
    note: '`user_id` is nullable and a `team` target has none at all. A team target belongs to a '
      + 'company by decision, not derivation.',
  },
  // ── Orders and revenue metrics ──
  orders: {
    area: 'orders and revenue metrics',
    via: null,
    through: null,
    klass: CLASS.UNATTRIBUTABLE,
    note: 'MEASURED: an order is (order_date, amount, buyer_type, product_category, status, notes). '
      + 'No buyer id, no seller, no owner, no SKU reference. Revenue cannot be attributed by any '
      + 'rule. Requires explicit owner attribution or a new source of truth; until then these rows '
      + 'belong to no company and are invisible to every company-scoped read.',
  },
  metrics_snapshots: {
    area: 'orders and revenue metrics',
    via: null,
    through: null,
    klass: CLASS.PORTFOLIO,
    note: 'UNIQUE(snapshot_date): one row per day for the whole platform, built by summing orders '
      + 'and averaging performance scores across every company. An aggregate cannot be split back '
      + 'into its parts, so existing rows are PORTFOLIO-level and are labelled so. Company-specific '
      + 'snapshots require the unique constraint to become (snapshot_date, company_id) and start '
      + 'from the migration forward — they cannot be backfilled.',
  },
});

/** Tables that get a company_id column in the B7.21 migration. */
const SCOPED_TABLES = Object.freeze(Object.keys(TABLES)
  .filter((t) => TABLES[t].klass !== CLASS.PORTFOLIO));

/**
 * Tables measured as having no company ownership that are NOT in the scope of this change, listed
 * so the gap is stated rather than implied. Each still needs a decision; none is forgotten.
 */
const OUT_OF_SCOPE = Object.freeze({
  kpi_hierarchy: 'KPI tree structure; scoping follows weekly_kpis and targets',
  goal_cascades: 'goal cascade records; follows objectives',
  agent_activity_log: 'agent audit feed; company comes from the run, like the office kernel',
  approval_queue: 'legacy approval queue; office_approvals is the governed one and IS company-scoped',
  email_log: 'send ledger; company belongs on the outbound attempt, not retrofitted here',
});

/**
 * Can this row's company be derived, and if so which?
 *
 * Returns a VERDICT, never a guess. `memberships` is the list of active memberships for the person
 * the row names, obtained from identity/company-membership.js — this module never queries.
 *
 *   { ok: true,  companyId }            exactly one active membership
 *   { ok: false, reason: 'ambiguous' }  two or more — a decision, not a derivation
 *   { ok: false, reason: 'no_member' }  the person has no active membership
 *   { ok: false, reason: 'no_subject' } the row names nobody
 */
function deriveOwner({ memberships }) {
  if (memberships === null || memberships === undefined) {
    return { ok: false, reason: 'unknown', detail: 'membership could not be read; an outage is not an attribution' };
  }
  if (!Array.isArray(memberships) || memberships.length === 0) {
    return { ok: false, reason: 'no_member',
      detail: 'the person this row names has no active company membership' };
  }
  const companies = [...new Set(memberships.map((m) => m.companyId))];
  if (companies.length > 1) {
    return { ok: false, reason: 'ambiguous',
      detail: `the person is an active member of ${companies.length} companies (${companies.join(', ')}); `
        + 'which one this record belongs to is a decision, not a derivation' };
  }
  return { ok: true, companyId: companies[0] };
}

module.exports = {
  CLASS, TABLES, SCOPED_TABLES, OUT_OF_SCOPE, deriveOwner,
};
