#!/usr/bin/env node
// ── B7.9: A SENDER IS AN AUTHORIZED IDENTITY, NOT A FAMILIAR DOMAIN ─────────
//
//   node scripts/check-sender-identity-db.js   exit 0 = every ruled property holds
//                                              exit 3 = NOT EXECUTED (no Postgres available)
//
// Owner instruction: *"B7.9 sender and provider-account authorization. B7.6b binds
// from/reply-to/provider account; this is whether they are AUTHORIZED for the company. A
// comment-stripped source scan is not proof."*
//
// The decisive assertion is 2.1. mailer.js:116 says, and has always said, that any address on a
// verified domain works "because the domain (not the individual address) is what Resend
// authorizes". That is a deliverability fact standing in for a company authorization, and it let
// any caller send as the CEO or as a departed director.
//
// Every negative case is paired with a positive control, because a sender rule that refused
// everything would satisfy each negative on its own and authorize nothing — which would stop the
// platform's mail rather than govern it.
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
  cluster = DISPOSABLE.create({ label: 'sndid' });
} catch (e) {
  if (e && e.infrastructure) {
    console.log(`  skip  ${e.message}`);
    console.log('SKIP  sender identity not exercised — infrastructure unavailable');
    process.exit(EXIT_NOT_EXECUTED);
  }
  throw e;
}
process.env.DATABASE_URL = cluster.url;
process.env.ADMIN_EMAIL = 'sndid-bootstrap@sndid.invalid';
process.env.ADMIN_PASSWORD = `sndid-${crypto.randomBytes(16).toString('hex')}`;

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
  const ids = { companies: [], users: [], identities: [] };
  const uid = (p) => `sndid-${p}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    await require('../src/lib/db').initDB();
    await require('../src/lib/runs').migrateRuns(q);
    await require('../src/lib/office/schema').migrateOffice(q);
    await require('../src/lib/outbound/shared-mailboxes').migrateSharedMailboxes(q);
    await require('../src/lib/outbound/sender-identity').migrateSenderIdentities(q);
    console.log('  ..    schema up\n');

    const SID = require('../src/lib/outbound/sender-identity');

    const A = uid('co-a');
    const B = uid('co-b');
    for (const c of [A, B]) {
      await q(`INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$1,'active')`, [c]);
      ids.companies.push(c);
    }

    const declare = async ({ address, companyId = null, scope = 'company',
      providerAccount = 'resend:default', purpose = 'any', status = 'active',
      maySend = true, mayReply = true, from = null, to = null }) => {
      const id = uid('si');
      // `from` is parameterised for the same reason the B7.11 check parameterises it: an EXPIRED
      // fixture needs a window that runs forwards AND lies in the past, and leaving `from` at
      // NOW() - 1 minute with `to` also in the past trips sender_identities_window — the
      // constraint doing its job on the fixture rather than on the thing under test.
      await q(`INSERT INTO sender_identities
                 (id, address, company_id, company_scope, provider_account, purpose, status,
                  may_send, may_receive_replies, authorized_by, reason, effective_from, effective_to)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'naren','b7.9 check fixture',
                       COALESCE($11::timestamptz, NOW() - INTERVAL '1 minute'), $10)`,
        [id, address.toLowerCase(), companyId, scope, providerAccount, purpose, status,
          maySend, mayReply, to, from]);
      ids.identities.push(id);
      return id;
    };
    const mkUser = async (email, active) => {
      const id = uid('u');
      await q(`INSERT INTO users (id, email, name, role, password_hash, is_active)
               VALUES ($1,$2,'Fixture','admin','x',$3)`, [id, email, active ? 1 : 0]);
      ids.users.push(id);
      return id;
    };

    const ENV = { MAIL_FROM: '', RESEND_FROM: '' };
    const RESEND = 'resend:default';

    // ══ 1. THE POSITIVE CONTROL COMES FIRST ══════════════════════════════
    //
    // If this fails, every refusal below is meaningless: a rule that authorizes nothing satisfies
    // all of them and stops the platform's mail.
    console.log('── 1. a declared identity CAN send (the control) ──\n');

    const DECLARED = 'declared@fixture.invalid';
    await declare({ address: DECLARED, companyId: A });
    {
      const v = await SID.authorizedSender(
        { from: DECLARED, companyId: A, providerAccount: RESEND }, { ...deps, env: ENV });
      if (v.ok && v.sender === DECLARED) ok(`a declared identity is authorized (via ${v.via})`);
      else bad('a declared identity was refused — every negative case below is vacuous', v);
    }
    {
      const v = await SID.authorizedSender(
        { from: `"Declared Name" <${DECLARED.toUpperCase()}>`, companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV });
      if (v.ok) ok('a display name and mixed case resolve to the same authorized address');
      else bad('a display-name form of a declared identity was refused', v);
    }

    // ══ 2. THE DEFECT ════════════════════════════════════════════════════
    console.log('\n── 2. a company domain is not an authorization ──\n');

    {
      // DECISIVE. Same domain as the declared identity above, no declaration of its own.
      const v = await SID.authorizedSender(
        { from: 'naren@fixture.invalid', companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV });
      if (!v.ok && v.code === 'sender_not_authorized') {
        ok('DECISIVE: an undeclared address on an authorized domain cannot be sent as');
      } else {
        bad('an undeclared address on a company domain was authorized — this is the B7.9 defect', v);
      }
    }
    {
      const v = await SID.authorizedSender(
        { from: 'invented-never-existed@fixture.invalid', companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV });
      if (!v.ok) ok('an address that has never existed cannot be sent as');
      else bad('an invented address on the domain was authorized', v);
    }

    console.log('\n── 3. a departed person cannot be sent AS ──\n');

    const DEPARTED = 'departed@fixture.invalid';
    await mkUser(DEPARTED, false);
    await declare({ address: DEPARTED, companyId: A });   // declared, and still refused
    {
      const v = await SID.authorizedSender(
        { from: DEPARTED, companyId: A, providerAccount: RESEND }, { ...deps, env: ENV });
      if (!v.ok && v.code === 'deactivated_sender') {
        ok('a DECLARED identity belonging to a deactivated account is still refused');
      } else {
        bad('the platform may send as a person who has left', v);
      }
    }
    {
      // The positive control for the override: an ACTIVE user, same shape of declaration.
      const ACTIVE = 'active-person@fixture.invalid';
      await mkUser(ACTIVE, true);
      await declare({ address: ACTIVE, companyId: A });
      const v = await SID.authorizedSender(
        { from: ACTIVE, companyId: A, providerAccount: RESEND }, { ...deps, env: ENV });
      if (v.ok) ok('an ACTIVE user with the same declaration can send (the override is not a blanket no)');
      else bad('an active declared user was refused, so the deactivation check is refusing everyone', v);
    }
    {
      const v = await SID.authorizedSender(
        { from: DECLARED, replyTo: DEPARTED, companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV });
      if (!v.ok && v.code === 'deactivated_reply_to') {
        ok('answers cannot be routed to a deactivated account');
      } else {
        bad('a reply-to on a departed person\'s mailbox was authorized', v);
      }
    }

    // ══ 4. COMPANY SCOPE ═════════════════════════════════════════════════
    console.log('\n── 4. three companies share this platform ──\n');

    {
      const v = await SID.authorizedSender(
        { from: DECLARED, companyId: B, providerAccount: RESEND }, { ...deps, env: ENV });
      if (!v.ok && v.code === 'sender_not_authorized_for_company') {
        ok('an identity declared for company A is not one company B may send as');
      } else {
        bad('a cross-company sender was authorized', v);
      }
    }
    {
      const PLATFORM = 'platform-noreply@fixture.invalid';
      await declare({ address: PLATFORM, companyId: null, scope: 'platform' });
      const a = await SID.authorizedSender(
        { from: PLATFORM, companyId: A, providerAccount: RESEND }, { ...deps, env: ENV });
      const b = await SID.authorizedSender(
        { from: PLATFORM, companyId: B, providerAccount: RESEND }, { ...deps, env: ENV });
      if (a.ok && b.ok) ok('an explicitly PLATFORM-scope identity serves every company');
      else bad('a platform-scope identity was refused for a company send', { a, b });
    }
    {
      const v = await SID.authorizedSender(
        { from: DECLARED, companyId: null, providerAccount: RESEND }, { ...deps, env: ENV });
      if (!v.ok) {
        ok('a company-scoped identity is NOT usable by a send with no company context');
      } else {
        bad('a company-scoped identity was used for a send that names no company', v);
      }
    }

    // ══ 5. THE PROVIDER ACCOUNT ══════════════════════════════════════════
    console.log('\n── 5. the same address through a different credential is a different sender ──\n');

    const WARMED = 'sales@fixture.invalid';
    await declare({ address: WARMED, companyId: A, providerAccount: 'gmail:sales-mailbox' });
    {
      const v = await SID.authorizedSender(
        { from: WARMED, companyId: A, providerAccount: 'gmail:sales-mailbox' },
        { ...deps, env: ENV });
      if (v.ok) ok('the declared provider account is authorized (the control)');
      else bad('the declared provider account was refused', v);
    }
    {
      const v = await SID.authorizedSender(
        { from: WARMED, companyId: A, providerAccount: RESEND }, { ...deps, env: ENV });
      if (!v.ok && v.code === 'provider_account_mismatch') {
        ok('the SAME address through a different provider account is refused');
      } else {
        bad('a declaration for one credential authorized another', v);
      }
    }
    {
      const v = await SID.authorizedSender(
        { from: WARMED, companyId: A, providerAccount: null }, { ...deps, env: ENV });
      if (!v.ok && v.code === 'provider_account_unestablished') {
        ok('a send that does not name its provider account is refused, not defaulted');
      } else {
        bad('a send with no named provider account was authorized', v);
      }
    }

    // ══ 6. SENDING AND RECEIVING REPLIES ARE SEPARATE POWERS ═════════════
    console.log('\n── 6. a reply-to is not a sender, and a sender is not a reply-to ──\n');

    const INBOX = 'shared-inbox@fixture.invalid';
    await declare({ address: INBOX, companyId: A, maySend: false, mayReply: true,
      providerAccount: 'none:inbox-only' });
    {
      const v = await SID.authorizedSender(
        { from: INBOX, companyId: A, providerAccount: 'none:inbox-only' }, { ...deps, env: ENV });
      if (!v.ok) ok('an inbox declared may_send = false cannot be sent as');
      else bad('a receive-only inbox was authorized as a sender', v);
    }
    {
      // And the distinction that matters: a reply-to is checked WITHOUT the provider account,
      // because nothing sends from it. This declaration names a provider that is not the one
      // carrying the message, and it is still a valid destination for answers.
      const v = await SID.authorizedSender(
        { from: DECLARED, replyTo: INBOX, companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV });
      if (v.ok && v.replyTo === INBOX) {
        ok('a reply-to is authorized without a provider match — nothing sends from it');
      } else {
        bad('a legitimate shared inbox was refused as a reply-to over a provider mismatch', v);
      }
    }
    {
      const NOREPLY = 'send-only@fixture.invalid';
      await declare({ address: NOREPLY, companyId: A, maySend: true, mayReply: false });
      const v = await SID.authorizedSender(
        { from: DECLARED, replyTo: NOREPLY, companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV });
      if (!v.ok && v.code === 'reply_to_not_authorized') {
        ok('an identity declared may_receive_replies = false cannot be a reply-to');
      } else {
        bad('answers were routed to an address not declared to receive them', v);
      }
    }
    {
      const v = await SID.authorizedSender(
        { from: DECLARED, replyTo: 'anyone@fixture.invalid', companyId: A,
          providerAccount: RESEND }, { ...deps, env: ENV });
      if (!v.ok && v.code === 'reply_to_not_authorized') {
        ok('an undeclared address on the company domain cannot receive the answers either');
      } else {
        bad('a reply-to was authorized by its domain, which is the same defect one field over', v);
      }
    }

    // ══ 7. THE LIFECYCLE OF A DECLARATION ════════════════════════════════
    console.log('\n── 7. revoked, suspended, expired and not-yet-effective ──\n');

    for (const [label, spec, code] of [
      ['revoked', { status: 'revoked' }, null],
      ['suspended', { status: 'suspended' }, null],
      ['expired', { from: new Date(Date.now() - 86400e3).toISOString(),
        to: new Date(Date.now() - 3600e3).toISOString() }, null],
      ['not yet effective', { from: new Date(Date.now() + 3600e3).toISOString() }, null],
    ]) {
      const addr = `${label.replace(/\s+/g, '-')}@fixture.invalid`;
      await declare({ address: addr, companyId: A, ...spec });
      const v = await SID.authorizedSender(
        { from: addr, companyId: A, providerAccount: RESEND }, { ...deps, env: ENV });
      if (!v.ok) ok(`a ${label} declaration does not authorize a send`);
      else bad(`a ${label} declaration authorized a send`, v);
      if (code) note(code);
    }
    {
      // B7.8d. `effective_from` is written by Postgres NOW() in MICROseconds; a JS
      // `new Date()` comparison in milliseconds made a membership invisible to its own creator in
      // 142 of 200 trials. The same mistake here would make an identity authorized a moment ago
      // read as unauthorized, so the window is compared in SQL and this asserts it.
      const FRESH = 'fresh-right-now@fixture.invalid';
      const id = uid('si');
      await q(`INSERT INTO sender_identities
                 (id, address, company_id, company_scope, provider_account, purpose, status,
                  authorized_by, reason)
               VALUES ($1,$2,$3,'company',$4,'any','active','naren','b7.9 fresh fixture')`,
        [id, FRESH, A, RESEND]);
      ids.identities.push(id);
      const v = await SID.authorizedSender(
        { from: FRESH, companyId: A, providerAccount: RESEND }, { ...deps, env: ENV });
      if (v.ok) ok('a declaration created a moment ago is visible to its own creator (B7.8d)');
      else bad('a just-created declaration read as unauthorized — the clock-race is back', v);
    }

    // ══ 8. THE ENV DEFAULT, KEPT AND NARROWED ════════════════════════════
    console.log('\n── 8. MAIL_FROM is the default sender, not a licence for the domain ──\n');

    const ENV_DEFAULT = { MAIL_FROM: 'PlayNexa <no-reply@fixture.invalid>', RESEND_FROM: '' };
    {
      // B7.11a CHANGED THIS ASSERTION, and the old one had become the defect it was guarding
      // against. It required the env default to authorize a send for COMPANY A — so one
      // environment variable could send as any company, for any purpose, which is what the owner
      // named: "the default platform sender must not automatically grant authority across all
      // companies and purposes." Both halves are now measured.
      const vPlatform = await SID.authorizedSender(
        { from: 'no-reply@fixture.invalid', companyId: null, providerAccount: RESEND },
        { ...deps, env: ENV_DEFAULT });
      if (vPlatform.ok) ok('the address MAIL_FROM names can send PLATFORM mail, so nothing breaks silently');
      else bad('the platform default sender was refused even for platform mail', vPlatform);

      const v = await SID.authorizedSender(
        { from: 'no-reply@fixture.invalid', companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV_DEFAULT });
      if (!v.ok) {
        ok('and it does NOT authorize a send for a COMPANY — that needs a declared row, by the '
          + 'same rule shared-mailboxes.js already applies to recipients');
      } else {
        bad('the env default authorized a company-scoped send: one variable can send as any '
          + 'company, for any purpose', v);
      }
    }
    {
      const v = await SID.authorizedSender(
        { from: 'someone-else@fixture.invalid', companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV_DEFAULT });
      if (!v.ok) ok('MAIL_FROM authorizes the ONE address it names, not its domain');
      else bad('MAIL_FROM authorized the whole domain, which is the defect it was narrowed to fix', v);
    }
    {
      // A declaration GOVERNS once it exists: a wrong company must not be rescued by the env
      // default, or declaring an address narrowly would be a no-op for the platform default.
      const BOTH = 'both@fixture.invalid';
      await declare({ address: BOTH, companyId: A });
      const v = await SID.authorizedSender(
        { from: BOTH, companyId: B, providerAccount: RESEND },
        { ...deps, env: { MAIL_FROM: `<${BOTH}>`, RESEND_FROM: '' } });
      if (!v.ok && v.code === 'sender_not_authorized_for_company') {
        ok('once a row declares an address, the row governs — the env default does not rescue it');
      } else {
        bad('the env default overrode a narrower declaration', v);
      }
    }
    {
      const DEP2 = 'departed-env@fixture.invalid';
      await mkUser(DEP2, false);
      const v = await SID.authorizedSender(
        { from: DEP2, companyId: A, providerAccount: RESEND },
        { ...deps, env: { MAIL_FROM: `<${DEP2}>`, RESEND_FROM: '' } });
      if (!v.ok && v.code === 'deactivated_sender') {
        ok('MAIL_FROM cannot readmit a departed person either — the override outranks it');
      } else {
        bad('the env default let the platform send as a person who has left', v);
      }
    }

    // ══ 9. FAIL CLOSED WHEN A SOURCE CANNOT BE READ ══════════════════════
    console.log('\n── 9. an unreadable source is not a yes ──\n');

    {
      const broken = { query: async (t, p) => {
        if (/FROM sender_identities/.test(t)) throw new Error('relation does not exist');
        return q(t, p);
      } };
      const v = await SID.authorizedSender(
        { from: DECLARED, companyId: A, providerAccount: RESEND }, { ...broken, env: ENV });
      if (!v.ok && v.code === 'sender_authorization_unknown') {
        ok('an unreadable declaration table refuses rather than authorizing');
      } else {
        bad('an unreadable declaration table did not fail closed', v);
      }
    }
    {
      const broken = { query: async (t, p) => {
        if (/FROM users/.test(t)) throw new Error('users unavailable');
        return q(t, p);
      } };
      const v = await SID.authorizedSender(
        { from: DECLARED, companyId: A, providerAccount: RESEND }, { ...broken, env: ENV });
      if (!v.ok && v.code === 'sender_authorization_unknown') {
        ok('an unreadable user table refuses — whether this is a departed person is then unknowable');
      } else {
        bad('an unreadable user table was treated as "nobody is deactivated"', v);
      }
    }
    {
      const v = await SID.authorizedSender(
        { from: 'a@fixture.invalid, b@fixture.invalid', companyId: A, providerAccount: RESEND },
        { ...deps, env: ENV });
      if (!v.ok && v.code === 'sender_unestablished') {
        ok('a send naming two senders is refused, not resolved to one of them');
      } else {
        bad('two senders were resolved to one', v);
      }
    }

    // ══ 10. WHAT THE DATABASE REFUSES ON ITS OWN ═════════════════════════
    console.log('\n── 10. the constraints hold whatever the calling code does ──\n');

    const refusedByDb = async (label, text, params) => {
      try {
        await q(text, params);
        bad(`the database ACCEPTED ${label}`);
      } catch (e) {
        if (['23502', '23514', '23503'].includes(e.code)) ok(`the database refuses ${label} (${e.code})`);
        else bad(`${label} failed for the wrong reason`, `${e.code} ${e.message}`);
      }
    };
    const base = (over = {}) => {
      const r = { id: uid('bad'), address: 'x@fixture.invalid', company_id: A,
        company_scope: 'company', provider_account: RESEND, purpose: 'any', status: 'active',
        may_send: true, may_receive_replies: true, authorized_by: 'naren', reason: 'why', ...over };
      return [`INSERT INTO sender_identities
                (id,address,company_id,company_scope,provider_account,purpose,status,may_send,
                 may_receive_replies,authorized_by,reason)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.id, r.address, r.company_id, r.company_scope, r.provider_account, r.purpose, r.status,
        r.may_send, r.may_receive_replies, r.authorized_by, r.reason]];
    };
    await refusedByDb('a company-scope row with no company', ...(() => {
      const [t, p] = base({ company_id: null }); return [t, p];
    })());
    await refusedByDb('a platform-scope row that names a company', ...(() => {
      const [t, p] = base({ company_scope: 'platform' }); return [t, p];
    })());
    await refusedByDb('a row that permits neither sending nor replies', ...(() => {
      const [t, p] = base({ may_send: false, may_receive_replies: false }); return [t, p];
    })());
    await refusedByDb('a blank reason', ...(() => {
      const [t, p] = base({ reason: '   ' }); return [t, p];
    })());
    await refusedByDb('a blank authorizer', ...(() => {
      const [t, p] = base({ authorized_by: '' }); return [t, p];
    })());
    await refusedByDb('a blank provider account', ...(() => {
      const [t, p] = base({ provider_account: ' ' }); return [t, p];
    })());
    await refusedByDb('an address that is not lower-case', ...(() => {
      const [t, p] = base({ address: 'MixedCase@fixture.invalid' }); return [t, p];
    })());
    await refusedByDb('a declaration for a company that does not exist', ...(() => {
      const [t, p] = base({ company_id: 'no-such-company' }); return [t, p];
    })());

    // ══ 11. THE AUDIT ════════════════════════════════════════════════════
    console.log('\n── 11. the audit the owner asked for ──\n');

    {
      // *"audit stored config, legacy mailbox credentials, signatures, database-backed
      // identities"* — and *"a comment-stripped source scan is not proof"*. So this asks each
      // SOURCE rather than grepping: a scan cannot find an address sitting in a database row or an
      // environment variable.
      const report = await SID.declaredIdentities({ ...deps, env: ENV_DEFAULT });
      if (report.tableReadable && report.table.length) {
        ok(`the audit reads ${report.table.length} declared identities from the database`);
      } else {
        bad('the audit found no database-backed identities', report);
      }
      if (report.env.some((e) => e.address === 'no-reply@fixture.invalid')) {
        ok('the audit reports the env-declared default sender');
      } else {
        bad('the audit missed MAIL_FROM, which is the source most sends actually use', report.env);
      }
      if (report.undeclaredEnv.includes('no-reply@fixture.invalid')) {
        ok('the audit names which env identities still have no reviewed declaration');
      } else {
        bad('the audit did not report the undeclared env identity', report.undeclaredEnv);
      }
    }
    // ══ 12. THE AUDIT SCRIPT, NOT JUST ITS LIBRARY ═══════════════════════
    console.log('\n── 12. the audit CLI runs ──\n');

    {
      // §11 exercises declaredIdentities(). This runs scripts/audit-sender-identities.js itself,
      // because a CLI can be broken while the library under it works — a missing require, a typo
      // in an output line, a crash in the source-literal walk. The repository has already been
      // caught once by a validator that could not be LOADED, and only because another driver
      // happened to execute it.
      const { execFileSync } = require('node:child_process');
      const env = { ...process.env, DATABASE_URL: cluster.url,
        MAIL_FROM: 'PlayNexa <no-reply@fixture.invalid>', RESEND_FROM: '' };
      try {
        const out = execFileSync(process.execPath,
          [require('node:path').join(__dirname, 'audit-sender-identities.js'), '--json'],
          { env, encoding: 'utf8', timeout: 60_000 });
        const parsed = JSON.parse(out);
        if (parsed.writes_nothing === true && Array.isArray(parsed.undeclared_env_identities)) {
          ok('the audit CLI runs against a real database and emits parseable JSON');
        } else {
          bad('the audit CLI produced unexpected JSON', Object.keys(parsed));
        }
        if (parsed.undeclared_env_identities.includes('no-reply@fixture.invalid')) {
          ok('the CLI names the env identity that has no reviewed declaration');
        } else {
          bad('the CLI did not report the undeclared env identity',
            parsed.undeclared_env_identities);
        }
        if (parsed.sources && parsed.sources.sender_identities_table !== null) {
          ok('the CLI read the declaration table rather than reporting it unreadable');
        } else {
          bad('the CLI could not read the declaration table');
        }
      } catch (e) {
        bad('the audit CLI failed to run', `${e.status !== undefined ? `exit ${e.status}: ` : ''}`
          + `${(e.stderr || e.message || '').toString().slice(0, 400)}`);
      }
    }
  } catch (e) {
    bad('the check threw', e.stack || e.message);
  } finally {
    // ── CLEANUP: ONLY WHAT THIS CREATED, BY ID ──────────────────────────
    try {
      for (const id of ids.identities) await q(`DELETE FROM sender_identities WHERE id = $1`, [id]);
      for (const id of ids.users) await q(`DELETE FROM users WHERE id = $1`, [id]);
      for (const id of ids.companies) await q(`DELETE FROM companies WHERE id = $1`, [id]);
      const mine = (await q(
        `SELECT COUNT(*)::int n FROM sender_identities WHERE id = ANY($1)`, [ids.identities])).rows[0].n;
      if (mine) bad(`${mine} fixture identities survived cleanup`);
      else ok('every fixture this check created is gone (by id, not by timestamp)');
    } catch (e) {
      bad('cleanup failed', e.message);
    }
    try { await P.end(); } catch (_) {}
    try { cluster.destroy(); } catch (_) {}
    clearTimeout(watchdog);
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`FAIL  ${e.stack || e.message}`);
  try { cluster.destroy(); } catch (_) {}
  process.exit(1);
});
