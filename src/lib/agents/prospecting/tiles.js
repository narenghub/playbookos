// GolfNex prospecting — tile configuration. The Places Text Search cap is 60 results per
// query, so a statewide search must be TILED: 3 subtypes × geographic regions. Adding a new
// state (or product) is a config entry here, NOT new code — the orchestrator reads tiles
// from tilesForProduct().

const SUBTYPES = [
  { key: 'course', term: 'golf course' },
  { key: 'range', term: 'driving range' },
  { key: 'simulator', term: 'golf simulator' },
];

// state → regions. Chicago metro is subdivided (it holds most facilities and would hit the
// 60 cap as one tile); downstate metros are single tiles.
const REGIONS = {
  illinois: [
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

// product → states it prospects. Adding a product/state is a data change here.
const PRODUCT_STATES = {
  golfnex: ['illinois'],
};

// Build every { region, subtype, query } tile for a product. query = "<term> in <region>".
function tilesForProduct(product) {
  const states = PRODUCT_STATES[product] || [];
  const tiles = [];
  for (const state of states) {
    for (const region of (REGIONS[state] || [])) {
      for (const st of SUBTYPES) {
        tiles.push({ state, region, subtype: st.key, query: `${st.term} in ${region}` });
      }
    }
  }
  return tiles;
}

module.exports = { SUBTYPES, REGIONS, PRODUCT_STATES, tilesForProduct };
