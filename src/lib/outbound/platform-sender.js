// ── THE PLATFORM'S COMPILED-IN SENDER, IN ONE PLACE ─────────────────────────
//
// This module exists because of a circular require, and the way that cycle FAILED is the reason it
// is worth a file of its own.
//
// B7.9a needed `sender-identity.js` to treat the platform's hardcoded default sender as a
// declaration — otherwise enforcing sender authorization on the internal road refuses every send in
// any environment where neither `MAIL_FROM` nor `RESEND_FROM` is set, which is every test
// environment and would be production the day somebody unset one.
//
// The obvious implementation was `require('../mailer').DEFAULT_FROM` from inside sender-identity.
// **It silently never worked.** `mailer.js` requires `outbound/sender-identity` at module scope, so
// the two form a cycle; sender-identity's require resolves to mailer's *partially initialised*
// exports object, and `mailer.js` later REPLACES that object with `module.exports = {…}`. The cached
// reference therefore points at the original empty object for the life of the process, and
// `DEFAULT_FROM` is `undefined` for ever.
//
// It did not throw. It returned undefined, my `try/catch` around it caught nothing, and the
// authorization quietly failed closed — three tests found it by asserting the provider was invoked
// exactly once and being handed zero. **A try/catch around a circular require hides the one failure
// mode a circular require actually has**, which is a value that is silently absent rather than an
// error.
//
// So the literal lives here, required by both, and neither requires the other.
//
// ── WHAT THIS ADDRESS IS AND IS NOT ────────────────────────────────────────
//
// It is the platform's own no-reply identity, used when no company-scoped sender is declared and no
// environment variable names one. It is PLATFORM scope: it may never authorize sending on a
// company's behalf once that company has a declaration, for the same reason `company_scope` exists
// on `sender_identities` at all. And it is reviewed by being written in source rather than
// configured, which is the same argument B7.9 used for narrowing `MAIL_FROM` to the one address it
// names.

'use strict';

/** The platform default. `Name <address>` form; `oneAddress()` is what extracts the address. */
const PLATFORM_DEFAULT_FROM = 'PlayNexa <no-reply@adificetechnologies.com>';

module.exports = { PLATFORM_DEFAULT_FROM };
