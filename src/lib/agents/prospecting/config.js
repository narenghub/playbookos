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
//   regions:         ['Chicago, IL']  — OPTIONAL. Overrides REGIONS[state] so a product can run
//                                       one metro instead of a whole state. Omit = all regions.
//   callCap:         60               — OPTIONAL. Per-product Places call cap, preferred over
//                                       PROSPECTING_CALL_CAP (which is global to every product).
//   primeBy:         'site_score'     — OPTIONAL. Names the axis "prime" is measured on when it
//                                       is NOT booking-platform polarity. See sitenex below.

const PRODUCT_CONFIG = {
  golfnex: {
    // Prime = NO platform: they have not solved booking yet, so there is something to sell.
    primeSignal: 'no-platform',
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
    // Prime = NO platform: they have not solved booking yet, so there is something to sell.
    primeSignal: 'no-platform',
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
    // INVERTED. Prime = HAS a platform: an ATS means real requisition volume and a workflow
    // worth improving. No platform is more likely a one-person shop with nothing to integrate.
    primeSignal: 'platform',
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

  sitenex: {
    // SiteNex referral pipeline, 'outdated site' segment: local businesses whose website is bad
    // enough to sell a rebuild against. SiteNex sells through REFERRAL PARTNERS — sitenex_deals tracks the
    // client deals it refers (see scripts/migrate-sitenex.js).
    //
    // primeSignal is DELIBERATELY ABSENT. Its vocabulary ('platform' | 'no-platform') is about
    // booking-software polarity and means nothing here; prime for SiteNex is "the site is bad",
    // i.e. a high site_score. Setting primeSignal:'no-platform' would make the Prospects page's
    // prime filter read "no CMS detected" — close to the opposite of what we want. Because the
    // field is absent, routes.js:4410 still falls back to 'no-platform' for the legacy
    // ?booking_platform=prime filter, so that filter must NOT be used for sitenex; the page needs
    // to branch on primeBy. Until it does, filter sitenex by site_score directly.
    primeBy: 'site_score',            // prime = HIGH site_score (0-100, higher = worse)
    // These three survived a four-cell experiment (2026-09-28, ~$1.50) that separated the
    // CATEGORY effect from the GEOGRAPHY effect. Metrics per cell were: share with no website
    // (the P1 pool), share on plain http://, and share whose URL carries utm_/campaign tracking
    // — the last being the sharpest proxy for "already pays an agency", i.e. won't buy a rebuild.
    //
    //   old cats (hvac/plumbing/dental/legal) × Chicago :  3.1% noSite / 27.5% http / 27.5% tracked
    //   new cats × Chicago                              : 12.6% / 44.6% / 13.8%
    //   old cats × Rockford                             : 16.1% / 35.3% / 13.2%
    //   new cats × Rockford                             : 27.6% / 40.5% /  7.1%   <- best cell
    //
    // Category and geography both help and compound, but the category effect is the larger one:
    // machine_shop scores 66.7% http / 0.0% tracked in Rockford AND 58.8% / 5.9% in CHICAGO, so
    // the metro was never the problem — the original four categories were. Chicago therefore
    // stays in (it holds the largest pool of the best category, and it subdivides across five
    // regions so the 60-result Places cap works in our favour rather than against us).
    //
    // DROPPED after the experiment: auto_repair (only 52% even have a website, and http:// is
    // flat at 28.6/33.3/26.5% across review bands — review count carries no site-quality signal,
    // so it is noise, not a segment) and daycare (26.3% tracked, near the discarded baseline —
    // a credibility purchase means they already bought a site).
    subtypes: [
      { key: 'machine_shop', term: 'machine shop' },   // best of the set: B2B, real revenue, unmarketed
      { key: 'funeral', term: 'funeral home' },        // family-owned, high-margin, nobody calls them
      { key: 'pharmacy', term: 'independent pharmacy' }, // squeezed by chains, so local presence matters
    ],
    states: ['IL'],                   // all 13 REGIONS — this segment scales by METRO, not category
    callCap: 150,                     // 3 subtypes × 13 regions × ≤3 pages ≈ 117 calls (~$4)
    // CMS / site-builder tokens. NOTE: these are scored, not chosen between — the site-quality
    // scorer (not built yet) will use detectAll() so every signal counts. Until that scorer
    // exists, running the EXISTING booking qualifier against sitenex will record whichever builder
    // it finds in booking_platform. That is harmless and mildly useful (it is a real builder
    // detection), and it cannot corrupt the sitenex prime pool because prime here is site_score,
    // not booking_platform.
    signatures: [
      { platform: 'wix', key: 'wix.com' },
      { platform: 'wix', key: 'parastorage.com' },      // Wix's static host, present even on custom domains
      { platform: 'squarespace', key: 'squarespace.com' },
      { platform: 'squarespace', key: 'static1.squarespace' },
      { platform: 'wordpress', key: 'wp-content' },
      { platform: 'wordpress', key: 'wp-includes' },
      { platform: 'weebly', key: 'weebly.com' },
      { platform: 'weebly', key: 'editmysite.com' },     // Weebly/Square Online asset host
      { platform: 'godaddy', key: 'godaddysites.com' },
      { platform: 'godaddy', key: 'secureserver.net' },
      { platform: 'duda', key: 'dudamobile' },
      { platform: 'duda', key: 'multiscreensite.com' },
      { platform: 'joomla', key: '/media/jui/' },         // path token, not the word 'joomla'
      { platform: 'drupal', key: '/sites/default/files' },
      { platform: 'shopify', key: 'cdn.shopify.com' },
      { platform: 'frontpage', key: 'vti_cnf' },          // FrontPage leftovers — ancient by definition
    ],
    // The scorer fetches the homepage; these are the one-hop links worth following when the
    // homepage alone is thin. Not booking links — SiteNex sells the site itself.
    bookingLinkTerms: ['about', 'contact', 'services'],
    // NOT YET READ BY ANY CODE. Declared here for the scorer's qualify pass, which will consume
    // it; until that ships, nothing rejects anything and these rows enumerate like any other.
    // Rejection patterns — a rebuild is unsellable to a franchise
    // or a hospital system, and pharmacy in particular pulls them in (Walgreens, CVS, and
    // hospital outpatient pharmacies all rank for 'independent pharmacy').
    //
    // NOTE what is deliberately NOT here: a high-review-count rejection. That correlation
    // ("many reviews ≈ has an agency") held in the ESTABLISHED verticals — hvac 14→3→44%,
    // legal 13→23→46%, plumbing 0→15→32% tracked by review band — but these three categories
    // are the opposite case: machine shops average FIVE reviews, and that is the whole point.
    rejectNamePatterns: [
      'walgreens', 'cvs', 'rite aid', 'walmart', 'costco', 'sam\'s club', 'kroger', 'jewel-osco',
      'mariano\'s', 'meijer', 'target pharmacy', 'osco', 'hy-vee',
      'health system', 'healthcare system', 'medical center', 'hospital', 'uw health',
      'advocate', 'northwestern medicine', 'osf ', 'carle ', 'mercyhealth', 'swedishamerican',
      'dignity memorial', 'service corporation international',
    ],
  },
};

function getConfig(product) {
  return PRODUCT_CONFIG[product] || null;
}

module.exports = { PRODUCT_CONFIG, getConfig };
