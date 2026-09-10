// ── FDA establishment registration (DECRS) — PURE parsing + name folding ──
//
// No network, no DB. `parseDecrs(text)` takes the unzipped drls_reg.txt and returns rows in
// column shape; the ingest script owns the download and the upsert. Same split as
// src/lib/dmf/fda-file.js: a parser you can test on a fixture beats one you can only test by
// downloading 2.3 MB.
//
// THE FILE IS TAB-SEPARATED, NOT PIPE. The header names 14 columns and rows carry 15 fields —
// there is a trailing empty field on every line. Splitting to exactly 14 and ignoring the rest
// is deliberate: a parser that demanded exactly 14 would reject every row in the file.

const FIELDS = [
  'FEI_NUMBER', 'DUNS_NUMBER', 'FIRM_NAME', 'ADDRESS', 'EXPIRATION_DATE', 'OPERATIONS',
  'ESTABLISHMENT_CONTACT_NAME', 'ESTABLISHMENT_CONTACT_EMAIL', 'AGENT_DETAILS',
  'REGISTRANT_NAME', 'REGISTRANT_DUNS', 'REGISTRANT_CONTACT_NAME',
  'REGISTRANT_CONTACT_EMAIL', 'EXCLUSION_FLAG',
];

// Third-party US-agent services. A foreign establishment must name a US agent to register, and
// that agent's mailbox lands in REGISTRANT_CONTACT_EMAIL — so the address is real, reachable,
// and belongs to a compliance intermediary rather than the plant. Measured on the live file:
// registrarcorp.com 597, applied-inc.com 232, asteriskllc.com 205.
const US_AGENT_DOMAINS = new Set([
  'registrarcorp.com', 'asteriskllc.com', 'applied-inc.com', 'usagentservices.com',
  'fdaagent.com', 'usagent.com', 'globalregulatorypartners.com',
]);

// Dropped before folding. Corporate suffixes and industry words carry no identity: every
// second firm in this file is a "PHARMACEUTICALS LTD", so leaving them in makes two unrelated
// companies look similar and two spellings of one company look different.
const GENERIC = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'pvt', 'private',
  'gmbh', 'ag', 'spa', 'srl', 'sas', 'bv', 'nv', 'plc', 'kg', 'sa', 'as', 'ab', 'oy',
  'bhd', 'sdn', 'the', 'and', 'of', 'group', 'holdings', 'international', 'usa', 'america',
  'pharmaceuticals', 'pharmaceutical', 'pharma', 'laboratories', 'laboratory', 'labs',
]);

/** Lowercase, strip punctuation, collapse whitespace. Never throws. */
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The identity-bearing tokens only — normalizeName minus the generic vocabulary. */
function firmCore(s) {
  return normalizeName(s).split(' ').filter(t => t && !GENERIC.has(t)).join(' ');
}

/**
 * ISO-3 country from the address tail: "Rue Grands Navoirs, Chauny, F-02300, France (FRA)".
 * Returns null rather than guessing — an address with no parenthesised code is not a country
 * we can filter on, and inventing one would put rows in the wrong geography silently.
 */
function countryOf(address) {
  const m = /\(([A-Z]{3})\)\s*$/.exec(String(address || '').trim());
  return m ? m[1] : null;
}

/** OPERATIONS is a semicolon list; API MANUFACTURE is the qualifying entry. */
function isApiManufacturer(operations) {
  return String(operations || '').toUpperCase().includes('API MANUFACTURE');
}

/** Is the REGISTRANT contact a third-party US agent rather than the firm itself? */
function isUsAgent(registrantEmail) {
  const d = String(registrantEmail || '').split('@').pop().toLowerCase().trim();
  return !!d && US_AGENT_DOMAINS.has(d);
}

/**
 * Parse drls_reg.txt into column shape. Never throws: a malformed line is skipped, not fatal,
 * because one bad row must not cost the other 10,453.
 */
function parseDecrs(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  // Drop the header only if it IS one — a file served as an error page must not silently
  // lose its first data row and look merely short.
  const start = /FEI_NUMBER/i.test(lines[0]) ? 1 : 0;
  const out = [];
  for (const line of lines.slice(start)) {
    const p = line.split('\t').map(x => x.trim());
    if (p.length < FIELDS.length) continue;              // not a data row
    const r = {};
    FIELDS.forEach((f, i) => { r[f] = p[i] || null; });
    if (!r.FIRM_NAME) continue;                          // firm_name is the join key; no name, no row
    out.push({
      fei_number: r.FEI_NUMBER || null,
      duns_number: r.DUNS_NUMBER || null,
      firm_name: r.FIRM_NAME,
      firm_normalized: normalizeName(r.FIRM_NAME),
      address: r.ADDRESS || null,
      country: countryOf(r.ADDRESS),
      operations: r.OPERATIONS || null,
      is_api_manufacturer: isApiManufacturer(r.OPERATIONS),
      establishment_contact_name: r.ESTABLISHMENT_CONTACT_NAME || null,
      establishment_contact_email: r.ESTABLISHMENT_CONTACT_EMAIL || null,
      registrant_name: r.REGISTRANT_NAME || null,
      registrant_contact_email: r.REGISTRANT_CONTACT_EMAIL || null,
      is_us_agent: isUsAgent(r.REGISTRANT_CONTACT_EMAIL),
      exclusion_flag: r.EXCLUSION_FLAG || null,
    });
  }
  return out;
}

/**
 * Which tier, if any, joins a DMF holder name to an establishment firm name?
 *
 *   exact  the folded names are identical
 *   core   identical once corporate suffixes and industry words are dropped
 *   null   no join
 *
 * DELIBERATELY NO LOOSER TIER. The CPHI work needed prefix and token tiers because it matched
 * against a bounded exhibitor list where a near-miss was usually the right company under a
 * different trading name. Here the looser tiers were MEASURED and they are noise: "TIANJIN
 * BIOSEPUR PURIFICATION EQUIPMENT" shares a token with "Alick's Home Medical Equipment". A
 * tier that is wrong more often than right is not a tier, it is a review queue nobody drains.
 */
function matchTier(holderName, firmName) {
  const hn = normalizeName(holderName);
  const fn = normalizeName(firmName);
  if (!hn || !fn) return null;
  if (hn === fn) return 'exact';
  const hc = firmCore(holderName);
  const fc = firmCore(firmName);
  if (hc && fc && hc === fc) return 'core';
  return null;
}

/** exact and core are trustworthy unattended; nothing else is written at all. */
function reviewStatusFor(tier) {
  return tier === 'exact' || tier === 'core' ? 'auto_confirmed' : 'unreviewed';
}

module.exports = {
  FIELDS, US_AGENT_DOMAINS, GENERIC,
  normalizeName, firmCore, countryOf, isApiManufacturer, isUsAgent,
  parseDecrs, matchTier, reviewStatusFor,
};
