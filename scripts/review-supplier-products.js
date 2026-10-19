#!/usr/bin/env node
// ── APPROVE OR REJECT EXTRACTED PRODUCTS, IN BULK ────────────────────────────
//
//   railway ssh 'node scripts/review-supplier-products.js'                                  → what is waiting
//   railway ssh 'node scripts/review-supplier-products.js --approve --use=commercial --suggested=list'
//   railway ssh 'node scripts/review-supplier-products.js --approve --supplier=Egis --execute'
//   railway ssh 'node scripts/review-supplier-products.js --reject --suggested=reject --execute'
//   railway ssh 'node scripts/review-supplier-products.js --hold --suggested=hold --execute'
//
// Dry run unless --execute. Always prints what it is about to change, and how many.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// 441 rows are in the review table and every one is `pending`. The export that the marketplace
// project reads takes --status=approved, which currently returns nothing, so the gate is working
// exactly as designed and is also completely blocking. Reviewing 441 rows one at a time is not a
// plan, and the alternative people reach for — handing over everything unreviewed — is the thing
// the gate was built to prevent.
//
// So: bulk decisions, by criteria, with the criteria visible. This is a MECHANISM, not a policy.
// Which rows deserve approval is a commercial and legal judgement and it stays with the person
// running it.
//
// ── IT WILL NOT APPROVE WHAT IT SHOULD NOT ──────────────────────────────────
//
// Two refusals are built in and cannot be overridden by a flag:
//
//   1. A row the classifier marked `hold` cannot be bulk-approved. Holds are the GLP-1s, the
//      controlled substances, the cosmetic peptides and the rows whose extraction was uncertain.
//      Each needs a human looking at that specific row, which is the opposite of a bulk action.
//   2. A row with no use_class cannot be approved at all, because the marketplace cannot render
//      it safely. That is the same refusal the export makes.
//
// A single id can still be approved explicitly with --id=, which is the escape hatch for a hold
// somebody HAS looked at.
'use strict';

const { initDB, query } = require('../src/lib/db');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const EXECUTE = process.argv.includes('--execute');
const BY = arg('by', 'naren');

const WANTS = ['approve', 'reject', 'hold'].filter((a) => process.argv.includes(`--${a}`));
const USE = arg('use', null);
const SUGGESTED = arg('suggested', null);
const SUPPLIER = arg('supplier', null);
const CONFIDENCE = arg('confidence', null);
const MIN_PRIORITY = arg('min-priority', null);
const IDS = (arg('id', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const NOTE = arg('note', null);

const STATUS_FOR = { approve: 'approved', reject: 'rejected', hold: 'held' };
const say = (s = '') => console.log(s);

async function main() {
  await initDB();

  // ── NO ACTION: REPORT WHAT IS WAITING ────
  if (!WANTS.length) {
    const rows = (await query(
      `SELECT review_status, suggested, use_class, COUNT(*)::int c
         FROM supplier_products WHERE event_slug = $1
        GROUP BY 1,2,3 ORDER BY 1, 4 DESC`, [EVENT])).rows;
    const total = rows.reduce((a, r) => a + r.c, 0);
    say(`\n── ${EVENT} · ${total} extracted product(s)\n`);
    let last = null;
    for (const r of rows) {
      if (r.review_status !== last) { say(`   ${r.review_status.toUpperCase()}`); last = r.review_status; }
      say(`      ${String(r.suggested || '(none)').padEnd(15)} ${String(r.use_class || '(none)').padEnd(12)} ${r.c}`);
    }
    const ready = (await query(
      `SELECT COUNT(*)::int c FROM supplier_products
        WHERE event_slug = $1 AND review_status = 'pending'
          AND suggested IN ('list','second_source') AND use_class = 'commercial'`, [EVENT])).rows[0].c;
    say(`\n   ${ready} pending row(s) are suggested for listing AND commercially supplyable.`);
    say(`   That is the obvious first batch:\n`);
    say(`      node scripts/review-supplier-products.js --approve --use=commercial --suggested=list`);
    say(`      node scripts/review-supplier-products.js --approve --use=commercial --suggested=second_source\n`);
    say(`   Nothing reaches the marketplace until a row is approved — the export takes --status=approved.\n`);
    return;
  }

  if (WANTS.length > 1) { say(`✗ pick one of --approve, --reject, --hold (got ${WANTS.join(', ')})`); process.exit(1); }
  const action = WANTS[0];
  const newStatus = STATUS_FOR[action];

  const where = ['event_slug = $1'];
  const params = [EVENT];
  const crit = [];
  if (IDS.length) { params.push(IDS); where.push(`id = ANY($${params.length}::bigint[])`); crit.push(`id in (${IDS.join(', ')})`); }
  if (USE) { params.push(USE); where.push(`use_class = $${params.length}`); crit.push(`use_class = ${USE}`); }
  if (SUGGESTED) { params.push(SUGGESTED); where.push(`suggested = $${params.length}`); crit.push(`suggested = ${SUGGESTED}`); }
  if (SUPPLIER) { params.push(`%${SUPPLIER}%`); where.push(`supplier ILIKE $${params.length}`); crit.push(`supplier ~ ${SUPPLIER}`); }
  if (CONFIDENCE) { params.push(CONFIDENCE); where.push(`confidence = $${params.length}`); crit.push(`confidence = ${CONFIDENCE}`); }
  if (MIN_PRIORITY) { params.push(parseInt(MIN_PRIORITY, 10) || 0); where.push(`priority >= $${params.length}`); crit.push(`priority >= ${MIN_PRIORITY}`); }

  // Only ever act on rows nobody has decided yet, unless specific ids were named. Re-running a
  // bulk approve must not quietly overturn a rejection made afterwards.
  if (!IDS.length) { where.push(`review_status = 'pending'`); crit.push('review_status = pending'); }

  if (crit.length <= 1) {
    say('✗ that would act on EVERY pending row. Narrow it with --use, --suggested, --supplier,');
    say('  --confidence, --min-priority or --id. A bulk decision needs a stated reason.\n');
    process.exit(1);
  }

  // ── THE TWO REFUSALS ────
  const guard = [];
  if (action === 'approve') {
    guard.push(`use_class IS NOT NULL`);
    // A hold is a row that needs a person looking at THAT row. Only an explicit --id overrides it.
    if (!IDS.length) guard.push(`suggested <> 'hold'`);
  }
  const fullWhere = [...where, ...guard].join(' AND ');

  const rows = (await query(
    `SELECT id, supplier, product_name, cas, use_class, suggested, priority, confidence, source_file
       FROM supplier_products WHERE ${fullWhere}
      ORDER BY priority DESC, supplier, product_name`, params)).rows;

  // What the guards removed, reported rather than silently dropped.
  const unguarded = (await query(
    `SELECT COUNT(*)::int c FROM supplier_products WHERE ${where.join(' AND ')}`, params)).rows[0].c;
  const blocked = unguarded - rows.length;

  say(`\n── ${EVENT} · ${action.toUpperCase()} · ${EXECUTE ? 'WRITING' : 'dry run'}`);
  say(`   criteria: ${crit.join(' · ')}\n`);
  say(`   ${rows.length} row(s) would become "${newStatus}"\n`);

  for (const r of rows.slice(0, 30)) {
    say(`      ${String(r.priority).padStart(3)}  ${String(r.use_class).padEnd(11)} ${(r.product_name || '').slice(0, 36).padEnd(38)} ${(r.cas || '').padEnd(13)} ${r.supplier}`);
  }
  if (rows.length > 30) say(`      … and ${rows.length - 30} more`);
  say();

  if (blocked > 0) {
    say(`   ⚠ ${blocked} row(s) matched the criteria and were REFUSED:`);
    if (action === 'approve') {
      say(`      · rows suggested "hold" — the GLP-1s, controlled substances, cosmetic peptides,`);
      say(`        and rows whose extraction was uncertain. Each needs a person on that row.`);
      say(`      · rows with no use_class — the marketplace cannot render them safely.`);
      say(`      Approve one deliberately with --id=<id> once you have looked at it.`);
    }
    say();
  }

  if (!rows.length) { say('   nothing to do.\n'); return; }

  if (!EXECUTE) { say('   DRY RUN — nothing written. Re-run with --execute.\n'); return; }

  const res = await query(
    `UPDATE supplier_products
        SET review_status = $${params.length + 1},
            reviewed_by   = $${params.length + 2},
            reviewed_at   = NOW(),
            review_note   = COALESCE($${params.length + 3}, review_note),
            updated_at    = NOW()
      WHERE ${fullWhere}
      RETURNING id`,
    [...params, newStatus, BY, NOTE]);

  say(`   ✅ ${res.rows.length} row(s) now "${newStatus}", reviewed_by ${BY}.\n`);

  const after = (await query(
    `SELECT review_status, COUNT(*)::int c FROM supplier_products
      WHERE event_slug = $1 GROUP BY 1 ORDER BY 2 DESC`, [EVENT])).rows;
  for (const a of after) say(`      ${a.review_status.padEnd(10)} ${a.c}`);
  say(`\n   The marketplace handover reads only the approved rows:`);
  say(`      node scripts/export-supplier-products.js --status=approved --format=json\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('review-supplier-products failed:', e && e.message ? e.message : e);
  process.exit(1);
});
