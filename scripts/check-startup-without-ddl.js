#!/usr/bin/env node
// ── ENG-003 — PROVE THE APPLICATION STARTS WITHOUT SUPERUSER OR DDL ──────────
//
//   node scripts/check-startup-without-ddl.js
//
// Ruling 27 item 5: "Move boot-time DDL into a separate migration process and verify normal startup
// without superuser or DDL privileges."
//
// The design was verified in scripts/check-db-role-separation.js. What that did NOT prove is the
// part that was actually blocking: that THIS application, with its real boot path, can start as a
// restricted role. Until the boot chain moved, it could not — boot applied a dozen migrations, so
// DDL was required, so the role had to be a superuser, so GRANT and RLS were bypassed.
//
// This runs the whole thing on a disposable cluster:
//
//   1. start a throwaway cluster; the bootstrap role owns it
//   2. run the MIGRATOR (src/lib/migrate-all) as that owner — DDL allowed
//   3. create playbookos_app: NOSUPERUSER, NOCREATEDB, NOCREATEROLE, no CREATE on the schema
//   4. run the SERVER'S OWN readiness check as playbookos_app, and require it to pass
//   5. attempt DDL as playbookos_app, and require every attempt to FAIL
//   6. exercise the PRPA read and write paths as playbookos_app, and require them to work
//
// Step 4 is the claim. Step 5 is what makes step 4 mean something: a check that passes because the
// role is secretly privileged proves nothing, so the restriction is demonstrated by attempting what
// it forbids.
//
// Exit status is the verdict. 0 = the application can run restricted. 3 = could not execute (no
// Postgres toolchain), which is NOT a pass.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
// The shared Postgres discovery. Not a local copy of the search path: thirty-five harnesses each
// carried one, they drifted, and on 2026-11-03 thirty-one preflight steps reported `ok` having
// executed nothing. scripts/pg-harness-discipline.test.js fails the build if a harness declares its
// own, and this is the module it points at.
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.ENG003_PGPORT || '55439';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;

// initdb refuses to run as root, so as root we drop to the postgres OS user — and INITDB_FLAGS
// carries `-U postgres`, which is what makes the bootstrap ROLE's name match the connection string
// on a machine where the invoking user is somebody else.
function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/eng003-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) {
    console.error(`  (cluster start failed: ${e.message})`);
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
  } catch { /* going away anyway */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp dir */ }
}

async function main() {
  h('ENG-003 — DOES THE APPLICATION START WITHOUT SUPERUSER OR DDL?');

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  const ownerUrl = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  const appUrl = `postgresql://playbookos_app@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;

  // src/lib/db reads DATABASE_URL when it is first required, and migrate-all goes through it. Set
  // it to the OWNER url before that first require.
  process.env.DATABASE_URL = ownerUrl;
  process.env.PRPA_COMPANY_SLUG = 'abiozen';

  // initDB() seeds the FIRST admin user when no admin exists, and refuses to run without
  // ADMIN_EMAIL and ADMIN_PASSWORD rather than falling back to a known default — which is correct,
  // and is a real prerequisite of the migrator's first run against an empty database.
  //
  // These values are throwaway fixtures for a cluster that is destroyed at the end of this script.
  // They are not a credential, they are not reused anywhere, and nothing outside this process can
  // reach the socket they apply to (listen_addresses is empty — the cluster has no TCP port).
  process.env.ADMIN_EMAIL = 'eng003-fixture@example.invalid';
  process.env.ADMIN_PASSWORD = `fixture-only-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  const oq = (sql, p) => owner.query(sql, p);

  let app = null;
  try {
    // ── 1. MIGRATE AS THE OWNER ────────────────────────────────────────────────
    h('1. THE MIGRATOR RUNS AS A ROLE WITH DDL');
    const { runAll } = require('../src/lib/migrate-all');
    const out = await runAll(oq, { seeds: false, log: (s) => console.log(`    ${s.trim()}`) });
    if (out.ok) ok(`all ${out.steps.length} migration step(s) applied`);
    else bad(`${out.failed.length} migration step(s) failed`, out.failed.map((f) => `${f.name}: ${f.error}`).join(' | '));

    const schemaReady = require('../src/lib/schema-ready');
    const readyAsOwner = await schemaReady.check(oq);
    if (readyAsOwner.ready) ok('the readiness check passes as the owner');
    else bad('the readiness check fails even as the owner', JSON.stringify(readyAsOwner));

    // ── 2. THE RESTRICTED ROLE ─────────────────────────────────────────────────
    h('2. A ROLE WITH NO SUPERUSER AND NO DDL');
    await oq(`CREATE ROLE playbookos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
    // PostgreSQL 15 stopped granting CREATE on schema public to PUBLIC, so this role has no CREATE
    // to begin with. REVOKE is here anyway: on a cluster restored from an older dump, PUBLIC may
    // still hold it, and the role would silently be able to create tables.
    await oq(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await oq(`REVOKE ALL ON SCHEMA public FROM playbookos_app`);
    await oq(`GRANT USAGE ON SCHEMA public TO playbookos_app`);
    await oq(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO playbookos_app`);
    await oq(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO playbookos_app`);

    const role = (await oq(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = 'playbookos_app'`)).rows[0];
    if (!role.rolsuper) ok('playbookos_app is NOT a superuser'); else bad('playbookos_app is a superuser');
    if (!role.rolcreatedb) ok('…cannot create databases'); else bad('it can create databases');
    if (!role.rolcreaterole) ok('…cannot create roles'); else bad('it can create roles');
    if (!role.rolbypassrls) ok('…cannot bypass row-level security'); else bad('it can bypass RLS');

    app = new Client({ connectionString: appUrl });
    await app.connect();
    const aq = (sql, p) => app.query(sql, p);

    const canCreate = (await aq(
      `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS c`)).rows[0].c;
    if (!canCreate) ok('…and holds no CREATE privilege on schema public'); else bad('it holds CREATE on schema public');

    // ── 3. THE CLAIM: BOOT'S OWN CHECK PASSES AS THE RESTRICTED ROLE ───────────
    h('3. THE SERVER\'S READINESS CHECK, RUN AS THE RESTRICTED ROLE');
    const readyAsApp = await schemaReady.check(aq);
    if (readyAsApp.ready) {
      ok('schema-ready.check() passes as playbookos_app — this is what boot runs');
    } else {
      bad('the readiness check FAILS as the restricted role', JSON.stringify(readyAsApp));
    }

    // And it must pass without exiting. assertReadyOrExit is what server.js actually calls, so the
    // injected exit proves the success path never reaches it.
    let exited = null;
    await schemaReady.assertReadyOrExit(aq, {
      log: () => {}, err: () => {}, exit: (c) => { exited = c; },
    });
    if (exited === null) ok('assertReadyOrExit() does not exit — the application would start');
    else bad(`assertReadyOrExit() exited with ${exited} as the restricted role`);

    // ── 4. WHAT MAKES STEP 3 MEAN SOMETHING ────────────────────────────────────
    h('4. DDL AS THE RESTRICTED ROLE MUST FAIL');
    const forbidden = [
      ['CREATE TABLE', `CREATE TABLE eng003_probe (id int)`],
      ['ALTER TABLE', `ALTER TABLE federal_opportunities ADD COLUMN eng003_probe int`],
      ['DROP TABLE', `DROP TABLE opportunity_audit_events`],
      ['CREATE INDEX', `CREATE INDEX eng003_probe_ix ON federal_opportunities (title)`],
      ['CREATE FUNCTION', `CREATE FUNCTION eng003_probe() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql`],
      ['TRUNCATE', `TRUNCATE federal_opportunities`],
    ];
    for (const [label, sql] of forbidden) {
      try {
        await aq(sql);
        bad(`${label} SUCCEEDED as the restricted role — it is not restricted`);
        // Undo it so later assertions are not run against a mutated schema.
        try { await oq(sql.replace(/^CREATE TABLE/, 'DROP TABLE IF EXISTS').replace(/\(id int\)/, '')); } catch { /* best effort */ }
      } catch (e) {
        if (/permission denied|must be owner/i.test(e.message)) ok(`${label} refused: ${e.message.split('\n')[0].slice(0, 62)}`);
        else bad(`${label} failed for the WRONG reason`, e.message.split('\n')[0]);
      }
    }

    // A migration run as the application role must fail too.
    //
    // Asserted PRECISELY. Five steps call into src/lib/db, which uses its own pool built from
    // DATABASE_URL and ignores the connection passed here — so those five run as the OWNER whatever
    // is handed to runAll, and treating their success as a privilege escape would be wrong. The
    // assertion is therefore that the migration fails AT the first step that actually uses the
    // passed connection, and migrate-all exports which step that is rather than naming it twice.
    const { FIRST_STEP_USING_PASSED_CONNECTION } = require('../src/lib/migrate-all');
    try {
      const r = await runAll(aq, { seeds: false, log: () => {} });
      if (r.ok) {
        bad('the MIGRATOR succeeded end to end as the restricted role — DDL is not actually restricted');
      } else if (r.failed[0].name === FIRST_STEP_USING_PASSED_CONNECTION) {
        ok(`the migrator fails at "${r.failed[0].name}" — the first step that uses the given connection`);
      } else {
        bad(`the migrator failed at "${r.failed[0].name}", not at the expected `
          + `"${FIRST_STEP_USING_PASSED_CONNECTION}"`, r.failed[0].error);
      }
    } catch (e) {
      ok(`the migrator throws as the restricted role: ${e.message.split('\n')[0].slice(0, 54)}`);
    }

    // ── 5. THE APPLICATION'S REAL WORK, AS THE RESTRICTED ROLE ─────────────────
    h('5. THE PRPA READ AND WRITE PATHS AS THE RESTRICTED ROLE');
    const T = require('../src/lib/office/opportunity-tracker');
    const AUDIT = require('../src/lib/office/opportunity-audit');
    const REG = require('../src/lib/office/capability-registry');
    const CO = (await aq(`SELECT id FROM companies WHERE slug = 'abiozen'`)).rows[0];
    if (CO) ok('the company row the migrator seeded is readable'); else bad('no company row');

    const csv = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'sam-opportunities-real-2026-11-06.csv'), 'utf8');
    const imp = await T.importCsv(aq, {
      companyId: CO.id, importedBy: 'eng003@example.test', csvText: csv,
      sourceDetail: 'ENG-003 restricted-role check',
    });
    if (imp.outcome.inserted.length > 0) ok(`import works: ${imp.outcome.inserted.length} row(s) inserted with no DDL`);
    else bad('import inserted nothing', JSON.stringify(imp.outcome).slice(0, 180));

    const caps = await REG.activeCapabilities(aq, CO.id, { today: '2026-11-06' });
    ok(`the capability registry reads: ${caps.length} verified capability(ies)`);

    const asmt = await T.assessAll(aq, {
      companyId: CO.id, assessedBy: 'eng003@example.test', capabilities: caps,
      evidenceBasis: 'real_registry', opts: { today: '2026-11-06' },
    });
    if (asmt.length) ok(`assessment writes: ${asmt.length} verdict(s)`); else bad('assessment wrote nothing');

    const rows = await T.listOpportunities(aq, CO.id, {});
    if (rows.length) ok(`the board reads: ${rows.length} row(s)`); else bad('the board read nothing');

    const first = rows.find((r) => r.response_deadline);
    if (first) {
      const c = await T.confirmDeadline(aq, { companyId: CO.id, opportunityId: first.id, confirmedBy: 'eng003@example.test' });
      if (c) ok('deadline confirmation writes'); else bad('deadline confirmation wrote nothing');
    }

    // A set-wide action: opportunityId is null. This is the case MATCH FULL refused, so it is the
    // one asserted.
    const a = await AUDIT.record(aq, {
      companyId: CO.id, action: 'export.csv', actor: 'eng003@example.test', detail: { rows: rows.length },
    });
    if (a.ok) ok('the audit trail accepts an append naming no opportunity (set-wide action)');
    else bad('the audit append failed', a.error);

    // And one naming a row, where the full company-welded pair IS enforced.
    const a2 = first ? await AUDIT.record(aq, {
      companyId: CO.id, opportunityId: first.id, action: 'deadline.confirmed',
      actor: 'eng003@example.test', detail: {},
    }) : { ok: false, error: 'no row with a deadline to reference' };
    if (a2.ok) ok('…and one naming an opportunity'); else bad('the row-scoped audit append failed', a2.error);

    // Cross-company reference must still be impossible.
    const xc = await AUDIT.record(aq, {
      companyId: CO.id, opportunityId: 'opp-does-not-exist', action: 'review.recorded',
      actor: 'eng003@example.test', detail: {},
    });
    if (!xc.ok && /foreign key/i.test(xc.error || '')) ok('…and an event naming an unknown opportunity is refused');
    else bad('an audit event referenced a non-existent opportunity', JSON.stringify(xc));

    // Append-only must still hold for the restricted role — by trigger AND, now, by the absence of
    // an UPDATE grant it was never given... except it WAS granted UPDATE on all tables above, which
    // is exactly why the trigger matters. Both layers are checked.
    // An UPDATE that matches NO ROWS does not fire a row trigger and raises nothing — so without a
    // real id this assertion passes vacuously, which is how it first reported "UPDATEable" after
    // the append above had failed and left a.id undefined. The id is therefore required.
    if (!a.ok || !a.id) {
      bad('cannot test append-only: no audit row was written to attempt an UPDATE against');
    } else {
      try {
        const u = await aq(`UPDATE opportunity_audit_events SET actor = 'tampered' WHERE id = $1`, [a.id]);
        bad(`an audit event was UPDATEable as the application role (${u.rowCount} row(s) changed)`);
      } catch (e) {
        if (/append-only/i.test(e.message)) ok('the audit trail refuses an UPDATE (trigger, not grant)');
        else bad('the UPDATE failed for the wrong reason', e.message.split('\n')[0]);
      }
      try {
        await aq(`DELETE FROM opportunity_audit_events WHERE id = $1`, [a.id]);
        bad('an audit event was DELETEable as the application role');
      } catch (e) {
        if (/append-only/i.test(e.message)) ok('…and refuses a DELETE');
        else bad('the DELETE failed for the wrong reason', e.message.split('\n')[0]);
      }
    }

    const out2 = T.exportCsv(rows);
    if (out2.charCodeAt(0) === 0xfeff && out2.includes('\r\n')) ok('the Excel export is produced as the restricted role');
    else bad('the export is malformed');
  } finally {
    try { if (app) await app.end(); } catch { /* closing */ }
    try { await owner.end(); } catch { /* closing */ }
    stopCluster();
  }

  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the application cannot yet run without superuser or DDL.\n');
    process.exit(1);
  }
  console.log('\nPASS  migrations run as their own process, and the application starts and does its');
  console.log('      real work as a role with NO superuser, NO DDL and NO RLS bypass.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\ncheck-startup-without-ddl: ${e.stack || e.message}\n`);
  process.exit(1);
});
