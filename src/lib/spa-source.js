// ── READING public/index.html AS A STRUCTURE ───────────────────────────────────
//
// The SPA is one HTML file with several inline scripts plus a couple of external ones, and a surprising
// number of tests and checkers need to ask structural questions about it: where does the `pages` literal
// end, which scripts does it load, which parts are comments. Each of those has a non-obvious answer, and
// each has already been got wrong at least once.
//
// This is their ONE HOME. Four separate copies of the brace-counting below existed at one point — in an edit
// script and in two tests — and two of them were wrong in the same way.
//
// Consumers: src/lib/spa-parses.test.js, src/lib/nav-targets.test.js, scripts/check-spa-parse.js.

// THE END OF `const pages = { ... }` CANNOT BE FOUND BY COUNTING BRACES.
//
// The literal is ~200KB of page functions whose bodies are full of template strings, and a template string
// contains `{` and `}` — so a counter goes out of balance on the first `${…}` and reports an end thousands of
// lines early or never. Naive counting failed twice, once in an edit script that then corrupted the file and
// once in two tests that reported "could not find the end of the pages object".
//
// The reliable anchor is the first line that is exactly `};` at COLUMN 0. Every member of the literal is
// indented or is a column-0 method shorthand, and nothing inside a template string begins a line at column 0
// with those two characters, because the file's own style never does.
function pagesLiteral(src) {
  const lines = src.split('\n');
  const open = lines.findIndex(l => l.startsWith('const pages = {'));
  if (open === -1) return null;
  let close = -1;
  for (let i = open + 1; i < lines.length; i++) if (lines[i] === '};') { close = i; break; }
  if (close === -1) return null;
  return { open: open + 1, close: close + 1, body: lines.slice(open, close + 1).join('\n') };
}

// HTML comments blanked, LINE COUNT PRESERVED, so reported line numbers stay right.
//
// Needed by anything that scans the shell for a pattern it also EXPLAINS: writing the word `<script>` inside
// a comment made check-spa-parse.js treat the rest of the comment as JavaScript and fail with "Unexpected
// identifier 'take'", and a nav id quoted in prose would otherwise read as a real nav entry.
function blankHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

// The LOCAL scripts the shell loads. Protocol-relative and absolute URLs are skipped: a CDN script is not
// ours to vouch for and cannot be read from disk.
function externalScriptPaths(html) {
  return [...blankHtmlComments(html).matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)]
    .map(m => m[1])
    .filter(u => !/^(https?:)?\/\//.test(u))
    .map(u => u.replace(/^\//, '').split('?')[0]);
}

// Every page id something registers, from the shell AND from the external scripts.
//
// TWO SHAPES, and the second is the one that is easy to miss:
//   pages['x'] = fn            an assignment, from anywhere — how external files and the post-literal
//                              attachments register
//   async dashboard() { … }    a METHOD SHORTHAND inside the literal, unquoted and at COLUMN 0
//
// The shorthand has no `function` keyword, which is exactly what distinguishes it from a top-level
// `async function dashboard()` declaration elsewhere in the file. The first version of the nav test looked
// only for quoted, indented keys and reported 13 live pages as missing.
function registeredPages(shellHtml, externalSources = []) {
  const shell = blankHtmlComments(shellHtml);
  const out = new Set();
  for (const src of [shell, ...externalSources]) {
    for (const m of src.matchAll(/pages\[['"]([a-z0-9-]+)['"]\]\s*=/g)) out.add(m[1]);
  }
  const lit = pagesLiteral(shell);
  if (lit) {
    for (const line of lit.body.split('\n')) {
      // Column 0, optional `async`, a name, then `(` — and NO `function`, which would make it a declaration.
      const m = /^(?:async\s+)?(?!function\b)([a-z0-9-]+)\s*\(/.exec(line);
      if (m) out.add(m[1]);
      const q = /^\s*(?:async\s+)?['"]([a-z0-9-]+)['"]\s*[(:]/.exec(line);
      if (q) out.add(q[1]);
    }
  }
  return out;
}

// Every page id THE NAV CAN REACH, from BOTH shells.
//
// There are two, and the second is default ON:
//   NAV_SECTIONS      the classic sidebar — items are { id, label, icon }
//   PRODUCTS[].pages  the product-nav tabs (productNavEnabled() defaults true), listing page ids per product
//
// Reading only NAV_SECTIONS reported `my-activity` as unreachable while it sits in the Me tab, and reading
// `{id:,label:}` ANYWHERE swept up a product-filter list and three in-page tab bars that are not nav at all.
// So: NAV_SECTIONS is scoped to its own block and requires the `icon:` that every real item carries.
function navPageIds(shellHtml) {
  const shell = blankHtmlComments(shellHtml);
  const ids = new Set();
  const navBlock = shell.slice(shell.indexOf('const NAV_SECTIONS'), shell.indexOf('const NAV_FAMILIES'));
  for (const m of navBlock.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'\s*,\s*label:[^}]*icon:/g)) ids.add(m[1]);
  const prodBlock = shell.slice(shell.indexOf('const PRODUCTS'), shell.indexOf('const PAGE_SECTION'));
  for (const m of prodBlock.matchAll(/pages:\s*\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/'([a-z0-9-]+)'/g)) ids.add(q[1]);
  }
  return ids;
}

module.exports = { pagesLiteral, blankHtmlComments, externalScriptPaths, registeredPages, navPageIds };
