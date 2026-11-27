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
  // ── BOUND TO AN ACTUAL TOKEN, NOT TO A CORRECTLY FORMATTED STRING ────────
  //
  // Owner, Workstream A.1: *"Verify whether a direct INSERT can fabricate
  // enrolled_by = enrollment:<digest>. Do not mistake a correctly formatted provenance value for
  // authenticated enrollment."*
  //
  // **It could, and I measured it.** `enrolled_by = 'enrollment:deadbeefcafe'` — a string I made
  // up — was accepted and carried `exec:hardware` with `synthetic_only = false`. My previous
  // version matched `LIKE 'enrollment:%'`, which tests the SHAPE of the value and not the fact
  // behind it. That is this repository's recurring defect appearing inside the fix I had just
  // written for another instance of it, one commit later.
  //
  // So the trigger now JOINS the claimed provenance to the token table and requires the token to
  // exist, to be unexpired, to be bound to no other worker, and — the part that matters most — to
  // carry **exactly the grants being inserted**. A token authorizing nothing cannot create an
  // identity holding `exec:hardware`, which was the real hole: the previous guard would have waved
  // through any widened identity as long as a real enrolment had happened at some point for
  // anything at all.
  //
  // Set equality is mutual containment (`<@` both ways) rather than `=`, because array equality in
  // Postgres is order-sensitive and `{a,b}` and `{b,a}` are the same grant.
  await query(
    `CREATE OR REPLACE FUNCTION ${FN}_insert() RETURNS trigger AS $fn$
     DECLARE tok RECORD;
     BEGIN
       IF NEW.enrolled_by IS NULL OR NEW.enrolled_by NOT LIKE 'enrollment:%' THEN
         RAISE EXCEPTION
           'a worker identity may only be created by the enrollment exchange, which records '
           'enrolled_by as enrollment:<digest> (worker %). A direct INSERT cannot create one.',
           NEW.id
           USING ERRCODE = 'check_violation';
       END IF;

       SELECT * INTO tok FROM worker_enrollment_tokens
         WHERE left(token_digest, 12) = substring(NEW.enrolled_by from 12)
         LIMIT 1;

       IF tok IS NULL THEN
         RAISE EXCEPTION
           'enrolled_by % names no enrollment token (worker %). A correctly formatted provenance '
           'value is not an authenticated enrollment.', NEW.enrolled_by, NEW.id
           USING ERRCODE = 'check_violation';
       END IF;
       IF tok.expires_at <= NOW() THEN
         RAISE EXCEPTION 'the enrollment token for worker % has expired', NEW.id
           USING ERRCODE = 'check_violation';
       END IF;
       IF tok.consumed_by_worker IS NOT NULL AND tok.consumed_by_worker <> NEW.id THEN
         RAISE EXCEPTION
           'the enrollment token for worker % is already bound to worker % — a token is single use',
           NEW.id, tok.consumed_by_worker
           USING ERRCODE = 'check_violation';
       END IF;
       IF NOT (COALESCE(NEW.capabilities, ARRAY[]::text[]) <@ COALESCE(tok.capabilities, ARRAY[]::text[])
               AND COALESCE(tok.capabilities, ARRAY[]::text[]) <@ COALESCE(NEW.capabilities, ARRAY[]::text[])) THEN
         RAISE EXCEPTION
           'worker % is being created with capabilities % but its enrollment token authorized % — '
           'an identity may only carry the grants its token approved',
           NEW.id, NEW.capabilities, tok.capabilities
           USING ERRCODE = 'check_violation';
       END IF;
       IF NEW.synthetic_only IS DISTINCT FROM tok.synthetic_only THEN
         RAISE EXCEPTION
           'worker % is being created with synthetic_only = % but its token authorized % — the '
           'isolation setting is part of the approved grant',
           NEW.id, NEW.synthetic_only, tok.synthetic_only
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
