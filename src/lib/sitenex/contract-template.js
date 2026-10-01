// ── THE CONTRACT, AS DATA ─────────────────────────────────────────────────────
//
// v1 — the short standard-terms document, deliberately about one page. This is the shape a web
// developer actually sends: the deal on the front, fourteen one-sentence terms, two signatures. It is
// NOT a negotiated instrument and it is not attorney-reviewed; it is the standard form we offer on a
// take-it basis, the same way a hosting company publishes its terms. A client who wants their counsel
// to mark it up is a client we handle as a one-off, outside the generator.
//
// `TEMPLATE_VERSION` is stamped on every generated document and stored in the register, so when the
// wording changes we can still tell which text a given client signed. Bump it on any change to BLOCKS.
//
// WHY THIS IS DATA AND NOT CODE: an attorney has to be able to read, mark up and replace the clauses
// without touching the renderer, and we have to be able to swap the whole document without a code
// review of layout logic. So this file is a nested array of plain objects — headings, paragraphs,
// lists, tables, signature blocks — and src/lib/sitenex/contract-render.js knows how to draw each
// kind and nothing about what any of them say.
//
// FIELDS are referenced as {{name}} and resolved from one flat object. The renderer REFUSES on a
// missing required field rather than emitting `{{client_company}}` into a document going to a real
// business, which is the one failure mode that would be visible to the client and invisible to us.

const TEMPLATE_VERSION = 'v1';

// Every field the document can reference. `required: true` means the renderer refuses without it.
// Deliberately small: a field that is optional in the document must be optional here too, or a deal
// logged from a phone call can never produce a draft.
//
// `system: true` means the GENERATOR supplies it, not the deal — the contract number comes from the
// sequence at generation time and the date is "today". They are still required of the finished document,
// but they must not appear in the "what is this deal missing" answer a form shows somebody: telling a
// user to fill in the contract number is both impossible and alarming.
const FIELDS = {
  contract_no:      { required: true,  label: 'Contract number', system: true },
  contract_date:    { required: true,  label: 'Date', system: true },
  client_company:   { required: true,  label: 'Client company' },
  client_address:   { required: true,  label: 'Client address' },
  client_contact:   { required: true,  label: 'Client contact name' },
  client_title:     { required: false, label: 'Client contact title' },
  client_email:     { required: true,  label: 'Client email' },
  client_phone:     { required: false, label: 'Client phone' },
  partner_name:     { required: false, label: 'Partner' },
  package_name:     { required: true,  label: 'Package' },
  duration_weeks:   { required: true,  label: 'Duration (weeks)' },
  start_basis:      { required: true,  label: 'When the term starts', system: true },
  total_value:      { required: true,  label: 'Total value' },
  monthly_value:    { required: false, label: 'Monthly amount' },
  terms_note:       { required: false, label: 'Additional agreed terms' },
  supplier_name:    { required: true,  label: 'Supplier', system: true },
  supplier_address: { required: false, label: 'Supplier address' },
};

// Our own details. Here rather than in the renderer so they are reviewable with everything else.
const SUPPLIER = {
  supplier_name: 'Adifice Technologies LLC',
  supplier_address: null,   // not filled in: the renderer omits the line rather than printing blank
};

// ── the document ──────────────────────────────────────────────────────────────
//
// Block kinds the renderer understands:
//   { h: 'text' }                        a numbered clause heading
//   { title: 'text' }                    the document title
//   { p: 'text' }                        a paragraph
//   { bullets: ['a','b'] }               a bulleted list
//   { numbered: ['a','b'] }              a numbered list
//   { kv: [['Label','{{field}}'], …] }   a two-column facts table
//   { scope: 'included' | 'not_included' }  the package lists, injected at render time
//   { payments: true }                   the payment schedule table, injected at render time
//   { signatures: [{ for: 'text', name: '{{field}}', title: '{{field}}' }, …] }
//   { notice: 'text' }                   a boxed warning, used for the placeholder notice
//   { pagebreak: true }
const BLOCKS = [
  { title: 'Website Development Agreement' },
  { p: 'Contract {{contract_no}}, dated {{contract_date}}. This agreement is between '
     + '{{supplier_name}} ("we") and {{client_company}} ("you"), and covers the work described below.' },

  { kv: [
    ['Client', '{{client_company}}'],
    ['Address', '{{client_address}}'],
    ['Contact', '{{client_contact}}'],
    ['Email', '{{client_email}}'],
    ['Telephone', '{{client_phone}}'],
    ['Introduced by', '{{partner_name}}'],
    ['Package', '{{package_name}}'],
    ['Total', '{{total_value}}'],
    ['Monthly, from launch', '{{monthly_value}}'],
    ['Duration', '{{duration_weeks}} weeks, beginning {{start_basis}}'],
  ] },

  { h: 'What we will build' },
  { scope: 'included' },

  { h: 'Not included' },
  { p: 'These are outside this agreement and are quoted separately if you want them. Anything not '
     + 'listed under "What we will build" is not included, whether or not it appears here.' },
  { scope: 'not_included' },

  { h: 'Payment' },
  { payments: true },

  { h: 'Terms' },
  { numbered: [
    'The {{duration_weeks}}-week timeline begins {{start_basis}} — not when this is signed. If you are late sending content, approvals or access, the delivery date moves by the same amount, and we will confirm the new date in writing.',
    'You will give us your text, images, logo, opening hours and access to your domain and any existing site, and you confirm you have the right to use what you send us. Please name one person who can approve things.',
    'Two rounds of revisions are included. A revision round is one consolidated set of changes. Anything beyond that, or outside the scope above, is quoted and agreed in writing before we start it.',
    'If we do not hear back on something we have sent for approval within five working days, we treat it as approved, so the project does not stall.',
    'Each invoice is payable within 14 days. We may pause work on anything more than 14 days overdue, and the delivery date moves accordingly.',
    'When you have paid in full, the finished site, its content and its design are yours. We keep ownership of the frameworks and components underneath it, and you get a perpetual licence to use them as part of your site. Your domain is yours throughout.',
    'The monthly fee covers hosting, security updates, backups and the content changes listed above. Either of us can end it with 30 days’ notice, and if it ends we will give you an export of your site so you can host it elsewhere.',
    'Domain registration, third-party licences and plugin fees are yours and are passed through at cost.',
    'For 30 days after launch we will fix, free, anything that does not do what this agreement says it does. A change of mind, a new requirement, or a fault in something you supplied or in a third-party service is not covered by that.',
    'We cannot promise any particular search ranking, amount of traffic, or number of enquiries, and we have not done so.',
    'Either of us can end this agreement with 14 days’ written notice, or immediately if the other is in material breach and has not fixed it within 14 days of being told. If it ends, you pay for the work done and we hand it over as it stands.',
    'Except for death, personal injury or fraud, neither of us is liable for loss of profit or business or any indirect loss, and our total liability is limited to the fees paid under this agreement.',
    'Where a partner is named under "Introduced by", they introduced us and are not a party to this agreement. They cannot vary it or agree anything on our behalf.',
    'This is the whole agreement about this work and replaces anything said before it. Changes are in writing, signed by both of us. If one clause is unenforceable the rest still stands. It is governed by the law of the State of Illinois.',
  ] },

  { h: 'Additional agreed terms', omit_if_empty: 'terms_note' },
  { p: '{{terms_note}}', omit_if_empty: 'terms_note' },

  { h: 'Signed' },
  { signatures: [
    // `for:` is a fixed label, NOT merged — the renderer's sweep refuses the document if a
    // {{placeholder}} is left here, which is how this was caught.
    { for: 'For the Supplier', name: '{{supplier_name}}', title: null },
    { for: 'For the Client', name: '{{client_contact}}', title: '{{client_title}}' },
  ] },
];

module.exports = { TEMPLATE_VERSION, FIELDS, SUPPLIER, BLOCKS };
