// ── MIGRATION 62: SYNTHETIC ISOLATION ───────────────────────────────────────
//
// Authorized by the owner on 2026-11-27, development-only, after their Priority 2 correction:
// *"Verify that the development API enforces synthetic objective and data isolation. Cloud
// eligibility and pure handlers alone do not establish synthetic-only authorization."*
//
// **They were right and my claim was wrong.** Measured before writing this: `companies` carried
// `id, slug, display_name, status, created_at` and `objectives` likewise — **no synthetic, pilot,
// fixture or development marker existed anywhere in either schema.** What bounded a cloud worker
// was the capability grant, handler purity and company-scoped server-side retrieval. None of those
// says anything about WHICH company, so "synthetic-only" was a property of what somebody had put in
// the development database rather than an authorization the API enforced.
//
// Two columns, and the asymmetry between their defaults is deliberate:
//
//   companies.is_synthetic           NOT NULL DEFAULT false
//   worker_identities.synthetic_only NOT NULL DEFAULT true
//
// **A company is real unless somebody says otherwise; a worker is restricted unless somebody says
// otherwise.** Both defaults fail closed, in opposite directions, because the dangerous answer is
// different on each side: a company silently defaulting to synthetic would let a restricted worker
// claim real work the day somebody adds a company, and a worker silently defaulting to unrestricted
// would make the whole column vacuous for every identity enrolled before it existed — which is the
// exact reasoning `leases.js` already records for the capability filter.
//
// **DEFAULT true APPLIES TO EXISTING ROWS TOO, and that is a decision rather than an oversight.**
// `ADD COLUMN ... NOT NULL DEFAULT true` restricts every identity already enrolled, including the
// iMac hardware worker. The alternative — adding it nullable and reading NULL as "predates the
// restriction, therefore unrestricted" — preserves today's behaviour and leaves a tri-state whose
// third value means *exempt*, which is the kind of quiet permission this repository keeps finding.
// So every identity is restricted, and widening one is a reviewed act with a row to point at.
//
// **What that costs, stated rather than discovered later:** the M7.6 hardware pilot enqueues through
// `m76/pipeline.js`, which passes **no companyId at all**, so its tasks carry `company_id = NULL`.
// A restricted worker will not claim them. That does not invalidate the M7.5/M7.6 hardware evidence
// already recorded — it means a FUTURE hardware run needs either a company on those tasks or an
// explicitly widened identity. B2.1 already needs fresh crash-test arming before it can run again,
// so this joins a step that exists rather than inventing one.
//
// The NULL case needs no special clause and gets none: `NULL IN (SELECT ...)` is NULL, never true,
// so a task with no company is excluded by the same predicate that excludes a real company's work.
// **A task with no company cannot be isolated at all** — nobody can say whose data it concerns — so
// refusing it is the honest answer and not a gap in the filter.

'use strict';

const IDENTITY_SCHEMA = require('./identity-schema');

/**
 * Idempotent, and called from BOTH migrators for the reason `installActiveCompanyGuard` is:
 * `companies` lives in the office schema and `worker_identities` in this one, and different checks
 * run those two migrations in different orders. Whichever runs last completes the pair.
 */
async function installSyntheticIsolation(query) {
  // `companies` may not exist yet when this is reached from the worker migrator. That is not a
  // failure: the office migrator calls this again. Asked rather than assumed, because a swallowed
  // error here would leave the column missing and the gate reading nothing.
  const companies = await query(
    `SELECT to_regclass('public.companies') IS NOT NULL AS present`);
  if (companies.rows[0].present) {
    await query(
      `ALTER TABLE companies
         ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false`);
  }

  const identities = await query(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${IDENTITY_SCHEMA.TABLES.identities}`]);
  if (identities.rows[0].present) {
    await query(
      `ALTER TABLE ${IDENTITY_SCHEMA.TABLES.identities}
         ADD COLUMN IF NOT EXISTS synthetic_only BOOLEAN NOT NULL DEFAULT true`);
  }

  // The ENROLLMENT TOKEN carries it too, because that is what makes the restriction
  // server-authorized rather than a column somebody UPDATEs afterwards. Capabilities already work
  // this way — they travel on an operator-issued token and no code path updates them later — and a
  // restriction that could be lifted by an UPDATE would be a weaker thing than the grant it sits
  // beside.
  const tokens = await query(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${IDENTITY_SCHEMA.TABLES.tokens}`]);
  if (tokens.rows[0].present) {
    await query(
      `ALTER TABLE ${IDENTITY_SCHEMA.TABLES.tokens}
         ADD COLUMN IF NOT EXISTS synthetic_only BOOLEAN NOT NULL DEFAULT true`);
  }

  return {
    ok: true,
    companies: Boolean(companies.rows[0].present),
    identities: Boolean(identities.rows[0].present),
    tokens: Boolean(tokens.rows[0].present),
  };
}

/**
 * Mark a company synthetic, or stop doing so. Development fixtures and the pilot company are
 * synthetic; a real company is not, and nothing in this module makes that judgement for anybody.
 *
 * Deliberately NOT exposed through an HTTP route: it decides which data a restricted worker may be
 * handed, so it is a reviewed act performed against a database, like declaring a sender identity.
 */
async function setCompanySynthetic(companyId, isSynthetic, { query }) {
  if (!companyId) throw new Error('setCompanySynthetic needs a companyId');
  if (typeof isSynthetic !== 'boolean') {
    throw new Error('isSynthetic must be a boolean — a truthy value is not a decision about which '
      + 'data a worker may be handed');
  }
  const r = await query(
    `UPDATE companies SET is_synthetic = $2 WHERE id = $1 RETURNING id, slug, is_synthetic`,
    [String(companyId), isSynthetic]);
  if (!r.rows.length) throw new Error(`company ${companyId} does not exist`);
  return r.rows[0];
}

module.exports = { installSyntheticIsolation, setCompanySynthetic };
