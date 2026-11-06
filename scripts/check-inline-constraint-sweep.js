// ── NEGATIVE CONTROLS FOR THE SKIPPED-CONSTRAINT SWEEP ─────────────────────────────────────────────
//
//   node scripts/check-inline-constraint-sweep.js ; echo $?
//
// check-skipped-inline-constraints.js exists to find the class of defect that halted the first real
// gate-2 run: a constraint declared inside `CREATE TABLE IF NOT EXISTS`, therefore never applied to a
// database where the table already existed. It reports 63 such declarations across 57 tables.
//
// A sweep is only worth the exit code it prints, and two failure modes would each make it worthless:
//
//   FALSE GREEN — it fails to notice a constraint that really is missing. Then it certifies a database
//     that will halt the migration anyway, which is strictly worse than not running it, because
//     somebody will have stopped looking.
//
//   FALSE RED — it reports a gap that is not one. The first version of the parser did exactly this,
//     inventing `UNIQUE (so)` and `UNIQUE (a)` out of English prose in SQL comments. Noise is not
//     harmless: a checker that cries wolf twice is a checker whose third verdict nobody reads, and
//     the whole reason this repository reads exit codes is that somebody once stopped.
//
// So both are provoked here, on purpose, against a real cluster:
//
//   1. a table with rows and a declared constraint it does not have — must be REPORTED, exit 1
//   2. the same table with the constraint present must be CLEAN, exit 0
//   3. a unique INDEX, not a constraint, must count as satisfying it — ON CONFLICT accepts either,
//      so flagging it would be a false red on a table somebody already fixed by hand
//   4. duplicate values must be reported as blocking, because that is the case where the repair
//      cannot be done without somebody deciding which row to discard
//
// And one more, learned the hard way in the same afternoon: a constraint a LATER migration drops on
// purpose must not be reported at all. That is why the subject here is content_queue and not the
// table that started this — see the note on the fixture below.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.SWEEP_PGPORT || '55458';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;

function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/sweep-control-');
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

function sweep(url) {
  try {
    const out = execFileSync(process.execPath,
      [`${__dirname}/check-skipped-inline-constraints.js`, '--against', url],
      { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

async function db(base, name, ddl) {
  const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = `postgresql://postgres@localhost/${name}?host=${base}&port=${PGPORT}&sslmode=disable`;
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(ddl);
  return { url, c };
}

// Only content_queue is created in each fixture. Every other declared table is absent, which the
// sweep reports as "the migration creates them" and not as a gap — so the verdict in each case is
// about content_queue alone, which is what makes these controls readable.
// WHY content_queue AND NOT outreach. outreach was the obvious subject — it is the table whose
// missing constraint halted gate 2 — and it is now the wrong one. migrate-outreach-partner-scope.js
// drops UNIQUE (entity_type, entity_id) on purpose, so the sweep correctly marks it SUPERSEDED and
// does not check for it. Using it here would assert that the sweep reports a gap it is right to
// ignore, which would pin the stale expectation in place with a test.
//
// content_queue declares UNIQUE (product, source_ref) in migrate-content-queue.js and nothing drops
// it, so it is a genuine instance of the class under test.
const CQ_NO_CONSTRAINT = `
  CREATE TABLE content_queue (
    id SERIAL PRIMARY KEY, product TEXT NOT NULL, source_ref TEXT NOT NULL, status TEXT);
  INSERT INTO content_queue (product, source_ref, status) VALUES
    ('abiozen','ref-1','queued'), ('abiozen','ref-2','queued');
`;

async function main() {
  h('NEGATIVE CONTROLS — CAN THE SKIPPED-CONSTRAINT SWEEP GO RED, AND STAY GREEN CORRECTLY?');

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  // ── 1. production's shape: the gap must be found ────────────────────────────────────────────────
  h("1. THE DEFECT'S SHAPE — a table with rows and a declared constraint it does not have");
  {
    const { url, c } = await db(base, 'sweep_gap', CQ_NO_CONSTRAINT);
    const r = sweep(url);
    if (r.code === 1) ok('exit 1 — the sweep goes red on the real defect');
    else bad(`exit ${r.code} — FALSE GREEN on the exact database that halted gate 2`, 'this is the failure mode that matters most');

    if (/content_queue — UNIQUE \(product, source_ref\)/.test(r.out)) ok('it names the table and the exact column set');
    else bad('it does not name content_queue / (product, source_ref)', r.out.trim().split('\n').slice(-5).join(' | '));

    if (/2 row\(s\) in the table/.test(r.out)) ok('it reports how many rows are at stake');
    else bad('it does not report the row count');

    if (/can be added safely with ALTER TABLE/.test(r.out)) ok('with no duplicate values, it says the repair is safe');
    else bad('it does not say the repair is safe', r.out.trim().split('\n').slice(-5).join(' | '));

    await c.end();
  }

  // ── 2. constraint present: must be clean ───────────────────────────────────────────────────────
  h('2. THE SAME TABLE WITH THE CONSTRAINT — must be clean');
  {
    const { url, c } = await db(base, 'sweep_ok',
      `${CQ_NO_CONSTRAINT} ALTER TABLE content_queue ADD CONSTRAINT u UNIQUE (product, source_ref);`);
    const r = sweep(url);
    if (r.code === 0) ok('exit 0 — no gap reported');
    else bad(`exit ${r.code} — FALSE RED on a correct database`, r.out.trim().split('\n').slice(-5).join(' | '));

    if (/every inline UNIQUE declared for a table that exists here is present/.test(r.out)) ok('it says so explicitly');
    else bad('it does not report the clean result clearly');

    await c.end();
  }

  // ── 3. a unique INDEX, not a constraint ────────────────────────────────────────────────────────
  h('3. A UNIQUE INDEX RATHER THAN A CONSTRAINT — ON CONFLICT accepts it, so it is not a gap');
  {
    const { url, c } = await db(base, 'sweep_index',
      `${CQ_NO_CONSTRAINT} CREATE UNIQUE INDEX ix ON content_queue (product, source_ref);`);
    const r = sweep(url);
    if (r.code === 0) ok('exit 0 — a unique index satisfies the declaration');
    else bad(`exit ${r.code} — FALSE RED: a unique index does support ON CONFLICT`, r.out.trim().split('\n').slice(-5).join(' | '));

    // Proof the premise is right, rather than taken on trust: the upsert must actually work here.
    try {
      await c.query(`INSERT INTO content_queue (product, source_ref, status)
                     VALUES ('abiozen','ref-1','done')
                     ON CONFLICT (product, source_ref) DO UPDATE SET status = EXCLUDED.status`);
      ok('…and the ON CONFLICT upsert really does work against a bare unique index');
    } catch (e) {
      bad('the upsert fails against a unique index — then the sweep SHOULD flag it', e.message);
    }

    await c.end();
  }

  // ── 4. duplicates: reported as blocking ────────────────────────────────────────────────────────
  h('4. DUPLICATE VALUES — the repair needs a human decision, and must be reported as such');
  {
    const { url, c } = await db(base, 'sweep_dupes', `
      CREATE TABLE content_queue (
        id SERIAL PRIMARY KEY, product TEXT NOT NULL, source_ref TEXT NOT NULL, status TEXT);
      INSERT INTO content_queue (product, source_ref, status) VALUES
        ('abiozen','ref-1','queued'), ('abiozen','ref-1','done');
    `);
    const r = sweep(url);
    if (r.code === 1) ok('exit 1');
    else bad(`exit ${r.code} — a table that cannot take the constraint was passed`);

    if (/duplicate group\(s\)/.test(r.out) && /decides which row survives/.test(r.out)) {
      ok('it reports the duplicates as blocking and says the decision is a human one');
    } else {
      bad('it does not distinguish a blocked repair from a safe one', r.out.trim().split('\n').slice(-6).join(' | '));
    }

    if (!/can be added safely/.test(r.out)) ok('it does NOT claim the repair is safe');
    else bad('it claims the repair is safe while duplicates exist — this would be acted on, and fail');

    await c.end();
  }

  // ── 5. a constraint a later migration drops ON PURPOSE ─────────────────────────────────────────
  h('5. A SUPERSEDED CONSTRAINT — dropped by design, so it must not be reported at all');
  {
    // This is the control for the mistake that produced two wrong answers in one afternoon. The
    // sweep's first version called outreach's absent entity-only UNIQUE a gap. It is not: partner
    // scoping drops it so a partner and our staff can each hold a record for the same prospect, and
    // adding it back would break the product. Flagging it would have pinned a stale schema
    // expectation in place with a checker, which is how the original defect survived in the first
    // place — a verification that outlived the design it was written against.
    const { url, c } = await db(base, 'sweep_superseded', `
      -- No partners table, and partner_id carries no foreign key: a hand-rolled partners here would
      -- be missing ITS OWN declared constraints, and the sweep would correctly flag those — a gap
      -- belonging to the fixture, reported as though the subject under test had failed.
      CREATE TABLE outreach (
        id SERIAL PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        product TEXT NOT NULL, status TEXT NOT NULL, partner_id INTEGER);
      CREATE UNIQUE INDEX uq_outreach_entity_partner
        ON outreach (entity_type, entity_id, COALESCE(partner_id, 0));
      INSERT INTO outreach (entity_type, entity_id, product, status) VALUES
        ('prospect','1','abiozen','contacted');
    `);
    const r = sweep(url);
    if (r.code === 0) ok('exit 0 — a constraint dropped by design is not reported as missing');
    else bad(`exit ${r.code} — FALSE RED on a correct, deliberately-superseded schema`,
      'adding this constraint back would forbid the per-partner records the product needs');

    if (/superseded/i.test(r.out)) ok('it says explicitly that the constraint is superseded');
    else bad('it does not explain why the constraint is absent', r.out.trim().split('\n').slice(-4).join(' | '));

    // And the premise: the per-partner key is what the application actually conflicts on.
    try {
      await c.query(`INSERT INTO outreach (entity_type, entity_id, product, status, partner_id)
                     VALUES ('prospect','1','abiozen','won', 1)
                     ON CONFLICT (entity_type, entity_id, COALESCE(partner_id, 0))
                     DO UPDATE SET status = EXCLUDED.status`);
      const n = (await c.query(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
      if (n === 2) ok('a partner record coexists with the staff record — which the old constraint would forbid');
      else bad(`expected 2 rows (staff + partner), found ${n}`);
    } catch (e) {
      bad('the per-partner upsert does not work on this fixture', e.message.split('\n')[0]);
    }

    await c.end();
  }

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the sweep cannot be trusted to report what it claims to report.\n');
    process.exit(1);
  }
  console.log('\nPASS  the sweep goes red on the real defect, stays green on a correct database,\n' +
              '      accepts a unique index, and separates a safe repair from one needing a decision.\n');
}

main().then(() => { stopCluster(); }).catch((e) => {
  stopCluster();
  console.error(`\nFAIL  harness error: ${e.message}`);
  process.exit(1);
});
