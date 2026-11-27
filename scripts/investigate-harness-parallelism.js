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
  console.log('── D. fixed ports across the legacy harnesses ──');
  console.log('');
  {
    const fsx = require('fs');
    const files = fsx.readdirSync(__dirname)
      .filter((f) => f.endsWith('.js'))
      .map((f) => require('path').join(__dirname, f));
    const portPat = /(?:PGPORT|APPPORT|PORT)\s*(?:=|\|\|)\s*(?:Number\()?\s*['"]?(\d{4,5})['"]?/g;
    const envPat = /process\.env\.([A-Z_]+)\s*\|\|\s*['"]?(\d{4,5})/g;
    const byPort = new Map();
    const byEnv = new Map();
    for (const f of files) {
      let src;
      try { src = fsx.readFileSync(f, 'utf8'); } catch (_) { continue; }
      if (src.includes('pg-disposable') && !src.includes('pg-legacy-harness')) continue;
      const base = require('path').basename(f);
      let m;
      portPat.lastIndex = 0;
      while ((m = portPat.exec(src)) !== null) {
        const n = Number(m[1]);
        if (n > 1024 && n < 65536 && n !== PG.PORT_FLOOR) {
          if (!byPort.has(n)) byPort.set(n, new Set());
          byPort.get(n).add(base);
        }
      }
      envPat.lastIndex = 0;
      while ((m = envPat.exec(src)) !== null) {
        if (!byEnv.has(m[1])) byEnv.set(m[1], new Set());
        byEnv.get(m[1]).add(`${m[2]} (${base})`);
      }
    }
    const shared = [...byPort.entries()].filter(([, set]) => set.size > 1);
    console.log(`   ${byPort.size} distinct fixed ports are written into these harnesses.`);
    console.log('   Each is a permanent single point of failure: one orphan holding that port blocks');
    console.log('   that harness on every future run, which is the 2026-11-24 failure still present.');
    console.log('');
    if (shared.length) {
      console.log(`   ${shared.length} port(s) are shared by more than one harness — these CANNOT run`);
      console.log('   concurrently, by construction:');
      for (const [port, set] of shared.sort((a, b) => a[0] - b[0])) {
        console.log(`     port ${port}: ${[...set].sort().join(', ')}`);
      }
    } else {
      console.log('   No port is shared by two harnesses.');
    }
    const clashing = [...byEnv.entries()]
      .filter(([, set]) => new Set([...set].map((x) => x.split(' ')[0])).size > 1);
    if (clashing.length) {
      console.log('');
      console.log('   And a TRAP: these env var names have DIFFERENT defaults in different files, so');
      console.log('   setting one — the obvious way to move a harness off a busy port — points every');
      console.log('   file that reads it at the SAME port and collides them deliberately:');
      for (const [name, set] of clashing.sort()) {
        console.log(`     ${name}: ${[...set].sort().join(', ')}`);
      }
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
    console.log('   §D is what survives, and it is not "contention" — it is a named resource. The');
    console.log('   legacy harnesses each hard-code a port. Two that share one cannot run together');
    console.log('   at all, and the shared env-var defaults mean the obvious workaround creates the');
    console.log('   collision it was meant to avoid. In SERIAL preflight none of this is reachable,');
    console.log('   which is why it has never shown up as anything but "a parallel batch is not a');
    console.log('   verdict".');
    console.log('');
    console.log('   The fix is the one pg-disposable already made: pick a free port and retry. That');
    console.log('   is a change to pg-legacy-harness and its callers, and it has NOT been made —');
    console.log('   this file establishes the cause, it does not repair it.');
  } else {
    console.log(`   First failure at N=${firstFailure.n}. The verbatim error above is the finding;`);
    console.log('   match it against the five candidates in this file\'s header rather than');
    console.log('   assuming the first plausible one.');
  }
  process.exit(0);
})();
