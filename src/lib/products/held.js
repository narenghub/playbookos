// PlaybookOS — what a user holds, for HANDLERS that must scope their DATA.
//
// The product boundary decides whether a REQUEST may reach a route. It deliberately does not touch
// req.user and does not filter rows. That is the right split, but it leaves a second job that only a
// handler can do: a route can be legitimately 'shared' — safe for anyone with a login — while the
// TABLE behind it carries a product column and must not be shown across products.
//
// `notifications` is the case that proved it: the route is genuinely shared (everyone needs their own
// alerts), but the table has a `product` column and no user_id, so an unscoped read handed every
// logged-in user every other product's agent failures, and read-all marked everyone's rows read.
// Classifying the route 'internal' would have been the wrong fix — it would hide a product's own
// alerts from the people running that product. The route IS shared; the DATA needed scoping. Those
// are different problems, and conflating them is what produced the gap.
//
// NULL product is treated as PLATFORM-WIDE and requires the 'internal' pseudo-product: a cron failure
// or a schema alert is not attributable to a product, and is staff business. Every internal user holds
// 'internal' from the backfill, so this preserves today's behaviour exactly while containing a partner
// account automatically.

const { query: defaultQuery } = require('../db');

// Products a user holds, as a plain array. Never throws: an empty array is the safe answer, because
// every caller uses it to NARROW a query.
async function heldProducts(userId, deps = {}) {
  const q = deps.query || defaultQuery;
  if (!userId) return [];
  try {
    const r = await q(`SELECT product FROM user_products WHERE user_id = $1`, [userId]);
    return r.rows.map(x => x.product);
  } catch (e) { return []; }
}

// A SQL fragment + params that scope any product-bearing table to what the caller holds.
//   const scope = productScopeSql(held, 'notifications', 1);
//   `... WHERE ${scope.sql}`, [...scope.params]
// `startIndex` is the first $n to use, so it composes with a query that already has parameters.
function productScopeSql(held, alias = '', startIndex = 1) {
  const col = alias ? `${alias}.product` : 'product';
  const hasInternal = (held || []).includes('internal');
  // A holder of nothing matches nothing — not everything. This is the direction that fails safe.
  return {
    sql: `(${col} = ANY($${startIndex})${hasInternal ? ` OR ${col} IS NULL` : ''})`,
    params: [held || []],
    nextIndex: startIndex + 1,
    hasInternal,
  };
}

module.exports = { heldProducts, productScopeSql };
