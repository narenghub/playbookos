#!/usr/bin/env node
// ── WHAT THE CONTACT SOURCES ACTUALLY RETURN ─────────────────────────────────
//
//   railway ssh 'node scripts/probe-research-sources.js'
//   railway ssh 'node scripts/probe-research-sources.js --topic="GLP-1 receptor agonist"'
//
// Read-only. Writes no rows, sends nothing, stores no addresses.
//
// ── WHY A PROBE AND NOT JUST THE INGEST ──────────────────────────────────────
//
// An ingest built on field paths somebody remembered writes NULL into every column and reports
// success, which is the same failure mode as the task segments: no error, no data, a log line that
// reads like a good day. It is also the failure mode that cost us the Reliance catalogue, where the
// parser ran cleanly over text it had silently mangled.
//
// So this does not assert my expectations. It WALKS the live response and reports where an address
// actually sits, by key path, with a count. If Europe PMC renames authorList.author[].email
// tomorrow, this says so in one line instead of the ingest quietly storing nothing.
//
// It also measures the only number that decides whether this plan is worth building: of papers on
// a topic we can supply, WHAT FRACTION CARRY A REACHABLE ADDRESS. If that is 3%, the publication
// route is not a channel and we should put the effort into grant records and conferences instead.
// Better to learn that from one read-only script than from a quarter of ingest work.
'use strict';

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const NIH = 'https://api.reporter.nih.gov/v2/projects/search';

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const TOPIC = arg('topic', 'medicinal chemistry synthesis');
const PAGE = Math.max(1, Math.min(100, parseInt(arg('n', '50'), 10) || 50));

const say = (s = '') => console.log(s);
const EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

// Walk any shape and record every key path whose value looks like an address. Discovery, not
// assumption: the point is to find out where they are, not to confirm where I think they are.
function findEmails(node, path, out) {
  if (node == null) return;
  if (typeof node === 'string') {
    const s = node.trim();
    if (EMAIL_RE.test(s)) {
      const e = out.get(path) || { count: 0, sample: s };
      e.count += 1;
      out.set(path, e);
    } else if (s.includes('@') && s.length < 300) {
      // addresses embedded in prose — affiliation strings often end "...; e-mail: x@y.ac.uk"
      const m = s.match(/[^\s<>()[\]{},;:"]+@[^\s<>()[\]{},;:"]+\.[A-Za-z]{2,}/);
      if (m) {
        const k = `${path} (inside text)`;
        const e = out.get(k) || { count: 0, sample: m[0] };
        e.count += 1;
        out.set(k, e);
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) findEmails(v, `${path}[]`, out);
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) findEmails(v, path ? `${path}.${k}` : k, out);
  }
}

function keyShape(node, depth = 0, prefix = '') {
  if (depth > 2 || node == null || typeof node !== 'object') return [];
  const out = [];
  if (Array.isArray(node)) return node.length ? keyShape(node[0], depth + 1, `${prefix}[]`) : [];
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push(...keyShape(v, depth + 1, p));
    else out.push(`${p} = ${String(v).slice(0, 60)}`);
  }
  return out;
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

let problems = 0;

async function probeEuropePmc() {
  say('── EUROPE PMC  (corresponding-author addresses, published for correspondence)');
  say(`   topic: "${TOPIC}"  ·  ${PAGE} records  ·  resultType=core\n`);

  const url = `${EPMC}?query=${encodeURIComponent(TOPIC)}`
    + `&format=json&resultType=core&pageSize=${PAGE}`;

  let data;
  try { data = await getJson(url); } catch (e) {
    say(`   ✗ unreachable: ${e.message}`);
    say(`     Railway has open egress, so a failure here is the API or the query, not the network.`);
    problems += 1;
    return;
  }

  const hits = (data.resultList && data.resultList.result) || [];
  say(`   hitCount ${data.hitCount} · returned ${hits.length}`);
  if (!hits.length) { say('   ✗ no records — widen the topic'); problems += 1; return; }

  const paths = new Map();
  for (const h of hits) findEmails(h, '', paths);

  say('\n   WHERE ADDRESSES ACTUALLY APPEAR');
  if (!paths.size) {
    say('   ✗ none found in any field of any record.');
    say('     This is the finding, not a bug: if it holds across topics, publications are not a');
    say('     contact channel for us and the effort belongs in grant records instead.');
    problems += 1;
  } else {
    for (const [p, v] of [...paths.entries()].sort((a, b) => b[1].count - a[1].count)) {
      say(`      ${String(v.count).padStart(4)}×  ${p}`);
      say(`            e.g. ${v.sample}`);
    }
  }

  // THE NUMBER THAT DECIDES THE PLAN
  const withAny = hits.filter((h) => { const m = new Map(); findEmails(h, '', m); return m.size > 0; });
  const pct = Math.round((withAny.length / hits.length) * 100);
  say(`\n   REACHABLE RATE   ${withAny.length}/${hits.length} papers carry an address  (${pct}%)`);
  if (pct < 10) say('      ⚠ under 10%. Treat publications as enrichment, not as the channel.');
  else if (pct < 30) say('      usable, but expect to need grant records for coverage.');
  else say('      strong. This is a real channel.');

  say('\n   AUTHOR / AFFILIATION / GRANT SHAPE (first record, 3 levels)');
  const f = hits[0];
  for (const line of keyShape(
    { authorList: f.authorList, grantsList: f.grantsList, affiliation: f.affiliation },
  ).slice(0, 24)) say(`      ${line}`);
  say(`\n   first record: ${f.id} · ${String(f.title || '').slice(0, 70)}`);
  say(`   checkable at: https://europepmc.org/article/${f.source}/${f.id}\n`);
}

async function probeNihReporter() {
  say('── NIH REPORTER  (who holds money, for what, until when — public award record)\n');

  const body = {
    criteria: {
      advanced_text_search: {
        operator: 'and', search_field: 'projecttitle,abstracttext', search_text: TOPIC,
      },
    },
    include_fields: ['ProjectNum', 'ProjectTitle', 'PrincipalInvestigators', 'Organization',
      'AwardAmount', 'ProjectEndDate', 'ProjectStartDate', 'AbstractText'],
    offset: 0, limit: 25, sort_field: 'project_end_date', sort_order: 'desc',
  };

  let data;
  try {
    data = await getJson(NIH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    say(`   ✗ unreachable or rejected: ${e.message}`);
    say('     If this is a 400, the criteria shape changed — print the body and compare against');
    say('     https://api.reporter.nih.gov/ before assuming the field names below.');
    problems += 1;
    return;
  }

  const results = data.results || [];
  say(`   total ${data.meta && data.meta.total} · returned ${results.length}`);
  if (!results.length) { say('   ✗ no awards for this topic'); problems += 1; return; }

  say('\n   ACTUAL RESPONSE KEYS (first award, 3 levels)');
  for (const line of keyShape(results[0]).slice(0, 30)) say(`      ${line}`);

  const emails = new Map();
  for (const r of results) findEmails(r, '', emails);
  say('\n   ADDRESSES IN AWARD RECORDS');
  if (!emails.size) {
    say('      none — expected. RePORTER names the PI and the institution, not the inbox.');
    say('      It is the FUNDING and FOCUS source; the address comes from their papers,');
    say('      matched on PI name + institution. That join is the whole design.');
  } else {
    for (const [p, v] of emails.entries()) say(`      ${v.count}×  ${p}  e.g. ${v.sample}`);
  }

  say('\n   TOP AWARDS BY END DATE — the labs with budget left to spend');
  for (const r of results.slice(0, 8)) {
    const pis = (r.principal_investigators || []).map((p) => p.full_name || p.fullName).filter(Boolean);
    const org = (r.organization && (r.organization.org_name || r.organization.orgName)) || '?';
    const amt = r.award_amount != null ? `$${Number(r.award_amount).toLocaleString()}` : '?';
    say(`      ${String(r.project_end_date || '').slice(0, 10)}  ${String(pis[0] || '?').padEnd(26)} ${String(org).slice(0, 34).padEnd(36)} ${amt}`);
  }
  say();
}

async function main() {
  say(`\n── probing the contact sources  (read-only, stores nothing)\n`);
  await probeEuropePmc();
  await probeNihReporter();

  say('── WHAT TO DO WITH THIS');
  say('   The reachable rate above decides the plan. Field paths it printed are what the ingest');
  say('   maps; anything I would otherwise have guessed is now a fact. Nothing writes a contact');
  say('   until this has been read.\n');

  if (problems) {
    say(`   ${problems} source(s) did not answer usefully — see above.\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('probe-research-sources failed:', e && e.message ? e.message : e);
  process.exit(1);
});
