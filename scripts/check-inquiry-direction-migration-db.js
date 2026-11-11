#!/usr/bin/env node
// ── THE SINGLE-PURPOSE MIGRATION, AGAINST A REAL SERVER ──────────────────────
//
//   node scripts/check-inquiry-direction-migration-db.js
//
// CEO decision 2026-11-11 task 2: "Test it against a disposable database containing the
// previous-release schema and representative records."
//
// So this builds the PREVIOUS-RELEASE shape — inquiry_messages with the two-value CHECK — seeds
// representative rows, and then drives scripts/migrate-inquiry-direction-check.js through every
// path that matters: read-only, apply, repeat, the incompatible-row refusal, the rollback refusal
// that must never relabel a draft as sent, and the lock timeout.
//
// A disposable cluster is created and destroyed. Nothing here touches production, and the
// migration under test writes no data by design — which is asserted, not assumed.
//
// EXIT 3 when no Postgres is available, so a missing server is reported as NOT EXECUTED rather
// than counted as a pass. preflight distinguishes the two.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Postgres discovery and the initdb flags come from the SHARED module, not from a local copy.
// scripts/pg-harness-discipline.test.js refuses a harness that rolls its own, and it caught this
// file within minutes of it being written — correctly: 33 harnesses once skipped silently because
// each had its own idea of where Postgres lives, and a hard-coded version list is how one of them
// stops finding a server after an image upgrade and reports SKIP forever.
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let temp = null;
const findInitdb = pgBin;

function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/dircheck-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55993 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55993&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asRoot
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.DIRCHECK_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set DIRCHECK_PG_URL or install initdb)');
  console.log('SKIP  the single-purpose migration was NOT exercised — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

let pass = 0;
let fail = 0;
let undone = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.error(`  FAIL  ${m}${d ? `\n        ${d}` : ''}`); };
const note = (m) => console.log(`  --    ${m}`);
// A phase that could not run is its own verdict. Counting it as a pass is the failure mode this
// repo's release discipline exists to prevent, and printing it as a note makes it invisible.
const incomplete = (m) => { undone += 1; console.error(`  INCOMPLETE  ${m}`); };

// The migration runs as its own process, exactly as it will in production, so what is tested is
// the shipped entry point rather than a re-implementation of it.
function runMigration(args = [], env = {}) {
  const r = require('child_process').spawnSync(
    process.execPath, [path.join(__dirname, 'migrate-inquiry-direction-check.js'), ...args],
    { env: { ...process.env, MIGRATION_DATABASE_URL: url, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// The INDEPENDENT verifier, driven as its own process. CEO ruling 2026-11-11: the constraint must
// be inspected by a separate read-only query rather than by asking the migration script whether
// its own change happened. Exercised here in BOTH states, because a verifier that only ever sees
// the migrated database cannot be shown to detect the unmigrated one.
function runVerifier() {
  const r = require('child_process').spawnSync(
    process.execPath, [path.join(__dirname, 'verify-inquiry-direction-constraint.js')],
    { env: { ...process.env, MIGRATION_DATABASE_URL: url }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const defOf = async () => (await q(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname = 'inquiry_messages' AND c.conname = 'inquiry_messages_direction_check'`
  )).rows[0]?.def || null;

  // ── THE PREVIOUS-RELEASE SCHEMA, copied from src/lib/db.js as it stood before S2 ──
  const buildPrevious = async () => {
    await q(`DROP TABLE IF EXISTS inquiry_messages`);
    await q(`CREATE TABLE inquiry_messages (
      id TEXT PRIMARY KEY,
      inquiry_id TEXT,
      direction TEXT CONSTRAINT inquiry_messages_direction_check
        CHECK (direction IN ('inbound','outbound')),
      sender_name TEXT, sender_email TEXT, subject TEXT,
      body_text TEXT, body_html TEXT, sent_at TEXT, read_at TEXT,
      created_at TEXT DEFAULT NOW())`);
    await q(`CREATE INDEX idx_inq_msg ON inquiry_messages (inquiry_id, created_at)`);
    // Representative records: both live directions, a NULL (the column is nullable and a CHECK
    // passes on NULL, so this must NOT read as an incompatible row), and realistic bodies.
    await q(`INSERT INTO inquiry_messages (id, inquiry_id, direction, sender_email, subject, body_text)
      VALUES
        ('m1','inq-1','inbound','buyer@acme-pharma.test','Gemcitabine 12kg','Please quote 12 kg.'),
        ('m2','inq-1','outbound','sales@abiozen.com','Re: Gemcitabine 12kg','Thank you for your enquiry.'),
        ('m3','inq-1','outbound','sales@abiozen.com','Quotation QT-2026-INQ001','Total USD 48,150.'),
        ('m4','inq-2','inbound','prof@uni.test','Catalyst enquiry','Do you supply this?'),
        ('m5','inq-2',NULL,'sales@abiozen.com','(no direction recorded)','legacy row')`);
  };

  try {
    await buildPrevious();
    note('previous-release schema built: two-value CHECK, 5 representative rows incl. one NULL');

    // ══ 1. READ-ONLY MODE CHANGES NOTHING ══════════════════════════════════
    {
      const before = await defOf();
      const r = runMigration([]);
      const after = await defOf();
      if (r.code === 0 && before === after && !/outbound_pending/.test(after || '')) {
        ok('read-only mode reports and changes nothing');
      } else bad('read-only mode altered the constraint or exited non-zero', `code=${r.code}`);
      if (/READ-ONLY/.test(r.out) && /WOULD, in ONE transaction/.test(r.out)) {
        ok('it states what it would do, and that it has not');
      } else bad('read-only output does not say what it would do', r.out.slice(0, 300));
      // The surveyed facts an operator needs before authorising.
      for (const expect of [/5 row\(s\)/, /incompatible with the new predicate: 0/, /table owner/, /size /]) {
        if (!expect.test(r.out)) bad(`the survey omits ${expect}`, r.out.slice(0, 400));
      }
      if (/incompatible with the new predicate: 0/.test(r.out)) {
        ok('a NULL direction is NOT counted as an incompatible row — a CHECK passes on NULL');
      }
    }

    // ══ 1c. THE INDEPENDENT VERIFIER SEES THE UNMIGRATED STATE ═════════════
    {
      const v = runVerifier();
      if (v.code === 1 && /does NOT admit/.test(v.out)) {
        ok('the independent verifier reports FAIL before the migration (exit 1)');
      } else {
        bad('the independent verifier does not detect the unmigrated constraint',
          `code=${v.code}\n${v.out.slice(0, 300)}`);
      }
      if (/admits: inbound, outbound$/m.test(v.out)) {
        ok('and it names the values it parsed, rather than only a verdict');
      } else bad('the verifier does not report the parsed value set', v.out.slice(0, 300));
    }

    // ══ 2. APPLY ═══════════════════════════════════════════════════════════
    {
      const t0 = Date.now();
      const r = runMigration(['--apply']);
      const ms = Date.now() - t0;
      const after = await defOf();
      if (r.code === 0 && /outbound_pending/.test(after || '')) {
        ok(`--apply committed the widened constraint in ${ms} ms (process wall time)`);
      } else bad('--apply did not produce the target constraint', `code=${r.code}\n${r.out.slice(0, 400)}`);
      if (/no data was written/.test(r.out)) ok('it verifies post-commit that no data was written');
      else bad('no post-commit data assertion in the output');

      const n = (await q(`SELECT COUNT(*)::int n FROM inquiry_messages`)).rows[0].n;
      if (n === 5) ok('all 5 rows survived, unmodified');
      else bad(`row count is ${n}, expected 5`);
    }

    // ══ 2b. AND IT SEES THE MIGRATED STATE, BY ITS OWN QUERY ═══════════════
    {
      const v = runVerifier();
      if (v.code === 0 && /PASS — the constraint admits exactly/.test(v.out)) {
        ok('the independent verifier reports PASS after the migration (exit 0)');
      } else {
        bad('the independent verifier does not confirm the migrated constraint',
          `code=${v.code}\n${v.out.slice(0, 300)}`);
      }
      // It must be genuinely independent: no shared module with the thing it verifies.
      // Comments stripped first. The verifier's own header NAMES the migration script, in the
      // sentence explaining that it shares no code with it — so a raw grep matched prose and
      // failed a correct file. Third time today that a guard has read a comment as code.
      const vsRaw = fs.readFileSync(path.join(__dirname, 'verify-inquiry-direction-constraint.js'), 'utf8');
      const vs = vsRaw.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
      if (!/migrate-inquiry-direction-check/.test(vs)) {
        ok('and it requires nothing from the migration script — two readings, not one taken twice');
      } else bad('the verifier imports the migration script, so it is not independent');
      if (/default_transaction_read_only/.test(vsRaw)) {
        ok('and it declares the session read-only at the server');
      } else bad('the verifier does not declare itself read-only');
    }

    // ══ 3. THE NEW VALUE IS NOW ACCEPTED, AND NOTHING ELSE IS ══════════════
    {
      await q(`INSERT INTO inquiry_messages (id, inquiry_id, direction, subject)
               VALUES ('m6','inq-3','outbound_pending','Quotation QT-2026-INQ003 (draft)')`);
      ok("'outbound_pending' is accepted after the migration");
      try {
        await q(`INSERT INTO inquiry_messages (id, direction) VALUES ('m7','sent')`);
        bad("an arbitrary direction was accepted — the CHECK is not constraining anything");
      } catch (e) {
        if (/inquiry_messages_direction_check/.test(e.message)) {
          ok('an arbitrary direction is still refused — the constraint still constrains');
        } else bad('refused for an unexpected reason', e.message);
      }
    }

    // ══ 4. IDEMPOTENCE ════════════════════════════════════════════════════
    {
      const r = runMigration(['--apply']);
      if (r.code === 0 && /ALREADY APPLIED/.test(r.out)) {
        ok('a second --apply is a no-op, decided from the server\'s own definition');
      } else bad('repeat execution is not idempotent', `code=${r.code}\n${r.out.slice(0, 300)}`);
    }

    // ══ 5. THE ROLLBACK REFUSAL — THE ONE THAT MUST NOT LIE ════════════════
    note("rollback while a draft exists must refuse, and must not relabel it as sent");
    {
      const before = (await q(
        `SELECT direction FROM inquiry_messages WHERE id = 'm6'`)).rows[0].direction;
      const r = runMigration(['--rollback']);
      const after = (await q(
        `SELECT direction FROM inquiry_messages WHERE id = 'm6'`)).rows[0].direction;
      const def = await defOf();
      if (r.code === 1 && /REFUSING/.test(r.out)) ok('--rollback refuses while a draft exists');
      else bad('--rollback did not refuse', `code=${r.code}\n${r.out.slice(0, 300)}`);
      if (after === before && after === 'outbound_pending') {
        ok('the draft row is untouched — it was NOT relabelled as sent');
      } else bad(`the draft row changed from '${before}' to '${after}'`);
      if (/outbound_pending/.test(def || '')) ok('and the constraint is unchanged');
      else bad('the constraint was narrowed despite the refusal');
    }

    // ══ 6. ROLLBACK IS POSSIBLE ONLY WHEN NO DRAFT EXISTS ══════════════════
    {
      await q(`DELETE FROM inquiry_messages WHERE id = 'm6'`);
      const r = runMigration(['--rollback']);
      const def = await defOf();
      if (r.code === 0 && !/outbound_pending/.test(def || '')) {
        ok('with no draft rows, --rollback narrows the constraint cleanly');
      } else bad('rollback failed on a database with no drafts', `code=${r.code}\n${r.out.slice(0, 300)}`);
      // And forward again, so the fixture ends in the migrated state for the lock test.
      const f = runMigration(['--apply']);
      if (f.code === 0) ok('and it can be re-applied afterwards — the change is reversible both ways');
      else bad('could not re-apply after a rollback');
    }

    // ══ 7. AN INCOMPATIBLE ROW BLOCKS, BEFORE ANY ALTER ════════════════════
    note('a row the new predicate rejects must be reported, not discovered by a failing ALTER');
    {
      // Reachable only by widening the constraint first, which is exactly how such a row would
      // come to exist in the wild: an older, looser schema.
      await q(`ALTER TABLE inquiry_messages DROP CONSTRAINT inquiry_messages_direction_check`);
      await q(`INSERT INTO inquiry_messages (id, direction) VALUES ('m8','queued')`);
      await q(`ALTER TABLE inquiry_messages ADD CONSTRAINT inquiry_messages_direction_check
               CHECK (direction IN ('inbound','outbound'))  NOT VALID`);
      const r = runMigration(['--apply']);
      const def = await defOf();
      if (r.code === 1 && /row\(s\) hold a direction the new predicate rejects/.test(r.out)) {
        ok('an incompatible row is reported as a precondition failure');
      } else bad('an incompatible row was not caught before the ALTER', `code=${r.code}\n${r.out.slice(0, 300)}`);
      if (/SELECT DISTINCT direction/.test(r.out)) ok('and the output gives the query to list them');
      else bad('the operator is told there is a problem but not how to see it');
      if (!/outbound_pending/.test(def || '')) ok('the constraint was not changed');
      else bad('the constraint was widened despite an incompatible row');
      await q(`DELETE FROM inquiry_messages WHERE id = 'm8'`);
    }

    // ══ 8. THE LOCK TIMEOUT — THE WHOLE REASON THIS SCRIPT EXISTS ══════════
    note('a conflicting lock must fail fast and roll back, never block the table');
    {
      await q(`ALTER TABLE inquiry_messages DROP CONSTRAINT IF EXISTS inquiry_messages_direction_check`);
      await q(`ALTER TABLE inquiry_messages ADD CONSTRAINT inquiry_messages_direction_check
               CHECK (direction IN ('inbound','outbound'))`);

      // Hold ACCESS EXCLUSIVE in another session, so the migration cannot take its lock.
      const blocker = await new Pool({ connectionString: url, ssl: false }).connect();
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE inquiry_messages IN ACCESS EXCLUSIVE MODE');

      const t0 = Date.now();
      const r = runMigration(['--apply', '--lock-timeout=1s', '--statement-timeout=3s']);
      const waited = Date.now() - t0;

      await blocker.query('ROLLBACK');
      blocker.release();

      const def = await defOf();
      // It now fails in the SURVEY, which is correct: counting rows takes ACCESS SHARE, and that
      // conflicts with the blocker too. The first version of the migration set its bounds only
      // inside the transaction, so this very case hung for five minutes in the read-only phase —
      // the script carrying the exact failure it exists to prevent.
      if (r.code === 1) ok('the blocked migration exited non-zero rather than hanging');
      else bad('a blocked migration did not fail', `code=${r.code}\n${r.out.slice(0, 300)}`);
      if (waited < 20000) ok(`it gave up after ${waited} ms rather than waiting indefinitely`);
      else bad(`it waited ${waited} ms — the lock bound is not in force`);
      if (/conflicting lock/i.test(r.out) && /pg_stat_activity/.test(r.out)) {
        ok('and it names the cause and the query to find the holder');
      } else bad('a lock failure does not explain itself', r.out.slice(0, 400));
      if (!/outbound_pending/.test(def || '')) ok('nothing was changed');
      else bad('the constraint changed despite the lock failure');

      // Once the blocker is gone it must succeed, or the control above proves nothing.
      const after = runMigration(['--apply']);
      if (after.code === 0 && /outbound_pending/.test(await defOf() || '')) {
        ok('with the lock released it applies normally — the timeout is not a permanent failure');
      } else bad('could not apply after the lock cleared', after.out.slice(0, 300));
    }

    // ══ 9. IT TOUCHES NOTHING ELSE ═════════════════════════════════════════
    {
      const src = fs.readFileSync(path.join(__dirname, 'migrate-inquiry-direction-check.js'), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
      for (const forbidden of ['runAll', 'SEED_STEPS', 'ensureCompany', 'seedMoleculePricing',
        'initDB', 'migrateSchemas', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'TRUNCATE', 'DROP TABLE']) {
        if (code.includes(forbidden)) {
          bad(`the migration references ${forbidden} — it must touch one constraint and nothing else`);
        }
      }
      ok('no seeds, no company upsert, no unrelated step, and no data statement of any kind');
      if (/SET LOCAL lock_timeout/.test(code) && /SET LOCAL statement_timeout/.test(code)) {
        ok('both bounds are SET LOCAL, so they die with the transaction');
      } else bad('the timeouts are not SET LOCAL and could leak into the session');
      // Scoped BETWEEN the BEGIN and the COMMIT, not by first occurrence. The first version took
      // indexOf('ADD CONSTRAINT …') and found the DRY-RUN PREVIEW text, which sits before the
      // transaction — so a correct file failed. A guard that matches the wrong occurrence reports
      // a defect in code it is not looking at.
      const begin = code.indexOf("'BEGIN'");
      const commit = code.indexOf("'COMMIT'");
      if (begin > 0 && commit > begin) {
        const body = code.slice(begin, commit);
        if (/ADD CONSTRAINT \$\{CONSTRAINT\}/.test(body) && /DROP CONSTRAINT IF EXISTS/.test(body)) {
          ok('both ALTERs are inside the explicit transaction');
        } else bad('an ALTER sits outside the BEGIN/COMMIT block');
        if (/SET LOCAL lock_timeout/.test(body)) ok('and the bounds are set inside it');
        else bad('the transaction does not set its own bounds');
      } else bad('no explicit BEGIN/COMMIT found');
    }
    // ══ 10. THE PREDEPLOY ROLE — CAN RAILWAY RUN THIS AT ALL? ══════════════
    //
    // CEO ruling 2026-11-11 step 7: "Confirm the predeploy environment can execute the dedicated
    // migration with the required database permissions."
    //
    // This is a question about MY OWN config change, and it could have been a NO-GO. railway.json
    // now runs this script as preDeployCommand, which means it runs on EVERY deploy, as whatever
    // role that environment holds. ENG-003 deliberately made the application role least-privilege
    // with no DDL — so if preDeploy inherits DATABASE_URL and that role does not own
    // inquiry_messages, an ALTER is impossible and preDeploy would fail, blocking every future
    // deploy of the service.
    //
    // It does not, for one reason: the idempotence short-circuit is decided from the server's own
    // constraint definition and returns BEFORE the ownership precondition is read. Once Phase C
    // has applied the constraint by hand, every later run exits 0 at "ALREADY APPLIED" without
    // ever needing ALTER rights.
    //
    // That ordering was not designed; it fell out of writing the survey before the preconditions.
    // A property the deploy pipeline depends on cannot be left resting on an accident, so it is
    // pinned here. If someone moves the ownership check above the short-circuit, this fails — and
    // what it is really protecting is the deploy, not the test.
    {
      const LOW = 'deploy_leastpriv';
      let lowUrl = null;
      try {
        if (!/:\/\/postgres@/.test(url)) throw new Error('not the harness-built cluster');
        await q(`REVOKE ALL ON inquiry_messages FROM ${LOW}`).catch(() => {});
        await q(`DROP ROLE IF EXISTS ${LOW}`);
        await q(`CREATE ROLE ${LOW} LOGIN`);
        await q(`GRANT USAGE ON SCHEMA public TO ${LOW}`);
        await q(`GRANT SELECT ON inquiry_messages TO ${LOW}`);
        lowUrl = url.replace('://postgres@', `://${LOW}@`);
      } catch (e) {
        incomplete('phase 10 could not build a least-privilege role, so the predeploy permission '
          + `question is UNANSWERED by this run: ${(e && e.message) || e}`);
      }

      if (lowUrl) {
        const runLow = (args = []) => runMigration(args, { MIGRATION_DATABASE_URL: lowUrl });

        // The role must genuinely lack what an ALTER needs, or everything below proves nothing.
        const canAlter = (await q(
          `SELECT pg_has_role($1, rel.relowner, 'USAGE') AS can_alter
             FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace
            WHERE n.nspname = 'public' AND rel.relname = 'inquiry_messages'`, [LOW])).rows[0].can_alter;
        if (canAlter === false) ok(`${LOW} does not own inquiry_messages — it cannot ALTER it`);
        else bad(`${LOW} can ALTER the table, so this phase tests nothing`);

        // ── the case that actually runs in production, on every deploy ──
        if (!/outbound_pending/.test(await defOf() || '')) runMigration(['--apply']);
        const applied = runLow(['--apply']);
        if (applied.code === 0) {
          ok('against an already-migrated database the least-privilege role exits 0 — preDeploy '
            + 'cannot fail on permissions after the constraint is applied by hand');
        } else {
          bad('the least-privilege role CANNOT run the predeploy command against a migrated '
            + 'database — railway.json would block every deploy', `code=${applied.code}\n        ${applied.out.slice(0, 400)}`);
        }
        if (/ALREADY APPLIED/.test(applied.out)) {
          ok('and it exits there by idempotence, not by acquiring a lock it has no right to');
        } else bad('exit 0 did not come from the idempotence short-circuit', applied.out.slice(0, 400));
        if (/ALTER permitted: NO/.test(applied.out)) {
          ok('its own survey reports ALTER permitted: NO, and it proceeds anyway — correctly, '
            + 'because there is nothing left to alter');
        } else bad('the run did not report the missing ALTER right', applied.out.slice(0, 400));
        if (!/ADD CONSTRAINT/.test(applied.out.replace(/target\s+CHECK[^\n]*/g, ''))) {
          ok('and it issued no DDL');
        } else bad('it attempted DDL as an unprivileged role', applied.out.slice(0, 400));

        // ── the control: UNMIGRATED, same role. It must refuse, loudly. ──
        //
        // Without this, a pass above is consistent with the script never checking anything. And
        // this is the state preDeploy sees if a deploy ever lands BEFORE Phase C is run by hand,
        // so the refusal has to be legible rather than a stack trace.
        await q(`DELETE FROM inquiry_messages WHERE direction = 'outbound_pending'`);
        await q(`ALTER TABLE inquiry_messages DROP CONSTRAINT inquiry_messages_direction_check`);
        await q(`ALTER TABLE inquiry_messages ADD CONSTRAINT inquiry_messages_direction_check
                 CHECK (direction IN ('inbound','outbound'))`);
        const unmig = runLow(['--apply']);
        if (unmig.code !== 0) {
          ok('against an UNMIGRATED database the same role refuses with a non-zero exit');
        } else bad('an unprivileged role reported success on an unmigrated database — the ALTER '
          + 'either did not happen or was not checked', unmig.out.slice(0, 400));
        if (/is not a member of/.test(unmig.out) && new RegExp(LOW).test(unmig.out)) {
          ok('naming the role and the owner, so the operator knows it is a grant and not a bug');
        } else bad('the refusal does not explain that it is a permissions problem', unmig.out.slice(0, 400));
        if (!/outbound_pending/.test(await defOf() || '')) {
          ok('and the constraint is untouched by the refused run');
        } else bad('the constraint changed during a run that refused');

        await q(`REVOKE ALL ON inquiry_messages FROM ${LOW}`).catch(() => {});
        await q(`DROP ROLE IF EXISTS ${LOW}`).catch(() => {});
      }
    }
  } catch (e) {
    bad(`the harness itself failed: ${(e && e.message) || e}`);
  } finally {
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(`\n  ${pass} assertion(s) passed · ${fail} failed`
    + `${undone ? ` · ${undone} phase(s) NOT EXECUTED` : ''}`);
  if (!fail && undone) {
    console.log('\nINCOMPLETE  everything that ran passed, but a phase did not run. Read the');
    console.log('            INCOMPLETE line above; this is not a pass.');
    process.exit(EXIT_NOT_EXECUTED);
  }
  if (fail) {
    console.log('\nFAIL  the single-purpose migration is not safe to run on production.');
    process.exit(1);
  }
  console.log('\nPASS  one constraint, one transaction, bounded locks, idempotent, and a rollback');
  console.log('      that refuses rather than relabelling a draft as sent.');
  process.exit(0);
})();
