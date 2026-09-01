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

  const callCap = envNum(env, 'PROSPECTING_CALL_CAP', 300);
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
    rows = (await q(
      `SELECT id, website FROM prospects
        WHERE product=$1 AND website IS NOT NULL AND (status='new' OR reachable IS NULL)
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
      await q(`UPDATE prospects SET booking_platform=$1, reachable=$2, unreachable_reason=$3, qualified_at=NOW(), status='qualified' WHERE id=$4`,
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

module.exports = { runProspecting, runQualifyProspects, AGENT_NAME };
