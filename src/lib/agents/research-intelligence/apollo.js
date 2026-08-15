// Clinical Demand Intelligence — Phase 3 Apollo.io wrapper (pure, never-throws).
//
// Three primitives for the on-demand contact-enrichment flow (probe-verified
// against the live API 2026-08-15):
//   searchOrganizations → POST /mixed_companies/search  (1 credit/page) — disambiguation candidates
//   searchContactsByOrg → POST /mixed_people/api_search (FREE)          — id/title/dept/linkedin ONLY
//   enrichContact       → POST /people/match            (~1 credit)     — reveals name+email+phone
//
// IMPORTANT: `mixed_people/search` is DEPRECATED for API callers (HTTP 422) — we
// use `mixed_people/api_search`. api_search REDACTS name + email (revealed only by
// enrichContact). `primary_phone` and `phone_numbers[]` are OBJECTS — extract .number.
//
// Every function never throws: returns { ...data, credits_used } on success or
// { error, credits_used } on any failure. The caller (route/orchestrator) decides.

const APOLLO_BASE = 'https://api.apollo.io/api/v1';
const ORG_SEARCH = '/mixed_companies/search';
const PEOPLE_SEARCH = '/mixed_people/api_search'; // NOT the deprecated /mixed_people/search
const PEOPLE_ENRICH = '/people/match';

// Role → title filters (locked in the Phase 3 spec).
const PROCUREMENT_TITLES = ['Procurement', 'Sourcing', 'Supply Chain', 'Purchasing', 'Vendor Management', 'API Sourcing'];
const RD_CMC_TITLES = ['CMC', 'Drug Substance', 'API Development', 'Chemistry Manufacturing Controls', 'Process Chemistry', 'Head of R&D', 'VP R&D'];

// Apollo phone fields are objects ({ number, ... }) — pull the raw number string.
function phoneNumber(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.number || v.raw_number || v.sanitized_number || null;
}

async function apolloPost(path, body, apiKey) {
  const res = await fetch(APOLLO_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey, 'Cache-Control': 'no-cache' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

// Org disambiguation candidates by (normalized) name. 1 credit/page.
async function searchOrganizations(queryName, { perPage = 5, apiKey = process.env.APOLLO_API_KEY } = {}) {
  if (!apiKey) return { error: 'APOLLO_API_KEY not configured', credits_used: 0 };
  const q = String(queryName || '').trim();
  if (!q) return { organizations: [], credits_used: 0 };
  const per = Math.min(10, Math.max(1, perPage));
  let r;
  try { r = await apolloPost(ORG_SEARCH, { q_organization_name: q, per_page: per }, apiKey); }
  catch (e) { return { error: 'Apollo org search failed: ' + e.message, credits_used: 0 }; }
  if (!r.ok) return { error: `Apollo org search ${r.status}: ${(r.text || '').slice(0, 200)}`, credits_used: 0 };
  const raw = (r.json && (r.json.organizations || r.json.accounts)) || [];
  const organizations = raw.slice(0, perPage).map(o => ({
    apollo_org_id: o.id || null,
    name: o.name || null,
    primary_domain: o.primary_domain || null,
    website_url: o.website_url || null,
    linkedin_url: o.linkedin_url || null,
    primary_phone: phoneNumber(o.primary_phone),
    estimated_num_employees: (typeof o.estimated_num_employees === 'number') ? o.estimated_num_employees : null,
    logo_url: o.logo_url || null,
    founded_year: (typeof o.founded_year === 'number') ? o.founded_year : null,
  })).filter(o => o.apollo_org_id);
  return { organizations, credits_used: 1 };
}

// Contacts at an org filtered by role titles. FREE (no credit). Returns
// id/title/department/linkedin ONLY — name + email come from enrichContact.
async function searchContactsByOrg(apolloOrgId, { titles = [], perPage = 10, apiKey = process.env.APOLLO_API_KEY } = {}) {
  if (!apiKey) return { error: 'APOLLO_API_KEY not configured', credits_used: 0 };
  if (!apolloOrgId) return { error: 'apolloOrgId required', credits_used: 0 };
  const body = { organization_ids: [apolloOrgId], per_page: Math.min(25, Math.max(1, perPage)) };
  if (Array.isArray(titles) && titles.length) body.person_titles = titles;
  let r;
  try { r = await apolloPost(PEOPLE_SEARCH, body, apiKey); }
  catch (e) { return { error: 'Apollo people search failed: ' + e.message, credits_used: 0 }; }
  if (!r.ok) return { error: `Apollo people search ${r.status}: ${(r.text || '').slice(0, 200)}`, credits_used: 0 };
  const raw = (r.json && (r.json.people || r.json.contacts)) || [];
  const contacts = raw.map(p => ({
    apollo_contact_id: p.id || null,
    title: p.title || null,
    department: (Array.isArray(p.departments) && p.departments.length) ? p.departments[0] : (p.department || null),
    linkedin_url: p.linkedin_url || null,
  })).filter(c => c.apollo_contact_id);
  return { contacts, credits_used: 0 };
}

// Reveal one contact's name/email/email_status/phone. ~1 credit.
async function enrichContact(apolloContactId, { apiKey = process.env.APOLLO_API_KEY } = {}) {
  if (!apiKey) return { error: 'APOLLO_API_KEY not configured', credits_used: 0 };
  if (!apolloContactId) return { error: 'apolloContactId required', credits_used: 0 };
  let r;
  try { r = await apolloPost(PEOPLE_ENRICH, { id: apolloContactId }, apiKey); }
  catch (e) { return { error: 'Apollo enrich failed: ' + e.message, credits_used: 0 }; }
  if (!r.ok) return { error: `Apollo enrich ${r.status}: ${(r.text || '').slice(0, 200)}`, credits_used: 0 };
  const p = (r.json && r.json.person) || null;
  if (!p) return { error: 'Apollo enrich returned no person', credits_used: 1 };
  const rawEmail = p.email || null;
  const email = (rawEmail && !/email_not_unlocked/i.test(rawEmail)) ? rawEmail : null; // Apollo masks locked emails
  const contact = {
    apollo_contact_id: p.id || apolloContactId,
    full_name: p.name || null,
    first_name: p.first_name || null,
    last_name: p.last_name || null,
    title: p.title || null,
    email,
    email_status: p.email_status || null,
    phone: phoneNumber(p.phone_numbers && p.phone_numbers[0]) || phoneNumber(p.sanitized_phone),
    linkedin_url: p.linkedin_url || null,
    organization_name: (p.organization && p.organization.name) || p.organization_name || null,
  };
  return { contact, credits_used: 1 };
}

module.exports = {
  searchOrganizations, searchContactsByOrg, enrichContact,
  PROCUREMENT_TITLES, RD_CMC_TITLES,
  APOLLO_BASE, ORG_SEARCH, PEOPLE_SEARCH, PEOPLE_ENRICH,
};
