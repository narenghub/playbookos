#!/usr/bin/env node
/*
 * check-date-formatting.js — refuse the date bug a fifth time.
 *
 * node-postgres returns DATE and TIMESTAMPTZ columns as JavaScript Date objects. So:
 *
 *   String(new Date('2026-11-21')).slice(0, 10)   === 'Sat Nov 21'
 *   `${new Date('2026-01-01')}`.slice(0, 10)      === 'Thu Jan 01'
 *
 * That string is wrong to display AND wrong to compare: 'Sat Nov 21' > '2026-11-06' is true,
 * because 'S' > '2'. The failures it has caused in this repo, each found after shipping:
 *
 *   1. the qualification engine told every opportunity it needed a SAM renewal
 *   2. the deadline-passed check never fired
 *   3. the capability gap report called an expired capability COVERED
 *   4. the opportunity CSV export shipped "Thu Nov 05" as a Posted Date to the owner
 *   5. the tracker demo printed "deadline Sat Nov 07", and contract-render.js put the same
 *      malformed date into the payment schedule of a generated CONTRACT
 *
 * Four of those were fixed one at a time, which is why there was a fifth. src/lib/office/iso-day.js
 * exists so there is one correct implementation; this script is what makes using it non-optional.
 *
 *   node scripts/check-date-formatting.js       # exit 0 = clean, 1 = at least one raw format
 *
 * Exit status is the verdict. The listing is diagnostics.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const SEARCH_DIRS = ['src', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'public', 'coverage', 'evidence', 'fixtures']);

// A date-ish identifier: the names this codebase actually uses for date columns. Deliberately
// narrow — this check must not fire on String(someText).slice(0, 10), which is a legitimate truncation.
const DATEISH = '(?:[A-Za-z_$][\\w$]*\\.)*(?:[a-z_]*(?:date|deadline|_at|_on|posted|expires|due|day|timestamp|modified|created|sent|archive)[\\w$]*)';

const PATTERNS = [
  // String(x.due_date).slice(0, 10)
  { re: new RegExp(`String\\(\\s*${DATEISH}\\s*[^)]*\\)\\s*\\.slice\\(\\s*0\\s*,\\s*(?:10|7|4)\\s*\\)`, 'i'),
    why: 'String(<date>).slice(...) — use isoDay() from src/lib/office/iso-day.js' },
  // `${x.due_date}`.slice(0, 10)
  { re: new RegExp('`\\$\\{\\s*' + DATEISH + '\\s*\\}`\\s*\\.slice\\(\\s*0\\s*,\\s*(?:10|7|4)\\s*\\)', 'i'),
    why: 'template-literal coercion of a date then .slice(...) — use isoDay()' },
  // x.due_date + '' then slice
  { re: new RegExp(`${DATEISH}\\s*\\+\\s*['"]['"]\\s*\\)?\\s*\\.slice\\(\\s*0\\s*,\\s*(?:10|7|4)\\s*\\)`, 'i'),
    why: 'date + "" then .slice(...) — use isoDay()' },
];

// iso-day.js is the correct implementation and necessarily contains the wrong form in its comments
// and in the tests that prove it. Same for this file, which documents the bug it forbids.
const EXEMPT = new Set([
  path.join('src', 'lib', 'office', 'iso-day.js'),
  path.join('scripts', 'check-date-formatting.js'),
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = SEARCH_DIRS
  .map((d) => path.join(repo, d))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d));

const findings = [];
for (const abs of files) {
  const rel = path.relative(repo, abs);
  if (EXEMPT.has(rel)) continue;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // A line that is only a comment is documentation, not behaviour.
    const code = line.replace(/\/\/.*$/, '');
    if (!code.trim() || /^\s*\*/.test(line)) return;
    for (const { re, why } of PATTERNS) {
      if (re.test(code)) { findings.push({ rel, line: i + 1, text: line.trim().slice(0, 118), why }); break; }
    }
  });
}

process.stdout.write(`\ncheck-date-formatting — scanned ${files.length} file(s) under ${SEARCH_DIRS.join(', ')}\n\n`);

if (!findings.length) {
  process.stdout.write('PASS  no raw date coercion found. Dates go through isoDay().\n\n');
  process.exit(0);
}

for (const f of findings) {
  process.stdout.write(`  ${f.rel}:${f.line}\n      ${f.text}\n      → ${f.why}\n\n`);
}
process.stdout.write(`FAIL  ${findings.length} raw date format(s). `
  + 'String(<a pg Date>).slice(0, 10) yields "Sat Nov 21", which displays wrongly and compares\n'
  + '      wrongly against an ISO day. Use isoDay() from src/lib/office/iso-day.js.\n\n');
process.exit(1);
