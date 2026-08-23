// Outbound credential accessor tests — run with:  node --test src/lib/outbound/credentials.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { getOutboundCredential, hasOutboundCredential, envKeysFor } = require('./credentials');

test('env key naming normalizes product/vendor (uppercase, non-alnum → _)', () => {
  assert.deepEqual(envKeysFor('golfnex', 'mcp'), { primaryKey: 'OUTBOUND_GOLFNEX_MCP', nextKey: 'OUTBOUND_GOLFNEX_MCP_NEXT' });
  assert.deepEqual(envKeysFor('golf nex', 'mcp-x'), { primaryKey: 'OUTBOUND_GOLF_NEX_MCP_X', nextKey: 'OUTBOUND_GOLF_NEX_MCP_X_NEXT' });
});

test('returns the primary secret when only primary is set', () => {
  const r = getOutboundCredential('golfnex', 'mcp', { env: { OUTBOUND_GOLFNEX_MCP: 's3cret' } });
  assert.equal(r.secret, 's3cret');
  assert.equal(r.slot, 'primary');
  assert.equal(r.error, undefined);
});

test('PREFERS the _NEXT slot when both are set (rotation cutover)', () => {
  const r = getOutboundCredential('golfnex', 'mcp', { env: { OUTBOUND_GOLFNEX_MCP: 'old', OUTBOUND_GOLFNEX_MCP_NEXT: 'new' } });
  assert.equal(r.secret, 'new');
  assert.equal(r.slot, 'next');
});

test('falls back to primary when _NEXT is empty/whitespace', () => {
  const r = getOutboundCredential('golfnex', 'mcp', { env: { OUTBOUND_GOLFNEX_MCP: 'old', OUTBOUND_GOLFNEX_MCP_NEXT: '   ' } });
  assert.equal(r.secret, 'old');
  assert.equal(r.slot, 'primary');
});

test('error when neither slot is set, naming the primary key, WITHOUT any secret', () => {
  const r = getOutboundCredential('golfnex', 'mcp', { env: {} });
  assert.match(r.error, /no outbound credential for golfnex\/mcp \(set OUTBOUND_GOLFNEX_MCP\)/);
  assert.equal(r.secret, undefined, 'no secret leaked on the error path');
});

test('product and vendor are required', () => {
  assert.match(getOutboundCredential('', 'mcp', { env: {} }).error, /product and vendor are required/);
  assert.match(getOutboundCredential('golfnex', '', { env: {} }).error, /product and vendor are required/);
});

test('uses the injected env, not process.env', () => {
  const saved = process.env.OUTBOUND_GOLFNEX_MCP;
  process.env.OUTBOUND_GOLFNEX_MCP = 'from-process';
  try {
    // injected env has no such key → error, proving we did not read process.env
    assert.ok(getOutboundCredential('golfnex', 'mcp', { env: {} }).error);
  } finally {
    if (saved === undefined) delete process.env.OUTBOUND_GOLFNEX_MCP; else process.env.OUTBOUND_GOLFNEX_MCP = saved;
  }
});

test('hasOutboundCredential reflects presence without returning the secret', () => {
  assert.equal(hasOutboundCredential('golfnex', 'mcp', { env: { OUTBOUND_GOLFNEX_MCP: 'x' } }), true);
  assert.equal(hasOutboundCredential('golfnex', 'mcp', { env: {} }), false);
});
