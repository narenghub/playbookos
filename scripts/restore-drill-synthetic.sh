#!/usr/bin/env bash
# ── SYNTHETIC RESTORE DRILL — PROVE THE INSTRUMENT BEFORE SPENDING A REAL DUMP ─
#
#   scripts/restore-drill-synthetic.sh
#   echo $?
#
# M7 gate item 5, the half that does not need production. `verify-restore.js` and
# `verify-prod-dump.sh` are both written and neither has ever been executed end to end, because
# both need a production dump that only the owner can take. So the first time anyone runs the
# recovery procedure would be in the middle of needing it — with a real dump, under pressure, on an
# instrument of unknown quality.
#
# This runs the WHOLE procedure against a synthetic database instead: build the real schema, insert
# synthetic rows, dump it, restore into a separate disposable cluster, boot the real application
# against the restored copy, and assert it stays up. Same tooling, same commands, no production.
#
# ── WHAT IT PROVES, AND WHAT IT CANNOT ───────────────────────────────────────
#
# PROVES: the schema round-trips through pg_dump/pg_restore; the application boots on a restored
#         database and stays up; autonomy_stops survive a restore (a restored copy with the STOPs
#         missing would come back UNCONTAINED, which is the failure nobody would be looking for);
#         the dump never lands in the git working tree; and roughly how long each phase takes,
#         which is the only honest input to an RTO figure.
#
# CANNOT PROVE: that PRODUCTION's actual schema restores. Production has drifted from the migrator
#         in at least one known way — email_log.sent_at is TEXT there and TIMESTAMPTZ in six
#         fixtures — so a synthetic dump is built from what the code BELIEVES the schema is. That
#         gap is the entire reason the real drill still has to happen. This de-risks it; it does
#         not replace it.
#
# Nothing here reads DATABASE_URL. The only databases it touches are two it creates in a temp
# directory and destroys on exit. The dump is written OUTSIDE the repository.
#
# Exit: 0 the full procedure worked · 1 a phase failed · 3 could not run

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRILL_DIR="$(mktemp -d /var/tmp/restore-drill-XXXXXX)"
PGPORT=55971
SRC="$DRILL_DIR/src"
DUMP="$DRILL_DIR/synthetic-$(date -u +%Y%m%dT%H%M%SZ).dump"

fail=0
say()  { printf '  %s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  FAIL  %s\n' "$*"; }
head_() { printf '\n  ── %s ──\n\n' "$*"; }

PGBIN=""
for d in /usr/lib/postgresql/18/bin /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin \
         /usr/lib/postgresql/15/bin /usr/lib/postgresql/14/bin; do
  if [ -x "$d/initdb" ] && [ -x "$d/postgres" ] && [ -x "$d/pg_dump" ]; then PGBIN="$d"; break; fi
done
if [ -z "$PGBIN" ]; then
  say "skip  no directory holds initdb, postgres AND pg_dump together"
  say "SKIP  the restore drill did NOT run — this proved nothing."
  rm -rf "$DRILL_DIR"
  exit 3
fi

AS_PG=0
[ "$(id -u)" = "0" ] && AS_PG=1
run() { if [ "$AS_PG" = "1" ]; then su postgres -c "$1"; else sh -c "$1"; fi; }

cleanup() {
  run "PATH=$PGBIN:\$PATH pg_ctl -D $SRC/data -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$DRILL_DIR"
}
trap cleanup EXIT

echo
echo "══ SYNTHETIC RESTORE DRILL ══"
say "postgres  : $PGBIN"
say "workspace : $DRILL_DIR   (outside the repository, removed on exit)"

# ── 1. A SOURCE DATABASE WITH THE REAL SCHEMA ───────────────────────────────
head_ "1. build a source database using the real migrator"
mkdir -p "$SRC"
[ "$AS_PG" = "1" ] && chown -R postgres "$DRILL_DIR"
t0=$(date +%s)
if ! run "PATH=$PGBIN:\$PATH initdb -D $SRC/data -U postgres -E UTF8 --locale=C" >"$DRILL_DIR/initdb.log" 2>&1; then
  bad "initdb failed"; tail -5 "$DRILL_DIR/initdb.log"; exit 1
fi
if ! run "PATH=$PGBIN:\$PATH pg_ctl -D $SRC/data -l $SRC/pg.log -o '-k $SRC -p $PGPORT -c listen_addresses=' start -w" >/dev/null 2>&1; then
  bad "the source cluster did not start"; tail -5 "$SRC/pg.log" 2>/dev/null; exit 1
fi
# `sslmode=disable` is not decoration. There are ELEVEN independent SSL decisions outside
# src/lib/db.js; seven test the URL for this string and four ignore it entirely. db.js now also
# recognises a unix socket structurally. Including the parameter satisfies both kinds, and the DR
# runbook must carry it for any local restore target or the migration dies partway through on a
# message about SSL that reads like a broken server.
SRC_URL="postgresql://postgres@localhost/postgres?host=$SRC&port=$PGPORT&sslmode=disable"
ok "source cluster up on a unix socket with no TCP port"

# The migrator, run exactly as a deployment would run it.
#
# ADMIN_EMAIL / ADMIN_PASSWORD are required, and that is a DR finding rather than a nuisance:
# initDB REFUSES to finish on a database with no admin user unless they are set, so a recovery into
# a fresh database stops dead at step one without them. The spelling of the placeholders is copied
# from verify-restore.js deliberately — check-secrets.js cannot distinguish an invented-looking
# credential from a real one, and a scanner that cries wolf gets ignored.
cd "$ROOT"
if MIGRATION_DATABASE_URL="$SRC_URL" DATABASE_URL="$SRC_URL" JWT_SECRET=drill \
     ADMIN_EMAIL='restore-drill@example.invalid' ADMIN_PASSWORD='REPLACE_ME_NOT_A_SECRET' \
     node scripts/migrate.js --no-seeds >"$DRILL_DIR/migrate.log" 2>&1; then
  ok "scripts/migrate.js --no-seeds applied the full schema"
else
  bad "the migrator failed against a fresh database"
  tail -20 "$DRILL_DIR/migrate.log"
fi

psql_src() { run "PATH=$PGBIN:\$PATH psql -tAq -U postgres -h $SRC -p $PGPORT -d postgres -c \"$1\""; }

TABLES=$(psql_src "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")
say "tables created: ${TABLES:-0}"
[ "${TABLES:-0}" -gt 30 ] && ok "a plausible schema exists" || bad "only ${TABLES:-0} tables — the migrator did not build the schema"

# ── 2. SYNTHETIC ROWS, INCLUDING THE THING A RESTORE MUST NOT LOSE ──────────
head_ "2. insert synthetic rows — no real data anywhere"
psql_src "INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by) VALUES
  ('capability','email.send','DRILL synthetic stop — not a real containment record','drill'),
  ('capability','whatsapp.send','DRILL synthetic stop','drill'),
  ('global','','DRILL synthetic global stop','drill')" >/dev/null 2>&1 \
  && ok "three synthetic STOP rows inserted" || bad "could not insert STOP rows"

psql_src "INSERT INTO users (id,email,name,role) VALUES
  ('drill-1','drill-one@example.invalid','Drill One','admin'),
  ('drill-2','drill-two@example.invalid','Drill Two','sales_team')" >/dev/null 2>&1 \
  && ok "two synthetic users inserted (example.invalid — unroutable by RFC 2606)" \
  || bad "could not insert users"

STOPS_BEFORE=$(psql_src "SELECT COUNT(*) FROM autonomy_stops")
USERS_BEFORE=$(psql_src "SELECT COUNT(*) FROM users")
say "before dump — autonomy_stops: ${STOPS_BEFORE:-?}  users: ${USERS_BEFORE:-?}"

# ── 3. THE DUMP ─────────────────────────────────────────────────────────────
head_ "3. take the dump, exactly as the runbook says to"
t1=$(date +%s)
if run "PATH=$PGBIN:\$PATH pg_dump --format=custom --no-owner --no-privileges -U postgres -h $SRC -p $PGPORT -d postgres -f $DUMP" >"$DRILL_DIR/dump.log" 2>&1; then
  t2=$(date +%s)
  SIZE=$(du -h "$DUMP" 2>/dev/null | cut -f1)
  ok "pg_dump --format=custom --no-owner --no-privileges → ${SIZE:-?} in $((t2-t1))s"
else
  bad "pg_dump failed"; tail -5 "$DRILL_DIR/dump.log"
fi

# The dump must not be anywhere near the working tree. preflight check 'no database dump is sitting
# in the working tree' holds the repo; this asserts the drill itself did not put one there.
case "$DUMP" in
  "$ROOT"/*) bad "THE DUMP IS INSIDE THE REPOSITORY: $DUMP" ;;
  *)         ok "the dump is outside the repository" ;;
esac
if node scripts/check-no-database-dumps.js >/dev/null 2>&1; then
  ok "check-no-database-dumps.js still passes — the working tree is clean"
else
  bad "check-no-database-dumps.js now fails — the drill contaminated the working tree"
fi

# ── 4. RESTORE, VIA THE REAL INSTRUMENT ─────────────────────────────────────
head_ "4. restore into a SEPARATE disposable cluster and boot the application"
say "running: node scripts/verify-restore.js <dump>"
say "(it builds its own cluster, restores, boots server.js, and asserts it stays alive)"
say "--expect-stops=3 makes STOP survival a hard assertion rather than a report"
echo
t3=$(date +%s)
JWT_SECRET=drill node scripts/verify-restore.js "$DUMP" --expect-stops=3 >"$DRILL_DIR/restore.log" 2>&1
RC=$?
t4=$(date +%s)
# The containment section is the one a reader must actually see, and a bare `tail` buried it —
# which is this repo's oldest mistake (reading the tail of a report instead of its verdict). Shown
# explicitly, then the tail for context. The VERDICT is $RC, read below, never this text.
awk '/2b\. CONTAINMENT/,/^────.*$/{print}  /stop rows restored|CONTAINED|NOT ASSERTED/{print}' \
  "$DRILL_DIR/restore.log" | sed 's/^/    /' | head -14
echo
sed 's/^/    /' "$DRILL_DIR/restore.log" | tail -18
echo
if [ "$RC" = "0" ]; then
  ok "verify-restore.js exit 0 — restored, and the application came up and stayed up ($((t4-t3))s)"
elif [ "$RC" = "2" ] || [ "$RC" = "3" ]; then
  bad "verify-restore.js did NOT execute (exit $RC) — the instrument is still unproven"
else
  bad "verify-restore.js exit $RC — the restore procedure does not work"
fi

# ── 5. TIMINGS — THE ONLY HONEST INPUT TO AN RTO ────────────────────────────
head_ "5. timings"
say "schema build      : $((t1-t0))s"
say "dump              : $((t2-t1))s"
say "restore + boot    : $((t4-t3))s"
say "TOTAL             : $((t4-t0))s"
say ""
say "These are synthetic-scale numbers on a container. They bound the PROCEDURE, not the data:"
say "production's dump and restore scale with its row count, and 3,910 email_log rows plus the"
say "research tables are not represented here. Treat this as a floor, never as the RTO."

echo
if [ "$fail" -gt 0 ]; then
  echo "FAIL  $fail phase(s) of the restore drill did not work."
  exit 1
fi
echo "PASS  the full recovery procedure works end to end on synthetic data."
echo "      The instrument is proven. A real production dump is still required to prove"
echo "      PRODUCTION's schema restores — see the note at the top of this file."
exit 0
