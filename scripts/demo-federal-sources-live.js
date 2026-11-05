#!/usr/bin/env node
'use strict';
// ── END-TO-END DEMONSTRATION AGAINST REAL PUBLIC SOURCES ────────────────────
//
// Ruling 6 items 3–4. Pulls live records from USAspending, Grants.gov and NIH RePORTER, separates
// them by record kind, qualifies them, and produces an owner-first shortlist with source links,
// deadlines, evidence-backed relevance signals, eligibility verdicts and exact blocker reasons.
//
//   "Clearly separate contracts, grants, research leads, forecasts, and historical awards. Do not
//    claim live SAM.gov coverage until the connector is authorized and operational."
//   "Unknown values must remain UNKNOWN."
//
// ── THE HEADLINE, STATED UP FRONT RATHER THAN DISCOVERED ────────────────────
//
// CONTRACTS HAVE NO LIVE COVERAGE. A federal contract opportunity is a SAM.gov solicitation, and
// `solicitation` is the ONLY one of the seven record kinds from which a priced bid may be produced.
// SAM.gov is not authorized or operational here. So this demonstration covers grants, forecasts,
// research leads and historical awards — and the biddable category, the one that produces
// procurement revenue, is EMPTY.
//
// That is the most important sentence in the output and it is printed as a row in the table rather
// than left as an absence, because a table with no "contracts" line reads as though contracts were
// not part of the question.
//
// ── WHY THIS WRITES NOTHING ─────────────────────────────────────────────────
//
// Network reads and stdout only. No database connection at all, so there is no fixture, no cleanup
// and nothing to get wrong against production. The connectors that persist these records exist and
// are tested, but their migration is unapplied and persisting is not authorized.
//
// Usage: node scripts/demo-federal-sources-live.js
// Exit:  0 demonstration produced · 1 a source was unreachable or a stage failed

const https = require('https');
const { RECORD_KINDS, kindFromGrantsGov, biddability } = require('../src/lib/procurement/record-kind');
const { assess } = require('../src/lib/procurement/qualify');

const UNKNOWN = 'UNKNOWN';
const asOf = new Date().toISOString().slice(0, 10);

function bar(ch = '─') { return ch.repeat(78); }
function h(t) { console.log(`\n${bar()}\n${t}\n${bar()}`); }
function u(v) {
  if (v === null || v === undefined || v === '' ) return UNKNOWN;
  return v;
}

function postJson(url, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // A generic client name. The brief is explicit that a site asking automated clients for
        // contact details is not a reason to send a person's address.
        'User-Agent': 'playbookos-prpa-readonly/1.0',
      },
    };
    const req = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms: ${url}`)); });
    req.end(payload);
  });
}

// ── relevance signals ──────────────────────────────────────────────────────
//
// EVIDENCE-BACKED, NOT A SCORE. The ruling asked for relevance signals rather than an arbitrary
// number, and the reason is that a score of 72 cannot be argued with: nobody can tell whether it
// means "the agency buys this molecule every year" or "the word 'pharmaceutical' appeared once".
// Each signal below names what matched and where, so a person can disagree with it specifically.
function relevanceSignals(record, terms) {
  const signals = [];
  const hay = `${record.title || ''} ${record.description || ''}`.toLowerCase();
  for (const term of terms) {
    if (hay.includes(term.toLowerCase())) {
      signals.push({
        signal: 'keyword_in_title_or_description',
        evidence: `"${term}" appears in the record text`,
        strength: 'weak — a word match is not a requirement match',
      });
    }
  }
  // A program classification is a much stronger signal than a word, because it is the government's
  // own statement of what the money is for rather than a string that happened to appear.
  if (record.cfdaList && record.cfdaList.length) {
    signals.push({
      signal: 'cfda_program_classification',
      evidence: `CFDA ${record.cfdaList.join(', ')}`,
      strength: "moderate — the government's own classification of the programme, which a word match is not",
    });
  }
  if (record.agency) {
    signals.push({
      signal: 'issuing_agency_recorded',
      evidence: `agency: ${record.agency}`,
      strength: 'context only — says nothing about whether they buy from us',
    });
  }
  if (!signals.length) {
    signals.push({
      signal: 'none',
      evidence: 'no signal could be computed from the fields this source returned',
      strength: UNKNOWN,
    });
  }
  return signals;
}

async function main() {
  const TERMS = ['pharmaceutical', 'active pharmaceutical ingredient', 'reference standard',
    'analytical testing', 'contract research'];

  h('FEDERAL SOURCE DEMONSTRATION — LIVE PUBLIC DATA (read-only, nothing persisted)');
  console.log(`  generated : ${new Date().toISOString()}`);
  console.log(`  as of     : ${asOf}`);
  console.log('  sources   : USAspending, Grants.gov, NIH RePORTER — all public, no key required');
  console.log('');
  console.log('  CONTRACTS ARE NOT COVERED. A federal contract opportunity is a SAM.gov');
  console.log('  solicitation, and `solicitation` is the ONLY record kind from which a priced bid');
  console.log('  may be produced. SAM.gov is not authorized or operational, so the biddable');
  console.log('  category below is EMPTY and no procurement revenue is demonstrable from it.');

  const buckets = {
    solicitation: [], sources_sought: [], rfi: [],
    grant_opportunity: [], forecast: [], research_lead: [], historical_award: [],
  };
  const sourceStatus = [];

  // ── 1. GRANTS.GOV — grant opportunities and forecasts ────────────────────
  try {
    const res = await postJson('https://api.grants.gov/v1/api/search2',
      { keyword: 'pharmaceutical', rows: 25 });
    const hits = (res && res.data && res.data.oppHits) || [];
    sourceStatus.push({ source: 'Grants.gov search2', ok: true, records: hits.length });
    for (const o of hits) {
      // kindFromGrantsGov separates a live posting from a forecast. A forecast is a stated
      // intention to fund; it has no application and nothing to win.
      const kind = kindFromGrantsGov({
        oppStatus: o.oppStatus, docType: o.docType, closeDate: o.closeDate,
      }) || 'grant_opportunity';
      const rec = {
        recordKind: kind,
        title: u(o.title),
        // MEASURED: the field is `agency`, not `agencyName`. Reading a field that does not exist
        // fell through to agencyCode and printed "DOD-AMRAA" where a name was meant.
        agency: u(o.agency || o.agencyCode),
        identifier: u(o.number),
        responseDeadline: o.closeDate ? isoFromUs(o.closeDate) : null,
        sourceUrl: o.id ? `https://www.grants.gov/search-results-detail/${o.id}` : null,
        // search2 returns NO description field — only these ten keys. So text relevance for a
        // Grants.gov record can only ever be computed from the title, which is a structural limit
        // of the source and not something a better query fixes. cfdaList is the program
        // classification and is a far stronger signal than any word match.
        cfdaList: Array.isArray(o.cfdaList) ? o.cfdaList : null,
        raw: { oppStatus: o.oppStatus, docType: o.docType, closeDate: o.closeDate },
      };
      (buckets[kind] || buckets.grant_opportunity).push(rec);
    }
  } catch (e) {
    sourceStatus.push({ source: 'Grants.gov search2', ok: false, error: e.message });
  }

  // ── 2. USASPENDING — historical awards (evidence, never opportunities) ───
  try {
    const res = await postJson('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      filters: {
        award_type_codes: ['A', 'B', 'C', 'D'],
        time_period: [{ start_date: '2024-01-01', end_date: asOf }],
        keywords: ['pharmaceutical'],
      },
      fields: ['Award ID', 'Recipient Name', 'Awarding Agency', 'Award Amount',
        'Start Date', 'End Date', 'generated_internal_id'],
      limit: 25,
      page: 1,
    });
    const rows = (res && res.results) || [];
    sourceStatus.push({ source: 'USAspending spending_by_award', ok: true, records: rows.length });
    for (const r of rows) {
      buckets.historical_award.push({
        recordKind: 'historical_award',
        title: u(r['Recipient Name']),
        agency: u(r['Awarding Agency']),
        identifier: u(r['Award ID']),
        // An award has no response deadline. It is finished. Leaving this null rather than
        // inventing one is what keeps it out of the deadline gate.
        responseDeadline: null,
        obligated: u(r['Award Amount']),
        sourceUrl: r.generated_internal_id
          ? `https://www.usaspending.gov/award/${r.generated_internal_id}` : null,
      });
    }
  } catch (e) {
    sourceStatus.push({ source: 'USAspending spending_by_award', ok: false, error: e.message });
  }

  // ── 3. NIH REPORTER — research leads (AI-derived demand, not buyers) ─────
  try {
    // The first version passed only fiscal_years, which returned 25 ARBITRARY projects — none
    // related to anything we sell. That is not a research lead set, it is a sample of NIH. The
    // relevance has to be in the QUERY; computing a signal afterwards cannot rescue an unfiltered
    // pull, and reporting those records as leads would have been the invention this ruling forbids.
    const res = await postJson('https://api.reporter.nih.gov/v2/projects/search', {
      criteria: {
        fiscal_years: [2025],
        advanced_text_search: {
          operator: 'and',
          search_field: 'projecttitle,abstracttext',
          search_text: 'pharmaceutical',
        },
      },
      include_fields: ['ProjectNum', 'ProjectTitle', 'Organization', 'AgencyIcAdmin'],
      limit: 25,
      offset: 0,
    });
    const rows = (res && res.results) || [];
    sourceStatus.push({ source: 'NIH RePORTER projects/search', ok: true, records: rows.length });
    for (const p of rows) {
      buckets.research_lead.push({
        recordKind: 'research_lead',
        title: u(p.project_title),
        agency: u(p.agency_ic_admin && p.agency_ic_admin.name),
        identifier: u(p.project_num),
        responseDeadline: null,
        organization: u(p.organization && p.organization.org_name),
        sourceUrl: p.project_num
          ? `https://reporter.nih.gov/search/results?projectNumber=${encodeURIComponent(p.project_num)}`
          : null,
      });
    }
  } catch (e) {
    sourceStatus.push({ source: 'NIH RePORTER projects/search', ok: false, error: e.message });
  }

  // ── source status ────────────────────────────────────────────────────────
  h('SOURCE STATUS');
  for (const s of sourceStatus) {
    console.log(`  ${s.ok ? 'OK  ' : 'FAIL'}  ${s.source.padEnd(38)} ${s.ok ? `${s.records} record(s)` : s.error}`);
  }
  console.log(`  N/A   ${'SAM.gov (contract solicitations)'.padEnd(38)} NOT AUTHORIZED — no live coverage`);
  const anyOk = sourceStatus.some((s) => s.ok);
  if (!anyOk) {
    console.error('\nEvery source was unreachable — no demonstration is possible.');
    return 1;
  }

  // ── the separation the ruling asked for ──────────────────────────────────
  h('RECORD KINDS, SEPARATED');
  console.log(`  ${'kind'.padEnd(20)} ${'count'.padStart(5)}  ${'biddable'.padEnd(9)} what a response to it is`);
  console.log(`  ${bar('─').slice(0, 74)}`);
  for (const [kind, meta] of Object.entries(RECORD_KINDS)) {
    const n = buckets[kind] ? buckets[kind].length : 0;
    const note = kind === 'solicitation' && n === 0 ? 'NO LIVE COVERAGE (SAM.gov not authorized)'
      : meta.responseArtifact;
    console.log(`  ${kind.padEnd(20)} ${String(n).padStart(5)}  ${(meta.biddable ? 'YES' : 'no').padEnd(9)} ${note}`);
  }
  console.log('');
  console.log('  Revenue channel per kind — so no number lands in the wrong column:');
  for (const [kind, meta] of Object.entries(RECORD_KINDS)) {
    console.log(`    ${kind.padEnd(20)} ${meta.revenueChannel}`);
  }
  console.log('');
  console.log('  HISTORICAL AWARDS ARE NOT PIPELINE. Their obligated amounts are money already');
  console.log('  spent, on contracts already awarded, to recipients who are mostly not us. They are');
  console.log('  evidence about what an agency buys and from whom — never an opportunity and never');
  console.log('  a forecast of our revenue.');

  // ── 4. OWNER-FIRST SHORTLIST ─────────────────────────────────────────────
  h('OWNER-FIRST SHORTLIST');
  console.log('  Ordered by what an owner must decide, not by score. Every verdict carries the');
  console.log('  exact blocker reasons; every unknown stays UNKNOWN.');
  console.log('');
  console.log('  WHY EVERY VERDICT HERE IS NOT_QUALIFIED, AND WHY THAT IS THE RIGHT ANSWER.');
  console.log('  None of these record kinds can be bid — a grant takes an application, a forecast');
  console.log('  takes nothing, a research lead takes gated outreach, an award is already made. That');
  console.log('  is a CATEGORY ERROR, not a data gap, so the verdict is final and the record can be');
  console.log('  archived. It is not a judgement that we are unqualified; it is that there is');
  console.log('  nothing here to bid on.');
  console.log('');
  console.log('  The data-gap path is therefore NOT exercised by this run, and saying so matters:');
  console.log('  registry and registration are both absent (verified_capabilities is unapplied, no');
  console.log('  SAM registration was supplied), and for a BIDDABLE record those UNKNOWNs would');
  console.log('  produce NEEDS_REVIEW rather than a soft pass or a false rejection. There are no');
  console.log('  biddable records, so that behaviour is proven by the unit tests, not by this output.');

  const shortlist = [];
  for (const kind of Object.keys(buckets)) {
    for (const rec of buckets[kind]) {
      const verdict = assess({
        record: rec,
        asOf,
        // registry and registration deliberately omitted — see the note above.
      });
      shortlist.push({ rec, verdict });
    }
  }

  // Order: anything biddable first (there is none), then by whether a person must act.
  const rank = (s) => {
    if (s.verdict.verdict === 'QUALIFIED') return 0;
    if (s.verdict.verdict === 'NEEDS_REVIEW') return 1;
    if (s.verdict.verdict === 'NOT_QUALIFIED') return 2;
    return 3;
  };
  shortlist.sort((a, b) => rank(a) - rank(b));

  const counts = {};
  for (const s of shortlist) counts[s.verdict.verdict] = (counts[s.verdict.verdict] || 0) + 1;
  console.log('');
  console.log(`  verdicts: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);
  console.log(`  rule set: ${require('../src/lib/procurement/qualify').RULE_SET_VERSION}`);
  console.log(`  evaluated as of: ${asOf}`);

  // ── RELEVANCE HONESTY ────────────────────────────────────────────────────
  //
  // MEASURED, and it is the most useful thing in this section: a keyword search is a RETRIEVAL
  // mechanism, not a relevance verdict. Searching Grants.gov for "pharmaceutical" returns records
  // like "Solid Waste Management Grant Program" whose text contains none of our terms — the engine
  // matched something in a field it does not return. A scoring system would have given that record
  // a number and buried the problem. Counting the records with NO substantive signal surfaces it.
  let byText = 0; let byProgram = 0; let contextOnly = 0;
  for (const s of shortlist) {
    const sigs = relevanceSignals(s.rec, TERMS);
    const text = sigs.some((x) => x.signal === 'keyword_in_title_or_description');
    const prog = sigs.some((x) => x.signal === 'cfda_program_classification');
    if (text) byText += 1;
    if (prog) byProgram += 1;
    if (!text && !prog) contextOnly += 1;
  }
  console.log('');
  console.log(`  relevance evidence: ${byText} matched one of our terms in the returned text`);
  console.log(`                      ${byProgram} carry a CFDA programme classification`);
  console.log(`                      ${contextOnly} have NO signal beyond the issuing agency`);
  console.log('');
  console.log('  A keyword search is RETRIEVAL, not relevance. Grants.gov search2 returns ten');
  console.log('  fields and no description, so a record can arrive on a match in a field we never');
  console.log('  see — which is how "Solid Waste Management Grant Program" reaches a search for');
  console.log('  "pharmaceutical". A term search therefore cannot stand in for a relevance filter,');
  console.log('  and no score is invented to paper over the gap: a record with nothing but an');
  console.log('  agency name says so on its own line.');

  const SHOW = 12;
  console.log(`\n  showing the first ${SHOW} of ${shortlist.length}:`);
  for (const s of shortlist.slice(0, SHOW)) {
    const r = s.rec;
    const b = biddability(r);
    console.log(`\n  ${bar('·').slice(0, 74)}`);
    console.log(`  ${r.title === UNKNOWN ? UNKNOWN : String(r.title).slice(0, 86)}`);
    console.log(`    kind       : ${r.recordKind}  (biddable: ${b.biddable ? 'YES' : 'no'} — ${b.reason})`);
    console.log(`    identifier : ${u(r.identifier)}`);
    console.log(`    agency     : ${u(r.agency)}`);
    console.log(`    deadline   : ${r.responseDeadline || UNKNOWN}`);
    console.log(`    source     : ${r.sourceUrl || UNKNOWN}`);
    if (r.obligated !== undefined) {
      console.log(`    obligated  : ${u(r.obligated)}  (money ALREADY SPENT — not pipeline)`);
    }
    console.log(`    verdict    : ${s.verdict.verdict}`);
    const findings = s.verdict.findings || [];
    const fails = findings.filter((f) => f.result === 'fail');
    const unknowns = findings.filter((f) => f.result === 'unknown');

    // OWNER-FIRST MEANS THE DECISIVE REASON FIRST. A grant that can never be bid also has twelve
    // unchecked gates, and printing all twelve buries the one line that settles it. Where a
    // category error decides the verdict, the remaining gates are moot — they are counted, named
    // as moot, and not listed. Suppressing them when they are NOT moot would be hiding work.
    const decidedByKind = fails.some((f) => f.criterion_key === 'record_kind_biddable');
    if (fails.length) {
      console.log('    blockers   :');
      for (const f of fails) {
        console.log(`      [FAIL   ] ${f.criterion_key}: ${f.reason}`);
      }
    }
    if (decidedByKind) {
      console.log(`      [MOOT   ] ${unknowns.length} further gate(s) not evaluated: the record kind `
        + 'settles this one, so checking registration or capability would not change the verdict');
    } else if (unknowns.length) {
      for (const f of unknowns) {
        console.log(`      [UNKNOWN] ${f.criterion_key}: ${f.reason}`);
      }
    }
    if (!fails.length && !unknowns.length) console.log('    blockers   : none');
    console.log('    relevance  :');
    for (const sig of relevanceSignals(r, TERMS)) {
      console.log(`      ${sig.signal}: ${sig.evidence}  [${sig.strength}]`);
    }
  }

  h('WHAT THIS DEMONSTRATION DOES NOT ESTABLISH');
  console.log('  · that anything here is biddable. Nothing is. The only biddable kind is a SAM.gov');
  console.log('    solicitation and SAM.gov is not authorized, so the biddable bucket is empty.');
  console.log('  · that any record is QUALIFIED. With no capability registry and no SAM');
  console.log('    registration, the mandatory gates cannot pass and return NEEDS_REVIEW.');
  console.log('  · that a research lead is a buyer. It is AI-derived demand and must not be');
  console.log('    presented as a confirmed buyer requirement. Outreach remains behind the email HOLD.');
  console.log('  · that a historical award is pipeline, a forecast is an opportunity, or a grant is');
  console.log('    procurement revenue — including when its funding instrument says "contract".');
  console.log('  · any dollar figure as ours. The only amounts shown are obligations on awards');
  console.log('    already made to other recipients.');
  console.log('');
  console.log('  Nothing was persisted. No email, bid, submission or supplier contact occurred.');
  console.log('  All HOLDs and capability STOPs remain active.');
  console.log('');
  return 0;
}

/** Grants.gov returns MM/DD/YYYY. Returns null rather than a guess when it is not that. */
function isoFromUs(s) {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
