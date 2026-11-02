#!/usr/bin/env node
// ── WHAT IS WAITING FOR A HUMAN ─────────────────────────────────────────────
//
//   railway ssh 'node scripts/office-pending-approvals.js'
//
// READ-ONLY. An approval boundary nobody is told about becomes either a rubber stamp or a
// bottleneck, and until R4 gives this a real surface, this script is the surface.
'use strict';

const { query } = require('../src/lib/db');
const crypto = require('crypto');

(async () => {
  try {
    console.log('\n══ APPROVALS AND THEIR STATE (READ-ONLY) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    const rows = (await query(
      `SELECT a.id, a.status, a.resolution, a.resolved_by, a.resolved_at, a.release_claimed_at,
              a.objective_id, a.action_kind, a.action_payload, a.created_at, a.owner_user_id,
              o.release_mode, c.display_name
         FROM office_approvals a
         JOIN objectives o ON o.id = a.objective_id AND o.company_id = a.company_id
         JOIN companies c ON c.id = a.company_id
        ORDER BY a.created_at`)).rows;

    if (!rows.length) { console.log('  nothing has been prepared yet.\n'); process.exit(0); }

    const pending = rows.filter((r) => r.status === 'pending');
    const approvedUnsent = rows.filter((r) => r.status === 'approved' && !r.release_claimed_at);

    for (const r of rows) {
      const p = r.action_payload || {};
      const hash = p.body ? crypto.createHash('sha256').update(String(p.body)).digest('hex').slice(0, 16) : '—';
      console.log(`  ${r.status.toUpperCase()}${r.release_claimed_at ? ' · RELEASE CLAIMED' : ''}`);
      console.log(`    ${r.id}`);
      console.log(`    ${r.action_kind} → ${p.to || '(no destination)'}  ·  ${p.supplier_name || '?'}`);
      console.log(`    ${p.approved_molecule_name || '?'}`
        + `${p.approved_cas ? ` (${p.approved_cas})` : ' — no CAS'}`
        + `  ·  signed by ${p.signed_by_name || '(none recorded)'}`);
      console.log(`    objective ${r.objective_id} (release_mode=${r.release_mode})  ·  body ${hash}`);
      console.log(`    prepared ${r.created_at.toISOString()}  ·  owner ${r.owner_user_id}`);
      if (r.resolved_by) {
        console.log(`    decided by ${r.resolved_by} at ${r.resolved_at.toISOString()}`);
        console.log(`    reason: ${String(r.resolution || '(none recorded)').slice(0, 150)}`);
      }
      console.log('');
    }

    console.log(`  ${pending.length} awaiting a decision · ${approvedUnsent.length} approved and not yet released\n`);
    for (const r of pending) {
      console.log(`  to decide ${r.id}:`);
      console.log(`    railway ssh 'node scripts/office-decide-approval.js --approval=${r.id} --approve --reason="..."'`);
      console.log(`    railway ssh 'node scripts/office-decide-approval.js --approval=${r.id} --reject --reason="..."'\n`);
    }
    for (const r of approvedUnsent) {
      console.log(`  approved, awaiting RELEASE — this sends a real email:`);
      console.log(`    railway ssh 'node scripts/office-release-approved.js --approval=${r.id} --i-authorize-release'\n`);
    }
    process.exit(0);
  } catch (e) {
    console.error('\nFAIL  listing error:', e.stack || e.message);
    process.exit(1);
  }
})();
