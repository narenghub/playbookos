// ── THE NEGATIVE CONTROLS FOR THE OUTBOUND SCANNER ──────────────────────────
//
// Milestone 1. Every assertion here that matters is a bypass that MUST fail. A scanner is only
// worth its runtime if somebody has proven it goes red, and this repository has twice shipped a
// check that was green over the thing it was written to catch.
//
// Positive assertions are included too, and one of them — `POST /messages/{id}/modify` must PASS —
// carries as much weight as the negatives. A control that blocks the legitimate work it governs is
// a control that gets switched off, and then nothing is enforced at all.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AL = require('./outbound-endpoint-allowlist');
const COV = require('./check-email-transport-coverage');
const DEP = require('./check-dependency-additions');

const SCANNER = path.join(__dirname, 'check-email-transport-coverage.js');

/** A throwaway tree with one planted module, scanned in isolation. */
function planted(filename, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, filename), source);
  return { dir, src };
}

function runScanner(env = {}) {
  const r = require('child_process').spawnSync(process.execPath, [SCANNER], {
    env: { ...process.env, ...env }, encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ══ SKELETON DERIVATION ═══════════════════════════════════════════════════

test('a plain literal becomes its own skeleton', () => {
  assert.deepStrictEqual(AL.skeletonOf("'/labels'"), { skeleton: '/labels', classifiable: true });
});

test('an interpolation becomes one placeholder', () => {
  const r = AL.skeletonOf('`/messages/${msg.id}/modify`');
  assert.strictEqual(r.skeleton, '/messages/{}/modify');
  assert.strictEqual(r.classifiable, true);
});

test('the query string is not part of the endpoint identity', () => {
  assert.strictEqual(AL.skeletonOf('`/messages/${ref.id}?format=full`').skeleton, '/messages/{}');
  assert.strictEqual(AL.skeletonOf('`/messages?q=${q}&maxResults=${n}`').skeleton, '/messages');
});

test('nested braces inside an interpolation collapse to ONE placeholder', () => {
  // `${encodeURIComponent({a:1}.a)}` must not produce two placeholders or an unbalanced read.
  const r = AL.skeletonOf('`/messages/${fn({ a: 1 })}/modify`');
  assert.strictEqual(r.skeleton, '/messages/{}/modify');
});

// ══ FAIL CLOSED — THE LOAD-BEARING RULE ═══════════════════════════════════

test('an opaque identifier is UNCLASSIFIABLE, not approved', () => {
  const r = AL.skeletonOf('path');
  assert.strictEqual(r.classifiable, false);
  assert.strictEqual(r.skeleton, null);
  assert.strictEqual(AL.matchEndpoint({ provider: 'gmail-rest', method: 'GET', skeleton: r.skeleton }), null);
});

test('a function call is UNCLASSIFIABLE, not approved', () => {
  const r = AL.skeletonOf('buildPath(x)');
  assert.strictEqual(r.classifiable, false);
  assert.strictEqual(AL.matchEndpoint({ provider: 'gmail-rest', method: 'POST', skeleton: r.skeleton }), null);
});

test('a concatenation is UNCLASSIFIABLE, not approved', () => {
  const r = AL.skeletonOf("'/messages/' + verb");
  assert.strictEqual(r.classifiable, false);
});

test('an empty expression is UNCLASSIFIABLE', () => {
  assert.strictEqual(AL.skeletonOf('').classifiable, false);
  assert.strictEqual(AL.skeletonOf(null).classifiable, false);
});

// ══ THE ALLOWLIST ═════════════════════════════════════════════════════════

test('POST /messages/{id}/modify is APPROVED — legitimate work must not be blocked', () => {
  const e = AL.matchEndpoint({ provider: 'gmail-rest', method: 'POST', skeleton: '/messages/{}/modify' });
  assert.ok(e, 'labelling a message is the triage cron\'s job and must remain permitted');
});

test('every approved template in the allowlist matches its own normalised skeleton', () => {
  for (const e of AL.ALLOWLIST) {
    const hit = AL.matchEndpoint({
      provider: e.provider, method: e.method, skeleton: AL.normaliseTemplate(e.template),
    });
    assert.ok(hit, `${e.method} ${e.template} does not match itself`);
  }
});

test('the send endpoints are NOT in the allowlist', () => {
  for (const [method, skeleton] of [
    ['POST', '/messages/send'], ['POST', '/drafts/send'], ['POST', '/drafts/{}/send'],
    ['POST', '/messages/import'], ['POST', '/messages/insert'],
  ]) {
    assert.strictEqual(
      AL.matchEndpoint({ provider: 'gmail-rest', method, skeleton }), null,
      `${method} ${skeleton} must never be approved`,
    );
  }
});

test('METHOD is part of the key — GET /messages/{id} is approved, POST is not', () => {
  assert.ok(AL.matchEndpoint({ provider: 'gmail-rest', method: 'GET', skeleton: '/messages/{}' }));
  assert.strictEqual(
    AL.matchEndpoint({ provider: 'gmail-rest', method: 'POST', skeleton: '/messages/{}' }), null,
    "this is what stops '/messages/' + verb: there is no POST /messages/{id}",
  );
});

// ══ THE MODULE AXIS ═══════════════════════════════════════════════════════

test('an approved shape is approved for the PERMITTED module', () => {
  assert.ok(AL.matchEndpoint({
    provider: 'gmail-rest', method: 'POST', skeleton: '/drafts',
    file: 'src/lib/agents/inquiry-triage.js',
  }), 'the triage cron drafts by owner decision 2026-11-09');
});

test('the SAME shape is refused to a DIFFERENT module', () => {
  assert.strictEqual(AL.matchEndpoint({
    provider: 'gmail-rest', method: 'POST', skeleton: '/drafts',
    file: 'src/lib/agents/some-new-agent.js',
  }), null, 'drafting is not a capability every future agent inherits');
});

test('the refusal reason distinguishes an unknown shape from an unpermitted module', () => {
  assert.strictEqual(AL.refusalReason({
    provider: 'gmail-rest', method: 'POST', skeleton: '/drafts',
    file: 'src/lib/agents/other.js',
  }), 'module-not-permitted');
  assert.strictEqual(AL.refusalReason({
    provider: 'gmail-rest', method: 'POST', skeleton: '/messages/send',
    file: 'src/lib/agents/inquiry-triage.js',
  }), 'shape-not-in-allowlist');
  assert.strictEqual(AL.refusalReason({
    provider: 'gmail-rest', method: 'POST', skeleton: null,
    file: 'src/lib/agents/inquiry-triage.js',
  }), 'unclassifiable');
});

test('every allowlist entry names at least one permitted module', () => {
  for (const e of AL.ALLOWLIST) {
    assert.ok(Array.isArray(e.modules) && e.modules.length,
      `${e.method} ${e.template} permits no module — an entry nobody may use is dead, and an`
      + ' entry everybody may use is not a permission');
  }
});

// ══ FINGERPRINTS ══════════════════════════════════════════════════════════

test('a fingerprint ignores whitespace and is stable across unrelated edits', () => {
  const a = AL.fingerprint({ file: 'src/x.js', enclosing: 'run', expression: "gapi('/labels')" });
  const b = AL.fingerprint({ file: 'src/x.js', enclosing: 'run', expression: "gapi(  '/labels'  )" });
  assert.strictEqual(a, b, 'adding a comment or reformatting must not invalidate a baseline entry');
});

test('moving a call to a different function CHANGES its fingerprint', () => {
  const a = AL.fingerprint({ file: 'src/x.js', enclosing: 'run', expression: "gapi('/labels')" });
  const b = AL.fingerprint({ file: 'src/x.js', enclosing: 'other', expression: "gapi('/labels')" });
  assert.notStrictEqual(a, b, 'it is no longer the same call site');
});

test('a fingerprint is not a line number', () => {
  const f = AL.fingerprint({ file: 'src/x.js', enclosing: 'run', expression: "gapi('/labels')" });
  assert.match(f, /^[0-9a-f]{32}$/);
});

// ══ DISCOVERY ON PLANTED TREES ════════════════════════════════════════════

test('a planted REST send path is discovered and refused', () => {
  const { dir, src } = planted('rogue.js', `
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users';
async function gapi(p, { method = 'GET' } = {}) {
  return fetch(\`\${GMAIL}/me\${p}\`, { method });
}
async function go() { await gapi('/messages/send', { method: 'POST' }); }
module.exports = { go };
`);
  const sites = COV.discoverRest(src);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(sites.length, 1, 'the planted call site was not discovered');
  assert.strictEqual(sites[0].skeleton, '/messages/send');
  assert.strictEqual(sites[0].approved, false, 'a send endpoint was approved');
});

test('a planted DYNAMIC send path fails closed', () => {
  const { dir, src } = planted('rogue2.js', `
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users';
async function gapi(p, { method = 'GET' } = {}) {
  return fetch(\`\${GMAIL}/me\${p}\`, { method });
}
async function go(verb) { await gapi('/messages/' + verb, { method: 'POST' }); }
module.exports = { go };
`);
  const sites = COV.discoverRest(src);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(sites.length, 1);
  assert.strictEqual(sites[0].classifiable, false, 'a concatenated path must be unclassifiable');
  assert.strictEqual(sites[0].approved, false, 'unclassifiable must NOT be approved');
});

test('a planted OPAQUE path fails closed', () => {
  const { dir, src } = planted('rogue3.js', `
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users';
async function gapi(p, o) { return fetch(\`\${GMAIL}/me\${p}\`, o); }
async function go(p, o) { await gapi(p, o); }
module.exports = { go };
`);
  const sites = COV.discoverRest(src);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(sites.length, 1);
  assert.strictEqual(sites[0].classifiable, false);
  assert.strictEqual(sites[0].approved, false);
});

test('a planted LEGITIMATE dynamic path is approved — the over-restriction guard', () => {
  const { dir, src } = planted('ok.js', `
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users';
async function gapi(p, { method = 'GET' } = {}) { return fetch(\`\${GMAIL}/me\${p}\`, { method }); }
async function go(id) { await gapi(\`/messages/\${id}/modify\`, { method: 'POST' }); }
module.exports = { go };
`);
  const sites = COV.discoverRest(src);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(sites.length, 1);
  assert.strictEqual(sites[0].skeleton, '/messages/{}/modify',
    'a dynamic resource id must reduce to an approved SHAPE, not be rejected for being dynamic');
  // Both axes, in one assertion each. The SHAPE is approved — that is the over-restriction guard,
  // and it is why `/messages/{id}/modify` is not collateral damage of the send controls. The
  // planted module is still refused, because approval is per-module and this is not the module.
  assert.ok(AL.matchEndpoint({ provider: 'gmail-rest', method: 'POST', skeleton: sites[0].skeleton }),
    'labelling a message must remain a permitted shape');
  assert.strictEqual(sites[0].approved, false);
  assert.strictEqual(sites[0].reason, 'module-not-permitted',
    'refused for the module, not for the shape');
});

test('a send path inside a COMMENT or a STRING is not discovered as a call site', () => {
  const { dir, src } = planted('quiet.js', `
// await gapi('/messages/send', { method: 'POST' });
const doc = "gapi('/messages/send')";
module.exports = { doc };
`);
  const sites = COV.discoverRest(src);
  const sdk = COV.discover(src);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(sites.length, 0, 'a commented or quoted path is not a transmission');
  assert.strictEqual(sdk.length, 0);
});

test('a planted SDK send is discovered and is not approval-bound', () => {
  const { dir, src } = planted('sdk.js', `
async function go(g) { await g.gmail.users.messages.send({ userId: 'me' }); }
module.exports = { go };
`);
  const sites = COV.discover(src);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(sites.length, 1);
  assert.strictEqual(sites[0].approvalBound, false);
  assert.strictEqual(sites[0].gated, false);
});

test('nodemailer is discovered as a transport', () => {
  const { dir, src } = planted('smtp.js', `
const nodemailer = require('nodemailer');
async function go() { const t = nodemailer.createTransport({}); await t.sendMail({}); }
module.exports = { go };
`);
  const sites = COV.discover(src);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(sites.length >= 1, 'an SMTP transport must be visible');
  assert.ok(sites.every((s) => !s.approvalBound));
});

// ══ THE REAL TREE ═════════════════════════════════════════════════════════

test('the real tree: every REST endpoint in inquiry-triage.js is approved', () => {
  const sites = COV.discoverRest();
  const triage = sites.filter((s) => s.file === 'src/lib/agents/inquiry-triage.js');
  assert.ok(triage.length >= 6, `expected the triage REST calls, found ${triage.length}`);
  for (const s of triage) {
    assert.strictEqual(s.approved, true, `${s.method} ${s.skeleton} is not approved`);
  }
});

test('the real tree: the three known violations are exactly the unapproved SDK sites', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'outbound-known-violations.json'), 'utf8'));
  const unapproved = COV.discover().filter((s) => !s.approvalBound && !s.exception);
  assert.strictEqual(unapproved.length, baseline.length);
  const fps = new Set(baseline.map((b) => b.fingerprint));
  for (const s of unapproved) {
    assert.ok(fps.has(s.fingerprint), `${s.file}:${s.line} is not in the baseline`);
  }
});

test('the baseline records violations, not exceptions', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'outbound-known-violations.json'), 'utf8'));
  for (const b of baseline) {
    assert.ok(b.violation, 'every entry states what is WRONG');
    assert.ok(b.fix_in, 'every entry states where it gets fixed');
    assert.ok(b.reason && b.reason.length > 20, 'every entry carries a written reason');
  }
});

// ══ THE RATCHET ═══════════════════════════════════════════════════════════

test('a FOURTH baseline entry fails CI, even with a valid-looking fingerprint', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'outbound-known-violations.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
  const f = path.join(dir, 'planted.json');
  fs.writeFileSync(f, JSON.stringify([...real, {
    fingerprint: 'ffffffffffffffffffffffffffffffff',
    file: 'src/lib/agents/some-new-agent.js',
    violation: 'no-approval-boundary',
    reason: 'planted by the negative control to prove the ratchet turns one way only',
    fix_in: 'nowhere — this entry is a test fixture',
  }], null, 2));
  const r = runScanner({ OUTBOUND_BASELINE_FILE: f });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notStrictEqual(r.code, 0, 'a fourth violation passed CI');
  assert.match(r.out, /MAX_KNOWN_VIOLATIONS permits 3|pinned digest/);
});

test('a planted baseline fails the pinned digest even when the count is unchanged', () => {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'outbound-known-violations.json'), 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
  const f = path.join(dir, 'planted.json');
  // Same three entries, one reason quietly softened. Count unchanged, digest changed.
  const edited = JSON.parse(JSON.stringify(real));
  edited[0].reason = 'nothing to see here';
  fs.writeFileSync(f, JSON.stringify(edited, null, 2));
  const r = runScanner({ OUTBOUND_BASELINE_FILE: f });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notStrictEqual(r.code, 0, 'an edited baseline passed CI');
  assert.match(r.out, /pinned digest was not updated/);
});

test('an EMPTY baseline fails as stale rather than passing as clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-'));
  const f = path.join(dir, 'empty.json');
  fs.writeFileSync(f, '[]');
  const r = runScanner({ OUTBOUND_BASELINE_FILE: f });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /NEW outbound path/,
    'emptying the baseline must surface the violations, not hide them');
});

// ══ THE DEPENDENCY GATE ═══════════════════════════════════════════════════

test('an unreviewed dependency is reported as added', () => {
  const { added } = DEP.diffAgainstReviewed(['express', 'some-email-sdk'], { express: 'HTTP server' });
  assert.deepStrictEqual(added, ['some-email-sdk']);
});

test('every mail-capable dependency is labelled as such in the reviewed set', () => {
  for (const name of ['googleapis', 'resend', 'nodemailer']) {
    assert.match(DEP.REVIEWED[name] || '', /^MAIL-CAPABLE/,
      `${name} can reach a mail provider and its note must say so`);
  }
});

test('the reviewed set describes the package.json that exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const { added } = DEP.diffAgainstReviewed(DEP.declaredDependencies(pkg));
  assert.deepStrictEqual(added, [], 'an unreviewed dependency is declared');
});

// ══ ONE SOURCE OF TRUTH ═══════════════════════════════════════════════════

test('the scanner carries no second copy of the allowlist', () => {
  const src = fs.readFileSync(SCANNER, 'utf8');
  const code = COV.blankNonCode(src);
  assert.ok(/require\(.\.\/outbound-endpoint-allowlist.\)/.test(src),
    'the scanner must read the shared allowlist module');
  assert.ok(!/\/messages\/\{id\}\/modify/.test(code),
    'an endpoint template appears in the scanner as code — there must be only one copy');
});

test('the scanner contacts no provider', () => {
  const src = COV.blankNonCode(fs.readFileSync(SCANNER, 'utf8'));
  for (const forbidden of ['fetch(', 'https.request', 'http.request', 'axios']) {
    assert.ok(!src.includes(forbidden), `the scanner references ${forbidden}`);
  }
});
