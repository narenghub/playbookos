#!/usr/bin/env node
// ── B7.11: A SHARED MAILBOX IS SCOPED, AND CANNOT READMIT A DEPARTED PERSON ─
//
//   node scripts/check-shared-mailboxes-db.js   exit 0 = every ruled property holds
//                                               exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner instruction (correction 5, B6.9, and again in Decision 5): *"Scope shared mailboxes to
// company + purpose. INTERNAL_MAILBOXES must not override a deactivated human account."*
//
// The second half is the one with teeth. `classifyByMembership` checked
// `members.has(lower) || mailboxes.has(lower)`, so putting a departed employee's address in the env
// var made them INTERNAL again — no approval needed — which is reinstating by configuration the
// exact person the active-membership rule exists to exclude. It is B7.4's defect (an approval
// reinstating a deactivated employee) one layer down, in a place nobody reviews.
//
// Every assertion below is paired with a positive control, because a mailbox rule that refused
// everything would satisfy each negative case on its own.
//
// NO URL OVERRIDE: its own disposable cluster; fixtures by id.

'use strict';

const crypto = require('node:crypto');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail++;
  console.log(`  FAIL  ${m}`);
  if (extra !== undefined) console.log(`          ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
};
const note = (m) => console.log(`  --    ${m}`);

const DISPOSABLE = require('./lib/pg-disposable');
let cluster = null;
try {
  cluster = DISPOSABLE.create({ label: 'smbox' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  shared mailboxes not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'smbox-bootstrap@smbox.invalid';
process.env.ADMIN_PASSWORD = `smbox-${crypto.randomBytes(16).toString('hex')}`;

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
  const ids = { companies: [], users: [], mailboxes: [] };
  const uid = (p) => `smbox-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/outbound/shared-mailboxes').migrateSharedMailboxes(q);
    console.log('  ..    schema up\n');

    const SHARED = require('../src/lib/outbound/shared-mailboxes');
    const MEMBERSHIP = require('../src/lib/outbound/membership');

    const A = uid('co-a');
    const B = uid('co-b');
    for (const c of [A, B]) {
      await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [c]);
      ids.companies.push(c);
    }

    const declare = async ({ address, companyId = null, scope = 'company', purpose,
      status = 'active', from = null, to = null }) => {
      const id = uid('mb');
      // `from` is parameterised because the EXPIRED fixture needs a window that both runs forwards
      // and lies in the past. Leaving `from` at NOW() - 1 minute and setting `to` to NOW() - 1
      // minute tripped shared_mailboxes_window (effective_to > effective_from) — the constraint
      // doing its job on the fixture rather than on the thing under test.
      await q(`INSERT INTO shared_mailboxes
                 (id, address, company_id, company_scope, purpose, status, authorized_by, reason,
                  effective_from, effective_to)
               VALUES ($1,$2,$3,$4,$5,$6,'naren','b7.11 check fixture',
                       COALESCE($8::timestamptz, NOW() - INTERVAL '1 minute'), $7)`,
        [id, address.toLowerCase(), companyId, scope, purpose, status, to, from]);
      ids.mailboxes.push(id);
      return id;
    };
    const mkUser = async (email, active) => {
      const id = uid('u');
      await q(`INSERT INTO users (id, email, name, role, password_hash, is_active)
               VALUES ($1,$2,'Fixture','admin','x',$3)`, [id, email, active ? 1 : 0]);
      ids.users.push(id);
      return id;
    };

    const ENV = { COMPANY_EMAIL_DOMAINS: 'fixture.invalid', INTERNAL_MAILBOXES: '' };

    // ══ 1. THE OVERRIDE: A DEACTIVATED ACCOUNT CANNOT BE READMITTED ═══════
    console.log('── 1. a departed person cannot be readmitted by configuration ──\n');

    const DEPARTED = 'departed@fixture.invalid';
    await mkUser(DEPARTED, false);

    // Declared as a shared mailbox for this company AND this purpose — every other condition met.
    await declare({ address: DEPARTED, companyId: A, purpose: 'briefing' });
    const dec = await SHARED.usableMailboxes([DEPARTED],
      { companyId: A, purpose: 'briefing', env: ENV }, deps);
    if (!dec.usable.has(DEPARTED) && /DEACTIVATED/.test(dec.verdicts.get(DEPARTED).reason)) {
      ok('a DECLARED shared mailbox whose address belongs to a DEACTIVATED account is refused, '
        + 'with every other condition satisfied');
      note('this is the override: it is applied last and nothing before it can satisfy the rule');
    } else bad('a declaration readmitted a deactivated account', JSON.stringify([...dec.verdicts]));

    // The env var, the exact hole the owner named.
    const envDeparted = { ...ENV, INTERNAL_MAILBOXES: DEPARTED };
    const viaEnv = await SHARED.usableMailboxes([DEPARTED], { env: envDeparted }, deps);
    if (!viaEnv.usable.has(DEPARTED)) {
      ok('and INTERNAL_MAILBOXES cannot readmit them either — the owner\'s instruction, measured '
        + 'on the env var itself');
    } else bad('INTERNAL_MAILBOXES overrode a deactivated account', JSON.stringify([...viaEnv.verdicts]));

    // THROUGH THE GATE'S OWN CLASSIFIER, which is what actually decides a send.
    const classified = await MEMBERSHIP.classifyByMembership([DEPARTED], envDeparted, deps);
    if (classified.external.includes(DEPARTED) && !classified.internal.includes(DEPARTED)) {
      ok('and classifyByMembership puts them in EXTERNAL, so a send to them needs a released '
        + 'approval');
      note(`its verdict: ${classified.sharedMailboxVerdicts[DEPARTED].reason.slice(0, 90)}…`);
    } else bad('the classifier treated a departed person as internal', JSON.stringify(classified));
    if (classified.departedOrUnknown.includes(DEPARTED)) {
      ok('and names them as departed-or-unknown rather than as an ordinary outsider');
    } else bad('the departed class was not named', JSON.stringify(classified.departedOrUnknown));

    // POSITIVE CONTROL: the same address, same declaration, with an ACTIVE account.
    const ACTIVE_ROLE = 'sales@fixture.invalid';
    await declare({ address: ACTIVE_ROLE, companyId: A, purpose: 'briefing' });
    const okRole = await SHARED.usableMailboxes([ACTIVE_ROLE],
      { companyId: A, purpose: 'briefing', env: ENV }, deps);
    if (okRole.usable.has(ACTIVE_ROLE)) {
      ok('POSITIVE CONTROL: a declared mailbox with no user account at all IS usable — the rule '
        + 'refuses departed people, not mailboxes');
    } else bad('a legitimate shared mailbox was refused', JSON.stringify([...okRole.verdicts]));

    // ══ 2. COMPANY SCOPE ═════════════════════════════════════════════════
    console.log('\n── 2. scoped to a company ──\n');

    const forB = await SHARED.usableMailboxes([ACTIVE_ROLE],
      { companyId: B, purpose: 'briefing', env: ENV }, deps);
    if (!forB.usable.has(ACTIVE_ROLE) && /not for company/.test(forB.verdicts.get(ACTIVE_ROLE).reason)) {
      ok('a mailbox declared for company A is NOT usable for company B\'s mail');
      note('one env var could not express this: `sales@` was internal for every company sharing '
        + 'the platform');
    } else bad('a company-scoped mailbox leaked to another company', JSON.stringify([...forB.verdicts]));

    const PLATFORM_BOX = 'alerts@fixture.invalid';
    await declare({ address: PLATFORM_BOX, scope: 'platform', companyId: null, purpose: 'any' });
    const platA = await SHARED.usableMailboxes([PLATFORM_BOX], { companyId: A, env: ENV }, deps);
    const platB = await SHARED.usableMailboxes([PLATFORM_BOX], { companyId: B, env: ENV }, deps);
    if (platA.usable.has(PLATFORM_BOX) && platB.usable.has(PLATFORM_BOX)) {
      ok('a PLATFORM-scope mailbox is usable for both — declared explicitly as platform, not '
        + 'inferred from a missing company');
    } else bad('the platform scope does not work', JSON.stringify([[...platA.usable], [...platB.usable]]));

    let scopeDisagrees = null;
    try {
      await q(`INSERT INTO shared_mailboxes
                 (id, address, company_id, company_scope, purpose, authorized_by, reason)
               VALUES ($1,'x@fixture.invalid',NULL,'company','any','naren','a company row with no company')`,
        [uid('mb')]);
    } catch (e) { scopeDisagrees = e.code; }
    if (scopeDisagrees === '23514') {
      ok('the DATABASE refuses a company-scoped row with no company — which would have been '
        + 'internal for everybody, the very hole this table closes');
    } else bad('a scopeless company row was accepted', scopeDisagrees);

    let platformWithCompany = null;
    try {
      await q(`INSERT INTO shared_mailboxes
                 (id, address, company_id, company_scope, purpose, authorized_by, reason)
               VALUES ($1,'y@fixture.invalid',$2,'platform','any','naren','a platform row naming a company')`,
        [uid('mb'), A]);
    } catch (e) { platformWithCompany = e.code; }
    if (platformWithCompany === '23514') {
      ok('and refuses a platform-scoped row that names a company — the two cannot both be true');
    } else bad('a contradictory scope was accepted', platformWithCompany);

    // ══ 3. PURPOSE ═══════════════════════════════════════════════════════
    console.log('\n── 3. scoped to a purpose ──\n');

    const RFQ_BOX = 'rfq@fixture.invalid';
    await declare({ address: RFQ_BOX, companyId: A, purpose: 'rfq' });
    const rightPurpose = await SHARED.usableMailboxes([RFQ_BOX],
      { companyId: A, purpose: 'rfq', env: ENV }, deps);
    const wrongPurpose = await SHARED.usableMailboxes([RFQ_BOX],
      { companyId: A, purpose: 'payroll', env: ENV }, deps);
    if (rightPurpose.usable.has(RFQ_BOX) && !wrongPurpose.usable.has(RFQ_BOX)) {
      ok('a mailbox declared for `rfq` is usable for rfq mail and NOT for payroll mail');
    } else bad('the purpose scope does not discriminate',
      JSON.stringify({ right: [...rightPurpose.usable], wrong: [...wrongPurpose.usable] }));

    const noPurpose = await SHARED.usableMailboxes([RFQ_BOX], { companyId: A, env: ENV }, deps);
    if (!noPurpose.usable.has(RFQ_BOX)) {
      ok('and a send that declares NO purpose does not get it — an absent purpose is not a '
        + 'wildcard');
      note('`any` is a declared value, written by whoever authorized the row');
    } else bad('a missing purpose acted as a wildcard', JSON.stringify([...noPurpose.verdicts]));

    // ══ 4. STATUS AND WINDOW ═════════════════════════════════════════════
    console.log('\n── 4. suspended, revoked, expired ──\n');

    for (const [label, status] of [['suspended', 'suspended'], ['revoked', 'revoked']]) {
      const addr = `${label}@fixture.invalid`;
      await declare({ address: addr, companyId: A, purpose: 'any', status });
      const r = await SHARED.usableMailboxes([addr], { companyId: A, purpose: 'any', env: ENV }, deps);
      if (!r.usable.has(addr)) ok(`a ${label} declaration is not usable`);
      else bad(`a ${label} declaration was used`, JSON.stringify([...r.verdicts]));
    }

    const EXPIRED = 'expired@fixture.invalid';
    await declare({ address: EXPIRED, companyId: A, purpose: 'any',
      from: new Date(Date.now() - 7_200_000).toISOString(),
      to: new Date(Date.now() - 3_600_000).toISOString() });
    const expired = await SHARED.usableMailboxes([EXPIRED],
      { companyId: A, purpose: 'any', env: ENV }, deps);
    if (!expired.usable.has(EXPIRED)) ok('a declaration outside its effective window is not usable');
    else bad('an expired declaration was used', JSON.stringify([...expired.verdicts]));

    // ══ 5. FAIL CLOSED ═══════════════════════════════════════════════════
    console.log('\n── 5. an unreadable source is not an empty one ──\n');

    const blindUsers = { query: async (t, p) => {
      if (/FROM users/i.test(t)) throw new Error('users unreadable (fixture)');
      return q(t, p);
    } };
    const unknownUsers = await SHARED.usableMailboxes([ACTIVE_ROLE],
      { companyId: A, purpose: 'briefing', env: ENV }, blindUsers);
    if (unknownUsers.unknown === true && unknownUsers.usable.size === 0) {
      ok('if the user table cannot be read, NOTHING is a shared mailbox — whether an address '
        + 'belongs to a departed person is unknowable, and unknowable is not permission');
    } else bad('an unreadable user table was treated as "nobody is deactivated"',
      JSON.stringify([...unknownUsers.usable]));

    const blindBoxes = { query: async (t, p) => {
      if (/shared_mailboxes/i.test(t)) throw new Error('declarations unreadable (fixture)');
      return q(t, p);
    } };
    const unknownBoxes = await SHARED.usableMailboxes([ACTIVE_ROLE],
      { companyId: A, purpose: 'briefing', env: ENV }, blindBoxes);
    if (!unknownBoxes.usable.has(ACTIVE_ROLE)
        && /could not be read/.test(unknownBoxes.verdicts.get(ACTIVE_ROLE).reason)) {
      ok('and an unreadable declaration table refuses too, saying so rather than reporting no '
        + 'declaration');
    } else bad('an unreadable declaration table read as "no declaration"',
      JSON.stringify([...unknownBoxes.verdicts]));

    // ══ 6. THE LEGACY ENV VAR, NARROWED NOT DELETED ══════════════════════
    console.log('\n── 6. INTERNAL_MAILBOXES: kept, narrowed, and reported ──\n');

    const LEGACY = 'legacy@fixture.invalid';
    const envLegacy = { ...ENV, INTERNAL_MAILBOXES: `${LEGACY}, ${ACTIVE_ROLE}` };
    const noCompany = await SHARED.usableMailboxes([LEGACY], { env: envLegacy }, deps);
    if (noCompany.usable.has(LEGACY)) {
      ok('an env entry still works for a send with NO company context — nothing in production '
        + 'breaks silently');
    } else bad('the legacy source stopped working entirely', JSON.stringify([...noCompany.verdicts]));

    const withCompany = await SHARED.usableMailboxes([LEGACY],
      { companyId: A, purpose: 'briefing', env: envLegacy }, deps);
    if (!withCompany.usable.has(LEGACY)
        && /PLATFORM-scope/.test(withCompany.verdicts.get(LEGACY).reason)) {
      ok('and a COMPANY-scoped send needs a declared row — one env var cannot say which company a '
        + 'mailbox belongs to, and the refusal says that');
    } else bad('the env var satisfied a company-scoped send', JSON.stringify([...withCompany.verdicts]));

    const migration = await SHARED.envEntriesNeedingDeclaration({ env: envLegacy }, deps);
    if (migration.undeclared.includes(LEGACY) && !migration.undeclared.includes(ACTIVE_ROLE)) {
      ok('and the migration aid lists exactly the env entries with no declaration yet');
      note(`entries: ${migration.entries.length} · still undeclared: ${migration.undeclared.join(', ')}`);
    } else bad('the migration aid is wrong', JSON.stringify(migration));

    console.log('');
  } catch (e) {
    bad('the check itself threw', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    try {
      for (const id of ids.mailboxes) await q(`DELETE FROM shared_mailboxes WHERE id = $1`, [id]).catch(() => {});
      await q(`DELETE FROM shared_mailboxes WHERE reason = 'b7.11 check fixture'`).catch(() => {});
      for (const id of ids.users) await q(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]).catch(() => {});
      const left = (await q(`SELECT COUNT(*)::int n FROM shared_mailboxes WHERE id = ANY($1)`,
        [ids.mailboxes])).rows[0].n;
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
    console.log('\nFAIL  shared mailboxes are not yet scoped.');
    process.exit(1);
  }
  console.log('\nPASS  B7.11: a shared mailbox is a reviewed declaration naming a company, a '
    + 'purpose and who authorized it; it is refused outside that company, that purpose, its status '
    + 'and its window; an unreadable source refuses rather than reading as absent; the legacy env '
    + 'var still works for platform-scope sends and is reported for migration; and NOTHING — '
    + 'declaration or env var — can readmit a deactivated human account.');
  process.exit(0);
})();
