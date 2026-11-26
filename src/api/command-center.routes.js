// ── GET /api/office/command-center — WHAT THE AUTONOMOUS OFFICE IS DOING ────
//
// B2.9. Owner's Priority 3 of 2026-11-25 lists what an operator must be able to distinguish, and
// `src/lib/office/command-center.js` is where those distinctions live. This route does three things
// and nothing else: it establishes WHICH COMPANY is being asked about, it refuses if the caller may
// not ask, and it returns the snapshot.
//
// ── THE COMPANY IS RESOLVED, NEVER ACCEPTED ────────────────────────────────
//
// There is no `?companyId=` parameter, and that is the point. A query parameter naming a company is
// exactly what `office/context.js` exists to refuse: *"an agent does not get to choose which
// company it is acting for"*, and neither does an HTTP caller. The company comes from the
// OBJECTIVE being asked about, read from stored state — so a caller can ask about an objective and
// the platform decides whose it is.
//
// ── READ-ONLY, AND adminOnly FOR A SPECIFIC REASON ─────────────────────────
//
// The snapshot carries worker identities, capability grants, budget exposure and authorization
// refusals. Those are operational-security facts about the platform, not a tenant's business data:
// knowing which worker is offline and which capability nothing is serving is knowing where to push.
// So it is adminOnly, like /api/spend, and for the same kind of reason rather than merely by
// analogy.
//
// It writes nothing. There is no stop, no resume, no retry and no dispatch on this surface — a
// dashboard that can act is a dashboard whose read path needs the authorization of a write path,
// and Agent Control already owns stopping things.

'use strict';

const express = require('express');
const { query } = require('../lib/db');
const { authMiddleware, adminOnly } = require('../lib/core');

const router = express.Router();

router.get('/office/command-center', authMiddleware, adminOnly, async (req, res) => {
  const CTX = require('../lib/office/context');
  const CC = require('../lib/office/command-center');
  const deps = { query };

  const objectiveId = typeof req.query.objectiveId === 'string' ? req.query.objectiveId : null;
  if (!objectiveId) {
    // Deliberately a refusal rather than a default. "Show me the first company you find" is a
    // choice about whose data to display, and nothing here is entitled to make it.
    return res.status(400).json({
      error: 'an objectiveId is required: the company is read from the objective, never supplied',
      code: 'objective_required',
    });
  }

  let ctx = null;
  try {
    ctx = await CTX.resolveObjectiveContext({ objectiveId }, deps);
  } catch (e) {
    // The same refusal for "no such objective" and for "that objective is not active": both mean
    // there is no execution context, and distinguishing them here would tell an unauthorized
    // caller which objective ids exist.
    return res.status(404).json({
      error: 'no autonomous-office context for that objective',
      code: 'no_context',
      detail: e.message,
    });
  }

  try {
    const snap = await CC.snapshot(ctx, { limitHistory: 20 }, deps);
    // 200 even when sections are unreadable, because the snapshot SAYS which ones — and a 500 here
    // would turn "the worker table could not be read" into "the dashboard is broken", which sends
    // somebody to the wrong problem. The payload's `unreadable` array is the signal.
    return res.json(snap);
  } catch (e) {
    return res.status(500).json({ error: e.message, code: 'snapshot_failed' });
  }
});

// Exported as the router itself, like spend.routes.js, so server.js mounts it the same way.
module.exports = router;
