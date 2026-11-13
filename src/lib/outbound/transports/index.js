// ── THE TRANSPORT REGISTRY, POPULATED ────────────────────────────────────────
//
// dispatch() resolves a transport BY NAME and refuses a name it does not know. This is where the
// names come from. One file, so "what can this system send through?" is answered by reading it
// rather than by searching for registration calls.
//
// Each name is a (sender, purpose) pair rather than just a provider, because the ledger, the kill
// switch and the containment reports are all keyed on transport: `gmail_cphi` being quiet while
// `gmail_outreach` is busy is a fact worth being able to state, and one provider name could not
// state it.
//
// Registered lazily, on first dispatch, so requiring dispatch.js does not pull googleapis into
// every process that merely imports it — and so a test can register its own fakes first.

'use strict';

const { registerTransport, knownTransports } = require('../dispatch');

let done = false;

/** Register every known transport. Idempotent. */
function registerDefaults() {
  if (done) return knownTransports();
  const gmail = require('./gmail');

  // The two legacy external senders, migrated onto the chokepoint (Spec A milestone 5, item 2).
  registerTransport('gmail_cphi', gmail.transport);
  registerTransport('gmail_outreach', gmail.transport);

  done = true;
  return knownTransports();
}

/** Forget the registrations — for tests only. */
function _reset() { done = false; }

module.exports = { registerDefaults, _reset };
