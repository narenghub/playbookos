// Prospecting — SITE QUALITY SCORE (PURE; the fetch lives in the orchestrator).
//
//   scoreSite({ html, finalUrl, website, reachable, unreachableReason, builderHits, now })
//     -> { score, signals:[{key,penalty,evidence}], builder }
//
// site_score is 0-100 and HIGHER = WORSE: it scores how bad the current site is, so the worst
// sites sort to the top of the call list. It is a SUM OF NAMED PENALTIES, never an opaque
// number — being quotable is the whole point. "Your site has these five problems" works in an
// email; "your site scores 64" does not. Every penalty therefore carries the evidence string
// that justifies it, and site_findings.signals is what an outreach email is written from.
//
// WHAT IS DELIBERATELY NOT IN HERE — rating_count. Review count measures "do they need
// customers"; this measures "how bad is the site". They are different axes, and blending them
// makes the score unquotable. rating_count is already a column on prospects; surface it BESIDE
// the score and let a human weigh the two.
//
// Signal weights were agreed against real data (2026-09-28 four-cell experiment):
//   • a 403 is treated as nearly UNKNOWN (5), not as a broken site — a bare-agent 403 is usually
//     bot protection. httpText now sends a User-Agent, which removes most of that noise.
//   • builder-hosted URL patterns (wixsite.com etc.) are NOT scored: measured 0% across 584
//     sites, because US small businesses buy real domains. Builder DETECTION still matters and
//     comes from detectAll() reading HTML tokens, which fire on a custom domain.

const SOCIAL_HOST = /(?:^|\.)(facebook|instagram|linkedin|twitter|x)\.com$/i;
// Builders whose presence is itself a datedness signal (as opposed to Wix/Squarespace/WordPress,
// which are merely "a platform" and say nothing about age on their own).
const DATED_BUILDERS = new Set(['weebly', 'godaddy', 'frontpage']);
// RESELLER platforms. duda is sold and maintained BY AGENCIES, so finding it means someone was
// already paid to build that site and is probably still being paid — the same "the seat is taken"
// read as utm tracking. It was previously in DATED_BUILDERS, which scored it in exactly the wrong
// direction: 77 of 84 dated_builder hits were duda, all of them tidy agency-built funeral sites.
const AGENCY_BUILDERS = new Set(['duda']);
// Campaign tracking on the URL Google holds for the business: somebody is running campaigns.
const AGENCY_TRACKING = /[?&](?:utm_[a-z]+|gclid|npcmp|mc_cid|fbclid)=|[?&]campaign=/i;

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return ''; } };

// Every penalty the scorer can apply, in one table so the weights are reviewable in one place.
const PENALTY = {
  social_as_website: 40,   // the only web presence is a social page
  site_unreachable: 35,    // dns / timeout / empty body — nothing to show a customer
  no_viewport: 25,         // not mobile-friendly, the single most quotable defect
  legacy_layout: 20,       // Flash, <font>, <center>, layout tables
  no_https: 15,            // http:// after redirects
  stale_copyright: 10,     // footer year more than 2 years old
  missing_title_or_desc: 10,
  dated_builder: 10,
  old_jquery: 5,
};

function scoreSite({ html, finalUrl, website, reachable, unreachableReason, builderHits = [], now = new Date() } = {}) {
  const signals = [];
  const add = (key, evidence) => signals.push({ key, penalty: PENALTY[key], evidence });
  const agencySignals = agencyEvidence(website, finalUrl, builderHits);

  // 1. Social-only presence — decided from the URL alone; we never fetch the social page.
  if (website && SOCIAL_HOST.test(host(website))) {
    add('social_as_website', `only web presence is ${host(website)}`);
    return finish(signals, null, agencySignals);
  }

  // 2. A 403 is NOT SCORED AT ALL — it is UNSCANNABLE. Scoring it low made "we could not look"
  // indistinguishable from "the site is fine", which is the worst possible failure in a list
  // someone calls from: 149 rows silently reading as clean. These stay prospects (a 403 says
  // nothing about the business) but sit in their own bucket for a human to spot-check.
  // We do NOT work around the bot protection — no UA rotation, no pretending to be a browser.
  if (reachable === false && unreachableReason === '403') {
    return { score: null, signals: [], builder: null, agencySignals,
      unscannable: true, unscannableReason: '403 — bot protection blocked the fetch; site NOT assessed' };
  }

  // 3. Genuinely unreachable: dns / timeout / http_error / empty. Scored, and routed to P1 by
  // recommendPackage once a SECOND scan confirms it (one 15s timeout is not a dead site).
  if (reachable === false) {
    add('site_unreachable', `homepage unreachable (${unreachableReason || 'unknown'})`);
    return finish(signals, null, agencySignals);
  }

  const h = String(html || '');
  if (!h) return finish(signals, null, agencySignals); // nothing fetched, not marked unreachable

  // 3. Mobile-friendliness.
  if (!/<meta[^>]+name\s*=\s*["']viewport["']/i.test(h)) add('no_viewport', 'no <meta name="viewport"> — not mobile-friendly');

  // 4. Legacy markup. Layout tables need a width/border attribute to distinguish them from a
  // modern data table.
  const legacy = [];
  if (/\.swf\b/i.test(h) || /<embed[^>]+(?:flash|shockwave)/i.test(h)) legacy.push('Flash');
  if (/<font\b/i.test(h)) legacy.push('<font>');
  if (/<center\b/i.test(h)) legacy.push('<center>');
  if (/<table[^>]+(?:width|border|cellpadding|cellspacing)\s*=/i.test(h)) legacy.push('layout <table>');
  if (legacy.length) add('legacy_layout', `legacy markup: ${legacy.join(', ')}`);

  // 5. HTTPS — judged on the URL AFTER redirects, which is why httpText returns it.
  const effective = finalUrl || website || '';
  if (/^http:\/\//i.test(effective)) add('no_https', `served over plain http:// (${effective.slice(0, 60)})`);

  // 6. Stale footer copyright. Takes the LATEST year mentioned, so "2005-2019" reads as 2019.
  const years = [...h.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,24}((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)]
    .flatMap(m => [m[1], m[2]]).filter(Boolean).map(Number);
  if (years.length) {
    const latest = Math.max(...years);
    const cutoff = now.getFullYear() - 2;
    if (latest < cutoff) add('stale_copyright', `footer copyright reads ${latest} (more than 2 years old)`);
  }

  // 7. Basic SEO hygiene — a missing title or description is visible in every search result.
  const hasTitle = /<title[^>]*>\s*\S/i.test(h);
  const hasDesc = /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']\s*\S/i.test(h);
  if (!hasTitle || !hasDesc) {
    add('missing_title_or_desc', !hasTitle && !hasDesc ? 'no <title> and no meta description' : (!hasTitle ? 'no <title>' : 'no meta description'));
  }

  // 8. Builder. builderHits comes from detectAll(html, cfg.signatures) — HTML tokens, so it
  // fires on a custom domain where the URL shows nothing. A RESELLER platform (AGENCY_BUILDERS)
  // is never a penalty: it is agency evidence, recorded separately.
  const builder = builderHits.length ? builderHits[0].platform : null;
  if (builder && DATED_BUILDERS.has(builder)) {
    add('dated_builder', `built on ${builder} (${builderHits[0].evidence})`);
  }

  // 9. Ancient jQuery — a proxy for "nobody has touched this in a decade".
  const jq = h.match(/jquery[.\-/](1\.\d+(?:\.\d+)?)/i);
  if (jq) add('old_jquery', `jQuery ${jq[1]} (1.x is end-of-life)`);

  return finish(signals, builder, agencyEvidence(website, finalUrl, builderHits));
}

// "The seat is taken" evidence. NOT part of the score — the score answers "how bad is the site",
// this answers "is someone already paid to look after it". Recorded beside the score so a human
// can weigh it, exactly as rating_count is.
function agencyEvidence(website, finalUrl, builderHits = []) {
  const out = [];
  const builder = builderHits.length ? builderHits[0].platform : null;
  if (builder && AGENCY_BUILDERS.has(builder)) {
    out.push({ key: 'reseller_builder', evidence: `built on ${builder}, a platform sold and maintained by agencies` });
  }
  for (const u of [website, finalUrl]) {
    if (u && AGENCY_TRACKING.test(u)) {
      out.push({ key: 'campaign_tracking', evidence: `URL carries campaign tracking (${String(u).slice(0, 80)})` });
      break;
    }
  }
  return out;
}

function finish(signals, builder, agencySignals = []) {
  const score = Math.min(100, signals.reduce((s, x) => s + x.penalty, 0));
  return { score, signals, builder, agencySignals };
}

// The package a scored row implies. no website -> P1 (build one); a site scoring at/above the
// threshold -> P2 (rebuild). Anything else -> null: not a fit, do not invent a reason to call.
// P3 is NEVER assigned automatically — it is inactive and unpriced.
const P2_THRESHOLD = 40;
const UNREACHABLE_STRIKES_FOR_P1 = 2;
function recommendPackage({ hasWebsite, score, unreachableStrikes = 0 } = {}) {
  if (!hasWebsite) return 'P1';
  // A confirmed-dead site is P1, not P2: P2 is a REBUILD, and its deliverables include content
  // migration and a 301 redirect map from the old URLs. Neither exists for a site that will not
  // load. Requires TWO failed scans — a single 15-second timeout is not a dead business.
  if (unreachableStrikes >= UNREACHABLE_STRIKES_FOR_P1) return 'P1';
  if (typeof score === 'number' && score >= P2_THRESHOLD) return 'P2';
  return null;   // includes unscannable (score null) — never guess at a package we cannot justify
}

// Google PageSpeed Insights, mobile strategy. SECOND PASS ONLY — it is slow (10-30s per URL)
// and wasted on a site that already scored low, so the orchestrator calls it for rows already
// above the threshold. Its value is rhetorical: it is Google's verdict, not ours, which is the
// most persuasive line available in the outreach. Never throws; returns { error } instead.
const PSI_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
async function pageSpeedMobile(url, { apiKey, timeoutMs = 60000, deps = {} } = {}) {
  const httpJson = deps.httpJson || require('../../outbound/http').httpJson;
  const qs = new URLSearchParams({ url, strategy: 'mobile', category: 'performance' });
  if (apiKey) qs.set('key', apiKey);
  const r = await httpJson({ url: `${PSI_URL}?${qs}`, timeoutMs });
  if (r.error) return { error: r.error, status: r.status };
  const raw = r.data?.lighthouseResult?.categories?.performance?.score;
  if (typeof raw !== 'number') return { error: 'no performance score in response' };
  return { mobile_score: Math.round(raw * 100), fetched_at: new Date().toISOString() };
}

module.exports = { scoreSite, recommendPackage, pageSpeedMobile, agencyEvidence,
  PENALTY, P2_THRESHOLD, UNREACHABLE_STRIKES_FOR_P1, DATED_BUILDERS, AGENCY_BUILDERS, AGENCY_TRACKING };
