#!/usr/bin/env node
// ── THE PRODUCT, AS A QUERY: WHAT A LEAD ACTUALLY CONTAINS TODAY ──────────────
//
//   railway ssh 'node scripts/demand-leads.js'                      → what the data can support
//   railway ssh 'node scripts/demand-leads.js --ta=Oncology --phase=2,3 --country=US --limit=10'
//   railway ssh 'node scripts/demand-leads.js --with-contacts'       → only studies we can name somebody at
//   railway ssh 'node scripts/demand-leads.js --csv'                 → the sample as CSV
//
// Read-only. Writes nothing.
//
// ── WHY THIS IS THE FIRST THING TO BUILD, NOT THE LOGIN PAGE ─────────────────
//
// Twelve vendors at SCOPE took Naren's card for a lead subscription. The instinct is to build the
// thing he described — onboarding, company profile, credentials, tiers at 10/20/100 leads a month.
// That is several weeks of work, and at the end of it he still would not know the one thing that
// decides whether the business exists: whether the data can produce a lead a vendor would pay for.
//
// This produces the lead. Nothing else. If ten rows out of it make a Clinical Operations buyer
// say "yes, those are prospects", there is a product and the platform is worth building. If they
// are thin, no amount of onboarding UI rescues it — and we find that out this morning rather than
// in November.
//
// ── IT REPORTS WHAT IS MISSING AS LOUDLY AS WHAT IS THERE ────────────────────
//
// A lead with no named contact is a company name a vendor could have found themselves, so the
// coverage numbers are printed first: how many studies, how many resolve to an organisation, how
// many of those have a person, how many of those a verified email. That ratio IS the product's
// quality, and it is better to know it before quoting a price.
//
// And one field in the SCOPE pitch does not exist: which EDC, eTMF or CTMS a study uses. There is
// no column for it and nothing collects it. It is named here so nobody sells it by accident.
'use strict';

const { initDB, query } = require('../src/lib/db');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const TA = arg('ta', null);
const PHASES = (arg('phase', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const COUNTRY = arg('country', null);
const SPONSOR_TYPE = arg('sponsor-type', null);
const SINCE = arg('since', null);               // YYYY-MM-DD on last_update_post_date
const LIMIT = Math.max(1, Math.min(200, parseInt(arg('limit', '10'), 10) || 10));
const WITH_CONTACTS = process.argv.includes('--with-contacts');
const CSV = process.argv.includes('--csv');

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  await initDB();

  // ── 1. COVERAGE: THE PRODUCT'S QUALITY, BEFORE ANY SAMPLE ────
  const cov = (await query(`
    SELECT
      COUNT(*)::int                                                          AS studies,
      COUNT(*) FILTER (WHERE therapeutic_area IS NOT NULL)::int              AS classified,
      COUNT(*) FILTER (WHERE resolved_organization_id IS NOT NULL)::int       AS org_resolved,
      COUNT(DISTINCT lead_sponsor_name)::int                                 AS distinct_sponsors,
      COUNT(*) FILTER (WHERE last_update_post_date >= to_char(NOW() - INTERVAL '30 days', 'YYYY-MM-DD'))::int AS updated_30d
    FROM clinical_studies`)).rows[0];

  const contactCov = (await query(`
    SELECT COUNT(DISTINCT cs.id)::int AS studies_with_contact,
           COUNT(DISTINCT cs.id) FILTER (WHERE rc.email IS NOT NULL AND rc.email <> '')::int AS studies_with_email,
           COUNT(DISTINCT cs.id) FILTER (WHERE rc.email_status = 'verified')::int AS studies_with_verified
      FROM clinical_studies cs
      JOIN research_contacts rc ON rc.organization_id = cs.resolved_organization_id`)).rows[0];

  if (!CSV) {
    console.log('── clinical demand intelligence · what a lead can contain today\n');
    console.log(`   studies ingested            ${cov.studies}`);
    console.log(`   classified (therapeutic area) ${cov.classified}`);
    console.log(`   distinct sponsors           ${cov.distinct_sponsors}`);
    console.log(`   updated in the last 30 days ${cov.updated_30d}   ← this is the "live" supply`);
    console.log(`   resolved to an organisation ${cov.org_resolved}`);
    console.log(`   …of those, with a person    ${contactCov.studies_with_contact}`);
    console.log(`   …with an email              ${contactCov.studies_with_email}`);
    console.log(`   …with a VERIFIED email      ${contactCov.studies_with_verified}\n`);

    const sellable = contactCov.studies_with_email;
    console.log(`   A lead with no named contact is a company name the vendor could have found`);
    console.log(`   themselves. On today's data, ${sellable} stud${sellable === 1 ? 'y' : 'ies'} can carry a person with an`);
    console.log(`   email — that number, not the ${cov.studies} total, is what a subscription can be sold against.\n`);

    // Role mix matters: an EDC vendor wants Clinical Operations and Data Management, and the
    // enrichment so far was aimed at procurement and R&D for Abiozen's own molecule sourcing.
    const roles = (await query(
      `SELECT role_category, COUNT(*)::int n FROM research_contacts GROUP BY role_category ORDER BY n DESC`)).rows;
    if (roles.length) {
      console.log(`   contacts by role: ${roles.map((r) => `${r.role_category || 'null'} ${r.n}`).join(' · ')}`);
      console.log(`   ⚠ role_category is constrained to procurement | rd_cmc | other — built for`);
      console.log(`     sourcing molecules. An EDC or eTMF vendor wants Clinical Operations, Data`);
      console.log(`     Management, Head of Clinical Systems. Those categories cannot even be stored`);
      console.log(`     yet: the CHECK constraint would reject them.\n`);
    }
    console.log(`   ⚠ NOT AVAILABLE: which EDC / eTMF / CTMS a study uses. No column holds it and`);
    console.log(`     nothing collects it. It was in the SCOPE pitch; it cannot be delivered today.\n`);
  }

  // ── 2. THE SAMPLE ────
  const where = ['1=1'];
  const params = [];
  if (TA) { params.push(`%${TA}%`); where.push(`cs.therapeutic_area ILIKE $${params.length}`); }
  if (COUNTRY) { params.push(`%${COUNTRY}%`); where.push(`cs.locations_countries ILIKE $${params.length}`); }
  if (SPONSOR_TYPE) { params.push(`%${SPONSOR_TYPE}%`); where.push(`cs.sponsor_type ILIKE $${params.length}`); }
  if (SINCE) { params.push(SINCE); where.push(`cs.last_update_post_date >= $${params.length}`); }
  if (PHASES.length) {
    const ors = PHASES.map((p) => { params.push(`%${p}%`); return `cs.phase ILIKE $${params.length}`; });
    where.push(`(${ors.join(' OR ')})`);
  }
  if (WITH_CONTACTS) where.push(`rc.id IS NOT NULL`);
  params.push(LIMIT);

  const rows = (await query(`
    SELECT cs.nct_id, cs.brief_title, cs.phase, cs.overall_status, cs.therapeutic_area,
           cs.disease, cs.lead_sponsor_name, cs.sponsor_type, cs.institution,
           cs.enrollment_count, cs.locations_countries, cs.start_date,
           cs.last_update_post_date,
           ro.display_name AS org, ro.primary_domain AS domain, ro.website_url,
           rc.full_name AS contact, rc.title AS contact_title, rc.email, rc.email_status,
           rc.linkedin_url
      FROM clinical_studies cs
      LEFT JOIN research_organizations ro ON ro.id = cs.resolved_organization_id
      LEFT JOIN research_contacts rc ON rc.organization_id = cs.resolved_organization_id
     WHERE ${where.join(' AND ')}
     ORDER BY cs.last_update_post_date DESC NULLS LAST
     LIMIT $${params.length}`, params)).rows;

  const HEADER = ['NCT', 'Study', 'Phase', 'Status', 'Therapeutic area', 'Sponsor', 'Sponsor type',
    'Institution', 'Enrollment', 'Countries', 'Last update', 'Organisation', 'Domain',
    'Contact', 'Title', 'Email', 'Email status', 'LinkedIn'];

  if (CSV) {
    console.log(HEADER.map(csvCell).join(','));
    for (const r of rows) {
      console.log([r.nct_id, r.brief_title, r.phase, r.overall_status, r.therapeutic_area,
        r.lead_sponsor_name, r.sponsor_type, r.institution, r.enrollment_count,
        r.locations_countries, r.last_update_post_date, r.org, r.domain,
        r.contact, r.contact_title, r.email, r.email_status, r.linkedin_url]
        .map(csvCell).join(','));
    }
    return;
  }

  console.log(`── sample · ${rows.length} lead(s)`
    + `${TA ? ` · ${TA}` : ''}${PHASES.length ? ` · phase ${PHASES.join('/')}` : ''}`
    + `${COUNTRY ? ` · ${COUNTRY}` : ''}${WITH_CONTACTS ? ' · named contact only' : ''}\n`);

  if (!rows.length) {
    console.log('   nothing matched. Loosen the filters, or the pipeline has not ingested this segment.\n');
    return;
  }

  for (const r of rows) {
    console.log(`   ${r.nct_id}  ${r.phase || 'phase n/a'}  ·  ${r.overall_status || 'status n/a'}`);
    console.log(`      ${(r.brief_title || '').slice(0, 110)}`);
    console.log(`      ${r.therapeutic_area || 'unclassified'}${r.disease ? ` — ${r.disease}` : ''}`);
    console.log(`      sponsor    ${r.lead_sponsor_name || '(none)'}${r.sponsor_type ? ` (${r.sponsor_type})` : ''}`);
    if (r.institution) console.log(`      site       ${r.institution}`);
    console.log(`      where      ${r.locations_countries || '(not stated)'}`
      + `${r.enrollment_count ? ` · n=${r.enrollment_count}` : ''}`);
    console.log(`      updated    ${r.last_update_post_date || '(unknown)'}`);
    if (r.org) console.log(`      org        ${r.org}${r.domain ? ` · ${r.domain}` : ''}`);
    if (r.contact) {
      console.log(`      CONTACT    ${r.contact}${r.contact_title ? ` — ${r.contact_title}` : ''}`);
      console.log(`                 ${r.email || '(no email)'}`
        + `${r.email_status ? ` [${r.email_status}]` : ''}`);
    } else {
      console.log(`      CONTACT    none — this row is a company name, not a lead`);
    }
    console.log();
  }

  const named = rows.filter((r) => r.contact).length;
  console.log(`   ${named} of ${rows.length} carry a named person.`);
  console.log(`   Judge these as a Clinical Operations buyer would: would you pay monthly for 20 of them?\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('demand-leads failed:', e && e.message ? e.message : e);
  process.exit(1);
});
