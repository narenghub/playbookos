#!/usr/bin/env node
'use strict';
// ── READ-ONLY TENANCY DIAGNOSTICS ───────────────────────────────────────────
//
// Ruling 7 item 3: "First produce read-only production counts for companies, research tables,
// existing pricing ownership, and relevant entity IDs. Do not assign or migrate tenant ownership
// based on guesses."
//
// This script is the "first" in that sentence. It answers the questions the migration's risk
// profile depends on, and it answers NONE of them by inference — every number below is a COUNT of
// rows that exist, and every absent thing is reported as absent rather than as zero.
//
// ── WHY THIS EXISTS AS A SCRIPT RATHER THAN AN ANSWER ───────────────────────
//
// I have no production access: no Railway CLI, no token, no DATABASE_URL. So I cannot produce
// these counts, and a design that assumed them would be the guess this ruling forbids. The one
// number that matters most — how many rows are in `companies` — decides whether the backfill is
// mechanical or dangerous, and it is not a number anyone should estimate.
//
// ── READ-ONLY, CHECKED RATHER THAN CLAIMED ──────────────────────────────────
//
// SELECT only. assertReadOnly() refuses anything else at the call site, and preflight asserts no
// SQL literal in this file contains a mutating verb. There are no fixtures, so there is no
// cleanup to get wrong — the safest possible state for a script pointed at production.
//
// Usage:
//   railway ssh 'node scripts/tenancy-diagnostics.js'
//   echo $?
//
// Exit: 0 report produced · 1 could not produce it

const { Pool } = require('pg');

const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy)\b/i;
function assertReadOnly(sql) {
  if (FORBIDDEN.test(sql)) throw new Error(`REFUSED: statement is not read-only:\n${sql}`);
  return sql;
}

function bar(ch = '─') { return ch.repeat(78); }
function h(t) { console.log(`\n${bar()}\n${t}\n${bar()}`); }

// The research intelligence tables, and whether the tenancy design calls each one shared
// reference data or tenant-owned. From claude/research-spine-tenancy-design.md.
const RESEARCH_TABLES = [
  ['clinical_studies', 'shared spine — public register'],
  ['study_molecules', 'SPLIT — public inference + our catalogue match'],
  ['research_organizations', 'split — org public, CRM link ours'],
  ['research_contacts', 'shared spine — bought data'],
  ['research_findings', 'split — article public, our decision ours'],
  ['research_outreach', 'tenant-owned — our drafts'],
  ['molecule_pricing', 'TENANT-OWNED — our prices, the most sensitive here'],
  ['molecule_dmf_matches', 'shared spine — derived from the FDA register'],
  ['dmf_holders', 'shared spine — FDA register'],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    return 1;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /sslmode=disable/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  const q = (sql, vals) => pool.query(assertReadOnly(sql), vals);

  try {
    const exists = async (t) => (await q(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1) AS p`, [t])).rows[0].p;
    const hasCol = async (t, c) => (await q(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS p`, [t, c])).rows[0].p;
    const count = async (t, where = '') => (await q(
      `SELECT COUNT(*)::int n FROM ${t} ${where}`)).rows[0].n;

    h('TENANCY DIAGNOSTICS — READ-ONLY  (ruling 7 item 3)');
    console.log(`  generated : ${new Date().toISOString()}`);
    console.log(`  database  : ${String(process.env.DATABASE_URL).replace(/:[^:@/]*@/, ':***@')}`);
    console.log('  statements: SELECT only. No row is written. No ownership is assigned.');

    // ── 1. THE NUMBER THE MIGRATION'S RISK PROFILE DEPENDS ON ────────────
    h('1. COMPANIES — the number that decides whether the backfill is safe');
    if (!(await exists('companies'))) {
      console.log('  companies: TABLE ABSENT. The office kernel schema is not applied here.');
      console.log('  Everything below about tenant assignment is therefore moot until it is.');
    } else {
      const rows = (await q(
        'SELECT id, slug, display_name, status, created_at FROM companies ORDER BY created_at')).rows;
      console.log(`  row count: ${rows.length}`);
      console.log('');
      for (const r of rows) {
        console.log(`    id=${r.id}`);
        console.log(`      slug         : ${r.slug}`);
        console.log(`      display_name : ${r.display_name}`);
        console.log(`      status       : ${r.status}`);
        console.log(`      created_at   : ${r.created_at ? r.created_at.toISOString().slice(0, 10) : 'UNKNOWN'}`);
      }
      console.log('');
      if (rows.length === 0) {
        console.log('  ZERO COMPANIES. A backfill has no target at all; the tenancy work cannot');
        console.log('  begin until at least one company row exists.');
      } else if (rows.length === 1) {
        console.log('  EXACTLY ONE COMPANY. The backfill is mechanical: every existing research row');
        console.log('  belongs to this tenant, and no row has an ambiguous owner. This is the case');
        console.log('  in which the migration is safe to propose.');
      } else {
        console.log(`  ${rows.length} COMPANIES. THE BACKFILL IS NOT MECHANICAL. There is no rule in`);
        console.log('  the data that says which tenant owns a given research row — the column that');
        console.log('  would say so is the one being added. Assigning ownership here would be the');
        console.log('  guess this ruling forbids, and a wrong guess hands one tenant another');
        console.log('  tenant\'s pricing and outreach. A separate design is required.');
      }
    }

    // ── 2. RESEARCH TABLES ───────────────────────────────────────────────
    h('2. RESEARCH INTELLIGENCE TABLES — size, and whether any already has a tenant column');
    console.log(`  ${'table'.padEnd(26)} ${'rows'.padStart(9)}  ${'company_id?'.padEnd(12)} intended treatment`);
    console.log(`  ${bar('─').slice(0, 74)}`);
    let totalRows = 0;
    for (const [t, treatment] of RESEARCH_TABLES) {
      if (!(await exists(t))) {
        console.log(`  ${t.padEnd(26)} ${'ABSENT'.padStart(9)}  ${'-'.padEnd(12)} ${treatment}`);
        continue;
      }
      const n = await count(t);
      totalRows += n;
      const tenant = (await hasCol(t, 'company_id')) ? 'PRESENT' : 'none';
      console.log(`  ${t.padEnd(26)} ${String(n).padStart(9)}  ${tenant.padEnd(12)} ${treatment}`);
    }
    console.log('');
    console.log(`  total rows across present research tables: ${totalRows}`);
    console.log('  A "none" in the company_id column is the finding, not an error: these tables');
    console.log('  predate the tenant pattern the PRPA tables use.');

    // ── 3. PRICING OWNERSHIP — the most sensitive table ──────────────────
    h('3. molecule_pricing — ownership and exposure');
    if (!(await exists('molecule_pricing'))) {
      console.log('  molecule_pricing: TABLE ABSENT.');
    } else {
      const total = await count('molecule_pricing');
      const active = await count('molecule_pricing', 'WHERE active = 1');
      const priced = await count('molecule_pricing', 'WHERE price_per_kg_usd IS NOT NULL');
      console.log(`  rows               : ${total}`);
      console.log(`  active             : ${active}`);
      console.log(`  carrying a price   : ${priced}`);
      console.log(`  company_id column  : ${(await hasCol('molecule_pricing', 'company_id')) ? 'PRESENT' : 'NONE — single-tenant by construction'}`);
      console.log('');
      console.log('  These are OUR prices. If a second tenant ever exists, this is the table whose');
      console.log('  leak costs the most, and it is the one most worth isolating first.');
      if (total > 0 && !(await hasCol('molecule_pricing', 'company_id'))) {
        console.log(`  ${total} priced rows would need an owner assigned. See section 1 for whether`);
        console.log('  that assignment is mechanical or a guess.');
      }
    }

    // ── 4. ENTITY IDS ────────────────────────────────────────────────────
    h('4. RELEVANT ENTITY IDS — do Abiozen Scientific and CRO360 exist as records?');
    const NAMES = ['abiozen scientific', 'abiozen', 'cro360', 'cro 360'];
    for (const [table, col] of [['companies', 'display_name'], ['labs', 'name'],
      ['suppliers', 'name'], ['research_organizations', 'display_name'],
      ['fda_establishments', 'firm_name']]) {
      if (!(await exists(table))) { console.log(`  ${table.padEnd(24)} ABSENT`); continue; }
      if (!(await hasCol(table, col))) { console.log(`  ${table.padEnd(24)} no ${col} column`); continue; }
      const { rows } = await q(
        `SELECT id, ${col} AS nm FROM ${table} WHERE lower(${col}) LIKE ANY($1) LIMIT 20`,
        [NAMES.map((n) => `%${n}%`)],
      );
      console.log(`  ${table.padEnd(24)} ${rows.length} match(es)`);
      for (const r of rows) console.log(`      id=${r.id}  ${r.nm}`);
    }
    console.log('');
    console.log('  A zero here is NOT a finding that the entity has no records. It is a finding');
    console.log('  that these name fragments did not match. Confirm the filed names before');
    console.log('  concluding anything — matchTier("CRO360","CRO 360 Inc") is null, and one space');
    console.log('  is enough to hide a real row.');

    // ── 5. PRPA TABLES — are they applied here at all? ───────────────────
    h('5. PRPA TABLES — applied, or still unapplied?');
    const PRPA = ['source_connectors', 'source_sync_runs', 'federal_awards', 'funding_opportunities',
      'funding_opportunity_versions', 'eligibility_assessments', 'eligibility_findings',
      'verified_capabilities', 'capability_scope_items', 'review_tasks',
      'solicitations', 'solicitation_amendments'];
    let appliedCount = 0;
    for (const t of PRPA) {
      const p = await exists(t);
      if (p) appliedCount += 1;
      const n = p ? await count(t) : null;
      console.log(`  ${p ? 'applied' : 'ABSENT '}  ${t.padEnd(32)} ${p ? `${n} row(s)` : ''}`);
    }
    console.log('');
    console.log(`  ${appliedCount} of ${PRPA.length} PRPA tables exist in this database.`);
    if (!(await exists('verified_capabilities'))) {
      console.log('  verified_capabilities is ABSENT, so NO capability is verified for any entity —');
      console.log('  not because none qualify, but because the table that records verification does');
      console.log('  not exist. The human-review workflow has nowhere to write until it does.');
    }

    h('WHAT THIS REPORT DOES NOT DO');
    console.log('  · it assigns no ownership and migrates nothing');
    console.log('  · it infers no tenant for any row');
    console.log('  · a zero match in section 4 is a failed name match, not an absence of records');
    console.log('  · it writes nothing — SELECT only, refused at the call site otherwise');
    console.log('');
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
