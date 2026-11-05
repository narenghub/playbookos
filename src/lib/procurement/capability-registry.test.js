// ── THE REGISTRY: PLANNED IS NEVER APPROVED ─────────────────────────────────
//
//   node --test src/lib/procurement/capability-registry.test.js
//
// The ruling's second item is the whole design: "Planned or pending certifications must never be
// treated as approved." Four rules decide whether a row is usable, and each is tested on its own
// so a pass is attributable:
//
//   1. STATUS   — only 'verified'
//   2. VALIDITY — against the assessment's as-of date, not row existence
//   3. SCOPE    — an accreditation covers named methods, not a field
//   4. ENTITY   — Abiozen LLC and CRO360 do not share each other's certificates
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  effectiveAsOf, unusableReason, resolveRequirement, coversScope, daysUntilExpiry,
  USABLE_STATUS, RECORDED_BUT_UNUSABLE, SCOPE_KINDS,
} = require('./capability-registry');

const TODAY = '2026-11-05';

const row = (over = {}) => ({
  id: 'acc-iso-17025',
  company_id: 'co',
  kind: 'accreditation',
  code: 'ISO-17025',
  name: 'ISO/IEC 17025',
  responsible_entity: 'Abiozen LLC',
  verification_status: 'verified',
  evidence_source: 'A2LA certificate 1234.01 on file',
  evidence_url: 'https://example.invalid/cert.pdf',
  verified_at: '2026-01-15T00:00:00Z',
  verified_by: 'fixture-verifier@example.invalid',
  approval_id: 'appr-1',
  valid_from: '2026-01-01',
  valid_to: '2027-12-31',
  scope: [{ scope_kind: 'method', scope_value: 'USP <621> HPLC assay' }],
  ...over,
});

// ── 1. status ───────────────────────────────────────────────────────────────

test('only "verified" is usable', () => {
  assert.equal(USABLE_STATUS, 'verified');
  const e = effectiveAsOf([row()], TODAY);
  assert.equal(e.accreditations.length, 1);
  assert.equal(e.excluded.length, 0);
});

test('planned and pending are recorded but unusable, and the reason says why', () => {
  for (const [status, pattern] of [
    ['planned', /PLANNED, not verified.*intended certification is not an approved one/s],
    ['pending', /PENDING verification.*in progress is not approved/s],
  ]) {
    const e = effectiveAsOf([row({ verification_status: status })], TODAY);
    assert.equal(e.accreditations.length, 0, `${status} must not be usable`);
    assert.equal(e.excluded.length, 1);
    assert.match(e.excluded[0].reason, pattern);
  }
  // The ruling's second item, as behaviour. These statuses EXIST so an intended certification can
  // be recorded without becoming usable — leaving them out would push people to file aspirations
  // as verified facts.
});

test('revoked is unusable, and the reason says it was once true', () => {
  const e = effectiveAsOf([row({ verification_status: 'revoked' })], TODAY);
  assert.equal(e.accreditations.length, 0);
  assert.match(e.excluded[0].reason, /REVOKED — it was once true, which is why it is still on file/);
  // The most dangerous status in the set: a reader that only checked for absence would still find
  // the row and could still read it as support for a representation.
});

test('disputed is unusable', () => {
  assert.equal(effectiveAsOf([row({ verification_status: 'disputed' })], TODAY).accreditations.length, 0);
});

test('every non-verified status is excluded, with no exceptions', () => {
  for (const status of RECORDED_BUT_UNUSABLE) {
    const e = effectiveAsOf([row({ verification_status: status })], TODAY);
    assert.equal(e.capabilities.length + e.accreditations.length, 0, `${status} leaked through`);
  }
});

test('an unknown status is unusable rather than treated as verified', () => {
  const e = effectiveAsOf([row({ verification_status: 'approved' })], TODAY);
  assert.equal(e.accreditations.length, 0);
  assert.match(e.excluded[0].reason, /is not "verified"/);
  // "approved" reads like a pass to a human and is not one of the five statuses. A default of
  // usable would make any typo a certification.
});

// ── the backstop against a row the schema should have refused ───────────────

test('a "verified" row with no evidence source is still refused by the reader', () => {
  const e = effectiveAsOf([row({ evidence_source: '  ' })], TODAY);
  assert.equal(e.accreditations.length, 0);
  assert.match(e.excluded[0].reason, /no evidence source, which the schema should have refused/);
  // The schema CHECK makes this unreachable through a normal INSERT. The reader does not rely on a
  // constraint it cannot see: rows can arrive from a fixture, an import or another service.
});

test('a "verified" row with no approval id is refused — nobody authorised it', () => {
  const e = effectiveAsOf([row({ approval_id: null })], TODAY);
  assert.match(e.excluded[0].reason, /no approval id, so no human authorised the verification/);
});

// ── 2. validity ─────────────────────────────────────────────────────────────

test('an expired accreditation is unusable, however true it once was', () => {
  const e = effectiveAsOf([row({ valid_to: '2026-10-01' })], TODAY);
  assert.equal(e.accreditations.length, 0);
  assert.match(e.excluded[0].reason, /EXPIRED on 2026-10-01 \(assessed as of 2026-11-05\)/);
});

test('a window that has not opened yet is unusable', () => {
  const e = effectiveAsOf([row({ valid_from: '2027-01-01' })], TODAY);
  assert.match(e.excluded[0].reason, /not yet in effect — valid from 2027-01-01/);
  // Real case: a certificate issued with a future effective date.
});

test('validity is checked against the as-of date, not against today', () => {
  const r = row({ valid_from: '2026-01-01', valid_to: '2026-06-30' });
  assert.equal(effectiveAsOf([r], '2026-03-01').accreditations.length, 1, 'usable in March');
  assert.equal(effectiveAsOf([r], '2026-11-05').accreditations.length, 0, 'not usable in November');
  // An assessment recomputed later must reach the verdict the evidence supported AT THE TIME.
});

test('the boundary days are inclusive', () => {
  const r = row({ valid_from: '2026-11-05', valid_to: '2026-11-05' });
  assert.equal(effectiveAsOf([r], '2026-11-05').accreditations.length, 1);
  assert.equal(effectiveAsOf([r], '2026-11-06').accreditations.length, 0);
  assert.equal(effectiveAsOf([r], '2026-11-04').accreditations.length, 0);
});

test('an open-ended valid_to never expires, and reports no expiry countdown', () => {
  const e = effectiveAsOf([row({ valid_to: null })], TODAY);
  assert.equal(e.accreditations.length, 1);
  assert.strictEqual(e.accreditations[0].daysUntilExpiry, null);
  assert.strictEqual(daysUntilExpiry(row({ valid_to: null }), TODAY), null);
});

test('the expiry countdown is reported so a near-expiry capability can warn', () => {
  const e = effectiveAsOf([row({ valid_to: '2026-12-30' })], TODAY);
  assert.equal(e.accreditations[0].daysUntilExpiry, 55);
});

test('a non-ISO date is not parsed optimistically', () => {
  for (const d of ['12/30/2026', 'Dec 30 2026', '2026-12-30T00:00:00Z', 'soon']) {
    const e = effectiveAsOf([row({ valid_from: d })], TODAY);
    assert.equal(e.accreditations.length, 0, `valid_from ${d} should be unusable`);
    assert.match(e.excluded[0].reason, /no valid_from/);
  }
});

test('asOf is required', () => {
  assert.throws(() => effectiveAsOf([row()], '11/05/2026'), /asOf .* is required/);
  assert.throws(() => effectiveAsOf([row()]), /asOf .* is required/);
});

// ── 3. scope ────────────────────────────────────────────────────────────────

test('an unscoped requirement is satisfied by holding the capability', () => {
  const e = effectiveAsOf([row()], TODAY);
  const out = resolveRequirement('acc-iso-17025', e);
  assert.equal(out.satisfied, true);
  assert.match(out.reason, /ISO-17025 \(Abiozen LLC\)/);
  assert.match(out.reason, /evidence: A2LA certificate/);
});

test('a scoped requirement needs a matching scope row', () => {
  const e = effectiveAsOf([row()], TODAY);
  const hit = resolveRequirement({ id: 'acc-iso-17025', scope: { kind: 'method', value: 'USP <621> HPLC assay' } }, e);
  assert.equal(hit.satisfied, true);
  assert.match(hit.reason, /scope includes method "USP <621> HPLC assay"/);

  const miss = resolveRequirement({ id: 'acc-iso-17025', scope: { kind: 'method', value: 'ICP-MS elemental impurities' } }, e);
  assert.equal(miss.satisfied, false);
  assert.match(miss.reason, /held but OUT OF SCOPE for method "ICP-MS elemental impurities"/);
  assert.match(miss.reason, /in scope: USP <621> HPLC assay/);
});

test('scope matching ignores case and surrounding whitespace, not content', () => {
  const e = effectiveAsOf([row()], TODAY);
  assert.equal(resolveRequirement({ id: 'acc-iso-17025', scope: { kind: 'method', value: '  usp <621> hplc ASSAY ' } }, e).satisfied, true);
  assert.equal(resolveRequirement({ id: 'acc-iso-17025', scope: { kind: 'method', value: 'usp 621 hplc assay' } }, e).satisfied, false,
    'dropping the angle brackets makes it a different method name, and guessing is not matching');
});

test('a capability with NO scope rows satisfies nothing scoped', () => {
  const e = effectiveAsOf([row({ scope: [] })], TODAY);
  const out = resolveRequirement({ id: 'acc-iso-17025', scope: { kind: 'method', value: 'anything' } }, e);
  assert.equal(out.satisfied, false);
  assert.match(out.reason, /has no recorded scope.*holding it is not a general permission/s);
  // "We hold ISO 17025" is not an answer to "are you accredited for this method". An unscoped row
  // satisfying a scoped requirement would be the general claim §8 forbids.
});

test('a scope kind outside the recorded vocabulary is refused', () => {
  const e = effectiveAsOf([row()], TODAY);
  const out = resolveRequirement({ id: 'acc-iso-17025', scope: { kind: 'vibes', value: 'x' } }, e);
  assert.equal(out.satisfied, false);
  assert.match(out.reason, /not a scope kind this registry records/);
  assert.deepEqual([...SCOPE_KINDS], ['method', 'molecule', 'service', 'naics', 'psc']);
});

test('coversScope is pure and usable on its own', () => {
  const entry = { code: 'X', scope: [{ kind: 'molecule', value: 'Gemcitabine' }] };
  assert.equal(coversScope(entry, { scope: { kind: 'molecule', value: 'gemcitabine' } }).covered, true);
  assert.equal(coversScope(entry, {}).covered, true);
  assert.equal(coversScope(entry, { scope: { kind: 'molecule', value: 'Semaglutide' } }).covered, false);
});

// ── 4. responsible entity ───────────────────────────────────────────────────

test('one entity cannot bid on another entity\'s accreditation', () => {
  const e = effectiveAsOf([row({ responsible_entity: 'CRO360' })], TODAY);
  const out = resolveRequirement({ id: 'acc-iso-17025', entity: 'Abiozen LLC' }, e);
  assert.equal(out.satisfied, false);
  assert.match(out.reason, /held, but by another entity.*cannot rest on another entity's accreditation/s);
});

test('a requirement naming no entity is satisfied by whichever entity holds it', () => {
  const e = effectiveAsOf([row({ responsible_entity: 'CRO360' })], TODAY);
  assert.equal(resolveRequirement('acc-iso-17025', e).satisfied, true);
});

test('two entities may each hold the same code, and each resolves to its own', () => {
  const e = effectiveAsOf([
    row({ id: 'acc-a', responsible_entity: 'Abiozen LLC' }),
    row({ id: 'acc-c', responsible_entity: 'CRO360' }),
  ], TODAY);
  assert.equal(resolveRequirement({ code: 'ISO-17025', entity: 'CRO360' }, e).entry.id, 'acc-c');
  assert.equal(resolveRequirement({ code: 'ISO-17025', entity: 'Abiozen LLC' }, e).entry.id, 'acc-a');
});

// ── "on file but unusable" is the actionable answer ─────────────────────────

test('a pending requirement reports that it IS on file — the actionable distinction', () => {
  const e = effectiveAsOf([row({ verification_status: 'pending' })], TODAY);
  const out = resolveRequirement('acc-iso-17025', e);
  assert.equal(out.satisfied, false);
  assert.equal(out.recordedButUnusable, true);
  assert.match(out.reason, /IS on file but is not usable: recorded as PENDING/);
  // "Pending since March" is something a human can chase. "Missing" is not.
});

test('a requirement we hold nothing for says exactly that', () => {
  const e = effectiveAsOf([row()], TODAY);
  const out = resolveRequirement('cap-sterile-fill', e);
  assert.equal(out.satisfied, false);
  assert.ok(!out.recordedButUnusable);
  assert.match(out.reason, /no verified capability row for cap-sterile-fill/);
});

test('exclusions carry enough to identify the row without re-querying', () => {
  const e = effectiveAsOf([row({ verification_status: 'planned' })], TODAY);
  const x = e.excluded[0];
  assert.equal(x.id, 'acc-iso-17025');
  assert.equal(x.code, 'ISO-17025');
  assert.equal(x.status, 'planned');
  assert.equal(x.responsible_entity, 'Abiozen LLC');
});

// ── capabilities and accreditations are kept apart ─────────────────────────

test('kind decides which bucket a row lands in', () => {
  const e = effectiveAsOf([
    row({ id: 'cap-1', kind: 'capability', code: 'API-SOURCING' }),
    row({ id: 'acc-1', kind: 'accreditation', code: 'ISO-17025' }),
  ], TODAY);
  assert.deepEqual(e.capabilities.map((c) => c.id), ['cap-1']);
  assert.deepEqual(e.accreditations.map((c) => c.id), ['acc-1']);
});

test('unusableReason returns null for a usable row, and a sentence otherwise', () => {
  assert.strictEqual(unusableReason(row(), TODAY), null);
  assert.match(unusableReason(null, TODAY), /no such capability row/);
  assert.ok(unusableReason(row({ verification_status: 'planned' }), TODAY).length > 20);
});
