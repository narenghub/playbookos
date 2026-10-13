// ── DID THAT MESSAGE ACTUALLY ARRIVE? ─────────────────────────────────────────
//
// Naren asked how many of the CPHI follow-ups were delivered and how many were not. The honest
// answer has to start with what is NOT knowable: Gmail has no delivery receipt. There is no API
// call that says "their server accepted this". SMTP confirms a handoff, not a delivery, and a
// recipient's server is free to accept a message and then file it in a junk folder or discard it
// silently. Anyone who tells you a 100% "delivered" figure for ordinary email is reporting
// "accepted for relay" and calling it something stronger.
//
// So this module works from the two things that ARE facts:
//
//   1. A BOUNCE. When delivery fails, the receiving or relaying server sends back a Delivery
//      Status Notification (RFC 3464). That is a real message in the mailbox, with the failed
//      recipient and a diagnostic code in it. A bounce is proof of failure.
//   2. WHETHER THE DOMAIN CAN RECEIVE MAIL AT ALL. A domain with no MX record cannot accept mail,
//      so an address there was never going to work. For addresses transcribed by hand from
//      business cards this is the single most useful check, because the likeliest error is a typo
//      in the domain — and it can be known WITHOUT sending anything.
//
// Everything else is "sent, no failure reported", which is the strongest claim the protocol
// supports. This module says that in those words rather than "delivered", because the difference
// matters when you are deciding whether to chase somebody.
//
// ── WHY STATUS CODES AND NOT JUST "IT BOUNCED" ───────────────────────────────
//
// A 5.x.x status is permanent — bad address, domain doesn't exist, mailbox full and giving up,
// blocked as spam. That address needs correcting or abandoning. A 4.x.x is temporary: the server
// was busy or greylisting, and Gmail will keep retrying for days. Treating a 4.x.x as a failed
// address would mean re-typing an address that is perfectly fine. They are reported separately.
'use strict';

const dns = require('dns').promises;

/** Flatten a Gmail payload into every part, so nested multiparts are not missed. */
function allParts(payload, out = []) {
  if (!payload) return out;
  out.push(payload);
  for (const p of payload.parts || []) allParts(p, out);
  return out;
}

const decode = (b64) => {
  if (!b64) return '';
  try { return Buffer.from(String(b64).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch (_) { return ''; }
};

/** Every text-ish body in the message, concatenated — where DSN fields live. */
function bodyText(payload) {
  return allParts(payload)
    .filter((p) => !p.parts)
    .map((p) => decode(p.body && p.body.data))
    .filter(Boolean)
    .join('\n');
}

function headerOf(payload, name) {
  const hs = (payload && payload.headers) || [];
  const h = hs.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Read one message as a possible bounce.
 * Returns { isBounce, recipients: [], status, permanent, diagnostic, subject, date } .
 *
 * The parse is deliberately layered: the machine-readable DSN fields first (Final-Recipient,
 * Status, Diagnostic-Code — these are a standard and mean exactly one thing), then the headers
 * Gmail and Exchange add, and only then a text scrape. Each layer is less trustworthy than the
 * one before, so the order is the point.
 */
function readBounce(msg) {
  const payload = (msg && msg.payload) || {};
  const subject = headerOf(payload, 'Subject');
  const from = headerOf(payload, 'From');
  const date = headerOf(payload, 'Date');
  const text = bodyText(payload);

  const fromDaemon = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(from);
  const dsnSubject = /^\s*(undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|delivery (has )?failed)/i
    .test(subject);
  const hasDsnPart = allParts(payload).some((p) => /message\/(delivery-status|feedback-report)/i.test(p.mimeType || ''));
  const failedHeader = headerOf(payload, 'X-Failed-Recipients');

  const isBounce = !!(fromDaemon || dsnSubject || hasDsnPart || failedHeader);
  if (!isBounce) return { isBounce: false };

  // Layer 1 — the standard fields.
  const finals = [...text.matchAll(/^Final-Recipient:\s*[^;]*;\s*(.+)$/gim)].map((m) => m[1].trim());
  const originals = [...text.matchAll(/^Original-Recipient:\s*[^;]*;\s*(.+)$/gim)].map((m) => m[1].trim());
  const statusM = text.match(/^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im);
  const diagM = text.match(/^Diagnostic-Code:\s*(.+)$/im);
  const actionM = text.match(/^Action:\s*(\w+)/im);

  // Layer 2 — the header some servers set instead.
  const headerRecipients = failedHeader ? failedHeader.split(/[,;]\s*/).filter(Boolean) : [];

  // Layer 3 — a scrape, used only when the layers above found no recipient at all. Our own
  // address is excluded: a bounce is addressed TO us, so we are always in the text.
  let recipients = [...new Set([...finals, ...originals, ...headerRecipients]
    .map((r) => (String(r).match(EMAIL_RE) || [])[0]).filter(Boolean))];
  if (!recipients.length) recipients = [...new Set(text.match(EMAIL_RE) || [])];

  const status = statusM ? statusM[1] : null;
  // Permanent when the status says 5, or the server said so in words. Absent a status code, a
  // bounce is NOT assumed permanent: calling a temporary failure permanent means retyping an
  // address that was always correct.
  const permanent = status ? status.startsWith('5')
    : /\b(5\d\d)\b|permanent (error|failure)|does not exist|no such user|user unknown|address (not found|rejected)/i.test(text);

  return {
    isBounce: true,
    recipients,
    status,
    permanent,
    action: actionM ? actionM[1].toLowerCase() : null,
    diagnostic: diagM ? diagM[1].trim().slice(0, 300) : null,
    subject, from, date,
  };
}

/** The Gmail search that finds bounces. Narrow enough to be cheap, broad enough to catch Exchange. */
function bounceQuery(days = 14) {
  return `newer_than:${Math.max(1, Math.floor(days))}d `
    + '(from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification"'
    + ' OR subject:Undeliverable OR subject:"Mail delivery failed" OR subject:"Returned mail")';
}

/**
 * Can this domain receive mail at all? Returns { ok, reason, mx }.
 *
 * `ok: null` means the lookup itself failed (no DNS from this host) — which must not be read as a
 * bad domain. An unknown is not a failure, and reporting it as one would send somebody re-typing
 * perfectly good addresses off a stack of business cards.
 */
async function domainAcceptsMail(email, deps = {}) {
  const resolveMx = deps.resolveMx || ((d) => dns.resolveMx(d));
  const at = String(email || '').lastIndexOf('@');
  if (at < 1) return { ok: false, reason: 'not an email address' };
  const domain = String(email).slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes('.')) return { ok: false, reason: 'domain has no dot' };
  try {
    const mx = await resolveMx(domain);
    if (!mx || !mx.length) return { ok: false, reason: 'no MX record — the domain cannot receive mail', mx: [] };
    return { ok: true, mx: mx.map((m) => m.exchange).slice(0, 3) };
  } catch (e) {
    const code = (e && e.code) || '';
    // NXDOMAIN is a real answer: the domain does not exist. Everything else is a failed lookup.
    if (code === 'ENOTFOUND' || code === 'NXDOMAIN') {
      return { ok: false, reason: 'the domain does not exist', mx: [] };
    }
    if (code === 'ENODATA') return { ok: false, reason: 'no MX record — the domain cannot receive mail', mx: [] };
    return { ok: null, reason: `MX lookup failed (${code || (e && e.message)})` };
  }
}


// ── WHY IT BOUNCED DECIDES WHAT TO DO ABOUT IT ───────────────────────────────
//
// The first version of the audit printed "Re-check this address against the business card" under
// every failure. On the real CPHI run that was wrong for four of nine: Olon answered
//
//     554 5.7.1 Service unavailable; Sender address [naren@abiozen.com] blocked
//
// and Cipla, Zydus and Moehs all answered "5.4.1 Recipient address rejected: Access denied" from
// Microsoft 365 tenants. None of those is a bad address. Re-typing a correct address off a card and
// sending to it again from the same blocked domain wastes the contact a second time and makes the
// reputation problem worse.
//
// These are different problems with different owners: a wrong address is a data-entry fix, a dead
// domain is a data fix, and a blocked sender is a deliverability problem that no amount of
// card-reading will solve.
const NO_DOMAIN_RE = /NXDOMAIN|DNS type .?mx.? lookup|domain (name )?(not found|does not exist)|host or domain name not found/i;
// [\s\S] rather than [^.]: the blocked address itself contains dots, so excluding them meant
// "Sender address [naren@abiozen.com] blocked" — the clearest case there is — fell through to
// the ambiguous branch.
const SENDER_BLOCKED_RE = /sender address[\s\S]{0,80}?blocked|sender (was |is )?(blocked|denied|rejected|not allowed)|blocked using|rejected due to (spam|policy|reputation)|spam ?(block|filter)/i;
const BAD_MAILBOX_RE = /user (unknown|not found)|recipient (is )?not exist|no such (user|recipient|mailbox)|verify address failed|mailbox (unavailable|not found)|does not exist/i;
const FULL_RE = /mailbox (is )?full|over ?quota|insufficient storage/i;
// EXOSmtpErrors is Microsoft's own help link and is the reliable tell that this came from
// Exchange Online rather than from a server that means what it says.
const EXCHANGE_DBEB_RE = /EXOSmtpErrors|aka\.ms\/EXO|\.outlook\.com\b[\s\S]{0,120}access denied|access denied[\s\S]{0,120}\.outlook\.com\b/i;
const POLICY_RE = /access denied|policy|not authori[sz]ed|relay (denied|access denied)/i;

function classifyBounce(b) {
  const t = `${(b && b.diagnostic) || ''} ${(b && b.subject) || ''}`;
  const status = (b && b.status) || '';

  if (NO_DOMAIN_RE.test(t) || status === '5.1.2') {
    return { kind: 'no_such_domain',
      advice: 'The DOMAIN does not exist, so the address cannot be right. Re-read the card and '
        + "check the company's real mail domain." };
  }
  // Before the generic policy case: an explicit mention of the SENDER is unambiguous.
  if (SENDER_BLOCKED_RE.test(t)) {
    return { kind: 'sender_blocked',
      advice: 'The address is probably FINE — their server refused OUR domain. Re-typing it will '
        + 'not help. This is deliverability: authentication and sender reputation.' };
  }
  if (BAD_MAILBOX_RE.test(t) || status === '5.1.1') {
    return { kind: 'bad_mailbox',
      advice: 'Their server says this mailbox does not exist. Re-read the card.' };
  }
  if (FULL_RE.test(t)) {
    return { kind: 'mailbox_full',
      advice: 'Their mailbox is full. The address is fine and it may clear on its own.' };
  }
  // Exchange Online's "5.4.1 Recipient address rejected: Access denied" reads like a sender block
  // and usually is not one. It is most often Directory-Based Edge Blocking: the address does not
  // exist in that tenant's directory, and Microsoft returns a deliberately vague "Access denied"
  // instead of "user unknown" so that nobody can discover valid addresses by probing.
  //
  // I had this backwards on 13 Oct. Four CPHI bounces came back this way from Cipla, Zydus, Moehs
  // and Macleods, and I read them as abiozen.com being refused on reputation — then
  // check-email-auth.js showed SPF correct, DKIM published and DMARC aligned, which removes that
  // explanation. The likelier reading is four wrong addresses, which is a cards problem after all.
  if (EXCHANGE_DBEB_RE.test(t) || (status === '5.4.1' && /access denied/i.test(t))) {
    return { kind: 'likely_bad_address',
      advice: 'Exchange Online "Access denied" is USUALLY a non-existent address, obscured on '
        + 'purpose so valid addresses cannot be probed. Re-read the card. It can also be a tenant '
        + 'block, so if the card is right, ask your contact to whitelist the domain.' };
  }
  // A genuine policy refusal that is not the Exchange pattern.
  if (POLICY_RE.test(t) || status.startsWith('5.7')) {
    return { kind: 'policy_reject',
      advice: 'A policy refusal. Check the card first; if several arrive together from different '
        + 'companies, look at sender authentication and reputation instead.' };
  }
  return { kind: 'unknown', advice: 'No clear reason given. Read the diagnostic above.' };
}

module.exports = { readBounce, classifyBounce, bounceQuery, domainAcceptsMail, bodyText, allParts, headerOf };
