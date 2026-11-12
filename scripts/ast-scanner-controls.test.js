// ── THE AST SCANNER'S NEGATIVE CONTROLS ──────────────────────────────────────
//
//   node --test scripts/ast-scanner-controls.test.js
//
// CEO decision 2026-11-12, item 6: "Add permanent negative controls for the original regex-literal
// defect, postfix division, hidden provider calls, and the C-4 bypass."
//
// Each historical defect gets a control that runs the ORIGINAL implementation, verbatim, alongside
// the AST analysis, and requires the first to be wrong and the second right. A control that merely
// describes a defect proves nothing; one that reads only the current code can only ever agree with
// it.
//
// There is also a set of controls for the things this migration could plausibly break, because the
// first draft of it DID break one: it carried four of the scanner's five transports across and
// silently lost nodemailer. The existing suite caught that. Test 5 below exists so the next
// migration cannot lose one quietly.
//
// MOCKED EVERYTHING. No provider, no network, no database. Fixtures are parsed, never executed.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AST = require('./js-ast');
const OUTBOUND = require('./outbound-ast-analysis');
const COVERAGE = require('./check-email-transport-coverage');
const LEX = require('./js-lex');

// ═══════════════════════════════════════════════════════════════════════════
// THE ORIGINAL PRE-PASS, REPRODUCED VERBATIM
//
// From scripts/check-email-transport-coverage.js at da057d3c. Do not "improve" it: its value is
// being exactly what shipped and reported PASS over code it had erased.
// ═══════════════════════════════════════════════════════════════════════════
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

const GMAIL_SEND = /\.users\s*\.\s*messages\s*\.\s*send\s*\(/g;
const countSends = (code) => { GMAIL_SEND.lastIndex = 0; return (code.match(GMAIL_SEND) || []).length; };

/** Discover through the real pipeline, from a planted tree. */
function plantAndDiscover(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-controls-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return COVERAGE.discover(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE REGEX-LITERAL DEFECT
// ═══════════════════════════════════════════════════════════════════════════

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
  assert.strictEqual(countSends(originalBlankNonCode(QUOTE_BEARING_REGEX)), 0,
    'the original pre-pass no longer exhibits the defect — restore the verbatim copy; its whole '
    + 'value is being exactly what shipped');
});

test('1b. the AST finds it, and the question does not arise', () => {
  // Not "the lexer was fixed" — the category of mistake is gone. A regex literal is a Literal node;
  // it cannot swallow its neighbours.
  const ast = AST.parse(QUOTE_BEARING_REGEX, 'hidden.js');
  const calls = OUTBOUND.providerCalls(ast);
  assert.strictEqual(calls.length, 1, `expected one provider call, got ${calls.length}`);
  assert.strictEqual(calls[0].key, 'gmail.messages.send');
  assert.strictEqual(AST.functionsOf(ast).find((f) => f.node === calls[0].enclosing).name, 'run');
});

test('1c. and the whole pipeline reports it as an ungated sender', () => {
  const site = plantAndDiscover({ 'lib/hidden-sender.js': QUOTE_BEARING_REGEX })
    .find((s) => /hidden-sender/.test(s.file));
  assert.ok(site, 'the sender was not discovered at all — the scanner would report it as absent');
  assert.strictEqual(site.transport, 'gmail.messages.send');
  assert.strictEqual(site.enclosing, 'run');
  assert.strictEqual(site.gated, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. POSTFIX DIVISION
//
// The one construct the corrected lexer still got silently wrong. Zero occurrences in real code
// when measured, but a silent wrong answer is the category that matters, and the parser removes it.
// ═══════════════════════════════════════════════════════════════════════════

test('2. the corrected LEXER still misreads postfix-then-division as a regex', () => {
  const src = 'let a=1,b=2,c=3; a++ / b / c;';
  const kinds = LEX.lex(src).spans.map((s) => s.kind);
  assert.ok(kinds.includes('regex'),
    'the lexer no longer exhibits this — if it was fixed, say so here and keep the AST control');
  assert.deepStrictEqual(LEX.concernsIn(src), [],
    'and it raises NO concern, which is what made it the only silently-wrong construct');
});

test('2b. the AST reads it as division, so the defect cannot exist', () => {
  const ast = AST.parse('let a=1,b=2,c=3; a++ / b / c;', 'div.js');
  const expr = ast.body[1].expression;
  assert.strictEqual(expr.type, 'BinaryExpression', `parsed as ${expr.type}`);
  assert.strictEqual(expr.operator, '/');
});

test('2c. and a transport after postfix division is still discovered', () => {
  // The consequence that would have mattered: under the lexer the misread span could blank to end
  // of line. Here the call is on the next line and must survive.
  const src = [
    "const g = require('./gmail');",
    'async function run(m, a, b, c) {',
    '  const ratio = a++ / b / c;',
    '  await g.gmail.users.messages.send(m);',
    '  return ratio;',
    '}',
    'module.exports = { run };',
  ].join('\n');
  const site = plantAndDiscover({ 'lib/postfix.js': src }).find((s) => /postfix/.test(s.file));
  assert.ok(site, 'the transport after a postfix division was not discovered');
  assert.strictEqual(site.enclosing, 'run');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. HIDDEN PROVIDER CALLS
//
// Every way a real transport can fail to look like the pattern someone wrote down.
// ═══════════════════════════════════════════════════════════════════════════

test('3. a transport inside a template interpolation is discovered', () => {
  const src = [
    "const g = require('./gmail');",
    'async function run(m) {',
    '  const log = `sent ${ await g.gmail.users.messages.send(m) }`;',
    '  return log;',
    '}',
    'module.exports = { run };',
  ].join('\n');
  const site = plantAndDiscover({ 'lib/interp.js': src }).find((s) => /interp/.test(s.file));
  assert.ok(site, 'a transport inside an interpolation was not discovered');
  assert.strictEqual(site.gated, false);
});

test('3b. an unusual receiver does not hide a transport', () => {
  // Suffix matching on the parse tree, so the receiver can be anything: `this.client`, an awaited
  // factory, an element of an array. A per-receiver regex list would have to anticipate each.
  for (const receiver of ['this.client', 'svc.api.google', '(await client())', 'clients[0]']) {
    const src = [
      'async function run(m) {',
      `  await ${receiver}.users.messages.send(m);`,
      '}',
      'module.exports = { run };',
    ].join('\n');
    const ast = AST.parse(src, 'r.js');
    const calls = OUTBOUND.providerCalls(ast);
    assert.strictEqual(calls.length, 1, `receiver ${receiver} hid the transport`);
  }
});

test('3c. a call in a comment or a string is NOT a transport', () => {
  // The other direction. A scanner that counts prose invents violations, and this repository has
  // test fixtures that contain provider calls as strings on purpose.
  const src = [
    '// await g.gmail.users.messages.send(m) — described, not performed',
    'const fixture = "await g.gmail.users.messages.send(m)";',
    'const tmpl = `await g.gmail.users.messages.send(m)`;',
    'module.exports = { fixture, tmpl };',
  ].join('\n');
  assert.strictEqual(OUTBOUND.providerCalls(AST.parse(src, 'prose.js')).length, 0,
    'prose or a string fixture was counted as a transmission');
});

test('3d. a provider call at import time is reported, not attributed to a function', () => {
  const src = ["const g = require('./gmail');", 'g.gmail.users.messages.send({ userId: "me" });'].join('\n');
  const r = OUTBOUND.analyseFile({ file: 'lib/toplevel.js', src });
  assert.strictEqual(r.sites.length, 1);
  assert.strictEqual(r.sites[0].enclosing, null);
  assert.ok(r.findings.some((f) => !f.ok && /runs at import time/.test(f.message)),
    `expected an import-time finding, got ${JSON.stringify(r.findings.map((f) => f.message))}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE C-4 BYPASS — THE CONDITIONAL-GATE CONTROL
//
// The decision's item 3. The previous check proved a gate was ON the path and could not see that a
// caller could step around it: with the bypass restored, the mailer test suite went red and the
// scanner still said PASS.
// ═══════════════════════════════════════════════════════════════════════════

const BYPASS_SHAPE = [
  "const { assertSendAllowed } = require('./email-gate');",
  "const g = require('./gmail');",
  'async function send(opts, internal = {}) {',
  '  const gate = internal.alertAlreadyAuthorized',
  '    ? { allowed: true, reason: null }',
  '    : await assertSendAllowed({ capability: "email.send" });',
  '  if (!gate.allowed) return false;',
  '  await g.gmail.users.messages.send(opts);',
  '  return true;',
  '}',
  'module.exports = { send };',
].join('\n');

test('4. a caller-skippable gate is caught, and the parameter is named', () => {
  const r = OUTBOUND.analyseFile({ file: 'lib/bypass.js', src: BYPASS_SHAPE });
  const refusals = r.findings.filter((f) => !f.ok);
  assert.strictEqual(refusals.length, 1, JSON.stringify(r.findings.map((f) => f.message)));
  assert.match(refusals[0].message, /CALLER-SKIPPABLE/);
  assert.match(refusals[0].detail, /a ternary/);
  assert.match(refusals[0].detail, /`internal`/,
    'the finding does not name the parameter that controls the bypass, which is what a reader has '
    + 'to go and remove');
});

test('4b. the REAL pre-C-4 mailer is caught by this control', () => {
  // Not a fixture resembling the defect — the actual file as it shipped, so the control is pinned
  // to history rather than to my description of it.
  const real = path.join(__dirname, '..', 'test-fixtures', 'mailer-pre-c4.js.txt');
  if (!fs.existsSync(real)) {
    assert.fail(`the pre-C-4 mailer fixture is missing at ${real}; it is the evidence for this control`);
  }
  const r = OUTBOUND.analyseFile({ file: 'src/lib/mailer.js', src: fs.readFileSync(real, 'utf8') });
  const refusals = r.findings.filter((f) => !f.ok);
  assert.strictEqual(refusals.length, 1, JSON.stringify(r.findings.map((f) => f.message)));
  assert.match(refusals[0].message, /sendEmailDetailed\(\) reaches .* CALLER-SKIPPABLE/);
  assert.match(refusals[0].detail, /`internal`/);
});

test('4c. and the C-4 patch passes it — the control is not "condemn every gate"', () => {
  const fixed = BYPASS_SHAPE
    .replace('async function send(opts, internal = {}) {', 'async function send(opts) {')
    .replace('  const gate = internal.alertAlreadyAuthorized\n', '  const gate =')
    .replace('    ? { allowed: true, reason: null }\n', '')
    .replace('    : await assertSendAllowed', '    await assertSendAllowed');
  const r = OUTBOUND.analyseFile({ file: 'lib/fixed.js', src: fixed });
  assert.deepStrictEqual(r.findings.filter((f) => !f.ok), [],
    `an unconditional gate was refused: ${JSON.stringify(r.findings.map((f) => f.message))}`);
});

test('4d. every branching form is caught, not only the ternary', () => {
  // Item 3 names ternary, logical and conditional branches. One fixture each, all with the provider
  // call OUTSIDE the branch that holds the gate.
  const forms = {
    'a ternary': '  const gate = skip ? { allowed: true } : await assertSendAllowed({});',
    'a short-circuit (&& or ||)': '  const gate = skip || await assertSendAllowed({});',
    'an if statement': '  let gate = { allowed: true };\n  if (!skip) { gate = await assertSendAllowed({}); }',
  };
  for (const [label, body] of Object.entries(forms)) {
    const src = [
      "const { assertSendAllowed } = require('./email-gate');",
      "const g = require('./gmail');",
      'async function send(opts, skip) {',
      body,
      '  if (!gate.allowed) return false;',
      '  await g.gmail.users.messages.send(opts);',
      '  return true;',
      '}',
      'module.exports = { send };',
    ].join('\n');
    const refusals = OUTBOUND.analyseFile({ file: 'lib/f.js', src }).findings.filter((f) => !f.ok);
    assert.strictEqual(refusals.length, 1, `${label} was not caught`);
    assert.match(refusals[0].message, /CALLER-SKIPPABLE/, `${label}: not reported as skippable`);
    assert.match(refusals[0].detail, new RegExp(label.replace(/[()&|]/g, '\\$&')),
      `${label}: the finding does not say which construct it is`);
  }
});

test('4e. a gate and a call sharing one loop is NOT a finding', () => {
  // THE FALSE POSITIVE THAT HAD TO BE AVOIDED. The first version of the conditional-gate control
  // asked "is the gate inside any branch" and condemned src/lib/agents/outreach-agent.js and
  // src/lib/campaigns/cphi-runner.js, where the gate and the send sit in the same per-recipient
  // loop and the gate runs first on every iteration. A control that condemns correct code gets
  // switched off, so the property is RELATIVE: every branch holding the gate must also hold the
  // call.
  const src = [
    "const { assertSendAllowed } = require('./email-gate');",
    "const g = require('./gmail');",
    'async function run(queue) {',
    '  for (const q of queue) {',
    '    const gate = await assertSendAllowed({ to: q.email });',
    '    if (!gate.allowed) continue;',
    '    await g.gmail.users.messages.send(q.msg);',
    '  }',
    '}',
    'module.exports = { run };',
  ].join('\n');
  const r = OUTBOUND.analyseFile({ file: 'lib/loop.js', src });
  assert.deepStrictEqual(r.findings.filter((f) => !f.ok), [],
    `a gate sharing a loop with its call was condemned: ${JSON.stringify(r.findings.map((f) => f.message))}`);
  assert.match(r.findings[0].message, /on every path/);
});

test('4f. but a gate in a loop with the call OUTSIDE it is caught', () => {
  // The converse, so 4e cannot be satisfied by ignoring loops altogether.
  const src = [
    "const { assertSendAllowed } = require('./email-gate');",
    "const g = require('./gmail');",
    'async function run(queue, msg) {',
    '  for (const q of queue) { await assertSendAllowed({ to: q.email }); }',
    '  await g.gmail.users.messages.send(msg);',
    '}',
    'module.exports = { run };',
  ].join('\n');
  const refusals = OUTBOUND.analyseFile({ file: 'lib/loop2.js', src }).findings.filter((f) => !f.ok);
  assert.strictEqual(refusals.length, 1,
    'a gate that runs only inside a loop was accepted for a call outside it — an empty queue means '
    + 'the gate never runs at all');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. COVERAGE PARITY — THE CONTROL THAT CAUGHT MY OWN REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

test('5. every transport the regex list knows is covered by the AST shapes', () => {
  // The first draft of this migration carried four of five transports across and silently dropped
  // nodemailer. The existing suite caught it. This makes the parity explicit so the next migration
  // cannot lose one quietly — coverage that shrinks as the code grows is this scanner's founding
  // failure, and a refactor is just a faster way to shrink it.
  const regexKeys = new Set(COVERAGE.TRANSPORTS.map((t) => t.key));
  const astKeys = new Set(OUTBOUND.TRANSPORT_SHAPES.map((t) => t.key));
  astKeys.add('resend.http');                 // fetch(RESEND_EMAILS_URL), handled separately
  const missing = [...regexKeys].filter((k) => !astKeys.has(k));
  assert.deepStrictEqual(missing, [],
    `the AST analysis does not cover: ${missing.join(', ')} — a transport the old scanner saw and `
    + 'the new one does not is a silent loss of coverage');
});

test('5b. and each of the five is actually found in a fixture', () => {
  // Parity of key names is not parity of behaviour. One fixture per transport.
  const fixtures = {
    'gmail.messages.send': 'async function f(m){ await g.gmail.users.messages.send(m); }',
    'gmail.drafts.send': 'async function f(m){ await g.gmail.users.drafts.send(m); }',
    'resend.sdk': 'async function f(m){ await client.emails.send(m); }',
    'resend.http': 'async function f(m){ await fetch(RESEND_EMAILS_URL, m); }',
    nodemailer: 'async function f(m){ await transporter.sendMail(m); }',
  };
  for (const [key, src] of Object.entries(fixtures)) {
    const calls = OUTBOUND.providerCalls(AST.parse(src, 'f.js'));
    assert.ok(calls.some((c) => c.key === key),
      `${key} was not found in its own fixture; found ${JSON.stringify(calls.map((c) => c.key))}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. WHAT CANNOT BE PROVEN — INCOMPLETE, NOT PASS
// ═══════════════════════════════════════════════════════════════════════════

test('6. computed dispatch on a provider path is unprovable', () => {
  const reasons = COVERAGE.unreadableReasons('lib/c.js',
    'async function f(m, k){ await g.gmail.users.messages[k](m); }');
  assert.ok(reasons.some((r) => /computed-dispatch/.test(r)), JSON.stringify(reasons));
});

test('6b. an aliased provider method is unprovable', () => {
  const reasons = COVERAGE.unreadableReasons('lib/a.js',
    'const send = g.gmail.users.messages.send;\nasync function f(m){ return send(m); }');
  assert.ok(reasons.some((r) => /aliased-provider-method/.test(r)), JSON.stringify(reasons));
});

test('6c. ordinary computed calls are NOT flagged — the control is not "refuse everything"', () => {
  // Computed dispatch is everywhere in normal code. Flagging all of it would make the scanner
  // permanently INCOMPLETE, which is the same as switched off.
  for (const src of [
    'const h = { a(){} }; function f(k){ return h[k](); }',
    'function f(o, k){ return o[k](1, 2); }',
    'async function f(m){ await g.gmail.users.messages["send"](m); }',
  ]) {
    assert.deepStrictEqual(COVERAGE.unreadableReasons('lib/ok.js', src), [],
      `an ordinary computed call was flagged: ${src}`);
  }
});

test('6d. a file that does not parse is refused, never analysed anyway', () => {
  assert.ok(COVERAGE.unreadableReasons('lib/bad.js', 'function f( { return 1 }')
    .some((r) => /does not parse/.test(r)));
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. NO SILENT FALLBACK
// ═══════════════════════════════════════════════════════════════════════════

test('7. discovery does not fall back to the lexer', () => {
  // Structural, and the most important assertion in the file. If the parser is missing, the scanner
  // must report INCOMPLETE — not revert to the pre-pass it replaced. A quiet fallback to the thing
  // being replaced is how this defect class survived three attempts at fixing it.
  const src = fs.readFileSync(path.join(__dirname, 'check-email-transport-coverage.js'), 'utf8');
  const code = LEX.blankNonCode(src);
  const i = code.indexOf('function discover(roots = ROOTS) {');
  assert.ok(i > 0, 'discover() could not be located — update this guard');
  const body = code.slice(i, code.indexOf('\nfunction ', i + 10));
  assert.ok(!/blankNonCode\s*\(/.test(body),
    'discover() calls the lexer — discovery must be AST-based, with no text path');
  assert.ok(/analyseFile\s*\(/.test(body), 'discover() does not use the AST analysis');

  assert.strictEqual(typeof AST.parserAvailable, 'function');
  assert.ok(/parserAvailable\(\)/.test(code),
    'the scanner never asks whether the parser is available, so a missing parser would be silent');
});

test('7b. the parser-missing path produces a reason, not an empty result', () => {
  // Exercised by substituting the check the scanner makes. The real absence cannot be simulated
  // once acorn is loaded, so the contract is asserted instead: available ⇒ no reason, and the
  // reason text, when there is one, says it does not fall back.
  assert.strictEqual(AST.parserAvailable(), true, 'acorn should be installed for this suite');
  assert.strictEqual(AST.parserMissingReason(), null);
  const reasonSource = fs.readFileSync(path.join(__dirname, 'js-ast.js'), 'utf8');
  assert.match(reasonSource, /NOT fall back/,
    'the parser-missing reason must say plainly that there is no fallback');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. A DENIAL MUST ACTUALLY PREVENT DELIVERY
//
// CEO review 2026-11-12, item 2: "Verify that the authorization analysis does not accept a provider
// call merely because assertSendAllowed() executed. A denial must actually prevent delivery."
//
// It was a real gap, and these are the two shapes that were accepted before it was closed. In both
// the gate runs unconditionally on every path, and a refusal changes nothing — the analysis proved
// the call HAPPENED and called that authorization.
// ═══════════════════════════════════════════════════════════════════════════

const SENDER = (gateBody) => [
  "const { assertSendAllowed } = require('./email-gate');",
  "const g = require('./gmail');",
  'async function send(opts) {',
  gateBody,
  '  await g.gmail.users.messages.send(opts);',
  '  return true;',
  '}',
  'module.exports = { send };',
].join('\n');

const verdictOf = (src, file = 'lib/honour.js') => {
  const r = OUTBOUND.analyseFile({ file, src });
  const f = r.findings[0] || null;
  if (f && f.ok) return { state: 'ok', f, r };
  if (r.unprovable.length) return { state: 'incomplete', f, r };
  return { state: 'fail', f, r };
};

test('8. a gate whose result is DISCARDED is a finding, not a pass', () => {
  const v = verdictOf(SENDER('  await assertSendAllowed({ capability: "email.send" });'));
  assert.strictEqual(v.state, 'fail',
    `a discarded gate result was accepted as authorization: ${v.f && v.f.message}`);
  assert.match(v.f.message, /DOES NOT ACT ON THE ANSWER/);
  assert.match(v.f.detail, /discarded entirely/);
});

test('8b. a gate result that is bound but never read is a finding', () => {
  const v = verdictOf(SENDER('  const gate = await assertSendAllowed({ capability: "email.send" });'));
  assert.strictEqual(v.state, 'fail',
    `an unread gate result was accepted as authorization: ${v.f && v.f.message}`);
  assert.match(v.f.detail, /never read before the send/);
});

test('8c. a gate result read but with no branch ending the path is UNPROVABLE', () => {
  // Not a finding: the code might prevent delivery in a way this analysis cannot see. It is
  // reported as unprovable, which makes the scanner INCOMPLETE rather than green.
  const v = verdictOf(SENDER([
    '  const gate = await assertSendAllowed({});',
    '  if (!gate.allowed) { console.warn("refused"); }',
  ].join('\n')));
  assert.strictEqual(v.state, 'incomplete', `expected INCOMPLETE, got ${v.state}`);
  assert.ok(v.r.unprovable.some((u) => u.why === 'gate-result-unproven'), JSON.stringify(v.r.unprovable));
});

test('8d. every real refusal form in this repository is accepted', () => {
  // The positive control, and it has to cover all of them or the check condemns working code:
  // mailer.js returns, outreach-agent.js and cphi-runner.js `continue`, verify-bounce-detection.js
  // calls process.exit with its own refused-by-policy code.
  const forms = {
    return: '  const gate = await assertSendAllowed({});\n  if (!gate.allowed) return false;',
    throw: '  const gate = await assertSendAllowed({});\n  if (!gate.allowed) throw new Error(gate.reason);',
    'process.exit': '  const gate = await assertSendAllowed({});\n  if (!gate.allowed) { process.exit(3); }',
    destructured: '  const { allowed } = await assertSendAllowed({});\n  if (!allowed) return false;',
    inline: '  if (!(await assertSendAllowed({})).allowed) return false;',
  };
  for (const [label, body] of Object.entries(forms)) {
    const v = verdictOf(SENDER(body));
    assert.strictEqual(v.state, 'ok', `the ${label} refusal form was rejected: ${v.f && v.f.message}`);
    assert.match(v.f.message, /a refusal ends the path before it/);
  }
});

test('8e. `continue` inside a send loop is accepted — the real agent shape', () => {
  const src = [
    "const { assertSendAllowed } = require('./email-gate');",
    "const g = require('./gmail');",
    'async function run(queue) {',
    '  for (const q of queue) {',
    '    const gate = await assertSendAllowed({ to: q.email });',
    '    if (!gate.allowed) continue;',
    '    await g.gmail.users.messages.send(q.msg);',
    '  }',
    '}',
    'module.exports = { run };',
  ].join('\n');
  const v = verdictOf(src, 'lib/loop.js');
  assert.strictEqual(v.state, 'ok', `the real agent shape was rejected: ${v.f && v.f.message}`);
});

test('8f. a `return` inside a callback does NOT count as ending the path', () => {
  // It returns from the callback, not from the sender. Accepting it would accept a guard that does
  // nothing — the same category of mistake as accepting a gate that merely executed.
  const v = verdictOf(SENDER([
    '  const gate = await assertSendAllowed({});',
    '  if (!gate.allowed) { [1].forEach(() => { return 1; }); }',
  ].join('\n')));
  assert.notStrictEqual(v.state, 'ok',
    'a return inside a callback was accepted as a refusal path');
});

test('8g. the indirection path enforces it too', () => {
  // A private helper reached by two callers, one of which consults the gate and ignores it. Without
  // this, item 2 would arrive by the indirect road.
  const src = [
    "const { assertSendAllowed } = require('./email-gate');",
    "const g = require('./gmail');",
    'async function deliver(m) { await g.gmail.users.messages.send(m); }',
    'async function sendOne(m) {',
    '  const gate = await assertSendAllowed({});',
    '  if (!gate.allowed) return false;',
    '  return deliver(m);',
    '}',
    'async function sendTwo(m) {',
    '  const gate = await assertSendAllowed({});',
    '  return deliver(m);',
    '}',
    'module.exports = { sendOne, sendTwo };',
  ].join('\n');
  const v = verdictOf(src, 'lib/indirect.js');
  assert.strictEqual(v.state, 'fail', `expected a finding, got ${v.state}: ${v.f && v.f.message}`);
  assert.match(v.f.message, /WITHOUT ACTING ON THE ANSWER/);
  assert.match(v.f.detail, /sendTwo\(\)/, 'the finding does not name the offending caller');
});

test('8h. and the real mailer passes, with the stronger statement', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8');
  const r = OUTBOUND.analyseFile({ file: 'src/lib/mailer.js', src });
  assert.deepStrictEqual(r.findings.filter((f) => !f.ok), [],
    JSON.stringify(r.findings.map((f) => f.message)));
  assert.match(r.findings[0].message, /refuse on a denial/,
    'the mailer finding no longer asserts that its callers act on the gate answer');
});
