#!/usr/bin/env node
// ── WHO DECIDES WHAT A WORKER MAY EXECUTE? (Decision 4, 2026-11-25) ─────────
//
//   node scripts/check-worker-capability-authority-db.js   exit 0 = the authority holds
//                                                          exit 3 = NOT EXECUTED (no Postgres)
//
// Owner Decision 4: *"Worker capability grants are server-authorized, not self-declared."* And:
// *"Prepare the iMac capability enrollment change for review. Do not automatically grant
// exec:hardware or exec:gui to existing production identities."*
//
// ── THE PROPERTY, AND WHY IT IS WORTH PINNING ──────────────────────────────
//
// A worker that can name its own capabilities can claim any work it likes: the claim filter in
// worker/leases.js reads `capabilities` off the identity row, so that column IS the authorization.
// Measured here, three ways:
//
//   1. the capabilities come from the ENROLLMENT TOKEN, which an operator issued;
//   2. `consumeEnrollmentToken` has no capabilities parameter at all, so there is nothing for an
//      enrolling worker to supply;
//   3. no code path anywhere UPDATES the column, so a worker cannot acquire one later either.
//
// (1) is behaviour, (2) and (3) are structure. All three are asserted, because a signature can gain
// a parameter and a module can gain an UPDATE, and either would move the authority without moving
// the behaviour anybody tests.
//
// ── AND ONE GAP, STATED RATHER THAN IMPLIED ────────────────────────────────
//
// `exec:gui` is a GRANT, not evidence of a live desktop session. §4 measures exactly what holds
// today and records what does not, because the owner's wording — *"GUI-required work cannot execute
// without an authorized GUI session"* — asks for more than a capability column can give.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures by id.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);
const REPO = path.join(__dirname, '..');

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'wcap' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  worker capability authority not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'wcap-bootstrap@wcap.invalid';
process.env.ADMIN_PASSWORD = `wcap-${crypto.randomBytes(16).toString('hex')}`;
// The enrollment path seals the worker secret, and refuses before burning a token if it cannot.
// WORKER_SECRET_SEAL_KEY — the name the code actually reads. The first version set
// WORKER_SECRET_SEALING_KEY, enrollment refused with `cannot_seal` BEFORE burning the token (which
// is the right order), and six assertions failed for a missing fixture variable rather than for
// anything about capability authority.
process.env.WORKER_SECRET_SEAL_KEY = process.env.WORKER_SECRET_SEAL_KEY
  || crypto.randomBytes(32).toString('hex');

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 240s — a stall is a failure.');
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, 240_000);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };
  const ids = { workers: [], tasks: [], companies: [] };
  const uid = (p) => `wcap-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/autonomy').migrateAutonomy(q);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(q);
    await require('../src/lib/worker/leases').migrateWorkerTasks(q);
    console.log('  ..    schema up\n');

    const IDENTITY = require('../src/lib/worker/identity');
    const LEASES = require('../src/lib/worker/leases');
    const TYPES = require('../src/lib/worker/task-types');

    // ══ 1. THE CAPABILITIES COME FROM THE OPERATOR'S TOKEN ════════════════
    console.log('── 1. the grant travels on the enrollment token ──\n');

    const issued = await IDENTITY.createEnrollmentToken({
      label: 'wcap-cloud-worker', capabilities: [], createdBy: 'operator:naren',
    }, deps);
    if (issued && issued.token) {
      ok('an operator issues an enrollment token, naming the capabilities it will confer (none here)');
    } else bad('the token could not be issued', JSON.stringify(issued));

    const enrolled = await IDENTITY.consumeEnrollmentToken({
      token: issued.token, hostFingerprint: 'fixture-host',
    }, deps);
    if (enrolled.ok) { ok('a worker redeems it and receives an identity'); ids.workers.push(enrolled.workerId); }
    else bad('enrollment failed', JSON.stringify(enrolled));

    const row = (await q(`SELECT capabilities, enrolled_by FROM worker_identities WHERE id = $1`,
      [enrolled.workerId])).rows[0];
    if (row && Array.isArray(row.capabilities) && row.capabilities.length === 0) {
      ok('and its stored capabilities are the TOKEN\'s — empty, because the operator granted none');
      note(`enrolled_by: ${row.enrolled_by} — the token digest, not the worker`);
    } else bad('the stored capabilities did not come from the token', JSON.stringify(row));

    // The operator grants one on a SECOND token; the same worker code enrolls and gets it.
    const issuedHw = await IDENTITY.createEnrollmentToken({
      label: 'wcap-hardware-worker', capabilities: ['exec:hardware'], createdBy: 'operator:naren',
    }, deps);
    const enrolledHw = await IDENTITY.consumeEnrollmentToken({
      token: issuedHw.token, hostFingerprint: 'fixture-imac',
    }, deps);
    ids.workers.push(enrolledHw.workerId);
    const rowHw = (await q(`SELECT capabilities FROM worker_identities WHERE id = $1`,
      [enrolledHw.workerId])).rows[0];
    if (rowHw && rowHw.capabilities.includes('exec:hardware')) {
      ok('POSITIVE CONTROL: a token granting exec:hardware produces a worker that has it — the '
        + 'authority is the operator\'s, and it works');
    } else bad('the granted capability did not arrive', JSON.stringify(rowHw));

    // ══ 2. THERE IS NOTHING FOR A WORKER TO DECLARE ═══════════════════════
    console.log('\n── 2. the enrolling worker has no say ──\n');

    const idSrc = fs.readFileSync(path.join(REPO, 'src', 'lib', 'worker', 'identity.js'), 'utf8');
    const consumeSig = idSrc.slice(idSrc.indexOf('async function consumeEnrollmentToken'),
      idSrc.indexOf('{', idSrc.indexOf('async function consumeEnrollmentToken')));
    if (!/capabilit/i.test(consumeSig)) {
      ok('consumeEnrollmentToken accepts NO capabilities parameter — there is nothing an enrolling '
        + 'worker could supply, rather than something that is validated away');
      note(`its signature: ${consumeSig.replace(/\s+/g, ' ').trim()}`);
    } else bad('the enrollment path accepts capabilities from its caller',
      consumeSig.replace(/\s+/g, ' ').trim());

    // An enrolling worker that TRIES anyway gets nothing: the extra field is simply not read.
    const issued3 = await IDENTITY.createEnrollmentToken({
      label: 'wcap-liar', capabilities: [], createdBy: 'operator:naren' }, deps);
    const liar = await IDENTITY.consumeEnrollmentToken({
      token: issued3.token, hostFingerprint: 'fixture-liar',
      capabilities: ['exec:hardware', 'exec:gui'],
    }, deps);
    ids.workers.push(liar.workerId);
    const liarRow = (await q(`SELECT capabilities FROM worker_identities WHERE id = $1`,
      [liar.workerId])).rows[0];
    if (liarRow && liarRow.capabilities.length === 0) {
      ok('a worker that passes capabilities at enrollment anyway receives NONE of them');
    } else bad('a self-declared capability was stored', JSON.stringify(liarRow));

    // ══ 3. AND NO PATH GRANTS ONE LATER ══════════════════════════════════
    console.log('\n── 3. the column has no update path ──\n');

    const strip = (text) => text
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const writers = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(path.join(dir, e.name)); continue; }
        if (!/\.js$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
        const f = path.join(dir, e.name);
        const code = strip(fs.readFileSync(f, 'utf8'));
        // An UPDATE of worker_identities that touches `capabilities`, in any statement.
        if (/UPDATE\s+(\$\{[^}]*\}|worker_identities)[\s\S]{0,400}?SET[\s\S]{0,400}?capabilities\s*=/i.test(code)) {
          writers.push(path.relative(REPO, f));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    if (writers.length === 0) {
      ok('NO module in src/ updates worker_identities.capabilities — a granted set is immutable, '
        + 'so a worker cannot acquire a capability after enrollment either');
      note('re-granting means issuing a new token and enrolling again, which is an operator act '
        + 'with its own audit row');
    } else bad('a code path can rewrite a worker\'s capabilities', writers.join(', '));

    // The negative control: this scanner must be able to see one.
    const planted = path.join(REPO, 'src', 'lib', 'worker', '__wcap_control.js');
    fs.writeFileSync(planted,
      "// planted control\nmodule.exports = async (q, id) => q(`UPDATE worker_identities SET capabilities = $2 WHERE id = $1`, [id, ['exec:gui']]);\n");
    const before = writers.length;
    walk(path.join(REPO, 'src', 'lib', 'worker'));
    fs.rmSync(planted, { force: true });
    if (writers.length > before) {
      ok('negative control: a planted UPDATE of the column IS detected, so the silence above means '
        + 'something');
    } else bad('the scanner cannot see a capability write — its verdict is vacuous');

    // ══ 4. WHAT THE GRANT DOES AND DOES NOT PROVE ════════════════════════
    console.log('\n── 4. the claim filter, and the GUI gap ──\n');

    const CO = uid('co');
    await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [CO]);
    ids.companies.push(CO);

    const guiTask = await LEASES.enqueueTask({
      taskType: 'desktop.capture_once', payload: {}, intentKey: uid('gui'),
      companyId: CO, workflow: 'wcap',
    }, deps);
    ids.tasks.push(guiTask.taskId);
    const hwTask = await LEASES.enqueueTask({
      taskType: 'synthetic.crash_test', payload: {}, intentKey: uid('hw'),
      companyId: CO, workflow: 'wcap',
    }, deps);
    ids.tasks.push(hwTask.taskId);

    // The capability-less worker: may claim neither.
    const plainClaim = await LEASES.claimTask({ workerId: enrolled.workerId }, deps);
    if (!plainClaim.ok && plainClaim.code === 'nothing_claimable_by_this_worker') {
      ok('a worker granted NO execution capability can claim neither the hardware nor the GUI task, '
        + 'and is told work is waiting that it cannot do');
      note(`waiting for other workers: ${plainClaim.waitingForOtherWorkers}`);
    } else bad('a capability-less worker claimed restricted work', JSON.stringify(plainClaim));

    // The exec:hardware worker: may claim the hardware task, not the GUI one.
    const hwClaim = await LEASES.claimTask({ workerId: enrolledHw.workerId, taskId: hwTask.taskId }, deps);
    if (hwClaim.ok) ok('the exec:hardware worker CAN claim the hardware task');
    else bad('the granted worker could not claim its own class of work', JSON.stringify(hwClaim));

    const guiClaim = await LEASES.claimTask({ workerId: enrolledHw.workerId, taskId: guiTask.taskId }, deps);
    if (!guiClaim.ok) {
      ok('and it CANNOT claim the GUI task — exec:hardware is not exec:gui');
    } else bad('a hardware worker claimed GUI work', JSON.stringify(guiClaim));

    // AN ATTEMPT IS A LEASE, NOT A COLUMN. worker_tasks has no `attempts` — an attempt is an
    // `agent_runs` row keyed by the task's intent_key, which is why "attempts unconsumed" is
    // measured as "no run was ever opened for it". The first version of this assertion selected a
    // column that does not exist, which is forgetting a finding this project had already made.
    const stillPending = (await q(`SELECT state FROM worker_tasks WHERE id = $1`,
      [guiTask.taskId])).rows[0];
    const attemptsOpened = (await q(`SELECT COUNT(*)::int n FROM agent_runs WHERE intent_key = $1`,
      [(await q(`SELECT intent_key FROM worker_tasks WHERE id = $1`, [guiTask.taskId])).rows[0].intent_key]
    )).rows[0].n;
    if (stillPending && stillPending.state === 'PENDING' && attemptsOpened === 0) {
      ok('and the GUI task is still PENDING with NO attempt opened against it — refused work is '
        + 'not failed work, and an attempt is a lease rather than a counter');
    } else bad('the unclaimable task was consumed',
      JSON.stringify({ stillPending, attemptsOpened }));

    // THE GAP, measured and stated.
    const guiDef = TYPES.definitionOf('desktop.capture_once');
    if (TYPES.requiredCapabilityOf('desktop.capture_once') === 'exec:gui' && guiDef) {
      ok('the GUI class is enforced by a CAPABILITY GRANT — which is what holds today');
      note('WHAT IT DOES NOT PROVE: a granted `exec:gui` is an operator\'s statement that this '
        + 'machine CAN have a desktop session, not evidence that one is live at execution time. A '
        + 'machine can be enrolled, granted and running with nobody logged in — the distinction '
        + 'B4.4b turns on. Closing it needs the worker to ASSERT a live session and the server to '
        + 'refuse the lease without that assertion; `desktop.capture_once` is unimplemented, so '
        + 'nothing executes under the gap today. Recorded as B4.4c rather than implied as closed');
    } else bad('the GUI class is not enforced at all', JSON.stringify(guiDef));

    // ══ 5. NO AUTOMATIC GRANT TO AN EXISTING IDENTITY ════════════════════
    console.log('\n── 5. no automatic grant to an existing identity ──\n');

    const existing = (await q(`SELECT COUNT(*)::int n FROM worker_identities
                                WHERE 'exec:hardware' = ANY(capabilities)`)).rows[0].n;
    if (existing === 1) {
      ok('exactly ONE identity here holds exec:hardware — the one whose token granted it. The '
        + 'migrations granted nothing to anybody');
      note('owner instruction: "Do not automatically grant exec:hardware or exec:gui to existing '
        + 'production identities." Nothing in this codebase does, and §3 is why it cannot');
    } else bad('more identities hold exec:hardware than were granted it', existing);

    console.log('');
  } catch (e) {
    bad('the check itself threw', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    try {
      await q(`DELETE FROM worker_audit WHERE worker_id = ANY($1)`, [ids.workers]).catch(() => {});
      for (const t of ids.tasks) await q(`DELETE FROM worker_tasks WHERE id = $1`, [t]).catch(() => {});
      await q(`DELETE FROM agent_runs WHERE company_id = ANY($1)`, [ids.companies]).catch(() => {});
      for (const w of ids.workers) await q(`DELETE FROM worker_identities WHERE id = $1`, [w]).catch(() => {});
      await q(`DELETE FROM worker_enrollment_tokens WHERE label LIKE 'wcap-%'`).catch(() => {});
      for (const c of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [c]).catch(() => {});
      const left = (await q(`SELECT COUNT(*)::int n FROM worker_identities WHERE id = ANY($1)`,
        [ids.workers])).rows[0].n;
      if (left === 0) ok('cleanup: my fixtures are gone');
      else bad('cleanup leaked fixtures', left);
      const planted = path.join(REPO, 'src', 'lib', 'worker', '__wcap_control.js');
      if (fs.existsSync(planted)) { fs.rmSync(planted, { force: true }); bad('the planted control file was left behind'); }
      else ok('and the planted control file is gone');
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    cluster.destroy();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  worker capability authority does not hold.');
    process.exit(1);
  }
  console.log('\nPASS  Decision 4: a worker\'s execution capabilities are SERVER-AUTHORIZED — they '
    + 'travel on an operator-issued enrollment token, the enrollment path has no parameter through '
    + 'which a worker could declare its own, no module can update the column afterwards, and the '
    + 'claim filter refuses work outside the granted set while leaving it PENDING with its attempts '
    + 'unconsumed. The GUI gap is stated, not implied closed.');
  process.exit(0);
})();
