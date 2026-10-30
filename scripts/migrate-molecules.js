#!/usr/bin/env node
// ── E1: THE CANONICAL MOLECULE SPINE ─────────────────────────────────────────
//
//   node scripts/migrate-molecules.js            (local)
//   railway ssh 'node scripts/migrate-molecules.js'   ← NOT YET. See the note at the bottom.
//
// Safe to re-run: every statement is IF NOT EXISTS or an idempotent CREATE OR REPLACE. Creates no
// molecule rows and writes no identity mappings — that is the backfill's job, and it is a separate
// command on purpose.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
//
// Text identity. `study_molecules` is keyed `UNIQUE (study_id, LOWER(molecule_name))`, so the
// substance a row is about is a string, and three strings for one substance are three substances.
// That is the defect behind the 9 Oct "SOLE holder worldwide" error, where `Leuprolide`,
// `Leuprolide Acetate` and `Leuprorelin` split one substance's DMF holders and the page printed
// false scarcity over a substance three companies hold.
//
// ── THE RULE THE WHOLE SCHEMA ENCODES ───────────────────────────────────────
//
//     An ALIAS means "the same substance".
//     A PARENT edge means "chemically related but NOT interchangeable identity".
//
// So salts, esters and hydrates are their own `molecules` rows with a parent edge to the base, and
// only documented naming divergences (INN/USAN/BAN, spelling) become aliases. See
// src/lib/molecules/identity.js for why, and for why `canonicalMolecule()` must never be the
// identity key.
//
// ── WHY THE INVARIANTS ARE TRIGGERS AND NOT APPLICATION CODE ────────────────
//
// Because an index and a trigger cannot be forgotten by a call path written next year. The same
// reasoning as the run ledger's partial unique index: the arbiter is the database. Every rule below
// is a property of the schema, so a future ingest inherits all of it without knowing it exists.
'use strict';

const { initDB, query } = require('../src/lib/db');

// ── THE DDL IS EXPORTED, NOT INLINE ─────────────────────────────────────────
//
// scripts/check-molecule-identity-db.js applies THESE strings to a throwaway server. The repo
// learned this the hard way: a test that greps the source for query text proves the words are
// there and never that the statement runs, and a test holding its own COPY of the schema passes
// while production's schema drifts away from it. One source, two callers.
const DDL_TABLES = `
    -- ── THE SUBSTANCE ────
    CREATE TABLE IF NOT EXISTS molecules (
      id                 BIGSERIAL PRIMARY KEY,

      -- Human-quotable and stable. Generated from the id so nothing has to allocate it, and so two
      -- concurrent inserts cannot pick the same one.
      molecule_ref       TEXT GENERATED ALWAYS AS ('ABZ-Mol-' || LPAD(id::text, 6, '0')) STORED,

      preferred_name     TEXT NOT NULL,          -- the filed spelling, for display
      normalized_name    TEXT NOT NULL,          -- THE IDENTITY KEY within E1
      cas                TEXT,                   -- an identifier, NOT assumed globally unique

      -- ── NULLABLE AND UNPOPULATED IN E1 ────
      -- There is no InChIKey, SMILES or molfile anywhere in this codebase, so there is nothing to
      -- adopt: populating this means resolving names or CAS numbers against an external service.
      -- That resolver fails in the worst available direction — resolving "leuprolide acetate" by
      -- name can return the base, another salt, or a near miss, and an InChIKey written from a
      -- wrong match is WORSE THAN NULL because it looks authoritative and would then be used as
      -- the merge key. Structure resolution is its own phase and must publish a measured accuracy
      -- before anything merges on it. scripts/check-molecule-identity-db.js asserts this column is
      -- entirely NULL, so the day something starts writing it, a check fails loudly.
      inchikey           TEXT,

      -- ── DECISION 1: A CONTESTED CAS IS NOT WRITTEN AS CANONICAL ────
      -- "A missing canonical CAS is preferable to a registry number known to be contested across
      -- distinct proposed substances." selumetinib and binimetinib both carry 606143-89-9; one is
      -- wrong and the data does not say which, so cas stays NULL on both while the SOURCE values
      -- are preserved here. No owner is chosen and nothing is discarded.
      -- cas_suppressed_reason also distinguishes the three evidence states that an empty cas
      -- column would otherwise flatten into one: absent, present-but-invalid, and contested.
      cas_suppressed_reason TEXT,
      cas_source_values     TEXT,

      substance_form     TEXT NOT NULL DEFAULT 'base'
        CHECK (substance_form IN ('base','salt','ester','hydrate','solvate','mixture','other')),

      -- "chemically related but not interchangeable". NULL is normal and means one of two things,
      -- distinguished by derived_base_name: either this IS a base substance, or its base has not
      -- been independently observed in the data yet.
      parent_molecule_id BIGINT REFERENCES molecules(id),

      -- The base name the form logic derived, recorded even when no parent row exists. This is how
      -- a parent can be linked later WITHOUT inventing a molecule now: creating "testosterone" on
      -- the strength of an enanthate row and nothing else would file a derived fact as a sourced
      -- one, which the P1 provenance contract forbids.
      derived_base_name  TEXT,

      -- What was stripped to reach the form, so a human can audit the classification instead of
      -- trusting it. "acetate" and "succinate" are genuinely both salt and ester depending on the
      -- parent's chemical class, and resolve to 'other' rather than to a guess.
      form_tokens        TEXT,

      -- ── P1 PROVENANCE CONTRACT ────
      source             TEXT NOT NULL,
      source_url         TEXT,
      raw_reference      TEXT,
      collected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at        TIMESTAMPTZ,
      verification_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (verification_status IN ('unverified','verified','disputed')),
      confidence         TEXT CHECK (confidence IS NULL OR confidence IN ('low','medium','high')),
      -- Never silently promote source fact -> derived fact -> inference. This says which it is.
      derivation_method  TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_molecules_normalized ON molecules (normalized_name);
    CREATE INDEX IF NOT EXISTS idx_molecules_cas    ON molecules (cas) WHERE cas IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_molecules_parent ON molecules (parent_molecule_id)
      WHERE parent_molecule_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_molecules_base   ON molecules (derived_base_name)
      WHERE derived_base_name IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_molecules_form   ON molecules (substance_form);

    -- ── THE SAME SUBSTANCE, UNDER ANOTHER NAME ────
    CREATE TABLE IF NOT EXISTS molecule_aliases (
      id            BIGSERIAL PRIMARY KEY,
      molecule_id   BIGINT NOT NULL REFERENCES molecules(id) ON DELETE CASCADE,
      alias         TEXT NOT NULL,            -- normalized
      alias_type    TEXT NOT NULL DEFAULT 'other'
        CHECK (alias_type IN ('inn','usan','ban','spelling','filed_variant','other')),
      source        TEXT NOT NULL,
      source_url    TEXT,
      collected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at   TIMESTAMPTZ,
      confidence    TEXT CHECK (confidence IS NULL OR confidence IN ('low','medium','high'))
    );

    -- One name resolves to exactly one substance. Without this, two molecules could each claim the
    -- same alias and a lookup would depend on row order.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_molecule_aliases_alias ON molecule_aliases (alias);
    CREATE INDEX IF NOT EXISTS idx_molecule_aliases_mol ON molecule_aliases (molecule_id);

    -- ── WHAT WE REFUSED TO DECIDE ────
    -- Append-only by trigger. A quarantined conflict is the most informative row in the schema: it
    -- is the list of places where the data contradicts itself and a human must rule. Overwriting
    -- one would keep only the latest guess.
    CREATE TABLE IF NOT EXISTS molecule_conflicts (
      id            BIGSERIAL PRIMARY KEY,
      kind          TEXT NOT NULL
        CHECK (kind IN ('cas_disagreement','alias_collision','ambiguous_form','unresolvable_name',
                        'cas_contested','corrupted_name','duplicate_risk',
                        -- 30 Oct: the analyser's categories, now that it is the sole authority.
                        'insufficient_identity','cas_contested_within_identity',
                        -- Not a category: a reason shape the backfill was never taught to map. It
                        -- is storable ON PURPOSE, so the drift is recorded as a row rather than
                        -- aborting a migration mid-run — and a check asserts the count is zero.
                        'unmapped_exclusion_reason')),
      filed_name    TEXT NOT NULL,
      identity_name TEXT,
      detail        TEXT NOT NULL,            -- what disagreed, in words
      cas_values    TEXT,                     -- every distinct valid CAS seen, comma separated
      source_table  TEXT NOT NULL,
      source_ids    TEXT,                     -- the row ids, so the rule-on can be exact
      detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at   TIMESTAMPTZ,              -- set by a human decision, in a later phase
      resolution    TEXT,

      -- ── WHY A DEDUPE KEY, AND WHY IT IS AN INDEX ────
      -- The table is append-only, so a backfill that re-records the same refusal on every run
      -- piles up identical rows that nothing is permitted to delete. The first version of this
      -- script did exactly that: the second pass wrote the same conflict again, and
      -- check-molecule-identity-db.js caught it on the idempotence assertion.
      -- The arbiter is a partial unique index rather than a SELECT-then-INSERT, for the same
      -- reason the run ledger uses one: an index cannot be forgotten by a future call path.
      -- It is PARTIAL on resolved_at IS NULL deliberately — once a human has ruled, a fresh
      -- detection of the same disagreement is new information ("still disagreeing after your
      -- ruling") and is allowed to land as its own row.
      conflict_key  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mol_conflicts_kind ON molecule_conflicts (kind);
    CREATE INDEX IF NOT EXISTS idx_mol_conflicts_open ON molecule_conflicts (detected_at DESC)
      WHERE resolved_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mol_conflicts_open_key
      ON molecule_conflicts (conflict_key) WHERE resolved_at IS NULL;
`;

// ── THE INVARIANTS ──────────────────────────────────────────────────────────
//
// Each is written so that it cannot be satisfied by luck of insertion order, and each is exercised
// INDEPENDENTLY by scripts/check-molecule-identity-db.js — because the first draft of the
// run-ledger checks passed with either of two indexes weakened, which meant neither was proven
// necessary for any assertion.
const DDL_TRIGGERS = `
    -- 1. A base substance has no parent. If it had one it would not be a base.
    CREATE OR REPLACE FUNCTION molecules_form_parent_guard() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.substance_form = 'base' AND NEW.parent_molecule_id IS NOT NULL THEN
        RAISE EXCEPTION 'substance_form = base cannot have a parent_molecule_id (molecule %)', NEW.normalized_name;
      END IF;
      IF NEW.parent_molecule_id IS NOT NULL AND NEW.parent_molecule_id = NEW.id THEN
        RAISE EXCEPTION 'a molecule cannot be its own parent (molecule %)', NEW.normalized_name;
      END IF;
      -- Cycle guard. Depth is legitimate (hydrochloride monohydrate -> hydrochloride -> base), so
      -- this walks rather than forbidding depth, with a hard stop so a malformed graph cannot hang
      -- an INSERT.
      IF NEW.parent_molecule_id IS NOT NULL THEN
        DECLARE
          cursor_id BIGINT := NEW.parent_molecule_id;
          hops INT := 0;
        BEGIN
          WHILE cursor_id IS NOT NULL AND hops < 16 LOOP
            IF cursor_id = NEW.id THEN
              RAISE EXCEPTION 'parent_molecule_id would create a cycle (molecule %)', NEW.normalized_name;
            END IF;
            SELECT parent_molecule_id INTO cursor_id FROM molecules WHERE id = cursor_id;
            hops := hops + 1;
          END LOOP;
          IF hops >= 16 THEN
            RAISE EXCEPTION 'parent chain deeper than 16 for molecule % — refusing', NEW.normalized_name;
          END IF;
        END;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_molecules_form_parent ON molecules;
    CREATE TRIGGER trg_molecules_form_parent
      BEFORE INSERT OR UPDATE ON molecules
      FOR EACH ROW EXECUTE FUNCTION molecules_form_parent_guard();

    -- 2. A name cannot be one molecule's own identity AND another's alias.
    --    Enforced from BOTH sides, because either row can arrive first. This is the structural half
    --    of "an alias means the same substance": without it, "leuprolide" could be registered as an
    --    alias of "leuprolide acetate" while also being its own substance, and a lookup would
    --    return whichever the query happened to join first.
    CREATE OR REPLACE FUNCTION molecule_alias_collision_guard() RETURNS TRIGGER AS $$
    DECLARE owner_id BIGINT;
    BEGIN
      SELECT id INTO owner_id FROM molecules WHERE normalized_name = NEW.alias;
      IF owner_id IS NOT NULL AND owner_id <> NEW.molecule_id THEN
        RAISE EXCEPTION 'alias "%" is already the identity of molecule % — an alias means the same substance', NEW.alias, owner_id;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_molecule_alias_collision ON molecule_aliases;
    CREATE TRIGGER trg_molecule_alias_collision
      BEFORE INSERT OR UPDATE ON molecule_aliases
      FOR EACH ROW EXECUTE FUNCTION molecule_alias_collision_guard();

    CREATE OR REPLACE FUNCTION molecules_name_vs_alias_guard() RETURNS TRIGGER AS $$
    DECLARE other_id BIGINT;
    BEGIN
      SELECT molecule_id INTO other_id FROM molecule_aliases WHERE alias = NEW.normalized_name;
      IF other_id IS NOT NULL AND other_id <> NEW.id THEN
        RAISE EXCEPTION 'name "%" is already an alias of molecule % — cannot also be its own substance', NEW.normalized_name, other_id;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_molecules_name_vs_alias ON molecules;
    CREATE TRIGGER trg_molecules_name_vs_alias
      BEFORE INSERT OR UPDATE ON molecules
      FOR EACH ROW EXECUTE FUNCTION molecules_name_vs_alias_guard();

    -- 3. Conflicts are evidence. Append, and resolve by setting resolved_at/resolution — never by
    --    rewriting what was detected or deleting it.
    CREATE OR REPLACE FUNCTION molecule_conflicts_append_only() RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'molecule_conflicts is append-only: a detected conflict cannot be deleted';
      END IF;
      IF NEW.kind <> OLD.kind OR NEW.filed_name <> OLD.filed_name
         OR NEW.detail <> OLD.detail OR NEW.detected_at <> OLD.detected_at
         OR COALESCE(NEW.cas_values,'') <> COALESCE(OLD.cas_values,'')
         OR NEW.conflict_key <> OLD.conflict_key
         OR NEW.source_table <> OLD.source_table THEN
        RAISE EXCEPTION 'molecule_conflicts is append-only: only resolved_at and resolution may be set';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_molecule_conflicts_append_only ON molecule_conflicts;
    CREATE TRIGGER trg_molecule_conflicts_append_only
      BEFORE UPDATE OR DELETE ON molecule_conflicts
      FOR EACH ROW EXECUTE FUNCTION molecule_conflicts_append_only();
`;

// ── THE THREE OPERATIONAL TABLES, AND ONLY THOSE THREE ──────────────────────
//
// 16+ tables carry molecule_name as text. Migrating all of them is the platform-wide refactor E1's
// scope explicitly excludes: SEO, pricing and historical/reporting tables migrate later through
// controlled compatibility work. The column is NULLABLE everywhere, so nothing breaks while it is
// empty and nothing has to be backfilled atomically.
const TARGET_TABLES = [
  ['study_molecules', 'idx_sm_molecule_id'],
  ['research_interests', 'idx_ri_molecule_id'],
  ['supplier_products', 'idx_sp_molecule_id'],
];

// Exported so the checker applies THIS, not its own ALTER statements.
// ── CONSTRAINTS THAT HAVE TO CHANGE ON AN EXISTING TABLE ────────────────────
//
// DDL_TABLES uses CREATE TABLE IF NOT EXISTS, which is right for re-running but means a CHECK added
// to that text never reaches a database where the table already exists. Production already has
// molecule_conflicts, so widening its `kind` vocabulary in the DDL alone would have left the new
// kinds rejected at runtime — the backfill would abort mid-identity on a constraint violation, which
// is exactly how the local checker found this.
//
// Dropped and re-added rather than ALTER ... ADD CONSTRAINT, because adding one that already exists
// errors and adding one under a new name would leave the old narrow check in force.
const CONFLICT_KINDS = [
  'cas_disagreement', 'alias_collision', 'ambiguous_form', 'unresolvable_name',
  'cas_contested', 'corrupted_name', 'duplicate_risk',
  'insufficient_identity', 'cas_contested_within_identity', 'unmapped_exclusion_reason',
];
async function applyConflictKinds(q, log = () => {}) {
  const exists = await q(`SELECT to_regclass('molecule_conflicts') IS NOT NULL ok`);
  if (!exists.rows[0].ok) return;
  const list = CONFLICT_KINDS.map((k) => `'${k}'`).join(',');
  await q(`ALTER TABLE molecule_conflicts DROP CONSTRAINT IF EXISTS molecule_conflicts_kind_check`);
  await q(`ALTER TABLE molecule_conflicts
             ADD CONSTRAINT molecule_conflicts_kind_check CHECK (kind IN (${list}))`);
  log(`   molecule_conflicts.kind accepts ${CONFLICT_KINDS.length} kinds`);
}

async function applyTargetColumns(q, log = () => {}) {
  for (const [table, idx] of TARGET_TABLES) {
    const exists = await q(`SELECT to_regclass($1) IS NOT NULL ok`, [table]);
    if (!exists.rows[0].ok) { log(`   skip   ${table} does not exist on this database`); continue; }
    await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS molecule_id BIGINT REFERENCES molecules(id)`);
    await q(`CREATE INDEX IF NOT EXISTS ${idx} ON ${table} (molecule_id) WHERE molecule_id IS NOT NULL`);
    // The row that could not be resolved must say so rather than look un-processed. NULL
    // molecule_id with a NULL reason means "not yet attempted"; NULL with a reason means
    // "attempted and refused", which is the distinction the whole quarantine rests on.
    await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS molecule_unresolved_reason TEXT`);
    log(`   ok     ${table}.molecule_id ready`);
  }
}

async function main() {
  await initDB();
  await query(DDL_TABLES);
  await query(DDL_TRIGGERS);
  await applyConflictKinds(query, (m) => console.log(m));
  await applyTargetColumns(query, (m) => console.log(m));

  const counts = (await query(`
    SELECT (SELECT COUNT(*)::int FROM molecules)           molecules,
           (SELECT COUNT(*)::int FROM molecule_aliases)    aliases,
           (SELECT COUNT(*)::int FROM molecule_conflicts)  conflicts,
           (SELECT COUNT(*)::int FROM molecules WHERE inchikey IS NOT NULL) with_inchikey
  `)).rows[0];

  console.log('\n✅ molecules / molecule_aliases / molecule_conflicts ready\n');
  console.log(`   molecules                  ${counts.molecules}`);
  console.log(`   aliases                    ${counts.aliases}`);
  console.log(`   quarantined conflicts      ${counts.conflicts}`);
  console.log(`   rows with an InChIKey      ${counts.with_inchikey}   ← must stay 0 in E1`);
  console.log('\n   This migration created NO identity mappings. Next:');
  console.log('     node scripts/backfill-molecule-identity.js            (dry run, writes nothing)');
  console.log('     node scripts/backfill-molecule-identity.js --execute\n');
  console.log('   NOT YET ON PRODUCTION. The census must run first and its CAS-conflict output be');
  console.log('   reviewed before any migration is applied there — census to migration is not automatic.\n');
}

module.exports = { DDL_TABLES, DDL_TRIGGERS, TARGET_TABLES, applyTargetColumns,
  applyConflictKinds, CONFLICT_KINDS, main };

// Only run when invoked directly, so the checker can import the DDL without applying it to
// whatever DATABASE_URL happens to be set.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('migrate-molecules failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
