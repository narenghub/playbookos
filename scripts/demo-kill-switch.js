#!/usr/bin/env node
// ── LIVE STOP / RESUME DEMONSTRATION, AGAINST THE RUNNING SYSTEM ─────────────
//
//   railway ssh 'node scripts/demo-kill-switch.js'
//
// Proves on PRODUCTION what the tests prove in a fixture: a stop takes effect with no redeploy, a
// real outbound primitive refuses, a separate process sees it, a resume restores execution, and the
// history survives the resume. Exit 0 = demonstrated.
//
// Optional: --pg=<url> runs the same sequence against a throwaway cluster instead of the live
// database, for rehearsing the script itself. Same flag style as the other check scripts.
//
// ── WHY THIS SCRIPT IS BUILT THE WAY IT IS ───────────────────────────────────
//
// It deliberately halts all autonomy for a few seconds. Three rules from CLAUDE.md apply directly,
// and the third is the one that has cost the most:
//
//   1. It touches only rows it created, by explicit scope key. Never by timestamp, never "recent".
//   2. It never asserts a table is empty. It asserts ITS OWN stop is gone.
//   3. "It will be refused anyway" is a prediction, not a safeguard. So the email probe is
//      addressed to a reserved .invalid domain (RFC 2606) which cannot reach a person. If the guard
//      fails — the one run where it does — nothing is delivered to anybody.
//
// It also REFUSES TO RUN if any stop already exists, because an operator may have stopped autonomy
// deliberately and a demonstration that ends with a resume would silently lift their halt.
//
// And it resumes in a finally block, printing the exact manual resume command if it could not.
'use strict';

const path = require('path');

const argv = process.argv.slice(2);
const PG = (argv.find((a) => a.startsWith('--pg=')) || '').slice(5);
const LABEL_REASON = 'P0.2 production demonstration — verifying the kill switch halts and releases';

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };

const autonomy = require('../src/lib/autonomy');

(async () => {
  let query, withTransaction, pool = null;
  if (PG) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: PG, ssl: false });
    query = (t, p) => pool.query(t, p);
    withTransaction = async (fn) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
      catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
      finally { c.release(); }
    };
    await autonomy.migrateAutonomy(query);
  } else {
    const db = require('../src/lib/db');
    query = db.query;
    withTransaction = db.withTransaction;
  }
  const deps = { query, withTransaction };
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'local';

  console.log(`\n── kill switch · live demonstration · commit ${commit}\n`);

  let weStopped = false;
  try {
    // 0. Refuse to proceed if autonomy is already stopped by somebody else.
    const existing = await autonomy.listStops({ deps });
    if (existing.length) {
      console.log('  ✗ autonomy is ALREADY stopped. Refusing to run: this script ends with a resume,');
      console.log('    which would lift a halt somebody else put in place deliberately.\n');
      for (const s of existing) {
        console.log(`      ${s.scope_type}${s.scope_key ? `:${s.scope_key}` : ''} — ${s.reason} (by ${s.set_by || '?'})`);
      }
      console.log('');
      process.exit(2);
    }
    ok('no stop is in force at the start, so the demonstration is unambiguous');

    // 1. Baseline: a consequential action is permitted.
    autonomy.resetForTests();
    const before = await autonomy.checkStopped({ capability: 'email.send' }, { consequential: true, deps });
    if (before === null) ok('baseline: a consequential action is permitted');
    else bad('baseline is not clean', JSON.stringify(before));

    // 2. GLOBAL STOP via the BREAK-GLASS path: a raw INSERT, exactly what an operator types into a
    //    database console when the HTTP control plane is unavailable. Two things at once —
    //    break-glass is demonstrated, and because this path does not touch the module's in-process
    //    snapshot, the propagation below is the genuine TTL worst case rather than a cold read.
    const t0 = Date.now();
    await query(
      `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by) VALUES ('global', '', $1, $2)`,
      [LABEL_REASON, `demo-break-glass:${commit}`],
    );
    weStopped = true;
    ok('GLOBAL STOP written by raw SQL (break-glass) — autonomy is halted platform-wide');

    // 3. Propagation — measured as the WORST case, which is not the obvious one.
    //
    //    A cold cache refreshes on the next call and sees the stop in milliseconds; quoting that
    //    number would be flattering and wrong. The real worst case is a process that has just
    //    cached an "allowed" verdict and must wait out the TTL, with the LISTEN accelerator dead so
    //    nothing invalidates it early. Step 1 above already populated that cache, so the snapshot
    //    is deliberately NOT reset here.
    let observedMs = null;
    while (Date.now() - t0 < 5000) {
      const v = await autonomy.checkStopped({ capability: 'email.send' },
        { consequential: true, deps: { ...deps, listen: () => {} } });
      if (v) { observedMs = Date.now() - t0; break; }
      await new Promise((s) => setTimeout(s, 25));
    }
    if (observedMs === null) bad('the stop was never observed within 5s');
    else if (observedMs <= 2000) ok(`observed in ${observedMs}ms — worst case: a cached 'allowed' verdict, no listener (target ≤2000ms)`);
    else bad(`propagation took ${observedMs}ms, above the 2000ms target`);

    // 3b. The break-glass write was audited by the TRIGGER, with no application involvement.
    const bgHist = await autonomy.history({ limit: 20, deps });
    const bg = bgHist.find((e) => e.action === 'STOP' && e.reason === LABEL_REASON);
    if (bg && bg.actor === 'sql-break-glass') ok('the break-glass stop was audited and attributed by the trigger');
    else bad('the break-glass stop was not audited as such', JSON.stringify(bg || null));

    // 4. THE REAL PRIMITIVE refuses. Not the lookup — the function that talks to Resend.
    //    Addressed to a reserved .invalid domain so that if the guard fails, no person is emailed.
    const { sendEmailDetailed } = require('../src/lib/mailer');
    const probe = await sendEmailDetailed({
      to: 'killswitch-probe@demo.invalid',
      subject: 'P0.2 kill-switch probe — must never be delivered',
      html: '<p>If this was delivered, the kill switch did not hold.</p>',
    });
    if (probe.stopped === true && probe.ok === false && /STOPPED_BY_POLICY/.test(String(probe.error))) {
      ok('sendEmailDetailed REFUSED with STOPPED_BY_POLICY — the provider was never called');
    } else bad('the mailer did not refuse while autonomy was stopped', JSON.stringify(probe));

    // 5. A cron does not reach its body.
    const { withAlerts } = require('../src/lib/cron-alerts');
    let ran = 0;
    const out = await withAlerts('weekday-910cst-outreach-agent', async () => { ran += 1; }, deps)();
    if (ran === 0 && out && out.stopped_by_policy) ok('a cron was halted and never reached its body');
    else bad('a cron executed while autonomy was stopped', JSON.stringify({ ran, out }));

    // 6. Read-only reasoning survives the global stop — the THINKING/ACTING split, live.
    const think = await autonomy.checkStopped({ capability: 'llm.call' }, { consequential: false, deps });
    if (think === null) ok('read-only reasoning is still permitted under a global stop');
    else bad('a global stop silenced analysis', JSON.stringify(think));

    // 7. A SEPARATE PROCESS sees it. This is what "no redeploy" means.
    const { spawnSync } = require('child_process');
    const child = spawnSync(process.execPath, ['-e', `
      const a = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'autonomy.js'))});
      ${PG
    ? `const { Pool } = require('pg'); const p = new Pool({ connectionString: process.env.U, ssl: false });
         const q = (t,x)=>p.query(t,x); const done = () => p.end();`
    : `const q = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'db.js'))}).query; const done = () => {};`}
      a.checkStopped({ capability: 'email.send' }, { consequential: true, deps: { query: q, listen: () => {} } })
        .then(v => { console.log(JSON.stringify(v)); return done(); })
        .then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
    `], { env: { ...process.env, U: PG || '' }, encoding: 'utf8', timeout: 30000 });
    let v = null;
    try { v = JSON.parse(String(child.stdout).trim()); } catch (_) {}
    if (v && v.scope_type === 'global') ok('a separate process observes the stop — no restart, no shared state');
    else bad('a separate process did not see the stop', `${child.stdout} ${child.stderr}`.slice(0, 200));

    // 8. RESUME, and execution is restored.
    const rr = await autonomy.resume(
      { scope_type: 'global', scope_key: '', reason: 'demonstration complete — releasing the halt', actor: `demo:${commit}` },
      { deps },
    );
    if (rr.ok && rr.removed === 1) { weStopped = false; ok('RESUME removed the stop'); }
    else bad('the resume did not remove the stop', JSON.stringify(rr));

    autonomy.resetForTests();
    const after = await autonomy.checkStopped({ capability: 'email.send' },
      { consequential: true, deps: { ...deps, listen: () => {} } });
    if (after === null) ok('consequential actions are permitted again — with no redeploy at any point');
    else bad('still stopped after the resume', JSON.stringify(after));

    // 9. The evidence survives. A resume must not erase the fact that autonomy was stopped.
    const hist = await autonomy.history({ limit: 50, deps });
    const mine = hist.filter((e) => e.actor === `demo:${commit}` || /production demonstration/.test(e.reason || ''));
    const hasStop = mine.some((e) => e.action === 'STOP');
    const hasResume = mine.some((e) => e.action === 'RESUME');
    const hasRefusal = hist.some((e) => e.action === 'REFUSED');
    if (hasStop && hasResume) ok('both the STOP and the RESUME are in the durable history');
    else bad('the history is incomplete', JSON.stringify(mine.map((m) => m.action)));
    // recordRefusal writes through the application's OWN connection (require('./db')), not the one
    // injected here — which is correct in production and unreachable in a --pg rehearsal. Reported
    // as a skip rather than a pass, because a rehearsal that silently claims to have verified a
    // production-only property is worse than one that says it cannot.
    if (PG) console.log('  skip  REFUSED rows are written via the app connection — not verifiable in --pg rehearsal');
    else if (hasRefusal) ok('the refusals that occurred are recorded as REFUSED');
    else bad('no REFUSED row was written for the refusals above');

    // 10. Only our row is gone; the table is NOT asserted empty.
    const left = await query(
      "SELECT COUNT(*)::int n FROM autonomy_stops WHERE scope_type = 'global' AND scope_key = ''");
    if (left.rows[0].n === 0) ok('our stop row is gone (the table itself is not asserted empty)');
    else bad('our stop row is still present');
  } catch (e) {
    bad('threw', e && e.message ? e.message : String(e));
  } finally {
    // The thing that must not be left behind.
    if (weStopped) {
      try {
        await autonomy.resume(
          { scope_type: 'global', scope_key: '', reason: 'demonstration aborted — releasing the halt', actor: 'demo-cleanup' },
          { deps },
        );
        console.log('\n  ⚠ the run did not complete, but the global stop HAS been released.');
      } catch (e) {
        console.log('\n  ✗✗ AUTONOMY IS STILL STOPPED AND THIS SCRIPT COULD NOT RELEASE IT.');
        console.log('     Release it now, from a database console:');
        console.log("       DELETE FROM autonomy_stops WHERE scope_type = 'global' AND scope_key = '';");
        console.log(`     (resume failed: ${e.message})`);
      }
    }
    if (pool) await pool.end().catch(() => {});
  }

  if (fail) { console.log(`\n✗ FAIL — ${fail} step(s) failed.\n`); process.exit(1); }
  console.log('\n✓ DEMONSTRATED — stopped, enforced at the primitive, seen by another process,');
  console.log('  resumed, and audited. No redeploy at any point.\n');
})();
