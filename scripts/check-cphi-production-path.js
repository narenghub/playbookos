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

function reconcile(url, args = [], extraEnv = {}) {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'cphi-reconcile.js'), ...args],
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
  const okRes = reconcile(prod.url, ['--apply', planFile, '--apply-to-production',
    '--confirm-plan-id', plan.plan_id]);
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
    '--confirm-plan-id', plan.plan_id]);
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
    '--confirm-plan-id', bp.plan_id]);
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
    '--confirm-plan-id', np.plan_id]);
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

  for (const d of [prod, other, stale, stale2, conf, brk, noaud, iso]) { try { await d.c.end(); } catch { /* closing */ } }

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
