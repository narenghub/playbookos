// ── ONE ACCEPTANCE RUN MUST NOT INHERIT ANOTHER'S ATTEMPT HISTORY ───────────
//
// Found on 2026-11-19, during the final preflight for the third hardware run. The development
// database held three leftover `agent_runs` rows:
//
//     m75-expire   ABANDONED
//     m75-cancel   ABANDONED
//     m75-stop     ABANDONED
//
// — the exact intent keys scenarios 5, 3 and 4 reuse. Zero tasks remained, so the queue looked
// clean and the stale-fixture gate passed.
//
// It would not have been clean. When a worker claims a task, `leases.js` looks up the prior run
// for that intent key, finds an ABANDONED predecessor, and `reattemptEligibility` returns
// `override_reason_required`: "an ABANDONED predecessor needs a recorded reason of at least 10
// characters — the outcome is unknown and somebody must own accepting that". The claim is refused.
// Had it got past that, `trg_agent_runs_retry_guard` raises the same requirement in the database.
//
// So scenarios 3, 4 and 5 would have reported "the Mac never claimed the task", and because the
// worker demonstrably WAS polling, the liveness probe would have ruled out "no worker" and
// recorded three product FAILs — for a governance guard working exactly as designed, two layers
// below where anyone would look. That is the third time a previous run's residue would have
// corrupted the next run's evidence.
//
// ── THE FIX IS ISOLATION, NOT CLEANUP ──────────────────────────────────────
//
// Deleting those rows would fix today and nothing else, and deletion is destructive. Passing an
// `overrideReason` would be the test reaching around a governance guard to make itself pass, which
// would also mean exercising a path real work never takes. Neither.
//
// Instead every invocation mints its own run id, and every intent key carries it. A run can then
// only ever be its own predecessor's successor, and the ABANDONED rows stay exactly where they
// are — still protecting their own intents, which is their job.
//
// WITHIN a run the key is stable, because scenario 6's duplicate-submission test needs both
// submissions to land on the same intent and the same run. Isolation is between invocations, not
// between the two halves of one assertion.
//
// The `m75-` prefix is preserved so `m7-5-state-report.js`, the driver's own stale-fixture gate and
// every `intent_key LIKE 'm75-%'` query keep matching.

'use strict';

const crypto = require('crypto');

/** Every key this module produces starts here, so existing `m75-%` inspection still finds them. */
const PREFIX = 'm75';

/**
 * Time-ordered and random. The timestamp makes a run's fixtures sortable and recognisable by eye
 * when reading the database afterwards; the random suffix is what guarantees two invocations
 * cannot collide — including two started in the same second, which is exactly what a retried run
 * after a failure looks like.
 */
function newRunId(now = Date.now(), rand = () => crypto.randomBytes(3).toString('hex')) {
  return `${now.toString(36)}${rand()}`;
}

/** `m75-<runId>-<scenario>`. Lowercase, hyphenated, no characters that need quoting in SQL. */
function intentKey(runId, scenario) {
  if (!runId || !/^[a-z0-9]+$/.test(String(runId))) {
    throw new Error(`run id must be lowercase alphanumeric, got ${JSON.stringify(runId)}`);
  }
  if (!scenario || !/^[a-z0-9-]+$/.test(String(scenario))) {
    throw new Error(`scenario name must be lowercase, got ${JSON.stringify(scenario)}`);
  }
  return `${PREFIX}-${runId}-${scenario}`;
}

/** What every inspection query uses. Kept here so the prefix is declared once. */
const LIKE_PATTERN = `${PREFIX}-%`;

module.exports = { newRunId, intentKey, PREFIX, LIKE_PATTERN };
