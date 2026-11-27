// ── A WORKER'S GRANTS ARE WRITE-ONCE, AND THE DATABASE IS WHAT SAYS SO ──────
//
// Owner, sixth directive, 2026-11-27: *"Do not treat the absence of UPDATE statements as proof of
// database-enforced immutability."*
//
// **I had. All of it was false, and I measured it by attempting what I had claimed was impossible:**
//
//   UPDATE worker_identities SET synthetic_only = false  →  SUCCEEDED
//   UPDATE worker_identities SET capabilities = ARRAY['exec:hardware']  →  SUCCEEDED
//
// So migration 62's restriction was bypassable by one statement, and so was the capability grant —
// which is worse, because that grant has been load-bearing since B4.1 and Decision 4 of
// 2026-11-25, and this repository's own tracker describes it as *"no module updates the column
// afterwards"*. That sentence is true and it is an **inventory of today's code**, not a property of
// the data: it says nothing about the next module, a migration, a psql session, or a check that
// widens a fixture because widening was easy. I wrote "write-once" on the strength of a grep
// finding nothing, which is rule 2 — *did I measure this, or did I look and not find it* — in the
// one place where the answer decides whether a worker can be handed real business records.
//
// **What this trigger refuses, and what it deliberately does not.** Only the two grant columns are
// frozen. Everything else about an identity must stay writable, and each for a reason:
//
//   revoked_at / revoked_by / revoked_reason   revocation is the emergency control; freezing it
//                                              would be a far worse defect than the one being fixed
//   last_seen_at                               written on every heartbeat
//   secret_current / secret_previous / scheme  rotation
//
// A row can therefore still be revoked, rotated and heartbeaten; it simply cannot be made more
// powerful than the enrolment that created it. **Widening is not forbidden — it is relocated**: it
// happens by issuing a new enrolment token, which is an authorized act with an operator on it, and
// not by editing a row.
//
// `IS DISTINCT FROM` rather than `<>` on purpose: `<>` is NULL when either side is NULL, so a
// change from NULL to a value would have passed straight through the guard. That is the same
// three-valued-logic trap that made the first version of the claim-time backlog count wrong.

'use strict';

const IDENTITY_SCHEMA = require('./identity-schema');

const FN = 'worker_identity_grants_are_write_once';
const TRIGGER = 'trg_worker_identity_grants_write_once';

async function installGrantImmutability(query) {
  const table = IDENTITY_SCHEMA.TABLES.identities;
  const present = await query(
    `SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${table}`]);
  if (!present.rows[0].present) return { ok: true, installed: false, reason: 'table absent' };

  // The column must exist before the trigger body references it, or every UPDATE fails at runtime
  // with a missing-column error that reads like a broken deploy.
  const cols = await query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = $1 AND column_name IN ('capabilities', 'synthetic_only')`, [table]);
  const have = new Set(cols.rows.map((r) => r.column_name));
  if (!have.has('capabilities') || !have.has('synthetic_only')) {
    return { ok: true, installed: false, reason: 'grant columns not both present yet' };
  }

  await query(
    `CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger AS $fn$
     BEGIN
       IF NEW.capabilities IS DISTINCT FROM OLD.capabilities THEN
         RAISE EXCEPTION
           'worker_identities.capabilities is write-once (worker %): a grant travels on the '
           'operator-issued enrollment token and cannot be edited afterwards. Enrol a new identity.',
           OLD.id
           USING ERRCODE = 'check_violation';
       END IF;
       IF NEW.synthetic_only IS DISTINCT FROM OLD.synthetic_only THEN
         RAISE EXCEPTION
           'worker_identities.synthetic_only is write-once (worker %): widening a worker to reach '
           'non-synthetic data is an authorized enrollment, not an UPDATE.',
           OLD.id
           USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;
     END
     $fn$ LANGUAGE plpgsql`);

  await query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON ${table}`);
  await query(
    `CREATE TRIGGER ${TRIGGER}
       BEFORE UPDATE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${FN}()`);

  // ── AND THE INSERT PATH, WHICH THE UPDATE TRIGGER DOES NOT COVER ─────────
  //
  // Owner: *"Inspect every caller of createEnrollmentToken and every direct worker identity
  // creation path."* Doing that found a second route to an unrestricted worker that the guard above
  // is blind to: `INSERT INTO worker_identities (…, synthetic_only) VALUES (…, false)` never
  // updates anything. Two checks did exactly that, bypassing the token entirely.
  //
  // The database cannot verify an administrator, so it enforces the thing it CAN see: an
  // unrestricted identity must have come through the enrolment exchange, which is the only writer
  // that stamps `enrolled_by` as `enrollment:<digest>`. A restricted identity may be inserted
  // directly — it has no privilege to protect — so fixtures that need an ordinary worker are
  // untouched, and anything wanting a widened one has to go through the path that checks an
  // operator. **This is a provenance requirement, not an authorization check**, and it is stated
  // that way rather than described as one.
  await query(
    `CREATE OR REPLACE FUNCTION ${FN}_insert() RETURNS trigger AS $fn$
     BEGIN
       IF NEW.synthetic_only IS FALSE AND
          (NEW.enrolled_by IS NULL OR NEW.enrolled_by NOT LIKE 'enrollment:%') THEN
         RAISE EXCEPTION
           'an unrestricted worker identity (synthetic_only = false) may only be created by the '
           'enrollment exchange, which records enrolled_by as enrollment:<digest> and requires an '
           'administrator on the token. Direct INSERT of a widened identity is refused (worker %).',
           NEW.id
           USING ERRCODE = 'check_violation';
       END IF;
       IF NEW.capabilities && ARRAY['exec:hardware','exec:gui']::text[] AND
          (NEW.enrolled_by IS NULL OR NEW.enrolled_by NOT LIKE 'enrollment:%') THEN
         RAISE EXCEPTION
           'exec:hardware and exec:gui may only be granted through the enrollment exchange '
           '(worker %).', NEW.id
           USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;
     END
     $fn$ LANGUAGE plpgsql`);
  await query(`DROP TRIGGER IF EXISTS ${TRIGGER}_insert ON ${table}`);
  await query(
    `CREATE TRIGGER ${TRIGGER}_insert
       BEFORE INSERT ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${FN}_insert()`);

  return { ok: true, installed: true, trigger: TRIGGER, insertTrigger: `${TRIGGER}_insert` };
}

module.exports = { installGrantImmutability, FN, TRIGGER };
