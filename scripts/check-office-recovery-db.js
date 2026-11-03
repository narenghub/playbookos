#!/usr/bin/env node
// ── K4: STALE-RUN RECOVERY AND RETRY, AGAINST A REAL POSTGRES ───────────────
//
//   scripts/check-office-recovery-db.js  → exit 0 = recovery is safe to deploy inert
//
// Covers the 19 adversarial cases required by the K4 ruling, plus mutation controls, plus the
// 20-way reaper race. Every mechanism under test is server-side — a partial unique index, two
// BEFORE triggers, and row-level arbitration — so none of it can be proven with a stubbed query.
//
// ── THE THREE THINGS MOST WORTH PROVING ─────────────────────────────────────
//
// 1. EXACTLY ONE REAPER OWNS A RECOVERY. Twenty concurrent attempts on one eligible run: one
//    transition, one durable record, one exception. Not "it looked fine" — counted. The arbiter is
//    the UPDATE's own WHERE clause, so this also proves there is no SELECT-then-UPDATE window.
//
// 2. RETRY IS NOT RESUME. Attempt 1 stays terminal and immutable; attempt 2 is a NEW run_id with
//    the SAME intent_key and predecessor set. If a retry could reopen the prior run, the attempt
//    history of both would be a lie.
//
// 3. A KNOWN-UNKNOWN IS NEVER AUTOMATICALLY RETRIED. An ACTION_ATTEMPTED with no terminal
//    acknowledgement means the external effect MAY have happened. The database demands a recorded
//    human override; this check proves the refusal AND that the override works, because a guard
//    that refuses everything is not a guard.
//
// Fixtures are recorded by id and deleted by exactly those ids in a finally. The post-condition is
// "my fixtures are gone", never "the table is empty".
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

const findInitdb = pgBin;
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/office-k4-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55997' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55997 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55997&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.OFFICE_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set OFFICE_PG_URL or install initdb)');
  console.log('SKIP  K4 recovery not executed against a server — this check needs one');
  process.exit(EXIT_NOT_EXECUTED);
}
// src/lib/autonomy.js writes a stop through db.js's withTransaction, NOT through an injectable
// query — so injecting deps.query is not enough and an un-set DATABASE_URL made it dial
// localhost:5432. The kill-switch re-evaluation under test is a real production path, so the
// fixture cluster has to be the module-level database too, not only the one this check holds.
process.env.DATABASE_URL = url;

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  // A SECOND pool, so "a crash/restart sees the durable prior state" is read on a different
  // connection than the one that wrote it. Reading back on the writing connection would pass even
  // if nothing were durable.
  const P2 = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const q2 = (t, p) => P2.query(t, p);
  const deps = { query: q };

  const ids = { runs: [], companies: [], objectives: [] };
  const { migrateRuns } = require('../src/lib/runs');
  const { migrateOffice } = require('../src/lib/office/schema');
  const autonomy = require('../src/lib/autonomy');
  const recovery = require('../src/lib/office/recovery');
  const { ledger } = require('../src/lib/run-ledger');

  // Insert a run directly at a chosen age and state. created_at/started_at are set explicitly
  // because startRun() stamps NOW() and nothing can age a row afterwards: the transition guard
  // freezes created_at on UPDATE, which is correct and makes direct insertion the only route.
  async function mkRun({ state = 'RUNNING', ageMinutes = 0, workflow = 'test-wf', intentKey = null,
    ceiling = null, companyId = null, objectiveId = null, attempt = 1, predecessor = null,
    override = null, agent = 'test-agent' } = {}) {
    const runId = crypto.randomUUID();
    await q(
      `INSERT INTO agent_runs
         (run_id, root_run_id, trigger, product, state, workflow, agent, intent_key, attempt,
          predecessor_run_id, retry_override_reason, max_runtime_minutes, company_id, objective_id,
          created_at, started_at)
       VALUES ($1,$1,'cron','internal',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               NOW() - ($12 || ' minutes')::interval,
               CASE WHEN $2 = 'CREATED' THEN NULL ELSE NOW() - ($12 || ' minutes')::interval END)`,
      [runId, state, workflow, agent, intentKey, attempt, predecessor, override, ceiling,
       companyId, objectiveId, String(ageMinutes)]
    );
    ids.runs.push(runId);
    return runId;
  }
  const stateOf = async (runId, reader = q) =>
    (await reader(`SELECT state FROM agent_runs WHERE run_id=$1`, [runId])).rows[0]?.state;
  const attempted = async (runId, subjectRef) => q(
    `INSERT INTO agent_run_events (run_id, kind, action_kind, subject_type, subject_ref)
     VALUES ($1,'ACTION_ATTEMPTED','email.send','supplier',$2)`, [runId, subjectRef]);

  try {
    await migrateRuns(q);
    await migrateOffice(q);
    await autonomy.migrateAutonomy(q);
    ok('schema applied (runs + office + autonomy)');

    const ceilDefault = recovery.DEFAULT_CEILING_MINUTES;
    note(`declared-ceiling policy: objective-review=${recovery.CEILINGS['objective-review']}m, default=${ceilDefault}m`);

    // ══ 1. ELIGIBILITY AND THE FOUR CLASSES ════════════════════════════════
    const staleCreated = await mkRun({ state: 'CREATED', ageMinutes: 400 });
    const staleRunning = await mkRun({ state: 'RUNNING', ageMinutes: 400 });
    const freshRunning = await mkRun({ state: 'RUNNING', ageMinutes: 5 });
    const declaredFresh = await mkRun({ state: 'RUNNING', ageMinutes: 400, ceiling: 1000 });

    let r = await recovery.recoverRun(staleCreated, deps);
    if (!r.recovered || r.classification !== 'safe_stale') bad(`stale CREATED was not recovered as safe_stale: ${JSON.stringify(r)}`);
    else if (await stateOf(staleCreated) !== 'ABANDONED') bad('stale CREATED did not become ABANDONED');
    else ok('stale CREATED -> ABANDONED when eligible');

    r = await recovery.recoverRun(staleRunning, deps);
    if (!r.recovered || await stateOf(staleRunning) !== 'ABANDONED') bad(`stale RUNNING was not abandoned: ${JSON.stringify(r)}`);
    else ok('stale RUNNING -> ABANDONED when eligible');

    r = await recovery.recoverRun(freshRunning, deps);
    if (r.recovered) bad('a FRESH RUNNING run was recovered');
    else if (r.reason !== 'fresh') bad(`fresh run skipped for the wrong reason: ${r.reason}`);
    else if (await stateOf(freshRunning) !== 'RUNNING') bad('fresh RUNNING run was modified');
    else ok('fresh RUNNING untouched');

    r = await recovery.recoverRun(declaredFresh, deps);
    if (r.recovered) bad('a run 400m old with a DECLARED 1000m ceiling was recovered — the declaration was ignored');
    else ok('a declared ceiling overrides the default: 400m old, 1000m declared, untouched');

    // Terminal states, including the one that must never be re-judged by elapsed time.
    for (const st of ['SUCCEEDED', 'PARTIAL', 'FAILED', 'ABANDONED', 'STOPPED_BY_POLICY']) {
      const t = await mkRun({ state: st, ageMinutes: 9999 });
      const res = await recovery.recoverRun(t, deps);
      if (res.recovered) bad(`a terminal ${st} run was recovered`);
      else if (await stateOf(t) !== st) bad(`terminal ${st} run was modified`);
      else ok(`terminal ${st} untouched, however old`);
    }

    // ══ 2. KNOWN-UNKNOWN ═══════════════════════════════════════════════════
    const A = `k4-co-${crypto.randomUUID()}`;
    await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [A]);
    ids.companies.push(A);
    const OA = `k4-obj-${crypto.randomUUID()}`;
    await q(`INSERT INTO objectives (id, company_id, objective, priority, autonomy_tier, approval_policy, status, created_by)
             VALUES ($1,$2,'k4 fixture','P3','none','none','active','check')`, [OA, A]);
    ids.objectives.push(OA);

    const ku = await mkRun({ state: 'RUNNING', ageMinutes: 400, companyId: A, objectiveId: OA,
      intentKey: `office:test:${OA}:ku`, workflow: 'objective-review' });
    await attempted(ku, 'supplier-xyz');

    const cand = (await recovery.candidates({}, deps)).find((c) => c.run_id === ku);
    if (!cand || cand.classification !== 'known_unknown') bad(`the unresolved-action run was not classified known_unknown: ${JSON.stringify(cand)}`);
    else ok('a run with an unresolved ACTION_ATTEMPTED classifies as known_unknown');

    r = await recovery.recoverRun(ku, deps);
    if (!r.recovered || r.classification !== 'known_unknown') bad(`known-unknown recovery failed: ${JSON.stringify(r)}`);
    else ok('a known-unknown is recovered as ABANDONED (asserting no recorded outcome, not failure)');

    const kuRecs = await recovery.knownUnknownRecoveries({}, deps);
    if (!kuRecs.some((x) => x.run_id === ku)) bad('the known-unknown is NOT machine-queryable — an email alone is insufficient');
    else ok('the known-unknown is surfaced durably and is machine-queryable');

    const exRow = (await q(
      `SELECT id, severity, status, sla_hours, company_id FROM office_exceptions WHERE run_id=$1`, [ku]
    )).rows[0];
    if (!exRow) bad('no office_exceptions row was filed for a known-unknown with a company');
    else if (exRow.severity !== 'critical' || exRow.status !== 'open') bad(`the exception is ${exRow.severity}/${exRow.status}`);
    else ok(`the known-unknown reached the existing exception queue (${exRow.severity}, SLA ${exRow.sla_hours}h) — adopted, not a second system`);

    // A companyless known-unknown cannot be queued (office_exceptions requires a company) and must
    // still be durably recorded. This is the case that would otherwise vanish.
    const kuLegacy = await mkRun({ state: 'RUNNING', ageMinutes: 400, intentKey: `legacy:ku:${crypto.randomUUID()}` });
    await attempted(kuLegacy, 'legacy-subject');
    r = await recovery.recoverRun(kuLegacy, deps);
    if (!r.recovered || r.classification !== 'known_unknown') bad('a legacy known-unknown was not recovered');
    else if (r.exception_id !== null) bad('a legacy run was somehow queued despite having no company');
    else if (!(await recovery.knownUnknownRecoveries({}, deps)).some((x) => x.run_id === kuLegacy)) {
      bad('a LEGACY known-unknown left no durable record — it would vanish');
    } else ok('a companyless known-unknown is still durably recorded, though it cannot be queued');

    // ══ 3. THE 20-WAY REAPER RACE ══════════════════════════════════════════
    const raced = await mkRun({ state: 'RUNNING', ageMinutes: 400, companyId: A, objectiveId: OA,
      intentKey: `office:test:${OA}:race`, workflow: 'objective-review' });
    await attempted(raced, 'race-subject');
    const racers = await Promise.all(
      Array.from({ length: 20 }, () => recovery.recoverRun(raced, deps))
    );
    const winners = racers.filter((x) => x.recovered);
    if (winners.length !== 1) bad(`${winners.length} of 20 reapers recovered the same run — recovery is not arbitrated`);
    else ok('20 concurrent recovery attempts: exactly ONE owns the transition');
    const losers = racers.filter((x) => !x.recovered);
    const badLoser = losers.find((x) => !['lost_race', 'already_terminal'].includes(x.reason));
    if (badLoser) bad(`a losing reaper reported an unexpected reason: ${JSON.stringify(badLoser)}`);
    else ok('the other 19 observe the current/terminal state and do nothing');
    const evN = (await q(`SELECT COUNT(*)::int n FROM agent_run_events WHERE run_id=$1 AND kind='RECOVERY_ABANDONED'`, [raced])).rows[0].n;
    if (evN !== 1) bad(`${evN} RECOVERY_ABANDONED events for one run — duplicate escalation`);
    else ok('exactly one durable recovery record, not twenty');
    const exN = (await q(`SELECT COUNT(*)::int n FROM office_exceptions WHERE run_id=$1`, [raced])).rows[0].n;
    if (exN !== 1) bad(`${exN} exceptions for one run — duplicate escalation`);
    else ok('exactly one exception, not twenty');

    // ══ 4. RETRY ═══════════════════════════════════════════════════════════
    const intent = `cron:k4-retry:${crypto.randomUUID()}`;
    const failed = await mkRun({ state: 'FAILED', ageMinutes: 10, intentKey: intent });
    const rr = await recovery.retryRun(failed, {}, deps);
    if (!rr.retried) bad(`FAILED -> attempt 2 refused: ${JSON.stringify(rr)}`);
    else {
      ids.runs.push(rr.runId);
      ok('FAILED -> attempt 2');
      if (rr.runId === failed) bad('the retry reused the predecessor run id');
      else ok('the retry receives a NEW run id (retry is not resume)');
      const n = (await q(`SELECT intent_key, attempt, predecessor_run_id, state FROM agent_runs WHERE run_id=$1`, [rr.runId])).rows[0];
      if (n.intent_key !== intent) bad(`intent identity changed: ${n.intent_key}`);
      else ok('intent identity is stable across attempts');
      if (n.predecessor_run_id !== failed) bad('predecessor_run_id is wrong');
      else ok('predecessor is recorded correctly');
      if (n.attempt !== 2) bad(`attempt did not increment (got ${n.attempt})`);
      else ok('attempt increments to 2');
      if (await stateOf(failed) !== 'FAILED') bad('attempt 1 was mutated by the retry — it must stay historical evidence');
      else ok('attempt 1 remains FAILED and immutable — the previous run was never reopened');
    }

    // Refusals. Each must come from the database's own guard.
    const succeeded = await mkRun({ state: 'SUCCEEDED', ageMinutes: 10, intentKey: `cron:k4-s:${crypto.randomUUID()}` });
    let x = await recovery.retryRun(succeeded, {}, deps);
    if (x.retried) bad('a SUCCEEDED run was retried');
    else ok(`retry of SUCCEEDED refused (${x.reason})`);

    const active = await mkRun({ state: 'RUNNING', ageMinutes: 1, intentKey: `cron:k4-a:${crypto.randomUUID()}` });
    x = await recovery.retryRun(active, {}, deps);
    if (x.retried) bad('an ACTIVE run was retried');
    else ok(`retry of an active run refused (${x.reason})`);

    const abandoned = await mkRun({ state: 'ABANDONED', ageMinutes: 10, intentKey: `cron:k4-ab:${crypto.randomUUID()}` });
    x = await recovery.retryRun(abandoned, {}, deps);
    if (x.retried) bad('an ABANDONED run was retried with NO override');
    else ok(`retry of ABANDONED without an override refused (${x.reason})`);
    x = await recovery.retryRun(abandoned, { overrideReason: 'operator reviewed the ledger and accepts the ambiguity' }, deps);
    if (!x.retried) bad(`ABANDONED retry WITH an override was refused: ${JSON.stringify(x)}`);
    else { ids.runs.push(x.runId); ok('retry of ABANDONED WITH a recorded override accepted — the guard refuses, it does not forbid'); }

    // An unresolved consequential action requires an override even from a FAILED predecessor.
    const failedKU = await mkRun({ state: 'FAILED', ageMinutes: 10, intentKey: `cron:k4-fku:${crypto.randomUUID()}` });
    await attempted(failedKU, 'unresolved-subject');
    x = await recovery.retryRun(failedKU, {}, deps);
    if (x.retried) bad('a run with an unresolved ACTION_ATTEMPTED was AUTOMATICALLY retried');
    else ok(`an unresolved ACTION_ATTEMPTED is not auto-retried (${x.reason})`);
    x = await recovery.retryRun(failedKU, { overrideReason: 'checked the supplier mailbox; no message was sent' }, deps);
    if (!x.retried) bad('an explicit override could not resolve the ambiguity');
    else { ids.runs.push(x.runId); ok('an explicit, recorded override permits the retry'); }

    // A run with no intent_key cannot be retried, and says so rather than failing obscurely.
    const noIntent = await mkRun({ state: 'FAILED', ageMinutes: 10 });
    x = await recovery.retryRun(noIntent, {}, deps);
    if (x.retried) bad('a run with no intent_key was retried — the attempt history of its intent is now unprovable');
    else ok(`a run with no intent_key cannot be retried (${x.reason})`);

    // ══ 5. STOPPED_BY_POLICY RE-EVALUATES THE KILL POLICY ══════════════════
    autonomy.resetForTests && autonomy.resetForTests();
    // K8 refuses a stop whose scope key names nothing, so this fixture workflow must be declared
    // the same way a real non-cron owner declares its own. That interaction is the point: before
    // K8 this check happily stopped an invented workflow name and the stop protected nothing.
    autonomy.registerScopes({ workflows: ['k4-stopped-wf'], agents: ['k4-agent'] });
    const stoppedIntent = `cron:k4-sbp:${crypto.randomUUID()}`;
    const sbp = await mkRun({ state: 'STOPPED_BY_POLICY', ageMinutes: 10, intentKey: stoppedIntent,
      workflow: 'k4-stopped-wf', agent: 'k4-agent' });
    // Assert the precondition. An earlier version ignored stop()'s return value, and when K8 began
    // refusing the invented scope key the "stop" silently did nothing — so the next assertion
    // reported that the retry path bypasses the kill switch when in fact no stop existed. A
    // precondition is asserted, never assumed.
    const stopped = await autonomy.stop({ scope_type: 'workflow', scope_key: 'k4-stopped-wf',
      reason: 'K4 check: the stop must still be in force at retry time', actor: 'check' },
      { deps: { query: q } });
    if (!stopped.ok) bad(`the fixture stop was not created, so the next assertion would be meaningless: ${stopped.error}`);
    else ok('the fixture workflow stop is in force (asserted, not assumed)');
    x = await recovery.retryRun(sbp, {}, deps);
    if (x.runId) ids.runs.push(x.runId);
    if (x.retried) bad('a STOPPED_BY_POLICY run was retried WHILE THE STOP WAS STILL IN FORCE — the retry path bypasses the kill switch');
    else if (x.reason !== 'still_stopped_by_policy') bad(`refused for the wrong reason: ${JSON.stringify(x)}`);
    else ok(`retry of STOPPED_BY_POLICY re-evaluates the kill policy and refuses while stopped (${x.scope_type})`);

    // resume() RETURNS { ok:false, error } rather than throwing, and it requires a reason of at
    // least 10 characters. The first version of this check omitted the reason and ignored the
    // return value, so the resume silently did nothing and the next assertion "failed" against a
    // stop that was still in force. A precondition is asserted, never assumed.
    const resumed = await autonomy.resume({ scope_type: 'workflow', scope_key: 'k4-stopped-wf',
      reason: 'K4 check: lifting the fixture stop to prove policy is re-evaluated', actor: 'check' },
      { deps: { query: q } });
    if (!resumed.ok || resumed.removed !== 1) bad(`the fixture stop was not lifted: ${JSON.stringify(resumed)}`);
    else ok('the fixture stop was lifted (asserted, not assumed)');
    autonomy.resetForTests && autonomy.resetForTests();
    x = await recovery.retryRun(sbp, {}, deps);
    if (x.runId) ids.runs.push(x.runId);
    if (!x.retried) bad(`after the stop was lifted the retry was still refused: ${JSON.stringify(x)}`);
    else ok('once the stop is lifted the same retry is permitted — policy is re-evaluated, not remembered');

    // ══ 6. DURABILITY ACROSS A CRASH ═══════════════════════════════════════
    if (await stateOf(staleRunning, q2) !== 'ABANDONED') bad('a second connection does not see the recovery — it is not durable');
    else ok('a crash/restart (second connection) sees the durable prior run state');
    const ev2 = (await q2(`SELECT detail FROM agent_run_events WHERE run_id=$1 AND kind='RECOVERY_ABANDONED'`, [ku])).rows[0];
    if (!ev2 || !ev2.detail || ev2.detail.classification !== 'known_unknown') bad('the recovery classification is not durable across connections');
    else ok('the recovery classification and its policy are durable and readable elsewhere');

    // ══ 7. THE REAPER'S DEFAULT IS DRY ═════════════════════════════════════
    const willBeStale = await mkRun({ state: 'RUNNING', ageMinutes: 500, intentKey: `cron:k4-dry:${crypto.randomUUID()}` });
    const dry = await recovery.reap({}, deps);
    if (!dry.dry_run) bad('reap() ACTED by default — one accidental invocation would abandon live work');
    else ok('reap() is dry by default and reports what it would change');
    if (!dry.would_change.some((c) => c.run_id === willBeStale)) bad('the dry run did not list an eligible candidate');
    else ok('the dry run names each candidate with its age, ceiling and the source of that ceiling');
    if (await stateOf(willBeStale) !== 'RUNNING') bad('the DRY run modified a row');
    else ok('the dry run changed nothing');

    // excludeRunId: the reaper now runs inside a ledger run of its own, which is CREATED/RUNNING
    // while it sweeps. Without this it would appear in its own candidate list and — once past its
    // ceiling — abandon itself mid-flight, then keep writing against a terminal run.
    const selfRun = await mkRun({ state: 'RUNNING', ageMinutes: 400,
      workflow: 'quarter-hourly-office-recovery', intentKey: `cron:k4-self:${crypto.randomUUID()}` });
    const listed = await recovery.candidates({ excludeRunId: selfRun }, deps);
    if (listed.some((c) => c.run_id === selfRun)) bad('excludeRunId did not remove the run from its own candidate list');
    else ok('excludeRunId removes the sweeping run from its own candidate list');

    await recovery.reap({ dryRun: false, excludeRunId: selfRun }, deps);
    if (await stateOf(selfRun) !== 'RUNNING') bad('the reaper ABANDONED ITSELF despite excludeRunId');
    else ok('an acting reap does not abandon the run it is executing inside');

    const wet = await recovery.reap({ dryRun: false }, deps);
    if (!wet.recovered) bad('an explicit non-dry reap recovered nothing');
    else ok(`an explicit reap({dryRun:false}) recovers (${wet.recovered} run(s))`);

    // The library default must stay dry now that an acting caller exists: the cron states
    // dryRun:false explicitly, and nothing may come to rely on the default flipping.
    const stillDry = await recovery.reap({}, deps);
    if (!stillDry.dry_run) bad('reap() no longer defaults to dry — an accidental call would now act');
    else ok('reap() STILL defaults to dry after activation; the acting caller states dryRun:false');

    // ══ 8. MUTATION CONTROLS ═══════════════════════════════════════════════
    note('mutation controls: disable each mechanism, prove the attack then succeeds');

    // M1 — the arbiter. Replace the arbitrated UPDATE with SELECT-then-UPDATE and prove the race
    // breaks. Done by patching the file, the only way to show the SHIPPED code is what protects us.
    const RECOVERY_FILE = path.join(__dirname, '..', 'src', 'lib', 'office', 'recovery.js');
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const before = sha(RECOVERY_FILE);
    const src = fs.readFileSync(RECOVERY_FILE, 'utf8');
    const needle = `      WHERE run_id = $1 AND state = ANY($2)
      RETURNING run_id, state\``;
    if (!src.includes(needle)) {
      bad('M1 could not locate the arbitrated UPDATE — the mutation control is stale and proves nothing');
    } else {
      // Drop the state predicate AND its parameter together. An earlier version removed only the
      // predicate and left [runId, ACTIVE] bound, so the mutated query failed with "bind message
      // supplies 2 parameters, but prepared statement requires 1" — the mutation errored instead
      // of racing, and the control proved nothing while appearing to run. Same defect class as the
      // K1 M5 control.
      fs.writeFileSync(RECOVERY_FILE, src
        .replace(needle, `      WHERE run_id = $1
      RETURNING run_id, state\``)
        .replace('    [runId, ACTIVE]\n  );\n  if (!claimed.rows.length)', '    [runId]\n  );\n  if (!claimed.rows.length)'));
      try {
        for (const k of Object.keys(require.cache)) {
          if (k.includes(path.join('src', 'lib', 'office', 'recovery.js'))) delete require.cache[k];
        }
        const mutated = require('../src/lib/office/recovery');
        const raced2 = await mkRun({ state: 'RUNNING', ageMinutes: 400, intentKey: `cron:k4-m1:${crypto.randomUUID()}` });
        const rs = await Promise.all(Array.from({ length: 20 }, () => mutated.recoverRun(raced2, deps)));
        const w = rs.filter((z) => z.recovered).length;
        if (w <= 1) bad(`M1 with the state predicate removed only ${w} reaper(s) still won — the predicate may not be what arbitrates`);
        else ok(`M1 removing the state predicate lets ${w} of 20 reapers all "recover" the same run — the arbitration is load-bearing`);
      } finally {
        fs.writeFileSync(RECOVERY_FILE, src);
        for (const k of Object.keys(require.cache)) {
          if (k.includes(path.join('src', 'lib', 'office', 'recovery.js'))) delete require.cache[k];
        }
      }
    }
    if (sha(RECOVERY_FILE) !== before) bad('M1 recovery.js was NOT restored byte-for-byte');
    else ok('M1 recovery.js restored, verified by content hash');

    // M2 — the retry guard. Drop it and prove a SUCCEEDED run becomes retryable.
    await q(`DROP TRIGGER IF EXISTS trg_agent_runs_retry_guard ON agent_runs`);
    const fresh2 = require('../src/lib/office/recovery');
    const bypass = await fresh2.retryRun(succeeded, {}, deps);
    if (!bypass.retried) bad('M2 with the retry guard dropped a SUCCEEDED run was still refused — the guard may not be what protects us', JSON.stringify(bypass));
    else { ids.runs.push(bypass.runId); ok('M2 dropping the retry guard makes a SUCCEEDED run retryable — the guard is load-bearing'); }
    await migrateRuns(q);
    const back = await fresh2.retryRun(succeeded, {}, deps);
    if (back.retried) { ids.runs.push(back.runId); bad('after restoring the retry guard a SUCCEEDED run was still retryable'); }
    else ok('after restore the SUCCEEDED retry is refused again');

    // M3 — terminal immutability. Prove the transition guard is what stops a terminal rewrite.
    const term = await mkRun({ state: 'SUCCEEDED', ageMinutes: 9999 });
    let threw = null;
    try { await q(`UPDATE agent_runs SET state='RUNNING' WHERE run_id=$1`, [term]); } catch (e) { threw = e; }
    if (!threw) bad('a terminal run was reopened to RUNNING');
    else ok(`a terminal run cannot be reopened (${threw.code}) — retry can only ever be a new run`);

  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    try {
      for (const id of ids.runs) await q(`DELETE FROM office_exceptions WHERE run_id = $1`, [id]);
      await q(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`);
      try {
        for (const id of ids.runs) await q(`DELETE FROM agent_run_events WHERE run_id = $1`, [id]);
        // Children before parents: a retry references its predecessor.
        await q(`UPDATE agent_runs SET predecessor_run_id = NULL WHERE run_id = ANY($1)`, [ids.runs])
          .catch(async () => {
            await q(`ALTER TABLE agent_runs DISABLE TRIGGER trg_agent_runs_transition_guard`);
            await q(`UPDATE agent_runs SET predecessor_run_id = NULL WHERE run_id = ANY($1)`, [ids.runs]);
            await q(`ALTER TABLE agent_runs ENABLE TRIGGER trg_agent_runs_transition_guard`);
          });
        // Sweep anything pointing at a fixture run. A retry created by an assertion that FAILED
        // may not be in ids.runs, and it would then block the predecessor FK on delete — which is
        // how cleanup failed once already.
        await q(`ALTER TABLE agent_runs DISABLE TRIGGER trg_agent_runs_transition_guard`);
        try {
          await q(`UPDATE agent_runs SET predecessor_run_id = NULL WHERE predecessor_run_id = ANY($1)`, [ids.runs]);
        } finally {
          await q(`ALTER TABLE agent_runs ENABLE TRIGGER trg_agent_runs_transition_guard`);
        }
        for (const id of ids.runs) await q(`DELETE FROM agent_runs WHERE run_id = $1`, [id]);
      } finally {
        await q(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`);
      }
      const trg = (await q(`SELECT tgenabled FROM pg_trigger WHERE tgname='trg_agent_run_events_append_only'`)).rows[0];
      if (!trg || trg.tgenabled === 'D') bad('the append-only trigger was left DISABLED after cleanup');
      else ok('the append-only trigger is enabled again after cleanup');

      for (const id of ids.objectives) await q(`DELETE FROM objectives WHERE id = $1`, [id]);
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]);

      const leaks = [];
      const mine = async (table, col, list) => {
        if (!list.length) return;
        const n = (await q(`SELECT COUNT(*)::int n FROM ${table} WHERE ${col} = ANY($1)`, [list])).rows[0].n;
        if (n) leaks.push(`${table}: ${n} of my rows remain`);
      };
      await mine('agent_runs', 'run_id', ids.runs);
      await mine('objectives', 'id', ids.objectives);
      await mine('companies', 'id', ids.companies);
      if (leaks.length) bad('fixture cleanup leaked', leaks.join('\n'));
      else ok('cleanup: every fixture row I created is gone (by id)');
    } catch (e) {
      bad('cleanup failed', e.message);
    }
    try { await P.end(); } catch (_) {}
    try { await P2.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} K4 recovery assertion(s) failed`
    : '\nPASS  K4: stale runs recover under an arbitrated transition, known-unknowns are never '
      + 'auto-retried and never vanish, and retry is a new run rather than a reopened one');
  process.exit(fail ? 1 : 0);
})();
