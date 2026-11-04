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

// ── STDOUT IS CLAIMED BEFORE ANYTHING ELSE IS REQUIRED ──────────────────────
//
// This block is first ON PURPOSE and must stay first. `pdfjs-dist` prints at REQUIRE time, and it
// prints to STDOUT:
//
//     Warning: Cannot polyfill `DOMMatrix`, rendering may be broken: "Error: Cannot find module
//     'canvas' ... Warning: Cannot polyfill `Path2D` ...
//
// Six lines, before a single statement of this script runs. Claiming the stream further down —
// after the requires, where the other flags are parsed — produced a `--report=json` whose stdout
// began with those warnings and did not parse. The guard was in place and the document was still
// contaminated, because the contamination happened before the guard existed.
//
// So the report flag is read straight off argv here, ahead of every other require. The generalisable
// rule: a payload-emitting script must claim stdout before loading anything that might print, and
// "might print" includes a dependency's startup warning on a machine that lacks an optional
// native module.
const { payloadMode } = require('./lib/clean-stdout');
const REPORT = ((process.argv.find((a) => a.startsWith('--report=')) || '').split('=')[1] || '').toLowerCase();
const REPORTING = REPORT === 'json' || REPORT === 'csv';
const out = REPORTING ? payloadMode() : null;

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { gmailClientFor } = require('../src/lib/gmail/client');
const { readIncoming, looksLikeCatalogue } = require('../src/lib/gmail/incoming');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { pdfToText } = require('../src/lib/catalogue/pdf-text');
const { rowsFromText, rowsFromSheet } = require('../src/lib/catalogue/extract');
const { classifyAll } = require('../src/lib/catalogue/classify');
const { makeDocRegistry, ladder, ladderKey, normName } = require('../src/lib/catalogue/measure');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const FROM_MAILBOX = arg('from', 'naren@abiozen.com');
const ONLY = arg('supplier', null);
const SHOW = Math.max(0, parseInt(arg('show', '12'), 10) || 0);
const EXECUTE = process.argv.includes('--execute');
// ── THE TRACEABILITY REPORT ─────────────────────────────────────────────────
//
//   --report=json   one document, every row with its full provenance
//   --report=csv    the same, for a reviewer in a spreadsheet
//
// Read-only and incompatible with --execute, because a run that both reports and writes invites
// reading the report as a record of what was written. REPORT itself is parsed at the top of the
// file, ahead of the requires — see the note there.
if (REPORTING && EXECUTE) {
  console.error('--report and --execute are mutually exclusive. A run that both reports and writes '
    + 'invites reading the report as a record of what was written. Run the report, read it, then '
    + 'decide about --execute as a separate command.');
  process.exit(2);
}
if (REPORT && !REPORTING) {
  console.error(`--report=${REPORT} is not a format. Use --report=json or --report=csv.`);
  process.exit(2);
}
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
    // Kept APART from demandNames: which set a molecule is in decides whether it can be sold
    // commercially or only for research. See useClass() in lib/catalogue/classify.js.
    dmfNames: new Set(), trialNames: new Set(),
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
      if (!x.molecule_name) continue;
      const n = String(x.molecule_name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      ctx.demandNames.add(n);
      ctx.dmfNames.add(n);
    }
    ctx.notes.push(`${r.rows.length} confirmed DMF molecule(s)`);
  } catch (_) { ctx.notes.push('molecule_dmf_matches unreadable'); }

  try {
    const r = await query(`SELECT DISTINCT molecule_name FROM study_molecules LIMIT 5000`);
    for (const x of r.rows) {
      if (!x.molecule_name) continue;
      const n = String(x.molecule_name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      ctx.demandNames.add(n);
      ctx.trialNames.add(n);
    }
    ctx.notes.push(`${r.rows.length} molecule(s) named in trials`);
  } catch (_) { ctx.notes.push('study_molecules unreadable'); }

  // ── ONE DICTIONARY OF EVERY MOLECULE THE PLATFORM KNOWS ────
  //
  // Most supplier portfolios print no CAS numbers, so the names are the anchor. Catalogue names
  // are included as well as demand names: a supplier listing something we already sell is the
  // second-source case, and missing it because the row had no CAS would lose the most valuable
  // outcome in the exercise.
  ctx.dictionary = new Set([...ctx.demandNames, ...ctx.catalogueNames].filter((n) => n && n.length >= 5));
  ctx.notes.push(`${ctx.dictionary.size} molecule name(s) in the matching dictionary`);

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
  // ── DURABLE DOCUMENT IDENTITY ─────────────────────────────────────────────
  //
  // Sinopep sent `Brochure_3.12.2026_Generic_APIs_Sinopep.pdf` and
  // `Brochure_Generic_APIs_--Sinopep 2026.pdf`: both 24 pages, both 37,094 characters, both 26
  // products. The same document under two names, counted twice in every total.
  //
  // Filename cannot settle that — these differ. Byte equality cannot either, because a document
  // re-saved or re-exported has different bytes and identical content. So identity is the SHA-256
  // of the EXTRACTED CONTENT, whitespace-normalised: what the parser actually read. Two files that
  // yield the same text are the same product list however they were produced.
  //
  // Duplicates are RECORDED, never dropped. The second file is real supplier evidence — they sent
  // it — and deleting it would lose the fact that it arrived. It is marked `duplicate_of` the first
  // and excluded from the distinct-product count.
  // The registry and the ladder live in src/lib/catalogue/measure.js, under test with the real
  // Sinopep duplicate and the real 19-examined/9-contributing shape as fixtures. Replacing one
  // wrong number with nine unverified ones would not be an improvement.
  const { docs, register } = makeDocRegistry();
  // Suppliers who ATTACHED something that could be a product list, readable or not. This is the
  // level between "replied" and "parseable" whose absence let fifteen catalogues sound like nine.
  // `looksLikeCatalogue` is the same predicate cphi-replies.js reports with, so the two agree.
  const suppliersWithCatalogue = new Set();
  const registerDoc = (d) => {
    const doc = register(d);
    if (doc.duplicate_of) {
      say(`      ⟲ identical content to "${doc.duplicate_of}" — counted once, evidence kept`);
    }
    return doc;
  };

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
    if (files.some(looksLikeCatalogue)) suppliersWithCatalogue.add(normalizeCompany(r.company));

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
      let doc = null;
      try {
        if (isPdf(f)) {
          const t = await pdfToText(buf);
          if (t.empty) {
            skipped.push(`${r.company} · ${f.filename}: ${t.pages} page(s), no text layer — this is a SCAN. Ask for the original file.`);
            say(`      ✗ no text layer (${t.pages} pages) — scanned`);
            continue;
          }
          res = rowsFromText(t.text, { file: f.filename, supplier: r.company, dictionary: ctx.dictionary });
          say(`      ${t.pages} page(s), ${t.chars} chars, ${res.rows.length} product(s), ${res.stats.high_confidence} high confidence`);
          doc = registerDoc({ supplier: r.company, filename: f.filename, buf, bytes: buf.length,
            extent: `${t.pages} page(s), ${t.chars} chars`, content: t.text });
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
          const grids = [];
          for (const sheet of wb.SheetNames) {
            const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: '' });
            grids.push(grid);
            const r2 = rowsFromSheet(grid, { file: `${f.filename}#${sheet}`, supplier: r.company, dictionary: ctx.dictionary });
            res.rows.push(...r2.rows);
          }
          say(`      ${wb.SheetNames.length} sheet(s), ${res.rows.length} product(s)`);
          // The parsed cells, not the file bytes: a workbook re-saved by Excel differs byte for
          // byte while holding the same table.
          doc = registerDoc({ supplier: r.company, filename: f.filename, buf, bytes: buf.length,
            extent: `${wb.SheetNames.length} sheet(s)`, content: JSON.stringify(grids) });
        }
      } catch (e) { skipped.push(`${r.company} · ${f.filename}: parse failed — ${(e && e.message) || e}`); continue; }

      for (const row of res.rows) {
        all.push({
          ...row,
          contact_id: r.contact_id,
          doc_index: doc ? doc.index : null,
          source_doc_sha256: doc ? doc.content_sha256 : null,
          duplicate_of_file: doc ? doc.duplicate_of : null,
        });
      }
    }
  }

  const { rows: classified, counts } = classifyAll(all, ctx);

  // ── THE MEASUREMENT LADDER ────────────────────────────────────────────────
  //
  // This used to print `${classified.length} product row(s) from ${rows.length} supplier(s)`, where
  // `rows` is the query above — the suppliers whose threads were EXAMINED. On 4 Nov it read
  // "508 product row(s) from 19 supplier(s)" when nine suppliers had contributed all 508 and the
  // other ten contributed nothing. A number that reads as coverage while measuring the attempt,
  // and it would have gone into a board update as supplier onboarding overstated twofold.
  //
  // Each line below counts a different thing, and none of them is a proxy for another. The two
  // zeros at the bottom are the honest answer and not a gap in the report: clearance is a human
  // judgement about one molecule in one jurisdiction, and nothing here publishes.
  const levels = ladder({ threads: rows, rows: classified, docs, suppliersWithCatalogue,
    normalizeCompany });
  say('');
  for (const [label, n] of levels) say(`   ${String(label).padEnd(44)} ${String(n).padStart(5)}`);
  say('');
  say('   commercially cleared is 0 by definition here: DMF registration is evidence of intent to');
  say('   supply, not freedom to operate. Clearance is per molecule, per jurisdiction, by a human.');
  say('   published is 0: nothing in PlaybookOS writes to abiozen.com.');
  say('');
  for (const [k, v] of Object.entries(counts)) say(`      ${k.padEnd(14)} ${v}`);
  say();
  const dupDocs = docs.filter((d) => d.duplicate_of);
  if (dupDocs.length) {
    say(`   ${dupDocs.length} duplicate document(s), kept as evidence and counted once:`);
    for (const d of dupDocs) {
      say(`      ${d.supplier} · ${d.filename}`);
      say(`         identical extracted content to "${d.duplicate_of}"`);
      say(`         content sha256 ${d.content_sha256.slice(0, 32)}…  (bytes differ: ${
        d.bytes_sha256 !== docs[d.duplicate_of_index].bytes_sha256 ? 'yes' : 'no'})`);
    }
    say();
  }

  // ── THE PER-ROW TRACEABILITY REPORT ───────────────────────────────────────
  //
  // Every row carries where it came from and how its identity was reached, because the disposition
  // cannot be reviewed without that. `cas_provenance` is the field that matters most: a CAS read
  // from the same line as the name is evidence, and a CAS sitting near a name is a guess that
  // happens to look identical once it is in a column.
  if (REPORTING) {
    const canon = (n) => {
      const k = normName(n);
      return {
        on_dmf_register: ctx.dmfNames.has(k),
        named_in_active_trials: ctx.trialNames.has(k),
        matches_existing_catalogue: ctx.catalogueNames.has(k),
      };
    };
    const uncertainty = (r) => {
      const u = [];
      if (!r.cas) u.push('no CAS printed');
      if (r.cas && r.confidence !== 'high') u.push(`CAS not on the name's line (${r.name_source})`);
      if (r.confidence === 'low') u.push('name read from a neighbouring line');
      if (r.name_source === 'dictionary') u.push('name matched by dictionary, not printed as a product');
      if (!r.name) u.push('no name found');
      if (r.duplicate_of_file) u.push('row comes from a duplicate document');
      return u;
    };
    const record = (r) => ({
      source_supplier: r.supplier,
      source_document: r.source_file,
      source_document_sha256: r.source_doc_sha256,
      source_line: r.line,
      extracted_name: r.name,
      cas: r.cas || null,
      cas_provenance: r.cas ? (r.confidence === 'high' ? 'printed on the same line as the name'
        : `NOT on the name's line — ${r.name_source}`) : 'none printed',
      identity_verified: Boolean(r.cas && r.confidence === 'high'),
      grade: r.grade || null,
      markers: r.markers || null,
      duplicate_classification: r.duplicate_of_file
        ? `duplicate of ${r.duplicate_of_file} (identical extracted content)` : 'unique document',
      canonical_match: canon(r.name),
      uncertainty: uncertainty(r),
      use_class: r.use_class || null,
      listing_notice: r.listing_notice || null,
      patent_check: r.patent_check || null,
      proposed_disposition: r.decision,
      proposed_reason: r.reason,
      priority: r.priority,
    });

    if (REPORT === 'json') {
      out.emitJson({
        event: EVENT,
        generated_at: new Date().toISOString(),
        wrote_nothing: true,
        measurement: Object.fromEntries(levels.map(([k, v]) => [ladderKey(k), v])),
        rules: {
          identity: 'identity_verified requires a checksum-valid CAS printed on the same line as the '
            + 'name. An adjacent CAS or a name similarity is NOT identity.',
          clearance: 'DMF registration is evidence of intent to supply, not freedom to operate. '
            + 'commercially_cleared_products is 0 until a human clears a molecule for a jurisdiction.',
          duplicates: 'Duplicate documents are recorded, never deleted — the supplier did send them.',
        },
        documents: docs,
        rows: classified.map(record),
      });
    } else {
      const cols = ['source_supplier', 'source_document', 'source_line', 'extracted_name', 'cas',
        'cas_provenance', 'identity_verified', 'grade', 'duplicate_classification', 'use_class',
        'listing_notice', 'proposed_disposition', 'proposed_reason', 'priority', 'uncertainty'];
      const cell = (v) => {
        const s = v == null ? '' : (Array.isArray(v) ? v.join('; ') : String(v));
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      out.emitLine(cols.join(','));
      for (const r of classified) {
        const rec = record(r);
        out.emitLine(cols.map((c) => cell(rec[c])).join(','));
      }
    }
    return;                                  // a report NEVER falls through to the write path
  }

  if (SHOW && classified.length) {
    say(`   top ${Math.min(SHOW, classified.length)} by priority:`);
    for (const r of classified.slice(0, SHOW)) {
      say(`      ${String(r.priority).padStart(3)}  ${r.decision.padEnd(14)} ${String(r.use_class || '').padEnd(11)} ${(r.name || '(no name)').slice(0, 34).padEnd(36)} ${r.cas || ''}`);
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
          suggested, suggested_reason, priority, use_class, listing_notice, patent_check)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (event_slug, supplier_normalized, COALESCE(cas, ''), lower(COALESCE(product_name, '')))
       DO UPDATE SET
         grade = EXCLUDED.grade, markers = EXCLUDED.markers,
         confidence = EXCLUDED.confidence, name_source = EXCLUDED.name_source,
         source_file = EXCLUDED.source_file, source_line = EXCLUDED.source_line,
         suggested = EXCLUDED.suggested, suggested_reason = EXCLUDED.suggested_reason,
         priority = EXCLUDED.priority, use_class = EXCLUDED.use_class,
         listing_notice = EXCLUDED.listing_notice, patent_check = EXCLUDED.patent_check,
         updated_at = NOW()
       RETURNING (xmax = 0) AS created`,
      [EVENT, r.contact_id || null, r.supplier, normalizeCompany(r.supplier || ''),
       r.name, r.cas, r.grade, JSON.stringify(r.markers || []), r.confidence, r.name_source,
       r.source_file, r.line, r.decision, r.reason, r.priority,
       r.use_class || null, r.listing_notice || null, r.patent_check || null]);
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
