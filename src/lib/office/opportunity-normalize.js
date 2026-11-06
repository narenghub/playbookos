// ── NORMALISE AN IMPORTED ROW INTO THE TRACKER'S SHAPE ───────────────────────
//
// SAM.gov's exports, its web UI, and third-party re-exports all use different column names for the
// same field. This maps whatever arrived onto the schema, and — the important half — REFUSES TO
// GUESS. An unparseable date becomes null with a recorded reason, never today's date. An absent
// value stays absent, never zero.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────────────
//
// Ruling 21 priority 3: "Do not fabricate contract records, deadlines, values, or qualification
// results." The most likely way to fabricate one is not malice, it is a convenience default — a
// `|| new Date()` on a missing deadline, a `parseFloat(x) || 0` on a missing value, a notice type
// defaulted to 'solicitation' because that is the common case. Each would produce a plausible,
// wrong, actionable record. So every field has exactly one of: a parsed value, or null plus a
// reason in `issues`.
//
// A row with issues is still imported. The issues travel with it and surface in the tracker, which
// is more useful than dropping the row — a solicitation with an unreadable deadline is still a real
// solicitation, it just cannot be called biddable, and the generated is_biddable column already
// refuses that.
'use strict';

const crypto = require('crypto');
const { NOTICE_TYPES } = require('./opportunity-schema');

// Header aliases, lower-cased and stripped of non-alphanumerics for matching. Taken from the
// column names SAM.gov's contract-opportunity exports and UI actually use.
const FIELD_ALIASES = {
  // 'sol' is SAM.gov's own export header `Sol#`. Omitting it meant every record silently fell
  // back to the notice id as identity — and a notice id CHANGES per amendment, so amendment
  // detection would have keyed on a field that is different for every version. The importer
  // reported this 82 times as a per-record issue and the run still looked successful, which is
  // why the issue list is worth reading rather than counting.
  solicitation_number: ['solicitationnumber', 'solnbr', 'sol', 'solnumber', 'solicitation', 'solicitationid', 'solno', 'referencenumber'],
  notice_id: ['noticeid', 'noticeidnumber', 'id', 'opportunityid'],
  title: ['title', 'subject', 'opportunitytitle', 'noticetitle'],
  // 'departmentindagency' is the real header `Department/Ind.Agency`.
  agency: ['department', 'departmentindagency', 'deptindagency', 'departmentagency', 'agency', 'deptagency', 'parentagency'],
  sub_agency: ['subtier', 'subtieragency', 'subagency', 'agencysubtier'],
  office: ['office', 'officename', 'contractingoffice'],
  naics_code: ['naics', 'naicscode', 'naicscodes', 'primarynaics'],
  psc_code: ['classificationcode', 'psc', 'psccode', 'productservicecode'],
  // Descriptive first, code second: SAM exports both `SetASide` (text) and `SetASideCode`, and the
  // code column is frequently blank while the text one is populated.
  set_aside: ['setaside', 'setasidedescription', 'typeofsetaside', 'setasidetype', 'setasidecode'],
  contract_type: ['contracttype', 'typeofcontract', 'contractvehicle', 'contractawardtype'],
  estimated_value_usd: ['estimatedvalue', 'awardamount', 'estimatedcontractvalue', 'value', 'basevalue'],
  posted_date: ['posteddate', 'datedposted', 'publishdate', 'postedon', 'date'],
  response_deadline: ['responsedeadline', 'responsedate', 'currentresponsedate', 'offersdueby', 'closedate', 'responsedeadlinedate', 'reponsedeadline'],
  notice_type: ['type', 'noticetype', 'basetype', 'opportunitytype'],
  archive_date: ['archivedate'],
  award_number: ['awardnumber', 'awardnbr'],
  status: ['status', 'active', 'archivetype'],
  source_url: ['link', 'url', 'uilink', 'noticelink', 'opportunitylink'],
  description: ['description', 'synopsis', 'body'],
  place_of_performance: ['popcity', 'placeofperformance', 'popstate', 'performancelocation'],
};

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Build header → field mapping for a parsed CSV's headers. Unmatched headers are reported. */
/**
 * Map headers to fields. A field may legitimately have SEVERAL candidate columns — SAM exports
 * both `SetASide` and `SetASideCode`, both `Type` and `BaseType` — so the mapping holds an ORDERED
 * list per field and the reader takes the first non-blank. The previous version kept one header
 * per field and discarded the rest as "duplicate mappings", which is how `SetASideCode` (empty in
 * practice) won over `SetASide` (populated) and left every set-aside blank.
 */
function mapHeaders(headers) {
  const mapping = {};        // field → [header, …] in alias-priority order
  const unmatched = [];
  const byAlias = new Map();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    aliases.forEach((a, rank) => { if (!byAlias.has(a)) byAlias.set(a, { field, rank }); });
  }
  for (const h of headers) {
    const hit = byAlias.get(norm(h));
    if (!hit) { unmatched.push(h); continue; }
    (mapping[hit.field] = mapping[hit.field] || []).push({ header: h, rank: hit.rank });
  }
  for (const f of Object.keys(mapping)) {
    mapping[f] = mapping[f].sort((a, b) => a.rank - b.rank).map((x) => x.header);
  }
  return { mapping, unmatched };
}

// ── parsers that refuse rather than guess ────────────────────────────────────

const EMPTY = new Set(['', 'n/a', 'na', 'none', 'null', '-', '--', 'tbd', 'unknown', 'not applicable']);
const blank = (v) => v === null || v === undefined || EMPTY.has(String(v).trim().toLowerCase());

/** A date, or null plus why. Accepts ISO, US, and SAM's common forms. Never defaults. */
function parseDate(raw) {
  if (blank(raw)) return { value: null, issue: null };
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                         // 2026-11-06
  if (!m) {
    const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);          // 11/06/2026
    if (us) m = [null, us[3], us[1].padStart(2, '0'), us[2].padStart(2, '0')];
  }
  if (!m) {
    const d = new Date(s);
    // Date's permissiveness is the hazard: new Date('Q3') is Invalid but new Date('5') is 2001.
    // So a free-form string is accepted only if it round-trips to something with a 4-digit year
    // that appears in the input.
    if (!Number.isNaN(d.getTime()) && /\b(19|20)\d{2}\b/.test(s)) {
      return { value: d.toISOString().slice(0, 10), issue: null };
    }
    return { value: null, issue: `unparseable date: ${JSON.stringify(s.slice(0, 40))}` };
  }
  const [, y, mo, da] = m;
  const iso = `${y}-${mo}-${da}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) {
    return { value: null, issue: `not a real date: ${iso}` };
  }
  return { value: iso, issue: null };
}

/**
 * A deadline, with whether the source gave a time of day.
 * Rendering "2:00 PM Eastern" as midnight would move a deadline by fourteen hours, so the two
 * cases are kept distinct and the original text is preserved.
 */
function parseDeadline(raw) {
  if (blank(raw)) return { value: null, hasTime: false, sourceText: null, issue: null };
  const s = String(raw).trim();
  const hasTime = /\d{1,2}:\d{2}/.test(s) || /\b(am|pm)\b/i.test(s);
  // An explicit offset or a named US zone we can resolve; otherwise the time is kept as text and
  // the timestamp is dated midnight UTC with hasTime=false, which the tracker renders as
  // "date only, time unconfirmed" rather than as a precise instant.
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2})?)\s*(Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const off = iso[4] ? iso[4].replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z';
    const d = new Date(`${iso[1]}T${iso[2].length === 5 ? `${iso[2]}:00` : iso[2]}${off}`);
    if (!Number.isNaN(d.getTime())) {
      return {
        value: d.toISOString(), hasTime: true, sourceText: s,
        issue: iso[4] ? null : 'deadline had no timezone; interpreted as UTC',
      };
    }
  }
  const d = parseDate(s);
  if (d.value) {
    return {
      value: `${d.value}T00:00:00.000Z`,
      hasTime: false,
      sourceText: s,
      issue: hasTime
        ? `deadline carried a time this parser could not resolve; kept as text and dated 00:00Z — CONFIRM BEFORE RELYING: ${JSON.stringify(s.slice(0, 48))}`
        : null,
    };
  }
  return { value: null, hasTime, sourceText: s, issue: d.issue };
}

/** A dollar amount, or null. Never zero for "absent" — those mean different things. */
function parseMoney(raw) {
  if (blank(raw)) return { value: null, issue: null };
  const s = String(raw).trim();
  const cleaned = s.replace(/[$,\s]/g, '').replace(/usd/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { value: null, issue: `unparseable value: ${JSON.stringify(s.slice(0, 32))}` };
  }
  const n = Number(cleaned);
  if (n < 0) return { value: null, issue: `negative estimated value: ${s}` };
  if (!Number.isFinite(n) || n > 99999999999.99) return { value: null, issue: `value out of range: ${s}` };
  return { value: Number(n.toFixed(2)), issue: null };
}

function parseNaics(raw) {
  if (blank(raw)) return { value: null, issue: null };
  // A cell may hold several; take the first and record that there were more.
  const all = String(raw).split(/[;,|\s]+/).map((x) => x.trim()).filter(Boolean);
  const first = all[0];
  if (!/^\d{6}$/.test(first)) {
    return { value: null, issue: `NAICS is not six digits: ${JSON.stringify(String(raw).slice(0, 32))}` };
  }
  return { value: first, issue: all.length > 1 ? `row listed ${all.length} NAICS codes; kept ${first}` : null };
}

function parsePsc(raw) {
  if (blank(raw)) return { value: null, issue: null };
  const v = String(raw).trim().toUpperCase().split(/[;,|\s]+/)[0];
  if (!/^[0-9A-Z]{4}$/.test(v)) {
    return { value: null, issue: `PSC is not four alphanumerics: ${JSON.stringify(String(raw).slice(0, 32))}` };
  }
  return { value: v, issue: null };
}

// Notice-type mapping. UNRECOGNISED BECOMES 'unknown', never 'solicitation'. Defaulting an
// unrecognised type to the biddable one would turn an award into an opportunity.
const NOTICE_MAP = [
  [/combined\s*synopsis|combined/i, 'combined_synopsis'],
  [/pre\s*-?\s*solicitation|presol/i, 'presolicitation'],
  [/sources?\s*sought/i, 'sources_sought'],
  [/special\s*notice/i, 'special_notice'],
  [/justification|j&a|jefo/i, 'justification'],
  [/intent\s*to\s*bundle/i, 'intent_to_bundle'],
  [/award/i, 'award'],
  [/solicitation|rfp|rfq|ifb/i, 'solicitation'],
];
function parseNoticeType(raw) {
  if (blank(raw)) return { value: 'unknown', issue: 'source gave no notice type' };
  const s = String(raw).trim();
  for (const [re, v] of NOTICE_MAP) if (re.test(s)) return { value: v, issue: null };
  return {
    value: 'unknown',
    issue: `unrecognised notice type ${JSON.stringify(s.slice(0, 40))} — recorded as unknown, NOT as a solicitation`,
  };
}

function parseStatus(raw) {
  if (blank(raw)) return { value: 'unknown', issue: 'source gave no status' };
  const s = String(raw).trim().toLowerCase();
  if (/^(yes|active|true|open)$/.test(s)) return { value: 'open', issue: null };
  if (/^(no|inactive|false)$/.test(s)) return { value: 'archived', issue: null };
  if (/award/.test(s)) return { value: 'awarded', issue: null };
  if (/cancel/.test(s)) return { value: 'cancelled', issue: null };
  if (/archiv/.test(s)) return { value: 'archived', issue: null };
  if (/clos/.test(s)) return { value: 'closed', issue: null };
  return { value: 'unknown', issue: `unrecognised status ${JSON.stringify(s.slice(0, 24))}` };
}

/** A source URL, validated for shape only. The SSRF guard owns fetching; this owns recording. */
function parseUrl(raw) {
  if (blank(raw)) return { value: null, issue: null };
  const s = String(raw).trim();
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { value: null, issue: `source link is not http(s): ${u.protocol}` };
    }
    return { value: u.toString(), issue: u.protocol === 'http:' ? 'source link is plaintext http' : null };
  } catch (_) {
    return { value: null, issue: `source link is not a URL: ${JSON.stringify(s.slice(0, 48))}` };
  }
}

const text = (raw, max = 4000) => (blank(raw) ? null : String(raw).trim().slice(0, max));

/**
 * The content hash that drives deduplication. Computed over the SUBSTANTIVE fields only, so a
 * re-export with a different column order or a changed `observed_at` is recognised as the same
 * record, while a changed deadline or title is recognised as an amendment.
 */
function contentHash(rec) {
  const material = [
    rec.solicitation_number, rec.title, rec.agency, rec.sub_agency, rec.office,
    rec.naics_code, rec.psc_code, rec.set_aside, rec.contract_type,
    rec.estimated_value_usd === null ? '' : String(rec.estimated_value_usd),
    rec.posted_date, rec.response_deadline, rec.notice_type, rec.status,
    rec.description, rec.place_of_performance,
  ].map((x) => (x === null || x === undefined ? '' : String(x)));
  return crypto.createHash('sha256').update(material.join('\u0000')).digest('hex');
}

/**
 * Normalise one row. Returns { record, issues, rejected }.
 * A row is REJECTED only when it has no usable identity — no solicitation number, or no title.
 * Everything else is imported with its issues attached.
 */
function normalizeRow(row, mapping) {
  // First NON-BLANK among the candidate columns, in alias-priority order.
  const get = (field) => {
    for (const header of (mapping[field] || [])) {
      const v = row[header];
      if (!blank(v)) return v;
    }
    return undefined;
  };
  const issues = [];
  const take = (r) => { if (r.issue) issues.push(r.issue); return r.value; };

  const solicitation_number = text(get('solicitation_number'), 128)
    || text(get('notice_id'), 128);              // some exports only carry a notice id
  const title = text(get('title'), 500);

  if (!solicitation_number) {
    return { record: null, issues: ['no solicitation number and no notice id — cannot identify this record'], rejected: true };
  }
  if (!title) {
    return { record: null, issues: [`${solicitation_number}: no title — refusing to import an unnamed opportunity`], rejected: true };
  }
  if (!text(get('solicitation_number'), 128) && text(get('notice_id'), 128)) {
    issues.push('no solicitation number in source; used the notice id as identity');
  }

  const dl = parseDeadline(get('response_deadline'));
  if (dl.issue) issues.push(dl.issue);

  const record = {
    solicitation_number,
    notice_id: text(get('notice_id'), 128),
    title,
    agency: text(get('agency'), 240),
    sub_agency: text(get('sub_agency'), 240),
    office: text(get('office'), 240),
    naics_code: take(parseNaics(get('naics_code'))),
    psc_code: take(parsePsc(get('psc_code'))),
    set_aside: text(get('set_aside'), 160),
    contract_type: text(get('contract_type'), 160),
    estimated_value_usd: take(parseMoney(get('estimated_value_usd'))),
    posted_date: take(parseDate(get('posted_date'))),
    response_deadline: dl.value,
    deadline_has_time: dl.hasTime && !!dl.value,
    deadline_source_text: dl.sourceText,
    notice_type: take(parseNoticeType(get('notice_type'))),
    status: take(parseStatus(get('status'))),
    source_url: take(parseUrl(get('source_url'))),
    description: text(get('description'), 8000),
    place_of_performance: text(get('place_of_performance'), 240),
  };
  record.content_hash = contentHash(record);
  return { record, issues, rejected: false };
}

module.exports = {
  FIELD_ALIASES,
  mapHeaders,
  parseDate,
  parseDeadline,
  parseMoney,
  parseNaics,
  parsePsc,
  parseNoticeType,
  parseStatus,
  parseUrl,
  contentHash,
  normalizeRow,
};
