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
const BASELINE_SHA256 = 'ec48eb3086dd4f2587fb5062c02c9da5e5e797e49fe7aaefb78bbed5d93bb4fe';

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
    // Deliberately NOT satisfied by requiring mailer.js. A caller that reaches the mailer without
    // supplying an approval id and expected digest is not approval-bound, and treating the import
    // as sufficient would report exactly that caller as compliant.
    const approvalBound = APPROVAL_ANCHORS.some((re) => re.test(code));
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
          approvalBound,
          enclosing: enclosingFunctionAt(code, m.index),
          expression: m[0],
          fingerprint: AL.fingerprint({
            file: rel, enclosing: enclosingFunctionAt(code, m.index), expression: m[0],
          }),
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
  for (const file of new Set(sites.filter((x) => x.gated).map((x) => x.file))) {
    const code = blankNonCode(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
    const gateAt = code.indexOf(`${GATE}(`);
    const firstCall = Math.min(...TRANSPORTS.map((t) => {
      t.re.lastIndex = 0; const m = t.re.exec(code); return m ? m.index : Number.MAX_SAFE_INTEGER;
    }));
    if (gateAt === -1) { bad(`${file} is marked gated but does not call ${GATE}()`); continue; }
    if (gateAt < firstCall) ok(`${file}: the gate precedes the provider call`);
    else bad(`${file}: a provider call appears BEFORE the gate — the gate is present but not first`);
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

module.exports = { discover, discoverRest, enclosingFunctionAt, firstArgument, methodOf, blankNonCode, blankCommentsOnly, TRANSPORTS, EXCEPTIONS, GATE, ROOTS };

if (require.main === module) main();
