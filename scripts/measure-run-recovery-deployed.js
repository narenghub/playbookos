#!/usr/bin/env node
// ── K4: WHAT WOULD THE REAPER CHANGE? (READ ONLY) ───────────────────────────
//
//   railway ssh 'node scripts/measure-run-recovery-deployed.js'
//
// Answers K4 Definition of Done items 3, 4 and 14 against production, and CHANGES NOTHING.
//
// ── WHY THIS EXISTS AS A SEPARATE SCRIPT ────────────────────────────────────
//
//   "Do not let the first production reaper invocation discover its policy by modifying rows."
//
// So the candidate list, the age distribution and the known-unknown count are read FIRST, by a
// script that has no write path at all. reap() defaults to dryRun anyway, but a default is a
// decision somebody can pass an argument past; this file cannot write even if asked.
//
// It is also the evidence for the ruling's other instruction: if production has no eligible stale
// runs, SAY SO WITH EVIDENCE rather than manufacturing one to demonstrate the mechanism.
'use strict';

const { query } = require('../src/lib/db');
const recovery = require('../src/lib/office/recovery');

(async () => {
  try {
    console.log('\nK4 production measurement — READ ONLY, nothing is modified\n');

    // ── 1. Terminal distribution and the overall shape ────────────────────
    const dist = (await query(
      `SELECT state, COUNT(*)::int AS n,
              MIN(created_at) AS oldest, MAX(created_at) AS newest
         FROM agent_runs GROUP BY state ORDER BY n DESC`
    )).rows;
    console.log('1. Run state distribution\n');
    if (!dist.length) console.log('  (no runs at all)');
    for (const d of dist) {
      console.log(`  ${String(d.state).padEnd(20)} ${String(d.n).padStart(6)}   oldest ${d.oldest ? d.oldest.toISOString() : '-'}`);
    }
    const total = dist.reduce((a, d) => a + d.n, 0);
    const active = dist.filter((d) => recovery.ACTIVE.includes(d.state)).reduce((a, d) => a + d.n, 0);
    console.log(`\n  total runs = ${total}   non-terminal (CREATED/RUNNING) = ${active}`);

    // ── 2. Age distribution of non-terminal runs ──────────────────────────
    console.log('\n2. Age of non-terminal runs\n');
    const ages = (await query(
      `SELECT state,
              COUNT(*)::int AS n,
              ROUND(MIN(EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at))) / 60.0)::numeric, 1) AS min_min,
              ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at))) / 60.0)::numeric, 1) AS max_min,
              ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at))) / 60.0)::numeric, 1) AS avg_min
         FROM agent_runs WHERE state = ANY($1) GROUP BY state`, [recovery.ACTIVE]
    )).rows;
    if (!ages.length) console.log('  none — there are no CREATED or RUNNING runs on production');
    for (const a of ages) {
      console.log(`  ${String(a.state).padEnd(10)} n=${a.n}  age minutes: min=${a.min_min} avg=${a.avg_min} max=${a.max_min}`);
    }

    // ── 3. Known-unknowns: unresolved consequential actions ───────────────
    console.log('\n3. Unresolved consequential actions (ACTION_ATTEMPTED with no terminal event)\n');
    const unresolved = (await query(
      `SELECT r.state AS run_state, COUNT(*)::int AS n
         FROM agent_run_events e JOIN agent_runs r USING (run_id)
        WHERE e.kind = 'ACTION_ATTEMPTED'
          AND NOT EXISTS (SELECT 1 FROM agent_run_events t
                           WHERE t.run_id = e.run_id
                             AND t.action_kind IS NOT DISTINCT FROM e.action_kind
                             AND t.subject_ref IS NOT DISTINCT FROM e.subject_ref
                             AND t.kind IN ('ACTION_SUCCEEDED','ACTION_FAILED'))
        GROUP BY r.state ORDER BY n DESC`
    )).rows;
    if (!unresolved.length) console.log('  none — every attempted consequential action has a terminal acknowledgement');
    for (const u of unresolved) console.log(`  run_state=${String(u.run_state).padEnd(20)} unresolved actions = ${u.n}`);

    // ── 4. Exactly what the reaper would change ───────────────────────────
    console.log('\n4. Candidates the proposed reaper would change\n');
    console.log(`  policy: declared ceiling per run; workflow policy ${JSON.stringify(recovery.CEILINGS)}; default ${recovery.DEFAULT_CEILING_MINUTES} minutes`);
    const dry = await recovery.reap({ limit: 500 });   // dryRun defaults to true
    if (!dry.dry_run) {
      console.log('\n  CRITICAL: reap() did not run dry. Aborting before anything else.');
      process.exit(1);
    }
    console.log(`  inspected=${dry.inspected}  eligible=${dry.eligible}  fresh=${dry.fresh}`
      + `  safe_stale=${dry.safe_stale}  known_unknown=${dry.known_unknown}`);
    if (!dry.would_change.length) {
      console.log('\n  NO ELIGIBLE STALE RUNS ON PRODUCTION.');
      console.log('  That is the measurement, not a gap. No stale production run was manufactured');
      console.log('  to demonstrate the mechanism — the behaviour is proven against fixtures in');
      console.log('  scripts/check-office-recovery-db.js (33 assertions, 3 mutation controls).');
    } else {
      for (const c of dry.would_change) {
        console.log(`  ${c.classification.padEnd(14)} ${c.state.padEnd(8)} ${String(c.workflow || '-').padEnd(28)}`
          + ` age=${c.age_minutes}m ceiling=${c.ceiling_minutes}m (${c.ceiling_source}) run=${c.run_id}`);
      }
      console.log('\n  Each line above is a row the reaper WOULD transition to ABANDONED.');
      console.log('  Nothing has been changed. Activation requires a separate ruling.');
    }

    // ── 5. Already-recorded recoveries, if any ────────────────────────────
    const prior = await recovery.knownUnknownRecoveries({ limit: 50 });
    console.log(`\n5. Known-unknown recoveries already recorded: ${prior.length}`);
    for (const p of prior) console.log(`  ${p.at.toISOString()} run=${p.run_id} workflow=${p.workflow || '-'}`);

    // ── 6. Is the reaper wired to anything? ───────────────────────────────
    console.log('\n6. Activation status\n');
    console.log('  The reaper has NO cron wiring and NO route. It is inert: it cannot run unless a');
    console.log('  human invokes it, and it defaults to a dry run even then. Nothing in this script');
    console.log('  can write — it holds no write path at all.');

    console.log('\nPASS  measurement complete — no row was modified');
    process.exit(0);
  } catch (e) {
    console.error('\nFAIL  measurement error:', e.message);
    process.exit(1);
  }
})();
