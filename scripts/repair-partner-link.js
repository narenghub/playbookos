#!/usr/bin/env node
// ── LINK AN ACCOUNT THAT ACCEPTED BEFORE THE INVITE COULD CARRY A PARTNER. ────
//
//   railway ssh 'node scripts/migrate-partner-invite.js'                      # adds the column
//   railway ssh 'node scripts/repair-partner-link.js'                         # dry run, shows candidates
//   railway ssh 'node scripts/repair-partner-link.js --email a@b.com --partner-id 1 --execute'
//
// The ACBM Partners account accepted its invite, set a password, and saw nothing — because
// /auth/accept-invite never wrote users.partner_id, so partnerScopeSql returned FALSE for it. That
// is fixed going forward. This repairs the account that is already stuck.
//
// ── WHY THIS IS NOT A ONE-LINE UPDATE ────
//
// Setting partner_id on the WRONG account shows one partner another partner's entire pipeline. So:
//   • --email and --partner-id are BOTH required for a write. No "fix all the external accounts",
//     no inferring the partner from an email domain, no default.
//   • The account must already exist and hold an external role. Scoping a staff account to one
//     partner would hide most of their own data from them.
//   • It prints exactly what it will do and changes nothing without --execute.
//   • It touches ONLY the one row named by --email, by id, and verifies that one row afterwards.
'use strict';

const { query } = require('../src/lib/db');
const { isExternalRole } = require('../src/lib/roles');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
};

const EMAIL = (arg('email') || '').trim().toLowerCase();
const PARTNER = arg('partner-id');
const EXECUTE = process.argv.includes('--execute');
// joined_at is what the Status badge reads. An account with a password but no joined_at shows
// "Invited" forever. Only set it when a password actually exists — otherwise the badge would claim
// an account is active when nobody can log into it.
const SET_JOINED = !process.argv.includes('--no-joined-at');

async function main() {
  const partners = (await query(`SELECT id, name, status FROM partners ORDER BY id`)).rows;
  const external = (await query(
    `SELECT id, email, role, partner_id, joined_at,
            (password_hash IS NOT NULL) AS has_password,
            (invite_token IS NOT NULL) AS has_token
       FROM users ORDER BY email`)).rows.filter((u) => isExternalRole(u.role));

  if (!EMAIL || !PARTNER) {
    console.log('── repair partner link · DRY RUN (no --email / --partner-id given)\n');
    console.log(`active partners:`);
    for (const p of partners) console.log(`  id=${p.id}  ${p.name}  (${p.status})`);
    console.log(`\nexternal-role accounts that would need linking:`);
    if (!external.length) console.log('  none');
    for (const u of external) {
      const flags = [];
      if (u.partner_id == null) flags.push('NO partner_id → sees nothing');
      if (u.has_password && !u.joined_at) flags.push('password set but joined_at NULL → badge reads Invited');
      if (!u.has_password) flags.push('no password → has not accepted');
      console.log(`  ${u.email.padEnd(34)} ${u.role.padEnd(10)} partner_id=${u.partner_id == null ? 'NULL' : u.partner_id}` +
                  (flags.length ? `\n      ${flags.join('\n      ')}` : ''));
    }
    console.log('\nTo repair one:');
    console.log(`  node scripts/repair-partner-link.js --email <address> --partner-id <id> --execute`);
    console.log('\nBoth flags are required. There is deliberately no "repair everything": setting');
    console.log('partner_id on the wrong account shows one partner another partner\'s pipeline.');
    return;
  }

  const pid = parseInt(PARTNER, 10);
  if (!Number.isInteger(pid)) throw new Error('--partner-id must be an integer');
  const partner = partners.find((p) => p.id === pid);
  if (!partner) throw new Error(`No partner with id ${pid}. Known: ${partners.map((p) => p.id + '=' + p.name).join(', ')}`);
  if (partner.status !== 'active') throw new Error(`Partner "${partner.name}" is ${partner.status}, not active`);

  const u = (await query('SELECT * FROM users WHERE LOWER(email) = $1', [EMAIL])).rows[0];
  if (!u) throw new Error(`No account with email ${EMAIL}`);
  if (!isExternalRole(u.role)) {
    throw new Error(`${EMAIL} holds role "${u.role}", which is INTERNAL. Scoping a staff account to ` +
                    `one partner would hide most of their own data from them. Refusing.`);
  }

  const willSetJoined = SET_JOINED && !u.joined_at && u.password_hash;
  console.log('── repair partner link\n');
  console.log(`  account      ${u.email}  (${u.role})`);
  console.log(`  partner_id   ${u.partner_id == null ? 'NULL' : u.partner_id}  →  ${pid} (${partner.name})`);
  console.log(`  joined_at    ${u.joined_at || 'NULL'}${willSetJoined ? '  →  now  (badge: Invited → Active)' : '  (unchanged)'}`);
  if (SET_JOINED && !u.joined_at && !u.password_hash) {
    console.log('  ⚠ joined_at left NULL: there is no password on this account, so it cannot log in.');
    console.log('    Marking it Active would be a lie. Re-send the invite instead.');
  }
  if (u.partner_id != null && u.partner_id !== pid) {
    console.log(`  ⚠ this account is ALREADY linked to partner ${u.partner_id}. Changing it moves which`);
    console.log('    partner\'s rows they can see. Make sure that is intended.');
  }

  if (!EXECUTE) { console.log('\n  DRY RUN — nothing written. Add --execute.'); return; }

  // By id, one row, explicitly. Never by role, domain or pattern.
  const res = await query(
    `UPDATE users
        SET partner_id = $1,
            joined_at = CASE WHEN $2 THEN NOW() ELSE joined_at END
      WHERE id = $3
      RETURNING id, email, role, partner_id, joined_at`,
    [pid, !!willSetJoined, u.id]);

  const after = res.rows[0];
  console.log(`\n  ✅ ${after.email}: partner_id=${after.partner_id}, joined_at=${after.joined_at}`);

  // Verify the one row we changed, and only that one.
  const check = (await query(
    `SELECT COUNT(*)::int n FROM users WHERE id = $1 AND partner_id = $2`, [u.id, pid])).rows[0].n;
  if (check !== 1) throw new Error('the write did not stick — investigate before telling the partner to log in');

  const visible = (await query(
    `SELECT COUNT(*)::int n FROM outreach_prospects WHERE partner_id = $1`, [pid]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  console.log(`\n  They can now see ${visible} prospect row(s) — the ones carrying partner_id=${pid}.`);
  if (!visible) {
    console.log('  That is ZERO, and it is correct rather than broken: rows with a NULL partner_id are');
    console.log('  self-sourced and deliberately invisible to a partner. Until deals are referred BY');
    console.log('  this partner, or existing rows are assigned to them, their board is empty.');
  }
}

main().then(() => process.exit(0))
      .catch((e) => { console.error('repair error:', e.message); process.exit(1); });
