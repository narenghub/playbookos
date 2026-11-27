// ── B3.5: THE FOUR READ-ONLY BUSINESS HANDLERS ──────────────────────────────
//
// Owner's requirement 3, 2026-11-26: *"Complete B3.5 with practical read-only business capabilities
// and independent validation criteria. Synthetic echo alone is insufficient for a useful autonomous
// office. Prioritize operational reporting, employee task status, procurement analysis and governed
// business-data retrieval. Reuse existing modules."*
//
// ── WHAT A HANDLER MAY SEE, AND WHY IT IS SO LITTLE ────────────────────────
//
// These run on a worker. In the M7 design that worker is a machine in an office which must never be
// able to read the business, so a handler has **no database credentials and no network**: it is a
// pure function from the payload it was handed to the result it returns. The retrieval happens
// server-side in `src/lib/office/business-capabilities.js`, company-scoped, through modules that
// already existed.
//
// That is why every handler here begins by refusing a payload it does not understand rather than
// going to look for better data. There is nowhere to look.
//
// ── AND WHY NONE OF THEM INVENTS A FIGURE ──────────────────────────────────
//
// Each capability's criterion RECOMPUTES the answer from the payload and requires equality
// (`business-capabilities.js`, each `criterion`). So a handler cannot pass by being well-formed. In
// particular:
//
//   · an unmeasured fact must come back with `value: null`, not `0`. `missing` rendered as a zero
//     is the defect the whole measured/measured_zero/missing vocabulary exists to prevent, and the
//     operational criterion fails an output that does it.
//   · a ranking must be a permutation of its candidates. Dropping one silently fails.
//   · a reason must cite a field the payload carried. Prose fails.
//   · a retrieval may only return rows it was given, field for field. Altering one fails.
//
// Those are not defensive extras; they are what these handlers are FOR. An autonomous office whose
// reports might contain invented numbers is worse than one that reports nothing.

'use strict';

const MAX_PAYLOAD_BYTES = 512 * 1024;

class Aborted extends Error {
  constructor() { super('aborted'); this.name = 'Aborted'; this.aborted = true; }
}

/** Checked between units of work: a handler that takes a signal and never reads it is decorative. */
function checkSignal(signal) {
  if (signal && signal.aborted) throw new Aborted();
}

function guardPayload(payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload || {}), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload is ${bytes} bytes; these tasks accept at most ${MAX_PAYLOAD_BYTES}`);
  }
}

const UNMEASURED = new Set(['missing', 'unavailable']);

// ══ 1. OPERATIONAL REPORTING ════════════════════════════════════════════════

async function runOperationalStatus(payload = {}, { signal } = {}) {
  guardPayload(payload);
  if (!Array.isArray(payload.facts)) throw new Error('payload.facts must be an array');
  if (typeof payload.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.as_of)) {
    throw new Error('payload.as_of must be YYYY-MM-DD: a report with no as-of day cannot be filed');
  }

  const sections = [];
  for (const f of payload.facts) {
    checkSignal(signal);
    if (!f || typeof f !== 'object' || !f.kind) {
      throw new Error('every fact must be an object carrying a kind');
    }
    const unmeasured = UNMEASURED.has(String(f.status));
    sections.push({
      kind: f.kind,
      key: f.key || '',
      status: f.status,
      // NULL, not 0, when nothing was measured. The criterion refuses a figure here, and it is
      // right to: "0 open tasks" and "we could not tell how many open tasks there are" are
      // different sentences and only one of them is a measurement.
      value: unmeasured ? null : (f.value === undefined ? null : f.value),
      // Carried through verbatim so a reader sees the module's own words rather than a paraphrase.
      detail: f.detail || null,
    });
  }

  const measured = sections.filter((s) => !UNMEASURED.has(String(s.status))).length;
  return {
    capability: 'report.operational_status',
    as_of: payload.as_of,
    sections,
    // Counts OF SECTIONS, which is a fact about this report rather than about the business — so it
    // cannot be mistaken for an operational figure.
    coverage: {
      facts: sections.length,
      measured,
      unmeasured: sections.length - measured,
    },
    degraded: Array.isArray(payload.degraded) ? payload.degraded : [],
  };
}

// ══ 2. EMPLOYEE TASK STATUS ═════════════════════════════════════════════════

async function runEmployeeTaskStatus(payload = {}, { signal } = {}) {
  guardPayload(payload);
  if (!Array.isArray(payload.employees)) throw new Error('payload.employees must be an array');
  if (!Array.isArray(payload.tasks)) throw new Error('payload.tasks must be an array');

  const rows = new Map(payload.employees.map((e) => [e.id, {
    user_id: e.id, name: e.name || null, role: e.role || null,
    assigned: 0, completed: 0, open: 0,
  }]));

  // A task for somebody outside the employee set is NOT counted into an "other" bucket and not
  // dropped in silence: it is reported in its own field, because an assignment to a person the
  // company does not list is a finding rather than a rounding error.
  const unknownAssignees = new Set();
  for (const t of payload.tasks) {
    checkSignal(signal);
    const row = rows.get(t && t.user_id);
    if (!row) { if (t && t.user_id) unknownAssignees.add(t.user_id); continue; }
    row.assigned += 1;
    if (t.status === 'completed') row.completed += 1; else row.open += 1;
  }

  // EVERY employee, including those with nothing assigned. A report that lists only the busy people
  // answers "who is working" and looks like an answer to "who has work".
  const per_employee = [...rows.values()];
  return {
    capability: 'report.employee_task_status',
    date: payload.date || null,
    per_employee,
    unassigned_employees: per_employee.filter((r) => r.assigned === 0).map((r) => r.user_id),
    tasks_for_unlisted_people: [...unknownAssignees],
  };
}

// ══ 3. PROCUREMENT ANALYSIS ═════════════════════════════════════════════════

/**
 * The ordering rule, stated here as the handler's own arithmetic over the fields the payload
 * carried. It deliberately does NOT import `supplier-evidence.js`: a handler that shared the
 * ranking code with the retriever would be checked against itself, and the worker has no access to
 * that module anyway.
 */
function scoreOf(c) {
  const responsiveness = { fast: 3, normal: 2, slow: 1 }[String(c.responsiveness)] || 0;
  return (c.dmf ? 8 : 0) + (c.gmp ? 4 : 0) + responsiveness + Math.min(Number(c.approvals) || 0, 3);
}

async function runProcurementAnalysis(payload = {}, { signal } = {}) {
  guardPayload(payload);
  if (!Array.isArray(payload.candidates)) throw new Error('payload.candidates must be an array');

  const ranked = payload.candidates.map((c) => {
    checkSignal(signal);
    const reasons = [];
    // EVERY REASON NAMES A FIELD FROM THE PAYLOAD. The criterion refuses a reason that cites
    // nothing the handler was shown, so this is the shape it has to take.
    if (c.dmf) reasons.push('dmf on file'); else reasons.push('no dmf on file');
    if (c.gmp) reasons.push('gmp certified'); else reasons.push('gmp not evidenced');
    reasons.push(`responsiveness ${c.responsiveness || 'unknown'}`);
    reasons.push(`approvals ${Number(c.approvals) || 0}`);
    return { supplier_id: c.supplier_id, name: c.name || null, score: scoreOf(c), reasons };
  });

  // Stable: equal scores keep the order the payload gave, so two runs over one payload rank
  // identically and a reviewer comparing them is comparing the analysis, not the sort.
  ranked.sort((a, b) => (b.score - a.score)
    || payload.candidates.findIndex((x) => x.supplier_id === a.supplier_id)
     - payload.candidates.findIndex((x) => x.supplier_id === b.supplier_id));

  return {
    capability: 'analysis.procurement',
    rfq_id: payload.rfq_id || null,
    ranked,
    // Stated, never implied: this is an ordering over recorded evidence and it is not a decision.
    not_a_decision: 'an ordering over the evidence supplied. Choosing a supplier is a human '
      + 'decision and nothing here places an order, requests a quote or contacts anybody.',
  };
}

// ══ 4. GOVERNED BUSINESS-DATA RETRIEVAL ═════════════════════════════════════

async function runBusinessDataRetrieval(payload = {}, { signal } = {}) {
  guardPayload(payload);
  if (!Array.isArray(payload.rows)) throw new Error('payload.rows must be an array');
  if (!Array.isArray(payload.fields)) throw new Error('payload.fields must be an array');

  // The rows are returned AS GIVEN. There is nothing to compute: the governance happened at
  // retrieval, where the dataset came off an allowlist and the projection off that dataset's
  // declared fields. A handler that reshaped them here would be undoing that.
  const rows = payload.rows.map((r) => {
    checkSignal(signal);
    const out = {};
    for (const f of payload.fields) out[f] = r[f] === undefined ? null : r[f];
    return out;
  });

  return {
    capability: 'retrieve.business_data',
    dataset: payload.dataset,
    fields: payload.fields,
    rows,
    row_count: rows.length,
  };
}

// ── OUTPUT VALIDATION, AT THE EXECUTOR BOUNDARY ────────────────────────────
//
// Separate from the criterion in business-capabilities.js, and both exist on purpose: this one is
// the handler's own contract ("is this well formed"), and that one is the plan's independent check
// ("is this the answer to what I asked"). The second is the one that catches an invented figure.
function validateOutput(out) {
  const problems = [];
  if (!out || typeof out !== 'object') return ['the output is not an object'];
  if (!out.capability) problems.push('the output names no capability');
  const arrays = {
    'report.operational_status': 'sections',
    'report.employee_task_status': 'per_employee',
    'analysis.procurement': 'ranked',
    'retrieve.business_data': 'rows',
  };
  const key = arrays[out.capability];
  if (!key) problems.push(`'${out.capability}' is not one of the four read-only capabilities`);
  else if (!Array.isArray(out[key])) problems.push(`\`${key}\` must be an array`);
  return problems;
}

// ── FOUR HANDLER OBJECTS, ONE FILE ─────────────────────────────────────────
//
// `executor.js`'s HANDLERS table requires each entry to expose `{run, validateOutput}`, and it is
// deliberately a frozen object of STATIC requires — *"a conditionally-registered handler would make
// this table depend on the environment"*. Four adapter files would satisfy that and would be four
// files of boilerplate around four functions that share their payload guard, their abort handling
// and their output contract. One file, four exported objects: the table stays closed and statically
// required, and the shared parts are shared once.
const operationalStatus = Object.freeze({ run: runOperationalStatus, validateOutput });
const employeeTaskStatus = Object.freeze({ run: runEmployeeTaskStatus, validateOutput });
const procurementAnalysis = Object.freeze({ run: runProcurementAnalysis, validateOutput });
const businessDataRetrieval = Object.freeze({ run: runBusinessDataRetrieval, validateOutput });

module.exports = {
  MAX_PAYLOAD_BYTES, Aborted, validateOutput, scoreOf,
  runOperationalStatus, runEmployeeTaskStatus, runProcurementAnalysis, runBusinessDataRetrieval,
  operationalStatus, employeeTaskStatus, procurementAnalysis, businessDataRetrieval,
};
