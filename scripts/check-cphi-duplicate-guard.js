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
//   2. duplicates present      → REFUSED, naming every group, CHANGING NOTHING
//   3. no flag can make it delete — the migration has no DELETE statement at all
//   4. two human-touched rows  → named a CONFLICT, with a query for inspecting them
//   5. the sweep PREDICTS this class instead of discovering it one production dump at a time
//
// Reconciliation itself lives in scripts/cphi-reconcile.js and is covered by
// scripts/check-cphi-reconcile.js: plan determinism, human work carried across rather than lost,
// conflicts flagged, an audit row holding the complete prior contents of everything touched, refusal
// on drift, and a second run that changes nothing.
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

    if (/cannot delete anything/.test(r.out) && /Nothing has been changed/.test(r.out)) {
      ok('it says plainly that it cannot delete and that nothing was changed');
    } else {
      bad('it does not say it is refusing', r.out.trim().split('\n').slice(-4).join(' | '));
    }

    if (/cphi-milan-2026 \/ alpha — 2 rows/.test(r.out)) ok('it names the duplicate group and the row count');
    else bad('it does not name the duplicate group', r.out.trim().split('\n').slice(-6).join(' | '));

    if (/cphi-reconcile\.js/.test(r.out)) ok('it names the one tool that can reconcile');
    else bad('it does not say how to proceed', r.out.trim().split('\n').slice(-4).join(' | '));

    if (await rowCount(c) === 3) ok('all 3 rows still there — nothing was deleted');
    else bad(`it deleted rows without being asked: 3 → ${await rowCount(c)}`);
    if (!(await idxPresent(c))) ok('no index was created');
    else bad('it created the index despite duplicates');
    await c.end();
  }

  // ── 3. the migration cannot delete, with any flag ──────────────────────────────────────────────
  h('3. THE MIGRATION HAS NO DELETE PATH — refused even when asked, by any flag');
  {
    // An earlier version took --resolve-duplicates and did the cleanup itself. It worked, and it was
    // still the wrong shape: two destructive paths for one table, and the one nobody reads is the one
    // that runs. Reconciliation now lives in cphi-reconcile.js, with a plan, an audit trail and a
    // drift check. This asserts the migration cannot be talked into deleting a row.
    const src = fs.readFileSync(path.join(__dirname, 'migrate-cphi-exhibitors.js'), 'utf8');
    if (!/DELETE\s+FROM/i.test(src)) ok('migrate-cphi-exhibitors.js contains no DELETE statement at all');
    else bad('the migration can still delete rows', 'there must be exactly one destructive path, and it is cphi-reconcile.js');
    if (!/--resolve-duplicates/.test(src.replace(/\/\/.*$/gm, ''))) ok('the --resolve-duplicates flag is gone from its code');
    else bad('the migration still accepts --resolve-duplicates');

    const { url, c } = await db(base, 'cphi_noflag', `${TABLE}
      ${ins('cphi-milan-2026', 'alpha', { ageDays: 9 })}
      ${ins('cphi-milan-2026', 'alpha', { ageDays: 1 })}
      ${ins('cphi-milan-2026', 'beta')}`);

    // Every flag a person might reach for, including the one that used to work.
    for (const flags of [[], ['--resolve-duplicates'], ['--force'], ['--yes']]) {
      const r = runMigration(url, flags);
      const label = flags.length ? flags.join(' ') : '(no flags)';
      if (r.code !== 0) ok(`refused with ${label} — exit ${r.code}`);
      else bad(`migration exited 0 with ${label}`, 'it indexed or deleted something it should not have');
    }
    if (await rowCount(c) === 3) ok('all 3 rows still there after four attempts');
    else bad(`rows were deleted: 3 → ${await rowCount(c)}`);
    if (!(await idxPresent(c))) ok('no index was created');
    else bad('the index was created despite duplicates');

    const r = runMigration(url);
    if (/cphi-reconcile\.js/.test(r.out)) ok('it points at the one tool that can reconcile');
    else bad('it does not say how to proceed', r.out.trim().split('\n').slice(-4).join(' | '));
    await c.end();
  }

  // ── 4. a conflict is still named as a conflict ─────────────────────────────────────────────────
  h('4. TWO DIFFERENT NOTES IN ONE GROUP — named a CONFLICT, with a query to inspect them');
  {
    // Under ruling 38 option 2 the only human-authored field is entity_note, so a conflict needs TWO
    // DIFFERENT NOTES. A review_status beside a note is no longer a conflict: review_status is
    // machine-assigned here, and escalating it asked a person to adjudicate between a sentence they
    // wrote and a label a script applied.
    const { url, c } = await db(base, 'cphi_conflict', `${TABLE}
      ${ins('cphi-milan-2026', 'alpha', { note: 'spoke to them at the stand' })}
      ${ins('cphi-milan-2026', 'alpha', { note: 'emailed instead, no reply' })}
      ${ins('cphi-milan-2026', 'beta')}`);

    const r = runMigration(url);
    if (r.code !== 0) ok(`refused — exit ${r.code}`);
    else bad('migration exited 0 on an unindexable table');

    if (/CONFLICT/.test(r.out)) ok('it labels the group a CONFLICT');
    else bad('it does not distinguish a conflict from a safe group', r.out.trim().split('\n').slice(-5).join(' | '));

    if (/SELECT id, event_slug/.test(r.out)) ok('it hands over a query for inspecting the conflicting rows');
    else bad('it does not show how to look at them');

    // ── THE HALT MUST NAME THE REASON, NOT THE DIAGNOSTIC SQL ───────────────────────────────────
    //
    // src/lib/migrate-all.js used to report a failing step as its last four output lines. This step
    // explains itself and THEN prints a SELECT for the owner to run, so on 2026-11-06 the halt he
    // was shown was the SQL, and the line saying why was four lines above it and discarded. A
    // migration that stops has one job in its error message: say what to do next.
    const { runAll } = require('../src/lib/migrate-all');
    void runAll;
    const asStep = await (async () => {
      try {
        execFileSync(process.execPath, [path.join(__dirname, 'migrate-cphi-exhibitors.js')], {
          env: { ...process.env, DATABASE_URL: url,
            ADMIN_EMAIL: 'guard@example.invalid',
            ADMIN_PASSWORD: require('crypto').randomBytes(12).toString('hex') },
          encoding: 'utf8', stdio: 'pipe',
        });
        return null;
      } catch (e) {
        // Reproduce exactly what runScript does with the output.
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
        const isSql = (l) => /^(SELECT|FROM|WHERE|ORDER BY|GROUP BY|HAVING|AND|OR|\()/i.test(l) || /;$/.test(l);
        const marked = lines.filter((l) => /^(❌|⚠️|REFUSING)/.test(l) || /\b(cannot|refus)/i.test(l));
        const chosen = (marked.length ? marked : lines.filter((l) => !isSql(l))).slice(-4);
        return (chosen.length ? chosen : lines.slice(-4)).join(' | ');
      }
    })();
    if (asStep && !/^\s*SELECT /i.test(asStep)) ok('the halt message leads with the reason, not a SELECT');
    else bad('the halt message is still SQL', String(asStep).slice(0, 160));
    if (asStep && /note|conflict|cannot delete/i.test(asStep)) ok('…and the reason is legible without the full log');
    else bad('the halt message does not explain itself', String(asStep).slice(0, 160));

    // ── THE TWO TOOLS MUST AGREE ON WHAT NEEDS A HUMAN ─────────────────────────────────────────
    //
    // The migration counted ROWS CARRYING A NOTE; cphi-reconcile.js counts DISTINCT notes. A group
    // whose duplicates shared the same note was therefore a conflict in one tool and reconcilable in
    // the other, so the owner got a different answer depending on which he ran.
    const { url: uSame, c: cSame } = await db(base, 'cphi_agree', `${TABLE}
      ${ins('cphi-milan-2026', 'zeta', { note: 'same note on both rows' })}
      ${ins('cphi-milan-2026', 'zeta', { note: 'same note on both rows' })}
      ${ins('cphi-milan-2026', 'beta')}`);
    let planOut = `${temp.base}/agree.json`;
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'cphi-reconcile.js'), '--plan-out', planOut],
        { env: { ...process.env, DATABASE_URL: uSame }, encoding: 'utf8', stdio: 'pipe' });
    } catch { /* exit 1 is expected: duplicates exist */ }
    const agreePlan = JSON.parse(fs.readFileSync(planOut, 'utf8'));
    const zeta = agreePlan.groups.find((x) => x.holder_normalized === 'zeta');
    const migOut = runMigration(uSame);
    const migCallsItConflict = /CONFLICT\s+cphi-milan-2026 \/ zeta|zeta[^\n]*\n?[^\n]*CONFLICT/.test(migOut.out)
      || /CONFLICT.*zeta/.test(migOut.out);
    const reconcileCallsItConflict = zeta.classification === 'CONFLICT';
    if (migCallsItConflict === reconcileCallsItConflict) {
      ok(`both tools agree on an identical-note group (conflict=${reconcileCallsItConflict})`);
    } else {
      bad('the migration and the reconciliation tool disagree about the same group',
        `migration says conflict=${migCallsItConflict}, reconcile says conflict=${reconcileCallsItConflict}`);
    }
    await cSame.end();

    if (await rowCount(c) === 3) ok('all 3 rows still there');
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
