#!/usr/bin/env node
// ── EVERY OUTBOUND EMAIL TRANSPORT, DISCOVERED RATHER THAN LISTED ────────────
//
//   node scripts/check-email-transport-coverage.js
//
// Exit 0 = every provider call site in src/ is governed by the shared kill-switch gate, or is an
// explicitly classified exception. Exit 1 = at least one is not. Exit 3 = the scan could not run.
//
// ── WHY A SCANNER AND NOT A LIST ─────────────────────────────────────────────
//
// scripts/check-legacy-email-containment-db.js proves, against a real database, that a named sender
// stops. It is good evidence and it is not coverage: its names were `inquiry-agent` and
// `procurement-agent`, both Resend, while two Gmail transports sent with no kill-switch check at
// all. The guard's name — "each legacy external sender stops on its own, by name" — invited reading
// it as complete.
//
// A hand-written list is a claim about the code that was true when it was written. The same defect
// appeared twice more in this repository in a single day:
//
//   • the product-boundary completeness test enumerated routes from ONE of six routers, so 57
//     routes went unclassified and two shipped dead behind a 403;
//   • eight agents called the Anthropic API directly, outside llm.js and therefore outside the
//     `llm.call` kill switch.
//
// Three instances, one shape: a gate enforced at one chokepoint while other code reaches the
// provider by another road. So this file does not ask "do the senders we know about stop"; it asks
// "WHAT REACHES A MAIL PROVIDER AT ALL", and then whether each of those is gated.
//
// ── HOW IT READS THE SOURCE, AND WHAT THAT IS WORTH ──────────────────────────
//
// There is no JavaScript parser in this project's dependency tree — not acorn, not espree, nothing
// transitive — and adding one is a supply-chain decision that belongs to the CEO rather than to a
// guard. So this does NOT claim to be AST-based. It does two things instead, and the combination is
// what makes it load-bearing:
//
//   1. A STRUCTURAL PRE-PASS. Comments, string literals and template literals are blanked by a
//      character-level scanner before any matching, so a provider name inside a comment or a log
//      line cannot register as a call site and a call site cannot hide inside one. That scanner has
//      its own negative controls below — it is the fragile part, so it is the tested part.
//   2. RUNTIME INTERCEPTION, in scripts/check-email-containment-live.js, which stubs the actual
//      transports and asserts zero provider invocations under a stop. Static reach plus dynamic
//      behaviour; neither is offered as sole proof.
//
// ── WHAT COUNTS AS A TRANSPORT ───────────────────────────────────────────────
//
// Every way this repository could hand a message to a mail provider, including ones nothing uses
// today. `nodemailer` is a declared dependency with no importer: dormant, and listed here so that
// the day something imports it, this fails rather than discovers it in production.

'use strict';

const fs = require('fs');
const path = require('path');

// BOTH TREES. src/ is the application; scripts/ holds operator-run tools, and one of them —
// verify-bounce-detection.js — genuinely transmits. CEO authorization 2026-11-10 item A: an
// operator script is a sender like any other, and a kill switch is only worth something when it
// is total. Scanning src/ alone was the same "coverage that shrinks as the code grows" this file
// exists to prevent, one directory up.
const ROOTS = [
  { dir: path.join(__dirname, '..', 'src'), base: path.join(__dirname, '..') },
  { dir: path.join(__dirname, '..', 'scripts'), base: path.join(__dirname, '..') },
];
const ROOT = ROOTS[0].dir;
const EXIT_NOT_EXECUTED = 3;

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };

// ── THE PRE-PASS ────────────────────────────────────────────────────────────
//
// Blanks comments and string/template literals, preserving newlines and length so reported line
// numbers stay true. Written as a character scanner rather than a chain of regexes because a regex
// cannot tell a `//` inside a string from a comment, and `'https://api.resend.com'` contains one.
function blankNonCode(src) {
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

// Comments only — STRING LITERALS ARE KEPT. Used where the thing being looked for IS a string
// value, such as `capability: 'email.alert'`. blankNonCode would erase exactly that and leave a
// check which can never match: a test that passes against a planted bypass, which is worse than
// no test. (It did. The planted probe below went undetected until this was added.)
function blankCommentsOnly(src) {
  const out = src.split('');
  let i = 0; const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i]; const d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j += 1; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1; blank(i, Math.min(j + 2, n)); i = j + 2; continue; }
    // Strings are SKIPPED OVER, not blanked — a `//` inside one is not a comment.
    if (c === '"' || c === "'" || c === '`') {
      const q = c; let j = i + 1;
      while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src[j] === q) break; j += 1; }
      i = j + 1; continue;
    }
    i += 1;
  }
  return out.join('');
}

// ── THE TRANSPORTS ──────────────────────────────────────────────────────────
//
// `where` matches the BLANKED source for a call shape; `label` is what a human reads. The Resend
// HTTP call is found by its request shape rather than by its URL, because the URL is a string
// literal and the pre-pass has blanked it — which is the pre-pass working, not a gap.
const TRANSPORTS = [
  { key: 'gmail.messages.send', label: 'Gmail users.messages.send',
    re: /\.users\s*\.\s*messages\s*\.\s*send\s*\(/g },
  { key: 'gmail.drafts.send', label: 'Gmail users.drafts.send',
    re: /\.users\s*\.\s*drafts\s*\.\s*send\s*\(/g },
  { key: 'resend.sdk', label: 'Resend SDK emails.send',
    re: /\.emails\s*\.\s*send\s*\(/g },
  { key: 'resend.http', label: 'Resend HTTP POST /emails',
    re: /RESEND_EMAILS_URL|fetch\s*\(\s*RESEND/g },
  { key: 'nodemailer', label: 'nodemailer transport.sendMail',
    re: /\.sendMail\s*\(|createTransport\s*\(/g },
];

// The ONE function that authorizes a send. A transport call site is governed when its file routes
// through it — directly, or by calling mailer.js, which does.
const GATE = 'assertSendAllowed';
const MAILER = /require\(\s*['"][^'"]*\/?mailer['"]\s*\)/;

// ── EXCEPTIONS, EXPLICIT AND NARROW ─────────────────────────────────────────
//
// An exception is a file that may name a transport without routing through the gate, and each one
// states why. Absence from this map is not neutrality: an unlisted, ungated call site fails.
const EXCEPTIONS = {
  'src/lib/email-gate.js': 'the gate itself',
  'src/lib/mailer.js': 'calls the gate directly; the Resend transport lives here',
  // The scanner and its controls necessarily contain the forbidden shapes — as STRING LITERALS,
  // which the pre-pass blanks, so neither should appear as a call site at all. Listed anyway: if a
  // refactor ever moves one of those fixtures out of a string and into live code, the exception
  // makes that visible as a deliberate decision rather than letting it pass as a discovery.
  'scripts/check-email-transport-coverage.js': 'the scanner; its patterns and controls are string fixtures',
  'scripts/email-containment.test.js': 'the negative controls; planted senders are string fixtures',
  'scripts/confirm-legacy-email-state.js': 'read-only state report; names the Resend URL in a string to locate it in source',
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

/**
 * Every transport call site under src/, with its governance state.
 * Exported so the test file can reuse the discovery rather than re-implement it.
 */
function discover(roots = ROOTS) {
  // A bare path is accepted so the negative controls can scan a planted temporary tree.
  const list = typeof roots === 'string'
    ? [{ dir: roots, base: path.join(roots, '..') }]
    : roots;
  const sites = [];
  for (const { dir, base } of list) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
    const raw = fs.readFileSync(file, 'utf8');
    const code = blankNonCode(raw);
    const rel = path.relative(base, file);
    const gated = code.includes(GATE) || MAILER.test(code);
    for (const t of TRANSPORTS) {
      t.re.lastIndex = 0;
      let m;
      while ((m = t.re.exec(code)) !== null) {
        sites.push({
          file: rel,
          line: raw.slice(0, m.index).split('\n').length,
          transport: t.key,
          label: t.label,
          gated,
          exception: EXCEPTIONS[rel] || null,
        });
      }
    }
    }
  }
  return sites;
}

function main() {
  for (const { dir } of ROOTS) {
    if (!fs.existsSync(dir)) {
      console.log(`${dir} not found — the scan did not execute.`);
      process.exit(EXIT_NOT_EXECUTED);
    }
  }

  const sites = discover();
  console.log(`\n  ${sites.length} outbound email transport call site(s) discovered `
    + `across src/ and scripts/\n`);
  for (const s of sites) {
    const state = s.exception ? `EXCEPTION — ${s.exception}` : (s.gated ? 'gated' : 'UNGATED');
    console.log(`    ${s.file}:${s.line}  ${s.label}  →  ${state}`);
  }
  console.log('');

  // The pre-pass is the fragile part, so it is the proven part. Both directions.
  const planted = blankNonCode([
    "// await g.gmail.users.messages.send({})",
    "const u = 'x.users.messages.send(';",
    'await g.gmail.users.messages.send({});',
  ].join('\n'));
  const hits = (planted.match(/\.users\s*\.\s*messages\s*\.\s*send\s*\(/g) || []).length;
  if (hits === 1) ok('pre-pass: a call in a comment and one in a string are blanked, real code is not');
  else bad(`pre-pass found ${hits} call(s) in the control, expected exactly 1`);

  // A COUNT IS NOT A SANITY CHECK. "At least three" passes on three Gmail sites while the Resend
  // transport has gone invisible, which is precisely what happened on the first run of this file.
  // Each transport KNOWN to exist in this repository is named and must be found.
  const transportsSeen = new Set(sites.map((s) => s.transport));
  for (const [key, label] of [
    ['gmail.messages.send', 'Gmail users.messages.send'],
    ['resend.http', 'the Resend HTTP transport in mailer.js'],
  ]) {
    if (transportsSeen.has(key)) ok(`${label} is discovered`);
    else {
      bad(`${label} was NOT discovered — the pattern no longer matches the code`,
        'A transport that exists and cannot be seen is the exact failure this file was written '
        + 'for. Fix the pattern, or make the call site structurally visible (a named constant '
        + 'survives the string-literal blanking; an inline URL does not).');
    }
  }

  // The walk must actually reach the second tree. A `discover()` that silently scanned only src/
  // would report every script as compliant by never looking at one.
  if (sites.some((s) => s.file.startsWith('scripts/'))) ok('the scan reaches scripts/, not only src/');
  else bad('no call site found under scripts/ — the second tree is not being walked');

  const ungated = sites.filter((s) => !s.gated && !s.exception);
  if (!ungated.length) {
    ok('every discovered transport is gated or an explicit exception');
  } else {
    bad(`${ungated.length} transport call site(s) reach a mail provider without the kill switch`,
      ungated.map((s) => `${s.file}:${s.line}  ${s.label}`).join('\n          ')
      + `\n\n          Route it through assertSendAllowed() in src/lib/email-gate.js, or add an`
      + `\n          explicit entry to EXCEPTIONS in this file saying why it may not be gated.`
      + `\n          Absence is not neutrality.`);
  }

  console.log(`\n  ${pass} assertion(s) passed · ${fail} failed\n`);
  if (fail) {
    console.log('FAIL  an outbound email path is not governed by the kill switch.\n');
    process.exit(1);
  }
  console.log('PASS  every outbound email transport routes through one authorization gate.\n');
  process.exit(0);
}

module.exports = { discover, blankNonCode, blankCommentsOnly, TRANSPORTS, EXCEPTIONS, GATE, ROOTS };

if (require.main === module) main();
