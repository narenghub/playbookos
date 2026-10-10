#!/usr/bin/env node
// ── GRANT A PARTNER A PATCH, AND PROVE THEY CAN SEE IT ────────────────────────
//
//   node scripts/grant-partner-territory.js --partner=1 --region='Chicago, IL' --region='Rockford, IL'
//   node scripts/grant-partner-territory.js --partner=1 --region='Chicago, IL' --region='Rockford, IL' --execute
//
// ACBM Partners has credentials, a signed-off price list, outreach content, a deals board and a
// contract generator — and holds NO territory, so territoryScopeSql fails closed and they see
// nothing. Every other piece of SiteNex is finished and nobody can sell, which makes this two rows
// the most valuable two rows in the product.
//
// ── WHY A SCRIPT WHEN POST /api/sitenex/territories ALREADY EXISTS ───────────
//
// The route is good and this does not replace it. What the route cannot do is answer the question
// that actually matters afterwards: CAN THEY NOW SEE THE LIST? It returns "ACBM Partners now sees prospects
// matching region 'Chicago, IL'", which is a restatement of the insert, not a measurement. Nobody
// has ever run the chain users.partner_id → partner_territories → territoryScopeSql → prospects
// end to end, and the last time an access path went untested a partner sat blocked while /health
// said everything was fine.
//
// ── EXCLUSIVE DEFAULTS TO TRUE, WHICH IS THE TRAP ───────────────────────────
//
// `partner_territories.exclusive` is NOT NULL DEFAULT TRUE and the route only turns it off if the
// body explicitly says `exclusive: false`. So the easy path — grant a region, say nothing about
// exclusivity — hands over an EXCLUSIVE patch, locks it against your own team and any future
// partner behind a partial unique index, and nothing in the response says so loudly.
//
// This script inverts that: non-exclusive unless `--exclusive` is passed, and it says which it is
// doing on every line. An exclusive patch is a contractual commitment and nothing in the ACBM Partners
// agreement obliges one yet — the revenue-share tiers are still blank.
//
// ── IT REFUSES A GRANT THAT MATCHES NOTHING ─────────────────────────────────
//
// `state` is blank on all 1,524 SiteNex prospects, so `--state=IL` would insert a row, return 201,
// read correctly in every listing, and show the partner zero prospects forever. A grant that
// matches no rows is indistinguishable from no grant at all except that it looks done.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { DIMENSIONS, DIMENSION_COLUMN, territoryScopeSql } = require('../src/lib/products/territory-scope');

const EXECUTE = process.argv.includes('--execute');
const EXCLUSIVE = process.argv.includes('--exclusive');

const PARTNER_ID = (() => {
  const hit = process.argv.find((a) => a.startsWith('--partner='));
  const n = hit ? parseInt(hit.split('=')[1], 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
})();

// Each --<dimension>=<value> becomes one grant. Repeatable, and territories are OR'd, so two grants
// hand over the SUM of their rows, never the overlap.
const GRANTS = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)=(.+)$/.exec(arg);
  if (!m) continue;
  const [, dim, value] = m;
  if (!DIMENSIONS.includes(dim)) continue;
  GRANTS.push({ dimension: dim, value: value.trim() });
}

const OURS = `product = 'sitenex' AND source_partner_id IS NULL`;

async function main() {
  await initDB();

  if (!PARTNER_ID || !GRANTS.length) {
    console.log('usage: --partner=<id> --<dimension>=<value> [more] [--exclusive] [--execute]');
    console.log(`       dimensions: ${DIMENSIONS.join(', ')}`);
    console.log("       e.g. --partner=1 --region='Chicago, IL' --region='Rockford, IL'");
    process.exit(1);
  }

  const partner = (await query(`SELECT id, name, status FROM partners WHERE id = $1`, [PARTNER_ID])).rows[0];
  if (!partner) { console.log(`✗ no partner with id ${PARTNER_ID}`); process.exit(1); }

  const total = (await query(`SELECT COUNT(*)::int n FROM prospects WHERE ${OURS}`)).rows[0].n;
  console.log(`── territory grant · ${partner.name} (id ${partner.id}, ${partner.status})\n`);
  console.log(`   ${total} SiteNex prospects are ours and therefore territory-gated`);
  console.log(`   this grant is ${EXCLUSIVE ? 'EXCLUSIVE — it LOCKS the patch against your own team and any' : 'NON-EXCLUSIVE — shared, which is the reversible choice'}`);
  if (EXCLUSIVE) console.log('   future partner, behind a partial unique index. Nothing in the agreement obliges this.');

  // ── WHAT THEY HOLD NOW ────
  const existing = (await query(
    `SELECT id, dimension, value, exclusive FROM partner_territories
      WHERE partner_id = $1 ORDER BY dimension, value`, [PARTNER_ID])).rows;
  console.log(`\n   currently holds ${existing.length} territor${existing.length === 1 ? 'y' : 'ies'}:`);
  for (const t of existing) {
    console.log(`      ${t.dimension} = ${JSON.stringify(t.value)}${t.exclusive ? '  [exclusive]' : ''}`);
  }
  if (!existing.length) console.log('      — none, so they currently see NOTHING of ours (fail closed)');

  // ── WHAT EACH GRANT WOULD ACTUALLY REACH ────
  let fatal = 0;
  console.log(`\n   proposed:`);
  for (const g of GRANTS) {
    const col = DIMENSION_COLUMN[g.dimension];
    const n = (await query(
      `SELECT COUNT(*)::int n FROM prospects WHERE ${OURS} AND ${col} = $1`, [g.value])).rows[0].n;
    g.matches = n;
    const pct = total ? Math.round((n / total) * 100) : 0;

    const already = existing.find((t) => t.dimension === g.dimension && t.value === g.value);
    const holder = (await query(
      `SELECT p.id, p.name FROM partner_territories t JOIN partners p ON p.id = t.partner_id
        WHERE t.dimension = $1 AND t.value = $2 AND t.exclusive AND t.partner_id <> $3 LIMIT 1`,
      [g.dimension, g.value, PARTNER_ID])).rows[0];

    console.log(`      ${g.dimension} = ${JSON.stringify(g.value).padEnd(20)} ${String(n).padStart(5)} prospects  ${String(pct).padStart(3)}%`);

    // A grant that reaches nothing is the silent failure this script exists to stop. It inserts, it
    // returns 201, it reads back correctly, and the partner sees zero rows forever.
    if (n === 0) {
      fatal += 1;
      console.log(`         ✗ MATCHES NOTHING. This would insert a row and grant no access at all.`);
      if (g.dimension === 'state') {
        console.log(`           'state' is blank on all ${total} SiteNex prospects — no state grant can reach any row.`);
      } else {
        const near = (await query(
          `SELECT DISTINCT ${col} v FROM prospects WHERE ${OURS} AND ${col} ILIKE $1 LIMIT 5`,
          [`%${g.value}%`])).rows.map((r) => r.v).filter(Boolean);
          if (near.length) console.log(`           did you mean: ${near.map((v) => JSON.stringify(v)).join(' · ')}`);
      }
    }
    if (already) {
      console.log(`         already granted${already.exclusive === EXCLUSIVE ? '' : ` (currently ${already.exclusive ? 'exclusive' : 'non-exclusive'})`} — will be skipped`);
      g.skip = true;
    }
    if (holder) {
      fatal += 1;
      console.log(`         ✗ held EXCLUSIVELY by ${holder.name} (partner ${holder.id}) — the unique index will refuse this.`);
    }
  }

  const newGrants = GRANTS.filter((g) => !g.skip && g.matches > 0);
  // OR'd, so the reach is the union — computed as a union rather than a sum, because two dimensions
  // can overlap and summing them would overstate what is being handed over.
  if (newGrants.length) {
    const clauses = newGrants.map((g, i) => `${DIMENSION_COLUMN[g.dimension]} = $${i + 1}`).join(' OR ');
    const union = (await query(
      `SELECT COUNT(*)::int n FROM prospects WHERE ${OURS} AND (${clauses})`,
      newGrants.map((g) => g.value))).rows[0].n;
    console.log(`\n   together they reach ${union} of ${total} prospects (${Math.round((union / total) * 100)}%)` +
                ` — a union, not a sum, because dimensions can overlap`);
  }

  if (fatal) {
    console.log(`\n   ✗ ${fatal} problem(s) above. Nothing written. Fix the values and re-run.\n`);
    process.exit(1);
  }
  if (!EXECUTE) {
    console.log('\n   DRY RUN — nothing written. Re-run with --execute.\n');
    await verifyVisibility(partner, 'as things stand TODAY');
    return;
  }

  // ── THE WRITE ────
  // created_by is left NULL: this is an ops script with no acting user, and inventing one would put
  // a false name on the audit trail. The column is nullable for exactly this case.
  let written = 0;
  for (const g of newGrants) {
    try {
      await query(
        `INSERT INTO partner_territories (partner_id, dimension, value, exclusive, created_by)
         VALUES ($1,$2,$3,$4,NULL)`,
        [PARTNER_ID, g.dimension, g.value, EXCLUSIVE]);
      written += 1;
      console.log(`      ✓ granted ${g.dimension} = ${JSON.stringify(g.value)}`);
    } catch (e) {
      if (e.code === '23505') { console.log(`      — ${g.dimension} = ${JSON.stringify(g.value)} already present`); }
      else throw e;
    }
  }
  console.log(`\n   ✅ ${written} territor${written === 1 ? 'y' : 'ies'} granted.\n`);

  await verifyVisibility(partner, 'AFTER the grant');
}

// ── THE PART THE ROUTE CANNOT DO ─────────────────────────────────────────────
//
// Read-only, and it runs as the REAL ACBM Partners accounts rather than a fixture, because the thing being
// tested is the chain users.partner_id → partner_territories → territoryScopeSql → prospects and a
// fixture user would prove only that the function works on a user I built to make it work.
//
// Nothing is written and no account is modified: CLAUDE.md's rule is that a verification may only
// touch rows it created, and the honest way to satisfy that here is to touch none.
async function verifyVisibility(partner, when) {
  console.log(`   ── can they actually see it, ${when} ────`);

  const users = (await query(
    `SELECT id, email, role, status FROM users WHERE partner_id = $1 ORDER BY email`, [partner.id])).rows;
  if (!users.length) {
    console.log(`   ⚠ no user account is linked to ${partner.name} (users.partner_id = ${partner.id}).`);
    console.log(`     The territory is granted to the FIRM; a person still needs an account bound to it.`);
    console.log(`     Run scripts/diagnose-partner-accounts.js to see who is unlinked.\n`);
    return;
  }

  for (const u of users) {
    const scope = await territoryScopeSql(u, 'p', 1);
    if (scope.isStaff) {
      console.log(`   ⚠ ${u.email} resolves as STAFF — it would see every prospect, not a territory.`);
      continue;
    }
    if (scope.failed) {
      console.log(`   ✗ ${u.email} (${u.role}, ${u.status}) → BLOCKED: ${scope.reason}`);
      continue;
    }
    const n = (await query(
      `SELECT COUNT(*)::int n FROM prospects p WHERE p.product = 'sitenex' AND ${scope.sql}`,
      scope.params)).rows[0].n;
    const note = scope.reason ? ` [${scope.reason}]` : '';
    const verdict = n > 0 ? '✓' : '✗';
    console.log(`   ${verdict} ${u.email} (${u.role}, ${u.status}) → ${n} prospect(s) visible` +
                ` across ${scope.territories.length} territor${scope.territories.length === 1 ? 'y' : 'ies'}${note}`);
    if (n === 0) {
      console.log(`       A real login would show an empty list. That is the state ACBM Partners is in now.`);
    }
  }

  // And the other direction: a partner's own book is theirs whatever the patch says, and another
  // partner's introductions must stay invisible even where non-exclusive patches overlap.
  const others = (await query(
    `SELECT COUNT(*)::int n FROM prospects
      WHERE product = 'sitenex' AND source_partner_id IS NOT NULL AND source_partner_id <> $1`,
    [partner.id])).rows[0].n;
  if (others) {
    console.log(`   (${others} prospect(s) were introduced by OTHER partners — invisible to ${partner.name}`);
    console.log(`    regardless of territory, which is what makes a non-exclusive overlap safe.)`);
  }
  console.log();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('grant-partner-territory failed:', e && e.message ? e.message : e);
  process.exit(1);
});
