#!/usr/bin/env node
// ── WHO WOULD SIGN A GOVERNED RFQ RIGHT NOW ─────────────────────────────────
//
//   railway ssh 'node scripts/office-signatory.js'
//
// READ-ONLY. No INSERT, UPDATE or DELETE, no AI call.
//
// This exists because on 2 Nov 2026 two real supplier RFQs were prepared signed by a Procurement
// Director who had left the organisation, with his address as the reply-to. The signature block
// was three hardcoded lines inside an AI prompt, so nothing failed and nothing warned.
//
// The signatory is now resolved from `users` at render time. That means the signature is only ever
// as correct as that table — so this reports who the system WOULD put on a supplier letter, and
// who it is skipping, before anybody spends money finding out.
'use strict';

const { query } = require('../src/lib/db');

const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);

(async () => {
  try {
    console.log('\n══ WHO WOULD SIGN A GOVERNED SUPPLIER RFQ (READ-ONLY) ══\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    const { resolveSignatory } = require('../src/lib/office/procurement-rfq');
    const who = await resolveSignatory({});

    if (!who) {
      console.log('  NOBODY.\n');
      console.log('  No active procurement_director, procurement_team member or admin exists in');
      console.log('  `users`, so renderGovernedRFQ REFUSES with no_active_signatory rather than');
      console.log('  signing a name it has no right to use. No RFQ can be prepared until somebody');
      console.log('  active holds one of those roles.\n');
    } else {
      console.log('  THE SIGNATURE BLOCK A SUPPLIER WOULD SEE\n');
      console.log(`    ${who.name}`);
      console.log(`    ${who.title}`);
      console.log('    Abiozen LLC');
      console.log(`    ${who.email}\n`);
      console.log(`  resolved from role "${who.role}" (user id ${who.id})`);
      console.log('  replies from the supplier would go to that address.\n');
    }

    // Everyone the resolution considers, and what it does with them. The point is the skipped
    // rows: an inactive director is exactly the case that caused the incident.
    const roles = ['procurement_director', 'procurement_team', 'admin', 'super_admin'];
    const rows = (await query(
      `SELECT id, name, email, role, is_active FROM users
        WHERE role = ANY($1) ORDER BY
          array_position($1, role), is_active DESC, created_at`, [roles])).rows;

    console.log('  EVERY CANDIDATE THE RESOLUTION CONSIDERS, IN ORDER\n');
    if (!rows.length) console.log('    none\n');
    else {
      console.log(`    ${pad('role', 22)}${pad('name', 24)}${pad('email', 34)}active`);
      console.log(`    ${'-'.repeat(21)} ${'-'.repeat(23)} ${'-'.repeat(33)} ------`);
      for (const r of rows) {
        const mark = who && r.id === who.id ? ' ← SIGNS' : (r.is_active ? '' : ' (skipped: inactive)');
        console.log(`    ${pad(r.role, 22)}${pad(r.name, 24)}${pad(r.email, 34)}`
          + `${pad(r.is_active ? 'yes' : 'NO', 6)}${mark}`);
      }
      console.log('');
    }

    console.log('  --    is_active=0 is what keeps a departed employee off a supplier letter, so a');
    console.log('  --    person who has left must be deactivated in Team Management — not merely');
    console.log('  --    left in place with nobody using their login.');
    console.log('  --    this script issued no INSERT, UPDATE or DELETE\n');
    process.exit(0);
  } catch (e) {
    console.error('\nFAIL  signatory lookup error:', e.stack || e.message);
    process.exit(1);
  }
})();
