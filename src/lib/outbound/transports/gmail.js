// ── THE GMAIL SENDER SERVICE ──────────────────────────────────────────────────
//
//   const gmail = require('./outbound/transports/gmail');
//   registerTransport('gmail_cphi', gmail.transport);
//
// Spec A milestone 5, item 3: credential isolation. **This is the only module permitted to hold a
// send-capable Gmail credential.**
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
//
// Before this existed, outreach-agent.js and cphi-runner.js each called gmailClientFor(FROM) and
// got back a client on `send+readonly` or `modify+readonly` — a token that can send. They then
// called g.gmail.users.messages.send(...) directly. Two consequences:
//
//   1. Any code path in those files, present or future, could send. "The script only sends inside
//      the governed block" was a property of that day's source, re-established by reading it.
//   2. There was no chokepoint. The kill switch was checked by each sender, in each sender's own
//      way, and a sender that forgot was simply ungoverned — which is what happened.
//
// Now the agents hold a READ-ONLY token and cannot send at all. Not "do not" — CANNOT. That is the
// distinction gmail/client.js already draws in its own words: "the script never calls send is a
// property of today's code, while a token that cannot send is a property of the grant."
//
// ── WHY THE WRITES LIVE HERE TOO ─────────────────────────────────────────────
//
// Labelling a thread is `threads.modify`, a write, and a read-only token cannot do it. So filing
// moves here with sending rather than forcing the agents back onto a write-capable token — which
// would hand them sending again through the side door, since gmail.modify permits messages.send.
//
// Reading (messages.list, messages.get) stays with the agents on their read-only token. Reading is
// not an outbound action and routing it through here would buy nothing.
//
// ── THIS MODULE MAKES NO AUTHORIZATION DECISION ──────────────────────────────
//
// By the time send() is called, dispatch() has established every invariant: approval, digest,
// STOPs, idempotency, ledger. A transport that could also decide authorization would be a second
// place for that logic to be wrong, and the whole point of the chokepoint is that there is one.
//
// It is deliberately dumb for a second reason: when this becomes a separate process holding the
// only copy of the credential, nothing here has to change but the body of send().

'use strict';

const { gmailClientFor, READONLY_ONLY } = require('../../gmail/client');
const { labelThread, ensureNeedLabels, ensureCampaignLabels } = require('../../gmail/labels');

// The two label sets the two senders use. Named here so a caller picks one by NAME and cannot pass
// in an arbitrary function to be run with a write-capable client.
const LABEL_SETS = Object.freeze({ needs: ensureNeedLabels, campaigns: ensureCampaignLabels });

// Send-capable clients, per mailbox. A run of fifty sends re-uses one client rather than minting
// fifty tokens. Process-local and never persisted.
const senders = new Map();

/** Reset for tests. Production never calls this. */
function _resetSenders() { senders.clear(); }

/**
 * A send-capable client for `mailbox`. PRIVATE — not exported, so no caller outside this file can
 * obtain one. That inaccessibility is the isolation; everything else is convention.
 */
async function sendCapableClient(mailbox, deps = {}) {
  const make = deps.gmailClientFor || gmailClientFor;
  if (deps.gmail) return { gmail: deps.gmail, scopeSet: 'injected' };
  if (senders.has(mailbox)) return senders.get(mailbox);
  const g = await make(mailbox);          // default scope sets: send+readonly, then modify+readonly
  if (g.error) return g;
  senders.set(mailbox, g);
  return g;
}

/**
 * A READ-ONLY Gmail client, for an agent that reads its inbox and must not be able to send.
 *
 * This is what the agents call instead of gmailClientFor. It forces READONLY_ONLY, so the token
 * handed back lacks gmail.send AND gmail.modify — the grant refuses the write, not this code.
 */
async function readOnlyClientFor(mailbox, deps = {}) {
  const make = deps.gmailClientFor || gmailClientFor;
  return make(mailbox, { ...deps, scopeSets: READONLY_ONLY });
}

/**
 * The transport dispatch() calls. Takes a message carrying a prepared RFC822 payload.
 *
 * @param {object} message        { mailbox, raw, threadId?, to, subject, html }
 * @returns {Promise<object>}     { ok, id, error, providerResponded, meta: { threadId, messageId } }
 *
 * `providerResponded` matters more than `ok`: it is what tells the ledger apart "Gmail refused
 * this" from "nobody knows whether Gmail got it". A throw propagates, because dispatch records a
 * throw as OUTCOME_UNKNOWN and never as a clean failure.
 */
async function send(message, deps = {}) {
  const { mailbox, raw, threadId } = message || {};
  if (!mailbox) return { ok: false, error: 'the gmail transport requires a mailbox to send as', providerResponded: false };
  if (!raw) return { ok: false, error: 'the gmail transport requires a prepared raw message', providerResponded: false };

  const g = await sendCapableClient(mailbox, deps);
  if (g.error) {
    // No credential, no send, and NOT an unknown outcome: nothing was transmitted because nothing
    // could be. dispatch turns this into PROVIDER_REJECTED, which is the truth.
    return { ok: false, error: `no send-capable Gmail credential for ${mailbox}: ${g.error}`,
      providerResponded: false };
  }

  const res = await g.gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, ...(threadId ? { threadId } : {}) },
  });

  const data = (res && res.data) || {};
  return {
    ok: true,
    id: data.id || data.threadId || null,
    error: null,
    providerResponded: true,
    meta: { threadId: data.threadId || null, messageId: data.id || null, scopeSet: g.scopeSet },
  };
}

/**
 * File a thread under a label. A WRITE, which is why it is here and not in the agent.
 *
 * Reported, never thrown: by the time this runs the message has left, and Gmail cannot unsend it.
 * A filing failure treated as a send failure would turn "it went and is sitting unfiled" into "it
 * may or may not have gone", which is strictly worse information.
 */
async function fileThread({ mailbox, threadId, folder }, deps = {}) {
  if (!folder) return { ok: false, error: 'no folder given' };
  const g = await sendCapableClient(mailbox, deps);
  if (g.error) return { ok: false, error: `no write-capable Gmail credential for ${mailbox}: ${g.error}` };
  try {
    return await labelThread(g.gmail, mailbox, threadId, folder);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Create a sender's labels if they are missing. A write, for the same reason as fileThread.
 *
 * `set` names one of LABEL_SETS. A NAME rather than a function, so no caller can hand this module
 * arbitrary code to execute holding a write-capable client.
 */
async function ensureLabels({ mailbox, set = 'needs' }, deps = {}) {
  const build = LABEL_SETS[set];
  if (!build) {
    return { error: `unknown label set ${JSON.stringify(set)}; known: ${Object.keys(LABEL_SETS).join(', ')}` };
  }
  const g = await sendCapableClient(mailbox, deps);
  if (g.error) return { error: `no write-capable Gmail credential for ${mailbox}: ${g.error}` };
  return build(g.gmail, mailbox);
}

module.exports = {
  transport: { send },
  send,
  fileThread,
  ensureLabels,
  readOnlyClientFor,
  _resetSenders,
};
