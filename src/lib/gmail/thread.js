// ── HAS THIS PERSON REPLIED? ──────────────────────────────────────────────────
//
// Stop-on-reply is the single most important behaviour in the follow-up agent. Everything else
// going wrong produces a slightly worse email; this going wrong produces a follow-up chasing
// somebody who already answered — to a person who shook Naren's hand four days earlier. There is
// no recovering from that with a better subject line.
//
// ── AN OUT-OF-OFFICE IS NOT A REPLY ──────────────────────────────────────────
//
// And the mirror failure is just as real and much quieter: treating an auto-responder as a reply
// silently kills the sequence. Somebody on leave until the 20th sends back "Automatic reply: I am
// out of the office", the agent marks them replied, and they are never followed up — which looks
// from the outside exactly like a sequence working correctly. Nobody finds out.
//
// So auto-replies are detected and EXCLUDED from "replied", but recorded, because a bounce or a
// vacation notice is information: it means the message arrived and the person is not reading it
// yet, which is a reason to wait rather than a reason to stop.
//
// Detection uses the headers that auto-responders are required to set, plus a narrow subject
// pattern. Deliberately NOT a loose "does the subject look automatic" test: a genuine reply from a
// supplier beginning "Automatic quotes attached" must not be swallowed, and the cost of missing an
// auto-reply (one extra follow-up to somebody on holiday) is far smaller than the cost of
// misreading a real one (silence towards somebody who answered).
'use strict';

/** Headers an auto-responder sets. RFC 3834 mandates the first; the rest are what clients do. */
const AUTO_HEADERS = [
  ['auto-submitted', /auto-(replied|generated|notified)/i],
  ['x-autoreply', /./],
  ['x-autorespond', /./],
  ['x-auto-response-suppress', /./],
  ['precedence', /^(auto_reply|bulk|junk)$/i],
  ['x-failed-recipients', /./],          // a bounce
];

// Anchored at the start, because that is where an auto-responder puts it. "Automatic reply: ..."
// is an auto-reply; "Re: your note — automatic reply not needed" is a person.
const AUTO_SUBJECT = /^\s*(automatic reply|out of office|auto(matic)?[- ]?response|undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail)\b/i;

const headerMap = (payload) => {
  const out = {};
  for (const h of (payload && payload.headers) || []) {
    out[String(h.name || '').toLowerCase()] = String(h.value == null ? '' : h.value);
  }
  return out;
};

/** The bare address out of `Name <a@b.com>`. */
function addressOf(value) {
  const s = String(value == null ? '' : value);
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** Is this message an auto-responder or a bounce rather than a person? */
function isAutomated(headers, labelIds = []) {
  for (const [name, re] of AUTO_HEADERS) {
    if (headers[name] && re.test(headers[name])) return true;
  }
  if (AUTO_SUBJECT.test(headers.subject || '')) return true;
  // Gmail's own classification, when it offers one.
  if ((labelIds || []).includes('CATEGORY_UPDATES') && AUTO_SUBJECT.test(headers.subject || '')) return true;
  return false;
}

/**
 * Read a thread and decide whether the recipient has actually replied.
 *
 * Returns:
 *   { replied, repliedAt, autoReplies, fromThem, fromUs, error }
 *
 * `replied` is TRUE only for a message from somebody other than the sending mailbox that is not an
 * auto-responder. On any error it is NULL — never false. "I could not tell" must not read as
 * "nobody replied, send the next one"; the caller skips rather than sends, which costs a day and
 * risks nothing.
 */
async function replyState(gmail, threadId, selfEmail, deps = {}) {
  if (!threadId) return { replied: null, error: 'no threadId' };
  const self = String(selfEmail || '').toLowerCase();
  if (!self) return { replied: null, error: 'no sending mailbox given' };

  let thread;
  try {
    const res = await gmail.users.threads.get({
      userId: 'me', id: threadId, format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date', 'Auto-Submitted', 'X-Autoreply',
                        'X-Autorespond', 'X-Auto-Response-Suppress', 'Precedence',
                        'X-Failed-Recipients', 'Message-ID'],
    });
    thread = res.data;
  } catch (e) {
    // FAIL CLOSED. A lookup that throws is not permission to send the next step.
    return { replied: null, error: (e && e.message) || String(e) };
  }

  const messages = (thread && thread.messages) || [];
  const fromUs = [];
  const fromThem = [];
  const autoReplies = [];

  for (const m of messages) {
    const h = headerMap(m.payload);
    const from = addressOf(h.from);
    const when = h.date || null;
    if (from === self) { fromUs.push({ from, when, subject: h.subject }); continue; }
    if (isAutomated(h, m.labelIds)) {
      autoReplies.push({ from, when, subject: h.subject });
      continue;
    }
    fromThem.push({ from, when, subject: h.subject, messageId: h['message-id'] || null });
  }

  return {
    replied: fromThem.length > 0,
    repliedAt: fromThem.length ? fromThem[0].when : null,
    fromThem, fromUs, autoReplies,
    messageCount: messages.length,
  };
}

module.exports = { replyState, isAutomated, addressOf, AUTO_SUBJECT };
