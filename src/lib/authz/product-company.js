// ── A PRODUCT IS NOT A COMPANY (Decision 1, 2026-11-25) ─────────────────────
//
// Owner instruction: *"No assumption that product or tenant identifiers are company identifiers.
// Resolve product-to-company relationships through explicit, authorized mappings. Reject
// ambiguous, missing, suspended or revoked mappings."*
//
// ── THE ASSUMPTION THIS REPLACES, AND WHERE IT WAS ─────────────────────────
//
// `src/lib/agents/gate.js` passed its `product` into the kill switch's COMPANY slot:
//
//     checkStopped({ company: product, agent, capability }, …)
//
// So `golfnex` — a product — was treated as a company id. That is not a naming nit. The office
// kernel's company is a row in `companies`, with memberships, objectives, budgets and composite
// foreign keys hanging off it; a product is a route namespace in
// src/lib/products/route-map.js. One company can own several products (Abiozen owns the
// marketplace and the CRO lines), a product can be sold on behalf of a partner, and the two
// vocabularies were never required to agree. Where they happened to coincide the gate worked by
// luck, and where they did not it authorized against a company that does not exist.
//
// ── WHY A TABLE AND NOT A CONSTANT ─────────────────────────────────────────
//
// A hard-coded map would be a second authorization model: two places that answer "which company is
// this for", drifting apart, with no review trail and no way to suspend one entry. This table is
// the explicit, authorized mapping the owner asked for — `authorized_by` and `reason` are NOT
// NULL, so an entry says who decided it and why, and `status` lets one be suspended or revoked
// without deleting the evidence that it existed.
//
// ── EVERY NON-ANSWER IS A REFUSAL, AND THEY ARE DISTINGUISHED ──────────────
//
//   missing     no mapping at all. The product may be real and simply unmapped.
//   ambiguous   more than one ACTIVE mapping. Two companies claim it; which one is a decision,
//               not a derivation — the same rule record-ownership.js applies to a shared employee.
//   suspended   mapped, deliberately paused. Not an outage and not permission.
//   revoked     mapped, deliberately withdrawn.
//   expired     mapped, outside its effective window.
//   unknown     the mapping could not be READ. An outage is not an attribution.
//
// None of them resolves to a company, and a caller that cannot tell them apart would report a
// deliberate suspension as a configuration gap.

'use strict';

const STATUSES = Object.freeze(['active', 'suspended', 'revoked']);

const DDL = [
  `CREATE TABLE IF NOT EXISTS product_companies (
     id             TEXT PRIMARY KEY,
     product        TEXT NOT NULL,
     company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
     status         TEXT NOT NULL DEFAULT 'active',
     authorized_by  TEXT NOT NULL,
     reason         TEXT NOT NULL,
     effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     effective_to   TIMESTAMPTZ,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT product_companies_status CHECK (status IN ('active','suspended','revoked')),
     CONSTRAINT product_companies_window CHECK (effective_to IS NULL OR effective_to > effective_from),
     CONSTRAINT product_companies_reason_not_blank CHECK (length(btrim(reason)) > 0),
     CONSTRAINT product_companies_authorized_by_not_blank CHECK (length(btrim(authorized_by)) > 0)
   )`,
  // NOT a unique index on (product): a product may have several rows over time, and the history of
  // who mapped it is the point. What must not happen is two mappings being ACTIVE at once — and
  // the resolver refuses that case loudly rather than the database silently preventing it, because
  // "ambiguous" is information an operator needs, not a write to reject. Recording the second
  // mapping is how it becomes visible.
  `CREATE INDEX IF NOT EXISTS idx_product_companies_lookup
     ON product_companies (product, status)`,
];

async function migrateProductCompanies(query) {
  for (const stmt of DDL) {
    try { await query(stmt); } catch (e) {
      throw new Error(`product_companies migration failed on [${stmt.slice(0, 60).replace(/\s+/g, ' ')}…]: ${e.message}`);
    }
  }
  return { ok: true };
}

/**
 * Which company, if any, is authorized to act for this product?
 *
 * Deliberately NOT company-context-scoped: this is the function that ESTABLISHES a company, so it
 * cannot require one — the same exception office/scope.js makes for
 * `bootstrapObjectiveForContext`, and for the same reason. It is read-only and takes no company
 * from the caller.
 *
 * @returns {{ok:true, companyId, mappingId, authorizedBy}}
 *        | {{ok:false, reason:'missing'|'ambiguous'|'suspended'|'revoked'|'expired'|'unknown', detail}}
 */
async function companyForProduct(product, deps = {}) {
  if (!product || typeof product !== 'string') {
    return { ok: false, reason: 'missing', detail: 'no product was named' };
  }
  const query = deps.query || require('../db').query;
  let rows;
  try {
    rows = (await query(
      `SELECT id, company_id, status, authorized_by, effective_from, effective_to
         FROM product_companies
        WHERE product = $1
        ORDER BY created_at DESC`,
      [product])).rows;
  } catch (e) {
    // An outage is not an attribution. The same rule the membership accessor follows when it
    // returns UNKNOWN rather than "not a member".
    return { ok: false, reason: 'unknown',
      detail: `the product-to-company mapping could not be read (${e.message})` };
  }

  if (!rows.length) {
    return { ok: false, reason: 'missing',
      detail: `product "${product}" has no authorized company mapping. It is not assumed to BE a `
        + 'company: a mapping is a reviewed decision and its absence is not one.' };
  }

  // NOW() is read from the database rather than from this process, for the reason measured on
  // 2026-11-24 in the identity accessors: comparing one clock's write against another clock's read
  // hid a row from its own creator 71% of the time.
  const live = [];
  const nowRow = await query(`SELECT NOW() AS now`).catch(() => null);
  const now = nowRow ? new Date(nowRow.rows[0].now) : new Date();
  for (const r of rows) {
    if (r.status !== 'active') continue;
    if (new Date(r.effective_from) > now) continue;
    if (r.effective_to !== null && new Date(r.effective_to) <= now) continue;
    live.push(r);
  }

  if (live.length > 1) {
    return { ok: false, reason: 'ambiguous',
      detail: `product "${product}" has ${live.length} ACTIVE company mappings `
        + `(${live.map((r) => r.company_id).join(', ')}). Which company it acts for is a decision, `
        + 'not a derivation — refusing rather than picking one.',
      companies: live.map((r) => r.company_id) };
  }

  if (live.length === 1) {
    return { ok: true, companyId: live[0].company_id, mappingId: live[0].id,
      authorizedBy: live[0].authorized_by };
  }

  // Nothing live. Say WHICH kind of not-live, because a deliberate suspension and an expired
  // window call for different responses from whoever reads this.
  const latest = rows[0];
  if (latest.status === 'suspended') {
    return { ok: false, reason: 'suspended',
      detail: `product "${product}" is mapped to ${latest.company_id} and that mapping is `
        + 'SUSPENDED. A deliberate pause is not permission and is not a gap.' };
  }
  if (latest.status === 'revoked') {
    return { ok: false, reason: 'revoked',
      detail: `product "${product}" had a mapping to ${latest.company_id} and it was REVOKED` };
  }
  return { ok: false, reason: 'expired',
    detail: `product "${product}" is mapped to ${latest.company_id} but the mapping is outside its `
      + 'effective window' };
}

module.exports = { companyForProduct, migrateProductCompanies, DDL, STATUSES };
