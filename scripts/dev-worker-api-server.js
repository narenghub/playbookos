#!/usr/bin/env node
// ── THE M7 DEVELOPMENT WORKER API — NOT server.js ───────────────────────────
//
//   M7_DEV_API=yes DATABASE_URL=<dev> WORKER_API_ENABLED=true \
//   WORKER_SECRET_SEAL_KEY=<64 hex> node scripts/dev-worker-api-server.js
//
// This exists so the Mac mini has something to talk to that is NOT the PlaybookOS server.
//
// ── WHY NOT JUST RUN server.js WITH A FLAG ──────────────────────────────────
//
// server.js registers 42 cron jobs at module load, unconditionally. Among them: performance
// scoring, which emails coaching; the command-center briefing, which emails Naresh; the GitHub
// sync, which calls GitHub; and the product shadow read, which connects to the Abiozen Django
// PRODUCTION database through ABIOZEN_DATABASE_URL. A development deploy of server.js would
// register every one of them, and the only thing standing between those crons and a real send
// would be the ABSENCE of provider credentials plus 42 stop rows — that is, configuration.
//
// So this file does not import server.js. No cron is registered because the module that registers
// them is never loaded, and no provider client is constructed because nothing here requires one.
// "No consequential provider integrations" becomes a property of what this process CONTAINS rather
// than of what it has been told not to do. The 42 stop rows (scripts/m7-dev-seed-containment.js)
// remain as a second layer, for the case where somebody runs the real server against the dev
// database anyway.
//
// It serves exactly two things: /health, and /api/worker/*. There is no UI, no auth router, no
// agent, no mailer, no LLM client, no Algolia, no Apollo, no Twilio.
//
// EXIT 2 refused to start

'use strict';

const express = require('express');

// ── REFUSALS, BEFORE A SOCKET IS OPENED ─────────────────────────────────────

const FORBIDDEN_DB_HOSTS = [
  'postgres.railway.internal',
  'interchange.proxy.rlwy.net',
];

function refuse(msg, extra) {
  process.stderr.write(`REFUSED: ${msg}\n`);
  if (extra) process.stderr.write(`${extra}\n`);
  process.exit(2);
}

if (process.env.M7_DEV_API !== 'yes') {
  refuse('set M7_DEV_API=yes to confirm this is the development worker API.',
    'This is a deliberate second pair of eyes. This process exposes the worker API and nothing else;\n'
    + 'it is not the PlaybookOS server and must never be deployed as one.');
}
if (process.env.NODE_ENV === 'production') {
  refuse('NODE_ENV=production. This entry point is development-only.');
}
if (!process.env.DATABASE_URL) refuse('DATABASE_URL is not set.');

let dbHost = '';
try { dbHost = new URL(process.env.DATABASE_URL).hostname; } catch (_) {
  refuse('DATABASE_URL is not a URL this process can inspect, so it cannot be cleared as non-production.');
}
for (const h of FORBIDDEN_DB_HOSTS) {
  if (dbHost === h || dbHost.endsWith(`.${h}`)) {
    refuse(`${dbHost} is a production database host.`,
      'The M7 worker API will not be pointed at production data.');
  }
}

// Provider credentials are not merely unused here — their PRESENCE means somebody has pointed a
// production environment at this file, and that is worth stopping for rather than ignoring.
const PROVIDER_VARS = [
  'RESEND_API_KEY', 'TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID', 'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY', 'APOLLO_API_KEY', 'LINKEDIN_ACCESS_TOKEN', 'ALGOLIA_API_KEY',
  'GOOGLE_REFRESH_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'ABIOZEN_DATABASE_URL',
];
const present = PROVIDER_VARS.filter((v) => process.env[v]);
if (present.length) {
  refuse(`${present.length} provider credential(s) are set in this environment: ${present.join(', ')}`,
    'This process needs none of them and must not run anywhere they exist. Requirement 6 of the M7\n'
    + 'development environment is no consequential provider integrations; a credential that is\n'
    + 'present is one that can be used by a later edit. Remove them from this service.');
}

const WR = require('../src/api/worker.routes');
if (!WR.isMountEnabled(process.env)) {
  refuse(`WORKER_API_ENABLED must be exactly 'true' (it is ${JSON.stringify(process.env.WORKER_API_ENABLED)}).`,
    'The worker API is opt-in by design. This is requirement 3: explicit development-only activation.');
}
if (!/^[0-9a-f]{64}$/i.test(String(process.env.WORKER_SECRET_SEAL_KEY || ''))) {
  refuse('WORKER_SECRET_SEAL_KEY must be 64 hex characters (32 bytes).',
    'Generate one with:  openssl rand -hex 32\nIt is a DEVELOPMENT key. Do not reuse it anywhere else, and do not paste it into a chat.');
}

// ── THE PROCESS ─────────────────────────────────────────────────────────────

const { Pool } = require('pg');

// A small pool: one Mac mini, one task at a time. A dev database does not need 20 connections, and
// a small pool makes a connection leak visible instead of absorbing it.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const query = (sql, params) => pool.query(sql, params);
const withTransaction = async (fn) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { c.release(); }
};

const app = express();
app.disable('x-powered-by');

// Matches server.js, because worker.routes.js verifies signatures over the RAW body and a body
// re-serialised by express would hash differently.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// Reports the commit so wait-for-deploy.sh works against this service too, and names itself a dev
// API so nothing mistakes it for production in a screenshot or a log.
app.get('/health', async (req, res) => {
  let db = 'unknown';
  try { await query('SELECT 1'); db = 'connected'; } catch (e) { db = 'error'; }
  res.json({
    status: db === 'connected' ? 'ok' : 'degraded',
    service: 'm7-dev-worker-api',
    production: false,
    db,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    worker_api: 'enabled',
  });
});

app.use('/api', WR.createWorkerRouter({
  enable: true, query, withTransaction, env: process.env,
}));

// Anything else does not exist here. Said explicitly so a request to /api/auth/login against this
// host returns a clear 404 rather than looking like a broken production server.
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    code: 'not_this_service',
    detail: 'This is the M7 development worker API. It serves /health and /api/worker/* only.',
  });
});

const port = Number(process.env.PORT) || 3100;
const server = app.listen(port, () => {
  console.log(`[m7-dev-worker-api] listening on ${port}`);
  console.log(`[m7-dev-worker-api] database host: ${dbHost}`);
  console.log('[m7-dev-worker-api] crons registered: 0 (server.js is not loaded by this process)');
  console.log('[m7-dev-worker-api] provider clients constructed: 0');
  console.log('[m7-dev-worker-api] routes: GET /health, POST /api/worker/{enroll,claim,heartbeat,result}, GET /api/worker/lease/:runId');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[m7-dev-worker-api] ${sig} — closing`);
    server.close(() => pool.end().then(() => process.exit(0), () => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

module.exports = { app };
