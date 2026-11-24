#!/usr/bin/env node
// ── ONE DEFINITION OF "THE MESSAGE A HUMAN APPROVED" ────────────────────────
//
//   node scripts/check-approval-digest-discipline.js
//     exit 0 = every approval binding comes from approval-digest.js
//
// B7.6 moved the approval binding from the ledger's v1 fingerprint to the canonical v2 digest.
// That change touched SIX producers across FOUR modules and TWO processes, and it had to be made in
// lockstep: migrate one and leave another, and every approved external send on the unmigrated road
// refuses with what reads as a tampering alarm.
//
// It did not go smoothly, and the ways it failed are what this check exists to prevent recurring:
//
//   · dispatch.js computed `resend:<from>` for the provider account while the SENDER SERVICE — a
//     separate process recomputing the same binding from the request body — computed the bare
//     transport name. Both were v2. Both were defensible. Every send across that boundary refused.
//   · three TEST fixtures carried their own copy of the digest expression, so the fixture and the
//     producer could drift together while the suite kept passing.
//   · the ledger's `digestOf` served both "the bytes a human approved" and "a dedupe key", so
//     changing the first would silently have changed every dispatch id in existence.
//
// Each of those is the same shape: a second expression of one definition. A reviewer cannot catch
// it, because each expression is locally correct. A check can.
//
// ── WHAT THIS ENFORCES ──────────────────────────────────────────────────────
//
//   1. No module computes an approval binding from LEDGER.digestOf. That function survives as the
//      ledger's audit fingerprint and to recognise a stored v1 digest well enough to REFUSE it.
//   2. No module hashes an approval binding by hand — no local sha256 over message fields.
//
// ── WHAT IT DOES NOT CLAIM ──────────────────────────────────────────────────
//
// It is a repository check. It cannot prove the FIELD SET is right — that every field reaching a
// recipient is bound — which is what src/lib/outbound/approval-digest.test.js and the end-to-end
// agreement tests in scripts/buyer-email-boundary.test.js are for. This check proves there is one
// place to look.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { blankNonCode } = require('./js-lex');

const ROOT = path.join(__dirname, '..');

// Each exemption carries its reason. A list of bare paths becomes a place to add a file rather
// than a decision somebody made.
const EXEMPT = new Map([
  ['src/lib/outbound/ledger.js',
    'DEFINES digestOf as the audit fingerprint, and idempotencyHash on top of it. Neither is an '
    + 'approval binding, and its own comments say so at length.'],
  ['src/lib/outbound/approval-digest.js',
    'IS the canonical binding. It hashes by hand because it is the one place allowed to.'],
  ['src/lib/outbound/approval-digest.test.js',
    'asserts v1 behaviour in order to prove v2 differs from it — the legacy-recognition tests need '
    + 'to produce a real v1 digest to show it is refused.'],
  ['scripts/buyer-email-boundary.test.js',
    'asserts that the fingerprint and the binding are DIFFERENT things, which requires naming '
    + 'both. It also runs every producer against one message, which is the lockstep assertion.'],
  ['scripts/check-approval-digest-discipline.js',
    'this file.'],
]);

// The approval binding is produced ONLY by this module's function.
const CANONICAL = 'approvalDigest';

const violations = [];
const checked = [];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { yield* walk(abs); continue; }
    if (e.name.endsWith('.js')) yield abs;
  }
}

// Fields that make a hash an approval binding rather than some other hash. A sha256 over a
// commercial record or a plan is not this check's business; a sha256 over recipients and a subject
// is a message digest whatever it is called.
const MESSAGE_FIELDS = /\b(?:subject|recipients|replyTo|reply_to|bcc)\b/;

for (const dir of ['src', 'scripts', 'services']) {
  const base = path.join(ROOT, dir);
  if (!fs.existsSync(base)) continue;
  for (const abs of walk(base)) {
    const rel = path.relative(ROOT, abs);
    const raw = fs.readFileSync(abs, 'utf8');
    // Comments and strings blanked: five guards in this repository have fired on their own
    // documentation, and each time the fix was to match statements rather than words. A file
    // explaining why it must not call digestOf must not fail for containing that sentence.
    const code = blankNonCode(raw);

    if (EXEMPT.has(rel)) {
      if (raw.includes(CANONICAL) || /digestOf/.test(code)) checked.push(`exempt  ${rel} — ${EXEMPT.get(rel)}`);
      continue;
    }

    // 1. The v1 fingerprint, used where an approval binding belongs.
    if (/\bdigestOf\s*\(/.test(code)) {
      // `PLANNER.digestOf` hashes a plan, not a message — a different subsystem with its own
      // meaning for the word. Only the ledger's is in scope here.
      const usesLedger = /(?:LEDGER|ledger)\s*\.\s*digestOf\s*\(/.test(code)
        || /require\([^)]*outbound\/ledger[^)]*\)\s*\.\s*digestOf/.test(code);
      if (usesLedger) {
        violations.push(`${rel} computes a digest with the LEDGER's digestOf. That is the v1 audit `
          + 'fingerprint: it binds the recipients in TO, the subject and ONE body, and binds '
          + 'neither cc, bcc, the company, the sender identity, the provider account, the '
          + 'attachments nor the text alternative. An approval binding comes from '
          + `src/lib/outbound/approval-digest.js ${CANONICAL}().`);
      }
    }

    // 2. A hand-rolled message hash.
    if (/createHash\s*\(\s*$|createHash\s*\(/.test(code) && MESSAGE_FIELDS.test(code)) {
      const near = code.split('\n').some((line, i, all) => /createHash/.test(line)
        && MESSAGE_FIELDS.test(all.slice(Math.max(0, i - 4), i + 8).join('\n')));
      if (near) {
        violations.push(`${rel} hashes message fields with its own createHash. One expression of `
          + '"the message that was approved", or a producer and a consumer can each be internally '
          + 'consistent and still disagree — which is exactly what happened between dispatch.js '
          + 'and the sender service, in two processes, during this very migration.');
      }
    }
  }
}

for (const line of checked) console.log(`  ${line}`);
console.log(`\n  ${checked.length} exempted file(s); every other module takes its approval binding `
  + 'from approval-digest.js.');

if (violations.length) {
  console.error(`\nFAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`  - ${v}\n`);
  process.exit(1);
}
console.log('\nOK: one definition of the message a human approved.');
process.exit(0);
