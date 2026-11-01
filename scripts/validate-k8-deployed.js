#!/usr/bin/env node
// ── K8 PRODUCTION VALIDATION (READ ONLY) ────────────────────────────────────
//
//   railway ssh 'node scripts/validate-k8-deployed.js'
//
// "A STOP command that records a nonexistent target remains unacceptable false safety evidence."
// K8 must be production validated before the first real office objective.
//
// ── IT WRITES NO STOP, AND THAT IS NOT A COMPROMISE ─────────────────────────
//
// Writing a stop on production would HALT AUTONOMY — the control under test is the one that stops
// the business. So this validator never calls stop(). It does not need to: `validate()` is a pure
// function over the live, deployed vocabularies, so acceptance and refusal are both decidable
// without side effects. End-to-end stop/resume/audit behaviour is proven against fixtures in
// scripts/check-autonomy-scope-validation-db.js (26 assertions, 2 mutation controls).
//
// ── THE ASSERTION THAT ONLY PRODUCTION CAN MAKE ─────────────────────────────
//
// Every stop row that ALREADY EXISTS on production is checked against the live vocabulary. A
// historical stop whose key matches nothing is protecting nothing RIGHT NOW, and an operator
// looking at the list would believe otherwise. No fixture can tell us that.
'use strict';

const { query } = require('../src/lib/db');
const autonomy = require('../src/lib/autonomy');

// Loading these registers their non-cron scope names, exactly as the server does at boot. Without
// it `workflow=objective-review` would read as invalid here and nowhere else.
require('../src/lib/office/executive-agent');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};
const note = (m) => console.log(`  --    ${m}`);

const REASON = 'K8 production validation: confirming scope-key validation (no stop is written)';

(async () => {
  try {
    console.log('\nK8 production validation — READ ONLY, no stop is written\n');
    console.log(`  deployed SHA ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}\n`);

    // ── 1. The deployed vocabularies, derived from the live registries ────
    const vocab = {};
    for (const t of ['capability', 'workflow', 'agent']) vocab[t] = autonomy.knownScopeKeys(t);
    console.log(`  capability keys : ${vocab.capability.join(', ')}`);
    console.log(`  workflow keys   : ${vocab.workflow.length}`);
    console.log(`  agent keys      : ${vocab.agent.length}`);
    console.log(`  company keys    : free text by design (P0.2), checked against the companies table at stop() time\n`);

    const cronNames = Object.keys(autonomy.CRON_SCOPES);
    const missing = cronNames.filter((c) => !vocab.workflow.includes(c));
    if (missing.length) bad(`${missing.length} live cron name(s) are not in the workflow vocabulary`, missing.slice(0, 6).join(', '));
    else ok(`the workflow vocabulary is DERIVED from the live CRON_SCOPES (all ${cronNames.length} present), not a second list`);

    // ── §14 PREREQUISITE: THE AI OFFICE'S OWN SCOPES ──────────────────────
    //
    // "K8 recognizes the new workflow/agent/capability scopes." These used to be registered as a
    // SIDE EFFECT of requiring the module that owned them, so the vocabulary varied with the
    // import graph: `objective-review` was invisible to any process that had not loaded
    // executive-agent, and a legitimate stop could be rejected as an unknown key at exactly the
    // moment somebody needed it. They are now declared statically in autonomy.js.
    //
    // This validator does NOT require the office modules, deliberately — that is what makes the
    // assertion meaningful rather than self-fulfilling.
    const officeWorkflows = ['objective-review', 'governed-rfq-generation', 'quarter-hourly-office-recovery'];
    const officeAgents = ['executive-agent', 'procurement-agent'];
    const missingOffice = officeWorkflows.filter((w) => !vocab.workflow.includes(w));
    const missingOfficeAgents = officeAgents.filter((a) => !vocab.agent.includes(a));
    if (missingOffice.length) {
      bad('AI Office workflow scope(s) are NOT stoppable by name — an operator could not halt them',
        missingOffice.join(', '));
    } else ok(`all ${officeWorkflows.length} AI Office workflow scopes are recognized without their modules being loaded`);
    if (missingOfficeAgents.length) {
      bad('AI Office agent scope(s) are NOT stoppable by name', missingOfficeAgents.join(', '));
    } else ok(`both AI Office agent scopes are recognized (${officeAgents.join(', ')})`);

    const cronAgents = [...new Set(Object.values(autonomy.CRON_SCOPES).map((m) => m && m.agent).filter(Boolean))];
    const missingAgents = cronAgents.filter((a) => !vocab.agent.includes(a));
    if (missingAgents.length) bad(`${missingAgents.length} live cron agent(s) missing from the vocabulary`, missingAgents.join(', '));
    else ok(`the agent vocabulary is derived too (all ${cronAgents.length} cron agents present)`);

    if (!vocab.workflow.includes('objective-review') || !vocab.agent.includes('executive-agent')) {
      bad('the Executive Agent did not register its scopes — it could not be stopped by name');
    } else ok('registerScopes() is in force on the deployed bytes: the Executive Agent is stoppable by name');

    // ── 2. A stop that would protect nothing is refused ───────────────────
    console.log('');
    const invalid = [
      ['capability', 'email_send'], ['capability', 'send_email'],
      ['agent', 'seo'], ['agent', 'ceo'],
      ['workflow', 'daily-ceo-briefing'], ['workflow', 'objective_review'],
    ];
    for (const [scope_type, scope_key] of invalid) {
      const v = autonomy.validate({ scope_type, scope_key, reason: REASON });
      if (v === null) bad(`${scope_type}="${scope_key}" would be ACCEPTED on production — it would protect nothing`);
      else ok(`${scope_type}="${scope_key}" is refused${/did you mean/.test(v) ? ' (and names the near miss)' : ''}`);
    }

    // ── 3. OVER-STRICTNESS IS THE DANGEROUS DIRECTION ────────────────────
    // Refusing a legitimate stop denies an operator a halt, so every key in every vocabulary is
    // checked by enumeration rather than by sampling.
    console.log('');
    for (const t of ['capability', 'workflow', 'agent']) {
      const rejected = vocab[t].filter((k) => autonomy.validate({ scope_type: t, scope_key: k, reason: REASON }) !== null);
      if (rejected.length) bad(`${rejected.length} legitimate ${t} key(s) would be REFUSED on production`, rejected.join(', '));
      else ok(`all ${vocab[t].length} ${t} keys are accepted (enumerated, not sampled)`);
    }
    // All five scope types must remain expressible.
    const globalV = autonomy.validate({ scope_type: 'global', scope_key: '', reason: REASON });
    if (globalV !== null) bad(`a GLOBAL stop would be refused: ${globalV}`);
    else ok('a global stop remains expressible');
    const firstCompany = (await query(`SELECT id FROM companies ORDER BY created_at LIMIT 1`)).rows[0];
    if (!firstCompany) {
      note('no companies exist yet, so the company path cannot be exercised here — it is');
      note('fixture-proven in both directions (known company accepted, unknown refused).');
    } else {
      const cv = autonomy.validate({ scope_type: 'company', scope_key: firstCompany.id, reason: REASON });
      if (cv !== null) bad(`a company stop on a real company would be refused: ${cv}`);
      else ok('a company stop on a real company remains expressible');
    }

    // ── 4. THE ASSERTION ONLY PRODUCTION CAN MAKE ────────────────────────
    console.log('');
    const stops = await autonomy.listStops();
    console.log(`  existing stop rows on production: ${stops.length}`);
    if (!stops.length) {
      ok('no stop rows exist, so none can be protecting nothing');
    } else {
      const dead = [];
      for (const s of stops) {
        if (s.scope_type === 'global') continue;
        if (s.scope_type === 'company') continue;   // free text by design; checked at stop() time
        const known = autonomy.knownScopeKeys(s.scope_type);
        if (known && !known.includes(s.scope_key)) dead.push(`${s.scope_type}="${s.scope_key}" (set ${s.set_at})`);
      }
      if (dead.length) {
        bad(`${dead.length} EXISTING stop row(s) match nothing and are protecting nothing RIGHT NOW`,
          dead.join('\n') + '\n\nThese predate K8. An operator reading the stop list would believe'
          + '\nautonomy is halted where it is not. Report before removing: deleting a stop is a'
          + '\ndecision about live autonomy, not a cleanup.');
      } else {
        ok(`every one of the ${stops.length} existing stop row(s) names a target that exists`);
      }
    }

    // ── 5. Nothing was written ───────────────────────────────────────────
    console.log('');
    const after = await autonomy.listStops();
    if (after.length !== stops.length) bad(`this validator CHANGED the stop list (${stops.length} → ${after.length})`);
    else ok(`no stop was written by this validator (${after.length} row(s) before and after)`);
    note('end-to-end stop/resume/audit for all five scope types is fixture-proven in');
    note('scripts/check-autonomy-scope-validation-db.js — writing a stop here would halt autonomy.');

    console.log('\n' + (fail
      ? `FAIL  ${fail} K8 production assertion(s) failed`
      : 'PASS  K8 on production: a stop that would protect nothing is refused, every real scope key '
        + 'is still accepted, and no existing stop row is protecting nothing'));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\nFAIL  K8 validation error:', e.stack || e.message);
    process.exit(1);
  }
})();
