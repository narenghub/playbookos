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
    await q(`CREATE TABLE companies (id TEXT PRIMARY KEY, slug TEXT, name TEXT, status TEXT,
               UNIQUE (id, status))`);
    await q(`CREATE TABLE solicitations (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
               record_kind TEXT, active BOOLEAN DEFAULT true, response_deadline DATE,
               UNIQUE (id, company_id))`);
    await q(`CREATE TABLE verified_capabilities (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
               kind TEXT, UNIQUE (id, company_id))`);
    await q(`CREATE TABLE source_connectors (source_key TEXT PRIMARY KEY, display_name TEXT, kind TEXT,
               auth_mode TEXT, access_mode TEXT, daily_call_ceiling INT, activated BOOLEAN, notes TEXT)`);
    await q(`CREATE TABLE skus (id TEXT PRIMARY KEY, name TEXT)`);
    await q(`CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT)`);
    await q(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT, is_active INT DEFAULT 1)`);
    await q(`INSERT INTO companies VALUES ('co-a','abiozen','Abiozen LLC','active')`);
    await q(`INSERT INTO solicitations (id,company_id,record_kind) VALUES ('sol-a','co-a','solicitation')`);
    await q(`INSERT INTO skus VALUES ('sku-1','A molecule')`);
    await q(`INSERT INTO users (id,email,role,is_active) VALUES ('u1','naren@abiozen.com','super_admin',1)`);
    for (const stmt of schema.DDL) await q(stmt);
    ok(`v3 schema applied — ${schema.DDL.length} statements, ${schema.CREATED_TABLES.length} tables`);

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

    h('RESULT');
    console.log(`  ${pass} assertion(s) passed · ${fail} failed`);
    if (fail === 0) {
      console.log('\n  The design in ENG-003 is not a proposal. The mechanism is PostgreSQL');
      console.log('  column-level UPDATE grants, it works, and the application role provably');
      console.log('  cannot write a scan verdict or fabricate a scan result.');
      console.log('\n  What remains is not the grants. It is moving ~12 boot-time migrations out of');
      console.log('  the application so a non-DDL role can start it. That is the blocker.');
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
