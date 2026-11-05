#!/usr/bin/env node
'use strict';
// ── READ-ONLY EVIDENCE INVENTORY FOR OUR OWN ENTITIES ───────────────────────
//
// Ruling 6 items 1–2. Inventories what the existing records actually establish about Abiozen
// Scientific and CRO360, and proposes CANDIDATE capability records for human verification.
//
//   "Do not invent certifications, accreditations, authorizations, equipment availability, or
//    technical capabilities."
//   "Candidate records must remain pending until verified with evidence, scope, entity, validity
//    dates, and an authorized approval."
//
// ── READ-ONLY, AND CHECKED RATHER THAN CLAIMED ──────────────────────────────
//
// SELECT only. assertReadOnly() refuses anything else at the call site, and the preflight check
// asserts no SQL literal here contains a mutating verb. There are no fixtures, so there is no
// cleanup to get wrong.
//
// ── THE TRAP THIS SCRIPT IS BUILT AROUND ────────────────────────────────────
//
// "Zero records found" has two meanings and they are not the same:
//
//   (a) the entity genuinely has no records, or
//   (b) the entity HAS records and the name did not match.
//
// (b) is not hypothetical here. matchTier('CRO360', 'CRO 360 Inc') returns null — the space
// defeats it — so a search keyed on the normalized name alone would report CRO360 as having no
// laboratory, registration or accreditation records whatever while rows sat in the table. An
// inventory that reports (b) as (a) is worse than no inventory, because it looks like a completed
// search.
//
// So every entity is searched several ways, every near-miss is printed with its match tier, and a
// dimension with no hit says WHICH searches were run and that identity is UNCONFIRMED. The script
// never concludes that a record does not exist; it reports what it looked for and did not find.
//
// Usage:
//   DATABASE_URL=<read-only> node scripts/capability-evidence-inventory.js
//   railway ssh 'node scripts/capability-evidence-inventory.js'
//
// Exit: 0 inventory produced. 1 could not produce it.

const { Pool } = require('pg');
const { normalizeCompany, companyCore, matchTier } = require('../src/lib/cphi/match-company');
const {
  DIMENSIONS, STATUS, inventory, unknown,
} = require('../src/lib/procurement/evidence-inventory');

const FORBIDDEN = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy)\b/i;
function assertReadOnly(sql) {
  if (FORBIDDEN.test(sql)) throw new Error(`REFUSED: statement is not read-only:\n${sql}`);
  return sql;
}

// Our own entities. Variants exist because the matcher is exact-ish and these names are written
// several ways in practice; listing them is how (b) above is avoided.
const TARGETS = [
  { name: 'Abiozen Scientific', variants: ['Abiozen Scientific', 'Abiozen', 'Abiozen LLC', 'Abiozen Scientific LLC'] },
  { name: 'CRO360', variants: ['CRO360', 'CRO 360', 'CRO-360', 'CRO360 LLC', 'Abiozen CRO360'] },
];

function bar(ch = '─') { return ch.repeat(78); }
function h(title) { console.log(`\n${bar()}\n${title}\n${bar()}`); }

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
  const asOf = new Date().toISOString().slice(0, 10);

  try {
    const present = async (t) => (await q(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1) AS p`, [t],
    )).rows[0].p;

    const TABLES = ['companies', 'fda_establishments', 'labs', 'lab_tests', 'test_catalogue',
      'suppliers', 'research_organizations', 'verified_capabilities'];
    const have = {};
    for (const t of TABLES) have[t] = await present(t);

    h('EVIDENCE INVENTORY — Abiozen Scientific and CRO360  (read-only)');
    console.log(`  generated : ${new Date().toISOString()}`);
    console.log(`  as of     : ${asOf}`);
    console.log('');
    console.log('  record stores probed:');
    for (const t of TABLES) {
      console.log(`    ${have[t] ? 'present' : 'ABSENT '}  ${t}`);
    }
    console.log('');
    console.log('  STRUCTURAL FINDING, independent of any row: four of the dimensions this ruling');
    console.log('  names have NO table anywhere in this schema that can hold them —');
    console.log(`    ${DIMENSIONS.filter((d) => d.structurallyAbsent).map((d) => d.key).join(', ')}`);
    console.log('  so UNKNOWN there is a schema gap, not an empty search. verified_capabilities is');
    console.log('  the table designed to hold them and it is NOT APPLIED to production.');

    for (const target of TARGETS) {
      h(`ENTITY: ${target.name}`);
      const norms = [...new Set(target.variants.map(normalizeCompany).filter(Boolean))];
      const cores = [...new Set(target.variants.map(companyCore).filter(Boolean))];
      console.log(`  searched as : ${target.variants.join(' | ')}`);
      console.log(`  normalized  : ${norms.join(' | ')}`);
      const records = [];
      const nearMisses = [];
      const searchesRun = [];

      // ── companies (tenant identity) ──────────────────────────────────────
      if (have.companies) {
        searchesRun.push('companies by slug and display_name');
        const r = await q(
          `SELECT id, slug, display_name, status FROM companies
            WHERE lower(display_name) = ANY($1) OR lower(slug) = ANY($1)`, [norms],
        );
        for (const row of r.rows) {
          records.push({
            dimension: 'tenant_identity',
            value: `${row.display_name} (slug ${row.slug}, status ${row.status})`,
            source: { table: 'companies', column: 'display_name', id: row.id },
            external: false,
            selfReported: true,
            evidenceRef: row.slug,
          });
        }
        // Near misses, so (b) is visible rather than silent.
        const nm = await q(
          `SELECT id, slug, display_name FROM companies
            WHERE display_name ILIKE ANY($1) OR slug ILIKE ANY($1)`,
          [cores.map((c) => `%${c.split(' ')[0]}%`)],
        );
        for (const row of nm.rows) {
          const tier = matchTier(target.name, row.display_name);
          if (!norms.includes(normalizeCompany(row.display_name))) {
            nearMisses.push(`companies id=${row.id} "${row.display_name}" — match tier: ${tier || 'NO MATCH'}`);
          }
        }
      }

      // ── fda_establishments (external registration) ───────────────────────
      if (have.fda_establishments) {
        searchesRun.push('fda_establishments by firm_normalized and firm_name');
        const r = await q(
          `SELECT id, firm_name, fei_number, duns_number, operations, is_api_manufacturer,
                  is_us_agent, exclusion_flag, country
             FROM fda_establishments
            WHERE lower(firm_normalized) = ANY($1) OR lower(firm_name) = ANY($1)`, [norms],
        );
        for (const row of r.rows) {
          records.push({
            dimension: 'registration',
            value: `FDA establishment: ${row.operations || 'operations UNKNOWN'}`
              + `${row.exclusion_flag ? ` [EXCLUSION FLAG: ${row.exclusion_flag}]` : ''}`
              + `${row.is_us_agent ? ' [row is a US AGENT, not the firm itself]' : ''}`,
            source: { table: 'fda_establishments', column: 'operations', id: row.id },
            external: true,
            evidenceRef: row.fei_number ? `FEI ${row.fei_number}`
              : (row.duns_number ? `DUNS ${row.duns_number}` : null),
          });
        }
        const nm = await q(
          `SELECT id, firm_name FROM fda_establishments WHERE firm_name ILIKE ANY($1) LIMIT 25`,
          [cores.map((c) => `%${c.split(' ')[0]}%`)],
        );
        for (const row of nm.rows) {
          if (!norms.includes(normalizeCompany(row.firm_name))) {
            nearMisses.push(`fda_establishments id=${row.id} "${row.firm_name}" — `
              + `match tier: ${matchTier(target.name, row.firm_name) || 'NO MATCH'}`);
          }
        }
      }

      // ── labs (accreditations, capability flags, provenance) ──────────────
      if (have.labs) {
        searchesRun.push('labs by name_normalized and name');
        const r = await q(
          `SELECT id, name, source, status, fei_number, duns_number, country,
                  research_capable, gmp_capable, accreditations
             FROM labs
            WHERE lower(name_normalized) = ANY($1) OR lower(name) = ANY($1)`, [norms],
        );
        for (const row of r.rows) {
          // accreditations JSONB carries body/certificate/scope_url/expires_on — evidence-shaped.
          const accs = Array.isArray(row.accreditations) ? row.accreditations : [];
          for (const a of accs) {
            records.push({
              dimension: 'accreditation',
              value: `${a.body || 'body UNKNOWN'}${a.certificate ? ` cert ${a.certificate}` : ''}`,
              source: { table: 'labs', column: 'accreditations', id: row.id },
              // An accreditation body is external; but if the lab self-onboarded, the CLAIM is the
              // lab's. Provenance decides which, and `source` records it.
              external: row.source !== 'self_onboard',
              selfReported: row.source === 'self_onboard',
              evidenceRef: a.certificate || a.scope_url || null,
              scope: a.scope_url ? [a.scope_url] : null,
              validTo: a.expires_on || null,
            });
          }
          // THE BOOLEANS. No evidence column, no date, no approver. Passed in deliberately with
          // no evidenceRef so they classify as CLAIM_WITHOUT_EVIDENCE and appear as GAPS.
          for (const [col, val] of [['research_capable', row.research_capable],
            ['gmp_capable', row.gmp_capable]]) {
            if (val) {
              records.push({
                dimension: 'technical_capability',
                value: `${col} = true`,
                source: { table: 'labs', column: col, id: row.id },
                // provenance of the FLAG, not of a document: 'fda_register' means nobody has
                // spoken to this firm at all.
                selfReported: row.source === 'self_onboard',
                // no evidenceRef, on purpose — there is no document behind a boolean
              });
            }
          }
          if (row.fei_number || row.duns_number) {
            records.push({
              dimension: 'registration',
              value: `labs row carries ${row.fei_number ? `FEI ${row.fei_number}` : ''}`
                + `${row.duns_number ? ` DUNS ${row.duns_number}` : ''} (provenance: ${row.source})`,
              source: { table: 'labs', column: 'fei_number', id: row.id },
              external: row.source === 'fda_register',
              selfReported: row.source === 'self_onboard',
              evidenceRef: row.fei_number || row.duns_number,
            });
          }

          // ── lab_tests: scope, which is narrower than holding an accreditation ──
          if (have.lab_tests && have.test_catalogue) {
            searchesRun.push(`lab_tests for labs.id=${row.id}`);
            const lt = await q(
              `SELECT lt.test_code, lt.accredited, lt.gmp, lt.turnaround_days,
                      tc.name, tc.typical_method, tc.gmp_relevant
                 FROM lab_tests lt JOIN test_catalogue tc ON tc.code = lt.test_code
                WHERE lt.lab_id = $1`, [row.id],
            );
            for (const t of lt.rows) {
              records.push({
                dimension: 'technical_capability',
                value: `${t.name} (${t.test_code})`
                  + `${t.typical_method ? ` method ${t.typical_method}` : ''}`
                  + `${t.accredited ? ' [accredited FOR THIS TEST]' : ' [not accredited for this test]'}`,
                source: { table: 'lab_tests', column: 'test_code', id: `${row.id}/${t.test_code}` },
                selfReported: true,
                // Only an accredited-for-this-test row has anything checkable behind it; an
                // offered-but-unaccredited test is a claim.
                evidenceRef: t.accredited ? `${t.test_code} accredited scope` : null,
                scope: [t.test_code],
              });
            }
          }
        }
        const nm = await q(`SELECT id, name FROM labs WHERE name ILIKE ANY($1) LIMIT 25`,
          [cores.map((c) => `%${c.split(' ')[0]}%`)]);
        for (const row of nm.rows) {
          if (!norms.includes(normalizeCompany(row.name))) {
            nearMisses.push(`labs id=${row.id} "${row.name}" — `
              + `match tier: ${matchTier(target.name, row.name) || 'NO MATCH'}`);
          }
        }
      }

      // ── suppliers / research_organizations / catalogue ───────────────────
      for (const [table, col] of [['suppliers', 'name'], ['research_organizations', 'name']]) {
        if (!have[table]) continue;
        searchesRun.push(`${table} by ${col}`);
        const r = await q(`SELECT * FROM ${table} WHERE lower(${col}) = ANY($1)`, [norms]);
        for (const row of r.rows) {
          records.push({
            dimension: table === 'suppliers' ? 'supplier_record' : 'catalog_record',
            value: `${table} row: ${row[col]}`,
            source: { table, column: col, id: row.id },
            selfReported: true,
            evidenceRef: row.id ? String(row.id) : null,
          });
        }
      }

      // ── verified_capabilities, if the migration has been applied ─────────
      if (have.verified_capabilities) {
        searchesRun.push('verified_capabilities by responsible_entity');
        const r = await q(
          `SELECT * FROM verified_capabilities WHERE lower(responsible_entity) = ANY($1)`, [norms],
        );
        console.log(`  verified_capabilities rows for this entity: ${r.rows.length}`);
      } else {
        console.log('  verified_capabilities: TABLE NOT APPLIED — no capability is verified, for');
        console.log('  any entity, because the table that records verification does not exist yet.');
      }

      // ── report ───────────────────────────────────────────────────────────
      const inv = inventory({ name: target.name }, records, asOf);

      console.log('');
      console.log(`  searches run: ${searchesRun.length}`);
      for (const s of searchesRun) console.log(`    · ${s}`);

      console.log('');
      console.log(`  ${'dimension'.padEnd(24)} ${'status'.padEnd(24)} value`);
      console.log(`  ${bar('─').slice(0, 74)}`);
      for (const d of DIMENSIONS) {
        for (const f of inv.byDimension[d.key]) {
          const v = String(f.value).slice(0, 90);
          console.log(`  ${d.key.padEnd(24)} ${f.status.padEnd(24)} ${v}`);
          if (f.status === STATUS.UNKNOWN && f.structurallyAbsent) {
            console.log(`  ${''.padEnd(24)} ${''.padEnd(24)} ^ schema gap: no table can hold this`);
          }
          if (f.status === STATUS.CLAIM_WITHOUT_EVIDENCE) {
            console.log(`  ${''.padEnd(24)} ${''.padEnd(24)} ^ ${f.reason}`);
          }
        }
      }

      console.log('');
      console.log(`  dimensions with evidence   : ${inv.summary.withEvidence} of ${inv.summary.dimensions}`);
      console.log(`  dimensions UNKNOWN         : ${inv.summary.unknownDimensions}`);
      console.log(`  candidates for verification: ${inv.summary.candidatesForVerification}`);
      console.log(`  VERIFIED capabilities      : ${inv.summary.verified}`);

      if (inv.candidates.length) {
        console.log('\n  ── PROPOSED VERIFICATION QUEUE (all pending; none is a capability yet) ──');
        for (const c of inv.candidates) {
          console.log(`\n    capability    : ${c.capability}`);
          console.log(`    dimension     : ${c.dimension}`);
          console.log(`    entity        : ${c.responsible_entity}`);
          console.log(`    evidence      : ${c.evidence_source}  ref=${c.evidence_ref}`);
          console.log(`    scope         : ${c.scope ? JSON.stringify(c.scope) : 'UNKNOWN — a person must record it'}`);
          console.log(`    validity      : ${c.valid_from || 'UNKNOWN'} → ${c.valid_to || 'UNKNOWN'}`);
          console.log(`    attestation   : ${c.attestation}`);
          console.log(`    status        : ${c.verification_status}  (verified_by/approval_id: a person's to supply)`);
        }
      }

      if (nearMisses.length) {
        console.log('\n  ── NEAR MISSES — rows whose name did NOT match, printed so that a failed');
        console.log('     name match is never read as an absence of records ──');
        for (const n of [...new Set(nearMisses)]) console.log(`    ${n}`);
      }

      if (inv.summary.withEvidence === 0) {
        console.log('\n  IDENTITY UNCONFIRMED. No record matched any variant of this name. That is');
        console.log('  NOT a finding that the entity holds no certifications — it is a finding that');
        console.log('  these searches did not locate it. matchTier is exact-ish: it returns NO MATCH');
        console.log("  for 'CRO360' against 'CRO 360 Inc', so a real row can sit unmatched behind a");
        console.log('  single space. Confirm the entity\'s filed name before concluding anything.');
      }
    }

    h('WHAT THIS INVENTORY DOES NOT ESTABLISH');
    console.log('  · that any capability is VERIFIED. Nothing here is. verified_capabilities requires');
    console.log('    evidence_source, verified_at, verified_by, approval_id and valid_from before a');
    console.log("    row may read 'verified', and a CHECK constraint enforces it. Every candidate");
    console.log('    above is pending and stays pending until a person rules.');
    console.log('  · that a capability flag means a capability. labs.research_capable and gmp_capable');
    console.log('    are booleans with no evidence, source, date or approver behind them. Where');
    console.log("    labs.source = 'fda_register', nobody has spoken to the firm at all.");
    console.log('  · that an absent record means an absent capability. Four dimensions have no table');
    console.log('    in this schema; a name that did not match may still have rows.');
    console.log('  · anything about equipment availability. There is no equipment record anywhere.');
    console.log('');
    console.log('  No row was written. No capability was marked verified. All HOLDs and STOPs remain.');
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
