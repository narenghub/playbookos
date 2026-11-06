// ── PRPA v5 — AUDIT HISTORY FOR THE OPPORTUNITY TRACKER ──────────────────────
//
// Ruling 27 item 1 asks for audit history. Three histories already exist and this does not
// duplicate them:
//
//   federal_opportunities.version_seq    every amendment, with the superseded version kept
//   opportunity_assessments              every qualification verdict, with its evidence basis
//   opportunity_bid_reviews              every human bid/no-bid decision, with its rationale
//
// What none of them records is the ACTION: who imported a batch, who confirmed a deadline, who
// resolved a duplicate, who exported the data and what they exported. Those are the operations a
// reviewer reconstructs when asking "how did this row come to say that", and until now they left
// no trace at all.
//
// APPEND-ONLY, by the same mechanism as rfq_identity_decisions. The application connects as a
// superuser today (ENG-003), and a superuser bypasses GRANT and RLS. A BEFORE trigger still fires,
// so the trigger is the thing that actually holds. Once ENG-003 lands, the restricted role has no
// UPDATE or DELETE grant on this table either, and the trigger stays as the belt to that braces.
//
// COMPANY-WELDED, like every other kernel table: the composite foreign key means a row cannot
// reference an opportunity belonging to a different company, which a plain FK on opportunity_id
// alone would permit.

'use strict';

const VERSION = '2026-11-06.opportunity-audit.v5';

const CREATED_TABLES = Object.freeze(['opportunity_audit_events']);
const ROLLBACK_ORDER = Object.freeze(['opportunity_audit_events']);

// The actions worth recording. An enumeration rather than free text for the same reason notice_type
// is one: "confirmed" written three different ways cannot be counted, and a typo becomes a new kind
// of event that no report will ever show.
//
// Note what is NOT here: nothing about sending anything to anybody. No action in this table reaches
// outside PlaybookOS, and there is no value that would let one look as though it had.
const AUDIT_ACTIONS = Object.freeze([
  'import.csv',              // a CSV was imported
  'import.url',              // a single solicitation URL was fetched and imported
  'import.rejected',         // a submitted record was refused by normalisation
  'amendment.recorded',      // a new version superseded a current one
  'duplicate.flagged',       // a possible cross-number duplicate was recorded for a human
  'duplicate.resolved',      // a human said same/different — never merged automatically
  'deadline.confirmed',      // a human confirmed a response deadline against the notice
  'assessment.run',          // the qualification engine ran, with its evidence basis
  'review.recorded',         // a human recorded bid / no_bid / undecided
  'export.csv',              // the data left the system as a file
  'documents.inspected',     // a notice's attachment list was retrieved
]);

const PRECONDITIONS = Object.freeze([
  // The parent must exist first. Running v5 before v4 would create a table whose foreign key
  // silently has nothing to point at — and CREATE TABLE would fail anyway, less legibly.
  {
    name: 'federal_opportunities exists',
    sql: `SELECT to_regclass('public.federal_opportunities') IS NOT NULL AS ok`,
    detail: 'v5 is additive to v4; apply 2026-11-06.opportunities.v4 first',
  },
  {
    name: 'companies exists',
    sql: `SELECT to_regclass('public.companies') IS NOT NULL AS ok`,
    detail: 'the office kernel schema must be applied first',
  },
]);

const DDL = [
  `CREATE TABLE IF NOT EXISTS opportunity_audit_events (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES companies(id),
     -- NULLable: an import or an export is an action on the whole set, not on one row.
     opportunity_id  TEXT,
     action          TEXT NOT NULL,
     actor           TEXT NOT NULL,
     actor_role      TEXT,
     at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     -- What happened, in whatever shape the action needs. Read, never executed.
     detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
     CONSTRAINT opportunity_audit_events_action
       CHECK (action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(', ')})),
     CONSTRAINT opportunity_audit_events_actor
       CHECK (length(btrim(actor)) > 0),
     -- Company-welded: when a row names an opportunity, that opportunity must belong to the same
     -- company.
     --
     -- MATCH SIMPLE, deliberately, and this is the one place in the PRPA schema where MATCH FULL is
     -- WRONG. MATCH FULL requires the referencing columns to be either all NULL or all non-NULL.
     -- company_id here is NOT NULL, so a row with opportunity_id NULL — an import or an export,
     -- which is an action on the whole set rather than on one row — is a partially-null pair and
     -- MATCH FULL refuses it outright. The first audit append of a set-wide action failed with
     -- exactly that violation.
     --
     -- MATCH SIMPLE skips the check when any referencing column is NULL. Because company_id cannot
     -- be NULL, the only skippable case is "this event names no opportunity", which is the case we
     -- want; whenever opportunity_id IS present, the full pair is enforced and cross-company
     -- reference is still impossible.
     CONSTRAINT opportunity_audit_events_opp_fk
       FOREIGN KEY (opportunity_id, company_id)
       REFERENCES federal_opportunities(id, company_id) MATCH SIMPLE ON DELETE RESTRICT,
     UNIQUE (id, company_id)
   )`,

  `CREATE INDEX IF NOT EXISTS opportunity_audit_events_by_opp
     ON opportunity_audit_events (company_id, opportunity_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS opportunity_audit_events_recent
     ON opportunity_audit_events (company_id, at DESC)`,
  `CREATE INDEX IF NOT EXISTS opportunity_audit_events_by_action
     ON opportunity_audit_events (company_id, action, at DESC)`,

  // Append-only. An audit trail that can be edited is a record of what somebody wanted the history
  // to look like.
  `CREATE OR REPLACE FUNCTION opportunity_audit_events_append_only() RETURNS trigger AS $fn$
     BEGIN
       RAISE EXCEPTION 'opportunity_audit_events is append-only: an audit event may not be altered or deleted'
         USING ERRCODE = 'check_violation';
     END; $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_opportunity_audit_events_append_only ON opportunity_audit_events`,
  `CREATE TRIGGER trg_opportunity_audit_events_append_only
     BEFORE UPDATE OR DELETE ON opportunity_audit_events
     FOR EACH ROW EXECUTE FUNCTION opportunity_audit_events_append_only()`,
];

const ROLLBACK_EXTRA_DDL = Object.freeze([
  `DROP TRIGGER IF EXISTS trg_opportunity_audit_events_append_only ON opportunity_audit_events`,
  `DROP FUNCTION IF EXISTS opportunity_audit_events_append_only()`,
]);

module.exports = {
  VERSION, DDL, CREATED_TABLES, ROLLBACK_ORDER, ROLLBACK_EXTRA_DDL, PRECONDITIONS, AUDIT_ACTIONS,
};
