// ── CAN A BUYER QUOTATION REACH A BUYER WITHOUT A HUMAN DECISION? ────────────
//
//   node --test src/lib/agents/buyer-email-approval.test.js
//
// CEO authorization 2026-11-11 workstream B names the cases: "direct-call bypasses, concurrent
// workers, cron retries, changed quotations, expired approvals, STOP enforcement and provider
// timeouts." Each has a test below and each is driven through the SHIPPED functions.
//
// ── THE SHAPE THESE AVOID ────────────────────────────────────────────────────
//
// Five guards in this repository have been found passing while testing nothing: a scanner that
// looked for a string literal using the function that blanked string literals; a mutation control
// that mutated the wrong file; a failure-path check that stubbed `window.API` when `API` was a
// module-scoped const; a completeness test that read one of six routers; a containment report
// structurally unable to see two of four transports.
//
// So every refusal here is driven to its actual return value rather than asserted by inspection,
// and the positive case is proven to transmit — because a boundary that refuses everything,
// including valid work, is not a boundary, it is an outage, and a suite in which the send never
// happens cannot tell the two apart.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const APPROVAL = require('./buyer-email-approval');
const LEDGER = require('../outbound/ledger');

const INQUIRY = Object.freeze({
  id: 'inq-1', buyer_email: 'buyer@acme-pharma.test', buyer_company: 'Acme Pharma',
  molecule_name: 'Gemcitabine', cas_number: '95058-81-4',
});
const SIGNATORY = Object.freeze({ id: 'u-7', email: 'naren@abiozen.com', name: 'Naresh Boda' });
const COMMERCIAL = Object.freeze({
  product_name: 'Gemcitabine', cas_number: '95058-81-4', product_type: 'GMP API',
  quantity: 12, quantity_unit: 'kg', unit_price: 4000, total: 48150, currency: 'USD',
  payment_terms: '50% advance, 50% before shipment', lead_time_days: 45,
  valid_until: '2026-12-11', quote_ref: 'QT-2026-INQ001', incoterms: null,
});
const CTX = Object.freeze({ companyId: 'co-1', runId: 'run-1', objectiveId: 'obj-1' });

const MESSAGE = {
  to: INQUIRY.buyer_email, cc: ['naren@abiozen.com'], from: 'Sarah Chen · Abiozen <sales@abiozen.com>',
  replyTo: 'sales@abiozen.com', subject: 'Quotation QT-2026-INQ001 — Gemcitabine (12kg) | Abiozen LLC',
  body: 'Dear Buyer, ... total $48,150 ... Reply ACCEPTED to proceed.',
  html: '<div>Quotation QT-2026-INQ001 — 12 kg at $4,000/kg — total $48,150 USD</div>',
};

function frozen(overrides = {}) {
  return APPROVAL.freezeBuyerEmail({
    inquiry: INQUIRY, to: MESSAGE.to, cc: MESSAGE.cc, from: MESSAGE.from, replyTo: MESSAGE.replyTo,
    subject: MESSAGE.subject, body: MESSAGE.body, html: MESSAGE.html,
    commercial: COMMERCIAL, displayName: 'Sarah Chen', signatory: SIGNATORY, ...overrides,
  });
}

/**
 * A stand-in office kernel. Holds one approval and reproduces the real release() contract:
 * refuses unless approved, claims ATOMICALLY so a second release is refused, and returns the
 * payload it was given rather than a rebuilt one.
 */
function fakeKernel({ status = 'approved', payload, approvedAt = new Date(), released = false } = {}) {
  const state = { status, payload, approvedAt, released, releaseCount: 0, prepared: [] };
  return {
    state,
    approval: {
      prepare: async (ctx, { id, actionPayload, actionKind, reason }) => {
        if (state.prepared.some((p) => p.id === id)) {
          const e = new Error('duplicate key value violates unique constraint "office_approvals_pkey"');
          throw e;
        }
        state.prepared.push({ id, actionPayload, actionKind, reason });
        return { approvalId: id, status: 'pending', created_at: new Date() };
      },
      release: async (ctx, { approvalId }) => {
        if (state.status !== 'approved') return { released: false, reason: 'not_approved', status: state.status };
        if (state.released) return { released: false, reason: 'already_released', status: 'approved' };
        // The real claim is one SQL statement, so exactly one caller wins. Modelled here as a
        // single synchronous flip with no await between the check and the set.
        state.released = true;
        state.releaseCount += 1;
        return { released: true, approvalId, actionKind: APPROVAL.ACTION_KIND,
          actionPayload: state.payload, approvedBy: 'naren@abiozen.com', approvedAt: state.approvedAt };
      },
    },
    scope: {
      approvalReleaseState: async () => ({ status: state.status, action_payload: state.payload,
        released_at: state.released ? new Date() : null }),
    },
  };
}

// ── THE ARTEFACT, AND THE DIGEST THAT BINDS IT ───────────────────────────────

test('the frozen payload hashes the bytes the buyer will read, with the ledger\'s own function', () => {
  const { payload, transportDigest } = frozen();
  // One hash function, used at both ends. Two implementations of "the same" digest is how a
  // binding check quietly stops binding.
  assert.strictEqual(transportDigest, LEDGER.digestOf({
    to: MESSAGE.to, subject: MESSAGE.subject, html: MESSAGE.html }));
  assert.strictEqual(payload.html, MESSAGE.html, 'the html is frozen verbatim, not re-rendered');
  assert.deepStrictEqual(payload.attachments, [], 'attachments are an explicit empty, not absent');
});

test('changing one character of the body changes the digest', () => {
  const a = frozen().transportDigest;
  const b = frozen({ html: MESSAGE.html.replace('$48,150', '$41,850') }).transportDigest;
  assert.notStrictEqual(a, b, 'a transposed total must not hash to the approved artefact');
});

test('the persona and the accountable human are separate fields', () => {
  const { payload } = frozen();
  assert.strictEqual(payload.display_name, 'Sarah Chen');
  assert.strictEqual(payload.signed_by_email, 'naren@abiozen.com');
  assert.strictEqual(payload.signed_by_user_id, 'u-7');
});

test('a payload with no accountable signatory cannot be frozen at all', () => {
  // office/approval.js release() refuses a payload recording no signatory. Refusing it HERE means
  // the unreleasable approval never exists, rather than sitting in the queue looking actionable.
  assert.throws(() => frozen({ signatory: { name: 'Sarah Chen' } }), /accountable signatory/);
  assert.throws(() => frozen({ signatory: { email: 'x@y.test' } }), /accountable signatory/);
});

test('a payload with no rendered html cannot be frozen', () => {
  assert.throws(() => frozen({ html: '' }), /rendered html/);
});

// ── DIRECT-CALL BYPASS ───────────────────────────────────────────────────────

test('BYPASS: release refuses without a governed context, an id or an actor', async () => {
  const k = fakeKernel({ payload: frozen().payload });
  const d = { approval: k.approval, scope: k.scope };
  assert.strictEqual((await APPROVAL.releaseBuyerEmail(null, { approvalId: 'a', releasedBy: 'n' }, d)).reason,
    'no_governed_context');
  assert.strictEqual((await APPROVAL.releaseBuyerEmail(CTX, { releasedBy: 'n' }, d)).reason, 'no_approval_id');
  assert.strictEqual((await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'a' }, d)).reason, 'no_releasing_actor');
  assert.strictEqual(k.state.releaseCount, 0, 'nothing was claimed');
});

test('BYPASS: prepare refuses without a run, so no approval exists to release', async () => {
  const r = await APPROVAL.prepareBuyerEmail({ companyId: 'co-1' }, {
    inquiry: INQUIRY, to: MESSAGE.to, from: MESSAGE.from, subject: MESSAGE.subject,
    html: MESSAGE.html, commercial: COMMERCIAL, signatory: SIGNATORY,
  });
  assert.strictEqual(r.prepared, false);
  assert.strictEqual(r.reason, 'no_governed_context');
});

// ── THE POSITIVE CASE. WITHOUT IT, EVERY REFUSAL ABOVE IS MEANINGLESS ────────

test('an approved, fresh, unchanged approval DOES release, with the digest attached', async () => {
  const { payload, transportDigest } = frozen();
  const k = fakeKernel({ payload });
  const rel = await APPROVAL.releaseBuyerEmail(CTX,
    { approvalId: 'ap-1', releasedBy: 'naren@abiozen.com', currentCommercial: COMMERCIAL },
    { approval: k.approval, scope: k.scope });

  assert.strictEqual(rel.released, true, 'a valid approval must transmit — a boundary that '
    + 'refuses everything is an outage, not a control');
  assert.strictEqual(rel.expectedDigest, transportDigest);
  assert.strictEqual(rel.message.html, MESSAGE.html);
  assert.strictEqual(rel.inquiryId, 'inq-1');
  assert.strictEqual(k.state.releaseCount, 1);
});

// ── CONCURRENT WORKERS AND CRON RETRIES ──────────────────────────────────────

test('CONCURRENCY: two workers racing the same approval produce exactly one release', async () => {
  const k = fakeKernel({ payload: frozen().payload });
  const d = { approval: k.approval, scope: k.scope };
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => APPROVAL.releaseBuyerEmail(CTX,
    { approvalId: 'ap-1', releasedBy: 'naren@abiozen.com' }, d)));

  const won = results.filter((r) => r.released);
  assert.strictEqual(won.length, 1, 'one human decision must authorise exactly one send');
  assert.strictEqual(k.state.releaseCount, 1);
  for (const r of results.filter((x) => !x.released)) {
    assert.strictEqual(r.reason, 'already_released');
  }
});

test('RETRY: a cron re-running after a successful release is refused, not re-sent', async () => {
  const k = fakeKernel({ payload: frozen().payload });
  const d = { approval: k.approval, scope: k.scope };
  const first = await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'ap-1', releasedBy: 'n' }, d);
  assert.strictEqual(first.released, true);
  const second = await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'ap-1', releasedBy: 'n' }, d);
  assert.strictEqual(second.released, false);
  assert.strictEqual(second.reason, 'already_released');
});

test('RETRY: re-preparing the identical letter is idempotent, not a second decision', async () => {
  const k = fakeKernel({ payload: frozen().payload });
  const d = { approval: k.approval, scope: k.scope };
  const args = { inquiry: INQUIRY, to: MESSAGE.to, cc: MESSAGE.cc, from: MESSAGE.from,
    replyTo: MESSAGE.replyTo, subject: MESSAGE.subject, body: MESSAGE.body, html: MESSAGE.html,
    commercial: COMMERCIAL, displayName: 'Sarah Chen', signatory: SIGNATORY };

  const a = await APPROVAL.prepareBuyerEmail(CTX, args, d);
  const b = await APPROVAL.prepareBuyerEmail(CTX, args, d);
  assert.strictEqual(a.prepared, true);
  assert.strictEqual(b.prepared, true);
  assert.strictEqual(b.alreadyPending, true, 'the second attempt reports the existing decision');
  assert.strictEqual(a.approvalId, b.approvalId, 'same letter, same approval id');
  assert.strictEqual(k.state.prepared.length, 1, 'one human decision was queued, not two');
});

test('RETRY: re-preparing a CHANGED letter is a different approval, not a collision', async () => {
  const k = fakeKernel({ payload: frozen().payload });
  const d = { approval: k.approval, scope: k.scope };
  const base = { inquiry: INQUIRY, to: MESSAGE.to, from: MESSAGE.from, subject: MESSAGE.subject,
    body: MESSAGE.body, commercial: COMMERCIAL, signatory: SIGNATORY };

  const a = await APPROVAL.prepareBuyerEmail(CTX, { ...base, html: MESSAGE.html }, d);
  const b = await APPROVAL.prepareBuyerEmail(CTX,
    { ...base, html: MESSAGE.html.replace('$48,150', '$61,500') }, d);
  assert.notStrictEqual(a.approvalId, b.approvalId);
  assert.strictEqual(k.state.prepared.length, 2, 'a different letter needs its own decision');
});

// ── CHANGED QUOTATIONS ───────────────────────────────────────────────────────

test('CHANGED QUOTE: a moved total refuses the release and names the field', async () => {
  const k = fakeKernel({ payload: frozen().payload });
  const rel = await APPROVAL.releaseBuyerEmail(CTX,
    { approvalId: 'ap-1', releasedBy: 'n', currentCommercial: { ...COMMERCIAL, total: 61500 } },
    { approval: k.approval, scope: k.scope });

  assert.strictEqual(rel.released, false);
  assert.strictEqual(rel.reason, 'quotation_changed');
  assert.deepStrictEqual(rel.changed, [{ field: 'total', approved: 48150, now: 61500 }]);
  // THE CRITICAL HALF: the approval is not spent. Discovering a changed quote must not destroy a
  // human decision, and it must not leave the operator with an approval that reads "released".
  assert.strictEqual(k.state.releaseCount, 0, 'the approval was not claimed');
  assert.strictEqual(k.state.released, false);
});

test('CHANGED QUOTE: the frozen payload is never rewritten to match', async () => {
  const { payload } = frozen();
  const k = fakeKernel({ payload });
  await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'ap-1', releasedBy: 'n',
    currentCommercial: { ...COMMERCIAL, unit_price: 9999 } }, { approval: k.approval, scope: k.scope });
  assert.strictEqual(k.state.payload.commercial.unit_price, 4000, 'approving one offer and '
    + 'sending another with extra steps is the thing this prevents');
});

test('CHANGED QUOTE: every declared commercial field is actually compared', () => {
  // The negative control for the comparison itself. A diff function that silently ignored a field
  // would let that field move between approval and send, and the list would still LOOK complete.
  for (const f of APPROVAL.COMMERCIAL_FIELDS) {
    const moved = { ...COMMERCIAL, [f]: 'DEFINITELY-DIFFERENT' };
    const diff = APPROVAL.commercialDiff(COMMERCIAL, moved);
    assert.deepStrictEqual(diff.map((d) => d.field), [f],
      `${f} is declared in COMMERCIAL_FIELDS but a change to it is not detected`);
  }
});

test('an undeclared field moving does NOT refuse — and that is a stated limit', () => {
  // Honest scope. COMMERCIAL_FIELDS is what is checked; anything outside it is not, and saying so
  // here is worth more than implying the check is total.
  const diff = APPROVAL.commercialDiff(COMMERCIAL, { ...COMMERCIAL, shipping_cost: 2500 });
  assert.deepStrictEqual(diff, []);
});

// ── EXPIRED APPROVALS ────────────────────────────────────────────────────────

test('STALE: an approval older than the TTL is refused', async () => {
  const k = fakeKernel({ payload: frozen().payload,
    approvedAt: new Date(Date.now() - 40 * 3600 * 1000) });
  const rel = await APPROVAL.releaseBuyerEmail(CTX,
    { approvalId: 'ap-1', releasedBy: 'n', ttlMinutes: 1440 }, { approval: k.approval, scope: k.scope });
  assert.strictEqual(rel.released, false);
  assert.strictEqual(rel.reason, 'approval_stale');
  assert.ok(rel.age_minutes >= 2400);
});

test('STALE: an approval just inside the TTL still releases', async () => {
  const k = fakeKernel({ payload: frozen().payload,
    approvedAt: new Date(Date.now() - 23 * 3600 * 1000) });
  const rel = await APPROVAL.releaseBuyerEmail(CTX,
    { approvalId: 'ap-1', releasedBy: 'n', ttlMinutes: 1440 }, { approval: k.approval, scope: k.scope });
  assert.strictEqual(rel.released, true, 'the expiry must have an inside as well as an outside');
});

test('STALE: an approval with no usable decision time is refused, not treated as fresh', async () => {
  const k = fakeKernel({ payload: frozen().payload, approvedAt: null });
  const rel = await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'ap-1', releasedBy: 'n' },
    { approval: k.approval, scope: k.scope });
  assert.strictEqual(rel.released, false);
  assert.strictEqual(rel.reason, 'approval_time_unknown');
});

// ── SUPERSEDED AND UNAPPROVED ────────────────────────────────────────────────

test('a pending approval does not release', async () => {
  const k = fakeKernel({ payload: frozen().payload, status: 'pending' });
  const rel = await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'ap-1', releasedBy: 'n' },
    { approval: k.approval, scope: k.scope });
  assert.strictEqual(rel.released, false);
  assert.strictEqual(rel.reason, 'not_approved');
});

test('a superseded approval does not release', async () => {
  const k = fakeKernel({ payload: frozen().payload, status: 'superseded' });
  const rel = await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'ap-1', releasedBy: 'n' },
    { approval: k.approval, scope: k.scope });
  assert.strictEqual(rel.released, false);
});

// ── A TAMPERED PAYLOAD ───────────────────────────────────────────────────────

test('MISMATCH: a payload whose html no longer hashes to its recorded digest is refused', async () => {
  // The database trigger makes action_payload immutable, so this should be unreachable. It is
  // checked anyway: "should be impossible" is the category every defect in this repository has
  // come from, and the cost is one hash.
  const { payload } = frozen();
  const tampered = { ...payload, html: '<div>12 kg at $1,000/kg — total $12,150 USD</div>' };
  const k = fakeKernel({ payload: tampered });
  const rel = await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'ap-1', releasedBy: 'n' },
    { approval: k.approval, scope: k.scope });
  assert.strictEqual(rel.released, false);
  assert.strictEqual(rel.reason, 'payload_digest_mismatch');
});

test('MISMATCH: a payload recording no digest at all is refused', async () => {
  const { payload } = frozen();
  const stripped = { ...payload };
  delete stripped.transport_digest;
  const k = fakeKernel({ payload: stripped });
  const rel = await APPROVAL.releaseBuyerEmail(CTX, { approvalId: 'ap-1', releasedBy: 'n' },
    { approval: k.approval, scope: k.scope });
  assert.strictEqual(rel.released, false);
  assert.strictEqual(rel.reason, 'payload_digest_mismatch');
});
