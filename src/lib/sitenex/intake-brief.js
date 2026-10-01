// ── (7) THE BRIEF AGENT — one page, from a completed intake ────────────────────
//
// A developer opening a finished intake gets a contact, a package code, a pile of uploads and whatever
// the client typed into the boxes. This turns that into a page somebody can read before their first
// call: what the business does, what it needs, what is ambiguous, and what to ask.
//
// ── ASYNCHRONOUS, AND NEITHER SYNCHRONOUS NOR A CRON ─────────────────────────
//
// Not in the request path: intake completion is a CLIENT action, and an LLM call there makes a small-
// business owner sit on a spinner and then see a failure because api.anthropic.com was slow. Nothing
// about their experience should depend on our model provider.
//
// Not a cron either: a developer should not wait until 2am to find out what they are building.
//
// So it is fired immediately AFTER the client has been answered — setImmediate from the handler, with
// no await — and attaches itself to a task that already exists.
//
// ── THE TASK DOES NOT DEPEND ON THIS FILE ────────────────────────────────────
//
// intake-complete.js writes the task from the raw intake first. This only ever APPENDS, and only on
// success. Three consequences worth being explicit about:
//
//   • every failure path here writes brief_error and returns; nothing is removed and nothing is rewritten
//   • generate() NEVER THROWS, so an unhandled rejection cannot take down the process that fired it
//     and forgot about it (callClaude already has that contract; this preserves it over the DB writes)
//   • a task with no brief is a complete task, not a broken one
//
// ── SPEND ────────────────────────────────────────────────────────────────────
//
// ONE call per completed intake. Regeneration only on explicit request, which is what `force` is for —
// so a retry is a person pressing a button, never a loop. At the current rate of completed intakes this
// is cents a month, so there is NO BUDGET FUSE here on purpose: a fuse that has never been near
// tripping is untested code in the path of something that matters, and the honest place to add one is
// when volume makes it a real question.

const { callClaude } = require('../llm');
const { missingItems } = require('./intake-required');

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1600;

const SYSTEM = `You write build briefs for a small-business website studio. Your reader is the developer who will build the site, and they will read this once before their first call with the client.

Write for somebody competent and busy. No preamble, no "I hope this helps", no restating the instructions. Use these headings exactly, as markdown H3:

### The business
### What they want
### What we have
### What is unclear
### Ask them

Rules:
- Base every statement on the intake below. If something is not there, say it is not there — under "What is unclear" or "Ask them" — and never fill the gap with a plausible guess. A fabricated detail in a brief becomes a wrong assumption in a built site.
- "Ask them" is a short list of specific questions, each one answerable in a sentence. No generic discovery questions.
- Do not invent a budget, a deadline, a competitor, or a traffic or revenue figure. None of those are in the intake.
- The client's name, email and phone are NOT below and are not missing — they are already on the task this brief is attached to, and were withheld from you because a brief has no use for them. Never list them as unclear and never ask for them.
- At most 450 words.`;

// What goes to the model, and what deliberately does not.
//
// NOT the client's email or phone: a brief has no use for them, the developer already has them on the
// task, and the least data that does the job is the right amount to send to a third party. Not the
// price, the payment schedule or the contract either — none of them describe what to build.
function promptFor({ deal, intake, files }) {
  const fields = (intake && intake.fields && typeof intake.fields === 'object') ? intake.fields : {};
  const lines = [`Business: ${deal.company_name || 'unnamed'}`];
  if (deal.package_code) lines.push(`Package: ${deal.package_code}`);
  if (deal.client_address) lines.push(`Location: ${deal.client_address}`);
  if (deal.subtype) lines.push(`Trade: ${deal.subtype}`);
  if (deal.site_url) lines.push(`Existing site: ${deal.site_url}`);

  // Stated beside the data, not only in the system prompt. The first live brief asked the developer to
  // find out "who is the main point of contact" on a task whose third line is that person's email — the
  // model correctly observed an absence that is an absence only in what we chose to send it.
  lines.push('', '(The contact name, email and phone are deliberately not included here. They are already on the task.)');
  lines.push('', 'What the client wrote in the intake form:');
  const answered = Object.keys(fields).filter(k => fields[k] != null && fields[k] !== '');
  if (!answered.length) lines.push('(they filled in nothing — only uploads)');
  for (const k of answered) {
    const v = Array.isArray(fields[k]) ? fields[k].join(', ') : String(fields[k]);
    lines.push(`- ${k}: ${v.length > 2000 ? v.slice(0, 2000) + '…' : v}`);
  }

  lines.push('', `Files they uploaded (${files.length}) — names and types only, the contents were not read:`);
  if (!files.length) lines.push('- none');
  for (const f of files) lines.push(`- ${f.file_name} (${f.content_type}${f.field ? `, for "${f.field}"` : ''})`);

  const missing = missingItems(intake && intake.required, fields, files);
  if (missing.length) lines.push('', `Required items they did NOT supply: ${missing.join(', ')}`);

  return lines.join('\n');
}

// Returns { ok, brief?, skipped?, error? }. NEVER THROWS.
async function generateBrief({ dealId, taskId = null, force = false } = {}, deps = {}) {
  const q = deps.query || require('../db').query;
  const call = deps.callClaude || callClaude;

  try {
    const project = (await q(
      `SELECT id, brief FROM sitenex_projects WHERE deal_id = $1`, [dealId])).rows[0];
    if (!project) return { ok: false, error: 'no project row for that deal' };
    // ONE CALL PER INTAKE. Without this, two completions racing — or a client double-clicking through
    // a retried request — would each pay for a brief and the second would overwrite the first.
    if (project.brief && !force) return { ok: true, skipped: 'a brief already exists' };

    const deal = (await q(
      `SELECT d.id, d.company_name, d.package_code, d.client_address,
              p.subtype, p.site_url
         FROM sitenex_deals d
         LEFT JOIN prospects p ON p.id = d.prospect_id
        WHERE d.id = $1`, [dealId])).rows[0];
    if (!deal) return { ok: false, error: 'no deal' };

    const intake = (await q(
      `SELECT fields, required, completed_at FROM sitenex_intake WHERE deal_id = $1`, [dealId])).rows[0];
    if (!intake || !intake.completed_at) return { ok: false, error: 'intake is not complete' };

    const files = (await q(
      `SELECT file_name, content_type, field FROM sitenex_intake_files
        WHERE deal_id = $1 ORDER BY uploaded_at`, [dealId])).rows;

    const r = await call({ model: MODEL, system: SYSTEM, prompt: promptFor({ deal, intake, files }),
                           maxTokens: MAX_TOKENS });
    const text = (r && r.text || '').trim();
    if (r && r.error) return await fail(q, dealId, r.error);
    if (!text) return await fail(q, dealId, 'the model returned nothing');

    await q(`UPDATE sitenex_projects
                SET brief = $2, brief_model = $3, brief_generated_at = NOW(), brief_error = NULL
              WHERE deal_id = $1`, [dealId, text, MODEL]);

    // APPEND to the task. Never a rewrite: the raw intake written at completion stays exactly as it
    // was, so the worst case for this UPDATE failing is a brief that is on the project and not yet on
    // the task — which is a missing convenience, not a missing handover.
    if (taskId) {
      await q(`UPDATE daily_tasks
                  SET task_description = task_description || $2
                WHERE id = $1 AND task_description NOT LIKE '%── BRIEF ──%'`,
              [taskId, `\n\n── BRIEF ── (generated, ${MODEL} — the intake above is the source of truth)\n\n${text}\n`]);
    }

    return { ok: true, brief: text, model: MODEL, cost_usd: r && r.costUsd || null };
  } catch (e) {
    // Including a DB error. The contract is that this never throws into a caller that has already
    // responded to the client and is not waiting for it.
    try { return await fail(deps.query || require('../db').query, dealId, e.message); }
    catch (_) { return { ok: false, error: e.message }; }
  }
}

// Record the failure where somebody will see it: next to the thing it failed to produce.
async function fail(q, dealId, message) {
  await q(`UPDATE sitenex_projects SET brief_error = $2, brief_generated_at = NOW() WHERE deal_id = $1`,
          [dealId, String(message || 'unknown error').slice(0, 500)]).catch(() => {});
  return { ok: false, error: message };
}

// Fire and forget, from a handler that has already answered the client.
//
// setImmediate rather than a bare un-awaited call so the response is flushed first, and .catch here as
// well as inside generateBrief because an unhandled rejection in a detached promise is a process-level
// event, and "the brief failed" must never be able to restart the container.
function fireBrief(args) {
  setImmediate(() => { generateBrief(args).catch(() => {}); });
}

module.exports = { generateBrief, fireBrief, promptFor, MODEL, SYSTEM };
