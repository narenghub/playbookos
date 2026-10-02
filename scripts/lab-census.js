// ── LABCONNECT: WHAT IS ALREADY IN THE REGISTER ───────────────────────────────
//
//   railway ssh 'node scripts/lab-census.js'
//
// READ-ONLY. No INSERT, no UPDATE, no DELETE anywhere in this file. It answers one question —
// how many establishments already in `fda_establishments` perform analytical testing, and where
// are they — so the decision to build a LabConnect directory is made against a number instead
// of an assumption.
//
// WHY IT PRINTS THE OPERATIONS VOCABULARY FIRST. The whole census rests on the belief that FDA
// writes analytical testing as the token "ANALYSIS" in `operations`. That belief is mine, not a
// documented fact, and if it is wrong every count below is zero or wrong in a way that looks
// plausible. So section 1 prints the actual distinct tokens with their frequencies, before any
// filter is applied. Read it first: if ANALYSIS is not there, the token we want is, and the
// filter in this script needs changing rather than the conclusion.
//
// Exit codes: 0 = the census ran. 1 = it could not (and says why). A census cannot "fail" on its
// numbers — a zero is a finding, not an error — so a zero ANALYSIS count exits 0 and says so
// loudly in words.

const { initDB, query } = require('../src/lib/db');
const { excludedSql } = require('../src/lib/fda/exclusion');

// EU/EEA + UK + CH/NO/IS/LI, as ISO-3. Copied deliberately rather than imported from routes.js:
// that list (AROS_US_EU) exists for a different purpose — the AROS ideal-customer slice — and a
// shared constant would mean a change made for AROS silently redefining Europe for LabConnect.
const EUROPE = ['GBR', 'CHE', 'NOR', 'ISL', 'LIE',
  'AUT', 'BEL', 'BGR', 'HRV', 'CYP', 'CZE', 'DNK', 'EST', 'FIN', 'FRA', 'DEU', 'GRC',
  'HUN', 'IRL', 'ITA', 'LVA', 'LTU', 'LUX', 'MLT', 'NLD', 'POL', 'PRT', 'ROU', 'SVK',
  'SVN', 'ESP', 'SWE'];

// US state out of the address tail: "..., Rockford, IL 61108" → IL. Two-letter code followed by
// a 5-digit ZIP is specific enough not to match a street abbreviation.
const STATE_SQL = `substring(address from ',\\s*([A-Z]{2})\\s+\\d{5}')`;

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const num = (n) => Number(n || 0).toLocaleString('en-US');
const head = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 74 - t.length))}`);

async function main() {
  await initDB();

  const total = (await query(`SELECT COUNT(*)::int n FROM fda_establishments`)).rows[0].n;
  if (!total) {
    console.error('fda_establishments is EMPTY — run the establishments migration/ingest first.');
    process.exit(1);
  }
  console.log(`fda_establishments: ${num(total)} site rows`);

  // ── 1. the vocabulary, before any filtering ──────────────────────────────────
  // operations is a free-text, semicolon-joined list. Split it and count the parts, so the token
  // we filter on is one we have SEEN rather than one we expect.
  head('1. operations tokens, as they actually appear');
  const tokens = (await query(
    `SELECT token, COUNT(*)::int n FROM (
       SELECT btrim(unnest(string_to_array(upper(operations), ';'))) AS token
         FROM fda_establishments WHERE operations IS NOT NULL
     ) t WHERE token <> '' GROUP BY token ORDER BY n DESC`)).rows;
  for (const r of tokens) console.log(`  ${pad(r.token, 42)} ${num(r.n).padStart(8)}`);
  const hasAnalysis = tokens.some(r => r.token === 'ANALYSIS');
  if (!hasAnalysis) {
    console.log('\n  ⚠ There is no "ANALYSIS" token. Every count below will be wrong.');
    console.log('    Pick the token above that means analytical testing and change ANALYSIS_SQL.');
  }
  const noOps = (await query(
    `SELECT COUNT(*)::int n FROM fda_establishments WHERE operations IS NULL OR btrim(operations) = ''`)).rows[0].n;
  console.log(`\n  ${pad('(no operations recorded)', 42)} ${num(noOps).padStart(8)}`);
  console.log('  Rows with no operations are INVISIBLE to this census — they may well be labs.');

  // The filter, in one place. ILIKE on the delimited string rather than on the array, because a
  // token can sit anywhere in the list.
  const ANALYSIS_SQL = `operations ILIKE '%ANALYSIS%'`;

  // ── 2. the headline: how many labs, and where ────────────────────────────────
  head('2. establishments performing ANALYSIS');
  const split = (await query(
    `SELECT COUNT(*)::int all_labs,
            COUNT(*) FILTER (WHERE country = 'USA')::int usa,
            COUNT(*) FILTER (WHERE country = ANY($1))::int europe,
            COUNT(*) FILTER (WHERE country IS NOT NULL
                             AND country <> 'USA' AND NOT (country = ANY($1)))::int rest,
            COUNT(*) FILTER (WHERE country IS NULL)::int unknown_country
       FROM fda_establishments WHERE ${ANALYSIS_SQL}`, [EUROPE])).rows[0];
  console.log(`  total                 ${num(split.all_labs).padStart(8)}`);
  console.log(`  United States         ${num(split.usa).padStart(8)}`);
  console.log(`  Europe (EEA+UK+CH)    ${num(split.europe).padStart(8)}`);
  console.log(`  rest of world         ${num(split.rest).padStart(8)}`);
  console.log(`  country not parsed    ${num(split.unknown_country).padStart(8)}`);

  if (!split.all_labs) {
    console.log('\n  No rows match ANALYSIS. See section 1 — the token is probably spelled differently.');
    await done(); return;
  }

  // ── 3. pure testing lab vs manufacturer-with-a-lab ───────────────────────────
  // A different sales conversation each: a contract lab wants order flow; a manufacturer that
  // happens to hold an ANALYSIS registration is testing its OWN product and is not a supplier.
  // This distinction decides how much of the count is actually addressable.
  head('3. is testing the business, or a sideline?');
  const kind = (await query(
    `SELECT
       COUNT(*) FILTER (WHERE upper(operations) ~ '^\\s*ANALYSIS\\s*$')::int analysis_only,
       COUNT(*) FILTER (WHERE ${ANALYSIS_SQL} AND is_api_manufacturer)::int also_api_mfr,
       COUNT(*) FILTER (WHERE ${ANALYSIS_SQL}
         AND array_length(string_to_array(btrim(operations), ';'), 1) > 1)::int multi_operation
       FROM fda_establishments WHERE ${ANALYSIS_SQL}`)).rows[0];
  console.log(`  ANALYSIS and nothing else   ${num(kind.analysis_only).padStart(8)}  ← the contract labs`);
  console.log(`  ANALYSIS + other operations ${num(kind.multi_operation).padStart(8)}`);
  console.log(`  of which API manufacturers  ${num(kind.also_api_mfr).padStart(8)}  ← testing their own product`);

  // ── 4. how many can actually be contacted ────────────────────────────────────
  // The directory is worth what its contact data is worth. is_us_agent matters: a US agent's
  // address is a law firm in Washington, not the lab, so those rows are contactable but their
  // GEOGRAPHY is fiction — which is fatal for region-wise routing.
  head('4. contactability, and whose address it is');
  const contact = (await query(
    `SELECT COUNT(*) FILTER (WHERE establishment_contact_email IS NOT NULL)::int est_email,
            COUNT(*) FILTER (WHERE registrant_contact_email IS NOT NULL)::int reg_email,
            COUNT(*) FILTER (WHERE is_us_agent)::int via_us_agent,
            COUNT(*) FILTER (WHERE ${excludedSql()})::int excluded
       FROM fda_establishments WHERE ${ANALYSIS_SQL}`)).rows[0];
  console.log(`  a named person at the firm   ${num(contact.est_email).padStart(8)}`);
  console.log(`  registrant email only        ${num(contact.reg_email).padStart(8)}`);
  console.log(`  address is a US AGENT        ${num(contact.via_us_agent).padStart(8)}  ← geography unusable`);
  console.log(`  affirmatively EXCLUDED       ${num(contact.excluded).padStart(8)}  ← do not onboard`);
  console.log('  (a populated flag is NOT an exclusion — the column is set on nearly every row)');

  // ── 5. region-wise, which is the thing being asked for ───────────────────────
  head('5. US labs by state');
  const states = (await query(
    `SELECT ${STATE_SQL} AS st, COUNT(*)::int n
       FROM fda_establishments
      WHERE ${ANALYSIS_SQL} AND country = 'USA' AND NOT is_us_agent
      GROUP BY 1 ORDER BY n DESC NULLS LAST`)).rows;
  const parsed = states.filter(r => r.st);
  for (const r of parsed) console.log(`  ${pad(r.st, 6)} ${num(r.n).padStart(6)}`);
  const unparsed = states.find(r => !r.st);
  console.log(`  ${pad('(none)', 6)} ${num(unparsed ? unparsed.n : 0).padStart(6)}  ← address did not yield a state`);
  console.log(`\n  ${parsed.length} states represented.`);

  head('6. Europe by country');
  const euCountries = (await query(
    `SELECT country, COUNT(*)::int n FROM fda_establishments
      WHERE ${ANALYSIS_SQL} AND country = ANY($1)
      GROUP BY 1 ORDER BY n DESC`, [EUROPE])).rows;
  for (const r of euCountries) console.log(`  ${pad(r.country, 6)} ${num(r.n).padStart(6)}`);
  console.log(`\n  ${euCountries.length} of ${EUROPE.length} European countries represented.`);
  console.log('  NOTE: this is the FDA register, so a European lab appears here only if it serves');
  console.log('  the US market. The EU-only labs are in EudraGMDP and are NOT counted anywhere above.');

  head('7. how fresh the register is');
  const src = (await query(
    `SELECT source_last_modified, MAX(ingested_at) ingested_at, COUNT(*)::int sites
       FROM fda_establishments GROUP BY source_last_modified
      ORDER BY MAX(ingested_at) DESC LIMIT 3`)).rows;
  for (const r of src) {
    console.log(`  published ${pad(r.source_last_modified, 34)} ingested ${pad(r.ingested_at, 26)} ${num(r.sites)} sites`);
  }

  await done();
}

async function done() {
  console.log('\nREAD-ONLY — nothing was written.');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('census failed:', e && e.message ? e.message : e);
  process.exit(1);
});
