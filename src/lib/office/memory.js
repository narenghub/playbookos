// ── PERSISTENT, COMPANY-ISOLATED AGENT MEMORY (B3.1) ────────────────────────
//
//   const M = require('./memory');
//   await M.remember(ctx, { kind: 'decision', subject: '…', body: '…', author: 'agent:ceo-agent' });
//   await M.recall(ctx,   { query: 'supplier lead time' });
//
// THE ONLY ACCESSOR for `agent_memory`, enforced by scripts/check-identity-accessor-discipline.js
// for the same reason `user_companies` has one: a table that decides what an agent knows about a
// company must have exactly one road into it, so "is the company filter applied" is a question
// about one file rather than about every caller that will ever be written.
//
// ── WHY EVERY FUNCTION TAKES A CONTEXT AND NONE TAKES A COMPANY ID ──────────
//
// There is no `companyId` parameter anywhere in this module's surface. Not optional, not
// overridable, not "for tests". The company in every statement below is `ctx.companyId`, read off
// a context that src/lib/office/context.js minted from stored state — a run, an objective, an
// authenticated read session, or a mapped scheduled workflow.
//
// That is deliberate and it is the whole isolation design. `dispatch.js` accepts a `companyId`
// string today and that is the hole this system has been closing all week: a string is whatever
// the caller says, and an agent's output is a string. A context cannot be produced by an agent,
// because an agent emits text and text cannot carry a Symbol or an object identity.
//
// So the authorization question for memory is not asked here at all. It was asked when the context
// was resolved, against `user_companies`, through its own accessor. Revoke somebody's membership
// and `resolveCompanyForReadSession` refuses them a context; with no context there is no recall.
// Memory inherits revocation rather than re-implementing it — which is owner requirement 12 of
// B7.8, "the same foundation for memory, tasks, documents and delegation", taken literally.
//
// ── WHY FULL-TEXT SEARCH AND NOT EMBEDDINGS ─────────────────────────────────
//
// The tracker required this decision before any code, and specifically said not to default to
// pgvector. Three reasons it is not pgvector:
//
//  1. pgvector needs `CREATE EXTENSION`, and ENG-003 is in the middle of making the runtime role
//     NOSUPERUSER with no DDL at all. Building recall on a privilege the system is deliberately
//     removing would mean memory works until the security work lands.
//
//  2. An embedding path puts a METERED AI CALL on the write path and on every read. Budget
//     enforcement is real here — the ceiling refuses charges in the UPDATE itself — so memory
//     reads would stop working exactly when a company is busiest, and a memory write could fail
//     for reasons that have nothing to do with memory. Recall must not have a spend precondition.
//
//  3. `to_tsvector` is deterministic, so a test can assert that this query returns that row. A
//     similarity threshold cannot be asserted without pinning a model version, which means the
//     isolation tests below would be measuring the embedding service rather than the company
//     filter. The filter is the thing that must be proved.
//
// If semantic recall is wanted later it belongs BESIDE this, reading the same rows through the
// same accessor, so the company filter is not reimplemented in a second retrieval path.
//
// ── NOTHING HERE DELETES ────────────────────────────────────────────────────
//
// There is no `forget`. A memory is corrected by SUPERSEDING it: the new row carries `supersedes`,
// the old row records when and by what. An agent that can delete its own history can delete the
// evidence of what it did, and this repository has spent too long learning that the dangerous code
// is the cleanup nobody reads. Operators remove rows with a migration, by id, under review.

'use strict';

const crypto = require('node:crypto');

const CTX = require('./context');

/** What a memory IS. A free-text `kind` would become an unqueryable junk drawer within a month. */
const MEMORY_KINDS = Object.freeze([
  'fact',        // something established about the company's world: a lead time, a spec, a contact
  'decision',    // a choice that was made, and is to be honoured until superseded
  'outcome',     // what actually happened when something was tried
  'constraint',  // a standing limit: a budget, a policy, a supplier that may not be used
]);

/**
 * Did somebody STATE this, or did a model CONCLUDE it? The distinction this whole system runs on,
 * and the one that keeps a model's inference from hardening into a company fact.
 */
const CONFIDENCE = Object.freeze(['stated', 'derived']);

/** Columns a caller gets back. `search` is machinery and is never selected. */
const COLS = `id, company_id, kind, subject, body, author, source_run_id, source_objective_id,
              confidence, supersedes, superseded_at, superseded_by, created_at`;

// ── SCHEMA ──────────────────────────────────────────────────────────────────

const DDL = [
  // The composite UNIQUE below exists for one reason: it lets the `supersedes` foreign key be
  // COMPOSITE, so the DATABASE refuses a supersede chain that crosses companies. Without it, the
  // accessor would be the only thing standing between a correction in one company and a row in
  // another — and "the accessor checks it" is the shape of defect this project keeps finding.
  // The engine stops it, not just the caller.
  `CREATE TABLE IF NOT EXISTS agent_memory (
     id                  TEXT PRIMARY KEY,
     company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     kind                TEXT NOT NULL,
     subject             TEXT NOT NULL,
     body                TEXT NOT NULL,
     author              TEXT NOT NULL,
     source_run_id       TEXT,
     source_objective_id TEXT,
     confidence          TEXT NOT NULL DEFAULT 'stated',
     supersedes          TEXT,
     superseded_at       TIMESTAMPTZ,
     superseded_by       TEXT,
     created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     search              TSVECTOR GENERATED ALWAYS AS (
                           to_tsvector('english', subject || ' ' || body)
                         ) STORED,
     CONSTRAINT agent_memory_id_company UNIQUE (id, company_id),
     CONSTRAINT agent_memory_kind_check CHECK (kind IN ('fact','decision','outcome','constraint')),
     CONSTRAINT agent_memory_confidence_check CHECK (confidence IN ('stated','derived')),
     -- A superseded row carries BOTH when and by what, or neither. A half-finished correction must
     -- not be able to leave a row marked stale with no record of what replaced it.
     CONSTRAINT agent_memory_supersession_recorded CHECK (
       (superseded_at IS NULL AND superseded_by IS NULL)
       OR (superseded_at IS NOT NULL AND superseded_by IS NOT NULL)
     ),
     CONSTRAINT agent_memory_not_self CHECK (supersedes IS NULL OR supersedes <> id),
     -- COMPOSITE: a correction must point at a row of the SAME company.
     CONSTRAINT agent_memory_supersedes_same_company
       FOREIGN KEY (supersedes, company_id) REFERENCES agent_memory (id, company_id)
       ON DELETE RESTRICT
   )`,

  // GIN on `search` ALONE, and the company filter is not in it.
  //
  // The first version of this index was `GIN (company_id, search)`, which needs the `btree_gin`
  // extension for the text column — the very `CREATE EXTENSION` dependency this module's header
  // rejects pgvector for. It failed on the first run: "data type text has no default operator
  // class for access method gin".
  //
  // Worth recording why the comment that went with it was also wrong. It said a GIN on `search`
  // alone "would let the planner match across companies and then discard — correct results by
  // subtraction, which is not a property to rely on". That is this project's own defect class in
  // miniature: an index SHAPE standing in for the isolation property. An index never decides which
  // rows a query returns; the WHERE clause does, and the composite foreign key does. Postgres
  // bitmap-ANDs this with the btree indexes below. The index is performance; the guarantee is the
  // predicate, and the check asserts the predicate.
  `CREATE INDEX IF NOT EXISTS agent_memory_search
     ON agent_memory USING GIN (search)`,

  `CREATE INDEX IF NOT EXISTS agent_memory_by_subject
     ON agent_memory (company_id, lower(subject)) WHERE superseded_at IS NULL`,

  `CREATE INDEX IF NOT EXISTS agent_memory_live
     ON agent_memory (company_id, kind, created_at DESC) WHERE superseded_at IS NULL`,

  // ONE CORRECTION PER MEMORY, enforced here rather than in `remember`.
  //
  // This index exists because the first version of this module got it wrong in a way its own test
  // did not catch. `remember` writes the new row and marks the old one in a single CTE, then
  // throws `already_superseded` when the UPDATE matched nothing. But the INSERT had ALREADY
  // COMMITTED, so a refused correction left a live orphan row whose `supersedes` pointed at an
  // already-superseded memory — two live rows claiming to replace the same one, which is exactly
  // the fork the error message said could not happen. The check asserted the ERROR CODE and
  // passed; the leak detector in its cleanup found the row.
  //
  // That is this project's recurring defect in one commit: a measurement — "the right error was
  // thrown" — standing in for the property, "no second correction exists". A thrown error is not a
  // rollback. So the constraint is a unique index: the INSERT itself fails, nothing lands, and the
  // property is true whatever the JavaScript around it does.
  // ── B3.17: ONE LIVE MEMORY PER RUN AND SUBJECT ─────────────────────────────
//
// Owner's Priority 2 of the second directive, 2026-11-25: restart and concurrent ticks must not
// create duplicate memory records. The cycle's REPORT phase writes one memory per completed plan
// step, and until now nothing stopped it writing them twice — which is exactly what happened when
// REPORT re-ran every 15 seconds under the continuous advancement tick. The repair in cycle.js
// reads what the run has already remembered and skips those subjects, and that is a check-then-act:
// two concurrent REPORT phases can both read "not yet" before either writes. This index is the part
// that holds whatever the calling code does.
//
// `superseded_at IS NULL` is what makes it compatible with corrections: superseding marks the old
// row and inserts a new one with the same subject, and only the LIVE row is constrained. Memories
// with no source run (a stated fact, a human's note) are outside the predicate entirely — they are
// not a cycle's bookkeeping and there is no reason one run's worth of them should be unique.
`CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_memory_run_subject
   ON agent_memory (source_run_id, subject)
   WHERE source_run_id IS NOT NULL AND superseded_at IS NULL`,

`CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_one_correction
     ON agent_memory (supersedes) WHERE supersedes IS NOT NULL`,
];

async function migrateMemory(query) {
  for (const stmt of DDL) {
    try {
      await query(stmt);
    } catch (e) {
      // The same narrow set as the office kernel and identity: duplicate object, duplicate table,
      // duplicate column. 42P01 (missing dependency) is NOT ignorable — `companies` must exist
      // before this runs, and a silent skip would produce a system where every recall returns
      // nothing, which reads exactly like "the company has no history".
      if (!['42710', '42P07', '42701'].includes(e.code)) {
        throw new Error(`agent memory schema failed on [${stmt.slice(0, 72).replace(/\s+/g, ' ')}…]: ${e.message}`);
      }
    }
  }
  return { ok: true };
}

// ── INTERNALS ───────────────────────────────────────────────────────────────

function lazyQuery() {
  // Required at call time, not at module load: ten verification harnesses clear require.cache and
  // inject their own query, and a top-level require would bind the pool before they could.
  return require('../db').query;
}

class MemoryRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MemoryRefused';
    this.code = code;
  }
}

/**
 * Every exported function starts here. Two things happen and the order matters: the context is
 * verified to be one this process minted, and only then is a company id read off it. A caller that
 * wants to act for another company has nothing to supply.
 */
function companyOf(ctx) {
  CTX.assertContext(ctx);
  return ctx.companyId;
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MemoryRefused('invalid_field', `${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

// ── WRITE ───────────────────────────────────────────────────────────────────

/**
 * Record something. The company comes from `ctx`; `author` says who is accountable — an agent
 * (`agent:ceo-agent`) or a person (`user:<id>`), never bare.
 *
 * `supersedes` corrects an earlier memory. The old row is marked in the same transaction as the
 * new one is written, so there is no instant at which both are live or neither is.
 */
async function remember(ctx, input = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const query = deps.query || lazyQuery();

  const kind = requireText(input.kind, 'kind');
  if (!MEMORY_KINDS.includes(kind)) {
    throw new MemoryRefused('unknown_kind', `kind must be one of ${MEMORY_KINDS.join(', ')}; got ${kind}`);
  }
  const confidence = input.confidence === undefined ? 'stated' : requireText(input.confidence, 'confidence');
  if (!CONFIDENCE.includes(confidence)) {
    throw new MemoryRefused('unknown_confidence', `confidence must be one of ${CONFIDENCE.join(', ')}`);
  }
  const subject = requireText(input.subject, 'subject');
  const body = requireText(input.body, 'body');
  const author = requireText(input.author, 'author');
  if (!/^(agent|user):.+/.test(author)) {
    throw new MemoryRefused('unattributed',
      `author must name who is accountable as agent:<name> or user:<id>; got "${author}". A memory `
      + 'is something the company will act on, so it carries an author the same way a membership '
      + 'carries granted_by.');
  }

  const id = `mem_${crypto.randomBytes(12).toString('hex')}`;
  const supersedes = input.supersedes ? requireText(input.supersedes, 'supersedes') : null;

  // Provenance. A run id is NOT taken from the input when the context already carries one: the
  // context's run is the one that actually executed, and the input's is whatever the caller typed.
  const sourceRunId = ctx.runId || (input.sourceRunId ? requireText(input.sourceRunId, 'sourceRunId') : null);
  const sourceObjectiveId = ctx.objectiveId || null;

  let rows;
  try {
    rows = await query(
    `WITH inserted AS (
       INSERT INTO agent_memory
         (id, company_id, kind, subject, body, author, source_run_id, source_objective_id,
          confidence, supersedes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLS}
     ), marked AS (
       UPDATE agent_memory
          SET superseded_at = NOW(), superseded_by = $1
        WHERE $10::text IS NOT NULL
          AND id = $10
          AND company_id = $2          -- belt as well as the composite FK's braces
          AND superseded_at IS NULL
       RETURNING id
     )
     SELECT ${COLS}, (SELECT count(*)::int FROM marked) AS marked FROM inserted`,
    [id, companyId, kind, subject, body, author, sourceRunId, sourceObjectiveId, confidence, supersedes],
    );
  } catch (e) {
    // 23505 on agent_memory_one_correction: something already supersedes that memory. The INSERT
    // failed, so nothing landed — which is the difference between this and the version that threw
    // after a successful write. See the index's comment.
    if (e && e.code === '23505' && /one_correction/.test(e.constraint || e.message || '')) {
      throw new MemoryRefused('already_superseded',
        `${supersedes} has already been superseded. Correct the CURRENT memory for that subject, `
        + 'not a historical one, or the chain forks and recall has two answers.');
    }
    // 23503 on the composite FK: the target does not exist IN THIS COMPANY. Reported as a missing
    // target rather than a cross-company refusal, because telling a caller "that id belongs to
    // another company" confirms the row exists, which is itself a cross-tenant disclosure.
    if (e && e.code === '23503' && /supersedes_same_company/.test(e.constraint || e.message || '')) {
      throw new MemoryRefused('no_such_memory',
        `${supersedes} is not a memory of this company.`);
    }
    throw e;
  }

  const row = rows.rows[0];
  if (supersedes && row.marked === 0) {
    // Defence in depth. The unique index above makes this unreachable for the fork case and the
    // composite FK covers a missing target, so a zero here means a state nothing predicted — worth
    // refusing loudly rather than returning a memory whose predecessor was never marked.
    throw new MemoryRefused('supersede_not_applied',
      `wrote ${id} but did not mark ${supersedes} as superseded; refusing to report a correction `
      + 'that only half happened');
  }
  return shape(row);
}

// ── READ ────────────────────────────────────────────────────────────────────

/**
 * Keyword recall, ranked. Company-scoped by construction; superseded rows are excluded unless
 * `includeSuperseded` is asked for explicitly, because an agent acting on a corrected memory is
 * the failure this table exists to prevent.
 */
async function recall(ctx, { query: text, kind = null, limit = 10, includeSuperseded = false } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const q = deps.query || lazyQuery();
  const needle = requireText(text, 'query');
  const n = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 10;

  const rows = await q(
    `SELECT ${COLS}, ts_rank(search, websearch_to_tsquery('english', $2)) AS rank
       FROM agent_memory
      WHERE company_id = $1
        AND search @@ websearch_to_tsquery('english', $2)
        AND ($3::text IS NULL OR kind = $3)
        AND ($4::boolean OR superseded_at IS NULL)
      ORDER BY rank DESC, created_at DESC
      LIMIT $5`,
    [companyId, needle, kind, includeSuperseded, n],
  );
  return rows.rows.map(shape);
}

/**
 * The current memory for an exact subject. `recall` is for questions; this is for "what did we
 * decide about X" where X is a key the caller already holds.
 */
async function recallSubject(ctx, { subject } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const q = deps.query || lazyQuery();
  const key = requireText(subject, 'subject');
  const rows = await q(
    `SELECT ${COLS} FROM agent_memory
      WHERE company_id = $1 AND lower(subject) = lower($2) AND superseded_at IS NULL
      ORDER BY created_at DESC`,
    [companyId, key],
  );
  return rows.rows.map(shape);
}

/**
 * One memory by id.
 *
 * `AND company_id = $2` is the single most important clause in this file. A get-by-id that filters
 * on the id alone is a cross-company read with a primary-key index on it, and an id is exactly the
 * kind of value that travels — in an audit row, a log line, an agent's own previous output. The
 * isolation test suite asserts this specific query refuses a known id from another company.
 */
async function getMemory(ctx, { id } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const q = deps.query || lazyQuery();
  const key = requireText(id, 'id');
  const rows = await q(
    `SELECT ${COLS} FROM agent_memory WHERE id = $1 AND company_id = $2`,
    [key, companyId],
  );
  return rows.rows.length ? shape(rows.rows[0]) : null;
}

/** What this company remembers, newest first. For a briefing's "what do we know" section. */
async function timeline(ctx, { kind = null, limit = 50, includeSuperseded = false } = {}, deps = {}) {
  const companyId = companyOf(ctx);
  const q = deps.query || lazyQuery();
  const n = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
  const rows = await q(
    `SELECT ${COLS} FROM agent_memory
      WHERE company_id = $1
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::boolean OR superseded_at IS NULL)
      ORDER BY created_at DESC LIMIT $4`,
    [companyId, kind, includeSuperseded, n],
  );
  return rows.rows.map(shape);
}

function shape(r) {
  return Object.freeze({
    id: r.id,
    companyId: r.company_id,
    kind: r.kind,
    subject: r.subject,
    body: r.body,
    author: r.author,
    sourceRunId: r.source_run_id,
    sourceObjectiveId: r.source_objective_id,
    confidence: r.confidence,
    supersedes: r.supersedes,
    supersededAt: r.superseded_at,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
  });
}

module.exports = {
  migrateMemory,
  remember,
  recall,
  recallSubject,
  getMemory,
  timeline,
  MEMORY_KINDS,
  CONFIDENCE,
  MemoryRefused,
  DDL,
  MEMORY_TABLES: Object.freeze(['agent_memory']),
};
