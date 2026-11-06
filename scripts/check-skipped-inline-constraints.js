// ── EVERY CONSTRAINT `CREATE TABLE IF NOT EXISTS` WILL SILENTLY SKIP ON AN EXISTING TABLE ──
//
//   node scripts/check-skipped-inline-constraints.js                      # report the exposure
//   node scripts/check-skipped-inline-constraints.js --against <db-url>   # and what is MISSING there
//
// THE DEFECT THIS GENERALISES. On 2026-11-06 the first gate-2 run against the real production dump
// halted on one step:
//
//   outreach: unique on (entity_type, entity_id): MISSING
//
// `CREATE TABLE IF NOT EXISTS outreach (… UNIQUE (entity_type, entity_id))` declares that constraint,
// but IF NOT EXISTS skips the ENTIRE statement when the table exists. Production's outreach table had
// been created by an older revision, so it had 159 rows and no constraint — and setStatus's
// ON CONFLICT upsert raises 42P10 against it, meaning the feature was failing outright in production.
//
// That is not one bug. It is one instance of a pattern repeated across 78 files: any constraint
// declared INSIDE a CREATE TABLE IF NOT EXISTS is applied only to databases where that table did not
// already exist. Every table that predates its current declaration may be missing any of them, and
// the only databases where the gap shows are real ones.
//
// WHY A SWEEP RATHER THAN FIXING OUTREACH AND MOVING ON. Each of these is discovered by restoring a
// 25MB production dump, watching the chain halt on the first one, fixing it, and asking the CEO to
// take another dump. One per round-trip, with him doing the work each time. This enumerates all of
// them so the next run reports every gap at once — and `--against` turns the enumeration into a
// finding against a database that actually exists.
//
// WHAT THIS DOES NOT DO. It does not add anything. Repairing a skipped constraint can require
// discarding real rows — see migrate-outreach.js, which refuses rather than choosing which duplicate
// outreach record survives — so each gap is a decision, reported here and made by a person.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = [path.join(ROOT, 'scripts'), path.join(ROOT, 'src')];

const argv = process.argv.slice(2);
const againstIdx = argv.indexOf('--against');
const AGAINST = againstIdx >= 0 ? argv[againstIdx + 1] : null;

let fail = 0;
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Balance parentheses from the table's opening paren. A regex cannot do this: the bodies contain
// nested parens in DEFAULT expressions, numeric types and partial-index predicates, and a greedy or
// lazy match gets a different wrong answer on each.
function tableBody(src, fromIndex) {
  let depth = 0;
  for (let i = fromIndex; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(fromIndex + 1, i);
    }
  }
  return null;
}

// These bodies are written inside JS template literals and are full of prose: `--` SQL comments and
// `//` JS comments explaining each column. Left in, the clause splitter reads that prose as SQL and
// invents constraints out of it — the first run of this sweep reported `UNIQUE (so)` and `UNIQUE (a)`,
// both of which came from the word before "UNIQUE" in an English sentence. A sweep that invents gaps
// is worse than no sweep, because every real finding then arrives alongside noise.
function stripComments(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

// Split a table body on top-level commas only — so UNIQUE (a, b) stays one clause.
function clauses(body) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const CREATE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s*(?=\()/gi;

function declarations() {
  const found = [];                       // { table, kind, columns, text, file }
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      let m;
      CREATE.lastIndex = 0;
      while ((m = CREATE.exec(src)) !== null) {
        const table = m[1];
        const open = src.indexOf('(', m.index + m[0].length - 1);
        const body = tableBody(src, open);
        if (!body) continue;
        for (const c of clauses(stripComments(body))) {
          // Table-level: UNIQUE (a, b) — and the named form, CONSTRAINT x UNIQUE (a, b), which the
          // first version of this parser excluded along with the prose it was trying to reject. It is
          // the same constraint and it is skipped the same way.
          const tu = c.match(/^(?:CONSTRAINT\s+["']?[a-zA-Z_][a-zA-Z0-9_]*["']?\s+)?UNIQUE\s*\(([^)]+)\)/i);
          if (tu) {
            found.push({ table, kind: 'unique', columns: tu[1].split(',').map((s) => s.trim().replace(/["']/g, '')),
              text: c, file: path.relative(ROOT, file) });
            continue;
          }
          // Table-level: CHECK (...)
          if (/^CHECK\s*\(/i.test(c)) {
            found.push({ table, kind: 'check', columns: [], text: c, file: path.relative(ROOT, file) });
            continue;
          }
          // Column-level: "<col> TEXT UNIQUE …" — a single-column unique, equally skipped. The type
          // token is REQUIRED: without it this matched any two words followed by "UNIQUE" anywhere,
          // which is how English prose became a constraint.
          const cu = c.match(/^["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s+(?:TEXT|VARCHAR|CHAR|INTEGER|INT|BIGINT|SMALLINT|SERIAL|BIGSERIAL|BOOLEAN|BOOL|NUMERIC|DECIMAL|REAL|DOUBLE|DATE|TIMESTAMP|TIMESTAMPTZ|TIME|JSON|JSONB|UUID|BYTEA|INET)\b[^,]*\bUNIQUE\b/i);
          if (cu && !/^(UNIQUE|CHECK|PRIMARY|FOREIGN|CONSTRAINT|LIKE|EXCLUDE)\b/i.test(c)) {
            found.push({ table, kind: 'unique', columns: [cu[1]], text: c, file: path.relative(ROOT, file) });
          }
        }
      }
    }
  }
  // The same constraint is declared in more than one place: the real schema module and the harness
  // stubs that mirror it. That is one constraint on one table, so it is reported once with every file
  // that declares it — a count inflated by its own test fixtures is a count nobody can act on.
  const byKey = new Map();
  for (const d of found) {
    const key = `${d.table}|${d.kind}|${d.columns.slice().sort().join(',')}`;
    if (byKey.has(key)) { byKey.get(key).files.push(d.file); continue; }
    byKey.set(key, { ...d, files: [d.file] });
  }

  // SOME OF THESE ARE SUPPOSED TO BE ABSENT, and missing that is how this sweep would repeat the very
  // defect it was written to find.
  //
  // migrate-outreach.js declares UNIQUE (entity_type, entity_id). migrate-outreach-partner-scope.js
  // then DROPS it on purpose, replacing it with a unique index on
  // (entity_type, entity_id, COALESCE(partner_id, 0)) so a partner and our own staff can each hold a
  // record for the same prospect — and it throws if the old one is still there. On production, where
  // partner scoping has been applied, that constraint is absent BY DESIGN.
  //
  // A sweep that called it a gap would be making exactly the mistake migrate-outreach.js's stale
  // verification made: asserting a schema shape that a later migration deliberately changed. So any
  // declared constraint whose conventional name is dropped elsewhere in the tree is marked superseded
  // and reported as such, never as missing.
  const dropped = new Set();
  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gi)) {
        dropped.add(m[1]);
      }
      // `ALTER TABLE x DROP CONSTRAINT ${name}` — the name comes from a variable, so the literal is
      // not in the source. Catch the lookup that produced it instead.
      for (const m of src.matchAll(/conname\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/gi)) dropped.add(m[1]);
      for (const m of src.matchAll(/indexname\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/gi)) dropped.add(m[1]);
    }
  }
  for (const d of byKey.values()) {
    // Postgres's own naming for a table-level UNIQUE: <table>_<col>_<col>_key.
    const conventional = `${d.table}_${d.columns.join('_')}_key`;
    if (dropped.has(conventional)) { d.superseded = conventional; }
  }
  return [...byKey.values()];
}

async function main() {
  h('CONSTRAINTS DECLARED INSIDE `CREATE TABLE IF NOT EXISTS` — SKIPPED ON ANY EXISTING TABLE');

  const decls = declarations();
  const uniques = decls.filter((d) => d.kind === 'unique');
  const checks = decls.filter((d) => d.kind === 'check');
  const tables = [...new Set(decls.map((d) => d.table))].sort();

  console.log(`\n  ${decls.length} constraint(s) declared inline across ${tables.length} table(s):`);
  console.log(`    ${uniques.length} UNIQUE · ${checks.length} CHECK`);
  console.log(`\n  Each is applied ONLY where the table did not already exist. On a database where it`);
  console.log(`  did — production — the constraint is absent and nothing reports it.`);

  if (!AGAINST) {
    h('UNIQUE CONSTRAINTS, BY TABLE');
    const byTable = {};
    for (const u of uniques) (byTable[u.table] ||= []).push(u);
    for (const t of Object.keys(byTable).sort()) {
      console.log(`\n  ${t}`);
      for (const u of byTable[t]) {
        const where = `${u.files[0]}${u.files.length > 1 ? ` (+${u.files.length - 1} more)` : ''}`;
        console.log(`      UNIQUE (${u.columns.join(', ')})          ${where}`);
        if (u.superseded) console.log(`          ↳ SUPERSEDED: ${u.superseded} is dropped by a later migration — absence here is correct`);
      }
    }
    console.log(`\n  This is the EXPOSURE, not a list of defects: it says nothing about which are actually`);
    console.log(`  missing anywhere. To find that out, run it against a restored copy of the database:\n`);
    console.log(`      node scripts/check-skipped-inline-constraints.js --against "$URL"\n`);
    console.log(`  scripts/verify-prod-dump.sh does this for you against a production dump.\n`);
    return;
  }

  // ── against a real database ────────────────────────────────────────────────────────────────────
  const { Client } = require('pg');
  const c = new Client({ connectionString: AGAINST });
  await c.connect();

  h('MEASURED AGAINST THE SUPPLIED DATABASE');
  const missing = []; const absentTables = []; const superseded = [];
  for (const u of uniques) {
    // Dropped on purpose by a later migration: its absence is the correct state, not a gap. Checking
    // for it would be the same stale-shape assertion that halted gate 2 on a correct database.
    if (u.superseded) { superseded.push(u); continue; }
    const exists = (await c.query(`SELECT to_regclass($1) IS NOT NULL AS t`, [`public.${u.table}`])).rows[0].t;
    if (!exists) { absentTables.push(u.table); continue; }
    // Any unique constraint OR unique index covering exactly this column set, in any order. A unique
    // index satisfies ON CONFLICT just as a constraint does, so matching only pg_constraint would
    // report a false gap on tables where the index was added by hand.
    const sets = (await c.query(
      `SELECT array_agg(a.attname::text ORDER BY a.attname) cols
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisunique
        GROUP BY i.indexrelid`, [`public.${u.table}`])).rows.map((r) => r.cols.slice().sort().join(','));
    const want = u.columns.slice().sort().join(',');
    if (!sets.includes(want)) missing.push(u);
  }

  if (superseded.length) {
    console.log(`\n  ${superseded.length} declared constraint(s) are dropped on purpose by a later migration.`);
    console.log(`  Their absence is correct and is NOT checked for:`);
    for (const u of superseded) {
      console.log(`      ${u.table} UNIQUE (${u.columns.join(', ')}) — superseded, ${u.superseded} is dropped`);
    }
  }

  if (absentTables.length) {
    console.log(`\n  ${[...new Set(absentTables)].length} declared table(s) do not exist here yet — the migration`);
    console.log(`  creates them, so their inline constraints WILL be applied. Not a gap:`);
    console.log(`      ${[...new Set(absentTables)].sort().join(', ')}`);
  }

  if (!missing.length) {
    console.log(`\n  ok    every inline UNIQUE declared for a table that exists here is present.`);
    console.log(`        No skipped constraint to repair.\n`);
  } else {
    fail = 1;
    console.log(`\n  ${missing.length} UNIQUE constraint(s) are DECLARED but MISSING on an existing table.`);
    console.log(`  These are the ones that will halt a migration, or break an ON CONFLICT upsert at runtime:\n`);
    for (const u of missing) {
      const n = (await c.query(`SELECT COUNT(*)::int n FROM ${u.table}`)).rows[0].n;
      let dupes = [];
      try {
        const cols = u.columns.map((x) => `"${x}"`).join(', ');
        dupes = (await c.query(
          `SELECT ${cols}, COUNT(*)::int n FROM ${u.table}
            GROUP BY ${cols} HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 5`)).rows;
      } catch { /* a column named in the declaration may not exist here either */ }
      console.log(`    ${u.table} — UNIQUE (${u.columns.join(', ')})`);
      console.log(`        ${n} row(s) in the table · declared in ${u.files.join(', ')}`);
      if (dupes.length) {
        console.log(`        ⚠ ${dupes.length}+ duplicate group(s) — the constraint CANNOT be added until`);
        console.log(`          somebody decides which row survives in each. Example: ` +
          `${JSON.stringify(dupes[0])}`);
      } else {
        console.log(`        no duplicate values — the constraint can be added safely with ALTER TABLE`);
      }
    }
    console.log('');
  }

  await c.end();
}

main().then(() => {
  if (fail) {
    console.log('FAIL  at least one declared constraint is missing from this database.\n');
    process.exit(1);
  }
}).catch((e) => {
  console.error(`\nFAIL  check-skipped-inline-constraints: ${e.message}\n`);
  process.exit(1);
});
