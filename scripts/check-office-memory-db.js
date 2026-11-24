#!/usr/bin/env node
// ── COMPANY-ISOLATED AGENT MEMORY, PROVED AGAINST A REAL SERVER (B3.1) ──────
//
//   node scripts/check-office-memory-db.js   exit 0 = every ruled property holds
//                                            exit 3 = NOT EXECUTED (no Postgres available)
//
// B3.1 is persistent agent memory for a multi-company operating system. The requirement that
// decides whether it is safe is isolation: a memory written for ABIOZEN must be unreachable from
// Adifice, and the owner's B7.8 ruling says memory must use the SAME authorization foundation —
// "do not introduce competing identity or company authorization systems".
//
// Almost nothing below can be proved with a stubbed query. "A known id from another company
// returns nothing" is a claim about a WHERE clause; "the database refuses a supersede chain across
// companies" is a claim about a composite foreign key. A unit test with a fake `query` would be
// asserting that my own stub filters the way I think the SQL does, which is the defect this
// project has found ~60 times: a measurement standing in for the property.
//
// NO URL OVERRIDE, for the reason in check-company-membership-db.js: this INSERTs and DELETEs in
// `users`, `companies` and `agent_memory`. A script that can only reach a cluster it created
// cannot have the 2026-09-30 accident where "it will be refused anyway" turned out to be a
// prediction rather than a safeguard. Fixtures are recorded and removed BY ID regardless.

'use strict';

const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};

const DISPOSABLE = require('./lib/pg-disposable');

let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'memory' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  agent memory not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
const url = cluster.url;
const stopTemp = () => cluster.destroy();
process.env.DATABASE_URL = url;

// Fixture bootstrap values for a cluster created seconds ago on a unix socket in a temp directory,
// destroyed on the way out. initDB refuses to finish without an admin, and letting it run means
// `users` is the REAL table from src/lib/db.js rather than a hand-copied DDL that would drift.
process.env.ADMIN_EMAIL = 'memchk-bootstrap@memchk.invalid';
process.env.ADMIN_PASSWORD = `memchk-${require('node:crypto').randomBytes(16).toString('hex')}`;

// Silence is the one verdict a verifier must never produce.
const WATCHDOG_MS = Number(process.env.MEMORY_CHECK_TIMEOUT_MS || 180_000);
const watchdog = setTimeout(() => {
  console.log(`\n  FAIL  the check made no progress in ${Math.round(WATCHDOG_MS / 1000)}s and was `
    + 'stopped. A stall is a failure, not a pass.');
  try { stopTemp(); } catch (_) {}
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

const EARLIER = new Date('2026-11-01T00:00:00Z');

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };
  const made = { users: [], companies: [], memberships: [], memories: [] };

  try {
    await require('../src/lib/db').initDB();                       // users
    await require('../src/lib/runs').migrateRuns(q);               // agent_runs
    await require('../src/lib/office/schema').migrateOffice(q);    // companies, objectives
    await require('../src/lib/identity/schema').migrateIdentity(q);// user_companies
    const MEM = require('../src/lib/office/memory');
    await MEM.migrateMemory(q);
    console.log('  ..    schema up');

    const CTX = require('../src/lib/office/context');
    const MBR = require('../src/lib/identity/company-membership');

    // ── THE TABLE AND THE CONSTRAINTS THAT CARRY THE GUARANTEES ────────────
    const cols = (await q(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_memory'`))
      .rows.map((r) => r.column_name);
    const required = ['company_id', 'kind', 'subject', 'body', 'author', 'confidence',
      'supersedes', 'superseded_at', 'superseded_by', 'source_run_id', 'search'];
    const missingCols = required.filter((c) => !cols.includes(c));
    if (!missingCols.length) ok('agent_memory carries every ruled column, including the tsvector');
    else bad('agent_memory is missing ruled columns', missingCols);

    const notNull = (await q(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'agent_memory' AND column_name = 'company_id'`)).rows[0];
    if (notNull && notNull.is_nullable === 'NO') ok('company_id is NOT NULL — a memory cannot exist outside a company');
    else bad('company_id is nullable', notNull);

    const cons = (await q(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'agent_memory'::regclass`))
      .rows.map((r) => r.conname);
    for (const name of ['agent_memory_supersedes_same_company', 'agent_memory_id_company',
      'agent_memory_supersession_recorded', 'agent_memory_not_self', 'agent_memory_kind_check']) {
      if (cons.includes(name)) ok(`constraint ${name} is present`);
      else bad(`constraint ${name} is absent — the guarantee rests on the accessor alone`, cons);
    }

    try {
      await MEM.migrateMemory(q);
      const n = (await q(
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name = 'agent_memory'`))
        .rows[0].n;
      if (n === 1) ok('migration is repeatable — applying it twice leaves exactly one table');
      else bad('re-running the migration did not leave one table', n);
    } catch (e) {
      bad('re-running the migration threw — it is not idempotent', e && e.message);
    }

    // ── FIXTURES ───────────────────────────────────────────────────────────
    const mkCompany = async (slug) => {
      const id = `memchk-co-${slug}`;
      await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$2,$3,'active')`,
        [id, `memchk-${slug}`, `MemChk ${slug}`]);
      made.companies.push(id);
      return id;
    };
    const mkUser = async (handle, role = 'admin', active = 1) => {
      const id = `memchk-u-${handle}`;
      await q(`INSERT INTO users (id, email, name, role, is_active) VALUES ($1,$2,$3,$4,$5)`,
        [id, `${handle}@memchk.invalid`, handle, role, active]);
      made.users.push(id);
      return id;
    };
    const owner = await mkUser('owner', 'super_admin');
    const grant = async (userId, companyId) => {
      const row = await MBR.grantMembership({
        userId, companyId, companyRole: 'admin', grantedBy: owner,
        grantedReason: 'fixture', effectiveFrom: EARLIER, effectiveTo: null,
      }, deps);
      made.memberships.push(row.id);
      return row;
    };

    const abiozen = await mkCompany('abiozen');
    const adifice = await mkCompany('adifice');

    // Contexts through the TEST-ONLY door, which scripts/check-test-context-usage.js confines to
    // tests and checks. What is being verified here is the company filter, not the resolver —
    // resolution itself is proved further down, through a real membership lookup.
    const ctxA = CTX.contextForTests__TEST_ONLY({ companyId: abiozen });
    const ctxB = CTX.contextForTests__TEST_ONLY({ companyId: adifice });

    const remember = async (ctx, input) => {
      const row = await MEM.remember(ctx, input, deps);
      made.memories.push(row.id);
      return row;
    };

    // ── REQ: A CONTEXT IS REQUIRED, AND A SHAPE IS NOT A CONTEXT ───────────
    //
    // This is the substitution attack, at the memory boundary rather than the email one. If a
    // frozen object with a companyId were accepted, an agent's output could choose the company
    // whose memory it writes to and reads from.
    const forged = [
      ['a plain frozen object with a companyId', Object.freeze({ companyId: abiozen })],
      ['a COPY of a real context with the company changed', Object.freeze({ ...ctxA, companyId: adifice })],
      ['a COPY of a real context changing nothing', Object.freeze({ ...ctxA })],
      ['a prototype-inheriting object', Object.freeze(Object.create(ctxA))],
      ['a JSON round-trip of a real context', Object.freeze(JSON.parse(JSON.stringify(ctxA)))],
      ['a bare company id string', abiozen],
    ];
    for (const [label, candidate] of forged) {
      let refused = false;
      try {
        await MEM.remember(candidate, {
          kind: 'fact', subject: 'forged', body: 'forged', author: 'agent:attacker',
        }, deps);
      } catch (e) { refused = e && e.name === 'NoCompanyContext'; }
      if (refused) ok(`REFUSED as a company context: ${label}`);
      else bad(`ACCEPTED as a company context: ${label} — memory's company is caller-chosen`, label);
    }
    for (const [label, candidate] of forged) {
      let refused = false;
      try { await MEM.recall(candidate, { query: 'anything' }, deps); } catch (e) {
        refused = e && e.name === 'NoCompanyContext';
      }
      if (refused) ok(`recall REFUSES ${label}`);
      else bad(`recall ACCEPTED ${label} — the read path is a second road into the table`, label);
    }

    // ── REQ: A MEMORY LANDS IN THE CONTEXT'S COMPANY ───────────────────────
    const a1 = await remember(ctxA, {
      kind: 'decision', subject: 'supplier lead time policy',
      body: 'Quote eight weeks on hydrochlorothiazide until Palash confirms the Hyderabad route.',
      author: 'agent:procurement-agent',
    });
    if (a1.companyId === abiozen) ok('a memory lands in the company the context resolved, not one the caller named');
    else bad('company_id does not match the context', a1.companyId);

    const b1 = await remember(ctxB, {
      kind: 'decision', subject: 'supplier lead time policy',
      body: 'Adifice quotes four weeks on every development engagement.',
      author: 'agent:sales-agent',
    });

    // ── REQ: THE CENTRAL ISOLATION PROPERTY ────────────────────────────────
    const recalledA = await MEM.recall(ctxA, { query: 'supplier lead time' }, deps);
    const recalledB = await MEM.recall(ctxB, { query: 'supplier lead time' }, deps);
    if (recalledA.length === 1 && recalledA[0].id === a1.id) {
      ok('recall returns this company\'s memory');
    } else bad('recall did not return the expected single memory', recalledA.map((r) => r.id));
    if (recalledB.length === 1 && recalledB[0].id === b1.id) {
      ok('the other company recalls ITS memory — same subject, different answer, no bleed');
    } else bad('cross-company recall is wrong', recalledB.map((r) => r.id));
    if (!recalledA.some((r) => r.id === b1.id) && !recalledB.some((r) => r.id === a1.id)) {
      ok('neither company\'s recall contains the other\'s row');
    } else bad('recall crossed companies');

    // ── REQ: THE SHARP EDGE — GET BY A KNOWN ID FROM ANOTHER COMPANY ───────
    //
    // An id travels: into audit rows, log lines, an agent's own previous output. A get-by-id that
    // filters on the id alone is a cross-company read with a primary-key index on it.
    const stolen = await MEM.getMemory(ctxB, { id: a1.id }, deps);
    if (stolen === null) ok('getMemory with a KNOWN id from another company returns nothing');
    else bad('getMemory leaked a row across companies by id', stolen && stolen.id);
    const own = await MEM.getMemory(ctxA, { id: a1.id }, deps);
    if (own && own.id === a1.id) ok('getMemory still returns the row to its own company');
    else bad('getMemory refused a legitimate read', own);

    const subjA = await MEM.recallSubject(ctxA, { subject: 'SUPPLIER LEAD TIME POLICY' }, deps);
    if (subjA.length === 1 && subjA[0].id === a1.id) ok('recallSubject is case-insensitive and company-scoped');
    else bad('recallSubject is wrong', subjA.map((r) => r.id));

    const tlB = await MEM.timeline(ctxB, {}, deps);
    if (tlB.length === 1 && tlB[0].id === b1.id) ok('timeline shows only this company\'s history');
    else bad('timeline crossed companies', tlB.map((r) => r.id));

    // ── REQ: THE DATABASE REFUSES A CROSS-COMPANY CORRECTION ───────────────
    //
    // Raw SQL, deliberately going around the accessor. If this insert succeeds, the guarantee
    // rests on JavaScript that a future caller can bypass — "the engine stops it, not just the
    // caller" is the standard this repository already holds its budget ceiling to.
    let fkRefused = false;
    try {
      await q(
        `INSERT INTO agent_memory (id, company_id, kind, subject, body, author, supersedes)
         VALUES ($1, $2, 'fact', 'cross-company correction', 'body', 'agent:attacker', $3)`,
        ['memchk-crosscompany', adifice, a1.id],
      );
      made.memories.push('memchk-crosscompany');
    } catch (e) { fkRefused = e && e.code === '23503'; }
    if (fkRefused) ok('the DATABASE refuses a supersede chain that crosses companies (composite FK)');
    else bad('a cross-company supersede was accepted by the database itself');

    let selfRefused = false;
    try {
      await q(
        `INSERT INTO agent_memory (id, company_id, kind, subject, body, author, supersedes)
         VALUES ($1, $2, 'fact', 's', 'b', 'agent:x', $1)`, ['memchk-self', abiozen]);
      made.memories.push('memchk-self');
    } catch (e) { selfRefused = e && e.code === '23514'; }
    if (selfRefused) ok('a memory cannot supersede itself');
    else bad('self-supersession was accepted');

    let halfRefused = false;
    try {
      await q(`UPDATE agent_memory SET superseded_at = NOW() WHERE id = $1`, [a1.id]);
    } catch (e) { halfRefused = e && e.code === '23514'; }
    if (halfRefused) ok('a row cannot be marked superseded without recording BY WHAT');
    else bad('a half-finished correction left a row stale with no replacement recorded');

    // ── REQ: CORRECTION REPLACES, AND NOTHING IS DELETED ───────────────────
    const a2 = await remember(ctxA, {
      kind: 'decision', subject: 'supplier lead time policy',
      body: 'Six weeks confirmed on the Hyderabad route.',
      author: 'user:memchk-u-owner', supersedes: a1.id,
    });
    const afterA = await MEM.recall(ctxA, { query: 'lead time' }, deps);
    if (afterA.length === 1 && afterA[0].id === a2.id) {
      ok('after a correction, recall returns the NEW memory only');
    } else bad('recall after correction is wrong', afterA.map((r) => r.id));
    const old = await MEM.getMemory(ctxA, { id: a1.id }, deps);
    if (old && old.supersededBy === a2.id && old.supersededAt) {
      ok('the superseded memory is KEPT, and records when and by what');
    } else bad('the old memory was lost or not marked', old);
    const withHistory = await MEM.recall(ctxA, { query: 'lead time', includeSuperseded: true }, deps);
    if (withHistory.length === 2) ok('history is retrievable when explicitly asked for');
    else bad('history is not retrievable', withHistory.length);

    // THE ERROR CODE IS NOT THE PROPERTY. The first version of this module threw
    // `already_superseded` from a CTE whose INSERT had already committed, so the refused
    // correction left a live orphan row pointing at a1 — the fork, with the right error on top of
    // it. This asserts the code AND counts the rows, and the row count is the assertion that
    // matters.
    const beforeFork = (await q(
      `SELECT COUNT(*)::int n FROM agent_memory WHERE supersedes = $1`, [a1.id])).rows[0].n;
    let forkCode = null;
    try {
      await MEM.remember(ctxA, {
        kind: 'decision', subject: 'forked correction', body: 'b', author: 'agent:x', supersedes: a1.id,
      }, deps);
    } catch (e) { forkCode = e && e.code; }
    const afterFork = (await q(
      `SELECT COUNT(*)::int n FROM agent_memory WHERE supersedes = $1`, [a1.id])).rows[0].n;
    if (forkCode === 'already_superseded') ok('correcting an ALREADY-superseded memory is refused');
    else bad('a second correction was not refused as already_superseded', forkCode);
    if (afterFork === beforeFork && beforeFork === 1) {
      ok('and NOTHING was written — exactly one row supersedes a1, so the chain cannot fork');
    } else {
      bad('the refusal left a row behind — a thrown error is not a rollback',
        { beforeFork, afterFork });
    }
    const orphan = (await q(
      `SELECT id FROM agent_memory WHERE subject = 'forked correction'`)).rows;
    if (!orphan.length) ok('the refused correction left no orphan memory in the table');
    else { made.memories.push(...orphan.map((r) => r.id)); bad('an orphan row was committed', orphan.map((r) => r.id)); }

    // The accessor's own cross-company refusal, which must not confirm the row exists elsewhere.
    let crossCode = null;
    try {
      await MEM.remember(ctxB, {
        kind: 'fact', subject: 'cross', body: 'b', author: 'agent:x', supersedes: a2.id,
      }, deps);
    } catch (e) { crossCode = e && e.code; }
    if (crossCode === 'no_such_memory') {
      ok('superseding another company\'s memory is refused as NOT FOUND — no cross-tenant disclosure');
    } else bad('a cross-company supersede through the accessor was not refused as no_such_memory', crossCode);

    if (typeof MEM.forget === 'undefined' && typeof MEM.deleteMemory === 'undefined') {
      ok('the accessor exposes no delete — an agent cannot remove the record of what it did');
    } else bad('a delete path exists on the memory accessor');

    // ── REQ: ATTRIBUTION AND VOCABULARY ───────────────────────────────────
    for (const [label, input, code] of [
      ['an unattributed author', { kind: 'fact', subject: 's', body: 'b', author: 'somebody' }, 'unattributed'],
      ['an invented kind', { kind: 'vibe', subject: 's', body: 'b', author: 'agent:x' }, 'unknown_kind'],
      ['an invented confidence', { kind: 'fact', subject: 's', body: 'b', author: 'agent:x', confidence: 'certain' }, 'unknown_confidence'],
      ['an empty body', { kind: 'fact', subject: 's', body: '   ', author: 'agent:x' }, 'invalid_field'],
    ]) {
      let got = null;
      try { await MEM.remember(ctxA, input, deps); } catch (e) { got = e && e.code; }
      if (got === code) ok(`REFUSED: ${label}`);
      else bad(`${label} was not refused as ${code}`, got);
    }

    const derived = await remember(ctxA, {
      kind: 'fact', subject: 'inferred demand', body: 'Demand looks seasonal.',
      author: 'agent:sales-agent', confidence: 'derived',
    });
    if (derived.confidence === 'derived') {
      ok('a model\'s CONCLUSION is stored as derived, not as a company fact');
    } else bad('confidence was not recorded', derived.confidence);

    // ── REQ: THE SAME FOUNDATION AS B7.8 — REVOCATION CLOSES RECALL ────────
    //
    // The composition that owner requirement 12 asks for. Memory holds no membership logic at all;
    // it refuses because the RESOLVER refuses, which means revocation cannot be forgotten here.
    const reader = await mkUser('reader');
    await grant(reader, abiozen);
    const live = await CTX.resolveCompanyForReadSession(
      { userId: reader, requestedCompanyId: abiozen }, deps);
    const readerRecall = await MEM.recall(live, { query: 'lead time' }, deps);
    if (readerRecall.length === 1) ok('an active member resolves a context and recalls the company\'s memory');
    else bad('an active member could not recall', readerRecall.length);

    await MBR.revokeMembership({
      userId: reader, companyId: abiozen, revokedBy: owner, revokedReason: 'fixture: departure',
    }, deps);
    let noContext = false;
    try {
      await CTX.resolveCompanyForReadSession({ userId: reader, requestedCompanyId: abiozen }, deps);
    } catch (e) { noContext = e && e.name === 'NoCompanyContext'; }
    if (noContext) {
      ok('after revocation there is NO context — so there is no recall, with no check in memory.js');
    } else bad('a revoked member still resolved a read context');

    // ── REQ: PROVENANCE COMES FROM THE CONTEXT, NOT THE INPUT ──────────────
    const runCtx = CTX.deriveContext(ctxA, { runId: 'memchk-run-real' });
    const provenanced = await remember(runCtx, {
      kind: 'outcome', subject: 'rfq attempt', body: 'Refused at the gate.',
      author: 'agent:procurement-agent', sourceRunId: 'memchk-run-claimed',
    });
    if (provenanced.sourceRunId === 'memchk-run-real') {
      ok('provenance is the run that ACTUALLY executed, not the one the caller typed');
    } else bad('the caller\'s claimed run id won', provenanced.sourceRunId);

    let derivedCrossCompany = false;
    try { CTX.deriveContext(ctxA, { companyId: adifice }); } catch (e) {
      derivedCrossCompany = e && e.name === 'NoCompanyContext';
    }
    if (derivedCrossCompany) ok('a derived context still cannot change company');
    else bad('deriveContext changed the company');
  } catch (e) {
    bad('the check threw', e && (e.stack || e.message));
  } finally {
    // CLEANUP: only what this script created, by explicit id. Never by timestamp, never by
    // pattern, never "recent" — and the table is never asserted empty, only that MY fixtures are
    // gone. The cluster is disposable, and the discipline still applies.
    try {
      // Break the supersede chain first: the composite FK is ON DELETE RESTRICT, so a corrected
      // memory still points at the one it replaced. Errors are REPORTED, not swallowed — a silent
      // catch here is how a leak becomes invisible, and a leaking verification is the thing that
      // pressures the next person toward a wider DELETE.
      const trouble = [];
      for (const id of made.memories) {
        try { await q(`UPDATE agent_memory SET supersedes = NULL WHERE id = $1`, [id]); } catch (e) {
          trouble.push(`unlink ${id}: ${e.message}`);
        }
      }
      for (const id of made.memories) {
        try { await q(`DELETE FROM agent_memory WHERE id = $1`, [id]); } catch (e) {
          trouble.push(`delete ${id}: ${e.message}`);
        }
      }
      if (trouble.length) console.log(`  --    cleanup trouble: ${trouble.join(' | ')}`);
      for (const id of made.memberships) await q(`DELETE FROM user_companies WHERE id = $1`, [id]).catch(() => {});
      for (const id of made.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]).catch(() => {});
      for (const id of made.users) await q(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
      const mine = (await q(
        `SELECT COUNT(*)::int n FROM agent_memory WHERE id = ANY($1)`, [made.memories])).rows[0].n;
      if (mine === 0) ok('cleanup: my fixtures are gone');
      else bad('cleanup leaked fixtures', mine);
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    stopTemp();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  agent memory does not hold every ruled property.');
    process.exit(1);
  }
  console.log('\nPASS  B3.1: memory is persistent, attributed, correctable without deletion, and '
    + 'isolated per company — by the context it demands, by the WHERE clause on every read, and '
    + 'by the database itself.');
  process.exit(0);
})();
