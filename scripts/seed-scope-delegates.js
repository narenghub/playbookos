#!/usr/bin/env node
// ── THE PEOPLE WHO ARE ACTUALLY IN THE ROOM AT SCOPE. ─────────────────────────
//
//   railway ssh 'node scripts/seed-scope-delegates.js'            # dry run
//   railway ssh 'node scripts/seed-scope-delegates.js --execute'  # writes
//
// WHY THIS EXISTS, AND IT IS NARESH'S OBSERVATION NOT MINE:
//
// He went to SCOPE Orlando last year and found "so many labs and buyers, clinical institutes who
// run CRO and support CRO". Those are DELEGATES, not exhibitors — which is the same reason the
// 61-company sponsor list yielded only six Abiozen prospects, and the same reason the molecule
// buyers are attendees. SCOPE Europe is 750+ participants from 400+ organisations against roughly
// 65 booths. The room is an order of magnitude bigger than the hall.
//
// So this seeds the two delegate populations we already hold data for and had not used:
//
//   RESEARCH INSTITUTIONS → abiozen. Academic centres, hospitals, cancer centres and institutes
//   that run trials. They buy RESEARCH-GRADE material, which is the business Naresh said he is
//   starting with ("only for the research use only"). My Abiozen tab filtered
//   sponsor_type = 'INDUSTRY', which deliberately excluded exactly these — so the ranked list was
//   missing his most likely first customers. That filter was a mistake and this is the correction.
//
//   LABS → qc_lab. Analytical and QC laboratories to recruit into LabConnect. A different
//   conversation from everything else on the page: we are buying their capacity, not selling to
//   them, which is why it earns its own tab rather than rows inside Abiozen.
//
// ── EU FIRST, BUT NOT EU ONLY ────
//
// The show is in Barcelona, so European rows come first — but a US institution or lab with real
// activity may well send someone, and excluding them outright would hide people who are standing
// in the room. They are included and marked, rather than filtered out on a guess about travel.
'use strict';

const { query } = require('../src/lib/db');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { isRoleOf } = require('../src/lib/events/registry');
// The two source tables use DIFFERENT country conventions — labs.country is ISO-3,
// research_institutions.country holds full names — and the first version of this script tested
// `country <> 'USA'`, so 80 American hospitals were reported as non-US and stamped market='eu'
// three days before a show in Barcelona. src/lib/events/country.js now owns both conventions.
const { marketOfCountry, europeFirstSql, europeFirstParams } = require('../src/lib/events/country');
// ── THE FIX I BUILT YESTERDAY AND THEN DID NOT USE ────
//
// The first version of the lab query ordered by `(region LIKE 'eu%') DESC, (contact_email IS NOT
// NULL) DESC, name`. All 60 rows were EU with a contact, so both leading terms were CONSTANT and
// the result was ALPHABETICAL: ACS Dobfar, Aesica, AGC Biologics, Ajinomoto, Albhades, Alexion.
// That is the identical bug, on the identical table, that produced "2seventy bio" and three
// numbered Québec companies in the CPHI lab lookup — and src/lib/labconnect/lab-shape.js exists
// precisely because of it.
//
// Worse than the ordering: ACS Dobfar, Aesica, AGC Biologics, Ajinomoto Omnichem and Alexion are
// API MANUFACTURERS and CDMOs, not analytical laboratories. The labs table is seeded from the FDA
// establishment register, which does not distinguish "makes drugs" from "tests drugs" — the same
// register, and the same failure, that filled the CPHI buyer tab with dairies and poultry farms.
// looksLikeLabSql is the shape test that separates the two.
// Both lab queries live in src/lib/events/lab-delegates.js so scripts/check-lab-delegates-sql.js
// can execute the SHIPPED query rather than its own rebuild of it.
const { labDelegateSql, labShapeAuditSql } = require('../src/lib/events/lab-delegates');
const { isStrongLab, groupKey } = require('../src/lib/labconnect/lab-shape');
const { staleRows } = require('../src/lib/events/stale-rows');

const EVENT = 'scope-europe-2026';
const EXECUTE = process.argv.includes('--execute');
const num = (flag, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  const n = hit ? parseInt(hit.split('=')[1], 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : dflt;
};
const TOP_INSTITUTES = num('institutes', 80);
const TOP_LABS = num('labs', 60);
// One corporate group may hold at most this many rows. Eurofins took five of the top eight before
// this existed, and Eurofins has one stand. `--max-per-group=0` disables it, which is how to see
// what the cap is doing rather than taking its word for it.
const MAX_PER_GROUP = process.argv.some((a) => a === '--max-per-group=0') ? 0 : num('max-per-group', 4);

// A site last seen in 2013 is not an active lab. Three years is generous for trial data, which
// lags, but it excludes the long tail of sites that have not run anything in a decade.
const ACTIVE_SINCE = '2023-01-01';

// ── RESEARCH INSTITUTIONS: the research-grade molecule buyers ────
//
// Ranked by study_count, which is the activity proxy the table was built around. A contact on file
// sorts above one without, because an institution we cannot reach is a name rather than a lead —
// but it is NOT filtered out, since Naresh will be standing in the same room as them.
// $1 = European full names (lowercase), $2 = European ISO-3 codes. Both, because this table holds
// names and the platform's EUROPE list holds codes.
const INSTITUTE_SQL = `
  SELECT name, city, country, facility_type, study_count, contact_name, contact_email, last_seen
    FROM research_institutions
   WHERE facility_type IS NOT NULL
     AND (last_seen IS NULL OR last_seen >= DATE '${ACTIVE_SINCE}')
   ORDER BY ${europeFirstSql('country', 1)},
            (contact_email IS NOT NULL) DESC,
            study_count DESC,
            name
   LIMIT ${TOP_INSTITUTES}`;

// ── LABS: the QC Partners tab ────
//
// The queries, and the reasoning behind the shape filter, are in src/lib/events/lab-delegates.js.
const LAB_SQL = labDelegateSql(TOP_LABS, MAX_PER_GROUP);
const LAB_SHAPE_AUDIT_SQL = labShapeAuditSql();

const FACILITY_LABEL = {
  academic: 'Academic centre', hospital: 'Hospital',
  cancer_centre: 'Cancer centre', institute: 'Research institute',
};

async function upsert(row) {
  const res = await query(
    `INSERT INTO cphi_exhibitor_matches
       (event_slug, holder, holder_normalized, exhibitor_name, exhibiting, booth, hall,
        role, role_note, review_status, match_tier, market,
        studies_count, patients_count, molecules_covered, checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW())
     ON CONFLICT (event_slug, role, holder_normalized) DO UPDATE
       SET role_note     = EXCLUDED.role_note,
           studies_count = EXCLUDED.studies_count,
           market        = EXCLUDED.market,
           checked_at    = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [EVENT, row.displayName || row.name, row.dedupeKey || normalizeCompany(row.name),
     null, false, null, null,
     row.role, row.note, 'entity_review', null, row.market,
     row.studies == null ? null : row.studies, null, 0]);
  return res.rows[0] && res.rows[0].inserted;
}

async function main() {
  let institutes = [];
  let labs = [];
  const problems = [];

  // No throwaway catches. A missing table is a DIFFERENT answer from an empty one, and a script
  // that blurs the two printed a confident false zero in this repo yesterday.
  try { institutes = (await query(INSTITUTE_SQL, europeFirstParams())).rows; }
  catch (e) { problems.push(`research_institutions: ${e.message}`); }
  try { labs = (await query(LAB_SQL)).rows; }
  catch (e) { problems.push(`labs: ${e.message}`); }
  let labAudit = null;
  try { labAudit = (await query(LAB_SHAPE_AUDIT_SQL)).rows[0]; }
  catch (_) { /* the LAB_SQL failure above already says the table is unreadable */ }

  if (problems.length) {
    console.log('⚠ could not read a source table:\n');
    for (const p of problems) console.log(`   ${p}`);
    console.log('\n   Run the matching migration first (migrate-research-institutions.js /');
    console.log('   migrate-labconnect.js), and note this must run INSIDE Railway.\n');
  }

  const planned = [];
  for (const i of institutes) {
    const where = [i.city, i.country].filter(Boolean).join(', ');
    const reach = i.contact_email ? `contact on file` : 'no contact on file';
    planned.push({
      name: i.name, role: 'abiozen',
      // marketOfCountry, not a string comparison. It returns null for a country it cannot place,
      // and null is written as null — a row we cannot locate must not be filed under a market,
      // because a wrong market is worse than a blank one on a list for a specific city.
      market: marketOfCountry(i.country),
      studies: i.study_count || null,
      note: `${FACILITY_LABEL[i.facility_type] || i.facility_type}` +
            `${where ? ` · ${where}` : ''} · ${i.study_count || 0} trials run · ${reach}` +
            ` · buys RESEARCH-GRADE material, not GMP`,
    });
  }
  for (const l of labs) {
    const where = [l.city, l.country].filter(Boolean).join(', ');
    const caps = [l.research_capable ? 'research' : null, l.gmp_capable ? 'GMP' : null]
      .filter(Boolean).join(' + ') || 'capability unknown';
    planned.push({
      name: l.name, role: 'qc_lab',
      // The lab's own region prefix is authoritative where it exists (it is the LabConnect routing
      // key); fall back to the country for rows whose region could not be determined.
      market: l.region && /^eu/.test(l.region) ? 'eu' : marketOfCountry(l.country),
      // ONE FIRM, MANY SITES. labs is deduped on (name_normalized, address) because a laboratory
      // group has a site per city, but cphi_exhibitor_matches is unique on
      // (event_slug, role, holder_normalized) — so "Eurofins Madrid" and "Eurofins Lancaster"
      // collapsed onto one row and the second silently overwrote the first. The first run planned
      // 60 labs and stored 47: thirteen lost, reported as "13 updated".
      //
      // The city joins the identity for a lab, so each site keeps its own row, its own met flag and
      // its own cards. Without it a visit to one site would mark the whole group as met.
      // The country is ALWAYS part of the key, not just the city. "Almac Pharma Services Limited"
      // (GBR) and "Almac Pharma Services (Ireland) Limited" (IRL) normalise to the same company
      // name and BOTH have a NULL city, so a city-only key collapsed two separate legal entities
      // into one row and the second silently overwrote the first — the thirteen-labs-lost failure
      // in a smaller, harder-to-see form, since the dry run reported it as a collision to "check"
      // rather than as a loss.
      dedupeKey: [normalizeCompany(l.name), l.city ? normalizeCompany(l.city) : '',
                  l.country ? normalizeCompany(l.country) : ''].filter(Boolean).join(' '),
      // Plain substring, NOT a regex. `new RegExp(l.city)` on "Almac Pharma Services (Ireland)"
      // style values throws on an unbalanced parenthesis, and a city with a '+' or '.' in it
      // matches things it should not. The register's city values are not trusted input.
      displayName: l.city && !String(l.name).toLowerCase().includes(String(l.city).toLowerCase())
        ? `${l.name} — ${l.city}`
        : (!l.city && l.country ? `${l.name} — ${l.country}` : l.name),
      studies: null,
      note: `Lab${where ? ` · ${where}` : ''} · ${caps} · status ${l.status}` +
            `${l.contact_email ? ' · contact on file' : ' · no contact on file'}` +
            ` · RECRUIT into LabConnect, we buy their capacity`,
    });
  }

  // Collisions AFTER the keys are built, so a remaining one is reported rather than discovered as
  // a missing row. Two sites of one firm in the same city genuinely are one target.
  const keySeen = new Map();
  const collisions = [];
  for (const p of planned) {
    const k = `${p.role}|${p.dedupeKey || normalizeCompany(p.name)}`;
    if (keySeen.has(k)) collisions.push([keySeen.get(k), p.name, k]);
    else keySeen.set(k, p.name);
  }

  for (const p of planned) {
    if (!isRoleOf(EVENT, p.role)) throw new Error(`"${p.role}" is not a role of ${EVENT}`);
  }

  const byRole = {};
  for (const p of planned) byRole[p.role] = (byRole[p.role] || 0) + 1;

  console.log('── SCOPE Europe 2026 · the DELEGATE populations, which is where the room actually is\n');
  console.log(`   research institutions read  ${institutes.length}`);
  console.log(`   labs read                   ${labs.length}`);
  console.log(`   rows planned                ${planned.length}`);
  for (const [role, n] of Object.entries(byRole)) console.log(`      ${role.padEnd(10)} ${n}`);

  if (collisions.length) {
    console.log(`\n   ⚠ ${collisions.length} name collision(s) — these would share ONE row:`);
    for (const [first, second, k] of collisions.slice(0, 10)) {
      console.log(`      "${first}" + "${second}"  →  ${k}`);
    }
    console.log('      Two sites of one firm in one city genuinely are one target, so this is');
    console.log('      reported rather than fatal — but check it is not two different companies.');
  }

  if (institutes.length) {
    // Counted with the real classifier. The first version counted `country <> 'USA'` and reported
    // "80 non-US" over a list of American hospitals.
    const tally = { eu: 0, us: 0, row: 0, unknown: 0 };
    for (const i of institutes) tally[marketOfCountry(i.country) || 'unknown']++;
    const withContact = institutes.filter((i) => i.contact_email).length;
    console.log(`\n   institutions: ${tally.eu} EUROPE · ${tally.us} US · ${tally.row} elsewhere · ` +
                `${tally.unknown} country not placeable · ${withContact} with a contact on file`);
    if (!tally.eu) {
      console.log('   ⚠ NOT ONE European institution in this cut. The show is in Barcelona, so');
      console.log('     either research_institutions holds no European sites, or their country');
      console.log('     spelling is missing from src/lib/events/country.js. Check before relying');
      console.log('     on this list — a US-only list is the wrong list for this trip.');
    }
    if (tally.unknown) {
      console.log(`   ⚠ ${tally.unknown} row(s) have a country this build cannot place. If any are`);
      console.log('     European they are being sorted below US rows. Add the spelling to country.js.');
    }
    const types = {};
    for (const i of institutes) types[i.facility_type] = (types[i.facility_type] || 0) + 1;
    console.log(`   by type: ${Object.entries(types).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
    console.log('\n   top 8 by trials run:');
    for (const i of institutes.slice(0, 8)) {
      console.log(`      ${String(i.name).slice(0, 44).padEnd(46)} ${String(i.study_count || 0).padStart(4)} trials  ` +
                  `${i.contact_email ? '✉' : ' '} ${[i.city, i.country].filter(Boolean).join(', ')}`);
    }
  }
  if (labAudit) {
    const a = labAudit;
    console.log(`\n   how the QC list is narrowed, stage by stage:`);
    console.log(`      ${a.eligible} labs eligible by status`);
    console.log(`      ${a.reads_like_a_lab} read like a testing business`);
    console.log(`      −${a.api_manufacturer_flag} the FDA register flags as also an API manufacturer (notes)`);
    console.log(`      −${a.originator} are originator pharma whose "Laboratories" is historical (Abbott, AbbVie…)`);
    console.log(`      = ${a.kept} kept · ${a.kept_strong} of those SELL analysis by name, the rest just say "Laboratories"`);
    console.log(`      ${a.kept_eu} European rows → ${a.kept_eu_companies} distinct companies (one row per firm per city)`);
    if (a.kept_eu_companies < TOP_LABS) {
      console.log(`      ⚠ fewer European companies than the ${TOP_LABS} asked for. That is the real`);
      console.log(`        supply; padding it back would put the manufacturers straight back on the tab.`);
    }
  }
  if (labs.length) {
    const eu = labs.filter((l) => l.region && /^eu/.test(l.region)).length;
    const withContact = labs.filter((l) => l.contact_email).length;
    console.log(`\n   labs: ${eu} in an EU region, ${withContact} with a contact on file`);
    console.log(`   top 8 by lookup rank:`);
    for (const l of labs.slice(0, 8)) {
      const sig = isStrongLab(l.name) ? 'sells analysis' : 'name says "lab" only';
      console.log(`      ${String(l.name).slice(0, 38).padEnd(40)} ${String(l.sites || 1).padStart(2)} site(s)  ` +
                  `${l.contact_email ? '✉' : ' '} ${[l.city, l.country].filter(Boolean).join(', ').slice(0, 20).padEnd(22)} ${sig}`);
    }
    // ONE GROUP, ONE BOOTH. Before the cap existed this list was five-eighths Eurofins, which is
    // five slots spent on one conversation. Printed so the concentration is visible either way.
    const groups = new Map();
    for (const l of labs) groups.set(groupKey(l.name), (groups.get(groupKey(l.name)) || 0) + 1);
    const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`   ${groups.size} corporate group(s) across ${labs.length} rows` +
                `${MAX_PER_GROUP ? ` · capped at ${MAX_PER_GROUP} rows per group` : ' · NO CAP (--max-per-group=0)'}`);
    console.log(`      largest: ${top.map(([g, n]) => `${g} ${n}`).join(' · ')}`);
    if (MAX_PER_GROUP && top.length && top[0][1] > MAX_PER_GROUP) {
      console.log(`      ⚠ "${top[0][0]}" holds ${top[0][1]} rows, above the cap of ${MAX_PER_GROUP} —`);
      console.log(`        the cap is applied per corporate group, so this means the group key is`);
      console.log(`        splitting one firm into several. Check groupKey() against these names.`);
    }
    const distinctKeys = new Set(planned.filter((p) => p.role === 'qc_lab').map((p) => p.dedupeKey)).size;
    console.log(`   ${labs.length} labs → ${distinctKeys} distinct rows (city is part of a lab's identity,`);
    console.log(`   so each site keeps its own met flag and its own cards)`);
  }

  // Labs already partnered are NOT recruitment targets. Reported so the number is explained
  // rather than looking like a gap in the list.
  try {
    const active = (await query(`SELECT COUNT(*)::int n FROM labs WHERE status = 'active'`)).rows[0].n;
    if (active) console.log(`   (${active} lab(s) already active in LabConnect are excluded — they are partners, not targets)`);
  } catch (_) { /* reported above if the table is missing */ }

  // ── STALE ROWS FROM THE FIRST RUN, WHICH USED A DIFFERENT KEY ────
  //
  // The first version keyed a lab on its name alone. This one includes the city, so re-running does
  // not overwrite those rows — it ADDS beside them, leaving "Eurofins" next to "Eurofins — Madrid"
  // and "Eurofins — Lancaster". A reseed that quietly doubles a list is worse than one that fails.
  //
  // So: find qc_lab rows whose key is not among the planned ones. Delete only the UNTOUCHED ones —
  // no met flag, no cards — and KEEP anything a human has worked, because a met flag is somebody's
  // Tuesday and no script gets to throw that away. Named individually, never deleted by pattern.
  const plannedKeys = new Set(planned.filter((p) => p.role === 'qc_lab').map((p) => p.dedupeKey));
  let stale = [], removable = [], keepers = [];
  try {
    // One definition, in src/lib/events/stale-rows.js. The second hand-written copy of this query
    // named a `contact_cards` column that does not exist — a contact card is a ROW in
    // cphi_exhibitor_contacts — and it would have thrown on the first --execute.
    ({ stale, removable, keepers } = await staleRows(query, EVENT, 'qc_lab', plannedKeys));
  } catch (e) {
    console.log(`\n   ⚠ could not check for stale rows: ${e.message}`);
  }
  if (stale.length) {
    console.log(`\n   ${stale.length} qc_lab row(s) carry a key this run no longer produces:`);
    console.log(`      ${removable.length} untouched → will be removed (they are duplicates of the new rows)`);
    if (keepers.length) {
      console.log(`      ${keepers.length} WORKED → kept, because a met flag or a card is somebody's work:`);
      for (const r of keepers) {
        console.log(`         ${r.holder}${r.met_in_person ? ' · met' : ''}${r.cards ? ` · ${r.cards} card(s)` : ''}`);
      }
      console.log('      Those will sit beside the new per-site rows. Merge them by hand, or leave them.');
    }
  }

  if (!EXECUTE) {
    console.log('\n   DRY RUN — nothing written. Re-run with --execute.');
    return;
  }

  let removed = 0;
  for (const r of removable) {
    const res = await query(`DELETE FROM cphi_exhibitor_matches WHERE id = $1`, [r.id]);
    if (res.rowCount) { removed++; console.log(`      − ${r.holder}`); }
  }

  let ins = 0, upd = 0;
  for (const p of planned) { if (await upsert(p)) ins++; else upd++; }
  console.log(`\n   ✅ ${ins} inserted, ${upd} updated, ${removed} stale removed.`);

  const counts = (await query(
    `SELECT role, COUNT(*)::int n, COUNT(*) FILTER (WHERE exhibiting)::int on_floor
       FROM cphi_exhibitor_matches WHERE event_slug = $1 GROUP BY role ORDER BY role`, [EVENT])).rows;
  console.log('\n   Final state:');
  for (const c of counts) console.log(`      ${c.role.padEnd(10)} ${String(c.n).padStart(4)} rows, ${c.on_floor} on the floor`);
  console.log('\n   Every row here is exhibiting=false: these are DELEGATES. Nobody has a booth, so');
  console.log('   they are found in sessions, at the networking, and through the attendee app —');
  console.log('   which is the whole point. The hall is 65 companies; the room is 400.');
}

main().then(() => process.exit(0))
      .catch((e) => { console.error('seed error:', e.message); process.exit(1); });
