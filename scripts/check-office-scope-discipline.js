#!/usr/bin/env node
// ── K1 READ-SIDE SCOPE DISCIPLINE ────────────────────────────────────────────
//
//   scripts/check-office-scope-discipline.js  → exit 0 = no kernel table is read or written in
//                                               SQL outside the one accessor module
//
// ── WHAT THIS CHECK IS, AND WHAT IT IS NOT ───────────────────────────────────
//
// Composite foreign keys make cross-company WRITES a referential impossibility. They do not
// scope READS, and no foreign key can. The ruling set the bar for the read side:
//
//   "If the proposed enforcement only works because every developer remembers to write
//    WHERE company_id = ?, K1 is not complete."
//
// src/lib/office/scope.js answers that by owning the predicate: callers cannot forget it because
// callers never write it, and they never write it because they do not have the table names. This
// check is what keeps that true — it is the difference between "every developer remembers" and
// "a check fails if they don't".
//
// IT IS WEAKER THAN THE WRITE SIDE AND IS NOT PRESENTED OTHERWISE. It is static: it can be
// defeated by dynamic SQL built from fragments, and it protects THIS REPOSITORY rather than the
// database — a psql session or another service is outside its reach. Read-side enforcement in
// the database itself requires row-level security, which requires a non-superuser application
// role, because PostgreSQL bypasses RLS for superusers even under FORCE ROW LEVEL SECURITY and
// DATABASE_URL connects as `postgres`. That is an infrastructure decision, recorded as a residual
// risk rather than quietly assumed.
//
// THE TABLE LIST IS NOT MAINTAINED HERE. It is read from src/lib/office/schema.js, so adding a
// kernel table brings it under this check automatically instead of requiring somebody to
// remember to list it in two places — the duplication that put five copies of SOURCES in the
// repo.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { KERNEL_TABLES } = require('../src/lib/office/schema');

let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => {
  fail++; console.log(`  FAIL  ${m}`);
  if (d) console.log(String(d).split('\n').map((l) => `          ${l}`).join('\n'));
};

const ROOT = path.join(__dirname, '..');

// THE EXEMPTION RULE, AND ITS LIMIT.
//
// Two kinds of file may name a kernel table in SQL:
//   • the accessor itself (it owns the predicate) and the schema (it owns the DDL);
//   • VALIDATORS AND MEASUREMENT SCRIPTS, whose job is to observe or attack the raw tables in
//     order to prove something ABOUT them. A cross-company insert has to be built by hand — the
//     accessor exists precisely to make it unrepresentable, so a validator routed through it would
//     prove nothing about the constraints — and a global tamper count ("zero recovery exceptions
//     were manufactured") is not expressible through a company-scoped read at all. These scripts
//     test the database, not the application.
//
//     This category was first written as "isolation validators". It has since taken an activation
//     proof and a measurement script, so the rule is restated to match the list rather than left
//     to drift — a stated rule that quietly diverges from what it permits is how a guard rots.
//
// NOTHING ELSE. In particular no product code is ever exempt, and that is asserted below rather
// than left to the reader — an exemption list that nobody checks is how this kind of guard dies:
// the next person hits the failure, adds a line here, and the predicate quietly moves back to the
// call sites.
const EXEMPT = new Set([
  // The end-to-end acceptance test (ruling 8 item 5). It SEEDS a company, an objective and a run
  // into a DISPOSABLE cluster it creates and destroys, so that the real server has something to
  // serve — the kernel rows are the fixture, not the subject. It never runs against production
  // and reads nothing through a scoped query it could have used instead. Same category as the
  // validators below: a measurement harness, not product code.
  path.join('scripts', 'acceptance-e2e.js'),
  // Same category. It builds a minimal office_approvals in a DISPOSABLE cluster — by hand, with
  // no foreign keys, exactly as it already builds email_log — so that the approval gate added on
  // 2026-11-11 can be SATISFIED and therefore stop masking what that file actually measures:
  // whether a workflow-scoped stop refuses the legacy buyer path. Fixture, not subject; it
  // asserts nothing about approvals and never runs against production.
  path.join('scripts', 'check-legacy-email-containment-db.js'),
  path.join('src', 'lib', 'office', 'scope.js'),
  path.join('src', 'lib', 'office', 'schema.js'),
  path.join('scripts', 'check-office-scope-discipline.js'),
  path.join('scripts', 'check-office-isolation-db.js'),
  path.join('scripts', 'validate-k1-deployed.js'),
  path.join('scripts', 'check-k1-validator-runs.js'),
  path.join('scripts', 'check-office-k2-db.js'),
  path.join('scripts', 'validate-k2-deployed.js'),
  path.join('scripts', 'check-office-recovery-db.js'),
  path.join('scripts', 'validate-k4-activation-deployed.js'),
  path.join('scripts', 'check-office-governed-ai-db.js'),
  path.join('scripts', 'office-create-first-objective.js'),
  // Verification independence (Rule 6): these two read the kernel tables in RAW SQL on purpose.
  // The accessor is the thing under test — reading the evidence back through it would mean the
  // check and the implementation share every assumption, so a scoping bug would pass both.
  path.join('scripts', 'office-validate-governed-ai.js'),
  path.join('scripts', 'check-governed-ai-validator-runs.js'),
  path.join('scripts', 'validate-k5-budget-deployed.js'),
  path.join('scripts', 'validate-k7-k9-deployed.js'),
  path.join('scripts', 'office-activate-objective.js'),
  path.join('scripts', 'office-prepare-first-rfq.js'),
  path.join('scripts', 'office-rfq-candidates.js'),
  path.join('scripts', 'office-decide-approval.js'),
  path.join('scripts', 'office-release-approved.js'),
  path.join('scripts', 'office-pending-approvals.js'),
  path.join('scripts', 'validate-r1-deployed.js'),
  path.join('scripts', 'check-office-release-db.js'),
  // Seeds office_approvals by hand to prove the supplier-eligibility read sees a REJECTED approval
  // — which leaves no outreach row, so the pair's deterministic approval id is spent invisibly.
  // The library it tests names no kernel table: it goes through the accessor, as product code must.
  path.join('scripts', 'check-supplier-evidence-sql.js'),
  // Rehearses office-pre-release-report.js on a throwaway cluster. It must set release_mode,
  // deactivate a signatory and plant an ACTION_ATTEMPTED by hand — the accessor exists precisely
  // to make those unrepresentable, so a rehearsal routed through it would prove nothing. The
  // report it rehearses names no kernel table: it goes through the accessor.
  path.join('scripts', 'check-pre-release-report-runs.js'),
  // Attacks office_approvals by hand to prove the supersession transition is no wider than it was
  // authorized to be: it must set release_claimed_at and plant an outreach row to construct the
  // states that MUST be refused. The accessor exists to make those unrepresentable, so a harness
  // routed through it would prove nothing about the arbitration. The operation it tests names no
  // kernel table outside the accessor.
  path.join('scripts', 'check-office-supersede-db.js'),
  // Reads `objectives` raw to answer "is any objective set to release without a second human
  // act" — a GLOBAL question across every company, which a company-scoped accessor cannot ask.
  // Read-only: it writes nothing and sends nothing.
  path.join('scripts', 'confirm-legacy-email-state.js'),
]);

// Product code may never be exempt. The only permitted exemptions under src/ are the accessor and
// the schema; everything else exempt must be a script.
const ALLOWED_SRC_EXEMPTIONS = new Set([
  path.join('src', 'lib', 'office', 'scope.js'),
  path.join('src', 'lib', 'office', 'schema.js'),
]);

const SCAN_DIRS = ['src', 'scripts', 'public'];
const SCAN_EXT = new Set(['.js', '.html']);

// SQL CONTEXTS ONLY. `objectives` is an ordinary English word that appears in prose, comments and
// variable names; matching the bare token would produce noise, and a check that cries wolf gets
// an exemption added to it rather than a fix. So the pattern requires a SQL keyword immediately
// before the table name.
function sqlUses(src, table) {
  const re = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE|TABLE|DELETE\\s+FROM)\\s+${table}\\b`, 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    hits.push({ line, text: m[0].replace(/\s+/g, ' ') });
  }
  return hits;
}

// ── THE INDIRECTION THAT GOT PAST THIS CHECK ────────────────────────────────
//
// sqlUses looks for `FROM office_approvals`. On 2026-11-11 a verification query was written in
// src/lib/email-gate.js as:
//
//     const APPROVAL_TABLE = 'office_approvals';
//     ... `SELECT ... FROM ${APPROVAL_TABLE} WHERE id = $1`
//
// and this file passed. The table name never appeared next to FROM, so a text search could not
// see it. It was not an attempt to evade anything — it was a named constant written for tidiness,
// which is exactly why it matters: the next one will be accidental too.
//
// ── AND WHY THIS RULE IS NARROW ─────────────────────────────────────────────
//
// The first version of this assertion flagged the table name ANYWHERE in code, and it was wrong.
// It fired on `source: 'office_approvals'` in decision-sources.js — a label on a queue row saying
// where the item came from, not a table reference — and this file already carries a deliberate
// control stating that "prose and identifiers naming kernel tables do NOT trip it". A check that
// contradicts its own control is a check somebody silences with an exemption.
//
// So the rule is the actual defect shape: a binding whose value is a kernel table name, which is
// then INTERPOLATED into something that reads as SQL. Labels, log lines and information_schema
// probes are untouched.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const SQL_KEYWORD = '(?:FROM|JOIN|INTO|UPDATE|TABLE|DELETE\\s+FROM)';

function smuggledTableName(src, table) {
  // Comments are blanked rather than deleted, so reported line numbers still match the real file.
  // The first version counted lines in the stripped text and pointed at the wrong ones.
  const code = stripComments(src);
  const hits = [];
  const decl = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"\`]${table}['"\`]`, 'g');
  let m;
  while ((m = decl.exec(code)) !== null) {
    const name = m[1];
    const interp = new RegExp(`${SQL_KEYWORD}\\s*\\$\\{\\s*${name}\\s*\\}`, 'i');
    const where = interp.exec(code);
    if (!where) continue;
    hits.push({
      line: code.slice(0, m.index).split('\n').length,
      usedLine: code.slice(0, where.index).split('\n').length,
      text: `${name} = '${table}'`,
    });
  }
  return hits;
}

function scanNames(files) {
  const out = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    if (EXEMPT.has(rel)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const table of KERNEL_TABLES) {
      for (const h of smuggledTableName(src, table)) {
        out.push(`${rel}:${h.line}  ${h.text}, interpolated into SQL at line ${h.usedLine}`);
      }
    }
  }
  return out;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SCAN_EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

function scan(files) {
  const violations = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    if (EXEMPT.has(rel)) continue;
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    for (const table of KERNEL_TABLES) {
      for (const h of sqlUses(src, table)) violations.push(`${rel}:${h.line}  ${h.text}`);
    }
  }
  return violations;
}

const files = walk(path.join(ROOT, 'src'))
  .concat(walk(path.join(ROOT, 'scripts')))
  .concat(walk(path.join(ROOT, 'public')));

if (!files.length) {
  bad('scanned zero files — the walk is broken and this check would pass vacuously');
} else {
  ok(`scanned ${files.length} files across ${SCAN_DIRS.join(', ')} for ${KERNEL_TABLES.length} kernel tables`);
}

// The exemption list guards itself: a future exemption for product code fails here.
const smuggled = [...EXEMPT].filter((p) => p.startsWith(`src${path.sep}`) && !ALLOWED_SRC_EXEMPTIONS.has(p));
if (smuggled.length) {
  bad('product code has been added to the exemption list — company scoping must not move back to call sites',
    smuggled.join('\n'));
} else {
  ok(`exemptions are the accessor, the schema and ${EXEMPT.size - ALLOWED_SRC_EXEMPTIONS.size} validator/measurement script(s) — no product code`);
}

const violations = scan(files);
if (violations.length) {
  bad(`kernel tables are reached in SQL outside src/lib/office/scope.js (${violations.length})`,
    violations.join('\n') +
    '\n\nAdd a function to src/lib/office/scope.js instead. Company scoping lives in one file on' +
    '\npurpose: a predicate written at the call site is a predicate somebody can forget.');
} else {
  ok('no kernel table is reached in SQL outside the accessor');
}

const named = scanNames(files);
if (named.length) {
  bad(`kernel tables reach SQL through a constant outside the accessor (${named.length})`,
    `        ${named.join('\n        ')}\n\n`
    + '        A constant holding a kernel table name hides it from the SQL scan above — which is\n'
    + '        how a query in email-gate.js passed this check on 2026-11-11. Put the SQL in\n'
    + '        src/lib/office/scope.js.');
} else {
  ok('no kernel table reaches SQL through a constant either');
}

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────
// Platform invariant 1: every reconciliation must have a negative control proving it can detect
// the defect it claims to detect. Without this, a broken regex, an over-broad exemption or a
// mis-rooted walk produces a confident green on a repository full of violations — which is
// exactly how `tail -1` took production down on 30 Sep.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-ctl-'));
try {
  const planted = path.join(tmp, 'violation.js');
  fs.writeFileSync(planted, `
    // A plausible violation: someone adds a dashboard query where it is convenient.
    async function pendingForDashboard(query, companyId) {
      return query('SELECT id FROM office_approvals WHERE company_id = $1', [companyId]);
    }
    module.exports = { pendingForDashboard };
  `);
  const caught = scan([planted]);
  if (caught.length) ok('negative control: a planted out-of-accessor query IS detected');
  else bad('negative control FAILED — a planted violation was not detected, so a green result here means nothing');

  // The control for the NEW assertion, and it is the real one: the exact shape that got past this
  // file. If scanNames does not catch a constant, the hole is still open.
  const smuggledConst = path.join(tmp, 'smuggled.js');
  fs.writeFileSync(smuggledConst, `
    const T = 'office_approvals';
    async function read(query, id) {
      return (await query(\`SELECT status FROM \${T} WHERE id = $1\`, [id])).rows[0];
    }
    module.exports = { read };
  `);
  if (scan([smuggledConst]).length) {
    bad('the SQL scan unexpectedly caught a templated table name — update these controls');
  } else if (scanNames([smuggledConst]).length) {
    ok('negative control: a kernel table smuggled through a constant IS detected');
  } else {
    bad('negative control FAILED — a kernel table name in a constant is still invisible, so the '
      + 'indirection that got past this check on 2026-11-11 would get past it again');
  }

  // And a control for the false-positive direction: prose must not trip it, or the next person
  // silences this check with an exemption instead of fixing a real finding.
  const prose = path.join(tmp, 'prose.js');
  fs.writeFileSync(prose, `
    // We track objectives and office_exceptions in the kernel; see the design doc for how
    // office_approvals ages. None of this is SQL.
    const objectives = [];
    module.exports = { objectives };
  `);
  const noise = [...scan([prose]), ...scanNames([prose])];
  if (noise.length) bad('negative control: prose and identifiers tripped the check (false positive)', noise.join('\n'));
  else ok('negative control: prose and identifiers naming kernel tables do NOT trip it');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

console.log(fail ? `\nFAIL  ${fail} scope-discipline assertion(s) failed` : '\nPASS  kernel tables are reached only through the company-scoped accessor');
process.exit(fail ? 1 : 0);
