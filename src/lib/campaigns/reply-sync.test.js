'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { syncReplies } = require('./reply-sync');

const SELF = 'naren@abiozen.com';
const hdr = (from, subject, extra = {}) => ({
  labelIds: [],
  payload: { headers: [
    { name: 'From', value: from }, { name: 'Subject', value: subject },
    { name: 'Date', value: 'Tue, 13 Oct 2026 04:12:00 +0000' },
    ...Object.entries(extra).map(([name, value]) => ({ name, value })),
  ] },
});

// A fake Gmail whose threads are keyed by id, and a fake query that records every statement.
function harness(threads, rows) {
  const statements = [];
  const gmail = { users: { threads: { get: async ({ id }) => {
    const t = threads[id];
    if (t === 'throw') throw new Error('backendError');
    return { data: { messages: t || [] } };
  } } } };
  const query = async (sql, params) => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/SELECT/i.test(sql)) return { rows };
    return { rowCount: 1, rows: [{ id: params[0] }] };
  };
  return { gmail, query, statements };
}

const ROWS = [
  { id: 1, thread_id: 't-replied', campaign: 'supplier', status: 'active', name: 'Trevor Huang', company: 'Formosa' },
  { id: 2, thread_id: 't-quiet',   campaign: 'supplier', status: 'active', name: 'Ketan Rathod', company: 'Sun' },
  { id: 3, thread_id: 't-ooo',     campaign: 'supplier', status: 'active', name: 'Sonia Raut',   company: 'Zydus' },
  { id: 4, thread_id: 'throw',     campaign: 'partner',  status: 'active', name: 'Boris Brunow', company: 'Allpack' },
];
const THREADS = {
  't-replied': [hdr(`Naren Boda <${SELF}>`, 'Following up from CPHI Milan'),
                hdr('Trevor Huang <trevor@formosalab.com>', 'Re: Following up from CPHI Milan')],
  't-quiet':   [hdr(`Naren Boda <${SELF}>`, 'Following up from CPHI Milan')],
  't-ooo':     [hdr(`Naren Boda <${SELF}>`, 'Following up from CPHI Milan'),
                hdr('Sonia Raut <sonia@zyduslife.com>', 'Automatic reply: Following up from CPHI Milan',
                    { 'Auto-Submitted': 'auto-replied' })],
  throw: 'throw',
};

test('a real reply is found and marked', async () => {
  const h = harness(THREADS, ROWS);
  const r = await syncReplies({ gmail: h.gmail, event: 'cphi-milan-2026', fromMailbox: SELF,
    query: h.query, execute: true, log: () => {} });
  assert.strictEqual(r.replied.length, 1);
  assert.strictEqual(r.replied[0].name, 'Trevor Huang');
  assert.strictEqual(r.marked, 1);
});

test('an out-of-office is NOT a reply and does not stop the sequence', async () => {
  const h = harness(THREADS, ROWS);
  const r = await syncReplies({ gmail: h.gmail, event: 'e', fromMailbox: SELF, query: h.query,
    execute: true, log: () => {} });
  assert.ok(!r.replied.some((x) => x.name === 'Sonia Raut'),
    'marking a vacation notice as a reply silently kills the sequence');
});

test('a thread that cannot be read is UNKNOWN, never "no reply"', async () => {
  const h = harness(THREADS, ROWS);
  const r = await syncReplies({ gmail: h.gmail, event: 'e', fromMailbox: SELF, query: h.query,
    execute: true, log: () => {} });
  assert.strictEqual(r.unknown.length, 1);
  assert.strictEqual(r.unknown[0].name, 'Boris Brunow');
  assert.match(r.unknown[0].why, /backendError/);
});

test('a dry run writes NOTHING', async () => {
  const h = harness(THREADS, ROWS);
  const r = await syncReplies({ gmail: h.gmail, event: 'e', fromMailbox: SELF, query: h.query,
    execute: false, log: () => {} });
  assert.strictEqual(r.replied.length, 1);
  assert.strictEqual(r.marked, 0);
  assert.ok(!h.statements.some((s) => /UPDATE/i.test(s.sql)), 'a dry run issued an UPDATE');
});

test('it only ever moves active → replied, and touches nothing else', async () => {
  // It must never clear a reply, un-halt a sequence, or alter step_sent. A thread marked replied
  // that now looks quiet is not evidence — a human can move or delete a message — and reviving a
  // stopped sequence on that basis emails somebody who already answered.
  const h = harness(THREADS, ROWS);
  await syncReplies({ gmail: h.gmail, event: 'e', fromMailbox: SELF, query: h.query, execute: true, log: () => {} });
  const updates = h.statements.filter((s) => /UPDATE/i.test(s.sql));
  assert.strictEqual(updates.length, 1);
  const sql = updates[0].sql;
  assert.match(sql, /SET status = 'replied'/);
  assert.match(sql, /WHERE id = \$1 AND status = 'active'/, 'the guard must be in the WHERE clause');
  assert.ok(!/step_sent/.test(sql), 'step_sent must not be touched');
  assert.ok(!/next_due_at/.test(sql), 'next_due_at must not be touched');
});

test('only ACTIVE sequences with a thread are considered', async () => {
  const h = harness(THREADS, ROWS);
  await syncReplies({ gmail: h.gmail, event: 'cphi-milan-2026', fromMailbox: SELF, query: h.query, execute: false, log: () => {} });
  const select = h.statements.find((s) => /SELECT/i.test(s.sql));
  assert.match(select.sql, /status = 'active'/);
  assert.match(select.sql, /thread_id IS NOT NULL/);
  assert.strictEqual(select.params[0], 'cphi-milan-2026');
});

test('preconditions throw rather than silently doing nothing', async () => {
  const h = harness(THREADS, ROWS);
  await assert.rejects(() => syncReplies({ event: 'e', fromMailbox: SELF, query: h.query }), /gmail client/);
  await assert.rejects(() => syncReplies({ gmail: h.gmail, fromMailbox: SELF, query: h.query }), /event slug/);
  // Without the mailbox, replyState cannot tell OUR messages from theirs — every thread would
  // look replied, and every sequence would stop.
  await assert.rejects(() => syncReplies({ gmail: h.gmail, event: 'e', query: h.query }), /mailbox is required/);
  await assert.rejects(() => syncReplies({ gmail: h.gmail, event: 'e', fromMailbox: SELF }), /query function/);
});
