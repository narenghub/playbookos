// ── THE UNIX-SOCKET EXCEPTION, AND ITS BOUNDARY ──────────────────────────────
//
// sslConfig() returns an SSL object whenever DATABASE_URL is set. That is the deployed behaviour and
// ruling 49 item 2 says to preserve it. The one exception added for the restore drill is a
// unix-domain socket, which has no network hop to protect.
//
// The whole safety of that exception is its boundary: if it ever widened to a TCP host, the
// application would silently stop using TLS against Railway and look exactly the same from outside.
// So the TCP cases are asserted here one by one, including the one that matters most —
// production's own URL shape, which carries `sslmode=disable` and must STILL get TLS, because
// today's explicit ssl option overrides that parameter and turning it off would be a silent
// downgrade dressed as a tidy-up.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const DB = require('./db');

test('1. a unix-socket URL gets no TLS — there is no network hop to protect', () => {
  for (const url of [
    'postgresql://postgres@localhost/postgres?host=/var/tmp/drill-abc&port=55971',
    'postgresql://postgres@localhost/restored?port=5432&host=/tmp/pg',
    'postgres://postgres@localhost/x?host=%2Fvar%2Ftmp%2Fsock',
    'postgresql://postgres@%2Fvar%2Frun%2Fpostgresql/postgres',
  ]) {
    assert.strictEqual(DB.isUnixSocketUrl(url), true, `not recognised as a socket: ${url}`);
  }
});

test('2. EVERY TCP URL still gets TLS, including production\'s own shape', () => {
  const tcp = [
    // Production, as the handoff records it. `sslmode=disable` is present and is deliberately NOT
    // honoured: the explicit ssl option overrides it, so the deployed app uses TLS today. If this
    // assertion ever fails, production's transport has been turned off.
    'postgresql://postgres:x@postgres.railway.internal:5432/railway?sslmode=disable',
    'postgresql://postgres@127.0.0.1:55491/postgres',
    'postgresql://postgres@interchange.proxy.rlwy.net:18553/railway',
    'postgresql://u:p@db.example.com:5432/d?sslmode=require',
    // A hostname that merely CONTAINS a slash-like encoding later in the string must not qualify.
    'postgresql://postgres@127.0.0.1:5432/postgres?application_name=%2Ffoo',
    // A `host=` parameter naming a HOSTNAME, not a path.
    'postgresql://postgres@localhost:5432/postgres?host=db.internal',
  ];
  for (const url of tcp) {
    assert.strictEqual(DB.isUnixSocketUrl(url), false, `WRONGLY treated as a socket: ${url}`);
  }
});

test('3. sslConfig honours the boundary, and the no-URL case is unchanged', () => {
  const saved = process.env.DATABASE_URL;
  const savedPem = process.env.DATABASE_CA_CERT;
  const savedFile = process.env.DATABASE_CA_CERT_FILE;
  const savedFp = process.env.DATABASE_SSL_FINGERPRINT;
  delete process.env.DATABASE_CA_CERT;
  delete process.env.DATABASE_CA_CERT_FILE;
  delete process.env.DATABASE_SSL_FINGERPRINT;
  try {
    delete process.env.DATABASE_URL;
    assert.strictEqual(DB.sslConfig(), false, 'no DATABASE_URL must still be false');

    process.env.DATABASE_URL = 'postgresql://postgres@localhost/postgres?host=/var/tmp/s&port=1';
    assert.strictEqual(DB.sslConfig(), false, 'a unix socket must not attempt TLS');

    // The deployed default, byte for byte.
    process.env.DATABASE_URL = 'postgresql://postgres:x@postgres.railway.internal:5432/railway?sslmode=disable';
    assert.deepStrictEqual(DB.sslConfig(), { rejectUnauthorized: false },
      'the deployed TCP default changed — this is a transport change, not a refactor');
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
    if (savedPem !== undefined) process.env.DATABASE_CA_CERT = savedPem;
    if (savedFile !== undefined) process.env.DATABASE_CA_CERT_FILE = savedFile;
    if (savedFp !== undefined) process.env.DATABASE_SSL_FINGERPRINT = savedFp;
  }
});
