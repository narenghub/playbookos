// PlaybookOS — PRODUCT BOUNDARY, part 2: resolving a request to ONE product.
//
//   resolveProduct(req, { lookupRowProduct }) -> { product, via, unresolved }
//
// `product` is always a CONCRETE grantable name ('abiozen' … 'acbm', or the pseudo-products
// 'shared' / 'internal'), or null when it cannot be determined. Never an intermediate marker:
// 'param:product' and 'param:agent' are instructions to keep resolving, not answers, and
// comparing either literal against user_products would compare a sentinel to a grant and quietly
// let everything through. Resolution is therefore a small loop with a depth cap.
//
// null is the FAIL-CLOSED case. The completeness test guarantees the map is total, so an
// unresolved product at runtime means the map and the routes have diverged — precisely the moment
// to stop rather than continue.

const { classifyRoute, AGENT_PRODUCT, PARAM_DEFAULT, ROW_FORM, GRANTABLE } = require('./route-map');

const MAX_HOPS = 4;
// Only these tables may be consulted by a `row:` value. The map is code, not user input, but an
// allowlist means a typo fails closed instead of reaching the database with a bad identifier.
const ROW_TABLES = { prospects: 'product', acbm_deals: null };

// The map is keyed on ROUTE PATTERNS ('/api/prospects/:id'), but this middleware runs BEFORE the
// router, where `req.route` does not exist yet — so a concrete path ('/api/prospects/6533') has to
// be matched back to its pattern. Built from the map as regexes, exactly as
// permissions/shadow.js:29-45 does it for the registry: `:param` → one segment, `/*` → the rest.
//
// Order matters and mirrors Express: a literal pattern wins over a param pattern for the same
// shape ('/api/inquiry/dashboard' before '/api/inquiry/:id'), so literals are tried first and
// wildcards last. Without that, '/api/prospects/run' would match '/api/prospects/:id' and resolve
// by row lookup instead of by request param.
function patternToRegex(p) {
  const wild = p.endsWith('/*');
  const body = wild ? p.slice(0, -2) : p;
  const parts = body.split('/').map(seg =>
    seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + parts.join('/') + (wild ? '(?:/.*)?$' : '$'));
}
let _matchers = null;
function matchers() {
  if (_matchers) return _matchers;
  const { ROUTE_PRODUCT } = require('./route-map');
  const rank = (p) => (p.endsWith('/*') ? 2 : (p.includes('/:') ? 1 : 0));   // literal < param < wildcard
  _matchers = Object.keys(ROUTE_PRODUCT)
    .map(key => { const [method, ...rest] = key.split(' '); const pattern = rest.join(' '); return { key, method, pattern, rank: rank(pattern), rx: patternToRegex(pattern) }; })
    .sort((a, b) => a.rank - b.rank || b.pattern.length - a.pattern.length);
  return _matchers;
}

// Concrete request path → the map's pattern for it, or the raw path when nothing matches (which
// then classifies as null, i.e. fail closed).
function routePattern(req) {
  if (req.route && req.route.path) return (req.baseUrl || '') + req.route.path;  // inside a handler
  const method = String(req.method || 'GET').toUpperCase();
  const path = (req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  for (const m of matchers()) {
    if (m.method !== method) continue;
    if (m.rx.test(path)) return m.pattern;
  }
  // The SPA catch-all is mapped as 'GET *' — index.html for any front-end path. It must NOT cover
  // /api/, and that is not a tidiness point: before this line was narrowed, a NEW GET route missing from
  // the map fell through to 'GET *' and resolved to 'shared', so the boundary waved it through. Found by
  // the impact arithmetic on the product-assignment screen, which reported two routes it could not
  // attribute — both of them mine, both unmapped, both already passing.
  //
  // An unmapped /api/ path now returns the raw path, which classifies as null, which fails closed under
  // enforce. That is the behaviour the design claimed and the wildcard quietly undid for every GET.
  if (method === 'GET' && !path.startsWith('/api/') && require('./route-map').ROUTE_PRODUCT['GET *']) return '*';
  return path;
}

// The product named in the request, for 'param:product'.
function productFromRequest(req) {
  const q = req.query && req.query.product;
  const b = req.body && req.body.product;
  const v = (typeof q === 'string' && q.trim()) || (typeof b === 'string' && b.trim()) || null;
  return v || null;
}

async function resolveProduct(req, { lookupRowProduct } = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  const pattern = routePattern(req);
  let value = classifyRoute(method, pattern);
  const via = [`route:${method} ${pattern}`];

  for (let hop = 0; value && hop < MAX_HOPS; hop++) {
    // Terminal: a grantable name (real product, or 'shared'/'internal').
    if (value === 'shared' || value === 'internal' || GRANTABLE.includes(value)) {
      return { product: value, via, unresolved: false };
    }

    if (value === 'param:product') {
      const named = productFromRequest(req);
      if (named) {
        via.push(`param:product=${named}`);
        // An unknown product name is NOT waved through — it fails closed like anything else.
        if (!GRANTABLE.includes(named)) return { product: null, via: [...via, 'unknown-product'], unresolved: true };
        value = named;
        continue;
      }
      const key = `${method} ${pattern}`;
      const def = Object.prototype.hasOwnProperty.call(PARAM_DEFAULT, key) ? PARAM_DEFAULT[key] : undefined;
      if (def === undefined) return { product: null, via: [...via, 'param:product with no documented default'], unresolved: true };
      if (def === null) return { product: null, via: [...via, 'no product in request and no default'], unresolved: true };
      via.push(`param:product default=${def}`);
      value = def;
      continue;
    }

    if (value === 'param:agent') {
      const agentKey = (req.params && (req.params.key || req.params.agent)) || null;
      if (!agentKey) return { product: null, via: [...via, 'param:agent with no :key'], unresolved: true };
      const mapped = AGENT_PRODUCT[agentKey];
      via.push(`agent:${agentKey}=${mapped || 'UNLISTED'}`);
      // An unlisted agent key fails closed rather than defaulting to anything. NOTE the loop:
      // 'prospecting' maps to 'param:product', so this hop CONTINUES into the param branch above
      // and resolves through to a real product — never compared as the literal marker.
      if (!mapped) return { product: null, via, unresolved: true };
      value = mapped;
      continue;
    }

    const row = ROW_FORM.exec(value);
    if (row) {
      const [, table, column] = row;
      if (!Object.prototype.hasOwnProperty.call(ROW_TABLES, table)) {
        return { product: null, via: [...via, `row: table '${table}' not allowlisted`], unresolved: true };
      }
      const id = (req.params && (req.params.id || req.params.rowId)) || null;
      if (!id) return { product: null, via: [...via, 'row: lookup with no :id'], unresolved: true };
      if (typeof lookupRowProduct !== 'function') {
        return { product: null, via: [...via, 'row: no lookup available'], unresolved: true };
      }
      let found = null;
      try { found = await lookupRowProduct(table, column, id); }
      catch (e) { return { product: null, via: [...via, `row: lookup failed (${e && e.message})`], unresolved: true }; }
      via.push(`row:${table}.${column}#${id}=${found || 'NOT FOUND'}`);
      // A missing row is unresolved, not permitted: the handler will 404 anyway, and guessing
      // 'allowed' here is exactly the hole this value exists to close.
      if (!found || !GRANTABLE.includes(found)) return { product: null, via, unresolved: true };
      value = found;
      continue;
    }

    return { product: null, via: [...via, `unknown map value '${value}'`], unresolved: true };
  }

  return { product: null, via: [...via, value ? 'resolution did not terminate' : 'route not classified'], unresolved: true };
}

module.exports = { resolveProduct, routePattern, productFromRequest, ROW_TABLES, MAX_HOPS };
