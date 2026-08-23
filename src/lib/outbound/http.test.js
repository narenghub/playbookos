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
