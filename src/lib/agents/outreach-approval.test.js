// ── CAN AN APPROVED OUTREACH MESSAGE BECOME A DIFFERENT MESSAGE? ─────────────
//
//   node --test src/lib/agents/outreach-approval.test.js
//
// Spec A milestone 6, item 2. The lifecycle these controls cover: the agent freezes a message and
// queues a decision; a human approves it; release hands back the frozen artefact and its digest;
// dispatch revalidates that digest against the bytes it is about to transmit; the sender service
// revalidates it a third time from the request body.
//
// The question worth asking of all that is the one in the title. Every control below is an attempt
// to answer YES.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const A = require('./outreach-approval');
const D = require('../outbound/dispatch');

const CTX = { runId: 'run-7', companyId: 'abiozen' };
const RAW = Buffer.from('From: sales@abiozen.com\r\nTo: buyer@acme-pharma.test\r\n\r\nHello.').toString('base64url');

const MSG = {
  to: 'buyer@acme-pharma.test',
  subject: 'Re: CPHI Milan — API supply follow-up',
  raw: RAW,
  mailbox: 'naren@abiozen.com',
  transport: 'gmail_cphi',
  campaign: 'supplier',
  step: 2,
  contactRef: '4821',
  preview: '<p>Following up on our conversation at stand 4C-21.</p>',
};

/** An approval store that behaves like office/approval, and can be tampered with. */
function store() {
  const rows = new Map();
  return {
    rows,
    approval: {
      prepare: async (ctx, { id, actionKind, actionPayload, reason }) => {
        if (rows.has(id)) {
          const e = new Error('duplicate key value violates unique constraint');
          throw e;
        }
        rows.set(id, { id, actionKind, actionPayload, reason, status: 'pending',
          created_at: new Date().toISOString() });
        return { approvalId: id, status: 'pending' };
      },
      release: async (ctx, { approvalId, releasedBy }) => {
        const r = rows.get(approvalId);
        if (!r) return { released: false, reason: 'not_found' };
        if (r.status === 'released') return { released: false, reason: 'already_released' };
        if (r.status === 'rejected') return { released: false, reason: 'rejected', status: 'rejected' };
        r.status = 'released';
        r.releasedBy = releasedBy;
        return { released: true, actionKind: r.actionKind, actionPayload: r.actionPayload,
          releasedAt: new Date().toISOString() };
      },
    },
  };
}

// ═══ 1. QUEUEING A DECISION ════════════════════════════════════════════════

test('1. an outreach message is frozen and queued for a human', async () => {
  const s = store();
  const r = await A.prepareOutreachEmail(CTX, { ...MSG, reason: 'follow-up' }, s);
  assert.strictEqual(r.prepared, true, r.detail);
  assert.strictEqual(r.status, 'pending');
  const row = s.rows.get(r.approvalId);
  assert.strictEqual(row.actionKind, A.ACTION_KIND);
  assert.strictEqual(row.actionPayload.raw, RAW, 'the raw bytes were not frozen into the approval');
  assert.ok(row.reason.includes('buyer@acme-pharma.test'),
    'the approver cannot see who this is addressed to');
});

test('1b. re-queueing the SAME message is idempotent, not a second decision', async () => {
  const s = store();
  const a = await A.prepareOutreachEmail(CTX, MSG, s);
  const b = await A.prepareOutreachEmail(CTX, MSG, s);
  assert.strictEqual(b.prepared, true);
  assert.strictEqual(b.alreadyPending, true);
  assert.strictEqual(b.approvalId, a.approvalId);
  assert.strictEqual(s.rows.size, 1, 'the same letter was queued twice for one person to decide');
});

test('1c. a CHANGED message is a NEW decision, not a silent collision', async () => {
  const s = store();
  const a = await A.prepareOutreachEmail(CTX, MSG, s);
  const b = await A.prepareOutreachEmail(CTX,
    { ...MSG, raw: Buffer.from('different bytes entirely').toString('base64url') }, s);
  assert.notStrictEqual(b.approvalId, a.approvalId,
    'a different message reused the first message\'s approval id');
  assert.strictEqual(s.rows.size, 2);
});

test('1d. an incomplete message is refused rather than queued', async () => {
  const s = store();
  for (const missing of ['to', 'subject', 'raw', 'mailbox', 'transport']) {
    const m = { ...MSG }; delete m[missing];
    const r = await A.prepareOutreachEmail(CTX, m, s);
    assert.strictEqual(r.prepared, false, `a message with no ${missing} was queued`);
    assert.strictEqual(r.reason, 'payload_incomplete');
  }
  assert.strictEqual(s.rows.size, 0, 'a decision was put in front of a human about nothing');
});

test('1e. no governed context means no approval, and it says so', async () => {
  const s = store();
  for (const ctx of [null, {}, { companyId: 'abiozen' }]) {
    const r = await A.prepareOutreachEmail(ctx, MSG, s);
    assert.strictEqual(r.prepared, false);
    assert.strictEqual(r.reason, 'no_governed_context');
  }
});

// ═══ 2. THE DIGEST BINDS THE TRANSMITTED BYTES ═════════════════════════════

test('2. the digest is over raw, and matches what dispatch will compute', async () => {
  // If these two disagree, every approved message is refused by dispatch as tampered — or, with
  // the comparison the other way round, none of them is bound at all.
  const s = store();
  const r = await A.prepareOutreachEmail(CTX, MSG, s);
  const released = await A.releaseOutreachEmail(CTX, { approvalId: r.approvalId, releasedBy: 'naren' }, s);
  assert.strictEqual(released.released, true, released.reason);
  assert.strictEqual(released.expectedDigest,
    D.transmittedDigest({ to: MSG.to, subject: MSG.subject, raw: RAW }),
    'the approval and dispatch compute different digests for the same bytes');
});

test('2b. changing the PREVIEW cannot change what is sent', async () => {
  // The preview exists so a human can read the letter; the raw blob is unreadable base64. It must
  // therefore carry no authority: two messages differing only in preview are the same message.
  const s = store();
  const a = await A.prepareOutreachEmail(CTX, MSG, s);
  const b = await A.prepareOutreachEmail(CTX, { ...MSG, preview: '<p>something else entirely</p>' }, s);
  assert.strictEqual(b.transportDigest, a.transportDigest,
    'the preview is inside the digest, so an unreadable blob could be approved by a readable lie');
});

test('2c. a payload altered IN THE STORE after approval is refused at release', async () => {
  // The joint this covers is the approval store itself. dispatch and the sender service both
  // recompute the digest — but they compare against the digest TRAVELLING WITH the payload, so a
  // row edited in the database would carry its own consistent digest and satisfy them both.
  const s = store();
  const r = await A.prepareOutreachEmail(CTX, MSG, s);

  const row = s.rows.get(r.approvalId);
  row.actionPayload.raw = Buffer.from('a completely different letter').toString('base64url');

  const released = await A.releaseOutreachEmail(CTX, { approvalId: r.approvalId, releasedBy: 'naren' }, s);
  assert.strictEqual(released.released, false, 'an altered approved payload was released');
  assert.strictEqual(released.reason, 'approved_payload_altered');
});

test('2d. a swapped RECIPIENT in the store is refused too', async () => {
  const s = store();
  const r = await A.prepareOutreachEmail(CTX, MSG, s);
  s.rows.get(r.approvalId).actionPayload.to = 'someone-else@elsewhere.test';
  const released = await A.releaseOutreachEmail(CTX, { approvalId: r.approvalId, releasedBy: 'naren' }, s);
  assert.strictEqual(released.released, false);
  assert.strictEqual(released.reason, 'approved_payload_altered');
});

// ═══ 3. RELEASE IS ONCE, AND ONLY FOR WHAT WAS APPROVED ════════════════════

test('3. an approval releases exactly once', async () => {
  const s = store();
  const r = await A.prepareOutreachEmail(CTX, MSG, s);
  const first = await A.releaseOutreachEmail(CTX, { approvalId: r.approvalId, releasedBy: 'naren' }, s);
  const second = await A.releaseOutreachEmail(CTX, { approvalId: r.approvalId, releasedBy: 'naren' }, s);
  assert.strictEqual(first.released, true);
  assert.strictEqual(second.released, false);
  assert.strictEqual(second.reason, 'already_released');
});

test('3b. a rejected approval releases nothing', async () => {
  const s = store();
  const r = await A.prepareOutreachEmail(CTX, MSG, s);
  s.rows.get(r.approvalId).status = 'rejected';
  const out = await A.releaseOutreachEmail(CTX, { approvalId: r.approvalId, releasedBy: 'naren' }, s);
  assert.strictEqual(out.released, false);
  assert.strictEqual(out.reason, 'rejected');
});

test('3c. an approval for a DIFFERENT action cannot be spent as an outreach send', async () => {
  // Without this, any approved action id in the queue would be a licence to mail somebody.
  const s = store();
  await s.approval.prepare(CTX, { id: 'ap-other', actionKind: 'invoice.pay',
    actionPayload: { to: 'buyer@acme-pharma.test', raw: RAW, transport: 'gmail_cphi' },
    reason: 'pay an invoice' });
  const out = await A.releaseOutreachEmail(CTX, { approvalId: 'ap-other', releasedBy: 'naren' }, s);
  assert.strictEqual(out.released, false);
  assert.strictEqual(out.reason, 'wrong_action_kind');
});

test('3d. release refuses without an approval id or a releasing actor', async () => {
  const s = store();
  const r = await A.prepareOutreachEmail(CTX, MSG, s);
  assert.strictEqual((await A.releaseOutreachEmail(CTX, { releasedBy: 'naren' }, s)).reason, 'no_approval_id');
  assert.strictEqual((await A.releaseOutreachEmail(CTX, { approvalId: r.approvalId }, s)).reason,
    'no_releasing_actor');
  assert.strictEqual(s.rows.get(r.approvalId).status, 'pending',
    'a malformed release spent the approval anyway');
});

// ═══ 4. END TO END: QUEUED → APPROVED → DISPATCHED ═════════════════════════

test('4. the released message passes dispatch, and a tampered one does not', async () => {
  const s = store();
  const r = await A.prepareOutreachEmail(CTX, MSG, s);
  const rel = await A.releaseOutreachEmail(CTX, { approvalId: r.approvalId, releasedBy: 'naren' }, s);
  assert.strictEqual(rel.released, true, rel.reason);

  const sends = [];
  const deps = {
    env: { COMPANY_DOMAINS: 'abiozen.com' },
    gate: { assertSendAllowed: async () => ({ allowed: true }) },
    ledger: {
      beginAttempt: async () => ({ ok: true, id: 'att-1',
        blocked: async () => {}, claim: async () => {}, accepted: async () => {},
        rejected: async () => {}, unknown: async () => {} }),
      priorClaim: async () => null,
    },
    transports: { gmail_cphi: { send: async (m) => { sends.push(m.to); return { ok: true, id: 'p-1' }; } } },
  };

  // (a) exactly as approved → transmitted
  const ok = await D.dispatch({
    message: { ...rel.message, mailbox: MSG.mailbox },
    transport: rel.transport, idempotencyKey: 'cphi:4821:2',
    approvalId: rel.approvalId, expectedDigest: rel.expectedDigest,
  }, deps);
  assert.strictEqual(ok.ok, true, ok.error);
  assert.strictEqual(sends.length, 1);

  // (b) the SAME approval and digest, with the bytes swapped in flight → refused, 0 more sends
  const tampered = await D.dispatch({
    message: { ...rel.message, mailbox: MSG.mailbox,
      raw: Buffer.from('swapped after release').toString('base64url') },
    transport: rel.transport, idempotencyKey: 'cphi:4821:2b',
    approvalId: rel.approvalId, expectedDigest: rel.expectedDigest,
  }, deps);
  assert.strictEqual(tampered.ok, false);
  assert.strictEqual(tampered.phase, 'digest_mismatch');
  assert.strictEqual(sends.length, 1, 'a message altered after release was transmitted');
});

// ═══ 5. THE AGENTS ACTUALLY QUEUE, RATHER THAN DECLINING ═══════════════════

test('5. both agents prepare an approval on the needs-approval path', () => {
  // Structural, because driving the full send loop needs a database. What is asserted is the thing
  // milestone 6 item 2 asks for: the agents no longer silently refuse.
  const LEX = require('../../../scripts/js-lex');
  for (const f of ['src/lib/campaigns/cphi-runner.js', 'src/lib/agents/outreach-agent.js']) {
    const code = LEX.blankNonCode(fs.readFileSync(path.join(__dirname, '..', '..', '..', f), 'utf8'));
    assert.ok(/prepareOutreachEmail\s*\(/.test(code),
      `${f} does not queue an approval — it still just declines`);
    assert.ok(/outreachApprovalContext\s*\(/.test(code),
      `${f} never establishes a governed context, so every prepare would be refused`);
    assert.ok(/queued_for_approval/.test(code),
      `${f} does not count what it queued, so a run that queued everything reads as a quiet day`);
    assert.ok(/approval_unavailable/.test(code),
      `${f} does not distinguish "nobody has decided yet" from "this could not be put in front of `
      + 'anybody" — collapsing them hides the second behind the first');
  }
});

test('5b. the approval module computes no digest of its own', () => {
  // It delegates to dispatch.transmittedDigest. Two implementations of one hash is how a binding
  // check quietly stops binding — the defect mailer.js warns about and that I then committed in
  // dispatch's first draft.
  const LEX = require('../../../scripts/js-lex');
  const code = LEX.blankNonCode(fs.readFileSync(path.join(__dirname, 'outreach-approval.js'), 'utf8'));
  assert.ok(!/createHash|createHmac/.test(code),
    'outreach-approval.js hashes something itself instead of delegating to transmittedDigest');
  assert.ok(/transmittedDigest/.test(code), 'it does not use dispatch\'s digest at all');
});
