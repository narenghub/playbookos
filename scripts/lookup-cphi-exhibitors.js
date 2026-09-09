// ── CPHI sourcing: check DMF holders against the Milan exhibitor list ──
//
// Demand-first. Takes the DMF holders that supply the top-N molecules by clinical demand,
// ordered by how many of those molecules each one covers, and checks each against CPHI's
// PUBLIC exhibitor search. Writes cphi_exhibitor_matches.
//
// WHY ONE-AT-A-TIME AND NOT AN ENUMERATION: the Milan floor has 2,989 exhibitors, but only
// ~300 of them make anything our trial pipeline needs. Looking up the ones we care about is a
// few hundred requests; enumerating the directory is thousands and needs a persisted-query
// hash the widget does not expose.
//
// PUBLIC SURFACE ONLY. Each lookup is a plain GET of the exhibitor-list widget with a ?search=
// term; the results are server-rendered into __NEXT_DATA__. No login, no attendee data, no
// private endpoint. Requests are serialised with a delay - be polite, this is someone's site.
//
// ORDERED BY VALUE so a partial run is still useful: if the widget changes shape or starts
// rate-limiting halfway, you have TAPI, Dr Reddy's, Hetero and MSN rather than an
// alphabetical half.
//
// IDEMPOTENT: unique on (event_slug, holder_normalized), so a re-run refreshes booths in
// place. A human's review_status survives - see the ON CONFLICT clause.
//
// Run:
//   node scripts/lookup-cphi-exhibitors.js              # DRY RUN, first 10
//   node scripts/lookup-cphi-exhibitors.js --execute    # full run, writes
//   node scripts/lookup-cphi-exhibitors.js --execute --limit 50 --top 150

const { query } = require('../src/lib/db');
const { DEMAND_SQL } = require('../src/lib/dmf/demand');
const { searchTerms, bestMatch, reviewStatusFor } = require('../src/lib/cphi/match-company');

const EVENT_SLUG = 'cphi-milan-2026';
const WIDGET = 'https://visitor.cphieventplanner.com/widget/event/cphi-milan-2026/exhibitors/RXZlbnRWaWV3XzEyNzIwOTk=';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const TOP_N = flag('--top', 100);
const LIMIT = flag('--limit', EXECUTE ? Infinity : 10);
const DELAY_MS = flag('--delay', 600);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One public search. Returns [{name, booth}]. Never throws. */
async function searchExhibitors(term) {
  try {
    const res = await fetch(`${WIDGET}?search=${encodeURIComponent(term)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, hits: [] };
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { error: 'no __NEXT_DATA__ (widget layout changed)', hits: [] };
    const state = (JSON.parse(m[1]).props || {}).apolloState || {};
    const hits = Object.keys(state)
      .filter((k) => state[k].__typename === 'Core_Exhibitor')
      .map((k) => {
        const e = state[k];
        const wk = Object.keys(e).find((x) => x.startsWith('withEvent'));
        return { name: e.name, booth: wk && e[wk] ? e[wk].booth : null };
      });
    return { hits };
  } catch (err) {
    return { error: String(err.message || err), hits: [] };
  }
}

/** CPHI booths are <hall><row><number>, e.g. "10K47" is hall 10. */
function hallOf(booth) {
  const m = /^(\d+)/.exec(String(booth || ''));
  return m ? m[1] : null;
}

async function demandRankedHolders(topN) {
  const rows = await query(
    `WITH demand AS (
       SELECT LOWER(sm.molecule_name) AS k,
              COUNT(DISTINCT sm.study_id) AS studies,
              SUM(COALESCE(cs.enrollment_count,0)) AS patients,
              COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase='Phase 3') AS ph3,
              COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase='Phase 2') AS ph2
         FROM study_molecules sm JOIN clinical_studies cs ON cs.id = sm.study_id GROUP BY 1),
     sourceable AS (
       SELECT d.* FROM demand d WHERE EXISTS (
         SELECT 1 FROM molecule_dmf_matches m
          WHERE LOWER(m.molecule_name)=d.k AND m.review_status='auto_confirmed')),
     top AS (SELECT k FROM sourceable ORDER BY ${DEMAND_SQL} DESC, studies DESC LIMIT $1)
     SELECT MIN(d.holder) AS holder, d.holder_normalized, COUNT(DISTINCT t.k)::int AS molecules
       FROM top t
       JOIN molecule_dmf_matches m ON LOWER(m.molecule_name)=t.k AND m.review_status='auto_confirmed'
       JOIN dmf_holders d ON d.dmf_number = m.dmf_number
      GROUP BY d.holder_normalized
      ORDER BY molecules DESC, holder`,
    [topN],
  );
  return rows.rows;
}

async function main() {
  const holders = await demandRankedHolders(TOP_N);
  const scope = holders.slice(0, LIMIT === Infinity ? holders.length : LIMIT);
  console.log(`demand-ranked holders for the top ${TOP_N} molecules: ${holders.length}`);
  console.log(`checking: ${scope.length}${EXECUTE ? '' : '  (DRY RUN)'}   delay ${DELAY_MS}ms\n`);

  const tally = { exact: 0, core: 0, prefix: 0, token: 0, none: 0, errors: 0 };
  let written = 0;

  for (const [i, h] of scope.entries()) {
    const terms = searchTerms(h.holder);
    let best = null;
    let err = null;
    for (const term of terms) {
      const { hits, error } = await searchExhibitors(term);
      if (error) { err = error; break; }
      const m = bestMatch(h.holder, hits);
      if (m && (!best || m.tier === 'exact')) best = m;
      if (best && best.tier === 'exact') break;
      await sleep(DELAY_MS);
    }
    if (err) tally.errors++;
    tally[best ? best.tier : 'none']++;

    const line = best
      ? `${String(best.tier).padEnd(7)}${String(best.booth || '-').padEnd(8)}${best.name}`
      : 'not exhibiting';
    console.log(`${String(i + 1).padStart(4)}. ${String(h.molecules).padStart(2)} mol  ${h.holder.slice(0, 42).padEnd(42)} ${line}${err ? '  ERROR: ' + err : ''}`);

    if (EXECUTE) {
      await query(
        `INSERT INTO cphi_exhibitor_matches
           (event_slug, holder, holder_normalized, exhibiting, exhibitor_name, booth, hall,
            match_tier, molecules_covered, review_status, searched_terms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (event_slug, holder_normalized) DO UPDATE SET
           holder = EXCLUDED.holder,
           exhibiting = EXCLUDED.exhibiting,
           exhibitor_name = EXCLUDED.exhibitor_name,
           booth = EXCLUDED.booth,
           hall = EXCLUDED.hall,
           match_tier = EXCLUDED.match_tier,
           molecules_covered = EXCLUDED.molecules_covered,
           searched_terms = EXCLUDED.searched_terms,
           -- A human verdict outranks the matcher: once someone has confirmed or rejected a
           -- row, a quarterly re-run must not silently reset it.
           review_status = CASE
             WHEN cphi_exhibitor_matches.review_status IN ('confirmed','rejected')
               THEN cphi_exhibitor_matches.review_status
             ELSE EXCLUDED.review_status END,
           checked_at = NOW()`,
        [
          EVENT_SLUG, h.holder, h.holder_normalized, !!best,
          best ? best.name : null, best ? best.booth : null, best ? hallOf(best.booth) : null,
          best ? best.tier : null, h.molecules,
          best ? reviewStatusFor(best.tier) : 'unreviewed',
          terms.join(' | '),
        ],
      );
      written++;
    }
    await sleep(DELAY_MS);
  }

  const confident = tally.exact + tally.core + tally.prefix;
  console.log(`\n── ${scope.length} checked ──`);
  console.log(`  exact ${tally.exact}  core ${tally.core}  prefix ${tally.prefix}  -> ${confident} confident`);
  console.log(`  token ${tally.token} (needs review)   not exhibiting ${tally.none}   errors ${tally.errors}`);
  if (EXECUTE) console.log(`\n✅ wrote ${written} rows into cphi_exhibitor_matches (${EVENT_SLUG})`);
  else console.log('\nDRY RUN — nothing written. Re-run with --execute.');
}

main().then(() => process.exit(0), (e) => { console.error('lookup error:', e.message); process.exit(1); });
