// ── CPHI Milan 2026: the cards collected on the floor ─────────────────────────
//
//   node scripts/seed-cphi-contacts.js            # DRY RUN — shows what matches what
//   node scripts/seed-cphi-contacts.js --write    # insert/update
//
// Transcribed from the physical cards and QR vCards collected on day 1, 6 October 2026. Every
// field is as printed. Nothing here is inferred: where a card is ambiguous the ambiguity is
// written into `note` rather than resolved by guessing, because a wrong legal entity on a supply
// contract is expensive and a note costs nothing.
//
// ── HOW A CARD IS TIED TO A BOOTH ────────────────────────────────────────────
//
// By the SAME name-matching the exhibitor lookup uses (src/lib/cphi/match-company.js), not by a
// hand-written mapping. A hand-written one would be right today and silently wrong after the next
// quarterly re-run renames a holder. Unmatched cards are still imported — see the migration header.
//
// IDEMPOTENT: unique on (event, company fold, lower(name)), so a re-run refreshes.

const { initDB, query } = require('../src/lib/db');
const { normalizeCompany, companyCore } = require('../src/lib/cphi/match-company');

const EVENT = 'cphi-milan-2026';
const WRITE = process.argv.includes('--write');

const CARDS = [
  { company: 'TAPI', name: 'Quyen Nguyen', title: 'Associate Director of Key Accounts, NA',
    email: 'quyen.nguyen@tapi.com', office: '+1 973-307-5179', source: 'card',
    note: 'Only US-based contact collected on day 1.' },

  { company: "Dr. Reddy's Laboratories Ltd", name: 'Ashish Rana', title: 'Head, API — US & Canada',
    email: 'rashish@drreddys.com', mobile: '+1 609-819-6840', office: '+91 40 4900 2900',
    website: 'api.drreddys.com',
    address: "8-2-337, Road No. 3, Banjara Hills, Hyderabad 500034, Telangana, India",
    source: 'digital card', note: 'US & Canada remit — correct seniority for a US buyer.' },

  { company: 'Sun Pharmaceutical Industries Ltd', name: 'Ketan Rathod',
    title: 'Senior General Manager — API Marketing', email: 'ketan.rathod1@sunpharma.com',
    mobile: '+91 88009 83623', office: '+91 22 7166 4252 (direct)', website: 'www.sunpharma.com',
    address: 'Acme Plaza, Andheri-Kurla Road, Andheri (E), Mumbai 400059, Maharashtra, India',
    source: 'card', note: 'Main line +91 22 7166 4224 / 6696 9696.' },

  { company: 'Hetero Labs Limited', name: 'Murty Mokkarala',
    title: 'Vice President, Head — CMO/CDMO Business Services', email: 'Murty.Mokkarala@hetero.com',
    mobile: '+91 8121014746', office: '+91 40 2370 4923 ext 9902', website: 'www.hetero.com',
    address: 'RMZ Nexity, Tower 30, 11th Floor, Knowledge City, Raidurg, Serilingampally, Hyderabad 500081, Telangana, India',
    source: 'card',
    note: 'CONFIRM NAME: card prints "M S N Murty", email reads Murty.Mokkarala. Alt mobile +91 7680885243. CDMO side — ask about capacity and tech transfer, not a DMF list.' },

  { company: 'Hetero Labs Limited', name: 'B. Shalini Reddy',
    title: 'Assistant Manager, International API Regulatory Marketing', email: 'shalini.b@hetero.com',
    mobile: '+91 9100902951', office: '+91 40 2370 4923', website: 'www.hetero.com',
    address: 'RMZ Nexity, Tower 30, 9/10/11th Floor, Knowledge City, Raidurg, Serilingampally, Hyderabad 500081, Telangana, India',
    source: 'card', note: 'Regulatory side — the right person for DMF questions.' },

  { company: 'MSN Laboratories Private Limited', name: 'Udaya Sagar G.',
    title: 'Portfolio & Business Development', email: 'udayasagar.gavini@msnlabs.com',
    mobile: '+91 98856 68398', office: '+91 40 3043 8800 ext 8517', website: 'www.msnlabs.com',
    address: 'H. No. 2-91/10&11, Whitefields, Kondapur, Hyderabad 500084, Telangana, India',
    source: 'card', note: 'Portfolio role — ask for the full DMF list.' },

  { company: 'Biocon Limited', name: 'Rohin Verma',
    title: 'Business Development & Sales — Europe, API Commercial', email: 'rohin.verma@biocon.com',
    mobile: '+91 9986523071', website: 'www.biocon.com',
    address: 'Biocon House, Semicon Park, Electronic City Phase 2, Bengaluru 560100, India',
    source: 'card', note: 'Europe remit — will need a US counterpart introduction.' },

  { company: 'Natco Pharma', name: 'Vinod J',
    title: 'Assistant General Manager, API Sales & Business Development',
    email: 'vinod@natcopharma.co.in', mobile: '+91 80743 46116', office: '+91 40 2354 7532 ext 343',
    website: 'www.natcopharma.co.in', source: 'card' },

  { company: 'Gland Pharma Limited', name: 'Karthik Ulaganathan',
    title: 'Head — Business Development & Licensing', email: 'karthik.ulaganathan@glandpharma.com',
    mobile: '+91 81698 83026', office: '+91 8455 699999 ext 1228', website: 'www.glandpharma.com',
    address: 'TSIIC Phase IV, Pashamylaram, Patancheru (M), Sangareddy Dist., Hyderabad 502307, India',
    source: 'card', note: 'Sterile injectables focus.' },

  { company: 'Emcure Pharmaceuticals Ltd', name: 'Priya Agarwal',
    title: 'AGM — API Business Development (USA & EU)', email: 'Priya.Agarwal@emcure.com',
    mobile: '+91 7506060937', office: '+91 22 6942 0000', website: 'www.emcure.com',
    address: '4th Floor, Light Bridge, House of Hiranandani, Saki Vihar Road, Andheri (E), Mumbai 400072, India',
    source: 'card', note: 'USA & EU remit — directly relevant.' },

  { company: 'Biophore India Pharmaceuticals Pvt Ltd', name: 'Gautham Manthena',
    title: 'Head — Business Development, IND-US Market', email: 'gautham@biophore.com',
    mobile: '+91 80597 76672', office: '+91 40 4747 4545', website: 'www.biophore.com',
    address: '1-98/2/92, Plot 92, Phase II, Kavuri Hills, Jubilee Hills, Hyderabad 500033, India',
    source: 'card', note: 'Card carries a QR to their product list — capture the URL.' },

  { company: 'Matrix Pharmacorp Pvt. Ltd.', name: 'Kishore Addanki', title: 'AGM — CDMO Global Sales',
    email: 'Kishore.addanki@matrixpharmacorp.com', mobile: '+91 9121001944',
    website: 'matrixpharmacorp.com',
    address: 'Plot 1-60/35/A, 6th–9th Floor, HITEC City Phase II, Gachibowli, Serilingampally, Hyderabad 500081, Telangana, India',
    source: 'QR vCard', note: 'CDMO — contract manufacturing, not catalogue API.' },

  { company: 'Allchem Lifescience Ltd.', name: 'Dhruvil Patel', title: 'Business Development Manager',
    email: 'dhruvil@allchemlifescience.com', mobile: '+91 90544 42409', office: '+91 95747 22211',
    website: 'www.allchemlifescience.com',
    address: 'Block 1088/A, B/P, Lamdapura Road, Manjusar, Savli, Vadodara 391775, Gujarat, India',
    source: 'card', note: 'General inbox: info@allchemlifescience.com' },

  { company: 'Formosa Laboratories, Inc.', name: 'Trevor Huang', title: 'Marketing & Sales',
    email: 'trevorhuang@formosalab.com', mobile: '+886 965 232 962', office: '+886 3 324 0895 ext 261',
    address: '36 Heping St., Luzhu Dist., Taoyuan 338002, Taiwan', source: 'card',
    note: 'Taiwan — supply diversification away from the India/China bench.' },

  { company: 'Sintaho Pharmaceutical (Chongqing Xingtaihao)', name: 'Wu Minnan',
    title: 'Marketing Director', email: 'wu.minnan@polymedt.com', mobile: '+86 13752911633',
    office: '+86 23 88961270',
    address: 'Qingliu Road 600, Maliuzui, Banan District, Chongqing, China', source: 'card',
    note: 'CONFIRM ENTITY: email domain polymedt.com does not match the trading name on the card.' },
];

const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);

async function main() {
  await initDB();

  // Every exhibitor row for this event, so a card can be tied to a booth by the SAME fold the
  // matcher uses. Loaded once: 300-odd rows, and a per-card query would be 15 round trips.
  const matches = (await query(
    `SELECT id, holder, holder_normalized, booth, hall, exhibiting, molecules_covered
       FROM cphi_exhibitor_matches WHERE event_slug = $1`, [EVENT])).rows;

  const byNorm = new Map(), byCore = new Map();
  for (const m of matches) {
    const norm = normalizeCompany(m.holder);
    const core = companyCore(m.holder);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, m);
    // Core can collide (two Hetero entities); keep the one covering most molecules, which is the
    // one the floor list ranks first and the one a person would have been standing at.
    if (core) {
      const prev = byCore.get(core);
      if (!prev || (m.molecules_covered || 0) > (prev.molecules_covered || 0)) byCore.set(core, m);
    }
  }

  console.log(`\n── ${CARDS.length} cards against ${matches.length} exhibitor rows ──────────────────────\n`);
  console.log(`  ${pad('CARD COMPANY', 42)} ${pad('MATCHED HOLDER', 34)} ${pad('BOOTH', 10)} MOL`);

  const rows = [];
  let tied = 0;
  for (const c of CARDS) {
    const norm = normalizeCompany(c.company);
    const core = companyCore(c.company);
    const m = byNorm.get(norm) || (core ? byCore.get(core) : null) || null;
    if (m) tied += 1;
    rows.push({ ...c, match: m, company_normalized: norm });
    console.log(`  ${pad(c.company, 42)} ${pad(m ? m.holder : '— no DMF-holder match —', 34)} ` +
                `${pad(m && m.booth ? m.booth : '—', 10)} ${m ? m.molecules_covered : ''}`);
  }

  console.log(`\n  tied to a booth ${tied} · standalone ${CARDS.length - tied}`);
  console.log('  A standalone card is NOT an error: a CDMO or an intermediate maker holds no DMF.');
  console.log('  It is imported either way and stays reachable from the contacts list.\n');

  if (!WRITE) {
    console.log('── dry run ─────────────────────────────────────────────────────────────────');
    console.log(`  Nothing written. Re-run with --write to insert ${CARDS.length} contacts.\n`);
    return;
  }

  let inserted = 0, updated = 0;
  for (const r of rows) {
    const res = await query(
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
       RETURNING (xmax = 0) AS was_insert`,
      [EVENT, r.match ? r.match.id : null, r.company, r.company_normalized, r.name, r.title || null,
       r.email || null, r.mobile || null, r.office || null, r.website || null, r.address || null,
       r.source || 'card', r.note || null]);
    if (res.rows[0] && res.rows[0].was_insert) inserted += 1; else updated += 1;
  }

  // Mark the companies as met. This is what day 2 filters on, so it is part of the same import
  // rather than a separate step somebody forgets.
  const ids = rows.filter(r => r.match).map(r => r.match.id);
  if (ids.length) {
    await query(
      `UPDATE cphi_exhibitor_matches
          SET met_in_person = TRUE, met_at = COALESCE(met_at, NOW())
        WHERE id = ANY($1)`, [ids]);
  }

  const total = (await query(
    `SELECT COUNT(*)::int n FROM cphi_exhibitor_contacts WHERE event_slug = $1`, [EVENT])).rows[0].n;
  console.log('── writing ─────────────────────────────────────────────────────────────────');
  console.log(`  inserted ${inserted}, updated ${updated}`);
  console.log(`  ${ids.length} exhibitor row(s) marked met_in_person`);
  console.log(`  contacts for ${EVENT}: ${total}\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('seed failed:', e && e.message ? e.message : e);
  process.exit(1);
});
