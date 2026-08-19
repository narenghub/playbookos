// PlaybookOS — multi-product event ingestion (E0)
//
// Core logic for POST /api/events/ingest. HTTP-agnostic and never-throws: returns
// { status, body } and never rejects, so a malformed event from one product can never
// affect another product or crash the request. The route in src/api/routes.js is a thin
// wrapper. Tests inject deps.query / deps.env / deps.alert — no DB needed.
//
// Contract (see docs/ECOSYSTEM_ARCHITECTURE.md):
//   Auth  : Authorization: Bearer <per-product secret>  (never a shared secret)
//   Body  : { product, event, occurred_at, idempotency_key, payload }
//   Flag  : EVENT_INGEST_ENABLED (default OFF -> 503)
//
// Reject (4xx, store nothing) vs quarantine (200, stored status='quarantined'):
//   - envelope problems  -> reject 400 (sender bug, fix + retry)
//   - bad/unknown secret -> reject 401
//   - revenue money rule -> reject 400 (integer minor units + ISO-4217 currency, both required)
//   - unknown event / not-allowed / empty payload -> quarantine (authentic but questionable;
//     never lose it, alert on every one)

const crypto = require('crypto');

const VOCAB = new Set([
  'subscriber.created', 'subscriber.changed', 'revenue.recorded',
  'supply.listed', 'demand.matched', 'support.requested', 'community.signal',
]);

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function timingEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), 'hex'), bb = Buffer.from(String(b), 'hex');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch (_) { return false; }
}

// Per-event payload validation. Returns null (ok), {reject} (hard 400), or {quarantine}.
function validatePayload(event, payload) {
  // MONEY CONVENTION — the one hard rule. Getting units wrong is a silent 100x error.
  if (event === 'revenue.recorded') {
    if (!Number.isInteger(payload.amount_minor)) {
      return { reject: 'revenue.recorded requires integer amount_minor (minor units, e.g. cents — not dollars)' };
    }
    if (typeof payload.currency !== 'string' || !/^[A-Z]{3}$/.test(payload.currency)) {
      return { reject: 'revenue.recorded requires an ISO-4217 currency code (3 uppercase letters)' };
    }
    return null;
  }
  // Day-one soft rule for the other events: an authentic event with an empty payload is
  // almost certainly a sender bug — park it, don't lose it, don't count it. Richer
  // per-event schemas are deferred until the second product (generalize-after-2nd).
  if (Object.keys(payload).length === 0) return { quarantine: 'empty_payload' };
  return null;
}

async function defaultAlert(job, err) {
  try {
    const { sendCronAlert } = require('../cron-alerts');
    if (sendCronAlert) await sendCronAlert(job, err);
  } catch (_) {
    try { console.warn(`[events/ingest] ${job}:`, err && err.message); } catch (_2) {}
  }
}

async function ingestEvent({ authorization, body } = {}, deps = {}) {
  const R = (status, obj) => ({ status, body: obj });
  try {
    const env = deps.env || process.env;
    const alert = deps.alert || defaultAlert;

    // 0. feature flag (default OFF)
    if (String(env.EVENT_INGEST_ENABLED).toLowerCase() !== 'true') {
      return R(503, { error: 'event ingestion is disabled' });
    }

    const query = deps.query || require('../db').query;

    // 1. authenticate by credential -> derive the product (never trust body.product alone)
    const m = /^Bearer\s+(.+)$/i.exec(String(authorization || ''));
    if (!m) return R(401, { error: 'missing or malformed Authorization: Bearer credential' });
    const providedHash = sha256(m[1].trim());

    let src;
    try {
      src = (await query(
        `SELECT product, secret_hash, secret_hash_next, is_active, allowed_events
           FROM event_sources
          WHERE is_active = true AND (secret_hash = $1 OR secret_hash_next = $1)`,
        [providedHash]
      )).rows[0];
    } catch (e) {
      if (/event_sources/i.test(String(e && e.message))) return R(503, { error: 'event ingestion is not migrated (event_sources missing)' });
      throw e;
    }
    if (!src) return R(401, { error: 'unknown product credential' });
    // defense-in-depth timing-safe confirm (the SQL matched on a hash already)
    const match = timingEqualHex(providedHash, src.secret_hash) ||
      (src.secret_hash_next && timingEqualHex(providedHash, src.secret_hash_next));
    if (!match) return R(401, { error: 'invalid credential' });
    const product = src.product;

    // 2. envelope validation (reject 4xx, store nothing)
    const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    if (typeof b.product !== 'string' || !b.product.trim()) return R(400, { error: 'product is required' });
    if (b.product !== product) return R(401, { error: 'product does not match the presented credential' });
    if (typeof b.event !== 'string' || !b.event.trim()) return R(400, { error: 'event is required' });
    if (typeof b.idempotency_key !== 'string' || !b.idempotency_key.trim()) return R(400, { error: 'idempotency_key is required' });
    const occ = b.occurred_at != null ? new Date(b.occurred_at) : null;
    if (!occ || isNaN(occ.getTime())) return R(400, { error: 'occurred_at is required and must be a valid timestamp' });
    if (b.payload === null || typeof b.payload !== 'object' || Array.isArray(b.payload)) return R(400, { error: 'payload must be an object' });

    const event = b.event, idem = b.idempotency_key, payload = b.payload;

    // 3. classify: valid vs quarantine vs hard-reject
    let status = 'valid', reason = null;
    if (!VOCAB.has(event)) {
      status = 'quarantined'; reason = `unknown_event:${event}`;
    } else {
      const v = validatePayload(event, payload);
      if (v && v.reject) return R(400, { error: v.reject });           // money rule -> hard reject
      if (v && v.quarantine) { status = 'quarantined'; reason = v.quarantine; }
    }
    // optional per-product allow-list
    if (status === 'valid' && Array.isArray(src.allowed_events) && src.allowed_events.length && !src.allowed_events.includes(event)) {
      status = 'quarantined'; reason = `event_not_allowed:${event}`;
    }

    const payloadHash = sha256(JSON.stringify(payload));

    // 4. idempotent durable insert (synchronous-before-ack; the UNIQUE is the guarantee)
    let inserted;
    try {
      inserted = await query(
        `INSERT INTO ingested_events
           (product, event, occurred_at, idempotency_key, payload, payload_hash, status, quarantine_reason)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (product, idempotency_key) DO NOTHING
         RETURNING id`,
        [product, event, occ.toISOString(), idem, JSON.stringify(payload), payloadHash, status, reason]
      );
    } catch (e) {
      if (/ingested_events/i.test(String(e && e.message))) return R(503, { error: 'event ingestion is not migrated (ingested_events missing)' });
      throw e;
    }

    // 5. replay vs key-reuse
    if (inserted.rows.length === 0) {
      const ex = (await query(
        `SELECT payload_hash FROM ingested_events WHERE product = $1 AND idempotency_key = $2`,
        [product, idem]
      )).rows[0];
      if (ex && timingEqualHex(ex.payload_hash, payloadHash)) {
        return R(200, { received: true, duplicate: true });           // benign retry
      }
      return R(409, { error: 'idempotency_key reused with a different payload' }); // integrity anomaly
    }

    // 6. alert on every quarantined row (decision #4), once (only on first insert)
    if (status === 'quarantined') {
      try { await alert('event-ingest/quarantine', new Error(`${product} ${event}: ${reason}`)); } catch (_) {}
    }

    return R(status === 'quarantined' ? 200 : 201, { received: true, id: inserted.rows[0].id, status });
  } catch (e) {
    try { console.error('[events/ingest] unexpected error:', e && e.message); } catch (_) {}
    return R(500, { error: 'internal error' }); // never-throws
  }
}

module.exports = { ingestEvent, VOCAB, sha256 };
