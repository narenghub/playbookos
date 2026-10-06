// ── CPHI: ONE FLOOR, THREE KINDS OF COMPANY ───────────────────────────────────
//
//   node scripts/migrate-cphi-roles.js
//
// Until now every row in cphi_exhibitor_matches was an API supplier, because the only list ever
// checked against the Milan directory was the DMF holders. A trade floor carries three things worth
// walking to, and they are different conversations:
//
//   supplier   an API / DMF holder. We are BUYING. The ask is capacity, lead time, second source.
//   qc_lab     an analytical testing laboratory. We are RECRUITING it into LabConnect. The ask is
//              which tests under GMP, turnaround, price — and the offer is filled capacity.
//   buyer      a manufacturer with no analytical registration of its own. We are SELLING testing
//              to it. A displacement sale: it already sends its testing somewhere.
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
//   ALTER TABLE cphi_exhibitor_matches DROP COLUMN IF EXISTS role, DROP COLUMN IF EXISTS role_note;

const { initDB, query } = require('../src/lib/db');

const ROLES = ['supplier', 'qc_lab', 'buyer'];

async function migrate() {
  await initDB();

  await query(`
    ALTER TABLE cphi_exhibitor_matches
      ADD COLUMN IF NOT EXISTS role      TEXT NOT NULL DEFAULT 'supplier',
      ADD COLUMN IF NOT EXISTS role_note TEXT;
  `);

  // CHECK constraint added separately and tolerantly: the column may already carry rows, and a
  // failed constraint should say so rather than abort the whole migration halfway.
  try {
    await query(`ALTER TABLE cphi_exhibitor_matches
                   ADD CONSTRAINT cem_role_valid CHECK (role IN ('supplier','qc_lab','buyer'))`);
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
  }

  // The key swap. Create the new index FIRST, then drop the old one: if creating it fails — which
  // it will if two rows already collide on the new key — the table is left exactly as it was
  // rather than unprotected.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cem_unique_role
                 ON cphi_exhibitor_matches (event_slug, role, holder_normalized)`);
  await query(`DROP INDEX IF EXISTS idx_cem_unique`);

  await query(`CREATE INDEX IF NOT EXISTS idx_cem_role
                 ON cphi_exhibitor_matches (event_slug, role, exhibiting, molecules_covered DESC)`);

  const counts = (await query(
    `SELECT role, COUNT(*)::int n FROM cphi_exhibitor_matches GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log('✅ CPHI roles applied.');
  for (const r of counts) console.log(`   ${String(r.role).padEnd(10)} ${r.n}`);
  if (!counts.length) console.log('   (no rows yet)');
  console.log(`\n   valid roles: ${ROLES.join(', ')}`);
  process.exit(0);
}

migrate().catch(e => { console.error('CPHI roles migration error:', e.message); process.exit(1); });
