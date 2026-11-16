#!/usr/bin/env node
// ── EXACTLY ONE OF THE TWO SERVERS CAN START ────────────────────────────────
//
//   node scripts/check-dev-marker-mutual-exclusion.js; echo "EXIT=$?"
//
// The M7 development service carries M7_DEV_API=yes. That marker is REQUIRED by
// scripts/dev-worker-api-server.js and REFUSED by server.js, so the two are mutually exclusive by
// code rather than by configuration.
//
// ── WHY THIS IS NOT A CONFIGURATION QUESTION ────────────────────────────────
//
// Railway's docs say config-in-code always overrides the dashboard, and the repo root holds
// railway.json with `startCommand: node server.js`. Whether a newly created service reads that file
// is not something the documentation settles, and this session has no Railway access to find out.
// Rather than leave the answer to "read the first deploy log and hope someone looks", the marker
// makes the wrong process refuse to boot.
//
// What matters is not that server.js exits — it is that it exits BEFORE registering anything. So
// this asserts on the real require cache: node-cron must never be loaded, and the mailer, WhatsApp
// and the Abiozen production database module must never be reached.
//
// EXIT 0 mutually exclusive, and the refusal is early · 1 it is not

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server.js');
const DEVAPI = path.join(REPO, 'scripts', 'dev-worker-api-server.js');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 300)}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

const BASE = { PATH: process.env.PATH, HOME: process.env.HOME };

function run(entry, env) {
  const e = { ...BASE, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, [entry], { cwd: REPO, encoding: 'utf8', timeout: 45_000, env: e });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Loads an entry point and reports what it pulled in before exiting. */
function loadProbe(entry, env) {
  const probe = `
    const real = process.exit;
    process.exit = (c) => { throw Object.assign(new Error('x'), { __code: c }); };
    let code = null;
    try { require(${JSON.stringify(entry)}); } catch (e) { if (e && e.__code !== undefined) code = e.__code; }
    const pkgs = [...new Set(Object.keys(require.cache)
      .filter((p) => p.includes('node_modules'))
      .map((p) => { const m = p.match(/node_modules[\\\\/](@[^\\\\/]+[\\\\/][^\\\\/]+|[^\\\\/]+)/); return m ? m[1] : null; })
      .filter(Boolean))];
    const repo = Object.keys(require.cache)
      .filter((p) => !p.includes('node_modules') && p.startsWith(${JSON.stringify(REPO)}))
      .map((p) => p.replace(${JSON.stringify(REPO + path.sep)}, ''));
    process.stdout.write(JSON.stringify({ code, pkgs, repo }) + '\\n');
    real(0);
  `;
  const e = { ...BASE, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, ['-e', probe], { cwd: REPO, encoding: 'utf8', timeout: 45_000, env: e });
  try {
    return JSON.parse(String(r.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop());
  } catch (err) { return { code: null, pkgs: [], repo: [], err: String(r.stderr || '').slice(0, 200) }; }
}

const DEV_MARKER = { M7_DEV_API: 'yes' };
const DEV_FULL = {
  M7_DEV_API: 'yes', WORKER_API_ENABLED: 'true',
  WORKER_SECRET_SEAL_KEY: 'ab'.repeat(32),
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:59995/devdb', PORT: '0',
};

console.log('\n══ DEV MARKER MUTUAL EXCLUSION ══');

// ── 1. server.js REFUSES THE MARKER ─────────────────────────────────────────
head('1. server.js refuses to start as the development service');

const refused = run(SERVER, DEV_MARKER);
if (refused.code === 2 && /M7_DEV_API=yes marks this as the M7 development worker service/.test(refused.out)) {
  ok('server.js exits 2 when M7_DEV_API=yes');
} else bad('server.js did NOT refuse the development marker', `exit ${refused.code}: ${refused.out.slice(0, 300)}`);

if (/dev-worker-api-server\.js/.test(refused.out)) {
  ok('and it names the process that should have started instead');
} else bad('the refusal does not say what to run instead');

// ── 2. AND IT REFUSES EARLY — THE PART THAT MATTERS ─────────────────────────
head('2. nothing is registered before it refuses');

note('An exit code alone would not be enough: 42 crons register at module load, so WHEN the');
note('refusal happens is the whole question.');

const probe = loadProbe(SERVER, DEV_MARKER);
if (probe.err) bad('could not probe server.js', probe.err);

if (probe.code === 2) ok('the probe confirms exit 2');
else bad(`the probe saw exit ${JSON.stringify(probe.code)}`);

if (!probe.pkgs.includes('node-cron')) {
  ok('node-cron was NEVER loaded — no schedule can have been registered');
} else bad('node-cron was loaded before the refusal', 'crons may already be registered');

for (const [m, what] of [
  ['src/lib/cron-alerts.js', 'the cron alert path'],
  ['src/lib/mailer.js', 'email'],
  ['src/lib/whatsapp.js', 'WhatsApp'],
  ['src/api/routes.js', 'the production REST surface'],
  ['src/lib/db.js', 'the database module'],
]) {
  if (probe.repo.includes(m)) bad(`${m} was loaded before the refusal (${what})`);
}
ok('no mailer, WhatsApp, cron-alert, route or database module was reached');

for (const pkg of ['resend', 'twilio', '@anthropic-ai/sdk', 'openai', 'algoliasearch', 'pg']) {
  if (probe.pkgs.includes(pkg)) bad(`the ${pkg} package was loaded before the refusal`);
}
ok('and no provider SDK or database driver was loaded');
note(`${probe.repo.length} repo module(s) and ${probe.pkgs.length} package(s) loaded in total`);

// ── 3. THE DEV API REQUIRES THE SAME MARKER ─────────────────────────────────
head('3. the development API requires what server.js refuses');

const devNoMarker = run(DEVAPI, { ...DEV_FULL, M7_DEV_API: undefined });
if (devNoMarker.code === 2 && /M7_DEV_API=yes/.test(devNoMarker.out)) {
  ok('dev-worker-api-server.js refuses to start WITHOUT the marker');
} else bad('the dev API started without the marker', `exit ${devNoMarker.code}`);

// The control: the dev API must get PAST its marker check when it is present, or "mutually
// exclusive" would be satisfied by neither of them ever starting.
const devWithMarker = run(DEVAPI, DEV_FULL);
if (devWithMarker.code === 2 && /M7_DEV_API=yes/.test(devWithMarker.out)) {
  bad('the dev API still refuses WITH the marker set', 'nothing could start at all');
} else ok('control: with the marker present it gets past that check');

// ── 4. AND server.js IS UNAFFECTED WITHOUT THE MARKER ───────────────────────
head('4. production is not disturbed');

// No marker, no DATABASE_URL: it must fail for its OWN reasons, never with the dev refusal.
const prodish = run(SERVER, { PORT: '0' });
if (/M7_DEV_API/.test(prodish.out)) {
  bad('server.js emitted the development refusal when the marker was absent',
    'the guard fires on the wrong condition');
} else ok('without the marker, server.js does not emit the development refusal');

const fs = require('fs');
const src = fs.readFileSync(SERVER, 'utf8');
const guardAt = src.indexOf("process.env.M7_DEV_API === 'yes'");
const cronAt = src.indexOf("require('node-cron')");
const firstCron = src.indexOf('cron.schedule(');
if (guardAt > 0 && cronAt > 0 && guardAt < cronAt) {
  ok(`the guard appears at character ${guardAt}, before require('node-cron') at ${cronAt}`);
} else bad('the guard is not positioned before node-cron is required', `guard=${guardAt} cron=${cronAt}`);
if (guardAt > 0 && firstCron > 0 && guardAt < firstCron) {
  ok('and before the first cron.schedule() call');
} else bad('the guard is not before the first cron.schedule()');

// Everything above the guard must be inert. dotenv is the only thing permitted to precede it,
// because a .env-supplied marker must be caught too.
const before = src.slice(0, guardAt);
const requiresBefore = [...before.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
const allowed = ['dotenv'];
const unexpected = requiresBefore.filter((r) => !allowed.includes(r));
if (unexpected.length === 0) {
  ok(`only ${allowed.join(', ')} is required before the guard`);
} else bad(`${unexpected.length} module(s) are required before the guard`, unexpected.join(', '));

console.log();
if (fail) {
  console.log(`FAIL  ${fail} problem(s). The two servers are not mutually exclusive, or the refusal`);
  console.log('      is not early enough to prevent a cron registering.');
  process.exit(1);
}
console.log('PASS  server.js refuses M7_DEV_API=yes and dev-worker-api-server.js requires it, so');
console.log('      exactly one can start whichever config Railway applies. The refusal happens');
console.log('      before node-cron, the mailer, WhatsApp, the routes and the database driver are');
console.log('      loaded — so no schedule can have been registered and nothing can have been sent.');
process.exit(0);
