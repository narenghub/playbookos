// ── WHO WORKS FOR WHICH COMPANY: THE ONE PLACE THAT ANSWERS IT ──────────────
//
// THE SOLE ACCESSOR for `user_companies`. No other module may read or write that table in SQL;
// scripts/check-membership-accessor-discipline.js fails the build if one does. The reason is the
// one the K1 ruling gave for scope.js: "if the proposed enforcement only works because every
// developer remembers to write WHERE company_id = ?, it is not complete." Callers cannot forget
// the predicate here because callers never write it, and they never write it because they are not
// given the table name.
//
// ── WHY THIS IS NOT IN outbound/membership.js ───────────────────────────────
//
// Owner ruling 2026-11-24: "Implement a reusable identity and company authorization foundation,
// not an email-specific workaround… Use the same authorization foundation for future agent memory,
// task assignments, document access, business integrations and agent delegation."
//
// So the question this module answers is deliberately general — *is this person, right now, an
// authorized member of this company?* — and email is merely its first caller.
//
// ── THE RULES, EACH TRACEABLE TO A REQUIREMENT ──────────────────────────────
//
//  1. GLOBAL DEACTIVATION OVERRIDES EVERYTHING (req 4). `users.is_active = 0` means no company,
//     no matter how many live membership rows exist. The join checks the account first, which is
//     why no caller can authorize a departed employee by naming the right company.
//
//  2. REVOCATION IS SCOPED (req 5). Revoking ABIOZEN leaves Adifice untouched, because revocation
//     is a column on the membership row and never on the user.
//
//  3. SHARED EMPLOYEES NEED EXPLICIT MEMBERSHIPS (req 6). Two companies, two rows. There is no
//     "same owner, therefore access" rule anywhere in this file, and common ownership is not
//     represented at all.
//
//  4. NO DOMAIN-BASED GRANTS (req 8). This module cannot see an email domain. It reads rows.
//     An address being @abiozen.com grants nothing, which is the whole point — a departed
//     employee's address is still on the company domain, and that is what stopped all company
//     email on 2026-11-03.
//
//  5. EXTERNAL PARTNER ROLES ARE NOT EMPLOYEES (req 9). Enforced twice over: `users.role` must
//     not be an external role, AND `company_role` must not be either. One row in `users` is not a
//     colleague — the `partner` role exists so a partner agency can sign in to its own portal, and
//     the first draft of the email classifier swept the whole roster and would have made such an
//     account internal. That was caught by src/lib/external-roles.test.js.
//
//  6. EFFECTIVE DATES (req 3). A membership that has not started, or has ended, is not a
//     membership. Evaluated against an explicit instant so a caller can ask "was this true then",
//     and so tests are not at the mercy of the clock.
//
// ── FAIL CLOSED, AND WHAT THAT MEANS HERE ───────────────────────────────────
//
// Every reader returns null — NOT an empty result — when the question could not be answered: the
// database was unreachable, the table is absent. null means "could not ask"; empty means "asked,
// and nobody qualifies". Collapsing the two is exactly how a fail-closed control becomes
// fail-open, and the caller is required to treat null as a refusal. Owner ruling: "If the
// membership resolver is unavailable and required identity checks cannot be established, refuse or
// safely defer dispatch. Do not classify an unavailable membership record as a departed employee."

'use strict';

const { excludeExternalSql, isExternalRole } = require('../roles');

const q = (deps) => (deps && deps.query) || require('../db').query;

/** Returned by every reader when the question could not be answered at all. */
const UNKNOWN = null;

// `u.role` is the global account role; `uc.company_role` is the role within the company. Both are
// screened, because an external role in either position means this is not an internal employee.
const NOT_EXTERNAL = `${excludeExternalSql('u')}${excludeExternalSql('uc')
  .replace('uc.role', 'uc.company_role')}`;

/**
 * The live-membership predicate, written once.
 *
 * $1 is the instant to evaluate at. Every condition here is a ruled requirement; see the header.
 */
const LIVE = `
       u.is_active = 1                         -- req 4: global deactivation overrides all
   AND uc.status = 'active'                    -- req 5: scoped revocation
   AND uc.revoked_at IS NULL
   AND uc.effective_from <= $1                 -- req 3: effective dates
   AND (uc.effective_to IS NULL OR uc.effective_to > $1)
   AND c.status = 'active'                     -- a suspended company authorizes nobody
   ${NOT_EXTERNAL}                             -- req 9: a partner is not an employee
`;

const FROM = `
  FROM user_companies uc
  JOIN users     u ON u.id = uc.user_id
  JOIN companies c ON c.id = uc.company_id
`;

/**
 * Every company this person is a live member of, with the role they hold in each.
 *
 * @returns {Promise<Array<{companyId:string, companyRole:string}>|null>} null when unknowable.
 */
async function membershipsOf(userId, { at = new Date(), ...deps } = {}) {
  if (!userId) return [];
  try {
    const r = await q(deps)(
      `SELECT uc.company_id AS "companyId", uc.company_role AS "companyRole"
       ${FROM}
       WHERE uc.user_id = $2 AND ${LIVE}
       ORDER BY uc.company_id`,
      [at, String(userId)]);
    return r.rows;
  } catch (_) {
    return UNKNOWN;
  }
}

/**
 * Is this person a live member of this company?
 *
 * @returns {Promise<boolean|null>} null when unknowable — the caller must refuse, not assume.
 */
async function isActiveMember({ userId, companyId }, { at = new Date(), ...deps } = {}) {
  if (!userId || !companyId) return false;
  try {
    const r = await q(deps)(
      `SELECT 1 ${FROM}
       WHERE uc.user_id = $2 AND uc.company_id = $3 AND ${LIVE}
       LIMIT 1`,
      [at, String(userId), String(companyId)]);
    return r.rows.length > 0;
  } catch (_) {
    return UNKNOWN;
  }
}

/**
 * Which of these addresses belong to live members OF THIS COMPANY.
 *
 * This is what an outbound gate needs: not "is this address known to us" but "is this address a
 * person currently employed by the company this message is being sent on behalf of". An address
 * that belongs to an active employee of ANOTHER company is not internal here — req 6, and the
 * reason cross-company isolation cannot be an afterthought in the email path.
 *
 * @returns {Promise<Set<string>|null>} lowercased addresses; null when unknowable.
 */
async function activeMemberAddresses(addresses, { companyId, at = new Date(), ...deps } = {}) {
  const wanted = [...new Set((addresses || []).map((a) => String(a).toLowerCase()))].filter(Boolean);
  if (!wanted.length) return new Set();
  // No companyId is not "any company" — it is an unanswerable question, and answering it as
  // "every company" is precisely the cross-tenant leak this table exists to prevent.
  if (!companyId) return UNKNOWN;
  try {
    const r = await q(deps)(
      `SELECT lower(u.email) AS email
       ${FROM}
       WHERE uc.company_id = $3 AND lower(u.email) = ANY($2) AND ${LIVE}`,
      [at, wanted, String(companyId)]);
    return new Set(r.rows.map((x) => x.email));
  } catch (_) {
    return UNKNOWN;
  }
}

// ── WRITES: A MEMBERSHIP IS AN ACCESS GRANT, SO SOMEBODY OWNS IT ────────────
//
// Both writers demand an actor. There is no system-grant path and no default actor, because
// "granted by the migration" is how an access grant ends up with nobody accountable for it. Owner
// ruling: "Do not infer or grant production memberships automatically."
//
// ── AND THE ACTOR IS CHECKED, NOT JUST RECORDED ─────────────────────────────
//
// Recording `granted_by` is audit; it is not authorization. The first draft of this module took an
// actor and wrote it down, which means any caller could have granted itself any company by passing
// its own id — the access-control equivalent of a signature field on a form nobody checks. Owner
// requirements: "Unauthorized actors cannot grant or elevate their own membership" and
// "Administrative membership changes require separately authorized permissions and audit
// attribution."
//
// WHO MAY MANAGE MEMBERSHIPS OF A COMPANY:
//   · a global `super_admin` — the platform owner, who is not a member of every company; or
//   · an ACTIVE MEMBER of that company holding an administrative company_role.
//
// Membership-management authority is therefore itself company-scoped: an admin of Adifice cannot
// grant anybody access to ABIOZEN, which is the same isolation the table exists to express.
//
// NO SELF-SERVICE, EVEN FOR AN ADMIN. An actor may not grant, re-grant or revoke their OWN
// membership. The reason is not distrust of admins; it is that self-elevation is the one path
// where the authority being checked and the authority being changed are the same row, so a bug in
// one direction compromises both. A second person does it, and both halves stay on the record.
// A super_admin is not exempt: bootstrapping the first membership is a migration decision with a
// named human behind it, not a runtime self-grant.

/** Administrative company roles. A membership grant is an access grant, so this list is narrow. */
const MEMBERSHIP_MANAGER_ROLES = Object.freeze(['super_admin', 'admin']);

/**
 * May this actor change memberships of this company?
 *
 * Throws on refusal rather than returning false: a caller that forgets to check a boolean has
 * written the bug this exists to prevent, and a thrown error cannot be ignored by omission.
 */
async function assertActorMayManage({ actorUserId, companyId, subjectUserId },
  { at = new Date(), ...deps } = {}) {
  if (!actorUserId) throw new Error('membership changes require actorUserId — an access grant with no actor is unauthorized by definition');
  if (!companyId) throw new Error('membership changes require companyId');

  if (subjectUserId && String(subjectUserId) === String(actorUserId)) {
    throw new Error(
      'an actor may not grant, re-grant or revoke their OWN company membership. Self-elevation is '
      + 'the one path where the authority being checked and the authority being changed are the '
      + 'same row. Another authorized administrator must make this change.');
  }

  const r = await q(deps)(
    `SELECT role AS global_role, is_active FROM users WHERE id = $1`, [String(actorUserId)]);
  const actor = r.rows[0];
  if (!actor) throw new Error(`actor ${actorUserId} does not exist, so it cannot authorize a membership change`);
  if (!actor.is_active) throw new Error(`actor ${actorUserId} is a deactivated account and cannot authorize a membership change`);
  if (isExternalRole(actor.global_role)) {
    throw new Error(`actor ${actorUserId} holds the external role "${actor.global_role}" and is not an internal administrator`);
  }
  if (actor.global_role === 'super_admin') return { via: 'super_admin' };

  // The actor's own membership is resolved through membershipsOf, NOT through a second copy of the
  // predicate inlined here. Two copies of a six-condition authorization rule drift, and the one
  // that drifts is always the one nobody is reading.
  const held = await membershipsOf(actorUserId, { at, ...deps });
  if (held === UNKNOWN) {
    throw new Error(
      'the actor\'s own membership could not be read, so their authority to change memberships '
      + 'cannot be established — refusing rather than assuming it');
  }
  const mine = held.find((m) => m.companyId === String(companyId));
  if (mine && MEMBERSHIP_MANAGER_ROLES.includes(mine.companyRole)) {
    return { via: `company_role:${mine.companyRole}` };
  }
  throw new Error(
    `actor ${actorUserId} is not authorized to change memberships of ${companyId}: a global `
    + 'super_admin or an active administrative member of THAT company is required (actor holds '
    + `global role "${actor.global_role}", company role ${JSON.stringify(mine ? mine.companyRole : null)}).`);
}

/** Grant (or re-grant) a membership. Throws rather than silently granting something unintended. */
async function grantMembership({ userId, companyId, companyRole, grantedBy, grantedReason = null,
  effectiveFrom = null, effectiveTo = null, id = null }, deps = {}) {
  for (const [k, v] of Object.entries({ userId, companyId, companyRole, grantedBy })) {
    if (!v) throw new Error(`grantMembership requires ${k} — a membership with no ${k} is an access grant nobody owns`);
  }
  // Authorization, not just attribution. Throws when the actor may not do this.
  await assertActorMayManage(
    { actorUserId: grantedBy, companyId, subjectUserId: userId }, deps);
  if (isExternalRole(companyRole)) {
    throw new Error(
      `company_role "${companyRole}" is an EXTERNAL role, so it cannot be an internal company `
      + 'membership. A partner belongs in a partner relationship, not in user_companies — '
      + 'granting one here would make an outside party an employee of this company.');
  }
  const rowId = id || `uc-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const r = await q(deps)(
    `INSERT INTO user_companies
       (id, user_id, company_id, company_role, status, effective_from, effective_to,
        granted_by, granted_reason)
     VALUES ($1,$2,$3,$4,'active',COALESCE($5, NOW()),$6,$7,$8)
     RETURNING id, user_id, company_id, company_role, status, effective_from, effective_to`,
    [rowId, String(userId), String(companyId), String(companyRole), effectiveFrom, effectiveTo,
      String(grantedBy), grantedReason]);
  return r.rows[0];
}

/**
 * Revoke ONE membership. Scoped by construction: it names a company, so it cannot reach another.
 *
 * Deliberately not a delete. The row stays, carrying who removed the access and why, because an
 * access grant that vanishes leaves no way to answer "who could see this in October".
 */
async function revokeMembership({ userId, companyId, revokedBy, revokedReason = null },
  deps = {}) {
  for (const [k, v] of Object.entries({ userId, companyId, revokedBy })) {
    if (!v) throw new Error(`revokeMembership requires ${k}`);
  }
  await assertActorMayManage(
    { actorUserId: revokedBy, companyId, subjectUserId: userId }, deps);
  const r = await q(deps)(
    `UPDATE user_companies
        SET status = 'revoked', revoked_at = NOW(), revoked_by = $3, revoked_reason = $4
      WHERE user_id = $1 AND company_id = $2 AND status = 'active'
      RETURNING id, user_id, company_id`,
    [String(userId), String(companyId), String(revokedBy), revokedReason]);
  return { revoked: r.rows.length, rows: r.rows };
}

module.exports = {
  membershipsOf,
  isActiveMember,
  activeMemberAddresses,
  grantMembership,
  revokeMembership,
  assertActorMayManage,
  MEMBERSHIP_MANAGER_ROLES,
  UNKNOWN,
  // Exported for the accessor-discipline check and for tests that assert the predicate itself
  // rather than re-deriving it, which would be a second implementation of the same rule.
  LIVE,
  FROM,
};
