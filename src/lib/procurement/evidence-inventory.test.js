'use strict';
// Tests for the evidence inventory. The fixtures are shaped like the REAL columns in this schema
// (labs.research_capable, labs.accreditations, fda_establishments.operations, companies.slug),
// because the defect this module exists to prevent is specifically a default-FALSE boolean being
// read as a capability.

const assert = require('assert');
const {
  STATUS, DIMENSIONS, classify, candidateFrom, inventory, unknown, withinValidity,
} = require('./evidence-inventory');

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; } catch (e) {
    fail += 1;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}
const ASOF = '2026-11-05';
const ENTITY = { name: 'Abiozen Scientific', companyId: 'co_abiozen_sci' };

// ── the core rule: a flag is not a capability ──────────────────────────────

t('a boolean with no evidence is CLAIM_WITHOUT_EVIDENCE, not a capability', () => {
  // This is labs.research_capable: BOOLEAN NOT NULL DEFAULT FALSE, no evidence column behind it.
  const f = classify({
    dimension: 'technical_capability',
    value: 'research_capable = true',
    source: { table: 'labs', column: 'research_capable', id: 42 },
    external: false,
    selfReported: false,
  }, ASOF);
  assert.strictEqual(f.status, STATUS.CLAIM_WITHOUT_EVIDENCE);
  assert.strictEqual(f.usableForEligibility, false);
});

t('NEGATIVE CONTROL: a flag does not become usable just by naming a source table', () => {
  // The tempting shortcut: "it came from a table, so it is evidence." A table is not an attestor.
  const f = classify({
    dimension: 'technical_capability',
    value: 'gmp_capable = true',
    source: { table: 'labs', column: 'gmp_capable', id: 42 },
    selfReported: true,          // claimed, but...
    // ...no evidenceRef: no certificate, no scope document, nothing checkable.
  }, ASOF);
  assert.strictEqual(f.status, STATUS.CLAIM_WITHOUT_EVIDENCE);
  assert.ok(/no certificate, scope document or external identifier/.test(f.reason));
});

t('an accreditation entry WITH a certificate number is attested', () => {
  // labs.accreditations JSONB: [{ body, certificate, scope_url, expires_on }]
  const f = classify({
    dimension: 'accreditation',
    value: 'A2LA ISO/IEC 17025',
    source: { table: 'labs', column: 'accreditations', id: 42 },
    external: true,
    evidenceRef: '1234.01',
    scope: ['assay_hplc'],
    validTo: '2027-03-01',
  }, ASOF);
  assert.strictEqual(f.status, STATUS.ATTESTED_EXTERNAL);
  assert.strictEqual(f.usableForEligibility, true);
});

t('an expired accreditation is EXPIRED and unusable, not simply absent', () => {
  const f = classify({
    dimension: 'accreditation',
    value: 'A2LA ISO/IEC 17025',
    source: { table: 'labs', column: 'accreditations', id: 42 },
    external: true,
    evidenceRef: '1234.01',
    validTo: '2026-03-01',
  }, ASOF);
  assert.strictEqual(f.status, STATUS.EXPIRED);
  assert.strictEqual(f.usableForEligibility, false);
  assert.ok(/does not cover 2026-11-05/.test(f.reason));
});

t('an accreditation not yet in force is EXPIRED-side unusable, not treated as current', () => {
  // A planned certification must never be treated as approved — ruling 5 item 2, verbatim.
  const f = classify({
    dimension: 'accreditation',
    value: 'ISO 17025 (planned)',
    source: { table: 'labs', column: 'accreditations', id: 42 },
    external: true,
    evidenceRef: 'pending-app-9',
    validFrom: '2027-01-01',
  }, ASOF);
  assert.strictEqual(f.usableForEligibility, false);
});

t('an FDA establishment row is ATTESTED_EXTERNAL registration evidence', () => {
  const f = classify({
    dimension: 'registration',
    value: 'ANALYSIS; API MANUFACTURE',
    source: { table: 'fda_establishments', column: 'operations', id: 901 },
    external: true,
    evidenceRef: 'FEI 3001234567',
  }, ASOF);
  assert.strictEqual(f.status, STATUS.ATTESTED_EXTERNAL);
});

t('a self-onboarded claim with a certificate is ATTESTED_SELF, ranked below external', () => {
  const f = classify({
    dimension: 'accreditation',
    value: 'ISO 9001',
    source: { table: 'labs', column: 'accreditations', id: 42 },
    selfReported: true,
    evidenceRef: 'CERT-55',
    validTo: '2028-01-01',
  }, ASOF);
  assert.strictEqual(f.status, STATUS.ATTESTED_SELF);
  assert.strictEqual(f.usableForEligibility, true);
  assert.ok(/still requires verification/.test(f.reason));
});

// ── absence ────────────────────────────────────────────────────────────────

t('a dimension no table can hold reports UNKNOWN and says it is a schema gap', () => {
  const f = unknown('equipment');
  assert.strictEqual(f.status, STATUS.UNKNOWN);
  assert.strictEqual(f.value, 'UNKNOWN');
  assert.strictEqual(f.structurallyAbsent, true);
  assert.ok(/schema gap, not an empty search/.test(f.reason));
});

t('a dimension a table COULD hold reports UNKNOWN as an empty search', () => {
  const f = unknown('registration');
  assert.strictEqual(f.structurallyAbsent, false);
  assert.ok(/no matching record found/.test(f.reason));
});

t('NEGATIVE CONTROL: absence is never expressed as false, 0 or "none"', () => {
  for (const d of DIMENSIONS) {
    const f = unknown(d.key);
    assert.strictEqual(f.value, 'UNKNOWN', `${d.key} must be UNKNOWN`);
    assert.notStrictEqual(f.value, 0);
    assert.notStrictEqual(f.value, false);
  }
});

t('withinValidity refuses to answer without a date', () => {
  assert.throws(() => withinValidity('2020-01-01', '2030-01-01', null), /requires asOf/);
});

t('classify refuses to answer without a date', () => {
  assert.throws(() => classify({ dimension: 'registration', value: 'x' }), /requires asOf/);
});

t('classify refuses an unknown dimension rather than inventing one', () => {
  assert.throws(() => classify({ dimension: 'vibes', value: 'x' }, ASOF), /unknown dimension/);
});

// ── candidates: nothing here is ever verified ──────────────────────────────

t('a candidate is always pending, with verifier fields left for a person', () => {
  const f = classify({
    dimension: 'accreditation',
    value: 'A2LA ISO/IEC 17025',
    source: { table: 'labs', column: 'accreditations', id: 42 },
    external: true,
    evidenceRef: '1234.01',
    validTo: '2027-03-01',
  }, ASOF);
  const c = candidateFrom(f, ENTITY);
  assert.strictEqual(c.verification_status, 'pending');
  assert.strictEqual(c.verified_at, null);
  assert.strictEqual(c.verified_by, null);
  assert.strictEqual(c.approval_id, null);
  assert.strictEqual(c.responsible_entity, 'Abiozen Scientific');
  assert.ok(/CANDIDATE ONLY/.test(c.note));
});

t('NEGATIVE CONTROL: a claim without evidence does NOT become a candidate capability', () => {
  const f = classify({
    dimension: 'technical_capability',
    value: 'research_capable = true',
    source: { table: 'labs', column: 'research_capable', id: 42 },
  }, ASOF);
  assert.strictEqual(candidateFrom(f, ENTITY), null,
    'a bare flag must enter the queue as a gap to investigate, never as a capability candidate');
});

t('NEGATIVE CONTROL: an expired accreditation does NOT become a candidate', () => {
  const f = classify({
    dimension: 'accreditation',
    value: 'A2LA',
    source: { table: 'labs', column: 'accreditations', id: 42 },
    external: true,
    evidenceRef: '1234.01',
    validTo: '2020-01-01',
  }, ASOF);
  assert.strictEqual(candidateFrom(f, ENTITY), null);
});

t('candidateFrom refuses without a responsible entity', () => {
  const f = classify({
    dimension: 'registration',
    value: 'x',
    source: { table: 'fda_establishments' },
    external: true,
    evidenceRef: 'FEI 1',
  }, ASOF);
  assert.throws(() => candidateFrom(f, null), /responsible entity/);
});

t('no candidate can ever carry verification_status "verified"', () => {
  // The schema CHECK would refuse it, but refusing here too means the attempt never reaches the
  // database to be refused — Rule 7, applied to the inventory.
  const statuses = new Set();
  for (const ext of [true, false]) {
    const f = classify({
      dimension: 'accreditation',
      value: 'v',
      source: { table: 'labs', column: 'accreditations', id: 1 },
      external: ext,
      selfReported: !ext,
      evidenceRef: 'ref',
      validTo: '2030-01-01',
    }, ASOF);
    statuses.add(candidateFrom(f, ENTITY).verification_status);
  }
  assert.deepStrictEqual([...statuses], ['pending']);
});

// ── the whole inventory ────────────────────────────────────────────────────

t('every dimension appears in the inventory, UNKNOWN included', () => {
  const inv = inventory(ENTITY, [], ASOF);
  for (const d of DIMENSIONS) {
    assert.ok(inv.byDimension[d.key], `${d.key} missing from the inventory`);
    assert.strictEqual(inv.byDimension[d.key][0].status, STATUS.UNKNOWN);
  }
  assert.strictEqual(inv.summary.unknownDimensions, DIMENSIONS.length);
  assert.strictEqual(inv.summary.withEvidence, 0);
});

t('an empty inventory reports verified: 0 explicitly rather than omitting it', () => {
  const inv = inventory(ENTITY, [], ASOF);
  assert.strictEqual(inv.summary.verified, 0);
  assert.ok('verified' in inv.summary);
});

t('a mixed inventory separates evidence from gaps', () => {
  const inv = inventory(ENTITY, [
    {
      dimension: 'registration',
      value: 'ANALYSIS',
      source: { table: 'fda_establishments', column: 'operations', id: 9 },
      external: true,
      evidenceRef: 'FEI 3001234567',
    },
    {
      dimension: 'technical_capability',
      value: 'gmp_capable = true',
      source: { table: 'labs', column: 'gmp_capable', id: 42 },
    },
  ], ASOF);
  assert.strictEqual(inv.summary.withEvidence, 1, 'only the FDA row is evidence');
  assert.strictEqual(inv.summary.candidatesForVerification, 1);
  assert.strictEqual(inv.summary.verified, 0);
  assert.ok(inv.gaps.some((g) => g.dimension === 'technical_capability'),
    'the bare flag must be listed as a gap');
});

t('inventory refuses without an entity or a date', () => {
  assert.throws(() => inventory(null, [], ASOF), /entity name/);
  assert.throws(() => inventory(ENTITY, []), /requires asOf/);
});

t('the four structurally-absent dimensions are counted and named', () => {
  const absent = DIMENSIONS.filter((d) => d.structurallyAbsent).map((d) => d.key).sort();
  assert.deepStrictEqual(absent,
    ['authorization', 'certification', 'equipment', 'quality_system'],
    'these four have no table in this schema; if one gains a table, update both the list and this test');
});

console.log(`\nevidence-inventory: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
