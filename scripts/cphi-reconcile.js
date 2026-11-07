#!/usr/bin/env node
// ── CPHI DUPLICATE RECONCILIATION — REPORT, PLAN, AND AN AUDITED APPLY ─────────────────────────────
//
//   node scripts/cphi-reconcile.js                              # read-only: report + write a plan
//   node scripts/cphi-reconcile.js --plan-out /tmp/plan.json     # where to write it
//   node scripts/cphi-reconcile.js --apply /tmp/plan.json --confirm-not-production
//
// Ruling 35 items 3, 4 and 5. `cphi_exhibitor_matches` holds duplicate
// (event_slug, holder_normalized) pairs, so `idx_cem_unique` cannot be created and the migration
// halts at the `cphi exhibitors` step (docs/tickets/ENG-005).
//
// WHY THIS IS A SEPARATE TOOL FROM THE MIGRATION. The migration is fail-closed and stays that way: it
// reports and refuses, and has no ability to delete anything. All reconciliation happens here, so
// there is exactly ONE destructive path in the repository for this table, and it is the one with a
// plan file, a drift check, an audit trail and an idempotent apply. Two destructive paths would mean
// two places to get it wrong, and the one nobody reads would be the one that ran.
//
// THE THREE GUARANTEES RULING 35 ITEM 5 ASKS FOR, AND HOW EACH IS OBTAINED:
//
//   AUDITABLE   every applied action writes a row to `cphi_reconcile_audit` holding the COMPLETE
//               prior JSON of every row it touched, the plan id, the actor and the timestamp. The
//               deleted rows are recoverable from that table by hand, field for field.
//   REPEATABLE  plan generation is deterministic — the same database yields the same plan, ordered
//               and tie-broken explicitly. Applying a plan twice is a no-op: the second run sees the
//               group already reconciled and skips it.
//   RECOVERABLE the audit rows above, plus the pre-migration backup the readiness harness already
//               takes and verifies. Nothing is deleted whose content is not first written down.
//
// AND THE DRIFT CHECK, which is the part that makes a plan safe to review and act on later: each
// group carries a fingerprint of the exact rows it was built from. If anything about that group has
// changed when the plan is applied, that group is refused. A plan is a statement about a database at
// a moment; acting on a stale one is how `verify-product-revocation-live.js` wrote to a live account.
//
// HUMAN-AUTHORED vs DERIVED. This distinction is the whole basis of the merge rules:
//
//   HUMAN     review_status (anything but 'unreviewed'), entity_note (free text)
//   DERIVED   exhibiting, exhibitor_name, booth, hall, match_tier, molecules_covered,
//             searched_terms, checked_at — all recomputable from a search
//   IDENTITY  event_slug, holder, holder_normalized
//
// Human-authored values are NEVER discarded. Where a row that would not survive carries a note or a
// review the survivor lacks, the plan CARRIES IT OVER rather than dropping it, and records where it
// came from. Where two rows carry human values that contradict each other, no rule can settle it and
// the group is flagged CONFLICT for a person.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const APPLY = val('--apply');
const CONFIRMED = has('--confirm-not-production');
const PLAN_OUT = val('--plan-out', '/tmp/cphi-reconcile-plan.json');
const ACTOR = process.env.RECONCILE_ACTOR || 'cphi-reconcile.js';

// ── THE PRODUCTION PATH (ruling 44) ────────────────────────────────────────────────────────────────
//
// Until ruling 44 there was exactly one apply flag, --confirm-not-production, and its refusal read
// "never against production itself". That was right for ruling 35 and it made the release
// impossible: idx_cem_unique cannot be created while duplicates exist, production has 232 duplicate
// groups, and the only command that removes them asserts it is not running against production.
//
// The wrong fix is to pass that flag anyway. It would leave an audit trail in which a rehearsal and
// the real thing are indistinguishable — which is the one question that trail exists to answer.
//
// So: a second, differently named path, MUTUALLY EXCLUSIVE with the first, which refuses unless the
// database it is pointed at is the same database the reviewed plan was built from, the rows are
// still the rows in that plan, and the operator names the plan id out loud. Authorization is never
// inferred from the environment: an env var can be inherited by a subprocess nobody is watching,
// and the whole point of this gate is that a person decided.
const APPLY_PROD = has('--apply-to-production');
const CONFIRM_PLAN_ID = val('--confirm-plan-id');

// ── PLAN WITHOUT A PLAN FILE (ruling 45 item 1) ────────────────────────────────────────────────────
//
// The two-command shape — plan to /tmp, review, apply that file — assumed /tmp survives between
// `railway ssh` invocations. It may not: each invocation can land in a different container, and a
// restart or redeploy takes the filesystem with it. A plan that silently disappears between review
// and apply is bad; a plan file that is silently a DIFFERENT, newer plan than the reviewed one is
// much worse, and that is what a re-plan into the same path would produce.
//
// The fix is to stop moving the artifact. Plan generation is already deterministic — the same
// database yields the same groups, survivors and fingerprints, which check-cphi-reconcile.js
// asserts — so the plan does not need to be carried anywhere. It needs to be IDENTIFIED. The report
// prints a digest over the plan's content (everything except its random id and its timestamp), and
// --apply-current re-plans from the live database, recomputes that digest, and refuses unless it
// equals the one reviewed.
//
// So nothing is stored, nothing is transferred, and nothing sensitive leaves the database: the only
// thing that travels is a 24-character hash. If a single row changed in between, the digest differs
// and the apply refuses — which is also ruling 45 item 5, obtained for free rather than bolted on.
const APPLY_CURRENT = has('--apply-current');
const CONFIRM_DIGEST = val('--confirm-plan-digest');

// ── WHICH IDENTITY DOES THE WORK (ruling 45 item 2) ────────────────────────────────────────────────
//
// The application role is least-privileged on purpose: no DDL, so it cannot create the audit tables
// this script needs, and it should not be the identity that deletes rows in a maintenance operation
// either. The migration identity exists for exactly this.
//
// This has to happen BEFORE src/lib/db is required, because that module builds its Pool from
// DATABASE_URL once, at require time — the same ordering the readiness harness depends on. Hence the
// require below this line and not at the top of the file with the others.
const MAINTENANCE_URL = process.env.MIGRATION_DATABASE_URL || null;
let IDENTITY_SOURCE = 'DATABASE_URL';
if ((APPLY || APPLY_CURRENT) && MAINTENANCE_URL) {
  process.env.DATABASE_URL = MAINTENANCE_URL;
  IDENTITY_SOURCE = 'MIGRATION_DATABASE_URL';
}
// eslint-disable-next-line global-require
const { query, withTransaction } = require('../src/lib/db');

if (APPLY_PROD && CONFIRMED) {
  console.error('\nRefusing: --apply-to-production and --confirm-not-production are mutually exclusive.\n');
  console.error('  They describe opposite claims about the database in front of you. Passing both says');
  console.error('  nothing, and a gate that can be satisfied by saying nothing is not a gate.\n');
  process.exit(2);
}
const TARGET = APPLY_PROD ? 'production' : 'isolated-restore';

const HUMAN_FIELDS = ['review_status', 'entity_note'];
const DERIVED_FIELDS = ['exhibiting', 'exhibitor_name', 'booth', 'hall', 'match_tier',
  'molecules_covered', 'searched_terms', 'checked_at'];

const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

// ── WHAT COUNTS AS HUMAN WORK (ruling 38, option 2) ────────────────────────────────────────────────
//
// `entity_note`, and nothing else. An earlier version also counted any review_status other than
// 'unreviewed', which was wrong on this data in a way the production dump made plain: the only values
// present are 'unreviewed' (247), 'entity_review' (181) and 'auto_confirmed' (39), and BOTH non-default
// values are machine-assigned —
//
//   · 'entity_review' is written as a literal by four seeding scripts, and
//     migrate-cphi-entity-note.js backfills notes WHERE review_status='entity_review' AND
//     entity_note IS NULL. The machine marks the row; the human writes the note.
//   · build-cphi-briefing.js renders 'entity_review' as a "confirm which entity holds the file"
//     caveat — a derived caution flag, not a decision.
//   · 'auto_confirmed' says auto on the tin.
//
// Treating those as human decisions produced one "CONFLICT" on the real dump that was two machine
// labels disagreeing with no note on either row, and 47 "MERGE" groups carrying no human text at all.
// It erred safe, but it asked a person to adjudicate something no person had written.
const isReviewed = (r) => r.review_status != null && r.review_status !== 'unreviewed';
const hasNote = (r) => r.entity_note != null && String(r.entity_note).trim() !== '';
const isHuman = (r) => hasNote(r);

// ── THE STATUS RULE (ruling 38 item 3) ─────────────────────────────────────────────────────────────
//
// Deterministic, stated here, and asymmetric ON PURPOSE. review_status is machine-derived, so the
// survivor keeps ITS OWN value and never adopts another row's — with exactly one exception, in the
// one direction that cannot mislead anybody:
//
//   if any row in the group is 'entity_review' and the survivor is not, the survivor becomes
//   'entity_review'.
//
// 'entity_review' means "a human should look at this": the DMF holder's name and the name on the
// stand differ, so the legal entity needs confirming. Raising a row to it only ever asks for more
// scrutiny. Going the other way — adopting 'auto_confirmed' onto a row that was flagged, or onto an
// 'unreviewed' row — would assert machine confidence the survivor never earned, which is precisely
// the "silently reinterpret machine classifications as verified human decisions" that ruling 38
// forbids. So 'auto_confirmed' is NEVER adopted.
//
// Every original value survives in cphi_reconcile_audit.before_row regardless, and a group whose rows
// disagreed is recorded as such, so the disagreement is never simply resolved away.
const NEEDS_HUMAN_EYES = 'entity_review';
function statusFor(survivor, rows) {
  const anyFlagged = rows.some((r) => r.review_status === NEEDS_HUMAN_EYES);
  if (anyFlagged && survivor.review_status !== NEEDS_HUMAN_EYES) {
    return { value: NEEDS_HUMAN_EYES, raised: true };
  }
  return { value: survivor.review_status, raised: false };
}

// Deterministic, and the determinism matters: a plan a person reviewed must be the same plan that is
// applied. Sorted by id so the fingerprint and the survivor choice cannot vary between runs.
function fingerprint(rows) {
  const canonical = rows
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((r) => [r.id, r.review_status, r.entity_note, r.exhibiting, r.exhibitor_name, r.booth,
      r.hall, r.match_tier, r.molecules_covered, r.searched_terms,
      r.checked_at instanceof Date ? r.checked_at.toISOString() : r.checked_at].join('\u0001'))
    .join('\u0002');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ── WHICH DATABASE IS THIS, AND IS IT STILL THE ONE THE PLAN WAS BUILT FROM ───────────────────────
//
// Ruling 44 items 2 and 3. Every component is chosen to be (a) stable for one database over time,
// (b) different for a restore of that database into a fresh cluster, and (c) not a secret. No
// connection string, no host, no password, no token — the identity that gets written down is a
// SHA-256 of these, and the plan carries the hash, not the parts that could identify a host.
//
//   database name      stable; differs between 'railway' and a disposable 'existing'
//   database OID       assigned by CREATE DATABASE — a restore into a fresh cluster gets a new one
//   table OID          likewise assigned on restore, so it moves even if the name does not
//   column fingerprint catches a schema that has changed under a reviewed plan
//   schema step count  which migration chain this code believes in
//
// pg_control_system()'s system_identifier would be the textbook answer and is deliberately NOT used:
// it is superuser-only on a managed Postgres, and a guard that needs superuser is a guard that gets
// run as superuser.
async function dbIdentity() {
  const r = (await query(`
    SELECT current_database()                                        AS database,
           (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS db_oid,
           to_regclass('public.cphi_exhibitor_matches')::oid::text    AS table_oid`)).rows[0];
  const cols = (await query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='cphi_exhibitor_matches'
      ORDER BY column_name`)).rows.map((c) => `${c.column_name}:${c.data_type}`).join(',');
  let schemaSteps = null;
  try { schemaSteps = require('../src/lib/migrate-all').SCHEMA_STEPS.length; } catch { /* reported as null */ }

  const parts = {
    database: r.database,
    db_oid: r.db_oid,
    table_oid: r.table_oid,
    columns_sha: crypto.createHash('sha256').update(cols).digest('hex').slice(0, 16),
    schema_steps: schemaSteps,
  };
  const sha = crypto.createHash('sha256')
    .update(JSON.stringify(parts)).digest('hex').slice(0, 24);
  return { ...parts, identity_sha: sha };
}

// The state of the whole table, not just the duplicate groups. A plan reviewed yesterday is only
// safe to apply if nothing in this table moved since — including rows OUTSIDE the duplicate groups,
// because a row added to a group changes what the survivor should be.
async function tableStateFingerprint() {
  const rows = (await query(
    `SELECT id, event_slug, holder_normalized, review_status,
            COALESCE(btrim(entity_note), '') AS note
       FROM cphi_exhibitor_matches ORDER BY id`)).rows;
  const canonical = rows
    .map((r) => [r.id, r.event_slug, r.holder_normalized, r.review_status, r.note].join('\u0001'))
    .join('\u0002');
  return {
    rows: rows.length,
    state_sha: crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24),
  };
}

// A plan file is reviewed, then sits on disk, then is acted on. Between those points it can be
// edited — by a person tidying it, by a script, by a mistake. The hash covers everything except
// itself, so an altered plan is refused rather than applied.
function planIntegritySha(plan) {
  const { plan_sha: _omit, ...rest } = plan;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 24);
}

// The CONTENT digest, as distinct from the integrity hash above. It deliberately excludes plan_id
// (random per generation) and generated_at (a clock), so two plans built from the same unchanged
// database have the same digest — which is what makes "re-plan and compare" a safe substitute for
// carrying a file between sessions. It covers db_identity, so a digest from one database cannot
// authorize an apply on another.
function planDigest(plan) {
  const { plan_id: _i, generated_at: _g, plan_sha: _s, plan_digest: _d, ...rest } = plan;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 24);
}

// Who am I connected as, and can this identity do the job? Printed rather than assumed, because
// "run it as the migrator" is an instruction and this is the fact.
async function connectionIdentity() {
  const r = (await query(`
    SELECT current_user AS role, current_database() AS database,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
           has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
           has_table_privilege(current_user, 'cphi_exhibitor_matches', 'DELETE') AS can_delete,
           has_table_privilege(current_user, 'cphi_exhibitor_matches', 'UPDATE') AS can_update`)).rows[0];
  return r;
}

async function columnsOf(table) {
  return (await query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]))
    .rows.map((r) => r.column_name);
}

// ── THE PLAN ───────────────────────────────────────────────────────────────────────────────────────
function planForGroup(rows) {
  const notes = [...new Set(rows.filter(hasNote).map((r) => String(r.entity_note).trim()))];
  const reviews = [...new Set(rows.filter(isReviewed).map((r) => r.review_status))];
  const reasons = [];
  const conflicts = [];

  // ONLY contradicting human text is a conflict now. Two machine labels disagreeing is recorded and
  // handled by the status rule above, not escalated to a person who wrote neither of them.
  if (notes.length > 1) {
    conflicts.push(`${notes.length} different entity_note values — merging somebody's sentences is a judgement, not a rule`);
  }
  // Disagreement about whether a holder exhibits at all is substantive, but only when a person has
  // actually written something about this holder; otherwise it is a stale-search artifact and the
  // newest check wins.
  const exhibitingValues = [...new Set(rows.map((r) => r.exhibiting))];
  if (exhibitingValues.length > 1 && rows.some(hasNote)) {
    conflicts.push('rows disagree on `exhibiting` and one of them carries a note');
  }
  // Recorded, never silently resolved: a machine-label disagreement is reported on the group and
  // every original value is kept in the audit.
  const statusDisagreement = reviews.length > 1
    ? `review_status differed across this group (${reviews.join(', ')}) — machine-assigned, so not a conflict; `
      + 'every original value is preserved in cphi_reconcile_audit.before_row'
    : null;

  // Survivor: the reviewed/annotated row if there is exactly one, else the most recently checked.
  // id DESC as the final tie-break so two rows checked in the same instant still resolve the same
  // way on every run.
  const ranked = rows.slice().sort((a, b) => {
    const ah = isHuman(a) ? 1 : 0; const bh = isHuman(b) ? 1 : 0;
    if (ah !== bh) return bh - ah;
    const at = new Date(a.checked_at).getTime(); const bt = new Date(b.checked_at).getTime();
    if (at !== bt) return bt - at;
    return Number(b.id) - Number(a.id);
  });
  const survivor = ranked[0];
  const losers = ranked.slice(1);

  reasons.push(hasNote(survivor)
    ? `kept #${survivor.id} because it carries the group's entity_note — the only human-authored field here`
    : `kept #${survivor.id} as the most recently checked (${new Date(survivor.checked_at).toISOString().slice(0, 10)}); no row in this group carries a note`);
  if (statusDisagreement) reasons.push(statusDisagreement);

  // Carry human work ACROSS, rather than losing it with the row.
  const merges = [];
  if (!hasNote(survivor) && notes.length === 1) {
    const from = losers.find(hasNote);
    merges.push({
      field: 'entity_note',
      value: `${notes[0]}\n[merged from row #${from.id} on reconciliation — original checked_at ${new Date(from.checked_at).toISOString()}]`,
      why: `row #${from.id} carried the only note in this group; it is carried over with its provenance rather than deleted with the row`,
    });
  }
  const status = statusFor(survivor, rows);
  if (status.raised) {
    const from = rows.find((r) => r.review_status === NEEDS_HUMAN_EYES);
    merges.push({
      field: 'review_status',
      value: NEEDS_HUMAN_EYES,
      why: `row #${from.id} is flagged ${NEEDS_HUMAN_EYES} (holder name and stand name differ, so the legal `
        + `entity needs confirming) while the survivor is ${JSON.stringify(survivor.review_status)}. Raised to the `
        + 'more cautious of the two — never the reverse, and auto_confirmed is never adopted',
    });
  }
  // Derived fields: fill only where the survivor has nothing. Never overwrite a present value — a
  // survivor's own derived data is at least self-consistent, and preferring another row's would mix
  // two searches into one row that describes neither.
  for (const f of ['exhibitor_name', 'booth', 'hall', 'match_tier', 'searched_terms']) {
    if (survivor[f] == null || String(survivor[f]).trim() === '') {
      const from = losers.find((r) => r[f] != null && String(r[f]).trim() !== '');
      if (from) {
        merges.push({ field: f, value: from[f], why: `survivor had no ${f}; taken from row #${from.id}` });
      }
    }
  }
  const maxMols = Math.max(...rows.map((r) => Number(r.molecules_covered) || 0));
  if (Number(survivor.molecules_covered || 0) < maxMols) {
    const from = losers.find((r) => Number(r.molecules_covered || 0) === maxMols);
    merges.push({
      field: 'molecules_covered',
      value: maxMols,
      why: `row #${from.id} covered ${maxMols} molecules against the survivor's ${survivor.molecules_covered || 0}; `
        + 'keeping the lower figure would understate this holder\'s coverage',
    });
  }

  // What would be LOST if the losers were simply deleted and nothing merged. Reported whether or not
  // a merge covers it, because item 3 asks for everything reconciliation could change.
  const wouldLose = [];
  for (const l of losers) {
    const carried = [];
    if (hasNote(l)) carried.push(`entity_note=${JSON.stringify(String(l.entity_note).slice(0, 120))}`);
    if (isReviewed(l)) carried.push(`review_status=${l.review_status}`);
    for (const f of DERIVED_FIELDS) {
      if (l[f] != null && String(l[f]) !== String(survivor[f])) {
        carried.push(`${f}=${JSON.stringify(String(l[f] instanceof Date ? l[f].toISOString() : l[f]).slice(0, 60))}`);
      }
    }
    wouldLose.push({ id: l.id, fields: carried });
  }

  return {
    event_slug: survivor.event_slug,
    holder_normalized: survivor.holder_normalized,
    fingerprint: fingerprint(rows),
    rows: rows.map((r) => ({
      id: r.id,
      human: isHuman(r),
      review_status: r.review_status,
      entity_note: r.entity_note,
      exhibiting: r.exhibiting,
      exhibitor_name: r.exhibitor_name,
      booth: r.booth,
      hall: r.hall,
      match_tier: r.match_tier,
      molecules_covered: r.molecules_covered,
      searched_terms: r.searched_terms,
      checked_at: r.checked_at instanceof Date ? r.checked_at.toISOString() : r.checked_at,
    })),
    classification: conflicts.length ? 'CONFLICT' : (merges.length ? 'MERGE' : 'AUTO'),
    conflicts,
    status_disagreement: statusDisagreement,
    original_review_statuses: rows.map((r) => ({ id: r.id, review_status: r.review_status })),
    survivor_id: survivor.id,
    // A CONFLICT group is left untouched, so it must not SCHEDULE anything. These were previously
    // populated regardless and the apply skipped the group at run time — which was safe in this tool
    // and a trap in the file: a plan that reads "delete row 11" for a conflicted group would delete a
    // noted row in the hands of anything else that consumed the JSON. Caught by the harness assertion
    // that no plan anywhere schedules a noted row for deletion.
    delete_ids: conflicts.length ? [] : losers.map((l) => l.id),
    merges: conflicts.length ? [] : merges,
    // Kept for the report either way, so a conflicted group still shows what WOULD have happened.
    would_be_survivor: survivor.id,
    would_delete: losers.map((l) => l.id),
    reasons,
    would_lose_without_merge: wouldLose,
  };
}

async function buildPlan() {
  const cols = await columnsOf('cphi_exhibitor_matches');
  if (!cols.length) {
    console.error('cphi_exhibitor_matches does not exist in this database.');
    process.exit(2);
  }
  const noteCol = cols.includes('entity_note') ? 'entity_note' : `NULL::text AS entity_note`;
  const dup = (await query(
    `SELECT event_slug, holder_normalized
       FROM cphi_exhibitor_matches
      GROUP BY event_slug, holder_normalized
     HAVING COUNT(*) > 1
      ORDER BY event_slug, holder_normalized`)).rows;

  const groups = [];
  for (const d of dup) {
    const rows = (await query(
      `SELECT id, event_slug, holder, holder_normalized, exhibiting, exhibitor_name, booth, hall,
              match_tier, molecules_covered, review_status, searched_terms, checked_at, ${noteCol}
         FROM cphi_exhibitor_matches
        WHERE event_slug = $1 AND holder_normalized = $2
        ORDER BY id`, [d.event_slug, d.holder_normalized])).rows;
    groups.push(planForGroup(rows));
  }
  const total = (await query(`SELECT COUNT(*)::int n FROM cphi_exhibitor_matches`)).rows[0].n;

  // Ruling 44 item 2: the plan file is the reviewed artifact, so everything the apply will check
  // has to be IN it. A plan that does not state what it expects cannot be compared against reality.
  const identity = await dbIdentity();
  const state = await tableStateFingerprint();
  const conflicts = groups.filter((g) => g.classification === 'CONFLICT').length;
  const expectedDeletions = groups.reduce((n, g) => n + (g.delete_ids || []).length, 0);

  const plan = {
    plan_id: crypto.randomUUID(),
    generated_at: new Date().toISOString(),
    table: 'cphi_exhibitor_matches',
    index_blocked: 'idx_cem_unique ON cphi_exhibitor_matches (event_slug, holder_normalized)',
    table_rows: total,
    db_identity: identity,
    table_state: state,
    expected_groups: groups.length,
    expected_deletions: expectedDeletions,
    conflict_count: conflicts,
    groups,
  };
  plan.plan_digest = planDigest(plan);
  plan.plan_sha = planIntegritySha(plan);
  return plan;
}

function report(plan) {
  h('CPHI DUPLICATE RECONCILIATION — FULL REPORT (read-only)');
  const auto = plan.groups.filter((g) => g.classification === 'AUTO');
  const merge = plan.groups.filter((g) => g.classification === 'MERGE');
  const conflict = plan.groups.filter((g) => g.classification === 'CONFLICT');
  const deletions = plan.groups.reduce((n, g) => n + (g.classification === 'CONFLICT' ? 0 : g.delete_ids.length), 0);

  console.log(`\n  plan ${plan.plan_id}`);
  console.log(`  ${plan.table}: ${plan.table_rows} row(s), ${plan.groups.length} duplicate group(s)`);
  console.log(`  blocked index: ${plan.index_blocked}\n`);
  console.log(`    AUTO      ${auto.length} group(s) — no human work anywhere; keep one, delete the rest`);
  console.log(`    MERGE     ${merge.length} group(s) — human work carried onto the survivor first`);
  console.log(`    CONFLICT  ${conflict.length} group(s) — NOT reconcilable by rule; a person must choose`);
  console.log(`\n  rows deleted if this plan is applied: ${deletions}` +
    (conflict.length ? `  (conflicting groups are left exactly as they are)` : ''));

  for (const g of plan.groups) {
    h(`${g.classification}  ${g.event_slug} / ${g.holder_normalized}   fingerprint ${g.fingerprint}`);
    for (const r of g.rows) {
      const mark = r.id === g.survivor_id ? '  KEEP →' : (g.classification === 'CONFLICT' ? '   —    ' : '  del  ');
      console.log(`${mark} #${r.id}${r.human ? '  [HUMAN]' : '          '}  checked ${String(r.checked_at).slice(0, 19)}`);
      console.log(`            review_status=${JSON.stringify(r.review_status)}  molecules_covered=${r.molecules_covered}  exhibiting=${r.exhibiting}`);
      console.log(`            exhibitor_name=${JSON.stringify(r.exhibitor_name)}  booth=${JSON.stringify(r.booth)}  hall=${JSON.stringify(r.hall)}  match_tier=${JSON.stringify(r.match_tier)}`);
      if (r.entity_note != null) console.log(`            entity_note=${JSON.stringify(r.entity_note)}`);
      if (r.searched_terms != null) console.log(`            searched_terms=${JSON.stringify(String(r.searched_terms).slice(0, 100))}`);
    }
    for (const why of g.reasons) console.log(`        · ${why}`);
    if (g.status_disagreement) {
      console.log(`        ? original review_status per row: ` +
        g.original_review_statuses.map((x) => `#${x.id}=${x.review_status}`).join(', '));
    }
    for (const m of g.merges) {
      console.log(`        + MERGE ${m.field} ← ${JSON.stringify(String(m.value).slice(0, 120))}`);
      console.log(`              ${m.why}`);
    }
    if (g.classification === 'CONFLICT') {
      for (const c of g.conflicts) console.log(`        ! ${c}`);
      console.log(`        → left untouched. Decide which row stands, then re-run this tool.`);
    }
    const lossy = g.would_lose_without_merge.filter((w) => w.fields.length);
    if (lossy.length) {
      console.log(`        information on the non-surviving row(s), for the record:`);
      for (const w of lossy) console.log(`              #${w.id}: ${w.fields.join(' · ') || '(nothing not already on the survivor)'}`);
    }
  }
  return { auto: auto.length, merge: merge.length, conflict: conflict.length, deletions };
}

// ── APPLY ──────────────────────────────────────────────────────────────────────────────────────────
async function ensureAudit() {
  await query(`
    CREATE TABLE IF NOT EXISTS cphi_reconcile_audit (
      id          BIGSERIAL PRIMARY KEY,
      plan_id     TEXT NOT NULL,
      event_slug  TEXT NOT NULL,
      holder_normalized TEXT NOT NULL,
      action      TEXT NOT NULL,              -- merge | delete | skip
      survivor_id BIGINT,
      affected_id BIGINT,
      before_row  JSONB,                      -- the COMPLETE prior row, so it can be put back by hand
      after_row   JSONB,
      actor       TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cra_plan ON cphi_reconcile_audit (plan_id, applied_at);
  `);
  await query(`COMMENT ON TABLE cphi_reconcile_audit IS $c$Every row CPHI duplicate reconciliation changed or removed, with its complete prior contents in before_row. This is the recovery path: a deleted row can be reconstructed field for field from here. Written by scripts/cphi-reconcile.js --apply.$c$`);

  // ── THE RUN LEDGER (ruling 44 item 6) ───────────────────────────────────────────────────────────
  //
  // The per-row audit answers "what did this change". It cannot answer "was this a rehearsal or the
  // real thing", and after the fact that is the question people actually ask. One row per
  // invocation, naming the target, the plan, the database identity (a hash — never a connection
  // string, host, user, password or token) and how it ended.
  //
  // Added by ALTER rather than folded into the CREATE above, because CREATE TABLE IF NOT EXISTS
  // skips the whole statement on an existing table — the repository's own founding lesson — so a
  // column added to that literal would silently never appear on any database that already has it.
  await query(`
    CREATE TABLE IF NOT EXISTS cphi_reconcile_runs (
      run_id       BIGSERIAL PRIMARY KEY,
      plan_id      TEXT NOT NULL,
      target       TEXT NOT NULL CHECK (target IN ('production','isolated-restore')),
      db_identity  TEXT NOT NULL,
      database_name TEXT,
      code_sha     TEXT,
      actor        TEXT NOT NULL,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at  TIMESTAMPTZ,
      outcome      TEXT,
      merged       INTEGER, deleted INTEGER, skipped INTEGER, refused INTEGER, failed INTEGER
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_crr_plan ON cphi_reconcile_runs (plan_id, started_at)`);
  await query(`ALTER TABLE cphi_reconcile_audit ADD COLUMN IF NOT EXISTS run_id BIGINT`);
  await query(`ALTER TABLE cphi_reconcile_audit ADD COLUMN IF NOT EXISTS target TEXT`);
}

// Opened before the first transaction, so even a run that dies mid-flight leaves a row saying it
// started, against which target, and never finished.
async function openRun(plan) {
  const id = await dbIdentity();
  let code = null;
  try {
    code = execFileSync('git', ['-C', path.join(__dirname, '..'), 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* not a checkout */ }
  const r = await query(
    `INSERT INTO cphi_reconcile_runs
       (plan_id, target, db_identity, database_name, code_sha, actor, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,'started') RETURNING run_id`,
    [plan.plan_id, TARGET, id.identity_sha, id.database, code, ACTOR]);
  return r.rows[0].run_id;
}

async function closeRun(runId, outcome, counts) {
  await query(
    `UPDATE cphi_reconcile_runs
        SET finished_at = NOW(), outcome = $2,
            merged = $3, deleted = $4, skipped = $5, refused = $6, failed = $7
      WHERE run_id = $1`,
    [runId, outcome, counts.merged, counts.deleted, counts.skipped, counts.refused, counts.failed]);
}

async function applyPlan(file) {
  // The original gate, unchanged (ruling 44 item 7). An invocation with neither flag is refused
  // exactly as before, and the isolated-restore path behaves exactly as it did.
  if (!CONFIRMED && !APPLY_PROD) {
    console.error('\nRefusing to apply without --confirm-not-production.\n');
    console.error('  This DELETES rows. Run it against an isolated restore of the production backup,');
    console.error('  never against production itself, and only with separate authorization.\n');
    console.error('  To reconcile PRODUCTION, which is a different and separately authorized thing:');
    console.error('      --apply-to-production --confirm-plan-id <the plan id>\n');
    process.exit(2);
  }
  // ── --apply-current: the plan is rebuilt here, not read from disk (ruling 45 item 1) ────────────
  let plan;
  if (file === null) {
    if (!CONFIRM_DIGEST) {
      console.error('\nRefusing --apply-current without --confirm-plan-digest.\n');
      console.error('  --apply-current rebuilds the plan from the database in front of it. Without the');
      console.error('  digest of the plan you reviewed, there is nothing to compare it against, and it');
      console.error('  would apply whatever it happens to find now.\n');
      process.exit(2);
    }
    plan = await buildPlan();
    const live = plan.plan_digest;
    if (live !== CONFIRM_DIGEST) {
      console.error('\nRefusing production apply: the plan rebuilt from this database is not the plan you reviewed.\n');
      console.error(`  reviewed digest: ${CONFIRM_DIGEST}`);
      console.error(`  current digest:  ${live}`);
      console.error('\n  Something changed between the review and now — a row, the schema, or the');
      console.error('  database. Nothing has been changed. Re-plan, review the new report, and');
      console.error('  confirm the new digest.\n');
      process.exit(2);
    }
    console.log(`\n  plan rebuilt from this database and matches the reviewed digest ${live}`);
    console.log(`  (plan id ${plan.plan_id} — newly generated; the digest is what was reviewed)`);
  } else {
    if (!fs.existsSync(file)) { console.error(`no such plan file: ${file}`); process.exit(2); }
    plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  // ── THE PRODUCTION GATE (ruling 44 items 3, 4 and 7) ────────────────────────────────────────────
  //
  // Seven refusals, each one a separate reason. They run before ensureAudit() and before any
  // transaction opens, so a refused production invocation has touched nothing at all — it has not
  // even created a table.
  if (APPLY_PROD) {
    const ok_line = (m) => console.log(`  ${m}`);
    const refuse = (what, why) => {
      console.error(`\nRefusing production apply: ${what}\n`);
      console.error(`  ${why}\n`);
      console.error('  Nothing has been changed. Re-plan against the database you intend to act on,');
      console.error('  review the new plan, and pass its plan id.\n');
      process.exit(2);
    };

    // 4a. The second confirmation, bound to the exact plan — not to the file path, which can be
    //     recalled from shell history pointing at a file whose contents have since been replaced.
    // With --apply-current the second confirmation is the DIGEST, already verified above against a
    // plan rebuilt from this database. With a plan file it is the plan id. Exactly one of the two,
    // never neither — and the digest form is strictly stronger, because a plan id identifies a
    // generation while a digest identifies the content.
    if (APPLY_CURRENT) {
      ok_line(`second confirmation: plan digest ${CONFIRM_DIGEST} (content, not just identity)`);
    } else {
      if (!CONFIRM_PLAN_ID) {
        refuse('--confirm-plan-id was not given',
          'a production apply needs two independent confirmations: the flag that says which database, '
          + 'and the plan id that says which change. One of them is missing.');
      }
      if (CONFIRM_PLAN_ID !== plan.plan_id) {
        refuse('the confirmed plan id is not this plan\'s id',
          `you confirmed ${CONFIRM_PLAN_ID}, this file holds ${plan.plan_id} — so the file is not the `
          + 'plan you reviewed.');
      }
    }

    // 4b. Authorization is never inferred from the environment. Said out loud because the
    //     surrounding code reads plenty of env vars, and the next person should not add one here.
    if (!APPLY_PROD) refuse('internal: production path reached without its flag', 'this should be unreachable');

    // 3a. The plan file must not have been edited since it was written.
    if (!plan.plan_sha) {
      refuse('this plan has no integrity hash',
        'it predates the production path and cannot be verified. Re-plan.');
    }
    const recomputed = planIntegritySha(plan);
    if (recomputed !== plan.plan_sha) {
      refuse('the plan file has been modified since it was generated',
        `it records ${plan.plan_sha}, its contents hash to ${recomputed}. A reviewed plan and an `
        + 'edited plan are not the same artifact.');
    }

    // 3b. Same database. This is the refusal that stops a plan built on a restore from landing on
    //     production, and a production plan from landing on a restore.
    if (!plan.db_identity || !plan.db_identity.identity_sha) {
      refuse('this plan does not record which database it was built from', 're-plan.');
    }
    const live = await dbIdentity();
    if (live.identity_sha !== plan.db_identity.identity_sha) {
      refuse('this plan was built against a DIFFERENT database',
        `plan: ${plan.db_identity.database} (db oid ${plan.db_identity.db_oid}, table oid `
        + `${plan.db_identity.table_oid}, ${plan.db_identity.schema_steps} schema steps) — `
        + `connected: ${live.database} (db oid ${live.db_oid}, table oid ${live.table_oid}, `
        + `${live.schema_steps} schema steps).`);
    }

    // 3c. Same rows. Covers the whole table, not just the groups: a row added to a group changes
    //     which row should survive it.
    const liveState = await tableStateFingerprint();
    if (!plan.table_state || liveState.state_sha !== plan.table_state.state_sha) {
      refuse('the table has changed since this plan was reviewed',
        `plan saw ${plan.table_state ? plan.table_state.rows : '?'} row(s) `
        + `(${plan.table_state ? plan.table_state.state_sha : 'no fingerprint'}), the database now `
        + `holds ${liveState.rows} (${liveState.state_sha}). The plan's survivor choices were made `
        + 'from rows that are no longer what is there.');
    }

    // 3d. The plan's own arithmetic must still describe itself. Cheap, and it catches a plan
    //     assembled by something other than buildPlan().
    const groups = plan.groups || [];
    const conflicts = groups.filter((g) => g.classification === 'CONFLICT').length;
    const deletions = groups.reduce((n, g) => n + (g.delete_ids || []).length, 0);
    if (groups.length !== plan.expected_groups || deletions !== plan.expected_deletions
        || conflicts !== plan.conflict_count) {
      refuse('the plan does not match its own summary',
        `it states ${plan.expected_groups} group(s), ${plan.expected_deletions} deletion(s), `
        + `${plan.conflict_count} conflict(s); its groups contain ${groups.length}, ${deletions}, `
        + `${conflicts}.`);
    }

    // 7. The production flag does not buy its way past conflict refusal. Per-group refusal already
    //    happens below; this refuses the WHOLE run up front, because a production apply that
    //    knowingly leaves the index uncreatable is a half-done release, not a step forward.
    if (conflicts > 0) {
      refuse(`${conflicts} group(s) are in CONFLICT`,
        'two rows in those groups carry human-authored notes that disagree, and no rule can settle '
        + 'that. Resolve them by hand first — the plan lists every row, its status, its note and its '
        + 'timestamps. The unique index cannot be created while they remain either way.');
    }

    console.log(`\n  production apply authorized for plan ${plan.plan_id}`);
    console.log(`  database identity ${live.identity_sha} (${live.database}) — matches the plan`);
    console.log(`  table state ${liveState.state_sha} (${liveState.rows} rows) — matches the plan`);
    console.log(`  ${groups.length} group(s), ${deletions} deletion(s), 0 conflict(s)`);
  }

  await ensureAudit();
  const runId = await openRun(plan);

  // ── WHICH CODE IS APPLYING THIS (ruling 38 item 4) ──────────────────────────────────────────────
  //
  // The apply became transactional in e5fcd03. Before that it ran on autocommit, so a mid-flight
  // failure could leave a group half-reconciled. The owner's last verification ran from dcd9e4e, one
  // commit earlier, so "is the transactional version present" is a real question and not a
  // formality — and the only honest answer is the commit, printed by the code itself into the
  // transcript that records what it did.
  let provenance = '(not a git checkout)';
  try {
    provenance = execFileSync('git', ['-C', path.join(__dirname, '..'), 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['-C', path.join(__dirname, '..'), 'status', '--porcelain'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean).length;
    if (dirty) provenance += ` (+${dirty} uncommitted)`;
  } catch { /* not a checkout; said so above */ }

  h(`APPLYING PLAN ${plan.plan_id}`);
  console.log(`  code:     ${provenance}  —  transactional per group since e5fcd03`);
  console.log(`  actor:    ${ACTOR}`);
  let merged = 0; let deleted = 0; let skipped = 0; let refused = 0; let failed = 0;
  const cols = await columnsOf('cphi_exhibitor_matches');
  const noteCol = cols.includes('entity_note') ? 'entity_note' : `NULL::text AS entity_note`;

  // ── ONE TRANSACTION PER GROUP ───────────────────────────────────────────────────────────────────
  //
  // Ruling 36 item 2. These statements used to run on autocommit, one at a time: UPDATE the survivor,
  // INSERT the merge audit, then for each loser INSERT an audit row and DELETE. A failure anywhere in
  // that sequence left the group HALF RECONCILED — merged but losers still present, or one loser gone
  // and another not. Worse, a re-run then saw a fingerprint that no longer matched the plan and
  // correctly refused the group, so a partial apply turned into a group only fixable by hand.
  //
  // PER GROUP, not per plan: a group that fails must not roll back the groups that already succeeded,
  // which is the same isolation the drift refusal already has.
  //
  // The SELECT inside the transaction takes FOR UPDATE, which also closes a race the old code had:
  // it checked the fingerprint, then wrote in a separate statement, with nothing holding the rows in
  // between. Now the check and the act are one atomic unit.
  //
  // And this corrects a comment that used to sit over the delete: "the audit row goes in BEFORE the
  // delete, so a failure between the two leaves the record rather than losing it". That was the right
  // instinct for autocommit and is the wrong reasoning now — atomicity is better than ordering. The
  // audit row and the deletion it describes commit together or not at all, so there can be no audit
  // row claiming a deletion that did not happen, and no deletion without its record.
  for (const g of plan.groups) {
    const label = `${g.event_slug} / ${g.holder_normalized}`;
    if (g.classification === 'CONFLICT') {
      console.log(`  skip      ${label} — CONFLICT, untouched by design`);
      skipped += 1;
      continue;
    }

    let outcome;
    try {
      outcome = await withTransaction(async (tx) => {
        const live = (await tx.query(
          `SELECT id, event_slug, holder, holder_normalized, exhibiting, exhibitor_name, booth, hall,
                  match_tier, molecules_covered, review_status, searched_terms, checked_at, ${noteCol}
             FROM cphi_exhibitor_matches
            WHERE event_slug = $1 AND holder_normalized = $2
            ORDER BY id
              FOR UPDATE`, [g.event_slug, g.holder_normalized])).rows;

        // Already reconciled — this is what makes a second run of the same plan a no-op.
        if (live.length === 1 && String(live[0].id) === String(g.survivor_id)) {
          return { status: 'done' };
        }
        // Drift: the plan describes rows that no longer look like this. Refuse, never guess.
        const nowPrint = fingerprint(live);
        if (nowPrint !== g.fingerprint) {
          return { status: 'drift', now: nowPrint };
        }
        const survivorBefore = live.find((r) => String(r.id) === String(g.survivor_id));
        if (!survivorBefore) return { status: 'missing' };

        let didMerge = false;
        if (g.merges.length) {
          const sets = g.merges.map((m, i) => `${m.field} = $${i + 2}`).join(', ');
          const after = (await tx.query(
            `UPDATE cphi_exhibitor_matches SET ${sets} WHERE id = $1
             RETURNING id, event_slug, holder, holder_normalized, exhibiting, exhibitor_name, booth, hall,
                       match_tier, molecules_covered, review_status, searched_terms, checked_at, ${noteCol}`,
            [g.survivor_id, ...g.merges.map((m) => m.value)])).rows[0];
          await tx.query(
            `INSERT INTO cphi_reconcile_audit
               (plan_id, event_slug, holder_normalized, action, survivor_id, affected_id, before_row, after_row, actor, run_id, target)
             VALUES ($1,$2,$3,'merge',$4,$4,$5,$6,$7,$8,$9)`,
            [plan.plan_id, g.event_slug, g.holder_normalized, g.survivor_id,
              JSON.stringify(survivorBefore), JSON.stringify(after), ACTOR, runId, TARGET]);
          didMerge = true;
        }

        const removed = [];
        for (const id of g.delete_ids) {
          const before = live.find((r) => String(r.id) === String(id));
          if (!before) continue;
          await tx.query(
            `INSERT INTO cphi_reconcile_audit
               (plan_id, event_slug, holder_normalized, action, survivor_id, affected_id, before_row, actor, run_id, target)
             VALUES ($1,$2,$3,'delete',$4,$5,$6,$7,$8,$9)`,
            [plan.plan_id, g.event_slug, g.holder_normalized, g.survivor_id, id,
              JSON.stringify(before), ACTOR, runId, TARGET]);
          await tx.query(`DELETE FROM cphi_exhibitor_matches WHERE id = $1`, [id]);
          removed.push(id);
        }
        return { status: 'applied', didMerge, removed };
      });
    } catch (e) {
      // The transaction rolled back, so this group is exactly as it was: nothing merged, nothing
      // deleted, no audit rows. Reported as a failure rather than swallowed, and the other groups
      // carry on.
      outcome = { status: 'error', message: e.message.split('\n')[0] };
    }

    if (outcome.status === 'done') {
      console.log(`  done      ${label} — already reconciled to #${g.survivor_id}`);
      skipped += 1;
    } else if (outcome.status === 'drift') {
      console.log(`  REFUSED   ${label} — changed since the plan was made ` +
        `(plan ${g.fingerprint}, now ${outcome.now}). Re-generate the plan.`);
      refused += 1;
    } else if (outcome.status === 'missing') {
      console.log(`  REFUSED   ${label} — the planned survivor #${g.survivor_id} is gone`);
      refused += 1;
    } else if (outcome.status === 'error') {
      console.log(`  ROLLED BACK  ${label} — ${outcome.message}`);
      console.log(`               nothing merged, nothing deleted, no audit rows written for this group`);
      failed += 1;
    } else {
      if (outcome.didMerge) {
        console.log(`  merged    ${label} → #${g.survivor_id}: ${g.merges.map((m) => m.field).join(', ')}`);
        merged += 1;
      }
      if (outcome.removed.length) {
        console.log(`  deleted   ${label} — ${outcome.removed.join(', ')} (recorded in cphi_reconcile_audit)`);
        deleted += outcome.removed.length;
      }
    }
  }

  h('RESULT');
  console.log(`  ${merged} group(s) merged · ${deleted} row(s) deleted · ${skipped} skipped · `
    + `${refused} refused · ${failed} rolled back`);

  const left = (await query(
    `SELECT COUNT(*)::int n FROM (
       SELECT 1 FROM cphi_exhibitor_matches
        GROUP BY event_slug, holder_normalized HAVING COUNT(*) > 1) d`)).rows[0].n;
  const counts = { merged, deleted, skipped, refused, failed };
  if (left) {
    await closeRun(runId, failed ? 'incomplete-with-rollback' : 'incomplete-conflicts', counts);
    console.log(`\n  ${left} duplicate group(s) remain — the unique index still cannot be created.`);
    console.log(`  Those are the CONFLICT groups: resolve them by hand and re-run.`);
    console.log(`\n  Run ${runId} recorded in cphi_reconcile_runs against target '${TARGET}'.`);
    process.exit(1);
  }
  await closeRun(runId, failed ? 'complete-with-rollback' : 'complete', counts);
  console.log(`\n  no duplicate (event_slug, holder_normalized) pairs remain.`);
  console.log(`  The migration's \`cphi exhibitors\` step will now create idx_cem_unique.`);
  console.log(`\n  Recovery: every deleted row's complete prior contents are in cphi_reconcile_audit`);
  console.log(`  under plan_id ${plan.plan_id}.`);
  console.log(`\n  Run ${runId} recorded in cphi_reconcile_runs: target '${TARGET}', outcome`);
  console.log(`  '${failed ? 'complete-with-rollback' : 'complete'}'. That row is how anyone later`);
  console.log(`  tells a rehearsal from the real thing.\n`);
}

(async () => {
  // Who is doing this, printed before anything happens (ruling 45 item 2).
  const who = await connectionIdentity();
  console.log(`\n  identity: ${who.role}@${who.database} via ${IDENTITY_SOURCE}`
    + ` — superuser=${who.is_super} create=${who.can_create}`
    + ` update=${who.can_update} delete=${who.can_delete}`);
  if ((APPLY || APPLY_CURRENT) && !who.can_create) {
    console.error('\nRefusing: this identity cannot create tables, so it cannot guarantee the audit\n'
      + '  table exists before deleting anything. Run the apply with MIGRATION_DATABASE_URL set to\n'
      + '  the maintenance identity; the application role is least-privileged on purpose.\n');
    process.exit(2);
  }
  if (APPLY_CURRENT && APPLY) {
    console.error('\nRefusing: --apply and --apply-current are mutually exclusive.\n');
    console.error('  One applies a file, the other rebuilds the plan here. Pick one.\n');
    process.exit(2);
  }
  if (APPLY_CURRENT) { await applyPlan(null); process.exit(0); }
  if (APPLY) { await applyPlan(APPLY); process.exit(0); }

  const plan = await buildPlan();
  if (!plan.groups.length) {
    h('CPHI DUPLICATE RECONCILIATION');
    console.log(`\n  no duplicate (event_slug, holder_normalized) pairs in ${plan.table_rows} row(s).`);
    console.log(`  Nothing to reconcile; idx_cem_unique can be created as it is.\n`);
    process.exit(0);
  }
  const counts = report(plan);
  fs.mkdirSync(path.dirname(PLAN_OUT), { recursive: true });
  fs.writeFileSync(PLAN_OUT, `${JSON.stringify(plan, null, 2)}\n`);

  h('NOTHING HAS BEEN CHANGED');
  console.log(`\n  plan id      ${plan.plan_id}   (new on every generation)`);
  console.log(`  plan digest  ${plan.plan_digest}   <-- THIS is what identifies the plan's CONTENT`);
  console.log(`  database     ${plan.db_identity.database} / identity ${plan.db_identity.identity_sha}`);
  console.log(`  table state  ${plan.table_state.state_sha} over ${plan.table_state.rows} row(s)`);
  console.log(`  plan written to ${PLAN_OUT}`);

  console.log(`\n  Apply against an ISOLATED RESTORE of the backup:\n`);
  console.log(`      node scripts/cphi-reconcile.js --apply ${PLAN_OUT} --confirm-not-production\n`);
  console.log(`  Or, for PRODUCTION, with no plan file to keep or carry — the plan is rebuilt and`);
  console.log(`  compared against the digest above, and refused if a single row has changed:\n`);
  console.log(`      node scripts/cphi-reconcile.js --apply-current \\`);
  console.log(`        --apply-to-production --confirm-plan-digest ${plan.plan_digest}\n`);
  if (counts.conflict) {
    console.log(`  ${counts.conflict} CONFLICT group(s) will be left untouched and the unique index will`);
    console.log(`  still not be creatable. Those need a decision first — the report above lists every`);
    console.log(`  row, its review status, its note and its timestamps.\n`);
  }
  // Exit 1 whenever duplicates exist: this is a blocking finding, and an exit code is the only part
  // of a report that cannot be skimmed past.
  process.exit(1);
})().catch((e) => { console.error(`\ncphi-reconcile: ${e.message}\n`); process.exit(1); });
