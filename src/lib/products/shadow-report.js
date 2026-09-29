// PRODUCT BOUNDARY — the shadow read, as a report that files itself.
//
// Runs INSIDE the app (a cron in server.js) rather than as a cloud routine, because the data is
// only reachable from here: DATABASE_URL points at postgres.railway.internal, which nothing outside
// the container can resolve, and there is no public URL variable. A cloud agent would fire and fail.
//
// HOW TO READ THE RESULT — this is the whole point of the wide backfill, so the report says it
// itself rather than trusting whoever opens it to remember:
//   • every existing user holds every product, so would_block MUST be 0
//   • a non-zero would_block is a MIDDLEWARE BUG, not a finding that some user lacks access
//   • unresolved rows are the other thing to hunt: a route pattern that failed to match a concrete
//     URL, which would 403 the moment mode=enforce
//
// Self-retiring: the cron skips when PRODUCT_BOUNDARY_MODE is not 'shadow', so it stops on its own
// once enforcement is decided instead of becoming a daily message nobody reads.

const { query: defaultQuery } = require('../db');

async function productShadowReport({ hours = 24, deps = {} } = {}) {
  const q = deps.query || defaultQuery;
  const since = `NOW() - INTERVAL '${Number(hours) || 24} hours'`;

  const totals = (await q(
    `SELECT COUNT(*)::int evaluated,
            COUNT(*) FILTER (WHERE would_block)::int would_block,
            COUNT(*) FILTER (WHERE resolved_product IS NULL)::int unresolved,
            COUNT(DISTINCT user_id)::int users,
            MIN(created_at) first_seen, MAX(created_at) last_seen
       FROM product_shadow_log WHERE created_at >= ${since}`)).rows[0];

  const byProduct = (await q(
    `SELECT COALESCE(resolved_product, '(unresolved)') AS product, COUNT(*)::int n
       FROM product_shadow_log WHERE created_at >= ${since}
      GROUP BY 1 ORDER BY 2 DESC`)).rows;

  // Unresolved rows, grouped by the path that produced them — the fix is per-route, so the paths
  // are what matter, not the count.
  const unresolvedPaths = (await q(
    `SELECT method, path, COUNT(*)::int n, MAX(created_at) last_seen
       FROM product_shadow_log
      WHERE created_at >= ${since} AND resolved_product IS NULL
      GROUP BY 1,2 ORDER BY 3 DESC LIMIT 25`)).rows;

  // would_block detail. Expected to be empty; if it is not, this is what to debug.
  const blocks = (await q(
    `SELECT method, path, resolved_product, role, user_products, COUNT(*)::int n
       FROM product_shadow_log
      WHERE created_at >= ${since} AND would_block
      GROUP BY 1,2,3,4,5 ORDER BY 6 DESC LIMIT 25`)).rows;

  // Did the row-lookup routes actually exercise? Their absence is a finding in itself: it means
  // nobody opened a prospect detail, so the riskiest resolution path is still unproven.
  const rowRoutes = (await q(
    `SELECT method, path, resolved_product, COUNT(*)::int n
       FROM product_shadow_log
      WHERE created_at >= ${since} AND path ~ '^/api/prospects/[0-9]+$'
      GROUP BY 1,2,3 ORDER BY 4 DESC`)).rows;

  const verdict = totals.evaluated === 0
    ? 'NO DATA — nothing authenticated hit the app in this window, so the map is still unproven.'
    : totals.would_block > 0
      ? `STOP AND FIX — ${totals.would_block} would_block in ${totals.evaluated} requests. Every user holds every product, so this is a MIDDLEWARE BUG, not a user lacking access.`
      : totals.unresolved > 0
        ? `MAP GAP — 0 would_block (correct) but ${totals.unresolved} request(s) resolved to NO product. Those would 403 under enforce. Fix the map before enforcing.`
        : `CLEAN — ${totals.evaluated} requests evaluated, 0 would_block, 0 unresolved. The map held for everything that was actually called.`;

  return { hours, totals, byProduct, unresolvedPaths, blocks, rowRoutes, verdict };
}

// A compact, readable summary for agent_activity_log / a notification body.
function formatShadowReport(r) {
  const t = r.totals || {};
  const lines = [];
  lines.push(`${r.verdict}`);
  lines.push(`evaluated=${t.evaluated} would_block=${t.would_block} unresolved=${t.unresolved} distinct_users=${t.users}`);
  if ((r.byProduct || []).length) lines.push('products: ' + r.byProduct.map(p => `${p.product}=${p.n}`).join(' '));
  if ((r.rowRoutes || []).length) lines.push('row-lookup routes exercised: ' + r.rowRoutes.map(x => `${x.method} ${x.path}->${x.resolved_product || 'null'}(${x.n})`).join(' '));
  else lines.push('row-lookup routes: NOT exercised — /api/prospects/:id was never called, so that path is unproven');
  if ((r.unresolvedPaths || []).length) lines.push('unresolved paths: ' + r.unresolvedPaths.map(x => `${x.method} ${x.path} x${x.n}`).join(' · '));
  if ((r.blocks || []).length) lines.push('would_block: ' + r.blocks.map(x => `${x.method} ${x.path} product=${x.resolved_product} role=${x.role} x${x.n}`).join(' · '));
  return lines.join('\n');
}

module.exports = { productShadowReport, formatShadowReport };
