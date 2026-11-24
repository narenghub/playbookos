#!/usr/bin/env node
// ── DOES THE GATE SEE EVERYTHING THAT WILL RECEIVE THE MESSAGE? ──────────────
//
//   node scripts/check-email-gate-recipient-coverage.js   # exit 0 = every recipient is judged
//
// ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
//
// Found 2026-11-24. src/lib/mailer.js accepted `cc`, forwarded it to deliverAuthorized, and
// deliverAuthorized put it into the Resend payload as body.cc — while assertSendAllowed was called
// with `to` ALONE. So an email addressed to a colleague with an outside address in cc passed the
// external-approval boundary untouched, and the cc'd party received it with no approval. Live, not
// hypothetical: sitenex-phase3.routes.js:536 cc's a partner address, procurement-rfq.js cc's
// `copyTo` on supplier RFQs, buyer-email-approval.js cc's whatever a stored payload holds.
//
// ── WHY A SCANNER AND NOT ANOTHER TEST ───────────────────────────────────────
//
// This is the THIRD instance of one defect class in this codebase, and the first two each have a
// scanner because a test could not have caught them:
//
//   1. Eight agents called the Anthropic API directly rather than through llm.js, so they sat
//      outside the `llm.call` kill switch (d0c19ee).
//   2. Two Gmail senders reached a provider without consulting the kill switch at all, while the
//      guard that should have caught it named only the two Resend senders —
//      scripts/check-email-transport-coverage.js is the answer to that one.
//
// Each time: a gate that is real, and is not the only road. There the second road was another
// provider; here it is another FIELD on the same provider call. Every behavioural test of the gate
// passes while this bug is present, because those tests call the gate directly and therefore hand
// it the very parameter the caller was forgetting to hand it. The thing to check is not "does the
// gate judge a cc correctly" but "is the gate GIVEN the cc", and that is a property of the call
// site rather than of the gate.
//
// ── WHAT IT CHECKS ───────────────────────────────────────────────────────────
//
//   A. mailer.js — every recipient-bearing name that sendEmailDetailed forwards to the provider
//      helper must also appear in its assertSendAllowed call. Add `bcc` to the transmit path
//      tomorrow and this fails until the gate is given it too.
//
//   B. dispatch.js — the same property on the one governed road: any recipient field read off
//      `message` must be passed to its gate call.
//
//   C. The raw/RFC822 tripwire. src/lib/gmail/message.js:170 can emit a `Cc:` header into the raw
//      MIME, and dispatch gates the `to` DESCRIPTION of a raw blob rather than its headers — so a
//      caller that passes `cc` to buildMessage would put recipients inside opaque bytes that the
//      gate never reads. No current caller does (outreach-agent and cphi-runner both omit it), so
//      the hole is latent, and this keeps it latent: the day a cc appears at a buildMessage call
//      site, this fails and names the work that has to happen first.
//
// ── WHAT IT DOES NOT CHECK, STATED SO NOBODY READS IT AS COMPLETE ────────────
//
// It does not parse raw MIME, so it cannot tell you which addresses a given blob would reach. It
// does not cover `from` or `reply_to`: those are not recipients — nothing is delivered to a
// Reply-To — and sender-identity validation is a separate control, not this one. Partial coverage
// under a confident name is how check-legacy-email-containment-db.js read as complete while
// containing no reference to Gmail; so this says what it leaves out.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const AST = require('./js-ast');

const ROOT = path.join(__dirname, '..');

// Fields that cause DELIVERY. `from` and `replyTo` are deliberately absent — see the note above.
const RECIPIENT_FIELDS = new Set(['to', 'cc', 'bcc']);

const violations = [];
const checked = [];

function read(rel) {
  const abs = path.join(ROOT, rel);
  return { rel, abs, src: fs.readFileSync(abs, 'utf8') };
}

/** The property keys passed to a call's first object-literal argument. */
function passedKeys(callNode) {
  const arg = (callNode.arguments || [])[0];
  if (!arg || arg.type !== 'ObjectExpression') return null;   // not analysable → caller decides
  const keys = new Set();
  for (const p of arg.properties || []) {
    if (p.type === 'SpreadElement') return null;              // a spread can carry anything
    if (p.key) keys.add(p.key.name || p.key.value);
  }
  return keys;
}

// ── A: THE RESEND PATH IN mailer.js ─────────────────────────────────────────

function checkMailer(ast, rel) {
  const fns = AST.functionsOf(ast);
  const sender = fns.find((f) => f.name === 'sendEmailDetailed');
  if (!sender) {
    violations.push(`${rel}: sendEmailDetailed was not found, so its gate call cannot be checked. `
      + 'If it was renamed, rename it here too rather than deleting the check.');
    return;
  }

  // What the function RECEIVES that could reach a provider.
  const accepted = sender.params.filter((p) => RECIPIENT_FIELDS.has(p));

  // What it forwards to the provider helper, and what it gives the gate — both inside this
  // function only, so a call in a neighbouring function cannot satisfy it.
  const within = (c) => c.start >= sender.start && c.start < sender.end;
  const delivered = new Set();
  for (const c of AST.callsTo(ast, 'deliverAuthorized').filter(within)) {
    const keys = passedKeys(c.node);
    if (keys === null) {
      violations.push(`${rel}:${c.line}: the deliverAuthorized argument is not a plain object `
        + 'literal, so which recipients are transmitted cannot be established by reading it.');
      continue;
    }
    for (const k of keys) if (RECIPIENT_FIELDS.has(k)) delivered.add(k);
  }

  const gateCalls = AST.callsTo(ast, 'assertSendAllowed').filter(within);
  if (!gateCalls.length) {
    violations.push(`${rel}: sendEmailDetailed contains no assertSendAllowed call. The kill switch `
      + 'and the approval boundary are both that call; without it nothing is authorized.');
    return;
  }
  for (const c of gateCalls) {
    const keys = passedKeys(c.node);
    if (keys === null) {
      violations.push(`${rel}:${c.line}: the assertSendAllowed argument is not a plain object `
        + 'literal, so the recipients it judges cannot be established by reading it.');
      continue;
    }
    for (const field of delivered) {
      if (!keys.has(field)) {
        violations.push(`${rel}:${c.line}: \`${field}\` is transmitted to the provider but is NOT `
          + `passed to assertSendAllowed. Every address in ${field} receives the message, so the `
          + 'approval boundary must classify it; today it is delivered unjudged. This is the exact '
          + 'defect found on 2026-11-24 — add it to the gate call.');
      }
    }
  }

  // A recipient field accepted but never transmitted is not a bypass. It is a trap: the parameter
  // is in the signature, so a future edit that forwards it inherits an unjudged channel unless the
  // gate call already carries it. Reported as a finding, not a violation.
  for (const field of accepted) {
    if (!delivered.has(field)) {
      checked.push(`NOTE ${rel}: sendEmailDetailed accepts \`${field}\` but does not transmit it — `
        + 'nothing reaches the provider that way today.');
    }
  }
  checked.push(`${rel}: transmitted recipients {${[...delivered].sort().join(', ')}} are all passed `
    + 'to assertSendAllowed');
}

// ── B: THE GOVERNED ROAD IN dispatch.js ─────────────────────────────────────

function checkDispatch(ast, rel, src) {
  const gateCalls = AST.callsTo(ast, 'assertSendAllowed');
  if (!gateCalls.length) {
    violations.push(`${rel}: no assertSendAllowed call — dispatch is described as the only governed `
      + 'road out, and an ungoverned road is not one.');
    return;
  }
  // Which recipient fields does dispatch read off the message it will hand to a transport?
  const readOff = new Set();
  AST.walk(ast, (node) => {
    if (node.type !== 'MemberExpression' || node.computed) return;
    const name = node.property && node.property.name;
    if (!RECIPIENT_FIELDS.has(name)) return;
    const obj = node.object;
    if (obj && obj.type === 'Identifier' && /^(message|m|msg)$/.test(obj.name)) readOff.add(name);
  });
  // Destructuring counts as reading: `const { to, cc } = message`.
  AST.walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    if (!node.id || node.id.type !== 'ObjectPattern') return;
    if (!node.init || node.init.type !== 'Identifier') return;
    if (!/^(message|m|msg)$/.test(node.init.name)) return;
    for (const n of AST.paramNames(node.id)) if (RECIPIENT_FIELDS.has(n)) readOff.add(n);
  });

  for (const c of gateCalls) {
    const keys = passedKeys(c.node);
    if (keys === null) {
      violations.push(`${rel}:${c.line}: the assertSendAllowed argument is not a plain object literal.`);
      continue;
    }
    for (const field of readOff) {
      if (!keys.has(field)) {
        violations.push(`${rel}:${c.line}: dispatch reads \`${field}\` off the message it hands to a `
          + `transport but does not pass it to assertSendAllowed.`);
      }
    }
  }
  checked.push(`${rel}: recipient fields read off the message {${[...readOff].sort().join(', ') || 'to'}}`
    + ' are all passed to the gate');

  // The JSDoc advertises what a caller may supply. If it offers a recipient field the code never
  // forwards, a caller will reasonably supply it and silently have it dropped — or, worse, a later
  // implementer will wire it up and inherit an ungated channel.
  const doc = /the message:\s*\{([^}]*)\}/.exec(src);
  if (doc) {
    for (const field of RECIPIENT_FIELDS) {
      const advertised = new RegExp(`\\b${field}\\??\\s*[,}]`).test(`${doc[1]},`);
      if (advertised && !readOff.has(field)) {
        checked.push(`NOTE ${rel}: the message JSDoc advertises \`${field}\`, which the code does `
          + 'not read or forward. A caller supplying it would have it silently dropped.');
      }
    }
  }
}

// ── C: THE RAW/RFC822 TRIPWIRE ──────────────────────────────────────────────

function checkRawBuilders() {
  const builder = read('src/lib/gmail/message.js');
  const emitsCc = /headers\.push\(\s*\[\s*'Cc'/.test(builder.src);
  if (!emitsCc) {
    checked.push(`${builder.rel}: no Cc header is emitted into raw MIME; the tripwire below is moot`);
    return;
  }

  // buildMessage CAN put a Cc header in the bytes. dispatch gates the `to` description of a raw
  // blob, not its headers — so a cc here is a recipient the gate cannot see.
  const callers = [];
  const srcDir = path.join(ROOT, 'src');
  const walkDir = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walkDir(abs); continue; }
      if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue;
      const rel = path.relative(ROOT, abs);
      let ast;
      try { ast = AST.parse(fs.readFileSync(abs, 'utf8'), rel); } catch (_) { continue; }
      for (const c of AST.callsTo(ast, 'buildMessage')) {
        const keys = passedKeys(c.node);
        if (keys === null) {
          violations.push(`${rel}:${c.line}: buildMessage is called with an argument that cannot be `
            + 'read statically, so whether it supplies a cc cannot be established.');
          continue;
        }
        if (keys.has('cc') || keys.has('bcc')) callers.push(`${rel}:${c.line}`);
      }
    }
  };
  walkDir(srcDir);

  if (callers.length) {
    violations.push('a raw MIME message is being built with cc/bcc, which puts recipients inside '
      + 'bytes that the gate does not read: '
      + `${callers.join(', ')}. src/lib/outbound/dispatch.js passes only the \`to\` DESCRIPTION of a `
      + 'raw blob to assertSendAllowed, so those addresses would be delivered unjudged. Before '
      + 'wiring this: make dispatch parse the recipient headers out of `raw` (src/lib/catalogue/'
      + 'rfc822.js already decodes cc) and pass them to the gate.');
  } else {
    checked.push('src/lib/gmail/message.js can emit a Cc header, and no caller supplies one — the '
      + 'raw-path hole stays latent (tripwire armed)');
  }
}

// ── RUN ─────────────────────────────────────────────────────────────────────

function main() {
  // An unavailable parser is a scanner that cannot conclude, not a scanner that passes. There is
  // no text-matching fallback: a quieter scan is not a safer one.
  if (!AST.parserAvailable()) {
    console.error(`FAIL: ${AST.parserMissingReason()}`);
    process.exit(1);
  }

  for (const [rel, fn] of [['src/lib/mailer.js', checkMailer],
    ['src/lib/outbound/dispatch.js', checkDispatch]]) {
    const f = read(rel);
    let ast;
    try {
      ast = AST.parse(f.src, rel);
    } catch (e) {
      violations.push(`${rel} does not parse: ${e.message}`);
      continue;
    }
    fn(ast, rel, f.src);
  }
  checkRawBuilders();

  for (const line of checked) console.log(`  ${line}`);
  if (violations.length) {
    console.error(`\nFAIL — ${violations.length} recipient(s) reach a provider unjudged:\n`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log('\nOK: every recipient field that reaches a provider is passed to the gate.');
  process.exit(0);
}

main();
