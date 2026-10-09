// ── CPHI: ONE FLOOR, THREE KINDS OF COMPANY ───────────────────────────────────
//
//   node scripts/migrate-cphi-roles.js
//
// Until now every row in cphi_exhibitor_matches was an API supplier, because the only list ever
// checked against the Milan directory was the DMF holders. A trade floor carries three things worth
// walking to, and they are different conversations:
//
//   supplier          an API / DMF holder. We are BUYING. The ask is capacity, lead time, second
//                     source.
//   platform_partner  an EU manufacturer or CDMO that could hold client relationships locally the
//                     way ACBM Partners does in the US. We are PARTNERING. The ask is whose clients they
//                     already serve; the offer is the platform and offshore delivery behind it.
//   qc_lab            an analytical testing laboratory. We are RECRUITING it into LabConnect. The
//                     ask is which tests under GMP, turnaround, price — the offer is filled capacity.
//   buyer             a manufacturer with no analytical registration of its own. We are SELLING
//                     testing to it. A displacement sale: it already sends its testing somewhere.
//
// The last three carry a `market` (us / eu / row), because the partner and buyer conversations run on
// both sides of the Atlantic and the floor list has to be filterable down to one. See
// src/lib/cphi/markets.js for what the column means and where it is blunt.
//
// ── WHY role JOINS THE UNIQUE KEY ────────────────────────────────────────────
//
// One company can legitimately be two of these. A firm that manufactures AND runs a laboratory is a
// supplier on one list and a qc_lab on another, with different counts and a different ask at the
// same booth. Keyed on (event, holder_normalized) alone, the second import would overwrite the
// first and one of those conversations would silently disappear from the floor list.
//
// Existing rows become 'supplier', which is what they are.
//
// Manual rollback:
//   DROP INDEX IF EXISTS idx_cem_unique_role;
//   CREATE UNIQUE INDEX idx_cem_unique ON cphi_exhibitor_matches (event_slug, holder_normalized);
//   ALTER TABLE cphi_exhibitor_matches DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS role_note,
//                                      DROP COLUMN IF EXISTS market;

const { initDB, query } = require('../src/lib/db');

// MUST MATCH CPHI_ROLES in src/api/routes.js.
// Read from the event registry, which is now the single place a role is defined. Adding a role to
// an event there and re-running this migration are the only two steps — before this, the list lived
// here AND in routes.js AND as literals in the front end, and they drifted.
//
// SCOPE Europe 2026 adds abiozen / aros / linkable. Those are a different KIND of role: CPHI's four
// say what we want FROM a company, SCOPE's three say what the company buys FROM US. Same table,
// because it is already partitioned by event_slug and keyed on (event_slug, role,
// holder_normalized) — see the note at the top of src/lib/events/registry.js about the name.
const { allRoleKeys } = require('../src/lib/events/registry');
const ROLES = allRoleKeys();

async function migrate() {
  await initDB();

  await query(`
    ALTER TABLE cphi_exhibitor_matches
      ADD COLUMN IF NOT EXISTS role      TEXT NOT NULL DEFAULT 'supplier',
      ADD COLUMN IF NOT EXISTS role_note TEXT,
      ADD COLUMN IF NOT EXISTS market    TEXT;
  `);

  // DROPPED AND RE-ADDED rather than added tolerantly. An earlier run of this script created the
  // constraint with three roles; "add, ignore already exists" would then leave the narrow version in
  // place and every platform_partner insert would fail against a constraint that looks correct in
  // this file. Widening a CHECK means replacing it.
  await query(`ALTER TABLE cphi_exhibitor_matches DROP CONSTRAINT IF EXISTS cem_role_valid`);
  await query(`ALTER TABLE cphi_exhibitor_matches
                 ADD CONSTRAINT cem_role_valid
                 CHECK (role IN (${ROLES.map(r => `'${r}'`).join(',')}))`);
  // 'row' is storable but not a filter — a company outside the US and EU is still worth a row.
  await query(`ALTER TABLE cphi_exhibitor_matches DROP CONSTRAINT IF EXISTS cem_market_valid`);
  await query(`ALTER TABLE cphi_exhibitor_matches
                 ADD CONSTRAINT cem_market_valid
                 CHECK (market IS NULL OR market IN ('us','eu','row'))`);

  // The key swap. Create the new index FIRST, then drop the old one: if creating it fails — which
  // it will if two rows already collide on the new key — the table is left exactly as it was
  // rather than unprotected.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cem_unique_role
                 ON cphi_exhibitor_matches (event_slug, role, holder_normalized)`);
  await query(`DROP INDEX IF EXISTS idx_cem_unique`);

  await query(`CREATE INDEX IF NOT EXISTS idx_cem_role
                 ON cphi_exhibitor_matches (event_slug, role, exhibiting, molecules_covered DESC)`);

  await query(`CREATE INDEX IF NOT EXISTS idx_cem_market
                 ON cphi_exhibitor_matches (event_slug, role, market)`);

  const counts = (await query(
    `SELECT role, COALESCE(market,'—') market, COUNT(*)::int n
       FROM cphi_exhibitor_matches GROUP BY 1,2 ORDER BY 3 DESC`)).rows;
  console.log('✅ CPHI roles applied.');
  for (const r of counts) console.log(`   ${String(r.role).padEnd(18)} ${String(r.market).padEnd(4)} ${r.n}`);
  if (!counts.length) console.log('   (no rows yet)');
  console.log(`\n   valid roles: ${ROLES.join(', ')}`);
  process.exit(0);
}

migrate().catch(e => { console.error('CPHI roles migration error:', e.message); process.exit(1); });
