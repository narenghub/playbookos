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
const vm = require('vm');
const crypto = require('crypto');
const AL = require('./outbound-endpoint-allowlist');

// ── THE KNOWN-VIOLATION BASELINE, AND WHY THE COUNT LIVES HERE ──────────────
//
// outbound-known-violations.json records what is wrong TODAY so the check can fail on anything
// NEW without failing on everything that already is. It is a ratchet, not an exemption list: each
// entry names a violation and where it gets fixed, and every run prints them as outstanding.
//
// MAX_KNOWN_VIOLATIONS lives HERE, in the checker, and BASELINE_SHA256 pins the file's contents.
// Adding a fourth violation therefore takes three coordinated edits — the code, the JSON, and this
// file twice — instead of one quiet line in a data file the reviewer skims.
//
// BE HONEST ABOUT WHAT THAT IS WORTH. Nothing inside a repository is unforgeable against someone
// with write access to it; all three edits can land in one commit. This does not PREVENT an
// expansion. It makes one impossible to perform SILENTLY: loud in the diff, loud in CI output,
// and requiring a written reason. The only enforcement that actually holds is outside the artifact
// — branch protection and CODEOWNERS on this file and the JSON — and that is owner configuration,
// not code. Until it exists, this comment is the accurate description of the control's strength.
const MAX_KNOWN_VIOLATIONS = 3;
// The path is overridable ONLY so the negative controls can drive a planted baseline. The
// pinned digest and MAX_KNOWN_VIOLATIONS are not overridable, which is what keeps the seam
// from becoming the bypass: a planted baseline still fails both of those, which is exactly
// what tests 14 and 15 assert.
const BASELINE_FILE = process.env.OUTBOUND_BASELINE_FILE
  || path.join(__dirname, 'outbound-known-violations.json');
// Re-pinned 2026-11-12 for the AST migration. The three tracked violations are the same three
// call sites with the same three violations; what changed is that a fingerprint covers the callee
// expression, and that expression is now taken from the parse tree rather than from a regex match.
// Re-fingerprinting is the procedure this file prescribes for a violation that MOVED, and it is
// deliberately three edits — the baseline, this digest, and the ceiling — so that it cannot happen
// quietly. The ceiling did NOT move: still 3.
// Previous: ec48eb3086dd4f2587fb5062c02c9da5e5e797e49fe7aaefb78bbed5d93bb4fe
const BASELINE_SHA256 = '142d988f405e6e737447ec47f3c9774dad89d470834c08c873e35bfd512f10c5';

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

// ── THE PRE-PASS NOW LIVES IN ONE PLACE ─────────────────────────────────────
//
// It was two near-identical character scanners right here, and neither understood REGEX LITERALS.
// A quote inside `/...([^"'\s]+)/` opened a phantom string that ran to the next quote in the file;
// on 2026-11-12 that span covered a whole `async function sendEmailDetailed(` declaration, and the
// ordering check below then attributed that function's provider call to the function above it and
// reported "all 1 caller(s) gate first" about a function with two callers. A planted ungated Gmail
// sender placed after such a regex produced ZERO discovered call sites: an unauthorized sender
// invisible to the control whose entire job is finding unauthorized senders.
//
// This file argues at length that one shared decision function is what stops two transports
// drifting apart, and then carried two copies of its own lexer. They are now one module,
// scripts/js-lex.js, which also REFUSES TO GUESS: anything it cannot classify comes back as a
// concern, and unreadableReasons() below turns a concern into "not executed" rather than a pass.
const { blankNonCode, blankCommentsOnly, lex } = require('./js-lex');
// ── AND NOW A REAL PARSER ───────────────────────────────────────────────────
//
// CEO decision 2026-11-12: the security-critical discovery and ordering analysis is AST-based.
// js-lex.js stays for discoverRest(), which looks for STRING VALUES (a URL template) rather than
// structure, and for the permanent controls that pin the historical defects. It is no longer what
// decides whether an outbound path is governed.
const ASTLIB = require('./js-ast');
const OUTBOUND = require('./outbound-ast-analysis');

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
  // THE CALL FORM ONLY. A bare `RESEND_EMAILS_URL` also matched the constant's DECLARATION, which
  // is not a transmission — it reported mailer.js:9 as a call site and, because the declaration
  // sits above the gate, made the ordering check fail on a file where the ordering is correct.
  // A pattern loose enough to match a definition is a pattern that will mis-locate a call.
  { key: 'resend.http', label: 'Resend HTTP POST /emails',
    re: /fetch\s*\(\s*RESEND_EMAILS_URL/g },
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

// ── THE APPROVAL AXIS ───────────────────────────────────────────────────────
//
// A second question about every site, beside "is it behind the kill switch". S2 put buyer
// quotations behind an approval bound to the exact rendered bytes; the two Gmail agents reach the
// same buyers with the kill switch and no approval at all. Classifying only against the kill
// switch reports them as compliant, which is how "the gate exists" came to be mistaken for "the
// gate is the only road".
//
// File-level, like `gated`, and with the same honest limit: it establishes that the file knows
// about the approval binding, not that every path through it uses one. Sharpening that is
// Milestone 2's dispatcher, where there is one path to sharpen.
const APPROVAL_ANCHORS = [/\bexpectedDigest\b/, /\bverifyReleasedApproval\b/];

// ── PROVIDER REST, WHICH THE SDK PATTERNS CANNOT SEE ────────────────────────
//
// src/lib/agents/inquiry-triage.js reaches Gmail through a hand-built URL and `fetch`, not the
// googleapis SDK. No `.users.messages.send(` pattern matches it, so until now this scanner did not
// see that module at all. It is harmless today — it reads, labels and drafts — but a send added
// there would have been invisible to every control in this repository.
//
// Analysis runs on blankCommentsOnly() rather than blankNonCode(), because here the thing being
// looked for IS a string value. blankNonCode would erase every path and leave a check that can
// never match.

/** The nearest enclosing function name at `index`, or null. Used for stable fingerprints. */
function enclosingFunctionAt(code, index) {
  const before = code.slice(0, index);
  const re = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/g;
  let m; let name = null;
  while ((m = re.exec(before)) !== null) name = m[1] || m[2];
  return name;
}

/** The balanced first argument of a call starting at `openParen`, plus the rest of the args. */
function firstArgument(code, openParen) {
  let depth = 0;
  let i = openParen;
  let argStart = -1;
  for (; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') { depth += 1; if (depth === 1) argStart = i + 1; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return { arg: code.slice(argStart, i).trim(), rest: '', end: i };
      continue;
    }
    if (c === ',' && depth === 1) {
      let j = i + 1; let d2 = 1;
      for (; j < code.length && d2 > 0; j += 1) {
        const e = code[j];
        if (e === '(' || e === '[' || e === '{') d2 += 1;
        else if (e === ')' || e === ']' || e === '}') d2 -= 1;
      }
      return { arg: code.slice(argStart, i).trim(), rest: code.slice(i + 1, j - 1), end: j - 1 };
    }
  }
  return { arg: '', rest: '', end: openParen };
}

/** `method: 'POST'` inside the options argument; GET when unstated, as fetch defaults. */
function methodOf(rest) {
  const m = /\bmethod\s*:\s*['"]([A-Za-z]+)['"]/.exec(rest || '');
  return m ? m[1].toUpperCase() : 'GET';
}

/**
 * Every provider-REST endpoint expression in the tree, classified against the allowlist.
 *
 * Unclassifiable expressions are returned as violations with `classifiable: false`. They are NOT
 * skipped and NOT approved — see outbound-endpoint-allowlist.js:skeletonOf.
 */
function discoverRest(roots = ROOTS) {
  const list = typeof roots === 'string'
    ? [{ dir: roots, base: path.join(roots, '..') }]
    : roots;
  const sites = [];
  for (const { dir, base } of list) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const raw = fs.readFileSync(file, 'utf8');
      const code = blankCommentsOnly(raw);
      const rel = path.relative(base, file);
      for (const prov of AL.PROVIDER_BASES) {
        if (!code.includes(prov.host)) continue;

        // The base constant, so the helper's own fetch can be told from its callers.
        const bc = new RegExp(`(?:const|let|var)\\s+([A-Za-z0-9_$]+)\\s*=\\s*['"\`][^'"\`]*${prov.host.replace(/\./g, '\\.')}[^'"\`]*['"\`]`).exec(code);
        const baseConst = bc ? bc[1] : null;

        // The helper is the function whose body builds a URL from that constant.
        let helper = null;
        if (baseConst) {
          const use = new RegExp(`\\$\\{\\s*${baseConst}\\s*\\}`).exec(code);
          if (use) helper = enclosingFunctionAt(code, use.index);
        }

        if (helper) {
          const call = new RegExp(`\\b${helper}\\s*\\(`, 'g');
          let m;
          while ((m = call.exec(code)) !== null) {
            // The declaration itself is not a call site.
            const prefix = code.slice(Math.max(0, m.index - 40), m.index);
            if (/function\s+$|=\s*(?:async\s*)?$/.test(prefix)) continue;
            if (enclosingFunctionAt(code, m.index) === helper) continue; // recursion inside the helper
            const { arg, rest } = firstArgument(code, m.index + helper.length);
            const { skeleton, classifiable, reason } = AL.skeletonOf(arg);
            const method = methodOf(rest);
            const entry = AL.matchEndpoint({ provider: prov.key, method, skeleton, file: rel });
            const refusal = entry ? null : AL.refusalReason({ provider: prov.key, method, skeleton, file: rel });
            sites.push({
              file: rel,
              line: raw.slice(0, m.index).split('\n').length,
              provider: prov.key,
              providerLabel: prov.label,
              via: `${helper}()`,
              expression: arg,
              enclosing: enclosingFunctionAt(code, m.index),
              method,
              skeleton,
              classifiable,
              reason: reason || refusal || null,
              approved: !!entry,
              fingerprint: AL.fingerprint({ file: rel, enclosing: enclosingFunctionAt(code, m.index), expression: arg }),
            });
          }
        }
      }
    }
  }
  return sites;
}

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
// ── A PARSED FILE, ONCE ─────────────────────────────────────────────────────
//
// Parsing is the expensive part, and three separate questions are asked of every file. One cache,
// keyed by absolute path, so the tree is built once per run.
const TREES = new Map();
function treeFor(abs, rel) {
  if (TREES.has(abs)) return TREES.get(abs);
  const src = fs.readFileSync(abs, 'utf8');
  let entry;
  try {
    entry = { src, ast: ASTLIB.parse(src, rel), error: null };
  } catch (e) {
    entry = { src, ast: null, error: e };
  }
  TREES.set(abs, entry);
  return entry;
}

function discover(roots = ROOTS) {
  // A bare path is accepted so the negative controls can scan a planted temporary tree.
  const list = typeof roots === 'string'
    ? [{ dir: roots, base: path.join(roots, '..') }]
    : roots;
  const sites = [];
  for (const { dir, base } of list) {
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const rel = path.relative(base, file);
      const { src, ast, error } = treeFor(file, rel);
      // A file that does not parse yields no sites. main() turns that into INCOMPLETE — it is NOT
      // treated as "no transports here", which is the mistake that let an erased function read as
      // a clean one.
      if (error || !ast) continue;
      const r = OUTBOUND.analyseFile({ file: rel, src, ast, exception: EXCEPTIONS[rel] || null });
      for (const site of r.sites) {
        sites.push({
          ...site,
          fingerprint: AL.fingerprint({
            file: site.file, enclosing: site.enclosing, expression: site.expression,
          }),
        });
      }
    }
  }
  return sites;
}

function unreadableReasons(file, src, parsed = null) {
  const out = [];
  if (!ASTLIB.parserAvailable()) {
    out.push(ASTLIB.parserMissingReason());
    return out;
  }
  let ast = parsed;
  if (!ast) {
    try {
      ast = ASTLIB.parse(src, file);
    } catch (e) {
      out.push(`${file} does not parse: ${String(e.message).slice(0, 140)} — this scanner will not `
        + 'report on a file it could not read');
      return out;
    }
  }
  // Item 4: computed dispatch on a provider path, and a provider method whose VALUE is taken. Both
  // would make a call invisible to any name-matching analysis, so they are returned as unprovable
  // rather than as clean.
  for (const u of OUTBOUND.analyseFile({ file, src, ast }).unprovable) {
    out.push(`${file}${u.line ? `:${u.line}` : ''} cannot be proven safe (${u.why}): ${u.detail}`);
  }
  return out;
}

// ── IS THE GATE FIRST ON EVERY ROAD TO THE PROVIDER? ────────────────────────
//
// THE DEFECT THIS REPLACES. The check was two indexes into the whole file:
//
//     const gateAt    = code.indexOf(`${GATE}(`);
//     const firstCall = Math.min(...TRANSPORTS.map(...));
//     if (gateAt < firstCall) ok(...); else bad('a provider call appears BEFORE the gate');
//
// That is file ORDER standing in for execution order. It held only while the gate and the provider
// call sat in one function in one arrangement. On 2026-11-12 the C-4 patch extracted the provider
// half of the send into a module-private `deliverAuthorized` and placed it above the gated
// function: the gate still ran first, and was now UNCONDITIONAL rather than skippable by a caller,
// and this check went red reporting "a provider call appears BEFORE the gate".
//
// A control that fails on a patch which strengthens the invariant gets silenced by whoever is
// holding the patch, and the tempting silencing move — move the function back down — protects
// nothing. The paragraph above this check in the original already recorded that its PREDECESSOR
// failed because its string anchors moved. It then implemented the same class of thing one level
// up.
//
// So the question is asked per CALL SITE, about the function the call is in:
//
//   · the gate is called in that same function, before the call  → gated, directly;
//   · otherwise the enclosing function must be MODULE-PRIVATE — an exported function that
//     transmits without gating is callable by every importer, which is C-4 with a different
//     spelling — and EVERY call to it inside the file must itself be preceded by a gate call in
//     the function making it → gated, by one PROVEN level of indirection.
//
// One level, not a general call graph: deeper chains are refused rather than guessed at, which
// keeps the answer something this scanner can actually establish. Extracted and exported so it can
// be handed a planted file and REQUIRED TO GO RED — while it was inline, the only input it ever
// saw was this repository, so neither defect it shipped with could be caught by a test.
function gateOrdering(file, code) {
  const out = [];
  const say = (good, message, detail) => out.push({ ok: good, message, detail });
  if (code.indexOf(`${GATE}(`) === -1) {
    say(false, `${file} is marked gated but does not call ${GATE}()`);
    return out;
  }

  // Top-level declarations, in order. The enclosing function of an offset is the last declaration
  // that starts before it; its body ends where the next one starts.
  const DECL = /\n(?:async )?function (\w+)\s*\(/g;
  const decls = [];
  for (let m = DECL.exec(code); m; m = DECL.exec(code)) decls.push({ name: m[1], at: m.index });
  const enclosing = (i) => {
    let found = null;
    for (const d of decls) { if (d.at < i) found = d; else break; }
    if (!found) return null;
    const next = decls.find((d) => d.at > found.at);
    return { name: found.name, start: found.at, end: next ? next.at : code.length };
  };
  const gatedBefore = (start, before) => code.slice(start, before).includes(`${GATE}(`);

  const callsIn = [];
  for (const t of TRANSPORTS) {
    t.re.lastIndex = 0;
    for (let m = t.re.exec(code); m; m = t.re.exec(code)) {
      callsIn.push({ at: m.index, label: t.label });
    }
  }
  if (!callsIn.length) {
    say(false, `${file}: marked gated but no transport call site was re-located`);
    return out;
  }

  for (const call of callsIn) {
    const fn = enclosing(call.at);
    if (!fn) {
      say(false, `${file}: a ${call.label} call sits outside any function — it runs at import time`);
      continue;
    }
    if (gatedBefore(fn.start, call.at)) {
      say(true, `${file}: ${fn.name}() calls the gate before reaching ${call.label}`);
      continue;
    }
    const expAt = code.indexOf('module.exports');
    const exported = expAt !== -1 && new RegExp(`\\b${fn.name}\\b`).test(code.slice(expAt));
    if (exported) {
      say(false,
        `${file}: ${fn.name}() reaches ${call.label} without calling the gate, and is EXPORTED`,
        'An exported function that transmits without gating is callable by every module that '
        + 'imports this file — which is the C-4 bypass with a different spelling.');
      continue;
    }
    const callers = [];
    const CALL = new RegExp(`\\b${fn.name}\\s*\\(`, 'g');
    for (let m = CALL.exec(code); m; m = CALL.exec(code)) {
      if (m.index >= fn.start && m.index < fn.end) continue;     // its own declaration and body
      const c = enclosing(m.index);
      if (c) callers.push({ fn: c, at: m.index });
    }
    if (!callers.length) {
      say(false,
        `${file}: ${fn.name}() reaches ${call.label} without the gate and has no in-file caller`,
        'Nothing in this file calls it, so there is no path on which the gate can be shown to run '
        + 'first. If it is dead code, delete it.');
      continue;
    }
    const ungated = callers.filter((c) => !gatedBefore(c.fn.start, c.at));
    if (ungated.length) {
      say(false,
        `${file}: ${fn.name}() reaches ${call.label} and ${ungated.length} of its `
        + `${callers.length} caller(s) do not gate first`,
        ungated.map((c) => `${c.fn.name}() calls ${fn.name}() with no ${GATE}() before it`)
          .join('\n          '));
      continue;
    }
    say(true, `${file}: ${call.label} is reached only through ${fn.name}(), and all `
      + `${callers.length} caller(s) gate first`);
  }
  return out;
}

function main() {
  for (const { dir } of ROOTS) {
    if (!fs.existsSync(dir)) {
      console.log(`${dir} not found — the scan did not execute.`);
      process.exit(EXIT_NOT_EXECUTED);
    }
  }

  // ── BEFORE ANY CONCLUSION: CAN THIS SCANNER READ WHAT IT IS SCANNING? ─────
  //
  // M1 correction item 4. Every .js file under the scanned roots must compile and must lex without
  // a concern, or this scanner reports NOT EXECUTED instead of a verdict. The alternative is what
  // happened on 2026-11-12: a pre-pass quietly ate a function and the output said PASS.
  const unreadable = [];
  if (!ASTLIB.parserAvailable()) unreadable.push(ASTLIB.parserMissingReason());
  for (const { dir, base } of ROOTS) {
    for (const abs of walk(dir)) {
      const rel = path.relative(base, abs);
      const { src, ast, error } = treeFor(abs, rel);
      if (error) {
        unreadable.push(`${rel} does not parse: ${String(error.message).slice(0, 140)}`);
        continue;
      }
      for (const why of unreadableReasons(rel, src, ast)) unreadable.push(why);
    }
  }
  if (unreadable.length) {
    console.log(`  INCOMPLETE  ${unreadable.length} file(s) could not be read with certainty:\n`);
    for (const why of unreadable.slice(0, 20)) console.log(`      ${why}`);
    if (unreadable.length > 20) console.log(`      … and ${unreadable.length - 20} more`);
    console.log('\nINCOMPLETE  the scan did not execute over the whole tree, so its silence means '
      + 'nothing.\n            This is NOT a pass and NOT a finding.\n');
    process.exit(EXIT_NOT_EXECUTED);
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

  // ── THE GATE MUST COME FIRST, NOT MERELY EXIST ─────────────────────────────
  //
  // A file can import the gate, call it, and still reach the provider on a path that does not pass
  // through it. `gated` above only establishes that the file knows about the gate.
  //
  // This also closes a gap the S1 deployment exposed. scripts/confirm-legacy-email-state.js — a
  // PRODUCTION-ONLY verifier, not run by preflight — held two string anchors into mailer.js to
  // prove this same ordering. Both moved in S1, it reported `-1 / -1`, and it concluded the
  // ordering was unproven on a deploy where it holds. Preflight was 93/93 green throughout,
  // because nothing locally exercised that assumption. Asserting the invariant HERE means the next
  // move of those anchors goes red on a laptop rather than in a production evidence run.
  //
  // THAT PREDECESSOR'S DEFECT WAS REPEATED HERE, and the replacement lives in gateOrdering()
  // above — see its header for what went wrong and why the question is now asked per call site.
  for (const file of new Set(sites.filter((x) => x.gated).map((x) => x.file))) {
    const abs = path.join(__dirname, '..', file);
    const { src, ast } = treeFor(abs, file);
    if (!ast) { bad(`${file}: could not be parsed, so its ordering is unproven`); continue; }
    for (const f of OUTBOUND.analyseFile({ file, src, ast }).findings) {
      if (f.ok) ok(f.message); else bad(f.message, f.detail);
    }
  }

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

  // ── PROVIDER REST ──────────────────────────────────────────────────────────
  const rest = discoverRest();
  console.log(`\n  ${rest.length} provider-REST endpoint expression(s) discovered\n`);
  for (const r of rest) {
    // The reason matters. "This module may not do that" and "nothing may do that" are different
    // findings with different fixes, and one label for both sends the reader to the wrong file.
    const verdict = r.approved ? 'approved'
      : (!r.classifiable ? `UNCLASSIFIABLE — ${r.reason}`
        : (r.reason === 'module-not-permitted'
          ? 'SHAPE APPROVED, MODULE NOT PERMITTED' : 'NOT IN ALLOWLIST'));
    console.log(`    ${r.file}:${r.line}  ${r.method} ${r.skeleton || r.expression}  →  ${verdict}`);
  }
  console.log('');

  const restBad = rest.filter((r) => !r.approved);
  if (!restBad.length) {
    ok('every provider-REST endpoint matches an approved (method, template) shape');
  } else {
    bad(`${restBad.length} provider-REST endpoint(s) are not approved`,
      restBad.map((r) => `${r.file}:${r.line}  ${r.method} ${r.skeleton || r.expression}`
        + `${r.classifiable ? '' : '  [unclassifiable — fails closed]'}`).join('\n          ')
      + '\n\n          Add the shape to scripts/outbound-endpoint-allowlist.js if it is legitimate,'
      + '\n          or rewrite the call so its endpoint is a literal or template this can read.'
      + '\n          An endpoint the scanner cannot classify is a violation, not an approval.');
  }

  // A control that discovers nothing passes trivially. The REST client that exists must be seen.
  if (rest.some((r) => r.file === 'src/lib/agents/inquiry-triage.js')) {
    ok('the Gmail REST client in inquiry-triage.js is discovered — SDK patterns never saw it');
  } else {
    bad('no REST endpoint found in inquiry-triage.js — the REST analysis is not reaching it');
  }

  // ── THE APPROVAL AXIS, AND THE RATCHET ─────────────────────────────────────
  let baseline = [];
  let baselineRaw = '';
  try {
    baselineRaw = fs.readFileSync(BASELINE_FILE, 'utf8');
    baseline = JSON.parse(baselineRaw);
  } catch (e) {
    bad(`the known-violation baseline could not be read: ${(e && e.message) || e}`,
      'Absence of the baseline is not an empty baseline. Restore the file.');
  }

  const digest = crypto.createHash('sha256').update(baselineRaw).digest('hex');
  if (BASELINE_SHA256 === digest) {
    ok(`the baseline matches its pinned digest (${digest.slice(0, 12)}…)`);
  } else {
    bad('the known-violation baseline has changed and its pinned digest was not updated',
      `recorded ${BASELINE_SHA256.slice(0, 12)}…  ·  actual ${digest.slice(0, 12)}…\n`
      + '          Expanding the baseline is a deliberate act: update BASELINE_SHA256 and\n'
      + '          MAX_KNOWN_VIOLATIONS in this file, with a reason recorded in the entry.');
  }

  if (baseline.length <= MAX_KNOWN_VIOLATIONS) {
    ok(`the baseline holds ${baseline.length} violation(s), within the ${MAX_KNOWN_VIOLATIONS} permitted`);
  } else {
    bad(`the baseline holds ${baseline.length} violations; MAX_KNOWN_VIOLATIONS permits ${MAX_KNOWN_VIOLATIONS}`,
      'The ratchet only turns one way. Fix a violation, or raise the constant deliberately.');
  }

  const known = new Map(baseline.map((b) => [b.fingerprint, b]));
  const unapproved = sites.filter((s) => !s.approvalBound && !s.exception);

  console.log('');
  for (const b of baseline) {
    console.log(`    OUTSTANDING  ${b.file}  ${b.violation}  →  ${b.fix_in}`);
  }
  console.log('');

  const newViolations = unapproved.filter((s) => !known.has(s.fingerprint));
  if (!newViolations.length) {
    ok('no outbound path reaches a provider without the approval boundary, beyond the baseline');
  } else {
    bad(`${newViolations.length} NEW outbound path(s) have no approval boundary`,
      newViolations.map((s) => `${s.file}:${s.line}  ${s.label}  [${s.fingerprint}]`).join('\n          ')
      + '\n\n          Route it through the approval boundary, or — if it is genuinely a tracked'
      + '\n          violation — add it to the baseline AND raise MAX_KNOWN_VIOLATIONS and'
      + '\n          BASELINE_SHA256 in this file. Three edits, on purpose.');
  }

  const seen = new Set(unapproved.map((s) => s.fingerprint));
  const stale = baseline.filter((b) => !seen.has(b.fingerprint));
  if (!stale.length) {
    ok('every baseline entry still matches a real call site');
  } else {
    bad(`${stale.length} baseline entry/entries match nothing in the code`,
      stale.map((b) => `${b.file}  ${b.violation}  [${b.fingerprint}]`).join('\n          ')
      + '\n\n          A violation that was FIXED must be removed from the baseline — leaving it'
      + '\n          there silently raises the ceiling for the next one. A violation that MOVED'
      + '\n          must be re-fingerprinted deliberately.');
  }

  console.log(`\n  known violations: ${baseline.length} (baseline sha ${digest.slice(0, 12)}…)`);
  console.log(`\n  ${pass} assertion(s) passed · ${fail} failed\n`);
  if (fail) {
    console.log('FAIL  an outbound email path is not governed by the kill switch.\n');
    process.exit(1);
  }
  console.log('PASS  every outbound email transport routes through one authorization gate.\n');
  process.exit(0);
}

module.exports = { discover, discoverRest, gateOrdering, unreadableReasons, treeFor, enclosingFunctionAt, firstArgument, methodOf, blankNonCode, blankCommentsOnly, TRANSPORTS, EXCEPTIONS, GATE, ROOTS };

if (require.main === module) main();
