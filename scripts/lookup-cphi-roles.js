// ── CPHI: WHICH OF OUR LABS AND BUYERS ARE ON THE FLOOR ───────────────────────
//
//   node scripts/lookup-cphi-roles.js --role qc_lab              # DRY RUN, first 10
//   node scripts/lookup-cphi-roles.js --role qc_lab --execute
//   node scripts/lookup-cphi-roles.js --role buyer --execute --limit 200
//
// The supplier lookup asks "is this DMF holder on the floor". This asks the same question of the
// other two sides of the business, using the same public directory and the same name matcher.
//
//   --role qc_lab   Analytical testing laboratories from fda_establishments. These are LabConnect
//                   RECRUITS, and LabConnect currently has ZERO active labs — so a lab found on
//                   this floor is worth more than a lab found in a database, because you can walk
//                   to it and ask the three questions that activate it.
//
//   --role buyer    Manufacturers with no analytical registration of their own — they outsource
//                   their testing today. See src/lib/labconnect/buyers.js for why that signal is
//                   the sharpest one available without buying new data, and how it can be wrong.
//
// ── ORDERED BY VALUE, so a partial run is still useful ───────────────────────
//
// Hundreds of HTTP requests, serialised. If the widget changes shape or starts refusing halfway,
// you want the half you keep to be the half that matters. Labs are ordered contract-labs-first
// (ANALYSIS and nothing else — the ones actually selling testing), then by whether we hold a
// contactable email. Buyers are ordered by how many tests they are likely to need.
//
// IDEMPOTENT: unique on (event, role, holder_normalized), and a human review verdict is never
// reset by a re-run.

const { query } = require('../src/lib/db');
const { searchTerms, bestMatch, reviewStatusFor, normalizeCompany } = require('../src/lib/cphi/match-company');
const { searchExhibitors, hallOf, entityNote, sleep } = require('../src/lib/cphi/directory');
const { excludedSql } = require('../src/lib/fda/exclusion');
const { outsourcerSql } = require('../src/lib/labconnect/buyers');

const EVENT_SLUG = 'cphi-milan-2026';
const VALID_ROLES = ['qc_lab', 'buyer'];

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const str = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const num = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const ROLE = str('--role', null);
const LIMIT = num('--limit', EXECUTE ? 400 : 10);
const DELAY_MS = num('--delay', 600);
const REGION = str('--region', null);   // e.g. eu, us — prefix match on labs.region

const fmt = (n) => Number(n).toLocaleString('en-US');
const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);

/**
 * LabConnect recruits. Sourced from `labs` when the directory has been populated, because that
 * table carries region, status and the contact a person may have corrected. Contract labs first:
 * a site registered for ANALYSIS and nothing else sells testing, while one that also manufactures
 * is usually testing its own product.
 */
async function qcLabs(limit) {
  const rows = await query(
    `SELECT name AS holder, name_normalized, region, country, state, contact_email,
            (notes IS NULL) AS contract_lab
       FROM labs
      WHERE status <> 'rejected'
        ${REGION ? "AND region LIKE $2 || '%'" : ''}
      ORDER BY (notes IS NULL) DESC, (contact_email IS NOT NULL) DESC, name
      LIMIT $1`,
    REGION ? [limit, REGION] : [limit]);
  return rows.rows.map(r => ({
    holder: r.holder,
    holder_normalized: normalizeCompany(r.holder),
    detail: [r.contract_lab ? 'contract lab' : 'also manufactures', r.region || 'no region']
      .filter(Boolean).join(' · '),
    rank: 0,
  }));
}

/**
 * Who needs outsourced testing: registered to make something, NOT registered for ANALYSIS.
 * The same fragment the LabConnect buyers route uses, so the two cannot disagree about who a
 * buyer is.
 */
async function buyers(limit) {
  // outsourcerSql returns { sql, params, nextIndex } — it owns its own placeholders, so the LIMIT
  // has to take the index it hands back rather than $1.
  const o = outsourcerSql(1);
  const rows = await query(
    `SELECT firm_name AS holder, firm_normalized, country, operations
       FROM fda_establishments
      WHERE ${o.sql}
        AND NOT ${excludedSql()}
      ORDER BY length(operations) DESC, firm_name
      LIMIT $${o.nextIndex}`, [...o.params, limit]);
  return rows.rows.map(r => ({
    holder: r.holder,
    holder_normalized: normalizeCompany(r.holder),
    detail: [r.country || 'US', String(r.operations || '').split(';').length + ' operations']
      .join(' · '),
    rank: 0,
  }));
}

async function main() {
  if (!VALID_ROLES.includes(ROLE)) {
    console.error(`--role must be one of: ${VALID_ROLES.join(', ')}`);
    console.error('(suppliers are handled by scripts/lookup-cphi-exhibitors.js)');
    process.exit(1);
  }

  const scope = ROLE === 'qc_lab' ? await qcLabs(LIMIT) : await buyers(LIMIT);

  if (!scope.length) {
    console.log(`\nNothing to check for role "${ROLE}".`);
    if (ROLE === 'qc_lab') {
      console.log('The `labs` table is empty — run scripts/seed-labs-from-fda.js --write first.');
    }
    process.exit(0);
  }

  console.log(`\n── ${ROLE} against the ${EVENT_SLUG} directory ──────────────────────`);
  console.log(`   checking ${fmt(scope.length)}${EXECUTE ? '' : '   (DRY RUN — nothing is written)'}`
    + `   delay ${DELAY_MS}ms   ~${Math.ceil(scope.length * DELAY_MS * 1.6 / 60000)} min\n`);

  const tally = { exact: 0, core: 0, prefix: 0, token: 0, none: 0, errors: 0 };
  let written = 0, consecutiveErrors = 0;

  for (const [i, h] of scope.entries()) {
    const terms = searchTerms(h.holder);
    let best = null, err = null;
    for (const term of terms) {
      const { hits, error } = await searchExhibitors(term, EVENT_SLUG);
      if (error) { err = error; break; }
      const m = bestMatch(h.holder, hits);
      if (m && (!best || m.tier === 'exact')) best = m;
      if (best && best.tier === 'exact') break;
      await sleep(DELAY_MS);
    }

    if (err) {
      tally.errors += 1;
      consecutiveErrors += 1;
      // STOP RATHER THAN GRIND ON. Ten failures in a row is the widget refusing us, not ten odd
      // names. Continuing would spend an hour writing nothing and look like a completed run.
      if (consecutiveErrors >= 10) {
        console.error(`\n  ABORTED after 10 consecutive errors (last: ${err}).`);
        console.error('  The directory is refusing or has changed shape. Nothing further was checked.');
        break;
      }
    } else {
      consecutiveErrors = 0;
    }
    tally[best ? best.tier : 'none'] += 1;

    console.log(`${String(i + 1).padStart(4)}. ${pad(h.holder, 44)} ${pad(h.detail, 26)} `
      + (best ? `${pad(best.tier, 7)}${pad(best.booth || '-', 8)}${best.name}` : 'not exhibiting')
      + (err ? `  ERROR: ${err}` : ''));

    if (EXECUTE && !err) {
      await query(
        `INSERT INTO cphi_exhibitor_matches
           (event_slug, role, holder, holder_normalized, exhibiting, exhibitor_name, booth, hall,
            match_tier, molecules_covered, review_status, searched_terms, entity_note, role_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13)
         ON CONFLICT (event_slug, role, holder_normalized) DO UPDATE SET
           holder = EXCLUDED.holder,
           exhibiting = EXCLUDED.exhibiting,
           exhibitor_name = EXCLUDED.exhibitor_name,
           booth = EXCLUDED.booth,
           hall = EXCLUDED.hall,
           match_tier = EXCLUDED.match_tier,
           searched_terms = EXCLUDED.searched_terms,
           entity_note = EXCLUDED.entity_note,
           role_note = EXCLUDED.role_note,
           -- A human verdict outranks the matcher, exactly as in the supplier lookup.
           review_status = CASE
             WHEN cphi_exhibitor_matches.review_status IN ('confirmed','rejected')
               THEN cphi_exhibitor_matches.review_status
             ELSE EXCLUDED.review_status END,
           checked_at = NOW()`,
        [EVENT_SLUG, ROLE, h.holder, h.holder_normalized, !!best,
         best ? best.name : null, best ? best.booth : null, best ? hallOf(best.booth) : null,
         best ? best.tier : 'not_found',
         best ? reviewStatusFor(best.tier) : 'unreviewed',
         terms.join(' | '), entityNote(h.holder, best), h.detail]);
      written += 1;
    }
  }

  const onFloor = tally.exact + tally.core + tally.prefix + tally.token;
  console.log(`\n── result ──────────────────────────────────────────────────────────`);
  console.log(`  on the floor ${onFloor}   (exact ${tally.exact}, core ${tally.core}, `
    + `prefix ${tally.prefix}, token ${tally.token})`);
  console.log(`  not exhibiting ${tally.none}   errors ${tally.errors}`);
  console.log(`  The token tier is roughly half wrong and is held back for review, same as suppliers.`);
  if (EXECUTE) {
    console.log(`\n  wrote ${written} row(s) as role="${ROLE}".`);
  } else {
    console.log(`\n  DRY RUN — nothing written. Add --execute to write.`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('role lookup failed:', e && e.message ? e.message : e); process.exit(1); });
