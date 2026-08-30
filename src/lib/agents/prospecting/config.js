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

  favly: {
    // Facility TYPES that enumerate the appointment-based beauty/grooming market. Chose the
    // four clean Places facility categories; deliberately dropped 'esthetician' (a profession,
    // not a facility — it returns individuals/med-spas and enumerates noisily).
    subtypes: [
      { key: 'hair', term: 'hair salon' },
      { key: 'nail', term: 'nail salon' },
      { key: 'barber', term: 'barber shop' },
      { key: 'spa', term: 'day spa' },
    ],
    states: ['IL'], // match GolfNex for now (reuses tiles.js REGIONS['IL'])
    // Salon/beauty booking platforms → the token that appears in the site HTML (script/iframe
    // src, booking-link href, or text). Multiple keys per platform where the vendor uses more
    // than one booking host (Square, Acuity). See report for the sanity-check list.
    signatures: [
      { platform: 'vagaro', key: 'vagaro' },
      { platform: 'booksy', key: 'booksy' },
      { platform: 'fresha', key: 'fresha' },
      { platform: 'glossgenius', key: 'glossgenius' },
      { platform: 'square', key: 'squareup.com/appointments' },
      { platform: 'square', key: 'book.squareup.com' },
      { platform: 'mindbody', key: 'mindbodyonline' },
      { platform: 'schedulicity', key: 'schedulicity' },
      { platform: 'styleseat', key: 'styleseat' },
      { platform: 'boulevard', key: 'blvd.co' },
      { platform: 'phorest', key: 'phorest' },
      { platform: 'acuity', key: 'acuityscheduling' },
      { platform: 'acuity', key: 'squarespace-scheduling' },
      { platform: 'setmore', key: 'setmore' },
    ],
    bookingLinkTerms: ['book', 'appointment', 'schedule', 'reserve'],
  },
};

function getConfig(product) {
  return PRODUCT_CONFIG[product] || null;
}

module.exports = { PRODUCT_CONFIG, getConfig };
