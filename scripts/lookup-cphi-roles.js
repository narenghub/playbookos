// ── CPHI: WHICH OF OUR LABS AND BUYERS ARE ON THE FLOOR ───────────────────────
//
//   node scripts/lookup-cphi-roles.js --role qc_lab                          # DRY RUN, first 10
//   node scripts/lookup-cphi-roles.js --role qc_lab --execute
//   node scripts/lookup-cphi-roles.js --role platform_partner --market eu --execute
//   node scripts/lookup-cphi-roles.js --role buyer --market eu --execute --limit 200
//
// The supplier lookup asks "is this DMF holder on the floor". This asks the same question of the
// other three sides of the business, using the same public directory and the same name matcher.
//
//   --role platform_partner   Manufacturers and CDMOs that could hold client relationships locally
//                   the way ACBM Partners does in the US — the EU repeat of that model. Ordered by breadth of
//                   registered operations, because a site licensed to do six things serves more
//                   clients than one licensed to do one. This is the WEAKEST of the four lists and the
//                   reason is worth carrying onto the floor: there is no register of agencies, so this
//                   is manufacturers used as a proxy for "company with a local client base". Expect to
//                   disqualify most of them in the first minute of conversation.
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
//   --market us|eu|all   Applies to platform_partner and buyer, which run on both sides of the
//                   Atlantic. See src/lib/cphi/markets.js — in particular that this is the US
//                   register, so "EU" means EU firms with US-facing business, not all EU firms.
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
const { outsourcerSql, MAKER_TOKENS } = require('../src/lib/labconnect/buyers');
const { marketSql, marketOf, marketLabel, isMarket } = require('../src/lib/cphi/markets');
const { looksLikeLabSql, labLookupOrderSql } = require('../src/lib/labconnect/lab-shape');

const EVENT_SLUG = 'cphi-milan-2026';
const VALID_ROLES = ['platform_partner', 'qc_lab', 'buyer'];

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const str = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const num = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const ROLE = str('--role', null);
const LIMIT = num('--limit', EXECUTE ? 400 : 10);
const DELAY_MS = num('--delay', 600);
const REGION = str('--region', null);   // e.g. eu, us — prefix match on labs.region
const MARKET = str('--market', 'all');  // us | eu | all — platform_partner and buyer only

const fmt = (n) => Number(n).toLocaleString('en-US');
const pad = (s, n) => String(s == null ? '' : s).padEnd(n).slice(0, n);

/**
 * LabConnect recruits. Sourced from `labs` when the directory has been populated, because that
 * table carries region, status and the contact a person may have corrected.
 *
 * ORDERED EU-FIRST, THEN BY WHETHER THE NAME READS AS A TESTING BUSINESS. The first live run checked
 * ten rows alphabetically from "2seventy bio" and found nothing, because every term in the old
 * ORDER BY was constant and `name` decided. See src/lib/labconnect/lab-shape.js.
 */
async function qcLabs(limit) {
  const rows = await query(
    `SELECT name AS holder, name_normalized, region, country, state, contact_email,
            (notes IS NOT NULL) AS also_manufactures,
            ${looksLikeLabSql('name')} AS name_reads_as_lab
       FROM labs
      WHERE status <> 'rejected'
        ${REGION ? "AND region LIKE $2 || '%'" : ''}
      ORDER BY ${labLookupOrderSql()}
      LIMIT $1`,
    REGION ? [limit, REGION] : [limit]);
  return rows.rows.map(r => ({
    holder: r.holder,
    holder_normalized: normalizeCompany(r.holder),
    // `labs.region` is already resolved (us_central, eu_ita, row_ind), so the market comes off the
    // region prefix rather than from the country code — the lab directory's own answer, not a second
    // opinion about the same row.
    market: r.region ? String(r.region).split('_')[0] : marketOf(r.country),
    // SAYS WHAT THE REGISTER SAYS, no more. The old label called every row without an
    // API-manufacturer flag a "contract lab", which put "contract lab" next to 3M Company on screen.
    // `notes` carries that flag and nothing else, so that is all this reports.
    detail: [r.name_reads_as_lab ? 'name reads as a lab' : null,
             r.also_manufactures ? 'also manufactures' : null,
             r.region || 'no region'].filter(Boolean).join(' · '),
  }));
}

/**
 * Candidate PLATFORM partners: the EU repeat of the ACBM Partners model.
 *
 * There is no register of agencies, so this uses the thing a register does know — a site licensed to
 * do several operations serves more clients than a site licensed to do one — as a proxy for "company
 * with a local client base worth putting a platform behind". Unlike the buyer query this deliberately
 * does NOT exclude sites with their own laboratory: a firm that both makes and tests is a better
 * partner, not a worse one, because it can carry LabConnect and SiteNex to the same clients.
 *
 * Weak list, honestly ordered. Most will be disqualified in conversation; the ordering is there so
 * the ones at the top are worth the walk.
 */
async function platformPartners(limit) {
  const m = marketSql(MARKET, 1);
  const makers = MAKER_TOKENS.map((t, i) => `operations ILIKE $${m.nextIndex + i}`).join(' OR ');
  const makerParams = MAKER_TOKENS.map(t => '%' + t + '%');
  const limitIdx = m.nextIndex + MAKER_TOKENS.length;
  const rows = await query(
    `SELECT firm_name AS holder, country, operations
       FROM fda_establishments
      WHERE ${m.sql}
        AND operations IS NOT NULL AND btrim(operations) <> ''
        AND (${makers})
        AND NOT ${excludedSql()}
      ORDER BY length(operations) DESC, firm_name
      LIMIT $${limitIdx}`, [...m.params, ...makerParams, limit]);
  return rows.rows.map(r => ({
    holder: r.holder,
    holder_normalized: normalizeCompany(r.holder),
    market: marketOf(r.country),
    detail: [r.country || 'USA', String(r.operations || '').split(';').length + ' operations']
      .join(' · '),
  }));
}

/**
 * Who needs outsourced testing: registered to make something, NOT registered for ANALYSIS.
 * The same fragment the LabConnect buyers route uses, so the two cannot disagree about who a
 * buyer is.
 */
async function buyers(limit) {
  // Both fragments own their own placeholders, so they are chained by index rather than by counting:
  // outsourcerSql starts at 1 and marketSql picks up where it stopped, and the LIMIT takes whatever
  // index is free after both. Getting this wrong is silent — the query runs and filters on the wrong
  // value — which is exactly how the role parameter once landed in the tier filter.
  const o = outsourcerSql(1);
  const m = marketSql(MARKET, o.nextIndex);
  const rows = await query(
    `SELECT firm_name AS holder, firm_normalized, country, operations
       FROM fda_establishments
      WHERE ${o.sql}
        AND ${m.sql}
        AND NOT ${excludedSql()}
      ORDER BY length(operations) DESC, firm_name
      LIMIT $${m.nextIndex}`, [...o.params, ...m.params, limit]);
  return rows.rows.map(r => ({
    holder: r.holder,
    holder_normalized: normalizeCompany(r.holder),
    market: marketOf(r.country),
    detail: [r.country || 'USA', String(r.operations || '').split(';').length + ' operations']
      .join(' · '),
  }));
}

async function main() {
  if (!VALID_ROLES.includes(ROLE)) {
    console.error(`--role must be one of: ${VALID_ROLES.join(', ')}`);
    console.error('(suppliers are handled by scripts/lookup-cphi-exhibitors.js)');
    process.exit(1);
  }
  // Rejected rather than quietly widened to 'all'. A typo in --market on a 400-row --execute run
  // would otherwise spend an hour checking the wrong continent and report success.
  if (!isMarket(MARKET)) {
    console.error(`--market must be one of: us, eu, all   (got "${MARKET}")`);
    process.exit(1);
  }
  if (ROLE === 'qc_lab' && MARKET !== 'all') {
    console.error('--market does not apply to qc_lab — labs are scoped with --region (eu, us), '
      + 'because the lab directory resolves its own regions.');
    process.exit(1);
  }

  const scope = ROLE === 'qc_lab' ? await qcLabs(LIMIT)
    : ROLE === 'platform_partner' ? await platformPartners(LIMIT)
    : await buyers(LIMIT);

  if (!scope.length) {
    console.log(`\nNothing to check for role "${ROLE}"${MARKET === 'all' ? '' : ` in ${marketLabel(MARKET)}`}.`);
    if (ROLE === 'qc_lab') {
      console.log('The `labs` table is empty — run scripts/seed-labs-from-fda.js --write first.');
    } else {
      console.log('`fda_establishments` has no row matching that market — if this is the EU list, '
        + 'check that scripts/ingest-establishments.js has been run on the FULL register and not '
        + 'the domestic extract.');
    }
    process.exit(0);
  }

  console.log(`\n── ${ROLE}${ROLE === 'qc_lab' ? '' : ` · ${marketLabel(MARKET)}`}`
    + ` against the ${EVENT_SLUG} directory ──────────────`);
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
            match_tier, molecules_covered, review_status, searched_terms, entity_note, role_note,
            market)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12,$13,$14)
         ON CONFLICT (event_slug, role, holder_normalized) DO UPDATE SET
           holder = EXCLUDED.holder,
           market = EXCLUDED.market,
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
         terms.join(' | '), entityNote(h.holder, best), h.detail, h.market || null]);
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
    console.log(`\n  wrote ${written} row(s) as role="${ROLE}"`
      + `${ROLE === 'qc_lab' ? '' : ` market="${MARKET}"`}.`);
  } else {
    console.log(`\n  DRY RUN — nothing written. Add --execute to write.`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('role lookup failed:', e && e.message ? e.message : e); process.exit(1); });
