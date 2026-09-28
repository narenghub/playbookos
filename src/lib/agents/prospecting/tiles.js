// Prospecting — geographic tiles. The Places Text Search cap is 60 results per query, so a
// statewide search must be TILED: subtypes × regions. Subtypes + which states a product
// prospects now live in config.js (per product); REGIONS (state → region list) stays here.
// Adding a state = a REGIONS entry; adding a product = a config.js entry — neither is code.

const { getConfig } = require('./config');

// state key → regions. Chicago metro is subdivided (it alone would hit the 60 cap); downstate
// metros are single tiles. Region STRINGS are what Places searches — keep them stable.
const REGIONS = {
  IL: [
    'Chicago, IL',
    'North Shore, Illinois',
    'Northwest suburbs, Chicago, IL',
    'West suburbs, Chicago, IL',
    'South suburbs, Chicago, IL',
    'Rockford, IL',
    'Peoria, IL',
    'Springfield, IL',
    'Champaign, IL',
    'Bloomington, IL',
    'Quad Cities, IL',
    'Decatur, IL',
    'Metro East, Illinois',
  ],
};

// Build every { state, region, subtype, query } tile for a product from its config.
// query = "<subtype term> in <region>". Unknown product → [] (orchestrator reports it).
function tilesForProduct(product) {
  const cfg = getConfig(product);
  if (!cfg) return [];
  const tiles = [];
  // cfg.regions (optional) narrows a state to specific metros — a first run can be one metro
  // instead of all 13 IL tiles. Guarded so it changes nothing for a product that omits it:
  // only a non-empty array overrides, and each region is still filtered to REGIONS[state], so a
  // typo yields no tiles (which the orchestrator reports) rather than an unsearchable query.
  const override = Array.isArray(cfg.regions) && cfg.regions.length ? cfg.regions : null;
  for (const state of (cfg.states || [])) {
    const all = REGIONS[state] || [];
    const regions = override ? all.filter(r => override.includes(r)) : all;
    for (const region of regions) {
      for (const st of (cfg.subtypes || [])) {
        tiles.push({ state, region, subtype: st.key, query: `${st.term} in ${region}` });
      }
    }
  }
  return tiles;
}

module.exports = { REGIONS, tilesForProduct };
