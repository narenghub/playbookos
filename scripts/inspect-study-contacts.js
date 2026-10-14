#!/usr/bin/env node
// ── WHAT CONTACT DATA DOES THE REGISTRY ITSELF GIVE US? ───────────────────────
//
//   railway ssh 'node scripts/inspect-study-contacts.js'
//   railway ssh 'node scripts/inspect-study-contacts.js --nct=NCT06676579'
//
// Read-only. Reports structure and counts; prints no personal data.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// The lead sample on 14 Oct was unusable: "eleva GmbH" (a German biotech) had been resolved to
// "Escola Eleva", a Brazilian school, with two Purchasing Analysts attached and their emails marked
// verified. Johns Hopkins resolved to its business school. Mayo Clinic resolved to Mayo Clinic
// Laboratories and returned marketing and supply-chain staff. Only 293 of 3,287 studies resolved at
// all, and the ones that did were often to the wrong company.
//
// The cause is that contacts come from fuzzy company-name matching in Apollo, which was the right
// approach for finding a procurement head at an API manufacturer and is the wrong approach here.
//
// ClinicalTrials.gov publishes its OWN contacts per study — central contacts and per-location
// contacts. We store the full record in clinical_studies.raw_json, so if those fields are present
// they are already in the database, unparsed, and they name the person actually attached to the
// trial rather than somebody who shares a word with the sponsor's name.
//
// This counts what is there. It deliberately prints NO names, emails or phone numbers — the
// question is coverage and structure, and an audit script does not need to copy personal data into
// a terminal to answer it. A redacted shape is shown instead.
'use strict';

const { initDB, query } = require('../src/lib/db');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const NCT = arg('nct', null);
const SAMPLE = Math.max(1, Math.min(2000, parseInt(arg('sample', '400'), 10) || 400));

const redact = (v) => {
  if (v == null) return null;
  const s = String(v);
  if (!s) return '';
  if (s.includes('@')) return `<email ${s.length} chars>`;
  if (/^[+\d][\d\s().-]{6,}$/.test(s)) return `<phone>`;
  return `<${s.length} chars>`;
};

function contactsOf(raw) {
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
  if (!j) return null;
  // The v2 API shape; the legacy shape is checked as a fallback.
  const ps = j.protocolSection || j;
  const contactsModule = ps.contactsLocationsModule || ps.contacts_locations_module || {};
  const central = contactsModule.centralContacts || contactsModule.central_contacts || [];
  const locations = contactsModule.locations || [];
  const overall = contactsModule.overallOfficials || contactsModule.overall_officials || [];
  const locContacts = locations.flatMap((l) => l.contacts || []);
  return { central, overall, locations, locContacts };
}

async function main() {
  await initDB();

  if (NCT) {
    const r = (await query(`SELECT nct_id, lead_sponsor_name, raw_json FROM clinical_studies WHERE nct_id = $1`, [NCT])).rows[0];
    if (!r) { console.log(`✗ ${NCT} is not in the database.`); process.exit(1); }
    const c = contactsOf(r.raw_json);
    console.log(`\n── ${r.nct_id} · ${r.lead_sponsor_name}\n`);
    if (!c) { console.log('   raw_json is absent or unparseable.\n'); return; }
    console.log(`   centralContacts    ${c.central.length}`);
    for (const x of c.central) {
      console.log(`      role ${x.role || '(none)'} · name ${redact(x.name)} · email ${redact(x.email)} · phone ${redact(x.phone)}`);
    }
    console.log(`   overallOfficials   ${c.overall.length}`);
    for (const x of c.overall) {
      console.log(`      role ${x.role || '(none)'} · name ${redact(x.name)} · affiliation ${redact(x.affiliation)}`);
    }
    console.log(`   locations          ${c.locations.length}`
      + ` (with a contact: ${c.locations.filter((l) => (l.contacts || []).length).length})`);
    console.log(`   location contacts  ${c.locContacts.length}`);
    for (const x of c.locContacts.slice(0, 4)) {
      console.log(`      role ${x.role || '(none)'} · name ${redact(x.name)} · email ${redact(x.email)}`);
    }
    console.log('\n   Names, emails and phones are redacted on purpose: this answers coverage, and an');
    console.log('   audit does not need to copy personal data into a terminal to do that.\n');
    return;
  }

  const rows = (await query(
    `SELECT nct_id, raw_json FROM clinical_studies
      WHERE raw_json IS NOT NULL
      ORDER BY last_update_post_date DESC NULLS LAST LIMIT $1`, [SAMPLE])).rows;

  let parsed = 0, withCentral = 0, withCentralEmail = 0, withOfficial = 0, withLocContact = 0, withAnyEmail = 0;
  const roles = {};
  for (const r of rows) {
    const c = contactsOf(r.raw_json);
    if (!c) continue;
    parsed += 1;
    if (c.central.length) withCentral += 1;
    if (c.central.some((x) => x.email)) withCentralEmail += 1;
    if (c.overall.length) withOfficial += 1;
    if (c.locContacts.length) withLocContact += 1;
    if (c.central.some((x) => x.email) || c.locContacts.some((x) => x.email)) withAnyEmail += 1;
    for (const x of [...c.central, ...c.overall, ...c.locContacts]) {
      const k = x.role || '(none)';
      roles[k] = (roles[k] || 0) + 1;
    }
  }

  const pct = (n) => (parsed ? `${Math.round((n / parsed) * 1000) / 10}%` : 'n/a');
  console.log(`\n── registry-published contacts · newest ${rows.length} studies\n`);
  console.log(`   raw_json parsed            ${parsed} of ${rows.length}`);
  console.log(`   with a central contact     ${withCentral}  (${pct(withCentral)})`);
  console.log(`   …carrying an email         ${withCentralEmail}  (${pct(withCentralEmail)})`);
  console.log(`   with an overall official   ${withOfficial}  (${pct(withOfficial)})`);
  console.log(`   with a location contact    ${withLocContact}  (${pct(withLocContact)})`);
  console.log(`   with ANY contact email     ${withAnyEmail}  (${pct(withAnyEmail)})\n`);
  const top = Object.entries(roles).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) console.log(`   roles seen: ${top.map(([k, n]) => `${k} ${n}`).join(' · ')}\n`);

  console.log('   ⚠ READ BEFORE USING ANY OF THIS. These contacts are published so that PATIENTS and');
  console.log('     clinicians can enquire about taking part in a trial. Using them to sell software');
  console.log('     is a different purpose from the one they were published for — which in the EU is');
  console.log('     exactly the question a lawful basis has to answer, and in the US is the kind of');
  console.log('     thing a sponsor complains to the registry about. Coverage is a technical fact;');
  console.log('     whether we may use it is not, and is not settled by this script.\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('inspect-study-contacts failed:', e && e.message ? e.message : e);
  process.exit(1);
});
