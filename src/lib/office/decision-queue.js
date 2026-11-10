// ── THE DECISION QUEUE — ONE PLACE FOR EVERYTHING WAITING ON A HUMAN ─────────
//
// Seven stores in this codebase hold something that cannot proceed until a person decides:
//
//   office_approvals    a PREPARED external action, held before execution      (office/approval.js)
//   approval_queue      an agent action awaiting admin review                  (agent-core.js)
//   review_tasks        a blocked qualification criterion on a federal notice  (procurement/review-tasks.js)
//   daily_tasks         today's agent-assigned work for one person             (orchestrator.js)
//   opportunity_tracker a federal notice whose advice says act, with a closing date
//   inquiries           a buyer who wrote in and has had no answer
//   performance_scores  a score that escalated to the CEO
//
// Each has its own page. None of them knows about the others, so "what is waiting on me" was a
// question answered by visiting five screens and remembering the sixth. This module answers it in
// one list.
//
// ── IT PERFORMS NOTHING, AND THAT IS THE DESIGN ──────────────────────────────
//
// There is no approve here, no send, no bid, no release. Every item carries `where` — the page and
// the control that owns that decision — and the person goes there to make it. The reason is not
// tidiness:
//
//   • office_approvals is released ONLY through approval.release(), which refuses a row that is not
//     `approved` and refuses a second release. A convenience "approve" on an aggregated list would
//     be a second door into the one path that is deliberately narrow.
//   • the global email HOLD and the capability STOPs sit on the execution paths. A queue that acted
//     would have to either respect them (and so fail confusingly) or bypass them.
//   • a read-only view cannot weaken a guard it cannot reach.
//
// So this is a VIEW. Adding a write to it is not an enhancement; it is a new hole in a gate that
// several incidents paid for.
//
// ── WHY A FAILED SOURCE IS LOUDER THAN AN EMPTY ONE ──────────────────────────
//
// This is the whole reason the aggregation is shaped the way it is, and it is the lesson of the
// 1,113 lost emails: "every layer did the right local thing and the aggregate was silence."
//
// An aggregator is the perfect machine for that failure. Seven queries, one list; if a query throws
// and its rows are dropped, the list is SHORTER and nothing about it looks wrong. An empty decision
// queue would mean "you are clear" when it actually meant "six stores are unreachable" — and it is
// the one screen a person checks precisely in order to stop worrying.
//
// Therefore:
//
//   • collect() never swallows. Each source returns ok:true with items, or ok:false with the error.
//   • the result carries `degraded` naming every source that failed, and `complete` is false when
//     any did. The caller cannot get a count without also getting that flag.
//   • "nothing is waiting" is only sayable when complete === true. merge() computes `trustworthy`
//     so no caller has to remember the rule.
//
// ── WHY THE ORDER IS A LADDER AND NOT A SCORE ────────────────────────────────
//
// A weighted score would be unexplainable at exactly the moment it matters ("why is this fourth?").
// The order is four named rungs, and every item reports which rung it is on and why.

'use strict';

// A federal closing date inside this many days is treated as urgent. Matches contract-advice.js's
// URGENT_DAYS deliberately: two different definitions of "urgent" on two screens describing the
// same notice is how a person learns to distrust both.
const URGENT_DAYS = 14;

// Beyond this, a dated item stops competing with undated work on urgency alone.
const SOON_DAYS = 30;

// The rungs, highest first. `rank` is the sort key; `why` is shown to the person.
const RUNGS = Object.freeze({
  BLOCKING:  { rank: 0, label: 'blocking', why: 'something outside the company is already waiting on this' },
  URGENT:    { rank: 1, label: 'urgent',   why: `closes within ${URGENT_DAYS} days` },
  SOON:      { rank: 2, label: 'soon',     why: `closes within ${SOON_DAYS} days` },
  OPEN:      { rank: 3, label: 'open',     why: 'no external clock, ordered by how long it has waited' },
});

const KINDS = Object.freeze([
  'approval',    // office_approvals — a prepared action held before execution
  'agent_action',// approval_queue — an agent proposal awaiting admin review
  'review',      // review_tasks — a blocked qualification criterion
  'task',        // daily_tasks — today's assigned work
  'contract',    // a federal notice whose advice says act
  'inquiry',     // a buyer awaiting a reply
  'escalation',  // a performance score escalated to the CEO
]);

const DAY_MS = 86400000;

function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.floor((b - a) / DAY_MS);
}

/**
 * Place one item on a rung.
 *
 * `blocks_external` wins over any date. An approval holding a prepared email, or a buyer who wrote
 * in nine days ago, is work where the waiting is already happening to somebody else — that outranks
 * a deadline that has not arrived.
 */
function rungFor(item, now) {
  if (item.blocks_external) return RUNGS.BLOCKING;
  const left = item.days_left;
  if (left !== null && left !== undefined) {
    if (left <= URGENT_DAYS) return RUNGS.URGENT;
    if (left <= SOON_DAYS) return RUNGS.SOON;
  }
  return RUNGS.OPEN;
}

/**
 * Normalise one source row into a queue item. Everything optional is explicitly defaulted, because
 * a missing `kind` or a missing `where` would produce a row the page cannot route and the person
 * cannot act on — an item that is visible and useless, which is worse than absent.
 */
function makeItem(raw, now = new Date()) {
  if (!raw || !raw.id) throw new Error('a decision item needs an id: without one the page cannot key or dedupe it');
  if (!KINDS.includes(raw.kind)) {
    throw new Error(`unknown decision kind "${raw.kind}" — add it to KINDS with a page in \`where\`, `
      + `or the item renders with nowhere to go`);
  }
  if (!raw.where || !raw.where.page) {
    throw new Error(`decision ${raw.id} has no \`where.page\`: this queue performs nothing, so an item `
      + `that does not say where the decision is made is a dead end`);
  }
  if (!raw.title || !String(raw.title).trim()) {
    throw new Error(`decision ${raw.id} has no title`);
  }

  const deadline = raw.deadline || null;
  const item = {
    id: String(raw.id),
    kind: raw.kind,
    source: raw.source || raw.kind,
    title: String(raw.title).trim(),
    detail: raw.detail ? String(raw.detail).trim() : null,
    blocks_external: Boolean(raw.blocks_external),
    deadline,
    days_left: deadline ? daysBetween(now, deadline) : null,
    age_days: raw.created_at ? daysBetween(raw.created_at, now) : null,
    owner: raw.owner || null,
    where: { page: raw.where.page, label: raw.where.label || 'Open', anchor: raw.where.anchor || null },
  };
  const rung = rungFor(item, now);
  item.rung = rung.label;
  item.rung_why = rung.why;
  item._rank = rung.rank;
  return item;
}

/**
 * Merge the results of every source into one ordered queue.
 *
 * @param {Array<{source:string, ok:boolean, items?:Array, error?:string}>} results
 * @returns {{items:Array, count:number, degraded:Array, complete:boolean, trustworthy:boolean,
 *            by_kind:Object, sources:Array}}
 */
function merge(results, { now = new Date() } = {}) {
  if (!Array.isArray(results)) throw new Error('merge expects the array of source results');

  const items = [];
  const degraded = [];
  const sources = [];
  const malformed = [];

  for (const r of results) {
    const name = (r && r.source) || 'unnamed source';
    if (!r || r.ok !== true) {
      degraded.push({ source: name, error: (r && r.error) || 'the source reported no result at all' });
      sources.push({ source: name, ok: false, count: 0 });
      continue;
    }
    const raws = Array.isArray(r.items) ? r.items : [];
    let kept = 0;
    for (const raw of raws) {
      // ONE BAD ROW MUST NOT EMPTY THE QUEUE. A throw here would discard six healthy sources
      // because one row lacked a title. It is recorded as a degradation — which is the same
      // treatment as a failed query, because the effect on the person is identical: something is
      // waiting and they cannot see it.
      try {
        items.push(makeItem(raw, now));
        kept += 1;
      } catch (e) {
        malformed.push({ source: name, id: (raw && raw.id) || '(no id)', error: e.message });
      }
    }
    sources.push({ source: name, ok: true, count: kept });
  }

  for (const m of malformed) {
    degraded.push({ source: m.source, error: `item ${m.id} could not be shown: ${m.error}` });
  }

  // THE LADDER, then the deadline, then age. Every comparison is a sentence a person would accept.
  items.sort((a, b) =>
    a._rank - b._rank
    || (a.days_left ?? Number.MAX_SAFE_INTEGER) - (b.days_left ?? Number.MAX_SAFE_INTEGER)
    || (b.age_days ?? 0) - (a.age_days ?? 0)
    || a.id.localeCompare(b.id));

  const by_kind = {};
  for (const k of KINDS) by_kind[k] = 0;
  for (const it of items) by_kind[it.kind] += 1;

  const complete = degraded.length === 0;
  return {
    items: items.map(({ _rank, ...rest }) => rest),
    count: items.length,
    by_kind,
    sources,
    degraded,
    complete,
    // The ONLY condition under which a caller may tell somebody they are clear. An empty queue with
    // a failed source is not an empty queue; it is an unknown one.
    trustworthy: complete || items.length > 0,
    // Plain English for the page header, computed here so two screens cannot word it differently.
    headline: headlineFor(items.length, degraded.length),
  };
}

function headlineFor(count, degradedCount) {
  if (degradedCount > 0 && count === 0) {
    return `Nothing to show, and ${degradedCount} source${degradedCount === 1 ? '' : 's'} could not be read `
      + `— this is NOT "you are clear"`;
  }
  if (degradedCount > 0) {
    return `${count} waiting, and ${degradedCount} source${degradedCount === 1 ? '' : 's'} could not be read `
      + `— there may be more`;
  }
  if (count === 0) return 'Nothing is waiting on you';
  return `${count} decision${count === 1 ? '' : 's'} waiting on you`;
}

/**
 * Run every source and merge. Sources are injected so the route, the tests and a CLI preview all
 * exercise the same aggregation.
 *
 * Each source is `{ name, run: async () => Array<rawItem> }`. A source that throws is recorded, not
 * propagated: one unreachable table must not blank the screen, and must not be silent either.
 */
async function collect(sources, { now = new Date() } = {}) {
  if (!Array.isArray(sources) || !sources.length) {
    throw new Error('collect needs at least one source: an aggregator over nothing would report "all clear" forever');
  }
  const results = await Promise.all(sources.map(async (s) => {
    const name = s && s.name;
    if (!name || typeof (s && s.run) !== 'function') {
      return { source: name || 'unnamed source', ok: false, error: 'the source has no name or no run()' };
    }
    try {
      const items = await s.run();
      if (!Array.isArray(items)) {
        return { source: name, ok: false, error: `the source returned ${typeof items}, not an array` };
      }
      return { source: name, ok: true, items };
    } catch (e) {
      return { source: name, ok: false, error: e && e.message ? e.message : String(e) };
    }
  }));
  return merge(results, { now });
}

module.exports = {
  collect, merge, makeItem, rungFor, headlineFor, daysBetween,
  KINDS, RUNGS, URGENT_DAYS, SOON_DAYS,
};
