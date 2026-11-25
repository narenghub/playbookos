#!/usr/bin/env node
// ── B7.18: A REVIEWABLE MEMBERSHIP BACKFILL. IT GRANTS NOTHING. ─────────────
//
//   node scripts/propose-company-memberships.js              # the proposal
//   node scripts/propose-company-memberships.js --json        # machine-readable, for review tooling
//
//   exit 0 = a proposal was produced          exit 3 = NOT EXECUTED (no readable database)
//
// Owner instruction, carried unchanged since 2026-11-24 and restated in Decision 5:
//
//   *"No automatic production grants. No membership inferred from domain, job title, or the
//    approved workflow mappings. Shared-employee memberships require reviewed assignment records.
//    Do not infer ownership or silently assign ambiguous records to ABIOZEN."*
//
// ── WHAT THIS TOOL REFUSES TO DO, AND WHY THAT IS THE WHOLE DESIGN ─────────
//
// The tempting implementation writes itself: every `@abiozen.com` address is an ABIOZEN member,
// every `@adificetechnologies.com` one is an Adifice member, done in an afternoon. That is exactly
// what the instruction forbids, three times over, and for a reason this project has already
// measured: `prasanthi@adificetechnologies.com` administers ABIOZEN. Her domain says Adifice. A
// domain-derived backfill would have given her the wrong company and taken ABIOZEN's admin away
// from it, and because `user_companies` is what decides company scope, the error would have been
// invisible until a workflow selected nobody.
//
// So this tool DERIVES NOTHING FROM A DOMAIN, A TITLE, A ROLE OR A WORKFLOW MAPPING. It reports:
//
//   ALREADY GRANTED   users with a live membership — nothing to propose, and the count a reviewer
//                     needs in order to know the backfill has not been half-applied.
//   REVIEWED          a membership an ASSIGNMENT RECORD already states. Today that is: a user who
//                     owns an objective of a company, or who has been assigned a company-scoped
//                     task. Those are records a person created on purpose, in the product, naming
//                     both sides — which is what "reviewed assignment record" means here.
//   NEEDS A DECISION  an active internal user with no live membership and no assignment record.
//                     Listed with everything known about them and NO proposed company. This is the
//                     honest answer and the list is expected to be long.
//   EXTERNAL          partner and other external roles. Not internal members of anything, and
//                     named so nobody reads their absence as an omission.
//
// ── AND IT CANNOT APPLY ────────────────────────────────────────────────────
//
// No INSERT, no UPDATE, no call to grantMembership. scripts/membership-proposal-is-readonly.test.js
// asserts that, in the same shape as the workflow-mapping proposal's test and for the same reason:
// the risk is not that somebody writes an apply step on purpose, it is that this grows an `--apply`
// flag six weeks from now because running two commands is tedious, and from then on nobody reads
// the dry run. Adding the flag means deleting an assertion that says why it must not exist.

'use strict';

const JSON_OUT = process.argv.includes('--json');

(async () => {
  const db = require('../src/lib/db');
  const query = db.query;

  // NOT EXECUTED rather than a false clean result: a proposal nobody could compute is not an empty
  // proposal, and exit 3 is this repository's signal for that.
  try {
    await query('SELECT 1');
  } catch (e) {
    console.error(`NOT EXECUTED  the database is not readable: ${e.message}`);
    console.error('              A proposal that could not be computed is not an empty proposal.');
    process.exit(3);
  }

  const need = async (table) => (await query(`SELECT to_regclass($1) AS t`, [`public.${table}`]))
    .rows[0].t !== null;
  const missing = [];
  for (const t of ['users', 'companies', 'user_companies', 'objectives', 'daily_tasks']) {
    if (!(await need(t))) missing.push(t);
  }
  if (missing.length) {
    console.error(`NOT EXECUTED  these tables do not exist here: ${missing.join(', ')}`);
    console.error('              On a database without them this proposal would read as "nobody');
    console.error('              needs a membership", which is the opposite of true.');
    process.exit(3);
  }

  const { excludeExternalSql } = require('../src/lib/roles');

  const companies = (await query(
    `SELECT id, slug, display_name, status FROM companies ORDER BY slug`)).rows;

  // ALREADY GRANTED — through the accessor's own live predicate, not a second copy of it. The
  // predicate is several conditions long (effective window, revocation) and a copy here would
  // drift from the one that decides access.
  const MEMBERSHIP = require('../src/lib/identity/company-membership');
  const granted = new Map();
  for (const c of companies) {
    const members = await MEMBERSHIP.membersOfCompany(c.id, {});
    if (members === MEMBERSHIP.UNKNOWN || members === null) {
      console.error(`NOT EXECUTED  membership for ${c.slug} could not be read.`);
      console.error('              An unreadable membership is not an absent one.');
      process.exit(3);
    }
    for (const m of members) {
      if (!granted.has(m.id)) granted.set(m.id, []);
      granted.get(m.id).push({ company: c.id, companyRole: m.companyRole });
    }
  }

  // REVIEWED ASSIGNMENT RECORDS. Two sources, both created deliberately by a person in the
  // product, both naming a user AND a company. Neither is a domain, a title or a workflow mapping.
  const fromObjectives = (await query(
    `SELECT DISTINCT u.id AS user_id, u.email, u.name, u.role, o.company_id, 'objective_owner' AS basis
       FROM objectives o JOIN users u ON lower(u.email) = lower(o.created_by)
      WHERE o.company_id IS NOT NULL`)).rows;

  // daily_tasks.company_id exists from B7.21 and is NULLABLE with no backfill, so this source is
  // empty until tasks are assigned through the company-scoped writer. Reported either way, because
  // "this source contributed nothing" is worth knowing.
  const fromTasks = (await query(
    `SELECT DISTINCT u.id AS user_id, u.email, u.name, u.role, t.company_id,
            'assigned_company_task' AS basis
       FROM daily_tasks t JOIN users u ON u.id = t.user_id
      WHERE t.company_id IS NOT NULL`)).rows;

  const reviewed = new Map();
  for (const r of [...fromObjectives, ...fromTasks]) {
    const key = `${r.user_id}::${r.company_id}`;
    if (!reviewed.has(key)) reviewed.set(key, { ...r, bases: new Set() });
    reviewed.get(key).bases.add(r.basis);
  }

  // Everyone else. Active internal users only — external roles are listed separately rather than
  // omitted, so their absence from the proposal is stated rather than looking like an oversight.
  const activeInternal = (await query(
    `SELECT id, email, name, role FROM users
      WHERE is_active = 1${excludeExternalSql('')} ORDER BY email`)).rows;
  const externals = (await query(
    `SELECT id, email, name, role FROM users WHERE is_active = 1 AND NOT (TRUE${excludeExternalSql('')})
      ORDER BY email`)).rows;

  const proposals = [];
  const needsDecision = [];
  for (const u of activeInternal) {
    const live = granted.get(u.id) || [];
    const mine = [...reviewed.values()].filter((r) => r.user_id === u.id);
    const newOnes = mine.filter((r) => !live.some((g) => g.company === r.company_id));
    if (newOnes.length) {
      for (const r of newOnes) {
        proposals.push({
          userId: u.id, email: u.email, name: u.name, globalRole: u.role,
          proposedCompany: r.company_id,
          basis: [...r.bases].join(' + '),
          // NOT proposed: the company role. `member` would be a guess, and an admin granted as a
          // member is a quieter failure than no grant at all.
          companyRole: null,
          companyRoleNote: 'NOT PROPOSED — a reviewer sets this. Guessing `member` would silently '
            + 'demote an administrator, which is worse than leaving it blank',
        });
      }
      continue;
    }
    if (!live.length) {
      needsDecision.push({ userId: u.id, email: u.email, name: u.name, globalRole: u.role,
        why: 'active internal user with no live membership and no reviewed assignment record — '
          + 'nothing in the data says which company, and a domain does not' });
    }
  }

  const shared = [...new Set(proposals.map((p) => p.email))]
    .filter((e) => proposals.filter((p) => p.email === e).length > 1);

  const out = {
    generated_at: new Date().toISOString(),
    writes_nothing: true,
    companies: companies.map((c) => ({ id: c.id, slug: c.slug, status: c.status,
      live_members: [...granted.values()].flat().filter((g) => g.company === c.id).length })),
    already_granted: [...granted.entries()].map(([userId, gs]) => ({ userId, memberships: gs })),
    proposed_from_reviewed_records: proposals,
    shared_employees_proposed: shared,
    needs_a_decision: needsDecision,
    external_roles_not_members: externals.map((u) => ({ email: u.email, role: u.role })),
    sources_consulted: [
      'objectives.created_by + objectives.company_id (a person created an objective FOR a company)',
      'daily_tasks.user_id + daily_tasks.company_id (a person was assigned company-scoped work)',
    ],
    sources_deliberately_NOT_consulted: [
      'the email domain — prasanthi@adificetechnologies.com administers ABIOZEN, so a '
      + 'domain-derived backfill would assign the wrong company and take ABIOZEN its own admin',
      'the global role or job title — neither names a company',
      'the approved workflow→company mappings — the owner ruled those out explicitly as a '
      + 'membership source, and a workflow acting for a company says nothing about who works there',
    ],
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const line = (s = '') => console.log(s);
  line('── B7.18 MEMBERSHIP BACKFILL PROPOSAL ──────────────────────────────────');
  line();
  line('  THIS TOOL WRITES NOTHING. No INSERT, no UPDATE, no grantMembership.');
  line();
  line(`  companies: ${companies.length}`);
  for (const c of out.companies) {
    line(`    ${c.slug.padEnd(28)} ${String(c.live_members).padStart(3)} live member(s)  [${c.status}]`);
  }
  line();
  line(`  ── PROPOSED, from reviewed assignment records (${proposals.length}) ──`);
  if (!proposals.length) line('    (none — no assignment record names both a user and a company yet)');
  for (const p of proposals) {
    line(`    ${p.email.padEnd(38)} → ${p.proposedCompany}`);
    line(`      basis: ${p.basis}`);
    line(`      company_role: ${p.companyRoleNote}`);
  }
  if (shared.length) {
    line();
    line(`  ── SHARED EMPLOYEES in the proposal (${shared.length}) ──`);
    for (const e of shared) line(`    ${e} — proposed for more than one company; review each`);
  }
  line();
  line(`  ── NEEDS A DECISION (${needsDecision.length}) ──`);
  line('    Active internal users the data cannot place. Expected to be long, and a long list is');
  line('    the honest answer: a domain is not a membership.');
  for (const u of needsDecision) line(`    ${u.email.padEnd(38)} ${u.globalRole || ''}`);
  line();
  line(`  ── EXTERNAL ROLES, not internal members (${externals.length}) ──`);
  for (const u of out.external_roles_not_members) line(`    ${u.email.padEnd(38)} ${u.role}`);
  line();
  line('  ── SOURCES NOT CONSULTED, deliberately ──');
  for (const s of out.sources_deliberately_NOT_consulted) line(`    · ${s}`);
  line();
  line('── NOTHING WAS GRANTED. A reviewer decides, and the grant is a separate, audited act. ──');
  process.exit(0);
})().catch((e) => {
  console.error(`FAIL  ${e.stack || e.message}`);
  process.exit(1);
});
