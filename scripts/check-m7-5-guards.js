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

// ── A PLATFORM GATE MUST BE TESTABLE ON BOTH PLATFORMS ──────────────────────
//
// `fakeUname` puts a one-line `uname` ahead of the real one on PATH, so the gate's own conditional
// — `[ "$(uname -s)" != "Darwin" ]` — executes for real against an answer this file chooses.
//
// It exists because the clause below used to run the script UNSTUBBED and assert that the gate
// fired. That can only hold on a non-Darwin host. The variable was even called `onLinux`. On the
// office iMac on 2026-11-18 it failed — so `preflight.sh` could never exit 0 on the one machine
// whose evidence the gate exists to protect, and the only check that could not pass there was the
// check about hardware evidence. Every sibling clause already neutralised the gate to reach what
// it wanted to test; this one depended on the build machine's identity instead.
function fakeUname(kernel) {
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'm75-uname-'));
  const p = path.join(dir, 'uname');
  // Answers -s with the requested kernel and -m with something plausible, because a shim that
  // only handles the exact flag under test breaks the moment the script asks anything else.
  fs.writeFileSync(p, `#!/bin/sh\ncase "\${1:-}" in\n  -m) echo x86_64 ;;\n  *) echo ${kernel} ;;\nesac\n`);
  fs.chmodSync(p, 0o755);
  return dir;
}

/** Runs the acceptance script. `unameAs` shims the kernel so the Darwin gate can be exercised from
 *  either platform; `stubDarwin` neutralises that one line so the guards AFTER it can be reached. */
function accept(baseUrl, { stubDarwin = false, unameAs = null } = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (baseUrl !== undefined) env.WORKER_API_BASE_URL = baseUrl;
  if (unameAs) env.PATH = `${fakeUname(unameAs)}:${env.PATH}`;
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

// ── WHAT A HOSTNAME CAN AND CANNOT SETTLE ──────────────────────────────────
//
// `postgres.railway.internal` used to be on this list and is deliberately gone. Railway's private
// DNS is project-scoped, so inside playnexa-m7-dev that name is the DEVELOPMENT database — blocking
// it forced the only available workaround, giving the dev database a public internet address.
// A hostname also says nothing about a dev database RESTORED FROM production.
//
// So the list keeps only hosts that are publicly reachable AND unambiguously production, and
// scripts/lib/db-identity.js answers the real question by asking the database what it holds.
// check-db-identity-db.js covers that; this covers what remains name-blockable.
const PROD_DBS = [
  ['postgresql://u:p@interchange.proxy.rlwy.net:18553/railway', 'the Abiozen Django production DB'],
  ['postgresql://u:p@replica.interchange.proxy.rlwy.net:18553/railway', 'a subdomain of it'],
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

// Runs on macOS and on Linux alike: the kernel is a shim, not the host.
const asForeign = accept('https://dev-playnexa.example.com', { unameAs: 'Linux' });
if (asForeign.code === 2 && /not Darwin/.test(asForeign.out)) {
  ok('refuses to run anywhere but macOS — a transcript from Linux is not hardware evidence');
} else {
  bad('the Darwin gate did not fire for a non-Darwin kernel',
    `exit ${asForeign.code}: ${asForeign.out}`);
}

// ── NEGATIVE CONTROL: WOULD WE NOTICE IF THE GATE WERE DELETED? ─────────────
//
// The clause above passes if the script refuses. It would ALSO pass if `uname` shimming silently
// failed and the real Linux host made it refuse for the ordinary reason — which is exactly how the
// old version looked healthy for weeks. So: neutralise the gate line, shim the kernel to Linux,
// and require that it now gets PAST the host check. If this fails, the clause above is measuring
// the build machine rather than the guard.
const gateRemoved = accept('https://dev-playnexa.example.com', { stubDarwin: true, unameAs: 'Linux' });
if (gateRemoved.code !== 2 || !/not Darwin/.test(gateRemoved.out)) {
  ok('control: with that one line removed it gets past the host check, so the clause above is '
    + 'testing the gate and not the host');
} else {
  bad('the host check still fired with its own line neutralised',
    'the Darwin refusal above cannot be attributed to the gate — it may be the real host. '
    + `exit ${gateRemoved.code}: ${gateRemoved.out}`);
}

// And the shim itself must be load-bearing: claiming Darwin on a Linux host has to clear the gate.
const asDarwin = accept('https://dev-playnexa.example.com', { unameAs: 'Darwin' });
if (!/not Darwin/.test(asDarwin.out)) {
  ok('control: the uname shim is effective — claiming Darwin clears the host check');
} else {
  bad('the uname shim is not on PATH ahead of the real uname',
    `the gate still saw a non-Darwin kernel. exit ${asDarwin.code}: ${asDarwin.out}`);
}

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
// The control, re-pointed. A correct configuration must clear every STATIC refusal — the marker,
// the activation flag, the seal key, the provider-credential scan and the host list — and then stop
// at the database identity stage, because the URL here points at nothing. Reaching that stage is
// the proof: it means nothing earlier rejected it.
//
// Asserting `code !== 2` no longer works and must not be restored: an unreachable database is now
// `cannot_tell`, which is a refusal, so exit 2 is correct here. What distinguishes a good config is
// WHICH refusal it reaches.
const good = devapi(DEV_OK);
const reachedIdentity = /could not be positively identified as development|cannot_tell/.test(good.out);
const staticRefusal = /M7_DEV_API|WORKER_API_ENABLED|64 hex|provider credential|production database host/
  .test(good.out);
if (reachedIdentity && !staticRefusal) {
  ok('control: a correct development configuration clears every static refusal and reaches the');
  ok('         database identity stage — which is where an unreachable URL should stop it');
} else if (staticRefusal) {
  bad('a correct development configuration was rejected before the identity stage',
    good.out.slice(0, 300));
} else {
  bad('the dev API neither refused nor reached the identity stage', good.out.slice(0, 300));
}

// ── 2c. THE CONTAINMENT SEED ────────────────────────────────────────────────
head('2c. m7-dev-seed-containment.js will not touch production');

const SEED = path.join(REPO, 'scripts', 'm7-dev-seed-containment.js');
function seed(extra = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
  const r = spawnSync(process.execPath, [SEED], { env, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
for (const [name, env, expect] of [
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
// A batched delete over a RECORDED list of ids. Added when cleanup had to delete agent_run_events
// before agent_runs — that FK has no ON DELETE CASCADE, and a row-at-a-time delete over two
// parent tables is both slower and harder to read than one keyed by the list.
//
// The list is not taken on trust. `= ANY($1)` counts as keyed only when the statement's parameter
// is drawn from `made.` — the record of what this run created. A delete keyed to a local variable
// the guard cannot trace is NOT accepted, because "it was derived from recorded ids" is a claim
// about code the guard has not read, and that is precisely the kind of claim this file exists to
// stop taking at face value.
const KEYED_ANY = /WHERE\s+\w+\s*=\s*ANY\(\$1\)\s*$/i;
const RECORDED_PARAM = /\[\s*made\.\w+\s*\]/;
const deleteLines = driverSrc.split('\n')
  .map((l) => l.replace(/`.*$/, (m) => m))       // keep the line as written
  .filter((l) => /DELETE FROM/i.test(l));
const unkeyed = deleteLines.filter((l) => {
  const sql = (l.match(/DELETE FROM[^`]*/i) || [''])[0].trim();
  if (KEYED.test(sql) || KEYED_COMPOSITE.test(sql)) return false;
  if (KEYED_ANY.test(sql)) return !RECORDED_PARAM.test(l);
  return true;
});
if (deleteLines.length && unkeyed.length === 0) {
  ok(`all ${deleteLines.length} DELETE statements name a recorded identity`);
} else if (!deleteLines.length) {
  bad('no DELETE statements found at all — the cleanup this check exists to police has moved');
} else bad(`${unkeyed.length} DELETE statement(s) are not keyed to a recorded identity`, unkeyed[0].trim());

// Either keyed shape satisfies this: what matters is that the verification names the fixtures,
// never that a table is empty. The requirement is the WHERE clause, not the operator in it.
if (/COUNT\(\*\)::int n FROM worker_tasks WHERE id = (?:\$1|ANY\(\$1\))/.test(driverSrc)) {
  ok('and it verifies its own fixtures are gone, not that the tables are empty');
} else bad('cleanup does not verify its fixtures by id');

// Added 2026-11-20. The cleanup wrote four tables and verified two, over an empty catch, and
// reported success — so the per-table rule is now enforced here as well as in the regression
// suite. A guard that checks only the tables somebody remembered to list is the same defect.
{
  const body = driverSrc.slice(driverSrc.indexOf('async function cleanup() {'),
    driverSrc.indexOf('\nasync function setStop'));
  const written = new Set([...body.matchAll(/DELETE FROM ([a-z_]+)/g)].map((m) => m[1]));
  const checked = new Set([...body.matchAll(/survivors\('([a-z_]+)'/g)].map((m) => m[1]));
  const missing = [...written].filter((t) => !checked.has(t));
  if (written.size && !missing.length) {
    ok(`every table cleanup writes (${written.size}) is also verified by id`);
  } else if (!written.size) {
    bad('cleanup appears to delete nothing — this check has lost its subject');
  } else bad(`${missing.length} table(s) are deleted from but never verified`, missing.join(', '));

  if (/catch\s*\(\s*_\s*\)\s*\{\s*\}/.test(body)) {
    bad('cleanup swallows an exception', 'the agent_runs FK failure hid behind exactly this');
  } else ok('and no cleanup exception is swallowed');
}

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
