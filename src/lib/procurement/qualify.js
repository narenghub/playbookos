'use strict';
// ── PR-5: THE OPPORTUNITY QUALIFICATION ENGINE ───────────────────────────────
//
// Pure. No database, no network, no clock except the `asOf` the caller passes — so the same inputs
// always give the same verdict, and a verdict can be recomputed from its stored evidence.
//
// Four verdicts, per the brief's §6: QUALIFIED, CONDITIONAL, NOT_QUALIFIED, NEEDS_REVIEW.
//
// ── EVERY DETERMINATION CARRIES EVIDENCE AND A REASON ───────────────────────
//
// §6 requires it, and it is why a finding is a row per criterion rather than a blob on the
// assessment. A verdict whose per-criterion evidence cannot be retrieved is not auditable, and the
// thirteen criteria each need their own provenance.
//
// ── WHAT "MANDATORY" MEANS HERE, EXACTLY ────────────────────────────────────
//
// A mandatory criterion is a GATE, so it has three outcomes and all three are decisive:
//
//     FAIL     → NOT_QUALIFIED, whatever else passed. One closed gate is enough.
//     UNKNOWN  → NEEDS_REVIEW. Never QUALIFIED, never CONDITIONAL.
//     PASS     → carry on.
//
// The UNKNOWN rule is the one that matters most, and it is the opposite of the convenient default.
// An agent that treats "we have no evidence either way" as a soft pass produces QUALIFIED verdicts
// built on absences, and the absences are invisible in the output. Here an unknown gate stops the
// verdict and names itself.
//
// Advisory criteria cannot cause NOT_QUALIFIED. They downgrade QUALIFIED to CONDITIONAL and say why.
//
// ── A CONSEQUENCE WORTH STATING BEFORE ANYBODY RUNS THIS ────────────────────
//
// There is no verified-capability registry in this codebase. §8 forbids inventing certifications,
// project references, equipment, laboratory capacity or regulatory approvals, so `verified_capability`
// and `accreditation` can only resolve against rows that exist — and none do.
//
// Therefore, until a capability registry exists, THIS ENGINE RETURNS NEEDS_REVIEW FOR EVERYTHING.
// That is the correct output and not a defect: it is the honest statement that nobody has yet
// recorded what Abiozen can actually supply and what it is accredited to do. A version that
// returned QUALIFIED by assuming capability would be inventing exactly what §8 forbids, and would
// do it silently.
//
// ── THE SAM REGISTRATION GATE MAKES A CALENDAR FACT VISIBLE ─────────────────
//
// Registration is checked against the SUBMISSION DEADLINE, not against today. A registration that
// is active now but expires before the deadline cannot support an award, so it FAILS rather than
// passing with a note. Abiozen's expires 2026-12-30; this is how that date shows up in the product
// instead of as a surprise.

const RESULTS = Object.freeze(['pass', 'fail', 'unknown', 'not_applicable']);
const VERDICTS = Object.freeze(['QUALIFIED', 'CONDITIONAL', 'NOT_QUALIFIED', 'NEEDS_REVIEW']);

// Bump when a criterion is added, removed or its logic changes. Stored on the assessment so a
// verdict can be read against the rules that produced it rather than against today's.
const RULE_SET_VERSION = 'pr5-2026-11-05';

// ── the criteria ────────────────────────────────────────────────────────────
//
// `mandatory` is from the ruling: legal eligibility, verified capabilities, accreditation
// requirements, sourcing restrictions, delivery feasibility and registration status are gates.
// Record kind and deadline are gates too — a bid against a sources-sought notice or a closed
// solicitation is not a near miss, it is an impossibility.
const CRITERIA = Object.freeze([
  { key: 'record_kind_biddable', mandatory: true, label: 'the record is a biddable solicitation' },
  { key: 'submission_deadline', mandatory: true, label: 'the response deadline has not passed' },
  { key: 'sam_registration', mandatory: true, label: 'SAM registration active through the deadline' },
  { key: 'legal_entity_eligibility', mandatory: true, label: 'legal entity and size eligibility' },
  { key: 'set_aside_eligibility', mandatory: true, label: 'set-aside eligibility' },
  { key: 'naics_psc_applicability', mandatory: true, label: 'NAICS / PSC applicability' },
  { key: 'verified_capability', mandatory: true, label: 'the requirement maps to a verified capability' },
  { key: 'accreditation', mandatory: true, label: 'required accreditations held and in scope' },
  { key: 'country_of_origin', mandatory: true, label: 'country-of-origin and sourcing restrictions' },
  { key: 'delivery_feasibility', mandatory: true, label: 'supplier capacity and delivery feasibility' },
  { key: 'past_performance', mandatory: false, label: 'past-performance requirements' },
  { key: 'insurance_and_risk', mandatory: false, label: 'insurance and contractual risk' },
  { key: 'financial_viability', mandatory: false, label: 'financial viability' },
]);

const MANDATORY_KEYS = Object.freeze(CRITERIA.filter((c) => c.mandatory).map((c) => c.key));

function finding(key, result, reason, evidence = {}) {
  if (!RESULTS.includes(result)) throw new Error(`qualify: unknown result "${result}" for ${key}`);
  const c = CRITERIA.find((x) => x.key === key);
  if (!c) throw new Error(`qualify: unknown criterion "${key}"`);
  return {
    criterion_key: key,
    label: c.label,
    mandatory: c.mandatory,
    result,
    reason,
    evidence_text: evidence.text || null,
    evidence_source_url: evidence.url || null,
  };
}

const isoDay = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null);

// ── individual gates ───────────────────────────────────────────────────────

function assessRecordKind(record, deps) {
  const b = deps.biddability(record);
  if (b.biddable) return finding('record_kind_biddable', 'pass', b.reason, { url: record.sourceUrl });
  // FAIL for a category error, UNKNOWN for a data gap, and the difference matters.
  //
  // A sources-sought notice can never be bid however complete its data, so NOT_QUALIFIED is the
  // right verdict and the record can be archived. A solicitation whose deadline was not captured is
  // a gap in OUR data, not a fact about the opportunity — the deadline almost certainly exists on
  // the source. Failing it would archive a real opportunity, so it goes to review instead.
  const result = b.determinable === false ? 'unknown' : 'fail';
  return finding('record_kind_biddable', result, b.reason, { url: record.sourceUrl });
}

function assessDeadline(record, asOf) {
  const dl = isoDay(record.responseDeadline);
  if (!dl) {
    return finding('submission_deadline', 'unknown',
      'no response deadline is recorded, so whether there is time cannot be determined');
  }
  if (dl < asOf) {
    return finding('submission_deadline', 'fail',
      `the response deadline ${dl} is in the past (as of ${asOf})`, { text: dl });
  }
  const days = Math.round((Date.parse(`${dl}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 864e5);
  return finding('submission_deadline', 'pass', `${days} day(s) until the ${dl} deadline`, { text: dl });
}

function assessSamRegistration(registration, record, asOf) {
  if (!registration || !registration.uei) {
    return finding('sam_registration', 'unknown',
      'no SAM registration record was supplied, so registration status cannot be determined');
  }
  const ev = { text: `UEI ${registration.uei}${registration.cage ? `, CAGE ${registration.cage}` : ''}` };
  if (registration.status && String(registration.status).toLowerCase() !== 'active') {
    return finding('sam_registration', 'fail',
      `the SAM registration is "${registration.status}", not active`, ev);
  }
  const expiry = isoDay(registration.expiresOn);
  if (!expiry) {
    return finding('sam_registration', 'unknown',
      'the registration has no recorded expiry date, so it cannot be checked against the deadline', ev);
  }
  if (expiry < asOf) {
    return finding('sam_registration', 'fail', `the SAM registration expired on ${expiry}`, ev);
  }
  // THE POINT OF THIS GATE. Checked against the deadline, not against today.
  const deadline = isoDay(record.responseDeadline);
  if (deadline && expiry < deadline) {
    return finding('sam_registration', 'fail',
      `the SAM registration expires ${expiry}, BEFORE the ${deadline} response deadline. An award `
      + 'cannot be made to an entity whose registration has lapsed, so this is a closed gate rather '
      + 'than a note — renew before responding.', ev);
  }
  const days = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 864e5);
  // A pass either way — the registration does cover this deadline. The near-expiry wording is a
  // warning carried on a passing finding, not a different result: downgrading the gate would block
  // opportunities we are in fact eligible for, and renewal urgency belongs in the reason where a
  // human reads it.
  const soon = days <= 60;
  return finding('sam_registration', 'pass',
    soon
      ? `active and covers this deadline, but expires ${expiry} — ${days} day(s) away. Renew now: `
        + 'SAM processing has a multi-week tail, so later deadlines will start failing this gate.'
      : `active through ${expiry} (${days} days)`,
    ev);
}

function assessPolicyGate(key, policy, { unknownReason, failReason }) {
  if (policy == null) return finding(key, 'unknown', unknownReason);
  if (policy.applicable === false) {
    return finding(key, 'not_applicable', policy.reason || 'the solicitation imposes no such requirement');
  }
  if (policy.satisfied === true) {
    return finding(key, 'pass', policy.reason || 'requirement satisfied', { text: policy.evidence, url: policy.url });
  }
  if (policy.satisfied === false) {
    return finding(key, 'fail', policy.reason || failReason, { text: policy.evidence, url: policy.url });
  }
  return finding(key, 'unknown', policy.reason || unknownReason, { text: policy.evidence, url: policy.url });
}

/**
 * Capability and accreditation resolve against ROWS, never against a claim.
 *
 * §8: "Do not invent certifications, project references, equipment, laboratory capacity, or
 * regulatory approvals." The structural form of that is an id lookup — a requirement either maps to
 * a capability row we hold, or it does not map. A truthy string in a field is not a capability.
 */
function assessVerifiedCapability(record, capabilities) {
  if (!Array.isArray(capabilities)) {
    return finding('verified_capability', 'unknown',
      'no verified-capability registry was supplied. §8 forbids inventing capabilities, so a '
      + 'requirement cannot be confirmed as something we can supply. This is the gate that keeps '
      + 'every verdict at NEEDS_REVIEW until a registry exists.');
  }
  const required = Array.isArray(record.requiredCapabilities) ? record.requiredCapabilities : [];
  if (!required.length) {
    return finding('verified_capability', 'unknown',
      'the solicitation\'s required capabilities have not been extracted, so there is nothing to '
      + 'map. An empty requirement list must not read as "nothing required".');
  }
  const held = new Map(capabilities.filter((c) => c && c.id).map((c) => [String(c.id), c]));
  const missing = required.filter((r) => !held.has(String(r)));
  if (missing.length) {
    return finding('verified_capability', 'fail',
      `no verified capability row for: ${missing.join(', ')}`,
      { text: `holds ${[...held.keys()].join(', ') || 'nothing'}` });
  }
  return finding('verified_capability', 'pass',
    `every required capability maps to a held row: ${required.join(', ')}`,
    { text: required.map((r) => `${r} → ${held.get(String(r)).reference || 'row'}`).join('; ') });
}

function assessAccreditation(record, accreditations) {
  if (!Array.isArray(accreditations)) {
    return finding('accreditation', 'unknown',
      'no accreditation registry was supplied. An accreditation claim must resolve to a row with a '
      + 'scope and an expiry; §8 forbids asserting one we cannot show.');
  }
  const required = Array.isArray(record.requiredAccreditations) ? record.requiredAccreditations : [];
  if (!required.length) {
    return finding('accreditation', 'unknown',
      'required accreditations have not been extracted from the solicitation');
  }
  const held = new Map(accreditations.filter((a) => a && a.id).map((a) => [String(a.id), a]));
  const missing = required.filter((r) => !held.has(String(r)));
  if (missing.length) {
    return finding('accreditation', 'fail', `not accredited for: ${missing.join(', ')}`);
  }
  // Scope matters as much as possession: ISO 17025 is accredited for named methods, not in general.
  const outOfScope = required.filter((r) => {
    const a = held.get(String(r));
    return a.inScope === false;
  });
  if (outOfScope.length) {
    return finding('accreditation', 'fail',
      `held but OUT OF SCOPE for: ${outOfScope.join(', ')} — an accreditation covers named methods, `
      + 'not a field in general');
  }
  return finding('accreditation', 'pass', `accredited and in scope for: ${required.join(', ')}`);
}

/**
 * Assess one opportunity. Returns the verdict plus one finding per criterion.
 *
 * @param {object} input
 * @param {object} input.record            the normalised opportunity (recordKind, responseDeadline, …)
 * @param {object} [input.registration]    { uei, cage, status, expiresOn }
 * @param {Array}  [input.capabilities]    verified capability rows — absent means UNKNOWN, not none
 * @param {Array}  [input.accreditations]  accreditation rows with scope
 * @param {object} [input.policy]          per-criterion { applicable, satisfied, reason, evidence, url }
 * @param {string} input.asOf              YYYY-MM-DD; required, so a verdict is reproducible
 */
function assess(input = {}, deps = {}) {
  const biddabilityFn = deps.biddability || require('./record-kind').biddability;
  const asOf = isoDay(input.asOf);
  if (!asOf) throw new Error('assess: asOf (YYYY-MM-DD) is required — a verdict must be reproducible');
  const record = input.record || {};
  const policy = input.policy || {};

  const findings = [
    assessRecordKind(record, { biddability: biddabilityFn }),
    assessDeadline(record, asOf),
    assessSamRegistration(input.registration, record, asOf),
    assessPolicyGate('legal_entity_eligibility', policy.legal_entity_eligibility, {
      unknownReason: 'entity type, size standard and representations have not been checked against this solicitation',
      failReason: 'the entity does not meet the stated eligibility',
    }),
    assessPolicyGate('set_aside_eligibility', policy.set_aside_eligibility, {
      unknownReason: 'the set-aside code has not been checked against our certifications',
      failReason: 'the set-aside excludes this entity',
    }),
    assessPolicyGate('naics_psc_applicability', policy.naics_psc_applicability, {
      unknownReason: 'the solicitation NAICS/PSC has not been compared with what we sell',
      failReason: 'the NAICS/PSC is outside what we supply',
    }),
    assessVerifiedCapability(record, input.capabilities),
    assessAccreditation(record, input.accreditations),
    assessPolicyGate('country_of_origin', policy.country_of_origin, {
      unknownReason: 'country-of-origin and sourcing restrictions (TAA, Buy American, Section 889) '
        + 'have not been evaluated against the proposed supply chain',
      failReason: 'the proposed source is excluded by a country-of-origin restriction',
    }),
    assessPolicyGate('delivery_feasibility', policy.delivery_feasibility, {
      unknownReason: 'no supplier lead time has been obtained, so delivery against the required date '
        + 'cannot be assessed',
      failReason: 'the required delivery date cannot be met by any qualified supplier',
    }),
    assessPolicyGate('past_performance', policy.past_performance, {
      unknownReason: 'past-performance references have not been assembled',
      failReason: 'the stated past-performance threshold is not met',
    }),
    assessPolicyGate('insurance_and_risk', policy.insurance_and_risk, {
      unknownReason: 'insurance and contractual risk have not been reviewed',
      failReason: 'the required insurance or risk terms are not acceptable',
    }),
    assessPolicyGate('financial_viability', policy.financial_viability, {
      unknownReason: 'margin and financing exposure have not been modelled',
      failReason: 'the opportunity is not financially viable on current assumptions',
    }),
  ];

  // ── the verdict ──────────────────────────────────────────────────────────
  const mandatory = findings.filter((f) => f.mandatory);
  const failedGates = mandatory.filter((f) => f.result === 'fail');
  const unknownGates = mandatory.filter((f) => f.result === 'unknown');
  const advisory = findings.filter((f) => !f.mandatory);
  const advisoryConcerns = advisory.filter((f) => f.result === 'fail' || f.result === 'unknown');

  let verdict;
  let rationale;
  if (failedGates.length) {
    verdict = 'NOT_QUALIFIED';
    rationale = `${failedGates.length} mandatory gate(s) failed: `
      + failedGates.map((f) => f.criterion_key).join(', ')
      + '. One closed gate is decisive regardless of what else passed.';
  } else if (unknownGates.length) {
    verdict = 'NEEDS_REVIEW';
    rationale = `${unknownGates.length} mandatory gate(s) could not be determined: `
      + unknownGates.map((f) => f.criterion_key).join(', ')
      + '. An unknown gate is never a soft pass — a QUALIFIED verdict built on absences hides them.';
  } else if (advisoryConcerns.length) {
    verdict = 'CONDITIONAL';
    rationale = 'every mandatory gate passed; '
      + `${advisoryConcerns.length} advisory criterion/criteria need attention: `
      + advisoryConcerns.map((f) => `${f.criterion_key} (${f.result})`).join(', ');
  } else {
    verdict = 'QUALIFIED';
    rationale = 'every mandatory gate passed and no advisory criterion raised a concern';
  }

  return {
    verdict,
    rationale,
    rule_set_version: RULE_SET_VERSION,
    as_of: asOf,
    findings,
    // A convenience for the review queue, derived rather than stored, so it cannot disagree with
    // the findings it summarises.
    blocking: [...failedGates, ...unknownGates].map((f) => f.criterion_key),
  };
}

module.exports = {
  RESULTS,
  VERDICTS,
  CRITERIA,
  MANDATORY_KEYS,
  RULE_SET_VERSION,
  assess,
};
