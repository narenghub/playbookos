// ── NEW WORK CANNOT BE CREATED FOR A COMPANY THAT IS NOT ACTIVE ──────────────
//
// Owner's Priority 1, 2026-11-26: *"Verify authorization changes between a phase guard and the
// consequential operation itself."*
//
// ── THE WINDOW THE PHASE GUARD CANNOT CLOSE ─────────────────────────────────
//
// B3.18's `office/phase-guard.js` revalidates the company, the objective and the kill switch at the
// top of every phase. It closes the gap between one PHASE and the next — minutes or hours apart, and
// the gap that mattered most, because nothing re-read the company's status at all.
//
// It cannot close the gap between the guard and the write a few milliseconds later. A company
// suspended in that window passes the guard and the work is enqueued anyway. Checking again
// immediately before the write would NARROW the window and would not close it: there is no amount of
// re-checking that makes a check-then-act atomic, which is the same lesson B2.5b learned about
// budget (*"two concurrent calls both passed the same check"*) and the reason that hold is taken
// inside the statement rather than before it.
//
// So the DATABASE states it. A `BEFORE INSERT` trigger refuses a row whose company is not active,
// and it is enforced however the insert arrives — from the cycle, from a route, from a future caller
// nobody has written, or from a psql session. The guard remains, because an operator needs the phase
// to refuse BY NAME with an escalation rather than to discover a raw constraint error; the trigger is
// what makes the refusal true rather than likely.
//
// ── WHICH TABLES, AND WHY NOT THE OTHERS ────────────────────────────────────
//
// Only the tables that represent **new work being created**:
//
//   · `worker_tasks`  — enqueueing work for a worker to execute
//   · `office_plans`  — minting a plan, which is minting authorization to act
//
// Deliberately NOT `office_outcomes`, `office_exceptions`, `agent_memory` or `agent_runs`. Those are
// the TRUTHFUL RECORD of what happened, and a suspended company is exactly when they must still be
// writable: B3.18's whole answer to a withdrawn authorization is to open an exception and record a
// terminal state. A trigger that refused those would make the system unable to write down that it
// had stopped — turning a governed refusal into silence, which is worse than the thing it prevents.
//
// `company_id IS NULL` is left alone. An unattributed row belongs to nobody and is already invisible
// to every scoped read; refusing it here would be a second, different opinion about ownership.

'use strict';

/** The tables where creating a row means creating new work. */
const GUARDED_TABLES = Object.freeze(['worker_tasks', 'office_plans']);

const FUNCTION_SQL = `
  CREATE OR REPLACE FUNCTION office_company_must_be_active() RETURNS trigger AS $fn$
  DECLARE s TEXT;
  BEGIN
    IF NEW.company_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT status INTO s FROM companies WHERE id = NEW.company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'company % does not exist, so no work may be created for it', NEW.company_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF s <> 'active' THEN
      RAISE EXCEPTION 'company % is %, not active: new work may not be created for a company whose authorization has been withdrawn', NEW.company_id, s
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql`;

/**
 * Create (or re-create) the guard wherever both halves exist.
 *
 * ── WHY IT IS CALLED FROM BOTH MIGRATIONS ───────────────────────────────────
 *
 * The trigger needs `companies` (created by `office/schema.js`) and the guarded table (created by
 * `office/schema.js` for plans, `worker/leases.js` for tasks). Several checks apply those migrations
 * in different orders, and at least one applies `migrateWorkerTasks` without `migrateOffice` at all.
 * A statement that assumed an order would fail in exactly those cases — which is how this repository
 * learned that a migration ordering assumption surfaces as a product-shaped error.
 *
 * So this is idempotent, order-free and guarded on `to_regclass`: whichever migration runs LAST
 * wires the trigger, and a database that has only one half gets nothing and no error.
 */
async function installActiveCompanyGuard(query) {
  const companies = await query("SELECT to_regclass('companies') AS t");
  if (!companies.rows[0].t) return { ok: true, installed: [], reason: 'companies does not exist' };

  await query(FUNCTION_SQL);

  const installed = [];
  for (const table of GUARDED_TABLES) {
    const exists = await query('SELECT to_regclass($1) AS t', [table]);
    if (!exists.rows[0].t) continue;
    await query(`DROP TRIGGER IF EXISTS trg_${table}_company_active ON ${table}`);
    await query(
      `CREATE TRIGGER trg_${table}_company_active
         BEFORE INSERT ON ${table}
         FOR EACH ROW EXECUTE FUNCTION office_company_must_be_active()`);
    installed.push(table);
  }
  return { ok: true, installed };
}

module.exports = { installActiveCompanyGuard, GUARDED_TABLES, FUNCTION_SQL };
