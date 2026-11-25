// ── B7.7: THE BYTES GET JUDGED ──────────────────────────────────────────────
//
//   node --test src/lib/outbound/mime-authorization.test.js
//
// The decisive test is 2. Everything else is the parser being made trustworthy enough for 2 to
// mean something.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const M = require('./mime-authorization');
const D = require('./dispatch');

const STRANGER = 'stranger@acme-pharma.test';
const COLLEAGUE = 'ops@abiozen.com';
const SALES = 'sales@abiozen.com';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const mime = (headerLines, body = 'hello') => `${headerLines.join('\r\n')}\r\n\r\n${body}`;
const raw = (headerLines, body = 'hello') => b64url(mime(headerLines, body));

// ═══ 1. THE HAPPY PATH ═════════════════════════════════════════════════════

test('1. a well-formed message authorizes, and reports who actually receives it', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: "Naren B" <${SALES}>`, `To: Ops <${COLLEAGUE}>`, 'Subject: x']),
    to: COLLEAGUE, from: SALES,
  });
  assert.strictEqual(v.ok, true, v.reason);
  assert.deepStrictEqual(v.recipients, [COLLEAGUE]);
  assert.strictEqual(v.sender, SALES);
  assert.strictEqual(v.encoding, 'base64url');
});

// ═══ 2. THE DEFECT THIS EXISTS TO CLOSE ════════════════════════════════════

test('2. DECISIVE: a blob addressed to a stranger under an internal envelope is REFUSED', () => {
  // This is the whole of B7.7. dispatch decides whether a human approval is MANDATORY by
  // classifying the envelope. An envelope naming a colleague is internal, so no approval is
  // required and no digest is ever taken — and Gmail then delivers to whoever the bytes name.
  //
  // Reachable by any caller of dispatch, and NOT protected by the digest binding, because on this
  // path there is no approval for a digest to bind to.
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${STRANGER}`, 'Subject: Quotation']),
    to: COLLEAGUE,                       // what the gate and the classification would have seen
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'recipient_not_in_envelope');
  assert.deepStrictEqual(v.unjudged, [STRANGER]);
});

test('2a. …and the same blob is refused by dispatch, with nothing transmitted', async () => {
  const sends = [];
  const deps = {
    env: { COMPANY_EMAIL_DOMAINS: 'abiozen.com' },
    gate: { assertSendAllowed: async () => ({ allowed: true }) },
    ledger: {
      beginAttempt: async () => ({ ok: true, id: 'att-1', blocked: async () => {},
        claim: async () => ({ ok: true }), accepted: async () => {}, rejected: async () => {},
        unknown: async () => {} }),
      priorClaim: async () => null,
      idempotencyHash: (k) => `h-${k}`,
    },
    transports: { gmail: { send: async (m) => { sends.push(m); return { ok: true, id: 'm-1' }; } } },
  };
  const r = await D.dispatch({
    message: { to: COLLEAGUE, subject: 'Quotation', mailbox: SALES,
      raw: raw([`From: ${SALES}`, `To: ${STRANGER}`, 'Subject: Quotation']) },
    transport: 'gmail', idempotencyKey: 'smuggle-1',
  }, deps);

  assert.strictEqual(sends.length, 0,
    'a message whose bytes address a stranger was transmitted under an internal envelope');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.mimeVerdict, 'recipient_not_in_envelope');
});

test('2b. a Cc inside the bytes counts as a recipient', () => {
  // The recipient-coverage scanner called this hole latent because no caller of buildMessage
  // supplies a Cc. That was an inventory of one producer, not a property of the road: `raw` does
  // not have to come from buildMessage.
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`, `Cc: ${STRANGER}`, 'Subject: x']),
    to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'recipient_not_in_envelope');
  assert.deepStrictEqual(v.unjudged, [STRANGER]);
});

test('2c. a Bcc inside the bytes counts too — Gmail honours it', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`, `Bcc: ${STRANGER}`, 'Subject: x']),
    to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(v.unjudged, [STRANGER]);
});

test('2d. the other direction is a different failure, and is named differently', () => {
  // Nobody unauthorized receives this one. But the gate and any approval judged a message that is
  // not the one being sent, and the next such disagreement may run the other way.
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`, 'Subject: x']),
    to: [COLLEAGUE, 'other@abiozen.com'],
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'envelope_recipient_absent_from_message');
  assert.deepStrictEqual(v.undelivered, ['other@abiozen.com']);
});

// ═══ 3. AMBIGUITY IS REFUSED, NEVER RESOLVED ═══════════════════════════════

test('3. two To headers are refused, not merged', () => {
  // The classic smuggling shape: one agent reads the first occurrence, another the last. Merging
  // them — which catalogue/rfc822.js parseHeaders does, correctly, for its own purpose — produces a
  // single tidy value consistent with neither reading.
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`, `To: ${STRANGER}`, 'Subject: x']),
    to: [COLLEAGUE, STRANGER],           // even naming both, it stays refused
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'ambiguous_headers');
  assert.deepStrictEqual(v.duplicated, ['to']);
});

test('3a. two From headers are refused', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `From: naren@abiozen.com`, `To: ${COLLEAGUE}`]),
    to: COLLEAGUE,
  });
  assert.strictEqual(v.code, 'ambiguous_headers');
  assert.deepStrictEqual(v.duplicated, ['from']);
});

test('3b. every singleton header is covered, not just the ones I thought of', () => {
  // Asserted as a set so adding a header to the module without a test is visible.
  assert.deepStrictEqual([...M.SINGLETON_HEADERS].sort(),
    ['bcc', 'cc', 'from', 'reply-to', 'sender', 'to']);
  for (const h of M.SINGLETON_HEADERS) {
    const name = h.replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase());
    const v = M.authorizeRawMessage({
      raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`, `${name}: a@abiozen.com`,
        `${name}: b@abiozen.com`]),
      to: COLLEAGUE,
    });
    assert.strictEqual(v.code, 'ambiguous_headers', `a duplicated ${name} was not refused`);
  }
});

test('3c. group syntax is refused rather than expanded', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: Team: ${COLLEAGUE}, ${STRANGER};`]),
    to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'group_syntax');
});

// ═══ 4. THE PARSER ═════════════════════════════════════════════════════════

test('4. a comma inside a quoted display name separates nothing', () => {
  // A parser that splits on every comma turns one recipient into two unparseable ones, and the
  // refusal that follows reads as a malformed message rather than as a parser bug.
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: "Das, Palash" <${COLLEAGUE}>`]),
    to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, true, v.reason);
  assert.deepStrictEqual(v.recipients, [COLLEAGUE]);
});

test('4a. a folded header is read as one value', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE},`, `\t${'second@abiozen.com'}`]),
    to: [COLLEAGUE, 'second@abiozen.com'],
  });
  assert.strictEqual(v.ok, true, v.reason);
  assert.deepStrictEqual(v.recipients, [COLLEAGUE, 'second@abiozen.com']);
});

test('4b. an RFC822 comment is not part of an address', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE} (the ops mailbox)`]),
    to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, true, v.reason);
  assert.deepStrictEqual(v.recipients, [COLLEAGUE]);
});

test('4c. addresses are compared case-insensitively', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: OPS@Abiozen.COM`]),
    to: 'ops@ABIOZEN.com',
  });
  assert.strictEqual(v.ok, true, v.reason);
});

test('4d. an unreadable address is refused, not dropped', () => {
  for (const bad of ['not-an-address', 'two@at@signs.com', 'trailing@', '@nolocal.com',
    'has space@abiozen.com']) {
    const v = M.authorizeRawMessage({
      raw: raw([`From: ${SALES}`, `To: ${bad}`]), to: COLLEAGUE,
    });
    assert.strictEqual(v.ok, false, `${bad} was accepted as an address`);
    assert.match(v.code, /unparseable_address|recipient_not_in_envelope/);
  }
});

test('4d2. a colon inside angle brackets is refused rather than read as a group OR an address', () => {
  // This case exists because a mutation showed the `!angle` guard on the group-syntax check was
  // unobservable: a comma inside `<…>` is refused either way. A COLON is where the guard does
  // decide something — `<a:b@x>` must not read as group syntax, and must then not be accepted as an
  // address either. Both halves, or the token is delivered to something no mail agent agrees on.
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: Ops <ops:x@abiozen.com>`]), to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'unparseable_address');
});

test('4e. an unterminated quote or angle bracket is refused', () => {
  const q = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: "Unclosed <${COLLEAGUE}>`]), to: COLLEAGUE,
  });
  assert.strictEqual(q.code, 'unbalanced_quotes');
  const a = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: Ops <${COLLEAGUE}`]), to: COLLEAGUE,
  });
  assert.strictEqual(a.code, 'unbalanced_angle');
});

test('4f. a line in the header block that is not a header is refused', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`, 'this is not a header at all']),
    to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'malformed_headers');
});

// ═══ 5. THE SENDER ═════════════════════════════════════════════════════════

test('5. a message with no From cannot establish which account it claims', () => {
  const v = M.authorizeRawMessage({ raw: raw([`To: ${COLLEAGUE}`, 'Subject: x']), to: COLLEAGUE });
  assert.strictEqual(v.code, 'sender_unestablished');
});

test('5a. a From naming two identities has no single authorized sender', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}, naren@abiozen.com`, `To: ${COLLEAGUE}`]), to: COLLEAGUE,
  });
  assert.strictEqual(v.code, 'ambiguous_sender');
});

test('5b. a sender the envelope does not declare is refused', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${STRANGER}`, `To: ${COLLEAGUE}`]), to: COLLEAGUE, from: SALES,
  });
  assert.strictEqual(v.code, 'sender_mismatch');
  assert.strictEqual(v.messageSender, STRANGER);
  assert.strictEqual(v.envelopeSender, SALES);
});

test('5c. with no envelope sender, the two are not compared — that is B7.9, not this', () => {
  // Inventing an expectation here would answer a question nobody asked. Whether a sender is
  // AUTHORIZED for the company is a separate boundary; this one only checks they agree.
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`]), to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, true, v.reason);
  assert.strictEqual(v.sender, SALES);
});

test('5d. a Reply-To the envelope does not declare is refused — where an answer lands was approved', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`, `Reply-To: ${STRANGER}`]),
    to: COLLEAGUE, replyTo: 'naren@abiozen.com',
  });
  assert.strictEqual(v.code, 'reply_to_mismatch');
});

// ═══ 6. THE BYTES MUST BE READABLE AT ALL ══════════════════════════════════

test('6. a blob with no header block is refused, not treated as having no recipients', () => {
  // The dangerous reading is "no recipients found, therefore internal". A message whose
  // destination cannot be established is not an internal send.
  for (const bad of ['UkFXLU9SSUdJTkFM', 'Ug', 'not base64 and not mime either', '   ']) {
    const v = M.authorizeRawMessage({ raw: bad, to: COLLEAGUE });
    assert.strictEqual(v.ok, false, `${JSON.stringify(bad)} was accepted as a message`);
    assert.strictEqual(v.code, 'unparseable_mime');
  }
});

test('6a. plain MIME text is accepted, and reported as such', () => {
  const v = M.authorizeRawMessage({
    raw: mime([`From: ${SALES}`, `To: ${COLLEAGUE}`]), to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, true, v.reason);
  assert.strictEqual(v.encoding, 'plain');
});

test('6b. a Buffer is accepted', () => {
  const v = M.authorizeRawMessage({
    raw: Buffer.from(mime([`From: ${SALES}`, `To: ${COLLEAGUE}`]), 'utf8'), to: COLLEAGUE,
  });
  assert.strictEqual(v.ok, true, v.reason);
});

test('6c. a header block beyond the scan limit is refused rather than searched further', () => {
  const padding = 'X'.repeat(M.HEADER_SCAN_BYTES * 2);
  const v = M.authorizeRawMessage({ raw: b64url(`${padding}\r\n\r\nbody`), to: COLLEAGUE });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'unparseable_mime');
});

test('6c2. the scan limit holds for a Buffer too, not only for a string', () => {
  // It did not. The bound was applied on the string path and skipped on the Buffer path, so the
  // property this module states held for one of its two accepted input shapes. A property that
  // holds for one of two shapes is not a property, and the asymmetry is invisible until somebody
  // passes the other one.
  const padding = Buffer.from('X'.repeat(M.HEADER_SCAN_BYTES * 2) + '\r\n\r\nbody', 'utf8');
  const v = M.authorizeRawMessage({ raw: padding, to: COLLEAGUE });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'unparseable_mime');
});

test('6d. a missing raw says so rather than passing', () => {
  for (const empty of [null, undefined, '']) {
    assert.strictEqual(M.authorizeRawMessage({ raw: empty, to: COLLEAGUE }).code, 'no_raw');
  }
  assert.strictEqual(M.authorizeRawMessage({ raw: 42, to: COLLEAGUE }).code, 'unparseable_mime');
});

test('6e. a message naming nobody is refused', () => {
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, 'Subject: x']), to: COLLEAGUE,
  });
  assert.strictEqual(v.code, 'no_message_recipient');
});

// ═══ 7. THE DISCIPLINE THAT KEEPS THIS HONEST ══════════════════════════════

test('7. this module keeps duplicate headers rather than merging them', () => {
  // Stated as a property of the parser, because the merging parser is one import away and is the
  // obvious thing for a future reader to reach for.
  const { headers } = M.parseHeadersStrict(`To: a@x.test\r\nTo: b@x.test`);
  assert.deepStrictEqual(headers.get('to'), ['a@x.test', 'b@x.test'],
    'duplicate headers were merged, which makes an ambiguous message look consistent');
});

test('7a. it does not require the lenient catalogue parser', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./mime-authorization.js'), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '');       // comments discuss it deliberately
  assert.doesNotMatch(code, /catalogue\/rfc822/,
    'this module requires the parser that merges duplicate headers');
  assert.doesNotMatch(code, /parseHeaders\b(?!Strict)/);
});

test('7b. nothing is quietly dropped: an accepted message reports EVERY address in its headers', () => {
  // Asserted as behaviour rather than by grepping for mutation, which is the prose-matching
  // mistake this repository has made before — and which would have failed here anyway, since the
  // parser legitimately builds its own map with `headers.set`.
  //
  // The property that matters: a repair is a refusal turned into a quieter send. If this ever
  // stripped the Cc instead of reporting it, the send would succeed with the Cc still in the bytes
  // and nothing would have judged it.
  const v = M.authorizeRawMessage({
    raw: raw([`From: ${SALES}`, `To: ${COLLEAGUE}`, `Cc: ${STRANGER}`,
      'Bcc: third@abiozen.com']),
    to: COLLEAGUE, cc: STRANGER, bcc: 'third@abiozen.com',
  });
  assert.strictEqual(v.ok, true, v.reason);
  assert.deepStrictEqual(v.recipients, [COLLEAGUE, STRANGER, 'third@abiozen.com'].sort(),
    'an address present in the transmitted headers is missing from what was authorized');
});
