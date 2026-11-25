#!/usr/bin/env node
// ── OPEN BLOCKERS AND UNSATISFIED PREREQUISITES ON A PRODUCTION RELEASE ─────
//
//   node scripts/check-release-blockers.js              → REPORTS. exit 0. part of preflight.
//   node scripts/check-release-blockers.js --releasing   → FAILS while anything is open.
//
// The two modes exist because preflight is a PUSH gate and this is a RELEASE gate. Making an open
// blocker fail preflight would deadlock the feature branch on work that is not part of the branch;
// making it never fail would make it a comment. So it reports on every push and refuses on a
// release, and the refusal lives in whatever command actually ships.
//
// ── WHY THIS GATE GREW A SECOND HALF (Decision 5, 2026-11-25) ──────────────
//
// Owner instruction: "Correct B7.17 and B6.9 to explicitly include B7.18, B7.22, B7.24 and every
// other applicable restoration prerequisite. ENFORCE THOSE DEPENDENCIES IN THE RELEASE GATE, NOT
// ONLY IN DOCUMENTATION."
//
// Until now the prerequisites lived in prose — the master tracker and B6.9's own row — and this
// gate knew nothing about them. A release could pass it with B7.18 untouched, and the only thing
// in the way would have been somebody remembering. That is B6.1's own rule turned on this file:
// "a prerequisite that the gate does not check is not closed, it is unmeasured."
//
// ── HOW A PREREQUISITE IS SATISFIED, AND WHY SILENCE IS NOT ────────────────
//
// Each entry must say how it is verified:
//
//   verified_by.checker      a script that EXISTS on disk and is WIRED INTO preflight. Both are
//                            asserted: a checker nobody runs is documentation with a filename.
//   verified_by.attestation  { actor, date, scope } — for a condition no script can observe, such
//                            as a restore performed against production.
//   verified_by: null        UNMEASURED, and it BLOCKS.
//
// A `partial` note on a checker also blocks, and says so. That is the dangerous case: a tripwire
// which holds while the migration it guards is undone looks like coverage.
//
// This gate deliberately does NOT run the checkers. Most need a database, and a release gate that
// tries to stand up Postgres fails for infrastructure reasons and gets waived. It asserts they
// exist and are wired into the suite that does run them — the part that can silently stop being
// true.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'docs', 'security', 'release-blockers.json');
const PREFLIGHT = path.join(ROOT, 'scripts', 'preflight.sh');
const RELEASING = process.argv.includes('--releasing');

let doc;
try { doc = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  console.error(`FAIL  cannot read ${path.relative(ROOT, FILE)}: ${e.message}`);
  console.error('      A missing registry is not an empty registry.');
  process.exit(1);
}

let preflightText = '';
try { preflightText = fs.readFileSync(PREFLIGHT, 'utf8'); } catch (e) {
  console.error(`FAIL  cannot read scripts/preflight.sh: ${e.message}`);
  console.error('      Without it, "is this checker actually run" is unanswerable, and an');
  console.error('      unanswerable question is not a satisfied prerequisite.');
  process.exit(1);
}

/** Why this prerequisite is not satisfied, or null if it is. */
function unsatisfied(item) {
  const v = item.verified_by;
  if (!v) {
    return item.only_satisfiable_by
      ? `UNMEASURED — ${item.only_satisfiable_by}`
      : 'UNMEASURED — no checker and no attestation';
  }
  if (v.checker) {
    const abs = path.join(ROOT, v.checker);
    if (!fs.existsSync(abs)) return `names ${v.checker}, which does not exist`;
    if (!preflightText.includes(path.basename(v.checker))) {
      return `names ${v.checker}, which exists but is NOT wired into preflight — a checker nobody `
        + 'runs is documentation with a filename';
    }
    if (v.partial) return `PARTIAL — ${v.partial}`;
    return null;
  }
  if (v.attestation) {
    const a = v.attestation;
    const missing = ['actor', 'date', 'scope'].filter((k) => !a[k]);
    if (missing.length) return `attested without ${missing.join(', ')}`;
    return null;
  }
  return 'verified_by names neither a checker nor an attestation';
}

const open = (doc.blockers || []).filter((b) => b.status === 'open');

const groups = [
  ['communication release', doc.communication_release_prerequisites],
  ['restoration', doc.restoration_prerequisites],
];

let unsatisfiedTotal = 0;
const report = [];
for (const [label, group] of groups) {
  if (!group || !Array.isArray(group.items)) {
    // A missing GROUP is the dangerous shape: the gate would pass by having nothing to check.
    report.push({ label, fatal: `the ${label} prerequisite list is missing from the registry — `
      + 'an absent list is not an empty one' });
    unsatisfiedTotal += 1;
    continue;
  }
  const rows = group.items.map((i) => ({ id: i.id, title: i.title, why: unsatisfied(i) }));
  unsatisfiedTotal += rows.filter((r) => r.why).length;
  report.push({ label, rows });
}

for (const b of open) {
  console.log(`  ${RELEASING ? 'BLOCKER' : 'NOTE'}  ${b.id} — ${b.title}`);
  console.log(`          raised by ${b.raised_by}, opened ${b.opened}`);
  if (b.design_verified) console.log(`          design verified: ${b.design_verified}`);
  if (b.ticket) console.log(`          ${b.ticket}`);
}

for (const g of report) {
  console.log(`\n  -- ${g.label} prerequisites --`);
  if (g.fatal) { console.log(`  ${RELEASING ? 'BLOCKER' : 'NOTE'}  ${g.fatal}`); continue; }
  for (const r of g.rows) {
    if (!r.why) console.log(`  ok       ${r.id} — ${r.title}`);
    else console.log(`  ${RELEASING ? 'BLOCKER' : 'NOTE'}  ${r.id} — ${r.title}\n           ${r.why}`);
  }
}

const total = open.length + unsatisfiedTotal;
if (!total) {
  console.log('\nPASS  no open production release blockers and every prerequisite is satisfied');
  process.exit(0);
}
if (RELEASING) {
  console.error(`\nFAIL  ${open.length} open blocker(s) and ${unsatisfiedTotal} unsatisfied `
    + 'prerequisite(s). A production release is not authorized.');
  console.error('      A prerequisite the gate does not check is not closed, it is unmeasured.');
  process.exit(1);
}
console.log(`\nPASS  ${open.length} open blocker(s) and ${unsatisfiedTotal} unsatisfied `
  + 'prerequisite(s) reported — this is a push gate, not a release gate');
process.exit(0);
