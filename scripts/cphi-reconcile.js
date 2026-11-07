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
const { query, withTransaction } = require('../src/lib/db');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const APPLY = val('--apply');
const CONFIRMED = has('--confirm-not-production');
const PLAN_OUT = val('--plan-out', '/tmp/cphi-reconcile-plan.json');
const ACTOR = process.env.RECONCILE_ACTOR || 'cphi-reconcile.js';

const HUMAN_FIELDS = ['review_status', 'entity_note'];
const DERIVED_FIELDS = ['exhibiting', 'exhibitor_name', 'booth', 'hall', 'match_tier',
  'molecules_covered', 'searched_terms', 'checked_at'];

const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

const isReviewed = (r) => r.review_status != null && r.review_status !== 'unreviewed';
const hasNote = (r) => r.entity_note != null && String(r.entity_note).trim() !== '';
const isHuman = (r) => isReviewed(r) || hasNote(r);

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

  if (notes.length > 1) {
    conflicts.push(`${notes.length} different entity_note values — merging them is a judgement, not a rule`);
  }
  if (reviews.length > 1) {
    conflicts.push(`${reviews.length} different review_status values (${reviews.join(', ')}) — only a person can say which stands`);
  }
  // Disagreement about whether a holder exhibits at all is substantive. If nobody has reviewed the
  // group it is a stale-search artifact and the newest check wins; if somebody HAS, the disagreement
  // may be the thing they were looking at, so it goes to review.
  const exhibitingValues = [...new Set(rows.map((r) => r.exhibiting))];
  if (exhibitingValues.length > 1 && rows.some(isHuman)) {
    conflicts.push('rows disagree on `exhibiting` and at least one has been reviewed or annotated');
  }

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

  reasons.push(isHuman(survivor)
    ? `kept #${survivor.id} because it carries human work (${isReviewed(survivor) ? `review_status=${survivor.review_status}` : ''}${isReviewed(survivor) && hasNote(survivor) ? ', ' : ''}${hasNote(survivor) ? 'entity_note' : ''})`
    : `kept #${survivor.id} as the most recently checked (${new Date(survivor.checked_at).toISOString().slice(0, 10)}); no row in this group carries human work`);

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
  if (!isReviewed(survivor) && reviews.length === 1) {
    const from = losers.find(isReviewed);
    merges.push({
      field: 'review_status',
      value: reviews[0],
      why: `row #${from.id} held the only review in this group (${reviews[0]})`,
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
    survivor_id: survivor.id,
    delete_ids: losers.map((l) => l.id),
    merges,
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
  return {
    plan_id: crypto.randomUUID(),
    generated_at: new Date().toISOString(),
    table: 'cphi_exhibitor_matches',
    index_blocked: 'idx_cem_unique ON cphi_exhibitor_matches (event_slug, holder_normalized)',
    table_rows: total,
    groups,
  };
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
}

async function applyPlan(file) {
  if (!CONFIRMED) {
    console.error('\nRefusing to apply without --confirm-not-production.\n');
    console.error('  This DELETES rows. Run it against an isolated restore of the production backup,');
    console.error('  never against production itself, and only with separate authorization.\n');
    process.exit(2);
  }
  if (!fs.existsSync(file)) { console.error(`no such plan file: ${file}`); process.exit(2); }
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  await ensureAudit();

  h(`APPLYING PLAN ${plan.plan_id}`);
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
               (plan_id, event_slug, holder_normalized, action, survivor_id, affected_id, before_row, after_row, actor)
             VALUES ($1,$2,$3,'merge',$4,$4,$5,$6,$7)`,
            [plan.plan_id, g.event_slug, g.holder_normalized, g.survivor_id,
              JSON.stringify(survivorBefore), JSON.stringify(after), ACTOR]);
          didMerge = true;
        }

        const removed = [];
        for (const id of g.delete_ids) {
          const before = live.find((r) => String(r.id) === String(id));
          if (!before) continue;
          await tx.query(
            `INSERT INTO cphi_reconcile_audit
               (plan_id, event_slug, holder_normalized, action, survivor_id, affected_id, before_row, actor)
             VALUES ($1,$2,$3,'delete',$4,$5,$6,$7)`,
            [plan.plan_id, g.event_slug, g.holder_normalized, g.survivor_id, id,
              JSON.stringify(before), ACTOR]);
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
  if (left) {
    console.log(`\n  ${left} duplicate group(s) remain — the unique index still cannot be created.`);
    console.log(`  Those are the CONFLICT groups: resolve them by hand and re-run.`);
    process.exit(1);
  }
  console.log(`\n  no duplicate (event_slug, holder_normalized) pairs remain.`);
  console.log(`  The migration's \`cphi exhibitors\` step will now create idx_cem_unique.`);
  console.log(`\n  Recovery: every deleted row's complete prior contents are in cphi_reconcile_audit`);
  console.log(`  under plan_id ${plan.plan_id}.\n`);
}

(async () => {
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
  console.log(`\n  plan written to ${PLAN_OUT}`);
  console.log(`  Review it, then apply against an ISOLATED RESTORE of the backup:\n`);
  console.log(`      node scripts/cphi-reconcile.js --apply ${PLAN_OUT} --confirm-not-production\n`);
  if (counts.conflict) {
    console.log(`  ${counts.conflict} CONFLICT group(s) will be left untouched and the unique index will`);
    console.log(`  still not be creatable. Those need a decision first — the report above lists every`);
    console.log(`  row, its review status, its note and its timestamps.\n`);
  }
  // Exit 1 whenever duplicates exist: this is a blocking finding, and an exit code is the only part
  // of a report that cannot be skimmed past.
  process.exit(1);
})().catch((e) => { console.error(`\ncphi-reconcile: ${e.message}\n`); process.exit(1); });
