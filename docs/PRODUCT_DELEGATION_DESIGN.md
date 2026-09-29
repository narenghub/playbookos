# Product-scoped delegation — DESIGN ONLY, NOT SHIPPED

> **Nothing in this document is built.** It is the design for steps (a) and (d) of the sequence
> below. (d) must not ship before (c). Written 2026-09-28.

## Why the sequencing is the whole design

A product owner who holds only `acbm` and invites a colleague is only *actually* scoped once
`PRODUCT_BOUNDARY_MODE=enforce`. In `shadow`, an account holding one product in `user_products`
still reaches every route — the middleware observes and calls `next()`.

Shipping (d) during shadow would therefore create accounts that **look** scoped and are not, while
everyone involved believes the scoping works. That is worse than not having the feature: absent, the
risk is visible and nobody invites an outsider; present-but-inert, someone invites a partner in good
faith.

```
a. Register the three /api/acbm/* features in the registry      ← the current blocker, designed below
b. Finish the shadow week, read the reports, fix any map gaps
c. Switch PRODUCT_BOUNDARY_MODE to enforce
d. THEN product_owner + the scoped invite flow                  ← designed below, ship after (c)
e. THEN an account for ACBM
```

---

# (a) Registry features for the ACBM routes

**Why this is the blocker.** The three routes are `authMiddleware + adminOnly` with no registry
feature. `mapFeatureKey` returns null for them, so `enforce.js:94` falls through to the gate. Two
consequences: they never appear in `resolveAll`, and **a per-user override cannot grant them** —
`user_feature_overrides` is keyed on a feature that does not exist. So a `product_owner` could not be
given the ACBM screens at all, however the role were defined.

**Four features**, following the existing registry shape (`src/lib/permissions/registry.js`):

```js
// nav_page — the page, so nav and API agree and resolveNav can see it
{ key: 'acbm.page_acbm.view', label: 'Page — ACBM', domain: 'acbm', surface: 'nav_page',
  ref: 'acbm-prospects', cost: 'free', spend: [], dangerous: false, defaultDeny: false,
  implies: ['acbm.prospects.list', 'acbm.deals.list', 'acbm.packages.list'] },

{ key: 'acbm.prospects.list', label: 'List — GET /api/acbm/prospects', domain: 'acbm',
  surface: 'api_route', ref: 'GET /api/acbm/prospects', cost: 'free', spend: [],
  dangerous: false, defaultDeny: false, implies: [] },

{ key: 'acbm.deals.list', label: 'List — GET /api/acbm/deals', domain: 'acbm',
  surface: 'api_route', ref: 'GET /api/acbm/deals', cost: 'free', spend: [],
  dangerous: false, defaultDeny: false, implies: [] },

{ key: 'acbm.packages.list', label: 'List — GET /api/acbm/packages', domain: 'acbm',
  surface: 'api_route', ref: 'GET /api/acbm/packages', cost: 'free', spend: [],
  dangerous: false, defaultDeny: false, implies: [] },
```

Notes on the choices, since each one is a decision:

- **`domain: 'acbm'`** is a new domain value. `golfnex` already exists as a domain, so this follows
  precedent rather than inventing a pattern.
- **`defaultDeny: false`** on all four. They are read-only GETs with no spend. `defaultDeny: true` is
  for things that cost money or write (the 54 in admin's `needsExplicitGrant`); marking a read-only
  list `defaultDeny` would mean even a super_admin needed rule 3's bypass to see it, which is noise.
- **One `implies` chain from the page**, matching how every other page feature works: holding the
  page implies its read routes, which is what `resolveNav` and rule 6 use.
- **The three GETs keep `adminOnly` in the route definition** until (c). Registry features *tighten*;
  they do not loosen. Relaxing `adminOnly` to `requireTier` is part of (d), not (a).

**Template grants:** add all four to `super_admin` and `admin` in `src/lib/permissions/templates.js`.
Nobody else, for now.

**The step that is easy to forget:** `NAV_PAGE_REQS` in `public/index.html:805` is *generated from the
registry* and marked "do not hand-edit". Adding a `nav_page` feature means regenerating it, and
`scripts/verify-classic-nav-parity.js` will then report a diff for super_admin/admin — expected, and
the same "did only the intended roles move?" reading as before.

**Cost of (a):** four registry entries, two template edits, one regeneration, one parity re-read.
It is inert for current users: admin and super_admin already reach these routes via `adminOnly`.

---

# (d) `product_owner` and the scoped invite

## The invariant

> **An inviter can never grant a product they do not hold.**

This is the only thing that makes delegation safe, and it must be enforced **server-side**. The
invite form is a convenience; the check belongs where the row is written. Stated as code:

```
granted_products ⊆ inviter's user_products     (always, no exceptions, including for admins)
```

An admin holding all 7 can grant any subset. A product owner holding `['acbm']` can grant `['acbm']`
and nothing else. There is no "grant everything" flag, because the invariant makes one unnecessary.

## Schema

`user_products` already has the shape needed; delegation needs only provenance, which it already has
(`granted_by`, `granted_at`). One addition:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by TEXT REFERENCES users(id);
```

`invites` (or the existing `invite_token` columns on `users`) must carry the products being offered,
so the grant is decided at invite time by someone who held them, not at accept time:

```sql
CREATE TABLE IF NOT EXISTS user_invites (
  token        TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL,
  products     TEXT[] NOT NULL,          -- validated ⊆ inviter's products AT INVITE TIME
  invited_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ
);
```

**Re-validate the subset at ACCEPT time as well as invite time.** The inviter may have lost a product
between sending and acceptance; the grant must reflect what they hold when it is actually written, and
the intersection is the safe answer. An invite whose products no longer intersect is refused, not
silently downgraded to nothing.

## The role

```js
product_owner: {
  label: 'Product Owner',
  tiers: { self: 'rw' },          // deliberately NO domain tiers
  pages: [],                      // nav comes from the product, not the role
}
```

`tiers: { self: 'rw' }` and nothing else is the point: the role grants *no* domain access, so every
door a product owner can open is opened by a product grant. The `internal` pseudo-product is **never**
granted to a `product_owner` — that is what keeps `/api/users`, role administration and the meeting
notes out of reach even though those routes are not product-specific.

**Consequence to accept deliberately:** with no domain tiers, `requireTier(...)` refuses a
product_owner on every existing route. So (d) also requires the ACBM routes to move from `adminOnly`
to a gate a product_owner can pass — the registry features from (a) plus the product boundary become
the two gates, and `adminOnly` is replaced rather than supplemented. That is precisely why (a) comes
first and why (d) cannot land during shadow: the product boundary must be the real gate before
`adminOnly` is removed from anything.

## Server-side enforcement points

| Where | Check |
|---|---|
`POST /api/users/invite` | `products ⊆ inviter.user_products`; reject the whole request on any element outside it, never silently filter — silent filtering teaches the inviter the wrong model |
`POST /api/auth/accept-invite` | re-validate against the inviter's CURRENT products; write the intersection; refuse if empty |
`POST /api/user-products/grant` (new) | same subset check; `granted_by = req.user.id` |
`DELETE /api/user-products/:user/:product` (new) | an inviter may revoke only within their own holdings, and only for users they invited (`invited_by = req.user.id`) or if they are admin |

Every one of these writes `permission_audit_log` — the table already exists and already has
`actor_user_id`, `target_user_id`, `before`, `after`, `reason`.

## What a product owner must NOT be able to do

- grant `internal`, or any product they do not hold
- change their own product set (self-grant), or another inviter's
- see `/api/users` (that is `internal`)
- reach any other product's data — this is the boundary's job, which is why enforce must be on first

## Tests the implementation needs

1. `['acbm']` inviter offering `['acbm']` → allowed.
2. `['acbm']` inviter offering `['acbm','abiozen']` → **rejected entirely**, not filtered.
3. `['acbm']` inviter offering `['internal']` → rejected.
4. Inviter loses `acbm` between invite and accept → accept refused, no partial grant.
5. Inviter gains a product between invite and accept → the invite still grants only what it named.
6. A product_owner calling the grant endpoint for a user they did not invite → rejected.
7. With `PRODUCT_BOUNDARY_MODE=enforce`, a product_owner holding `['acbm']` gets 403 on
   `/api/apollo/stats`, `/api/users`, and `GET /api/prospects?product=golfnex`.
8. The same account gets 200 on the three `/api/acbm/*` routes.
9. **`GET /api/prospects/:id` for a golfnex row → 403** (the `row:prospects.product` path — the one
   that would otherwise leak another product's data by id, and PUT would modify it).

Test 9 is the one that proves the boundary rather than the role.

## Residual risks, stated rather than discovered later

- **`shared` is reachable by anyone with a login** by design. Re-read the `shared` list before the
  first external account exists and ask of each route: would I show this to a partner?
- **`param:product` defaults to `golfnex`** on the prospects routes. A product_owner calling
  `/api/prospects` with no `?product=` resolves to golfnex and is refused — correct, but it will read
  as a bug to them. The screens always send the parameter.
- **A product owner can invite unlimited users.** No cap is designed here; if that matters, it belongs
  on the invite endpoint, not in the role.
- **Revocation is not retroactive to sessions**: the boundary reads `user_products` per request, so a
  revoke takes effect on the next request — good — but any already-downloaded page data stays in the
  browser.
