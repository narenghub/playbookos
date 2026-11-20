// ── THE FIRST TASK THAT COMPUTES SOMETHING ──────────────────────────────────
//
// M7.6. `report.daily_operations` was declared in the task vocabulary at M7.2 — "renders an
// internal operations summary from data already in the database" — and had no handler until now.
// Its declared flags were already right for a pilot: `reexecutable: true`, `readOnly: true`,
// `ceilingMinutes: 15`.
//
// ── IT IS A PURE FUNCTION OF ITS PAYLOAD, AND THAT IS THE DESIGN ────────────
//
// The type summary says "from data already in the database". This handler does NOT read a
// database, because the worker has no database handle and must not acquire one: the handler
// signature deliberately hands over a payload and an AbortSignal and nothing else, so that the
// tenth task written against it cannot quietly start writing rows from a Mac in an office.
//
// So the facts travel IN the payload. The server reads the database — where it already has
// credentials, governance and audit — and the worker computes. That split is why no database URL
// ever reaches the iMac, and it is also what makes `reexecutable: true` honest: the same payload
// produces a byte-identical report, which a test can assert without any hardware.
//
// ── THE ARITHMETIC IS CHECKED HERE *AND* ON THE SERVER ─────────────────────
//
// `validateOutput` below refuses output whose section counts do not reconcile with `factCount`.
// src/lib/m76/validate.js then checks the same arithmetic again, server-side, and does not trust
// this function's word for it. That is not redundancy for its own sake: a handler validating its
// own output is the author checking their own working, and the server is the party that has to
// decide whether a report may be assembled.

'use strict';

/** Refused, not truncated. A report over a cap is a wrong report, not a long one. */
const MAX_PAYLOAD_BYTES = 32 * 1024;

/** The closed set of fact kinds. An unknown kind refuses the task rather than being bucketed. */
const KINDS = Object.freeze(['assay', 'batch', 'qc_check', 'inquiry', 'shipment']);

/** The closed set of statuses, in report order. */
const STATUSES = Object.freeze(['open', 'closed', 'blocked']);

class Aborted extends Error {
  constructor() { super('aborted'); this.name = 'Aborted'; this.aborted = true; }
}

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * @param {object}      payload  `{ asOf: 'YYYY-MM-DD', facts: [{id, kind, molecule, status, units}] }`
 * @param {AbortSignal} signal   aborted on STOP, revocation, cancellation, lease loss or deadline
 * @returns {Promise<object>}    the report body; the executor validates and bounds it
 */
async function run(payload = {}, { signal } = {}) {
  const raw = JSON.stringify(payload || {});
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload is ${bytes} bytes; this task accepts at most ${MAX_PAYLOAD_BYTES}`);
  }
  if (!isDay(payload.asOf)) {
    throw new Error('payload.asOf must be a YYYY-MM-DD date: a report without an as-of date cannot be filed');
  }
  if (!Array.isArray(payload.facts)) {
    throw new Error('payload.facts must be an array');
  }

  // Each fact is validated before it is counted. A fact with an unrecognised kind or status is a
  // refusal, not a row in an "other" bucket — a bucket named "other" is where a vocabulary change
  // goes to hide.
  const buckets = new Map(KINDS.map((k) => [k, { count: 0, units: 0, byStatus: {} }]));
  for (const k of KINDS) for (const st of STATUSES) buckets.get(k).byStatus[st] = 0;

  for (let i = 0; i < payload.facts.length; i++) {
    // Checked between units of work: a handler that accepts a signal and never reads it is
    // cooperative cancellation in name only.
    if (i % 64 === 0 && signal && signal.aborted) throw new Aborted();

    const f = payload.facts[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw new Error(`facts[${i}] is not an object`);
    }
    if (!KINDS.includes(f.kind)) {
      throw new Error(`facts[${i}] has kind '${f.kind}', which is not one of ${KINDS.join(', ')}`);
    }
    if (!STATUSES.includes(f.status)) {
      throw new Error(`facts[${i}] has status '${f.status}', which is not one of ${STATUSES.join(', ')}`);
    }
    const units = Number(f.units);
    if (!Number.isFinite(units) || units < 0) {
      throw new Error(`facts[${i}] has units '${f.units}', which is not a non-negative number`);
    }

    const b = buckets.get(f.kind);
    b.count += 1;
    b.units += units;
    b.byStatus[f.status] += 1;
  }

  if (signal && signal.aborted) throw new Aborted();

  // Kinds with nothing in them are reported as zero rather than omitted: a section that disappears
  // when a count is zero makes "no assays today" indistinguishable from "assays were not counted".
  const sections = KINDS.map((kind) => {
    const b = buckets.get(kind);
    return {
      kind,
      count: b.count,
      units: Math.round(b.units * 100) / 100,
      byStatus: { ...b.byStatus },
    };
  });

  const totals = {
    count: sections.reduce((n, s) => n + s.count, 0),
    units: Math.round(sections.reduce((n, s) => n + s.units, 0) * 100) / 100,
    blocked: sections.reduce((n, s) => n + s.byStatus.blocked, 0),
  };

  return {
    asOf: payload.asOf,
    factCount: payload.facts.length,
    sections,
    totals,
    // No timestamps, hostnames, usernames or paths — the same rule synthetic-echo follows. Output
    // travels to the server and is read by whoever is debugging; a hostname in it makes every
    // result mildly identifying for no benefit. `asOf` comes from the request, so the report is
    // reproducible rather than dependent on the worker's clock.
  };
}

/**
 * Structured output validation, declared next to the handler that produces it. The executor
 * refuses to submit output that fails this.
 */
function validateOutput(out) {
  if (out === null || typeof out !== 'object' || Array.isArray(out)) {
    return ['output must be a plain object'];
  }
  const problems = [];
  const allowed = ['asOf', 'factCount', 'sections', 'totals'];
  for (const k of Object.keys(out)) {
    if (!allowed.includes(k)) problems.push(`unexpected key \`${k}\``);
  }
  if (!isDay(out.asOf)) problems.push('`asOf` must be a YYYY-MM-DD date');
  if (!Number.isInteger(out.factCount) || out.factCount < 0) {
    problems.push('`factCount` must be a non-negative integer');
  }
  if (!Array.isArray(out.sections)) {
    problems.push('`sections` must be an array');
    return problems;
  }
  if (out.sections.length !== KINDS.length) {
    problems.push(`\`sections\` must cover all ${KINDS.length} kinds, found ${out.sections.length}`);
  }
  let summed = 0;
  for (const s of out.sections) {
    if (!s || typeof s !== 'object') { problems.push('a section is not an object'); continue; }
    if (!KINDS.includes(s.kind)) problems.push(`section kind \`${s.kind}\` is not allowlisted`);
    if (!Number.isInteger(s.count) || s.count < 0) {
      problems.push(`section ${s.kind}: \`count\` must be a non-negative integer`);
      continue;
    }
    const byStatus = s.byStatus || {};
    const statusSum = STATUSES.reduce((n, st) => n + (Number(byStatus[st]) || 0), 0);
    if (statusSum !== s.count) {
      problems.push(`section ${s.kind}: statuses sum to ${statusSum} but count is ${s.count}`);
    }
    summed += s.count;
  }
  // THE RECONCILIATION. A report whose parts do not add up to its whole is the one failure mode
  // that looks completely normal in a rendered summary.
  if (Number.isInteger(out.factCount) && summed !== out.factCount) {
    problems.push(`sections sum to ${summed} but factCount is ${out.factCount}`);
  }
  if (!out.totals || typeof out.totals !== 'object') {
    problems.push('`totals` must be an object');
  } else if (Number.isInteger(out.totals.count) && out.totals.count !== summed) {
    problems.push(`totals.count is ${out.totals.count} but sections sum to ${summed}`);
  }
  return problems;
}

module.exports = { run, validateOutput, MAX_PAYLOAD_BYTES, KINDS, STATUSES, Aborted };
