// ── A UNIQUE INDEX ON A TABLE THAT ALREADY HOLDS DUPLICATES ────────────────────────────────────────
//
//   node scripts/check-cphi-duplicate-guard.js ; echo $?
//
// WHAT HAPPENED. The production-dump verification, finally running the right code (53 steps), halted
// on a different step:
//
//     cphi exhibitors: CPHI migration error: could not create unique index "idx_cem_unique"
//
// That is Postgres saying `cphi_exhibitor_matches` already contains duplicate
// (event_slug, holder_normalized) pairs. The index has never existed on production, so nothing ever
// stopped them accumulating — and because the statement was bundled into the same multi-statement
// query as the CREATE TABLE, the failure took the whole step down and named the index rather than a
// single row anybody could act on.
//
// THIS IS A DIFFERENT DEFECT CLASS FROM ENG-004, and worse in one respect. An inline constraint on an
// existing table is silently SKIPPED — the migration passes and the guarantee is quietly absent. A
// standalone CREATE UNIQUE INDEX on a table holding duplicates FAILS LOUDLY and halts the chain. The
// first is a lie; the second is a wall. The sweep built for the first did not look for the second,
// and reported "no constraint declared inline is missing from this database" on the same run that
// then hit this wall. Nine standalone unique indexes exist, on tables that all hold production rows.
//
// WHY THE MIGRATION DOES NOT JUST DEDUPLICATE. Two columns carry human work: `review_status`
// (anything but 'unreviewed' is somebody's decision) and `entity_note` (free text). The rest of the
// row is derived from a search and recomputable. A migration that picked a survivor on its own could
// discard a review, and no later run could tell that it had.
//
// So three behaviours are asserted here, and the second is the one that matters most:
//
//   1. no duplicates           → the index is created, nothing is touched
//   2. duplicates present      → REFUSED by default, naming every group, CHANGING NOTHING
//   3. two human-touched rows  → refused even WITH --resolve-duplicates, because that is a conflict
//                                only a person can settle
//
// and then that --resolve-duplicates, on groups where it cannot lose human work, keeps the right row
// and deletes the rest BY ID — never by pattern or timestamp, which is the rule the 2026-09-30
// ten-minute DELETE broke.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.CPHI_GUARD_PGPORT || '55481';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;

function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/cphiguard-');
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

// Production's shape: the table WITHOUT idx_cem_unique, holding duplicate pairs. entity_note is
// present because migrate-cphi-entity-note.js has run there.
const TABLE = `
  CREATE TABLE cphi_exhibitor_matches (
    id                BIGSERIAL PRIMARY KEY,
    event_slug        TEXT NOT NULL,
    holder            TEXT NOT NULL,
    holder_normalized TEXT NOT NULL,
    exhibiting        BOOLEAN NOT NULL DEFAULT false,
    exhibitor_name    TEXT,
    booth             TEXT,
    hall              TEXT,
    match_tier        TEXT,
    molecules_covered INTEGER NOT NULL DEFAULT 0,
    review_status     TEXT NOT NULL DEFAULT 'unreviewed',
    searched_terms    TEXT,
    checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    entity_note       TEXT
  );
`;

const ins = (slug, norm, opts = {}) => `INSERT INTO cphi_exhibitor_matches
  (event_slug, holder, holder_normalized, review_status, entity_note, checked_at, molecules_covered)
  VALUES ('${slug}', '${norm}', '${norm}', '${opts.review || 'unreviewed'}',
          ${opts.note ? `'${opts.note}'` : 'NULL'},
          NOW() - INTERVAL '${opts.ageDays || 0} days', ${opts.mols || 0});`;

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

function runMigration(url, extraArgs = []) {
  const args = [path.join(__dirname, 'migrate-cphi-exhibitors.js'), ...extraArgs];
  try {
    const out = execFileSync(process.execPath, args, {
      env: {
        ...process.env,
        DATABASE_URL: url,
        ADMIN_EMAIL: 'cphi-guard-fixture@example.invalid',
        ADMIN_PASSWORD: require('crypto').randomBytes(16).toString('hex'),
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const idxPresent = async (c) => (await c.query(
  `SELECT COUNT(*)::int n FROM pg_indexes WHERE indexname = 'idx_cem_unique'`)).rows[0].n > 0;
const rowCount = async (c) => (await c.query(`SELECT COUNT(*)::int n FROM cphi_exhibitor_matches`)).rows[0].n;

async function main() {
  h('CPHI — A UNIQUE INDEX ON A TABLE THAT ALREADY HOLDS DUPLICATES');

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  // ── 1. no duplicates ───────────────────────────────────────────────────────────────────────────
  h('1. NO DUPLICATES — the index must simply be created');
  {
    const { url, c } = await db(base, 'cphi_clean',
      `${TABLE}${ins('cphi-milan-2026', 'alpha')}${ins('cphi-milan-2026', 'beta')}${ins('cphi-frankfurt-2027', 'alpha')}`);
    if (!(await idxPresent(c))) ok('fixture reproduces production: table present, idx_cem_unique absent');
    else bad('the fixture already has the index');

    const r = runMigration(url);
    if (r.code === 0) ok('migration exit 0');
    else bad(`migration failed (exit ${r.code})`, r.out.trim().split('\n').slice(-3).join(' | '));

    if (await idxPresent(c)) ok('idx_cem_unique created');
    else bad('the index was not created', r.out.trim().split('\n').slice(-3).join(' | '));

    if (await rowCount(c) === 3) ok('all 3 rows untouched');
    else bad(`row count changed to ${await rowCount(c)}`);
    await c.end();
  }

  // ── 2. duplicates, no human work — must REFUSE by default ──────────────────────────────────────
  h('2. DUPLICATES PRESENT — refused by default, and NOTHING is changed');
  {
    const { url, c } = await db(base, 'cphi_dupes',
      `${TABLE}${ins('cphi-milan-2026', 'alpha', { ageDays: 5 })}${ins('cphi-milan-2026', 'alpha', { ageDays: 1 })}${ins('cphi-milan-2026', 'beta')}`);
    const r = runMigration(url);
    if (r.code !== 0) ok(`refused — exit ${r.code}`);
    else bad('migration exited 0 on a table it could not index — this is the false green');

    if (/REFUSING to delete/.test(r.out)) ok('it says plainly that it is refusing to delete');
    else bad('it does not say it is refusing', r.out.trim().split('\n').slice(-4).join(' | '));

    if (/cphi-milan-2026 \/ alpha — 2 rows/.test(r.out)) ok('it names the duplicate group and the row count');
    else bad('it does not name the duplicate group', r.out.trim().split('\n').slice(-6).join(' | '));

    if (/--resolve-duplicates/.test(r.out)) ok('it names the flag that would resolve it');
    else bad('it does not say how to proceed');

    if (await rowCount(c) === 3) ok('all 3 rows still there — nothing was deleted');
    else bad(`it deleted rows without being asked: 3 → ${await rowCount(c)}`);
    if (!(await idxPresent(c))) ok('no index was created');
    else bad('it created the index despite duplicates');
    await c.end();
  }

  // ── 3. --resolve-duplicates on a safe group ────────────────────────────────────────────────────
  h('3. WITH --resolve-duplicates — keeps the reviewed row, deletes the rest BY ID');
  {
    // Two duplicate groups. In the first, one row is reviewed and must survive even though it is the
    // OLDER one — so "keep the newest" alone would be wrong, and this proves the human row wins.
    const { url, c } = await db(base, 'cphi_resolve', `${TABLE}
      ${ins('cphi-milan-2026', 'alpha', { ageDays: 9, review: 'confirmed' })}
      ${ins('cphi-milan-2026', 'alpha', { ageDays: 1 })}
      ${ins('cphi-milan-2026', 'gamma', { ageDays: 7 })}
      ${ins('cphi-milan-2026', 'gamma', { ageDays: 2 })}
      ${ins('cphi-milan-2026', 'beta')}`);

    const reviewedId = (await c.query(
      `SELECT id FROM cphi_exhibitor_matches WHERE review_status = 'confirmed'`)).rows[0].id;
    const newestGamma = (await c.query(
      `SELECT id FROM cphi_exhibitor_matches WHERE holder_normalized = 'gamma'
        ORDER BY checked_at DESC LIMIT 1`)).rows[0].id;

    const r = runMigration(url, ['--resolve-duplicates']);
    if (r.code === 0) ok('migration exit 0');
    else bad(`migration failed (exit ${r.code})`, r.out.trim().split('\n').slice(-4).join(' | '));

    if (await idxPresent(c)) ok('idx_cem_unique created');
    else bad('the index was still not created');

    if (await rowCount(c) === 3) ok('5 rows → 3: exactly the 2 redundant rows removed');
    else bad(`expected 3 rows, found ${await rowCount(c)}`);

    const survivors = (await c.query(`SELECT id FROM cphi_exhibitor_matches ORDER BY id`)).rows.map((x) => Number(x.id));
    if (survivors.includes(Number(reviewedId))) ok('the REVIEWED row survived, though it was the older one');
    else bad('the reviewed row was deleted', `survivors ${survivors.join(', ')}, reviewed was ${reviewedId}`);
    if (survivors.includes(Number(newestGamma))) ok('with no review in a group, the most recently checked row survived');
    else bad('the wrong row survived in the un-reviewed group');

    if (/by id/.test(r.out)) ok('it reports deleting by id');
    else bad('it does not say the deletes were by id');
    await c.end();
  }

  // ── 4. a real conflict — refused even WITH the flag ────────────────────────────────────────────
  h('4. TWO HUMAN-TOUCHED ROWS IN ONE GROUP — refused even with --resolve-duplicates');
  {
    const { url, c } = await db(base, 'cphi_conflict', `${TABLE}
      ${ins('cphi-milan-2026', 'alpha', { review: 'confirmed' })}
      ${ins('cphi-milan-2026', 'alpha', { note: 'spoke to them at the stand' })}
      ${ins('cphi-milan-2026', 'beta')}`);

    const r = runMigration(url, ['--resolve-duplicates']);
    if (r.code !== 0) ok(`refused even with the flag — exit ${r.code}`);
    else bad('it resolved a group holding two human-touched rows', 'one person\'s review or note was discarded');

    if (/CONFLICT/.test(r.out)) ok('it labels the group a CONFLICT');
    else bad('it does not distinguish a conflict from a safe group', r.out.trim().split('\n').slice(-5).join(' | '));

    if (/SELECT id, event_slug/.test(r.out)) ok('it hands over a query for inspecting the conflicting rows');
    else bad('it does not show how to look at them');

    if (await rowCount(c) === 3) ok('all 3 rows still there — nothing was deleted');
    else bad(`it deleted rows in a conflict: 3 → ${await rowCount(c)}`);
    await c.end();
  }

  // ── 5. the sweep must PREDICT this, not discover it ────────────────────────────────────────────
  h('5. THE SWEEP MUST REPORT THIS BEFORE THE MIGRATION HITS IT');
  {
    const { url, c } = await db(base, 'cphi_sweep',
      `${TABLE}${ins('cphi-milan-2026', 'alpha')}${ins('cphi-milan-2026', 'alpha')}`);
    let out = ''; let code = 0;
    try {
      out = execFileSync(process.execPath,
        [path.join(__dirname, 'check-skipped-inline-constraints.js'), '--against', url],
        { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) { code = e.status === undefined ? 1 : e.status; out = `${e.stdout || ''}${e.stderr || ''}`; }

    if (code === 1) ok('the sweep goes red on a standalone unique index that cannot be created');
    else bad(`the sweep exited ${code} — it still misses this class`,
      'it reported "no constraint declared inline is missing" on the run that then halted here');

    if (/idx_cem_unique\s+ON cphi_exhibitor_matches/.test(out)) ok('it names the index and table');
    else bad('it does not name idx_cem_unique', out.trim().split('\n').slice(-6).join(' | '));

    if (/duplicate group\(s\) among/.test(out)) ok('it reports how many duplicate groups, among how many rows');
    else bad('it does not quantify the problem');

    if (/HALTS its migration step/.test(out)) ok('it says what the consequence is');
    else bad('it does not say the migration will halt');
    await c.end();
  }

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the duplicate guard is not safe.\n');
    stopCluster();
    process.exit(1);
  }
  console.log('\nPASS  the index is created where it can be, refused — touching nothing — where it cannot,\n'
    + '      and refused even when asked where resolving it would discard somebody\'s review or note.\n'
    + '      The sweep now predicts this class instead of discovering it one dump at a time.\n');
}

main().then(() => {
  stopCluster();
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  stopCluster();
  console.error(`\nFAIL  harness error: ${e.message}`);
  process.exit(1);
});
