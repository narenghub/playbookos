#!/usr/bin/env node
// ── WHY A PARTNER WHO ACCEPTED STILL READS "INVITED" AND SEES NOTHING. ────────
//
//   railway ssh 'node scripts/diagnose-partner-accounts.js'
//
// READ ONLY. No writes, no fixtures, nothing to clean up. It answers four questions that have to be
// answered from the real rows before anything is changed, because each one points at a different
// fix and guessing between them would mean writing to production on a hunch.
//
//   1. Does the account have joined_at? The Status badge is `!u.joined_at ? 'Invited' : 'Active'`,
//      and /auth/accept-invite DOES set joined_at. So "Invited" means that route never completed
//      for this account — they got credentials some other way.
//   2. Does the account have a partner_id? /auth/accept-invite never sets one. This is a confirmed
//      code defect, not a guess, and it is why a partner sees no rows: partnerScopeSql returns
//      FALSE for an external role with a NULL partner_id. That is correct, protective behaviour —
//      the alternative would show them every partner's pipeline — but nothing ever sets the value.
//   3. Is there still an invite_token? A token present with a password present means two different
//      paths touched the row.
//   4. What is BASE_URL? The invite email builds its link from
//      `process.env.BASE_URL || 'https://playbookos-production.up.railway.app'`, and production is
//      now app.playnexa.ai. An unset BASE_URL sends partners to the old host.
'use strict';

const { query } = require('../src/lib/db');
const { isExternalRole } = require('../src/lib/roles');

async function main() {
  console.log('── partner account diagnosis · READ ONLY\n');

  // ── 4 first, because it is free and might explain everything else. ────
  const base = process.env.BASE_URL || null;
  console.log('BASE_URL (what invite emails link to):');
  if (!base) {
    console.log('  ⚠ NOT SET → invite links point at https://playbookos-production.up.railway.app');
    console.log('    Production is app.playnexa.ai. Set BASE_URL in Railway Variables to');
    console.log('    https://app.playnexa.ai so an invite link lands on the live host.');
  } else {
    console.log(`  ${base}`);
    if (!/app\.playnexa\.ai/.test(base)) console.log('  ⚠ does not point at app.playnexa.ai');
  }
  console.log();

  // ── The partners table. ────
  let partners = [];
  try {
    partners = (await query(`SELECT id, name, primary_contact_email, status, created_at
                               FROM partners ORDER BY id`)).rows;
  } catch (e) {
    console.log(`partners table: NOT PRESENT (${e.message})`);
    console.log('  → run scripts/migrate-sitenex-rename.js first.\n');
  }
  if (partners.length) {
    console.log(`partners (${partners.length}):`);
    for (const p of partners) {
      console.log(`  id=${String(p.id).padEnd(3)} ${String(p.name).padEnd(24)} ${String(p.status).padEnd(8)} ${p.primary_contact_email || '—'}`);
    }
    console.log();
  }

  // ── Every account on an external role: the ones that should have a partner_id. ────
  const users = (await query(
    `SELECT id, email, name, role, joined_at, invited_at, is_active, partner_id,
            (invite_token IS NOT NULL) AS has_token,
            (password_hash IS NOT NULL) AS has_password
       FROM users ORDER BY invited_at NULLS LAST, email`)).rows;

  const external = users.filter((u) => isExternalRole(u.role));
  console.log(`accounts on an EXTERNAL role (${external.length} of ${users.length} total):`);
  if (!external.length) {
    console.log('  none — so no account is currently scoped to a partner.');
  }
  for (const u of external) {
    const badge = !u.joined_at ? 'INVITED' : (u.is_active ? 'ACTIVE' : 'INACTIVE');
    console.log(`\n  ${u.email}`);
    console.log(`    role          ${u.role}`);
    console.log(`    Status badge  ${badge}   (from joined_at, which is ${u.joined_at ? 'set' : 'NULL'})`);
    console.log(`    partner_id    ${u.partner_id == null ? 'NULL  ← sees NO rows (fail-closed, by design)' : u.partner_id}`);
    console.log(`    password      ${u.has_password ? 'set' : 'NOT SET — cannot log in'}`);
    console.log(`    invite_token  ${u.has_token ? 'STILL PRESENT' : 'cleared'}`);

    // The diagnosis, stated rather than left to be worked out.
    const problems = [];
    if (u.has_password && !u.joined_at) {
      problems.push('has a password but no joined_at → they set credentials WITHOUT going through ' +
                    '/auth/accept-invite, so the badge reads Invited and the product grants that ' +
                    'route writes were never written either. Check user_products below.');
    }
    if (!u.has_password && u.has_token) {
      problems.push('invite not accepted yet — the link may have pointed at the old host (see BASE_URL).');
    }
    if (u.partner_id == null) {
      problems.push('no partner_id → every partner-scoped query returns FALSE for this account. ' +
                    'This is the confirmed code defect: /auth/accept-invite never sets it.');
    }
    if (u.has_password && u.has_token) {
      problems.push('password AND token both present → two paths touched this row.');
    }
    for (const p of problems) console.log(`    ⚠ ${p}`);

    const prods = (await query(`SELECT product FROM user_products WHERE user_id = $1 ORDER BY product`,
      [u.id])).rows.map((r) => r.product);
    console.log(`    products      ${prods.length ? prods.join(', ') : 'NONE ← cannot see any product surface'}`);
  }

  // ── What they would be looking for: is there anything to see? ────
  console.log('\n\nsitenex data, by owner:');
  for (const [label, sql] of [
    ['prospects', `SELECT partner_id, COUNT(*)::int n FROM outreach_prospects GROUP BY 1 ORDER BY 1 NULLS FIRST`],
    ['deals',     `SELECT partner_id, COUNT(*)::int n FROM sitenex_deals     GROUP BY 1 ORDER BY 1 NULLS FIRST`],
  ]) {
    try {
      const rows = (await query(sql)).rows;
      if (!rows.length) { console.log(`  ${label.padEnd(10)} no rows at all`); continue; }
      for (const r of rows) {
        const who = r.partner_id == null ? 'NULL (self-sourced, ours)' : `partner ${r.partner_id}`;
        console.log(`  ${label.padEnd(10)} ${String(r.n).padStart(5)} rows · ${who}`);
      }
    } catch (e) {
      console.log(`  ${label.padEnd(10)} could not read (${e.message})`);
    }
  }
  console.log('\n  A partner sees ONLY rows whose partner_id equals theirs. Rows with partner_id NULL');
  console.log('  are self-sourced and deliberately invisible to them — so even once the link is');
  console.log('  fixed, a partner with no referred rows correctly sees an empty board.');

  console.log('\n── nothing was written.');
}

main().then(() => process.exit(0))
      .catch((e) => { console.error('diagnosis error:', e.message); process.exit(1); });
