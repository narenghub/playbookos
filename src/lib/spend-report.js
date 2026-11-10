// ── WHAT THIS PLATFORM IS SPENDING ON THE MODEL API ──────────────────────────
//
// 42 crons make model calls and there was no spend figure anywhere. This produces one — by day, by
// agent and by model — from llm_spend_log.
//
// ── THE RULE THAT SHAPES EVERY QUERY HERE ────────────────────────────────────
//
// A call that was attempted but returned no usage block MAY have spent tokens. It is stored with
// cost_known = false and cost_usd = NULL, and the database refuses any other shape.
//
// So SUM(cost_usd) is not the answer to "what did we spend". It is the answer to "what did we spend
// ON THE CALLS WE COULD MEASURE", and the difference between those two sentences is the whole
// reason the column exists. Every figure below therefore travels with the number of calls it could
// NOT account for. A caller cannot obtain a dollar total from this module without also obtaining
// that count — they are returned on the same object, deliberately, because an unmeasured count in a
// separate call is an unmeasured count somebody forgets to make.
//
// This mirrors scope.spendToday's reasoning for office_cost_ledger: "a budget that reads only `usd`
// would under-report by exactly the amount it could not see."
//
// ── NOT A BUDGET, AND NOT A FUSE ─────────────────────────────────────────────
//
// This measures. It does not cap, refuse or throttle. Spend ceilings are a separate decision with
// a separate failure mode — a cap that trips silently mid-briefing is worse than no cap — and
// llm.js's own note says the same: "Spend CEILINGS are P0.9 and deliberately not here."

'use strict';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function windowDays(d) {
  const n = Number(d);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(Math.floor(n), MAX_DAYS);
}

/**
 * One row of totals, in the shape every caller gets: measured dollars, and the calls behind them
 * that could not be measured.
 */
function shapeTotals(r) {
  const unmeasured = Number(r.unmeasured_calls || 0);
  const calls = Number(r.calls || 0);
  return {
    calls,
    failed_calls: Number(r.failed_calls || 0),
    usd: Number(r.usd || 0),
    tokens_input: Number(r.tokens_input || 0),
    tokens_output: Number(r.tokens_output || 0),
    // Never folded into `usd`. Named so a reader cannot take the dollar figure as complete without
    // seeing this beside it.
    unmeasured_calls: unmeasured,
    // Stated in words, because a zero here and a number here mean different things about the
    // figure next to them and a bare integer does not say which.
    confidence: unmeasured === 0
      ? (calls === 0 ? 'no calls recorded in this window' : 'every recorded call was measured')
      : `${unmeasured} of ${calls} call(s) returned no usage — the dollar figure is a FLOOR`,
  };
}

const TOTALS_SELECT = `
  COUNT(*)::int                                            AS calls,
  COUNT(*) FILTER (WHERE NOT ok)::int                      AS failed_calls,
  COALESCE(SUM(cost_usd) FILTER (WHERE cost_known), 0)::float8 AS usd,
  COALESCE(SUM(tokens_input), 0)::bigint                   AS tokens_input,
  COALESCE(SUM(tokens_output), 0)::bigint                  AS tokens_output,
  COUNT(*) FILTER (WHERE NOT cost_known)::int              AS unmeasured_calls`;

/**
 * The whole report, in one round trip per section.
 *
 * @returns {{window_days, total, by_day, by_agent, by_model, recent_failures, as_of}}
 */
async function spendReport(queryFn, { days = DEFAULT_DAYS, now = new Date() } = {}) {
  const d = windowDays(days);
  const since = new Date(now.getTime() - d * 86400000).toISOString();

  const [total, byDay, byAgent, byModel, failures] = await Promise.all([
    queryFn(`SELECT ${TOTALS_SELECT} FROM llm_spend_log WHERE at >= $1`, [since]),

    queryFn(
      `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, ${TOTALS_SELECT}
         FROM llm_spend_log WHERE at >= $1
        GROUP BY 1 ORDER BY 1 DESC`, [since]),

    // Ordered by measured spend, but a row with ZERO measured dollars and many unmeasured calls
    // must not sort to the bottom and disappear — it is the most suspicious row on the page. So
    // unmeasured calls break the tie upward.
    queryFn(
      `SELECT agent, ${TOTALS_SELECT}
         FROM llm_spend_log WHERE at >= $1
        GROUP BY agent
        ORDER BY usd DESC, unmeasured_calls DESC, calls DESC`, [since]),

    queryFn(
      `SELECT model, ${TOTALS_SELECT}
         FROM llm_spend_log WHERE at >= $1
        GROUP BY model ORDER BY usd DESC, calls DESC`, [since]),

    // A run of failures that each consumed input tokens is a spend pattern, and it is invisible in
    // a dollar total that it barely moves.
    queryFn(
      `SELECT agent, model, error, COUNT(*)::int AS n, MAX(at) AS last_at
         FROM llm_spend_log
        WHERE at >= $1 AND NOT ok AND error IS NOT NULL
        GROUP BY agent, model, error ORDER BY n DESC LIMIT 10`, [since]),
  ]);

  return {
    window_days: d,
    since,
    total: shapeTotals(total.rows[0] || {}),
    by_day: byDay.rows.map((r) => ({ day: r.day, ...shapeTotals(r) })),
    by_agent: byAgent.rows.map((r) => ({ agent: r.agent, ...shapeTotals(r) })),
    by_model: byModel.rows.map((r) => ({ model: r.model, ...shapeTotals(r) })),
    recent_failures: failures.rows.map((r) => ({
      agent: r.agent, model: r.model, n: r.n,
      error: String(r.error || '').slice(0, 200), last_at: r.last_at,
    })),
    as_of: now.toISOString(),
  };
}

/**
 * A projection, stated as arithmetic rather than as a forecast.
 *
 * Deliberately the dumbest possible model — the measured daily mean over the window, times 30. It
 * is labelled with its own basis so nobody reads it as a prediction, and it is omitted entirely
 * when there is not enough data, rather than extrapolated from one day.
 */
function monthlyProjection(report, { minDays = 3 } = {}) {
  const days = report.by_day.length;
  if (days < minDays) {
    return { available: false, why: `only ${days} day(s) of data — too few to project from` };
  }
  const perDay = report.total.usd / days;
  return {
    available: true,
    usd_per_day: perDay,
    usd_per_30_days: perDay * 30,
    basis: `the measured mean across ${days} day(s) with activity, times 30`,
    // Said out loud beside the number, because the number looks like a total.
    caveat: report.total.unmeasured_calls > 0
      ? `a FLOOR: ${report.total.unmeasured_calls} call(s) in this window returned no usage and are not in it`
      : 'every call in this window was measured',
  };
}

module.exports = { spendReport, monthlyProjection, shapeTotals, windowDays, DEFAULT_DAYS, MAX_DAYS };
