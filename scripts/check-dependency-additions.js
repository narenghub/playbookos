#!/usr/bin/env node
// ── A NEW DEPENDENCY IS A NEW ROAD OUT ──────────────────────────────────────
//
//   node scripts/check-dependency-additions.js
//
// Exit 0 when every dependency in package.json has been reviewed. Exit 1 on any addition that has
// not. Exit 3 when the check could not run.
//
// ── WHY THIS EXISTS BESIDE THE TRANSPORT SCANNER ────────────────────────────
//
// check-email-transport-coverage.js discovers provider call sites by the SHAPES it knows: the
// googleapis SDK, the Resend SDK, nodemailer, and Gmail/Resend REST. That is every road in this
// repository today, and it is a statement about today.
//
// It cannot see a transport nobody anticipated. A raw POST to an unfamiliar host, an SDK with a
// different call shape, a queue that forwards to email somewhere else — none of those match a
// pattern written before they existed. The scanner's header says so plainly rather than implying
// coverage it does not have.
//
// This is the second leg, and it catches a different thing: not "what does the code call" but
// "what has the code gained the ABILITY to call". A mail SDK cannot be used before it is
// installed, and installing it edits one file. That is a cheap, high-signal chokepoint.
//
// ── WHAT IT CATCHES, AND WHAT IT DOES NOT ───────────────────────────────────
//
//   catches: `npm i some-email-sdk` — a reviewed list stops naming every installed package
//   misses:  `await fetch('https://some-other-provider/send', ...)` with no new dependency at all
//
// Both are written here so nobody reads a green run as proof that no new transport exists. Proving
// the application CANNOT reach a provider is the separate sender process in Spec A Tier 2, not a
// static check of any kind.

'use strict';

const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'package.json');
const EXIT_NOT_EXECUTED = 3;

// ── THE REVIEWED SET ────────────────────────────────────────────────────────
//
// Every dependency present on 2026-11-12, each with what it is for. The notes are not decoration:
// a reviewer approving an addition needs to know what the existing network-capable packages are,
// and `googleapis`, `resend` and `nodemailer` are the three that can reach a mail provider.
//
// Adding a package means adding a line HERE, which puts it in the diff next to the reason. That is
// the whole mechanism — it does not prevent an addition, it prevents a silent one.
const REVIEWED = Object.freeze({
  'adm-zip': 'zip handling for document export',
  bcryptjs: 'password hashing',
  'better-sqlite3': 'local fixture databases in tests',
  cors: 'HTTP middleware',
  docx: 'Word document generation',
  dotenv: 'environment loading',
  express: 'HTTP server',
  googleapis: 'MAIL-CAPABLE — Gmail, Search Console, Drive. Send scope governed by the transport scanner.',
  jsonwebtoken: 'session tokens',
  multer: 'file uploads',
  'node-cron': 'scheduled jobs',
  nodemailer: 'MAIL-CAPABLE — SMTP. Declared but has no importer; a dormant road, tracked by the transport scanner.',
  'pdfjs-dist': 'PDF text extraction',
  pg: 'PostgreSQL client',
  resend: 'MAIL-CAPABLE — the Resend SDK, used by src/lib/mailer.js behind the kill switch and the approval boundary.',
  uuid: 'identifiers',
  xlsx: 'spreadsheet generation',
});

/** Dependencies declared by a package.json object, runtime and dev together. */
function declaredDependencies(pkg) {
  return [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ].sort();
}

/** { added, removed } relative to the reviewed set. */
function diffAgainstReviewed(declared, reviewed = REVIEWED) {
  const known = new Set(Object.keys(reviewed));
  return {
    added: declared.filter((d) => !known.has(d)),
    removed: Object.keys(reviewed).filter((d) => !declared.includes(d)).sort(),
  };
}

function main() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  } catch (e) {
    console.log(`package.json could not be read: ${(e && e.message) || e}`);
    console.log('SKIP  the dependency gate did NOT execute.');
    process.exit(EXIT_NOT_EXECUTED);
  }

  const declared = declaredDependencies(pkg);
  const { added, removed } = diffAgainstReviewed(declared);

  console.log(`\n  ${declared.length} declared dependency/dependencies · ${Object.keys(REVIEWED).length} reviewed\n`);

  let fail = 0;

  if (!added.length) {
    console.log('  ok    every declared dependency has been reviewed');
  } else {
    fail += 1;
    console.log(`  FAIL  ${added.length} dependency/dependencies have not been reviewed`);
    console.log(`          ${added.join(', ')}`);
    console.log('\n          A new package is a new capability. If it can reach a network');
    console.log('          service, say so in its note. Add it to REVIEWED in this file with');
    console.log('          one line on what it is for, so the addition sits in the diff beside');
    console.log('          its reason.');
  }

  // A removed dependency is not a failure — but a reviewed entry for a package that is gone means
  // the list is drifting away from the thing it describes, and a stale list is read as a current
  // one. Reported, not fatal.
  if (removed.length) {
    console.log(`\n  --    ${removed.length} reviewed entry/entries no longer declared: ${removed.join(', ')}`);
    console.log('        Remove them, so the reviewed set stays a description of reality.');
  }

  const mailCapable = declared.filter((d) => (REVIEWED[d] || '').startsWith('MAIL-CAPABLE'));
  console.log(`\n  mail-capable dependencies: ${mailCapable.length} (${mailCapable.join(', ') || 'none'})`);

  if (fail) {
    console.log('\nFAIL  an unreviewed dependency is declared.\n');
    process.exit(1);
  }
  console.log('\nPASS  no unreviewed dependency. This does NOT establish that no new transport');
  console.log('      exists — a raw call to an unknown host needs no dependency at all.\n');
  process.exit(0);
}

module.exports = { REVIEWED, declaredDependencies, diffAgainstReviewed };

if (require.main === module) main();
