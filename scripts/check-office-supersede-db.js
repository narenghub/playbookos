#!/usr/bin/env node
// ── SUPERSESSION: ONE NEW TRANSITION, AND NOTHING WIDER ─────────────────────
//
//   node scripts/check-office-supersede-db.js    exit 0 = the transition is exactly as narrow
//                                                         as it was authorized to be
//
// The authorized transition is `approved + never externally claimed → superseded`. The risk is not
// that it fails; it is that it turns out to be wider than it looks, and a decided approval becomes
// re-decidable. So most of this file is about what must REMAIN impossible.
//
//   pending    → superseded   impossible: a pending action must be approved or rejected
//   rejected   → superseded   impossible
//   superseded → approved     impossible
//   superseded → rejected     impossible
//   rejected   → approved     still impossible
//   claimed    → superseded   impossible: once execution is claimed, supersession is too late
//   released   → superseded   impossible
//
// And two positive properties that matter as much:
//
//   • THE ORIGINAL DECISION EVIDENCE SURVIVES. `resolution` holds the approver's own words; the
//     supersession is recorded beside it, never over it. An evidence trail that can only say one
//     of "the CEO approved this payload" and "a later invariant made it ineligible" says the
//     wrong one.
//   • THE BUSINESS INTENT IS NOT CONSUMED. A superseded, never-claimed preparation must leave the
//     same (RFQ, supplier) preparable again — that is the whole reason this exists — while the
//     external send's UNIQUE (rfq_id, supplier_id) stays exactly as strong.
'use strict';

const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(String(d).split('\n').slice(0, 4).map((l) => '          ' + l).join('\n')); };
const note = (m) => console.log(`  --    ${m}`);

const findInitdb = pgBin;

let temp = null;
function startTemp() {
  const dir = findInitdb();
  if (!dir) return null;
  const base = fs.mkdtempSync('/var/tmp/supersede-');
  const asRoot = process.getuid && process.getuid() === 0;
  const run = (cmd) => execFileSync('sh', ['-c', asRoot ? `su postgres -c ${JSON.stringify(cmd)}` : cmd], { stdio: 'pipe' });
  try {
    if (asRoot) execFileSync('chown', ['-R', 'postgres', base]);
    run(`PATH=${dir}:$PATH initdb -D ${base}/data ${INITDB_FLAGS}`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log -o '-k ${base} -p 55987 -c listen_addresses=' start -w`);
  } catch (e) { return null; }
  temp = { base, dir, asRoot };
  return `postgresql://postgres@localhost/postgres?host=${base}&port=55987&sslmode=disable`;
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

const url = process.env.SUPERSEDE_PG_URL || startTemp();
if (!url) {
  console.log('  skip  no Postgres available (set SUPERSEDE_PG_URL or install initdb)');
  console.log('SKIP  supersession not exercised — this check needs a server');
  process.exit(EXIT_NOT_EXECUTED);
}
process.env.DATABASE_URL = url;

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
const digestOf = (p) => crypto.createHash('sha256').update(canonical(p)).digest('hex');

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };
  const ids = { companies: [], objectives: [], runs: [], approvals: [] };

  try {
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await q(`CREATE TABLE IF NOT EXISTS supplier_outreach_log (
      id TEXT PRIMARY KEY, rfq_id TEXT, supplier_id TEXT, email_sent_to TEXT, email_subject TEXT,
      email_body TEXT, sent_at TEXT, replied_at TEXT, reply_text TEXT, status TEXT DEFAULT 'sent')`);
    await require('../src/lib/idempotency/supplier-rfq').migrate(q);

    const scope = require('../src/lib/office/scope');
    const approvalMod = require('../src/lib/office/approval');
    const { ledger } = require('../src/lib/run-ledger');
    const L = ledger({ query: q, onDurabilityFailure: () => {} });

    // ── THE SCHEMA MUST ACCEPT THE NEW VALUE AT ALL ────────────────────────
    const chk = (await q(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conname = 'office_approvals_status_check'`)).rows[0];
    if (chk && /superseded/.test(chk.d)) ok("the status CHECK accepts 'superseded'");
    else bad('the status CHECK does not accept the new value', chk && chk.d);
    if (chk && /'rejected'/.test(chk.d) && /'approved'/.test(chk.d) && /'pending'/.test(chk.d)) {
      ok('and still accepts every status it accepted before — the change is additive');
    } else bad('the CHECK dropped a pre-existing status', chk && chk.d);

    let n = 0;
    // One company per case: a single harness-wide company would let one case's rows answer
    // another's question, which is how four earlier controls measured nothing.
    const mk = async ({ decide = 'approved', claim = false, release = false } = {}) => {
      n += 1;
      const CO = `co-sup-${n}`;
      const OID = `obj-sup-${n}`;
      await q(`INSERT INTO companies (id, slug, display_name) VALUES ($1,$1,$1)`, [CO]);
      ids.companies.push(CO);
      await scope.createObjective({ id: OID, companyId: CO, objective: `supersede fixture ${n}`,
        priority: 'P3', kpiMetric: 'q', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 10,
        autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: 'test' }, deps);
      ids.objectives.push(OID);
      await q(`UPDATE objectives SET status='active', release_mode='explicit' WHERE id=$1`, [OID]);
      const begun = await require('../src/lib/office/run').beginObjectiveRun({
        objectiveId: OID, trigger: 'manual', workflow: 'governed-rfq-generation',
        agent: 'procurement-agent', intentKey: `sup-${n}` }, deps);
      ids.runs.push(begun.runId);
      await L.startRun(begun.runId);
      const ctx = begun.context;
      await scope.recordCost(ctx, { runId: begun.runId, provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001', tokensInput: 10, tokensOutput: 10, costUsd: 0.001,
        costKnown: true, agent: 'procurement-agent', workflow: 'governed-rfq-generation' }, deps);
      const apId = `ap-sup-${n}`;
      const payload = {
        rfq_id: `rfq-sup-${n}`, supplier_id: `sup-sup-${n}`, supplier_name: `Supplier ${n}`,
        to: `s${n}@fixture.invalid`, subject: `RFQ ${n}`, body: 'Dear supplier,\n\nPlease quote.',
        approved_molecule_name: 'Candidatium', approved_cas: '36282-47-0',
        signed_by_name: 'A Director', signed_by_email: 'dir@fixture.invalid',
        signed_by_user_id: 'u-dir',
        from: 'A Director <dir@fixture.invalid>', from_email: 'dir@fixture.invalid',
        cc: [], bcc: [],
      };
      await scope.requestApproval(ctx, { id: apId, runId: begun.runId,
        actionKind: 'send_rfq_email', actionPayload: payload,
        reason: 'fixture: a supplier communication requires human approval',
        ownerUserId: 'u-dir' }, deps);
      ids.approvals.push(apId);
      if (decide) {
        await scope.decideApproval(ctx, { id: apId, decision: decide, resolvedBy: 'ceo',
          resolution: `fixture ${decide} — recorded with a reason` }, deps);
      }
      if (claim) {
        await q(`UPDATE office_approvals SET release_claimed_at=NOW(), release_claimed_by='exec'
                 WHERE id=$1`, [apId]);
      }
      if (release) {
        await q(`UPDATE office_approvals SET release_claimed_at=NOW(), release_claimed_by='exec',
                 released_at=NOW(), released_by='exec' WHERE id=$1`, [apId]);
      }
      return { apId, ctx, CO, OID, runId: begun.runId, payload };
    };

    const REASON = 'Superseded after approval and before external execution because the approved '
      + 'immutable payload predates mandatory sender provenance and records no sender.';

    // ══ 1. THE AUTHORIZED TRANSITION ═══════════════════════════════════════
    note('approved + never claimed → superseded, and the original decision survives it');
    {
      const { apId, ctx, payload } = await mk();
      const beforeRow = (await q(`SELECT resolution, resolved_by, resolved_at, action_payload
                                    FROM office_approvals WHERE id=$1`, [apId])).rows[0];
      const beforeDigest = digestOf(beforeRow.action_payload);

      const done = await scope.supersedeApproval(ctx, { approvalId: apId,
        supersededBy: 'naren', reason: REASON }, deps);
      if (done && done.status === 'superseded') ok('an approved, never-claimed action is superseded');
      else bad('the authorized transition failed', JSON.stringify(done));
      if (done && done.previous_status === 'approved') ok('and records what it came from');
      else bad('previous_status was not recorded', done && done.previous_status);
      if (done && done.superseded_reason === REASON) ok('and the mandatory reason is PERSISTED');
      else bad('the supersession reason was not persisted');
      if (done && done.superseded_by === 'naren' && done.superseded_at) {
        ok('and the actor and timestamp are attributed to the human, not the system');
      } else bad('the supersession is not attributed');

      // THE ORIGINAL DECISION EVIDENCE. Both facts must be readable from the row.
      const after = (await q(`SELECT status, resolution, resolved_by, resolved_at, action_payload,
                                     superseded_reason FROM office_approvals WHERE id=$1`, [apId])).rows[0];
      if (after.resolution === beforeRow.resolution && after.resolved_by === beforeRow.resolved_by) {
        ok('the ORIGINAL approval resolution and approver are untouched — the supersession sits '
          + 'beside the decision, not over it');
      } else bad('the original decision evidence was overwritten',
        `${beforeRow.resolution} → ${after.resolution}`);
      if (after.resolution && after.superseded_reason && after.resolution !== after.superseded_reason) {
        ok('so the trail answers BOTH "who approved it and why" and "what superseded it and why"');
      } else bad('the two events cannot both be read from the row');
      if (digestOf(after.action_payload) === beforeDigest) {
        ok('and the frozen payload is byte-for-byte unchanged');
      } else bad('THE PAYLOAD CHANGED during supersession');

      // ── TERMINAL ────────────────────────────────────────────────────────
      let threw = null;
      const again = await scope.supersedeApproval(ctx, { approvalId: apId,
        supersededBy: 'naren', reason: REASON }, deps).catch((e) => { threw = e; return null; });
      if (!again && !threw) ok('superseded → superseded is refused: the transition is terminal');
      else bad('a superseded action was superseded again', threw ? threw.message : JSON.stringify(again));

      for (const d of ['approved', 'rejected']) {
        const re = await scope.decideApproval(ctx, { id: apId, decision: d, resolvedBy: 'ceo',
          resolution: 'attempting to re-decide a superseded action' }, deps).catch(() => null);
        if (!re) ok(`superseded → ${d} is refused — decideApproval still requires pending`);
        else bad(`a superseded action was re-decided into ${d}`, JSON.stringify(re));
      }

      // ── AND IT CANNOT RELEASE ───────────────────────────────────────────
      const rel = await approvalMod.release(ctx, { approvalId: apId, releasedBy: 'exec',
        consequential: false }, deps);
      if (!rel.released && rel.reason === 'superseded') {
        ok('a superseded action cannot release, and the refusal NAMES the state');
      } else if (!rel.released) {
        bad('it refused but not by name — an operator would look for a missing approval instead '
          + 'of a completed governance decision', rel.reason);
      } else bad('A SUPERSEDED ACTION RELEASED');
      const claimRows = (await q(`SELECT COUNT(*)::int n FROM supplier_outreach_log
        WHERE rfq_id=$1 AND supplier_id=$2`, [payload.rfq_id, payload.supplier_id])).rows[0].n;
      if (claimRows === 0) ok('and no supplier claim, no outreach — supersession is not an action');
      else bad(`${claimRows} claim row(s) exist after a supersession`);
    }

    // ══ 2. WHAT MUST REMAIN IMPOSSIBLE ═════════════════════════════════════
    note('every other transition into superseded stays impossible');
    {
      const pend = await mk({ decide: null });
      const r = await scope.supersedeApproval(pend.ctx, { approvalId: pend.apId,
        supersededBy: 'naren', reason: REASON }, deps);
      if (!r) ok('pending → superseded is refused: a pending action must be approved or rejected');
      else bad('a PENDING action was superseded', JSON.stringify(r));
      const st = (await q(`SELECT status FROM office_approvals WHERE id=$1`, [pend.apId])).rows[0].status;
      if (st === 'pending') ok('  and it is still pending');
      else bad(`  its status changed to ${st}`);
    }
    {
      const rej = await mk({ decide: 'rejected' });
      const r = await scope.supersedeApproval(rej.ctx, { approvalId: rej.apId,
        supersededBy: 'naren', reason: REASON }, deps);
      if (!r) ok('rejected → superseded is refused');
      else bad('a REJECTED action was superseded', JSON.stringify(r));
      // And the pre-existing invariant is still intact.
      const re = await scope.decideApproval(rej.ctx, { id: rej.apId, decision: 'approved',
        resolvedBy: 'ceo', resolution: 'attempting to approve a rejected action' }, deps).catch(() => null);
      if (!re) ok('rejected → approved remains impossible — adding a status did not widen that');
      else bad('A REJECTED ACTION WAS APPROVED', JSON.stringify(re));
    }
    {
      const claimed = await mk({ claim: true });
      const r = await scope.supersedeApproval(claimed.ctx, { approvalId: claimed.apId,
        supersededBy: 'naren', reason: REASON }, deps);
      if (!r) ok('claimed → superseded is refused: once execution is claimed, supersession is too late');
      else bad('A CLAIMED action was superseded', JSON.stringify(r));
    }
    {
      const released = await mk({ release: true });
      const r = await scope.supersedeApproval(released.ctx, { approvalId: released.apId,
        supersededBy: 'naren', reason: REASON }, deps);
      if (!r) ok('released → superseded is refused');
      else bad('A RELEASED action was superseded', JSON.stringify(r));
    }
    {
      // THE OUTREACH LOG IS THE STRONGER SOURCE OF TRUTH. An approval whose control-plane
      // timestamps are both NULL but which HAS an external claim row must still be refused —
      // the claim is written by a different code path at a different moment, precisely so a crash
      // between them is visible, and trusting the nullable timestamps alone would supersede an
      // action whose letter may already have gone out.
      const sneaky = await mk();
      await q(`INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, status, approval_id)
               VALUES ($1,$2,$3,'pending',$4)`,
        [`sol-${sneaky.apId}`, sneaky.payload.rfq_id, sneaky.payload.supplier_id, sneaky.apId]);
      const r = await scope.supersedeApproval(sneaky.ctx, { approvalId: sneaky.apId,
        supersededBy: 'naren', reason: REASON }, deps);
      if (!r) {
        ok('an approval with NULL release timestamps but an EXISTING outreach claim is still '
          + 'refused — the claim table is in the predicate, not merely trusted to agree');
      } else bad('supersession trusted the control-plane timestamps over the outreach log',
        JSON.stringify(r));
    }
    {
      // A supersession with no author or no reason is not evidence.
      const x = await mk();
      let threwActor = false; let threwReason = false;
      await scope.supersedeApproval(x.ctx, { approvalId: x.apId, reason: REASON }, deps)
        .catch(() => { threwActor = true; });
      await scope.supersedeApproval(x.ctx, { approvalId: x.apId, supersededBy: 'naren', reason: 'x' }, deps)
        .catch(() => { threwReason = true; });
      if (threwActor) ok('a supersession with no actor is refused');
      else bad('a supersession was recorded with no author');
      if (threwReason) ok('and one with no meaningful reason is refused');
      else bad('a supersession was recorded with a meaningless reason');
      const st = (await q(`SELECT status FROM office_approvals WHERE id=$1`, [x.apId])).rows[0].status;
      if (st === 'approved') ok('  and neither attempt changed the row');
      else bad(`  the row changed to ${st}`);
    }

    // ══ 3. THE BUSINESS INTENT IS NOT CONSUMED ═════════════════════════════
    //
    // The reason supersession exists at all. A superseded, never-claimed preparation must leave the
    // same (RFQ, supplier) preparable again — three real suppliers were permanently consumed by
    // defects in our own code before this distinction existed.
    note('a superseded attempt does not consume the business intent');
    {
      const rfqMod = require('../src/lib/office/procurement-rfq');
      const first = await mk();
      await scope.supersedeApproval(first.ctx, { approvalId: first.apId,
        supersededBy: 'naren', reason: REASON }, deps);

      const prior = await scope.rfqApprovalsForEligibility(first.payload.rfq_id, deps);
      const blocked = rfqMod.intentBlockedBy(prior, first.payload.supplier_id);
      if (!blocked) ok('a SUPERSEDED attempt does not block a new preparation for the same intent');
      else bad('a superseded attempt still blocks the intent', JSON.stringify(blocked));
      const attempt = rfqMod.nextAttempt(prior, first.payload.supplier_id);
      if (attempt === 2) ok('and the next preparation is attempt 2, with its own approval identity');
      else bad(`the attempt number did not advance (got ${attempt})`);

      // THE EXTERNAL SEND'S UNIQUENESS IS UNCHANGED. Preparation attempts and actual outreach are
      // different things, and only the first was relaxed.
      const idx = (await q(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_supplier_outreach_rfq_supplier'`)).rows[0];
      if (idx && /UNIQUE/.test(idx.indexdef) && /rfq_id/.test(idx.indexdef)
          && /supplier_id/.test(idx.indexdef) && !/WHERE/.test(idx.indexdef)) {
        ok('UNIQUE (rfq_id, supplier_id) on the outreach log is unchanged and unconditional — one '
          + 'external send per pair, for ever');
      } else bad('the external-send uniqueness changed', idx && idx.indexdef);
    }

    // ══ 4. MUTATION CONTROLS ═══════════════════════════════════════════════
    note('mutation controls: remove each predicate, prove the defect returns');
    const SCOPEF = path.join(__dirname, '..', 'src', 'lib', 'office', 'scope.js');
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const fresh = () => { for (const k of Object.keys(require.cache)) if (k.includes(path.join('src', 'lib', 'office'))) delete require.cache[k]; };

    // M1 — remove the status='approved' predicate. A PENDING action must then become supersedable,
    // which would let a supersession stand in for a human decision that never happened.
    {
      const before = sha(SCOPEF); const src = fs.readFileSync(SCOPEF, 'utf8');
      const anchor = "        AND a.status = 'approved'";
      if (!src.includes(anchor)) bad('M1 could not locate the approved predicate — the control is stale');
      else {
        fs.writeFileSync(SCOPEF, src.replace(anchor, ''));
        try {
          fresh();
          const mutated = require('../src/lib/office/scope');
          const pend = await mk({ decide: null });
          const r = await mutated.supersedeApproval(pend.ctx, { approvalId: pend.apId,
            supersededBy: 'naren', reason: REASON }, deps);
          if (r && r.status === 'superseded') {
            ok('M1 without the approved predicate a PENDING action is superseded — a supersession '
              + 'would stand in for a decision nobody made. The predicate is load-bearing');
          } else bad('M1 the pending action was still refused, so the predicate was not measured',
            JSON.stringify(r));
        } finally { fs.writeFileSync(SCOPEF, src); fresh(); }
      }
      if (sha(SCOPEF) !== before) bad('M1 scope.js was NOT restored byte-for-byte');
      else ok('M1 scope.js restored, verified by content hash');
    }

    // M2 — remove the never-claimed predicates. An action already claimed for release must then
    // become supersedable, which is the one ordering that must never be possible.
    {
      const before = sha(SCOPEF); const src = fs.readFileSync(SCOPEF, 'utf8');
      const anchors = ['        AND a.release_claimed_at IS NULL', '        AND a.released_at IS NULL'];
      const missing = anchors.filter((a) => !src.includes(a));
      if (missing.length) bad('M2 could not locate the never-claimed predicates — the control is stale');
      else {
        let m = src; for (const a of anchors) m = m.replace(a, '');
        fs.writeFileSync(SCOPEF, m);
        try {
          fresh();
          const mutated = require('../src/lib/office/scope');
          const claimed = await mk({ claim: true });
          const r = await mutated.supersedeApproval(claimed.ctx, { approvalId: claimed.apId,
            supersededBy: 'naren', reason: REASON }, deps);
          if (r && r.status === 'superseded') {
            ok('M2 without the never-claimed predicates an action ALREADY CLAIMED for release is '
              + 'superseded — supersession after execution began. They are load-bearing');
          } else bad('M2 the claimed action was still refused, so the predicates were not measured',
            JSON.stringify(r));
        } finally { fs.writeFileSync(SCOPEF, src); fresh(); }
      }
      if (sha(SCOPEF) !== before) bad('M2 scope.js was NOT restored byte-for-byte');
      else ok('M2 scope.js restored, verified by content hash');
    }

    // M3 — remove the outreach-log clause. An approval with an external claim but NULL control
    // plane timestamps must then become supersedable: the exact case the clause exists for.
    {
      const before = sha(SCOPEF); const src = fs.readFileSync(SCOPEF, 'utf8');
      // THE WHOLE CLAUSE IS REPLACED, not prepended to. The first version inserted a second,
      // trivially-false NOT EXISTS in front of the real one and left it intact, so the statement
      // still refused and the case failed honestly — a mutation that does not take measures
      // nothing, which is why the assertion checks that the defect RETURNS rather than that
      // something was edited.
      const anchor = [
        '        AND NOT EXISTS (',
        '          SELECT 1 FROM supplier_outreach_log s',
        "           WHERE s.approval_id = a.id",
        "              OR (s.rfq_id = a.action_payload->>'rfq_id'",
        "                  AND s.supplier_id = a.action_payload->>'supplier_id'))",
      ].join('\n');
      if (!src.includes(anchor)) bad('M3 could not locate the outreach-log clause — the control is stale');
      else {
        fs.writeFileSync(SCOPEF, src.replace(anchor, '        AND NOT EXISTS (SELECT 1 WHERE false)'));
        try {
          fresh();
          const mutated = require('../src/lib/office/scope');
          const sneaky = await mk();
          await q(`INSERT INTO supplier_outreach_log (id, rfq_id, supplier_id, status, approval_id)
                   VALUES ($1,$2,$3,'pending',$4)`,
            [`sol-m3-${sneaky.apId}`, sneaky.payload.rfq_id, sneaky.payload.supplier_id, sneaky.apId]);
          const r = await mutated.supersedeApproval(sneaky.ctx, { approvalId: sneaky.apId,
            supersededBy: 'naren', reason: REASON }, deps);
          if (r && r.status === 'superseded') {
            ok('M3 with the outreach clause neutralized, an approval holding an EXTERNAL CLAIM is '
              + 'superseded on the strength of two NULL timestamps. The clause is load-bearing');
          } else bad('M3 it was still refused, so the clause was not measured', JSON.stringify(r));
        } finally { fs.writeFileSync(SCOPEF, src); fresh(); }
      }
      if (sha(SCOPEF) !== before) bad('M3 scope.js was NOT restored byte-for-byte');
      else ok('M3 scope.js restored, verified by content hash');
    }

    // M4 — allow a superseded action to release. The release claim's own predicate is what stops
    // it, and this proves that rather than trusting the status check in approval.js.
    {
      const SCOPE2 = SCOPEF;
      const before = sha(SCOPE2); const src = fs.readFileSync(SCOPE2, 'utf8');
      // claimApprovalRelease writes `AND status = 'approved'` with no table alias;
      // supersedeApproval writes `AND a.status = 'approved'`. The two are textually distinct, so
      // this mutation cannot reach the wrong one — verified by the occurrence count below.
      const anchor = "        AND status = 'approved'\n";
      const hits = src.split(anchor).length - 1;
      if (hits !== 1) bad(`M4 the release-claim predicate anchor matches ${hits} times — stale or ambiguous`);
      else {
        fs.writeFileSync(SCOPE2, src.replace(anchor, ''));
        try {
          fresh();
          const mutatedScope = require('../src/lib/office/scope');
          const mutatedApproval = require('../src/lib/office/approval');
          const s = await mk();
          await mutatedScope.supersedeApproval(s.ctx, { approvalId: s.apId,
            supersededBy: 'naren', reason: REASON }, deps);
          const rel = await mutatedApproval.release(s.ctx, { approvalId: s.apId,
            releasedBy: 'exec', consequential: false }, deps);
          if (rel.released) {
            ok('M4 without the approved predicate in the release claim, a SUPERSEDED action '
              + 'releases — the claim predicate is what makes supersession terminal');
          } else bad('M4 it still refused, so the release predicate was not what blocks it', rel.reason);
        } finally { fs.writeFileSync(SCOPE2, src); fresh(); }
      }
      if (sha(SCOPE2) !== before) bad('M4 scope.js was NOT restored byte-for-byte');
      else ok('M4 scope.js restored, verified by content hash');
    }
  } catch (e) {
    bad('unexpected error', e.stack || e.message);
  } finally {
    try {
      for (const id of ids.runs) {
        await q(`DELETE FROM office_approvals WHERE run_id=$1`, [id]).catch(() => {});
        await q(`DELETE FROM office_cost_ledger WHERE run_id=$1`, [id]).catch(() => {});
        await q(`DELETE FROM office_exceptions WHERE run_id=$1`, [id]).catch(() => {});
      }
      await q(`ALTER TABLE agent_run_events DISABLE TRIGGER trg_agent_run_events_append_only`).catch(() => {});
      try {
        for (const id of ids.runs) await q(`DELETE FROM agent_run_events WHERE run_id=$1`, [id]).catch(() => {});
        for (const id of ids.runs) await q(`DELETE FROM agent_runs WHERE run_id=$1`, [id]).catch(() => {});
      } finally {
        await q(`ALTER TABLE agent_run_events ENABLE TRIGGER trg_agent_run_events_append_only`).catch(() => {});
      }
      for (const id of ids.objectives) await q(`DELETE FROM objectives WHERE id=$1`, [id]).catch(() => {});
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id=$1`, [id]).catch(() => {});

      // Only my rows, by id. Never "is the table empty".
      const mine = (await q(`SELECT
        (SELECT COUNT(*) FROM office_approvals WHERE id = ANY($1)) a,
        (SELECT COUNT(*) FROM objectives WHERE id = ANY($2)) b,
        (SELECT COUNT(*) FROM companies WHERE id = ANY($3)) c`,
        [ids.approvals, ids.objectives, ids.companies])).rows[0];
      if (Number(mine.a) + Number(mine.b) + Number(mine.c) === 0) {
        ok('cleanup: every fixture row I created is gone (by id)');
      } else bad('fixture cleanup leaked', JSON.stringify(mine));
    } catch (e) { bad('cleanup failed', e.message); }
    try { await P.end(); } catch (_) {}
    stopTemp();
  }

  console.log(fail
    ? `\nFAIL  ${fail} supersession assertion(s) failed`
    : '\nPASS  supersession is exactly one transition: approved and never externally claimed → '
      + 'superseded.\n      The original decision survives it, the payload is untouched, it is '
      + 'terminal, it cannot\n      release, and it does not consume the business intent.');
  process.exit(fail ? 1 : 0);
})();
