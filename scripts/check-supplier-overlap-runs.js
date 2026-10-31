#!/usr/bin/env node
// ── DOES THE OVERLAP MEASUREMENT RUN, AND DOES IT COUNT THE RIGHT THINGS? ────
//
//   node scripts/check-supplier-overlap-runs.js    exit 0 = it runs and classifies correctly
//
// `gate2-supplier-overlap.js` runs once against production and its numbers decide whether
// replacing `matchSuppliers` with canonical capability is worth doing. The distinction that
// matters: an RFQ whose molecule RESOLVES but has NO canonical supplier is not the same as an RFQ
// that does not resolve at all, and neither is the same as one with a real multi-supplier
// comparison. Collapsing any pair of those would make the overlap look better or worse than it is.
//
// Asserted: it executes; the three resolved-RFQ cases are counted separately; unresolved RFQs are
// reported apart from resolved ones; and it writes nothing.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 400)}`); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/sovl-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55995' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55995 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55995&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.MOLID_PG_URL || startTemp();
if (!url) {
  out('  skip  no Postgres available (set MOLID_PG_URL or install initdb)');
  out('SKIP  supplier overlap not executed — this check needs a server');
  process.exit(0);
}
process.env.DATABASE_URL = url;

const { query } = require('../src/lib/db');
const { DDL_TABLES, DDL_TRIGGERS, applyConflictKinds, applyDriftColumns } = require('./migrate-molecules');

const FIXTURE = `
  CREATE TABLE IF NOT EXISTS rfq_requests (
    id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT, week_start TEXT,
    status TEXT, gmp_required INTEGER DEFAULT 0, target_quantity TEXT, target_purity TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS supplier_products (
    id BIGSERIAL PRIMARY KEY, event_slug TEXT, contact_id BIGINT, product_name TEXT, cas TEXT);
  CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY, name TEXT, region TEXT, specialties TEXT, reliability_score REAL,
    gmp_certified INTEGER DEFAULT 0, contact_email TEXT, contact_name TEXT,
    avg_response_days REAL DEFAULT 3, total_orders INTEGER DEFAULT 0);
`;

function runScript() {
  try {
    const stdout = execFileSync(process.execPath, [path.join(__dirname, 'gate2-supplier-overlap.js')],
      { env: { ...process.env, DATABASE_URL: url, JWT_SECRET: process.env.JWT_SECRET || 'overlap-check' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
const digit = (stdout, key) => {
  const m = stdout.match(new RegExp(`${key}=([0-9]+)`));
  return m ? Number(m[1]) : null;
};

(async () => {
  await query(DDL_TABLES);
  await query(DDL_TRIGGERS);
  await applyConflictKinds(query);
  await applyDriftColumns(query, () => {});
  await query(FIXTURE);
  await query(`ALTER TABLE supplier_products ADD COLUMN IF NOT EXISTS molecule_id BIGINT`);

  // Three canonical molecules, deliberately giving one multi-supplier capability, one single, and
  // one none at all.
  const ids = (await query(
    `INSERT INTO molecules (preferred_name, normalized_name, cas, source, derivation_method) VALUES
       ('Tramadol Hydrochloride','tramadol hydrochloride','36282-47-0','fixture','exact'),
       ('Gemcitabine','gemcitabine','95058-81-4','fixture','exact'),
       ('Warfarin','warfarin','81-81-2','fixture','exact')
     RETURNING id, normalized_name`)).rows;
  const idOf = (n) => String(ids.find((x) => x.normalized_name === n).id);

  // Tramadol: two suppliers (a real comparison). Gemcitabine: one. Warfarin: none.
  await query(
    `INSERT INTO supplier_products (event_slug, contact_id, product_name, cas, molecule_id) VALUES
       ('e1', 1, 'Tramadol HCl', NULL, $1),
       ('e1', 2, 'Tramadol HCl', NULL, $1),
       ('e1', 1, 'Gemcitabine',  NULL, $2)`, [idOf('tramadol hydrochloride'), idOf('gemcitabine')]);

  // A supplier row so the SHIPPED matchSuppliers has something to score.
  await query(
    `INSERT INTO suppliers (id, name, region, specialties, reliability_score, gmp_certified, contact_email)
     VALUES ('sup-a','Supplier A','india','["api"]',70,1,'a@example.com'),
            ('sup-b','Supplier B','china','["research"]',60,0,'b@example.com')`);

  // Four RFQs: multi-supplier, single-supplier, resolved-but-no-supplier, and unresolved.
  await query(
    `INSERT INTO rfq_requests (id, molecule_name, cas_number, week_start, status) VALUES
       ('r1','Tramadol Hydrochloride',NULL,'2026-10-26','sent'),
       ('r2','Gemcitabine',NULL,'2026-10-26','pending'),
       ('r3','Warfarin',NULL,'2026-10-26','pending'),
       ('r4','Tiotropium Bromide',NULL,'2026-10-26','pending')`);

  const r = runScript();
  if (r.code !== 0) bad(`script exited ${r.code}`, r.stderr);
  else ok('runs end to end against a real Postgres and exits 0 having measured');

  const expect = (key, want) => {
    const got = digit(r.stdout, key);
    if (got === want) ok(`${key} = ${want}`);
    else bad(`${key} = ${got}, expected ${want}`, r.stdout.slice(-500));
  };

  expect('rfq_total', 4);
  expect('rfq_resolved', 3);
  expect('rfq_unresolved', 1);
  // THE THREE CASES THAT MUST NOT COLLAPSE
  expect('resolved_with_supplier', 2);     // Tramadol + Gemcitabine
  expect('resolved_with_multi', 1);        // Tramadol only
  expect('resolved_no_supplier', 1);       // Warfarin resolves but nobody supplies it
  expect('capability_molecules', 2);

  // An unresolved RFQ must be reported separately, by name, not folded into a total.
  if (/"Tiotropium Bromide"/.test(r.stdout) && /unresolved_no_match/.test(r.stdout)) {
    ok('the unresolved RFQ is named with its reason, not just counted');
  } else {
    bad('the unresolved RFQ was not reported individually');
  }
  // The heuristic-without-capability case is the one that argues for the change.
  if (/heuristic proposed \d+, canonical capability knows 0/.test(r.stdout)) {
    ok('an RFQ the heuristic would answer but canonical capability cannot is surfaced');
  } else {
    bad('the heuristic-without-capability case was not surfaced', r.stdout.slice(-600));
  }

  // ── wrote nothing ────────────────────────────────────────────────────────
  const counts = async () => (await query(
    `SELECT (SELECT COUNT(*)::int FROM molecules) m,
            (SELECT COUNT(*)::int FROM rfq_requests) r,
            (SELECT COUNT(*)::int FROM supplier_products) s,
            (SELECT COUNT(*)::int FROM suppliers) u,
            (SELECT COUNT(*)::int FROM molecule_conflicts) c`)).rows[0];
  const before = await counts();
  runScript();
  const after = await counts();
  if (JSON.stringify(before) === JSON.stringify(after)) {
    ok('the overlap measurement wrote nothing — counts unchanged across five tables');
  } else {
    bad('the overlap measurement MUTATED the database', JSON.stringify({ before, after }));
  }

  stopTemp();
  if (fail) { out(`FAIL  ${fail} assertion(s) failed`); process.exit(1); }
  out('PASS  supplier overlap runs, keeps the three resolved cases apart, and writes nothing');
  process.exit(0);
})().catch((e) => {
  stopTemp();
  fs.writeSync(2, `FAIL  harness error: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
