#!/usr/bin/env node
'use strict';
// ── DOES MIGRATION v2 DO WHAT IT CLAIMS, AND DO ITS GUARDS FIRE? ────────────
//
// Ruling 12 item 4 requires migration tests. This runs the REAL runner against a disposable
// cluster it creates and destroys. It never touches production.
//
// The distinction it is built around: **a constraint that exists is not a constraint that works.**
// Every guard below is proved by attempting the thing it forbids and requiring the database to
// refuse. A migration test that only checks tables exist would have passed on a schema where every
// CHECK was `CHECK (true)`.
//
// Twelve properties:
//    1  a clean database is REFUSED (exit 2) and nothing is created
//    2  --check writes nothing
//    3  --apply creates every table, index and constraint
//    4  --apply is idempotent
//    5  a registration cannot be marked verified without evidence, approval, expiry and UEI
//    6  a BRAND cannot be declared a separate legal entity without evidence and an approval
//    7  there is no column through which a brand could hold a registration        (ruling 12 item 5)
//    8  the widened kind CHECK accepts the five new kinds and still rejects nonsense
//    9  a capability cannot be attributed to ANOTHER TENANT'S brand
//   10  an observation cannot cross tenants
//   11  rollback is refused without the acknowledgement, and refused again if new-kind rows exist
//   12  after a clean rollback, companies and verified_capabilities survive and re-apply works
//
// Exit: 0 all proved · 1 a property failed · 3 did not execute (no Postgres)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
const schema = require('../src/lib/office/registration-schema');

const PGPORT = 55991;
let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

const NEW_KINDS = schema.CAPABILITY_KINDS.filter((k) => !schema.CAPABILITY_KINDS_BEFORE.includes(k));

let temp = null;
function startCluster() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/mig2-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) { return null; }
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

/** Run the real runner. Returns { code, out }. Never throws on a non-zero exit — that is data. */
function runner(url, args) {
  const script = path.join(__dirname, 'migrate-registrations.js');
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      env: { ...process.env, DATABASE_URL: url, MIGRATION_OPERATOR: 'migration-v2-harness' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** Did this statement get refused by the database? Returns the error message, or null if it was accepted. */
async function refused(q, sql, params) {
  try { await q(sql, params); return null; } catch (e) { return e.message; }
}

async function main() {
  h('MIGRATION v2 — DO ITS GUARDS ACTUALLY FIRE?');
  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no complete PostgreSQL server toolchain available.');
    console.log('      This check asserted NOTHING. It is not a pass.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }
  const url = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  const client = new Client({ connectionString: url });
  await client.connect();
  const q = (sql, params) => client.query(sql, params);

  try {
    // ── 1. a clean database must be REFUSED ───────────────────────────────
    h('1. A CLEAN DATABASE IS REFUSED, AND NOTHING IS CREATED');
    let r = runner(url, ['--apply']);
    if (r.code === 2) ok('--apply on a database with no companies table exits 2 (refused)');
    else bad(`--apply exited ${r.code} on a clean database, expected 2`, r.out.slice(-400));
    if (/NOTHING WAS WRITTEN/.test(r.out)) ok('it says plainly that nothing was written');
    else bad('the refusal does not state that nothing was written');
    let created = 0;
    for (const t of schema.CREATED_TABLES) {
      const n = (await q(
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t],
      )).rows[0].n;
      created += n;
    }
    if (created === 0) ok('a refused migration created ZERO tables — the refusal is before any write');
    else bad(`${created} table(s) were created by a migration that refused`);

    // ── build the preconditions, the way the real database has them ───────
    await q(`CREATE TABLE companies (
               id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`INSERT INTO companies (id,slug,display_name) VALUES
               ('co-abiozen','abiozen','Abiozen LLC'), ('co-other','other','Other Tenant LLC')`);
    // verified_capabilities as connectors.v1 leaves it: the NARROW kind CHECK.
    await q(`CREATE TABLE verified_capabilities (
               id TEXT PRIMARY KEY,
               company_id TEXT NOT NULL REFERENCES companies(id),
               kind TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
               responsible_entity TEXT NOT NULL,
               verification_status TEXT NOT NULL DEFAULT 'planned',
               evidence_source TEXT, evidence_url TEXT, evidence_sha256 TEXT,
               verified_at TIMESTAMPTZ, verified_by TEXT, approval_id TEXT,
               valid_from DATE, valid_to DATE, notes TEXT,
               created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
               CONSTRAINT verified_capabilities_kind_check
                 CHECK (kind IN ('capability','accreditation')),
               UNIQUE (id, company_id))`);
    // A pre-existing row, so every later claim about surviving a rollback has something to be about.
    await q(`INSERT INTO verified_capabilities (id,company_id,kind,code,name,responsible_entity)
               VALUES ('vc-pre','co-abiozen','accreditation','ISO17025','Pre-existing','Abiozen Scientific')`);

    // ── 2. --check writes nothing ─────────────────────────────────────────
    h('2. --check WRITES NOTHING');
    r = runner(url, ['--check']);
    if (r.code === 0) ok('--check exits 0 when preconditions are met');
    else bad(`--check exited ${r.code}`, r.out.slice(-400));
    let any = 0;
    for (const t of schema.CREATED_TABLES) {
      any += (await q(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])).rows[0].n;
    }
    if (any === 0) ok('--check created no tables');
    else bad(`--check created ${any} table(s)`);
    const defBefore = (await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='verified_capabilities_kind_check'`)).rows[0].d;
    if (!NEW_KINDS.some((k) => defBefore.includes(k))) ok('--check did not widen the kind CHECK');
    else bad('--check altered the CHECK constraint');

    // ── 3 & 4. apply, and apply again ─────────────────────────────────────
    h('3. --apply CREATES EVERYTHING AND SELF-VERIFIES');
    r = runner(url, ['--apply']);
    if (r.code === 0) ok('--apply exits 0');
    else { bad(`--apply exited ${r.code}`, r.out.slice(-800)); return; }
    for (const t of schema.CREATED_TABLES) {
      const n = (await q(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])).rows[0].n;
      if (n === 1) ok(`${t} exists`); else bad(`${t} was not created`);
    }
    for (const idx of ['idx_company_brands_company', 'idx_company_registrations_expiry',
      'idx_company_registrations_registry', 'idx_registration_observations_latest',
      'idx_verified_capabilities_brand']) {
      const n = (await q(`SELECT COUNT(*)::int n FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [idx])).rows[0].n;
      if (n === 1) ok(`index ${idx} exists`); else bad(`index ${idx} is missing`);
    }

    h('4. --apply IS IDEMPOTENT');
    r = runner(url, ['--apply']);
    if (r.code === 0) ok('a second --apply exits 0 and changes nothing');
    else bad(`the second --apply exited ${r.code}`, r.out.slice(-600));

    // ── 5. the registration evidence constraint ───────────────────────────
    h('5. A REGISTRATION CANNOT BE VERIFIED WITHOUT ITS EVIDENCE');
    // Each attempt omits exactly ONE required thing, so a pass cannot come from the row being
    // malformed in some other way. The expiry case is the one that matters most: a verified
    // registration with no expiry satisfies an existence check while being unable to answer
    // whether it was valid at a submission deadline.
    const full = {
      id: 'reg-1', company_id: 'co-abiozen', registry: 'sam_gov', uei: 'GW4MAZJHFV44',
      expires_on: '2026-12-30', evidence_source: 'SAM.gov Entity Management API v2',
      verified_at: '2026-11-06T00:00:00Z', verified_by: 'naren@abiozen.com', approval_id: 'appr-1',
    };
    for (const omit of ['evidence_source', 'verified_at', 'verified_by', 'approval_id', 'expires_on', 'uei']) {
      const row = { ...full, id: `reg-omit-${omit}` };
      delete row[omit];
      const cols = Object.keys(row);
      const msg = await refused(q,
        `INSERT INTO company_registrations (${cols.join(',')}, verification_status)
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, 'verified')`,
        cols.map((c) => row[c]));
      if (msg && /verified_requires_evidence/.test(msg)) ok(`verified without ${omit} → refused`);
      else bad(`a verified registration with no ${omit} was ACCEPTED`, msg || 'the insert succeeded');
    }
    // And the complete row must be accepted, or the constraint is simply broken.
    const cols = Object.keys(full);
    const accepted = await refused(q,
      `INSERT INTO company_registrations (${cols.join(',')}, verification_status)
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}, 'verified')`,
      cols.map((c) => full[c]));
    if (!accepted) ok('a complete verified registration IS accepted — the constraint is not a wall');
    else bad('a fully evidenced registration was refused', accepted);
    // A pending one needs none of it, which is what makes the queue usable.
    const pend = await refused(q,
      `INSERT INTO company_registrations (id,company_id,registry,uei) VALUES ('reg-pend','co-abiozen','sam_gov','PENDING000001')`);
    if (!pend) ok('a PENDING registration needs no evidence — the queue can hold a candidate');
    else bad('a pending registration was refused', pend);

    // ── 6. the brand promotion constraint (ruling 12 item 5) ──────────────
    h('6. A BRAND CANNOT BECOME A LEGAL ENTITY BY EDITING A COLUMN');
    await q(`INSERT INTO company_brands (id,company_id,name,aliases) VALUES
               ('br-sci','co-abiozen','Abiozen Scientific','{}'),
               ('br-cro','co-abiozen','CRO360','{"CRO 360 Inc","CRO 360"}')`);
    ok('two brands recorded under Abiozen LLC, with the CRO360 spellings as aliases');
    const defaults = (await q(`SELECT legal_status FROM company_brands ORDER BY id`)).rows.map((x) => x.legal_status);
    if (defaults.every((s) => s === 'brand_or_division')) {
      ok('both default to brand_or_division — the safe claim, not the convenient one');
    } else bad(`default legal_status was ${defaults.join(', ')}`);
    const promote = await refused(q,
      `UPDATE company_brands SET legal_status='separate_legal_entity' WHERE id='br-cro'`);
    if (promote && /legal_entity_requires_evidence/.test(promote)) {
      ok('promoting CRO360 to a separate legal entity → REFUSED without evidence');
    } else bad('a brand was promoted to a separate legal entity with no evidence', promote || 'accepted');
    const promoteOk = await refused(q,
      `UPDATE company_brands SET legal_status='separate_legal_entity',
         evidence_source='Illinois SOS filing', verified_at=NOW(),
         verified_by='naren@abiozen.com', approval_id='appr-2' WHERE id='br-cro'`);
    if (!promoteOk) ok('with documents, a verifier and an approval, the promotion IS allowed');
    else bad('a fully evidenced promotion was refused', promoteOk);
    await q(`UPDATE company_brands SET legal_status='brand_or_division', evidence_source=NULL,
               verified_at=NULL, verified_by=NULL, approval_id=NULL WHERE id='br-cro'`);

    // ── 7. a brand has no path to a registration ──────────────────────────
    h('7. THERE IS NO COLUMN THROUGH WHICH A BRAND COULD HOLD A REGISTRATION');
    const regCols = (await q(
      `SELECT column_name FROM information_schema.columns WHERE table_name='company_registrations'`,
    )).rows.map((x) => x.column_name);
    if (!regCols.some((c) => /brand/i.test(c))) {
      ok('company_registrations has no brand column at all — "Abiozen Scientific holds a UEI" is');
      ok('not a claim this schema can express, which is the enforcement of ruling 12 item 5');
    } else bad(`company_registrations exposes ${regCols.filter((c) => /brand/i.test(c)).join(', ')}`,
      'a brand must not be able to acquire a registration');
    const wrongFk = await refused(q,
      `INSERT INTO company_registrations (id,company_id,registry,uei) VALUES ('reg-brand','br-cro','sam_gov','X')`);
    if (wrongFk && /foreign key|companies/i.test(wrongFk)) {
      ok('pointing company_id at a BRAND id → refused by the FK to companies');
    } else bad('a registration was attached to a brand id', wrongFk || 'accepted');

    // ── 8. the widened kind CHECK ─────────────────────────────────────────
    h('8. THE WIDENED KIND CHECK ACCEPTS THE NEW KINDS AND STILL REFUSES NONSENSE');
    for (const kind of NEW_KINDS) {
      const msg = await refused(q,
        `INSERT INTO verified_capabilities (id,company_id,kind,code,name,responsible_entity)
           VALUES ($1,'co-abiozen',$2,'C','N','Abiozen Scientific')`, [`vc-${kind}`, kind]);
      if (!msg) ok(`kind '${kind}' is now storable`);
      else bad(`kind '${kind}' was refused after widening`, msg);
    }
    const junk = await refused(q,
      `INSERT INTO verified_capabilities (id,company_id,kind,code,name,responsible_entity)
         VALUES ('vc-junk','co-abiozen','whatever_i_like','C','N','X')`);
    if (junk && /kind_check/.test(junk)) ok('an unlisted kind is still refused — widened, not opened');
    else bad('the kind CHECK now accepts anything', junk || 'accepted');

    // ── 9 & 10. tenant isolation ──────────────────────────────────────────
    h('9. A CAPABILITY CANNOT BE ATTRIBUTED TO ANOTHER TENANT\'S BRAND');
    const cross = await refused(q,
      `INSERT INTO verified_capabilities (id,company_id,kind,code,name,responsible_entity,brand_id)
         VALUES ('vc-cross','co-other','capability','C','N','X','br-sci')`);
    if (cross && /brand_tenant_fk|foreign key/i.test(cross)) {
      ok("co-other cannot attribute a capability to Abiozen's brand — refused by the composite FK");
    } else bad("a capability was attributed across tenants", cross || 'accepted');
    const sameTenant = await refused(q,
      `INSERT INTO verified_capabilities (id,company_id,kind,code,name,responsible_entity,brand_id)
         VALUES ('vc-ok','co-abiozen','capability','C','N','X','br-sci')`);
    if (!sameTenant) ok('within one tenant the attribution is allowed');
    else bad('a same-tenant attribution was refused', sameTenant);

    h('10. AN OBSERVATION CANNOT CROSS TENANTS');
    const obsOk = await refused(q,
      `INSERT INTO company_registration_observations (id,company_id,registration_id,source)
         VALUES ('obs-1','co-abiozen','reg-1','SAM.gov Entity Management API v2')`);
    if (!obsOk) ok('an observation against its own tenant\'s registration is allowed');
    else bad('a valid observation was refused', obsOk);
    const obsCross = await refused(q,
      `INSERT INTO company_registration_observations (id,company_id,registration_id,source)
         VALUES ('obs-2','co-other','reg-1','forged')`);
    if (obsCross && /tenant_fk|foreign key/i.test(obsCross)) {
      ok('co-other cannot observe Abiozen\'s registration — refused by (registration_id, company_id)');
    } else bad('an observation crossed tenants', obsCross || 'accepted');

    // ── 11. the rollback guards ───────────────────────────────────────────
    h('11. ROLLBACK REFUSES WITHOUT ACKNOWLEDGEMENT, AND REFUSES RATHER THAN DESTROY DATA');
    r = runner(url, ['--rollback']);
    if (r.code === 2 && /REFUSED/.test(r.out)) ok('--rollback without the acknowledgement exits 2');
    else bad(`--rollback without acknowledgement exited ${r.code}`, r.out.slice(-300));

    // Rows using the new kinds exist (inserted in step 8). Narrowing the CHECK back would fail —
    // AFTER the tables had been dropped. The runner must refuse the whole thing.
    r = runner(url, ['--rollback', '--i-understand-this-drops-tables']);
    if (r.code === 2 && /DATA WOULD HAVE TO BE DESTROYED/.test(r.out)) {
      ok('rollback REFUSED while rows use the new kinds — it will not half-revert and then');
      ok('pressure somebody into deleting capability records to finish the job');
    } else bad(`rollback exited ${r.code} with new-kind rows present`, r.out.slice(-500));
    for (const t of schema.CREATED_TABLES) {
      const n = (await q(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])).rows[0].n;
      if (n === 1) ok(`${t} still exists — the refused rollback dropped nothing`);
      else bad(`${t} was dropped by a rollback that refused`);
    }

    // ── 12. a clean rollback, and re-apply ────────────────────────────────
    h('12. AFTER THE NEW-KIND ROWS GO, ROLLBACK IS CLEAN AND NON-DESTRUCTIVE');
    await q(`DELETE FROM verified_capabilities WHERE kind = ANY($1)`, [NEW_KINDS]);
    r = runner(url, ['--rollback', '--i-understand-this-drops-tables']);
    if (r.code === 0) ok('rollback succeeds once no row depends on the widened CHECK');
    else bad(`rollback exited ${r.code}`, r.out.slice(-600));
    for (const t of schema.CREATED_TABLES) {
      const n = (await q(`SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [t])).rows[0].n;
      if (n === 0) ok(`${t} dropped`); else bad(`${t} survived the rollback`);
    }
    const companies = (await q(`SELECT COUNT(*)::int n FROM companies`)).rows[0].n;
    const pre = (await q(`SELECT COUNT(*)::int n FROM verified_capabilities WHERE id='vc-pre'`)).rows[0].n;
    if (companies === 2) ok('companies untouched (2 rows)'); else bad(`companies has ${companies} rows, expected 2`);
    if (pre === 1) ok('the pre-existing capability row survived'); else bad('the pre-existing capability row was lost');
    const defAfter = (await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='verified_capabilities_kind_check'`)).rows[0];
    if (defAfter && !NEW_KINDS.some((k) => defAfter.d.includes(k))) {
      ok('the narrow kind CHECK is restored — rollback is a real revert, not a partial one');
    } else bad('the kind CHECK was not restored', defAfter ? defAfter.d : 'constraint absent');
    const brandCol = (await q(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='verified_capabilities' AND column_name='brand_id'`)).rows[0].n;
    if (brandCol === 0) ok('brand_id removed'); else bad('brand_id survived the rollback');

    r = runner(url, ['--apply']);
    if (r.code === 0) ok('the migration re-applies cleanly after a rollback');
    else bad(`re-apply exited ${r.code}`, r.out.slice(-600));
  } finally {
    await client.end().catch(() => {});
    stopCluster();
  }

  h('RESULT');
  if (fail) { console.log(`  ${fail} property FAILED. Migration v2 is not proved.\n`); process.exit(1); }
  console.log('  Every guard was tested by attempting what it forbids, and the database refused.\n');
  process.exit(0);
}

main().catch((e) => { stopCluster(); console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
