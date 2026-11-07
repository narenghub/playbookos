-- ── LEAST-PRIVILEGE PRODUCTION ROLES ────────────────────────────────────────
--
-- Ruling 29 item 5: prepared, NOT applied. Nothing in this repository runs this file. You run it,
-- once, against the Railway Postgres, when you are ready.
--
-- WHAT IT DOES
--   Creates one role for the application that cannot change the schema, and leaves the existing
--   superuser as the migrator. That is what closes ENG-003: today the application connects as a
--   superuser, and a superuser bypasses GRANT and row-level security entirely, so no in-database
--   privilege separation is possible however the grants are written.
--
-- WHAT IT DOES NOT DO
--   It does not drop anything, revoke anything from your existing role, or change any data. The
--   only REVOKE is against PUBLIC and against the new role itself, before granting it back exactly
--   what it needs.
--
-- NO PASSWORD APPEARS IN THIS FILE, AND NONE SHOULD BE TYPED INTO IT
--   An earlier version of this file said "replace <<<PUT A NEW PASSWORD HERE>>> on line 38". That
--   instruction was wrong: it put a live production password into a tracked file in a PUBLIC
--   repository, one `git add -A` from being published, and into the editor's undo history and any
--   backup the editor keeps besides. The role is now created with NO password, and the password is
--   set interactively afterwards, so the value never exists in a file, in shell history, or in a log.
--
-- BEFORE YOU RUN IT
--   1. Have the backup from step 2 of the release checklist already downloaded.
--   2. Nothing else. Do not generate a password yet — step 3 below prompts for it.
--
-- HOW TO RUN IT  (psql, from your own machine — not the Railway "Query" tab)
--   The Railway Data -> Query tab cannot do step 3: \password is a psql command, not SQL. Running
--   this file there would leave you setting the password with an SQL statement containing the
--   plaintext, which is the problem this file now avoids.
--
--     1. Copy the superuser connection string from Railway -> Postgres -> Variables. Do not paste
--        it onto a command line: `psql "<string>"` puts the password in your shell history.
--        Instead let psql prompt you for it:
--
--          read -rs PGPASSWORD && export PGPASSWORD   # paste the password, press Enter, nothing echoes
--          psql -h <host> -p <port> -U postgres -d railway
--
--     2. At the psql prompt:        \i docs/deploy/prod-roles.sql
--     3. Then, still in psql:       \password playbookos_app
--        It prompts twice, echoes nothing, hashes the password in the client, and sends only the
--        SCRAM verifier — so even a server with log_statement=all records no plaintext. psql keeps
--        \password out of its own history.
--     4. Leave psql, then clear the variable:   unset PGPASSWORD
--
-- AFTER YOU RUN IT
--   Set these two in the Railway Variables UI by typing or pasting into the field — not with a
--   `railway variables set ...` command, which would put a production password into your shell
--   history, and not in a file:
--     MIGRATION_DATABASE_URL = the EXISTING superuser connection string
--     DATABASE_URL           = the same string with the user and password swapped for
--                              playbookos_app and the password you set with \password
--
--   Railway Variables is a secret store, and it is the ONLY place that password should come to
--   rest. It does not belong in a chat, a document, a commit, a screenshot or a terminal.
--
--   Then run the migration as a deploy step BEFORE the app starts:  node scripts/migrate.js
--   scripts/migrate.js:53 reads MIGRATION_DATABASE_URL in preference to DATABASE_URL, which is
--   what makes the migration run as the migrator and the application run as playbookos_app.
--
--   ONE ORDERING TRAP. Setting DATABASE_URL to playbookos_app takes effect on the next deploy.
--   If that deploy happens before the migration step is in place, the app boots as a role with no
--   CREATE privilege against a schema that has not been migrated — and src/lib/schema-ready.js
--   refuses to start rather than attempting DDL it cannot perform. That is the designed refusal,
--   not an outage to debug: run the migration, then let the app start.
--
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. The application role. No superuser, no DDL, no RLS bypass.
--    NOINHERIT so it cannot pick up privileges from any role it is later added to by accident.
--    Created with NO password: a role with no password cannot be logged into at all, so this is the
--    safe intermediate state. `\password playbookos_app` (step 3 above) is what makes it usable,
--    and until you run it nothing can connect as this role.
CREATE ROLE playbookos_app
  LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- 2. PostgreSQL 15 already stopped granting CREATE on schema public to PUBLIC. This is for a
--    database restored from an older dump, where PUBLIC may still hold it — in which case the new
--    role could create tables and the separation would be decorative.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL    ON SCHEMA public FROM playbookos_app;

-- 3. What the application may actually do: read and write rows. Not define them.
GRANT USAGE ON SCHEMA public TO playbookos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO playbookos_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO playbookos_app;

-- 4. And the same for tables a FUTURE migration creates, so this file does not have to be re-run
--    after every release. Without this, the next migration's new tables would be invisible to the
--    application and every request touching them would fail with "permission denied".
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO playbookos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO playbookos_app;

COMMIT;

-- ── VERIFY, as playbookos_app ───────────────────────────────────────────────
-- Connect with the new credentials and run these three. All three answers must be as stated, and
-- if any is not, the separation is not in place and ENG-003 is still open.
--
--   SELECT current_user;
--     -> playbookos_app
--
--   SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
--     FROM pg_roles WHERE rolname = current_user;
--     -> f, f, f, f        (four falses)
--
--   SELECT has_schema_privilege(current_user, 'public', 'CREATE');
--     -> f
--
-- And the one that proves it rather than describing it — this MUST fail with
-- "permission denied for schema public":
--
--   CREATE TABLE eng003_probe (id int);
--
-- If that statement SUCCEEDS, drop the table and stop: the role is not restricted.
--
--   DROP TABLE eng003_probe;

-- ── ROLLBACK, if you need to undo this ──────────────────────────────────────
-- Point DATABASE_URL back at the superuser connection string and redeploy. The role below can then
-- be removed; it owns nothing, so nothing is lost with it.
--
--   REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM playbookos_app;
--   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM playbookos_app;
--   REVOKE ALL ON SCHEMA public FROM playbookos_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM playbookos_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM playbookos_app;
--   DROP ROLE playbookos_app;
--
-- Reverting the role does NOT revert the schema. The migration is additive and the previous
-- application release runs against the new schema unchanged, so a bad deploy is recovered by
-- redeploying the previous image, not by touching the database.
