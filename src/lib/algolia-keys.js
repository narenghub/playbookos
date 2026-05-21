// Purpose-scoped Algolia keys — least privilege per operation class.
// Each scoped key falls back to ALGOLIA_API_KEY when unset, so a single-key
// deployment keeps working until dedicated keys are provisioned.
const fallback = () => process.env.ALGOLIA_API_KEY || '';

function getAppId() {
  return process.env.ALGOLIA_APP_ID || '';
}

// Write operations — batch indexing / catalog sync. Needs the addObject ACL.
function getWriteKey() {
  return process.env.ALGOLIA_API_KEY || '';
}

// Index search queries (/1/indexes/{index}/query). Needs the search ACL.
function getSearchKey() {
  return process.env.ALGOLIA_SEARCH_KEY || fallback();
}

// Analytics API (analytics.algolia.com) — top searches, no-result searches,
// CTR, conversion rate. Needs the analytics ACL.
function getAnalyticsKey() {
  return process.env.ALGOLIA_ANALYTICS_KEY || fallback();
}

// Algolia Recommend API. Needs the recommendation ACL.
function getRecommendationKey() {
  return process.env.ALGOLIA_RECOMMENDATION_KEY || fallback();
}

module.exports = { getAppId, getWriteKey, getSearchKey, getAnalyticsKey, getRecommendationKey };
