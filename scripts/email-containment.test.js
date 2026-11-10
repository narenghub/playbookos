// ── S1 CONTAINMENT: THE NEGATIVE CONTROLS ────────────────────────────────────
//
//   node --test scripts/email-containment.test.js
//
// CEO authorization of 2026-11-10 names eight controls. Each has a test below, and each is written
// so that it FAILS if the protection is removed — a test that passes whether or not the guard
// exists is the thing this project keeps finding in its own history.
//
// MOCKED TRANSPORTS ONLY. No provider is contacted. The assertion is always "how many times was
// the transport invoked", because that is the only question that matters about containment: not
// what was returned, not what was logged, but whether anything left.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'preflight';

const GATE = require('../src/lib/email-gate');
const COVERAGE = require('./check-email-transport-coverage');

// A fake kill switch. `stops` is a list of scope objects; the first that matches wins, exactly as
// the real matcher behaves for the cases under test.
function fakeAutonomy(stops = [], { throws = false } = {}) {
  const seen = [];
  return {
    seen,
    checkStopped: async (scopes, opts) => {
      if (throws) throw new Error('database unreachable');
      seen.push({ scopes, opts });
      for (const s of stops) {
        if (s.scope_type === 'global') {
          // A global stop does not reach a NON-consequential call — that is the observability rule,
          // and it is the real matcher's behaviour, reproduced here rather than assumed.
          if (opts && opts.consequential === false) continue;
          return s;
        }
        if (s.scope_type === 'capability' && s.scope_key === scopes.capability) return s;
        if (s.scope_type === 'workflow' && s.scope_key === scopes.workflow) return s;
        if (s.scope_type === 'agent' && s.scope_key === scopes.agent) return s;
      }
      return null;
    },
    recordRefusal: () => {},
  };
}

const ENV = { ALERT_EMAIL: 'ops@abiozen.com', ADMIN_EMAIL: 'naren@abiozen.com' };
const SENDERS = [
  { agent: 'cphi-runner', workflow: 'cphi-followup', to: 'buyer@example.com' },
  { agent: 'outreach-agent', workflow: 'outreach', to: 'lead@example.com' },
  { agent: 'procurement-agent', workflow: 'rfq', to: 'supplier@example.com' },
  { agent: 'inquiry-agent', workflow: 'inquiry', to: 'customer@example.com' },
];

// ── 1. A GLOBAL STOP PREVENTS PROVIDER INVOCATION FROM EVERY SENDER ─────────

test('1. a global STOP refuses every discovered sender', async () => {
  const stops = [{ scope_type: 'global', scope_key: null, reason: 'CEO hold' }];
  for (const s of SENDERS) {
    const r = await GATE.assertSendAllowed(
      { capability: 'email.send', workflow: s.workflow, agent: s.agent, to: s.to },
      { autonomy: fakeAutonomy(stops), env: ENV });
    assert.strictEqual(r.allowed, false, `${s.agent} was allowed through a GLOBAL stop`);
    assert.match(r.reason, /STOPPED_BY_POLICY: global/);
  }
});

test('1b. with no stop, every sender is allowed — the control is not "always false"', async () => {
  // Without this, test 1 would pass against a gate hardwired to refuse, and the whole suite would
  // be proving nothing while looking thorough.
  for (const s of SENDERS) {
    const r = await GATE.assertSendAllowed(
      { capability: 'email.send', workflow: s.workflow, agent: s.agent, to: s.to },
      { autonomy: fakeAutonomy([]), env: ENV });
    assert.strictEqual(r.allowed, true, `${s.agent} was refused with no stop in force`);
  }
});

// ── 2 & 3. WORKFLOW SCOPING CUTS WHERE IT IS AIMED, AND NOWHERE ELSE ────────

test('2. a workflow STOP refuses that workflow', async () => {
  const stops = [{ scope_type: 'workflow', scope_key: 'cphi-followup', reason: 'pause CPHI' }];
  const r = await GATE.assertSendAllowed(
    { capability: 'email.send', workflow: 'cphi-followup', agent: 'cphi-runner', to: 'b@example.com' },
    { autonomy: fakeAutonomy(stops), env: ENV });
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /workflow:cphi-followup/);
});

test('3. an unrelated workflow STOP does NOT block a permitted workflow', async () => {
  // The reason workflow scoping was added at all: containing one sender used to mean silencing the
  // 6pm scores, the briefings and the team tasks with it.
  const stops = [{ scope_type: 'workflow', scope_key: 'cphi-followup', reason: 'pause CPHI' }];
  const r = await GATE.assertSendAllowed(
    { capability: 'email.send', workflow: 'outreach', agent: 'outreach-agent', to: 'l@example.com' },
    { autonomy: fakeAutonomy(stops), env: ENV });
  assert.strictEqual(r.allowed, true, 'a stop aimed at CPHI also blocked outreach');
});

test('3b. an undeclared workflow is still covered by capability and global scopes', async () => {
  const cap = [{ scope_type: 'capability', scope_key: 'email.send', reason: 'all mail' }];
  const r = await GATE.assertSendAllowed({ capability: 'email.send', to: 'x@example.com' },
    { autonomy: fakeAutonomy(cap), env: ENV });
  assert.strictEqual(r.allowed, false, 'a send declaring no workflow escaped a capability stop');
});

// ── 4. AN UNREADABLE KILL SWITCH BLOCKS TRANSMISSION ────────────────────────

test('4. if the STOP state cannot be read, the send is REFUSED', async () => {
  // Fail-closed, per the CEO authorization. This inverts the previous behaviour, where an
  // unreadable kill state let ordinary mail through — a brake of unknown condition was treated as
  // a working brake.
  const r = await GATE.assertSendAllowed(
    { capability: 'email.send', workflow: 'outreach', agent: 'outreach-agent', to: 'l@example.com' },
    { autonomy: fakeAutonomy([], { throws: true }), env: ENV });
  assert.strictEqual(r.allowed, false, 'an unreadable kill switch permitted an external send');
  assert.match(r.reason, /AUTHORIZATION_UNDETERMINED/);
  assert.match(r.reason, /database unreachable/, 'the reason does not carry the underlying failure');
});

// ── 5. LIFTING THE STOP IS NOT, BY ITSELF, AUTHORIZATION ────────────────────

test('5. an allowed gate result does not transmit anything on its own', async () => {
  // The gate answers one question — is this permitted right now. It is not a send, and it is not
  // approval. The other controls (the env feature flag, the approval record, the release claim)
  // remain in force; removing a stop must never be mistakable for turning a sender on.
  const r = await GATE.assertSendAllowed(
    { capability: 'email.send', workflow: 'cphi-followup', agent: 'cphi-runner', to: 'b@example.com' },
    { autonomy: fakeAutonomy([]), env: ENV });
  assert.strictEqual(r.allowed, true);

  for (const k of Object.keys(GATE)) {
    assert.ok(!/^(send|transmit|deliver|dispatch|release|enable|resume)/i.test(k),
      `email-gate exports ${k} — the authorization module must not also be able to send`);
  }

  // And the senders still read their own feature flag: the gate did not replace it.
  for (const f of ['src/lib/campaigns/cphi-runner.js', 'src/lib/agents/outreach-agent.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /const EXECUTE = !!opts\.execute;/,
      `${f} no longer has its own execute flag — the kill switch REPLACED a control instead of adding one`);
  }
});

// ── 8. AN ORDINARY MESSAGE CANNOT RELABEL ITSELF AS AN ALERT ────────────────

test('8. email.alert to an arbitrary recipient is treated as an ordinary send, and stopped', async () => {
  // The exemption was documented as narrow and enforced nowhere: `capability` is an ordinary
  // parameter, so any caller could pass 'email.alert' with any recipient and any body and transmit
  // straight through a global stop. Narrow by convention is not narrow.
  const stops = [{ scope_type: 'global', scope_key: null, reason: 'CEO hold' }];
  const r = await GATE.assertSendAllowed(
    { capability: 'email.alert', to: 'buyer@example.com' },
    { autonomy: fakeAutonomy(stops), env: ENV });
  assert.strictEqual(r.allowed, false, 'an ordinary recipient rode out under the alert exemption');
  assert.strictEqual(r.exempt, false, 'the exemption was granted to a non-operator recipient');
});

test('8b. a genuine alert to the operator address still survives a global stop', async () => {
  // The negative control for the test above. If the exemption were simply removed, test 8 would
  // pass while the oversight channel died with the database — which is the failure the exemption
  // exists to prevent, re-created by the fix for its abuse.
  const stops = [{ scope_type: 'global', scope_key: null, reason: 'CEO hold' }];
  const r = await GATE.assertSendAllowed(
    { capability: 'email.alert', to: 'ops@abiozen.com' },
    { autonomy: fakeAutonomy(stops), env: ENV });
  assert.strictEqual(r.allowed, true, 'the cron-failure channel was silenced by a global stop');
  assert.strictEqual(r.exempt, true);
});

test('8c. a mixed recipient list does not launder an ordinary recipient through an alert', async () => {
  const stops = [{ scope_type: 'global', scope_key: null, reason: 'CEO hold' }];
  const r = await GATE.assertSendAllowed(
    { capability: 'email.alert', to: ['ops@abiozen.com', 'buyer@example.com'] },
    { autonomy: fakeAutonomy(stops), env: ENV });
  assert.strictEqual(r.allowed, false, 'one operator address carried an outsider through the exemption');
});

test('8d. an explicit capability:email.alert stop still silences genuine alerts', async () => {
  const stops = [{ scope_type: 'capability', scope_key: 'email.alert', reason: 'too noisy' }];
  const r = await GATE.assertSendAllowed({ capability: 'email.alert', to: 'ops@abiozen.com' },
    { autonomy: fakeAutonomy(stops), env: ENV });
  assert.strictEqual(r.allowed, false, 'the alert channel cannot be stopped even deliberately');
});

test('8e. with no operator address configured, the exemption is not granted', async () => {
  // An alert that cannot prove where it is going is an ordinary send.
  const stops = [{ scope_type: 'global', scope_key: null, reason: 'CEO hold' }];
  const r = await GATE.assertSendAllowed({ capability: 'email.alert', to: 'ops@abiozen.com' },
    { autonomy: fakeAutonomy(stops), env: {} });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.exempt, false);
});

// ── 6 & 7. THE SCANNER DETECTS AN INTRODUCED BYPASS ─────────────────────────
//
// "A successful scanner run is insufficient unless the scanner is independently shown to detect an
// intentionally introduced bypass." These plant bypasses in a temporary tree and assert they are
// caught — the scanner is never trusted on its green result alone.

function plant(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-coverage-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

test('6. a NEW unguarded sender is detected', async () => {
  const dir = plant({
    'lib/new-agent.js': [
      "const g = require('./gmail');",
      'async function run() {',
      '  await g.gmail.users.messages.send({ userId: "me" });',
      '}',
      'module.exports = { run };',
    ].join('\n'),
  });
  try {
    const sites = COVERAGE.discover(dir);
    const ungated = sites.filter((s) => !s.gated && !s.exception);
    assert.strictEqual(ungated.length, 1, `expected one ungated site, got ${JSON.stringify(sites)}`);
    assert.match(ungated[0].file, /new-agent\.js/);
    assert.strictEqual(ungated[0].transport, 'gmail.messages.send');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('7. a DIRECT provider call that bypasses the wrapper is detected', async () => {
  // The realistic bypass: a file that imports the gate for show, or not at all, and reaches the
  // provider by a transport the list did not anticipate.
  const dir = plant({
    'lib/sneaky.js': [
      "const nodemailer = require('nodemailer');",
      'const t = nodemailer.createTransport({ host: "smtp.example.com" });',
      'async function run() { await t.sendMail({ to: "x@example.com" }); }',
      'module.exports = { run };',
    ].join('\n'),
  });
  try {
    const sites = COVERAGE.discover(dir);
    const ungated = sites.filter((s) => !s.gated && !s.exception);
    assert.ok(ungated.length >= 1, 'an SMTP transport reached a provider undetected');
    assert.ok(ungated.some((s) => s.transport === 'nodemailer'),
      `nodemailer not among ${ungated.map((s) => s.transport).join(', ')}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('6b. a GATED sender in the same shape is NOT reported — the scanner discriminates', async () => {
  // Without this, tests 6 and 7 would pass against a scanner that flags everything, and the real
  // tree would be unfixable.
  const dir = plant({
    'lib/good-agent.js': [
      "const { assertSendAllowed } = require('./email-gate');",
      'async function run(g) {',
      '  const gate = await assertSendAllowed({ capability: "email.send" });',
      '  if (!gate.allowed) return;',
      '  await g.gmail.users.messages.send({ userId: "me" });',
      '}',
      'module.exports = { run };',
    ].join('\n'),
  });
  try {
    const sites = COVERAGE.discover(dir);
    assert.strictEqual(sites.length, 1, 'the gated call site was not discovered at all');
    assert.strictEqual(sites[0].gated, true, 'a correctly gated sender was reported as ungated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('6c. a provider call hidden in a comment or a string is NOT a call site', async () => {
  const dir = plant({
    'lib/prose.js': [
      '// await g.gmail.users.messages.send({});  <- explaining the forbidden shape',
      'const doc = "call g.gmail.users.messages.send() to transmit";',
      '/* await t.sendMail({}); */',
      'module.exports = { doc };',
    ].join('\n'),
  });
  try {
    assert.deepStrictEqual(COVERAGE.discover(dir), [],
      'prose describing a transport was counted as a transport');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── THE REAL TREE ───────────────────────────────────────────────────────────

test('the live repository has no ungated transport', async () => {
  const sites = COVERAGE.discover();
  const ungated = sites.filter((s) => !s.gated && !s.exception);
  assert.deepStrictEqual(ungated.map((s) => `${s.file}:${s.line}`), []);
  assert.ok(sites.length >= 3, `only ${sites.length} site(s) discovered in src/`);

  const transports = new Set(sites.map((s) => s.transport));
  assert.ok(transports.has('gmail.messages.send'), 'the Gmail transport vanished from discovery');
  assert.ok(transports.has('resend.http'), 'the Resend transport vanished from discovery');
});
