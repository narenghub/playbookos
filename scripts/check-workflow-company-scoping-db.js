#!/usr/bin/env node
// ── A COMPANY LABEL MUST MEAN THE WORK IS COMPANY-SCOPED ────────────────────
//
//   node scripts/check-workflow-company-scoping-db.js
//     exit 0 = no workflow carries a company mapping while its implementation ignores companies
//     exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner condition, 2026-11-24, on approving the four Group A workflow mappings:
//
//   "Verify that their actual queries, assignments, reporting and recipients are company-scoped,
//    not merely that their email recipients pass the gate."
//
// That condition is not met today, and this check is what makes the gap impossible to forget.
//
// ── WHAT WAS MEASURED ───────────────────────────────────────────────────────
//
// The three modules implementing all four Group A workflows — src/lib/jobs.js,
// src/lib/agents/orchestrator.js, src/lib/kpi-engine.js — contain **zero** references to
// `company_id`. Segments are ROLE-based (`SEGMENT_ROLES`: procurement_ist, dev_seo_ist, us_team),
// not company-based. So:
//
//   · scoreAllAndCoach selects every active non-admin user with no company filter, scores them and
//     mails each one. A GolfNex or Adifice employee is scored and coached by a workflow labelled
//     ABIOZEN.
//   · runMorningBriefing({segment:'us_team'}) assigns tasks and generates KPIs by ROLE, so the same
//     applies to task assignment, not only to mail.
//   · metrics-snapshot sums `orders` and averages `performance_scores` across every company into
//     one row, which then feeds the CEO briefing and the Command Center as though it were one
//     company's revenue and one team's performance.
//
// Mapping those workflows to ABIOZEN therefore buys exactly one thing: their recipients stop
// classifying as external. The work itself stays cross-company. That is the false assurance the
// owner's condition is written to prevent — a workflow wearing a company label whose queries span
// five companies.
//
// ── WHY THIS IS A TRIPWIRE RATHER THAN A FAILING CHECK ──────────────────────
//
// It exits 0 today, because no mapping has been applied: there is no false assurance yet, and a
// check that is red from birth gets disabled rather than fixed. It goes red the moment a
// `workflow_companies` row exists for a workflow whose implementation has no company scoping —
// which is precisely the mistake to catch, at precisely the moment it is made.
//
// It proves it can fire by INSERTING the four approved mappings as FIXTURES against a disposable
// cluster and asserting that each one is reported. Guards get verified against fixtures you create
// (CLAUDE.md), never against live state, and these fixtures are removed by id.
//
// ── THE IMPLEMENTATION MAP ──────────────────────────────────────────────────
//
// Hand-declared, with the reason for each entry, because deriving "which module implements this
// cron" from server.js by parsing would be a second, fragile model of the call graph. The map is
// asserted COMPLETE against the mapped workflows, so a new mapping with no entry fails loudly
// rather than passing silently — the same discipline the accessor checks use for exemptions.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const ROOT = path.join(__dirname, '..');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);

/**
 * Workflow → the modules that do its work, and why those are the ones that matter.
 *
 * "Does its work" means: selects the people or records the workflow acts on. A module that only
 * formats or transports is not listed, because transport is already governed by the email gate —
 * and the owner's point is that the gate is not the thing in question.
 */
const IMPLEMENTED_BY = Object.freeze({
  'daily-7cst-ceo-briefing': {
    modules: ['src/lib/agents/orchestrator.js', 'src/lib/agents/ceo-agent.js'],
    why: 'runMorningBriefing({segment:"ceo"}) — selects what the CEO is told about',
  },
  'weekdays-8cst-us-team-briefing': {
    modules: ['src/lib/agents/orchestrator.js', 'src/lib/kpi-engine.js'],
    why: 'runMorningBriefing({segment:"us_team"}) — selects WHO is assigned work and which KPIs',
  },
  'daily-18utc-performance-scoring': {
    modules: ['src/lib/jobs.js', 'src/lib/agents/orchestrator.js'],
    why: 'scoreAllAndCoach + runPerformanceCheck — selects who is scored, coached and escalated',
  },
  'weekly-mon-7cst-data-accuracy': {
    modules: ['src/lib/jobs.js'],
    why: 'the weekly data-accuracy report — selects which records are reported on',
  },
  'daily-0utc-metrics-snapshot': {
    modules: ['src/lib/agents/metrics-snapshot.js'],
    why: 'aggregates orders and performance_scores into the figure the briefing quotes. Listed '
      + 'even though the owner classified it Group C, because its data access is NOT '
      + 'platform-level: orders are revenue and performance_scores are employees, and it sums '
      + 'both across every company into one undifferentiated row',
  },
});

/**
 * Is this module company-aware at all? Deliberately generous: a reference to `company_id`, to the
 * membership accessor, or to a resolved context all count. The question is not whether the scoping
 * is CORRECT — a scanner cannot judge that — but whether the module has any notion of a company.
 * Zero notion is the state worth failing on, and it is the state measured today.
 */
function companyAware(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return { exists: false };
  const src = fs.readFileSync(abs, 'utf8');
  const signals = [];
  if (/\bcompany_id\b/.test(src)) signals.push('company_id');
  if (/identity\/company-membership/.test(src)) signals.push('membership accessor');
  if (/office\/context/.test(src)) signals.push('resolved context');
  if (/\bcompanyId\b/.test(src)) signals.push('companyId');
  return { exists: true, aware: signals.length > 0, signals };
}

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'wfscope' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  workflow company scoping not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
const url = cluster.url;
process.env.DATABASE_URL = url;
process.env.ADMIN_EMAIL = 'wfscope-bootstrap@wfscope.invalid';
process.env.ADMIN_PASSWORD = `wfscope-${require('node:crypto').randomBytes(16).toString('hex')}`;

const WATCHDOG_MS = Number(process.env.WFSCOPE_CHECK_TIMEOUT_MS || 180_000);
const watchdog = setTimeout(() => {
  console.log(`\n  FAIL  no progress in ${Math.round(WATCHDOG_MS / 1000)}s — a stall is a failure.`);
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const made = { companies: [], mappings: [], users: [] };

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/identity/schema').migrateIdentity(q);
    const WFC = require('../src/lib/identity/workflow-company');
    console.log('  ..    schema up\n');

    // ── 1. THE LIVE STATE: NO MAPPING, SO NO FALSE ASSURANCE YET ───────────
    const live = await WFC.allMappings({ query: q });
    if (live.length === 0) {
      ok('no workflow carries a company mapping yet, so no workflow is mislabelled');
    } else {
      const unscoped = [];
      for (const row of live) {
        const impl = IMPLEMENTED_BY[row.workflow];
        if (!impl) {
          bad(`${row.workflow} is mapped to a company but this check has no implementation entry `
            + 'for it — the map must be complete, or a new mapping passes unexamined', row.workflow);
          continue;
        }
        const blind = impl.modules.filter((m) => !companyAware(m).aware);
        if (blind.length) unscoped.push({ workflow: row.workflow, blind });
      }
      if (!unscoped.length) ok('every mapped workflow has company-aware implementation modules');
      else for (const u of unscoped) {
        bad(`${u.workflow} carries a company mapping, but its implementation has no notion of a `
          + 'company — the label makes its recipients pass the gate and changes nothing about '
          + 'which company\'s people and records it acts on', u.blind.join(', '));
      }
    }

    // ── 2. THE TRIPWIRE FIRES — proved on FIXTURES, not on live state ──────
    const coId = 'wfscope-co-abiozen';
    await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$2,$3,'active')`,
      [coId, 'wfscope-abiozen', 'WfScope ABIOZEN']);
    made.companies.push(coId);
    const actor = 'wfscope-u-owner';
    await q(`INSERT INTO users (id, email, name, role, is_active) VALUES ($1,$2,$3,'super_admin',1)`,
      [actor, 'owner@wfscope.invalid', 'WfScope Owner']);
    made.users.push(actor);

    const approved = ['daily-7cst-ceo-briefing', 'weekdays-8cst-us-team-briefing',
      'daily-18utc-performance-scoring', 'weekly-mon-7cst-data-accuracy'];
    for (const wf of approved) {
      const row = await WFC.mapWorkflowToCompany({
        workflow: wf, companyId: coId, grantedBy: actor,
        grantedReason: 'FIXTURE — proves the tripwire fires; removed by id below',
      }, { query: q });
      made.mappings.push(row.id);
    }
    ok(`inserted ${approved.length} fixture mapping(s) — the four the owner approved`);

    const withFixtures = await WFC.allMappings({ query: q });
    const flagged = [];
    for (const row of withFixtures) {
      const impl = IMPLEMENTED_BY[row.workflow];
      if (!impl) continue;
      const blind = impl.modules.filter((m) => !companyAware(m).aware);
      if (blind.length) flagged.push({ workflow: row.workflow, blind });
    }
    if (flagged.length === approved.length) {
      ok(`the tripwire reports ALL ${flagged.length} as mislabelled — it can fire, and it would `
        + 'fire the moment these mappings were applied for real');
      for (const f of flagged) note(`${f.workflow} → unscoped: ${f.blind.join(', ')}`);
    } else {
      bad(`expected all ${approved.length} fixture mappings to be reported; got ${flagged.length}. `
        + 'A tripwire that does not fire on the known-bad case proves nothing', flagged);
    }

    // ── 3. THE MEASUREMENT ITSELF, STATED ──────────────────────────────────
    const seen = {};
    for (const [wf, impl] of Object.entries(IMPLEMENTED_BY)) {
      for (const m of impl.modules) {
        if (!(m in seen)) seen[m] = companyAware(m);
      }
      void wf;
    }
    const missing = Object.entries(seen).filter(([, v]) => !v.exists).map(([k]) => k);
    if (!missing.length) ok('every module named in the implementation map exists');
    else bad('the implementation map names modules that do not exist — it has gone stale', missing);

    console.log('');
    for (const [m, v] of Object.entries(seen)) {
      if (!v.exists) continue;
      console.log(`  --    ${m}: ${v.aware ? `company-aware (${v.signals.join(', ')})` : 'NO notion of a company'}`);
    }
    console.log('');

    // The positive control: a module that IS company-aware must be recognised, or "no signals"
    // might just mean the detector is broken.
    const control = companyAware('src/lib/identity/company-membership.js');
    if (control.aware) ok('CONTROL: a company-aware module is detected as such — the detector works');
    else bad('CONTROL FAILED: the membership accessor was not detected as company-aware, so every '
      + '"NO notion of a company" result above is unreliable');
  } catch (e) {
    bad('the check threw', e && (e.stack || e.message));
  } finally {
    try {
      for (const id of made.mappings) await q(`DELETE FROM workflow_companies WHERE id = $1`, [id]).catch(() => {});
      for (const id of made.users) await q(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
      for (const id of made.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]).catch(() => {});
      const mine = (await q(`SELECT COUNT(*)::int n FROM workflow_companies WHERE id = ANY($1)`,
        [made.mappings])).rows[0].n;
      if (mine === 0) ok('cleanup: my fixture mappings are gone');
      else bad('cleanup leaked fixture mappings', mine);
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    cluster.destroy();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  a workflow carries a company label its implementation does not honour.');
    process.exit(1);
  }
  console.log('\nPASS  no workflow is mislabelled today, and the tripwire fires on the four '
    + 'approved mappings — so applying them before their queries are company-scoped turns this '
    + 'check red rather than producing a quiet false assurance.');
  process.exit(0);
})();
