#!/usr/bin/env node
// ── SET A USER'S PASSWORD, WHEN NOBODY CAN LOG IN TO DO IT PROPERLY ───────────
//
//   railway ssh 'ADMIN_RESET_EMAIL=naren@abiozen.com ADMIN_RESET_PASSWORD='"'"'...'"'"' node scripts/reset-admin-password.js'
//   railway ssh '... node scripts/reset-admin-password.js --execute'
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// POST /admin/users/:id/reset-password requires an authenticated super_admin, which is no use to
// somebody locked out — the only account that can fix the problem is the one that cannot sign in.
// And initDB() will not help either: its admin seed runs ONLY when no admin exists and
// deliberately never touches an existing password, so redeploying with a new ADMIN_PASSWORD
// changes nothing. That is correct behaviour (a fresh deploy must never reset a live account), and
// it means a locked-out admin has no path at all without this.
//
// ── THE PASSWORD IS NEVER PRINTED AND NEVER AN ARGUMENT ──────────────────────
//
// It comes from the environment, not argv, because a command line ends up in shell history and in
// the process list. Nothing here logs it, not even on failure — the read-back reports true/false,
// never the value. Given the handoff document already carries this system's credentials in
// plaintext, the least this script can do is not add another copy.
'use strict';

const { initDB, query } = require('../src/lib/db');
const bcrypt = require('bcryptjs');

const EMAIL = (process.env.ADMIN_RESET_EMAIL || '').trim();
const PASSWORD = process.env.ADMIN_RESET_PASSWORD || '';
const EXECUTE = process.argv.includes('--execute');

async function main() {
  await initDB();

  if (!EMAIL || !PASSWORD) {
    console.log('✗ both ADMIN_RESET_EMAIL and ADMIN_RESET_PASSWORD must be set in the environment.');
    console.log('  They are env vars rather than flags so the password stays out of shell history.');
    process.exit(1);
  }
  // Long enough to matter. This is the account that can read every page in the system.
  if (PASSWORD.length < 12) {
    console.log(`✗ the new password is ${PASSWORD.length} characters. Use at least 12.`);
    process.exit(1);
  }

  const u = (await query(
    `SELECT id, email, name, role, is_active FROM users WHERE lower(email) = lower($1)`,
    [EMAIL])).rows;

  if (!u.length) {
    console.log(`✗ no user with email ${EMAIL}.`);
    // The likeliest cause of a failed login is the WRONG ADDRESS, so name the admins that exist.
    const admins = (await query(
      `SELECT email, role FROM users WHERE role IN ('admin','super_admin') ORDER BY email`)).rows;
    if (admins.length) {
      console.log(`  Admin accounts that do exist: ${admins.map((a) => `${a.email} (${a.role})`).join(', ')}`);
    } else {
      console.log('  There are NO admin accounts at all — set ADMIN_EMAIL and ADMIN_PASSWORD and redeploy,');
      console.log('  and initDB() will seed the first one.');
    }
    process.exit(1);
  }
  if (u.length > 1) {
    console.log(`✗ ${u.length} users share ${EMAIL}. Not guessing which one.`);
    process.exit(1);
  }

  const user = u[0];
  console.log(`── ${user.email}  (${user.role})  ${EXECUTE ? 'WRITING' : 'dry run'}\n`);
  console.log(`   name       ${user.name}`);
  console.log(`   active     ${user.is_active ? 'yes' : 'NO — a correct password will still be refused'}`);
  console.log(`   new secret ${PASSWORD.length} characters (not printed)\n`);

  if (!EXECUTE) {
    console.log('   DRY RUN — nothing written. Re-run with --execute.\n');
    return;
  }

  const hash = bcrypt.hashSync(PASSWORD, 10);
  await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, hash]);

  // Verify against the STORED hash the way the login route does, rather than trusting the UPDATE.
  // "I wrote a row" and "this password now signs in" are different claims, and only the second one
  // is what somebody locked out actually needs.
  const after = (await query(`SELECT password_hash FROM users WHERE id = $1`, [user.id])).rows[0];
  const works = !!after && bcrypt.compareSync(PASSWORD, after.password_hash);

  if (!works) {
    console.log('   ✗ read-back FAILED — the stored hash does not match the new password.');
    process.exit(1);
  }
  console.log('   ✅ the new password verifies against the stored hash.');
  if (!user.is_active) {
    console.log('   ⚠ but is_active is false, so the login route will still refuse this account.');
  }
  console.log('\n   Change it again from Settings once you are in, so the value is not left in a');
  console.log('   Railway variable or a terminal session.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('reset-admin-password failed:', e && e.message ? e.message : e);
  process.exit(1);
});
