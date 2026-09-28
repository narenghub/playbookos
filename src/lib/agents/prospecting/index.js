// GolfNex prospecting ORCHESTRATOR — runProspecting(product). Modelled on
// research-intelligence/index.js: never-throws, per-tile error collection, a call cap, rate
// limiting, ON CONFLICT dedup, logAgentActivity on completion.
//
// For each tile (region × subtype) it paginates Places to the 60-result cap (3 pages),
// upserts ON CONFLICT (product, place_id) DO NOTHING, and records subtype + region on first
// insert. Tiles that still have a nextPageToken after 3 pages hit the cap and are reported —
// they hold >60 facilities and need finer subdivision.
//
// Flag-gated by PROSPECTING_ENABLED (default OFF → full no-op). No cron; manual trigger only.
// Does NOT qualify (booking-signature) or enrich (Apollo) — later steps. Collaborators are
// injectable via deps for hermetic tests.

const { query } = require('../../db');
const { logAgentActivity } = require('../../agent-core');
const { notify } = require('../../notify');
const places = require('./places');
const { tilesForProduct } = require('./tiles');
const { qualifyFacility } = require('./qualify');
const { getConfig } = require('./config');

const AGENT_NAME = 'prospecting';
const PAGE_CAP = 3; // Places New: 20/page, max 3 pages = 60 results per query

function envNum(env, name, def) { const n = Number(env[name]); return Number.isFinite(n) ? n : def; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runProspecting(product, { dryRun = false, deps = {} } = {}) {
  const env = deps.env || process.env;
  const summary = {
    product, enabled: true,
    tiles_run: 0, calls_made: 0,
    facilities_found: 0, new_facilities: 0, duplicates: 0,
    capped_tiles: [], dry_run: !!dryRun, errors: [],
  };

  // Master flag — OFF by default. No-op means no Places calls, no DB.
  if (String(env.PROSPECTING_ENABLED) !== 'true') { summary.enabled = false; return summary; }

  const tilesFn = deps.tilesForProduct || tilesForProduct;
  const tiles = tilesFn(product);
  if (!tiles.length) { summary.errors.push({ stage: 'config', error: `no tiles for product '${product}'` }); return summary; }

  // Per-product cap wins over the env var, which is GLOBAL — bounding one product's first run
  // via PROSPECTING_CALL_CAP would throttle every other product too. Guarded: only a positive
  // integer in config overrides, so products without callCap keep the env/default behaviour.
  const cfgCap = ((deps.getConfig || getConfig)(product) || {}).callCap;
  const callCap = (Number.isInteger(cfgCap) && cfgCap > 0) ? cfgCap : envNum(env, 'PROSPECTING_CALL_CAP', 300);
  const rateMs = envNum(env, 'PROSPECTING_RATE_MS', 200);
  const q = deps.query || query;
  const search = deps.searchText || places.searchText;
  const logActivity = deps.logAgentActivity || logAgentActivity;

  try {
    for (const tile of tiles) {
      if (summary.calls_made >= callCap) { summary.errors.push({ stage: 'call_cap', error: `call cap ${callCap} reached` }); break; }
      summary.tiles_run++;
      let token = null, page = 0, tileFailed = false;

      for (page = 0; page < PAGE_CAP; page++) {
        if (summary.calls_made >= callCap) { summary.errors.push({ stage: 'call_cap', error: `call cap ${callCap} reached mid-tile` }); tileFailed = true; break; }
        let res;
        try { res = await search(tile.query, { pageToken: token }); }
        catch (e) { res = { places: [], error: e && e.message ? e.message : String(e) }; } // defensive; search never throws
        summary.calls_made++;
        if (res.error) { summary.errors.push({ stage: 'search', tile: tile.query, error: res.error }); tileFailed = true; break; }

        for (const p of (res.places || [])) {
          if (!p.place_id || !p.name) continue;
          summary.facilities_found++;
          if (dryRun) { summary.new_facilities++; continue; }
          try {
            const ins = await q(
              `INSERT INTO prospects (product, place_id, name, address, phone, website, types, rating, rating_count, subtype, region, status, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new',NOW())
               ON CONFLICT (product, place_id) DO NOTHING
               RETURNING id`,
              [product, p.place_id, p.name, p.address, p.phone, p.website, p.types, p.rating, p.rating_count, tile.subtype, tile.region]
            );
            if (ins && ins.rows && ins.rows.length) summary.new_facilities++; else summary.duplicates++;
          } catch (e) { summary.errors.push({ stage: 'upsert', place_id: p.place_id, error: e && e.message ? e.message : String(e) }); }
        }

        token = res.nextPageToken || null;
        await sleep(rateMs);
        if (!token) break;
      }

      // Ran all 3 pages and STILL a token → >60 facilities for this tile → needs subdividing.
      if (!tileFailed && page >= PAGE_CAP && token) summary.capped_tiles.push(tile.query);
    }
  } catch (e) {
    summary.errors.push({ stage: 'run', error: e && e.message ? e.message : String(e) });
  }

  if (!dryRun) {
    try {
      await logActivity({
        agent_name: AGENT_NAME,
        action_type: 'enumerate',
        reasoning: `Google Places enumeration for ${product}`,
        output_summary: `tiles=${summary.tiles_run} calls=${summary.calls_made} found=${summary.facilities_found} `
          + `new=${summary.new_facilities} dup=${summary.duplicates} capped=${summary.capped_tiles.length} errors=${summary.errors.length}`,
      });
    } catch { /* logging must never break the run */ }
    if (summary.errors.length > 0) {   // agent_failed notification (never-throws)
      await notify({ product, kind: 'agent_failed', severity: 'error',
        title: `Prospecting: ${summary.errors.length} error${summary.errors.length === 1 ? '' : 's'} for ${product}`,
        body: summary.errors.slice(0, 3).map(e => `${e.stage}: ${e.error}`).join(' · '), link_page: 'prospects' }, { query: q });
    }
  }
  return summary;
}

// ── qualifier orchestrator step ─────────────────────────────────────────────────
// Qualify prospects that are status='new' with a website: run the booking-signature
// qualifier, write booking_platform + qualified_at, set status='qualified'. Never-throws;
// flag-gated by PROSPECTING_ENABLED; capped; rate-limited. Facilities with no website are
// left 'new' (nothing to scan). logAgentActivity on completion.
async function runQualifyProspects(product, { deps = {} } = {}) {
  const env = deps.env || process.env;
  const summary = { product, enabled: true, considered: 0, qualified: 0, with_platform: 0, no_platform: 0, reachable: 0, unreachable: 0, by_platform: {}, by_reason: {}, errors: [] };
  if (String(env.PROSPECTING_ENABLED) !== 'true') { summary.enabled = false; return summary; }

  // Resolve the product's domain config (signatures + booking-link terms). Unknown → error.
  const cfg = (deps.getConfig || getConfig)(product);
  if (!cfg) { summary.errors.push({ stage: 'config', error: `no config for product '${product}'` }); return summary; }

  const q = deps.query || query;
  const qualify = deps.qualifyFacility || qualifyFacility;
  const logActivity = deps.logAgentActivity || logAgentActivity;
  const cap = envNum(env, 'PROSPECTING_QUALIFY_CAP', 500);
  const rateMs = envNum(env, 'PROSPECTING_RATE_MS', 200);

  let rows;
  try {
    // Qualify anything not yet reachability-tagged: brand-new rows AND already-'qualified' rows
    // whose reachable is still null (the pre-reachability backfill population). This makes the
    // step self-healing — re-running it fills reachable/unreachable_reason on old rows.
    //
    // status <> 'rejected' is LOAD-BEARING, not tidiness. `reachable IS NULL` matches rejected
    // rows too, and the UPDATE below sets status='qualified' unconditionally — so without this
    // clause a qualify run silently resurrects every row rejected for geography, being a national
    // chain, or not being an agency, and discards the reject_reason that recorded why. It only
    // stayed hidden because golfnex and favly were qualified BEFORE they were rejected; a product
    // filtered first (linkabl) hits it on the first run.
    rows = (await q(
      `SELECT id, website FROM prospects
        WHERE product=$1 AND website IS NOT NULL
          AND status <> 'rejected'
          AND (status='new' OR reachable IS NULL)
        ORDER BY id LIMIT $2`, [product, cap])).rows;
  } catch (e) { summary.errors.push({ stage: 'select', error: e && e.message ? e.message : String(e) }); return summary; }

  for (const r of rows) {
    summary.considered++;
    let res;
    // orchestrator-level throw (injected qualifier misbehaves) → undetermined reachability (null),
    // so the row stays retryable on the next run rather than being falsely marked dead.
    try { res = await qualify(r.website, { signatures: cfg.signatures, bookingLinkTerms: cfg.bookingLinkTerms, deps }); }
    catch (e) { res = { platform: null, confidence: null, evidence: 'qualify threw: ' + (e && e.message ? e.message : String(e)), reachable: null, unreachableReason: null }; }
    const platform = res.platform || null;
    const reachable = res.reachable === true ? true : (res.reachable === false ? false : null);
    const reason = reachable === false ? (res.unreachableReason || null) : null;
    try {
      // The WHERE also re-checks status: a row rejected while this run was in flight (the loop
      // is rate-limited and can take minutes) must not be flipped back by a stale id.
      await q(`UPDATE prospects SET booking_platform=$1, reachable=$2, unreachable_reason=$3, qualified_at=NOW(), status='qualified' WHERE id=$4 AND status <> 'rejected'`,
        [platform, reachable, reason, r.id]);
      summary.qualified++;
      if (platform) { summary.with_platform++; summary.by_platform[platform] = (summary.by_platform[platform] || 0) + 1; }
      else summary.no_platform++;
      if (reachable === true) summary.reachable++;
      else if (reachable === false) { summary.unreachable++; summary.by_reason[reason || 'unknown'] = (summary.by_reason[reason || 'unknown'] || 0) + 1; }
    } catch (e) { summary.errors.push({ stage: 'update', id: r.id, error: e && e.message ? e.message : String(e) }); }
    await sleep(rateMs);
  }

  try {
    await logActivity({ agent_name: AGENT_NAME, action_type: 'qualify',
      reasoning: `Booking-signature qualification for ${product}`,
      output_summary: `considered=${summary.considered} qualified=${summary.qualified} with_platform=${summary.with_platform} no_platform=${summary.no_platform} reachable=${summary.reachable} unreachable=${summary.unreachable} errors=${summary.errors.length}` });
  } catch { /* logging must never break the run */ }
  if (summary.errors.length > 0) {   // agent_failed notification (never-throws)
    await notify({ product, kind: 'agent_failed', severity: 'error',
      title: `Qualifier: ${summary.errors.length} error${summary.errors.length === 1 ? '' : 's'} for ${product}`,
      body: summary.errors.slice(0, 3).map(e => `${e.stage}: ${e.error}`).join(' · '), link_page: 'prospects' }, { query: q });
  }
  return summary;
}

// ── site-quality scorer (ACBM) ─────────────────────────────────────────────────
// The ACBM equivalent of runQualifyProspects, and deliberately NOT the same function: the
// booking qualifier writes booking_platform, which would read as correct while holding "wix".
// This writes site_url / site_score / site_findings / recommended_package, plus the same
// reachable / unreachable_reason the qualifier uses (those mean exactly what they say).
//
// Never-throws, flag-gated, capped, rate-limited. Rows already rejected are skipped — the
// chain/franchise rejection passes run BEFORE this.
async function runScoreSites(product, { subtypes = null, cap = null, rescore = false, deps = {} } = {}) {
  const env = deps.env || process.env;
  const summary = { product, enabled: true, considered: 0, scored: 0, unscannable: 0, no_website: 0,
    unreachable: 0, agency_flagged: 0, p1: 0, p2: 0, no_fit: 0, by_builder: {}, score_bands: {}, errors: [] };
  if (String(env.PROSPECTING_ENABLED) !== 'true') { summary.enabled = false; return summary; }

  const cfg = (deps.getConfig || getConfig)(product);
  if (!cfg) { summary.errors.push({ stage: 'config', error: `no config for product '${product}'` }); return summary; }

  const q = deps.query || query;
  const fetchText = deps.httpText || require('../../outbound/http').httpText;
  const { scoreSite, recommendPackage } = deps.scorer || require('./site-score');
  const { detectAll } = deps.detector || require('./qualify');
  const logActivity = deps.logAgentActivity || logAgentActivity;
  const limit = Number.isInteger(cap) && cap > 0 ? cap : envNum(env, 'PROSPECTING_SCORE_CAP', 800);
  const rateMs = envNum(env, 'PROSPECTING_RATE_MS', 200);

  let rows;
  try {
    // status <> 'rejected' is load-bearing for the same reason as in the qualifier: a row
    // rejected as a chain must not be resurrected by a later pass.
    // site_findings comes along so a re-scan can read the prior unreachable strike count. NOTE
    // the selection condition: `site_score IS NULL` alone would re-scan every UNSCANNABLE (403)
    // row on each run, so an already-scanned row is skipped unless rescore is set.
    rows = (await q(
      `SELECT id, name, website, site_findings FROM prospects
        WHERE product=$1 AND status <> 'rejected'
          AND ($2::text[] IS NULL OR subtype = ANY($2))
          AND ($3::boolean OR (site_score IS NULL AND site_findings IS NULL))
        ORDER BY id LIMIT $4`, [product, subtypes, !!rescore, limit])).rows;
  } catch (e) { summary.errors.push({ stage: 'select', error: e && e.message ? e.message : String(e) }); return summary; }

  for (const r of rows) {
    summary.considered++;
    try {
      if (!r.website) {
        // Nothing to score. This is the P1 pool: they need a site built, not rebuilt.
        const findings = { scanned_at: new Date().toISOString(), no_website: true, signals: [], builder: null };
        await q(`UPDATE prospects SET site_score=NULL, site_findings=$2::jsonb, recommended_package='P1',
                   qualified_at=NOW(), status='qualified' WHERE id=$1 AND status <> 'rejected'`,
          [r.id, JSON.stringify(findings)]);
        summary.no_website++; summary.p1++;
        continue;
      }
      const res = await fetchText({ url: r.website });
      // httpText reports non-2xx as { error, status } but now also returns the body; error first.
      const reachable = !res.error;
      const unreachableReason = res.error ? (res.status === 403 ? '403' : classifyFetchReason(res)) : null;
      const html = res.text || '';
      const builderHits = html ? detectAll(html, cfg.signatures) : [];
      const out = scoreSite({
        html, finalUrl: res.url, website: r.website, reachable, unreachableReason, builderHits,
      });
      const { score, signals, builder, agencySignals, unscannable, unscannableReason } = out;
      // Strike count for genuinely-unreachable sites only: a 403 is unscannable, not dead, and a
      // reachable scan resets the count to 0.
      const prior = (r.site_findings && Number(r.site_findings.unreachable_strikes)) || 0;
      const isDead = reachable === false && unreachableReason !== '403';
      const strikes = isDead ? prior + 1 : 0;
      const findings = {
        scanned_at: new Date().toISOString(), final_url: res.url || r.website, score, signals,
        builder, builder_hits: builderHits, agency_signals: agencySignals || [],
        reachable, unreachable_reason: unreachableReason, unreachable_strikes: strikes,
        ...(unscannable ? { unscannable: true, unscannable_reason: unscannableReason } : {}),
      };
      const pkg = recommendPackage({ hasWebsite: true, score, unreachableStrikes: strikes });
      await q(`UPDATE prospects SET site_url=$2, site_score=$3, site_findings=$4::jsonb, recommended_package=$5,
                 reachable=$6, unreachable_reason=$7, qualified_at=NOW(), status='qualified'
               WHERE id=$1 AND status <> 'rejected'`,
        [r.id, res.url || r.website, score, JSON.stringify(findings), pkg, reachable, unreachableReason]);
      if (unscannable) summary.unscannable++;
      else summary.scored++;
      if (isDead) summary.unreachable++;
      if (builder) summary.by_builder[builder] = (summary.by_builder[builder] || 0) + 1;
      if ((agencySignals || []).length) summary.agency_flagged++;
      if (typeof score === 'number') {
        const band = score >= 60 ? '60+' : score >= 40 ? '40-59' : score >= 20 ? '20-39' : '0-19';
        summary.score_bands[band] = (summary.score_bands[band] || 0) + 1;
      }
      if (pkg === 'P2') summary.p2++; else if (pkg === 'P1') summary.p1++; else summary.no_fit++;
    } catch (e) { summary.errors.push({ stage: 'score', id: r.id, error: e && e.message ? e.message : String(e) }); }
    await sleep(rateMs);
  }

  try {
    await logActivity({ agent_name: AGENT_NAME, action_type: 'score_sites',
      reasoning: `Site-quality scoring for ${product}${subtypes ? ' (' + subtypes.join('+') + ')' : ''}`,
      output_summary: `considered=${summary.considered} scored=${summary.scored} noSite=${summary.no_website} p1=${summary.p1} p2=${summary.p2} noFit=${summary.no_fit} errors=${summary.errors.length}` });
  } catch { /* logging must never break the run */ }
  return summary;
}
// httpText's error strings mapped to the persisted vocabulary, mirroring qualify.classifyUnreachable.
function classifyFetchReason(r) {
  const err = (r && r.error) || '';
  if (r && r.timedOut) return 'timeout';
  if (typeof r.status === 'number' && r.status >= 400) return 'http_error';
  if (/request failed/i.test(err)) return 'dns';
  return 'empty';
}

// ── PageSpeed second pass ──────────────────────────────────────────────────────
// Runs ONLY on rows already at/above the P2 threshold, worst first. PSI is slow (10-30s/URL),
// so it is wasted on a site that already scored low, and it never changes site_score — it adds
// Google's own mobile number to site_findings.psi for the outreach to quote.
async function runPageSpeedPass(product, { subtypes = null, cap = 15, deps = {} } = {}) {
  const env = deps.env || process.env;
  const summary = { product, enabled: true, considered: 0, updated: 0, failed: 0, scores: [], errors: [] };
  if (String(env.PROSPECTING_ENABLED) !== 'true') { summary.enabled = false; return summary; }
  const q = deps.query || query;
  const { pageSpeedMobile, P2_THRESHOLD } = deps.scorer || require('./site-score');
  // EXPLICITLY DISABLED without a key rather than half-working. Keyless PSI returns HTTP 429
  // (the anonymous per-project quota is exhausted), so calling it would burn a minute per run to
  // write nothing. To enable: turn on the PageSpeed Insights API in Google Cloud project
  // instant-maxim-497102-k5, then set PAGESPEED_API_KEY in Railway.
  const apiKey = env.PAGESPEED_API_KEY || null;
  if (!apiKey) { summary.enabled = false; summary.skipped = 'PAGESPEED_API_KEY not configured — second pass disabled (keyless PSI is 429-quota-blocked)'; return summary; }
  let rows;
  try {
    rows = (await q(
      `SELECT id, name, site_url, site_score FROM prospects
        WHERE product=$1 AND status='qualified' AND site_score >= $2 AND site_url IS NOT NULL
          AND ($3::text[] IS NULL OR subtype = ANY($3))
          AND NOT (site_findings ? 'psi')
        ORDER BY site_score DESC, id LIMIT $4`, [product, P2_THRESHOLD, subtypes, cap])).rows;
  } catch (e) { summary.errors.push({ stage: 'select', error: e && e.message ? e.message : String(e) }); return summary; }

  for (const r of rows) {
    summary.considered++;
    const psi = await pageSpeedMobile(r.site_url, { apiKey, deps });
    if (psi.error) { summary.failed++; summary.errors.push({ id: r.id, error: psi.error }); continue; }
    try {
      await q(`UPDATE prospects SET site_findings = jsonb_set(COALESCE(site_findings,'{}'::jsonb), '{psi}', $2::jsonb, true) WHERE id=$1`,
        [r.id, JSON.stringify(psi)]);
      summary.updated++; summary.scores.push({ name: r.name, site_score: r.site_score, psi_mobile: psi.mobile_score });
    } catch (e) { summary.errors.push({ stage: 'update', id: r.id, error: e && e.message ? e.message : String(e) }); }
  }
  return summary;
}

module.exports = { runProspecting, runQualifyProspects, runScoreSites, runPageSpeedPass, AGENT_NAME };
