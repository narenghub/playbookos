#!/usr/bin/env node
// ── REHEARSAL FOR office-validate-governed-ai.js ────────────────────────────
//
//   node scripts/check-governed-ai-validator-runs.js      exit 0 = the validator behaves
//
// The validator it exercises runs against PRODUCTION and buys a real AI call. A defect in it
// either spends money for nothing, writes junk into the control plane, or — worst — reports a
// PASS that was never earned. So it is rehearsed here first, on a throwaway cluster, with the
// provider stubbed.
//
// This is the behavioural half of Rule 7's split: forbidden and failure paths are exercised
// HERE, where a wrong prediction costs nothing. Production then performs only the safe positive
// execution the ruling authorized.
//
// Four properties, and the last two matter most:
//
//   1. a matching objective → PASS, with durable cost evidence attributed to company, objective,
//      run, workflow and agent, the fixture cancelled, and the approved objective still draft
//   2. the validator's own assertions can go RED — a stub that returns no usage but a known cost
//      must be caught as a fabricated number rather than passed
//   3. a MISMATCHED stored objective → STOP, exit 1, AND NO PROVIDER CALL AT ALL
//   4. a second run → no second AI call and no second cost row
//
// Property 3 is the one that protects production data and property 4 is the one that protects the
// card: `railway ssh` has failed five distinct ways, and every one of them invites a re-run.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  // The TAIL, not the head: a script that dies does it at the end, and the head is the banner.
  if (d) console.log(String(d).split('\n').slice(-22).map((l) => `          ${l}`).join('\n'));
};

// ── a throwaway cluster, same pattern as the other harnesses ────────────────
const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/lib/postgresql/14/bin',
  '/usr/pgsql-16/bin', '/opt/homebrew/opt/postgresql@16/bin', '/usr/local/opt/postgresql@16/bin'];
function pgBin() {
  for (const d of BIN) if (fs.existsSync(path.join(d, 'initdb'))) return d;
  try { return path.dirname(execFileSync('which', ['initdb'], { encoding: 'utf8' }).trim()); } catch (_) { return null; }
}
let temp = null;
function startCluster() {
  const dir = pgBin();
  if (!dir) return null;
  const base = fs.mkdtempSync(path.join('/var/tmp', 'gaival-'));
  const run = (c) => execFileSync('bash', ['-c', c], { stdio: 'pipe' });
  try {
    if (process.getuid && process.getuid() === 0) {
      execFileSync('bash', ['-c', `chown -R postgres ${base}`], { stdio: 'pipe' });
      run(`su postgres -c "PATH=${dir}:\\$PATH initdb -D ${base}/data -A trust"`);
      run(`su postgres -c "PATH=${dir}:\\$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55987 -c listen_addresses=' start -w"`);
    } else {
      run(`PATH=${dir}:$PATH initdb -D ${base}/data -A trust`);
      run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55987 -c listen_addresses=' start -w`);
    }
  } catch (e) {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    return null;
  }
  temp = { base, dir };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55987&sslmode=disable`;
}
function stopCluster() {
  if (!temp) return;
  const c = process.getuid && process.getuid() === 0
    ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
    : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`;
  try { execFileSync('bash', ['-c', c], { stdio: 'pipe' }); } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
  temp = null;
}

console.log('\nRehearsal: office-validate-governed-ai.js\n');
const url = startCluster();
if (!url) {
  console.log('  skip  no Postgres available — the validator cannot be rehearsed here');
  process.exit(0);
}

// ── the provider stub, injected with --require so the validator is unmodified ──
//
// It must be a PRELOAD rather than a dependency the validator accepts, because a validator that
// takes an injectable provider is not the validator that runs in production. This way the file
// under test is byte-identical to the one deployed.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaistub-'));
function writeStub({ usage, status = 200, model = 'claude-haiku-4-5-20251001', json = true }) {
  const f = path.join(stubDir, `stub-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(f, `
globalThis.fetch = async () => ({
  ok: ${status === 200},
  status: ${status},
  text: async () => 'stub',
  json: async () => (${json ? `{
    model: ${JSON.stringify(model)},
    content: [{ type: 'text', text: 'OK' }],
    usage: ${usage === null ? 'null' : JSON.stringify(usage)},
  }` : 'undefined'}),
});
`);
  return f;
}

function runValidator(stub, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--require', stub, 'scripts/office-validate-governed-ai.js'], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-stub', RAILWAY_GIT_COMMIT_SHA: 'rehearsal', ...extraEnv },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

(async () => {
  try {
    process.env.DATABASE_URL = url;
    const { query } = require('../src/lib/db');

    // Seed the control plane exactly as production has it.
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/autonomy').migrateAutonomy(query);
    await require('../src/lib/procurement/rfq-identity-guard').migrate(query).catch(() => {});
    await query(`CREATE TABLE IF NOT EXISTS supplier_outreach_log (
      id TEXT PRIMARY KEY, rfq_id TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);

    const CO = 'co-rehearsal-abiozen';
    await query(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,'abiozen','Abiozen LLC','active')
                 ON CONFLICT (slug) DO NOTHING`, [CO]);
    const seedObjective = (fields = {}) => query(
      `INSERT INTO objectives (id, company_id, objective, priority, kpi_metric, kpi_target, deadline,
                               budget_usd, autonomy_tier, approval_policy, status, created_by)
       VALUES ('obj-abiozen-first-governed-rfq',$1,$2,'P1',$3,1,'2026-11-15',10,'supervised','all_consequential','draft','naren')
       ON CONFLICT (id) DO UPDATE SET objective=$2, kpi_metric=$3`,
      [CO,
        fields.objective || 'Obtain a qualified supplier quotation through governed RFQ outreach',
        fields.kpi_metric || 'qualified_supplier_quotes_received']);
    await seedObjective();

    // ══ 1. THE HAPPY PATH ════════════════════════════════════════════════
    console.log('── 1. a matching objective and a well-behaved provider\n');
    const r1 = runValidator(writeStub({ usage: { input_tokens: 17, output_tokens: 4 } }));
    if (r1.code === 0) ok('the validator exits 0');
    else bad(`the validator exited ${r1.code} on the happy path`, r1.out);
  if (r1.code !== 0 && /validation error/.test(r1.out)) {
    bad('  it died rather than failing an assertion — that is a defect in the validator itself');
  }

    for (const want of ['every stored field matches the approved proposal',
      'durable cost evidence exists', 'company attribution: Abiozen',
      'objective attribution: the validation fixture', 'run attribution',
      'workflow attribution', 'agent attribution', 'literal model id recorded',
      'usage normalized: 17 in / 4 out', 'cost known and durable',
      'correct terminal run state: SUCCEEDED', 'no approval, no outcome', 'no supplier was contacted',
      'validation fixture CANCELLED', 'the cancelled fixture grants no execution context',
      'the APPROVED objective is still draft']) {
      if (r1.out.split('\n').some((l) => l.includes(want) && l.trim().startsWith('ok'))) ok(`  reported: ${want}`);
      else bad(`  did NOT report: ${want}`);
    }

    // The evidence is in the database, not only in the output.
    const cost1 = (await query(
      `SELECT company_id, objective_id, run_id, workflow, agent, provider, model,
              tokens_input, tokens_output, cost_usd, cost_known FROM office_cost_ledger`)).rows;
    if (cost1.length === 1) ok('exactly one cost row was written');
    else bad(`expected 1 cost row, found ${cost1.length}`);
    const c = cost1[0] || {};
    if (c.company_id === CO) ok('the cost row carries the company'); else bad('cost row company wrong', c.company_id);
    if (c.objective_id === 'obj-k5k6-governed-ai-validation') ok('the cost row carries the fixture objective');
    else bad('cost row objective wrong', c.objective_id);
    if (c.cost_known === true && Number(c.cost_usd) > 0) ok(`cost is known and non-zero ($${Number(c.cost_usd).toFixed(8)})`);
    else bad('cost should be known and non-zero from real usage', `${c.cost_known} / ${c.cost_usd}`);

    const approved1 = (await query(`SELECT status FROM objectives WHERE id='obj-abiozen-first-governed-rfq'`)).rows[0];
    if (approved1.status === 'draft') ok('the approved objective was not activated');
    else bad(`the validator changed the approved objective to ${approved1.status}`);

    // ══ 2. IDEMPOTENCE — a re-run must not buy a second call ═════════════
    console.log('\n── 2. a second run (the railway-ssh-timed-out case)\n');
    const r2 = runValidator(writeStub({ usage: { input_tokens: 99, output_tokens: 99 } }));
    const cost2 = (await query(`SELECT COUNT(*)::int n FROM office_cost_ledger`)).rows[0].n;
    if (cost2 === 1) ok('still exactly one cost row — the re-run did NOT buy a second AI call');
    else bad(`the re-run spent again: ${cost2} cost rows`, r2.out.slice(-1500));
    if (/NOT buying a second AI call|already exists/.test(r2.out)) ok('the re-run says plainly that it reused the evidence');
    else bad('the re-run did not explain itself', r2.out.slice(-800));

    // ══ 3. A MISMATCH MUST STOP BEFORE SPENDING ══════════════════════════
    //
    // The property is not only "exit 1". It is that NO PROVIDER CALL HAPPENED — a validator that
    // reports a mismatch after buying the call has already failed the instruction not to touch
    // production data on a mismatch.
    console.log('\n── 3. a stored objective that differs from the approved proposal\n');
    // TRUNCATE, not DELETE: agent_run_events is append-only and refuses DELETE — correctly, and
    // that refusal is one of the guards this programme relies on. A row trigger does not fire on
    // TRUNCATE, which is the right tool for resetting a disposable cluster between phases.
    await query(`TRUNCATE office_cost_ledger, agent_run_events, agent_runs CASCADE`);
    await query(`DELETE FROM objectives WHERE id='obj-k5k6-governed-ai-validation'`);
    await seedObjective({ kpi_metric: 'suppliers_quoted' });   // the wording the ruling REJECTED

    const r3 = runValidator(writeStub({ usage: { input_tokens: 5, output_tokens: 5 } }));
    if (r3.code !== 0) ok(`the validator refuses to continue (exit ${r3.code})`);
    else bad('the validator PROCEEDED despite a mismatched objective', r3.out.slice(-1200));
    if (/══ STOP ══/.test(r3.out)) ok('it stops explicitly'); else bad('no STOP banner');
    if (/kpi_metric: stored "suppliers_quoted" ≠ approved "qualified_supplier_quotes_received"/.test(r3.out)) {
      ok('it names the exact difference');
    } else bad('it did not name the difference', r3.out.slice(-900));
    if (/No AI call was made and nothing/.test(r3.out)) ok('it states that nothing was spent');
    else bad('it did not state that nothing was spent');

    const after3 = (await query(`SELECT
        (SELECT COUNT(*)::int FROM office_cost_ledger) AS cost,
        (SELECT COUNT(*)::int FROM agent_runs) AS runs,
        (SELECT COUNT(*)::int FROM objectives WHERE id='obj-k5k6-governed-ai-validation') AS fixture`)).rows[0];
    if (after3.cost === 0) ok('NO cost row — the provider was never called'); else bad(`${after3.cost} cost row(s) on the mismatch path`);
    if (after3.runs === 0) ok('NO run was created'); else bad(`${after3.runs} run(s) created on the mismatch path`);
    if (after3.fixture === 0) ok('NO fixture objective was created'); else bad('a fixture was created before the comparison');

    // ══ 4. THE VALIDATOR'S OWN ASSERTIONS CAN GO RED ═════════════════════
    //
    // A provider that returns a cost with no usage behind it is a fabricated number. If the
    // validator passes that, every green run above is worth nothing.
    console.log('\n── 4. can the validator catch a fabricated cost?\n');
    await seedObjective();                       // back to matching
    await query(`DELETE FROM objectives WHERE id='obj-k5k6-governed-ai-validation'`);
    await query(`TRUNCATE office_cost_ledger, agent_run_events, agent_runs CASCADE`);

    const r4 = runValidator(writeStub({ usage: { input_tokens: 0, output_tokens: 0 } }));
    const fabricated = /fabricated number/.test(r4.out) || /cost is claimed KNOWN with no usage/.test(r4.out);
    const unknownInstead = /cost UNKNOWN and recorded as unknown/.test(r4.out);
    if (fabricated) {
      ok('the validator catches a cost claimed KNOWN with no usage behind it');
      if (r4.code !== 0) ok('and it goes red (exit non-zero), so this cannot pass unnoticed');
      else bad('it printed the finding but still exited 0');
    } else if (unknownInstead) {
      ok('zero usage yields cost UNKNOWN rather than a fabricated figure — the lie cannot be formed');
    } else {
      bad('zero-usage cost was neither caught nor recorded unknown', r4.out.slice(-1200));
    }

    // ══ 5. THE BUDGET VALIDATOR, AND WHETHER IT CAN GO RED ═══════════════
    //
    // validate-k5-budget-deployed.js is read-only, so the risk is not that it breaks something —
    // it is that it passes while the budget is NOT wired, which is the one thing it exists to
    // deny. So it is run twice: once as deployed, and once with the gate removed from ai.js.
    console.log('\n── 5. the budget activation validator\n');
    const AIFILE = path.join(REPO, 'src', 'lib', 'office', 'ai.js');
    const runBudget = () => spawnSync(process.execPath, ['scripts/validate-k5-budget-deployed.js'], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url, RAILWAY_GIT_COMMIT_SHA: 'rehearsal' },
    });

    const b1 = runBudget();
    const b1out = (b1.stdout || '') + (b1.stderr || '');
    if (b1.status === 0) ok('the budget validator exits 0 against a correctly wired build');
    else bad(`the budget validator exited ${b1.status}`, b1out.split('\n').slice(-20).join('\n'));
    for (const want of ['enterprise daily cap is $100',
      'thresholds are 50% / 75% / 90% / 100%',
      'critical, recovery and observability are exempt',
      'acts on a refusal BEFORE reaching the provider',
      'consequential release consults the fail-closed gate',
      'governedCall exposes NO cap parameter',
      'measured spend agrees with raw SQL by an independent path',
      'is correct for fraction']) {
      if (b1out.split('\n').some((l) => l.includes(want) && l.trim().startsWith('ok'))) ok(`  reported: ${want}`);
      else bad(`  did NOT report: ${want}`);
    }

    // ── the red path ────────────────────────────────────────────────────────
    const aiBefore = fs.readFileSync(AIFILE, 'utf8');
    const anchor = '  if (!budgetDecision.allow) {';
    if (!aiBefore.includes(anchor)) {
      bad('could not locate the budget gate in ai.js — this red-path control is stale');
    } else {
      fs.writeFileSync(AIFILE, aiBefore.replace(anchor, '  if (false && !budgetDecision.allow) {'));
      try {
        const b2 = runBudget();
        const b2out = (b2.stdout || '') + (b2.stderr || '');
        if (b2.status !== 0) ok('with the refusal disabled the budget validator GOES RED — its green is load-bearing');
        else bad('the budget validator still passed with the gate disabled — its green means nothing', b2out.split('\n').slice(-18).join('\n'));
        if (/the budget is assessed but its refusal is not acted on/.test(b2out)) {
          ok('and it names the exact defect rather than failing vaguely');
        } else bad('it went red for an unclear reason', b2out.split('\n').slice(-14).join('\n'));
      } finally {
        fs.writeFileSync(AIFILE, aiBefore);
      }
    }
    const restored = fs.readFileSync(AIFILE, 'utf8') === aiBefore;
    if (restored) ok('ai.js restored byte-for-byte'); else bad('ai.js was NOT restored');

    console.log('\n' + (fail ? `FAIL  ${fail} assertion(s) failed` :
      'PASS  the validator stops before spending on a mismatch, is idempotent, attributes its '
      + 'evidence, leaves the approved objective alone, and cannot report a fabricated cost.'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  rehearsal error:', e.stack || e.message);
    process.exit(1);
  } finally {
    try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch (_) {}
    stopCluster();
  }
})();
