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

  linkabl: {
    // Recruiting/staffing agencies. IMPORTANT: Google Places has ONE underlying type for all of
    // these — `employment_agency`; it does NOT expose distinct types for IT vs healthcare vs
    // generic staffing. The split below is purely the free-text query, which biases WHICH firms
    // rank, not a Places category. Measured overlap (Chicago, one page each): 'healthcare
    // staffing agency' shares 0% place_ids with the others (its own clean set); 'IT staffing
    // agency' shares 54–67% with 'staffing agency' (generic firms crowd the IT query), so the
    // tech/general split is FUZZY — the qualifier/enrichment (below) is the real classifier, not
    // the query. Dropped 'recruiting agency' + 'employment agency' (43–67% dupes of 'staffing
    // agency', same type — wasted tiles) and 'executive search firm' (a different business —
    // headhunting, not the volume ATS-running staffing market). Order matters: subtype is claimed
    // by the FIRST tile to insert a place (ON CONFLICT DO NOTHING), region-by-region, in this
    // array order — specialists first so a genuine IT firm that also ranks generically (e.g.
    // Motion Recruitment) keeps the 'tech' tag instead of being swallowed by 'general'.
    subtypes: [
      { key: 'healthcare', term: 'healthcare staffing agency' },
      { key: 'tech', term: 'IT staffing agency' },
      { key: 'general', term: 'staffing agency' },
    ],
    states: ['IL'], // match GolfNex/Favly (reuses tiles.js REGIONS['IL'])
    // ATS / recruiting-CRM tokens as they appear in careers-page HTML (job-board link href,
    // embed script/iframe src, or text). INVERTED polarity vs golf/beauty: here a detected
    // platform is the BETTER prospect (real req volume + a workflow to improve); no-platform is
    // likely a one-person shop. Keys are host/brand tokens chosen to avoid English-word false
    // positives — 'lever.co' not 'lever', 'workable.com' not 'workable', 'greenhouse.io' not
    // 'greenhouse', 'loxo.co' not 'loxo'. See report for the per-signature sanity-check list.
    signatures: [
      { platform: 'bullhorn', key: 'bullhorn' },
      { platform: 'greenhouse', key: 'greenhouse.io' },
      { platform: 'greenhouse', key: 'grnh.se' },
      { platform: 'lever', key: 'lever.co' },
      { platform: 'jobdiva', key: 'jobdiva' },
      { platform: 'ceipal', key: 'ceipal' },
      { platform: 'jobvite', key: 'jobvite' },
      { platform: 'workable', key: 'workable.com' },
      { platform: 'recruitee', key: 'recruitee' },
      { platform: 'smartrecruiters', key: 'smartrecruiters' },
      { platform: 'icims', key: 'icims' },
      { platform: 'taleo', key: 'taleo' },
      { platform: 'zohorecruit', key: 'zohorecruit' },
      { platform: 'zohorecruit', key: 'recruit.zoho' },
      { platform: 'crelate', key: 'crelate' },
      { platform: 'loxo', key: 'loxo.co' },
      { platform: 'avionte', key: 'avionte' },
    ],
    // Careers-page finder (the equivalent of a "book" link): the qualifier follows the first
    // matching link off the homepage and scans THAT page for the ATS signatures above.
    bookingLinkTerms: ['careers', 'jobs', 'apply', 'openings'],
  },
};

function getConfig(product) {
  return PRODUCT_CONFIG[product] || null;
}

module.exports = { PRODUCT_CONFIG, getConfig };
