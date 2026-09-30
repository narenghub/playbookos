// OUTREACH — ONE implementation for every list, and the list of lists.
//
// Enumerated from the code, not from memory. Each entry says which table a list is really backed by, how
// to read an entity's id and product, and what to call a row of it. Adding a list is a line here; that is
// the whole point of the exercise, because six separate status columns would have drifted within a month.
//
// WHAT THE ENUMERATION TURNED UP, beyond the six lists named:
//   • GolfNex / Favly / Linkabl "prospect lists" are ONE table behind three product filters, so they are
//     one implementation, not three.
//   • AROS Establishments, CPHI Milan and Sales Pipeline are also lists of contactable entities and were
//     not on the list. They are here.
//   • THREE outreach-ish tables already exist and are deliberately NOT replaced:
//       research_outreach      generated email DRAFTS per study (subject/body/copied_at) — content, not status
//       supplier_outreach_log  RFQ emails tied to an rfq_id, with its own replied_at — a send log
//       linkedin_outreach      per-contact LinkedIn sends, currently empty
//     None of them is a status tracker for a list, so none of them is what this replaces. Left alone.
//
// ── THE CONFLICT WORTH READING BEFORE CHANGING ANYTHING ───────────────────────
//
// prospects.status ALREADY EXISTS: new(1,564) / qualified(2,697) / rejected(402). It is NOT an outreach
// status — it is the QUALIFIER's verdict on whether the row is worth having at all. The two are
// orthogonal, and collapsing them would be a real loss:
//
//     prospects.status   'is this a good target?'    written by the qualifier agent
//     outreach.status    'where is the conversation?' written by a person after a call
//
// A qualified prospect you have contacted is BOTH. If outreach status were written into
// prospects.status, 'qualified' and 'contacted' would become mutually exclusive and the qualifier's next
// run would overwrite a human's note. So prospects.status stays exactly as it is, and outreach lives in
// its own table. Do not "simplify" this into one column.

// product: a literal product key, or 'row' meaning read it from the entity's own product column.
const ENTITIES = {
  prospect: {
    label: 'Prospect',
    table: 'prospects',
    idCast: 'bigint',                // prospects.id is BIGSERIAL; entity_id is TEXT, so casts are explicit
    product: 'row',                  // golfnex / favly / linkabl / sitenex all live in this one table
    pages: ['prospects', 'sitenex-prospects'],
  },
  institution: {
    label: 'Institution',
    table: 'research_institutions',
    idCast: 'bigint',
    product: 'abiozen',
    pages: ['research-institutions'],
  },
  study: {
    label: 'Study',
    table: 'clinical_studies',
    // TEXT, not bigint — clinical_studies.id is a uuid. I assumed bigint because every other entity table
    // uses one, and the existence query then cast the uuid and threw, so every study write returned 400.
    // verify-outreach-live.js now compares every idCast against information_schema, which is the only place
    // that can catch this: a fake with numeric ids agrees with either answer.
    idCast: 'text',
    product: 'abiozen',
    pages: ['clinical-demand-intelligence'],
  },
  establishment: {
    label: 'FDA establishment',
    table: 'fda_establishments',
    idCast: 'bigint',
    product: 'aros',
    pages: ['aros-establishments'],
  },
  exhibitor: {
    label: 'CPHI exhibitor',
    table: 'cphi_exhibitor_matches',
    idCast: 'bigint',
    product: 'abiozen',
    pages: ['cphi-milan'],
  },
  // ── lead: REGISTERED, BUT DELIBERATELY NOT GIVEN A CONTROL ON THE PAGE ──────
  //
  // leads.status ALREADY IS an outreach lifecycle — new → contacted → qualified → closed — with its own
  // buttons on each card in the Sales Pipeline. This is NOT the prospects.status situation: there the two
  // columns measure different things (qualification vs. conversation) and coexist correctly. Here they
  // measure the SAME thing, so a second dropdown beside those buttons is exactly the "recorded in two
  // places" problem that the won → sitenex_deals link exists to avoid.
  //
  // DECIDED 2026-09-30: leave it unwired. The real fix is migrating leads.status into outreach and retiring
  // the four buttons, and it is NOT being done now, for two reasons:
  //
  //   1. THE 4 → 8 MAPPING IS LOSSY. 'closed' means won or lost and the data cannot say which, so any
  //      migration would have to guess — and a guess that looks like data is worse than the gap.
  //   2. NOBODY IS WORKING THIS PIPELINE. leads has 4 rows, all 'new'. So a lossy migration would be
  //      solving a collision no one is hitting.
  //
  // Revisit when somebody actually uses it — at which point there will be real transitions to map, and the
  // won/lost ambiguity will be answerable by asking them rather than by inference.
  //
  // The entity type stays registered so nothing about the design pretends leads are outside the system: the
  // API accepts lead outreach today, the page simply does not offer a second control.
  lead: {
    label: 'Lead',
    table: 'leads',
    idCast: 'text',                  // leads.id is TEXT
    product: 'abiozen',
    pages: ['sales-pipeline'],
    hasOwnLifecycle: 'leads.status (new/contacted/qualified/closed) with buttons on the card',
  },
};

// ── THE VOCABULARY ────────────────────────────────────────────────────────────
//
// Eight values, in lifecycle order. NO CHECK CONSTRAINT: inquiries.status shipped with one and it was
// dropped (db.js) once the lifecycle outgrew the original six, and this will grow the same way —
// 'proposal_sent' and 'nurture' are both plausible. The vocabulary lives in a COMMENT on the column and
// in this array, and the API validates against it so a typo is still rejected at the edge.
//
// 'new' NEEDS NO ROW. The absence of an outreach row IS 'new', which is why 1,524 prospects can show as
// new without writing 1,524 rows. Every count has to account for that — see summary() in index.js.
const STATUSES = [
  'new',            // no contact yet — the default, no row needed
  'contacted',      // reached out, no reply yet
  'no_response',    // reached out repeatedly, nothing back
  'in_progress',    // a conversation is happening
  'interested',     // positive signal, not closed
  'not_interested', // declined
  'won',            // signed / now a customer
  'disqualified',   // wrong fit, chain, out of business
];
const DEFAULT_STATUS = 'new';
// Statuses that mean the conversation is over, for the summary bar's grouping.
const TERMINAL = ['not_interested', 'won', 'disqualified'];

function entity(type) { return ENTITIES[type] || null; }
function isEntityType(type) { return Object.prototype.hasOwnProperty.call(ENTITIES, type); }
function isStatus(s) { return STATUSES.includes(s); }

module.exports = { ENTITIES, STATUSES, DEFAULT_STATUS, TERMINAL, entity, isEntityType, isStatus };
