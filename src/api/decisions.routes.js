// ── THE DECISION QUEUE — ONE ROUTE, NO WRITES ────────────────────────────────
//
// GET /api/decisions  →  everything in this platform that cannot proceed until a person decides,
//                        from all seven stores that hold such a thing, in one order.
//
// ── THERE IS DELIBERATELY NO SECOND ROUTE ────────────────────────────────────
//
// No POST, no PUT, no `/decisions/:id/approve`. Each item carries `where`, naming the page that
// owns its decision, and the person goes there. This is not an unfinished feature:
//
//   • office_approvals is released ONLY through approval.release(), which refuses a row that is not
//     `approved` and refuses a second release of the same row. That narrowness is the whole
//     mechanism — one human decision authorising one external action. A convenience approve here
//     would be a second door into it.
//   • the global email HOLD and the capability STOPs sit on the execution paths, not on the
//     queue. A route that acted would either have to respect them (and fail in a way nobody
//     expects from a list) or bypass them.
//   • a read-only surface cannot weaken a guard it never touches.
//
// The owner's standing instruction is to preserve every email HOLD, capability STOP and the
// restrictions on autonomous outreach and bidding. The way to aggregate decisions without touching
// any of that is to aggregate only the SIGHT of them.
//
// ── WHY adminOnly ────────────────────────────────────────────────────────────
//
// This surface crosses tiers by construction: a federal notice (procurement), a buyer inquiry
// (sales), a performance escalation (team). Serving it to a lower role would be a new cross-tier
// read path, which is a disclosure change dressed up as a dashboard. Everyone else keeps their own
// scoped pages, which is where their decisions already are.
//
// ── WHY A FAILURE IS IN THE RESPONSE BODY AND NOT A 500 ──────────────────────
//
// Six healthy stores and one unreachable one is not an error; it is a partial answer, and a 500
// would hide the six. So the route answers 200 with `complete: false` and `degraded` naming what
// could not be read. What it must never do is answer 200 with a short list and no flag — an empty
// queue that means "six stores are down" is read as "you are clear", which is the exact silence
// the 1,113 lost emails were made of.

'use strict';

const express = require('express');
const { query } = require('../lib/db');
const { authMiddleware, adminOnly } = require('../lib/core');
const QUEUE = require('../lib/office/decision-queue');
const SOURCES = require('../lib/office/decision-sources');
const BOARD = require('../lib/office/board');
const SCOPE = require('../lib/office/scope');
const { resolveCompanyForReadSession } = require('../lib/office/context');
const { isoDay } = require('../lib/office/iso-day');

const router = express.Router();

// ── COMPANY RESOLUTION: THE KERNEL'S OWN READ-SESSION RESOLVER ───────────────
//
// NOT a slug lookup. The first version of this file resolved the company from PRPA_COMPANY_SLUG,
// copying prpa.routes.js. That is a DEFAULT, and context.js explains at length why a default is the
// wrong answer here: there is no user-to-company mapping anywhere in this system, so "which company
// is this person looking at" has no stored answer, and `resolveCompanyForReadSession` refuses when
// two active companies exist rather than showing a person a tenant that may not be theirs.
//
// A slug default would answer that question by guessing, and would keep guessing quietly on the day
// a second company appears. This surface aggregates held actions, buyer inquiries and performance
// escalations — the guess would be the whole of someone else's operation.
//
// It also returns the FROZEN context that scope.js's accessors require, which is how the approvals
// read reaches a kernel table without this file naming one.
async function resolveCompany(req, res, next) {
  try {
    req.ctx = await resolveCompanyForReadSession({ userId: req.user.id }, { query });
    return next();
  } catch (e) {
    // A refusal here is a configuration fact, reported as one. NOT an empty queue: an empty queue
    // reads as "nothing is waiting on you", which is the single sentence this page must never say
    // when it does not know.
    const missing = /relation "companies" does not exist/i.test(e.message);
    return res.status(503).json({
      error: missing ? 'the office schema is not applied' : 'the company could not be resolved',
      code: missing ? 'schema_missing' : (e.name === 'NoCompanyContext' ? 'company_unresolved' : 'company_lookup_failed'),
      detail: missing ? 'run: node scripts/migrate.js' : e.message,
    });
  }
}

router.get('/decisions', authMiddleware, adminOnly, resolveCompany, async (req, res) => {
  try {
    const now = new Date();
    const notes = [];
    const sources = SOURCES.sourcesFor(query, {
      ctx: req.ctx,
      companyId: req.ctx.companyId,
      userId: req.user.id,
      today: isoDay(now),
      now,
      buildBoard: BOARD.buildBoard,
      // The kernel accessor, injected rather than imported inside the source module: every
      // office_approvals predicate lives in scope.js and nowhere else.
      listPendingApprovals: SCOPE.listPendingApprovals,
      notes,
    });

    const result = await QUEUE.collect(sources, { now });

    // One optional filter, and it narrows what is DISPLAYED without changing what was counted:
    // ?kind=approval still reports the full `count` and the full `degraded`, so a filtered view
    // cannot be mistaken for an empty queue.
    const kind = req.query.kind ? String(req.query.kind) : null;
    const items = kind ? result.items.filter((i) => i.kind === kind) : result.items;

    res.json({
      ...result,
      items,
      filtered_to: kind,
      showing: items.length,
      // Capped sources, so a count that is a floor says so rather than reading as a total.
      caps: notes,
      // Stated in the payload rather than only in this file, because the page renders it: a
      // reader should be able to see that the list does not act without reading the source.
      performs_nothing: 'This queue is a view. Every decision is made on the page named in `where`, '
                      + 'behind that page\'s own guards.',
      as_of: now.toISOString(),
    });
  } catch (e) {
    // collect() turns a failing source into a degradation, so reaching here means the aggregation
    // itself broke — a real 500, and not one that can be mistaken for calm.
    res.status(500).json({ error: e.message, code: 'queue_failed' });
  }
});

module.exports = router;
