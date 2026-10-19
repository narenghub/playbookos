#!/usr/bin/env node
// ── THE HANDOVER FILE FOR THE MARKETPLACE PROJECT ────────────────────────────
//
//   railway ssh 'node scripts/export-supplier-products.js'                  → summary + JSON
//   railway ssh 'node scripts/export-supplier-products.js --format=csv'     → CSV
//   railway ssh 'node scripts/export-supplier-products.js --status=approved' → only what a human approved
//   railway ssh 'node scripts/export-supplier-products.js --use=commercial'  → only commercially supplyable
//
// Read-only. This is the boundary between PlaybookOS and the marketplace: PlaybookOS extracts,
// classifies and holds the review state; the marketplace project reads this and does the listing.
// Nothing here writes to abiozen.com and nothing here needs the marketplace's code.
//
// ── EVERY ROW CARRIES ITS RESTRICTION, AND THAT IS NOT OPTIONAL ─────────────
//
// `use_class` and `listing_notice` ship with every record. A row marked rnd_only must be rendered
// with its notice and must not be offered for commercial supply without a freedom-to-operate
// check. The first extraction run ranked Orforglipron, Inclisiran and Nusinersen at the top of
// the list-these-first pile — all under patent, one not yet approved — because trial activity and
// patent protection are the same signal seen from different sides.
//
// The export therefore REFUSES to emit a row whose use_class is missing. A listing that loses its
// restriction between two systems is exactly the failure this column exists to prevent, and a
// silent NULL is how that happens.
'use strict';

const { initDB, query } = require('../src/lib/db');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FORMAT = (arg('format', 'json') || 'json').toLowerCase();
const STATUS = arg('status', null);          // pending | approved | rejected | held
const USE = arg('use', null);                // commercial | rnd_only
const SUGGESTED = arg('suggested', null);    // list | second_source | hold | reject
const LIMIT = Math.max(1, Math.min(5000, parseInt(arg('limit', '2000'), 10) || 2000));

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  await initDB();

  const where = ['event_slug = $1'];
  const params = [EVENT];
  if (STATUS) { params.push(STATUS); where.push(`review_status = $${params.length}`); }
  if (USE) { params.push(USE); where.push(`use_class = $${params.length}`); }
  if (SUGGESTED) { params.push(SUGGESTED); where.push(`suggested = $${params.length}`); }
  params.push(LIMIT);

  const rows = (await query(
    `SELECT id, supplier, product_name, cas, grade, markers, confidence, name_source,
            use_class, listing_notice, patent_check,
            suggested, suggested_reason, priority,
            review_status, review_note, source_file, source_line, extracted_at
       FROM supplier_products
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY priority DESC, supplier, product_name
      LIMIT $${params.length}`, params)).rows;

  // A row without a use_class cannot be listed safely, so it is not exported at all.
  const unsafe = rows.filter((r) => !r.use_class);
  const safe = rows.filter((r) => r.use_class);

  if (FORMAT === 'csv') {
    const cols = ['id', 'supplier', 'product_name', 'cas', 'grade', 'markers', 'confidence',
      'use_class', 'listing_notice', 'patent_check', 'suggested', 'priority',
      'review_status', 'source_file'];
    console.log(cols.join(','));
    for (const r of safe) console.log(cols.map((c) => csvCell(r[c])).join(','));
    if (unsafe.length) console.error(`\n⚠ ${unsafe.length} row(s) omitted: no use_class. Re-run the extractor.`);
    return;
  }

  if (FORMAT === 'json') {
    console.log(JSON.stringify({
      event: EVENT,
      generated_at: new Date().toISOString(),
      contract: {
        use_class: 'commercial = may be offered for sale. rnd_only = research and development use only.',
        listing_notice: 'When present the marketplace MUST render this on the listing.',
        rule: 'No commercial quote for an rnd_only row without a freedom-to-operate check.',
        provenance: 'Every row carries source_file and source_line — the verbatim line it was read from.',
      },
      count: safe.length,
      omitted_without_use_class: unsafe.length,
      products: safe,
    }, null, 2));
    return;
  }

  // Default: a human-readable summary, which is what you want before shipping a file anywhere.
  const by = (col) => {
    const m = {};
    for (const r of safe) m[r[col] || '(none)'] = (m[r[col] || '(none)'] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  console.log(`\n── ${EVENT} · supplier products · ${safe.length} row(s)\n`);
  for (const [label, col] of [['review status', 'review_status'], ['suggested', 'suggested'],
    ['use class', 'use_class'], ['supplier', 'supplier']]) {
    console.log(`   by ${label}:`);
    for (const [k, v] of by(col).slice(0, 20)) console.log(`      ${String(k).padEnd(28)} ${v}`);
    console.log();
  }
  if (unsafe.length) console.log(`   ⚠ ${unsafe.length} row(s) have no use_class and are excluded from every export.\n`);
  console.log('   --format=json  or  --format=csv  to emit the handover file.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('export-supplier-products failed:', e && e.message ? e.message : e);
  process.exit(1);
});
