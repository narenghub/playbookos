#!/usr/bin/env node
// ── ENG-003 — PROVE LEAST-PRIVILEGE DATABASE ROLES ACTUALLY WORK ──────────────
//
//   node scripts/check-db-role-separation.js
//
// Ruling 19 item 5 promoted ENG-003 to a production release blocker and asked for a design:
// separate least-privilege roles for ordinary application operations and for trusted
// security-sensitive workflows.
//
// A design is a claim. This is the claim executed, on a disposable cluster, with no production
// involvement and no AWS account. It proves the mechanism works BEFORE anyone proposes changing
// the production DATABASE_URL.
//
// ── THE MECHANISM: COLUMN-LEVEL UPDATE GRANTS ────────────────────────────────
//
// PostgreSQL can grant UPDATE on specific COLUMNS:
//
//   GRANT UPDATE (scan_status, scan_version_id, …) ON intake_documents TO playbookos_scanner;
//
// So the application role can be given UPDATE on every column of intake_documents EXCEPT the scan
// verdict columns, and the scanner role UPDATE on only those. The application then cannot write a
// verdict — not because a trigger talked it out of it, but because it lacks the privilege.
//
// That is the difference between what ruling 18 item 6 delivered and what it asked for. The
// triggers stay as defence in depth; they were never the problem. The problem is that a superuser
// bypasses every GRANT, so today the triggers are all there is.
//
// ── WHY THIS IS A RELEASE BLOCKER AND NOT A TIDY-UP ──────────────────────────
//
// server.js line 3 runs about twelve migration functions at boot — initDB, initPhase2,
// migrateSchemas, migrateAutonomy, supplier-rfq migrate, rfq-identity-guard migrate, migrateRuns,
// migrateOffice, migrateResearchIntelligence, two phase-3 migrations, then three seeders. They
// issue CREATE TABLE and ALTER TABLE. A role without DDL privileges CANNOT BOOT THIS APPLICATION.
//
// So "point DATABASE_URL at a limited role" is not a configuration change. The boot-time migration
// chain has to be extracted into a migration entrypoint run as a separate role, as a separate
// deploy step, first. That refactor is the blocker; the grants below are the easy part, and this
// script exists so that the easy part is not also unverified.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const schema = require('../src/lib/office/intake-schema');
const { pgBinCandidates, INITDB_FLAGS } = require('./lib/pg-cluster');

const PGPORT = process.env.PGPORT_TEST || '55439';
const EXIT_NOT_EXECUTED = 3;

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 300)}`); };
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

// The columns that carry a security verdict. The application must not be able to write these.
const VERDICT_COLUMNS = [
  'scan_status', 'scan_version_id', 'scan_provider', 'scan_provider_status',
  'scan_detail', 'scanned_at',
];
// Everything the application legitimately writes on intake_documents.
const APP_COLUMNS = [
  'id', 'company_id', 'submitted_by', 'submitted_at', 'origin', 'source_url',
  'filename_original', 'declared_mime', 'detected_mime', 'byte_size', 'sha256',
  'storage_bucket', 'storage_key', 'storage_kms_key_id', 'storage_version_id',
  'integrity_checked_at', 'integrity_ok',
];

let temp = null;
function pgBin() {
  for (const d of pgBinCandidates()) return d;
  return null;
}
function startCluster() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/roles-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) {
    console.error(`cluster start failed: ${e.message}`);
    try { console.error(fs.readFileSync(`${base}/pg.log`, 'utf8').slice(-800)); } catch (_) { /* */ }
    return null;
  }
  temp = { base, dir, asPostgres };
  return base;
}
function stopCluster() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

const refused = async (c, sql, params) => {
  try { await c.query(sql, params); return null; } catch (e) { return e.message; }
};

async function main() {
  h('ENG-003 — LEAST-PRIVILEGE DATABASE ROLES, EXECUTED NOT PROPOSED');
  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no complete PostgreSQL server toolchain. This asserted NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }
  const url = (user) => `postgresql://${user}@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  const su = new Client({ connectionString: url('postgres') });
  await su.connect();
  const q = (sql, p) => su.query(sql, p);

  let app = null; let scanner = null; let migrator = null;
  try {
    // ── 1. the schema, built by a migrator identity ────────────────────────
    h('1. THE PRECONDITIONS AND THE v3 SCHEMA');
    // ── THE REAL MIGRATOR, NOT HAND-WRITTEN STUBS ──────────────────────────
    //
    // This block used to hand-write companies, solicitations, verified_capabilities and
    // source_connectors. The stub source_connectors omitted base_url, which the real table declares
    // NOT NULL — so when the v3 seed was corrected to satisfy the real schema, this check went red
    // while the product was right. The same stub-versus-real divergence has now cost three separate
    // harnesses in this repository.
    //
    // The migrator is what a deployment runs, so it is what this runs. The roles below are then
    // created against a schema identical to production's, which is the only way this check means
    // anything about production.
    process.env.DATABASE_URL = url('postgres');
    process.env.ADMIN_EMAIL = 'eng003-roles-fixture@example.invalid';
    // Generated per run, never read from the environment: `process.env.X || '<literal>'`
    // is the exact shape of a hard-coded fallback credential, and check-secrets.js refuses
    // it on sight — correctly, because it cannot tell an ephemeral fixture from a real one.
    // This value exists for one disposable cluster and is discarded with it.
    process.env.ADMIN_PASSWORD = require('crypto').randomBytes(18).toString('hex');
    process.env.PRPA_COMPANY_SLUG = 'abiozen';
    const migResult = await require('../src/lib/migrate-all').runAll(q, { seeds: false, log: () => {} });
    if (!migResult.ok) throw new Error(`migration failed: ${migResult.failed.map((f) => `${f.name}: ${f.error}`).join(' | ')}`);
    // A fixture company with the id the assertions below use. The migrator seeds the real
    // 'abiozen' row; this one exists so the literals in this file keep naming a row that exists,
    // and so nothing here writes against the company the product uses.
    await q(`INSERT INTO companies (id, slug, display_name, status)
             VALUES ('co-a', 'roles-fixture', 'Roles fixture company', 'active')
             ON CONFLICT (id) DO NOTHING`);
    // raw_json is NOT NULL on the real table — the stub had no such column at all.
    await q(`INSERT INTO solicitations (id, company_id, source_key, notice_id, record_kind, raw_json)
             VALUES ('sol-a', 'co-a', 'manual', 'notice-a', 'solicitation', '{}'::jsonb)
             ON CONFLICT (id) DO NOTHING`);
    await q(`INSERT INTO users (id, email, name, role, is_active)
             VALUES ('u1','naren@abiozen.com','Naren B','super_admin', 1)
             ON CONFLICT (email) DO NOTHING`);
    ok(`schema applied by the migrator — ${migResult.steps.length} steps`);
    ok(`v3 included: ${schema.CREATED_TABLES.length} intake tables present via the migrator`);

    // ── 2. the roles, exactly as proposed for production ───────────────────
    h('2. THREE ROLES, AND NOT ONE OF THEM A SUPERUSER');
    // The migrator owns DDL. It is NOT the role the application runs as, which is the whole point:
    // the boot-time migration chain has to move out of the application before this is possible.
    await q(`CREATE ROLE playbookos_migrator LOGIN`);
    await q(`CREATE ROLE playbookos_app LOGIN`);
    await q(`CREATE ROLE playbookos_scanner LOGIN`);

    const BUSINESS = ['companies', 'solicitations', 'verified_capabilities', 'source_connectors',
      'skus', 'suppliers', 'users', 'solicitation_requirements', 'requirement_matches',
      'fulfillment_authorizations', 'intake_audit', 'document_download_grants'];

    await q(`GRANT USAGE ON SCHEMA public TO playbookos_app, playbookos_scanner, playbookos_migrator`);
    // PostgreSQL 15 stopped granting CREATE on schema public to PUBLIC, so a migrator role needs
    // it explicitly. The first run of this script failed here, which is the kind of thing that
    // would otherwise have been discovered during a production cutover.
    await q(`GRANT CREATE ON SCHEMA public TO playbookos_migrator`);
    for (const t of BUSINESS) {
      await q(`GRANT SELECT, INSERT, UPDATE ON ${t} TO playbookos_app`);
    }
    // intake_documents: UPDATE on everything EXCEPT the verdict columns.
    await q(`GRANT SELECT, INSERT ON intake_documents TO playbookos_app`);
    await q(`GRANT UPDATE (${APP_COLUMNS.join(', ')}) ON intake_documents TO playbookos_app`);
    // The scanner: the verdict columns, and the results table. Nothing else.
    await q(`GRANT SELECT ON intake_documents TO playbookos_scanner`);
    await q(`GRANT UPDATE (${VERDICT_COLUMNS.join(', ')}) ON intake_documents TO playbookos_scanner`);
    await q(`GRANT SELECT, INSERT ON document_scan_results TO playbookos_scanner`);
    await q(`GRANT SELECT ON document_scan_results TO playbookos_app`);
    await q(`GRANT SELECT ON companies, solicitations TO playbookos_scanner`);
    ok('roles created with column-level grants, no superuser among them');

    app = new Client({ connectionString: url('playbookos_app') }); await app.connect();
    scanner = new Client({ connectionString: url('playbookos_scanner') }); await scanner.connect();
    migrator = new Client({ connectionString: url('playbookos_migrator') }); await migrator.connect();
    for (const [n, c] of [['app', app], ['scanner', scanner], ['migrator', migrator]]) {
      const r = await c.query(`SELECT current_user, usesuper FROM pg_user WHERE usename = current_user`);
      if (r.rows[0] && r.rows[0].usesuper === false) ok(`'${n}' connects as ${r.rows[0].current_user}, usesuper=false`);
      else bad(`'${n}' is a superuser`, JSON.stringify(r.rows[0] || null));
    }

    // ── 3. THE POINT: the application cannot write a verdict ───────────────
    h('3. THE APPLICATION ROLE CANNOT WRITE A SCAN VERDICT — BY PRIVILEGE');
    await app.query(
      `INSERT INTO intake_documents
         (id,company_id,submitted_by,origin,byte_size,sha256,detected_mime,
          storage_bucket,storage_key,storage_version_id)
       VALUES ('d1','co-a','naren','upload',1024,$1,'application/pdf','b','prpa/co-a/x.pdf','v1')`,
      ['a'.repeat(64)]);
    ok('the app CAN file a document — this is a gate, not a wall');

    for (const col of VERDICT_COLUMNS) {
      const v = col === 'scanned_at' ? 'NOW()' : `'clean'`;
      const msg = await refused(app, `UPDATE intake_documents SET ${col} = ${v} WHERE id='d1'`);
      if (msg && /permission denied/i.test(msg)) ok(`app UPDATE of ${col} → PERMISSION DENIED`);
      else bad(`app could write ${col}`, msg || 'accepted');
    }
    const ins = await refused(app,
      `INSERT INTO document_scan_results
         (id,company_id,document_id,storage_version_id,provider,channel,provider_event_id,
          provider_status,mapped_status)
       VALUES ('s-forge','co-a','d1','v1','aws_guardduty_malware_protection_s3','eventbridge',
               'e-forge','NO_THREATS_FOUND','clean')`);
    if (ins && /permission denied/i.test(ins)) ok('app INSERT into document_scan_results → PERMISSION DENIED');
    else bad('the app could fabricate a scan result', ins || 'accepted');

    // And the app CAN still do its own job on the same table.
    const own = await refused(app, `UPDATE intake_documents SET integrity_ok = true, integrity_checked_at = NOW() WHERE id='d1'`);
    if (!own) ok('app CAN still write integrity fields — the split is per column, not per table');
    else bad('the app lost a column it needs', own);

    // ── 4. the scanner can do exactly its job, and nothing else ────────────
    h('4. THE SCANNER ROLE CAN RECORD A VERDICT AND NOTHING ELSE');
    const si = await refused(scanner,
      `INSERT INTO document_scan_results
         (id,company_id,document_id,storage_version_id,provider,channel,provider_event_id,
          provider_status,mapped_status)
       VALUES ('s1','co-a','d1','v1','aws_guardduty_malware_protection_s3','eventbridge',
               'e1','NO_THREATS_FOUND','clean')`);
    if (!si) ok('scanner CAN ingest a verdict');
    else bad('the scanner could not do its job', si);

    const sv = await refused(scanner,
      `UPDATE intake_documents SET scan_status='clean', scan_version_id='v1', scanned_at=NOW() WHERE id='d1'`);
    if (!sv) ok('scanner CAN reflect the verdict onto the document');
    else bad('the scanner could not reflect its verdict', sv);

    for (const [what, sql] of [
      ['a document it did not scan', `UPDATE intake_documents SET submitted_by='someone-else' WHERE id='d1'`],
      ['a bid authorization', `INSERT INTO fulfillment_authorizations (id,company_id,solicitation_id,scope,authorized_by,approval_id) VALUES ('a1','co-a','sol-a','50 kg','naren@abiozen.com','ap1')`],
      ['a requirement', `INSERT INTO solicitation_requirements (id,company_id,solicitation_id,requirement_kind,description) VALUES ('r1','co-a','sol-a','material','x')`],
      ['a download grant', `INSERT INTO document_download_grants (id,company_id,document_id,storage_version_id,granted_to,expires_at,purpose) VALUES ('g1','co-a','d1','v1','x',NOW()+INTERVAL '5 minutes','human_review')`],
    ]) {
      const msg = await refused(scanner, sql);
      if (msg && /permission denied/i.test(msg)) ok(`scanner writing ${what} → PERMISSION DENIED`);
      else bad(`the scanner could write ${what}`, msg || 'accepted');
    }

    // ── 5. neither role may change the shape of the database ───────────────
    h('5. NEITHER APPLICATION NOR SCANNER MAY RUN DDL');
    for (const [n, c] of [['app', app], ['scanner', scanner]]) {
      for (const [what, sql] of [
        ['CREATE TABLE', `CREATE TABLE sneaky (id TEXT)`],
        ['ALTER TABLE', `ALTER TABLE intake_documents ADD COLUMN sneaky TEXT`],
        ['DROP TRIGGER', `DROP TRIGGER trg_prpa_scan_status_must_be_ingested ON intake_documents`],
        ['CREATE FUNCTION', `CREATE FUNCTION sneaky() RETURNS INT AS 'SELECT 1' LANGUAGE sql`],
      ]) {
        const msg = await refused(c, sql);
        if (msg && /permission denied|must be owner|denied/i.test(msg)) ok(`${n}: ${what} → REFUSED`);
        else bad(`${n} could run ${what}`, msg || 'accepted');
      }
    }
    // The one that matters most: dropping the trigger would disarm every control above it.
    ok('a role that cannot DROP TRIGGER cannot disarm the guards that protect it');

    // ── 6. and this is why it is a BLOCKER, not a configuration change ─────
    h("6. WHY THIS IS A RELEASE BLOCKER: THE APP'S OWN BOOT NEEDS DDL");
    const bootDdl = await refused(app, `CREATE TABLE IF NOT EXISTS github_stats (id TEXT PRIMARY KEY)`);
    if (bootDdl && /permission denied/i.test(bootDdl)) {
      ok('the app role cannot run the CREATE TABLE statements server.js issues at boot');
      console.log('        server.js line 3 chains ~12 migrations before listening. Pointing');
      console.log('        DATABASE_URL at this role today would fail at startup, not at runtime.');
      console.log('        Extracting that chain into a migrator entrypoint IS the blocker;');
      console.log('        the grants above are the easy part, and they now have a test.');
    } else bad('the app role could run boot DDL — then these grants are not least privilege', bootDdl || 'accepted');
    const mig = await refused(migrator, `CREATE TABLE migrator_can (id TEXT PRIMARY KEY)`);
    if (!mig) ok('a migrator identity CAN run DDL — so the split is workable, not merely restrictive');
    else bad('the migrator could not run DDL; the proposed split would not work', mig);

    // ── 7. EVERY TABLE AND EVERY SEQUENCE (ruling 49 item 3) ───────────────
    //
    // The checks above prove the SHAPE of the separation on the tables they name. This proves the
    // COVERAGE: that the runtime role can actually do its job on every table and sequence the
    // migration leaves behind, not just the ones a test happened to pick.
    //
    // The sequences half is the part that bites in production. INSERT on a table with a BIGSERIAL
    // column calls nextval() on its sequence, and nextval needs USAGE on that sequence — a grant
    // that is easy to leave out because it is not a table grant. A role with INSERT on every table
    // and USAGE on no sequence passes every table-level check and then fails on the first insert.
    h('7. COVERAGE: every table and every sequence the migration leaves behind');

    // THE GRANTS UNDER TEST ARE THE ONES WE SHIP. The fixture roles above hold deliberately narrow,
    // column-level grants, because sections 3 to 6 exist to prove specific refusals. Sweeping those
    // would measure the fixture, not the artifact — the first run of this section reported 153
    // tables and 54 sequences "the runtime role cannot use", which was true of the fixture and
    // false of production.
    //
    // So: read docs/deploy/prod-roles.sql, take its REVOKE/GRANT/ALTER DEFAULT PRIVILEGES
    // statements verbatim, point them at a fresh role, and sweep THAT. If someone deletes the
    // sequence grant from that file, this fails. Comment lines are stripped first, since the file's
    // footer carries a commented-out rollback block whose REVOKEs would otherwise be executed.
    const SHIPPED = 'playbookos_app_shipped';
    const roleSql = fs.readFileSync(path.join(__dirname, '..', 'docs', 'deploy', 'prod-roles.sql'), 'utf8')
      .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^(REVOKE|GRANT|ALTER DEFAULT PRIVILEGES)/i.test(s) && /playbookos_app/.test(s))
      .map((s) => s.replace(/playbookos_app/g, SHIPPED));

    if (roleSql.length < 4) {
      bad(`only ${roleSql.length} grant statement(s) found in prod-roles.sql`,
        'the file this sweep is meant to validate did not parse — the sweep would prove nothing');
    } else {
      await su.query(`CREATE ROLE ${SHIPPED} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
      for (const s of roleSql) await su.query(s);
      ok(`applied ${roleSql.length} grant statement(s) taken verbatim from docs/deploy/prod-roles.sql`);
    }

    const tables = (await su.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows
      .map((r) => r.tablename);
    const missing = [];
    for (const t of tables) {
      const r = (await su.query(
        `SELECT has_table_privilege('playbookos_app_shipped', $1, 'SELECT') s,
                has_table_privilege('playbookos_app_shipped', $1, 'INSERT') i,
                has_table_privilege('playbookos_app_shipped', $1, 'UPDATE') u,
                has_table_privilege('playbookos_app_shipped', $1, 'DELETE') d`, [`public.${t}`])).rows[0];
      const lack = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].filter((p, n) => !r[['s', 'i', 'u', 'd'][n]]);
      if (lack.length) missing.push(`${t} (${lack.join(',')})`);
    }
    if (!missing.length) ok(`the runtime role holds SELECT/INSERT/UPDATE/DELETE on all ${tables.length} table(s)`);
    else {
      bad(`${missing.length} table(s) the runtime role cannot fully use`,
        `${missing.slice(0, 6).join('; ')}${missing.length > 6 ? ` … and ${missing.length - 6} more` : ''}`);
    }

    const seqs = (await su.query(
      `SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`)).rows
      .map((r) => r.sequencename);
    const noUsage = [];
    for (const s of seqs) {
      const r = (await su.query(
        `SELECT has_sequence_privilege('playbookos_app_shipped', $1, 'USAGE') u`, [`public.${s}`])).rows[0];
      if (!r.u) noUsage.push(s);
    }
    if (!seqs.length) bad('no sequences found', 'the sweep proved nothing');
    else if (!noUsage.length) ok(`…and USAGE on all ${seqs.length} sequence(s) — nextval() will work on every insert`);
    else {
      bad(`${noUsage.length} sequence(s) the runtime role cannot use`,
        `${noUsage.slice(0, 6).join(', ')} — an INSERT into the owning table would fail`);
    }

    // And the end-to-end version of the same thing: a real INSERT that must call nextval().
    const serialTable = (await su.query(
      `SELECT c.relname AS t, a.attname AS col
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE c.relkind = 'r' AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%'
        ORDER BY c.relname LIMIT 1`)).rows[0];
    if (serialTable) {
      const seqOf = (await su.query(
        `SELECT pg_get_serial_sequence($1, $2) AS s`, [`public.${serialTable.t}`, serialTable.col])).rows[0].s;
      // End to end as the SHIPPED role: a grant in a catalog and a working nextval() are not the
      // same claim, and INSERT is the operation that needs the second one.
      const shipped = new Client({ connectionString: url(SHIPPED) });
      await shipped.connect();
      const nv = await refused(shipped, `SELECT nextval('${seqOf}')`);
      if (!nv) ok(`the shipped runtime role can call nextval() on ${seqOf} — proved, not inferred`);
      else bad(`the shipped runtime role cannot call nextval() on ${seqOf}`, nv);
      const ddl = await refused(shipped, `CREATE TABLE shipped_probe (x int)`);
      if (ddl && /permission denied/i.test(ddl)) ok('…and that same role still cannot CREATE TABLE');
      else bad('the shipped grants allow DDL', ddl || 'CREATE TABLE was accepted');

      // ── FUTURE OBJECTS (ruling 50 item 3) ───────────────────────────────
      //
      // ALTER DEFAULT PRIVILEGES is the half of prod-roles.sql that nobody notices until the
      // release after next: without it, the NEXT migration's new tables are invisible to the
      // runtime role and every request touching them fails with "permission denied" — on a deploy
      // where nothing about the roles was changed, which is the hardest kind to diagnose.
      //
      // So a table and a sequence are created AFTER the grants were applied, as the owner, exactly
      // as a future migration would, and the role's access to them is checked. Nothing about the
      // existing-object sweep above can detect this.
      await su.query(`CREATE TABLE future_migration_probe (id BIGSERIAL PRIMARY KEY, x TEXT)`);
      const fut = (await su.query(
        `SELECT has_table_privilege('playbookos_app_shipped', 'public.future_migration_probe', 'INSERT') i,
                has_table_privilege('playbookos_app_shipped', 'public.future_migration_probe', 'SELECT') s,
                has_sequence_privilege('playbookos_app_shipped',
                  pg_get_serial_sequence('public.future_migration_probe','id'), 'USAGE') u`)).rows[0];
      if (fut.i && fut.s && fut.u) {
        ok('a table created AFTER the grants is usable by the role, sequence included — ALTER DEFAULT PRIVILEGES works');
      } else {
        bad('a future migration\'s table would NOT be usable by the runtime role',
          `insert=${fut.i} select=${fut.s} sequence=${fut.u} — prod-roles.sql's ALTER DEFAULT `
          + 'PRIVILEGES is missing or incomplete; the next release would fail with permission denied');
      }
      const futInsert = await refused(shipped, `INSERT INTO future_migration_probe (x) VALUES ('proof')`);
      if (!futInsert) ok('…proved by actually inserting into it, which calls nextval() on its new sequence');
      else bad('the insert into a post-grant table failed', futInsert);
      await su.query(`DROP TABLE future_migration_probe`);
      await shipped.end();
    } else console.log('        (no nextval-defaulted column found to exercise end to end)');

    h('RESULT');
    console.log(`  ${pass} assertion(s) passed · ${fail} failed`);
    if (fail === 0) {
      console.log('\n  The design in ENG-003 is not a proposal. The mechanism is PostgreSQL');
      console.log('  column-level UPDATE grants, it works, and the application role provably');
      console.log('  cannot write a scan verdict or fabricate a scan result.');
      console.log('\n  The boot-time migration chain HAS now been moved out of the application');
      console.log('  (ruling 27 item 5) — scripts/check-startup-without-ddl.js proves the app');
      console.log('  starts and does its real work as a restricted role. What remains is the');
      console.log('  DEPLOYMENT: production still connects with one superuser DATABASE_URL.');
      console.log('  docs/deploy/prpa-cloud-handover.md section 4 has the exact statements.');
    }
  } finally {
    for (const c of [app, scanner, migrator]) { if (c) { try { await c.end(); } catch (_) { /* */ } } }
    try { await su.end(); } catch (_) { /* */ }
    stopCluster();
  }
  return fail;
}

main()
  .then((f) => {
    if (f) { console.log('\nFAIL  least-privilege role separation does not hold as designed.\n'); process.exit(1); }
    console.log('\nPASS  role separation demonstrated on a disposable cluster. No production involved.\n');
    process.exit(0);
  })
  .catch((e) => { stopCluster(); console.error(e); process.exit(1); });
