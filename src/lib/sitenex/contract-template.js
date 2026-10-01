// ── THE CONTRACT, AS DATA ─────────────────────────────────────────────────────
//
// ⚠️  PLACEHOLDER. THIS HAS NOT BEEN REVIEWED BY AN ATTORNEY. It is a structurally complete document
//     with plausible commercial clauses, written so the generator, the register and the download can be
//     built and tested end to end. The clause TEXT is not legal advice and must be replaced before any
//     of it is sent to a real business. `TEMPLATE_VERSION` says so, every generated document carries
//     that version in the register, and the document itself prints the notice — so a placeholder cannot
//     be mistaken for the real thing after the fact.
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

const TEMPLATE_VERSION = 'placeholder-v1';

// Every field the document can reference. `required: true` means the renderer refuses without it.
// Deliberately small: a field that is optional in the document must be optional here too, or a deal
// logged from a phone call can never produce a draft.
const FIELDS = {
  contract_no:      { required: true,  label: 'Contract number' },
  contract_date:    { required: true,  label: 'Date' },
  client_company:   { required: true,  label: 'Client company' },
  client_address:   { required: true,  label: 'Client address' },
  client_contact:   { required: true,  label: 'Client contact name' },
  client_title:     { required: false, label: 'Client contact title' },
  client_email:     { required: true,  label: 'Client email' },
  client_phone:     { required: false, label: 'Client phone' },
  partner_name:     { required: false, label: 'Partner' },
  package_name:     { required: true,  label: 'Package' },
  duration_weeks:   { required: true,  label: 'Duration (weeks)' },
  start_basis:      { required: true,  label: 'When the term starts' },
  total_value:      { required: true,  label: 'Total value' },
  monthly_value:    { required: false, label: 'Monthly amount' },
  terms_note:       { required: false, label: 'Additional agreed terms' },
  supplier_name:    { required: true,  label: 'Supplier' },
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
  { notice: 'DRAFT — THIS TEMPLATE HAS NOT BEEN REVIEWED BY AN ATTORNEY. '
          + 'Clause text is placeholder content for system testing and is not legal advice. '
          + 'Do not send to a client until it has been replaced with reviewed wording.' },

  { title: 'Website Development Agreement' },
  { p: 'Contract {{contract_no}}, dated {{contract_date}}.' },

  { kv: [
    ['Supplier', '{{supplier_name}}'],
    ['Client', '{{client_company}}'],
    ['Client address', '{{client_address}}'],
    ['Client contact', '{{client_contact}}'],
    ['Email', '{{client_email}}'],
    ['Telephone', '{{client_phone}}'],
    ['Introduced by', '{{partner_name}}'],
    ['Package', '{{package_name}}'],
    ['Duration', '{{duration_weeks}} weeks'],
    ['Term begins', '{{start_basis}}'],
    ['Total', '{{total_value}}'],
    ['Monthly', '{{monthly_value}}'],
  ] },

  { h: 'What the Supplier will do' },
  { p: 'The Supplier will deliver the following as part of the {{package_name}} package:' },
  { scope: 'included' },

  { h: 'What is not included' },
  { p: 'The following are expressly outside the scope of this agreement. They may be purchased '
     + 'separately, under a separate written agreement:' },
  { scope: 'not_included' },
  { p: 'Anything not listed in "What the Supplier will do" is not included, whether or not it appears '
     + 'in the list above.' },

  { h: 'Duration' },
  { p: 'The expected duration is {{duration_weeks}} weeks. The term begins {{start_basis}}.' },
  { p: 'The duration assumes the Client supplies content, approvals and access when requested. Delay '
     + 'by the Client extends the duration by the length of that delay, and the Supplier will confirm '
     + 'any such change in writing.' },

  { h: 'Fees and payment' },
  { p: 'The total fee for this agreement is {{total_value}}, payable as set out below.' },
  { payments: true },
  { p: 'Invoices are payable within 14 days of issue. Where a payment is tied to a milestone, the '
     + 'invoice issues on the Supplier reaching that milestone, not on the Client approving it.' },

  { h: "The Client's responsibilities" },
  { p: 'The Client will:' },
  { bullets: [
    'provide text, images and any other content the Supplier needs, and confirm it has the right to use them',
    'name one person who can give approvals, and tell the Supplier if that person changes',
    'respond to requests for approval within five working days',
    'provide access to any existing domain, hosting or analytics account that is to be reused',
  ] },
  { p: 'The Supplier is not responsible for delay caused by any of the above not happening.' },

  { h: 'Intellectual property' },
  { p: 'On payment in full, the Client owns the finished website, its content and its design. Until '
     + 'payment in full, the Supplier retains ownership of the work in progress.' },
  { p: 'The Supplier retains ownership of any pre-existing framework, library or component used to '
     + 'build the site, and grants the Client a perpetual licence to use it as part of the site.' },
  { p: 'Third-party components keep their own licences. The Supplier will tell the Client about any '
     + 'component that carries an ongoing fee before it is used.' },

  { h: 'Changes' },
  { p: 'A change to the scope set out above is agreed in writing, with its effect on the fee and the '
     + 'duration stated at the time. Work does not begin on a change before that is agreed.' },

  { h: 'Warranty and defects' },
  { p: 'For 30 days after launch the Supplier will correct, at no charge, any defect in the work it '
     + 'delivered. A defect is the work not doing what this agreement says it does.' },
  { p: 'A change of mind, a new requirement, or a fault in something the Client supplied or in a '
     + 'third-party service is not a defect.' },
  { p: 'The Supplier does not warrant any particular commercial result from the website.' },

  { h: 'Hosting and ongoing costs' },
  { p: 'Domain registration, hosting and third-party service fees are the Client\'s, and are passed '
     + 'through at cost unless this agreement says otherwise.' },

  { h: 'Confidentiality' },
  { p: 'Each party will keep confidential anything the other marks as confidential, or that is '
     + 'obviously confidential, and will use it only to perform this agreement.' },

  { h: 'Liability' },
  { p: 'Neither party excludes liability for death, personal injury, or fraud.' },
  { p: 'Otherwise, each party\'s total liability under this agreement is limited to the total fee '
     + 'paid or payable under it, and neither party is liable for loss of profit, loss of business, or '
     + 'any indirect or consequential loss.' },

  { h: 'Ending this agreement' },
  { p: 'Either party may end this agreement by 14 days\' written notice. On ending, the Client pays '
     + 'for work done up to that date, and the Supplier delivers that work in the state it is in.' },
  { p: 'Either party may end this agreement immediately if the other is in material breach and has '
     + 'not corrected it within 14 days of being told about it in writing.' },

  { h: 'Referral partner' },
  { p: 'Where this agreement names a partner under "Introduced by", that partner introduced the '
     + 'Client to the Supplier and is not a party to this agreement. The partner has no authority to '
     + 'vary it, to accept notice under it, or to bind the Supplier.' },

  { h: 'General' },
  { numbered: [
    'This agreement is the whole agreement between the parties about this work, and replaces anything said or written before it.',
    'A waiver of one breach is not a waiver of any other.',
    'If any clause is unenforceable, the rest of the agreement continues in force.',
    'Neither party may assign this agreement without the other\'s written consent.',
    'This agreement is governed by the law of the State of Illinois, and the courts of that State have exclusive jurisdiction.',
  ] },

  // BOTH blocks carry omit_if_empty, so an absent note drops the heading with its body rather than
  // leaving a numbered clause containing nothing.
  { h: 'Additional agreed terms', omit_if_empty: 'terms_note' },
  { p: '{{terms_note}}', omit_if_empty: 'terms_note' },

  { h: 'Signed' },
  { p: 'Each party confirms the person signing is authorised to do so.' },
  { signatures: [
    { for: 'For the Supplier', name: '{{supplier_name}}', title: null },
    { for: 'For the Client', name: '{{client_contact}}', title: '{{client_title}}' },
  ] },
];

module.exports = { TEMPLATE_VERSION, FIELDS, SUPPLIER, BLOCKS };
