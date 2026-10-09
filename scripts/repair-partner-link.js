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
  // ── A LIVE INVITE TOKEN ON AN ACCOUNT THAT ALREADY HAS A PASSWORD ────
  //
  // Found on the real account: password set, joined_at NULL, AND invite_token still present. That
  // combination is a STANDING CREDENTIAL. /auth/accept-invite looks an account up by token and sets
  // a password on it with no other check, so anyone holding that invite URL — a forwarded email, a
  // mailing-list archive, a shared inbox — can reset the partner's password at any time. It is
  // rate-limited, not authenticated.
  //
  // Once a password exists the invite is spent, so the token has no remaining purpose and clearing
  // it cannot lock anybody out. accept-invite clears it on the path it owns; nothing cleared it on
  // whatever path this account actually took.
  const clearToken = !!(u.password_hash && u.invite_token);
  if (clearToken) {
    console.log('  invite_token STILL PRESENT alongside a password  →  will be CLEARED');
    console.log('    That token is a live password-reset link for this account: accept-invite takes a');
    console.log('    token and sets a password, with no other check. The invite is already spent, so');
    console.log('    clearing it removes a standing credential and locks nobody out.');
  }
  if (u.partner_id != null && u.partner_id !== pid) {
    console.log(`  ⚠ this account is ALREADY linked to partner ${u.partner_id}. Changing it moves which`);
    console.log('    partner\'s rows they can see. Make sure that is intended.');
  }

  // ── THE THIRD CONSEQUENCE OF BYPASSING accept-invite ────
  //
  // That route writes three things: the password, joined_at, and the PRODUCT GRANTS. An account
  // with a password but no joined_at got its credentials some other way, which means its grants
  // were never written either — and with no row in user_products it cannot see a product surface
  // at all, so fixing partner_id alone would leave it still showing nothing.
  //
  // The grants applied here come ONLY from invited_products: the choice a super admin already made
  // when the invite was sent. Nothing is invented, and if that column is empty this prints and
  // grants nothing rather than guessing at a sensible default — guessing is how an outside account
  // ends up holding a product somebody would not have given it.
  const held = (await query(
    `SELECT product FROM user_products WHERE user_id = $1 ORDER BY product`, [u.id])).rows.map((r) => r.product);
  const authorised = Array.isArray(u.invited_products) ? u.invited_products : [];
  const toGrant = authorised.filter((p) => !held.includes(p));
  console.log(`  products     ${held.length ? held.join(', ') : 'NONE ← cannot see any product surface'}`);
  if (toGrant.length) {
    console.log(`               → grant ${toGrant.join(', ')}  (chosen at invite time, never applied)`);
  } else if (!held.length && !authorised.length) {
    console.log('               ⚠ and the invite recorded no product choice either, so there is');
    console.log('                 nothing to apply. Grant the products from Team Management, or');
    console.log('                 this account will log in and see an empty shell.');
  }

  if (!EXECUTE) { console.log('\n  DRY RUN — nothing written. Add --execute.'); return; }

  // By id, one row, explicitly. Never by role, domain or pattern.
  //
  // COALESCE with a parameter, NOT `CASE WHEN $2 THEN NOW() ELSE joined_at END`. That version
  // failed on the live database with "CASE types text and timestamp with time zone cannot be
  // matched": users.joined_at is TEXT — /auth/accept-invite writes new Date().toISOString() into
  // it — so NOW() in the other branch is a type mismatch Postgres refuses. Passing the timestamp as
  // an ISO string, the same shape accept-invite uses, keeps both sides text and keeps the two
  // routes writing the same format. COALESCE also expresses the intent more directly: set it only
  // if it is not already set, never overwrite a real join date.
  const joinedAt = willSetJoined ? new Date().toISOString() : null;
  const res = await query(
    `UPDATE users
        SET partner_id   = $1,
            joined_at    = COALESCE(joined_at, $2),
            invite_token = CASE WHEN $4 THEN NULL ELSE invite_token END
      WHERE id = $3
      RETURNING id, email, role, partner_id, joined_at, (invite_token IS NULL) AS token_cleared`,
    [pid, joinedAt, u.id, clearToken]);

  const after = res.rows[0];
  console.log(`\n  ✅ ${after.email}: partner_id=${after.partner_id}, joined_at=${after.joined_at}`);
  if (clearToken) {
    if (!after.token_cleared) throw new Error('the invite token was NOT cleared — it is still a live password-reset link');
    console.log('  ✅ invite token cleared — that standing credential is gone');
  }

  // Verify the one row we changed, and only that one.
  const check = (await query(
    `SELECT COUNT(*)::int n FROM users WHERE id = $1 AND partner_id = $2`, [u.id, pid])).rows[0].n;
  if (check !== 1) throw new Error('the write did not stick — investigate before telling the partner to log in');

  // Apply the grants the invite authorised, and log them the same way accept-invite does, so every
  // route by which a grant comes into being lands in one audit table.
  for (const product of toGrant) {
    await query(`INSERT INTO user_products (user_id, product, granted_by) VALUES ($1,$2,$3)
                 ON CONFLICT (user_id, product) DO NOTHING`, [u.id, product, u.invited_by || null]);
    await query(
      `INSERT INTO user_product_grants_log (user_id, user_email, product, action, actor_id, source)
       VALUES ($1,$2,$3,'grant',$4,'repair_partner_link')`,
      [u.id, u.email, product, u.invited_by || null]);
    console.log(`  ✅ granted ${product}`);
  }
  if (toGrant.length) {
    await query(`UPDATE users SET invited_products = NULL WHERE id = $1`, [u.id]);
  }

  // ── WHAT THEY WILL ACTUALLY SEE. FIVE LAYERS, AND partner_id IS ONLY THE FOURTH. ────
  //
  // The first version of this counted `outreach_prospects WHERE partner_id = $1` inside a .catch()
  // that returned 0. That column DOES NOT EXIST — prospects carry source_partner_id — so the query
  // threw, the catch swallowed it, and the script printed a confident "0 prospect rows" with an
  // explanation that was the DEALS rule (layer 4) applied to a table governed by TERRITORY
  // (layer 5). A silently caught error reporting a plausible zero is worse than a crash.
  //
  // src/lib/products/territory-scope.js is the authority:
  //   source_partner_id = theirs                → ALWAYS visible, territory or not
  //   source_partner_id = another partner's      → NEVER visible
  //   source_partner_id NULL (our own leads)     → visible only INSIDE their granted territory
  //   no territory rows at all                   → FALSE → nothing
  //
  // So fixing partner_id makes them a partner. It does NOT give them a prospect list. No throwaway
  // catch here: if a query fails, say so, because that is a different answer from zero.
  let terr = null;
  try {
    terr = (await query(
      `SELECT dimension, value, exclusive FROM partner_territories
        WHERE partner_id = $1 ORDER BY dimension, value`, [pid])).rows;
  } catch (e) {
    console.log(`\n  ⚠ could not read partner_territories: ${e.message}`);
  }
  let own = null;
  try {
    own = (await query(
      `SELECT COUNT(*)::int n FROM prospects WHERE product = 'sitenex' AND source_partner_id = $1`,
      [pid])).rows[0].n;
  } catch (e) {
    console.log(`  ⚠ could not count their referred prospects: ${e.message}`);
  }

  console.log('\n  WHAT THEY WILL SEE');
  console.log(`    their own referred prospects   ${own == null ? 'unknown (query failed)' : own}`);
  if (terr == null) {
    console.log('    granted territory              unknown (query failed)');
  } else if (!terr.length) {
    console.log('    granted territory              NONE  ← so NONE of our own leads are visible');
    console.log('\n  Prospects are scoped by TERRITORY, not by partner ownership — a prospect is OUR lead,');
    console.log('  and the question is whether it falls inside the patch granted to them. With no');
    console.log('  territory rows the scope is FALSE and they see nothing of ours. That is fail-closed');
    console.log('  by design, not a bug: "nobody decided what this partner may see" safely reads as');
    console.log('  "nothing" rather than "our whole lead list".');
    console.log('\n  → Grant a territory on the SiteNex Partners page. Until then, linking partner_id');
    console.log('    has made them a partner but given them nothing to look at.');
  } else {
    console.log(`    granted territory              ${terr.length} grant(s):`);
    for (const t of terr) {
      console.log(`      ${t.dimension} = ${t.value}${t.exclusive ? '  (exclusive)' : ''}`);
    }
    console.log('\n  Our own leads inside those grants are visible to them, plus anything they referred.');
  }
}

main().then(() => process.exit(0))
      .catch((e) => { console.error('repair error:', e.message); process.exit(1); });
