// ── WHAT THE PLATFORM SPENDS ON THE MODEL API ────────────────────────────────
//
// GET /api/spend?days=30  →  totals, by day, by agent, by model, plus the failures.
//
// Read-only, and adminOnly for two reasons rather than one. The obvious one is that spend is a
// business figure. The less obvious one matters more: llm_spend_log is PLATFORM spend on one API
// key, not tenant data. It is not company-scoped and must never be served to a tenant as if some
// share of it were theirs.
//
// ── IT MEASURES, IT DOES NOT CAP ─────────────────────────────────────────────
//
// There is no route here that sets a budget, trips a fuse or throttles an agent. A ceiling is a
// separate decision with a separate failure mode — one that trips silently in the middle of the
// CEO briefing is worse than no ceiling at all — and llm.js's own note says the same of itself:
// "Spend CEILINGS are P0.9 and deliberately not here." The kill switch (`llm.call` via
// autonomy.checkStopped) already exists for stopping spend deliberately, and it is reached from
// Agent Control, which is where a stop belongs.

'use strict';

const express = require('express');
const { query } = require('../lib/db');
const { authMiddleware, adminOnly } = require('../lib/core');
const REPORT = require('../lib/spend-report');

const router = express.Router();

router.get('/spend', authMiddleware, adminOnly, async (req, res) => {
  try {
    const now = new Date();
    const report = await REPORT.spendReport(query, { days: req.query.days, now });
    res.json({
      ...report,
      projection: REPORT.monthlyProjection(report),
      // Rendered on the page rather than only documented here, so a reader can see what the
      // figure does and does not include without opening the source.
      measures_only: 'This measures spend. It does not cap it. Stop model spend from Agent Control '
                   + '(the llm.call capability), not from here.',
    });
  } catch (e) {
    // A missing table is a configuration fact, not a zero. Reporting $0.00 because the ledger has
    // not been migrated would be the most expensive kind of wrong answer this page could give.
    const missing = /relation "llm_spend_log" does not exist/i.test(e.message);
    res.status(missing ? 503 : 500).json({
      error: missing
        ? 'the spend ledger has not been created yet — this is NOT a spend of $0'
        : e.message,
      code: missing ? 'ledger_missing' : 'spend_report_failed',
      detail: missing ? 'run: node scripts/migrate-connectors.js' : undefined,
    });
  }
});

module.exports = router;
