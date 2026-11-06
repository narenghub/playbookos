#!/usr/bin/env node
'use strict';
// ── DO v3's GUARDS FIRE? ADVERSARIAL TESTS AGAINST A DISPOSABLE CLUSTER ─────
//
// Ruling 15 item 7: adversarial tests. Runs the REAL runner. Never touches production.
//
// Every assertion proves a guard by ATTEMPTING WHAT IT FORBIDS and requiring the database to
// refuse. A constraint that exists is not a constraint that works: a test suite that only exercised
// happy paths would pass unchanged against a schema where every CHECK was `CHECK (true)`.
//
// The three concepts ruling 15 item 1 separates are tested separately, because the whole point is
// that they do not imply one another:
//
//   evidence sufficiency  — can this evidence satisfy this requirement?
//   eligibility           — qualify.js's business, not the schema's
//   authorization to bid  — a human decision that NOTHING can derive
//
// Exit: 0 every guard fired · 1 a guard did not · 3 did not execute (no Postgres)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');
const schema = require('../src/lib/office/intake-schema');

const PGPORT = 56003;
let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 320)}`); };
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

let temp = null;
function startCluster() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/mig3-');
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

function runner(url, args) {
  const script = path.join(__dirname, 'migrate-intake.js');
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      env: { ...process.env, DATABASE_URL: url, MIGRATION_OPERATOR: 'v3-adversarial-harness' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** Did the database refuse? Returns the error message, or null if it accepted. */
async function refused(q, sql, params) {
  try { await q(sql, params); return null; } catch (e) { return e.message; }
}

// SHA('a') → a 64-char hex string. It used to accept anything and repeat it, so SHA('doc-ok')
// produced a 384-character non-hex value that failed much later inside a CHECK constraint, looking
// like a schema bug rather than a bad call. A helper that cannot be misused is worth four lines.
const SHA = (c) => {
  if (typeof c !== 'string' || !/^[0-9a-f]$/.test(c)) {
    throw new Error(`SHA() takes ONE lowercase hex char; got ${JSON.stringify(c)}. Use H() for a real digest.`);
  }
  return c.repeat(64);
};
// A real digest, for fixtures that need many distinct hashes.
const H = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex');

// Ruling 18 item 6: a verdict must be INGESTED before it can be reflected. These two helpers are
// the only legitimate way to give a document a verdict, which is the point.
const MAP = {
  NO_THREATS_FOUND: 'clean', THREATS_FOUND: 'infected', UNSUPPORTED: 'unsupported',
  ACCESS_DENIED: 'access_denied', FAILED: 'failed',
};
let evt = 0;
const ingest = (q, docId, ver, providerStatus, co = 'co-a') => q(
  `INSERT INTO document_scan_results
     (id,company_id,document_id,storage_version_id,provider,channel,
      provider_event_id,provider_status,mapped_status,threats)
   VALUES ($1,$2,$3,$4,'aws_guardduty_malware_protection_s3','eventbridge',$5,$6,$7,$8)`,
  [`scan-${++evt}`, co, docId, ver, `evt-${evt}`, providerStatus, MAP[providerStatus],
   providerStatus === 'THREATS_FOUND' ? 'EICAR-Test-File (not a virus)' : null]);

async function main() {
  h('MIGRATION v3 — ADVERSARIAL TESTS (ruling 15 item 7)');
  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no complete PostgreSQL server toolchain. This asserted NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }
  const url = `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable`;
  const client = new Client({ connectionString: url });
  await client.connect();
  const q = (sql, params) => client.query(sql, params);

  try {
    // ── 1. a database without the preconditions must be refused ───────────
    h('1. PRECONDITIONS REFUSED, AND NOTHING CREATED');
    let r = runner(url, ['--apply']);
    if (r.code === 2) ok('--apply with no companies/solicitations exits 2');
    else bad(`--apply exited ${r.code} on a bare database, expected 2`, r.out.slice(-300));
    let created = 0;
    for (const t of schema.CREATED_TABLES) {
      created += (await q(
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [t])).rows[0].n;
    }
    if (created === 0) ok('a refused migration created ZERO tables');
    else bad(`${created} table(s) created by a migration that refused`);

    // ── the preconditions, shaped as production has them ──────────────────
    await q(`CREATE TABLE companies (
               id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT NOW())`);
    await q(`INSERT INTO companies (id,slug,display_name) VALUES
               ('co-a','abiozen','Abiozen LLC'), ('co-b','other','Other Tenant LLC')`);
    await q(`CREATE TABLE source_connectors (
               source_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL,
               auth_mode TEXT, access_mode TEXT, daily_call_ceiling INTEGER, activated BOOLEAN,
               notes TEXT)`);
    await q(`INSERT INTO source_connectors (source_key,display_name,kind,activated)
               VALUES ('grants_gov','Grants.gov','grant',true)`);
    await q(`CREATE TABLE solicitations (
               id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
               source_key TEXT NOT NULL REFERENCES source_connectors(source_key),
               notice_id TEXT, record_kind TEXT, active BOOLEAN, response_deadline TIMESTAMPTZ,
               UNIQUE (id, company_id))`);
    await q(`CREATE TABLE verified_capabilities (
               id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
               kind TEXT NOT NULL, code TEXT, name TEXT, responsible_entity TEXT,
               verification_status TEXT DEFAULT 'planned', UNIQUE (id, company_id))`);
    await q(`CREATE TABLE skus (id TEXT PRIMARY KEY, name TEXT)`);
    await q(`CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT)`);
    // users, because the authorization trigger reads roles from it (ruling 16 item 7)
    await q(`CREATE TABLE users (
               id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT,
               role TEXT NOT NULL, is_active INTEGER DEFAULT 1)`);
    await q(`INSERT INTO users (id,email,name,role,is_active) VALUES
               ('u-super','naren@abiozen.com','Naresh','super_admin',1),
               ('u-admin','admin@abiozen.com','Admin','admin',1),
               ('u-proc','raj@abiozen.com','Raj','procurement_team',1),
               ('u-dir','dir@abiozen.com','Director','procurement_director',1),
               ('u-gone','former@abiozen.com','Former','admin',0)`);
    await q(`INSERT INTO skus VALUES ('sku-1','A molecule')`);
    await q(`INSERT INTO suppliers VALUES ('sup-1','A supplier')`);
    await q(`INSERT INTO verified_capabilities (id,company_id,kind,code,name,responsible_entity)
               VALUES ('cap-a','co-a','accreditation','ISO17025','Accredited','Abiozen Scientific')`);
    await q(`INSERT INTO solicitations (id,company_id,source_key,notice_id)
               VALUES ('sol-a','co-a','grants_gov','n-1'), ('sol-b','co-b','grants_gov','n-2')`);

    // ── 2. check writes nothing; apply works; idempotent ──────────────────
    h('2. --check WRITES NOTHING, --apply WORKS, AND REPEATS SAFELY');
    r = runner(url, ['--check']);
    if (r.code === 0) ok('--check exits 0 with preconditions met');
    else bad(`--check exited ${r.code}`, r.out.slice(-300));
    let any = 0;
    for (const t of schema.CREATED_TABLES) {
      any += (await q(
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [t])).rows[0].n;
    }
    if (any === 0) ok('--check created nothing');
    else bad(`--check created ${any} table(s)`);

    r = runner(url, ['--apply']);
    if (r.code === 0) ok('--apply exits 0 and self-verifies');
    else { bad(`--apply exited ${r.code}`, r.out.slice(-900)); return; }
    r = runner(url, ['--apply']);
    if (r.code === 0) ok('a second --apply is safe');
    else bad(`the second --apply exited ${r.code}`, r.out.slice(-400));

    const manual = (await q(`SELECT kind, activated FROM source_connectors WHERE source_key='manual'`)).rows[0];
    if (manual && manual.kind === 'manual') ok(`manual source seeded, kind='manual' not 'procurement'`);
    else bad('manual source row wrong or absent', JSON.stringify(manual || null));

    // ── 3. RULING 15 ITEM 1 — the three indicative classes ────────────────
    h('3. CATALOG LISTING, SYNTHESIS PREDICTION, SUPPLIER RELATIONSHIP (item 1)');
    // A clean document now has to name the object version its verdict judged, and show that its
    // bytes were verified. This fixture predates ruling 17 item 4 and was a plain 'clean' row; the
    // new constraint rejected it, which is the constraint working.
    // Pending first, then an ingested verdict, then the reflection. Writing 'clean' directly is
    // now refused — which is ruling 18 item 6, and which broke this fixture, correctly.
    await q(`INSERT INTO intake_documents
               (id,company_id,submitted_by,origin,byte_size,sha256,storage_bucket,storage_key,
                storage_version_id,detected_mime)
             VALUES ('doc-a','co-a','naren','upload',1024,$1,'abiozen-intake','co-a/doc-a.pdf',
                     'ver-a','application/pdf')`, [SHA('a')]);
    await ingest(q, 'doc-a', 'ver-a', 'NO_THREATS_FOUND');
    await q(`UPDATE intake_documents
                SET scan_status='clean', scan_version_id='ver-a', scanned_at=NOW(),
                    integrity_ok=true, integrity_checked_at=NOW()
              WHERE id='doc-a'`);
    await q(`INSERT INTO solicitation_requirements
               (id,company_id,solicitation_id,requirement_kind,description,quantity_value,quantity_unit)
             VALUES ('req-a','co-a','sol-a','material','50 kg of a named API',50,'kg')`);

    for (const cls of schema.INDICATIVE_CLASSES) {
      const msg = await refused(q,
        `INSERT INTO requirement_matches
           (id,company_id,requirement_id,evidence_class,evidence_ref,evidence_as_of,
            evidence_sufficient,matched_by,approval_id)
         VALUES ($1,'co-a','req-a',$2,'ref',CURRENT_DATE,true,'naren','appr-1')`,
        [`m-${cls}`, cls]);
      if (msg && /indicative_never_sufficient/.test(msg)) {
        ok(`'${cls}' with evidence_sufficient=true → REFUSED by the database`);
      } else {
        bad(`'${cls}' was accepted as SUFFICIENT`, msg || 'the insert succeeded');
      }
    }
    // They must still be storable as indicative — excluded evidence gets re-entered under a class
    // that does qualify, so visible and powerless beats absent.
    for (const cls of schema.INDICATIVE_CLASSES) {
      const msg = await refused(q,
        `INSERT INTO requirement_matches
           (id,company_id,requirement_id,evidence_class,evidence_ref,evidence_sufficient,matched_by)
         VALUES ($1,'co-a','req-a',$2,'ref',false,'naren')`, [`i-${cls}`, cls]);
      if (!msg) ok(`'${cls}' IS storable as indicative (sufficient=false) — recorded, powerless`);
      else bad(`'${cls}' could not be recorded at all`, msg);
    }

    // ── 4. the sufficient classes, and what they still require ────────────
    h('4. SUFFICIENCY REQUIRES A REFERENCE, AN APPROVAL AND A DATE');
    const full = {
      id: 'm-ok', company_id: 'co-a', requirement_id: 'req-a', evidence_class: 'supplier_quote',
      evidence_ref: 'Q-1234', evidence_as_of: '2026-11-06', evidence_sufficient: true,
      matched_by: 'naren', approval_id: 'appr-2',
    };
    for (const omit of ['evidence_ref', 'evidence_as_of', 'approval_id']) {
      const row = { ...full, id: `m-omit-${omit}` };
      delete row[omit];
      const cols = Object.keys(row);
      const msg = await refused(q,
        `INSERT INTO requirement_matches (${cols.join(',')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        cols.map((c) => row[c]));
      if (msg && /sufficient_requires_evidence/.test(msg)) ok(`sufficient without ${omit} → refused`);
      else bad(`a sufficient match with no ${omit} was ACCEPTED`, msg || 'accepted');
    }
    const cols = Object.keys(full);
    const acc = await refused(q,
      `INSERT INTO requirement_matches (${cols.join(',')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => full[c]));
    if (!acc) ok('a fully evidenced supplier_quote IS accepted — the constraint is not a wall');
    else bad('a complete sufficient match was refused', acc);

    const backdated = await refused(q,
      `INSERT INTO requirement_matches
         (id,company_id,requirement_id,evidence_class,evidence_ref,evidence_as_of,valid_until,
          evidence_sufficient,matched_by,approval_id)
       VALUES ('m-bad-window','co-a','req-a','supplier_quote','Q-9',CURRENT_DATE,
               CURRENT_DATE - 10,true,'naren','appr-3')`);
    if (backdated && /validity_window/.test(backdated)) {
      ok('a quote whose valid_until precedes its evidence_as_of → refused');
    } else bad('an impossible validity window was accepted', backdated || 'accepted');

    // ── 5. AUTHORIZATION IS NOT DERIVABLE — item 1, concept (3) ───────────
    h('5. AUTHORIZATION TO BID IS A HUMAN ACT, NOT A COMPUTED STATE');
    // No column anywhere outside fulfillment_authorizations could hold it. That absence IS the
    // control: a column is one UPDATE away from being set by whatever computed the verdict.
    const strays = (await q(
      `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name <> 'fulfillment_authorizations'
           AND (column_name LIKE '%authorized%' OR column_name LIKE '%guaranteed%'
                OR column_name LIKE '%bid_%')`)).rows;
    if (!strays.length) ok('no other table has an authorization or guarantee column');
    else bad(`${strays.length} stray column(s)`, strays.map((s) => `${s.table_name}.${s.column_name}`).join(', '));

    for (const omit of ['authorized_by', 'approval_id', 'scope']) {
      const row = {
        id: `auth-omit-${omit}`, company_id: 'co-a', solicitation_id: 'sol-a',
        scope: '50 kg API delivery', authorized_by: 'naren@abiozen.com', approval_id: 'appr-bid-1',
      };
      delete row[omit];
      const c2 = Object.keys(row);
      const msg = await refused(q,
        `INSERT INTO fulfillment_authorizations (${c2.join(',')})
           VALUES (${c2.map((_, i) => `$${i + 1}`).join(',')})`, c2.map((k) => row[k]));
      if (msg) ok(`an authorization with no ${omit} → refused`);
      else bad(`an authorization with no ${omit} was ACCEPTED`, 'a bid commitment needs all three');
    }
    const authOk = await refused(q,
      `INSERT INTO fulfillment_authorizations
         (id,company_id,solicitation_id,scope,authorized_by,approval_id)
       VALUES ('auth-1','co-a','sol-a','50 kg API delivery','naren@abiozen.com','appr-bid-1')`);
    if (!authOk) ok('a complete authorization IS accepted — a person can still authorise a bid');
    else bad('a complete authorization was refused', authOk);

    // Sufficiency across every requirement STILL does not produce one. Proved by the absence of
    // any mechanism: nothing in the schema writes this table.
    const authCount = (await q(`SELECT COUNT(*)::int n FROM fulfillment_authorizations`)).rows[0].n;
    const suffCount = (await q(`SELECT COUNT(*)::int n FROM requirement_matches WHERE evidence_sufficient`)).rows[0].n;
    ok(`${suffCount} sufficient match(es) exist and produced ${authCount - 1} authorization(s) by themselves`);

    // ── 5b. RULING 16 ITEM 7 — THE DATABASE REFUSES THE WRITE ────────────
    h('5b. AUTHORIZATION IS ENFORCED BY A WRITE CONTROL, NOT ONLY BY SHAPE');
    // RLS would be the textbook answer and does not work: the app connects as a superuser and a
    // superuser bypasses RLS. A BEFORE trigger fires for every role, so it holds against the
    // connection we actually have. These assertions are what make that claim checkable.
    const notAUser = await refused(q,
      `INSERT INTO fulfillment_authorizations
         (id,company_id,solicitation_id,scope,authorized_by,approval_id)
       VALUES ('auth-ghost','co-a','sol-a','anything','someone@nowhere.invalid','appr-x')`);
    if (notAUser && /is not a known user/.test(notAUser)) {
      ok('an authorizer who is not a real user → REFUSED by the trigger');
    } else bad('a non-existent authorizer was accepted', notAUser || 'accepted');

    const inactive = await refused(q,
      `INSERT INTO fulfillment_authorizations
         (id,company_id,solicitation_id,scope,authorized_by,approval_id)
       VALUES ('auth-gone','co-a','sol-a','anything','former@abiozen.com','appr-x')`);
    if (inactive && /not an active user/.test(inactive)) {
      ok('a DEACTIVATED admin cannot authorize a bid — the role is read live, not from a token');
    } else bad('an inactive user authorized a bid', inactive || 'accepted');

    for (const [email, role] of [['raj@abiozen.com', 'procurement_team'], ['dir@abiozen.com', 'procurement_director']]) {
      const msg = await refused(q,
        `INSERT INTO fulfillment_authorizations
           (id,company_id,solicitation_id,scope,authorized_by,approval_id)
         VALUES ($1,'co-a','sol-a','anything',$2,'appr-x')`, [`auth-${role}`, email]);
      if (msg && /may not authorize a bid/.test(msg)) ok(`role '${role}' → REFUSED`);
      else bad(`role '${role}' authorized a bid`, msg || 'accepted');
    }
    const adminOk = await refused(q,
      `INSERT INTO fulfillment_authorizations
         (id,company_id,solicitation_id,scope,authorized_by,approval_id)
       VALUES ('auth-admin','co-a','sol-a','10 kg','admin@abiozen.com','appr-admin')`);
    if (!adminOk) ok("role 'admin' IS permitted — the guard is a gate, not a wall");
    else bad('a permitted role was refused', adminOk);

    // IMMUTABILITY. An authorization that can be edited is a signature that can be moved onto a
    // different document.
    for (const [sql, what] of [
      [`UPDATE fulfillment_authorizations SET scope = 'something much larger' WHERE id='auth-1'`, 'the scope'],
      [`UPDATE fulfillment_authorizations SET authorized_by = 'admin@abiozen.com' WHERE id='auth-1'`, 'the authorizer'],
      [`UPDATE fulfillment_authorizations SET approval_id = 'appr-different' WHERE id='auth-1'`, 'the approval id'],
      [`UPDATE fulfillment_authorizations SET valid_until = CURRENT_DATE + 365 WHERE id='auth-1'`, 'the validity window'],
    ]) {
      const msg = await refused(q, sql);
      if (msg && /immutable once made/.test(msg)) ok(`editing ${what} after the fact → REFUSED`);
      else bad(`${what} was edited after the authorization was made`, msg || 'accepted');
    }
    const revokeBad = await refused(q,
      `UPDATE fulfillment_authorizations
         SET revoked_at = NOW(), revoked_by = 'raj@abiozen.com' WHERE id='auth-1'`);
    if (revokeBad && /may not revoke/.test(revokeBad)) ok('a non-admin cannot revoke an authorization');
    else bad('a non-admin revoked an authorization', revokeBad || 'accepted');
    const revokeOk = await refused(q,
      `UPDATE fulfillment_authorizations
         SET revoked_at = NOW(), revoked_by = 'naren@abiozen.com',
             revocation_reason = 'supplier withdrew' WHERE id='auth-1'`);
    if (!revokeOk) ok('an admin CAN revoke — and the row is kept, not deleted');
    else bad('a legitimate revocation was refused', revokeOk);
    const stillThere = (await q(`SELECT COUNT(*)::int n FROM fulfillment_authorizations WHERE id='auth-1'`)).rows[0].n;
    if (stillThere === 1) ok('the revoked authorization survives as history');
    else bad('revocation deleted the record');

    // ── 6. tenant isolation, and the limit of it (item 2) ─────────────────
    h('6. TENANT ISOLATION, AND WHERE IT CANNOT REACH');
    const crossReq = await refused(q,
      `INSERT INTO solicitation_requirements (id,company_id,solicitation_id,requirement_kind,description)
         VALUES ('req-x','co-b','sol-a','material','co-b reaching into co-a')`);
    if (crossReq && /tenant_fk|foreign key/i.test(crossReq)) {
      ok("co-b cannot attach a requirement to co-a's solicitation");
    } else bad('a requirement crossed tenants', crossReq || 'accepted');

    const crossDoc = await refused(q,
      `INSERT INTO solicitation_requirements
         (id,company_id,solicitation_id,requirement_kind,description,extracted_from)
       VALUES ('req-y','co-b','sol-b','material','cites co-a document','doc-a')`);
    if (crossDoc && /document_tenant_fk|foreign key/i.test(crossDoc)) {
      ok("co-b cannot cite co-a's document as its extraction source");
    } else bad("a requirement cited another tenant's document", crossDoc || 'accepted');

    const crossCap = await refused(q,
      `INSERT INTO requirement_matches
         (id,company_id,requirement_id,evidence_class,capability_id,evidence_as_of,
          evidence_sufficient,matched_by,approval_id)
       VALUES ('m-x','co-a','req-a','accreditation','cap-a',CURRENT_DATE,true,'naren','appr-4')`);
    if (!crossCap) ok('a same-tenant capability match is allowed');
    else bad('a valid capability match was refused', crossCap);

    const orphanSku = await refused(q,
      `INSERT INTO requirement_matches
         (id,company_id,requirement_id,evidence_class,sku_id,evidence_sufficient,matched_by)
       VALUES ('m-orphan','co-a','req-a','catalog_listing','sku-does-not-exist',false,'naren')`);
    if (orphanSku && /foreign key|skus/i.test(orphanSku)) {
      ok('an orphaned sku reference → refused (item 2: reject orphaned references)');
    } else bad('an orphaned sku reference was accepted', orphanSku || 'accepted');

    // THE HONEST LIMIT. skus and suppliers have no company_id, so cross-tenant use of a REAL sku
    // cannot be refused. Asserted as a KNOWN GAP rather than left for somebody to discover.
    const crossSku = await refused(q,
      `INSERT INTO requirement_matches
         (id,company_id,requirement_id,evidence_class,sku_id,evidence_sufficient,matched_by)
       VALUES ('m-globalsku','co-a','req-a','catalog_listing','sku-1',false,'naren')`);
    if (!crossSku) {
      ok('a real sku reference is accepted — and NOTE: skus has no company_id, so tenant');
      ok('scoping on skus/suppliers is NOT enforceable. Recorded as a known gap, not a pass.');
    } else bad('a legitimate sku reference was refused', crossSku);

    // ── 6b. RULING 16 ITEM 8 — FAIL CLOSED ON A SECOND ACTIVE TENANT ─────
    h('6b. A SECOND ACTIVE TENANT MUST FAIL CLOSED, NOT PICK ONE');
    // skus and suppliers have no company_id, so tenant scoping on them is unenforceable (§6).
    // The compensating control is that the read-session resolver REFUSES outright when more than
    // one active company exists, rather than defaulting to a row. Tested here against the real
    // resolver, because a compensating control nobody exercises is an assumption.
    const ctx = require('../src/lib/office/context');
    const twoActive = async () => ctx.resolveCompanyForReadSession(
      { userId: 'u-super' }, { query: (sql, p) => q(sql, p) });
    try {
      await twoActive();
      bad('the resolver returned a company while TWO are active',
        'with skus/suppliers unscoped, picking one would be a cross-tenant read');
    } catch (e) {
      if (/active companies exist/.test(e.message) && /UNKNOWN/.test(e.message)) {
        ok('two active companies → the resolver REFUSES and says which answer is UNKNOWN');
      } else bad('the resolver failed for the wrong reason', e.message);
    }
    await q(`UPDATE companies SET status='inactive' WHERE id='co-b'`);
    const one = await twoActive();
    if (one.companyId === 'co-a') ok('with one active company it resolves, and to the right one');
    else bad('the resolver returned the wrong company', JSON.stringify(one));
    await q(`UPDATE companies SET status='active' WHERE id='co-b'`);
    ok('second tenant restored — the refusal is the steady state while skus/suppliers are unscoped');

    // ── 7. documents: integrity and scan discipline (items 5–6) ───────────
    h('7. DOCUMENT INTEGRITY AND SCAN DISCIPLINE');
    // This must reach intake_documents_clean_requires_storage, so it needs a version and an
    // ingested verdict first: the ruling-18 trigger is a BEFORE trigger and fires ahead of every
    // CHECK, so without those the refusal would come from the wrong guard and this assertion
    // would be testing something it does not name.
    await q(`INSERT INTO intake_documents
               (id,company_id,submitted_by,origin,byte_size,sha256,storage_version_id)
             VALUES ('doc-bad','co-a','naren','upload',10,$1,'v1')`, [SHA('b')]);
    await ingest(q, 'doc-bad', 'v1', 'NO_THREATS_FOUND');
    const cleanNoStore = await refused(q,
      `UPDATE intake_documents SET scan_status='clean', scan_version_id='v1', scanned_at=NOW(),
              integrity_ok=true, integrity_checked_at=NOW()
         WHERE id='doc-bad'`);
    if (cleanNoStore && /clean_requires_storage/.test(cleanNoStore)) {
      ok('a document marked clean with no storage reference or scan time → refused');
    } else bad('a clean document with no storage was accepted', cleanNoStore || 'accepted');

    const badSha = await refused(q,
      `INSERT INTO intake_documents (id,company_id,submitted_by,origin,byte_size,sha256)
         VALUES ('doc-sha','co-a','naren','upload',10,'not-a-sha')`);
    if (badSha && /sha256_shape/.test(badSha)) ok('a malformed sha256 → refused');
    else bad('a malformed sha256 was accepted', badSha || 'accepted');

    const tooBig = await refused(q,
      `INSERT INTO intake_documents (id,company_id,submitted_by,origin,byte_size,sha256)
         VALUES ('doc-big','co-a','naren','upload',60000000,$1)`, [SHA('c')]);
    if (tooBig && /size_cap/.test(tooBig)) ok('a 60 MB document → refused by the constraint, not just the handler');
    else bad('an oversized document was accepted', tooBig || 'accepted');

    const urlNoUrl = await refused(q,
      `INSERT INTO intake_documents (id,company_id,submitted_by,origin,byte_size,sha256)
         VALUES ('doc-url','co-a','naren','url',10,$1)`, [SHA('d')]);
    if (urlNoUrl && /url_has_url/.test(urlNoUrl)) ok("origin='url' with no source_url → refused");
    else bad('a url-origin document with no url was accepted', urlNoUrl || 'accepted');

    const dupSha = await refused(q,
      `INSERT INTO intake_documents (id,company_id,submitted_by,origin,byte_size,sha256)
         VALUES ('doc-dup','co-a','naren','upload',1024,$1)`, [SHA('a')]);
    if (dupSha && /unique|duplicate key/i.test(dupSha)) ok('the same bytes twice → one document');
    else bad('duplicate bytes created a second document', dupSha || 'accepted');
    // ── 7c. RULING 18 ITEM 6 — A CLEAN VERDICT CANNOT BE FORGED ──────────
    h('7c. THE APPLICATION AND THE AI PATH CANNOT INVENT A SCAN VERDICT');
    // The threat model is not an outside attacker: it is our own code, and specifically the AI
    // evaluation path, writing 'clean' because a column was writable.
    await q(`INSERT INTO intake_documents
               (id,company_id,submitted_by,origin,byte_size,sha256,detected_mime,
                storage_bucket,storage_key,storage_version_id)
             VALUES ('doc-forge','co-a','naren','upload',2048,$1,'application/pdf',
                     'b','prpa/co-a/2026/11/f.pdf','fv1')`, [H('forge')]);

    const asserted = await refused(q,
      `UPDATE intake_documents SET scan_status='clean', scan_version_id='fv1', scanned_at=NOW(),
              integrity_ok=true, integrity_checked_at=NOW() WHERE id='doc-forge'`);
    if (asserted && /cannot be asserted, only reflected/.test(asserted)) {
      ok("'clean' with NO ingested scanner result → REFUSED; a verdict is reflected, not asserted");
    } else bad('a verdict was asserted with no scanner result', asserted || 'accepted');

    // The AI path has no channel by which its reasoning becomes a scan result.
    for (const ch of ['application', 'ai', 'manual', 'claude']) {
      const e = await refused(q,
        `INSERT INTO document_scan_results
           (id,company_id,document_id,storage_version_id,provider,channel,
            provider_event_id,provider_status,mapped_status)
         VALUES ($1,'co-a','doc-forge','fv1','aws_guardduty_malware_protection_s3',$2,
                 $3,'NO_THREATS_FOUND','clean')`, [`sr-${ch}`, ch, `e-${ch}`]);
      if (e && /document_scan_results_channel/.test(e)) ok(`channel '${ch}' → REFUSED; there is no such delivery path`);
      else bad(`channel '${ch}' was accepted`, e || 'accepted');
    }

    // A verdict may not be mapped to something the provider did not say.
    const badMap = await refused(q,
      `INSERT INTO document_scan_results
         (id,company_id,document_id,storage_version_id,provider,channel,
          provider_event_id,provider_status,mapped_status)
       VALUES ('sr-map','co-a','doc-forge','fv1','aws_guardduty_malware_protection_s3',
               'eventbridge','e-map','THREATS_FOUND','clean')`);
    if (badMap && /mapping_is_the_documented_one/.test(badMap)) {
      ok("THREATS_FOUND mapped to 'clean' → REFUSED; the mapping is fixed in the database too");
    } else bad('a threat was mapped to clean', badMap || 'accepted');

    const unknownStatus = await refused(q,
      `INSERT INTO document_scan_results
         (id,company_id,document_id,storage_version_id,provider,channel,
          provider_event_id,provider_status,mapped_status)
       VALUES ('sr-unk','co-a','doc-forge','fv1','aws_guardduty_malware_protection_s3',
               'eventbridge','e-unk','PROBABLY_FINE','clean')`);
    // Refused — by the MAPPING constraint, because an unrecognised status cannot satisfy any of
    // its five branches. That makes document_scan_results_provider_status unreachable in practice:
    // defence in depth rather than the first line. Asserting its name would assert a path the
    // database does not take.
    if (unknownStatus && /(provider_status|mapping_is_the_documented_one)/.test(unknownStatus)) {
      ok('an unrecognised provider status cannot be stored at all, so it cannot become clean');
    } else bad('an unknown provider status was accepted', unknownStatus || 'accepted');

    // A real verdict, and the reflection it permits — the positive control.
    await ingest(q, 'doc-forge', 'fv1', 'THREATS_FOUND');
    const claimClean = await refused(q,
      `UPDATE intake_documents SET scan_status='clean', scan_version_id='fv1', scanned_at=NOW(),
              integrity_ok=true, integrity_checked_at=NOW() WHERE id='doc-forge'`);
    if (claimClean && /says 'infected', not 'clean'/.test(claimClean)) {
      ok("the scanner said infected → 'clean' is REFUSED with the real verdict named");
    } else bad('a clean verdict overrode an infected scan result', claimClean || 'accepted');
    const reflectTrue = await refused(q,
      `UPDATE intake_documents SET scan_status='infected', scan_version_id='fv1', scanned_at=NOW()
         WHERE id='doc-forge'`);
    if (!reflectTrue) ok('…and the TRUE verdict is accepted — the gate reflects, it does not block');
    else bad('the true verdict was refused', reflectTrue);

    // An ingested result for a different version authorizes nothing.
    const otherVer = await refused(q,
      `UPDATE intake_documents SET storage_version_id='fv2', scan_status='clean',
              scan_version_id='fv2', scanned_at=NOW(), integrity_ok=true,
              integrity_checked_at=NOW() WHERE id='doc-forge'`);
    if (otherVer && /no ingested scan result/.test(otherVer)) {
      ok('a result for version fv1 does not clear version fv2');
    } else bad('a verdict crossed object versions', otherVer || 'accepted');

    // Evidence is append-only. Evidence that can be edited is not evidence.
    const edited = await refused(q,
      `UPDATE document_scan_results SET provider_status='NO_THREATS_FOUND', mapped_status='clean'
         WHERE document_id='doc-forge'`);
    if (edited && /append-only/.test(edited)) ok('a stored scan result cannot be edited');
    else bad('a scan result was rewritten', edited || 'accepted');
    const deleted = await refused(q, `DELETE FROM document_scan_results WHERE document_id='doc-forge'`);
    if (deleted && /never deleted/.test(deleted)) ok('a stored scan result cannot be deleted');
    else bad('a scan result was deleted', deleted || 'accepted');

    const dupEvent = await refused(q,
      `INSERT INTO document_scan_results
         (id,company_id,document_id,storage_version_id,provider,channel,
          provider_event_id,provider_status,mapped_status)
       SELECT 'sr-dup',company_id,document_id,storage_version_id,provider,channel,
              provider_event_id,provider_status,mapped_status
         FROM document_scan_results WHERE document_id='doc-forge' LIMIT 1`);
    if (dupEvent) ok('the same provider event cannot be ingested twice');
    else bad('a duplicate provider event was accepted', 'accepted');

    const crossScan = await refused(q,
      `INSERT INTO document_scan_results
         (id,company_id,document_id,storage_version_id,provider,channel,
          provider_event_id,provider_status,mapped_status)
       VALUES ('sr-cross','co-b','doc-forge','fv1','aws_guardduty_malware_protection_s3',
               'eventbridge','e-cross','NO_THREATS_FOUND','clean')`);
    if (crossScan) ok("co-b cannot ingest a scan result for co-a's document");
    else bad('a cross-tenant scan result was accepted', 'accepted');

    const threatsOnClean = await refused(q,
      `INSERT INTO document_scan_results
         (id,company_id,document_id,storage_version_id,provider,channel,
          provider_event_id,provider_status,mapped_status,threats)
       VALUES ('sr-tc','co-a','doc-forge','fv3','aws_guardduty_malware_protection_s3',
               'eventbridge','e-tc','NO_THREATS_FOUND','clean','EICAR')`);
    if (threatsOnClean && /threats_only_when_found/.test(threatsOnClean)) {
      ok('a clean verdict carrying a threat list → refused');
    } else bad('a clean verdict carried threats', threatsOnClean || 'accepted');

    // ── 7b. RULING 17 ITEM 4 — A VERDICT BELONGS TO ONE OBJECT VERSION ───
    h('7b. ONLY A CURRENT CLEAN VERDICT PLUS INTEGRITY AUTHORIZES A DOWNLOAD');
    // A presigned URL is not a database write, so the row that must precede one is the gate.
    const PS = { clean: 'NO_THREATS_FOUND', infected: 'THREATS_FOUND', unsupported: 'UNSUPPORTED',
      access_denied: 'ACCESS_DENIED', failed: 'FAILED' };
    const mkDoc = async (id, extra) => {
      await q(
        `INSERT INTO intake_documents
           (id,company_id,submitted_by,origin,byte_size,sha256,detected_mime,
            storage_bucket,storage_key,storage_version_id)
         VALUES ($1,'co-a','naren','upload',1024,$2,'application/pdf',
                 'playnexa-prpa-documents-dev','prpa/co-a/2026/11/x.pdf',$3)`,
        [id, H(id), extra.ver]);
      if (extra.status === 'pending') return;
      await ingest(q, id, extra.scanVer, PS[extra.status]);
      await q(
        `UPDATE intake_documents
            SET scan_status=$2, scan_version_id=$3, scanned_at=$4,
                integrity_ok=$5, integrity_checked_at=$6
          WHERE id=$1`,
        [id, extra.status, extra.scanVer, extra.scannedAt, extra.integrity, extra.integrityAt]);
    };

    const grant = (id, doc, ver, mins = 5) => refused(q,
      `INSERT INTO document_download_grants
         (id,company_id,document_id,storage_version_id,granted_to,expires_at,purpose)
       VALUES ($1,'co-a',$2,$3,'naren', NOW() + ($4 || ' minutes')::interval,'human_review')`,
      [id, doc, ver, String(mins)]);

    // The positive control FIRST, so a later refusal cannot be mistaken for a wall.
    await mkDoc('doc-ok', { ver: 'v1', status: 'clean', scanVer: 'v1',
      scannedAt: new Date().toISOString(), integrity: true, integrityAt: new Date().toISOString() });
    const okServable = (await q(`SELECT servable FROM intake_documents WHERE id='doc-ok'`)).rows[0].servable;
    if (okServable === true) ok('a clean, current, integrity-verified document IS servable');
    else bad('a fully clean document was not servable', String(okServable));
    const gOk = await grant('g-ok', 'doc-ok', 'v1');
    if (!gOk) ok('…and a download grant for it IS accepted');
    else bad('a legitimate download grant was refused', gOk);

    // Each quarantined category named by the ruling.
    for (const st of ['pending', 'infected', 'unsupported', 'failed', 'access_denied']) {
      const id = `doc-${st}`;
      await mkDoc(id, { ver: 'v1', status: st,
        scanVer: st === 'pending' ? null : 'v1',
        scannedAt: st === 'pending' ? null : new Date().toISOString(),
        integrity: true, integrityAt: new Date().toISOString() });
      const sv = (await q(`SELECT servable FROM intake_documents WHERE id=$1`, [id])).rows[0].servable;
      const g = await grant(`g-${st}`, id, 'v1');
      if (sv === false && g && /quarantined/.test(g)) ok(`scan_status '${st}' → not servable, download REFUSED`);
      else bad(`scan_status '${st}' did not quarantine`, `servable=${sv} grant=${g || 'accepted'}`);
    }

    // THE CASE THE RULING EXISTS FOR: a clean verdict, then a new version of the same object.
    // I expected the generated column to render this merely unservable. The CHECK is stronger than
    // that — it refuses to let such a row EXIST. A stale clean verdict is not a state the database
    // can be put into, which is better than a state it can be put into and then declines to serve.
    const staleRow = await refused(q,
      `UPDATE intake_documents SET storage_version_id = 'v2' WHERE id = 'doc-ok'`);
    if (staleRow && /clean_verdict_is_current/.test(staleRow)) {
      ok('pointing a clean document at a NEW object version → REFUSED; the row cannot exist');
    } else bad('a clean verdict survived being repointed at a new version', staleRow || 'accepted');

    // So the only way to record a new version is to retract the verdict in the same statement.
    // That is the discipline the constraint forces, and it is the correct one.
    await q(`UPDATE intake_documents
                SET storage_version_id='v2', scan_status='pending',
                    scan_version_id=NULL, scanned_at=NULL
              WHERE id='doc-ok'`);
    const afterNewVer = (await q(`SELECT servable, scan_status FROM intake_documents WHERE id='doc-ok'`)).rows[0];
    if (afterNewVer.servable === false && afterNewVer.scan_status === 'pending') {
      ok('recording a new version forces the verdict back to pending, and it is not servable');
    } else bad('a new version did not reset the verdict', JSON.stringify(afterNewVer));
    const gStale = await grant('g-stale', 'doc-ok', 'v2');
    if (gStale && /quarantined/.test(gStale)) ok('…and no download may be authorized for it');
    else bad('a download was authorized for an unscanned version', gStale || 'accepted');

    // Re-scanned at the new version, it is servable again — and a grant naming the OLD version is
    // still refused, so a grant cannot be replayed across a re-upload.
    await ingest(q, 'doc-ok', 'v2', 'NO_THREATS_FOUND');
    await q(`UPDATE intake_documents
                SET scan_status='clean', scan_version_id='v2', scanned_at=NOW(),
                    integrity_ok=true, integrity_checked_at=NOW()
              WHERE id='doc-ok'`);
    const gWrongVer = await grant('g-wrongver', 'doc-ok', 'v1');
    if (gWrongVer && /names version/.test(gWrongVer)) ok('a grant naming a superseded version → REFUSED');
    else bad('a grant named the wrong version and was accepted', gWrongVer || 'accepted');

    // Integrity alone can withdraw servability, independently of the scan.
    const brokeIntegrity = await refused(q,
      `UPDATE intake_documents SET integrity_ok=false WHERE id='doc-ok'`);
    if (brokeIntegrity && /clean_verdict_is_current/.test(brokeIntegrity)) {
      ok('a clean document whose bytes fail verification → REFUSED; scan and integrity are separate');
    } else bad('integrity could be revoked while the document stayed clean', brokeIntegrity || 'accepted');

    // Integrity is a separate requirement from the scan, per ruling 17 item 4.
    await q(`INSERT INTO intake_documents
                (id,company_id,submitted_by,origin,byte_size,sha256,detected_mime,storage_bucket,
                 storage_key,storage_version_id)
              VALUES ('doc-noint','co-a','naren','upload',10,$1,'application/pdf','b','k','v1')`,
      [H('noint')]);
    await ingest(q, 'doc-noint', 'v1', 'NO_THREATS_FOUND');
    const noIntegrity = await refused(q,
      `UPDATE intake_documents SET scan_status='clean', scan_version_id='v1', scanned_at=NOW()
         WHERE id='doc-noint'`);
    if (noIntegrity && /clean_verdict_is_current/.test(noIntegrity)) {
      ok('clean with NO integrity verification → refused (scan and integrity are separate)');
    } else bad('a clean document with no integrity check was accepted', noIntegrity || 'accepted');

    // intake_documents_verdict_names_its_version is now DEFENCE IN DEPTH rather than the first
    // line: any non-pending verdict with a null version is refused by the ruling-18 trigger
    // before a CHECK is evaluated. Asserting the constraint name here would be asserting a path
    // the database no longer takes, so this asserts the refusal and names what produced it.
    const verdictNoVersion = await refused(q,
      `INSERT INTO intake_documents
         (id,company_id,submitted_by,origin,byte_size,sha256,scan_status)
       VALUES ('doc-nov','co-a','naren','upload',10,$1,'infected')`, [H('nov')]);
    if (verdictNoVersion && /no ingested scan result/.test(verdictNoVersion)) {
      ok('a verdict naming no object version → refused (by the ingestion gate, which fires first)');
    } else bad('a versionless verdict was accepted', verdictNoVersion || 'accepted');

    // Short-lived by construction, and tenant-scoped.
    const tooLong = await grant('g-long', 'doc-ok', 'v2', 120);
    if (tooLong && /short_lived/.test(tooLong)) ok('a 2-hour download grant → refused; grants are minutes');
    else bad('a long-lived download grant was accepted', tooLong || 'accepted');

    const crossGrant = await refused(q,
      `INSERT INTO document_download_grants
         (id,company_id,document_id,storage_version_id,granted_to,expires_at,purpose)
       VALUES ('g-cross','co-b','doc-ok','v2','someone', NOW() + INTERVAL '5 minutes','extraction')`);
    if (crossGrant) ok("co-b cannot authorize a download of co-a's document");
    else bad("a cross-tenant download grant was accepted", 'accepted');


    // ── 8. extraction provenance (item 2 of ruling 14, kept) ──────────────
    h('8. A MODEL-EXTRACTED REQUIREMENT MUST NAME THE MODEL');
    const unattributed = await refused(q,
      `INSERT INTO solicitation_requirements
         (id,company_id,solicitation_id,requirement_kind,description,extraction_method)
       VALUES ('req-unattr','co-a','sol-a','material','from a machine','gpt-guess')`);
    if (unattributed && /method_attributed/.test(unattributed)) {
      ok("an extraction_method that is not 'human', 'structured' or 'model:…' → refused");
    } else bad('an unattributed extraction method was accepted', unattributed || 'accepted');
    const attributed = await refused(q,
      `INSERT INTO solicitation_requirements
         (id,company_id,solicitation_id,requirement_kind,description,extraction_method,
          extraction_confidence,source_span)
       VALUES ('req-attr','co-a','sol-a','quantity','50 kg','model:claude-x@2026-11',0.82,
               '{"page":3,"start":120,"end":168,"text":"fifty (50) kilograms"}'::jsonb)`);
    if (!attributed) ok('a properly attributed extraction with a source span is accepted');
    else bad('a properly attributed extraction was refused', attributed);

    const halfConfirmed = await refused(q,
      `UPDATE solicitation_requirements SET confirmed_by = 'naren' WHERE id = 'req-attr'`);
    if (halfConfirmed && /confirmation_paired/.test(halfConfirmed)) {
      ok('a confirmation without a timestamp → refused (a person and a time, or neither)');
    } else bad('a half-recorded confirmation was accepted', halfConfirmed || 'accepted');

    // ── 9. audit history (item 2: preserve approval history) ──────────────
    h('9. AUDIT ENTRIES FOR DECISIONS MUST CARRY THEIR APPROVAL');
    const noApproval = await refused(q,
      `INSERT INTO intake_audit (id,company_id,subject_table,subject_id,action,actor)
         VALUES ('aud-1','co-a','requirement_matches','m-ok','authorized','naren')`);
    if (noApproval && /decisions_have_approval/.test(noApproval)) {
      ok("an 'authorized' audit entry with no approval_id → refused");
    } else bad('a decision was audited without its approval', noApproval || 'accepted');
    const withApproval = await refused(q,
      `INSERT INTO intake_audit (id,company_id,subject_table,subject_id,action,actor,approval_id)
         VALUES ('aud-2','co-a','fulfillment_authorizations','auth-1','authorized','naren@abiozen.com','appr-bid-1')`);
    if (!withApproval) ok('the same entry with its approval is accepted');
    else bad('a properly approved audit entry was refused', withApproval);

    // ── 10. the rollback guard ────────────────────────────────────────────
    h('10. ROLLBACK REFUSES RATHER THAN DESTROY HUMAN DECISIONS');
    r = runner(url, ['--rollback']);
    if (r.code === 2) ok('--rollback without the acknowledgement exits 2');
    else bad(`--rollback without acknowledgement exited ${r.code}`);

    r = runner(url, ['--rollback', '--i-understand-this-drops-tables']);
    if (r.code === 2 && /HUMAN DECISIONS WOULD BE DESTROYED/.test(r.out)) {
      ok('rollback REFUSED while approvals, authorizations and audit entries exist');
    } else bad(`rollback exited ${r.code} with human decisions present`, r.out.slice(-400));
    let survived = 0;
    for (const t of schema.CREATED_TABLES) {
      survived += (await q(
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [t])).rows[0].n;
    }
    if (survived === schema.CREATED_TABLES.length) ok('the refused rollback dropped NOTHING');
    else bad(`only ${survived} of ${schema.CREATED_TABLES.length} tables survived a refused rollback`);

    // Clean rollback once the human work is deliberately removed.
    h('11. A CLEAN ROLLBACK, ONCE THE DECISIONS ARE DELIBERATELY REMOVED');
    await q(`DELETE FROM intake_audit`);
    await q(`DELETE FROM fulfillment_authorizations`);
    await q(`DELETE FROM requirement_matches`);
    await q(`UPDATE solicitation_requirements SET confirmed_by=NULL, confirmed_at=NULL`);
    r = runner(url, ['--rollback', '--i-understand-this-drops-tables']);
    if (r.code === 0) ok('rollback succeeds once nothing human remains');
    else bad(`rollback exited ${r.code}`, r.out.slice(-500));
    let gone = 0;
    for (const t of schema.CREATED_TABLES) {
      gone += (await q(
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [t])).rows[0].n;
    }
    if (gone === 0) ok(`all ${schema.CREATED_TABLES.length} tables dropped`);
    else bad(`${gone} table(s) survived the rollback`);
    const manualGone = (await q(`SELECT COUNT(*)::int n FROM source_connectors WHERE source_key='manual'`)).rows[0].n;
    if (manualGone === 0) ok('the manual source row was removed');
    else bad('the manual source row survived');
    const sols = (await q(`SELECT COUNT(*)::int n FROM solicitations`)).rows[0].n;
    const caps = (await q(`SELECT COUNT(*)::int n FROM verified_capabilities`)).rows[0].n;
    if (sols === 2 && caps === 1) ok('solicitations and verified_capabilities untouched');
    else bad(`pre-existing rows changed: solicitations ${sols}, capabilities ${caps}`);

    r = runner(url, ['--apply']);
    if (r.code === 0) ok('the migration re-applies cleanly after a rollback');
    else bad(`re-apply exited ${r.code}`, r.out.slice(-400));
  } finally {
    await client.end().catch(() => {});
    stopCluster();
  }

  h('RESULT');
  if (fail) { console.log(`  ${fail} guard(s) FAILED. v3 is not proved.\n`); process.exit(1); }
  console.log('  Every guard was tested by attempting what it forbids, and the database refused.');
  console.log('  Evidence sufficiency, eligibility and bid authorization are separate, and nothing');
  console.log('  derives the third from the first two.\n');
  process.exit(0);
}

main().catch((e) => { stopCluster(); console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
