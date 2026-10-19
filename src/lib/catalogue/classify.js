// ── WHAT HAPPENS TO EACH EXTRACTED PRODUCT ───────────────────────────────────
//
// Four outcomes, and the one people forget is the most commercially valuable.
//
//   list          — a new product worth putting on the marketplace
//   second_source — WE ALREADY SELL THIS. A second supplier for an existing SKU is not a
//                   duplicate to discard; it is the ability to quote competitively instead of
//                   accepting one supplier's price. Naresh's stated constraint on revenue is
//                   supply depth, and this is literally that.
//   hold          — needs a human decision before it can be listed
//   reject        — not a product, or not identifiable enough to list
//
// ── NOTHING HERE DECIDES ANYTHING ON ITS OWN ────────────────────────────────
//
// Every row lands in the review table as `pending` whatever this returns. The classification is a
// SORT ORDER for a human, not an approval. Extraction is lossy and a wrong CAS on a pharma
// listing is a different molecule, so the suggestion always carries its reason and the row always
// carries its source file and line.
'use strict';

// ── MOLECULES THAT STOP AND WAIT FOR A PERSON ───────────────────────────────
//
// These are NOT a legal determination and this file is not the place for one. They are the
// categories where listing without advice could be expensive, so the classifier refuses to put
// them in the "list" pile and says why.
//
// The GLP-1s are here because Zhejiang Peptides led their list with three of them and the patent
// and import position in the US is live and contested. Naresh has been advised to take trade-law
// advice before quoting any of them; until that happens they sit in hold.
const RESTRICTED = [
  [/\bsemaglutide\b/i, 'GLP-1 — patent and US import exposure. Legal advice taken first.'],
  [/\btirzepatide\b/i, 'GLP-1 — patent and US import exposure. Legal advice taken first.'],
  [/\bliraglutide\b/i, 'GLP-1 — patent and US import exposure. Legal advice taken first.'],
  [/\bdulaglutide\b|\bexenatide\b|\bretatrutide\b/i, 'GLP-1 family — same question as the three above.'],
  [/\bfentanyl\b|\bmorphine\b|\boxycodone\b|\bhydrocodone\b|\bcodeine\b|\bmethadone\b/i,
    'Controlled substance — DEA registration and import licensing.'],
  [/\bamphetamine\b|\bmethylphenidate\b|\bketamine\b/i,
    'Controlled substance — DEA registration and import licensing.'],
  [/\bpseudoephedrine\b|\bephedrine\b/i, 'Listed precursor — DEA reporting obligations.'],
  [/\bcannabidiol\b|\bCBD\b|\btetrahydrocannabinol\b|\bTHC\b/i,
    'Cannabinoid — state and federal position varies.'],
];

// A cosmetic-grade peptide is a different market with different regulation, and abiozen.com has
// not decided whether it carries cosmetics at all. Not a rejection — a decision nobody has made.
const COSMETIC = /\bcosmetic\b|\bskin\s*care\b|\banti[-\s]?aging\b|\bacetyl\s+hexapeptide\b|\bargireline\b|\bmatrixyl\b/i;

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ── RESEARCH USE, OR COMMERCIAL SUPPLY ───────────────────────────────────────
//
// The first live run ranked Orforglipron, Inclisiran, Nusinersen, Elacestrant, Abemaciclib,
// Acalabrutinib and Adagrasib at the top of the "list first" pile. Every one of those is under
// patent, and Orforglipron is not even approved — it is in Lilly's phase 3.
//
// That is not a bug in the ranking; it is what the ranking MEASURES. A molecule shows up in the
// clinical-trials data precisely because somebody is developing it, and active development
// usually means live patent protection. So evidenced demand and freedom to operate pull in
// opposite directions, and the demand signal points at the riskiest rows first.
//
// These brochures are generic-API PIPELINES: Chinese and Indian manufacturers develop molecules
// ahead of patent expiry and sell research quantities meanwhile. That is legitimate and it is
// close to Abiozen's own positioning — research-grade material for research use. What is not
// legitimate is listing them as commercially available APIs in a territory where the patent
// subsists.
//
// The heuristic, and its limits: a molecule named in active trials AND absent from the DMF
// register is treated as research-use-only. A DMF is filed when a manufacturer intends commercial
// supply, so its presence is real evidence the molecule is open; its absence is weaker evidence
// that it is not. This DOES NOT determine patent status, which is a legal question about a
// specific molecule in a specific territory on a specific date. It decides which listings carry
// the restriction and which need a freedom-to-operate check before anyone quotes.
const RUO_NOTICE = 'For research and development use. Not offered for commercial supply in territories where patent protection subsists — confirm freedom to operate before quoting.';

function useClass(row, ctx = {}) {
  const n = norm((row && row.name) || '');
  if (!n) return { use_class: 'unknown', listing_notice: RUO_NOTICE };

  // The named-restriction list always wins. A GLP-1 is restricted whatever else is true of it.
  for (const [re, why] of RESTRICTED) {
    if (re.test(String((row && row.name) || ''))) {
      return { use_class: 'rnd_only', listing_notice: RUO_NOTICE, patent_check: why };
    }
  }

  // ── THE ONLY POSITIVE EVIDENCE WE HAVE IS OUR OWN CATALOGUE ────
  //
  // This started as "on the DMF register → commercial", which is wrong, and the first bulk-review
  // dry run showed exactly how wrong: Orforglipron, Inclisiran, Nusinersen, Elacestrant, Olaparib,
  // Palbociclib, Ribociclib, Enzalutamide, Ivacaftor, Finerenone, Capivasertib, Encorafenib and
  // Apalutamide were all cleared as commercially supplyable and queued for approval. Every one is
  // under patent.
  //
  // The error was treating a DMF filing as patent clearance. It is not, for ANY molecule: generic
  // manufacturers file DMFs years before expiry — that is the whole business model of the
  // portfolios these rows came from. Patching the GLP-1s by name fixed four molecules and left the
  // inference that produced them untouched.
  //
  // Nothing in this platform can determine patent status. It is a legal question about one
  // molecule, one territory, one date. So the default is inverted: a row is restricted unless
  // there is POSITIVE evidence it is open, and the only positive evidence available is that
  // Abiozen already sells it — a decision a human already made, for that molecule, deliberately.
  //
  // Everything else carries the research-use notice until somebody checks. For a research-chemical
  // marketplace that is the normal posture, not a limitation, and Option B lists the molecules
  // either way — the notice decides how, not whether.
  if ((ctx.catalogueNames || new Set()).has(n)) {
    return { use_class: 'commercial', listing_notice: null };
  }

  const inTrials = (ctx.trialNames || new Set()).has(n);
  const inDmf = (ctx.dmfNames || new Set()).has(n);

  if (inTrials) {
    return {
      use_class: 'rnd_only',
      listing_notice: RUO_NOTICE,
      patent_check: inDmf
        ? 'in active clinical trials; a DMF exists but a DMF is a filing, not patent clearance — confirm freedom to operate'
        : 'named in active clinical trials, which usually means live patent protection',
    };
  }
  if (inDmf) {
    return {
      use_class: 'rnd_only',
      listing_notice: RUO_NOTICE,
      patent_check: 'on the DMF register, which is a filing rather than patent clearance — a generic maker may file years before expiry',
    };
  }
  return {
    use_class: 'rnd_only',
    listing_notice: RUO_NOTICE,
    patent_check: 'no evidence either way — the research-use restriction applies until somebody checks',
  };
}

/**
 * Decide what to do with one extracted row.
 *
 * `ctx` carries what we already know:
 *   catalogueCas   Set of CAS numbers already on abiozen.com
 *   catalogueNames Set of normalised product names already on abiozen.com
 *   demandCas      Set of CAS numbers with evidenced demand (trials, DMF matches, enquiries)
 *   demandNames    Set of normalised names with evidenced demand
 */
function classifyRow(row, ctx = {}) {
  const r = row || {};
  const name = r.name || '';
  const text = `${name} ${r.grade || ''} ${r.line || ''}`;
  // Every outcome carries it, including hold and reject: a row that later gets approved must not
  // arrive at the marketplace without its restriction.
  const use = useClass(r, ctx);

  // ── NOT LISTABLE AT ALL ────
  if (!name) {
    return { ...use, decision: 'reject', reason: 'no product name could be read next to this CAS number', priority: 0 };
  }
  // ── A MISSING CAS IS NOT THE SAME AS AN UNIDENTIFIED MOLECULE ────
  //
  // The first version held every row without a CAS number, and the first live run showed why that
  // is wrong: Alivus sent a clean spreadsheet of 158 molecule names with no CAS column, and all
  // 158 were held. "Apixaban" is not ambiguous. Neither is "Temozolomide" on Reliance's list.
  //
  // So the test is whether the molecule was IDENTIFIED — by a checksum-valid CAS number, or by
  // matching a molecule the platform already knows. A name that matched nothing and carries no CAS
  // is still held, because that is a genuinely unknown string.
  if (!r.cas && !r.dictionary) {
    return { ...use, decision: 'hold',
      reason: 'no CAS number and the name matches no molecule we know — ask the supplier to confirm what this is',
      priority: 0,
    };
  }

  // ── STOP AND ASK A HUMAN ────
  for (const [re, why] of RESTRICTED) {
    if (re.test(name)) return { ...use, decision: 'hold', reason: why, priority: 0 };
  }
  if (COSMETIC.test(text)) {
    return { ...use, decision: 'hold',
      reason: 'cosmetic grade — abiozen.com has not decided whether it carries cosmetics',
      priority: 0,
    };
  }
  if (r.confidence === 'low') {
    return { ...use, decision: 'hold',
      reason: `name was read from ${r.name_source || 'a neighbouring line'}, so the pairing is uncertain — check the source line`,
      priority: 0,
    };
  }

  // ── ALREADY OURS ────
  const cat = ctx.catalogueCas || new Set();
  const catNames = ctx.catalogueNames || new Set();
  if (r.cas && cat.has(r.cas)) {
    return { ...use, decision: 'second_source',
      reason: 'already on abiozen.com — this is a second supplier for an existing product, which is a price lever rather than a new listing',
      priority: 90,
    };
  }
  if (catNames.has(norm(name))) {
    return { ...use, decision: 'second_source',
      reason: 'name matches an existing product (CAS differs or is absent) — confirm it is the same molecule, then treat as a second source',
      priority: 70,
    };
  }

  // ── NEW, AND RANKED BY WHETHER ANYONE WANTS IT ────
  // A name match is a weaker identification than a checksum, so an otherwise identical row ranks
  // below one carrying a CAS number — and the reason says so, because the reviewer should know
  // which rows would benefit from asking the supplier for CAS numbers.
  // Two things make a row less immediately useful, and both are subtracted from the rank rather
  // than hidden: identification by name alone, and a research-use restriction. A molecule that can
  // be supplied commercially is worth more today than one that needs a freedom-to-operate opinion
  // first, so Allopurinol surfaces above Orforglipron even when both show evidenced demand.
  const noCas = !r.cas;
  const ruo = use.use_class === 'rnd_only' ? 25 : 0;
  const less = (p) => Math.max(1, p - (noCas ? 15 : 0) - ruo);
  const note = (why) => (noCas ? `${why} — identified by name only, no CAS on the document` : why);

  const demand = ctx.demandCas || new Set();
  const demandNames = ctx.demandNames || new Set();
  const wanted = (r.cas && demand.has(r.cas)) || demandNames.has(norm(name));
  const regulated = (r.markers || []).some((m) => m === 'DMF' || m === 'CEP');

  if (wanted) {
    return { ...use, decision: 'list',
      reason: note(regulated
        ? 'evidenced demand AND a filed DMF/CEP — list this first'
        : 'evidenced demand — somebody is already looking for this molecule'),
      priority: less(regulated ? 100 : 85),
    };
  }
  if (regulated) {
    return { ...use, decision: 'list',
      reason: note('a filed DMF or CEP, which is what a buyer asks for second after price'),
      priority: less(60),
    };
  }
  return { ...use, decision: 'list',
    reason: note('new product, no demand signal yet — list it, but it is not the one to lead with'),
    priority: less(30),
  };
}

/** Classify a set of rows and summarise. Rows come back sorted: the ones worth reading first. */
function classifyAll(rows, ctx = {}) {
  const out = (rows || []).map((r) => ({ ...r, ...classifyRow(r, ctx) }));
  out.sort((a, b) => b.priority - a.priority || String(a.name).localeCompare(String(b.name)));
  const counts = {};
  for (const r of out) counts[r.decision] = (counts[r.decision] || 0) + 1;
  return { rows: out, counts };
}

module.exports = { classifyRow, classifyAll, useClass, RESTRICTED, COSMETIC, RUO_NOTICE };
