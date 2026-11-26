// ── DISPOSABLE POSTGRES, WITH A LIFECYCLE THAT SURVIVES BEING KILLED ────────
//
//   const C = await DISPOSABLE.create({ label: 'membership' });
//   try { … C.url … } finally { C.destroy(); }
//
//   DISPOSABLE.inventory()                    // what exists, and whose it is
//   DISPOSABLE.cleanupStale({ dryRun: true }) // report; dryRun:false removes only DEAD-OWNED
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// On 2026-11-24 preflight reported two failures: "database TLS verification refuses the wrong
// certificate" and "the migration connects as the migrator, not as DATABASE_URL". Both read as
// security regressions. Neither was. The disk was 100% full — 3.3 MB free — behind 688 orphaned
// cluster directories and 228 postgres processes, left by preflight runs that had been killed
// mid-flight. Every DB check cleans up in a `finally`, and a `finally` does not run when the
// process is killed.
//
// So the defect is not housekeeping. It is that a dozen checks each carry their own copy of the
// same scaffolding, and that scaffolding had three faults:
//
//   · a FIXED PORT, so one orphan blocked every later run and the check reported "no Postgres
//     available" — a self-inflicted failure wearing an honest NOT EXECUTED badge
//   · `pg_ctl` with no `-l`, so the server inherited the captured stdout pipe and held it open
//     forever: execFileSync never returned while `ps` showed a healthy cluster
//   · cleanup only on the happy path
//
// ── THE RULE THIS FILE IS BUILT AROUND ─────────────────────────────────────
//
// DELETION REQUIRES POSITIVE EVIDENCE OF OWNERSHIP, AND UNCERTAINTY MEANS REPORT, NOT DELETE.
//
// A directory name is not evidence. Age is not evidence. "It looks like a test cluster" is not
// evidence. Every cluster this utility creates writes an OWNER.json naming the marker, the run id,
// the pid and THE PID'S START TIME; cleanup reads that file back and refuses anything it cannot
// positively account for. Clusters that predate this utility have no such file, so they are
// inventoried separately and never touched automatically — exactly the 688 that caused the
// incident.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pgBin, INITDB_FLAGS } = require('./pg-cluster');

const MARKER = 'playnexa-disposable-postgres-v1';
const OWNER_FILE = 'OWNER.json';
const PREFIX = 'pnxpg-';
/** Where disposable clusters may live. Canonicalised, and nothing outside it is ever touched. */
const BASE = fs.realpathSync(process.env.PNX_PG_BASE || os.tmpdir());
/** Below this, creating a cluster is an INFRASTRUCTURE failure, not a test failure. */
const MIN_FREE_BYTES = Number(process.env.PNX_PG_MIN_FREE || 512 * 1024 * 1024);

const RUN_ID = `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

// ── PROCESS IDENTITY, ACCOUNTING FOR PID REUSE ──────────────────────────────
//
// A pid alone is not identity: pids are recycled, and on a busy container they are recycled fast.
// Killing "pid 3845 because OWNER.json says so" can kill whatever now holds 3845. So ownership
// records the pid AND its start time, and both must match before a process is considered ours.
//
// Linux exposes starttime as field 22 of /proc/<pid>/stat, in clock ticks since boot — stable for
// the life of the process and not reused with the pid. Where /proc is absent the start time is
// null, which makes the evidence incomplete, which means refuse.
function pidStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field can contain spaces and parentheses, so fields are counted after the last ')'.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return after[19] || null;                       // field 22 overall
  } catch (_) {
    return null;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Is this pid the same process that wrote the marker — not merely the same number? */
function sameProcess(pid, recordedStart) {
  if (!pidAlive(pid)) return false;
  const now = pidStartTime(pid);
  if (!now || !recordedStart) return null;          // cannot tell → caller must refuse
  return now === recordedStart;
}

// ── PATH SAFETY ─────────────────────────────────────────────────────────────
//
// Cleanup resolves every candidate to its canonical path and requires it to sit directly under
// BASE. A symlink pointing at /var/lib/postgresql, or a `..` segment, resolves outside BASE and is
// refused. Without this, an attacker — or a careless marker file — could aim a recursive delete at
// a real database directory.
function safeCandidate(dir) {
  let real;
  try { real = fs.realpathSync(dir); } catch (_) { return null; }
  const parent = path.dirname(real);
  if (parent !== BASE) return null;                 // must be a direct child of BASE
  if (!path.basename(real).startsWith(PREFIX)) return null;
  return real;
}

function freeBytes() {
  try {
    const s = fs.statfsSync(BASE);
    return s.bavail * s.bsize;
  } catch (_) {
    return null;
  }
}

class InfrastructureError extends Error {
  constructor(message) { super(message); this.name = 'InfrastructureError'; this.infrastructure = true; }
}

// ── CREATE ──────────────────────────────────────────────────────────────────

const live = new Set();
let handlersInstalled = false;

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  // Cleanup on the paths a `finally` does not cover. The handler destroys only THIS run's
  // clusters, then re-raises so the exit status still reflects the signal.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      for (const c of [...live]) { try { c.destroy(); } catch (_) { /* best effort */ } }
      process.kill(process.pid, sig === 'SIGHUP' ? 'SIGTERM' : sig);
    });
  }
  process.on('exit', () => {
    for (const c of [...live]) { try { c.destroy(); } catch (_) { /* best effort */ } }
  });
}

/**
 * Create a disposable cluster. Throws InfrastructureError when the environment cannot support one,
 * so a caller can report "could not run" rather than "the product is broken".
 */
function create({ label = 'test', port = null } = {}) {
  const dir = pgBin();
  if (!dir) throw new InfrastructureError('initdb is not on PATH — no disposable Postgres available');

  const free = freeBytes();
  if (free !== null && free < MIN_FREE_BYTES) {
    throw new InfrastructureError(
      `only ${Math.round(free / 1048576)} MiB free under ${BASE}; a disposable cluster needs at `
      + `least ${Math.round(MIN_FREE_BYTES / 1048576)} MiB. This is an INFRASTRUCTURE failure, not `
      + 'a test failure — run `node scripts/pg-cleanup.js` to inventory stale clusters.');
  }

  // A unique directory AND a unique port per run, so two concurrent runs cannot collide and an
  // orphan cannot block a later one.
  // When this process is root, initdb runs AS postgres, which must be able to traverse into the
  // base. A base created with mkdtemp is 0700, so postgres cannot enter it and initdb fails with
  // "could not access directory … Permission denied" — which happens only for a CONFIGURED base,
  // because /tmp is already world-traversable. Traverse-only (0711): postgres can reach its own
  // cluster directory without being able to list what else is in the base.
  if (process.getuid && process.getuid() === 0) {
    try { fs.chmodSync(BASE, 0o711); } catch (_) { /* not ours to change; initdb will report it */ }
  }
  const base = fs.mkdtempSync(path.join(BASE, `${PREFIX}${label}-`));
  const chosen = port || 49152 + (crypto.randomBytes(2).readUInt16BE(0) % 16000);
  const asRoot = process.getuid && process.getuid() === 0;

  const owner = {
    marker: MARKER,
    runId: RUN_ID,
    pid: process.pid,
    pidStartTime: pidStartTime(process.pid),
    label,
    port: chosen,
    createdAt: new Date().toISOString(),
    argv: process.argv.slice(1, 3),
  };
  fs.writeFileSync(path.join(base, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`);

  const log = path.join(base, 'pg.log');
  try {
    if (asRoot) {
      execFileSync('sh', ['-c', `chown -R postgres ${base}`], { stdio: 'pipe' });
      execFileSync('sh', ['-c',
        `su postgres -c "PATH=${dir}:\\$PATH initdb -D ${base}/data ${INITDB_FLAGS}" && `
        + `su postgres -c "PATH=${dir}:\\$PATH pg_ctl -D ${base}/data -l ${log} `
        + `-o '-p ${chosen} -k ${base}' -w start"`], { stdio: 'pipe' });
    } else {
      execFileSync('sh', ['-c',
        `PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS} && `
        + `PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${log} -o '-p ${chosen} -k ${base}' -w start`],
      { stdio: 'pipe' });
    }
  } catch (e) {
    const detail = String((e && (e.stderr || e.message)) || e).split('\n').slice(-6).join(' ').trim();
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    // Reported, never swallowed into "unavailable": a blocked port and a missing binary need
    // different action, and conflating them is what hid a self-inflicted failure for an afternoon.
    throw new InfrastructureError(`could not start a disposable cluster: ${detail}`);
  }

  const cluster = {
    base,
    dir,
    port: chosen,
    runId: RUN_ID,
    url: `postgresql://postgres@localhost/postgres?host=${base}&port=${chosen}&sslmode=disable`,
    destroy() {
      if (!live.has(cluster)) return;
      live.delete(cluster);
      try {
        execFileSync('sh', ['-c', asRoot
          ? `su postgres -c "PATH=${dir}:\\$PATH pg_ctl -D ${base}/data -m immediate stop"`
          : `PATH=${dir}:$PATH pg_ctl -D ${base}/data -m immediate stop`], { stdio: 'pipe' });
      } catch (_) { /* a cluster that is already gone is the desired state */ }
      const safe = safeCandidate(base);
      if (safe) { try { fs.rmSync(safe, { recursive: true, force: true }); } catch (_) {} }
    },
  };
  live.add(cluster);
  installHandlers();
  return cluster;
}

// ── INVENTORY: WHAT EXISTS, AND WHOSE IS IT ─────────────────────────────────

const STATE = Object.freeze({
  MINE: 'mine',                      // this run's — destroy() handles these
  LIVE_OTHER: 'owned_by_live_run',   // another run is using it. NEVER touch
  DEAD_OWNED: 'owned_by_dead_run',   // positively ours-and-finished → safe to remove
  UNCERTAIN: 'ownership_uncertain',  // evidence incomplete → report, refuse
  UNIDENTIFIED: 'unidentified',      // no marker at all (pre-utility orphans) → inventory only
});

function inventory() {
  const rows = [];
  let entries = [];
  try { entries = fs.readdirSync(BASE, { withFileTypes: true }); } catch (_) { return rows; }

  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX)) continue;
    const real = safeCandidate(path.join(BASE, e.name));
    if (!real) {
      rows.push({ dir: path.join(BASE, e.name), state: STATE.UNCERTAIN,
        why: 'does not canonicalise to a direct child of the disposable base — a symlink or a '
          + 'traversal, and never removed automatically' });
      continue;
    }
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(real, OWNER_FILE), 'utf8')); } catch (_) {}

    if (!owner || owner.marker !== MARKER) {
      rows.push({ dir: real, state: STATE.UNIDENTIFIED,
        why: 'no disposable-cluster ownership marker. It may predate this utility or belong to '
          + 'something else entirely; a directory name is not evidence of ownership' });
      continue;
    }
    if (owner.runId === RUN_ID) { rows.push({ dir: real, owner, state: STATE.MINE }); continue; }

    const same = sameProcess(owner.pid, owner.pidStartTime);
    if (same === null) {
      rows.push({ dir: real, owner, state: STATE.UNCERTAIN,
        why: `cannot confirm whether pid ${owner.pid} is still the process that created this `
          + '(no start-time evidence), and a recycled pid must never be killed on a name match' });
    } else if (same === true) {
      rows.push({ dir: real, owner, state: STATE.LIVE_OTHER,
        why: `pid ${owner.pid} is alive and is the same process that created it — another run is `
          + 'using this cluster' });
    } else {
      rows.push({ dir: real, owner, state: STATE.DEAD_OWNED,
        why: `created by run ${owner.runId} (pid ${owner.pid}), which is no longer running` });
    }
  }
  return rows;
}

/**
 * Remove stale clusters. DRY RUN BY DEFAULT.
 *
 * Only DEAD_OWNED is ever removed. LIVE_OTHER, UNCERTAIN and UNIDENTIFIED are reported and left
 * alone — including the pre-utility orphans, which is deliberate: they are the ones that caused the
 * incident, and deleting a directory on no better evidence than its name is how a cleanup tool
 * becomes the next incident.
 */
function cleanupStale({ dryRun = true } = {}) {
  const rows = inventory();
  const removable = rows.filter((r) => r.state === STATE.DEAD_OWNED);
  const removed = [];

  if (!dryRun) {
    for (const r of removable) {
      const safe = safeCandidate(r.dir);
      if (!safe) continue;                           // re-checked immediately before deleting
      // Stop its server first, and only by its own data directory — never by a pid from the
      // marker, because that pid may have been recycled.
      try {
        execFileSync('sh', ['-c',
          `PATH=${pgBin() || ''}:$PATH pg_ctl -D ${safe}/data -m immediate stop`], { stdio: 'pipe' });
      } catch (_) { /* already stopped */ }
      try { fs.rmSync(safe, { recursive: true, force: true }); removed.push(safe); } catch (_) {}
    }
  }

  return {
    dryRun,
    base: BASE,
    freeBytes: freeBytes(),
    counts: {
      mine: rows.filter((r) => r.state === STATE.MINE).length,
      liveOther: rows.filter((r) => r.state === STATE.LIVE_OTHER).length,
      deadOwned: removable.length,
      uncertain: rows.filter((r) => r.state === STATE.UNCERTAIN).length,
      unidentified: rows.filter((r) => r.state === STATE.UNIDENTIFIED).length,
    },
    removed,
    rows,
  };
}

module.exports = {
  create,
  inventory,
  cleanupStale,
  InfrastructureError,
  STATE,
  MARKER,
  OWNER_FILE,
  BASE,
  // Exported so another module can RECOGNISE a cluster this utility made without duplicating the
  // literal. src/lib/office/business-day-override.js asks the database for its own data_directory
  // and matches this prefix: a disposable cluster is throwaway BY CONSTRUCTION, which is a
  // development signal that does not depend on what rows happen to be in it.
  PREFIX,
  RUN_ID,
  MIN_FREE_BYTES,
  // exported for tests
  pidStartTime,
  sameProcess,
  safeCandidate,
};
