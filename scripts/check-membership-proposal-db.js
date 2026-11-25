#!/usr/bin/env node
// ── DOES THE B7.18 PROPOSAL RUN, AND IS IT RIGHT? ───────────────────────────
//
//   node scripts/check-membership-proposal-db.js   exit 0 = the proposal is correct and writes nothing
//                                                  exit 3 = NOT EXECUTED (no Postgres available)
//
// `membership-proposal-is-readonly.test.js` asserts what the tool's SOURCE may not contain. That is
// necessary and not sufficient: a tool can be read-only and still propose the wrong thing, or throw
// on the first row, or — worst — report an empty proposal because a query silently matched nothing.
// This runs it against a real database with fixtures whose correct answer is known in advance.
//
// THE ONE THAT MATTERS: the owner's measured example. `prasanthi@adificetechnologies.com`
// administers ABIOZEN. A fixture reproduces exactly that — an Adifice-domain address whose only
// assignment record is an ABIOZEN objective — and the proposal must say ABIOZEN. A
// domain-derived backfill would say Adifice, and because `user_companies` is what decides company
// scope, that error would be invisible until a workflow selected nobody.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures by id.

'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);
const REPO = path.join(__dirname, '..');

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'mprop' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  the membership proposal not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'mprop-bootstrap@mprop.invalid';
process.env.ADMIN_PASSWORD = `mprop-${crypto.randomBytes(16).toString('hex')}`;

const watchdog = setTimeout(() => {
  console.log('\n  FAIL  no progress in 240s — a stall is a failure.');
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
}, 240_000);
watchdog.unref?.();

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: cluster.url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };

  const runProposal = () => {
    try {
      const stdout = execFileSync(process.execPath,
        [path.join(REPO, 'scripts', 'propose-company-memberships.js'), '--json'],
        { env: { ...process.env, DATABASE_URL: cluster.url }, encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, json: JSON.parse(stdout) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };

  try {
    await require('../src/lib/db').initDB();
    // initPhase2 BEFORE migrateSchemas: `daily_tasks` is created by the phase-2 block, and
    // migrateRecordOwnership ALTERs it. Without this the ALTER failed with `relation "daily_tasks"
    // does not exist` — the same ordering trap recorded in db.js's own comment about four ALTERs
    // that ran 45 lines above the CREATE TABLE they depended on.
    await require('../src/lib/db').initPhase2();
    await require('../src/lib/db').migrateSchemas();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/identity/schema').migrateIdentity(q);
    await require('../src/lib/identity/schema').migrateRecordOwnership(q);
    console.log('  ..    schema up\n');

    const scope = require('../src/lib/office/scope');
    const uid = (p) => `mprop-${p}-${crypto.randomUUID().slice(0, 8)}`;

    const ABIOZEN = 'mprop-abiozen';
    const ADIFICE = 'mprop-adifice';
    await q(`INSERT INTO companies (id, slug, display_name, status)
             VALUES ($1,$1,'Abiozen fixture','active'), ($2,$2,'Adifice fixture','active')`,
      [ABIOZEN, ADIFICE]);

    const mkUser = async (email, role, active = 1) => {
      const id = uid('u');
      await q(`INSERT INTO users (id, email, name, role, password_hash, is_active)
               VALUES ($1,$2,$3,$4,'x',$5)`, [id, email, email.split('@')[0], role, active]);
      return id;
    };

    // ══ THE OWNER'S MEASURED EXAMPLE ══════════════════════════════════════
    console.log('── 1. the Adifice-domain address who administers ABIOZEN ──\n');

    const PRASANTHI = 'prasanthi@adificetechnologies.invalid';
    await mkUser(PRASANTHI, 'admin');
    // Her ONLY assignment record: she created an ABIOZEN objective. A person did that on purpose,
    // in the product, naming both sides.
    const obj = uid('obj');
    await scope.createObjective({
      id: obj, companyId: ABIOZEN, objective: 'an ABIOZEN objective she created', priority: 'P2',
      kpiMetric: 'x', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 10,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: PRASANTHI,
    }, deps);

    const r1 = runProposal();
    if (r1.code !== 0) { bad('the proposal did not run', r1.out); throw new Error('no run'); }
    ok('the proposal runs and emits JSON');

    const hers = r1.json.proposed_from_reviewed_records.filter((p) => p.email === PRASANTHI);
    if (hers.length === 1 && hers[0].proposedCompany === ABIOZEN) {
      ok('it proposes ABIOZEN for the Adifice-domain address — from the objective she created, not '
        + 'from her domain');
      note(`basis: ${hers[0].basis}`);
      note('a domain-derived backfill would have said Adifice, and taken ABIOZEN its own admin');
    } else bad('the proposal used the wrong source', JSON.stringify(hers));

    if (hers.length && hers[0].companyRole === null) {
      ok('and it proposes NO company_role — guessing `member` would silently demote an administrator');
    } else bad('a company role was guessed', JSON.stringify(hers));

    // ══ 2. NOBODY IS PLACED BY THEIR DOMAIN ═══════════════════════════════
    console.log('\n── 2. an address with no assignment record is not placed ──\n');

    const DOMAIN_ONLY = 'someone@mprop-abiozen.invalid';
    await mkUser(DOMAIN_ONLY, 'sales_team');
    const r2 = runProposal();
    const placed = r2.json.proposed_from_reviewed_records.some((p) => p.email === DOMAIN_ONLY);
    const undecided = r2.json.needs_a_decision.some((u) => u.email === DOMAIN_ONLY);
    if (!placed && undecided) {
      ok('an active internal user with no assignment record appears under NEEDS A DECISION with no '
        + 'proposed company');
      note('a long list here is the honest answer, not a gap');
    } else bad('a user was placed without an assignment record',
      JSON.stringify({ placed, undecided }));

    // ══ 3. A SHARED EMPLOYEE IS NAMED AS ONE ══════════════════════════════
    console.log('\n── 3. a shared employee is flagged, not resolved ──\n');

    const obj2 = uid('obj2');
    await scope.createObjective({
      id: obj2, companyId: ADIFICE, objective: 'an Adifice objective she also created',
      priority: 'P3', kpiMetric: 'x', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 10,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: PRASANTHI,
    }, deps);
    const r3 = runProposal();
    const both = r3.json.proposed_from_reviewed_records.filter((p) => p.email === PRASANTHI);
    if (both.length === 2 && r3.json.shared_employees_proposed.includes(PRASANTHI)) {
      ok('with assignment records at TWO companies she is proposed for both and named a shared '
        + 'employee — not resolved to one by a tiebreak');
      note(`proposed: ${both.map((p) => p.proposedCompany).join(', ')}`);
    } else bad('the shared-employee case was resolved or missed',
      JSON.stringify({ both, shared: r3.json.shared_employees_proposed }));

    // ══ 4. AN EXISTING MEMBERSHIP IS NOT RE-PROPOSED ══════════════════════
    console.log('\n── 4. an existing grant is reported, not repeated ──\n');

    const GRANTER = await mkUser('granter@mprop.invalid', 'super_admin');
    const MEMBERSHIP = require('../src/lib/identity/company-membership');
    const subject = (await q(`SELECT id FROM users WHERE email = $1`, [PRASANTHI])).rows[0].id;
    await MEMBERSHIP.grantMembership({
      userId: subject, companyId: ABIOZEN, companyRole: 'admin', grantedBy: GRANTER,
      grantedReason: 'mprop fixture: the half-applied backfill case',
    }, deps);

    const r4 = runProposal();
    const stillProposed = r4.json.proposed_from_reviewed_records
      .filter((p) => p.email === PRASANTHI).map((p) => p.proposedCompany);
    const alreadyHas = r4.json.already_granted.some((g) => g.userId === subject
      && g.memberships.some((m) => m.company === ABIOZEN));
    if (alreadyHas && !stillProposed.includes(ABIOZEN) && stillProposed.includes(ADIFICE)) {
      ok('the granted company moves to ALREADY GRANTED and is not proposed again; the ungranted '
        + 'one still is');
      note('so a half-applied backfill is visible rather than producing duplicate grants');
    } else bad('a granted membership was re-proposed or lost',
      JSON.stringify({ alreadyHas, stillProposed }));

    // ══ 5. EXTERNAL ROLES ARE NAMED, NOT OMITTED ══════════════════════════
    console.log('\n── 5. external roles ──\n');

    const PARTNER = 'agency@partner.invalid';
    await mkUser(PARTNER, 'partner');
    const r5 = runProposal();
    const asExternal = r5.json.external_roles_not_members.some((u) => u.email === PARTNER);
    const asInternal = r5.json.needs_a_decision.some((u) => u.email === PARTNER)
      || r5.json.proposed_from_reviewed_records.some((p) => p.email === PARTNER);
    if (asExternal && !asInternal) {
      ok('a partner is listed as an external role and is NOT proposed or left needing a decision — '
        + 'their absence is stated rather than looking like an oversight');
    } else bad('an external role was treated as an internal member',
      JSON.stringify({ asExternal, asInternal }));

    // ══ 6. IT WROTE NOTHING ═══════════════════════════════════════════════
    console.log('\n── 6. it wrote nothing ──\n');

    const before = (await q(`SELECT COUNT(*)::int n FROM user_companies`)).rows[0].n;
    runProposal(); runProposal();
    const after = (await q(`SELECT COUNT(*)::int n FROM user_companies`)).rows[0].n;
    if (before === after && after === 1) {
      ok(`three proposal runs left user_companies at ${after} row — the one the FIXTURE granted`);
    } else bad('the proposal wrote to user_companies', { before, after });

    if (r5.json.writes_nothing === true) ok('and it says so in its own output');
    else bad('the output does not declare itself read-only');

    // ══ 7. UNREADABLE IS NOT EMPTY ════════════════════════════════════════
    console.log('\n── 7. an unreadable database is NOT an empty proposal ──\n');

    let notExecuted = null;
    try {
      execFileSync(process.execPath,
        [path.join(REPO, 'scripts', 'propose-company-memberships.js'), '--json'],
        { env: { ...process.env, DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none' },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      notExecuted = 0;
    } catch (e) { notExecuted = e.status; }
    if (notExecuted === 3) {
      ok('against an unreachable database it exits 3 (NOT EXECUTED) rather than 0 with an empty '
        + 'proposal');
      note('exit 0 there would read as "nobody needs a membership" — the most dangerous possible '
        + 'wrong answer for a backfill');
    } else bad('an unreadable database produced something other than NOT EXECUTED', notExecuted);

    console.log('');
  } catch (e) {
    bad('the check itself threw', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    // The whole cluster is destroyed; these deletes are belt and braces for the leak report.
    try {
      await q(`DELETE FROM user_companies`).catch(() => {});
      await q(`DELETE FROM objectives WHERE id LIKE 'mprop-%'`).catch(() => {});
      await q(`DELETE FROM users WHERE email LIKE '%mprop%' OR email LIKE '%partner.invalid'
                 OR email LIKE '%adificetechnologies.invalid'`).catch(() => {});
      await q(`DELETE FROM companies WHERE id LIKE 'mprop-%'`).catch(() => {});
      const left = (await q(`SELECT COUNT(*)::int n FROM companies WHERE id LIKE 'mprop-%'`)).rows[0].n;
      if (left === 0) ok('cleanup: my fixtures are gone');
      else bad('cleanup leaked fixtures', left);
    } catch (e) {
      bad('cleanup itself failed', e && e.message);
    }
    await P.end().catch(() => {});
    clearTimeout(watchdog);
    cluster.destroy();
  }

  console.log(`\n  ${pass} ok, ${fail} failed`);
  if (fail) {
    console.log('\nFAIL  the membership proposal is not trustworthy.');
    process.exit(1);
  }
  console.log('\nPASS  B7.18 dry run: the proposal derives a membership only from a reviewed '
    + 'assignment record naming both a user and a company — the Adifice-domain address who '
    + 'administers ABIOZEN is proposed for ABIOZEN; nobody is placed by their domain; a shared '
    + 'employee is flagged rather than resolved; no company_role is guessed; an existing grant is '
    + 'reported rather than repeated; external roles are named rather than omitted; it writes '
    + 'nothing; and an unreadable database is NOT EXECUTED rather than an empty proposal.');
  process.exit(0);
})();
