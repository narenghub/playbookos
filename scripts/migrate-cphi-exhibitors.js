// ── CPHI sourcing: exhibitor-match schema (additive, standalone, NOT wired into boot) ──
//
// One row per (event, DMF holder): is this API manufacturer on the show floor, at which booth,
// and how confident is the name match.
//
// molecules_covered is DENORMALISED on purpose. It is the demand-rank at the time of the run —
// derived from study_molecules + clinical_studies + molecule_dmf_matches, all of which move
// when the quarterly DMF file lands. Storing it makes each run a dated snapshot you can compare
// quarter to quarter, which recomputing on read would destroy.
//
// review_status gates two different problems:
//   auto_confirmed  exact/core name match - same legal entity, safe to act on.
//   entity_review   `prefix` match. The BOOTH is right but the entity may be a parent or
//                   sibling (UMICORE ARGENTINA SA -> UMICORE AG & CO. KG). Fine for a
//                   conversation on the floor, wrong for a contract.
//   unreviewed      `token` match. ~50% wrong. Never act on it unverified.
//
// Standalone: nothing imports it, so it does NOT run on boot. Run manually:
//   node scripts/migrate-cphi-exhibitors.js
//
// Manual rollback:
//   DROP TABLE IF EXISTS cphi_exhibitor_matches;

const { initDB, query } = require('../src/lib/db');

async function migrateCphiExhibitors() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS cphi_exhibitor_matches (
      id                BIGSERIAL PRIMARY KEY,
      event_slug        TEXT NOT NULL,          -- e.g. 'cphi-milan-2026'
      holder            TEXT NOT NULL,          -- DMF holder, verbatim from dmf_holders
      holder_normalized TEXT NOT NULL,          -- join key back to dmf_holders
      exhibiting        BOOLEAN NOT NULL,
      exhibitor_name    TEXT,                   -- the name as it appears on the CPHI stand
      booth             TEXT,
      hall              TEXT,                   -- leading digits of the booth (CPHI hall number)
      match_tier        TEXT,                   -- exact | core | prefix | token
      molecules_covered INTEGER NOT NULL DEFAULT 0,
      review_status     TEXT NOT NULL DEFAULT 'unreviewed',
      searched_terms    TEXT,                   -- what we actually queried, for auditing a miss
      checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_cem_exhibiting ON cphi_exhibitor_matches (event_slug, exhibiting, molecules_covered DESC);
    CREATE INDEX IF NOT EXISTS idx_cem_review ON cphi_exhibitor_matches (review_status);
    CREATE INDEX IF NOT EXISTS idx_cem_holder ON cphi_exhibitor_matches (holder_normalized);
  `);

  // ── idx_cem_unique, SEPARATED FROM THE BLOCK ABOVE AND GUARDED ──────────────────────────────────
  //
  // `CREATE UNIQUE INDEX IF NOT EXISTS idx_cem_unique ON cphi_exhibitor_matches
  //  (event_slug, holder_normalized)` used to sit inside that one multi-statement query. On the real
  // production dump it failed:
  //
  //     CPHI migration error: could not create unique index "idx_cem_unique"
  //
  // which is Postgres saying the table ALREADY CONTAINS duplicate (event_slug, holder_normalized)
  // pairs. The index has never existed on production, so nothing ever stopped them accumulating, and
  // because the statement was bundled with the CREATE TABLE the failure took the whole step down and
  // halted the chain — with an error message that named the index and not one of the rows.
  //
  // THE DUPLICATES ARE NOT DELETED HERE BY DEFAULT. Two columns carry human work:
  // `entity_note` — and ONLY entity_note (ruling 38 option 2). review_status's non-default values on
  // (free text, added by scripts/migrate-cphi-entity-note.js). The rest of the row is derived from a
  // search and is recomputable. A migration that silently picked a survivor could discard a review,
  // and no later run could tell it had.
  //
  // So: report every duplicate group precisely, and refuse. This step has NO ability to delete a row,
  // with any flag — reconciliation lives in scripts/cphi-reconcile.js, which produces a plan a person
  // reviews, preserves human work by carrying it onto the survivor, records the complete prior
  // contents of everything it changes, and refuses a plan whose rows have since moved.
  // this data are 'entity_review' and 'auto_confirmed', both machine-assigned: four seeding scripts
  // write 'entity_review' as a literal, migrate-cphi-entity-note.js backfills notes WHERE
  // review_status='entity_review' AND entity_note IS NULL (the machine marks, the human annotates),
  // and build-cphi-briefing.js renders it as a "confirm the legal entity" caveat. Counting them as
  // human work made the real dump report one CONFLICT that was two machine labels disagreeing with
  // nothing written on either row.
  const HUMAN = `(entity_note IS NOT NULL AND btrim(entity_note) <> '')`;
  const hasNote = (await query(
    `SELECT COUNT(*)::int n FROM information_schema.columns
      WHERE table_name = 'cphi_exhibitor_matches' AND column_name = 'entity_note'`)).rows[0].n > 0;
  // entity_note is added by a later step, so on a database where that has not run yet the predicate
  // has to fall back to review_status alone rather than erroring on a missing column.
  // Without the column there is no human-authored field in this table at all, so nothing is at risk.
  const humanPredicate = hasNote ? HUMAN : 'false';

  const indexExists = (await query(
    `SELECT COUNT(*)::int n FROM pg_indexes
      WHERE tablename = 'cphi_exhibitor_matches' AND indexname = 'idx_cem_unique'`)).rows[0].n > 0;

  if (indexExists) {
    console.log('↷ idx_cem_unique already present');
  } else {
    const groups = (await query(
      `SELECT event_slug, holder_normalized, COUNT(*)::int n,
              COUNT(*) FILTER (WHERE ${humanPredicate})::int human,
              array_agg(id ORDER BY id) ids
         FROM cphi_exhibitor_matches
        GROUP BY event_slug, holder_normalized
       HAVING COUNT(*) > 1
        ORDER BY COUNT(*) FILTER (WHERE ${humanPredicate}) DESC, COUNT(*) DESC`)).rows;

    if (!groups.length) {
      await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cem_unique
                   ON cphi_exhibitor_matches (event_slug, holder_normalized)`);
      console.log('✅ idx_cem_unique created — no duplicate (event_slug, holder_normalized) pairs');
    } else {
      const conflicts = groups.filter((g) => g.human >= 2);
      const resolvable = groups.filter((g) => g.human < 2);
      const redundant = resolvable.reduce((n, g) => n + (g.n - 1), 0);

      console.log(`\n⚠️  cphi_exhibitor_matches has ${groups.length} duplicate ` +
        `(event_slug, holder_normalized) pair(s), so idx_cem_unique cannot be created.`);
      console.log(`    ${resolvable.length} group(s) resolvable without losing human work ` +
        `(${redundant} redundant row(s))`);
      console.log(`    ${conflicts.length} group(s) hold TWO OR MORE reviewed/annotated rows — a person must choose\n`);

      for (const g of groups.slice(0, 25)) {
        console.log(`    ${g.human >= 2 ? 'CONFLICT' : 'resolvable'}  ${g.event_slug} / ${g.holder_normalized}` +
          ` — ${g.n} rows (${g.human} with review or note), ids ${g.ids.join(', ')}`);
      }
      if (groups.length > 25) console.log(`    … and ${groups.length - 25} more`);

      if (conflicts.length) {
        console.error(`\n❌ ${conflicts.length} group(s) hold more than one reviewed or annotated row. ` +
          `Nothing has been changed.`);
        console.error(`   Decide which row survives in each, delete the others, then re-run. To see them:\n`);
        console.error(`     SELECT id, event_slug, holder_normalized, review_status, exhibitor_name, booth, checked_at`);
        console.error(`       FROM cphi_exhibitor_matches`);
        console.error(`      WHERE (event_slug, holder_normalized) IN (${conflicts.slice(0, 5)
          .map((g) => `('${g.event_slug}','${g.holder_normalized}')`).join(', ')})`);
        console.error(`      ORDER BY event_slug, holder_normalized, id;\n`);
        process.exit(1);
      }

      // ── THE MIGRATION CANNOT DELETE. THAT IS THE POINT. ───────────────────────────────────────
      //
      // An earlier version of this step took `--resolve-duplicates` and did the cleanup itself. It
      // worked and it was tested, and it was still the wrong shape: two destructive paths for one
      // table, and the one nobody reads is the one that runs. Ruling 35 asks for duplicate handling
      // that is fail-closed by default, with a reviewable plan, an audit trail and a recovery route —
      // none of which belong inside a migration step that a chain runs unattended.
      //
      // So this step now has no ability to delete anything, ever, with any flag. It reports and
      // refuses. All reconciliation goes through scripts/cphi-reconcile.js, which writes a plan a
      // person can read, records the complete prior contents of every row it touches, refuses a group
      // whose rows have changed since the plan was made, and is a no-op when run twice.
      console.error(`❌ ${redundant} row(s) would have to go to create this index, and this step `
        + `cannot delete anything.`);
      console.error(`   Nothing has been changed.\n`);
      console.error(`   Reconciliation has one path, and it is not this one:\n`);
      console.error(`     node scripts/cphi-reconcile.js                     # read-only report + plan`);
      console.error(`     node scripts/cphi-reconcile.js --apply <plan.json> --confirm-not-production\n`);
      console.error(`   It carries human work across rather than losing it with the row, flags groups`);
      console.error(`   no rule can settle, and records every change in cphi_reconcile_audit.\n`);
      process.exit(1);
    }
  }

  console.log('✅ CPHI schema applied (cphi_exhibitor_matches)');
  process.exit(0);
}

migrateCphiExhibitors().catch(e => { console.error('CPHI migration error:', e.message); process.exit(1); });
