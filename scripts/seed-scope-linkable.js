#!/usr/bin/env node
// ── LINKABLE AT SCOPE: THE TAB THAT SHOWED ZERO ───────────────────────────────
//
//   railway ssh 'node scripts/seed-scope-linkable.js'            → dry run
//   railway ssh 'node scripts/seed-scope-linkable.js --execute'  → writes
//
// The LinkAble tab read "0 companies, 0 exhibiting" and said so confidently: all 61 published SCOPE
// sponsors were checked and not one places people into jobs. That finding is correct and stands —
// SCOPE Europe's exhibitors sell software, data, logistics and lab services TO trial sponsors.
//
// But a tab showing zero is accurate and useless. The other three carry 226, 60 and 60 rows, and
// the fix is not the query: it is the SOURCE. LinkAble's subscribers were never going to be in the
// sponsor list, so they come from research — exactly as the 80 research institutions and 60 labs on
// the other tabs do. None of those are verified SCOPE attendees either. They are the ROOM, to be
// confirmed on site, which is what `exhibiting = false` on every row of this event means.
//
// ── WHAT A LINKABLE SUBSCRIBER IS, AND IS NOT ────────────────────────────────
//
// Naresh corrected this once already and it is the easiest thing to get wrong twice:
//
//   "LinkAble is a recruiting software as a SaaS operating system, recruiting operating system. So
//    where any recruiting company, they can subscribe and they can find the candidates. Another
//    side, they can collaborate with the pharmaceutical companies and find their jobs. NOT the
//    recruit people for ongoing studies. They only recruit employees, like employment agencies."
//
// So: firms that place PEOPLE INTO JOBS. Not patient-recruitment companies, not site networks, not
// functional service providers who staff a trial as a service — those enrol patients or sell
// headcount as delivery, and seeding that kind filled the CPHI tab with 16 companies that would
// never buy a recruiting OS. Every row below is a recruitment agency whose product is placement.
//
// ── WHAT IS SOURCED AND WHAT IS NOT ─────────────────────────────────────────
//
// `hq_city` / `hq_country` are filled ONLY where the firm's own site or a cited directory stated
// them. Several well-known agencies publish no head office at all, and a guessed city on a list
// Naresh walks a floor with is worse than a blank one — the same rule that made marketOfCountry
// return null rather than guess 'row'. Those rows carry no country, the market column stays null,
// and the dry run counts them as "country not stated" rather than hiding them.
//
// ATTENDANCE IS NOT VERIFIED FOR ANY ROW. Say so in the note on every one. The check on site is the
// attendee app, and the whole purpose of this tab is to walk in with names already in hand.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { marketOfCountry } = require('../src/lib/events/country');
const { isRoleOf } = require('../src/lib/events/registry');
const { staleRows } = require('../src/lib/events/stale-rows');

const EVENT = 'scope-europe-2026';
const ROLE = 'linkable';
const EXECUTE = process.argv.includes('--execute');

// Every firm here came from its own website or a cited recruitment directory during the research on
// 2026-10-10. `why` is what goes in front of Naresh at a stand, so it says what they place.
const FIRMS = [
  { name: 'Proclinical', country: null, city: null,
    why: 'Clinical operations and clinical development placement — VP Clinical Operations, Clinical Project Manager, CRA, CTA, across Phase I–IV. Clients are pharma, CROs, biotech and medtech, which is the SCOPE room exactly.',
    source: 'proclinical.com/clinical-research-recruitment', strength: 'strong' },
  { name: 'Barrington James', country: null, city: null,
    why: 'Pharma, biotech, medical device, CRO and CDMO staffing — contract, permanent and executive search. Disciplines include Clinical Operations, Clinical Development, Biometrics and Pharmacovigilance. 10+ global offices.',
    source: 'barringtonjames.com', strength: 'strong' },
  { name: 'QCS Staffing', country: 'GBR', city: 'Berkhamsted',
    why: 'Life sciences recruitment across pharmacovigilance, drug safety, medical affairs and clinical research, plus CQV and compliance. European offices in Berkhamsted, Dublin and Rotterdam.',
    source: 'qcsstaffing.com/our-industries/life-sciences-recruitment', strength: 'strong' },
  { name: 'NonStop Consulting', country: null, city: null,
    why: 'Pharmaceutical and medical device recruitment with named contacts in 17 European countries. Specialisms include clinical research, clinical data management, biostatistics and pharmacovigilance.',
    source: 'nonstopconsulting.com/employers/life-sciences', strength: 'strong' },
  { name: 'RBW Consulting', country: 'GBR', city: 'Brighton',
    why: 'CRO and vendor services, pharma and biotech. Places Clinical Project Managers and Senior Biostatisticians. Brighton, with an office in Crawley.',
    source: 'agencycentral.co.uk clinical trials directory', strength: 'strong' },
  { name: 'SciPro', country: 'GBR', city: 'Bristol',
    why: 'Life sciences recruitment covering clinical and preclinical. Bristol head office with London, Munich, Los Angeles and New York.',
    source: 'agencycentral.co.uk clinical trials directory', strength: 'strong' },
  { name: 'X4 Life Sciences', country: 'GBR', city: 'London',
    why: 'Scientific, clinical and regulatory placement including Biometrics. Covent Garden, London.',
    source: 'agencycentral.co.uk clinical trials directory', strength: 'strong' },
  { name: 'EPM Scientific', country: null, city: null,
    why: 'Permanent and multi-hire life sciences recruitment in R&D, market launch and pharmacovigilance, with a dedicated Swiss pharmaceutical desk. Part of Phaidon International.',
    source: 'epmscientific.com/en-ch/request-talent/pharmaceutical-recruitment', strength: 'strong' },
  { name: 'Chromosome Recruitment', country: 'GBR', city: 'London',
    why: 'Life sciences recruitment including Clinical Operations and Biometry. Poplar, London.',
    source: 'agencycentral.co.uk clinical trials directory', strength: 'medium' },
  { name: 'Duchesse Recruitment', country: 'GBR', city: 'London',
    why: 'Life sciences recruitment including Biometrics and Clinical Development. 7 Bell Yard, Holborn, London.',
    source: 'agencycentral.co.uk clinical trials directory', strength: 'medium' },
  { name: 'Ark Talent Group', country: 'GBR', city: 'Manchester',
    why: 'Life science, healthcare and chemical recruitment including Clinical Research. Manchester, with an Oxford office.',
    source: 'agencycentral.co.uk clinical trials directory', strength: 'medium' },
  { name: 'Star OUTiCO', country: 'GBR', city: 'Rugby',
    why: 'Places healthcare professionals into pharmaceutical, medical device and biotech firms, including Clinical Technical Advisor roles. Rugby, Warwickshire.',
    source: 'agencycentral.co.uk clinical trials directory', strength: 'medium' },
  { name: 'Real Staffing', country: null, city: null,
    why: 'Pharma and biotech, medical devices and diagnostics, and healthcare IT — permanent and contract placement. Part of the SThree group.',
    source: 'lifesciencesreview / cornerstonesg directory', strength: 'medium' },
  { name: 'EU Recruit', country: null, city: null,
    why: 'Life science recruitment and staffing agency positioned on European coverage.',
    source: 'eu-recruit.com/our-sectors/life-sciences', strength: 'medium' },
  { name: 'Thema Group', country: null, city: null,
    why: 'European life sciences recruitment group.',
    source: 'themagroup.eu', strength: 'weak' },
  // Worth a row BECAUSE of the finding rather than in spite of it: ckgroup.co.uk now 302-redirects
  // to talentmark.co.uk, so CK Group appears to have rebranded or been absorbed. Approaching it
  // under the old name would land badly, and nobody would find that out until the conversation.
  { name: 'Talentmark (formerly CK Group)', country: null, city: null,
    why: 'Life science recruitment. NOTE: ckgroup.co.uk now redirects to talentmark.co.uk, so the entity appears to have rebranded or been acquired — confirm who you are speaking to before using either name.',
    source: 'ckgroup.co.uk 302 → talentmark.co.uk, observed 2026-10-10', strength: 'verify' },
];

// The key carries the country for the same reason the delegate seed's does: two firms can normalise
// to one company name, and a key that cannot tell them apart silently overwrites one with the other.
const keyFor = (f) => [normalizeCompany(f.name), f.city ? normalizeCompany(f.city) : '',
                       f.country ? normalizeCompany(f.country) : ''].filter(Boolean).join(' ');

const STRENGTH_LABEL = {
  strong: 'STRONG fit — clinical/pharma placement is their core business',
  medium: 'fit — life science placement, clinical exposure',
  weak: 'thin — confirm what they actually place before spending time',
  verify: 'VERIFY THE ENTITY FIRST',
};

async function main() {
  await initDB();
  if (!isRoleOf(EVENT, ROLE)) throw new Error(`"${ROLE}" is not a role of ${EVENT}`);

  console.log(`── ${EVENT} · LinkAble · the tab that read zero\n`);

  const planned = FIRMS.map((f) => ({
    name: f.name,
    dedupeKey: keyFor(f),
    market: marketOfCountry(f.country),
    note: `Recruitment agency · ${f.city ? f.city + ', ' : ''}${f.country || 'head office not published'}` +
          ` · ${STRENGTH_LABEL[f.strength]} · ${f.why}` +
          ` · ATTENDANCE NOT VERIFIED — check the attendee app on site · source: ${f.source}`,
  }));

  // Collisions before writing, not discovered afterwards as a missing row.
  const seen = new Map();
  const collisions = [];
  for (const p of planned) {
    if (seen.has(p.dedupeKey)) collisions.push([seen.get(p.dedupeKey), p.name]);
    else seen.set(p.dedupeKey, p.name);
  }
  if (collisions.length) {
    console.log('   ✗ key collision — two firms would share one row:');
    for (const [a, b] of collisions) console.log(`      "${a}" + "${b}"`);
    process.exit(1);
  }

  const byStrength = FIRMS.reduce((a, f) => { a[f.strength] = (a[f.strength] || 0) + 1; return a; }, {});
  const placeable = planned.filter((p) => p.market).length;
  console.log(`   ${planned.length} recruitment agencies, all researched on 2026-10-10`);
  console.log(`      ${byStrength.strong || 0} strong fit · ${byStrength.medium || 0} medium · ` +
              `${byStrength.weak || 0} thin · ${byStrength.verify || 0} to verify first`);
  console.log(`      ${placeable} with a published head office, ${planned.length - placeable} without`);
  console.log(`   NOT ONE is a confirmed attendee. This is a list to walk in with, not a floor plan.\n`);
  for (const f of FIRMS) {
    console.log(`      ${f.name.padEnd(34)} ${(f.city || '—').padEnd(13)} ${f.country || '—'}`);
  }

  if (!EXECUTE) {
    console.log('\n   DRY RUN — nothing written. Re-run with --execute.\n');
    return;
  }

  let ins = 0, upd = 0;
  for (const p of planned) {
    const r = await query(
      `INSERT INTO cphi_exhibitor_matches
         (event_slug, holder, holder_normalized, exhibitor_name, exhibiting, booth, hall,
          role, role_note, review_status, match_tier, market,
          studies_count, patients_count, molecules_covered, checked_at)
       VALUES ($1,$2,$3,NULL,false,NULL,NULL,$4,$5,'entity_review',NULL,$6,NULL,NULL,0, NOW())
       ON CONFLICT (event_slug, role, holder_normalized) DO UPDATE
         SET role_note = EXCLUDED.role_note, market = EXCLUDED.market, checked_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [EVENT, p.name, p.dedupeKey, ROLE, p.note, p.market]);
    if (r.rows[0] && r.rows[0].inserted) ins += 1; else upd += 1;
  }

  // Stale rows, scoped to THIS role and THIS event, via the shared helper. Never a role-wide
  // sweep: the delegate seed's cleanup is qc_lab-only because the abiozen role holds 146 sponsor
  // rows a different script owns, and a wider DELETE would take out the six firms on the floor.
  const { removable, keepers } = await staleRows(query, EVENT, ROLE, seen);
  for (const r of keepers) {
    console.log(`\n   ⚠ kept "${r.holder}" — it carries a met flag, a connection or a card.`);
  }
  let removed = 0;
  for (const r of removable) {
    await query(`DELETE FROM cphi_exhibitor_matches WHERE id = $1`, [r.id]);
    removed += 1;
  }

  const final = (await query(
    `SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE exhibiting)::int floor
       FROM cphi_exhibitor_matches WHERE event_slug = $1 AND role = $2`, [EVENT, ROLE])).rows[0];
  console.log(`\n   ✅ ${ins} inserted, ${upd} updated, ${removed} stale removed.`);
  console.log(`   linkable now holds ${final.n} rows, ${final.floor} on the floor.\n`);
  console.log('   The zero finding still stands: none of these is a published SCOPE sponsor, and');
  console.log('   none is a confirmed attendee. They are who to look for in the attendee app.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('seed-scope-linkable failed:', e && e.message ? e.message : e);
  process.exit(1);
});
