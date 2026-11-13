#!/usr/bin/env node
// ── PRINT THE EXACT PRODUCTION AUDIT COMMAND ─────────────────────────────────
//
//   node scripts/make-claim-audit-command.js
//
// Renders scripts/inline/claim-audit-payload.js into a single railway command. Generated rather
// than pasted, so the command always carries the payload that is actually in the repository — a
// command transcribed by hand drifts from the file it came from, and this one is long enough that
// the drift would not be visible.
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'inline', 'claim-audit-payload.js');
const src = fs.readFileSync(file, 'utf8');

if (src.includes("'")) {
  console.error('REFUSING: the payload contains a single quote, which would break the shell quoting.');
  console.error('Rewrite it with double quotes and bound parameters.');
  process.exit(1);
}

const b64 = Buffer.from(src, 'utf8').toString('base64');
console.log('# Read-only. Four SELECTs. Writes one temp file in the container, nothing to the database.');
console.log('# EXIT 0 = CLEAR · 1 = BLOCKED · 3 = INCOMPLETE (not a clearance).');
console.log();
console.log(`railway ssh --service playbookos 'echo ${b64} | base64 -d > /tmp/claim-audit.js && node /tmp/claim-audit.js; echo "EXIT=$?"'`);
