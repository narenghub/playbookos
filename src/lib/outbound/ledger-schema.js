// ── THE COMMON OUTBOUND EXECUTION LEDGER ─────────────────────────────────────
//
// CEO authorization 2026-11-10, S1.1 item 2. One durable per-message record for EVERY outbound
// transport, so "what left the building" is answerable without knowing which code path sent it.
//
// ── WHY email_log AND NOT A NEW TABLE ────────────────────────────────────────
//
// The authorization is explicit: "Reuse existing durable audit infrastructure where suitable.
// Avoid duplicate competing ledgers." There are already four places that record outbound email:
//
//   email_log              every Resend send, including stopped_by_policy. Queried by
//                          scripts/confirm-legacy-email-state.js as THE evidence of what reached
//                          an outside address.
//   supplier_outreach_log  the RFQ claim, with provider / provider_message_id /
//                          provider_accepted_at / approval_id / run_id already on it.
//   cphi_followup_sends    the CPHI claim.
//   outreach_sends         the outreach claim.
//
// The last three are DOMAIN claims. Each exists to make one business action happen at most once —
// one RFQ per supplier per request, one follow-up per contact per step — and each is keyed by its
// own domain columns with a UNIQUE index deciding the race. That is idempotency, and it works.
//
// What was missing is the TRANSPORT record: the fact that a message was prepared, authorized,
// claimed, handed to a provider, and what the provider said. `email_log` is already that for one
// transport out of four, which is exactly why section 9 of the production checker reported
// "0 external recipients" while being structurally unable to see the two Gmail senders — they
// write nothing to it.
//
// So this extends email_log rather than competing with it. The domain tables keep owning
// idempotency; the ledger references their claim through `claim_ref` so the two are linked without
// either duplicating the other.
//
// ── WHY THIS IS NOT IN db.js's BOOT BLOCK ────────────────────────────────────
//
// db.js runs its migrations at startup, so putting these ALTERs there would execute a production
// migration by the act of deploying. The authorization says: "If a production migration is
// required, prepare it but do not execute it." It is therefore a standalone, deliberate step —
// scripts/migrate-outbound-ledger.js — in the same shape as scripts/migrate-connectors.js.
//
// CONSEQUENCE, STATED LOUDLY: the ledger fails CLOSED. Deploying this code without running the
// migration refuses consequential email, because a consequential action with no durable record is
// the thing S1 was about. That is safe today only because email is already held. It is in the
// decision packet, not buried here.

'use strict';

// ── OUTCOME SEMANTICS (authorization item 3) ────────────────────────────────
//
// Seven states, and the distinctions between them are the whole point:
//
//   PREPARED           the message exists and authorization has not yet been decided
//   BLOCKED            policy refused it. NOTHING was handed to a provider. Never counted as sent
//   CLAIMED            this executor has taken durable responsibility for attempting it. Written
//                      BEFORE the provider call, so a crash in between is visible as an attempt
//                      that may have happened rather than as nothing
//   PROVIDER_ACCEPTED  the provider acknowledged and returned an id. NOT proof of inbox delivery
//   PROVIDER_REJECTED  the provider answered and refused. Definite: nothing was sent
//   OUTCOME_UNKNOWN    the provider did not answer, or answered without an id. Tokens may have
//                      been spent and the message may have gone. NEVER eligible for automatic
//                      retry — that is how one uncertain send becomes two real ones
//   RECONCILED         a human or a reconciliation job later established what actually happened
const OUTCOMES = Object.freeze([
  'PREPARED', 'BLOCKED', 'CLAIMED',
  'PROVIDER_ACCEPTED', 'PROVIDER_REJECTED', 'OUTCOME_UNKNOWN', 'RECONCILED',
]);

// Outcomes that mean a message may have reached a recipient. Used by reports so "sent" is never
// computed by excluding the states somebody remembered to exclude.
const MAY_HAVE_LEFT = Object.freeze(['PROVIDER_ACCEPTED', 'OUTCOME_UNKNOWN']);

// Outcomes that definitely transmitted nothing.
const DEFINITELY_NOT_SENT = Object.freeze(['PREPARED', 'BLOCKED', 'PROVIDER_REJECTED']);

const TABLE = 'email_log';

// Idempotent, and ordered so a partially applied run can be repeated safely.
const DDL = [
  // The table itself predates this; these are the columns that make it a transport-spanning ledger.
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS transport TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS provider TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS workflow TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS agent TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS company_id TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS correlation_id TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS outcome TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS stop_scope TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS approval_id TEXT`,
  // A digest, never the body. The authorization: "Do not log message bodies, secrets or access
  // tokens unnecessarily." A digest proves the artefact that was approved is the artefact that was
  // sent, which is the only property an audit needs from the content.
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS payload_digest TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS provider_message_id TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS provider_responded_at TIMESTAMPTZ`,
  // The domain claim this transport attempt belongs to — 'cphi_followup_sends:1234' and the like.
  // The link, rather than a second copy of the claim.
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS claim_ref TEXT`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS reconciled_note TEXT`,

  // ── THE CONSTRAINT THAT MAKES THE SEMANTICS REAL ──────────────────────────
  //
  // Without it, OUTCOMES is a comment. Legacy rows carry NULL and are left alone: back-filling an
  // outcome onto a historical row would invent a fact, and "we do not know what this old row was"
  // is itself true and worth preserving.
  `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS email_log_outcome_check`,
  `ALTER TABLE ${TABLE} ADD CONSTRAINT email_log_outcome_check
     CHECK (outcome IS NULL OR outcome IN (${OUTCOMES.map((o) => `'${o}'`).join(',')}))`,

  // A BLOCKED row must name the scope that blocked it, or the refusal cannot be explained later —
  // and an unexplainable refusal is indistinguishable from a bug.
  `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS email_log_blocked_needs_scope`,
  `ALTER TABLE ${TABLE} ADD CONSTRAINT email_log_blocked_needs_scope
     CHECK (outcome <> 'BLOCKED' OR (stop_scope IS NOT NULL AND length(btrim(stop_scope)) > 0))`,

  // A row claiming provider acceptance must carry WHEN the provider answered. Acceptance with no
  // timestamp is the shape that let `released_at` mean three different things in office_approvals.
  `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS email_log_accepted_needs_time`,
  `ALTER TABLE ${TABLE} ADD CONSTRAINT email_log_accepted_needs_time
     CHECK (outcome <> 'PROVIDER_ACCEPTED' OR provider_responded_at IS NOT NULL)`,

  `CREATE INDEX IF NOT EXISTS idx_email_log_outcome ON ${TABLE} (outcome, sent_at)`,
  `CREATE INDEX IF NOT EXISTS idx_email_log_transport ON ${TABLE} (transport, sent_at)`,
  `CREATE INDEX IF NOT EXISTS idx_email_log_correlation ON ${TABLE} (correlation_id)`,
  // ── THE CLAIM IS ARBITRATED BY THE DATABASE ────────────────────────────────
  //
  // One claimed row per claim_ref. Without this, idempotency was a read-then-write race:
  // beginAttempt → priorClaim (nobody has claimed yet) → claim → send, with twelve concurrent
  // dispatches under one key all passing the read and FOUR of them reaching the provider. Measured,
  // not theorised: scripts/check-ledger-accounting-db.js produced exactly that.
  //
  // priorClaim() is kept — it gives the honest refusal reason for the ordinary sequential case, and
  // it catches a retry minutes later. But it cannot be the guarantee, because two transactions can
  // both read "no prior claim" before either writes. The guarantee is this index: the second
  // UPDATE to CLAIMED under the same claim_ref violates it and the caller refuses.
  //
  // PARTIAL, over the outcomes that mean responsibility was taken. A PREPARED row carries a
  // claim_ref too and there may legitimately be many of those under one key — every refused
  // duplicate writes one — so a plain unique index would reject the refusals as well.
  //
  // DEPLOYMENT NOTE: CREATE UNIQUE INDEX fails if the table already holds two claimed rows under
  // one claim_ref. Production has had no such constraint, so the migration must be run with that
  // possibility in mind; scripts/check-claim-uniqueness-live.js reports it read-only first.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_log_one_claim_per_ref
     ON ${TABLE} (claim_ref)
     WHERE claim_ref IS NOT NULL
       AND outcome IN ('CLAIMED', 'PROVIDER_ACCEPTED', 'OUTCOME_UNKNOWN', 'RECONCILED')`,
];

// ROLLBACK, documented and executable. Drops only what this migration added — email_log itself and
// its original columns are older than this and are never touched.
const ROLLBACK = [
  'DROP INDEX IF EXISTS idx_email_log_one_claim_per_ref',
  'DROP INDEX IF EXISTS idx_email_log_correlation',
  'DROP INDEX IF EXISTS idx_email_log_transport',
  'DROP INDEX IF EXISTS idx_email_log_outcome',
  `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS email_log_accepted_needs_time`,
  `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS email_log_blocked_needs_scope`,
  `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS email_log_outcome_check`,
  ...['reconciled_note', 'claim_ref', 'provider_responded_at', 'claimed_at', 'provider_message_id',
    'payload_digest', 'approval_id', 'stop_scope', 'outcome', 'correlation_id', 'company_id',
    'agent', 'workflow', 'provider', 'transport',
  ].map((c) => `ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS ${c}`),
];

const ADDED_COLUMNS = Object.freeze([
  'transport', 'provider', 'workflow', 'agent', 'company_id', 'correlation_id', 'outcome',
  'stop_scope', 'approval_id', 'payload_digest', 'provider_message_id', 'claimed_at',
  'provider_responded_at', 'claim_ref', 'reconciled_note',
]);

module.exports = { DDL, ROLLBACK, TABLE, OUTCOMES, MAY_HAVE_LEFT, DEFINITELY_NOT_SENT, ADDED_COLUMNS };
