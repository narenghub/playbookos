// ── THE INTAKE TOKEN: hashing, the allowlist, and the caps ─────────────────────
//   node --test src/lib/sitenex/intake-token.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const T = require('./intake-token');

// ── hashed, not stored ────────────────────────────────────────────────────────

test('a token is 256 bits of randomness, URL-safe, and never repeats', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const { token } = T.newToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/, 'must survive a URL and an email linkifier without encoding');
    assert.ok(token.length >= 40, `expected at least 40 chars, got ${token.length}`);
    assert.ok(!seen.has(token), 'collision');
    seen.add(token);
  }
});

test('the hash is sha256 of the token, and the token is nowhere in it', () => {
  const { token, hash, tail } = T.newToken();
  assert.equal(hash, crypto.createHash('sha256').update(token, 'utf8').digest('hex'));
  assert.equal(hash.length, 64);
  assert.ok(!hash.includes(token.slice(0, 8)), 'the hash must not contain the token');
  // The tail is 4 characters of a 43-character secret. Stored so staff can identify WHICH link a client
  // is quoting; asserted short so nobody grows it into a usable fragment of the credential.
  assert.equal(tail.length, 4);
  assert.ok(token.endsWith(tail));
});

test('hashing is deterministic — which is what makes the lookup a single indexed read', () => {
  // A salted scheme would force reading every live row and comparing one at a time: slower, and a worse
  // shape, because it touches every other client's row to answer a question about one.
  const { token, hash } = T.newToken();
  assert.equal(T.hashToken(token), hash);
  assert.equal(T.hashToken(token), T.hashToken(token));
  assert.notEqual(T.hashToken(token + 'x'), hash);
});

test('the digest comparison is length-safe and does not throw on junk', () => {
  const a = T.hashToken('a');
  assert.equal(T.sameDigest(a, a), true);
  assert.equal(T.sameDigest(a, T.hashToken('b')), false);
  assert.equal(T.sameDigest(a, 'short'), false, 'differing lengths must return false, not throw');
  assert.equal(T.sameDigest(null, undefined), true, 'two empties are equal; neither reaches a real row');
  assert.equal(T.sameDigest(a, null), false);
});

test('an implausible token is rejected without touching the database', () => {
  // One regex instead of one query, for every scanner spraying /api/intake/wp-admin.
  assert.equal(T.looksLikeToken(T.newToken().token), true);
  for (const junk of ['', 'nope', '../../etc/passwd', 'a'.repeat(200), "' OR 1=1--", null, undefined, 42]) {
    assert.equal(T.looksLikeToken(junk), false, `should reject ${JSON.stringify(junk)}`);
  }
});

test('the lifetime is 30 days, because clients take weeks to find a logo', () => {
  assert.equal(T.LIFETIME_DAYS, 30);
  const now = new Date('2026-10-01T12:00:00Z');
  assert.equal(T.expiryFrom(now).toISOString(), '2026-10-31T12:00:00.000Z');
});

// ── what may land in Postgres ────────────────────────────────────────────────

test('VIDEO IS REFUSED, and the message tells the client what to do instead', () => {
  for (const f of [{ name: 'walkthrough.mov', type: 'video/quicktime' },
                   { name: 'clip.mp4', type: 'video/mp4' },
                   // The case that matters: a phone upload arriving with no useful mime type. The
                   // EXTENSION is the only evidence, so it is checked too.
                   { name: 'IMG_4821.MOV', type: 'application/octet-stream' },
                   { name: 'reel.webm', type: '' }]) {
    const v = T.classifyUpload({ ...f, size: 3 * 1024 * 1024 });
    assert.equal(v.ok, false, `${f.name} must be refused`);
    assert.equal(v.code, 'video_not_accepted');
    assert.match(v.message, /cannot accept video/i);
    // REFUSED WITH A ROUTE FORWARD, not just refused. A client told only "no" sends nothing.
    assert.match(v.message, /link/i, 'the refusal must tell them to send a link instead');
  }
});

test('a video under the size limit is STILL refused — the reason is the medium, not the bytes', () => {
  const v = T.classifyUpload({ name: 'tiny.mp4', type: 'video/mp4', size: 1024 });
  assert.equal(v.code, 'video_not_accepted');
});

test('SVG is refused on purpose, with a usable alternative', () => {
  // A logo is often an SVG, so this one needs its reason attached: an SVG is a script-bearing document,
  // and accepting one from an unauthenticated endpoint into a system that may display it inline later is
  // a stored-XSS primitive we would be installing ourselves.
  const v = T.classifyUpload({ name: 'logo.svg', type: 'image/svg+xml', size: 2048 });
  assert.equal(v.code, 'svg_not_accepted');
  assert.match(v.message, /PNG/);
});

test('the types a small-business site is actually built from are accepted', () => {
  for (const [name, type] of [['logo.png', 'image/png'], ['front.jpg', 'image/jpeg'],
                              ['brief.pdf', 'application/pdf'], ['copy.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
                              ['prices.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
                              ['notes.txt', 'text/plain'], ['brand.zip', 'application/zip']]) {
    const v = T.classifyUpload({ name, type, size: 50000 });
    assert.equal(v.ok, true, `${name} should be accepted, got ${v.code}: ${v.message}`);
  }
});

test('anything not on the allowlist is refused — the list is an allowlist, not a blocklist', () => {
  for (const [name, type] of [['run.exe', 'application/x-msdownload'], ['x.sh', 'application/x-sh'],
                              ['page.html', 'text/html'], ['app.js', 'text/javascript']]) {
    const v = T.classifyUpload({ name, type, size: 1000 });
    assert.equal(v.ok, false, `${name} must be refused`);
  }
});

test('a mime type with a charset parameter still matches', () => {
  // 'text/plain; charset=utf-8' is what a browser actually sends, and an exact-string allowlist that
  // forgot the parameter would refuse a plain text file.
  assert.equal(T.classifyUpload({ name: 'a.txt', type: 'text/plain; charset=utf-8', size: 10 }).ok, true);
});

test('10MB per file, and an empty file is refused rather than stored', () => {
  assert.equal(T.MAX_FILE_BYTES, 10 * 1024 * 1024);
  assert.equal(T.classifyUpload({ name: 'a.png', type: 'image/png', size: T.MAX_FILE_BYTES }).ok, true);
  const over = T.classifyUpload({ name: 'a.png', type: 'image/png', size: T.MAX_FILE_BYTES + 1 });
  assert.equal(over.code, 'file_too_large');
  assert.match(over.message, /10MB/);
  assert.equal(T.classifyUpload({ name: 'a.png', type: 'image/png', size: 0 }).code, 'empty_file');
});

// ── the caps and the rate limit ──────────────────────────────────────────────
//
// consume() is driven against a fake that behaves the way the row does, so these assert the DECISIONS
// rather than the SQL. The SQL shape (FOR UPDATE, the hash lookup, no join to the deal) is asserted in
// src/api/intake-scope.test.js, where the fake reads the query text.

function fakeTx({ link, stored = 0 }) {
  const calls = [];
  const tx = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ');
    calls.push(s);
    if (/FROM sitenex_intake_links WHERE token_hash/.test(s)) {
      return { rows: link && link.token_hash === params[0] ? [link] : [] };
    }
    if (/SUM\(file_size\)/.test(s)) return { rows: [{ total: String(stored) }] };
    if (/UPDATE sitenex_intake_links/.test(s)) {
      link.request_count += 1;
      link.bytes_uploaded = Number(link.bytes_uploaded) + Number(params[1] || 0);
      if (params[3]) link.window_requests += 1;
      else { link.window_started_at = params[2]; link.window_requests = 1; }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  };
  tx.calls = calls;
  return tx;
}
const live = (token, over = {}) => ({
  id: 7, deal_id: 41, token_hash: T.hashToken(token), token_tail: token.slice(-4),
  expires_at: new Date(Date.now() + 86400000), revoked_at: null,
  request_count: 0, bytes_uploaded: 0, window_started_at: null, window_requests: 0, ...over,
});

test('a live token resolves to a deal id AND NOTHING ELSE', () => {
  // THE UPLOAD-ONLY SCOPE, expressed as the return value. A caller cannot leak a price it was never
  // given, which is a stronger guarantee than a caller that was given one and chose not to use it.
  const { token } = T.newToken();
  const tx = fakeTx({ link: live(token) });
  return T.consume(tx, { token }).then(r => {
    assert.deepEqual(Object.keys(r).sort(), ['deal_id', 'id', 'ok']);
    assert.equal(r.deal_id, 41);
  });
});

test('a revoked token is 410 and an expired one is 410, with distinct, honest messages', async () => {
  const { token } = T.newToken();
  const revoked = await T.consume(fakeTx({ link: live(token, { revoked_at: new Date() }) }), { token });
  assert.equal(revoked.status, 410);
  assert.equal(revoked.code, 'link_revoked');
  assert.match(revoked.message, /most recent link/);

  const expired = await T.consume(fakeTx({ link: live(token, { expires_at: new Date(Date.now() - 1000) }) }), { token });
  assert.equal(expired.status, 410);
  assert.equal(expired.code, 'link_expired');
});

test('an unknown token and an implausible one return the IDENTICAL body — enumeration learns nothing', async () => {
  const unknown = await T.consume(fakeTx({ link: null }), { token: 'Z'.repeat(43) });
  const junk = await T.consume(fakeTx({ link: null }), { token: 'nope' });
  assert.equal(unknown.status, 404);
  assert.deepEqual({ ...unknown }, { ...junk },
    'distinguishing "no such token" from "that is not a token" tells a scanner it found something real');
});

test('the per-window request cap refuses with 429 and a Retry-After the client can act on', async () => {
  const { token } = T.newToken();
  const started = new Date(Date.now() - 10 * 60000);           // 10 minutes into the hour
  const r = await T.consume(fakeTx({ link: live(token, {
    window_started_at: started, window_requests: T.MAX_REQUESTS_PER_WINDOW }) }), { token });
  assert.equal(r.status, 429);
  assert.equal(r.code, 'rate_limited');
  assert.ok(r.retry_after_s > 0 && r.retry_after_s <= 3600, `got ${r.retry_after_s}`);
});

test('a window that has rolled over starts clean — the cap is a rate, not a lifetime total', async () => {
  const { token } = T.newToken();
  const link = live(token, { window_started_at: new Date(Date.now() - 2 * 3600000),
                             window_requests: T.MAX_REQUESTS_PER_WINDOW });
  const r = await T.consume(fakeTx({ link }), { token });
  assert.equal(r.ok, true, 'an hour later, the client may upload again');
  assert.equal(link.window_requests, 1, 'and the counter restarted rather than incrementing');
});

test('the lifetime total cap exists as well, so a slow grind is also bounded', async () => {
  // The window alone permits MAX_REQUESTS_PER_WINDOW an hour forever. Two caps, because they stop
  // different things.
  const { token } = T.newToken();
  const r = await T.consume(fakeTx({ link: live(token, { request_count: T.MAX_REQUESTS_TOTAL }) }), { token });
  assert.equal(r.status, 429);
  assert.equal(r.code, 'link_exhausted');
});

test('every accepted request is counted, including a read', async () => {
  const { token } = T.newToken();
  const link = live(token);
  const tx = fakeTx({ link });
  await T.consume(tx, { token });
  await T.consume(tx, { token });
  assert.equal(link.request_count, 2, 'a read costs a request, or the limiter is trivially bypassed');
  assert.equal(link.window_requests, 2);
});

// ── the per-deal cap REFUSES; it does not truncate ──────────────────────────

test('50MB per deal, measured against what is STORED, not against this link', async () => {
  // A deal can have had two links. The 50MB is a property of the deal, so the check sums the files.
  assert.equal(T.MAX_DEAL_BYTES, 50 * 1024 * 1024);
  const { token } = T.newToken();
  const stored = T.MAX_DEAL_BYTES - 1024;
  const r = await T.consume(fakeTx({ link: live(token), stored }), { token, bytes: 5 * 1024 * 1024 });
  assert.equal(r.status, 413);
  assert.equal(r.code, 'deal_quota_exceeded');
  assert.equal(r.used_bytes, stored);
  assert.equal(r.remaining_bytes, 1024);
});

test('the refusal says how much room is left, so the client can act without emailing us', async () => {
  const { token } = T.newToken();
  const r = await T.consume(fakeTx({ link: live(token), stored: 42 * 1048576 }), { token, bytes: 9 * 1048576 });
  assert.equal(r.code, 'deal_quota_exceeded');
  assert.match(r.message, /8MB of 50MB left/);
});

test('a file that exactly fills the remaining quota is ACCEPTED — the cap is a limit, not a margin', async () => {
  const { token } = T.newToken();
  const stored = T.MAX_DEAL_BYTES - 4096;
  const r = await T.consume(fakeTx({ link: live(token), stored }), { token, bytes: 4096 });
  assert.equal(r.ok, true);
});

test('NOTHING IS COUNTED when a request is refused', async () => {
  // A refusal that still incremented the counters would let a client burn their own link by repeatedly
  // trying one file that is too big.
  const { token } = T.newToken();
  const link = live(token);
  await T.consume(fakeTx({ link, stored: T.MAX_DEAL_BYTES }), { token, bytes: 1024 });
  assert.equal(link.request_count, 0);
  assert.equal(Number(link.bytes_uploaded), 0);
});

test('the quota is checked BEFORE the counters are written, in the same locked read', async () => {
  const { token } = T.newToken();
  const tx = fakeTx({ link: live(token), stored: 0 });
  await T.consume(tx, { token, bytes: 1024 });
  const lookup = tx.calls.findIndex(s => /FROM sitenex_intake_links WHERE token_hash/.test(s));
  const sum = tx.calls.findIndex(s => /SUM\(file_size\)/.test(s));
  const update = tx.calls.findIndex(s => /UPDATE sitenex_intake_links/.test(s));
  assert.ok(lookup >= 0 && sum > lookup && update > sum,
    'lock the link, then measure the deal, then write — any other order lets two uploads both pass the last byte');
});

test('consume refuses to run outside a transaction', () => {
  // The read of the counters and the write of the counters cannot be separated, so passing anything but
  // a transaction client is a bug worth failing loudly on rather than racing quietly.
  return assert.rejects(() => T.consume(null, { token: T.newToken().token }),
    /pass \(sql, params\)/, 'the error must name what to pass instead');
});
