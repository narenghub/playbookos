// ── CAN ANYTHING REACH A PROVIDER WITHOUT PASSING dispatch()? ────────────────
//
//   node --test scripts/dispatch-chokepoint.test.js
//
// Spec A milestone 5. This control exists to PAY FOR an exception.
//
// `scripts/check-email-transport-coverage.js` asks of every file that names a provider: does this
// file also consult the kill switch? `src/lib/outbound/transports/gmail.js` names a provider and
// deliberately does NOT consult the kill switch — dispatch() holds every authorization decision so
// there is one place for that logic to be wrong, and the transport's own suite asserts it mentions
// neither assertSendAllowed nor expectedDigest.
//
// So the transport is an EXCEPTION in that scanner, which is a real loss of coverage on the single
// file that touches the provider. What makes that acceptable is not the comment next to the
// exception. It is this file, which proves the property the scanner can no longer see:
//
//     the transport is unreachable except through dispatch(),
//     and dispatch()'s gate call is unconditional.
//
// Together those give the same guarantee the scanner was giving, by a different route. If this
// control is ever deleted, the exception must be deleted with it.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEX = require('./js-lex');
const AST = require('./js-ast');

const TRANSPORT = 'src/lib/outbound/transports/gmail.js';
const REGISTRY = 'src/lib/outbound/transports/index.js';
const DISPATCH = 'src/lib/outbound/dispatch.js';

/** Every .js file in the repo, excluding node_modules. */
function allSources(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test-fixtures') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) allSources(full, out);
    else if (e.name.endsWith('.js')) out.push(path.relative(ROOT, full));
  }
  return out;
}

const SOURCES = allSources();
const codeOf = (rel) => LEX.blankNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// ═══ 1. WHO CAN REACH THE TRANSPORT AT ALL ═════════════════════════════════

test('1. only the registry imports the Gmail transport', () => {
  // A require of this module is the only way to obtain its send(). If an agent can import it, the
  // chokepoint is advisory — the agent could call send() directly and skip dispatch entirely.
  const importers = SOURCES.filter((rel) => {
    if (rel === TRANSPORT) return false;
    return /require\([`'"][^`'"]*transports\/gmail[`'"]\)/.test(codeOf(rel));
  });

  const permitted = new Set([REGISTRY, 'src/lib/outbound/dispatch.test.js', __filename.replace(ROOT + path.sep, '')]);
  const unexpected = importers.filter((f) => !permitted.has(f));

  assert.deepStrictEqual(unexpected, [],
    'these files import the Gmail transport directly and could call send() without dispatch():\n  '
    + unexpected.join('\n  '));
});

test('1b. and the two migrated agents import it only for their READ-ONLY client and label writes', () => {
  // cphi-runner and outreach-agent DO reference the transport module — for readOnlyClientFor,
  // fileThread and ensureLabels. None of those is a send. What they must never do is call send().
  for (const rel of ['src/lib/campaigns/cphi-runner.js', 'src/lib/agents/outreach-agent.js']) {
    const code = codeOf(rel);
    assert.ok(!/GMAIL\.send\s*\(|\.transport\.send\s*\(/.test(code),
      `${rel} calls the transport's send() directly, bypassing dispatch()`);
    assert.ok(!/users\.messages\.send/.test(code),
      `${rel} still reaches Gmail's send endpoint itself`);
  }
});

// ═══ 2. THE REGISTRY WIRES send() AND NOTHING ELSE ═════════════════════════

test('2. the registry registers the transport and makes no authorization decision', () => {
  const code = codeOf(REGISTRY);
  for (const t of ['assertSendAllowed', 'autonomy_stops', 'approvalId', 'expectedDigest',
    'RESEND_API_KEY', 'users.messages.send']) {
    assert.ok(!code.includes(t), `the registry references ${t} — it is a lookup table, nothing more`);
  }
});

// ═══ 3. THE GATE IN dispatch() IS ON EVERY PATH TO THE TRANSPORT ═══════════

test('3. the gate dominates dispatch\'s transport send, and its denial ends the path', () => {
  // The outbound scanner cannot answer this one. Its matchers look for PROVIDER shapes
  // (users.messages.send, the Resend URL), and dispatch deliberately calls none — it calls an
  // abstract transport by name, which is the whole point of the indirection. So analyseFile finds
  // no site here and has nothing to say.
  //
  // What it DOES have is the three helpers that implement the hard parts, and those are reused
  // verbatim rather than reimplemented: guaranteedBefore (does the gate run on every path),
  // skippability (is the gate under a branch a caller controls), resultHonoured (does a denial
  // actually end the path). My first draft of this control invented its own signatures for them
  // and failed for exactly that reason.
  const OUT = require('./outbound-ast-analysis');
  const src = fs.readFileSync(path.join(ROOT, DISPATCH), 'utf8');
  // AST.parse returns the tree itself, not { ast }. Destructuring it gives undefined, and
  // callsTo(undefined) returns [] — a silent zero that reads as 'no such call exists'.
  const ast = AST.parse(src, DISPATCH);
  const fns = AST.functionsOf(ast);

  // The transport send, located by shape: the registry lookup's send(), not a provider's.
  const sends = AST.callsTo(ast, (dotted) => dotted === 'impl.send');
  assert.strictEqual(sends.length, 1,
    `dispatch has ${sends.length} transport send call(s); this control proves the property for `
    + 'exactly one. If another was added it needs the same proof, not this assertion loosened.');
  const send = sends[0];

  const gates = OUT.gateCalls(ast);
  assert.ok(gates.length >= 1, 'dispatch never calls the authorization gate');

  const fnRecord = fns.find((f) => f.node === send.enclosing) || null;
  assert.ok(fnRecord, 'the send is not inside a function the analysis can scope');

  // (a) Some gate call is guaranteed to execute before the send on EVERY path — not merely
  //     earlier in the file, which is the file-order proxy this repository has been bitten by.
  const dominating = gates.filter((g) => OUT.guaranteedBefore(g, send));
  assert.ok(dominating.length >= 1,
    'no assertSendAllowed call is guaranteed to run before the transport send on every path');

  // (b) No caller-supplied value can skip it. This is the C-4 shape, asserted statically.
  for (const g of dominating) {
    const skip = OUT.skippability(g, fnRecord, send);
    assert.strictEqual(skip.callerControlled, false,
      `the gate at line ${g.line} sits under a branch a caller controls (${skip.by.join(', ')})`);
  }

  // (c) A denial actually prevents the send, rather than merely being computed. The CEO review
  //     finding — a gate consulted and ignored is not a gate — applied to the chokepoint itself.
  const honoured = dominating.map((g) => OUT.resultHonoured(g, send, fnRecord));
  assert.ok(honoured.some((h) => h.ok === true),
    'no denial from the gate is provably obeyed before the send: '
    + honoured.map((h) => h.why || '(no reason given)').join(' | '));
});

// ═══ 4. NO SECOND ROAD OUT ═════════════════════════════════════════════════

test('4. no agent or campaign module reaches a provider endpoint directly', () => {
  // The broad sweep. Any NEW sender added to an agent must go through dispatch, and this fails if
  // one does not — independently of the outbound scanner's baseline and ratchet.
  const offenders = [];
  for (const rel of SOURCES) {
    if (!/^src\/lib\/(agents|campaigns)\//.test(rel)) continue;
    if (rel.endsWith('.test.js')) continue;
    const code = codeOf(rel);
    if (/users\.messages\.send\s*\(/.test(code)) offenders.push(`${rel} (Gmail SDK send)`);
    if (/api\.resend\.com/.test(code)) offenders.push(`${rel} (Resend REST)`);
    if (/gmail\.googleapis\.com[^`'"]*\/send/.test(code)) offenders.push(`${rel} (Gmail REST send)`);
  }
  assert.deepStrictEqual(offenders, [],
    'these agent/campaign modules reach a provider without dispatch():\n  ' + offenders.join('\n  '));
});

test('4b. the exception in the outbound scanner still names this file', () => {
  // The two halves are load-bearing together. If someone removes the exception the scanner starts
  // failing on the transport; if someone removes THIS file the exception becomes unpaid-for. This
  // asserts the pairing is intact, so neither can drift away quietly.
  const scanner = fs.readFileSync(path.join(ROOT, 'scripts/check-email-transport-coverage.js'), 'utf8');
  assert.ok(scanner.includes(TRANSPORT),
    'the outbound scanner no longer excepts the transport — if the design changed, this control '
    + 'should be reconsidered rather than left asserting a dead pairing');
  assert.ok(scanner.includes('dispatch-chokepoint.test.js'),
    'the scanner\'s exception no longer names this control as its justification');
});
