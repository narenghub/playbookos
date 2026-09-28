// Outbound HTTP helper tests — run with:  node --test src/lib/outbound/http.test.js
// Stubs global.fetch per test. Proves never-throws { data, error }, timeout via abort, and
// that it is a dumb transport (serialization + header passthrough).

const { test } = require('node:test');
const assert = require('node:assert');
const { httpJson } = require('./http');

const realFetch = global.fetch;
const stub = (fn) => { global.fetch = fn; };
const restore = () => { global.fetch = realFetch; };
const okJson = (data) => ({ ok: true, status: 200, json: async () => data });

test('success → { data, status }', async () => {
  stub(async () => okJson({ a: 1 }));
  try {
    const r = await httpJson({ url: 'https://x/y' });
    assert.deepEqual(r.data, { a: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.error, undefined);
  } finally { restore(); }
});

test('non-2xx → { error, status } with truncated body, no throw', async () => {
  stub(async () => ({ ok: false, status: 500, text: async () => 'boom'.repeat(200) }));
  try {
    let r;
    await assert.doesNotReject(async () => { r = await httpJson({ url: 'https://x' }); });
    assert.match(r.error, /^HTTP 500: boom/);
    assert.ok(r.error.length <= 'HTTP 500: '.length + 300, 'body truncated to 300');
    assert.equal(r.status, 500);
  } finally { restore(); }
});

test('non-JSON 200 body → { error }, no throw', async () => {
  stub(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
  try {
    let r;
    await assert.doesNotReject(async () => { r = await httpJson({ url: 'https://x' }); });
    assert.match(r.error, /response not JSON/);
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('network throw → { error: request failed }, no throw', async () => {
  stub(async () => { throw new Error('ECONNREFUSED'); });
  try {
    let r;
    await assert.doesNotReject(async () => { r = await httpJson({ url: 'https://x' }); });
    assert.match(r.error, /request failed: ECONNREFUSED/);
    assert.equal(r.timedOut, undefined);
  } finally { restore(); }
});

test('timeout → aborts and returns { error, timedOut:true }, no throw', async () => {
  // fetch that never resolves until aborted, then rejects with AbortError (undici behaviour)
  stub((url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  }));
  try {
    let r;
    await assert.doesNotReject(async () => { r = await httpJson({ url: 'https://x', timeoutMs: 20 }); });
    assert.equal(r.timedOut, true);
    assert.match(r.error, /timed out after 20ms/);
  } finally { restore(); }
});

test('serializes an object body + sets Content-Type; passes method + headers through', async () => {
  let captured;
  stub(async (url, opts) => { captured = { url, opts }; return okJson({ ok: true }); });
  try {
    await httpJson({ url: 'https://x/rpc', method: 'POST', headers: { Authorization: 'Bearer t' }, body: { hello: 'world' } });
    assert.equal(captured.url, 'https://x/rpc');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.body, JSON.stringify({ hello: 'world' }));
    assert.equal(captured.opts.headers.Authorization, 'Bearer t');
    assert.equal(captured.opts.headers['Content-Type'], 'application/json');
    assert.ok(captured.opts.signal, 'an abort signal is attached');
  } finally { restore(); }
});

test('does not override a caller-supplied content-type; string body passed as-is', async () => {
  let captured;
  stub(async (url, opts) => { captured = opts; return okJson({}); });
  try {
    await httpJson({ url: 'https://x', method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'raw' });
    assert.equal(captured.body, 'raw');
    assert.equal(captured.headers['content-type'], 'text/plain');
    assert.equal('Content-Type' in captured.headers, false, 'did not add a duplicate header');
  } finally { restore(); }
});

test('url is required → { error }, without touching the network', async () => {
  let fetched = false;
  stub(async () => { fetched = true; return okJson({}); });
  try {
    const r = await httpJson({});
    assert.match(r.error, /url is required/);
    assert.equal(fetched, false);
  } finally { restore(); }
});

// ── httpText (raw-body fetch for HTML scraping) ─────────────────────────────────
const { httpText } = require('./http');
test('httpText success → { text, status, contentType }', async () => {
  stub(async () => ({ ok: true, status: 200, text: async () => '<html>hi</html>', headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'text/html' : null } }));
  try {
    const r = await httpText({ url: 'https://x' });
    assert.equal(r.text, '<html>hi</html>'); assert.equal(r.status, 200); assert.equal(r.contentType, 'text/html');
  } finally { restore(); }
});
test('httpText non-2xx → { error, status }, no throw', async () => {
  stub(async () => ({ ok: false, status: 403 }));
  try { const r = await httpText({ url: 'https://x' }); assert.match(r.error, /HTTP 403/); assert.equal(r.status, 403); } finally { restore(); }
});
test('httpText timeout → { error, timedOut }', async () => {
  stub((url, opts) => new Promise((_r, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; rej(e); })));
  try { const r = await httpText({ url: 'https://x', timeoutMs: 15 }); assert.equal(r.timedOut, true); assert.match(r.error, /timed out/); } finally { restore(); }
});
test('httpText network throw → { error }, no throw', async () => {
  stub(async () => { throw new Error('ECONN'); });
  try { let r; await assert.doesNotReject(async () => { r = await httpText({ url: 'https://x' }); }); assert.match(r.error, /request failed: ECONN/); } finally { restore(); }
});

// ── httpText additions: final URL, body on non-2xx, User-Agent ──────────────────
test('httpText returns the FINAL url after redirects (http → https is detectable)', async () => {
  stub(async () => ({ ok: true, status: 200, url: 'https://x.com/', text: async () => '<html/>', headers: { get: () => 'text/html' } }));
  try {
    const r = await httpText({ url: 'http://x.com' });
    assert.equal(r.url, 'https://x.com/', 'final url, not the requested one');
  } finally { restore(); }
});

test('httpText falls back to the requested url when the response carries none', async () => {
  stub(async () => ({ ok: true, status: 200, text: async () => '<html/>', headers: { get: () => null } }));
  try { assert.equal((await httpText({ url: 'https://y.com' })).url, 'https://y.com'); } finally { restore(); }
});

test('httpText KEEPS the body on non-2xx, while still reporting { error, status }', async () => {
  stub(async () => ({ ok: false, status: 404, url: 'https://x.com/404', text: async () => '<html>parked domain</html>', headers: { get: () => 'text/html' } }));
  try {
    const r = await httpText({ url: 'https://x.com' });
    assert.match(r.error, /HTTP 404/);        // callers must keep checking error FIRST
    assert.equal(r.status, 404);
    assert.match(r.text, /parked domain/);    // ...but the page is now inspectable
  } finally { restore(); }
});

test('httpText non-2xx with NO body reader still returns { error, status } and text null', async () => {
  stub(async () => ({ ok: false, status: 403 }));   // the original contract, unchanged
  try {
    const r = await httpText({ url: 'https://x' });
    assert.match(r.error, /HTTP 403/); assert.equal(r.status, 403); assert.equal(r.text, null);
  } finally { restore(); }
});

test('httpText sends a default User-Agent; a caller-supplied one wins', async () => {
  const { DEFAULT_USER_AGENT } = require('./http');
  let seen;
  stub(async (_u, opts) => { seen = opts.headers; return { ok: true, status: 200, text: async () => '', headers: { get: () => null } }; });
  try {
    await httpText({ url: 'https://x' });
    assert.equal(seen['User-Agent'], DEFAULT_USER_AGENT);
    await httpText({ url: 'https://x', headers: { 'user-agent': 'mine/1.0' } });
    assert.equal(seen['user-agent'], 'mine/1.0');
    assert.equal(seen['User-Agent'], undefined, 'no duplicate UA header');
  } finally { restore(); }
});
