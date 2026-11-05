#!/usr/bin/env node
// ── R2: THE SEARCH RULE MAY NOT REACH A COMMERCIAL PATH ──────────────────────
//
//   scripts/check-search-rule-scope.js  → exit 0 = no file outside the declared allowlist
//                                         imports a search-only molecule function
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// src/lib/molecules/synonyms.js de-salts names deliberately, for search, and documents the limit
// itself: stripping `testosterone enanthate` to `testosterone` is "correct for FINDING a supplier
// and wrong for ordering one". That scoping rule is right. Until now it was enforced only by
// whoever read the file.
//
// The ruling that produced the molecule-identity remediation put it plainly: a prohibition in a
// brief is not a control in a build. This is the control.
//
// ── DEFAULT DENY ────────────────────────────────────────────────────────────
//
// Every file is forbidden unless src/lib/molecules/search-scope.js lists it with a reason. A new
// PRPA matcher is therefore forbidden the moment somebody creates it, by doing nothing — which is
// the point, because the module most likely to be left off a blocklist is the one just written.
//
// ── WHAT THIS CHECK CANNOT DO, STATED RATHER THAN ASSUMED ───────────────────
//
// It is STATIC, and weaker than the engine-side guards in the connector schema for the same reason
// scripts/check-office-scope-discipline.js is weaker than a composite foreign key. Specifically:
//
//   • It can be defeated by a dynamic require, a re-export, or a wrapper module that is itself on
//     the allowlist. It greps; it does not trace a call graph.
//   • It protects THIS REPOSITORY. Another service, or a psql session, is outside its reach.
//   • routes.js is allowlisted because it hosts the search endpoints, so a pricing handler added
//     inline there would sit inside the exemption. search-scope.js records that as a residual risk
//     with the remedy (extract the search handlers), rather than pretending the gap is closed.
//
// A guard that is described as stronger than it is, is worse than a weak guard, because the next
// person stops looking.
'use strict';

const fs = require('fs');
const path = require('path');

const {
  SEARCH_ONLY_FUNCTIONS, SEARCH_MODULE, SEARCH_CALLER_ALLOWLIST, isAllowedCaller,
} = require('../src/lib/molecules/search-scope');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'test-fixtures', 'dist']);

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 500)}`); };

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// A require of the search module, in either destructuring or whole-module form. Comments are
// stripped first so the many files that MENTION canonicalMolecule in prose — migrate-molecules.js
// explains why it must never be the merge rule — are not reported as callers. Naming the hazard is
// not importing it.
// Matches a relative require of the synonyms module in any of its spellings: './synonyms',
// '../molecules/synonyms', '../../src/lib/molecules/synonyms.js'. The first version required the
// literal segment 'molecules/synonyms' and so missed './synonyms' entirely — which the negative
// control caught on its first run, as it is there to.
const REQUIRE_RE = /require\(\s*['"][^'"]*?\/synonyms(?:\.js)?['"]\s*\)/;

// A line that is itself a comment. Many files MENTION these functions in prose —
// scripts/migrate-molecules.js explains at length why canonicalMolecule must never be the merge
// rule — and naming a hazard is not importing it.
//
// WHY LINE-BY-LINE AND NOT A REGEX COMMENT STRIPPER. The first version stripped /* ... */ across
// the whole file before scanning. On src/api/routes.js that deleted a large region containing the
// real import at line 5211, so the check reported ZERO callers and then flagged the routes.js
// allowlist entry as stale. Both failures were one bug, and it was a FALSE NEGATIVE — the
// direction I had written off in a comment as not worth worrying about. A 5,000-line file contains
// `/*` inside strings and regexes, and a non-greedy block match then spans to the next `*/`
// wherever that happens to be. Nothing about that is visible in a passing report.
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * Which search-only functions does this source pull in?
 * Returns [] when the file does not require the search module at all.
 */
function searchFunctionsImported(src) {
  const hits = new Set();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;
    if (!REQUIRE_RE.test(line)) continue;

    // The destructuring pattern usually sits on the same line; allow a short lookbehind for the
    // multi-line form `const {\n  expandMolecule,\n} = require(...)`, skipping comment lines in
    // the window for the same reason as above.
    const window = lines.slice(Math.max(0, i - 8), i + 1)
      .filter((l) => !COMMENT_LINE.test(l)).join('\n');
    for (const fn of SEARCH_ONLY_FUNCTIONS) {
      if (new RegExp(`\\b${fn}\\b`).test(window)) hits.add(fn);
    }

    // Whole-module import: `const syn = require('.../synonyms')`. Any later `syn.expandMolecule`
    // is then reachable, so the import itself is the finding.
    const whole = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/);
    if (whole && !/[{}]/.test(line.slice(0, line.indexOf('=')))) {
      const alias = whole[1];
      const body = lines.filter((l) => !COMMENT_LINE.test(l)).join('\n');
      for (const fn of SEARCH_ONLY_FUNCTIONS) {
        if (new RegExp(`\\b${alias}\\.${fn}\\b`).test(body)) hits.add(fn);
      }
    }
  }
  return [...hits];
}

function run() {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

  const callers = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const fns = searchFunctionsImported(src);
    if (fns.length) callers.push({ file: rel(f), fns });
  }

  console.log(`  scanned ${files.length} files under ${SCAN_DIRS.join('/, ')}/ for imports of ${SEARCH_MODULE}`);

  const violations = [];
  for (const c of callers) {
    const verdict = isAllowedCaller(c.file);
    if (verdict.allowed) {
      console.log(`  ok    ${c.file} imports ${c.fns.join(', ')} — allowlisted`);
    } else {
      violations.push(c);
    }
  }

  if (violations.length) {
    for (const v of violations) {
      bad(`${v.file} imports search-only function(s): ${v.fns.join(', ')}`,
        'These de-salt names and fold synonyms. They are correct for FINDING a supplier and wrong '
        + 'for ordering one. Use commercialMatch() from src/lib/molecules/commercial-match.js, which '
        + 'preserves base/salt/ester/hydrate/solvate distinctions and fails closed with a reason. '
        + 'If this file really is a search surface, declare it in src/lib/molecules/search-scope.js '
        + 'with the reason.');
    }
  } else {
    ok(`no file outside the allowlist imports a search-only function (${callers.length} allowlisted caller(s))`);
  }

  // The allowlist must not rot. An entry naming a file that no longer exists, or that no longer
  // imports anything, is an exemption nobody is watching — and an exemption outliving its reason is
  // how a guard quietly stops guarding.
  const importing = new Set(callers.map((c) => c.file));
  const stale = Object.keys(SEARCH_CALLER_ALLOWLIST).filter((p) => {
    if (!fs.existsSync(path.join(ROOT, p))) return true;
    return !importing.has(p);
  });
  if (stale.length) {
    bad(`allowlist entries that no longer import anything (remove them): ${stale.join(', ')}`,
      'an exemption that outlives its reason is how a guard stops guarding without failing');
  } else {
    ok('every allowlist entry still exists and still imports — no stale exemptions');
  }

  // Every allowlist entry carries a reason. An exemption with no stated reason cannot be reviewed.
  const unreasoned = Object.entries(SEARCH_CALLER_ALLOWLIST)
    .filter(([, r]) => !r || String(r).trim().length < 20).map(([p]) => p);
  if (unreasoned.length) bad(`allowlist entries with no usable reason: ${unreasoned.join(', ')}`);
  else ok('every allowlist entry states why it is legitimate');

  return fail;
}

// ── THE NEGATIVE CONTROL ────────────────────────────────────────────────────
//
// Rule 8: a refusal test must prove WHICH control refused. And the repo's own words on the
// run-ledger checks: "A guard that is never shown to be load-bearing has not been verified."
//
// So the check runs itself against a file it plants in a NON-allowlisted location, asserts it is
// caught by name, and removes it in a finally. Without this, a check that scanned the wrong
// directory or whose regex never matched anything would pass with a clean report — which is the
// false green this repository has already shipped twice.
function negativeControl() {
  const planted = path.join(ROOT, 'src', 'lib', 'molecules', '__scope_negative_control.js');
  let caught = false;
  let detectedFns = [];
  try {
    fs.writeFileSync(planted,
      "'use strict';\n"
      + "// Planted by scripts/check-search-rule-scope.js. Deleted in a finally. If this file is\n"
      + "// still here, the check crashed between planting and cleanup — delete it.\n"
      + "const { expandMolecule, moleculeBase } = require('./synonyms');\n"
      + 'module.exports = { expandMolecule, moleculeBase };\n');
    const src = fs.readFileSync(planted, 'utf8');
    detectedFns = searchFunctionsImported(src);
    const verdict = isAllowedCaller('src/lib/molecules/__scope_negative_control.js');
    caught = detectedFns.length > 0 && !verdict.allowed;
  } finally {
    try { fs.unlinkSync(planted); } catch (_) { /* nothing to remove */ }
  }

  if (caught && detectedFns.includes('expandMolecule') && detectedFns.includes('moleculeBase')) {
    ok(`negative control: a planted import in a non-allowlisted file IS detected (${detectedFns.join(', ')}) and refused`);
  } else {
    bad('negative control: the guard must catch a planted import',
      detectedFns.length
        ? `detected ${detectedFns.join(', ')} but the path was treated as allowed`
        : 'detected nothing — the detector does not work, so a clean report means nothing');
  }

  // And the mirror: the SAME import inside an allowlisted file must NOT be reported, or the guard
  // is just a ban and the allowlist is decoration.
  //
  // The path is TAKEN FROM THE ALLOWLIST rather than hardcoded. It used to name src/api/routes.js,
  // and when that exemption was correctly narrowed away this control failed — not because the guard
  // broke, but because the control had a stale fixture. A control that has to be edited whenever the
  // thing it checks changes legitimately will eventually be edited the lazy way.
  const allowlisted = Object.keys(SEARCH_CALLER_ALLOWLIST);
  if (!allowlisted.length) {
    bad('negative control: the allowlist is empty', 'nothing to test the allowlist path against — '
      + 'this control would pass vacuously');
  } else {
    const inAllowlisted = isAllowedCaller(allowlisted[0]);
    if (inAllowlisted.allowed) {
      ok(`negative control: the same import inside an allowlisted file is permitted (${allowlisted[0]})`);
    } else {
      bad('negative control: an allowlisted file must be permitted', 'the allowlist is not consulted');
    }
  }

  // REGRESSION TEST FOR RULING 6 ITEM 6. routes.js must NOT be allowlisted. The exemption was
  // granted to a ~6,000-line file holding pricing, RFQ, order and approval handlers beside the
  // search ones, which exempted all of them; it now belongs to src/lib/molecules/search-query.js,
  // which does one job. If routes.js ever reappears on the list, the narrowing has been undone and
  // an inline expandMolecule() next to a price becomes invisible again.
  const routesDenied = isAllowedCaller('src/api/routes.js');
  if (!routesDenied.allowed) {
    ok('REGRESSION: src/api/routes.js is NOT allowlisted — the exemption belongs to the boundary module');
  } else {
    bad('src/api/routes.js is allowlisted again',
      'the item 6 narrowing has been undone: a pricing handler in routes.js could import the '
      + 'search rule and this guard would permit it');
  }
  // And the boundary module must actually hold the exemption, or the narrowing moved it nowhere.
  const boundary = isAllowedCaller('src/lib/molecules/search-query.js');
  if (boundary.allowed) ok('REGRESSION: the boundary module src/lib/molecules/search-query.js holds the exemption');
  else bad('the boundary module is not allowlisted', 'the search endpoints cannot work');

  // A planted file must leave nothing behind.
  if (!fs.existsSync(planted)) ok('negative control: the planted file was removed');
  else bad('negative control cleanup', `${planted} still exists`);
}

negativeControl();
run();

console.log('');
if (fail) {
  console.log(`FAIL  ${fail} search-rule scope violation(s)`);
  process.exit(1);
}
console.log('PASS  the search rule is confined to declared search surfaces, and the guard was shown to catch a violation');
process.exit(0);
