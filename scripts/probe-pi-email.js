#!/usr/bin/env node
// ── WHY ZERO OF TEN FUNDED CHEMISTS HAD A PUBLISHED ADDRESS ──────────────────
//
//   railway ssh 'node scripts/probe-pi-email.js'
//
// Read-only. Stores nothing, sends nothing.
//
// ── THE CONTRADICTION THIS EXISTS TO RESOLVE ─────────────────────────────────
//
// probe-research-sources.js measured a 22-30% reachable rate across three topics. Then
// ingest-research-labs.js enriched ten funded chemistry labs and found 0%. Those cannot both
// describe the same world. The labs in question are Scott Miller at Yale, Marisa Kozlowski at
// Penn, Paul Hergenrother at Illinois — people with hundreds of papers each. The addresses exist.
// My lookup is not finding them.
//
// And the reason I cannot tell you why is that I wrote this in findEmailForPi:
//
//     try { data = await getJson(url); } catch (_) { return null; }
//
// which is precisely the silent-failure class I spent this session removing from the task agent: a
// malformed query, a 400, a rate limit and a genuine absence of data all return the same answer,
// and the report then prints a confident "—". So this probe distinguishes the two things that
// matter and refuses to collapse them:
//
//   · ZERO HITS            the query is wrong. My fault, fixable.
//   · HITS BUT NO ADDRESS  the query is right and the papers carry no email. A real finding.
//
// It tries several query formulations per PI because I do not know Europe PMC's author convention
// for certain — RePORTER gives "Scott J Miller" as first/middle/last, while Europe PMC indexes
// authors as "Miller SJ". Guessing which to use is what produced the 0%. Measuring is cheaper.
'use strict';

const { extractEmails, attributeEmail, normalizePerson } = require('../src/lib/research/affiliation');

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

// The exact PIs the ingest failed on, with the institution exactly as RePORTER spelled it — so
// this tests the real inputs, not a tidied version of them.
const CASES = [
  { first: 'Scott', middle: 'J', last: 'Miller', org: 'YALE UNIVERSITY' },
  { first: 'Marisa', middle: 'C', last: 'Kozlowski', org: 'UNIVERSITY OF PENNSYLVANIA' },
  { first: 'Paul', middle: '', last: 'Hergenrother', org: 'UNIVERSITY OF ILLINOIS AT URBANA-CHAMPAIGN' },
  { first: 'Mario', middle: '', last: 'Rivera', org: 'LOUISIANA STATE UNIV A&M COL BATON ROUGE' },
  { first: 'Zhengqiang', middle: '', last: 'Wang', org: 'UNIVERSITY OF MINNESOTA' },
];

// Europe PMC's AFF index holds the published affiliation string, which never looks like
// "LOUISIANA STATE UNIV A&M COL BATON ROUGE". Passing RePORTER's spelling straight through is a
// likely cause of zero hits all by itself, so one variant drops the affiliation entirely.
function orgKeyword(org) {
  const s = String(org || '').toLowerCase()
    .replace(/\buniv\b/g, 'university').replace(/&/g, ' and ')
    .replace(/\b(col|coll)\b/g, 'college').replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // "university of illinois at urbana champaign" -> "illinois": the distinctive word, which is
  // what actually appears in a published affiliation.
  const stop = new Set(['university', 'of', 'at', 'the', 'college', 'and', 'state', 'univ', 'medical', 'center']);
  const words = s.split(' ').filter((w) => w.length > 3 && !stop.has(w));
  return words[0] || s.split(' ')[0] || '';
}

function variants(c) {
  const initials = `${c.first[0] || ''}${c.middle ? c.middle[0] : ''}`;
  const kw = orgKeyword(c.org);
  return [
    // what the ingest currently sends
    { label: 'AUTH "Last, First" + AFF full org', q: `AUTH:"${c.last}, ${c.first}" AND AFF:"${String(c.org).split(',')[0].slice(0, 48)}"` },
    // Europe PMC's own author convention
    { label: 'AUTH "Last Initials"            ', q: `AUTH:"${c.last} ${initials}"` },
    { label: 'AUTH "Last Initials" + AFF kw   ', q: `AUTH:"${c.last} ${initials}" AND AFF:"${kw}"` },
    { label: 'AUTH "First Last"               ', q: `AUTH:"${c.first} ${c.last}"` },
    // surname plus distinctive institution word, loosest useful form
    { label: 'AUTH "Last" + AFF kw            ', q: `AUTH:"${c.last}" AND AFF:"${kw}"` },
  ];
}

async function run(q) {
  const url = `${EPMC}?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=25`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status}`, body: text.slice(0, 200) };
  let data;
  try { data = JSON.parse(text); } catch (e) { return { error: `unparseable: ${e.message}` }; }
  return { hits: data.hitCount, results: (data.resultList && data.resultList.result) || [] };
}

// Of the papers returned, how many carry ANY address, and how many carry one we would attribute to
// this PI. The gap between those two numbers is the cost of the attribution rule, stated honestly.
function measure(results, c) {
  let withAny = 0; let attributed = 0; let sample = null;
  for (const h of results) {
    const authors = ((h.authorList && h.authorList.author) || []);
    const pool = [];
    for (const a of authors) {
      const affs = ((a.authorAffiliationDetailsList
        && a.authorAffiliationDetailsList.authorAffiliation) || [])
        .map((x) => x.affiliation).filter(Boolean);
      for (const aff of affs) for (const e of extractEmails(aff)) pool.push({ e, a });
    }
    for (const e of extractEmails(h.affiliation || '')) pool.push({ e, a: null });
    if (!pool.length) continue;
    withAny += 1;
    for (const { e, a } of pool) {
      const who = a ? attributeEmail(e, [{ firstName: a.firstName, lastName: a.lastName, initials: a.initials }])
        : attributeEmail(e, authors.map((x) => ({ firstName: x.firstName, lastName: x.lastName, initials: x.initials })));
      if (who && normalizePerson(who.lastName) === normalizePerson(c.last)) {
        attributed += 1; sample = sample || e; break;
      }
    }
  }
  return { withAny, attributed, sample };
}

async function main() {
  say('\n── why the PI lookup returned nothing  (read-only)\n');
  say('   ZERO HITS = my query is wrong.  HITS BUT NO ADDRESS = a real finding.\n');

  const winners = new Map();

  for (const c of CASES) {
    say(`   ── ${c.first} ${c.middle} ${c.last}  ·  ${c.org}`);
    say(`      (affiliation keyword: "${orgKeyword(c.org)}")`);
    for (const v of variants(c)) {
      const r = await run(v.q);
      if (r.error) {
        say(`      ${v.label}  ✗ ${r.error} ${r.body ? `— ${r.body}` : ''}`);
      } else {
        const m = measure(r.results, c);
        say(`      ${v.label}  hits ${pad(r.hits, 8)} papers ${pad(r.results.length, 4)}`
          + ` with-address ${pad(m.withAny, 4)} attributed ${pad(m.attributed, 4)}`
          + (m.sample ? ` → ${m.sample}` : ''));
        if (m.attributed > 0) {
          const prev = winners.get(v.label) || 0;
          winners.set(v.label, prev + 1);
        }
      }
      await sleep(350);
    }
    say();
  }

  say('   ── WHICH FORMULATION ACTUALLY WORKS');
  if (!winners.size) {
    say('      none produced an attributable address for any of the five.');
    say('      If hit counts above were non-zero, the queries are fine and the addresses genuinely');
    say('      are not in these records — which means US chemistry journals strip them, and the');
    say('      22-30% measured earlier came from other regions. That changes the channel, not the');
    say('      code: enrich European and Asian labs this way, reach US labs another route.');
  } else {
    for (const [label, n] of [...winners.entries()].sort((a, b) => b[1] - a[1])) {
      say(`      ${label}  worked for ${n}/${CASES.length} PIs`);
    }
    say('\n      Highest-scoring formulation goes into findEmailForPi.');
  }
  say();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('probe-pi-email failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
