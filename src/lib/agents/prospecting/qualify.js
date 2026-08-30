// Prospecting — booking-signature qualifier (PURE, uses outbound/http.js httpText).
//
//   qualifyFacility(website, { signatures, bookingLinkTerms }) -> { platform, confidence, evidence }
//
// The strongest prospecting signal: does the facility already run booking software?
// 1. Fetch the homepage; scan for the product's platform signatures.
// 2. If none, follow ONE booking link (widgets often live on a subdomain).
// 3. Return the platform, or null if none found.
//
// confidence: high = signature in a <script>/<iframe> src; medium = in a link href;
//             low = only a text mention. NEVER THROWS on a RUNTIME site failure — a dead
//             site/timeout/403/non-HTML is a RESULT (platform:null with evidence).
//
// signatures + bookingLinkTerms are REQUIRED — there is NO default. A domain default is how
// a wrong assumption creeps back: qualifyFacility(url) for salons would silently scan for
// tee-time platforms, find nothing, and produce a clean-looking-but-wrong prospect list.
// Missing config is therefore a LOUD programming error (thrown before the runtime try), not a
// swallowed null. The orchestrator passes the product's config from config.js.

const { httpText } = require('../../outbound/http');

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Detect the highest-confidence signature in one HTML blob against a given signature set.
// high (script/iframe src) beats medium (link href) beats low (text mention).
function detect(html, signatures) {
  if (!Array.isArray(signatures) || !signatures.length) throw new Error('detect(html, signatures): a non-empty signatures array is required');
  const h = String(html || '');
  for (const s of signatures) {
    if (new RegExp('<(?:script|iframe)\\b[^>]+src=["\'][^"\']*' + esc(s.key) + '[^"\']*["\']', 'i').test(h))
      return { platform: s.platform, confidence: 'high', evidence: 'script/iframe src ~ ' + s.key };
  }
  for (const s of signatures) {
    if (new RegExp('href=["\'][^"\']*' + esc(s.key) + '[^"\']*["\']', 'i').test(h))
      return { platform: s.platform, confidence: 'medium', evidence: 'link href ~ ' + s.key };
  }
  for (const s of signatures) {
    if (new RegExp(esc(s.key), 'i').test(h))
      return { platform: s.platform, confidence: 'low', evidence: 'text mention ~ ' + s.key };
  }
  return { platform: null, confidence: null, evidence: null };
}

// Build the booking-link matcher from config terms: a space in a term becomes [\s-]? (so
// 'tee time' matches 'tee-time' / 'tee time'). Terms are required — no default.
function bookingLinkRegex(terms) {
  if (!Array.isArray(terms) || !terms.length) throw new Error('bookingLinkRegex(terms): a non-empty terms array is required');
  const alt = terms.map(t => esc(t).replace(/ /g, '[\\s-]?')).join('|');
  return new RegExp('(?:' + alt + ')', 'i');
}

// Find the first booking link and resolve it absolute against baseUrl.
function findBookingLink(html, baseUrl, terms) {
  const rx = bookingLinkRegex(terms); // throws if terms missing
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[1];
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    const text = (m[2] || '').replace(/<[^>]+>/g, ' ');
    if (rx.test(href + ' ' + text)) {
      try { return new URL(href, baseUrl).href; } catch { /* skip malformed href */ }
    }
  }
  return null;
}

async function qualifyFacility(website, { signatures, bookingLinkTerms, deps = {} } = {}) {
  // Misuse (missing domain config) is a LOUD error, validated BEFORE the try so it can never
  // be swallowed into a silent null. Runtime site failures inside the try stay results.
  if (!Array.isArray(signatures) || !signatures.length) throw new Error('qualifyFacility: signatures (from the product config) are required');
  if (!Array.isArray(bookingLinkTerms) || !bookingLinkTerms.length) throw new Error('qualifyFacility: bookingLinkTerms (from the product config) are required');
  try {
    if (!website) return { platform: null, confidence: null, evidence: 'no website' };
    const fetchText = deps.httpText || httpText;

    const home = await fetchText({ url: website });
    if (home.error || !home.text) {
      return { platform: null, confidence: null, evidence: 'homepage unreachable: ' + (home.error || 'empty body') };
    }
    let hit = detect(home.text, signatures);
    if (hit.platform) return hit;

    const link = findBookingLink(home.text, website, bookingLinkTerms);
    if (link) {
      const page = await fetchText({ url: link });
      if (!page.error && page.text) {
        hit = detect(page.text, signatures);
        if (hit.platform) return { ...hit, evidence: hit.evidence + ' (via book link ' + link + ')' };
      }
      return { platform: null, confidence: null, evidence: 'no signature (homepage + book link ' + link + ')' };
    }
    return { platform: null, confidence: null, evidence: 'no signature (homepage; no book link found)' };
  } catch (e) {
    return { platform: null, confidence: null, evidence: 'qualify error: ' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = { qualifyFacility, detect, findBookingLink, bookingLinkRegex };
