// ── INTAKE COMPLETION, AND THE TASK THAT DOES NOT DEPEND ON THE BRIEF ──────────
//   node --test src/lib/sitenex/intake-complete.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { completeIntake, assigneeFor, rawSummary } = require('./intake-complete');
const { generateBrief } = require('./intake-brief');

const DEAL = 41;
let DEALS, USERS, INTAKE, FILES, LINKS, PROJECTS, TASKS;

function reset() {
  USERS = [
    { id: 'u-naren', role: 'super_admin', is_active: 1, joined_at: '2024-01-01' },
    { id: 'u-pras', role: 'admin', is_active: 1, joined_at: '2024-02-01' },
    { id: 'u-dev', role: 'engineering_team', is_active: 1, joined_at: '2024-03-01' },
    // THE ACCOUNT THIS WHOLE ARRANGEMENT EXISTS TO KEEP OUT OF daily_tasks.
    { id: 'u-partner', role: 'partner', is_active: 1, joined_at: '2024-04-01' },
  ];
  DEALS = [{ id: DEAL, company_name: 'Rock Valley Machine', contact_name: 'Dolores Whitfield',
             contact_title: 'Owner', contact_email: 'dolores@rvm.test', contact_phone: '815 555 0142',
             client_address: '12 Mill Lane, Rockford, IL', package_code: 'P2', partner_id: 32,
             owner_user_id: 'u-partner', status: 'signed' }];
  INTAKE = [{ deal_id: DEAL, fields: { copy: 'We machine parts.', services: 'Turning\nMilling' },
              required: ['copy', 'services', 'logo', 'photos'], completed_at: null }];
  FILES = [{ id: 71, deal_id: DEAL, file_name: 'rvm-logo.png', field: 'logo', file_size: 4096,
             content_type: 'image/png' }];
  LINKS = [{ id: 1, deal_id: DEAL, issued_by: 'u-pras', revoked_at: null, created_at: '2026-09-20' }];
  PROJECTS = [];
  TASKS = [];
}
reset();
beforeEach(reset);

// The fake reads the SQL rather than restating the handler's behaviour, so changing a WHERE changes
// what comes back here too.
function tx(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();

  if (/FROM sitenex_deals WHERE id/i.test(s)) return { rows: DEALS.filter(d => d.id === params[0]) };
  // The brief reads the deal through a join to prospects, so it is a different query from the one above.
  if (/FROM sitenex_deals d LEFT JOIN prospects p/i.test(s)) {
    const d = DEALS.find(x => x.id === params[0]);
    return { rows: d ? [{ id: d.id, company_name: d.company_name, package_code: d.package_code,
                          client_address: d.client_address, subtype: 'machine_shop', site_url: null }] : [] };
  }
  if (/UPDATE sitenex_projects SET brief = /i.test(s)) {
    const p = PROJECTS.find(x => x.deal_id === params[0]);
    if (p) { p.brief = params[1]; p.brief_model = params[2]; p.brief_error = null; }
    return { rows: [], rowCount: p ? 1 : 0 };
  }
  if (/UPDATE sitenex_projects SET brief_error/i.test(s)) {
    const p = PROJECTS.find(x => x.deal_id === params[0]);
    if (p) p.brief_error = params[1];
    return { rows: [], rowCount: p ? 1 : 0 };
  }
  if (/FROM sitenex_intake WHERE deal_id/i.test(s)) return { rows: INTAKE.filter(i => i.deal_id === params[0]) };
  if (/INSERT INTO sitenex_intake \(/i.test(s)) {
    const row = { deal_id: params[0], fields: {}, required: [], completed_at: null };
    INTAKE.push(row); return { rows: [row] };
  }
  if (/UPDATE sitenex_intake SET completed_at/i.test(s)) {
    const i = INTAKE.find(x => x.deal_id === params[0]); if (i) i.completed_at = params[1];
    return { rows: [], rowCount: i ? 1 : 0 };
  }
  if (/UPDATE sitenex_intake_links SET revoked_at/i.test(s)) {
    let n = 0;
    for (const l of LINKS) if (l.deal_id === params[0] && !l.revoked_at) { l.revoked_at = params[1]; n++; }
    return { rows: [], rowCount: n };
  }
  if (/FROM sitenex_intake_files WHERE deal_id/i.test(s)) {
    return { rows: FILES.filter(f => f.deal_id === params[0]) };
  }
  if (/FROM sitenex_projects WHERE deal_id/i.test(s)) {
    return { rows: PROJECTS.filter(p => p.deal_id === params[0]) };
  }
  if (/INSERT INTO sitenex_projects/i.test(s)) {
    const row = { id: 300 + PROJECTS.length, deal_id: params[0], status: 'queued', assigned_to: null };
    PROJECTS.push(row); return { rows: [row] };
  }
  if (/FROM sitenex_intake_links WHERE deal_id/i.test(s) && /issued_by/i.test(s)) {
    const l = LINKS.filter(x => x.deal_id === params[0] && x.issued_by)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    return { rows: l ? [{ issued_by: l.issued_by }] : [] };
  }
  if (/FROM sitenex_deals d JOIN users u ON u\.id = d\.owner_user_id/i.test(s)) {
    const d = DEALS.find(x => x.id === params[0]);
    const u = d && USERS.find(x => x.id === d.owner_user_id);
    return { rows: u ? [{ id: u.id, role: u.role }] : [] };
  }
  if (/FROM users WHERE role = 'super_admin'/i.test(s)) {
    return { rows: USERS.filter(u => u.role === 'super_admin' && u.is_active).slice(0, 1) };
  }
  if (/INSERT INTO daily_tasks/i.test(s)) {
    TASKS.push({ id: params[0], user_id: params[1], task_date: params[2], task_title: params[3],
                 task_description: params[4], source_kpi: null, agent_name: 'sitenex-intake',
                 reasoning: params[5] });
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE sitenex_deals SET status/i.test(s)) {
    const d = DEALS.find(x => x.id === params[0]); if (d) d.status = 'building';
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE daily_tasks SET task_description = task_description \|\|/i.test(s)) {
    const t = TASKS.find(x => x.id === params[0]);
    // The handler's own WHERE guard, honoured: it will not append a second brief.
    if (t && !/── BRIEF ──/.test(t.task_description)) { t.task_description += params[1]; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
  return { rows: [] };
}
const q = (sql, params) => Promise.resolve(tx(sql, params));

// ── completion ──────────────────────────────────────────────────────────────

test('completing an intake stamps it, revokes the link, makes a project and creates ONE task', async () => {
  const r = await completeIntake(q, { dealId: DEAL });
  assert.equal(r.ok, true);
  assert.ok(INTAKE[0].completed_at, 'completed_at must be stamped');
  assert.ok(LINKS[0].revoked_at, 'the link must close — there is no reason for a live upload endpoint during the build');
  assert.equal(PROJECTS.length, 1);
  assert.equal(TASKS.length, 1);
  assert.equal(DEALS[0].status, 'building');
});

test('completing twice does not create a second task — a client WILL double-click', async () => {
  await completeIntake(q, { dealId: DEAL });
  const again = await completeIntake(q, { dealId: DEAL });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(TASKS.length, 1);
  assert.match(again.message, /already have everything/);
});

test('a completed intake cannot drag a live site backwards', async () => {
  DEALS[0].status = 'live';
  await completeIntake(q, { dealId: DEAL });
  assert.equal(DEALS[0].status, 'live', "status moves forward from signed/intake only");
});

// ── who gets it ─────────────────────────────────────────────────────────────

test('AN EXTERNAL DEAL OWNER IS SKIPPED — a partner never lands in the scored task list', async () => {
  // The whole point. daily_tasks is what the 8am agent scores and the coaching emails are written from;
  // item 4 exists so an external role is never in there, and this is the back door it would come
  // through. The fixture's owner_user_id IS a partner, so a rule that trusted it would fail here.
  const r = await completeIntake(q, { dealId: DEAL });
  assert.notEqual(r.assignee.user_id, 'u-partner');
  assert.equal(TASKS[0].user_id, 'u-pras', 'it falls to the staff member who issued the link');
  assert.equal(r.assignee.rule, 'link.issued_by');
  assert.ok(!USERS.filter(u => u.role === 'partner').some(u => TASKS.some(t => t.user_id === u.id)));
});

test('an assigned developer wins, and the task says start rather than assign', async () => {
  PROJECTS.push({ id: 300, deal_id: DEAL, assigned_to: 'u-dev' });
  const r = await completeIntake(q, { dealId: DEAL });
  assert.equal(r.assignee.user_id, 'u-dev');
  assert.equal(r.assignee.rule, 'project.assigned_to');
  assert.match(TASKS[0].task_title, /^Start build/);
});

test('with nobody assigned the task NAMES the decision rather than guessing at it', async () => {
  // There is deliberately no assignment algorithm anywhere in this feature: capacity is the constraint,
  // nothing in the database knows it, and a round-robin would produce a confident wrong answer.
  const r = await completeIntake(q, { dealId: DEAL });
  assert.equal(r.assignee.assigned, false);
  assert.equal(TASKS[0].task_title, 'Assign a developer to Rock Valley Machine');
  assert.match(TASKS[0].task_description, /nobody is assigned/);
});

test('an INTERNAL deal owner is used when no link was issued', async () => {
  LINKS = [];
  DEALS[0].owner_user_id = 'u-dev';
  const r = await completeIntake(q, { dealId: DEAL });
  assert.equal(r.assignee.rule, 'deal.owner_user_id');
  assert.equal(TASKS[0].user_id, 'u-dev');
});

test('the super_admin is the floor, never nobody', async () => {
  LINKS = [];
  DEALS[0].owner_user_id = 'u-partner';
  const r = await completeIntake(q, { dealId: DEAL });
  assert.equal(r.assignee.user_id, 'u-naren');
  assert.equal(r.assignee.rule, 'super_admin floor');
});

test('which rule fired is RECORDED, so a task on the wrong desk can be explained', async () => {
  await completeIntake(q, { dealId: DEAL });
  assert.match(TASKS[0].reasoning, /Assignee by rule: link\.issued_by/);
});

test('source_kpi is NULL — a handover is not a performance measure', async () => {
  await completeIntake(q, { dealId: DEAL });
  assert.equal(TASKS[0].source_kpi, null,
    'a KPI name here would quietly change somebody\'s score from an unauthenticated client action');
});

// ── THE TASK IS COMPLETE WITHOUT THE BRIEF ──────────────────────────────────

test('the task carries the contact, every upload, and what is still missing — before any LLM runs', async () => {
  await completeIntake(q, { dealId: DEAL });
  const d = TASKS[0].task_description;
  assert.match(d, /Dolores Whitfield/);
  assert.match(d, /dolores@rvm\.test/);
  assert.match(d, /815 555 0142/);
  assert.match(d, /rvm-logo\.png/);
  // They pressed done with two required items outstanding. The developer has to see that before the
  // first call, not during it.
  // 'logo' is NOT listed, because they uploaded one — the bug this assertion caught.
  assert.match(d, /STILL MISSING \(they marked intake complete anyway\): photos$/m);
  assert.match(d, /PROJECT: \/sitenex-deals#deal-41/);
  assert.ok(!/BRIEF/.test(d), 'no brief exists yet, and the task is already usable');
});

test('a FAILED brief leaves the task exactly as it was', async () => {
  const r = await completeIntake(q, { dealId: DEAL });
  const before = TASKS[0].task_description;
  const out = await generateBrief({ dealId: DEAL, taskId: r.task_id },
    { query: q, callClaude: async () => ({ error: 'overloaded_error' }) });
  assert.equal(out.ok, false);
  assert.equal(TASKS[0].task_description, before,
    'a failed brief must not remove, truncate or rewrite anything the client actually sent');
  assert.equal(PROJECTS[0].brief_error, 'overloaded_error', 'the failure is recorded next to what it failed to produce');
});

test('generateBrief NEVER THROWS, whatever goes wrong', async () => {
  const r = await completeIntake(q, { dealId: DEAL });
  for (const broken of [
    async () => { throw new Error('socket hang up'); },
    async () => ({ text: '' }),
    async () => ({ text: null }),
    async () => null,
  ]) {
    const out = await generateBrief({ dealId: DEAL, taskId: r.task_id }, { query: q, callClaude: broken });
    assert.equal(out.ok, false, 'a failure is returned, never raised');
  }
  // It is fired with no await from a handler that has already answered the client, so an unhandled
  // rejection here would be a process-level event — "the brief failed" must not restart the container.
  assert.ok(TASKS[0].task_description.length > 0);
});

test('a SUCCESSFUL brief is APPENDED, and the raw intake above it is untouched', async () => {
  const r = await completeIntake(q, { dealId: DEAL });
  const before = TASKS[0].task_description;
  const out = await generateBrief({ dealId: DEAL, taskId: r.task_id },
    { query: q, callClaude: async () => ({ text: '### The business\nThey machine parts.' }) });
  assert.equal(out.ok, true);
  assert.ok(TASKS[0].task_description.startsWith(before), 'append, never rewrite');
  assert.match(TASKS[0].task_description, /── BRIEF ──/);
  assert.match(TASKS[0].task_description, /They machine parts/);
  assert.equal(PROJECTS[0].brief, '### The business\nThey machine parts.');
});

test('ONE CALL PER INTAKE — a second attempt is skipped unless forced', async () => {
  const r = await completeIntake(q, { dealId: DEAL });
  let calls = 0;
  const call = async () => { calls++; return { text: 'brief ' + calls }; };
  await generateBrief({ dealId: DEAL, taskId: r.task_id }, { query: q, callClaude: call });
  await generateBrief({ dealId: DEAL, taskId: r.task_id }, { query: q, callClaude: call });
  assert.equal(calls, 1, 'two completions racing must not each pay for a brief');
  const forced = await generateBrief({ dealId: DEAL, taskId: r.task_id, force: true }, { query: q, callClaude: call });
  assert.equal(calls, 2, 'regeneration on an explicit request is the one way a second call happens');
  assert.equal(forced.ok, true);
  assert.ok(!/── BRIEF ──[\s\S]*── BRIEF ──/.test(TASKS[0].task_description),
    'and it does not staple a second brief onto the task');
});

test('a brief is not generated for an intake that is not complete', async () => {
  PROJECTS.push({ id: 300, deal_id: DEAL, assigned_to: null });
  let calls = 0;
  const out = await generateBrief({ dealId: DEAL }, { query: q, callClaude: async () => { calls++; return { text: 'x' }; } });
  assert.equal(out.ok, false);
  assert.equal(calls, 0, 'no spend on an intake nobody has finished');
});

// ── the prompt ──────────────────────────────────────────────────────────────

test('the prompt withholds the contact details and the money — a brief has no use for either', () => {
  const { promptFor } = require('./intake-brief');
  const p = promptFor({ deal: { company_name: 'Rock Valley Machine', package_code: 'P2',
                                client_address: '12 Mill Lane', subtype: 'machine_shop' },
                        intake: { fields: { copy: 'We machine parts.' }, required: ['copy', 'logo', 'photos'] },
                        files: [{ file_name: 'rvm-logo.png', content_type: 'image/png', field: 'logo' }] });
  for (const secret of ['dolores@rvm.test', '815 555 0142', 'Dolores', '1250000']) {
    assert.ok(!p.includes(secret), `the prompt must not send ${secret} to a third party — it adds nothing to a brief`);
  }
  assert.match(p, /Rock Valley Machine/);
  assert.match(p, /rvm-logo\.png/);
  // photos, and NOT logo — they uploaded a logo, and a prompt that asked the model to note a missing
  // logo while listing the logo file above it would produce a brief that argued with itself.
  assert.match(p, /Required items they did NOT supply: photos$/m);
});

test('the system prompt forbids inventing the things a brief is most tempted to invent', () => {
  const { SYSTEM } = require('./intake-brief');
  for (const word of ['budget', 'deadline', 'competitor', 'traffic', 'revenue']) {
    assert.ok(SYSTEM.toLowerCase().includes(word), `the brief must be told not to invent a ${word}`);
  }
  assert.match(SYSTEM, /never fill the gap/i);
});

// ── the summary itself ──────────────────────────────────────────────────────

test('an intake with no uploads says so, because it is worth a call before starting', () => {
  const s = rawSummary({ deal: DEALS[0], intake: INTAKE[0], files: [] });
  assert.match(s, /none, which is worth a call before starting/);
});

test('a missing deal is reported, not thrown', async () => {
  const r = await completeIntake(q, { dealId: 999 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_deal');
});

test('completeIntake refuses a client object, the way consume does', async () => {
  await assert.rejects(() => completeIntake({ query: q }, { dealId: DEAL }), /pass \(sql, params\)/);
});

// ── ONE DEFINITION OF MISSING ───────────────────────────────────────────────
//
// Added because the first version of this feature had four: a required 'logo' was computed from
// sitenex_intake.fields alone, so a client who UPLOADED their logo was told it was outstanding on a task
// that listed the file two lines above.
test('an UPLOADED item satisfies the requirement — fields are not the only way to answer', () => {
  const { missingItems } = require('./intake-required');
  assert.deepEqual(missingItems(['copy', 'logo', 'photos'], { copy: 'x' }, [{ field: 'logo' }]), ['photos']);
  assert.deepEqual(missingItems(['logo'], {}, []), ['logo']);
  assert.deepEqual(missingItems(['logo'], { logo: 'see attached' }, []), [], 'an answer also satisfies it');
  assert.deepEqual(missingItems(['copy'], { copy: '   ' }, []), ['copy'], 'whitespace is not an answer');
  assert.deepEqual(missingItems(['photos'], { photos: [] }, []), ['photos'], 'an empty list is not an answer');
  assert.deepEqual(missingItems(['logo'], {}, [{ field: null }]), ['logo'], 'an untagged upload answers nothing');
  // Shape tolerance, because these arrive from JSONB and from a Postgres array.
  assert.deepEqual(missingItems(null, null, null), []);
});

test('all four callers use it, so they cannot drift apart', () => {
  const fs = require('node:fs'), path = require('node:path');
  const ROOT = path.resolve(__dirname, '../../..');
  for (const f of ['src/lib/sitenex/intake-complete.js', 'src/lib/sitenex/intake-brief.js',
                   'src/api/sitenex-intake.routes.js', 'src/api/sitenex-phase3.routes.js',
                   'src/lib/outreach/tasks.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(/missingItems/.test(src), `${f} must compute "missing" through missingItems`);
    // The open-coded form this replaced. Banned by shape, so a copy-paste of the old filter fails here.
    assert.ok(!/\.filter\(k => (have|fields)\[k\] == null/.test(src),
      `${f} still computes "missing" itself — there must be exactly one definition`);
  }
});
