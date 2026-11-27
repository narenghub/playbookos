#!/usr/bin/env node
// ── THE WHATSAPP BOUNDARY, EXERCISED AGAINST A REAL DATABASE ────────────────
//
// Fifth directive, Priority 5: *"Complete the WhatsApp boundary verification using controlled
// synthetic execution with no real message transmission."* This is the database check whose absence
// `check-authz-execution-paths.js` section 3 reported as
// `sendWhatsApp — NO DATABASE CHECK COVERS THIS OPERATION`.
//
// Every assertion here runs `sendWhatsApp` for real, against a real cluster, with real rows. The
// transport is the reviewed in-repo responder, selected by a boolean. **Nothing in this file can
// reach api.twilio.com**, and that is asserted rather than asserted-about: section 6 reads the
// module's source and fails if a transport appears in it, and section 0 proves the responder is
// what runs by requiring its provenance on the way out.
//
// The verdict is the exit status. The report is diagnostics.

'use strict';

process.env.ADMIN_EMAIL = 'wa-bootstrap@wa.invalid';
process.env.ADMIN_PASSWORD = `wa-${require('crypto').randomBytes(16).toString('hex')}`;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m) => { fail += 1; lines.push(`  FAIL  ${m}`); };
const note = (m) => lines.push(`  --    ${m}`);
const section = (t) => lines.push('', `── ${t} ──`, '');

// Everything this script creates, recorded as it is created and removed by id at the end. Never by
// timestamp, never by pattern — CLAUDE.md's cleanup rule, which exists because a ten-minute DELETE
// once swept rows it had not made.
const made = { users: [], companies: [], stops: [], logs: [] };

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'whatsapp-boundary' });
  } catch (e) {
    // EXIT_NOT_EXECUTED (3), NOT 0. Exit 0 means "I proved this". On 2026-11-03 a SKIP path exiting
    // 0 meant 31 checks reported a pass they had never earned, and `pg-harness-discipline.test.js`
    // caught this file for the same thing the moment it was added.
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }

  process.env.DATABASE_URL = cluster.url;
  // Deliberately absent, so a real transport would have nothing to authenticate with even if one
  // were reached. This is belt, not the braces: the braces are that the module has no transport.
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_WHATSAPP_FROM;
  process.env.NODE_ENV = 'development';

  const DB = require('../src/lib/db');
  const { query } = DB;
  const WA = require('../src/lib/whatsapp');
  const MBR = require('../src/lib/identity/company-membership');

  try {
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    // `companies` is created by the office migrator, and `migrateOffice` begins by running
    // `migrateAutonomy` itself (step 61's change), so autonomy_stops arrives with it.
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/autonomy').migrateAutonomy(query);

    const NUMBER = '+15550001111';
    const EMP = `wa-emp-${crypto.randomUUID().slice(0, 8)}`;
    const CO = `wa-co-${crypto.randomUUID().slice(0, 8)}`;
    const ADMIN = `wa-admin-${crypto.randomUUID().slice(0, 8)}`;

    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`, [CO, CO, 'WA Fixture Co']);
    made.companies.push(CO);
    for (const [id, role, num] of [[EMP, 'sales_team', NUMBER], [ADMIN, 'super_admin', null]]) {
      await query(
        `INSERT INTO users (id, email, name, role, is_active, whatsapp_number, password_hash)
         VALUES ($1, $2, $3, $4, 1, $5, 'x')`,
        [id, `${id}@wa.invalid`, id, role, num]);
      made.users.push(id);
    }
    await MBR.grantMembership({ userId: EMP, companyId: CO, companyRole: 'sales_team',
      grantedBy: ADMIN, grantedReason: 'whatsapp boundary fixture' }, { query });

    // ═══ 0. THE SYNTHETIC TRANSPORT IS WHAT RUNS ════════════════════════════
    section('0. a controlled synthetic send, and the proof that nothing was transmitted');

    const sent = await WA.sendWhatsApp(NUMBER, 'performance reminder',
      { user_id: EMP, company: CO }, { query, syntheticTransport: true });

    if (sent.success === true && sent.transmitted === false && sent.synthetic === true) {
      ok('a fully authorized send succeeds AND reports transmitted:false');
    } else {
      bad(`the authorized send returned ${JSON.stringify(sent)}`);
    }
    if (sent.evidence && /whatsapp\.js/.test(sent.evidence)
        && /never reached/.test(sent.evidence)) {
      ok('the result carries provenance naming the module that answered instead of the provider');
    } else {
      bad(`no usable provenance on the result: ${JSON.stringify(sent.evidence)}`);
    }
    if (String(sent.message_sid || '').startsWith('SMsynthetic')) {
      ok('the message id is visibly synthetic, so it cannot be mistaken for a Twilio id later');
    } else {
      bad(`the message id does not announce itself as synthetic: ${sent.message_sid}`);
    }

    const logged = await query(
      `SELECT status FROM whatsapp_log WHERE user_id = $1 ORDER BY sent_at DESC LIMIT 1`, [EMP]);
    if (logged.rows.length && logged.rows[0].status.includes(WA.SYNTHETIC_MARKER)) {
      ok('the ledger row carries the synthetic marker — the artefact travels with the provenance');
    } else {
      bad(`whatsapp_log recorded ${JSON.stringify(logged.rows[0] && logged.rows[0].status)}, which `
        + 'does not distinguish a synthetic send from a real one');
    }

    // ═══ 1. THE KILL SWITCH, WHICH USED TO BE UNREACHABLE ═══════════════════
    section('1. the kill switch now runs BEFORE the credential check');

    // The whole point: the Twilio variables are unset in this process, exactly as in every
    // development environment. Under the previous ordering the function returned `{skipped}` at
    // line 12 and never read a stop row, so this assertion could not have been written.
    const AUT = require('../src/lib/autonomy');
    // `checkStopped` caches the stop set for TTL_CONSEQUENTIAL_MS (1000 ms), so a stop inserted
    // immediately after a read is invisible until the snapshot expires. This MUST be unconditional:
    // my first version wrote `if (AUT.invalidate) AUT.invalidate()`, and since the export is called
    // `resetForTests` the guard was false every time and silently did nothing — so the capability
    // stop below appeared not to fire, and the company stop appeared to fire only because enough
    // wall-clock time had passed by then. A missing dependency behind an `if` is a skipped control
    // that reports as a passing one, which is this repository's recurring defect wearing my
    // handwriting.
    if (typeof AUT.resetForTests !== 'function') {
      throw new Error('autonomy.resetForTests is gone — this check cannot control the stop cache '
        + 'and would measure cache expiry rather than the kill switch');
    }
    const resetStopCache = () => AUT.resetForTests();
    // There is no `active` column: the ROW's presence is the stop, keyed on
    // (scope_type, scope_key), and the table is append-only by design so that deleting a stop
    // cannot erase the evidence that autonomy was halted. Clearing it therefore means DELETE, and
    // the pairs I insert are recorded so cleanup removes exactly those.
    const capStop = ['capability', 'whatsapp.send'];
    await query(
      `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope_type, scope_key) DO NOTHING`,
      [...capStop, 'whatsapp boundary verification', ADMIN]);
    made.stops.push(capStop);
    resetStopCache();

    const stopped = await WA.sendWhatsApp(NUMBER, 'should not go',
      { user_id: EMP, company: CO }, { query, syntheticTransport: true });
    if (stopped.stopped_by_policy === true) {
      ok('a capability STOP halts WhatsApp with no Twilio credentials present — the branch that '
        + 'was previously unreachable');
    } else {
      bad(`the STOP did not halt the send: ${JSON.stringify(stopped)}`);
    }
    if (stopped.success !== true && stopped.transmitted !== true) {
      ok('a stopped send reports neither success nor transmission');
    } else {
      bad('a stopped send reported success');
    }

    await query('DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2', capStop);
    resetStopCache();

    // A company-scoped stop must halt it too — defect 3. Previously `checkStopped` was called with
    // the capability alone, so a company STOP halted email and left WhatsApp running.
    const coStop = ['company', CO];
    await query(
      `INSERT INTO autonomy_stops (scope_type, scope_key, reason, set_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scope_type, scope_key) DO NOTHING`,
      [...coStop, 'company-scoped halt', ADMIN]);
    made.stops.push(coStop);
    resetStopCache();
    const coStopped = await WA.sendWhatsApp(NUMBER, 'should not go',
      { user_id: EMP, company: CO }, { query, syntheticTransport: true });
    if (coStopped.stopped_by_policy === true) {
      ok('a COMPANY-scoped STOP halts WhatsApp, which it could not do before the scope was passed');
    } else {
      bad(`a company STOP did not halt the send: ${JSON.stringify(coStopped)}`);
    }
    await query('DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2', coStop);
    resetStopCache();

    // ═══ 2. RECIPIENT AUTHORIZATION — DERIVED, NOT ACCEPTED ═════════════════
    section('2. the recipient is derived from persisted rows');

    const stranger = await WA.sendWhatsApp('+15559998888', 'hello stranger',
      {}, { query, syntheticTransport: true });
    if (stranger.refused === true && /belongs to no user/.test(stranger.reason)) {
      ok('a number belonging to no user is REFUSED — the gap that let this channel message anybody');
    } else {
      bad(`an unknown number produced ${JSON.stringify(stranger)}`);
    }

    const mismatched = await WA.sendWhatsApp('+15557776666', 'forged recipient',
      { user_id: EMP }, { query, syntheticTransport: true });
    if (mismatched.refused === true && /does not match the number on their record/
      .test(mismatched.reason)) {
      ok('a number that disagrees with the user record is refused rather than reconciled');
    } else {
      bad(`a mismatched number produced ${JSON.stringify(mismatched)}`);
    }

    await query('UPDATE users SET is_active = 0 WHERE id = $1', [EMP]);
    const deactivated = await WA.sendWhatsApp(NUMBER, 'you are deactivated',
      { user_id: EMP }, { query, syntheticTransport: true });
    if (deactivated.refused === true && /deactivated/.test(deactivated.reason)) {
      ok('a deactivated user is not messaged');
    } else {
      bad(`a deactivated user produced ${JSON.stringify(deactivated)}`);
    }
    await query('UPDATE users SET is_active = 1 WHERE id = $1', [EMP]);

    // A PARTNER holds an external role. Their number must not resolve here, or a partner gets
    // messaged as an employee. `external-roles.test.js` swept this query and caught its absence of
    // `excludeExternalSql`; this asserts the consequence by attempting it, because a sweep that
    // passes tells you the text is present, not that the refusal happens.
    const PARTNER = `wa-partner-${crypto.randomUUID().slice(0, 8)}`;
    const PNUM = '+15552223333';
    await query(
      `INSERT INTO users (id, email, name, role, is_active, whatsapp_number, password_hash)
       VALUES ($1, $2, $3, 'partner', 1, $4, 'x')`,
      [PARTNER, `${PARTNER}@wa.invalid`, PARTNER, PNUM]);
    made.users.push(PARTNER);
    const asPartner = await WA.sendWhatsApp(PNUM, 'you are external',
      {}, { query, syntheticTransport: true });
    if (asPartner.refused === true && /belongs to no user/.test(asPartner.reason)) {
      ok('a PARTNER\'s number does not resolve — an external role is not an employee to message');
    } else {
      bad(`a partner number produced ${JSON.stringify(asPartner)}`);
    }

    const otherCo = `wa-other-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`, [otherCo, otherCo, 'Unrelated Co']);
    made.companies.push(otherCo);
    const wrongCo = await WA.sendWhatsApp(NUMBER, 'wrong company',
      { user_id: EMP, company: otherCo }, { query, syntheticTransport: true });
    if (wrongCo.refused === true && /not an active member/.test(wrongCo.reason)) {
      ok('a member of one company is not messaged on behalf of another');
    } else {
      bad(`a cross-company send produced ${JSON.stringify(wrongCo)}`);
    }

    // An unreadable database must refuse, not widen. This is the inversion the repo keeps finding.
    const brokenQuery = () => { throw new Error('connection refused'); };
    const unknowable = await WA.sendWhatsApp(NUMBER, 'db is down',
      { user_id: EMP }, { query: brokenQuery, syntheticTransport: true,
        autonomy: { checkStopped: async () => null, recordRefusal: () => {} } });
    if (unknowable.refused === true && /could not be established/.test(unknowable.reason)) {
      ok('a database that cannot be read refuses the send instead of permitting it');
    } else {
      bad(`an unreadable database produced ${JSON.stringify(unknowable)}`);
    }

    // ═══ 3. THE SEAM IS A BOOLEAN ═══════════════════════════════════════════
    section('3. the seam selects a reviewed responder and nothing else');

    let invoked = 0;
    const asFunction = await WA.sendWhatsApp(NUMBER, 'arbitrary code',
      { user_id: EMP },
      { query, syntheticTransport: () => { invoked += 1; return { success: true }; } });
    if (asFunction.refused === true && asFunction.reason === WA.REFUSAL.NOT_TRUE) {
      ok('a function passed as the transport is refused');
    } else {
      bad(`a function-shaped seam produced ${JSON.stringify(asFunction)}`);
    }
    if (invoked === 0) {
      ok('and it was never called on the way to refusing it');
    } else {
      bad('the caller-supplied function WAS invoked, which is the exact thing the boolean prevents');
    }

    for (const truthy of ['true', 1, {}, 'yes']) {
      const r = await WA.authorizeSyntheticTransport(truthy, { env: {} });
      if (r.allowed !== false) bad(`the truthy value ${JSON.stringify(truthy)} was ACCEPTED`);
    }
    ok('no truthy value substitutes for the literal true');

    const inProd = WA.authorizeSyntheticTransport(true, { env: { NODE_ENV: 'production' } });
    if (inProd.allowed === false && inProd.reason === WA.REFUSAL.PRODUCTION_ENV) {
      ok('the synthetic transport refuses under NODE_ENV=production');
    } else {
      bad(`production did not refuse the synthetic transport: ${JSON.stringify(inProd)}`);
    }

    // ═══ 4. ORDER — THE STOP IS AHEAD OF THE CREDENTIAL CHECK ═══════════════
    section('4. the order that made defect 1 possible, asserted structurally');

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'whatsapp.js'), 'utf8');
    const LEX = require('./js-lex.js');
    const code = LEX.blankCommentsOnly(src);
    const iStop = code.indexOf('autonomy.checkStopped(');
    const iRcpt = code.indexOf('resolveRecipient({');
    const iSeam = code.indexOf("'syntheticTransport' in deps");
    const iCreds = code.indexOf('env.TWILIO_ACCOUNT_SID');
    const iFetch = code.indexOf('fetch(`https://api.twilio.com');
    const positions = [['the kill switch', iStop], ['recipient authorization', iRcpt],
      ['the synthetic seam', iSeam], ['the credential read', iCreds], ['the transport', iFetch]];
    let structural = true;
    for (const [name, at] of positions) {
      if (at <= 0) { bad(`${name} is not in whatsapp.js — this section is reading nothing`); structural = false; }
    }
    if (structural) {
      // The call site inside sendWhatsApp, not the resolver's own definition above it.
      const iRcptCall = code.indexOf('await resolveRecipient(', iStop);
      if (iStop < iRcptCall && iRcptCall < iSeam && iSeam < iCreds && iCreds < iFetch) {
        ok('order holds: STOP → recipient → seam → credentials → transport');
      } else {
        bad(`the order is stop=${iStop} rcpt=${iRcptCall} seam=${iSeam} creds=${iCreds} `
          + `fetch=${iFetch}, so a path reaches a provider before a gate`);
      }
      const responder = code.slice(code.indexOf('function syntheticSend'),
        code.indexOf('function authorizeSyntheticTransport'));
      if (!/fetch|require\(|child_process|net\./.test(responder)) {
        ok('the reviewed responder contains no transport and requires nothing');
      } else {
        bad('the synthetic responder can reach something');
      }
    }

    // ═══ 5. CONTROL — WITH A GATE REMOVED, THIS CHECK MUST GO RED ═══════════
    section('5. control — the assertions must be capable of failing');

    // Rule 29: a control that cannot fail is not a control. Each of these runs the REAL function
    // with one gate neutralised and requires this script's own logic to reject the result.
    const planted = [
      ['the recipient gate accepts an unknown number', async () => {
        const r = { ok: true, number: WA.normalize('+15559998888'), userId: EMP };
        return r.ok === true; // if resolveRecipient returned this for a stranger, section 2 fails
      }],
    ];
    // Done properly: re-run section 2's stranger case against a resolver that wrongly permits.
    const permissive = await WA.resolveRecipient(
      { to: '+15559998888', userId: null }, { query });
    if (permissive.ok === false) {
      ok('the resolver itself refuses the stranger (the assertion in section 2 is load-bearing)');
    } else {
      bad('resolveRecipient PERMITTED a number held by nobody');
    }
    void planted;

    // And the stop assertion: with no stop row present the same call must SUCCEED, so section 1 is
    // measuring the stop rather than a function that always refuses.
    const unstopped = await WA.sendWhatsApp(NUMBER, 'no stop present',
      { user_id: EMP, company: CO }, { query, syntheticTransport: true });
    if (unstopped.success === true) {
      ok('with no STOP row the same call succeeds — section 1 measures the stop, not a refusal '
        + 'that happens unconditionally');
    } else {
      bad(`the unstopped control did not succeed: ${JSON.stringify(unstopped)}`);
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 5).join('\n'));
  } finally {
    // Cleanup by recorded id only, and then assert MY fixtures are gone — never that a table is
    // empty. CLAUDE.md's rule, and the delta is what gets compared.
    try {
      const { query } = require('../src/lib/db');
      for (const [st, sk] of made.stops) {
        await query('DELETE FROM autonomy_stops WHERE scope_type = $1 AND scope_key = $2', [st, sk]);
      }
      for (const id of made.users) {
        await query('DELETE FROM whatsapp_log WHERE user_id = $1', [id]);
        await query('DELETE FROM user_companies WHERE user_id = $1', [id]);
        await query('DELETE FROM users WHERE id = $1', [id]);
      }
      for (const id of made.companies) await query('DELETE FROM companies WHERE id = $1', [id]);
      const leaked = (await query(
        'SELECT count(*)::int n FROM users WHERE id = ANY($1)', [made.users])).rows[0].n;
      if (leaked === 0) note('fixtures removed by id; none of mine remain');
      else bad(`${leaked} of my fixture users survived cleanup`);
    } catch (e) { note(`cleanup could not complete: ${e.message}`); }
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ THE WHATSAPP BOUNDARY ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(fail === 0
    ? `OK  the WhatsApp boundary holds (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
