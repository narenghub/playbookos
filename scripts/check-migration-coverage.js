#!/usr/bin/env node
// ── DOES THE MIGRATOR CREATE EVERY TABLE THE CODE EXPECTS? ───────────────────
//
//   node scripts/check-migration-coverage.js [--list]
//
// There are 43 scripts/migrate-*.js files in this repository. Not one of them was in the boot
// chain, and not one was in any chain at all: each was run BY HAND, once, against production, in
// whatever order the person remembered. There is no record of which have been run and no way to
// bring a fresh database to the shape the application expects.
//
// This was invisible while boot applied a dozen migrations against a database that had been alive
// for months. It became visible the moment a freshly migrated cluster was asked to serve a page:
// /api/notifications and /api/outreach/tasks returned 500 "relation does not exist", on the first
// page load, for every user. Four more tables were then found the same way, one 500 at a time.
//
// Discovering a deployment prerequisite by watching requests fail is not a method. This measures it:
//
//   1. migrate a disposable cluster with src/lib/migrate-all (the real migrator)
//   2. list the tables that exist afterwards
//   3. scan every scripts/migrate-*.js for the tables it would CREATE
//   4. report every table a script creates that the migrator does NOT
//
// Exit status is the verdict: 0 = the migrator covers every table any migration script creates,
// 1 = there are tables only reachable by running a script by hand, 3 = could not execute.
//
// A FAIL here does not mean the gap is a bug to fix blindly: some of these scripts are one-off data
// migrations, renames, or enforcement switches, and running them unreviewed against production is
// its own risk. It means the gap is KNOWN and listed, instead of being found by a user.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.COVERAGE_PGPORT || '55451';
const SCRIPTS_DIR = path.join(__dirname);
const LIST_ONLY = process.argv.includes('--list');

// Scripts that must NOT be treated as table creators to be absorbed. Each is named with its reason:
// running these as part of a routine migration is a different and larger decision.
// Tables that are created and then RENAMED by a later step, so their original names correctly do
// not exist after a full run. migrate-acbm.js creates acbm_*, and migrate-sitenex-rename.js renames
// each to sitenex_*. Reporting these as "not covered" would be reporting the rename as a fault.
const RENAMED_AWAY = new Map([
  ['acbm_packages', 'sitenex_packages'],
  ['acbm_deals', 'sitenex_deals'],
  ['acbm_intake', 'sitenex_intake'],
  ['acbm_projects', 'sitenex_projects'],
]);

const NOT_PLAIN_CREATORS = new Map([
  ['migrate-enforce-denials.js', 'flips an enforcement switch; that is a policy change, not a schema step'],
  ['migrate-cphi-roles.js', 'grants roles; belongs to access provisioning, not schema'],
  ['migrate-invite-products.js', 'back-fills product grants for existing accounts'],
  ['migrate-prospects-reachability.js', 'back-fills a computed column over existing rows'],
  // migrate-outreach-partner-scope.js WAS excluded here, as "back-fills partner scope over existing
  // rows". It is now step 'outreach partner scope' in the chain: the description was accurate about
  // what it also does and silent about the schema it changes — ADD COLUMN partner_id, DROP the
  // entity-only UNIQUE, CREATE the per-partner unique index the application's upsert conflicts on.
  // A migrator-built database had no outreach.partner_id and the app's own setStatus failed on it.
  //
  // The lesson is about this list, not that script: an entry here is a claim that a script changes no
  // schema, and it was accepted on the strength of a summary line. Anything added below is read.
]);

let temp = null;
function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/prpa-cov-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) { console.error(`  (cluster start failed: ${e.message})`); return null; }
  temp = { base, dir, asPostgres };
  return base;
}
function stopCluster() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch { /* going away anyway */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp dir */ }
}

// Tables a script would create. Matches both quoted and bare identifiers.
function tablesCreatedBy(src) {
  // Comments stripped first: several of these files DISCUSS creating tables in prose ("CREATE TABLE
  // IF the row means …"), and scanning the raw text captured `if` and `means` as table names.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  const out = new Set();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  // The trailing \( matters: a table declaration is always followed by its column list, and
  // requiring it rejects prose that merely contains the words.
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1].toLowerCase();
    // Belt and braces against SQL keywords slipping through as identifiers.
    if (['if', 'not', 'exists', 'means', 'table', 'select', 'as'].includes(name)) continue;
    out.add(name);
  }
  return out;
}

function scanScripts() {
  const files = fs.readdirSync(SCRIPTS_DIR)
    .filter((f) => /^migrate-.*\.js$/.test(f))
    .sort();
  return files.map((f) => ({
    file: f,
    excluded: NOT_PLAIN_CREATORS.get(f) || null,
    tables: [...tablesCreatedBy(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'))],
  }));
}

async function main() {
  console.log(`\n${'─'.repeat(78)}\nMIGRATION COVERAGE — what a fresh database would be missing\n${'─'.repeat(78)}`);

  const scanned = scanScripts();
  const declared = scanned.filter((s) => s.tables.length);
  console.log(`  ${scanned.length} migrate-*.js script(s) · ${declared.length} declare at least one CREATE TABLE`);

  if (LIST_ONLY) {
    for (const s of scanned) {
      console.log(`\n  ${s.file}${s.excluded ? '   [EXCLUDED]' : ''}`);
      if (s.excluded) console.log(`      reason: ${s.excluded}`);
      if (s.tables.length) console.log(`      tables: ${s.tables.join(', ')}`);
      else console.log('      tables: (none — not a table creator)');
    }
    console.log('');
    process.exit(0);
  }

  const base = startCluster();
  if (!base) { console.log('\nSKIP  no PostgreSQL toolchain. This proved NOTHING.\n'); process.exit(EXIT_NOT_EXECUTED); }

  const url = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  process.env.DATABASE_URL = url;
  process.env.PRPA_COMPANY_SLUG = 'abiozen';
  process.env.ADMIN_EMAIL = 'coverage-fixture@example.invalid';
  process.env.ADMIN_PASSWORD = `fixture-only-${Date.now()}`;
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');

  const client = new Client({ connectionString: url });
  await client.connect();
  let present = new Set();
  let migrationOk = false;
  try {
    const out = await require('../src/lib/migrate-all').runAll((s, p) => client.query(s, p), {
      seeds: false, log: () => {},
    });
    migrationOk = out.ok;
    if (!out.ok) {
      console.log(`\n  the migrator itself FAILED: ${out.failed.map((f) => `${f.name}: ${f.error}`).join(' | ')}`);
    } else {
      console.log(`  the migrator applied ${out.steps.length} step(s) cleanly`);
    }
    const rows = (await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows;
    present = new Set(rows.map((r) => r.tablename.toLowerCase()));
    console.log(`  ${present.size} table(s) exist after migration`);
  } finally {
    try { await client.end(); } catch { /* closing */ }
    stopCluster();
  }

  const gaps = [];
  const renamed = [];
  for (const s of declared) {
    const missing = [];
    for (const t of s.tables) {
      if (present.has(t)) continue;
      const to = RENAMED_AWAY.get(t);
      // Covered if the table it was renamed INTO exists. If neither name is present, the rename
      // did not happen either, and that is a genuine gap.
      if (to && present.has(to)) { renamed.push(`${t} → ${to}`); continue; }
      missing.push(t);
    }
    if (missing.length) gaps.push({ file: s.file, excluded: s.excluded, missing });
  }
  if (renamed.length) console.log(`  ${renamed.length} table(s) renamed by a later step: ${renamed.join(', ')}`);

  console.log('');
  if (!migrationOk) {
    console.log('FAIL  the migrator did not complete, so coverage cannot be judged.\n');
    process.exit(1);
  }
  const blocking = gaps.filter((g) => !g.excluded);
  const excluded = gaps.filter((g) => g.excluded);

  // The verdict is BLOCKING gaps, not all gaps. Keying it off `gaps` failed the check while
  // reporting "0 table(s) across 0 script(s)" — a red with nothing to fix, which trains a reader to
  // ignore the exit code. That is the same disease as a false green.
  if (!blocking.length) {
    if (excluded.length) {
      console.log('  Excluded by name (not routine schema steps — see NOT_PLAIN_CREATORS):');
      for (const g of excluded) {
        console.log(`      ${g.file} — ${g.excluded}`);
        console.log(`          would create: ${g.missing.join(', ')}`);
      }
      console.log('');
    }
    console.log('PASS  every table a migration script creates is created by the migrator, except');
    console.log('      those excluded by name above with a stated reason.\n');
    process.exit(0);
  }

  for (const g of blocking) {
    console.log(`  NOT COVERED  ${g.file}`);
    console.log(`      tables absent after migration: ${g.missing.join(', ')}`);
  }
  if (excluded.length) {
    console.log('\n  Excluded by name (not routine schema steps — see NOT_PLAIN_CREATORS):');
    for (const g of excluded) {
      console.log(`      ${g.file} — ${g.excluded}`);
      console.log(`          would create: ${g.missing.join(', ')}`);
    }
  }

  const tableCount = blocking.reduce((n, g) => n + g.missing.length, 0);
  console.log(`\nFAIL  ${tableCount} table(s) across ${blocking.length} script(s) are reachable ONLY by running`);
  console.log('      a script by hand. A fresh deployment will 500 on any endpoint that touches them.');
  console.log('      Add each to SCHEMA_STEPS in src/lib/migrate-all.js, or record it as deliberately');
  console.log('      out of scope in NOT_PLAIN_CREATORS here. Do not leave it undecided.\n');
  process.exit(1);
}

main().catch((e) => { console.error(`\ncheck-migration-coverage: ${e.stack || e.message}\n`); stopCluster(); process.exit(1); });
