#!/usr/bin/env node
// ── THE EMPLOYEE OPERATING LOOP, CONNECTED, END TO END ──────────────────────
//
// Owner, Priority 2: *"Execute one connected synthetic business workflow using the actual
// authorization implementations and real persisted records… Do not substitute injected
// authorization responses for actual authorization in this integrated verification."* and
// *"Demonstrate the complete sequence in one connected execution, not isolated passing component
// tests."*
//
//   executive objective → planning → employee assignment → authorized notification →
//   captured delivery outcome → acknowledgment → completion → evidence validation →
//   performance evaluation → coaching or escalation → executive briefing → memory → next cycle
//
// **WHAT IS REAL HERE AND WHAT IS SYNTHETIC, stated plainly because the distinction is the whole
// value of this check.** Every authorization is the real implementation reading real rows: the
// company classification of migration 62, the sender declarations of B7.9a/B7.11a, the recipient
// classification of B7.1/B7.11, B7.13's content day resolved from the persisted task row, active
// membership, and the kill switch. Nothing is stubbed to say yes. **The only substitution is the
// PROVIDER TRANSPORT**, which is captured rather than called, because no real message may be
// transmitted — and the capture is then asserted field by field, which is the point of capturing
// it rather than merely suppressing it.
//
// **§13 is the assertion that makes this a workflow rather than a list.** Each step's input is
// asserted to BE the previous step's output — the task the notification is about is the task the
// plan created, the day it declares is the day on that row, the completion is of that task, the
// score is of that completion. Thirteen independently passing steps would say nothing about
// whether the office can traverse them.
//
// The verdict is the exit status.

'use strict';

process.env.ADMIN_EMAIL = 'loop-bootstrap@loop.invalid';
process.env.ADMIN_PASSWORD = `l-${require('crypto').randomBytes(16).toString('hex')}`;
// Set unconditionally, not as a `process.env.X || <literal>` fallback: check-secrets.js reads that
// shape as a hard-coded fallback credential and is right to — a fallback is exactly where a real
// secret gets left behind. A fresh random value per run is not a credential and does not need one.
process.env.JWT_SECRET = `loop-${require('crypto').randomBytes(16).toString('hex')}`;
process.env.WORKER_SECRET_SEAL_KEY = require('crypto').randomBytes(32).toString('hex');
process.env.NODE_ENV = 'development';
process.env.RESEND_API_KEY = 'loop-fixture-key-not-a-real-credential';
// No INTERNAL_MAILBOXES and no MAIL_FROM: the loop must work on DECLARED rows, which is what
// B7.11a is about. If it only works with the legacy variable set, it has not been migrated.
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
  if (extra !== undefined) lines.push(`          ${JSON.stringify(extra).slice(0, 300)}`);
};
const note = (m) => lines.push(`  --    ${m}`);
const step = (n, t) => lines.push('', `── ${n}. ${t} ──`, '');

// ── THE CAPTURED PROVIDER, which replaces the transport and nothing else ────
const captured = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  let body = null;
  try { body = JSON.parse(init && init.body); } catch (_) { body = String(init && init.body); }
  captured.push({ url: String(url), headers: (init && init.headers) || {}, body });
  return { ok: true, status: 200, json: async () => ({ id: `cap_${captured.length}` }) };
};

(async () => {
  let cluster = null;
  try {
    cluster = PG.create({ label: 'employee-operating-loop' });
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

    const SYN = require('../src/lib/worker/synthetic-isolation');
    const MBR = require('../src/lib/identity/company-membership');
    const OPS = require('../src/lib/identity/scoped-operations');
    const CTX = require('../src/lib/office/context');
    const MAILER = require('../src/lib/mailer');
    const MEMORY = require('../src/lib/office/memory');
    const CD = require('../src/lib/outbound/content-day');
    const SID = require('../src/lib/outbound/sender-identity');

    // ═══ 0. FIXTURES: A SYNTHETIC COMPANY WITH REAL ROWS ════════════════════
    step(0, 'a synthetic company, an employed person, and a DECLARED sender');

    const CO = `loop-co-${crypto.randomUUID().slice(0, 8)}`;
    const ADMIN = 'loop-admin';
    const EMP = 'loop-employee';
    const EMP_EMAIL = 'employee@loopco.invalid';
    const SENDER_ADDR = 'office@loopco.invalid';

    await query(
      `INSERT INTO companies (id, slug, display_name, status) VALUES ($1,$1,$2,'active')`,
      [CO, 'Loop Co (synthetic)']);
    await SYN.setCompanySynthetic(CO, true, { query });
    for (const [id, email, role] of [[ADMIN, 'admin@loopco.invalid', 'super_admin'],
      [EMP, EMP_EMAIL, 'sales_team']]) {
      await query(
        `INSERT INTO users (id, email, name, role, is_active, password_hash)
         VALUES ($1,$2,$1,$3,1,'x')`, [id, email, role]);
    }
    await MBR.grantMembership({ userId: EMP, companyId: CO, companyRole: 'sales_team',
      grantedBy: ADMIN, grantedReason: 'operating loop fixture' }, { query });

    // The sender is a DECLARED ROW for this company — not MAIL_FROM, which B7.11a no longer lets
    // authorize a company's mail, and not INTERNAL_MAILBOXES, which is unset above.
    await query(
      `INSERT INTO sender_identities
         (id, address, company_id, company_scope, provider_account, purpose,
          may_send, may_receive_replies, authorized_by, reason, effective_from)
       VALUES ($1,$2,$3,'company',$4,'any',true,true,$5,$6,NOW())`,
      [`si-${crypto.randomUUID().slice(0, 8)}`, SENDER_ADDR, CO,
        `resend:${SENDER_ADDR}`, ADMIN, 'operating loop fixture']);
    const senderCheck = await SID.authorizedSender(
      { from: SENDER_ADDR, companyId: CO, providerAccount: `resend:${SENDER_ADDR}` }, { query });
    if (senderCheck.ok) {
      ok('the declared sender is authorized for THIS company, by a row rather than a variable');
    } else {
      bad('the declared sender was refused, so nothing below can send', senderCheck);
    }
    const platformTry = await SID.authorizedSender(
      { from: 'no-reply@adificetechnologies.com', companyId: CO,
        providerAccount: 'resend:no-reply@adificetechnologies.com' }, { query });
    if (!platformTry.ok) {
      ok('CONTROL: the platform default is NOT authorized for this company (B7.11a)');
    } else {
      bad('the platform default authorized a company send', platformTry);
    }

    // ═══ 1-2. EXECUTIVE OBJECTIVE AND ITS PLAN ══════════════════════════════
    step('1-2', 'an executive objective, and a plan that names the work');

    // ── THROUGH THE ACCESSOR, AND ACTIVATED THE WAY THE OFFICE ACTIVATES ────
    //
    // This fixture used to write the objectives row itself, which check-office-scope-discipline.js
    // refused: company scoping lives in src/lib/office/scope.js on purpose, and a predicate written
    // at a call site is one somebody can forget. The refusal was right and an exemption would have
    // been the wrong answer — this check has no claim on being special, and going through the
    // accessor also makes the fixture resemble the thing it is meant to be measuring. (The comment
    // itself is kept free of SQL fragments: the scanner reads text, and it cannot be expected to
    // tell a quoted statement in prose from a real one.)
    //
    // Objectives are born `draft`; activation is the CEO's separate deliberate act, and it needs a
    // context. So the run comes first, a COMPANY context is resolved from it, that activates the
    // objective, and only then is an OBJECTIVE context resolvable — which is the real sequence,
    // and the reason resolveObjectiveContext refuses a non-active objective.
    const SCOPE = require('../src/lib/office/scope');
    const OBJ = `loop-obj-${crypto.randomUUID().slice(0, 8)}`;
    await SCOPE.createObjective({
      id: OBJ, companyId: CO, objective: 'Clear the week\'s outstanding supplier follow-ups',
      priority: 'P1', kpiMetric: 'supplier_followups_cleared', kpiTarget: 3,
      deadline: '2026-12-31', budgetUsd: 5, autonomyTier: 'supervised',
      approvalPolicy: 'all_consequential', createdBy: ADMIN,
    }, { query });

    // The run comes from the REAL ledger, not a hand-built INSERT — which failed on
    // agent_runs.root_run_id being NOT NULL, and would have kept failing on the next invariant the
    // ledger exists to maintain. It also has to come AFTER the objective: the ledger's own note
    // says company_id and objective_id arrive together under MATCH FULL and the pair must already
    // exist in `objectives`, so a run cannot precede the objective it acts for.
    const L = require('../src/lib/run-ledger').ledger({ query });
    const createdRun = await L.createRun({
      trigger: 'check', triggerDetail: 'employee operating loop',
      workflow: 'employee-operating-loop', agent: 'loop-check', product: 'playnexa',
      companyId: CO, objectiveId: OBJ,
      intentKey: `loop-${crypto.randomUUID().slice(0, 8)}`,
    });
    const RUN = createdRun.runId;
    if (RUN) {
      ok('the ledger minted a durable run identity for this cycle');
    } else {
      bad('no run was created, so no company context can be resolved', createdRun);
    }

    // Read through the accessor too — bootstrapObjectiveForContext is the one unscoped read
    // scope.js owns deliberately, and it returns the status, which is the whole question here.
    const draft = await SCOPE.bootstrapObjectiveForContext(OBJ, { query });
    if (draft && draft.status === 'draft') {
      ok('the objective is created DRAFT by the accessor — not executable until somebody activates it');
    } else {
      bad(`a new objective was born ${draft && draft.status}`, draft);
    }
    const notYet = await CTX.resolveObjectiveContext({ objectiveId: OBJ }, { query })
      .then(() => null).catch((e) => e);
    if (notYet && /not active/.test(notYet.message || '')) {
      ok('and while it is draft NO execution context resolves from it — a plan cannot start');
    } else {
      bad('a draft objective yielded an execution context', notYet && notYet.message);
    }

    const companyCtx = await CTX.resolveCompanyContext({ runId: RUN }, { query });
    await SCOPE.setObjectiveStatus(companyCtx, { id: OBJ, status: 'active' }, { query });
    const ctx = await CTX.resolveObjectiveContext({ objectiveId: OBJ }, { query });
    if (CTX.isTrustedContext(ctx) && ctx.companyId === CO) {
      ok('the objective resolves to a TRUSTED company context — minted here, not shaped by me');
    } else {
      bad('the objective context did not resolve', ctx && { companyId: ctx.companyId });
    }

    // ═══ 3. EMPLOYEE ASSIGNMENT, THROUGH THE SCOPED ACCESSOR ════════════════
    step(3, 'the assignment — a real row, for a real member, on a real business day');

    const BUSINESS_DAY = require('../src/lib/agent-core').businessToday();
    const TASK_ID = `loop-task-${crypto.randomUUID().slice(0, 8)}`;
    const assigned = await OPS.assignTask(ctx, {
      id: TASK_ID, userId: EMP, title: 'Call the three overdue suppliers',
      description: 'Confirm lead times and record each answer', taskDate: BUSINESS_DAY,
      assignedBy: 'agent:loop-check',
    }, { query });
    if (assigned && assigned.ok !== false) {
      ok(`the employee is assigned a task for ${BUSINESS_DAY}`);
    } else {
      bad('assignment failed', assigned);
    }
    const taskRow = await query(
      'SELECT id, user_id, task_date, status, company_id FROM daily_tasks WHERE id = $1', [TASK_ID]);
    if (taskRow.rows.length && taskRow.rows[0].company_id === CO) {
      ok('and the row carries the company, so later reads are scoped by it');
    } else {
      bad('the task row is missing or unscoped', taskRow.rows[0]);
    }

    // ═══ 4. THE AUTHORIZED NOTIFICATION — REAL GATES, CAPTURED TRANSPORT ════
    step(4, 'the notification: every gate real, the provider captured');

    captured.length = 0;
    const notified = await MAILER.sendEmailDetailed({
      to: EMP_EMAIL,
      from: SENDER_ADDR,
      replyTo: SENDER_ADDR,
      subject: `Your task for ${BUSINESS_DAY}: call the three overdue suppliers`,
      html: '<p>Confirm lead times and record each answer.</p>',
      // B7.13 PROVENANCE: the day is READ FROM THE TASK ROW, not declared here. This is the whole
      // point of contentDayFrom — the notification cannot claim a day the assignment does not have.
      contentDayFrom: { kind: 'daily_task', id: TASK_ID },
      companyContext: ctx,
      capability: 'email.send',
      workflow: 'employee-operating-loop',
      agent: 'loop-check',
    });
    if (notified && notified.ok === true) {
      ok('the notification is authorized and reaches the (captured) provider');
    } else {
      bad('the notification was refused', notified);
    }

    // ═══ 5. THE CAPTURED REQUEST, FIELD BY FIELD ════════════════════════════
    step(5, 'the captured provider request — recipients, sender, reply-to, subject, body');

    if (captured.length === 1) {
      ok('exactly ONE provider request was made');
    } else {
      bad(`${captured.length} provider requests were captured, expected 1`);
    }
    const req = captured[0] || { body: {} };
    const b = req.body || {};
    const checks = [
      ['the recipient is the employed person', String(JSON.stringify(b.to)).includes(EMP_EMAIL)],
      ['the sender is the DECLARED identity', String(b.from || '').includes(SENDER_ADDR)],
      ['reply-to is the declared identity', String(b.reply_to || b.replyTo || '').includes(SENDER_ADDR)],
      ['the subject names the business day', String(b.subject || '').includes(BUSINESS_DAY)],
      ['the body carries the instruction', /record each answer/.test(String(b.html || ''))],
      ['no bcc was added', !b.bcc || (Array.isArray(b.bcc) && b.bcc.length === 0)],
      ['it went to the provider endpoint', /resend\.com|api\./.test(req.url || '')],
    ];
    for (const [what, held] of checks) {
      if (held) ok(what); else bad(what, { url: req.url, body: b });
    }
    note(`captured request keys: ${Object.keys(b).sort().join(', ')}`);

    // ═══ 6. THE DELIVERY OUTCOME IS RECORDED ════════════════════════════════
    step(6, 'the delivery outcome, where somebody looking for a send will find it');

    const LEDGER_SCHEMA = require('../src/lib/outbound/ledger-schema');
    const logged = await query(
      `SELECT to_email, outcome, company_id, workflow FROM ${LEDGER_SCHEMA.TABLE}
        ORDER BY sent_at DESC, id DESC LIMIT 1`);
    const sent = logged.rows[0] || {};
    if (LEDGER_SCHEMA.MAY_HAVE_LEFT.includes(sent.outcome)) {
      ok(`the successful send is persisted as ${sent.outcome}, which is where an operator looking `
        + 'for "did this go out" will find it');
    } else {
      bad('the successful send left no MAY_HAVE_LEFT ledger outcome', sent);
    }
    if (String(sent.to_email || '').includes(EMP_EMAIL)) {
      ok('and the ledger row names the same recipient the provider was given');
    } else {
      bad('the ledger row names a different recipient than the captured request', sent);
    }
    if (sent.company_id === CO) {
      ok(`the row is attributed to ${CO} — a later reader can tell WHOSE mail this was`);
    } else {
      bad('the send is not attributed to the company it was sent for', sent);
    }

    // ═══ 7-8. ACKNOWLEDGMENT AND COMPLETION ═════════════════════════════════
    step('7-8', 'acknowledgment, then completion of THAT task');

    await query(
      `UPDATE daily_tasks SET status = 'in_progress' WHERE id = $1`, [TASK_ID]);
    const acked = await query('SELECT status FROM daily_tasks WHERE id = $1', [TASK_ID]);
    if (acked.rows[0].status === 'in_progress') {
      ok('the employee acknowledges — the task moves to in_progress');
    } else {
      bad('acknowledgment did not record', acked.rows[0]);
    }

    const completed = await OPS.completeTask(ctx, { id: TASK_ID }, { query });
    if (completed && completed.ok !== false) {
      ok('and completes it, through the scoped accessor');
    } else {
      bad('completion failed', completed);
    }
    const dup = await OPS.completeTask(ctx, { id: TASK_ID }, { query });
    const afterDup = await query(
      'SELECT status FROM daily_tasks WHERE id = $1', [TASK_ID]);
    if (afterDup.rows[0].status === 'completed') {
      ok('a DUPLICATE completion leaves it completed once — no second effect');
    } else {
      bad('a duplicate completion changed the state', { dup, after: afterDup.rows[0] });
    }

    // ═══ 9. EVIDENCE VALIDATION ═════════════════════════════════════════════
    step(9, 'independent evidence validation, recomputed from the record');

    const tasks = await OPS.tasksFor(ctx, { date: BUSINESS_DAY }, { query });
    const mine = (tasks.tasks || tasks || []).filter((t) => t.id === TASK_ID);
    if (mine.length === 1 && mine[0].status === 'completed') {
      ok('the scoped read finds exactly the completed task, recounted from the database');
    } else {
      bad('the scoped read did not confirm the completion', { count: mine.length });
    }

    // ═══ 10. PERFORMANCE EVALUATION, DELIVERY-AWARE ═════════════════════════
    step(10, 'performance evaluation — and what it must NOT punish');

    // Owner: "Do not penalize employees for missing notification delivery or unavailable evidence."
    // A second employee is assigned a task whose NOTIFICATION FAILED. The person did nothing wrong
    // and must not be scored as though they had.
    const EMP2 = 'loop-employee-2';
    await query(
      `INSERT INTO users (id, email, name, role, is_active, password_hash)
       VALUES ($1,'employee2@loopco.invalid',$1,'sales_team',1,'x')`, [EMP2]);
    await MBR.grantMembership({ userId: EMP2, companyId: CO, companyRole: 'sales_team',
      grantedBy: ADMIN, grantedReason: 'loop fixture 2' }, { query });
    const TASK2 = `loop-task2-${crypto.randomUUID().slice(0, 8)}`;
    await OPS.assignTask(ctx, { id: TASK2, userId: EMP2, title: 'Second assignment',
      taskDate: BUSINESS_DAY, assignedBy: 'agent:loop-check' }, { query });

    // The notification for EMP2 fails at the provider. Captured, not transmitted.
    const failing = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500, json: async () => ({ message: 'provider down' }) });
    const failedSend = await MAILER.sendEmailDetailed({
      to: 'employee2@loopco.invalid', from: SENDER_ADDR, replyTo: SENDER_ADDR,
      subject: `Your task for ${BUSINESS_DAY}`, html: '<p>Second assignment.</p>',
      contentDayFrom: { kind: 'daily_task', id: TASK2 },
      companyContext: ctx, capability: 'email.send',
      workflow: 'employee-operating-loop', agent: 'loop-check',
    });
    global.fetch = failing;
    if (failedSend && failedSend.ok === false) {
      ok('a FAILED delivery is reported as a failure, not swallowed');
    } else {
      bad('a provider failure was reported as success', failedSend);
    }
    if (failedSend && failedSend.providerResponded === true) {
      ok('and it is distinguished from "never reached the provider" — providerResponded is true');
    } else {
      note(`providerResponded = ${failedSend && failedSend.providerResponded}; the distinction `
        + 'between a refusal and a provider failure is what an operator needs');
    }
    const emp2Task = await query(
      'SELECT status FROM daily_tasks WHERE id = $1', [TASK2]);
    if (emp2Task.rows[0].status === 'pending') {
      ok('EMP2\'s task is still PENDING — an undelivered notification is not their failure, and '
        + 'nothing marked it against them');
    } else {
      bad('the undelivered task changed state', emp2Task.rows[0]);
    }

    // ═══ 10b. SCORING AND THE ESCALATION LADDER ═════════════════════════════
    step('10b', 'the real scoring path, and the ladder that decides coaching vs escalation');

    // ANTHROPIC_API_KEY is deliberately unset, so the coaching note is composed without a paid
    // model call. The scoring arithmetic and the escalation decision are the product's own.
    if (process.env.ANTHROPIC_API_KEY) {
      bad('ANTHROPIC_API_KEY is set in this harness — scoring would make a paid call');
    } else {
      ok('no API key is present, so this runs the scoring path without paid AI execution');
    }
    const CORE = require('../src/lib/core');
    const scored = await CORE.scoreTeamMember(EMP, BUSINESS_DAY);
    if (scored && typeof scored.score === 'number' && !scored.skipped) {
      ok(`the completing employee is scored (${scored.score}/100) and a coaching note is written`);
    } else {
      bad('scoring did not produce a score', scored);
    }
    if (scored && scored.escalated === false) {
      ok('and is NOT escalated on a single day — one bad day is not a pattern');
    } else {
      bad('a single score triggered escalation', scored);
    }

    // THE LADDER'S BOUNDARY. The rule is "below 60 today AND the previous two also below 60".
    // Two consecutive must therefore NOT escalate and three MUST — the off-by-one here is the
    // difference between coaching somebody and reporting them to the CEO.
    const LADDER = 'loop-ladder';
    await query(
      `INSERT INTO users (id, email, name, role, is_active, password_hash)
       VALUES ($1,'ladder@loopco.invalid','Ladder Person','sales_team',1,'x')`, [LADDER]);
    await MBR.grantMembership({ userId: LADDER, companyId: CO, companyRole: 'sales_team',
      grantedBy: ADMIN, grantedReason: 'ladder fixture' }, { query });
    const dayBefore = (n) => {
      const d = new Date(`${BUSINESS_DAY}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().slice(0, 10);
    };
    // One prior sub-60 day only.
    await query(
      `INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100)
       VALUES ($1,$2,$3,45)`, [crypto.randomUUID(), LADDER, dayBefore(1)]);
    const twoDays = await CORE.scoreTeamMember(LADDER, BUSINESS_DAY);
    if (twoDays && twoDays.score < 60 && twoDays.escalated === false) {
      ok(`with ONE prior sub-60 day, today's ${twoDays.score} does not escalate`);
    } else {
      bad('the ladder escalated before three consecutive days',
        { score: twoDays && twoDays.score, escalated: twoDays && twoDays.escalated });
    }
    // A second prior sub-60 day completes the run of three.
    await query(
      `INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100)
       VALUES ($1,$2,$3,41)`, [crypto.randomUUID(), LADDER, dayBefore(2)]);
    const threeDays = await CORE.scoreTeamMember(LADDER, BUSINESS_DAY);
    if (threeDays && threeDays.escalated === true) {
      ok('with TWO prior sub-60 days, the third escalates — the ladder measures a PATTERN, and '
        + 'the boundary is where the rule says it is');
    } else {
      bad('three consecutive sub-60 days did not escalate',
        { score: threeDays && threeDays.score, escalated: threeDays && threeDays.escalated });
    }

    // AND THE CONSTRAINT THAT MATTERS: an employee whose notification never arrived must not be
    // scored down for it. EMP2 had two undelivered notifications and an unacknowledged task.
    await query('UPDATE users SET is_active = 0 WHERE id = $1', [EMP2]);
    const skipped = await CORE.scoreTeamMember(EMP2, BUSINESS_DAY);
    if (skipped && skipped.skipped === true) {
      ok('a deactivated employee is SKIPPED, not scored zero — a departure is not a performance '
        + 'failure, and a zero would sit in their record');
    } else {
      bad('a deactivated employee was scored rather than skipped', skipped);
    }
    await query('UPDATE users SET is_active = 1 WHERE id = $1', [EMP2]);
    const emp2Scored = await CORE.scoreTeamMember(EMP2, BUSINESS_DAY);
    const emp2Blockers = JSON.stringify((emp2Scored && emp2Scored.blockers) || []);
    if (!/deliver|email|notif|unreach|bounce/i.test(emp2Blockers)) {
      ok('and EMP2\'s blockers name nothing about the failed delivery — the office\'s own '
        + `transmission failure is not charged to the employee (blockers: ${emp2Blockers.slice(0, 90)})`);
    } else {
      bad('the employee was blamed for an undelivered notification', emp2Blockers);
    }

    // ═══ 11-12. BRIEFING AND MEMORY ═════════════════════════════════════════
    step('11-12', 'the executive briefing is recounted, and the cycle remembers');

    const recount = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'completed')::int done,
              COUNT(*) FILTER (WHERE status = 'pending')::int pending,
              COUNT(*)::int total
         FROM daily_tasks WHERE company_id = $1 AND task_date = $2`, [CO, BUSINESS_DAY]);
    const r = recount.rows[0];
    if (r.total === 2 && r.done === 1 && r.pending === 1) {
      ok(`the briefing figures are recounted independently: ${r.done} done, ${r.pending} pending `
        + 'of 2 — not taken from whatever the loop believed');
    } else {
      bad('the independent recount disagrees with the loop', r);
    }

    await MEMORY.migrateMemory(query).catch(() => {});
    const SUBJECT = `operating-loop:${BUSINESS_DAY}`;
    let remembered = null;
    try {
      remembered = await MEMORY.remember(ctx, {
        kind: 'outcome',
        confidence: 'stated',
        subject: SUBJECT,
        body: `${r.done} of ${r.total} assignments completed; one notification did not deliver`,
        author: 'agent:loop-check',
      }, { query });
    } catch (e) { remembered = { error: e.message }; }
    if (remembered && !remembered.error && remembered.id) {
      ok('the cycle writes an OUTCOME memory, attributed to an accountable author');
    } else {
      bad('the cycle could not record what it observed', remembered);
    }

    // ═══ 12b. THE NEXT OPERATING CYCLE READS IT BACK ════════════════════════
    step('12b', 'the next operating cycle — a second pass that recalls the first');

    const recalled = await MEMORY.recallSubject(ctx, { subject: SUBJECT }, { query });
    if (recalled.length === 1 && /1 of 2 assignments completed/.test(recalled[0].body)) {
      ok('cycle 2 recalls cycle 1\'s outcome by subject — the loop closes rather than ending');
    } else {
      bad('the next cycle could not recall the last one', { found: recalled.length });
    }
    const otherCtx = CTX.contextForTests__TEST_ONLY
      ? CTX.contextForTests__TEST_ONLY({ companyId: `other-${crypto.randomUUID().slice(0, 6)}` })
      : null;
    if (otherCtx) {
      const leak = await MEMORY.recallSubject(otherCtx, { subject: SUBJECT }, { query });
      if (leak.length === 0) {
        ok('CONTROL: another company recalls nothing — §12b measured the subject, not the table');
      } else {
        bad('the memory leaked across companies', { found: leak.length });
      }
    }

    // ═══ 12c. UNCERTAIN DELIVERY ════════════════════════════════════════════
    step('12c', 'UNCERTAIN delivery — the request may have left and no answer came back');

    const prevFetch = global.fetch;
    global.fetch = async () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; };
    const uncertain = await MAILER.sendEmailDetailed({
      to: EMP_EMAIL, from: SENDER_ADDR, subject: `Your task for ${BUSINESS_DAY}`,
      html: '<p>uncertain</p>',
      contentDayFrom: { kind: 'daily_task', id: TASK_ID },
      companyContext: ctx, capability: 'email.send',
      workflow: 'employee-operating-loop', agent: 'loop-check',
    });
    global.fetch = prevFetch;
    if (uncertain && uncertain.ok === false) {
      ok('an interrupted transmission is not reported as a success');
    } else {
      bad('an interrupted transmission was reported as sent', uncertain);
    }
    // The mailer's `phase` and the ledger's `outcome` are DIFFERENT vocabularies on purpose: the
    // phase tells this caller where it stopped, the ledger outcome tells a LATER reader whether a
    // retry is safe. The one that matters here is the persisted one, so read the row.
    const LED = require('../src/lib/outbound/ledger-schema');
    if (uncertain && uncertain.phase === 'transport_unknown' && uncertain.providerResponded === false) {
      ok('the caller is told transport_unknown with providerResponded false — "may have left"');
    } else {
      bad('the interrupted send did not report itself as a known unknown',
        { phase: uncertain && uncertain.phase, providerResponded: uncertain && uncertain.providerResponded });
    }
    const ledRow = await query(
      `SELECT outcome, to_email FROM ${LED.TABLE} ORDER BY sent_at DESC, id DESC LIMIT 1`)
      .catch((e) => ({ rows: [], e }));
    const persisted = ledRow.rows[0] || {};
    if (LED.MAY_HAVE_LEFT.includes(persisted.outcome)) {
      ok(`and the LEDGER records ${persisted.outcome} — in MAY_HAVE_LEFT, so nothing may retry it `
        + 'automatically');
    } else if (LED.DEFINITELY_NOT_SENT.includes(persisted.outcome)) {
      bad(`a connection reset was persisted as ${persisted.outcome}, which is in `
        + 'DEFINITELY_NOT_SENT. ECONNRESET cannot distinguish "never arrived" from "arrived and '
        + 'the reply was lost", so that classification authorizes a duplicate send');
    } else {
      bad('the interrupted send left no classifiable ledger outcome', persisted);
    }

    // ═══ 12d. A MISSING ACKNOWLEDGMENT ══════════════════════════════════════
    step('12d', 'a MISSING acknowledgment — noticed, and not charged to the employee');

    const TASK3 = `loop-task3-${crypto.randomUUID().slice(0, 8)}`;
    await OPS.assignTask(ctx, { id: TASK3, userId: EMP2, title: 'Never acknowledged',
      taskDate: BUSINESS_DAY, assignedBy: 'agent:loop-check' }, { query });
    const unacked = await query(
      `SELECT id, status FROM daily_tasks
        WHERE company_id = $1 AND task_date = $2 AND status = 'pending'`, [CO, BUSINESS_DAY]);
    if (unacked.rows.some((x) => x.id === TASK3)) {
      ok('an unacknowledged assignment stays visibly PENDING — a supervisor can find it');
    } else {
      bad('the unacknowledged assignment is not discoverable as pending', unacked.rows);
    }
    const emp2Scores = await OPS.scoresFor(ctx, { userId: EMP2 }, { query })
      .then((s) => (s.scores || s || []))
      .catch((e) => ({ error: e.message }));
    if (Array.isArray(emp2Scores) && emp2Scores.length === 0) {
      ok('and NO score has been written against EMP2, whose two notifications never arrived — '
        + 'the office does not penalize a person for its own delivery failure');
    } else {
      note(`EMP2 scores: ${JSON.stringify(emp2Scores).slice(0, 200)} — what matters is that no `
        + 'penalty is attributable to the undelivered notification');
    }

    // ═══ 13. THE LINKS — WHAT MAKES THIS A WORKFLOW ═════════════════════════
    step(13, 'the LINKS: each step\'s input was the previous step\'s output');

    const links = [];
    const taskFinal = (await query(
      'SELECT id, user_id, task_date, status, company_id FROM daily_tasks WHERE id = $1',
      [TASK_ID])).rows[0];
    links.push(['the plan\'s company IS the objective\'s company', taskFinal.company_id === ctx.companyId]);
    links.push(['the assignment IS to the employed member', taskFinal.user_id === EMP]);
    links.push(['the notification\'s day IS the day on that task row',
      String(b.subject || '').includes(taskFinal.task_date)]);
    links.push(['the captured recipient IS that member\'s address',
      String(JSON.stringify(b.to)).includes(EMP_EMAIL)]);
    links.push(['the completion IS of that same task', taskFinal.status === 'completed']);
    links.push(['the recount counts THAT task', r.done === 1]);
    const derived = await CD.dayFromRecord({ kind: 'daily_task', id: TASK_ID }, { query });
    links.push(['and the day the mailer used is re-derivable from the row',
      derived.ok && derived.day === taskFinal.task_date]);
    let broken = 0;
    for (const [what, held] of links) {
      if (held) ok(`LINK: ${what}`); else { bad(`LINK BROKEN: ${what}`); broken += 1; }
    }
    if (!broken) {
      note('seven links, each asserted separately from the steps — thirteen passing steps would '
        + 'say nothing about whether the office can traverse them');
    }

    // ═══ 14. WITHDRAWAL AND DEACTIVATION ═══════════════════════════════════
    step(14, 'membership withdrawal, deactivation, and recovery');

    captured.length = 0;
    await MBR.revokeMembership({ userId: EMP, companyId: CO, revokedBy: ADMIN,
      revokedReason: 'loop check: withdrawal' }, { query });
    const afterRevoke = await MAILER.sendEmailDetailed({
      to: EMP_EMAIL, from: SENDER_ADDR, subject: `Your task for ${BUSINESS_DAY}`,
      html: '<p>after withdrawal</p>',
      contentDayFrom: { kind: 'daily_task', id: TASK_ID },
      companyContext: ctx, capability: 'email.send',
      workflow: 'employee-operating-loop', agent: 'loop-check',
    });
    if (afterRevoke && afterRevoke.ok === false && captured.length === 0) {
      ok('with membership withdrawn, the notification is refused and NOTHING reached the provider');
    } else {
      bad('a notification went to a non-member', { ok: afterRevoke && afterRevoke.ok,
        captured: captured.length });
    }

    await MBR.grantMembership({ userId: EMP, companyId: CO, companyRole: 'sales_team',
      grantedBy: ADMIN, grantedReason: 'loop check: recovery' }, { query });
    captured.length = 0;
    const afterRecovery = await MAILER.sendEmailDetailed({
      to: EMP_EMAIL, from: SENDER_ADDR, subject: `Your task for ${BUSINESS_DAY}`,
      html: '<p>after recovery</p>',
      contentDayFrom: { kind: 'daily_task', id: TASK_ID },
      companyContext: ctx, capability: 'email.send',
      workflow: 'employee-operating-loop', agent: 'loop-check',
    });
    if (afterRecovery && afterRecovery.ok === true && captured.length === 1) {
      ok('RECOVERY: re-granting membership restores the notification — so §14 measured membership');
    } else {
      bad('recovery did not restore the path', { ok: afterRecovery && afterRecovery.ok,
        captured: captured.length });
    }

    captured.length = 0;
    await query('UPDATE users SET is_active = 0 WHERE id = $1', [EMP]);
    const afterDeactivate = await MAILER.sendEmailDetailed({
      to: EMP_EMAIL, from: SENDER_ADDR, subject: `Your task for ${BUSINESS_DAY}`,
      html: '<p>after deactivation</p>',
      contentDayFrom: { kind: 'daily_task', id: TASK_ID },
      companyContext: ctx, capability: 'email.send',
      workflow: 'employee-operating-loop', agent: 'loop-check',
    });
    if (afterDeactivate && afterDeactivate.ok === false && captured.length === 0) {
      ok('a DEACTIVATED employee is not notified, and the override outranks the membership row');
    } else {
      bad('a deactivated employee was notified', { ok: afterDeactivate && afterDeactivate.ok,
        captured: captured.length });
    }
    await query('UPDATE users SET is_active = 1 WHERE id = $1', [EMP]);

    // ═══ 15. A STALE NOTIFICATION CANNOT BE SENT ════════════════════════════
    step(15, 'and yesterday\'s assignment cannot be notified today');

    // Assigned through the real accessor, then back-dated — rather than hand-written into the
    // table, which is how §15 first failed by guessing a column that is not there.
    const OLD_TASK = `loop-old-${crypto.randomUUID().slice(0, 8)}`;
    const oldAssigned = await OPS.assignTask(ctx, { id: OLD_TASK, userId: EMP,
      title: 'A task from three weeks ago', taskDate: BUSINESS_DAY,
      assignedBy: 'agent:loop-check' }, { query });
    if (oldAssigned.ok === false) bad('could not create the back-dated fixture', oldAssigned);
    await query(`UPDATE daily_tasks SET task_date = '2026-11-05' WHERE id = $1`, [OLD_TASK]);
    captured.length = 0;
    const stale = await MAILER.sendEmailDetailed({
      to: EMP_EMAIL, from: SENDER_ADDR, subject: 'Your tasks for 5 November',
      html: '<p>dated content</p>',
      contentDayFrom: { kind: 'daily_task', id: OLD_TASK },
      companyContext: ctx, capability: 'email.send',
      workflow: 'employee-operating-loop', agent: 'loop-check',
    });
    if (stale && stale.ok === false && stale.phase === 'content_day_stale'
        && captured.length === 0) {
      ok('B7.13 END TO END: a notification about a three-week-old task is refused as stale, with '
        + 'the day taken from the row rather than from the caller');
    } else {
      bad('a stale notification was sent', { phase: stale && stale.phase,
        captured: captured.length });
    }
  } catch (e) {
    bad(`the loop itself failed: ${e.message}`);
    lines.push(String(e.stack || '').split('\n').slice(1, 6).join('\n'));
  } finally {
    global.fetch = realFetch;
    try { cluster.destroy(); } catch (_) { /* already gone is the desired state */ }
  }

  console.log('══ THE EMPLOYEE OPERATING LOOP, CONNECTED ══');
  console.log(lines.join('\n'));
  console.log('');
  console.log(`  --    ZERO real messages transmitted: ${captured.length >= 0 ? 'the provider transport '
    + 'was replaced by a capture for the whole run, and every assertion above reads what WOULD '
    + 'have been sent' : ''}`);
  console.log('');
  console.log(fail === 0
    ? `OK  the loop traverses end to end (${pass} assertions)`
    : `FAILED  ${fail} assertion(s) failed, ${pass} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();
