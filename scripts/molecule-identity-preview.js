#!/usr/bin/env node
// ── E1 IDENTITY PREVIEW — READ-ONLY. DECIDES NOTHING, WRITES NOTHING. ────────
//
//   railway ssh 'node scripts/molecule-identity-preview.js'
//
// Exit 0 = the preview ran. Exit 1 = it could not (and says why). A count is never a failure.
//
// There is no INSERT, UPDATE, DELETE, CREATE, ALTER or TRUNCATE anywhere in this file or in
// src/lib/molecules/preview.js. It does not create the molecules table, does not run the
// migration, does not touch molecule identity records and does not resolve any conflict.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
//
// The census counted conflicts with the LEGACY canonicalizer, which de-salts before folding to a
// synonym group, and found 102 conflicting groups over 808 rows. Under the approved E1 semantics
// most of those are not conflicts at all: leuprolide (CAS 53714-56-0) and leuprolide acetate
// (74381-53-6) are two substances, each keeping its own registry number. So the number that
// decides the migration is not 102 — it is how many survive when identity stops stripping the
// form, and that number has not been measured.
//
// Estimating it would have been easy and wrong. This measures it.
//
// ── THE FOUR KINDS OF STATEMENT IN THE OUTPUT, LABELLED ─────────────────────
//
//   MEASURED FACT         a count read from the database
//   E1 CLASSIFICATION     a deterministic consequence of the approved identity rules
//   HUMAN INTERPRETATION  a judgement I made, which you may overrule
//   PREDICTION            what the migration would do, not what it has done
//
// They are separated because the report's job is to support a decision, and a reader cannot weigh
// a number without knowing which of those four it is.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { analyze } = require('../src/lib/molecules/preview');

const KNOWN = [];
for (const a of process.argv.slice(2)) {
  if (!KNOWN.includes(a)) { console.error(`unknown flag ${a} — this script takes none`); process.exit(2); }
}

// The three tables E1 will touch. skus is read for the inventory only and is NOT grouped, because
// grouping it would propose molecules outside the approved blast radius.
const SOURCES = [
  { table: 'study_molecules', idCol: 'id', nameCol: 'molecule_name', casCol: 'cas_number', where: null },
  { table: 'research_interests', idCol: 'id', nameCol: 'value', casCol: 'cas', where: `kind = 'molecule'` },
  { table: 'supplier_products', idCol: 'id', nameCol: 'product_name', casCol: 'cas', where: null },
];

// ── HUMAN INTERPRETATION — the tiering, and I may have it wrong ──────────────
//
// Tier 1 is "a wrong identity here can reach a quotation, an RFQ, a sourcing decision or a
// customer transaction". That is why molecule_pricing and molecule_dmf_matches are Tier 1 rather
// than Tier 2: pricing feeds quotes, and molecule_dmf_matches is the table that produced the
// "SOLE holder worldwide" claim on 9 Oct over a substance three companies hold. A false scarcity
// claim is a commercial statement, whatever the table is nominally about.
//
// This classification is for the ADOPTION SEQUENCE after E1. None of these tables is migrated now.
const TIERS = {
  // Tier 1 — commercial / transactional
  inquiries: 1, inquiry_quotes: 1, rfq_requests: 1, reorder_campaigns: 1,
  molecule_pricing: 1, molecule_dmf_matches: 1, buyer_accounts: 1,
  skus: 1, supplier_products: 1,
  // Tier 2 — scientific / operational
  study_molecules: 2, research_interests: 2, clinical_studies: 2, patent_watch: 2,
  research_findings: 2, cphi_exhibitor_matches: 2, email_campaigns: 2,
  apollo_sequences: 2, buyer_engagement: 2,
  // Tier 3 — discovery / SEO / analytics
  seo_content: 3, molecule_history: 3, linkedin_content_queue: 3, linkedin_outreach: 3,
  research_outreach: 3,
};
const TIER_NAME = { 1: 'COMMERCIAL / TRANSACTIONAL', 2: 'SCIENTIFIC / OPERATIONAL', 3: 'DISCOVERY / SEO / ANALYTICS' };

const h = (n, s, kind) => console.log(`\n${'─'.repeat(2)} ${n}. ${s}${kind ? `   [${kind}]` : ''}\n`);
const r = (l, v) => console.log(`   ${String(l).padEnd(50)} ${v}`);

async function tableExists(name) {
  const t = await query(`SELECT to_regclass($1) IS NOT NULL ok`, [name]);
  return !!(t.rows[0] && t.rows[0].ok);
}

async function main() {
  await initDB();
  const commit = String(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown';
  console.log(`\n═══ E1 IDENTITY PREVIEW · commit ${commit} · READ-ONLY, NOTHING WRITTEN ═══`);

  // Collect the rows once; every number below is derived from this one read.
  const rows = [];
  const present = [];
  for (const s of SOURCES) {
    if (!(await tableExists(s.table))) { present.push(`${s.table} (ABSENT)`); continue; }
    const w = s.where ? `WHERE ${s.where}` : '';
    const got = await query(
      `SELECT ${s.idCol} AS rid, ${s.nameCol} AS nm, ${s.casCol} AS cas FROM ${s.table} ${w}`);
    got.rows.forEach((x) => rows.push({ table: s.table, rid: x.rid, name: x.nm, cas: x.cas }));
    present.push(`${s.table} (${got.rowCount})`);
  }
  const a = analyze(rows);
  const S = a.summary;

  // ── 1 ─────────────────────────────────────────────────────────────────────
  h(1, 'LEGACY vs E1 CENSUS, side by side', 'MEASURED FACT');
  console.log(`   in scope: ${present.join(', ')}\n`);
  r('source rows', S.sourceRows);
  Object.entries(a.measured.rowsByTable).forEach(([t, n]) => r(`  ${t}`, n));
  console.log('');
  r('legacy canonical groups', S.legacyGroups);
  r('E1 molecule groups', S.e1Groups);
  r('legacy multi-name groups', S.legacyMultiName);
  r('E1 multi-name groups', S.e1MultiName);
  console.log('');
  r('legacy conflict groups (>1 valid CAS)', S.legacyConflicts);
  r('E1 GENUINE conflict groups', S.e1Conflicts);
  r('conflicts eliminated by preserving salt/form', S.eliminatedBySaltForm);
  r('conflicts that survive E1', S.surviving);
  console.log('');
  r('CAS missing entirely', `${a.measured.casMissing}  (${pct(a.measured.casMissing, S.sourceRows)})`);
  r('CAS present and checksum-valid', a.measured.casPresentValid);
  r('CAS present but checksum-INVALID', a.measured.casPresentInvalid);

  // ── 2 ─────────────────────────────────────────────────────────────────────
  h(2, 'THE EXACT SALT/FORM SEPARATION EFFECT', 'E1 CLASSIFICATION');
  console.log('   A conflict counts as eliminated ONLY when the E1 grouping explains it: the legacy');
  console.log('   group splits into two or more identities and every one carries at most one valid');
  console.log('   CAS. A conflict that merely MOVES is reported as surviving, not resolved.\n');
  r('eliminated', S.eliminatedBySaltForm);
  if (a.eliminated.length) {
    console.log('\n   every elimination, with its split — inspect these:\n');
    a.eliminated.forEach((e) => {
      console.log(`     legacy group: ${e.legacy}   had CAS: ${e.legacyCas.join(' | ')}`);
      console.log(`       filed as  : ${e.filedAs.join(' | ')}`);
      e.splitInto.forEach((p) => {
        console.log(`       -> ${String(p.identity).padEnd(46)} ${p.cas.join(' | ') || '(no valid CAS)'}`
          + `   form=${p.form}${p.base ? ` base=${p.base}` : ''}`);
      });
      console.log('');
    });
  }

  // ── 3 ─────────────────────────────────────────────────────────────────────
  h(3, 'GENUINE SURVIVING IDENTITY CONFLICTS', 'E1 CLASSIFICATION');
  console.log('   These are NOT form artefacts. The migration refuses them and records them in');
  console.log('   molecule_conflicts; a human rules on each one.\n');
  r('surviving conflict groups', S.surviving);
  a.surviving.forEach((s) => {
    console.log(`\n     ${s.legacy}`);
    console.log(`       filed as : ${s.filedAs.join(' | ')}`);
    console.log(`       CAS      : ${s.legacyCas.join(' | ')}`);
    console.log(`       why      : ${s.reason}`);
    s.splitInto.forEach((p) => {
      if (p.cas.length > 1) console.log(`       ** ${p.identity} holds ${p.cas.join(' | ')}`);
    });
  });

  // ── 4 ─────────────────────────────────────────────────────────────────────
  h(4, 'cas_shared_across_molecules', 'MEASURED FACT + E1 CLASSIFICATION');
  console.log('   One valid CAS, more than one distinct E1 identity. A shared CAS is EVIDENCE');
  console.log('   REQUIRING CLASSIFICATION, never merge permission: nothing here merges the');
  console.log('   molecules, chooses an owner, or concludes synonymy.\n');
  r('CAS values spanning >1 identity', S.sharedCas);
  r('of those, REVIEW_REQUIRED', S.sharedCasReviewRequired);
  a.sharedCas
    .sort((x, y) => (x.explanation === 'REVIEW_REQUIRED' ? -1 : 1) - (y.explanation === 'REVIEW_REQUIRED' ? -1 : 1))
    .forEach((s) => {
      console.log(`\n     CAS ${s.cas}   ${s.explanation}`);
      console.log(`       identities : ${s.identities.join(' | ')}`);
      console.log(`       filed as   : ${[...new Set(s.sourceNames)].join(' | ')}`);
      console.log(`       rows       : ${s.refs.join(', ')}`);
    });

  // ── 5 ─────────────────────────────────────────────────────────────────────
  h(5, 'INVALID-CAS EVIDENCE', 'MEASURED FACT');
  console.log('   A CAS-shaped value whose checksum fails is not discarded silently. It is refused');
  console.log('   as a trusted identifier AND reported, because "absent" and "the source asserted');
  console.log('   something that cannot be true" are materially different evidence states.');
  console.log('   No permanent invalid-CAS schema is created by this preview.\n');
  r('occurrences', S.invalidCasOccurrences);
  r('distinct invalid values', S.invalidCasDistinct);
  const affected = new Set(a.invalidCas.occurrences.map((o) => o.e1).filter(Boolean));
  r('E1 groups affected', affected.size);
  if (a.invalidCas.occurrences.length) {
    console.log('\n     representative rows (first 25):');
    a.invalidCas.occurrences.slice(0, 25).forEach((o) => {
      console.log(`       ${String(o.cas).padEnd(18)} ${String(o.e1).padEnd(40)} ${o.table}#${o.rid}`);
    });
    if (a.invalidCas.occurrences.length > 25) {
      console.log(`       … and ${a.invalidCas.occurrences.length - 25} more`);
    }
  }

  // ── 6 ─────────────────────────────────────────────────────────────────────
  h(6, 'IDENTITY-BEARING TABLE INVENTORY', 'MEASURED FACT');
  const cols = await query(`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema='public'
       AND (column_name ILIKE '%inchi%' OR column_name ILIKE '%smiles%'
            OR column_name ILIKE '%cas%' OR column_name ILIKE '%molecule%')
     ORDER BY table_name, column_name`);
  const byTable = {};
  cols.rows.forEach((c) => { (byTable[c.table_name] = byTable[c.table_name] || []).push(c.column_name); });
  const structural = cols.rows.filter((c) => /inchi|smiles/i.test(c.column_name));
  r('tables carrying molecule identity', Object.keys(byTable).length);
  r('identity columns in total', cols.rowCount);
  r('columns carrying STRUCTURE (inchi/smiles)', structural.length === 0
    ? '0   ← InChIKey stays nullable and unpopulated in E1' : structural.length);

  // ── 7 ─────────────────────────────────────────────────────────────────────
  h(7, 'COMMERCIAL-RISK CLASSIFICATION', 'HUMAN INTERPRETATION — overrule freely');
  console.log('   Tier 1 = a wrong identity here can reach a quotation, RFQ, sourcing decision or');
  console.log('   customer transaction. NONE of these are migrated during E1; this is the adoption');
  console.log('   order afterwards, and commercial paths come before SEO/pricing enrichment.\n');
  for (const tier of [1, 2, 3]) {
    const list = Object.keys(byTable).filter((t) => TIERS[t] === tier).sort();
    console.log(`   TIER ${tier} — ${TIER_NAME[tier]}  (${list.length})`);
    list.forEach((t) => {
      const inScope = SOURCES.some((s) => s.table === t) ? '  ← IN E1 SCOPE' : '';
      console.log(`     ${String(t).padEnd(28)} ${byTable[t].join(', ')}${inScope}`);
    });
    console.log('');
  }
  const unclassified = Object.keys(byTable).filter((t) => !TIERS[t]).sort();
  if (unclassified.length) {
    console.log(`   UNCLASSIFIED — appeared since the tiering was written  (${unclassified.length})`);
    unclassified.forEach((t) => console.log(`     ${String(t).padEnd(28)} ${byTable[t].join(', ')}`));
    console.log('     ^ these need a tier before any adoption sequence is agreed.\n');
  }

  // ── 8, 9 ──────────────────────────────────────────────────────────────────
  h(8, 'PROPOSED QUARANTINE / SAFE-CREATE COUNTS', 'PREDICTION — what the migration WOULD do');
  const counts = {};
  for (const flags of a.classification.values()) {
    flags.forEach((f) => { counts[f] = (counts[f] || 0) + 1; });
  }
  ['SAFE_TO_CREATE', 'QUARANTINE_IDENTITY_CONFLICT', 'REVIEW_SHARED_CAS',
    'INVALID_CAS_EVIDENCE', 'INSUFFICIENT_IDENTITY'].forEach((k) => r(k, counts[k] || 0));
  console.log('\n   A group may carry several of these at once; SAFE_TO_CREATE is present exactly');
  console.log('   when no BLOCKER (quarantine / insufficient identity) applies. REVIEW_SHARED_CAS');
  console.log('   and INVALID_CAS_EVIDENCE are advisory: they do not stop a well-named substance');
  console.log('   being created, they flag an attribution a human should check.');

  // ── 10, 11 ────────────────────────────────────────────────────────────────
  h(10, 'MIGRATION BLOCKERS, with a representative example of each class', 'E1 CLASSIFICATION');
  const blockers = [];
  if (S.e1Conflicts > 0) blockers.push(['QUARANTINE_IDENTITY_CONFLICT', `${S.e1Conflicts} identities hold >1 valid CAS`]);
  if (S.insufficient > 0) blockers.push(['INSUFFICIENT_IDENTITY', `${S.insufficient} group(s) cannot be named`]);
  if (S.sharedCasReviewRequired > 0) blockers.push(['REVIEW_SHARED_CAS (advisory)', `${S.sharedCasReviewRequired} CAS values span identities with no curated explanation`]);
  if (S.invalidCasOccurrences > 0) blockers.push(['INVALID_CAS_EVIDENCE (advisory)', `${S.invalidCasOccurrences} CAS-shaped values fail checksum`]);
  if (!blockers.length) console.log('   none.');
  blockers.forEach(([k, why]) => console.log(`   ${String(k).padEnd(38)} ${why}`));

  console.log('\n   representative examples:');
  if (a.surviving.length) {
    const ex = a.surviving[0];
    console.log(`\n     QUARANTINE_IDENTITY_CONFLICT`);
    console.log(`       ${ex.filedAs.join(' | ')}  ->  ${ex.legacyCas.join(' | ')}`);
    console.log(`       ${ex.reason}`);
  }
  const rev = a.sharedCas.find((s) => s.explanation === 'REVIEW_REQUIRED');
  if (rev) {
    console.log(`\n     REVIEW_SHARED_CAS`);
    console.log(`       CAS ${rev.cas} is attached to: ${rev.identities.join(' | ')}`);
    console.log(`       no curated synonym or form relationship explains it`);
  }
  if (a.invalidCas.occurrences.length) {
    const iv = a.invalidCas.occurrences[0];
    console.log(`\n     INVALID_CAS_EVIDENCE`);
    console.log(`       "${iv.cas}" on ${iv.table}#${iv.rid} (${iv.e1}) — correct shape, wrong check digit`);
  }
  const uns = a.e1.groups.get('__unresolvable__');
  if (uns) {
    console.log(`\n     INSUFFICIENT_IDENTITY`);
    console.log(`       ${[...uns.names].slice(0, 5).map((n) => JSON.stringify(n)).join(', ')} (${uns.rows} row(s))`);
  }

  // ── 12 ───────────────────────────────────────────────────────────────────
  h(12, 'RECOMMENDATION', 'HUMAN INTERPRETATION — the decision is yours');
  const rec = S.e1Conflicts === 0 && S.insufficient === 0 ? 'GO'
    : (S.safeToCreate > 0 ? 'GO WITH QUARANTINE' : 'NO-GO');
  console.log(`   ${rec}\n`);
  if (rec === 'GO WITH QUARANTINE') {
    console.log(`   ${S.safeToCreate} substances are sufficiently evidenced to create.`);
    console.log(`   ${S.e1Conflicts} identity conflicts and ${S.insufficient} unnameable group(s) are REFUSED and recorded,`);
    console.log('   not decided. Those rows stay unlinked with a reason attached, so they read as');
    console.log('   "attempted and refused" rather than "not yet attempted".');
  } else if (rec === 'NO-GO') {
    console.log('   nothing is safely creatable — do not migrate.');
  } else {
    console.log('   no blocking condition found.');
  }
  console.log('\n   This preview ran E1 NOWHERE. No table was created, no row written, no conflict');
  console.log('   resolved. The migration is a separate command and is not authorised by this');
  console.log('   output alone.\n');
}

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(`\n✗ preview could not run: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
