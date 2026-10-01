// ── MY TASKS, DERIVED FROM OUTREACH ───────────────────────────────────────────
//
// WHY NOT daily_tasks. Those are generated from weekly_kpis by the 8am agent, and a partner has no KPIs — by
// design, because scoring an outside account is meaningless and coaching one would be worse. So My Tasks has
// always been an empty page for a partner, and filling it from daily_tasks would have meant inventing KPIs for
// somebody we do not manage.
//
// Outreach is the right source and it already exists: a partner's own rows, partner-scoped since this morning.
// Three derivations, each of which names a thing somebody should do today:
//
//   OVERDUE      next_action_at is in the past. They said they would do something and the day has passed.
//   UNCHASED     'contacted' for more than STALE_DAYS with no follow-up. The commonest way a lead dies.
//   INTAKE       their own deals where the client has not finished intake. The build cannot start.
//
// NOTHING IS STORED. These are computed on read, so there is no row to go stale, no generator to run, and no
// second place where a task can exist after the thing it describes has been dealt with. Marking a prospect
// 'following_up' makes its UNCHASED task disappear because the task WAS the absence of that status — which is
// the property a daily_tasks row could not have.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
// No scoring, no coaching email, no escalation. Not an omission: external roles are excluded from performance
// scoring and from the 8am assignment agent as a property of the ROLE, and a task list that quietly fed a score
// would reintroduce exactly that by the back door. These are reminders a person reads, and nothing reads them
// back.

const { productScopeSql } = require('../products/held');
const { partnerFragment } = require('./index');
const { TERMINAL } = require('./registry');

// How long 'contacted' may sit before it is a thing to chase.
//
// THREE DAYS, so a Monday call is chased by Thursday. Short enough that a lead does not cool, long enough that
// somebody who rang on Friday afternoon is not nagged on Monday morning. A number with a reason beats a number
// with a comment saying "tune this", and it is one constant to change when somebody disagrees.
const STALE_DAYS = 3;

// Statuses where a chase is the right next action. Deliberately NOT every status: 'following_up' is already the
// chase, and TERMINAL ones are finished — nagging somebody about a deal they lost is how a task list gets
// ignored wholesale.
const CHASEABLE = ['contacted'];

const q = (deps) => deps.query || require('../db').query;

// A task is a plain object, not a row. `key` is stable for the same underlying fact so a UI can remember what
// somebody dismissed without us storing a dismissal.
const task = (kind, o, title, detail, dueAt) => ({
  key: `${kind}:${o.entity_type}:${o.entity_id}`,
  kind,
  entity_type: o.entity_type,
  entity_id: o.entity_id,
  entity_name: o.entity_name || null,
  product: o.product || null,
  status: o.status || null,
  title,
  detail,
  due_at: dueAt || null,
  // Days overdue, floored, so "4 days" is four whole days and not 3.6 rounded up into a worse-sounding number.
  days_overdue: dueAt ? Math.max(0, Math.floor((Date.now() - new Date(dueAt).getTime()) / 86400000)) : null,
});

async function outreachTasks({ held, partner, staleDays = STALE_DAYS } = {}, deps = {}) {
  // THE SAME product and partner scopes as every other outreach read, and partnerFragment THROWS when the
  // caller has not said whose view this is. A task list that defaulted to "everybody's" would be the most
  // natural-looking leak in the system: a partner opening My Tasks and seeing our follow-ups.
  const scope = productScopeSql(held, 'o', 1);
  const pt = partnerFragment(partner, 'o', scope.nextIndex);
  const days = Math.max(1, Math.min(90, Number(staleDays) || STALE_DAYS));

  // ONE query for both outreach derivations. The prospect name is joined in because a task reading
  // "follow up prospect 6114" is a task nobody can act on without opening another screen.
  const rows = (await q(deps)(
    `SELECT o.entity_type, o.entity_id, o.product, o.status, o.next_action_at, o.last_contacted_at,
            o.updated_at, o.note,
            -- brief_title, NOT title: clinical_studies has brief_title and official_title and no column
            -- called title at all, so the obvious name would have thrown on every study task.
            -- (And no backticks in here: this is inside a template literal, which one would close.)
            COALESCE(p.name, i.name, s.brief_title) AS entity_name
       FROM outreach o
       -- ── THE CAST IS GUARDED BY A PATTERN, NOT BY entity_type ──
       --
       -- outreach.entity_id is TEXT because the entities it spans do not agree on a key type: prospects are
       -- BIGSERIAL, clinical_studies are uuid. Writing the discriminator and the cast side by side in a join
       -- condition LOOKS guarded and is not — Postgres may evaluate the cast before the discriminator, and in
       -- production it did: every row was a study with a uuid id and the query died with
       -- (no backticks in this comment: it lives inside a template literal, which one would close — second
       --  time today, so it is worth the parenthesis)
       --   invalid input syntax for type bigint: "4b797daf-34d6-..."
       --
       -- A CASE on the TEXT ITSELF is safe, because the regex rules out anything the cast would reject, and it
       -- still compares against p.id as a bigint so the primary key index is usable. Casting p.id to text
       -- instead would also be correct and would throw the index away.
       LEFT JOIN prospects p
              ON p.id = (CASE WHEN o.entity_type = 'prospect' AND o.entity_id ~ '^[0-9]+$'
                              THEN o.entity_id::bigint END)
       LEFT JOIN research_institutions i
              ON i.id = (CASE WHEN o.entity_type = 'institution' AND o.entity_id ~ '^[0-9]+$'
                              THEN o.entity_id::bigint END)
       -- clinical_studies.id is TEXT (a uuid), so there is nothing to cast. Assuming bigint here once 400'd
       -- every study write; the lesson is the same one, from the other direction.
       LEFT JOIN clinical_studies s
              ON o.entity_type = 'study' AND s.id = o.entity_id
      WHERE ${scope.sql} AND ${pt.sql}
        AND o.status <> ALL($${pt.nextIndex})`,
    [...scope.params, ...pt.params, TERMINAL])).rows;

  const overdue = [];
  const unchased = [];
  const now = Date.now();
  for (const o of rows) {
    if (o.next_action_at && new Date(o.next_action_at).getTime() < now) {
      overdue.push(task('overdue', o,
        `Follow up ${o.entity_name || o.entity_type + ' ' + o.entity_id}`,
        o.note ? `You noted: ${o.note}` : 'You set a date for this and it has passed.',
        o.next_action_at));
      continue;   // an overdue action is the stronger statement; listing it twice is noise
    }
    if (CHASEABLE.includes(o.status)) {
      // Measured from the CONTACT, not from updated_at: editing a note is not contact, and using updated_at
      // would let a row be kept "fresh" by touching it.
      const since = o.last_contacted_at || o.updated_at;
      const age = since ? Math.floor((now - new Date(since).getTime()) / 86400000) : null;
      if (age != null && age >= days) {
        unchased.push(task('unchased', o,
          `Chase ${o.entity_name || o.entity_type + ' ' + o.entity_id}`,
          `Contacted ${age} days ago with no follow-up since.`,
          since));
      }
    }
  }

  // ── intake outstanding, on their OWN deals ─────────────────────────────────
  //
  // A different table and a different scope: a deal carries partner_id directly, so this is partnerScopeSql's
  // question rather than the outreach fragment's. Written separately rather than forced into the query above,
  // because joining a deal to an outreach row would silently drop any deal whose prospect nobody has logged.
  const dealScope = partner && partner.isStaff ? { sql: 'TRUE', params: [] }
    : (partner && partner.partnerId != null && !partner.failed)
      ? { sql: 'd.partner_id = $1', params: [partner.partnerId] }
      : { sql: 'FALSE', params: [] };
  const intake = (await q(deps)(
    `SELECT d.id, d.company_name, d.status, d.updated_at,
            x.completed_at, x.fields, x.required
       FROM sitenex_deals d
       LEFT JOIN sitenex_intake x ON x.deal_id = d.id
      WHERE ${dealScope.sql}
        AND d.status <> 'lost'
        AND x.completed_at IS NULL
        AND d.status = ANY($${dealScope.params.length + 1})`,
    [...dealScope.params, ['signed', 'intake', 'building']])).rows;

  const intakeTasks = intake.map(d => ({
    key: `intake:deal:${d.id}`,
    kind: 'intake',
    entity_type: 'deal',
    entity_id: String(d.id),
    entity_name: d.company_name || `deal #${d.id}`,
    product: 'sitenex',
    status: d.status,
    title: `Intake outstanding — ${d.company_name || 'deal #' + d.id}`,
    detail: x_detail(d),
    due_at: d.updated_at || null,
    days_overdue: d.updated_at
      ? Math.max(0, Math.floor((Date.now() - new Date(d.updated_at).getTime()) / 86400000)) : null,
  }));

  // Heaviest first within a kind, and overdue before unchased before intake — the order answers "what should
  // I do next" rather than listing by table.
  const byAge = (a, b) => (b.days_overdue || 0) - (a.days_overdue || 0);
  const tasks = [...overdue.sort(byAge), ...unchased.sort(byAge), ...intakeTasks.sort(byAge)];

  return {
    stale_days: days,
    total: tasks.length,
    counts: { overdue: overdue.length, unchased: unchased.length, intake: intakeTasks.length },
    tasks,
    // Said explicitly, because an empty list has two meanings and only one of them is good news.
    note: tasks.length ? null
      : (rows.length || intake.length
        ? 'Nothing needs chasing today.'
        : 'No outreach recorded yet, so there is nothing to follow up.'),
  };
}

// What is still missing, from the intake row's own `required` list. Named rather than counted, because
// "3 items outstanding" sends somebody to another screen to find out which.
function x_detail(d) {
  const have = d.fields && typeof d.fields === 'object' ? d.fields : {};
  const need = Array.isArray(d.required) ? d.required : [];
  const missing = need.filter(k => have[k] == null || have[k] === '' ||
    (Array.isArray(have[k]) && !have[k].length));
  if (!d.completed_at && !need.length) return 'Intake has not been started.';
  if (!missing.length) return 'Everything is in — mark the intake complete.';
  return `Still needed: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}.`;
}

module.exports = { outreachTasks, STALE_DAYS, CHASEABLE };
