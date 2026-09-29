// PlaybookOS — CHANGING what a user holds, and the guards on doing it.
//
// The write side of the product boundary. Reading is one line (held.js); writing is not, because the
// ways it goes wrong are specific and one of them needs database surgery to undo.
//
// WHAT THE CALLER GETS BACK is a DIFF, not a success flag. "Saved" tells somebody nothing about what
// they just did to another person's account; "lost abiozen and aros — 120 routes will now 403" tells
// them enough to notice they picked the wrong row.

const { PRODUCTS, GRANTABLE, classifyRoute } = require('./route-map');

// ── guards ────────────────────────────────────────────────────────────────────
//
// Both of these are refused on the SERVER. Hiding a checkbox is a courtesy to whoever is looking at
// the screen; it is not a guard, because the request can be made without the screen.

// 1. NOBODY NARROWS THEMSELVES.
// Removing 'internal' from your own account removes your access to /api/users — the page you would use
// to put it back. The fix is a hand-written UPDATE against production, which is the category of problem
// worth one `if`. Widening yourself is fine: a super_admin can already grant any product to anyone, so
// granting one to themselves is not an escalation, just a shortcut.
//
// 2. THE LAST SUPER_ADMIN KEEPS EVERYTHING.
// Two super_admins can rescue each other. One cannot, so their products are not removable by anyone,
// including another account that thinks it is being helpful.
function checkGrantChange({ actor, target, current, next, activeSuperAdmins }) {
  const cur = new Set(current || []);
  const nxt = new Set(next || []);
  const removed = [...cur].filter(p => !nxt.has(p));

  const unknown = [...nxt].filter(p => !GRANTABLE.includes(p));
  if (unknown.length) {
    return { ok: false, code: 'unknown_product',
      error: `Unknown product(s): ${unknown.join(', ')}. Grantable: ${GRANTABLE.join(', ')}` };
  }

  if (!removed.length) return { ok: true, removed: [], added: [...nxt].filter(p => !cur.has(p)) };

  if (actor.id === target.id) {
    return { ok: false, code: 'self_narrow',
      error: `You cannot remove your own products (${removed.join(', ')}). Removing 'internal' from `
        + `your own account would remove your access to this page, and the only way back is a manual `
        + `database change. Ask another super admin to do it.` };
  }

  if (target.role === 'super_admin' && activeSuperAdmins <= 1) {
    return { ok: false, code: 'last_super_admin',
      error: `${target.email} is the only active super admin. Their products cannot be removed — there `
        + `would be nobody able to restore them. Promote a second super admin first.` };
  }

  return { ok: true, removed, added: [...nxt].filter(p => !cur.has(p)) };
}

// ── the diff, and what it costs the user ──────────────────────────────────────

// How many MOUNTED routes each product owns. Routes are injected rather than imported, so this is
// testable and cannot create a cycle with the router that defines them.
function routeCountsByProduct(mountedRoutes) {
  const counts = {};
  for (const p of [...PRODUCTS, 'internal', 'shared']) counts[p] = 0;
  // Routes whose product comes from the REQUEST (param:product, param:agent, row:<table>.<column>)
  // cannot be attributed to one product from the map alone. They are counted here rather than dropped:
  // an impact line that silently omits routes is the kind of number that makes people stop trusting the
  // screen. They are real and they are affected — a ?product=abiozen call stops working when abiozen
  // goes — the map just cannot say how many belong to whom.
  counts.variable = 0;
  counts.unclassified = 0;
  for (const r of mountedRoutes || []) {
    const c = classifyRoute(r.method, r.path);
    if (c === null) { counts.unclassified += 1; continue; }
    if (counts[c] !== undefined) counts[c] += 1;
    else counts.variable += 1;           // a marker: param:product / param:agent / row:*
  }
  return counts;
}

// A sentence a person can check their own intent against.
//
// It counts what the change COSTS or BUYS in routes, because "abiozen" means nothing to somebody
// deciding whether they have just broken a colleague's afternoon, and "119 routes" means quite a lot.
// 'shared' routes are never affected by a product change, so they are excluded from the arithmetic and
// mentioned separately — otherwise the number reads as "everything is gone".
function describeChange({ target, added, removed, counts }) {
  const n = (list) => (list || []).reduce((s, p) => s + (counts[p] || 0), 0);
  const who = target.name || target.email;
  const parts = [];
  if (added.length) parts.push(`gained ${added.join(', ')} (+${n(added)} routes)`);
  if (removed.length) parts.push(`lost ${removed.join(', ')} — will now get 403 on ${n(removed)} routes`);
  if (!parts.length) return `${who}: no change.`;
  let s = `${who} ${parts.join('; ')}.`;
  if (removed.includes('internal')) {
    s += ` Removing 'internal' also hides every platform-wide alert and the whole admin surface`
      + ` (team, settings, agent control).`;
  }
  s += ` ${counts.shared} shared routes are unaffected — they never depend on a product.`;
  if (counts.variable) {
    s += ` A further ${counts.variable} routes take their product from the request, so they keep working`
      + ` for whatever this user still holds.`;
  }
  return s;
}

module.exports = { checkGrantChange, routeCountsByProduct, describeChange };
