# ENG-002 — `skus` and `suppliers` have no tenant column

**Class:** security · **Opened:** 2026-11-06 · **Status:** OPEN — compensating control in place
**Raised by:** ruling 16 item 8 · **Blocks:** onboarding a second active company

## The gap

Every table created by connectors.v1, registrations.v2 and intake.v3 carries `company_id`, and the
tenant-crossing writes are refused inside the engine by composite foreign keys `(id, company_id)`
declared `MATCH FULL`. Two legacy tables predate that and have no tenant column at all:

- `skus`
- `suppliers`

A requirement match therefore cannot be tenant-checked against the SKU or supplier it names. The v3
schema references both tables for orphan rejection, so the *existence* of the row is enforced; the
*ownership* of it is not, and cannot be, until the column exists.

`scripts/check-migration-v3-db.js` records this as a **known gap, not a pass** — it asserts the
absence of the column rather than asserting isolation it cannot prove. A test that reported this
area green would be worse than no test.

## Why this is not currently an exploitable path

There is exactly one active company. Measured on production 2026-11-06:

```
co-bbb13600-5966-4bb4-a569-2df76c5abba8 | abiozen | Abiozen LLC | active
```

With one tenant, "which tenant owns this SKU" has one answer, and an unscoped read cannot cross a
boundary that does not exist yet. **That is a property of the data, not of the code.** It stops
holding the moment a second company row goes active, and nothing about adding that row would
announce this ticket.

## The compensating control, and its test

`resolveCompanyForReadSession` in `src/lib/office/context.js` refuses outright when more than one
active company exists, rather than defaulting to a row:

> `N active companies exist and this system has no user-to-company mapping, so which one this
> person may see is UNKNOWN. Refusing rather than showing a tenant that may not be theirs.`

So the system fails closed instead of guessing. Ruling 16 item 8 required that this be tested, and
section 6b of `check-migration-v3-db.js` now does, by inserting a second active company and
requiring the refusal:

```
ok    two active companies → the resolver REFUSES and says which answer is UNKNOWN
ok    with one active company it resolves, and to the right one
ok    second tenant restored — the refusal is the steady state while skus/suppliers are unscoped
```

Proved non-vacuous by mutation: disabling the `rows.length > 1` branch turns the first assertion red
(`FAIL the resolver returned a company while TWO are active`). A compensating control nobody
exercises is an assumption, and this one was an assumption until this test existed.

## What closing this requires

Not a migration I should write unprompted — it alters tables that carry seven months of live
product data, and ruling 11 item 6 is explicit that production database initialization does not
change without separate review. The work, for whoever is authorized to do it:

1. Add `company_id` to `skus` and `suppliers`, nullable at first.
2. Backfill to the single active company id, and verify the row counts match before and after.
3. Make the column `NOT NULL`, add the unique key `(id, company_id)` that composite foreign keys
   require, and point v3's SKU and supplier references at it.
4. Replace the resolver's refusal with a real membership model — a user-to-company mapping. The
   refusal is a stopgap that makes multi-tenancy *safe*; it does not make it *possible*.
5. Only then onboard a second company.

Step 4 is the one that is easy to skip, because by then the schema will look finished.

## Do not do this instead

Widening the resolver to pick the first active row, or to read a company from a request parameter,
would make the symptom disappear and the gap real. The refusal is load-bearing.
