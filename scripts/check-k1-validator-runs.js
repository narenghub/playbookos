#!/usr/bin/env node
// ── DOES THE K1 PRODUCTION VALIDATOR PROVE WHAT IT CLAIMS? ──────────────────
//
//   node scripts/check-k1-validator-runs.js    exit 0 = the validator is trustworthy
//
// `validate-k1-deployed.js` runs once against production and its verdict is what decides whether
// K1 becomes PRODUCTION VALIDATED. Three things about it have to be proven before it is believed.
//
//   1. IT WRITES NOTHING DURABLE. It creates two companies, two objectives and several runs to
//      exercise the real constraints — a constraint is a server-side object and nothing
//      off-production can stand in for it — inside a transaction that is deliberately rolled
//      back. A fixture left behind on production could NOT be cleaned up afterwards, because
//      agent_run_events is append-only by trigger. So the rollback is asserted, not assumed.
//
//   2. IT CAN GO RED, for each distinct reason. A validator that cannot fail is a formality. Five
//      independent sabotages, each of which must turn it red: drop the composite FK; downgrade
//      MATCH FULL to MATCH SIMPLE; attribute a historical run to a company; add company_id to a
//      table outside the authorized scope; drop a kernel table.
//
//   3. EVERY REFUSAL WAS INDEPENDENTLY EVALUATED. This is the subtle one. In PostgreSQL a failed
//      statement aborts the transaction, so without a SAVEPOINT around each attempt the first
//      refusal would make every later statement fail with 25P02 "current transaction is aborted"
//      — and a naive validator would score those as refusals too. Nine attacks would report
//      success while only the first was ever tested. This check asserts that ALL NINE refusal
//      lines and ALL FIVE positive controls appear in a green run, which is only possible if the
//      savepoint discipline held and the transaction stayed usable throughout.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 500)}`); };

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/local/bin', '/usr/bin'];
function findInitdb() {
  for (const d of BIN) { const p = path.join(d, 'initdb'); if (fs.existsSync(p)) return d; }
  return null;
}
let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/k1val-');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PGPORT: '55994' };
  const asPostgres = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, stdio: 'pipe' });
  try {
    if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55994 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asPostgres };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55994&sslmode=disable`;
}
function stopTemp() {
  if (!temp) return;
  const env = { ...process.env, PATH: `${temp.dir}:${process.env.PATH}` };
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { env, stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.K1_PG_URL || startTemp();
if (!url) {
  out('  skip  no Postgres available (set K1_PG_URL or install initdb)');
  out('SKIP  K1 validator not executed — this check needs a server');
  process.exit(0);
}
process.env.DATABASE_URL = url;

const REPO = path.join(__dirname, '..');
const { query } = require('../src/lib/db');
const { migrateRuns } = require('../src/lib/runs');
const { migrateOffice } = require('../src/lib/office/schema');

function runValidator() {
  try {
    const stdout = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'validate-k1-deployed.js')],
      { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

const HISTORICAL = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

// The nine ruled refusals and the five positive controls, by the exact label the validator prints.
const REFUSALS = [
  'A objective + B run',
  'A run + B approval',
  'A run + B exception',
  'A run + B cost',
  'A run + B outcome',
  'one-NULL composite-FK evasion',
  'new companyless run naming an objective',
  'new run with a company but no objective',
  'kernel cost filed against a legacy (companyless) run',
];
const POSITIVES = [
  'A cost against A run',
  'A exception against A run',
  'A approval against A run',
  'A outcome against A run',
  'B work against B run',
];

(async () => {
  try {
    await migrateRuns(query);
    await migrateOffice(query);
    // Historical runs, unattributed — exactly the production shape the validator must find.
    for (const id of HISTORICAL) {
      await query(
        `INSERT INTO agent_runs (run_id, root_run_id, trigger, product, state)
         VALUES ($1,$1,'cron','internal','SUCCEEDED') ON CONFLICT DO NOTHING`, [id]);
    }

    // ── 1. GREEN, AND NOTHING DURABLE ─────────────────────────────────────
    const before = (await query(`SELECT COUNT(*)::int n FROM agent_runs`)).rows[0].n;
    const g = runValidator();
    if (g.code !== 0) bad('the validator is RED against a correctly migrated database', (g.stdout + g.stderr).slice(-1200));
    else ok('the validator is GREEN against a correctly migrated database');

    const after = (await query(`SELECT COUNT(*)::int n FROM agent_runs`)).rows[0].n;
    if (after !== before) bad(`the validator left ${after - before} run(s) behind — it must write nothing durable`);
    else ok(`the validator wrote nothing durable (agent_runs ${before} → ${after})`);

    for (const t of ['companies', 'objectives', 'office_cost_ledger', 'office_approvals', 'office_exceptions', 'office_outcomes']) {
      const n = (await query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      if (n) bad(`${t} holds ${n} row(s) after the validator ran — the rollback did not hold`);
    }
    ok('no company, objective or kernel record survived the validator\'s rollback');

    if (!/deliberately ROLLED BACK/.test(g.stdout)) bad('the validator did not assert its own rollback');
    else ok('the validator asserts its own rollback rather than assuming it');

    // ── 2. EVERY REFUSAL INDEPENDENTLY EVALUATED (the 25P02 trap) ─────────
    // Substring match, deliberately NOT a regex. These labels contain '+' and '(' — regex
    // metacharacters — and an earlier version built a pattern from them with only the parentheses
    // escaped, so '+' acted as a quantifier and 7 of 9 present refusals read as missing. A check
    // whose own escaping can silently invert its result is worse than no check.
    // Match PER LINE rather than assuming the label and the verdict are adjacent: two labels
    // carry a parenthetical suffix ("…evasion (objective set, company NULL)"), so a contiguous
    // `label + " — refused"` match reported them missing when they were present.
    const lines = g.stdout.split('\n');
    const refusedLine = (label) => lines.some((l) => l.includes(label) && l.includes('— refused by production'));
    const missing = REFUSALS.filter((r) => !refusedLine(r));
    if (missing.length) {
      bad(`${missing.length} of 9 ruled refusals did not report as independently refused`, missing.join('\n'));
    } else {
      ok('all 9 ruled refusals reported individually — the savepoint discipline held');
    }
    if (/25P02/.test(g.stdout)) bad('the validator reported a 25P02 (aborted transaction) — refusals were not independently evaluated');
    else ok('no aborted-transaction artefact: not one refusal was a 25P02 in disguise');

    const posMissing = POSITIVES.filter((p) => !g.stdout.includes(`positive control: ${p}`));
    if (posMissing.length) bad(`${posMissing.length} of 5 positive controls missing`, posMissing.join('\n'));
    else ok('all 5 same-company positive controls succeeded — the refusals are specific, not blanket');

    // ── 3. IT CAN GO RED, FOR EACH DISTINCT REASON ────────────────────────
    out('  --    sabotage controls: each must turn the validator red');

    const sabotage = async (label, breakIt, fixIt, expect) => {
      await breakIt();
      const r = runValidator();
      if (r.code === 0) bad(`SABOTAGE ${label}: the validator stayed GREEN`);
      else if (expect && !expect.test(r.stdout)) bad(`SABOTAGE ${label}: red, but not for the expected reason`, r.stdout.slice(-700));
      else ok(`SABOTAGE ${label}: the validator goes red${expect ? ', for the right reason' : ''}`);
      await fixIt();
      const back = runValidator();
      if (back.code !== 0) bad(`after repairing "${label}" the validator is still red`, (back.stdout + back.stderr).slice(-700));
    };

    await sabotage('composite FK dropped',
      () => query(`ALTER TABLE agent_runs DROP CONSTRAINT fk_agent_runs_objective_company`),
      () => migrateOffice(query),
      /fk_agent_runs_objective_company is ABSENT|was ACCEPTED by production/);

    await sabotage('MATCH FULL downgraded to MATCH SIMPLE',
      async () => {
        await query(`ALTER TABLE agent_runs DROP CONSTRAINT fk_agent_runs_objective_company`);
        await query(`ALTER TABLE agent_runs ADD CONSTRAINT fk_agent_runs_objective_company
                       FOREIGN KEY (objective_id, company_id) REFERENCES objectives (id, company_id)
                       MATCH SIMPLE NOT VALID`);
      },
      async () => {
        await query(`ALTER TABLE agent_runs DROP CONSTRAINT fk_agent_runs_objective_company`);
        await migrateOffice(query);
      },
      /NOT MATCH FULL|one-NULL composite-FK evasion.*ACCEPTED/s);

    await sabotage('a historical run attributed to a company',
      async () => {
        await query(`INSERT INTO companies (id, slug, display_name) VALUES ('sab-co','sab-co','sab') ON CONFLICT DO NOTHING`);
        // objective_id must come too, or MATCH FULL refuses the mixed state — which is itself a
        // reminder that this sabotage has to be a VALID row to test the validator's ruling-7 check
        // rather than the constraint.
        await query(`INSERT INTO objectives (id, company_id, objective, priority, autonomy_tier, approval_policy, status, created_by)
                     VALUES ('sab-obj','sab-co','s','P3','none','none','active','sab') ON CONFLICT DO NOTHING`);
        await query(`UPDATE agent_runs SET company_id='sab-co', objective_id='sab-obj' WHERE run_id=$1`, [HISTORICAL[0]]);
      },
      async () => {
        await query(`UPDATE agent_runs SET company_id=NULL, objective_id=NULL WHERE run_id=$1`, [HISTORICAL[0]]);
        await query(`DELETE FROM objectives WHERE id='sab-obj'`);
        await query(`DELETE FROM companies WHERE id='sab-co'`);
      },
      /historical run\(s\) carry a company/);

    await sabotage('company_id added to a table outside the authorized scope',
      async () => {
        await query(`CREATE TABLE IF NOT EXISTS k1_sabotage_business (id TEXT PRIMARY KEY, company_id TEXT)`);
      },
      async () => { await query(`DROP TABLE IF EXISTS k1_sabotage_business`); },
      /OUTSIDE the authorized scope carry company_id/);

    await sabotage('a kernel table dropped',
      () => query(`DROP TABLE IF EXISTS office_outcomes`),
      () => migrateOffice(query),
      /office_outcomes DOES NOT EXIST/);

    // ── 4. HISTORICAL ROWS SURVIVED EVERY RUN ─────────────────────────────
    const hist = (await query(
      `SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE company_id IS NOT NULL)::int attributed
         FROM agent_runs WHERE run_id = ANY($1)`, [HISTORICAL])).rows[0];
    if (hist.n !== HISTORICAL.length) bad(`historical fixture runs lost: ${hist.n} of ${HISTORICAL.length}`);
    else if (hist.attributed !== 0) bad(`${hist.attributed} historical fixture run(s) left attributed after the sabotage repair`);
    else ok('historical runs survived every validator run and sabotage, still unattributed');

  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    try { await require('../src/lib/db').pool?.end?.(); } catch (_) {}
    stopTemp();
  }

  out(fail
    ? `\nFAIL  ${fail} assertion(s) failed — the K1 validator is not yet trustworthy`
    : '\nPASS  the K1 validator goes red for each distinct reason, evaluates every refusal independently, and writes nothing durable');
  process.exit(fail ? 1 : 0);
})();
