// ── THE SCANNER'S QUESTIONS, ASKED OF A PARSE TREE ───────────────────────────
//
//   const AST = require('./js-ast');
//
// Replaces the text-and-heuristics layer underneath the outbound transport scanner. CEO decision
// 2026-11-12: "Replace the security-critical lexer-based discovery and ordering assumptions with
// AST-based analysis."
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Three defects in three days, all the same shape — a proxy standing in for the property:
//
//   · the pre-pass did not understand regex literals, so a quote inside one erased a function
//     declaration and the scanner reported PASS over code it had not read. A planted ungated
//     Gmail sender after such a regex produced ZERO discovered call sites.
//   · the ordering check compared positions in file TEXT. It condemned a correct refactor, and —
//     worse — it PASSED a file whose second provider call was exported and ungated, because it
//     only ever looked at the first one.
//   · and the check that replaced it proved a gate was ON the path while being unable to see that
//     the gate was skippable, because `assertSendAllowed` inside a ternary is still, textually,
//     before the call.
//
// Every one of those is a question about structure answered by looking at characters. A parser
// makes them questions about structure answered by looking at structure. `a++ / b / c` is a
// division because the tree says so, not because a heuristic guessed; a gate inside a
// ConditionalExpression is skippable because the tree says so.
//
// ── THE PARSER ───────────────────────────────────────────────────────────────
//
// acorn, exact-pinned, DEV DEPENDENCY ONLY. No network capability, zero transitive dependencies,
// MIT, and it is the parser Node vendors internally. It never executes what it reads.
//
// IT DOES NOT FALL BACK. If acorn is missing, every function here throws and the scanner reports
// INCOMPLETE. A silent fallback to the lexer being replaced is precisely how this defect class
// survived three attempts at fixing it.

'use strict';

let acorn = null;
let acornError = null;
try {
  acorn = require('acorn');
} catch (e) {
  acornError = e;
}

/** Is the parser available? The scanner asks before concluding anything. */
function parserAvailable() {
  return acorn !== null;
}

function parserMissingReason() {
  return acornError
    ? `the JavaScript parser (acorn) is not installed: ${acornError.message}. This scanner does `
      + 'NOT fall back to text matching — a quieter scan is not a safer one.'
    : null;
}

/**
 * Parse a file. Tries script then module, so a CommonJS file and an ESM file both parse — the
 * previous implementation reported INCOMPLETE for ESM because `new vm.Script` rejects it.
 *
 * Throws on genuinely invalid syntax. The caller turns that into INCOMPLETE.
 */
function parse(src, filename = '<anonymous>') {
  if (!acorn) throw new Error(parserMissingReason());
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true };
  try {
    return acorn.parse(src, { ...opts, sourceType: 'script' });
  } catch (scriptErr) {
    try {
      return acorn.parse(src, { ...opts, sourceType: 'module', allowAwaitOutsideFunction: true });
    } catch (moduleErr) {
      const e = new Error(`${filename} does not parse as script or module: ${scriptErr.message}`);
      e.scriptError = scriptErr;
      e.moduleError = moduleErr;
      throw e;
    }
  }
}

// ── WALKING ──────────────────────────────────────────────────────────────────
//
// Written here rather than taking acorn-walk as a second dependency: the whole walk is twenty
// lines, and one dependency in a security path is easier to review than two.

const SKIP = new Set(['start', 'end', 'loc', 'range', 'type']);

/**
 * Depth-first walk. `visit(node, ancestors)` is called for every node; `ancestors` is the chain
 * from the root down to (not including) `node`, so a visitor can ask what encloses what — which is
 * the question the text version could only guess at.
 */
function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, ancestors);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = ancestors.concat([node]);
  for (const key of Object.keys(node)) {
    if (SKIP.has(key)) continue;
    walk(node[key], visit, next);
  }
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression',
  'ArrowFunctionExpression']);

/** The dotted source name of a callee, or null when any link is computed or dynamic. */
function dottedName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') {
    if (node.computed) return null;                      // obj[expr] — not a static name
    const left = dottedName(node.object);
    if (left === null) return null;
    const right = node.property.type === 'Identifier' ? node.property.name
      : (node.property.type === 'Literal' ? String(node.property.value) : null);
    if (right === null) return null;
    return `${left}.${right}`;
  }
  if (node.type === 'CallExpression') {
    // `foo().bar` — the receiver is a call, so the name is not static above this point.
    return null;
  }
  return null;
}

/**
 * The TRAILING property chain of a member expression, regardless of what the base is.
 *
 * `dottedName` returns null the moment any link is dynamic, which is right for naming a callee and
 * WRONG for recognising a transport: `(await client()).users.messages.send(m)` is a Gmail send, and
 * the regex it replaced matched it because the regex only ever looked at `.users.messages.send(`.
 * Caught by the control `an unusual receiver does not hide a transport` — the AST version was
 * briefly less capable than the regex, which is exactly the silent coverage loss this scanner
 * exists to prevent.
 *
 * So: walk up the non-computed member links and return what they spell, ignoring the base.
 * `(await c()).users.messages.send` → "users.messages.send".
 */
function propertySuffix(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  const parts = [];
  let cur = node;
  while (cur && cur.type === 'MemberExpression') {
    if (cur.computed) {
      // A computed link breaks the chain. What is above it is still a suffix in its own right, and
      // the computed call itself is reported separately as unprovable.
      break;
    }
    const name = cur.property.type === 'Identifier' ? cur.property.name
      : (cur.property.type === 'Literal' ? String(cur.property.value) : null);
    if (name === null) break;
    parts.unshift(name);
    cur = cur.object;
  }
  return parts.length ? parts.join('.') : null;
}

/**
 * The name a function is known by, inferred from its own id or from what it is assigned to.
 * Covers `function f(){}`, `const f = function(){}`, `const f = () => {}`, `obj.f = function(){}`
 * and `{ f() {} }` — the text version saw only the first three.
 */
function functionName(fnNode, ancestors) {
  if (fnNode.id && fnNode.id.name) return fnNode.id.name;
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator' && parent.id && parent.id.name) return parent.id.name;
  if (parent.type === 'AssignmentExpression') return dottedName(parent.left);
  if (parent.type === 'Property' && parent.key) {
    return parent.key.name || (parent.key.value !== undefined ? String(parent.key.value) : null);
  }
  if (parent.type === 'MethodDefinition' && parent.key) return parent.key.name || null;
  return null;
}

/** Every function in the file, innermost-last, with its name, params and extent. */
function functionsOf(ast) {
  const out = [];
  walk(ast, (node, ancestors) => {
    if (!FUNCTION_TYPES.has(node.type)) return;
    out.push({
      node,
      name: functionName(node, ancestors),
      params: (node.params || []).flatMap(paramNames),
      start: node.start,
      end: node.end,
      line: node.loc ? node.loc.start.line : null,
      depth: ancestors.filter((a) => FUNCTION_TYPES.has(a.type)).length,
    });
  });
  return out;
}

/** Parameter names, including destructured ones — `{ to, subject }` contributes both. */
function paramNames(param) {
  if (!param) return [];
  switch (param.type) {
    case 'Identifier': return [param.name];
    case 'AssignmentPattern': return paramNames(param.left);
    case 'RestElement': return paramNames(param.argument);
    case 'ArrayPattern': return (param.elements || []).flatMap(paramNames);
    case 'ObjectPattern':
      return (param.properties || []).flatMap((p) => (p.type === 'RestElement'
        ? paramNames(p.argument)
        : paramNames(p.value && p.value.type ? p.value : p.key)));
    default: return [];
  }
}

/**
 * The innermost function containing `offset`. Unlike the text version — which took the last
 * top-level `function` declaration before the offset and so attributed a call to whatever happened
 * to be declared above it — this is the actual enclosing scope.
 */
function enclosingFunction(ast, offset) {
  let best = null;
  for (const fn of functionsOf(ast)) {
    if (fn.start <= offset && offset < fn.end) {
      if (!best || fn.start > best.start) best = fn;
    }
  }
  return best;
}

// ── CONDITIONALITY: IS THIS CALL ON EVERY PATH? ─────────────────────────────
//
// The question C-4 exposed. `assertSendAllowed` inside
//
//     const gate = internal.alertAlreadyAuthorized ? { allowed: true } : await assertSendAllowed(…)
//
// is textually before the provider call and is reached on only one of two paths. The tree says so
// outright: the call sits inside a ConditionalExpression.
//
// Returns the list of branching constructs between the enclosing function and the call. Empty
// means the call is unconditional within that function. A `try` block does not count: a call
// inside one still executes.
const BRANCHING = {
  ConditionalExpression: 'a ternary',
  IfStatement: 'an if statement',
  SwitchCase: 'a switch case',
  LogicalExpression: 'a short-circuit (&& or ||)',
  ForStatement: 'a for loop',
  ForOfStatement: 'a for-of loop',
  ForInStatement: 'a for-in loop',
  WhileStatement: 'a while loop',
  DoWhileStatement: 'a do-while loop',
  CatchClause: 'a catch clause',
};

function branchesAbove(node, ancestors, stopAt = null) {
  const out = [];
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const a = ancestors[i];
    if (stopAt && a === stopAt) break;
    if (FUNCTION_TYPES.has(a.type) && a !== stopAt) {
      // A different function entirely — stop; conditionality is per-function.
      if (!stopAt) break;
    }
    const kind = BRANCHING[a.type];
    if (!kind) continue;
    // An `if` only branches its own consequent/alternate, not its test: a call in the TEST runs
    // unconditionally. Same for the left side of a short-circuit.
    if (a.type === 'IfStatement' && ancestors[i + 1] === a.test) continue;
    if (a.type === 'LogicalExpression' && ancestors[i + 1] === a.left) continue;
    if (a.type === 'ConditionalExpression' && ancestors[i + 1] === a.test) continue;
    out.push({ node: a, type: a.type, kind, line: a.loc ? a.loc.start.line : null });
  }
  return out;
}

/**
 * The branching nodes between `entry` and its enclosing function, as identities.
 *
 * Identities rather than descriptions, because the question that matters is not "is this call
 * inside a branch" but "is it inside a branch that some OTHER call is outside of". See
 * guaranteedBefore() in outbound-ast-analysis.js: a gate and a provider call sharing one loop are
 * both inside a branch and the gate is still guaranteed to run before the call.
 */
function branchNodesOf(entry) {
  return new Set(branchesAbove(entry.node, entry.ancestors, entry.enclosing).map((b) => b.node));
}

/**
 * Every call to `name` (a dotted callee, matched exactly or by suffix) with where it sits and what
 * branches above it inside its enclosing function.
 */
function callsTo(ast, matches) {
  const test = typeof matches === 'function'
    ? matches
    : (dotted) => dotted === matches || (dotted || '').endsWith(`.${matches}`);
  const out = [];
  walk(ast, (node, ancestors) => {
    if (node.type !== 'CallExpression') return;
    const dotted = dottedName(node.callee);
    // The matcher is given BOTH: the full dotted name when it is static, and the trailing property
    // chain, which survives a dynamic receiver. See propertySuffix().
    const suffix = propertySuffix(node.callee);
    if (!test(dotted, node, suffix)) return;
    const fnAncestors = ancestors.filter((a) => FUNCTION_TYPES.has(a.type));
    const fn = fnAncestors.length ? fnAncestors[fnAncestors.length - 1] : null;
    out.push({
      node,
      dotted,
      start: node.start,
      line: node.loc ? node.loc.start.line : null,
      enclosing: fn,
      branches: branchesAbove(node, ancestors, fn),
      ancestors,
    });
  });
  return out;
}

// ── WHAT IS EXPORTED ─────────────────────────────────────────────────────────
//
// The text version tested `new RegExp('\\b' + name + '\\b')` against everything after
// `module.exports`, which matches a name appearing in a trailing comment as readily as in the
// export itself.

function exportedNames(ast) {
  const names = new Set();
  const addPattern = (node) => {
    if (!node) return;
    if (node.type === 'ObjectExpression') {
      for (const p of node.properties || []) {
        if (p.type !== 'Property') continue;
        const key = p.key && (p.key.name || p.key.value);
        if (key !== undefined && key !== null) names.add(String(key));
        const v = dottedName(p.value);
        if (v) names.add(v);
      }
      return;
    }
    const d = dottedName(node);
    if (d) names.add(d);
  };
  walk(ast, (node) => {
    if (node.type === 'AssignmentExpression') {
      const left = dottedName(node.left);
      if (left === 'module.exports') { addPattern(node.right); return; }
      if (left && left.startsWith('exports.')) {
        names.add(left.slice('exports.'.length));
        const v = dottedName(node.right);
        if (v) names.add(v);
      }
      return;
    }
    // ESM, so the same analysis works on a module if one ever appears.
    if (node.type === 'ExportNamedDeclaration') {
      for (const s of node.specifiers || []) {
        if (s.exported && s.exported.name) names.add(s.exported.name);
        if (s.local && s.local.name) names.add(s.local.name);
      }
      if (node.declaration) {
        if (node.declaration.id && node.declaration.id.name) names.add(node.declaration.id.name);
        for (const d of node.declaration.declarations || []) {
          if (d.id && d.id.name) names.add(d.id.name);
        }
      }
    }
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
  });
  return names;
}

// ── WHAT CANNOT BE PROVEN ────────────────────────────────────────────────────
//
// CEO decision item 4: "Analyze computed provider calls and indirect dispatch where possible.
// Return INCOMPLETE for cases that cannot be proven safe."
//
// Two shapes no static analysis settles, and both would make a provider call invisible to a
// name-matching scanner:
//
//   1. COMPUTED DISPATCH — `obj[name](...)`, where the method is chosen at run time. Common and
//      harmless almost everywhere, so it is reported only where the receiver could plausibly be a
//      provider object: the chain's static prefix reaches into a known provider path.
//   2. ALIASING — `const send = g.gmail.users.messages.send;` then `send(msg)`. The call site no
//      longer names the transport at all. Any reference to a provider method that is NOT itself a
//      call is reported, because taking the function value is the only reason to write it.
//
// Both are returned as unprovable rather than as findings: the honest answer is that this scanner
// cannot see through them.

function unprovableDispatch(ast, { providerSuffixes, providerRoots }) {
  const out = [];
  const suffixMatch = (dotted) => dotted
    && providerSuffixes.some((s) => dotted === s || dotted.endsWith(`.${s}`));

  walk(ast, (node, ancestors) => {
    // 1. computed member call whose static prefix reaches into a provider path
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'MemberExpression'
        && node.callee.computed) {
      const prefix = dottedName(node.callee.object);
      const key = node.callee.property;
      const literalKey = key && key.type === 'Literal' ? String(key.value) : null;
      if (literalKey === null && prefix
          && providerRoots.some((r) => prefix === r || prefix.endsWith(`.${r}`)
            || prefix.includes(`${r}.`))) {
        out.push({
          why: 'computed-dispatch',
          detail: `${prefix}[<computed>](…) — the method is chosen at run time on a provider path`,
          line: node.loc ? node.loc.start.line : null,
        });
      }
      return;
    }
    // 2. a provider method referenced without calling it — i.e. its value is being taken
    if (node.type === 'MemberExpression' && !node.computed) {
      const dotted = dottedName(node);
      if (!suffixMatch(dotted)) return;
      const parent = ancestors[ancestors.length - 1];
      const isTheCallee = parent && parent.type === 'CallExpression' && parent.callee === node;
      const isDeeperMember = parent && parent.type === 'MemberExpression' && parent.object === node;
      if (isTheCallee || isDeeperMember) return;
      out.push({
        why: 'aliased-provider-method',
        detail: `${dotted} is referenced without being called — the value is being taken, so a `
          + 'later call through it names no transport',
        line: node.loc ? node.loc.start.line : null,
      });
    }
  });
  return out;
}

module.exports = {
  parserAvailable, parserMissingReason, parse, walk, dottedName, propertySuffix,
  functionsOf, functionName,
  paramNames, enclosingFunction, callsTo, branchesAbove, branchNodesOf, exportedNames,
  unprovableDispatch,
  FUNCTION_TYPES, BRANCHING,
};
