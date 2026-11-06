# ENG-003 — the application connects to Postgres as a superuser

**Class:** security · **Opened:** 2026-11-06 · **Status:** OPEN — **PRODUCTION RELEASE BLOCKER** (ruling 19 item 5)
**Design:** verified on a disposable cluster — `scripts/check-db-role-separation.js`, 31 assertions, exit 0
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


---

## The design, verified rather than proposed (ruling 19 item 5)

`scripts/check-db-role-separation.js` builds the v3 schema on a disposable cluster, creates the three
roles below with the exact grants intended for production, and then attempts what each must not be
able to do. 31 assertions, exit 0, no production involvement and no AWS account. It is part of
preflight, so the design cannot quietly rot.

### The mechanism: PostgreSQL column-level UPDATE grants

```sql
GRANT UPDATE (id, company_id, submitted_by, …, integrity_ok) ON intake_documents TO playbookos_app;
GRANT UPDATE (scan_status, scan_version_id, scan_provider, scan_provider_status,
              scan_detail, scanned_at)                        ON intake_documents TO playbookos_scanner;
```

The application gets UPDATE on every column of `intake_documents` **except** the six that carry a
security verdict; the scanner gets UPDATE on **only** those. The application then cannot write a
verdict because it lacks the privilege — not because a trigger declined. That is the whole
difference between what ruling 18 item 6 delivered and what it asked for.

### Three roles, none of them a superuser

| Role | May | May not |
|---|---|---|
| `playbookos_migrator` | DDL (needs `GRANT CREATE ON SCHEMA public`) | run the application |
| `playbookos_app` | SELECT/INSERT/UPDATE on business tables; INSERT + non-verdict UPDATE on `intake_documents` | write any verdict column · INSERT into `document_scan_results` · any DDL |
| `playbookos_scanner` | INSERT into `document_scan_results`; UPDATE of the six verdict columns | touch requirements, authorizations, download grants, or any other column · any DDL |

Demonstrated refusals include `DROP TRIGGER` for both the app and the scanner — a role that cannot
drop a trigger cannot disarm the guards above it, which is the failure mode that makes the current
superuser connection load-bearing.

### Two findings the demonstration produced

**PostgreSQL 15 stopped granting `CREATE` on schema `public` to `PUBLIC`.** The first run failed
with `permission denied for schema public` for the migrator. That needs an explicit
`GRANT CREATE ON SCHEMA public TO playbookos_migrator` — exactly the sort of thing that otherwise
surfaces midway through a production cutover.

**The blocker is not the grants. It is `server.js` line 3.** It chains about twelve migrations
before the server listens — `initDB`, `initPhase2`, `migrateSchemas`, `migrateAutonomy`, the
supplier-RFQ and RFQ-identity-guard migrations, `migrateRuns`, `migrateOffice`,
`migrateResearchIntelligence` and two phase-3 migrations, then three seeders — issuing `CREATE
TABLE` and `ALTER TABLE`. The test confirms the app role cannot run those statements, so pointing
`DATABASE_URL` at it today would fail **at startup**, not at runtime.

So the work is, in order:

1. Extract the boot-time migration chain into a migration entrypoint, run as `playbookos_migrator`
   as a **separate deploy step**. This is the blocker and it is where the time goes.
2. Apply the grants above. Proven; the easy part.
3. Switch `DATABASE_URL` to `playbookos_app` and give the scanner worker its own credential.
4. Keep a superuser credential for break-glass only, out of the application's environment.
5. Re-run the whole verification suite against the restricted roles, expecting the scripts that
   create and drop tables to fail — that is what running them proves.

Step 1 is what will be tempting to defer. Until it is done, every control in the PRPA schema is a
trigger that the connection running the application is privileged to drop.

---

## 2026-11-06 — step 1 is DONE (ruling 27 item 5)

**"Step 1 is what will be tempting to defer."** It was not deferred. The boot chain is gone.

`server.js` line 3 is now a READ. It calls `src/lib/schema-ready.js`, which issues only `SELECT`s —
`to_regclass` for each required table, `information_schema.columns` for the columns whose absence
means a migration applied only partly — and exits non-zero with the command to run if anything is
missing. No `CREATE`, no `ALTER`, no `INSERT` anywhere in the boot path.

The chain moved to `src/lib/migrate-all.js`, run by `scripts/migrate.js` as its own process against
`MIGRATION_DATABASE_URL`. **47 steps**, each recorded in a new `schema_migrations` ledger.

### What proves it

`scripts/check-startup-without-ddl.js` — 28 assertions, exit 0, on a disposable cluster:

- the migrator runs as the owner and the readiness check passes
- `playbookos_app` is created `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, with no `CREATE` on
  schema `public`
- **the server's own readiness check passes as that role**, and `assertReadyOrExit` does not exit
- every DDL statement attempted as that role is refused: `CREATE TABLE`, `ALTER TABLE`, `DROP
  TABLE`, `CREATE INDEX`, `CREATE FUNCTION`, `TRUNCATE` — each for the right reason, checked
- the migrator itself fails as that role, at the first step that uses the passed connection
- and the application does its **real work** restricted: imports 80 records, assesses them, reads
  the board, confirms a deadline, appends to the audit trail, and produces the Excel export

### What the chain's extraction exposed

Three things that made the old arrangement look like it worked:

1. **43 `migrate-*.js` scripts were in no chain at all** — 57 tables existed only if somebody
   remembered to run them. Now 27 steps inside the migrator, with
   `scripts/check-migration-coverage.js` failing the build on any gap.
2. **The PRPA schema could never have applied to a real database**: `verified_capabilities` lacked
   the composite `UNIQUE (id, company_id)` its foreign key needs, and the v3 seed violated three
   constraints on `source_connectors`. Both had only ever run against a disposable stub.
3. **There was no migration ledger.** Three scripts read `schema_migrations`; nothing created it.
   "Which migrations has this database had?" had no answer anywhere.

### Why this ticket stays OPEN

The CODE no longer requires a superuser. The DEPLOYMENT still uses one: production connects with a
single `DATABASE_URL` belonging to a superuser role. Closing it needs steps 2–4 above — the grants,
the URL split, and the scanner credential — which are environment changes on the Railway Postgres,
not code. Exact statements: `docs/deploy/prpa-cloud-handover.md` §4.

Step 5 is partly done: the restricted-role check re-runs the PRPA paths and expects DDL to fail,
which is what running it proves. The rest of the suite has not been run against restricted roles.
