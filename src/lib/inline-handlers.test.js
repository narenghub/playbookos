// EVERY FUNCTION AN INLINE HANDLER CALLS MUST BE REACHABLE FROM THE GLOBAL SCOPE.
//   node --test src/lib/inline-handlers.test.js
//
// THE BUG THIS EXISTS FOR. The Agent Control "Run now" button did nothing at all — no request, no error.
// product_shadow_log recorded ZERO requests to /api/agent/mission-control/*/run and there were zero
// manual_run_error rows, so nothing was blocking it: the request was never sent.
//
// `mcTrigger` was declared as `async function mcTrigger(...)` inside the block that starts
// `if (typeof pages !== 'undefined') {`. A PLAIN function declared in a block is hoisted into the global
// scope by Annex B (B.3.3) — which is why `acTab`, declared two lines above it, worked fine from an
// inline onclick. That rule explicitly does not cover ASYNC functions, so mcTrigger existed only inside
// the block and `onclick="mcTrigger(...)"` threw ReferenceError into the console.
//
// It is a silent failure by construction: an inline handler that throws leaves no trace in the UI. So the
// invariant is checked mechanically rather than by clicking things.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const path = require('path');

const PUBLIC = path.join(__dirname, '../../public');
const SRC = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const LINES = SRC.split('\n');

// ── FOLLOW <script src> ───────────────────────────────────────────────────────
//
// The UI is no longer one file. Scanning only index.html made this test blind in BOTH directions: it
// collected neither the handlers an external file declares nor the onclicks that file generates, so a new
// page could ship with every one of its buttons dead and every assertion here still green.
//
// Protocol-relative and absolute URLs are skipped — a CDN script is not ours to check and cannot be read
// from disk. A LOCAL src that does not resolve to a file is a FAILURE, not a skip: a missing script is a
// page whose handlers are all undefined, which is the loudest possible version of this bug and the easiest
// to cause with a typo in a path.
function externalScripts(html) {
  // Comments blanked first, so a <script src> written inside an explanatory comment is not chased.
  const scrubbed = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  return [...scrubbed.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)].map(m => m[1]);
}

const EXTERNAL = [];
const SKIPPED = [];
for (const src of externalScripts(SRC)) {
  if (/^(https?:)?\/\//.test(src)) { SKIPPED.push(src); continue; }
  const rel = src.replace(/^\//, '').split('?')[0];
  const full = path.join(PUBLIC, rel);
  assert.ok(fs.existsSync(full),
    `index.html loads <script src="${src}"> but ${full} does not exist — every handler in it would be ` +
    `undefined and every button it draws would silently do nothing`);
  EXTERNAL.push({ src, file: full, code: fs.readFileSync(full, 'utf8') });
}

// Every source that can DECLARE a global or NAME a handler.
const ALL_SOURCES = [{ src: 'index.html', code: SRC, inline: true },
                     ...EXTERNAL.map(e => ({ ...e, inline: false }))];

// NOTE ON THE REGEX: use [ \t]+, never \s+. `\s` matches a NEWLINE, so /^\s+async function/ with the m
// flag happily starts at one line's beginning, eats the line break, and matches an UNINDENTED declaration
// on the next line. That false positive reported 50 broken functions here when the real answer was one.
const INDENTED_ASYNC = /^[ \t]+async function ([A-Za-z0-9_$]+)[ \t]*\(/;

test('no async function is declared INDENTED — it would be block-scoped, not global', () => {
  const found = [];
  LINES.forEach((l, i) => { const m = INDENTED_ASYNC.exec(l); if (m) found.push(`${m[1]} (line ${i + 1})`); });
  assert.deepEqual(found, [],
    `\nthese async functions are declared inside a block, so Annex B does NOT hoist them to global. If an\n` +
    `inline handler names one, clicking it throws ReferenceError and nothing happens:\n  ` +
    found.join('\n  ') + `\n\nFix: \`window.name = async function name(...)\`.\n`);
});

test('every function named by an inline handler is declared at the top level or on window', () => {
  // Collect the identifiers actually invoked from on*="..." attributes.
  const called = new Set();
  // From EVERY source, not just index.html — an external file's handlers are named inside the HTML strings
  // it builds, so scanning only the shell finds none of them.
  const allHandlerText = ALL_SOURCES.map(x => x.code).join('\n');
  for (const m of allHandlerText.matchAll(/\son(?:click|change|input|submit|keydown|keyup|blur|focus|mouseover|mouseout)="([^"]*)"/g)) {
    // Two things are deliberately excluded:
    //   ${...}  — a template interpolation is evaluated when the HTML is BUILT, in the enclosing function's
    //             scope, so `onclick="f('${esc(x)}')"` calls esc at render time and only f on click.
    //   a.b(    — a method call, so `el.remove(` is not read as a global named remove.
    const attr = m[1].replace(/\$\{[^}]*\}/g, "''");
    for (const f of attr.matchAll(/(?<![.$\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) called.add(f[1]);
  }
  assert.ok(called.size > 100, `only ${called.size} handler calls found — the scanner has stopped working`);

  // Anything reachable as a global: a column-0 declaration, a column-0 const/let/var, or window.x = ...
  const globals = new Set();
  for (const m of SRC.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)/gm)) globals.add(m[1]);
  for (const m of SRC.matchAll(/^(?:const|let|var) ([A-Za-z0-9_$]+)/gm)) globals.add(m[1]);
  for (const m of SRC.matchAll(/window\.([A-Za-z0-9_$]+)\s*=/g)) globals.add(m[1]);

  // AN EXTERNAL FILE CONTRIBUTES ONLY window.* AND COLUMN-0 DECLARATIONS. Deliberately TIGHTER than the
  // rules for the inline script: the Annex B allowance below (an indented plain `function` hoisting to the
  // enclosing var scope) is not extended to these files, because a file that wraps itself in an IIFE —
  // which a separate file reasonably might — has a var scope that is NOT global, and its internals must
  // still read as unreachable. Column-0 in a non-IIFE file is global, so both halves stay honest.
  for (const e of EXTERNAL) {
    for (const m of e.code.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)/gm)) globals.add(m[1]);
    for (const m of e.code.matchAll(/^(?:const|let|var) ([A-Za-z0-9_$]+)/gm)) globals.add(m[1]);
    for (const m of e.code.matchAll(/window\.([A-Za-z0-9_$]+)\s*=/g)) globals.add(m[1]);
  }
  // A PLAIN function declared inside a block IS reachable globally — Annex B hoists it into the enclosing
  // var scope, which for this script is global. That is exactly why acTab worked and mcTrigger did not,
  // and why the first test above is specifically about async declarations.
  LINES.forEach(l => { const m = /^[ \t]+function ([A-Za-z0-9_$]+)[ \t]*\(/.exec(l); if (m) globals.add(m[1]); });

  // Built-ins and DOM/host functions that appear in handlers and are not ours to declare.
  const HOST = new Set(['alert', 'confirm', 'prompt', 'parseInt', 'parseFloat', 'String', 'Number',
    'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout', 'JSON', 'Math', 'Date',
    'event', 'this', 'return', 'if', 'for', 'while', 'typeof', 'new', 'Boolean', 'Array', 'Object',
    'fetch', 'console', 'requestAnimationFrame', 'isNaN', 'Promise']);

  const missing = [...called].filter(n => !globals.has(n) && !HOST.has(n));
  assert.deepEqual(missing, [],
    `\nthese functions are named by an inline handler but are not reachable from the global scope, so\n` +
    `clicking throws ReferenceError and the control silently does nothing:\n  ` + missing.join('\n  ') + '\n');
});

test('mcTrigger specifically is on window, and still sends the request it used to', () => {
  assert.match(SRC, /window\.mcTrigger = async function mcTrigger\(/,
    'the Run button handler must be an explicit global');
  const fn = SRC.slice(SRC.indexOf('window.mcTrigger = async function'));
  assert.match(fn.slice(0, 900), /agent\/mission-control\/'\s*\+\s*encodeURIComponent\(key\)\s*\+\s*'\/run/,
    'and it must still post to the run route');
});

test("the Run button's key comes from the same list the server runs", () => {
  // The other half of the original hypothesis, worth pinning now it has been checked: the card renders
  // a.key from GET /api/agent/mission-control, which is built from MC_AGENTS, and MC_RUNNERS +
  // AGENT_PRODUCT are keyed identically. A key present in one and missing from another fails closed and
  // looks like a broken button.
  const routes = fs.readFileSync(__dirname + '/../api/routes.js', 'utf8');
  const agentsBlock = routes.slice(routes.indexOf('const MC_AGENTS = ['), routes.indexOf('// Manual-trigger runners'));
  const runnersBlock = routes.slice(routes.indexOf('const MC_RUNNERS = {'), routes.indexOf('const MC_RUNNING'));
  const agents = [...agentsBlock.matchAll(/key:\s*'([a-z-]+)'/g)].map(m => m[1]);
  const runners = [...runnersBlock.matchAll(/'([a-z-]+)':/g)].map(m => m[1]);
  const { AGENT_PRODUCT } = require('./products/route-map');
  const mapped = Object.keys(AGENT_PRODUCT);
  assert.ok(agents.length >= 9, `parsed only ${agents.length} MC_AGENTS keys`);
  assert.deepEqual(runners.sort(), agents.sort(), 'every card shown must have a runner');
  assert.deepEqual(mapped.sort(), agents.sort(),
    'every runnable agent must have a product, or the boundary fails closed and the button looks broken');
});
