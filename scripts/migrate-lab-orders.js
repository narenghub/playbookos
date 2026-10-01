// ── LABCONNECT ORDERS ─────────────────────────────────────────────────────────
//
//   railway ssh 'node scripts/migrate-lab-orders.js'
//
// An order is a client asking for a named test, and a routing decision placing it with one lab.
// Two tables, because those are two different things with two different lifetimes.
//
// ── WHY THE ROUTING IS AUDITED AND NOT JUST RECORDED ──────────────────────────
//
// `lab_orders.lab_id` says where the work went. `lab_order_routes` says WHO ELSE WAS CONSIDERED and
// why each was ruled out, as of the moment the decision was made.
//
// That second table is the one that earns its keep. When an order goes wrong — a missed date, a
// result the client disputes, a lab that turns out not to have been accredited for the method — the
// first question is "why did it go there?", and the answer has to be the state at decision time, not
// the state now. Labs get onboarded, prices change, accreditations lapse; re-running the matcher a
// month later produces a different answer and proves nothing. A GMP release test placed with the
// wrong lab is the failure this whole product has to be able to account for, and an audit written
// afterwards is not an audit.
//
// It is also the only way to see the near misses: five labs rejected for NOT_GMP_TEST on the same
// method is a sales fact (nobody has priced it under GMP) wearing the clothes of a routing failure.
//
// ── THE SNAPSHOT COLUMNS ──────────────────────────────────────────────────────
//
// `lab_name`, `price_cents` and `turnaround_days` are copied onto the order rather than joined. The
// lab's catalogue is live and editable; what the client was told is not. A joined price silently
// rewrites history the next time a lab edits its rate card — the same reason the SiteNex contract
// snapshots its figures instead of reading them back from the deal.
//
// Idempotent. Safe to re-run.

const { initDB, query } = require('../src/lib/db');

async function migrate() {
  await initDB();

  await query(`
    CREATE TABLE IF NOT EXISTS lab_orders (
      id               BIGSERIAL PRIMARY KEY,
      order_no         TEXT UNIQUE,

      -- THE CLIENT. Free text rather than a foreign key: the first orders will come from firms that
      -- are not in any table yet, and refusing an order because its buyer has no row would be the
      -- platform getting in the way of the business it exists to serve.
      client_company   TEXT NOT NULL,
      client_contact   TEXT,
      client_email     TEXT,
      -- Where the buyer came from, when it was one of ours. NULL for an inbound enquiry.
      fda_establishment_id BIGINT REFERENCES fda_establishments(id) ON DELETE SET NULL,
      segment          TEXT,

      -- WHAT IS BEING ASKED FOR.
      test_code        TEXT NOT NULL REFERENCES test_catalogue(code),
      matrix           TEXT,                    -- 'tablet', 'API powder', 'sterile solution'
      sample_count     INTEGER NOT NULL DEFAULT 1,
      -- THE REGULATORY PURPOSE, and not a preference. True means a GMP release test, and the router
      -- will not place it with a lab that is not qualified — under any circumstances.
      gmp              BOOLEAN NOT NULL DEFAULT FALSE,
      require_accredited BOOLEAN NOT NULL DEFAULT FALSE,
      -- A hard constraint when set: crossing a border raises customs and import-licensing questions
      -- that are the client's to answer, not ours to assume.
      restrict_country TEXT,
      client_region    TEXT,                    -- the tie-break, not a filter

      -- WHERE IT WENT. NULL until routed; an order can exist unrouted, which is the normal state
      -- between a client asking and a lab accepting.
      lab_id           BIGINT REFERENCES labs(id) ON DELETE SET NULL,
      -- SNAPSHOTS, not joins. See the note above.
      lab_name         TEXT,
      price_cents      INTEGER,
      currency         TEXT NOT NULL DEFAULT 'USD',
      turnaround_days  INTEGER,
      -- What Abiozen adds on top of the lab's own price. The commercial model, per order, because
      -- it will not be the same for every one of them.
      commission_bps   INTEGER,                 -- basis points, so 1500 = 15%

      -- new → routed → accepted → in_progress → reported → invoiced → (cancelled | declined)
      status           TEXT NOT NULL DEFAULT 'new',
      status_note      TEXT,

      routed_at        TIMESTAMPTZ,
      due_at           TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_lab_orders_status ON lab_orders (status);
    CREATE INDEX IF NOT EXISTS idx_lab_orders_lab ON lab_orders (lab_id);
    CREATE INDEX IF NOT EXISTS idx_lab_orders_test ON lab_orders (test_code);

    -- ONE ROW PER LAB THE ROUTER LOOKED AT, at the moment it looked.
    CREATE TABLE IF NOT EXISTS lab_order_routes (
      id             BIGSERIAL PRIMARY KEY,
      order_id       BIGINT NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
      lab_id         BIGINT REFERENCES labs(id) ON DELETE SET NULL,
      -- SNAPSHOT AGAIN, and here it is the whole point: a lab deleted or renamed later must not
      -- erase the record of having been considered.
      lab_name       TEXT NOT NULL,
      -- 'matched' or a reject code from src/lib/labconnect/match.js (REJECT.*). Not a FK to a
      -- lookup table: the codes live with the logic that produces them, and a second copy in the
      -- database would drift from it.
      outcome        TEXT NOT NULL,
      reason         TEXT,                      -- the sentence, as shown at the time
      rank           INTEGER,                   -- its position among the matches; NULL if rejected
      price_cents    INTEGER,
      turnaround_days INTEGER,
      same_region    BOOLEAN,
      chosen         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_lab_order_routes_order ON lab_order_routes (order_id);
    -- The near-miss query: which reject reason is costing us the most orders.
    CREATE INDEX IF NOT EXISTS idx_lab_order_routes_outcome ON lab_order_routes (outcome);

    -- Order numbers, so a client has something to quote back at us.
    CREATE SEQUENCE IF NOT EXISTS lab_order_no_seq START 1;
  `);

  const counts = (await query(
    `SELECT (SELECT COUNT(*)::int FROM lab_orders) orders,
            (SELECT COUNT(*)::int FROM lab_order_routes) routes`)).rows[0];
  console.log('LabConnect orders schema ready.');
  console.log(`  lab_orders        ${counts.orders}`);
  console.log(`  lab_order_routes  ${counts.routes}`);
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch((e) => {
    console.error('migration failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { migrate };
