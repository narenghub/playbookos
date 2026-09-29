// PlaybookOS — ROW-LEVEL PARTNER SCOPING. Partner A must never see Partner B's deals.
//
// THE PRODUCT BOUNDARY DOES NOT DO THIS, and cannot. It answers "may this caller reach a route that
// belongs to product X" — every partner on SiteNex holds 'sitenex', so the boundary says yes to all of
// them and is right to. Which ROWS they may see is a different question, one layer further in, and the
// only place it can be answered is the query.
//
// This is the same split as products/held.js for product-bearing tables, one level finer: there the
// question was "whose BUSINESS is this row", here it is "whose PARTNER is this row".
//
//   layer 1  role / tier          may this kind of user do this kind of thing
//   layer 2  product boundary     is this route's product one they hold
//   layer 3  product data scope   held.js — is this row's product one they hold
//   layer 4  PARTNER data scope   this file — is this row their own partner's
//
// ENFORCED IN THE WHERE CLAUSE, never by a filter the client sends. A partner_id arriving in a query
// string is a suggestion from someone with an incentive to change it; users.partner_id is a fact we
// wrote. The two must never be confused, which is why this function takes the USER and not an id.

const { isExternalRole } = require('../roles');

// A user's own partner, from their row. Staff have partner_id NULL.
// Never throws: a lookup failure returns "no partner", and the SQL below then matches no rows for a
// partner account rather than all of them.
async function partnerIdFor(user, deps = {}) {
  if (!user || !user.id) return null;
  const q = deps.query || require('../db').query;
  try {
    const r = await q('SELECT partner_id FROM users WHERE id = $1', [user.id]);
    return (r.rows[0] && r.rows[0].partner_id) || null;
  } catch (e) { return undefined; }   // undefined = "could not tell", distinct from "staff"
}

// The WHERE fragment for a partner-owned table.
//
//   const scope = await partnerScopeSql(req.user, 'd', 1);
//   `... WHERE ${scope.sql}`, [...scope.params]
//
// Three cases, and the third is the one that matters:
//   staff (partner_id NULL)      → no restriction: they see every partner's deals
//   a partner (partner_id set)   → only their own rows
//   unknown (lookup failed)      → NO rows. Not all rows.
//
// `isStaff` is derived from the row, not from the role. A partner account with a generous role still has
// a partner_id, and that is what decides.
async function partnerScopeSql(user, alias = '', startIndex = 1, deps = {}) {
  const col = alias ? `${alias}.partner_id` : 'partner_id';
  const partnerId = await partnerIdFor(user, deps);

  if (partnerId === undefined) {
    // Fail closed. `FALSE` rather than a parameter, so there is no value to get wrong.
    return { sql: 'FALSE', params: [], nextIndex: startIndex, isStaff: false, partnerId: null, failed: true };
  }
  if (partnerId === null) {
    // partner_id NULL means STAFF — unless the role says this is an outside account, in which case NULL
    // means MISCONFIGURED, and the two must not be treated the same. An external role with no partner_id
    // is the one case where "no filter" and "filter by nothing" diverge, and the safe answer is an empty
    // board somebody asks about rather than every partner's pipeline. The role is the tiebreak here and
    // only here; it is safe to use because authMiddleware now reads it from the database.
    if (isExternalRole(user.role)) {
      return { sql: 'FALSE', params: [], nextIndex: startIndex, isStaff: false, partnerId: null,
               failed: true, reason: 'external role with no partner_id' };
    }
    return { sql: 'TRUE', params: [], nextIndex: startIndex, isStaff: true, partnerId: null, failed: false };
  }
  // A partner sees their own rows. Rows with a NULL partner_id are SELF-SOURCED — ours, not theirs — so
  // they are excluded: `partner_id = $n` is already false for NULL, which is the behaviour we want and
  // the reason this is not written as an IS NULL OR.
  return { sql: `${col} = $${startIndex}`, params: [partnerId], nextIndex: startIndex + 1,
           isStaff: false, partnerId, failed: false };
}

module.exports = { partnerIdFor, partnerScopeSql };
