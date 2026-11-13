#!/usr/bin/env node
// ── CAN THE SENDER SERVICE BE DEPLOYED ON ITS OWN? ───────────────────────────
//
//   node scripts/check-sender-deployability.js
//
// CEO readiness item 3. It boots the REAL entry point as a separate process, the way Railway will,
// and asks the questions a deployment has to answer before it is attempted:
//
//   · does it start at all from this repo, with only its own environment?
//   · does it refuse to start misconfigured, rather than coming up unauthenticated?
//   · is it PRIVATE by default — loopback, not 0.0.0.0?
//   · is the public bind an explicit act, so "we forgot to firewall it" cannot be the quiet case?
//   · does the application, given the environment it is meant to have, hold no send credential?
//
// A service that answers /health is not the same as a service that is safe to expose, and the
// difference is the whole of this check.
//
// Nothing is sent and no credential is read: the service is booted with no provider credential at
// all, which is itself one of the assertions — it must still start and still refuse callers.
//
// EXIT 0 deployable as designed · 1 not · 3 nothing established.

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const note = (m) => console.log(`        ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

const ROOT = path.join(__dirname, '..');
const START = path.join(ROOT, 'src', 'services', 'sender', 'start.js');
const SECRET = 'PLACEHOLDER-not-a-secret-deployability-check';

/** Boot start.js and resolve once it is listening, or when it exits. */
function boot(env, { waitMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [START], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const grab = (b) => { out += b.toString(); };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);

    const done = (r) => { clearTimeout(t); resolve({ child, out, ...r }); };
    const t = setTimeout(() => done({ listening: /listening on/.test(out), exited: false }), waitMs);
    child.on('exit', (code) => done({ listening: false, exited: true, code }));
  });
}

const get = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', (e) => resolve({ error: e.message }));
  req.setTimeout(4000, () => { req.destroy(new Error('timeout')); });
});

/** Is the port reachable on this address? Asked, not inferred from the bind argument. */
const reachable = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.setTimeout(2500);
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.on('timeout', () => { s.destroy(); resolve(false); });
});

(async () => {
  // ══ 1. IT REFUSES TO START MISCONFIGURED ═══════════════════════════════
  head('without a secret, it must not come up at all');
  {
    const r = await boot({ SENDER_SERVICE_SECRET: '', SENDER_SERVICE_PORT: '8090' }, { waitMs: 3000 });
    if (r.exited && r.code === 1) {
      ok('it exits 1 rather than starting unauthenticated');
      if (/Refusing to start/.test(r.out)) ok('…and says why');
      else bad('it exits without explaining');
    } else {
      bad('it started without SENDER_SERVICE_SECRET',
        'an unauthenticated sender that reports itself healthy is worse than an absent one');
      try { r.child.kill(); } catch (_) {}
    }
  }

  // ══ 2. IT STARTS FROM THIS REPO, WITH ONLY ITS OWN ENVIRONMENT ═════════
  head('with a secret and NO provider credential');
  //
  // Deliberately no Google or Resend credential: the service must still start and still refuse
  // callers. A sender that only boots when it already holds a key cannot be stood up and smoke
  // tested before the credential is moved to it, which is the order a careful deploy wants.
  const PORT = '8091';
  const r2 = await boot({
    SENDER_SERVICE_SECRET: SECRET, SENDER_SERVICE_PORT: PORT,
    GOOGLE_SERVICE_ACCOUNT_JSON: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    GOOGLE_REFRESH_TOKEN: '', RESEND_API_KEY: '',
  });
  if (!r2.listening) {
    bad('it did not start', (r2.out || '').trim().split('\n').slice(-3).join(' | '));
    console.log('\nINCOMPLETE  the service could not be booted, so nothing below was established.');
    try { r2.child.kill(); } catch (_) {}
    process.exit(3);
  }
  ok('it starts with no provider credential present');

  try {
    // ══ 3. PRIVATE BY DEFAULT ════════════════════════════════════════════
    head('is it reachable from outside the host?');
    const onLoopback = await reachable('127.0.0.1', Number(PORT));
    if (onLoopback) ok('reachable on 127.0.0.1, as a sidecar or private service must be');
    else bad('not reachable on loopback either — nothing can call it');

    // The binding address, read from the process rather than from the source. A service bound to
    // 0.0.0.0 is reachable on every interface the container has, and on a platform that assigns a
    // public address that is an open sender behind one HMAC.
    const addrs = require('os').networkInterfaces();
    const external = Object.values(addrs).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
    let exposed = [];
    for (const a of external) if (await reachable(a, Number(PORT))) exposed.push(a);

    if (!exposed.length) {
      ok(`bound to loopback only — not reachable on ${external.length} external interface(s)`);
      note('SENDER_SERVICE_HOST defaults to 127.0.0.1, so exposing it is an explicit act and');
      note('"we forgot to firewall it" cannot be the quiet case.');
    } else {
      bad(`reachable on ${exposed.join(', ')} — the service is exposed beyond the host`,
        'on a platform that assigns a public address this is an open sender behind one HMAC');
    }

    // ══ 4. IT IS ALIVE AND REFUSING ══════════════════════════════════════
    head('alive, and refusing without a credential');
    const health = await get(`http://127.0.0.1:${PORT}/health`);
    if (health.status === 200) {
      ok('GET /health answers');
      const body = JSON.parse(health.body);
      if (body.transports && body.transports.length === 3) {
        ok(`and reports its three transports: ${body.transports.join(', ')}`);
      } else {
        bad(`/health reports ${JSON.stringify(body.transports)}`);
      }
    } else {
      bad(`GET /health → ${health.status || health.error}`);
    }

    const unsigned = await new Promise((resolve) => {
      const body = JSON.stringify({ message: { to: 'x@example.invalid', subject: 's', raw: 'cw', mailbox: 'x@example.invalid' }, transport: 'gmail_cphi', idempotencyKey: 'deployability' });
      const req = http.request({ method: 'POST', hostname: '127.0.0.1', port: Number(PORT), path: '/send',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0));
      req.end(body);
    });
    if (unsigned === 401) ok('POST /send unsigned → 401, so it is authenticating');
    else bad(`POST /send unsigned → ${unsigned} (expected 401)`);

    // ══ 5. THE APPLICATION SIDE OF THE SPLIT ═════════════════════════════
    head('the application, with the environment it is meant to have');
    //
    // Run here rather than left to the deployment: the point of the split is that BOTH sides are
    // checkable before either is deployed.
    const { spawnSync } = require('child_process');
    const appCheck = spawnSync(process.execPath, ['scripts/check-credential-isolation.js', '--expect', 'app'], {
      cwd: ROOT, encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        SENDER_SERVICE_URL: `http://127.0.0.1:${PORT}`, SENDER_SERVICE_SECRET: SECRET,
      },
    });
    if (appCheck.status === 0) {
      ok('an application with no provider credential reports isolation complete');
    } else {
      bad('the application-side check did not pass with a clean environment',
        (appCheck.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join(' | '));
    }

    const senderCheck = spawnSync(process.execPath, ['scripts/check-credential-isolation.js', '--expect', 'sender'], {
      cwd: ROOT, encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        SENDER_SERVICE_SECRET: SECRET, GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
      },
    });
    if (senderCheck.status === 0) ok('and a sender holding a Gmail credential reports correctly');
    else bad('the sender-side check did not pass with a credential present');
  } finally {
    try { r2.child.kill(); } catch (_) {}
  }

  console.log();
  if (fail) {
    console.log(`FAIL  ${fail} check(s) failed. The sender service is not deployable as designed.`);
    process.exit(1);
  }
  console.log('PASS  the sender service starts standalone, refuses to start unauthenticated, binds');
  console.log('      loopback only, answers /health, and refuses unsigned callers — with NO provider');
  console.log('      credential present. Nothing was sent.');
  process.exit(0);
})().catch((e) => {
  console.log(`\nINCOMPLETE  ${(e && e.stack) || e}`);
  process.exit(3);
});
