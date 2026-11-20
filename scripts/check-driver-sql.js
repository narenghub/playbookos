#!/usr/bin/env node
// ── EVERY SQL IDENTIFIER IN THE ACCEPTANCE HARNESS, CHECKED AGAINST THE SCHEMA ─
//
//   node scripts/check-driver-sql.js            # check against the repo's DDL
//   node scripts/check-driver-sql.js --live     # check against the live schema (read-only)
//   node scripts/check-driver-sql.js --self-test  # prove the checker rejects the real defects
//   echo $?                                     # 0 = every identifier resolves
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// The third hardware acceptance run aborted at scenario 7 with
//
//     column "error" does not exist
//
// `worker_results` has no `error` column; the failure detail lives inside `output`. Ten minutes
// after diagnosing that, an ad-hoc query written the same way failed with
//
//     column "lease_expires_at" does not exist
//
// Both were written from memory and neither had ever been executed. Unit tests could not catch
// them: the statements only run against a real database, on hardware, in the middle of a run that
// takes twenty minutes to reach them. So the SQL is checked statically, here, against a catalog
// built from the schema the application itself creates — never from memory.
//
// This is a LINTER, not a parser. It resolves table references and the identifiers that look like
// columns, and it is deliberately loud about anything it cannot resolve rather than quiet. The
// --self-test mode exists because a checker that passes everything is worse than no checker: it
// feeds both historical defects through and fails if either is accepted.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** The files whose SQL is checked. Helpers and cleanup included — the authorization says so. */
const TARGETS = [
  'scripts/m7-5-dev-driver.js',
  'scripts/m7-5-state-report.js',
  'scripts/check-worker-leasing-db.js',
  'scripts/check-worker-runtime-db.js',
  'scripts/m7-6-dev-driver.js',
  'scripts/check-worker-availability.js',
];

// ── 1. THE CATALOG ─────────────────────────────────────────────────────────
//
// Built by reading the DDL the application runs at migration time. Test files are excluded: a
// table that exists only in a test fixture is not a table the harness may use, and if the harness
// references one, that is a finding rather than a pass.

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

function catalogFromDDL() {
  const tables = new Map();
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');

    // CREATE TABLE IF NOT EXISTS <name> ( ... )  — the body up to the matching close paren is
    // approximated by reading to the first `)` that is followed by a backtick or `)`,
    // which is how every DDL string in this repo is written.
    const re = /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const [, name, body] = m;
      const cols = tables.get(name) || new Set();
      for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('--')) continue;
        // A column definition starts with the column name. Table-level constraints do not.
        const cm = /^([a-z_][a-z0-9_]*)\s+[A-Za-z]/.exec(t);
        if (!cm) continue;
        const word = cm[1].toUpperCase();
        if (['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'EXCLUDE'].includes(word)) continue;
        cols.add(cm[1]);
      }
      tables.set(name, cols);
    }

    // Columns added later are just as real as columns created up front.
    const alter = /ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/g;
    while ((m = alter.exec(src))) {
      const cols = tables.get(m[1]) || new Set();
      cols.add(m[2]);
      tables.set(m[1], cols);
    }
  }
  return tables;
}

async function catalogFromLive() {
  // Read-only introspection. No DDL, no writes, nothing but information_schema.
  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) {
    throw new Error('--live needs DATABASE_URL pointed at the DEVELOPMENT database');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const r = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`);
    const tables = new Map();
    for (const row of r.rows) {
      const cols = tables.get(row.table_name) || new Set();
      cols.add(row.column_name);
      tables.set(row.table_name, cols);
    }
    return tables;
  } finally {
    await pool.end();
  }
}

// ── 2. STATEMENT EXTRACTION ────────────────────────────────────────────────

/** Every backtick template literal in a file that contains SQL. */
function statementsIn(src) {
  const out = [];
  const lines = src.split('\n');
  let buf = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (buf === null) {
      const start = line.indexOf('`');
      if (start === -1) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue;       // a comment, not code
      const rest = line.slice(start + 1);
      const end = rest.indexOf('`');
      if (end !== -1) out.push({ line: i + 1, sql: rest.slice(0, end) });
      else buf = { line: i + 1, sql: rest };
    } else {
      const end = line.indexOf('`');
      if (end === -1) { buf.sql += `\n${line}`; continue; }
      buf.sql += `\n${line.slice(0, end)}`;
      out.push(buf);
      buf = null;
    }
  }
  // A template literal must START with a SQL verb to be SQL. Requiring only that one appear
  // somewhere matched English prose — `ok(\`without the index, still exactly one WINNER — so the
  // task UPDATE is the primary arbiter\`)` was read as a statement selecting from a table called
  // "is". A linter that reports a sentence as a schema defect gets switched off, and then it
  // catches nothing at all.
  return out.filter((s) => /^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i.test(s.sql));
}

// Words that appear in these statements and are not columns.
const NOT_COLUMNS = new Set(`
select from where and or not null is in as on join left right inner outer full cross using
insert into values update set delete returning order by group having limit offset distinct
count sum min max avg coalesce now interval extract date cast case when then else end exists
asc desc conflict do nothing true false between like ilike any all some union intersect except
int integer bigint text boolean timestamptz jsonb uuid numeric interval_type with recursive
information_schema public table_name column_name table_schema ordinal_position columns
`.trim().split(/\s+/));

/** Table references and their aliases. */
function referencesIn(sql) {
  const refs = [];
  const re = /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_][a-z0-9_.]*)\s*(?:AS\s+)?([a-z][a-z0-9_]*)?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1];
    let alias = m[2];
    if (alias && (NOT_COLUMNS.has(alias.toLowerCase()) || /^(set|where|values|on|using)$/i.test(alias))) {
      alias = undefined;
    }
    refs.push({ table, alias });
  }
  return refs;
}

function checkStatement({ sql, line }, tables, file, findings) {
  if (/\$\{/.test(sql)) {
    findings.push({ kind: 'INTERPOLATED', file, line, detail:
      'the statement interpolates a value, so its identifiers cannot be checked statically' });
    return;
  }
  const refs = referencesIn(sql);
  if (!refs.length) return;

  // Introspection against the Postgres catalog or information_schema is checking the schema, not
  // using it. Its columns are not in the application's DDL by definition, so it is out of scope
  // here — and a statement that reads pg_indexes to assert an index exists is exactly the kind of
  // check this file is defending.
  if (/\b(?:FROM|JOIN)\s+(?:pg_[a-z_]+|pg_catalog\.|information_schema\.)/i.test(sql)) return;

  const known = new Set();
  const aliasMap = new Map();
  for (const r of refs) {
    const bare = r.table.replace(/^public\./, '');
    if (bare.includes('.')) continue;                  // information_schema.columns etc
    if (!tables.has(bare)) {
      findings.push({ kind: 'UNKNOWN TABLE', file, line, detail: `${bare} is not in the schema` });
      continue;
    }
    for (const c of tables.get(bare)) known.add(c);
    if (r.alias) aliasMap.set(r.alias.toLowerCase(), bare);
  }
  if (refs.some((r) => r.table.includes('.'))) return; // introspection queries: catalog, not data

  // Strip string literals and casts so their contents are not read as identifiers.
  const body = sql.replace(/'[^']*'/g, "''").replace(/::[a-z_]+/gi, '');

  // Qualified columns are the strongest check there is: the alias names the table exactly.
  const qual = /\b([a-z][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g;
  let m;
  while ((m = qual.exec(body))) {
    const [, al, col] = m;
    const table = aliasMap.get(al.toLowerCase()) || (tables.has(al) ? al : null);
    if (!table) continue;
    if (!tables.get(table).has(col)) {
      findings.push({ kind: 'UNKNOWN COLUMN', file, line,
        detail: `${table}.${col} does not exist (columns: ${[...tables.get(table)].join(', ')})` });
    }
  }

  // Unqualified identifiers, checked against the union of the referenced tables' columns. Output
  // aliases the statement itself introduces are collected first so they are not mistaken for
  // columns.
  const introduced = new Set();
  for (const am of body.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)) introduced.add(am[1].toLowerCase());
  for (const am of body.matchAll(/\)\s+([a-z_][a-z0-9_]*)\s*(?:,|FROM)/gi)) introduced.add(am[1].toLowerCase());

  const stripped = body.replace(/\b[a-z][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/g, ' ');
  for (const im of stripped.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)) {
    const w = im[1];
    const lw = w.toLowerCase();
    if (NOT_COLUMNS.has(lw) || introduced.has(lw)) continue;
    if (tables.has(w) || aliasMap.has(lw)) continue;
    if (known.has(w)) continue;
    findings.push({ kind: 'UNRESOLVED', file, line,
      detail: `"${w}" is not a column of ${refs.map((r) => r.table).join(', ')}` });
  }
}

function run(tables, targets = TARGETS) {
  const findings = [];
  const perFile = [];
  let statements = 0;
  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      findings.push({ kind: 'MISSING FILE', file: rel, line: 0, detail: 'target not found' });
      continue;
    }
    const src = fs.readFileSync(abs, 'utf8');
    const sts = statementsIn(src);
    perFile.push({ file: rel, n: sts.length });
    for (const st of sts) {
      statements++;
      checkStatement(st, tables, rel, findings);
    }
  }
  return { findings, statements, perFile };
}

// ── 3. THE CONTROL ─────────────────────────────────────────────────────────
//
// A linter nobody has seen reject anything is decoration. These are the two statements that
// actually failed on hardware; if this checker accepts either, it is broken and says so.

function selfTest(tables) {
  const cases = [
    { name: 'the scenario 7 defect',
      sql: 'SELECT status, error FROM worker_results WHERE task_id=$1',
      expect: /error/ },
    { name: 'the ad-hoc query defect',
      sql: 'SELECT id, lease_expires_at FROM worker_tasks WHERE state=\'LEASED\'',
      expect: /lease_expires_at/ },
    { name: 'a wrong qualified column',
      sql: 'SELECT r.finished_at FROM agent_runs r WHERE r.intent_key = $1',
      expect: /finished_at/ },
    { name: 'a table that does not exist',
      sql: 'SELECT * FROM worker_leases WHERE id = $1',
      expect: /worker_leases/ },
  ];
  let failed = 0;
  console.log('\nCONTROL — the checker must reject each of these:\n');
  for (const c of cases) {
    const f = [];
    checkStatement({ sql: c.sql, line: 0 }, tables, '(control)', f);
    const hit = f.some((x) => c.expect.test(x.detail));
    console.log(`  ${hit ? 'rejected' : 'ACCEPTED'}  ${c.name}`);
    if (!hit) {
      failed++;
      console.log(`            the checker did not object to: ${c.sql}`);
    }
  }
  // And the mirror: a statement known to be correct must NOT be rejected, or the checker would
  // "pass" by rejecting everything.
  const good = [
    'SELECT status, output FROM worker_results WHERE task_id=$1',
    'SELECT state, cancel_requested_at, cancel_reason FROM worker_tasks WHERE id = $1',
    'SELECT scope_type, scope_key FROM autonomy_stops',
  ];
  console.log('\nCONTROL — and must accept each of these:\n');
  for (const sql of good) {
    const f = [];
    checkStatement({ sql, line: 0 }, tables, '(control)', f);
    console.log(`  ${f.length ? 'REJECTED' : 'accepted'}  ${sql.slice(0, 64)}`);
    if (f.length) {
      failed++;
      for (const x of f) console.log(`            ${x.kind}: ${x.detail}`);
    }
  }
  return failed;
}

async function main() {
  const live = process.argv.includes('--live');
  const tables = live ? await catalogFromLive() : catalogFromDDL();
  console.log(`\nschema catalog: ${tables.size} table(s) from ${live ? 'the LIVE development database (read-only)' : "the repo's DDL"}`);

  if (process.argv.includes('--self-test')) {
    const failed = selfTest(tables);
    console.log(failed ? `\nFAIL — ${failed} control(s) wrong\n` : '\nthe checker discriminates\n');
    process.exit(failed ? 1 : 0);
  }

  const { findings, statements, perFile } = run(tables);
  console.log(`checked ${statements} SQL statement(s):`);
  // Printed per file because a zero here is the one result that must never be mistaken for a
  // pass: a file whose statements were not extracted is a file that was not checked.
  for (const f of perFile) console.log(`    ${String(f.n).padStart(3)}  ${f.file}`);
  const empty = perFile.filter((f) => f.n === 0);
  if (empty.length) {
    findings.push({ kind: 'NOT CHECKED', file: empty.map((f) => f.file).join(', '), line: 0,
      detail: 'no SQL statements were extracted — the file is unchecked, not clean' });
  }
  console.log('');

  const hard = findings.filter((f) => f.kind !== 'INTERPOLATED');
  for (const f of findings) {
    console.log(`  ${f.kind.padEnd(14)} ${f.file}:${f.line}  ${f.detail}`);
  }
  if (!findings.length) console.log('  no findings');

  console.log(hard.length
    ? `\nFAIL — ${hard.length} identifier(s) do not resolve against the schema\n`
    : '\nOK — every table and column referenced by the harness exists\n');
  process.exit(hard.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => { console.error(`\nERROR ${e.message}\n`); process.exit(2); });
}

module.exports = { catalogFromDDL, statementsIn, referencesIn, checkStatement, run, TARGETS };
