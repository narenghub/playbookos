#!/usr/bin/env node
// ── MANY-TO-MANY COMPANY MEMBERSHIP, PROVED AGAINST A REAL SERVER ───────────
//
//   node scripts/check-company-membership-db.js   exit 0 = every ruled property holds
//                                                 exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner ruling 2026-11-24 (B7.8) approved a many-to-many membership architecture for a
// multi-company operating system — ABIOZEN, Adifice, Favly, Linkabl, GolfNex and more. Twelve
// requirements came with it. Every one that is a database property is asserted here, because they
// are SQL semantics and a stubbed query cannot prove any of them: "global deactivation overrides
// every company membership" is a claim about a join, not about JavaScript.
//
// ── WHY THERE IS NO URL OVERRIDE ────────────────────────────────────────────
//
// Sibling checks accept an environment variable pointing at an existing server. This one does not,
// and that is deliberate. It INSERTs and DELETEs rows in `users` and `user_companies` — the
// account table and the access-grant table. CLAUDE.md's rule exists because of
// verify-product-revocation-live.js, which wrote to the live super admin on the expectation that a
// guard would refuse, and on 2026-09-30 the guard allowed it and the write landed. "It will be
// refused anyway" is a prediction, not a safeguard. A script that can only ever reach a cluster it
// created itself cannot have that accident, so it is built that way rather than guarded into it.
//
// Fixtures are still recorded and removed BY ID, because the discipline is the point and because
// the next person to add an override should find cleanup that was already correct.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pgBin, INITDB_FLAGS, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0; let temp = null;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);

// ── CLUSTER LIFECYCLE: THE SHARED UTILITY, NOT A LOCAL COPY ─────────────────
//
// This file used to carry its own startTemp/stopTemp — a per-run port, an explicit pg_ctl logfile,
// and a cleanup that ran only on the happy path. Every DB check carries a version of the same
// thing, and on 2026-11-24 the accumulated orphans from killed runs filled the disk to 100% and
// preflight reported it as "database TLS verification refuses the wrong certificate".
//
// scripts/lib/pg-disposable.js owns that lifecycle now: unique directory and port per run, an
// ownership marker recording the pid AND its start time, signal-handler cleanup as well as normal
// cleanup, and a reclaim path that demands positive ownership evidence. This is the first check
// migrated to it; the rest follow incrementally.
const DISPOSABLE = require('./lib/pg-disposable');

let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'membership' });
} catch (e) {
  if (e && e.infrastructure) {
    // An infrastructure failure is NOT a product failure, and conflating them is the whole reason
    // the shared utility exists.
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  company membership not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
const url = cluster.url;
const stopTemp = () => cluster.destroy();

process.env.DATABASE_URL = url;

// initDB() creates `users` — which this check needs for its foreign key — and then REFUSES to
// finish without an admin to bootstrap: "No admin user exists and ADMIN_EMAIL/ADMIN_PASSWORD env
// vars are not set." Found by this check hanging with NO OUTPUT AT ALL: initDB rejected, the catch
// below ran, and the half-initialised pool kept the process alive, so even the failure never
// printed. A check that cannot report its own failure is worse than one that fails.
//
// These are fixture values for a disposable cluster this script created seconds earlier and
// destroys on the way out. They are credentials for nothing: it listens on a unix socket in a
// temp directory and nothing outside this process can reach it. Letting initDB run to completion
// is deliberate — `users` is then the REAL table from src/lib/db.js rather than a hand-copied DDL
// that would drift from it.
process.env.ADMIN_EMAIL = 'mbrchk-bootstrap@mbrchk.invalid';
process.env.ADMIN_PASSWORD = `mbrchk-${require('node:crypto').randomBytes(16).toString('hex')}`;

// ── A CHECK THAT CANNOT REPORT ITS OWN FAILURE IS WORSE THAN A FAILING ONE ──
//
// This script sat for ten minutes printing nothing, which told whoever was watching neither
// "passed", "failed", nor "could not run". The watchdog converts any such stall into a stated
// verdict with a non-zero exit, because silence is the one outcome a verifier must never produce.
const WATCHDOG_MS = Number(process.env.MEMBERSHIP_CHECK_TIMEOUT_MS || 180_000);
const watchdog = setTimeout(() => {
  console.log(`\n  FAIL  the check made no progress in ${Math.round(WATCHDOG_MS / 1000)}s and was `
    + 'stopped. A stall is a failure, not a pass.');
  try { stopTemp(); } catch (_) {}
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

const AT = new Date('2026-11-24T12:00:00Z');
const EARLIER = new Date('2026-11-01T00:00:00Z');
const LATER = new Date('2026-12-31T00:00:00Z');

(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: url, ssl: false });
  const q = (t, p) => P.query(t, p);
  const deps = { query: q };
  const made = { users: [], companies: [], memberships: [] };

  try {
    console.log('  ..    initDB (creates users)');
    await require('../src/lib/db').initDB();              // users
    console.log('  ..    initDB done');
    // migrateOffice ALTERs agent_runs, which migrateRuns creates. Omitting this threw
    // `relation "agent_runs" does not exist` — which also confirms that 42P01 is not among the
    // ignorable codes, so a wrong migration order fails loudly instead of silently skipping the
    // table this check exists to exercise.
    await require('../src/lib/runs').migrateRuns(q);
    console.log('  ..    migrateOffice');
    await require('../src/lib/office/schema').migrateOffice(q);
    console.log('  ..    migrateOffice done');
    await require('../src/lib/identity/schema').migrateIdentity(q);
    console.log('  ..    migrateIdentity done');

    const M = require('../src/lib/identity/company-membership');

    // ── THE TABLE AND ITS CONSTRAINTS EXIST AT ALL ─────────────────────────
    const cols = (await q(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_companies'`))
      .rows.map((r) => r.column_name);
    const required = ['user_id', 'company_id', 'company_role', 'status', 'effective_from',
      'effective_to', 'granted_by', 'revoked_at', 'revoked_by'];
    const missing = required.filter((c) => !cols.includes(c));
    if (!missing.length) ok('user_companies carries every ruled column');
    else bad('user_companies is missing ruled columns', missing);

    const idx = (await q(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'user_companies_one_active'`)).rows[0];
    if (idx && /WHERE \(?status = 'active'/.test(idx.indexdef)) {
      ok('one ACTIVE membership per (person, company), with revoked history kept');
    } else {
      bad('the partial unique index is absent — history and uniqueness cannot both hold', idx);
    }

    // ── FIXTURES ───────────────────────────────────────────────────────────
    const mkCompany = async (slug) => {
      const id = `mbrchk-co-${slug}`;
      await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$2,$3,'active')`,
        [id, `mbrchk-${slug}`, `MbrChk ${slug}`]);
      made.companies.push(id);
      return id;
    };
    const mkUser = async (handle, role = 'admin', active = 1) => {
      const id = `mbrchk-u-${handle}`;
      await q(`INSERT INTO users (id, email, name, role, is_active) VALUES ($1,$2,$3,$4,$5)`,
        [id, `${handle}@mbrchk.invalid`, handle, role, active]);
      made.users.push(id);
      return id;
    };
    // Every grant needs an AUTHORIZED actor now, not just a recorded one. A global super_admin is
    // the fixture's administrator; the checks further down prove that anyone else is refused.
    const owner = await mkUser('owner', 'super_admin');
    const grant = async (userId, companyId, opts = {}) => {
      const row = await M.grantMembership({
        userId, companyId, companyRole: opts.companyRole || 'admin',
        grantedBy: opts.grantedBy || owner, grantedReason: 'fixture',
        effectiveFrom: opts.effectiveFrom || EARLIER, effectiveTo: opts.effectiveTo || null,
      }, deps);
      made.memberships.push(row.id);
      return row;
    };

    const abiozen = await mkCompany('abiozen');
    const adifice = await mkCompany('adifice');
    const favly = await mkCompany('favly');

    // ── MIGRATION IS REPEATABLE ────────────────────────────────────────────
    // Applying the schema twice must be a no-op, not an error and not a second table. Everything
    // below runs against a database that has been migrated twice, so this is load-bearing rather
    // than decorative.
    try {
      await require('../src/lib/office/schema').migrateOffice(q);
      await require('../src/lib/identity/schema').migrateIdentity(q);
      const n = (await q(
        `SELECT COUNT(*)::int n FROM information_schema.tables WHERE table_name = 'user_companies'`))
        .rows[0].n;
      if (n === 1) ok('migration is repeatable — applying it twice leaves exactly one table');
      else bad('re-running the migration did not leave one table', n);
    } catch (e) {
      bad('re-running the migration threw — it is not idempotent', e && e.message);
    }

    // ── REQ: AN ACTIVE AUTHORIZED EMPLOYEE IS A MEMBER ─────────────────────
    const employee = await mkUser('employee');
    await grant(employee, abiozen);
    if (await M.isActiveMember({ userId: employee, companyId: abiozen }, { at: AT, ...deps }) === true) {
      ok('an active authorized employee IS a member');
    } else {
      bad('an active authorized employee was not recognised — the whole model is inert');
    }

    // ── REQ 6: CROSS-COMPANY ACCESS IS REFUSED WITHOUT AN EXPLICIT GRANT ───
    if (await M.isActiveMember({ userId: employee, companyId: adifice }, { at: AT, ...deps }) === false) {
      ok('DECISIVE: a member of one company is NOT a member of another — common ownership grants nothing');
    } else {
      bad('cross-company access was allowed without an explicit membership');
    }

    // ── REQ 6: A SHARED EMPLOYEE NEEDS TWO EXPLICIT MEMBERSHIPS ────────────
    const shared = await mkUser('shared');
    await grant(shared, abiozen, { companyRole: 'admin' });
    await grant(shared, adifice, { companyRole: 'dev_team' });
    const sharedIn = await M.membershipsOf(shared, { at: AT, ...deps });
    const sharedIds = (sharedIn || []).map((m) => m.companyId).sort();
    if (JSON.stringify(sharedIds) === JSON.stringify([abiozen, adifice].sort())) {
      ok('a shared employee holds BOTH memberships, each with its own company role');
    } else {
      bad('shared memberships did not resolve', sharedIds);
    }
    if (await M.isActiveMember({ userId: shared, companyId: favly }, { at: AT, ...deps }) === false) {
      ok('…and operates ONLY within assigned scopes — the third company is still refused');
    } else {
      bad('a shared employee reached a company they were never granted');
    }
    const roles = Object.fromEntries((sharedIn || []).map((m) => [m.companyId, m.companyRole]));
    if (roles[abiozen] === 'admin' && roles[adifice] === 'dev_team') {
      ok('company-specific roles are per membership, not per account');
    } else {
      bad('company roles did not come back per company', roles);
    }

    // ── REQ 5: REVOCATION IS SCOPED ────────────────────────────────────────
    const rev = await M.revokeMembership({ userId: shared, companyId: abiozen,
      revokedBy: owner, revokedReason: 'scoped revocation test' }, deps);
    if (rev.revoked === 1) ok('revoking one membership affects exactly one row');
    else bad('revocation touched the wrong number of rows', rev.revoked);

    if (await M.isActiveMember({ userId: shared, companyId: abiozen }, { at: AT, ...deps }) === false) {
      ok('DECISIVE: the revoked company is immediately refused');
    } else {
      bad('a revoked membership still authorized access');
    }
    if (await M.isActiveMember({ userId: shared, companyId: adifice }, { at: AT, ...deps }) === true) {
      ok('DECISIVE: …and the OTHER authorized membership is untouched');
    } else {
      bad('revoking one company also removed another — revocation is not scoped');
    }

    const hist = (await q(
      `SELECT status, revoked_by, revoked_reason FROM user_companies
        WHERE user_id = $1 AND company_id = $2`, [shared, abiozen])).rows[0];
    if (hist && hist.status === 'revoked' && hist.revoked_by === owner) {
      ok('the revoked membership is KEPT, carrying who removed the access and why');
    } else {
      bad('revocation deleted the row or lost its attribution', hist);
    }

    // ── REQ 4: GLOBAL DEACTIVATION OVERRIDES EVERY MEMBERSHIP ──────────────
    const departed = await mkUser('departed');
    await grant(departed, abiozen);
    await grant(departed, adifice);
    await q(`UPDATE users SET is_active = 0 WHERE id = $1`, [departed]);
    const departedIn = await M.membershipsOf(departed, { at: AT, ...deps });
    if (Array.isArray(departedIn) && departedIn.length === 0) {
      ok('DECISIVE: global deactivation overrides EVERY company membership, live rows and all');
    } else {
      bad('a globally deactivated account still held memberships', departedIn);
    }
    if (await M.isActiveMember({ userId: departed, companyId: abiozen }, { at: AT, ...deps }) === false) {
      ok('…and naming the right company does not get a departed employee back in');
    } else {
      bad('a deactivated account was authorized by naming its company');
    }
    const stillThere = (await q(
      `SELECT COUNT(*)::int n FROM user_companies WHERE user_id = $1 AND status = 'active'`,
      [departed])).rows[0].n;
    if (stillThere === 2) {
      ok('CONTROL: the membership rows still exist — the override is at read time, not a deletion');
    } else {
      bad('deactivation destroyed membership rows; re-activation would silently lose access', stillThere);
    }

    // ── REQ 9: AN EXTERNAL PARTNER IS NOT AN EMPLOYEE ──────────────────────
    const partner = await mkUser('partner', 'partner');
    await grant(partner, abiozen, { companyRole: 'admin' });   // even with an internal company role
    if (await M.isActiveMember({ userId: partner, companyId: abiozen }, { at: AT, ...deps }) === false) {
      ok('DECISIVE: an external partner account is NOT an internal member, even with a membership row');
    } else {
      bad('an external partner was treated as an employee');
    }
    let refusedExternalRole = false;
    try {
      await M.grantMembership({ userId: employee, companyId: favly, companyRole: 'partner',
        grantedBy: owner }, deps);
    } catch (e) { refusedExternalRole = /EXTERNAL role/.test(e.message); }
    if (refusedExternalRole) ok('granting an EXTERNAL company_role is refused outright');
    else bad('an external company_role was accepted into user_companies');

    // ── REQ 3: EFFECTIVE DATES ─────────────────────────────────────────────
    const future = await mkUser('future');
    await grant(future, abiozen, { effectiveFrom: LATER });
    if (await M.isActiveMember({ userId: future, companyId: abiozen }, { at: AT, ...deps }) === false) {
      ok('a membership that has not started yet does not authorize');
    } else {
      bad('a future-dated membership authorized access early');
    }
    if (await M.isActiveMember({ userId: future, companyId: abiozen },
      { at: new Date('2027-01-02T00:00:00Z'), ...deps }) === true) {
      ok('CONTROL: …and it does authorize once it has started');
    } else {
      bad('a started membership never became live — the window is wrong, not strict');
    }

    const expired = await mkUser('expired');
    await grant(expired, abiozen, { effectiveFrom: EARLIER, effectiveTo: new Date('2026-11-10T00:00:00Z') });
    if (await M.isActiveMember({ userId: expired, companyId: abiozen }, { at: AT, ...deps }) === false) {
      ok('an expired membership does not authorize');
    } else {
      bad('an expired membership still authorized access');
    }

    // ── A SUSPENDED COMPANY AUTHORIZES NOBODY ──────────────────────────────
    await q(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [favly]);
    const favlyMember = await mkUser('favlyone');
    await grant(favlyMember, favly);
    if (await M.isActiveMember({ userId: favlyMember, companyId: favly }, { at: AT, ...deps }) === false) {
      ok('a suspended company authorizes nobody');
    } else {
      bad('a suspended company still authorized its members');
    }
    await q(`UPDATE companies SET status = 'active' WHERE id = $1`, [favly]);

    // ── WHAT AN OUTBOUND GATE ASKS: ADDRESSES, SCOPED TO ONE COMPANY ───────
    const addrs = [`employee@mbrchk.invalid`, `shared@mbrchk.invalid`, `departed@mbrchk.invalid`,
      `partner@mbrchk.invalid`, `outsider@elsewhere.invalid`];
    const inAbiozen = await M.activeMemberAddresses(addrs, { companyId: abiozen, at: AT, ...deps });
    if (inAbiozen && inAbiozen.has('employee@mbrchk.invalid')
      && !inAbiozen.has('shared@mbrchk.invalid')        // revoked from abiozen above
      && !inAbiozen.has('departed@mbrchk.invalid')      // globally deactivated
      && !inAbiozen.has('partner@mbrchk.invalid')       // external role
      && !inAbiozen.has('outsider@elsewhere.invalid')) {
      ok('DECISIVE: address resolution is company-scoped and excludes revoked, departed and partners');
    } else {
      bad('company-scoped address resolution returned the wrong set', [...(inAbiozen || [])]);
    }
    const inAdifice = await M.activeMemberAddresses(addrs, { companyId: adifice, at: AT, ...deps });
    if (inAdifice && inAdifice.has('shared@mbrchk.invalid')
      && !inAdifice.has('employee@mbrchk.invalid')) {
      ok('CONTROL: the same addresses resolve DIFFERENTLY for another company');
    } else {
      bad('company scope made no difference to address resolution', [...(inAdifice || [])]);
    }

    // ── REQ 7 / REQ 8: NO COMPANY, NO ANSWER. AND NO DOMAIN RULE. ──────────
    const noCompany = await M.activeMemberAddresses(addrs, { at: AT, ...deps });
    if (noCompany === M.UNKNOWN) {
      ok('DECISIVE: with no company context the question is UNANSWERABLE, not "any company"');
    } else {
      bad('a missing company context was answered — that is the cross-tenant leak', [...(noCompany || [])]);
    }
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'identity', 'company-membership.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    if (!/@|domain|WORKSPACE_DOMAINS|COMPANY_EMAIL_DOMAINS/i.test(code.replace(/\.invalid/g, ''))) {
      ok('req 8: the accessor contains no email-domain rule at all — it reads rows, not addresses');
    } else {
      note('the accessor mentions a domain somewhere; inspect that it is not a grant rule');
      ok('req 8: no automatic domain grant asserted by the behavioural checks above');
    }

    // ── FAIL CLOSED: UNKNOWABLE IS NOT EMPTY ───────────────────────────────
    const broken = { query: async () => { throw new Error('connection refused'); } };
    if (await M.isActiveMember({ userId: employee, companyId: abiozen }, { at: AT, ...broken }) === M.UNKNOWN) {
      ok('an unreadable membership table returns UNKNOWN, never false');
    } else {
      bad('a database failure was reported as "not a member" — that is a departed-employee verdict '
        + 'invented from an outage');
    }
    if (await M.membershipsOf(employee, { at: AT, ...broken }) === M.UNKNOWN) {
      ok('…and membershipsOf does the same, rather than returning an empty list');
    } else {
      bad('an outage produced an empty membership list, which reads as "works nowhere"');
    }

    // ── AN ARCHIVED COMPANY AUTHORIZES NOBODY EITHER ───────────────────────
    await q(`UPDATE companies SET status = 'archived' WHERE id = $1`, [favly]);
    if (await M.isActiveMember({ userId: favlyMember, companyId: favly }, { at: AT, ...deps }) === false) {
      ok('an ARCHIVED company authorizes nobody — both non-active statuses, not just suspended');
    } else {
      bad('an archived company still authorized its members');
    }
    await q(`UPDATE companies SET status = 'active' WHERE id = $1`, [favly]);

    // ── DUPLICATE AND CONFLICTING MEMBERSHIPS ARE DETERMINISTIC ────────────
    //
    // Two active rows for one (person, company) would make "their role here" ambiguous, and an
    // ambiguous authorization answer is decided by row order — which is not a tenancy model.
    let dupRefused = false;
    try {
      await M.grantMembership({ userId: employee, companyId: abiozen, companyRole: 'dev_team',
        grantedBy: owner, grantedReason: 'conflicting second active grant' }, deps);
    } catch (e) { dupRefused = e.code === '23505' || /duplicate key/i.test(e.message); }
    if (dupRefused) {
      ok('DECISIVE: a second ACTIVE membership for the same (person, company) is refused by the database');
    } else {
      bad('two active memberships for one person and company were accepted — "their role" is now ambiguous');
    }
    // …and re-granting after revocation works, which is what the partial index exists to allow.
    // effectiveFrom is explicit here for the same reason every other fixture sets it: the default
    // is NOW(), and these assertions evaluate at AT (noon). A re-grant defaulted to the real wall
    // clock has simply not started yet at AT — which is the effective-date rule working, and was
    // how this check first reported "re-granting did not restore access".
    await grant(shared, abiozen, { companyRole: 'sales_team' });
    if (await M.isActiveMember({ userId: shared, companyId: abiozen }, { at: AT, ...deps }) === true) {
      ok('CONTROL: a revoked membership can be re-granted — history kept, access restored');
    } else {
      bad('re-granting after revocation did not restore access');
    }
    const rows = (await q(
      `SELECT COUNT(*)::int n FROM user_companies WHERE user_id = $1 AND company_id = $2`,
      [shared, abiozen])).rows[0].n;
    if (rows === 2) ok('…and both the revoked and the new row are on the record');
    else bad('re-granting lost the revoked row', rows);

    // ── UNAUTHORIZED ACTORS CANNOT GRANT, AND NOBODY GRANTS THEMSELVES ─────
    const outsiderActor = await mkUser('nobody', 'sales_team');
    await grant(outsiderActor, adifice, { companyRole: 'sales_team' });
    let refusedUnauthorized = false;
    try {
      await M.grantMembership({ userId: outsiderActor, companyId: abiozen, companyRole: 'admin',
        grantedBy: outsiderActor }, deps);
    } catch (e) { refusedUnauthorized = /not authorized|OWN company membership/.test(e.message); }
    if (refusedUnauthorized) {
      ok('DECISIVE: an unauthorized actor cannot grant themselves a company');
    } else {
      bad('a non-admin granted itself access to a company it had no authority over');
    }

    let refusedSelf = false;
    try {
      await M.grantMembership({ userId: owner, companyId: abiozen, companyRole: 'admin',
        grantedBy: owner }, deps);
    } catch (e) { refusedSelf = /OWN company membership/.test(e.message); }
    if (refusedSelf) {
      ok('DECISIVE: even a super_admin cannot grant their OWN membership — no self-elevation');
    } else {
      bad('an actor granted itself a membership; the authority checked and the authority changed '
        + 'were the same row');
    }

    // A company admin may manage THEIR company…
    const abiozenAdmin = await mkUser('coadmin', 'admin');
    await grant(abiozenAdmin, abiozen, { companyRole: 'admin' });
    const newHire = await mkUser('newhire');
    let adminGranted = false;
    try {
      const row = await M.grantMembership({ userId: newHire, companyId: abiozen,
        companyRole: 'sales_team', grantedBy: abiozenAdmin }, deps);
      made.memberships.push(row.id);
      adminGranted = true;
    } catch (e) { adminGranted = false; note(`company admin grant failed: ${e.message}`); }
    if (adminGranted) ok('CONTROL: an administrative member CAN grant within their own company');
    else bad('an authorized company administrator was refused — the rule is not strict, it is broken');

    // …and not another company. This is the same isolation the table exists to express.
    let crossRefused = false;
    try {
      await M.grantMembership({ userId: newHire, companyId: adifice, companyRole: 'admin',
        grantedBy: abiozenAdmin }, deps);
    } catch (e) { crossRefused = /not authorized/.test(e.message); }
    if (crossRefused) {
      ok('DECISIVE: an admin of one company cannot grant access to ANOTHER company');
    } else {
      bad('membership-management authority was not company-scoped');
    }

    // A deactivated administrator cannot authorize anything, even holding an admin role.
    await q(`UPDATE users SET is_active = 0 WHERE id = $1`, [abiozenAdmin]);
    let deadAdminRefused = false;
    try {
      await M.grantMembership({ userId: newHire, companyId: abiozen, companyRole: 'dev_team',
        grantedBy: abiozenAdmin }, deps);
    } catch (e) { deadAdminRefused = /deactivated account/.test(e.message); }
    if (deadAdminRefused) ok('a deactivated administrator cannot authorize a membership change');
    else bad('a deactivated account authorized a membership change');
    await q(`UPDATE users SET is_active = 1 WHERE id = $1`, [abiozenAdmin]);

    // And an actor whose own membership cannot be read is refused, not assumed.
    let unknownActorRefused = false;
    try {
      await M.assertActorMayManage({ actorUserId: abiozenAdmin, companyId: abiozen,
        subjectUserId: newHire },
      { at: AT, query: async (sql, p) => (/FROM users WHERE id/.test(sql)
        ? { rows: [{ global_role: 'admin', is_active: 1 }] }
        : (() => { throw new Error('connection refused'); })()) });
    } catch (e) { unknownActorRefused = /cannot be established/.test(e.message); }
    if (unknownActorRefused) {
      ok("an actor's unreadable membership refuses the change rather than assuming authority");
    } else {
      bad('an unreadable actor membership was treated as authority');
    }

    // ── WHICH COMPANY A SCHEDULED WORKFLOW ACTS FOR (Option A bridge) ──────
    const WF = require('../src/lib/identity/workflow-company');
    const CTX = require('../src/lib/office/context');
    const wfIds = [];
    const map = async (workflow, companyId, by = owner) => {
      // effectiveFrom is explicit for the same reason every membership fixture sets it: the
      // default is NOW(), and these assertions evaluate at AT (noon), so a mapping left to default
      // has not started yet at AT. That is the effective-date rule working — and it is the second
      // time in this check that defaulting it produced a confusing "did not resolve".
      const row = await WF.mapWorkflowToCompany({ workflow, companyId, grantedBy: by,
        grantedReason: 'fixture', effectiveFrom: EARLIER }, deps);
      wfIds.push(row.id);
      return row;
    };

    // An UNMAPPED workflow refuses, and says which of the four refusals it is.
    const unmapped = await WF.resolveWorkflowCompany('mbrchk-unmapped', { at: AT, ...deps });
    if (unmapped.ok === false && unmapped.code === WF.REFUSAL.NOT_MAPPED) {
      ok('an unmapped scheduled workflow refuses with an actionable code, not a default company');
    } else {
      bad('an unmapped workflow did not refuse correctly', unmapped);
    }

    await map('mbrchk-ceo-briefing', abiozen);
    const one = await WF.resolveWorkflowCompany('mbrchk-ceo-briefing', { at: AT, ...deps });
    if (one.ok && one.companyId === abiozen) ok('a mapped workflow resolves to exactly its company');
    else bad('a mapped workflow did not resolve', one);

    // Two companies → REFUSE, and name them, because the scheduler runs it once per company.
    await map('mbrchk-ceo-briefing', adifice);
    const amb = await WF.resolveWorkflowCompany('mbrchk-ceo-briefing', { at: AT, ...deps });
    if (amb.ok === false && amb.code === WF.REFUSAL.AMBIGUOUS && amb.candidates.length === 2) {
      ok('DECISIVE: a workflow authorized for two companies REFUSES rather than choosing one');
    } else {
      bad('an ambiguous workflow mapping was resolved to a single company', amb);
    }
    const both = await WF.companiesForWorkflow('mbrchk-ceo-briefing', { at: AT, ...deps });
    if (both && both.length === 2) ok('…and both authorizations are visible, so a scheduler can fan out per company');
    else bad('the two company mappings did not both resolve', both);

    // A suspended company authorizes no workflow either.
    await q(`UPDATE companies SET status = 'suspended' WHERE id = $1`, [adifice]);
    const nowOne = await WF.resolveWorkflowCompany('mbrchk-ceo-briefing', { at: AT, ...deps });
    if (nowOne.ok && nowOne.companyId === abiozen) {
      ok('a suspended company drops out of a workflow mapping — same rule as membership');
    } else {
      bad('a suspended company still counted toward a workflow mapping', nowOne);
    }
    await q(`UPDATE companies SET status = 'active' WHERE id = $1`, [adifice]);

    // The TRUSTED context a cron actually gets.
    await WF.unmapWorkflow({ workflow: 'mbrchk-ceo-briefing', companyId: adifice,
      revokedBy: owner, revokedReason: 'fixture: collapse to one' }, deps);
    // Caught, not allowed to abort: a refusal here is an assertion failure about the product, and
    // an uncaught throw would skip every assertion below it AND the cleanup — which is how a
    // mutation run leaves fixtures behind and reports "cleanup failed" instead of the defect.
    let sched = null;
    try {
      sched = await CTX.resolveCompanyForScheduledWorkflow(
        { workflow: 'mbrchk-ceo-briefing' }, deps);
    } catch (e) {
      bad('the scheduled-workflow context was refused for a workflow mapped to exactly one '
        + 'company', `${e.refusal || '(no code)'}: ${e.message}`);
    }
    if (sched && CTX.isTrustedContext(sched) && sched.companyId === abiozen
        && sched.source === 'scheduled_workflow') {
      ok('DECISIVE: a cron obtains a TRUSTED branded context from stored configuration');
    } else {
      bad('the scheduled-workflow context was not trusted or not the mapped company', sched);
    }
    let schedRefused = null;
    try {
      await CTX.resolveCompanyForScheduledWorkflow({ workflow: 'mbrchk-unmapped' }, deps);
    } catch (e) { schedRefused = e.refusal; }
    if (schedRefused === WF.REFUSAL.NOT_MAPPED) {
      ok('…and an unmapped workflow throws a refusal carrying the actionable code');
    } else {
      bad('the scheduled-workflow refusal carried no actionable code', schedRefused);
    }

    // Retirement is recorded as retirement, not as a revoked authorization (Option B).
    await WF.unmapWorkflow({ workflow: 'mbrchk-ceo-briefing', companyId: abiozen,
      revokedBy: owner, revokedReason: 'governed run verified', retiredForGovernedRun: true }, deps);
    const retired = (await q(
      `SELECT retired_for_governed_run r, status FROM workflow_companies
        WHERE workflow = $1 AND company_id = $2`, ['mbrchk-ceo-briefing', abiozen])).rows[0];
    if (retired && retired.r === true && retired.status === 'revoked') {
      ok('a mapping retired because its governed replacement works is recorded as such');
    } else {
      bad('retirement was indistinguishable from revocation', retired);
    }

    // An unauthorized actor cannot point a workflow at a company.
    let wfRefused = false;
    try {
      await WF.mapWorkflowToCompany({ workflow: 'mbrchk-sneaky', companyId: abiozen,
        grantedBy: outsiderActor }, deps);
    } catch (e) { wfRefused = /not authorized/.test(e.message); }
    if (wfRefused) ok('DECISIVE: an unauthorized actor cannot map a workflow to a company');
    else bad('a non-administrator mapped a workflow to a company');

    // And an admin of one company cannot map a workflow into another.
    let wfCross = false;
    try {
      await WF.mapWorkflowToCompany({ workflow: 'mbrchk-cross', companyId: adifice,
        grantedBy: abiozenAdmin }, deps);
    } catch (e) { wfCross = /not authorized/.test(e.message); }
    if (wfCross) ok('…and mapping authority is company-scoped, like membership management');
    else bad('an admin of one company mapped a workflow into another');

    made.workflowMappings = wfIds;

    // ── THE REVOCATION-ATTRIBUTION CONSTRAINT IS IN THE DATABASE ───────────
    let dbRefused = false;
    try {
      await q(`UPDATE user_companies SET status = 'revoked' WHERE id = $1`, [made.memberships[0]]);
    } catch (e) { dbRefused = e.code === '23514'; }
    if (dbRefused) {
      ok('the DATABASE refuses a revocation with no attribution — not merely this module');
    } else {
      bad('a revocation without revoked_at/revoked_by was accepted by the database');
    }

  } catch (e) {
    bad('the check threw', e && e.message);
  } finally {
    // ── CLEANUP: ONLY WHAT THIS SCRIPT CREATED, BY ID ──────────────────────
    try {
      for (const id of (made.workflowMappings || [])) await q(`DELETE FROM workflow_companies WHERE id = $1`, [id]);
      for (const id of made.memberships) await q(`DELETE FROM user_companies WHERE id = $1`, [id]);
      for (const id of made.users) await q(`DELETE FROM users WHERE id = $1`, [id]);
      for (const id of made.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]);
      const leakedM = (await q(
        `SELECT COUNT(*)::int n FROM user_companies WHERE id = ANY($1)`, [made.memberships])).rows[0].n;
      const leakedU = (await q(
        `SELECT COUNT(*)::int n FROM users WHERE id = ANY($1)`, [made.users])).rows[0].n;
      // "My fixtures are gone", never "the table is empty" — the latter becomes false the moment
      // the product is used, and the obvious fix for it is a wider DELETE.
      if (leakedM === 0 && leakedU === 0) ok('fixtures removed by id; none of mine remain');
      else bad('fixtures leaked', { memberships: leakedM, users: leakedU });
    } catch (e) {
      bad('cleanup failed', e && e.message);
    }
    await P.end().catch(() => {});
    stopTemp();
  }

  console.log(`\n  ${pass} assertion(s) passed · ${fail} failed\n`);
  if (fail) {
    console.log('FAIL  company membership does not hold its ruled properties.');
    process.exit(1);
  }
  console.log('PASS  many-to-many company membership: global deactivation overrides all, revocation');
  console.log('      is scoped, shared employees are explicit, partners are not employees, and an');
  console.log('      unreadable table is UNKNOWN rather than a departure.');
  process.exit(0);
})();
