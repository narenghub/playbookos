// ── B7.11: A SHARED MAILBOX IS SCOPED TO A COMPANY AND A PURPOSE ────────────
//
// Owner instruction (correction 5, restated in B6.9 and again in Decision 5):
//
//   *"Scope shared mailboxes to company + purpose. INTERNAL_MAILBOXES must not override a
//    deactivated human account."*
//
// ── THE TWO HOLES IN THE ENVIRONMENT VARIABLE ──────────────────────────────
//
// `INTERNAL_MAILBOXES` is a flat, comma-separated env string, and `outbound/membership.js` treated
// any address in it as internal unconditionally. Two consequences, both measured:
//
//   1. IT OVERRODE A DEACTIVATED HUMAN. `classifyByMembership` checked `members.has(lower) ||
//      mailboxes.has(lower)`, so adding a departed employee's address to the allowlist made them
//      internal again — reinstating by configuration the exact person the whole
//      active-membership rule exists to exclude, and doing it in a place nobody reviews. That is
//      the same defect as B7.4 (an approval reinstating a deactivated employee), one layer down.
//   2. IT HAD NO COMPANY AND NO PURPOSE. `sales@abiozen.com` was internal for every company's
//      mail. Abiozen, Adifice and GolfNEX share one platform and one env var, so a mailbox
//      declared for one was a free internal recipient for all of them — and a mailbox that exists
//      to receive RFQ replies was equally internal for payroll.
//
// ── THE RULE NOW ────────────────────────────────────────────────────────────
//
// An address is a usable shared mailbox for a send only if ALL of these hold:
//
//   a. a `shared_mailboxes` row declares it, ACTIVE and inside its effective window;
//   b. that row's company is the company the send is for — or the send has no company context and
//      the row is explicitly marked `company_scope = 'platform'`;
//   c. the row's purpose is the send's purpose, or the row's purpose is 'any' (explicit, not
//      inferred from an absent value);
//   d. the address is NOT a known deactivated human account. This one has no override and no
//      exception: a person who has left cannot be readmitted by a mailbox declaration.
//
// (d) is checked LAST and overrides everything before it, which is the only ordering that makes it
// an override rather than a condition among others.
//
// ── THE ENV VARIABLE IS KEPT, AND NARROWED ─────────────────────────────────
//
// Deleting `INTERNAL_MAILBOXES` would break whatever production currently relies on it with no
// warning, so it survives as a PLATFORM-SCOPE, ANY-PURPOSE source — the behaviour it already had —
// with one change: rule (d) now applies to it too. So the env var can no longer readmit a departed
// employee, which is the hole the owner named, and a company-scoped send must use a declared row.
// `envEntriesNeedingDeclaration` reports which env entries have no row yet, so the migration is a
// list rather than an archaeology exercise.

'use strict';

const PURPOSE_ANY = 'any';
const COMPANY_SCOPE_PLATFORM = 'platform';

const DDL = [
  `CREATE TABLE IF NOT EXISTS shared_mailboxes (
     id             TEXT PRIMARY KEY,
     address        TEXT NOT NULL,
     company_id     TEXT REFERENCES companies(id) ON DELETE RESTRICT,
     company_scope  TEXT NOT NULL DEFAULT 'company',
     purpose        TEXT NOT NULL,
     status         TEXT NOT NULL DEFAULT 'active',
     authorized_by  TEXT NOT NULL,
     reason         TEXT NOT NULL,
     effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     effective_to   TIMESTAMPTZ,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT shared_mailboxes_status CHECK (status IN ('active','suspended','revoked')),
     CONSTRAINT shared_mailboxes_scope CHECK (company_scope IN ('company','platform')),
     -- A COMPANY-scoped row must name its company, and a PLATFORM-scoped one must not. Without
     -- this a row could claim company scope with a null company and be internal for everybody,
     -- which is hole (2) reintroduced through the table meant to close it.
     CONSTRAINT shared_mailboxes_scope_agrees CHECK (
       (company_scope = 'company' AND company_id IS NOT NULL)
       OR (company_scope = 'platform' AND company_id IS NULL)
     ),
     CONSTRAINT shared_mailboxes_window CHECK (effective_to IS NULL OR effective_to > effective_from),
     CONSTRAINT shared_mailboxes_reason_not_blank CHECK (length(btrim(reason)) > 0),
     CONSTRAINT shared_mailboxes_authorized_by_not_blank CHECK (length(btrim(authorized_by)) > 0),
     CONSTRAINT shared_mailboxes_address_lower CHECK (address = lower(address))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shared_mailboxes_lookup
     ON shared_mailboxes (address, status)`,
];

async function migrateSharedMailboxes(query) {
  for (const stmt of DDL) {
    try { await query(stmt); } catch (e) {
      throw new Error(`shared_mailboxes migration failed on [${stmt.slice(0, 60).replace(/\s+/g, ' ')}…]: ${e.message}`);
    }
  }
  return { ok: true };
}

const q = (deps) => (deps && deps.query) || require('../db').query;

/**
 * Addresses that are known users but NOT active.
 *
 * Returns null when it cannot be determined. A caller must treat null as unknowable and refuse to
 * treat ANY address as a shared mailbox — the same fail-closed rule activeMembers follows, and for
 * the same reason: an empty set means "asked, none are deactivated", which is a different fact.
 */
async function deactivatedAccounts(addresses, deps = {}) {
  const wanted = [...new Set(addresses.map((a) => String(a).toLowerCase()))].filter(Boolean);
  if (!wanted.length) return new Set();
  try {
    const r = await q(deps)(
      `SELECT lower(email) AS email FROM users
        WHERE lower(email) = ANY($1) AND (is_active = 0 OR is_active IS NULL)`,
      [wanted]);
    return new Set(r.rows.map((x) => x.email));
  } catch (_) {
    return null;
  }
}

/**
 * Which of `addresses` are usable shared mailboxes for this send?
 *
 * @returns {{usable:Set<string>, verdicts:Map<string,{ok:boolean, reason:string}>, unknown:boolean}}
 *          `unknown: true` means a source could not be read and NOTHING is usable.
 */
async function usableMailboxes(addresses, { companyId = null, purpose = null,
  env = process.env } = {}, deps = {}) {
  const wanted = [...new Set(addresses.map((a) => String(a).toLowerCase()))].filter(Boolean);
  const verdicts = new Map();
  const usable = new Set();
  if (!wanted.length) return { usable, verdicts, unknown: false };

  // (d) first in the READ, last in the DECISION: fetched up front so a row can never be accepted
  // before this is known, and applied after everything else so it overrides.
  const deactivated = await deactivatedAccounts(wanted, deps);
  if (deactivated === null) {
    for (const a of wanted) {
      verdicts.set(a, { ok: false,
        reason: 'the user table could not be read, so whether this address belongs to a '
          + 'deactivated account is unknowable — nothing is treated as a shared mailbox' });
    }
    return { usable, verdicts, unknown: true };
  }

  let rows = [];
  let tableReadable = true;
  try {
    rows = (await q(deps)(
      `SELECT address, company_id, company_scope, purpose, status, effective_from, effective_to
         FROM shared_mailboxes
        WHERE address = ANY($1) AND status = 'active'
          AND effective_from <= NOW()
          AND (effective_to IS NULL OR effective_to > NOW())`,
      [wanted])).rows;
  } catch (_) {
    tableReadable = false;
  }

  // The env var: PLATFORM scope, ANY purpose. Kept so nothing in production breaks silently, and
  // reported by envEntriesNeedingDeclaration so the migration off it is a list.
  const envSet = new Set(String(env.INTERNAL_MAILBOXES || '')
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));

  for (const a of wanted) {
    // ── (d) THE OVERRIDE ────────────────────────────────────────────────
    if (deactivated.has(a)) {
      verdicts.set(a, { ok: false,
        reason: 'this address belongs to a DEACTIVATED user account. A shared-mailbox declaration '
          + 'cannot readmit a person who has left — that is the hole the active-membership rule '
          + 'exists to close, and a configuration entry may not reopen it' });
      continue;
    }

    const declared = rows.filter((r) => r.address === a);
    const forThisCompany = declared.filter((r) => (
      companyId
        ? (r.company_scope === 'company' && r.company_id === companyId)
          || r.company_scope === COMPANY_SCOPE_PLATFORM
        : r.company_scope === COMPANY_SCOPE_PLATFORM
    ));
    const forThisPurpose = forThisCompany.filter((r) => (
      r.purpose === PURPOSE_ANY || (purpose !== null && r.purpose === purpose)
    ));

    if (forThisPurpose.length) {
      usable.add(a);
      const r = forThisPurpose[0];
      verdicts.set(a, { ok: true,
        reason: `declared for ${r.company_scope === 'platform' ? 'the platform' : r.company_id}, `
          + `purpose ${r.purpose}` });
      continue;
    }

    if (envSet.has(a)) {
      if (companyId) {
        verdicts.set(a, { ok: false,
          reason: 'present only in INTERNAL_MAILBOXES, which is PLATFORM-scope and any-purpose. A '
            + `send for company ${companyId} needs a declared shared_mailboxes row for that `
            + 'company, because one env var cannot say which company a mailbox belongs to' });
        continue;
      }
      usable.add(a);
      verdicts.set(a, { ok: true,
        reason: 'INTERNAL_MAILBOXES (platform scope, any purpose) — legacy source, kept so nothing '
          + 'breaks silently; it can no longer readmit a deactivated account' });
      continue;
    }

    verdicts.set(a, { ok: false,
      reason: declared.length
        ? (companyId
          ? `declared, but not for company ${companyId}`
            + (purpose ? ` and purpose ${purpose}` : '')
          : 'declared with company scope, but this send has no company context')
        : (tableReadable
          ? 'no active shared-mailbox declaration and not in INTERNAL_MAILBOXES'
          : 'the shared_mailboxes table could not be read, and an unreadable declaration is not a '
            + 'declaration') });
  }

  return { usable, verdicts, unknown: false };
}

/**
 * Which `INTERNAL_MAILBOXES` entries have no declared row yet?
 *
 * The migration aid: it turns "move off the env var" into a list of addresses that still need a
 * company, a purpose and somebody's name against them.
 */
async function envEntriesNeedingDeclaration({ env = process.env } = {}, deps = {}) {
  const entries = [...new Set(String(env.INTERNAL_MAILBOXES || '')
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!entries.length) return { entries: [], undeclared: [], readable: true };
  try {
    const rows = (await q(deps)(
      `SELECT DISTINCT address FROM shared_mailboxes WHERE address = ANY($1) AND status = 'active'`,
      [entries])).rows.map((r) => r.address);
    return { entries, undeclared: entries.filter((e) => !rows.includes(e)), readable: true };
  } catch (_) {
    return { entries, undeclared: entries, readable: false };
  }
}

module.exports = {
  migrateSharedMailboxes, DDL,
  usableMailboxes, deactivatedAccounts, envEntriesNeedingDeclaration,
  PURPOSE_ANY, COMPANY_SCOPE_PLATFORM,
};
