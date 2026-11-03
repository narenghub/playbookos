#!/usr/bin/env node
// ── REHEARSAL FOR office-pre-release-report.js ──────────────────────────────
//
//   node scripts/check-pre-release-report-runs.js     exit 0 = the report behaves
//
// The report it exercises is THE LAST THING A HUMAN READS BEFORE A FIRST PRODUCTION SEND. Its
// failure modes are, in increasing severity: it crashes; it writes something; or it reports PASS
// when a release precondition would actually refuse. The third is the one that gets a letter sent
// over a departed person's name or twice to the same supplier.
//
// So the report is rehearsed on a throwaway cluster, and the properties asserted are the ones that
// matter rather than "it printed something":
//
//   1. a clean approved/unreleased approval → PASS (exit 0)
//   2. IT CAN GO RED, independently, for each precondition:
//        · status not approved
//        · release_mode = 'on_approval' (approval alone would release — not what was authorized)
//        · the signatory is no longer active
//        · a supplier claim already exists
//        · an ACTION_ATTEMPTED event already exists
//      Each case asserts the SPECIFIC reason, not merely a non-zero exit. A report that goes red
//      for the wrong reason is the gate-contamination pattern: the case passes, and the control it
//      claims to measure was never exercised.
//   3. IT WRITES NOTHING — every table's row count AND the payload digest are identical after a
//      run, including on the red paths, because a verification that mutates on its failure path is
//      worse than no verification.
//
// Property 3 is checked by counting rows rather than by reading the source: the whole point of
// Rule 7 is that a script's claim about itself is not evidence.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
// Show the TARGET's own FAIL lines rather than the first lines of its banner. The first version
// sliced the head of the output and printed a header six times, which made every failure look
// identical and told me nothing.
const reasons = (out) => {
  const lines = String(out || '').split('\n').filter((l) => /FAIL|REFUSE|UNREADABLE/.test(l));
  return (lines.length ? lines : String(out || '').split('\n').slice(-8)).slice(0, 8).join('\n');
};
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(reasons(d).split('\n').map((l) => '          ' + l).join('\n')); };

const findInitdb = pgBin;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/prerelease-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55991 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55991`;
}
function stopTemp() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asRoot
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { stdio: 'pipe' });
  } catch (_) {}
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch (_) {}
}

const url = process.env.PRERELEASE_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set PRERELEASE_PG_URL or install initdb)');
  console.log('SKIP  the pre-release report was not rehearsed — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}

const AP = 'ap-prerelease-fixture';
const CO = 'co-prerelease';
const OB = 'obj-prerelease';
const RFQ = 'rfq-prerelease';
const SUP = 'sup-prerelease';
const SIG = 'u-prerelease-sig';
let RUN = null;   // assigned by beginObjectiveRun; read by the cleanup in `finally`
const extraApprovals = [];   // sender cases build their own approvals; cleanup removes them by id

// sslmode=disable: the child builds its own pool through src/lib/db.js, which asks for SSL, and a
// throwaway cluster has none. Without it every case above failed with "The server does not support
// SSL connections" — and the red cases all PASSED, because they only checked that the exit was
// non-zero. That is the gate-contamination pattern in a harness rather than in a fixture, which is
// why each case asserts its specific reason.
const CHILD_URL = `${url}&sslmode=disable`;

function runReport(id = AP) {
  const r = spawnSync(process.execPath, ['scripts/office-pre-release-report.js', `--approval=${id}`], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: CHILD_URL, RAILWAY_GIT_COMMIT_SHA: 'rehearsal' },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

(async () => {
  process.env.DATABASE_URL = url;
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);

  // A fingerprint of everything the report could possibly mutate. Compared before and after every
  // run, including the red ones.
  async function fingerprint() {
    const r = await q(`SELECT
      (SELECT COUNT(*) FROM office_approvals)       ap,
      (SELECT COUNT(*) FROM office_exceptions)      ex,
      (SELECT COUNT(*) FROM office_outcomes)        oc,
      (SELECT COUNT(*) FROM office_cost_ledger)     cl,
      (SELECT COUNT(*) FROM agent_run_events)       ev,
      (SELECT COUNT(*) FROM agent_runs)             ar,
      (SELECT COUNT(*) FROM supplier_outreach_log)  sl,
      (SELECT COUNT(*) FROM users)                  us,
      (SELECT md5(action_payload::text) FROM office_approvals WHERE id = $1) digest,
      (SELECT status FROM office_approvals WHERE id = $1) st,
      (SELECT release_claimed_at::text FROM office_approvals WHERE id = $1) rc`, [AP]);
    return JSON.stringify(r.rows[0]);
  }

  // Runs the report and asserts it changed NOTHING, whatever its verdict.
  async function runInert(label) {
    const before = await fingerprint();
    const r = runReport();
    const after = await fingerprint();
    if (before !== after) {
      bad(`${label}: THE REPORT MUTATED THE DATABASE`, `before ${before}\nafter  ${after}`);
    }
    return r;
  }

  try {
    const { migrateRuns } = require('../src/lib/runs');
    const { migrateOffice } = require('../src/lib/office/schema');
    const rfqClaim = require('../src/lib/idempotency/supplier-rfq');
    await migrateRuns(q);
    await migrateOffice(q);

    // The legacy tables the report reads, in the shape db.js creates them — not an invented shape,
    // or this would prove the queries run against the fixture and nothing else.
    await q(`CREATE TABLE IF NOT EXISTS supplier_outreach_log (
               id TEXT PRIMARY KEY, rfq_id TEXT, supplier_id TEXT, email_sent_to TEXT,
               email_subject TEXT, email_body TEXT, sent_at TEXT, replied_at TEXT, reply_text TEXT,
               status TEXT DEFAULT 'sent' CHECK (status IN ('sent','replied','no_response')))`);
    await q(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
               name TEXT NOT NULL, role TEXT NOT NULL, is_active INTEGER DEFAULT 1,
               created_at TEXT DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS suppliers (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT,
               region TEXT CHECK (region IN ('apac','india','china','europe','us')),
               contact_email TEXT, contact_name TEXT, website TEXT, specialties TEXT,
               reliability_score INTEGER DEFAULT 50, avg_response_days REAL DEFAULT 3,
               gmp_certified INTEGER DEFAULT 0, total_orders INTEGER DEFAULT 0)`);
    await q(`CREATE TABLE IF NOT EXISTS rfq_requests (
               id TEXT PRIMARY KEY, molecule_name TEXT NOT NULL, cas_number TEXT,
               target_quantity TEXT, target_purity TEXT, gmp_required INTEGER DEFAULT 0,
               status TEXT DEFAULT 'pending')`);
    // The kill switch must be READABLE in the fixture, or every run reports UNKNOWABLE and the
    // clean path can never be green — the report would then be measuring a missing table rather
    // than the precondition it claims to check.
    const { migrateAutonomy } = require('../src/lib/autonomy');
    await migrateAutonomy(q);
    await rfqClaim.migrate(q);

    await q(`INSERT INTO companies (id, display_name, slug) VALUES ($1,'Pre-release Fixture',$1)
             ON CONFLICT (id) DO NOTHING`, [CO]);
    await q(`INSERT INTO users (id, email, name, role, is_active)
             VALUES ($1,'sig@prerelease.invalid','A Fixture Signatory','procurement_director',1)
             ON CONFLICT (id) DO UPDATE SET is_active = 1`, [SIG]);
    await q(`INSERT INTO suppliers (id, name, country, contact_email)
             VALUES ($1,'Pre-release Labs','India','sup@prerelease.invalid')
             ON CONFLICT (id) DO NOTHING`, [SUP]);
    await q(`INSERT INTO rfq_requests (id, molecule_name, cas_number, target_quantity, target_purity,
               gmp_required, status) VALUES ($1,'Clopidogrel Bisulfate','120202-66-6','1kg','99%',1,'sent')
             ON CONFLICT (id) DO NOTHING`, [RFQ]);

    const scope = require('../src/lib/office/scope');
    const deps = { query: q };
    await scope.createObjective({ id: OB, companyId: CO, objective: 'Pre-release fixture',
      priority: 'P3', kpiMetric: 'qualified_supplier_quotes_received', kpiTarget: 1,
      deadline: '2026-12-31', budgetUsd: 10, autonomyTier: 'supervised',
      approvalPolicy: 'all_consequential', createdBy: 'rehearsal' }, deps);
    await scope.setObjectiveStatus(Object.freeze({ companyId: CO, objectiveId: OB, runId: null }),
      { id: OB, status: 'active' }, deps);
    await q(`UPDATE objectives SET release_mode = 'explicit' WHERE id = $1`, [OB]);

    // THE RUN IS CREATED THE WAY PRODUCTION CREATES IT. An earlier version hand-inserted into
    // agent_runs and discovered its NOT NULL columns one error at a time — root_run_id, trigger,
    // product — which is a fixture drifting from the real shape by construction. beginObjectiveRun
    // is what the governed path uses, so the run this report reads is a real one.
    const { beginObjectiveRun } = require('../src/lib/office/run');
    const begun = await beginObjectiveRun({
      objectiveId: OB, workflow: 'governed-rfq-generation', agent: 'procurement-agent',
      trigger: 'manual', triggerDetail: 'pre-release report rehearsal',
    }, deps);
    // It returns { runId, context } — NOT { ctx }. Read from run.js, not recalled.
    if (!begun || !begun.runId) throw new Error(`beginObjectiveRun returned no run: ${JSON.stringify(begun)}`);
    RUN = begun.runId;

    const payload = {
      rfq_id: RFQ, supplier_id: SUP, supplier_name: 'Pre-release Labs',
      to: 'sup@prerelease.invalid', subject: 'RFQ — fixture', body: 'Dear supplier,\n\nFixture.',
      approved_molecule_name: 'Clopidogrel bisulfate', approved_cas: '120202-66-6',
      identity_decision_id: 99,
      signed_by_name: 'A Fixture Signatory', signed_by_title: 'Procurement',
      signed_by_email: 'sig@prerelease.invalid', signed_by_user_id: SIG,
      signed_by_role: 'procurement_director',
      cc: ['principal@prerelease.invalid'], bcc: [],
      // The sender is part of the approved communication. Present by default so every other case
      // measures its own precondition rather than refusing on this one first.
      from: 'A Fixture Signatory <sig@prerelease.invalid>',
      from_email: 'sig@prerelease.invalid', from_name: 'A Fixture Signatory', from_user_id: SIG,
      sender_provenance: 'derived from the resolved active signatory',
      intent_key: `${RFQ}:${SUP}`, attempt: 1,
      recipients: [
        { kind: 'to', email: 'sup@prerelease.invalid', relationship: 'external supplier', why: 'the supplier' },
        { kind: 'cc', email: 'principal@prerelease.invalid', relationship: 'principal', why: 'the company principal' },
      ],
    };
    await q(`INSERT INTO office_approvals (id, company_id, objective_id, run_id, action_kind,
               action_payload, status, reason, resolution, resolved_by, resolved_at)
             VALUES ($1,$2,$3,$4,'send_rfq_email',$5::jsonb,'approved','fixture',
                     'Approved for release in rehearsal','rehearsal',NOW())`,
      [AP, CO, OB, RUN, JSON.stringify(payload)]);

    // ══ 1. THE CLEAN PATH ══════════════════════════════════════════════════
    let r = await runInert('clean path');
    if (r.code === 0 && /PASS  approved, unreleased, unclaimed, unattempted/.test(r.out)) {
      ok('a clean approved/unreleased approval → PASS, exit 0');
    } else bad(`the clean path did not PASS (exit ${r.code})`, r.out);
    if (/release_mode = explicit/.test(r.out)) ok('and it states that release_mode is explicit');
    else bad('the report did not report the release mode');
    if (/payload sha256\s+[0-9a-f]{64}/.test(r.out)) ok('and prints a canonical payload digest');
    else bad('no payload digest was printed');
    if (/FROM\s+A Fixture Signatory/.test(r.out)) ok('and it displays FROM — a report without it is incomplete');
    else bad('the report does not display the sender');
    if (/R1 send capability IS deployed/.test(r.out)) {
      ok('and attributes the safety to EXPLICIT RELEASE MODE, not to an absent send capability');
    } else bad('the report does not state why approval is safe');
    const digestOf = (out) => (out.match(/payload sha256\s+([0-9a-f]{64})/) || [])[1];
    const cleanDigest = digestOf(r.out);

    // ══ 2. IT CAN GO RED, FOR EACH PRECONDITION INDEPENDENTLY ══════════════
    //
    // Each case changes exactly ONE fact and asserts the SPECIFIC reason. Restored afterwards, so
    // the next case measures its own control and not the leftovers of the last.
    const redCase = async (label, setup, restore, pattern) => {
      await setup();
      const rr = await runInert(`red case "${label}"`);
      if (rr.code === 0) {
        bad(`${label}: the report PASSED when a release precondition would refuse`, rr.out.slice(-400));
      } else if (!pattern.test(rr.out)) {
        bad(`${label}: it went red for the WRONG reason — the intended precondition was never `
          + 'measured, which is the gate-contamination pattern', rr.out.slice(-700));
      } else ok(`${label} → RED, for the right reason`);
      await restore();
    };

    await redCase('a pending approval',
      () => q(`UPDATE office_approvals SET status='pending' WHERE id=$1`, [AP]),
      () => q(`UPDATE office_approvals SET status='approved' WHERE id=$1`, [AP]),
      /status is "pending", not approved/);

    await redCase("release_mode = 'on_approval'",
      () => q(`UPDATE objectives SET release_mode='on_approval' WHERE id=$1`, [OB]),
      () => q(`UPDATE objectives SET release_mode='explicit' WHERE id=$1`, [OB]),
      /release_mode is "on_approval".*NOT what was authorized/s);

    // ── THE SENDER CASES GET THEIR OWN APPROVAL ROWS ──────────────────────
    //
    // They cannot be done by editing this fixture's payload: the immutability trigger refuses it —
    // "an approval request is immutable ... so that what was approved is what is released". That
    // is the protection the whole frozen-payload invariant rests on, so the fixture works WITH it
    // rather than disabling it, and each case inserts the payload it wants to test.
    const senderCase = async (label, suffix, overrides, pattern) => {
      const id = `${AP}-${suffix}`;
      const { from, from_email: fe, ...rest } = payload;
      await q(`INSERT INTO office_approvals (id, company_id, objective_id, run_id, action_kind,
                 action_payload, status, reason, resolution, resolved_by, resolved_at)
               VALUES ($1,$2,$3,$4,'send_rfq_email',$5::jsonb,'approved','fixture',
                       'approved in rehearsal','rehearsal',NOW())`,
        [id, CO, OB, RUN, JSON.stringify({ ...rest, ...overrides })]);
      extraApprovals.push(id);
      const rr = runReport(id);
      if (rr.code === 0) bad(`${label}: the report PASSED on a payload it must refuse`, rr.out.slice(-400));
      else if (!pattern.test(rr.out)) {
        bad(`${label}: red for the WRONG reason — the sender precondition was never measured`,
          reasons(rr.out));
      } else ok(`${label} → RED, for the right reason`);
    };

    // THE HETERO STATE: approved, and its payload records no sender because it was prepared before
    // the sender became part of the approved communication.
    await senderCase('a payload with NO sender', 'nosender', {}, /THE PAYLOAD RECORDS NO SENDER/);

    await senderCase('a sender that is not the signatory', 'notsig',
      { from: 'Procurement <procurement@prerelease.invalid>',
        from_email: 'procurement@prerelease.invalid' },
      /is not the frozen signatory/);

    await senderCase('a sender at another company\'s domain', 'otherdomain',
      { from: 'PlayNexa <no-reply@elsewhere.invalid>', from_email: 'no-reply@elsewhere.invalid' },
      /is not the frozen signatory|sender_outside_company_boundary/);

    await redCase('a departed signatory',
      () => q(`UPDATE users SET is_active=0 WHERE id=$1`, [SIG]),
      () => q(`UPDATE users SET is_active=1 WHERE id=$1`, [SIG]),
      /no longer active.*signatory_no_longer_active/s);

    await redCase('an existing supplier claim',
      () => q(`INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, status, claimed_at)
               VALUES ('sol-prerelease',$1,$2,'sent',NOW())`, [RFQ, SUP]),
      () => q(`DELETE FROM supplier_outreach_log WHERE id='sol-prerelease'`),
      /claim row\(s\) already exist for this pair/);

    await redCase('an existing ACTION_ATTEMPTED',
      () => q(`INSERT INTO agent_run_events (run_id, kind, action_kind, subject_type, subject_ref)
               VALUES ($1,'ACTION_ATTEMPTED','send_rfq_email','supplier',$2)`, [RUN, SUP]),
      async () => {
        await q(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`);
        try { await q(`DELETE FROM agent_run_events WHERE run_id=$1 AND kind='ACTION_ATTEMPTED'`, [RUN]); }
        finally { await q(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`); }
      },
      /ACTION_ATTEMPTED event\(s\) on this run/);

    // ══ 3. NON-VACUITY: IT IS GREEN AGAIN AFTERWARDS ═══════════════════════
    //
    // Without this, every red case above could be passing because the report is simply broken and
    // always exits non-zero — and the clean run happened before any of them.
    r = await runInert('clean path, re-run');
    if (r.code === 0) ok('and it is GREEN again once each condition is restored — the red cases '
      + 'were the conditions, not a report that always fails');
    else bad('the report stayed red after every condition was restored', r.out.slice(-700));
    // NON-VACUITY. The first version compared two undefineds and reported "unchanged", which is
    // how a digest check survives the report never printing a digest at all.
    const reDigest = digestOf(r.out);
    if (!/^[0-9a-f]{64}$/.test(String(cleanDigest)) || !/^[0-9a-f]{64}$/.test(String(reDigest))) {
      bad('no digest was printed on one of the runs, so this comparison measures nothing',
        `${cleanDigest} / ${reDigest}`);
    } else if (reDigest === cleanDigest) {
      ok('the payload digest is identical across every run — byte-for-byte, not merely "no error"');
    } else bad('the payload digest changed', `${cleanDigest} → ${reDigest}`);

    ok('every run above was checked for mutation — see the inert assertions');
  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    try {
      for (const id of extraApprovals) await q(`DELETE FROM office_approvals WHERE id = $1`, [id]).catch(() => {});
      await q(`DELETE FROM office_approvals WHERE id = $1`, [AP]).catch(() => {});
      await q(`DELETE FROM supplier_outreach_log WHERE rfq_id = $1`, [RFQ]).catch(() => {});
      await q(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`).catch(() => {});
      try { await q(`DELETE FROM agent_run_events WHERE run_id = $1`, [RUN]).catch(() => {}); }
      finally { await q(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`).catch(() => {}); }
      // By objective as well as by run id: if the rehearsal crashed before RUN was assigned, a
      // created run still holds the objective by foreign key and the delete below would fail.
      // Still only rows this fixture created — the objective id is mine.
      await q(`DELETE FROM agent_run_events WHERE run_id IN
                 (SELECT run_id FROM agent_runs WHERE objective_id = $1)`, [OB]).catch(() => {});
      await q(`DELETE FROM office_cost_ledger WHERE objective_id = $1`, [OB]).catch(() => {});
      await q(`DELETE FROM agent_runs WHERE objective_id = $1`, [OB]).catch(() => {});
      await q(`DELETE FROM objectives WHERE id = $1`, [OB]).catch(() => {});
      await q(`DELETE FROM companies WHERE id = $1`, [CO]).catch(() => {});
      await q(`DELETE FROM users WHERE id = $1`, [SIG]).catch(() => {});
      await q(`DELETE FROM suppliers WHERE id = $1`, [SUP]).catch(() => {});
      await q(`DELETE FROM rfq_requests WHERE id = $1`, [RFQ]).catch(() => {});

      // Only my rows, by id. Never "is the table empty".
      const mine = (await q(`SELECT
        (SELECT COUNT(*) FROM office_approvals WHERE id=$1) a,
        (SELECT COUNT(*) FROM objectives WHERE id=$2) b,
        (SELECT COUNT(*) FROM companies WHERE id=$3) c,
        (SELECT COUNT(*) FROM agent_runs WHERE run_id=$4) d`, [AP, OB, CO, RUN])).rows[0];
      if (Number(mine.a) + Number(mine.b) + Number(mine.c) + Number(mine.d) === 0) {
        ok('cleanup: every fixture row I created is gone (by id)');
      } else bad('fixture cleanup leaked', JSON.stringify(mine));
    } catch (e) { bad('cleanup failed', e.message); }
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} pre-release-report assertion(s) failed`
    : '\nPASS  the pre-release report passes a clean approval, goes RED for each release '
      + 'precondition independently and for the right reason, and writes nothing on any path');
  process.exit(fail ? 1 : 0);
})();
