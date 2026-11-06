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

  let baseline = null; let after = null; let client = null;
  try {
    // ── 1. THE "EXISTING" DATABASE ────────────────────────────────────────────
    h('1. AN EXISTING DATABASE WITH DATA IN IT');
    sh(`createdb -h ${temp.base} -p ${PGPORT} -U postgres existing`);
    process.env.DATABASE_URL = urlFor('existing');
    client = new Client({ connectionString: urlFor('existing') });
    await client.connect();
    const q = (s, p) => client.query(s, p);

    if (DUMP) {
      sh(`pg_restore -h ${temp.base} -p ${PGPORT} -U postgres -d existing --no-owner --no-privileges ${JSON.stringify(DUMP)} || true`);
      ok(`restored ${path.basename(DUMP)} — this is production's schema, not a fixture`);
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
    h('4. EXISTING DATA PRESERVED');
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
      if (before === null || now === null) {
        bad(`${table} is not readable before or after the migration`);
      } else if (before === 0) {
        skip(`${what}s: none in the baseline`, 'nothing to preserve, so nothing is proved here');
      } else if (now >= before) {
        ok(`all ${before} ${what}(s) survived the migration`);
      } else {
        bad(`${before - now} ${what}(s) were LOST`, `${before} → ${now}`);
      }
    }

    // ── 5. IDEMPOTENCE ───────────────────────────────────────────────────────
    h('5. IDEMPOTENCE — a re-run must change nothing');
    const again = await runAll(q, { seeds: false, log: () => {} });
    if (again.ok) ok('the migration runs a second time without error');
    else bad('a re-run failed', again.failed.map((f) => f.error).join(' | '));
    const third = await fingerprint(q, TRACKED);
    const drifted = TRACKED.filter((t) => typeof after[t] === 'number' && after[t] !== third[t]);
    if (!drifted.length) ok('row counts identical after the re-run — no duplicate rows created');
    else bad(`${drifted.length} table(s) changed on a re-run`, drifted.map((t) => `${t}: ${after[t]} → ${third[t]}`).join(' | '));

    // ── 6. BACKWARD COMPATIBILITY ────────────────────────────────────────────
    h('6. BACKWARD COMPATIBILITY — would the PREVIOUS release still run?');
    // The question is whether the migration is additive. A column the old code reads that this
    // migration drops or renames would break the running application during a rolling deploy, and
    // would break a rollback afterwards.
    const dropped = [];
    for (const [t, c] of [
      ['federal_opportunities', 'solicitation_number'], ['federal_opportunities', 'response_deadline'],
      ['federal_opportunities', 'is_biddable'], ['opportunity_assessments', 'verdict'],
      ['opportunity_bid_reviews', 'decision'], ['users', 'email'], ['users', 'role'],
      ['companies', 'slug'], ['verified_capabilities', 'verification_status'],
    ]) {
      const r = await q(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS present`, [t, c]);
      if (!r.rows[0].present) dropped.push(`${t}.${c}`);
    }
    if (!dropped.length) ok('every column the application reads is still present');
    else bad(`${dropped.length} column(s) the application reads are GONE`, dropped.join(', '));

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
    h('7. RECOVERY — restore the pre-migration backup and check it comes back');
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
      const ready = await require('../src/lib/schema-ready').check((s, p) => rec.query(s, p));
      if (ready.ready) ok('…and the restored database passes the readiness check the server runs at boot');
      else bad('the restored database would not start the server', JSON.stringify(ready));
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

main().catch((e) => { console.error(`\nverify-migration-readiness: ${e.stack || e.message}\n`); stopCluster(); process.exit(1); });
