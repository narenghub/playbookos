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

// ── WHY A SUMMARY MODE EXISTS ───────────────────────────────────────────────
//
// The full report is ~2,800 lines, most of it the 2,433-name CREATE listing. On 29 Oct a run over
// `railway ssh` was CUT OFF at about line 2,100 — and the ssh client still exited 0, because that
// status belongs to the transport and not to the script. Everything that decides the migration
// (the expected state, the invariants, the exclusion integrity, the verdict) prints at the END, so
// a truncated run loses exactly the part worth reading while looking like a success.
//
// That is the `| tail -1` outage in a new costume: a verdict inferred from a stream that did not
// finish. --summary prints the decision sections only, about 120 lines, which crosses the wire
// intact. The full listings remain available without the flag, for a run that writes to a file.
const SUMMARY = process.argv.slice(2).includes('--summary');
const KNOWN = ['--summary'];
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

// ── THE PREVIOUS RUN, RECORDED SO THE DELTA IS COMPUTED AND NOT CLAIMED ─────
//
// Measured on production at commit 1dc702c, 29 Oct 2026, BEFORE purpose-descriptor normalization
// existed. Hard-coded on purpose: a delta against a number somebody remembers is not a delta.
// If the corrected run reports the same figures, nothing changed and the report should say so
// rather than imply improvement.
const BASELINE = {
  label: '240e48f (first descriptor pass — 10 gaps remained, verdict NO-GO)',
  e1Groups: 2529,
  e1MultiName: 553,
  e1Conflicts: 48,
  legacyConflicts: 104,
  eliminatedBySaltForm: 60,
  surviving: 44,
  safeToCreate: 2481,
  quarantine: 48,
  insufficient: 0,
  sharedCas: 134,
  sharedCasIdentitiesTotal: 312,
  sharedCasReviewRequired: 95,
  sharedCasDescriptorVariant: 10,
  invalidCasOccurrences: 346,
  invalidCasDistinct: 294,
};

// The run before descriptor normalization existed, kept so the cumulative effect stays visible
// after BASELINE has moved on. These are the figures the NO-GO was called on.
const ORIGINAL = {
  label: '1dc702c (pre-descriptor-normalization)',
  e1Groups: 2990, safeToCreate: 2944, sharedCas: 341,
  sharedCasIdentitiesTotal: 823, sharedCasReviewRequired: 328,
};
const delta = (now, then) => {
  if (then === undefined || then === null) return `${now}`;
  const d = now - then;
  const arrow = d === 0 ? '  =' : (d > 0 ? ` +${d}` : ` ${d}`);
  return `${String(now).padEnd(8)} (was ${then})${arrow}`;
};

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

  // ── 1b ────────────────────────────────────────────────────────────────────
  h('1b', `OLD PREVIEW -> CORRECTED PREVIEW DELTA   [baseline: ${BASELINE.label}]`, 'MEASURED FACT');
  console.log('   A zero delta means the correction changed nothing on that measure. Said plainly');
  console.log('   rather than implied, because the point of a baseline is to be able to be wrong.\n');
  r('proposed molecule groups', delta(S.e1Groups, BASELINE.e1Groups));
  r('multi-name groups', delta(S.e1MultiName, BASELINE.e1MultiName));
  r('E1 conflict groups', delta(S.e1Conflicts, BASELINE.e1Conflicts));
  r('legacy conflict groups', delta(S.legacyConflicts, BASELINE.legacyConflicts));
  r('eliminated by salt/form preservation', delta(S.eliminatedBySaltForm, BASELINE.eliminatedBySaltForm));
  r('surviving legacy conflicts', delta(S.surviving, BASELINE.surviving));
  console.log('');
  r('SAFE_TO_CREATE', delta(S.safeToCreate, BASELINE.safeToCreate));
  r('QUARANTINE_IDENTITY_CONFLICT', delta(S.quarantine, BASELINE.quarantine));
  r('INSUFFICIENT_IDENTITY', delta(S.insufficient, BASELINE.insufficient));
  console.log('');
  r('shared-CAS values (all kinds)', delta(S.sharedCas, BASELINE.sharedCas));
  r('identities touched by a shared CAS', delta(S.sharedCasIdentitiesTotal, BASELINE.sharedCasIdentitiesTotal));
  r('  DESCRIPTOR_VARIANT (normalization gap)', S.sharedCasDescriptorVariant);
  r('  EXPLAINED (curated synonym / form)', S.sharedCasExplained);
  r('  DISTINCT_NAMES_SHARED_CAS (review)', delta(S.sharedCasDistinctNames, BASELINE.sharedCasReviewRequired));
  console.log('');
  r('invalid-CAS occurrences', delta(S.invalidCasOccurrences, BASELINE.invalidCasOccurrences));
  r('invalid-CAS distinct values', delta(S.invalidCasDistinct, BASELINE.invalidCasDistinct));
  console.log(`\n   cumulative, against ${ORIGINAL.label}:\n`);
  r('proposed molecule groups', delta(S.e1Groups, ORIGINAL.e1Groups));
  r('SAFE_TO_CREATE', delta(S.safeToCreate, ORIGINAL.safeToCreate));
  r('shared-CAS values', delta(S.sharedCas, ORIGINAL.sharedCas));
  r('identities touched by a shared CAS', delta(S.sharedCasIdentitiesTotal, ORIGINAL.sharedCasIdentitiesTotal));
  r('DISTINCT_NAMES_SHARED_CAS (review queue)', delta(S.sharedCasDistinctNames, ORIGINAL.sharedCasReviewRequired));

  // ── 1c ────────────────────────────────────────────────────────────────────
  h('1c', 'DETERMINISTIC DESCRIPTOR NORMALIZATION — what it removed, and how often',
    'MEASURED FACT');
  console.log('   Grade and purpose nomenclature only. Chemical form is never removed: `free acid`');
  console.log('   and `free base` are deliberately NOT in the stripping rules, and the salt, ester');
  console.log('   and hydrate tokens are untouched by it.\n');
  r('rows whose filed name was normalized', S.descriptorNormalizedRows);
  const removedCounts = Object.entries(a.descriptorRemovedCounts).sort((x, y) => y[1] - x[1]);
  if (!removedCounts.length) console.log('\n   nothing was removed — no descriptor phrasing is present in this data.');
  removedCounts.forEach(([w, n]) => r(`  removed "${w}"`, n));
  if (a.descriptorNormalized.length) {
    console.log('\n     representative normalizations (first 20) — the evidence each rule APPLIED:');
    a.descriptorNormalized.slice(0, 20).forEach((d) => {
      console.log(`       ${String(d.filed).slice(0, 56).padEnd(58)} -> ${String(d.identity).padEnd(30)} [-${d.removed.join(', -')}]`);
    });
  }

  // ── 2 ─────────────────────────────────────────────────────────────────────
  h(2, 'THE EXACT SALT/FORM SEPARATION EFFECT', 'E1 CLASSIFICATION');
  console.log('   A conflict counts as eliminated ONLY when the E1 grouping explains it: the legacy');
  console.log('   group splits into two or more identities and every one carries at most one valid');
  console.log('   CAS. A conflict that merely MOVES is reported as surviving, not resolved.\n');
  r('eliminated', S.eliminatedBySaltForm);
  if (a.eliminated.length && !SUMMARY) {
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
  r('  DESCRIPTOR_VARIANT — normalization gap', S.sharedCasDescriptorVariant);
  r('  EXPLAINED — curated synonym or form', S.sharedCasExplained);
  r('  DISTINCT_NAMES_SHARED_CAS — REVIEW', S.sharedCasDistinctNames);
  console.log('\n   DESCRIPTOR_VARIANT is evidence that a normalization RULE is missing, not work');
  console.log('   for a human. DISTINCT_NAMES_SHARED_CAS is the real review queue, and it is where');
  console.log('   probable source misattribution lives — two unrelated drugs under one registry');
  console.log('   number stay separate and stay visible.\n');

  const ORDER = { DISTINCT_NAMES_SHARED_CAS: 0, DESCRIPTOR_VARIANT: 1, EXPLAINED: 2 };
  if (!SUMMARY) a.sharedCas.sort((x, y) => ORDER[x.kind] - ORDER[y.kind]).forEach((s) => {
    console.log(`\n     CAS ${s.cas}   ${s.kind}`);
    console.log(`       identities : ${s.identities.join(' | ')}`);
    console.log(`       filed as   : ${s.sourceNames.join(' | ')}`);
    console.log(`       rows       : ${s.refs.slice(0, 8).join(', ')}`);
  });

  // ── 4b ────────────────────────────────────────────────────────────────────
  h('4b', 'SYNONYM CANDIDATES — reported for review, NOT added', 'HUMAN REVIEW ITEM');
  console.log('   A shared CAS is never licence to create a synonym row. `aspirin` /');
  console.log('   `acetylsalicylic acid` was added by hand as one pair after inspection;');
  console.log('   `mirvetuximab soravtansine` / `durvalumab` share a number and are two different');
  console.log('   drugs. Only a human can tell those apart, so nothing below is acted on.\n');
  r('candidates awaiting a decision', S.synonymCandidates);
  if (!SUMMARY) a.synonymCandidates.slice(0, 60).forEach((c) => {
    console.log(`     CAS ${String(c.cas).padEnd(16)} ${c.identities.join('  <->  ')}`);
  });
  // Gated with the listing it belongs to. Left ungated, --summary printed "… and 37 more" under a
  // heading with nothing above it — a continuation of a list the reader was never shown.
  if (!SUMMARY && a.synonymCandidates.length > 60) {
    console.log(`     … and ${a.synonymCandidates.length - 60} more`);
  }
  if (SUMMARY && a.synonymCandidates.length) {
    console.log(`     (${a.synonymCandidates.length} candidates; listing suppressed by --summary)`);
  }

  // ── 4c ────────────────────────────────────────────────────────────────────
  h('4c', 'TRUNCATED / UNBALANCED CHEMICAL NAMES', 'MEASURED FACT — upstream defect, not E1\'s');
  console.log('   An unbalanced bracket means the source name was cut before it was stored.');
  console.log('   Recorded and deliberately NOT repaired: guessing the missing half of a chemical');
  console.log('   name is the kind of plausible invention this platform refuses. Fixing the ingest');
  console.log('   that truncates them is separate work and does not belong inside E1.\n');
  r('names that look truncated', S.truncatedNames);
  a.truncatedNames.slice(0, 20).forEach((t) => {
    console.log(`     ${String(t.filed).slice(0, 62).padEnd(64)} ${t.why}   ${t.table}#${t.rid}`);
  });
  if (a.truncatedNames.length > 20) console.log(`     … and ${a.truncatedNames.length - 20} more`);

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

  // ── E1.1-1 ────────────────────────────────────────────────────────────────
  h('E1.1-1', 'FREE BASE / FREE ACID, classified against evidence', 'E1 CLASSIFICATION');
  console.log('   No global stripping rule, and none derived from frequency. Each case is decided');
  console.log('   on what the source says, and where it says too little the answer is AMBIGUOUS.');
  console.log('   NOTHING IS MERGED by this census.\n');
  console.log('   STRUCTURAL EVIDENCE: NONE. No InChIKey, SMILES or molfile exists anywhere in');
  console.log('   this database (section 6 proves it against the live schema), so every');
  console.log('   classification below rests on names and registry numbers alone.\n');
  r('cases found', S.freeFormCases);
  r('  SAME_NEUTRAL_SUBSTANCE', S.freeFormSameNeutral);
  r('  DISTINCT_FORM', S.freeFormDistinct);
  r('  AMBIGUOUS (blocked from creation)', S.freeFormAmbiguous);
  if (!SUMMARY) a.freeForm.forEach((f) => {
    console.log(`\n     ${f.identity}   [${f.disposition}]`);
    console.log(`       filed as        : ${f.sourceNames.join(' | ')}`);
    console.log(`       CAS             : ${f.cas.join(' | ') || '(none valid)'}`);
    console.log(`       neutral parent  : ${f.parentExists ? `"${f.parent}" EXISTS, CAS ${f.parentCas.join(' | ') || '(none valid)'}` : `"${f.parent}" ABSENT`}`);
    console.log(`       salt/form kin   : ${f.saltCounterparts.join(', ') || '(none)'}`);
    console.log(`       shares CAS with : ${f.sharedCasWith.join(', ') || '(nothing)'}`);
    console.log(`       structural ev.  : ${f.structuralEvidence}`);
    console.log(`       reason          : ${f.reason}`);
    console.log(`       E1 disposition  : ${(a.classification.get(f.identity) || []).join(', ')}`);
    console.log(`       rows            : ${f.refs.join(', ')}`);
    if (f.aliasProof && f.aliasProof.verdict !== 'NOT_APPLICABLE') {
      console.log(`       DECISION 3      : ${f.aliasProof.verdict}`);
      f.aliasProof.checks.forEach(([n, okk]) => console.log(`         ${okk ? 'ok  ' : 'FAIL'}  ${n}`));
    }
  });
  const proven = a.freeForm.filter((f) => f.aliasProof && f.aliasProof.verdict === 'ALIAS_PROVEN');
  console.log(`\n   DECISION 3 SUMMARY: ${proven.length} of ${S.duplicateRisk} duplicate-risk identities are ALIAS_PROVEN.`);
  console.log('   Seven is not a reason to approve seven: any single failed check leaves the');
  console.log('   identity excluded. Proven cases are added through the curated alias mechanism');
  console.log('   only, as explicit pairs — NOT as a general free-base rule.');
  if (proven.length) {
    console.log('\n     proven, ready to add as curated pairs:');
    proven.forEach((f) => console.log(`       ['${f.parent}', '${f.identity}']`));
  }
  const notProven = a.freeForm.filter((f) => f.aliasProof && f.aliasProof.verdict === 'NOT_PROVEN');
  if (notProven.length) {
    console.log('\n     NOT proven — stay excluded:');
    notProven.forEach((f) => console.log(`       ${String(f.identity).padEnd(34)} failed: ${f.aliasProof.failed.join('; ')}`));
  }

  // ── E1.1-2 ────────────────────────────────────────────────────────────────
  h('E1.1-2', 'DRONABINOL / DELTA-9-THC CLUSTER — evidence, not a verdict', 'MEASURED FACT');
  console.log('   Whether a generic THC name stands in for a specific stereoisomer is a judgement');
  console.log('   about source intent. The records are printed with the stereochemical and');
  console.log('   isotopic markers each name does or does not carry, so a human can rule.');
  console.log('   No synonym is added, and a shared CAS is not treated as equivalence.\n');
  r('identities in the cluster', S.thcIdentities);
  if (!SUMMARY) a.thcCluster.forEach((t) => {
    console.log(`\n     ${t.identity}`);
    console.log(`       filed as   : ${t.sourceNames.join(' | ')}`);
    console.log(`       CAS        : ${t.cas.join(' | ') || '(none valid)'}`
      + `${t.invalidCas.length ? `   invalid: ${t.invalidCas.join(' | ')}` : ''}`);
    console.log(`       rows       : ${t.rows}   form=${t.form}`);
    console.log(`       stereo marker in the name : ${t.hasStereoMarker ? 'YES' : 'no'}`);
    console.log(`       isotope marker in the name: ${t.hasIsotopeMarker ? 'YES' : 'no'}`);
    console.log(`       refs       : ${t.refs.join(', ')}`);
  });

  // ── E1.1-3 ────────────────────────────────────────────────────────────────
  h('E1.1-3', 'CORRUPTED_NAME_REVIEW_REQUIRED — all detected truncated names', 'MEASURED FACT');
  console.log('   Upstream ingest defect. NOT repaired from CAS, and NOT created as a molecule:');
  console.log('   sharing a registry number with the real substance is the fact that makes a');
  console.log('   corrupted name look resolvable, and it is the fact that makes it dangerous.');
  console.log('   A name nobody can read is not an identity.\n');
  r('names detected', S.truncatedNames);
  r('identities excluded from creation', S.corruptedName);
  a.truncatedNames.forEach((t) => {
    console.log(`\n     CORRUPTED_NAME_REVIEW_REQUIRED`);
    console.log(`       filed : ${t.filed}`);
    console.log(`       why   : ${t.why}`);
    console.log(`       row   : ${t.table}#${t.rid}   <- repair the ingest here`);
  });

  // ── E1.1-4 ────────────────────────────────────────────────────────────────
  h('E1.1-4', 'ISOTOPE REGRESSION INVARIANT', 'E1 CLASSIFICATION');
  console.log('   > Commercial and analytical descriptors may normalize away;');
  console.log('   > isotopic composition must not.\n');
  console.log('   Asserted in src/lib/molecules/preview.test.js as two regression tests, so a');
  console.log('   future widening of the descriptor rules fails the suite rather than silently');
  console.log('   collapsing an enriched compound into its natural-abundance form.\n');
  const isotopeIds = [...a.e1.groups.keys()].filter((k) => /enriched|deuterated|\[18f\]|\bd\d\b|-d\d/.test(k));
  r('identities carrying an isotopic marker', isotopeIds.length);
  if (!SUMMARY) isotopeIds.slice(0, 20).forEach((k) => {
    const g = a.e1.groups.get(k);
    console.log(`     ${String(k).padEnd(56)} CAS ${[...g.cas].join(' | ') || '(none valid)'}`);
  });

  // ── E1.1-5 ────────────────────────────────────────────────────────────────
  h('E1.1-5', 'PROPOSED E1 EXECUTION SET', 'PREDICTION — nothing is executed');
  const ex = a.executionSet;
  r('CREATE', ex.CREATE.length);
  r('QUARANTINE_IDENTITY_CONFLICT', ex.QUARANTINE_IDENTITY_CONFLICT.length);
  r('QUARANTINE_CORRUPTED_NAME', ex.QUARANTINE_CORRUPTED_NAME.length);
  r('AMBIGUOUS_FORM', ex.AMBIGUOUS_FORM.length);
  r('DUPLICATE_RISK', ex.DUPLICATE_RISK.length);
  r('INSUFFICIENT_IDENTITY', ex.INSUFFICIENT_IDENTITY.length);
  r('REVIEW_SHARED_CAS (advisory, still created)', ex.REVIEW_SHARED_CAS.length);
  r('INVALID_CAS_EVIDENCE (advisory, still created)', ex.INVALID_CAS_EVIDENCE.length);

  // ── THE CREATE SET, IN FULL ──────────────────────────────────────────────
  //
  // The previous run printed the count and not the identities, so nothing in the report let anyone
  // check WHAT would be created — which is how `amine` sat in the execution set unnoticed. Four
  // per line because this is a list to scan, and railway ssh hangs up on silence rather than on
  // volume.
  if (SUMMARY) {
    console.log(`\n   CREATE — ${ex.CREATE.length} identities (listing suppressed by --summary; run without it for all names)`);
  } else {
    console.log(`\n   CREATE — all ${ex.CREATE.length} identities:\n`);
    const sorted = ex.CREATE.slice().sort();
    for (let i = 0; i < sorted.length; i += 4) {
      console.log(`     ${sorted.slice(i, i + 4).map((s) => String(s).slice(0, 34).padEnd(36)).join('')}`);
    }
  }

  if (a.fragmentSuspects.length) {
    console.log(`\n   FRAGMENT_SUSPECT — in CREATE, shaped like the tail of an IUPAC name (${a.fragmentSuspects.length}):`);
    console.log('   REVIEW ONLY, not excluded: the pattern also matches real compounds, and a');
    console.log('   false exclusion is its own kind of silent loss.\n');
    a.fragmentSuspects.forEach((k) => console.log(`     ${k}`));
  }

  console.log('\n   the excluded identities, in full:\n');
  for (const cat of ['QUARANTINE_IDENTITY_CONFLICT', 'QUARANTINE_CORRUPTED_NAME',
    'AMBIGUOUS_FORM', 'DUPLICATE_RISK', 'INSUFFICIENT_IDENTITY']) {
    if (!ex[cat].length) continue;
    console.log(`     ${cat}  (${ex[cat].length})`);
    ex[cat].forEach((k) => console.log(`       ${String(k).slice(0, 62).padEnd(64)} ${a.exclusionReasons.get(k) || '(NO REASON — DEFECT)'}`));
    console.log('');
  }

  // ── E1.1-5c ───────────────────────────────────────────────────────────────
  h('E1.1-5c', 'AUTHORITATIVE EXPECTED MIGRATION STATE', 'PREDICTION');
  r('proposed groups', S.e1Groups);
  r('CREATE', ex.CREATE.length);
  r('EXCLUDED', a.exclusionIntegrity.excluded);
  r('identity conflicts', S.quarantine);
  r('corrupted names', S.corruptedName);
  r('insufficient identities', S.insufficient);
  r('duplicate-risk exclusions', S.duplicateRisk);
  r('shared-CAS review identities', ex.REVIEW_SHARED_CAS.length);
  r('curated-synonym folds (alias, not molecule)', S.aliasFolded);
  console.log('');
  console.log('   CAS evidence states on the CREATE set — kept apart, never flattened:\n');
  r('  canonical CAS populated', S.casPopulated);
  r('  CAS_MISSING (absent at source)', S.casMissing);
  r('  CAS_PRESENT_INVALID (suppressed)', S.casPresentInvalidOnly);
  r('  CAS_CONTESTED (suppressed, evidence kept)', S.casContested);
  const casSum = S.casPopulated + S.casMissing + S.casPresentInvalidOnly + S.casContested;
  r('  sum', `${casSum}  ${casSum === ex.CREATE.length ? '✓ equals CREATE' : '✗ DOES NOT EQUAL CREATE'}`);
  console.log('');
  r('InChIKey populated', `${S.inchikeyPopulated}   (E1 writes none; the Postgres checker asserts NULL)`);

  h('E1.1-5d', 'REQUIRED INVARIANTS', 'MEASURED FACT');

  // The set of registry numbers two or more distinct substances both claim.
  const contestedCasValues = new Set(
    a.sharedCas.filter((s) => s.kind === 'DISTINCT_NAMES_SHARED_CAS').map((s) => s.cas));
  // Any identity that would be CREATED carrying one of them while NOT being marked contested.
  const contestedLeak = ex.CREATE.filter((k) => {
    const g = a.e1.groups.get(k);
    if (!g) return false;
    const holdsContested = [...g.cas].some((c) => contestedCasValues.has(c));
    return holdsContested && !a.casEvidence.CAS_CONTESTED.includes(k);
  });

  const inv = [
    ['CREATE + EXCLUDED = PROPOSED',
      ex.CREATE.length + a.exclusionIntegrity.excluded === S.e1Groups,
      `${ex.CREATE.length} + ${a.exclusionIntegrity.excluded} = ${ex.CREATE.length + a.exclusionIntegrity.excluded} vs ${S.e1Groups}`],
    ['CREATE n EXCLUDED = empty',
      a.exclusionIntegrity.createdAndExcluded.length === 0,
      `${a.exclusionIntegrity.createdAndExcluded.length} overlap`],
    ['UNEXPLAINED_EXCLUSIONS = 0',
      a.exclusionIntegrity.missingReason.length === 0,
      `${a.exclusionIntegrity.missingReason.length}`],
    // ── COMPUTED, NOT ASSERTED ────
    //
    // This read `true`. A hardcoded invariant reports PASS on something nobody tested, which is
    // the same failure as reading a checker through `tail -1`: the output says the thing holds
    // and no code anywhere established that it does.
    //
    // What it now checks: every CREATE identity holding a CAS that is contested across distinct
    // substances must be classified CAS_CONTESTED — never CAS_POPULATED. That classification is
    // precisely what the backfill acts on when it writes cas = NULL, so a violation here is an
    // identity that WOULD be written with a disputed registry number.
    //
    // The behavioural half — that the backfill actually withholds it — is proven separately in
    // scripts/check-molecule-identity-db.js against a real Postgres, with selumetinib and
    // binimetinib seeded in DIFFERENT tables. Two different paths, deliberately: a preview that
    // graded its own downstream behaviour would be the implementation marking its own homework.
    ['CONTESTED_CAS_WRITTEN_CANONICALLY = 0',
      contestedLeak.length === 0,
      contestedLeak.length === 0
        ? `${S.casContested} contested identities, every one classified CAS_CONTESTED (not populated)`
        : `${contestedLeak.length} would carry a disputed CAS: ${contestedLeak.slice(0, 5).join(', ')}`],
  ];
  let invFail = 0;
  inv.forEach(([name, pass, detail]) => {
    if (!pass) invFail += 1;
    console.log(`   ${pass ? 'ok  ' : 'FAIL'}  ${String(name).padEnd(42)} ${detail}`);
  });
  console.log(`\n   ${invFail === 0 ? 'all invariants hold' : `${invFail} INVARIANT(S) FAILED — do not run the migration`}`);

  h('E1.1-5b', 'EXCLUSION INTEGRITY — the assertion that matters', 'MEASURED FACT');
  const ei = a.exclusionIntegrity;
  r('identities excluded from creation', ei.excluded);
  r('of those, carrying an explicit reason', ei.withReason);
  r('excluded WITHOUT a reason', ei.missingReason.length === 0 ? '0  ✓' : `${ei.missingReason.length}  ✗ DEFECT`);
  r('both created AND excluded', ei.createdAndExcluded.length === 0 ? '0  ✓' : `${ei.createdAndExcluded.length}  ✗ DEFECT`);
  if (ei.missingReason.length) {
    console.log('\n     ✗ these would be silently skipped — that is the failure mode this phase exists to remove:');
    ei.missingReason.slice(0, 20).forEach((k) => console.log(`       ${k}`));
  }

  // ── 12 ───────────────────────────────────────────────────────────────────
  h(12, 'RECOMMENDATION', 'HUMAN INTERPRETATION — the decision is yours');

  // ── NOT A BLOCKER COUNT ──────────────────────────────────────────────────
  //
  // The previous version of this script printed GO WITH QUARANTINE off a numeric blocker test, and
  // it was wrong: 823 identities were touched by a shared CAS and the overwhelming cause was a
  // missing normalization rule, which that test classed as advisory. A mechanical GO is how a
  // design defect gets waved through by its own tooling.
  //
  // So the gate is five separate questions, each answered before any recommendation is printed.
  console.log('   The five categories, separately:\n');
  r('1. deterministic normalization findings', `${S.descriptorNormalizedRows} rows normalized, `
    + `${S.sharedCasDescriptorVariant} descriptor gap(s) remaining`);
  r('2. quarantinable source conflicts', `${S.e1Conflicts} identities hold >1 valid CAS`);
  r('3. unresolved cross-molecule identity risk', `${S.sharedCasDistinctNames} CAS value(s) span distinct names`);
  r('4. invalid source evidence', `${S.invalidCasOccurrences} occurrence(s), ${S.invalidCasDistinct} distinct`);
  r('5. human-review items', `${S.synonymCandidates} synonym candidate(s), `
    + `${S.truncatedNames} truncated name(s)`);
  console.log('');

  // GO WITH QUARANTINE is acceptable only when safe identities can be created without silently
  // merging or duplicating unresolved chemical identities, AND every unresolved case can be
  // excluded deterministically. A remaining descriptor gap fails the first condition, because it
  // means the run would create duplicates of substances it should treat as one.
  const wouldDuplicate = S.sharedCasDescriptorVariant > 0;
  const nothingSafe = S.safeToCreate === 0;
  // An exclusion nobody can explain is an identity silently skipped, which is the failure class
  // this whole phase exists to remove. It is a hard NO-GO, not a warning.
  const unexplained = a.exclusionIntegrity.missingReason.length > 0
    || a.exclusionIntegrity.createdAndExcluded.length > 0;

  let rec;
  if (nothingSafe || wouldDuplicate || unexplained) rec = 'NO-GO';
  else if (S.quarantine > 0 || S.corruptedName > 0 || S.ambiguousForm > 0
    || S.duplicateRisk > 0 || S.insufficient > 0) {
    rec = 'GO WITH QUARANTINE';
  } else rec = 'GO';

  console.log(`   ${rec}\n`);
  if (rec === 'NO-GO' && wouldDuplicate) {
    console.log(`   ${S.sharedCasDescriptorVariant} shared-CAS value(s) are still DESCRIPTOR_VARIANT, meaning the`);
    console.log('   normalization rules would create more than one molecule for one substance.');
    console.log('   Duplicates are undone by MERGING, which is the direction that produced a false');
    console.log('   scarcity claim on 9 Oct. Fix the rule, re-run, then decide.');
  } else if (rec === 'NO-GO') {
    console.log('   nothing is safely creatable — do not migrate.');
  } else if (rec === 'NO-GO' && unexplained) {
    console.log(`   ${a.exclusionIntegrity.missingReason.length} identity/identities would be excluded with NO recorded reason`);
    console.log(`   and ${a.exclusionIntegrity.createdAndExcluded.length} would be both created and excluded. An identity that`);
    console.log('   disappears without a reason is the silent-skip failure this phase removes.');
  } else if (rec === 'GO WITH QUARANTINE') {
    console.log(`   ${S.safeToCreate} substances are sufficiently evidenced to create, with no remaining`);
    console.log('   descriptor gap — so the run will not silently duplicate a substance.');
    console.log('\n   EXCLUDED, each deterministically and each with a machine-readable reason:');
    console.log(`     ${S.quarantine} identity conflict(s)      cas_disagreement:<values>`);
    console.log(`     ${S.corruptedName} corrupted name(s)        corrupted_name:<why>`);
    console.log(`     ${S.ambiguousForm} ambiguous form(s)        ambiguous_form:<phrase>`);
    console.log(`     ${S.duplicateRisk} evidenced duplicate(s)   duplicate_risk:same_neutral_substance_as:<parent>`);
    console.log(`     ${S.insufficient} unnameable group(s)      insufficient_identity:*`);
    console.log(`   ${a.exclusionIntegrity.withReason} of ${a.exclusionIntegrity.excluded} exclusions carry a reason, and none is also in CREATE.`);
    console.log('\n   STILL OPEN, and NOT blocking creation:');
    console.log(`     ${S.sharedCasDistinctNames} cross-identity CAS finding(s) — the NAMES are sound and are created;`);
    console.log(`       their canonical CAS is WITHHELD (${S.casContested} identities), so nothing false is stored.`);
    console.log(`     ${S.truncatedNames} truncated name(s) recorded for upstream repair`);
    console.log(`     ${S.invalidCasOccurrences} invalid CAS occurrence(s), refused as identifiers`);
    // ── THIS PARAGRAPH USED TO SAY THE OPPOSITE ────
    // Before Decision 1 was implemented it warned that a contested identity is created WITH the
    // disputed CAS, and it was left standing after the behaviour changed — so section 12
    // contradicted sections 5c and 5d in the same report, and a reader could not tell which was
    // current. A stale warning is worse than no warning: it spends the attention that a real one
    // needs. Updated to describe what the code now does, and the invariant above proves it rather
    // than this text asserting it.
    console.log('\n   CONTESTED CAS — resolved, not residual:');
    console.log(`   The ${S.sharedCasDistinctNames} unresolved shared-CAS findings produce ${S.casContested} identities whose`);
    console.log('   canonical cas is NULL. For `selumetinib | binimetinib`, NEITHER molecule carries');
    console.log('   606143-89-9: the name proceeds, the disputed attribute does not, no owner is');
    console.log('   chosen and the source values are preserved in cas_source_values with the');
    console.log('   contest recorded in molecule_conflicts. Proven two ways — the invariant above');
    console.log('   computes it from this run, and check-molecule-identity-db.js proves the');
    console.log('   backfill behaviour against a real Postgres with the pair seeded in DIFFERENT');
    console.log('   tables, because a per-table check would never have seen the contest at all.');
  } else {
    console.log('   no blocking condition and no normalization gap found.');
  }
  // ── THE EXIT CODE IS THE VERDICT ────────────────────────────────────────
  //
  // The previous run printed this entire report and then died on a reference I had left behind
  // after deleting its variable — `canExcludeDeterministically is not defined`, exit 1. A reader
  // who scrolled to the recommendation saw GO WITH QUARANTINE; a reader who checked `$?` saw a
  // failure. CLAUDE.md's first rule is that a checker's verdict is its exit status, so a report
  // that is complete and an exit code that says otherwise is the worst of both.
  //
  // Returned rather than printed-and-forgotten, so the caller's exit code reflects the gate.
  return rec;
  console.log('\n   This preview ran E1 NOWHERE. No table was created, no row written, no conflict');
  console.log('   resolved. The migration is a separate command and is not authorised by this');
  console.log('   output alone.\n');
}

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }

if (require.main === module) {
  main().then((rec) => {
    // Exit 0 means THE PREVIEW RAN, whatever it recommends: a NO-GO is a finding, not a crash,
    // and conflating the two is how a verdict gets misread. The recommendation is in the report
    // and is echoed on the last line so a terminal scrollback shows it without hunting.
    console.log(`── verdict: ${rec || 'UNKNOWN'} (the preview ran; nothing was written)\n`);
    process.exit(0);
  }).catch((e) => {
    console.error(`\n✗ preview could not run: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
