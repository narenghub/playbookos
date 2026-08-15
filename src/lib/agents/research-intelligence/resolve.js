// Clinical Demand Intelligence — Phase 3 resolve orchestrator (contact enrichment).
//
// Ties normalize + apollo together and owns persistence into research_organizations /
// research_contacts. On-demand only (a user clicks "Find Contacts"). Never-throws:
// each function returns a summary object with { error } / { errors:[] } on failure.
//
// Two resolution tiers (auto-guess deferred to a later phase — not enough signal):
//   Tier A  findOrgCandidates(sponsor)  — name search + first-token fallback → candidates
//                                          for the UI disambiguation picker (no DB write)
//   Tier B  resolveByDomain(domain)      — user-typed domain → canonical HQ (single result)
// Then: persistResolvedOrg(pick) upserts the org + links the study, and
//       findAndEnrichContacts(org) pulls + enriches up to 2 procurement + 2 R&D contacts
//       (hard cap 4 enrichment credits per call — locked Decision B).
const crypto = require('crypto');
const { query } = require('../../db');
const { normalize, firstToken } = require('./normalize');
const apollo = require('./apollo');

const MAX_PER_ROLE = 2; // 2 procurement + 2 R&D = max 4 enrichment credits / Find-Contacts click

// Tier A — get org candidates for the disambiguation picker. No DB writes. Never-throws.
// Returns { candidates, resolution, credits_used[, error] }. resolution = audit metadata.
async function findOrgCandidates(sponsorName, opts = {}) {
  const original = String(sponsorName || '').trim();
  const normalized = normalize(original);
  const resolution = {
    original_sponsor_name: original, normalized_query: normalized, query_used: normalized,
    fallback_fired: false, candidates_shown: 0, no_candidates: false,
  };
  if (!normalized) { resolution.no_candidates = true; return { candidates: [], resolution, credits_used: 0 }; }

  let credits = 0;
  let res = await apollo.searchOrganizations(normalized, { perPage: 5, ...opts });
  credits += res.credits_used || 0;
  if (res.error) return { candidates: [], resolution, credits_used: credits, error: res.error };

  // Tier-A fallback — first token (Apollo partial-match fails when the query has more
  // words than the indexed org name, e.g. "alnylam pharmaceuticals" → 0).
  if (!res.organizations.length) {
    const ft = firstToken(normalized);
    if (ft && ft !== normalized) {
      resolution.fallback_fired = true; resolution.query_used = ft;
      res = await apollo.searchOrganizations(ft, { perPage: 5, ...opts });
      credits += res.credits_used || 0;
      if (res.error) return { candidates: [], resolution, credits_used: credits, error: res.error };
    }
  }
  const candidates = res.organizations || [];
  resolution.candidates_shown = candidates.length;
  resolution.no_candidates = candidates.length === 0;
  return { candidates, resolution, credits_used: credits };
}

// Tier B — user-typed domain → single canonical org (skips disambiguation). Never-throws.
async function resolveByDomain(domain, opts = {}) {
  const res = await apollo.enrichOrganizationByDomain(domain, opts);
  const resolution = {
    original_sponsor_name: null, normalized_query: null, query_used: 'domain:' + String(domain || '').trim().toLowerCase(),
    fallback_fired: false, candidates_shown: res.organization ? 1 : 0, no_candidates: !res.organization, manual_domain: true,
  };
  if (res.error) return { organization: null, resolution, credits_used: res.credits_used || 0, error: res.error };
  return { organization: res.organization || null, resolution, credits_used: res.credits_used || 0 };
}

// Persist the chosen org (upsert by apollo_org_id) + link the study. Never-throws.
// `org` is a candidate/enriched org record; `resolution` is the audit metadata JSON.
async function persistResolvedOrg({ studyId, org, resolution = null, userSelectedIndex = null }, { queryFn = query } = {}) {
  if (!org || !org.apollo_org_id) return { error: 'org with apollo_org_id required' };
  const meta = resolution ? JSON.stringify({ ...resolution, user_selected_index: userSelectedIndex }) : null;
  try {
    const ins = await queryFn(
      `INSERT INTO research_organizations
        (id, apollo_org_id, normalized_name, display_name, primary_domain, website_url, linkedin_url, primary_phone, founded_year, logo_url, resolution_metadata, last_enriched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (apollo_org_id) DO UPDATE SET
         display_name=EXCLUDED.display_name, primary_domain=EXCLUDED.primary_domain, website_url=EXCLUDED.website_url,
         linkedin_url=EXCLUDED.linkedin_url, primary_phone=EXCLUDED.primary_phone, founded_year=EXCLUDED.founded_year,
         logo_url=EXCLUDED.logo_url, last_enriched_at=NOW()
       RETURNING id`,
      [crypto.randomUUID(), org.apollo_org_id, org.normalized_name || null, org.name || null, org.primary_domain || null,
       org.website_url || null, org.linkedin_url || null, org.primary_phone || null,
       (typeof org.founded_year === 'number') ? org.founded_year : null, org.logo_url || null, meta]
    );
    const organizationId = ins.rows[0].id;
    if (studyId) await queryFn(`UPDATE clinical_studies SET resolved_organization_id=$1 WHERE id=$2`, [organizationId, studyId]);
    return { organization_id: organizationId };
  } catch (e) { return { error: e.message }; }
}

// Find + enrich up to MAX_PER_ROLE procurement + MAX_PER_ROLE R&D contacts for the org
// and persist them. Search is free; each enrichment ~1 credit (hard cap 2+2=4). Never-throws.
// Returns { contacts, credits_used, errors }.
async function findAndEnrichContacts({ organizationId, apolloOrgId }, { queryFn = query, maxPerRole = MAX_PER_ROLE } = {}) {
  const summary = { contacts: [], credits_used: 0, errors: [] };
  if (!organizationId || !apolloOrgId) { summary.errors.push('organizationId + apolloOrgId required'); return summary; }

  const roles = [
    { role: 'procurement', titles: apollo.PROCUREMENT_TITLES },
    { role: 'rd_cmc', titles: apollo.RD_CMC_TITLES },
  ];
  for (const { role, titles } of roles) {
    const sc = await apollo.searchContactsByOrg(apolloOrgId, { titles, perPage: 10 });
    summary.credits_used += sc.credits_used || 0;
    if (sc.error) { summary.errors.push(`${role} search: ${sc.error}`); continue; }

    for (const cand of (sc.contacts || []).slice(0, maxPerRole)) {
      const en = await apollo.enrichContact(cand.apollo_contact_id);
      summary.credits_used += en.credits_used || 0;
      if (en.error) { summary.errors.push(`${role} enrich ${cand.apollo_contact_id}: ${en.error}`); continue; }
      const ct = en.contact;
      try {
        await queryFn(
          `INSERT INTO research_contacts
            (id, organization_id, apollo_contact_id, full_name, first_name, last_name, title, email, email_status, phone, linkedin_url, department, role_category, enriched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
           ON CONFLICT (apollo_contact_id) DO UPDATE SET
             full_name=EXCLUDED.full_name, email=EXCLUDED.email, email_status=EXCLUDED.email_status,
             phone=EXCLUDED.phone, title=EXCLUDED.title, role_category=EXCLUDED.role_category, enriched_at=NOW()`,
          [crypto.randomUUID(), organizationId, ct.apollo_contact_id, ct.full_name, ct.first_name, ct.last_name,
           ct.title || cand.title, ct.email, ct.email_status, ct.phone, ct.linkedin_url || cand.linkedin_url, cand.department, role]
        );
        summary.contacts.push({ ...ct, role_category: role, department: cand.department });
      } catch (e) { summary.errors.push(`${role} persist ${cand.apollo_contact_id}: ${e.message}`); }
    }
  }
  return summary;
}

module.exports = { findOrgCandidates, resolveByDomain, persistResolvedOrg, findAndEnrichContacts, MAX_PER_ROLE };
