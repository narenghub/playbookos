#!/usr/bin/env node
// ── SUPPLIER ATTACHMENTS → REVIEWABLE PRODUCT ROWS ───────────────────────────
//
//   railway ssh 'node scripts/cphi-catalogue-extract.js'                    → dry run
//   railway ssh 'node scripts/cphi-catalogue-extract.js --execute'          → writes
//   railway ssh 'node scripts/cphi-catalogue-extract.js --supplier=Egis'    → one supplier
//   railway ssh 'node scripts/cphi-catalogue-extract.js --show=20'          → print sample rows
//
// Reads the product lists the CPHI suppliers attached, extracts the molecules, classifies each
// one, and writes them to supplier_products as `pending`.
//
// ── IT PUBLISHES NOTHING ────────────────────────────────────────────────────
//
// Not one row reaches abiozen.com from here. Extraction is lossy in a way that matters on a
// pharma listing — a shifted column pairs one product's name with another's CAS number, which is
// a different molecule — so everything lands in the review table with the file and the verbatim
// source line attached, and a human approves it.
//
// Re-running is safe and expected: the upsert refreshes the extracted fields and never touches
// review_status, so improving the parser does not reset decisions already made.
//
// ── IT PRINTS CONTINUOUSLY, ON PURPOSE ──────────────────────────────────────
//
// `railway ssh` hangs up on SILENCE rather than on duration — it killed the CPHI release mid-list
// and then a 550-second backfill that printed nothing. Parsing a 40-page brochure takes a while,
// so every file reports as it is read.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { readIncoming } = require('../src/lib/gmail/incoming');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { pdfToText } = require('../src/lib/catalogue/pdf-text');
const { rowsFromText, rowsFromSheet } = require('../src/lib/catalogue/extract');
const { classifyAll } = require('../src/lib/catalogue/classify');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');
const ONLY = arg('supplier', null);
const SHOW = Math.max(0, parseInt(arg('show', '12'), 10) || 0);
const EXECUTE = process.argv.includes('--execute');
// ── SEE THE TEXT BEFORE BELIEVING A ZERO ────────────────────────────────────
//
// The first live run read twelve PDFs that all HAD a text layer and returned zero products from
// every one of them. Two explanations fit that equally well: these brochures genuinely do not
// print CAS numbers, or the text came out mangled and the extractor never had a chance.
//
// Those lead to opposite fixes — redesign the anchor, or fix the text layer — so guessing between
// them is how a day gets spent on the wrong one. --dump prints what was actually extracted.
const DUMP = Math.max(0, parseInt(arg('dump', '0'), 10) || 0);

const say = (s = '') => console.log(s);
const isPdf = (f) => /\.pdf$/i.test(f.filename) || /pdf/i.test(f.mimeType || '');
const isSheet = (f) => /\.(xlsx|xlsm|xls|csv)$/i.test(f.filename);

// ── WHAT WE ALREADY SELL, AND WHAT ANYONE HAS ASKED FOR ─────────────────────
//
// Both drive the classification: a molecule already listed is a SECOND SOURCE (a price lever),
// and a molecule somebody has asked for goes to the top. Missing tables are not fatal — the
// classifier simply has less to go on, and saying so beats failing.
async function loadContext() {
  const ctx = {
    catalogueCas: new Set(), catalogueNames: new Set(),
    demandCas: new Set(), demandNames: new Set(),
    notes: [],
  };

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // ── THE CATALOGUE IS MATCHED BY NAME, BECAUSE THERE IS NO CAS TO MATCH ON ────
  //
  // `skus` has no cas_number column. The first version of this selected one, which would have
  // thrown, been swallowed by the catch below, and reported "skus unreadable" — quietly disabling
  // second-source detection, the single most valuable outcome here, behind a note that reads like
  // a transient problem.
  //
  // So it matches on name, and SAYS that it is matching on name. A name match is weaker: "
  // Paracetamol" and "Paracetamol BP" are the same molecule and will not match each other, so
  // some second sources will be missed and arrive as new listings. That is the safe direction to
  // fail — a missed price lever costs an opportunity, a false match merges two molecules.
  //
  // Putting CAS numbers on the SKU table would fix it properly and is worth doing.
  try {
    const r = await query(`SELECT name FROM skus WHERE is_active = 1`);
    for (const x of r.rows) if (x.name) ctx.catalogueNames.add(norm(x.name));
    ctx.notes.push(`${r.rows.length} active SKU(s) — matched by NAME, skus holds no CAS`);
  } catch (e) { ctx.notes.push(`skus unreadable (${(e && e.message) || e}) — no catalogue comparison`); }

  try {
    const r = await query(`SELECT DISTINCT molecule_name FROM molecule_pricing WHERE active = 1`);
    for (const x of r.rows) if (x.molecule_name) ctx.catalogueNames.add(norm(x.molecule_name));
    ctx.notes.push(`${r.rows.length} priced molecule(s)`);
  } catch (e) { ctx.notes.push(`molecule_pricing unreadable (${(e && e.message) || e})`); }

  try {
    const r = await query(
      `SELECT DISTINCT molecule_name FROM molecule_dmf_matches WHERE review_status = 'auto_confirmed'`);
    for (const x of r.rows) {
      if (x.molecule_name) ctx.demandNames.add(String(x.molecule_name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    }
    ctx.notes.push(`${r.rows.length} confirmed DMF molecule(s)`);
  } catch (_) { ctx.notes.push('molecule_dmf_matches unreadable'); }

  try {
    const r = await query(`SELECT DISTINCT molecule_name FROM study_molecules LIMIT 5000`);
    for (const x of r.rows) {
      if (x.molecule_name) ctx.demandNames.add(String(x.molecule_name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    }
    ctx.notes.push(`${r.rows.length} molecule(s) named in trials`);
  } catch (_) { ctx.notes.push('study_molecules unreadable'); }

  return ctx;
}

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.error(`✗ "${EVENT}" is not an event.`); process.exit(1); }

  // Fail here rather than after parsing sixteen files.
  if (EXECUTE) {
    try { await query(`SELECT 1 FROM supplier_products LIMIT 1`); }
    catch (_) {
      say('✗ supplier_products does not exist. Run this first:');
      say("     railway ssh 'node scripts/migrate-supplier-products.js'\n");
      process.exit(1);
    }
  }

  const rows = (await query(
    `SELECT st.thread_id, c.id AS contact_id, c.name, c.company
       FROM cphi_followup_state st
       JOIN cphi_exhibitor_contacts c ON c.id = st.contact_id
      WHERE st.event_slug = $1 AND st.status = 'replied' AND st.thread_id IS NOT NULL
      ORDER BY c.company`, [EVENT])).rows
    .filter((r) => !ONLY || new RegExp(ONLY, 'i').test(r.company));

  say(`\n── ${EVENT} · extracting product lists · ${EXECUTE ? 'WRITING' : 'dry run'}\n`);
  if (!rows.length) { say('   nothing to read.\n'); return; }

  const ctx = await loadContext();
  say(`   context: ${ctx.notes.join(' · ')}\n`);

  const g = await gmailClientFor(FROM_MAILBOX);
  if (g.error) { console.error(`   ✗ cannot act as ${FROM_MAILBOX}: ${g.error}`); process.exit(1); }

  const all = [];
  const skipped = [];

  for (const r of rows) {
    let msgs;
    try {
      msgs = ((await g.gmail.users.threads.get({ userId: 'me', id: r.thread_id, format: 'full' })).data.messages) || [];
    } catch (e) { skipped.push(`${r.company}: cannot read thread — ${(e && e.message) || e}`); continue; }

    // Only THEIR attachments: our one-pager rides on every outbound step.
    const files = [];
    for (const m of msgs) {
      const p = readIncoming(m);
      if (!p.fromEmail || p.fromEmail === String(FROM_MAILBOX).toLowerCase()) continue;
      for (const a of p.attachments) files.push({ ...a, messageId: m.id });
    }
    if (!files.length) continue;

    for (const f of files) {
      if (!isPdf(f) && !isSheet(f)) { skipped.push(`${r.company} · ${f.filename}: not a product list format`); continue; }

      say(`   reading  ${r.company} · ${f.filename}`);      // keep-alive: the tunnel hangs up on silence
      let buf;
      try {
        const att = await g.gmail.users.messages.attachments.get(
          { userId: 'me', messageId: f.messageId, id: f.attachmentId });
        buf = Buffer.from(String(att.data.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      } catch (e) { skipped.push(`${r.company} · ${f.filename}: download failed — ${(e && e.message) || e}`); continue; }

      let res;
      try {
        if (isPdf(f)) {
          const t = await pdfToText(buf);
          if (t.empty) {
            skipped.push(`${r.company} · ${f.filename}: ${t.pages} page(s), no text layer — this is a SCAN. Ask for the original file.`);
            say(`      ✗ no text layer (${t.pages} pages) — scanned`);
            continue;
          }
          res = rowsFromText(t.text, { file: f.filename, supplier: r.company });
          say(`      ${t.pages} page(s), ${t.chars} chars, ${res.rows.length} product(s), ${res.stats.high_confidence} high confidence`);
          if (DUMP) {
            const lines = t.text.split('\n').filter((l) => l.trim());
            say(`      ── first ${Math.min(DUMP, lines.length)} non-empty line(s) of ${lines.length}:`);
            for (const l of lines.slice(0, DUMP)) say(`         ${JSON.stringify(l.slice(0, 160))}`);
            say(`      ── ${res.unanchored.length} line(s) look like product names with no CAS:`);
            say(`         ${JSON.stringify(res.unanchored.slice(0, 15))}`);
          }
        } else {
          const XLSX = require('xlsx');
          const wb = XLSX.read(buf, { type: 'buffer' });
          res = { rows: [], unanchored: [], stats: {} };
          for (const sheet of wb.SheetNames) {
            const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: '' });
            const r2 = rowsFromSheet(grid, { file: `${f.filename}#${sheet}`, supplier: r.company });
            res.rows.push(...r2.rows);
          }
          say(`      ${wb.SheetNames.length} sheet(s), ${res.rows.length} product(s)`);
        }
      } catch (e) { skipped.push(`${r.company} · ${f.filename}: parse failed — ${(e && e.message) || e}`); continue; }

      for (const row of res.rows) all.push({ ...row, contact_id: r.contact_id });
    }
  }

  const { rows: classified, counts } = classifyAll(all, ctx);

  say(`\n   ${classified.length} product row(s) from ${rows.length} supplier(s)\n`);
  for (const [k, v] of Object.entries(counts)) say(`      ${k.padEnd(14)} ${v}`);
  say();

  if (SHOW && classified.length) {
    say(`   top ${Math.min(SHOW, classified.length)} by priority:`);
    for (const r of classified.slice(0, SHOW)) {
      say(`      ${String(r.priority).padStart(3)}  ${r.decision.padEnd(14)} ${(r.name || '(no name)').slice(0, 38).padEnd(40)} ${r.cas || ''}`);
      say(`           ${r.supplier} · ${r.source_file}`);
      say(`           ${r.reason}`);
    }
    say();
  }

  if (skipped.length) {
    say(`   ${skipped.length} file(s) not read:`);
    for (const s of skipped) say(`      ${s}`);
    say();
  }

  if (!EXECUTE) {
    say('   DRY RUN — nothing written. Re-run with --execute.\n');
    return;
  }

  let inserted = 0; let refreshed = 0;
  for (const r of classified) {
    // review_status and the reviewed_* columns are absent from the UPDATE on purpose: re-parsing
    // must never reset a decision a human has already made.
    const res = await query(
      `INSERT INTO supplier_products
         (event_slug, contact_id, supplier, supplier_normalized, product_name, cas, grade,
          markers, confidence, name_source, source_file, source_line,
          suggested, suggested_reason, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (event_slug, supplier_normalized, COALESCE(cas, ''), lower(COALESCE(product_name, '')))
       DO UPDATE SET
         grade = EXCLUDED.grade, markers = EXCLUDED.markers,
         confidence = EXCLUDED.confidence, name_source = EXCLUDED.name_source,
         source_file = EXCLUDED.source_file, source_line = EXCLUDED.source_line,
         suggested = EXCLUDED.suggested, suggested_reason = EXCLUDED.suggested_reason,
         priority = EXCLUDED.priority, updated_at = NOW()
       RETURNING (xmax = 0) AS created`,
      [EVENT, r.contact_id || null, r.supplier, normalizeCompany(r.supplier || ''),
       r.name, r.cas, r.grade, JSON.stringify(r.markers || []), r.confidence, r.name_source,
       r.source_file, r.line, r.decision, r.reason, r.priority]);
    if (res.rows[0].created) inserted += 1; else refreshed += 1;
  }

  say(`   ✅ ${inserted} new, ${refreshed} refreshed. All new rows are PENDING — nothing is published.`);

  const pend = (await query(
    `SELECT suggested, COUNT(*)::int c FROM supplier_products
      WHERE event_slug = $1 AND review_status = 'pending' GROUP BY 1 ORDER BY 2 DESC`, [EVENT])).rows;
  say(`\n   waiting for review:`);
  for (const p of pend) say(`      ${String(p.suggested || 'unclassified').padEnd(14)} ${p.c}`);
  say();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('cphi-catalogue-extract failed:', e && e.message ? e.message : e);
  process.exit(1);
});
