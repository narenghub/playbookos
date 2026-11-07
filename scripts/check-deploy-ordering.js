// ── THE MIGRATION MUST RUN BEFORE THE NEW CONTAINER SERVES ───────────────────────────────────────
//
//   node scripts/check-deploy-ordering.js ; echo $?
//
// Push to `main` auto-deploys on Railway. Before this file existed there was no railway.json and
// `start` was a bare `node server.js`, so a merge to main would build the new release and start it
// with NO migration ahead of it. With ENG-003's least-privilege role in place that is not a
// half-migrated database serving traffic — `playbookos_app` cannot perform DDL at all, and
// src/lib/schema-ready.js refuses to start rather than attempting it — but it is still a release
// whose outcome depends on a race nobody chose.
//
// So the ordering is declared in railway.json as a PRE-deploy step, which runs before the container
// is started.
//
// WHAT THIS CHECK DOES NOT CLAIM. Railway's documentation describes preDeployCommand only as "the
// command to run before starting the container". It does NOT document what happens when that
// command exits non-zero — whether the deploy is abandoned, and whether the previous deployment
// keeps serving. That behaviour was not verifiable from the documentation, so the release sequence
// does not depend on it: for the controlled release, auto-deploy is turned OFF and the deploy is
// triggered by hand after reconciliation and migration have finished. preDeployCommand is
// defence-in-depth for every ORDINARY push afterwards, not the control that makes the release safe.
//
// The second assertion matters as much as the first. If the migration were chained into the start
// command (`node scripts/migrate.js && node server.js`) it would run inside the serving container
// on every restart, including crash restarts — a schema change racing an unknown number of parallel
// replicas. A pre-deploy step runs once per deploy. It is also the rule from CLAUDE.md: a
// verification (or a migration) and the thing that follows it are separate decisions, not one `&&`
// chain.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };

console.log(`\n${'─'.repeat(78)}\nDEPLOY ORDERING — migration before the container serves\n${'─'.repeat(78)}`);

const cfgPath = path.join(ROOT, 'railway.json');
if (!fs.existsSync(cfgPath)) {
  bad('railway.json is missing',
    'without it the deploy has no declared pre-deploy step and a merge to main starts the new '
    + 'release with no migration ahead of it');
} else {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {
    bad('railway.json is not valid JSON', e.message);
  }

  if (cfg) {
    const deploy = cfg.deploy || {};
    const pre = deploy.preDeployCommand;

    // Railway's reference gives this as an array of strings.
    if (!Array.isArray(pre) || !pre.length) {
      bad('deploy.preDeployCommand is absent or not a non-empty array',
        'Railway\'s config reference gives this field as an array of strings, e.g. ["node scripts/migrate.js"]');
    } else if (!pre.some((c) => /scripts\/migrate\.js/.test(String(c)))) {
      bad(`deploy.preDeployCommand does not run scripts/migrate.js (${JSON.stringify(pre)})`,
        'migrate.js is the entry point that reads MIGRATION_DATABASE_URL in preference to '
        + 'DATABASE_URL — that preference is what makes the migration run as the migrator and the '
        + 'application run as the least-privilege role');
    } else {
      ok(`deploy.preDeployCommand runs the migration: ${JSON.stringify(pre)}`);
    }

    // The healthcheck is what makes a started-but-broken container visible. /health returns the
    // deployed commit, which is what wait-for-deploy.sh reads.
    if (deploy.healthcheckPath) ok(`healthcheckPath is set: ${deploy.healthcheckPath}`);
    else bad('deploy.healthcheckPath is not set', 'a container that starts broken would be indistinguishable from one that works');

    // And the migration must NOT be inside the start command.
    const start = String(deploy.startCommand || '');
    if (/migrate/.test(start)) {
      bad(`deploy.startCommand contains a migration: ${JSON.stringify(start)}`,
        'that runs the schema change inside the serving container on every restart, including '
        + 'crash restarts, racing however many replicas are up. It belongs in preDeployCommand');
    } else if (start) {
      ok(`deploy.startCommand starts the server only: ${JSON.stringify(start)}`);
    }
  }
}

// Same assertion against package.json, because `start` is what Railway falls back to.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const startScript = String((pkg.scripts || {}).start || '');
if (/migrate/.test(startScript)) {
  bad(`package.json "start" contains a migration: ${JSON.stringify(startScript)}`,
    'a migration in the start script runs on every container restart');
} else {
  ok(`package.json "start" starts the server only: ${JSON.stringify(startScript)}`);
}

// migrate.js must exist and must be the credential-aware entry point, or the pre-deploy step above
// points at nothing.
const migratePath = path.join(ROOT, 'scripts', 'migrate.js');
if (!fs.existsSync(migratePath)) {
  bad('scripts/migrate.js does not exist', 'the pre-deploy command points at a missing file');
} else {
  const src = fs.readFileSync(migratePath, 'utf8');
  if (/MIGRATION_DATABASE_URL/.test(src)) ok('scripts/migrate.js reads MIGRATION_DATABASE_URL — the migration can use its own credentials');
  else bad('scripts/migrate.js does not mention MIGRATION_DATABASE_URL', 'the migration would run as whatever the application runs as');
}

console.log(`\n${'─'.repeat(78)}`);
if (fail) {
  console.log(`FAIL  ${fail} finding(s). The deploy ordering is not declared. Do not push.\n`);
  process.exit(1);
}
console.log('PASS  the migration is a pre-deploy step, runs with its own credentials, and is not\n'
  + '      chained into the start command.\n');
