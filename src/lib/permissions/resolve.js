// PlaybookOS — Permission Resolver (P2)
//
// Answers "does this user hold this feature, and exactly why?" against the code-defined
// registry (registry.js) + derived role templates (templates.js) + per-user overrides
// (user_feature_overrides) + env kill-switches. The rule number and explain string are
// first-class outputs so a super_admin UI can show precisely why access was granted/denied.
//
// PRECEDENCE — first match wins, top to bottom:
//   1  feature absent from registry, or deprecated                 -> DENY
//   2  feature's env kill-switch is off                            -> DENY  (beats user rules)
//   3  user inactive / suspended                                   -> DENY
//   4  unexpired user override, effect='deny'                      -> DENY  (beats allow, rule 4 > 5)
//   5  unexpired user override, effect='allow'                     -> ALLOW
//   6  reachable via `implies` from an already-allowed feature     -> ALLOW
//   7  in the user's role template grants AND defaultDeny is false -> ALLOW
//   8  nothing matched                                             -> DENY
//
// Revocation takes effect on the NEXT REQUEST, not next login: role, is_active and
// permissions_version are read FRESH from the users row on every call (the can_run_standup
// precedent, routes.js:2983). Permissions are NEVER read from the JWT. The heavier
// user_feature_overrides query is cached per user keyed on users.permissions_version;
// middleware bumps that counter on any permission change, which busts the cache.
//
// Nothing imports this file yet.

const { FEATURES } = require('./registry');
const { TEMPLATES } = require('./templates');

// ── static indexes (built once) ───────────────────────────────────────────────
const FEAT = new Map(FEATURES.map(f => [f.key, f]));
// child feature key -> [parent feature keys that imply it]
const IMPLIED_BY = new Map();
for (const f of FEATURES) {
  for (const child of (f.implies || [])) {
    if (!IMPLIED_BY.has(child)) IMPLIED_BY.set(child, []);
    IMPLIED_BY.get(child).push(f.key);
  }
}
const _grantsCache = new Map(); // role -> Set(featureKey)
function grantsFor(role) {
  if (_grantsCache.has(role)) return _grantsCache.get(role);
  const s = new Set((TEMPLATES[role] && TEMPLATES[role].grants) || []); // custom/unknown role -> no grants
  _grantsCache.set(role, s);
  return s;
}

// ── env kill-switches ─────────────────────────────────────────────────────────
// Registry features carry no env field, so the (small, explicit) mapping lives here.
// Mirrors researchIntelEnabled() in routes.js (flag must equal the string 'true').
const ENV_GATES = [
  { match: k => k.startsWith('intelligence.research_intelligence'), flag: 'RESEARCH_INTEL_ENABLED' },
];
function envFlagOff(key, env) {
  for (const g of ENV_GATES) {
    if (g.match(key) && String(env[g.flag]).toLowerCase() !== 'true') return g.flag;
  }
  return null;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function A(rule, source, explain) { return { allowed: true, rule, source: source || null, explain }; }
function D(rule, source, explain) { return { allowed: false, rule, source: source || null, explain }; }

function isExpired(row, now) {
  return !!row.expires_at && new Date(row.expires_at).getTime() <= now;
}
// Collapse override rows to one decision per feature. Deny beats allow (rule 4 > 5) even
// if both rows are present (the DB PK forbids duplicates, but we resolve defensively).
function indexOverrides(rows, now) {
  const m = new Map();
  for (const r of rows || []) {
    if (isExpired(r, now)) continue;
    const cur = m.get(r.feature_key);
    if (!cur) { m.set(r.feature_key, r); continue; }
    if (cur.effect === 'allow' && r.effect === 'deny') m.set(r.feature_key, r); // deny wins
  }
  return m;
}
function isActiveVal(v) { return v === true || Number(v) === 1; }

// ── pure evaluation (rules 1-8) — no I/O ──────────────────────────────────────
// rules 1,2,3,4,5 only. Returns a decision, or null when undecided (fall through to 6/7).
function evalTopRules(key, ctx) {
  const f = FEAT.get(key);
  if (!f) return D(1, { key }, `Feature '${key}' is not in the registry`);
  if (f.deprecated === true) return D(1, { key }, `Feature '${key}' is deprecated`);
  const flag = envFlagOff(key, ctx.env);
  if (flag) return D(2, { flag }, `Env kill-switch ${flag} is off — '${key}' is disabled for everyone`);
  if (!ctx.is_active) return D(3, { userId: ctx.userId }, `User ${ctx.userId} is inactive/suspended`);
  const ov = ctx.overrides.get(key);
  if (ov) {
    if (ov.effect === 'deny') return D(4, { override: ov }, `Explicit deny override${ov.reason ? ' — ' + ov.reason : ''} (beats allow, template and implies)`);
    if (ov.effect === 'allow') return A(5, { override: ov }, `Explicit allow override${ov.reason ? ' — ' + ov.reason : ''}`);
  }
  return null; // undecided
}
// rule 7 only.
function evalTemplate(key, ctx) {
  const f = FEAT.get(key);
  if (!f) return null;
  // NOTE: the "defaultDeny === false" guard is bypassed ONLY for super_admin, whose template
  // (templates.js, rule 3) deliberately lists every non-cron feature incl. defaultDeny ones.
  // For every other role, templates already exclude defaultDeny features, so the guard is a
  // belt-and-suspenders check that keeps a mis-built template from leaking a dangerous grant.
  const ok = ctx.grants.has(key) && (f.defaultDeny === false || ctx.role === 'super_admin');
  if (!ok) return null;
  const via = (ctx.role === 'super_admin' && f.defaultDeny)
    ? `In 'super_admin' template (rule 3 grants all non-cron, incl. defaultDeny)`
    : `In '${ctx.role}' template grants (defaultDeny=false)`;
  return A(7, { role: ctx.role, template: ctx.role }, via);
}
// A parent (page) is "already-allowed" for rule-6 purposes if it passes rules 1-5 or rule 7.
// Deliberately excludes rule 6 itself, so implies is single-level and cannot recurse.
function parentAllowed(key, ctx) {
  const r = evalTopRules(key, ctx);
  if (r) return r.allowed;
  const t = evalTemplate(key, ctx);
  return !!(t && t.allowed);
}
// Full resolution for one feature (rules 1-8 in order).
function resolveSync(key, ctx) {
  const top = evalTopRules(key, ctx);       // rules 1-5
  if (top) return top;
  const parents = IMPLIED_BY.get(key) || []; // rule 6
  for (const pk of parents) {
    if (parentAllowed(pk, ctx)) {
      return A(6, { via: pk }, `Granted via already-allowed '${pk}' → implies '${key}'`);
    }
  }
  const tmpl = evalTemplate(key, ctx);       // rule 7
  if (tmpl) return tmpl;
  return D(8, null, `No rule matched — '${key}' is not overridden, not implied by a held feature, and not in the '${ctx.role}' template`); // rule 8
}

// ── context (fresh per request; overrides cached by permissions_version) ───────
const _ovCache = new Map(); // userId -> { version, rows }
function migrationError(missing) {
  return new Error(
    `[permissions] ${missing} is missing — run \`node scripts/migrate-permissions.js\` ` +
    `(migration ffed828) before using the resolver.`
  );
}
async function gatherContext(user, deps) {
  const env = deps.env || process.env;
  const now = deps.now != null ? deps.now : Date.now();

  // Injected mode (tests / callers that already have the data): no DB, no cache.
  if (deps.overrides !== undefined) {
    return {
      userId: user.id,
      role: user.role,
      is_active: isActiveVal(user.is_active !== undefined ? user.is_active : 1),
      version: user.permissions_version != null ? user.permissions_version : 0,
      overrides: indexOverrides(deps.overrides, now),
      grants: grantsFor(user.role),
      env, now,
    };
  }

  // DB mode. Read role/is_active/permissions_version FRESH every call (revocation on next
  // request). This read also surfaces the migration guard.
  const query = deps.query || require('../db').query;
  let urow;
  try {
    urow = (await query('SELECT role, is_active, permissions_version FROM users WHERE id=$1', [user.id])).rows[0];
  } catch (e) {
    if (e && (e.code === '42703' || /permissions_version/i.test(String(e.message)))) throw migrationError('users.permissions_version');
    throw e;
  }
  const role = urow ? urow.role : user.role;
  const is_active = isActiveVal(urow ? urow.is_active : 0); // unknown user -> treat inactive
  const version = urow ? urow.permissions_version : 0;

  // Overrides: cached per user, invalidated by permissions_version.
  let rows;
  const cached = _ovCache.get(user.id);
  if (cached && cached.version === version) {
    rows = cached.rows;
  } else {
    try {
      rows = (await query(
        'SELECT feature_key, effect, expires_at, reason FROM user_feature_overrides WHERE user_id=$1',
        [user.id]
      )).rows;
    } catch (e) {
      if (e && (e.code === '42P01' || /user_feature_overrides/i.test(String(e.message)))) throw migrationError('user_feature_overrides table');
      throw e;
    }
    _ovCache.set(user.id, { version, rows });
  }

  return { userId: user.id, role, is_active, version, overrides: indexOverrides(rows, now), grants: grantsFor(role), env, now };
}

// ── public API ────────────────────────────────────────────────────────────────
async function resolve(user, featureKey, deps = {}) {
  const ctx = await gatherContext(user, deps);
  return resolveSync(featureKey, ctx);
}

// Every feature -> its resolution. Loads the user's overrides ONCE (not per feature).
async function resolveAll(user, deps = {}) {
  const ctx = await gatherContext(user, deps);
  const out = new Map();
  for (const f of FEATURES) out.set(f.key, resolveSync(f.key, ctx));
  return out;
}

// nav_page features the user holds — this is what keeps the sidebar and the API in agreement.
async function resolveNav(user, deps = {}) {
  const ctx = await gatherContext(user, deps);
  const held = [];
  for (const f of FEATURES) {
    if (f.surface === 'nav_page' && resolveSync(f.key, ctx).allowed) held.push(f.key);
  }
  return held;
}

// Bust the override cache (e.g. right after writing a grant, if you don't want to wait for
// the next permissions_version read). Pass a userId to clear one user, or nothing for all.
function clearCache(userId) {
  if (userId === undefined) _ovCache.clear();
  else _ovCache.delete(userId);
}

module.exports = { resolve, resolveAll, resolveNav, clearCache };
