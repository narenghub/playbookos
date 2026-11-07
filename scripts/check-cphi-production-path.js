// ── THE PRODUCTION RECONCILIATION PATH, ATTACKED ──────────────────────────────────────────────────
//
//   node scripts/check-cphi-production-path.js ; echo $?
//
// Ruling 44 item 8: *"Build adversarial regression tests covering wrong database, stale plan,
// changed rows, altered plan, unresolved conflicts, missing audit, repeated execution, partial
// failure, and unauthorized invocation."*
//
// `--apply-to-production` is the only code in this repository authorized to delete production rows.
// Every other destructive path was removed on purpose. So the question this file answers is not
// "does it work" — the happy path is one assertion among forty — but "what does it do when the
// situation is not the one it was reviewed for". Each refusal below is provoked against a real
// cluster, and each one is checked for TWO things: that it exited non-zero, and that it changed
// nothing. A guard that refuses after deleting a row is not a guard.
//
// WHY A SEPARATE FILE FROM check-cphi-reconcile.js. That one proves the reconciliation is auditable,
// repeatable and recoverable — properties of the operation. This one proves the gate in front of it
// cannot be talked past. Mixing them would mean a failure in either reading as a failure in both.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { pgBinCandidates, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.CPHIPROD_PGPORT || '55489';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;
const sh = (cmd) => execFileSync('sh', ['-c', temp.asPostgres
  ? `su postgres -c ${JSON.stringify(`PATH=${temp.dir}:$PATH ${cmd}`)}` : cmd],
{ env: { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` }, encoding: 'utf8', stdio: 'pipe' });

function startCluster() {
  const dir = pgBinCandidates()[0];
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/cphiprod-');
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

const TABLE = `
  CREATE TABLE cphi_exhibitor_matches (
    id                BIGSERIAL PRIMARY KEY,
    event_slug        TEXT NOT NULL,
    holder            TEXT NOT NULL,
    holder_normalized TEXT NOT NULL,
    exhibiting        BOOLEAN NOT NULL DEFAULT false,
    exhibitor_name    TEXT, booth TEXT, hall TEXT, match_tier TEXT,
    molecules_covered TEXT, review_status TEXT NOT NULL DEFAULT 'unreviewed',
    searched_terms    TEXT, checked_at TIMESTAMPTZ DEFAULT NOW(),
    entity_note       TEXT
  );`;

// Two clean duplicate groups: one where a single row carries the human note (so it survives), one
// where neither does (so the newest derived row survives). No conflicts — conflicts get their own
// database, because a conflict refuses the whole run and would mask everything after it.
const CLEAN = `
  INSERT INTO cphi_exhibitor_matches
    (event_slug, holder, holder_normalized, exhibiting, review_status, entity_note, match_tier) VALUES
    ('cphi-2026','Alpha Pharma','alpha pharma', true,  'entity_review', 'holder is Alpha SA', 't1'),
    ('cphi-2026','Alpha Pharma','alpha pharma', true,  'unreviewed',    NULL,                 't2'),
    ('cphi-2026','Beta Labs',   'beta labs',    false, 'unreviewed',    NULL,                 't2'),
    ('cphi-2026','Beta Labs',   'beta labs',    true,  'auto_confirmed',NULL,                 't1'),
    ('cphi-2026','Gamma Only',  'gamma only',   true,  'unreviewed',    NULL,                 't1');`;

// Two DISTINCT human notes in one group — nothing can settle which is right.
const CONFLICTED = `
  INSERT INTO cphi_exhibitor_matches
    (event_slug, holder, holder_normalized, exhibiting, review_status, entity_note, match_tier) VALUES
    ('cphi-2026','Delta Inc','delta inc', true,  'entity_review', 'holder is Delta GmbH', 't1'),
    ('cphi-2026','Delta Inc','delta inc', false, 'entity_review', 'holder is Delta Srl',  't2');`;

async function db(base, name, ddl) {
  const admin = new Client({ connectionString: `postgresql://postgres@localhost/postgres?host=${base}&port=${PGPORT}&sslmode=disable` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = `postgresql://postgres@localhost/${name}?host=${base}&port=${PGPORT}&sslmode=disable`;
  const c = new Client({ connectionString: url });
  await c.connect();
  if (ddl) await c.query(ddl);
  return { url, c };
}

// ── A CLEAN CHECKOUT TO RUN THE PRODUCTION PATH FROM (ruling 46 item 2) ───────────────────────────
//
// A production apply refuses from a tree with modified tracked files, because then the logic that
// built the reviewed plan and the logic about to delete rows are not provably the same code. That
// refusal is correct and it means this harness cannot exercise the authorized path from a working
// tree mid-change — which is most of the time, since preflight runs before the commit.
//
// The answer is not a bypass flag. It is to give it what it asks for: a real git checkout, clean,
// containing the code under test. Clone HEAD, overlay the working tree, commit that as one snapshot,
// and symlink node_modules so src/lib/db can still require pg. The clone's SHA differs from HEAD's
// by design — what is asserted is that a CLEAN checkout is accepted, not which commit it is.
const ROOT = path.join(__dirname, '..');
function snapshotCheckout(label, { dirty = false } = {}) {
  const dest = `${temp.base}/co-${label}`;
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: 'pipe' });
  git('clone', '--local', '--no-hardlinks', '--quiet', ROOT, dest);
  execFileSync('sh', ['-c',
    `cd ${JSON.stringify(ROOT)} && tar -cf - --exclude=./.git --exclude=./node_modules . `
    + `| (cd ${JSON.stringify(dest)} && tar -xf -)`], { stdio: 'pipe' });
  git('-C', dest, 'add', '-A');
  git('-C', dest, '-c', 'user.email=harness@example.invalid', '-c', 'user.name=harness',
    'commit', '-q', '-m', 'harness snapshot', '--allow-empty');
  try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dest, 'node_modules')); } catch { /* exists */ }
  if (dirty) {
    // Modify a TRACKED file, which is what the refusal is about. `dirty` may name which one, so
    // ruling 47 item 4 can be asserted for files OTHER than the script itself — the guard is
    // repo-wide, and a change to src/lib/db.js or to the dependency lock is just as relevant to
    // reconciliation as a change to the script.
    const target = typeof dirty === 'string' ? dirty : 'package.json';
    fs.appendFileSync(path.join(dest, target), '\n');
  }
  return {
    script: path.join(dest, 'scripts', 'cphi-reconcile.js'),
    sha: git('-C', dest, 'rev-parse', 'HEAD').trim(),
  };
}

function reconcile(url, args = [], extraEnv = {}, script = null) {
  try {
    const out = execFileSync(process.execPath, [script || path.join(__dirname, 'cphi-reconcile.js'), ...args],
      { env: { ...process.env, DATABASE_URL: url, RECONCILE_ACTOR: 'harness@example.invalid', ...extraEnv },
        encoding: 'utf8', stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const rowCount = async (c) => (await c.query(`SELECT COUNT(*)::int n FROM cphi_exhibitor_matches`)).rows[0].n;
const dupGroups = async (c) => (await c.query(
  `SELECT COUNT(*)::int n FROM (SELECT 1 FROM cphi_exhibitor_matches
     GROUP BY event_slug, holder_normalized HAVING COUNT(*) > 1) d`)).rows[0].n;

// Every refusal is checked the same way: non-zero exit AND an untouched table.
async function refusal(label, c, res, mustSay) {
  const before = refusal.before;
  const after = await rowCount(c);
  if (res.code === 0) { bad(`${label} — EXITED 0; it was allowed`); return; }
  if (after !== before) { bad(`${label} — refused (exit ${res.code}) but the table changed`, `${before} rows before, ${after} after`); return; }
  if (mustSay && !new RegExp(mustSay, 'i').test(res.out)) {
    bad(`${label} — refused, but the message does not name the reason`, `expected to match /${mustSay}/i`);
    return;
  }
  ok(`${label} — refused (exit ${res.code}), table unchanged at ${after} row(s)`);
}

async function main() {
  h('CPHI PRODUCTION RECONCILIATION PATH — ADVERSARIAL');

  const base = startCluster();
  if (!base) {
    console.log('\nSKIP  no PostgreSQL server toolchain (initdb/pg_ctl). This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  // ── 1. PLAN, read-only ──────────────────────────────────────────────────────────────────────────
  h('1. PLANNING IS READ-ONLY AND THE PLAN CARRIES ITS OWN EVIDENCE');
  const prod = await db(base, 'cphi_prodlike', `${TABLE}${CLEAN}`);
  const planFile = `${temp.base}/plan-prod.json`;
  const before = await rowCount(prod.c);

  const planRes = reconcile(prod.url, ['--plan-out', planFile]);
  if (planRes.code === 1) ok('planning exits 1 while duplicates exist — a blocking finding, not a note');
  else bad(`planning exited ${planRes.code}, expected 1`);
  if (await rowCount(prod.c) === before) ok(`planning changed nothing — still ${before} row(s)`);
  else bad('planning CHANGED THE TABLE');
  if (await dupGroups(prod.c) === 2) ok('2 duplicate groups present, as seeded');
  else bad(`expected 2 duplicate groups, found ${await dupGroups(prod.c)}`);

  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  for (const f of ['plan_id', 'db_identity', 'table_state', 'expected_groups', 'expected_deletions',
    'conflict_count', 'plan_sha']) {
    if (plan[f] !== undefined && plan[f] !== null) ok(`the plan records ${f}`);
    else bad(`the plan is missing ${f}`, 'ruling 44 item 2 requires it to be in the durable artifact');
  }
  if (plan.conflict_count === 0) ok('this plan has no conflicts, so a production apply is permitted to proceed');
  else bad(`fixture produced ${plan.conflict_count} conflict(s); it is meant to be clean`);

  // No secrets in the artifact a person will email around.
  const planText = fs.readFileSync(planFile, 'utf8');
  if (!/postgres(ql)?:\/\/|password|PGPASSWORD|secret|token/i.test(planText)) {
    ok('the plan file contains no connection string, password, secret or token');
  } else bad('the plan file contains something secret-shaped');

  // ── 2. UNAUTHORIZED INVOCATION ──────────────────────────────────────────────────────────────────
  h('2. UNAUTHORIZED INVOCATION');
  refusal.before = await rowCount(prod.c);

  await refusal('no flag at all', prod.c,
    reconcile(prod.url, ['--apply', planFile]), 'confirm-not-production');

  await refusal('both flags together — opposite claims about the same database', prod.c,
    reconcile(prod.url, ['--apply', planFile, '--confirm-not-production', '--apply-to-production',
      '--confirm-plan-id', plan.plan_id]), 'mutually exclusive');

  await refusal('--apply-to-production with no --confirm-plan-id', prod.c,
    reconcile(prod.url, ['--apply', planFile, '--apply-to-production']), 'confirm-plan-id');

  await refusal('--confirm-plan-id naming a different plan', prod.c,
    reconcile(prod.url, ['--apply', planFile, '--apply-to-production',
      '--confirm-plan-id', '00000000-0000-4000-8000-000000000000']), 'not this plan');

  // Ruling 44 item 4: authorization is never inferred from the environment.
  await refusal('environment variables that look like authorization, but no flags', prod.c,
    reconcile(prod.url, ['--apply', planFile], {
      APPLY_TO_PRODUCTION: 'true',
      CPHI_APPLY_TO_PRODUCTION: '1',
      CONFIRM_PLAN_ID: plan.plan_id,
      RECONCILE_CONFIRMED: 'yes',
      NODE_ENV: 'production',
    }), 'confirm-not-production');

  // ── 3. ALTERED PLAN ─────────────────────────────────────────────────────────────────────────────
  h('3. A PLAN THAT IS NOT THE PLAN THAT WAS REVIEWED');
  const tampered = `${temp.base}/plan-tampered.json`;

  const t1 = JSON.parse(planText);
  t1.groups[0].delete_ids = [...(t1.groups[0].delete_ids || []), 999999];
  fs.writeFileSync(tampered, JSON.stringify(t1, null, 2));
  await refusal('a plan with an extra id spliced into delete_ids', prod.c,
    reconcile(prod.url, ['--apply', tampered, '--apply-to-production', '--confirm-plan-id', t1.plan_id]),
    'modified since it was generated');

  const t2 = JSON.parse(planText);
  t2.conflict_count = 0; t2.expected_deletions = 99;
  t2.plan_sha = undefined; delete t2.plan_sha;
  fs.writeFileSync(tampered, JSON.stringify(t2, null, 2));
  await refusal('a plan with its integrity hash removed', prod.c,
    reconcile(prod.url, ['--apply', tampered, '--apply-to-production', '--confirm-plan-id', t2.plan_id]),
    'no integrity hash');

  // ── 4. WRONG DATABASE ───────────────────────────────────────────────────────────────────────────
  // The same DDL and the same rows, so the TABLE STATE matches. Only the database identity differs.
  // If this passed, a rehearsal plan would apply to production.
  h('4. THE RIGHT PLAN, THE WRONG DATABASE');
  const other = await db(base, 'cphi_otherdb', `${TABLE}${CLEAN}`);
  refusal.before = await rowCount(other.c);
  await refusal('a plan built on one database, applied to another with identical contents', other.c,
    reconcile(other.url, ['--apply', planFile, '--apply-to-production', '--confirm-plan-id', plan.plan_id]),
    'DIFFERENT database');

  // ── 5. STALE PLAN / CHANGED ROWS ────────────────────────────────────────────────────────────────
  h('5. THE RIGHT DATABASE, BUT THE ROWS MOVED SINCE THE REVIEW');
  const stale = await db(base, 'cphi_stale', `${TABLE}${CLEAN}`);
  const stalePlan = `${temp.base}/plan-stale.json`;
  reconcile(stale.url, ['--plan-out', stalePlan]);
  const sp = JSON.parse(fs.readFileSync(stalePlan, 'utf8'));

  // A note edited on a row OUTSIDE any duplicate group: still a refusal, because the fingerprint
  // covers the table. A reviewer who approved a plan did so against a state, not a subset.
  await stale.c.query(`UPDATE cphi_exhibitor_matches SET entity_note = 'edited after review'
                        WHERE holder_normalized = 'gamma only'`);
  refusal.before = await rowCount(stale.c);
  await refusal('a row edited after planning, outside every duplicate group', stale.c,
    reconcile(stale.url, ['--apply', stalePlan, '--apply-to-production', '--confirm-plan-id', sp.plan_id]),
    'changed since this plan was reviewed');

  // And a row ADDED to one of the groups, which changes who should survive it.
  const stale2 = await db(base, 'cphi_stale2', `${TABLE}${CLEAN}`);
  const stale2Plan = `${temp.base}/plan-stale2.json`;
  reconcile(stale2.url, ['--plan-out', stale2Plan]);
  const sp2 = JSON.parse(fs.readFileSync(stale2Plan, 'utf8'));
  await stale2.c.query(`INSERT INTO cphi_exhibitor_matches
    (event_slug, holder, holder_normalized, exhibiting, review_status, entity_note, match_tier)
    VALUES ('cphi-2026','Alpha Pharma','alpha pharma', true, 'entity_review', 'a third opinion', 't1')`);
  refusal.before = await rowCount(stale2.c);
  await refusal('a row added to a duplicate group after planning', stale2.c,
    reconcile(stale2.url, ['--apply', stale2Plan, '--apply-to-production', '--confirm-plan-id', sp2.plan_id]),
    'changed since this plan was reviewed');

  // ── 6. UNRESOLVED CONFLICTS ─────────────────────────────────────────────────────────────────────
  h('6. THE PRODUCTION FLAG DOES NOT BUY ITS WAY PAST A CONFLICT');
  const conf = await db(base, 'cphi_conflict', `${TABLE}${CLEAN}${CONFLICTED}`);
  const confPlan = `${temp.base}/plan-conflict.json`;
  reconcile(conf.url, ['--plan-out', confPlan]);
  const cp = JSON.parse(fs.readFileSync(confPlan, 'utf8'));
  if (cp.conflict_count >= 1) ok(`the plan reports ${cp.conflict_count} conflict group(s)`);
  else bad('the conflicted fixture produced no conflict');

  refusal.before = await rowCount(conf.c);
  await refusal('a production apply of a plan containing a conflict', conf.c,
    reconcile(conf.url, ['--apply', confPlan, '--apply-to-production', '--confirm-plan-id', cp.plan_id]),
    'CONFLICT');

  const confAudit = await conf.c.query(`SELECT to_regclass('public.cphi_reconcile_audit') IS NULL AS absent`);
  if (confAudit.rows[0].absent) ok('a refused run created no audit table — it touched nothing whatsoever');
  else bad('a refused run created the audit table', 'the refusals must happen before any DDL');

  // ── 7. THE AUTHORIZED PATH ──────────────────────────────────────────────────────────────────────
  h('7. THE AUTHORIZED PATH — and what it writes down');

  // Ruling 46 item 2: a clean checkout is required, so the harness makes one.
  const clean = snapshotCheckout('clean');
  const dirtyCo = snapshotCheckout('dirty', { dirty: true });
  refusal.before = await rowCount(prod.c);
  await refusal('a production apply from a checkout with a modified tracked file', prod.c,
    reconcile(prod.url, ['--apply', planFile, '--apply-to-production',
      '--confirm-plan-id', plan.plan_id], {}, dirtyCo.script), 'uncommitted change');
  // Item 4: the guard is repo-wide, not script-wide. A change to the database module or to the
  // dependency lock is as relevant to reconciliation as a change to the script, and reaches it by
  // a path the script's own contents say nothing about.
  for (const rel of ['src/lib/db.js', 'package-lock.json']) {
    const co = snapshotCheckout(`dirty-${rel.replace(/[^a-z]+/gi, '-')}`, { dirty: rel });
    await refusal(`a production apply with ${rel} modified`, prod.c,
      reconcile(prod.url, ['--apply', planFile, '--apply-to-production',
        '--confirm-plan-id', plan.plan_id], {}, co.script), 'uncommitted change');
  }

  await refusal('a production apply whose --expect-code-sha is not this checkout', prod.c,
    reconcile(prod.url, ['--apply', planFile, '--apply-to-production',
      '--confirm-plan-id', plan.plan_id, '--expect-code-sha', 'c0ffee0'], {}, clean.script),
    'not the SHA you authorized');

  const okRes = reconcile(prod.url, ['--apply', planFile, '--apply-to-production',
    '--confirm-plan-id', plan.plan_id, '--expect-code-sha', clean.sha.slice(0, 12)], {}, clean.script);
  if (okRes.code === 0) ok('a correct production invocation is allowed and exits 0');
  else bad(`the authorized path exited ${okRes.code}`, okRes.out.trim().split('\n').slice(-6).join(' | '));

  if (await dupGroups(prod.c) === 0) ok('no duplicate groups remain — idx_cem_unique can now be created');
  else bad(`${await dupGroups(prod.c)} duplicate group(s) remain`);

  const runs = (await prod.c.query(
    `SELECT target, plan_id, db_identity, database_name, outcome, merged, deleted
       FROM cphi_reconcile_runs ORDER BY run_id`)).rows;
  if (runs.length === 1) ok('exactly one run was recorded');
  else bad(`${runs.length} run rows recorded, expected 1`);
  if (runs[0] && runs[0].target === 'production') ok("the run ledger records target = 'production'");
  else bad(`the run ledger records target = ${runs[0] ? runs[0].target : '(none)'}`);
  if (runs[0] && runs[0].plan_id === plan.plan_id) ok('the run ledger names the plan id that was applied');
  else bad('the run ledger does not name the plan id');
  if (runs[0] && runs[0].outcome === 'complete') ok(`the run ledger records the outcome: ${runs[0].outcome}`);
  else bad(`unexpected outcome: ${runs[0] ? runs[0].outcome : '(none)'}`);

  // Item 6's second half: identity, not credentials.
  const ledgerText = JSON.stringify(runs);
  if (!/postgres(ql)?:\/\/|password|PGPASSWORD|@localhost|token/i.test(ledgerText)) {
    ok('the run ledger holds a database identity hash and no connection string, password or token');
  } else bad('the run ledger contains something secret-shaped', ledgerText.slice(0, 160));

  const aud = (await prod.c.query(
    `SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE target = 'production')::int prod,
            COUNT(*) FILTER (WHERE run_id IS NOT NULL)::int linked,
            COUNT(*) FILTER (WHERE action = 'delete' AND before_row IS NOT NULL)::int recoverable
       FROM cphi_reconcile_audit`)).rows[0];
  if (aud.n > 0) ok(`${aud.n} audit row(s) written`);
  else bad('no audit rows were written');
  if (aud.prod === aud.n) ok("every audit row is tagged target = 'production'");
  else bad(`${aud.n - aud.prod} audit row(s) are not tagged production`);
  if (aud.linked === aud.n) ok('every audit row is linked to its run');
  else bad(`${aud.n - aud.linked} audit row(s) have no run_id`);
  if (aud.recoverable > 0) ok(`${aud.recoverable} deleted row(s) carry their complete prior contents`);
  else bad('a deletion was recorded without its prior row');

  // ── 8. REPEATED EXECUTION ───────────────────────────────────────────────────────────────────────
  h('8. RUNNING IT AGAIN');
  const rowsAfter = await rowCount(prod.c);
  const again = reconcile(prod.url, ['--apply', planFile, '--apply-to-production',
    '--confirm-plan-id', plan.plan_id], {}, clean.script);
  // The table state has legitimately changed — the first run changed it — so the honest outcome is
  // a refusal, not a silent no-op. Either is safe; deleting something is not.
  if (await rowCount(prod.c) === rowsAfter) ok(`a second run changed nothing — still ${rowsAfter} row(s)`);
  else bad(`a second run changed the table: ${rowsAfter} → ${await rowCount(prod.c)}`);
  if (again.code !== 0 || /already|skip|unchanged/i.test(again.out)) {
    ok(`a second run is either refused or a no-op (exit ${again.code}) — never a second deletion`);
  } else bad('a second run reported success without saying it had nothing to do');

  // ── 9. PARTIAL FAILURE ──────────────────────────────────────────────────────────────────────────
  h('9. PARTIAL FAILURE — a DELETE that throws mid-group');
  const brk = await db(base, 'cphi_partial', `${TABLE}${CLEAN}`);
  const brkPlan = `${temp.base}/plan-partial.json`;
  reconcile(brk.url, ['--plan-out', brkPlan]);
  const bp = JSON.parse(fs.readFileSync(brkPlan, 'utf8'));
  // Fail the deletion of ONE row. If the apply were not transactional, the survivor would already
  // have been updated and an audit row written when this fires.
  const victim = (bp.groups.find((g) => (g.delete_ids || []).length) || {}).delete_ids[0];
  await brk.c.query(`
    CREATE FUNCTION boom() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure on id %', OLD.id; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER boom_trg BEFORE DELETE ON cphi_exhibitor_matches
      FOR EACH ROW WHEN (OLD.id = ${Number(victim)}) EXECUTE FUNCTION boom();`);
  const brkBefore = await rowCount(brk.c);
  const brkRes = reconcile(brk.url, ['--apply', brkPlan, '--apply-to-production',
    '--confirm-plan-id', bp.plan_id], {}, clean.script);
  if (brkRes.code !== 0) ok(`an injected failure makes the run exit non-zero (${brkRes.code})`);
  else bad('an injected failure still exited 0');

  const survivorRow = (await brk.c.query(
    `SELECT review_status, entity_note FROM cphi_exhibitor_matches WHERE id = $1`,
    [bp.groups.find((g) => (g.delete_ids || []).includes(victim)).survivor_id])).rows[0];
  const victimStill = (await brk.c.query(
    `SELECT COUNT(*)::int n FROM cphi_exhibitor_matches WHERE id = $1`, [victim])).rows[0].n;
  if (victimStill === 1) ok('the row whose deletion failed is still there');
  else bad('the row whose deletion failed is gone');

  const brkAudit = (await brk.c.query(
    `SELECT COUNT(*)::int n FROM cphi_reconcile_audit WHERE event_slug = $1 AND holder_normalized = $2`,
    [bp.groups.find((g) => (g.delete_ids || []).includes(victim)).event_slug,
      bp.groups.find((g) => (g.delete_ids || []).includes(victim)).holder_normalized])).rows[0].n;
  if (brkAudit === 0) ok('the rolled-back group left NO audit rows — the transaction took them with it');
  else bad(`${brkAudit} audit row(s) survived a rolled-back group`, 'the audit and the change must commit together');
  if (survivorRow) ok(`the survivor row still exists (review_status ${JSON.stringify(survivorRow.review_status)})`);

  const brkRuns = (await brk.c.query(
    `SELECT target, outcome, failed FROM cphi_reconcile_runs ORDER BY run_id`)).rows;
  if (brkRuns.length && /rollback|incomplete/i.test(String(brkRuns[0].outcome))) {
    ok(`the run ledger records the failure: outcome '${brkRuns[0].outcome}', failed ${brkRuns[0].failed}`);
  } else bad(`the run ledger does not record the rollback: ${JSON.stringify(brkRuns[0] || null)}`);
  console.log(`        (${brkBefore} rows before the injected failure, ${await rowCount(brk.c)} after)`);

  // ── 10. MISSING AUDIT ───────────────────────────────────────────────────────────────────────────
  h('10. MISSING AUDIT INFRASTRUCTURE');
  const noaud = await db(base, 'cphi_noaudit', `${TABLE}${CLEAN}`);
  const noaudPlan = `${temp.base}/plan-noaudit.json`;
  reconcile(noaud.url, ['--plan-out', noaudPlan]);
  const np = JSON.parse(fs.readFileSync(noaudPlan, 'utf8'));
  const r10 = reconcile(noaud.url, ['--apply', noaudPlan, '--apply-to-production',
    '--confirm-plan-id', np.plan_id], {}, clean.script);
  if (r10.code === 0) ok('with no audit table present, the apply creates one rather than proceeding without');
  else bad(`the apply failed with no audit table present (exit ${r10.code})`,
    r10.out.trim().split('\n').slice(-4).join(' | '));
  const n10 = (await noaud.c.query(`SELECT COUNT(*)::int n FROM cphi_reconcile_audit`)).rows[0].n;
  if (n10 > 0) ok(`${n10} audit row(s) in the freshly created table — nothing was deleted unrecorded`);
  else bad('rows were reconciled with an empty audit table');

  // ── 11. THE ISOLATED PATH IS UNCHANGED, AND SAYS SO ─────────────────────────────────────────────
  h('11. THE NON-PRODUCTION PATH STILL WORKS AND IS LABELLED DIFFERENTLY');
  const iso = await db(base, 'cphi_isolated', `${TABLE}${CLEAN}`);
  const isoPlan = `${temp.base}/plan-iso.json`;
  reconcile(iso.url, ['--plan-out', isoPlan]);
  const ip = JSON.parse(fs.readFileSync(isoPlan, 'utf8'));
  const isoRes = reconcile(iso.url, ['--apply', isoPlan, '--confirm-not-production']);
  if (isoRes.code === 0) ok('--confirm-not-production still applies a plan, exactly as before');
  else bad(`the isolated path exited ${isoRes.code}`, isoRes.out.trim().split('\n').slice(-5).join(' | '));

  // And the isolated path deliberately does NOT require --confirm-plan-id: ruling 44 item 7 says
  // leave it unchanged, and it is the path that runs inside an automated readiness harness.
  if (!/confirm-plan-id/i.test(isoRes.out)) ok('the isolated path did not acquire the production path\'s second confirmation');
  else bad('the isolated path now demands --confirm-plan-id', 'item 7 says it must be unchanged');

  const isoRuns = (await iso.c.query(`SELECT target, outcome FROM cphi_reconcile_runs`)).rows;
  if (isoRuns.length === 1 && isoRuns[0].target === 'isolated-restore') {
    ok("the run ledger distinguishes it: target = 'isolated-restore'");
  } else bad(`the isolated run was recorded as ${JSON.stringify(isoRuns)}`);
  const isoAud = (await iso.c.query(
    `SELECT COUNT(*) FILTER (WHERE target = 'isolated-restore')::int iso, COUNT(*)::int n
       FROM cphi_reconcile_audit`)).rows[0];
  if (isoAud.n && isoAud.iso === isoAud.n) ok(`all ${isoAud.n} audit row(s) tagged 'isolated-restore' — a rehearsal is distinguishable forever`);
  else bad(`audit tagging wrong on the isolated path: ${JSON.stringify(isoAud)}`);

  // ── 12. PLANNING IS GENUINELY READ-ONLY (ruling 45 item 4) ──────────────────────────────────────
  //
  // Not "we did not write anything on purpose" — proved by planning as a role that CANNOT write.
  // A SELECT-only role turns the claim into an assertion the database enforces: if planning tried
  // to create the audit table, or update a row, it would fail with permission denied.
  h('12. PLANNING IS READ-ONLY — proved with a role that cannot write');
  const ro = await db(base, 'cphi_readonly', `${TABLE}${CLEAN}`);
  await ro.c.query(`
    CREATE ROLE cphi_planner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE ALL ON SCHEMA public FROM cphi_planner;
    GRANT USAGE ON SCHEMA public TO cphi_planner;
    GRANT SELECT ON cphi_exhibitor_matches TO cphi_planner;`);
  const roUrl = `postgresql://cphi_planner@localhost/cphi_readonly?host=${base}&port=${PGPORT}&sslmode=disable`;

  const tablesBefore = (await ro.c.query(
    `SELECT string_agg(tablename, ',' ORDER BY tablename) t FROM pg_tables WHERE schemaname='public'`)).rows[0].t;
  const roPlan = `${temp.base}/plan-ro.json`;
  const roRes = reconcile(roUrl, ['--plan-out', roPlan]);
  if (roRes.code === 1) ok('planning succeeds as a SELECT-only role — it performs no write of any kind');
  else {
    bad(`planning as a SELECT-only role exited ${roRes.code}`,
      roRes.out.trim().split('\n').slice(-5).join(' | '));
  }
  const tablesAfter = (await ro.c.query(
    `SELECT string_agg(tablename, ',' ORDER BY tablename) t FROM pg_tables WHERE schemaname='public'`)).rows[0].t;
  if (tablesAfter === tablesBefore) ok('planning created no table — no implicit audit-table creation');
  else bad('planning created a table', `before: ${tablesBefore} / after: ${tablesAfter}`);
  if ((await ro.c.query(`SELECT COUNT(*)::int n FROM cphi_exhibitor_matches`)).rows[0].n === 5) {
    ok('planning changed no row');
  } else bad('planning changed rows');

  // ── THE DIGEST MUST NOT DEPEND ON WHO IS LOGGED IN (ruling 46 item 1) ──────────────────────────
  //
  // Planning may run as a low-privilege role while the apply runs as the maintenance identity. If
  // the identity or the digest varied with the login role, the apply would refuse with "this plan
  // was built against a DIFFERENT database" — fail-closed, so never a data risk, but false, and it
  // would stop the release pointing at the wrong thing.
  //
  // It DID vary, until this was fixed: the column fingerprint came from information_schema.columns,
  // which is privilege-filtered. Measured on a cluster: a role with column-level SELECT on every
  // column except entity_note hashed to f96b50ae494a156f where the owner hashed to 68dec06f2f70439a.
  // pg_attribute is the catalog and is not filtered. This asserts it stays that way.
  await ro.c.query(`
    CREATE ROLE cphi_narrow LOGIN NOSUPERUSER;
    GRANT USAGE ON SCHEMA public TO cphi_narrow;
    GRANT SELECT (id, event_slug, holder, holder_normalized, exhibiting, exhibitor_name, booth,
                  hall, match_tier, molecules_covered, review_status, searched_terms, checked_at,
                  entity_note)
      ON cphi_exhibitor_matches TO cphi_narrow;
    REVOKE SELECT (booth, hall) ON cphi_exhibitor_matches FROM cphi_narrow;`);
  // Measured directly under two roles, because the narrow role cannot run a plan at all — the plan
  // SELECTs booth and hall, so a role without those grants gets "permission denied", which is
  // correct and is why the comparison is made at the fingerprint rather than at the plan.
  const COLQ = {
    info: `SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY column_name) c
             FROM information_schema.columns
            WHERE table_schema='public' AND table_name='cphi_exhibitor_matches'`,
    cat: `SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ','
                    ORDER BY a.attname) c
            FROM pg_attribute a
           WHERE a.attrelid = to_regclass('public.cphi_exhibitor_matches')
             AND a.attnum > 0 AND NOT a.attisdropped`,
  };
  const asRole = async (role) => {
    const cc = new Client({ connectionString: `postgresql://${role}@localhost/cphi_readonly?host=${base}&port=${PGPORT}&sslmode=disable` });
    await cc.connect();
    const out = {
      info: (await cc.query(COLQ.info)).rows[0].c || '',
      cat: (await cc.query(COLQ.cat)).rows[0].c || '',
    };
    await cc.end();
    return out;
  };
  const asOwner = await asRole('postgres');
  const asNarrow = await asRole('cphi_narrow');

  if (asOwner.cat === asNarrow.cat) {
    ok('pg_attribute returns the same columns to the owner and to a role missing two column grants');
  } else bad('the catalog fingerprint differs between roles', 'the identity would depend on who logged in');
  if (asOwner.info !== asNarrow.info) {
    ok('…while information_schema returns DIFFERENT columns to those roles — which is why it is not used');
  } else {
    console.log('        (information_schema happened to agree here; the catalog is used regardless)');
  }
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'cphi-reconcile.js'), 'utf8');
  const identityFn = src.slice(src.indexOf('async function dbIdentity'), src.indexOf('async function tableStateFingerprint'));
  // Comments stripped first: the function CONTAINS the word information_schema, in the comment
  // explaining why it is not used. A checker that reads prose as code fails on its own explanation.
  const identityCode = identityFn.replace(/^\s*\/\/.*$/gm, '');
  if (/pg_attribute/.test(identityCode) && !/information_schema/.test(identityCode)) {
    ok('dbIdentity() reads the catalog and never information_schema (comments excluded)');
  } else bad('dbIdentity() still queries information_schema', 'privilege-filtered: the identity would vary by role');

  // And the realistic pairing, end to end: plan as the low-privilege role that CAN read the table,
  // and confirm the digest equals the one the owner computes — plan as one, apply as the other.
  const ownerPlanPath = `${temp.base}/plan-asowner.json`;
  const plannerPlanPath = `${temp.base}/plan-asplanner.json`;
  reconcile(`postgresql://postgres@localhost/cphi_readonly?host=${base}&port=${PGPORT}&sslmode=disable`,
    ['--plan-out', ownerPlanPath]);
  reconcile(roUrl, ['--plan-out', plannerPlanPath]);
  if (fs.existsSync(ownerPlanPath) && fs.existsSync(plannerPlanPath)) {
    const po = JSON.parse(fs.readFileSync(ownerPlanPath, 'utf8'));
    const pp = JSON.parse(fs.readFileSync(plannerPlanPath, 'utf8'));
    if (po.db_identity.identity_sha === pp.db_identity.identity_sha) {
      ok(`database identity matches across login roles (${po.db_identity.identity_sha})`);
    } else bad('database identity differs by login role', `${po.db_identity.identity_sha} vs ${pp.db_identity.identity_sha}`);
    if (po.plan_digest === pp.plan_digest) {
      ok(`plan digest matches across login roles (${po.plan_digest}) — plan as one role, apply as another`);
    } else bad('the plan digest differs by login role', `${po.plan_digest} vs ${pp.plan_digest}`);
    if (po.table === pp.table && po.db_identity.table_oid === pp.db_identity.table_oid) {
      ok(`both target the same table (oid ${po.db_identity.table_oid}) in the same database`);
    } else bad('the two roles resolved different tables');
  } else bad('could not plan as both the owner and the read-only role');

  // And the identity refusal (ruling 45 item 2): that same role must not be allowed to APPLY.
  const roApply = reconcile(roUrl, ['--apply', roPlan, '--apply-to-production',
    '--confirm-plan-id', JSON.parse(fs.readFileSync(roPlan, 'utf8')).plan_id]);
  if (roApply.code !== 0 && /cannot create tables|least-privileged/i.test(roApply.out)) {
    ok('an apply attempted as the least-privileged role is refused, naming the maintenance identity');
  } else bad(`apply as a non-DDL role was not refused for that reason (exit ${roApply.code})`,
    roApply.out.trim().split('\n').slice(-4).join(' | '));

  // ── 13. THE DIGEST PATH — no plan file to keep (ruling 45 items 1 and 5) ────────────────────────
  h('13. --apply-current — the plan is rebuilt, not carried');
  const dg = await db(base, 'cphi_digest', `${TABLE}${CLEAN}`);
  const dgPlanA = `${temp.base}/plan-dg-a.json`;
  const dgPlanB = `${temp.base}/plan-dg-b.json`;
  reconcile(dg.url, ['--plan-out', dgPlanA]);
  reconcile(dg.url, ['--plan-out', dgPlanB]);
  const dA = JSON.parse(fs.readFileSync(dgPlanA, 'utf8'));
  const dB = JSON.parse(fs.readFileSync(dgPlanB, 'utf8'));

  if (dA.plan_digest && dA.plan_digest === dB.plan_digest) {
    ok(`two plans from the same unchanged database share one digest (${dA.plan_digest})`);
  } else bad('the digest is not stable across generations', `${dA.plan_digest} vs ${dB.plan_digest}`);
  if (dA.plan_id !== dB.plan_id) ok('…while the plan ids differ — so the digest, not the id, identifies content');
  else bad('two generations produced the same plan id');

  // The digest covers db_identity, so a rehearsal digest cannot authorize a production apply.
  const otherPlan = `${temp.base}/plan-other.json`;
  reconcile(other.url, ['--plan-out', otherPlan]);
  const dOther = JSON.parse(fs.readFileSync(otherPlan, 'utf8'));
  if (dOther.plan_digest !== dA.plan_digest) {
    ok('two databases with identical contents produce DIFFERENT digests — identity is inside the digest');
  } else bad('identical contents in different databases share a digest', 'a rehearsal digest would authorize production');

  refusal.before = await rowCount(dg.c);
  await refusal('--apply-current with no --confirm-plan-digest', dg.c,
    reconcile(dg.url, ['--apply-current', '--apply-to-production']), 'confirm-plan-digest');
  await refusal('--apply-current with a digest that is not this plan\'s', dg.c,
    reconcile(dg.url, ['--apply-current', '--apply-to-production', '--confirm-plan-digest', 'deadbeefdeadbeefdeadbeef']),
    'not the plan you reviewed');
  await refusal('--apply and --apply-current together', dg.c,
    reconcile(dg.url, ['--apply', dgPlanA, '--apply-current', '--apply-to-production',
      '--confirm-plan-digest', dA.plan_digest]), 'mutually exclusive');

  // Item 5: a row changes between review and apply, and the digest catches it.
  await dg.c.query(`UPDATE cphi_exhibitor_matches SET entity_note = 'changed between review and apply'
                     WHERE holder_normalized = 'gamma only'`);
  refusal.before = await rowCount(dg.c);
  await refusal('a row changed between the review and the apply', dg.c,
    reconcile(dg.url, ['--apply-current', '--apply-to-production', '--confirm-plan-digest', dA.plan_digest]),
    'not the plan you reviewed');

  // And the authorized digest path, on a clean database.
  const dg2 = await db(base, 'cphi_digest2', `${TABLE}${CLEAN}`);
  const dg2Plan = `${temp.base}/plan-dg2.json`;
  reconcile(dg2.url, ['--plan-out', dg2Plan]);
  const d2 = JSON.parse(fs.readFileSync(dg2Plan, 'utf8'));
  fs.rmSync(dg2Plan);  // the point: the file is GONE, as it would be after a container restart
  const dg2Res = reconcile(dg2.url, ['--apply-current', '--apply-to-production',
    '--confirm-plan-digest', d2.plan_digest], {}, clean.script);
  if (dg2Res.code === 0) ok('--apply-current works with the plan file deleted — nothing had to persist');
  else bad(`the digest path exited ${dg2Res.code}`, dg2Res.out.trim().split('\n').slice(-6).join(' | '));
  if (await dupGroups(dg2.c) === 0) ok('it reconciled the duplicates it was authorized for');
  else bad(`${await dupGroups(dg2.c)} duplicate group(s) remain`);
  const dg2Runs = (await dg2.c.query(`SELECT target FROM cphi_reconcile_runs`)).rows;
  if (dg2Runs.length === 1 && dg2Runs[0].target === 'production') ok("the digest path records target = 'production'");
  else bad(`the digest path recorded ${JSON.stringify(dg2Runs)}`);

  // ── 14. WHAT IS ACTUALLY IN A PLAN (ruling 45 item 3) ───────────────────────────────────────────
  h('14. IS THE PLAN SAFE TO STORE OR SEND');
  const planObj = JSON.parse(fs.readFileSync(dgPlanA, 'utf8'));
  const fields = new Set();
  for (const g of planObj.groups) for (const r of (g.rows || [])) Object.keys(r).forEach((k) => fields.add(k));
  console.log(`        row fields carried in the plan: ${[...fields].sort().join(', ') || '(none)'}`);
  const text = fs.readFileSync(dgPlanA, 'utf8');
  const secretish = [/postgres(ql)?:\/\//i, /password/i, /PGPASSWORD/, /\bsecret\b/i, /\btoken\b/i,
    /api[_-]?key/i, /BEGIN [A-Z ]*PRIVATE KEY/, /\bBearer\b/, /ghp_[A-Za-z0-9]/, /\b\d{3}-\d{2}-\d{4}\b/];
  const hits = secretish.filter((re) => re.test(text)).map(String);
  if (!hits.length) ok('no credential, key, token or government-id pattern anywhere in the plan');
  else bad(`the plan matches ${hits.length} secret-shaped pattern(s)`, hits.join(' '));
  // It does carry business row content — company names, booths, and human notes — which is the
  // point of a reviewable plan. Said out loud so nobody treats it as public.
  if (/entity_note|holder/.test(text)) {
    ok('the plan does carry business row content (holders, notes) — internal, and the digest path means it never has to leave the database');
  }

  // ── 15. THE READ-ONLY PLANNING OVERRIDE (ruling 48 items 1, 2, 3) ───────────────────────────────
  h('15. PLANNING OVER A SEPARATE, READ-ONLY CONNECTION');

  // (a) The mechanism, proved against the database rather than trusted: a session opened with
  //     options=-c default_transaction_read_only=on must have writes REFUSED by Postgres.
  const x = await db(base, 'cphi_xident', `${TABLE}${CLEAN}`);
  await x.c.query(`
    CREATE ROLE cphi_plan2 LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO cphi_plan2;
    GRANT SELECT ON cphi_exhibitor_matches TO cphi_plan2;`);
  const base_ = `host=${base}&port=${PGPORT}&sslmode=disable`;
  const roOpt = `&options=${encodeURIComponent('-c default_transaction_read_only=on')}`;
  const probe = new Client({ connectionString: `postgresql://postgres@localhost/cphi_xident?${base_}${roOpt}` });
  await probe.connect();
  let refusedWrite = false;
  try { await probe.query(`CREATE TABLE should_not_exist (x int)`); } catch (e) {
    refusedWrite = /read-only transaction/i.test(e.message);
  }
  await probe.end();
  if (refusedWrite) ok('a session opened with the read-only option has writes refused BY POSTGRES, even as the owner');
  else bad('the read-only session option did not block a write', 'the enforcement half of the override is not real');

  // (b) Planning through the override, as a low-privilege role on its own connection.
  const planUrl = `postgresql://cphi_plan2@localhost/cphi_xident?${base_}`;
  const maintUrl = `postgresql://postgres@localhost/cphi_xident?${base_}`;
  const xPlanFile = `${temp.base}/plan-xident.json`;
  const xPlan = reconcile('postgresql://unused@localhost/cphi_xident?' + base_,
    ['--plan-out', xPlanFile], { RECONCILE_PLAN_DATABASE_URL: planUrl });
  if (xPlan.code === 1) ok('planning uses RECONCILE_PLAN_DATABASE_URL in preference to DATABASE_URL');
  else bad(`planning through the override exited ${xPlan.code}`, xPlan.out.trim().split('\n').slice(-5).join(' | '));
  if (/session read-only/.test(xPlan.out)) ok('…and reports the connection as session read-only');
  else bad('the override did not report a read-only session');
  if (/transport:/.test(xPlan.out)) ok(`…and reports the transport: ${(xPlan.out.match(/transport:.*/) || [''])[0].trim().slice(0, 96)}`);
  else bad('no transport line was reported', 'ruling 48 item 3 asks for the TLS state to be stated');

  // (c) An apply must never fall back to the read-only planning URL.
  refusal.before = await rowCount(x.c);
  await refusal('an apply with only the read-only planning override set', x.c,
    reconcile('postgresql://unused@localhost/cphi_xident?' + base_,
      ['--apply-current', '--apply-to-production', '--confirm-plan-digest', 'x'],
      { RECONCILE_PLAN_DATABASE_URL: planUrl }, clean.script), 'READ-ONLY planning override');

  // (d) Item 2: planned by one identity on one connection, applied by another on another —
  //     same database, same table, same digest.
  const xp = JSON.parse(fs.readFileSync(xPlanFile, 'utf8'));
  const xApply = reconcile('postgresql://unused@localhost/cphi_xident?' + base_,
    ['--apply-current', '--apply-to-production', '--confirm-plan-digest', xp.plan_digest],
    { MIGRATION_DATABASE_URL: maintUrl }, clean.script);
  if (xApply.code === 0) {
    ok('a plan made by the read-only identity is applied by the maintenance identity — same digest');
  } else {
    bad(`cross-identity apply exited ${xApply.code}`, xApply.out.trim().split('\n').slice(-6).join(' | '));
  }
  if (/via MIGRATION_DATABASE_URL/.test(xApply.out)) ok('…and the apply ran as the maintenance identity, not the planning one');
  else bad('the apply did not report the maintenance identity');
  if (await dupGroups(x.c) === 0) ok('the duplicates are gone — the two identities agreed on the same table');
  else bad(`${await dupGroups(x.c)} duplicate group(s) remain`);
  const xRuns = (await x.c.query(`SELECT target, database_name FROM cphi_reconcile_runs`)).rows;
  if (xRuns.length === 1 && xRuns[0].target === 'production' && xRuns[0].database_name === 'cphi_xident') {
    ok("the run ledger records target 'production' against the same database the plan named");
  } else bad(`the run ledger recorded ${JSON.stringify(xRuns)}`);

  // (e) What this harness CANNOT simulate, said rather than implied: a Postgres reachable on a
  //     public address with TLS off. The refusal for that case is in the code and is exercised by
  //     neither of the two situations available here (unix socket, private address) — both of which
  //     are correctly ALLOWED, which is itself worth asserting, since a guard that refused them
  //     would block every disposable-cluster test and every run from inside Railway's network.
  console.log('        (a public-address server with TLS off cannot be simulated here; the two');
  console.log('         reachable cases — unix socket and private address — are allowed, as above)');

  for (const d of [prod, other, stale, stale2, conf, brk, noaud, iso, ro, dg, dg2, x]) { try { await d.c.end(); } catch { /* closing */ } }

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the production reconciliation gate can be talked past. Do not push.\n');
    process.exit(1);
  }
  console.log('\nPASS  the production path refuses a wrong database, a stale plan, changed rows, an\n'
    + '      altered plan, an unresolved conflict, a missing confirmation and an environment\n'
    + '      pretending to be one — and in every refusal it changed nothing. It rolls back a\n'
    + '      partial failure with its audit rows, recreates missing audit infrastructure rather\n'
    + '      than proceeding without it, and records which target it ran against.\n');
}

main()
  .then(() => { stopCluster(); process.exit(0); })
  .catch((e) => { console.error(`\ncheck-cphi-production-path: ${e.message}\n${e.stack || ''}`); stopCluster(); process.exit(1); });
process.on('exit', stopCluster);
