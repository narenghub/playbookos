// PlaybookOS — Permission Resolver ENFORCEMENT (P3 step 3, STAGED per-role)
//
// Runs BEFORE the route handlers. For a user whose role is listed in
// PERMISSIONS_ENFORCE_ROLES (comma-separated), the RESOLVER is the authority: if it DENIES
// the feature mapped from METHOD+path, this middleware returns 403 and the handler never
// runs. For every other role — and when the list is empty — this middleware is a no-op and
// the existing gate (authMiddleware / requireTier / adminOnly / in-handler checks) remains
// the sole authority. Enforcement is applied PER ROLE, never globally.
//
// Hard contract:
//   • Never-throws / FAIL OPEN: ANY error for an enforced role (resolver throw, decode
//     failure, unexpected bug) falls through to next() so the EXISTING gate decides. An
//     enforcement bug must never lock users out. Every fail-open is logged loudly.
//   • Tighten-only: a resolver "allow" just calls next(); the existing gate then still runs
//     and may independently 403. So enforcement can only ADD denials, never remove a denial
//     the old gate imposes. (The coverage matrix shows ZERO expands across all 13 roles, so
//     resolver-allow always coincides with gate-allow — for all real traffic this is exactly
//     "resolver decides", and it can never grant a role more than the gate already would.)
//   • Reads the role by verifying the JWT itself (read-only). It does NOT set req.user or
//     touch the DB — the downstream authMiddleware still runs normally (last_login, 401 for
//     missing/invalid tokens). Anonymous / bad-token requests fall straight through to it.
//   • Unmapped routes (no registry feature for METHOD+path) fall through to the gate — we
//     never block a route the resolver can't reason about.
//   • env-gated by PERMISSIONS_ENFORCE_ROLES. Empty/unset = enforce nothing (mount still adds
//     the middleware, but it no-ops on every request = zero behaviour change).
//   • The shadow observer (shadow.js) is independent and keeps observing ALL roles regardless
//     — enforced and unenforced roles are both still recorded.
//
// On deny the 403 body carries { feature_key, rule } so a blocked user can report exactly
// what the resolver denied and by which precedence rule.
//
// Wire-in (server.js, before the router):
//   require('./src/lib/permissions/enforce').mount(app)

const { mapFeatureKey } = require('./shadow'); // shared METHOD+path → feature_key matcher

// Lazy so importing this module never eagerly pulls in resolve/db/core.
let _resolve = null, _verify = null, _query = null;
function resolveFn() { if (!_resolve) _resolve = require('./resolve').resolve; return _resolve; }
function verifyTokenFn() { if (!_verify) _verify = require('../core').verifyToken; return _verify; }
function queryFn() { if (!_query) _query = require('../db').query; return _query; }

// ── fire-and-forget denial log write ───────────────────────────────────────────
// Records every enforcement 403 to permission_enforce_denials. Same hard contract as the
// shadow hook's fireInsert: NEVER throws and is NEVER awaited by the response, so a failed
// (or slow) write can never affect the 403 or the request. Sync and async failures are both
// swallowed. Table/index live in scripts/migrate-enforce-denials.js (run manually).
function fireDenial(query, row) {
  try {
    const p = query(
      `INSERT INTO permission_enforce_denials
         (user_id, role, feature_key, method, path, resolver_rule, resolver_explain)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.user_id || null, row.role || null, row.feature_key || null, row.method, row.path,
       row.resolver_rule == null ? null : row.resolver_rule, row.resolver_explain || null]
    );
    if (p && typeof p.catch === 'function') p.catch(() => {}); // swallow async failure
  } catch (_) { /* swallow sync failure */ }
}

// PERMISSIONS_ENFORCE_ROLES="admin, business_dev" → Set{'admin','business_dev'}. Read fresh
// per request (cheap) so the resolver-fresh philosophy holds and tests can inject deps.env.
function parseRoles(raw) {
  return new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean));
}

// Verify the bearer token read-only to learn the caller's role. No side effects, never throws.
function decodeUser(req, deps = {}) {
  try {
    const verify = deps.verifyToken || verifyTokenFn();
    const auth = (req.headers && req.headers.authorization) || '';
    const token = auth.replace('Bearer ', '');
    if (!token) return null;
    return verify(token); // { id, email, role } or null
  } catch (_) { return null; }
}

// ── the enforcement middleware (fully guarded, fails open) ─────────────────────
async function enforceMiddleware(req, res, next, deps = {}) {
  try {
    const env = deps.env || process.env;
    const roles = parseRoles(env.PERMISSIONS_ENFORCE_ROLES);
    if (roles.size === 0) return next(); // nothing enforced → zero behaviour change

    // req.user isn't populated yet at this mount point (authMiddleware runs inside the route
    // stack), so derive the role from the token. Prefer an already-set req.user if present.
    const user = req.user || decodeUser(req, deps);
    if (!user || !user.role || !roles.has(user.role)) return next(); // unenforced/anon → gate decides

    const method = req.method;
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const mapFn = deps.mapFeatureKey || mapFeatureKey;
    const feature_key = mapFn(method, path);
    if (!feature_key) return next(); // unmapped route — resolver can't reason; gate decides

    const resolve = deps.resolve || resolveFn();
    let r;
    try {
      r = await resolve(user, feature_key);
    } catch (e) {
      // FAIL OPEN — resolver errored for an enforced role. Existing gate decides. Log loudly.
      console.error(`[permissions-enforce] FAIL-OPEN role=${user.role} feature=${feature_key} ${method} ${path} — resolver threw: ${e && e.message ? e.message : String(e)}`);
      return next();
    }

    if (r && r.allowed) return next(); // ALLOW → the existing gate still runs after us

    // DENY — block before the handler. Body names the feature and the precedence rule.
    const rule = r ? r.rule : null;
    const explain = r ? (r.explain || null) : null;
    // Loud log (Railway) + durable denial record — both fire-and-forget; neither can affect
    // or delay the 403 (fireDenial is never awaited and never throws).
    try { console.warn(`[permissions-enforce] DENY role=${user.role} user=${user.id} feature=${feature_key} rule=${rule} ${method} ${path}`); } catch (_) {}
    fireDenial(deps.query || queryFn(), {
      user_id: user.id, role: user.role, feature_key, method, path,
      resolver_rule: rule, resolver_explain: explain,
    });
    return res.status(403).json({
      error: 'Forbidden by permission resolver',
      feature_key,
      rule,
      explain,
    });
  } catch (e) {
    // Never-throws: any unexpected error fails open to the existing gate.
    try { console.error('[permissions-enforce] FAIL-OPEN (unexpected) — ' + (e && e.message ? e.message : String(e))); } catch (_) {}
    return next();
  }
}

// ── mount: adds the middleware at /api, before the router ──────────────────────
function mount(app, deps = {}) {
  const wrapped = (req, res, next) => enforceMiddleware(req, res, next, deps);
  app.use('/api', wrapped);
  const roles = parseRoles(((deps.env || process.env)).PERMISSIONS_ENFORCE_ROLES);
  console.log(roles.size
    ? `[permissions-enforce] ENABLED — resolver decides for roles: ${[...roles].join(', ')} (all other roles keep the existing gate)`
    : '[permissions-enforce] mounted; PERMISSIONS_ENFORCE_ROLES empty — enforcing nothing (zero behaviour change)');
  return true;
}

module.exports = { mount, enforceMiddleware, parseRoles, decodeUser, fireDenial };
