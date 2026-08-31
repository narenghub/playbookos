// Prospects route tests — run with:  node --test src/api/prospects-routes.test.js
// Mounts the real router with a faked db.query (matched by SQL shape), a signed JWT, and
// stubbed runProspecting/runQualifyProspects (patched before ./routes is required, so the
// route's destructured references point at the stubs). No real DB, no Places network.

process.env.JWT_SECRET = 'test-secret';

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ── stub the prospecting orchestrators BEFORE routes.js destructures them ───────
const prospecting = require('../lib/agents/prospecting');
prospecting.runProspecting = async (product) => ({ product, discovered: 0, inserted: 0, note: 'stub' });
prospecting.runQualifyProspects = async (product) => ({ product, scanned: 0, qualified: 0, note: 'stub' });

// ── in-memory prospects table behind a fake db.query ───────────────────────────
let STORE = [];
function seed() {
  STORE = [
    { id: 1, product: 'golfnex', place_id: 'p1', name: 'Alpha Range',  address: '1 A St, Chicago, IL 60601', phone: '311', website: 'https://a.com', types: ['golf'], rating: '4.5', rating_count: 300, subtype: 'range',     region: 'IL-N', state: 'IL', booking_platform: null,     reachable: true,  unreachable_reason: null,  qualified_at: 1, reject_reason: null, notes: null, status: 'qualified', created_at: 100 },
    { id: 2, product: 'golfnex', place_id: 'p2', name: 'Beta Course',  address: '2 B St, Aurora, IL 60505',  phone: '312', website: 'https://b.com', types: ['golf'], rating: '4.1', rating_count: 900, subtype: 'course',    region: 'IL-N', state: 'IL', booking_platform: 'teesnap', reachable: true,  unreachable_reason: null,  qualified_at: 1, reject_reason: null, notes: null, status: 'qualified', created_at: 200 },
    { id: 3, product: 'golfnex', place_id: 'p3', name: 'Gamma Sim',    address: '3 C St, Peoria, IL 61602',  phone: null,  website: null,           types: [],       rating: null,  rating_count: 50,  subtype: 'simulator', region: 'IL-C', state: 'IL', booking_platform: null,     reachable: null,  unreachable_reason: null,  qualified_at: null, reject_reason: 'no website', notes: null, status: 'new', created_at: 300 },
    { id: 4, product: 'golfnex', place_id: 'p4', name: 'Delta Bad',    address: 'nowhere',                    phone: null,  website: null,           types: [],       rating: null,  rating_count: null, subtype: 'course',   region: 'IL-S', state: null, booking_platform: null,     reachable: null,  unreachable_reason: null,  qualified_at: null, reject_reason: 'non-IL', notes: 'x', status: 'rejected', created_at: 400 },
    { id: 5, product: 'favly',   place_id: 'p5', name: 'Favly Salon',  address: '5 E St, Chicago, IL 60614', phone: '773', website: 'https://e.com', types: ['spa'],  rating: '4.8', rating_count: 120, subtype: 'hair',     region: 'IL-N', state: 'IL', booking_platform: null,     reachable: true,  unreachable_reason: null,  qualified_at: 1, reject_reason: null, notes: null, status: 'qualified', created_at: 500 },
    // favly prime-pool row that was qualified but NEVER reachable (dead 403) — must be excluded
    // from the default prime pool yet returned by the explicit unreachable filter.
    { id: 6, product: 'favly',   place_id: 'p6', name: 'Dead Spa',     address: '6 F St, Chicago, IL 60614', phone: '773', website: 'https://f.com', types: ['spa'],  rating: '4.2', rating_count: 200, subtype: 'hair',     region: 'IL-N', state: 'IL', booking_platform: null,     reachable: false, unreachable_reason: '403', qualified_at: 1, reject_reason: null, notes: null, status: 'qualified', created_at: 600 },
  ];
}
seed();

function applyFilters(sql, params) {
  let rows = STORE.slice(), pi = 0;
  const product = params[pi++];                                       // product = $1 always
  rows = rows.filter(r => r.product === product);
  if (/status = \$\d/i.test(sql))  { const s = params[pi++]; rows = rows.filter(r => r.status === s); }
  if (/subtype = \$\d/i.test(sql)) { const s = params[pi++]; rows = rows.filter(r => r.subtype === s); }
  if (/booking_platform IS NULL/i.test(sql)) rows = rows.filter(r => r.booking_platform == null);
  else if (/booking_platform = \$\d/i.test(sql)) { const b = params[pi++]; rows = rows.filter(r => r.booking_platform === b); }
  if (/reachable = true/i.test(sql)) rows = rows.filter(r => r.reachable === true);
  else if (/reachable = false/i.test(sql)) rows = rows.filter(r => r.reachable === false);
  if (/website IS NOT NULL/i.test(sql)) rows = rows.filter(r => r.website != null);
  else if (/website IS NULL/i.test(sql)) rows = rows.filter(r => r.website == null);
  return rows;
}

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };   // authMiddleware fire-and-forget
  // product-wide summary (has FILTER aggregates) — check before the generic count/list branches
  if (/COUNT\(\*\) FILTER/i.test(sql)) {
    const rows = STORE.filter(r => r.product === params[0]);
    const q = rows.filter(r => r.status === 'qualified');
    const noPlat = q.filter(r => r.booking_platform == null);
    return { rows: [{
      total: rows.length,
      qualified: q.length,
      no_platform: noPlat.length,
      no_platform_reachable: noPlat.filter(r => r.reachable === true).length,
      no_platform_unreachable: noPlat.filter(r => r.reachable === false).length,
      on_platform: q.filter(r => r.booking_platform != null).length,
      rejected: rows.filter(r => r.status === 'rejected').length,
    }] };
  }
  if (/SELECT COUNT\(\*\)::int n FROM prospects/i.test(sql)) {
    return { rows: [{ n: applyFilters(sql, params).length }] };
  }
  if (/FROM prospects/i.test(sql) && /ORDER BY rating_count/i.test(sql)) {
    let rows = applyFilters(sql, params)
      .sort((a, b) => (b.rating_count || 0) - (a.rating_count || 0) || a.id - b.id);
    const lim = /LIMIT (\d+) OFFSET (\d+)/i.exec(sql);
    if (lim) rows = rows.slice(+lim[2], +lim[2] + +lim[1]);
    return { rows };
  }
  if (/SELECT \* FROM prospects WHERE id = \$1/i.test(sql)) {
    return { rows: STORE.filter(r => String(r.id) === String(params[0])) };
  }
  if (/UPDATE prospects\s+SET status = COALESCE/i.test(sql)) {
    const [status, notes, id] = params;
    const row = STORE.find(r => String(r.id) === String(id));
    if (!row) return { rows: [] };
    if (status != null) row.status = status;
    if (notes != null) row.notes = notes;
    return { rows: [row] };
  }
  throw new Error('unexpected SQL in fake: ' + sql);
};

const { signToken } = require('../lib/core');
const router = require('./routes');

const app = express();
app.use(express.json());
app.use('/api', router);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const tok = (role) => signToken({ id: 'u-' + role, email: role + '@x.com', role });
function req(method, path, { role, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers.Authorization = 'Bearer ' + tok(role);
  return fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// ── auth gates ─────────────────────────────────────────────────────────────────
test('GET /prospects without a token → 401', async () => {
  const r = await fetch(base() + '/api/prospects');
  assert.equal(r.status, 401);
});

test('GET /prospects without sales tier (seo_specialist) → 403', async () => {
  const r = await req('GET', '/api/prospects', { role: 'seo_specialist' });
  assert.equal(r.status, 403);
});

test('POST /prospects/run as non-admin (sales_team) → 403 (adminOnly)', async () => {
  const r = await req('POST', '/api/prospects/run', { role: 'sales_team', body: {} });
  assert.equal(r.status, 403);
});

test('POST /prospects/qualify as non-admin (sales_director) → 403 (adminOnly)', async () => {
  const r = await req('POST', '/api/prospects/qualify', { role: 'sales_director', body: {} });
  assert.equal(r.status, 403);
});

test('PUT /prospects/:id without sales tier (seo_specialist) → 403', async () => {
  const r = await req('PUT', '/api/prospects/1', { role: 'seo_specialist', body: { status: 'contacted' } });
  assert.equal(r.status, 403);
});

// ── list: default product, filtering, sort, summary, pagination ────────────────
test('GET /prospects defaults to golfnex, sorted by review count DESC', async () => {
  seed();
  const r = await req('GET', '/api/prospects', { role: 'sales_team' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.product, 'golfnex');
  // golfnex rows sorted by rating_count desc: 900(2), 300(1), 50(3), null(4)
  assert.deepEqual(j.items.map(i => i.id), [2, 1, 3, 4]);
});

test('GET /prospects prime-pool filter (status=qualified & booking_platform=none)', async () => {
  seed();
  const r = await req('GET', '/api/prospects?status=qualified&booking_platform=none', { role: 'sales_team' });
  const j = await r.json();
  assert.deepEqual(j.items.map(i => i.id), [1]); // only qualified golfnex with no platform
});

test('GET /prospects?product=favly scopes to the other product', async () => {
  seed();
  const j = await (await req('GET', '/api/prospects?product=favly', { role: 'sales_team' })).json();
  assert.deepEqual(j.items.map(i => i.id), [6, 5]); // both favly rows, rc DESC (id6=200 > id5=120)
});

test('GET /prospects filters by subtype and has_website', async () => {
  seed();
  const bySub = await (await req('GET', '/api/prospects?subtype=course', { role: 'sales_team' })).json();
  assert.deepEqual(bySub.items.map(i => i.id).sort(), [2, 4]);
  const noSite = await (await req('GET', '/api/prospects?has_website=false', { role: 'sales_team' })).json();
  assert.deepEqual(noSite.items.map(i => i.id).sort(), [3, 4]);
});

test('GET /prospects summary is product-wide, independent of table filters', async () => {
  seed();
  const j = await (await req('GET', '/api/prospects?status=new', { role: 'sales_team' })).json();
  assert.deepEqual(j.summary, { total: 4, qualified: 2, no_platform: 1, no_platform_reachable: 1, no_platform_unreachable: 0, on_platform: 1, rejected: 1 });
  assert.deepEqual(j.items.map(i => i.id), [3]); // filter still applied to the rows
});

test('GET /prospects paginates', async () => {
  seed();
  const p1 = await (await req('GET', '/api/prospects?pageSize=2&page=1', { role: 'sales_team' })).json();
  assert.equal(p1.total, 4);
  assert.equal(p1.pageSize, 2);
  assert.deepEqual(p1.items.map(i => i.id), [2, 1]);
  const p2 = await (await req('GET', '/api/prospects?pageSize=2&page=2', { role: 'sales_team' })).json();
  assert.deepEqual(p2.items.map(i => i.id), [3, 4]);
});

// ── reachability: default prime pool excludes unreachable; explicit filter returns them ──
test('default prime-pool filter (reachable=true) EXCLUDES the unreachable row', async () => {
  seed();
  // this is the page's default: qualified + no platform + reachable → the true prime pool
  const j = await (await req('GET', '/api/prospects?product=favly&status=qualified&booking_platform=none&reachable=true', { role: 'sales_team' })).json();
  assert.deepEqual(j.items.map(i => i.id), [5]);       // id6 (dead 403) is filtered out
  assert.ok(j.items.every(i => i.reachable === true));
});

test('explicit unreachable filter (reachable=false) RETURNS the dead rows with their reason', async () => {
  seed();
  const j = await (await req('GET', '/api/prospects?product=favly&reachable=false', { role: 'sales_team' })).json();
  assert.deepEqual(j.items.map(i => i.id), [6]);
  assert.equal(j.items[0].reachable, false);
  assert.equal(j.items[0].unreachable_reason, '403');  // still findable — they need a phone call
});

test('summary splits no_platform into reachable (prime) vs unreachable', async () => {
  seed();
  const j = await (await req('GET', '/api/prospects?product=favly', { role: 'sales_team' })).json();
  assert.equal(j.summary.no_platform, 2);              // both id5 + id6 are qualified null-platform
  assert.equal(j.summary.no_platform_reachable, 1);    // id5 — the true prime pool
  assert.equal(j.summary.no_platform_unreachable, 1);  // id6 — dead, kept but not prime
});

// ── get one / 404 ──────────────────────────────────────────────────────────────
test('GET /prospects/:id returns full record; 404 when missing', async () => {
  seed();
  const ok = await req('GET', '/api/prospects/2', { role: 'sales_team' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).name, 'Beta Course');
  const missing = await req('GET', '/api/prospects/999', { role: 'sales_team' });
  assert.equal(missing.status, 404);
});

// ── update: status + notes validation ──────────────────────────────────────────
test('PUT /prospects/:id sets status and notes', async () => {
  seed();
  const r = await req('PUT', '/api/prospects/1', { role: 'sales_team', body: { status: 'contacted', notes: 'called' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'contacted');
  assert.equal(j.notes, 'called');
});

test('PUT /prospects/:id notes-only leaves status unchanged (COALESCE)', async () => {
  seed();
  const j = await (await req('PUT', '/api/prospects/1', { role: 'sales_team', body: { notes: 'just a note' } })).json();
  assert.equal(j.status, 'qualified'); // unchanged
  assert.equal(j.notes, 'just a note');
});

test('PUT /prospects/:id invalid status → 400', async () => {
  seed();
  const r = await req('PUT', '/api/prospects/1', { role: 'sales_team', body: { status: 'bogus' } });
  assert.equal(r.status, 400);
});

test('PUT /prospects/:id with neither status nor notes → 400', async () => {
  seed();
  const r = await req('PUT', '/api/prospects/1', { role: 'sales_team', body: {} });
  assert.equal(r.status, 400);
});

test('PUT /prospects/:id on missing row → 404', async () => {
  seed();
  const r = await req('PUT', '/api/prospects/999', { role: 'sales_team', body: { status: 'contacted' } });
  assert.equal(r.status, 404);
});

// ── run / qualify: admin-only, relay the orchestrator summary, never hang ───────
test('POST /prospects/run as admin relays the summary', async () => {
  const r = await req('POST', '/api/prospects/run', { role: 'admin', body: { product: 'golfnex' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.product, 'golfnex');
  assert.equal(j.note, 'stub');
});

test('POST /prospects/qualify as admin relays the summary (defaults product)', async () => {
  const r = await req('POST', '/api/prospects/qualify', { role: 'admin', body: {} });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.product, 'golfnex'); // default
  assert.equal(j.note, 'stub');
});
