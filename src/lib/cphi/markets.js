// ── WHICH MARKET A COMPANY SITS IN ────────────────────────────────────────────
//
// The partner and buyer lists are not US-only. The US model — a local partner holds the client
// relationship, offshore delivery builds, the platform coordinates — is being repeated in the EU, and
// the buyer side of LabConnect has demand on both sides of the Atlantic. So every non-supplier row
// carries the market it belongs to, and the floor list can be filtered down to one.
//
// ── THE SOURCE, AND WHERE IT IS BLUNT ────────────────────────────────────────
//
// `fda_establishments.country` is the ISO-3 code parsed out of the PARENTHESISED TAIL of the
// registered address — see src/lib/fda/establishments.js countryOf(). It is NULL when the tail
// carries no code, and that is the one thing worth knowing before trusting this filter:
//
//   • A NULL COUNTRY IS TREATED AS DOMESTIC. The register writes "…, United States (USA)" for US
//     sites and "…, France (FRA)" for foreign ones, so a missing tail is overwhelmingly a US row
//     with a truncated address, which is exactly what the region fix found: 1,159 US rows whose
//     country never parsed. Treating NULL as EU instead would be wrong far more often. It is still
//     an assumption, so it is written here once rather than inlined in three queries.
//   • THIS IS THE US REGISTER. A European CDMO appears in it only because it ships into the US. That
//     makes the EU list a list of EU firms with US-facing business — which for a partner conversation
//     is a feature, since those are the ones who already understand the regulatory surface we sell
//     into, and for a buyer conversation is a limit, since a purely domestic EU manufacturer is
//     invisible here. Say so on the floor rather than implying full EU coverage.
//
// Pure SQL fragments, no database handle, so the route and the script cannot disagree about what
// "EU" means.

const { EUROPE } = require('../labconnect/region');

const MARKETS = ['us', 'eu', 'all'];

/**
 * WHERE fragment restricting `fda_establishments` to one market.
 *
 *   const m = marketSql('eu', 1);
 *   await query(`SELECT ... WHERE ${m.sql} LIMIT $${m.nextIndex}`, [...m.params, limit]);
 *
 * Composes the same way outsourcerSql and territoryScopeSql do: it owns its own placeholders and
 * hands back the next free index, so a caller never has to count them.
 */
function marketSql(market, startIndex = 1) {
  let i = startIndex;
  if (market === 'eu') {
    return { sql: `(country = ANY($${i}))`, params: [EUROPE], nextIndex: i + 1 };
  }
  if (market === 'us') {
    // NULL is domestic — see the note at the top of this file.
    return { sql: `(country = 'USA' OR country IS NULL)`, params: [], nextIndex: i };
  }
  return { sql: 'TRUE', params: [], nextIndex: i };
}

/** Which market does one establishment row belong to? Mirrors marketSql, for labelling a row. */
function marketOf(country) {
  if (!country || country === 'USA') return 'us';
  return EUROPE.includes(country) ? 'eu' : 'row';
}

function marketLabel(market) {
  return { us: 'US', eu: 'EU', row: 'rest of world', all: 'all markets' }[market] || market;
}

function isMarket(m) { return MARKETS.includes(m); }

module.exports = { MARKETS, marketSql, marketOf, marketLabel, isMarket, EUROPE };
