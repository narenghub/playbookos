'use strict';
// ── PULLING A CONTACT OUT OF AFFILIATION PROSE ───────────────────────────────
//
// Europe PMC has no email field. The probe walked three topics and found addresses in exactly one
// dominant place: inside the free text of
//
//     authorList.author[].authorAffiliationDetailsList.authorAffiliation[].affiliation
//
// 41 of 50 records on one topic, 36 on another. The paper-level `affiliation` string carries a few
// more. Nothing lives in a field called email, which is why this is parsed rather than read: had
// the ingest been written against the field name I expected, every row would have stored NULL and
// reported success.
//
// So this module is prose parsing, and prose parsing is where quiet corruption comes from — the
// catalogue extractor taught us that by producing a plausible, broken CAS number for a whole
// supplier list. Everything here is therefore pure and tested against real strings copied from the
// probe output, not invented ones. Hand-made fixtures are the reason nineteen passing tests missed
// the kerning bug.
//
// ── THE ATTRIBUTION PROBLEM ──────────────────────────────────────────────────
//
// An address found in author X's own affiliation details belongs to author X. An address in the
// paper-level affiliation string belongs to SOMEBODY — usually the corresponding author, but the
// field does not say. Mailing the wrong person is not a cosmetic error: it is a stranger receiving
// commercial mail about work that is not theirs, from a domain whose reputation we cannot spend.
//
// So attribution is earned, never assumed. attributeEmail() matches the local part against the
// author's surname, given name or initials, and returns null when it cannot. A person we cannot
// name is stored without an address rather than guessed at.

// Addresses in prose arrive wrapped: "Electronic address: a@b.com.", "e-mail: a@b.com;",
// "(a@b.com)". Capture generously, then strip the wrapping — the alternative is a trailing full
// stop silently becoming part of the domain, which bounces and looks like a bad list.
const EMAIL_IN_TEXT = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TRIM_EDGES = /^[.,;:()[\]{}<>"'\s]+|[.,;:()[\]{}<>"'\s]+$/g;

function cleanEmail(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(TRIM_EDGES, '');
  // A sentence-ending period lands inside the TLD: "...@ox.ac.uk." -> strip it, but never strip a
  // dot that belongs to the domain.
  while (/\.$/.test(s)) s = s.slice(0, -1);
  s = s.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(s)) return null;
  // Local part must not start or end with a dot, which is what "address:.a@b.com" leaves behind.
  const [local, domain] = s.split('@');
  if (!local || /^\.|\.$|\.\./.test(local)) return null;
  if (/^-|-$/.test(domain.split('.')[0])) return null;
  return s;
}

// Everything that looks like an address in a blob of text, de-duplicated, order preserved.
function extractEmails(text) {
  const out = [];
  const seen = new Set();
  const s = String(text == null ? '' : text);
  for (const m of s.match(EMAIL_IN_TEXT) || []) {
    const e = cleanEmail(m);
    if (e && !seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

// Affiliation strings are comma-separated from most specific to least:
//   "Department of Chemistry, University of Delaware, Newark, DE 19716, United States."
// So the institution is the segment naming an organisation, and the department is the segment
// naming a unit. Taking the whole string would make every row unique and defeat grouping.
const ORG_WORDS = /\b(universit|instituto|institut|college|hospital|cancer cent|centre|center|school|academy|laborator|clinic|foundation|polytechnic|kmitl|cnrs|inserm|csic|max planck|chinese academy)/i;
const DEPT_WORDS = /^\s*(depart|dept\b|division|school of|centre of|center for|centre for|institute of|laborator|unit of|faculty of|state key)/i;

function segments(text) {
  return String(text == null ? '' : text)
    // the email and its label are not part of the address
    .replace(/\b(e-?mail|electronic address|email address)\s*:?/gi, ' ')
    .replace(EMAIL_IN_TEXT, ' ')
    .split(/[,;]/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function institutionFrom(text) {
  const segs = segments(text);
  // Prefer a segment that names an organisation but is NOT a department — "Department of
  // Chemistry" contains no organisation, "University of Delaware" does. Where several match, the
  // LAST is the parent body: "Centre of Chemistry of University of Minho" resolves to the
  // university, not the centre.
  const orgs = segs.filter((s) => ORG_WORDS.test(s) && !DEPT_WORDS.test(s));
  if (orgs.length) return orgs[orgs.length - 1];
  const any = segs.filter((s) => ORG_WORDS.test(s));
  return any.length ? any[any.length - 1] : (segs[0] || null);
}

function departmentFrom(text) {
  const seg = segments(text).find((s) => DEPT_WORDS.test(s));
  return seg || null;
}

// Grouping key. Institutions are written a dozen ways; without this every spelling is its own
// customer. Mirrors the normalisation already used for study_sites so the two can be joined.
function normalizeInstitution(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|of|at|for|de|du|des|der|und)\b/g, ' ')
    .replace(/\b(univ)\b/g, 'university')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizePerson(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// ── EARNED ATTRIBUTION ───────────────────────────────────────────────────────
// Return the matching author, or null. Local parts seen in the probe output:
//   t.tan@imperial.ac.uk        initial + surname        -> Tricia Tan
//   priyankar.paira@vit.ac.in   given + surname          -> Priyankar Paira
//   duangkamol.gl@kmitl.ac.th   given + initials         -> Duangkamol (Thai given-name order)
//   blp@mit.edu                 initials only            -> B. L. P.
//   j.deanfield@ucl.ac.uk       initial + surname        -> John Deanfield
// A surname of three letters or fewer is not evidence on its own — "li@x.edu" would match every
// Li on the paper — so those require corroboration from the given name or initials.
function attributeEmail(email, authors) {
  const e = cleanEmail(email);
  if (!e || !Array.isArray(authors) || !authors.length) return null;
  const local = e.split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  const joined = local.replace(/[^a-z0-9]/g, '');

  const scored = [];
  for (const a of authors) {
    const last = normalizePerson(a.lastName || a.last_name || '').replace(/\s/g, '');
    const first = normalizePerson(a.firstName || a.first_name || a.initials || '').replace(/\s/g, '');
    if (!last && !first) continue;
    let score = 0;
    const hasLast = last && parts.includes(last);
    const hasFirst = first && parts.includes(first);
    if (hasLast) score += last.length > 3 ? 3 : 1;
    if (hasFirst) score += first.length > 3 ? 2 : 1;
    // initial + surname, written together or split
    if (last && first && (joined === first[0] + last || parts.includes(first[0]) && hasLast)) score += 2;
    // initials only: "blp" for B. L. P. — needs the surname initial to be in there
    if (!hasLast && !hasFirst && last && joined.length <= 4 && joined.includes(last[0])
        && first && joined.includes(first[0])) score += 1;
    if (score > 0) scored.push({ author: a, score });
  }
  if (!scored.length) return null;
  scored.sort((x, y) => y.score - x.score);
  // Ambiguity is a reason to decline, not to pick the first. Two authors scoring equally means we
  // cannot say whose address this is.
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  if (scored[0].score < 2) return null;
  return scored[0].author;
}

module.exports = {
  cleanEmail, extractEmails, institutionFrom, departmentFrom,
  normalizeInstitution, normalizePerson, attributeEmail,
};

// ── THE INSTITUTION KEYWORD ──────────────────────────────────────────────────
// RePORTER writes "LOUISIANA STATE UNIV A&M COL BATON ROUGE". No published paper has ever
// contained that string, which is why AFF:"<org verbatim>" returned zero hits for all five PIs
// probed. What a paper DOES contain is the distinctive word: "Louisiana". One word, because the
// affiliation index holds the publisher's spelling and we cannot predict the rest of it.
const ORG_STOP = new Set(['university', 'universite', 'of', 'at', 'the', 'college', 'and', 'state',
  'univ', 'medical', 'center', 'centre', 'school', 'institute', 'hospital', 'health', 'research',
  'department', 'dept', 'system', 'campus', 'main', 'national', 'general']);

function orgKeyword(org) {
  const s = String(org == null ? '' : org).toLowerCase()
    .replace(/\buniv\b/g, 'university').replace(/&/g, ' and ')
    .replace(/\b(col|coll)\b/g, 'college')
    .replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter((w) => w.length > 3 && !ORG_STOP.has(w));
  return words[0] || (s.split(' ').find((w) => w.length > 2) || '');
}

// ── ATTRIBUTION TO A NAMED PERSON, NOT MERELY TO AN AUTHOR ───────────────────
//
// attributeEmail answers "whose address is this, among the authors of this paper". That is not the
// question the ingest asks. The ingest asks "is this the address of the PI who holds the grant",
// and the gap between those two cost us a near-miss: searching for Scott J Miller at Yale,
// attributeEmail happily returned sophie.miller@sahmri.com (a different person, in South
// Australia) and edward.miller@yale.edu (a different person, same university). Both matched on the
// surname Miller and nothing contradicted them, because nothing was checking the given name.
//
// Had that run with --execute and an outreach step behind it, two uninvolved scientists would have
// received commercial mail about a grant that is not theirs. So the surname is necessary and never
// sufficient: a full given-name token in the local part must AGREE with the PI's given name, and
// "sophie" disagreeing with "scott" is a rejection rather than a tiebreak. An initial on its own
// is not enough to separate Scott from Sophie — both are S.
function attributeToPi(email, authors, pi) {
  const e = cleanEmail(email);
  if (!e || !pi) return null;
  const tLast = normalizePerson(pi.last || pi.lastName || '').replace(/\s/g, '');
  const tFirst = normalizePerson(pi.first || pi.firstName || '').replace(/\s/g, '');
  if (!tLast) return null;

  const who = attributeEmail(e, authors);
  if (!who) return null;
  if (normalizePerson(who.lastName || '').replace(/\s/g, '') !== tLast) return null;

  const local = e.split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);

  // Tokens that are a whole word and are not the surname (nor an initial glued to it, as in
  // "mrivera") are given names. Any such token must be the PI's given name.
  for (const p of parts) {
    if (p.length <= 3) continue;                       // initials cluster: "blp", "gl"
    if (p === tLast) continue;                         // the surname itself
    if (p.endsWith(tLast) && p.length - tLast.length <= 2) continue;  // "mrivera"
    if (tFirst && p === tFirst) continue;              // the PI's given name: agreement
    if (tFirst && tFirst.startsWith(p) && p.length >= 4) continue;    // "chris" for "christopher"
    if (tFirst && p.startsWith(tFirst) && tFirst.length >= 4) continue;
    return null;                                       // a different given name. Decline.
  }

  // The author record itself must not contradict the PI. Europe PMC gives firstName; where both
  // are spelled out they must match, and where one is an initial the initials must agree.
  const aFirst = normalizePerson(who.firstName || '').replace(/\s/g, '');
  if (aFirst && tFirst) {
    const bothSpelled = aFirst.length > 2 && tFirst.length > 2;
    if (bothSpelled) {
      const agree = aFirst === tFirst
        || aFirst.startsWith(tFirst) || tFirst.startsWith(aFirst);
      if (!agree) return null;
    } else if (aFirst[0] !== tFirst[0]) return null;
  }
  return who;
}

module.exports.orgKeyword = orgKeyword;
module.exports.attributeToPi = attributeToPi;
