// ── THE OUTER ORDER BY CAN ONLY NAME COLUMNS THE SUBQUERY PROJECTS ────────────
//
// `node scripts/lookup-cphi-roles.js --role qc_lab --region eu --execute` failed in production with
//
//   role lookup failed: column "name" does not exist
//
// The dedupe wrapped the scope in `SELECT * FROM (SELECT DISTINCT ON (name_normalized) name AS holder,
// … ) d ORDER BY … name`. Inside the subquery the column is `name`; outside it, it is `holder`. The
// outer ORDER BY — built by labLookupOrderSql(), which refers to `name` and `contact_email` — named a
// column that no longer existed at that level, and Postgres refused the whole statement.
//
// The guard that existed asserted the SQL CONTAINED "DISTINCT ON (name_normalized)" and that the inner
// ORDER BY led with the right key. Both were true. Neither could notice that the two halves disagreed
// about a column name, because a string match cannot resolve a name — and the most valuable list of
// the show did not run.
//
// So this parses the three scope queries out of the script and checks the outer ORDER BY against what
// the inner SELECT actually projects. No database: the failure was a NAME RESOLUTION error, which is
// decidable from the text once the text is read as structure instead of searched as a string.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'scripts/lookup-cphi-roles.js'), 'utf8');

// The ordering helper is interpolated as `${labLookupOrderSql()}`, so its text has to come from the
// module rather than from the script.
const { labLookupOrderSql } = require('../labconnect/lab-shape');

/** Split a SELECT list on top-level commas — parens hold function calls and CASE/OR groups. */
function splitTopLevel(list) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

/** The names a SELECT list makes available to an enclosing query. */
function projectedNames(list) {
  const names = new Set();
  for (let item of splitTopLevel(list)) {
    item = item.replace(/^DISTINCT ON\s*\([^)]*\)\s*/i, '').trim();
    if (!item) continue;
    const alias = /\sAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(item);
    if (alias) { names.add(alias[1].toLowerCase()); continue; }
    // A bare column keeps its own name. Anything else (an expression with no alias) is not
    // addressable by name and is deliberately not added.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) names.add(item.toLowerCase());
  }
  return names;
}

/** Bare identifiers an ORDER BY clause refers to, ignoring SQL keywords and string literals. */
const SQL_WORDS = new Set([
  'asc', 'desc', 'nulls', 'first', 'last', 'like', 'ilike', 'is', 'not', 'null', 'and', 'or',
  'upper', 'lower', 'length', 'btrim', 'case', 'when', 'then', 'else', 'end', 'true', 'false',
  // Added 2026-10-10 with COALESCE(region, '') in labRankTerms. A function name is not a column
  // reference; without this the check reports "coalesce is not projected", which is noise that
  // would pressure the next person into removing the COALESCE — and the COALESCE is there because
  // NULL LIKE 'eu%' is NULL and DESC sorts NULLs first.
  'coalesce',
]);
function referencedNames(order) {
  const stripped = order.replace(/'[^']*'/g, "''");
  const ids = stripped.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  return [...new Set(ids.map(s => s.toLowerCase()).filter(s => !SQL_WORDS.has(s)))];
}

/**
 * Every `SELECT * FROM ( SELECT … ) alias ORDER BY …` in the script, with the inner list and the
 * outer ordering, so each can be checked independently.
 */
function dedupeQueries() {
  const found = [];
  const re = /SELECT \* FROM \(\s*([\s\S]*?)\n\s*\) \w+\s*\n\s*ORDER BY ([^\n]*)/g;
  let m;
  while ((m = re.exec(SRC))) {
    const innerSelect = m[1];
    const sel = /SELECT\s+([\s\S]*?)\n\s*FROM /i.exec(innerSelect);
    if (!sel) continue;
    found.push({ list: sel[1], order: m[2] });
  }
  return found;
}

test('the script still wraps its scopes in a dedupe subquery', () => {
  // If this drops to zero the test below passes vacuously, which is how a guard quietly stops guarding.
  assert.equal(dedupeQueries().length, 3,
    'expected three deduped scopes: labs, platform partners, buyers');
});

test('no outer ORDER BY names a column the subquery does not project', () => {
  for (const { list, order } of dedupeQueries()) {
    // The ordering is interpolated for the lab scope, so substitute the real text before resolving.
    const resolved = order.replace('${labLookupOrderSql()}', labLookupOrderSql());
    const available = projectedNames(list);
    for (const ref of referencedNames(resolved)) {
      assert.ok(available.has(ref),
        `ORDER BY refers to "${ref}", which the subquery does not project.\n`
        + `  projected: ${[...available].join(', ')}\n`
        + `  ORDER BY:  ${resolved.trim()}`);
    }
  }
});

test('the lab scope projects `name` unaliased, which is what its ordering refers to', () => {
  // The specific regression: `name AS holder` inside the subquery with `name` in the outer ORDER BY.
  const labs = dedupeQueries().find(q => /name_normalized/.test(q.list) && /notes/.test(q.list));
  assert.ok(labs, 'the lab scope was not found');
  assert.ok(!/\bname AS holder\b/i.test(labs.list),
    'aliasing name to holder inside the subquery is what broke the outer ORDER BY');
  assert.ok(projectedNames(labs.list).has('name'));
});

test('a resumed run skips only what was actually written', () => {
  // A row whose lookup errored is never written, so a resume must retry it. If errors were recorded,
  // one network outage would turn into a permanent hole in the list that no re-run could fill.
  assert.match(SRC, /EXECUTE && !err/, 'an errored lookup must not be written');
  assert.match(SRC, /NOT EXISTS \(SELECT 1 FROM cphi_exhibitor_matches/);
  // And resume has to be the default, or working through a long list by re-running re-checks the same
  // first page every time and never reaches the end of it.
  assert.match(SRC, /const RESUME = !argv\.includes\('--no-resume'\)/);
});

test('the default limit fits inside one ssh session', () => {
  // 400 dropped the connection at row 89 with "closed by remote host". The point of the smaller
  // default is that a run completes; resume is what makes several runs add up to the whole list.
  const m = /const LIMIT = num\('--limit', EXECUTE \? (\d+)/.exec(SRC);
  assert.ok(m, 'the default limit could not be read');
  assert.ok(Number(m[1]) <= 150, `default limit ${m[1]} is too large for one ssh session`);
});
