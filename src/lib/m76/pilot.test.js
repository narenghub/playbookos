// ── THE M7.6 PILOT: PLAN, POLICY, DISPATCH, VALIDATE, ASSEMBLE, ESCALATE ────
//
//   node --test src/lib/m76/pilot.test.js
//
// Everything here runs without a database and without a Mac, by injecting `query` and `leases`.
// That is not a weaker test than a hardware run — it is the test that runs BEFORE one, which is
// the lesson from four M7.5 acceptance runs where defects that were findable in a second were
// instead found twenty minutes into an armed window.
//
// What these tests CANNOT establish, stated plainly so nobody reads more into them:
//   • that `uq_worker_tasks_intent` refuses a duplicate — that is Postgres, proven in
//     scripts/check-worker-leasing-db.js
//   • that the office iMac executes the handler — that needs the hardware run, unauthorized so far

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLANNER = require('./planner');
const POLICY = require('./policy');
const PIPELINE = require('./pipeline');
const SYNTHETIC = require('./synthetic');
const SCHEMA = require('./schema');
const HANDLER = require('../../worker-client/handlers/report-daily-operations');

const GOAL = "Produce today's ABIOZEN scientific operations report";
const AS_OF = '2026-11-20';

const okPlan = () => {
  const r = PLANNER.plan({ goalId: 'g1', text: GOAL, asOf: AS_OF, factCount: 40 });
  assert.ok(r.ok, JSON.stringify(r));
  return r.plan;
};

/** A query stub that records every statement and answers the few shapes the pipeline asks for. */
function fakeQuery(answers = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    for (const [pattern, rows] of Object.entries(answers)) {
      if (new RegExp(pattern, 'i').test(sql)) {
        return { rows: typeof rows === 'function' ? rows(params) : rows, rowCount: 1 };
      }
    }
    return { rows: [], rowCount: 1 };
  };
  return { query, calls };
}

const noStops = { checkStopped: async () => null };

// ── GOAL → PLAN ─────────────────────────────────────────────────────────────

test('a recognised goal becomes a bounded two-step plan', () => {
  const p = okPlan();
  assert.equal(p.goalKind, 'daily_operations_report');
  assert.deepEqual(p.steps.map((s) => s.stepType),
    ['operations.liveness_checkpoint', 'operations.daily_report']);
  assert.deepEqual(p.steps.map((s) => s.taskType),
    ['synthetic.echo', 'report.daily_operations']);
  assert.deepEqual(PLANNER.validateShape(p), []);
});

test('DECISIVE: an unrecognised goal produces NO plan', () => {
  for (const text of ['delete the production database', 'email every supplier', '', 'hello']) {
    const r = PLANNER.plan({ goalId: 'g1', text, asOf: AS_OF });
    assert.equal(r.ok, false, `planned something for "${text}"`);
    assert.ok(/unrecognised_goal|empty_goal/.test(r.refused), r.refused);
  }
});

test('a plan without an as-of date is refused', () => {
  const r = PLANNER.plan({ goalId: 'g1', text: GOAL });
  assert.equal(r.ok, false);
  assert.equal(r.refused, 'no_as_of');
});

test('intent keys are namespaced per plan, so two plans cannot collide', () => {
  const a = okPlan();
  const b = okPlan();
  assert.notEqual(a.planId, b.planId);
  const keys = new Set([...a.steps, ...b.steps].map((s) => s.intentKey));
  assert.equal(keys.size, 4);
  for (const s of a.steps) assert.ok(s.intentKey.startsWith(`m76-${a.planId}-`));
});

// ── CLOSED VOCABULARY ───────────────────────────────────────────────────────

test('DECISIVE: a step outside the vocabulary refuses the WHOLE plan', () => {
  const p = okPlan();
  p.steps.push({ stepId: 's3', ordinal: 3, stepType: 'operations.send_email',
    taskType: 'email.send', payload: {}, intentKey: `m76-${p.planId}-s3` });
  const problems = PLANNER.validateShape(p);
  assert.ok(problems.some((x) => /not in the closed vocabulary/.test(x)), problems.join('; '));
});

test('a step whose taskType does not match its stepType is refused', () => {
  // The shape that would let a known step name smuggle in a different task type.
  const p = okPlan();
  p.steps[1].taskType = 'proposal.draft_once';
  assert.ok(PLANNER.validateShape(p).some((x) => /must map to task type/.test(x)));
});

test('an intent key outside the plan namespace is refused', () => {
  const p = okPlan();
  p.steps[0].intentKey = 'm75-mwo9zoaufe36ad-expire';   // another run's key
  assert.ok(PLANNER.validateShape(p).some((x) => /outside its own plan's namespace/.test(x)));
});

test('every vocabulary entry maps to a declared task type', () => {
  const TYPES = require('../worker/task-types');
  for (const [stepType, def] of Object.entries(PLANNER.STEP_VOCABULARY)) {
    assert.ok(TYPES.isKnown(def.taskType), `${stepType} -> ${def.taskType} is not declared`);
    assert.equal(TYPES.definitionOf(def.taskType).readOnly, true,
      `${stepType} maps to a type that is not read-only`);
  }
});

// ── POLICY ──────────────────────────────────────────────────────────────────

test('CONTROL: a valid plan passes policy', async () => {
  const r = await POLICY.validatePlan(okPlan(), { workerId: 'wkr_' + 'a'.repeat(32) },
    { autonomy: noStops, query: fakeQuery().query });
  assert.deepEqual(r.refusals, []);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 2);
});

test('DECISIVE: policy refuses a write-capable task type', async () => {
  const p = okPlan();
  // Bypass the shape check deliberately: this asserts the READ-ONLY rule itself, not the shape.
  p.steps[1].stepType = 'operations.daily_report';
  p.steps[1].taskType = 'report.daily_operations';
  const TYPES = require('../worker/task-types');
  const original = TYPES.definitionOf('report.daily_operations').readOnly;
  assert.equal(original, true, 'premise: the pilot type is read-only');

  // A plan that claims a write-capable type, constructed the way a future planner bug would.
  const writey = { ...p, steps: [{ ...p.steps[0] }, { ...p.steps[1], taskType: 'proposal.draft_once' }] };
  const r = await POLICY.validatePlan(writey, {}, { autonomy: noStops, query: fakeQuery().query });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /must map to task type|readOnly/.test(x)), r.refusals.join('; '));
});

test('DECISIVE: a capability STOP refuses the plan', async () => {
  const stopped = {
    checkStopped: async ({ capability }) => (capability
      ? { scope_type: 'capability', scope_key: 'worker.execute', reason: 'halted for a test' }
      : null),
  };
  const r = await POLICY.validatePlan(okPlan(), {}, { autonomy: stopped, query: fakeQuery().query });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /stopped at capability/.test(x)), r.refusals.join('; '));
});

test('a workflow STOP on the pilot refuses the plan', async () => {
  const stopped = {
    checkStopped: async ({ workflow }) => (workflow === POLICY.PILOT_WORKFLOW
      ? { scope_type: 'workflow', scope_key: POLICY.PILOT_WORKFLOW, reason: 'pilot paused' }
      : null),
  };
  const r = await POLICY.validatePlan(okPlan(), {}, { autonomy: stopped, query: fakeQuery().query });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => new RegExp(POLICY.PILOT_WORKFLOW).test(x)));
});

test('the pilot workflow scope is its own, so a STOP on it halts nothing else', () => {
  assert.equal(POLICY.PILOT_WORKFLOW, 'm76-autonomous-office-pilot');
  const autonomy = require('../autonomy');
  assert.ok(!Object.keys(autonomy.CRON_SCOPES || {}).includes(POLICY.PILOT_WORKFLOW),
    'the pilot workflow must not collide with a cron scope, or the 42 dev STOPs would cover it');
});

// ── DISPATCH ────────────────────────────────────────────────────────────────

test('DECISIVE: dispatch refuses a plan policy has not validated', async () => {
  const f = fakeQuery();
  await assert.rejects(
    () => PIPELINE.dispatchPlan(okPlan(), { validated: false }, { query: f.query }),
    /requires a plan the policy engine has validated/);
  assert.equal(f.calls.length, 0, 'nothing may be written for an unvalidated plan');
});

test('dispatch enqueues one task per step, in ordinal order', async () => {
  const p = okPlan();
  const seen = [];
  const leases = {
    enqueueTask: async ({ intentKey, taskType, workflow }) => {
      seen.push({ intentKey, taskType, workflow });
      return { taskId: `wtask_${seen.length}` };
    },
  };
  const f = fakeQuery();
  const r = await PIPELINE.dispatchPlan(p, { validated: true }, { query: f.query, leases });
  assert.equal(r.dispatched.length, 2);
  assert.deepEqual(seen.map((s) => s.taskType), ['synthetic.echo', 'report.daily_operations']);
  for (const s of seen) assert.equal(s.workflow, POLICY.PILOT_WORKFLOW);
});

test('DECISIVE: re-dispatch creates no second task', async () => {
  const p = okPlan();
  // Models what the database does: one task per intent key, the existing one handed back.
  const byIntent = new Map();
  const leases = {
    enqueueTask: async ({ intentKey }) => {
      if (!byIntent.has(intentKey)) byIntent.set(intentKey, `wtask_${byIntent.size + 1}`);
      return { taskId: byIntent.get(intentKey), existing: true };
    },
  };
  const f = fakeQuery();
  const first = await PIPELINE.dispatchPlan(p, { validated: true }, { query: f.query, leases });
  const again = await PIPELINE.dispatchPlan(p, { validated: true }, { query: f.query, leases });
  assert.equal(byIntent.size, 2, 'a second dispatch created extra tasks');
  assert.deepEqual(first.dispatched.map((d) => d.taskId), again.dispatched.map((d) => d.taskId));
});

test('dispatch fails loudly if enqueue returns no task id', async () => {
  const leases = { enqueueTask: async () => ({ ok: false, code: 'nothing_to_do' }) };
  await assert.rejects(
    () => PIPELINE.dispatchPlan(okPlan(), { validated: true },
      { query: fakeQuery().query, leases }),
    /returned no task id/);
});

// ── SERVER-SIDE VALIDATION OF THE REPORT ────────────────────────────────────

test('CONTROL: a real handler report passes server-side validation', async () => {
  const { facts } = SYNTHETIC.generate({ asOf: AS_OF, count: 40 });
  const body = await HANDLER.run({ asOf: AS_OF, facts });
  assert.deepEqual(PIPELINE.validateReportBody(body, { asOf: AS_OF, factCount: 40 }), []);
});

test('DECISIVE: the server does not trust the worker\'s arithmetic', async () => {
  const { facts } = SYNTHETIC.generate({ asOf: AS_OF, count: 20 });
  const body = await HANDLER.run({ asOf: AS_OF, facts });
  body.totals.count = 999;                       // the handler's own check would have caught this
  const problems = PIPELINE.validateReportBody(body, { asOf: AS_OF, factCount: 20 });
  assert.ok(problems.some((p) => /totals\.count is 999/.test(p)), problems.join('; '));
});

test('a report for the wrong day is refused', async () => {
  const { facts } = SYNTHETIC.generate({ asOf: AS_OF, count: 5 });
  const body = await HANDLER.run({ asOf: AS_OF, facts });
  assert.ok(PIPELINE.validateReportBody(body, { asOf: '2026-11-19' })
    .some((p) => /asOf is/.test(p)));
});

test('a report over a different number of facts than requested is refused', async () => {
  const { facts } = SYNTHETIC.generate({ asOf: AS_OF, count: 5 });
  const body = await HANDLER.run({ asOf: AS_OF, facts });
  assert.ok(PIPELINE.validateReportBody(body, { asOf: AS_OF, factCount: 6 })
    .some((p) => /factCount is 5, expected 6/.test(p)));
});

// ── ASSEMBLY AND ESCALATION ─────────────────────────────────────────────────

async function assembleWith(rowsFor) {
  const p = okPlan();
  const { facts } = SYNTHETIC.generate({ asOf: AS_OF, count: 40 });
  const body = await HANDLER.run({ asOf: AS_OF, facts });
  const f = fakeQuery({
    'FROM worker_tasks wt': (params) => rowsFor(params, body),
    'FROM agent_runs': [{ run_id: 'run-1', state: 'SUCCEEDED', attempt: 1 }],
    'COUNT\\(\\*\\)::int n FROM worker_audit': [{ n: 7 }],
  });
  return { plan: p, result: await PIPELINE.assemble(p, { expectedFactCount: 40 }, { query: f.query }), calls: f.calls, body };
}

test('a complete, valid run assembles a report with evidence', async () => {
  const { result } = await assembleWith((params, body) => [{
    status: 'SUCCEEDED',
    output: /daily_report|s2/.test(String(params[0])) ? body : { echoed: {}, steps: 0 },
    worker_id: 'wkr_' + 'b'.repeat(32),
    run_id: 'run-1',
    task_id: 'wtask_1',
    task_state: 'COMPLETED',
  }]);
  assert.equal(result.ok, true, JSON.stringify(result.detail));
  assert.ok(result.reportId.startsWith('m76rep_'));
  assert.equal(result.evidence.steps.length, 2);
  for (const s of result.evidence.steps) {
    assert.ok(s.taskId && s.runId && s.workerId, `step ${s.stepId} has incomplete evidence`);
  }
  assert.equal(result.evidence.auditRows, 7);
});

test('DECISIVE: a step that did not succeed produces NO report', async () => {
  const { result } = await assembleWith(() => [{
    status: null, output: null, worker_id: null, run_id: null,
    task_id: 'wtask_1', task_state: 'LEASED',
  }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'steps_not_succeeded');
  assert.ok(result.detail.length >= 1);
});

test('DECISIVE: an invalid report body produces NO report', async () => {
  const { result } = await assembleWith((params, body) => [{
    status: 'SUCCEEDED',
    output: { ...body, totals: { ...body.totals, count: 1234 } },
    worker_id: 'wkr_' + 'c'.repeat(32), run_id: 'run-1', task_id: 'wtask_1', task_state: 'COMPLETED',
  }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'report_failed_validation');
  assert.ok(result.detail.some((d) => /totals\.count/.test(d)));
});

test('assembly writes no report row when it refuses', async () => {
  const { calls } = await assembleWith(() => [{
    status: 'FAILED', output: { failure: { code: 'x' } }, worker_id: 'w', run_id: 'r',
    task_id: 't', task_state: 'FAILED',
  }]);
  assert.ok(!calls.some((c) => /INSERT INTO m76_reports/i.test(c.sql)),
    'a refused assembly must not insert a report');
});

test('escalation produces a decision-queue item the existing queue accepts', async () => {
  const DQ = require('../office/decision-queue');
  const p = okPlan();
  const item = PIPELINE.escalationItem(p, { reason: 'report_failed_validation', detail: ['totals'] });
  // makeItem throws on an unknown kind or a missing page — this proves the pilot plugs into the
  // existing queue WITHOUT modifying its frozen KINDS allowlist.
  const made = DQ.makeItem(item, new Date());
  assert.equal(made.kind, 'escalation');
  assert.ok(made.id.startsWith('m76:'));
  assert.ok(DQ.KINDS.includes(made.kind));
});

test('the decision source is read-only', () => {
  const src = fs.readFileSync(path.join(__dirname, 'pipeline.js'), 'utf8');
  const fn = src.slice(src.indexOf('function decisionSource'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  for (const write of ['INSERT', 'UPDATE', 'DELETE']) {
    assert.ok(!new RegExp(write, 'i').test(body), `decisionSource contains a ${write}`);
  }
});

// ── SYNTHETIC DATA ──────────────────────────────────────────────────────────

test('DECISIVE: the generator is deterministic', () => {
  const a = SYNTHETIC.generate({ asOf: AS_OF, seed: 'm76', count: 50 });
  const b = SYNTHETIC.generate({ asOf: AS_OF, seed: 'm76', count: 50 });
  assert.equal(JSON.stringify(a.facts), JSON.stringify(b.facts));
});

test('different days and seeds give different data', () => {
  const a = SYNTHETIC.generate({ asOf: AS_OF, seed: 'm76', count: 50 });
  const b = SYNTHETIC.generate({ asOf: '2026-11-19', seed: 'm76', count: 50 });
  const c = SYNTHETIC.generate({ asOf: AS_OF, seed: 'other', count: 50 });
  assert.notEqual(JSON.stringify(a.facts), JSON.stringify(b.facts));
  assert.notEqual(JSON.stringify(a.facts), JSON.stringify(c.facts));
});

test('the generator refuses a count beyond the 8 GB-machine bound', () => {
  assert.throws(() => SYNTHETIC.generate({ asOf: AS_OF, count: SYNTHETIC.MAX_COUNT + 1 }),
    /between 0 and/);
});

test('every generated fact is one the handler accepts', async () => {
  // The two vocabularies must not drift: a generator producing a kind the handler refuses would
  // fail only on hardware.
  const { facts } = SYNTHETIC.generate({ asOf: AS_OF, count: SYNTHETIC.MAX_COUNT });
  for (const f of facts) {
    assert.ok(HANDLER.KINDS.includes(f.kind), `handler rejects kind ${f.kind}`);
    assert.ok(HANDLER.STATUSES.includes(f.status), `handler rejects status ${f.status}`);
  }
  assert.deepEqual(SYNTHETIC.KINDS, HANDLER.KINDS);
  assert.deepEqual(SYNTHETIC.STATUSES, HANDLER.STATUSES);
});

test('the synthetic molecules are obviously fictional', () => {
  for (const m of SYNTHETIC.MOLECULES) assert.match(m, /^SYN-/);
});

// ── NO OUTBOUND CAPABILITY, NO GOVERNANCE BYPASS ────────────────────────────

test('DECISIVE: nothing under m76/ can reach an outbound primitive', () => {
  const dir = __dirname;
  const forbidden = [/mailer/, /whatsapp/, /\bllm\b/, /services\/sender/, /node-fetch/,
    /child_process/, /office\/execute/];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of requires) {
      for (const bad of forbidden) {
        assert.ok(!bad.test(r), `${file} requires ${r}, which can reach an outbound primitive`);
      }
    }
    assert.ok(!/\bfetch\s*\(/.test(src), `${file} calls fetch()`);
  }
});

test('DECISIVE: the pilot passes no overrideReason and writes no retry reason', () => {
  const dir = __dirname;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/overrideReason/.test(code), `${file} passes overrideReason`);
    assert.ok(!/retry_override_reason/.test(code), `${file} writes the override column`);
  }
});

test('the pilot touches no table outside its own, except by reading', () => {
  const src = fs.readFileSync(path.join(__dirname, 'pipeline.js'), 'utf8');
  // `[a-z0-9_]`, not `[a-z_]`: the first version captured `m76_plans` as "m" and then reported
  // that the pilot writes to a table called "m". A guard whose own regex is wrong reports a defect
  // that does not exist, which is the fastest way to get a guard switched off.
  // `(?<!DO )UPDATE` so `ON CONFLICT ... DO UPDATE SET` is not read as a table write.
  const writes = [...src.matchAll(/(INSERT INTO|(?<!DO )UPDATE|DELETE FROM)\s+([a-z0-9_]+)/gi)]
    .map((m) => m[2].toLowerCase())
    .filter((t) => t !== 'set');
  for (const t of writes) {
    assert.ok(SCHEMA.TABLES.includes(t),
      `the pilot writes to ${t}, which is not one of its own tables (${SCHEMA.TABLES.join(', ')})`);
  }
  assert.ok(writes.length >= 4, `expected several writes, found ${writes.length}`);
});

test('the schema can be rolled back completely', () => {
  for (const t of SCHEMA.TABLES) {
    assert.ok(SCHEMA.ROLLBACK.some((s) => new RegExp(`DROP TABLE IF EXISTS ${t}\\b`).test(s)),
      `${t} has no rollback`);
  }
  // Children before parents, or the rollback fails on a foreign key.
  const order = SCHEMA.ROLLBACK.filter((s) => /DROP TABLE/.test(s)).map((s) => s.match(/EXISTS (\w+)/)[1]);
  assert.ok(order.indexOf('m76_reports') < order.indexOf('m76_plans'));
  assert.ok(order.indexOf('m76_plan_steps') < order.indexOf('m76_plans'));
  assert.ok(order.indexOf('m76_plans') < order.indexOf('m76_goals'));
});
