// MY TASKS, derived from outreach — and the things it must NOT do.
//
//   node --test src/lib/outreach/tasks.test.js
//
// The point of this source is that a partner has no KPIs, so daily_tasks is empty for them — and the fix is not
// to invent KPIs for somebody we do not manage. These assertions divide into three:
//
//   • the derivations are right (and do not double-count the same fact)
//   • the scope is the same one every other outreach read uses, and still THROWS when omitted
//   • NO SCORING, NO COACHING, NO ESCALATION — a task list that fed a score would reintroduce by the back door
//     exactly what excluding external roles from scoring was meant to prevent

const { test } = require('node:test');
const assert = require('node:assert');
const { outreachTasks, STALE_DAYS, CHASEABLE } = require('./tasks');

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY);

let OUT, DEALS, SQL;
function reset() {
  SQL = [];
  OUT = [];
  DEALS = [];
}
const out = (o) => ({ entity_type: 'prospect', product: 'sitenex', next_action_at: null,
  last_contacted_at: null, updated_at: ago(1), note: null, entity_name: null, ...o });

const query = async (sql, params = []) => {
  SQL.push(sql.replace(/\s+/g, ' ').trim());
  if (/FROM sitenex_deals/.test(sql)) {
    // The deal scope is honoured, or every partner would see every deal's intake.
    if (!/d\.partner_id = \$|WHERE TRUE|WHERE FALSE/.test(sql)) throw new Error('UNSCOPED deal read: ' + sql);
    if (/WHERE FALSE/.test(sql)) return { rows: [] };
    const m = /d\.partner_id = \$(\d+)/.exec(sql);
    const rows = m ? DEALS.filter(d => String(d.partner_id) === String(params[+m[1] - 1])) : DEALS;
    return { rows: rows.filter(d => ['signed', 'intake', 'building'].includes(d.status) && !d.completed_at) };
  }
  // The outreach read must carry BOTH scopes, like every other one.
  if (!/o\.product = ANY\(\$\d+\)/.test(sql)) throw new Error('not product-scoped: ' + sql);
  if (!/o\.partner_id = \$\d+|AND TRUE|AND FALSE/.test(sql)) throw new Error('not partner-scoped: ' + sql);
  if (/AND FALSE/.test(sql)) return { rows: [] };
  const m = /o\.partner_id = \$(\d+)/.exec(sql);
  let rows = OUT;
  if (m) rows = OUT.filter(o => String(o.partner_id) === String(params[+m[1] - 1]));
  // TERMINAL statuses are excluded in SQL, so the fake applies that too rather than letting them through.
  const terminal = params.find(p => Array.isArray(p) && p.includes('disqualified')) || [];
  return { rows: rows.filter(o => !terminal.includes(o.status)) };
};
const deps = { query };
const PA = { partnerId: 11 }, OURS = { isStaff: true };
const run = (partner = PA, opts = {}) => outreachTasks({ held: ['sitenex'], partner, ...opts }, deps);

// ── the derivations ───────────────────────────────────────────────────────────

test('OVERDUE: a next_action_at in the past is a task, with the note as the detail', async () => {
  reset();
  OUT.push(out({ entity_id: '1', partner_id: 11, status: 'contacted', entity_name: 'Acme',
                 next_action_at: ago(2), note: 'promised a quote' }));
  const r = await run();
  assert.equal(r.counts.overdue, 1);
  assert.equal(r.tasks[0].kind, 'overdue');
  assert.match(r.tasks[0].title, /Follow up Acme/);
  assert.match(r.tasks[0].detail, /You noted: promised a quote/, "their own note is the most useful detail");
  assert.equal(r.tasks[0].days_overdue, 2);
});

test('   a FUTURE next_action_at is not a task — it is a plan', async () => {
  reset();
  OUT.push(out({ entity_id: '1', partner_id: 11, status: 'in_conversation',
                 next_action_at: new Date(Date.now() + 3 * DAY) }));
  assert.equal((await run()).total, 0);
});

test('UNCHASED: contacted for STALE_DAYS or more with no follow-up', async () => {
  reset();
  OUT.push(out({ entity_id: '2', partner_id: 11, status: 'contacted', entity_name: 'Bolt Co',
                 last_contacted_at: ago(5) }));
  const r = await run();
  assert.equal(r.counts.unchased, 1);
  assert.match(r.tasks[0].title, /Chase Bolt Co/);
  assert.match(r.tasks[0].detail, /Contacted 5 days ago/);
});

test('   a RECENT contact is left alone', async () => {
  reset();
  OUT.push(out({ entity_id: '3', partner_id: 11, status: 'contacted', last_contacted_at: ago(1) }));
  assert.equal((await run()).total, 0, 'somebody who rang yesterday is not nagged today');
  // The boundary is inclusive at STALE_DAYS, so the rule reads as "3 days or more".
  reset();
  OUT.push(out({ entity_id: '3', partner_id: 11, status: 'contacted', last_contacted_at: ago(STALE_DAYS) }));
  assert.equal((await run()).counts.unchased, 1);
});

test('   measured from the CONTACT, not from updated_at', async () => {
  // Otherwise a row could be kept "fresh" by editing its note, and the chase would never surface.
  reset();
  OUT.push(out({ entity_id: '4', partner_id: 11, status: 'contacted',
                 last_contacted_at: ago(9), updated_at: ago(0) }));
  const r = await run();
  assert.equal(r.counts.unchased, 1, 'a note edited today does not reset the clock');
  assert.match(r.tasks[0].detail, /9 days ago/);
});

test('   only CHASEABLE statuses are chased', async () => {
  // 'following_up' IS the chase, and nagging about a lost deal is how a task list gets ignored wholesale.
  assert.deepEqual(CHASEABLE, ['contacted']);
  for (const status of ['following_up', 'in_conversation', 'quote_sent', 'contract_sent']) {
    reset();
    OUT.push(out({ entity_id: '5', partner_id: 11, status, last_contacted_at: ago(30) }));
    assert.equal((await run()).counts.unchased, 0, `${status} must not be chased`);
  }
});

test('   and TERMINAL statuses are excluded in SQL, not in JS', async () => {
  // Filtering them client-side would mean fetching every lost deal on every page load.
  reset();
  OUT.push(out({ entity_id: '6', partner_id: 11, status: 'won', last_contacted_at: ago(30) }));
  OUT.push(out({ entity_id: '7', partner_id: 11, status: 'disqualified', next_action_at: ago(5) }));
  assert.equal((await run()).total, 0);
  assert.ok(SQL.some(s => /o\.status <> ALL\(\$\d+\)/.test(s)), 'the exclusion must be in the query');
});

test('ONE FACT, ONE TASK — an overdue action is not also listed as unchased', async () => {
  reset();
  OUT.push(out({ entity_id: '8', partner_id: 11, status: 'contacted', entity_name: 'Both Co',
                 next_action_at: ago(2), last_contacted_at: ago(20) }));
  const r = await run();
  assert.equal(r.total, 1, 'the same row must not produce two tasks');
  assert.equal(r.tasks[0].kind, 'overdue', 'and the stronger statement wins');
});

test('INTAKE: an unfinished intake on their OWN deal, naming what is missing', async () => {
  reset();
  DEALS.push({ id: 7, partner_id: 11, company_name: 'Signed Client Ltd', status: 'intake',
               updated_at: ago(6), completed_at: null, fields: { logo: 'x' },
               required: ['logo', 'copy', 'photos'] });
  const r = await run();
  assert.equal(r.counts.intake, 1);
  assert.match(r.tasks[0].title, /Intake outstanding — Signed Client Ltd/);
  assert.match(r.tasks[0].detail, /Still needed: copy, photos/,
    '"2 items outstanding" sends somebody to another screen to find out which');
});

test("   an intake with everything in says MARK IT COMPLETE", async () => {
  reset();
  DEALS.push({ id: 8, partner_id: 11, company_name: 'Ready Co', status: 'intake', updated_at: ago(1),
               completed_at: null, fields: { logo: 'x', copy: 'y' }, required: ['logo', 'copy'] });
  assert.match((await run()).tasks[0].detail, /mark the intake complete/i);
});

test('   a COMPLETED intake is no task at all', async () => {
  reset();
  DEALS.push({ id: 9, partner_id: 11, company_name: 'Done Co', status: 'building', updated_at: ago(1),
               completed_at: ago(1), fields: {}, required: ['logo'] });
  assert.equal((await run()).total, 0);
});

test('   an empty array counts as missing, not as supplied', async () => {
  // `photos: []` is the shape an upload field takes before anything is uploaded, and it is truthy.
  reset();
  DEALS.push({ id: 10, partner_id: 11, company_name: 'Empty Co', status: 'intake', updated_at: ago(1),
               completed_at: null, fields: { logo: 'x', photos: [] }, required: ['logo', 'photos'] });
  assert.match((await run()).tasks[0].detail, /Still needed: photos/);
});

// ── the scope ─────────────────────────────────────────────────────────────────

test('a partner sees only THEIR OWN tasks', async () => {
  reset();
  OUT.push(out({ entity_id: '1', partner_id: 11, status: 'contacted', entity_name: 'A lead', last_contacted_at: ago(9) }));
  OUT.push(out({ entity_id: '2', partner_id: 22, status: 'contacted', entity_name: 'B lead', last_contacted_at: ago(9) }));
  DEALS.push({ id: 1, partner_id: 11, company_name: 'A client', status: 'intake', updated_at: ago(2), completed_at: null, fields: {}, required: ['logo'] });
  DEALS.push({ id: 2, partner_id: 22, company_name: 'B client', status: 'intake', updated_at: ago(2), completed_at: null, fields: {}, required: ['logo'] });
  const a = await run({ partnerId: 11 });
  assert.equal(a.total, 2);
  assert.ok(a.tasks.every(t => !/B lead|B client/.test(t.entity_name)), "none of B's work");
  const b = await run({ partnerId: 22 });
  assert.ok(b.tasks.every(t => !/A lead|A client/.test(t.entity_name)));
  // Staff see both.
  assert.equal((await run(OURS)).total, 4);
});

test('NO SCOPE means it THROWS — a task list that defaulted would be the most natural-looking leak', async () => {
  reset();
  for (const p of [undefined, null]) {
    await assert.rejects(() => outreachTasks({ held: ['sitenex'], partner: p }, deps),
      /partner scope is required/);
  }
});

test('a FAILED lookup yields nothing, not everything', async () => {
  reset();
  OUT.push(out({ entity_id: '1', partner_id: 11, status: 'contacted', last_contacted_at: ago(9) }));
  DEALS.push({ id: 1, partner_id: 11, company_name: 'X', status: 'intake', updated_at: ago(2), completed_at: null, fields: {}, required: ['l'] });
  assert.equal((await run({ failed: true })).total, 0);
});

// ── what it must NOT do ───────────────────────────────────────────────────────

test('NOTHING IS STORED — the task list is computed, not generated', async () => {
  // The property this buys: marking a prospect 'following_up' makes its chase disappear, because the task WAS
  // the absence of that status. A daily_tasks row would survive and have to be closed separately.
  reset();
  OUT.push(out({ entity_id: '1', partner_id: 11, status: 'contacted', last_contacted_at: ago(9) }));
  assert.equal((await run()).counts.unchased, 1);
  OUT[0].status = 'following_up';
  assert.equal((await run()).counts.unchased, 0, 'acting on it is what closes it');
  // And no write of any kind happened.
  assert.ok(!SQL.some(s => /^(INSERT|UPDATE|DELETE)/i.test(s)), `it wrote something: ${SQL.find(s => /^(INSERT|UPDATE|DELETE)/i.test(s))}`);
});

test('NO SCORING, NO COACHING, NO ESCALATION — not an omission', async () => {
  // External roles are excluded from performance scoring and from the 8am assignment agent as a property of the
  // ROLE. A task list that quietly fed a score, emailed a nudge, or escalated to a manager would reintroduce all
  // three by the back door, which is the specific thing that exclusion exists to prevent.
  const src = require('fs').readFileSync(__dirname + '/tasks.js', 'utf8');
  for (const re of [/score/i, /coach/i, /escalat/i, /sendEmail/, /notify/i, /notifications/i,
                    /weekly_kpis/, /daily_tasks/, /performance/i]) {
    const hit = src.split('\n').find(l => re.test(l) && !/^\s*(\/\/|\*|--)/.test(l));
    assert.equal(hit, undefined, `tasks.js must not touch this: ${hit}`);
  }
});

test('an EMPTY list says which kind of empty it is', async () => {
  // "No tasks" has two meanings and only one is good news.
  reset();
  assert.match((await run()).note, /No outreach recorded yet/);
  OUT.push(out({ entity_id: '1', partner_id: 11, status: 'in_conversation', last_contacted_at: ago(1) }));
  assert.match((await run()).note, /Nothing needs chasing today/);
  OUT[0].status = 'contacted'; OUT[0].last_contacted_at = ago(9);
  assert.equal((await run()).note, null, 'and says nothing when there IS something to do');
});

test('ordered by urgency: overdue, then unchased, then intake, each oldest first', async () => {
  reset();
  OUT.push(out({ entity_id: '1', partner_id: 11, status: 'contacted', entity_name: 'new chase', last_contacted_at: ago(4) }));
  OUT.push(out({ entity_id: '2', partner_id: 11, status: 'contacted', entity_name: 'old chase', last_contacted_at: ago(30) }));
  OUT.push(out({ entity_id: '3', partner_id: 11, status: 'contacted', entity_name: 'overdue one', next_action_at: ago(1) }));
  DEALS.push({ id: 1, partner_id: 11, company_name: 'intake one', status: 'intake', updated_at: ago(99), completed_at: null, fields: {}, required: ['l'] });
  const r = await run();
  assert.deepEqual(r.tasks.map(t => t.kind), ['overdue', 'unchased', 'unchased', 'intake']);
  assert.equal(r.tasks[1].entity_name, 'old chase', 'the oldest chase comes first within its kind');
  // The intake task is 99 days old and still last — the ORDER is by what to do next, not by age alone.
  assert.equal(r.tasks[3].entity_name, 'intake one');
});

test('stale_days is bounded, so a query string cannot ask for a silly window', async () => {
  reset();
  OUT.push(out({ entity_id: '1', partner_id: 11, status: 'contacted', last_contacted_at: ago(9) }));
  assert.equal((await run(PA, { staleDays: 0 })).stale_days, STALE_DAYS, '0 falls back to the default');
  assert.equal((await run(PA, { staleDays: 9999 })).stale_days, 90, 'and a huge one is capped');
  assert.equal((await run(PA, { staleDays: 'nonsense' })).stale_days, STALE_DAYS);
});

test('a task key is stable for the same fact, so a UI can remember a dismissal without us storing one', async () => {
  reset();
  OUT.push(out({ entity_id: '42', partner_id: 11, status: 'contacted', last_contacted_at: ago(9) }));
  const a = (await run()).tasks[0].key;
  const b = (await run()).tasks[0].key;
  assert.equal(a, b);
  assert.equal(a, 'unchased:prospect:42');
});
