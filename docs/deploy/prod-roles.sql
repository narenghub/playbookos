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
-- BEFORE YOU RUN IT
--   1. Replace <<<PUT A NEW PASSWORD HERE>>> on line 38 with a freshly generated password.
--      Generate it on your own machine:  openssl rand -base64 24
--      Do not reuse the superuser password. Do not paste it into a chat, a file, or a document.
--   2. Have the backup from step 2 of the release checklist already downloaded.
--
-- HOW TO RUN IT
--   Railway -> your project -> the Postgres service -> "Data" tab -> Query
--   (or psql with the superuser connection string Railway gives you)
--
-- AFTER YOU RUN IT
--   Set, in Railway -> Variables:
--     MIGRATION_DATABASE_URL = the EXISTING superuser connection string
--     DATABASE_URL           = the same string with the user and password swapped for
--                              playbookos_app and the password you chose above
--   Then run the migration as a deploy step BEFORE the app starts:  node scripts/migrate.js
--
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. The application role. No superuser, no DDL, no RLS bypass.
--    NOINHERIT so it cannot pick up privileges from any role it is later added to by accident.
CREATE ROLE playbookos_app
  LOGIN PASSWORD '<<<PUT A NEW PASSWORD HERE>>>'
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
