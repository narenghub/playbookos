#!/usr/bin/env node
// ── THE CARDS FROM THE SCOPE EUROPE FLOOR ─────────────────────────────────────
//
//   railway ssh 'node scripts/seed-scope-contacts.js'            → dry run
//   railway ssh 'node scripts/seed-scope-contacts.js --execute'  → writes
//
// Eighteen cards photographed in Barcelona on 2026-10-14, plus two contacts exchanged over
// LinkedIn the same morning, transcribed field by field.
//
// ── THESE ARE NOT CPHI CARDS, AND THE DIFFERENCE IS THE WHOLE POINT ──────────
//
// Every CPHI contact was somebody who MAKES molecules. Almost nobody here does. This floor is
// vendors who sell software and services INTO trial sponsors — eCOA, RBQM, biostatistics, patient
// payments and travel, ancillary supply, site networks, IRB services — which makes them customers
// for clinical demand intelligence rather than suppliers of anything Abiozen buys.
//
// So they land under a role of their own, `demand_intel`, declared in the registry. Filing them
// under an existing SCOPE tab would have been wrong in a way that is hard to undo: the AROS note
// states that the eClinical platforms are COMPETITORS for that product. They are competitors there
// and prospects here, and one key cannot mean both.
//
// ── THREE OF THESE ARE LABCONNECT, NOT LEAD DATA ─────────────────────────────
//
// Labcorp, ACM Global Laboratories and Thermo Fisher's central-labs team are a different
// conversation: we are buying their capacity, not selling them a feed. They go to qc_lab, the same
// key CPHI uses, for the reason recorded in SHARED_ROLE_KEYS.
//
// Thermo Fisher matters more than the other two. scripts/seed-cphi-day3-contacts.js ends with the
// line "Thermo Fisher is still missing. If that card exists it belongs here too" — because the
// LabConnect notes record that Thermo Fisher, Almac and Cambrex each said their analytical units
// could support the model. Nigel Fernandes is that missing contact. He is not a cold follow-up.
//
// ── WHAT IS DELIBERATELY NOT DECIDED HERE ────────────────────────────────────
//
// Two rows carry no role. A card that does not settle which side of a relationship somebody wants
// is not a card that can be put in a campaign, and export-cphi-contacts.js refuses roleless rows by
// design. Guessing is the one mistake that cannot be walked back.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { isEvent, isRoleOf } = require('../src/lib/events/registry');

const EVENT = 'scope-europe-2026';
const EXECUTE = process.argv.includes('--execute');
// The summit runs 13–14 October and these were collected across both days. The exact day is not
// load-bearing — met_in_person is — so the later date is used rather than inventing a split.
const MET_AT = '2026-10-14';

// role: demand_intel | qc_lab | abiozen | aros | linkable | null (null = needs a human)
const CARDS = [
  // ── DEMAND INTELLIGENCE: vendors who sell INTO trial sponsors ────

  { company: 'Emvenio Research', name: 'Hassan Alli',
    title: 'Business Development Director', email: 'hassan.alli@emvenio.com',
    mobile: '+44 7863168025', website: 'emvenio.com',
    role: 'demand_intel',
    why: 'decentralised and community site network — they need to know which trials are starting and where' },

  { company: 'Qointa', name: 'Rudiger Mees',
    title: 'Founder & CEO — Digital Health Technologies, eClinical Expert',
    email: 'rudiger@qointa.com', mobile: '+32 470 33 05 44', website: 'www.qointa.com',
    role: 'demand_intel',
    why: 'the card says eClinical expert — a vendor selling to sponsors, and the founder, so one conversation decides it' },

  { company: 'Stefanini', name: 'Denis Reynders',
    title: 'Global Director, Digital Health Services', email: 'denis.reynders@stefanini.com',
    mobile: '+32 475 17963', website: 'www.stefanini.com',
    address: 'Belgicastraat 5, Fountain Plaza, 1930 Zaventem, Belgium',
    role: 'demand_intel',
    why: 'IT services building digital health for sponsors — sells into the same buyer the feed describes',
    note: 'Mobile is printed tightly as "M + 32 4751 7963"; confirm the grouping before dialling.' },

  { company: 'Cyntegrity', name: 'Julien Nunes Goncalves',
    title: 'Head of Growth', email: 'julien.goncalves@cyntegrity.com',
    mobile: '+1 (0) 510 647 6330', office: '+27 (0) 84 466 1292', website: 'www.cyntegrity.com',
    address: 'Altenhöferallee 3, 60438 Frankfurt am Main, Germany',
    role: 'demand_intel',
    why: 'risk-based quality management software for trials — head of growth is the right door for a data subscription',
    note: 'Card prints two numbers, USA and South Africa. The South African one is filed as office only to keep both; neither is a landline.' },

  { company: 'Cytel', name: 'Alena Shubina',
    title: 'Market & Business Development Manager', email: 'alena.shubina@cytel.com',
    mobile: '+49 176 80765871', website: 'www.cytel.com',
    role: 'demand_intel',
    why: 'biostatistics and trial design software sold to sponsors' },

  { company: 'uMotif', name: 'Malcolm Weaver',
    title: 'Senior Director, Business Development', email: 'malcolm.weaver@umotif.com',
    mobile: '+44 (0) 7738 969 223', website: 'www.umotif.com',
    role: 'demand_intel',
    why: 'eCOA and patient data capture — a trial-by-trial sale, so new-trial signal is the input to their pipeline' },

  { company: 'Mural Health', name: 'Paul Diercksen',
    title: 'VP, Business Development', email: 'paul@muralhealth.com',
    mobile: '732 966 5690', website: 'muralhealth.com',
    role: 'demand_intel',
    why: 'patient payments and reimbursement platform, sold per trial',
    note: 'Card prints the number without a country code; it is a US (New Jersey) number — dial +1.' },

  { company: 'Wemedoo AG', name: 'Staffan Jakobsson',
    title: 'Chief Revenue Officer', email: 'staffan.jakobsson@wemedoo.com',
    mobile: '+41 78 698 0950', office: '+41 41 740 01 24', website: 'wemedoo.com',
    address: 'Sumpfstrasse 24, CH-6312 Steinhausen, Switzerland',
    role: 'demand_intel',
    why: 'eClinical data platform — and the CRO carries the revenue number, so there is no committee between him and a yes' },

  { company: 'Merative', name: 'Ferdows Sanehi',
    title: 'Clinical Trial Sales Engineer', email: 'ferdows.sanehi@merative.com',
    role: 'demand_intel', source: 'linkedin',
    why: 'health data and analytics sold into clinical development — adjacent enough to the feed to understand it immediately',
    note: 'Exchanged over LinkedIn on 14 Oct, not a card. No phone given. Already a 1st-degree connection.' },

  { company: 'WCG', name: 'Lauren Sobocinski',
    title: 'Senior Vice President, Strategic Alliances', email: 'lsobocinski@wcgclinical.com',
    mobile: '+1 302 494 9488', website: 'wcgclinical.com',
    address: '212 Carnegie Center, Suite 301, Princeton, NJ 08540, USA',
    role: 'demand_intel',
    why: 'IRB and clinical services — strategic alliances is exactly the function that buys a data partnership' },

  { company: 'WCG', name: 'Michal Kouril',
    title: 'Director, Strategic Solutions and Partnership EMEA — Research Solutions',
    email: 'mkouril@wcgclinical.com', mobile: '+49 151 23483688', office: '+49 69 42690550',
    website: 'wcgclinical.com',
    address: 'Eschersheimer Landstraße 14, 60322 Frankfurt am Main, Germany',
    role: 'demand_intel',
    why: 'same firm as Lauren Sobocinski, EMEA side — partnerships, and based in Europe',
    note: 'TWO WCG CONTACTS, one US and one EMEA, both in partnership roles. Decide which one leads before writing to either: two unconnected approaches into one company reads as a scattergun.' },

  { company: 'mdgroup', name: 'Matt Dixon',
    title: 'Account Director', email: 'matt.dixon@mdgroup.com',
    mobile: '+1 (862) 881 9904', website: 'www.mdgroup.com',
    address: '5001 S. Miami Boulevard, Suite 320, Durham, NC 27703, USA',
    role: 'demand_intel',
    why: 'patient travel and concierge services, sold per trial' },

  { company: 'Resonant Clinical Solutions', name: 'Simon Brophy',
    title: 'Senior Business Development Manager', email: 'simon.brophy@resonantclinical.com',
    mobile: '+353 8670 15913',
    role: 'demand_intel',
    why: 'kitting, biorepository, equipment and ancillaries — an ancillary supplier lives or dies on knowing which trials are starting, which is precisely what the feed says',
    note: 'Card lists the group brands: Kitting by Therapak, Biorepository by EPL Archives, Equipment and Ancillaries by MESM.' },

  { company: 'ERCULES Comunicazioni S.r.l.', name: 'Cecilia Tabasso',
    title: 'Head of Project Management', email: 'cecilia.tabasso@ercules.it',
    mobile: '+39 348 9038782', office: '+39 011 9411080', website: 'www.ercules.co',
    address: 'Via Roma 10, 10023 Chieri (TO), Italy',
    role: 'demand_intel',
    why: 'clinical communications agency serving sponsors',
    note: 'Email domain is ercules.it while the website is ercules.co — both printed on the card, not a transcription error.' },

  { company: 'Credible Planning', name: 'Amit Shah',
    title: 'Chief Operating Officer', email: 'amit.shah@credibleplanning.com',
    mobile: '+91 94281 11118', website: 'www.credibleplanning.com',
    role: 'demand_intel',
    why: 'clinical planning services sold to sponsors, and the COO can decide',
    note: 'Card reads "Clinical Division of Jalson Business Solutions LLP" — confirm which entity contracts.' },

  // ── QC LAB: LabConnect recruits. We buy their capacity; we do not sell them a feed ────

  { company: 'Thermo Fisher Scientific', name: 'Nigel Fernandes',
    title: 'Global Biotech Team Lead, Central Labs Business Development',
    email: 'Nigel.Fernandes@thermofisher.com',
    role: 'qc_lab', priority: true, source: 'linkedin',
    why: 'CENTRAL LABS business development — the contact the CPHI day-three seed recorded as missing. Per the LabConnect notes Thermo Fisher already said their analytical units can support the model',
    note: 'WARMEST ON THIS LIST. Not a cold follow-up: Thermo Fisher is one of the three firms (with Almac and Cambrex) that already agreed the LabConnect model works for them. Exchanged over LinkedIn on 14 Oct; no phone given.' },

  { company: 'Labcorp', name: 'Juan Carlos Saavedra',
    title: 'Business Development Director', email: 'juancarlos.saavedra@labcorp.com',
    mobile: '+34 659 901778', website: 'labcorp.com',
    address: 'Rue Moïse-Marcinhes 7, 1217 Geneva, Switzerland',
    role: 'qc_lab',
    why: 'central laboratory — LabConnect capacity, not a data customer',
    note: 'Could also buy the demand feed one day. Filed qc_lab because that is the live conversation and mixing the two in one approach muddles both.' },

  { company: 'ACM Global Laboratories', name: 'Charlotte Perrin',
    title: 'Global Key Account Director', email: 'cperrin@acmglobalab.com',
    office: '+44 (0) 7501 468055', website: 'www.acmglobalab.com',
    role: 'qc_lab',
    why: 'global central laboratory — Americas, Europe, India, Singapore per the card',
    note: 'The number printed under "Office" is a UK mobile. Card also carries a US toll-free line, 1-866-405-0400.' },

  // ── THE TWO THE CARD DOES NOT SETTLE ────

  { company: 'Centre for Human Drug Research', name: 'Vasileios Exadaktylos',
    title: 'Product Manager, Trial@Home', email: 'vexadaktylos@chdr.nl',
    office: '+31 (0)71 524 64 80', website: 'www.chdr.nl',
    address: 'Zernikedreef 8, 2333 CL Leiden, Netherlands',
    role: null, confirm: true,
    why: 'CHDR RUNS trials — an early-phase research institute — which makes it a subject of the demand feed rather than an obvious buyer. But Trial@Home is a PRODUCT they sell, and a product manager is a vendor-side role',
    note: 'Which is it: are they buying a signal, or are they a research institute that buys research-grade material? The second would make them Abiozen, not demand_intel. What did he actually ask you for?' },

  { company: 'TRU', name: 'Abi Balmer',
    title: 'Senior Account Executive', email: 'abi.balmer@tru.team',
    mobile: '+44 753 4411200', website: 'tru.team',
    address: '4001 NC 54, Suite 3150, Durham, NC 27709, USA',
    role: null, confirm: true,
    why: 'the card carries a name, a title and a QR code and does not say what the company does',
    note: 'UK mobile, US address, domain tru.team. Nothing on the card settles the business. Ask before classifying — the whole card is a logo and a QR.' },
];

const say = (s = '') => console.log(s);

async function main() {
  await initDB();

  // A typo here does not fail — it invents an event. Checked before anything is read or written.
  if (!isEvent(EVENT)) {
    console.error(`✗ "${EVENT}" is not an event in src/lib/events/registry.js.`);
    process.exit(1);
  }
  for (const c of CARDS) {
    if (c.role && !isRoleOf(EVENT, c.role)) {
      console.error(`✗ "${c.role}" is not a role of ${EVENT} (card: ${c.name})`);
      process.exit(1);
    }
  }

  // ── THE LIVE CONSTRAINT, CHECKED IN THE DRY RUN ──────────────────────────
  //
  // A role is legal in two places and they are not the same place: src/lib/events/registry.js, and
  // a CHECK constraint on cphi_exhibitor_matches in the database. Adding `demand_intel` to the
  // registry and running this script produced a clean dry run listing all twenty rows, followed by
  // `violates check constraint "cem_role_valid"` on the FIRST write — because the migration that
  // builds the CHECK from the registry had not been re-run against production.
  //
  // The dry run's whole job is to answer "will the write work", and it answered yes to a write that
  // could not succeed. Printing rows is not a rehearsal. So the constraint is now read from the
  // live database and compared against the roles this file actually uses, BEFORE anything is
  // printed — which costs one query and makes the dry run mean what it says.
  const needed = [...new Set(CARDS.map((c) => c.role).filter(Boolean))];
  const def = (await query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'cem_role_valid'`
  )).rows[0];
  if (def && def.def) {
    const missing = needed.filter((r) => !def.def.includes(`'${r}'`));
    if (missing.length) {
      say(`✗ the database does not accept ${missing.length === 1 ? 'this role' : 'these roles'}: ${missing.join(', ')}`);
      say(`   The CHECK constraint on cphi_exhibitor_matches is built from the registry, and it`);
      say(`   has not been re-run since ${missing.join(' and ')} ${missing.length === 1 ? 'was' : 'were'} added.`);
      say(`   Live constraint: ${def.def}`);
      say('');
      say(`   Run this first, then this script again:`);
      say(`      railway ssh 'node scripts/migrate-cphi-roles.js'`);
      say('');
      process.exit(1);
    }
  }

  say(`── SCOPE Europe 2026 · Barcelona · ${CARDS.length} contacts\n`);

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
      say(`      ${c.priority ? '★ ' : '  '}${c.name.padEnd(22)} ${c.company.slice(0, 32).padEnd(34)} ${c.email}`);
      say(`         ${c.why}`);
    }
    say();
  }

  const needHuman = CARDS.filter((c) => c.confirm);
  if (needHuman.length) {
    say(`   ⚠ ${needHuman.length} card(s) are NOT given a role, because the card does not settle it:`);
    for (const c of needHuman) say(`      ${c.name} — ${c.company}: ${c.note}`);
    say(`      They are written WITHOUT a role, so the export excludes them from every campaign`);
    say(`      until somebody decides.`);
    say();
  }

  const priority = CARDS.filter((c) => c.priority);
  if (priority.length) {
    say(`   ★ ${priority.length} contact(s) are already warm:`);
    for (const c of priority) say(`      ${c.name} — ${c.company}`);
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

    const noteParts = [c.why, c.note].filter(Boolean);
    const r = await query(
      `INSERT INTO cphi_exhibitor_contacts
         (event_slug, exhibitor_match_id, company, company_normalized, name, title, email,
          phone_mobile, phone_office, website, address, source, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (event_slug, company_normalized, lower(name)) DO UPDATE
         SET exhibitor_match_id = COALESCE(EXCLUDED.exhibitor_match_id, cphi_exhibitor_contacts.exhibitor_match_id),
             title = EXCLUDED.title, email = EXCLUDED.email,
             phone_mobile = EXCLUDED.phone_mobile, phone_office = EXCLUDED.phone_office,
             website = EXCLUDED.website, address = EXCLUDED.address,
             note = EXCLUDED.note, updated_at = NOW()
       RETURNING (xmax = 0) AS created`,
      [EVENT, matchId, c.company, holderNorm, c.name, c.title, c.email,
       c.mobile || null, c.office || null, c.website || null, c.address || null,
       c.source || 'card', noteParts.join(' · ')]);
    if (r.rows[0].created) inserted += 1; else updated += 1;
  }

  say(`   ✅ ${inserted} contact(s) inserted, ${updated} updated, ${matches} new match row(s).`);

  const totals = (await query(
    `SELECT COALESCE(x.role, '(no role)') role, COUNT(*)::int n
       FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1
      GROUP BY 1 ORDER BY 2 DESC`, [EVENT])).rows;
  say(`\n   ${EVENT} contacts now, by segment:`);
  for (const t of totals) say(`      ${t.role.padEnd(18)} ${t.n}`);
  say();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('seed-scope-contacts failed:', e && e.message ? e.message : e);
  process.exit(1);
});
