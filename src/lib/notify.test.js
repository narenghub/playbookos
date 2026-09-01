// notify() tests — run with:  node --test src/lib/notify.test.js
// The contract that matters: a failed notification insert must NEVER throw or reject, so it
// cannot affect the agent run / draft / cost-fuse that triggered it.

const { test } = require('node:test');
const assert = require('node:assert');
const { notify } = require('./notify');

test('inserts a row and returns the new id (via injected query)', async () => {
  let captured;
  const query = async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 42 }] }; };
  const id = await notify({ product: 'golfnex', kind: 'approval_pending', severity: 'info', title: '2 drafts', body: 'b', link_page: 'content-studio' }, { query });
  assert.equal(id, 42);
  assert.match(captured.sql, /INSERT INTO notifications/i);
  assert.deepEqual(captured.params, ['golfnex', 'approval_pending', 'info', '2 drafts', 'b', 'content-studio']);
});

test('defaults: product null, severity info, body/link null', async () => {
  let params;
  const query = async (_s, p) => { params = p; return { rows: [{ id: 1 }] }; };
  await notify({ kind: 'budget', title: 'fuse hit' }, { query });
  assert.deepEqual(params, [null, 'budget', 'info', 'fuse hit', null, null]);
});

test('NEVER THROWS when the query throws → resolves null', async () => {
  const query = async () => { throw new Error('DB unavailable'); };
  let id;
  await assert.doesNotReject(async () => { id = await notify({ kind: 'agent_failed', title: 'x' }, { query }); });
  assert.equal(id, null);
});

test('NEVER THROWS when the query rejects → resolves null', async () => {
  const query = () => Promise.reject(new Error('connection reset'));
  let id;
  await assert.doesNotReject(async () => { id = await notify({ kind: 'agent_failed', title: 'x' }, { query }); });
  assert.equal(id, null);
});

test('missing kind/title → null, no query call (programming guard, not a crash)', async () => {
  let called = false;
  const query = async () => { called = true; return { rows: [{ id: 1 }] }; };
  assert.equal(await notify({ title: 'no kind' }, { query }), null);
  assert.equal(await notify({ kind: 'budget' }, { query }), null);
  assert.equal(called, false);
});

test('a trigger that fires notify() completes even if the insert fails', async () => {
  // models an agent run: it does its work, then notifies; the notify failure must not surface.
  const query = async () => { throw new Error('boom'); };
  async function fakeAgentRun() {
    const summary = { drafts_created: 2, errors: [] };
    await notify({ product: 'golfnex', kind: 'approval_pending', title: '2 drafts' }, { query }); // never throws
    return summary;
  }
  let s;
  await assert.doesNotReject(async () => { s = await fakeAgentRun(); });
  assert.equal(s.drafts_created, 2);
});
