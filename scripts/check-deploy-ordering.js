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

// ── WHY THIS ASSERTS A PROPERTY AND NOT A FILENAME ──────────────────────────
//
// This check used to require the literal `scripts/migrate.js`, and gave the real reason in its own
// failure message: that file "reads MIGRATION_DATABASE_URL in preference to DATABASE_URL — that
// preference is what makes the migration run as the migrator and the application run as the
// least-privilege role."
//
// So the filename was a PROXY for a property, and on 2026-11-11 the proxy became wrong. The S2
// release needs exactly one schema change, and `migrate.js` applies it along with 53 other steps
// and THREE SEEDS — one of which, seedMoleculePricing(), INSERTs into molecule_pricing, the table
// every quotation is priced from. runAll also upserts the company row. Neither belongs in an
// automatic deploy step.
//
// The property is now checked directly: whatever preDeployCommand names must prefer
// MIGRATION_DATABASE_URL, must not reach the seeds, and must not upsert company data. A migration
// entry point that satisfies those is acceptable whatever it is called; `migrate.js` itself is
// acceptable WITH --no-seeds, and unacceptable without it.
const MIGRATION_ENTRY = /scripts\/(migrate[a-z0-9-]*\.js)/;

function preRunsAMigration(pre) {
  return pre.some((c) => MIGRATION_ENTRY.test(String(c)));
}

// Faults in what the configured command would actually DO. Read from the named file, not assumed.
function preMigrationFaults(pre) {
  const faults = [];
  for (const cmd of pre.map(String)) {
    const m = MIGRATION_ENTRY.exec(cmd);
    if (!m) continue;
    const file = path.join(__dirname, m[1]);
    if (!fs.existsSync(file)) {
      faults.push({ what: `preDeployCommand names ${m[1]}, which does not exist`,
        why: 'a deploy would fail at the pre-deploy step with MODULE_NOT_FOUND' });
      continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

    if (!/MIGRATION_DATABASE_URL/.test(code)) {
      faults.push({ what: `${m[1]} does not read MIGRATION_DATABASE_URL`,
        why: 'that preference is what lets the migration hold DDL while the application runs as '
          + 'the least-privilege role' });
    }
    // THE SEEDS. runAll seeds unless --no-seeds is passed, and seedMoleculePricing() writes to
    // molecule_pricing — business data, on every deploy.
    const reachesRunAll = /require\(.*migrate-all|runAll/.test(code);
    if (reachesRunAll && !/--no-seeds/.test(cmd)) {
      faults.push({ what: `${m[1]} reaches runAll and the command omits --no-seeds (${cmd})`,
        why: 'every deploy would run seedMoleculePricing(), which INSERTs into molecule_pricing — '
          + 'the table every quotation is priced from — and ensureCompany(), which upserts the '
          + 'company row. Business data must not be written by an automatic deploy step.' });
    }
    if (/ensureCompany/.test(code) && !reachesRunAll) {
      faults.push({ what: `${m[1]} upserts the company row directly`,
        why: 'an automatic deploy step must not write company data' });
    }
  }
  return faults;
}

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
    } else if (!preRunsAMigration(pre)) {
      bad(`deploy.preDeployCommand does not run a migration entry point (${JSON.stringify(pre)})`,
        'it must name a scripts/migrate*.js file');
    } else if (preMigrationFaults(pre).length) {
      for (const f of preMigrationFaults(pre)) bad(f.what, f.why);
    } else {
      ok(`deploy.preDeployCommand runs a bounded migration: ${JSON.stringify(pre)}`);
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
