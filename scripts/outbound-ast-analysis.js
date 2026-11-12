// ── OUTBOUND MAIL ANALYSIS, FROM THE PARSE TREE ──────────────────────────────
//
//   const { analyseFile } = require('./outbound-ast-analysis');
//
// The policy layer. js-ast.js answers structural questions about any JavaScript; this file asks
// the four that decide whether an outbound mail path is governed:
//
//   1. WHERE are the provider calls?                    → sites()
//   2. Is a gate on the path to each one?               → ordering findings
//   3. Is that gate UNCONDITIONAL, or can a caller skip it?   → the conditional-gate control
//   4. What cannot be proven either way?                → unprovable, which becomes INCOMPLETE
//
// CEO decision 2026-11-12. Question 3 exists because of a specific miss: the previous check proved
// a gate was on the path while being blind to whether it could be stepped around. With C-4's
// bypass restored, the mailer test suite went red and the scanner still said PASS, because
// `assertSendAllowed` inside a ternary is textually before the provider call. It is now a
// structural question with a structural answer.

'use strict';

const AST = require('./js-ast');

// ── THE TRANSPORTS, AS TREE SHAPES RATHER THAN REGEXES ──────────────────────
//
// A dotted callee is matched by SUFFIX, so `g.gmail.users.messages.send` and
// `this.client.users.messages.send` both match without a pattern per receiver. The old regexes
// matched text and so also matched prose, string fixtures and — the reason this file exists —
// nothing at all when a quote-bearing regex had erased the line.
const TRANSPORT_SHAPES = [
  { key: 'gmail.messages.send', label: 'Gmail users.messages.send', suffix: 'users.messages.send' },
  { key: 'gmail.drafts.send', label: 'Gmail users.drafts.send', suffix: 'users.drafts.send' },
  { key: 'resend.sdk', label: 'Resend SDK emails.send', suffix: 'emails.send' },
  // nodemailer. DROPPED BY ACCIDENT in the first draft of this migration, and caught by the
  // existing control `nodemailer is discovered as a transport` — which is the whole reason that
  // control exists. Carrying four of five transports across a refactor is precisely the
  // coverage-that-shrinks failure this scanner was written for, so it is recorded rather than
  // quietly fixed.
  //
  // Both forms, as the regex had: the send itself, and the factory — a file that builds an SMTP
  // transport is a file that can reach one, even if the send happens elsewhere.
  { key: 'nodemailer', label: 'nodemailer transport.sendMail', suffix: 'sendMail' },
  { key: 'nodemailer', label: 'nodemailer createTransport', suffix: 'createTransport',
    bare: 'createTransport' },
];
// The HTTP transport is not a method call on a client, it is fetch() against a named constant.
const RESEND_URL_IDENT = 'RESEND_EMAILS_URL';

// Receivers whose computed dispatch cannot be proven safe (item 4).
const PROVIDER_ROOTS = ['gmail', 'users', 'messages', 'drafts', 'emails', 'resend',
  'transporter', 'transport'];
const PROVIDER_SUFFIXES = TRANSPORT_SHAPES.map((t) => t.suffix);

const GATE = 'assertSendAllowed';

/** Every provider call in the tree, with its enclosing function and branch context. */
function providerCalls(ast) {
  const out = [];
  for (const shape of TRANSPORT_SHAPES) {
    // A suffix match covers `x.y.sendMail(`; `bare` additionally covers an imported function
    // called directly, as `createTransport(opts)` after destructuring it from the module.
    for (const c of AST.callsTo(ast, (dotted, node, suffix) => {
      // `suffix` rather than `dotted`, so a dynamic receiver cannot hide a transport:
      // `(await client()).users.messages.send(m)` has no static name and is still a Gmail send.
      const chain = suffix || dotted;
      if (chain && (chain === shape.suffix || chain.endsWith(`.${shape.suffix}`))) return true;
      return shape.bare ? dotted === shape.bare : false;
    })) {
      out.push({ ...c, key: shape.key, label: shape.label });
    }
  }
  // fetch(RESEND_EMAILS_URL, …)
  for (const c of AST.callsTo(ast, (dotted, node) => {
    if (dotted !== 'fetch' && dotted !== 'global.fetch') return false;
    const first = node.arguments && node.arguments[0];
    return !!first && first.type === 'Identifier' && first.name === RESEND_URL_IDENT;
  })) {
    out.push({ ...c, key: 'resend.http', label: 'Resend HTTP POST /emails' });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Every gate call, with what branches above it inside its own function. */
function gateCalls(ast) {
  return AST.callsTo(ast, GATE);
}

/** Identifier names appearing anywhere inside a node. */
function identifiersIn(node) {
  const names = new Set();
  AST.walk(node, (n) => { if (n.type === 'Identifier') names.add(n.name); });
  return names;
}

/**
 * Is this gate call skippable by the CALLER?
 *
 * A gate inside any branch is conditional. It is specifically CALLER-SKIPPABLE when a branch's
 * test mentions a parameter of the enclosing function — which is exactly the C-4 shape:
 *
 *     async function sendEmailDetailed(opts, internal = {}) {
 *       const gate = internal.alertAlreadyAuthorized ? { allowed: true } : await assertSendAllowed(…)
 *
 * The distinction matters because the remedy differs. A gate behind an internal condition is a
 * design question; a gate behind a condition the caller supplies is a bypass.
 */
/**
 * Is `gate` guaranteed to have run whenever `call` runs?
 *
 * THE QUESTION THAT HAD TO BE GOT RIGHT. The first version of this check asked "is the gate inside
 * any branch", and reported `outreach-agent.js` and `cphi-runner.js` as having a conditional gate.
 * They do not: in both, the gate and the provider call sit inside the SAME per-recipient `for-of`
 * loop, the gate runs first on every iteration, and a refusal does `continue`. The gate is inside a
 * branch and is still guaranteed. A check that condemns correct code gets switched off.
 *
 * The property is therefore RELATIVE: every branching construct enclosing the gate must also
 * enclose the call. A shared loop satisfies that. A ternary that holds only the gate does not — and
 * neither does `if (x) { gate(); }` followed by an unguarded `send()`.
 */
function guaranteedBefore(gate, call) {
  if (gate.enclosing !== call.enclosing) return false;
  if (gate.start >= call.start) return false;
  const gateBranches = AST.branchNodesOf(gate);
  const callBranches = AST.branchNodesOf(call);
  for (const n of gateBranches) if (!callBranches.has(n)) return false;
  return true;
}

/**
 * The branches that hold the gate but NOT the call — the ones that make it skippable — and whether
 * any of their tests reads a parameter of the enclosing function.
 */
function skippability(gate, fnRecord, call = null) {
  if (!gate.branches.length) return { conditional: false, callerControlled: false, by: [] };
  const callBranches = call ? AST.branchNodesOf(call) : new Set();
  const params = new Set(fnRecord ? fnRecord.params : []);
  const by = [];
  let callerControlled = false;
  for (let i = gate.ancestors.length - 1; i >= 0; i -= 1) {
    const a = gate.ancestors[i];
    if (a === gate.enclosing) break;
    const kind = AST.BRANCHING[a.type];
    if (!kind) continue;
    // A branch that encloses the CALL too does not make the gate skippable — see
    // guaranteedBefore(). This is what keeps the per-recipient send loops out of the findings.
    if (callBranches.has(a)) continue;
    const test = a.test || (a.type === 'LogicalExpression' ? a.left : null);
    if (!test) { by.push({ kind, param: null }); continue; }
    const mentioned = [...identifiersIn(test)].filter((n) => params.has(n));
    if (mentioned.length) {
      callerControlled = true;
      by.push({ kind, param: mentioned[0] });
    } else {
      by.push({ kind, param: null });
    }
  }
  return { conditional: true, callerControlled, by };
}


// ── AND IS THE GATE'S ANSWER ACTUALLY OBEYED? ───────────────────────────────
//
// CEO review 2026-11-12, item 2: "Verify that the authorization analysis does not accept a provider
// call merely because assertSendAllowed() executed. A denial must actually prevent delivery."
//
// THE GAP THIS CLOSES, and it was real. Until this check existed, both of these were accepted:
//
//     await assertSendAllowed({ ... });                  // result discarded
//     await g.gmail.users.messages.send(opts);
//
//     const gate = await assertSendAllowed({ ... });      // bound, never read
//     await g.gmail.users.messages.send(opts);
//
// In each, the gate runs unconditionally on every path — and a refusal changes nothing. The
// analysis proved the call happened and called that authorization. That is the fourth instance in
// this series of proving a weaker property than the one that matters, and it was caught in review
// rather than by me.
//
// What counts as obeying the answer: the result must be bound (or read inline), tested, and the
// failing branch must END the path before the provider call — `return`, `throw`, `continue`,
// `break`, or `process.exit()`. All five appear in this repository: mailer.js returns,
// outreach-agent.js and cphi-runner.js `continue` inside their send loops, and
// verify-bounce-detection.js exits with its own refused-by-policy code.
//
// Where the shape is recognisable and wrong, that is a FINDING. Where it is simply unrecognisable,
// that is UNPROVABLE and the scanner reports INCOMPLETE — it does not guess, in either direction.

const TERMINATORS = new Set(['ReturnStatement', 'ThrowStatement', 'ContinueStatement',
  'BreakStatement']);

/**
 * Does this subtree end the current path? Nested functions are ignored: a `return` inside a
 * callback returns from the callback, not from the sender, and treating it as a terminator would
 * accept a guard that does nothing.
 */
function endsThePath(node) {
  let found = false;
  AST.walk(node, (n, ancestors) => {
    if (found) return;
    if (ancestors.some((a) => AST.FUNCTION_TYPES.has(a.type))) return;
    if (TERMINATORS.has(n.type)) { found = true; return; }
    if (n.type === 'CallExpression' && AST.dottedName(n.callee) === 'process.exit') found = true;
  });
  return found;
}

/** What the gate's return value was bound to, if anything. */
function gateBinding(gate) {
  let idx = gate.ancestors.length - 1;
  let child = gate.node;
  while (idx >= 0 && gate.ancestors[idx].type === 'AwaitExpression') {
    child = gate.ancestors[idx];
    idx -= 1;
  }
  const holder = gate.ancestors[idx];
  if (!holder) return { kind: 'unknown' };
  if (holder.type === 'VariableDeclarator' && holder.init === child) {
    if (holder.id.type === 'Identifier') return { kind: 'binding', names: [holder.id.name] };
    // `const { allowed } = await assertSendAllowed(...)`
    return { kind: 'binding', names: AST.paramNames(holder.id) };
  }
  if (holder.type === 'AssignmentExpression' && holder.right === child) {
    const n = AST.dottedName(holder.left);
    return n ? { kind: 'binding', names: [n.split('.')[0]] } : { kind: 'unknown' };
  }
  // `if (!(await assertSendAllowed(...)).allowed) return;`
  if (holder.type === 'MemberExpression' && holder.object === child) return { kind: 'inline' };
  if (holder.type === 'UnaryExpression' || holder.type === 'LogicalExpression') return { kind: 'inline' };
  if (holder.type === 'ExpressionStatement') return { kind: 'discarded' };
  return { kind: 'unknown' };
}

/**
 * Is a denial from `gate` guaranteed to prevent `call`?
 *
 * Returns { ok: true } proven, { ok: false, why } proven NOT honoured, or { ok: null, why } when it
 * cannot be established — which the caller turns into INCOMPLETE.
 */
function resultHonoured(gate, call, fnRecord) {
  const b = gateBinding(gate);

  if (b.kind === 'discarded') {
    return { ok: false, why: 'the gate\'s return value is discarded entirely, so a refusal cannot '
      + 'reach any branch and nothing can stop the send' };
  }

  if (b.kind === 'inline') {
    // Read directly inside a test. The enclosing `if` must end the path.
    const guards = gate.ancestors.filter((a) => a.type === 'IfStatement'
      || a.type === 'ConditionalExpression');
    const ends = guards.some((a) => (a.consequent && endsThePath(a.consequent))
      || (a.alternate && endsThePath(a.alternate)));
    if (ends) return { ok: true };
    return { ok: null, why: 'the gate result is read inline but no branch around it ends the path' };
  }

  if (b.kind === 'unknown') {
    return { ok: null, why: 'the gate result is used in a shape this analysis does not recognise' };
  }

  // Bound. Look for a guard between the gate and the call that tests the binding and ends the path.
  let guard = null;
  let referenced = false;
  AST.walk(fnRecord.node, (n, ancestors) => {
    if (ancestors.some((a) => AST.FUNCTION_TYPES.has(a.type) && a !== fnRecord.node)) return;
    if (n.type === 'Identifier' && b.names.includes(n.name)
        && n.start > gate.start && n.start < call.start) referenced = true;
    if (n.type !== 'IfStatement') return;
    if (!(n.start > gate.start && n.start < call.start)) return;
    const ids = new Set();
    AST.walk(n.test, (t) => { if (t.type === 'Identifier') ids.add(t.name); });
    if (!b.names.some((nm) => ids.has(nm))) return;
    if (endsThePath(n.consequent) || (n.alternate && endsThePath(n.alternate))) guard = n;
  });

  if (guard) return { ok: true };
  if (referenced) {
    return { ok: null, why: `\`${b.names.join(', ')}\` is read before the send but no branch on it `
      + 'ends the path, so it cannot be shown that a refusal stops delivery' };
  }
  return { ok: false, why: `the gate's result is bound to \`${b.names.join(', ')}\` and never read `
    + 'before the send, so a refusal changes nothing' };
}

/**
 * Analyse one file. Returns:
 *   { sites, findings, unprovable }
 *
 * `sites` keeps the shape the allowlist, approval axis and violation ratchet already consume, so
 * those protections are untouched — only the way a site is FOUND has changed.
 * `findings` are { ok, message, detail } exactly as the previous ordering check produced.
 * `unprovable` are reasons the scanner must report INCOMPLETE rather than a verdict.
 */
function analyseFile({ file, src, ast, exception = null }) {
  const tree = ast || AST.parse(src, file);
  const functions = AST.functionsOf(tree);
  const byNode = new Map(functions.map((f) => [f.node, f]));
  const exported = AST.exportedNames(tree);

  const calls = providerCalls(tree);
  const gates = gateCalls(tree);

  // ── the two file-level axes, unchanged in meaning ──
  //
  // `gated`: the file knows about the gate, or reaches the mailer. `approvalBound`: it carries an
  // approval id and an expected digest. Both were regex tests over blanked text; both are now
  // tree facts, which closes the hole where a mention in a comment satisfied them.
  let requiresMailer = false;
  let approvalBound = false;
  AST.walk(tree, (node) => {
    if (node.type === 'CallExpression' && AST.dottedName(node.callee) === 'require') {
      const a = node.arguments && node.arguments[0];
      if (a && a.type === 'Literal' && /(^|\/)mailer$/.test(String(a.value))) requiresMailer = true;
    }
    if (node.type === 'Identifier' && node.name === 'expectedDigest') approvalBound = true;
    if (node.type === 'Identifier' && node.name === 'verifyReleasedApproval') approvalBound = true;
  });
  const gated = gates.length > 0 || requiresMailer;

  const sites = calls.map((c) => {
    const fn = byNode.get(c.enclosing) || null;
    return {
      file,
      line: c.line,
      transport: c.key,
      label: c.label,
      gated,
      approvalBound,
      enclosing: fn ? fn.name : null,
      // Deterministic and derived from the tree: the callee's own source text plus the paren.
      expression: `${src.slice(c.node.callee.start, c.node.callee.end)}(`,
      exception,
    };
  });

  // ── item 4: what cannot be proven ──
  const unprovable = AST.unprovableDispatch(tree, {
    providerSuffixes: PROVIDER_SUFFIXES,
    providerRoots: PROVIDER_ROOTS,
  }).map((u) => ({ ...u, file }));
  // Gate-result findings append to this list too, below.

  const findings = [];
  const say = (ok, message, detail) => findings.push({ ok, message, detail });

  // A file with no provider call has nothing to order.
  if (!calls.length) return { sites, findings, unprovable, gated, approvalBound };

  // ── is a gate on the path, and is it unconditional? ──
  for (const call of calls) {
    const fn = byNode.get(call.enclosing) || null;
    if (!fn) {
      say(false, `${file}:${call.line}: a ${call.label} call sits outside any function — it runs `
        + 'at import time, before any gate can have been consulted');
      continue;
    }

    const inSameFn = gates.filter((g) => g.enclosing === call.enclosing && g.start < call.start);
    const unconditional = inSameFn.filter((g) => guaranteedBefore(g, call));
    const conditional = inSameFn.filter((g) => !guaranteedBefore(g, call));

    if (unconditional.length) {
      // The gate RUNS. Item 2 of the 2026-11-12 review: that is not the same as the gate being
      // OBEYED, and until this check existed a discarded result was accepted as authorization.
      const honoured = unconditional
        .map((g) => ({ g, h: resultHonoured(g, call, fn) }))
        .sort((a, b2) => (a.h.ok === true ? -1 : 0) - (b2.h.ok === true ? -1 : 0));
      const best = honoured[0];
      if (best.h.ok === true) {
        say(true, `${file}: ${fn.name}() calls the gate on every path to ${call.label}, and a `
          + 'refusal ends the path before it');
      } else if (best.h.ok === false) {
        say(false,
          `${file}: ${fn.name}() calls the gate before ${call.label} but DOES NOT ACT ON THE ANSWER`,
          `${best.h.why}. A gate that is consulted and ignored is not a gate: the kill switch, the `
          + 'approval boundary and the recipient restriction all return a decision that nothing '
          + 'enforces.');
      } else {
        unprovable.push({ why: 'gate-result-unproven', file, line: call.line,
          detail: `${fn.name}() calls the gate before ${call.label}, but ${best.h.why}` });
        say(false,
          `${file}: ${fn.name}() reaches ${call.label} and it cannot be proven that a refusal `
          + 'stops it',
          `${best.h.why}. Reported as unprovable rather than as either a pass or a finding.`);
      }
      continue;
    }

    // ── THE CONDITIONAL-GATE CONTROL ──────────────────────────────────────
    //
    // A gate the caller can step around is not a gate. This is the check whose absence let the
    // C-4 bypass pass the scanner while failing its own test suite.
    if (conditional.length) {
      const s = skippability(conditional[0], fn, call);
      const where = s.by.map((b) => b.kind).join(', then inside ');
      if (s.callerControlled) {
        const p = s.by.find((b) => b.param);
        say(false,
          `${file}: ${fn.name}() reaches ${call.label} and its only gate is CALLER-SKIPPABLE`,
          `The ${GATE}() call sits inside ${where}, and the condition tests \`${p.param}\`, which `
          + `is a parameter of ${fn.name}(). Any caller can pass a value that skips authorization `
          + 'entirely — no kill switch, no approval boundary, no recipient restriction. This is '
          + 'the C-4 defect, and it is what a text-ordering check cannot see.');
      } else {
        say(false,
          `${file}: ${fn.name}() reaches ${call.label} and its only gate is conditional`,
          `The ${GATE}() call sits inside ${where}, so there is a path to the provider on which `
          + 'it does not run. A gate must be on EVERY path, not merely present.');
      }
      continue;
    }

    // ── one proven level of indirection ──
    if (!fn.name) {
      say(false, `${file}:${call.line}: an anonymous function reaches ${call.label} with no gate `
        + 'of its own, so no caller can be identified');
      continue;
    }
    if (exported.has(fn.name)) {
      say(false,
        `${file}: ${fn.name}() reaches ${call.label} without calling the gate, and is EXPORTED`,
        'An exported function that transmits without gating is callable by every module that '
        + 'imports this file — which is the C-4 bypass with a different spelling.');
      continue;
    }
    const callers = AST.callsTo(tree, fn.name)
      .filter((c) => c.enclosing !== fn.node)
      .map((c) => ({ call: c, fn: byNode.get(c.enclosing) || null }));
    if (!callers.length) {
      say(false,
        `${file}: ${fn.name}() reaches ${call.label} without the gate and has no in-file caller`,
        'There is no path on which the gate can be shown to run first. If it is dead code, '
        + 'delete it.');
      continue;
    }
    // Each caller must gate unconditionally AND act on the answer. The second half was missing
    // here too: a caller that consulted the gate and ignored it would have been accepted, which is
    // item 2 of the review arriving by the indirect road.
    const verdicts = callers.map((c) => {
      if (!c.fn) return { c, state: 'no-function' };
      const g = gates.filter((x) => x.enclosing === c.call.enclosing && guaranteedBefore(x, c.call));
      if (!g.length) return { c, state: 'ungated' };
      const h = g.map((x) => resultHonoured(x, c.call, c.fn))
        .sort((a, b2) => (a.ok === true ? -1 : 0) - (b2.ok === true ? -1 : 0))[0];
      if (h.ok === true) return { c, state: 'ok' };
      if (h.ok === false) return { c, state: 'ignores-answer', why: h.why };
      return { c, state: 'unproven', why: h.why };
    });
    const ungated = verdicts.filter((v) => v.state === 'ungated' || v.state === 'no-function');
    const ignoring = verdicts.filter((v) => v.state === 'ignores-answer');
    const unproven = verdicts.filter((v) => v.state === 'unproven');
    const named = (v) => (v.c.fn ? `${v.c.fn.name}()` : 'an anonymous function');

    if (ungated.length) {
      say(false,
        `${file}: ${fn.name}() reaches ${call.label} and ${ungated.length} of its ${callers.length} `
        + 'caller(s) do not gate unconditionally first',
        ungated.map((v) => `${named(v)} calls ${fn.name}() with no unconditional ${GATE}() before it`)
          .join('\n          '));
      continue;
    }
    if (ignoring.length) {
      say(false,
        `${file}: ${fn.name}() reaches ${call.label} and ${ignoring.length} of its `
        + `${callers.length} caller(s) consult the gate WITHOUT ACTING ON THE ANSWER`,
        ignoring.map((v) => `${named(v)}: ${v.why}`).join('\n          '));
      continue;
    }
    if (unproven.length) {
      for (const v of unproven) {
        unprovable.push({ why: 'gate-result-unproven', file, line: v.c.call.line,
          detail: `${named(v)} calls ${fn.name}(), but ${v.why}` });
      }
      say(false,
        `${file}: ${fn.name}() reaches ${call.label} and for ${unproven.length} of its `
        + `${callers.length} caller(s) it cannot be proven that a refusal stops the send`,
        unproven.map((v) => `${named(v)}: ${v.why}`).join('\n          '));
      continue;
    }
    say(true, `${file}: ${call.label} is reached only through ${fn.name}(), and all `
      + `${callers.length} caller(s) gate unconditionally and refuse on a denial`);
  }

  return { sites, findings, unprovable, gated, approvalBound };
}

module.exports = { analyseFile, providerCalls, gateCalls, skippability, guaranteedBefore,
  resultHonoured, gateBinding, endsThePath, TRANSPORT_SHAPES,
  PROVIDER_ROOTS, PROVIDER_SUFFIXES, GATE, RESEND_URL_IDENT };
