#!/usr/bin/env node
// ── THE EVIDENCE TRAIL FOR THE 72-HOUR RELIABILITY RUN (B4.7) ───────────────
//
//   node scripts/office-reliability-sampler.js --objective <id> [--interval-seconds 60]
//        [--duration-hours 72] [--out <path>]
//
//   exit 0 = the run completed and its summary is written
//   exit 1 = it stopped early, or an abort condition fired
//   exit 3 = NOT EXECUTED (the database is not identified as development)
//
// Owner's Priority 6, second directive of 2026-11-25: *"Prepare the 72-hour continuous reliability
// run after these prerequisites are verified."* B4.7's acceptance is *"72 h, zero unexplained
// gaps"* — and that is a claim about a THREE-DAY period, which nobody is going to watch.
//
// ── WHY A SAMPLER AND NOT A LOG ────────────────────────────────────────────
//
// "Zero unexplained gaps" cannot be established from the application's own logs. A process that
// dies writes nothing about having died, and a log that simply stops is indistinguishable from a
// quiet period — which is the whole failure this run exists to detect. The only way to measure a
// gap is for something OUTSIDE the system under test to take a reading at a known interval and
// record the interval it actually achieved.
//
// So this samples. Each line is one reading with the wall-clock time it was taken, appended
// immediately: a crash loses at most the sample in flight, and the gap it leaves is visible in the
// timestamps of the lines around it. The file IS the evidence, and it is readable by somebody who
// was asleep for the three days it covers.
//
// ── IT IS READ-ONLY, AND IT REFUSES A DATABASE IT CANNOT IDENTIFY ──────────
//
// It writes nothing to the database — no alerts, no heartbeats, no runs — and makes no provider
// call and no outward call. The only thing it writes is its own file.
//
// And it refuses to run against a database that is not identified as development, through
// `scripts/lib/db-identity.js`: reading production from an operator's laptop is the thing the
// standing instruction forbids, and a read-only tool is still a connection to production. The
// identification is positive — a database that cannot be inspected is `cannot_tell`, which is a
// refusal, not permission.
//
// ── WHAT IT CANNOT PROVE ───────────────────────────────────────────────────
//
// That the office DID something useful. It measures continuity: that the scheduler kept beating,
// that runs reached terminal states, that alerts opened and closed, that no section became
// unreadable, that exposure stayed bounded. Whether the work was worth doing is a different
// question and belongs to the acceptance criteria, not to a sampler.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXIT_NOT_EXECUTED = 3;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const OBJECTIVE = arg('objective');
const INTERVAL_SECONDS = Math.min(3600, Math.max(5, Number.parseInt(arg('interval-seconds', '60'), 10) || 60));
// `--duration-seconds` exists for the harness check, which runs this for seconds rather than days.
// The first version clamped `--duration-hours` to a minimum of 0.01 — 36 seconds — so a 12-second
// run silently became a 36-second one and every reconciliation in the summary was against the wrong
// expectation. A clamp that SILENTLY changes what was asked for is a lie told by a safety rail.
const DURATION_SECONDS = (() => {
  const secs = arg('duration-seconds', null);
  if (secs !== null) {
    const v = Number.parseFloat(secs);
    if (Number.isFinite(v) && v > 0) return Math.min(240 * 3600, v);
  }
  const hours = Number.parseFloat(arg('duration-hours', '72'));
  const h = Number.isFinite(hours) && hours > 0 ? hours : 72;
  return Math.min(240 * 3600, h * 3600);
})();
const DURATION_HOURS = DURATION_SECONDS / 3600;
const OUT = String(arg('out', path.join(process.cwd(), `reliability-${Date.now()}.jsonl`)));
// A gap is a sample that arrived far later than it was due. Three intervals, because one late
// sample is a slow query and three is something having stopped.
const GAP_FACTOR = Math.max(2, Number.parseFloat(arg('gap-factor', '3')));

/**
 * Is the interval this sample actually achieved a GAP rather than a late sample?
 *
 * Pure, and exported, because it is the one piece of arithmetic B4.7's whole claim rests on and it
 * is worth being able to measure on its own, with explicit timestamps.
 *
 * ── CORRECTED 2026-11-26 ───────────────────────────────────────────────────
 *
 * This comment used to say an end-to-end demonstration was *"not available here"* because the
 * container's clock advances with CPU time, so a SIGSTOPped sampler perceives nothing. The first
 * half is true and the conclusion was wrong: the clock advances with CPU time, which is not the
 * STOPPED process's CPU time. With a sibling burning CPU, the clock moves and the resumed sampler
 * sees the whole interval. `check-reliability-sampler-db.js` section 2b now stops this process for
 * real and asserts the gap it records — a 15s gap, from an actual SIGSTOP — which is what the owner
 * asked be validated. The limitation was a conclusion standing in for a measurement.
 *
 * One thing that measurement taught, which matters to anyone reading a gap figure: the threshold is
 * computed from the interval IN FORCE, and `--interval-seconds` is clamped to a 5s floor. A caller
 * who asks for 1 and reasons about a 3s threshold is reasoning about 15s.
 */
function isGap(lastAtMs, nowMs, intervalSeconds, factor) {
  const actualSeconds = (nowMs - lastAtMs) / 1000;
  return { gap: actualSeconds > intervalSeconds * factor, actualSeconds };
}

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

async function main() {
  if (!OBJECTIVE) {
    die('--objective <id> is required: the company is READ from the objective, never supplied.\n'
      + 'Usage: node scripts/office-reliability-sampler.js --objective <id> '
      + '[--interval-seconds 60] [--duration-hours 72|--duration-seconds N] [--out <path>]');
  }
  const { query } = require('../src/lib/db');
  const deps = { query };

  // ── 1. REFUSE ANYTHING THAT COULD BE PRODUCTION ─────────────────────────
  //
  // THE PRECEDENCE IS COPIED FROM `office/business-day-override.js` (B3.20), deliberately, because
  // it is the same question — "could this be production?" — and two answers to it would be one
  // answer too many:
  //
  //   1. `NODE_ENV=production` refuses outright. No signal overrides it.
  //   2. a DISPOSABLE test cluster is permitted BY CONSTRUCTION, because its data directory is one
  //      `scripts/lib/pg-disposable.js` created. Production cannot be one.
  //   3. otherwise `scripts/lib/db-identity.js` must POSITIVELY identify the database as
  //      development. `unidentified` and `cannot_tell` are refusals, not permission.
  //
  // Step 2 is before step 3 for the reason B3.20 recorded: `initDB` seeds an admin, `users` is a
  // production table, and the fingerprint rule therefore reads a freshly migrated scratch database
  // as production — correctly, by its own rule, and uselessly for a tool that has to run against
  // one. Loosening the fingerprint rule would have been the wrong fix; asking the cheaper, stronger
  // question first is not.
  //
  // A read-only tool is still a connection to production, which is why this gate exists at all.
  const OVERRIDE = require('../src/lib/office/business-day-override');
  if (String(process.env.NODE_ENV) === 'production') {
    die('NODE_ENV=production — this sampler never runs against production, read-only or not',
      EXIT_NOT_EXECUTED);
  }
  let permittedBy = null;
  // `isDisposableCluster(query)` takes the QUERY FUNCTION and returns `{yes, detail}` — read off
  // its signature, not assumed. Passing `{query}` would have made `yes` undefined, which is falsy,
  // so the refusal would have looked like a working guard while measuring nothing.
  let disposable = { yes: false, detail: 'not asked' };
  try { disposable = await OVERRIDE.isDisposableCluster(query); } catch (_) { /* refuses below */ }
  if (disposable.yes) {
    permittedBy = `disposable_test_cluster (${disposable.detail})`;
  } else {
    const IDENTITY = require('./lib/db-identity');
    let identity = null;
    try {
      // `identifyDatabase(query)` — the module's own name and shape, read off its exports rather
      // than guessed. It returns `{verdict, findings, tables, detail}`.
      identity = await IDENTITY.identifyDatabase(query);
    } catch (e) {
      die(`the database could not be identified (${e.message}) — refusing: cannot_tell is a `
        + 'refusal, not permission', EXIT_NOT_EXECUTED);
    }
    if (!identity || identity.verdict !== IDENTITY.VERDICT.DEVELOPMENT) {
      die(`the database is ${identity ? identity.verdict : 'unidentified'}`
        + `${identity && identity.detail ? ` (${identity.detail})` : ''} — this sampler runs only `
        + 'against a development database. A read-only tool is still a connection to production.',
      EXIT_NOT_EXECUTED);
    }
    permittedBy = `db_identity:${identity.verdict}`;
  }

  const CTXMOD = require('../src/lib/office/context');
  const CC = require('../src/lib/office/command-center');
  const SCOPE = require('../src/lib/office/scope');

  let ctx = null;
  try {
    ctx = await CTXMOD.resolveObjectiveContext({ objectiveId: OBJECTIVE }, deps);
  } catch (e) {
    die(`no autonomous-office context for ${OBJECTIVE}: ${e.message}`);
  }

  const startedAt = Date.now();
  const endsAt = startedAt + DURATION_SECONDS * 1000;
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  const write = (o) => out.write(`${JSON.stringify(o)}\n`);

  const state = {
    samples: 0, errors: 0, gaps: [], maxGapSeconds: 0,
    terminalRuns: new Set(), alertsSeen: new Set(), maxUnresolvedUsd: 0,
    unreadableSections: new Set(), heartbeatMaxAgeSeconds: 0,
  };

  write({
    kind: 'run_started',
    at: new Date(startedAt).toISOString(),
    objective: OBJECTIVE, company: ctx.companyId,
    intervalSeconds: INTERVAL_SECONDS, durationHours: DURATION_HOURS, gapFactor: GAP_FACTOR,
    // Recorded so the evidence says what it was taken against. A three-day file whose commit is
    // unknown cannot be used to argue anything about a deployed build.
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null,
    permittedBy,
    note: 'read-only sampler: it writes nothing to the database and sends nothing',
  });

  let stopping = false;
  const stop = (why) => { if (!stopping) { stopping = true; state.stopReason = why; } };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  let lastAt = Date.now();
  while (!stopping && Date.now() < endsAt) {
    const dueAt = lastAt + INTERVAL_SECONDS * 1000;
    const waitMs = Math.max(0, dueAt - Date.now());
    await new Promise((r) => setTimeout(r, waitMs));
    const now = Date.now();

    // ── THE GAP MEASUREMENT, WHICH IS THE POINT ───────────────────────────
    const { gap: isAGap, actualSeconds } = isGap(lastAt, now, INTERVAL_SECONDS, GAP_FACTOR);
    if (isAGap) {
      const gap = { at: new Date(now).toISOString(), seconds: Math.round(actualSeconds) };
      state.gaps.push(gap);
      state.maxGapSeconds = Math.max(state.maxGapSeconds, gap.seconds);
      // A gap in the SAMPLER is not a gap in the office, and saying so is the difference between
      // evidence and an accusation: a laptop that slept recorded nothing about the server.
      write({ kind: 'sampler_gap', ...gap,
        note: 'this is a gap in the SAMPLER, which may or may not coincide with one in the office '
          + '— the samples either side are what say which' });
    }
    lastAt = now;

    try {
      const snap = await CC.snapshot(ctx, { limitHistory: 10 }, deps);
      const beats = await SCOPE.schedulerHeartbeats(deps).catch(() => []);
      const advance = beats.find((b) => b.name === 'office-cycle-advance');
      const beatAge = advance ? Math.round((now - new Date(advance.at).getTime()) / 1000) : null;
      if (beatAge !== null) {
        state.heartbeatMaxAgeSeconds = Math.max(state.heartbeatMaxAgeSeconds, beatAge);
      }

      for (const h of (snap.history || [])) {
        if (!['CREATED', 'RUNNING'].includes(h.state)) state.terminalRuns.add(h.run_id);
      }
      for (const a of (snap.openAlerts || [])) state.alertsSeen.add(a.id);
      for (const u of (snap.unreadable || [])) state.unreadableSections.add(u.section);
      for (const o of (snap.objectives || [])) {
        const x = Number(o.spend.unresolvedExposureUsd || 0);
        if (x > state.maxUnresolvedUsd) state.maxUnresolvedUsd = x;
      }

      state.samples += 1;
      write({
        kind: 'sample',
        at: new Date(now).toISOString(),
        intervalAchievedSeconds: Math.round(actualSeconds),
        schedulerHeartbeatAgeSeconds: beatAge,
        workers: snap.workers.map((w) => ({ id: w.id, name: w.name, kind: w.kind,
          status: w.status, lastAuthSeconds: w.lastAuthenticatedAgeSeconds })),
        liveCapabilities: snap.liveCapabilities,
        work: snap.work ? { byState: snap.work.byState,
          blocked: snap.work.blockedBacklog.length } : null,
        runs: (snap.history || []).map((h) => ({ id: h.run_id, state: h.state })),
        openAlerts: (snap.openAlerts || []).map((a) => ({ id: a.id, severity: a.severity,
          occurrences: a.occurrences })),
        objectives: (snap.objectives || []).map((o) => ({ id: o.id, status: o.status,
          held: o.spend.heldUsd, measured: o.spend.measuredUsd,
          unresolved: o.spend.unresolvedExposureUsd })),
        factQuality: snap.factQuality
          ? { supportable: snap.factQuality.supportable, total: snap.factQuality.total } : null,
        unreadable: snap.unreadable,
      });

      // ── ABORT CONDITIONS, AND THEY ARE DELIBERATELY FEW ─────────────────
      //
      // A sampler that aborts easily produces a two-hour file for a 72-hour question. These two
      // are the ones where continuing would be collecting evidence about a system nobody should
      // leave running: real money in an unresolved state, and a company whose authorization went
      // away mid-run.
      const exposure = (snap.objectives || []).reduce(
        (a, o) => a + Number(o.spend.unresolvedExposureUsd || 0), 0);
      if (exposure > 0) {
        write({ kind: 'abort', at: new Date(now).toISOString(), reason: 'unresolved_exposure',
          detail: `$${exposure} is held in an unresolved financial state — a dispatched hold whose `
            + 'charge nobody has reconciled keeps counting with no window, and only a human closes '
            + 'it. Continuing would be collecting evidence about a system that should be stopped.' });
        stop('unresolved_exposure');
      }
    } catch (e) {
      state.errors += 1;
      write({ kind: 'sample_error', at: new Date(now).toISOString(), error: e.message });
      // NOT an abort. A failed read is a finding — it is what the `unreadable` sections are for —
      // and a sampler that quits on one would lose the rest of a three-day window to a blip.
    }
  }

  const summary = {
    kind: 'run_summary',
    at: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    plannedHours: DURATION_HOURS,
    actualHours: Number(((Date.now() - startedAt) / 3600_000).toFixed(3)),
    samples: state.samples,
    sampleErrors: state.errors,
    samplerGaps: state.gaps.length,
    maxSamplerGapSeconds: state.maxGapSeconds,
    expectedSamples: Math.floor((Date.now() - startedAt) / (INTERVAL_SECONDS * 1000)),
    terminalRunsObserved: state.terminalRuns.size,
    distinctAlertsObserved: state.alertsSeen.size,
    maxUnresolvedExposureUsd: state.maxUnresolvedUsd,
    sectionsEverUnreadable: [...state.unreadableSections],
    maxSchedulerHeartbeatAgeSeconds: state.heartbeatMaxAgeSeconds,
    stopReason: state.stopReason || 'duration_reached',
    // The verdict is NOT computed here. "Zero unexplained gaps" has the word UNEXPLAINED in it, and
    // explaining a gap is a human act: a sampler cannot know that the laptop slept, that the
    // operator restarted the service, or that Railway moved the container. This file gives the
    // figures; B4.7's acceptance is a judgement made against them.
    verdict: 'not computed — see the note in this file and in docs/office/b4-7-72-hour-reliability-run.md',
  };
  write(summary);

  // ── WAIT FOR THE FILE, BECAUSE process.exit TRUNCATES A BUFFERED WRITE ────
  //
  // The first version called `out.end()` and then `process.exit()`. `createWriteStream` buffers, so
  // the SUMMARY LINE — the one line that reconciles samples against expectations and names the
  // stop reason — never reached the disk. Every sample survived, because those were written over
  // the life of the run and flushed as they went, and the file therefore looked complete right up
  // to the part a reader would actually use.
  //
  // Found by the harness check in a six-second run. In a 72-hour run it would have cost the
  // conclusion of the three days, and the file would have looked fine.
  await new Promise((resolve) => out.end(resolve));

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(state.stopReason && state.stopReason !== 'duration_reached' ? 1 : 0);
}

// ── REQUIRED RATHER THAN RUN: HAND OVER THE PURE PARTS AND DO NOTHING ───────
//
// A `return` at module top level was how this was written first. `node --check` accepts it, because
// CommonJS wraps every module in a function — and `scripts/js-lex.test.js` compiles each file
// properly and refused it as an illegal return statement. Two tools, two answers, and the stricter
// one was right: the same code in an ES module would not load at all.
//
// A sampler that started sampling on `require` would be a tool that cannot be tested, which is why
// the pure predicate is exported and nothing else happens here.
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`sampler failed: ${e.stack || e.message}\n`);
    process.exit(1);
  });
} else {
  module.exports = { isGap };
}
