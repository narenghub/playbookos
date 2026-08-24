// Places client tests — run with:  node --test src/lib/agents/prospecting/places.test.js
// httpJson injected via deps; no network.
const { test } = require('node:test');
const assert = require('node:assert');
const { searchText, parsePlace, FIELD_MASK } = require('./places');

const rawPlace = (id, over = {}) => ({ id, displayName: { text: 'Name ' + id }, formattedAddress: 'Addr', nationalPhoneNumber: '(111) 222', websiteUri: 'http://x', types: ['golf_course'], rating: 4.5, userRatingCount: 100, businessStatus: 'OPERATIONAL', ...over });
const httpReturning = (resp) => { const cap = {}; const fn = async (req) => { Object.assign(cap, req); return resp; }; fn.cap = cap; return fn; };

test('field mask includes the 9 place fields + nextPageToken', () => {
  ['places.id','places.displayName','places.formattedAddress','places.nationalPhoneNumber','places.websiteUri','places.types','places.rating','places.userRatingCount','places.businessStatus','nextPageToken']
    .forEach(f => assert.ok(FIELD_MASK.includes(f), 'mask has ' + f));
});

test('parsePlace flattens the raw Places shape', () => {
  const p = parsePlace(rawPlace('abc'));
  assert.deepEqual(p, { place_id: 'abc', name: 'Name abc', address: 'Addr', phone: '(111) 222', website: 'http://x', types: ['golf_course'], rating: 4.5, rating_count: 100, business_status: 'OPERATIONAL' });
  // missing fields → nulls/[]
  assert.deepEqual(parsePlace({ id: 'x' }), { place_id: 'x', name: null, address: null, phone: null, website: null, types: [], rating: null, rating_count: null, business_status: null });
});

test('success → normalized places + nextPageToken, sends the mask + key header', async () => {
  const http = httpReturning({ data: { places: [rawPlace('a'), rawPlace('b')], nextPageToken: 'tok2' } });
  const r = await searchText('golf course in Illinois', { apiKey: 'k', deps: { httpJson: http } });
  assert.equal(r.places.length, 2);
  assert.equal(r.places[0].place_id, 'a');
  assert.equal(r.nextPageToken, 'tok2');
  assert.equal(http.cap.url, 'https://places.googleapis.com/v1/places:searchText');
  assert.equal(http.cap.method, 'POST');
  assert.equal(http.cap.headers['X-Goog-Api-Key'], 'k');
  assert.equal(http.cap.headers['X-Goog-FieldMask'], FIELD_MASK);
  assert.deepEqual(http.cap.body, { textQuery: 'golf course in Illinois' });
});

test('pageToken is forwarded in the body', async () => {
  const http = httpReturning({ data: { places: [] } });
  await searchText('q', { apiKey: 'k', pageToken: 'PT', deps: { httpJson: http } });
  assert.equal(http.cap.body.pageToken, 'PT');
});

test('transport/API error → { places:[], error }, no throw', async () => {
  const http = httpReturning({ error: 'HTTP 403: blocked' });
  let r;
  await assert.doesNotReject(async () => { r = await searchText('q', { apiKey: 'k', deps: { httpJson: http } }); });
  assert.deepEqual(r.places, []);
  assert.equal(r.nextPageToken, null);
  assert.match(r.error, /HTTP 403/);
});

test('missing key / missing query → error, no call', async () => {
  let called = false; const http = async () => { called = true; return { data: {} }; };
  assert.match((await searchText('q', { apiKey: '', deps: { httpJson: http } })).error, /GOOGLE_PLACES_API_KEY not configured/);
  assert.match((await searchText('', { apiKey: 'k', deps: { httpJson: http } })).error, /query is required/);
  assert.equal(called, false);
});

test('drops results with no place_id', async () => {
  const http = httpReturning({ data: { places: [rawPlace('a'), { displayName: { text: 'no id' } }] } });
  const r = await searchText('q', { apiKey: 'k', deps: { httpJson: http } });
  assert.equal(r.places.length, 1);
});
