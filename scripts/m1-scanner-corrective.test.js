// ── THE TWO SCANNER DEFECTS, DEMONSTRATED AGAINST THE ORIGINAL ───────────────
//
//   node --test scripts/m1-scanner-corrective.test.js
//
// CEO decision 2026-11-12, M1 correction item 3: "Add permanent negative controls demonstrating
// both failures against the original scanner."
//
// So the original implementations are reproduced below, VERBATIM, as fixtures. Not referenced from
// git, not paraphrased: a control that describes a defect proves nothing, and a control that reads
// the current code can only ever agree with it. Each test runs the historical code and the
// corrected code against the same input and asserts that the first is wrong and the second is
// right. If someone later reverts either fix, these go red while still demonstrating why.
//
// ── THE TWO DEFECTS ──────────────────────────────────────────────────────────
//
// 1. THE PRE-PASS DID NOT UNDERSTAND REGEX LITERALS. A quote inside
//    `/not authorized to send emails from ([^"'\s]+)/i` was read as the start of a string, so
//    everything to the next quote in the file was blanked. The consequence was not a failing
//    check: it was a PASS over code nobody had looked at. Measured, an ungated
//    `gmail.users.messages.send` placed after such a regex produced ZERO discovered call sites.
//
// 2. THE AUTHORIZATION ORDERING CHECK COMPARED POSITIONS IN FILE TEXT. `gateAt < firstCall` on
//    whole-file indexes stood in for "the gate runs first". It is wrong in both directions, and
//    the dangerous direction is demonstrated in test 3: a file containing an EXPORTED, UNGATED
//    transport passes it.
//
// MOCKED EVERYTHING. No provider, no network, no database. Nothing here is executed from the
// fixtures; they are lexed as text.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

const NEW = require('./js-lex');
const COVERAGE = require('./check-email-transport-coverage');

const GMAIL_SEND = /\.users\s*\.\s*messages\s*\.\s*send\s*\(/g;
const countSends = (code) => { GMAIL_SEND.lastIndex = 0; return (code.match(GMAIL_SEND) || []).length; };

// ═══════════════════════════════════════════════════════════════════════════
// THE ORIGINAL IMPLEMENTATIONS, REPRODUCED VERBATIM
//
// From scripts/check-email-transport-coverage.js at da057d3c. Do not "improve" these: their value
// is that they are exactly what shipped.
// ═══════════════════════════════════════════════════════════════════════════

/** The original pre-pass. Blanks comments and string/template literals — and nothing else. */
function originalBlankNonCode(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i; while (j < n && src[j] !== '\n') j += 1;
      blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      blank(i, Math.min(j + 2, n)); i = j + 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j += 1;
      }
      blank(i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * The original authorization ordering check, as a verdict. The shipped code was an inline loop
 * doing exactly this comparison and then calling ok() or bad(); this returns the branch it took.
 */
function originalGateOrdering(code) {
  const GATE = 'assertSendAllowed';
  const gateAt = code.indexOf(`${GATE}(`);
  GMAIL_SEND.lastIndex = 0;
  const m = GMAIL_SEND.exec(code);
  const firstCall = m ? m.index : Number.MAX_SAFE_INTEGER;
  if (gateAt === -1) return 'no-gate';
  return gateAt < firstCall ? 'the gate precedes the provider call' : 'a provider call appears BEFORE the gate';
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE PRE-PASS ATE CODE
// ═══════════════════════════════════════════════════════════════════════════

// The real shape, from src/lib/mailer.js, with a transport call after it.
const QUOTE_BEARING_REGEX = [
  "const g = require('./gmail');",
  'function parse(s) {',
  '  const m = /not authorized to send emails from ([^"\'\\s]+)/i.exec(s);',
  '  return m;',
  '}',
  'async function run(msg) {',
  '  await g.gmail.users.messages.send(msg);',
  '}',
  'module.exports = { run, parse };',
].join('\n');

test('1. the ORIGINAL pre-pass erases the transport call after a quote-bearing regex', () => {
  const before = originalBlankNonCode(QUOTE_BEARING_REGEX);
  assert.strictEqual(countSends(before), 0,
    'the original pre-pass no longer exhibits the defect — if this file was edited, restore the '
    + 'verbatim copy; its whole value is being exactly what shipped');
  assert.ok(!before.includes('async function run('),
    'the original pre-pass no longer erases the declaration either');
});

test('1b. and the CORRECTED lexer finds it', () => {
  const after = NEW.blankNonCode(QUOTE_BEARING_REGEX);
  assert.strictEqual(countSends(after), 1,
    'the transport call is still invisible — an ungated sender the scanner would report as absent');
  assert.ok(after.includes('async function run('), 'the declaration is still hidden');
  assert.deepStrictEqual(NEW.concernsIn(QUOTE_BEARING_REGEX), [],
    'valid input must raise no concern, or the scanner fails closed on healthy code');
});

test('1c. the whole pipeline finds the planted sender, and calls it ungated', async () => {
  // End to end through discover(), because that is what the verdict is built from. Before the fix
  // this returned an empty list and the scanner printed PASS.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-corrective-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'lib', 'hidden-sender.js'), QUOTE_BEARING_REGEX);
    const sites = COVERAGE.discover(dir);
    const site = sites.find((s) => /hidden-sender/.test(s.file));
    assert.ok(site, `the sender was not discovered at all. Sites: ${JSON.stringify(sites)}`);
    assert.strictEqual(site.transport, 'gmail.messages.send');
    assert.strictEqual(site.gated, false, 'an ungated sender must be reported as ungated');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('1d. a template interpolation holding a transport makes the scanner REFUSE, not miss it', () => {
  // A declared limitation of the lexer: interpolations are blanked with their template. So it is
  // checked rather than assumed away — the scanner reports NOT EXECUTED for such a file.
  const src = [
    "const g = require('./gmail');",
    'async function run(m) {',
    '  const log = `sent ${ await g.gmail.users.messages.send(m) }`;',
    '  return log;',
    '}',
  ].join('\n');
  const reasons = COVERAGE.unreadableReasons('lib/interp.js', src);
  assert.ok(reasons.some((r) => /template interpolation/.test(r)),
    `expected a refusal naming the interpolation, got ${JSON.stringify(reasons)}`);
});

test('1e. an unterminated literal makes the scanner refuse the file', () => {
  // The old pre-pass blanked from the opening quote to end of file and carried on scanning the
  // remains. Whatever it then concluded was about a file it had partly erased.
  const reasons = COVERAGE.unreadableReasons('lib/bad.js', "const s = 'oops;\nasync function run() {}");
  assert.ok(reasons.some((r) => /unterminated-string/.test(r)),
    `expected a refusal naming the unterminated string, got ${JSON.stringify(reasons)}`);
  assert.ok(reasons.some((r) => /does not compile/.test(r)),
    'a file that cannot be parsed by Node should also be reported as not compiling');
});

test('1f. a file that does not compile is refused, not lexed anyway', () => {
  const reasons = COVERAGE.unreadableReasons('lib/broken.js', 'function f( { return 1 }');
  assert.ok(reasons.some((r) => /does not compile/.test(r)), JSON.stringify(reasons));
});

test('1g. and a healthy file is NOT refused — the control is not "refuse everything"', () => {
  // Without this, every refusal test above would pass against a scanner that reports INCOMPLETE on
  // everything, which would be a check that never checks anything.
  assert.deepStrictEqual(COVERAGE.unreadableReasons('lib/fine.js', QUOTE_BEARING_REGEX), [],
    'a valid file was refused, so the scanner would report INCOMPLETE forever');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE ORDERING CHECK WAS FILE ORDER — FALSE POSITIVE
// ═══════════════════════════════════════════════════════════════════════════

// The shape the C-4 patch produced: the provider half extracted into a module-private helper and
// placed ABOVE the gated function. The gate still runs first, and is now unconditional.
const C4_SHAPE = [
  "const { assertSendAllowed } = require('./email-gate');",
  "const g = require('./gmail');",
  'async function deliver(msg) {',
  '  await g.gmail.users.messages.send(msg);',
  '}',
  'async function sendOne(msg) {',
  '  const gate = await assertSendAllowed({ capability: "email.send" });',
  '  if (!gate.allowed) return false;',
  '  return deliver(msg);',
  '}',
  'async function sendAlert(msg) {',
  '  const gate = await assertSendAllowed({ capability: "email.alert" });',
  '  if (!gate.allowed) return false;',
  '  return deliver(msg);',
  '}',
  'module.exports = { sendOne, sendAlert };',
].join('\n');

test('2. the ORIGINAL ordering check condemns a correctly gated file', () => {
  const verdict = originalGateOrdering(NEW.blankNonCode(C4_SHAPE));
  assert.strictEqual(verdict, 'a provider call appears BEFORE the gate',
    'the original check no longer exhibits the defect — restore the verbatim copy');
});

test('2b. and the CORRECTED check accepts it, naming both authorization paths', () => {
  const findings = COVERAGE.gateOrdering('lib/c4-shape.js', NEW.blankNonCode(C4_SHAPE));
  assert.deepStrictEqual(findings.filter((f) => !f.ok), [],
    `a correctly gated indirection was refused: ${JSON.stringify(findings.map((f) => f.message))}`);
  assert.match(findings[0].message, /all 2 caller\(s\) gate first/,
    'the finding does not confirm BOTH paths were checked — one checked path reported as all of '
    + 'them is how the original said "all 1 caller(s)" about a function with two');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE ORDERING CHECK WAS FILE ORDER — FALSE NEGATIVE
//
// The dangerous direction, and the reason this is a security defect rather than a test nuisance.
// ═══════════════════════════════════════════════════════════════════════════

const EXPORTED_UNGATED_SENDER = [
  "const { assertSendAllowed } = require('./email-gate');",
  "const g = require('./gmail');",
  'async function properSend(msg) {',
  '  const gate = await assertSendAllowed({ capability: "email.send" });',
  '  if (!gate.allowed) return false;',
  '  await g.gmail.users.messages.send(msg);',
  '}',
  'async function sneaky(msg) {',
  '  await g.gmail.users.messages.send(msg);',
  '}',
  'module.exports = { properSend, sneaky };',
].join('\n');

test('3. the ORIGINAL ordering check PASSES a file with an exported, ungated sender', () => {
  // Because it only ever looked at the FIRST provider call in the file. That one is gated, the
  // gate's index is smaller, and the check concluded the file was fine — while `sneaky` is
  // exported and transmits with no kill-switch check at all.
  const verdict = originalGateOrdering(NEW.blankNonCode(EXPORTED_UNGATED_SENDER));
  assert.strictEqual(verdict, 'the gate precedes the provider call',
    'the original check no longer exhibits the defect — restore the verbatim copy');
});

test('3b. and the CORRECTED check catches it, naming the function', () => {
  const findings = COVERAGE.gateOrdering('lib/sneaky.js', NEW.blankNonCode(EXPORTED_UNGATED_SENDER));
  const refusals = findings.filter((f) => !f.ok);
  assert.strictEqual(refusals.length, 1,
    `expected exactly one refusal, got ${JSON.stringify(findings.map((f) => f.message))}`);
  assert.match(refusals[0].message, /sneaky\(\) reaches .* without calling the gate, and is EXPORTED/);
  assert.ok(findings.some((f) => f.ok && /properSend\(\) calls the gate/.test(f.message)),
    'the gated function must still be reported as gated — a check that condemns everything is as '
    + 'useless as one that condemns nothing');
});

test('3c. an ungated caller of a private helper is caught, and named', () => {
  // The indirection is accepted only when EVERY in-file caller gates. One that does not must be
  // named, because that is what somebody has to go and fix.
  const src = [
    "const { assertSendAllowed } = require('./email-gate');",
    "const g = require('./gmail');",
    'async function deliver(msg) {',
    '  await g.gmail.users.messages.send(msg);',
    '}',
    'async function properSend(msg) {',
    '  const gate = await assertSendAllowed({ capability: "email.send" });',
    '  if (!gate.allowed) return false;',
    '  return deliver(msg);',
    '}',
    'async function sloppySend(msg) {',
    '  return deliver(msg);',
    '}',
    'module.exports = { properSend, sloppySend };',
  ].join('\n');
  const findings = COVERAGE.gateOrdering('lib/split.js', NEW.blankNonCode(src));
  const refusals = findings.filter((f) => !f.ok);
  assert.strictEqual(refusals.length, 1, JSON.stringify(findings.map((f) => f.message)));
  assert.match(refusals[0].message, /1 of its 2 caller\(s\) do not gate first/);
  assert.match(refusals[0].detail, /sloppySend\(\) calls deliver\(\)/);
});

test('3d. an exported private helper is refused — the indirection argument collapses', () => {
  const src = C4_SHAPE.replace('module.exports = { sendOne, sendAlert };',
    'module.exports = { sendOne, sendAlert, deliver };');
  const refusals = COVERAGE.gateOrdering('lib/leaky.js', NEW.blankNonCode(src)).filter((f) => !f.ok);
  assert.strictEqual(refusals.length, 1, 'exporting the ungated helper was not refused');
  assert.match(refusals[0].message, /is EXPORTED/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. BOTH MAILER STATES — M1 CORRECTION ITEM 5
// ═══════════════════════════════════════════════════════════════════════════

test('4. the corrected check is right about the production mailer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8');
  assert.deepStrictEqual(COVERAGE.unreadableReasons('src/lib/mailer.js', raw), [],
    'the scanner cannot read the mailer with certainty, so it must not be reporting on it');
  const findings = COVERAGE.gateOrdering('src/lib/mailer.js', NEW.blankNonCode(raw));
  assert.deepStrictEqual(findings.filter((f) => !f.ok), [],
    JSON.stringify(findings.map((f) => f.message)));
  assert.ok(findings.length >= 1, 'no provider call site was re-located in the mailer');
});

// The C-4 mailer is NOT on this branch — the branches are deliberately not combined until both
// have been verified independently (CEO decision 2026-11-12). So the shape it produces is pinned
// as a fixture here instead, in tests 2 and 2b above: a module-private provider half above the
// gated function, reached by two gating callers. That is the integration risk, and it is covered
// without merging anything.
