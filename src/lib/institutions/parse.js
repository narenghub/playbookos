// ── Research institutions from ClinicalTrials.gov trial SITES — PURE parsing ──
//
// No network, no DB. The input is a study's raw_json, already in clinical_studies: the
// registry's full record, whose contactsLocationsModule carries one entry per participating
// site with facility, city, state, country AND a contacts array with name, phone and email.
//
// WHY THIS IS THE SOURCE. Every other route measured for this ICP fails at enrichment: Places
// cannot tell a CRO from big pharma, the FDA register only reaches manufacturers, and NIH
// RePORTER — which has the best addresses of any of them — carries no email field at all, at
// any level. ClinicalTrials.gov is the only one carrying institution, address and contact in a
// single record, and it is already ingested, so a pipeline is a parse rather than a fetch.
//
// NOT TO BE CONFUSED WITH research_organizations. That table holds 222 trial SPONSORS resolved
// through Apollo by the Research Intelligence agent — who is RUNNING a trial. This is the
// SITES, the institutions where trials are physically conducted, which is the thing that buys
// research chemicals. A sponsor is a pharma company; a site is a university hospital.

// ── ANONYMISED PLACEHOLDERS ──────────────────────────────────────────────────────
// Sponsors routinely redact site identity, and the redactions are the MOST common names in
// the data: "Research Site" appears against 813 studies, more than any real institution. They
// are not institutions and must never reach a target list — there is nobody to contact at
// "GSK Investigational Site".
const PLACEHOLDER = /(research|investigational|clinical|study|trial|local|recruiting)\s*(site|center|centre|facility)|^site\b|site\s*#?\s*\d|^investigator|^local institution|^clinical (trial|study)/i;

// ── FACILITY TYPE ────────────────────────────────────────────────────────────────
// Ordered: the FIRST match wins, most specific first. A "University Cancer Center" is a cancer
// centre before it is a university — that is the buying unit, and it has its own budget.
const TYPES = [
  ['cancer_centre', /(cancer|oncolog|tumou?r)\s*(cent|instit|hosp)|comprehensive cancer/i],
  ['academic',      /(universit|college|school of medicine|univ\b|universit(y|e|a|ä)t|universidad|université|università)/i],
  ['hospital',      /(hospital|medical cent|health system|clinic\b|klinik|ospedale|hôpital|hopital|hospita|infirmary|nhs)/i],
  ['institute',     /(institut|inserm|cnrs|max planck|fraunhofer|research council|academy of|akadem)/i],
];

/** Which ICP category, or 'other' when it matches none. Never throws. */
function facilityType(name) {
  const n = String(name || '');
  for (const [type, re] of TYPES) if (re.test(n)) return type;
  return 'other';
}

/** Is this an anonymised placeholder rather than a real institution? */
function isPlaceholder(name) {
  return PLACEHOLDER.test(String(name || '').trim());
}

/** The ICP: a real, named academic / hospital / cancer-centre / institute site. */
function isIcp(name) {
  return !!String(name || '').trim() && !isPlaceholder(name) && facilityType(name) !== 'other';
}

/**
 * Fold a facility name for grouping. Deliberately light: lowercase, strip punctuation and
 * collapse whitespace, and nothing else.
 *
 * NO generic-word stripping here, unlike the DMF matcher. There, "pharmaceuticals ltd" carried
 * no identity and had to go. Here "University" and "Hospital" ARE the identity — dropping them
 * would fold "Boston University" into "Boston Children's Hospital". The cost is that spelling
 * variants of one institution stay separate rows; that is the safer error for a list someone
 * will email.
 */
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Accepts the raw_json column (object or JSON string) and returns its location rows. */
function locationsOf(rawJson) {
  let o = rawJson;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (_) { return []; } }
  if (!o || typeof o !== 'object') return [];
  const mod = (o.protocolSection || o).contactsLocationsModule;
  return (mod && Array.isArray(mod.locations)) ? mod.locations : [];
}

/**
 * Collapse many studies' locations into one row per institution.
 *
 * studies: [{ raw_json, start_date }]  ->  Map(normalized -> institution)
 *
 * The contact kept is the FIRST one seen carrying an email. Sites list patient-recruitment
 * contacts and there can be several; taking the first with an address beats taking the first,
 * which is often a name with only a phone.
 */
function collectInstitutions(studies, { icpOnly = true } = {}) {
  const out = new Map();
  for (const st of studies || []) {
    const seen = new Date(st.start_date || st.first_posted_date || st.ingested_at || Date.now());
    const when = isNaN(seen.getTime()) ? null : seen;
    for (const L of locationsOf(st.raw_json)) {
      const name = String(L.facility || '').trim();
      if (!name) continue;
      if (icpOnly && !isIcp(name)) continue;
      const key = normalizeName(name);
      if (!key) continue;
      let e = out.get(key);
      if (!e) {
        e = { name, normalized: key, city: L.city || null, state: L.state || null,
              country: L.country || null, facility_type: facilityType(name),
              study_count: 0, contact_name: null, contact_email: null,
              first_seen: when, last_seen: when };
        out.set(key, e);
      }
      e.study_count++;
      if (when) {
        if (!e.first_seen || when < e.first_seen) e.first_seen = when;
        if (!e.last_seen || when > e.last_seen) e.last_seen = when;
      }
      if (!e.contact_email) {
        const c = (L.contacts || []).find(x => x && x.email);
        if (c) { e.contact_email = c.email; e.contact_name = c.name || null; }
      }
    }
  }
  return out;
}

module.exports = { PLACEHOLDER, TYPES, facilityType, isPlaceholder, isIcp, normalizeName, locationsOf, collectInstitutions };
