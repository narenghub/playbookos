// SiteNex Phase 3 routes — the write path, the schedule rule, and the two scoping rules.
//
//   node --test src/api/sitenex-phase3.test.js
//
// Two fixture partners, because the assertion that matters cannot be made with one: "A sees their own"
// is satisfied by a query that returns everything when there is only one partner's data to return.
//
// The fake models sitenex_deals, sitenex_deal_payments and sitenex_contracts, and it THROWS if a read
// of a partner-owned table arrives without a partner_id predicate — a scoping test whose fake ignores
// the scope passes for the wrong reason.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase3-test';

const PARTNER_A = 11, PARTNER_B = 22;
const USERS = [
  { id: 'u-admin', email: 'admin@abiozen.com', role: 'admin', partner_id: null },
  { id: 'u-super', email: 'super@abiozen.com', role: 'super_admin', partner_id: null },
  { id: 'u-pa', email: 'a@partnera.example', role: 'partner', partner_id: PARTNER_A },
  { id: 'u-pb', email: 'b@partnerb.example', role: 'partner', partner_id: PARTNER_B },
  { id: 'u-broken', email: 'x@nopartner.example', role: 'partner', partner_id: null },
];
const PARTNERS = [{ id: PARTNER_A, name: 'Partner A', primary_contact_email: 'a@partnera.example' },
                  { id: PARTNER_B, name: 'Partner B', primary_contact_email: 'b@partnerb.example' }];
const PACKAGES = [{ code: 'P2', name: 'Renew', included: ['content migration', 'redirect map'],
                    not_included: ['content writing', 'photography'] }];

// EVERY statement the route makes, recorded by the fake itself.
//
// It has to be here and not in a wrapper a test installs: the router does
// `const { query } = require('../lib/db')` at MODULE LOAD, so it captures whatever db.query was when it was
// required — which is this fake, set up above. Reassigning db.query inside a test afterwards changes
// nothing the route can see, and a test that counted queries that way counted zero and passed.
let SQL_LOG = [];
let DEALS, PAYMENTS, CONTRACTS, SENDS, SEQ, DEAL_SEQ, CONTRACT_SEQ, PROSPECTS;
let MAIL;   // what the fake mailer was asked to send, and what it should answer
function reset() {
  DEAL_SEQ = 100; CONTRACT_SEQ = 500; SEQ = 0;
  PAYMENTS = []; CONTRACTS = []; SENDS = []; SQL_LOG = [];
  MAIL = { sent: [], reply: { ok: true, id: 'msg_fake_1', error: null }, throwOnTxn: false };
  DEALS = [
    { id: ++DEAL_SEQ, partner_id: PARTNER_A, owner_user_id: 'u-admin', status: 'new', package_code: 'P2',
      company_name: 'Acme Machine Works LLC', contact_name: 'Dale Prentice', contact_title: 'Owner',
      contact_email: 'dale@acme.example', contact_phone: null, client_address: '412 W Main St, Rockford, IL',
      duration_weeks: 3, starts_at_intake: true, terms_note: null, value_cents: 450000, monthly_cents: 9900,
      prospect_id: null, proposal_url: null, signed_at: null },
    { id: ++DEAL_SEQ, partner_id: PARTNER_B, owner_user_id: 'u-admin', status: 'new', package_code: 'P2',
      company_name: 'B Client Inc', contact_name: 'Jo Smith', contact_email: 'jo@b.example',
      client_address: '9 High St, Peoria, IL', duration_weeks: 3, starts_at_intake: true,
      value_cents: 100000, monthly_cents: null, prospect_id: null },
    { id: ++DEAL_SEQ, partner_id: null, owner_user_id: 'u-admin', status: 'signed', package_code: 'P2',
      company_name: 'Self Sourced Co', contact_name: 'Pat Lee', contact_email: 'pat@self.example',
      client_address: '1 Our St, Chicago, IL', duration_weeks: 4, starts_at_intake: false,
      value_cents: 200000, monthly_cents: null, prospect_id: null },
  ];
  PROSPECTS = [{ id: 9001, name: 'Acme Machine', website: 'http://acme.example', site_url: 'http://acme.example',
                 site_score: 50, recommended_package: 'P2', subtype: 'machine_shop', region: 'Rockford, IL',
                 phone: '(815) 555-0142', address: '412 W Main St, Rockford, IL 61101', product: 'sitenex',
                 site_findings: { reachable: true, signals: [
                   { key: 'no_viewport', penalty: 25, evidence: 'no <meta name="viewport"> — not mobile-friendly' },
                   { key: 'no_https', penalty: 15, evidence: 'served over plain http:// (http://acme.example)' }] } }];
}
reset();

let LOOKUP_FAILS = false;

// Partner-owned tables. A read of one of these without a partner_id predicate is a leak, so the fake
// refuses rather than quietly returning everything.
const requiresScope = (s) => /FROM sitenex_deals|FROM sitenex_contracts c/.test(s);
const scopeOf = (s, params) => {
  const m = /(?:d|c)\.partner_id = \$(\d+)/.exec(s);
  if (m) return { kind: 'partner', id: params[+m[1] - 1] };
  if (/WHERE FALSE|AND FALSE/.test(s)) return { kind: 'none' };
  if (/WHERE TRUE|AND TRUE/.test(s)) return { kind: 'all' };
  throw new Error('UNSCOPED read of a partner-owned table: ' + s);
};
const visible = (s, params, rows) => {
  const sc = scopeOf(s, params);
  if (sc.kind === 'all') return rows;
  if (sc.kind === 'none') return [];
  return rows.filter(r => r.partner_id === sc.id);
};
const join = (d) => {
  const pt = PARTNERS.find(p => p.id === d.partner_id);
  const u = USERS.find(x => x.id === d.owner_user_id);
  return { ...d, partner_name: pt ? pt.name : null, partner_email: pt ? pt.primary_contact_email : null,
           prospect_name: null, prospect_phone: null, prospect_region: null, owner_name: u ? u.name || u.email : null,
           created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z' };
};

const db = require('../lib/db');
const realQuery = db.query, realTxn = db.withTransaction;

db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  SQL_LOG.push(s);

  if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
  if (/^SELECT role, is_active FROM users WHERE id =/i.test(s)) {
    const u = USERS.find(x => x.id === params[0]);
    return { rows: u ? [{ role: u.role, is_active: 1 }] : [] };
  }
  if (/^SELECT partner_id FROM users WHERE id =/i.test(s)) {
    if (LOOKUP_FAILS) throw new Error('simulated lookup failure');
    const u = USERS.find(x => x.id === params[0]);
    return { rows: u ? [{ partner_id: u.partner_id }] : [] };
  }
  if (/FROM user_products WHERE user_id/i.test(s)) {
    return { rows: ['sitenex', 'internal'].map(product => ({ product })) };
  }
  if (/FROM sitenex_packages WHERE code/i.test(s)) {
    const p = PACKAGES.find(x => x.code === params[0]);
    return { rows: p ? [p] : [] };
  }
  if (/FROM prospects WHERE id = \$1::bigint AND product = 'sitenex'/i.test(s)) {
    const p = PROSPECTS.find(x => String(x.id) === String(params[0]));
    return { rows: p ? [p] : [] };
  }

  // ── deals ──
  if (/^SELECT d\.id, d\.status/.test(s) && /WHERE d\.id = \$1/.test(s)) {
    const rows = visible(s, params, DEALS).filter(d => String(d.id) === String(params[0]));
    return { rows: rows.map(join) };
  }
  if (/^SELECT d\.id, d\.status/.test(s)) return { rows: visible(s, params, DEALS).map(join) };
  if (/^INSERT INTO sitenex_deals \(/.test(s)) {
    const cols = /INSERT INTO sitenex_deals \(([^)]+)\)/.exec(s)[1].split(',').map(x => x.trim());
    // starts_at_intake DEFAULT TRUE, modelled because the column has it: a fake that leaves it undefined
    // makes the route look like it forgot to set a value it is deliberately letting the DB supply.
    const row = { id: ++DEAL_SEQ, starts_at_intake: true };
    cols.forEach((c, i) => { if (c !== 'created_at' && c !== 'updated_at') row[c] = params[i]; });
    DEALS.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (/^UPDATE sitenex_deals SET/.test(s)) {
    const id = params[params.length - 1];
    const d = DEALS.find(x => String(x.id) === String(id));
    const sets = [...s.matchAll(/(\w+) = \$(\d+)/g)];
    for (const [, col, n] of sets) d[col] = params[+n - 1];
    return { rowCount: 1, rows: [] };
  }

  // ── payments ──
  // ANCHORED on ^SELECT. Unanchored, this branch also matched `DELETE FROM sitenex_deal_payments WHERE
  // deal_id = $1` — so the delete returned rows and deleted nothing, and the two tests that depend on a
  // schedule being CLEARED failed in ways that pointed at the route instead of at the fake.
  // The BOARD batches: WHERE deal_id = ANY($1). A different shape from the single-deal read, and the fake
  // modelled only the latter — so the board saw no payments at all, believed every schedule balanced, and
  // reported a deal as contract-ready that the form correctly called unbalanced. The board/form agreement
  // test is what surfaced it.
  if (/^SELECT deal_id, seq, label, amount_cents, due_trigger, due_date, status FROM sitenex_deal_payments WHERE deal_id = ANY/.test(s)) {
    const ids = (params[0] || []).map(String);
    return { rows: PAYMENTS.filter(p => ids.includes(String(p.deal_id)))
      .sort((a, b) => (a.deal_id - b.deal_id) || (a.seq - b.seq)) };
  }
  if (/^SELECT code, name, included, not_included FROM sitenex_packages WHERE code = ANY/.test(s)) {
    const codes = params[0] || [];
    return { rows: PACKAGES.filter(x => codes.includes(x.code)) };
  }
  if (/^SELECT .* FROM sitenex_deal_payments WHERE deal_id/.test(s)) {
    return { rows: PAYMENTS.filter(p => String(p.deal_id) === String(params[0])).sort((a, b) => a.seq - b.seq) };
  }
  if (/^DELETE FROM sitenex_deal_payments WHERE deal_id/.test(s)) {
    PAYMENTS = PAYMENTS.filter(p => String(p.deal_id) !== String(params[0]));
    return { rows: [] };
  }
  if (/^INSERT INTO sitenex_deal_payments/.test(s)) {
    PAYMENTS.push({ id: ++SEQ, deal_id: params[0], seq: params[1], label: params[2],
                    amount_cents: params[3], due_trigger: params[4], due_date: params[5], status: params[6] });
    return { rows: [] };
  }

  // ── contracts ──
  if (/nextval\('sitenex_contract_no_seq'\)/.test(s)) return { rows: [{ n: ++CONTRACT_SEQ }] };
  if (/FROM sitenex_contracts WHERE deal_id = \$1 ORDER BY id DESC/.test(s)) {
    return { rows: CONTRACTS.filter(c => String(c.deal_id) === String(params[0])) };
  }
  if (/SELECT id FROM sitenex_contracts WHERE deal_id = \$1 AND status <> 'superseded'/.test(s)) {
    return { rows: CONTRACTS.filter(c => String(c.deal_id) === String(params[0])
                                      && c.status !== 'superseded' && c.status !== 'void').map(c => ({ id: c.id })) };
  }
  if (/^INSERT INTO sitenex_contracts/.test(s)) {
    const row = { id: ++SEQ, contract_no: params[0], deal_id: params[1], partner_id: params[2],
                  client_company: params[3], client_contact: params[4], client_title: params[5],
                  client_email: params[6], client_phone: params[7], client_address: params[8],
                  partner_name: params[9], partner_email: params[10],
                  package_code: params[11], package_name: params[12], value_cents: params[15],
                  monthly_cents: params[16], duration_weeks: params[17],
                  template_version: params[21], file_name: params[22],
                  file_bytes: params[23], file_size: params[24], status: 'generated', generated_by: params[25],
                  superseded_by: null, sent_at: null, created_at: '2026-09-30T00:00:00Z' };
    CONTRACTS.push(row);
    return { rows: [{ id: row.id, contract_no: row.contract_no, status: row.status,
                      file_name: row.file_name, file_size: row.file_size, created_at: row.created_at }] };
  }
  // ── the send log + sent_at ──
  if (/^SELECT c\.id, c\.contract_no, c\.client_company/.test(s)) {
    const rows = visible(s, params, CONTRACTS).filter(c => String(c.id) === String(params[0]));
    return { rows };
  }
  if (/FROM sitenex_contract_sends WHERE contract_id/.test(s)) {
    return { rows: SENDS.filter(x => String(x.contract_id) === String(params[0])).slice().reverse() };
  }
  if (/^INSERT INTO sitenex_contract_sends/.test(s)) {
    const row = { id: ++SEQ, contract_id: params[0], contract_no: params[1], to_email: params[2],
                  cc_email: params[3], from_email: params[4], subject: params[5], file_name: params[6],
                  file_size: params[7], status: params[8], provider_id: params[9], error: params[10],
                  sent_by: params[11], sent_at: '2026-09-30T12:00:00Z' };
    SENDS.push(row);
    return { rows: [{ id: row.id, sent_at: row.sent_at }] };
  }
  if (/^UPDATE sitenex_contracts SET status = 'sent', sent_at = NOW\(\)/.test(s)) {
    const c = CONTRACTS.find(x => String(x.id) === String(params[0]));
    if (!c) return { rows: [] };
    c.status = 'sent'; c.sent_at = '2026-09-30T12:00:00Z';
    return { rows: [{ id: c.id, contract_no: c.contract_no, status: c.status, sent_at: c.sent_at }] };
  }
  if (/^UPDATE sitenex_contracts SET status='superseded'/.test(s)) {
    const c = CONTRACTS.find(x => String(x.id) === String(params[1]));
    if (c) { c.status = 'superseded'; c.superseded_by = params[0]; }
    return { rows: [] };
  }
  if (/^SELECT c\.id, c\.contract_no/.test(s)) {
    return { rows: visible(s, params, CONTRACTS).map(c => ({ ...c, generated_by_name: 'Admin', deal_status: 'new',
      partner_name: (PARTNERS.find(p => p.id === c.partner_id) || {}).name || null })) };
  }
  if (/SELECT contract_no, file_name, file_bytes, file_size FROM sitenex_contracts c/.test(s)) {
    const rows = visible(s, params, CONTRACTS).filter(c => String(c.id) === String(params[0]));
    return { rows };
  }
  if (/^UPDATE sitenex_contracts c SET status = \$3/.test(s)) {
    const rows = visible(s, params, CONTRACTS).filter(c => String(c.id) === String(params[0]));
    if (!rows.length) return { rows: [] };
    rows[0].status = params[params.length - 1];
    return { rows: [{ id: rows[0].id, contract_no: rows[0].contract_no, status: rows[0].status }] };
  }

  if (requiresScope(s)) scopeOf(s, params);   // force the leak check even on an unmatched shape
  throw new Error('unexpected SQL in fake: ' + s);
};
// The transaction client MIRRORS pg: its `query` is a METHOD that needs `this`. The first version handed
// out a plain `{ query: db.query }`, where a detached reference works fine — so `logSend(tx.query, …)`
// passed every test here and threw in production with "Cannot read properties of undefined (reading
// 'connectionParameters')", leaving an email sent and the status unmoved. A fake whose client is more
// forgiving than the real one cannot catch a `this` bug.
db.withTransaction = async (fn) => {
  if (MAIL.throwOnTxn) throw new Error('simulated commit failure');
  const client = {
    _isClient: true,
    async query(sql, params) {
      if (!this || this._isClient !== true) {
        throw new TypeError("Cannot read properties of undefined (reading 'connectionParameters')");
      }
      return db.query(sql, params);
    },
  };
  return fn(client);
};

// The mailer is replaced, not the network: this file must never be able to send a real email, whatever
// RESEND_API_KEY happens to be set to in the environment it runs in.
const mailer = require('../lib/mailer');
const realSend = mailer.sendEmailDetailed;
mailer.sendEmailDetailed = async (opts) => { MAIL.sent.push(opts); return MAIL.reply; };
after(() => { mailer.sendEmailDetailed = realSend; });
after(() => { db.query = realQuery; db.withTransaction = realTxn; });

const { signToken } = require('../lib/core');
const routes = require('./routes');
const phase3 = require('./sitenex-phase3.routes');
const app = express(); app.use(express.json()); app.use('/api', routes); app.use('/api', phase3);
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
beforeEach(() => { reset(); LOOKUP_FAILS = false; });

const tok = (id) => { const u = USERS.find(x => x.id === id); return signToken({ id: u.id, email: u.email, role: u.role }); };
const call = (method, path, who, body) => fetch(base() + path, {
  method, headers: { Authorization: 'Bearer ' + tok(who), 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})),
                      raw: r, type: r.headers.get('content-type') }));

const A_DEAL = 101, B_DEAL = 102, SELF_DEAL = 103;

// ── RULE 1: partner_id is NEVER taken from the body ───────────────────────────

test('partner_id in the body is IGNORED — it comes from the acting user, server-side', async () => {
  // The leak this prevents: a staff account (or a compromised one) writing a deal into a partner's book,
  // or a partner writing their own id onto a row to read it back. The body value is not validated, it is
  // ignored, which is why posting a wild value changes nothing rather than 400ing.
  const r = await call('POST', '/api/sitenex/deals', 'u-admin',
    { company_name: 'Injected Co', partner_id: PARTNER_B, status: 'new' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.deal.partner_id, null, 'staff create a self-sourced deal regardless of the body');
  const stored = DEALS.find(d => d.company_name === 'Injected Co');
  assert.equal(stored.partner_id, null, 'nothing from the body reached the column');
});

test('and PUT cannot move a deal into another partner\'s book either', async () => {
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin',
    { partner_id: PARTNER_B, company_name: 'Renamed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(DEALS.find(d => d.id === A_DEAL).partner_id, PARTNER_A, 'partner_id must be unchanged');
  assert.equal(DEALS.find(d => d.id === A_DEAL).company_name, 'Renamed', 'the legitimate field did change');
  assert.ok(!r.body.changed.includes('partner_id'), 'and it is not reported as changed');
});

test('partner_id is not even in the writable allowlist', () => {
  // Belt and braces at the source level: the allowlist is what the UPDATE is built from, so a future
  // edit that adds partner_id to it would be the whole bug in one line.
  const { DEAL_WRITABLE } = require('./sitenex-phase3.routes');
  assert.ok(!DEAL_WRITABLE.includes('partner_id'), 'partner_id must never be writable from a request');
  assert.ok(!DEAL_WRITABLE.includes('owner_user_id'), 'nor the owner');
  assert.ok(!DEAL_WRITABLE.includes('id'));
});

// ── RULE 2: every read is scoped, including single-row reads ───────────────────

test('GUARD: staff see all three deals, so an empty list below means scoping and not a broken fake', async () => {
  const r = await call('GET', '/api/sitenex/deals', 'u-admin');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 3);
  assert.equal(r.body.scope, 'all partners');
});

test('a partner sees only their own deals — and the OTHER partner sees only theirs', async () => {
  const a = await call('GET', '/api/sitenex/deals', 'u-pa');
  const b = await call('GET', '/api/sitenex/deals', 'u-pb');
  const ids = (body) => (body.columns || []).flatMap(c => c.deals.map(d => d.id)).sort();
  assert.deepEqual(ids(a.body), [A_DEAL], 'partner A');
  assert.deepEqual(ids(b.body), [B_DEAL], 'partner B');
  assert.equal(a.body.scope, 'own partner only');
  // Neither sees the self-sourced row. That is the assertion one fixture cannot make.
  assert.ok(!ids(a.body).includes(SELF_DEAL) && !ids(b.body).includes(SELF_DEAL));
});

test("the SINGLE-ROW read is scoped too — Partner B cannot fetch A's deal by guessing an integer", async () => {
  // A list that scopes and a GET /:id that does not is the same leak with one more step.
  assert.equal((await call('GET', `/api/sitenex/deals/${A_DEAL}`, 'u-pb')).status, 404);
  assert.equal((await call('GET', `/api/sitenex/deals/${B_DEAL}`, 'u-pb')).status, 200);
  assert.equal((await call('GET', `/api/sitenex/deals/${SELF_DEAL}`, 'u-pb')).status, 404);
  assert.equal((await call('GET', `/api/sitenex/deals/${A_DEAL}`, 'u-admin')).status, 200);
});

test('404 and "not yours" are indistinguishable, so the register cannot be enumerated', async () => {
  // A 403 on someone else's row differs from a 404 only in confirming the row exists.
  const mine = await call('GET', `/api/sitenex/deals/${A_DEAL}`, 'u-pb');
  const nothing = await call('GET', '/api/sitenex/deals/99999', 'u-pb');
  assert.equal(mine.status, nothing.status);
  assert.deepEqual(mine.body, nothing.body);
});

test('a partner with NO partner_id sees nothing, not everything', async () => {
  const r = await call('GET', '/api/sitenex/deals', 'u-broken');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 0);
  assert.equal(r.body.scope, 'none');
});

test('and if the partner lookup FAILS, the answer is no rows', async () => {
  LOOKUP_FAILS = true;
  const r = await call('GET', '/api/sitenex/deals', 'u-pa');
  assert.equal(r.body.total, 0, 'fail closed — "could not tell" is not "show everything"');
});

// ── writes are adminOnly ──────────────────────────────────────────────────────

test('a PARTNER cannot write: every write is adminOnly, decided deliberately', async () => {
  // READS are requireTier('sitenex'), which a partner holds. Gating a write on the tier alone would let
  // an outside account create deals and generate contracts under our terms.
  const writes = [
    ['POST', '/api/sitenex/deals', { company_name: 'X' }],
    ['PUT', `/api/sitenex/deals/${A_DEAL}`, { company_name: 'X' }],
    ['PUT', `/api/sitenex/deals/${A_DEAL}/payments`, { payments: [] }],
    ['POST', '/api/sitenex/contracts', { deal_id: A_DEAL }],
    ['PUT', '/api/sitenex/contracts/1', { status: 'sent' }],
  ];
  for (const [m, p, b] of writes) {
    const r = await call(m, p, 'u-pa', b);
    assert.equal(r.status, 403, `${m} ${p} must be refused for a partner, got ${r.status}`);
  }
  // And the reads it DOES hold still work, so this is a gate and not a lockout.
  assert.equal((await call('GET', '/api/sitenex/deals', 'u-pa')).status, 200);
  assert.equal((await call('GET', '/api/sitenex/contracts', 'u-pa')).status, 200);
});

test('every non-GET route in this router carries adminOnly, at the source level', () => {
  // The HTTP test above can only check the routes it knows about. This one fails when a new write is
  // added without the gate, which is the case nobody remembers.
  const src = require('fs').readFileSync(__dirname + '/sitenex-phase3.routes.js', 'utf8');
  const decls = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)',([^\n]*)/g)];
  assert.ok(decls.length >= 10, `only ${decls.length} routes found — the scanner has stopped working`);
  for (const [, method, path, rest] of decls) {
    if (method === 'get') continue;
    assert.ok(/adminOnly/.test(rest), `${method.toUpperCase()} ${path} is a write without adminOnly`);
  }
});

// ── the deal write path ───────────────────────────────────────────────────────

test('POST creates a deal with the client details and defaults status to new', async () => {
  const r = await call('POST', '/api/sitenex/deals', 'u-admin', {
    company_name: 'New Client LLC', contact_name: 'Sam Reed', contact_email: 'sam@new.example',
    client_address: '7 Elm St, Aurora, IL', package_code: 'P2', duration_weeks: 3, value_cents: 300000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.deal.status, 'new');
  assert.equal(r.body.deal.company_name, 'New Client LLC');
  assert.equal(r.body.deal.value_usd, 3000, 'dollars are derived, not stored');
  assert.equal(r.body.deal.starts_at_intake, true, 'the standing arrangement is the default');
  assert.equal(r.body.deal.owner_user_id ?? 'u-admin', 'u-admin');
});

test('starts_at_intake can be set FALSE explicitly, but is never silently flipped', async () => {
  const r = await call('POST', '/api/sitenex/deals', 'u-admin',
    { company_name: 'Sig Co', starts_at_intake: false });
  assert.equal(r.body.deal.starts_at_intake, false);
  const u = await call('PUT', `/api/sitenex/deals/${r.body.deal.id}`, 'u-admin', { starts_at_intake: true });
  assert.equal(u.body.deal.starts_at_intake, true);
});

test('an unknown status is refused, with the vocabulary named', async () => {
  const r = await call('POST', '/api/sitenex/deals', 'u-admin', { company_name: 'X', status: 'nurture' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Unknown status 'nurture'/);
  assert.match(r.body.error, /proposal_sent/);
});

test('a non-numeric money value is refused rather than stored as NaN', async () => {
  const r = await call('POST', '/api/sitenex/deals', 'u-admin', { company_name: 'X', value_cents: 'lots' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /value_cents must be a number/);
});

test('PUT reports WHAT CHANGED, and refuses an empty update', async () => {
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', { status: 'proposal_sent', terms_note: 'note' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed.sort(), ['status', 'terms_note']);
  assert.equal((await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', {})).status, 400);
});

// ── the payment schedule, and the sum rule ────────────────────────────────────

test('a schedule that sums to the deal value is accepted', async () => {
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments: [
    { label: 'Deposit', amount_cents: 225000, due_trigger: 'on_signature' },
    { label: 'On launch', amount_cents: 225000, due_trigger: 'on_launch' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total_cents, 450000);
  assert.deepEqual(r.body.payments.map(p => p.seq), [1, 2], 'seq is assigned by position, not by the client');
});

test('a schedule that does NOT sum to the value is REFUSED, with the difference named', async () => {
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments: [
    { label: 'Deposit', amount_cents: 225000, due_trigger: 'on_signature' }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'unbalanced_schedule');
  assert.match(r.body.error, /\$2,250/);
  assert.match(r.body.error, /\$4,500/);
  assert.match(r.body.error, /under by \$2,250/);
  assert.equal(PAYMENTS.length, 0, 'and NOTHING was written — not even the valid row');
});

test('over by a single cent is still refused', async () => {
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments: [
    { label: 'All of it', amount_cents: 450001, due_trigger: 'on_signature' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /over by \$0.01/);
});

test('an EMPTY schedule is allowed — it clears the plan', async () => {
  await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments: [
    { label: 'Deposit', amount_cents: 450000, due_trigger: 'on_signature' }] });
  assert.equal(PAYMENTS.length, 1);
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments: [] });
  assert.equal(r.status, 200);
  assert.equal(PAYMENTS.length, 0, 'cleared');
});

test('a schedule on a deal with NO value is refused — there is nothing to add up to', async () => {
  const made = await call('POST', '/api/sitenex/deals', 'u-admin', { company_name: 'No Value Co' });
  const r = await call('PUT', `/api/sitenex/deals/${made.body.deal.id}/payments`, 'u-admin',
    { payments: [{ label: 'Deposit', amount_cents: 1000 }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'no_total');
});

test("a 'date' trigger with no date is refused — it would print beside a blank", async () => {
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments: [
    { label: 'Balance', amount_cents: 450000, due_trigger: 'date' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /needs a due_date/);
});

test('installment validation: label required, amount positive, triggers and statuses known', async () => {
  const cases = [
    [[{ amount_cents: 450000 }], /label is required/],
    [[{ label: 'X' }], /amount_cents is required/],
    [[{ label: 'X', amount_cents: -5 }], /must be positive/],
    [[{ label: 'X', amount_cents: 450000, due_trigger: 'whenever' }], /unknown due_trigger/],
    [[{ label: 'X', amount_cents: 450000, status: 'maybe' }], /unknown status/],
  ];
  for (const [payments, re] of cases) {
    const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments });
    assert.equal(r.status, 400, JSON.stringify(payments));
    assert.match(r.body.error, re);
    assert.match(r.body.error, /installment 1/, 'the error says WHICH installment');
  }
  assert.equal((await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', {})).status, 400);
});

test('changing the deal VALUE under an existing schedule is refused, not silently unbalanced', async () => {
  // Otherwise the deal is left in a state where contract generation fails with an error about the
  // schedule, pointing at the wrong edit.
  await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments: [
    { label: 'Deposit', amount_cents: 450000, due_trigger: 'on_signature' }] });
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', { value_cents: 600000 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'unbalanced_schedule');
  assert.equal(DEALS.find(d => d.id === A_DEAL).value_cents, 450000, 'and the value is unchanged');
  // With no schedule, the same edit is fine.
  await call('PUT', `/api/sitenex/deals/${A_DEAL}/payments`, 'u-admin', { payments: [] });
  assert.equal((await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', { value_cents: 600000 })).status, 200);
});

// ── contracts ────────────────────────────────────────────────────────────────

test('generating a contract produces a numbered row and real .docx bytes', async () => {
  const r = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.contract.contract_no, /^SN-\d{4}-0\d{3}$/);
  assert.equal(r.body.contract.status, 'generated');
  assert.ok(r.body.contract.file_size > 5000, 'a real document, not an empty one');
  const stored = CONTRACTS[0];
  assert.equal(stored.file_bytes.subarray(0, 4).toString('hex'), '504b0304', 'the bytes must be a .docx');
  // SNAPSHOT: the client details are copied onto the contract row, not joined.
  assert.equal(stored.client_company, 'Acme Machine Works LLC');
  assert.equal(stored.package_name, 'P2 · Renew');
});

test('a snapshot does NOT follow a later change to the deal', async () => {
  // The whole reason the register snapshots: a corrected address must not rewrite history.
  await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  const before = CONTRACTS[0].client_company;
  await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', { company_name: 'Acme Renamed Ltd' });
  assert.equal(CONTRACTS[0].client_company, before, 'the signed document said the old name, and still does');
  assert.equal(DEALS.find(d => d.id === A_DEAL).company_name, 'Acme Renamed Ltd');
});

test('REGENERATION makes a new row and supersedes the old one — never overwrites', async () => {
  const first = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  const second = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  assert.equal(second.status, 201);
  assert.equal(CONTRACTS.length, 2, 'two rows, not one edited');
  assert.notEqual(second.body.contract.contract_no, first.body.contract.contract_no);
  const old = CONTRACTS.find(c => c.id === first.body.contract.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.superseded_by, second.body.contract.id, 'and it says WHICH contract replaced it');
  assert.deepEqual(second.body.superseded, [first.body.contract.id]);
  assert.match(second.body.note, /superseded/);
});

test('generation REFUSES on a deal missing client details, before taking a number', async () => {
  // Checked before nextval, so a refused attempt does not burn SN-2026-0004 and leave a gap in the
  // register that reads as a deleted contract.
  const made = await call('POST', '/api/sitenex/deals', 'u-admin', { company_name: 'Bare Co' });
  const before = CONTRACT_SEQ;
  const r = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: made.body.deal.id });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'missing_fields');
  assert.ok(r.body.missing.length > 1, 'and names them all');
  assert.equal(CONTRACT_SEQ, before, 'the sequence was NOT advanced by a refused attempt');
  assert.equal(CONTRACTS.length, 0);
});

test('generation refuses when the schedule does not balance', async () => {
  // Reachable because a schedule can be written and the value changed through other paths; the renderer
  // is the last gate before bytes exist.
  PAYMENTS.push({ id: 1, deal_id: A_DEAL, seq: 1, label: 'Part', amount_cents: 1000, status: 'due' });
  const r = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'unbalanced_schedule');
});

test('the contract file downloads with the right type and name, and is partner-scoped', async () => {
  const made = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  const id = made.body.contract.id;
  const r = await fetch(`${base()}/api/sitenex/contracts/${id}/file`,
    { headers: { Authorization: 'Bearer ' + tok('u-admin') } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /wordprocessingml\.document/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="SN-\d{4}-\d{4}-Acme/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304');
  // Partner B cannot download Partner A's contract.
  assert.equal((await call('GET', `/api/sitenex/contracts/${id}/file`, 'u-pb')).status, 404);
  // Partner A can download their own.
  const own = await fetch(`${base()}/api/sitenex/contracts/${id}/file`,
    { headers: { Authorization: 'Bearer ' + tok('u-pa') } });
  assert.equal(own.status, 200, 'the partner whose deal it is may download it');
});

test('a download with NO Authorization header is 401 — a bare href would not work', async () => {
  // Which is why the UI must fetch with the header and click a blob anchor.
  const made = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  const r = await fetch(`${base()}/api/sitenex/contracts/${made.body.contract.id}/file`);
  assert.equal(r.status, 401);
});

test("'superseded' cannot be set by hand — it is set by generating a replacement", async () => {
  const made = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  const r = await call('PUT', `/api/sitenex/contracts/${made.body.contract.id}`, 'u-admin', { status: 'superseded' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'not_settable');
  // The real statuses are settable.
  assert.equal((await call('PUT', `/api/sitenex/contracts/${made.body.contract.id}`, 'u-admin', { status: 'sent' })).status, 200);
  assert.equal((await call('PUT', `/api/sitenex/contracts/${made.body.contract.id}`, 'u-admin', { status: 'nope' })).status, 400);
});

// ── the register's totals ─────────────────────────────────────────────────────

test('the register totals signed one-time, monthly, annualised and pipeline', async () => {
  const mk = (over) => { CONTRACTS.push({ id: ++SEQ, deal_id: A_DEAL, partner_id: PARTNER_A,
    client_company: 'X', status: 'generated', value_cents: 0, monthly_cents: 0, superseded_by: null, ...over }); };
  mk({ status: 'signed', value_cents: 450000, monthly_cents: 9900 });
  mk({ status: 'signed', value_cents: 200000, monthly_cents: 0 });
  mk({ status: 'sent', value_cents: 100000 });
  mk({ status: 'generated', value_cents: 50000 });
  mk({ status: 'superseded', value_cents: 999999, monthly_cents: 99999 });
  mk({ status: 'void', value_cents: 888888 });
  const r = await call('GET', '/api/sitenex/contracts', 'u-admin');
  const t = r.body.totals;
  assert.equal(t.signed_count, 2);
  assert.equal(t.signed_one_time_cents, 650000);
  assert.equal(t.signed_monthly_cents, 9900);
  assert.equal(t.annualised_cents, 650000 + 9900 * 12, 'one-time plus twelve months of the retainer');
  assert.equal(t.pipeline_count, 2, 'generated + sent');
  assert.equal(t.pipeline_cents, 150000);
  // A SUPERSEDED row is in no total: it is the same commercial fact as its replacement, and counting
  // both would double the book.
  assert.equal(t.superseded_count, 2, 'superseded and void are both excluded');
  assert.ok(t.signed_one_time_cents < 999999, 'the superseded value must not be counted');
});

test('a partner sees only their own contracts, and their totals reflect only those', async () => {
  CONTRACTS.push({ id: 1, deal_id: A_DEAL, partner_id: PARTNER_A, client_company: 'A', status: 'signed',
                   value_cents: 100000, monthly_cents: 0, superseded_by: null });
  CONTRACTS.push({ id: 2, deal_id: B_DEAL, partner_id: PARTNER_B, client_company: 'B', status: 'signed',
                   value_cents: 700000, monthly_cents: 0, superseded_by: null });
  const a = await call('GET', '/api/sitenex/contracts', 'u-pa');
  assert.equal(a.body.total, 1);
  assert.equal(a.body.totals.signed_one_time_cents, 100000, "not the other partner's 700000");
  assert.equal(a.body.scope, 'own partner only');
  assert.equal((await call('GET', '/api/sitenex/contracts', 'u-admin')).body.totals.signed_one_time_cents, 800000);
});

// ── the prospect content route ────────────────────────────────────────────────

test('the content route returns a call script and an email for one prospect', async () => {
  const r = await call('GET', '/api/sitenex/prospects/9001/content', 'u-admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.call.led_with, 'no_viewport', 'ranked by penalty, heaviest first');
  assert.match(r.body.call.opening, /on my phone/);
  assert.deepEqual(r.body.call.what_this_is_not, PACKAGES[0].not_included, 'the caller gets the exclusions');
  assert.ok(r.body.email.subject.includes('Acme Machine'));
  assert.equal(r.body.call.priced, false, 'the package is unpriced, so it says so');
  assert.equal((await call('GET', '/api/sitenex/prospects/999999/content', 'u-admin')).status, 404);
});

test('a partner may read the content for a prospect — it is the script for the call', async () => {
  assert.equal((await call('GET', '/api/sitenex/prospects/9001/content', 'u-pa')).status, 200);
});

// ── mount order ──────────────────────────────────────────────────────────────

test('no path is declared in BOTH routers — the second mount would be dead code', () => {
  // routes.js mounts first, so a duplicate declaration here is unreachable. This is how GET
  // /api/sitenex/deals was nearly left serving the old payload with the new handler never running.
  const fs = require('fs');
  const pathsOf = (file) => new Set([...fs.readFileSync(__dirname + '/' + file, 'utf8')
    .matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)].map(m => `${m[1].toUpperCase()} ${m[2]}`));
  const a = pathsOf('routes.js'), b = pathsOf('sitenex-phase3.routes.js');
  const both = [...b].filter(p => a.has(p));
  assert.deepEqual(both, [], `declared in both routers, so the Phase 3 one never runs: ${both.join(', ')}`);
});

// ── EMAILING A CONTRACT ───────────────────────────────────────────────────────
//
// The one irreversible action in these screens. A wrong address or a wrong price has reached a real
// business and cannot be recalled, so the refusals are tested harder than the happy path.
//
// Nothing here can send a real email: the mailer is replaced above, and a test asserts the route resolves
// it at call time rather than capturing it at require time — which is what would make that replacement
// silently ineffective.

async function makeSendableContract() {
  const made = await call('POST', '/api/sitenex/contracts', 'u-admin', { deal_id: A_DEAL });
  const c = CONTRACTS.find(x => x.id === made.body.contract.id);
  c.client_email = 'dale@acme.example';
  c.partner_email = 'a@partnera.example';
  return c;
}

test('the PREVIEW names the recipient, the cc, the sender and the price before anything is sent', async () => {
  const c = await makeSendableContract();
  const r = await call('GET', `/api/sitenex/contracts/${c.id}/send`, 'u-admin');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.to, 'dale@acme.example');
  assert.equal(r.body.cc, 'a@partnera.example', 'the partner on the contract is cc’d');
  assert.match(r.body.from, /naren@adificetechnologies\.com/, 'the AUTHORIZED domain — abiozen.com 403s');
  assert.match(r.body.subject, /SN-\d{4}-\d{4} — agreement for Acme Machine Works LLC/);
  assert.match(r.body.price, /\$4,500/);
  assert.equal(r.body.can_send, true);
  assert.equal(MAIL.sent.length, 0, 'a PREVIEW must not send anything');
});

test('the preview says WHY it cannot send, rather than offering a button that fails', async () => {
  const c = await makeSendableContract();
  c.client_email = null;
  let r = await call('GET', `/api/sitenex/contracts/${c.id}/send`, 'u-admin');
  assert.equal(r.body.can_send, false);
  assert.match(r.body.blocked_because, /no client email/);
  c.client_email = 'dale@acme.example';
  c.status = 'superseded';
  r = await call('GET', `/api/sitenex/contracts/${c.id}/send`, 'u-admin');
  assert.equal(r.body.can_send, false);
  assert.match(r.body.blocked_because, /superseded/);
});

test('a send REQUIRES the address to be echoed back', async () => {
  // The browser confirm() is a courtesy, not the safeguard — it is one devtools line away. Requiring the
  // address means a request built by anything other than the screen that displayed it cannot send to an
  // address nobody saw.
  const c = await makeSendableContract();
  for (const body of [{}, { confirm_to: '' }, { confirm_to: 'someone@else.example' }]) {
    const r = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'confirm_mismatch');
    assert.equal(r.body.to, 'dale@acme.example', 'and it names the real address so the caller can correct it');
  }
  assert.equal(MAIL.sent.length, 0, 'nothing was sent');
  // Case and surrounding space do not count as a mismatch — that would be a confusing refusal, not a safe one.
  const ok = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', { confirm_to: '  DALE@Acme.Example ' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('a successful send attaches the stored .docx, base64, with the right name', async () => {
  const c = await makeSendableContract();
  const r = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', { confirm_to: 'dale@acme.example' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(MAIL.sent.length, 1);
  const m = MAIL.sent[0];
  assert.equal(m.to, 'dale@acme.example');
  assert.equal(m.cc, 'a@partnera.example');
  assert.match(m.from, /naren@adificetechnologies\.com/);
  assert.equal(m.replyTo, m.from, 'a reply must come back to a real person, not to no-reply');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, c.file_name);
  // The BYTES from the register, not a regeneration — the client must receive the document the register
  // holds, or the two disagree about what was sent.
  assert.ok(Buffer.isBuffer(m.attachments[0].content));
  assert.equal(m.attachments[0].content.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(m.attachments[0].content.length, c.file_size);
  // The covering note is short and states the price.
  assert.match(m.html, /\$4,500/);
  assert.match(m.html, /sign and return/i);
  assert.ok(m.html.length < 1600, `the note should be short, got ${m.html.length} chars`);
});

test('a successful send sets status AND sent_at — not one without the other', async () => {
  // Otherwise the register's "sent" count depends on somebody remembering to change a dropdown, which
  // they will not, and the register is then quietly wrong about what has reached a client.
  const c = await makeSendableContract();
  assert.equal(c.status, 'generated');
  assert.equal(c.sent_at, null);
  const r = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', { confirm_to: 'dale@acme.example' });
  assert.equal(r.body.contract.status, 'sent');
  assert.ok(r.body.contract.sent_at, 'sent_at must be stamped');
  assert.equal(c.status, 'sent');
  assert.ok(c.sent_at);
});

test('the send is LOGGED with everything needed to prove what went where', async () => {
  const c = await makeSendableContract();
  const r = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', { confirm_to: 'dale@acme.example' });
  assert.equal(SENDS.length, 1);
  const log = SENDS[0];
  assert.equal(log.contract_id, c.id);
  assert.equal(log.contract_no, c.contract_no, 'snapshot, so the log reads without a join');
  assert.equal(log.to_email, 'dale@acme.example');
  assert.equal(log.cc_email, 'a@partnera.example');
  assert.match(log.from_email, /adificetechnologies\.com/);
  assert.match(log.subject, /agreement for/);
  assert.equal(log.status, 'sent');
  assert.equal(log.provider_id, 'msg_fake_1', "the provider's id, which is the only external proof");
  assert.equal(log.sent_by, 'u-admin');
  assert.ok(log.sent_at);
  assert.equal(r.body.provider_id, 'msg_fake_1', 'and it comes back to the caller');
});

test('a FAILED send is logged too, and marks nothing as sent', async () => {
  // "We tried twice and both bounced" is exactly the question this log exists to answer.
  const c = await makeSendableContract();
  MAIL.reply = { ok: false, id: null, error: 'Resend said no' };
  const r = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', { confirm_to: 'dale@acme.example' });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'send_failed');
  assert.match(r.body.error, /Resend said no/);
  assert.equal(SENDS.length, 1, 'the attempt is recorded');
  assert.equal(SENDS[0].status, 'failed');
  assert.equal(SENDS[0].error, 'Resend said no');
  assert.equal(SENDS[0].provider_id, null);
  assert.equal(c.status, 'generated', 'and the contract is NOT marked sent');
  assert.equal(c.sent_at, null);
});

test('if the email goes but the DB write fails, it says SO — loudly', async () => {
  // The hardest case. An HTTP call to a provider cannot be rolled back, so a COMMIT failing after a
  // successful send would otherwise return an error that reads as "it did not send" — and somebody would
  // press the button again, sending a second copy to a client.
  const c = await makeSendableContract();
  MAIL.throwOnTxn = true;
  const r = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', { confirm_to: 'dale@acme.example' });
  assert.equal(r.status, 500);
  assert.equal(r.body.code, 'sent_but_not_recorded');
  assert.equal(r.body.sent, true, 'the response must assert the email DID go');
  assert.equal(r.body.provider_id, 'msg_fake_1');
  assert.match(r.body.error, /WAS sent to dale@acme\.example/);
  assert.match(r.body.error, /by hand/, 'and says what to do about it');
  assert.equal(MAIL.sent.length, 1, 'exactly one email left');
});

test('a superseded or void contract cannot be emailed', async () => {
  const c = await makeSendableContract();
  for (const status of ['superseded', 'void']) {
    c.status = status;
    const r = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', { confirm_to: 'dale@acme.example' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'not_current');
    assert.match(r.body.error, /no way to know it is not the agreement/);
  }
  assert.equal(MAIL.sent.length, 0);
});

test('a contract with no client email refuses, and says regeneration is the fix', async () => {
  // The address is SNAPSHOT at generation, so editing the deal does not change this document.
  const c = await makeSendableContract();
  c.client_email = null;
  const r = await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-admin', { confirm_to: 'x@y.example' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'no_recipient');
  assert.match(r.body.error, /regenerate/);
});

test('sending is adminOnly and partner-scoped', async () => {
  const c = await makeSendableContract();
  // A partner cannot send at all — it is a write.
  assert.equal((await call('POST', `/api/sitenex/contracts/${c.id}/send`, 'u-pa', { confirm_to: 'dale@acme.example' })).status, 403);
  assert.equal((await call('GET', `/api/sitenex/contracts/${c.id}/send`, 'u-pa')).status, 403);
  assert.equal(MAIL.sent.length, 0);
  // And a staff account cannot send a contract outside its scope — scope is TRUE for staff here, so the
  // meaningful half is that the route reads through the same scoped SELECT as everything else.
  assert.equal((await call('POST', '/api/sitenex/contracts/999999/send', 'u-admin', { confirm_to: 'x@y.example' })).status, 404);
});

test('the route resolves the mailer at CALL time, so a test cannot fail to replace it', () => {
  // A destructured `const { sendEmailDetailed } = require('../lib/mailer')` is captured when the module
  // loads, before any test runs — so replacing it afterwards does nothing and the suite would send real
  // email to whatever address a fixture carried, if RESEND_API_KEY happened to be set.
  const src = require('fs').readFileSync(__dirname + '/sitenex-phase3.routes.js', 'utf8');
  assert.ok(!/const\s*\{[^}]*sendEmailDetailed[^}]*\}\s*=\s*require/.test(src),
    'the mailer must not be destructured at module load');
  assert.match(src, /mailer\(\)\.sendEmailDetailed\(/, 'it must be resolved at call time');
});

test('generating does NOT send — they are separate actions', async () => {
  // Never automatic. Generating is reversible; sending is not.
  await makeSendableContract();
  assert.equal(MAIL.sent.length, 0, 'POST /contracts must not email anybody');
  const src = require('fs').readFileSync(__dirname + '/sitenex-phase3.routes.js', 'utf8');
  const gen = src.slice(src.indexOf("router.post('/sitenex/contracts',"), src.indexOf("router.get('/sitenex/contracts/:id/file'"));
  assert.ok(!/sendEmail/.test(gen), 'the generate handler must contain no send');
});

// ── can_create: the server says who may write ─────────────────────────────────

test('the board reports can_create, so the client never computes the rule itself', async () => {
  // The board is visible to super_admin, admin AND partner (the sitenex tier) but only the first two may
  // POST a deal. A copy of that rule in the SPA is a copy that can disagree with the gate.
  for (const who of ['u-admin', 'u-super']) {
    const r = await call('GET', '/api/sitenex/deals', who);
    assert.equal(r.body.can_create, true, `${who} may create`);
  }
  const p = await call('GET', '/api/sitenex/deals', 'u-pa');
  assert.equal(p.body.can_create, false, 'a partner may not');
  // And the FLAG IS NOT THE GATE — the route refuses regardless of what any client was told.
  assert.equal((await call('POST', '/api/sitenex/deals', 'u-pa', { company_name: 'X' })).status, 403);
});

test('a deal created from a prospect alone leaves the client fields EMPTY', async () => {
  // The new-deal flow posts only a prospect_id. company_name is deliberately not seeded from
  // prospects.name: that is the Google Places listing, frequently abbreviated or stylised, and this field
  // goes on a contract. The form offers it as a placeholder instead.
  const r = await call('POST', '/api/sitenex/deals', 'u-admin', { prospect_id: 9001 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.deal.prospect_id, 9001, 'the link is made');
  assert.equal(r.body.deal.company_name, undefined, 'and nothing is invented for the contract');
  assert.equal(r.body.deal.status, 'new');
  // Which means the contract is correctly NOT yet generatable, and the form will say what is missing.
  const detail = await call('GET', `/api/sitenex/deals/${r.body.deal.id}`, 'u-admin');
  assert.equal(detail.body.renderable.ok, false);
  assert.ok(detail.body.renderable.missing.some(m => m.field === 'client_company'));
});

// ── the board and the form must give the SAME answer about a contract ──────────

test('contract_ready on the board EQUALS renderable.ok on the deal page, deal for deal', () => {
  // Not asserted by inspection but by comparison, over deals in deliberately different states. If the board
  // ever grows its own cheaper "is this ready" predicate, this is what fails.
  return (async () => {
    // A deal with everything.
    const whole = await call('POST', '/api/sitenex/deals', 'u-admin', {
      company_name: 'Whole Co', contact_name: 'A Person', contact_email: 'a@whole.example',
      client_address: '1 Whole St, Chicago, IL', package_code: 'P2', duration_weeks: 3, value_cents: 100000 });
    // A deal with nothing but a prospect.
    const bare = await call('POST', '/api/sitenex/deals', 'u-admin', { prospect_id: 9001 });
    // A deal that looks complete but has an unbalanced schedule.
    const unbal = await call('POST', '/api/sitenex/deals', 'u-admin', {
      company_name: 'Unbalanced Co', contact_name: 'B Person', contact_email: 'b@u.example',
      client_address: '2 Odd St, Chicago, IL', package_code: 'P2', duration_weeks: 3, value_cents: 500000 });
    PAYMENTS.push({ id: 999, deal_id: unbal.body.deal.id, seq: 1, label: 'Part', amount_cents: 1000, status: 'due' });

    const board = await call('GET', '/api/sitenex/deals', 'u-admin');
    const flat = (board.body.columns || []).flatMap(c => c.deals);
    assert.ok(flat.length >= 3, 'the fixtures must be on the board');

    for (const card of flat) {
      const detail = await call('GET', `/api/sitenex/deals/${card.id}`, 'u-admin');
      assert.equal(card.contract_ready, detail.body.renderable.ok,
        `deal ${card.id}: the board says contract_ready=${card.contract_ready} and the form says ` +
        `renderable.ok=${detail.body.renderable.ok} — they must be the same answer`);
      if (!card.contract_ready) {
        assert.equal(card.blocked_reason, detail.body.renderable.code, `deal ${card.id}: and the same reason`);
        assert.deepEqual(card.missing, (detail.body.renderable.missing || []).map(m => m.label),
          `deal ${card.id}: and the same list`);
      }
    }
    // And the three states really were different, or the comparison proved nothing.
    const byId = Object.fromEntries(flat.map(c => [c.id, c]));
    assert.equal(byId[whole.body.deal.id].contract_ready, true, 'the complete deal is ready');
    assert.equal(byId[bare.body.deal.id].contract_ready, false, 'the bare one is not');
    assert.equal(byId[bare.body.deal.id].blocked_reason, 'missing_fields');
    assert.equal(byId[unbal.body.deal.id].contract_ready, false, 'nor the unbalanced one');
    assert.equal(byId[unbal.body.deal.id].blocked_reason, 'unbalanced_schedule',
      'and an unbalanced schedule is reported as THAT, not as a missing field');
  })();
});

test('the board computes readiness for every deal WITHOUT a query per deal', async () => {
  // N+1 on a board is how a screen gets slow quietly. The package and payment lookups are batched, so the
  // count must not grow with the number of deals.
  const countFor = async (n) => {
    reset();
    for (let i = 0; i < n; i++) {
      DEALS.push({ id: 900 + i, partner_id: null, owner_user_id: 'u-admin', status: 'new', package_code: 'P2',
                   company_name: 'Co ' + i, value_cents: 1000, duration_weeks: 3 });
    }
    await call('GET', '/api/sitenex/deals', 'u-admin');
    // Counted from the fake's own log, because the route captured db.query at require time.
    return SQL_LOG.filter(q => /sitenex_deal_payments|sitenex_packages|sitenex_deals/.test(q)).length;
  };
  const few = await countFor(2);
  const many = await countFor(20);
  assert.equal(few, many,
    `the query count grew with the number of deals (${few} for 2, ${many} for 20) — the lookups are not batched`);
});

// ── the stage clock ───────────────────────────────────────────────────────────

test('status_changed_at moves on a REAL status change and on nothing else', async () => {
  // updated_at already answers "when was this last touched". Treating the two as the same thing is how
  // "days in current stage" becomes "days since somebody fixed a typo".
  const updates = () => SQL_LOG.filter(q => /^UPDATE sitenex_deals SET/.test(q));
  SQL_LOG = [];
  await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', { status: 'proposal_sent' });
  assert.ok(updates().some(q => /status_changed_at = NOW\(\)/.test(q)), 'a status change must move the clock');
  SQL_LOG = [];
  await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', { terms_note: 'a typo fix' });
  assert.ok(updates().length > 0, 'the edit itself must have happened');
  assert.ok(!updates().some(q => /status_changed_at/.test(q)), 'editing another field must NOT move it');
  SQL_LOG = [];
  // Re-selecting the SAME status is not a move either.
  await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', { status: 'proposal_sent' });
  assert.ok(updates().length > 0, 'the update still ran');
  assert.ok(!updates().some(q => /status_changed_at/.test(q)), 're-selecting the same status is not a change');
});

test('`changed` reports what the CALLER changed, not bookkeeping columns', async () => {
  // It is shown to the user as "Saved: …". Naming status_changed_at there claims the system did something
  // it was not asked to; updated_at was never listed either, so this keeps the two consistent.
  const r = await call('PUT', `/api/sitenex/deals/${A_DEAL}`, 'u-admin', { status: 'contacted', terms_note: 'x' });
  assert.deepEqual(r.body.changed.sort(), ['status', 'terms_note']);
  assert.ok(!r.body.changed.includes('status_changed_at'));
  assert.ok(!r.body.changed.includes('updated_at'));
});
