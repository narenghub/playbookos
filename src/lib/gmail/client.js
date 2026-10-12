// ── AN AUTHORISED GMAIL CLIENT, ON WHATEVER SCOPE IS ACTUALLY GRANTED ─────────
//
// Domain-wide delegation only permits the scopes an admin pasted into the Admin Console, and it
// does not tell you which those are: ask for one outside the list and Google answers
// `unauthorized_client`, which is the same error you get when delegation is not configured at all.
// So the only way to find out what is available is to try.
//
// ── WHY THIS TRIES gmail.send FIRST AND gmail.modify SECOND ──────────────────
//
// On 2026-10-12 the grant for client 115672336730088849964 read:
//
//     gmail.readonly, gmail.modify, calendar.readonly, drive.readonly,
//     webmasters.readonly, admin.directory.user.readonly, admin.reports.audit.readonly
//
// No `gmail.send`. I had written the check to request exactly `gmail.send` + `gmail.readonly` on
// the principle of asking for the narrowest thing that works — and that principle, applied here,
// was wrong twice over:
//
//   1. `gmail.modify` ALREADY permits messages.send. It is "all read/write except permanent
//      deletion", and sending is a write. The capability was granted; only the name differed.
//   2. The security boundary is the ADMIN GRANT, not the runtime request. `gmail.modify` is
//      already delegated domain-wide, so requesting `gmail.send` instead buys no protection
//      whatsoever — the key can still do everything modify allows. It only adds a console trip.
//
// And `gmail.modify` cannot simply be narrowed out of the grant, because two agents need it:
// meet-agent and inquiry-agent both drop the UNREAD label after reading, which is a modify
// operation. Removing it to tidy the scope list would break them.
//
// So: prefer `gmail.send` if it has been granted — it is genuinely narrower and costs nothing to
// ask for — and fall back to the `gmail.modify` that is actually there. The caller is told which
// one answered, because "sending via modify" is a fact worth having in a log.
'use strict';

const { google } = require('googleapis');
const { SCOPES, getGoogleAccessToken } = require('../google-auth');

// In preference order. Each entry is a complete scope set, not a scope to add to the previous one.
const SCOPE_SETS = [
  { name: 'send+readonly', scopes: [SCOPES.gmailSend, SCOPES.gmailReadonly] },
  { name: 'modify+readonly', scopes: [SCOPES.gmailModify, SCOPES.gmailReadonly] },
];

// Which set worked, per subject, so a run of fifty sends does not re-probe a refused scope fifty
// times. Process-local and deliberately not persisted: a grant can change under us, and the cost
// of being wrong for one process lifetime is one extra probe.
const resolved = new Map();

/**
 * An authorised Gmail API client acting as `subject`.
 * Returns { gmail, via, scopeSet, access_token } or { error, tried }.
 *
 * `via` is 'service_account' (domain-wide delegation, no token to expire) or 'refresh_token' (the
 * legacy OAuth fallback, which can expire). Callers that must run unattended should say which they
 * got rather than treating them as equivalent.
 */
async function gmailClientFor(subject, deps = {}) {
  const getToken = deps.getGoogleAccessToken || getGoogleAccessToken;
  // Injectable so the scope-fallback logic can be tested without a Google account. The fallback is
  // the part most likely to be wrong and the hardest to observe in production.
  const makeGmail = deps.gmailFactory || ((access_token) => {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token });
    return google.gmail({ version: 'v1', auth });
  });
  if (!subject) return { error: 'a subject mailbox is required — never impersonate "me" by default' };

  const preferred = resolved.get(subject);
  const order = preferred
    ? [preferred, ...SCOPE_SETS.filter((s) => s.name !== preferred.name)]
    : SCOPE_SETS;

  const tried = [];
  for (const set of order) {
    const tok = await getToken({ subject, scopes: set.scopes });
    if (tok.error) { tried.push(`${set.name}: ${tok.error}`); continue; }

    const gmail = makeGmail(tok.access_token);

    // A token that mints is not a token that works: before delegation is granted the refresh-token
    // fallback hands back a Search-Console token quite happily, and the first Gmail call is where
    // that shows up as "Request had insufficient authentication scopes". So prove it with a cheap
    // read before handing the client to a caller that is about to send mail.
    try {
      const profile = (await gmail.users.getProfile({ userId: 'me' })).data;
      const got = String(profile.emailAddress || '').toLowerCase();
      if (got !== String(subject).toLowerCase()) {
        tried.push(`${set.name}: token is for ${got}, not ${subject}`);
        continue;
      }
      resolved.set(subject, set);
      return { gmail, via: tok.via, scopeSet: set.name, access_token: tok.access_token, profile };
    } catch (e) {
      tried.push(`${set.name}: ${(e && e.message) || String(e)}`);
    }
  }
  return { error: `no usable Gmail scope for ${subject}`, tried };
}

/** Forget the cached scope set — for a test, or after a grant changes. */
function resetScopeCache() { resolved.clear(); }

module.exports = { gmailClientFor, resetScopeCache, SCOPE_SETS };
