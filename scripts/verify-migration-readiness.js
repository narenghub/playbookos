#!/usr/bin/env node
// ── PRODUCTION MIGRATION READINESS ───────────────────────────────────────────
//
//   node scripts/verify-migration-readiness.js [prod-YYYYMMDD.dump]
//   echo $?
//
// Ruling 28 item 2: "Validate all 47 migration steps against a production-like copy of the existing
// database, check backward compatibility, preserve existing data, and demonstrate backup and
// recovery procedures. No production database changes yet."
//
// ── WHAT THIS CAN AND CANNOT PROVE ───────────────────────────────────────────
//
// WITH a dump argument it restores the real thing and the word "production-like" is retired.
// WITHOUT one it builds a production-LIKE database: the migrator's own schema, populated with
// representative rows, then migrated again as an EXISTING database rather than an empty one.
//
// That distinction is the whole point and it is reported in the verdict rather than buried. A
// fresh install builds a different database from production's — this repository has already seen a
// fresh install produce ~66 tables against production's 137 — so a green run here without a dump
// means "the migration is safe on a database shaped like the one I built", which is weaker than it
// sounds and stronger than nothing.
//
// Getting a dump: `railway ssh 'pg_dump --format=custom ...'` returned "command not found" on
// 2026-11-06, so the dump has to come from Railway's own backup UI or from a machine with the
// client tools. Until then this runs in production-like mode and says so.
//
// ── IT NEVER TOUCHES PRODUCTION ──────────────────────────────────────────────
//
// Every cluster here is created in a temp directory, listens on no TCP port, and is destroyed at
// the end. There is no code path in this file that connects to a URL it did not create.
//
// Exit status is the verdict. 3 = could not execute (no toolchain), which is not a pass.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const RECONCILE_ON_RESTORE = process.argv.includes('--reconcile-on-restore');
const DUMP = process.argv[2] || null;
const PGPORT = process.env.READINESS_PGPORT || '55455';

let pass = 0; let fail = 0; let notRun = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const skip = (m, d) => { notRun += 1; console.log(`  ----  ${m} — DID NOT RUN${d ? `: ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null; let BIN = null;
function sh(cmd) {
  const asPostgres = process.getuid && process.getuid() === 0;
  // The PATH prefix goes INSIDE the command string. `su postgres -c` starts a login shell that
  // resets PATH, so setting it only in env gave "initdb: command not found" while the binary was
  // sitting in BIN — which the harness then reported as "no PostgreSQL toolchain", i.e. a check
  // that did not run presenting itself as an environment limitation.
  // Every psql/createdb/pg_dump/pg_restore call below passes -U postgres. These tools default the
  // ROLE to the invoking OS user, which is a separate decision from initdb's bootstrap superuser:
  // as root with an `su postgres` wrapper the two coincide and the omission is invisible, but run
  // as a person it is `role "<username>" does not exist` on the first call. The repository's
  // pg-harness-discipline test enforces this, and caught it here.
  const withPath = `PATH=${BIN}:$PATH ${cmd}`;
  return execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(withPath)}` : withPath],
    { env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` }, encoding: 'utf8', stdio: 'pipe' });
}
function startCluster() {
  BIN = pgBinCandidates()[0];
  if (!BIN) return null;
  const base = fs.mkdtempSync('/var/tmp/prpa-readiness-');
  const asPostgres = process.getuid && process.getuid() === 0;
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    sh(`initdb -D ${base}/data ${INITDB_FLAGS}`);
    sh(`pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) { console.error(`  (cluster start failed: ${e.message})`); return null; }
  temp = { base };
  return base;
}
function stopCluster() {
  if (!temp) return;
  try { sh(`pg_ctl -D ${temp.base}/data -m immediate stop`); } catch { /* going away */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp */ }
}

const urlFor = (db) => `postgresql://postgres@localhost/${db}?host=${temp.base}&port=${PGPORT}&sslmode=disable`;

// A content fingerprint that does not depend on row order or on columns a migration may add.
async function fingerprint(q, tables) {
  const out = {};
  for (const t of tables) {
    try {
      const n = (await q(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
      out[t] = n;
    } catch (e) { out[t] = `ERROR: ${e.message.split('\n')[0]}`; }
  }
  return out;
}

// The columns the running application reads. §6 asks whether the migration is additive, which is a
// question about a BEFORE and an AFTER: a column that is absent in both was never created, and that
// is not a backward-compatibility problem — it is either a table this release introduces or, if the
// chain halted, a step that never ran.
const APP_COLUMNS = [
  ['federal_opportunities', 'solicitation_number'], ['federal_opportunities', 'response_deadline'],
  ['federal_opportunities', 'is_biddable'], ['opportunity_assessments', 'verdict'],
  ['opportunity_bid_reviews', 'decision'], ['users', 'email'], ['users', 'role'],
  ['companies', 'slug'], ['verified_capabilities', 'verification_status'],
];

// Pure, and exported, so the negative control can watch it say "dropped". The clean-build path never
// reaches the never-created branch, and a classifier nobody has seen say no is not a classifier.
function classifyColumns(before, after) {
  const dropped = []; const notCreated = [];
  for (const key of Object.keys(after)) {
    if (after[key]) continue;
    if (before && before[key]) dropped.push(key);
    else notCreated.push(key);
  }
  return { dropped, notCreated };
}

// ── A BEFORE/AFTER PICTURE OF THE SCHEMA (ruling 34 item 3) ───────────────────
//
// Row counts tell you data survived. They say nothing about what the migration DID to the schema, and
// "152 tables after" is not a comparison — the useful question is which tables and constraints appeared,
// which disappeared, and which changed definition. Production is at 140 tables and a database this
// migrator builds is at 152; that gap is the thing a reader actually wants itemised.
//
// Constraint definitions are compared as text, because pg_get_constraintdef is the canonical rendering:
// a CHECK whose expression was widened, or a UNIQUE that gained a column, shows up as a change rather
// than as a drop plus an add.
async function schemaSnapshot(q) {
  const tables = (await q(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);
  const constraints = {};
  for (const r of (await q(
    `SELECT c.conname, t.relname AS tbl, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'`)).rows) {
    constraints[`${r.tbl}.${r.conname}`] = r.def;
  }
  // Unique indexes are not constraints but satisfy ON CONFLICT just the same, and the per-partner
  // outreach key is one — so a comparison that ignored them would miss the most important change in
  // this release.
  const uniqueIndexes = {};
  for (const r of (await q(
    `SELECT indexname, tablename, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ILIKE '%UNIQUE%'`)).rows) {
    uniqueIndexes[`${r.tablename}.${r.indexname}`] = r.indexdef.replace(' USING btree', '');
  }
  return { tables, constraints, uniqueIndexes };
}

function reportSchemaDiff(before, after) {
  const line = (s) => console.log(`        ${s}`);
  const addedT = after.tables.filter((t) => !before.tables.includes(t));
  const removedT = before.tables.filter((t) => !after.tables.includes(t));

  console.log(`        tables: ${before.tables.length} before → ${after.tables.length} after`);
  if (addedT.length) {
    line(`  + ${addedT.length} table(s) CREATED by the migration:`);
    for (let i = 0; i < addedT.length; i += 4) line(`      ${addedT.slice(i, i + 4).join(', ')}`);
  }
  if (removedT.length) {
    line(`  - ${removedT.length} table(s) GONE after the migration:`);
    for (const t of removedT) line(`      ${t}`);
  } else {
    line('  - no table disappeared');
  }

  const bc = before.constraints; const ac = after.constraints;
  const addedC = Object.keys(ac).filter((k) => !(k in bc));
  const removedC = Object.keys(bc).filter((k) => !(k in ac));
  const changedC = Object.keys(ac).filter((k) => k in bc && bc[k] !== ac[k]);

  console.log(`        constraints: ${Object.keys(bc).length} before → ${Object.keys(ac).length} after`);
  line(`  + ${addedC.length} added · - ${removedC.length} removed · ~ ${changedC.length} redefined`);
  // Added constraints on PRE-EXISTING tables are the interesting ones: a new constraint on a new table
  // is just the table. A new constraint on a table that already held data could have failed, and did not.
  const addedOnExisting = addedC.filter((k) => before.tables.includes(k.split('.')[0]));
  if (addedOnExisting.length) {
    line(`      added on tables that ALREADY HELD DATA (these could have failed, and did not):`);
    for (const k of addedOnExisting.slice(0, 20)) line(`        ${k}  ${ac[k]}`);
    if (addedOnExisting.length > 20) line(`        … and ${addedOnExisting.length - 20} more`);
  }
  for (const k of removedC) line(`      REMOVED  ${k}  ${bc[k]}`);
  for (const k of changedC) line(`      CHANGED  ${k}\n          before: ${bc[k]}\n          after:  ${ac[k]}`);

  const bi = before.uniqueIndexes; const ai = after.uniqueIndexes;
  const addedI = Object.keys(ai).filter((k) => !(k in bi));
  const removedI = Object.keys(bi).filter((k) => !(k in ai));
  if (addedI.length || removedI.length) {
    console.log(`        unique indexes: ${Object.keys(bi).length} before → ${Object.keys(ai).length} after`);
    for (const k of removedI) line(`      REMOVED  ${k}  ${bi[k]}`);
    const addedOnExistingI = addedI.filter((k) => before.tables.includes(k.split('.')[0]));
    for (const k of addedOnExistingI) line(`      ADDED on an existing table  ${k}\n          ${ai[k]}`);
  }

  return { addedT, removedT, addedC, removedC, changedC, removedI };
}

async function columnPresence(q) {
  const out = {};
  for (const [t, c] of APP_COLUMNS) {
    const r = await q(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS present`, [t, c]);
    out[`${t}.${c}`] = r.rows[0].present === true;
  }
  return out;
}

async function main() {
  h(`PRODUCTION MIGRATION READINESS — ${DUMP ? `restore of ${path.basename(DUMP)}` : 'PRODUCTION-LIKE (no dump supplied)'}`);

  if (DUMP && !fs.existsSync(DUMP)) {
    console.log(`\nSKIP  ${DUMP} does not exist. This proved NOTHING.\n`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  const base = startCluster();
  if (!base) { console.log('\nSKIP  no PostgreSQL toolchain. This proved NOTHING.\n'); process.exit(EXIT_NOT_EXECUTED); }

  process.env.PRPA_COMPANY_SLUG = 'abiozen';
  process.env.ADMIN_EMAIL = 'readiness-fixture@example.invalid';
  process.env.ADMIN_PASSWORD = require('crypto').randomBytes(18).toString('hex');
  process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');

  let baseline = null; let after = null; let client = null; let baselineCols = null; let baselineSchema = null;
  try {
    // ── 1. THE "EXISTING" DATABASE ────────────────────────────────────────────
    h('1. AN EXISTING DATABASE WITH DATA IN IT');
    sh(`createdb -h ${temp.base} -p ${PGPORT} -U postgres existing`);
    process.env.DATABASE_URL = urlFor('existing');
    client = new Client({ connectionString: urlFor('existing') });
    await client.connect();
    const q = (s, p) => client.query(s, p);

    if (DUMP) {
      // ── THE RESTORE MUST ACTUALLY RESTORE ───────────────────────────────────
      //
      // This said `pg_restore ... || true` and then printed "restored — this is production's
      // schema". Handed a PLAIN SQL dump, pg_restore cannot read it at all: the restore did
      // nothing, the `|| true` swallowed the failure, and the harness announced success over an
      // EMPTY database. A false green in the one check whose entire purpose is to be the real thing.
      //
      // So: pick the tool by the file's actual format, let it fail loudly, and then COUNT what
      // arrived. A restore that produced no tables is a failed restore whatever the exit code said.
      const head = fs.readFileSync(DUMP, { encoding: 'latin1', flag: 'r' }).slice(0, 8192);
      const isCustom = head.startsWith('PGDMP');
      const isTar = /\.tar$/i.test(DUMP);
      const tool = isCustom || isTar ? 'pg_restore' : 'psql';
      try {
        if (tool === 'pg_restore') {
          sh(`pg_restore -h ${temp.base} -p ${PGPORT} -U postgres -d existing --no-owner --no-privileges ${JSON.stringify(DUMP)}`);
        } else {
          // Plain SQL. ON_ERROR_STOP so a broken dump is an error rather than a half-restore.
          sh(`psql -h ${temp.base} -p ${PGPORT} -U postgres -d existing -v ON_ERROR_STOP=1 -q -f ${JSON.stringify(DUMP)}`);
        }
      } catch (e) {
        // pg_restore warns about owners and extensions on a dump from a managed service; those are
        // not fatal. A restore that produced tables is accepted, and the count below decides.
        const msg = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(-3).join(' | ');
        console.log(`        (restore reported: ${msg.slice(0, 200)})`);
      }

      const restored = (await q(
        `SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n;
      if (restored === 0) {
        bad(`${path.basename(DUMP)} restored ZERO tables — nothing was loaded`,
          `format detected: ${isCustom ? 'custom (PGDMP)' : isTar ? 'tar' : 'plain SQL'}; tool used: ${tool}. `
          + 'A .sql file needs psql, a .dump needs pg_restore. If this is a Railway backup, check it '
          + 'downloaded completely.');
        throw new Error('stop');
      }
      ok(`restored ${path.basename(DUMP)} via ${tool} — ${restored} table(s)`);

      // ── AND IT MUST BE THE RIGHT DATABASE ───────────────────────────────────
      //
      // The first real run of this was handed aros_full_backup_2026-08-06.sql — the AROS database,
      // not PlaybookOS. Every expected table was missing, and the harness went on to "migrate" it
      // and report failures that were nothing to do with the migration. Checking identity before
      // drawing conclusions is cheaper than explaining the conclusions afterwards.
      const SENTINELS = ['users', 'targets', 'activity_logs'];
      const present = [];
      for (const t of SENTINELS) {
        const r = await q(`SELECT to_regclass($1) IS NOT NULL AS p`, [`public.${t}`]);
        if (r.rows[0].p) present.push(t);
      }
      if (!present.length) {
        bad(`${path.basename(DUMP)} does not look like the PlaybookOS database`,
          `none of ${SENTINELS.join(', ')} exist in it. This is a backup of a DIFFERENT database — `
          + 'take the backup from the Postgres service attached to the PlaybookOS Railway project.');
        throw new Error('stop');
      }
      ok(`it is the PlaybookOS database (${present.join(', ')} present)`);

      // EVERY skipped-constraint gap, listed BEFORE the migration runs.
      //
      // The migration halts at the first required step that fails, so a run reports one of these at a
      // time — and finding the next one costs another 25MB dump, taken by hand, by the CEO. The first
      // such run halted at `outreach`; this says up front whether anything else is waiting behind it.
      //
      // It is a DIAGNOSTIC, not an assertion: a gap here is a decision (some repairs need a person to
      // choose which duplicate row survives), and the verdict belongs to the migration step that
      // actually tries it. Making this a failure would double-report the same defect.
      try {
        const out = execFileSync(process.execPath,
          [path.join(__dirname, 'check-skipped-inline-constraints.js'), '--against', urlFor('existing')],
          { encoding: 'utf8', stdio: 'pipe' });
        console.log('        no constraint declared inline is missing from this database');
        void out;
      } catch (e) {
        const text = `${e.stdout || ''}${e.stderr || ''}`;
        const lines = text.split('\n').filter((l) => /DECLARED but MISSING|^    \S|^        /.test(l));
        console.log('        ── skipped-constraint gaps in this database (diagnostic, not a verdict) ──');
        for (const l of lines.slice(0, 40)) console.log(`        ${l.trim()}`);
        console.log('        ── these are what will halt the migration below, in this order ──');
      }

      // ── THE CPHI DUPLICATE REPORT AND PLAN, from the same single command ──────────────────────
      //
      // Ruling 35 item 3 wants every affected group with its row ids, review statuses, notes, source
      // references and timestamps. Asking the owner to run a second tool to get it would mean another
      // round trip, and this release has already cost four. So the read-only report runs here and the
      // plan is written next to the dump.
      //
      // READ-ONLY, and on the RESTORED COPY — never production. It exits 1 when duplicates exist,
      // which is a finding about the data, not a failure of this harness, so its status is reported
      // and not adopted.
      try {
        const planOut = path.join(path.dirname(DUMP), 'cphi-reconcile-plan.json');
        let rout = ''; let rcode = 0;
        try {
          rout = execFileSync(process.execPath,
            [path.join(__dirname, 'cphi-reconcile.js'), '--plan-out', planOut],
            { encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024,
              env: { ...process.env, DATABASE_URL: urlFor('existing') } });
        } catch (e) { rcode = e.status === undefined ? 1 : e.status; rout = `${e.stdout || ''}${e.stderr || ''}`; }
        if (rcode === 0) {
          console.log('        cphi_exhibitor_matches has no duplicate pairs — nothing to reconcile');
        } else {
          console.log('\n        ── CPHI DUPLICATE RECONCILIATION REPORT (read-only, on the restore) ──');
          for (const l of rout.split('\n')) console.log(`        ${l}`);
          console.log(`        ── end of reconciliation report · plan written to ${planOut} ──\n`);

          // ── RULING 38 ITEM 8: APPLY TO THE ISOLATED RESTORE, THEN MIGRATE ──────────────────────
          //
          // Opt-in, and the flag names where it is allowed to act. The database it touches is the
          // disposable cluster this harness created and destroys at the end, never production — the
          // decoy test (check-dump-test-isolation.js) is what makes that a fact rather than a claim.
          if (RECONCILE_ON_RESTORE) {
            let acode = 0; let aout = '';
            try {
              aout = execFileSync(process.execPath,
                [path.join(__dirname, 'cphi-reconcile.js'), '--apply', planOut, '--confirm-not-production'],
                { encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024,
                  env: { ...process.env, DATABASE_URL: urlFor('existing'),
                    RECONCILE_ACTOR: process.env.RECONCILE_ACTOR || 'verify-prod-dump.sh (isolated restore)' } });
            } catch (e) { acode = e.status === undefined ? 1 : e.status; aout = `${e.stdout || ''}${e.stderr || ''}`; }
            console.log('        ── RECONCILIATION APPLIED TO THE ISOLATED RESTORE ──');
            for (const l of aout.split('\n')) console.log(`        ${l}`);
            console.log(`        ── apply exit ${acode} (1 means conflicting groups remain, which is not a failure) ──\n`);
            const remaining = (await q(
              `SELECT COUNT(*)::int n FROM (
                 SELECT 1 FROM cphi_exhibitor_matches
                  GROUP BY event_slug, holder_normalized HAVING COUNT(*) > 1) d`)).rows[0].n;
            if (remaining === 0) ok('reconciliation cleared every duplicate on the restore — idx_cem_unique can now be created');
            else bad(`${remaining} duplicate group(s) remain on the restore`, 'those are the CONFLICT groups; they need a decision before the index can exist');
          } else {
            console.log('        (read-only. To apply this plan to THIS RESTORE and then migrate:');
            console.log('         scripts/verify-prod-dump.sh <dump> --reconcile-on-restore)\n');
          }
        }
      } catch (e) {
        console.log(`        (could not produce the CPHI reconciliation report: ${e.message.split('\n')[0]})`);
      }
    } else {
      // Production-like: the migrator's schema, then representative rows, so the second migration
      // run below is against a POPULATED database rather than an empty one. Migrating an empty
      // database proves nothing about preserving data.
      const first = await require('../src/lib/migrate-all').runAll(q, { seeds: false, log: () => {} });
      if (!first.ok) { bad('could not build the baseline', first.failed.map((f) => f.error).join(' | ')); throw new Error('stop'); }
      ok(`baseline built by the migrator — ${first.steps.length} steps`);

      const CO = (await q(`SELECT id FROM companies WHERE slug='abiozen'`)).rows[0].id;
      const T = require('../src/lib/office/opportunity-tracker');
      const csv = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sam-opportunities-real-2026-11-06.csv'), 'utf8');
      const imp = await T.importCsv(q, { companyId: CO, importedBy: 'readiness@example.invalid', csvText: csv, sourceDetail: 'readiness baseline' });
      await T.assessAll(q, { companyId: CO, assessedBy: 'readiness', capabilities: [], evidenceBasis: 'real_registry', opts: { today: '2026-11-06' } });

      // A human decision and an audit event: the two things that cannot be re-derived from a
      // re-import, and therefore the two whose survival actually matters.
      const row = (await q(`SELECT id FROM federal_opportunities WHERE company_id=$1 AND is_current AND response_deadline IS NOT NULL ORDER BY id LIMIT 1`, [CO])).rows[0];
      await T.confirmDeadline(q, { companyId: CO, opportunityId: row.id, confirmedBy: 'readiness@example.invalid' });
      await q(`INSERT INTO opportunity_bid_reviews (id, company_id, opportunity_id, decision, decided_by, rationale)
               VALUES ('rev-readiness', $1, $2, 'no_bid', 'readiness@example.invalid',
                       'Recorded during the migration readiness review so its survival can be asserted.')`, [CO, row.id]);
      await require('../src/lib/office/opportunity-audit').record(q, {
        companyId: CO, opportunityId: row.id, action: 'review.recorded', actor: 'readiness@example.invalid', detail: { note: 'baseline' },
      });
      ok(`populated: ${imp.outcome.inserted.length} opportunities, 1 confirmed deadline, 1 human decision, 1 audit event`);
    }

    const TRACKED = ['users', 'companies', 'federal_opportunities', 'opportunity_assessments',
      'opportunity_bid_reviews', 'opportunity_audit_events', 'opportunity_import_batches',
      'notifications', 'outreach', 'prospects'];
    baseline = await fingerprint(q, TRACKED);
    console.log(`        baseline rows: ${JSON.stringify(baseline)}`);

    // Which of the application's columns exist BEFORE the migration. Without this reading, §6 cannot
    // tell a column the migration DROPPED from one it never created, and on the first real production
    // dump it reported five columns as "GONE" that had never existed — sending the reader looking for
    // a destructive statement that was not there. A backward-compatibility check needs a before.
    baselineCols = await columnPresence(q);
    baselineSchema = await schemaSnapshot(q);

    // ── 2. BACKUP, BEFORE ANYTHING IS CHANGED ────────────────────────────────
    h('2. BACKUP — taken before the migration, which is the only time it is worth anything');
    const dumpPath = `${temp.base}/pre-migration.dump`;
    try {
      sh(`pg_dump -h ${temp.base} -p ${PGPORT} -U postgres --format=custom --file=${dumpPath} existing`);
      const bytes = fs.statSync(dumpPath).size;
      if (bytes > 0) ok(`pg_dump --format=custom wrote ${bytes.toLocaleString()} bytes`);
      else bad('the dump is empty');
    } catch (e) { bad('pg_dump failed', e.message.split('\n')[0]); }

    // ── 3. THE 47 STEPS AGAINST A DATABASE THAT ALREADY HAS DATA ─────────────
    h('3. THE MIGRATION, AGAINST AN EXISTING POPULATED DATABASE');
    const { runAll, SCHEMA_STEPS } = require('../src/lib/migrate-all');
    const run = await runAll(q, { seeds: false, log: () => {} });
    if (run.ok) ok(`all ${run.steps.length} step(s) applied to a populated database`);
    else bad(`${run.failed.length} step(s) failed`, run.failed.map((f) => `${f.name}: ${f.error}`).join(' | '));
    console.log(`        (${SCHEMA_STEPS.length} schema steps declared)`);

    // ── 4. EXISTING DATA PRESERVED ───────────────────────────────────────────
    // ── BEFORE / AFTER SCHEMA COMPARISON (ruling 34 item 3) ──────────────────
    h('4. BEFORE / AFTER — WHAT THE MIGRATION CHANGED ABOUT THE SCHEMA');
    let diff = null;
    if (baselineSchema) {
      const afterSchema = await schemaSnapshot(q);
      diff = reportSchemaDiff(baselineSchema, afterSchema);
      // A dropped table or constraint is the only part of this that is a VERDICT; the rest is the
      // itemised picture the ruling asked for. Removals are asserted because they are what breaks a
      // rolling deploy and a rollback.
      if (!diff.removedT.length) ok('the migration dropped no table');
      else bad(`${diff.removedT.length} table(s) were DROPPED`, diff.removedT.join(', '));
      // sitenex_deals_referred_by is a documented, deliberate removal (migration-risk-report §1.2),
      // and so is the entity-only outreach UNIQUE (§1.4). Anything else wants explaining.
      const EXPECTED_REMOVALS = /referred_by|outreach_entity_type_entity_id_key/;
      const unexplained = [...diff.removedC, ...diff.removedI].filter((k) => !EXPECTED_REMOVALS.test(k));
      if (!unexplained.length) ok('every constraint removal is one of the two documented ones');
      else bad(`${unexplained.length} UNDOCUMENTED constraint removal(s)`, unexplained.join(' | '));
    } else {
      skip('before/after schema comparison', 'no baseline snapshot was taken');
    }

    h('5. EXISTING DATA PRESERVED');
    after = await fingerprint(q, TRACKED);
    const lost = [];
    for (const t of TRACKED) {
      const b = baseline[t]; const a = after[t];
      if (typeof b !== 'number') continue;              // table absent in the baseline
      if (typeof a !== 'number') { lost.push(`${t}: table is GONE after migration`); continue; }
      if (a < b) lost.push(`${t}: ${b} → ${a} (${b - a} row(s) LOST)`);
    }
    if (!lost.length) ok('no table lost rows');
    else bad(`${lost.length} table(s) lost data`, lost.join(' | '));

    // The two that cannot be re-derived from a re-import, so their survival is the thing that
    // actually matters. Asserted against the BASELINE, not against zero.
    //
    // A real production dump holds none of these yet — the tracker is not deployed — so demanding
    // a positive count failed a correct migration and said "the human decisions did not survive",
    // which is both alarming and false. An assertion that cannot distinguish "lost" from "never
    // existed" is the kind of red that teaches people to ignore exit codes.
    for (const [table, what] of [
      ['opportunity_bid_reviews', 'human bid/no-bid decision'],
      ['opportunity_audit_events', 'audit event'],
    ]) {
      const before = typeof baseline[table] === 'number' ? baseline[table] : null;
      const now = typeof after[table] === 'number' ? after[table] : null;
      if (before === null && now !== null) {
        // The table did not exist before and the migration created it. That is the normal case for
        // a database that predates this release, and it is not a failure: there was nothing to
        // preserve. Reporting it as "not readable before or after the migration" was alarming and
        // wrong on the first real production dump.
        skip(`${what}s: the table did not exist before this migration`, `created now, holding ${now} row(s)`);
      } else if (before === null || now === null) {
        // If the chain halted, this table's creating step never ran. Reporting it as its own failure
        // turns one root cause into four, and the reader then has four things to investigate instead
        // of one. Name the cause and let the real failure carry the verdict.
        if (!run.ok) {
          skip(`${table} is absent`, `the migration halted at ${run.failed.map((f) => f.name).join(', ')}, ` +
            `so the step that creates it never ran — not a data loss`);
        } else {
          bad(`${table} is not readable after the migration`, `before=${baseline[table]} after=${after[table]}`);
        }
      } else if (before === 0) {
        skip(`${what}s: none in the baseline`, 'nothing to preserve, so nothing is proved here');
      } else if (now >= before) {
        ok(`all ${before} ${what}(s) survived the migration`);
      } else {
        bad(`${before - now} ${what}(s) were LOST`, `${before} → ${now}`);
      }
    }

    // ── 5. IDEMPOTENCE ───────────────────────────────────────────────────────
    h('6. IDEMPOTENCE — a re-run must change nothing');
    const again = await runAll(q, { seeds: false, log: () => {} });
    if (again.ok) ok('the migration runs a second time without error');
    else bad('a re-run failed', again.failed.map((f) => f.error).join(' | '));
    const third = await fingerprint(q, TRACKED);
    const drifted = TRACKED.filter((t) => typeof after[t] === 'number' && after[t] !== third[t]);
    if (!drifted.length) ok('row counts identical after the re-run — no duplicate rows created');
    else bad(`${drifted.length} table(s) changed on a re-run`, drifted.map((t) => `${t}: ${after[t]} → ${third[t]}`).join(' | '));

    // ── 6. BACKWARD COMPATIBILITY ────────────────────────────────────────────
    h('7. BACKWARD COMPATIBILITY — would the PREVIOUS release still run?');
    // The question is whether the migration is additive. A column the old code reads that this
    // migration drops or renames would break the running application during a rolling deploy, and
    // would break a rollback afterwards.
    //
    // DROPPED and NEVER-CREATED are different findings and must not share a message. The first
    // production dump produced "5 column(s) the application reads are GONE" for five columns that
    // had never existed in that database — the chain had halted at `outreach`, so the steps that
    // create them never ran. That wording describes a destructive migration, which is the one thing
    // this check exists to detect, and it was not what happened. Reading the before tells them apart.
    const afterCols = await columnPresence(q);
    const { dropped, notCreated } = classifyColumns(baselineCols, afterCols);
    if (dropped.length) {
      bad(`${dropped.length} column(s) the application reads were DROPPED by the migration`,
        `${dropped.join(', ')} — present before, absent after. This breaks a rolling deploy and a rollback.`);
    } else {
      ok('the migration dropped no column the application reads');
    }
    if (notCreated.length) {
      // Whether this is a problem depends entirely on whether the migration completed.
      if (run.ok) {
        bad(`${notCreated.length} column(s) the application reads were never created`,
          `${notCreated.join(', ')} — the migration reported success without creating them`);
      } else {
        skip(`${notCreated.length} column(s) the application reads are absent`,
          `${notCreated.join(', ')} — never created, NOT dropped: the chain halted at ` +
          `${run.failed.map((f) => f.name).join(', ')}, so the steps that create them never ran. ` +
          `Fix that step and this resolves with it.`);
      }
    }

    // The one destructive statement in the chain, named so it is not discovered.
    const referred = await q(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_schema='public' AND table_name='sitenex_deals'
                                 AND column_name='referred_by') AS present`);
    if (!referred.rows[0].present) {
      ok('sitenex_deals.referred_by is absent — dropped by the rename, as documented, and no code reads it');
    } else {
      skip('sitenex_deals.referred_by is still present', 'the rename has not been applied to this database');
    }

    // ── 7. RECOVERY ──────────────────────────────────────────────────────────
    h('8. RECOVERY — restore the pre-migration backup and check it comes back');
    try {
      await client.end(); client = null;
      sh(`createdb -h ${temp.base} -p ${PGPORT} -U postgres recovered`);
      sh(`pg_restore -h ${temp.base} -p ${PGPORT} -U postgres -d recovered --no-owner --no-privileges ${dumpPath} || true`);
      const rec = new Client({ connectionString: urlFor('recovered') });
      await rec.connect();
      const recFingerprint = await fingerprint((s, p) => rec.query(s, p), TRACKED);
      const mismatched = TRACKED.filter((t) => typeof baseline[t] === 'number' && recFingerprint[t] !== baseline[t]);
      if (!mismatched.length) ok('the restored database matches the pre-migration baseline row for row');
      else bad(`${mismatched.length} table(s) differ after restore`,
        mismatched.map((t) => `${t}: ${baseline[t]} → ${recFingerprint[t]}`).join(' | '));

      // And it is a WORKING database, not just rows: the readiness check the server runs must pass.
      // Whether the RESTORED (pre-migration) database can start the server is only a meaningful
      // question if it could before. A backup taken from a database that predates this release
      // naturally lacks its tables — asserting otherwise failed a correct recovery and said "the
      // restored database would not start the server", which reads as a broken backup.
      //
      // What matters either way is that the restore reproduced the baseline, which is asserted
      // above, row for row.
      const baselineCouldStart = typeof baseline.users === 'number'
        && typeof baseline.federal_opportunities === 'number';
      const ready = await require('../src/lib/schema-ready').check((s, p) => rec.query(s, p));
      if (ready.ready) {
        ok('…and the restored database passes the readiness check the server runs at boot');
      } else if (!baselineCouldStart) {
        skip('the restored database does not pass the readiness check',
          'it predates this release, so it never could — the migration is what adds those tables. '
          + 'Recovery here means restoring and then re-migrating.');
      } else {
        bad('the restored database would not start the server', JSON.stringify(ready));
      }
      await rec.end();
    } catch (e) { bad('recovery failed', e.message.split('\n')[0]); }
  } catch (e) {
    if (!/^stop$/.test(e.message)) bad('the review could not complete', e.message.split('\n')[0]);
  } finally {
    try { if (client) await client.end(); } catch { /* closing */ }
    stopCluster();
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  ${pass} assertion(s) passed · ${fail} failed · ${notRun} did not run`);
  if (fail) { console.log('\nFAIL  the migration is not ready for a production database.\n'); process.exit(1); }
  if (!DUMP) {
    console.log('\nPASS WITH A NAMED LIMITATION');
    console.log('      The migration applied cleanly to a POPULATED database, preserved every row,');
    console.log('      is idempotent, is additive, and the pre-migration backup restored exactly.');
    console.log('');
    console.log('      It was NOT validated against production\'s own schema, because no dump was');
    console.log('      supplied. A fresh install and production have diverged before in this');
    console.log('      repository. Re-run as:');
    console.log('          node scripts/verify-migration-readiness.js prod-YYYYMMDD.dump');
    console.log('      before treating this as a production go-ahead.\n');
    process.exit(0);
  }
  console.log('\nPASS  validated against a restore of the real production database.\n');
  process.exit(0);
}

// Guarded so the negative control can require classifyColumns without starting a Postgres cluster.
// `node scripts/verify-migration-readiness.js` is unchanged.
if (require.main === module) {
  main().catch((e) => { console.error(`\nverify-migration-readiness: ${e.stack || e.message}\n`); stopCluster(); process.exit(1); });
}

module.exports = { classifyColumns, APP_COLUMNS };
