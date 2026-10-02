// ── LABCONNECT REGIONS: THE ROUTING KEY ───────────────────────────────────────
//
// An order has to go somewhere. This module decides WHERE a lab sits, as one short string, from
// the only location data the FDA register actually gives us: a country and a US postal address.
//
// WHAT A REGION IS FOR, AND WHAT IT IS NOT FOR. It is a coarse bucket for routing and for the
// directory's filters — "show me the labs in my half of the country". It is NOT a statement that
// the nearest lab is the right lab: a QC sample ships overnight, and whether a lab can take an
// order is decided by whether it runs that method under the right accreditation, not by distance.
// Region breaks ties and it carries the cold-chain and short-hold-time cases where distance
// genuinely matters. Capability comes first; see lab_tests.
//
// WHY TIME ZONES RATHER THAN CENSUS DIVISIONS. The four zones are how the business already talks
// about US coverage, and they line up with the thing that matters operationally for a lab you
// phone: whether their working day overlaps yours. Census divisions would cut the country nine
// ways and no one would know which they were in.
//
// THE HONEST LIMITATION, stated here because the map looks more precise than it is: thirteen
// states straddle two time zones. A state is assigned to the zone holding most of its population,
// so a lab in the Florida panhandle is filed as Eastern and a lab in western Kansas as Central.
// For a routing bucket that is the right trade; for anything that needs a real timezone, use the
// address, not this.

// state → zone. Split states are marked with the share that is actually elsewhere, so the next
// person reading this knows the assignment is a judgement and not a fact.
const US_ZONE = {
  // ── Eastern ──
  CT: 'us_east', DC: 'us_east', DE: 'us_east', GA: 'us_east', MA: 'us_east', MD: 'us_east',
  ME: 'us_east', NC: 'us_east', NH: 'us_east', NJ: 'us_east', NY: 'us_east', OH: 'us_east',
  PA: 'us_east', RI: 'us_east', SC: 'us_east', VA: 'us_east', VT: 'us_east', WV: 'us_east',
  FL: 'us_east',       // panhandle west of the Apalachicola is Central
  MI: 'us_east',       // four western UP counties are Central
  IN: 'us_east',       // a dozen north-west and south-west counties are Central
  KY: 'us_east',       // the western third is Central
  TN: 'us_east',       // the middle and west — most of the state's population — is Central
  // ── Central ──
  AL: 'us_central', AR: 'us_central', IA: 'us_central', IL: 'us_central', LA: 'us_central',
  MN: 'us_central', MO: 'us_central', MS: 'us_central', OK: 'us_central', WI: 'us_central',
  TX: 'us_central',    // El Paso and Hudspeth are Mountain
  KS: 'us_central',    // four western counties are Mountain
  NE: 'us_central',    // the western panhandle is Mountain
  ND: 'us_central',    // the south-west corner is Mountain
  SD: 'us_central',    // roughly the western half is Mountain
  // ── Mountain ──
  AZ: 'us_mountain', CO: 'us_mountain', MT: 'us_mountain', NM: 'us_mountain', UT: 'us_mountain',
  WY: 'us_mountain',
  ID: 'us_mountain',   // the panhandle north of the Salmon River is Pacific
  // ── Pacific ──
  CA: 'us_pacific', NV: 'us_pacific', WA: 'us_pacific',
  OR: 'us_pacific',    // most of Malheur County is Mountain
  // Alaska and Hawaii have their own zones and two labs between them; folded into Pacific rather
  // than given buckets that would sit empty in every filter on the directory.
  AK: 'us_pacific', HI: 'us_pacific',
  // Territories. PR and VI run on Atlantic time; a US-market lab there is served by the Eastern
  // desk, which is what the bucket is for.
  PR: 'us_east', VI: 'us_east', GU: 'us_pacific', AS: 'us_pacific', MP: 'us_pacific',
};

const US_ZONES = ['us_east', 'us_central', 'us_mountain', 'us_pacific'];

const ZONE_LABEL = {
  us_east: 'US · Eastern',
  us_central: 'US · Central',
  us_mountain: 'US · Mountain',
  us_pacific: 'US · Pacific',
};

// EU/EEA + UK + Switzerland and the other EFTA states, as ISO-3. Europe is NOT bucketed into
// zones: a national regulator licenses each lab, so the country IS the operational unit — a
// German lab and a French lab are not interchangeable the way Ohio and Pennsylvania are.
const EUROPE = ['GBR', 'CHE', 'NOR', 'ISL', 'LIE',
  'AUT', 'BEL', 'BGR', 'HRV', 'CYP', 'CZE', 'DNK', 'EST', 'FIN', 'FRA', 'DEU', 'GRC',
  'HUN', 'IRL', 'ITA', 'LVA', 'LTU', 'LUX', 'MLT', 'NLD', 'POL', 'PRT', 'ROU', 'SVK',
  'SVN', 'ESP', 'SWE'];
const EUROPE_SET = new Set(EUROPE);

/**
 * The US state out of an address tail: "..., Rockford, IL 61108" → "IL".
 *
 * Anchored on a two-letter code FOLLOWED BY A 5-DIGIT ZIP, which is what stops it matching a
 * street abbreviation ("...123 N ST, Chicago..."). Returns null rather than guessing: a wrong
 * state puts a lab in the wrong half of the country, which is worse than an unassigned one that
 * shows up in the directory's "region not determined" bucket and gets looked at.
 */
function stateFromAddress(address) {
  if (!address) return null;
  const m = /,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*(?:,|$)/.exec(String(address).toUpperCase());
  return m ? m[1] : null;
}

/**
 * The region for one establishment row.
 *
 *   regionFor({ country: 'USA', address: '...IL 61108' })  → { region: 'us_central', state: 'IL' }
 *   regionFor({ country: null,  address: '...IL 61108' })  → { region: 'us_central', state: 'IL' }
 *   regionFor({ country: 'DEU' })                          → { region: 'eu_deu',     state: null }
 *   regionFor({ country: 'IND' })                          → { region: 'row_ind',    state: null }
 *   regionFor({ country: null,  address: 'No. 9 Jianguo' }) → { region: null,         state: null }
 *
 * `region: null` means UNDETERMINED and is deliberately not a bucket of its own — a lab with no
 * usable location must not be silently filed anywhere, because routing would then send it work it
 * cannot be assessed for. The directory shows those rows under their own heading so somebody can
 * fix the address.
 *
 * ── WHY A NULL COUNTRY IS NOT THE END OF THE QUESTION ────────────────────────
 *
 * `fda_establishments.country` is parsed from a trailing "(DEU)" on the address, and the FDA file
 * writes that suffix on FOREIGN addresses only. A domestic one is "105 Church Rd, North Wales, PA
 * 19454" with nothing after it — so every US establishment in the register has country NULL.
 *
 * The first version of this function refused on a null country, and the result was that the US
 * labs — the entire domestic directory, which is the point of the product — all landed in "region
 * not determined":
 *
 *     ── region-wise ──
 *       (undetermined) region not determined        1,159
 *       row_ind        IND                            568
 *       row_chn        CHN                            261
 *     … and no US row anywhere in the list.
 *
 * So a null country falls through to the US address parse. That is an inference, and it is a safe
 * one for two reasons together: `stateFromAddress` requires a two-letter code followed by a 5-digit
 * ZIP, and the code must then be a REAL US state in US_ZONE. A German address ("Berlin, BE 10115")
 * passes the first and fails the second. A foreign address that passed both would have carried its
 * own "(XXX)" and never reached here.
 *
 * ── AND `is_us_agent` NO LONGER SUPPRESSES THE REGION ────────────────────────
 *
 * It used to, on the stated grounds that "a US-agent row carries the AGENT'S address — a law office
 * — not the lab's". That is wrong about this dataset, and the parser that produces the column says
 * so: `isUsAgent` reads REGISTRANT_CONTACT_EMAIL, the agent's MAILBOX. The establishment's own
 * address is in ADDRESS, and the agent has a separate AGENT_DETAILS column entirely. The flag
 * describes who answers the email, not where the laboratory is.
 *
 * It never bit, only because the branch was unreachable while every US row had a null country —
 * which is the kind of luck worth naming rather than relying on. What the flag DOES mean is carried
 * forward on the contact, where it belongs: an approach reads differently when it is going to a
 * compliance intermediary rather than the plant.
 */
function regionFor(row) {
  const country = row && row.country ? String(row.country).trim().toUpperCase() : null;

  if (!country || country === 'USA') {
    const state = stateFromAddress(row && row.address);
    if (!state) {
      return { region: null, state: null, country: country || null,
               reason: country ? 'no state in address' : 'no country and no US state in the address' };
    }
    const region = US_ZONE[state];
    if (!region) {
      // A two-letter code with a US-shaped ZIP that is not a US state. Refused rather than
      // bucketed: this is exactly the shape a foreign address takes when its country code is
      // missing, and guessing would file it in the wrong hemisphere.
      return { region: null, state: null, country: country || null, reason: `'${state}' is not a US state` };
    }
    return { region, state, country: 'USA', country_inferred: !country, reason: null };
  }

  if (EUROPE_SET.has(country)) {
    return { region: 'eu_' + country.toLowerCase(), state: null, country, reason: null };
  }

  // Everything else keeps its country rather than being lumped into one "rest of world": the
  // register has labs in India, China, Japan and Canada, and a bucket that merges them is useless
  // the first time somebody asks which country a lab is in.
  return { region: 'row_' + country.toLowerCase(), state: null, country, reason: null };
}

/** Human label for a region key, for the directory's filter and column. */
function regionLabel(region) {
  if (!region) return 'region not determined';
  if (ZONE_LABEL[region]) return ZONE_LABEL[region];
  const m = /^(eu|row)_([a-z]{3})$/.exec(region);
  if (m) return (m[1] === 'eu' ? 'EU · ' : '') + m[2].toUpperCase();
  return region;
}

/** Is this a region key this module could have produced? Used to reject a hand-typed filter. */
function isRegion(region) {
  if (typeof region !== 'string' || !region) return false;
  return US_ZONES.includes(region) || /^(eu|row)_[a-z]{3}$/.test(region);
}

module.exports = {
  regionFor, regionLabel, isRegion, stateFromAddress,
  US_ZONE, US_ZONES, ZONE_LABEL, EUROPE,
};
