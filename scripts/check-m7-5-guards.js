#!/usr/bin/env node
// ── THE M7.5 SCRIPTS MUST REFUSE PRODUCTION, FOREVER ────────────────────────
//
//   node scripts/check-m7-5-guards.js; echo "EXIT=$?"
//
// scripts/m7-5-dev-driver.js cancels tasks, sets a STOP and revokes a credential. Against
// production that changes containment state. scripts/m7-5-acceptance.sh writes a LaunchAgent and
// drives a worker. Both refuse production, and this pins those refusals so a later edit cannot
// quietly widen them.
//
// Every case here is executed, not read: the guard is invoked and its exit code and message are
// checked. A test that greps a script for the word "REFUSED" tests the spelling.
//
// ANTI-VACUITY: a legitimate development target must get PAST the production gate. Without that,
// a guard that refuses literally everything would pass this check — and would also make M7.5
// impossible to run, which is the failure nobody would attribute to the guard.
//
// EXIT 0 every guard behaves · 1 one does not

'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const LEX = require('./js-lex');

const REPO = path.join(__dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'm7-5-dev-driver.js');
const ACCEPT = path.join(REPO, 'scripts', 'm7-5-acceptance.sh');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${String(d).slice(0, 220)}`); };
const head = (m) => console.log(`\n  ── ${m} ──\n`);

/** Runs the driver with a given DATABASE_URL and nothing else that could let it through. */
function driver(dbUrl, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
  if (dbUrl !== undefined) env.DATABASE_URL = dbUrl;
  const r = spawnSync(process.execPath, [DRIVER, 'mint'], { env, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** Runs the acceptance script. On Linux the Darwin gate fires first, so for the host cases we
 *  neutralise exactly that one line — nothing else — and leave every other guard intact. */
function accept(baseUrl, { stubDarwin = false } = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (baseUrl !== undefined) env.WORKER_API_BASE_URL = baseUrl;
  let script = ACCEPT;
  if (stubDarwin) {
    const src = require('fs').readFileSync(ACCEPT, 'utf8');
    const stubbed = src.replace('if [ "$(uname -s)" != "Darwin" ]; then', 'if false; then');
    if (stubbed === src) {
      bad('could not neutralise the Darwin gate — its line has changed',
        'this check can no longer reach the host guard; fix the replacement above');
      return { code: -1, out: '' };
    }
    script = path.join(require('os').tmpdir(), `m75-accept-${process.pid}.sh`);
    require('fs').writeFileSync(script, stubbed);
  }
  const r = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 20_000 });
  if (stubDarwin) { try { require('fs').unlinkSync(script); } catch (_) {} }
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

console.log('\n══ M7.5 GUARDS ══');

// ── 1. THE DEV DRIVER ───────────────────────────────────────────────────────
head('1. m7-5-dev-driver.js refuses every production database');

const PROD_DBS = [
  ['postgresql://u:p@postgres.railway.internal:5432/railway', 'the production Postgres'],
  ['postgresql://u:p@interchange.proxy.rlwy.net:18553/railway', 'the Abiozen Django production DB'],
  ['postgresql://u:p@replica.postgres.railway.internal:5432/railway', 'a subdomain of a production host'],
];
for (const [url, what] of PROD_DBS) {
  const r = driver(url, { M7_5_DEV_CONFIRM: 'yes' });   // confirmation must NOT buy a way through
  if (r.code === 2 && /production host/.test(r.out)) ok(`refuses ${what}`);
  else bad(`did NOT refuse ${what}`, `exit ${r.code}: ${r.out}`);
}

const noUrl = driver(undefined);
if (noUrl.code === 2 && /not set/.test(noUrl.out)) ok('refuses a missing DATABASE_URL');
else bad('did not refuse a missing DATABASE_URL', `exit ${noUrl.code}`);

const nodeEnvProd = driver('postgresql://u:p@localhost:5432/dev',
  { M7_5_DEV_CONFIRM: 'yes', NODE_ENV: 'production' });
if (nodeEnvProd.code === 2 && /NODE_ENV=production/.test(nodeEnvProd.out)) {
  ok('refuses NODE_ENV=production even against a local database');
} else bad('ran with NODE_ENV=production', `exit ${nodeEnvProd.code}`);

const unconfirmed = driver('postgresql://u:p@localhost:5432/dev');
if (unconfirmed.code === 2 && /M7_5_DEV_CONFIRM/.test(unconfirmed.out)) {
  ok('refuses a development database until it is explicitly confirmed');
} else bad('ran against an unconfirmed database', `exit ${unconfirmed.code}`);

const unparseable = driver('not a url at all', { M7_5_DEV_CONFIRM: 'yes' });
if (unparseable.code === 2) ok('refuses a DATABASE_URL it cannot inspect, rather than hoping');
else bad('accepted a DATABASE_URL it could not parse', `exit ${unparseable.code}`);

// ANTI-VACUITY. A confirmed local development URL must get past the production gate. It will then
// fail trying to CONNECT, which is a different and expected failure — the point is which refusal
// it reaches.
const legit = driver('postgresql://u:p@127.0.0.1:59999/devdb', { M7_5_DEV_CONFIRM: 'yes' });
if (legit.code !== 2 || !/production host|M7_5_DEV_CONFIRM|not set/.test(legit.out)) {
  ok('control: a confirmed local development database gets PAST the production gate');
} else bad('the guard refuses even a legitimate development database, so M7.5 cannot be run',
  `exit ${legit.code}: ${legit.out}`);

// ── 2. THE ACCEPTANCE SCRIPT ────────────────────────────────────────────────
head('2. m7-5-acceptance.sh refuses to produce fake hardware evidence');

const onLinux = accept('https://dev-playnexa.example.com');
if (onLinux.code === 2 && /not Darwin/.test(onLinux.out)) {
  ok('refuses to run anywhere but macOS — a transcript from Linux is not hardware evidence');
} else bad('ran on a non-Darwin host', `exit ${onLinux.code}: ${onLinux.out}`);

const PROD_URLS = [
  ['https://app.playnexa.ai', 'production'],
  ['https://playbook.abiozen.com', 'the custom production domain'],
  ['https://playbookos-production.up.railway.app', 'the Railway production URL'],
  ['https://app.playnexa.ai/api', 'production with a path'],
];
for (const [url, what] of PROD_URLS) {
  const r = accept(url, { stubDarwin: true });
  if (r.code === 2 && /is production/.test(r.out)) ok(`refuses ${what}`);
  else bad(`did NOT refuse ${what}`, `exit ${r.code}: ${r.out}`);
}

const plain = accept('http://dev-playnexa.example.com', { stubDarwin: true });
if (plain.code === 2 && /must be https/.test(plain.out)) {
  ok('refuses plain HTTP — M7.5 requires certificate verification');
} else bad('accepted a plain-HTTP base URL', `exit ${plain.code}`);

const noBase = accept(undefined, { stubDarwin: true });
if (noBase.code === 2) ok('refuses a missing base URL');
else bad('ran with no base URL', `exit ${noBase.code}`);

// ANTI-VACUITY for the host list: a legitimate dev URL must clear the host gate and be stopped by
// a LATER guard (in this container, the root/admin check) rather than by the production list.
const legitUrl = accept('https://dev-playnexa.example.com', { stubDarwin: true });
if (legitUrl.code === 2 && !/is production|must be https/.test(legitUrl.out)) {
  ok('control: a development URL clears the host gate and is stopped by a later check');
} else bad('a legitimate development URL was refused as production',
  `exit ${legitUrl.code}: ${legitUrl.out}`);

// ── 2b. THE DEV API ENTRY POINT ─────────────────────────────────────────────
head('2b. dev-worker-api-server.js refuses anything production-shaped');

const DEVAPI = path.join(REPO, 'scripts', 'dev-worker-api-server.js');
const SEAL64 = 'd4'.repeat(32);
function devapi(extra = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
  const r = spawnSync(process.execPath, [DEVAPI], { env, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const DEV_OK = {
  M7_DEV_API: 'yes',
  WORKER_API_ENABLED: 'true',
  WORKER_SECRET_SEAL_KEY: SEAL64,
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:59998/devdb',
};

for (const [name, env, expect] of [
  ['without M7_DEV_API', { ...DEV_OK, M7_DEV_API: undefined }, /M7_DEV_API=yes/],
  ['with NODE_ENV=production', { ...DEV_OK, NODE_ENV: 'production' }, /NODE_ENV=production/],
  ['pointed at the production Postgres',
    { ...DEV_OK, DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway' },
    /production database host/],
  ['pointed at the Abiozen production DB',
    { ...DEV_OK, DATABASE_URL: 'postgresql://u:p@interchange.proxy.rlwy.net:18553/railway' },
    /production database host/],
  ['without WORKER_API_ENABLED=true', { ...DEV_OK, WORKER_API_ENABLED: undefined }, /WORKER_API_ENABLED/],
  ['with WORKER_API_ENABLED=TRUE (not exactly true)', { ...DEV_OK, WORKER_API_ENABLED: 'TRUE' }, /WORKER_API_ENABLED/],
  ['without a seal key', { ...DEV_OK, WORKER_SECRET_SEAL_KEY: undefined }, /64 hex/],
  ['with a short seal key', { ...DEV_OK, WORKER_SECRET_SEAL_KEY: 'abcd' }, /64 hex/],
]) {
  const cleaned = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleaned[k] = v;
  const r = devapi(cleaned);
  if (r.code === 2 && expect.test(r.out)) ok(`refuses to start ${name}`);
  else bad(`started ${name}`, `exit ${r.code}: ${r.out.slice(0, 160)}`);
}

// Every provider credential must block startup on its own, because any one of them being present
// means this file is running somewhere it should not be.
const PROVIDERS = ['RESEND_API_KEY', 'TWILIO_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'APOLLO_API_KEY', 'LINKEDIN_ACCESS_TOKEN', 'ALGOLIA_API_KEY', 'GOOGLE_REFRESH_TOKEN',
  'ABIOZEN_DATABASE_URL'];
const notRefused = [];
for (const v of PROVIDERS) {
  const r = devapi({ ...DEV_OK, [v]: 'x' });
  if (!(r.code === 2 && /provider credential/.test(r.out))) notRefused.push(v);
}
if (notRefused.length === 0) {
  ok(`refuses to start with ANY of the ${PROVIDERS.length} provider credentials present`);
} else bad(`${notRefused.length} provider credential(s) do not block startup`, notRefused.join(', '));

// ANTI-VACUITY. A correct dev environment must get past every guard above and fail only on the
// database connection, which is a different failure. Without this, a file that refused everything
// would pass — and would make the dev environment impossible to stand up.
const good = devapi(DEV_OK);
if (good.code !== 2) {
  ok('control: a correct development configuration clears every refusal');
} else bad('a correct development configuration was refused, so the dev API cannot be started',
  good.out.slice(0, 200));

// ── 2c. THE CONTAINMENT SEED ────────────────────────────────────────────────
head('2c. m7-dev-seed-containment.js will not touch production');

const SEED = path.join(REPO, 'scripts', 'm7-dev-seed-containment.js');
function seed(extra = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
  const r = spawnSync(process.execPath, [SEED], { env, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
for (const [name, env, expect] of [
  ['the production Postgres',
    { DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway', M7_5_DEV_CONFIRM: 'yes' },
    /production database/],
  ['the Abiozen production DB',
    { DATABASE_URL: 'postgresql://u:p@interchange.proxy.rlwy.net:18553/railway', M7_5_DEV_CONFIRM: 'yes' },
    /production database/],
  ['an unconfirmed database', { DATABASE_URL: 'postgresql://u:p@127.0.0.1:59998/devdb' }, /M7_5_DEV_CONFIRM/],
]) {
  const r = seed(env);
  if (r.code === 2 && expect.test(r.out)) ok(`refuses ${name}`);
  else bad(`did not refuse ${name}`, `exit ${r.code}: ${r.out.slice(0, 160)}`);
}

// The seed's whole purpose is one workflow stop per cron and NO global stop, because a global stop
// would halt the worker. Pinned here as source structure, since the behaviour needs a database.
const seedSrc = LEX.blankCommentsOnly(require('fs').readFileSync(SEED, 'utf8'));
if (/scope_type='workflow'|'workflow', \$1/.test(seedSrc) && !/VALUES \('global'/.test(seedSrc)) {
  ok('it writes workflow stops and never a global stop');
} else bad('the seed writes a global stop, which would halt the worker it exists to enable');
if (/Object\.keys\(autonomy\.CRON_SCOPES\)/.test(seedSrc)) {
  ok('and the cron list is generated from autonomy.CRON_SCOPES, not typed');
} else bad('the cron list is hand-maintained and will drift silently when a cron is added');

// ── 3. NO TLS BYPASS ANYWHERE IN EITHER SCRIPT ──────────────────────────────
head('3. neither script can disable certificate verification');

const fs = require('fs');
let bypasses = 0;
for (const f of ['scripts/m7-5-dev-driver.js', 'scripts/m7-5-acceptance.sh']) {
  const raw = fs.readFileSync(path.join(REPO, f), 'utf8');
  // Comments explain the rule, so strip them before looking for a violation of it. Shell STRING
  // literals are deliberately NOT stripped: this scanner cannot tell a string from a command, and
  // a scanner that guesses in that direction is the one that misses the real thing. The cost is
  // that the scripts may not QUOTE a forbidden flag in their own prose, which is a fine price.
  const code = f.endsWith('.js') ? LEX.blankCommentsOnly(raw) : raw.replace(/^\s*#.*$/gm, '');
  for (const t of ['NODE_TLS_REJECT_UNAUTHORIZED=0', 'rejectUnauthorized: false',
    'rejectUnauthorized:false', '--insecure', 'curl -k', ' -k ']) {
    if (code.includes(t)) { bypasses += 1; bad(`${f} contains a TLS bypass: ${t}`); }
  }
}
// Only claimed when nothing was found. An unconditional "ok" after a loop that can fail is the
// 2026-09-30 defect in miniature: a verdict printed beside the failure it was meant to report.
if (bypasses === 0) ok('no TLS bypass in either script');

// The acceptance script must actively ASSERT verification is on, not merely avoid turning it off.
const acceptSrc = fs.readFileSync(ACCEPT, 'utf8');
if (/verify_return_error/.test(acceptSrc) && /rejectUnauthorized:\s*true/.test(acceptSrc)) {
  ok('and it positively asserts verification: openssl -verify_return_error and node rejectUnauthorized: true');
} else bad('the acceptance script does not positively verify the certificate chain');
if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(acceptSrc)) {
  ok('and it checks that verification was not disabled in the operator\'s environment');
} else bad('it does not check the operator environment for a disabled-TLS setting');

// ── 4. THE DRIVER CLEANS UP BY ID ───────────────────────────────────────────
head('4. the driver deletes only what it created, by id');

const driverSrc = LEX.blankCommentsOnly(fs.readFileSync(DRIVER, 'utf8'));
for (const forbidden of [
  ["INTERVAL", 'a time-window DELETE'],
  ["LIKE '%", 'a pattern DELETE'],
]) {
  const [needle, what] = forbidden;
  const deletes = driverSrc.split('\n').filter((l) => /DELETE FROM/i.test(l) && l.includes(needle));
  if (deletes.length) bad(`cleanup uses ${what}`, deletes[0].trim());
}
// Two accepted shapes, both naming a RECORDED identity, and nothing else:
//   WHERE <col> = $1                          — a surrogate key (worker_tasks.id, agent_runs.intent_key)
//   WHERE scope_type = $1 AND scope_key = $2  — autonomy_stops, whose PRIMARY KEY is those two columns
// The second is listed explicitly rather than by loosening the first into "any WHERE with a
// placeholder". A rule relaxed to accommodate one table stops catching the thing it was written for.
const KEYED = /WHERE\s+\w+\s*=\s*\$1\s*$/i;
const KEYED_COMPOSITE = /WHERE\s+scope_type\s*=\s*\$1\s+AND\s+scope_key\s*=\s*\$2\s*$/i;
const deleteLines = driverSrc.split('\n')
  .map((l) => l.replace(/`.*$/, (m) => m))       // keep the line as written
  .filter((l) => /DELETE FROM/i.test(l));
const unkeyed = deleteLines.filter((l) => {
  const sql = (l.match(/DELETE FROM[^`]*/i) || [''])[0].trim();
  return !KEYED.test(sql) && !KEYED_COMPOSITE.test(sql);
});
if (deleteLines.length && unkeyed.length === 0) {
  ok(`all ${deleteLines.length} DELETE statements name a recorded identity`);
} else if (!deleteLines.length) {
  bad('no DELETE statements found at all — the cleanup this check exists to police has moved');
} else bad(`${unkeyed.length} DELETE statement(s) are not keyed to a recorded identity`, unkeyed[0].trim());

if (/COUNT\(\*\)::int n FROM worker_tasks WHERE id = \$1/.test(driverSrc)) {
  ok('and it verifies its own fixtures are gone, not that the tables are empty');
} else bad('cleanup does not verify its fixtures by id');

if (!/COUNT\(\*\)[^\n]*FROM (worker_tasks|autonomy_stops)\s*`\s*\)/.test(driverSrc)) {
  ok('no unqualified table count is asserted anywhere');
} else bad('an absolute table count is asserted — true only until the product is used');

console.log();
if (fail) { console.log(`FAIL  ${fail} M7.5 guard(s) do not hold.`); process.exit(1); }
console.log('PASS  both M7.5 scripts refuse production by host, refuse an unconfirmed database,');
console.log('      refuse to fake hardware evidence, cannot disable certificate verification, and');
console.log('      clean up only their own fixtures by id — while still admitting a real');
console.log('      development target, which is what makes the refusals usable rather than absolute.');
process.exit(0);
