// CPHI Event Agent route tests — run with:  node --test src/api/cphi-routes.test.js
// Mounts the real router with a faked db.query matched by SQL shape, and signed JWTs for a
// read-only tier and a read-write tier. No real DB, no network to fda.gov or CPHI.

process.env.JWT_SECRET = 'test-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ── in-memory cphi_exhibitor_matches behind a fake db.query ───────────────────
let STORE = [];
function seed() {
  STORE = [
    { id: 1, event_slug: 'cphi-milan-2026', holder: 'TAPI NL BV', holder_normalized: 'tapi nl', exhibiting: true,
      exhibitor_name: 'TAPI NL BV', booth: '3A73', hall: '3', match_tier: 'exact',
      review_status: 'auto_confirmed', entity_note: null, molecules_covered: 34, checked_at: 1 },
    { id: 2, event_slug: 'cphi-milan-2026', holder: 'UMICORE ARGENTINA SA', holder_normalized: 'umicore argentina', exhibiting: true,
      exhibitor_name: 'UMICORE AG & CO. KG', booth: '8J67', hall: '8', match_tier: 'prefix',
      review_status: 'entity_review', entity_note: 'Booth is correct, legal entity may differ…', molecules_covered: 5, checked_at: 1 },
    { id: 3, event_slug: 'cphi-milan-2026', holder: 'AURO PEPTIDES LTD', holder_normalized: 'auro peptides', exhibiting: true,
      exhibitor_name: 'BCN PEPTIDES', booth: '5F21', hall: '5', match_tier: 'token',
      review_status: 'unreviewed', entity_note: null, molecules_covered: 2, checked_at: 1 },
    { id: 4, event_slug: 'cphi-milan-2026', holder: 'INTAS PHARMACEUTICALS LTD', holder_normalized: 'intas', exhibiting: false,
      exhibitor_name: null, booth: null, hall: null, match_tier: 'not_found',
      review_status: 'unreviewed', entity_note: null, molecules_covered: 9, checked_at: 1 },
  ];
}
seed();

const db = require('../lib/db');
db.query = async (sql, params = []) => {
  if (/UPDATE users SET last_login/i.test(sql)) return { rows: [] };          // authMiddleware
  if (/FROM users WHERE id/i.test(sql)) return { rows: [{ id: 1, email: 'a@b.c', role: 'business_dev', is_active: true }] };

  // summary
  if (/COUNT\(DISTINCT booth\)/i.test(sql)) {
    const ex = STORE.filter(r => r.exhibiting);
    return { rows: [{
      exhibiting: ex.length, checked: STORE.length,
      booths: new Set(ex.map(r => r.booth)).size,
      molecule_links: ex.filter(r => ['auto_confirmed','entity_review','confirmed'].includes(r.review_status))
        .reduce((a, b) => a + b.molecules_covered, 0),
      entity_review: STORE.filter(r => r.review_status === 'entity_review').length,
      unverified: STORE.filter(r => r.review_status === 'unreviewed' && r.match_tier === 'token').length,
    }] };
  }
  // dmf source stamp
  if (/FROM dmf_holders GROUP BY source_file/i.test(sql)) {
    return { rows: [{ source_file: '2Q2026-EXCEL', ingested_at: '2026-09-09T00:00:00Z', rows: 41252 }] };
  }
  // thin supply
  if (/counted AS \(SELECT k, COUNT\(\*\)/i.test(sql)) {
    return { rows: [
      { molecule: 'cyclophosphamide', studies: 31, ph3: 2, ph2: 14, patients: 4892, holder_count: 1, score: '140.8',
        holders: [{ holder: 'AARTI PHARMALABS LTD', booth: '2F74', hall: '2', exhibiting: true }] },
      { molecule: 'gemcitabine hydrochloride', studies: 19, ph3: 9, ph2: 7, patients: 13329, holder_count: 1, score: '136.0',
        holders: [{ holder: 'TAPI NL BV', booth: '3A73', hall: '3', exhibiting: true }] },
    ] };
  }
  // list
  if (/FROM cphi_exhibitor_matches WHERE/i.test(sql) && /ORDER BY molecules_covered/i.test(sql)) {
    let rows = STORE.filter(r => r.event_slug === params[0]);
    if (/exhibiting = false/i.test(sql)) rows = rows.filter(r => !r.exhibiting);
    else if (/exhibiting = true/i.test(sql)) rows = rows.filter(r => r.exhibiting);
    let pi = 1;
    if (/match_tier = \$\d/i.test(sql)) { const t = params[pi++]; rows = rows.filter(r => r.match_tier === t); }
    if (/review_status = \$\d/i.test(sql)) { const rs = params[pi++]; rows = rows.filter(r => r.review_status === rs); }
    return { rows: rows.sort((a, b) => b.molecules_covered - a.molecules_covered) };
  }
  // review write
  if (/UPDATE cphi_exhibitor_matches/i.test(sql)) {
    const [status, note, id] = params;
    const row = STORE.find(r => String(r.id) === String(id));
    if (!row) return { rows: [] };
    if (status !== null) row.review_status = status;
    if (note !== null) row.entity_note = note;
    return { rows: [row] };
  }
  return { rows: [] };
};

const { signToken } = require('../lib/core');
const routes = require('./routes');
const app = express();
app.use(express.json());
app.use('/api', routes);

// business_dev holds intelligence:rw; seo_specialist holds intelligence:r (read only).
const RW = signToken({ id: 1, email: 'a@b.c', role: 'business_dev' });
const RO = signToken({ id: 2, email: 'r@b.c', role: 'seo_specialist' });

let server, base;
async function boot() {
  if (base) return base;
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
const call = async (method, path, token, body) => {
  const b = await boot();
  const res = await fetch(b + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('GET /events/cphi/exhibitors defaults to exhibiting only, ranked by coverage', async () => {
  seed();
  const r = await call('GET', '/api/events/cphi/exhibitors', RW);
  assert.equal(r.status, 200);
  assert.equal(r.body.event, 'cphi-milan-2026');
  // Intas is not exhibiting and must not appear in the default view.
  assert.deepEqual(r.body.items.map(i => i.holder), ['TAPI NL BV', 'UMICORE ARGENTINA SA', 'AURO PEPTIDES LTD']);
  assert.equal(r.body.items[0].booth, '3A73');
});

test('exhibiting=false returns the off-floor holders instead', async () => {
  const r = await call('GET', '/api/events/cphi/exhibitors?exhibiting=false', RW);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map(i => i.holder), ['INTAS PHARMACEUTICALS LTD']);
});

test('tier and review_status filter the table', async () => {
  const t = await call('GET', '/api/events/cphi/exhibitors?tier=token', RW);
  assert.deepEqual(t.body.items.map(i => i.holder), ['AURO PEPTIDES LTD']);
  const e = await call('GET', '/api/events/cphi/exhibitors?review_status=entity_review', RW);
  assert.deepEqual(e.body.items.map(i => i.holder), ['UMICORE ARGENTINA SA']);
});

test('the summary is event-wide and does NOT move when the table is filtered', async () => {
  const all = await call('GET', '/api/events/cphi/exhibitors', RW);
  const filtered = await call('GET', '/api/events/cphi/exhibitors?tier=token', RW);
  assert.deepEqual(filtered.body.summary, all.body.summary);
  assert.equal(all.body.summary.checked, 4);
  assert.equal(all.body.summary.exhibiting, 3);
  assert.equal(all.body.summary.unverified, 1);
  // molecule_links counts only reviewed-or-auto rows, so the token row's 2 are excluded.
  assert.equal(all.body.summary.molecule_links, 39);
});

test('the DMF file date rides along so staleness is visible on the page', async () => {
  const r = await call('GET', '/api/events/cphi/exhibitors', RW);
  assert.equal(r.body.dmf_source.source_file, '2Q2026-EXCEL');
  assert.equal(r.body.dmf_source.rows, 41252);
});

test('GET /events/cphi/thin-supply returns molecules with their holders and booths', async () => {
  const r = await call('GET', '/api/events/cphi/thin-supply', RW);
  assert.equal(r.status, 200);
  assert.equal(r.body.max_holders, 3);
  assert.equal(r.body.items[0].molecule, 'cyclophosphamide');
  assert.equal(r.body.items[0].holder_count, 1);
  assert.equal(r.body.items[0].holders[0].booth, '2F74');
});

test('thin-supply max_holders is clamped, so a caller cannot widen it to everything', async () => {
  const r = await call('GET', '/api/events/cphi/thin-supply?max_holders=999', RW);
  assert.equal(r.body.max_holders, 10);
  const z = await call('GET', '/api/events/cphi/thin-supply?max_holders=0', RW);
  assert.equal(z.body.max_holders, 3);
});

test('PUT approves a token-tier row and the verdict sticks', async () => {
  seed();
  const r = await call('PUT', '/api/events/cphi/exhibitors/3', RW, { review_status: 'confirmed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.review_status, 'confirmed');
  const back = await call('GET', '/api/events/cphi/exhibitors?review_status=confirmed', RW);
  assert.deepEqual(back.body.items.map(i => i.holder), ['AURO PEPTIDES LTD']);
});

test('PUT rejects an unknown review_status and an empty body', async () => {
  const bad = await call('PUT', '/api/events/cphi/exhibitors/3', RW, { review_status: 'maybe' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /review_status must be one of/);
  const empty = await call('PUT', '/api/events/cphi/exhibitors/3', RW, {});
  assert.equal(empty.status, 400);
  const missing = await call('PUT', '/api/events/cphi/exhibitors/999', RW, { review_status: 'rejected' });
  assert.equal(missing.status, 404);
});

test('a read-only intelligence tier reads but cannot write a verdict', async () => {
  const read = await call('GET', '/api/events/cphi/exhibitors', RO);
  assert.equal(read.status, 200);
  const write = await call('PUT', '/api/events/cphi/exhibitors/1', RO, { review_status: 'rejected' });
  assert.equal(write.status, 403);
});

test('no token, no access', async () => {
  const b = await boot();
  const res = await fetch(b + '/api/events/cphi/exhibitors');
  assert.equal(res.status, 401);
  server.close();
});
