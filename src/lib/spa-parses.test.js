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

// Where the `pages` object literal starts and ends.
//
// NOT by counting braces. The literal is full of template strings containing { and } (and regexes), so a
// brace walk never balances — it returned "could not find the end" and failed this very test. The file's
// own structure is the reliable anchor: the literal closes at the first column-0 `};` after it opens.
function pagesLiteral(src) {
  const lines = src.split('\n');
  const open = lines.findIndex(l => l.startsWith('const pages = {'));
  if (open === -1) return null;
  let close = -1;
  for (let i = open + 1; i < lines.length; i++) if (lines[i] === '};') { close = i; break; }
  if (close === -1) return null;
  return { open: open + 1, close: close + 1, body: lines.slice(open, close + 1).join('\n') };
}


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
  // The exact shape of the 2026-09-30 outage, checked directly: `const pages = {` may contain METHODS
  // (`async team() {`) but not DECLARATIONS (`async function x() {`). Cheaper to read than a parse error,
  // and it names the mistake.
  const lit = pagesLiteral(SRC);
  assert.ok(lit, 'could not locate the pages object literal');
  const decls = [...lit.body.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map(m => m[1]);
  assert.deepEqual(decls, [],
    `\nthese are declared INSIDE the pages object literal (lines ${lit.open}-${lit.close}), which is a syntax\n` +
    `error that kills the whole app:\n  ` + decls.join('\n  ') +
    `\n\nDeclare them before \`const pages\` and attach with pages['x'] = fn.\n`);
});

test('outreachPage specifically is declared before the literal and attached after it', () => {
  // The function that caused the outage, named so a future move gets told which one.
  const lit = pagesLiteral(SRC);
  const decl = SRC.split('\n').findIndex(l => l.startsWith('async function outreachPage()')) + 1;
  if (!decl) return;                                    // not present (e.g. rolled back) — nothing to check
  assert.ok(decl < lit.open,
    `outreachPage is declared at line ${decl}, inside or after the pages literal (${lit.open}-${lit.close}). ` +
    `It must be declared BEFORE it.`);
  const attach = SRC.split('\n').findIndex(l => l.startsWith("pages['outreach'] = outreachPage")) + 1;
  assert.ok(attach > lit.close,
    `the attachment is at line ${attach}; it must come AFTER the literal closes at ${lit.close}`);
});
