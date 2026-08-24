// GolfNex prospecting — Google Places (New) Text Search client (PURE: no DB, no LLM),
// mirroring clinicaltrials.js. Uses the shared outbound/http.js (which already has the
// timeout). Never throws — returns { places, nextPageToken } or { places:[], error }.
//
//   searchText(query, { pageToken }) -> { places:[normalized], nextPageToken, error? }
//
// Billing note: websiteUri + rating fields put this at the Text Search "Enterprise" SKU
// (~$35/1000). nextPageToken is a top-level response field and MUST be in the field mask to
// paginate — it is not a billable place field and does not change the SKU tier.

const { httpJson } = require('../../outbound/http');

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
// The exact place.* field set requested, plus nextPageToken (required for pagination).
const PLACE_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.websiteUri', 'places.types', 'places.rating', 'places.userRatingCount', 'places.businessStatus',
];
const FIELD_MASK = PLACE_FIELDS.join(',') + ',nextPageToken';

// Flatten one raw Places result to our column shape. Pure; never throws.
function parsePlace(p) {
  p = p || {};
  return {
    place_id: p.id || null,
    name: (p.displayName && p.displayName.text) || null,
    address: p.formattedAddress || null,
    phone: p.nationalPhoneNumber || null,
    website: p.websiteUri || null,
    types: Array.isArray(p.types) ? p.types : [],
    rating: typeof p.rating === 'number' ? p.rating : null,
    rating_count: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
    business_status: p.businessStatus || null,
  };
}

async function searchText(query, { pageToken, apiKey = process.env.GOOGLE_PLACES_API_KEY, timeoutMs, deps = {} } = {}) {
  if (!apiKey) return { places: [], nextPageToken: null, error: 'GOOGLE_PLACES_API_KEY not configured' };
  if (!query) return { places: [], nextPageToken: null, error: 'query is required' };

  const body = { textQuery: query };
  if (pageToken) body.pageToken = pageToken;

  const doHttp = deps.httpJson || httpJson;
  const r = await doHttp({
    url: PLACES_URL,
    method: 'POST',
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
    body,
    timeoutMs,
  });
  if (r.error) return { places: [], nextPageToken: null, error: r.error };

  const data = r.data || {};
  const places = Array.isArray(data.places) ? data.places.map(parsePlace).filter(p => p.place_id) : [];
  return { places, nextPageToken: data.nextPageToken || null };
}

module.exports = { searchText, parsePlace, PLACES_URL, FIELD_MASK, PLACE_FIELDS };
