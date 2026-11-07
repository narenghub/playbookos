// ── A STEP COUNT IN PROSE MUST MATCH THE MIGRATOR ──────────────────────────────────────────────────
//
//   node --test scripts/doc-step-counts.test.js
//
// The migration chain has been 47, then 48, then 49, then 53 steps in two days, and each change left
// a different subset of eight documents quoting the previous number. They were corrected by hand three
// times, and by the third it was obvious that hand-correction is the defect: a release document that
// says "validate all 49 steps" when the migrator has 53 is telling the person running the migration
// something false about the thing they are about to run, and nothing in the repository disagreed.
//
// This is not pedantry about numbers. `docs/deploy/RELEASE.md` and `release-gate-summary.md` are what
// the CEO follows at the keyboard, and `node scripts/migrate.js` printing a count he was not expecting
// is exactly the moment a release stops and a person starts guessing.
//
// So the count lives in one place — SCHEMA_STEPS — and this fails the build when prose disagrees.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { SCHEMA_STEPS } = require('../src/lib/migrate-all');

// Where a step count is allowed to appear at all. Anywhere else, use the command.
const DOCS = [
  'docs/deploy/RELEASE.md',
  'docs/deploy/migration-chain.md',
  'docs/deploy/go-no-go.md',
  'docs/deploy/release-gate-summary.md',
  'docs/deploy/prpa-go-no-go.md',
  'docs/deploy/prpa-mvp-status.md',
  'docs/deploy/prpa-cloud-handover.md',
  'docs/deploy/migration-risk-report.md',
  'docs/tickets/ENG-003-non-superuser-application-role.md',
  'docs/tickets/ENG-004-stale-schema-assertions-and-chain-exclusions.md',
  'docs/security/release-blockers.json',
];

// "53 steps", "all 53 steps", "53 migration steps". A number paired with the word `step` is a claim
// about the chain's length. A number followed by "schema steps declared" is the same claim.
const CLAIM = /\b(\d{2})\s+(?:migration\s+)?step(?:s)?\b/gi;

// Numbers that are a HISTORY of the count rather than a claim about it. "47 → 53 steps" records the
// change; "was 49" describes the past. Those are allowed, and are matched as a pair so a bare stale
// number cannot hide behind the exemption.
const HISTORICAL = /(?:\d{2}\s*(?:→|->|to)\s*\*{0,2}\d{2}|\bwas\s+\d{2}\b|\bfrom\s+\d{2}\b)/g;

// NOT a claim about the migration chain, and the first version of this test called one of them a
// defect: `release-gate-summary.md` records that on 2026-11-03 "31 of 44 steps reported ok having
// executed nothing" — PREFLIGHT steps, in a paragraph about preflight. A checker that reports a
// correct sentence as wrong is the behaviour this whole release has been spent removing, so the
// exemptions are narrow and each one names what it is for:
//
//   "31 of 44 steps"  — a ratio about some other population, never the chain's length
//   a line mentioning preflight / checks / assertions — a different kind of step entirely
const RATIO = /\b\d{1,3}\s+of\s+\d{2,3}\s+steps?\b/gi;
const OTHER_POPULATION = /\b(preflight|check\(s\)|checks|assertion|assertions)\b/i;

test('every step count in the docs matches SCHEMA_STEPS', () => {
  const n = SCHEMA_STEPS.length;
  const wrong = [];

  for (const rel of DOCS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    // Blank out the historical forms first, so "47 → 53 steps" does not read as a claim of 47.
    const src = raw
      .replace(HISTORICAL, (m) => ' '.repeat(m.length))
      .replace(RATIO, (m) => ' '.repeat(m.length));

    src.split('\n').forEach((line, i) => {
      if (OTHER_POPULATION.test(line)) return;
      CLAIM.lastIndex = 0;
      let m;
      while ((m = CLAIM.exec(line)) !== null) {
        const claimed = Number(m[1]);
        // Only counts in the plausible range for this chain; "12 roles" and "28 assertions" are not
        // step counts, and `step` is required by the pattern, so this is a narrow guard against a
        // number that happens to precede the word.
        if (claimed < 30 || claimed > 99) continue;
        if (claimed !== n) wrong.push(`${rel}:${i + 1} claims ${claimed} steps — the migrator has ${n}: ${line.trim().slice(0, 110)}`);
      }
    });
  }

  assert.deepStrictEqual(wrong, [],
    `\n${wrong.join('\n')}\n\nSCHEMA_STEPS is ${n}. Correct the prose, or stop quoting a number and `
    + 'point at `node scripts/migrate.js --plan` instead.\n');
});

test('scripts/expected-schema-steps.txt matches the migrator', () => {
  // verify-prod-dump.sh refuses to run a checkout with fewer steps than this, which is how a stale
  // working copy is caught — on 2026-11-06 one produced a full 80-line FAIL report for defects that
  // were already fixed, and the only clue was "(47 schema steps declared)" in a parenthesis.
  //
  // A number typed into that script would go stale the next time the chain grows, so it reads this
  // file, and this test is what keeps the file honest.
  const abs = path.join(__dirname, 'expected-schema-steps.txt');
  assert.ok(fs.existsSync(abs), 'scripts/expected-schema-steps.txt is missing — verify-prod-dump.sh reads it');
  const recorded = Number(fs.readFileSync(abs, 'utf8').trim());
  assert.strictEqual(recorded, SCHEMA_STEPS.length,
    `expected-schema-steps.txt says ${recorded}, SCHEMA_STEPS has ${SCHEMA_STEPS.length}. `
    + 'Update the file: `node -e \'require("fs").writeFileSync("scripts/expected-schema-steps.txt", '
    + 'String(require("./src/lib/migrate-all").SCHEMA_STEPS.length)+"\\n")\'`');
});

test('the plan command the docs point people at still exists', () => {
  // Several documents tell the operator to run this. If the flag is ever renamed, they become
  // instructions that fail at the keyboard, which is worse than a wrong number.
  const cli = fs.readFileSync(path.join(__dirname, 'migrate.js'), 'utf8');
  assert.ok(/--plan/.test(cli), 'scripts/migrate.js no longer accepts --plan, which the docs tell people to run');
});

test('SCHEMA_STEPS has no duplicate step names', () => {
  // The plan is read by a person comparing it against a running migration. Two steps with one name
  // make that comparison ambiguous at precisely the wrong moment.
  const names = SCHEMA_STEPS.map((s) => s.name);
  const dupes = names.filter((x, i) => names.indexOf(x) !== i);
  assert.deepStrictEqual([...new Set(dupes)], [], 'duplicate step name(s) in SCHEMA_STEPS');
});
