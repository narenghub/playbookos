// OUTREACH — one system, every list.
//   node --test src/lib/outreach/outreach.test.js
//
// The two properties that carry the design:
//   1. 'not_contacted' NEEDS NO ROW, so every count has to ADD the untracked remainder. Reading 'not_contacted' out of the
//      table reports 0 over a list of 1,524 untouched prospects — the status bar's whole job, wrong.
//   2. THE EVENTS TABLE IS THE POINT. Current status says 50 rows are 'contacted'; only the log says
//      Vinitha contacted 50 companies last week. A status change without an event must be unreachable.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { STATUS_DEFS, STATUSES, DEFAULT_STATUS, CHANNELS, ENTITIES, isStatus, isChannel } = require('./registry');
const { statusFor, setStatus, summary, activity, history } = require('./index');

// ── a fake that behaves like the table, including the unique constraint ─────────
let OUTREACH = [], EVENTS = [], ENTITY_ROWS = {}, SEQ = 1, DEALS = [], FIXTURE_PARTNER_ID = 7;
function reset() {
  OUTREACH = []; EVENTS = []; SEQ = 1; DEALS = []; FIXTURE_PARTNER_ID = 7;
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
    const [entity_type, entity_id, product, status, owner, note, next, touched, channel] = params;
    // The ON CONFLICT behaviour for `channel` is READ OUT OF THE SQL, not reimplemented here. That
    // distinction is the whole value of this fake: when I modelled COALESCE in JS instead, changing the
    // real statement to `channel = EXCLUDED.channel` — which erases a known channel on any status change
    // that supplies none — broke nothing, because the fake preserved it either way. A fake that restates
    // the semantics agrees with the code whether or not the code is right.
    const coalesced = /channel = COALESCE\(EXCLUDED\.channel, outreach\.channel\)/.test(s);
    let row = OUTREACH.find(x => x.entity_type === entity_type && x.entity_id === entity_id);
    if (row) {
      Object.assign(row, { status, product, owner_user_id: owner || row.owner_user_id,
        channel: coalesced && channel == null ? row.channel : (channel || null),
        note: note != null ? note : row.note, next_action_at: next || null,
        last_contacted_at: touched ? 'NOW' : row.last_contacted_at, updated_at: 'NOW' });
    } else {
      row = { id: SEQ++, entity_type, entity_id, product, status, channel: channel || null,
              owner_user_id: owner || null, note: note || null,
              next_action_at: next || null, last_contacted_at: touched ? 'NOW' : null, updated_at: 'NOW' };
      OUTREACH.push(row);
    }
    return { rows: [row] };
  }
  // The partner lookup the won-hook now does, so the deal lands in the right book. Modelled on the
  // USERS fixture rather than stubbed to null, so the test below can assert the id actually travels.
  if (/^SELECT partner_id FROM users WHERE id = \$1$/.test(s)) {
    return { rows: [{ partner_id: FIXTURE_PARTNER_ID }] };
  }
  if (/^SELECT id, status FROM sitenex_deals WHERE prospect_id/.test(s)) {
    const d = DEALS.find(x => String(x.prospect_id) === String(params[0]));
    return { rows: d ? [d] : [] };
  }
  if (/^INSERT INTO sitenex_deals/.test(s)) {
    // status is read out of the SQL rather than hardcoded: the literal is the thing under test, and a
    // fake that asserts its own copy of it would agree with the code whichever value the code used.
    const status = (/VALUES \(\$1::bigint, '(\w+)'/.exec(s) || [])[1] || null;
    const d = { id: DEALS.length + 100, prospect_id: params[0], status,
                owner_user_id: params[1], partner_id: params[2] === undefined ? null : params[2] };
    DEALS.push(d);
    return { rows: [d] };
  }
  if (/^INSERT INTO outreach_events/.test(s)) {
    const [outreach_id, from_status, to_status, by_user_id, by_email, note, channel] = params;
    EVENTS.push({ id: EVENTS.length + 1, outreach_id, from_status, to_status, channel: channel || null,
                  by_user_id, by_email, note, created_at: Date.now() });
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
      const k = `${e.by_email}|${e.to_status}|${e.channel}|${o.entity_type}`;
      if (!out.has(k)) out.set(k, { person: e.by_email, by_user_id: e.by_user_id, by_email: e.by_email,
                                    to_status: e.to_status, channel: e.channel,
                                    entity_type: o.entity_type, n: 0, last_at: 0 });
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
test('ten statuses, in FUNNEL order, with an explicit sort_order', () => {
  assert.deepEqual(STATUSES, ['not_contacted', 'contacted', 'following_up', 'no_response', 'in_conversation',
                              'quote_sent', 'contract_sent', 'won', 'not_interested', 'disqualified']);
  assert.equal(DEFAULT_STATUS, 'not_contacted');
  // sort_order is EXPLICIT, not array position: the bar reads as a funnel and array order is easy to disturb.
  assert.deepEqual(STATUS_DEFS.map(s => s.order), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(isStatus('nurture'), false, 'not in the vocabulary');
  assert.equal(isStatus('interested'), false, 'retired: it was a feeling, not a stage');
  assert.equal(isStatus('new'), false, 'renamed to not_contacted, which says what it means');
});

test('the array order and sort_order AGREE, so neither can silently become the odd one out', () => {
  // Two orderings exist: this array, and the explicit sort_order the bar renders by. They are allowed to be
  // two things, but they are not allowed to DISAGREE — a reorder of one without the other would make the
  // funnel read wrong while every other test still passed.
  const bySortOrder = STATUS_DEFS.slice().sort((a, b) => a.order - b.order).map(s => s.key);
  assert.deepEqual(STATUSES, bySortOrder);
});

test('every status earns its place by implying a DIFFERENT next action', () => {
  // The test for whether a status belongs. Two stages sharing a next action are one stage.
  const nexts = STATUS_DEFS.map(s => s.next);
  const dupes = nexts.filter((n, i) => nexts.indexOf(n) !== i && !/^nothing/.test(n));
  assert.deepEqual(dupes, [], `these stages share a next action, so they are not distinct stages: ${dupes}`);
  for (const d of STATUS_DEFS) {
    assert.ok(d.means && d.next && d.label, `${d.key} needs means, next and label`);
  }
});

test('CHANNEL is a separate axis, not more statuses', () => {
  // Folding these into the status list would give emailed_no_reply vs called_no_reply and double it.
  assert.deepEqual(CHANNELS, ['email', 'phone', 'linkedin', 'in_person', 'other']);
  for (const c of CHANNELS) assert.equal(isStatus(c), false, `${c} must NOT be a status`);
  for (const st of STATUSES) assert.equal(isChannel(st), false, `${st} must NOT be a channel`);
});

test('an unknown status is refused at the edge, since there is no CHECK constraint', async () => {
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'nurture' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_status');
  assert.match(r.error, /One of: not_contacted, contacted, following_up/);
  assert.equal(OUTREACH.length, 0);
  assert.equal(EVENTS.length, 0);
});

test('the migration must NOT add a CHECK on status', () => {
  const src = require('fs').readFileSync(__dirname + '/../../../scripts/migrate-outreach.js', 'utf8');
  const create = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS outreach ('), src.indexOf('CREATE INDEX'));
  assert.ok(!/CHECK/i.test(create), 'inquiries.status shipped with one and it had to be dropped');
  assert.match(src, /COMMENT ON COLUMN outreach\.status/, 'the vocabulary lives in a comment instead');
});

// ── 'not_contacted' needs no row ──────────────────────────────────────────────────────────
test("an untouched entity is 'not_contacted' with no row written", async () => {
  const map = await statusFor('prospect', [1, 2], STAFF, deps);
  assert.deepEqual(map, {}, 'nothing tracked yet');
  assert.equal(OUTREACH.length, 0);
});

test('the summary ADDS the untracked remainder as not_contacted', async () => {
  // The bug this prevents: reading 'not_contacted' out of the table reports 0 over 1,524 untouched prospects.
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  const s = await summary('prospect', { held: STAFF, totalEntities: 1524 }, deps);
  assert.equal(s.counts.contacted, 1);
  assert.equal(s.counts.not_contacted, 1523, '1524 total minus the 1 that has a row');
  assert.equal(s.tracked, 1);
  assert.equal(Object.values(s.counts).reduce((a, b) => a + b, 0), 1524, 'the bar accounts for every row');
});

test('with no total supplied, the remainder is not invented', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  const s = await summary('prospect', { held: STAFF }, deps);
  assert.equal(s.counts.not_contacted, 0, 'better zero than a wrong number');
  assert.equal(s.total, null);
});

test('a status outside the vocabulary is still COUNTED, not dropped', async () => {
  // The column has no CHECK, so a value could arrive from SQL. Dropping it would silently lose rows from
  // a bar that is supposed to account for all of them.
  OUTREACH.push({ id: 99, entity_type: 'prospect', entity_id: '2', product: 'golfnex', status: 'nurture' });
  const s = await summary('prospect', { held: STAFF, totalEntities: 10 }, deps);
  assert.equal(s.counts.nurture, 1);
  assert.equal(s.counts.not_contacted, 9);
});

// ── every change is an event ─────────────────────────────────────────────────────
test('a status change writes the row AND the event, with who and from-what', async () => {
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'contacted', note: 'left a voicemail' });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'not_contacted', 'no row before, so it came from new');
  assert.equal(r.to, 'contacted');
  assert.equal(EVENTS.length, 1);
  assert.deepEqual([EVENTS[0].from_status, EVENTS[0].to_status, EVENTS[0].by_email, EVENTS[0].note],
    ['not_contacted', 'contacted', 'vinitha@abiozen.com', 'left a voicemail']);
});

test('a second change logs the real transition, not new again', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  await set({ entityType: 'prospect', entityId: 1, status: 'quote_sent' });
  assert.equal(OUTREACH.length, 1, 'one row per entity — the unique constraint');
  assert.deepEqual(EVENTS.map(e => `${e.from_status}→${e.to_status}`), ['not_contacted→contacted', 'contacted→quote_sent']);
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

// ── CHANNEL: the second field ───────────────────────────────────────────────────
test('channel is written to BOTH the row and the event', async () => {
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'contacted', channel: 'phone' });
  assert.equal(r.channel, 'phone');
  assert.equal(OUTREACH[0].channel, 'phone', 'the row says how we last touched them');
  assert.equal(EVENTS[0].channel, 'phone', 'the event says how we touched them THAT time');
});

test('a later status change with NO channel does not erase the last known one', async () => {
  // "How we last touched them" is not "how we touched them in the most recent status edit". Moving a row
  // to quote_sent from the desk must not wipe the fact that the last contact was a phone call.
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted', channel: 'phone' });
  await set({ entityType: 'prospect', entityId: 1, status: 'quote_sent' });
  assert.equal(OUTREACH[0].channel, 'phone', 'the row keeps it');
  assert.equal(EVENTS[1].channel, null, 'but the event records that THIS change had none');
});

test('channel is OPTIONAL — a status change is not always a touch', async () => {
  // Disqualifying a chain from the desk has no channel. Inventing 'other' would make by_channel a lie.
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'disqualified' });
  assert.equal(r.ok, true);
  assert.equal(r.channel, null);
  assert.equal(OUTREACH[0].channel, null, 'NULL, not a guess');
});

test('a SUPPLIED channel outside the vocabulary is refused, and nothing is written', async () => {
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'contacted', channel: 'carrier_pigeon' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_channel');
  assert.match(r.error, /One of: email, phone, linkedin, in_person, other/);
  assert.equal(OUTREACH.length, 0, 'the status change is refused too — not half-applied');
  assert.equal(EVENTS.length, 0);
});

test('a channel is NOT a status and cannot be passed as one', async () => {
  // The whole point of two fields: 'email' must not be settable as a stage.
  // vocabulary-guard: deliberate — this writes a channel as a status in order to assert it is refused.
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'email' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_status');
});

// ── the summary bar reads as a FUNNEL ───────────────────────────────────────────
test('the summary returns statuses in funnel order, not alphabetically or by count', async () => {
  await set({ entityType: 'prospect', entityId: 2, status: 'won', channel: 'in_person' });
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted', channel: 'email' });
  const s = await summary('prospect', { held: STAFF, totalEntities: 1524 }, deps);
  const bySortOrder = STATUS_DEFS.slice().sort((a, b) => a.order - b.order).map(d => d.key);
  const keys = Object.keys(s.counts).filter(k => isStatus(k));
  // Asserted against sort_order, NOT against STATUSES — the bar must follow the numbers, and comparing it
  // to the array would pass even if sort_order were ignored entirely.
  assert.deepEqual(keys, bySortOrder, 'alphabetical would put contacted before not_contacted');
  assert.deepEqual(s.order, bySortOrder);
  // The drop-off between adjacent columns is the thing to act on, so the order has to be the funnel's.
  assert.deepEqual(s.funnel.map(f => f.key), bySortOrder);
  assert.ok(s.funnel.every(f => f.label && f.means && f.next), 'the bar gets its tooltips from the registry');
});

test('activity groups by channel, counting the unrecorded rather than dropping it', async () => {
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted', channel: 'phone' });
  await set({ entityType: 'prospect', entityId: 2, status: 'contacted', channel: 'phone' });
  await set({ entityType: 'prospect', entityId: 1, status: 'quote_sent', channel: 'email' });
  await set({ entityType: 'prospect', entityId: 2, status: 'disqualified' });        // no channel
  const a = await activity({ held: STAFF, sinceDays: 7 }, deps);
  assert.deepEqual(a.people[0].by_channel, { phone: 2, email: 1, '(not recorded)': 1 },
    'four events, four counted — a NULL channel is a fact, not a row to drop');
  assert.equal(a.people[0].total, 4);
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
  const r = await set({ entityType: 'lead', entityId: 'lead-a', status: 'in_conversation' });
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
  await set({ entityType: 'prospect', entityId: 1, status: 'quote_sent' });
  await setStatus({ entityType: 'institution', entityId: 10, status: 'contacted',
    user: { id: 'u-n', email: 'naren@abiozen.com' }, held: STAFF }, deps);

  const a = await activity({ held: STAFF, sinceDays: 7 }, deps);
  const v = a.people.find(p => p.person === 'vinitha@abiozen.com');
  assert.equal(v.total, 3, 'three changes by Vinitha');
  assert.deepEqual(v.by_status, { contacted: 2, quote_sent: 1 });
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
    assert.deepEqual(vocab.body.status_keys, STATUSES, 'the dropdown reads the vocabulary, not a second copy');
    // The client needs sort_order over the wire, or it re-derives the funnel and the two copies drift.
    assert.deepEqual(vocab.body.statuses.map(x => [x.key, x.order]), STATUS_DEFS.map(x => [x.key, x.order]));
    assert.ok(vocab.body.statuses.every(x => x.label && x.means && x.next), 'labels and tooltips come from the server');
    assert.deepEqual(vocab.body.channels.map(c => c.key), CHANNELS, 'channel is its own list, served alongside');
    assert.ok(vocab.body.channels.every(c => c.label), 'channel labels come from the server too');
    assert.equal(Object.keys(vocab.body.entity_types).length, 6);

    const put = await call('PUT', '/api/outreach',
      { entity_type: 'prospect', entity_id: 1, status: 'contacted', note: 'called, left a message' });
    assert.equal(put.status, 200);
    assert.deepEqual([put.body.from, put.body.to], ['not_contacted', 'contacted']);

    const get = await call('GET', '/api/outreach?entity_type=prospect&ids=1,2');
    assert.equal(get.body.statuses['1'].status, 'contacted');
    assert.equal(get.body.statuses['2'], undefined, 'untouched rows are absent, i.e. new');

    const sum = await call('GET', '/api/outreach/summary?entity_type=prospect&total=1524');
    assert.equal(sum.body.counts.contacted, 1);
    assert.equal(sum.body.counts.not_contacted, 1523, 'the bar gets the real untouched count, not 0');

    const act = await call('GET', '/api/outreach/activity?days=7');
    assert.equal(act.body.people[0].person, 'vinitha@abiozen.com');
    assert.equal(act.body.people[0].total, 1);

    const hist = await call('GET', '/api/outreach/history?entity_type=prospect&entity_id=1');
    assert.equal(hist.body.events.length, 1);

    // THE ROUTE MUST PASS `deal` THROUGH. setStatus returns it and the cell renders "deal #N created" from
    // it; omitting it made the whole won → sitenex_deals link invisible — the deal appeared on the board
    // with nothing on screen to say so. The module test above cannot see this: it calls setStatus directly.
    const won = await call('PUT', '/api/outreach', { entity_type: 'prospect', entity_id: 3, status: 'won' });
    assert.equal(won.status, 200);
    assert.ok(won.body.deal, 'the response must carry the deal');
    assert.equal(won.body.deal.created, true);
    assert.ok(won.body.deal.id, 'with its id, so the cell can name it');
    const again = await call('PUT', '/api/outreach', { entity_type: 'prospect', entity_id: 3, status: 'won' });
    assert.equal(again.body.deal.created, false, 'and linked, not duplicated, on a second pass');
    const noDeal = await call('PUT', '/api/outreach', { entity_type: 'prospect', entity_id: 1, status: 'won' });
    assert.equal(noDeal.body.deal, null, 'a golfnex win reports no deal rather than omitting the field');

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

// ── won → a SiteNex deal, rather than the same fact in two places ───────────────
test("a SiteNex prospect reaching 'won' creates a deal", async () => {
  reset();
  const r = await set({ entityType: 'prospect', entityId: 3, status: 'won' });   // id 3 is sitenex
  assert.equal(r.ok, true);
  assert.ok(r.deal, 'the response names the deal, so the UI can say which one');
  assert.equal(r.deal.created, true);
  // 'new', NOT 'signed'. 'won' in the OUTREACH vocabulary means "they said yes" — the moment a
  // conversation becomes a deal. 'signed' in the DEAL vocabulary means paperwork is executed, which is
  // three columns further along and has not happened: there is no contract, no schedule, and signed_at is
  // NULL. Creating it at 'signed' skipped proposal_sent and made the board claim an executed agreement
  // that did not exist — and the contract register's "signed value" would then have been counting it.
  assert.equal(r.deal.status, 'new', 'a deal starts at the beginning of the DEAL lifecycle');
  assert.equal(DEALS.length, 1);
  assert.equal(String(DEALS[0].prospect_id), '3', 'linked by prospect_id — the natural key, no new column');
  // And it lands in the ACTING USER'S BOOK. partner_id was NULL, which means self-sourced, so the deal a
  // partner had just created by marking a prospect won was invisible to that partner.
  assert.equal(r.deal.partner_id, 7, "the partner's own id, read from the DB and not from the token");
  assert.equal(DEALS[0].partner_id, 7);
});

test('a STAFF member marking won creates a self-sourced deal, which is what NULL means', async () => {
  reset();
  FIXTURE_PARTNER_ID = null;          // staff hold no partner_id
  const r = await set({ entityType: 'prospect', entityId: 3, status: 'won' });
  assert.equal(r.deal.partner_id, null, 'NULL is correct HERE — it means ours');
  assert.equal(r.deal.status, 'new');
});

test('re-marking won LINKS the existing deal instead of making a second', async () => {
  reset();
  await set({ entityType: 'prospect', entityId: 3, status: 'won' });
  const again = await set({ entityType: 'prospect', entityId: 3, status: 'won' });
  assert.equal(again.deal.created, false, 'found, not created');
  assert.equal(DEALS.length, 1, 'one deal per prospect');
  assert.equal(EVENTS.length, 2, 'but the second attempt is still logged');
});

test('won on a NON-sitenex prospect creates no deal', async () => {
  reset();
  const r = await set({ entityType: 'prospect', entityId: 1, status: 'won' });   // golfnex
  assert.equal(r.ok, true);
  assert.equal(r.deal, undefined, 'a golfnex win is not a SiteNex deal');
  assert.equal(DEALS.length, 0);
});

test('a non-won status on a sitenex prospect creates no deal', async () => {
  reset();
  await set({ entityType: 'prospect', entityId: 3, status: 'quote_sent' });
  assert.equal(DEALS.length, 0);
});

// ── the cross-list overview, including the silence ──────────────────────────────
test('overview: by person, by list, by status, and the SILENCE', async () => {
  reset();
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });
  await set({ entityType: 'prospect', entityId: 2, status: 'contacted' });
  await set({ entityType: 'institution', entityId: 10, status: 'quote_sent' });

  const o = await require('./index').overview({ held: STAFF, sinceDays: 7 }, deps);
  assert.equal(o.total_events, 3);
  assert.equal(o.people[0].total, 3, 'one person did all three');
  const byList = Object.fromEntries(o.by_list.map(l => [l.entity_type, l.events]));
  assert.equal(byList.prospect, 2);
  assert.equal(byList.institution, 1);
  assert.deepEqual(o.by_status, { contacted: 2, quote_sent: 1 });

  // THE ROW THAT MATTERS: lists with zero events, named without anyone going looking.
  const silent = o.silent.map(l => l.entity_type).sort();
  assert.deepEqual(silent, ['establishment', 'exhibitor', 'lead', 'study'],
    'every list the viewer can see and nobody has touched');
  assert.ok(o.silent.every(l => l.pages && l.pages.length), 'and each says which page to go to');
});

test('the silence is computed from the LISTS, not from the events', async () => {
  // A silent list cannot appear in the event data by definition, so deriving it from events would always
  // report none. With zero events every visible list must be silent.
  reset();
  const o = await require('./index').overview({ held: STAFF, sinceDays: 7 }, deps);
  assert.equal(o.total_events, 0);
  assert.equal(o.silent.length, Object.keys(ENTITIES).length, 'all six');
  assert.deepEqual(o.people, []);
});

test('overview is product-scoped — a partner sees only their own lists and events', async () => {
  reset();
  await set({ entityType: 'prospect', entityId: 1, status: 'contacted' });   // golfnex
  await set({ entityType: 'prospect', entityId: 3, status: 'won' });         // sitenex
  const o = await require('./index').overview({ held: ['sitenex'], sinceDays: 7 }, deps);
  assert.equal(o.total_events, 1, 'only the sitenex event');
  // A sitenex-only holder sees the prospect list (it has sitenex rows) and no abiozen/aros list at all.
  const types = o.by_list.map(l => l.entity_type).sort();
  assert.deepEqual(types, ['prospect'], 'the abiozen and aros lists are not theirs to be silent about');
  assert.deepEqual(o.silent, [], 'and the one list they can see is not silent');
});
