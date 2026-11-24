#!/usr/bin/env node
// ── A REVIEWABLE WORKFLOW → COMPANY PROPOSAL. IT ASSIGNS NOTHING. ───────────
//
//   node scripts/propose-workflow-company-mappings.js            # proposal from code only
//   node scripts/propose-workflow-company-mappings.js --db       # …also read current mappings
//
//   exit 0 = a proposal was produced
//   exit 3 = NOT EXECUTED (asked for --db without a readable database)
//
// Owner requirement 7, Option A: "Prepare a reviewable mapping proposal for all registered
// production workflows. Do not automatically assign production workflows to companies."
//
// So this script is READ-ONLY by construction. It contains no INSERT, no UPDATE and no call to
// mapWorkflowToCompany — scripts/check-proposal-is-readonly.test.js asserts that, because a tool
// that proposes and applies in one step is a tool whose dry run nobody reads.
//
// ── WHERE THE PROPOSED COMPANY COMES FROM ───────────────────────────────────
//
// Not from me. `CRON_SCOPES` in src/lib/autonomy.js already declares a company slug per cron —
// `sam-gov-harvest-3h → abiozen` — which exists for STOP scoping. Seeding the proposal from that
// means every suggested row is something somebody already wrote down, and the review is "is this
// still right", not "is this invented". A cron whose declared company is null gets NO proposal and
// is listed as needing a decision, because a null is an absence, not a vote for the default.
//
// ── A SECOND AUTHORIZATION MODEL, FLAGGED RATHER THAN CREATED ───────────────
//
// `CRON_SCOPES[*].company` and `workflow_companies` now both say which company a workflow belongs
// to, and the owner's instruction is explicit: do not create a second competing company
// authorization model. These are not yet in conflict — the former is a static STOP-scope label in
// code, the latter is a revocable authorization with an administrator behind it — but they will
// disagree the first time one is edited and the other is not.
//
// This script reports any divergence under DIVERGENCE below, and the recommendation it carries is
// that `workflow_companies` becomes authoritative and CRON_SCOPES.company is derived from it or
// removed. That is a decision for the owner, so it is reported, not taken.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WANT_DB = process.argv.includes('--db');
const OUT_DIR = path.join(__dirname, '..', 'docs', 'deploy');
const OUT_JSON = path.join(OUT_DIR, 'workflow-company-proposal.json');

const { CRON_SCOPES } = require('../src/lib/autonomy');

// Workflows that send outside the company. Their mapping matters most, because the company decides
// who counts as internal and therefore which sends need a released approval.
const EXTERNAL_SENDERS = new Set([
  'cphi-followup', 'legacy-inquiry-buyer-email', 'outreach-send', 'supplier-rfq',
]);

(async () => {
  const rows = [];
  for (const [workflow, scope] of Object.entries(CRON_SCOPES)) {
    rows.push({
      workflow,
      declaredCompanySlug: scope.company || null,
      agent: scope.agent || null,
      sendsExternally: EXTERNAL_SENDERS.has(workflow),
      proposal: scope.company ? 'map_to_declared_company' : 'NEEDS_A_DECISION',
    });
  }

  let current = null;
  let companiesBySlug = null;
  if (WANT_DB) {
    try {
      const { query } = require('../src/lib/db');
      const WF = require('../src/lib/identity/workflow-company');
      const live = await WF.allMappings({ query });
      if (live === WF.UNKNOWN) throw new Error('workflow_companies could not be read');
      current = live;
      const cs = await query(`SELECT id, slug, status FROM companies ORDER BY slug`);
      companiesBySlug = Object.fromEntries(cs.rows.map((c) => [c.slug, c]));
    } catch (e) {
      console.error(`  skip  --db requested but the database could not be read: ${e.message}`);
      console.error('SKIP  proposal not produced against live mappings');
      process.exit(3);
    }
  }

  // ── DIVERGENCE: the two places that name a company for a workflow ─────────
  const divergence = [];
  if (current) {
    const mappedByWorkflow = new Map();
    for (const m of current) {
      if (!mappedByWorkflow.has(m.workflow)) mappedByWorkflow.set(m.workflow, []);
      mappedByWorkflow.get(m.workflow).push(m.companyId);
    }
    for (const r of rows) {
      const mapped = mappedByWorkflow.get(r.workflow) || [];
      r.currentlyMappedTo = mapped;
      const declaredId = r.declaredCompanySlug && companiesBySlug[r.declaredCompanySlug]
        ? companiesBySlug[r.declaredCompanySlug].id : null;
      if (declaredId && mapped.length && !mapped.includes(declaredId)) {
        divergence.push(`${r.workflow}: CRON_SCOPES says ${r.declaredCompanySlug} `
          + `(${declaredId}) but workflow_companies says ${mapped.join(', ')}`);
      }
      if (mapped.length) r.proposal = 'already_mapped';
    }
  }

  const needsDecision = rows.filter((r) => r.proposal === 'NEEDS_A_DECISION');
  const proposed = rows.filter((r) => r.proposal === 'map_to_declared_company');
  const already = rows.filter((r) => r.proposal === 'already_mapped');

  const report = {
    generatedAt: new Date().toISOString(),
    note: 'PROPOSAL ONLY. Nothing here has been applied. Each row becomes a workflow_companies '
      + 'authorization only when an authorized administrator maps it, which is a separate, '
      + 'audited action.',
    registeredWorkflows: rows.length,
    counts: { proposed: proposed.length, needsDecision: needsDecision.length,
      alreadyMapped: already.length },
    divergenceBetweenCronScopesAndMappings: divergence,
    recommendation:
      'Make workflow_companies authoritative and derive or retire CRON_SCOPES[*].company. Two '
      + 'places naming a company for the same workflow will disagree the first time one is edited '
      + 'and the other is not, and the static one cannot be revoked by an administrator.',
    rows,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`  ${rows.length} registered workflow(s)`);
  console.log(`  ${proposed.length} with a declared company → proposed (NOT applied)`);
  console.log(`  ${needsDecision.length} with NO declared company → need an owner decision`);
  if (current) console.log(`  ${already.length} already mapped in workflow_companies`);
  if (needsDecision.length) {
    console.log('\n  Needing a decision (no company declared anywhere):');
    for (const r of needsDecision.slice(0, 50)) {
      console.log(`    ${r.workflow}${r.sendsExternally ? '   ** SENDS EXTERNALLY **' : ''}`);
    }
  }
  if (divergence.length) {
    console.log('\n  DIVERGENCE — two sources name different companies:');
    for (const d of divergence) console.log(`    ${d}`);
  }
  console.log(`\n  written: ${path.relative(path.join(__dirname, '..'), OUT_JSON)}`);
  console.log('\nOK: proposal produced. Nothing was assigned — mapping is a separate audited action.');
  process.exit(0);
})();
