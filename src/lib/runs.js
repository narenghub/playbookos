// ── RUN IDENTITY: INTENT, ATTEMPT, ACTION ────────────────────────────────────
//
// P0.3 items 2-3. Approved design: claude/p0-3-item2-retry-attempt-identity.md
//
// Three identities, kept separate on purpose:
//
//   INTENT    what business work are we trying to do        intent_key
//   ATTEMPT   this particular physical execution of it      run_id + attempt
//   ACTION    this exact consequential external effect      the existing claim tables
//
// Collapsing any two of them is how a retry becomes a duplicate email.
//
// ── THE CONCURRENCY ARBITER IS AN INDEX, NOT THIS CODE ───────────────────────
//
// uq_agent_runs_one_active is a partial unique index over the ACTIVE states. The database therefore
// permits at most one live execution per intent while allowing unlimited terminal attempts, and it
// does so without any application process choosing a number correctly.
//
// Advisory locks and SELECT … FOR UPDATE would also work. They were rejected for one reason: both
// are correct only while every future writer remembers to use them, and a forgotten lock fails
// silently. An index cannot be forgotten.
//
// uq_agent_runs_intent_attempt exists only to keep attempt NUMBERING honest. It is not the arbiter;
// two retries from different terminal predecessors would propose different numbers and pass it,
// and the ACTIVE index is what rejects one of them.
//
// ── WHY THE INTENT KEY NEEDS NO CRON PARSING ─────────────────────────────────
//
// Verified in node_modules, then empirically: node-cron calls the callback as
// `this._execution(now)` (task.js) where `now` is `timeMatcher.apply(date)` — a Date SHIFTED so its
// LOCAL fields spell the wall-clock time in the cron's configured timezone. It is NOT a real
// instant: for Asia/Kolkata the callback Date read 01:11Z while the true instant was 19:41Z.
// Reading it as an instant would have put the two IST briefings' keys 5.5 hours out.
//
// Its local getters, though, give exactly the wall-clock minute the matcher matched — proven
// identical to the true zone wall clock with the container TZ set to UTC, America/New_York and
// Asia/Tokyo. Since every one of the 37 registrations is a 5-field expression, the matcher's
// granularity is one minute, so THE MATCHED MINUTE IS THE SCHEDULED SLOT by definition. No
// expression registry, no cron-parser dependency, and no wall-clock truncation of Date.now() —
// which was the race the CEO rejected, where two containers either side of a minute boundary
// compute different keys for one scheduled occurrence.
'use strict';

const crypto = require('crypto');

const ACTIVE = ['CREATED', 'RUNNING'];
const TERMINAL = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'ABANDONED', 'STOPPED_BY_POLICY'];
const STATES = [...ACTIVE, ...TERMINAL];

// Which terminal states may produce another attempt, and which of those demand that a human record
// why they accepted the ambiguity. STOPPED_BY_POLICY needs no override: the work never ran, and the
// kill switch re-evaluates before the retry executes. A second expression of that rule would be a
// place for the two to disagree.
const RETRYABLE = ['FAILED', 'ABANDONED', 'PARTIAL', 'STOPPED_BY_POLICY'];
const RETRY_NEEDS_OVERRIDE = ['ABANDONED', 'PARTIAL'];
const MIN_OVERRIDE_REASON = 10;

const newRunId = () => crypto.randomUUID();

// ── INTENT KEYS ──────────────────────────────────────────────────────────────
// Opaque to consumers. Nothing downstream may parse meaning out of these strings: their job is
// identity, not presentation. The derivation can therefore change without invalidating history.

const two = (n) => String(n).padStart(2, '0');

/**
 * The scheduled slot a cron firing belongs to.
 * `firedAt` is the Date node-cron hands the callback. Local getters, deliberately — see the header.
 * Returns null when there is no firing context (a manual or test invocation), which leaves the run
 * unprotected against duplicate triggers rather than inventing an identity for it.
 */
function cronIntentKey(name, firedAt) {
  if (!(firedAt instanceof Date) || Number.isNaN(firedAt.getTime())) return null;
  const slot = `${firedAt.getFullYear()}-${two(firedAt.getMonth() + 1)}-${two(firedAt.getDate())}`
    + `T${two(firedAt.getHours())}:${two(firedAt.getMinutes())}`;
  return `cron:${name}:${slot}`;
}

// A provider's own event id is already an identity; inventing a second one would be duplication.
const webhookIntentKey = (endpoint, providerEventId) =>
  (providerEventId ? `webhook:${endpoint}:${providerEventId}` : null);

// A double-click inside the minute is one intent; a deliberate re-run a minute later is new work.
// A caller needing exactness supplies its own key.
function httpIntentKey(method, path, actor, at = new Date(), explicitKey = null) {
  if (explicitKey) return `http:${explicitKey}`;
  const d = at instanceof Date ? at : new Date();
  const slot = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
    + `T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}Z`;
  return `http:${method} ${path}:${actor || 'anonymous'}:${slot}`;
}

const parentIntentKey = (parentRunId, childWorkflow, ordinal = 0) =>
  `parent:${parentRunId}:${childWorkflow}:${ordinal}`;

// ── SCHEMA ───────────────────────────────────────────────────────────────────
const DDL = [
  `CREATE TABLE IF NOT EXISTS agent_runs (
     run_id                UUID PRIMARY KEY,
     parent_run_id         UUID REFERENCES agent_runs(run_id),
     root_run_id           UUID NOT NULL,
     trigger               TEXT NOT NULL,
     trigger_detail        TEXT,
     workflow              TEXT,
     agent                 TEXT,
     product               TEXT NOT NULL,
     tenant_id             TEXT,
     objective_id          TEXT,
     actor_user_id         TEXT,
     state                 TEXT NOT NULL,
     intent_key            TEXT,
     attempt               INTEGER NOT NULL DEFAULT 1,
     predecessor_run_id    UUID REFERENCES agent_runs(run_id),
     retry_override_reason TEXT,
     started_at            TIMESTAMPTZ,
     ended_at              TIMESTAMPTZ,
     heartbeat_at          TIMESTAMPTZ,
     cost_usd              NUMERIC(10,4),
     tokens_input          INTEGER,
     tokens_output         INTEGER,
     stopped_by            BIGINT,
     created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT agent_runs_state_check CHECK (state IN
       ('CREATED','RUNNING','SUCCEEDED','PARTIAL','FAILED','ABANDONED','STOPPED_BY_POLICY')),
     CONSTRAINT agent_runs_attempt_check CHECK (attempt >= 1)
   )`,

  // THE ARBITER. At most one active execution per intent; the slot frees the instant the row goes
  // terminal, so historical attempts are unlimited.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_one_active
     ON agent_runs (intent_key)
     WHERE intent_key IS NOT NULL AND state IN ('CREATED','RUNNING')`,

  // Numbering integrity only. Not the arbiter.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_intent_attempt
     ON agent_runs (intent_key, attempt) WHERE intent_key IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS idx_agent_runs_root ON agent_runs (root_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_intent ON agent_runs (intent_key, attempt)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_state_created ON agent_runs (state, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_heartbeat ON agent_runs (heartbeat_at)
     WHERE state = 'RUNNING'`,

  `CREATE TABLE IF NOT EXISTS agent_run_events (
     id            BIGSERIAL PRIMARY KEY,
     run_id        UUID NOT NULL REFERENCES agent_runs(run_id),
     at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     kind          TEXT NOT NULL,
     action_kind   TEXT,
     subject_type  TEXT,
     subject_ref   TEXT,
     success       BOOLEAN,
     error         TEXT,
     cost_usd      NUMERIC(10,4),
     tokens_input  INTEGER,
     tokens_output INTEGER,
     detail        JSONB
   )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events (run_id, at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_run_events_attempted
     ON agent_run_events (run_id) WHERE kind = 'ACTION_ATTEMPTED'`,

  // ── APPEND-ONLY EVIDENCE ───────────────────────────────────────────────────
  // Same mechanism as lead_outcomes (migrate-lead-outcomes.js:100) and autonomy_events: the
  // database refuses, so no future call path can quietly rewrite history.
  `CREATE OR REPLACE FUNCTION agent_run_events_append_only() RETURNS trigger AS $fn$
   BEGIN
     RAISE EXCEPTION 'agent_run_events is append-only: % is not permitted', TG_OP;
   END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_agent_run_events_append_only ON agent_run_events`,
  `CREATE TRIGGER trg_agent_run_events_append_only
     BEFORE UPDATE OR DELETE ON agent_run_events
     FOR EACH ROW EXECUTE FUNCTION agent_run_events_append_only()`,

  // ── RETRY ELIGIBILITY, ENFORCED BY THE DATABASE ────────────────────────────
  // In a trigger rather than in application code, so a call path added next year inherits it.
  `CREATE OR REPLACE FUNCTION agent_runs_retry_guard() RETURNS trigger AS $fn$
   DECLARE p agent_runs; unresolved INTEGER;
   BEGIN
     IF NEW.predecessor_run_id IS NULL THEN
       IF NEW.attempt <> 1 THEN
         RAISE EXCEPTION 'attempt % has no predecessor_run_id: an attempt beyond the first must name the attempt it retries', NEW.attempt;
       END IF;
       RETURN NEW;
     END IF;

     SELECT * INTO p FROM agent_runs WHERE run_id = NEW.predecessor_run_id;
     IF NOT FOUND THEN
       RAISE EXCEPTION 'predecessor_run_id % does not exist', NEW.predecessor_run_id;
     END IF;

     -- A retry is another attempt at the SAME work. Pointing at another intent's run would make
     -- the attempt history of both intents wrong.
     IF NEW.intent_key IS NULL OR p.intent_key IS NULL OR NEW.intent_key <> p.intent_key THEN
       RAISE EXCEPTION 'retry intent mismatch: predecessor intent % cannot be retried as %',
         COALESCE(p.intent_key, '(null)'), COALESCE(NEW.intent_key, '(null)');
     END IF;

     IF NEW.attempt <> p.attempt + 1 THEN
       RAISE EXCEPTION 'attempt must be predecessor attempt + 1 (got %, predecessor %)', NEW.attempt, p.attempt;
     END IF;

     IF NOT (p.state = ANY (ARRAY['FAILED','ABANDONED','PARTIAL','STOPPED_BY_POLICY'])) THEN
       RAISE EXCEPTION 'predecessor % is %, which may not be retried', p.run_id, p.state;
     END IF;

     -- A consequential action whose outcome never came back. The run may be retryable while THIS
     -- remains UNKNOWN_OUTCOME — neither failed nor safe — so proceeding requires a recorded human
     -- decision. A run-level authorisation does not resolve an action-level unknown.
     SELECT COUNT(*) INTO unresolved
       FROM agent_run_events e
      WHERE e.run_id = p.run_id AND e.kind = 'ACTION_ATTEMPTED'
        AND NOT EXISTS (
          SELECT 1 FROM agent_run_events t
           WHERE t.run_id = e.run_id
             AND t.action_kind IS NOT DISTINCT FROM e.action_kind
             AND t.subject_ref IS NOT DISTINCT FROM e.subject_ref
             AND t.kind IN ('ACTION_SUCCEEDED','ACTION_FAILED'));

     IF (p.state = ANY (ARRAY['ABANDONED','PARTIAL'])) OR unresolved > 0 THEN
       IF NEW.retry_override_reason IS NULL OR length(trim(NEW.retry_override_reason)) < 10 THEN
         RAISE EXCEPTION 'retrying a % predecessor with % unresolved consequential action(s) requires retry_override_reason (>= 10 chars): a human must record accepting the ambiguity',
           p.state, unresolved;
       END IF;
     END IF;

     RETURN NEW;
   END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_agent_runs_retry_guard ON agent_runs`,
  `CREATE TRIGGER trg_agent_runs_retry_guard
     BEFORE INSERT ON agent_runs
     FOR EACH ROW EXECUTE FUNCTION agent_runs_retry_guard()`,

  // ── A TERMINAL RUN IS IMMUTABLE ────────────────────────────────────────────
  // This is what guarantees "attempt 2 succeeding never rewrites attempt 1 into success", and that
  // STOPPED_BY_POLICY can never become SUCCEEDED. Identity columns are frozen too, so a row cannot
  // be re-pointed at another intent or renumbered after the fact.
  `CREATE OR REPLACE FUNCTION agent_runs_transition_guard() RETURNS trigger AS $fn$
   BEGIN
     IF OLD.state = ANY (ARRAY['SUCCEEDED','PARTIAL','FAILED','ABANDONED','STOPPED_BY_POLICY']) THEN
       IF NEW.state <> OLD.state THEN
         RAISE EXCEPTION 'run % is terminal (%): it cannot become %', OLD.run_id, OLD.state, NEW.state;
       END IF;
     ELSIF OLD.state = 'CREATED' THEN
       IF NOT (NEW.state = ANY (ARRAY['CREATED','RUNNING','FAILED','ABANDONED','STOPPED_BY_POLICY'])) THEN
         RAISE EXCEPTION 'CREATED may not go directly to %', NEW.state;
       END IF;
     ELSIF OLD.state = 'RUNNING' THEN
       IF NOT (NEW.state = ANY (ARRAY['RUNNING','SUCCEEDED','PARTIAL','FAILED','ABANDONED','STOPPED_BY_POLICY'])) THEN
         RAISE EXCEPTION 'RUNNING may not go to %', NEW.state;
       END IF;
     END IF;

     IF NEW.run_id <> OLD.run_id
        OR NEW.attempt <> OLD.attempt
        OR NEW.intent_key IS DISTINCT FROM OLD.intent_key
        OR NEW.predecessor_run_id IS DISTINCT FROM OLD.predecessor_run_id
        OR NEW.root_run_id <> OLD.root_run_id
        OR NEW.created_at <> OLD.created_at THEN
       RAISE EXCEPTION 'run identity is immutable: run_id, attempt, intent_key, predecessor_run_id, root_run_id and created_at may not be changed';
     END IF;

     RETURN NEW;
   END;
   $fn$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_agent_runs_transition_guard ON agent_runs`,
  `CREATE TRIGGER trg_agent_runs_transition_guard
     BEFORE UPDATE ON agent_runs
     FOR EACH ROW EXECUTE FUNCTION agent_runs_transition_guard()`,
];

async function migrateRuns(query) {
  for (const sql of DDL) await query(sql);
  // FK to autonomy_events is added separately: autonomy_events is created by migrateAutonomy, and a
  // hard dependency on migration ORDER is the kind of coupling that breaks a fresh deploy.
  try {
    await query(`ALTER TABLE agent_runs
                   ADD CONSTRAINT agent_runs_stopped_by_fkey
                   FOREIGN KEY (stopped_by) REFERENCES autonomy_events(id)`);
  } catch (e) {
    if (!/already exists|does not exist/i.test(e.message)) throw e;
  }
}

module.exports = {
  ACTIVE, TERMINAL, STATES, RETRYABLE, RETRY_NEEDS_OVERRIDE, MIN_OVERRIDE_REASON,
  newRunId, migrateRuns,
  cronIntentKey, webhookIntentKey, httpIntentKey, parentIntentKey,
};
