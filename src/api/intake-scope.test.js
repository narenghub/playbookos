// ── THE INTAKE LINK GRANTS UPLOADS AND NOTHING ELSE ────────────────────────────
//   node --test src/api/intake-scope.test.js
//
// The tokenised intake link is the only unauthenticated write surface in PlaybookOS. The claim being
// tested is narrow and absolute: holding it lets you write files against ONE deal, and gives you no
// read of the price, the terms, the contract, the client's contact record, or anything belonging to
// another client.
//
// ── WHY THIS IS ASSERTED NEGATIVELY ──────────────────────────────────────────
//
// A test that checks the response contains company_name and a file list would pass just as happily on
// a handler that ALSO returned value_cents, because it never asks about value_cents. So the fixture
// deal is loaded with every secret a deal can carry — a price, a monthly, a contact email, an address,
// payment terms, a contract number, a partner — and the assertion is that NONE of those strings appear
// anywhere in any response, at any depth, on any route. A column added to the handler later fails this
// without anybody having to remember to extend the test.
//
// The second fixture is a DIFFERENT client's deal with its own uploads, for the same reason
// partner-deal-scope.test.js uses two partners: with one deal in the table, "returns only this deal's
// files" and "returns every file" are the same result.

process.env.JWT_SECRET = 'test-secret';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { hashToken } = require('../lib/sitenex/intake-token');

// ── the secrets that must never come back ─────────────────────────────────────
const SECRET = {
  value_cents: 1250000,
  monthly_cents: 49900,
  contact_name: 'Dolores Whitfield',
  contact_title: 'Owner',
  contact_email: 'dolores@rockvalleymachine.test',
  contact_phone: '+1 815 555 0142',
  client_address: '12 Mill Lane, Rockford, IL 61101',
  terms_note: 'Net 30 from signature, 50% up front',
  package_code: 'P2',
  partner_name: 'ACBM Partners',
  contract_no: 'SN-2026-0007',
  owner_user_id: 'u-staff-naren',
  prospect_id: 90210,
};
// Keys that must not appear in a payload even if their value happens to be null — a key is a promise
// that the value will arrive one day.
const FORBIDDEN_KEYS = [
  'value_cents', 'monthly_cents', 'contact_email', 'contact_phone', 'contact_name', 'contact_title',
  'client_address', 'terms_note', 'package_code', 'partner_id', 'partner_name', 'prospect_id',
  'owner_user_id', 'duration_weeks', 'payments', 'contract', 'contracts', 'contract_no',
  'file_bytes', 'token', 'token_hash', 'token_tail', 'issued_by',
];

const GOOD_TOKEN = 'T'.repeat(42);
const DEAD_TOKEN = 'D'.repeat(42);
const OUR_DEAL = 41, OTHER_DEAL = 42;

let LINKS, DEALS, INTAKE, FILES, NEXT_FILE_ID;
function reset() {
  const future = new Date(Date.now() + 20 * 86400000);
  LINKS = [
    { id: 1, deal_id: OUR_DEAL, token_hash: hashToken(GOOD_TOKEN), token_tail: GOOD_TOKEN.slice(-4),
      expires_at: future, revoked_at: null, request_count: 0, bytes_uploaded: 0,
      window_started_at: null, window_requests: 0, issued_by: 'u-staff-naren' },
    // A REVOKED link on the OTHER client's deal. Its presence is what proves a dead token cannot be
    // used to reach a live deal, and that the two fixtures are genuinely separate.
    { id: 2, deal_id: OTHER_DEAL, token_hash: hashToken(DEAD_TOKEN), token_tail: DEAD_TOKEN.slice(-4),
      expires_at: future, revoked_at: new Date(), request_count: 3, bytes_uploaded: 900,
      window_started_at: null, window_requests: 0, issued_by: 'u-staff-naren' },
  ];
  DEALS = [
    { id: OUR_DEAL, company_name: 'Rock Valley Machine', ...SECRET },
    { id: OTHER_DEAL, company_name: 'Belvidere Funeral Home', ...SECRET,
      contact_email: 'other@belvidere.test', client_address: '9 Elm Street, Belvidere, IL' },
  ];
  INTAKE = [
    { deal_id: OUR_DEAL, fields: { copy: 'We machine parts.' }, required: ['copy', 'logo'], completed_at: null },
    { deal_id: OTHER_DEAL, fields: { copy: 'We are a funeral home.' }, required: ['copy'], completed_at: null },
  ];
  FILES = [
    { id: 71, deal_id: OUR_DEAL, field: 'logo', file_name: 'rvm-logo.png',
      content_type: 'image/png', file_size: 4096, uploaded_at: '2026-10-01T10:00:00Z' },
    { id: 72, deal_id: OTHER_DEAL, field: 'logo', file_name: 'BELVIDERE-SECRET-LOGO.png',
      content_type: 'image/png', file_size: 8192, uploaded_at: '2026-10-01T10:00:00Z' },
  ];
  NEXT_FILE_ID = 80;
}
reset();

// ── the fake, which READS the handler's SQL rather than restating its behaviour ──
const db = require('../lib/db');
async function fake(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();

  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(s)) return { rows: [] };

  if (/FROM sitenex_intake_links WHERE token_hash/i.test(s)) {
    // The LOOKUP IS BY HASH. If the handler ever selected by a plaintext column this would stop
    // matching, which is the point: the fake refuses to serve a query that reads a token in the clear.
    assert.ok(!/token\s*=\s*\$/.test(s), 'the link must be looked up by token_hash, never by a plaintext token');
    assert.ok(/FOR UPDATE/.test(s), 'the rate-limit read must lock the row, or two uploads can both pass the last byte of a cap');
    assert.ok(!/JOIN sitenex_deals/i.test(s), 'resolving a token must not join to the deal');
    return { rows: LINKS.filter(l => l.token_hash === params[0]) };
  }
  if (/UPDATE sitenex_intake_links SET request_count/i.test(s)) {
    const l = LINKS.find(x => x.id === params[0]);
    if (l) { l.request_count += 1; l.bytes_uploaded += Number(params[1] || 0); l.last_used_at = params[2];
             if (params[3]) l.window_requests += 1; else { l.window_started_at = params[2]; l.window_requests = 1; } }
    return { rows: [], rowCount: l ? 1 : 0 };
  }
  if (/SUM\(file_size\).*FROM sitenex_intake_files/i.test(s)) {
    const total = FILES.filter(f => f.deal_id === params[0]).reduce((n, f) => n + f.file_size, 0);
    return { rows: [{ total: String(total) }] };
  }
  if (/FROM sitenex_deals WHERE id/i.test(s)) {
    // THE ASSERTION THAT MATTERS MOST, made at the query rather than at the response: the client-facing
    // handler may read company_name and nothing else out of the deals table.
    const cols = /SELECT (.+?) FROM sitenex_deals/i.exec(s)[1].split(',').map(x => x.trim());
    assert.deepEqual(cols, ['company_name'],
      'the unauthenticated handler may select ONLY company_name from sitenex_deals, got: ' + cols.join(', '));
    const d = DEALS.find(x => x.id === params[0]);
    return { rows: d ? [{ company_name: d.company_name }] : [] };
  }
  if (/FROM sitenex_intake WHERE deal_id/i.test(s)) {
    const i = INTAKE.find(x => x.deal_id === params[0]);
    return { rows: i ? [{ fields: i.fields, required: i.required, completed_at: i.completed_at }] : [] };
  }
  if (/FROM sitenex_intake_files WHERE deal_id/i.test(s)) {
    assert.ok(!/file_bytes/.test(s), 'the client-facing list must not read the stored bytes back');
    return { rows: FILES.filter(f => f.deal_id === params[0])
      .map(f => ({ id: f.id, file_name: f.file_name, field: f.field, file_size: f.file_size, uploaded_at: f.uploaded_at })) };
  }
  if (/INSERT INTO sitenex_intake_files/i.test(s)) {
    const id = NEXT_FILE_ID++;
    FILES.push({ id, deal_id: params[0], field: params[2], file_name: params[3],
                 content_type: params[4], file_size: params[5] });
    return { rows: [{ id }] };
  }
  if (/INSERT INTO sitenex_intake /i.test(s) || /INSERT INTO sitenex_intake\b/i.test(s)) {
    const patch = JSON.parse(params[1]);
    let i = INTAKE.find(x => x.deal_id === params[0]);
    if (!i) { i = { deal_id: params[0], fields: {}, required: [], completed_at: null }; INTAKE.push(i); }
    Object.assign(i.fields, patch);
    return { rows: [i] };
  }
  if (/DELETE FROM sitenex_intake_files/i.test(s)) {
    // SCOPED BY deal_id, not by the file id alone — without this a client deletes another's upload by
    // guessing an integer.
    assert.ok(/deal_id = \$2/.test(s), 'the delete must be scoped by deal_id as well as id: ' + s);
    const before = FILES.length;
    FILES = FILES.filter(f => !(f.id === params[0] && f.deal_id === params[1]));
    return { rows: [], rowCount: before - FILES.length };
  }
  return { rows: [] };
}
db.query = fake;
// Mirrors pg: the client's query is a METHOD, so a handler that passes client.query around detached
// breaks here exactly as it would in production.
db.withTransaction = async (fn) => fn({ query(sql, params) { return fake(sql, params); } });

const router = require('./sitenex-intake.routes');
const app = express(); app.use(express.json()); app.use('/api', router);
const server = app.listen(0);
after(() => server.close());
beforeEach(() => reset());

const hit = (method, path, { token = GOOD_TOKEN, body, form } = {}) => {
  const headers = {}; if (token !== null) headers['X-Intake-Token'] = token;
  let payload;
  if (form) { payload = form; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, body: payload })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
};

// Walks the whole payload, so a secret nested three levels down still fails.
function assertNoLeak(label, body) {
  const json = JSON.stringify(body);
  for (const [k, v] of Object.entries(SECRET)) {
    assert.ok(!json.includes(String(v)),
      `${label}: leaked ${k} (${v}) — the intake link grants uploads, not a read of the deal`);
  }
  const keys = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) { keys.add(k); walk(o[k]); }
  })(body);
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!keys.has(k), `${label}: payload carries the key "${k}" — remove it, even empty`);
  }
  assert.ok(!json.includes('BELVIDERE-SECRET-LOGO'),
    `${label}: leaked another client's upload`);
  assert.ok(!json.includes('Belvidere'), `${label}: leaked another client's name`);
}

// ── GUARD: the fixture actually carries secrets ───────────────────────────────
//
// Without this, a fake that returned nothing would pass every assertion below and prove nothing.
test('GUARD: the fixture deal really does carry a price, terms and a contact', () => {
  const d = DEALS.find(x => x.id === OUR_DEAL);
  assert.equal(d.value_cents, 1250000);
  assert.equal(d.contact_email, 'dolores@rockvalleymachine.test');
  assert.ok(d.terms_note.length > 10);
  assert.equal(FILES.filter(f => f.deal_id === OTHER_DEAL).length, 1, 'the other client must have an upload to leak');
});

test('GUARD: a valid token reaches the deal at all — so an empty body below is scoping, not a broken fake', async () => {
  const r = await hit('GET', '/intake');
  assert.equal(r.status, 200);
  assert.equal(r.body.company_name, 'Rock Valley Machine');
  assert.deepEqual(r.body.files.map(f => f.name), ['rvm-logo.png']);
});

// ── the negative claim, on every route ───────────────────────────────────────
test('GET /api/intake leaks nothing about the deal', async () => {
  assertNoLeak('GET /intake', (await hit('GET', '/intake')).body);
});

test('POST /api/intake/fields leaks nothing', async () => {
  const r = await hit('POST', '/intake/fields', { body: { copy: 'We machine parts for agriculture.' } });
  assert.equal(r.status, 200);
  assertNoLeak('POST /intake/fields', r.body);
});

test('POST /api/intake/files leaks nothing, and returns only this deal\'s files', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(1024)], { type: 'image/png' }), 'new-logo.png');
  const r = await hit('POST', '/intake/files', { form: fd });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assertNoLeak('POST /intake/files', r.body);
  assert.deepEqual(r.body.files.map(f => f.name).sort(), ['new-logo.png', 'rvm-logo.png']);
});

test('the token cannot reach ANOTHER deal\'s files, in either direction', async () => {
  const mine = (await hit('GET', '/intake')).body.files.map(f => f.id);
  assert.deepEqual(mine, [71], 'only this deal');
  // Deleting the other client's file by id must do nothing, because the WHERE carries deal_id too.
  const d = await hit('DELETE', '/intake/files/72');
  assert.equal(d.status, 200);
  assert.equal(d.body.deleted, 0, "a client must not be able to delete another client's upload by guessing an id");
  assert.ok(FILES.some(f => f.id === 72), 'the other client\'s file must still exist');
});

// ── the token itself ────────────────────────────────────────────────────────
test('a revoked token is refused, and says replaced rather than invalid', async () => {
  const r = await hit('GET', '/intake', { token: DEAD_TOKEN });
  assert.equal(r.status, 410);
  assert.equal(r.body.code, 'link_revoked');
  assertNoLeak('revoked', r.body);
});

test('an unknown token and a malformed one give the SAME answer — enumeration learns nothing', async () => {
  const unknown = await hit('GET', '/intake', { token: 'U'.repeat(42) });
  const junk = await hit('GET', '/intake', { token: 'nope' });
  assert.equal(unknown.status, 404);
  assert.equal(junk.status, 404);
  assert.deepEqual(unknown.body, junk.body, 'a real-but-unknown token must be indistinguishable from nonsense');
});

test('no token at all is refused', async () => {
  const r = await hit('GET', '/intake', { token: null });
  assert.equal(r.status, 404);
});

test('the token is never echoed back, on success or on failure', async () => {
  for (const [label, r] of [['ok', await hit('GET', '/intake')],
                            ['revoked', await hit('GET', '/intake', { token: DEAD_TOKEN })]]) {
    const json = JSON.stringify(r.body);
    assert.ok(!json.includes(GOOD_TOKEN), `${label}: the token came back in the response`);
    assert.ok(!json.includes(DEAD_TOKEN), `${label}: a token came back in the response`);
    assert.ok(!json.includes(hashToken(GOOD_TOKEN)), `${label}: the hash came back in the response`);
  }
});

// ── the completed link closes ────────────────────────────────────────────────
test('once intake is complete the link accepts no more uploads', async () => {
  INTAKE.find(x => x.deal_id === OUR_DEAL).completed_at = new Date();
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(512)], { type: 'image/png' }), 'late.png');
  const r = await hit('POST', '/intake/files', { form: fd });
  assert.equal(r.status, 200);
  assert.equal(r.body.closed, true);
  assert.ok(/no longer accepting/.test(r.body.message));
  assert.ok(!FILES.some(f => f.file_name === 'late.png'), 'nothing may be stored after completion');
});
