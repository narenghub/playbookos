#!/usr/bin/env node
// ── FUNDED, ACTIVE, REACHABLE ────────────────────────────────────────────────
//
//   railway ssh 'node scripts/ingest-research-labs.js'                       # DRY RUN
//   railway ssh 'node scripts/ingest-research-labs.js --execute'
//   railway ssh 'node scripts/ingest-research-labs.js --topic="C-H activation" --execute'
//   railway ssh 'node scripts/ingest-research-labs.js --dept=CHEMISTRY --min-award=250000'
//
// Writes nothing without --execute. Sends no email, ever: this fills the table that outreach later
// reads, and those are deliberately separate steps.
//
// ── WHY IT SEARCHES METHODS AND NOT MOLECULES ────────────────────────────────
//
// The probe tried three topics against RePORTER and the contrast decided this design.
// "medicinal chemistry synthesis" returned Donald Watson (Delaware, CHEMISTRY, R35, $479k to
// 2031), Wendlandt at MIT, Michaudel at Texas A&M — synthetic methodology labs, which is the ICP
// exactly. But "GLP-1 receptor agonist" returned a cocaine-use-disorder dopamine project and a PhD
// student on a $35,556 fellowship, and "kinase inhibitor synthesis" returned "Branched chain amino
// acids in pancreatic carcinogenesis". advanced_text_search matches any mention anywhere in an
// abstract, so searching our own molecule names drags in clinical and biology groups who will
// never order a compound, and buries the people who would.
//
// The response carries two better filters, and the probe printed both: organization.dept_type
// (CHEMISTRY | PHARMACOLOGY | BIOLOGY) says what kind of building this is, and award_amount
// separates a funded programme from a stipend. Those are structural facts about the lab rather
// than word matches in prose, so they are what this filters on.
//
// ── WHY THE EMAIL COMES FROM A SECOND SOURCE ─────────────────────────────────
//
// RePORTER names the PI and the money but never an inbox — confirmed, not assumed: the probe
// walked every award record and found zero addresses. Europe PMC has addresses, in affiliation
// prose, on 22-30% of papers. So the join is (PI name + institution) across the two, and the
// reachable rate above is the ceiling on this pipeline. A lab we cannot reach is still worth
// storing: it is a real customer we have to find another way to, and knowing that is the point.
//
// ── PRINTING CONTINUOUSLY IS NOT COSMETIC ────────────────────────────────────
//
// `railway ssh` closes the connection on SILENCE, not on duration. A loop that fetches twenty-five
// awards and then enriches each one over the network will sit quiet for minutes and be hung up on
// mid-run, which looks exactly like a crash. Every iteration therefore prints a line.
'use strict';

const { initDB, query } = require('../src/lib/db');
const {
  extractEmails, institutionFrom, departmentFrom,
  normalizeInstitution, normalizePerson, attributeToPi, orgKeyword,
} = require('../src/lib/research/affiliation');

const NIH = 'https://api.reporter.nih.gov/v2/projects/search';
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const EXECUTE = has('execute');
const TOPIC = arg('topic', 'medicinal chemistry synthesis');
const DEPTS = arg('dept', 'CHEMISTRY,PHARMACOLOGY,PHARMACY')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const MIN_AWARD = Math.max(0, parseInt(arg('min-award', '150000'), 10) || 0);
const LIMIT = Math.max(1, Math.min(500, parseInt(arg('limit', '50'), 10) || 50));

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, opts, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) { lastErr = e; await sleep(800 * (i + 1)); }
  }
  throw lastErr;
}

// ── 1. THE AWARDS: who holds money, for what, until when ─────────────────────
async function fetchAwards() {
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let offset = 0; offset < LIMIT; offset += 25) {
    const body = {
      criteria: {
        advanced_text_search: {
          operator: 'and', search_field: 'projecttitle,abstracttext', search_text: TOPIC,
        },
        // A grant that ended is a lab with no budget. This is the single most useful filter and it
        // costs nothing.
        project_end_date: { from_date: today, to_date: '2040-12-31' },
      },
      include_fields: ['ProjectNum', 'ProjectTitle', 'AbstractText', 'PrincipalInvestigators',
        'Organization', 'AwardAmount', 'ProjectStartDate', 'ProjectEndDate'],
      offset, limit: 25, sort_field: 'award_amount', sort_order: 'desc',
    };
    const data = await getJson(NIH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const got = data.results || [];
    say(`   awards ${offset + 1}-${offset + got.length} of ${(data.meta && data.meta.total) || '?'}`);
    out.push(...got);
    if (got.length < 25) break;
    await sleep(400);
  }
  return out;
}

// ── 2. THE ADDRESS: their own papers, matched to their own name ───────────────
// Returns { email, source_url, published_for } or null. Declines rather than guesses.
async function findEmailForPi(pi, orgName) {
  const first = pi.first_name || '';
  const last = pi.last_name || '';
  if (!last) return null;

  // ── THE QUERY, AS MEASURED RATHER THAN ASSUMED ────
  // probe-pi-email.js ran five formulations against the five PIs this originally failed on.
  // AUTH:"Last, First" AND AFF:"<org verbatim>" — what this used to send — returned ZERO hits for
  // all five: Europe PMC indexes authors as "Miller SJ", and no paper contains the string
  // "LOUISIANA STATE UNIV A&M COL BATON ROUGE". The surviving formulation is surname + initials
  // against the one distinctive institution word, which also kept the hit counts narrow enough
  // (174, 182, 29) to avoid dragging in namesakes. Dropping AFF is not an option: "Wang Z" alone
  // returns 193,582 papers.
  const initials = `${first ? first[0] : ''}${pi.middle_name ? pi.middle_name[0] : ''}`;
  const kw = orgKeyword(orgName);
  if (!kw) return { empty: 'no usable affiliation keyword for this institution' };
  const q = `AUTH:"${last} ${initials}" AND AFF:"${kw}"`;
  const url = `${EPMC}?query=${encodeURIComponent(q)}`
    + '&format=json&resultType=core&pageSize=25&sort=P_PDATE_D desc';

  // A failure here must NOT read as "this lab has no address". That collapse is what made the
  // first run report 0% across ten prolific chemists and look like a finding instead of a bug.
  let data;
  try { data = await getJson(url); } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
  const hits = (data.resultList && data.resultList.result) || [];
  if (!hits.length) return { empty: 'no papers matched the author+affiliation query' };

  for (const h of hits) {
    const authors = ((h.authorList && h.authorList.author) || []).map((a) => ({
      firstName: a.firstName, lastName: a.lastName, initials: a.initials,
    }));
    // Author-level affiliation details first: an address there belongs to that author, which is
    // the only attribution the data actually supports.
    for (const a of (h.authorList && h.authorList.author) || []) {
      const affs = ((a.authorAffiliationDetailsList
        && a.authorAffiliationDetailsList.authorAffiliation) || [])
        .map((x) => x.affiliation).filter(Boolean);
      for (const aff of affs) {
        for (const email of extractEmails(aff)) {
          // attributeToPi, not attributeEmail: the latter only asks whose address this is among
          // the paper's authors, and answered "Sophie Miller, South Australia" when we were
          // looking for Scott Miller at Yale.
          const who = attributeToPi(email, [{
            firstName: a.firstName, lastName: a.lastName, initials: a.initials,
          }], { first, last, middle: pi.middle_name });
          if (who) {
            return {
              email,
              source_url: `https://europepmc.org/article/${h.source}/${h.id}`,
              published_for: 'scientific correspondence (author affiliation, Europe PMC)',
              affiliation: aff,
            };
          }
        }
      }
    }
    // Paper-level affiliation: attribution must be earned against the full author list.
    for (const email of extractEmails(h.affiliation || '')) {
      const who = attributeToPi(email, authors, { first, last, middle: pi.middle_name });
      if (who) {
        return {
          email,
          source_url: `https://europepmc.org/article/${h.source}/${h.id}`,
          published_for: 'scientific correspondence (corresponding author, Europe PMC)',
          affiliation: h.affiliation,
        };
      }
    }
  }
  return { empty: `${hits.length} paper(s) matched, none carried an attributable address` };
}

// ── 3. WHAT THEY WORK ON, against what we can supply ─────────────────────────
async function loadMoleculeDictionary() {
  const dict = new Set();
  const add = (n) => {
    const s = String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (s.length >= 5) dict.add(s);
  };
  for (const [sql, col] of [
    ['SELECT DISTINCT molecule_name FROM study_molecules LIMIT 5000', 'molecule_name'],
    ['SELECT DISTINCT molecule_name FROM supplier_products LIMIT 5000', 'molecule_name'],
    ['SELECT DISTINCT name FROM skus LIMIT 2000', 'name'],
  ]) {
    try { for (const r of (await query(sql)).rows) add(r[col]); } catch (_) { /* table may be absent */ }
  }
  return dict;
}

function interestsFrom(award, dict) {
  const text = `${award.project_title || ''} ${String(award.abstract_text || '').slice(0, 4000)}`;
  const norm = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const found = new Map();
  for (const name of dict) {
    if (norm.includes(` ${name} `)) found.set(name, { kind: 'molecule', value: name });
  }
  const dept = (award.organization && award.organization.dept_type) || null;
  if (dept) found.set(`dept:${dept}`, { kind: 'modality', value: dept });
  return [...found.values()];
}

async function main() {
  await initDB();
  say(`\n── research lab ingest${EXECUTE ? '' : '   ** DRY RUN — nothing is written **'}`);
  say(`   topic      "${TOPIC}"`);
  say(`   depts      ${DEPTS.join(', ') || '(any)'}`);
  say(`   min award  $${MIN_AWARD.toLocaleString()}`);
  say(`   limit      ${LIMIT} awards\n`);

  const dict = await loadMoleculeDictionary();
  say(`   ${dict.size} molecule name(s) in the matching dictionary\n`);

  const suppressed = new Set(
    (await query('SELECT lower(email) e FROM contact_suppression')).rows.map((r) => r.e));
  if (suppressed.size) say(`   ${suppressed.size} suppressed address(es) will be skipped\n`);

  say('   FETCHING AWARDS');
  const awards = await fetchAwards();
  say(`   ${awards.length} award(s) with an end date in the future\n`);

  // Structural filters, applied after the fetch so the report can show what each one removed —
  // a filter whose effect you cannot see is a filter you cannot tune.
  let dropDept = 0; let dropAward = 0;
  const keep = awards.filter((a) => {
    const dept = String((a.organization && a.organization.dept_type) || '').toUpperCase();
    if (DEPTS.length && !DEPTS.some((d) => dept.includes(d))) { dropDept += 1; return false; }
    if (Number(a.award_amount || 0) < MIN_AWARD) { dropAward += 1; return false; }
    return true;
  });
  say(`   dropped ${dropDept} on department, ${dropAward} on award size → ${keep.length} lab(s)\n`);

  say('   ENRICHING  (one line per lab; the connection closes on silence, not on time)');
  say(`      ${pad('PI', 26)}${pad('institution', 34)}${pad('dept', 13)}${pad('ends', 11)}email`);

  const rows = [];
  let lookupErrors = 0;
  let skipped = 0;

  // One PI, one lookup. Miller held three of the ten awards and Hergenrother three more, so the
  // first run spent ten network round-trips to enrich five labs and printed each of them three
  // times. The database deduplicated on write, which hid the waste in the output.
  const byPi = new Map();
  for (const a of keep) {
    const pis = a.principal_investigators || [];
    const pi = pis.find((p) => p.is_contact_pi) || pis[0];
    const org = a.organization || {};
    if (!pi) { say(`      (award ${a.project_num} names no PI — skipped)`); continue; }
    const key = `${normalizePerson(pi.full_name)}|${normalizeInstitution(org.org_name || '')}`;
    const prev = byPi.get(key);
    // Keep the award that runs longest: that is the budget still to be spent.
    if (!prev || String(a.project_end_date || '') > String(prev.project_end_date || '')) {
      byPi.set(key, a);
    }
  }
  const deduped = [...byPi.values()];
  if (deduped.length !== keep.length) {
    say(`      ${keep.length} award(s) → ${deduped.length} distinct lab(s) (same PI, several grants)`);
  }

  // ── PERSIST EACH LAB AS IT IS ENRICHED ────
  // This used to run after the whole loop. The loop makes one network call per lab with a polite
  // pause between them, so a 62-lab run holds the connection for minutes — and `railway ssh` drops
  // it on silence. A run died at lab 42 of 62 and wrote NOTHING, because every insert was waiting
  // behind the last iteration. Forty-two labs of work discarded by one broken pipe.
  //
  // So each lab is written the moment it is known. ON CONFLICT already made this idempotent, which
  // means an interrupted run is simply a shorter run: start it again and it picks up, skipping the
  // labs it has already enriched instead of paying for their lookups a second time.
  let labsNew = 0; let peopleNew = 0; let intNew = 0;

  async function persistLab(r) {
    const instName = r.institution || 'unknown';
    const labRes = await query(`
      INSERT INTO research_labs
        (institution_name, normalized_name, country, city, pi_name, pi_name_normalized,
         department, focus, funding_source, funding_id, funding_end, funding_amount,
         last_active, evidence_count, source, source_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'nih_reporter',$9,$10,$11,$12,1,'nih_reporter',$13)
      ON CONFLICT (pi_name_normalized, normalized_name) DO UPDATE SET
        funding_id     = EXCLUDED.funding_id,
        funding_end    = GREATEST(research_labs.funding_end, EXCLUDED.funding_end),
        funding_amount = EXCLUDED.funding_amount,
        focus          = COALESCE(EXCLUDED.focus, research_labs.focus),
        department     = COALESCE(EXCLUDED.department, research_labs.department),
        evidence_count = research_labs.evidence_count + 1,
        refreshed_at   = NOW()
      RETURNING id, (xmax = 0) AS inserted`,
    [instName, normalizeInstitution(instName), r.org.org_country || null, r.org.org_city || null,
      r.pi.full_name, normalizePerson(r.pi.full_name), r.department,
      r.award.project_title || null, r.award.project_num || null,
      String(r.award.project_end_date || '').slice(0, 10) || null,
      r.award.award_amount || null,
      String(r.award.project_start_date || '').slice(0, 10) || null,
      `https://reporter.nih.gov/project-details/${r.award.project_num || ''}`]);

    const labId = labRes.rows[0].id;
    if (labRes.rows[0].inserted) labsNew += 1;

    if (r.found) {
      const p = await query(`
        INSERT INTO research_people
          (lab_id, full_name, title, email, role_category, email_basis,
           source, source_url, published_for)
        VALUES ($1,$2,$3,$4,'pi','published','europepmc',$5,$6)
        ON CONFLICT (lab_id, email) DO NOTHING
        RETURNING id`,
      [labId, r.pi.full_name, r.pi.title || null, r.found.email,
        r.found.source_url, r.found.published_for]);
      if (p.rows.length) peopleNew += 1;
    }

    for (const i of r.interests) {
      const n = String(i.value).toLowerCase().trim();
      const ins = await query(`
        INSERT INTO research_interests (lab_id, kind, value, normalized, evidence_url,
                                        first_seen, last_seen, mentions)
        VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,CURRENT_DATE,1)
        ON CONFLICT (lab_id, kind, normalized) DO UPDATE SET
          last_seen = CURRENT_DATE, mentions = research_interests.mentions + 1
        RETURNING (xmax = 0) AS inserted`,
      [labId, i.kind, i.value, n,
        `https://reporter.nih.gov/project-details/${r.award.project_num || ''}`]);
      if (ins.rows[0] && ins.rows[0].inserted) intNew += 1;
    }
    return true;
  }

  for (const a of deduped) {
    const org = a.organization || {};
    const pis = (a.principal_investigators || []);
    // is_contact_pi marks the person who corresponds for the award. On a multi-PI grant that is
    // the one to write to; the others are co-investigators.
    const pi = pis.find((p) => p.is_contact_pi) || pis[0];
    if (!pi) { say(`      (award ${a.project_num} names no PI — skipped)`); continue; }

    // RESUME. A lab already holding a contact needs no second lookup — that is what makes an
    // interrupted run cheap to restart rather than a full repeat.
    if (!has('refresh')) {
      const seen = await query(
        `SELECT 1 FROM research_labs l JOIN research_people p ON p.lab_id = l.id
          WHERE l.pi_name_normalized = $1 AND l.normalized_name = $2 AND p.email IS NOT NULL
          LIMIT 1`,
        [normalizePerson(pi.full_name), normalizeInstitution(org.org_name || '')]);
      if (seen.rows.length) {
        skipped += 1;
        say(`      ${pad(pi.full_name, 26)}${pad(String(org.org_name || '').slice(0, 32), 34)}`
          + `${pad('', 13)}${pad('', 11)}(already have a contact — skipped)`);
        continue;
      }
    }

    const look = await findEmailForPi(pi, org.org_name || '');
    const found = look && look.email ? look : null;
    if (look && look.error) lookupErrors += 1;
    const email = found && !suppressed.has(found.email) ? found.email : null;
    const aff = found && found.affiliation;

    rows.push({
      award: a, org, pi, pis, found: email ? found : null,
      institution: (aff && institutionFrom(aff)) || org.org_name || null,
      department: (aff && departmentFrom(aff)) || org.dept_type || null,
      interests: interestsFrom(a, dict),
    });

    const row = rows[rows.length - 1];
    if (EXECUTE) await persistLab(row);   // written now, not at the end

    say(`      ${pad(pi.full_name, 26)}${pad(String(org.org_name || '').slice(0, 32), 34)}`
      + `${pad(String(org.dept_type || '').slice(0, 11), 13)}`
      + `${pad(String(a.project_end_date || '').slice(0, 10), 11)}`
      + (email || (found ? 'suppressed'
        : (look && look.error ? `LOOKUP FAILED: ${look.error}` : '—')))
      + (EXECUTE ? '  ✓saved' : ''));
    await sleep(350);   // be a good citizen of a free public API
  }

  if (lookupErrors) {
    say(`\n   ⚠ ${lookupErrors} lookup(s) FAILED rather than came back empty. Those labs are not`);
    say(`     unreachable — they are unmeasured. Fix the cause before trusting the rate below.`);
  }
  const reachable = rows.filter((r) => r.found).length;
  say(`\n   ${rows.length} lab(s), ${reachable} with a published address `
    + `(${rows.length ? Math.round((reachable / rows.length) * 100) : 0}%)`);
  const withInterest = rows.filter((r) => r.interests.some((i) => i.kind === 'molecule')).length;
  say(`   ${withInterest} lab(s) name a molecule we already know\n`);

  if (skipped) say(`   ${skipped} lab(s) skipped — already had a contact (--refresh to redo them)`);

  if (!EXECUTE) {
    say('\n   DRY RUN — nothing written. Re-run with --execute to persist.\n');
    process.exit(0);
  }

  const tot = (await query(`
    SELECT (SELECT COUNT(*)::int FROM research_labs) labs,
           (SELECT COUNT(*)::int FROM research_people WHERE email IS NOT NULL) mailable,
           (SELECT COUNT(*)::int FROM research_interests) interests`)).rows[0];

  say(`\n   WROTE  +${labsNew} lab(s), +${peopleNew} contact(s), +${intNew} interest(s)`);
  say(`\n   TOTALS   ${tot.labs} labs · ${tot.mailable} mailable contacts · ${tot.interests} interests\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('ingest-research-labs failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
