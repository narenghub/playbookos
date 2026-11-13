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

  // THE SERVICE CLIENT, not the in-process Gmail transport (milestone 6, item 1). This module is
  // loaded by the application; requiring transports/gmail here would pull the send-capable
  // credential back into the application process and undo the separation.
  //
  // The client holds no credential. It signs a request with SENDER_SERVICE_SECRET — which
  // authenticates a conversation, not an action — and the sender service re-checks the STOPs, the
  // approval, the digest and the idempotency for itself before anything leaves.
  const client = require('./sender-client');

  // The two legacy external senders, migrated onto the chokepoint (milestone 5, item 2).
  registerTransport('gmail_cphi', client.transportFor('gmail_cphi'));
  registerTransport('gmail_outreach', client.transportFor('gmail_outreach'));

  // The deliverability probe (milestone 6, item 4). An operator-run script, not an agent, but a
  // real message leaves the building — so it goes through the same boundary, the same service and
  // the same coverage report. Its recipient is a non-existent mailbox on our own domain.
  registerTransport('gmail_probe', client.transportFor('gmail_probe'));

  done = true;
  return knownTransports();
}

/** Forget the registrations — for tests only. */
function _reset() { done = false; }

module.exports = { registerDefaults, _reset };
