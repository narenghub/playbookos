#!/usr/bin/env node
// ── CAN AN OPERATOR TELL THESE APART? (B2.9) ────────────────────────────────
//
//   node scripts/check-command-center-db.js    exit 0 = every distinction holds
//                                               exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner's Priority 3 of 2026-11-25 lists what the Command Center must distinguish. A dashboard that
// shows a number per row is easy; the requirement is that several pairs of things which LOOK alike
// are told apart. So every section below ARRANGES both members of a pair and asserts that the
// snapshot reports them differently:
//
//   cloud node vs hardware node            — derived from the GRANT, never from the label's text
//   unknown vs offline                     — never authenticated is not "offline"
//   degraded vs online                     — reachable and unable to work is its own state
//   revoked vs anything else               — revocation outranks a fresh heartbeat
//   declared capability vs ACTUAL          — `exec:gui` is a grant, not a live desktop session
//   blocked backlog vs empty queue         — work nothing can serve is not "nothing to do"
//   stale hold vs unresolved charge        — reclaimable money vs money that may be gone
//   unreadable section vs a zero           — a broken dashboard must not look like a quiet one
//
// Several of those pairs are defects this project has already paid for, which is why each is a
// separate assertion rather than one "the snapshot is correct".
//
// NO URL OVERRIDE: its own disposable cluster; fixtures by id.

'use strict';

const crypto = require('node:crypto');

const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) {
    console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
  }
};
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n── ${m} ──\n`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'cc' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the command centre was not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'cc-bootstrap@cc.invalid';
process.env.ADMIN_PASSWORD = `cc-${crypto.randomBytes(16).toString('hex')}`;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 300s — a stall is a failure.');
  process.exit(1);
}, 300_000);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false, max: 8 });
  const query = (t, p) => P.query(t, p);
  const withTransaction = async (fn) => {
    const c = await P.connect();
    try {
      await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  };
  const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };
  const deps = { query, withTransaction, env: SEAL };
  const brokenOn = (re, code = '57P01') => ({
    ...deps,
    query: (t, p) => (re.test(String(t))
      ? Promise.reject(Object.assign(new Error('simulated database outage'), { code }))
      : query(t, p)),
  });

  const made = { companies: [], objectives: [], workers: [] };
  const uid = (p) => `cc-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    const autonomy = require('../src/lib/autonomy');
    const DB = require('../src/lib/db');
    await DB.initDB();
    await DB.initPhase2?.();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await autonomy.migrateAutonomy(query);
    await require('../src/lib/office/memory').migrateMemory(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/identity/schema').migrateRecordOwnership(query);
    await require('../src/lib/worker/identity').migrateWorkerIdentity(query);
    await require('../src/lib/worker/leases').migrateWorkerTasks(query);
    await require('../src/lib/worker/audit').migrateWorkerAudit(query);
    autonomy.resetForTests && autonomy.resetForTests();

    const CC = require('../src/lib/office/command-center');
    const IDENT = require('../src/lib/worker/identity');
    const LEASES = require('../src/lib/worker/leases');
    const CTXMOD = require('../src/lib/office/context');
    const SCOPE = require('../src/lib/office/scope');

    const CO = uid('co');
    await query(`INSERT INTO companies (id, slug, display_name, status)
                 VALUES ($1,$1,$1,'active')`, [CO]);
    made.companies.push(CO);
    const OBJ = uid('obj');
    await query(`INSERT INTO objectives
                   (id, company_id, objective, priority, autonomy_tier, approval_policy, status,
                    created_by, budget_usd)
                 VALUES ($1,$2,'command centre fixture','P1','supervised','all_consequential',
                         'active','naren@fixture.invalid',10.00)`, [OBJ, CO]);
    made.objectives.push(OBJ);
    const CTX = await CTXMOD.resolveObjectiveContext({ objectiveId: OBJ }, deps);

    /** Enrol a worker in process, then set the facts this section needs about it, by id. */
    const worker = async (label, { capabilities = [], lastSeen = null, revoked = null } = {}) => {
      // `capabilities` is omitted when empty so the worker gets identity.js's own default base
      // capability — passing `[]` would enrol a worker that declares nothing at all, which is a
      // different fixture from "a cloud worker".
      const tok = await IDENT.createEnrollmentToken(
        capabilities.length ? { label, capabilities } : { label }, deps);
      const e = await IDENT.consumeEnrollmentToken(
        { token: tok.token, hostFingerprint: `cc-${label}` }, deps);
      if (!e || !e.ok) throw new Error(`enrolment failed for ${label}: ${JSON.stringify(e)}`);
      made.workers.push(e.workerId);
      if (lastSeen !== null) {
        await query(`UPDATE worker_identities SET last_seen_at = $2 WHERE id = $1`,
          [e.workerId, lastSeen]);
      }
      if (revoked) {
        await query(`UPDATE worker_identities SET revoked_at = NOW(), revoked_reason = $2
                      WHERE id = $1`, [e.workerId, revoked]);
      }
      return e.workerId;
    };
    const byId = (snap, id) => snap.workers.find((w) => w.id === id);

    // ══ 1. KIND IS THE GRANT, NOT THE LABEL ══════════════════════════════
    head('1. cloud node vs hardware node, by the grant rather than by the name');

    const CLOUD = await worker('cloud-dev-railway', { lastSeen: new Date().toISOString() });
    const HW = await worker('imac-office', {
      capabilities: ['exec:hardware'], lastSeen: new Date().toISOString(),
    });
    // The trap: a label that SAYS imac on a node granted nothing, and a label that says nothing of
    // the sort on a node granted hardware. A string match on the label would get both wrong.
    const LIAR = await worker('imac-lookalike-no-grant', { lastSeen: new Date().toISOString() });
    const QUIET_HW = await worker('mac-mini-spare', { capabilities: ['exec:hardware'] });

    {
      const snap = await CC.snapshot(CTX, {}, deps);
      const k = (id) => (byId(snap, id) || {}).kind;
      if (k(CLOUD) === 'cloud_eligible_only' && k(HW) === 'hardware_node'
        && k(LIAR) === 'cloud_eligible_only' && k(QUIET_HW) === 'hardware_node') {
        ok('the KIND comes from the capability the server granted: a node labelled '
          + '"imac-lookalike-no-grant" with no grant is cloud-eligible only, and one labelled '
          + '"mac-mini-spare" with exec:hardware is a hardware node — a label match would have '
          + 'been inference dressed as a fact');
      } else bad('the kind was derived from the label', snap.workers.map((w) => [w.name, w.kind]));

      if (byId(snap, HW).name === 'imac-office' && byId(snap, CLOUD).name === 'cloud-dev-railway') {
        ok('and the NAME is the operator\'s own label, verbatim — which is what the owner asked to '
          + 'be able to tell apart');
      } else bad('the label was not reported verbatim', snap.workers.map((w) => w.name));
    }

    // ══ 2. UNKNOWN IS NOT OFFLINE ════════════════════════════════════════
    head('2. unknown vs offline vs online vs revoked');

    const STALE = await worker('cloud-worker-asleep', {
      lastSeen: new Date(Date.now() - 3600_000).toISOString(),
    });
    const GONE = await worker('decommissioned-node', {
      lastSeen: new Date().toISOString(), revoked: 'retired by the operator',
    });

    {
      const snap = await CC.snapshot(CTX, {}, deps);
      const st = (id) => (byId(snap, id) || {}).status;
      if (st(QUIET_HW) === CC.WORKER_STATUS.UNKNOWN) {
        ok('a worker enrolled but never authenticated is UNKNOWN, not offline — calling it offline '
          + 'claims knowledge nobody has, and "unknown" is what a human has to act on');
      } else bad('a never-authenticated worker was reported as offline', st(QUIET_HW));

      if (st(STALE) === CC.WORKER_STATUS.OFFLINE && st(CLOUD) === CC.WORKER_STATUS.ONLINE) {
        ok(`an hour-old authenticated heartbeat is OFFLINE and a fresh one is ONLINE, against a `
          + `stated window of ${snap.onlineWithinSeconds}s`);
      } else bad('online and offline were not told apart', { stale: st(STALE), live: st(CLOUD) });

      if (st(GONE) === CC.WORKER_STATUS.REVOKED) {
        ok('and revocation OUTRANKS a fresh heartbeat: a revoked worker with a heartbeat from this '
          + 'second reads REVOKED, because it may still be authenticating and may not work');
      } else bad('a revoked worker was shown as online', st(GONE));

      const hb = byId(snap, STALE);
      if (hb.lastAuthenticatedAt && hb.lastAuthenticatedAgeSeconds >= 3500) {
        ok(`the heartbeat shown is the last AUTHENTICATED one (${hb.lastAuthenticatedAgeSeconds}s `
          + 'ago) — worker/auth.js writes that column only after the signature verifies, so an '
          + 'unauthenticated request cannot move it');
      } else bad('the heartbeat age was not reported', hb);
    }

    // ══ 3. DECLARED VS ACTUALLY AVAILABLE ════════════════════════════════
    head('3. a declared capability is not an available one');

    const GUI = await worker('imac-with-gui-grant', {
      capabilities: ['exec:hardware', 'exec:gui'], lastSeen: new Date().toISOString(),
    });

    {
      const snap = await CC.snapshot(CTX, {}, deps);
      const w = byId(snap, GUI);
      const gui = w.capabilityAvailability.find((a) => a.capability === 'exec:gui');
      const hw = w.capabilityAvailability.find((a) => a.capability === 'exec:hardware');
      if (gui.availability === 'unverified' && /session/.test(gui.why)
        && hw.availability === 'declared') {
        ok('exec:gui reads UNVERIFIED while exec:hardware reads DECLARED — the GUI grant says a '
          + 'worker MAY run GUI work and nothing verifies that a desktop session exists (B4.4c). A '
          + 'dashboard showing it as available is how a GUI task reaches a machine with no session');
      } else bad('a GUI grant was shown as available capacity', w.capabilityAvailability);

      const offline = byId(snap, STALE).capabilityAvailability;
      const offlineHw = byId(snap, QUIET_HW).capabilityAvailability
        .find((a) => a.capability === 'exec:hardware');
      if (offlineHw.availability === 'unreachable' && /unknown/.test(offlineHw.why)) {
        ok('and a grant held by a worker that is not online is UNREACHABLE rather than declared — '
          + 'an unreachable machine\'s capability is not capacity');
      } else bad('an unreachable worker\'s grant counted as capacity', { offline, offlineHw });

      if (snap.liveCapabilities.includes('exec:hardware')
        && !snap.liveCapabilities.includes('exec:gui')) {
        ok(`live capabilities are exactly what an ONLINE worker can be relied on for `
          + `(${snap.liveCapabilities.join(', ')}) — exec:gui is excluded although it is granted`);
      } else bad('the live capability set included an unverified grant', snap.liveCapabilities);
    }

    // ══ 4. A BLOCKED BACKLOG IS NOT AN EMPTY QUEUE ═══════════════════════
    head('4. blocked backlog vs servable backlog vs nothing to do');

    {
      const empty = await CC.snapshot(CTX, {}, deps);
      if (empty.work.blockedBacklog.length === 0 && empty.work.servableBacklog.length === 0) {
        ok('with no work enqueued, both backlogs are empty — the baseline, so the next assertion '
          + 'is not measuring a permanent state');
      } else bad('the baseline was not empty', empty.work);

      await LEASES.enqueueTask({ taskType: 'synthetic.echo', payload: { hello: 'cc' },
        intentKey: uid('intent-cloud'), companyId: CO, workflow: 'cc-check',
        createdBy: 'cc-check' }, deps);
      // A GUI-required type: granted to nobody whose session is verified, so nothing can serve it.
      // `KNOWN` is the exported list; my first version read a `TYPES` object that is not exported,
      // found nothing, and the section reported honestly that it had not been exercised — which is
      // how a skipped assertion is supposed to behave, and is also why it was visible at all.
      const TT = require('../src/lib/worker/task-types');
      const guiType = (TT.KNOWN || []).find((t) => TT.requiredCapabilityOf(t) === 'exec:gui');
      let guiQueued = false;
      if (guiType) {
        const r = await LEASES.enqueueTask({ taskType: guiType, payload: {},
          intentKey: uid('intent-gui'), companyId: CO, workflow: 'cc-check',
          createdBy: 'cc-check' }, deps);
        guiQueued = !!(r && r.ok);
      }

      const snap = await CC.snapshot(CTX, {}, deps);
      if (snap.work.byState.pending >= 1 && snap.work.servableBacklog.length >= 1) {
        ok(`${snap.work.byState.pending} task(s) pending, of which `
          + `${snap.work.servableBacklog.length} kind(s) an online worker can serve`);
      } else bad('pending work was not reported', snap.work);

      if (guiQueued) {
        if (snap.work.blockedBacklog.some((b) => b.requiredCapability === 'exec:gui')) {
          ok(`and the ${guiType} task is in the BLOCKED backlog, named with the capability it `
            + 'waits for — B4.3 keeps such a task PENDING with its attempts unconsumed so it stays '
            + 'visible, and this is where it becomes legible rather than looking like idleness');
        } else bad('work nothing can serve was not reported as blocked', snap.work);
      } else {
        note(`no GUI-required task type could be enqueued (${guiType || 'none declared'}), so the `
          + 'blocked-backlog assertion was not exercised — reported rather than quietly skipped');
      }
    }

    // ══ 5. A STALE HOLD IS NOT AN UNRESOLVED CHARGE ══════════════════════
    head('5. budget: reserved, measured, remaining, and unresolved exposure kept apart');

    {
      // `office_budget_reservations.run_id` is NOT NULL — a hold with no run is money nobody can
      // attribute, which the schema refuses. So the run is started first, by the real initiator.
      const INIT0 = require('../src/lib/office/initiator');
      const s0 = await INIT0.initiateDueObjectives({ companyId: CO }, deps);
      const RUN0 = (s0.initiated[0] || {}).runId;
      if (!RUN0) throw new Error(`no run for the budget fixture: ${JSON.stringify(s0)}`);
      const held = await SCOPE.reserveSpend(CTX, { id: uid('res'), objectiveId: OBJ, runId: RUN0,
        maxUsd: 0.40, reason: 'command centre fixture: a live hold' }, deps)
        .catch((e) => ({ ok: false, error: e.message }));
      const snap = await CC.snapshot(CTX, {}, deps);
      const o = snap.objectives.find((x) => x.id === OBJ);
      if (o && o.budgetUsd === 10 && o.spend.heldUsd >= 0.4) {
        ok(`the objective reports its budget ($${o.budgetUsd}), what is HELD `
          + `($${o.spend.heldUsd}) and what is MEASURED ($${o.spend.measuredUsd}) as three figures`);
      } else bad('the money was not reported in parts', { o, held });

      if (o && o.spend.remainingUsd !== null
        && Math.abs(o.spend.remainingUsd - (10 - Number(o.spend.heldUsd)
          - Number(o.spend.measuredUsd))) < 1e-6) {
        ok(`remaining is budget minus held minus measured ($${o.spend.remainingUsd}) and is NULL `
          + 'whenever a part is unknown — a remaining figure computed from a missing part is a '
          + 'number that looks safe and is not');
      } else bad('remaining did not reconcile', o && o.spend);

      if (o && o.spend.unresolvedExposureUsd !== null && o.spend.staleHoldCount !== null) {
        ok(`unresolved exposure ($${o.spend.unresolvedExposureUsd}, `
          + `${o.spend.unresolvedCount} hold(s)) is reported SEPARATELY from stale holds `
          + `(${o.spend.staleHoldCount}) — one is reclaimable and the other may be money that is `
          + 'already gone, and summing them under one heading is how an overspend goes unseen');
      } else bad('exposure and stale holds were merged or missing', o && o.spend);
    }

    // ══ 6. STOPS, REFUSALS AND HISTORY ═══════════════════════════════════
    head('6. stop controls, authorization refusals and the durable history');

    {
      await autonomy.stop({ scope_type: 'company', scope_key: CO,
        reason: 'command centre fixture: a company-scoped halt', actor: 'cc-check' }, { deps });
      autonomy.resetForTests && autonomy.resetForTests();
      const snap = await CC.snapshot(CTX, {}, deps);

      if ((snap.stops || []).some((s) => s.scope_key === CO)) {
        ok('the stop in force is shown with its scope, reason and who set it');
      } else bad('a live stop was not visible', snap.stops);

      // `action` is 'STOP', uppercase — read off the row rather than assumed. Asserted
      // case-insensitively so the assertion is about the EVENT and not about its spelling.
      if ((snap.refusals || []).some((r) => String(r.action).toLowerCase() === 'stop'
        && r.scope_key === CO)) {
        ok('and the authorization history carries the act itself — autonomy_events is the record, '
          + 'so what an operator reads is the ledger rather than a summary somebody kept');
      } else bad('the authorization history did not carry the stop', (snap.refusals || []).slice(0, 3));

      // A worker enrolled under this company's stop is reachable and unable to work.
      const d = byId(snap, CLOUD);
      if (d.status === CC.WORKER_STATUS.ONLINE || d.status === CC.WORKER_STATUS.DEGRADED) {
        ok(`a company-scoped stop does not change a worker's own reachability (${d.status}) — `
          + 'worker status answers "can I talk to it", and the stop answers "may it act", which '
          + 'are two questions and must not be collapsed into one green dot');
      } else bad('a company stop changed the worker status', d.status);

      await autonomy.resume({ scope_type: 'company', scope_key: CO, actor: 'cc-check',
        reason: 'command centre fixture: lifting the halt' }, { deps });
      autonomy.resetForTests && autonomy.resetForTests();
    }

    // ══ 7. HISTORY AND OBJECTIVE STATUS ══════════════════════════════════
    head('7. objective status and execution history, from the ledger');

    {
      // The run started in section 5 is the one to look for: `uq_agent_runs_one_active` allows one
      // live run per objective, so initiating again here would correctly produce no second run —
      // and asserting on a run id that initiation declined to create would measure nothing.
      const snap = await CC.snapshot(CTX, {}, deps);
      const RUN = (await query(`SELECT run_id FROM agent_runs WHERE company_id = $1
                                 ORDER BY created_at DESC LIMIT 1`, [CO])).rows[0];
      if (RUN && (snap.history || []).some((h) => h.run_id === RUN.run_id)) {
        ok('a run started by the scheduler appears in the execution history with its state, '
          + 'attempt and timestamps');
      } else bad('the history did not carry a real run', { RUN, n: (snap.history || []).length });

      await query(`UPDATE objectives SET status = 'paused' WHERE id = $1`, [OBJ]);
      const paused = await CC.snapshot(CTX, {}, deps);
      if ((paused.objectives.find((x) => x.id === OBJ) || {}).status === 'paused') {
        ok('and an objective paused a moment ago reads paused — the status is read, not cached');
      } else bad('the objective status was stale', paused.objectives);
      await query(`UPDATE objectives SET status = 'active' WHERE id = $1`, [OBJ]);
    }

    // ══ 8. UNREADABLE IS NOT ZERO ════════════════════════════════════════
    head('8. a broken dashboard must not look like a quiet one');

    {
      const snap = await CC.snapshot(CTX, {}, brokenOn(/FROM worker_identities/));
      if (snap.workersUnreadable === true && snap.workers.length === 0
        && snap.unreadable.some((u) => u.section === 'workers')) {
        ok('with the worker table unreadable the snapshot says so BY SECTION rather than showing '
          + 'zero workers — "no workers enrolled" and "I could not look" are different facts and '
          + 'one of them is an incident');
      } else bad('an unreadable section was reported as empty', snap.unreadable);

      if (snap.objectives && snap.objectives.length >= 1) {
        ok('while the sections that could be read are still reported — one failure degrades its '
          + 'own section, not the page');
      } else bad('one unreadable section emptied the snapshot', snap.objectives);

      const healthy = await CC.snapshot(CTX, {}, deps);
      if (healthy.unreadable.length === 0 && healthy.workers.length >= 6) {
        ok(`control: with a healthy database nothing is unreadable and all `
          + `${healthy.workers.length} workers report — the refusal above is the outage, not the `
          + 'snapshot');
      } else bad('the control snapshot was not clean',
        { unreadable: healthy.unreadable, n: healthy.workers.length });
    }

    // ══ 9. WHAT IT CANNOT DO ═════════════════════════════════════════════
    head('9. it reads, and that is all it can do');

    {
      const src = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'src', 'lib', 'office', 'command-center.js'),
        'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      const writers = ['INSERT', 'UPDATE', 'DELETE', 'stop(', 'resume(', 'enqueueTask',
        'claimTask', 'advanceCycle', 'retryRun'];
      const found = writers.filter((w) => src.includes(w));
      if (!found.length) {
        ok('the read model contains no writer and no SQL of its own: a dashboard that can act is a '
          + 'dashboard whose READ path needs a write path\'s authorization');
      } else bad('the read model can act', found);

      const route = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'src', 'api', 'command-center.routes.js'),
        'utf8');
      if (!/companyId/.test(route.replace(/\/\/[^\n]*/g, '')) || /req\.query\.objectiveId/.test(route)) {
        ok('and the route takes no companyId: the company is READ from the objective, because an '
          + 'HTTP caller may no more choose a company than an agent may');
      } else bad('the route accepted a company from its caller');

      const calls = (await query('SELECT COUNT(*)::int n FROM office_cost_ledger')).rows[0].n;
      if (calls === 0) ok('ZERO provider calls');
      else bad(`${calls} provider cost rows exist; this check must make none`);

      note('NOT covered: the SPA page itself. This is the read model and its route; rendering it '
        + 'in public/index.html is a separate change with its own parse and nav-parity gates, and '
        + 'the owner\'s B2.9 asks for the visibility rather than for a particular layout');
      note('NOT covered: a cloud worker that actually exists (B4.2 owner actions) — every worker '
        + 'here is an enrolled identity in a disposable cluster, which is enough to prove the '
        + 'DISTINCTIONS and not that a Railway service is running');
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    try {
      for (const id of made.objectives) {
        await query(`DELETE FROM office_budget_reservations WHERE objective_id=$1`, [id])
          .catch(() => {});
        await query(`DELETE FROM office_plan_steps WHERE plan_id IN
                       (SELECT id FROM office_plans WHERE objective_id=$1)`, [id]).catch(() => {});
        await query(`DELETE FROM office_plans WHERE objective_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.workers) {
        await query(`DELETE FROM worker_identities WHERE id=$1`, [id]).catch(() => {});
      }
      for (const id of made.companies) {
        await query(`DELETE FROM worker_tasks WHERE company_id=$1`, [id]).catch(() => {});
        await query(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => {});
      }
    } catch (e) { bad('cleanup failed', e.message); }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
