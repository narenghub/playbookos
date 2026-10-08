// ── COLLAPSE THE ALIAS ROWS INTO ONE SUBSTANCE, AND RECOUNT THE HOLDERS. ──────
//
// The molecule search groups on the filed name, so one substance comes back as several rows:
// `Leuprolide` (Bachem), `Leuprolide Acetate` (Sun, ScinoPharm), `Leuprorelin` (a trial, no holder).
// Three rows, one substance, and a holder_count of 1 on the first of them.
//
// That number drives the sentence the page prints — "SOLE holder worldwide", "Thin — 3 holders",
// "competitive, low leverage" — which is the sentence a buyer hears across a booth. Splitting a
// substance across alias rows understates supply, and understated supply is a price claim. So the
// rows are merged on the canonical substance and holder_count is RECOMPUTED from the merged set
// rather than carried over from any one row.
//
// This is done in JS rather than SQL on purpose: canonicalisation needs the synonym table, which
// Postgres cannot see, and the query already returns at most 25 rows. Pushing it into SQL would mean
// shipping the table into the database and keeping two copies in step.
'use strict';

const { canonicalMolecule, normalize } = require('./synonyms');

// Highest-information name wins as the row's label: the longest filed name, which keeps the salt
// form a buyer actually orders ("Leuprolide Acetate" over "Leuprolide"). Ties break alphabetically
// so the output is deterministic.
function preferredLabel(names) {
  return names.slice().sort((a, b) => b.length - a.length || a.localeCompare(b))[0] || '';
}

// A holder is one company. The same company can arrive from two alias rows, once with a booth and
// once without; keep the one that knows where it is standing.
function mergeHolders(lists) {
  const byName = new Map();
  for (const h of [].concat(...lists.filter(Boolean))) {
    if (!h || !h.holder) continue;
    const key = normalize(h.holder);
    const prev = byName.get(key);
    if (!prev) { byName.set(key, h); continue; }
    const better = (h.exhibiting && h.booth) && !(prev.exhibiting && prev.booth);
    if (better) byName.set(key, h);
  }
  return Array.from(byName.values());
}

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const sum = (rows, k) => {
  const vals = rows.map((r) => num(r[k])).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
};
const firstDefined = (rows, k) => {
  for (const r of rows) if (r[k] != null && r[k] !== '') return r[k];
  return null;
};
const anyTrue = (rows, k) => rows.some((r) => r[k] === true || r[k] === 1);
const minNum = (rows, k) => {
  const vals = rows.map((r) => num(r[k])).filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
};

// rows → one row per substance. Input order is preserved for the first occurrence of each substance,
// so the query's ORDER BY still decides what the user reads first.
function mergeMoleculeRows(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const key = canonicalMolecule(r.molecule) || normalize(r.molecule);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const [canonical, members] of groups) {
    const names = members.map((m) => m.molecule).filter(Boolean);
    const holders = mergeHolders(members.map((m) => m.holders));

    out.push({
      molecule: preferredLabel(names),
      canonical,
      // Every name this substance is filed under, when there is more than one. The page prints it so
      // a buyer can see the merge happened rather than wondering why one row covers two names.
      filed_as: names.length > 1 ? names.slice().sort() : null,

      // RECOUNTED, not carried. This is the whole point of the file.
      holder_count: holders.length,
      holders,
      on_floor: holders.filter((h) => h.exhibiting && h.booth).length,

      // Demand adds up across aliases: a trial filed under the INN and one under the USAN are two
      // trials of the same substance.
      studies: sum(members, 'studies'),
      ph3: sum(members, 'ph3'),
      ph2: sum(members, 'ph2'),
      patients: sum(members, 'patients'),

      // Price-list fields come from whichever alias has a price row. gmp_certified is ANY, because
      // one certified supplier makes the substance available at GMP; the per-holder detail is in the
      // holder list. min_quantity and lead_time take the best offer on file.
      gmp_grade: firstDefined(members, 'gmp_grade'),
      gmp_certified: anyTrue(members, 'gmp_certified'),
      cas_number: firstDefined(members, 'cas_number'),
      purity: firstDefined(members, 'purity'),
      price_per_kg_usd: minNum(members, 'price_per_kg_usd'),
      min_quantity_g: minNum(members, 'min_quantity_g'),
      lead_time_days: minNum(members, 'lead_time_days'),
      sample_available: anyTrue(members, 'sample_available'),
      sample_price_usd: minNum(members, 'sample_price_usd'),
      regulatory_status: firstDefined(members, 'regulatory_status'),
      // Controlled status is ANY and never averaged: if any filing says controlled, it is controlled.
      controlled_substance: anyTrue(members, 'controlled_substance'),
    });
  }
  return out;
}

module.exports = { mergeMoleculeRows, mergeHolders, preferredLabel };
