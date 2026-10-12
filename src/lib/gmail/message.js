// ── BUILDING A MESSAGE THAT LOOKS LIKE A PERSON SENT IT ───────────────────────
//
// The whole reason these follow-ups go through Gmail rather than a sequencer is that the
// recipients met Naresh in person and agreed a model. Everything here serves that: no tracking
// pixel, no redirect wrapper, no List-Unsubscribe, no bulk headers, no "sent with" footer. A
// recipient who views the source should see an ordinary email.
//
// ── THREADING IS THE PART THAT GIVES IT AWAY ─────────────────────────────────
//
// A second email with the subject "Re: ..." that arrives as a NEW conversation is the clearest
// possible tell that software sent it, because a human replying to their own message would stay in
// the thread. Gmail needs two things to agree:
//
//   · `threadId` on the API call — which is Gmail's own grouping, and not enough on its own,
//   · `In-Reply-To` and `References` headers carrying the RFC822 Message-ID of the previous
//     message — which is what every OTHER mail client in the thread uses, including the
//     recipient's.
//
// Set only the first and the follow-up threads correctly in Naresh's mailbox and incorrectly in
// theirs, which is exactly the wrong way round. So the sender records the Message-ID of each send
// and both are set on the next one.
//
// ── WHY BASE64 EVERYWHERE ────────────────────────────────────────────────────
//
// Contact names on these cards include "Québec"-class characters today and will include more as
// the list grows into Europe. Rather than deciding per-part whether something is 7-bit clean —
// which is the kind of check that works until the first name with an accent in it — every text
// part is base64 with an explicit charset, and every header with a non-ASCII byte is encoded per
// RFC 2047. Both are always-correct rather than usually-correct.
'use strict';

const crypto = require('crypto');

const CRLF = '\r\n';

/** Gmail's API wants base64url with no padding, which is NOT the same as base64. */
function toBase64Url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Body parts: standard base64, wrapped at 76 columns as RFC 2045 requires. */
function base64Lines(input) {
  const b64 = Buffer.from(input).toString('base64');
  return (b64.match(/.{1,76}/g) || []).join(CRLF);
}

const isAscii = (s) => !/[^\x00-\x7F]/.test(String(s));

/**
 * RFC 2047 for a header value that is not pure ASCII. Encoded in short chunks so no encoded-word
 * exceeds 75 characters, which is the limit real mail servers enforce.
 */
function encodeHeaderWord(value) {
  const s = String(value == null ? '' : value);
  if (isAscii(s)) return s;
  const chunks = [];
  // 30 BYTES, not characters: a multi-byte character split across two encoded-words becomes two
  // broken ones. Buffer slicing on a character boundary is what keeps that from happening.
  let buf = Buffer.from(s, 'utf8');
  while (buf.length) {
    let take = Math.min(30, buf.length);
    // Do not cut mid-character: back off while the next byte is a UTF-8 continuation byte.
    while (take < buf.length && (buf[take] & 0xC0) === 0x80) take -= 1;
    if (take <= 0) take = Math.min(30, buf.length);
    chunks.push(`=?UTF-8?B?${buf.subarray(0, take).toString('base64')}?=`);
    buf = buf.subarray(take);
  }
  return chunks.join(`${CRLF} `);
}

/** `Name <addr@example.com>`, with the display name encoded or quoted as needed. */
function formatAddress(name, email) {
  const addr = String(email || '').trim();
  const n = String(name || '').trim();
  if (!n) return addr;
  if (!isAscii(n)) return `${encodeHeaderWord(n)} <${addr}>`;
  // A display name containing , ; : " ( ) < > @ must be quoted or the address parses wrong.
  if (/[,;:"()<>@\\]/.test(n)) return `"${n.replace(/(["\\])/g, '\\$1')}" <${addr}>`;
  return `${n} <${addr}>`;
}

/**
 * A Message-ID we generate ourselves, so the value is known BEFORE the send and can be stored
 * against the row. Gmail assigns one if we omit the header — but it is only discoverable by
 * reading the sent message back, and a follow-up that cannot cite the previous Message-ID cannot
 * thread. Generating it removes that round trip and the failure mode where the read-back is lost.
 */
function newMessageId(domain) {
  const host = String(domain || 'abiozen.com').replace(/^.*@/, '');
  return `<${Date.now().toString(36)}.${crypto.randomBytes(12).toString('hex')}@${host}>`;
}

function boundary(tag) {
  return `----=_${tag}_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Build the RFC 5322 message.
 *
 *   from        { name, email }
 *   to          { name, email }
 *   subject     string
 *   html        string — the body as HTML
 *   text        string — the plain-text alternative. REQUIRED: an HTML-only message scores badly
 *               with spam filters and is unreadable in a text client, and a follow-up that lands
 *               in spam is worse than one never sent.
 *   inReplyTo   the previous message's Message-ID, for a follow-up
 *   references  array of earlier Message-IDs, oldest first
 *   attachments [{ filename, contentType, content: Buffer }]
 *   messageId   override, otherwise generated
 *   date        Date, otherwise now
 *
 * Returns { raw, messageId, headers } — `raw` is base64url for users.messages.send.
 */
function buildMessage(opts = {}) {
  const {
    from, to, subject = '', html = '', text = '',
    inReplyTo = null, references = [], attachments = [], date = new Date(),
  } = opts;

  if (!from || !from.email) throw new Error('from.email is required');
  if (!to || !to.email) throw new Error('to.email is required');
  if (!html) throw new Error('html is required');
  if (!text) {
    // Deliberately fatal rather than auto-stripped from the HTML. A generated text part made by
    // removing tags reads like a machine wrote it, which is the one impression this campaign
    // cannot afford — and it is exactly what a reader on a watch or a text client sees.
    throw new Error('text is required — an HTML-only message is unreadable in a text client and scores badly with filters');
  }

  const messageId = opts.messageId || newMessageId(from.email);
  const altBoundary = boundary('alt');
  const mixBoundary = boundary('mix');
  const hasAttachments = attachments.length > 0;

  const headers = [
    ['From', formatAddress(from.name, from.email)],
    ['To', formatAddress(to.name, to.email)],
    ['Subject', encodeHeaderWord(subject)],
    ['Date', date.toUTCString().replace('GMT', '+0000')],
    ['Message-ID', messageId],
    ['MIME-Version', '1.0'],
  ];
  if (inReplyTo) {
    headers.push(['In-Reply-To', inReplyTo]);
    // References carries the whole chain, oldest first, and the message being replied to must be
    // last. A client that cannot find the parent in References starts a new thread.
    const chain = [...references.filter(Boolean)];
    if (!chain.includes(inReplyTo)) chain.push(inReplyTo);
    headers.push(['References', chain.join(' ')]);
  }

  const lines = headers.map(([k, v]) => `${k}: ${v}`);

  const alternative = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    '',
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    '',
    `--${altBoundary}--`,
  ];

  let body;
  if (!hasAttachments) {
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`, '');
    body = alternative;
  } else {
    lines.push(`Content-Type: multipart/mixed; boundary="${mixBoundary}"`, '');
    body = [
      `--${mixBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
      ...alternative,
      '',
    ];
    for (const a of attachments) {
      if (!a || !a.filename || !a.content) throw new Error('each attachment needs filename and content');
      body.push(
        `--${mixBoundary}`,
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename}"`,
        'Content-Transfer-Encoding: base64',
        // `attachment` rather than `inline`: a PDF one-pager should appear as a file to open, the
        // way a person attaching a document would send it.
        `Content-Disposition: attachment; filename="${a.filename}"`,
        '',
        base64Lines(a.content),
        '',
      );
    }
    body.push(`--${mixBoundary}--`);
  }

  const mime = [...lines, ...body].join(CRLF);
  return { raw: toBase64Url(mime), messageId, mime, headers: Object.fromEntries(headers) };
}

module.exports = {
  buildMessage, newMessageId, formatAddress, encodeHeaderWord, toBase64Url, base64Lines,
};
