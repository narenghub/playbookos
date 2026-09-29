// PlaybookOS — PRODUCT BOUNDARY, part 3: the middleware.
//
// A SECOND, INDEPENDENT gate. The existing role/tier gate keeps deciding what it always decided;
// this one additionally asks "does this caller hold the product this route belongs to?". Two gates
// that fail independently is the point: a tier granted by mistake must not be sufficient to become
// a data exposure.
//
// MODES — env PRODUCT_BOUNDARY_MODE, default 'shadow'. A kill switch that needs no deploy:
//   off      middleware does nothing at all. No logging, no evaluation.
//   shadow   evaluate, LOG EVERY REQUEST, never block. This is the default and where we start.
//   enforce  evaluate, log, and 403 when the caller lacks the product — or when the product
//            cannot be resolved (FAIL CLOSED).
//
// FAIL CLOSED, in enforce mode only. The completeness test guarantees the map is total, so an
// unresolvable product at runtime means the map and the routes have diverged, which is exactly the
// moment to stop rather than continue. The costs are asymmetric in the direction that decides it:
// fail-closed fails loudly and immediately — someone internal is locked out, says so, and it is
// fixed in minutes — while fail-open fails silently and is discovered when an outside account has
// been reading Apollo for a month. Same discipline as enforce.js rule 8 (no match = deny).
//
// SHADOW LOGGING records EVERY evaluated request, not only would-blocks. Without the denominator
// the result is unreadable: zero blocks across 3 requests means nothing; across 40,000 it means the
// map is right. Writes are fire-and-forget and can never delay or fail a request.
//
// Anonymous requests (no valid token) are NOT evaluated: there is no user, so there are no
// products, and the downstream authMiddleware is what should reject them. Evaluating here would
// bury the real 401 under a product 403.

// ── ROLE AND PRODUCTS DISAGREE ON PURPOSE. DO NOT "FIX" IT BY WIDENING PRODUCTS. ──
//
// If you are here because somebody said "Prasanthi is an admin but gets 403 on the Reorder Agent", that is
// the system working. Read this before changing anything.
//
// The two gates answer different questions and are meant to disagree:
//
//   ROLE / TIER        "is this KIND of user allowed to do this KIND of thing?"
//                      admin's template grants nearly every feature, because an admin is trusted with the
//                      CAPABILITY.
//   PRODUCT BOUNDARY   "which BUSINESS's data is this?"
//                      prasanthi@adificetechnologies.com holds [abiozen, golfnex, internal], so linkabl,
//                      favly, aros and acbm data is refused — however senior her role is.
//
// So a broad role plus narrow products is the NORMAL, INTENDED state, and the 403s that produces are the
// point of having a second gate. The whole value of the boundary is that a tier granted by mistake — the
// most likely permissions error there is, since tiers are coarse and granted by hand — cannot become a
// cross-product data exposure. If holding a role implied holding its products, there would be one gate
// wearing two names.
//
// THE WRONG FIXES, in the order somebody will reach for them:
//   1. granting the missing products to "make the role consistent" — this removes the boundary for that
//      person while leaving the code that looks like it is still there
//   2. having the boundary consult the role — same thing, for everybody at once
//   3. deriving products from the role — that is what the nav used to do, and it is why several roles
//      could see products they had no business in
//
// THE RIGHT FIX, when a 403 is genuinely wrong: grant that ONE product to that ONE person, deliberately,
// through the team page — which records who did it and when (user_product_grants_log).
//
// Products are assigned per PERSON by a super admin, not derived from anything. Roles say what you may
// do; products say whose data you may do it to.

const jwt = require('jsonwebtoken');
const { resolveProduct } = require('./resolve-product');
const { query: defaultQuery } = require('../db');

const MODES = new Set(['off', 'shadow', 'enforce']);
function boundaryMode(env = process.env) {
  const m = String(env.PRODUCT_BOUNDARY_MODE || 'shadow').toLowerCase().trim();
  return MODES.has(m) ? m : 'shadow';
}

// Read the caller from the JWT without touching req.user — authMiddleware still runs downstream
// and remains the authority on identity. Read-only, never throws.
function callerFromToken(req, env = process.env) {
  try {
    const h = req.headers && req.headers.authorization;
    if (!h || !/^Bearer /i.test(h)) return null;
    const decoded = jwt.verify(h.replace(/^Bearer /i, '').trim(), env.JWT_SECRET);
    return decoded && decoded.id ? { id: decoded.id, role: decoded.role || null } : null;
  } catch { return null; }
}

function productBoundary(deps = {}) {
  const env = deps.env || process.env;
  const q = deps.query || defaultQuery;

  const lookupRowProduct = deps.lookupRowProduct || (async (table, column, id) => {
    // Table/column come from the code-defined map and are allowlisted in resolve-product.js; the
    // id is the only caller-supplied value and is parameterised.
    const r = await q(`SELECT ${column} AS product FROM ${table} WHERE id = $1`, [id]);
    return (r.rows[0] && r.rows[0].product) || null;
  });

  const heldProducts = deps.heldProducts || (async (userId) => {
    const r = await q(`SELECT product FROM user_products WHERE user_id = $1`, [userId]);
    return r.rows.map(x => x.product);
  });

  const logShadow = deps.logShadow || ((row) => {
    q(`INSERT INTO product_shadow_log (user_id, role, method, path, resolved_product, user_products, would_block)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.user_id, row.role, row.method, row.path, row.resolved_product, row.user_products, row.would_block])
      .catch(() => { /* logging must never affect a request */ });
  });

  return async function productBoundaryMiddleware(req, res, next) {
    const mode = boundaryMode(env);
    if (mode === 'off') return next();
    try {
      const caller = callerFromToken(req, env);
      if (!caller) return next();               // anonymous → authMiddleware's problem, not ours

      const { product, via, unresolved } = await resolveProduct(req, { lookupRowProduct });
      const held = await heldProducts(caller.id);
      // 'shared' is held by everyone with a login by definition — it is not a grant.
      const allowed = product === 'shared' ? true : (product ? held.includes(product) : false);
      const wouldBlock = !allowed;

      logShadow({
        user_id: caller.id, role: caller.role, method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
        resolved_product: product, user_products: held, would_block: wouldBlock,
      });

      if (wouldBlock) {
        const why = unresolved ? 'product could not be resolved' : `caller does not hold '${product}'`;
        console.warn(`[product-boundary] ${mode === 'enforce' ? 'BLOCK' : 'would block'} user=${caller.id} role=${caller.role} ${req.method} ${req.path} — ${why} · via ${via.join(' → ')}`);
        if (mode === 'enforce') {
          return res.status(403).json({
            error: 'Forbidden by product boundary',
            resolved_product: product,
            reason: unresolved ? 'unresolved' : 'not_held',
          });
        }
      }
      return next();
    } catch (e) {
      // A bug in THIS middleware must not take the app down. In shadow it is a no-op either way;
      // in enforce, an internal failure is still a failure to establish the boundary, so it denies
      // — stated explicitly rather than falling through by accident.
      try { console.error('[product-boundary] evaluation error:', e && e.message); } catch (_) {}
      if (boundaryMode(env) === 'enforce') {
        return res.status(403).json({ error: 'Forbidden by product boundary', reason: 'evaluation_error' });
      }
      return next();
    }
  };
}

module.exports = { productBoundary, boundaryMode, callerFromToken, MODES };
