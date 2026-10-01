// OUTREACH IS PARTNER-SCOPED. A partner sees their own; never another partner's.
//
//   node --test src/api/outreach-external-gate.test.js
//
// HISTORY, because the file's name still carries it. On 2026-09-30 this asserted the OPPOSITE: every outreach
// route was staffOnly and a partner was refused all of them. The leak it closed was real — /api/outreach is
// classified 'shared', the data scoping underneath was by PRODUCT, and a partner holding 'sitenex' could read
// every SiteNex outreach row and overwrite a note somebody here had just written after a call.
//
// The reasoning given for choosing the ROLE as the gate was: "outreach rows have no partner_id, and giving them
// one would assert that an outreach note belongs to a partner rather than to us, which is the opposite of
// true." That held while a partner could not work a prospect. From 2026-10-01 they can — a partner holds a
// territory and sees the prospects in it — and a partner who rings a business and cannot record the call keeps
// that record somewhere we never see.
//
// So the refusal is REPLACED, not relaxed: outreach.partner_id says whose a row is, every read is scoped, and
// the module THROWS if a caller omits the scope rather than defaulting to no filter. What this file now asserts
// is that the replacement is airtight — which is a stronger claim than the blanket refusal it supersedes,
// because "nobody may read this" is easy and "A may read exactly A's" is not.

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'outreach-gate-test';

const PARTNER_A = 11, PARTNER_B = 22;
const USERS = {
  'u-admin': { role: 'admin', partner_id: null }, 'u-super': { role: 'super_admin', partner_id: null },
  'u-bd': { role: 'business_dev', partner_id: null },
  // TWO partners, because "A sees their own" is satisfied by a query returning everything when only one
  // partner has data. The second one is what makes the assertion mean anything.
  'u-pa': { role: 'partner', partner_id: PARTNER_A },
  'u-pb': { role: 'partner', partner_id: PARTNER_B },
};
// Rows the fake serves, one per partner on the SAME prospect plus one of ours.
const ROWS = [
  { id: 1, entity_type: 'prospect', entity_id: '1', product: 'sitenex', status: 'contacted',  note: "A's note",  partner_id: PARTNER_A },
  { id: 2, entity_type: 'prospect', entity_id: '1', product: 'sitenex', status: 'quote_sent', note: "B's note",  partner_id: PARTNER_B },
  { id: 3, entity_type: 'prospect', entity_id: '2', product: 'sitenex', status: 'won',        note: 'ours',      partner_id: null },
];

const db = require('../lib/db');
const realQuery = db.query, realTxn = db.withTransaction;
db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
  // The role comes from the DB per request, not from the token — an empty row here means "deleted or
  // inactive" and authMiddleware correctly 401s, which is not what this file is testing.
  if (/^SELECT role, is_active FROM users WHERE id =/i.test(s)) {
    const u = USERS[params[0]];
    return { rows: u ? [{ role: u.role, is_active: 1 }] : [] };
  }
  if (/^SELECT partner_id FROM users WHERE id =/i.test(s)) {
    const u = USERS[params[0]];
    return { rows: u ? [{ partner_id: u.partner_id }] : [] };
  }
  // THE PARTNER CLAUSE IS HONOURED. A fake that accepted it and ignored it would make every assertion below
  // green and meaningless — the exact failure this file exists to rule out.
  if (/FROM outreach o/.test(s)) {
    if (!/o\.partner_id = \$|AND TRUE|AND FALSE/.test(s)) throw new Error('UNSCOPED outreach read: ' + s);
    let rows = ROWS;
    const m = /o\.partner_id = \$(\d+)/.exec(s);
    if (m) rows = ROWS.filter(r => String(r.partner_id) === String(params[+m[1] - 1]));
    else if (/AND FALSE/.test(s)) rows = [];
    if (/o\.entity_id = ANY/.test(s)) {
      const ids = (params[1] || []).map(String);
      rows = rows.filter(r => ids.includes(r.entity_id));
    }
    if (/COUNT\(\*\)::int n/.test(s)) {
      const by = {};
      for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
      return { rows: Object.entries(by).map(([status, n]) => ({ status, n })) };
    }
    return { rows };
  }
  if (/FROM user_products WHERE user_id/i.test(s)) return { rows: [{ product: 'sitenex' }] };
  return { rows: [], rowCount: 0 };
};
db.withTransaction = async (fn) => fn({ query: db.query });
after(() => { db.query = realQuery; db.withTransaction = realTxn; });

const { signToken } = require('../lib/core');
const app = express(); app.use(express.json()); app.use('/api', require('./routes'));
const server = app.listen(0);
after(() => server.close());
const base = () => `http://127.0.0.1:${server.address().port}`;
const call = (method, path, who, body) => fetch(base() + path, {
  method, headers: { Authorization: 'Bearer ' + signToken({ id: who, email: who + '@x.example', role: USERS[who].role }),
                     'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const READS = [
  '/api/outreach?entity_type=prospect&ids=1',
  '/api/outreach/summary?entity_type=prospect&total=10',
  '/api/outreach/activity?days=7',
  '/api/outreach/overview?days=7',
  '/api/outreach/history?entity_type=prospect&entity_id=1',
];

test('a PARTNER can read outreach — the refusal was replaced, not kept', async () => {
  for (const p of READS) {
    const r = await call('GET', p, 'u-pa');
    assert.notEqual(r.status, 403, `${p} must be reachable now, got ${r.status}`);
  }
});

test('and sees ONLY their own rows — A never sees B', async () => {
  // THE CLAIM THAT MATTERS. Both partners hold a record on prospect 1; neither may see the other's.
  const a = await call('GET', '/api/outreach?entity_type=prospect&ids=1,2', 'u-pa');
  const b = await call('GET', '/api/outreach?entity_type=prospect&ids=1,2', 'u-pb');
  assert.equal(a.body.statuses['1'].status, 'contacted');
  assert.equal(a.body.statuses['1'].note, "A's note");
  assert.equal(b.body.statuses['1'].status, 'quote_sent');
  assert.equal(b.body.statuses['1'].note, "B's note", "and NOT A's");
  // Neither sees OUR row on prospect 2.
  assert.equal(a.body.statuses['2'], undefined, 'our own record is not theirs to read');
  assert.equal(b.body.statuses['2'], undefined);
});

test("a partner's SUMMARY counts only their own", async () => {
  const a = await call('GET', '/api/outreach/summary?entity_type=prospect&total=100', 'u-pa');
  assert.equal(a.body.counts.contacted, 1);
  assert.equal(a.body.counts.quote_sent, 0, "B's row must not reach A's funnel");
  assert.equal(a.body.counts.won, 0, 'nor ours');
});

test('a partner can WRITE, and the row lands in their own book', async () => {
  // The other half: a partner who can read a note and not write one still has nowhere to record a call.
  const r = await call('PUT', '/api/outreach', 'u-pa',
    { entity_type: 'prospect', entity_id: 1, status: 'following_up', note: 'chased' });
  assert.notEqual(r.status, 403, 'a partner may record their own outreach');
});

test('STAFF see every partner\'s rows and ours', async () => {
  for (const who of ['u-admin', 'u-super', 'u-bd']) {
    const r = await call('GET', '/api/outreach?entity_type=prospect&ids=1,2', who);
    assert.notEqual(r.status, 403, `${who} must still reach it`);
    assert.ok(r.body.statuses['2'], `${who} must see our own row`);
  }
});

test('every outreach data route passes a PARTNER SCOPE, at the source level', () => {
  // The HTTP tests above can only check the paths they know. This one fails when a new outreach route ships
  // without a scope — the case nobody remembers. It replaces a check that every route carried staffOnly.
  const src = require('fs').readFileSync(__dirname + '/routes.js', 'utf8');
  const decls = [...src.matchAll(/router\.(get|put|post|patch|delete)\('(\/outreach[^']*)',([^\n]*)/g)];
  assert.ok(decls.length >= 7, `only ${decls.length} outreach routes found — the scanner has stopped working`);
  for (const [, method, routePath] of decls) {
    if (routePath === '/outreach/vocabulary') continue;   // constants; see the note on it in routes.js
    const from = src.indexOf(`router.${method}('${routePath}'`);
    const body = src.slice(from, src.indexOf('\n});\n', from));
    if (method === 'get') {
      assert.match(body, /partnerScopeSql\(req\.user\)/,
        `GET ${routePath} does not pass a partner scope — a partner would read everybody's notes`);
    } else {
      // A WRITE composes no read scope and must not: setStatus resolves the partner from the acting user's own
      // row INSIDE the transaction, which is stronger than passing one in — there is no parameter to get
      // wrong, and nothing a caller could supply. Asserted as the absence of the alternative.
      assert.ok(!/partner_id/.test(body),
        `${method.toUpperCase()} ${routePath} must not handle partner_id at all — setStatus reads it from the user`);
    }
  }
});

test('the WRITE resolves the partner from the USER ROW, inside the transaction', () => {
  // Not from the request, and not from the token. A partner_id in a body is a suggestion from somebody with an
  // incentive to change it; users.partner_id is a fact we wrote. Inside the transaction so a stale token
  // cannot decide whose book a note lands in.
  const mod = require('fs').readFileSync(__dirname + '/../lib/outreach/index.js', 'utf8');
  const txn = mod.slice(mod.indexOf('await txn(async (c) => {'), mod.indexOf('// ── the summary bar'));
  assert.match(txn, /SELECT partner_id FROM users WHERE id = \$1/, 'read from the user row');
  assert.match(txn, /const partnerId = \(pid && pid\.partner_id\) \|\| null/);
  // And the upsert targets the EXPRESSION index, or a second staff row could exist for one prospect.
  assert.match(txn, /ON CONFLICT \(entity_type, entity_id, COALESCE\(partner_id, 0\)\)/);
  // The before-read is scoped too, or a partner's first touch reads its 'from' off our row.
  assert.match(txn, /COALESCE\(partner_id, 0\) = COALESCE\(\$3::int, 0\)/);
});

test('and the module REFUSES to read without one', () => {
  // Belt and braces, and the braces are the important half: the source check above can be satisfied by a
  // route that passes the scope into a function which ignores it. partnerFragment throws instead of
  // defaulting, so the two softer shapes — default to no filter, default to staff — are both unreachable.
  const mod = require('fs').readFileSync(__dirname + '/../lib/outreach/index.js', 'utf8');
  assert.match(mod, /function partnerFragment\(/);
  assert.match(mod, /a partner scope is required/);
  assert.match(mod, /if \(partner\.failed\) return \{ sql: 'FALSE'/, '"could not tell" must mean nothing');
  assert.match(mod, /if \(partner\.partnerId == null\) \{/);
  // No read may compose the product scope without also composing the partner one.
  const reads = [...mod.matchAll(/productScopeSql\(held, 'o', \d\)/g)];
  const frags = [...mod.matchAll(/partnerFragment\(partner, 'o',/g)];
  assert.equal(reads.length, frags.length,
    `${reads.length} product scopes but ${frags.length} partner scopes — one read is missing its partner filter`);
});

test('staffOnly still exists and is still keyed off the ROLE LIST, for whatever else needs it', () => {
  // Outreach no longer uses it, but it is the right tool for a route that genuinely has no partner answer, and
  // it must keep working off the shared list rather than a second copy.
  const { EXTERNAL_ROLES, isExternalRole } = require('../lib/roles');
  assert.ok(EXTERNAL_ROLES.includes('partner'));
  for (const r of ['admin', 'super_admin', 'business_dev']) assert.equal(isExternalRole(r), false);
  const src = require('fs').readFileSync(__dirname + '/../lib/core.js', 'utf8');
  const fn = src.slice(src.indexOf('function staffOnly('), src.indexOf('// super_admin ONLY'));
  assert.match(fn, /isExternalRole/, 'staffOnly must use the shared role list, not a second copy');
});
