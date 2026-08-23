// Thin MCP client tests — run with:  node --test src/lib/outbound/mcp.test.js
// httpJson is injected via deps so no network is touched.
const { test } = require('node:test');
const assert = require('node:assert');
const { callMcpTool } = require('./mcp');

const CRED = { secret: 'sk-out', slot: 'primary' };
// an injected httpJson that captures the request and returns a canned response
const httpReturning = (resp) => { const cap = {}; const fn = async (req) => { Object.assign(cap, req); return resp; }; fn.cap = cap; return fn; };
const rpcOk = (result) => ({ data: { jsonrpc: '2.0', id: 1, result } });
const rpcErr = (code, message) => ({ data: { jsonrpc: '2.0', id: 1, error: { code, message } } });

test('emits a well-formed JSON-RPC 2.0 tools/call with name + arguments + _meta', async () => {
  const http = httpReturning(rpcOk({ content: [{ type: 'text', text: 'ok' }] }));
  const r = await callMcpTool({
    serverUrl: 'http://gn.internal/mcp', credential: CRED, toolName: 'create_post',
    args: { title: 'Hi' }, meta: { product: 'golfnex', tenant_id: 't-1', on_behalf_of: 'u9', actor_agent: 'content-pipeline' },
    deps: { httpJson: http, id: 1 },
  });
  assert.deepEqual(r, { result: { content: [{ type: 'text', text: 'ok' }] } });
  const body = http.cap.body;
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'create_post');
  assert.deepEqual(body.params.arguments, { title: 'Hi' });
  assert.deepEqual(body.params._meta, { product: 'golfnex', tenant_id: 't-1', on_behalf_of: 'u9', actor_agent: 'content-pipeline' });
  assert.equal(http.cap.method, 'POST');
  assert.equal(http.cap.url, 'http://gn.internal/mcp');
});

test('Bearer auth + _meta mirrored into headers', async () => {
  const http = httpReturning(rpcOk({}));
  await callMcpTool({ serverUrl: 'http://x/mcp', credential: CRED, toolName: 't', meta: { product: 'golfnex', tenant_id: 't-1', on_behalf_of: 'u9', actor_agent: 'a' }, deps: { httpJson: http } });
  assert.equal(http.cap.headers.Authorization, 'Bearer sk-out');
  assert.equal(http.cap.headers['X-Playbook-Product'], 'golfnex');
  assert.equal(http.cap.headers['X-Playbook-Tenant'], 't-1');
  assert.equal(http.cap.headers['X-Playbook-On-Behalf-Of'], 'u9');
  assert.equal(http.cap.headers['X-Playbook-Actor-Agent'], 'a');
});

test('_meta always present including tenant_id=null; header becomes empty string', async () => {
  const http = httpReturning(rpcOk({}));
  await callMcpTool({ serverUrl: 'http://x/mcp', credential: CRED, toolName: 't', meta: { product: 'golfnex', on_behalf_of: 'u9', actor_agent: 'a' }, deps: { httpJson: http } });
  assert.ok('tenant_id' in http.cap.body.params._meta, 'tenant_id key present');
  assert.equal(http.cap.body.params._meta.tenant_id, null);
  assert.equal(http.cap.headers['X-Playbook-Tenant'], '', 'null tenant → empty header string');
  // even with NO meta at all, all four keys exist and are null
  const http2 = httpReturning(rpcOk({}));
  await callMcpTool({ serverUrl: 'http://x/mcp', credential: CRED, toolName: 't', deps: { httpJson: http2 } });
  assert.deepEqual(http2.cap.body.params._meta, { product: null, tenant_id: null, on_behalf_of: null, actor_agent: null });
});

test('JSON-RPC error result surfaces distinctly from transport error', async () => {
  const http = httpReturning(rpcErr(-32000, 'tool failed: quota exceeded'));
  const r = await callMcpTool({ serverUrl: 'http://x/mcp', credential: CRED, toolName: 't', deps: { httpJson: http } });
  assert.equal(r.result, undefined);
  assert.equal(r.transport, false, 'a JSON-RPC error is NOT a transport failure');
  assert.match(r.error, /JSON-RPC error -32000: tool failed: quota exceeded/);
  assert.deepEqual(r.rpcError, { code: -32000, message: 'tool failed: quota exceeded' });
});

test('transport failure is flagged transport:true (server unreachable / HTTP error)', async () => {
  const http = httpReturning({ error: 'HTTP 502: bad gateway', status: 502 });
  const r = await callMcpTool({ serverUrl: 'http://x/mcp', credential: CRED, toolName: 't', deps: { httpJson: http } });
  assert.equal(r.result, undefined);
  assert.equal(r.transport, true);
  assert.equal(r.status, 502);
  assert.match(r.error, /HTTP 502/);
});

test('timeout is a transport failure carrying timedOut', async () => {
  const http = httpReturning({ error: 'request timed out after 15000ms', timedOut: true });
  const r = await callMcpTool({ serverUrl: 'http://x/mcp', credential: CRED, toolName: 't', deps: { httpJson: http } });
  assert.equal(r.transport, true);
  assert.equal(r.timedOut, true);
});

test('malformed JSON-RPC (no result and no error) → error, transport:false', async () => {
  const http = httpReturning({ data: { jsonrpc: '2.0', id: 1 } });
  const r = await callMcpTool({ serverUrl: 'http://x/mcp', credential: CRED, toolName: 't', deps: { httpJson: http } });
  assert.match(r.error, /malformed JSON-RPC response/);
  assert.equal(r.transport, false);
});

test('validation: serverUrl, credential.secret, toolName required — no network', async () => {
  let called = false; const http = async () => { called = true; return rpcOk({}); };
  assert.match((await callMcpTool({ credential: CRED, toolName: 't', deps: { httpJson: http } })).error, /serverUrl is required/);
  assert.match((await callMcpTool({ serverUrl: 'http://x', toolName: 't', deps: { httpJson: http } })).error, /credential with a secret/);
  assert.match((await callMcpTool({ serverUrl: 'http://x', credential: CRED, deps: { httpJson: http } })).error, /toolName is required/);
  assert.equal(called, false);
});

test('never throws even if the injected transport throws', async () => {
  const http = async () => { throw new Error('boom'); };
  let r;
  await assert.doesNotReject(async () => { r = await callMcpTool({ serverUrl: 'http://x', credential: CRED, toolName: 't', deps: { httpJson: http } }); });
  assert.equal(r.transport, true);
  assert.match(r.error, /mcp client error: boom/);
});
