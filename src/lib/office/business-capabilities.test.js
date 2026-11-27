// ── CAN THE PLAN CATCH A HANDLER THAT MADE THE ANSWER UP? ───────────────────
//
// B3.5, requirement 3 of 2026-11-26. The four read-only capabilities each declare an independent
// criterion, and `independent-criterion.test.js` records why that phrase needs proving rather than
// asserting: the previous criterion compared `JSON.stringify(output).includes('')`, which is always
// true, and every result validated for as long as it existed.
//
// Its lesson is the shape of this file: *"The happy path satisfies a vacuous criterion and a real
// one identically — the only way to tell them apart is to feed in output that SHOULD be refused."*
//
// So each capability gets one happy case and several refusals, and the refusals are the point. Each
// one is a specific lie a handler could tell:
//
//   · an absence reported as a number            (the defect the data-state vocabulary exists for)
//   · a figure that does not match the data
//   · a person, supplier or row that was never in the payload
//   · a supplier silently dropped from a ranking
//   · a reason that cites data the handler was never shown
//   · a retrieved row altered on the way back
//
// The handlers themselves are exercised here too, because a criterion that only ever sees
// hand-written output is a criterion nobody has pointed at the code it guards.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const BC = require('./business-capabilities');
const H = require('../../worker-client/handlers/business-read-only');

const step = (task_type, payload) => ({ step_id: 's1', task_type, payload });

// ═══ THE REGISTRY ITSELF ═══════════════════════════════════════════════════

test('the four capabilities the owner named are all present, and the set is closed', () => {
  assert.deepEqual([...BC.KEYS].sort(), [
    'analysis.procurement',
    'report.employee_task_status',
    'report.operational_status',
    'retrieve.business_data',
  ]);
  assert.ok(Object.isFrozen(BC.CAPABILITIES));
  for (const k of BC.KEYS) {
    const cap = BC.CAPABILITIES[k];
    assert.equal(typeof cap.retrieve, 'function', `${k} has no retriever`);
    assert.equal(typeof cap.criterion, 'function', `${k} has no criterion`);
    assert.match(cap.reuses, /^src\/lib\//, `${k} does not name the module it reuses`);
    assert.ok(cap.answers.length > 40, `${k} does not say what question it answers`);
  }
});

test('a type the registry does not own returns null, not a verdict', () => {
  // So `cycle.js` falls through to `no_independent_criterion` rather than being told a step is
  // valid by a module that has never heard of it.
  assert.equal(BC.validateStep(step('synthetic.echo', {}), { echoed: {} }), null);
  assert.equal(BC.validateStep(step('something.new', {}), {}), null);
});

test('output that is not an object is refused for every capability', () => {
  for (const k of BC.KEYS) {
    for (const bad of [null, undefined, 'a string', 42, []]) {
      const r = BC.validateStep(step(k, {}), bad);
      assert.equal(r.validated, false, `${k} accepted ${JSON.stringify(bad)}`);
    }
  }
});

test('a criterion that throws reads as NOT validated', () => {
  // The dangerous failure is an exception swallowed into a pass. Forced by handing the procurement
  // criterion a payload whose `candidates` is a hostile getter.
  const hostile = {};
  Object.defineProperty(hostile, 'candidates', { get() { throw new Error('boom'); } });
  const r = BC.validateStep(step('analysis.procurement', hostile), { ranked: [] });
  assert.equal(r.validated, false);
  assert.match(r.reason, /could not be evaluated/);
});

// ═══ 1. OPERATIONAL REPORTING ══════════════════════════════════════════════

const FACTS = [
  { kind: 'employee_assignments', key: 'open', status: 'measured', value: 7 },
  { kind: 'task_completion', key: 'rate', status: 'measured_zero', value: 0 },
  { kind: 'milestones', key: 'due', status: 'missing', value: null },
  { kind: 'objectives', key: 'active', status: 'unavailable', value: null },
];
const opsPayload = { capability: 'report.operational_status', as_of: '2026-11-26', facts: FACTS };

test('1. the handler\'s own output validates, and the statuses survive', async () => {
  const out = await H.runOperationalStatus(opsPayload, {});
  const r = BC.validateStep(step('report.operational_status', opsPayload), out);
  assert.equal(r.validated, true, r.reason);
  assert.equal(out.coverage.measured, 2);
  assert.equal(out.coverage.unmeasured, 2);
  // And the two unmeasured facts came back as null rather than zero.
  for (const s of out.sections.filter((x) => x.status === 'missing' || x.status === 'unavailable')) {
    assert.equal(s.value, null, `${s.kind} is ${s.status} and carries ${s.value}`);
  }
});

test('1a. REFUSED: an absence reported as a number', async () => {
  // The single most important refusal in this file. `missing` rendered as `0` reads as "we measured
  // zero", and a CEO acting on it is acting on a figure nobody established.
  const out = await H.runOperationalStatus(opsPayload, {});
  out.sections.find((s) => s.status === 'missing').value = 0;
  const r = BC.validateStep(step('report.operational_status', opsPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /an absence rendered as a number/);
});

test('1b. REFUSED: a figure that does not match the fact', async () => {
  const out = await H.runOperationalStatus(opsPayload, {});
  out.sections.find((s) => s.key === 'open').value = 70;
  const r = BC.validateStep(step('report.operational_status', opsPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /was 7 and is reported as 70/);
});

test('1c. REFUSED: a status quietly upgraded', async () => {
  // `missing` → `measured` with a value is the same lie wearing a label.
  const out = await H.runOperationalStatus(opsPayload, {});
  const s = out.sections.find((x) => x.status === 'missing');
  s.status = 'measured'; s.value = 3;
  const r = BC.validateStep(step('report.operational_status', opsPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /was missing and is reported as measured/);
});

test('1d. REFUSED: a fact the plan never minted, and a fact dropped', async () => {
  const out = await H.runOperationalStatus(opsPayload, {});
  out.sections.push({ kind: 'revenue', key: 'ytd', status: 'measured', value: 10_000_000 });
  let r = BC.validateStep(step('report.operational_status', opsPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /5 sections for 4 facts/);

  const short = await H.runOperationalStatus(opsPayload, {});
  short.sections.pop();
  r = BC.validateStep(step('report.operational_status', opsPayload), short);
  assert.equal(r.validated, false);
});

test('1e. the handler refuses a payload with no as-of day', async () => {
  await assert.rejects(() => H.runOperationalStatus({ facts: [] }, {}), /as_of/);
});

// ═══ 2. EMPLOYEE TASK STATUS ═══════════════════════════════════════════════

const empPayload = {
  capability: 'report.employee_task_status',
  date: '2026-11-26',
  employees: [{ id: 'u1', name: 'A', role: 'sales_team' }, { id: 'u2', name: 'B', role: 'dev_team' },
    { id: 'u3', name: 'C', role: 'support_team' }],
  tasks: [
    { id: 't1', user_id: 'u1', status: 'completed' },
    { id: 't2', user_id: 'u1', status: 'pending' },
    { id: 't3', user_id: 'u2', status: 'pending' },
    { id: 't4', user_id: 'gone', status: 'pending' },
  ],
};

test('2. the counts validate, every employee is covered, and an unlisted assignee is reported', async () => {
  const out = await H.runEmployeeTaskStatus(empPayload, {});
  const r = BC.validateStep(step('report.employee_task_status', empPayload), out);
  assert.equal(r.validated, true, r.reason);
  assert.equal(out.per_employee.length, 3, 'u3 has nothing assigned and must still appear');
  assert.deepEqual(out.unassigned_employees, ['u3']);
  // A task assigned to somebody the company does not list is a finding, not a rounding error.
  assert.deepEqual(out.tasks_for_unlisted_people, ['gone']);
});

test('2a. REFUSED: an invented employee', async () => {
  const out = await H.runEmployeeTaskStatus(empPayload, {});
  out.per_employee.push({ user_id: 'u9', assigned: 5, completed: 5 });
  const r = BC.validateStep(step('report.employee_task_status', empPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /is not in the payload/);
});

test('2b. REFUSED: a count that does not match the tasks', async () => {
  const out = await H.runEmployeeTaskStatus(empPayload, {});
  out.per_employee.find((r) => r.user_id === 'u1').completed = 2;
  const r = BC.validateStep(step('report.employee_task_status', empPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /completed=2/);
});

test('2c. REFUSED: an employee silently omitted', async () => {
  // The quiet one. A report covering the busy people answers "who is working" while looking like
  // an answer to "who has work", and nobody notices the missing row.
  const out = await H.runEmployeeTaskStatus(empPayload, {});
  out.per_employee = out.per_employee.filter((r) => r.assigned > 0);
  const r = BC.validateStep(step('report.employee_task_status', empPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /covers 2 of 3 employees/);
});

// ═══ 3. PROCUREMENT ANALYSIS ═══════════════════════════════════════════════

const procPayload = {
  capability: 'analysis.procurement',
  rfq_id: 'rfq-1',
  candidates: [
    { supplier_id: 's1', name: 'One', dmf: false, gmp: true, responsiveness: 'slow', approvals: 0 },
    { supplier_id: 's2', name: 'Two', dmf: true, gmp: true, responsiveness: 'fast', approvals: 5 },
    { supplier_id: 's3', name: 'Three', dmf: false, gmp: false, responsiveness: 'normal', approvals: 1 },
  ],
};

test('3. the ranking validates, is a permutation, and is ordered by the evidence', async () => {
  const out = await H.runProcurementAnalysis(procPayload, {});
  const r = BC.validateStep(step('analysis.procurement', procPayload), out);
  assert.equal(r.validated, true, r.reason);
  assert.deepEqual(out.ranked.map((x) => x.supplier_id), ['s2', 's1', 's3']);
  assert.match(out.not_a_decision, /not a decision|human decision/);
});

test('3a. REFUSED: a supplier dropped from the ranking', async () => {
  const out = await H.runProcurementAnalysis(procPayload, {});
  out.ranked = out.ranked.slice(0, 2);
  const r = BC.validateStep(step('analysis.procurement', procPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /covers 2 of 3 candidates/);
});

test('3b. REFUSED: a supplier that was never a candidate', async () => {
  const out = await H.runProcurementAnalysis(procPayload, {});
  out.ranked.push({ supplier_id: 's99', score: 99, reasons: ['dmf on file'] });
  const r = BC.validateStep(step('analysis.procurement', procPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /is not a candidate/);
});

test('3c. REFUSED: a duplicate, which would double a supplier\'s weight in a shortlist', async () => {
  const out = await H.runProcurementAnalysis(procPayload, {});
  out.ranked.push(out.ranked[0]);
  const r = BC.validateStep(step('analysis.procurement', procPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /appears twice/);
});

test('3d. REFUSED: a reason that cites nothing the handler was shown', async () => {
  // The prose case, and the one a model would produce: a confident sentence about data nobody
  // supplied. "Long-standing relationship" is not in the payload and cannot be checked.
  const out = await H.runProcurementAnalysis(procPayload, {});
  out.ranked[0].reasons = ['long-standing relationship and excellent reputation'];
  const r = BC.validateStep(step('analysis.procurement', procPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /cites none of the fields/);
});

// ═══ 4. GOVERNED BUSINESS-DATA RETRIEVAL ═══════════════════════════════════

const retPayload = {
  capability: 'retrieve.business_data',
  dataset: 'milestones',
  fields: ['id', 'title', 'status', 'due_date'],
  rows: [
    { id: 'm1', title: 'Alpha', status: 'open', due_date: '2026-12-01' },
    { id: 'm2', title: 'Beta', status: 'closed', due_date: '2026-11-01' },
  ],
};

test('4. a retrieval validates when the rows come back as they were given', async () => {
  const out = await H.runBusinessDataRetrieval(retPayload, {});
  const r = BC.validateStep(step('retrieve.business_data', retPayload), out);
  assert.equal(r.validated, true, r.reason);
  assert.equal(out.row_count, 2);
});

test('4a. REFUSED: a row altered on the way back', async () => {
  // The quietest lie available to a retrieval, and the reason the criterion compares whole rows
  // rather than counting them.
  const out = await H.runBusinessDataRetrieval(retPayload, {});
  out.rows[0].status = 'closed';
  const r = BC.validateStep(step('retrieve.business_data', retPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /altered or fabricated/);
});

test('4b. REFUSED: a row that was never retrieved, and a field outside the projection', async () => {
  const out = await H.runBusinessDataRetrieval(retPayload, {});
  out.rows.push({ id: 'm3', title: 'Gamma', status: 'open', due_date: null });
  let r = BC.validateStep(step('retrieve.business_data', retPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /3 rows for 2 retrieved/);

  const widened = await H.runBusinessDataRetrieval(retPayload, {});
  widened.rows[0].owner_email = 'someone@abiozen.com';
  r = BC.validateStep(step('retrieve.business_data', retPayload), widened);
  assert.equal(r.validated, false);
  assert.match(r.reason, /outside the declared projection/);
});

test('4c. REFUSED: answering about a different dataset than the one asked for', async () => {
  const out = await H.runBusinessDataRetrieval(retPayload, {});
  out.dataset = 'employee_scores';
  const r = BC.validateStep(step('retrieve.business_data', retPayload), out);
  assert.equal(r.validated, false);
  assert.match(r.reason, /for a request for 'milestones'/);
});

test('4d. the CONTEXT is asserted before the dataset is even looked at', async () => {
  // The ordering, pinned. My first version of this test expected `not an allowlisted dataset` for
  // `dataset: 'users'` and got the context refusal instead — because `assertedContext(ctx)` is the
  // retriever's first line. That is the right order and worth asserting rather than working
  // around: a caller with no valid context should not learn which datasets exist, and authorization
  // before argument validation is the safer sequence when the argument names data.
  //
  // The allowlist's own refusal needs a real resolved context, so it is exercised in
  // scripts/check-business-capabilities-db.js, where there is a database to resolve one from.
  const cap = BC.CAPABILITIES['retrieve.business_data'];
  for (const dataset of ['users', 'office_budget_reservations', 'milestones']) {
    await assert.rejects(() => cap.retrieve({}, { dataset }, {}),
      /not produced by/,
      `dataset '${dataset}' reached the allowlist without a valid context`);
  }
  // And the allowlisted ones each declare their reader and their fields, so there is no path by
  // which a caller chooses either.
  for (const [name, spec] of Object.entries(BC.DATASETS)) {
    assert.equal(typeof spec.reader, 'string', `${name} names no reader`);
    assert.ok(Array.isArray(spec.fields) && spec.fields.length, `${name} declares no fields`);
  }
});

// ═══ 5. THE HANDLERS HOLD NO CREDENTIALS AND NO TRANSPORT ═════════════════

test('5. the handler file cannot read a database or reach a network', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const LEX = require(path.join(__dirname, '..', '..', '..', 'scripts', 'js-lex.js'));
  const file = path.join(__dirname, '..', '..', 'worker-client', 'handlers', 'business-read-only.js');
  const code = LEX.blankCommentsOnly(fs.readFileSync(file, 'utf8'));

  // The property that lets these run on a machine in an office: there is nothing they could read
  // that the plan did not hand them. Asserted on the source, because the alternative is trusting
  // that nobody adds a `require('../../lib/db')` later.
  for (const re of [/require\(['"][^'"]*\bdb\b[^'"]*['"]\)/, /\bfetch\s*\(/, /child_process/,
    /require\(['"](https?|net|fs|dns)['"]\)/, /process\.env/]) {
    assert.equal(re.test(code), false,
      `the read-only handlers match ${re} — they are meant to be pure functions of their payload, `
      + 'which is what makes it safe to run them on a machine that must never reach the business');
  }
});

test('5a. every handler reads its abort signal', async () => {
  // A handler that accepts a signal and never checks it is decorative: a STOP, a revoked lease or
  // a deadline would not stop it.
  const aborted = { aborted: true };
  const cases = [
    [H.runOperationalStatus, opsPayload],
    [H.runEmployeeTaskStatus, empPayload],
    [H.runProcurementAnalysis, procPayload],
    [H.runBusinessDataRetrieval, retPayload],
  ];
  for (const [fn, payload] of cases) {
    await assert.rejects(() => fn(payload, { signal: aborted }), (e) => e.aborted === true,
      `${fn.name} ignored an aborted signal`);
  }
});

test('5b. validateOutput is the handler contract, and is not the criterion', () => {
  // Both exist deliberately. This one asks "is this well formed"; the criterion asks "is this the
  // answer to what I asked". A well-formed report of invented numbers passes here and fails there,
  // which is the whole reason the second one exists.
  const invented = {
    capability: 'report.employee_task_status',
    per_employee: [{ user_id: 'nobody', assigned: 99, completed: 99 }],
  };
  assert.deepEqual(H.validateOutput(invented), [], 'it is well formed');
  const r = BC.validateStep(step('report.employee_task_status', empPayload), invented);
  assert.equal(r.validated, false, 'and it is not the answer to the question');
});
