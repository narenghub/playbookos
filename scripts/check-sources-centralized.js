#!/usr/bin/env node
// ── ONE SOURCE DEFINITION, AND IT IS LOAD-BEARING ───────────────────────────
//
//   node scripts/check-sources-centralized.js    exit 0 = centralised and provably so
//
// P1 of the Commercial Canonical Intake sequence: a behaviour-preserving extraction of the
// `SOURCES` definition that was duplicated across the E1 scripts.
//
// ── WHY THIS MATTERS MORE THAN IT LOOKS ─────────────────────────────────────
//
// On 29 Oct the migration created 2466 molecules against an authorised 2428, because the analyser
// and the backfill each had their own idea of what may be created. 38 unauthorised molecules.
// `SOURCES` was the identical defect waiting in a different place: identical copies are correct
// until somebody edits one, and the very next change to this list is Commercial Canonical Intake
// ADDING to it.
//
// A source added to the backfill but not the reconciliation creates molecules the reconciliation
// cannot see. Added to the reconciliation but not the backfill, every row of an unread table is
// reported missing. Both look like a reconciliation problem; neither is.
//
// ── WHAT IS PROVEN, AND WHY STRUCTURAL EQUALITY IS NOT ENOUGH ───────────────
//
// 1. BEFORE == AFTER. The extracted definition deep-equals the value the duplicated copies held,
//    recorded here as a literal baseline captured before the extraction. Membership unchanged.
// 2. ONE OBJECT, not several equal ones. Every consumer's SOURCES is `===` the shared array.
//    Deep-equality would still pass if the duplication came back with the same contents, which is
//    exactly the state this change exists to leave behind.
// 3. REMOVAL PROPAGATES. Drop a source from the shared module at runtime and every consumer
//    observes the removal. This is the mutation control: it is what makes "centralised" a
//    behavioural claim rather than a filesystem observation.
// 4. NO SURVIVING COPY. No file outside the shared module declares its own `SOURCES` literal, and
//    a reintroduced one is detected.
// 5. THE RECONCILIATION STILL RUNS, through its own check.
// 6. The consumers do not mutate the shared array during a normal run.
//
// Proof 3 was the reason the shared array is deliberately NOT frozen. A frozen array makes this
// control impossible to write, and a centralisation nobody can demonstrate is load-bearing has
// only moved the duplication somewhere less visible.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let fail = 0;
const out = (s) => fs.writeSync(1, s + '\n');
const ok = (m) => out(`  ok    ${m}`);
const bad = (m, d) => { fail++; out(`  FAIL  ${m}`); if (d) out(`          ${String(d).slice(0, 500)}`); };

const REPO = path.join(__dirname, '..');
const SHARED = path.join(REPO, 'src', 'lib', 'molecules', 'sources.js');

// ── THE BASELINE ────────────────────────────────────────────────────────────
//
// Captured from all five duplicated copies BEFORE the extraction, verified byte-identical in every
// one of them. This is the value, not the text, so reformatting the shared module cannot make this
// check pass or fail spuriously — only a change of MEMBERSHIP can.
const BASELINE = [
  { table: 'study_molecules', idCol: 'id', nameCol: 'molecule_name', casCol: 'cas_number', where: null },
  { table: 'research_interests', idCol: 'id', nameCol: 'value', casCol: 'cas', where: "kind = 'molecule'" },
  { table: 'supplier_products', idCol: 'id', nameCol: 'product_name', casCol: 'cas', where: null },
];

// Every consumer of the definition. If a sixth appears it must be added here, and proof 4 is what
// forces that: a new file with its own literal fails before anyone remembers this list.
const CONSUMERS = [
  'scripts/backfill-molecule-identity.js',
  'scripts/e1-reconcile.js',
  'scripts/e1-retract.js',
  'scripts/e1-snapshot.js',
  'scripts/molecule-identity-preview.js',
];

// Loading a consumer runs its module body, which for some of these touches the database pool at
// require time. JWT_SECRET and a DATABASE_URL that is never connected to keep that harmless.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sources-check';
process.env.DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://unused@127.0.0.1:1/unused?sslmode=disable';

const freshRequire = (rel) => {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(REPO, 'scripts')) || k.startsWith(path.join(REPO, 'src'))) {
      delete require.cache[k];
    }
  }
  return require(path.join(REPO, rel));
};

// ── 1. BEFORE == AFTER ──────────────────────────────────────────────────────
const shared = require(SHARED);
if (!shared || !Array.isArray(shared.SOURCES)) {
  bad('the shared module does not export a SOURCES array');
} else if (JSON.stringify(shared.SOURCES) === JSON.stringify(BASELINE)) {
  ok(`extraction preserved membership exactly — ${BASELINE.length} sources, unchanged`);
} else {
  bad('THE EXTRACTION CHANGED SOURCE MEMBERSHIP',
    `expected ${JSON.stringify(BASELINE)}\n          got      ${JSON.stringify(shared.SOURCES)}`);
}

// ── 2. ONE OBJECT, NOT SEVERAL EQUAL ONES ───────────────────────────────────
let identityFailures = 0;
for (const rel of CONSUMERS) {
  let mod;
  try { mod = require(path.join(REPO, rel)); } catch (e) {
    bad(`could not load ${rel}`, e.message); identityFailures += 1; continue;
  }
  if (!mod || !Object.prototype.hasOwnProperty.call(mod, 'SOURCES')) {
    bad(`${rel} does not export SOURCES, so its definition cannot be verified`);
    identityFailures += 1; continue;
  }
  if (mod.SOURCES !== shared.SOURCES) {
    bad(`${rel} holds its OWN SOURCES object, not the shared one`,
      JSON.stringify(mod.SOURCES) === JSON.stringify(shared.SOURCES)
        ? 'contents are equal, which is how a reintroduced copy hides'
        : 'contents differ too');
    identityFailures += 1;
  }
}
if (!identityFailures) {
  ok(`all ${CONSUMERS.length} consumers hold the SAME object (===), not equal copies`);
}

// ── 3. THE MUTATION CONTROL: removal must propagate ─────────────────────────
//
// Remove a source from the shared array and assert every consumer sees it go. A consumer holding
// its own copy would be unaffected, which is precisely the divergence this change prevents.
const removed = shared.SOURCES.pop();
try {
  const beforeLen = BASELINE.length;
  let propagated = 0;
  for (const rel of CONSUMERS) {
    const mod = require(path.join(REPO, rel));
    if (mod && Array.isArray(mod.SOURCES) && mod.SOURCES.length === beforeLen - 1) propagated += 1;
  }
  if (propagated === CONSUMERS.length) {
    ok(`MUTATION CONTROL: removing "${removed.table}" from the shared definition is observed by `
      + `all ${CONSUMERS.length} consumers`);
  } else {
    bad(`MUTATION CONTROL FAILED: only ${propagated} of ${CONSUMERS.length} consumers observed the `
      + 'removal — the rest are not really sharing the definition');
  }
  // And the baseline comparison must now go RED, proving proof 1 can detect a membership change
  // rather than passing because nothing ever changes.
  if (JSON.stringify(shared.SOURCES) !== JSON.stringify(BASELINE)) {
    ok('MUTATION CONTROL: proof 1 goes red on a membership change — it can detect one');
  } else {
    bad('proof 1 did not notice a removed source, so it cannot detect a membership change');
  }
} finally {
  shared.SOURCES.push(removed);
  if (JSON.stringify(shared.SOURCES) === JSON.stringify(BASELINE)) {
    ok('the shared definition was restored exactly after the mutation');
  } else {
    bad('THE SHARED DEFINITION WAS NOT RESTORED', JSON.stringify(shared.SOURCES));
  }
}

// ── 4. NO SURVIVING INDEPENDENT COPY, AND A REINTRODUCED ONE IS CAUGHT ──────
//
// A static scan, because object identity can only speak for files this check already knows about.
// Proof 2's consumer list is maintained by hand; this is what catches the file nobody added to it.
function filesDeclaringSources() {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(p, 'utf8');
      // A declaration of its own list — not a require, and not this check's own baseline.
      if (/\bconst\s+SOURCES\s*=\s*\[/.test(text)) hits.push(path.relative(REPO, p));
    }
  };
  walk(REPO);
  return hits;
}
const declarers = filesDeclaringSources();
const expected = ['src/lib/molecules/sources.js'];
if (JSON.stringify(declarers.sort()) === JSON.stringify(expected)) {
  ok('exactly one file declares a SOURCES list, and it is the shared module');
} else {
  bad('more than one file declares its own SOURCES list', declarers.join(', '));
}

// The scan must be able to find a reintroduced copy. Planted in a temp file inside the repo so the
// walker really has to see it, then removed.
const planted = path.join(REPO, 'scripts', '.sources-divergence-control.js');
try {
  fs.writeFileSync(planted,
    "'use strict';\nconst SOURCES = [{ table: 'sneaky', idCol: 'id', nameCol: 'n', casCol: 'c', where: null }];\n"
    + 'module.exports = { SOURCES };\n', 'utf8');
  const withPlant = filesDeclaringSources();
  if (withPlant.some((f) => f.endsWith('.sources-divergence-control.js'))) {
    ok('MUTATION CONTROL: a reintroduced independent SOURCES list IS detected by the scan');
  } else {
    bad('the scan did not detect a planted independent SOURCES list — proof 4 proves nothing');
  }
} finally {
  try { fs.unlinkSync(planted); } catch (_) { /* best effort */ }
  if (fs.existsSync(planted)) bad('the planted control file was not removed', planted);
  else ok('the planted control file was removed');
}

// ── 5. the reconciliation still runs ────────────────────────────────────────
//
// Delegated to its own check, which builds a real Postgres from the real DDL and executes
// e1-reconcile's main(). Running it here rather than asserting "the require worked" is the
// difference between proving the extraction is inert and hoping it is.
try {
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'check-reconcile-runs.js')],
    { stdio: 'pipe', env: { ...process.env, DATABASE_URL: '' } });
  ok('the reconciliation still runs end to end after the extraction');
} catch (e) {
  bad('the reconciliation check failed after the extraction',
    String(e.stdout || '').slice(-600) + String(e.stderr || '').slice(-300));
}

// ── 6. no consumer mutates the shared array ─────────────────────────────────
const afterAll = require(SHARED);
if (JSON.stringify(afterAll.SOURCES) === JSON.stringify(BASELINE)) {
  ok('no consumer mutated the shared definition during loading');
} else {
  bad('a consumer MUTATED the shared SOURCES array', JSON.stringify(afterAll.SOURCES));
}

if (fail) {
  out(`FAIL  ${fail} assertion(s) failed`);
  process.exit(1);
}
out('PASS  one SOURCES definition, shared by every consumer, and provably load-bearing');
process.exit(0);
