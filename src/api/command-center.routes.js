// ── GET /api/office/command-center — WHAT THE AUTONOMOUS OFFICE IS DOING ────
//
// B2.9. Owner's Priority 3 of 2026-11-25 lists what an operator must be able to distinguish, and
// `src/lib/office/command-center.js` is where those distinctions live. This route does three things
// and nothing else: it establishes WHICH COMPANY is being asked about, it refuses if the caller may
// not ask, and it returns the snapshot.
//
// ── THE COMPANY IS RESOLVED FROM MEMBERSHIP, NEVER ACCEPTED ────────────────
//
// `office/context.js` exists to refuse *"an agent does not get to choose which company it is acting
// for"*, and an HTTP caller does not either. So the company is resolved through
// `resolveCompanyForReadSession`, which reads THIS USER'S active memberships: a `companyId` in the
// query is a lookup key against them and a company they do not hold is refused by name. No
// membership, an unreadable membership table, or two memberships with no choice made are all
// refusals rather than a default — and this route returns that refusal rather than an empty page,
// because an empty dashboard reads as "the office is idle".
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

  // ── THE COMPANY COMES FROM THE CALLER'S OWN MEMBERSHIPS ──────────────────
  //
  // `resolveCompanyForReadSession` is the kernel's reviewed answer to "which company is this person
  // looking at", and it is what `/api/decisions` and `/api/approvals` already use. It reads this
  // user's ACTIVE memberships and refuses rather than guessing: no membership is a refusal, an
  // unreadable membership table is a refusal (an outage is not an empty company), and **two**
  // memberships with no choice made is a refusal, because picking one would show somebody a tenant
  // they did not ask for.
  //
  // A `companyId` in the query is therefore a LOOKUP KEY against this person's memberships, never
  // the answer: a company they do not hold is refused by name. That is what makes the parameter
  // safe, and it is how an admin of two companies chooses between them.
  //
  // The first version of this route required an `objectiveId` instead and read the company off the
  // objective. That was right for a tick — a run has an objective — and wrong for a dashboard: the
  // owner's Priority 2 asks to see *company objectives*, plural, so the page cannot be made to name
  // one before it can list them. Using the read-session resolver also means this surface inherits
  // the company isolation that module already enforces rather than a second copy of it.
  const requestedCompanyId = typeof req.query.companyId === 'string' && req.query.companyId
    ? req.query.companyId : null;

  let ctx = null;
  try {
    ctx = await CTX.resolveCompanyForReadSession(
      { userId: req.user.id, requestedCompanyId }, deps);
  } catch (e) {
    // A refusal here is a configuration or authorization fact and is reported as one, NOT as an
    // empty dashboard. An empty dashboard reads as "the office is idle", which is the single
    // sentence this page must never say when it does not know — and on a deployment where the
    // membership backfill (B7.18a) has not been applied, this is the expected answer.
    const missing = /relation "(companies|user_companies)" does not exist/i.test(e.message);
    return res.status(missing ? 503 : 403).json({
      error: missing ? 'the office schema is not applied' : 'no company context for this session',
      code: missing ? 'schema_missing'
        : (e.name === 'NoCompanyContext' ? 'company_unresolved' : 'company_lookup_failed'),
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
