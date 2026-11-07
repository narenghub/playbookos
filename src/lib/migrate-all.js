// ── EVERY MIGRATION, IN ONE PLACE, RUN BY ONE PROCESS ────────────────────────
//
// ENG-003 (ruling 19 item 5, ruling 27 item 5). `server.js` used to run this entire chain at boot
// on one line. That is why the application had to connect as a Postgres superuser, and a superuser
// bypasses GRANT, REVOKE and row-level security — so no in-database privilege separation was
// available to the application at all, however the roles were defined.
//
// The chain did not need to be at boot. It needed to be SOMEWHERE, and boot was convenient. Here it
// is run by `scripts/migrate.js` as a role that holds DDL, once, before the application starts;
// `src/lib/schema-ready.js` is what boot calls instead, and it only reads.
//
// ── ORDER IS LOAD-BEARING ────────────────────────────────────────────────────
//
// The steps below are in exactly the order server.js ran them, because later ones ALTER tables the
// earlier ones create. The order was previously expressed as a `.then()` chain and is now a list,
// which is the same order with the dependency made visible.
//
// ── A FAILING STEP IS NOT A WARNING ─────────────────────────────────────────
//
// server.js wrapped several of these in `.catch(e => console.error(...))`, so a schema that failed
// to apply left the application running with tables missing and one line in a log nobody reads.
// Here, `required: true` means a failure fails the migration and the process exits non-zero.
//
// Two steps are deliberately NOT required, and each says why. Neither creates a table.

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const db = require('./db');

// ── STEPS THAT ARE STANDALONE SCRIPTS ────────────────────────────────────────
//
// notifications, outreach and the Apollo sequence tables are created by scripts under scripts/,
// which were run BY HAND and were in no chain at all. They cannot be required: each one runs on
// import and calls process.exit(), so requiring it would end the migrator.
//
// So the migrator SHELLS OUT to them. They are the definition of those tables, and duplicating
// their DDL here would create a second copy to drift.
//
// Found because the SPA's own shell requests 500'd on a freshly migrated database — /api/notifications
// and /api/outreach/tasks both returned "relation does not exist". A deploy to an empty database
// would have done the same, on the first page load, for every user.
function runScript(rel, { refusalIsSuccess = null, args = [] } = {}) {
  const abs = path.join(__dirname, '..', '..', rel);
  try {
    const out = execFileSync(process.execPath, [abs, ...args], { env: { ...process.env }, stdio: 'pipe', encoding: 'utf8' });
    // ── A SCRIPT THAT PRINTED ITS USAGE DID NOT RUN ──────────────────────────
    //
    // migrate-intake.js, migrate-connectors.js and migrate-registrations.js all require an explicit
    // --apply. Invoked with no arguments they print usage, never connect to a database, and exit 0
    // — so the migrator recorded three steps as applied that had done nothing at all. The same
    // disease as a check that did not execute reporting itself as a pass, this time in the thing
    // that builds the database.
    //
    // Caught by reading scripts/analyze-migration-risks.js, which listed rollback branches in
    // scripts the migrator was calling without the flag that reaches any branch at all.
    if (/^\s*(Usage|USAGE)[: ]/m.test(out) || /\n\s*Usage:/.test(out)) {
      throw new Error(`${rel} printed its usage instead of running — it needs an explicit flag`);
    }
    return { script: rel, args: args.length ? args.join(' ') : undefined };
  } catch (e) {
    // ── A DELIBERATE REFUSAL IS NOT A FAILED MIGRATION ───────────────────────
    //
    // migrate-product-boundary.js creates its two tables and THEN exits non-zero if user_products
    // already holds rows, because "a re-run cannot tell revoked from never granted, so it would
    // silently re-grant products somebody deliberately took away". That refusal is correct, and it
    // is the same hazard as the 2026-09-30 incident where a super admin's deliberately removed
    // user_products rows made a write look like a widening.
    //
    // But it meant the migrator could not run against ANY populated database — including
    // production. Found by scripts/verify-migration-readiness.js, which is the only place that
    // runs the migration against a database that already has data in it.
    //
    // So a caller may declare the one refusal it expects. The match is on the script's own refusal
    // text; anything else still fails the migration.
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (refusalIsSuccess && refusalIsSuccess.test(out)) {
      return { script: rel, refused: true, note: 'schema applied; the one-time backfill was correctly refused' };
    }
    const detail = out.trim().split('\n').filter(Boolean).slice(-4).join(' | ');
    throw new Error(`${rel} failed${detail ? `: ${detail}` : ''}`);
  }
}

// Steps that create or alter schema. Every one is idempotent (IF NOT EXISTS / OR REPLACE), which is
// what makes re-running the migrator safe and what makes a partial failure recoverable.
// ── A LIMITATION WORTH NAMING ────────────────────────────────────────────────
//
// The first three steps, and the two research-intelligence steps, call functions in src/lib/db that
// use that module's OWN pool — built from DATABASE_URL when the module is first required. They
// ignore the `q` passed to runAll. `usesOwnPool: true` marks them.
//
// In production this is invisible and correct: scripts/migrate.js assigns MIGRATION_DATABASE_URL
// over DATABASE_URL for its own process before requiring anything, so every step — pool-based or
// not — runs as the migrator role.
//
// It matters for one thing only, and it is a test rather than a deployment concern: a harness that
// calls runAll with a RESTRICTED connection and expects every step to be refused will see these
// five succeed, because they never used that connection. The restricted-role check asserts against
// a step that takes `q`, and says so where it does.
//
// Converting the five would mean threading a connection through about forty functions in a
// 1,150-line module — a far larger and riskier diff than this change, for no gain in the deployed
// behaviour. It is recorded here instead of fixed.
const SCHEMA_STEPS = [
  { name: 'core tables (initDB)', required: true, usesOwnPool: true, run: () => db.initDB() },
  { name: 'phase 2 tables (initPhase2)', required: true, usesOwnPool: true, run: () => db.initPhase2() },
  { name: 'schema migrations (migrateSchemas)', required: true, usesOwnPool: true, run: () => db.migrateSchemas() },
  {
    name: 'autonomy kill switch',
    required: true,
    run: (q) => require('./autonomy').migrateAutonomy(q),
  },
  {
    name: 'supplier RFQ uniqueness',
    required: true,
    // This one returns a verdict rather than throwing: UNIQUE (rfq_id, supplier_id) cannot be
    // created while duplicates exist. Boot logged "CRITICAL" and carried on. A migration must not:
    // the duplicates have to be resolved, and until they are, RFQ sending fails closed anyway.
    run: async (q) => {
      const r = await require('./idempotency/supplier-rfq').migrate(q);
      if (!r.enforced) {
        const dups = (r.duplicates || []).map((d) => `rfq=${d.rfq_id} supplier=${d.supplier_id} rows=${d.n}`);
        throw new Error(`supplier RFQ uniqueness NOT enforced: ${r.error}`
          + (dups.length ? `\n  duplicates: ${dups.join('; ')}` : ''));
      }
      return r;
    },
  },
  {
    name: 'RFQ identity guard (append-only)',
    required: true,
    run: (q) => require('./procurement/rfq-identity-guard').migrate(q),
  },
  { name: 'run ledger', required: true, run: (q) => require('./runs').migrateRuns(q) },
  {
    name: 'AI office kernel (K1)',
    required: true,
    run: (q) => require('./office/schema').migrateOffice(q),
  },
  { name: 'research intelligence', required: true, usesOwnPool: true, run: () => db.migrateResearchIntelligence() },
  { name: 'research intelligence phase 3', required: true, usesOwnPool: true, run: () => db.migrateResearchIntelligencePhase3() },

  {
    name: 'notifications',
    required: true,
    usesOwnPool: true,     // its own process, its own pool, from DATABASE_URL
    run: () => runScript('scripts/migrate-notifications.js'),
  },
  {
    name: 'outreach',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-outreach.js'),
  },
  {
    // /api/outreach/tasks joins prospects, so outreach alone is not enough to stop that 500.
    name: 'prospects',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-prospects.js'),
  },
  {
    // and research_institutions, which that same endpoint also joins. Each of these was found by a
    // 500 on page load rather than by reading the code — which is the argument for the inventory
    // checker (scripts/check-migration-coverage.js) rather than for more guessing.
    name: 'research institutions',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-research-institutions.js'),
  },
  {
    name: 'outreach sequences',
    required: false,   // Apollo sequence tables; the shell does not request them on page load
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-outreach-sequences.js'),
  },


  // ── THE 27 SCRIPTS THAT WERE ONLY EVER RUN BY HAND ─────────────────────────
  //
  // scripts/check-migration-coverage.js measured this: 57 tables across 27 scripts existed ONLY if
  // somebody had remembered to run them against a database. There was no record of which had been
  // run, and no way to bring a fresh database to the shape the application expects — which is the
  // same thing as having no deployment procedure.
  //
  // Each is idempotent (CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE), so running them every time
  // is cheap and safe. Order here is dependency order: permissions and the product boundary first,
  // because other tables' foreign keys point at them.
  //
  // `required: true` for all of them on purpose. A fresh deployment missing any one of these 500s on
  // the endpoint that touches it, and a migration that "mostly worked" is how this state arose.
  { name: 'permissions', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-permissions.js') },
  { name: 'shadow log', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-shadow-log.js') },
  {
    // The two CREATE TABLE IF NOT EXISTS statements run first and are idempotent. The backfill
    // after them is a ONE-TIME operation that refuses to repeat itself, and that refusal is the
    // correct behaviour, not a migration failure — see runScript.
    name: 'product boundary',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-product-boundary.js', {
      refusalIsSuccess: /REFUSING TO BACKFILL: user_products already has/,
    }),
  },
  { name: 'product grant log', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-product-grant-log.js') },
  { name: 'tool audit', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-tool-audit.js') },
  { name: 'molecules', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-molecules.js') },
  { name: 'events', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-events.js') },
  { name: 'cphi exhibitors', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-cphi-exhibitors.js') },
  { name: 'cphi contacts', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-cphi-contacts.js') },
  { name: 'cphi followup', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-cphi-followup.js') },
  { name: 'supplier products', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-supplier-products.js') },
  { name: 'dmf', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-dmf.js') },
  { name: 'content queue', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-content-queue.js') },
  { name: 'fda establishments', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-fda-establishments.js') },
  { name: 'research labs', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-research-labs.js') },
  { name: 'study sites', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-study-sites.js') },
  { name: 'lead outcomes', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-lead-outcomes.js') },
  { name: 'labconnect', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-labconnect.js') },
  { name: 'lab orders', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-lab-orders.js') },
  { name: 'acbm', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-acbm.js') },
  {
    // The acbm_* → sitenex_* rename, which also CREATES `partners`. partner_territories and
    // sitenex_lead_registrations both have foreign keys into it, so without this step they cannot
    // be created at all — the chain failed here with 'relation "partners" does not exist'.
    //
    // It was excluded from coverage at first as "a rename, not a schema step". That was wrong as a
    // deployment decision: every statement in it is existence-guarded (RENAME only where the old
    // name is present, CREATE TABLE IF NOT EXISTS partners, ADD COLUMN IF NOT EXISTS), so on a
    // fresh database it is the step that produces today's table names, and on a database where it
    // has already run it is a no-op.
    //
    // WORTH KNOWING: it contains one destructive statement,
    //   ALTER TABLE sitenex_deals DROP COLUMN IF EXISTS referred_by
    // which is a no-op wherever the rename has already been applied — including production, whose
    // schema is already post-rename. It is named here rather than left to be discovered.
    name: 'sitenex rename (creates partners)',
    required: true,
    usesOwnPool: true,
    // NOT RE-RUNNABLE, and this is the one step in the chain that is not. Its table renames are
    // existence-guarded, but its ALTER INDEX ... RENAME is not: on a database where the rename has
    // already happened it fails with 'relation "sitenex_packages_pkey" already exists'.
    //
    // `partners` is created by this script and by nothing else, so its presence is an exact record
    // of whether this step has run. Gating on it rather than patching the script means nothing is
    // changed about a migration that has already been applied to production.
    //
    // Found by scripts/verify-migration-readiness.js — the only harness that runs the migration
    // twice, which is what production is: a database the migrator has already been run against.
    when: async (q) => {
      const r = await q(`SELECT to_regclass('public.partners') IS NULL AS needs_rename`);
      return r.rows[0].needs_rename === true;
    },
    run: () => runScript('scripts/migrate-sitenex-rename.js'),
  },
  { name: 'partner territories', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-partner-territories.js') },
  {
    // Schema, not a backfill — and it belongs HERE, after 'sitenex rename (creates partners)', because
    // outreach.partner_id carries a foreign key to partners(id). Placing it next to the 'outreach'
    // step, where it reads as though it belongs, fails with `relation "partners" does not exist`.
    //
    // It was left out of this chain entirely on the strength of its own description, "back-fills
    // partner scope over existing rows". It does back-fill. It also ADDS outreach.partner_id, DROPS
    // UNIQUE (entity_type, entity_id), and CREATES the unique index on
    // (entity_type, entity_id, COALESCE(partner_id, 0)) that src/lib/outreach/index.js conflicts on.
    //
    // Without it a database built by this migrator has no outreach.partner_id, and the application's
    // own setStatus upsert fails with `column "partner_id" does not exist` — so outreach status
    // changes are broken on every fresh deployment. Production works only because somebody ran this
    // script there by hand, which is also why the first gate-2 run against production's dump looked
    // like a schema defect when the schema was correct and the CHECK was stale.
    //
    // Measured, not reasoned: a migrator-built database was probed on 2026-11-06 and the application's
    // upsert raised exactly that error. The same defect as the 43 hand-run scripts, surviving one
    // round longer because it was classified by its summary line rather than by what it executes.
    name: 'outreach partner scope',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-outreach-partner-scope.js'),
  },
  { name: 'sitenex phase3', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-sitenex-phase3.js') },
  { name: 'sitenex contract sends', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-sitenex-contract-sends.js') },
  { name: 'sitenex intake links', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-sitenex-intake-links.js') },

  // ── FIVE COLUMN-ONLY MIGRATIONS THAT WERE IN NO CHAIN AND ON NO EXCLUSION LIST ──────────────────
  //
  // Found on 2026-11-07 by scripts/check-behavioral-regression.js, which boots the real server and
  // writes through the real API. The first granted outreach write returned 500:
  //
  //     {"error":"column \"channel\" of relation \"outreach\" does not exist"}
  //
  // src/lib/outreach/index.js writes outreach.channel on every status change. Production has the
  // column, because somebody ran migrate-outreach-vocabulary.js there by hand. A database built by
  // this migrator did not, so outreach was broken on every fresh deployment — the SECOND instance of
  // that defect in two days, after outreach.partner_id (ENG-004).
  //
  // WHY NEITHER CHECKER CAUGHT IT. check-migration-coverage.js asserts that every table a migration
  // script CREATES is created by the migrator. These five create no tables; they only ADD COLUMN. So
  // they were not in the chain, not excluded, and not enumerated — invisible by construction. The
  // coverage checker now fails on any migrate-*.js that is in neither list, whatever it changes.
  //
  // Placed here, as a group, because every table they alter exists by this point. They are all
  // ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so each is a no-op where it has already
  // been applied — which is every one of them on production.
  {
    // outreach.channel + outreach_events.channel — written by src/lib/outreach/index.js on every
    // status change. Its absence 500s the route.
    name: 'outreach vocabulary (channel)',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-outreach-vocabulary.js'),
  },
  {
    // users.invited_partner_id — chosen when an invite is sent, copied to users.partner_id on accept.
    name: 'partner invite column',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-partner-invite.js'),
  },
  {
    // prospects.country, prospects.source_partner_id, sitenex_contracts.region
    name: 'partner book country/region',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-partner-book-country-region.js'),
  },
  {
    // sitenex_deals.status_changed_at — the stage clock the deal board reads.
    name: 'sitenex stage clock',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-sitenex-stage-clock.js'),
  },
  {
    // cphi_exhibitor_matches.entity_note
    name: 'cphi entity note',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-cphi-entity-note.js'),
  },
  { name: 'connectors', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-connectors.js', { args: ['--apply'] }) },
  { name: 'intake', required: true, usesOwnPool: true, run: () => runScript('scripts/migrate-intake.js', { args: ['--apply'] }) },

  // ── PRPA ────────────────────────────────────────────────────────────────────
  // These were never in the boot chain: they were applied by hand on a disposable cluster, which is
  // why the tracker worked in a demonstration and did not exist in any deployable database.
  {
    // The research spine: `solicitations` and `verified_capabilities` live here, and the intake
    // schema's preconditions require both. Also absent from the boot chain — so on a fresh database
    // the PRPA schema could not have applied at all, and the capability registry the whole product
    // reasons from would not have existed. Found by running the migrator against an empty cluster,
    // which is the only place that gap was ever going to show.
    name: 'connectors / research spine',
    required: true,
    run: (q) => require('./connectors/schema').migrateConnectors(q),
  },
  {
    // AFTER connectors, because it widens the `kind` CHECK on verified_capabilities (2 kinds → 7,
    // adding certification, regulatory_authorization, equipment, service_capability and
    // quality_system) and its own preconditions require that table to exist. Ordered first, it
    // refused with "1 precondition(s) failed. NOTHING WAS WRITTEN."
    //
    // This step had been a silent no-op, so the widened kinds were never applied — which is why a
    // demo fixture using 'service_capability' was rejected by the database earlier in this session.
    // The fixture was right; the schema was incomplete.
    name: 'registrations',
    required: true,
    usesOwnPool: true,
    run: () => runScript('scripts/migrate-registrations.js', { args: ['--apply'] }),
  },
  {
    name: 'PRPA intake schema (v3)',
    required: true,
    run: (q) => applyVersioned(q, require('./office/intake-schema')),
  },
  {
    name: 'PRPA opportunity schema (v4)',
    required: true,
    run: (q) => applyVersioned(q, require('./office/opportunity-schema')),
  },
  {
    name: 'PRPA audit history (v5)',
    required: true,
    run: (q) => applyVersioned(q, require('./office/opportunity-audit-schema')),
  },
];

// Seeds are DML, not DDL — an application role could run them. They are here because they belong
// to provisioning rather than to serving a request, and because running them on every boot was
// pointless work. Not required: a failed seed leaves the application correct but emptier, and
// taking a deploy down over a supplier list would be the wrong trade.
const SEED_STEPS = [
  { name: 'supplier seed', required: false, run: () => require('./agents/procurement-agent').seedSupplierDatabase() },
  { name: 'patent-watch seed', required: false, run: () => require('./agents/research-agent').seedPatentWatch() },
  { name: 'molecule pricing seed', required: false, run: () => require('./agents/inquiry-agent').seedMoleculePricing() },
];

/**
 * Apply a versioned schema module: check its preconditions, then run its DDL in order.
 *
 * The preconditions exist because these modules are additive to one another — v5's foreign key
 * needs v4's table. Checking first turns "column does not exist" forty statements in into one
 * legible sentence before anything is written.
 */
async function applyVersioned(q, mod) {
  for (const p of (mod.PRECONDITIONS || [])) {
    // Two shapes exist in the repo and both are legitimate. The intake (v3) and opportunity (v4)
    // modules declare `{ name, what, table }` — a table that must already exist. The audit module
    // (v5) declares `{ name, sql, detail }` for a condition a table name cannot express. Handling
    // only one of them is how this first failed: `q(undefined)` reads as
    // "Client was passed a null or undefined query", which says nothing about preconditions.
    let ok; let describe;
    if (p.sql) {
      const r = await q(p.sql);
      ok = r.rows.length && (r.rows[0].ok === true || r.rows[0].ok === 't');
      describe = p.detail || p.what || p.sql;
    } else if (p.table) {
      const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${p.table}`]);
      ok = r.rows[0] && r.rows[0].ok === true;
      describe = p.what || `table ${p.table} must exist`;
    } else {
      throw new Error(`precondition ${p.name} of ${mod.VERSION} declares neither sql nor table`);
    }
    if (!ok) throw new Error(`precondition failed for ${mod.VERSION}: ${p.name} — ${describe}`);
  }
  for (const stmt of mod.DDL) await q(stmt);
  return { version: mod.VERSION, statements: mod.DDL.length, tables: mod.CREATED_TABLES || [] };
}

/**
 * Seed the company row PRPA is welded to. Idempotent.
 *
 * Every kernel table carries company_id, so without this row the tracker has nothing to attach to
 * and every endpoint returns 503. It is part of provisioning, not of a request.
 */
async function ensureCompany(q, slug = process.env.PRPA_COMPANY_SLUG || 'abiozen') {
  // The column is display_name, not name (src/lib/office/schema.js). Aliased on the way out so the
  // callers that read `.name` keep working without each of them having to know that.
  const existing = await q(
    `SELECT id, slug, display_name AS name, status FROM companies WHERE slug = $1`, [slug]);
  if (existing.rows.length) {
    if (existing.rows[0].status !== 'active') {
      throw new Error(`company "${slug}" exists but its status is "${existing.rows[0].status}", not active`);
    }
    return { created: false, company: existing.rows[0] };
  }
  const displayName = slug === 'abiozen' ? 'Abiozen LLC' : slug;
  const r = await q(
    `INSERT INTO companies (id, slug, display_name, status) VALUES ($1, $2, $3, 'active')
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id, slug, display_name AS name, status`,
    [`co-${slug}`, slug, displayName]);
  return { created: true, company: r.rows[0] };
}

// ── THE MIGRATION LEDGER ─────────────────────────────────────────────────────
//
// Three scripts READ `schema_migrations` and report "ABSENT (no runner has applied anything here)".
// Nothing has ever created it. So the question "which migrations has this database had?" had no
// answer anywhere — not in the database, not in a file, not in a deploy log. For 43 hand-run
// scripts against a live production database, that is the whole problem in one sentence.
//
// This creates it and records every step the migrator runs. It is append-mostly: a re-run updates
// the row's applied_at, because these steps are idempotent and re-running them is normal.
const LEDGER_DDL = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version      TEXT PRIMARY KEY,
     applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     applied_by   TEXT NOT NULL,
     ms           INTEGER,
     detail       TEXT
   )`,
];

async function ensureLedger(q) {
  for (const stmt of LEDGER_DDL) await q(stmt);
}

async function recordInLedger(q, { version, ms, detail }) {
  // Never fatal: a ledger write that fails must not fail the migration it is describing. But it is
  // reported, because a silent ledger is the state this is meant to end.
  try {
    await q(
      `INSERT INTO schema_migrations (version, applied_by, ms, detail)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (version) DO UPDATE
         SET applied_at = NOW(), applied_by = EXCLUDED.applied_by,
             ms = EXCLUDED.ms, detail = EXCLUDED.detail`,
      [version, process.env.USER || process.env.LOGNAME || 'migrator', ms, detail || null]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Run everything.
 *
 * @param {function} q           a query function, from a connection holding DDL privileges
 * @param {object}   opts
 * @param {boolean}  opts.seeds  run the seed steps (default true)
 * @param {function} opts.log    line logger
 * @returns {{ok: boolean, steps: Array, failed: Array}}
 */
async function runAll(q, opts = {}) {
  const log = opts.log || (() => {});
  const seeds = opts.seeds !== false;
  const steps = [];
  const failed = [];

  // The ledger before anything else, so every step below can be recorded as it lands.
  let ledger = true;
  try { await ensureLedger(q); log('  ok    migration ledger (schema_migrations)'); } catch (e) {
    ledger = false;
    log(`  warn  the migration ledger could not be created — steps will not be recorded: ${e.message}`);
  }

  const all = seeds ? SCHEMA_STEPS.concat(SEED_STEPS) : SCHEMA_STEPS;
  for (const step of all) {
    const t0 = Date.now();
    try {
      // A step may declare `when`: a read-only predicate deciding whether it applies to THIS
      // database. Used for the one step in the chain that is genuinely not re-runnable.
      if (step.when) {
        const applies = await step.when(q);
        if (!applies) {
          steps.push({ name: step.name, ok: true, skipped: true, ms: 0, result: 'already applied' });
          log(`  --    ${step.name}  — already applied, skipped`);
          continue;
        }
      }
      const result = await step.run(q);
      const ms = Date.now() - t0;
      steps.push({ name: step.name, ok: true, ms, result: summarise(result) });
      if (ledger) {
        const rec = await recordInLedger(q, { version: step.name, ms, detail: summarise(result) });
        if (!rec.ok) log(`  warn  ledger write failed for "${step.name}": ${rec.error}`);
      }
      log(`  ok    ${step.name}${summarise(result) ? `  — ${summarise(result)}` : ''}`);
    } catch (e) {
      steps.push({ name: step.name, ok: false, ms: Date.now() - t0, error: e.message, required: step.required });
      if (step.required) {
        failed.push({ name: step.name, error: e.message });
        log(`  FAIL  ${step.name}\n        ${e.message}`);
        // Stop at the first required failure. Continuing would run ALTERs against tables the failed
        // step was supposed to create, and the second error would bury the first.
        break;
      }
      log(`  warn  ${step.name} (not required) — ${e.message}`);
    }
  }

  // The company row comes after the schema it needs, and only if the schema applied.
  if (!failed.length) {
    try {
      const c = await ensureCompany(q);
      steps.push({ name: 'company row', ok: true, result: `${c.company.slug} (${c.created ? 'created' : 'already present'})` });
      log(`  ok    company row — ${c.company.slug} (${c.created ? 'created' : 'already present'})`);
    } catch (e) {
      failed.push({ name: 'company row', error: e.message });
      log(`  FAIL  company row\n        ${e.message}`);
    }
  }

  return { ok: failed.length === 0, steps, failed };
}

function summarise(r) {
  if (!r || typeof r !== 'object') return '';
  if (r.version) return `${r.version} · ${r.statements} statements`;
  if (typeof r.seeded === 'number') return `${r.seeded} added, ${r.skipped} existing`;
  if (r.table) return `${r.table}${r.appendOnly ? ' (append-only)' : ''}`;
  return '';
}

// The first schema step that actually uses the connection passed to runAll. The restricted-role
// check asserts against this rather than against step 1, because step 1 would succeed on its own
// pool and look like a privilege escape that had not happened.
const FIRST_STEP_USING_PASSED_CONNECTION = SCHEMA_STEPS.find((s) => !s.usesOwnPool).name;

module.exports = {
  runAll, applyVersioned, ensureCompany, ensureLedger, recordInLedger,
  SCHEMA_STEPS, SEED_STEPS, LEDGER_DDL,
  FIRST_STEP_USING_PASSED_CONNECTION,
};
