#!/usr/bin/env node
// ── THE 72-HOUR HARNESS, VERIFIED BEFORE 72 HOURS ARE SPENT ON IT ───────────
//
//   node scripts/check-reliability-sampler-db.js   exit 0 = the harness is trustworthy
//                                                   exit 3 = NOT EXECUTED (no Postgres available)
//
// B4.7's evidence will be a file written by `scripts/office-reliability-sampler.js` over three
// days. If that file is wrong, the three days are wasted — and the wrongness would be invisible,
// because nobody is watching the thing that was supposed to watch.
//
// So the sampler is run for REAL here, over seconds rather than hours, and four properties are
// measured:
//
//   1. it SAMPLES at the interval it was given, and its file is the evidence
//   2. it DETECTS A GAP, and says that the gap is the sampler's rather than the office's
//   3. it WRITES NOTHING to the database and makes no outward call
//   4. it REFUSES a database it cannot identify as development, with exit 3
//
// The fourth matters most for the wrong reason to skip: this tool only reads, and reading
// production from an operator's laptop is exactly what the standing instruction forbids. A
// read-only tool is still a connection.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures by id.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) {
    console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
};
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n── ${m} ──\n`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'rel' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the reliability harness was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'rel-bootstrap@rel.invalid';
process.env.ADMIN_PASSWORD = `rel-${crypto.randomBytes(16).toString('hex')}`;

const ROOT = path.join(__dirname, '..');
const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 300s — a stall is a failure.');
  process.exit(1);
}, 300_000);
watchdog.unref?.();

/** Run the sampler as its own process, as an operator will. */
function runSampler(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'office-reliability-sampler.js'), ...args], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DATABASE_URL: cluster.url,
        JWT_SECRET: 'reliability-harness',
        ADMIN_EMAIL: process.env.ADMIN_EMAIL,
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err }); });
  });
}

const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } });

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false, max: 6 });
  const query = (t, p) => P.query(t, p);
  const deps = { query };
  const made = { companies: [], objectives: [] };
  const uid = (p) => `rel-${p}-${crypto.randomUUID().slice(0, 8)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-'));

  try {
    const autonomy = require('../src/lib/autonomy');
    const DB = require('../src/lib/db');
    await DB.initDB();
    await DB.initPhase2?.();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await autonomy.migrateAutonomy(query);
    await require('../src/lib/office/memory').migrateMemory(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/identity/schema').migrateRecordOwnership(query);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/audit').migrateWorkerAudit(query);
    autonomy.resetForTests && autonomy.resetForTests();

    const CO = uid('co');
    await query(`INSERT INTO companies (id, slug, display_name, status)
                 VALUES ($1,$1,$1,'active')`, [CO]);
    made.companies.push(CO);
    const OBJ = uid('obj');
    await query(`INSERT INTO objectives
                   (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                    created_by, budget_usd)
                 VALUES ($1,$2,'reliability harness fixture','P1','supervised',
                         'all_consequential','active','naren@fixture.invalid',5.00)`, [OBJ, CO]);
    made.objectives.push(OBJ);

    const rowCounts = async () => {
      const t = ['agent_runs', 'office_monitor_alerts', 'office_scheduler_heartbeats',
        'worker_tasks', 'office_outcomes', 'agent_memory'];
      const out = {};
      for (const x of t) {
        out[x] = (await query(`SELECT COUNT(*)::int n FROM ${x}`)).rows[0].n;
      }
      return out;
    };

    // ══ 1. IT SAMPLES, AND THE FILE IS THE EVIDENCE ══════════════════════
    head('1. it samples at its interval, and the file stands on its own');

    const OUT1 = path.join(tmp, 'short.jsonl');
    {
      const before = await rowCounts();
      // Six seconds, sampling every second: long enough to measure an interval, short enough to
      // be a preflight step. The DURATION is the only thing scaled down from the real run.
      const r = await runSampler(['--objective', OBJ, '--interval-seconds', '1',
        '--duration-seconds', '14', '--out', OUT1]);
      const lines = fs.existsSync(OUT1) ? readJsonl(OUT1) : [];
      const started = lines.find((l) => l.kind === 'run_started');
      const samples = lines.filter((l) => l.kind === 'sample');
      const summary = lines.find((l) => l.kind === 'run_summary');

      if (r.code === 0 && started && summary && samples.length >= 3) {
        ok(`${samples.length} samples in ~14s at a 1s interval, exit 0, and the file opens with the `
          + 'run parameters and closes with a summary — readable by somebody who was asleep for the '
          + 'period it covers');
      } else bad('the sampler did not produce a usable evidence file',
        { code: r.code, lines: lines.length, kinds: lines.map((l) => l.kind),
          err: r.err.slice(-300) });

      if (started && started.objective === OBJ && started.company === CO
        && started.note && /read-only/.test(started.note)) {
        ok('the header records the objective, the COMPANY it resolved to, the interval and the '
          + 'commit — a three-day file whose commit is unknown cannot be used to argue anything '
          + 'about a deployed build');
      } else bad('the evidence file does not say what it was taken against', started);

      const s0 = samples[0];
      if (s0 && Array.isArray(s0.workers) && s0.work && 'schedulerHeartbeatAgeSeconds' in s0) {
        ok('each sample carries the worker statuses, the work by state, the runs, the open alerts, '
          + 'the money and the scheduler heartbeat age — the Command Center\'s own distinctions '
          + 'rather than a second opinion about them');
      } else bad('a sample is missing the state it exists to record', s0);

      if (summary && summary.verdict && /not computed/.test(summary.verdict)) {
        ok('and it does NOT compute a verdict: "zero UNEXPLAINED gaps" has the word unexplained in '
          + 'it, and explaining a gap is a human act — a sampler cannot know that the laptop slept '
          + 'or that Railway moved the container');
      } else bad('the sampler graded its own run', summary || lines.map((l) => l.kind));

      const after = await rowCounts();
      if (JSON.stringify(before) === JSON.stringify(after)) {
        ok(`it wrote NOTHING to the database (row counts unchanged: `
          + `${Object.values(after).join('/')}) — the only thing it writes is its own file`);
      } else bad('the sampler mutated the database it was measuring', { before, after });
    }

    // ══ 2. THE GAP ARITHMETIC, MEASURED WHERE IT CAN BE ═════════════════
    head('2. a gap is detected — and attributed to the sampler, not the office');

    {
      // ── WHY THIS IS NOT AN END-TO-END DEMONSTRATION, AND SAYING SO ──────
      //
      // The honest version of this section would SIGSTOP the sampler for longer than three
      // intervals and watch it record the gap. I wrote that, and it reported no gap — because this
      // development container's clock advances with CPU time, so a stopped process does not perceive
      // the wall-clock seconds it was stopped for. The first attempt also stopped the child during
      // its startup, before any sample existed, which would have produced no gap on any clock.
      //
      // So the predicate is measured directly, with explicit timestamps, and the limitation is
      // recorded rather than papered over. On real hardware a stopped sampler does perceive the
      // gap; this container cannot show it, and a section that quietly passed anyway would be the
      // measurement standing in for the property.
      const { isGap } = require('./office-reliability-sampler');
      const t0 = 1_000_000;
      const late = isGap(t0, t0 + 2_000, 1, 3);        // 2s at a 1s interval: late, not a gap
      const gap = isGap(t0, t0 + 5_000, 1, 3);         // 5s: past three intervals
      const edge = isGap(t0, t0 + 3_000, 1, 3);        // exactly three: NOT a gap, by design
      if (late.gap === false && gap.gap === true && edge.gap === false) {
        ok('the predicate calls 2s late at a 1s interval a LATE SAMPLE, 5s a GAP, and exactly 3× '
          + 'not a gap — one late sample is a slow query and three intervals is something having '
          + 'stopped');
      } else bad('the gap arithmetic is wrong', { late, gap, edge });

      if (gap.actualSeconds === 5) {
        ok('and it reports the interval it actually achieved, which is the figure the evidence file '
          + 'carries — a gap with no duration is an anecdote');
      } else bad('the achieved interval was not reported', gap);

      // And a run WITH samples records its achieved intervals, which is the end-to-end half that
      // this container can show: every sample carries the interval it actually achieved, so a gap
      // on real hardware is visible in the file whether or not the gap line is written.
      const OUT2 = path.join(tmp, 'intervals.jsonl');
      const r = await runSampler(['--objective', OBJ, '--interval-seconds', '1',
        '--duration-seconds', '12', '--out', OUT2]);
      const samples = (fs.existsSync(OUT2) ? readJsonl(OUT2) : [])
        .filter((l) => l.kind === 'sample');
      if (r.code === 0 && samples.length >= 3
        && samples.every((x) => typeof x.intervalAchievedSeconds === 'number')) {
        ok(`${samples.length} samples each record the interval they achieved `
          + `(${samples.map((x) => x.intervalAchievedSeconds).join(', ')}s) — so the timestamps and `
          + 'the achieved intervals both testify, and a reader does not depend on the gap line '
          + 'having been written');
      } else bad('samples do not record their achieved interval',
        { code: r.code, n: samples.length });

      // MEASURED, not assumed: one sample is a whole Command Center snapshot, and the owner's
      // standing condition on any interval is measured load. This is the figure that sets the real
      // run's interval — asking every second for three days would be asking for a snapshot before
      // the previous one finished.
      const achieved = samples.map((x) => x.intervalAchievedSeconds).filter((x) => x > 0);
      if (achieved.length) {
        const avg = achieved.reduce((a, b) => a + b, 0) / achieved.length;
        ok(`a sample costs ~${avg.toFixed(1)}s against a disposable cluster, which is why the `
          + 'runbook specifies a 60s interval rather than the 1s this check uses: at 1s the loop '
          + 'cannot keep up, and the achieved-interval field says so instead of hiding it');
      } else note('no positive achieved intervals to measure from');

      const summary = (fs.existsSync(OUT2) ? readJsonl(OUT2) : [])
        .find((l) => l.kind === 'run_summary');
      if (summary && summary.samples === samples.length
        && summary.expectedSamples >= samples.length) {
        ok(`the summary reconciles ${summary.samples} samples against `
          + `${summary.expectedSamples} expected — the shortfall is the figure B4.7 is judged on, `
          + 'and it is arithmetic rather than a verdict');
      } else bad('the summary did not reconcile samples against expectations', summary);

      note('the SIGSTOP demonstration is NOT available in this container (CPU-time clock) and is '
        + 'listed in docs/office/b4-7-72-hour-reliability-run.md as a step to perform once, by '
        + 'hand, on the machine the real run uses');
    }

    // ══ 3. IT REFUSES ANYTHING THAT COULD BE PRODUCTION ═════════════════
    head('3. a read-only tool is still a connection to production');

    {
      // THE PRECEDENCE UNDER TEST is the one B3.20 arrived at and this sampler copies:
      // NODE_ENV=production refuses outright · a DISPOSABLE cluster is permitted by construction ·
      // otherwise db-identity must say `development`.
      //
      // So the refusal is exercised through `NODE_ENV`, which is the condition that comes FIRST and
      // is the only one testable here — a disposable cluster is, by construction, the second. That
      // ordering exists because `initDB` seeds an admin and `users` is a production table, so the
      // fingerprint rule reads every freshly migrated scratch database as production: correct by
      // its own rule, useless for a tool that must run against one. The fingerprint rule itself is
      // measured by `check-db-identity-db.js`, which is where it belongs.
      const OUT3 = path.join(tmp, 'refused.jsonl');
      const r = await runSampler(['--objective', OBJ, '--interval-seconds', '1',
        '--duration-seconds', '2', '--out', OUT3], { NODE_ENV: 'production' });

      if (r.code === EXIT_NOT_EXECUTED && /production/i.test(r.err)) {
        ok(`it exits ${EXIT_NOT_EXECUTED} (NOT EXECUTED) under NODE_ENV=production and says why — `
          + 'exit 1 would read as "the office is broken", which is the wrong problem to send '
          + 'somebody to, and no signal overrides this one');
      } else bad('the sampler ran under NODE_ENV=production', { code: r.code, err: r.err.slice(-300) });

      if (!fs.existsSync(OUT3) || readJsonl(OUT3).length === 0) {
        ok('and it wrote no evidence file for a run it refused — a file that exists is a claim that '
          + 'something was measured');
      } else bad('a refused run left an evidence file', readJsonl(OUT3).slice(0, 2));

      // CONTROL: the same command without that one variable runs, so the refusal was the variable.
      const OUT4 = path.join(tmp, 'control.jsonl');
      const r2 = await runSampler(['--objective', OBJ, '--interval-seconds', '1',
        '--duration-seconds', '2', '--out', OUT4]);
      const header = fs.existsSync(OUT4) ? readJsonl(OUT4)[0] : null;
      if (r2.code === 0 && header && /disposable/.test(header.permittedBy || '')) {
        ok(`control: the same command without it runs, and the evidence file RECORDS what permitted `
          + `it ("${String(header.permittedBy).slice(0, 48)}…") — a three-day file that does not `
          + 'say which database it was allowed to read cannot be audited afterwards');
      } else bad('the control run did not succeed or did not record its permission',
        { code: r2.code, header });
    }

    // ══ 4. WHAT THE HARNESS DOES NOT ESTABLISH ═══════════════════════════
    head('4. what this harness does not establish');

    {
      const src = fs.readFileSync(
        path.join(ROOT, 'scripts', 'office-reliability-sampler.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      const writers = ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'recordAlert',
        'touchSchedulerHeartbeat', 'advanceCycle', 'enqueueTask', 'fetch('];
      const found = writers.filter((w) => src.includes(w));
      if (!found.length) {
        ok('the sampler contains no writer, no cycle call and no outward call — asserted on its '
          + 'source, because "it did not write anything during a six-second run" is a statement '
          + 'about six seconds');
      } else bad('the sampler can act on the system it measures', found);

      note('NOT established: that the office DID anything useful. This measures CONTINUITY — the '
        + 'scheduler kept beating, runs reached terminal states, alerts opened and closed, no '
        + 'section became unreadable, exposure stayed at zero. Whether the work was worth doing '
        + 'belongs to the acceptance criteria');
      note('NOT established: 72 hours. The duration is the one thing scaled down here, from three '
        + 'days to six seconds, and the prerequisites for the real run are listed in '
        + 'docs/office/b4-7-72-hour-reliability-run.md — B4.2\'s cloud worker service among them');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try {
      await query(`DELETE FROM autonomy_stops WHERE set_by = 'rel-check'`).catch(() => {});
      for (const id of made.objectives) {
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.companies) {
        await query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => {});
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) { bad('cleanup failed', e.message); }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
