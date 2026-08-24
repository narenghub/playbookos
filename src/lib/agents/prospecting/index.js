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
const places = require('./places');
const { tilesForProduct } = require('./tiles');

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
  }
  return summary;
}

module.exports = { runProspecting, AGENT_NAME };
