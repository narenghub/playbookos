// GolfNex prospecting — booking-signature qualifier (PURE, uses outbound/http.js httpText).
//
//   qualifyFacility(website) -> { platform, confidence, evidence }
//
// The strongest prospecting signal: does the facility already run tee-time booking software?
// 1. Fetch the homepage; scan for known platform signatures.
// 2. If none, follow ONE "book / tee time / reserve" link (widgets often live on a subdomain
//    — homepage-only scanning misses most of them).
// 3. Return the platform, or null if none found.
//
// confidence: high = signature in a <script>/<iframe> src; medium = in a link href;
//             low = only a text mention.
//
// NEVER THROWS. A dead site, timeout, 403, or non-HTML body is a RESULT (platform:null with
// evidence), not an error.

const { httpText } = require('../../outbound/http');

// platform → signature token (searched in the HTML). Ordered: more specific first.
const SIGNATURES = [
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
];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Detect the highest-confidence signature in one HTML blob. high (script/iframe src) beats
// medium (link href) beats low (text mention) — scanned in that order across all platforms.
function detect(html) {
  const h = String(html || '');
  for (const s of SIGNATURES) {
    if (new RegExp('<(?:script|iframe)\\b[^>]+src=["\'][^"\']*' + esc(s.key) + '[^"\']*["\']', 'i').test(h))
      return { platform: s.platform, confidence: 'high', evidence: 'script/iframe src ~ ' + s.key };
  }
  for (const s of SIGNATURES) {
    if (new RegExp('href=["\'][^"\']*' + esc(s.key) + '[^"\']*["\']', 'i').test(h))
      return { platform: s.platform, confidence: 'medium', evidence: 'link href ~ ' + s.key };
  }
  for (const s of SIGNATURES) {
    if (new RegExp(esc(s.key), 'i').test(h))
      return { platform: s.platform, confidence: 'low', evidence: 'text mention ~ ' + s.key };
  }
  return { platform: null, confidence: null, evidence: null };
}

// Find the first "book / tee time / reserve" link and resolve it absolute against baseUrl.
function findBookingLink(html, baseUrl) {
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[1];
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    const text = (m[2] || '').replace(/<[^>]+>/g, ' ');
    if (/book|tee[\s-]?time|reserve|booking/i.test(href + ' ' + text)) {
      try { return new URL(href, baseUrl).href; } catch { /* skip malformed href */ }
    }
  }
  return null;
}

async function qualifyFacility(website, { deps = {} } = {}) {
  try {
    if (!website) return { platform: null, confidence: null, evidence: 'no website' };
    const fetchText = deps.httpText || httpText;

    const home = await fetchText({ url: website });
    if (home.error || !home.text) {
      return { platform: null, confidence: null, evidence: 'homepage unreachable: ' + (home.error || 'empty body') };
    }
    let hit = detect(home.text);
    if (hit.platform) return hit;

    const link = findBookingLink(home.text, website);
    if (link) {
      const page = await fetchText({ url: link });
      if (!page.error && page.text) {
        hit = detect(page.text);
        if (hit.platform) return { ...hit, evidence: hit.evidence + ' (via book link ' + link + ')' };
      }
      return { platform: null, confidence: null, evidence: 'no signature (homepage + book link ' + link + ')' };
    }
    return { platform: null, confidence: null, evidence: 'no signature (homepage; no book link found)' };
  } catch (e) {
    return { platform: null, confidence: null, evidence: 'qualify error: ' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = { qualifyFacility, detect, findBookingLink, SIGNATURES };
