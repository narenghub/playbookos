'use strict';
// ── ONE IMPLEMENTATION OF "RESTORE A DUMP INTO A DISPOSABLE CLUSTER" ────────
//
// This module exists for the reason scripts/lib/pg-cluster.js exists. Thirty-five harnesses each
// carried their own copy of the Postgres search path; the copies drifted, could not be corrected
// in one place, and on 2026-11-03 that produced 31 of 44 preflight steps reporting `ok` having
// executed nothing. The restore logic was on the same path: verify-restore.js had it, and the
// migration-on-restore harness was about to become the second copy.
//
// Three lessons are encoded here, all of them paid for:
//
//  1. EVERY CLIENT CALL NAMES ITS ROLE. The cluster's only superuser is `postgres`
//     (INITDB_FLAGS), but psql and pg_restore default the ROLE to the invoking OS user — an
//     independent decision from initdb's. In a container running as root with an `su postgres`
//     wrapper the two coincide and the omission is invisible; run as a person it is
//     `role "nboda3230" does not exist` on the first call.
//
//  2. THE TOOLCHAIN IS CHOSEN BY WHAT CAN READ THE DUMP, not by search order. A custom-format
//     dump carries the archive version its pg_dump wrote, and an older pg_restore refuses it:
//     `unsupported version (1.16) in file header`. A versioned Homebrew keg outranks
//     /opt/homebrew/bin in the search list, so a good backup looked like a bad backup. Each
//     candidate is ASKED, with `pg_restore --list`, which parses the archive and touches no
//     server. The chosen directory is then used for initdb, pg_ctl AND pg_restore together, so
//     the cluster's server version cannot disagree with the client restoring into it.
//
//  3. initdb's PRESENCE DOES NOT MEAN A SERVER IS INSTALLED. Homebrew's `libpq` ships psql,
//     pg_dump, pg_restore and initdb but no `postgres`, and is linked into /opt/homebrew/bin.
//     canStartACluster() in pg-cluster.js requires all three binaries; this module only ever asks
//     for candidates that satisfy it.
//
// And one rule about reporting: a cluster that will not start is a FAILURE, not an absence. The
// earlier version returned null for every error and the caller printed "no Postgres available" on
// a machine with PostgreSQL 18.3 installed and correctly selected. The verdict was honest and the
// diagnosis was invented, which sends a person off to install what they already have. So the
// error is captured — the step, its output, and the server's own log, which is usually the only
// place the real reason appears.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pgBinCandidates, pgClientOnlyDirs, INITDB_FLAGS } = require('./pg-cluster');

/** The archive version from a custom-format dump header, or null if it is not one. */
function archiveVersion(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8);
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  if (buf.toString('latin1', 0, 5) !== 'PGDMP') return null;
  return `${buf[5]}.${buf[6]}`;
}

function toolVersion(dir, tool) {
  try {
    return execFileSync(path.join(dir, tool), ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { return 'unknown'; }
}

/**
 * A toolchain that can read this dump.
 * @returns {{dir:string, version:string, initdbVersion:string}} or {{tried:string[], clientOnly:string[]}}
 */
function toolchainFor(file, isCustom) {
  const candidates = pgBinCandidates();
  const clientOnly = pgClientOnlyDirs();
  if (!candidates.length) return { tried: [], clientOnly };
  const pick = (dir) => ({ dir, version: toolVersion(dir, 'pg_restore'), initdbVersion: toolVersion(dir, 'initdb') });
  if (!isCustom) return pick(candidates[0]);
  const tried = [];
  for (const dir of candidates) {
    try {
      execFileSync(path.join(dir, 'pg_restore'), ['--list', file], { stdio: 'ignore' });
      return pick(dir);
    } catch (_) { tried.push(`${dir} (${toolVersion(dir, 'pg_restore')})`); }
  }
  return { tried, clientOnly };
}

/**
 * Start a throwaway cluster from a chosen toolchain directory.
 * @returns {{base, dir, asPostgres, sh}} on success, or {{error:{step,output,log,base}}}
 */
function startCluster(dir, { port, prefix = 'restore-' } = {}) {
  const base = fs.mkdtempSync(`/var/tmp/${prefix}`);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const asPostgres = process.getuid && process.getuid() === 0;
  const sh = (cmd, quiet) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: quiet ? 'pipe' : ['pipe', 'pipe', 'pipe'] });
  let step = 'preparing the directory';
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    step = `initdb (${dir}/initdb)`;
    sh(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`, true);
    step = `pg_ctl start (${dir}/pg_ctl)`;
    sh(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${port} -c listen_addresses=' start -w`, true);
  } catch (e) {
    let log = '';
    try { log = fs.readFileSync(path.join(base, 'pg.log'), 'utf8'); } catch (_) { /* may not exist */ }
    return {
      error: {
        step,
        message: e.message || String(e),
        output: `${e.stdout || ''}${e.stderr || ''}`.trim(),
        log: log.trim(),
        base,
      },
    };
  }
  return { base, dir, asPostgres, sh, port };
}

function stopCluster(cluster) {
  if (!cluster || !cluster.base) return;
  const env = { ...process.env, PATH: `${cluster.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', cluster.asPostgres
      ? `su postgres -c "PATH=${cluster.dir}:\\$PATH pg_ctl -D ${cluster.base}/data -m immediate stop"`
      : `PATH=${cluster.dir}:$PATH pg_ctl -D ${cluster.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(cluster.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

/**
 * Restore a dump into a fresh database in that cluster.
 *
 * --exit-on-error / ON_ERROR_STOP are deliberate: a restore that reports success while skipping
 * objects is the failure this whole exercise exists to catch.
 *
 * @returns {{dbName}} or {{error:string}}
 */
function restoreDump(cluster, dumpPath, { dbName = 'restored' } = {}) {
  const { base, dir, asPostgres, sh, port } = cluster;
  const abs = path.resolve(dumpPath);
  const isCustom = archiveVersion(abs) !== null;
  const isGz = /\.gz$/i.test(abs);
  // The cluster runs as the postgres user when we are root, so the dump must be readable by it.
  if (asPostgres) { try { execFileSync('chmod', ['a+r', abs]); } catch (_) { /* best effort */ } }
  try {
    sh(`PATH=${dir}:$PATH psql -U postgres -h ${base} -p ${port} -d postgres `
      + `-c "DROP DATABASE IF EXISTS ${dbName}" -c "CREATE DATABASE ${dbName}"`, true);
    if (isCustom) {
      sh(`PATH=${dir}:$PATH pg_restore -U postgres --no-owner --no-privileges --exit-on-error `
        + `-h ${base} -p ${port} -d ${dbName} ${JSON.stringify(abs)} 2>&1`, true);
    } else if (isGz) {
      sh(`gunzip -c ${JSON.stringify(abs)} | PATH=${dir}:$PATH psql -U postgres -v ON_ERROR_STOP=1 `
        + `-h ${base} -p ${port} -d ${dbName} 2>&1`, true);
    } else {
      sh(`PATH=${dir}:$PATH psql -U postgres -v ON_ERROR_STOP=1 -h ${base} -p ${port} -d ${dbName} `
        + `-f ${JSON.stringify(abs)} 2>&1`, true);
    }
  } catch (e) {
    return { error: `${e.stdout || ''}${e.stderr || ''}`.trim() || e.message };
  }
  return { dbName, url: urlFor(cluster, dbName), isCustom };
}

function urlFor(cluster, dbName = 'restored') {
  return `postgresql://postgres@localhost/${dbName}?host=${cluster.base}&port=${cluster.port}&sslmode=disable`;
}

module.exports = {
  archiveVersion,
  toolVersion,
  toolchainFor,
  startCluster,
  stopCluster,
  restoreDump,
  urlFor,
};
