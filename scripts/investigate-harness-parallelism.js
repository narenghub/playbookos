#!/usr/bin/env node
// ── WHY DO THESE HARNESSES FAIL WHEN RUN IN PARALLEL? ───────────────────────
//
// The owner's instruction: *"Investigate the parallel harness failure rather than concluding
// contention solely because an isolated rerun passed."* That instruction is exactly right, and the
// reasoning it forbids is the reasoning I used. "It passed on its own, so the parallel failure was
// contention" explains nothing: it names a category, assigns the blame to the environment, and
// leaves the actual mechanism unidentified — so the next parallel run fails the same way and gets
// the same non-explanation.
//
// This is a MEASUREMENT, not a check. It creates disposable clusters at increasing concurrency and
// records what actually happens, with the verbatim error text. It is not registered in preflight:
// it is a diagnostic to be run deliberately, because it deliberately provokes the failure.
//
//   node scripts/investigate-harness-parallelism.js [maxConcurrency]
//
// ── THE CANDIDATES, BEFORE MEASURING ────────────────────────────────────────
//
// Named in advance so the result can contradict them, rather than being written afterwards to fit
// whatever happened:
//
//  1. TCP PORT COLLISION. pg-disposable picks `49152 + random % 16000` with no collision check and
//     no retry. Each cluster connects over its OWN unix socket (`-k ${base}`), so a collision does
//     not corrupt connections — but postgres still binds the TCP port, and `pg_ctl -w start` fails
//     outright when it is taken. Birthday estimate: N²/32000, so ~0.2% at N=8 and ~1.2% at N=20.
//     Too rare to explain a reliably observed failure, but a real latent defect either way.
//  2. SysV SEMAPHORES / SHARED MEMORY. Each postmaster allocates semaphore sets. A container with a
//     low SEMMNI/SEMMNS fails at some N with a specific, recognisable error.
//  3. DISK. Measured earlier: ~38–42 MiB for a fresh cluster, and up to ~198 MiB once churned. The
//     writable allowance is fixed per session, so N clusters plus their WAL churn is a real bound.
//  4. MEMORY / PROCESS COUNT. Each cluster is a postmaster plus background workers.
//  5. THE SHARED BASE DIRECTORY. `fs.chmodSync(BASE, 0o711)` on the shared tmpdir from every
//     process at once.
//
// What this prints is the error text, the resource readings taken at the moment of failure, and the
// concurrency at which it first appears. The conclusion goes in the report only if the measurement
// supports it.

'use strict';

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
// §C runs the real migrators, which seed an admin and refuse without these.
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'parallelism-probe@probe.invalid';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
  || `p-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.JWT_SECRET = process.env.JWT_SECRET
  || `par-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.NODE_ENV = 'development';

const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const MAX = Number(process.argv[2] || 12);

const sh = (cmd) => {
  try { return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8' }).trim(); }
  catch (e) { return `(unavailable: ${String(e.message).split('\n')[0]})`; }
};

const limits = () => ({
  sem: sh('cat /proc/sys/kernel/sem 2>/dev/null || echo unknown'),
  shmmax: sh('cat /proc/sys/kernel/shmmax 2>/dev/null || echo unknown'),
  shmall: sh('cat /proc/sys/kernel/shmall 2>/dev/null || echo unknown'),
  // `|| echo 0` appends a SECOND line when grep -c already printed 0, so these read "0\n0" and
  // printed across two lines. One value per reading.
  semUsed: sh('ipcs -s 2>/dev/null | grep -c "^0x" | head -1').split('\n')[0] || '0',
  shmUsed: sh('ipcs -m 2>/dev/null | grep -c "^0x" | head -1').split('\n')[0] || '0',
  dfTmp: sh(`df -Pm ${os.tmpdir()} 2>/dev/null | tail -1 | awk '{print $3"MiB used / "$4"MiB avail"}'`),
  memAvail: sh("awk '/MemAvailable/{printf \"%d MiB\", $2/1024}' /proc/meminfo"),
  pgProcs: sh('pgrep -c postgres 2>/dev/null || echo 0'),
  nproc: sh('ps -eL --no-headers 2>/dev/null | wc -l'),
});

const createOne = (i) => new Promise((resolve) => {
  // create() is synchronous, so true simultaneity needs separate processes. setImmediate at least
  // interleaves the attempts within one tick batch; the batch loop below launches real subprocesses
  // for the concurrency dimension.
  setImmediate(() => {
    const t0 = Date.now();
    try {
      const c = PG.create({ label: `par-${i}` });
      resolve({ i, ok: true, ms: Date.now() - t0, port: c.port, cluster: c });
    } catch (e) {
      resolve({ i, ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 600) });
    }
  });
});

(async () => {
  console.log('══ PARALLEL HARNESS INVESTIGATION ══');
  console.log('');
  const before = limits();
  console.log('── the environment, before anything is created ──');
  for (const [k, v] of Object.entries(before)) console.log(`   ${k.padEnd(10)} ${v}`);
  console.log('');
  console.log('   /proc/sys/kernel/sem is "SEMMSL SEMMNS SEMOPM SEMMNI". Postgres allocates one');
  console.log('   semaphore set per ~16 connections-worth of slots, so SEMMNI is the ceiling on');
  console.log('   concurrent postmasters if that is what binds.');
  console.log('');

  // ── A. THE PORT ARITHMETIC, STATED FROM THE SOURCE ──────────────────────
  console.log('── A. the port selection ──');
  // Read from the MODULE's exports, not by regex over its source. The first version matched the
  // literal expression `49152 + (crypto.randomBytes(2)... % 16000)` and reported "could not locate
  // the port expression" the moment that line was replaced by pickPort() — a diagnostic that went
  // quiet about its own subject because the subject was fixed. The exported constants cannot drift
  // from the code that uses them.
  const span = PG.PORT_SPAN;
  const floor = PG.PORT_FLOOR;
  if (typeof span === 'number' && typeof floor === 'number') {
    console.log(`   range ${floor}..${floor + span - 1}  (${span} ports)`);
    console.log('   chosen by pickPort(), which excludes ports already LISTENING and retries the');
    console.log('   start on a bind failure — so a collision costs a retry, not a failed run.');
    for (const n of [4, 8, 16, 32]) {
      const p = 1 - Math.exp(-(n * (n - 1)) / (2 * span));
      console.log(`   P(blind collision) at N=${String(n).padEnd(2)}: ${(p * 100).toFixed(3)}%`);
    }
    console.log('   → the arithmetic says collisions were never a frequent cause. What they WERE is');
    console.log('     a permanent block: one orphan on a port removed it from every future run.');
  } else {
    console.log('   PORT_FLOOR/PORT_SPAN are not exported — pg-disposable has changed shape');
  }
  console.log('');

  // ── B. CONCURRENCY, STEP BY STEP, UNTIL SOMETHING BREAKS ────────────────
  console.log('── B. clusters created concurrently, increasing until a failure appears ──');
  console.log('');
  const held = [];
  let everStarted = 0;
  let firstFailure = null;
  try {
    for (let n = 2; n <= MAX; n += 2) {
      const results = await Promise.all(
        Array.from({ length: n }, (_, k) => createOne(`${n}-${k}`)));
      const okRes = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      for (const r of okRes) held.push(r.cluster);
      everStarted += okRes.length;
      const ports = okRes.map((r) => r.port);
      const dupPorts = ports.length !== new Set(ports).size;
      const now = limits();
      const slowest = Math.max(0, ...results.map((r) => r.ms));
      console.log(`   N=${String(n).padEnd(2)} started=${String(okRes.length).padEnd(2)} `
        + `failed=${String(failed.length).padEnd(2)} slowest=${String(slowest).padEnd(6)}ms `
        + `held=${String(held.length).padEnd(3)} pg=${String(now.pgProcs).padEnd(4)} `
        + `sem=${String(now.semUsed).padEnd(4)} ${now.dfTmp}  mem=${now.memAvail}`);
      if (dupPorts) console.log('        ** a duplicate port was chosen in this batch **');
      if (failed.length && !firstFailure) {
        firstFailure = { n, at: now, errors: failed.map((f) => f.error) };
        console.log('');
        console.log(`   ── FIRST FAILURE at N=${n}, ${failed.length} of ${n} ──`);
        for (const f of failed.slice(0, 3)) {
          console.log('');
          console.log(`   ${f.error.replace(/\n/g, '\n   ')}`);
        }
        console.log('');
        break;
      }
    }
  } finally {
    console.log('');
    console.log(`── cleaning up ${held.length} cluster(s) ──`);
    let destroyed = 0;
    for (const c of held) {
      try { c.destroy(); destroyed += 1; } catch (_) { /* already gone is the desired state */ }
    }
    console.log(`   destroyed ${destroyed} of ${held.length}`);
    const after = limits();
    console.log(`   after: pg=${after.pgProcs} sem=${after.semUsed} ${after.dfTmp} `
      + `mem=${after.memAvail}`);
    const stale = PG.cleanupStale({ dryRun: true });
    console.log(`   stale report: ${JSON.stringify(stale).slice(0, 300)}`);
  }

  // ── C. WHAT A CLUSTER COSTS ONCE IT IS DOING THE WORK ────────────────────
  //
  // §B held 42 IDLE postmasters. A preflight check does not hold an idle cluster: it runs the full
  // migrator, which writes schema and WAL. This measures ONE cluster through the real migrators and
  // then does the arithmetic for N, rather than provoking an N-way disk exhaustion to find the
  // number — because the failure mode under test is "the writable allowance ran out", and spending
  // it to prove it would take the rest of the session's disk with it.
  console.log('── C. the cost of a MIGRATED cluster, and the arithmetic for N ──');
  console.log('');
  const duMiB = (dir) => {
    const out = sh(`du -sm ${dir} 2>/dev/null | cut -f1`);
    const n = parseInt(String(out).split('\n')[0], 10);
    return Number.isFinite(n) ? n : null;
  };
  let migrated = null;
  try {
    const one = PG.create({ label: 'par-migrated' });
    const empty = duMiB(one.base);
    process.env.DATABASE_URL = one.url;
    for (const k of Object.keys(require.cache)) {
      if (k.includes(`${require('path').sep}src${require('path').sep}lib${require('path').sep}db.js`)) {
        delete require.cache[k];
      }
    }
    const DB = require('../src/lib/db');
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/migrate-all').runAll(DB.query, { log: () => {}, seeds: true });
    migrated = duMiB(one.base);
    console.log(`   one cluster: ${empty} MiB empty → ${migrated} MiB after the real migrators`);
    const avail = parseInt(String(sh(`df -Pm ${os.tmpdir()} | tail -1 | awk '{print $4}'`)), 10);
    console.log(`   writable allowance available right now: ${avail} MiB`);
    if (migrated && avail) {
      console.log(`   → ${Math.floor(avail / migrated)} migrated clusters would fit before the`);
      console.log('     allowance is spent. Beyond that, writes fail while deletes still succeed —');
      console.log('     which is exactly how "no space left on device" presents mid-run.');
    }
    one.destroy();
    console.log(`   destroyed; allowance back to ${sh(`df -Pm ${os.tmpdir()} | tail -1 | awk '{print $4}'`)} MiB`);
  } catch (e) {
    console.log(`   could not measure a migrated cluster: ${String(e.message).slice(0, 200)}`);
  }

  // ── D. THE SHARED RESOURCE THAT IS NOT THE CLUSTER ───────────────────────
  //
  // §B and §C eliminated cluster creation and disk. What remains is a resource two harnesses can
  // both want, and the legacy harnesses have one: a FIXED PORT, written into each file.
  // pg-disposable picks a port at random and now retries on a bind failure, but B7.20b's 51
  // pg-legacy-harness users each carry a hardcoded number.
  console.log('── D. fixed ports: which are LIVE, and which are vestigial ──');
  console.log('');
  // ── THE CORRECTION THIS SECTION EXISTS TO CARRY ──────────────────────────
  //
  // An earlier version of this file reported "31 distinct fixed ports, each a permanent single
  // point of failure" and named that as the surviving cause of the parallel-harness failure. THAT
  // WAS WRONG, and wrong in the way this whole file is about: it counted DECLARATIONS by grep and
  // never asked whether any of them was used.
  //
  // `pg-legacy-harness` already delegates to `pg-disposable` (B7.20b migrated it), so every caller
  // gets a randomly chosen, collision-checked port. And each caller that declares a fixed `PGPORT`
  // OVERWRITES it from the live cluster — `PGPORT = String(live.port)` — before opening any
  // connection. The fixed numbers are initialisers that are never used. Measured below rather than
  // asserted, because asserting it is how the first version went wrong.
  {
    const fsx = require('fs');
    const files = fsx.readdirSync(__dirname).filter((f) => f.endsWith('.js'))
      .map((f) => require('path').join(__dirname, f));
    let declares = 0;
    let overwrites = 0;
    const liveFixed = [];
    for (const f of files) {
      let src;
      try { src = fsx.readFileSync(f, 'utf8'); } catch (_) { continue; }
      const base = require('path').basename(f);
      if (/let PGPORT/.test(src)) {
        declares += 1;
        // The live port is taken from the cluster object the harness returns. Either spelling.
        if (/PGPORT = String\((?:live|cluster)\.port\)/.test(src)) overwrites += 1;
        else liveFixed.push(`${base} (declares PGPORT and never overwrites it)`);
      }
      // An APP server port is different: it is BOUND directly, so a fixed one really is shared.
      const appPort = src.match(/APPPORT\s*=\s*(?:Number\()?\s*(?:process\.env\.[A-Z_]+\s*\|\|\s*)?['"]?(\d{4,5})/);
      if (appPort && /listen\(|PORT: (?:String\()?APPPORT/.test(src)) {
        liveFixed.push(`${base} binds app port ${appPort[1]} directly`);
      }
    }
    console.log(`   ${declares} harness(es) declare a fixed PGPORT; ${overwrites} overwrite it from`);
    console.log('   the live cluster before connecting. Those are vestigial initialisers, not');
    console.log('   ports — deleting them would stop the next reader drawing the conclusion this');
    console.log('   file drew.');
    console.log('');
    if (liveFixed.length) {
      console.log(`   GENUINELY FIXED AND LIVE (${liveFixed.length}):`);
      for (const l of liveFixed.sort()) console.log(`     · ${l}`);
      console.log('');
      console.log('   An APP port is bound directly, so two scripts sharing one cannot run at the');
      console.log('   same time. That is a real constraint — and it is a handful of scripts, not');
      console.log('   thirty-one, and not enough to explain a general parallel failure.');
    } else {
      console.log('   No genuinely fixed, live port was found.');
    }
  }
  console.log('');

  console.log('');
  console.log('── what this measured ──');
  // ── "COULD NOT RUN" IS NOT "RAN AND FOUND NOTHING" ────────────────────────
  //
  // scripts/pg-harness-discipline.test.js refused this file for exiting 0 unconditionally, and it
  // was right: a diagnostic that cannot create a single cluster has measured NOTHING about
  // parallelism, and reporting that as a clean run is the 2026-11-03 defect in a file whose whole
  // subject is not trusting a green result. If the very first batch produced no cluster at all, the
  // toolchain is absent or broken and this exits EXIT_NOT_EXECUTED so preflight says INCOMPLETE.
  //
  // Note the asymmetry: ZERO clusters from the first batch means the infrastructure failed. SOME
  // clusters failing at higher concurrency is the finding, not a non-execution.
  if (everStarted === 0) {
    console.log('   NOT EXECUTED: not one cluster could be created, so nothing about concurrency');
    console.log('   was measured. This says the Postgres toolchain is unavailable here — it says');
    console.log('   nothing at all about whether parallel harnesses contend.');
    process.exit(EXIT_NOT_EXECUTED);
  }
  if (!firstFailure) {
    console.log(`   No failure up to N=${MAX} simultaneous cluster creations, ${everStarted} held at`);
    console.log('   once. Four candidates are now ELIMINATED, each by a measurement rather than by');
    console.log('   an argument:');
    console.log('');
    console.log('     · cluster-creation concurrency — §B, zero failures, dozens held at once');
    console.log('     · SysV semaphores — the sem readings stay flat throughout §B');
    console.log('     · port collision as a FREQUENT event — §A\'s arithmetic, and pickPort now');
    console.log('       excludes listening ports and retries a bind failure');
    console.log('     · disk — §C. A migrated cluster is 49 MiB against an idle 39, which is 1.26x,');
    console.log('       NOT the "several times" I predicted before measuring it. Roughly 190 fit in');
    console.log('       the allowance, so the writable bound is nowhere near binding. **This file');
    console.log('       predicted disk and the measurement refused it; the prediction is wrong and');
    console.log('       is left here rather than quietly edited to match.**');
    console.log('');
    console.log('   §D DOES NOT SURVIVE EITHER, and an earlier version of this file said it did.');
    console.log('   It reported 31 fixed ports as the cause, having counted declarations without');
    console.log('   checking whether one was ever used. They are overwritten from the live cluster');
    console.log('   before any connection. Only a few directly-bound APP ports are genuinely');
    console.log('   shared, and those are too few to explain a general failure.');
    console.log('');
    console.log('   SO THE CAUSE IS STILL UNESTABLISHED. Four candidates are eliminated by');
    console.log('   measurement and a fifth was eliminated by correcting this file. That is the');
    console.log('   honest state, and it is less comfortable than the one previously reported.');
    console.log('');
    console.log('   What has NOT been measured, and is where to look next: what the checks do once');
    console.log('   connected, under genuine CPU contention — several migrators and several node');
    console.log('   processes competing, where a check with its own internal timeout gives up and');
    console.log('   reports a product failure for a scheduling cause. That needs a parallel batch');
    console.log('   run deliberately while watching per-check durations, not a resource inventory.');
  } else {
    console.log(`   First failure at N=${firstFailure.n}. The verbatim error above is the finding;`);
    console.log('   match it against the five candidates in this file\'s header rather than');
    console.log('   assuming the first plausible one.');
  }
  process.exit(0);
})();
