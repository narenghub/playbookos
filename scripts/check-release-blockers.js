#!/usr/bin/env node
// ── OPEN BLOCKERS ON A PRODUCTION RELEASE ────────────────────────────────────
//
//   node scripts/check-release-blockers.js              → REPORTS. exit 0. part of preflight.
//   node scripts/check-release-blockers.js --releasing   → FAILS while any blocker is open.
//
// The two modes exist because preflight is a PUSH gate and this is a RELEASE gate. Making an open
// blocker fail preflight would deadlock the feature branch on work that is not part of the branch;
// making it never fail would make it a comment. So it reports on every push and refuses on a
// release, and the refusal lives in whatever command actually ships.
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'docs', 'security', 'release-blockers.json');
const RELEASING = process.argv.includes('--releasing');

let doc;
try { doc = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  console.error(`FAIL  cannot read ${path.relative(path.join(__dirname, '..'), FILE)}: ${e.message}`);
  console.error('      A missing registry is not an empty registry.');
  process.exit(1);
}
const open = (doc.blockers || []).filter((b) => b.status === 'open');

if (!open.length) {
  console.log('PASS  no open production release blockers');
  process.exit(0);
}
for (const b of open) {
  console.log(`  ${RELEASING ? 'BLOCKER' : 'NOTE'}  ${b.id} — ${b.title}`);
  console.log(`          raised by ${b.raised_by}, opened ${b.opened}`);
  if (b.design_verified) console.log(`          design verified: ${b.design_verified}`);
  if (b.ticket) console.log(`          ${b.ticket}`);
}
if (RELEASING) {
  console.error(`\nFAIL  ${open.length} open blocker(s). A production release is not authorized.`);
  process.exit(1);
}
console.log(`PASS  ${open.length} open release blocker(s) reported — this is a push gate, not a release gate`);
