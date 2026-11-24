#!/usr/bin/env node
// ── EVERY JAVASCRIPT FILE IN THIS REPOSITORY PARSES ─────────────────────────
//
//   node scripts/check-scripts-parse.js    exit 0 = every file parses
//
// ── WHY THIS EXISTS, MEASURED 2026-11-24 ────────────────────────────────────
//
// A comment was added inside a template literal in scripts/validate-k2-deployed.js. The comment
// contained a word in backticks. A backtick inside a template literal ENDS it, so the file became
// `SyntaxError: missing ) after argument list` — the whole script, unloadable.
//
// Nothing caught it on its own. It surfaced only because check-k1-validator-runs.js happens to
// EXECUTE that validator against a disposable cluster, and that driver exists for unrelated
// reasons. The scripts it does not drive include the ones whose first execution is a single run
// against production over SSH — validate-r1-deployed.js, validate-k5-budget-deployed.js,
// office-pre-release-report.js. For those, a syntax error is discovered at the worst possible
// moment, reads exactly like a broken deploy, and costs a debugging round (the same shape as the
// `railway ssh` missing-`--service` incident recorded in CLAUDE.md).
//
// `node --check` is milliseconds per file and finds every one of these. What it CANNOT find is an
// undefined reference — that is the `after is not defined` class, and the answer to those is a
// driver that executes the file, which is why those drivers still exist. This is the cheap floor
// underneath them, not a replacement.
//
// It reads files and parses them. It opens no database, makes no network call and writes nothing.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const ROOTS = ['scripts', 'src', 'tools'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'tmp', '.cache']);

let checked = 0;
const broken = [];

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      continue;
    }
    if (!e.isFile() || !/\.(js|cjs|mjs)$/.test(e.name)) continue;
    const file = path.join(dir, e.name);
    try {
      // --check parses without executing: no side effect, no require of its dependencies.
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      checked += 1;
    } catch (err) {
      const why = String(err.stderr || err.message).split('\n')
        .filter((l) => /SyntaxError|\^|^\s*\d+ \|/.test(l)).slice(0, 3).join(' | ');
      broken.push({ file: path.relative(REPO, file), why: why || 'did not parse' });
    }
  }
}

for (const root of ROOTS) walk(path.join(REPO, root));

// server.js and the other entry points at the repository root.
for (const name of fs.readdirSync(REPO)) {
  if (!/\.(js|cjs|mjs)$/.test(name)) continue;
  const file = path.join(REPO, name);
  if (!fs.statSync(file).isFile()) continue;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    checked += 1;
  } catch (err) {
    broken.push({ file: name, why: String(err.stderr || err.message).split('\n')[2] || 'did not parse' });
  }
}

console.log(`  ..    parsed ${checked} JavaScript file(s) across ${ROOTS.join(', ')} and the repo root`);

if (!checked) {
  // A sweep that found nothing to sweep is not a passing sweep.
  console.log('\nFAIL  no files were parsed at all — this check measured nothing.');
  process.exit(1);
}

// ── THE NEGATIVE CONTROL ────────────────────────────────────────────────────
//
// "A green check that cannot be shown to fail is not safety evidence." If `node --check` were
// invoked wrongly — a bad flag, stderr swallowed, a non-zero exit not raising — this sweep would
// report PASS over 835 files while parsing none of them. So it plants the exact defect that
// motivated it, in a temporary directory outside the repository, and asserts that it is caught.
{
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-control-'));
  const planted = path.join(tmp, 'planted.js');
  // A backtick inside a template literal: the 2026-11-24 defect, reproduced.
  fs.writeFileSync(planted, 'const a = `a comment about `backticks` here`;\n');
  let caught = false;
  try {
    execFileSync(process.execPath, ['--check', planted], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (_) { caught = true; }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!caught) {
    console.log('\nFAIL  negative control: a planted unparseable file was NOT detected, so this');
    console.log('      sweep\'s silence over the repository means nothing.');
    process.exit(1);
  }
  console.log('  ok    negative control: a planted backtick-in-template-literal IS detected');
}

if (broken.length) {
  console.log(`\nFAIL  ${broken.length} file(s) do not parse:\n`);
  for (const b of broken) console.log(`  ${b.file}\n      ${b.why}`);
  console.log('\nA file that does not parse is not a failing test — it is a file that cannot run at');
  console.log('all, and for a production-only validator that is discovered in production.');
  process.exit(1);
}

console.log('\nPASS  every JavaScript file in the repository parses.');
process.exit(0);
