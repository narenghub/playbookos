#!/usr/bin/env node
// ── A SIGNALLED HARNESS LEAVES NOTHING BEHIND (B7.20b) ──────────────────────
//
//   node scripts/check-pg-harness-lifecycle-db.js   exit 0 = no cluster survives a signal
//                                                   exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's requirement 4, 2026-11-26: *"The recurring disposable PostgreSQL storage exhaustion must
// be resolved before the continuous reliability demonstration. Migrate the remaining legacy
// harnesses to the verified lifecycle utility. Do not delete unverified or unrelated resources."*
//
// ── WHY THIS CHECK EXISTS, AND WHY A SOURCE SCAN IS NOT ENOUGH ──────────────
//
// `pg-harness-discipline.test.js` asserts on SOURCE: every harness uses the shared discovery, names
// its superuser, and signals non-execution. None of that is a statement about what survives a
// `kill`. The exhaustion was never a source-level defect — every leaking file had a `finally` and
// looked correct.
//
// So this measures the behaviour, both ways round, with the legacy pair as the **control**:
//
//   · a child using the migrated harness, SIGTERMed → its cluster directory is GONE
//   · a child using the legacy pair verbatim, SIGTERMed → its cluster directory REMAINS
//
// Without the second, the first proves only that something cleaned up; it could have been the test.
// With it, the difference is the migration, and it is measured in megabytes.
//
// ── WHAT WENT WRONG, MEASURED ───────────────────────────────────────────────
//
// 66 orphaned `/var/tmp/m7-identity-*` directories at ~171 MiB each — **28 GB** — from
// `check-db-identity-db.js` alone. Two causes, and neither is a forgotten `finally`:
//
//   1. These checks call `process.exit()` on both pass and fail, and their watchdogs call it on a
//      stall. A promise `finally` does not run when the process exits from inside it, and a SIGTERM
//      does not reach it at all. The immediate trigger was me: I killed a running preflight three
//      times with `pkill`.
//   2. A leaked legacy cluster carries **no ownership record**, so `pg-cleanup.js` correctly refuses
//      to remove it — *"deletion requires positive evidence of ownership, and uncertainty means
//      report, not delete"* — and reports it as `unidentified`, inventory only. They accumulate for
//      ever.
//
// The disk then filled mid-gate and several checks reported `SKIP infrastructure unavailable`:
// **a full disk presenting as a missing database, for the second time in this project.**
//
// ── NOTHING UNVERIFIED OR UNRELATED IS DELETED ──────────────────────────────
//
// This check removes exactly the two directories its two children created, by the paths those
// children printed, and nothing else. It never calls `cleanupStale`, never scans a base directory
// for candidates, and never deletes by age, pattern or prefix.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { EXIT_NOT_EXECUTED, pgBin } = require('./lib/pg-cluster');

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

if (!pgBin()) {
  console.log('  skip  initdb is not on PATH');
  console.log('SKIP  harness lifecycle was NOT exercised — infrastructure unavailable');
  process.exit(EXIT_NOT_EXECUTED);
}

const ROOT = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lifecycle-'));

/** Record every directory a child reports, so cleanup is by id and nothing else is touched. */
const created = [];

const sizeOf = (p) => {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch (_) {} }
    }
  };
  walk(p);
  return total;
};

/**
 * Run a child that starts a cluster, prints its base directory, and then never exits.
 * SIGTERM it, and report whether the directory survives.
 */
function signalProbe(name, source, { settleMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const file = path.join(work, `${name}.js`);
    fs.writeFileSync(file, source);
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    // The child prints its base as soon as the cluster is up. initdb takes several seconds.
    const deadline = Date.now() + 90_000;
    const waitForBase = () => {
      const m = /__BASE__ (.+)/.exec(out);
      if (m) {
        const base = m[1].trim();
        created.push(base);
        const before = fs.existsSync(base);
        const bytes = before ? sizeOf(base) : 0;
        child.kill('SIGTERM');
        setTimeout(() => {
          const after = fs.existsSync(base);
          try { child.kill('SIGKILL'); } catch (_) {}
          resolve({ base, before, after, bytes, out, err });
        }, settleMs);
        return;
      }
      if (Date.now() > deadline || child.exitCode !== null) {
        resolve({ base: null, before: false, after: false, bytes: 0, out, err });
        return;
      }
      setTimeout(waitForBase, 500);
    };
    waitForBase();
  });
}

// ── THE MIGRATED HARNESS ───────────────────────────────────────────────────
const MIGRATED = `
const H = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'pg-legacy-harness.js'))});
const url = H.startTemp('lifecycle-migrated');
if (!url) { process.stdout.write('__NOCLUSTER__\\n'); process.exit(3); }
process.stdout.write('__BASE__ ' + /host=([^&]*)/.exec(url)[1] + '\\n');
// Exactly what the legacy files do, and it is not what cleans up: the utility's signal handlers are.
new Promise(() => {}).finally(H.stopTemp);
setInterval(() => {}, 1000);
`;

// ── THE LEGACY PAIR, VERBATIM, AS THE CONTROL ──────────────────────────────
//
// Copied from the shape every migrated file carried: a fixed port, /var/tmp, and
// `.finally(stopTemp)`. It is the control, so the difference below names the mechanism rather than
// leaving "something tidied up" as the conclusion.
const LEGACY = `
const fs = require('fs');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'lib', 'pg-cluster.js'))});
let temp = null;
function startTemp() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/lifecycle-legacy-');
  const env = { ...process.env, PATH: dir + ':' + process.env.PATH };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c',
    asPostgres ? 'su postgres -c ' + JSON.stringify(cmd) : cmd], { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run('PATH=' + dir + ':$PATH initdb -D ' + base + '/data ' + INITDB_FLAGS);
    run('PATH=' + dir + ':$PATH pg_ctl -D ' + base + '/data -l ' + base
      + '/pg.log -o \\'-k ' + base + ' -p 55123 -c listen_addresses=\\' start -w');
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return base;
}
function stopTemp() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c',
      'PATH=' + temp.dir + ':$PATH pg_ctl -D ' + temp.base + '/data -m immediate stop'],
    { stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}
const base = startTemp();
if (!base) { process.stdout.write('__NOCLUSTER__\\n'); process.exit(3); }
process.stdout.write('__BASE__ ' + base + '\\n');
new Promise(() => {}).finally(stopTemp);
setInterval(() => {}, 1000);
`;

(async () => {
  try {
    // ══ 1. THE MIGRATED HARNESS SURVIVES A SIGNAL CLEANLY ════════════════
    head('1. a SIGTERMed child using the migrated harness leaves no cluster');

    const mig = await signalProbe('migrated', MIGRATED);
    if (!mig.base) {
      bad('the migrated probe never reported a cluster', { out: mig.out.slice(0, 200), err: mig.err.slice(0, 300) });
    } else {
      if (mig.before) {
        ok(`the cluster existed before the signal (${Math.round(mig.bytes / 1048576)} MiB at `
          + `${mig.base}) — so the assertion below is about a directory that was really there`);
      } else bad('the migrated cluster did not exist before the signal', mig.base);

      if (mig.before && !mig.after) {
        ok('and it is GONE after SIGTERM — the utility installs SIGINT/SIGTERM/SIGHUP and `exit` '
          + 'handlers and re-raises the signal, so the exit status still reflects it');
      } else bad('the migrated cluster survived SIGTERM', { base: mig.base, after: mig.after });
    }

    // ══ 2. THE CONTROL: THE LEGACY PAIR LEAKS ════════════════════════════
    head('2. control — the legacy pair, verbatim, leaks under the same signal');

    const leg = await signalProbe('legacy', LEGACY);
    if (!leg.base) {
      bad('the legacy control never reported a cluster, so section 1 proves nothing about the '
        + 'mechanism', { out: leg.out.slice(0, 200), err: leg.err.slice(0, 300) });
    } else if (leg.before && leg.after) {
      ok(`the legacy cluster REMAINS after the identical signal `
        + `(${Math.round(leg.bytes / 1048576)} MiB) — so what cleaned up in section 1 was the `
        + 'migration and not the test harness, and the difference is measured in megabytes');
      // Removed BY THE PATH THE CHILD PRINTED, below. Nothing else is touched.
    } else if (leg.before && !leg.after) {
      bad('the legacy pair cleaned up too, so this control does not discriminate and section 1 '
        + 'establishes nothing about the mechanism', leg.base);
    } else bad('the legacy control did not create a cluster', leg.base);

    // ══ 3. OWNERSHIP: A DEAD RUN'S CLUSTER IS RECLAIMABLE ════════════════
    head('3. ownership — the second half of why the legacy leak was permanent');

    {
      const DISPOSABLE = require('./lib/pg-disposable');
      // The utility's own cluster carries an OWNER.json. Read it rather than asserting it exists.
      let own = null;
      try {
        own = DISPOSABLE.create({ label: 'lifecycle-owner' });
        const ownerPath = path.join(own.base, DISPOSABLE.OWNER_FILE);
        const rec = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        if (rec.marker === DISPOSABLE.MARKER && rec.pid === process.pid
          && typeof rec.pidStartTime !== 'undefined' && rec.runId) {
          ok('a utility cluster carries an OWNER.json naming the marker, the run id, the pid AND '
            + 'the pid\'s start time — which is what lets pg-cleanup say "this was ours and the '
            + 'run is over" instead of refusing on uncertainty');
        } else bad('the ownership record is incomplete', rec);

        // And the legacy directory from section 2 has none, which is why it was permanent.
        if (leg.base && fs.existsSync(leg.base)) {
          const hasOwner = fs.existsSync(path.join(leg.base, DISPOSABLE.OWNER_FILE));
          if (!hasOwner) {
            ok('while the leaked LEGACY directory carries no ownership record at all — so '
              + 'pg-cleanup correctly refuses to remove it and reports it as `unidentified`, '
              + 'inventory only. That is why 66 of them accumulated to 28 GB rather than being '
              + 'reclaimed: the leak and the irreclaimability are two separate defects');
          } else bad('the legacy directory unexpectedly has an ownership record', leg.base);
        } else note('the legacy control left nothing to inspect, so the ownership half is '
          + 'not asserted here');
      } catch (e) {
        if (e && e.infrastructure) {
          note(`the ownership section could not run: ${e.message}`);
        } else bad('the ownership section threw', e.message);
      } finally {
        if (own) { created.push(own.base); try { own.destroy(); } catch (_) {} }
      }
    }

    // ══ 4. THE POPULATION, SO THIS CANNOT GO VACUOUS ═════════════════════
    head('4. how many harnesses are migrated, counted rather than claimed');

    {
      const dir = path.join(ROOT, 'scripts');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
      let viaShim = 0; let viaUtility = 0; let raw = 0;
      for (const f of files) {
        let src = '';
        try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
        const rawInit = src.includes('initdb -D');
        const shim = /pg-legacy-harness/.test(src);
        const util = /pg-disposable/.test(src) && /DISPOSABLE\.create\(|create\(\s*\{\s*label:/.test(src);
        if (rawInit) raw += 1;
        else if (shim) viaShim += 1;
        else if (util) viaUtility += 1;
      }
      note(`${viaShim} harness(es) migrated onto the shim · ${viaUtility} written directly on the `
        + `utility · ${raw} still running their own initdb`);
      if (viaShim >= 40) {
        ok(`${viaShim} harnesses now obtain their cluster through the verified lifecycle utility, `
          + 'where before this change the number was zero');
      } else bad(`only ${viaShim} harnesses are on the shim — the migration has regressed`);
      if (raw > 0) {
        note(`the ${raw} remaining raw harnesses are the ones whose own block did not match the `
          + 'migrated shape. They are still covered by pg-harness-discipline.test.js\'s raw rules, '
          + 'and they are NOT yet protected against the signal leak measured above — that is the '
          + 'remainder of B7.20b and it is stated rather than implied');
      }
    }

    // ══ 5. WHAT THIS DOES NOT ESTABLISH ══════════════════════════════════
    head('5. the boundary of this check');

    note('NOT established: that the remaining raw harnesses do not leak. They do — section 2 is '
      + 'one of them, verbatim. Migrating them is the rest of B7.20b.');
    note('NOT established: anything about a SIGKILL. A SIGKILL cannot be handled by any process, so '
      + 'no harness can clean up after one; that is what the OWNER.json in section 3 is for, and '
      + 'why `pg-cleanup.js --apply` is the recovery path rather than a handler.');
    note('NOT established: that the disk cannot fill. A long run can still exhaust it; what has '
      + 'changed is that an orphan is now reclaimable instead of permanent.');
    note('nothing unverified or unrelated was deleted: this check removed exactly the directories '
      + 'its own children reported, by those paths.');
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    // ── CLEANUP BY ID, AND BY ID ONLY ──────────────────────────────────────
    // Each path here was printed by a child this check started. No scan, no pattern, no age.
    for (const base of created) {
      try {
        if (base && fs.existsSync(base)) {
          // Stop any postmaster still holding it, then remove that one directory.
          try {
            const { execFileSync } = require('node:child_process');
            const bin = pgBin();
            if (bin) {
              execFileSync('sh', ['-c',
                `PATH=${bin}:$PATH pg_ctl -D ${base}/data -m immediate stop`], { stdio: 'pipe' });
            }
          } catch (_) { /* already gone is the desired state */ }
          fs.rmSync(base, { recursive: true, force: true });
        }
      } catch (e) { note(`could not remove ${base}: ${e.message}`); }
    }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
