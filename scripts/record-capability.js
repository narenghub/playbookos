#!/usr/bin/env node
// ── RECORD A VERIFIED CAPABILITY ─────────────────────────────────────────────
//
//   node scripts/record-capability.js --area cro_services --code ISO9001 \
//     --name "ISO 9001:2015 …" --entity "ABIOZEN LLC" \
//     --evidence-class certification \
//     --evidence-source "certificate no. … issued by …" \
//     --valid-from 2026-06-30 --valid-to 2029-06-29 \
//     --verified-by "Naresh Boda" --approval "…" [--evidence-url …] [--dry-run]
//
// There is no API route for this and that is deliberate: a capability is what the qualification
// engine is allowed to bid on behalf of, so creating one is an attended act with a named approver,
// not a form somebody fills in while distracted.
//
// It does propose() then activate(), which is the only path to 'verified' — the CHECK constraint on
// verified_capabilities makes that status unreachable without evidence_source, verified_at,
// verified_by, approval_id and valid_from. This script cannot route around it and does not try.
//
// ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
//
// It will not invent evidence. Every value below comes from a document a human has read. The one
// thing that makes this registry worth having is that a row in it means somebody looked at a
// certificate — so --evidence-source must name the document, not describe a belief.
//
// Exit status: 0 recorded, 1 refused or failed, 2 bad usage.

'use strict';

require('dotenv').config();

const { query } = require('../src/lib/db');
const REG = require('../src/lib/office/capability-registry');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const log = (s) => process.stdout.write(`${s}\n`);
const bar = () => '─'.repeat(78);

function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

const REQUIRED = ['area', 'name', 'entity', 'evidence-class', 'evidence-source',
  'valid-from', 'verified-by', 'approval'];

async function main() {
  const missing = REQUIRED.filter((k) => !arg(k));
  if (missing.length) {
    process.stderr.write(`\nrecord-capability: missing ${missing.map((m) => `--${m}`).join(', ')}\n\n`);
    process.exit(2);
  }

  // The plan is printed, and a dry run exits, BEFORE any database work. A rehearsal that needs a
  // live connection is not a rehearsal — it cannot be run from a laptop to check the arguments.
  log(`\n${bar()}`);
  log('RECORD A VERIFIED CAPABILITY');
  log(bar());
  log(`  area           : ${arg('area')}`);
  log(`  name           : ${arg('name')}`);
  log(`  held by        : ${arg('entity')}`);
  log(`  evidence class : ${arg('evidence-class')}`);
  log(`  evidence       : ${arg('evidence-source')}`);
  log(`  valid          : ${arg('valid-from')} → ${arg('valid-to') || 'no expiry recorded'}`);
  log(`  verified by    : ${arg('verified-by')}`);
  log(`  approval       : ${arg('approval')}`);
  log(`  mode           : ${DRY ? 'DRY RUN — nothing will be written' : 'write'}`);

  if (DRY) { log('\nDRY RUN — nothing written, no database touched.\n'); process.exit(0); }

  const slug = process.env.PRPA_COMPANY_SLUG || 'abiozen';
  const c = await query(
    `SELECT id, display_name AS name FROM companies WHERE slug = $1 AND status = 'active' LIMIT 1`,
    [slug]);
  if (!c.rows.length) {
    process.stderr.write(`\nrecord-capability: no active company with slug "${slug}"\n\n`);
    process.exit(1);
  }
  const companyId = c.rows[0].id;
  log(`  company        : ${c.rows[0].name}`);

  const proposed = await REG.propose(query, {
    companyId,
    areaKey: arg('area'),
    code: arg('code') || undefined,
    name: arg('name'),
    responsibleEntity: arg('entity'),
    notes: arg('notes') || undefined,
    proposedBy: arg('verified-by'),
  });
  log(`\n  proposed : ${proposed.id} (pending, area ${proposed.area})`);

  const verified = await REG.activate(query, {
    companyId,
    capabilityId: proposed.id,
    evidenceClass: arg('evidence-class'),
    evidenceSource: arg('evidence-source'),
    evidenceUrl: arg('evidence-url') || undefined,
    evidenceSha256: arg('evidence-sha256') || undefined,
    verifiedBy: arg('verified-by'),
    approvalId: arg('approval'),
    validFrom: arg('valid-from'),
    validTo: arg('valid-to') || undefined,
  });

  log(`  verified : ${verified.id} · class ${verified.evidence_class} · valid to ${verified.valid_to || 'no expiry'}`);
  log('');
  log(`PASS  capability recorded and verified.`);
  log('');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\nrecord-capability: ${e.message}\n\n`);
  process.exit(1);
});
