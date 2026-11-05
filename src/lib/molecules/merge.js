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

// TWO IDENTITY LAYERS, DELIBERATELY, FOR TWO DIFFERENT JOBS.
//
//   canonicalMolecule  — the SEARCH rule. De-salts and folds synonyms, so a search for the base
//                        finds the salt and vice versa. That is what makes the page useful, and it
//                        is kept: this file is on the search-scope allowlist for exactly this.
//
//   moleculeKey/identityOf — the IDENTITY layer. Keeps the form, so `leuprolide` and
//                        `leuprolide acetate` are two substances with their own registry numbers.
//
// The grouping is done with the first and every COMMERCIAL number with the second. Until this
// change the whole row used the first, which meant a row labelled `Leuprolide Acetate` could carry
// the base's price, the base's CAS and a holder count summed across both — three claims about a
// substance nobody had counted.
const { canonicalMolecule, normalize } = require('./synonyms');
const { moleculeKey, identityOf } = require('./identity');

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
    const label = preferredLabel(names);

    // ── THE EXACT SUBSTANCE, SEPARATED FROM WHAT MERELY RELATES TO IT ──────
    //
    // The row is LABELLED with the highest-information name (the longest, which keeps the salt form
    // a buyer actually orders). So the exact substance is that label's identity — key plus form —
    // and every member that does not share it is a RELATED FORM: chemically adjacent, separately
    // registered, separately priced, not interchangeable.
    const labelIdentity = identityOf(label);
    const labelKey = moleculeKey(label);
    const isExact = (m) => moleculeKey(m.molecule) === labelKey
      && identityOf(m.molecule).form === labelIdentity.form;

    const exactMembers = members.filter(isExact);
    const relatedMembers = members.filter((m) => !isExact(m));
    const exactNames = exactMembers.map((m) => m.molecule).filter(Boolean);
    const relatedNames = relatedMembers.map((m) => m.molecule).filter(Boolean);

    const exactHolders = mergeHolders(exactMembers.map((m) => m.holders));
    const relatedHolders = mergeHolders(relatedMembers.map((m) => m.holders));
    // Holders of a related form who do not also hold the exact one. Counted this way because a
    // company holding both must not be double-counted as evidence of breadth.
    const exactHolderNames = new Set(exactHolders.map((h) => normalize(h.holder)));
    const relatedOnly = relatedHolders.filter((h) => !exactHolderNames.has(normalize(h.holder)));

    const mixed = relatedMembers.length > 0;

    out.push({
      molecule: label,
      canonical,
      // Every name this substance is filed under, when there is more than one. The page prints it so
      // a buyer can see the merge happened rather than wondering why one row covers two names.
      filed_as: names.length > 1 ? names.slice().sort() : null,

      // ── SUPPLY, WITH ITS BASIS STATED ───────────────────────────────────
      //
      // holder_count now counts holders of THE EXACT SUBSTANCE AND FORM. It was holders of anything
      // the search rule folded together, which is how `Leuprolide` (Bachem) and `Leuprolide Acetate`
      // (Sun, ScinoPharm) became one substance with three holders.
      //
      // Both directions of that error are a claim. Three holders of mixed forms printed as
      // "competitive, low leverage" overstates supply for whichever form the buyer wants. One holder
      // printed as "SOLE holder worldwide" overstates scarcity. So the row carries both numbers and,
      // when the forms are mixed, REFUSES to carry a leverage verdict — see supply_claim_allowed.
      holder_count: exactHolders.length,
      holder_count_basis: 'exact-substance-and-form',
      holders: exactHolders,
      on_floor: exactHolders.filter((h) => h.exhibiting && h.booth).length,

      // Discovery, kept and clearly labelled as a different question.
      related_form_holder_count: relatedOnly.length,
      related_form_holders: relatedOnly,
      related_forms: relatedNames.length ? [...new Set(relatedNames)].sort() : null,
      exact_form: labelIdentity.form,
      exact_filed_as: exactNames.length > 1 ? [...new Set(exactNames)].sort() : null,

      // THE CONTROL ON THE SENTENCE. A leverage or scarcity claim rests on a holder count for one
      // substance. When the group spans forms, this row's count is for the label's form only and
      // the related holders are a different substance's supply — so no single verdict is supportable
      // and the page must print the two counts instead of a conclusion.
      supply_claim_allowed: !mixed,
      supply_claim_basis: mixed
        ? `forms differ within this group — ${exactHolders.length} holder(s) of ${label} (${labelIdentity.form}), `
          + `${relatedOnly.length} of related form(s): ${[...new Set(relatedNames)].sort().join(', ')}. `
          + 'No single leverage verdict is supportable across distinct substances.'
        : `all ${members.length} filing(s) are the same substance and form`,

      // Demand is a question about the molecule rather than about one salt, so it still adds across
      // the group — with the basis stated, because a trial of the base is not a purchase order for
      // the acetate.
      studies: sum(members, 'studies'),
      ph3: sum(members, 'ph3'),
      ph2: sum(members, 'ph2'),
      patients: sum(members, 'patients'),
      demand_basis: mixed ? 'includes related forms' : 'exact substance and form',

      // ── COMMERCIAL FIELDS: EXACT MEMBERS ONLY ───────────────────────────
      //
      // This is the half that mattered more than the holder count. price_per_kg_usd was
      // minNum(members), i.e. the CHEAPEST price across every form in the group — and because the
      // row is labelled with the longest name, a row reading `Leuprolide Acetate` could carry the
      // base's price. A quotable number for a substance nobody priced.
      //
      // Same for cas_number (firstDefined across two substances with different registry numbers)
      // and gmp_certified (one form's certificate read as the other's). All now come from the exact
      // subgroup, and are null when the exact substance has no price row of its own — which is the
      // correct answer and the one the inquiry agent already gives: silence is the safe failure.
      gmp_grade: firstDefined(exactMembers, 'gmp_grade'),
      gmp_certified: anyTrue(exactMembers, 'gmp_certified'),
      cas_number: firstDefined(exactMembers, 'cas_number'),
      purity: firstDefined(exactMembers, 'purity'),
      price_per_kg_usd: minNum(exactMembers, 'price_per_kg_usd'),
      min_quantity_g: minNum(exactMembers, 'min_quantity_g'),
      lead_time_days: minNum(exactMembers, 'lead_time_days'),
      sample_available: anyTrue(exactMembers, 'sample_available'),
      sample_price_usd: minNum(exactMembers, 'sample_price_usd'),
      regulatory_status: firstDefined(exactMembers, 'regulatory_status'),

      // Controlled status stays ANY across the WHOLE group, on purpose and against the rule above.
      // A safety flag should err toward the restrictive answer: if any filing of any form of this
      // molecule says controlled, treating the row as uncontrolled is the error that ships a
      // scheduled substance. Over-restricting costs a conversation; under-restricting costs more.
      controlled_substance: anyTrue(members, 'controlled_substance'),
    });
  }
  return out;
}

module.exports = { mergeMoleculeRows, mergeHolders, preferredLabel };
