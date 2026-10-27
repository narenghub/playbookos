#!/usr/bin/env node
// ── THE KILL SWITCH, AGAINST A REAL POSTGRES ─────────────────────────────────
//
//   scripts/check-autonomy-stop-db.js   → exit 0 = the switch stops, resumes, audits and crosses
//                                         process boundaries without a restart
//
// ── WHY THIS CHECK EXISTS ────────────────────────────────────────────────────
//
// The unit tests prove the SEMANTICS with an injected query stub. They cannot prove the three
// things the kill switch actually has to do, all of which live in the database:
//
//   1. a stop written by one process is seen by ANOTHER, with no restart — which is the entire
//      meaning of "do not require a production redeployment to stop autonomy". A test that writes
//      and reads on one connection would pass while the real property failed.
//   2. the STOP/RESUME history is written by a TRIGGER, so a break-glass `INSERT` typed into a
//      database console is audited exactly like an API call. If this lived in the route handler,
//      the emergency path would be the one path with no evidence.
//   3. deleting the active stop row does not erase that history.
//
// It also measures propagation. A kill switch whose latency is asserted in a comment rather than
// measured is a kill switch nobody has timed.
//
// Needs a server: set AUTONOMY_PG_URL, or let it start a throwaway cluster if initdb is on PATH.
// With neither it SKIPS, so a machine without Postgres can still run preflight.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const autonomy = require('../src/lib/autonomy');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};

// ── GET A SERVER ────
const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/autonomy-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55991' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55991 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55991`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) { /* best effort */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.AUTONOMY_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set AUTONOMY_PG_URL or install initdb)');
  console.log('SKIP  kill switch not executed against a server — this check needs one');
  process.exit(0);
}

const REASON = 'preflight check — verifying the kill switch halts consequential work';

(async () => {
  const { Pool } = require('pg');
  // Two pools: writing on one and reading on the other is the minimum that can distinguish a real
  // shared switch from one that only works where it was set.
  const A = new Pool({ connectionString: url, ssl: false });
  const B = new Pool({ connectionString: url, ssl: false });
  const aq = (t, p) => A.query(t, p);
  const bq = (t, p) => B.query(t, p);
  const noListen = () => {};
  const withTx = async (fn) => {
    const c = await A.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  };

  try {
    // 1. The DDL runs. CREATE OR REPLACE FUNCTION with a dollar-quoted plpgsql body, a trigger on
    //    three events and current_setting(..., true) all parse in JavaScript and fail on a server.
    await autonomy.migrateAutonomy(aq);
    ok('migrateAutonomy creates the tables, audit function and trigger');

    // Idempotent: boot runs it on every deploy.
    await autonomy.migrateAutonomy(aq);
    ok('migrateAutonomy is idempotent (it runs on every boot)');

    // 2. A stop through the module writes the row AND the audit row, with the actor attributed.
    const r1 = await autonomy.stop(
      { scope_type: 'global', scope_key: '', reason: REASON, actor: 'check@local' },
      { deps: { withTransaction: withTx } },
    );
    if (!r1.ok) bad('stop() refused a valid global stop', r1.error);
    else ok('stop() writes a global stop');

    const stops = await autonomy.listStops({ deps: { query: bq } });
    if (stops.length === 1 && stops[0].scope_type === 'global' && stops[0].reason === REASON) {
      ok('the stop row is visible on a SECOND connection with its reason intact');
    } else bad('the stop row is wrong or invisible', JSON.stringify(stops));

    const ev1 = await autonomy.history({ deps: { query: bq } });
    const stopEv = ev1.find((e) => e.action === 'STOP');
    if (stopEv && stopEv.actor === 'check@local' && stopEv.reason === REASON) {
      ok('the TRIGGER recorded STOP with the actor, reason and scope');
    } else bad('no correctly attributed STOP event', JSON.stringify(ev1.slice(0, 3)));

    // 3. B. CROSS-PROCESS VISIBILITY. A genuinely separate node process, started after the stop was
    //    written, with no shared memory and no restart of anything.
    const child = spawnSync(process.execPath, ['-e', `
      const { Pool } = require('pg');
      const autonomy = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'autonomy.js'))});
      const pool = new Pool({ connectionString: process.env.U, ssl: false });
      autonomy.checkStopped({ capability: 'email.send' }, { consequential: true, deps: { query: (t,p)=>pool.query(t,p), listen: ()=>{} } })
        .then(v => { console.log(JSON.stringify(v)); return pool.end(); })
        .then(() => process.exit(0))
        .catch(e => { console.error(e.message); process.exit(1); });
    `], { env: { ...process.env, U: url }, encoding: 'utf8', timeout: 30000 });
    let childVerdict = null;
    try { childVerdict = JSON.parse(String(child.stdout).trim()); } catch (_) {}
    if (childVerdict && childVerdict.scope_type === 'global') {
      ok('B: a SEPARATE PROCESS observes the stop with no restart and no shared state');
    } else bad('a separate process did not see the stop', `${child.stdout}\n${child.stderr}`);

    // 4. C. PROPAGATION LATENCY, measured rather than asserted. The listener is deliberately
    //    disabled, so the TTL floor alone has to meet the target — which is the worst case in
    //    production, where a dropped LISTEN connection is silent.
    autonomy.resetForTests();
    await autonomy.resume({ scope_type: 'global', scope_key: '', reason: 'clearing before the latency measurement', actor: 'check@local' },
      { deps: { withTransaction: withTx } });
    autonomy.resetForTests();

    const allowed = await autonomy.checkStopped({ capability: 'email.send' }, { consequential: true, deps: { query: bq, listen: noListen } });
    if (allowed !== null) bad('expected to be allowed after the resume', JSON.stringify(allowed));

    // Write the stop on connection A, then poll on B as a consequential caller would.
    await aq(`INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by) VALUES ('global','',$1,'latency-probe')`, [REASON]);
    const t0 = Date.now();
    let observedMs = null;
    while (Date.now() - t0 < 5000) {
      const v = await autonomy.checkStopped({ capability: 'email.send' }, { consequential: true, deps: { query: bq, listen: noListen } });
      if (v) { observedMs = Date.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (observedMs === null) bad('the stop was never observed within 5s');
    else if (observedMs <= 2000) ok(`C: global stop observed in ${observedMs}ms with the listener disabled (target ≤2000ms)`);
    else bad(`C: global stop took ${observedMs}ms to propagate, above the 2000ms target`);

    // 5. A break-glass INSERT — no module, no HTTP, no transaction-local actor — is still audited.
    await aq(`DELETE FROM autonomy_stops WHERE scope_type='global'`);
    await aq(`INSERT INTO autonomy_stops (scope_type, scope_key, reason) VALUES ('company','abiozen',$1)`,
      ['break-glass test — direct SQL stop with no application involved']);
    const bg = (await autonomy.history({ deps: { query: bq } })).find(
      (e) => e.action === 'STOP' && e.scope_key === 'abiozen');
    if (bg && bg.actor === 'sql-break-glass') {
      ok('a direct SQL stop is audited and attributed to the break-glass path');
    } else bad('a break-glass INSERT was not audited', JSON.stringify(bg || null));

    // And it is enforced, not merely recorded.
    autonomy.resetForTests();
    const bgHit = await autonomy.checkStopped({ company: 'abiozen' }, { consequential: true, deps: { query: bq, listen: noListen } });
    if (bgHit && bgHit.scope_type === 'company') ok('the break-glass stop is enforced, not just logged');
    else bad('a break-glass stop was not enforced', JSON.stringify(bgHit));

    // 6. E. RESUME restores execution, and the history survives the delete.
    const before = (await autonomy.history({ limit: 500, deps: { query: bq } })).length;
    const r2 = await autonomy.resume(
      { scope_type: 'company', scope_key: 'abiozen', reason: 'investigation closed, resuming outbound', actor: 'check@local' },
      { deps: { withTransaction: withTx } },
    );
    if (!r2.ok || r2.removed !== 1) bad('resume() did not remove the stop', JSON.stringify(r2));
    else ok('resume() removes the active stop');

    autonomy.resetForTests();
    const afterResume = await autonomy.checkStopped({ company: 'abiozen' }, { consequential: true, deps: { query: bq, listen: noListen } });
    if (afterResume === null) ok('E: execution is permitted again after the resume, with no restart');
    else bad('still stopped after a resume', JSON.stringify(afterResume));

    const hist = await autonomy.history({ limit: 500, deps: { query: bq } });
    const resumeEv = hist.find((e) => e.action === 'RESUME' && e.scope_key === 'abiozen');
    if (hist.length > before && resumeEv && /investigation closed/.test(resumeEv.reason)) {
      ok('E: the RESUME is recorded with its reason, and the earlier STOP history still exists');
    } else bad('resume history missing or incomplete', JSON.stringify(hist.slice(0, 4)));

    const stillHasStop = hist.some((e) => e.action === 'STOP' && e.scope_key === 'abiozen');
    if (stillHasStop) ok('deleting the active stop row did NOT erase the evidence it existed');
    else bad('the STOP evidence vanished when the row was deleted');

    // 7. A refusal is durably recorded — the half that makes STOPPED_BY_POLICY un-mistakable for a
    //    provider failure after the fact.
    await aq(`INSERT INTO autonomy_stops (scope_type, scope_key, reason) VALUES ('capability','email.send',$1)`,
      ['refusal-recording test']);
    autonomy.resetForTests();
    const hit = await autonomy.checkStopped({ capability: 'email.send' }, { consequential: true, deps: { query: bq, listen: noListen } });
    autonomy.recordRefusal({ stop: hit, what: 'email.send', detail: { to: 'buyer@example.com' }, deps: { query: aq } });
    await new Promise((r) => setTimeout(r, 300));
    const ref = (await autonomy.history({ limit: 500, deps: { query: bq } })).find((e) => e.action === 'REFUSED');
    if (ref && ref.detail && ref.detail.what === 'email.send' && ref.detail.to === 'buyer@example.com') {
      ok('a refusal is recorded as REFUSED with what was refused, recoverable afterwards');
    } else bad('the refusal was not durably recorded', JSON.stringify(ref || null));

    // 8. The reason column cannot be bypassed at the database level either.
    try {
      await aq(`INSERT INTO autonomy_stops (scope_type, scope_key) VALUES ('agent','ceo-agent')`);
      bad('a stop was accepted with NO reason — incident reconstruction has nothing to read');
    } catch (_) {
      ok('the database itself refuses a stop with no reason');
    }

    // 9. Cleanup: only what this check created, by explicit key (CLAUDE.md — never by timestamp,
    //    never "recent", and never assert the table is empty).
    for (const [t, k] of [['global', ''], ['company', 'abiozen'], ['capability', 'email.send'], ['agent', 'ceo-agent']]) {
      await aq('DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2', [t, k]);
    }
    const mine = await bq(
      `SELECT COUNT(*)::int n FROM autonomy_stops
        WHERE (scope_type, scope_key) IN (('global',''),('company','abiozen'),('capability','email.send'),('agent','ceo-agent'))`);
    if (mine.rows[0].n === 0) ok('fixture stops removed by explicit key');
    else bad(`${mine.rows[0].n} fixture stop(s) left behind`);
  } catch (e) {
    bad('threw', e && e.stack ? e.stack : e);
  } finally {
    await A.end().catch(() => {});
    await B.end().catch(() => {});
    stopTemp();
  }

  if (fail) { console.log(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  the kill switch stops, enforces, propagates ≤2s, resumes, and keeps its history');
})();
