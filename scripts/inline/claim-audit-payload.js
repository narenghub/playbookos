// -- THE DUPLICATE-CLAIM AUDIT, SELF-CONTAINED -------------------------------
//
// Generate the command:   node scripts/make-claim-audit-command.js
//
// -- WHY THIS EXISTS SEPARATELY FROM check-claim-uniqueness-live.js ----------
//
// That script is the better one and should be used once the candidate is deployed. It cannot be
// used before: production runs fda00b4, which does not contain it, so
// "node /app/scripts/check-claim-uniqueness-live.js" fails with MODULE_NOT_FOUND. The command in
// the release package would have done exactly that -- the same defect the CEO caught in the
// migration step, which I had made twice.
//
// So this payload answers the same question with NOTHING but what the deployed container already
// has: /app/src/lib/db, and pg underneath it.
//
// -- CONSTRAINTS IT IS WRITTEN UNDER ----------------------------------------
//
// NO APOSTROPHES ANYWHERE, so the whole file can be base64 encoded into a single-quoted shell
// argument with no escaping hazard. That includes this comment block: the generator REFUSES to
// render a command from a payload containing one, and it refused this header on the first attempt,
// which is the guard doing its job.
//
// Every SQL literal is a bound parameter rather than a quoted string -- better SQL anyway, and the
// reason the outcome list and the table name arrive as $1 and $2.
//
// SELECT ONLY. Four reads: the columns, the index, a count, the duplicates. No write of any kind.
//
// NOTHING SENSITIVE PRINTED. No URL, no credential, no recipient, no subject. A claim_ref is masked
// because it is built from ids and an approval id can carry a person.
//
// EXIT 0 CLEAR * 1 BLOCKED, with the conflicting refs * 3 INCOMPLETE, which is NOT a clearance.
//
// Verified against a disposable cluster in five states: unmigrated (3), migrated and empty (0),
// duplicates present (1), duplicates resolved (0), index already created (0).

const { query } = require(process.env.AUDIT_DB || "/app/src/lib/db");
const CLAIMED = ["CLAIMED", "PROVIDER_ACCEPTED", "OUTCOME_UNKNOWN", "RECONCILED"];
const mask = (v) => String(v).replace(/[^\s:@]+@[^\s:]+/g, "***@***").slice(0, 56);
(async () => {
  const cols = await query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = ANY($2)",
    ["email_log", ["claim_ref", "outcome"]]);
  if (cols.rows.length < 2) {
    console.log("INCOMPLETE  email_log lacks claim_ref/outcome: the ledger migration is not applied.");
    console.log("            This is NOT a clearance to create the index.");
    process.exit(3);
  }
  const idx = await query(
    "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2",
    ["email_log", "idx_email_log_one_claim_per_ref"]);
  if (idx.rows.length) {
    console.log("CLEAR  idx_email_log_one_claim_per_ref ALREADY EXISTS. The migration is a no-op for it.");
    process.exit(0);
  }
  const tot = await query(
    "SELECT COUNT(*)::int AS n, COUNT(DISTINCT claim_ref)::int AS refs FROM email_log WHERE claim_ref IS NOT NULL AND outcome = ANY($1)",
    [CLAIMED]);
  console.log("covered by the index: " + tot.rows[0].n + " row(s), " + tot.rows[0].refs + " distinct claim_ref value(s)");
  const dup = await query(
    "SELECT claim_ref, COUNT(*)::int AS n, ARRAY_AGG(DISTINCT outcome) AS o FROM email_log WHERE claim_ref IS NOT NULL AND outcome = ANY($1) GROUP BY claim_ref HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 50",
    [CLAIMED]);
  if (!dup.rows.length) {
    console.log("CLEAR  no duplicate claimed rows under any claim_ref. The unique index can be created.");
    process.exit(0);
  }
  console.log("BLOCKED  " + dup.rows.length + " claim_ref value(s) already have more than one claimed row.");
  console.log("         CREATE UNIQUE INDEX would FAIL. Each row is a duplicate send or attempt, not a");
  console.log("         database artefact, and resolving them is a human act.");
  for (const r of dup.rows) console.log("         " + r.n + "  [" + r.o.join(",") + "]  " + mask(r.claim_ref));
  process.exit(1);
})().catch((e) => { console.log("INCOMPLETE  " + e.message); process.exit(3); });
