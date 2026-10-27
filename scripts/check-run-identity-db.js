#!/usr/bin/env node
// ── RUN IDENTITY INVARIANTS, ARBITRATED BY POSTGRES ──────────────────────────
//
//   scripts/check-run-identity-db.js   → exit 0 = the database, not the application, decides
//
// ── WHY THIS CHECK EXISTS ────────────────────────────────────────────────────
//
// The first retry proposal relied on UNIQUE (intent_key, attempt) to arbitrate concurrency. It
// cannot: that protects attempt NUMBERING, and two processes choosing different numbers would both
// have been active. The arbiter is a partial unique index over the ACTIVE states, and the only way
// to show it works is to race real connections against a real server.
//
// Everything asserted here is a property of the schema rather than of the calling code, which is
// the point — a call path added next year inherits all of it without knowing it exists.
//
// Needs a server: set RUNS_PG_URL, or let it start a throwaway cluster if initdb is on PATH.
// With neither it SKIPS, so a machine without Postgres can still run preflight.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const runs = require('../src/lib/runs');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 300)}`); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/runsid-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55977' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55977 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55977`;
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

const url = process.env.RUNS_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set RUNS_PG_URL or install initdb)');
  console.log('SKIP  run identity invariants not executed — this check needs a server');
  process.exit(0);
}

const OVERRIDE = 'investigated the unresolved send with Palash and accepted the risk';

(async () => {
  const { Pool } = require('pg');
  const A = new Pool({ connectionString: url, ssl: false });
  const B = new Pool({ connectionString: url, ssl: false });
  const aq = (t, p) => A.query(t, p);
  const bq = (t, p) => B.query(t, p);
  const created = [];

  // Insert a run. Returns the run_id, or throws with the database's own message.
  const insert = (q, o = {}) => {
    const id = o.run_id || runs.newRunId();
    created.push(id);
    return q(
      `INSERT INTO agent_runs
         (run_id, root_run_id, parent_run_id, trigger, trigger_detail, workflow, agent, product,
          state, intent_key, attempt, predecessor_run_id, retry_override_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, o.root_run_id || id, o.parent_run_id || null, o.trigger || 'cron', o.trigger_detail || null,
        o.workflow || 'wf', o.agent || null, o.product || 'abiozen', o.state || 'CREATED',
        o.intent_key === undefined ? null : o.intent_key, o.attempt || 1,
        o.predecessor_run_id || null, o.retry_override_reason || null],
    ).then(() => id);
  };
  const setState = (q, id, state, extra = '') =>
    q(`UPDATE agent_runs SET state = $2 ${extra} WHERE run_id = $1`, [id, state]);
  const event = (q, runId, kind, o = {}) => q(
    `INSERT INTO agent_run_events (run_id, kind, action_kind, subject_type, subject_ref, success, cost_usd, tokens_input, tokens_output)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [runId, kind, o.action_kind || null, o.subject_type || null, o.subject_ref || null,
      o.success === undefined ? null : o.success, o.cost_usd || null, o.tokens_input || null, o.tokens_output || null]);

  try {
    // autonomy_events must exist first: agent_runs.stopped_by references it, and the link from a
    // policy-stopped run to the exact refusal is one of the things asserted below.
    await require('../src/lib/autonomy').migrateAutonomy(aq);
    await runs.migrateRuns(aq);
    ok('migrateRuns creates both tables, both unique indexes and all three triggers');
    await runs.migrateRuns(aq);
    ok('migrateRuns is idempotent (it will run on every boot)');

    // ── 1. 20 CONCURRENT INITIAL TRIGGERS → EXACTLY ONE ────────────────────
    const intent = 'cron:weekday-910cst-outreach-agent:2026-10-27T09:10';
    const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      insert(i % 2 ? aq : bq, { intent_key: intent, attempt: 1 })));
    const accepted = settled.filter((s) => s.status === 'fulfilled').length;
    const rejected = settled.filter((s) => s.status === 'rejected');
    if (accepted === 1 && rejected.length === 19) ok('20 concurrent initial triggers → exactly 1 accepted, 19 rejected');
    else bad(`20 concurrent triggers → ${accepted} accepted`, rejected[0] && rejected[0].reason.message);
    if (rejected.every((r) => r.reason.code === '23505')) ok('every rejection is a unique violation, not a crash');
    else bad('a rejection was not 23505', rejected.map((r) => r.reason.code).join(','));

    const rows = await bq(`SELECT run_id, attempt FROM agent_runs WHERE intent_key = $1`, [intent]);
    if (rows.rows.length === 1) ok('exactly one row exists for the intent');
    else bad(`${rows.rows.length} rows for one intent`);
    const a1 = rows.rows[0].run_id;

    // ── EACH INDEX, IN ISOLATION ───────────────────────────────────────────
    //
    // The mutation harness caught a hole in these checks: weakening EITHER unique index still
    // passed everything, because each one catches every case the other does in any state the
    // retry trigger can reach. The trigger enforces attempt = predecessor.attempt + 1, which makes
    // "two ACTIVE rows with different attempt numbers for one intent" unreachable — so neither
    // index was independently necessary for any assertion, and the claim that the partial index is
    // THE arbiter was untested.
    //
    // Each is therefore exercised with the other removed. That is the only way to show what each
    // one is actually holding, and it is what makes the mutation evidence meaningful.
    const iso = 'cron:isolation:2026-10-27T09:00';
    const base = await insert(aq, { intent_key: iso });
    await setState(aq, base, 'FAILED', ', ended_at = NOW()');

    // (a) ACTIVE index alone. Numbering is bypassed by disabling the retry guard, so two rows with
    //     DIFFERENT attempt numbers both try to be active. Only the ACTIVE index can refuse this.
    await aq(`ALTER TABLE agent_runs DISABLE TRIGGER trg_agent_runs_retry_guard`);
    try {
      const r = await Promise.allSettled([
        insert(aq, { intent_key: iso, attempt: 7 }),
        insert(bq, { intent_key: iso, attempt: 9 }),
      ]);
      const won = r.filter((x) => x.status === 'fulfilled').length;
      if (won === 1) ok('ACTIVE index alone: two active rows with DIFFERENT attempts → one refused');
      else bad(`ACTIVE index alone: ${won} of 2 became active for one intent`);
    } finally {
      await aq(`ALTER TABLE agent_runs ENABLE TRIGGER trg_agent_runs_retry_guard`);
    }
    // Clear the active row so the slot is free for (b).
    await aq(`UPDATE agent_runs SET state='FAILED', ended_at=NOW()
               WHERE intent_key=$1 AND state IN ('CREATED','RUNNING')`, [iso]);

    // (b) ATTEMPT index alone. Every row for this intent is terminal, so the ACTIVE index cannot
    //     apply; re-using an attempt NUMBER must still be refused, or attempt history stops
    //     meaning anything.
    await aq(`DROP INDEX uq_agent_runs_one_active`);
    // The guard is out of the way here too: attempt 42 has no predecessor, and the guard rightly
    // refuses that — but what is being isolated is the INDEX, not the guard. Leaving the guard on
    // made both inserts fail for the wrong reason, which would have read as the index working.
    await aq(`ALTER TABLE agent_runs DISABLE TRIGGER trg_agent_runs_retry_guard`);
    try {
      const dup = await Promise.allSettled([
        insert(aq, { intent_key: iso, attempt: 42, state: 'FAILED' }),
        insert(bq, { intent_key: iso, attempt: 42, state: 'FAILED' }),
      ]);
      const won = dup.filter((x) => x.status === 'fulfilled').length;
      if (won === 1) ok('ATTEMPT index alone: two terminal rows claiming attempt 42 → one refused');
      else bad(`ATTEMPT index alone: ${won} of 2 claimed the same attempt number`);
    } finally {
      await aq(`ALTER TABLE agent_runs ENABLE TRIGGER trg_agent_runs_retry_guard`);
      await runs.migrateRuns(aq);   // restores the ACTIVE index
    }
    const restored = await bq(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_agent_runs_one_active'`);
    if (restored.rows.length && /UNIQUE/.test(restored.rows[0].indexdef)) {
      ok('the ACTIVE index is restored after the isolation test');
    } else bad('the ACTIVE index was left dropped');

    // ── 2. 20 CONCURRENT RETRIES AFTER FAILED → EXACTLY ONE ATTEMPT 2 ──────
    await event(aq, a1, 'ACTION_ATTEMPTED', { action_kind: 'email.send', subject_ref: 's1' });
    await event(aq, a1, 'ACTION_SUCCEEDED', { action_kind: 'email.send', subject_ref: 's1', success: true });
    await setState(aq, a1, 'FAILED', ', ended_at = NOW()');
    const retries = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      insert(i % 2 ? aq : bq, { intent_key: intent, attempt: 2, predecessor_run_id: a1 })));
    const rAcc = retries.filter((s) => s.status === 'fulfilled').length;
    if (rAcc === 1) ok('20 concurrent retry requests after FAILED → exactly 1 attempt 2');
    else bad(`${rAcc} retries accepted`, retries.find((r) => r.status === 'rejected')?.reason?.message);

    // ── 3. ATTEMPT 1 REMAINS FAILED AFTER ATTEMPT 2 SUCCEEDS ───────────────
    const a2 = (await bq(`SELECT run_id FROM agent_runs WHERE intent_key=$1 AND attempt=2`, [intent])).rows[0].run_id;
    await setState(aq, a2, 'RUNNING', ', started_at = NOW()');
    await setState(aq, a2, 'SUCCEEDED', ', ended_at = NOW()');
    const after = await bq(`SELECT run_id, attempt, state FROM agent_runs WHERE intent_key=$1 ORDER BY attempt`, [intent]);
    if (after.rows.length === 2 && after.rows[0].state === 'FAILED' && after.rows[1].state === 'SUCCEEDED') {
      ok('attempt 1 is still FAILED after attempt 2 SUCCEEDED — both reconstructable');
    } else bad('attempt history was rewritten', JSON.stringify(after.rows));

    // And the database refuses to rewrite it even if asked directly.
    try {
      await aq(`UPDATE agent_runs SET state='SUCCEEDED' WHERE run_id=$1`, [a1]);
      bad('a TERMINAL run was rewritten to SUCCEEDED');
    } catch (e) {
      if (/terminal/i.test(e.message)) ok('the database refuses to rewrite a terminal run, even directly');
      else bad('terminal rewrite failed for the wrong reason', e.message);
    }

    // ── 4. A SUCCEEDED INTENT REJECTS A SAME-INTENT RETRY ──────────────────
    try {
      await insert(aq, { intent_key: intent, attempt: 3, predecessor_run_id: a2, retry_override_reason: OVERRIDE });
      bad('a SUCCEEDED predecessor was retried');
    } catch (e) {
      if (/may not be retried/.test(e.message)) ok('a SUCCEEDED predecessor cannot be retried, and the error names its state');
      else bad('the SUCCEEDED retry failed for the wrong reason', e.message);
    }

    // ── 5. ABANDONED WITH AN UNRESOLVED ACTION NEEDS AN OVERRIDE ───────────
    const i2 = 'cron:daily-9cst-inquiry-agent:2026-10-27T09:00';
    const b1 = await insert(aq, { intent_key: i2 });
    await setState(aq, b1, 'RUNNING', ', started_at = NOW()');
    // Attempted and never acknowledged: provider may have accepted it. UNKNOWN_OUTCOME.
    await event(aq, b1, 'ACTION_ATTEMPTED', { action_kind: 'email.send', subject_ref: 'buyer-7' });
    await setState(aq, b1, 'ABANDONED', ', ended_at = NOW()');
    try {
      await insert(aq, { intent_key: i2, attempt: 2, predecessor_run_id: b1 });
      bad('an ABANDONED run with an unresolved action was retried with NO recorded reason');
    } catch (e) {
      if (/retry_override_reason/.test(e.message) && /unresolved/.test(e.message)) {
        ok('ABANDONED + unresolved action refuses a retry without a recorded reason, and says how many');
      } else bad('refused for the wrong reason', e.message);
    }
    const b2 = await insert(aq, { intent_key: i2, attempt: 2, predecessor_run_id: b1, retry_override_reason: OVERRIDE });
    if (b2) ok('with a recorded override the retry is permitted');
    const stored = await bq(`SELECT retry_override_reason FROM agent_runs WHERE run_id=$1`, [b2]);
    if (stored.rows[0].retry_override_reason === OVERRIDE) ok('the override reason is durable evidence, not a flag');
    else bad('the override reason was not stored');
    // A short reason is not a reason.
    const i3 = 'cron:x:2026-10-27T09:00';
    const c1 = await insert(aq, { intent_key: i3 });
    // Via RUNNING, because PARTIAL means "some actions landed" and a run that never started cannot
    // have landed anything. The transition guard refused the shortcut when this fixture tried it,
    // which is the guard working on its author.
    await setState(aq, c1, 'RUNNING', ', started_at = NOW()');
    await setState(aq, c1, 'PARTIAL', ', ended_at = NOW()');
    try {
      await insert(aq, { intent_key: i3, attempt: 2, predecessor_run_id: c1, retry_override_reason: 'ok' });
      bad('a 2-character override was accepted');
    } catch (e) {
      if (/retry_override_reason/.test(e.message)) ok('a token override reason is refused (PARTIAL needs a real one)');
      else bad('short-reason refusal failed for the wrong reason', e.message);
    }

    // ── THE KNOWN-UNKNOWN IS VISIBLE, AND IS NOT "FAILED" ──────────────────
    const unresolved = await bq(
      `SELECT r.intent_key, e.action_kind, e.subject_ref
         FROM agent_run_events e JOIN agent_runs r USING (run_id)
        WHERE e.kind = 'ACTION_ATTEMPTED'
          AND NOT EXISTS (SELECT 1 FROM agent_run_events t
                           WHERE t.run_id = e.run_id
                             AND t.action_kind IS NOT DISTINCT FROM e.action_kind
                             AND t.subject_ref IS NOT DISTINCT FROM e.subject_ref
                             AND t.kind IN ('ACTION_SUCCEEDED','ACTION_FAILED'))`);
    const un = unresolved.rows;
    if (un.length === 1 && un[0].subject_ref === 'buyer-7') {
      ok('reconciliation finds the attempted-without-outcome action, and only that one');
    } else bad('reconciliation query wrong', JSON.stringify(un));
    // The resolved one must NOT appear — reporting settled work as unknown is the alarm fatigue
    // that let a broken cron send 168 false alerts a week unnoticed.
    if (!un.some((u) => u.subject_ref === 's1')) ok('an acknowledged action is not reported as unknown');
    else bad('a resolved action was reported as unresolved');

    // ── 6. A PREDECESSOR FROM ANOTHER INTENT IS REFUSED ────────────────────
    try {
      await insert(aq, { intent_key: 'cron:other:2026-10-27T09:00', attempt: 2, predecessor_run_id: a1 });
      bad('a retry pointed at another intent was accepted');
    } catch (e) {
      if (/intent mismatch/.test(e.message)) ok('a predecessor from a different intent is refused');
      else bad('intent-mismatch refusal failed for the wrong reason', e.message);
    }
    // An attempt beyond the first must name what it retries.
    try {
      await insert(aq, { intent_key: 'cron:orphan:2026-10-27T09:00', attempt: 2 });
      bad('attempt 2 with no predecessor was accepted');
    } catch (e) {
      if (/no predecessor_run_id/.test(e.message)) ok('an attempt beyond the first must name its predecessor');
      else bad('orphan-attempt refusal failed for the wrong reason', e.message);
    }

    // ── 7. PARENT AND PREDECESSOR ARE INDEPENDENT GRAPHS ───────────────────
    // A 4-deep delegation chain, with level 3 failing and being retried. The retry keeps the
    // parent and the root, so lineage returns the tree once rather than double-counting the retry.
    const L1 = await insert(aq, { intent_key: 'parent-chain-root', trigger: 'manual' });
    const L2 = await insert(aq, { parent_run_id: L1, root_run_id: L1, intent_key: 'pc:L2' });
    const L3 = await insert(aq, { parent_run_id: L2, root_run_id: L1, intent_key: 'pc:L3' });
    await setState(aq, L3, 'FAILED', ', ended_at = NOW()');
    const L3b = await insert(aq, { parent_run_id: L2, root_run_id: L1, intent_key: 'pc:L3', attempt: 2, predecessor_run_id: L3 });
    const L4 = await insert(aq, { parent_run_id: L3b, root_run_id: L1, intent_key: 'pc:L4' });
    const tree = await bq(`SELECT run_id, parent_run_id, attempt, predecessor_run_id FROM agent_runs WHERE root_run_id=$1`, [L1]);
    if (tree.rows.length === 5) ok('lineage by root_run_id returns the 4-level chain plus the one retry');
    else bad(`root lineage returned ${tree.rows.length} rows, expected 5`);
    const retryRow = tree.rows.find((r) => r.run_id === L3b);
    if (retryRow.parent_run_id === L2 && retryRow.predecessor_run_id === L3) {
      ok('the retry keeps its PARENT (delegation) and its PREDECESSOR (retry) — two graphs, not one');
    } else bad('the retry lost a graph', JSON.stringify(retryRow));
    const distinctWork = await bq(
      `SELECT COUNT(DISTINCT intent_key)::int n FROM agent_runs WHERE root_run_id=$1`, [L1]);
    if (distinctWork.rows[0].n === 4) ok('counting WORK by intent gives 4, so a retry does not inflate the objective');
    else bad(`distinct intents under the root = ${distinctWork.rows[0].n}, expected 4`);
    if (L4) { /* referenced for cleanup */ }

    // ── APPEND-ONLY EVIDENCE ───────────────────────────────────────────────
    for (const [sql, label] of [
      [`UPDATE agent_run_events SET error='rewritten' WHERE run_id='${a1}'`, 'UPDATE'],
      [`DELETE FROM agent_run_events WHERE run_id='${a1}'`, 'DELETE'],
    ]) {
      try { await aq(sql); bad(`agent_run_events allowed an ${label}`); }
      catch (e) {
        if (/append-only/.test(e.message)) ok(`agent_run_events refuses ${label}`);
        else bad(`${label} failed for the wrong reason`, e.message);
      }
    }

    // ── IDENTITY IS IMMUTABLE ──────────────────────────────────────────────
    for (const [sql, label] of [
      [`UPDATE agent_runs SET intent_key='something-else' WHERE run_id='${b2}'`, 'intent_key'],
      [`UPDATE agent_runs SET attempt=9 WHERE run_id='${b2}'`, 'attempt'],
      [`UPDATE agent_runs SET root_run_id='${a1}' WHERE run_id='${b2}'`, 'root_run_id'],
    ]) {
      try { await aq(sql); bad(`${label} was mutable`); }
      catch (e) {
        if (/immutable/.test(e.message)) ok(`${label} cannot be changed after the fact`);
        else bad(`${label} guard failed for the wrong reason`, e.message);
      }
    }

    // ── ILLEGAL TRANSITIONS ────────────────────────────────────────────────
    const t1 = await insert(aq, { intent_key: 'cron:trans:2026-10-27T09:00' });
    try {
      await setState(aq, t1, 'SUCCEEDED');
      bad('CREATED went straight to SUCCEEDED — a run that never started looked successful');
    } catch (e) {
      if (/may not go directly/.test(e.message)) ok('CREATED cannot go straight to SUCCEEDED');
      else bad('transition guard failed for the wrong reason', e.message);
    }
    await setState(aq, t1, 'STOPPED_BY_POLICY', ', ended_at = NOW()');
    try {
      await setState(aq, t1, 'SUCCEEDED');
      bad('STOPPED_BY_POLICY became SUCCEEDED');
    } catch (e) {
      if (/terminal/.test(e.message)) ok('STOPPED_BY_POLICY can never become SUCCEEDED');
      else bad('terminal guard failed for the wrong reason', e.message);
    }

    // A policy-stopped run points at the exact refusal that stopped it.
    try {
      await aq(`INSERT INTO autonomy_stops (scope_type, scope_key, reason) VALUES ('global','','check fixture stop')`);
      const ev = await aq(`SELECT id FROM autonomy_events WHERE action='STOP' ORDER BY id DESC LIMIT 1`);
      await aq(`UPDATE agent_runs SET stopped_by=$2 WHERE run_id=$1`, [t1, ev.rows[0].id]);
      const j = await bq(`SELECT r.state, e.reason FROM agent_runs r JOIN autonomy_events e ON e.id = r.stopped_by WHERE r.run_id=$1`, [t1]);
      if (j.rows[0] && /check fixture stop/.test(j.rows[0].reason)) {
        ok('a STOPPED_BY_POLICY run joins to the exact autonomy_events refusal that caused it');
      } else bad('stopped_by did not resolve to the refusal');
      await aq(`DELETE FROM autonomy_stops WHERE scope_type='global' AND scope_key=''`);
    } catch (e) {
      bad('could not link a run to its refusal', e.message);
    }

    // ── 8. A SEPARATE PROCESS SEES ALL OF IT ───────────────────────────────
    const child = spawnSync(process.execPath, ['-e', `
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.U, ssl: false });
      (async () => {
        const hist = await pool.query("SELECT attempt, state FROM agent_runs WHERE intent_key=$1 ORDER BY attempt", [process.env.I]);
        const active = await pool.query("SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key=$1 AND state IN ('CREATED','RUNNING')", [process.env.I]);
        let blocked = false;
        try { await pool.query("UPDATE agent_run_events SET error='x' WHERE true"); }
        catch (e) { blocked = /append-only/.test(e.message); }
        console.log(JSON.stringify({ hist: hist.rows, active: active.rows[0].n, blocked }));
        await pool.end();
      })().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
    `], { env: { ...process.env, U: url, I: intent }, encoding: 'utf8', timeout: 30000 });
    let v = null;
    try { v = JSON.parse(String(child.stdout).trim()); } catch (_) {}
    if (v && v.hist.length === 2 && v.hist[0].state === 'FAILED' && v.hist[1].state === 'SUCCEEDED') {
      ok('a SEPARATE PROCESS reconstructs both attempts with their original outcomes');
    } else bad('a separate process saw different history', `${child.stdout}${child.stderr}`);
    if (v && v.active === 0) ok('the active slot is free once every attempt is terminal');
    else bad(`a separate process sees ${v && v.active} active runs for a finished intent`);
    if (v && v.blocked === true) ok('append-only enforcement holds in another process too');
    else bad('append-only did not hold in another process');

    // ── COST ROLLUP, WHERE USAGE IS ACTUALLY AVAILABLE ─────────────────────
    const cst = await insert(aq, { intent_key: 'cron:cost:2026-10-27T09:00' });
    await setState(aq, cst, 'RUNNING', ', started_at = NOW()');
    await event(aq, cst, 'ACTION_SUCCEEDED', { action_kind: 'llm.call', success: true, cost_usd: 0.0123, tokens_input: 900, tokens_output: 300 });
    await event(aq, cst, 'ACTION_SUCCEEDED', { action_kind: 'llm.call', success: true, cost_usd: 0.0077, tokens_input: 100, tokens_output: 50 });
    await aq(`UPDATE agent_runs r SET cost_usd = s.c, tokens_input = s.i, tokens_output = s.o
                FROM (SELECT SUM(cost_usd) c, SUM(tokens_input) i, SUM(tokens_output) o
                        FROM agent_run_events WHERE run_id=$1) s WHERE r.run_id=$1`, [cst]);
    const roll = await bq(`SELECT cost_usd, tokens_input, tokens_output FROM agent_runs WHERE run_id=$1`, [cst]);
    if (Number(roll.rows[0].cost_usd) === 0.02 && roll.rows[0].tokens_input === 1000) {
      ok('the run cost rollup equals the sum of its events (partial coverage by design)');
    } else bad('cost rollup wrong', JSON.stringify(roll.rows[0]));

    // ── CLEANUP: only rows this check created, by explicit id ──────────────
    await aq(`DELETE FROM agent_run_events WHERE run_id = ANY($1)`, [created])
      .catch(async () => {
        // append-only refuses DELETE by trigger, which is correct. Drop the trigger to clean up our
        // own fixtures, then restore it — never leaving the invariant off.
        await aq(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`);
        await aq(`DELETE FROM agent_run_events WHERE run_id = ANY($1)`, [created]);
        await aq(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`);
      });
    // Children before parents, since parent_run_id and predecessor_run_id are real FKs. Loop until
    // nothing more can be removed rather than a fixed number of passes: the deepest fixture chain
    // is parent 4 deep WITH a retry edge, and a fixed count silently leaves rows behind — which it
    // did, at 4.
    for (let pass = 0; pass < 12; pass += 1) {
      const r = await aq(`DELETE FROM agent_runs WHERE run_id = ANY($1)
                  AND NOT EXISTS (SELECT 1 FROM agent_runs c
                                   WHERE c.run_id <> agent_runs.run_id
                                     AND (c.parent_run_id = agent_runs.run_id
                                       OR c.predecessor_run_id = agent_runs.run_id))`, [created]);
      if (!r.rowCount) break;
    }
    const left = await bq(`SELECT COUNT(*)::int n FROM agent_runs WHERE run_id = ANY($1)`, [created]);
    if (left.rows[0].n === 0) ok('fixture runs removed by explicit id');
    else bad(`${left.rows[0].n} fixture run(s) left behind`);
    const trg = await bq(`SELECT tgenabled FROM pg_trigger WHERE tgname='trg_agent_run_events_append_only'`);
    if (trg.rows[0] && trg.rows[0].tgenabled === 'O') ok('the append-only trigger is enabled again after cleanup');
    else bad('the append-only trigger was left disabled', JSON.stringify(trg.rows));
  } catch (e) {
    bad('threw', e && e.stack ? e.stack : e);
  } finally {
    await A.end().catch(() => {});
    await B.end().catch(() => {});
    stopTemp();
  }

  if (fail) { console.log(`FAIL  ${fail} check(s) failed`); process.exit(1); }
  console.log('PASS  one active execution per intent, retries preserved, identity immutable, evidence append-only');
})();
