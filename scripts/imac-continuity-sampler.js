#!/usr/bin/env node
// ── INDEPENDENT CONTINUITY MONITORING FROM THE OFFICE iMac (B4.5 / E) ───────
//
//   node scripts/imac-continuity-sampler.js --api <https url> [--interval-seconds 60]
//        [--duration-hours 72] [--out <path>]
//
//   exit 0 = the window completed and a summary line was written
//   exit 1 = it stopped early
//   exit 2 = refused before sampling anything
//
// Owner's approval of 2026-11-27, conditions quoted: *"Create a separate, lightweight monitoring
// process. Use read-only, development-scoped access. Persist monitoring records locally. Ensure
// monitoring survives Claude Code session termination and Railway worker restarts. Verify automatic
// monitoring recovery after process termination. Do not modify the existing iMac worker, its
// identity, credentials, Keychain, FileVault or existing LaunchAgent. Do not require administrator
// privileges or weaken macOS security."*
//
// ── WHY THIS EXISTS RATHER THAN office-reliability-sampler.js ───────────────
//
// `office-reliability-sampler.js` is the richer monitor and it is the one to prefer wherever it can
// run: it reads scheduler heartbeats, run terminality, alert open/close and exposure directly. It
// needs `DATABASE_URL`, because it identifies the database through `scripts/lib/db-identity.js`
// before it samples anything.
//
// The development database is reachable only on Railway's project-private DNS
// (`postgres-pq2k.railway.internal`, measured unresolvable from outside the project, and
// `tcpProxies` for that service is empty). So running it from the iMac would require either giving
// the development database a public address — refused, and `db-identity.js` documents at length why
// that workaround is the wrong trade — or copying `DATABASE_URL` to the iMac, which the owner
// forbade in the same directive that approved this monitoring.
//
// So this samples over HTTPS instead and holds NO credential of any kind. That is a deliberate
// narrowing, and the next section says exactly what it costs.
//
// ── WHAT THIS CAN AND CANNOT PROVE ─────────────────────────────────────────
//
// CAN: that the development API answered, at a known interval, with the interval actually achieved
// recorded per sample; that it reported its database connected; the latency of each reading; and
// therefore where the gaps were and how long each lasted. A process that dies writes nothing about
// having died, so a gap is only ever visible to something outside the system under test — which is
// the whole reason this runs on a different machine.
//
// CANNOT: that the office DID anything. Scheduler heartbeat age, run terminality, alert lifecycle
// and cost exposure are not on the health endpoint, so this monitor is silent about all four. A
// 72-hour window that this sampler calls gap-free establishes that the application stayed up. It
// does NOT establish that consecutive cycles ran. Anyone reading its output must not treat the
// first claim as the second.
//
// ── IT HOLDS NO TRANSPORT AND NO DATABASE CLIENT ───────────────────────────
//
// Asserted as a property of this file's SHAPE by `scripts/imac-sampler-is-credential-free.test.js`,
// for the same reason `monitor-has-no-transport.test.js` gives: a configuration flag can be set by
// anybody with access to the environment, whereas requiring no `pg`, no mailer and no
// `DATABASE_URL` means acquiring them is an ADDITION somebody has to write and review.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const refuse = (msg) => { process.stderr.write(`REFUSED  ${msg}\n`); process.exit(2); };

const api = arg('api');
const intervalSeconds = Number(arg('interval-seconds', '60'));
const durationHours = Number(arg('duration-hours', '72'));
const outPath = arg('out', path.join(
  process.env.HOME || '.', 'playnexa-monitor', 'continuity.jsonl'));

if (!api) {
  refuse('usage: --api <https url> [--interval-seconds 60] [--duration-hours 72] [--out <path>]');
}
// `api.startsWith('https://')` rather than a regex, deliberately. A regex written `/^https:\/\//`
// contains the character pair `//` after an escape, and every comment-stripping scanner in this
// repo — `monitor-has-no-transport.test.js` included — treats `//` as the start of a comment unless
// it is preceded by a colon. So that regex silently truncated this line in the credential-free
// scan, which then mis-paired the template literal below it and swallowed the production refusal
// forty lines further down. The scan reported a clean file for entirely the wrong reason.
// A plain string test cannot be mis-lexed, so the hazard is removed rather than worked around.
if (!api.startsWith('https://')) {
  refuse(`--api must be https. Got ${api}`);
}

// ── THE PRODUCTION REFUSAL ─────────────────────────────────────────────────
//
// Read-only is not the same as harmless. Pointing a monitor at production from an operator's
// machine is a connection to production, and the standing instruction forbids it. The hostname is a
// weak test in general — `db-identity.js` explains why — but here there is no database to
// interrogate, so the host is the only signal available, and a named refusal beats none.
if (/playbookos-production|playbook\.abiozen\.com/.test(api)) {
  refuse('that is the PRODUCTION api. This monitor is for the development environment only');
}
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10) {
  refuse('--interval-seconds must be a number >= 10');
}
if (!Number.isFinite(durationHours) || durationHours <= 0) {
  refuse('--duration-hours must be a positive number');
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });

// Append-only, flushed per sample. A crash loses at most the reading in flight, and the gap it
// leaves is visible in the timestamps of the lines on either side of it. The file IS the evidence.
const append = (obj) => {
  try {
    fs.appendFileSync(outPath, `${JSON.stringify(obj)}\n`);
  } catch (e) {
    // A monitor that exits because it could not write its own log is a monitor that creates the
    // outage it exists to detect. Report to stderr (launchd captures it) and keep sampling.
    process.stderr.write(`sample_not_written ${String(e.message).slice(0, 160)}\n`);
  }
};

const startedAt = Date.now();
const endAt = startedAt + durationHours * 3600 * 1000;

append({
  at: 'started',
  ts: new Date(startedAt).toISOString(),
  api,
  intervalSeconds,
  durationHours,
  pid: process.pid,
  host: require('node:os').hostname(),
  note: 'HTTP continuity only — says nothing about whether the office executed any cycle',
});

let samples = 0;
let ok = 0;
let lastTs = startedAt;
let maxGapMs = 0;
let stopping = false;

const onSignal = (sig) => {
  stopping = true;
  append({ at: 'shutdown_requested', ts: new Date().toISOString(), signal: sig });
};
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

async function sample() {
  const t0 = Date.now();
  const gapMs = t0 - lastTs;
  lastTs = t0;
  if (samples > 0 && gapMs > maxGapMs) maxGapMs = gapMs;

  const rec = {
    at: 'sample',
    ts: new Date(t0).toISOString(),
    sinceLastMs: samples === 0 ? null : gapMs,
  };

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    let res;
    try {
      res = await fetch(`${api.replace(/\/$/, '')}/health`, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    rec.status = res.status;
    rec.latencyMs = Date.now() - t0;
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    // Only the fields the endpoint actually publishes. Absent is recorded as absent rather than as
    // a default, because "the endpoint stopped reporting db" and "db is false" are different events.
    rec.health = body ? {
      status: body.status ?? null,
      db: body.db ?? null,
      production: body.production ?? null,
      worker_api: body.worker_api ?? null,
      commit: body.commit ?? null,
    } : null;
    rec.ok = res.status === 200 && body && body.status === 'ok';
    if (rec.ok) ok += 1;
  } catch (e) {
    rec.ok = false;
    rec.latencyMs = Date.now() - t0;
    rec.error = String(e && e.message).slice(0, 200);
  }

  samples += 1;
  append(rec);
}

(async () => {
  while (!stopping && Date.now() < endAt) {
    await sample();
    const wait = Math.max(0, intervalSeconds * 1000 - (Date.now() - lastTs));
    await new Promise((r) => setTimeout(r, wait));
  }
  append({
    at: 'summary',
    ts: new Date().toISOString(),
    samples,
    ok,
    failed: samples - ok,
    maxGapMs,
    expectedIntervalMs: intervalSeconds * 1000,
    completedWindow: Date.now() >= endAt,
    note: 'maxGapMs materially above expectedIntervalMs means this monitor itself was not running; '
      + 'that is a monitoring gap, not an application outage, and the two must not be conflated',
  });
  process.exit(stopping && Date.now() < endAt ? 1 : 0);
})();
