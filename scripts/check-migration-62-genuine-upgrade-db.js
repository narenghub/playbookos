#!/usr/bin/env node
// ── A.9: MIGRATION 62 APPLIED TO A DATABASE BUILT BY THE GENUINE HISTORICAL CODE ────────────
//
// The owner has twice refused the earlier version of this test, and was right to. That one
// reconstructed the pre-migration shape by taking today's schema and DROPPING the three columns
// migration 62 adds. **That measures my belief about what migration 61 looked like, not migration
// 61.** If the historical migrator also created an index, a constraint, a default or a trigger that
// today's code no longer mentions, a reconstruction cannot know it, and the one thing an upgrade
// test exists to find is the interaction nobody predicted.
//
// So this check runs the ACTUAL HISTORICAL MIGRATORS, from a git worktree at `6b11bfb^` — the
// commit before synthetic isolation existed. That tree genuinely has no
// `src/lib/worker/synthetic-isolation.js`; `require` of it there fails. The database this check
// upgrades was therefore built by code that had never heard of migration 62, which is the only
// thing that makes the upgrade real.
//
//   M61_TREE=/path/to/worktree node scripts/check-migration-62-genuine-upgrade-db.js
//
// Without M61_TREE it creates the worktree itself from this repository's own history, so preflight
// needs no setup and the historical code cannot drift from what git actually records.
//
// ── WHAT THIS IS LOOKING FOR ────────────────────────────────────────────────
//
// Not "do the columns appear". The question is what happens to state that already exists: the
// office iMac's worker identity, and the real company whose tasks it claims. Migration 62 fails
// closed in OPPOSITE directions on purpose — a company is real unless marked synthetic, a worker is
// restricted unless marked otherwise — and the consequence for a PRE-EXISTING worker is the
// substance of this check, because the owner's standing instruction is both
// *"do not disrupt the existing office iMac worker"* and *"do not silently widen existing
// identities"*. Those two pull in opposite directions across this migration, and which way it
// resolves is a deployment-ordering fact the operator has to know BEFORE applying it, not after.

'use strict';

process.env.ADMIN_EMAIL = 'm62-bootstrap@m62.invalid';
process.env.ADMIN_PASSWORD = `m-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.JWT_SECRET = `m62-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const REPO = path.join(__dirname, '..');
const HISTORICAL_COMMIT = '6b11bfb^';   // the commit that introduced migration 62; ^ is before it

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail += 1;
  lines.push(`  FAIL  ${m}`);
  if (extra !== undefined) lines.push(`          ${String(extra).slice(0, 300)}`);
};
const note = (m) => lines.push(`  --    ${m}`);
const step = (t) => lines.push('', `── ${t} ──`, '');

const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim();

(async () => {
  let cluster = null;
  let tree = process.env.M61_TREE || null;
  let treeIsMine = false;

  try {
    // ── THE HISTORICAL TREE ────────────────────────────────────────────────
    if (!tree) {
      tree = path.join(require('os').tmpdir(), `m61-${crypto.randomBytes(6).toString('hex')}`);
      try {
        git('worktree', 'add', '--detach', tree, HISTORICAL_COMMIT);
        treeIsMine = true;
      } catch (e) {
        console.log(`NOT EXECUTED  cannot create a worktree at ${HISTORICAL_COMMIT}: ${e.message}`);
        process.exit(EXIT_NOT_EXECUTED);
      }
    }
    // The historical tree needs its dependencies. The DEPENDENCY SET is not what is under test —
    // the migration code is — and package.json is identical across these commits, so the current
    // tree's node_modules is the honest choice. Asserted rather than assumed, below.
    const nm = path.join(tree, 'node_modules');
    if (!fs.existsSync(nm)) {
      fs.symlinkSync(path.join(REPO, 'node_modules'), nm, 'dir');
    }

    cluster = PG.create({ label: 'migration-62-genuine-upgrade' });
    process.env.DATABASE_URL = cluster.url;

    // ── 0. THE HISTORICAL TREE IS GENUINELY PRE-MIGRATION-62 ───────────────
    step('0. the tree this database will be built by has never heard of migration 62');

    const sha = git('rev-parse', '--short', HISTORICAL_COMMIT);
    note(`historical tree: ${tree} at ${sha}`);
    if (!fs.existsSync(path.join(tree, 'src/lib/worker/synthetic-isolation.js'))) {
      ok(`${sha} has no src/lib/worker/synthetic-isolation.js — this is a real migration-61 tree, `
        + 'not today\'s schema with columns removed');
    } else {
      bad('the historical tree contains synthetic-isolation.js, so it is not pre-migration-62 and '
        + 'this check is measuring nothing');
    }
    const histPkg = fs.readFileSync(path.join(tree, 'package.json'), 'utf8');
    if (histPkg === fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) {
      ok('and its package.json is byte-identical to today\'s, so sharing node_modules changes '
        + 'nothing about what is being measured');
    } else {
      note('package.json differs between the trees; the shared node_modules is the current set. '
        + 'The migration code is what is under test, but record this if a step fails oddly');
    }

    // ── 1. BUILD A MIGRATION-61 DATABASE WITH THE HISTORICAL MIGRATORS ─────
    step('1. the historical migrators build the database');

    const histLog = [];
    const histRequire = (rel) => require(path.join(tree, rel));
    let histQuery;
    try {
      const histDB = histRequire('src/lib/db');
      histQuery = histDB.query;
      const result = await histRequire('src/lib/migrate-all').runAll(histQuery,
        { log: (m) => histLog.push(m), seeds: true });
      const failedSteps = (result && result.failed) || [];
      if (failedSteps.length === 0) {
        ok(`the historical migrate-all completed: ${(result.steps || []).length} steps, 0 failures`);
      } else {
        bad(`the historical migrator reported ${failedSteps.length} failed step(s)`,
          JSON.stringify(failedSteps).slice(0, 240));
      }
      // The worker tables are applied outside migrate-all, by the worker and office paths.
      await histRequire('src/lib/worker/leases').migrateWorkerTasks(histQuery);
      await histRequire('src/lib/worker/identity').migrateWorkerIdentity(histQuery);
      ok('and the historical worker-task and worker-identity migrators applied');
    } catch (e) {
      bad(`the historical migrators failed: ${e.message}`);
      lines.push(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
    }

    // ── 2. THE PRE-MIGRATION STATE, ASSERTED, NOT ASSUMED ──────────────────
    step('2. what migration 61 actually left behind');

    const colOf = async (table, column) => {
      const r = await histQuery(
        `SELECT data_type, column_default, is_nullable FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`, [table, column]);
      return r.rows[0] || null;
    };
    const absent = [];
    for (const [t, c] of [['companies', 'is_synthetic'], ['worker_identities', 'synthetic_only'],
      ['worker_enrollment_tokens', 'synthetic_only']]) {
      if (await colOf(t, c)) absent.push(`${t}.${c} EXISTS`);
    }
    if (absent.length === 0) {
      ok('none of the three migration-62 columns exists — confirmed by reading the catalog of the '
        + 'database the historical code just built');
    } else {
      bad('a migration-62 column already exists before the migration ran', absent.join('; '));
    }

    // PRE-EXISTING STATE, created by the historical code: the real company, and the office iMac's
    // identity with hardware capabilities. This is the state an operator actually has.
    const REAL_CO = 'abiozen-standin';
    await histQuery(
      `INSERT INTO companies (id, slug, display_name, status)
       VALUES ($1,$1,'Real trading company (fixture)','active')`, [REAL_CO]);
    const histIdentity = histRequire('src/lib/worker/identity');
    let imac = null;
    try {
      const tok = await histIdentity.createEnrollmentToken({
        label: 'office-imac-standin',
        capabilities: ['exec:hardware', 'exec:gui'],
        createdBy: 'migration-61-fixture',
      }, { query: histQuery });
      imac = tok;
      ok('the historical code minted a hardware-capable enrollment token — note that it accepted '
        + '`createdBy` as a plain string, which is the gap commit 50a5f83 later closed');
    } catch (e) {
      note(`the historical mint refused (${e.message}); inserting the identity row directly, which `
        + 'is what the pre-migration database would hold either way');
    }
    const IMAC_ID = `imac-${crypto.randomUUID().slice(0, 8)}`;
    await histQuery(
      // The real column names, read from identity-schema.js rather than guessed: there is no
      // `status` column (revocation is revoked_at/revoked_by/revoked_reason) and the secret column
      // is `secret_current`. My first fixture invented both, which failed loudly here — and would
      // have failed identically against TODAY's schema, because the two are the same. The lesson is
      // not about history: a fixture that names columns from memory is measuring my memory.
      `INSERT INTO worker_identities (id, label, capabilities, enrolled_by, secret_current)
       VALUES ($1,'office-imac',$2,'migration-61-fixture',$3)`,
      [IMAC_ID, ['exec:hardware', 'exec:gui'], crypto.randomBytes(32).toString('hex')]);
    const pre = await histQuery(
      'SELECT id, capabilities, revoked_at FROM worker_identities WHERE id = $1', [IMAC_ID]);
    if (pre.rows.length === 1) {
      ok(`a pre-existing hardware worker identity is in place (${pre.rows[0].capabilities.join(', ')})`);
    } else {
      bad('could not establish the pre-existing worker identity');
    }

    // ── 3. APPLY TODAY'S MIGRATION 62 TO THAT DATABASE ─────────────────────
    step('3. today\'s migration 62, applied to the historical database');

    // Today's module, against the database the historical code built. Nothing is dropped,
    // reconstructed or re-created in between.
    const SYN = require('../src/lib/worker/synthetic-isolation');
    const DB_TODAY = require('../src/lib/db');
    const inventory = await SYN.inventoryForMigration62(DB_TODAY.query);
    note(`pre-migration inventory (read-only): ${JSON.stringify(inventory).slice(0, 220)}`);
    try {
      await SYN.installSyntheticIsolation(DB_TODAY.query);
      ok('installSyntheticIsolation applied to the historical database without error');
    } catch (e) {
      bad(`migration 62 failed against a genuine migration-61 database: ${e.message}`);
    }
    try {
      await SYN.installSyntheticIsolation(DB_TODAY.query);
      ok('and again — the migration is idempotent, which is what a re-deploy will do to it');
    } catch (e) {
      bad(`migration 62 is not idempotent: ${e.message}`);
    }

    // ── 4. THE COLUMNS, AND THE DIRECTIONS THEY FAIL IN ────────────────────
    step('4. the two defaults point in OPPOSITE directions, deliberately');

    const coCol = await colOf('companies', 'is_synthetic');
    if (coCol && /false/i.test(String(coCol.column_default)) && coCol.is_nullable === 'NO') {
      ok('companies.is_synthetic is NOT NULL DEFAULT false — a company is REAL unless somebody '
        + 'says otherwise, so forgetting to mark one cannot expose it to a synthetic worker');
    } else {
      bad('companies.is_synthetic has the wrong shape', JSON.stringify(coCol));
    }
    for (const t of ['worker_identities', 'worker_enrollment_tokens']) {
      const c = await colOf(t, 'synthetic_only');
      if (c && /true/i.test(String(c.column_default)) && c.is_nullable === 'NO') {
        ok(`${t}.synthetic_only is NOT NULL DEFAULT true — a worker is RESTRICTED unless somebody `
          + 'says otherwise');
      } else {
        bad(`${t}.synthetic_only has the wrong shape`, JSON.stringify(c));
      }
    }

    // ── 5. WHAT HAPPENED TO THE STATE THAT WAS ALREADY THERE ───────────────
    step('5. the pre-existing company and the pre-existing worker');

    const coAfter = await DB_TODAY.query(
      'SELECT id, is_synthetic FROM companies WHERE id = $1', [REAL_CO]);
    if (coAfter.rows[0] && coAfter.rows[0].is_synthetic === false) {
      ok('the pre-existing real company was NOT marked synthetic by the migration — the backfill '
        + 'is the safe direction, and a real company stays real');
    } else {
      bad('the migration marked a pre-existing company synthetic', JSON.stringify(coAfter.rows[0]));
    }

    const idAfter = await DB_TODAY.query(
      'SELECT id, capabilities, synthetic_only, revoked_at FROM worker_identities WHERE id = $1',
      [IMAC_ID]);
    const row = idAfter.rows[0] || {};
    if (row.synthetic_only === true) {
      ok('the pre-existing hardware identity came out of the migration RESTRICTED — it was NOT '
        + 'silently widened, which is the owner\'s standing instruction');
    } else {
      bad('a pre-existing identity was silently widened by the migration', JSON.stringify(row));
    }
    if (Array.isArray(row.capabilities)
        && row.capabilities.includes('exec:hardware') && row.capabilities.includes('exec:gui')) {
      ok('and its capabilities are untouched — the migration narrowed its SCOPE, not its grants');
    } else {
      bad('the migration altered the identity\'s capabilities', JSON.stringify(row.capabilities));
    }

    // ── 6. THE DEPLOYMENT-ORDERING CONSEQUENCE ─────────────────────────────
    step('6. and therefore: what applying this to production actually does');

    const LEASES = require('../src/lib/worker/leases');
    // Through the accessor, for the same reason as everywhere else: it knows the columns and the
    // NOT NULL intent_key, and it refuses an unknown task type.
    const queued = await LEASES.enqueueTask({
      taskType: 'synthetic.echo', payload: {}, companyId: REAL_CO,
      intentKey: `m62-${crypto.randomUUID()}`, workflow: 'm62-check', createdBy: 'm62-fixture',
    }, { query: DB_TODAY.query });
    if (!queued || queued.ok === false) {
      bad('could not enqueue the real company task', JSON.stringify(queued).slice(0, 200));
    } else {
      ok('a task is queued for the pre-existing REAL company');
    }

    let claimed = null;
    try {
      claimed = await LEASES.claimTask({ workerId: IMAC_ID }, { query: DB_TODAY.query });
    } catch (e) {
      claimed = { ok: false, error: e.message };
    }
    if (claimed && claimed.ok !== true) {
      ok('the restored identity can no longer claim the REAL company\'s queued task. The claim '
        + 'path reads the new columns and refuses, exactly as designed');
      note(`refusal: ${JSON.stringify({ ok: claimed.ok, code: claimed.code || claimed.reason
        || claimed.error }).slice(0, 180)}`);
      note('**THIS IS THE DEPLOYMENT-ORDERING FACT.** Migration 62 fails closed, so the moment it '
        + 'is applied, every pre-existing worker identity — the office iMac included — stops '
        + 'claiming real-company work until an operator deliberately sets synthetic_only = false '
        + 'for it. That is the correct behaviour and it is NOT a silent one: it is a visible stop. '
        + 'But it means the operator step is a PREREQUISITE of applying migration 62 to a '
        + 'database with live workers, not a follow-up to it.');
    } else {
      bad('a restricted-by-default identity claimed a real company\'s task, so the migration did '
        + 'not fail closed', JSON.stringify(claimed).slice(0, 200));
    }

    // And the deliberate widening works, which is what the operator will do.
    await DB_TODAY.query(
      'UPDATE worker_identities SET synthetic_only = false WHERE id = $1', [IMAC_ID]);
    let afterWiden = null;
    try {
      afterWiden = await LEASES.claimTask({ workerId: IMAC_ID }, { query: DB_TODAY.query });
    } catch (e) {
      afterWiden = { ok: false, error: e.message };
    }
    if (afterWiden && afterWiden.ok === true) {
      ok('and once an operator widens it deliberately, the iMac claims the task again — so the '
        + 'stop is recoverable by one UPDATE, and §6 measured the new column rather than some '
        + 'unrelated breakage');
    } else {
      bad('widening the identity did not restore the claim, so the refusal above was caused by '
        + 'something other than synthetic_only', JSON.stringify(afterWiden).slice(0, 220));
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 6).join('\n'));
  } finally {
    try { if (cluster) cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
    if (treeIsMine && tree) {
      try {
        fs.unlinkSync(path.join(tree, 'node_modules'));
      } catch (_) { /* the link may not have been made */ }
      try {
        execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', tree],
          { stdio: 'ignore' });
      } catch (_) {
        lines.push(`  --    the worktree at ${tree} could not be removed; remove it by hand`);
      }
    }
  }

  console.log('══ MIGRATION 62 ON A GENUINE MIGRATION-61 DATABASE ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
