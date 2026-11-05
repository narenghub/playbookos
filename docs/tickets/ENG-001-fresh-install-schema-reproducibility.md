# ENG-001 — A fresh install cannot reproduce the production schema

**Raised:** 2026-11-05, ruling 11 item 6
**Severity:** high — this is a disaster-recovery defect, not a tidiness problem
**Status:** OPEN, not scheduled
**Constraint from the ruling:** *"Do not change production database initialization without a
separate review."* Nothing in this ticket may be acted on without that review.

---

## The finding

`server.js` boots and calls `initDB()` → `migrateSchemas()` in `src/lib/db.js`. There are **20+
`scripts/migrate-*.js` files and not one of them is in that boot chain.** They are run by hand,
once, against whichever database needed them.

Measured, both numbers independently confirmed on 2026-11-05:

| | tables |
|---|---|
| production (`SELECT count(*) … table_schema='public'`) | **125** (now 137 after `2026-11-05.connectors.v1`) |
| a fresh deploy against an empty database | **~66** |

So **a new environment built from this repository is not the application that is running.** The
difference is roughly half the schema: `fda_establishments`, `labs`, `test_catalogue`, `lab_tests`,
the office kernel, the connector tables and more arrive only via scripts somebody has to know
about and run in an order nobody has written down.

## Why it matters, concretely

1. **Production's schema is reproducible only from a backup.** That is the finding that made the
   restore test load-bearing rather than ceremonial, and it is why
   `claude/gate0-restore-verification-record.md` ends the way it does. If the database is lost and
   the backup is unusable, the schema cannot be rebuilt from source — only guessed at.
2. **A staging environment cannot be trusted.** Anything verified against a fresh install was
   verified against a different schema, so a green check there says less than it appears to.
3. **It already caused an outage-class bug.** A fresh deployment could not boot at all:
   `migrateSchemas()` is one multi-statement query in a single try/catch that only logs, and four
   `ALTER TABLE daily_tasks` statements sat ~45 lines *before* the `CREATE TABLE` for that table.
   On an empty database the ALTER failed, Postgres aborted the entire block, dozens of tables were
   never created, and the process called `process.exit(1)` **after `app.listen` had already
   bound** — so `/health` answered before it died. Fixed by moving the ALTERs, but the shape that
   allowed it is untouched: one giant block, one swallowed error, order dependent on line numbers.

## What is NOT being proposed

Not a rewrite of `initDB()`, and not wiring the `migrate-*.js` scripts into startup. Both would
change production database initialization, which this ruling forbids without separate review — and
the connector migration was deliberately built as an operator-run versioned runner for exactly that
reason (ruling 10 item 3). Automatic migration on boot means every deploy is a migration, with no
gate and no way to read the result before the application starts serving.

## Proposed work, for review

1. **Measure the gap precisely.** A script that builds a fresh database from the repository, lists
   its tables, and diffs them against a production table list, printing what is missing and which
   script creates it. Verdict is the exit code. This is read-only and can be done without any
   production change — it should be done first, because every number above deserves to be
   re-measured rather than trusted.
2. **Write down the order.** The migrations have dependencies (`companies` before the connector
   tables; `uq_agent_runs_run_company` before the composite FKs). That order currently exists only
   as whatever sequence someone used. It should be a list in the repository, verified by (1).
3. **Make `migrateSchemas()` fail loudly.** Split the single multi-statement query so one failing
   statement does not abort the rest silently, and make a failure non-zero rather than logged.
   The current shape is the direct cause of the boot defect above. **This is a change to production
   database initialization and needs the separate review.**
4. **Then decide** whether the remaining `migrate-*.js` scripts become versioned runners like
   `scripts/migrate-connectors.js`, or whether a single ordered bootstrap is appropriate for new
   environments only. That is a design decision, not an implementation detail, and it is the one
   genuinely needing a ruling.

## Acceptance

- a fresh install's table count equals production's, demonstrably, from a diff and not an assertion
- the diff script exits non-zero while a gap exists, so the gap cannot quietly return
- `migrateSchemas()` cannot abort a block and report success
- no change to production initialization without the separate review this ruling requires
