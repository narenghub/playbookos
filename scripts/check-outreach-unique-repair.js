// ── AFTER THE MIGRATION, DOES THE APPLICATION'S OWN OUTREACH UPSERT WORK? ──────────────────────────
//
//   node scripts/check-outreach-unique-repair.js ; echo $?
//
// This asks the only question that matters about `outreach`, against both of the database shapes that
// exist — and it exists because two different wrong answers were given to it in one afternoon.
//
// WHAT HAPPENED. The first gate-2 run against the real production dump halted on one step:
//
//   outreach: unique on (entity_type, entity_id): MISSING
//   ❌ the upsert has nothing to conflict on — setStatus would duplicate rows
//
// That message was wrong, and so was the first fix for it. The sequence:
//
//   1. migrate-outreach.js created outreach with UNIQUE (entity_type, entity_id) and verified it.
//   2. On 2026-10-01 migrate-outreach-partner-scope.js DELIBERATELY DROPPED that constraint, added
//      outreach.partner_id, and created a unique INDEX on (entity_type, entity_id,
//      COALESCE(partner_id, 0)) — so a partner and our own staff can each hold a record for the same
//      prospect. src/lib/outreach/index.js has conflicted on that three-column expression ever since.
//   3. migrate-outreach.js's verification was never updated. It still demanded the constraint that
//      step 2 removes on purpose, so on production — where partner scoping HAD been applied — it
//      reported a correct schema as broken and stopped the whole chain.
//   4. The first fix added the constraint back, under the exact name step 2 throws on. It would have
//      re-imposed one-record-per-prospect on a product that had deliberately moved past it.
//
// Then the real defect surfaced behind that one. migrate-outreach-partner-scope.js was excluded from
// the migrator chain as "back-fills partner scope over existing rows" — true, and silent about the
// schema it changes. So a database built by the migrator had NO outreach.partner_id, and the
// application's own setStatus upsert failed on it with `column "partner_id" does not exist`. Every
// green check in this repository had been run against a database where outreach was broken.
//
// THE LESSON THIS ENCODES. Both wrong answers came from asserting the SHAPE of the schema — this
// constraint, that index — instead of the BEHAVIOUR that depends on it. A shape assertion goes stale
// the moment a later migration deliberately changes it, and then it fails loudly while the product
// works, or passes quietly while the product does not. So what is asserted here is the upsert the
// application actually runs, taken from src/lib/outreach/index.js, executed against the migrated
// database. It cannot go stale without the application changing with it.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.OUTREACH_REPAIR_PGPORT || '55452';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;

function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/outreach-repair-');
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

// THE UPSERT, copied from src/lib/outreach/index.js. Not a paraphrase of it: if that query changes
// shape and this does not, the drift is the bug and this harness must be the thing that notices.
const APP_UPSERT = `
  INSERT INTO outreach (entity_type, entity_id, product, status, partner_id)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (entity_type, entity_id, COALESCE(partner_id, 0)) DO UPDATE SET
    status = EXCLUDED.status, updated_at = NOW()
  RETURNING id`;

async function createDb(base, name) {
  const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return `postgresql://postgres@localhost/${name}?host=${base}&port=${PGPORT}&sslmode=disable`;
}

// ONE CASE PER PROCESS, and this is not fastidiousness.
//
// src/lib/db creates its module-level Pool from DATABASE_URL the first time it is required, and 30 of
// the migrator's steps are marked `usesOwnPool: true` because they go through it rather than through
// the connection they are handed. Reassigning process.env.DATABASE_URL afterwards changes nothing: a
// second case in the same process migrates the FIRST case's database. The first version of this
// harness did that and reported "could not build the starting point" twice — the steps had run, just
// against the wrong database.
//
// So the parent starts the cluster and spawns one child per case, each with its own DATABASE_URL set
// before Node starts.
async function migrate(url) {
  process.env.DATABASE_URL = url;
  process.env.ADMIN_EMAIL = 'outreach-fixture@example.invalid';
  process.env.ADMIN_PASSWORD = require('crypto').randomBytes(18).toString('hex');
  const c = new Client({ connectionString: url });
  await c.connect();
  const q = (t, p) => c.query(t, p);
  const r = await require('../src/lib/migrate-all').runAll(q, { seeds: false, log: () => {} });
  return { c, q, r };
}

// Everything the behaviour depends on, asserted through the behaviour.
async function assertOutreachWorks(q, label) {
  const cols = (await q(`SELECT column_name FROM information_schema.columns
                          WHERE table_name='outreach'`)).rows.map((r) => r.column_name);
  if (cols.includes('partner_id')) ok(`${label}: outreach.partner_id exists`);
  else bad(`${label}: outreach has no partner_id`, 'the application reads and writes it on every status change');

  // 1. a staff record (partner_id NULL)
  let staffId = null;
  try {
    staffId = (await q(APP_UPSERT, ['prospect', '501', 'abiozen', 'contacted', null])).rows[0].id;
    ok(`${label}: the application's upsert inserts a staff record`);
  } catch (e) {
    bad(`${label}: the application's own upsert FAILS`, e.message.split('\n')[0]);
    return;
  }

  // 2. the same prospect again as staff — must UPDATE, not duplicate
  const again = (await q(APP_UPSERT, ['prospect', '501', 'abiozen', 'won', null])).rows[0].id;
  if (again === staffId) ok(`${label}: a second staff write updates in place, no duplicate`);
  else bad(`${label}: a second staff write created a new row`, `${staffId} → ${again}`);

  // 3. THE POINT OF THE PER-PARTNER KEY. A partner must be able to hold its own record for the same
  //    prospect. Under the old entity-only UNIQUE this write fails — which is exactly what the first
  //    fix would have reimposed, so it is asserted rather than assumed.
  const partner = (await q(`INSERT INTO partners (name) VALUES ('Fixture Partner')
                            ON CONFLICT DO NOTHING RETURNING id`)).rows[0]
    || (await q(`SELECT id FROM partners WHERE name='Fixture Partner'`)).rows[0];
  if (!partner) {
    bad(`${label}: could not create a fixture partner`, 'cannot test the per-partner key without one');
    return;
  }
  try {
    const pid = (await q(APP_UPSERT, ['prospect', '501', 'abiozen', 'contacted', partner.id])).rows[0].id;
    if (pid !== staffId) ok(`${label}: a partner holds its OWN record for the same prospect — the per-partner key works`);
    else bad(`${label}: the partner write overwrote the staff record`, 'both are meant to coexist');
  } catch (e) {
    bad(`${label}: a partner cannot hold a record for a prospect staff already touched`, e.message.split('\n')[0]);
  }

  // 4. and the old key must NOT be back, because it forbids exactly that
  const old = (await q(`SELECT 1 FROM pg_constraint WHERE conrelid='outreach'::regclass
                          AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (entity_type, entity_id)'`)).rows.length;
  if (!old) ok(`${label}: the entity-only UNIQUE is correctly absent`);
  else bad(`${label}: UNIQUE (entity_type, entity_id) is present`, 'it forbids the per-partner rows above');
}

// ── the child: run exactly one case against the DATABASE_URL it was given ─────────────────────────
async function runCase(which, url) {
  if (which === '1') {
    h('1. A FRESH DATABASE BUILT BY THE MIGRATOR — what a new deployment gets');
    const { c, q, r } = await migrate(url);
    if (r.ok) ok(`the migrator applied all ${r.steps.length} steps`);
    else bad(`${r.failed.length} step(s) failed`, r.failed.map((f) => `${f.name}: ${f.error}`).join(' | '));
    await assertOutreachWorks(q, 'fresh');
    await c.end();
    return;
  }

  if (which === '2') {
    h('2. A DATABASE FROM BEFORE PARTNER SCOPING — the migration must carry it forward');
    const { c, q, r } = await migrate(url);
    if (!r.ok) { bad('could not build the starting point', r.failed.map((f) => f.error).join(' | ')); await c.end(); return; }
    await q(`DROP INDEX IF EXISTS uq_outreach_entity_partner`);
    await q(`ALTER TABLE outreach DROP COLUMN IF EXISTS partner_id`);
    await q(`INSERT INTO outreach (entity_type, entity_id, product, status) VALUES
               ('prospect','1','abiozen','contacted'), ('prospect','2','abiozen','won')
             ON CONFLICT DO NOTHING`);
    await q(`ALTER TABLE outreach ADD CONSTRAINT outreach_entity_type_entity_id_key
             UNIQUE (entity_type, entity_id)`);
    const gone = (await q(`SELECT column_name FROM information_schema.columns
                            WHERE table_name='outreach' AND column_name='partner_id'`)).rows.length === 0;
    if (gone) ok('reverted to the pre-partner-scope shape: entity-only UNIQUE, no partner_id');
    else bad('could not revert the fixture to the pre-partner-scope shape');

    // THE BOOT CHECK MUST REFUSE THIS DATABASE. src/lib/schema-ready.js now lists
    // outreach.partner_id, because on 2026-11-06 it did not, and a server on a database in exactly
    // this state would have started, answered /health 200 with db: connected, and failed every
    // outreach status change — green from outside, broken in use, which is the 2026-09-30 shape.
    //
    // Asserted in the negative direction, against a database really missing the column. A boot guard
    // only ever run against a healthy schema is a guard nobody has watched refuse.
    const notReady = await require('../src/lib/schema-ready').check(q);
    if (notReady.ready === false && notReady.missingColumns.some((m) => /outreach\.partner_id/.test(m))) {
      ok('the boot readiness check REFUSES this database and names outreach.partner_id');
    } else {
      bad('the boot readiness check accepts a database where outreach cannot work',
        `ready=${notReady.ready} missingColumns=${JSON.stringify(notReady.missingColumns)}`);
    }

    const before = (await q(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    const again = await require('../src/lib/migrate-all').runAll(q, { seeds: false, log: () => {} });
    if (again.ok) ok(`the migrator carried it forward — all ${again.steps.length} steps`);
    else bad(`${again.failed.length} step(s) failed`, again.failed.map((f) => `${f.name}: ${f.error}`).join(' | '));

    const kept = (await q(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
    if (kept === before) ok(`all ${before} existing rows survived the key change`);
    else bad(`outreach went from ${before} to ${kept} rows`, 'the key change must not discard outreach records');

    await assertOutreachWorks(q, 'pre-partner-scope');
    await c.end();
    return;
  }

  h("3. PRODUCTION'S SHAPE — already partner-scoped, with rows; the migration must be a clean no-op");
  const { c, q, r } = await migrate(url);
  if (!r.ok) { bad('could not build the starting point', r.failed.map((f) => f.error).join(' | ')); await c.end(); return; }
  await q(`INSERT INTO outreach (entity_type, entity_id, product, status)
             SELECT 'prospect', g::text, 'abiozen', 'contacted' FROM generate_series(1, 159) g
           ON CONFLICT DO NOTHING`);
  const old = (await q(`SELECT COUNT(*)::int n FROM pg_constraint WHERE conrelid='outreach'::regclass
                         AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (entity_type, entity_id)'`)).rows[0].n;
  const before = (await q(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
  if (old === 0) ok(`reproduces production: ${before} outreach rows, partner-scoped, no entity-only UNIQUE`);
  else bad("the fixture still has the entity-only UNIQUE — not production's shape");

  const again = await require('../src/lib/migrate-all').runAll(q, { seeds: false, log: () => {} });
  if (again.ok) ok(`all ${again.steps.length} steps applied — it no longer halts on outreach`);
  else bad(`${again.failed.length} step(s) failed`, again.failed.map((f) => `${f.name}: ${f.error}`).join(' | '));

  const kept = (await q(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
  if (kept === before) ok(`all ${before} existing outreach rows survived`);
  else bad(`outreach went from ${before} to ${kept} rows`);

  await assertOutreachWorks(q, 'production-shaped');
  await c.end();
}

async function main() {
  // ── child mode ──────────────────────────────────────────────────────────────────────────────────
  const caseIdx = process.argv.indexOf('--case');
  if (caseIdx >= 0) {
    await runCase(process.argv[caseIdx + 1], process.env.DATABASE_URL);
    console.log(`__RESULT__ ${pass} ${fail}`);
    process.exit(fail ? 1 : 0);
  }

  h("OUTREACH — DOES THE APPLICATION'S OWN UPSERT WORK AFTER THE MIGRATION?");

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  for (const [which, name] of [['1', 'fresh_case'], ['2', 'legacy_case'], ['3', 'prod_case']]) {
    const url = await createDb(base, name);
    let out = '';
    try {
      out = execFileSync(process.execPath, [__filename, '--case', which], {
        encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, DATABASE_URL: url },
      });
    } catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; }
    const lines = out.split('\n');
    for (const l of lines) {
      if (/^__RESULT__ /.test(l)) {
        const [, p, f] = l.split(' ');
        pass += Number(p); fail += Number(f);
      } else if (l.trim()) console.log(l);
    }
    if (!/__RESULT__/.test(out)) {
      fail += 1;
      console.log(`  FAIL  case ${which} did not report a result — it crashed before finishing`);
      console.log(`          ${lines.filter(Boolean).slice(-3).join(' | ')}`);
    }
  }

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  outreach does not work after the migration on at least one real database shape.\n');
    stopCluster();
    process.exit(1);
  }
  console.log("\nPASS  the application's own outreach upsert works after the migration on a fresh database,\n" +
              "      on production's shape, and on one predating partner scoping — and a partner can hold\n" +
              '      its own record for a prospect our staff have already touched.\n');
}

// The explicit exit is load-bearing: src/lib/db opens a module-level Pool that nothing here can close,
// so stopping the cluster leaves it with a dead socket and it raises an unhandled 'error' AFTER the
// verdict is printed — an exit status that contradicts its own report.
main().then(() => {
  stopCluster();
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  stopCluster();
  console.error(`\nFAIL  harness error: ${e.message}`);
  process.exit(1);
});
