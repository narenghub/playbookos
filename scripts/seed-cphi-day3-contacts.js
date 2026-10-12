#!/usr/bin/env node
// ── THE LAST-DAY CARDS FROM CPHI MILAN ────────────────────────────────────────
//
//   railway ssh 'node scripts/seed-cphi-day3-contacts.js'            → dry run
//   railway ssh 'node scripts/seed-cphi-day3-contacts.js --execute'  → writes
//
// Twenty cards photographed on 2026-10-12, transcribed field by field. Each one creates or finds
// a match row carrying the ROLE — which is what decides the campaign — and a contact row under it.
//
// ── WHY THE ROLE IS ASSIGNED HERE AND NOT GUESSED LATER ──────────────────────
//
// scripts/export-cphi-contacts.js refuses to put a contact in a campaign without a role, because
// sending a sourcing request to somebody who came to buy is the one mistake that cannot be walked
// back. The role has to come from somewhere, and the only place it can honestly come from is the
// card plus what the person said at the stand.
//
// So every row below carries `why` — the reason for its classification, from the card itself. Where
// the card genuinely does not settle it, the row is marked `confirm: true`, reported separately,
// and NOT given a role until a human says. Four rows are in that state and they are the ones worth
// reading.
//
// ── THREE OF THESE ARE THE WARMEST LEADS ON THE LIST ─────────────────────────
//
// The LabConnect notes record that Almac, Thermo Fisher and Cambrex each said their EU and US
// analytical units could support the model, gave business development contacts, and scheduled
// follow-up calls. Two of those three are in this batch — Almac (Joanne McClelland) and Cambrex
// (Melissa Huang). They are not cold follow-ups; they are scheduled conversations, and they should
// not sit behind twelve API suppliers in a queue.
//
// Thermo Fisher is still missing. If that card exists it belongs here too.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { isEvent, isRoleOf } = require('../src/lib/events/registry');

// ── THE SLUG IS 'cphi-milan-2026', NOT 'cphi' ────────────────────────────────
//
// The first version of this script said 'cphi'. That is not an event: the registry calls it
// cphi-milan-2026, and both earlier contact seeds use that. So twenty cards were written under a
// slug nothing else uses, isolated from the sixty-one contacts already collected — and the export
// script, whose default was ALSO 'cphi', would have found exactly those twenty and reported them
// as the whole list. Two mistakes that cancelled each other into something that looked right.
//
// isEvent() below is the fix that matters more than the string: a slug that is not a real event
// now stops the run instead of quietly creating a phantom one.
const EVENT = 'cphi-milan-2026';
const EXECUTE = process.argv.includes('--execute');
const MET_AT = '2026-10-08';   // the last day of the show, which is when these were collected

// role: supplier | buyer | qc_lab | platform_partner | null (null = needs a human)
const CARDS = [
  // ── SUPPLIERS: API and intermediate manufacturers ────
  { company: 'Alivus Life Sciences Limited', name: 'Gautam Arora',
    title: 'Vice President, Sales & Marketing', email: 'Gautam.Arora@alivus.com',
    mobile: '+1 201 574 3602', website: 'www.alivus.com',
    address: 'Park 80 West, 250 Pehle Avenue, Suite 200, Saddle Brook, NJ 07663, USA',
    role: 'supplier', why: 'API manufacturer — formerly Glenmark Life Sciences',
    note: 'Card prints "formerly Glenmark Life Sciences Limited" — use the Alivus name.' },

  { company: 'Micro Labs Limited', name: 'Nagaraj Naik',
    title: 'Manager — Business Development (API)', email: 'nagaraj.naik@microlabs.in',
    mobile: '+91 87489 04767', office: '+91 80 22370451',
    address: '31 Race Course Road, Bangalore 560001, India',
    role: 'supplier', why: 'title is API business development' },

  { company: 'Zhejiang Xianju Pharmaceutical Co., Ltd.', name: 'Zhu Jiang',
    title: 'Regional Sales Manager, International Trade Department', email: 'zhujiang@xjpharma.com',
    mobile: '+86 15867631535', office: '+86 576 87713086', website: 'www.xjpharma.com',
    role: 'supplier', why: 'Chinese API manufacturer, international sales',
    greeting: 'Jiang',
    note: 'Card is 朱江 — ZHU is the FAMILY name and JIANG the given name. Greet "Jiang", never "Zhu".' },

  { company: 'Cipla Ltd', name: 'Sanjay Joseph',
    title: 'Vice President and Head — API Business', email: 'sanjayjoseph@cipla.com',
    mobile: '+91 82916 10248', website: 'www.cipla.com',
    address: 'Peninsula Business Park, Tower A, Lower Parel, Mumbai 400013, India',
    role: 'supplier', why: 'heads the API business' },

  { company: 'Indena S.p.A.', name: 'Edwin Heavisides',
    title: 'Sales Manager — North America, UK/IE, South Africa', email: 'edwin.heavisides@indena.com',
    mobile: '+39 340 153 6518', office: '+39 02 57496 408', website: 'indena.com',
    address: 'Viale Ortles 12, 20139 Milan, Italy',
    role: 'supplier', why: 'botanical API and extract manufacturer' },

  { company: 'Altergon Italia S.r.l.', name: 'Sara Vinciguerra',
    title: 'QC — Sodium Hyaluronate Coordinator', email: 's.vinciguerra@altergon.it',
    office: '+39 0827 215232', website: 'www.altergon.it',
    address: 'Zona Industriale ASI, 83040 Morra De Sanctis (AV), Italy',
    role: 'supplier', why: 'sodium hyaluronate MANUFACTURER — she runs their QC, which is not the same as being a contract QC lab',
    note: 'Her title says QC, but Altergon makes the material. Filed supplier, not qc_lab: a contract testing business sells testing, and this one sells hyaluronate.' },

  { company: 'Vistin Pharma ASA', name: 'Sabrina Berge',
    title: 'Global Sales Manager', email: 'sabrina.berge@vistin.com',
    mobile: '+47 930 69 335', website: 'vistin.com',
    address: 'Østensjøveien 27, P.O. Box 6735 Etterstad, 0609 Oslo, Norway',
    role: 'supplier', why: 'API manufacturer, Norway' },

  { company: 'EUROAPI', name: 'Brian Ransom',
    title: 'Head of CDMO & API Business Development, Americas', email: 'brian.ransom@euroapi.com',
    mobile: '+1 651 262 8882',
    address: '100 Somerset Corporate Boulevard, 2nd Floor, Bridgewater, NJ 08807, USA',
    role: 'supplier', why: 'API and CDMO business development' },

  { company: 'Olon S.p.A.', name: 'Nureddin Mansour',
    title: 'Area Manager — BU Generics', email: 'nureddin.mansour@olon-usa.com',
    mobile: '+1 973 407 0559', website: 'www.olonspa.com',
    address: '100 Campus Drive, Florham Park, NJ 07932, USA',
    role: 'supplier', why: 'API manufacturer, generics business unit' },

  { company: 'Egis Pharmaceuticals PLC', name: 'Viktoria Sebők',
    title: 'Business Development Manager, CMO/CDMO — API Export and CDMO Services',
    email: 'sebok.viktoria@egis.hu', mobile: '+36 20 427 8214', website: 'int.egis.health',
    address: 'H-1134 Budapest, Lehel str. 15, Hungary',
    role: 'supplier', why: 'API export and CDMO services' },

  { company: 'Granules Pharmaceuticals Inc.', name: 'Rajesh Narra',
    title: 'Senior Vice President', email: 'rajesh.narra@granulesindia.com',
    mobile: '+91 97390 65941', website: 'www.granulesindia.com',
    address: '3701 Concorde Parkway, Chantilly, VA 20151, USA',
    role: 'supplier', why: 'API and finished-dose manufacturer' },

  // ── PARTNERS: analytical testing, and the operations side ────
  { company: 'Almac Group', name: 'Joanne McClelland',
    title: 'Business Development Manager — Sciences', email: 'joanne.mcclelland@almacgroup.com',
    mobile: '+44 74 8451 5671', website: 'almacgroup.com',
    address: 'Almac House, 20 Seagoe Industrial Estate, Craigavon BT63 5QD, United Kingdom',
    role: 'qc_lab', priority: true,
    why: 'Almac Sciences — analytical services. ALREADY SAID their EU and US analytical units can support the model and scheduled a call',
    note: 'WARMEST CATEGORY: per the LabConnect notes, Almac gave this contact and scheduled a follow-up call. Not a cold follow-up.' },

  { company: 'Cambrex', name: 'Melissa Huang',
    title: 'Vice President, Sales & Business Development — Drug Substance',
    email: 'melissa.huang@cambrex.com', mobile: '+1 508 918 9727',
    role: 'qc_lab', priority: true,
    why: 'CDMO with analytical units. ALREADY SAID they can support the model and scheduled a call',
    note: 'WARMEST CATEGORY: per the LabConnect notes, Cambrex gave this contact and scheduled a follow-up call. Not a cold follow-up.' },

  { company: 'allpack GmbH', name: 'Boris Brunow',
    title: 'Business Development Manager', email: 'bbrunow@allpack.ch',
    mobile: '+41 79 333 51 89', office: '+41 61 716 65 65', website: 'allpack.ch',
    address: 'Pfeffingerstrasse 45, 4153 Reinach, Switzerland',
    role: 'platform_partner',
    why: 'PHARMA PACKAGING — the card reads "Passion for Pharma Packaging". This is the operations side: repack and relabel, and it is in Europe',
    note: 'The closest match on the whole list to the facilities partner asked for: packaging, in Switzerland. Member of the Rhenopharma Group.' },

  { company: 'Cenexi', name: 'David Gaubert',
    title: 'Business Development', email: 'david.gaubert@cenexi.com',
    mobile: '+33 6 71 58 79 58', office: '+33 1 43 94 88 95', website: 'www.cenexi.com',
    address: '52 rue Marcel et Jacques Gaucher, 94120 Fontenay-sous-Bois, France',
    role: 'platform_partner',
    why: 'CDMO doing contract manufacturing and finishing in France — operations rather than molecule supply' },

  { company: 'Recipharm Advanced Bio', name: 'Luís Raiado',
    title: 'Business Development Director', email: 'luis.raiado@genibet.com',
    mobile: '+351 962 322 216', website: 'www.recipharm-ab.com',
    address: 'Edifício da BPU do IBET, 2780-157 Oeiras, Portugal',
    role: 'platform_partner',
    why: 'Recipharm — contract development and manufacturing, Europe',
    note: 'Email domain is genibet.com while the card says Recipharm Advanced Bio. Confirm the legal entity before contracting — same class of mismatch as Sintaho.' },

  // ── BUYER ────
  { company: 'Adare Pharma Solutions', name: 'Luca Segàla',
    title: 'Senior Manager, Procurement & Supply Chain', email: 'Luca.Segala@adareps.com',
    mobile: '+39 345 1617315', website: 'www.AdarePharmaSolutions.com',
    address: 'Via Martin Luther King 13, 20042 Pessano con Bornago (MI), Italy',
    role: 'buyer',
    why: 'PROCUREMENT. He buys material — the one unambiguous buyer in this batch' },

  // ── THE FOUR THAT THE CARD DOES NOT SETTLE ────
  { company: 'GP-Pharm', name: 'Gerard Ferreres',
    title: 'PMO Officer', email: 'gferreres@gp-pharm.com',
    office: '+34 93 819 9200', website: 'www.gp-pharm.com',
    address: 'Ctra. Comarcal C-244 km 22, 08777 Sant Quintí de Mediona, Barcelona, Spain',
    role: null, confirm: true,
    why: 'Spanish pharma doing contract manufacturing — but "PMO Officer" is a project-management role and says nothing about which side of the relationship they want',
    note: 'Supplier or operations partner? What did he actually ask you for?' },

  { company: 'Granules Pharmaceuticals Inc.', name: 'Shishir N Shetty',
    title: 'Vice President — Supply Chain Management', email: 'Shishir.Shetty@granulespharma.com',
    mobile: '+1 571 564 8531', office: '+1 571 325 5945', website: 'www.granulesindia.com',
    address: '3701 Concorde Parkway, Chantilly, VA 20151, USA',
    role: null, confirm: true,
    why: 'SAME COMPANY as Rajesh Narra, who is filed supplier — but supply chain management is a BUYING role. One firm, two people, possibly two different conversations',
    note: 'Granules both makes and buys. If Shishir sources material he is a buyer and must not get the supplier email asking for a catalogue.' },

  { company: 'A-S Medication Solutions', name: 'Matteo Boettger',
    title: 'Director, Government Contracts', email: 'matteo.boettger@a-smeds.com',
    office: '+1 847 912 8668', website: 'www.a-smeds.com',
    role: null, confirm: true,
    why: 'A repackager and distributor — which makes them either a BUYER of finished material or an operations partner, and "Government Contracts" settles neither',
    note: 'US-based. Repackaging is exactly the operations capability being looked for, but they may want to buy rather than partner.' },
];

const say = (s = '') => console.log(s);

async function main() {
  await initDB();

  // A typo here does not fail — it invents an event. Checked before anything is read or written.
  if (!isEvent(EVENT)) {
    console.error(`✗ "${EVENT}" is not an event in src/lib/events/registry.js.`);
    console.error('  A slug that is not a real event silently creates a phantom one, which is');
    console.error('  exactly what happened with "cphi" on 2026-10-12.');
    process.exit(1);
  }
  for (const c of CARDS) {
    if (c.role && !isRoleOf(EVENT, c.role)) {
      console.error(`✗ "${c.role}" is not a role of ${EVENT} (card: ${c.name})`);
      process.exit(1);
    }
  }

  say(`── CPHI Milan · last-day cards · ${CARDS.length} contacts\n`);

  // ── TRANSCRIPTION SANITY, BEFORE ANYTHING IS WRITTEN ────
  const problems = [];
  const seen = new Map();
  for (const c of CARDS) {
    if (!c.company || !c.name) problems.push(`a card is missing company or name: ${JSON.stringify(c).slice(0, 80)}`);
    if (!c.email) problems.push(`${c.name} (${c.company}) has no email — nothing to send to`);
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) problems.push(`${c.name}: "${c.email}" is not a valid address`);
    if (!c.why) problems.push(`${c.name}: no reason recorded for the classification`);
    const key = `${normalizeCompany(c.company)}|${c.name.toLowerCase()}`;
    if (seen.has(key)) problems.push(`duplicate card: ${c.name} at ${c.company}`);
    seen.set(key, c);
  }
  if (problems.length) {
    say('✗ transcription problems — nothing written:');
    for (const p of problems) say(`   ${p}`);
    process.exit(1);
  }

  const byRole = {};
  for (const c of CARDS) (byRole[c.role || '(needs a human)'] ||= []).push(c);

  for (const [role, list] of Object.entries(byRole)) {
    say(`   ${role.padEnd(18)} ${list.length}`);
    for (const c of list) {
      say(`      ${c.priority ? '★ ' : '  '}${c.name.padEnd(20)} ${c.company.slice(0, 34).padEnd(36)} ${c.email}`);
      say(`         ${c.why}`);
    }
    say();
  }

  const needHuman = CARDS.filter((c) => c.confirm);
  if (needHuman.length) {
    say(`   ⚠ ${needHuman.length} card(s) are NOT given a role, because the card does not settle it:`);
    for (const c of needHuman) say(`      ${c.name} — ${c.company}: ${c.note}`);
    say(`      They are written WITHOUT a role, so the export excludes them from every campaign`);
    say(`      until somebody decides. Guessing here sends a sourcing request to a buyer.`);
    say();
  }

  const priority = CARDS.filter((c) => c.priority);
  if (priority.length) {
    say(`   ★ ${priority.length} contact(s) already have a scheduled call, per the LabConnect notes:`);
    for (const c of priority) say(`      ${c.name} — ${c.company}`);
    say(`      These are not cold follow-ups and should not queue behind the API suppliers.`);
    say();
  }

  if (!EXECUTE) {
    say('   DRY RUN — nothing written. Re-run with --execute.\n');
    return;
  }

  let matches = 0, inserted = 0, updated = 0;
  for (const c of CARDS) {
    const holderNorm = normalizeCompany(c.company);
    let matchId = null;

    if (c.role) {
      // The match row carries the role, and met_in_person is simply true: he shook their hand.
      const m = await query(
        `INSERT INTO cphi_exhibitor_matches
           (event_slug, holder, holder_normalized, exhibiting, role, role_note,
            review_status, met_in_person, met_at, checked_at)
         VALUES ($1,$2,$3,false,$4,$5,'entity_review',true,$6,NOW())
         ON CONFLICT (event_slug, role, holder_normalized) DO UPDATE
           SET met_in_person = true,
               met_at        = COALESCE(cphi_exhibitor_matches.met_at, EXCLUDED.met_at),
               role_note     = COALESCE(cphi_exhibitor_matches.role_note, EXCLUDED.role_note),
               checked_at    = NOW()
         RETURNING id, (xmax = 0) AS created`,
        [EVENT, c.company, holderNorm, c.role, c.why, MET_AT]);
      matchId = m.rows[0].id;
      if (m.rows[0].created) matches += 1;
    }

    const noteParts = [c.why, c.note, c.greeting ? `Greet as "${c.greeting}".` : null].filter(Boolean);
    const r = await query(
      `INSERT INTO cphi_exhibitor_contacts
         (event_slug, exhibitor_match_id, company, company_normalized, name, title, email,
          phone_mobile, phone_office, website, address, source, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'card',$12)
       ON CONFLICT (event_slug, company_normalized, lower(name)) DO UPDATE
         SET exhibitor_match_id = COALESCE(EXCLUDED.exhibitor_match_id, cphi_exhibitor_contacts.exhibitor_match_id),
             title = EXCLUDED.title, email = EXCLUDED.email,
             phone_mobile = EXCLUDED.phone_mobile, phone_office = EXCLUDED.phone_office,
             website = EXCLUDED.website, address = EXCLUDED.address,
             note = EXCLUDED.note, updated_at = NOW()
       RETURNING (xmax = 0) AS created`,
      [EVENT, matchId, c.company, holderNorm, c.name, c.title, c.email,
       c.mobile || null, c.office || null, c.website || null, c.address || null,
       noteParts.join(' · ')]);
    if (r.rows[0].created) inserted += 1; else updated += 1;
  }

  say(`   ✅ ${inserted} contact(s) inserted, ${updated} updated, ${matches} new match row(s).`);

  const totals = (await query(
    `SELECT COALESCE(x.role, '(no role)') role, COUNT(*)::int n
       FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1
      GROUP BY 1 ORDER BY 2 DESC`, [EVENT])).rows;
  say(`\n   ${EVENT} contacts now, by campaign segment:`);
  for (const t of totals) say(`      ${t.role.padEnd(18)} ${t.n}`);
  say(`\n   Next: scripts/export-cphi-contacts.js to see the campaign lists.\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('seed-cphi-day3-contacts failed:', e && e.message ? e.message : e);
  process.exit(1);
});
