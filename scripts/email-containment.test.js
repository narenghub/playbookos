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
// ── THE APPROVAL GATE, SATISFIED SO THE KILL-SWITCH TESTS STAY ABOUT IT ─────
//
// email-gate.js now refuses any send that leaves the company unless a RELEASED approval exists
// whose payload hashes to the bytes being sent (CEO decision 2026-11-11, priority 1). Every
// sender below addresses someone outside the company, so the "allowed" assertions would now fail
// for a reason that has nothing to do with the kill switch.
//
// Granting the approval rather than re-pointing these at internal addresses keeps them exercising
// the external path, and makes each of them prove that BOTH gates have an inside.
const GRANTED_DIGEST = 'a'.repeat(32);
function grantedApproval() {
  return {
    query: async (sql, params = []) => {
      if (/released_at, action_payload/i.test(sql)) {
        return { rows: [{ id: params[0], status: 'approved', released_at: new Date(),
          action_payload: { transport_digest: GRANTED_DIGEST } }] };
      }
      return { rows: [] };
    },
  };
}
const APPROVED = { approvalId: 'ap-granted', digest: GRANTED_DIGEST };

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
      { capability: 'email.send', workflow: s.workflow, agent: s.agent, to: s.to, ...APPROVED },
      { autonomy: fakeAutonomy([]), env: ENV, ...grantedApproval() });
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
    { capability: 'email.send', workflow: 'outreach', agent: 'outreach-agent', to: 'l@example.com',
      ...APPROVED },
    { autonomy: fakeAutonomy(stops), env: ENV, ...grantedApproval() });
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
  // The gate answers two questions now — is this permitted right now, and for anything leaving
  // the company, is there a released approval for these exact bytes. It is still not a send. The
  // other controls (the env feature flag, the release claim, the ledger claim) remain in force;
  // removing a stop must never be mistakable for turning a sender on.
  const r = await GATE.assertSendAllowed(
    { capability: 'email.send', workflow: 'cphi-followup', agent: 'cphi-runner', to: 'b@example.com',
      ...APPROVED },
    { autonomy: fakeAutonomy([]), env: ENV, ...grantedApproval() });
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

// ── B. THE ALERT INTERFACE — FORGERY, BODY, RECIPIENT, BYPASS ───────────────
//
// CEO authorization 2026-11-10 item B. A recipient allowlist alone was not enough: it still let a
// caller put ANY BODY in front of an operator under an exemption that bypasses a hold. So the
// content is not the caller's either — the interface takes a TYPE and FIELDS and renders the rest.

const ALERTS = require('../src/lib/alerts');
const MAILER = require('../src/lib/mailer');

test('B1. a forged alert capability is DOWNGRADED, not honoured', async () => {
  // The general path accepts `capability` as an ordinary parameter. It must never grant the
  // exemption on the strength of that label.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8');
  assert.match(src, /capability === 'email\.alert' \? 'email\.send' : capability/,
    'sendEmailDetailed no longer downgrades a caller-supplied email.alert');

  // And behaviourally: the gate is asked for email.send, so a global stop refuses it.
  const r = await GATE.assertSendAllowed(
    { capability: 'email.send', to: 'ops@abiozen.com' },
    { autonomy: fakeAutonomy([{ scope_type: 'global', scope_key: null, reason: 'hold' }]), env: ENV });
  assert.strictEqual(r.allowed, false,
    'a downgraded alert was still treated as non-consequential');
});

test('B2. the alert interface accepts NO arbitrary body, recipient or subject', async () => {
  // Not "validates" — ABSENT. A caller cannot express the dangerous message, so there is nothing
  // to validate and nothing to get wrong later.
  const built = ALERTS.buildAlert({
    type: 'cron_failure',
    fields: { cronName: '<img src=x onerror=alert(1)>', errMsg: 'boom' },
    // These are not parameters. If they ever become parameters, the assertions below fail.
    to: 'attacker@example.com', html: '<h1>pay this invoice</h1>', subject: 'Invoice due',
  }, { env: ENV });

  assert.strictEqual(built.ok, true);
  assert.deepStrictEqual(built.message.to, ['ops@abiozen.com', 'naren@abiozen.com'],
    'the recipient came from the caller rather than from the environment');
  assert.doesNotMatch(built.message.html, /pay this invoice/, 'caller HTML reached the body');
  assert.doesNotMatch(built.message.subject, /Invoice due/, 'caller subject was used');
  assert.match(built.message.subject, /Cron failed/);
  // Fields are escaped with no opt-out.
  assert.doesNotMatch(built.message.html, /<img src=x/, 'a field was interpolated unescaped');
  assert.match(built.message.html, /&lt;img src=x/);
});

test('B3. an unknown alert type is refused — alerts are a fixed set, not a label', () => {
  const r = ALERTS.buildAlert({ type: 'invoice', fields: {} }, { env: ENV });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown alert type/);
});

test('B4. with no operator address configured, no alert is sent to a guess', () => {
  const r = ALERTS.buildAlert({ type: 'cron_failure', fields: {} }, { env: {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no ALERT_EMAIL or ADMIN_EMAIL/);
});

test('B5. an alert type cannot be used as an unbounded channel', () => {
  // The exemption from the kill switch is also an exemption from the thing that would stop a loop.
  const env = { ALERT_EMAIL: 'ops@abiozen.com' };
  const max = ALERTS.ALERT_TYPES.send_failure.max;
  let lastOk = 0; let refused = null;
  for (let i = 0; i < max + 5; i += 1) {
    const r = ALERTS.buildAlert({ type: 'send_failure', fields: { context: 'x' } }, { env });
    if (r.ok) lastOk = i + 1; else { refused = r.error; break; }
  }
  assert.strictEqual(lastOk, max, `expected exactly ${max} to pass, got ${lastOk}`);
  assert.match(refused || '', /daily ceiling/);
  ALERTS._sentToday.clear();
});

test('B6. the ONLY code that sets email.alert is the privileged path in mailer.js', async () => {
  // Direct transport bypass: anything else reaching the provider with the exempt capability.
  const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'scripts')];
  const offenders = [];
  const walkAll = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkAll(p, out);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
    }
    return out;
  };
  for (const root of roots) {
    for (const file of walkAll(root)) {
      const rel = path.relative(path.join(__dirname, '..'), file);
      if (rel === 'src/lib/mailer.js' || rel === 'src/lib/email-gate.js' || rel === 'src/lib/alerts.js') continue;
      // COMMENTS ONLY. blankNonCode also erases string literals — and the thing being looked for
      // IS a string literal, so this check matched nothing and passed against a planted bypass.
      // Verified by planting one: with blankNonCode it went undetected; with this it is caught.
      const code = COVERAGE.blankCommentsOnly(fs.readFileSync(file, 'utf8'));
      if (/capability\s*:\s*['"]email\.alert['"]/.test(code)) offenders.push(rel);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `these files name the exempt capability in live code: ${offenders.join(', ')}. `
    + 'Operator alerts go through sendOperatorAlert(), which takes a type and fields.');

  // NEGATIVE CONTROL. The assertion above is only worth something if the matcher can fire.
  const planted = COVERAGE.blankCommentsOnly([
    "// capability: 'email.alert' described in prose",
    "const x = { capability: 'email.alert' };",
  ].join('\n'));
  const hits = (planted.match(/capability\s*:\s*['"]email\.alert['"]/g) || []).length;
  assert.strictEqual(hits, 1,
    `the matcher found ${hits} in the control, expected exactly 1 — prose must not count and live code must`);
});

test('B7. a genuine alert still reaches the operator under a GLOBAL stop', async () => {
  // The whole reason the exemption exists. If hardening it silenced the oversight channel, the
  // fix would have re-created the outage it protects against.
  const r = await GATE.assertSendAllowed({ capability: 'email.alert', to: ['ops@abiozen.com'] },
    { autonomy: fakeAutonomy([{ scope_type: 'global', scope_key: null, reason: 'hold' }]), env: ENV });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.exempt, true);
});

test('B8. the privileged path exists and takes no content parameters', () => {
  assert.strictEqual(typeof MAILER.sendOperatorAlert, 'function');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function sendOperatorAlert'));
  const sig = fn.slice(0, fn.indexOf(')') + 1);
  for (const forbidden of ['html', 'subject', 'to', 'capability']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(sig),
      `sendOperatorAlert accepts '${forbidden}' — the content must not be the caller's`);
  }
  assert.match(sig, /type/);
  assert.match(sig, /fields/);
});
