// ROW-LEVEL PARTNER SCOPING — Partner A must never see Partner B's deals.
//   node --test src/api/partner-deal-scope.test.js
//
// TWO PARTNER FIXTURES, because one proves nothing. With a single partner, a query that returns
// everything and a query that returns their own rows are indistinguishable — every row in the table
// happens to be theirs. The second partner is what makes the assertion real.
//
// The product boundary cannot do this job: every partner on SiteNex holds the 'sitenex' product, so it
// admits all of them to /api/sitenex/deals and is right to. Which ROWS is a separate question, answered
// in the WHERE clause.

process.env.JWT_SECRET = 'test-secret';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const PARTNER_A = 1, PARTNER_B = 2;   // deliberately not named after a real partner:
                                      // the property is about ANY two partners, not about ACBM
let USERS = [], DEALS = [];
function reset() {
  USERS = [
    { id: 'u-staff',  email: 'naren@abiozen.com', role: 'super_admin', is_active: 1, partner_id: null },
    { id: 'u-admin',  email: 'pras@x.com',        role: 'admin',       is_active: 1, partner_id: null },
    { id: 'u-pa',     email: 'a@partner-a.test', role: 'partner',     is_active: 1, partner_id: PARTNER_A },
    { id: 'u-pb',     email: 'b@partner-b.test', role: 'partner',     is_active: 1, partner_id: PARTNER_B },
    { id: 'u-orphan', email: 'nopartner@x.test',  role: 'partner',     is_active: 1, partner_id: null },
  ];
  // Statuses must be real SITENEX_DEAL_STATUSES values, or the board's per-status columns filter every
  // row out and an empty result looks like correct scoping.
  DEALS = [
    { id: 10, partner_id: PARTNER_A,  status: 'new',           updated_at: 5 },
    { id: 11, partner_id: PARTNER_A,  status: 'proposal_sent', updated_at: 4 },
    { id: 12, partner_id: PARTNER_B, status: 'new',           updated_at: 3 },
    { id: 13, partner_id: PARTNER_B, status: 'signed',        updated_at: 2 },
    { id: 14, partner_id: null,  status: 'live',          updated_at: 1 },   // self-sourced: ours, not theirs
  ];
}
reset();

let LOOKUP_FAILS = false;
const db = require('../lib/db');
db.query = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/UPDATE users SET last_login/i.test(s)) return { rows: [] };
  if (/^SELECT role, is_active FROM users WHERE id =/i.test(s)) {
    const u = USERS.find(x => x.id === params[0]);
    return { rows: u ? [{ role: u.role, is_active: 1 }] : [] };
  }
  if (/^SELECT partner_id FROM users WHERE id =/i.test(s)) {
    if (LOOKUP_FAILS) throw new Error('connection reset');
    const u = USERS.find(x => x.id === params[0]);
    return { rows: u ? [{ partner_id: u.partner_id }] : [] };
  }
  if (/FROM sitenex_deals d/i.test(s)) {
    // Apply the WHERE fragment the handler built, the way Postgres would.
    let rows = DEALS.slice();
    if (/WHERE FALSE/i.test(s)) rows = [];
    else if (/WHERE TRUE/i.test(s)) { /* staff: everything */ }
    else {
      const m = /WHERE d\.partner_id = \$(\d+)/.exec(s);
      assert.ok(m, 'the deals query must be scoped by partner_id: ' + s);
      const want = params[+m[1] - 1];
      rows = rows.filter(r => r.partner_id === want);
    }
    return { rows: rows.sort((a, b) => b.updated_at - a.updated_at) };
  }
  if (/FROM user_products/i.test(s)) return { rows: [{ product: 'sitenex' }] };
  return { rows: [] };
};

const { signToken } = require('../lib/core');
const router = require('./routes');
// BOTH routers, in the same order as server.js. GET /api/sitenex/deals now lives in the Phase 3 router,
// so mounting only the first one 404s it — and a 404 on a scoping test reads as "no rows visible", which
// is the shape of a passing scoping assertion. Mounting both is what keeps these tests about scoping.
const phase3 = require('./sitenex-phase3.routes');
const app = express(); app.use(express.json()); app.use('/api', router); app.use('/api', phase3);
const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
beforeEach(() => { reset(); LOOKUP_FAILS = false; });

const tok = (id) => { const u = USERS.find(x => x.id === id); return signToken({ id: u.id, email: u.email, role: u.role }); };
const deals = (id) => fetch(base() + '/api/sitenex/deals', { headers: { Authorization: 'Bearer ' + tok(id) } })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const idsIn = (body) => (body.columns || []).flatMap(c => c.deals.map(d => d.id)).sort((a, b) => a - b);

// ── the property ────────────────────────────────────────────────────────────────
test('GUARD: staff see all five fixtures — so an empty board below means scoping, not a broken fake', async () => {
  const r = await deals('u-staff');
  assert.equal(r.status, 200);
  assert.deepEqual(idsIn(r.body), [10, 11, 12, 13, 14]);
});

test('a partner sees ONLY their own deals', async () => {
  const r = await deals('u-pa');
  assert.equal(r.status, 200);
  assert.deepEqual(idsIn(r.body), [10, 11]);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.scope, 'own partner only');
});

test("and the OTHER partner sees only theirs — the assertion one fixture cannot make", async () => {
  const r = await deals('u-pb');
  assert.deepEqual(idsIn(r.body), [12, 13]);
  assert.equal(r.body.total, 2);
});

test('neither partner sees the other, in either direction', async () => {
  const a = idsIn((await deals('u-pa')).body);
  const b = idsIn((await deals('u-pb')).body);
  assert.equal(a.filter(id => b.includes(id)).length, 0, 'the two views must not overlap at all');
  assert.ok(!a.includes(12) && !a.includes(13), 'partner A must not see partner B rows');
  assert.ok(!b.includes(10) && !b.includes(11), 'partner B must not see partner A rows');
});

test('a self-sourced deal (partner_id NULL) belongs to us and reaches NO partner', async () => {
  // `partner_id = $1` is already false for NULL, which is why the fragment is not written as an
  // `IS NULL OR`. Asserted so nobody "improves" it into one.
  for (const who of ['u-pa', 'u-pb']) {
    assert.ok(!idsIn((await deals(who)).body).includes(14), `${who} must not see the self-sourced deal`);
  }
});

test('staff see every partner, including the self-sourced row', async () => {
  for (const who of ['u-staff', 'u-admin']) {
    const r = await deals(who);
    assert.deepEqual(idsIn(r.body), [10, 11, 12, 13, 14], `${who} sees everything`);
    assert.equal(r.body.scope, 'all partners');
  }
});

// ── the ways it could go wrong ──────────────────────────────────────────────────
test('a partner cannot widen their view with a query string', async () => {
  // The scope comes from users.partner_id, which we wrote. Anything in the request is a suggestion from
  // someone with an incentive to change it.
  for (const qs of ['?partner_id=2', '?partner_id=', '?partner_id=1&partner_id=2', '?scope=all']) {
    const r = await fetch(base() + '/api/sitenex/deals' + qs, { headers: { Authorization: 'Bearer ' + tok('u-pa') } });
    const body = await r.json();
    assert.deepEqual(idsIn(body), [10, 11], `${qs} must change nothing`);
  }
});

test('a MISCONFIGURED partner account (no partner_id) sees nothing, not everything', async () => {
  // partner_id NULL means staff for a staff row and MISCONFIGURED for an external role, and treating
  // those the same would hand a half-created partner account every partner's pipeline. The role is the
  // tiebreak in this one place — safe now that authMiddleware reads the role from the database rather
  // than the token.
  const r = await deals('u-orphan');
  assert.equal(r.status, 200);
  assert.deepEqual(idsIn(r.body), [], 'an empty board they can ask about, not somebody else\'s pipeline');
  assert.equal(r.body.scope, 'none');
});

test('the tiebreak is the EXTERNAL-role list, so the next partner role inherits it', async () => {
  const { EXTERNAL_ROLES } = require('../lib/roles');
  assert.ok(EXTERNAL_ROLES.includes('partner'), "'partner' must be an external role for the guard above to fire");
  // And a staff role with no partner_id is still staff — the guard must not narrow our own people.
  const staffScope = await partnerScopeSql({ id: 'u-admin', role: 'admin' }, 'd', 1, { query: db.query });
  assert.equal(staffScope.sql, 'TRUE');
});

test('if the partner lookup FAILS, the answer is no rows', async () => {
  LOOKUP_FAILS = true;
  const r = await deals('u-pa');
  assert.equal(r.status, 200);
  assert.deepEqual(idsIn(r.body), [], 'fail closed: an error must narrow to nothing, never widen');
  assert.equal(r.body.scope, 'none');
});

// ── the unit, directly ──────────────────────────────────────────────────────────
const { partnerScopeSql } = require('../lib/products/partner-scope');
const asUser = (id) => USERS.find(u => u.id === id);

test('the fragment composes after an existing parameter', async () => {
  const s = await partnerScopeSql(asUser('u-pa'), 'd', 3, { query: db.query });
  assert.equal(s.sql, 'd.partner_id = $3');
  assert.deepEqual(s.params, [PARTNER_A]);
  assert.equal(s.nextIndex, 4);
});

test('staff get TRUE and a partner gets a comparison — never a silently absent clause', async () => {
  // A scope helper that returned '' for staff would leave `WHERE ` dangling in the SQL, and the first
  // person to copy the pattern to a second table would get a syntax error or, worse, a stray AND.
  assert.equal((await partnerScopeSql(asUser('u-staff'), 'd', 1, { query: db.query })).sql, 'TRUE');
  assert.match((await partnerScopeSql(asUser('u-pa'), 'd', 1, { query: db.query })).sql, /^d\.partner_id = \$1$/);
});

test('prospects are scoped by TERRITORY, never by partner ownership', async () => {
  // A decision, not an omission, and the distinction survived the 2026-10-01 reversal: a partner now SEES
  // prospects, but no partner OWNS one. The list is our lead list and the question is which rows fall inside
  // the patch we granted them — territoryScopeSql — not whose row it is. If prospects ever grow a partner_id
  // this test should fail and be read, because that would be a different claim about who the leads belong to.
  const fs = require('fs');
  const routes = fs.readFileSync(__dirname + '/routes.js', 'utf8');
  const from = routes.indexOf("router.get('/sitenex/prospects'");
  assert.notEqual(from, -1, 'the prospects route has moved — find it before asserting about it');
  // Bounded by the HANDLER'S OWN END (the first column-0 `});`), not by "the next router." — a comment
  // written between this handler and the following route was being read as part of this handler's body,
  // and a sentence mentioning partner_id in prose failed a test about a WHERE clause.
  const end = routes.indexOf('\n});\n', from);
  assert.notEqual(end, -1, 'could not find the end of the prospects handler');
  // COMMENTS BLANKED. The handler now explains, in prose, why outreach carries a partner_id — and a check
  // for the string `partner_id` duly failed on the explanation. Fourth time a comment has broken a
  // source-reading test here, hence the shared stripper.
  const body = require('../lib/spa-source').stripJsComments(routes.slice(from, end));
  assert.ok(!/partnerScopeSql/.test(body), 'the prospects route must not be partner-scoped');
  assert.ok(!/partner_id/.test(body), 'and must not filter on partner_id — a prospect is not owned by a partner');
  // What it IS scoped by, asserted positively so "not partner-scoped" cannot be satisfied by being unscoped.
  assert.match(body, /territoryScopeSql/, 'it must be territory-scoped');
});
