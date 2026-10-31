#!/usr/bin/env node
// ── DOES THE RECONCILIATION RUN TO THE END? ──────────────────────────────────
//
//   node scripts/check-reconcile-runs.js
//
// Exit 0 = e1-reconcile's main() ran to completion against a local database built from the real
// schema. Exit 1 if it threw. Touches no production data.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// On 31 Oct at 11:14 the reconciliation printed every proof — proof 1 through the recovery section —
// and then died:
//
//   ✗ reconciliation could not run: after is not defined
//
// `after` had been the post-pass molecule count from proof 10. Removing that pass left the recovery
// section reading a variable that no longer existed. `node --check` parses a file; it cannot see an
// undefined reference. The project has no linter. And nothing in preflight executed main(), so the
// ONLY thing that could find it was a production run over an SSH connection that had already failed
// twice that morning.
//
// A 92-line edit to a verification script went out with a runtime error in its last section, and the
// cost was another deploy-and-retry cycle on the one result Gate 1 was waiting for.
//
// So: run it. Not to check its verdict — against fixtures the verdict is meaningless and this
// asserts nothing about it — but to prove every line executes. An undefined reference, a column that
// does not exist, a renamed export: all of them surface here, locally, in seconds.
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// SYNCHRONOUS output, deliberately. console.log to a pipe is an async write, and process.exit()
// discards whatever has not drained — the first run of this script printed NOTHING at all and
// exited 1, which is the "read the exit code not the output" lesson inverted: a verdict that can be
// silently dropped. These bypass the console entirely, and they keep working while this script
// suppresses console.log to silence the reconciliation it is running.
const say = (m) => fs.writeSync(1, `${m}\n`);
const err = (m) => fs.writeSync(2, `${m}\n`);

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { try { fs.accessSync(`${d}/initdb`); return d; } catch (_) { /* next */ } }
  return null;
}

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/recruns-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55994 -c listen_addresses=' start -w`);
  } catch (_) { return null; }
  temp = { base, dir, asPostgres };
  return base;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c ${JSON.stringify(`pg_ctl -D ${temp.base}/data stop -m immediate`)}`
      : `pg_ctl -D ${temp.base}/data stop -m immediate`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

const sock = startTemp();
if (!sock) {
  err('SKIP  no local postgres available — cannot prove the reconciliation runs');
  process.exit(1);
}
// Before any require that builds a pool: db.js reads these at module load, and with DATABASE_URL
// absent it uses PG* with ssl:false.
delete process.env.DATABASE_URL;
process.env.PGHOST = sock;
process.env.PGPORT = '55994';
process.env.PGUSER = 'postgres';
process.env.PGDATABASE = 'postgres';
// initDB() refuses to run without these when no admin user exists. Deliberately obvious fixture
// values for a throwaway local database that is deleted at the end of this script — never a real
// credential, and nothing here can reach production: DATABASE_URL is unset above.
process.env.ADMIN_EMAIL = 'fixture-admin@localhost.invalid';
process.env.ADMIN_PASSWORD = 'fixture-only-not-a-real-password';

const { query } = require('../src/lib/db');

(async () => {
  let failed = 0;
  const realLog = console.log;
  try {
    // The source tables E1 reads. Minimal shapes matching the real columns the reconciliation uses.
    await query(`
      CREATE TABLE IF NOT EXISTS study_molecules (
        id BIGSERIAL PRIMARY KEY, study_id TEXT, molecule_name TEXT NOT NULL, cas_number TEXT);
      CREATE TABLE IF NOT EXISTS research_interests (
        id BIGSERIAL PRIMARY KEY, lab_id BIGINT, kind TEXT, value TEXT, cas TEXT);
      CREATE TABLE IF NOT EXISTS supplier_products (
        id BIGSERIAL PRIMARY KEY, product_name TEXT, cas TEXT);
    `);
    // A couple of rows, so the proofs have something to read rather than a uniformly empty database
    // where a broken query might pass by returning nothing.
    await query(`INSERT INTO study_molecules (study_id, molecule_name, cas_number) VALUES
      ('NCT-1','Leuprolide','53714-56-0'), ('NCT-2','Leuprolide Acetate','74381-53-6'),
      ('NCT-3','Warfarin','81-81-2')`);
    await query(`INSERT INTO supplier_products (product_name, cas) VALUES ('Warfarin Sodium','129-06-6')`);

    const { DDL_TABLES, DDL_TRIGGERS, applyTargetColumns, applyConflictKinds,
      applyDriftColumns } = require('./migrate-molecules');
    await query(DDL_TABLES);
    await query(DDL_TRIGGERS);
    await applyConflictKinds(query);
    await applyDriftColumns(query);
    await applyTargetColumns(query);

    // initDB() inside main() runs the whole db.js migration suite. It is idempotent and designed to
    // run at every boot, so letting it run here is the honest thing: it is what production does.
    const reconcile = require('./e1-reconcile');
    if (typeof reconcile.main !== 'function') {
      err('  FAIL  e1-reconcile does not export main — nothing to execute');
      failed = 1;
    } else {
      // Its own output is suppressed: this asserts that it RUNS, not what it concluded. Against
      // fixtures the verdict carries no meaning and reporting it would invite someone to trust it.
      // Captured rather than discarded: the negative controls below have to prove the
      // reconciliation failed FOR THE RIGHT REASON, which means reading what it said.
      const run = async () => {
        const lines = [];
        console.log = (...a) => lines.push(a.map(String).join(' '));
        try { return { fail: await reconcile.main(), out: lines.join('\n') }; }
        finally { console.log = realLog; }
      };

      const base = await run();
      if (typeof base.fail === 'number') {
        say(`  ok    the reconciliation ran to completion (${base.fail} fixture proof(s) did not hold, which is expected and asserted nothing)`);
      } else {
        say('  ok    the reconciliation ran to completion');
      }

      // ── NEGATIVE CONTROL ────────────────────────────────────────────────
      //
      // The permanent rule: every reconciliation must have a negative-control test proving it can
      // detect the defect it claims to detect. At Gate 1 closure this was the one gap in the
      // evidence framework — check-reconcile-runs proved every line EXECUTED, and nothing proved
      // the reconciliation could go RED on a planted defect.
      //
      // Its detection record was empirical and strong: it caught the 38 unauthorised molecules on
      // 29 Oct, an 11-proof failure on 31 Oct, the levoleucovorin drift and two more. But history
      // is not a control. A check that has only ever failed on real defects has not been shown to
      // fail on demand, and the day it stops detecting is the day nobody finds out.
      //
      // Both branches get their own control, because the reconciliation deliberately distinguishes
      // them and reports different remedies.
      const planted = [];

      // (a) UNEXPLAINED — a molecule no source row proposes. This is the 29 Oct signature: the
      //     authorised set and the code having diverged, the condition that produced 38 molecules
      //     the report promised to withhold.
      await query(
        `INSERT INTO molecules (preferred_name, normalized_name, source, derivation_method)
         VALUES ('Zzz Planted Unauthorised','zzz planted unauthorised','negative-control','test')`);
      planted.push('zzz planted unauthorised');
      const unexp = await run();
      if (unexp.fail > base.fail
        && unexp.out.includes('zzz planted unauthorised')
        && /cannot explain/.test(unexp.out)) {
        say('  ok    NEGATIVE CONTROL: an unexplained molecule makes it RED, named, as a divergence');
      } else {
        err('  FAIL  the reconciliation did NOT detect an unauthorised molecule — it cannot prove '
          + 'what Gate 1 closed on');
        err(`        fail ${base.fail} -> ${unexp.fail}; named=${unexp.out.includes('zzz planted unauthorised')}`);
        failed = 1;
      }
      // Removed immediately. Each control must test ONE thing: left in place it contributes its own
      // failure to every later assertion, and a control measuring an accumulation proves nothing
      // about the condition it names.
      await query(`DELETE FROM molecules WHERE normalized_name = 'zzz planted unauthorised'`);

      // (b) DRIFT — an identity the analyser EXCLUDES, present as a molecule. Two study rows with
      //     two different valid CAS numbers and no row naming the substance alone is the
      //     norketamine shape: nothing can link, so the identity is withheld.
      await query(`INSERT INTO study_molecules (study_id, molecule_name, cas_number) VALUES
        ('NC-D1','Plantedstatin','8880000-10-4'), ('NC-D2','Plantedstatin','8880000-11-5')`);
      await query(
        `INSERT INTO molecules (preferred_name, normalized_name, source, derivation_method)
         VALUES ('Plantedstatin','plantedstatin','negative-control','test')`);
      planted.push('plantedstatin');
      const drifted = await run();
      if (drifted.out.includes('plantedstatin') && /ACTIVE molecule\(s\) have drifted/.test(drifted.out)) {
        say('  ok    NEGATIVE CONTROL: an ACTIVE drifted identity is RED, named, as un-deprecated drift');
      } else {
        err('  FAIL  the reconciliation did NOT detect a drifted identity');
        err(`        named=${drifted.out.includes('plantedstatin')}`);
        failed = 1;
      }

      // ── THE DEPRECATED STATE: GREEN WHEN CORRECT, RED PER INVARIANT ─────
      //
      // The drift policy makes a deprecated molecule outside the authorised set ACCEPTABLE. That is
      // a reconciliation rule loosened deliberately, so each of its six conditions needs a control
      // proving the proof still discriminates. A rule that only ever passes is an exemption wearing
      // the costume of a check.
      //
      // `plantedstatin` is still planted and still excluded. Deprecating it properly must turn the
      // verdict GREEN for it; breaking each invariant in turn must turn it RED.
      const depReason = 'cas_disagreement:8880000-10-4,8880000-11-5'
        + '|rev=AUTO_REVERSIBLE|rows=2|at=2026-10-31T00:00:00.000Z';
      const setDep = (reason, cas) => query(
        `UPDATE molecules SET deprecated_at = NOW(), deprecated_reason = $1, cas = $2
          WHERE normalized_name = 'plantedstatin'`, [reason, cas]);
      const conflictFor = (name) => query(
        `INSERT INTO molecule_conflicts (kind, filed_name, identity_name, detail, source_table, conflict_key)
         VALUES ('cas_disagreement',$1,$1,'planted for the negative control','negative-control',$2)
         ON CONFLICT (conflict_key) WHERE resolved_at IS NULL DO NOTHING`,
        [name, `nc|${name}|${Date.now()}`]);

      await conflictFor('plantedstatin');
      await setDep(depReason, null);
      const depGreen = await run();
      if (depGreen.fail === base.fail && /every invariant holding/.test(depGreen.out)) {
        say('  ok    NEGATIVE CONTROL: a correctly deprecated molecule outside the set is GREEN');
      } else {
        err(`  FAIL  a correctly deprecated molecule did not pass: fail ${base.fail} -> ${depGreen.fail}`);
        const was = new Set(base.out.split('\n').filter((l) => /FAIL/.test(l)));
        depGreen.out.split('\n').filter((l) => /FAIL/.test(l) && !was.has(l))
          .slice(0, 6).forEach((l) => err(`        NEW: ${l.trim()}`));
        failed = 1;
      }

      const redWhen = async (label, mutate, expect) => {
        await mutate();
        const r = await run();
        if (r.fail > base.fail && expect.test(r.out)) {
          say(`  ok    NEGATIVE CONTROL: RED when ${label}`);
        } else {
          err(`  FAIL  NOT red when ${label} — fail ${base.fail} -> ${r.fail}`);
          failed = 1;
        }
        // Restore the correct deprecated state before the next mutation, so each control tests one
        // thing rather than an accumulation.
        await conflictFor('plantedstatin');
        await setDep(depReason, null);
      };

      await redWhen('the deprecated molecule has no machine-readable reason',
        () => setDep('', null), /no machine-readable reason/);
      await redWhen('a contest requiring suppression leaves the canonical CAS populated',
        () => setDep(depReason, '8880000-10-4'), /requires suppression but canonical cas/);
      await redWhen('the reason category is unknown to drift.js',
        () => setDep('invented_category:whatever|rev=AUTO_REVERSIBLE|rows=2', null), /is unknown to drift\.js/);
      // Quarantine evidence absent. molecule_conflicts forbids DELETE by trigger, so the evidence is
      // removed by renaming the identity it points at — which is what "no evidence for THIS identity"
      // looks like from the proof's side.
      await redWhen('the quarantine evidence does not name the identity', async () => {
        await query(`ALTER TABLE molecule_conflicts DISABLE TRIGGER trg_molecule_conflicts_append_only`);
        await query(`UPDATE molecule_conflicts SET identity_name = 'nc-moved-away' WHERE identity_name = 'plantedstatin'`);
        await query(`ALTER TABLE molecule_conflicts ENABLE TRIGGER trg_molecule_conflicts_append_only`);
      }, /no quarantine\/conflict evidence/);

      // ── RESTORATION ─────────────────────────────────────────────────────
      // Remove the plants and prove the verdict returns to where it started. Without this, a
      // control that left its fixture behind would make every later assertion suspect.
      for (const n of planted) await query(`DELETE FROM molecules WHERE normalized_name = $1`, [n]);
      await query(`DELETE FROM study_molecules WHERE study_id IN ('NC-D1','NC-D2')`);
      await query(`ALTER TABLE molecule_conflicts DISABLE TRIGGER trg_molecule_conflicts_append_only`);
      await query(`DELETE FROM molecule_conflicts WHERE source_table = 'negative-control'`);
      await query(`ALTER TABLE molecule_conflicts ENABLE TRIGGER trg_molecule_conflicts_append_only`);
      const restored = await run();
      if (restored.fail === base.fail) {
        say(`  ok    restored: the verdict is back to its baseline (${base.fail})`);
      } else {
        err(`  FAIL  the verdict did not return to baseline: ${base.fail} -> ${restored.fail} — a `
          + 'negative control left something behind');
        const was = new Set(base.out.split('\n').filter((l) => /FAIL/.test(l)));
        restored.out.split('\n').filter((l) => /FAIL/.test(l) && !was.has(l))
          .slice(0, 12).forEach((l) => err(`        NEW: ${l.trim()}`));
        failed = 1;
      }
    }
  } catch (e) {
    console.log = realLog;
    // THIS is the catch that matters. `after is not defined` landed here.
    err(`  FAIL  the reconciliation threw before finishing: ${e && e.message ? e.message : e}`);
    if (e && e.stack) err(`        ${e.stack.split('\n').slice(1, 4).join('\n        ')}`);
    failed = 1;
  } finally {
    stopTemp();
  }

  say('');
  if (failed) { say('FAIL  the reconciliation does not run end to end\n'); process.exit(1); }
  say('PASS  every line of the reconciliation executes — no undefined reference, no missing column\n');
  process.exit(0);
})();
