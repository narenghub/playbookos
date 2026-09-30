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

// ── THE VOCABULARY: TWO FIELDS, NOT ONE ───────────────────────────────────────
//
// STATUS is where the conversation IS. CHANNEL is how we last touched them. They are separate because they
// are different axes, and folding them together is the mistake this design exists to avoid: "emailed" and
// "called" are not stages, they are methods at the same stage, so combining them produces
// emailed_no_reply vs called_no_reply and the list doubles for no gain.
//
// THE TEST FOR WHETHER A STATUS EARNS ITS PLACE: does it imply a different NEXT ACTION? That is why
// following_up and quote_sent are here (chase again vs. follow up the price) and why 'interested' is not —
// it was never a stage, it was a feeling, and it shared its next action with in_conversation.
//
// sort_order is EXPLICIT rather than implied by array position, because the summary bar has to read as a
// funnel and array order is easy to disturb; a number is not. The bar sorts on it, the client is given it,
// and drop-off between adjacent columns is the thing to act on.
//
// Still NO CHECK CONSTRAINT — inquiries.status shipped with one and it was dropped when the lifecycle grew,
// and this list has now grown twice. The vocabulary is a COMMENT on the column plus this array, validated at
// the API edge so a typo is still rejected.
const STATUS_DEFS = [
  { key: 'not_contacted',   order: 1,  label: 'Not contacted',   means: 'nobody has touched this yet',              next: 'make first contact' },
  { key: 'contacted',       order: 2,  label: 'Contacted',       means: 'first outreach made, no reply yet',        next: 'wait, then chase' },
  { key: 'following_up',    order: 3,  label: 'Following up',    means: 'chased at least once, still no reply',     next: 'chase again or give up' },
  { key: 'no_response',     order: 4,  label: 'No response',     means: 'gave up after repeated attempts',          next: 'nothing — revisit later' },
  { key: 'in_conversation', order: 5,  label: 'In conversation', means: 'they replied, a conversation is happening', next: 'qualify and quote' },
  { key: 'quote_sent',      order: 6,  label: 'Quote sent',      means: 'a price is with them',                     next: 'follow up the price' },
  { key: 'contract_sent',   order: 7,  label: 'Contract sent',   means: 'paperwork is out',                         next: 'chase the signature' },
  { key: 'won',             order: 8,  label: 'Won',             means: 'signed, now a customer',                   next: 'hand to delivery' },
  { key: 'not_interested',  order: 9,  label: 'Not interested',  means: 'they declined',                            next: 'nothing' },
  { key: 'disqualified',    order: 10, label: 'Disqualified',    means: 'wrong fit, chain, out of business',         next: 'nothing — do not re-enter' },
];
const STATUSES = STATUS_DEFS.map(s => s.key);
const STATUS_ORDER = Object.fromEntries(STATUS_DEFS.map(s => [s.key, s.order]));
const DEFAULT_STATUS = 'not_contacted';

// 'not_contacted' NEEDS NO ROW. The absence of an outreach row IS the default, which is why 1,522 untouched
// prospects can show in the bar without 1,522 rows existing. Every count has to add that remainder —
// see summary() in index.js.

// Statuses where the change MEANS we touched them, so last_contacted_at moves. Deciding somebody is
// disqualified is not contact, and stamping it would make "last contacted" a lie.
const CONTACT_STATUSES = ['contacted', 'following_up', 'no_response', 'in_conversation',
                          'quote_sent', 'contract_sent', 'won', 'not_interested'];

// Statuses where the conversation is over, for grouping the funnel's tail.
const TERMINAL = ['no_response', 'won', 'not_interested', 'disqualified'];

// ── CHANNEL: how we last touched them ─────────────────────────────────────────
// A separate field set alongside the status, never inside it. Optional: a status change is sometimes not a
// touch at all (disqualifying a chain from the desk), so channel stays NULL rather than being guessed.
const CHANNELS = ['email', 'phone', 'linkedin', 'in_person', 'other'];
const CHANNEL_LABEL = { email: 'Email', phone: 'Phone', linkedin: 'LinkedIn', in_person: 'In person', other: 'Other' };

// ── what the OLD vocabulary maps to ───────────────────────────────────────────
// Used by scripts/migrate-outreach-vocabulary.js. 'interested' is deliberately ABSENT: it was never a stage
// and its rows need a human decision, so the migration ABORTS on one rather than guessing. A guess that
// looks like data is worse than a migration that stops.
const LEGACY_STATUS_MAP = {
  new: 'not_contacted',
  in_progress: 'in_conversation',
  // interested: → ASK. see the migration.
};

function entity(type) { return ENTITIES[type] || null; }
function isEntityType(type) { return Object.prototype.hasOwnProperty.call(ENTITIES, type); }
function isStatus(s) { return STATUSES.includes(s); }

function isChannel(c) { return CHANNELS.includes(c); }
function statusOrder(s) { return STATUS_ORDER[s] != null ? STATUS_ORDER[s] : 99; }

module.exports = { ENTITIES, STATUS_DEFS, STATUSES, STATUS_ORDER, DEFAULT_STATUS, TERMINAL,
  CONTACT_STATUSES, CHANNELS, CHANNEL_LABEL, LEGACY_STATUS_MAP,
  entity, isEntityType, isStatus, isChannel, statusOrder };
