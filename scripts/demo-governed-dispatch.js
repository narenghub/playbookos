#!/usr/bin/env node
// ── ONE WORKFLOW, END TO END, THROUGH THE GOVERNED BOUNDARY ──────────────────
//
//   node scripts/demo-governed-dispatch.js
//
// Spec A milestone 5, item 6: demonstrate one complete supplier workflow in dry-run mode.
//
// DRY RUN IN THE STRONG SENSE. No database, no network, no credential, no live email. The
// transport is a counter, the ledger is in memory, the kill switch is a variable. Nothing here can
// reach a provider even if it is wrong.
//
// What it demonstrates is not "a message can be sent" — that was never the hard part. It is the
// five ways a send is REFUSED, each with the provider-invocation count printed, and then the one
// path that is permitted. The counts are the evidence: "it returned ok:false" is not proof that
// nothing left, and this project has twice mistaken one for the other.
//
// Exit 0 only if every expectation holds, including every zero.

'use strict';

const D = require('../src/lib/outbound/dispatch');

const BUYER = 'procurement@acme-pharma.test';          // external
const OPS = 'ops@abiozen.com';                          // internal
const ENV = { COMPANY_DOMAINS: 'abiozen.com,adificetechnologies.com' };

let fail = 0;
const pad = (s, n) => String(s).padEnd(n);
const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(78));

// ── THE MOCKS ───────────────────────────────────────────────────────────────

/** The provider, as a counter. Every call is recorded; nothing leaves this process. */
function mockTransport() {
  const sends = [];
  return { sends, impl: { send: async (m) => { sends.push(m.to); return { ok: true, id: `mock-${sends.length}`, meta: { threadId: `t-${sends.length}` } }; } } };
}

/** The ledger, in memory, recording the transitions a real run would persist. */
function mockLedger({ priorClaim = null } = {}) {
  const rows = [];
  return {
    rows,
    beginAttempt: async (a) => {
      rows.push({ kind: 'PREPARED', to: a.to, claimRef: a.claimRef });
      const id = `att-${rows.length}`;
      return { ok: true, id,
        blocked: async (why, scope) => rows.push({ kind: 'BLOCKED', scope, why }),
        claim: async () => { rows.push({ kind: 'CLAIMED', id }); return { ok: true }; },
        accepted: async (pid) => rows.push({ kind: 'PROVIDER_ACCEPTED', pid }),
        rejected: async (e) => rows.push({ kind: 'PROVIDER_REJECTED', e }),
        unknown: async (e) => rows.push({ kind: 'OUTCOME_UNKNOWN', e }) };
    },
    priorClaim: async () => priorClaim,
  };
}

const gateAllowing = { assertSendAllowed: async () => ({ allowed: true }) };
const gateStopping = {
  assertSendAllowed: async () => ({ allowed: false,
    reason: 'STOPPED_BY_POLICY: capability:email.send — all platform email held since 2026-11-03',
    scope: 'capability:email.send' }),
};

/** One scenario. Asserts the provider-invocation count, and prints it either way. */
async function scenario(name, { call, gate = gateAllowing, ledger = mockLedger(), expectSends, expectOk }) {
  const t = mockTransport();
  const deps = { env: ENV, gate, ledger, transports: { gmail_cphi: t.impl } };
  const r = await D.dispatch(call, deps);

  const sendsOk = t.sends.length === expectSends;
  const okOk = !!r.ok === expectOk;
  const verdict = sendsOk && okOk ? ' ok ' : 'FAIL';
  if (!sendsOk || !okOk) fail += 1;

  line(`  ${verdict}  ${pad(name, 46)} provider calls: ${t.sends.length} (expected ${expectSends})`);
  if (!r.ok) line(`        refused at ${r.phase}: ${String(r.error).split('.')[0]}`);
  else line(`        dispatched, provider id ${r.id}, thread ${r.meta && r.meta.threadId}`);
  const trail = ledger.rows.map((x) => x.kind).join(' → ') || '(no ledger rows)';
  line(`        ledger: ${trail}`);
  line();
  return r;
}

(async () => {
  rule();
  line('GOVERNED OUTBOUND DISPATCH — SUPPLIER FOLLOW-UP, DRY RUN');
  line('Spec A milestone 5 · mocked transport · no database · no network · no credential');
  rule();
  line();
  line('  The workflow: a CPHI exhibitor follow-up to a supplier contact. Before milestone 5 this');
  line('  path was: own ledger attempt → kill switch → Gmail send, with no approval boundary and');
  line('  no digest binding. It is one of the two senders that reached 25 real people between');
  line('  3 and 10 November. Every attempt below goes through dispatch() instead.');
  line();

  // The message the agent built. `raw` is what actually goes on the wire.
  const message = {
    to: BUYER,
    subject: 'Re: CPHI Milan — API supply follow-up',
    html: '<p>Following up on our conversation at stand 4C-21 regarding paracetamol API supply.</p>',
    mailbox: 'naren@abiozen.com',
    raw: 'UkVBTC1SRkM4MjItQllURVMtRk9SLVRIRS1XSVJF',
  };
  const digest = D.transmittedDigest(message);

  line('── 1. WHAT THE MIGRATED AGENT DOES TODAY, WITH NO APPROVAL PATH ─────────────');
  line();
  await scenario('no approvalId, no digest', {
    call: { message, transport: 'gmail_cphi', idempotencyKey: 'cphi:4821:step2',
      workflow: 'cphi-followup', agent: 'cphi-runner' },
    expectSends: 0, expectOk: false,
  });
  line('     This is the current production state of this sender, and it is the correct one.');
  line('     Approval is MANDATORY for an external recipient — not checked when supplied.');
  line();

  line('── 2. THE FIVE REFUSALS ─────────────────────────────────────────────────────');
  line();
  await scenario('a STOP is in force', {
    call: { message, transport: 'gmail_cphi', idempotencyKey: 'cphi:4821:step2',
      approvalId: 'apv-4821', expectedDigest: digest },
    gate: gateStopping, expectSends: 0, expectOk: false,
  });

  await scenario('the body was altered after approval', {
    call: { message: { ...message, raw: 'VEFNUEVSRUQtQllURVM' }, transport: 'gmail_cphi',
      idempotencyKey: 'cphi:4821:step2', approvalId: 'apv-4821', expectedDigest: digest },
    expectSends: 0, expectOk: false,
  });

  await scenario('the recipient was swapped after approval', {
    call: { message: { ...message, to: 'someone-else@elsewhere.test' }, transport: 'gmail_cphi',
      idempotencyKey: 'cphi:4821:step2', approvalId: 'apv-4821', expectedDigest: digest },
    expectSends: 0, expectOk: false,
  });

  await scenario('this key already claimed responsibility', {
    call: { message, transport: 'gmail_cphi', idempotencyKey: 'cphi:4821:step2',
      approvalId: 'apv-4821', expectedDigest: digest },
    ledger: mockLedger({ priorClaim: { id: 'att-earlier', outcome: 'PROVIDER_ACCEPTED' } }),
    expectSends: 0, expectOk: false,
  });

  await scenario('an unregistered transport', {
    call: { message, transport: 'smtp-direct', idempotencyKey: 'cphi:4821:step2',
      approvalId: 'apv-4821', expectedDigest: digest },
    expectSends: 0, expectOk: false,
  });

  line('── 3. THE ONE PATH THAT IS PERMITTED ────────────────────────────────────────');
  line();
  await scenario('approved, digest matches, no STOP', {
    call: { message, transport: 'gmail_cphi', idempotencyKey: 'cphi:4821:step2',
      approvalId: 'apv-4821', expectedDigest: digest,
      workflow: 'cphi-followup', agent: 'cphi-runner' },
    expectSends: 1, expectOk: true,
  });
  line('     CLAIMED before the provider call, PROVIDER_ACCEPTED after. A crash between the two');
  line('     leaves a row saying an attempt was made and its outcome is unknown — which is the');
  line('     truth, and is what stops the next run reading "never attempted" and sending again.');
  line();

  line('── 4. AND THE CHANNEL THAT MUST KEEP WORKING ────────────────────────────────');
  line();
  await scenario('internal recipient, no approval needed', {
    call: { message: { ...message, to: OPS }, transport: 'gmail_cphi',
      idempotencyKey: 'ops:digest:2026-11-13' },
    expectSends: 1, expectOk: true,
  });
  line('     If approval were required for everything, the operator alerts and the 6pm scores');
  line('     would be dead and this boundary would be switched off within a week.');
  line();

  rule();
  if (fail) {
    line(`FAIL  ${fail} scenario(s) did not behave as stated. The boundary is NOT as described.`);
    process.exit(1);
  }
  line('PASS  7 scenarios · 5 refusals at 0 provider calls · 2 permitted at 1 each.');
  line('      Nothing was sent: the transport is a counter and the process holds no credential.');
  rule();
  process.exit(0);
})().catch((e) => {
  console.error(`\nFAILED: ${(e && e.stack) || e}`);
  process.exit(1);
});
