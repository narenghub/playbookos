#!/usr/bin/env node
// ── WHAT THE PROCUREMENT AND FUNDING SOURCES ACTUALLY RETURN ─────────────────
//
//   node scripts/probe-procurement-sources.js
//   node scripts/probe-procurement-sources.js --naics=325412 --keyword="active pharmaceutical ingredient"
//   node scripts/probe-procurement-sources.js --json          (one JSON document on stdout, nothing else)
//
// PRPA PR-1. Read-only. Writes no rows, sends no email, stores nothing, authenticates nowhere.
//
// ── WHY A PROBE AND NOT JUST THE INGEST ──────────────────────────────────────
//
// Same reason as scripts/probe-research-sources.js: an ingest built on field paths somebody
// remembered writes NULL into every column and reports success. That is not an error anybody
// sees — it is a log line that reads like a good day.
//
// So this does not assert my expectations about the response. It WALKS the live response and
// reports where each field actually sits, by key path, with a count.
//
// It DOES assert a small number of STRUCTURAL facts, because the connector's correctness depends
// on them and a silent change would corrupt the dataset rather than empty it:
//
//   U1  USAspending paging exposes page_metadata.hasNext          — else we cannot page safely
//   U2  generated_internal_id is present on every result          — it is the natural key
//   U3  "Award ID" (PIID) is NOT unique across results            — so it must NOT be the key
//   G1  Grants.gov returns data.oppHits as an array
//   G2  data.hitCount is a number                                 — paging total
//   G3  docType distinguishes forecast from synopsis              — a forecast is not biddable
//   G4  closeDate may be empty                                    — so it is nullable, not a date
//
// U3 and G3 are the two that would do real damage. U3 because a task order and its parent IDV
// share nothing but a PIID, so keying on "Award ID" silently collapses distinct awards. G3 because
// a forecast with no close date rendered as a live opportunity is exactly the fabricated-pipeline
// failure the brief's §5 and §15 forbid.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
// SAM.gov is NOT called. No system-account key exists yet, and a personal key allows roughly ten
// requests a day — spending them on a shape probe is the wrong use of the quota. Reported as
// NOT PROBED, never as unavailable.
//
// FedConnect is checked for UNAUTHENTICATED reachability only. It is a login portal. Per ruling,
// authenticated access is not automated and not attempted. A 302 to a sign-in page is the finding,
// not a problem to route around.
//
// SBCX (mysbcx.hhs.gov) is not called at all: an authenticated portal with no published API, which
// the brief's §3 and §2 put outside automated access entirely.
'use strict';

const EXIT_OK = 0;
const EXIT_FAIL = 1;          // a probe executed and contradicted a structural assumption
const EXIT_INCOMPLETE = 2;    // a probe could not execute — never reported as a pass

const USASPENDING_AWARDS = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const GRANTS_SEARCH = 'https://api.grants.gov/v1/api/search2';
const GRANTS_FETCH = 'https://api.grants.gov/v1/api/fetchOpportunity';
const FEDCONNECT = 'https://www.fedconnect.net/FedConnect/';

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const JSON_MODE = process.argv.includes('--json');

// NAICS 325412 = pharmaceutical preparation manufacturing. 325411 = medicinal & botanical.
// 541380 = testing laboratories. These are the three Abiozen actually sells into.
const NAICS = arg('naics', '325412,325411,541380').split(',').map((s) => s.trim()).filter(Boolean);
const KEYWORD = arg('keyword', 'active pharmaceutical ingredient');
const ROWS = Math.max(1, Math.min(50, parseInt(arg('rows', '10'), 10) || 10));

// In --json mode stdout carries exactly one JSON document. Everything else goes to stderr.
// This is the lesson from the exporter: a diagnostic line on stdout makes the document unparseable,
// and the caller finds out by crashing on JSON.parse rather than by reading a warning.
const say = (s = '') => { if (JSON_MODE) process.stderr.write(`${s}\n`); else process.stdout.write(`${s}\n`); };

const report = {
  probed_at: new Date().toISOString(),
  sources: {},
  assertions: [],
  not_probed: [],
};

function assert(id, claim, ok, detail) {
  report.assertions.push({ id, claim, ok: !!ok, detail: detail == null ? null : String(detail) });
  say(`  ${ok ? 'OK  ' : 'FAIL'}  ${id}  ${claim}${detail ? `  — ${detail}` : ''}`);
}

// ── shape walking ───────────────────────────────────────────────────────────
// Record every leaf key path with a type and a count, so a renamed or newly-nested field shows up
// as a path that is gone rather than as a column that is quietly null.
function walk(node, path, out, depth = 0) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    for (const v of node) walk(v, `${path}[]`, out, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, out, depth + 1);
    return;
  }
  const t = typeof node;
  const e = out.get(path) || { type: t, count: 0, sample: null, empties: 0 };
  e.count += 1;
  if (node === '' || node === null) e.empties += 1;
  else if (e.sample === null) e.sample = t === 'string' && node.length > 70 ? `${node.slice(0, 70)}…` : node;
  if (e.type !== t) e.type = `${e.type}|${t}`;
  out.set(path, e);
}

function printPaths(paths, limit = 40) {
  const rows = [...paths.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, limit);
  const w = Math.max(...rows.map(([p]) => p.length), 4);
  for (const [p, e] of rows) {
    const empt = e.empties ? `  ${e.empties} empty` : '';
    say(`    ${p.padEnd(w)}  ${String(e.count).padStart(4)}×  ${e.type.padEnd(7)}  ${JSON.stringify(e.sample)}${empt}`);
  }
  if (paths.size > rows.length) say(`    … and ${paths.size - rows.length} more paths`);
}

async function post(url, body, timeoutMs = 45000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* reported as unparseable below */ }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

async function head(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: ac.signal });
    return { status: r.status, location: r.headers.get('location') || null };
  } finally { clearTimeout(t); }
}

// ── USAspending ─────────────────────────────────────────────────────────────
async function probeUsaspending() {
  say('');
  say('━━ USAspending — POST /api/v2/search/spending_by_award/ ━━━━━━━━━━━━━━━━━');
  say('   no API key, no signup, no published daily quota');
  const now = new Date();
  const from = new Date(now.getTime() - 365 * 864e5).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);

  let res;
  try {
    res = await post(USASPENDING_AWARDS, {
      filters: {
        award_type_codes: ['A', 'B', 'C', 'D'],
        naics_codes: NAICS,
        time_period: [{ start_date: from, end_date: to }],
      },
      fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
        'Awarding Sub Agency', 'NAICS', 'PSC', 'Start Date', 'End Date',
        'recipient_id', 'generated_internal_id'],
      limit: ROWS,
      page: 1,
    });
  } catch (e) {
    report.sources.usaspending = { reachable: false, error: e.message };
    say(`   UNREACHABLE: ${e.message}`);
    return 'incomplete';
  }

  say(`   HTTP ${res.status}   NAICS ${NAICS.join(',')}   window ${from} → ${to}`);
  if (res.status !== 200 || !res.json) {
    report.sources.usaspending = { reachable: true, status: res.status, body: res.text.slice(0, 400) };
    say(`   body: ${res.text.slice(0, 300)}`);
    return 'incomplete';
  }

  const results = Array.isArray(res.json.results) ? res.json.results : [];
  const paths = new Map();
  walk(res.json, '', paths);
  say(`   results: ${results.length}`);
  say('   response key paths:');
  printPaths(paths);

  // U1 — paging
  const pm = res.json.page_metadata;
  assert('U1', 'page_metadata.hasNext present', pm && typeof pm.hasNext === 'boolean',
    pm ? `hasNext=${pm.hasNext} last_record_unique_id=${pm.last_record_unique_id}` : 'no page_metadata');

  // U2 — natural key present on every row
  const missingKey = results.filter((r) => !r.generated_internal_id).length;
  assert('U2', 'generated_internal_id present on every result', results.length > 0 && missingKey === 0,
    `${results.length - missingKey}/${results.length} carry it`);

  // U3 — PIID is NOT unique. This is an assertion that a COLLISION IS POSSIBLE, not that one
  // happened in ten rows. We prove it structurally: the natural key embeds the PIID plus the
  // parent IDV, so two rows can share "Award ID" and differ in generated_internal_id.
  const piids = results.map((r) => r['Award ID']).filter(Boolean);
  const keys = results.map((r) => r.generated_internal_id).filter(Boolean);
  //
  // NOTE ON WHAT THIS CHECKS, AND WHAT IT FIRST GOT WRONG.
  //
  // "keyDistinct >= piidDistinct" would pass on any ten rows without proving anything, so it is
  // not the assertion. The first attempt instead asserted that every key embeds a PARENT award id,
  // which failed at 7/10 — correctly, because a standalone definitive contract has no parent IDV
  // and carries the sentinel "-NONE-" in those slots. My expectation was wrong, not the data.
  //
  // The real, provable structure is:
  //
  //     CONT_AWD_<piid>_<awardingAgency>_<parentPiid | -NONE->_<parentAgency | -NONE->
  //
  // So the key is a COMPOSITE: the PIID plus three further discriminators. Two awards can share a
  // PIID and differ in agency or in parent IDV. That is the proof that PIID alone is not a key,
  // and it holds structurally rather than depending on a collision turning up in one page.
  //
  // It also surfaces a trap: "-NONE-" is a sentinel string, not a value. A connector that stores
  // parent_piid verbatim writes the literal "-NONE-" into the column and every later join on it
  // silently matches unrelated standalone awards.
  const piidDistinct = new Set(piids).size;
  const keyDistinct = new Set(keys).size;
  const KEY_RE = /^CONT_AWD_(.+?)_([A-Z0-9]{4})_(.+?)_(.+?)$/;
  let wellFormed = 0;
  let sentinelParents = 0;
  for (const r of results) {
    const k = r.generated_internal_id || '';
    const m = k.match(KEY_RE);
    if (m && m[1] === r['Award ID']) wellFormed += 1;
    if (m && m[3] === '-NONE-') sentinelParents += 1;
  }
  assert('U3', 'generated_internal_id is PIID + awarding agency + parent PIID + parent agency — a composite, so PIID alone is not the natural key',
    results.length > 0 && wellFormed === results.length,
    `${wellFormed}/${results.length} keys well-formed with the PIID in slot 1; ${sentinelParents} carry the "-NONE-" parent sentinel (${piidDistinct} distinct PIID, ${keyDistinct} distinct key in this page)`);
  assert('U4', '"-NONE-" parent sentinel must be normalised to NULL, never stored verbatim',
    true, `${sentinelParents}/${results.length} standalone awards in this page would otherwise store the literal string`);

  // Vendor-documented caveats worth surfacing in the probe output rather than a code comment.
  if (Array.isArray(res.json.messages) && res.json.messages.length) {
    say('   server messages:');
    for (const m of res.json.messages) say(`     • ${String(m).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  say('   CAVEATS carried into the connector:');
  say('     • DoD contract actions are withheld ~90 days — trailing-quarter DoD trends undercount');
  say('     • amounts are OBLIGATIONS at action time, not outlays — must not be summed as spend');
  say('     • recipient rollups need recipient_id profile resolution, not name matching');

  report.sources.usaspending = {
    reachable: true, status: 200, auth: 'none',
    results: results.length,
    paging: pm || null,
    natural_key: 'generated_internal_id',
    paths: [...paths.keys()],
  };
  return 'ok';
}

// ── Grants.gov ──────────────────────────────────────────────────────────────
async function probeGrantsGov() {
  say('');
  say('━━ Grants.gov — POST /v1/api/search2 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  say('   "Authentication and authorization are not required" (api-guide)');

  let res;
  try {
    res = await post(GRANTS_SEARCH, { keyword: KEYWORD, rows: ROWS, startRecordNum: 0 });
  } catch (e) {
    report.sources.grants_gov = { reachable: false, error: e.message };
    say(`   UNREACHABLE: ${e.message}`);
    return 'incomplete';
  }

  say(`   HTTP ${res.status}   keyword "${KEYWORD}"   rows ${ROWS}`);
  if (res.status !== 200 || !res.json) {
    report.sources.grants_gov = { reachable: true, status: res.status, body: res.text.slice(0, 400) };
    return 'incomplete';
  }

  const d = res.json.data || {};
  const hits = Array.isArray(d.oppHits) ? d.oppHits : null;

  // Facet blocks are large and are NOT what the connector stores — walk only the hits, and
  // report the facet block names separately so a new facet is visible without 400 lines of output.
  const paths = new Map();
  walk({ errorcode: res.json.errorcode, msg: res.json.msg, searchParams: d.searchParams, hitCount: d.hitCount, oppHits: hits }, '', paths);
  say(`   msg "${res.json.msg}"   hitCount ${d.hitCount}   returned ${hits ? hits.length : 0}`);
  say('   hit key paths:');
  printPaths(paths);
  const facets = Object.keys(d).filter((k) => Array.isArray(d[k]) && k !== 'oppHits');
  say(`   facet blocks returned: ${facets.join(', ') || '(none)'}`);

  assert('G1', 'data.oppHits is an array', Array.isArray(hits), hits ? `${hits.length} hits` : typeof d.oppHits);
  assert('G2', 'data.hitCount is a number', typeof d.hitCount === 'number', `hitCount=${d.hitCount}`);

  // G3 — forecast vs synopsis. The single most dangerous field in this response.
  const docTypes = {};
  const statuses = {};
  for (const h of hits || []) {
    docTypes[h.docType || '(absent)'] = (docTypes[h.docType || '(absent)'] || 0) + 1;
    statuses[h.oppStatus || '(absent)'] = (statuses[h.oppStatus || '(absent)'] || 0) + 1;
  }
  assert('G3', 'docType present on every hit (forecast ≠ synopsis)',
    (hits || []).length > 0 && !docTypes['(absent)'],
    `docType ${JSON.stringify(docTypes)}  oppStatus ${JSON.stringify(statuses)}`);

  // G4 — closeDate nullability. Empty string, not null, not a date.
  const emptyClose = (hits || []).filter((h) => !h.closeDate).length;
  assert('G4', 'closeDate may be empty — nullable, and empty is NOT "no deadline, bid anytime"',
    true, `${emptyClose}/${(hits || []).length} hits have an empty closeDate`);

  // Dates are MM/DD/YYYY strings. Worth stating because an ISO parse of "12/14/2021" succeeds in
  // some runtimes and silently yields the wrong day in others.
  const sampleDates = (hits || []).map((h) => h.openDate).filter(Boolean).slice(0, 3);
  say(`   date format: ${JSON.stringify(sampleDates)}  → MM/DD/YYYY strings, parse explicitly`);

  // fetchOpportunity — documented as needing no auth, signature undocumented. Probe one id.
  const firstId = (hits || []).map((h) => h.id).filter(Boolean)[0] || null;
  let fetchShape = null;
  if (firstId) {
    say('');
    say(`   ── fetchOpportunity, id ${firstId} (signature is undocumented — discovering it)`);
    try {
      const f = await post(GRANTS_FETCH, { opportunityId: Number(firstId) });
      say(`      HTTP ${f.status}  msg "${f.json ? f.json.msg : '(unparseable)'}"`);
      if (f.status === 200 && f.json && f.json.data) {
        const fp = new Map();
        walk(f.json.data, '', fp);
        printPaths(fp, 28);
        const synopsisish = [...fp.keys()].filter((k) => /synopsis|description|agencyContact|oppNum|docType/i.test(k));
        say(`      detail fields relevant to §8 proposal drafting: ${synopsisish.slice(0, 10).join(', ') || '(none found)'}`);
        fetchShape = { status: 200, request_field: 'opportunityId', paths: [...fp.keys()] };
      } else {
        say(`      body: ${f.text.slice(0, 220)}`);
        fetchShape = { status: f.status, request_field: 'opportunityId', note: 'did not return data — signature UNKNOWN' };
      }
    } catch (e) {
      say(`      UNREACHABLE: ${e.message}`);
      fetchShape = { error: e.message };
    }
  }

  say('   CAVEATS carried into the connector:');
  say('     • oppStatus "forecasted" is a PLAN, not a solicitation — never shown as biddable');
  say('     • fundingInstruments includes "Procurement Contract" (PC); these still route to the');
  say('       funding pipeline, never to procurement revenue (ruling 4)');
  say('     • no published rate limit — pace courteously and meter every call');

  report.sources.grants_gov = {
    reachable: true, status: 200, auth: 'none',
    hit_count: d.hitCount, returned: (hits || []).length,
    natural_key: 'oppHits[].id', secondary_key: 'oppHits[].number',
    doc_types: docTypes, statuses, facet_blocks: facets,
    date_format: 'MM/DD/YYYY',
    fetch_opportunity: fetchShape,
    paths: [...paths.keys()],
  };
  return 'ok';
}

// ── FedConnect — unauthenticated reachability ONLY ──────────────────────────
async function probeFedConnect() {
  say('');
  say('━━ FedConnect — unauthenticated reachability only ━━━━━━━━━━━━━━━━━━━━━━');
  say('   Ruling 3: assess feasibility. Do NOT assume an API, do NOT automate authenticated access.');
  try {
    const r = await head(FEDCONNECT);
    say(`   GET ${FEDCONNECT} → HTTP ${r.status}${r.location ? `  Location: ${r.location}` : ''}`);
    const portal = r.status >= 300 && r.status < 400;
    say(portal
      ? '   FINDING: redirects — consistent with a session/sign-in portal, not a data endpoint.'
      : '   FINDING: served a page. That is not evidence of a machine-readable API.');
    say('   No public API is documented. Treating FedConnect as a MANUAL-ASSISTED source:');
    say('     scheduled human task + evidence attachment, same shape as SBCX. No login automation.');
    report.sources.fedconnect = {
      reachable: true, status: r.status, location: r.location,
      api: 'UNKNOWN — none documented', access: 'manual-assisted only; authenticated access not automated',
    };
    return 'ok';
  } catch (e) {
    say(`   UNREACHABLE: ${e.message}`);
    report.sources.fedconnect = { reachable: false, error: e.message, api: 'UNKNOWN' };
    return 'incomplete';
  }
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  say('PRPA PR-1 — procurement and funding source probe');
  say('read-only · no writes · no email · no authentication · no SAM.gov quota spent');

  const outcomes = [];
  outcomes.push(await probeUsaspending());
  outcomes.push(await probeGrantsGov());
  outcomes.push(await probeFedConnect());

  // Sources deliberately not called. Reported explicitly so that "absent from the output" can
  // never be mistaken for "tried and failed".
  report.not_probed = [
    { source: 'sam.gov', reason: 'no system-account key yet; a personal key allows ~10 req/day and spending it on a shape probe is the wrong use of the quota' },
    { source: 'mysbcx.hhs.gov', reason: 'authenticated portal, no published API; brief §2/§3 place it outside automated access' },
    { source: 'api.reporter.nih.gov', reason: 'already ingested weekly — covered by probe-research-sources.js, not rebuilt' },
    { source: 'clinicaltrials.gov', reason: 'already implemented in src/lib/agents/research-intelligence/clinicaltrials.js' },
    { source: 'ebi.ac.uk (Europe PMC)', reason: 'already ingested weekly — covered by probe-research-sources.js' },
  ];
  say('');
  say('━━ NOT PROBED (deliberately — absence here is not a failure) ━━━━━━━━━━━━');
  for (const n of report.not_probed) say(`   ${n.source.padEnd(28)} ${n.reason}`);

  const failed = report.assertions.filter((a) => !a.ok);
  const incomplete = outcomes.filter((o) => o === 'incomplete').length;

  say('');
  say('━━ VERDICT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  say(`   ${report.assertions.length - failed.length} structural assertion(s) held · ${failed.length} failed · ${incomplete} source(s) did not execute`);

  let code = EXIT_OK;
  let verdict = 'PASS';
  if (failed.length) { code = EXIT_FAIL; verdict = 'FAIL'; }
  else if (incomplete) { code = EXIT_INCOMPLETE; verdict = 'INCOMPLETE'; }
  report.verdict = verdict;

  if (failed.length) for (const f of failed) say(`   FAILED  ${f.id}  ${f.claim}  — ${f.detail}`);
  say(`   ${verdict}`);
  say('   (the verdict is this process\'s exit status — read $?, not this line)');

  if (JSON_MODE) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(code);
})().catch((e) => {
  say(`\nPROBE ABORTED: ${e.stack || e.message}`);
  process.exit(EXIT_INCOMPLETE);
});
