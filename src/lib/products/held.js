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
const { GRANTABLE } = require('./route-map');

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

// ── SUPER ADMIN HOLDS EVERYTHING, BY ROLE ─────────────────────────────────────
//
// Not a convenience. The failure it prevents: add a seventh product tomorrow and nobody holds it, so the
// person who just created it is locked out of his own new product until somebody grants it to him — and
// the only account that can grant it is the one that is locked out. Every new product would start with
// that five-minute puzzle.
//
// It is safe in a way a role-based bypass usually is not, because super_admin ALREADY holds every
// registry feature (templates.js rule 3) and every route gate. There is no route the boundary is keeping
// it out of that the other two layers would not admit it to, so the bypass removes a lockout without
// removing a protection. For every other role the boundary is the independent second gate it was built
// to be — see the block comment at the top of boundary.js about role and products disagreeing on purpose.
//
// Derived from GRANTABLE so a new product is covered the moment it is added to the map, which is the
// whole point.
const SUPER_ROLE = 'super_admin';

// What a caller effectively holds, given a role we already trust. Used by /auth/me, where authMiddleware
// has already rebuilt req.user from the users row.
async function effectiveProducts(user, deps = {}) {
  if (user && user.role === SUPER_ROLE) return GRANTABLE.slice();
  return heldProducts(user && user.id, deps);
}

// The same answer for a caller whose role we do NOT yet trust — the product boundary runs before
// authMiddleware, so all it has is the token, and a token's role can be stale by up to seven days.
//
// Taking the bypass from the token would reintroduce exactly the bug that made the Edit button fail: a
// user demoted out of super_admin would keep the boundary bypass until their token expired. So the role is
// read from the users row, in the SAME query as the products — one round trip, not two, and no more than
// the single query this replaced.
//
// Returns [] when the row is missing, which narrows rather than widens.
async function effectiveProductsById(userId, deps = {}) {
  const q = deps.query || defaultQuery;
  if (!userId) return [];
  try {
    const r = await q(
      `SELECT u.role,
              COALESCE(ARRAY(SELECT p.product FROM user_products p WHERE p.user_id = u.id), '{}') AS products
         FROM users u WHERE u.id = $1`, [userId]);
    const row = r.rows[0];
    if (!row) return [];
    return row.role === SUPER_ROLE ? GRANTABLE.slice() : (row.products || []);
  } catch (e) { return []; }
}

module.exports = { heldProducts, effectiveProducts, effectiveProductsById, productScopeSql, SUPER_ROLE };
