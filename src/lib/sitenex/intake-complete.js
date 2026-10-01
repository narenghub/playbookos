// ── INTAKE COMPLETION: close the link, create the developer's task ─────────────
//
// Called when intake is marked complete — by the client from the tokenised link, or by staff from the
// deal page. One transaction, and everything in it is derived from what is ALREADY in the database.
//
// ── THE TASK MUST NOT DEPEND ON THE BRIEF ────────────────────────────────────
//
// This is the one property worth stating twice. The task is created HERE, from the raw intake: the
// client's contact details, what they answered, what they uploaded, and a link to the project. The
// LLM brief (intake-brief.js) is generated afterwards, in the background, and APPENDS a section to a
// description that was already complete. So:
//
//   • the client never waits for an LLM call to be told their intake was received
//   • the client never sees a failure because the Anthropic API was slow
//   • if generation fails, the developer still has everything the client sent and can start today
//
// Appending rather than rewriting is what makes that true mechanically and not just in intent: there
// is no code path in which a failed brief leaves a task worse than one that never had a brief.
//
// ── WHO GETS THE TASK ────────────────────────────────────────────────────────
//
// sitenex_projects.assigned_to is a HUMAN DECISION. Capacity is the real constraint and no rule in
// here knows it, so there is deliberately NO assignment algorithm — not a round-robin, not
// least-loaded, not "whoever shipped last". Until a person is named, the task is "assign a developer
// to <client>" and goes to whoever can make that call.
//
// Four rules, in order, each one a real named person rather than a queue:
//   1. the project's assigned_to, if somebody has already chosen
//   2. the staff member who ISSUED the intake link — they set this client going and issuing is
//      adminOnly, so this is always staff
//   3. the deal's owner_user_id, ONLY IF they are internal
//   4. the super_admin, as a floor
//
// Rule 3 carries that condition for a reason: a deal's owner can be a PARTNER, and daily_tasks is the
// scored surface — the 8am agent reads it, coaching emails are written from it, escalation watches it.
// Putting a row in there for an external account would reintroduce scoring for partners by the back
// door, which is precisely what item 4 was built to avoid. Which rule fired is recorded on the row, so
// a task landing on the wrong desk can be explained rather than guessed at.

const crypto = require('crypto');
const { businessToday } = require('../agent-core');
const { isExternalRole } = require('../roles');
const { missingItems } = require('./intake-required');

// The queries this module runs all go through a caller-supplied function. NOT a client object with a
// .query property: `logSend(tx.query, …)` detached pg's method once already and the email sent while
// nothing was recorded. A function cannot be detached from itself.
const fn = (tx) => {
  if (typeof tx !== 'function') throw new Error('intake-complete: pass (sql, params) => client.query(sql, params), not the client');
  return tx;
};

async function assigneeFor(tx, dealId) {
  const q = fn(tx);

  const proj = (await q(`SELECT id, assigned_to FROM sitenex_projects WHERE deal_id = $1`, [dealId])).rows[0];
  if (proj && proj.assigned_to) return { user_id: proj.assigned_to, rule: 'project.assigned_to', assigned: true };

  const issuer = (await q(
    `SELECT issued_by FROM sitenex_intake_links
      WHERE deal_id = $1 AND issued_by IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [dealId])).rows[0];
  if (issuer && issuer.issued_by) return { user_id: issuer.issued_by, rule: 'link.issued_by', assigned: false };

  const owner = (await q(
    `SELECT u.id, u.role FROM sitenex_deals d JOIN users u ON u.id = d.owner_user_id WHERE d.id = $1`,
    [dealId])).rows[0];
  // THE CONDITION THAT MATTERS: an external owner is skipped, not assigned.
  if (owner && !isExternalRole(owner.role)) return { user_id: owner.id, rule: 'deal.owner_user_id', assigned: false };

  const sa = (await q(
    `SELECT id FROM users WHERE role = 'super_admin' AND is_active = 1 ORDER BY joined_at LIMIT 1`)).rows[0];
  if (sa) return { user_id: sa.id, rule: 'super_admin floor', assigned: false };

  return { user_id: null, rule: 'nobody — no active super_admin exists', assigned: false };
}

// What the client actually gave us, written out in full. Named items rather than counts, because
// "4 files" sends the developer to another screen to find out which four.
function rawSummary({ deal, intake, files }) {
  const fields = (intake && intake.fields && typeof intake.fields === 'object') ? intake.fields : {};
  const required = Array.isArray(intake && intake.required) ? intake.required : [];
  const lines = [];

  const contact = [deal.contact_name, deal.contact_title].filter(Boolean).join(', ');
  lines.push(`CLIENT: ${deal.company_name || 'deal #' + deal.id}`);
  if (contact) lines.push(`CONTACT: ${contact}`);
  if (deal.contact_email) lines.push(`EMAIL: ${deal.contact_email}`);
  if (deal.contact_phone) lines.push(`PHONE: ${deal.contact_phone}`);
  if (deal.client_address) lines.push(`ADDRESS: ${deal.client_address}`);
  if (deal.package_code) lines.push(`PACKAGE: ${deal.package_code}`);

  lines.push('');
  lines.push(`UPLOADS (${files.length}):`);
  if (!files.length) lines.push('  — none, which is worth a call before starting');
  for (const f of files) {
    lines.push(`  • ${f.file_name}${f.field ? ` (${f.field})` : ''} — ${Math.round(f.file_size / 1024)}KB`);
  }

  const answered = Object.keys(fields).filter(k => fields[k] != null && fields[k] !== '');
  if (answered.length) {
    lines.push('');
    lines.push('WHAT THEY TOLD US:');
    for (const k of answered) {
      const v = Array.isArray(fields[k]) ? fields[k].join(', ') : String(fields[k]);
      lines.push(`  • ${k}: ${v.length > 400 ? v.slice(0, 400) + '…' : v}`);
    }
  }

  // STILL MISSING, even though they pressed done. A client's "I'm finished" and our required list
  // disagree often enough that the developer needs to see it before the first call, not during it.
  //
  // Through missingItems, so an UPLOADED logo counts as a supplied logo. Computed here from `fields`
  // alone, this line listed items the paragraph above it had just listed as received.
  const missing = missingItems(required, fields, files);
  if (missing.length) {
    lines.push('');
    lines.push(`STILL MISSING (they marked intake complete anyway): ${missing.join(', ')}`);
  }
  return lines.join('\n');
}

// Marks the intake complete, closes the link, ensures a project row, and creates the task.
//
// IDEMPOTENT on completed_at: calling it twice does not create a second task. A client double-clicking
// "I'm finished" is the expected case, not the exception.
//
// `tx` is (sql, params) => client.query(sql, params) from withTransaction.
async function completeIntake(tx, { dealId, by = null, now = new Date() } = {}) {
  const q = fn(tx);

  const deal = (await q(
    `SELECT id, company_name, contact_name, contact_title, contact_email, contact_phone,
            client_address, package_code, partner_id, owner_user_id, status
       FROM sitenex_deals WHERE id = $1 FOR UPDATE`, [dealId])).rows[0];
  if (!deal) return { ok: false, code: 'no_deal', message: 'That deal no longer exists.' };

  const existing = (await q(
    `SELECT id, fields, required, completed_at FROM sitenex_intake WHERE deal_id = $1 FOR UPDATE`,
    [dealId])).rows[0];
  if (existing && existing.completed_at) {
    return { ok: true, already: true, completed_at: existing.completed_at,
             message: 'Thank you — we already have everything. There is nothing more to do.' };
  }

  const intake = existing || (await q(
    `INSERT INTO sitenex_intake (deal_id, fields, required) VALUES ($1, '{}'::jsonb, '[]'::jsonb)
     RETURNING id, fields, required, completed_at`, [dealId])).rows[0];

  await q(`UPDATE sitenex_intake SET completed_at = $2 WHERE deal_id = $1`, [dealId, now]);

  // THE LINK CLOSES. There is no reason for a live upload endpoint during the build, and leaving one
  // open is a surface that exists for no benefit. Revoked rather than deleted, so the register can
  // still show that a link existed and who issued it.
  await q(`UPDATE sitenex_intake_links SET revoked_at = $2 WHERE deal_id = $1 AND revoked_at IS NULL`,
          [dealId, now]);

  const files = (await q(
    `SELECT id, file_name, field, file_size FROM sitenex_intake_files
      WHERE deal_id = $1 ORDER BY uploaded_at`, [dealId])).rows;

  // The project. Normally created when the contract is marked executed; created here too, because an
  // intake that completed without one means somebody skipped a step and the developer still needs
  // somewhere for the brief to live.
  let project = (await q(`SELECT id, assigned_to FROM sitenex_projects WHERE deal_id = $1`, [dealId])).rows[0];
  if (!project) {
    project = (await q(
      `INSERT INTO sitenex_projects (deal_id, status, notes)
       VALUES ($1, 'queued', 'created at intake completion')
       ON CONFLICT (deal_id) DO UPDATE SET status = sitenex_projects.status
       RETURNING id, assigned_to`, [dealId])).rows[0];
  }

  const who = await assigneeFor(q, dealId);
  const client = deal.company_name || `deal #${deal.id}`;
  const title = who.assigned ? `Start build — ${client}` : `Assign a developer to ${client}`;

  const body = [
    who.assigned ? 'Intake is complete. Everything below is what the client sent.'
                 : 'Intake is complete and nobody is assigned to this build yet. Pick a developer, then set them on the project.',
    '',
    rawSummary({ deal, intake, files }),
    '',
    `PROJECT: /sitenex-deals#deal-${deal.id}`,
  ].join('\n');

  let taskId = null;
  if (who.user_id) {
    taskId = crypto.randomUUID();
    await q(
      `INSERT INTO daily_tasks (id, user_id, task_date, task_title, task_description, priority,
                                status, source_kpi, agent_name, reasoning)
       VALUES ($1, $2, $3, $4, $5, 'HIGH', 'pending', NULL, 'sitenex-intake', $6)`,
      [taskId, who.user_id, businessToday(), title, body,
       // source_kpi IS NULL ON PURPOSE. It is what the rollup scores against, and this task is a
       // handover, not a performance measure. A KPI name here would quietly change somebody's number.
       `Created when ${client} completed intake. Assignee by rule: ${who.rule}.`]);
  }

  // Move the deal along, but only forwards and only from the states where it makes sense — never
  // past 'building', so a completed intake cannot drag a live site backwards.
  if (deal.status === 'signed' || deal.status === 'intake') {
    await q(`UPDATE sitenex_deals SET status = 'building' WHERE id = $1`, [dealId]);
  }

  return { ok: true, already: false, deal_id: deal.id, project_id: project && project.id,
           task_id: taskId, assignee: who, files: files.length,
           message: 'Thank you — we have everything we need and your project is now with our build team.' };
}

module.exports = { completeIntake, assigneeFor, rawSummary };
