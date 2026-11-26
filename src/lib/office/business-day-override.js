// ── THE BUSINESS-DAY OVERRIDE, AND THE FOUR THINGS THAT MUST HOLD ───────────
//
// `scripts/office-cycle-tick.js --business-day YYYY-MM-DD` exists because a check that must
// demonstrate two consecutive scheduled cycles cannot wait until tomorrow, and must not rewrite a
// run's intent key: `agent_runs` forbids that with a trigger, because run identity is immutable.
//
// Owner, second directive of 2026-11-25, Priority 5: *"The --business-day flag is useful for
// acceptance testing, but must not permit production callers to bypass objective scheduling, replay
// historical business days or create future-dated unauthorized runs. Restrict the override to the
// approved development test context and verify production refusal."*
//
// ── WHAT THE FLAG CAN ACTUALLY DO, STATED PLAINLY ──────────────────────────
//
// The business day is half of the initiation intent key (`…:bd=<day>`), and that key is what
// `uq_agent_runs_intent_attempt` uses to refuse a second run for the same objective on the same
// day. So a caller who can choose the day can:
//
//   • start a SECOND run today by claiming it is a different day — the duplicate protection is
//     keyed on the value, so a different value is a different slot. This is the bypass.
//   • REPLAY a historical business day, minting a run that looks like it belonged to a day whose
//     work is already closed and whose evidence has already been reported.
//   • FUTURE-DATE a run, so an objective's work for a day nobody has authorized yet exists now.
//
// None of that requires a bug: it is what the flag is for, pointed the wrong way. Hence four
// conditions, each of which must hold, and every one of them is something a production environment
// cannot satisfy by accident:
//
//   1. NOT `NODE_ENV=production`. Production sets it; this is the cheapest and bluntest condition
//      and it is first so an obviously-production process stops before touching the database.
//   2. THE DATABASE MUST IDENTIFY AS DEVELOPMENT, by `scripts/lib/db-identity.js` — the same
//      read-only inspection the M7 development worker API uses to refuse a production database. It
//      looks for production's containment STOP rows and for populated business tables. An
//      environment variable can be set wrongly; what is IN the database cannot be set wrongly by a
//      flag. `cannot_tell` is a refusal, never permission.
//   3. THE DAY MUST BE TODAY OR TOMORROW in America/Chicago. That is exactly what an acceptance run
//      needs — a second consecutive business day — and it forecloses historical replay and
//      future-dating in the same clause. A one-day window is not a compromise between the two; it
//      is the smallest window in which "two consecutive cycles" is expressible at all.
//   4. IT MUST BE A COMMAND-LINE FLAG. Not an environment variable, which is the thing a deployment
//      platform sets for a whole service and nobody re-reads. A flag has to be typed into an
//      invocation, and the cron passes none.
//
// A refusal is a REFUSAL, not a silent fallback to today's date. Falling back would make a
// restricted seam behave like an unrestricted one with a different outcome, and the operator who
// typed the flag would never learn that their day was ignored.

'use strict';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A REAL calendar day, not merely four-two-two digits.
 *
 * `2026-13-45` matches the shape above, which my own test caught: it sailed past the format check
 * and was only refused later, by the window. That happens to be safe and it is the wrong reason to
 * be safe — a value that is not a date should be refused as not a date, where the message says so,
 * rather than as "not today or tomorrow". `Date.UTC` normalises out-of-range parts silently
 * (month 13 becomes January of the next year), so the test is a ROUND TRIP.
 */
function isRealDay(day) {
  if (!ISO_DAY.test(String(day))) return false;
  const [y, m, d] = String(day).split('-').map((n) => Number.parseInt(n, 10));
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.toISOString().slice(0, 10) === day;
}

const REFUSAL = Object.freeze({
  MALFORMED: 'malformed_day',
  PRODUCTION_ENV: 'production_environment',
  NOT_DEVELOPMENT_DB: 'database_is_not_identified_as_development',
  DB_UNKNOWABLE: 'database_identity_unknowable',
  OUT_OF_WINDOW: 'day_outside_the_permitted_window',
});

/** The business day, in the timezone the crons fire in. */
function chicagoDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** The day after a YYYY-MM-DD, by UTC arithmetic on the date parts (no timezone drift). */
function dayAfter(day) {
  const [y, m, d] = day.split('-').map((n) => Number.parseInt(n, 10));
  const t = Date.UTC(y, m - 1, d) + 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Is this Postgres a cluster created by `scripts/lib/pg-disposable.js`?
 *
 * Asked OF THE DATABASE, not of the connection string: a URL can point anywhere and is often
 * rewritten by a platform, whereas `data_directory` is where the server's own files actually are.
 * Any failure is a NO, never a yes — the permission has to be positively established.
 */
async function isDisposableCluster(query) {
  try {
    const r = await query('SHOW data_directory');
    const dir = r && r.rows && r.rows[0]
      ? (r.rows[0].data_directory || Object.values(r.rows[0])[0]) : null;
    if (!dir) return { yes: false, detail: 'the server reported no data_directory' };
    const { PREFIX } = require('../../../scripts/lib/pg-disposable');
    const yes = require('node:path').basename(String(dir)).startsWith(PREFIX)
      || String(dir).includes(`/${PREFIX}`);
    return { yes, detail: yes ? `disposable cluster at ${dir}` : `data_directory is ${dir}` };
  } catch (e) {
    return { yes: false,
      detail: `data_directory is unreadable (${String(e.message).slice(0, 100)})` };
  }
}

/**
 * May this process honour `--business-day <day>`?
 *
 * @returns {Promise<{allowed:boolean, day?:string, reason?:string, detail:string, window?:string[]}>}
 *
 * Never throws: an inspection that cannot complete is a refusal, because "I could not tell whether
 * this is production" and "this is not production" are different facts and only one of them permits
 * anything.
 */
async function authorizeBusinessDayOverride(day, { env = process.env, query = null, now = new Date(),
  identify = null } = {}) {
  if (!isRealDay(day)) {
    return { allowed: false, reason: REFUSAL.MALFORMED,
      detail: `--business-day must be a REAL date as YYYY-MM-DD (got ${JSON.stringify(day)})` };
  }

  // 1. The blunt one, first, before any database work.
  if (String(env.NODE_ENV) === 'production') {
    return { allowed: false, reason: REFUSAL.PRODUCTION_ENV,
      detail: 'NODE_ENV=production: the business day is the scheduler\'s to decide, not a '
        + 'caller\'s. Choosing it would let a second run open for an objective whose day is '
        + 'already taken, replay a closed day, or mint work for a day nobody has authorized' };
  }

  // 2. WHAT THE SERVER IS, THEN WHAT IS IN IT — IN THAT ORDER, AND THE ORDER IS THE POINT.
  //
  // First version of this asked `db-identity.js` first and refused anything carrying production's
  // fingerprint. That is the right rule for the M7 development worker API, where the question is
  // *"am I about to act on somebody's real data"* — and it is the WRONG FIRST QUESTION here, where
  // the question is *"could this possibly be production"*. The acceptance clusters seed an admin
  // user at bootstrap, `users` is one of db-identity's production tables, so a throwaway cluster
  // created seconds earlier reported `production_fingerprint` and the seam refused its own tests.
  // Loosening the fingerprint rule would have been the wrong repair: it is load-bearing elsewhere.
  //
  //   (a) A DISPOSABLE TEST CLUSTER answers the question by CONSTRUCTION. The server reports its
  //       own data_directory under the prefix `scripts/lib/pg-disposable.js` creates clusters with;
  //       such a cluster is made for one run and destroyed at the end of it, and production's
  //       Postgres is not there whatever rows it holds. Asked of the DATABASE, never of the
  //       connection string, which a platform rewrites. `SHOW data_directory` needs superuser or
  //       pg_read_all_settings and the production runtime role is NOSUPERUSER by design (ENG-003),
  //       so in production this signal is absent rather than wrong — and any failure is a NO.
  //
  //   (b) OTHERWISE db-identity must positively say `development`. A fingerprint, an unknowable
  //       database and an `unidentified` one are all refusals on a cluster nobody can vouch for.
  const DI = require('../../../scripts/lib/db-identity');
  const q = query || require('../db').query;

  const disposable = await isDisposableCluster(q);
  if (!disposable.yes) {
    const inspect = identify || ((qq) => DI.identifyDatabase(qq));
    let id;
    try {
      id = await inspect(q);
    } catch (e) {
      return { allowed: false, reason: REFUSAL.DB_UNKNOWABLE,
        detail: `not a disposable cluster (${disposable.detail}) and the database could not be `
          + `identified (${String(e.message).slice(0, 120)}) — an outage is not a development `
          + 'environment' };
    }
    if (!id || id.verdict === DI.VERDICT.CANNOT_TELL) {
      return { allowed: false, reason: REFUSAL.DB_UNKNOWABLE,
        detail: `the database reports \`${(id && id.verdict) || 'nothing'}\`: nothing is `
          + 'concluded, which is a refusal and not permission' };
    }
    if (id.verdict !== DI.VERDICT.DEVELOPMENT) {
      return { allowed: false, reason: REFUSAL.NOT_DEVELOPMENT_DB,
        detail: `not a disposable cluster (${disposable.detail}) and the database reports `
          + `\`${id.verdict}\``
          + `${id.findings && id.findings.length ? ` — ${id.findings[0]}` : ''}` };
    }
  }

  // 3. Today or tomorrow, in Chicago. Historical replay and future-dating refused by one clause.
  const today = chicagoDay(now);
  const window = [today, dayAfter(today)];
  if (!window.includes(day)) {
    return { allowed: false, reason: REFUSAL.OUT_OF_WINDOW, window,
      detail: `${day} is neither today (${window[0]}) nor tomorrow (${window[1]}) in `
        + 'America/Chicago: a historical business day would replay work whose evidence is already '
        + 'reported, and a future one would mint work for a day nobody has authorized' };
  }

  return { allowed: true, day, window,
    detail: `development database, non-production environment, ${day} within [${window.join(', ')}]` };
}

module.exports = {
  authorizeBusinessDayOverride, chicagoDay, dayAfter, isRealDay, isDisposableCluster,
  REFUSAL, ISO_DAY,
};
