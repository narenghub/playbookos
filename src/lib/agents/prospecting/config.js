// Prospecting — per-product DOMAIN configuration. Everything that makes the pipeline "about
// golf" (what to search for, which booking platforms to detect) lives HERE, per product.
// Previously these were module-global constants: SUBTYPES in tiles.js and SIGNATURES in
// qualify.js. Externalising them (following the PRODUCT_STATES pattern) is what turns a new
// product into a CONFIG entry instead of a code change.
//
// Entry shape:
//   subtypes:        [{ key, term }]  — the Places search terms (× regions → tiles)
//   states:          ['IL', ...]      — state keys into tiles.js REGIONS
//   signatures:      [{ platform, key }] — booking-platform tokens the qualifier scans for
//   bookingLinkTerms: ['book', ...]   — link text/href words that mark a "book/reserve" link

const PRODUCT_CONFIG = {
  golfnex: {
    subtypes: [
      { key: 'course', term: 'golf course' },
      { key: 'range', term: 'driving range' },
      { key: 'simulator', term: 'golf simulator' },
    ],
    states: ['IL'],
    signatures: [
      { platform: 'foreup', key: 'foreupsoftware.com' },
      { platform: 'foreup', key: 'foreup' },
      { platform: 'golfnow', key: 'golfnow' },
      { platform: 'ezlinks', key: 'ezlinks' },
      { platform: 'chronogolf', key: 'chronogolf' },
      { platform: 'lightspeed', key: 'lightspeed' },
      { platform: 'teesnap', key: 'teesnap' },
      { platform: 'clubprophet', key: 'clubprophet' },
      { platform: 'supremegolf', key: 'supremegolf' },
      { platform: 'membersports', key: 'membersports' },
      { platform: 'teeitup', key: 'teeitup' },
      { platform: 'golfrev', key: 'golfrev' },
      { platform: 'quick18', key: 'quick18' },
    ],
    bookingLinkTerms: ['book', 'tee time', 'reserve', 'booking'],
  },
};

function getConfig(product) {
  return PRODUCT_CONFIG[product] || null;
}

module.exports = { PRODUCT_CONFIG, getConfig };
