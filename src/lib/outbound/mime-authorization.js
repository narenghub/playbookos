// ── B7.7: THE BYTES DECIDE WHO RECEIVES THE MESSAGE, SO THE BYTES GET JUDGED ─
//
//   const v = authorizeRawMessage({ raw, to, cc, bcc, from, replyTo });
//   if (!v.ok) refuse(v.code, v.reason);
//   // v.recipients is every address that will actually receive it
//
// Owner instruction, carried since 2026-11-24 and restated in Decision 5:
//
//   *"B7.7 raw MIME authorization. Authorize parsed MIME headers; reject malformed, ambiguous or
//    conflicting headers; verify envelope-vs-message consistency."*
//
// ── THE DEFECT, AND IT IS NOT LATENT ───────────────────────────────────────
//
// `dispatch()` decides whether a human approval is MANDATORY by classifying the envelope `to`. For
// the Resend road that is the message. For the Gmail road it is a *description* of the message: the
// bytes transmitted are `raw`, a prepared RFC822 blob, and Gmail derives the recipients from the
// `To`, `Cc` and `Bcc` headers **inside those bytes**. Nothing read them.
//
// So, reachable today by any caller of dispatch:
//
//   dispatch({ message: { to: 'naren@abiozen.com',          // internal → approval not required
//                         raw: base64url('To: stranger@example.com\r\n…') },
//              transport: 'gmail' })
//
// Step 3 classifies the envelope as internal, step 4 therefore does not require an approvalId or a
// digest, step 8 hands the gate the same internal address, and the blob goes to Gmail, which sends
// it to the stranger. This is the `cc` bypass of B7.2 one layer down, and it bypasses not merely
// the recipient check but **the approval requirement itself** — there is no approval to bind the
// bytes to, because the envelope looked like internal mail.
//
// `check-email-gate-recipient-coverage.js` has described this hole since it was written and calls
// it latent, because no caller of `gmail/message.js buildMessage` supplies a `cc`. That reasoning
// is sound about buildMessage and silent about dispatch: a `raw` blob does not have to come from
// buildMessage. The latency was an inventory of one producer, not a property of the road.
//
// ── WHY THIS DOES NOT REUSE catalogue/rfc822.js parseHeaders ────────────────
//
// It parses the same thing and would be the obvious import. It MERGES duplicate headers:
//
//   out[k] = out[k] ? `${out[k]}, ${m[2]}` : m[2];
//
// which is right for reading a supplier's attachment and wrong for authorization, because two
// `To:` headers are the classic smuggling shape — one agent reads the first, another reads the
// last, and merging them produces a single tidy value that looks consistent with neither. An
// authorization parser has to be able to say *"this message has two To headers"*, so it keeps every
// occurrence and refuses rather than choosing. Reusing the lenient parser here would have turned a
// refusal into a merge.
//
// ── EVERY REFUSAL IS A REFUSAL, NOT A REPAIR ───────────────────────────────
//
// Nothing here rewrites, strips or normalises a header. A malformed address is refused, not
// dropped; an ambiguous header set is refused, not resolved; a group address is refused, not
// expanded. Stripping lets the send succeed minus its effect, and the attempt is what a reviewer
// needs to see. The one transformation is case-folding for comparison.

'use strict';

// At most one of each of these is permitted. RFC 5322 §3.6 says so for all of them; here the point
// is narrower — a second occurrence makes "who receives this" a question with two answers, and a
// security decision cannot be taken on a value that depends on which agent reads it.
const SINGLETON_HEADERS = Object.freeze(['from', 'sender', 'reply-to', 'to', 'cc', 'bcc']);
const RECIPIENT_HEADERS = Object.freeze(['to', 'cc', 'bcc']);

// Headers must appear within this much of the decoded message. A blob whose header block starts
// later than this is refused rather than searched further: an attachment-sized prefix with no
// blank line in it is not a message whose recipients we failed to find, it is a message we cannot
// establish the recipients of, and those are the same thing for a fail-closed decision.
const HEADER_SCAN_BYTES = 256 * 1024;

const problem = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

/**
 * Decode whatever a caller put in `raw` into MIME text.
 *
 * Gmail's API takes base64url, which is what `gmail/message.js` produces, so that is tried first.
 * Base64 decoding in Node does not throw on rubbish — it silently discards the characters outside
 * the alphabet — so a successful *decode* proves nothing. The test is whether the result contains a
 * header block, and only a reading that does is accepted.
 *
 * The two readings cannot both succeed: a base64url string contains no `:` and no newline, so it
 * cannot itself hold a `Name: value` line. That is why this can try both without having to rank
 * them.
 */
function decodeRaw(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return problem('no_raw', 'there is no raw message to authorize');
  }
  if (Buffer.isBuffer(raw)) {
    // The SAME bound as the string path below. It was missing here, so the limit this module states
    // — headers appear within HEADER_SCAN_BYTES or the message is refused — held for a string and
    // not for a Buffer, and §6c would have passed for one input type and failed for the other.
    // A property that holds for one of two accepted shapes is not a property.
    const text = raw.subarray(0, HEADER_SCAN_BYTES).toString('binary');
    const head = headerBlockOf(text);
    return head ? { ok: true, mime: text, encoding: 'buffer', head } : null;
  }
  if (typeof raw !== 'string') {
    return problem('unparseable_mime',
      `raw must be a string or a Buffer, not ${typeof raw} — a message whose bytes cannot be read `
      + 'cannot have its recipients established');
  }

  // Decode only a bounded prefix. A 30MB attachment does not need decoding to find the headers,
  // and the slice is cut to a multiple of 4 so the base64 groups stay intact.
  const prefix = raw.length > HEADER_SCAN_BYTES
    ? raw.slice(0, HEADER_SCAN_BYTES - (HEADER_SCAN_BYTES % 4))
    : raw;

  const decoded = Buffer.from(prefix.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    .toString('binary');
  const fromB64 = headerBlockOf(decoded);
  if (fromB64) return { ok: true, mime: decoded, encoding: 'base64url', head: fromB64 };

  const asText = headerBlockOf(prefix);
  if (asText) return { ok: true, mime: prefix, encoding: 'plain', head: asText };

  return problem('unparseable_mime',
    'the raw message has no header block (no blank line separating headers from body) in its first '
    + `${HEADER_SCAN_BYTES} bytes, read both as base64url and as text. Its recipients cannot be `
    + 'established, so it is refused rather than sent to whoever its headers may name');
}

/** The header text, or null. Both CRLFCRLF and LFLF occur in the wild. */
function headerBlockOf(s) {
  for (const sep of ['\r\n\r\n', '\n\n']) {
    const i = s.indexOf(sep);
    if (i > 0) return s.slice(0, i);
  }
  // A header block that runs to the end of a prefix with no blank line is not a header block: the
  // next byte could be another recipient header. Refusing is the only safe reading.
  return null;
}

/**
 * Index the header block, KEEPING every occurrence.
 *
 * @returns {{headers: Map<string, string[]>, malformed: string[]}}
 */
function parseHeadersStrict(head) {
  const unfolded = String(head).replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map();
  const malformed = [];
  for (const line of unfolded.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z0-9!#$%&'*+.^_`|~-]+)[ \t]*:(.*)$/);
    if (!m) { malformed.push(line.slice(0, 120)); continue; }
    const k = m[1].toLowerCase();
    if (!headers.has(k)) headers.set(k, []);
    headers.get(k).push(m[2].trim());
  }
  return { headers, malformed };
}

/**
 * Split an address list on the commas that separate addresses, and only those.
 *
 * A comma inside a quoted display name (`"Das, Palash" <p@x>`) separates nothing, and a parser that
 * splits on every comma turns one recipient into two unparseable ones. Group syntax
 * (`Team: a@x, b@y;`) is REFUSED rather than expanded: it nests a list inside a list, and a
 * boundary that expands one is a boundary deciding on its own reading of an ambiguous construct.
 */
function splitAddressList(value) {
  const s = String(value === null || value === undefined ? '' : value);
  const items = [];
  let cur = '';
  let quote = false;
  let angle = false;
  let comment = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i += 1; continue; }
      if (c === '"') { quote = false; cur += c; continue; }
      cur += c;
      continue;
    }
    if (comment > 0) {
      if (c === '(') comment += 1;
      else if (c === ')') comment -= 1;
      continue;                                  // a comment is not part of any address
    }
    if (c === '"') { quote = true; cur += c; continue; }
    if (c === '(') { comment = 1; continue; }
    if (c === '<') { angle = true; cur += c; continue; }
    if (c === '>') { angle = false; cur += c; continue; }
    if ((c === ':' || c === ';') && !angle) {
      return problem('group_syntax',
        'this recipient header uses group syntax (`Name: a@x, b@y;`), which nests an address list '
        + 'inside an address list. It is refused rather than expanded — expanding it would mean this '
        + 'boundary deciding on its own reading of a construct two mail agents may read differently');
    }
    if (c === ',' && !angle) { items.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quote) {
    return problem('unbalanced_quotes',
      'this recipient header has an unterminated quoted string, so where one address ends and the '
      + 'next begins is undecidable');
  }
  if (angle) {
    return problem('unbalanced_angle',
      'this recipient header has an unterminated `<`, so the address it contains is undecidable');
  }
  if (comment > 0) {
    return problem('unbalanced_comment',
      'this recipient header has an unterminated `(` comment');
  }
  items.push(cur);
  return { ok: true, items: items.map((x) => x.trim()).filter((x) => x.length) };
}

/** `"Naren B" <naren@abiozen.com>` → `naren@abiozen.com`, or a refusal. */
function addressOf(item) {
  const m = String(item).match(/<([^<>]*)>/);
  const spec = (m ? m[1] : String(item)).trim();
  if (!spec) {
    return problem('unparseable_address', `no address could be read from ${JSON.stringify(item)}`);
  }
  const at = spec.indexOf('@');
  if (at < 1 || at !== spec.lastIndexOf('@') || at === spec.length - 1) {
    return problem('unparseable_address',
      `${JSON.stringify(spec)} is not a single address with one local part and one domain`);
  }
  // `:` is in this set deliberately, and it is the one character here that is not obviously a
  // delimiter. The `!angle` guard on the group-syntax check above means a `:` INSIDE angle
  // brackets does not read as a group — correctly, since `<a:b@x>` is one token, not a list — and
  // without this clause that token would then be accepted as an address, because a colon is
  // otherwise just a character. It is not valid in an addr-spec, and the two clauses together are
  // what make `<a:b@x>` refused rather than quietly delivered to something no mail agent agrees on.
  if (/[\s,;:<>"]/.test(spec)) {
    return problem('unparseable_address',
      `${JSON.stringify(spec)} contains whitespace or a delimiter inside the address itself`);
  }
  return { ok: true, address: spec.toLowerCase() };
}

/** Every address in one header value, or the first refusal. */
function addressesIn(value) {
  const split = splitAddressList(value);
  if (!split.ok) return split;
  const out = [];
  for (const item of split.items) {
    const a = addressOf(item);
    if (!a.ok) return a;
    out.push(a.address);
  }
  return { ok: true, addresses: out };
}

/**
 * Flatten an envelope field (`to`, `cc`, `bcc`) the permissive way the mailer already accepts them.
 *
 * Deliberately NOT this module's strict parser: the envelope is what existing callers pass today,
 * in the shapes they already pass it, and tightening that is a separate change with 55 call sites
 * behind it. The strictness lives on the `raw` side, where the bytes are, and the comparison below
 * is what ties the two together.
 */
function envelopeAddresses(...fields) {
  const RECIPIENTS = require('./recipients');
  const out = [];
  for (const f of fields) {
    for (const a of RECIPIENTS.addressesOf(f)) out.push(String(a).toLowerCase());
  }
  return [...new Set(out)];
}

const sorted = (xs) => [...new Set(xs)].sort();

/**
 * Authorize the recipients and sender named INSIDE the bytes, and check them against the envelope.
 *
 * @param {object} m           { raw, to, cc, bcc, from, replyTo }
 * @returns {{ok:boolean, code?:string, reason?:string, recipients?:string[], sender?:string,
 *            envelopeRecipients?:string[], encoding?:string}}
 *
 * `ok: true` means: the bytes parse, no recipient or sender header is duplicated or ambiguous,
 * every address in them is a single readable address, there is at least one recipient, the set of
 * recipients in the bytes is EXACTLY the set in the envelope, and the sender in the bytes is the
 * sender the envelope declares. Any other outcome is a refusal naming which.
 */
function authorizeRawMessage({ raw, to = null, cc = null, bcc = null,
  from = null, replyTo = null } = {}) {
  const decoded = decodeRaw(raw);
  if (!decoded) {
    return problem('unparseable_mime', 'the raw message could not be read');
  }
  if (decoded.ok !== true) return decoded;

  const { headers, malformed } = parseHeadersStrict(decoded.head);

  // A line in the header block that is not a header at all. Refused rather than skipped: the
  // lenient reading is how a smuggled continuation gets treated as noise by one agent and as a
  // header by another.
  if (malformed.length) {
    return problem('malformed_headers',
      `the header block contains ${malformed.length} line(s) that are not headers, the first being `
      + `${JSON.stringify(malformed[0])}. A header block that does not parse cleanly is refused, `
      + 'because a line two mail agents read differently is not a basis for an authorization decision');
  }

  // ── AMBIGUITY: TWO ANSWERS TO "WHO RECEIVES THIS" ────────────────────────
  const duplicated = SINGLETON_HEADERS.filter((h) => (headers.get(h) || []).length > 1);
  if (duplicated.length) {
    return problem('ambiguous_headers',
      `the message carries more than one ${duplicated.map((h) => `\`${h}\``).join(' and ')} header. `
      + 'That is the header-smuggling shape: one mail agent reads the first occurrence and another '
      + 'reads the last, so there is no single answer to who receives this message. Refused rather '
      + 'than resolved — picking one would make this boundary the agent that disagrees',
      { duplicated });
  }

  // ── THE RECIPIENTS THE BYTES NAME ────────────────────────────────────────
  const messageRecipients = [];
  for (const h of RECIPIENT_HEADERS) {
    const values = headers.get(h) || [];
    if (!values.length) continue;
    const parsed = addressesIn(values[0]);
    if (!parsed.ok) {
      return problem(parsed.code,
        `the \`${h}\` header of the raw message could not be authorized: ${parsed.reason}`,
        { header: h });
    }
    for (const a of parsed.addresses) messageRecipients.push(a);
  }

  if (!messageRecipients.length) {
    return problem('no_message_recipient',
      'the raw message names no recipient in To, Cc or Bcc. A message with no establishable '
      + 'destination is not an internal send, it is a send whose destination is unknown');
  }

  // ── THE SENDER THE BYTES NAME ────────────────────────────────────────────
  const fromValues = headers.get('from') || [];
  if (!fromValues.length) {
    return problem('sender_unestablished',
      'the raw message has no From header, so which identity and which provider account this send '
      + 'claims cannot be established');
  }
  const fromParsed = addressesIn(fromValues[0]);
  if (!fromParsed.ok) {
    return problem(fromParsed.code,
      `the \`from\` header of the raw message could not be authorized: ${fromParsed.reason}`,
      { header: 'from' });
  }
  if (fromParsed.addresses.length !== 1) {
    return problem('ambiguous_sender',
      `the From header names ${fromParsed.addresses.length} addresses. A message sent as more than `
      + 'one identity has no single authorized sender');
  }
  const sender = fromParsed.addresses[0];

  // ── ENVELOPE-VS-MESSAGE CONSISTENCY, BOTH DIRECTIONS ─────────────────────
  //
  // The two directions are different failures and are reported as such.
  //
  //   in the bytes but not the envelope → this recipient was never judged. The smuggling case.
  //   in the envelope but not the bytes → the approval and the gate judged a message that is not
  //                                      the one being sent. Nobody unauthorized receives it, but
  //                                      the description the human approved was wrong, and the next
  //                                      such disagreement may run the other way.
  const envelopeRecipients = envelopeAddresses(to, cc, bcc);
  const unjudged = messageRecipients.filter((a) => !envelopeRecipients.includes(a));
  if (unjudged.length) {
    return problem('recipient_not_in_envelope',
      `the raw message will be delivered to ${sorted(unjudged).join(', ')}, which the envelope does `
      + 'not name. Nothing has judged whether those addresses are inside this company, so nothing '
      + 'has decided whether this send needs a human approval. The bytes decide who receives the '
      + 'message, so the bytes are what must be authorized',
      { unjudged: sorted(unjudged), messageRecipients: sorted(messageRecipients),
        envelopeRecipients: sorted(envelopeRecipients) });
  }
  const undelivered = envelopeRecipients.filter((a) => !messageRecipients.includes(a));
  if (undelivered.length) {
    return problem('envelope_recipient_absent_from_message',
      `the envelope names ${sorted(undelivered).join(', ')}, who are not in the raw message's own `
      + 'headers and will not receive it. The gate and any approval therefore judged a different '
      + 'message from the one about to be transmitted',
      { undelivered: sorted(undelivered), messageRecipients: sorted(messageRecipients),
        envelopeRecipients: sorted(envelopeRecipients) });
  }

  // ── THE SENDER MUST BE THE ONE THE ENVELOPE DECLARES ─────────────────────
  //
  // Only checked when the envelope declares one. An absent envelope `from` is B7.9's subject —
  // whether the sender is AUTHORIZED for the company — and is enforced there; here the question is
  // only whether the two agree, and inventing an expectation would answer a question nobody asked.
  if (from) {
    const envFrom = envelopeAddresses(from);
    if (envFrom.length !== 1) {
      return problem('ambiguous_sender',
        `the envelope \`from\` resolves to ${envFrom.length} addresses; a send has one sender`);
    }
    if (envFrom[0] !== sender) {
      return problem('sender_mismatch',
        `the raw message is from ${sender} but the envelope declares ${envFrom[0]}. Which identity `
        + 'this message claims decides which provider account and which company authorization '
        + 'apply, and two answers is not one of them',
        { messageSender: sender, envelopeSender: envFrom[0] });
    }
  }

  if (replyTo) {
    const envReply = envelopeAddresses(replyTo);
    const hdrReply = headers.get('reply-to') || [];
    if (hdrReply.length) {
      const parsed = addressesIn(hdrReply[0]);
      if (!parsed.ok) {
        return problem(parsed.code,
          `the \`reply-to\` header of the raw message could not be authorized: ${parsed.reason}`,
          { header: 'reply-to' });
      }
      const a = sorted(parsed.addresses);
      const b = sorted(envReply);
      if (a.join(',') !== b.join(',')) {
        return problem('reply_to_mismatch',
          `the raw message replies to ${a.join(', ')} but the envelope declares ${b.join(', ')}. `
          + 'Where an answer lands is part of what a human approved',
          { messageReplyTo: a, envelopeReplyTo: b });
      }
    }
  }

  return {
    ok: true,
    recipients: sorted(messageRecipients),
    envelopeRecipients: sorted(envelopeRecipients),
    sender,
    encoding: decoded.encoding,
  };
}

module.exports = {
  authorizeRawMessage,
  decodeRaw, parseHeadersStrict, splitAddressList, addressOf, addressesIn, envelopeAddresses,
  SINGLETON_HEADERS, RECIPIENT_HEADERS, HEADER_SCAN_BYTES,
};
