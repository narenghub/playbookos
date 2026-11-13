#!/usr/bin/env node
// ── ONE SUPPLIER WORKFLOW, ALL SIX STAGES, DRY RUN ───────────────────────────
//
//   node scripts/demo-autonomous-workflow.js
//
// Spec A milestone 6, item 3: demonstrate one complete supplier workflow through discovery, draft,
// approval, simulated delivery, ledger recording and follow-up scheduling.
//
// ── WHAT IS REAL HERE AND WHAT IS NOT ────────────────────────────────────────
//
// REAL, the actual production modules: the campaign step definitions and copy rendering
// (campaigns/cphi-followup), the MIME builder (gmail/message), the approval lifecycle
// (agents/outreach-approval), the governed boundary (outbound/dispatch) and its digest.
//
// MOCKED: the contact queue (in memory), the approval store (a Map behaving like approval_queue),
// the ledger (records transitions), the kill switch (a variable), and the transport (A COUNTER).
//
// So no database, no network, no credential, and nothing can reach a provider even if every check
// below is wrong. "Dry run" here means the delivery is simulated, NOT that the governance is.
//
// Exit 0 only if every stage behaves as stated, including the refusal counts.

'use strict';

const FOLLOWUP = require('../src/lib/campaigns/cphi-followup');
const { buildMessage } = require('../src/lib/gmail/message');
const APPROVAL = require('../src/lib/agents/outreach-approval');
const D = require('../src/lib/outbound/dispatch');

const FROM = 'naren@abiozen.com';
const ENV = { COMPANY_DOMAINS: 'abiozen.com,adificetechnologies.com' };
const CTX = { runId: 'run-demo-1', companyId: 'abiozen' };

let fail = 0;
const line = (s = '') => console.log(s);
const rule = (c = '─') => line(c.repeat(78));
const stage = (n, t) => { line(); rule(); line(`STAGE ${n} — ${t}`); rule(); line(); };
const check = (okFlag, what, detail) => {
  if (!okFlag) fail += 1;
  line(`  ${okFlag ? ' ok ' : 'FAIL'}  ${what}${detail ? `\n          ${detail}` : ''}`);
};

// ── THE MOCKS ───────────────────────────────────────────────────────────────

const transport = (() => {
  const sends = [];
  return { sends,
    impl: { send: async (m) => {
      sends.push({ to: m.to, bytes: (m.raw || '').length });
      return { ok: true, id: `gmail-${sends.length}`, meta: { threadId: `thread-${sends.length}` } };
    } } };
})();

const ledger = (() => {
  // ── ONE ROW PER ATTEMPT, UPDATED IN PLACE ─────────────────────────────────
  //
  // As the real ledger does: email_log gets one INSERT at beginAttempt carrying claim_ref, and
  // every later transition UPDATEs that same row's outcome. The first version of this mock
  // APPENDED a row per transition instead, so claim_ref and the outcome lived on different rows
  // and priorClaim() could never match one — the duplicate send then went through and the demo
  // reported it. A mock that is unfaithful exactly where the control under test looks is worse
  // than no mock, and this one was unfaithful in the one place that mattered.
  const rows = [];
  const UNSAFE = ['CLAIMED', 'PROVIDER_ACCEPTED', 'OUTCOME_UNKNOWN', 'RECONCILED'];
  return { rows,
    beginAttempt: async (a) => {
      const row = { id: `att-${rows.length + 1}`, outcome: 'PREPARED', to: a.to,
        transport: a.transport, claimRef: a.claimRef, approvalId: a.approvalId };
      rows.push(row);
      const set = (outcome, extra = {}) => { row.outcome = outcome; Object.assign(row, extra); };
      return { ok: true, id: row.id,
        blocked: async (why, scope) => set('BLOCKED', { scope, why }),
        claim: async () => { set('CLAIMED'); return { ok: true }; },
        accepted: async (pid) => set('PROVIDER_ACCEPTED', { provider_id: pid }),
        rejected: async (e) => set('PROVIDER_REJECTED', { e }),
        unknown: async (e) => set('OUTCOME_UNKNOWN', { e }) };
    },
    priorClaim: async (ref, { excludeId } = {}) => rows.find((r) =>
      r.claimRef === ref && r.id !== excludeId && UNSAFE.includes(r.outcome)) || null,
  };
})();

const approvalStore = (() => {
  const rows = new Map();
  return { rows,
    approval: {
      prepare: async (ctx, { id, actionKind, actionPayload, reason }) => {
        if (rows.has(id)) throw new Error('duplicate key value violates unique constraint');
        rows.set(id, { id, actionKind, actionPayload, reason, status: 'pending',
          created_at: new Date().toISOString() });
        return { approvalId: id, status: 'pending' };
      },
      release: async (ctx, { approvalId, releasedBy }) => {
        const r = rows.get(approvalId);
        if (!r) return { released: false, reason: 'not_found' };
        if (r.status !== 'approved') return { released: false, reason: `not_approved (${r.status})`, status: r.status };
        r.status = 'released';
        return { released: true, actionKind: r.actionKind, actionPayload: r.actionPayload,
          releasedAt: new Date().toISOString() };
      },
    } };
})();

const gate = { allowed: true };
const deps = () => ({
  env: ENV,
  gate: { assertSendAllowed: async () => (gate.allowed
    ? { allowed: true }
    : { allowed: false, reason: 'STOPPED_BY_POLICY: capability:email.send', scope: 'capability:email.send' }) },
  ledger,
  transports: { gmail_cphi: transport.impl },
});

(async () => {
  rule('═');
  line('AUTONOMOUS SUPPLIER FOLLOW-UP — END TO END, DRY RUN');
  line('Spec A milestone 6, item 3 · mocked transport, store and ledger · no network, no credential');
  rule('═');

  // ══ 1. DISCOVERY ═════════════════════════════════════════════════════════
  stage(1, 'DISCOVERY — who is due, and for which step');

  // A contact met at CPHI Milan, step 1 sent four days ago, step 2 now due. In production this
  // comes from cphi_followup_state joined to cphi_exhibitor_contacts; here it is one row.
  const contact = {
    id: 4821,
    name: 'Luca Segàla',
    company: 'Nordkem SpA',
    email: 'l.segala@nordkem.test',
    role: 'supplier',
    campaign: FOLLOWUP.campaignFor('cphi-milan-2026', 'supplier') || 'supplier',
    lastStep: 1,
    lastSentAt: new Date(Date.now() - 4 * 86400000),
    threadId: 'thread-earlier',
  };
  const nextStep = contact.lastStep + 1;
  const def = FOLLOWUP.stepDef(contact.campaign, nextStep);

  line(`  contact            ${contact.name}, ${contact.company} (${contact.role})`);
  line(`  campaign           ${contact.campaign}, step ${nextStep} of ${FOLLOWUP.stepsOf(contact.campaign).length}`);
  line(`  step ${contact.lastStep} sent          ${contact.lastSentAt.toISOString().slice(0, 10)} (${4} days ago)`);
  line(`  step ${nextStep} delay        ${def.delayDays} days → due now`);
  line();
  check(!!def, 'the campaign and step come from the real step definitions');
  check(def.delayDays <= 4, `step ${nextStep} is due (delay ${def.delayDays}d, elapsed 4d)`);

  // ══ 2. DRAFT ═════════════════════════════════════════════════════════════
  stage(2, 'DRAFT — rendered by the real campaign copy, built into real MIME');

  // `first`, not `firstName`: render() refuses outright without it rather than defaulting, on the
  // grounds that "Hi ," on a follow-up to somebody met four days ago is worse than not sending.
  // Getting the key wrong therefore throws here instead of producing a broken greeting, which is
  // the behaviour you want from it.
  const rendered = FOLLOWUP.render(contact.campaign, nextStep, {
    first: contact.name.split(' ')[0],
    company: contact.company,
    event: 'CPHI Milan',
  });

  const msg = buildMessage({
    from: { name: FOLLOWUP.SIG_NAME, email: FROM },
    to: { name: contact.name, email: contact.email },
    subject: rendered.subject || `Re: CPHI Milan — ${contact.company}`,
    text: rendered.text,
    html: rendered.html,
    inReplyTo: null,
    references: [],
    attachments: [],
  });

  line(`  subject            ${msg.headers.Subject}`);
  line(`  message-id         ${msg.messageId}`);
  line(`  raw payload        ${msg.raw.length} bytes of base64url RFC822`);
  line(`  preview            ${String(rendered.text || '').replace(/\s+/g, ' ').slice(0, 68)}…`);
  line();
  check(!!msg.raw, 'the message is built into transmittable bytes');
  check(!!rendered.text && !!rendered.html, 'both a text and an HTML body were rendered');

  // ══ 3. THE REFUSAL THAT COMES FIRST ══════════════════════════════════════
  stage(3, 'BEFORE APPROVAL — the boundary refuses, and nothing leaves');

  const beforeApproval = await D.dispatch({
    message: { to: contact.email, subject: msg.headers.Subject, raw: msg.raw,
      mailbox: FROM, threadId: contact.threadId },
    transport: 'gmail_cphi',
    idempotencyKey: `cphi_followup_sends:${contact.id}:${nextStep}`,
    workflow: 'cphi-followup', agent: 'cphi-runner',
  }, deps());

  line(`  dispatch           ${beforeApproval.phase}`);
  line(`  reason             ${String(beforeApproval.error).split('.')[0]}`);
  line();
  check(beforeApproval.ok === false, 'an unapproved external send is refused');
  check(transport.sends.length === 0, `provider calls: ${transport.sends.length} (expected 0)`);
  check(beforeApproval.needsApproval === true, 'and it says WHY — a decision is missing, not a fault');

  // ══ 4. APPROVAL ══════════════════════════════════════════════════════════
  stage(4, 'APPROVAL — queued for a human, decided, released');

  const queued = await APPROVAL.prepareOutreachEmail(CTX, {
    to: contact.email,
    subject: msg.headers.Subject,
    raw: msg.raw,
    mailbox: FROM,
    transport: 'gmail_cphi',
    threadId: contact.threadId,
    campaign: contact.campaign,
    step: nextStep,
    contactRef: String(contact.id),
    preview: rendered.html,
  }, approvalStore);

  line(`  queued             ${queued.approvalId}`);
  line(`  status             ${queued.status}`);
  line(`  digest             ${queued.transportDigest}  (over the RAW bytes)`);
  line(`  approver reads     "${approvalStore.rows.get(queued.approvalId).reason}"`);
  line();
  check(queued.prepared === true, 'the message is waiting on a person, not discarded');
  check(approvalStore.rows.get(queued.approvalId).reason.includes(contact.email),
    'the approval request names the recipient');

  // Re-queue the identical message: idempotent, not a second decision for the same letter.
  const again = await APPROVAL.prepareOutreachEmail(CTX, {
    to: contact.email, subject: msg.headers.Subject, raw: msg.raw, mailbox: FROM,
    transport: 'gmail_cphi', threadId: contact.threadId, campaign: contact.campaign,
    step: nextStep, contactRef: String(contact.id), preview: rendered.html,
  }, approvalStore);
  check(again.alreadyPending === true && approvalStore.rows.size === 1,
    're-running the agent does not queue the same letter twice');

  // Releasing before a human decides must refuse.
  const early = await APPROVAL.releaseOutreachEmail(CTX,
    { approvalId: queued.approvalId, releasedBy: 'cphi-runner' }, approvalStore);
  check(early.released === false, 'it cannot be released before anybody approves it',
    `reason: ${early.reason}`);

  // ── THE HUMAN ACTS ──
  line();
  line('  → Naresh opens Approvals, reads the preview, and approves.');
  approvalStore.rows.get(queued.approvalId).status = 'approved';
  line();

  const released = await APPROVAL.releaseOutreachEmail(CTX,
    { approvalId: queued.approvalId, releasedBy: 'naren@abiozen.com' }, approvalStore);
  check(released.released === true, 'the approved artefact is released once', released.reason);
  check(released.expectedDigest === queued.transportDigest,
    'and it carries the digest it was approved under');

  // ══ 5. SIMULATED DELIVERY ════════════════════════════════════════════════
  stage(5, 'DELIVERY — through the governed boundary, to a mocked transport');

  const sent = await D.dispatch({
    message: { ...released.message, mailbox: FROM },
    transport: released.transport,
    idempotencyKey: `cphi_followup_sends:${contact.id}:${nextStep}`,
    approvalId: released.approvalId,
    expectedDigest: released.expectedDigest,
    workflow: 'cphi-followup', agent: 'cphi-runner',
  }, deps());

  line(`  dispatch           ${sent.phase}`);
  line(`  provider id        ${sent.id}`);
  line(`  thread             ${sent.meta && sent.meta.threadId}`);
  line();
  check(sent.ok === true, 'the approved message is transmitted', sent.error);
  check(transport.sends.length === 1, `provider calls: ${transport.sends.length} (expected 1)`);

  // Tamper in flight, with the SAME approval and digest.
  const tampered = await D.dispatch({
    message: { ...released.message, mailbox: FROM,
      raw: Buffer.from('a different letter entirely').toString('base64url') },
    transport: released.transport,
    idempotencyKey: `cphi_followup_sends:${contact.id}:${nextStep}:t`,
    approvalId: released.approvalId, expectedDigest: released.expectedDigest,
  }, deps());
  check(tampered.phase === 'digest_mismatch' && transport.sends.length === 1,
    'swapping the bytes after release is refused', `provider calls still ${transport.sends.length}`);

  // The same key again: refused as a duplicate, never resent.
  const repeat = await D.dispatch({
    message: { ...released.message, mailbox: FROM },
    transport: released.transport,
    idempotencyKey: `cphi_followup_sends:${contact.id}:${nextStep}`,
    approvalId: released.approvalId, expectedDigest: released.expectedDigest,
  }, deps());
  check(repeat.phase === 'refused_duplicate' && transport.sends.length === 1,
    'running the agent again does not send it twice', `provider calls still ${transport.sends.length}`);

  // And a STOP still overrides an approval.
  gate.allowed = false;
  const stopped = await D.dispatch({
    message: { ...released.message, mailbox: FROM },
    transport: released.transport,
    idempotencyKey: `cphi_followup_sends:${contact.id}:${nextStep}:s`,
    approvalId: released.approvalId, expectedDigest: released.expectedDigest,
  }, deps());
  gate.allowed = true;
  check(stopped.stopped === true && transport.sends.length === 1,
    'a STOP overrides a human approval', `provider calls still ${transport.sends.length}`);

  // ══ 6. LEDGER ════════════════════════════════════════════════════════════
  stage(6, 'LEDGER — what an auditor can reconstruct afterwards');

  line('  outcome               detail');
  line('  ' + '-'.repeat(70));
  for (const r of ledger.rows) {
    const detail = r.scope ? `scope ${r.scope}`
      : r.provider_id ? `provider id ${r.provider_id}`
        : r.claimRef ? `claim ${r.claimRef}${r.approvalId ? `, approval ${r.approvalId}` : ''}`
          : '';
    line(`  ${String(r.outcome).padEnd(21)} ${detail}`);
  }
  line();
  const accepted = ledger.rows.filter((r) => r.outcome === 'PROVIDER_ACCEPTED').length;
  const blocked = ledger.rows.filter((r) => r.outcome === 'BLOCKED').length;
  check(accepted === 1, `exactly one PROVIDER_ACCEPTED row (${accepted})`);
  check(blocked >= 2, `every refusal recorded too (${blocked} BLOCKED rows)`);
  check(ledger.rows.some((r) => r.approvalId === queued.approvalId),
    'the send is traceable to the approval a human gave');

  // ══ 7. FOLLOW-UP SCHEDULING ══════════════════════════════════════════════
  stage(7, 'FOLLOW-UP — when the next step becomes due');

  const after = FOLLOWUP.stepDef(contact.campaign, nextStep + 1);
  if (after) {
    const due = new Date(Date.now() + after.delayDays * 86400000);
    line(`  next step          ${nextStep + 1} of ${FOLLOWUP.stepsOf(contact.campaign).length}`);
    line(`  delay              ${after.delayDays} days`);
    line(`  due                ${due.toISOString().slice(0, 10)}`);
    line(`  state              active`);
    line();
    check(after.delayDays > 0, 'the next step has a real delay from the campaign definition');
    line('     And it will stop at the same boundary: queued for approval, not sent.');
  } else {
    line(`  step ${nextStep} was the last — sequence completed, state 'completed'.`);
    check(true, 'the sequence terminates rather than looping');
  }

  // ══ VERDICT ══════════════════════════════════════════════════════════════
  line();
  rule('═');
  if (fail) {
    line(`FAIL  ${fail} stage check(s) did not hold. The workflow is NOT as described.`);
    process.exit(1);
  }
  line('PASS  discovery → draft → refusal → approval → delivery → ledger → follow-up.');
  line(`      1 message transmitted to a counter; 4 refusals at 0 provider calls each.`);
  line('      Nothing was sent: no credential, no network, no database in this process.');
  rule('═');
  process.exit(0);
})().catch((e) => {
  console.error(`\nFAILED: ${(e && e.stack) || e}`);
  process.exit(1);
});
