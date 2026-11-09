// ── WHAT THE HARVESTER MUST REFUSE TO DO QUIETLY ─────────────────────────────
//
//   node --test src/lib/connectors/sam-sgs.test.js
//
// The harvester depends on an UNDOCUMENTED endpoint by the owner's decision (2026-11-08). That is
// only defensible if its failure mode is loud, because the dangerous outcome is not an exception —
// it is a harvest that returns nothing, or records whose fields were renamed and now read as null,
// leaving a board that looks current and is not. Every test here is about that one property.
//
// These use a fake fetch. No network call is made.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const SGS = require('./sam-sgs');

const ok = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });

function notice(over = {}) {
  // `type` is destructured out before the spread: it is a STRING in the overrides and an OBJECT on
  // the record, and spreading it last silently replaced the object, which made every record
  // untyped and the biddable-type test pass vacuously in the wrong direction.
  const { type, ...rest } = over;
  return {
    _id: over._id || 'abc123',
    title: over.title || 'Lab testing services',
    solicitationNumber: '36C25027Q0032',
    type: { code: 'o', value: type || 'Solicitation' },
    publishDate: '2026-11-06T21:12:14+00:00',
    archiveDate: '2026-12-26T00:00:00+00:00',
    isActive: true,
    organizationHierarchy: [
      { level: 1, name: 'VETERANS AFFAIRS, DEPARTMENT OF' },
      { level: 2, name: 'VETERANS AFFAIRS, DEPARTMENT OF' },
      { level: 3, name: 'NETWORK CONTRACT OFFICE 10' },
    ],
    naics: [{ code: '325412', value: 'Pharmaceutical Preparation Manufacturing' }],
    psc: [{ code: '6505', value: 'DRUGS AND BIOLOGICALS' }],
    solicitation: { setAside: null, originalSetAside: null },
    // The deadline, and the contact block the harvester must never read.
    responseDate: over.responseDate !== undefined ? over.responseDate : '2099-01-01T17:00:00+00:00',
    pointOfContacts: [{ fullName: 'Jane Officer', email: 'jane.officer@va.gov', phone: '555-0100' }],
    ...rest,
  };
}

const page = (results, total) => ({ _embedded: { results }, page: { totalElements: total ?? results.length } });

test('assertShape throws when the results wrapper is missing — a rename must not read as empty', () => {
  assert.throws(() => SGS.assertShape({ page: { totalElements: 5 } }, 'x'), /_embedded.results/);
  assert.throws(() => SGS.assertShape({ data: [] }, 'x'), /_embedded.results/);
  assert.throws(() => SGS.assertShape(null, 'x'), /non-object/);
});

test('assertShape throws without a total — a truncated harvest must not look finished', () => {
  assert.throws(() => SGS.assertShape({ _embedded: { results: [] } }, 'x'), /totalElements/);
});

test('an empty first page against a non-zero total is an ERROR, not an empty harvest', async () => {
  await assert.rejects(
    SGS.harvest({ naics: ['325412'], fetchImpl: ok(page([], 232)) }),
    /returned an empty first page/);
});

test('a whole page with no deadline key is treated as a field rename, not as data', async () => {
  const noDeadline = Array.from({ length: 6 }, (_, i) =>
    notice({ _id: `n${i}`, responseDate: undefined, responseDateActual: undefined }));
  await assert.rejects(
    SGS.harvest({ naics: ['325412'], fetchImpl: ok(page(noDeadline, 6)) }),
    /deadline field has been renamed/);
});

test('a record with no _id is refused — the dedupe natural key cannot be absent', async () => {
  const bad = notice({ _id: undefined });
  delete bad._id;
  await assert.rejects(
    SGS.harvest({ naics: ['325412'], fetchImpl: ok(page([bad], 1)) }),
    /no _id/);
});

test('only biddable notice types are harvested — Sources Sought and awards are not solicitations', async () => {
  const mixed = [
    notice({ _id: 'a', type: 'Solicitation' }),
    notice({ _id: 'b', type: 'Sources Sought' }),
    notice({ _id: 'c', type: 'Award Notice' }),
    notice({ _id: 'd', type: 'Presolicitation' }),
    notice({ _id: 'e', type: 'Combined Synopsis/Solicitation' }),
  ];
  const { rows } = await SGS.harvest({ naics: ['325412'], fetchImpl: ok(page(mixed, 5)) });
  assert.deepStrictEqual(rows.map((r) => r.NoticeId).sort(), ['a', 'e']);
});

test('notices whose deadline has passed are skipped, and counted', async () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const recs = [
    notice({ _id: 'old', responseDate: '2020-05-28T17:00:00+00:00' }),
    notice({ _id: 'new', responseDate: '2026-12-01T17:00:00+00:00' }),
  ];
  const { rows, stats } = await SGS.harvest({ naics: ['325412'], now, fetchImpl: ok(page(recs, 2)) });
  assert.deepStrictEqual(rows.map((r) => r.NoticeId), ['new']);
  assert.strictEqual(stats.closedSkipped, 1);
});

test('onlyOpen:false keeps what the index calls active', async () => {
  const now = new Date('2026-11-09T00:00:00Z');
  const recs = [notice({ _id: 'old', responseDate: '2020-05-28T17:00:00+00:00' })];
  const { rows } = await SGS.harvest({
    naics: ['325412'], now, onlyOpen: false, fetchImpl: ok(page(recs, 1)),
  });
  assert.strictEqual(rows.length, 1);
});

test('NO CONTACT DETAILS ARE COLLECTED — not in the columns, not in a row, not in the CSV', () => {
  // SAM.gov notices carry federal contracting officers' names, emails and phone numbers. A HOLD on
  // sending email is weaker than it looks if the system has meanwhile assembled the list to send
  // to, so the list is never assembled. This asserts the absence rather than trusting the comment.
  const row = SGS.toRow(notice());
  const serialized = JSON.stringify(row);
  assert.ok(!/jane\.officer@va\.gov/i.test(serialized), 'an email reached the row');
  assert.ok(!/Jane Officer/i.test(serialized), 'a contact name reached the row');
  assert.ok(!/555-0100/.test(serialized), 'a phone number reached the row');
  for (const c of SGS.COLUMNS) {
    assert.ok(!/contact|email|phone|poc/i.test(c), `column "${c}" looks like a contact field`);
  }
  const csv = SGS.toCsv([row]);
  assert.ok(!/jane\.officer@va\.gov/i.test(csv), 'an email reached the CSV');
  assert.ok(!/555-0100/.test(csv), 'a phone number reached the CSV');
});

test('the CSV is the format the tracker importer already accepts', () => {
  const csv = SGS.toCsv([SGS.toRow(notice())]);
  const header = csv.split('\n')[0];
  assert.strictEqual(header, SGS.COLUMNS.map((c) => `"${c}"`).join(','));
  assert.ok(header.includes('"NoticeId"') && header.includes('"ResponseDeadLine"'));
});

test('CSV quoting survives a title containing quotes and commas', () => {
  const row = SGS.toRow(notice({ title: 'Lab "A", testing' }));
  const line = SGS.toCsv([row]).split('\n')[1];
  assert.ok(line.includes('"Lab ""A"", testing"'), line.slice(0, 80));
});

test('responseDateActual wins over responseDate — it carries the real local time', () => {
  const d = SGS.deadlineOf({ responseDate: '2026-11-11T21:00:00+00:00',
    responseDateActual: '2026-11-11T16:00:00-05:00' });
  assert.strictEqual(d, '2026-11-11T16:00:00-05:00');
});

test('an HTTP error is raised, never swallowed into an empty harvest', async () => {
  const bad = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(SGS.harvest({ naics: ['325412'], fetchImpl: bad }), /HTTP 503/);
});

test('no Accept header is sent — this endpoint answers 406 to application/json', async () => {
  // Measured 2026-11-08: it cost a failed harvest run. Asserted so it cannot be "tidied" back in.
  let seen = null;
  const spy = async (url, opts) => { seen = opts.headers; return { ok: true, status: 200, json: async () => page([], 0) }; };
  await SGS.harvest({ naics: ['325412'], fetchImpl: spy });
  assert.ok(seen, 'no request was made');
  const keys = Object.keys(seen).map((k) => k.toLowerCase());
  assert.ok(!keys.includes('accept'), `an Accept header was sent: ${JSON.stringify(seen)}`);
});
