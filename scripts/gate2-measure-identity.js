#!/usr/bin/env node
// ── WHAT CANONICAL IDENTITY WOULD CHANGE, MEASURED BEFORE ANYTHING CHANGES ───
//
//   railway ssh 'node scripts/gate2-measure-identity.js'
//
// READS ONLY. No INSERT, no UPDATE, no DELETE, no DDL, and no writer send path invoked.
// Run it against production.
//
// ── THIS IS A MEASUREMENT, NOT A CHECK ──────────────────────────────────────
//
// EXIT 0 MEANS "I MEASURED", NOT "ALL CLEAR". Every other script under scripts/ that prints a
// verdict exits non-zero when something is wrong; this one exits non-zero only when it could not
// take the measurement at all. Read the NUMBERS. A zero exit code here is not evidence of anything.
//
// ── WHAT IT MEASURES, AND WHY EACH PART EXISTS ──────────────────────────────
//
//   1. canonical census                   what identity is available to resolve against
//   2. the three transaction tables       how much commercial history can be identified at all
//   3. molecule_pricing and skus          the two tables that decide price and availability
//   4. canonical collisions               two priced rows that turn out to be ONE substance
//   5. COMMERCIAL BEHAVIOUR CHANGE        what a real buyer would be told, before vs after
//   6. rfq uniqueness collisions          whether the stricter unique key can be applied at all
//   7. supplier canonical coverage        whether capability matching has anything to stand on
//   8. pricing provenance feasibility     whether molecule_pricing can carry a stable reference
//
// Section 5 is the one that cannot be inferred from the others. Canonicalisation can be chemically
// safer and still change what a buyer is charged or told is in stock, in BOTH directions: it
// removes false refusals where a name differs only in form, and it creates NEW refusals where two
// catalogue rows turn out to be one substance. A design approved without those two numbers is a
// design whose commercial effect is discovered by customers.
//
// ── THE RESOLUTION RULE, AND THE ONE THING IT WILL NOT DO ───────────────────
//
// Resolution is by normalised name only — moleculeKey(), the same function E1 uses, then the alias
// table. `cas_number` IS NEVER A KEY. It is used in one direction only: to VETO a name match whose
// CAS contradicts the molecule's canonical CAS.
//
// That asymmetry is the direct lesson of the 31 Oct pricing defect. `molecule_pricing` has a unique
// index on the name and NO constraint on cas_number, and matching on a shared CAS priced a
// correctly-named molecule at another substance's rate, 2.4x out, decided by physical row order. A
// registry number identifies a substance until two rows disagree about it, and 212 identities in
// this database are already contested. A CAS can therefore refute a match; it must never make one.
//
// ── ONE RESOLVER, USED EVERYWHERE ───────────────────────────────────────────
//
// classify() below is the single authority for "what does this string resolve to", and the backfill
// will call this same function rather than re-deriving it. E1 created 38 molecules nobody authorised
// because the analyser and the backfill each had their own idea of the same question.
'use strict';

const fs = require('fs');
const { query } = require('../src/lib/db');
const { moleculeKey } = require('../src/lib/molecules/identity');

// stdout through fs.writeSync, not console.log. A checker printed nothing and exited 1 on 31 Oct
// because console.log to a pipe is an async write and process.exit discards what has not drained.
const out = (s) => fs.writeSync(1, s + '\n');
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

// The three tables Gate 2 covers, and the columns identity would be derived from.
const TX_TABLES = [
  { table: 'inquiries', name: 'molecule_name', cas: 'cas_number' },
  { table: 'inquiry_quotes', name: 'molecule_name', cas: 'cas_number' },
  { table: 'rfq_requests', name: 'molecule_name', cas: 'cas_number' },
];

// The two lookup tables. Note skus names its molecule column `name`, and carries cas_number from an
// ALTER rather than its original CREATE (db.js:309).
const LOOKUP_TABLES = [
  { table: 'molecule_pricing', name: 'molecule_name', cas: 'cas_number', activeCol: 'active' },
  { table: 'skus', name: 'name', cas: 'cas_number', activeCol: 'is_active' },
];

// Outcome vocabulary. Deliberately distinguishes the three kinds of "no id" that a single NULL
// would collapse — which is the defect shape this whole gate exists to remove.
const OUTCOMES = [
  'resolved',               // exactly one eligible canonical identity
  'resolved_deprecated',    // resolves, but the identity is deprecated (policy rule 6: history keeps it)
  'cas_contradiction',      // name resolves; the row's CAS disagrees with the molecule's canonical CAS
  'unresolved_no_match',    // normalises cleanly, nothing canonical answers to it
  'unresolved_unusable',    // the string does not yield an identity at all (empty, prose, fragment)
  'no_molecule_named',      // the row names no molecule — not a failure, just not a molecule row
];

// How a real buyer's answer would change when canonical lookup replaces string matching.
const TRANSITIONS = [
  'unchanged_answer',        // same row, or nothing either way
  'lookup_error',            // the SHIPPED lookup threw. NOT an answer, and never a gain.
  'refusal_removed',         // today: nothing. canonical: one answer. A false refusal disappears.
  'now_ambiguous',           // today: an answer. canonical: 2+ rows are one substance → must refuse.
  'now_refused_unresolved',  // today: an answer. canonical: E1 has no eligible identity for the name.
  'now_refused_deprecated',  // today: an answer. canonical: the identity is deprecated.
  'different_row',           // both answer, from DIFFERENT rows → the number itself changes.
];

function digits(cas) {
  return String(cas || '').replace(/[^0-9-]/g, '').trim();
}

async function loadCanonical() {
  // One pass over the canonical tables, held in memory. 2447 molecules and 44 aliases is small, and
  // a per-row query against a production database over a connection that failed three ways on
  // 31 Oct is how a measurement loses two thirds of its result and reports the rest as the answer.
  const byIdentity = new Map();
  const byId = new Map();
  for (const m of (await query(
    `SELECT id, molecule_ref, normalized_name, preferred_name, cas, deprecated_at
       FROM molecules`)).rows) {
    byIdentity.set(m.normalized_name, m);
    byId.set(String(m.id), m);
  }
  for (const a of (await query(
    `SELECT a.alias, a.molecule_id FROM molecule_aliases a`)).rows) {
    if (byIdentity.has(a.alias)) continue;      // an identity of its own wins over an alias
    const m = byId.get(String(a.molecule_id));
    if (m) byIdentity.set(a.alias, m);
  }
  return byIdentity;
}

function classify(row, canonical, cols) {
  const filed = row[cols.name];
  if (filed === null || filed === undefined || String(filed).trim() === '') {
    return { outcome: 'no_molecule_named', molecule: null };
  }
  const identity = moleculeKey(filed);
  if (!identity) return { outcome: 'unresolved_unusable', molecule: null };

  const m = canonical.get(identity);
  if (!m) return { outcome: 'unresolved_no_match', molecule: null, identity };

  // CAS as a veto, never as a key. Only a disagreement between two PRESENT values counts: a row
  // with no CAS contradicts nothing, and a molecule with a withheld canonical CAS (Decision 1 is
  // already suppressing it) is not evidence against the name.
  const rowCas = digits(row[cols.cas]);
  const molCas = digits(m.cas);
  if (rowCas && molCas && rowCas !== molCas) {
    return { outcome: 'cas_contradiction', molecule: m, identity, rowCas, molCas };
  }
  return {
    outcome: m.deprecated_at ? 'resolved_deprecated' : 'resolved',
    molecule: m,
    identity,
  };
}

// ── SECTIONS 2 AND 3: classify one table ────────────────────────────────────
async function measureTable(cols, canonical, { samples = 8 } = {}) {
  const extra = cols.activeCol ? `, ${cols.activeCol}` : '';
  const priceCol = cols.table === 'molecule_pricing' ? ', price_per_kg_usd' : '';
  const stockCol = cols.table === 'skus' ? ', units_in_stock' : '';
  let rows;
  try {
    rows = (await query(
      `SELECT id, ${cols.name}, ${cols.cas}${extra}${priceCol}${stockCol} FROM ${cols.table}`)).rows;
  } catch (e) {
    return { error: e.message, table: cols.table, cols };
  }
  const counts = {};
  const examples = {};
  for (const o of OUTCOMES) { counts[o] = 0; examples[o] = []; }
  const resolvedRows = [];

  for (const r of rows) {
    const c = classify(r, canonical, cols);
    counts[c.outcome] += 1;
    if (examples[c.outcome].length < samples) {
      examples[c.outcome].push(
        c.outcome === 'cas_contradiction'
          ? `${JSON.stringify(r[cols.name])}  row CAS ${c.rowCas} vs ${c.molecule.molecule_ref} CAS ${c.molCas}`
          : JSON.stringify(r[cols.name])
      );
    }
    if (c.molecule) {
      resolvedRows.push({
        row: r,
        molecule: c.molecule,
        outcome: c.outcome,
        active: cols.activeCol ? Number(r[cols.activeCol]) === 1 : null,
      });
    }
  }
  return { table: cols.table, total: rows.length, counts, examples, resolvedRows, cols };
}

function printTable(m) {
  out('');
  if (m.error) { out(`── ${m.table}: COULD NOT READ — ${m.error}`); return; }
  out(`── ${m.table}  (${m.total} rows)`);
  for (const o of OUTCOMES) {
    const n = m.counts[o];
    const pct = m.total ? ` ${((n / m.total) * 100).toFixed(1)}%` : '';
    out(`   ${pad(o, 22)} ${num(n, 6)}${pct}`);
  }
  for (const o of ['cas_contradiction', 'unresolved_no_match', 'unresolved_unusable', 'resolved_deprecated']) {
    if (!m.examples[o] || !m.examples[o].length) continue;
    out(`   examples — ${o}:`);
    for (const s of m.examples[o]) out(`     ${s}`);
  }
}

// ── SECTION 4: two rows that are one substance ──────────────────────────────
//
// `molecule_pricing` is unique on LOWER(molecule_name), so "Gemcitabine" and "Gemcitabine USP" are
// two legitimate rows with two legitimate prices. If both normalise to the SAME canonical molecule,
// canonical lookup has two prices for one substance and cannot choose — and the honest answer is to
// refuse. This number is therefore how much priced catalogue becomes unquotable, and it is the most
// consequential figure in the measurement.
function collisions(m) {
  if (m.error) return { groups: [], rows: 0 };
  const byMolecule = new Map();
  for (const r of m.resolvedRows) {
    if (r.active === false) continue;                   // inactive rows cannot be chosen anyway
    const k = String(r.molecule.id);
    if (!byMolecule.has(k)) byMolecule.set(k, []);
    byMolecule.get(k).push(r);
  }
  const groups = [...byMolecule.entries()]
    .filter(([, rs]) => rs.length > 1)
    .map(([id, rs]) => ({ id, molecule: rs[0].molecule, rows: rs }));
  return { groups, rows: groups.reduce((a, g) => a + g.rows.length, 0) };
}

// ── SECTION 5: what a real buyer would be told, before vs after ─────────────
//
// "Today" is measured by calling the SHIPPED findPricing and findStock, not by reimplementing them.
// A simulation of current behaviour written here would be a second implementation of the thing
// under test, and the two would disagree exactly where it matters.
//
// The population is the distinct molecule_name values in `inquiries` — what buyers have actually
// asked for. Measuring behaviour change across the catalogue instead would weight the answer by
// what Abiozen happens to stock rather than by what anyone wants.
function canonicalAnswer(askedName, canonical, lookup) {
  const c = classify({ [lookup.cols.name]: askedName, [lookup.cols.cas]: null },
    canonical, lookup.cols);
  if (c.outcome === 'no_molecule_named' || c.outcome === 'unresolved_unusable'
      || c.outcome === 'unresolved_no_match') {
    return { status: 'refused_unresolved', why: c.outcome };
  }
  if (c.outcome === 'cas_contradiction') return { status: 'refused_contradiction' };
  if (c.outcome === 'resolved_deprecated') return { status: 'refused_deprecated', molecule: c.molecule };

  const candidates = lookup.resolvedRows.filter(
    (r) => String(r.molecule.id) === String(c.molecule.id)
      && r.active !== false
      // a deprecated identity may never supply a NEW commercial answer (Amendment 2)
      && !r.molecule.deprecated_at
  );
  if (!candidates.length) return { status: 'none', molecule: c.molecule };
  if (candidates.length > 1) return { status: 'ambiguous', molecule: c.molecule, candidates };
  return { status: 'answer', molecule: c.molecule, row: candidates[0].row };
}

// `todayKey` identifies the row today's lookup chose: molecule_pricing has an id, findStock returns
// only a name, so the caller supplies whichever is available.
function transitionOf(todayKey, canon, canonKey) {
  const has = todayKey !== null && todayKey !== undefined;
  switch (canon.status) {
    case 'answer':
      if (!has) return 'refusal_removed';
      return String(todayKey) === String(canonKey) ? 'unchanged_answer' : 'different_row';
    case 'ambiguous':
      return has ? 'now_ambiguous' : 'unchanged_answer';
    case 'refused_deprecated':
      return has ? 'now_refused_deprecated' : 'unchanged_answer';
    case 'refused_unresolved':
    case 'refused_contradiction':
    case 'none':
    default:
      return has ? 'now_refused_unresolved' : 'unchanged_answer';
  }
}

async function measureBehaviour(canonical, pricingM, skusM) {
  // Required lazily. inquiry-agent is the shipped writer module; loading it is only safe because
  // nothing here invokes a send path — findPricing and findStock are both pure reads.
  const agent = require('../src/lib/agents/inquiry-agent');

  let asked;
  try {
    asked = (await query(
      `SELECT DISTINCT molecule_name FROM inquiries
        WHERE molecule_name IS NOT NULL AND TRIM(molecule_name) <> ''
        ORDER BY molecule_name`)).rows.map((r) => r.molecule_name);
  } catch (e) {
    return { error: e.message };
  }

  const price = {}; const stock = {};
  const priceEx = {}; const stockEx = {};
  for (const t of TRANSITIONS) { price[t] = 0; stock[t] = 0; priceEx[t] = []; stockEx[t] = []; }

  for (const name of asked) {
    // ── pricing: shipped vs canonical ──
    let today = null; let todayErr = null;
    try { today = await agent.findPricing(name, null); } catch (e) { todayErr = e.message; }
    const canon = pricingM.error ? { status: 'none' } : canonicalAnswer(name, canonical, pricingM);
    const canonKey = canon.status === 'answer' ? canon.row.id : null;
    // A thrown lookup is NOT "no price today". Swallowing it would read as a false refusal that
    // canonicalisation removes -- a gain manufactured out of a broken query.
    const pt = todayErr ? 'lookup_error' : transitionOf(today ? today.id : null, canon, canonKey);
    price[pt] += 1;
    if (priceEx[pt].length < 10) {
      priceEx[pt].push(`${JSON.stringify(name)}  ${todayErr ? `TODAY THREW: ${todayErr}  ` : ''}today=${today
        ? `$${Math.round(Number(today.price_per_kg_usd) || 0)}/kg via ${JSON.stringify(today.molecule_name)}`
        : 'no price'}  canonical=${canon.status}${canon.candidates
        ? ` (${canon.candidates.length}: ${canon.candidates
          .map((c) => JSON.stringify(c.row[pricingM.cols.name])).join(', ')})` : ''}`);
    }

    // ── availability: shipped vs canonical ──
    let todayS = null; let todaySErr = null;
    try { todayS = await agent.findStock(name); } catch (e) { todaySErr = e.message; }
    const canonS = skusM.error ? { status: 'none' } : canonicalAnswer(name, canonical, skusM);
    // findStock returns no id, so "the same row" is identified by its name.
    const canonSKey = canonS.status === 'answer' ? canonS.row[skusM.cols.name] : null;
    const st = todaySErr ? 'lookup_error'
      : transitionOf(todayS ? todayS.name : null, canonS, canonSKey);
    stock[st] += 1;
    if (stockEx[st].length < 10) {
      stockEx[st].push(`${JSON.stringify(name)}  ${todaySErr ? `TODAY THREW: ${todaySErr}  ` : ''}today=${todayS
        ? `${todayS.units_in_stock} units via ${JSON.stringify(todayS.name)}`
        : 'no stock claim'}  canonical=${canonS.status}${canonSKey
        ? ` via ${JSON.stringify(canonSKey)}` : ''}`);
    }
  }
  return { askedCount: asked.length, price, stock, priceEx, stockEx };
}

// ── SECTION 6: can the stricter RFQ unique key be applied at all? ───────────
async function measureRfqCollisions() {
  try {
    const rows = (await query(
      `SELECT week_start, LOWER(molecule_name) k, COUNT(*)::int n,
              STRING_AGG(DISTINCT molecule_name, ' | ') names
         FROM rfq_requests GROUP BY 1,2 HAVING COUNT(*) > 1 ORDER BY 3 DESC`)).rows;
    return { collisions: rows };
  } catch (e) { return { error: e.message }; }
}

// ── SECTION 7: is there anything for canonical supplier matching to use? ────
async function measureSupplierCoverage() {
  try {
    const t = (await query(
      `SELECT COUNT(*)::int total,
              COUNT(molecule_id)::int linked,
              COUNT(DISTINCT molecule_id)::int molecules,
              COUNT(DISTINCT contact_id)::int suppliers_any,
              COUNT(DISTINCT CASE WHEN molecule_id IS NOT NULL THEN contact_id END)::int suppliers_linked
         FROM supplier_products`)).rows[0];
    const multi = (await query(
      `SELECT COUNT(*)::int n FROM (
         SELECT molecule_id FROM supplier_products WHERE molecule_id IS NOT NULL
          GROUP BY molecule_id HAVING COUNT(DISTINCT contact_id) > 1) x`)).rows[0].n;
    return { ...t, molecules_with_multiple_suppliers: multi };
  } catch (e) { return { error: e.message }; }
}

// ── SECTION 8: can molecule_pricing carry a stable provenance reference? ────
async function measurePricingProvenance() {
  try {
    const pk = (await query(
      `SELECT a.attname col, format_type(a.atttypid, a.atttypmod) typ
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'molecule_pricing'::regclass AND i.indisprimary`)).rows;
    const counts = (await query(
      `SELECT COUNT(*)::int total, COUNT(id)::int with_id,
              COUNT(DISTINCT id)::int distinct_id,
              COUNT(*) FILTER (WHERE active = 1)::int active
         FROM molecule_pricing`)).rows[0];
    return { primaryKey: pk, ...counts };
  } catch (e) { return { error: e.message }; }
}

async function main() {
  const canonical = await loadCanonical();
  const activeCount = (await query(
    `SELECT COUNT(*)::int n FROM molecules WHERE deprecated_at IS NULL`)).rows[0].n;
  const deprecatedCount = (await query(
    `SELECT COUNT(*)::int n FROM molecules WHERE deprecated_at IS NOT NULL`)).rows[0].n;
  const aliasCount = (await query(`SELECT COUNT(*)::int n FROM molecule_aliases`)).rows[0].n;

  out('');
  out('════ GATE 2 IDENTITY MEASUREMENT ══════════════════════════════════════');
  out('A zero exit code means the measurement RAN. It is not a verdict. Read the numbers.');
  out('');
  out('── 1. CANONICAL CENSUS');
  out(`   molecules active                                 ${num(activeCount, 6)}`);
  out(`   molecules deprecated                             ${num(deprecatedCount, 6)}`);
  out(`   curated aliases                                  ${num(aliasCount, 6)}`);
  out(`   distinct strings resolvable (identities+aliases) ${num(canonical.size, 6)}`);

  // ── 2. the three transaction tables ──
  out('');
  out('── 2. TRANSACTION TABLES');
  const txTotals = {};
  for (const o of OUTCOMES) txTotals[o] = 0;
  let txGrand = 0;
  for (const cols of TX_TABLES) {
    const m = await measureTable(cols, canonical);
    printTable(m);
    if (!m.error) {
      for (const o of OUTCOMES) txTotals[o] += m.counts[o];
      txGrand += m.total;
    }
  }
  out('');
  out('   ALL THREE TRANSACTION TABLES');
  for (const o of OUTCOMES) out(`   ${pad(o, 22)} ${num(txTotals[o], 6)}`);
  out(`   ${pad('TOTAL ROWS', 22)} ${num(txGrand, 6)}`);

  // ── 3. the two lookup tables ──
  out('');
  out('── 3. LOOKUP TABLES (these decide price and availability)');
  const lookups = {};
  for (const cols of LOOKUP_TABLES) {
    const m = await measureTable(cols, canonical);
    printTable(m);
    lookups[cols.table] = m;
  }

  // ── 4. canonical collisions ──
  out('');
  out('── 4. CANONICAL COLLISIONS — rows that are ONE substance');
  out('   Two active priced rows resolving to one molecule cannot both be the canonical price. The');
  out('   honest answer is refusal, so this is how much priced catalogue becomes unquotable.');
  const colTotals = {};
  for (const cols of LOOKUP_TABLES) {
    const m = lookups[cols.table];
    if (m.error) { out(`   ${cols.table}: COULD NOT READ`); continue; }
    const c = collisions(m);
    colTotals[cols.table] = c;
    out('');
    out(`   ${cols.table}: ${c.groups.length} colliding molecule(s), ${c.rows} row(s) involved`);
    for (const g of c.groups.slice(0, 15)) {
      out(`     ${g.molecule.molecule_ref} ${JSON.stringify(g.molecule.preferred_name)} ←`);
      for (const r of g.rows) {
        const n = JSON.stringify(r.row[m.cols.name]);
        const extra = cols.table === 'molecule_pricing'
          ? `  $${Math.round(Number(r.row.price_per_kg_usd) || 0)}/kg`
          : `  ${r.row.units_in_stock} units`;
        out(`       ${n}${extra}`);
      }
    }
    if (c.groups.length > 15) out(`     … ${c.groups.length - 15} more`);
  }

  // ── 5. commercial behaviour change ──
  out('');
  out('── 5. COMMERCIAL BEHAVIOUR CHANGE — what a real buyer would be told');
  out('   "Today" calls the SHIPPED findPricing and findStock. Population: the distinct molecule');
  out('   names buyers have actually asked for in `inquiries`.');
  const beh = await measureBehaviour(canonical, lookups.molecule_pricing, lookups.skus);
  if (beh.error) {
    out(`   COULD NOT MEASURE — ${beh.error}`);
  } else {
    out('');
    out(`   distinct asked-for molecule names measured       ${num(beh.askedCount, 6)}`);
    out('');
    out('   PRICING                                          names');
    for (const t of TRANSITIONS) out(`   ${pad(t, 24)} ${num(beh.price[t], 6)}`);
    out('');
    out('   AVAILABILITY                                     names');
    for (const t of TRANSITIONS) out(`   ${pad(t, 24)} ${num(beh.stock[t], 6)}`);
    for (const t of TRANSITIONS) {
      if (t === 'unchanged_answer' || !beh.priceEx[t].length) continue;
      out('');
      out(`   pricing — ${t}:`);
      for (const s of beh.priceEx[t]) out(`     ${s}`);
    }
    for (const t of TRANSITIONS) {
      if (t === 'unchanged_answer' || !beh.stockEx[t].length) continue;
      out('');
      out(`   availability — ${t}:`);
      for (const s of beh.stockEx[t]) out(`     ${s}`);
    }
  }

  // ── 6. rfq uniqueness collisions ──
  out('');
  out('── 6. RFQ UNIQUENESS COLLISIONS');
  out('   Non-zero means the stricter unique key CANNOT be applied until these are ruled on.');
  const rfq = await measureRfqCollisions();
  if (rfq.error) out(`   COULD NOT READ — ${rfq.error}`);
  else if (!rfq.collisions.length) out('   none — the stricter key can be applied');
  else {
    out(`   ${rfq.collisions.length} colliding (week_start, lower(molecule_name)) group(s):`);
    for (const c of rfq.collisions.slice(0, 20)) {
      out(`     ${c.week_start}  ${JSON.stringify(c.k)}  ×${c.n}   ${c.names}`);
    }
  }

  // ── 7. supplier canonical coverage ──
  out('');
  out('── 7. SUPPLIER CANONICAL COVERAGE');
  const sup = await measureSupplierCoverage();
  if (sup.error) out(`   COULD NOT READ — ${sup.error}`);
  else {
    const frac = sup.total ? `${((sup.linked / sup.total) * 100).toFixed(1)}%` : 'n/a';
    out(`   supplier_products rows total                     ${num(sup.total, 6)}`);
    out(`   rows carrying molecule_id                        ${num(sup.linked, 6)}  ${frac}`);
    out(`   distinct canonical molecules covered             ${num(sup.molecules, 6)}`);
    out(`   distinct suppliers (any row)                     ${num(sup.suppliers_any, 6)}`);
    out(`   distinct suppliers with a canonical link         ${num(sup.suppliers_linked, 6)}`);
    out(`   molecules with >1 supplier (a real comparison)   ${num(sup.molecules_with_multiple_suppliers, 6)}`);
  }

  // ── 8. pricing provenance feasibility ──
  out('');
  out('── 8. PRICING PROVENANCE FEASIBILITY (pricing_id)');
  const prov = await measurePricingProvenance();
  if (prov.error) out(`   COULD NOT READ — ${prov.error}`);
  else {
    out(`   primary key: ${prov.primaryKey.map((p) => `${p.col} ${p.typ}`).join(', ') || 'NONE'}`);
    out(`   rows total                                       ${num(prov.total, 6)}`);
    out(`   rows with a non-null id                          ${num(prov.with_id, 6)}`);
    out(`   distinct ids                                     ${num(prov.distinct_id, 6)}`);
    out(`   active rows                                      ${num(prov.active, 6)}`);
  }

  // One line that survives being copy-pasted out of a terminal whose connection dropped.
  const resolvable = txTotals.resolved + txTotals.resolved_deprecated;
  const noId = txTotals.unresolved_no_match + txTotals.unresolved_unusable;
  const pc = colTotals.molecule_pricing ? colTotals.molecule_pricing.groups.length : -1;
  const sc = colTotals.skus ? colTotals.skus.groups.length : -1;
  out('');
  out('════ DIGEST ═══════════════════════════════════════════════════════════');
  out(`tx_resolvable=${resolvable} tx_ruling=${txTotals.cas_contradiction} tx_unidentified=${noId} `
    + `tx_none=${txTotals.no_molecule_named} tx_total=${txGrand}`);
  out(`collisions_pricing=${pc} collisions_skus=${sc} `
    + `rfq_collisions=${rfq.collisions ? rfq.collisions.length : -1}`);
  if (!beh.error) {
    out(`price_gain=${beh.price.refusal_removed} price_new_refusal=`
      + `${beh.price.now_ambiguous + beh.price.now_refused_unresolved + beh.price.now_refused_deprecated} `
      + `price_changed=${beh.price.different_row} `
      + `stock_gain=${beh.stock.refusal_removed} stock_new_refusal=`
      + `${beh.stock.now_ambiguous + beh.stock.now_refused_unresolved + beh.stock.now_refused_deprecated} `
      + `stock_changed=${beh.stock.different_row} asked=${beh.askedCount}`);
    if (beh.price.lookup_error || beh.stock.lookup_error) {
      out(`WARNING shipped_lookup_threw price=${beh.price.lookup_error} stock=${beh.stock.lookup_error}`
        + ' — those names have NO measured before-state and must not be read as refusals removed');
    }
  }
  out('');
  out('A CAS contradiction is NOT a row to resolve by majority or by preferring either value. The');
  out('row says one substance and the catalogue says another; picking one writes a guess into');
  out('commercial history. Those rows get a status and a review record, never an id.');
  return 0;
}

// Returns its verdict; never exits its caller. `main()` calling process.exit on 31 Oct killed the
// test harness that imported it.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => { fs.writeSync(2, `MEASUREMENT FAILED: ${e.message}\n${e.stack}\n`); process.exit(2); });
}

module.exports = {
  main, classify, loadCanonical, measureTable, collisions, canonicalAnswer, transitionOf,
  OUTCOMES, TRANSITIONS, TX_TABLES, LOOKUP_TABLES,
};
