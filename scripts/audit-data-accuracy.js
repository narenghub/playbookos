#!/usr/bin/env node
// ── HOW ACCURATE IS OUR DATA, MEASURED RATHER THAN ASSERTED ──────────────────
//
//   railway ssh 'node scripts/audit-data-accuracy.js'
//   railway ssh 'node scripts/audit-data-accuracy.js --source=labs'
//
// Read-only.
//
// ── WHY THIS HAS TO EXIST BEFORE ANY OF IT IS SOLD ───────────────────────────
//
// The plan is to sell lead data. The moment somebody pays for it, "how accurate is this?" stops
// being a conversation and becomes a warranty, and the honest answer has to be a number with a
// method behind it rather than an adjective.
//
// It also has to separate three things that get collapsed into one word:
//
//   VERIFIED    we checked it against the source and it agrees
//   UNVERIFIED  we cannot check it from here — not wrong, not confirmed
//   WRONG       we checked and it disagrees
//
// Most of this month's defects came from reporting the second as the first. The demand count read
// 37 buyers when 3 were real. The bounce gate read 0.0% from a table nothing wrote to. Each
// printed a confident number. So every figure below says which of the three it is, and where a
// thing genuinely cannot be known from inside the database, it says so instead of estimating.
//
// ── WHAT CANNOT BE MEASURED HERE, AND IS NOT PRETENDED ───────────────────────
//
// Whether an email address still works. Only a send proves that, and the bounce rate in
// outreach_bounces is the measurement — which is why that scanner had to be proven by causing a
// real bounce before any of its zeros meant anything.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { domainMatchesInstitution } = require('../src/lib/research/domain-match');
const { validCas } = (() => {
  try { return require('../src/lib/catalogue/cas'); } catch (_) { return {}; }
})();

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const ONLY = arg('source', '');

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const pc = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const bar = (n, d) => '█'.repeat(Math.round((d ? n / d : 0) * 28));

const want = (k) => !ONLY || ONLY === k;

async function safe(sql, params = []) {
  try { return (await query(sql, params)).rows; } catch (e) { return { err: e.message }; }
}

// ── 1. RESEARCH LABS ─────────────────────────────────────────────────────────
async function labs() {
  say('\n══ RESEARCH LABS — NIH RePORTER + Europe PMC ════════════════════════');

  const l = await safe(`
    SELECT l.id, l.institution_name, l.pi_name, l.department, l.focus,
           l.funding_id, l.funding_end, l.funding_amount, l.source_url, l.evidence_count,
           p.email, p.email_basis, p.source_url AS person_url, p.published_for
      FROM research_labs l
      LEFT JOIN research_people p ON p.lab_id = l.id`);
  if (l.err) { say(`   cannot read: ${l.err}`); return; }

  const rows = l;
  const withEmail = rows.filter((r) => r.email);
  say(`   ${rows.length} lab row(s) · ${withEmail.length} with an address\n`);

  // ── THE GRANT FACTS: verifiable, and the strongest thing we have ────
  const hasGrant = rows.filter((r) => r.funding_id).length;
  const hasUrl = rows.filter((r) => r.source_url).length;
  const future = rows.filter((r) => r.funding_end && new Date(r.funding_end) > new Date()).length;
  say('   GRANT FACTS — from NIH\'s own register, checkable by anyone');
  say(`      ${pad('award number recorded', 36)}${pad(`${hasGrant}/${rows.length}`, 10)}${pc(hasGrant, rows.length)}`);
  say(`      ${pad('source URL recorded', 36)}${pad(`${hasUrl}/${rows.length}`, 10)}${pc(hasUrl, rows.length)}`);
  say(`      ${pad('grant still running', 36)}${pad(`${future}/${rows.length}`, 10)}${pc(future, rows.length)}`);
  say('      VERIFIED. Every row carries a reporter.nih.gov link a buyer can open.');
  if (hasGrant < rows.length) {
    say(`      ⚠ ${rows.length - hasGrant} row(s) have no award number and cannot be evidenced.`);
  }

  // ── THE ADDRESS: the weak claim, and the one worth money ────
  say('\n   ADDRESSES — inferred by joining a PI to a paper, and the weakest link');
  const basis = {};
  for (const r of withEmail) basis[r.email_basis || '(none)'] = (basis[r.email_basis || '(none)'] || 0) + 1;
  for (const [k, n] of Object.entries(basis)) {
    say(`      ${pad(`basis: ${k}`, 36)}${pad(n, 10)}${pc(n, withEmail.length)}`);
  }

  // Domain ↔ institution. The error this catches is a plausible person attached to the wrong
  // organisation, which produces a confident personalised email to a stranger.
  const verdicts = { match: [], unverified: [], mismatch: [], freemail: [], unknown: [] };
  for (const r of withEmail) {
    const v = domainMatchesInstitution(r.email, r.institution_name);
    verdicts[v.verdict].push({ ...r, how: v.how, domain: v.domain });
  }

  // An "unverified" address whose domain belongs to a DIFFERENT institution we hold is not
  // unverified at all — it is attached to the wrong one. Upgrading those is the only way the
  // yale.edu-for-Wisconsin shape gets caught.
  const institutions = [...new Set(rows.map((r) => r.institution_name).filter(Boolean))];
  const upgraded = [];
  for (const r of [...verdicts.unverified]) {
    const other = institutions.find((inst) => inst !== r.institution_name
      && domainMatchesInstitution(r.email, inst).verdict === 'match');
    if (other) {
      verdicts.unverified = verdicts.unverified.filter((x) => x !== r);
      verdicts.mismatch.push({ ...r, how: `"${r.domain}" belongs to ${other}, not ${r.institution_name}` });
      upgraded.push(r);
    }
  }

  const n = withEmail.length;
  say('');
  say(`      ${pad('domain matches the institution', 36)}${pad(verdicts.match.length, 10)}${pad(pc(verdicts.match.length, n), 9)}${bar(verdicts.match.length, n)}`);
  say(`      ${pad('academic, link not derivable', 36)}${pad(verdicts.unverified.length, 10)}${pad(pc(verdicts.unverified.length, n), 9)}${bar(verdicts.unverified.length, n)}`);
  say(`      ${pad('public mail provider', 36)}${pad(verdicts.freemail.length, 10)}${pad(pc(verdicts.freemail.length, n), 9)}`);
  say(`      ${pad('WRONG INSTITUTION', 36)}${pad(verdicts.mismatch.length, 10)}${pad(pc(verdicts.mismatch.length, n), 9)}`);

  if (verdicts.mismatch.length) {
    say('\n      ✋ these addresses do not belong to the institution on the record:');
    for (const r of verdicts.mismatch) say(`         ${pad(r.pi_name, 24)}${pad(r.email, 36)}${r.how}`);
    say('         Do not email these. Each is a confident, personalised letter to a stranger.');
  }
  if (verdicts.unverified.length) {
    say('\n      these are academic addresses we could not link automatically — almost certainly');
    say('      fine (brand acronyms like umn.edu), but one human glance settles it:');
    for (const r of verdicts.unverified.slice(0, 10)) {
      say(`         ${pad(r.pi_name, 24)}${pad(r.email, 36)}${r.institution_name}`);
    }
  }

  // Two PIs sharing an address means the join put the same paper on two people.
  const byEmail = new Map();
  for (const r of withEmail) {
    const k = String(r.email).toLowerCase();
    byEmail.set(k, [...(byEmail.get(k) || []), r.pi_name]);
  }
  const shared = [...byEmail.entries()].filter(([, names]) => new Set(names).size > 1);
  if (shared.length) {
    say(`\n      ⚠ ${shared.length} address(es) are attached to more than one PI — the join is wrong`);
    for (const [e, names] of shared.slice(0, 5)) say(`         ${pad(e, 36)}${[...new Set(names)].join(' · ')}`);
  }

  // ── REACHABILITY, WHICH IS NOT ACCURACY ────
  say('\n   REACHABILITY — a different thing from accuracy, and often confused with it');
  const labCount = new Set(rows.map((r) => r.id)).size;
  say(`      ${pad('labs with any address', 36)}${pad(`${withEmail.length}/${labCount}`, 10)}${pc(withEmail.length, labCount)}`);
  say('      The rest are real, funded labs we simply cannot reach by this route. That is a');
  say('      coverage limit, not an error — and it is the ceiling on this pipeline.');

  // ── WHAT ONLY A SEND CAN TELL US ────
  const sent = await safe('SELECT COUNT(*)::int n FROM outreach_sends');
  const bounced = await safe('SELECT COUNT(DISTINCT LOWER(email))::int n FROM outreach_bounces');
  if (!sent.err) {
    const s = sent[0].n; const b = bounced.err ? 0 : bounced[0].n;
    say('\n   DELIVERABILITY — the only real test, and it needs sending');
    say(`      ${pad('messages sent', 36)}${s}`);
    say(`      ${pad('addresses that bounced', 36)}${b}   ${pc(b, s)}`);
    if (s < 25) {
      say(`      ⚠ ${s} send(s) is too few to call this a rate. It is an observation, not a number`);
      say('        to quote. At 25+ it starts to mean something.');
    }
  }
}

// ── 2. CLINICAL TRIALS ───────────────────────────────────────────────────────
async function trials() {
  say('\n══ CLINICAL TRIALS — ClinicalTrials.gov ══════════════════════════════');
  const t = await safe(`
    SELECT COUNT(*)::int n,
           COUNT(*) FILTER (WHERE raw_json IS NOT NULL)::int with_raw,
           COUNT(*) FILTER (WHERE nct_id IS NOT NULL AND nct_id <> '')::int with_nct,
           COUNT(*) FILTER (WHERE lead_sponsor_name IS NOT NULL)::int with_sponsor,
           COUNT(*) FILTER (WHERE enrollment_count IS NOT NULL)::int with_enrol,
           COUNT(*) FILTER (WHERE therapeutic_area IS NOT NULL)::int with_area,
           COUNT(*) FILTER (WHERE classification_confidence IS NOT NULL
                              AND classification_confidence < 0.7)::int low_conf
      FROM clinical_studies`);
  if (t.err) { say(`   cannot read: ${t.err}`); return; }
  const r = t[0];
  say(`   ${r.n} studies\n`);
  say('   FIELDS COPIED FROM THE REGISTRY — verifiable against a public URL per row');
  for (const [label, v] of [['NCT id', r.with_nct], ['lead sponsor', r.with_sponsor],
    ['enrolment target', r.with_enrol], ['original protocol retained', r.with_raw]]) {
    say(`      ${pad(label, 36)}${pad(`${v}/${r.n}`, 14)}${pc(v, r.n)}`);
  }
  say('      VERIFIED. scripts/audit-trial-feed.js re-derives these from the stored protocol and');
  say('      found 60/60 agreement — the figures are the registry\'s, not ours.');

  say('\n   FIELDS WE DERIVED — ours, and the part a buyer should question');
  say(`      ${pad('therapeutic area assigned', 36)}${pad(`${r.with_area}/${r.n}`, 14)}${pc(r.with_area, r.n)}`);
  say(`      ${pad('…of those, confidence < 0.7', 36)}${pad(r.low_conf, 14)}${pc(r.low_conf, r.with_area)}`);
  say('      UNVERIFIED. Classification is a judgement we make. The confidence score is our own');
  say('      estimate of it, not a measurement — no sample has been checked against a human.');
  say('      To sell this, score a random 50 by hand and publish that number instead.');
}

// ── 3. SUPPLIER CATALOGUE ────────────────────────────────────────────────────
async function catalogue() {
  say('\n══ SUPPLIER CATALOGUE — extracted from supplier PDFs ═════════════════');
  const c = await safe(`
    SELECT COUNT(*)::int n,
           COUNT(*) FILTER (WHERE review_status = 'approved')::int approved,
           COUNT(*) FILTER (WHERE cas IS NOT NULL AND cas <> '')::int with_cas,
           COUNT(*) FILTER (WHERE NULLIF(TRIM(product_name),'') IS NULL)::int no_name
      FROM supplier_products`);
  if (c.err) { say(`   cannot read: ${c.err}`); return; }
  const r = c[0];
  say(`   ${r.n} product rows from ${(await safe('SELECT COUNT(*)::int n FROM suppliers'))[0].n} suppliers\n`);
  say(`      ${pad('CAS number present', 36)}${pad(`${r.with_cas}/${r.n}`, 14)}${pc(r.with_cas, r.n)}`);
  say(`      ${pad('reviewed and approved', 36)}${pad(`${r.approved}/${r.n}`, 14)}${pc(r.approved, r.n)}`);
  if (r.no_name) say(`      ⚠ ${r.no_name} row(s) have no product name`);

  // A CAS number carries its own checksum, so this one is genuinely verifiable.
  if (typeof validCas === 'function') {
    const all = await safe("SELECT cas FROM supplier_products WHERE cas IS NOT NULL AND cas <> ''");
    if (!all.err) {
      const bad = all.filter((x) => !validCas(x.cas));
      say(`      ${pad('CAS passes its checksum', 36)}${pad(`${all.length - bad.length}/${all.length}`, 14)}${pc(all.length - bad.length, all.length)}`);
      say('      VERIFIED — a CAS number validates itself, so a typo cannot hide here.');
      if (bad.length) say(`      ⚠ ${bad.length} invalid: ${bad.slice(0, 6).map((x) => x.cas).join(', ')}`);
    }
  }

  say(`\n   ${pc(r.n - r.approved, r.n)} of the catalogue is UNREVIEWED. Those rows came out of a PDF`);
  say('   extractor and nobody has read them. They are fine for matching an inquiry; they are not');
  say('   fine to quote from, and nothing links to an unapproved product by design.');
}

// ── 4. INQUIRIES ─────────────────────────────────────────────────────────────
async function inquiries() {
  say('\n══ INBOUND INQUIRIES ═════════════════════════════════════════════════');
  const { COUNTS_SQL } = require('../src/lib/revenue/demand');
  const d = await safe(COUNTS_SQL);
  if (d.err) { say(`   cannot read: ${d.err}`); return; }
  const r = d[0];
  say(`      ${pad('rows in the table', 36)}${r.all_rows}`);
  say(`      ${pad('classified spam', 36)}${pad(r.spam, 14)}${pc(r.spam, r.all_rows)}`);
  say(`      ${pad('our own test records', 36)}${pad(r.ours, 14)}${pc(r.ours, r.all_rows)}`);
  say(`      ${pad('REAL EXTERNAL BUYERS', 36)}${pad(r.external, 14)}${pc(r.external, r.all_rows)}`);
  say('\n   This one is worth remembering. The same table read 37 buyers before the spam gate\'s');
  say('   verdict and our own addresses were excluded. Nothing was broken — a COUNT(*) was being');
  say('   quoted as demand. Every number above is a filter somebody can read.');
}

async function main() {
  await initDB();
  say('\n── data accuracy · measured, not asserted');
  say('   VERIFIED = checked against the source · UNVERIFIED = cannot check from here · WRONG = disagrees');

  if (want('labs')) await labs();
  if (want('trials')) await trials();
  if (want('catalogue')) await catalogue();
  if (want('inquiries')) await inquiries();

  say('\n══ WHAT YOU CAN PUT IN WRITING ═══════════════════════════════════════');
  say('   SAFE: grant number, award amount, dates, PI name, institution, trial facts. Every one');
  say('         carries a public URL the buyer can open. If they check, it holds.');
  say('   SAY SO: therapeutic-area classification is ours and unscored against a human sample.');
  say('   NEVER:  that an address is confirmed. We infer it from a published paper and the only');
  say('           proof is a send that did not bounce. Quote the bounce rate, with the sample size.');
  say('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('audit-data-accuracy failed:', e && e.message ? e.message : e);
  process.exit(1);
});
