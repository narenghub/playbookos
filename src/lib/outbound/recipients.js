// ── IS THIS MESSAGE LEAVING THE COMPANY? ─────────────────────────────────────
//
//   const r = classifyRecipients(to);
//   if (r.external.length) { /* this needs a human decision */ }
//
// ── WHY THE QUESTION IS ABOUT THE RECIPIENT AND NOTHING ELSE ─────────────────
//
// S2 put an approval boundary on buyer email by routing the inquiry agent through
// buyer-email-approval.js. That closed one road. The CEO decision of 2026-11-11 names the reason
// it was not enough: "a caller must not evade approval by changing workflow labels or transport."
//
// Both evasions were available. The boundary keyed on a code path, so:
//
//   • outreach-queue.js builds queue rows with `channel: 'inquiry'` carrying
//     inquiries.buyer_email, and outreach-agent.js mails them through
//     gmail.users.messages.send — the SAME buyers, a different transport, no approval.
//   • `workflow: 'legacy-inquiry-buyer-email'` is a string a caller chooses. Passing 'outreach'
//     instead changed which stops applied and which boundary was thought to be in force.
//
// A recipient is not a string a caller chooses. It is the fact that decides whether a message
// leaves the building, so it is the fact the boundary is keyed on.
//
// ── COMPANY DOMAINS ARE CONFIGURED, NOT HARDCODED ────────────────────────────
//
// This repository has been bitten twice by an address written into source: the quotation CC named
// a departed Procurement Director from a literal, on the OUTSIDE of a customer letter, where no
// personnel change could correct it; and R1 sent from a fallback nobody had chosen.
//
// So the list comes from COMPANY_EMAIL_DOMAINS. The default is the three domains this platform
// demonstrably sends from and to internally, and a domain added to the business later is a
// configuration change rather than a deploy.
//
// ── UNPARSEABLE IS EXTERNAL ──────────────────────────────────────────────────
//
// An address this cannot read is treated as OUTSIDE the company. That direction is deliberate:
// mistaking an internal address for external asks a human unnecessarily, while mistaking an
// external one for internal sends a commercial message to a stranger with no decision behind it.
// Only one of those is recoverable.

'use strict';

const DEFAULT_COMPANY_DOMAINS = Object.freeze([
  'abiozen.com',
  'adificetechnologies.com',
  'playnexa.ai',
]);

function companyDomains(env = process.env) {
  const raw = env.COMPANY_EMAIL_DOMAINS;
  if (!raw) return new Set(DEFAULT_COMPANY_DOMAINS);
  const set = new Set(String(raw).split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean));
  // An empty or whitespace-only override would make EVERY recipient internal, which is the one
  // misconfiguration that silently removes the boundary. Fall back rather than honour it.
  return set.size ? set : new Set(DEFAULT_COMPANY_DOMAINS);
}

/**
 * Flatten whatever a caller passed as `to`/`cc` into addresses.
 *
 * Accepts a string, a comma-joined string, an array, and the display forms the mailer already
 * handles ("Sarah Chen · Abiozen <sales@abiozen.com>"). Anything it cannot reduce to something
 * containing an @ is kept as-is and classified external.
 */
function addressesOf(to) {
  const parts = [];
  const push = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach(push); return; }
    for (const piece of String(v).split(',')) {
      const s = piece.trim();
      if (!s) continue;
      const m = s.match(/<([^>]+)>/);
      parts.push((m ? m[1] : s).trim().toLowerCase());
    }
  };
  push(to);
  return parts;
}

function domainOf(address) {
  const i = String(address).lastIndexOf('@');
  if (i < 0 || i === String(address).length - 1) return null;
  return String(address).slice(i + 1).trim().toLowerCase();
}

/**
 * Split recipients into inside and outside the company.
 *
 * @returns {{all:string[], internal:string[], external:string[], allInternal:boolean,
 *            unparseable:string[], domains:string[]}}
 *
 * `allInternal` is false for an EMPTY recipient list. A send with no recipient is not an internal
 * send; it is a send whose destination cannot be established, and the safe reading of that is the
 * one that asks a human rather than the one that proceeds.
 */
function classifyRecipients(to, env = process.env) {
  const domains = companyDomains(env);
  const all = addressesOf(to);
  const internal = [];
  const external = [];
  const unparseable = [];

  for (const a of all) {
    const d = domainOf(a);
    if (!d) { unparseable.push(a); external.push(a); continue; }
    if (domains.has(d)) internal.push(a);
    else external.push(a);
  }

  return {
    all,
    internal,
    external,
    unparseable,
    allInternal: all.length > 0 && external.length === 0,
    domains: [...domains],
  };
}

/** Does this message leave the company? True when it has no establishable recipient. */
function isExternal(to, env = process.env) {
  return !classifyRecipients(to, env).allInternal;
}

module.exports = {
  DEFAULT_COMPANY_DOMAINS, companyDomains, addressesOf, domainOf,
  classifyRecipients, isExternal,
};
