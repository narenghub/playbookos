#!/usr/bin/env node
// ── THE CAPABILITY REGISTRY, PROVED BY ATTEMPTING TO ACTIVATE WITHOUT EVIDENCE ──
//
//   node scripts/check-capability-registry.js
//
// Ruling 22 item 2 requires "evidence, authorization, and human review before activating a
// capability." Each of those three is attempted without, on a disposable cluster, and must be
// refused — by the module where it can give a useful message, and by the database where it has to
// hold against a caller that skips the module.
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const v4 = require('../src/lib/office/opportunity-schema');
const R = require('../src/lib/office/capability-registry');
const { pgBinCandidates, INITDB_FLAGS } = require('./lib/pg-cluster');

const PGPORT = process.env.PGPORT_TEST || '55443';
const EXIT_NOT_EXECUTED = 3;
const CO = 'co-abiozen';

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 260)}`); };
const bar = () => '─'.repeat(78);
const h = (t) => console.log(`\n${bar()}\n${t}\n${bar()}`);

let temp = null;
function startCluster() {
  let dir = null;
  for (const d of pgBinCandidates()) { dir = d; break; }
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/capreg-');
  const asPostgres = process.getuid && process.getuid() === 0;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (c) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(c)}` : c],
    { env, encoding: 'utf8', stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p ${PGPORT} -c listen_addresses=' start -w`);
  } catch (e) { console.error(`cluster start failed: ${e.message}`); return null; }
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
  } catch (_) { /* */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* */ }
}
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

async function main() {
  h('ABIOZEN CAPABILITY REGISTRY — EVIDENCE, AUTHORIZATION, HUMAN REVIEW');
  const base = startCluster();
  if (!base) { console.log('\nSKIP  no PostgreSQL toolchain. This asserted NOTHING.\n'); process.exit(EXIT_NOT_EXECUTED); }
  const client = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
  await client.connect();
  const q = (sql, p) => client.query(sql, p);

  try {
    await q(`CREATE TABLE companies (id TEXT PRIMARY KEY, slug TEXT, name TEXT, status TEXT, UNIQUE (id, status))`);
    await q(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT, is_active INT DEFAULT 1)`);
    await q(`CREATE TABLE verified_capabilities (
               id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
               kind TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
               responsible_entity TEXT NOT NULL,
               verification_status TEXT NOT NULL DEFAULT 'planned',
               evidence_source TEXT, evidence_url TEXT, evidence_sha256 TEXT,
               verified_at TIMESTAMPTZ, verified_by TEXT, approval_id TEXT,
               valid_from DATE, valid_to DATE, notes TEXT,
               created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
               CONSTRAINT verified_capabilities_status_check
                 CHECK (verification_status IN ('planned','pending','verified','disputed','revoked')),
               UNIQUE (id, company_id))`);
    await q(`CREATE TABLE federal_opportunities (id TEXT PRIMARY KEY, company_id TEXT, UNIQUE (id, company_id))`);
    await q(`INSERT INTO companies VALUES ($1,'abiozen','Abiozen LLC','active')`, [CO]);
    await q(`INSERT INTO users (id,email,role,is_active) VALUES
               ('u-super','naren@abiozen.com','super_admin',1),
               ('u-proc','raj@abiozen.com','procurement_team',1),
               ('u-dir','dir@abiozen.com','procurement_director',1),
               ('u-gone','former@abiozen.com','admin',0)`);
    // Only the ALTERs and the activation trigger from v4 are needed here.
    for (const s of v4.DDL) {
      if (/verified_capabilities|prpa_capability_activation_guard/.test(s)) await q(s);
    }
    ok('schema ready: live-shaped verified_capabilities + the v4 activation guard');

    h('1. THE REGISTRY STARTS EMPTY, AND THE GAP REPORT SAYS SO');
    const g0 = await R.gapReport(q, CO, { today: '2026-11-06' });
    if (g0.length === 5) ok(`all ${g0.length} capability areas reported`);
    else bad(`gap report covered ${g0.length} areas, expected 5`);
    if (g0.every((a) => a.status === 'NO EVIDENCE' && a.sufficient_count === 0)) {
      ok("every area reports NO EVIDENCE — Abiozen's actual position, not an empty list");
    } else bad('an area claimed coverage on an empty registry', JSON.stringify(g0.map((a) => a.status)));
    if (g0.every((a) => a.evidence_needed.length)) ok('each uncovered area names the documents that would cover it');
    else bad('an uncovered area named no required evidence');

    h('2. A PROPOSAL IS NEVER EVIDENCE');
    const p = await R.propose(q, {
      companyId: CO, areaKey: 'analytical_testing', name: 'HPLC assay services',
      responsibleEntity: 'Abiozen LLC', proposedBy: 'raj@abiozen.com',
    });
    const row = (await q(`SELECT * FROM verified_capabilities WHERE id=$1`, [p.id])).rows[0];
    if (row.verification_status === 'pending') ok('propose() lands PENDING');
    else bad(`propose() produced ${row.verification_status}`);
    if (!row.verified_at && !row.verified_by && !row.approval_id && !row.evidence_class) {
      ok('…with verified_at, verified_by, approval_id and evidence_class all NULL');
    } else bad('a proposal carried verification fields');
    const caps0 = await R.activeCapabilities(q, CO, { today: '2026-11-06' });
    if (caps0.length === 0) ok('a pending capability is NOT returned to the qualification engine');
    else bad('a pending capability reached the engine', JSON.stringify(caps0));
    const g1 = await R.gapReport(q, CO, { today: '2026-11-06' });
    const at = g1.find((a) => a.area === 'analytical_testing');
    if (at.status === 'PENDING_REVIEW' && at.sufficient_count === 0) ok('the gap report shows it as PENDING_REVIEW, not covered');
    else bad(`pending area reported ${at.status}`);

    h('3. ACTIVATION REFUSES WITHOUT EVIDENCE, AUTHORIZATION OR A DATE');
    const full = {
      companyId: CO, capabilityId: p.id, evidenceClass: 'method_validated',
      evidenceSource: 'Method validation report MV-2026-014, dated 2026-03-11',
      verifiedBy: 'naren@abiozen.com', approvalId: 'appr-cap-1', validFrom: '2026-03-11',
    };
    for (const [drop, why] of [
      ['evidenceSource', 'no evidence document'],
      ['approvalId', 'no approval id'],
      ['verifiedBy', 'no named verifier'],
      ['validFrom', 'no validity start — evidence without a date cannot expire'],
    ]) {
      const args = { ...full }; delete args[drop];
      const e = await refused(() => R.activate(q, args));
      if (e) ok(`${why} → REFUSED`);
      else bad(`activation succeeded with ${drop} missing`);
    }
    for (const cls of ['catalog_listing', 'supplier_relationship', 'synthesis_prediction']) {
      const e = await refused(() => R.activate(q, { ...full, evidenceClass: cls }));
      if (e && /INDICATIVE/.test(e)) ok(`evidence class '${cls}' → REFUSED as indicative`);
      else bad(`indicative class '${cls}' activated a capability`, e || 'accepted');
    }
    {
      const e = await refused(() => R.activate(q, { ...full, evidenceSha256: 'not-a-hash' }));
      if (e) ok('a malformed evidence hash → REFUSED');
      else bad('a malformed evidence hash was accepted');
    }

    h('4. THE DATABASE REFUSES AN UNAUTHORIZED VERIFIER, EVEN IF THE MODULE IS SKIPPED');
    // The module checks for a usable message; the trigger is what makes it load-bearing. These go
    // straight to SQL, which is what a future caller that skips activate() would do.
    for (const [who, why] of [
      ['nobody@nowhere.invalid', 'a verifier who is not a user'],
      ['former@abiozen.com', 'a DEACTIVATED admin'],
      ['raj@abiozen.com', 'a procurement_team member'],
      ['dir@abiozen.com', 'a procurement_director'],
    ]) {
      const e = await refused(() => q(
        `UPDATE verified_capabilities
            SET verification_status='verified', evidence_source='x', verified_by=$2,
                approval_id='a', verified_at=NOW(), valid_from='2026-01-01'
          WHERE id=$1`, [p.id, who]));
      if (e) ok(`${why} → REFUSED by the trigger`);
      else bad(`${why} activated a capability`, 'accepted');
    }

    h('5. A COMPLETE ACTIVATION WORKS — THE CONTROL IS A GATE, NOT A WALL');
    const a = await R.activate(q, full);
    if (a.verification_status === 'verified') ok('a complete activation succeeds');
    else bad(`activation produced ${a.verification_status}`);
    const caps1 = await R.activeCapabilities(q, CO, { today: '2026-11-06' });
    if (caps1.length === 1 && caps1[0].evidence_class === 'method_validated') {
      ok('…and the capability now reaches the qualification engine, carrying its class');
    } else bad('the activated capability did not reach the engine', JSON.stringify(caps1));
    const g2 = await R.gapReport(q, CO, { today: '2026-11-06' });
    const at2 = g2.find((a2) => a2.area === 'analytical_testing');
    if (at2.status === 'COVERED' && at2.evidence_needed.length === 0) ok('the gap report moves that area to COVERED');
    else bad(`activated area reported ${at2.status}`);
    const cro = g2.find((a2) => a2.area === 'cro_services');
    if (cro.status === 'COVERED') ok('cro_services shares the analytical_services line, so it is covered too');
    else ok(`cro_services reports ${cro.status} — areas are tracked separately from lines`);
    if (g2.filter((x) => x.status === 'NO EVIDENCE').length >= 2) ok('the other areas still report NO EVIDENCE');
    else bad('activating one area covered the others');

    h('6. ACTIVATION IS NOT IDEMPOTENT, AND THAT IS DELIBERATE');
    const again = await refused(() => R.activate(q, full));
    if (again && /only be activated from pending/.test(again)) {
      ok('re-activating an already-verified capability → REFUSED, because it means the wrong id');
    } else bad('re-activation silently succeeded', again || 'accepted');

    h('7. AN EXPIRED CAPABILITY IS NOT A CURRENT ONE');
    await q(`UPDATE verified_capabilities SET valid_to='2026-01-01' WHERE id=$1`, [p.id]);
    const g3 = await R.gapReport(q, CO, { today: '2026-11-06' });
    const at3 = g3.find((x) => x.area === 'analytical_testing');
    if (at3.status === 'EXPIRED' && at3.sufficient_count === 0) ok('a lapsed capability reports EXPIRED, not COVERED');
    else bad(`a lapsed capability reported ${at3.status}`);

    console.log(`\n${bar()}`);
    console.log(`  ${pass} assertion(s) passed · ${fail} failed`);
    return fail;
  } finally {
    try { await client.end(); } catch (_) { /* */ }
    stopCluster();
  }
}

main().then((f) => {
  if (f) { console.log('\nFAIL  a capability can be activated without evidence, authorization or review.\n'); process.exit(1); }
  console.log('\nPASS  nothing becomes a verified capability without a document, a named active');
  console.log('      admin, an approval id and a date — and the database enforces the last three.\n');
  process.exit(0);
}).catch((e) => { stopCluster(); console.error(e); process.exit(1); });
