// PlaybookOS — Permission Resolver SHADOW MODE (P3 step 2)
//
// Observes, never decides. The existing Express gate (authMiddleware / requireTier /
// adminOnly / in-handler checks) remains the SOLE authority on every request. This hook
// runs AFTER the response is finished, asks the resolver what IT would have decided, and
// records only the DISAGREEMENTS to permission_shadow_log. It never touches the response.
//
// Hard contract:
//   • never changes a response (it only reads res.statusCode, on the 'finish' event)
//   • never throws — the entire path is wrapped; a resolver error, an unmapped route, or a
//     DB write failure is swallowed so a shadow bug can never break a live request
//   • env-gated by PERMISSIONS_SHADOW_ENABLED (default OFF). With it off, mount() adds no
//     middleware, so ZERO shadow code runs per request.
//   • the log write is fire-and-forget; the response is never blocked on it.
//
// Wire-in (server.js, before the router):  require('./src/lib/permissions/shadow').mount(app)

const { FEATURES } = require('./registry');

// Lazy so that, when shadow is disabled, requiring this module never pulls in db/resolve.
let _resolve = null, _query = null;
function resolveFn() { if (!_resolve) _resolve = require('./resolve').resolve; return _resolve; }
function queryFn() { if (!_query) _query = require('../db').query; return _query; }

// ── request → feature_key matcher ─────────────────────────────────────────────
// Only features whose ref is an HTTP route (api_route + the 9 mission-control runs).
// nav_page (ref=page id) and cron (ref=cron key) refs are not HTTP routes.
const HTTP_REF = /^(GET|POST|PUT|DELETE|PATCH) (\/api\/\S*)$/;
function toRegex(apiPath) {
  const parts = apiPath.split('/').map(seg =>
    seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + parts.join('/') + '$');
}
// Built once, in registry (= route-definition) order, so a literal route defined before a
// param route (e.g. /inquiry/dashboard before /inquiry/:id) wins the first-match, exactly
// as Express itself resolves it.
const MATCHERS = [];
for (const f of FEATURES) {
  const m = f.ref && f.ref.match(HTTP_REF);
  if (!m) continue;
  MATCHERS.push({ method: m[1], rx: toRegex(m[2]), key: f.key });
}
function mapFeatureKey(method, path) {
  for (const m of MATCHERS) if (m.method === method && m.rx.test(path)) return m.key;
  return null;
}

// ── fire-and-forget log write (never throws, never awaited by the response) ────
function fireInsert(query, row) {
  try {
    const p = query(
      `INSERT INTO permission_shadow_log
         (user_id, role, feature_key, method, path, gate_decision, resolver_decision, resolver_rule, resolver_explain)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.user_id, row.role || null, row.feature_key || null, row.method, row.path,
       row.gate_decision, row.resolver_decision, row.resolver_rule == null ? null : row.resolver_rule,
       row.resolver_explain || null]
    );
    if (p && typeof p.catch === 'function') p.catch(() => {}); // swallow async failure
  } catch (_) { /* swallow sync failure */ }
}

// ── the observation (runs on res 'finish'; fully guarded) ─────────────────────
async function observe(req, res, deps = {}) {
  try {
    if (process.env.PERMISSIONS_SHADOW_ENABLED !== 'true') return; // defensive re-check
    if (!req || !req.user || !req.user.id) return;                 // only authenticated requests
    const resolve = deps.resolve || resolveFn();
    const query = deps.query || queryFn();

    const method = req.method;
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const status = Number(res.statusCode);
    // "what the gate actually did" = the effective access outcome, incl. in-handler auth:
    // 401/403 == denied, anything else == the request was allowed through.
    const gate_decision = (status === 401 || status === 403) ? 'deny' : 'allow';

    const feature_key = mapFeatureKey(method, path);
    if (!feature_key) {
      // registry gap — always recorded as its own case, never skipped silently
      fireInsert(query, { user_id: req.user.id, role: req.user.role, feature_key: null, method, path,
        gate_decision, resolver_decision: 'unmapped_route', resolver_rule: null,
        resolver_explain: 'no registry feature matches METHOD + path' });
      return;
    }

    let r;
    try {
      r = await resolve(req.user, feature_key);
    } catch (e) {
      fireInsert(query, { user_id: req.user.id, role: req.user.role, feature_key, method, path,
        gate_decision, resolver_decision: 'error', resolver_rule: null,
        resolver_explain: 'resolver threw: ' + (e && e.message ? e.message : String(e)) });
      return;
    }

    const resolver_decision = r.allowed ? 'allow' : 'deny';
    if (resolver_decision === gate_decision) return; // agreement — log nothing

    fireInsert(query, { user_id: req.user.id, role: req.user.role, feature_key, method, path,
      gate_decision, resolver_decision, resolver_rule: r.rule, resolver_explain: r.explain });
  } catch (_) { /* never-throws contract */ }
}

// ── middleware: attaches the finish listener, never alters the response ────────
function shadowMiddleware(req, res, next) {
  try {
    res.on('finish', () => { observe(req, res).catch(() => {}); });
  } catch (_) { /* if res has no .on, skip silently */ }
  next();
}

// ── mount: adds the middleware ONLY when the flag is on ────────────────────────
function mount(app) {
  if (process.env.PERMISSIONS_SHADOW_ENABLED !== 'true') {
    console.log('[permissions-shadow] disabled (PERMISSIONS_SHADOW_ENABLED != true) — no observer mounted');
    return false;
  }
  app.use('/api', shadowMiddleware);
  console.log('[permissions-shadow] ENABLED — observing resolver vs gate (no enforcement)');
  return true;
}

module.exports = { mount, shadowMiddleware, observe, mapFeatureKey, fireInsert, MATCHERS };
