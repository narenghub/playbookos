#!/usr/bin/env node
// ── SUPPLIER IF THE COMPANY IS IN OUR SUPPLIER DATA, OTHERWISE BUYER ──────────
//
//   railway ssh 'node scripts/classify-by-supplier-list.js --emails=a@b.com,c@d.com'
//   railway ssh 'node scripts/classify-by-supplier-list.js --emails=a@b.com --execute'
//
// Naren's rule, 12 Oct: "Granules and GP Pharm, those are suppliers. And just cross check are
// their supplier name in a supplier list or not. If not, add them as a buyer."
//
// ── THREE OUTCOMES, NOT TWO ──────────────────────────────────────────────────
//
// The rule reads as a two-way branch, and implementing it as one would be a mistake. "Not in the
// supplier list" has two completely different causes:
//
//   1. We looked, the name is searchable, and it genuinely is not there  → buyer, per the rule.
//   2. We could not look properly, because the name is too short or too generic to match on.
//
// `GP-Pharm` is case 2. Its brand core normalises to "gp", and canAnchor() refuses a two-character
// prefix because it would match every unrelated company starting "gp". So a name search returns
// nothing — and reading that as "not a supplier" would file a man who makes drug product as a
// buyer, on the strength of a search that never ran. Case 2 is reported as INCONCLUSIVE and is
// never written. A wrong role is not a cosmetic error: it decides which of three emails he gets.
//
// ── WHAT COUNTS AS "A SUPPLIER LIST" ─────────────────────────────────────────
//
// Three sources, reported separately because they disagree for good reasons:
//
//   · dmf_holders — the FDA Drug Master File register. The hard evidence: a company with an ACTIVE
//     TYPE II DMF files drug substances with the FDA, which is as close to proof of being an API
//     supplier as this data gets. Types III/IV/V are packaging and excipients and are counted
//     separately, because a company with only those is a packager, not an API source.
//   · suppliers — our own table. Being in it means somebody here already decided they are one.
//   · cphi_exhibitor_matches role='supplier' — already classified as a supplier at some show.
//
// A hit in ANY of them is enough for supplier. The register being quarterly and ~10 weeks stale at
// show time is exactly why absence from it alone is not proof of the opposite.
//
// Writing goes through setOne() in set-contact-role.js — the one piece of code that writes a role,
// with the already-emailed warning, the duplicate-address refusal and the read-back through the
// export's own join. A second write path would be a second set of guards.
'use strict';

const { initDB, query: dbQuery } = require('../src/lib/db');
const { isEvent, isRoleOf } = require('../src/lib/events/registry');
const { normalizeCompany, companyCore, canAnchor } = require('../src/lib/cphi/match-company');
const { setOne } = require('./set-contact-role');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const EMAILS = (arg('emails', '') || '').split(',').map((e) => e.trim()).filter(Boolean);
const EXECUTE = process.argv.includes('--execute');

/**
 * Evidence that `company` is a supplier. Returns { supplier, searchable, why, detail }.
 *
 * `deps.query` is injectable so check-supplier-classify-sql.js can run these statements against a
 * throwaway Postgres. db.js forces SSL whenever DATABASE_URL is set and a temp server does not
 * speak it — and changing how production connects to its database, to make a checker convenient,
 * while a live campaign is sending, is not a trade worth making.
 */
async function supplierEvidence(company, deps = {}) {
  const query = deps.query || dbQuery;
  const norm = normalizeCompany(company);
  const core = companyCore(company);
  const anchorable = canAnchor(core);
  const detail = [];

  // ── 1. FDA DMF register ────
  // Exact normalised match always; a prefix match only when the core can safely anchor.
  const dmf = (await query(
    `SELECT holder,
            COUNT(*) FILTER (WHERE status = 'A' AND dmf_type = 'II')::int AS active_type_ii,
            COUNT(*)::int AS all_dmfs
       FROM dmf_holders
      WHERE holder_normalized = $1
         OR ($2::boolean AND holder_normalized LIKE $3)
      GROUP BY holder
      ORDER BY active_type_ii DESC, all_dmfs DESC
      LIMIT 8`,
    [norm, anchorable, `${core} %`])).rows;

  const activeII = dmf.reduce((n, r) => n + r.active_type_ii, 0);
  if (dmf.length) {
    detail.push(`FDA DMF register: ${dmf.length} holder name(s), ${activeII} active Type II`);
    for (const r of dmf) {
      detail.push(`   ${r.holder} — ${r.active_type_ii} active Type II of ${r.all_dmfs} DMF(s)`);
    }
    if (!activeII) {
      detail.push('   ⚠ none are active Type II — DMFs may be packaging or excipients only');
    }
  }

  // ── 2. Our own suppliers table ────
  const ours = (await query(
    `SELECT id, name, country, gmp_certified FROM suppliers
      WHERE lower(name) = lower($1) OR ($2::boolean AND lower(name) LIKE $3)
      LIMIT 5`, [company, anchorable, `${core}%`])).rows;
  for (const s of ours) {
    detail.push(`suppliers table: ${s.name}${s.country ? ` (${s.country})` : ''}`
      + `${s.gmp_certified ? ' · GMP' : ''}`);
  }

  // ── 3. Already a supplier at some show ────
  const shows = (await query(
    `SELECT DISTINCT event_slug, holder FROM cphi_exhibitor_matches
      WHERE role = 'supplier' AND holder_normalized = $1 LIMIT 5`, [norm])).rows;
  for (const s of shows) detail.push(`already supplier at ${s.event_slug}: ${s.holder}`);

  const supplier = !!(activeII || dmf.length || ours.length || shows.length);
  if (supplier) {
    return { supplier: true, searchable: true,
      why: activeII ? `${activeII} active Type II DMF(s)`
        : dmf.length ? 'in the FDA DMF register, but no active Type II'
        : ours.length ? 'in our own suppliers table'
        : 'already classified supplier at another show',
      detail };
  }

  // Nothing found. Was the search capable of finding anything?
  if (!anchorable) {
    return { supplier: false, searchable: false,
      why: `the brand core is "${core}" — too short or too generic to search on, so this `
        + `"not found" is a failed search rather than an answer`,
      detail };
  }
  return { supplier: false, searchable: true,
    why: `searched the DMF register, our suppliers table and prior shows on "${core}" — no match`,
    detail };
}

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.log(`✗ "${EVENT}" is not an event.`); process.exit(1); }
  if (!isRoleOf(EVENT, 'supplier') || !isRoleOf(EVENT, 'buyer')) {
    console.log(`✗ ${EVENT} does not have both supplier and buyer roles.`); process.exit(1);
  }
  if (!EMAILS.length) {
    console.log('✗ --emails=a@b.com,c@d.com is required.');
    console.log('  scripts/set-contact-role.js with no arguments lists who has no role.');
    process.exit(1);
  }

  console.log(`── ${EVENT} · supplier-list cross-check · ${EXECUTE ? 'WRITING' : 'dry run'}\n`);

  const decided = [];
  const inconclusive = [];

  for (const email of EMAILS) {
    const c = (await dbQuery(
      `SELECT c.id, c.name, c.company, c.title, x.role
         FROM cphi_exhibitor_contacts c
         LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
        WHERE c.event_slug = $1 AND lower(c.email) = lower($2)`, [EVENT, email])).rows;

    if (!c.length) { console.log(`✗ ${email}: no contact under ${EVENT}\n`); inconclusive.push({ email, why: 'no such contact' }); continue; }
    if (c.length > 1) { console.log(`✗ ${email}: ${c.length} contacts share this address\n`); inconclusive.push({ email, why: 'duplicate address' }); continue; }

    const r = c[0];
    const ev = await supplierEvidence(r.company);

    console.log(`   ${r.name} — ${r.company}`);
    if (r.title) console.log(`      ${r.title}`);
    console.log(`      current role  ${r.role || '(none — receives nothing)'}`);
    for (const d of ev.detail) console.log(`      ${d}`);

    if (!ev.searchable) {
      console.log(`      ⟡ INCONCLUSIVE — ${ev.why}`);
      console.log(`        Not written. Reading a failed search as "not a supplier" would file`);
      console.log(`        them as a buyer on evidence that was never gathered.`);
      console.log(`        Decide by hand:  node scripts/set-contact-role.js --email=${email} --role=<supplier|buyer> --execute\n`);
      inconclusive.push({ email, name: r.name, company: r.company, why: ev.why });
      continue;
    }

    const role = ev.supplier ? 'supplier' : 'buyer';
    console.log(`      → ${role.toUpperCase()}  (${ev.why})\n`);
    decided.push({ email, role, name: r.name, company: r.company });
  }

  if (!EXECUTE) {
    console.log(`   ${decided.length} would be set, ${inconclusive.length} inconclusive.`);
    console.log('   DRY RUN — nothing written. Re-run with --execute.\n');
    return;
  }

  let ok = 0;
  const failed = [];
  for (const d of decided) {
    const res = await setOne({ email: d.email, role: d.role, event: EVENT, execute: true });
    if (res.ok) ok += 1; else failed.push({ ...d, why: res.why });
  }

  console.log(`   ── ${ok} of ${decided.length} set.`);
  for (const f of failed) console.log(`   ✗ ${f.email}: ${f.why}`);
  if (inconclusive.length) {
    console.log(`   ⟡ ${inconclusive.length} left for a human:`);
    for (const i of inconclusive) console.log(`      ${i.name || i.email} — ${i.why}`);
  }
  const left = (await dbQuery(
    `SELECT COUNT(*)::int n FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1 AND x.role IS NULL`, [EVENT])).rows[0].n;
  console.log(`   ${left} contact(s) still have no role.\n`);
  if (failed.length) process.exit(1);
}

// Only when run directly, so the checker can require supplierEvidence and EXECUTE it against a
// real Postgres rather than grepping this file for the words in its queries. A grep proves the
// words are present; it cannot prove the query runs, and this file names columns across three
// tables I did not write.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('classify-by-supplier-list failed:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { supplierEvidence };
