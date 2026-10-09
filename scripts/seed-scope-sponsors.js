#!/usr/bin/env node
// ── SCOPE EUROPE 2026: THE SPONSOR LIST, AND WHAT IT IS ACTUALLY FOR. ─────────
//
//   node scripts/seed-scope-sponsors.js            # dry run, prints what it would write
//   node scripts/seed-scope-sponsors.js --execute   # writes
//
// Source: https://www.scopesummiteurope.com/sponsors, read 9 Oct 2026. SCOPE sells exhibit space
// ONLY as part of a sponsorship package ("EXHIBIT SPACES ARE ONLY BEING SOLD AS PART OF SPONSORSHIP
// PACKAGES"), so the sponsor list and the exhibitor list are substantially the same list. The
// interactive floorplan at intheorious.com is robots-disallowed and was not fetched; booth numbers
// are therefore absent and every row here is `exhibiting = true` with `booth = NULL`.
//
// ── THE FINDING THAT MATTERS MORE THAN THE DATA ────
//
// This list is almost entirely VENDORS — companies selling TO clinical operations. That is the same
// side of the table as us. Read against the three SCOPE roles:
//
//   aros      The eClinical platforms here (Medidata, Suvoda, Viedoc, Florence, CRIO, Zelta, Saama,
//             Teckro, SLOPE, Cluepoints, Viedoc...) are AROS's COMPETITORS, not its customers.
//             Seeding them as `aros` prospects would produce a list that looks full and converts at
//             zero. They are seeded as `aros` anyway — but with role_note saying 'competitor', so
//             the tab is a competitor map, which is a real thing to walk a floor with and a
//             different thing from a pipeline.
//
//   linkable  The patient-recruitment firms and site networks (Care Access, Clariness, Inato,
//             Emvenio, Trialbee, mytomorrows, MDgroup, Naru, Scout) are a GENUINE match. This is
//             the tab Naresh expected to be empty and it is the strongest on the list.
//
//   abiozen   Thinnest, and that is the honest answer. A molecule buyer is a company DEVELOPING a
//             drug, and those people are at SCOPE as ATTENDEES — 800 executives from 300
//             organisations — not as exhibitors. The handful seeded here are the CRO/CDMO and
//             Phase 1 unit names that plausibly buy API or QC testing.
//
// So the exhibitor list cannot be the Abiozen target list at this show. That list comes from
// /events/scope-europe-2026/sponsors?role=abiozen, which ranks OUR OWN clinical_studies sponsors —
// and the floor flag stays false for most of them, correctly, because they are not exhibiting.
// This is the CPHI lesson in a new form: the list that can be obtained is not the list that is
// needed, and conflating them is what produced 13 on-floor out of 60 last time.
//
// ── CONFIDENCE ────
//
// Every `category` below is MY READING of what the company does, from its name and public
// positioning, not a claim sourced from SCOPE. Several are genuinely ambiguous and are marked
// `unsure` rather than guessed into a tab. The page must show the note; a category is a starting
// point for a conversation, not a fact about the company.
'use strict';

const { query } = require('../src/lib/db');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { isRoleOf } = require('../src/lib/events/registry');

const EVENT = 'scope-europe-2026';
const EXECUTE = process.argv.includes('--execute');

// level: as published. role: which tab. note: why, in the words the page will show.
const SPONSORS = [
  // ── PREMIER ────
  ['Fortrea',              'premier',   'abiozen',  'Global CRO. Runs trials for sponsors, so it specifies and sources material — and buys analytical testing. Displacement sale.'],
  ['H1',                   'premier',   'aros',     'Healthcare data platform. Competitor-adjacent: sells intelligence into the same clinical ops budget.'],
  ['IQVIA',                'premier',   'aros',     'COMPETITOR. The largest clinical data and technology provider; also a CRO. Not an AROS prospect.'],
  ['Labcorp',              'premier',   'qc_peer',  'Central laboratory services at scale. A LabConnect PEER or channel, not a QC customer — they have more capacity than we do.'],
  ['Medidata',             'premier',   'aros',     'COMPETITOR. The incumbent EDC/clinical cloud. Worth understanding, not pitching.'],
  ['Syneos Health',        'premier',   'abiozen',  'CRO and commercial organisation. Same displacement logic as Fortrea.'],
  ['Whatfix',              'premier',   'aros',     'Digital adoption platform — sits alongside a clinical system rather than replacing one. Possible channel partner.'],
  ['Trialbee',             'premier',   'linkable', 'Patient recruitment and matching. Direct LinkAble match.'],

  // ── CORPORATE ────
  ['Care Access',          'corporate', 'linkable', 'Decentralised site network and patient access. Strong LinkAble match.'],
  ['Citeline',             'corporate', 'aros',     'COMPETITOR-ADJACENT. Trial and pipeline intelligence; overlaps what our demand intelligence shows.'],
  ['Clariness',            'corporate', 'linkable', 'Patient recruitment across Europe. Strong LinkAble match.'],
  ['Cluepoints',           'corporate', 'aros',     'COMPETITOR. Risk-based monitoring and data quality analytics.'],
  ['Credible Planning',    'corporate', 'unsure',   'Name alone is not enough to place this. Needs a look before it goes in a tab.'],
  ['CRIO',                 'corporate', 'aros',     'COMPETITOR. eSource and site-facing clinical data capture.'],
  ['Cuttsy',               'corporate', 'linkable', 'Healthcare creative and patient communications — recruitment-adjacent.'],
  ['Cyntegrity',           'corporate', 'aros',     'COMPETITOR. Risk-based quality management.'],
  ['Emvenio',              'corporate', 'linkable', 'Mobile and community research sites. LinkAble match.'],
  ['Evinova',              'corporate', 'aros',     'COMPETITOR. AstraZeneca-backed digital health and clinical trial platform.'],
  ['Exostar',              'corporate', 'aros',     'Identity and secure collaboration for life sciences. Infrastructure, possible channel.'],
  ['Florence Healthcare',  'corporate', 'aros',     'COMPETITOR. eISF and site enablement — overlaps an AROS site workflow directly.'],
  ['Inato',                'corporate', 'linkable', 'Site marketplace matching trials to community sites. Strong LinkAble match.'],
  ['Mural Health',         'corporate', 'linkable', 'Participant payments and engagement. Recruitment-adjacent.'],
  ['mytomorrows',          'corporate', 'linkable', 'Pre-approval access and trial search for patients. LinkAble match.'],
  ['Tiomics',              'corporate', 'unsure',   'Insufficient signal from the name. Look before placing.'],
  ['PSI',                  'corporate', 'abiozen',  'Mid-size CRO, strong in Europe. Runs trials, so buys material and testing.'],
  ['Replior',              'corporate', 'unsure',   'Unclear from the name. Possibly clinical supply; check before placing.'],
  ['RWS',                  'corporate', 'linkable', 'Language and regulatory translation for trials. Service peer, recruitment-adjacent.'],
  ['Saama',                'corporate', 'aros',     'COMPETITOR. AI clinical data analytics.'],
  ['SAS',                  'corporate', 'aros',     'COMPETITOR-ADJACENT. Statistical computing environment for clinical data.'],
  ['SLOPE',                'corporate', 'aros',     'COMPETITOR. Clinical supply and specimen management at sites.'],
  ['Suvoda',               'corporate', 'aros',     'COMPETITOR. IRT/RTSM and eConsent.'],
  ['Teckro',               'corporate', 'aros',     'COMPETITOR. Protocol access for sites. (Their own link spells it "Techro".)'],
  ['Thermo Fisher',        'corporate', 'abiozen',  'ALREADY IN CONVERSATION — named as willing to collaborate for EU and USA. CDMO, clinical supply and analytical services. The highest-value booth on this list for us.'],
  ['TRI',                  'corporate', 'unsure',   'Ambiguous acronym. Check before placing.'],
  ['TrialFlow',            'corporate', 'linkable', 'Trial workflow and recruitment support. LinkAble-adjacent.'],
  ['TrialX',               'corporate', 'linkable', 'Trial matching and recruitment technology. LinkAble match.'],
  ['TriNetX',              'corporate', 'aros',     'COMPETITOR-ADJACENT. Real-world data network used for feasibility.'],
  ['umotif',               'corporate', 'aros',     'COMPETITOR. ePRO and patient data capture.'],
  ['Viedoc',               'corporate', 'aros',     'COMPETITOR. EDC platform.'],
  ['WCG',                  'corporate', 'linkable', 'IRB, site and patient recruitment services. Mixed; recruitment side is the LinkAble angle.'],
  ['ZS Associates',        'corporate', 'unsure',   'Consultancy. Could be a channel partner rather than a buyer of anything.'],

  // ── CORPORATE SUPPORT ────
  ['ACM',                            'support', 'unsure',   'Ambiguous acronym. Check before placing.'],
  ['Adamas',                         'support', 'unsure',   'Several companies use this name. Check before placing.'],
  ['Bitfount',                       'support', 'aros',     'Federated data access. Infrastructure, possible channel.'],
  ['Centre for Human Drug Research', 'support', 'abiozen',  'Phase 1 unit in Leiden. RUNS early-phase studies, so it buys research-grade material and analytical work. One of the few genuine Abiozen prospects on this list.'],
  ['Cytel',                          'support', 'aros',     'COMPETITOR-ADJACENT. Biostatistics software and services.'],
  ['Ercules',                        'support', 'unsure',   'Insufficient signal. Check before placing.'],
  ['Ephicacy',                       'support', 'aros',     'Clinical data and biometrics services. Service peer.'],
  ['Langland',                       'support', 'linkable', 'Healthcare communications agency — patient recruitment campaigns.'],
  ['Marken',                         'support', 'unsure',   'Clinical supply logistics (UPS). A LOGISTICS partner for shipping material, not a buyer — worth a conversation for our own supply chain.'],
  ['MaxCyte',                        'support', 'unsure',   'Cell engineering platform. Not a molecule buyer in our sense.'],
  ['MDgroup',                        'support', 'linkable', 'Patient-centric trial services and home nursing. LinkAble match.'],
  ['Naru Healthcare',                'support', 'linkable', 'Patient recruitment. LinkAble match.'],
  ['Research Grid',                  'support', 'aros',     'COMPETITOR. Site and study operations platform.'],
  ['Scout',                          'support', 'linkable', 'Patient recruitment and site support. LinkAble match.'],
  ['Stefanini',                      'support', 'unsure',   'IT services conglomerate. Channel partner at best.'],
  ['Syngene International',          'support', 'abiozen',  'Indian CRO/CDMO with real API and analytical capability. Could be SUPPLIER as much as buyer — worth both conversations.'],
  ['Transcom',                       'support', 'unsure',   'Customer experience outsourcing. Unclear fit.'],
  ['TrueTechnologies',               'support', 'unsure',   'Insufficient signal. Check before placing.'],
  ['Wemedoo',                        'support', 'aros',     'COMPETITOR. Clinical data management platform.'],
  ['Zelta',                          'support', 'aros',     'COMPETITOR. EDC and clinical data (formerly Merge/eClinical).'],
];

// `qc_peer` and `unsure` are not roles in the registry. They are deliberately NOT written as rows:
// a row in a tab is a claim that the company belongs in that tab, and neither of these is that.
// They are reported so the work of placing them is visible rather than silently dropped.
const REAL_ROLES = new Set(['abiozen', 'aros', 'linkable']);

async function main() {
  const rows = [];
  const parked = [];
  for (const [name, level, role, note] of SPONSORS) {
    if (!REAL_ROLES.has(role)) { parked.push([name, level, role, note]); continue; }
    if (!isRoleOf(EVENT, role)) throw new Error(`"${role}" is not a role of ${EVENT} — registry disagrees`);
    rows.push({
      event_slug: EVENT,
      holder: name,
      holder_normalized: normalizeCompany(name),
      exhibitor_name: name,
      exhibiting: true,
      booth: null,                 // the floorplan is robots-disallowed; no booth numbers obtained
      hall: 'Exhibit Hall',
      role,
      role_note: `${level} sponsor · ${note}`,
      // Not auto_confirmed: the company is certainly at the show, but the CATEGORY is my reading of
      // what it does, and that is exactly what the review gate is for.
      review_status: 'entity_review',
      match_tier: 'exact',
      market: 'eu',
    });
  }

  const byRole = {};
  for (const r of rows) byRole[r.role] = (byRole[r.role] || 0) + 1;

  console.log(`── SCOPE Europe 2026 sponsors · source: scopesummiteurope.com/sponsors, 9 Oct 2026`);
  console.log(`   ${SPONSORS.length} companies on the published list`);
  console.log(`   ${rows.length} placed into a tab:`);
  for (const [role, n] of Object.entries(byRole)) console.log(`      ${role.padEnd(10)} ${n}`);
  console.log(`   ${parked.length} NOT placed — a tab is a claim, and these are not one yet:`);
  for (const [name, , role, note] of parked) {
    console.log(`      ${String(name).padEnd(34)} ${role.padEnd(8)} ${note.slice(0, 70)}`);
  }
  console.log(`\n   booth numbers: NONE. The interactive floorplan is robots-disallowed.`);
  console.log(`   Every placed row is exhibiting=true with booth=NULL and review_status=entity_review.`);

  if (!EXECUTE) {
    console.log('\n   DRY RUN — nothing written. Re-run with --execute.');
    return;
  }

  let ins = 0, upd = 0;
  for (const r of rows) {
    const res = await query(
      `INSERT INTO cphi_exhibitor_matches
         (event_slug, holder, holder_normalized, exhibitor_name, exhibiting, booth, hall,
          role, role_note, review_status, match_tier, market, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
       ON CONFLICT (event_slug, role, holder_normalized) DO UPDATE
         SET exhibitor_name = EXCLUDED.exhibitor_name,
             exhibiting     = EXCLUDED.exhibiting,
             hall           = EXCLUDED.hall,
             role_note      = EXCLUDED.role_note,
             market         = EXCLUDED.market,
             checked_at     = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [r.event_slug, r.holder, r.holder_normalized, r.exhibitor_name, r.exhibiting, r.booth,
       r.hall, r.role, r.role_note, r.review_status, r.match_tier, r.market]);
    if (res.rows[0] && res.rows[0].inserted) ins++; else upd++;
  }
  console.log(`\n   ✅ ${ins} inserted, ${upd} updated.`);
}

main().then(() => process.exit(0))
      .catch((e) => { console.error('seed error:', e.message); process.exit(1); });
