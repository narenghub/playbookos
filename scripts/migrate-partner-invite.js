#!/usr/bin/env node
// ── AN INVITE HAS TO SAY WHICH PARTNER THE ACCOUNT BELONGS TO. ────────────────
//
//   railway ssh 'node scripts/migrate-partner-invite.js'
//
// users.invited_partner_id — chosen when the invite is SENT, copied to users.partner_id when it is
// ACCEPTED, and cleared. The same rule the product grants follow, and for the same reason: an
// invite that is never accepted must leave nothing behind that a scoping query can read.
//
// WHY THIS COLUMN DID NOT EXIST, AND WHAT IT COST: partnerScopeSql has always returned FALSE for an
// external role with a NULL partner_id. That is the right behaviour — the alternative is showing one
// partner every other partner's pipeline — and the guard was intact. But nothing ever SET the value,
// because the invite had no way to carry it. So the ACBM Partners account accepted its invite, set a
// password, logged in successfully, and saw an empty board. Every layer behaved correctly and the
// product was still broken.
'use strict';

const { query, initDB } = require('../src/lib/db');
const { isExternalRole } = require('../src/lib/roles');

async function migrate() {
  await initDB();

  // The partners table has to exist first — it is where the FK points.
  const hasPartners = (await query(
    `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name = 'partners'`)).rows[0].n;
  if (!hasPartners) {
    console.error('partners table is missing — run scripts/migrate-sitenex-rename.js first.');
    process.exit(1);
  }

  // No CASCADE: deleting a partner must not silently unlink the people who work for them. It should
  // fail and make somebody decide, which is the same choice users.partner_id already made.
  await query(`ALTER TABLE users
                 ADD COLUMN IF NOT EXISTS invited_partner_id INTEGER REFERENCES partners(id)`);
  console.log('✅ users.invited_partner_id');

  // Partial index: the only query that reads this column looks for the handful of pending invites.
  await query(`CREATE INDEX IF NOT EXISTS idx_users_invited_partner
                 ON users (invited_partner_id) WHERE invited_partner_id IS NOT NULL`);
  console.log('✅ idx_users_invited_partner');

  const partners = (await query(`SELECT id, name, status FROM partners ORDER BY id`)).rows;
  console.log(`\npartners available to invite against (${partners.length}):`);
  for (const p of partners) console.log(`   id=${String(p.id).padEnd(3)} ${String(p.name).padEnd(24)} ${p.status}`);

  // isExternalRole, NOT excluded_from_scoring. The first version of this used the column as a proxy
  // and reported three accounts needing a partner link — but two of them, a super_admin and a
  // recruitment_team member, are STAFF: excluded_from_scoring is set for its own reasons and is not
  // a synonym for "outside the company". A warning that names people who are fine is how a warning
  // stops being read, and the repair script beside it used the real check and listed exactly one.
  const stuck = (await query(
    `SELECT email, role FROM users WHERE partner_id IS NULL ORDER BY email`))
    .rows.filter((u) => isExternalRole(u.role));
  if (stuck.length) {
    console.log(`\n⚠ ${stuck.length} external account(s) have NO partner_id and therefore see no rows:`);
    for (const u of stuck) console.log(`   ${u.email}  (${u.role})`);
    console.log('\n   Repair each with:');
    console.log('     node scripts/repair-partner-link.js --email <address> --partner-id <id> --execute');
    console.log('   Diagnose first with:');
    console.log('     node scripts/diagnose-partner-accounts.js');
  } else {
    console.log('\nNo external account is missing a partner_id.');
  }
}

migrate().then(() => process.exit(0))
         .catch((e) => { console.error('migration error:', e.message); process.exit(1); });
