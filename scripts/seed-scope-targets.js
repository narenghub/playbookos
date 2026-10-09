#!/usr/bin/env node
// ── SCOPE EUROPE 2026: THE THREE TABS, AS NARESH DEFINED THEM. ────────────────
//
//   node scripts/seed-scope-targets.js            # dry run
//   node scripts/seed-scope-targets.js --execute  # writes
//
// Must run INSIDE Railway: railway ssh 'node scripts/seed-scope-targets.js'
// The internal DATABASE_URL does not resolve from a laptop.
//
// ── WHAT CHANGED, AND WHY IT MATTERS MORE THAN THE CODE ────
//
// I seeded these three tabs from the published sponsor list and got two of the three wrong, because
// I guessed at what the products are instead of asking. Naresh corrected both:
//
//   AROS      is the Autonomous Regulatory Operating System — regulatory and compliance tracking.
//             Its buyers are therefore SPONSOR COMPANIES, who carry the FDA regulatory burden for
//             their own trials. I had seeded the 25 eClinical platforms exhibiting at SCOPE, which
//             are a competitor map, not a prospect list.
//
//   LinkAble  is a recruiting OS: an employment agency subscribes, finds client companies and their
//             open jobs, and matches candidates to them. Its buyers are STAFFING AGENCIES — firms
//             that place people into jobs. I had seeded patient-recruitment firms (Care Access,
//             Clariness, Inato, Trialbee), which enrol PATIENTS INTO TRIALS. Adjacent words,
//             completely different business.
//
// So this script rebuilds all three from the right definitions. It does not delete the old rows
// silently: --execute reassigns or removes them and prints every move, because a row quietly
// changing tab between two sessions is how a list stops being trusted.
//
// ── WHERE EACH TAB'S ROWS COME FROM ────
//
//   abiozen   The 6 CRO/CDMO exhibitors, PLUS the top INDUSTRY sponsors from clinical_studies —
//             because a molecule buyer is a company developing a drug, and at SCOPE those are the
//             800 attendees, not the 65 booths. Each CRO row carries the sponsors whose trials it
//             runs (from clinical_studies.collaborators), which is what Naresh asked for: the
//             sponsor behind the CRO, with studies and patient counts.
//
//   aros      The same INDUSTRY sponsor universe, framed by regulatory load rather than molecules.
//             A sponsor running more trials, in more countries, at later phase carries more
//             compliance weight — that is the pitch, and it is the ranking.
//
//   linkable  Staffing and employment agencies on the floor. Expect very few: SCOPE is a clinical
//             operations conference and employment agencies are not typically its exhibitors. The
//             honest output here is a short list, and the script prints the number rather than
//             padding it. The companies with JOBS to fill — every sponsor and CRO above — are
//             LinkAble's demand side, not its subscribers, and are deliberately NOT seeded into
//             this tab: a tab is a list of who we sell to.
'use strict';

const { query } = require('../src/lib/db');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { isRoleOf } = require('../src/lib/events/registry');

const EVENT = 'scope-europe-2026';
const EXECUTE = process.argv.includes('--execute');
// How many sponsors to carry into each tab. 60 is a two-day floor's worth of names to scan, and
// past that the tail is sponsors with one small trial.
const TOP_SPONSORS = Number((process.argv.find((a) => a.startsWith('--top=')) || '').split('=')[1]) || 60;

// ── THE EXHIBITORS WE KEEP, RECATEGORISED ────
//
// From scopesummiteurope.com/sponsors. Only the rows whose tab I can defend; everything else is
// dropped from the tabs entirely rather than parked in one. `why` is printed and stored.
const EXHIBITORS = {
  // CRO / CDMO / Phase-1 units: they run trials, so they specify and buy material and testing.
  abiozen: [
    ['Thermo Fisher',                   'CDMO, clinical supply and analytical services. ALREADY IN CONVERSATION — named at CPHI Milan as willing to collaborate for EU and USA. The highest-value booth on this floor for us.'],
    ['Fortrea',                         'Global CRO. Runs trials for sponsors, so it specifies material and buys analytical testing.'],
    ['Syneos Health',                   'CRO and commercial organisation. Same displacement logic as Fortrea.'],
    ['PSI',                             'Mid-size CRO, strong in Europe.'],
    ['Syngene International',           'Indian CRO/CDMO with real API and analytical capability. Could be SUPPLIER as much as buyer — worth both conversations.'],
    ['Centre for Human Drug Research',  'Phase 1 unit in Leiden. Runs early-phase studies, so it buys research-grade material and analytical work.'],
  ],
  // Employment / staffing agencies. EMPTY, and that is the researched answer rather than a gap.
  //
  // Stefanini was here on the strength of its name. Researched 9 Oct against its own material: it is
  // a global IT services group that SELLS IT resource augmentation — so it competes with LinkAble
  // rather than subscribing to it. Removed. Nothing else on the 61-company list places a single
  // person into a single job.
  //
  // SCOPE Europe is a clinical operations conference. Its exhibitors sell software, data, logistics,
  // consulting and laboratory services TO trial sponsors. Employment agencies are not in that room,
  // so this tab is worked from the ATTENDEE list — 800 executives from 300 organisations, all of whom
  // have jobs to fill — and not from the floor.
  linkable: [],
  // aros is NOT seeded from exhibitors. Its buyers are sponsors, which come from clinical_studies
  // below. The 25 eClinical platforms that used to sit here are competitors and are removed.
};

// Rows previously seeded into a tab they do not belong in. Named explicitly so --execute can
// remove exactly these and print each one, rather than deleting by pattern.
const WRONG_TAB = {
  aros: ['IQVIA', 'Medidata', 'Cluepoints', 'CRIO', 'Cyntegrity', 'Evinova', 'Exostar',
         'Florence Healthcare', 'Saama', 'SAS', 'SLOPE', 'Suvoda', 'Teckro', 'TriNetX',
         'umotif', 'Viedoc', 'Citeline', 'H1', 'Whatfix', 'Bitfount', 'Cytel', 'Ephicacy',
         'Research Grid', 'Wemedoo', 'Zelta'],
  linkable: ['Trialbee', 'Care Access', 'Clariness', 'Cuttsy', 'Emvenio', 'Inato', 'Mural Health',
             'mytomorrows', 'RWS', 'TrialFlow', 'TrialX', 'WCG', 'Langland', 'MDgroup',
             'Naru Healthcare', 'Scout',
             // Sells IT staffing itself — a LinkAble competitor, not a subscriber. See above.
             'Stefanini'],
};

// ── THE 14 I COULD NOT READ FROM A NAME, NOW RESEARCHED ────
//
// Naresh asked whether six Abiozen companies could really be all of them. It was a fair challenge:
// six was my own categorisation, and 14 names were parked because I could not identify them. Those
// 14 were researched against their own material on 9 Oct 2026. The answer is that six IS the number —
// NONE of the 14 would buy an API or analytical testing — and four of my guesses were wrong in a way
// that mattered, which is the argument for having looked rather than reasoning from the names.
//
//   Labcorp            Central Laboratory Services — SELLS the testing we sell. LabConnect peer or
//                      competitor, never a buyer. (My "qc_peer" park was right.)
//   ACM                ACM Global Laboratories — also a central lab that SELLS testing. Same.
//   Adamas             ADAMAS *Consulting*: GCP audit and inspection readiness. NOT Adamas
//                      Pharmaceuticals, which would have been a genuine sponsor. The name collision
//                      is exactly the trap.
//   Transcom           tran-s.com: translation and linguistic validation for trials. NOT the Swedish
//                      CX/BPO firm of the same name, which is what I had guessed.
//   Replior            Swedish eClinical EDC/ePRO suite. I had guessed "possibly clinical supply".
//   TRI                TriTrials — risk-based quality management software.
//   TrueTechnologies   TruTechnologies — live trial execution software (TruLab, TruDose).
//   Credible Planning  Trial planning SaaS: country selection, site activation, enrolment forecasts.
//   Ercules            Ercules Comunicazioni — patient education and comms. Recruitment-adjacent,
//                      which the LinkAble definition explicitly excludes.
//   Marken             UPS Healthcare's clinical supply chain. A logistics conversation about OUR
//                      shipping, not a sale.
//   MaxCyte            Cell-engineering tools vendor. The closest near-miss: it makes GMP consumables
//                      and runs assays, so it might buy testing — but it develops no drug product.
//                      A soft probe at most.
//   ZS Associates      Management consulting. Channel partner at best.
//   Stefanini          IT services; sells staffing. Moved OUT of linkable, see WRONG_TAB.
//   Tiomics            UNIDENTIFIED. No company of that exact name found; possibly a mislabelled
//                      logo for Triomics (oncology trial matching). Left unplaced deliberately —
//                      an honest unknown beats a plausible wrong pitch at a booth.
//
// The pattern underneath: SCOPE's exhibitors sell TO trial sponsors. They are the same side of the
// table as us. The buyers are the attendees.

const SPONSOR_SQL = `
  WITH ind AS (
    SELECT cs.id, cs.lead_sponsor_name sponsor, cs.phase, cs.overall_status,
           cs.enrollment_count, cs.locations_countries, cs.collaborators
      FROM clinical_studies cs
     WHERE cs.sponsor_type = 'INDUSTRY'
       AND cs.lead_sponsor_name IS NOT NULL
       AND length(btrim(cs.lead_sponsor_name)) > 2
  ),
  agg AS (
    SELECT sponsor,
           COUNT(DISTINCT id)::int studies,
           COUNT(DISTINCT id) FILTER (WHERE phase = 'Phase 3')::int ph3,
           COUNT(DISTINCT id) FILTER (WHERE overall_status = 'RECRUITING')::int recruiting,
           COALESCE(SUM(DISTINCT enrollment_count), 0)::int patients
      FROM ind GROUP BY 1
  ),
  mol AS (
    SELECT i.sponsor,
           COUNT(DISTINCT LOWER(sm.molecule_name))::int molecules,
           COUNT(DISTINCT LOWER(sm.molecule_name)) FILTER (
             WHERE dm.dmf_number IS NOT NULL OR pr.id IS NOT NULL)::int sourceable
      FROM ind i
      JOIN study_molecules sm ON sm.study_id = i.id
      LEFT JOIN molecule_dmf_matches dm
             ON LOWER(dm.molecule_name) = LOWER(sm.molecule_name) AND dm.review_status = 'auto_confirmed'
      LEFT JOIN molecule_pricing pr
             ON LOWER(pr.molecule_name) = LOWER(sm.molecule_name) AND pr.active = 1
     GROUP BY 1
  )
  SELECT a.sponsor, a.studies, a.ph3, a.recruiting, a.patients,
         COALESCE(m.molecules, 0)::int molecules,
         COALESCE(m.sourceable, 0)::int sourceable
    FROM agg a LEFT JOIN mol m ON m.sponsor = a.sponsor
   ORDER BY a.studies DESC, a.patients DESC, a.sponsor
   LIMIT ${TOP_SPONSORS}`;

const NOT_A_BUYER = ['national cancer institute', 'national institutes of health',
  'world health organization', 'european commission', 'european medicines agency',
  'department of veterans affairs', 'ministry of health'];
const isBuyer = (n) => {
  const x = normalizeCompany(n);
  return x.length > 2 && !NOT_A_BUYER.some((b) => x.includes(normalizeCompany(b)));
};

async function upsert(row) {
  const res = await query(
    `INSERT INTO cphi_exhibitor_matches
       (event_slug, holder, holder_normalized, exhibitor_name, exhibiting, booth, hall,
        role, role_note, review_status, match_tier, market,
        studies_count, patients_count, molecules_covered, sponsors, checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, NOW())
     ON CONFLICT (event_slug, role, holder_normalized) DO UPDATE
       SET exhibitor_name  = COALESCE(EXCLUDED.exhibitor_name, cphi_exhibitor_matches.exhibitor_name),
           exhibiting      = EXCLUDED.exhibiting OR cphi_exhibitor_matches.exhibiting,
           hall            = COALESCE(EXCLUDED.hall, cphi_exhibitor_matches.hall),
           role_note       = EXCLUDED.role_note,
           studies_count   = EXCLUDED.studies_count,
           patients_count  = EXCLUDED.patients_count,
           molecules_covered = EXCLUDED.molecules_covered,
           sponsors        = COALESCE(EXCLUDED.sponsors, cphi_exhibitor_matches.sponsors),
           checked_at      = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [EVENT, row.name, normalizeCompany(row.name), row.exhibitor_name || null,
     !!row.exhibiting, null, row.exhibiting ? 'Exhibit Hall' : null,
     row.role, row.note, 'entity_review', row.exhibiting ? 'exact' : null, 'eu',
     row.studies == null ? null : row.studies,
     row.patients == null ? null : row.patients,
     row.molecules == null ? 0 : row.molecules,
     row.sponsors ? JSON.stringify(row.sponsors) : null]);
  return res.rows[0] && res.rows[0].inserted;
}

async function main() {
  // ── 1. The sponsors: who is developing a drug. Same universe, two different pitches. ────
  let sponsors = [];
  try {
    sponsors = (await query(SPONSOR_SQL)).rows.filter((r) => isBuyer(r.sponsor));
  } catch (e) {
    console.error('could not read clinical_studies:', e.message);
    console.error('This script must run inside Railway: railway ssh \'node scripts/seed-scope-targets.js\'');
    process.exit(1);
  }

  const planned = [];

  for (const [name, note] of EXHIBITORS.abiozen) {
    planned.push({ name, exhibitor_name: name, exhibiting: true, role: 'abiozen',
                   note: 'CRO/CDMO on the floor · ' + note });
  }
  for (const [name, note] of EXHIBITORS.linkable) {
    planned.push({ name, exhibitor_name: name, exhibiting: true, role: 'linkable',
                   note: 'Staffing · ' + note });
  }

  for (const s of sponsors) {
    const quote = s.sourceable
      ? `${s.sourceable} of its ${s.molecules} molecules quotable today`
      : `none of its ${s.molecules} molecules quotable yet`;
    planned.push({
      name: s.sponsor, exhibiting: false, role: 'abiozen',
      studies: s.studies, patients: s.patients, molecules: s.sourceable,
      note: `Sponsor · ${s.studies} studies${s.recruiting ? `, ${s.recruiting} recruiting` : ''}` +
            `${s.ph3 ? `, ${s.ph3} Phase 3` : ''} · ${quote}`,
    });
    planned.push({
      name: s.sponsor, exhibiting: false, role: 'aros',
      studies: s.studies, patients: s.patients, molecules: 0,
      // The AROS pitch is regulatory burden, so the note is the burden — not the molecules.
      note: `Sponsor · carries the regulatory file for ${s.studies} stud${s.studies === 1 ? 'y' : 'ies'}` +
            `${s.ph3 ? `, ${s.ph3} at Phase 3` : ''}${s.patients ? `, ${s.patients.toLocaleString()} patients enrolled` : ''}` +
            ` · more trials and later phase means more FDA compliance surface`,
    });
  }

  const byRole = {};
  for (const p of planned) byRole[p.role] = (byRole[p.role] || 0) + 1;
  for (const p of planned) {
    if (!isRoleOf(EVENT, p.role)) throw new Error(`"${p.role}" is not a role of ${EVENT}`);
  }

  console.log(`── SCOPE Europe 2026 targets · the three tabs as defined by Naresh on 9 Oct`);
  console.log(`   ${sponsors.length} INDUSTRY sponsors read from clinical_studies (top ${TOP_SPONSORS})`);
  console.log(`   ${planned.length} rows planned:`);
  for (const [role, n] of Object.entries(byRole)) console.log(`      ${role.padEnd(10)} ${n}`);
  console.log();
  console.log(`   abiozen  = ${EXHIBITORS.abiozen.length} CRO/CDMO exhibitors + ${sponsors.length} sponsors (the buyers are attendees, not booths)`);
  console.log(`   aros     = ${sponsors.length} sponsors, ranked by regulatory load. The 25 eClinical`);
  console.log(`              platforms previously here are COMPETITORS and are removed.`);
  console.log(`   linkable = ${EXHIBITORS.linkable.length} staffing firm(s) — ZERO, and researched rather than assumed.`);
  console.log(`              All 61 sponsors were checked: not one places people into jobs. SCOPE's`);
  console.log(`              exhibitors sell software, data, logistics and lab services TO sponsors.`);
  console.log(`              Work LinkAble from the ATTENDEE list — 800 executives from 300`);
  console.log(`              organisations, every one of them with jobs to fill — not from the floor.`);
  console.log();

  const toRemove = [];
  for (const [role, names] of Object.entries(WRONG_TAB)) {
    for (const n of names) toRemove.push({ role, name: n, norm: normalizeCompany(n) });
  }
  console.log(`   ${toRemove.length} rows to REMOVE from a tab they do not belong in:`);
  console.log(`      aros     ${WRONG_TAB.aros.length} competitors (eClinical platforms, not buyers of a regulatory OS)`);
  console.log(`      linkable ${WRONG_TAB.linkable.length} patient-recruitment firms (they enrol patients, not staff)`);

  if (!EXECUTE) {
    console.log('\n   DRY RUN — nothing written. Re-run with --execute.');
    return;
  }

  // Remove by (event, role, holder_normalized) — the exact unique key, never by pattern.
  let removed = 0;
  for (const r of toRemove) {
    const res = await query(
      `DELETE FROM cphi_exhibitor_matches
        WHERE event_slug = $1 AND role = $2 AND holder_normalized = $3`,
      [EVENT, r.role, r.norm]);
    if (res.rowCount) { removed += res.rowCount; console.log(`      − ${r.role.padEnd(9)} ${r.name}`); }
  }

  let ins = 0, upd = 0;
  for (const p of planned) {
    if (await upsert(p)) ins++; else upd++;
  }
  console.log(`\n   ✅ ${ins} inserted, ${upd} updated, ${removed} removed.`);

  const counts = (await query(
    `SELECT role, COUNT(*)::int n, COUNT(*) FILTER (WHERE exhibiting)::int on_floor
       FROM cphi_exhibitor_matches WHERE event_slug = $1 GROUP BY role ORDER BY role`, [EVENT])).rows;
  console.log('\n   Final state:');
  for (const c of counts) console.log(`      ${c.role.padEnd(10)} ${String(c.n).padStart(4)} rows, ${c.on_floor} on the floor`);
}

main().then(() => process.exit(0))
      .catch((e) => { console.error('seed error:', e.message); process.exit(1); });
