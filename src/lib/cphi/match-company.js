// CPHI sourcing — company-name matching: FDA DMF holder -> CPHI exhibitor. Pure, no network.
//
// The two sides write the same company very differently. The FDA carries the filing legal
// entity in shouting caps ("BIOPHORE INDIA PHARMACEUTICALS PVT LTD"); CPHI carries the trading
// brand on the stand ("Biophore"). Four tiers bridge that, and the tier is the whole point —
// it is what decides whether a row can be acted on unreviewed.
//
//   exact   normalised equality.                      Same company. Safe.
//   core    equal after industry+legal words drop.    Same company. Safe.
//           "DR REDDYS LABORATORIES LTD" = "Dr. Reddy's"
//   prefix  one core is a token-boundary prefix of    RIGHT STAND, POSSIBLY WRONG ENTITY.
//           the other. "UMICORE ARGENTINA SA" ->      Gated: fine for a conversation at the
//           "UMICORE AG & CO. KG"                      booth, not for a contract.
//   token   a shared distinctive brand token.         ~50% WRONG. Gated hard.
//           Rescues "ZAKLADY FARMACEUTYCZNE
//           POLPHARMA" -> "Polpharma S.A." but also
//           produces "AURO PEPTIDES" -> "BCN PEPTIDES".
//
// THREE BUGS THIS ENCODES, all found by checking misses against the live site rather than
// trusting the first pass (which undercounted 150 as 146):
//   1. the brand token is not always FIRST — "ZAKLADY FARMACEUTYCZNE POLPHARMA", "YANGZHOU
//      AURISCO" both carry it last, so leading-token-only queries never found them.
//   2. the >=5-char distinctiveness guard belongs to PREFIX only. Applied to equality it
//      rejected "SUN PHARMACEUTICAL INDUSTRIES LTD" vs "Sun Pharmaceutical Ind. Ltd." —
//      both core to "sun".
//   3. possessives must collapse BEFORE punctuation splitting, or "Dr. Reddy's" becomes
//      "dr reddy s" and never matches "DR REDDYS ...".

const LEGAL = new Set(['inc','incorporated','llc','ltd','limited','pvt','private','corp','corporation','co','plc','gmbh','ag','sa','sas','sau','sl','srl','spa','nv','bv','aps','ab','as','oy','oyj','kk','pte','sdn','bhd','dd','kgaa','lp','llp','cv','sro','se','kg','ind','usa','us']);

const INDUSTRY = new Set(['pharmaceuticals','pharmaceutical','pharma','pharm','laboratories','laboratory','labs','lab','lifesciences','lifescience','life','sciences','science','biotech','biotechnology','biotechnologies','chemicals','chemical','chem','industries','industry','industrial','healthcare','health','international','group','holdings','holding','technologies','technology','tech','bio','biopharma','biopharmaceutical','biopharmaceuticals','drugs','drug','medicines','medicine','medical','fine','organics','solutions','company','and','the','of','factory']);

// Tokens that must never anchor a match on their own: places and generic qualifiers. Without
// this, a lone "beijing" matches every Beijing company on the floor.
const NON_ANCHOR = new Set(['global','new','united','national','asia','china','india','euro','world','shanghai','beijing','zhejiang','jiangsu','shandong','sichuan','hubei','hunan','anhui','henan','hebei','guangdong','chongqing','suzhou','hangzhou','nanjing','shenzhen','wuhan','xian','tianjin','yangzhou','yancheng','taizhou','huzhou','ningxia','jilin','harbin','guizhou','hainan','shanxi','xuzhou','changzhou','chengdu','huangshi','shijiazhuang','nantong','weihai','jingmen','heze','linhai','shaoxing','kunming','ningbo','wuxi','yunnan','jiangxi','fujian','heilongjiang','guangzhou','japan','korea','taiwan','switzerland','france','netherlands','germany','italy','spain','mexico','argentina','brasil','brazil','malta','ireland','sweden','portugal','nl','usa','us','zaklady','farmaceutyczne','peptide','peptides','biomedical']);

const SUFFIX_RE = /\s+(inc|incorporated|llc|ltd|limited|pvt|private|corp|corporation|co|plc|gmbh|ag|sa|sas|sau|sl|srl|spa|nv|bv|aps|ab|as|oy|oyj|kk|pte|sdn|bhd|dd|kgaa|lp|llp|cv|sro|se|kg)$/;

function normalizeCompany(name) {
  // Possessives first — see bug 3 above.
  let s = String(name == null ? '' : name).replace(/['’]/g, '').toLowerCase();
  s = s.replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(SUFFIX_RE, ''); } while (s !== prev);
  return s;
}

/** The normalised name with industry and legal words removed — the brand residue. */
function companyCore(name) {
  return normalizeCompany(name).split(' ').filter((w) => w && !INDUSTRY.has(w) && !LEGAL.has(w)).join(' ');
}

/** Can this core anchor a PREFIX match without swallowing unrelated companies? */
function canAnchor(core) {
  const t = String(core || '').split(' ').filter(Boolean);
  if (!t.length) return false;
  if (t.length === 1) return t[0].length >= 5 && !NON_ANCHOR.has(t[0]);
  return !t.every((w) => NON_ANCHOR.has(w));
}

/**
 * Queries to try against the CPHI exhibitor search, best first. Deliberately LOOSER than match
 * acceptance: a wasted query costs one lookup, whereas a missing query costs a real exhibitor.
 * matchTier() is what decides whether a returned name is actually the same company.
 */
function searchTerms(holder) {
  const k = companyCore(holder);
  const n = normalizeCompany(holder);
  const t = k.split(' ').filter(Boolean);
  const out = [];
  const add = (x) => { x = (x || '').trim(); if (x.length >= 3 && !out.includes(x)) out.push(x); };
  add(k);
  if (t.length > 2) add(t.slice(0, 2).join(' '));
  if (t.length > 1) { add(t[0]); add(t[t.length - 1]); }       // brand can be first OR last
  for (const w of t) if (w.length >= 5 && !NON_ANCHOR.has(w)) add(w);
  if (!out.length) { const tn = n.split(' ').filter(Boolean); add(tn.slice(0, 2).join(' ')); add(tn[0]); }
  return out;
}

/** null when the two names are not the same company by any tier. */
function matchTier(holder, exhibitorName) {
  const hn = normalizeCompany(holder);
  const en = normalizeCompany(exhibitorName);
  const hk = companyCore(holder);
  const ek = companyCore(exhibitorName);

  // Identical cores ARE the same company; the anchor guard is for prefix, not equality.
  if (hk && hk === ek && !NON_ANCHOR.has(hk)) return hn === en ? 'exact' : 'core';
  if (hn && hn === en) return 'exact';

  if (hk && ek && canAnchor(hk) && canAnchor(ek) && (ek.startsWith(hk + ' ') || hk.startsWith(ek + ' '))) {
    return 'prefix';
  }

  // Weakest: one side's distinctive tokens are wholly contained in the other's.
  const sig = (x) => x.length >= 4 && !NON_ANCHOR.has(x);
  const a = hk.split(' ').filter(Boolean);
  const b = ek.split(' ').filter(Boolean);
  const shared = a.filter((x) => sig(x) && b.includes(x));
  if (shared.length && (shared.length === a.filter(sig).length || shared.length === b.filter(sig).length)) {
    return 'token';
  }
  return null;
}

const TIER_RANK = { exact: 0, core: 1, prefix: 2, token: 3 };

/**
 * Review gate. exact/core name the same legal entity and are safe to act on. `prefix` finds the
 * right STAND but often a parent or sibling entity (Umicore Argentina -> Umicore AG & Co KG) —
 * fine for a conversation, wrong for a contract, so it is held for entity review. `token` is
 * roughly half wrong and is held outright.
 */
function reviewStatusFor(tier) {
  if (tier === 'exact' || tier === 'core') return 'auto_confirmed';
  if (tier === 'prefix') return 'entity_review';
  return 'unreviewed';
}

/** Best match across a set of candidate exhibitors. Returns null when none qualify. */
function bestMatch(holder, exhibitors) {
  let best = null;
  for (const e of exhibitors) {
    const tier = matchTier(holder, e.name);
    if (!tier) continue;
    if (!best || TIER_RANK[tier] < TIER_RANK[best.tier]) best = { tier, name: e.name, booth: e.booth };
  }
  return best;
}

module.exports = {
  normalizeCompany, companyCore, canAnchor, searchTerms,
  matchTier, bestMatch, reviewStatusFor, TIER_RANK,
  LEGAL, INDUSTRY, NON_ANCHOR,
};
