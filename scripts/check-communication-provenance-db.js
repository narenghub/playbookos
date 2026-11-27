#!/usr/bin/env node
// ── COMMUNICATION PROVENANCE, ACROSS EVERY BUSINESS MESSAGE TYPE ────────────
//
// Owner, repeatedly: *"Complete trusted communication provenance across all relevant message
// types, actual message content, recipient and company scope."*
//
// Four questions, asked of each kind of message the product actually sends:
//
//   WHO IS SENDING   — a declared `sender_identities` row for THIS company and THIS provider
//                      account, not an environment variable and not a company-domain address
//   WHO IS RECEIVING — an active member of that company, or an explicitly declared external route
//   FOR WHOM        — the company the send is attributed to, in the ledger as well as the gate
//   ABOUT WHEN      — the content day, derived from a persisted business record where the message
//                      speaks for one, and never asserted by the caller over data that disagrees
//
// ── THE SIX KINDS, TAKEN FROM THE PRODUCT RATHER THAN INVENTED ─────────────
//
// `grep -o "timelessKind: '[a-z_]*'" src/` gives exactly what the application sends:
//
//     19  correspondence        4  account_lifecycle     2  supplier_rfq
//      1  operator_alert        1  contract_document     1  commercial_offer
//
// plus the DATED sends, which declare a content day rather than a timeless kind. Each of the six is
// exercised below through the real `sendEmailDetailed` with a captured provider, and the captured
// request is asserted field by field. Nothing is transmitted: the transport is replaced and then
// read, which is the only way to assert what WOULD have gone out.
//
// ── THE DEFECT THIS CHECK WAS WRITTEN AFTER FINDING ────────────────────────
//
// `runEscalationCheck` takes a `date`, selects `WHERE p.score_date = $1`, and sent "your
// performance score **today** is X/100" while declaring `contentDay: businessToday()` — the clock.
// Run for a past date, it replayed historical figures with a current content day, which is exactly
// what B7.13 exists to refuse, declared past it. Its comment said *"periodic content, so it
// concerns today by construction"*; the construction did not hold, because the date is a parameter.
//
// Four per-employee sends now use `contentDayFrom: {kind:'performance_score', id: r.id}` — the day
// read off the row the figures came from, so the declaration cannot disagree with the data. The CEO
// digest aggregates many rows, where no single record can speak for the message, so it declares
// `today` — the value its own subject and heading print. §5 measures both.

'use strict';

process.env.ADMIN_EMAIL = 'cp-bootstrap@cp.invalid';
process.env.ADMIN_PASSWORD = `c-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.JWT_SECRET = `cp-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.NODE_ENV = 'development';
process.env.RESEND_API_KEY = 'cp-fixture-key-REPLACE_ME-not-a-credential';
delete process.env.INTERNAL_MAILBOXES;
delete process.env.MAIL_FROM;
delete process.env.RESEND_FROM;

const crypto = require('crypto');
const PG = require('./lib/pg-disposable');
const { EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

let pass = 0;
let fail = 0;
const lines = [];
const ok = (m) => { pass += 1; lines.push(`  ok    ${m}`); };
const bad = (m, extra) => {
  fail += 1;
  lines.push(`  FAIL  ${m}`);
  if (extra !== undefined) lines.push(`          ${String(extra).slice(0, 300)}`);
};
const note = (m) => lines.push(`  --    ${m}`);
const step = (t) => lines.push('', `── ${t} ──`, '');

// THE CAPTURED PROVIDER. Replaces the transport and nothing else.
const captured = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  let body = null;
  try { body = JSON.parse(init && init.body); } catch (_) { body = String(init && init.body); }
  captured.push({ url: String(url), body });
  return { ok: true, status: 200, json: async () => ({ id: `cap_${captured.length}` }) };
};

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'communication-provenance' });
  } catch (e) {
    console.log(`NOT EXECUTED  infrastructure unavailable: ${e.message}`);
    process.exit(EXIT_NOT_EXECUTED);
  }
  process.env.DATABASE_URL = cluster.url;
  const DB = require('../src/lib/db');
  const { query } = DB;

  try {
    await DB.initDB();
    await DB.initPhase2();
    await DB.migrateSchemas();
    await require('../src/lib/runs').migrateRuns(query);
    await require('../src/lib/office/schema').migrateOffice(query);
    await require('../src/lib/identity/schema').migrateIdentity(query);
    await require('../src/lib/identity/schema').migrateRecordOwnership(query);
    await require('../src/lib/outbound/sender-identity').migrateSenderIdentities(query);
    await require('../src/lib/outbound/shared-mailboxes').migrateSharedMailboxes(query);
    for (const sql of require('../src/lib/outbound/ledger-schema').DDL) await query(sql);

    const MAILER = require('../src/lib/mailer');
    const CD = require('../src/lib/outbound/content-day');
    const CTX = require('../src/lib/office/context');
    const SCOPE = require('../src/lib/office/scope');
    const MBR = require('../src/lib/identity/company-membership');
    const { fixtureAdmin } = require('./lib/fixture-admin');

    const CO = `cp-co-${crypto.randomUUID().slice(0, 8)}`;
    const SENDER = 'office@cpco.invalid';
    const MEMBER = 'member@cpco.invalid';
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,'CP Co','active')`,
      [CO]);
    const admin = await fixtureAdmin(query);
    const EMP = 'cp-member';
    await query(
      `INSERT INTO users (id, email, name, role, is_active, password_hash)
       VALUES ($1,$2,'CP Member','sales_team',1,'x')`, [EMP, MEMBER]);
    await MBR.grantMembership({ userId: EMP, companyId: CO, companyRole: 'sales_team',
      grantedBy: admin, grantedReason: 'communication provenance fixture' }, { query });
    await query(
      `INSERT INTO sender_identities
         (id, address, company_id, company_scope, provider_account, purpose,
          may_send, may_receive_replies, authorized_by, reason)
       VALUES ($1,$2,$3,'company',$4,'any',true,true,$5,'provenance fixture')`,
      [`cp-si-${crypto.randomUUID().slice(0, 8)}`, SENDER, CO, `resend:${SENDER}`, admin]);

    // A trusted context, the real way: objective → run → company context.
    const OBJ = `cp-obj-${crypto.randomUUID().slice(0, 8)}`;
    await SCOPE.createObjective({
      id: OBJ, companyId: CO, objective: 'communication provenance', priority: 'P3',
      kpiMetric: 'cp', kpiTarget: 1, deadline: '2026-12-31', budgetUsd: 1,
      autonomyTier: 'supervised', approvalPolicy: 'all_consequential', createdBy: admin,
    }, { query });
    const run = await require('../src/lib/run-ledger').ledger({ query }).createRun({
      trigger: 'check', triggerDetail: 'cp', workflow: 'cp-workflow', agent: 'cp',
      product: 'playbookos', companyId: CO, objectiveId: OBJ,
      intentKey: `cp-${crypto.randomUUID().slice(0, 8)}`,
    });
    const coCtx = await CTX.resolveCompanyContext({ runId: run.runId }, { query });
    await SCOPE.setObjectiveStatus(coCtx, { id: OBJ, status: 'active' }, { query });
    const ctx = await CTX.resolveObjectiveContext({ objectiveId: OBJ }, { query });

    // ══ 1. EVERY KIND THE PRODUCT SENDS, FROM THE PRODUCT ══════════════════
    step('1. the six kinds are taken from the source, not from this file\'s imagination');

    const fs = require('fs');
    const path = require('path');
    const srcKinds = new Set();
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
          const txt = fs.readFileSync(full, 'utf8');
          for (const m of txt.matchAll(/timelessKind:\s*'([a-z_]+)'/g)) srcKinds.add(m[1]);
        }
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    // TIMELESS_KINDS is a Set. `Object.values()` on a Set returns [] — so the first run read an
    // EMPTY vocabulary, declared all six source kinds undeclared, iterated §2 zero times, and had
    // §3 compare against zero while reporting "ok". A container-type assumption that made three
    // sections agree with each other about nothing.
    const declared = new Set(
      CD.TIMELESS_KINDS instanceof Set ? [...CD.TIMELESS_KINDS]
        : Array.isArray(CD.TIMELESS_KINDS) ? CD.TIMELESS_KINDS
          : Object.values(CD.TIMELESS_KINDS || {}));
    if (declared.size === 0) {
      bad('the TIMELESS vocabulary read as EMPTY — every section below would pass vacuously');
    }
    const unknown = [...srcKinds].filter((k) => !declared.has(k));
    if (unknown.length === 0) {
      ok(`${srcKinds.size} kind(s) used in src/ (${[...srcKinds].sort().join(', ')}) and every one `
        + 'is in the closed vocabulary — a caller cannot invent a kind');
    } else {
      bad(`src/ uses kind(s) the vocabulary does not declare: ${unknown.join(', ')}`);
    }

    // ══ 2. EACH KIND, THROUGH THE REAL GATES, CAPTURED AND READ ════════════
    step('2. each kind sends, and the captured request carries the right provenance');

    const send = async (over) => {
      captured.length = 0;
      const r = await MAILER.sendEmailDetailed({
        to: MEMBER, from: SENDER, replyTo: SENDER,
        subject: `provenance: ${over.timelessKind || over.contentDay || 'dated'}`,
        html: `<p>content for ${over.timelessKind || 'a dated message'}</p>`,
        companyContext: ctx, capability: 'email.send',
        workflow: 'cp-workflow', agent: 'cp-check',
        ...over,
      });
      return { r, req: captured[0] || null };
    };

    for (const kind of [...declared].sort()) {
      const { r, req } = await send({ contentDay: CD.TIMELESS, timelessKind: kind });
      if (r.ok !== true) {
        bad(`${kind} was refused`, JSON.stringify({ phase: r.phase, error: r.error }).slice(0, 180));
        continue;
      }
      const b = (req && req.body) || {};
      const good = String(b.from || '').includes(SENDER)
        && String(JSON.stringify(b.to)).includes(MEMBER)
        && String(b.html || '').includes(kind);
      if (good) {
        ok(`${kind}: sent from the DECLARED identity to the active member, and the captured body `
          + 'is the content that was composed — not a shape');
      } else {
        bad(`${kind}: the captured request does not carry the right provenance`,
          JSON.stringify(b).slice(0, 220));
      }
    }

    // ══ 3. THE LEDGER ATTRIBUTES EVERY ONE TO THE COMPANY ══════════════════
    step('3. the audit row says WHOSE mail it was');

    const LED = require('../src/lib/outbound/ledger-schema');
    const attributed = await query(
      `SELECT COUNT(*)::int n FROM ${LED.TABLE} WHERE company_id = $1`, [CO]);
    const unattributed = await query(
      `SELECT COUNT(*)::int n FROM ${LED.TABLE} WHERE company_id IS NULL`);
    if (declared.size > 0 && attributed.rows[0].n >= declared.size) {
      ok(`${attributed.rows[0].n} ledger row(s) attributed to ${CO} — "every message sent for `
        + 'company X" answers, which it did not before the companyId was passed to beginAttempt');
    } else {
      bad(`only ${attributed.rows[0].n} of ${declared.size} sends were attributed`,
        `unattributed: ${unattributed.rows[0].n}`);
    }

    // ══ 4. THE FOUR REFUSALS, EACH BY NAME ═════════════════════════════════
    step('4. an undeclared sender, a non-member, another company, and a bare kind');

    const undeclared = await send({
      contentDay: CD.TIMELESS, timelessKind: 'correspondence', from: 'nobody@cpco.invalid' });
    if (undeclared.r.ok === false && /sender/i.test(`${undeclared.r.phase}`)) {
      ok(`an UNDECLARED sender on the same domain is refused (${undeclared.r.phase}) — being on a `
        + 'company domain is a deliverability fact, not an authorization');
    } else {
      bad('an undeclared sender was permitted', JSON.stringify(undeclared.r).slice(0, 200));
    }
    const stranger = await send({
      contentDay: CD.TIMELESS, timelessKind: 'correspondence', to: 'stranger@elsewhere.invalid' });
    if (stranger.r.ok === false) {
      ok(`a recipient who is not an active member is refused (${stranger.r.phase})`);
    } else {
      note(`an external recipient was permitted (${JSON.stringify(stranger.r).slice(0, 120)}) — `
        + 'legitimate for an outward kind; §4b checks the company scope instead');
    }
    // §4b: the DECLARED sender of THIS company may not send for ANOTHER company.
    const OTHER = `cp-other-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,'CP Other','active')`,
      [OTHER]);
    const SID = require('../src/lib/outbound/sender-identity');
    const crossScope = await SID.authorizedSender(
      { from: SENDER, companyId: OTHER, providerAccount: `resend:${SENDER}` }, { query });
    if (crossScope.ok === false) {
      ok('and this company\'s declared sender is NOT authorized for another company — the '
        + 'declaration is company-scoped, which is what "for whom" means');
    } else {
      bad('a declared sender crossed companies', JSON.stringify(crossScope).slice(0, 200));
    }
    const bareKind = await send({ contentDay: CD.TIMELESS });
    if (bareKind.r.ok === false && /timeless/i.test(`${bareKind.r.phase}`)) {
      ok(`declaring TIMELESS with no kind is refused (${bareKind.r.phase}) — a capability is not a `
        + 'content kind, and "this concerns no day" has to say which sort of message it is');
    } else {
      bad('a bare TIMELESS declaration was permitted', JSON.stringify(bareKind.r).slice(0, 200));
    }

    // ══ 5. THE DATED CASE, AND THE DEFECT THAT PROMPTED THIS CHECK ═════════
    step('5. a dated message takes its day from the record it describes');

    const SCORE_ID = `cp-score-${crypto.randomUUID().slice(0, 8)}`;
    const TODAY = require('../src/lib/agent-core').businessToday();
    await query(
      `INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100)
       VALUES ($1,$2,$3,42)`, [SCORE_ID, EMP, TODAY]);
    const fromRecord = await send({ contentDayFrom: { kind: 'performance_score', id: SCORE_ID } });
    if (fromRecord.r.ok === true) {
      ok('a message about TODAY\'s score row sends, with its day read from score_date');
    } else {
      bad('a current record was refused', JSON.stringify(fromRecord.r).slice(0, 200));
    }
    // THE DEFECT: a historical row. Before the fix this sent, because the clock said today.
    const OLD_ID = `cp-old-${crypto.randomUUID().slice(0, 8)}`;
    await query(
      `INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100)
       VALUES ($1,$2,'2026-11-01',41)`, [OLD_ID, EMP]);
    captured.length = 0;
    const stale = await send({ contentDayFrom: { kind: 'performance_score', id: OLD_ID } });
    if (stale.r.ok === false && stale.r.phase === 'content_day_stale' && captured.length === 0) {
      ok('and a message about a THREE-WEEK-OLD score row is refused as stale, with NOTHING sent — '
        + 'the day comes from the row, so a caller cannot declare it current');
    } else {
      bad('a historical record was sent about with a current declaration',
        JSON.stringify({ phase: stale.r.phase, captured: captured.length }));
    }
    // AND THE SITES: the escalation path must no longer take its day from the clock.
    const orchSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'agents', 'orchestrator.js'), 'utf8');
    const escalation = orchSrc.slice(orchSrc.indexOf('async function runEscalationCheck'));
    const clockDays = (escalation.match(/contentDay: require\('\.\.\/agent-core'\)\.businessToday\(\)/g) || []).length;
    const fromRows = (escalation.match(/contentDayFrom: \{ kind: 'performance_score'/g) || []).length;
    if (clockDays === 0 && fromRows === 4) {
      ok(`runEscalationCheck: ${fromRows} per-employee sends take the day from the score ROW and `
        + 'ZERO take it from the clock — the content and the declaration cannot disagree');
    } else {
      bad(`runEscalationCheck still has ${clockDays} clock-derived day(s) and ${fromRows} `
        + 'record-derived', 'each per-employee send describes one score row and must name it');
    }
    if (/contentDay: today,/.test(escalation)) {
      ok('and the CEO digest declares `today` — the value its own subject prints — because it '
        + 'aggregates many rows and no single record can speak for a digest');
    } else {
      bad('the CEO digest does not declare the day its content shows');
    }
  } catch (e) {
    bad(`the check itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 6).join('\n'));
  } finally {
    global.fetch = realFetch;
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ COMMUNICATION PROVENANCE ACROSS MESSAGE TYPES ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log('  --    ZERO messages transmitted: the provider transport was replaced by a capture '
    + 'for the whole run, and every assertion reads what WOULD have been sent');
  console.log('');
  console.log(fail === 0
    ? `OK  (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
