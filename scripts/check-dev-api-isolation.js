#!/usr/bin/env node
// ── THE DEV API CANNOT REACH THE CRON SERVER ────────────────────────────────
//
//   node scripts/check-dev-api-isolation.js; echo "EXIT=$?"
//
// scripts/dev-worker-api-server.js is what Railway's start command runs for the M7 development
// service. The claim it rests on is that it cannot load server.js — which registers 42 cron jobs at
// module load, among them performance scoring (emails coaching), the command-center briefing
// (emails the owner), the GitHub sync, and the product shadow read (connects to the Abiozen Django
// PRODUCTION database).
//
// A comment saying "this does not import server.js" is not that claim. Nor is grepping the file for
// `require('../server')`: the risk is TRANSITIVE — worker.routes.js requires something that
// requires something that pulls in the cron registry, and nothing in a direct read would show it.
//
// So this LOADS the module in a child process and inspects the real require cache. Whatever got
// pulled in, by any path, is in there.
//
// EXIT 0 isolated · 1 something reachable that must not be

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 400)}`); };
const note = (m) => console.log(`  --    ${m}`);
const head = (m) => console.log(`\n  ── ${m} ──\n`);

console.log('\n══ DEV API ISOLATION ══');

// ── 1. LOAD IT AND SEE WHAT CAME WITH IT ────────────────────────────────────
head('1. what the dev API actually loads');

// It is required, not run: the listen() call is skipped by never reaching the bottom? No — the
// module listens on load. So PORT=0 and an immediate exit after capturing the cache, which is
// enough to see every module that was pulled in.
const probe = `
  process.env.M7_DEV_API = 'yes';
  process.env.WORKER_API_ENABLED = 'true';
  process.env.WORKER_SECRET_SEAL_KEY = '${'ab'.repeat(32)}';
  process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:59997/devdb';
  process.env.PORT = '0';
  delete process.env.NODE_ENV;
  try { require(${JSON.stringify(path.join(REPO, 'scripts', 'dev-worker-api-server.js'))}); }
  catch (e) { console.error('LOAD_ERROR ' + e.message); process.exit(9); }
  const loaded = Object.keys(require.cache)
    .map((p) => p.replace(${JSON.stringify(REPO + path.sep)}, ''))
    .filter((p) => !p.startsWith('node_modules'))
    .sort();
  const pkgs = Object.keys(require.cache)
    .filter((p) => p.includes('node_modules'))
    .map((p) => { const m = p.match(/node_modules[\\\\/](@[^\\\\/]+[\\\\/][^\\\\/]+|[^\\\\/]+)/); return m ? m[1] : null; })
    .filter(Boolean);
  console.log(JSON.stringify({ loaded, pkgs: [...new Set(pkgs)].sort() }));
  process.exit(0);
`;

const r = spawnSync(process.execPath, ['-e', probe], {
  cwd: REPO, encoding: 'utf8', timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
});

if (r.status === 9 || (r.status !== 0 && !r.stdout)) {
  bad('the dev API module could not be loaded at all', `${r.stderr || ''}`.slice(0, 300));
  console.log('\nFAIL  isolation could not be assessed.');
  process.exit(1);
}

let info;
try {
  info = JSON.parse(String(r.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop());
} catch (e) {
  bad('could not read the require cache from the probe', `${r.stdout}`.slice(0, 300));
  console.log('\nFAIL  isolation could not be assessed.');
  process.exit(1);
}

note(`${info.loaded.length} repo module(s) and ${info.pkgs.length} package(s) loaded`);

// Vacuity guard: if nothing loaded, every assertion below is trivially satisfied.
if (info.loaded.length < 3) {
  bad('fewer than 3 repo modules loaded — the probe did not really load the API',
    info.loaded.join(', '));
}

// ── 2. THE CRON SERVER IS NOT AMONG THEM ────────────────────────────────────
head('2. server.js and the cron registry are NOT reachable');

if (!info.loaded.includes('server.js')) ok('server.js was NOT loaded');
else bad('server.js WAS loaded — all 42 crons are registered by this process');

if (!info.pkgs.includes('node-cron')) ok('node-cron was NOT loaded — no scheduler exists in this process');
else bad('node-cron WAS loaded', 'something in the require graph registers schedules');

// The modules that would actually do something consequential if a cron fired.
const CONSEQUENTIAL = [
  ['src/lib/mailer.js', 'email'],
  ['src/lib/whatsapp.js', 'WhatsApp'],
  ['src/lib/cron-alerts.js', 'cron alert email'],
  ['src/api/routes.js', 'the full production REST surface'],
];
const reached = CONSEQUENTIAL.filter(([m]) => info.loaded.includes(m));
if (reached.length === 0) {
  ok(`none of the ${CONSEQUENTIAL.length} consequential modules are reachable `
    + `(${CONSEQUENTIAL.map(([, w]) => w).join(', ')})`);
} else {
  bad(`${reached.length} consequential module(s) loaded`,
    reached.map(([m, w]) => `${m} (${w})`).join('; '));
}

for (const [pkg, what] of [['resend', 'email'], ['twilio', 'WhatsApp'],
  ['@anthropic-ai/sdk', 'the LLM'], ['openai', 'OpenAI'], ['algoliasearch', 'Algolia']]) {
  if (info.pkgs.includes(pkg)) bad(`the ${what} client package ${pkg} was loaded`);
}
ok('no provider SDK was loaded');

// ── 3. WHAT IT DID LOAD IS WHAT IT NEEDS ────────────────────────────────────
head('3. and it loaded what it does need');

for (const m of ['src/api/worker.routes.js', 'src/lib/worker/leases.js']) {
  if (info.loaded.includes(m)) ok(`${m}`);
  else bad(`${m} was NOT loaded — the worker API would not function`);
}
// autonomy.js is deliberately NOT expected here: it is required lazily, inside the functions that
// consult the kill switch, so it does not appear in the cache until the first request. Asserting it
// at load time was my error, not the code's. What matters is that it is reachable when needed:
try {
  const a = require('../src/lib/autonomy');
  if (typeof a.checkStopped === 'function') {
    ok('src/lib/autonomy.js is lazily required and loads on demand (checkStopped present)');
  } else bad('autonomy.js loaded but has no checkStopped');
} catch (e) { bad('autonomy.js cannot be loaded at all', e.message); }

// ── 4. THE START COMMAND IS THE ONLY WAY IN ─────────────────────────────────
head('4. the documented start command, and the one it must not be');

const fs = require('fs');

// ── THE ROOT CONFIG IS PRODUCTION'S, AND IT WINS OVER THE DASHBOARD ─────────
//
// railway.json at the repo root sets `startCommand: node server.js`, and Railway's documentation
// states that configuration defined in code always overrides dashboard values. So a dev service
// that reads this file runs the production cron server no matter what its dashboard says. That is
// a fact about the repository, not a defect — production needs that config. What must be true is
// that a SEPARATE file exists for the dev service, under a name Railway does not auto-detect.
const rootCfgPath = path.join(REPO, 'railway.json');
if (fs.existsSync(rootCfgPath)) {
  const rootCfg = JSON.parse(fs.readFileSync(rootCfgPath, 'utf8'));
  const sc = (rootCfg.deploy && rootCfg.deploy.startCommand) || '';
  if (/server\.js/.test(sc)) {
    ok(`railway.json (production) still starts the production server: "${sc}"`);
    note('config-as-code overrides the dashboard, so a dev service reading THIS file would run');
    note('all 42 crons regardless of its dashboard start command.');
  } else {
    bad(`railway.json startCommand is "${sc}"`, 'production must not have been repointed');
  }
  if (rootCfg.deploy && rootCfg.deploy.preDeployCommand) {
    note(`it also runs a pre-deploy migration: ${JSON.stringify(rootCfg.deploy.preDeployCommand)}`);
  }
} else {
  note('no railway.json at the repo root');
}

// The dev service's own config, under a NON-auto-detected name.
const devCfgPath = path.join(REPO, 'railway.dev.json');
if (!fs.existsSync(devCfgPath)) {
  bad('railway.dev.json is missing',
    'without it the dev service has only its dashboard start command, which the root '
    + 'railway.json would override.');
} else {
  const devCfg = JSON.parse(fs.readFileSync(devCfgPath, 'utf8'));
  const dsc = (devCfg.deploy && devCfg.deploy.startCommand) || '';
  if (dsc === 'node scripts/dev-worker-api-server.js') {
    ok(`railway.dev.json starts ONLY the dev API: "${dsc}"`);
  } else bad(`railway.dev.json startCommand is "${dsc}"`, 'expected node scripts/dev-worker-api-server.js');
  if (!/server\.js$/.test(dsc.replace('dev-worker-api-server.js', ''))) {
    ok('and it does not start server.js');
  }
  if (!devCfg.deploy || !devCfg.deploy.preDeployCommand) {
    ok('and it runs NO pre-deploy command — the dev schema is migrated explicitly by the operator');
    note('so a redeploy cannot change the schema under a hardware test in progress');
  } else bad('railway.dev.json defines a preDeployCommand', JSON.stringify(devCfg.deploy.preDeployCommand));
}

// Any OTHER auto-detected deploy config would make which one applies ambiguous.
const ambiguous = ['Procfile', 'railway.toml', 'nixpacks.toml', 'railpack.json']
  .filter((f) => fs.existsSync(path.join(REPO, f)));
if (ambiguous.length === 0) {
  ok('no other auto-detected deploy config exists, so which config applies is unambiguous');
} else {
  bad(`${ambiguous.length} additional auto-detected deploy config(s) present`,
    `${ambiguous.join(', ')} — two sources of truth for how a service starts`);
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const startScript = (pkgJson.scripts && pkgJson.scripts.start) || '';
if (/server\.js/.test(startScript) && !/dev-worker-api/.test(startScript)) {
  ok(`npm start still runs the production server (${startScript.trim()})`);
  note('so a dev service MUST override the start command; leaving it default starts the cron server');
} else if (!startScript) {
  note('package.json defines no start script');
} else {
  bad(`npm start is ${startScript}`, 'production must not have been repointed');
}

// If the dev service were ever misconfigured to run server.js, the dev API's own refusals would not
// help — they live in a file that would not be loaded. The containment seed is what covers that
// case, which is exactly why it exists as a second layer.
note('');
note('If the dev service were misconfigured to run server.js, this file\'s refusals would not fire');
note('— they are in a module that would never load. scripts/m7-dev-seed-containment.js is the layer');
note('that covers that case, and it is why a second layer exists at all.');

console.log();
if (fail) {
  console.log(`FAIL  ${fail} isolation problem(s). The dev API is not safely isolated from the cron server.`);
  process.exit(1);
}
console.log('PASS  loading the dev API pulls in neither server.js nor node-cron nor any mailer,');
console.log('      WhatsApp, LLM or other provider client — verified by inspecting the real require');
console.log('      cache after loading it, not by reading the source.');
console.log('      railway.dev.json starts only the dev API and runs no pre-deploy command, and the');
console.log('      production railway.json is unchanged.');
console.log('');
console.log('      THIS DOES NOT PROVE WHICH CONFIG RAILWAY WILL APPLY TO THE DEV SERVICE. That');
console.log('      depends on that service\'s Config-as-Code setting and must be confirmed from the');
console.log('      first deploy log: four [m7-dev-worker-api] lines, and no cron registration.');
process.exit(0);
