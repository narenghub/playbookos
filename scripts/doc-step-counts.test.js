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

// ── A RECORDED RESULT IS NOT A CLAIM ABOUT THE CHAIN TODAY ─────────────────────────────────────────
//
// Owner decision 2026-11-24: "Historical acceptance records must reflect exactly what was implemented
// and verified at the time of execution. Do not rewrite historical evidence to satisfy a current
// schema-count scanner."
//
// On 2026-11-24 the chain grew from 54 to 55 steps and this checker named ten stale lines. Seven were
// current — instructions and present-tense claims — and were corrected. THREE WERE TRANSCRIPTS of gate
// runs performed on 2026-11-10, when the chain genuinely had 54 steps: "exit=0  54 steps, 152 tables".
// They were "corrected" too, which falsified the evidence: the run did not validate 55 steps, and a
// record saying it did is worse than a stale number because nothing in the repository disagrees with it.
//
// So a line inside an `as-executed` region, or carrying the marker itself, states what was true then and
// is exempt from the current count. The marker is DATED and greppable
// (`grep -rn as-executed docs/`), so an exemption is visible in the document it applies to rather than
// buried in a list here.
//
// WHY THIS IS A LINE/REGION RULE AND NOT A FILE OR DIRECTORY ONE. Owner item 4: "Avoid broad directory
// exclusions that could conceal stale current documentation." release-gate-summary.md is the proof that
// matters — it holds a historical gate transcript AND, 50 lines later, a live operator instruction
// ("must be 0. 55 steps. Confirm with `node scripts/migrate.js --plan`"). Exempting the file would stop
// checking an instruction someone follows at the keyboard. The region covers the transcript; the
// instruction is still checked.
const AS_EXECUTED_OPEN = /<!--\s*as-executed:\s*(\d{4}-\d{2}-\d{2})/;
const AS_EXECUTED_CLOSE = /<!--\s*\/as-executed\s*-->/;

/**
 * Scan one document. Exported shape so the regression test below can drive it with fixtures instead
 * of re-implementing the classification — a second copy of this rule would be the thing it exists to
 * prevent.
 *
 * Returns { wrong: string[], exempt: string[] }.
 */
function scanDoc(rel, raw, n) {
  const wrong = [];
  const exempt = [];
  const src = raw
    .replace(HISTORICAL, (m) => ' '.repeat(m.length))
    .replace(RATIO, (m) => ' '.repeat(m.length));

  let inAsExecuted = false;
  src.split('\n').forEach((line, i) => {
    const opens = AS_EXECUTED_OPEN.test(line);
    const closes = AS_EXECUTED_CLOSE.test(line);
    // A line may carry both (a table row marks itself) — then it is exempt and the region does not
    // stay open. Opening and closing are evaluated before the claim check so the marker line itself
    // is covered.
    const coveredNow = inAsExecuted || opens;
    if (opens && !closes) inAsExecuted = true;
    if (closes) inAsExecuted = false;

    if (OTHER_POPULATION.test(line)) return;
    CLAIM.lastIndex = 0;
    let m;
    while ((m = CLAIM.exec(line)) !== null) {
      const claimed = Number(m[1]);
      if (claimed < 30 || claimed > 99) continue;
      if (claimed === n) continue;
      if (coveredNow) {
        exempt.push(`${rel}:${i + 1} records ${claimed} steps as-executed (chain is now ${n})`);
        continue;
      }
      wrong.push(`${rel}:${i + 1} claims ${claimed} steps — the migrator has ${n}: ${line.trim().slice(0, 110)}`);
    }
  });
  return { wrong, exempt };
}

const OTHER_POPULATION = /\b(preflight|check\(s\)|checks|assertion|assertions)\b/i;

test('every step count in the docs matches SCHEMA_STEPS', () => {
  const n = SCHEMA_STEPS.length;
  const wrong = [];
  const exempt = [];

  for (const rel of DOCS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const r = scanDoc(rel, fs.readFileSync(abs, 'utf8'), n);
    wrong.push(...r.wrong);
    exempt.push(...r.exempt);
  }

  // Printed, not silent: an exemption that nobody ever sees is how a stale current number eventually
  // hides behind one. This is the census of every historical record being honoured.
  if (exempt.length) console.log(`  as-executed records honoured (${exempt.length}):\n    ${exempt.join('\n    ')}`);

  assert.deepStrictEqual(wrong, [],
    `\n${wrong.join('\n')}\n\nSCHEMA_STEPS is ${n}. Correct the prose, or stop quoting a number and `
    + 'point at `node scripts/migrate.js --plan` instead. If the line is a RECORDED RESULT of a past '
    + 'run, do not change the number — wrap it in `<!-- as-executed: YYYY-MM-DD -->` … '
    + '`<!-- /as-executed -->` so it keeps stating what was true then.\n');
});

test('REGRESSION: historical counts stay valid while wrong CURRENT counts are still caught', () => {
  // Owner item 5. Both halves matter and they pull in opposite directions: an exemption that is too
  // broad stops catching stale instructions, and one that is too narrow goes back to falsifying
  // evidence. Driven through scanDoc, the same function the real scan uses, with fixtures rather than
  // real files so this keeps working when the chain's length changes again.
  const n = SCHEMA_STEPS.length;
  const stale = n === 54 ? 53 : 54;

  const historicalRegion = [
    '# A gate record',
    '<!-- as-executed: 2026-11-10 -->',
    '```',
    `check-migration-coverage.js  exit=0  ${stale} steps, 152 tables`,
    '```',
    '<!-- /as-executed -->',
  ].join('\n');
  assert.deepStrictEqual(scanDoc('fixture-historical.md', historicalRegion, n).wrong, [],
    'a transcript inside an as-executed region must NOT be reported — that is the evidence');
  assert.strictEqual(scanDoc('fixture-historical.md', historicalRegion, n).exempt.length, 1,
    'and it must be reported as an honoured exemption, not silently skipped');

  const selfMarkedRow = `| 2. Backup restored, ${stale} steps validated | PASS | <!-- as-executed: 2026-11-10 --><!-- /as-executed -->`;
  assert.deepStrictEqual(scanDoc('fixture-row.md', selfMarkedRow, n).wrong, [],
    'a single line may mark itself, for a table row');

  // THE OTHER HALF: the same file, after the region closes, is still checked.
  const mixed = [
    '<!-- as-executed: 2026-11-10 -->',
    `recorded: ${stale} steps`,
    '<!-- /as-executed -->',
    `run the migrator: all ${stale} migration steps apply`,
  ].join('\n');
  const r = scanDoc('fixture-mixed.md', mixed, n);
  assert.strictEqual(r.exempt.length, 1, 'the recorded line is exempt');
  assert.strictEqual(r.wrong.length, 1, 'the CURRENT instruction after the region is still caught');
  assert.match(r.wrong[0], /fixture-mixed\.md:4/, 'and it is the line after the region that is named');

  // An unmarked stale current claim is caught, which is the original purpose.
  assert.strictEqual(scanDoc('fixture-current.md', `all ${stale} migration steps`, n).wrong.length, 1);
  // A correct current claim is not.
  assert.strictEqual(scanDoc('fixture-ok.md', `all ${n} migration steps`, n).wrong.length, 0);
  // An undated marker is not a marker: the date is what makes a record identifiable.
  assert.strictEqual(
    scanDoc('fixture-undated.md', `<!-- as-executed -->\n${stale} steps`, n).wrong.length, 1,
    'an undated as-executed marker must not exempt anything');
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
