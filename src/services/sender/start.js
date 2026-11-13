#!/usr/bin/env node
// ── START THE SENDER SERVICE ─────────────────────────────────────────────────
//
//   SENDER_SERVICE_SECRET=... node src/services/sender/start.js
//
// A separate process from the application, holding the only send-capable email credential.
// Spec A milestone 6, item 1.
//
// It refuses to start without SENDER_SERVICE_SECRET. A service that starts unauthenticated and
// then refuses every request at least SAYS so per request — but it also sits there looking healthy,
// and "the sender is up" would be true and useless. Better not to exist.
'use strict';

const { createServer } = require('./server');

const PORT = Number(process.env.SENDER_SERVICE_PORT || 8081);
const HOST = process.env.SENDER_SERVICE_HOST || '127.0.0.1';

if (!process.env.SENDER_SERVICE_SECRET) {
  console.error('[sender] SENDER_SERVICE_SECRET is not set. Refusing to start: an unauthenticated');
  console.error('         sender that reports itself healthy is worse than one that is absent.');
  process.exit(1);
}

// Loopback by default. This service must not be reachable from outside the deployment, and a
// default of 0.0.0.0 would make "we forgot to firewall it" the quiet case.
createServer().listen(PORT, HOST, () => {
  console.log(`[sender] listening on ${HOST}:${PORT} — holds the send credential, re-checks every invariant`);
});
