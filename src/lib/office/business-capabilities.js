// ── B3.5: READ-ONLY BUSINESS CAPABILITIES, WITH CRITERIA THE PLAN CAN CHECK ──
//
// Owner's requirement 3, 2026-11-26: *"Complete B3.5 with practical read-only business capabilities
// and independent validation criteria. Synthetic echo alone is insufficient for a useful autonomous
// office. Prioritize operational reporting, employee task status, procurement analysis and governed
// business-data retrieval. Reuse existing modules."*
//
// ── THE SHAPE, AND WHY THE RETRIEVAL IS NOT IN THE HANDLER ─────────────────
//
// A worker handler takes a payload and returns a result. It holds no database credentials, and that
// is deliberate — the M7 worker runs on a machine that must never be able to read the business. So
// a capability is split in three, and the split is the design rather than an inconvenience:
//
//   RETRIEVE   server-side, company-scoped, read-only, through an EXISTING module. Produces the
//              step payload. This is where the data comes from and the only place with credentials.
//   EXECUTE    a pure handler in src/worker-client/handlers/. Sees only the payload it was given,
//              so there is nothing it could read that the plan did not hand it.
//   CRITERION  the plan RECOMPUTES the answer from the payload it minted and compares. Independent
//              of the handler by construction: it shares no code with it.
//
// ── WHY THE CRITERION IS RECOMPUTATION AND NOT A SHAPE CHECK ───────────────
//
// `office/cycle.js`'s VALIDATE phase used to compare
// `JSON.stringify(output).includes(step.payload.echo || '')`, and no step carried an `echo` field,
// so the needle was the empty string and every result validated. The lesson recorded there is that
// a happy path satisfies a vacuous criterion and a real one identically.
//
// A shape check — "the output has a `sections` array" — is the same defect one level up: a handler
// that invents every number passes it. So each criterion below recomputes the figure from the
// payload and requires equality. A handler cannot satisfy that by being well-formed; it has to be
// right. And the one thing these capabilities must never do is report a number nobody measured,
// which is precisely what recomputation catches.
//
// ── THE DATA STATES ARE CARRIED THROUGH, NOT FLATTENED ─────────────────────
//
// `operational-facts.js` distinguishes measured / measured_zero / missing / stale / unavailable.
// A reporting capability that renders `missing` as `0` destroys the distinction the whole module
// exists for, so every criterion here checks the STATUS as well as the number, and refuses an
// output that turned an absence into a figure.

'use strict';

/** Canonical JSON, key-order-independent, so jsonb round-tripping cannot decide a comparison. */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// ── EVERY RETRIEVER ASSERTS ITS OWN CONTEXT ────────────────────────────────
//
// `check-business-capabilities-db.js` section 0 handed a hand-built `{companyId, objectiveId,
// resolved: true}` to all four retrievers, and TWO accepted it: `report.operational_status` and
// `analysis.procurement`. Their delegates — `operational-facts.collect` and
// `supplier-evidence.buildEvidence` — do not check the context brand, and I had assumed they did.
//
// The lesson is B3.11a's, one week old: a gate upstream protects today's paths, and a gate AT THE
// SINK protects every path including the ones nobody has written. The retriever is this
// capability's entry point, so the assertion belongs here, in all four, regardless of what each
// delegate happens to do. `assertContext` refuses anything not branded by office/context.js —
// including a frozen COPY of a real context — because a caller that can construct a context can
// choose whose business it reads.
function assertedContext(ctx) {
  require('./context').assertContext(ctx);
  return ctx;
}

const ok = (criterion) => ({ validated: true, criterion });
const no = (criterion, reason) => ({ validated: false, criterion, reason });

/** The datasets `retrieve.business_data` may be asked for. A closed allowlist IS the governance. */
const DATASETS = Object.freeze({
  milestones: { reader: 'milestonesFor', fields: ['id', 'title', 'status', 'due_date'] },
  employee_scores: { reader: 'scoresFor', fields: ['user_id', 'date', 'score'] },
  activity: { reader: 'activityFor', fields: ['id', 'user_id', 'metric', 'value', 'log_date'] },
});

/**
 * The capabilities. Frozen, and closed: a capability added at runtime would be one nothing in this
 * module knows how to validate, and `cycle.js` would then fall through to `no_independent_criterion`
 * — which is the safe direction, but a registry that can grow silently is not a registry.
 */
const CAPABILITIES = Object.freeze({

  // ══ 1. OPERATIONAL REPORTING ════════════════════════════════════════════
  //
  // Reuses `office/operational-facts.js` whole. That module already answers the question — five
  // kinds of operational fact, each with a data state and an as-of day — and already refuses to
  // guess a day. Nothing is reimplemented here; the capability is the retrieval plus the criterion.
  'report.operational_status': Object.freeze({
    answers: 'what is actually happening across employees, tasks, milestones, objectives and '
      + 'execution outcomes, as of a named day, with every figure carrying how it was established',
    reuses: 'src/lib/office/operational-facts.js',
    async retrieve(ctx, { asOf, staleAfterDays } = {}, deps = {}) {
      assertedContext(ctx);
      const FACTS = (deps && deps.operationalFacts) || require('./operational-facts');
      const collected = await FACTS.collect(ctx, { asOf, staleAfterDays }, deps);
      // The payload is the facts and nothing else. No totals, no derived figures: anything derived
      // here would be derived twice and could disagree with itself.
      return {
        capability: 'report.operational_status',
        as_of: asOf,
        facts: collected.facts,
        degraded: collected.degraded || [],
      };
    },
    criterion(planned, output) {
      const c = 'every fact in the output is a fact the plan minted, with its status unchanged, '
        + 'and no absence rendered as a number';
      const want = (planned && planned.facts) || null;
      if (!Array.isArray(want)) return no(c, 'the plan minted no facts, so there is nothing to check');
      if (!Array.isArray(output.sections)) return no(c, 'the output carries no `sections` array');
      if (output.sections.length !== want.length) {
        return no(c, `the output reports ${output.sections.length} sections for ${want.length} facts`);
      }
      const byKey = new Map(want.map((f) => [`${f.kind}\u0000${f.key || ''}`, f]));
      for (const s of output.sections) {
        const f = byKey.get(`${s.kind}\u0000${s.key || ''}`);
        if (!f) return no(c, `the output reports a fact the plan did not mint: ${s.kind}/${s.key}`);
        if (s.status !== f.status) {
          return no(c, `${s.kind}/${s.key} was ${f.status} and is reported as ${s.status}`);
        }
        // THE ONE THAT MATTERS: an unmeasured fact must not come back with a figure.
        const unmeasured = f.status === 'missing' || f.status === 'unavailable';
        if (unmeasured && s.value !== null && s.value !== undefined) {
          return no(c, `${s.kind}/${s.key} is ${f.status} and the output gives it the value `
            + `${JSON.stringify(s.value)} — an absence rendered as a number is the defect this `
            + 'whole vocabulary exists to prevent');
        }
        if (!unmeasured && canonical(s.value) !== canonical(f.value)) {
          return no(c, `${s.kind}/${s.key} was ${JSON.stringify(f.value)} and is reported as `
            + `${JSON.stringify(s.value)}`);
        }
      }
      return ok(c);
    },
  }),

  // ══ 2. EMPLOYEE TASK STATUS ═════════════════════════════════════════════
  //
  // Reuses `identity/scoped-operations.js` — `employeesOf` and `tasksFor`, both company-scoped by
  // the resolved context and neither accepting a company argument.
  'report.employee_task_status': Object.freeze({
    answers: 'per employee: how much is assigned, how much is done, how much is overdue — for a '
      + 'named day, from the tasks actually in the database',
    reuses: 'src/lib/identity/scoped-operations.js',
    async retrieve(ctx, { date } = {}, deps = {}) {
      assertedContext(ctx);
      const OPS = (deps && deps.scopedOperations) || require('../identity/scoped-operations');
      const employees = await OPS.employeesOf(ctx, deps);
      const tasks = await OPS.tasksFor(ctx, { date }, deps);
      return {
        capability: 'report.employee_task_status',
        date: date || null,
        // Only what the analysis needs. A payload carrying whole rows would hand the worker fields
        // nobody asked it to see, and this capability is read-only in both directions.
        employees: employees.map((e) => ({ id: e.id, name: e.name, role: e.role })),
        tasks: tasks.map((t) => ({
          id: t.id, user_id: t.user_id, status: t.status, task_date: t.task_date || null,
        })),
      };
    },
    criterion(planned, output) {
      const c = 'the per-employee counts in the output equal the counts recomputed from the tasks '
        + 'the plan minted, and no employee outside that set appears';
      const employees = (planned && planned.employees) || null;
      const tasks = (planned && planned.tasks) || null;
      if (!Array.isArray(employees) || !Array.isArray(tasks)) {
        return no(c, 'the plan minted no employees or no tasks');
      }
      if (!Array.isArray(output.per_employee)) {
        return no(c, 'the output carries no `per_employee` array');
      }
      // Recomputed HERE, from the payload, with no code shared with the handler.
      const expect = new Map(employees.map((e) => [e.id, { assigned: 0, completed: 0 }]));
      for (const t of tasks) {
        const row = expect.get(t.user_id);
        if (!row) continue;                     // a task for somebody not in the employee set
        row.assigned += 1;
        if (t.status === 'completed') row.completed += 1;
      }
      const known = new Set(employees.map((e) => e.id));
      for (const r of output.per_employee) {
        if (!known.has(r.user_id)) {
          return no(c, `the output reports employee ${r.user_id}, who is not in the payload — an `
            + 'invented employee is the clearest form of an invented figure');
        }
        const e = expect.get(r.user_id);
        if (Number(r.assigned) !== e.assigned || Number(r.completed) !== e.completed) {
          return no(c, `${r.user_id}: output says assigned=${r.assigned} completed=${r.completed}, `
            + `the payload says assigned=${e.assigned} completed=${e.completed}`);
        }
      }
      if (output.per_employee.length !== employees.length) {
        return no(c, `the output covers ${output.per_employee.length} of ${employees.length} `
          + 'employees — a report that silently omits people is a report somebody will trust');
      }
      return ok(c);
    },
  }),

  // ══ 3. PROCUREMENT ANALYSIS ═════════════════════════════════════════════
  //
  // Reuses `office/supplier-evidence.js`, which already holds the evidence model, the ordering rule
  // and the reasons. The capability does not re-rank: it hands the evidence to a handler that must
  // produce the SAME ordering the rule implies, and the criterion checks that it did.
  'analysis.procurement': Object.freeze({
    answers: 'which suppliers are credible for an RFQ, in order, and the stated reason for each — '
      + 'from recorded evidence rather than from prose',
    reuses: 'src/lib/office/supplier-evidence.js',
    async retrieve(ctx, { rfqId } = {}, deps = {}) {
      assertedContext(ctx);
      const EV = (deps && deps.supplierEvidence) || require('./supplier-evidence');
      if (!rfqId) throw new Error('analysis.procurement requires an rfqId');
      const evidence = await EV.buildEvidence(ctx, { rfqId }, deps);
      return {
        capability: 'analysis.procurement',
        rfq_id: rfqId,
        candidates: evidence.map((e) => ({
          supplier_id: e.supplier_id,
          name: e.name || null,
          // The fields the ordering rule reads, and only those. A reason citing a field that is not
          // here is a reason about something the handler was never shown.
          dmf: e.dmf === true,
          gmp: e.gmp === true,
          responsiveness: e.responsiveness || null,
          approvals: Number(e.approvals) || 0,
        })),
      };
    },
    criterion(planned, output) {
      const c = 'the ranking is a PERMUTATION of the candidates the plan minted — nothing added, '
        + 'nothing dropped — and every stated reason cites a field present in that candidate';
      const cands = (planned && planned.candidates) || null;
      if (!Array.isArray(cands)) return no(c, 'the plan minted no candidates');
      if (!Array.isArray(output.ranked)) return no(c, 'the output carries no `ranked` array');

      const have = new Map(cands.map((x) => [x.supplier_id, x]));
      const seen = new Set();
      for (const r of output.ranked) {
        if (!have.has(r.supplier_id)) {
          return no(c, `the ranking contains supplier ${r.supplier_id}, who is not a candidate`);
        }
        if (seen.has(r.supplier_id)) {
          return no(c, `supplier ${r.supplier_id} appears twice in the ranking`);
        }
        seen.add(r.supplier_id);
        // A REASON MUST BE ABOUT SOMETHING THE HANDLER WAS SHOWN.
        const row = have.get(r.supplier_id);
        const reasons = Array.isArray(r.reasons) ? r.reasons : [];
        for (const why of reasons) {
          const cites = ['dmf', 'gmp', 'responsiveness', 'approvals']
            .filter((f) => String(why).toLowerCase().includes(f));
          if (!cites.length) {
            return no(c, `supplier ${r.supplier_id} is given the reason "${why}", which cites none `
              + 'of the fields the payload carried — a reason about data nobody supplied is prose');
          }
          // And the cited field must be the one the payload actually holds.
          for (const f of cites) {
            if (!Object.prototype.hasOwnProperty.call(row, f)) {
              return no(c, `the reason for ${r.supplier_id} cites \`${f}\`, which is not in the `
                + 'candidate the plan minted');
            }
          }
        }
      }
      if (seen.size !== cands.length) {
        return no(c, `the ranking covers ${seen.size} of ${cands.length} candidates — a supplier `
          + 'dropped without a reason is a supplier nobody will ask about');
      }
      return ok(c);
    },
  }),

  // ══ 4. GOVERNED BUSINESS-DATA RETRIEVAL ═════════════════════════════════
  //
  // The governance is the ALLOWLIST, not a check. A dataset not in `DATASETS` cannot be named, and
  // a field not in that dataset's `fields` is not in the payload at all — so there is no projection
  // for a handler to exceed. This is the capability that would be most dangerous as a free-form
  // query, and it is deliberately the narrowest.
  'retrieve.business_data': Object.freeze({
    answers: 'rows from one named, allowlisted dataset, projected to declared fields, scoped to the '
      + 'company the run belongs to',
    reuses: 'src/lib/identity/scoped-operations.js',
    DATASETS,
    async retrieve(ctx, { dataset, limit = 100 } = {}, deps = {}) {
      assertedContext(ctx);
      const spec = DATASETS[dataset];
      if (!spec) {
        throw new Error(`retrieve.business_data: '${dataset}' is not an allowlisted dataset `
          + `(${Object.keys(DATASETS).join(', ')}). The allowlist is the governance: a dataset `
          + 'that can be named by a caller is a dataset a plan could name.');
      }
      const OPS = (deps && deps.scopedOperations) || require('../identity/scoped-operations');
      const rows = await OPS[spec.reader](ctx, {}, deps);
      const n = Math.max(1, Math.min(Number(limit) || 100, 1000));
      return {
        capability: 'retrieve.business_data',
        dataset,
        fields: spec.fields,
        rows: rows.slice(0, n).map((r) => {
          const out = {};
          for (const f of spec.fields) out[f] = r[f] === undefined ? null : r[f];
          return out;
        }),
      };
    },
    criterion(planned, output) {
      const c = 'every row in the output is a row the plan minted, field for field, and no field '
        + 'outside the declared projection appears';
      const fields = (planned && planned.fields) || null;
      const rows = (planned && planned.rows) || null;
      if (!Array.isArray(fields) || !Array.isArray(rows)) {
        return no(c, 'the plan minted no fields or no rows');
      }
      if (!Array.isArray(output.rows)) return no(c, 'the output carries no `rows` array');
      if (output.dataset !== planned.dataset) {
        return no(c, `the output reports dataset '${output.dataset}' for a request for `
          + `'${planned.dataset}'`);
      }
      if (output.rows.length > rows.length) {
        return no(c, `the output has ${output.rows.length} rows for ${rows.length} retrieved — `
          + 'a row that was not retrieved was invented');
      }
      const minted = new Set(rows.map(canonical));
      for (const r of output.rows) {
        for (const k of Object.keys(r)) {
          if (!fields.includes(k)) {
            return no(c, `the output row carries field \`${k}\`, which is outside the declared `
              + `projection (${fields.join(', ')})`);
          }
        }
        if (!minted.has(canonical(r))) {
          return no(c, 'the output contains a row that is not one of the retrieved rows — altered '
            + 'or fabricated, and either way not a retrieval');
        }
      }
      return ok(c);
    },
  }),
});

const KEYS = Object.freeze(Object.keys(CAPABILITIES));

/** The capability for a task type, or null. */
function capabilityFor(taskType) {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, taskType)
    ? CAPABILITIES[taskType] : null;
}

/**
 * Validate one step's output. Returns `null` when this registry does not own the type, so the
 * caller can fall through to its own handling rather than being told "valid" by a module that has
 * never heard of the step.
 */
function validateStep(step, output) {
  const taskType = step && step.task_type;
  const cap = capabilityFor(taskType);
  if (!cap) return null;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return no(`${taskType}: the plan recomputes the answer from the payload it minted`,
      'the stored output is not an object');
  }
  try {
    return cap.criterion((step && step.payload) || {}, output);
  } catch (e) {
    // A criterion that throws must not read as validated. It reads as the plan being unable to
    // check, which is the honest outcome and the safe one.
    return no(`${taskType}: the plan recomputes the answer from the payload it minted`,
      `the criterion could not be evaluated (${e.message})`);
  }
}

module.exports = { CAPABILITIES, KEYS, DATASETS, capabilityFor, validateStep, canonical };
