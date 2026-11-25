#!/usr/bin/env node
// ── ONE PHASE, THEN EXIT ────────────────────────────────────────────────────
//
//   node scripts/office-cycle-tick.js                  # sweep: initiate, then advance each run
//   node scripts/office-cycle-tick.js --run <uuid>     # advance one run by one phase
//   node scripts/office-cycle-tick.js --company <id>   # restrict the sweep
//
// This is the body the cron calls, and it is ALSO how the restart requirement is demonstrated:
// every tick is a separate process that reads the cycle's phase from durable rows, does one
// thing, and exits. There is no resident state, so *"a controlled process restart and recovery
// without duplicate execution"* is not a recovery routine — it is what happens anyway.
//
// It exits 0 when it advanced something or had nothing to do, and non-zero only when it could not
// establish what to do. A tick that finds the cycle waiting on a worker is a successful tick.

'use strict';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };

(async () => {
  const INIT = require('../src/lib/office/initiator');
  const CYCLE = require('../src/lib/office/cycle');
  const log = (o) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...o })}\n`);

  const only = arg('run');
  const companyId = arg('company');

  // ── --business-day: THE CLOCK, INJECTED, FOR A CHECKER AND A BACKFILL ────
  //
  // The initiator stamps its intent key with the Chicago business day, which is what makes one
  // cycle per objective per day. A check that must demonstrate TWO consecutive cycles cannot wait
  // until tomorrow and must not rewrite the first run's intent key — agent_runs forbids that, by a
  // trigger, because run identity is immutable. So the day is injected through the dependency seam
  // the initiator already has, rather than read from an environment variable: a flag has to be
  // passed deliberately on a command line, and the cron passes none.
  const businessDay = arg('business-day');
  if (businessDay && !/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) {
    process.stderr.write('FAIL --business-day must be YYYY-MM-DD\n');
    process.exit(2);
  }
  const deps = businessDay
    ? { agentCore: { ...require('../src/lib/agent-core'), businessToday: () => businessDay } }
    : {};

  if (only) {
    const r = await CYCLE.advanceCycle({ runId: only }, deps);
    log({ at: 'advanced', runId: only, phase: r.phase, next: r.next, ok: r.ok,
      detail: r.refusal || r.reason || null });
    process.exit(r.phase === null ? 2 : 0);
  }

  // ── THE SWEEP: initiate what is due, then advance everything live ───────
  //
  // Initiation first, so a newly eligible objective gets a run in the same tick that discovers it.
  // Advancing second, so that run is immediately planned rather than waiting for the next tick —
  // one tick does one phase PER RUN, not one phase overall.
  const started = await INIT.initiateDueObjectives({ companyId }, deps);
  log({ at: 'initiated', businessDay: started.businessDay,
    started: started.initiated.length, duplicates: started.duplicates.length,
    refused: started.refused.length, skipped: started.skipped.length });

  for (const x of started.refused) {
    log({ at: 'initiation_refused', objectiveId: x.objectiveId, reason: x.reason, detail: x.detail });
  }

  const live = (await require('../src/lib/db').query(
    `SELECT run_id, objective_id FROM agent_runs
      WHERE workflow = $1 AND state IN ('CREATED','RUNNING')
        AND ($2::text IS NULL OR company_id = $2)
      ORDER BY created_at`, [INIT.WORKFLOW, companyId])).rows;

  for (const run of live) {
    try {
      const r = await CYCLE.advanceCycle({ runId: run.run_id }, deps);
      log({ at: 'advanced', runId: run.run_id, objectiveId: run.objective_id,
        phase: r.phase, next: r.next, ok: r.ok,
        detail: r.refusal || r.reason || null,
        waitingOn: r.waitingOn ? r.waitingOn.length : undefined });
    } catch (e) {
      // One run's failure must not stop the sweep: the others are independent objectives.
      log({ at: 'advance_failed', runId: run.run_id, detail: String(e.message).slice(0, 200) });
    }
  }
  process.exit(0);
})().catch((e) => {
  process.stderr.write(`FAIL ${e.stack || e.message}\n`);
  process.exit(1);
});
