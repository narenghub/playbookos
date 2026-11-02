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
    // Production migrates the supplier-claim table at boot, including R1's provider-acknowledgement
    // columns. Doing it here too means the K7/K9 validator sees the same shape it will on
    // production — the first version ran before this and reported the columns missing.
    await query(`CREATE TABLE IF NOT EXISTS supplier_outreach_log (
      id TEXT PRIMARY KEY, rfq_id TEXT, supplier_id TEXT, email_sent_to TEXT, email_subject TEXT,
      email_body TEXT, sent_at TEXT, replied_at TEXT, reply_text TEXT, status TEXT DEFAULT 'sent')`).catch(() => {});
    await require('../src/lib/idempotency/supplier-rfq').migrate(query).catch(() => {});
    await query(`CREATE TABLE IF NOT EXISTS supplier_outreach_log (
      id TEXT PRIMARY KEY, rfq_id TEXT, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);

    // The signature block on a governed RFQ is resolved from `users` at render time, so an active
    // signatory must exist before anything renders — otherwise every preparation below refuses
    // with no_active_signatory and the failure looks like the behaviour under test.
    await query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT NOW())`).catch(() => {});
    await query(`INSERT INTO users (id, email, name, role, is_active)
                 VALUES ('u-dir','dir@rehearsal.invalid','Rehearsal Director','procurement_director',1)
                 ON CONFLICT (id) DO UPDATE SET is_active = 1`);

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

    // ══ 6. THE K7/K9 VALIDATOR, AND WHETHER IT CAN GO RED ════════════════
    console.log('\n── 6. the approval + provenance validator\n');
    const runK7 = () => spawnSync(process.execPath, ['scripts/validate-k7-k9-deployed.js'], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url, RAILWAY_GIT_COMMIT_SHA: 'rehearsal' },
    });
    const k1r = runK7();
    const k1out = (k1r.stdout || '') + (k1r.stderr || '');
    if (k1r.status === 0) ok('the K7/K9 validator exits 0 against a correctly wired build');
    else bad(`the K7/K9 validator exited ${k1r.status}`, k1out.split('\n').slice(-22).join('\n'));
    for (const want of ['the approved payload is immutable in the database',
      'release is an ARBITRATED UPDATE',
      "it requires status = 'approved'",
      'it requires release_claimed_at IS NULL',
      'the EXECUTION CLAIM is its own fact',
      'PROVIDER ACKNOWLEDGEMENT is its own fact',
      'no mailer, WhatsApp, outreach or supplier-claim module is reachable from the approval path',
      '`consequential` defaults to TRUE']) {
      if (k1out.split('\n').some((l) => l.includes(want) && l.trim().startsWith('ok'))) ok(`  reported: ${want}`);
      else bad(`  did NOT report: ${want}`);
    }

    // The red path: remove the approved predicate, exactly as mutation control M4 does. A
    // validator that still passes without it would be certifying that approval precedes action
    // when it does not.
    const SCOPEFILE = path.join(REPO, 'src', 'lib', 'office', 'scope.js');
    const scopeBefore = fs.readFileSync(SCOPEFILE, 'utf8');
    // Anchor updated when ruling §2 split authorization from the execution claim. The control
    // reported itself stale rather than passing on text that no longer existed.
    const predicate = `        AND status = 'approved'\n        AND release_claimed_at IS NULL`;
    if (!scopeBefore.includes(predicate)) {
      bad('could not locate the approved predicate in scope.js — this red-path control is stale');
    } else {
      fs.writeFileSync(SCOPEFILE, scopeBefore.replace(predicate, `        AND release_claimed_at IS NULL`));
      try {
        const k2r = runK7();
        const k2out = (k2r.stdout || '') + (k2r.stderr || '');
        if (k2r.status !== 0) ok('without the approved predicate the K7/K9 validator GOES RED');
        else bad('it passed with the approved predicate removed — its green means nothing', k2out.split('\n').slice(-18).join('\n'));
        if (/approved predicate is MISSING/.test(k2out)) ok('and it names the missing predicate exactly');
        else bad('it went red for an unclear reason', k2out.split('\n').slice(-14).join('\n'));
      } finally {
        fs.writeFileSync(SCOPEFILE, scopeBefore);
      }
    }
    if (fs.readFileSync(SCOPEFILE, 'utf8') === scopeBefore) ok('scope.js restored byte-for-byte');
    else bad('scope.js was NOT restored');

    // ══ 7. THE CANDIDATE LISTING MUST REPORT THE REAL VERDICT ════════════
    //
    // This exists because the first version of office-rfq-candidates.js read guardSend()'s return
    // fields off decide()'s result — a DIFFERENT shape — so `d.allow` was undefined, every row
    // printed "REFUSE — undefined", and it announced on production that none of six real RFQs was
    // eligible. A false finding about production data, which would have sent somebody into the
    // molecule registry hunting a problem that may not exist.
    //
    // So the listing is now exercised against molecules whose verdicts are KNOWN IN ADVANCE, and
    // the assertion is that it prints each one. "No crash" would not have caught the defect: the
    // broken version did not crash.
    console.log('\n── 7. the candidate listing reports the real guard verdict\n');
    await require('../src/lib/molecules/canonical').migrate?.(query).catch?.(() => {});
    // id is BIGSERIAL in the real schema (scripts/migrate-molecules.js), and
    // rfq_identity_decisions.molecule_id is BIGINT. The first version of this fixture made it
    // TEXT, so persist() could not write the identity decision and guardSend correctly reported
    // decision_not_persisted — the guard refusing because its evidence could not be stored, which
    // is the right behaviour and was entirely my fixture's fault.
    await query(`CREATE TABLE IF NOT EXISTS molecules (
      id BIGSERIAL PRIMARY KEY, molecule_ref TEXT, normalized_name TEXT UNIQUE, preferred_name TEXT,
      cas TEXT, cas_suppressed_reason TEXT, substance_form TEXT,
      deprecated_at TIMESTAMPTZ, deprecated_reason TEXT, parent_molecule_id BIGINT)`).catch(() => {});
    await query(`CREATE TABLE IF NOT EXISTS molecule_aliases (
      alias TEXT PRIMARY KEY, molecule_id BIGINT)`).catch(() => {});
    await query(`CREATE TABLE IF NOT EXISTS rfq_requests (
      id TEXT PRIMARY KEY, molecule_name TEXT, cas_number TEXT, target_quantity TEXT,
      target_purity TEXT, gmp_required INTEGER DEFAULT 0, status TEXT,
      priority TEXT, week_start TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
    await require('../src/lib/procurement/rfq-identity-guard').migrate(query).catch(() => {});

    await query(`CREATE TABLE IF NOT EXISTS suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      country TEXT, region TEXT, contact_email TEXT, contact_name TEXT,
      gmp_certified INTEGER DEFAULT 0, reliability_score INTEGER, total_orders INTEGER)`).catch(() => {});
    // An earlier phase already created this table with a narrower shape, so CREATE TABLE IF NOT
    // EXISTS silently skips the columns the listing needs. The columns are added explicitly —
    // production's real table has supplier_id, email_sent_to and sent_at (and NO created_at,
    // which is why the §8 validator counts outreach defensively).
    await query(`CREATE TABLE IF NOT EXISTS supplier_outreach_log (id TEXT PRIMARY KEY, rfq_id TEXT)`).catch(() => {});
    for (const c of ['supplier_id TEXT', 'email_sent_to TEXT', 'status TEXT', 'sent_at TEXT']) {
      await query(`ALTER TABLE supplier_outreach_log ADD COLUMN IF NOT EXISTS ${c}`).catch(() => {});
    }
    await query(`INSERT INTO suppliers (id, name, country, contact_email, gmp_certified)
                 VALUES ('s-ok','Rehearsal Labs','India','bd@rehearsal.invalid',1)
                 ON CONFLICT (id) DO NOTHING`);

    // THE CAS VALUES HERE MUST BE CHECKSUM-VALID, AND THIS TEST'S FIRST VERSION'S WERE NOT.
    //
    // 111-11-1 and 222-22-2 look like CAS numbers and are not: both fail the check digit. The
    // guard therefore DISCARDED the filed value as evidence and used the canonical CAS, which is
    // correct and documented behaviour -- so the "disputed" fixture reported ALLOW and this test
    // read that as the guard failing. The guard was right and the fixture was fake.
    //
    // These are the real Tramadol pair, which is the case the identity guard exists for:
    // 36282-47-0 is the hydrochloride, 27203-92-5 is the base. Both are checksum-valid, they
    // disagree, and a checksum-only path would wave either one through.
    await query(`INSERT INTO molecules (id, molecule_ref, normalized_name, preferred_name, cas)
                 VALUES (9001,'MOL-CAND','candidatium','Candidatium','36282-47-0')
                 ON CONFLICT (normalized_name) DO NOTHING`);
    await query(`INSERT INTO rfq_requests (id, molecule_name, cas_number, target_quantity, status)
                 VALUES ('cand-allow','Candidatium','36282-47-0','1kg','pending'),
                        ('cand-disputed','Candidatium','27203-92-5','1kg','pending'),
                        ('cand-malformed','Candidatium','222-22-2','1kg','pending'),
                        ('cand-unknown','Notamoleculeium','109581-93-3','1kg','pending')
                 ON CONFLICT (id) DO NOTHING`);

    const cand = spawnSync(process.execPath, ['scripts/office-rfq-candidates.js'], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url, RAILWAY_GIT_COMMIT_SHA: 'rehearsal' },
    });
    const cout = (cand.stdout || '') + (cand.stderr || '');
    if (cand.status === 0) ok('the candidate listing exits 0');
    else bad(`the candidate listing exited ${cand.status}`, cout.split('\n').slice(-18).join('\n'));

    if (/REFUSE — undefined/.test(cout)) {
      bad('the listing STILL prints "REFUSE — undefined" — it is reading the wrong return shape');
    } else ok('no "REFUSE — undefined": the verdict fields are being read correctly');
    if (/NOT INTERPRETABLE/.test(cout)) {
      bad('the listing could not interpret a verdict — the guard shape has changed again', cout.split('\n').filter((l) => /NOT INTERPRETABLE/.test(l)).join('\n'));
    } else ok('every verdict was interpretable');

    const line = (id) => cout.split('\n').find((l) => l.includes(id)) || '';
    if (/ALLOW as "Candidatium" \(36282-47-0\)/.test(line('cand-allow'))) {
      ok('an agreeing filed CAS reports ALLOW with the CANONICAL name and CAS');
    } else bad('the allowed RFQ was not reported as allowed', line('cand-allow'));
    if (/REFUSE — cas_disputed/.test(line('cand-disputed'))) {
      ok('a filed CAS disagreeing with the canonical one reports REFUSE — cas_disputed (the Tramadol class)');
      if (/filed 27203-92-5 vs canonical 36282-47-0/.test(line('cand-disputed'))) {
        ok('and it shows BOTH CAS values, which is the fact a human needs to act on');
      } else bad('it refused without showing the disagreement', line('cand-disputed'));
    } else bad('a disputed CAS was not reported as cas_disputed', line('cand-disputed'));
    if (/REFUSE — identity_unresolved/.test(line('cand-unknown'))) {
      ok('an unresolvable name reports REFUSE — identity_unresolved');
    } else bad('an unknown molecule was not reported as unresolved', line('cand-unknown'));

    // The behaviour this test's own defect uncovered, now asserted deliberately: a filed CAS that
    // fails its check digit is DISCARDED as evidence rather than treated as a disagreement, and
    // the identity supplies its own CAS. Worth pinning down, because it is the difference between
    // "the filed value was corrected" -- which would be identity being edited -- and "the filed
    // value was never evidence in the first place".
    if (/ALLOW as "Candidatium" \(36282-47-0\)/.test(line('cand-malformed'))) {
      ok('a checksum-MALFORMED filed CAS is discarded, and the canonical CAS is used instead');
    } else bad('a malformed filed CAS was not handled as documented', line('cand-malformed'));

    // ── THE DUPLICATE WARNING ───────────────────────────────────────────────
    //
    // Every real RFQ on production is already status='sent', so the pair a human picks may be one
    // a supplier was already contacted about in July. That is not an identity problem — the guard
    // has no opinion about it — so nothing else would catch it, and the supplier would discover it
    // by receiving a second RFQ for the same molecule.
    await query(`INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, email_sent_to, status, sent_at)
                 VALUES ('out-1','cand-allow','s-ok','bd@rehearsal.invalid','no_response','2026-07-21 16:00:00')
                 ON CONFLICT (id) DO NOTHING`);
    const cand2 = spawnSync(process.execPath, ['scripts/office-rfq-candidates.js'], {
      cwd: REPO, encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url, RAILWAY_GIT_COMMIT_SHA: 'rehearsal' },
    });
    const c2 = (cand2.stdout || '') + (cand2.stderr || '');
    if (/ALREADY CONTACTED, PER ELIGIBLE RFQ/.test(c2)) ok('the listing reports prior outreach per eligible RFQ');
    else bad('the prior-outreach section is missing', c2.split('\n').slice(-12).join('\n'));
    if (/ALREADY SENT\s+Rehearsal Labs/.test(c2)) ok('and names the supplier that already holds an RFQ for that molecule');
    else bad('it did not name the already-contacted supplier');
    if (/makes the first governed action a DUPLICATE/.test(c2)) ok('and says plainly that choosing it would be a duplicate');
    else bad('it did not warn about the duplicate');
    // The RFQ nobody has been contacted about must say so, rather than being silent.
    if (/no supplier has been contacted for this RFQ/.test(c2)) {
      ok('an eligible RFQ with no prior outreach is reported as a clean NEW action');
    } else bad('an RFQ with no prior outreach was not distinguished from one with it');

    // And it must still write nothing — no identity decision for a candidate nobody chose.
    const decisions = (await query(`SELECT COUNT(*)::int n FROM rfq_identity_decisions`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    if (decisions === 0) ok('the listing persisted NO identity decision — decide(), never guardSend()');
    else bad(`${decisions} identity decision(s) were written by a read-only listing`);

    // ══ 8. §14 ACTIVATION AND §15 PREPARATION ════════════════════════════
    //
    // These two WRITE TO PRODUCTION — one flips the approved objective live, the other spends real
    // money and creates a durable approval carrying a real supplier communication. Rehearsing them
    // here is not optional: a defect in either is discovered in front of the CEO otherwise.
    console.log('\n── 8. activation and first-RFQ preparation\n');

    // The approved objective, exactly as ruled, in DRAFT.
    await query(`UPDATE objectives SET objective = $1, priority='P1',
                   kpi_metric='qualified_supplier_quotes_received', kpi_target=1,
                   deadline='2026-11-15', budget_usd=10, autonomy_tier='supervised',
                   approval_policy='all_consequential', created_by='naren', status='draft'
                 WHERE id='obj-abiozen-first-governed-rfq'`,
      ['Obtain a qualified supplier quotation through governed RFQ outreach']);
    // A second supplier, so there is a clean (non-duplicate) choice available.
    await query(`INSERT INTO suppliers (id, name, country, contact_email, gmp_certified)
                 VALUES ('s-fresh','Fresh Labs','India','bd@fresh.invalid',1)
                 ON CONFLICT (id) DO NOTHING`);

    const runScript = (script, args = [], stub = null) => spawnSync(process.execPath,
      [...(stub ? ['--require', stub] : []), `scripts/${script}`, ...args], {
        cwd: REPO, encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-stub',
          RAILWAY_GIT_COMMIT_SHA: 'rehearsal' },
      });
    const okStub = () => writeStub({ usage: { input_tokens: 220, output_tokens: 180 } });

    // ── preparing BEFORE activation must stop ───────────────────────────────
    const early = runScript('office-prepare-first-rfq.js',
      ['--rfq=cand-allow', '--supplier=s-fresh'], okStub());
    const earlyOut = (early.stdout || '') + (early.stderr || '');
    if (early.status !== 0 && /is "draft", not active/.test(earlyOut)) {
      ok('§15 refuses to prepare against a DRAFT objective, and says to activate first');
    } else bad('§15 did not refuse a draft objective', earlyOut.split('\n').slice(-14).join('\n'));

    // ── missing arguments must stop, without choosing anything ──────────────
    const noArgs = runScript('office-prepare-first-rfq.js', [], okStub());
    const noArgsOut = (noArgs.stdout || '') + (noArgs.stderr || '');
    if (noArgs.status !== 0 && /both required/.test(noArgsOut)) {
      ok('§15 refuses without --rfq and --supplier rather than choosing for the CEO');
    } else bad('§15 did not refuse missing arguments');

    // ── activate ────────────────────────────────────────────────────────────
    const act = runScript('office-activate-objective.js');
    const actOut = (act.stdout || '') + (act.stderr || '');
    if (act.status === 0) ok('§14 activation exits 0');
    else bad(`§14 activation exited ${act.status}`, actOut.split('\n').slice(-20).join('\n'));
    if (/ACTIVATED/.test(actOut)) ok('it reports the activation');
    else bad('it did not report an activation');
    if (/activation created no run, no AI call, no approval and no outcome/.test(actOut)) {
      ok('and that activation created no work');
    } else bad('it did not assert that activation created nothing');
    const st = (await query(`SELECT status FROM objectives WHERE id='obj-abiozen-first-governed-rfq'`)).rows[0];
    if (st.status === 'active') ok('the objective is active in the database');
    else bad(`the objective is "${st.status}" after activation`);

    // ── activation is idempotent and does not re-activate ───────────────────
    const act2 = runScript('office-activate-objective.js');
    if (act2.status === 0 && /ALREADY active/.test((act2.stdout || ''))) {
      ok('a second activation is a no-op that says so');
    } else bad('a second activation did not report already-active', (act2.stdout || '').slice(-400));

    // ── the duplicate guard ─────────────────────────────────────────────────
    // s-ok already holds an RFQ for cand-allow (seeded in phase 7).
    const dup = runScript('office-prepare-first-rfq.js',
      ['--rfq=cand-allow', '--supplier=s-ok'], okStub());
    const dupOut = (dup.stdout || '') + (dup.stderr || '');
    if (dup.status !== 0 && /ALREADY HOLDS an RFQ/.test(dupOut)) {
      ok('§15 REFUSES a supplier who already holds an RFQ for that molecule');
      if (/--allow-duplicate/.test(dupOut)) ok('and names the explicit override rather than hiding it');
      else bad('it refused without offering the deliberate path');
    } else bad('§15 did not refuse a duplicate supplier', dupOut.split('\n').slice(-16).join('\n'));
    const dupAppr = (await query(`SELECT COUNT(*)::int n FROM office_approvals`)).rows[0].n;
    if (dupAppr === 0) ok('the refused duplicate created NO approval');
    else bad(`${dupAppr} approval(s) exist after a refusal`);

    // ── a refused identity must stop, with the exception as the outcome ─────
    const disputed = runScript('office-prepare-first-rfq.js',
      ['--rfq=cand-disputed', '--supplier=s-fresh'], okStub());
    const disOut = (disputed.stdout || '') + (disputed.stderr || '');
    if (disputed.status !== 0 && /identity_guard_refused/.test(disOut)) {
      ok('§15 stops on a cas_disputed RFQ and reports the guard refusal as the outcome');
      if (/legacy generator is NOT a fallback/.test(disOut)) ok('and states there is no legacy fallback');
      else bad('it did not state the no-fallback rule');
    } else bad('a disputed RFQ was not refused', disOut.split('\n').slice(-16).join('\n'));

    // ── THE HAPPY PATH ──────────────────────────────────────────────────────
    const prep = runScript('office-prepare-first-rfq.js',
      ['--rfq=cand-allow', '--supplier=s-fresh'], okStub());
    const prepOut = (prep.stdout || '') + (prep.stderr || '');
    if (prep.status === 0) ok('§15 prepares successfully for a clean (RFQ, supplier) pair');
    else bad(`§15 exited ${prep.status}`, prepOut.split('\n').slice(-24).join('\n'));
    for (const want of ['the action is PENDING', 'nothing was transmitted',
      'no outcome recorded', 'the supplier outreach log is unchanged']) {
      if (prepOut.split('\n').some((l) => l.includes(want) && l.trim().startsWith('ok'))) ok(`  reported: ${want}`);
      else bad(`  did NOT report: ${want}`);
    }
    if (/THE NEXT DECISION IS YOURS/.test(prepOut)) ok('it ends at the human decision boundary');
    else bad('it did not end at the approval boundary');
    if (/THE EXACT COMMUNICATION AWAITING APPROVAL/.test(prepOut)) ok('it prints the exact communication');
    else bad('it did not print the communication a human must read');
    if (/PROVENANCE CHAIN/.test(prepOut)) ok('and the provenance chain');
    else bad('it did not print provenance');

    // The durable state: exactly one pending approval, payload is the communication, nothing sent.
    const apRows = (await query(
      `SELECT id, status, action_kind, action_payload FROM office_approvals`)).rows;
    if (apRows.length === 1) ok('exactly one approval exists');
    else bad(`${apRows.length} approvals exist, expected 1`);
    const ap = apRows[0] || {};
    if (ap.status === 'pending') ok('it is pending'); else bad(`it is ${ap.status}`);
    if (ap.action_kind === 'send_rfq_email') ok('its action kind is send_rfq_email');
    else bad(`unexpected action kind ${ap.action_kind}`);
    if (ap.action_payload && ap.action_payload.to === 'bd@fresh.invalid') {
      ok('its payload addresses the chosen supplier');
    } else bad('the payload does not address the chosen supplier', JSON.stringify(ap.action_payload || {}).slice(0, 160));
    if (ap.action_payload && ap.action_payload.approved_cas === '36282-47-0') {
      ok('and carries the CANONICAL CAS, not the filed one');
    } else bad('the payload does not carry the canonical CAS', ap.action_payload && ap.action_payload.approved_cas);
    const sentRows = (await query(`SELECT COUNT(*)::int n FROM supplier_outreach_log WHERE supplier_id='s-fresh'`)).rows[0].n;
    if (sentRows === 0) ok('no outreach row was written — the supplier was not claimed or contacted');
    else bad(`${sentRows} outreach row(s) written for a merely prepared RFQ`);

    // ── A GUARD REFUSAL MUST NOT CONSUME THE SLOT FOR A DIFFERENT RFQ ──────
    //
    // This is the property the rehearsal discovered was broken. The cas_disputed attempt above
    // opened a run before the guard refused it, and with a per-(workflow, objective) day key that
    // refusal consumed the objective's only slot — so the correct RFQ could not be prepared until
    // the next day. A guard refusal, which is the system working, would have locked out the very
    // work it was protecting. The intent is now the (objective, RFQ, supplier) triple.
    //
    // The happy path above ran AFTER the disputed refusal, so its success already demonstrates
    // this. Asserted explicitly so it cannot regress silently.
    const keys = (await query(
      `SELECT intent_key FROM agent_runs WHERE workflow = 'governed-rfq-generation'
        ORDER BY created_at`)).rows.map((r) => r.intent_key);
    if (new Set(keys).size === keys.length) {
      ok(`each governed procurement run has its OWN intent key (${keys.length} distinct)`);
    } else bad('two governed procurement runs share an intent key', keys.join('\n'));
    if (keys.some((k) => k && k.includes('cand-disputed')) && keys.some((k) => k && k.includes('cand-allow'))) {
      ok('a refused RFQ and an allowed one hold SEPARATE slots — a guard refusal locks out nothing');
    } else bad('the intent keys do not distinguish the two RFQs', keys.join('\n'));

    // ── and a second preparation the same day is one intent, not two ────────
    const again2 = runScript('office-prepare-first-rfq.js',
      ['--rfq=cand-allow', '--supplier=s-fresh', '--allow-duplicate'], okStub());
    const again2Out = (again2.stdout || '') + (again2.stderr || '');
    if (again2.status !== 0 && /duplicate_intent/.test(again2Out)) {
      ok('a second governed procurement run for the objective today is refused as one intent');
    } else bad('a second preparation was permitted the same day', again2Out.split('\n').slice(-14).join('\n'));
    const apAfter = (await query(`SELECT COUNT(*)::int n FROM office_approvals`)).rows[0].n;
    if (apAfter === 1) ok('still exactly one approval — no second communication was prepared');
    else bad(`${apAfter} approvals after the duplicate attempt`);

    // ══ 9. THE HUMAN DECISION, AND THE SIGNATORY REPORT ══════════════════
    console.log('\n── 9. deciding a prepared action, and who would sign\n');

    const sig = runScript('office-signatory.js');
    const sigOut = (sig.stdout || '') + (sig.stderr || '');
    if (sig.status === 0 && /THE SIGNATURE BLOCK A SUPPLIER WOULD SEE/.test(sigOut)) {
      ok('the signatory report names who a supplier would see');
    } else bad('the signatory report failed', sigOut.split('\n').slice(-12).join('\n'));

    // An inactive director must be shown as skipped, not silently omitted.
    await query(`INSERT INTO users (id, email, name, role, is_active)
                 VALUES ('u-gone','gone@abiozen.invalid','A Departed Director','procurement_director',0)
                 ON CONFLICT (id) DO UPDATE SET is_active = 0`);
    const sig2 = (runScript('office-signatory.js').stdout || '');
    if (/A Departed Director/.test(sig2) && /skipped: inactive/.test(sig2)) {
      ok('and shows an inactive director as SKIPPED rather than hiding them');
    } else bad('the inactive director was not shown as skipped', sig2.split('\n').slice(-14).join('\n'));

    // ── the decision itself ─────────────────────────────────────────────────
    const theApproval = (await query(`SELECT id FROM office_approvals LIMIT 1`)).rows[0];
    if (!theApproval) bad('no approval to decide — phase 8 should have prepared one');
    else {
      // a missing or too-short reason must be refused
      const noReason = runScript('office-decide-approval.js',
        [`--approval=${theApproval.id}`, '--reject']);
      if (noReason.status !== 0 && /--reason/.test((noReason.stdout || ''))) {
        ok('a decision without a reason is refused');
      } else bad('a reasonless decision was accepted');
      const bothWays = runScript('office-decide-approval.js',
        [`--approval=${theApproval.id}`, '--approve', '--reject', '--reason=cannot be both ways']);
      if (bothWays.status !== 0) ok('--approve and --reject together are refused rather than guessed');
      else bad('it guessed between approve and reject');

      // and it must print the stored communication before deciding
      const rej = runScript('office-decide-approval.js',
        [`--approval=${theApproval.id}`, '--reject', '--reason=rehearsal: signed by a departed employee']);
      const rejOut = (rej.stdout || '') + (rej.stderr || '');
      if (/WHAT WOULD GO OUT, FROM THE IMMUTABLE PAYLOAD/.test(rejOut)) {
        ok('it prints the stored payload before applying the decision');
      } else bad('it decided without showing what was being decided');
      if (rej.status === 0 && /REJECTED/.test(rejOut)) ok('the rejection is recorded');
      else bad(`the rejection failed (${rej.status})`, rejOut.split('\n').slice(-16).join('\n'));
      if (/the reason is stored beside the verdict/.test(rejOut)) ok('and the reason is persisted, not merely printed');
      else bad('the reason was not persisted');
      if (/nothing was released and nothing was transmitted/.test(rejOut)) ok('and nothing was released');
      else bad('it did not confirm nothing was released');

      const st2 = (await query(`SELECT status, resolution, released_at FROM office_approvals WHERE id=$1`,
        [theApproval.id])).rows[0];
      if (st2.status === 'rejected') ok('the stored status is rejected'); else bad(`stored status ${st2.status}`);
      if (st2.released_at === null) ok('released_at is still NULL'); else bad('it was released');

      // a second decision on the same action must be refused — arbitrated, not re-decided
      const again3 = runScript('office-decide-approval.js',
        [`--approval=${theApproval.id}`, '--approve', '--reason=trying to overturn the rejection']);
      if (again3.status !== 0 && /already "rejected"/.test((again3.stdout || ''))) {
        ok('a rejected action cannot be re-decided into approved');
      } else bad('a decided action was decided again', (again3.stdout || '').slice(-400));
    }

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
