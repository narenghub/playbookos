// ── POPULATE THE LABCONNECT DIRECTORY FROM THE FDA REGISTER ───────────────────
//
//   railway ssh 'node scripts/seed-labs-from-fda.js'            # report only, writes nothing
//   railway ssh 'node scripts/seed-labs-from-fda.js --write'    # insert/update labs
//
// DRY RUN BY DEFAULT. The first thing anybody wants from this script is the COUNT — how many QC
// testing labs are already sitting in `fda_establishments` — and that question should not require
// writing 1,000 rows to answer. Without --write it reads, classifies, prints the full census and
// touches nothing.
//
// ── WHAT IT IMPORTS, AND WHAT IT LEAVES OUT ───────────────────────────────────
//
// In:  establishments whose `operations` names analytical testing.
// Out, each for a reason that would otherwise put a bad row in front of the agent:
//
//   • US-AGENT ROWS are imported normally and DO get a region. The flag describes the registrant's
//     mailbox (REGISTRANT_CONTACT_EMAIL belongs to a compliance intermediary), not the address —
//     the establishment's own address is in ADDRESS and the agent has its own AGENT_DETAILS column.
//     An earlier version suppressed the region for these on the opposite belief; it is carried on
//     the CONTACT instead, where it belongs, since an approach reads differently when it is going
//     to an intermediary rather than the plant.
//   • EXCLUDED FIRMS, where the flag AFFIRMATIVELY says so. The first version of this treated any
//     non-empty `exclusion_flag` as an exclusion and discarded all 3,437 laboratories in the
//     register — Catalent and Glenmark among them — while reporting it as diligence. The column is
//     populated on nearly every row. See src/lib/fda/exclusion.js for the rule and why it errs the
//     way it does.
//   • ESTABLISHMENTS WITH NO OPERATIONS AT ALL. Invisible to the filter. Counted and reported,
//     because a census that silently drops rows overstates its own completeness — some of those
//     are labs and they need a different discovery route.
//
// ── EVERY ROW LANDS AS 'discovered' ───────────────────────────────────────────
//
// Nobody has contacted these firms. They have not agreed to anything and do not know they are in
// the database. 'discovered' says exactly that, and only an 'active' lab may be routed an order —
// asserted in the route that assigns work, not just here. The one thing this product must never do
// is send a client's sample to a firm that never signed up.
//
// Re-runnable: inserts are ON CONFLICT DO UPDATE on the identity index, and the update deliberately
// does NOT touch status, notes, accreditations or the capability flags — those are human decisions
// and a re-import must not revert them to the register's defaults.

const { initDB, query } = require('../src/lib/db');
const { regionFor, regionLabel } = require('../src/lib/labconnect/region');
const { isExcluded } = require('../src/lib/fda/exclusion');

const WRITE = process.argv.includes('--write');

const num = (n) => Number(n || 0).toLocaleString('en-US');
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const head = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 72 - t.length))}`);

// The same fold the establishment table uses for its own join key, so a lab discovered here and a
// lab that self-onboards later collide on the identity index instead of becoming two rows.
const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|sa|ag|bv|nv|srl|spa|pvt|private|plc|lp|llp)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// City out of a US address tail: "..., Rockford, IL 61108" → Rockford.
const cityFromAddress = (address) => {
  const m = /,\s*([^,]+),\s*[A-Z]{2}\s+\d{5}/.exec(String(address || ''));
  return m ? m[1].trim() : null;
};

async function main() {
  await initDB();

  // ── the vocabulary check, which the whole script rests on ────────────────────
  // ANALYSIS being the token for analytical testing is an inference from the column's example
  // values, not a documented fact. If it is wrong, every count below is a confident zero. So the
  // tokens are printed and the script REFUSES to write when the token is absent.
  head('operations tokens in the register');
  const tokens = (await query(
    `SELECT token, COUNT(*)::int n FROM (
       SELECT btrim(unnest(string_to_array(upper(operations), ';'))) AS token
         FROM fda_establishments WHERE operations IS NOT NULL
     ) t WHERE token <> '' GROUP BY token ORDER BY n DESC`)).rows;
  if (!tokens.length) {
    console.error('No operations values at all. Is fda_establishments populated?');
    process.exit(1);
  }
  for (const r of tokens) console.log(`  ${pad(r.token, 44)} ${num(r.n).padStart(8)}`);

  const hasAnalysis = tokens.some(r => r.token === 'ANALYSIS');
  if (!hasAnalysis) {
    console.error('\nThere is no ANALYSIS token. The filter in this script is wrong, so it will not');
    console.error('import anything. Pick the token above that means analytical testing and change it.');
    process.exit(1);
  }
  const noOps = (await query(
    `SELECT COUNT(*)::int n FROM fda_establishments
      WHERE operations IS NULL OR btrim(operations) = ''`)).rows[0].n;
  console.log(`\n  ${pad('(no operations recorded — invisible to this import)', 44)} ${num(noOps).padStart(8)}`);

  // ── the exclusion_flag vocabulary ────────────────────────────────────────────
  // PRINTED, NOT ASSUMED. The previous version of this script inferred the meaning of this column
  // and silently dropped the whole dataset. Any column a filter depends on gets its values shown
  // before the filter is applied, the same way the operations tokens are.
  head('exclusion_flag values, as they actually appear');
  const flags = (await query(
    `SELECT COALESCE(NULLIF(btrim(exclusion_flag), ''), '(empty)') AS flag, COUNT(*)::int n
       FROM fda_establishments GROUP BY 1 ORDER BY n DESC LIMIT 12`)).rows;
  for (const f of flags) {
    console.log(`  ${pad(f.flag, 44)} ${num(f.n).padStart(8)}  ${isExcluded(f.flag === '(empty)' ? null : f.flag) ? '← treated as EXCLUDED' : ''}`);
  }
  console.log('\n  Only a value that affirmatively says so is treated as an exclusion. If a real');
  console.log('  exclusion marker is in that list and is NOT flagged, add it to EXCLUDED_VALUES.');

  // ── the candidates ───────────────────────────────────────────────────────────
  const rows = (await query(
    `SELECT id, firm_name, address, country, operations, is_api_manufacturer, is_us_agent,
            fei_number, duns_number, exclusion_flag,
            establishment_contact_name, establishment_contact_email, registrant_contact_email
       FROM fda_establishments
      WHERE operations ILIKE '%ANALYSIS%'
      ORDER BY country, firm_name`)).rows;

  head(`${num(rows.length)} establishments perform ANALYSIS`);

  const stats = {
    excluded: 0, us_agent: 0, api_mfr: 0, analysis_only: 0,
    no_region: 0, with_email: 0, importable: 0, country_inferred: 0,
  };
  const byRegion = new Map();
  const excludedFirms = [];
  const candidates = [];

  for (const r of rows) {
    if (isExcluded(r.exclusion_flag)) {
      stats.excluded += 1;
      if (excludedFirms.length < 10) excludedFirms.push(`${r.firm_name} (${r.country || '??'})`);
      continue;                                   // never importable
    }
    if (r.is_us_agent) stats.us_agent += 1;
    if (r.is_api_manufacturer) stats.api_mfr += 1;
    if (/^\s*ANALYSIS\s*$/i.test(r.operations || '')) stats.analysis_only += 1;

    // `country` comes BACK from regionFor, not straight off the register row. A US establishment
    // has country NULL in `fda_establishments` — the parser only fills it from a trailing "(XXX)",
    // which the FDA file writes on foreign addresses only — and regionFor infers 'USA' from a US
    // address tail. Storing the register's NULL instead would leave every US lab unfilterable by
    // country in the directory, and unroutable for any order that restricts to one.
    const { region, state, country: resolvedCountry, country_inferred } = regionFor(r);
    if (!region) stats.no_region += 1;
    if (country_inferred) stats.country_inferred += 1;
    const key = region || '(undetermined)';
    byRegion.set(key, (byRegion.get(key) || 0) + 1);

    const email = r.establishment_contact_email || r.registrant_contact_email || null;
    if (email) stats.with_email += 1;

    stats.importable += 1;
    candidates.push({
      fda_establishment_id: r.id,
      name: r.firm_name,
      name_normalized: normalize(r.firm_name),
      fei_number: r.fei_number, duns_number: r.duns_number,
      address: r.address, city: cityFromAddress(r.address), state,
      country: resolvedCountry, country_inferred: !!country_inferred, region,
      contact_name: r.establishment_contact_name || null,
      contact_email: email,
      // A manufacturer with an ANALYSIS registration is testing its OWN product. Flagged in the
      // note so the agent's first email does not treat it as a contract lab touting for work.
      note: r.is_api_manufacturer
        ? 'FDA register: also an API manufacturer — may be testing its own product, not a contract lab.'
        : null,
    });
  }

  head('what the count is actually made of');
  console.log(`  importable                      ${num(stats.importable).padStart(8)}`);
  console.log(`  ANALYSIS and nothing else       ${num(stats.analysis_only).padStart(8)}   ← the contract labs`);
  console.log(`  also an API manufacturer        ${num(stats.api_mfr).padStart(8)}   ← probably testing its own product`);
  console.log(`  contact is a US agent           ${num(stats.us_agent).padStart(8)}   ← an intermediary, not the plant`);
  console.log(`  no region could be determined   ${num(stats.no_region).padStart(8)}`);
  console.log(`  country inferred from a US tail ${num(stats.country_inferred).padStart(8)}   ← the domestic labs`);
  console.log(`  a contactable email             ${num(stats.with_email).padStart(8)}   ← what the agent can actually work`);
  console.log(`  EXCLUDED, not imported          ${num(stats.excluded).padStart(8)}   ← FDA exclusion flag`);
  if (excludedFirms.length) {
    console.log('\n  excluded firms (first few):');
    for (const f of excludedFirms) console.log(`    ${f}`);
  }

  head('region-wise');
  const regions = [...byRegion.entries()].sort((a, b) => b[1] - a[1]);
  for (const [region, n] of regions) {
    const label = region === '(undetermined)' ? 'region not determined' : regionLabel(region);
    console.log(`  ${pad(region, 14)} ${pad(label, 26)} ${num(n).padStart(7)}`);
  }
  console.log('\n  Europe here is only labs that serve the US market — the FDA register is the source.');
  console.log('  EU-only labs are in EudraGMDP and are counted nowhere above.');

  if (!WRITE) {
    head('dry run');
    console.log(`  Nothing was written. ${num(stats.importable)} rows are ready to import.`);
    console.log('  Re-run with --write to insert them, all as status=discovered.');
    return;
  }

  // ── the write ────────────────────────────────────────────────────────────────
  // The UPDATE clause is deliberately narrow: register facts refresh, human decisions do not.
  // status, status_note, notes, accreditations, research_capable and gmp_capable are all absent
  // from it, so a re-import cannot revert a lab somebody onboarded back to 'discovered'.
  head('writing');
  let inserted = 0, updated = 0;
  for (const c of candidates) {
    const r = await query(
      `INSERT INTO labs (name, name_normalized, source, fda_establishment_id, fei_number,
                         duns_number, address, city, state, country, region,
                         contact_name, contact_email, notes, status)
            VALUES ($1,$2,'fda_register',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'discovered')
       ON CONFLICT (name_normalized, COALESCE(address, '')) DO UPDATE
          SET fda_establishment_id = EXCLUDED.fda_establishment_id,
              fei_number   = EXCLUDED.fei_number,
              duns_number  = EXCLUDED.duns_number,
              city         = EXCLUDED.city,
              state        = EXCLUDED.state,
              country      = EXCLUDED.country,
              region       = EXCLUDED.region,
              contact_name  = COALESCE(labs.contact_name, EXCLUDED.contact_name),
              contact_email = COALESCE(labs.contact_email, EXCLUDED.contact_email),
              updated_at   = NOW()
        RETURNING (xmax = 0) AS was_insert`,
      [c.name, c.name_normalized, c.fda_establishment_id, c.fei_number, c.duns_number,
       c.address, c.city, c.state, c.country, c.region, c.contact_name, c.contact_email, c.note]);
    if (r.rows[0] && r.rows[0].was_insert) inserted += 1; else updated += 1;
  }

  const total = (await query(`SELECT COUNT(*)::int n FROM labs`)).rows[0].n;
  console.log(`  inserted ${num(inserted)}, updated ${num(updated)}`);
  console.log(`  labs now holds ${num(total)} rows, all discovered — none has agreed to anything yet.`);
  console.log('\n  Next: review them in LabConnect and move the ones worth approaching to "invited".');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('seed failed:', e && e.message ? e.message : e);
  process.exit(1);
});
