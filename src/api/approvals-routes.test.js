// ── THE APPROVAL SURFACE CANNOT SEND, AND CANNOT SAY IT DID ──────────────────
//
//   node --test src/api/approvals-routes.test.js
//
// CEO decision 2026-11-11 priority 2. Two kinds of assertion here, and the split is deliberate:
// the verdict helpers are driven as functions, and the parts that live in markup — the page
// wiring, the admin gate, the sandboxed frame — are asserted against the shipped file, because a
// page that is never attached to `pages` is a nav link that navigates to nothing.
//
// The failure this guards against is not "approval is missing". It is a surface that LOOKS like it
// sent something. The WhatsApp notice this whole workstream came from read "💰 Large quote sent"
// about mail nobody had approved; a review screen that says "Sent!" after setting a status would
// be the same lie with a better interface.

'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'preflight';

const ROUTES = require('./approvals.routes');
const APPROVAL = require('../lib/agents/buyer-email-approval');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, 'approvals.routes.js'), 'utf8');

const PAYLOAD = {
  html: '<div>Quotation QT-1 — 12 kg — $48,150</div>',
  subject: 'Quotation QT-1', to: 'buyer@acme.test', from: 'Sales <sales@abiozen.com>',
  transport_digest: 'd'.repeat(32), signed_by_email: 'naren@abiozen.com',
  signed_by_user_id: 'u-7', display_name: 'Sarah Chen',
  commercial: { total: 48150, currency: 'USD' }, inquiry_id: 'inq-1',
};
const row = (over = {}) => ({
  id: 'ap-1', company_id: 'co-1', run_id: 'run-1', action_kind: APPROVAL.ACTION_KIND,
  action_payload: PAYLOAD, status: 'pending', owner_user_id: 'u-7', reason: 'a quotation',
  created_at: new Date(), resolved_at: null, released_at: null, ...over,
});

// ── VALIDITY: WHY THIS CANNOT BE APPROVED, ANSWERABLE ON THE SCREEN ──────────

test('a fresh pending approval is actionable', () => {
  const v = ROUTES.validity(row());
  assert.strictEqual(v.actionable, true);
  assert.deepStrictEqual(v.reasons, []);
});

test('each terminal or spent state is reported with what will happen', () => {
  const cases = [
    [{ status: 'rejected' }, 'rejected'],
    [{ status: 'superseded' }, 'superseded'],
    [{ status: 'expired' }, 'expired'],
    [{ released_at: new Date() }, 'already_released'],
  ];
  for (const [over, code] of cases) {
    const v = ROUTES.validity(row(over));
    assert.strictEqual(v.actionable, false, `${code} was reported actionable`);
    assert.ok(v.reasons.some((r) => r.code === code), `${code} missing from the reasons`);
    for (const r of v.reasons) {
      assert.ok(r.detail && r.detail.length > 8, `${r.code} has no usable detail`);
    }
  }
});

test('an approval past its TTL is reported stale, with the release consequence', () => {
  const v = ROUTES.validity(row({
    status: 'approved', resolved_at: new Date(Date.now() - 40 * 3600 * 1000) }));
  const stale = v.reasons.find((r) => r.code === 'stale');
  assert.ok(stale, 'a 40-hour-old approval was not reported stale');
  assert.match(stale.detail, /refused at release/);
});

test('an approval just inside the TTL is not called stale', () => {
  const v = ROUTES.validity(row({
    status: 'approved', resolved_at: new Date(Date.now() - 2 * 3600 * 1000) }));
  assert.ok(!v.reasons.some((r) => r.code === 'stale'));
});

test('a payload with no digest or no signatory is flagged before a human grants it', () => {
  // Both are refused by release(). Showing them at review time is the difference between a human
  // spending a decision on something unreleasable and not.
  const noDigest = { ...PAYLOAD }; delete noDigest.transport_digest;
  assert.ok(ROUTES.validity(row({ action_payload: noDigest })).reasons
    .some((r) => r.code === 'no_digest'));

  const noSig = { ...PAYLOAD }; delete noSig.signed_by_email; delete noSig.signed_by_user_id;
  assert.ok(ROUTES.validity(row({ action_payload: noSig })).reasons
    .some((r) => r.code === 'no_signatory'));
});

// ── SELF-APPROVAL: DETECTED ALWAYS, BLOCKED ONLY BY POLICY ───────────────────

test('self-approval is detected by user id, email, or the frozen signatory', () => {
  assert.strictEqual(ROUTES.isSelfApproval(row(), { id: 'u-7' }), true);
  assert.strictEqual(ROUTES.isSelfApproval(row(), { email: 'naren@abiozen.com' }), true);
  assert.strictEqual(ROUTES.isSelfApproval(row(), { email: 'NAREN@ABIOZEN.COM' }), true);
  assert.strictEqual(ROUTES.isSelfApproval(row(), { id: 'u-9', email: 'other@abiozen.com' }), false);
});

test('an approval with no owner is not self-approval by default', () => {
  const r = row({ owner_user_id: null, action_payload: { ...PAYLOAD, signed_by_email: null, signed_by_user_id: null } });
  assert.strictEqual(ROUTES.isSelfApproval(r, { id: 'u-7' }), false);
});

test('the self-approval fact is STORED, not merely displayed', () => {
  // A screen can be changed; the record is what an audit reads.
  assert.match(SRC, /resolution: self \?/,
    'the stored resolution does not record that the owner decided their own action');
  assert.match(SRC, /\[self-approval: decided by the owner\/signatory\]/);
});

test('self-approval blocks only behind APPROVAL_FORBID_SELF', () => {
  assert.match(SRC, /APPROVAL_FORBID_SELF/);
  assert.match(SRC, /FORBID_SELF\(\)/, 'the policy flag is read but never consulted');
  // And the default is not a block: one admin who is also the signatory would otherwise be unable
  // to approve anything, and a control that stops all work is removed within a week.
  assert.ok(!/APPROVAL_FORBID_SELF \|\| 'true'/.test(SRC),
    'the policy defaults to ON, which makes every approval impossible for a single-admin company');
});

// ── THE SURFACE CANNOT SEND ──────────────────────────────────────────────────

test('nothing in this route transmits', () => {
  for (const forbidden of ['sendEmail', 'sendEmailDetailed', 'releaseBuyerEmail', 'releaseQuote',
    'sendApprovedBuyerEmail', 'claimApprovalRelease', 'sendWhatsApp']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\s*\\(`).test(SRC),
      `the approval surface calls ${forbidden} — deciding must not also be sending, or a click on `
      + 'a review screen becomes an override of a containment hold');
  }
});

test('every successful decision states that nothing was sent', () => {
  assert.match(SRC, /sent: false/,
    'a decision response does not say sent:false, so a client may present it as delivery');
  assert.match(SRC, /NOTHING HAS BEEN SENT/);
});

test('a decision requires a resolution', () => {
  assert.match(SRC, /a resolution is required/,
    'a decision can be recorded with no account of why it was taken');
});

test('a decision is arbitrated in one statement, not a read-then-write', () => {
  // Two reviewers clicking at once would both see 'pending'. decideApproval's WHERE clause is the
  // arbitration; this asserts the route relies on it rather than on its own prior SELECT.
  assert.match(SRC, /already_decided/,
    'the route does not handle losing the arbitration, so a second decision would look successful');
  assert.match(SRC, /SCOPE\.decideApproval\(/);
});

// ── DISCLOSURE ───────────────────────────────────────────────────────────────

test('the list does not carry message bodies; the detail route does', () => {
  const s = ROUTES.summarise(row());
  assert.ok(!('html' in s), 'the list summary carries the rendered message — a list of every '
    + 'message body is a copy of all correspondence');
  assert.ok(!('body_text' in s));
  assert.strictEqual(s.transport_digest, 'd'.repeat(32), 'the digest is still shown');
  assert.strictEqual(s.subject, 'Quotation QT-1');
  // And the detail route serves the artefact itself: a summary would break the one property the
  // whole mechanism rests on — that what a human read is what gets executed.
  assert.match(SRC, /html: p\.html \|\| null/);
});

test('the already-decided conflict does not spread the whole row', () => {
  // The accessor returns the full record including the rendered message, and spreading it into a
  // 409 would put the most disclosing payload in this platform into an error body.
  assert.ok(!/code: 'already_decided', current: now \|\| null/.test(SRC),
    'the 409 response spreads the accessor row, leaking the rendered message');
  assert.match(SRC, /status: now\.status, resolved_by: now\.resolved_by/);
});

test('kernel reads go through the company-scoped accessor', () => {
  assert.match(SRC, /SCOPE\.approvalsForReview\(/);
  assert.match(SRC, /SCOPE\.approvalForReview\(/);
  assert.ok(!/FROM\s+office_approvals/i.test(SRC),
    'a company predicate written here is one somebody can forget, and forgetting it on THIS read '
    + "would show one tenant another's held commercial letters");
});

// ── THE PAGE ─────────────────────────────────────────────────────────────────

test("pages['approvals'] is attached, so the nav link navigates somewhere", () => {
  assert.match(HTML, /pages\['approvals'\]\s*=\s*window\.approvalsPage/);
  assert.match(HTML, /window\.approvalsPage\s*=\s*async function approvalsPage/,
    'the page handler is not assigned to window as an async function — Annex B hoists a plain '
    + 'function out of a block but NOT an async one, so a block-scoped handler throws '
    + 'ReferenceError on click and does nothing visible');
});

test('every onclick handler on this page is reachable from the global scope', () => {
  for (const fn of ['apOpen', 'apDecide', 'apSetStatus']) {
    assert.ok(new RegExp(`window\\.${fn}\\s*=`).test(HTML),
      `${fn} is used in an onclick but never assigned to window`);
  }
});

test('the page is admin-only in the nav, beside decisions and spend', () => {
  assert.match(HTML, /\['decisions', 'spend', 'approvals'\]\.indexOf\(pageId\)/,
    'approvals is not in the admin-only gate inside passesPageReads, so it would fall through to '
    + 'the tier rules and fail open to anyone holding the section');
});

// Comments are stripped before asserting on markup. My first version of the sandbox test failed
// on my own comment — "sandbox with no allow-scripts and no allow-same-origin" — which is a guard
// reading prose as code, the same shape as the B6 control that scanned for a string literal using
// the function that blanked string literals.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

test('the frozen message is rendered in a frame with no script and no same-origin access', () => {
  const code = codeOnly(HTML);
  const i = code.indexOf('window.apOpen');
  const body = code.slice(i, code.indexOf('window.apDecide', i));
  assert.match(body, /<iframe sandbox /,
    'the payload is dropped into a page holding an admin session without a sandbox');
  assert.ok(!/allow-scripts/.test(body), 'the sandbox allows scripts');
  assert.ok(!/allow-same-origin/.test(body), 'the sandbox allows same-origin access');
});

test('the page checks the payload instead of trusting it', () => {
  // window.API does not throw on a non-2xx: a 403 or 503 arrives as a RESOLVED value carrying
  // {error, code}. A try/catch would be dead code — which is exactly how the first versions of
  // the decisions and spend pages shipped broken.
  const i = HTML.indexOf('window.approvalsPage = async function');
  const body = HTML.slice(i, i + 2600);
  assert.match(body, /if \(!d \|\| d\.error\)/,
    'the approvals page does not check the response payload');
  assert.match(body, /NOT an empty queue/,
    'a failed read would be presented as an empty queue, which reads as "you are clear"');
});

test('the page never tells a reviewer the message was sent', () => {
  const i = HTML.indexOf('window.apOpen');
  const body = HTML.slice(i, HTML.indexOf("pages['approvals']", i));
  assert.match(body, /Approving does not send/);
  assert.ok(!/\bSent!|has been sent\b/.test(body),
    'the review screen claims the message was sent');
});
