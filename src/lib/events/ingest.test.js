// Event ingestion tests — run with:  node --test src/lib/events/ingest.test.js
// No live DB: a small in-memory fake simulates event_sources lookup + the ingested_events
// ON CONFLICT insert + replay lookup. deps.query / deps.env / deps.alert are injected.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { ingestEvent } = require('./ingest');

const SECRET = 'golfnex_live_' + 'a'.repeat(48);
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const ENV_ON = { EVENT_INGEST_ENABLED: 'true' };

// in-memory DB: one golfnex source + an ingested_events store keyed by product\0key
function makeDb({ sources } = {}) {
  const srcRows = sources || [{ product: 'golfnex', secret_hash: SECRET_HASH, secret_hash_next: null, is_active: true, allowed_events: null }];
  const store = new Map(); // "product\0idem" -> { id, payload_hash, status }
  let nextId = 1;
  const alerts = [];
  const query = async (sql, params) => {
    if (/FROM event_sources/i.test(sql)) {
      const hash = params[0];
      const row = srcRows.find(s => s.is_active && (s.secret_hash === hash || s.secret_hash_next === hash));
      return { rows: row ? [row] : [] };
    }
    if (/INSERT INTO ingested_events/i.test(sql)) {
      const [product, event, occ, idem, payloadJson, payloadHash, status] = params;
      const k = product + '\0' + idem;
      if (store.has(k)) return { rows: [] };                 // ON CONFLICT DO NOTHING
      const id = nextId++;
      store.set(k, { id, payload_hash: payloadHash, status });
      return { rows: [{ id }] };
    }
    if (/SELECT payload_hash FROM ingested_events/i.test(sql)) {
      const [product, idem] = params;
      const row = store.get(product + '\0' + idem);
      return { rows: row ? [{ payload_hash: row.payload_hash }] : [] };
    }
    throw new Error('unexpected SQL: ' + sql);
  };
  return { query, store, alerts, alert: async (job, err) => alerts.push({ job, msg: err && err.message }) };
}

const auth = 'Bearer ' + SECRET;
const baseEvent = (over = {}) => ({
  product: 'golfnex', event: 'subscriber.created', occurred_at: '2026-08-19T10:00:00Z',
  idempotency_key: 'k-' + Math.random().toString(36).slice(2), payload: { subscriber_id: 's1' }, ...over,
});
function call(body, db, envOverride) {
  return ingestEvent({ authorization: auth, body }, { query: db.query, env: envOverride || ENV_ON, alert: db.alert });
}

test('valid event -> 201 created', async () => {
  const db = makeDb();
  const r = await call(baseEvent(), db);
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'valid');
  assert.ok(r.body.id);
});

test('idempotent replay (same key + same payload) -> 200 duplicate:true', async () => {
  const db = makeDb();
  const ev = baseEvent({ idempotency_key: 'dupe-1' });
  const first = await call(ev, db);
  assert.equal(first.status, 201);
  const second = await call(ev, db); // identical retry
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(db.store.size, 1); // no double-write
});

test('key reuse with different payload -> 409', async () => {
  const db = makeDb();
  await call(baseEvent({ idempotency_key: 'reuse-1', payload: { subscriber_id: 'a' } }), db);
  const r = await call(baseEvent({ idempotency_key: 'reuse-1', payload: { subscriber_id: 'DIFFERENT' } }), db);
  assert.equal(r.status, 409);
});

test('unknown product credential -> 401', async () => {
  const db = makeDb();
  const r = await ingestEvent({ authorization: 'Bearer golfnex_live_' + 'z'.repeat(48), body: baseEvent() }, { query: db.query, env: ENV_ON, alert: db.alert });
  assert.equal(r.status, 401);
});

test('product body does not match credential -> 401 (spoof guard)', async () => {
  const db = makeDb();
  const r = await call(baseEvent({ product: 'favly' }), db);
  assert.equal(r.status, 401);
});

test('unknown event type -> quarantined (200) + alerted', async () => {
  const db = makeDb();
  const r = await call(baseEvent({ event: 'golf.teetime_booked', payload: { x: 1 } }), db);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'quarantined');
  assert.equal(db.alerts.length, 1);
});

test('malformed payload (empty) on a known event -> quarantined (200) + alerted', async () => {
  const db = makeDb();
  const r = await call(baseEvent({ event: 'subscriber.created', payload: {} }), db);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'quarantined');
  assert.equal(db.alerts.length, 1);
});

test('revenue.recorded without integer minor units -> 400 reject', async () => {
  const db = makeDb();
  const r = await call(baseEvent({ event: 'revenue.recorded', payload: { amount_minor: 19.99, currency: 'USD' } }), db);
  assert.equal(r.status, 400);
  assert.equal(db.store.size, 0); // rejected, nothing stored
});

test('revenue.recorded without currency -> 400 reject', async () => {
  const db = makeDb();
  const r = await call(baseEvent({ event: 'revenue.recorded', payload: { amount_minor: 1999 } }), db);
  assert.equal(r.status, 400);
});

test('revenue.recorded with integer minor units + ISO currency -> 201 valid', async () => {
  const db = makeDb();
  const r = await call(baseEvent({ event: 'revenue.recorded', payload: { amount_minor: 1999, currency: 'USD' } }), db);
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'valid');
});

test('missing envelope field (idempotency_key) -> 400', async () => {
  const db = makeDb();
  const ev = baseEvent(); delete ev.idempotency_key;
  const r = await call(ev, db);
  assert.equal(r.status, 400);
});

test('missing/invalid occurred_at -> 400', async () => {
  const db = makeDb();
  const r = await call(baseEvent({ occurred_at: 'not-a-date' }), db);
  assert.equal(r.status, 400);
});

test('flag OFF -> 503', async () => {
  const db = makeDb();
  const r = await call(baseEvent(), db, { EVENT_INGEST_ENABLED: 'false' });
  assert.equal(r.status, 503);
});

test('NEVER THROWS on malformed body (null, string, number, array)', async () => {
  const db = makeDb();
  for (const bad of [null, undefined, 'a string', 42, [], { junk: true }]) {
    await assert.doesNotReject(async () => {
      const r = await ingestEvent({ authorization: auth, body: bad }, { query: db.query, env: ENV_ON, alert: db.alert });
      assert.ok(r && typeof r.status === 'number'); // always a structured result
    });
  }
});

test('NEVER THROWS when query itself throws -> 500, no crash', async () => {
  const r = await ingestEvent({ authorization: auth, body: baseEvent() }, { query: async () => { throw new Error('db boom'); }, env: ENV_ON });
  assert.equal(r.status, 500);
});

test('missing bearer credential -> 401', async () => {
  const db = makeDb();
  const r = await ingestEvent({ authorization: '', body: baseEvent() }, { query: db.query, env: ENV_ON, alert: db.alert });
  assert.equal(r.status, 401);
});
