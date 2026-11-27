// ── B7.9: A SENDER IS AN AUTHORIZED IDENTITY, NOT A FAMILIAR DOMAIN ─────────
//
//   const v = await authorizedSender({ from, replyTo, companyId, providerAccount });
//   if (!v.ok) refuse(v.code, v.reason);
//
// Owner instruction, carried since 2026-11-24 and restated in Decision 5:
//
//   *"B7.9 sender and provider-account authorization. B7.6b binds from/reply-to/provider account;
//    this is whether they are AUTHORIZED for the company. A comment-stripped source scan is not
//    proof — audit stored config, legacy mailbox credentials, signatures, database-backed
//    identities."*
//
// ── THE DEFECT IS WRITTEN DOWN IN THE CODE IT AFFECTS ──────────────────────
//
// mailer.js:116, unchanged since it was written:
//
//   `from` / `replyTo` are optional overrides. Any address on an AUTHORIZED domain works, because
//   the domain (not the individual address) is what Resend authorizes — verified by probe.
//
// Every word of that is true and it is the wrong authorization. What the probe established is a
// DELIVERABILITY fact: Resend will carry anything on a verified domain. It says nothing about
// whether this platform may send as that address. With the domain as the only check, any caller
// anywhere can send as:
//
//   • naren@abiozen.com — so a coaching email, a supplier RFQ or an alert can go out as the CEO;
//   • palash@abiozen.com — the departed Procurement Director. This repository has already recorded
//     one incident of his address appearing on the OUTSIDE of a customer letter, from a literal,
//     where no personnel change could correct it. Sending AS him is the same defect with the
//     direction reversed, and worse: a reply lands in a mailbox nobody reads;
//   • anything@abiozen.com — an address that has never existed, which bounces into a void or, if
//     the domain has a catch-all, into somebody else's inbox.
//
// And `replyTo` is the same door for answers: approve a letter, and where the reply lands is an
// unauthorized free choice on any company domain.
//
// This is B7.1 one field over. B7.1's finding was *"internal is an ACTIVE MEMBER, not a familiar
// domain"*, about recipients. This is *"a sender is an AUTHORIZED IDENTITY, not a familiar
// domain"*, about the From line. The same substitution, in the same file, on the other side of the
// envelope.
//
// ── WHY THE PROVIDER ACCOUNT IS PART OF THE DECLARATION ────────────────────
//
// `sales@abiozen.com` is a real Gmail mailbox with its own credential and six weeks of warmup, and
// it is also an address Resend would carry. Those are two different ways of being that sender, with
// two different credentials, two different reputations and two different audit trails. An identity
// authorized for one is not authorized for the other, so `provider_account` is NOT NULL on the
// declaration and is checked. Without it, a declaration made to let the warmed Gmail mailbox send
// campaigns would silently also authorize anything holding the Resend key to send as it.
//
// ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
//
// It does not decide who may RECEIVE a message — that is B7.1 and the gate. It does not bind the
// sender to an approval — that is B7.6b, which already does. It does not read the bytes of a raw
// MIME message — that is B7.7, which checks that the From header and the envelope agree. This
// answers one question: is this platform authorized to send as this identity, for this company,
// through this provider account.

'use strict';

const SHARED = require('./shared-mailboxes');

const COMPANY_SCOPE_PLATFORM = 'platform';
const PURPOSE_ANY = 'any';

const DDL = [
  `CREATE TABLE IF NOT EXISTS sender_identities (
     id               TEXT PRIMARY KEY,
     address          TEXT NOT NULL,
     company_id       TEXT REFERENCES companies(id) ON DELETE RESTRICT,
     company_scope    TEXT NOT NULL DEFAULT 'company',
     -- Which provider account may send as this address. NOT NULL and NOT defaulted: a declaration
     -- that does not say which credential it authorizes authorizes every credential, which is the
     -- hole described above.
     provider_account TEXT NOT NULL,
     purpose          TEXT NOT NULL DEFAULT 'any',
     -- May answers be routed here? Separate from sending, because they are separate powers: a
     -- shared inbox can be a legitimate Reply-To while nothing may send as it.
     may_send         BOOLEAN NOT NULL DEFAULT TRUE,
     may_receive_replies BOOLEAN NOT NULL DEFAULT TRUE,
     status           TEXT NOT NULL DEFAULT 'active',
     authorized_by    TEXT NOT NULL,
     reason           TEXT NOT NULL,
     effective_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     effective_to     TIMESTAMPTZ,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT sender_identities_status CHECK (status IN ('active','suspended','revoked')),
     CONSTRAINT sender_identities_scope CHECK (company_scope IN ('company','platform')),
     CONSTRAINT sender_identities_scope_agrees CHECK (
       (company_scope = 'company' AND company_id IS NOT NULL)
       OR (company_scope = 'platform' AND company_id IS NULL)
     ),
     CONSTRAINT sender_identities_window CHECK (effective_to IS NULL OR effective_to > effective_from),
     CONSTRAINT sender_identities_reason_not_blank CHECK (length(btrim(reason)) > 0),
     CONSTRAINT sender_identities_authorized_by_not_blank CHECK (length(btrim(authorized_by)) > 0),
     CONSTRAINT sender_identities_address_lower CHECK (address = lower(address)),
     CONSTRAINT sender_identities_provider_not_blank CHECK (length(btrim(provider_account)) > 0),
     -- A row that permits neither sending nor replies permits nothing, and reads as an
     -- authorization because it is in the table. Refused by the database.
     CONSTRAINT sender_identities_permits_something CHECK (may_send OR may_receive_replies)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sender_identities_lookup
     ON sender_identities (address, status)`,
];

async function migrateSenderIdentities(query) {
  for (const stmt of DDL) {
    try { await query(stmt); } catch (e) {
      throw new Error(`sender_identities migration failed on [${stmt.slice(0, 60).replace(/\s+/g, ' ')}…]: ${e.message}`);
    }
  }
  return { ok: true };
}

const q = (deps) => (deps && deps.query) || require('../db').query;

const problem = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

/** `"Naren B" <naren@abiozen.com>` → `naren@abiozen.com`. One address or nothing. */
function oneAddress(value) {
  const RECIPIENTS = require('./recipients');
  const all = RECIPIENTS.addressesOf(value).map((a) => String(a).toLowerCase());
  const unique = [...new Set(all)];
  if (unique.length !== 1) return null;
  if (!RECIPIENTS.domainOf(unique[0])) return null;
  return unique[0];
}

/**
 * Rows declaring an address, active and in window right now.
 *
 * `NOW()` is evaluated by the DATABASE, not by this process. B7.8d: `effective_from` is written by
 * Postgres in microseconds and a JS `new Date()` comparison in milliseconds made a row invisible to
 * its own creator in 142 of 200 trials. The same mistake here would make an identity authorized a
 * moment ago read as unauthorized.
 */
async function declarationsFor(addresses, deps = {}) {
  const wanted = [...new Set(addresses.filter(Boolean).map((a) => String(a).toLowerCase()))];
  if (!wanted.length) return { ok: true, rows: [] };
  try {
    const r = await q(deps)(
      `SELECT address, company_id, company_scope, provider_account, purpose,
              may_send, may_receive_replies
         FROM sender_identities
        WHERE address = ANY($1) AND status = 'active'
          AND effective_from <= NOW()
          AND (effective_to IS NULL OR effective_to > NOW())`,
      [wanted]);
    return { ok: true, rows: r.rows };
  } catch (e) {
    // An unreadable declaration is not an absent one and it is certainly not a permissive one.
    return { ok: false, error: e.message };
  }
}

/**
 * The env-declared default sender, as a PLATFORM-scope, any-purpose, any-provider declaration.
 *
 * `MAIL_FROM` (and `RESEND_FROM`, which the deployment also sets) is what `mailer.defaultFrom()`
 * falls back to on every send that passes no `from`. Deleting that fallback would refuse most of
 * the platform's mail the moment this lands, so it survives — narrowed to the ONE address it names,
 * at platform scope. Everything else needs a row.
 *
 * It is the default sender, not a licence for the domain: `MAIL_FROM=x@abiozen.com` authorizes
 * `x@abiozen.com` and nothing else on abiozen.com. That narrowing is the point of this function.
 */
function envDeclaredSenders(env = process.env) {
  const out = [];
  for (const key of ['MAIL_FROM', 'RESEND_FROM']) {
    const a = oneAddress(env[key]);
    if (a) out.push({ address: a, source: key });
  }
  // ── THE COMPILED-IN PLATFORM DEFAULT, WHICH IS ALSO A DECLARATION ────────
  //
  // Found by wiring B7.9a into the internal road: `mailer.DEFAULT_FROM` is a hardcoded
  // `PlayNexa <no-reply@adificetechnologies.com>`, used whenever MAIL_FROM and RESEND_FROM are both
  // unset. It had no declaration anywhere, so enforcing sender authorization on the internal road
  // refused EVERY internal send in any environment without those variables — which is every test
  // environment, and would be production the day somebody unset one.
  //
  // It belongs here by the same argument B7.9 used to keep MAIL_FROM: it names exactly ONE address,
  // and that address is reviewed by being written in source rather than configured. What it is NOT
  // is a company authorization — it is platform scope, like the env entries beside it, so it can
  // never authorize sending on a company's behalf once a declaration exists for that company.
  //
  // `envEntriesNeedingDeclaration()` reports it alongside the env vars, so B7.11a's migration list
  // names it rather than leaving it as the one source nobody has to declare.
  // From `outbound/platform-sender.js`, NOT from `../mailer`. The two form a cycle, and reading
  // DEFAULT_FROM across it returned `undefined` for the life of the process without throwing — see
  // that module's header. No try/catch here either: a missing constant is a programming error that
  // should be loud, and the previous catch is what made it quiet.
  const compiled = oneAddress(require('./platform-sender').PLATFORM_DEFAULT_FROM);
  if (compiled && !out.some((e) => e.address === compiled)) {
    out.push({ address: compiled, source: 'platform-sender.PLATFORM_DEFAULT_FROM' });
  }
  return out;
}

/**
 * Is this platform authorized to send as this identity, for this company, through this account?
 *
 * @param {object} spec  { from, replyTo?, companyId?, providerAccount, purpose? }
 * @param {object} deps  { query, env }
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, sender?:string,
 *                     replyTo?:string|null, via?:string}>}
 */
async function authorizedSender({ from, replyTo = null, companyId = null,
  providerAccount = null, purpose = null } = {}, deps = {}) {
  const env = deps.env || process.env;

  const sender = oneAddress(from);
  if (!sender) {
    return problem('sender_unestablished',
      `the sender ${JSON.stringify(from)} does not resolve to exactly one address. A send has one `
      + 'identity, and which one it is decides which provider account and which company '
      + 'authorization apply');
  }
  if (!providerAccount || !String(providerAccount).trim()) {
    return problem('provider_account_unestablished',
      `sending as ${sender} was requested without naming a provider account. The same address can `
      + 'be a warmed Gmail mailbox with its own credential and an address Resend would carry; those '
      + 'are two different ways of being this sender, and an authorization for one is not an '
      + 'authorization for the other');
  }
  const account = String(providerAccount).trim();

  const wanted = [sender, ...(replyTo ? [oneAddress(replyTo)].filter(Boolean) : [])];
  if (replyTo && !oneAddress(replyTo)) {
    return problem('reply_to_unestablished',
      `the reply-to ${JSON.stringify(replyTo)} does not resolve to exactly one address, so where an `
      + 'answer to this message lands cannot be established');
  }

  // ── THE DEACTIVATED-ACCOUNT OVERRIDE ────────────────────────────────────
  //
  // Read first so no declaration can be accepted before it is known, decided before anything else
  // so it cannot be outvoted. Same rule and same ordering as B7.11's shared mailboxes, and the
  // reason is sharper here: a declaration that lets this platform send AS a departed employee puts
  // their name on the outside of a customer letter and routes the reply to a mailbox nobody reads.
  const deactivated = await SHARED.deactivatedAccounts(wanted, deps);
  if (deactivated === null) {
    return problem('sender_authorization_unknown',
      'the user table could not be read, so whether this sender belongs to a deactivated account is '
      + 'unknowable. Refusing: an unknown answer to that question is not a yes');
  }
  if (deactivated.has(sender)) {
    return problem('deactivated_sender',
      `${sender} belongs to a DEACTIVATED user account. No declaration authorizes sending as a `
      + 'person who has left — their name would appear on the outside of the message and the reply '
      + 'would land in a mailbox nobody reads');
  }
  const replyAddress = replyTo ? oneAddress(replyTo) : null;
  if (replyAddress && deactivated.has(replyAddress)) {
    return problem('deactivated_reply_to',
      `${replyAddress} belongs to a DEACTIVATED user account, so answers to this message would land `
      + 'in a mailbox nobody reads');
  }

  const declared = await declarationsFor(wanted, deps);
  if (!declared.ok) {
    return problem('sender_authorization_unknown',
      `the sender declarations could not be read (${declared.error}). An unreadable declaration is `
      + 'not a declaration, and this fails closed');
  }

  // ── THE SENDER ──────────────────────────────────────────────────────────
  const forSender = declared.rows.filter((r) => r.address === sender && r.may_send);
  const scopeOk = forSender.filter((r) => (
    companyId
      ? (r.company_scope === 'company' && r.company_id === companyId)
        || r.company_scope === COMPANY_SCOPE_PLATFORM
      : r.company_scope === COMPANY_SCOPE_PLATFORM
  ));
  const purposeOk = scopeOk.filter((r) => (
    r.purpose === PURPOSE_ANY || (purpose !== null && r.purpose === purpose)
  ));
  const accountOk = purposeOk.filter((r) => r.provider_account === account);

  let via = null;
  if (accountOk.length) {
    via = `sender_identities (${accountOk[0].company_scope === 'platform' ? 'platform' : accountOk[0].company_id})`;
  } else if (!forSender.length && envDeclaredSenders(env).some((e) => e.address === sender)) {
    // The env default, treated as a PLATFORM-scope declaration — which a company-scoped send
    // accepts, exactly as it accepts a platform row from the table.
    //
    // The `!forSender.length` guard matters: it applies only when NOTHING in the table declares
    // this address. Once a row exists, the row governs, and a wrong company or a wrong provider
    // account is reported as the mismatch it is rather than quietly satisfied by the env default.
    // Otherwise adding a narrow declaration would be a no-op for any address that is also the
    // platform default, which is the opposite of what declaring it is for.
    via = 'MAIL_FROM/RESEND_FROM (platform default)';
  }

  if (!via) {
    if (purposeOk.length && !accountOk.length) {
      return problem('provider_account_mismatch',
        `${sender} is a declared sender, but for provider account(s) `
        + `${[...new Set(purposeOk.map((r) => r.provider_account))].join(', ')} — not ${account}. `
        + 'The same address through a different credential is a different sender, with a different '
        + 'reputation and a different audit trail',
        { sender, requestedAccount: account,
          declaredAccounts: [...new Set(purposeOk.map((r) => r.provider_account))] });
    }
    if (scopeOk.length && !purposeOk.length) {
      return problem('sender_purpose_mismatch',
        `${sender} is a declared sender but not for purpose ${JSON.stringify(purpose)}`);
    }
    if (forSender.length && !scopeOk.length) {
      return problem('sender_not_authorized_for_company',
        `${sender} is a declared sender, but not for company ${companyId}. Three companies share `
        + 'this platform; a declaration made for one is not an identity the others may send as',
        { sender, companyId });
    }
    return problem('sender_not_authorized',
      `nothing authorizes this platform to send as ${sender} through ${account}. Being on a company `
      + 'domain is not an authorization — that is a deliverability fact about the provider, and it '
      + 'is what let any caller send as the CEO or as a departed director',
      { sender, account, companyId });
  }

  // ── THE REPLY-TO ────────────────────────────────────────────────────────
  //
  // Checked WITHOUT the provider account, deliberately: nothing sends from a Reply-To, so which
  // credential carries the message says nothing about whether answers may land there. Requiring a
  // provider match would refuse a perfectly ordinary shared inbox for a reason that does not apply
  // to it.
  if (replyAddress && replyAddress !== sender) {
    const forReply = declared.rows.filter((r) => r.address === replyAddress && r.may_receive_replies);
    const replyScopeOk = forReply.filter((r) => (
      companyId
        ? (r.company_scope === 'company' && r.company_id === companyId)
          || r.company_scope === COMPANY_SCOPE_PLATFORM
        : r.company_scope === COMPANY_SCOPE_PLATFORM
    ));
    if (!replyScopeOk.length) {
      return problem('reply_to_not_authorized',
        `nothing authorizes answers to this message landing at ${replyAddress}`
        + (companyId ? ` for company ${companyId}` : '')
        + '. Where a reply goes is part of what a human approved, and a domain match is not a '
        + 'declaration — the R1 incident sent from a fallback nobody had chosen',
        { replyTo: replyAddress, companyId });
    }
  }

  return { ok: true, sender, replyTo: replyAddress, via, account };
}

/**
 * Every identity the platform could send as, by source. Read-only; the audit the owner required.
 *
 * Deliberately NOT a source scan: the owner's instruction says in as many words that *"a
 * comment-stripped source scan is not proof"*. A scan finds literals; it cannot find an address
 * sitting in a database row, an env var, or a stored integration config. This asks each source.
 */
async function declaredIdentities(deps = {}) {
  const env = deps.env || process.env;
  const out = { env: envDeclaredSenders(env), table: [], tableReadable: true,
    undeclaredEnv: [], defaultFrom: null };

  try {
    const MAILER = require('../mailer');
    out.defaultFrom = oneAddress(MAILER.defaultFrom(env)) || null;
  } catch (_) { out.defaultFrom = null; }

  try {
    const r = await q(deps)(
      `SELECT address, company_id, company_scope, provider_account, purpose, status,
              may_send, may_receive_replies, authorized_by, effective_to
         FROM sender_identities ORDER BY address, provider_account`);
    out.table = r.rows;
  } catch (e) {
    out.tableReadable = false;
    out.tableError = e.message;
  }

  const declaredAddresses = new Set(out.table
    .filter((r) => r.status === 'active').map((r) => r.address));
  const envAddresses = new Set(out.env.map((e) => e.address));
  if (out.defaultFrom) envAddresses.add(out.defaultFrom);
  out.undeclaredEnv = [...envAddresses].filter((a) => !declaredAddresses.has(a)).sort();

  return out;
}

module.exports = {
  migrateSenderIdentities, DDL,
  authorizedSender, declarationsFor, declaredIdentities, envDeclaredSenders, oneAddress,
  COMPANY_SCOPE_PLATFORM, PURPOSE_ANY,
};
