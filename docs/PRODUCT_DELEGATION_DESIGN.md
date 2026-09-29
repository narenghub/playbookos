# Product access — how an account gets one, and what it means

> **Status: BUILT AND ENFORCING.** `PRODUCT_BOUNDARY_MODE=enforce` in production since 2026-09-29.
> This document replaces an earlier design for a `product_owner` role and delegated invites. That
> model was **dropped before anything was built** — see [What was dropped, and why](#what-was-dropped-and-why).

## The model in four sentences

A **super admin** creates every account. At invite time they tick which **products** that account can
reach. The grants are written when the invite is **accepted**, and from then on the **product
boundary** checks them on every single request, independently of the account's role. Nobody else can
create an account, and nobody can widen their own access.

That is the whole model. There is no delegation, no product-owner role, and no way for a product's
users to multiply themselves.

---

## The two gates, and why there are two

```
  request
    │
    ├─ 1. ROLE / TIER  ──── requireTier('intelligence'), adminOnly, superAdminOnly
    │                       "is this KIND of user allowed to do this KIND of thing?"
    │                       src/lib/core.js, src/lib/roles.js, src/lib/permissions/*
    │
    ├─ 2. PRODUCT BOUNDARY ─ does this caller hold the product this ROUTE belongs to?
    │                       "which BUSINESS's data is this?"
    │                       src/lib/products/*  ·  user_products  ·  ROUTE_PRODUCT
    │
    └─ 3. the handler ────── and where the TABLE is product-bearing, scope the ROWS too
                            src/lib/products/held.js (productScopeSql)
```

The two gates are independent **on purpose**. A tier granted by mistake — the single most likely
permissions error, because tiers are granted by hand and roles are coarse — must not be sufficient to
become a cross-product data exposure. Layer 2 does not consult the role and layer 1 does not consult
the products, so neither one failing opens the other.

Layer 3 exists because layer 2 deliberately does **not** filter rows. It admits or refuses a request
and never touches `req.user`. A route can be genuinely *shared* — safe for anyone with a login — while
the table behind it carries a `product` column. `notifications` was exactly that, and the audit of all
20 shared routes lives in a comment in `src/lib/products/route-map.js` so the next shared route gets
the same question asked of it.

---

## What actually happens when you invite someone

**1. The super admin opens the team page and clicks "Invite member".**
The button is not there for anyone else — `admin` can still rename, activate, deactivate and reset
passwords, but it cannot create an account. Inviting a user now decides what that account can reach,
and that decision stays with the person accountable for the boundary.

**2. The form offers product checkboxes.**
The list comes from `GET /api/products/grantable`, which reads `PRODUCTS` out of the route map. It is
not a copy kept in the client. A checkbox for a product the boundary does not know about would grant
nothing while looking like it granted something.

**3. `internal` is drawn separately, below the products, unchecked.**
It is not a product. It is the staff flag: it carries the platform-wide routes (team, settings, agent
control, roles) and every alert that is not attributable to a product. It is never pre-ticked, it is
labelled with what it means, and ticking it raises a confirmation naming the address. Granting it to
an outside account is the one mistake here that does not announce itself, so it has to be a decision
somebody made rather than a default nobody noticed.

**4. Sending the invite grants nothing.**
The choice is parked on the row (`users.invited_products`, with `users.invited_by`). An invite that is
never accepted, or is sent to the wrong address and revoked, leaves **no row in `user_products`** —
because that row is what the boundary reads, and a grant should exist only for an account somebody
actually holds.

**5. Accepting writes the grants.**
In the same transaction as the password, so there is no state where the account can log in but holds
nothing — that would look like a boundary bug and be debugged as one. `granted_by` records the
inviter, not the acceptor. `ON CONFLICT DO NOTHING` makes a replayed token harmless.

**6. The team page shows what every account holds.**
Held grants as badges; chosen-but-not-yet-accepted dimmed with "on accept"; `none` in grey when an
account holds nothing. A grant you cannot see is a grant nobody audits.

### Ticking nothing

Valid, and it is also what happens if you forget. The account reaches only the `shared` routes: its
own tasks, KPIs, activity, profile and notifications. The form says so. Empty is the safe direction —
`product = ANY('{}')` matches no row, so every product filter narrows to nothing rather than
everything.

---

## A partner account, concretely

```
role:      partner          tiers: { self: 'rw', sitenex: 'r' }
products:  ['sitenex']
NOT:       'internal'
```

`partner` is the first role for somebody who does not work here, so nothing about it is inherited
from a role designed for staff. It holds the `sitenex` tier read-only — every sitenex route is a GET today,
and `rw` would pre-authorise a write route that does not exist yet — and a hand-written permission
template of 16 features.

**It sees Deals and Packages. It does not see SiteNex Prospects.** That screen is our scored machine-shop
lead list; a referral partner reading it would be reading our pipeline rather than their own deals.
Three independent refusals, which is the point of having layers:

| Layer | What refuses Prospects |
|---|---|
| role | the route keeps `adminOnly` |
| resolver | `sitenex.prospects.list` is not in the template |
| nav | `NAV_PAGE_REQS['sitenex-prospects']` needs the `intelligence` tier, which the role has not got |

What the account *can* reach:

- `GET /api/sitenex/deals`, `GET /api/sitenex/packages` — gated `requireTier('sitenex')`, a tier held by
  `super_admin`, `admin` and `partner` and nobody else
- the `shared` routes: its own tasks, activity, KPIs, performance, profile, password
- `GET /api/roles` — the role catalog. Not an admin capability: `buildNav()` fetches it on every page
  load to work out the caller's tiers, and without it the nav falls back to section-only and would draw
  the SiteNex Prospects link it cannot open. It was classified `internal` in the route map, which was
  wrong the moment a non-internal account existed.
- notifications tagged `sitenex` — although in practice the bell is not rendered for this role at all,
  because it needs the `intelligence` tier (`index.html:1016`), the same as `sales_team`
- `GET /api/prospects/:id` only for rows whose own `product` is `sitenex` — resolved by looking the row up
  (`row:prospects.product`), because that URL carries no product at all and a guessed id would
  otherwise read, or `PUT` would modify, another product's row

What it cannot reach, and why it is two separate reasons: `GET /api/users`, `POST /api/users/invite`,
`POST /api/roles` and the rest of the platform surface are `internal` in the route map (boundary),
*and* gated by `adminOnly`/`superAdminOnly` (role). Either one alone would refuse it.

> **`PERMISSIONS_ENFORCE_ROLES` must list `partner`.** The template above decides nothing
> otherwise — `enforce.js:82` returns early for a role that is not listed, leaving the route gates
> alone. Pinned by `src/lib/permissions/sitenex-partner.test.js` and `src/api/sitenex-routes.test.js`.

---

## Role and products disagree by design

**This is the section to read before "fixing" a permissions inconsistency.**

The two gates answer different questions, so a broad role next to narrow products is the normal state, not
a bug:

| | asks | example |
|---|---|---|
| role / tier | *is this kind of user allowed to do this kind of thing?* | `admin` grants nearly every feature |
| product boundary | *whose business's data is this?* | Prasanthi holds `abiozen, golfnex, internal` — so `linkabl`, `favly`, `aros` and `sitenex` are refused |

Prasanthi is an `admin`. Her role grants the Reorder Agent, the Linkabl digest, AROS Sourcing, everything.
The boundary refuses the ones whose product she does not hold. **That 403 is the feature.** The value of a
second gate is precisely that a tier granted by mistake — the likeliest permissions error there is, since
tiers are coarse and granted by hand — cannot become a cross-product data exposure. If holding a role
implied holding its products, there would be one gate wearing two names.

As of 2026-09-29 the real state is deliberately uneven, because products are being narrowed one person at
a time:

```
admin             prasanthi    [abiozen, golfnex, internal]
business_dev      vinitha      [abiozen, internal]
dev_team          muni         [abiozen, favly, internal]
dev_team          premnath     [abiozen, internal, linkabl]
recruitment_team  nikhil       [internal, linkabl]          ← no abiozen at all, on purpose
super_admin       naren        all seven
```

Two people on the same role hold different products. That is correct: products follow the **person's
work**, not their job title.

### The wrong fixes, in the order somebody will reach for them

1. **Granting the missing products to "make the role consistent."** This removes the boundary for that
   person while leaving all the code that looks like it is still protecting them.
2. **Having the boundary consult the role.** The same thing, for everyone at once.
3. **Deriving products from the role.** This is what the nav used to do, and it is why several roles could
   see products they had no business in.

### The right fix

When a 403 is genuinely wrong, grant that **one** product to that **one** person, deliberately, through
the team page. That records who did it and when in `user_product_grants_log`. If the same grant keeps
being needed by everyone on a role, that is a signal about the route's classification in
`ROUTE_PRODUCT` — take it up there, not by widening people.

---

## Fail-closed, and the kill switch

`PRODUCT_BOUNDARY_MODE` — `off` | `shadow` | `enforce`. An env var, so it needs no code change:

- **off** — the middleware does nothing. No evaluation, no logging.
- **shadow** — evaluate, log **every** request to `product_shadow_log`, never block.
- **enforce** — evaluate, log, and `403` when the caller lacks the product, when the product cannot be
  resolved, or when the middleware itself errors.

Unresolvable means the map and the routes have diverged, which is the moment to stop rather than
continue. The costs are asymmetric in the direction that decides it: fail-closed fails loudly and
immediately — someone internal is locked out, says so, and it is fixed in minutes — while fail-open
fails silently and is discovered when an outside account has been reading Apollo for a month.

Changing the variable triggers a redeploy (~3 minutes). If something is badly wrong, that is the
rollback: set it to `off`.

### What was proven before the switch was thrown

| Check | Result |
|---|---|
| `src/lib/products/route-sweep.test.js` — all 210 mounted routes resolve to a concrete product | pass |
| `scripts/verify-row-product-lookup.js` — the `row:prospects.product` lookup against a real table, incl. missing id and a failing lookup | pass in prod, 0 leaked fixtures |
| `scripts/verify-notification-scope.js` — the notification data scope against the real column | pass in prod |
| `product_shadow_log` — 212 requests over 14 hours, `would_block` | 0 |
| `product_shadow_log` — unresolved products | 0 |
| `user_products` — 17 users × 7 values | 119 grants, nobody short |

Shadow traffic touched 41 of 210 routes, which is why the sweep test exists: the 169 untouched routes
include ~110 that mutate, and nobody is going to fire the email engine to test a route map. The sweep
proves what traffic was going to prove, without traffic.

---

## What was dropped, and why

The earlier design had a `product_owner` role that could invite users within its own product. It was
designed, reviewed, and never built. Three reasons it was the wrong shape:

1. **It creates a second authority over access.** The whole value of the boundary is that exactly one
   person decides who reaches what. A delegated invite splits that, and the split is invisible — you
   would have to read `user_products` to know who granted whom.
2. **The interesting case is a partner, and a partner should not multiply.** ACBM Partners is a referral
   partner. An account that can create accounts inside our system is a different kind of relationship
   from an account that can read its own deals, and only one of those was ever wanted.
3. **It solved a problem we do not have.** There are 17 internal users and one partner. Super admin
   creating each account by hand is minutes of work per year, against a permanent new surface.

If delegation is ever genuinely needed, the thing to add is not a role — it is a per-user "may invite
within these products" grant, which is the same check written where it can be seen.

---

## Where the code is

| Concern | File |
|---|---|
| **The security model written down** — every route → its product | `src/lib/products/route-map.js` |
| Resolving a request to a product (params, row lookups, agent keys) | `src/lib/products/resolve-product.js` |
| The middleware, the three modes, fail-closed | `src/lib/products/boundary.js` |
| Row-level scoping for product-bearing tables | `src/lib/products/held.js` |
| `user_products` + `product_shadow_log` + the wide backfill | `scripts/migrate-product-boundary.js` |
| `users.invited_products` + `users.invited_by` | `scripts/migrate-invite-products.js` |
| Invite (super_admin only, products chosen) · accept (grants written) | `src/api/routes.js` |
| The invite form and the products column | `public/index.html` (`pages.team`, `renderInviteProducts`) |
| `partner` — tiers, template, nav family, and what each layer refuses | `src/lib/roles.js`, `src/lib/permissions/templates.js`, `public/index.html` (`NAV_FAMILIES`) |

### Adding a route

Add it to the map. If you do not, the sweep test fails — which is the point; an unclassified route
`403`s under enforce rather than passing. If the route is `shared` and its handler reads a table with a
`product` column, scope the rows with `productScopeSql` as well. The list of product-bearing tables is
in the audit comment in `route-map.js`.

### Adding a product

Add it to `PRODUCTS` in the route map, classify its routes, and it appears in the invite form on its
own. No client change, no template change.
