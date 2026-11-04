// ── A PARTICIPANT ON A THREAD IS NOT NECESSARILY A CONTACT TO ADD ───────────
//
// The evidence probe swept every address on each CPHI thread and reported those absent from
// `cphi_exhibitor_contacts` under the heading:
//
//     2 participant(s) on a thread who are NOT in our contacts
//        Alivus: Rakesh Pratap Singh <Rakesh.Singh@alivus.com>
//        Alivus: Palash Das <palash@abiozen.com>
//
// Both statements are true. The heading is the problem: it reads as a list of people to add, and
// the second is a DEPARTED EMPLOYEE on our own domain, surfaced because a supplier had forwarded a
// message addressed to him. A finding that invites re-creating him as a contact runs directly into
// the standing rule:
//
//     Palash may exist in HISTORY. He must not exist as LIVE AUTHORITY.
//
// He appears there legitimately, as provenance — the Alivus catalogue reached us because Rakesh
// forwarded a message he had sent to Palash in August. That fact is worth keeping. What must not
// happen is it being read as an action.
//
// So classification is explicit and separate from discovery: an address is INTERNAL (our own
// domain — colleagues past and present, aliases, distribution lists) or EXTERNAL (the supplier's
// side). Only external addresses are ever candidates to add. Internal ones are reported as
// historical participants, under their own heading, with nothing to do.
'use strict';

const domainOf = (e) => String(e || '').toLowerCase().split('@')[1] || null;

/**
 * classifyParticipant({ email, ourDomains })
 *
 * `ourDomains` is every domain the company sends from. Anything on one of them is internal, which
 * is a statement about the address and needs no roster lookup — that is the point. A roster can be
 * stale, and a departed colleague is exactly the case where it will be.
 */
function classifyParticipant({ email, ourDomains = [] } = {}) {
  const d = domainOf(email);
  const ours = ourDomains.map((x) => String(x || '').toLowerCase().replace(/^@/, '')).filter(Boolean);
  const internal = Boolean(d && ours.includes(d));
  return {
    email: String(email || '').toLowerCase(),
    domain: d,
    internal,
    // The only field a caller should branch on when deciding whether to propose adding somebody.
    addable: Boolean(d) && !internal,
    reason: internal
      ? 'our own domain — a colleague, alias or distribution list, present as historical provenance'
      : 'external party on the supplier side',
  };
}

/** Split a participant list into the two groups, preserving order within each. */
function splitParticipants(list, ourDomains) {
  const external = [];
  const internal = [];
  for (const p of list || []) {
    const c = classifyParticipant({ email: p.email, ourDomains });
    (c.addable ? external : internal).push({ ...p, ...c });
  }
  return { external, internal };
}

module.exports = { classifyParticipant, splitParticipants, domainOf };
