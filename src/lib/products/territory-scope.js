// PlaybookOS — TERRITORY SCOPING. Which PROSPECTS a partner may see.
//
// A FIFTH LAYER, and the first one about a row that is not owned by anybody:
//
//   layer 1  role / tier          may this kind of user do this kind of thing
//   layer 2  product boundary     is this route's product one they hold
//   layer 3  product data scope   held.js — is this row's product one they hold
//   layer 4  partner data scope   partner-scope.js — is this row THEIR PARTNER'S
//   layer 5  TERRITORY scope      this file — is this row IN THEIR PATCH
//
// Layer 4 answers "whose row is this" and works because a deal carries a partner_id. A prospect does not
// and should not: our scored lead list is not owned by a partner, it is ours, and the question is the
// different one of whether a given row falls inside the territory we granted them.
//
// ── THIS SUPERSEDES AN EARLIER DECISION, DELIBERATELY ─────────────────────────
//
// Until 2026-10-01 a partner could not see the prospect list at all — "prospects are ours", with the route
// adminOnly and sitenex.prospects.list absent from the partner template. That was right when a partner had
// no defined patch: the only available answers were "all of our leads" or "none", and none was correct.
//
// Territories make the third answer expressible, and it is the one the business actually wants: a partner
// sees the prospects in the patch they were given, which is what they are for. The old refusal is not
// relaxed into "partners see prospects" — it is replaced by "partners see THEIR territory", and a partner
// with no territory rows still sees NOTHING.
//
// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
//
// No territory rows → 'FALSE' → no prospects. Never 'TRUE'. An empty grant list means nobody decided what
// this partner may see, and the safe reading of "undecided" is "nothing" — the same choice partnerScopeSql
// makes for a partner with no partner_id, and for the same reason: the failure mode of guessing wrong in
// the other direction is handing one partner another's entire pipeline.
//
// A lookup that THROWS is also 'FALSE'. "I could not tell" is not "show everything".

const { isExternalRole } = require('../roles');
const { partnerIdFor } = require('./partner-scope');

// The dimensions a territory can be expressed in, and the prospects column each one tests.
//
// A MAP AND NOT A SWITCH, so a dimension that is not here cannot reach the SQL at all. The value is
// parameterised; the COLUMN comes from this object and never from the row — a dimension string arriving
// from the table is still data we wrote, but it reaches a position in the query where a parameter cannot
// go, and the only safe way to use it there is as a lookup key into a list of known columns.
const DIMENSION_COLUMN = {
  region: 'region',
  subtype: 'subtype',
  state: 'state',
};
const DIMENSIONS = Object.keys(DIMENSION_COLUMN);
const isDimension = (d) => Object.prototype.hasOwnProperty.call(DIMENSION_COLUMN, d);

async function territoriesFor(partnerId, deps = {}) {
  if (partnerId == null) return [];
  const q = deps.query || require('../db').query;
  const r = await q(
    `SELECT dimension, value, exclusive FROM partner_territories WHERE partner_id = $1
      ORDER BY dimension, value`, [partnerId]);
  return r.rows;
}

// The WHERE fragment for the prospects list.
//
//   const t = await territoryScopeSql(req.user, '', 3);
//   `... AND ${t.sql}`, [..., ...t.params]
//
// Returns the same shape in every branch, so a caller cannot forget a field:
//   { sql, params, nextIndex, isStaff, partnerId, territories, failed, reason? }
//
// `sql` is never '' — staff get the literal 'TRUE'. A helper that returned an empty string would leave
// `AND ` dangling and the first person to copy the pattern would get a syntax error, or worse a stray AND
// that silently widened the query.
async function territoryScopeSql(user, alias = '', startIndex = 1, deps = {}) {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const none = (reason) => ({ sql: 'FALSE', params: [], nextIndex: startIndex, isStaff: false,
                              partnerId: null, territories: [], failed: true, reason });

  let partnerId;
  try { partnerId = await partnerIdFor(user, deps); }
  catch (e) { return none('partner lookup failed'); }
  if (partnerId === undefined) return none('partner lookup failed');

  if (partnerId === null) {
    // STAFF see everything. An EXTERNAL role with no partner_id is a misconfigured account, not staff, and
    // gets nothing — the same distinction partnerScopeSql draws.
    if (isExternalRole(user && user.role)) return none('external role with no partner_id');
    return { sql: 'TRUE', params: [], nextIndex: startIndex, isStaff: true,
             partnerId: null, territories: [], failed: false };
  }

  let territories;
  try { territories = await territoriesFor(partnerId, deps); }
  catch (e) { return none('territory lookup failed'); }

  const usable = territories.filter(t => isDimension(t.dimension) && t.value != null && t.value !== '');
  if (!usable.length) {
    // FAIL CLOSED. No grant means nobody decided, and "undecided" reads as "nothing".
    return { ...none(territories.length ? 'no usable territory rows' : 'no territories granted'), partnerId };
  }

  // ANY of their territories. One OR per grant, each value bound as a parameter.
  const parts = [];
  const params = [];
  let i = startIndex;
  for (const t of usable) {
    parts.push(`${col(DIMENSION_COLUMN[t.dimension])} = $${i}`);
    params.push(t.value);
    i += 1;
  }
  return { sql: `(${parts.join(' OR ')})`, params, nextIndex: i, isStaff: false,
           partnerId, territories: usable, failed: false };
}

// Does one business fall in a partner's patch? Used by lead registration, where the answer decides whether
// a claim confirms or waits for a human.
//
// Returns { in: boolean, matched: 'region=Rockford' | null, territories }. `matched` names the grant that
// let it through, so a confirmation can be explained afterwards rather than merely asserted.
async function matchTerritory(partnerId, business, deps = {}) {
  const b = business || {};
  let territories;
  try { territories = await territoriesFor(partnerId, deps); }
  catch (e) { return { in: false, matched: null, territories: [], failed: true }; }
  const usable = territories.filter(t => isDimension(t.dimension) && t.value != null && t.value !== '');
  for (const t of usable) {
    const have = b[DIMENSION_COLUMN[t.dimension]];
    // Compared case-insensitively on trimmed text: 'Rockford' and 'rockford, il' arrive from different
    // sources, and a claim that fails on capitalisation would look like a territory dispute.
    if (have != null && String(have).trim().toLowerCase() === String(t.value).trim().toLowerCase()) {
      return { in: true, matched: `${t.dimension}=${t.value}`, territories: usable, failed: false };
    }
  }
  return { in: false, matched: null, territories: usable, failed: false };
}

module.exports = { territoryScopeSql, territoriesFor, matchTerritory,
                   DIMENSIONS, DIMENSION_COLUMN, isDimension };
