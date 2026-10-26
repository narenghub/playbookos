// ── ROUTE ON WHAT THEY NEED, NOT ON WHICH LIST THEY LANDED IN ────────────────
//
// Apollo's four segments describe what KIND of organisation someone is. They say nothing about
// what that person needs from us, and the previous campaigns wrote to the segment: 2,946 contacts
// received a message about Abiozen, and none of them replied.
//
// A synthetic chemistry PI with an R35 running to 2031, a clinical operations lead on a Phase II,
// and a process chemist at a generic manufacturer are all "research" to Apollo and want three
// unrelated things from us. So the campaign is chosen by NEED, derived from evidence, and the
// segment is at most one weak signal among several.
//
// ── THE FOUR NEEDS ───────────────────────────────────────────────────────────
//
//   discovery         They are looking for a molecule, or for the structure of one. This is what
//                     the synthesis intelligence platform is for: find it in the known space, or
//                     elucidate the structure. Nothing to ship.
//   clinical_api      They are running a trial and need an API in clinical quantity, to a spec,
//                     on a date. Phase and sponsor are the evidence.
//   custom_synthesis  They know exactly what they want and nobody makes it. Made to order.
//   catalogue_api     They want a known molecule we can already source. The simplest case, and the
//                     only one where a price can be quoted the same day.
//
// ── FAIL CLOSED, FOR THE SAME REASON AS campaignFor() ────────────────────────
//
// cphi-followup.js learned this the hard way: a global role→campaign map queued a SCOPE contact to
// receive "Following up from CPHI Milan", caught one command before it sent. The fix was a map
// that returns null rather than a plausible default.
//
// The same rule governs here, and it bites harder. Every sequence below opens by naming something
// about the recipient's own work — a phase, a grant, a molecule. That opening is the entire reason
// the email is worth reading, and it is also a claim. If we cannot evidence the need, we have
// nothing true to open with, and the honest output is NO EMAIL rather than a generic one with the
// specific sentence removed. A contact with no detected need is not a contact to send a weaker
// letter to; it is a contact we do not yet know anything about.
//
// So needFor() returns { need, evidence, signal } or null, and the evidence string is carried into
// the render and must be a fact we hold — not a guess, not an inference from the segment alone.
'use strict';

const { SIG_NAME, SIG_ROLE, SIG_MAIL, SIG_TEL } = require('./cphi-followup');

const wrap = (bodyHtml) => `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#15202b;max-width:620px">
${bodyHtml}
  <p style="margin:18px 0 0 0;color:#5b6b7c">${SIG_NAME}<br>${SIG_ROLE}<br>${SIG_MAIL} · ${SIG_TEL}</p>
</div>`;
const p = (s) => `  <p style="margin:0 0 13px 0">${s}</p>`;
const sig = `\n${SIG_NAME}\n${SIG_ROLE}\n${SIG_MAIL} · ${SIG_TEL}`;

// ── 1. DISCOVERY ─────────────────────────────────────────────────────────────
// For people whose problem is "which molecule", not "where do I buy this one". The platform is the
// product here and there is nothing to ship, so the ask is a question rather than an order.
const discovery = {
  key: 'discovery',
  label: 'Discovery · synthesis intelligence',
  needsEvidence: true,
  steps: [
    {
      step: 1,
      delayDays: 0,
      subject: ({ topic }) => `${topic} — structure search`,
      text: ({ first, evidence }) => `Hi ${first},

${evidence}

We built a synthesis intelligence layer for exactly that kind of problem. Two things it does: given a structure, it finds what is commercially available that matches or comes close, with who supplies it and at what scale. Given a target you cannot name yet, it searches the known chemical space for candidates that fit the constraints you can state.

It is most useful when the answer is "nobody sells that" — because then it tells you what the nearest accessible analogue is, and what it would take to make the real one.

If you have a structure or a target in mind, send it and I will run it. You get the output whether or not you ever buy a gram from us.
${sig}`,
      html: ({ first, evidence }) => wrap([
        p(`Hi ${first},`),
        p(evidence),
        p('We built a <strong>synthesis intelligence</strong> layer for exactly that kind of problem. Two things it does: given a structure, it finds what is commercially available that matches or comes close, with who supplies it and at what scale. Given a target you cannot name yet, it searches the known chemical space for candidates that fit the constraints you can state.'),
        p('It is most useful when the answer is "nobody sells that" — because then it tells you what the nearest accessible analogue is, and what it would take to make the real one.'),
        p('If you have a structure or a target in mind, send it and I will run it. You get the output whether or not you ever buy a gram from us.'),
      ].join('\n')),
    },
    {
      step: 2,
      delayDays: 5,
      subject: null,
      text: ({ first }) => `Hi ${first},

One follow-up and then I will leave it.

The offer is unconditional: send a structure or a target and you get the search back. No call, no form, no obligation. We are trying to learn what synthesis groups actually hit walls on, and running searches is how we find out.
${sig}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('One follow-up and then I will leave it.'),
        p('The offer is unconditional: send a structure or a target and you get the search back. No call, no form, no obligation. We are trying to learn what synthesis groups actually hit walls on, and running searches is how we find out.'),
      ].join('\n')),
    },
  ],
};

// ── 2. CLINICAL API ──────────────────────────────────────────────────────────
// A trial sponsor needs material to a spec, on a date, with documentation. Timing is the whole
// pitch; price is secondary to a slipped milestone.
const clinicalApi = {
  key: 'clinical_api',
  label: 'Clinical · API supply',
  needsEvidence: true,
  steps: [
    {
      step: 1,
      delayDays: 0,
      subject: ({ topic }) => `API supply for ${topic}`,
      text: ({ first, evidence }) => `Hi ${first},

${evidence}

We supply APIs and intermediates for clinical programmes — the quantities a trial needs rather than commercial scale, with CoA, and DMF-backed where the filing requires it.

The part worth knowing: we will tell you in 48 hours whether we can hit your date, including when the answer is no. A supplier who says yes and then slips is more expensive to a clinical programme than one who declines in week one, and most of the pain we hear about comes from exactly that.

If you have material on the critical path right now, send me the molecule, the grade and the date you need it. I will come back with a real answer.
${sig}`,
      html: ({ first, evidence }) => wrap([
        p(`Hi ${first},`),
        p(evidence),
        p('We supply APIs and intermediates for clinical programmes — the quantities a trial needs rather than commercial scale, with CoA, and DMF-backed where the filing requires it.'),
        p('The part worth knowing: <strong>we will tell you in 48 hours whether we can hit your date, including when the answer is no.</strong> A supplier who says yes and then slips is more expensive to a clinical programme than one who declines in week one, and most of the pain we hear about comes from exactly that.'),
        p('If you have material on the critical path right now, send me the molecule, the grade and the date you need it. I will come back with a real answer.'),
      ].join('\n')),
    },
    {
      step: 2,
      delayDays: 5,
      subject: null,
      text: ({ first }) => `Hi ${first},

Following up once.

If supply is covered for this programme, the useful thing for us would be knowing who handles API sourcing on your side so I am not writing to the wrong desk. One line is plenty and I will not chase it further.
${sig}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('Following up once.'),
        p('If supply is covered for this programme, the useful thing for us would be knowing who handles API sourcing on your side so I am not writing to the wrong desk. One line is plenty and I will not chase it further.'),
      ].join('\n')),
    },
  ],
};

// ── 3. CUSTOM SYNTHESIS ──────────────────────────────────────────────────────
// They know the compound and nobody stocks it. The only honest pitch is scope, timeline and the
// willingness to decline — a custom synthesis quote that is wrong costs both sides months.
const customSynthesis = {
  key: 'custom_synthesis',
  label: 'Custom synthesis',
  needsEvidence: true,
  steps: [
    {
      step: 1,
      delayDays: 0,
      subject: ({ topic }) => `${topic} — made to order`,
      text: ({ first, evidence }) => `Hi ${first},

${evidence}

When a compound is not commercially available we make it to order. Milligrams to kilograms, with the route, the analytical package and the timeline agreed before anything starts.

Two things that may matter more than the capability itself. We scope before we quote, so you get a route and a realistic timeline rather than a number that moves later. And we decline work we cannot do well — if a target needs chemistry we are weak in, saying so in week one is worth more to you than a contract.

If you have something on the list that nobody will supply, send me the structure or the name. I will tell you whether it is a job for us.
${sig}`,
      html: ({ first, evidence }) => wrap([
        p(`Hi ${first},`),
        p(evidence),
        p('When a compound is not commercially available we make it to order. Milligrams to kilograms, with the route, the analytical package and the timeline agreed before anything starts.'),
        p('Two things that may matter more than the capability itself. <strong>We scope before we quote</strong>, so you get a route and a realistic timeline rather than a number that moves later. And <strong>we decline work we cannot do well</strong> — if a target needs chemistry we are weak in, saying so in week one is worth more to you than a contract.'),
        p('If you have something on the list that nobody will supply, send me the structure or the name. I will tell you whether it is a job for us.'),
      ].join('\n')),
    },
    {
      step: 2,
      delayDays: 6,
      subject: null,
      text: ({ first }) => `Hi ${first},

Last note on this.

If nothing is blocked right now, keep the thread — reply to it whenever a target comes up that nobody will quote, and it reaches me directly rather than a form.
${sig}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('Last note on this.'),
        p('If nothing is blocked right now, keep the thread — reply to it whenever a target comes up that nobody will quote, and it reaches me directly rather than a form.'),
      ].join('\n')),
    },
  ],
};

// ── 4. CATALOGUE API ─────────────────────────────────────────────────────────
// The easy case, and the one we have historically fumbled: a named molecule we can actually
// source. The only thing worth promising is speed, because that is the thing we failed at.
const catalogueApi = {
  key: 'catalogue_api',
  label: 'Catalogue · API supply',
  needsEvidence: true,
  steps: [
    {
      step: 1,
      delayDays: 0,
      subject: ({ topic }) => `${topic} — price and lead time`,
      text: ({ first, evidence }) => `Hi ${first},

${evidence}

We can source it. Rather than describe our capabilities, here is the specific offer: tell me the quantity and grade and you get a price and a lead time within 48 hours, from a supplier I will name.

No minimum that makes a small order awkward, and a straight no where we are not competitive.
${sig}`,
      html: ({ first, evidence }) => wrap([
        p(`Hi ${first},`),
        p(evidence),
        p('We can source it. Rather than describe our capabilities, here is the specific offer: <strong>tell me the quantity and grade and you get a price and a lead time within 48 hours</strong>, from a supplier I will name.'),
        p('No minimum that makes a small order awkward, and a straight no where we are not competitive.'),
      ].join('\n')),
    },
    {
      step: 2,
      delayDays: 4,
      subject: null,
      text: ({ first }) => `Hi ${first},

Following up once, then I will stop.

The 48-hour quote stands for anything else on your list too, not only the molecule above.
${sig}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('Following up once, then I will stop.'),
        p('The 48-hour quote stands for anything else on your list too, not only the molecule above.'),
      ].join('\n')),
    },
  ],
};

const NEED_CAMPAIGNS = Object.freeze({
  discovery,
  clinical_api: clinicalApi,
  custom_synthesis: customSynthesis,
  catalogue_api: catalogueApi,
});

// ── DETECTION ────────────────────────────────────────────────────────────────
//
// Ordered, and the order is the priority. A contact can satisfy more than one rule — a PI on a
// Phase II trial is both a researcher and a sponsor — and the first match wins, so the strongest,
// most specific evidence is checked first.
//
// Every rule must produce an `evidence` sentence built from facts we hold about THAT contact. A
// rule that cannot write one does not fire, because the sentence is the opening line of the email
// and it has to be true.

const PHASE = /phase\s*(1|2|3|i{1,3})\b/i;

/**
 * Decide what a contact needs, from evidence.
 *
 * @param {object} s signals
 * @param {string} [s.trialPhase]       e.g. "Phase 2" — from clinical_studies.phase
 * @param {string} [s.trialTitle]       the study's brief title
 * @param {string} [s.moleculeNamed]    a molecule this contact has named or published on
 * @param {boolean} [s.inCatalogue]     is that molecule in supplier_products?
 * @param {string} [s.deptType]         NIH organization.dept_type, e.g. "CHEMISTRY"
 * @param {string} [s.researchTopic]    short phrase from their own abstract or grant title
 * @param {string} [s.grantNumber]      e.g. "R35GM134809"
 * @param {string} [s.grantEndsOn]      ISO date the award runs to
 * @returns {{need: string, evidence: string, topic: string, signal: string}|null}
 */
function needFor(s = {}) {
  const molecule = String(s.moleculeNamed || '').trim();
  const topicText = String(s.researchTopic || '').trim();

  // 1. A trial on the books is the strongest signal there is: a phase, a date and a budget.
  if (s.trialPhase && PHASE.test(String(s.trialPhase))) {
    const what = String(s.trialTitle || '').trim();
    if (!what) return null;              // no true sentence to open with
    return {
      need: 'clinical_api',
      topic: String(s.trialPhase).trim(),
      signal: 'trial_phase',
      evidence: `I saw you are running ${String(s.trialPhase).trim()} on ${what}.`,
    };
  }

  // 2. A named molecule splits cleanly on whether anyone can already supply it.
  if (molecule) {
    if (s.inCatalogue === true) {
      return {
        need: 'catalogue_api',
        topic: molecule,
        signal: 'molecule_in_catalogue',
        evidence: `You asked about ${molecule}.`,
      };
    }
    if (s.inCatalogue === false) {
      return {
        need: 'custom_synthesis',
        topic: molecule,
        signal: 'molecule_not_in_catalogue',
        evidence: `You were looking for ${molecule}, which is not something the catalogue houses carry.`,
      };
    }
    // inCatalogue undefined: we genuinely do not know, and guessing picks the wrong email.
    return null;
  }

  // 3. A funded synthesis programme. Chemistry departments build molecules; the platform is the
  //    thing they have no equivalent of. Needs the topic AND the grant, so the opening is checkable.
  const dept = String(s.deptType || '').toUpperCase();
  if (dept.startsWith('CHEMISTRY') || dept.startsWith('BIOCHEMISTR')) {
    if (!topicText || !s.grantNumber) return null;
    const ends = s.grantEndsOn ? ` (running to ${String(s.grantEndsOn).slice(0, 7)})` : '';
    return {
      need: 'discovery',
      topic: topicText,
      signal: 'funded_chemistry_lab',
      evidence: `I came across your work on ${topicText} through ${s.grantNumber}${ends}.`,
    };
  }

  // Everything else: no evidence, no email. Apollo's segment alone never routes a contact — it
  // describes the company, not the need, and that is the mistake this module exists to stop.
  return null;
}

/** Render one step. Throws rather than emitting a placeholder or an empty opening line. */
function renderNeed(needKey, stepNumber, vars) {
  const c = NEED_CAMPAIGNS[needKey];
  if (!c) throw new Error(`unknown need campaign "${needKey}"`);
  const s = c.steps.find((x) => x.step === stepNumber);
  if (!s) throw new Error(`need campaign "${needKey}" has no step ${stepNumber}`);
  if (!vars || !vars.first || !String(vars.first).trim()) {
    throw new Error('a first name is required to render a greeting');
  }
  // Step 1 opens with the evidence sentence. An empty one would send a letter whose first line is
  // blank and whose premise is missing — the generic email this module exists to prevent.
  if (c.needsEvidence && stepNumber === 1 && !String(vars.evidence || '').trim()) {
    throw new Error(`need campaign "${needKey}" step 1 requires evidence — route produced none`);
  }
  const subject = typeof s.subject === 'function' ? s.subject(vars) : s.subject;
  if (subject !== null && /\{\{|\bundefined\b/.test(String(subject))) {
    throw new Error(`subject for "${needKey}" did not interpolate: ${subject}`);
  }
  return {
    subject,
    text: s.text(vars),
    html: s.html(vars),
    attach: false,
    isFollowUp: s.subject === null,
  };
}

const needStepsOf = (k) => (NEED_CAMPAIGNS[k] ? NEED_CAMPAIGNS[k].steps.map((x) => x.step) : []);

module.exports = { NEED_CAMPAIGNS, needFor, renderNeed, needStepsOf };
