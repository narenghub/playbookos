#!/usr/bin/env node
// ── WHO CAN ADMINISTER THIS SYSTEM ────────────────────────────────────────────
//
//   railway ssh 'node scripts/check-admins.js'          → every privileged account
//   railway ssh 'node scripts/check-admins.js --all'     → every account
//
// Read-only. Changes nothing.
//
// Written because the startup banner reported ONE admin, picked arbitrarily from an unordered
// LIMIT 1, and the name it showed changed between two runs on the same data — on a day Naren
// could not log in. The question that actually matters is not "name an admin" but "who holds
// privilege, is my own account among them, and is it active".
//
// is_active is shown because the login query filters `AND is_active=1`: a correct password on an
// inactive account is refused with the same "Invalid credentials" as a wrong one, so an account
// can look broken when it is only switched off.
'use strict';

const { initDB, query } = require('../src/lib/db');

const ALL = process.argv.includes('--all');
const ME = (process.argv.find((a) => a.startsWith('--me=')) || '--me=naren@abiozen.com').split('=')[1];

async function main() {
  await initDB();

  const rows = (await query(
    `SELECT email, name, role, is_active, joined_at, invite_token IS NOT NULL AS pending_invite,
            password_hash IS NOT NULL AS has_password
       FROM users
      ${ALL ? '' : "WHERE role IN ('admin','super_admin')"}
      ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, email`)).rows;

  console.log(`\n── ${ALL ? 'all accounts' : 'privileged accounts'} (${rows.length})\n`);
  for (const r of rows) {
    const flags = [
      r.is_active ? 'active' : 'INACTIVE — login refused even with the right password',
      r.has_password ? null : 'NO PASSWORD SET',
      r.pending_invite ? 'invite not accepted' : null,
    ].filter(Boolean);
    console.log(`   ${String(r.role).padEnd(12)} ${String(r.email).padEnd(42)} ${r.name || ''}`);
    console.log(`                ${flags.join(' · ')}`);
  }

  const supers = rows.filter((r) => r.role === 'super_admin');
  console.log(`\n   super_admin: ${supers.length ? supers.map((s) => s.email).join(', ') : 'NONE'}`);
  if (!supers.length) {
    console.log('   ⚠ no super_admin exists. Product revocation and role changes need one.');
  }

  const mine = rows.find((r) => String(r.email).toLowerCase() === String(ME).toLowerCase());
  console.log(`\n   ${ME}:`);
  if (!mine) {
    console.log(`      not in this list${ALL ? ' — no such account' : ' — holds no admin role'}.`);
    console.log('      Re-run with --all to see whether the account exists at all.');
  } else {
    console.log(`      role ${mine.role} · ${mine.is_active ? 'active' : 'INACTIVE'}`
      + ` · ${mine.has_password ? 'password set' : 'NO PASSWORD'}`);
    if (mine.role !== 'super_admin') {
      console.log('      ⚠ not super_admin, so some admin actions will be refused.');
    }
  }
  console.log();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('check-admins failed:', e && e.message ? e.message : e);
  process.exit(1);
});
