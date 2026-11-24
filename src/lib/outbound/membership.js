// ── WHO COUNTS AS INTERNAL ───────────────────────────────────────────────────
//
// `classifyRecipients` in recipients.js decides "internal" by DOMAIN: an address whose domain is in
// WORKSPACE_DOMAINS is internal, and anything else is external. That is the right first cut and it
// has one hole, which is the hole that has had all company email stopped since 2026-11-03:
//
//     A DEPARTED EMPLOYEE'S ADDRESS IS STILL ON THE COMPANY DOMAIN.
//
// So it classifies as internal, needs no approval, and mail reaches somebody who should no longer
// receive it. The CEO's own containment reason names exactly this — "legacy Abiozen email paths
// containing unauthorized/departed employee identity" — and the only control broad enough to catch
// it was a capability-wide stop on email.send. That stop has refused 369 sends in 21 days, which
// also took out the daily briefings, the 8am task assignments, the 6pm coaching mail and every
// escalation. The cure was correct and it is costing the operating loop.
//
// This module narrows the question from "is that domain ours" to "is that person ours, now".
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
// An address is INTERNAL only if, at send time, one of these is true:
//
//   1. it matches an ACTIVE user record (`users.is_active = 1`), compared case-insensitively; or
//   2. it is in the explicit shared-mailbox allowlist (INTERNAL_MAILBOXES).
//
// Everything else is EXTERNAL, which under email-gate means it requires a released approval. That
// includes the case this exists for: an address on the company domain belonging to nobody active.
//
// (2) exists because a company has mailboxes that are not people — sales@, support@ — and requiring
// a user row for those would classify legitimate internal destinations as external. The allowlist
// is explicit and auditable rather than inferred, because "it looks like a role address" is a guess
// and this file is where guesses stop.
//
// ── FAIL CLOSED, AND WHAT THAT MEANS HERE ───────────────────────────────────
//
// If membership cannot be determined — the database is unreadable, the users table is absent — then
// NOTHING is internal. Every recipient becomes external and needs an approval. The alternative
// (fall back to domain matching) would mean the control silently reverts to the behaviour it exists
// to replace, at exactly the moment nobody can see what it is doing.
//
// That is deliberately the opposite of convenient: a database outage stops internal mail too. The
// observability exemption in email-gate.js is the designed escape for the one message class that
// must still leave during an outage, and it is verified against operator addresses rather than
// claimed.

'use strict';

const { addressesOf, domainOf, companyDomains } = require('./recipients');

const q = (deps) => (deps && deps.query) || require('../db').query;

/** Shared mailboxes that are internal without being a person. Explicit, never inferred. */
function internalMailboxes(env = process.env) {
  return new Set(
    String(env.INTERNAL_MAILBOXES || '')
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The active-member subset of `addresses`, compared case-insensitively.
 *
 * Returns null — NOT an empty set — when membership could not be read. The caller must treat null
 * as "unknowable" and fail closed; an empty set means "asked, and none of them are members", which
 * is a different fact and must not be conflated with it. Returning [] on error is how a fail-closed
 * control becomes a fail-open one.
 */
async function activeMembers(addresses, deps = {}) {
  const wanted = [...new Set(addresses.map((a) => String(a).toLowerCase()))].filter(Boolean);
  if (!wanted.length) return new Set();
  try {
    const r = await q(deps)(
      `SELECT lower(email) AS email FROM users WHERE is_active = 1 AND lower(email) = ANY($1)`,
      [wanted]);
    return new Set(r.rows.map((x) => x.email));
  } catch (_) {
    return null;                                  // unknowable — the caller fails closed
  }
}

/**
 * Classify recipients by ACTIVE MEMBERSHIP rather than by domain.
 *
 * {
 *   all, internal, external, unparseable,
 *   allInternal,                     // true only if there is at least one recipient and none external
 *   departedOrUnknown,               // on a company domain, but not an active member — the hole
 *   membershipUnknown,               // true when membership could not be read; everything is external
 * }
 */
async function classifyByMembership(to, env = process.env, deps = {}) {
  const all = addressesOf(to);
  const domains = companyDomains(env);
  const mailboxes = internalMailboxes(env);

  const unparseable = all.filter((a) => !domainOf(a));
  const members = await activeMembers(all, deps);
  const membershipUnknown = members === null;

  const internal = [];
  const external = [];
  const departedOrUnknown = [];

  for (const a of all) {
    const lower = String(a).toLowerCase();
    const d = domainOf(a);
    const onCompanyDomain = Boolean(d) && domains.has(d);

    if (!membershipUnknown && (members.has(lower) || mailboxes.has(lower))) {
      internal.push(a);
      continue;
    }
    external.push(a);
    // Worth naming separately: an address that LOOKS internal and is not. That is the class the
    // capability-wide stop existed to catch, and an operator reading a refusal should see it
    // called by its name rather than lumped in with ordinary outside recipients.
    if (onCompanyDomain) departedOrUnknown.push(a);
  }

  return {
    all,
    internal,
    external,
    unparseable,
    allInternal: all.length > 0 && external.length === 0,
    departedOrUnknown,
    membershipUnknown,
    domains: [...domains],
  };
}

module.exports = { classifyByMembership, activeMembers, internalMailboxes };
