#!/usr/bin/env node
// ── CAN THE CLAIM-UNIQUENESS INDEX BE CREATED ON THIS DATABASE? ──────────────
//
//   railway ssh --service playbookos 'node /app/scripts/check-claim-uniqueness-live.js; echo "EXIT=$?"'
//
// CEO direction, final production readiness, item 1.
//
// ── WHY THIS HAS TO BE ASKED BEFORE THE MIGRATION ────────────────────────────
//
// `idx_email_log_one_claim_per_ref` is a PARTIAL UNIQUE INDEX over claim_ref for rows whose outcome
// means responsibility was taken. It is what makes a duplicate dispatch impossible rather than
// merely unlikely: before it, twelve concurrent dispatches under one key put FOUR messages through
// the provider.
//
// CREATE UNIQUE INDEX FAILS if the data already violates it. Production has never had this
// constraint, and until commit 73884da the claim was a read-then-write race — so duplicate claimed
// rows under one claim_ref are not hypothetical, they are the expected residue of the defect the
// index exists to fix. A migration that fails halfway through a deploy is a worse outcome than one
// that was never attempted, so the answer is established first, read-only.
//
// ── READ-ONLY, ENFORCED RATHER THAN PROMISED ─────────────────────────────────
//
// Every query goes through ro(), which refuses anything that is not a single SELECT. The
// repository's own history is the reason: a verification script's cleanup once held
// `DELETE FROM … WHERE created_at > NOW() - INTERVAL '10 minutes'`, and nothing of value was lost
// only because no real rows existed yet.
//
// ── NOTHING SENSITIVE LEAVES THIS SCRIPT ─────────────────────────────────────
//
// No database URL, no credential, no recipient address, no subject, no message body. Counts, and
// claim_ref values with their recipient-shaped parts masked — a claim_ref is constructed from table
// names and ids, but `approval:<id>` and `outreach:<who>:…` can carry a person, so they are masked
// on the way out rather than trusted to be safe.
//
// EXIT 0  the index can be created as written
// EXIT 1  duplicates exist — the migration would fail; the report says which refs and how many
// EXIT 3  nothing could be established (no database, no table, no columns) — NOT a pass

'use strict';

const EXIT_NOT_ESTABLISHED = 3;

let fail = 0;
let incomplete = false;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const note = (m) => console.log(`        ${m}`);

// The outcomes the partial index covers. Imported from the schema rather than restated, so this
// script and the migration cannot disagree about what "claimed" means.
const SCHEMA = require('../src/lib/outbound/ledger-schema');
const CLAIMED_OUTCOMES = SCHEMA.OUTCOMES.filter((o) => !SCHEMA.DEFINITELY_NOT_SENT.includes(o));

/** A claim_ref with anything address-shaped removed. */
function maskRef(v) {
  if (!v) return '(null)';
  return String(v)
    .replace(/[^\s:@]+@[^\s:]+/g, '***@***')
    .slice(0, 72);
}

function makeReadOnly(query) {
  return async (sql, params = []) => {
    const normalised = String(sql).trim().replace(/\s+/g, ' ');
    if (!/^SELECT\b/i.test(normalised)) {
      throw new Error(`refused: this script runs SELECT only, got: ${normalised.slice(0, 60)}`);
    }
    if (/;/.test(normalised.replace(/;$/, ''))) {
      throw new Error('refused: statement batching is not allowed in a read-only verifier');
    }
    return query(sql, params);
  };
}

/**
 * @param {object} [deps] { query } — injected only by the controls, which drive this against a
 *   disposable cluster. db.js attempts SSL whenever DATABASE_URL is set, which is correct for
 *   Railway and cannot connect to a local socket fixture, so the seam exists to let a control
 *   prove this script's VERDICTS rather than trusting them. Production passes nothing.
 */
async function main(deps = {}) {
  console.log('\n══ CLAIM UNIQUENESS — LIVE, READ-ONLY ══\n');

  const deployed = process.env.RAILWAY_GIT_COMMIT_SHA || null;
  note(deployed ? `deployed commit ${deployed.slice(0, 12)}` : 'RAILWAY_GIT_COMMIT_SHA is not set');
  note(`the index covers outcome IN (${CLAIMED_OUTCOMES.join(', ')})`);
  console.log();

  let ro;
  try {
    // Importing db.js creates a pool and writes NOTHING — initDB and the migrate* functions are
    // exported, not invoked. Checked, because a read-only verifier that migrated on import would
    // be the worst possible version of this script.
    const { query } = deps.query ? deps : require('../src/lib/db');
    ro = makeReadOnly(deps.query || query);
  } catch (e) {
    bad('the database module could not be loaded', e.message);
    incomplete = true;
    return;
  }

  // ── 1. IS THERE A TABLE WITH THE COLUMNS THIS DEPENDS ON? ─────────────────
  //
  // Asked first. "No duplicates" is also what an absent column looks like, and the two must not
  // produce the same answer — that is the defect class this repository keeps finding.
  let cols;
  try {
    cols = await ro(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'email_log' AND column_name = ANY($1)`,
      [['claim_ref', 'outcome']]);
  } catch (e) {
    bad('the schema could not be read, so nothing below could be established', e.message);
    incomplete = true;
    return;
  }
  const have = cols.rows.map((r) => r.column_name).sort();
  if (have.length !== 2) {
    bad(`email_log is missing ${['claim_ref', 'outcome'].filter((c) => !have.includes(c)).join(', ')}`,
      'the ledger migration has not been applied, so the claim-uniqueness index cannot be created '
      + 'yet either. Apply scripts/migrate-outbound-ledger.js first, then run this again.');
    incomplete = true;
    return;
  }
  ok('email_log has both claim_ref and outcome');

  // ── 2. DOES THE INDEX ALREADY EXIST? ──────────────────────────────────────
  let existing;
  try {
    existing = await ro(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'email_log' AND indexname = $1`,
      ['idx_email_log_one_claim_per_ref']);
  } catch (e) {
    bad('the index list could not be read', e.message);
    incomplete = true;
    return;
  }
  if (existing.rows.length) {
    ok('idx_email_log_one_claim_per_ref ALREADY EXISTS — the migration is a no-op for this index');
    note('IF NOT EXISTS makes re-running it safe, and nothing below can fail the create.');
    return;
  }
  ok('idx_email_log_one_claim_per_ref does not exist yet');

  // ── 3. HOW MUCH DATA WOULD THE INDEX COVER? ───────────────────────────────
  //
  // Reported because "no duplicates in an empty set" is a true statement that proves nothing about
  // a table that is about to start filling up, and a reader deserves to know which they are
  // looking at.
  let covered;
  try {
    covered = await ro(
      `SELECT COUNT(*)::int AS rows_covered,
              COUNT(DISTINCT claim_ref)::int AS distinct_refs
         FROM email_log
        WHERE claim_ref IS NOT NULL AND outcome = ANY($1)`,
      [CLAIMED_OUTCOMES]);
  } catch (e) {
    bad('the covered rows could not be counted', e.message);
    incomplete = true;
    return;
  }
  const { rows_covered: rowsCovered, distinct_refs: distinctRefs } = covered.rows[0];
  note(`${rowsCovered} row(s) fall under the index, across ${distinctRefs} distinct claim_ref value(s)`);
  if (rowsCovered === 0) {
    note('the index would be created over an empty set. That is a safe CREATE, and it is NOT');
    note('evidence that the application was behaving — it may simply never have recorded a claim.');
  }

  // ── 4. THE QUESTION ───────────────────────────────────────────────────────
  let dupes;
  try {
    dupes = await ro(
      `SELECT claim_ref, COUNT(*)::int AS n,
              ARRAY_AGG(DISTINCT outcome) AS outcomes,
              MIN(sent_at) AS first_seen, MAX(sent_at) AS last_seen
         FROM email_log
        WHERE claim_ref IS NOT NULL AND outcome = ANY($1)
        GROUP BY claim_ref
       HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC, MAX(sent_at) DESC
        LIMIT 50`,
      [CLAIMED_OUTCOMES]);
  } catch (e) {
    bad('the duplicate check could not be run', e.message);
    incomplete = true;
    return;
  }

  if (!dupes.rows.length) {
    ok('NO duplicate claimed rows under any claim_ref');
    ok('the unique index can be created as written');
    note('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_log_one_claim_per_ref');
    note('  ON email_log (claim_ref)');
    note(`  WHERE claim_ref IS NOT NULL AND outcome IN (${CLAIMED_OUTCOMES.map((o) => `'${o}'`).join(', ')})`);
    note('');
    note('This answer is about the data AS AT NOW. Until the index exists the claim is still a');
    note('read-then-write race, so a concurrent duplicate could be written between this check and');
    note('the migration. Re-run it immediately before applying, and with outbound email held the');
    note('window is as small as it can be made without a lock.');
    return;
  }

  // ── 5. WHAT WOULD HAVE TO HAPPEN FIRST ────────────────────────────────────
  bad(`${dupes.rows.length} claim_ref value(s) already have more than one claimed row`,
    'CREATE UNIQUE INDEX would FAIL on this data. The migration must not be attempted until these '
    + 'are resolved.');
  console.log();
  console.log('        rows  outcomes                          claim_ref (masked)');
  console.log(`        ${'-'.repeat(68)}`);
  for (const r of dupes.rows) {
    const outs = (r.outcomes || []).join(',').slice(0, 32);
    console.log(`        ${String(r.n).padStart(4)}  ${outs.padEnd(33)} ${maskRef(r.claim_ref)}`);
  }
  console.log();
  note('WHAT THESE ARE. Until 73884da the claim was a read-then-write race, so two attempts under');
  note('one key could both reach CLAIMED — and if both reached PROVIDER_ACCEPTED, two messages went');
  note('to the same recipient. Each row above is a duplicate SEND or a duplicate attempt, not a');
  note('database artefact, and each deserves reading before anything is deleted.');
  note('');
  note('RESOLVING THEM IS NOT THIS SCRIPT\'S JOB and must not be automated: the rows are the only');
  note('evidence that those sends happened. The options, in order of preference:');
  note('  1. RECONCILE — a human establishes what actually happened and the duplicates are marked');
  note('     RECONCILED, which the index still covers, so this does NOT resolve the conflict on its');
  note('     own. Keep one claimed row per ref and record the others as reconciled duplicates with');
  note('     a distinct claim_ref, or');
  note('  2. NARROW THE INDEX to PROVIDER_ACCEPTED only, which guarantees less — it would permit two');
  note('     CLAIMED rows, and a crash between claim and response is exactly when that matters, or');
  note('  3. CREATE INDEX CONCURRENTLY and accept an INVALID index on failure, which guarantees');
  note('     nothing at all and is listed only to be ruled out.');
}

function report() {
  console.log();
  if (incomplete) {
    console.log('INCOMPLETE  nothing was established. This is NOT a clearance to migrate.');
    return EXIT_NOT_ESTABLISHED;
  }
  if (fail) {
    console.log('BLOCKED  the claim-uniqueness migration cannot be applied to this data as written.');
    return 1;
  }
  console.log('CLEAR  the claim-uniqueness index can be created. Nothing was written by this script.');
  return 0;
}

/** For the controls: run against an injected query and return the exit code rather than exiting. */
async function run(deps = {}) {
  fail = 0; incomplete = false;
  try {
    await main(deps);
  } catch (e) {
    console.log(`\nINCOMPLETE  ${(e && e.message) || e}`);
    return EXIT_NOT_ESTABLISHED;
  }
  return report();
}

module.exports = { run, main, makeReadOnly, maskRef, CLAIMED_OUTCOMES };

// Only when run directly, so importing this module for a control does not open a pool or exit.
if (require.main === module) {
  main()
  .then(() => {
    console.log();
    if (incomplete) {
      console.log('INCOMPLETE  nothing was established. This is NOT a clearance to migrate.');
      process.exit(EXIT_NOT_ESTABLISHED);
    }
    if (fail) {
      console.log('BLOCKED  the claim-uniqueness migration cannot be applied to this data as written.');
      process.exit(1);
    }
    console.log('CLEAR  the claim-uniqueness index can be created. Nothing was written by this script.');
    process.exit(0);
  })
  .catch((e) => {
    console.log(`\nINCOMPLETE  ${(e && e.message) || e}`);
    console.log('            Nothing was established, and nothing was written.');
    process.exit(EXIT_NOT_ESTABLISHED);
  });
}
