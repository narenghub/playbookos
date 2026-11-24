// ── ONE AUTHORIZATION ROAD TO EVERY EMAIL PROVIDER ───────────────────────────
//
//   const gate = await assertSendAllowed({ capability, workflow, agent, to });
//   if (!gate.allowed) { /* do not call the provider */ }
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// The kill switch was enforced inside src/lib/mailer.js, immediately before the Resend call. That
// was the right place for Resend and it covered every caller of mailer.js — around 37 routes and 37
// crons — which is why it reads as complete.
//
// It is not complete. TWO MORE TRANSPORTS exist, both sending through Gmail rather than Resend:
//
//   src/lib/campaigns/cphi-runner.js   gmail.users.messages.send   cron '5 * * * 1-5'   (hourly)
//   src/lib/agents/outreach-agent.js   gmail.users.messages.send   cron '10 9 * * 1-5'
//
// Neither consulted the kill switch at all. Each was gated only by an environment variable —
// CPHI_FOLLOWUP_ENABLED and OUTREACH_ENABLED — read at the cron and turned into a local EXECUTE
// flag. A row in autonomy_stops, INCLUDING A GLOBAL STOP, did not reach either of them. The global
// stop was therefore not global, and no honest statement about email containment could be made.
//
// The guard that should have caught it, scripts/check-legacy-email-containment-db.js, runs in
// preflight as "each legacy external sender stops on its own, by name" — and its names were
// `inquiry-agent` and `procurement-agent`, both Resend. It contained no reference to Gmail. Real
// evidence, partial coverage, and a name that invites reading it as complete.
//
// ── THE PATTERN, WHICH IS WORTH MORE THAN THE BUG ────────────────────────────
//
// This is the SECOND instance of this defect class found in one day. The first: eight agents called
// the Anthropic API directly rather than through llm.js, so they sat outside the `llm.call` kill
// switch, and stopping model spend stopped three callers while leaving eight running (d0c19ee).
//
// Same shape both times — a capability gate enforced at one chokepoint while other code reaches the
// provider by a different road. The useful question about a capability is therefore not "is there a
// gate" but "is the gate the ONLY road", and that is a question a scanner can answer and a comment
// cannot. scripts/check-email-transport-coverage.js is that scanner.
//
// ── FAIL CLOSED, WITH ONE NAMED EXCEPTION ────────────────────────────────────
//
// If the stop state cannot be read, this refuses. An unreadable kill switch is an unestablished
// authorization, and an external effect is not the thing to do while unsure. That inverts mailer's
// previous behaviour for ordinary mail — it used to send on an unreadable kill state — and the
// inversion is deliberate: CEO authorization of 2026-11-10 requires "a fail-closed policy if
// authorization cannot be determined."
//
// The exception is the observability channel; see OBSERVABILITY below.

'use strict';

const { classifyRecipients, addressesOf, domainOf, companyDomains } = require('./outbound/recipients');
const { internalMailboxes: internalMailboxesOf } = require('./outbound/membership');
const { classifyByMembership } = require('./outbound/membership');

// ── EVERY ADDRESS THAT RECEIVES THE MESSAGE, NOT JUST THE ONES IN `to` ───────
//
// Found 2026-11-24 while auditing the containment reason. sendEmailDetailed accepted `cc` and
// deliverAuthorized put it straight into the provider payload as body.cc — but the gate was called
// with `to` ALONE. So an email addressed to a colleague with an outside address in `cc` passed the
// approval boundary untouched and the cc'd party received it with no approval. Not hypothetical:
// sitenex-phase3.routes.js:536 cc's a partner address, procurement-rfq.js cc's `copyTo` on supplier
// RFQs, and buyer-email-approval.js cc's whatever a stored payload holds.
//
// Same defect class as the Gmail transports described above — a gate that is real, and is not the
// only road. There the second road was another provider; here it is another FIELD on the same
// provider call. The useful question is not "is the gate called" but "does the gate see everything
// that will receive this": a parameter the gate never reads is a recipient it cannot judge.
//
// `bcc` is read here although sendEmailDetailed does not destructure it, so nothing reaches the
// provider that way today. Callers already pass it (procurement-rfq.js:637 sends `bcc: []`), so one
// added parameter in mailer.js is all that separates today's safe accident from a third unjudged
// channel. Reading it now costs nothing and removes that step.

// ── COMPANY-SCOPED RECIPIENT CLASSIFICATION ─────────────────────────────────
//
// Internal = an ACTIVE MEMBER OF THIS COMPANY, or an allowlisted shared mailbox. Everything else
// is external and needs a released approval.
//
// Built on identity/company-membership.js rather than on a query here, so the six-condition live
// predicate — global deactivation, scoped revocation, effective dates, company status and two
// external-role screens — exists once. `departedOrUnknown` keeps its own name: an address on a
// company domain belonging to no active member of this company is the class the capability-wide
// stop existed to catch, and an operator reading a refusal should see it called that.
async function classifyByCompanyMembership(to, companyId, env, deps = {}) {
  const MEMBERS = deps.membership || require('./identity/company-membership');
  const all = addressesOf(to);
  const domains = companyDomains(env);
  const mailboxes = internalMailboxesOf(env);

  const members = await MEMBERS.activeMemberAddresses(all, { companyId, ...deps });
  const membershipUnknown = members === MEMBERS.UNKNOWN;

  // ── TWO VERY DIFFERENT PEOPLE LOOK ALIKE ON A COMPANY DOMAIN ───────────
  //
  // Once "internal" is scoped to one company, an address on a company domain that is not an
  // active member HERE could be either of:
  //
  //   a DEPARTED account   — employed nowhere. Hard-refused: an approval must not reinstate a
  //                          deactivated employee (owner instruction).
  //   a SISTER-COMPANY     — an active colleague at Adifice while ABIOZEN is sending. Not
  //   colleague              deactivated at all, so refusing them as "a deactivated or unknown
  //                          account" states something false AND forbids a send that a human may
  //                          legitimately approve.
  //
  // The first draft of this collapsed them, and the gate's own test caught it: an active Adifice
  // employee was refused as NOT_ACTIVE_MEMBER. So employment-ANYWHERE is resolved as well, and it
  // is the only thing that separates the two. A sister-company colleague is EXTERNAL — they need
  // an approval, which is the correct answer for someone outside this company's internal traffic.
  const anywhere = await classifyByMembership(all, env, deps);
  const employedSomewhere = new Set(
    (anywhere && !anywhere.membershipUnknown ? anywhere.internal : []).map((a) => String(a).toLowerCase()));

  const internal = [];
  const external = [];
  const departedOrUnknown = [];
  const otherCompany = [];
  for (const a of all) {
    const lower = String(a).toLowerCase();
    const d = domainOf(a);
    if (!membershipUnknown && (members.has(lower) || mailboxes.has(lower))) {
      internal.push(a);
      continue;
    }
    external.push(a);
    if (employedSomewhere.has(lower)) {
      // Active, just not here. External, and recorded by its own name so a refusal does not read
      // as a departure.
      otherCompany.push(a);
    } else if (d && domains.has(d)) {
      departedOrUnknown.push(a);
    }
  }
  return {
    all,
    internal,
    external,
    unparseable: all.filter((a) => !domainOf(a)),
    allInternal: all.length > 0 && external.length === 0,
    departedOrUnknown,
    otherCompany,
    membershipUnknown,
    companyId,
    domains: [...domains],
  };
}

const ALL_RECIPIENT_FIELDS = ['to', 'cc', 'bcc'];
function allRecipientsOf(args) {
  return ALL_RECIPIENT_FIELDS.map((f) => args[f]);   // addressesOf flattens and splits comma lists
}

// Capabilities that survive a global stop. Exactly one, and it is not a promise — see the recipient
// constraint, which is what makes it narrow by construction.
const OBSERVABILITY = new Set(['email.alert']);

// ── THE SECOND GATE: NOTHING LEAVES THE COMPANY WITHOUT A HUMAN DECISION ─────
//
// CEO decision 2026-11-11, priority 1: "Enforce the same immutable approval boundary at every
// buyer-directed transmission path. A caller must not evade approval by changing workflow labels
// or transport."
//
// S2 put the boundary inside the inquiry agent. That closed one road and left two open, and both
// evasions were available by construction:
//
//   TRANSPORT — outreach-queue.js builds queue rows carrying inquiries.buyer_email, and
//   outreach-agent.js mails them through gmail.users.messages.send. The same buyers, a different
//   transport, no approval. One of the two transports that produced the 25-message breach.
//
//   LABEL — `workflow` is a string the caller picks. Passing 'outreach' rather than
//   'legacy-inquiry-buyer-email' changed which stops applied and which boundary was believed to
//   be in force.
//
// So this check is keyed on the RECIPIENT, which no caller chooses, and it lives HERE, in the
// function scripts/check-email-transport-coverage.js already proves all four transports pass
// through. A transport added next month inherits it; a relabelled workflow does not escape it.
//
// ── IT VERIFIES THE APPROVAL. IT DOES NOT TAKE THE CALLER'S WORD ─────────────
//
// A boolean parameter would re-create the exact defect that made `capability: 'email.alert'` a
// loophole: an assurance the caller supplies about itself. So the caller passes an approvalId and
// the digest of the bytes it is about to transmit, and this READS the approval row: it must exist,
// be approved, be RELEASED, and its frozen payload must hash to the same digest.
//
// Fail closed on every uncertainty, including an unreadable database. An external commercial
// message is not the thing to send while unsure.
/**
 * Is there a released approval authorising exactly these bytes?
 *
 * The SQL lives in src/lib/office/scope.js, which owns every kernel table name. It was here
 * first, written as `FROM ${APPROVAL_TABLE}` — and the scope-discipline scanner did not flag it,
 * because a constant hides a table name from a text search. That is the same indirection this
 * programme keeps finding in its own code, arrived at by accident, and it is why the check now
 * also refuses a product file that merely names a kernel table in a constant.
 *
 * @returns {{ok:true} | {ok:false, reason:string, detail:string}}
 */
async function verifyReleasedApproval({ approvalId, digest }, deps = {}) {
  const scope = deps.scope || require('./office/scope');
  try {
    return await scope.verifyReleasedApprovalForDigest({ approvalId, digest }, deps);
  } catch (e) {
    // The accessor fails closed internally; this covers the case where it cannot be reached at
    // all — a load error, a missing export — which is still an unverifiable authorization.
    return { ok: false, reason: 'approval_unreadable',
      detail: `the approval accessor could not be reached (${e && e.message})` };
  }
}

/**
 * Recipients the observability exemption may reach.
 *
 * ── THE RELABEL BYPASS THIS CLOSES ─────────────────────────────────────────
 *
 * The exemption was documented as narrow: "an alert goes only to ALERT_EMAIL/ADMIN_EMAIL from a
 * fixed template, so the exemption cannot carry autonomous business email." That was TRUE of the
 * one caller that used it, and enforced nowhere. `sendEmailDetailed` accepts `capability` as an
 * ordinary parameter, so any caller — today's, or one added next month by someone who read the
 * comment as a guarantee — could pass `capability: 'email.alert'` with an arbitrary recipient and
 * arbitrary HTML and transmit straight through a global stop.
 *
 * Narrow by convention is not narrow. The exemption now holds only when the recipient is an
 * operator address; anything else claiming to be an alert is treated as the ordinary consequential
 * send it actually is, and is stopped like one.
 */
function operatorRecipients(env = process.env) {
  return new Set([env.ALERT_EMAIL, env.ADMIN_EMAIL]
    .filter(Boolean)
    .map((s) => String(s).trim().toLowerCase()));
}

function recipientsOf(to) {
  const list = Array.isArray(to) ? to : [to];
  return list.filter(Boolean).map((s) => String(s).trim().toLowerCase());
}

/**
 * Is this send authorized right now?
 *
 * @returns {{allowed:boolean, reason:string|null, stop:object|null, exempt:boolean}}
 *
 * NEVER THROWS. Every caller is a cron or a route in the middle of work, and an exception thrown
 * from an authorization check is an outage in the thing being authorized. A failure to EVALUATE is
 * reported as a refusal, which is the fail-closed half of the contract.
 */
async function assertSendAllowed({ capability = 'email.send', workflow = null, agent = null,
  company = null, companyContext = null, to = null, cc = null, bcc = null, approvalId = null,
  digest = null } = {}, deps = {}) {
  const env = deps.env || process.env;
  const everyone = allRecipientsOf({ to, cc, bcc });

  // The exemption is claimed, then CHECKED. A message claiming to be an alert while addressed
  // somewhere else is not an alert — and `to` alone was the wrong place to check that, because an
  // alert with an outside address in cc is not an alert either. Checked against every field now.
  const claimsExempt = OBSERVABILITY.has(capability);
  let exempt = false;
  if (claimsExempt) {
    const operators = operatorRecipients(env);
    const rcpts = addressesOf(everyone);
    // No configured operator address means the exemption cannot be verified, so it is not granted.
    // An alert that cannot prove where it is going is an ordinary send.
    exempt = operators.size > 0 && rcpts.length > 0 && rcpts.every((r) => operators.has(r));
  }

  try {
    const { checkStopped, recordRefusal } = deps.autonomy || require('./autonomy');
    const blocked = await checkStopped({
      capability,
      ...(workflow ? { workflow } : {}),
      ...(agent ? { agent } : {}),
      ...(company ? { company } : {}),
    }, { consequential: !exempt });

    if (blocked) {
      const reason = `STOPPED_BY_POLICY: ${blocked.scope_type}`
        + `${blocked.scope_key ? `:${blocked.scope_key}` : ''} — ${blocked.reason}`;
      try {
        recordRefusal({ stop: blocked, what: capability, detail: { workflow, agent } });
      } catch (_) { /* the refusal record must not become the reason a refusal fails */ }
      return { allowed: false, reason, stop: blocked, exempt,
        // The scope string the ledger needs, built HERE rather than at each of the three call
        // sites. Each built its own from gate.stop and fell back to 'authorization_undetermined'
        // when it was null — so an approval refusal, which has no stop row, was about to be
        // recorded as an unreadable kill switch. A refusal filed under the wrong cause is the
        // containment-report failure of 10 November in miniature.
        scope: `${blocked.scope_type}${blocked.scope_key ? `:${blocked.scope_key}` : ''}` };
    }

    // ── NO STOP IN FORCE. DOES ANYONE OUTSIDE THE COMPANY RECEIVE THIS? ────
    //
    // Checked AFTER the kill switch, deliberately. When both would refuse, "a CEO hold is in
    // force" is the useful answer and "no approval was presented" is a distraction — and a
    // caller that fixed the approval would still be stopped.
    //
    // The observability exemption passes through: an operator alert is verified by this file to
    // be addressed to ALERT_EMAIL/ADMIN_EMAIL, which are company addresses, so it is internal by
    // the recipient rule as well. It gets no second pass here.
    // ── INTERNAL MEANS AN ACTIVE PERSON, NOT A FAMILIAR DOMAIN ────────────
    //
    // classifyRecipients answers this by DOMAIN, and that is the hole which has had all company
    // email stopped since 2026-11-03: a departed employee's address is still on the company
    // domain, so it classified as internal, so it needed no approval, so mail reached somebody who
    // should no longer receive it. The containment reason names exactly that. The only control
    // broad enough to catch it was a capability-wide stop on email.send, which has since refused
    // 369 sends in 21 days and taken the briefings, the 8am assignments, the coaching mail and
    // every escalation with them.
    //
    // outbound/membership.js narrows the question from "is that domain ours" to "is that person
    // ours, now", against users.is_active plus an explicit shared-mailbox allowlist. It returns
    // null membership — not an empty set — when the question cannot be answered, and this refuses
    // on that rather than falling back to domain matching, which would silently restore the
    // behaviour being replaced at the one moment nobody can see what it is doing.
    // ── INTERNAL IS SCOPED TO A COMPANY, AND THE COMPANY MUST BE TRUSTED ───
    //
    // classifyByMembership asks "is this address an active employee". That is right as far as it
    // goes and it is not enough for a multi-company system: an active employee of Adifice is not
    // internal to a send ABIOZEN is making. Owner requirement 6 — shared employees operate only
    // within their assigned company scopes — and the whole point of B7.8.
    //
    // WHICH COMPANY, AND WHY THE STRING IS NOT GOOD ENOUGH. `company` is a plain string that
    // dispatch.js has always accepted from its caller, so it says what the caller wants, not what
    // the system knows. `companyContext` is the branded object from office/context.js, which only
    // its three resolvers can mint — a run, an authenticated session, or a mapped scheduled
    // workflow. Requirement 7: company context must come from trusted authenticated execution
    // context, never an arbitrary identifier.
    //
    // WITHOUT A TRUSTED CONTEXT, NOTHING IS INTERNAL. Not "fall back to the string", and not
    // "fall back to employment anywhere": both would authorize a send against a company nobody
    // established. Every recipient then falls to the approval boundary below, which is the
    // fail-closed behaviour — an unmapped cron keeps refusing, loudly, instead of quietly sending
    // as whichever company it named.
    const TRUST = deps.context || require('./office/context');
    const trustedCompanyId = TRUST.isTrustedContext(companyContext)
      ? companyContext.companyId : null;

    let rcpt;
    if (trustedCompanyId) {
      rcpt = await classifyByCompanyMembership(everyone, trustedCompanyId, env, deps);
    } else {
      // No trusted company: classify by employment-anywhere ONLY to recognise departed accounts,
      // then treat every recipient as external. The departed check still runs because a
      // deactivated colleague must be refused whether or not a company was established — that
      // refusal is about the person, not the tenancy.
      const anywhere = await classifyByMembership(everyone, env, deps);
      rcpt = {
        ...anywhere,
        internal: [],
        external: anywhere.all,
        allInternal: false,
        noTrustedCompany: true,
      };
    }

    const refuseRecipients = (scopeKey, detailWhy, addresses) => {
      const why2 = `${scopeKey.toUpperCase()}: ${detailWhy} — ${addresses.join(', ')}`;
      console.warn(`[membership-gate] refusing ${capability}: ${why2}`);
      try {
        const { recordRefusal } = deps.autonomy || require('./autonomy');
        recordRefusal({
          stop: { scope_type: 'membership', scope_key: scopeKey, reason: detailWhy },
          what: capability,
          detail: { workflow, agent, addresses, approvalId: approvalId || null },
        });
      } catch (_) { /* the refusal record must not become the reason a refusal fails */ }
      return { allowed: false, reason: why2, stop: null, exempt: false,
        scope: `membership:${scopeKey}`, membershipRefusal: scopeKey, addresses };
    };

    // ── WHAT AN UNREADABLE MEMBERSHIP TABLE DOES, AND WHAT IT MUST NOT DO ──
    //
    // Nothing, here. It needs no branch of its own, because classifyByMembership already resolves
    // it the only safe way: when membership cannot be read, NOTHING is internal, so every
    // recipient falls to the approval boundary below and an internal send with no approval —
    // a briefing, a score, an assignment — is refused. That is the fail-closed requirement, met by
    // the classifier rather than by a second rule here.
    //
    // A refusal branch at this point was written first and removed, because it was WORSE than no
    // branch: it refused outright what the approval boundary would have judged, so a buyer email
    // carrying a validly released approval for exactly those bytes — a human decision, already
    // made — would have been blocked by a database outage that could not have changed the answer.
    // Fail closed means refusing what cannot be established, not refusing what has already been
    // established by other means.
    //
    // ── AN APPROVAL DOES NOT REINSTATE A DEACTIVATED EMPLOYEE ─────────────
    //
    // Refused BEFORE the approval boundary and unconditionally, because the external-approval path
    // would otherwise become an automatic override of a deactivation: a released approval would
    // make a departed colleague's address sendable exactly as if it were any outside party, which
    // is the opposite of why the account was deactivated. CEO instruction, 2026-11-24: "Departed
    // employees must be denied internal operational communications. Do not treat external approval
    // as an automatic override of employee deactivation."
    //
    // There is no bypass parameter. The two ways to permit such a send are both deliberate and
    // auditable: reactivate the user record, or add the address to INTERNAL_MAILBOXES because it is
    // a shared mailbox rather than a person.
    // Guarded by membershipUnknown, and that guard is load-bearing. With the table unreadable
    // EVERY company address lands in departedOrUnknown, so without it an outage would refuse all
    // internal mail with the reason "a deactivated account" — naming a departure that never
    // happened and sending whoever reads the refusal looking for one. The send still stops, by the
    // approval boundary below; what the guard protects is the honesty of the stated cause.
    if (!rcpt.membershipUnknown && rcpt.departedOrUnknown.length && !exempt) {
      return refuseRecipients('not_active_member',
        'on a company domain but not an active member — a deactivated or unknown account',
        rcpt.departedOrUnknown);
    }

    if (rcpt.external.length && !exempt) {
      const appr = await verifyReleasedApproval({ approvalId, digest }, deps);
      if (!appr.ok) {
        const where = rcpt.external.join(', ');
        const why2 = `EXTERNAL_WITHOUT_APPROVAL: ${appr.reason} — ${appr.detail}`;
        console.warn(`[approval-gate] refusing ${capability} to ${where}: ${why2}`);
        try {
          const { recordRefusal } = deps.autonomy || require('./autonomy');
          recordRefusal({
            stop: { scope_type: 'approval', scope_key: appr.reason, reason: appr.detail },
            what: capability,
            detail: { workflow, agent, external: rcpt.external, approvalId: approvalId || null },
          });
        } catch (_) { /* the refusal record must not become the reason a refusal fails */ }
        return { allowed: false, reason: why2, stop: null, exempt: false,
          scope: `approval:${appr.reason}`,
          approvalRefusal: appr.reason, external: rcpt.external };
      }
    }

    return { allowed: true, reason: null, stop: null, exempt };
  } catch (e) {
    const why = e && e.message ? e.message : String(e);
    // ── A CODE FAULT IS NOT AN UNREADABLE DATABASE ────────────────────────
    //
    // Found by causing one: a missing require in this file threw a ReferenceError, which this
    // catch reported as "the kill switch could not be read". The refusal was correct and
    // fail-closed, and the DIAGNOSIS sent the reader to Postgres for a bug in a require
    // statement. During an incident that is an hour spent in the wrong place.
    //
    // Still fail closed, either way. Only the stated cause changes.
    const codeFault = e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError;
    const cause = codeFault
      ? `a FAULT IN THE AUTHORIZATION CODE ITSELF, not a database problem — ${e.name}: ${why}`
      : `the kill switch could not be read — ${why}`;
    if (exempt) {
      // The one case where an unreadable kill state does not stop the message. Postgres goes down,
      // every cron halts fail-closed, and the alert explaining that must still leave — otherwise a
      // total outage becomes silence plus a console line.
      console.error(`[kill-switch] ${cause}; sending anyway (observability)`);
      return { allowed: true, reason: null, stop: null, exempt: true };
    }
    console.error(`[kill-switch] REFUSING ${capability}: ${cause}`);
    return {
      allowed: false,
      reason: `AUTHORIZATION_UNDETERMINED: ${cause}`,
      stop: null,
      exempt: false,
      scope: 'authorization_undetermined',
    };
  }
}

module.exports = { assertSendAllowed, OBSERVABILITY, operatorRecipients, recipientsOf,
  verifyReleasedApproval };
