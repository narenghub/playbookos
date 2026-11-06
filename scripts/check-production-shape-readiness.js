// ── WILL THE NEXT RUN AGAINST THE REAL PRODUCTION DUMP PASS? ───────────────────────────────────────
//
//   node scripts/check-production-shape-readiness.js ; echo $?
//
// WHY THIS EXISTS. Validating the migration against production's schema requires a production dump,
// which only the CEO can take: Railway → Postgres → Backups → download, then 25MB across the wire.
// The first such run halted on one step, `outreach`. Fixing that step and asking for another dump
// makes the loop one defect per round-trip, with him doing the work each time — and there are 63
// inline constraints across 57 tables that could each halt it the same way.
//
// So production's SHAPE is reconstructed here, from what that run actually reported, and the entire
// gate-2 harness is run against a dump of it. This cannot replace the real dump: it reproduces the
// shape that was observed, not the one that exists, and anything the report did not show is not in it.
// What it does do is answer "is there a second defect waiting behind the first" before asking for
// another 25MB.
//
// THE SHAPE, taken from the 2026-11-06 run and nothing else:
//
//   140 tables                                  — a database built by the hand-run scripts, not the migrator
//   outreach: 159 rows, columns including channel and partner_id, and NO
//     UNIQUE (entity_type, entity_id)           — what the run called the halt
//   federal_opportunities, opportunity_assessments, opportunity_bid_reviews,
//   opportunity_audit_events, opportunity_import_batches: ABSENT    — this release introduces them
//   users 12 · companies 1 · notifications 14 · prospects 4756      — rows that must survive
//
// WHAT THAT HALT TURNED OUT TO BE. Not a defect in production's schema. `partner_id` in that column
// list is the tell: migrate-outreach-partner-scope.js had been run there by hand, and it DROPS
// UNIQUE (entity_type, entity_id) on purpose, replacing it with a unique index on
// (entity_type, entity_id, COALESCE(partner_id, 0)) so a partner and our own staff can each hold a
// record for the same prospect. Production's schema was correct. migrate-outreach.js's verification
// was stale — it still demanded the constraint that a later migration deliberately removes, and
// stopped the chain over a schema that worked.
//
// Behind it sat the real defect: that partner-scope script was not in the migrator chain at all,
// excluded as "back-fills partner scope over existing rows". So a database built by the migrator had
// no outreach.partner_id, and the application's own setStatus upsert failed on it. Every green check
// in this repository had been running against a database where outreach was broken.
//
// A PASS here means: no further defect in the reconstructed shape. It is NOT the gate. The gate is
// scripts/verify-prod-dump.sh against the real dump, and it stays the gate.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.PRODSHAPE_PGPORT || '55461';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;
const sh = (cmd) => {
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  return execFileSync('sh', ['-c', temp.asPostgres ? `su postgres -c ${JSON.stringify(`PATH=${temp.dir}:$PATH ${cmd}`)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });
};

function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/prodshape-');
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
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`],
    { env: { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` }, stdio: 'pipe' });
  } catch { /* going away anyway */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp dir */ }
}

// The tables this release introduces. Production has none of them, which is the whole reason the
// migration exists — and dropping them is what turns a database this repository built into one
// shaped like the database production actually is.
const RELEASE_TABLES = ['opportunity_audit_events', 'opportunity_bid_reviews', 'opportunity_assessments',
  'opportunity_import_batches', 'federal_opportunities'];

async function main() {
  h("RECONSTRUCTED PRODUCTION SHAPE — DOES THE FULL GATE-2 HARNESS PASS AGAINST IT?");

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  const url = `postgresql://postgres@localhost/prodshape?host=${base}&port=${PGPORT}&sslmode=disable`;

  // ── build it ────────────────────────────────────────────────────────────────────────────────────
  h('1. BUILDING A DATABASE SHAPED LIKE PRODUCTION');
  {
    const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS prodshape');
    await admin.query('CREATE DATABASE prodshape');
    await admin.end();

    // Start from the migrator, because hand-reproducing 140 tables would be a fiction nobody could
    // maintain. Then subtract: this release's tables, and the constraint production lacks.
    process.env.DATABASE_URL = url;
    process.env.PRPA_COMPANY_SLUG = 'abiozen';
    // A fixture admin, generated per run. The seed refuses to fall back to a known default, which is
    // correct — and the exposed production password must never appear in a harness, a file or this
    // repository, so it is random and thrown away with the cluster.
    process.env.ADMIN_EMAIL = 'prodshape-fixture@example.invalid';
    process.env.ADMIN_PASSWORD = require('crypto').randomBytes(18).toString('hex');
    const c = new Client({ connectionString: url });
    await c.connect();
    const q = (text, params) => c.query(text, params);

    const built = await require('../src/lib/migrate-all').runAll(q, { seeds: false, log: () => {} });
    if (!built.ok) { bad('could not build the starting point', built.failed.map((f) => f.error).join(' | ')); throw new Error('stop'); }
    const total = (await q(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n;
    ok(`starting point built by the migrator — ${built.steps.length} steps, ${total} tables`);

    for (const t of RELEASE_TABLES) await q(`DROP TABLE IF EXISTS ${t} CASCADE`);
    const after = (await q(`SELECT COUNT(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n;
    ok(`dropped the ${RELEASE_TABLES.length} tables this release introduces — ${after} tables, as production has`);

    // Production's outreach, which the run reported as partner-scoped: partner_id present, the
    // entity-only UNIQUE absent, the per-partner unique index in place. Now that partner scope is a
    // step in the chain, the migrator already produces exactly this — so there is nothing to subtract,
    // and the assertion is that it is really so rather than an edit to make it so. An earlier version
    // of this harness DROPPED the entity-only constraint here to "reproduce the halt", which encoded
    // the wrong diagnosis: that absence is the correct state, not the fault.
    const perPartner = (await q(`SELECT indexdef FROM pg_indexes
                                   WHERE tablename='outreach' AND indexdef ILIKE '%UNIQUE%'
                                     AND indexdef ILIKE '%COALESCE%'`)).rows[0];
    const entityOnly = (await q(`SELECT COUNT(*)::int n FROM pg_constraint
                                   WHERE conrelid='outreach'::regclass AND contype='u'
                                     AND pg_get_constraintdef(oid)='UNIQUE (entity_type, entity_id)'`)).rows[0].n;
    const hasPartnerId = (await q(`SELECT COUNT(*)::int n FROM information_schema.columns
                                     WHERE table_name='outreach' AND column_name='partner_id'`)).rows[0].n;
    if (perPartner && entityOnly === 0 && hasPartnerId === 1) {
      ok("outreach matches production: partner_id present, per-partner unique index, no entity-only UNIQUE");
    } else {
      bad('outreach does not match the shape production reported',
        `partner_id=${hasPartnerId} perPartnerIndex=${perPartner ? 'yes' : 'no'} entityOnlyUnique=${entityOnly}`);
    }

    // Rows that have to survive. 159 outreach rows, all distinct pairs, as production's data must be
    // for the repair to be possible at all — if production turns out to hold duplicates, the harness
    // that matters is migrate-outreach.js's refusal, which is tested separately.
    await q(`INSERT INTO users (id, email, name, role, password_hash)
             SELECT 'shape-' || g, 'shape' || g || '@example.invalid', 'Shape ' || g, 'sales_team', 'x'
               FROM generate_series(1, 12) g
             ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO outreach (entity_type, entity_id, product, status)
             SELECT 'prospect', g::text, 'abiozen', 'contacted' FROM generate_series(1, 159) g`);
    const n = (await q(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    ok(`populated: ${n} outreach rows, 12 users — rows the migration must preserve`);

    await c.end();
  }

  // ── dump it ─────────────────────────────────────────────────────────────────────────────────────
  h('2. DUMPING IT THE WAY THE CEO DUMPS PRODUCTION');
  const dump = `${temp.base}/prodshape.dump`;
  {
    // Same format as `railway run pg_dump --format=custom`, so the readiness script takes the same
    // pg_restore path it will take on the real file.
    sh(`pg_dump -h ${temp.base} -p ${PGPORT} -U postgres --format=custom --file=${dump} prodshape`);
    const bytes = fs.statSync(dump).size;
    if (bytes > 10000) ok(`pg_dump --format=custom wrote ${bytes.toLocaleString()} bytes`);
    else bad(`the dump is suspiciously small (${bytes} bytes)`, 'a 862-byte dump once passed a check that restored nothing');
    const head = fs.readFileSync(dump, { encoding: 'latin1' }).slice(0, 5);
    if (head === 'PGDMP') ok('it is a custom-format archive (PGDMP) — the same kind of file as the real dump');
    else bad(`the dump does not begin with PGDMP: ${JSON.stringify(head)}`);
  }

  // ── run the real gate-2 harness against it ──────────────────────────────────────────────────────
  h('3. THE FULL GATE-2 HARNESS, AGAINST THAT DUMP');
  {
    let code = 0; let out = '';
    try {
      out = execFileSync(process.execPath,
        [path.join(__dirname, 'verify-migration-readiness.js'), dump],
        { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PGPORT_READINESS: '55463' }, maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      code = e.status === undefined ? 1 : e.status;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }

    // Print it, because the point of this harness is the report, not the boolean.
    console.log(out.split('\n').map((l) => `    │ ${l}`).join('\n'));

    if (code === 0) ok('verify-migration-readiness exited 0 against a production-shaped dump');
    else bad(`verify-migration-readiness exited ${code}`,
      'a defect remains that the real dump will hit too — fix it before asking for another backup');

    // The specific things that failed on 2026-11-06, each checked by name so a regression is legible.
    const checks = [
      [/all \d+ step\(s\) applied to a populated database/, 'every migration step applied'],
      [/no table lost rows/, 'no row was lost'],
      [/the migration dropped no column the application reads/, 'no column the application reads was dropped'],
      [/row counts identical after the re-run/, 'a re-run created no duplicate rows'],
    ];
    for (const [re, what] of checks) {
      if (re.test(out)) ok(what);
      else bad(`not shown in the report: ${what}`);
    }
    if (/column\(s\) the application reads are GONE/.test(out)) {
      bad('the misleading "GONE" wording is still being printed', 'it conflates a dropped column with one never created');
    } else {
      ok('the misleading "GONE" wording is gone');
    }
  }

  // ── the behaviour, checked in the database rather than in a log line ───────────────────────────
  h("4. AFTER MIGRATING THE DUMP — does the application's own outreach upsert work?");
  {
    // "All 49 steps applied" implies migrate-outreach.js exited 0 — but that is an inference from an
    // absence, and an absence is what let the original defect hide for a month. So the dump is
    // restored again and the query the application actually runs is executed against it.
    //
    // What is asserted is the BEHAVIOUR, not the shape. An earlier version of this section asserted
    // that UNIQUE (entity_type, entity_id) was present afterwards, which was the wrong expectation
    // twice over: partner scope drops it by design, and re-adding it would forbid the per-partner
    // records the product needs. A shape assertion goes stale the moment a migration changes the
    // design; the upsert cannot, because it is the application's own code.
    const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS prodshape_migrated');
    await admin.query('CREATE DATABASE prodshape_migrated');
    await admin.end();

    const mUrl = `postgresql://postgres@localhost/prodshape_migrated?host=${base}&port=${PGPORT}&sslmode=disable`;
    sh(`pg_restore -h ${temp.base} -p ${PGPORT} -U postgres -d prodshape_migrated ${dump}`);

    const c = new Client({ connectionString: mUrl });
    await c.connect();
    const q = (text, params) => c.query(text, params);

    const entityOnly = (await q(`SELECT COUNT(*)::int n FROM pg_constraint
                                   WHERE conrelid='outreach'::regclass AND contype='u'
                                     AND pg_get_constraintdef(oid)='UNIQUE (entity_type, entity_id)'`)).rows[0].n;
    if (entityOnly === 0) ok("the restored dump has no entity-only UNIQUE — production's actual state");
    else bad('the restored dump has the entity-only UNIQUE', 'it is not reproducing production');

    process.env.DATABASE_URL = mUrl;
    const run = await require('../src/lib/migrate-all').runAll(q, { seeds: false, log: () => {} });
    if (run.ok) ok(`the migration applied all ${run.steps.length} steps to the restored dump`);
    else bad(`${run.failed.length} step(s) failed`, run.failed.map((f) => `${f.name}: ${f.error}`).join(' | '));

    const rows = (await q(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    if (rows === 159) ok('all 159 outreach rows survived');
    else bad(`outreach went from 159 to ${rows} rows`, 'the migration must never discard an outreach record');

    // The query from src/lib/outreach/index.js, run against the migrated dump.
    const UPSERT = `INSERT INTO outreach (entity_type, entity_id, product, status, partner_id)
                    VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT (entity_type, entity_id, COALESCE(partner_id, 0))
                    DO UPDATE SET status = EXCLUDED.status, updated_at = NOW() RETURNING id`;
    try {
      const staff = (await q(UPSERT, ['prospect', '1', 'abiozen', 'won', null])).rows[0].id;
      const same = (await q(UPSERT, ['prospect', '1', 'abiozen', 'interested', null])).rows[0].id;
      if (same === staff) ok("setStatus's upsert works and updates in place — no duplicate row");
      else bad('the upsert created a second staff row', `${staff} → ${same}`);

      const partner = (await q(`INSERT INTO partners (name) VALUES ('Shape Partner') RETURNING id`)).rows[0].id;
      const pRow = (await q(UPSERT, ['prospect', '1', 'abiozen', 'contacted', partner])).rows[0].id;
      if (pRow !== staff) ok('a partner holds its own record for the same prospect — the per-partner key works');
      else bad('the partner write overwrote the staff record', 'both are meant to coexist');
    } catch (e) {
      bad("the application's own upsert fails after the migration", e.message.split('\n')[0]);
    }

    await c.end();
  }

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  a production-shaped dump still does not migrate cleanly.\n' +
                '      Fix this before asking for another production backup.\n');
    process.exit(1);
  }
  console.log('\nPASS  the full gate-2 harness passes against a database shaped like production.\n');
  console.log('      THIS IS NOT THE GATE, and one number says why: the real dump restored 140 tables.');
  console.log('      This reconstruction has 147 — the migrator\'s 152 less the 5 this release adds. So');
  console.log('      production is missing roughly SEVEN further tables that are present here, and this');
  console.log('      harness cannot say which, because the report it was built from did not list them.');
  console.log('      The migration creates missing tables, so the likely answer is "nothing to do" —');
  console.log('      but a table absent here and PRESENT there, with a constraint this schema expects,');
  console.log('      is exactly the shape of defect that halted the first run, and it would not appear');
  console.log('      in this reconstruction at all.');
  console.log('');
  console.log('      What a PASS here means: no further defect in the shape that WAS reported.');
  console.log('      The gate remains scripts/verify-prod-dump.sh against the real dump.\n');
}

// The explicit exits are load-bearing, not tidiness. src/lib/db opens a module-level Pool when the
// migrator is first required, and nothing here can close it — so shutting the cluster down leaves
// that pool with a dead socket, and it raises an unhandled 'error' event AFTER the verdict has been
// printed. The first run of this harness reported "17 assertion(s) passed · 0 failed" and then exited
// 1, which is the worst possible combination: by this repository's own rule the exit status is the
// verdict, so a status that contradicts the report is itself a defect. Exiting on the line after the
// verdict is what the sibling harnesses do, and for the same reason.
main().then(() => {
  stopCluster();
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  stopCluster();
  console.error(`\nFAIL  harness error: ${e.message}`);
  process.exit(1);
});
