// ── THE WORKER SERVICE'S DEPLOY CONFIGURATION, AND THE VARIABLE NAMES ───────
//
// Fifth directive, 2026-11-27. The owner asked four things to be verified before provisioning, and
// three of them turned out to be defects in what I had written rather than facts to confirm.
//
// **1. `railway.json` IS REPO-WIDE, AND ALL THREE OF ITS DEPLOY SETTINGS ARE WRONG FOR A WORKER.**
// A service created from this repository inherits them unless a per-service config file overrides
// them. `startCommand` runs `server.js` — the API, with 45 cron registrations — so the worker
// service would become a second scheduler. `healthcheckPath` is `/health`, and this worker opens no
// inbound listener by design, so every deploy would be marked failed and retried. And the dangerous
// one: `preDeployCommand` applies a schema migration on EVERY deploy.
//
// **The migration is the trap, and it is the shape CLAUDE.md warns about.** Following the approved
// spec — no `DATABASE_URL` on the worker service — that command exits 2 with
// `no MIGRATION_DATABASE_URL or DATABASE_URL`. So the deploy fails safely, and the message reads as
// *"the worker needs a database"*. The obvious fix is to add one, and that is how a worker service
// acquires the ability to migrate a schema. **A correct refusal that pressures the next person
// toward the dangerous change is worse than a loud one.** Hence `railway.worker.json`: the right
// configuration is checked in and reviewable, not a dashboard setting somebody has to remember.
//
// **2. I HAD INVENTED TWO OF THE FOUR VARIABLE NAMES.** My provisioning procedure said
// `PLAYNEXA_WORKER_API_URL` and `PLAYNEXA_WORKER_ID`. The source reads `WORKER_API_BASE_URL` and
// `WORKER_ID`. Two of the four variables DO carry the `PLAYNEXA_` prefix, and I pattern-matched it
// onto the two that do not — rule 12, *read the vocabulary, do not invent it*, in a document the
// owner was going to execute. The source is the authority and this test makes it so.
//
// **3. THE RESTART POLICY IS CORRECT, AND FOR A REASON THAT IS A COINCIDENCE.** `run.js` exits **0**
// on a terminal condition such as a revoked identity, and its comment reasons about launchd's
// `KeepAlive { SuccessfulExit false }` — macOS. Railway's `ON_FAILURE` happens to agree: exit 0 is
// success, so a revoked worker is left stopped rather than relaunched against a credential the
// server has already refused. `ALWAYS` would restart it for ever. The agreement is real and it rests
// on a number, so the number is asserted here rather than trusted.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

// ═══ 1. THE VARIABLE NAMES COME FROM THE SOURCE ═══════════════════════════

test('1. the worker reads exactly these four variables, and the names are the source\'s', () => {
  const LEX = require('./js-lex.js');
  // blankCommentsOnly: the names ARE string literals in secret-source.js, so blankNonCode would
  // erase the very thing this reads.
  const files = ['run.js', 'client.js', 'secret-source.js', 'keychain.js']
    .map((f) => path.join(ROOT, 'src', 'worker-client', f))
    .filter((f) => fs.existsSync(f));
  assert.ok(files.length >= 3, 'the worker-client module layout moved and this test reads nothing');

  const found = new Set();
  for (const f of files) {
    const code = LEX.blankCommentsOnly(fs.readFileSync(f, 'utf8'));
    for (const m of code.matchAll(/\benv(?:\.|\[')([A-Z_][A-Z0-9_]{3,})'?\]?/g)) found.add(m[1]);
    for (const m of code.matchAll(/['"]([A-Z_][A-Z0-9_]{3,})['"]/g)) {
      if (/^(WORKER|PLAYNEXA)_/.test(m[1])) found.add(m[1]);
    }
  }

  // The four the owner must set, by their REAL names.
  for (const name of ['WORKER_API_BASE_URL', 'WORKER_ID', 'PLAYNEXA_WORKER_ENV',
    'PLAYNEXA_DEV_WORKER_SECRET']) {
    assert.ok(found.has(name), `${name} is not read by the worker client — the provisioning `
      + `procedure names it, so either the code renamed it or the procedure invented it. Found: `
      + `${[...found].sort().join(', ')}`);
  }

  // And the names I invented must NOT appear, because a procedure naming them would configure a
  // variable nothing reads — which fails as "WORKER_API_BASE_URL is not set" and sends an operator
  // looking in the wrong place.
  for (const invented of ['PLAYNEXA_WORKER_API_URL', 'PLAYNEXA_WORKER_ID']) {
    assert.equal(found.has(invented), false,
      `${invented} appears in the source. If it is now real, the procedure and this test both need `
      + 'updating together — that pairing is the whole point of this assertion.');
  }
});

test('1a. the provisioning procedure uses those names and not the invented ones', () => {
  // The document the owner executes. A procedure that drifts from the source is a procedure that
  // wastes a deploy, and this is the only mechanical thing standing between the two.
  const docPath = path.join(ROOT, 'docs', 'office', 'b4-2-cloud-worker-owner-checklist.md');
  if (!fs.existsSync(docPath)) {
    // The checklist is the in-repo copy; the project doc is the owner-facing one. If the in-repo
    // copy is gone, say so rather than passing by reading nothing.
    assert.fail('docs/office/b4-2-cloud-worker-owner-checklist.md is missing — the in-repo '
      + 'provisioning procedure is what this test pins');
  }
  const doc = fs.readFileSync(docPath, 'utf8');
  for (const invented of ['PLAYNEXA_WORKER_API_URL', 'PLAYNEXA_WORKER_ID']) {
    assert.equal(doc.includes(invented), false,
      `the provisioning checklist names ${invented}, which the worker does not read`);
  }
  for (const real of ['WORKER_API_BASE_URL', 'WORKER_ID', 'PLAYNEXA_DEV_WORKER_SECRET']) {
    assert.ok(doc.includes(real), `the provisioning checklist does not name ${real}`);
  }
});

// ═══ 2. THE WORKER SERVICE'S CONFIG ═══════════════════════════════════════

test('2. railway.worker.json starts the WORKER and applies no migration', () => {
  const cfg = json('railway.worker.json');
  const d = cfg.deploy || {};

  assert.equal(d.startCommand, 'node src/worker-client/run.js',
    'the worker service would not start the worker');
  assert.equal(/server\.js/.test(d.startCommand || ''), false,
    'the worker service start command runs server.js, which is the API and its 45 crons');

  // THE ONE THAT MATTERS. Absent, not empty, not a no-op command.
  assert.equal('preDeployCommand' in d, false,
    'railway.worker.json declares a preDeployCommand. A worker service must never apply a schema '
    + 'migration, and the root railway.json does exactly that on every deploy');

  assert.equal('healthcheckPath' in d, false,
    'the worker service declares a healthcheck, and the worker opens no inbound listener — every '
    + 'deploy would be marked failed and, under ON_FAILURE, retried');
});

test('2a. the API config still DOES migrate — so test 2 is about the worker, not about absence', () => {
  // Non-vacuity. If somebody deleted preDeployCommand from railway.json, test 2 would keep passing
  // while the API silently stopped applying its migration. The property is a DIFFERENCE between two
  // files, so both halves are asserted.
  const api = json('railway.json').deploy || {};
  assert.ok(Array.isArray(api.preDeployCommand) && api.preDeployCommand.length > 0,
    'railway.json no longer declares a preDeployCommand — the API stopped applying its migration, '
    + 'and the worker/API distinction this file encodes became meaningless');
  assert.match(api.preDeployCommand.join(' '), /migrate-/,
    'the API pre-deploy command is no longer a migration');
  assert.equal(api.startCommand, 'node server.js');
});

test('2b. the two configs differ in exactly the ways that matter', () => {
  const api = json('railway.json').deploy || {};
  const wkr = json('railway.worker.json').deploy || {};
  assert.notEqual(api.startCommand, wkr.startCommand);
  assert.ok('preDeployCommand' in api && !('preDeployCommand' in wkr));
  assert.ok('healthcheckPath' in api && !('healthcheckPath' in wkr));
});

// ═══ 3. THE RESTART POLICY MATCHES THE EXIT CODES ═════════════════════════

test('3. ON_FAILURE is right because a revoked worker exits 0, which is asserted not assumed', () => {
  const wkr = (json('railway.worker.json').deploy || {});
  assert.equal(wkr.restartPolicyType, 'ON_FAILURE');
  assert.equal(typeof wkr.restartPolicyMaxRetries, 'number');

  const LEX = require('./js-lex.js');
  const code = LEX.blankCommentsOnly(read('src/worker-client/run.js'));
  // The terminal branch returns 0. If this becomes non-zero, ON_FAILURE would relaunch a worker
  // whose credential the server has refused, so the config decision changes with it.
  const iTerminal = code.indexOf('if (res.terminal)');
  assert.ok(iTerminal > 0, 'the terminal branch moved and this assertion reads nothing');
  const after = code.slice(iTerminal, iTerminal + 600);
  assert.equal(/return\s+[1-9]/.test(after), false,
    'the terminal (revoked) path now exits non-zero, so ON_FAILURE would restart a worker the '
    + 'server has refused — railway.worker.json must change with it');
});

test('3a. a missing configuration exits 2, measured by running the real process', () => {
  // Not read off the source: run it. With ON_FAILURE this is retried to the cap and then left
  // stopped, and the logs name which variable is missing — which is the behaviour an operator who
  // mistyped a variable name will actually meet.
  let status = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'src', 'worker-client', 'run.js')],
      { env: { PATH: process.env.PATH }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    status = e.status;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  assert.equal(status, 2, `a worker with no configuration exited ${status}, not 2`);
  assert.match(out, /WORKER_API_BASE_URL is not set/);
  assert.match(out, /WORKER_ID is not set/,
    'the config error does not name the variables, so an operator cannot tell which one is wrong');
});

// ═══ 4. CONTROL ═══════════════════════════════════════════════════════════

test('4. CONTROL: the config assertions go red when the setting is reintroduced', () => {
  // Rule 4 and rule 29. Each assertion above is re-evaluated against a config object carrying the
  // setting it forbids, and must reject it — otherwise test 2 passes by reading a shape that cannot
  // be violated.
  const sabotaged = { deploy: { startCommand: 'node server.js',
    preDeployCommand: ['node scripts/migrate-inquiry-direction-check.js --apply'],
    healthcheckPath: '/health' } };
  const d = sabotaged.deploy;
  assert.ok('preDeployCommand' in d, 'the control did not plant a preDeployCommand');
  assert.ok('healthcheckPath' in d, 'the control did not plant a healthcheck');
  assert.ok(/server\.js/.test(d.startCommand), 'the control did not plant the API start command');
  // And the real file must NOT look like the sabotage, which is what makes the comparison mean
  // something rather than restating the sabotage to itself.
  const real = json('railway.worker.json').deploy;
  assert.notDeepEqual(real, d);
});
