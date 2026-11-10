// ── THE SEVEN SOURCES ────────────────────────────────────────────────────────
//
//   node --test src/lib/office/decision-sources.test.js
//
// These run against a fake query function. What is asserted is not SQL correctness — the
// Postgres-backed checks cover that — but the three things that would make this surface harmful
// rather than merely wrong:
//
//   1. a read that is wider than the page it aggregates (another company's approvals, another
//      person's task list),
//   2. a cap that trims the list silently, so "12 waiting" is shown while 400 are,
//   3. urgency invented from a date nobody confirmed.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const S = require('./decision-sources');
const Q = require('./decision-queue');

const NOW = new Date('2026-11-10T00:00:00Z');
const TODAY = '2026-11-10';

// The frozen context scope.js's accessors require, and a stand-in for the ONE accessor this module
// is allowed to reach office_approvals through. Injected rather than stubbed on the real module, so
// these tests cannot accidentally pass against a hand-written kernel predicate.
const CTX = Object.freeze({ companyId: 'co-abiozen', objectiveId: null, source: 'read_session' });
const fakeApprovals = (rows) => {
  const seen = [];
  const fn = async (ctx, deps) => { seen.push({ ctx, deps }); return rows; };
  fn.seen = seen;
  return fn;
};

// A fake query that records every call and answers from a scripted list.
function fakeQuery(answers) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    const key = Object.keys(answers).find((k) => new RegExp(k, 'i').test(sql));
    if (key === undefined) throw new Error(`no scripted answer for: ${sql.slice(0, 60)}`);
    const a = answers[key];
    if (a instanceof Error) throw a;
    return { rows: a };
  };
  fn.calls = calls;
  return fn;
}

// ── SCOPING ─────────────────────────────────────────────────────────────────

test('the approvals read goes through the kernel accessor, not its own SQL', async () => {
  // office_approvals is a kernel table: every predicate on one lives in src/lib/office/scope.js.
  // The first version of this module wrote its own SELECT and the scope-discipline check refused
  // it — "a predicate written at the call site is a predicate somebody can forget", and a forgotten
  // company_id here would show one tenant another's held actions.
  const listPendingApprovals = fakeApprovals([]);
  await S.pendingApprovals(null, { ctx: CTX, listPendingApprovals });
  assert.strictEqual(listPendingApprovals.seen.length, 1, 'the accessor was not called');
  assert.strictEqual(listPendingApprovals.seen[0].ctx, CTX,
    'the frozen company context was not passed, so the accessor would refuse');

  const src = require('node:fs').readFileSync(require.resolve('./decision-sources'), 'utf8');
  assert.ok(!/FROM\s+office_approvals/i.test(src),
    'this module names a kernel table in SQL again');
});

test('review tasks are company-scoped too', async () => {
  const q = fakeQuery({ 'FROM review_tasks': [] });
  await S.openReviewTasks(q, { companyId: 'co-abiozen' });
  assert.match(q.calls[0].sql, /company_id = \$1/);
  assert.deepStrictEqual(q.calls[0].params, ['co-abiozen']);
});

test('a task list is filtered to the asking person, never to everyone', async () => {
  // A cross-tier screen showing one person every other person's assigned work would be a widened
  // read dressed up as a convenience.
  const q = fakeQuery({ 'FROM daily_tasks': [] });
  await S.myTasks(q, { userId: 'u-naren', today: TODAY });
  assert.match(q.calls[0].sql, /user_id = \$1/);
  assert.deepStrictEqual(q.calls[0].params, ['u-naren', TODAY]);
});

// ── THE CAP MUST ANNOUNCE ITSELF ────────────────────────────────────────────

test('a capped list says it is capped', async () => {
  const rows = Array.from({ length: S.CAP + 1 }, (_, i) => ({
    id: `i${i}`, buyer_name: 'A buyer', status: 'new', created_at: '2026-11-01',
  }));
  const q = fakeQuery({ 'FROM inquiries': rows });
  const r = await S.awaitingBuyers(q);

  assert.strictEqual(r.items.length, S.CAP, 'the cap was not applied');
  assert.ok(r.note, 'CAP + 1 rows came back and nothing said the list was trimmed');
  assert.match(r.note, /capped/);
  assert.match(r.note, /floor/, 'the note does not say the count is a floor');
});

test('an uncapped list says nothing', async () => {
  // Negative control: if `note` were always set, the assertion above would pass while every list
  // carried a false warning.
  const q = fakeQuery({ 'FROM inquiries': [{ id: 'a', buyer_name: 'B', status: 'new', created_at: '2026-11-01' }] });
  const r = await S.awaitingBuyers(q);
  assert.strictEqual(r.note, null);
});

test('every source asks for CAP + 1 so it can detect its own overflow', async () => {
  // A source that asks for exactly CAP cannot tell a full page from a complete one.
  const q = fakeQuery({
    'FROM review_tasks': [], 'FROM daily_tasks': [],
    'FROM inquiries': [], 'FROM approval_queue': [], 'FROM performance_scores': [],
  });
  // office_approvals is excluded: it reads through the kernel accessor, which returns the full set,
  // so its cap is applied in JavaScript and its overflow is measured from rows.length. The test
  // below covers that path.
  await S.openReviewTasks(q, { companyId: 'c' });
  await S.myTasks(q, { userId: 'u', today: TODAY });
  await S.awaitingBuyers(q);
  await S.pendingAgentActions(q);
  await S.escalations(q, { today: TODAY });
  assert.strictEqual(q.calls.length, 5, 'a SQL-writing source was added or removed');
  for (const c of q.calls) {
    assert.match(c.sql, new RegExp(`LIMIT ${S.CAP + 1}\\b`),
      `a source does not ask for CAP + 1, so it cannot report overflow: ${c.sql.slice(0, 70)}`);
  }
});

// ── WHAT COUNTS AS SOMEBODY WAITING ─────────────────────────────────────────

test('an approval and a buyer block; an agent proposal and a task do not', async () => {
  const q = fakeQuery({
    'FROM inquiries': [{ id: 'q1', buyer_name: 'Rita', status: 'new', created_at: '2026-11-02' }],
    'FROM approval_queue': [{ id: 'g1', agent_name: 'sales', action_type: 'draft', created_at: '2026-11-03' }],
    'FROM daily_tasks': [{ id: 't1', task_title: 'Call back', created_at: '2026-11-04' }],
  });
  const approvals = fakeApprovals([{ id: 'a1', action_kind: 'supplier_email', reason: 'r', created_at: '2026-11-01' }]);

  assert.strictEqual((await S.pendingApprovals(null, { ctx: CTX, listPendingApprovals: approvals }))
    .items[0].blocks_external, true);
  assert.strictEqual((await S.awaitingBuyers(q)).items[0].blocks_external, true);

  // approval_queue rows are a record of things ALREADY DONE — the orchestrator sends and then
  // enqueues. Marking them as blocking would push real blockers down the list.
  assert.strictEqual((await S.pendingAgentActions(q)).items[0].blocks_external, false);
  assert.strictEqual((await S.myTasks(q, { userId: 'u', today: TODAY })).items[0].blocks_external, false);
});

test('an approval item carries the reason the approver is meant to read', async () => {
  const listPendingApprovals = fakeApprovals([{
    id: 'a1', action_kind: 'supplier_email', reason: 'first contact with Hetero', created_at: '2026-11-01',
  }]);
  const { items } = await S.pendingApprovals(null, { ctx: CTX, listPendingApprovals });
  assert.strictEqual(items[0].detail, 'first contact with Hetero');
});

// ── NO INVENTED URGENCY ─────────────────────────────────────────────────────

test('an UNCONFIRMED closing date is not used as a deadline', async () => {
  // 20 of 21 board rows have an unconfirmed deadline. Ranking them as "closes in 4 days" on a date
  // nobody verified would put invented urgency at the very top of the list.
  const buildBoard = async () => ({
    opportunities: [
      { id: 'o1', title: 'Confirmed', agency: 'VA', response_deadline: '2026-11-14',
        deadline_confirmed: true, advice: { verdict: 'PREPARE', headline: 'h', blocked_by: [] } },
      { id: 'o2', title: 'Unconfirmed', agency: 'VA', response_deadline: '2026-11-12',
        deadline_confirmed: false, advice: { verdict: 'PREPARE', headline: 'h', blocked_by: [] } },
    ],
  });
  const { items } = await S.actionableContracts(null, { companyId: 'c', now: NOW, buildBoard });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.strictEqual(byId['contract:o1'].deadline, '2026-11-14');
  assert.strictEqual(byId['contract:o2'].deadline, null,
    'an unconfirmed closing date was used as a deadline');
});

test('only BID NOW and PREPARE reach the queue — WATCH and SKIP do not', async () => {
  const verdicts = ['BID NOW', 'PREPARE', 'WATCH', 'SKIP'];
  const buildBoard = async () => ({
    opportunities: verdicts.map((v, i) => ({
      id: `o${i}`, title: v, deadline_confirmed: false,
      advice: { verdict: v, headline: 'h', blocked_by: [] },
    })),
  });
  const { items } = await S.actionableContracts(null, { companyId: 'c', now: NOW, buildBoard });
  assert.deepStrictEqual(items.map((i) => i.title), ['BID NOW: BID NOW', 'PREPARE: PREPARE']);
});

test('the board source calls buildBoard rather than querying the tracker itself', async () => {
  // The guard against a second definition of "needs action". If this source ever grew its own
  // SELECT, the queue and the board would start disagreeing about the same notice.
  const src = require('node:fs').readFileSync(require.resolve('./decision-sources'), 'utf8');
  const fn = src.slice(src.indexOf('async function actionableContracts'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
  assert.ok(!/SELECT/i.test(body),
    'actionableContracts contains its own SELECT — it must go through board.buildBoard');
  assert.match(body, /buildBoard\(/);
});

// ── THE WHOLE SET, THROUGH THE AGGREGATOR ───────────────────────────────────

test('sourcesFor wires all seven, and one broken table does not empty the queue', async () => {
  const notes = [];
  const q = fakeQuery({
    'FROM inquiries': [{ id: 'q1', buyer_name: 'Rita', status: 'new', created_at: '2026-11-02' }],
    'FROM review_tasks': new Error('relation "review_tasks" does not exist'),
    'FROM approval_queue': [],
    'FROM daily_tasks': [{ id: 't1', task_title: 'Call back', created_at: '2026-11-04' }],
    'FROM performance_scores': [],
  });
  const buildBoard = async () => ({ opportunities: [] });

  const sources = S.sourcesFor(q, {
    ctx: CTX, companyId: 'c', userId: 'u', today: TODAY, now: NOW, buildBoard, notes,
    listPendingApprovals: fakeApprovals([
      { id: 'a1', action_kind: 'supplier_email', reason: 'r', created_at: '2026-11-01' }]),
  });
  assert.strictEqual(sources.length, 7, 'a source was added or removed without updating this test');

  const r = await Q.collect(sources, { now: NOW });
  assert.strictEqual(r.count, 3, 'the healthy sources did not all survive a broken one');
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.degraded.map((d) => d.source), ['review_tasks']);
  assert.match(r.degraded[0].error, /does not exist/);

  // The two blocking items first, oldest first within the rung.
  assert.deepStrictEqual(r.items.slice(0, 2).map((i) => i.id), ['approval:a1', 'inquiry:q1']);
  assert.strictEqual(r.items[0].rung, 'blocking');
});

test('overflow notes from the sources reach the caller', async () => {
  const notes = [];
  const rows = Array.from({ length: S.CAP + 1 }, (_, i) => ({
    id: `i${i}`, buyer_name: 'b', status: 'new', created_at: '2026-11-01',
  }));
  const q = fakeQuery({
    'FROM inquiries': rows, 'FROM review_tasks': [],
    'FROM approval_queue': [], 'FROM daily_tasks': [], 'FROM performance_scores': [],
  });
  await Q.collect(S.sourcesFor(q, {
    ctx: CTX, companyId: 'c', userId: 'u', today: TODAY, now: NOW,
    buildBoard: async () => ({ opportunities: [] }), notes,
    listPendingApprovals: fakeApprovals([]),
  }), { now: NOW });

  assert.deepStrictEqual(notes.map((n) => n.source), ['inquiries']);
  assert.match(notes[0].note, /capped/);
});

test('every item the sources produce is acceptable to the aggregator', async () => {
  // makeItem refuses an item with no `where.page`, no title or an unknown kind. A source that
  // emitted one would appear as a degradation in production and nowhere in these tests, so this
  // feeds one row through every source and asserts none of them is rejected.
  const q = fakeQuery({
    'FROM inquiries': [{ id: 'b', buyer_name: 'n', status: 'new', created_at: '2026-11-01' }],
    'FROM review_tasks': [{ id: 'c', title: 't', status: 'open', created_at: '2026-11-01' }],
    'FROM approval_queue': [{ id: 'd', agent_name: 'a', action_type: 't', created_at: '2026-11-01' }],
    'FROM daily_tasks': [{ id: 'e', task_title: 't', created_at: '2026-11-01' }],
    'FROM performance_scores': [{ id: 'f', user_id: 'u', score_0_to_100: 42, score_date: TODAY }],
  });
  const buildBoard = async () => ({
    opportunities: [{ id: 'g', title: 'T', deadline_confirmed: false,
      advice: { verdict: 'PREPARE', headline: 'h', blocked_by: [] } }],
  });

  const r = await Q.collect(S.sourcesFor(q, {
    ctx: CTX, companyId: 'c', userId: 'u', today: TODAY, now: NOW, buildBoard,
    listPendingApprovals: fakeApprovals([
      { id: 'a', action_kind: 'k', reason: 'r', created_at: '2026-11-01' }]),
  }), { now: NOW });

  assert.deepStrictEqual(r.degraded, [], 'a source emitted an item the aggregator refused');
  assert.strictEqual(r.count, 7, 'one item per source did not survive');
  // Every kind is represented, so no source is quietly producing the wrong one.
  assert.deepStrictEqual(
    Object.entries(r.by_kind).filter(([, n]) => n !== 1).map(([k]) => k), []);
});

// ── NO DEAD ENDS ────────────────────────────────────────────────────────────

test('every `where.page` is a page the SPA can actually navigate to', () => {
  // The queue performs nothing, so `where.page` is the whole value of a row. A key that does not
  // exist produces a button that does nothing — a visible decision the person cannot reach, which
  // is worse than not listing it. The keys are plain strings in this file and page names in
  // another, so nothing but a check connects them.
  const fs = require('node:fs');
  const path = require('node:path');

  const src = fs.readFileSync(require.resolve('./decision-sources'), 'utf8');
  const used = [...src.matchAll(/where:\s*\{\s*page:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 7, `expected a page key per source, found ${used.length}`);

  const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'index.html'), 'utf8');
  // Two shapes register a page: `pages['x'] = fn` and a method inside the `const pages = {` literal.
  const assigned = new Set([...html.matchAll(/pages\['([^']+)'\]\s*=/g)].map((m) => m[1]));
  // The nav title map is the authoritative list of navigable pages — navigate() routes by it.
  // Matched on `const titles = {` ALONE. An earlier version anchored on the first key in the map
  // (`{dashboard:`), so adding a key ahead of it silently matched nothing: `assigned` fell back to
  // the pages[...] assignments only, and every page registered just in the title map read as a dead
  // end. The assertion below that the line was found is what makes that loud rather than confusing.
  const titleLine = html.split('\n').find((l) => /const titles = \{/.test(l)) || '';
  assert.ok(titleLine, 'the nav title map was not found in public/index.html — fix this scan');
  for (const m of titleLine.matchAll(/'([a-z0-9-]+)'\s*:/g)) assigned.add(m[1]);
  for (const m of titleLine.matchAll(/([a-z]+)\s*:\s*'/g)) assigned.add(m[1]);

  const missing = [...new Set(used)].filter((k) => !assigned.has(k));
  assert.deepStrictEqual(missing, [],
    `these \`where.page\` keys are not pages in public/index.html, so their rows would be dead ends: `
    + `${missing.join(', ')}`);

  // NEGATIVE CONTROL. Five source-scanning tests in this repository have passed while matching the
  // wrong line, and the assertion above is green either way if `assigned` accidentally contains
  // everything. A key that is definitely not a page must be reported.
  assert.ok(!assigned.has('not-a-real-page-xyz'),
    'the page set matched a key that cannot exist, so this check would accept any dead end');
  // One page from each of the two shapes, so neither half of the scan can silently stop working:
  // 'my-tasks' is a pages[...] assignment, 'team' exists only as a key in the title map.
  assert.ok(assigned.has('my-tasks') && assigned.has('prpa-tracker') && assigned.has('agent-control'),
    'the page set is missing pages registered as pages[...] assignments');
  assert.ok(assigned.has('team') && assigned.has('settings'),
    'the page set is missing pages that exist only in the title map, so that half of the scan is dead');
});
