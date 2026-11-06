# Migration risk report

**Ruling 29 item 4.** What `node scripts/migrate.js` could do to production data, and what is still
unverified.

Produced by `scripts/analyze-migration-risks.js` — a static scan of every statement the migrator
executes. It connects to nothing. Re-run it any time; it is part of no gate.

```
6 destructive · 19 mutating · 4 breaking · 13 weakening
8 further statements exist in --rollback branches the migrator never reaches
```

---

## 1. The three that deserve your attention

### 1.1 `UPDATE users SET role=…` — four statements, every run

`src/lib/db.js:625–628`, inside `initDB`:

```sql
UPDATE users SET role='dev_team'         WHERE role='dev';
UPDATE users SET role='procurement_team' WHERE role='procurement' OR role='procurement_lead';
UPDATE users SET role='sales_team'       WHERE role='sales';
UPDATE users SET role='support_team'     WHERE role='qc' OR role='marketing';
```

A legacy-taxonomy remap, idempotent in the sense that after the first run no rows match. **But it
has been running on every boot already** — this is not new behaviour introduced by moving
migrations out of boot; it is existing behaviour that is now visible because it runs in a named
step instead of inside a `.then()` chain on line 3.

**What to check:** if anybody has deliberately been given the role `procurement` or `marketing` in
production, this silently reassigns them. Step 5 of the release checklist will show you the row
counts; if `users` has anyone on an old role name, decide before migrating.

### 1.2 `ALTER TABLE sitenex_deals DROP COLUMN IF EXISTS referred_by`

`scripts/migrate-sitenex-rename.js:97`. The only `DROP COLUMN` in the chain.

It is a **no-op on production**, whose schema is already post-rename — and the step is now gated on
whether `partners` exists, so on your database it will be **skipped entirely**. `IF EXISTS` does not
make a drop safe; the gate does.

Immediately before it, `UPDATE sitenex_deals SET partner_id = … WHERE LOWER(referred_by) = …`
migrates the data into the new column first. Order is correct.

### 1.3 `DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2`

`src/lib/autonomy.js:378` — part of the kill-switch module's own API, reached with parameters, not
a blanket delete during migration. Listed because a `DELETE` in a migration path should never be
invisible.

---

## 2. Destructive statements that will not run

Six of the eight remaining live in `--rollback` branches, several behind a second flag,
`--i-understand-this-drops-tables`. `node scripts/migrate.js` passes no arguments, so none is
reachable.

| File | What |
|---|---|
| `scripts/migrate-registrations.js` | `DROP TABLE IF EXISTS …` × ROLLBACK_ORDER |
| `scripts/migrate-connectors.js` | `DROP TABLE IF EXISTS …` + version record delete |
| `scripts/migrate-intake.js` | `DROP TABLE IF EXISTS …` + version record delete |
| `src/lib/office/intake-schema.js` | `DELETE FROM source_connectors WHERE source_key='manual'` |

`migrate-registrations.js` additionally **refuses** its own rollback when
`verified_capabilities` holds rows whose kind only exists after the migration — rather than deleting
them to make the revert succeed. That is the right instinct and worth knowing it is there.

---

## 3. Breaking: renames

Four `RENAME` statements, all in `migrate-sitenex-rename.js` (`acbm_*` → `sitenex_*`, plus indexes,
triggers and functions). **Gated**: the step runs only when `partners` does not exist, and
`partners` is created by that script alone, so its presence is an exact record that the rename has
already happened. On production it will be skipped.

A rename is listed as *breaking* rather than *destructive* because it loses no data — it breaks
running code mid-deploy. Skipped, it cannot do that either.

---

## 4. Weakening: 13 statements

All `DROP CONSTRAINT` / `DROP INDEX` immediately followed by a re-creation — the standard idiom for
making a definition idempotent. Two are mine, widening constraints that were too narrow:

- `source_connectors_kind_check` now also permits `'manual'`, because the intake migration verifies
  the manual source has `kind='manual'` and explicitly **not** `'procurement'` — so a human paste
  does not appear on the coverage panel as an automated feed.
- `verified_capabilities` gains `UNIQUE (id, company_id)`, which the PRPA foreign keys require.

Neither removes a check; both widen a vocabulary that was incomplete.

---

## 5. Schema differences — **NOT YET MEASURED**

This is the gap ruling 29 item 4 is pointing at, and it is open.

| Source | Tables |
|---|---|
| A fresh database built by the migrator | **152** (measured) |
| Production, per the handoff document | ~137 (documented, not measured) |
| A fresh install before this work | ~66 (recorded in `ENG-001`) |

Those numbers do not reconcile, and **I cannot reconcile them without your database.** A fresh
install and production have already diverged once in this repository — that divergence is the whole
subject of `docs/tickets/ENG-001-fresh-install-schema-reproducibility.md`.

`scripts/verify-prod-dump.sh <dump>` closes this. It restores your backup, migrates it, and reports
the real differences. Until it has run, **every green result in this repository describes a database
this repository built**.

---

## 6. Recovery limitations — read before migrating

1. **The migration is additive, so rollback is a redeploy, not a database operation.** The previous
   application release runs against the new schema unchanged. Prefer that, always.

2. **There is no point-in-time recovery between your backup and the migration.** Railway's backup is
   a snapshot. Anything written between taking it and running the migration is not in it. Take the
   backup immediately before, not the night before.

3. **Dropping `federal_opportunities` destroys the human bid/no-bid decisions and the audit trail.**
   They are the only things in this product that cannot be re-derived from a re-import. Export
   first: `GET /api/prpa/tracker/export.csv`.

4. **The migration ledger starts empty.** `schema_migrations` is new. It will not retroactively tell
   you which of the 43 hand-run scripts were ever applied to production — the first run is the first
   record. That history is unrecoverable and the ledger stops it getting worse.

5. **One step is deliberately not re-runnable and is gated rather than fixed.** If `partners` were
   ever dropped, the rename step would run again and fail on its indexes. Unlikely, and worth
   knowing.

6. **A failed migration leaves the database partly migrated.** The migrator stops at the first
   required failure rather than continuing — later steps `ALTER` tables earlier steps create, and a
   second error would bury the first. Every step is idempotent, so the fix is to correct the cause
   and re-run, not to unwind.
