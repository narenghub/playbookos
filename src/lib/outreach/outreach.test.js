// OUTREACH — one system, every list.
//   node --test src/lib/outreach/outreach.test.js
//
// The two properties that carry the design:
//   1. 'new' NEEDS NO ROW, so every count has to ADD the untracked remainder. Reading 'new' out of the
//      table reports 0 over a list of 1,524 untouched prospects — the status bar's whole job, wrong.
//   2. THE EVENTS TABLE IS THE POINT. Current status says 50 rows are 'contacted'; only the log says
//      Vinitha contacted 50 companies last week. A status change without an event must be unreachable.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { STATUSES, DEFAULT_STATUS, ENTITIES, isStatus } = require('./registry');
const { statusFor, setStatus, summary, activity, history } = require('./index');

// ── a fake that behaves like the table, including the unique constraint ─────────
let OUTREACH = [], EVENTS = [], ENTITY_ROWS = {}, SEQ = 1;
function reset() {
  OUTREACH = []; EVENTS = []; SEQ = 1;
  ENTITY_ROWS = {
    prospects: [{ id: 1, product: 'golfnex' }, { id: 2, product: 'golfnex' },
                { id: 3, product: 'sitenex' }, { id: 4, product: null }],
    research_institutions: [{ id: 10 }, { id: 11 }],
    leads: [{ id: 'lead-a' }],
  };
}
reset();

const scopeOf = (sql, params) => {
  const m = /o\.product = ANY\(\$(\d+)\)/.exec(sql);
  if (!m) throw new Error('outreach read is not product-scoped: ' + sql);
  return { held: params[+m[1] - 1] || [], nulls: /o\.product IS NULL/.test(sql) };
};
const visible = (sql, params, rows) => {
  const s = scopeOf(sql, params);
  return rows.filter(r => s.held.includes(r.product) || (r.product === null && s.nulls));
};

const query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  // entity existence
  let m = /^SELECT (id, product|id) FROM ([a-z_]+) WHERE id = \$1(::bigint)?$/.exec(s);
  if (m) {
    const table = m[2], cast = !!m[3];
    if (cast && !/^\d+$/.test(String(params[0]))) throw new Error('invalid input syntax for type bigint');
    const row = (ENTITY_ROWS[table] || []).find(r => String(r.id) === String(params[0]));
    return { rows: row ? [row] : [] };
  }
  if (/^SELECT id, status FROM outreach WHERE entity_type/.test(s)) {
    const r = OUTREACH.find(x => x.entity_type === params[0] && x.entity_id === params[1]);
    return { rows: r ? [{ id: r.id, status: r.status }] : [] };
  }
  if (/^INSERT INTO outreach \(/.test(s)) {
    const [entity_type, entity_id, product, status, owner, note, next, touched] = params;
    let row = OUTREACH.find(x => x.entity_type === entity_type && x.entity_id === entity_id);
    if (row) {
      Object.assign(row, { status, product, owner_user_id: owner || row.owner_user_id,
        note: note != null ? note : row.note, next_action_at: next || null,
        last_contacted_at: touched ? 'NOW' : row.last_contacted_at, updated_at: 'NOW' });
    } else {
      row = { id: SEQ++, entity_type, entity_id, product, status, owner_user_id: owner || null, note: note || null,
              next_action_at: next || null, last_contacted_at: touched ? 'NOW' : null, updated_at: 'NOW' };
      OUTREACH.push(row);
    }
    return { rows: [row] };
  }
  if (/^INSERT INTO outreach_events/.test(s)) {
    const [outreach_id, from_status, to_status, by_user_id, by_email, note] = params;
    EVENTS.push({ id: EVENTS.length + 1, outreach_id, from_status, to_status, by_user_id, by_email, note, created_at: Date.now() });
    return { rows: [] };
  }
  if (/FROM outreach o LEFT JOIN users u/.test(s) && /o\.entity_id = ANY/.test(s)) {
    const ids = (params[1] || []).map(String);
    return { rows: visible(s, params, OUTREACH).filter(r => r.entity_type === params[0] && ids.includes(r.entity_id)) };
  }
  if (/SELECT o\.status, COUNT/.test(s)) {
    const rows = visible(s, params, OUTREACH).filter(r => r.entity_type === params[0]);
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    return { rows: Object.entries(byStatus).map(([status, n]) => ({ status, n })) };
  }
  if (/FROM outreach_events e JOIN outreach o/.test(s) && /COUNT\(\*\)::int n/.test(s)) {
    const vis = visible(s, params, OUTREACH);
    const out = new Map();
    for (const e of EVENTS) {
      const o = vis.find(x => x.id === e.outreach_id);
      if (!o) continue;
      const k = `${e.by_email}|${e.to_status}|${o.entity_type}`;
      if (!out.has(k)) out.set(k, { person: e.by_email, by_user_id: e.by_user_id, by_email: e.by_email,
                                    to_status: e.to_status, entity_type: o.entity_type, n: 0, last_at: 0 });
      const row = out.get(k); row.n++; row.last_at = Math.max(row.last_at, e.created_at);
    }
    return { rows: [...out.values()].sort((a, b) => b.n - a.n) };
  }
  if (/FROM outreach_events e JOIN outreach o/.test(s)) {
    const vis = visible(s, params, OUTREACH);
    const o = vis.find(x => x.entity_type === params[0] && x.entity_id === String(params[1]));
    return { rows: o ? EVENTS.filter(e => e.outreach_id === o.id).reverse() : [] };
  }
  throw new Error('unexpected SQL in fake: ' + s);
};
const withTransaction = async (fn) => fn({ query });
const deps = { query, withTransaction };
const STAFF = ['abiozen', 'golfnex', 'favly', 'linkabl', 'aros', 'sitenex', 'internal'];
const set = (o) => setStatus({ user: { id: 'u-v', email: 'vinitha@abiozen.com' }, held: STAFF, ...o }, deps);

beforeEach(() => reset());

// ── the vocabulary ──────────────────────────────────────────────────────────────
test('eight statuses, in lifecycle order, with new as the default', () => {
  assert.deepEqual(STATUSES, ['new','contacted','no_response','in_progress','interested','not_interested','won','disqualified']);
  assert.equal(DEFAULT_STATUS, 'new');
  assert.equal(isStatus('nurture'), false, 'not yet in the vocabulary');
});

test('an unknown status is refused at the edge, since there is no CHECK constraint', async () => {
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'nurture' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_status');
  assert.match(r.error, /One of: new, contacted/);
  assert.equal(OUTREACH.length, 0);
  assert.equal(EVENTS.length, 0);
});

test('the migration must NOT add a CHECK on status', () => {
  const src = require('fs').readFileSync(__dirname + '/../../../scripts/migrate-outreach.js', 'utf8');
  const create = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS outreach ('), src.indexOf('CREATE INDEX'));
  assert.ok(!/CHECK/i.test(create), 'inquiries.status shipped with one and it had to be dropped');
  assert.match(src, /COMMENT ON COLUMN outreach\.status/, 'the vocabulary lives in a comment instead');
});

// ── 'new' needs no row ──────────────────────────────────────────────────────────
test("an untouched entity is 'new' with no row written", async () => {
  const map = await statusFor('prospect', [1, 2], STAFF, deps);
  assert.deepEqual(map, {}, 'nothing tracked yet');
  assert.equal(OUTREACH.length, 0);
});

test('the summary ADDS the untracked remainder as new', async () => {
  // The bug this prevents: reading 'new' out of the table reports 0 over 1,524 untouched prospects.
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  const s = await summary('prospect', { held: STAFF, totalEntities: 1524 }, deps);
  assert.equal(s.counts.contacted, 1);
  assert.equal(s.counts.new, 1523, '1524 total minus the 1 that has a row');
  assert.equal(s.tracked, 1);
  assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), 1524, 'the bar accounts for every row');
});

test('with no total supplied, new is not invented', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  const s = await summary('prospect', { held: STAFF }, deps);
  assert.equal(s.counts.new, 0, 'better zero than a wrong number');
  assert.equal(s.total, null);
});

test('a status outside the vocabulary is still COUNTED, not dropped', async () => {
  // The column has no CHECK, so a value could arrive from SQL. Dropping it would silently lose rows from
  // a bar that is supposed to account for all of them.
  OUTREACH.push({ id: 99, entity_type: 'prospect', entity_id: '2', product: 'golfnex', status: 'nurture' });
  const s = await summary('prospect', { held: STAFF, totalEntities: 10 }, deps);
  assert.equal(s.counts.nurture, 1);
  assert.equal(s.counts.new, 9);
});

// ── every change is an event ─────────────────────────────────────────────────────
test('a status change writes the row AND the event, with who and from-what', async () => {
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'contacted', note: 'left a voicemail' });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'new', 'no row before, so it came from new');
  assert.equal(r.to, 'contacted');
  assert.equal(EVENTS.length, 1);
  assert.deepEqual([EVENTS[0].from_status, EVENTS[0].to_status, EVENTS[0].by_email, EVENTS[0].note],
    ['new', 'contacted', 'vinitha@abiozen.com', 'left a voicemail']);
});

test('a second change logs the real transition, not new again', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  await set({ entityType: 'prospect', entityId: 1, status: 'interested' });
  assert.equal(OUTREACH.length, 1, 'one row per entity — the unique constraint');
  assert.deepEqual(EVENTS.map(e => `${e.from_status}→${e.to_status}`), ['new→contacted', 'contacted→interested']);
});

test('re-selecting the SAME status still logs — a second call is a second call', async () => {
  // Two contact attempts on different days are two events even though the status did not move. Suppressing
  // it would lose exactly the activity the log exists to count.
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  const again = await set({ entityType: 'prospect', entityId: 1, status: 'contacted', note: 'second attempt' });
  assert.equal(again.changed, false, 'reported as unchanged');
  assert.equal(EVENTS.length, 2, 'but still recorded');
});

test('last_contacted_at moves only when the change MEANS contact', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'disqualified' });
  assert.equal(OUTREACH[0].last_contacted_at, null, 'disqualifying is not contacting');
  await set({ entityType: 'prospect', entityId: 2, status: 'contacted' });
  assert.equal(OUTREACH[1].last_contacted_at, 'NOW');
});

// ── scoping is inherited, not reinvented ────────────────────────────────────────
test('reads are product-scoped — the fake THROWS if the fragment is missing', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });   // golfnex
  await set({ entityType: 'prospect', entityId: 3, status: 'won' });         // sitenex
  const golfnexOnly = await statusFor('prospect', [1, 2, 3], ['golfnex'], deps);
  assert.deepEqual(Object.keys(golfnexOnly), ['1'], 'the sitenex row is not visible');
  const both = await statusFor('prospect', [1, 2, 3], ['golfnex', 'sitenex'], deps);
  assert.deepEqual(Object.keys(both).sort(), ['1', '3']);
});

test('the product comes from the ROW, never from the caller', async () => {
  const r = await set({ entityType: 'prospect', entityId: 3, status: 'contacted', product: 'golfnex' });
  assert.equal(r.ok, true);
  assert.equal(r.row.product, 'sitenex', "the row's own product wins over anything passed in");
});

test('writing outreach on a row whose product you do NOT hold is refused', async () => {
  const r = await setStatus({ entityType: 'prospect', entityId: 3, status: 'contacted',
    user: { id: 'u-x', email: 'x@y.z' }, held: ['golfnex'] }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'product_not_held');
  assert.equal(OUTREACH.length, 0);
  assert.equal(EVENTS.length, 0, 'a refusal writes nothing at all');
});

test('an entity with a NULL product is refused rather than filed under nothing', async () => {
  const r = await set({ entityType: 'prospect', entityId: 4, status: 'contacted' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'entity_has_no_product');
});

test('a fixed-product entity takes it from the registry', async () => {
  const r = await set({ entityType: 'institution', entityId: 10, status: 'contacted' });
  assert.equal(r.ok, true);
  assert.equal(r.row.product, 'abiozen', 'research_institutions has no product column');
});

test('a TEXT id works as well as a bigint one — that is why entity_id is TEXT', async () => {
  const r = await set({ entityType: 'lead', entityId: 'lead-a', status: 'in_progress' });
  assert.equal(r.ok, true);
  assert.equal(r.row.entity_id, 'lead-a');
});

test('a missing or malformed entity is refused, not filed', async () => {
  assert.equal((await set({ entityType: 'prospect', entityId: 99999, status: 'contacted' })).code, 'entity_not_found');
  assert.equal((await set({ entityType: 'prospect', entityId: 'not-a-number', status: 'contacted' })).code, 'bad_entity_id');
  assert.equal((await set({ entityType: 'unicorn', entityId: 1, status: 'contacted' })).code, 'unknown_entity_type');
  assert.equal(OUTREACH.length, 0);
});

// ── the question status alone cannot answer ──────────────────────────────────────
test('activity says WHO contacted how many, which current status cannot', async () => {
  for (const id of [1, 2]) await set({ entityType: 'prospect', entityId: id, status: 'contacted' });
  await set({ entityType: 'prospect', entityId: 1, status: 'interested' });
  await setStatus({ entityType: 'institution', entityId: 10, status: 'contacted',
    user: { id: 'u-n', email: 'naren@abiozen.com' }, held: STAFF }, deps);

  const a = await activity({ held: STAFF, sinceDays: 7 }, deps);
  const v = a.people.find(p => p.person === 'vinitha@abiozen.com');
  assert.equal(v.total, 3, 'three changes by Vinitha');
  assert.deepEqual(v.by_status, { contacted: 2, interested: 1 });
  const n = a.people.find(p => p.person === 'naren@abiozen.com');
  assert.equal(n.total, 1);
  assert.ok(a.people[0].total >= a.people[1].total, 'busiest first');
});

test('activity is product-scoped like everything else', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });   // golfnex
  await set({ entityType: 'prospect', entityId: 3, status: 'contacted' });   // sitenex
  const a = await activity({ held: ['golfnex'], sinceDays: 7 }, deps);
  assert.equal(a.people.reduce((s, p) => s + p.total, 0), 1, 'only the golfnex event is counted');
});

test('the per-entity history reads back newest first', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  await set({ entityType: 'prospect', entityId: 1, status: 'won' });
  const h = await history('prospect', 1, STAFF, deps);
  assert.deepEqual(h.map(x => x.to_status), ['won', 'contacted']);
});

// ── the enumeration ─────────────────────────────────────────────────────────────
test('every entity type names a real table and a real product', () => {
  const { PRODUCTS } = require('../products/route-map');
  for (const [type, def] of Object.entries(ENTITIES)) {
    assert.ok(def.table && def.label, `${type} needs a table and a label`);
    assert.ok(['bigint', 'text'].includes(def.idCast), `${type}.idCast`);
    assert.ok(def.product === 'row' || PRODUCTS.includes(def.product),
      `${type}.product must be 'row' or a real product, got ${def.product}`);
    assert.ok(Array.isArray(def.pages) && def.pages.length, `${type} must name the pages it appears on`);
  }
});

test('the enumeration covers every list that shows contactable entities', () => {
  // The six named plus the three found by reading the code. If a new list appears, add it here and in the
  // registry — this is the test that makes "one implementation" true rather than aspirational.
  const pages = Object.values(ENTITIES).flatMap(e => e.pages).sort();
  assert.deepEqual(pages, [
    'aros-establishments', 'clinical-demand-intelligence', 'cphi-milan',
    'prospects', 'research-institutions', 'sales-pipeline', 'sitenex-prospects',
  ]);
});

test('prospects.status is NOT touched — it is qualification, not outreach', () => {
  // Collapsing the two would make 'qualified' and 'contacted' mutually exclusive, and the qualifier's next
  // run would overwrite a human's note.
  const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
  assert.ok(!/UPDATE prospects SET status/.test(src), 'outreach must never write prospects.status');
  const mig = require('fs').readFileSync(__dirname + '/../../../scripts/migrate-outreach.js', 'utf8');
  assert.ok(!/ALTER TABLE prospects/.test(mig), 'and must not alter the prospects table');
});

// ── the routes, over HTTP ───────────────────────────────────────────────────────
// A separate block because the properties above are about the module; these are about the wiring — that
// the route is scoped, that a refusal is the right status code, and that the summary bar gets its number.
const express = require('express');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

test('the HTTP surface: read, write, summary, activity, history, vocabulary', async (t) => {
  reset();
  const db = require('../db');
  const realQuery = db.query, realTxn = db.withTransaction;
  db.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
    if (/^SELECT role, is_active FROM users WHERE id =/i.test(s)) return { rows: [{ role: 'business_dev', is_active: 1 }] };
    if (/FROM user_products WHERE user_id/i.test(s)) return { rows: STAFF.map(product => ({ product })) };
    return query(sql, params);
  };
  db.withTransaction = withTransaction;

  const { signToken } = require('../core');
  const router = require('../../api/routes');
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const tok = signToken({ id: 'u-v', email: 'vinitha@abiozen.com', role: 'business_dev' });
  const call = (method, path, body) => fetch(base + path, {
    method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    const vocab = await call('GET', '/api/outreach/vocabulary');
    assert.equal(vocab.status, 200);
    assert.deepEqual(vocab.body.statuses, STATUSES, 'the dropdown reads the vocabulary, not a second copy');
    assert.equal(Object.keys(vocab.body.entity_types).length, 6);

    const put = await call('PUT', '/api/outreach',
      { entity_type: 'prospect', entity_id: 1, status: 'contacted', note: 'called, left a message' });
    assert.equal(put.status, 200);
    assert.deepEqual([put.body.from, put.body.to], ['new', 'contacted']);

    const get = await call('GET', '/api/outreach?entity_type=prospect&ids=1,2');
    assert.equal(get.body.statuses['1'].status, 'contacted');
    assert.equal(get.body.statuses['2'], undefined, 'untouched rows are absent, i.e. new');

    const sum = await call('GET', '/api/outreach/summary?entity_type=prospect&total=1524');
    assert.equal(sum.body.counts.contacted, 1);
    assert.equal(sum.body.counts.new, 1523, 'the bar gets the real new count, not 0');

    const act = await call('GET', '/api/outreach/activity?days=7');
    assert.equal(act.body.people[0].person, 'vinitha@abiozen.com');
    assert.equal(act.body.people[0].total, 1);

    const hist = await call('GET', '/api/outreach/history?entity_type=prospect&entity_id=1');
    assert.equal(hist.body.events.length, 1);

    // refusals carry the right status code
    assert.equal((await call('PUT', '/api/outreach', { entity_type: 'prospect', entity_id: 99999, status: 'contacted' })).status, 404);
    assert.equal((await call('PUT', '/api/outreach', { entity_type: 'prospect', entity_id: 1, status: 'nurture' })).status, 400);
    assert.equal((await call('GET', '/api/outreach?entity_type=unicorn&ids=1')).status, 400);
    assert.equal((await call('PUT', '/api/outreach', { entity_type: 'prospect' })).status, 400);
    assert.equal((await fetch(base + '/api/outreach?entity_type=prospect&ids=1')).status, 401, 'no token, no outreach');
  } finally {
    server.close(); db.query = realQuery; db.withTransaction = realTxn;
  }
});
