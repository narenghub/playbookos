// Per-company send cap tests — run with:  node --test src/lib/agents/email-engine-cap.test.js
// The contract: no company (email domain) ends up with more than the cap in flight across
// all Apollo sequences, and if the in-flight count can't be read, nobody is enrolled.

const { test } = require('node:test');
const assert = require('node:assert');
const { capPerCompany, inFlightByDomain, addSequenceContacts, maxPerCompany } = require('./email-engine');

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

test('bms.com replay: 413 contacts at one company → only 3 kept', () => {
  const contacts = Array.from({ length: 413 }, (_, i) => ({ id: `b${i}`, email: `p${i}@bms.com` }));
  const { kept, dropped } = capPerCompany(contacts, {}, 3);
  assert.equal(kept.length, 3);
  assert.equal(dropped.length, 410);
  assert.equal(dropped[0].reason, 'company_cap:bms.com');
});

test('counts contacts already in flight in other sequences', () => {
  const contacts = [{ id: 'a', email: 'x@novartis.com' }, { id: 'b', email: 'y@novartis.com' }, { id: 'c', email: 'z@lilly.com' }];
  const { kept } = capPerCompany(contacts, { 'novartis.com': 2 }, 3);
  assert.deepEqual(kept.map(c => c.id), ['a', 'c']);
});

test('domain match is case-insensitive; contacts without email are dropped', () => {
  const contacts = [{ id: 'a', email: 'A@BMS.com' }, { id: 'b', email: 'b@bms.COM' }, { id: 'c', email: null }];
  const { kept, dropped } = capPerCompany(contacts, {}, 1);
  assert.deepEqual(kept.map(c => c.id), ['a']);
  assert.deepEqual(dropped.map(c => c.reason), ['company_cap:bms.com', 'no_email']);
});

test('APOLLO_MAX_PER_COMPANY overrides the default of 3; junk falls back', () => {
  const prev = process.env.APOLLO_MAX_PER_COMPANY;
  try {
    delete process.env.APOLLO_MAX_PER_COMPANY; assert.equal(maxPerCompany(), 3);
    process.env.APOLLO_MAX_PER_COMPANY = '5'; assert.equal(maxPerCompany(), 5);
    process.env.APOLLO_MAX_PER_COMPANY = '0'; assert.equal(maxPerCompany(), 3);
    process.env.APOLLO_MAX_PER_COMPANY = 'abc'; assert.equal(maxPerCompany(), 3);
  } finally {
    if (prev === undefined) delete process.env.APOLLO_MAX_PER_COMPANY; else process.env.APOLLO_MAX_PER_COMPANY = prev;
  }
});

test('inFlightByDomain counts distinct recipients across pages', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ to_email: i < 60 ? `p${i % 30}@bms.com` : `q${i}@lilly.com` }));
  const page2 = [{ to_email: 'p0@bms.com' }, { to_email: 'new@bms.com' }];
  let calls = 0;
  const fetchFn = async () => jsonRes({ emailer_messages: ++calls === 1 ? page1 : page2 });
  const counts = await inFlightByDomain('k', fetchFn);
  assert.equal(counts['bms.com'], 31);
  assert.equal(counts['lilly.com'], 40);
  assert.equal(calls, 2);
});

test('addSequenceContacts enrolls only the capped set', async () => {
  process.env.APOLLO_CONTACTS_S3 = 'c1,c2,c3,c4';
  delete process.env.APOLLO_MAX_PER_COMPANY;
  const emails = { c1: 'a@bms.com', c2: 'b@bms.com', c3: 'c@bms.com', c4: 'd@lilly.com' };
  let enrolled;
  const fetchFn = async (url, opts) => {
    if (url.endsWith('/emailer_messages/search')) return jsonRes({ emailer_messages: [{ to_email: 'old@bms.com' }] });
    const m = url.match(/\/contacts\/(\w+)$/);
    if (m) return jsonRes({ contact: { email: emails[m[1]] } });
    if (url.endsWith('/add_contact_ids')) { enrolled = JSON.parse(opts.body).contact_ids; return jsonRes({}); }
    throw new Error('unexpected ' + url);
  };
  try {
    const r = await addSequenceContacts('seq1', 'generic_manufacturer', 'k', fetchFn);
    assert.deepEqual(enrolled, ['c1', 'c2', 'c4']); // old@bms.com already in flight → only 2 more bms
    assert.equal(r.added, 3);
    assert.equal(r.dropped, 1);
  } finally { delete process.env.APOLLO_CONTACTS_S3; }
});

test('fails closed: in-flight lookup error → nobody enrolled', async () => {
  process.env.APOLLO_CONTACTS_S1 = 'c1';
  let enrollCalled = false;
  const fetchFn = async (url) => {
    if (url.endsWith('/add_contact_ids')) enrollCalled = true;
    return jsonRes({}, false, 500);
  };
  try {
    const r = await addSequenceContacts('seq1', 'compounding_pharmacy', 'k', fetchFn);
    assert.equal(r.added, 0);
    assert.match(r.error, /500/);
    assert.equal(enrollCalled, false);
  } finally { delete process.env.APOLLO_CONTACTS_S1; }
});
