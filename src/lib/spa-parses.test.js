// THE SPA MUST PARSE. This is the test that should have existed before today.
//   node --test src/lib/spa-parses.test.js
//
// A syntax error anywhere in the main inline <script> means NOTHING renders: no nav, no pages, no data. It
// presents as "the page is not loading" AND "this screen shows no data" at the same time, which reads like
// two bugs and is one. The server stays perfectly healthy — /health returns 200, the DB is connected, the
// container logs are EMPTY — so nothing alerts and nobody finds out until a person opens the app.
//
// That is what happened on 2026-09-30. `async function outreachPage()` was inserted at line 2155, inside
// the `const pages = { ... }` object literal that opens at line 1779. A function declaration is not a valid
// object member, so the whole block failed and production was down from commit 8a1144f until the rollback.
//
// I HAD A CHECKER AND STILL SHIPPED IT. It lived in /tmp as a throwaway and I ran it as
// `node /tmp/spa-check.js | tail -1`, read "block 6 ... OK", and moved on — the failure was in block 1 and
// `tail -1` hid it. A per-block report piped through tail is not a verdict. So the check now lives in the
// suite, where it cannot be truncated, cannot be forgotten, and runs on every commit.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'public', 'index.html');
const SRC = fs.readFileSync(FILE, 'utf8');

// Inline scripts only — a <script src=...> is somebody else's file.
function inlineBlocks(src) {
  return [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => ({
    code: m[1], line: src.slice(0, m.index).split('\n').length, chars: m[1].length,
  }));
}

test('every inline script in index.html parses', () => {
  const blocks = inlineBlocks(SRC);
  assert.ok(blocks.length >= 5, `expected the SPA's inline scripts, found ${blocks.length}`);
  const failures = [];
  for (const b of blocks) {
    // `new Function` compiles without executing: it catches a SyntaxError and nothing else.
    try { new Function(b.code); }
    catch (e) { failures.push(`index.html:${b.line} (${b.chars} chars) — ${e.message}`); }
  }
  assert.deepEqual(failures, [],
    `\n${failures.length} inline script block(s) do not parse. The SPA will render NOTHING — no nav, no\n` +
    `pages, no data — while /health stays 200 and the container logs stay empty:\n\n  ` +
    failures.join('\n  ') + '\n');
});

test('the biggest block is the app, and it parses', () => {
  // Named separately because this is the one whose failure takes the whole application with it. If the main
  // block ever stops being the biggest, that is worth noticing too.
  const blocks = inlineBlocks(SRC).sort((a, b) => b.chars - a.chars);
  const main = blocks[0];
  assert.ok(main.chars > 100000, `the main script is only ${main.chars} chars — has it been split?`);
  new Function(main.code);   // throws the SyntaxError directly, with its own message
});

test('no function DECLARATION sits inside the pages object literal', () => {
  // The specific shape of the outage, checked directly: `const pages = {` ... `}` may contain methods
  // (`async team() {`) but not declarations (`async function x() {`). This is cheaper to read than a parse
  // error and names the actual mistake.
  const open = SRC.indexOf('const pages = {');
  assert.notEqual(open, -1, 'could not find the pages object');
  // Walk braces to find the literal's end, ignoring strings is unnecessary here because we only need the
  // first unbalanced close at depth 0 and the object is brace-balanced in practice.
  let depth = 0, end = -1;
  for (let i = open; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, 'could not find the end of the pages object');
  const body = SRC.slice(open, end);
  const decls = [...body.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map(m => m[1]);
  assert.deepEqual(decls, [],
    `\nthese are declared INSIDE the pages object literal, which is a syntax error:\n  ` +
    decls.join('\n  ') + `\n\nDeclare them before \`const pages\` and attach with pages['x'] = fn.\n`);
});
