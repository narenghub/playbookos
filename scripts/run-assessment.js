#!/usr/bin/env node
// ── RE-ASSESS EVERY CURRENT OPPORTUNITY ──────────────────────────────────────
//
//   node scripts/run-assessment.js
//
// Runs exactly what POST /api/prpa/tracker/assess runs — same capabilities, same engine, same
// evidence basis — from the command line, because a capability recorded by script should be
// provable by script without a browser session and an admin token.
//
// evidence_basis is 'real_registry', always. The fixture basis exists for demonstrations and a
// QUALIFIED verdict carrying it is refused by a CHECK constraint, which is the point: a verdict
// Abiozen could act on cannot have been produced from invented evidence.
//
// Exit status: 0 assessed, 1 failed.
//
// ZERO VERIFIED CAPABILITIES IS NOT AN ERROR. It produces a board on which nothing is QUALIFIED,
// and that is the truthful answer rather than a broken run — so it exits 0 and says so plainly.

'use strict';

require('dotenv').config();

const { query } = require('../src/lib/db');
const REG = require('../src/lib/office/capability-registry');
const T = require('../src/lib/office/opportunity-tracker');
const { isoDay } = require('../src/lib/office/iso-day');

const log = (s) => process.stdout.write(`${s}\n`);
const bar = () => '─'.repeat(78);

async function main() {
  const today = isoDay(new Date());
  const slug = process.env.PRPA_COMPANY_SLUG || 'abiozen';
  const c = await query(
    `SELECT id, display_name AS name FROM companies WHERE slug = $1 AND status = 'active' LIMIT 1`,
    [slug]);
  if (!c.rows.length) throw new Error(`no active company with slug "${slug}"`);
  const companyId = c.rows[0].id;

  const caps = await REG.activeCapabilities(query, companyId, { today });

  log(`\n${bar()}`);
  log('RE-ASSESS OPPORTUNITIES');
  log(bar());
  log(`  company               : ${c.rows[0].name}`);
  log(`  today                 : ${today}`);
  log(`  verified capabilities : ${caps.length}`);
  for (const cap of caps) {
    log(`    · ${cap.business_line} — ${cap.name} [${cap.evidence_class}]`
      + `${cap.valid_to ? ` valid to ${isoDay(cap.valid_to)}` : ''}`);
  }

  const out = await T.assessAll(query, {
    companyId,
    assessedBy: 'assessment@playbookos',
    capabilities: caps,
    evidenceBasis: 'real_registry',
    opts: { today },
  });

  const tally = out.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});

  log('');
  log(`  assessed : ${out.length}`);
  for (const [verdict, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    log(`    ${String(verdict).padEnd(16)} ${n}`);
  }
  log('');
  if (!caps.length) {
    log('NOTE  zero verified capabilities, so nothing can be QUALIFIED. That is the truthful');
    log('      result of this run, not a failure of it.');
    log('');
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\nrun-assessment: ${e.stack || e.message}\n\n`);
  process.exit(1);
});
