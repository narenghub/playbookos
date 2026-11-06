# ENG-003 — the application connects to Postgres as a superuser

**Class:** security · **Opened:** 2026-11-06 · **Status:** OPEN — structural control in place, privilege control impossible
**Raised by:** ruling 18 item 6 · **Blocks:** real privilege separation for scan verdicts, and RLS of any kind

## The constraint

`src/lib/office/context.js` records it:

> "the application connects as a superuser, which bypasses RLS even under FORCE ROW LEVEL SECURITY."

A Postgres superuser bypasses `GRANT`, `REVOKE` and row-level security entirely. So **no
in-database privilege separation is available to this application at all**, regardless of what
roles or grants are defined. Every control has to be a `CHECK` constraint or a `BEFORE` trigger,
because those are the only things that fire for a superuser.

## What this cost ruling 18 item 6

Item 6 asked that "only a trusted, authenticated scanner-result workflow may set security-sensitive
scan fields" and that "the ordinary application and AI evaluation workflows must not be able to
forge a clean verdict."

**The half that is delivered — structural separation.** `scan_status` can no longer be asserted. It
may only *reflect* a row in `document_scan_results`, which must name a provider, a delivery channel
(`eventbridge` or `guardduty_on_demand` — `application` and `ai` are not permissible values), a
provider event id, and the object version judged. The provider→internal status mapping is fixed in
the database as well as in JavaScript, so a `THREATS_FOUND` result cannot be recorded as `clean`.
Results are append-only. 15 assertions in `check-migration-v3-db.js` §7c prove each by attempting
it.

**The half that is not — privilege separation.** Because the connection is a superuser, a code path
that wanted to forge a verdict could insert a fabricated `document_scan_results` row with
`channel='eventbridge'` and then reflect it. Nothing in the database can stop that, and no trigger
can tell a fabricated row from a real one.

So the control removes the **accident** and the **casual path**, and leaves a row naming its channel
and event id behind. It does not stop code that is already running as us and means to lie. That
distinction is the whole content of this ticket, and anyone reading §7c's green output without
reading this file will overestimate what has been proved.

## What closing it requires

A production change, so not done here, and ruling 11 item 6 applies: production database
initialization does not change without separate review.

1. Create a non-superuser role for the application, with `GRANT`s covering exactly what it uses.
2. Create a second role for the scanner-result ingestion worker. Grant it `INSERT` on
   `document_scan_results`; **revoke `INSERT` on that table from the application role.** This is
   the step that makes item 6 real rather than structural.
3. Point `DATABASE_URL` at the application role and the ingestion worker at its own credential.
4. Only then is RLS available as a mechanism; the `MATCH FULL` composite foreign keys and the
   triggers stay regardless, since they are what caught the cross-tenant cases.
5. Re-run the whole verification suite against the restricted role. Expect failures: scripts that
   create and drop tables will not work as a limited role, and that is the point of running them.

Step 2 is the one with the security value. Steps 1 and 3 are the ones that will take the time, and
it will be tempting to do them, see the tests pass, and stop.

## Do not do this instead

Adding a shared secret that the ingestion path passes to the database (`SET LOCAL
prpa.scan_writer = '…'`) looks like authentication and is not: the secret would live in the same
codebase and process group as the application it is meant to exclude, so any path that can write
the table can also set the variable. It would convert a documented gap into an undocumented one.
