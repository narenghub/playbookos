// ── PR-5: THE FOUR VERDICTS, AND WHY NOTHING IS QUALIFIED TODAY ─────────────
//
//   node --test src/lib/procurement/qualify.test.js
//
// The contract:
//
//     a mandatory gate that FAILS    → NOT_QUALIFIED, whatever else passed
//     a mandatory gate that is UNKNOWN → NEEDS_REVIEW, never a soft pass
//     all gates pass, advisory concerns → CONDITIONAL
//     everything passes              → QUALIFIED
//
// The UNKNOWN rule is the one worth testing hardest, because the convenient default is the opposite
// and the convenient default produces QUALIFIED verdicts built on absences that nothing in the
// output reveals.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { assess, CRITERIA, MANDATORY_KEYS, VERDICTS, RULE_SET_VERSION } = require('./qualify');
const {
  RECORD_KINDS, kindFromSamNoticeType, kindFromGrantsGov, biddability, revenueChannel,
} = require('./record-kind');

const TODAY = '2026-11-05';

// A solicitation with everything a gate could want. Used as the baseline that the tests then break
// one gate at a time, so each verdict is attributable to one cause.
const GOOD_RECORD = {
  recordKind: 'solicitation',
  responseDeadline: '2026-12-10',
  sourceUrl: 'https://sam.gov/opp/EXAMPLE',
  requiredCapabilities: ['cap-api-sourcing'],
  requiredAccreditations: ['acc-iso-17025'],
};
const GOOD_REGISTRATION = { uei: 'GW4MAZJHFV44', cage: '0P2Q9', status: 'Active', expiresOn: '2027-06-30' };
const GOOD_CAPABILITIES = [{ id: 'cap-api-sourcing', reference: 'CAP-001' }];
const GOOD_ACCREDITATIONS = [{ id: 'acc-iso-17025', inScope: true }];
const ALL_PASS_POLICY = {
  legal_entity_eligibility: { satisfied: true },
  set_aside_eligibility: { applicable: false },
  naics_psc_applicability: { satisfied: true },
  country_of_origin: { satisfied: true },
  delivery_feasibility: { satisfied: true },
  past_performance: { satisfied: true },
  insurance_and_risk: { satisfied: true },
  financial_viability: { satisfied: true },
};

const fully = (over = {}) => assess({
  record: GOOD_RECORD,
  registration: GOOD_REGISTRATION,
  capabilities: GOOD_CAPABILITIES,
  accreditations: GOOD_ACCREDITATIONS,
  policy: ALL_PASS_POLICY,
  asOf: TODAY,
  ...over,
});

// ── the shape of the contract ───────────────────────────────────────────────

test('exactly four verdicts exist, and the ruling named all four', () => {
  assert.deepEqual([...VERDICTS].sort(), ['CONDITIONAL', 'NEEDS_REVIEW', 'NOT_QUALIFIED', 'QUALIFIED']);
});

test('the ruling\'s six mandatory gates are all mandatory', () => {
  for (const key of ['legal_entity_eligibility', 'verified_capability', 'accreditation',
    'country_of_origin', 'delivery_feasibility', 'sam_registration']) {
    assert.ok(MANDATORY_KEYS.includes(key), `${key} must be a mandatory gate`);
  }
});

test('every criterion produces a finding, every time', () => {
  const r = fully();
  assert.equal(r.findings.length, CRITERIA.length);
  for (const c of CRITERIA) {
    const f = r.findings.find((x) => x.criterion_key === c.key);
    assert.ok(f, `${c.key} produced no finding`);
    assert.ok(f.reason && f.reason.length > 10, `${c.key} has no usable reason`);
    assert.equal(f.mandatory, c.mandatory);
  }
  // §6: every determination must contain evidence and a reason — for all thirteen, not the
  // interesting ones.
});

test('the verdict carries the rule-set version and the as-of date, so it is reproducible', () => {
  const r = fully();
  assert.equal(r.rule_set_version, RULE_SET_VERSION);
  assert.equal(r.as_of, TODAY);
});

test('an assessment without asOf is refused rather than silently using the clock', () => {
  assert.throws(() => assess({ record: GOOD_RECORD }), /asOf .* is required/);
  // A verdict that depends on the wall clock cannot be recomputed from its stored evidence.
});

// ── the happy path, which requires every registry to exist ──────────────────

test('with every gate satisfied the verdict is QUALIFIED', () => {
  const r = fully();
  assert.equal(r.verdict, 'QUALIFIED', JSON.stringify(r.blocking));
  assert.deepEqual(r.blocking, []);
});

// ── THE CONSEQUENCE: nothing is qualified until a capability registry exists ─

test('with no capability registry supplied, the verdict is NEEDS_REVIEW — not QUALIFIED', () => {
  const r = fully({ capabilities: undefined, accreditations: undefined });
  assert.equal(r.verdict, 'NEEDS_REVIEW');
  assert.ok(r.blocking.includes('verified_capability'));
  assert.ok(r.blocking.includes('accreditation'));
  const f = r.findings.find((x) => x.criterion_key === 'verified_capability');
  assert.match(f.reason, /§8 forbids inventing capabilities/);
  // This is today's real state: there is no verified-capability registry in the codebase, so every
  // live assessment lands here. That is the honest output, not a defect — a version that returned
  // QUALIFIED by assuming capability would invent exactly what §8 forbids, silently.
});

test('an empty required-capability list is UNKNOWN, not "nothing required"', () => {
  const r = fully({ record: { ...GOOD_RECORD, requiredCapabilities: [] } });
  assert.equal(r.verdict, 'NEEDS_REVIEW');
  const f = r.findings.find((x) => x.criterion_key === 'verified_capability');
  assert.match(f.reason, /must not read as "nothing required"/);
});

test('a capability that is required but not held FAILS rather than being unknown', () => {
  const r = fully({ record: { ...GOOD_RECORD, requiredCapabilities: ['cap-sterile-fill'] } });
  assert.equal(r.verdict, 'NOT_QUALIFIED');
  const f = r.findings.find((x) => x.criterion_key === 'verified_capability');
  assert.match(f.reason, /no verified capability row for: cap-sterile-fill/);
});

test('an accreditation held but OUT OF SCOPE fails — scope is not possession', () => {
  const r = fully({ accreditations: [{ id: 'acc-iso-17025', inScope: false }] });
  assert.equal(r.verdict, 'NOT_QUALIFIED');
  assert.match(r.findings.find((x) => x.criterion_key === 'accreditation').reason,
    /OUT OF SCOPE.*named methods, not a field in general/s);
});

// ── the SAM registration gate ───────────────────────────────────────────────

test('a registration expiring BEFORE the deadline is a closed gate, not a note', () => {
  const r = fully({ registration: { ...GOOD_REGISTRATION, expiresOn: '2026-12-01' } });
  assert.equal(r.verdict, 'NOT_QUALIFIED');
  const f = r.findings.find((x) => x.criterion_key === 'sam_registration');
  assert.match(f.reason, /expires 2026-12-01, BEFORE the 2026-12-10 response deadline/);
  // This is how Abiozen's 2026-12-30 expiry becomes visible in the product rather than as a
  // surprise: every solicitation with a 2027 deadline fails this gate until the renewal lands.
});

test("Abiozen's real expiry passes a near deadline and warns, and fails a later one", () => {
  const near = fully({ registration: { ...GOOD_REGISTRATION, expiresOn: '2026-12-30' } });
  assert.equal(near.verdict, 'QUALIFIED');
  assert.match(near.findings.find((x) => x.criterion_key === 'sam_registration').reason,
    /expires 2026-12-30 — 55 day\(s\) away\. Renew now/);

  const later = fully({
    record: { ...GOOD_RECORD, responseDeadline: '2027-02-01' },
    registration: { ...GOOD_REGISTRATION, expiresOn: '2026-12-30' },
  });
  assert.equal(later.verdict, 'NOT_QUALIFIED');
});

test('an expired or non-active registration fails', () => {
  assert.equal(fully({ registration: { ...GOOD_REGISTRATION, expiresOn: '2026-01-01' } }).verdict, 'NOT_QUALIFIED');
  assert.equal(fully({ registration: { ...GOOD_REGISTRATION, status: 'Expired' } }).verdict, 'NOT_QUALIFIED');
});

test('no registration record at all is UNKNOWN, not FAIL', () => {
  const r = fully({ registration: undefined });
  assert.equal(r.verdict, 'NEEDS_REVIEW');
  assert.ok(r.blocking.includes('sam_registration'));
  // "We have no record" and "the registration lapsed" are different statements.
});

test('a registration with no recorded expiry cannot be checked against the deadline', () => {
  const r = fully({ registration: { uei: 'X', status: 'Active' } });
  assert.equal(r.verdict, 'NEEDS_REVIEW');
});

// ── the deadline gate ───────────────────────────────────────────────────────

test('a passed deadline fails', () => {
  const r = fully({ record: { ...GOOD_RECORD, responseDeadline: '2026-10-01' } });
  assert.equal(r.verdict, 'NOT_QUALIFIED');
  assert.match(r.findings.find((x) => x.criterion_key === 'submission_deadline').reason, /in the past/);
});

test('a missing deadline blocks via two gates at once, and goes to REVIEW not NOT_QUALIFIED', () => {
  const r = fully({ record: { ...GOOD_RECORD, responseDeadline: null } });
  // Both gates report UNKNOWN, because a missing deadline is a gap in OUR data rather than a fact
  // about the opportunity: the deadline almost certainly exists on the source and was not captured.
  // NOT_QUALIFIED would archive a real opportunity, so this must be NEEDS_REVIEW.
  assert.equal(r.verdict, 'NEEDS_REVIEW');
  assert.ok(r.blocking.includes('record_kind_biddable'));
  assert.ok(r.blocking.includes('submission_deadline'));
});

test('a category error still FAILS — sources-sought is not a data gap', () => {
  const r = fully({ record: { ...GOOD_RECORD, recordKind: 'sources_sought' } });
  assert.equal(r.verdict, 'NOT_QUALIFIED',
    'a sources-sought notice can never be bid however complete its data, so it can be archived');
});

// ── one closed gate is decisive ─────────────────────────────────────────────

test('a single failed gate produces NOT_QUALIFIED even with everything else passing', () => {
  const r = fully({ policy: { ...ALL_PASS_POLICY, country_of_origin: { satisfied: false } } });
  assert.equal(r.verdict, 'NOT_QUALIFIED');
  assert.deepEqual(r.blocking, ['country_of_origin']);
  assert.match(r.rationale, /One closed gate is decisive/);
});

test('a FAIL outranks an UNKNOWN', () => {
  const r = fully({
    registration: undefined,                                    // unknown gate
    policy: { ...ALL_PASS_POLICY, delivery_feasibility: { satisfied: false } },  // failed gate
  });
  assert.equal(r.verdict, 'NOT_QUALIFIED');
});

test('an UNKNOWN mandatory gate can never produce QUALIFIED or CONDITIONAL', () => {
  for (const key of MANDATORY_KEYS) {
    if (['record_kind_biddable', 'submission_deadline', 'sam_registration',
      'verified_capability', 'accreditation'].includes(key)) continue;   // covered individually
    const r = fully({ policy: { ...ALL_PASS_POLICY, [key]: undefined } });
    assert.equal(r.verdict, 'NEEDS_REVIEW', `${key} unknown should force NEEDS_REVIEW`);
    assert.ok(r.blocking.includes(key));
  }
});

test('the NEEDS_REVIEW rationale says why an unknown is not a soft pass', () => {
  const r = fully({ policy: { ...ALL_PASS_POLICY, naics_psc_applicability: undefined } });
  assert.match(r.rationale, /never a soft pass/);
});

// ── advisory criteria downgrade, they do not block ──────────────────────────

test('an advisory failure yields CONDITIONAL, not NOT_QUALIFIED', () => {
  const r = fully({ policy: { ...ALL_PASS_POLICY, past_performance: { satisfied: false } } });
  assert.equal(r.verdict, 'CONDITIONAL');
  assert.deepEqual(r.blocking, [], 'an advisory concern is not a blocker');
  assert.match(r.rationale, /every mandatory gate passed/);
});

test('an unknown advisory criterion also yields CONDITIONAL', () => {
  const r = fully({ policy: { ...ALL_PASS_POLICY, financial_viability: undefined } });
  assert.equal(r.verdict, 'CONDITIONAL');
});

test('not_applicable is neither a pass to be proud of nor a concern', () => {
  const r = fully({ policy: { ...ALL_PASS_POLICY, past_performance: { applicable: false } } });
  assert.equal(r.verdict, 'QUALIFIED');
});

// ── ruling item 4: six record kinds, one biddable ────────────────────────────

test('exactly one record kind is biddable', () => {
  const biddable = Object.entries(RECORD_KINDS).filter(([, v]) => v.biddable).map(([k]) => k);
  assert.deepEqual(biddable, ['solicitation']);
});

test('a sources-sought notice is NOT biddable, and the reason says what to send instead', () => {
  const b = biddability({ recordKind: 'sources_sought', responseDeadline: '2026-12-01' });
  assert.equal(b.biddable, false);
  assert.match(b.reason, /capability statement \(no price\)/);
  assert.match(b.reason, /There is no award and nothing to win/);
  // A priced bid against market research spends a supplier quote and an approval on an
  // impossibility — the most expensive confusion in the taxonomy.
});

test('assessing a sources-sought notice is NOT_QUALIFIED, not a near miss', () => {
  const r = fully({ record: { ...GOOD_RECORD, recordKind: 'sources_sought' } });
  assert.equal(r.verdict, 'NOT_QUALIFIED');
  assert.ok(r.blocking.includes('record_kind_biddable'));
});

test('forecasts, grants, research leads and historical awards are all non-biddable', () => {
  for (const kind of ['forecast', 'grant_opportunity', 'research_lead', 'historical_award', 'rfi']) {
    const b = biddability({ recordKind: kind, responseDeadline: '2026-12-01' });
    assert.equal(b.biddable, false, `${kind} must not be biddable`);
    assert.ok(b.reason.length > 20, `${kind} needs a usable reason`);
  }
});

test('an unclassified record is never biddable, and is UNKNOWN rather than FAIL', () => {
  const b = biddability({ responseDeadline: '2026-12-01' });
  assert.equal(b.biddable, false);
  assert.match(b.reason, /unclassified record is never biddable/);
  const r = fully({ record: { ...GOOD_RECORD, recordKind: null } });
  assert.equal(r.verdict, 'NEEDS_REVIEW', 'we could not tell, which is not the same as "it is not"');
});

test('a solicitation with no deadline is not biddable', () => {
  assert.equal(biddability({ recordKind: 'solicitation' }).biddable, false);
  assert.match(biddability({ recordKind: 'solicitation' }).reason, /never published or not captured/);
});

test('an unrecognised SAM notice type returns null — it does not default to solicitation', () => {
  assert.equal(kindFromSamNoticeType('Some New Notice Type 2027'), null);
  assert.equal(kindFromSamNoticeType(''), null);
  assert.equal(kindFromSamNoticeType(null), null);
  // Defaulting to solicitation would make every new SAM notice type biddable, which is the failure
  // mode in the expensive direction.
});

test('the SAM notice types that matter map correctly', () => {
  assert.equal(kindFromSamNoticeType('Solicitation'), 'solicitation');
  assert.equal(kindFromSamNoticeType('Combined Synopsis/Solicitation'), 'solicitation');
  assert.equal(kindFromSamNoticeType('Sources Sought'), 'sources_sought');
  assert.equal(kindFromSamNoticeType('Presolicitation'), 'forecast');
  assert.equal(kindFromSamNoticeType('Award Notice'), 'historical_award');
});

test('Grants.gov records classify from the two fields measured live', () => {
  assert.equal(kindFromGrantsGov({ docType: 'synopsis', oppStatus: 'posted' }), 'grant_opportunity');
  assert.equal(kindFromGrantsGov({ docType: 'forecast', oppStatus: 'forecasted' }), 'forecast');
  assert.equal(kindFromGrantsGov({ docType: 'synopsis', oppStatus: 'forecasted' }), 'forecast',
    'either field saying forecast is enough');
  assert.equal(kindFromGrantsGov({}), null);
});

test('a grant never reaches the procurement revenue channel', () => {
  assert.equal(revenueChannel('grant_opportunity'), 'grant');
  assert.equal(revenueChannel('solicitation'), 'procurement');
  assert.equal(revenueChannel('historical_award'), 'none',
    'an obligated amount already awarded to somebody else is not anybody\'s pipeline');
  assert.equal(revenueChannel('sources_sought'), 'none');
  assert.equal(revenueChannel('nonsense'), 'none', 'an unknown kind defaults to no channel');
});

test('a research lead is not a confirmed buyer requirement', () => {
  assert.match(RECORD_KINDS.research_lead.note, /must not be presented as a confirmed buyer requirement/);
  assert.equal(RECORD_KINDS.research_lead.biddable, false);
});

// ── determinism ─────────────────────────────────────────────────────────────

test('the same inputs always produce the same verdict and findings', () => {
  const a = fully();
  const b = fully();
  assert.deepEqual(a, b);
});

test('blocking is derived from the findings and cannot disagree with them', () => {
  const r = fully({ registration: undefined, policy: { ...ALL_PASS_POLICY, country_of_origin: { satisfied: false } } });
  const expected = r.findings
    .filter((f) => f.mandatory && (f.result === 'fail' || f.result === 'unknown'))
    .map((f) => f.criterion_key);
  assert.deepEqual([...r.blocking].sort(), [...expected].sort());
});
