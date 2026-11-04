#!/usr/bin/env node
// ── WHAT THE FIVE SKUs ACTUALLY SAY, AND WHERE THEY ARE PUBLISHED ────────────
//
//   railway ssh 'node scripts/sku-listing-audit.js'
//   railway ssh 'node scripts/sku-listing-audit.js --report=json'
//
// READ-ONLY, and strictly so. No INSERT, UPDATE, DELETE, CREATE or ALTER against any database;
// the Algolia call is a SEARCH, never an index write; nothing is published, unpublished or altered.
//
// ── WHY IT READS THREE PLACES ───────────────────────────────────────────────
//
// "Publication state" is not one fact in one table. A SKU can exist in PlaybookOS, appear in the
// Algolia index that powers search, and exist as a product row on abiozen.com, and those three can
// disagree. A compliance review that reads only `skus` would report that nothing is published while
// a listing is live and searchable.
//
//   PlaybookOS `skus`      the commercial record: titles, labels, prices, is_active
//   Algolia                what SEARCH will return — a stale index keeps selling a delisted item
//   abiozen.com (Django)   the marketplace itself, via ABIOZEN_DATABASE_URL
//
// Each is reported separately and labelled. Where a source cannot be reached, that is reported as
// UNKNOWN and never as "not published" — the difference matters when the question is whether a
// restricted product is on sale.
//
// ── IT MAKES NO COMPLIANCE JUDGEMENT ───────────────────────────────────────
//
// It prints what the listing says. It does not decide whether a product may be sold, whether a
// claim is permissible, or whether a notice is adequate. Those are human decisions about one
// molecule in one jurisdiction on one date, and a script that offered them would be read as having
// made them.
'use strict';

const { payloadMode } = require('./lib/clean-stdout');
const REPORT = ((process.argv.find((a) => a.startsWith('--report=')) || '').split('=')[1] || '').toLowerCase();
const REPORTING = REPORT === 'json';
const out = REPORTING ? payloadMode() : null;

const { initDB, query } = require('../src/lib/db');

if (REPORT && !REPORTING) {
  console.error(`--report=${REPORT} is not a format. Use --report=json.`);
  process.exit(2);
}

const say = (s = '') => (REPORTING ? null : console.log(s));
const field = (k, v) => say(`     ${String(k).padEnd(24)} ${v === null || v === undefined ? '(null)' : v}`);

// Words that make a claim about human use, treatment or quality. Their PRESENCE is reported, never
// judged: "99%" is a purity claim whoever wrote it, and "research use only" is a restriction whose
// absence is as informative as its presence.
const CLAIM_WORDS = [
  'research use', 'ruo', 'not for human', 'laboratory use', 'investigational',
  'gmp', 'usp', 'ep ', 'pharmaceutical grade', 'clinical', 'therapeutic', 'treat', 'cure',
  'dose', 'dosage', 'injection', 'patient', 'prescription', 'api',
];
const claimsIn = (text) => {
  const t = String(text || '').toLowerCase();
  return CLAIM_WORDS.filter((w) => t.includes(w));
};
const PURITY = /\b\d{2}(\.\d+)?\s*%/;

(async () => {
  await initDB();

  say('\n── the five SKUs · listing and publication audit · READ-ONLY\n');

  // ── 1. THE COMMERCIAL RECORD, EVERY COLUMN ────────────────────────────────
  const cols = (await query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'skus' ORDER BY ordinal_position`)).rows;
  say(`   skus columns (${cols.length}): ${cols.map((c) => c.column_name).join(', ')}\n`);

  const skus = (await query('SELECT * FROM skus ORDER BY is_active DESC, name')).rows;
  const active = skus.filter((s) => s.is_active === 1 || s.is_active === true);
  say(`   ${skus.length} SKU row(s), ${active.length} active\n`);

  // ── 2. ALGOLIA — WHAT SEARCH WOULD RETURN ─────────────────────────────────
  //
  // A search index is the listing a buyer actually meets. It is also the component most likely to
  // be stale: deactivating a SKU in Postgres does not remove it from Algolia, so an index record
  // can keep a withdrawn product discoverable and orderable.
  const appId = process.env.ALGOLIA_APP_ID;
  // ALGOLIA_SEARCH_KEY ONLY — never ALGOLIA_API_KEY, which is the write key.
  //
  // Falling back to the write key would make this script read-only by behaviour rather than by
  // capability: the credential in play could add, overwrite or delete index records, and the only
  // thing preventing it would be that the code does not currently ask. That is the same shape as
  // "it will be refused anyway" — a prediction, not a safeguard. With no search key the audit
  // reports the index as NOT QUERIED, which is an honest gap.
  const searchKey = process.env.ALGOLIA_SEARCH_KEY;
  const indexName = process.env.ALGOLIA_INDEX_NAME || 'abiozen_products';
  let algolia = { reachable: false, reason: 'not attempted', hits: {} };

  if (!appId || !searchKey) {
    algolia.reason = appId
      ? 'ALGOLIA_SEARCH_KEY is not set. The write key is deliberately NOT used as a fallback.'
      : 'ALGOLIA_APP_ID is not set in this environment';
  } else {
    algolia = { reachable: true, reason: null, index: indexName, hits: {} };
    for (const s of skus) {
      try {
        const res = await fetch(
          `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`, {
            method: 'POST',
            headers: {
              'X-Algolia-Application-Id': appId,
              'X-Algolia-API-Key': searchKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: s.name, hitsPerPage: 5 }),
          });
        if (!res.ok) { algolia.hits[s.name] = { error: `HTTP ${res.status}` }; continue; }
        const body = await res.json();
        algolia.hits[s.name] = {
          nbHits: body.nbHits,
          records: (body.hits || []).slice(0, 3).map((h) => ({
            objectID: h.objectID,
            name: h.name || h.title || h.product_name || null,
            is_active: h.is_active ?? null,
            price: h.sale_price ?? h.price ?? null,
            notice: h.listing_notice || h.use_class || null,
          })),
        };
      } catch (e) {
        algolia.hits[s.name] = { error: String((e && e.message) || e) };
      }
    }
  }

  // ── 3. THE MARKETPLACE ITSELF ─────────────────────────────────────────────
  //
  // abiozen.com runs on its own Django database. Read-only, and it fails SOFT: an unreachable
  // marketplace is reported as UNKNOWN, because "we could not look" and "it is not published" are
  // different answers and only one of them is safe to act on.
  let marketplace = { reachable: false, reason: 'ABIOZEN_DATABASE_URL not set', tables: [], matches: [] };
  if (process.env.ABIOZEN_DATABASE_URL) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.ABIOZEN_DATABASE_URL, ssl: false,
        connectionTimeoutMillis: 8000, max: 2 });
      try {
        const t = await pool.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name ~* 'product|sku|listing|item'
            ORDER BY table_name`);
        marketplace = { reachable: true, reason: null, tables: t.rows.map((r) => r.table_name), matches: [] };

        for (const tbl of marketplace.tables) {
          const nameCols = (await pool.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = $1 AND column_name ~* 'name|title'`, [tbl])).rows.map((r) => r.column_name);
          if (!nameCols.length) continue;
          for (const col of nameCols) {
            for (const s of active) {
              // Parameterised, ILIKE, SELECT only. Identity is NOT being asserted here — a name
              // match says a listing mentions this text, nothing more.
              const r = await pool.query(
                `SELECT COUNT(*)::int n FROM "${tbl}" WHERE "${col}" ILIKE $1`, [`%${s.name.split(' ')[0]}%`]);
              if (r.rows[0].n) {
                marketplace.matches.push({ table: tbl, column: col, sku: s.name, rows: r.rows[0].n,
                  caveat: 'a NAME match in a marketplace table — not an identity, and not proof of '
                    + 'publication state' });
              }
            }
          }
        }
      } finally { await pool.end().catch(() => {}); }
    } catch (e) {
      marketplace = { reachable: false, reason: String((e && e.message) || e), tables: [], matches: [] };
    }
  }

  // ── REPORT ────────────────────────────────────────────────────────────────
  const records = skus.map((s) => {
    const text = [s.name, s.category, s.supplier].filter(Boolean).join(' | ');
    const noticeFields = Object.keys(s).filter((k) => /notice|use_class|restrict|warn|disclaim/i.test(k));
    return {
      id: s.id,
      name: s.name,
      category: s.category || null,
      supplier_on_row: s.supplier || null,
      cas_number: Object.prototype.hasOwnProperty.call(s, 'cas_number') ? (s.cas_number || null) : '(no column)',
      is_active: s.is_active,
      is_gmp: s.is_gmp,
      sale_price: s.sale_price,
      units_sold: s.units_sold,
      units_in_stock: s.units_in_stock,
      lead_time_days: s.lead_time_days,
      purity_claim_in_title: PURITY.test(s.name) ? (s.name.match(PURITY) || [])[0] : null,
      // SUPPLIER DOCUMENTATION — its own category per the ruling, and omitted by the first
      // version of this audit, which listed 23 column names and then displayed a hand-picked
      // subset. A report that names a field and does not show it is worse than one that never
      // looked: the reader believes it was checked.
      purity_field: Object.prototype.hasOwnProperty.call(s, 'purity') ? (s.purity ?? null) : '(no column)',
      currency: Object.prototype.hasOwnProperty.call(s, 'currency') ? (s.currency ?? null) : '(no column)',
      sds_link: s.sds_link ?? null,
      sds_status: s.sds_status ?? null,
      coa_link: s.coa_link ?? null,
      coa_status: s.coa_status ?? null,
      owner_user_id: s.owner_user_id ?? null,
      // Every remaining column, verbatim, so nothing is hidden by my choice of what to print.
      all_columns: Object.fromEntries(Object.entries(s)),
      claim_words_present: claimsIn(text),
      research_use_notice_present: /research use|not for human|ruo|laboratory use/i.test(text),
      buyer_restriction_fields_on_row: noticeFields.length ? noticeFields : [],
      algolia: algolia.hits[s.name] || null,
    };
  });

  if (!REPORTING) {
    for (const r of records) {
      say(`── ${r.name}   [${r.id}]   ${r.is_active ? 'ACTIVE' : 'inactive'}`);
      field('category', r.category);
      field('supplier on row', r.supplier_on_row);
      field('cas_number', r.cas_number);
      field('is_gmp', r.is_gmp);
      field('sale price', r.sale_price);
      field('units sold / stock', `${r.units_sold} / ${r.units_in_stock}`);
      field('purity claim in title', r.purity_claim_in_title || 'none');
      field('purity field', r.purity_field);
      field('currency', r.currency);
      field('CoA', `${r.coa_status || '(no status)'}  ${r.coa_link || '(no link)'}`);
      field('SDS', `${r.sds_status || '(no status)'}  ${r.sds_link || '(no link)'}`);
      field('owner_user_id', r.owner_user_id);
      field('claim words present', r.claim_words_present.length ? r.claim_words_present.join(', ') : 'none');
      field('research-use notice', r.research_use_notice_present ? 'PRESENT' : 'ABSENT');
      field('restriction columns', r.buyer_restriction_fields_on_row.length
        ? r.buyer_restriction_fields_on_row.join(', ') : 'NONE on the skus table');
      if (r.algolia && r.algolia.error) field('algolia', `could not query — ${r.algolia.error}`);
      else if (r.algolia) {
        field('algolia hits', r.algolia.nbHits);
        for (const h of r.algolia.records) {
          say(`        ${h.objectID}  ${String(h.name || '').slice(0, 34).padEnd(36)}`
            + ` active=${h.is_active === null || h.is_active === undefined ? 'NO SUCH FIELD' : h.is_active}`
            + ` price=${h.price} notice=${h.notice || 'none'}`);
          if (h.is_active === null || h.is_active === undefined) {
            say('           ⚠ the index record carries NO is_active field, so deactivating this SKU');
            say('             in Postgres cannot make it stop being returned by search');
          }
        }
      } else field('algolia', 'not queried');
      say('');
    }

    say('── ALGOLIA ──');
    say(`   ${algolia.reachable ? `index "${algolia.index}" queried` : `NOT QUERIED — ${algolia.reason}`}`);
    say('   A search index is the listing a buyer actually meets, and it does not follow');
    say('   is_active in Postgres. A stale record keeps a withdrawn product discoverable.\n');

    say('── MARKETPLACE (abiozen.com) ──');
    if (!marketplace.reachable) {
      say(`   UNKNOWN — could not look: ${marketplace.reason}`);
      say('   This is NOT the same as "not published". Only one of those is safe to act on.\n');
    } else {
      say(`   product-like tables: ${marketplace.tables.join(', ') || '(none found)'}`);
      if (!marketplace.matches.length) say('   no name match for any active SKU in those tables');
      for (const m of marketplace.matches) {
        say(`   ${m.sku} → ${m.table}.${m.column}: ${m.rows} row(s) mention it`);
      }
      say('   Every line above is a NAME match in a marketplace table. It is not an identity and');
      say('   not proof of publication state — only that a listing mentions this text.\n');
    }

    say('── WHAT THIS AUDIT DOES NOT DECIDE ──\n');
    say('   Whether any of these may lawfully be sold, whether a claim is permissible, whether a');
    say('   notice is adequate, or whether a listing should be withdrawn. Those are human');
    say('   decisions about one molecule, one jurisdiction, one date.');
    say('\n   Nothing was written, published, unpublished or altered.\n');
    process.exit(0);
  }

  out.emitJson({
    generated_at: new Date().toISOString(),
    wrote_nothing: true, published_nothing: true, made_no_compliance_judgement: true,
    skus_columns: cols,
    skus: records,
    algolia: { reachable: algolia.reachable, reason: algolia.reason, index: algolia.index || null },
    marketplace,
    caveats: {
      name_matches: 'Every marketplace and Algolia match is a NAME match. Not an identity.',
      unknown_vs_absent: 'An unreachable source is reported UNKNOWN, never as "not published".',
      no_judgement: 'This report makes no compliance determination.',
    },
  });
  process.exit(0);
})().catch((e) => {
  console.error(`\nsku-listing-audit failed: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
