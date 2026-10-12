// ── THE POST-CPHI FOLLOW-UP SEQUENCES ─────────────────────────────────────────
//
// Three sequences, segmented the way the show was: supplier, buyer, partner. Every recipient met
// Naren in person and agreed a model at the stand, which decides everything about how these read.
//
// ── WHY THE HTML LOOKS LIKE THIS ─────────────────────────────────────────────
//
// Naren asked for HTML bodies. The trap in that request is that "HTML email" usually means a
// template: a logo, a hero band, a coloured call-to-action button, a footer with social icons. Any
// of those would undo the whole point of sending from his own mailbox instead of a sequencer —
// a person following up on a handshake does not send a newsletter.
//
// So the HTML here is typographic, not decorative. Paragraphs, one rule above the signature, and
// a link that looks like a link. No images (which also means nothing to block, and nothing that
// looks like a tracking pixel), no tables, no buttons, no background colours, no web fonts. It
// renders identically in Gmail, Outlook and Apple Mail because there is nothing in it to render
// differently. The visual continuity with the attachment comes from the one accent colour, used
// once.
//
// Every step also carries a plain-text part written BY HAND — not stripped from the HTML. A reader
// on a watch or in a text client sees that version, and tag-stripped HTML reads like a machine
// wrote it.
//
// ── WHAT THE COPY MAY AND MAY NOT SAY ────────────────────────────────────────
//
//   · No molecule is named in a template. Availability and price belong in a human reply, after
//     the catalogue comes back.
//   · No claim about a product beyond what the one-pager states: the marketplace is operating,
//     AROS is in early release, the analytical partner network is being onboarded.
//   · No volume forecast. "One or two studies a day" was said across a table; printed, it is a
//     commitment.
//   · Nothing about how the platform is built.
'use strict';

const SIG_NAME = 'Naren Boda';
// Naren's business card says DIRECTOR. The signature has to match the card they are holding —
// a follow-up four days after a handshake, signed with a different title from the card in their
// pocket, reads as a different person or a bait-and-switch. The card is the fixed point here.
const SIG_ROLE = 'Director, Abiozen LLC';
const SIG_MAIL = 'naren@abiozen.com';
const SIG_TEL = '+1 (773) 964-5150';
const ACCENT = '#0b5a6b';

// One font stack, one size, one colour. The signature is the only styled element, and it is styled
// the way a mail client's own signature block is — a rule and smaller grey text.
function wrap(bodyHtml, { showSignature = true } = {}) {
  // "Best regards," ONLY — the block below already says who sent it. Naren spotted the name
  // printed twice, which is the tell of a template assembled from two halves that each thought
  // they owned the sign-off.
  const sig = showSignature ? `
    <p style="margin:0 0 4px 0">Best regards,</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:14px">
      <tr><td style="border-top:2px solid ${ACCENT};padding-top:7px;font-size:13px;color:#5a6b78;line-height:1.5">
        <strong style="color:#15202b">${SIG_NAME}</strong> &middot; ${SIG_ROLE}<br>
        <a href="mailto:${SIG_MAIL}" style="color:${ACCENT};text-decoration:none">${SIG_MAIL}</a>
        &middot; ${SIG_TEL}<br>
        1333 Barclay Blvd, Buffalo Grove, IL 60089, USA
      </td></tr>
    </table>` : '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#15202b;max-width:620px">
${bodyHtml}
${sig}
</div>`;
}

const p = (s) => `  <p style="margin:0 0 13px 0">${s}</p>`;
const ol = (items) => `  <ol style="margin:0 0 13px 0;padding-left:22px">${
  items.map((i) => `<li style="margin-bottom:6px">${i}</li>`).join('')}</ol>`;

// ── SUPPLIER ──────────────────────────────────────────────────────────────────
// Goal: their full catalogue, and confirmation of what they can supply.
// The attachment goes on step 1, because every supplier on the floor asked "which molecules do you
// want?" and it could not be answered. Sending the ask without the answer repeats that failure in
// writing.
const supplier = {
  key: 'supplier',
  label: 'Supplier · catalogue request',
  steps: [
    {
      step: 1, delayDays: 0, attach: true,
      subject: 'Following up from CPHI Milan — how we work, and a question',
      text: ({ first }) => `Hi ${first},

It was a real pleasure meeting you at CPHI in Milan — thank you for the time at your stand.

I have attached a one-page summary of how our marketplace, our regulatory compliance platform and our analytical testing partners fit together, since that is the model we talked about and it is easier to read than to describe.

One thing would help us move quickly: your full product list. The complete catalogue, not only the molecules we discussed — we add demand continuously and would rather match against everything you make. Where a DMF is on file, and indicative lead times, would let us answer a buyer without coming back to you first.

If someone else on your team handles the commercial side of API supply, I am glad to be pointed their way.

Best regards,
${SIG_NAME}
${SIG_ROLE}
${SIG_MAIL} · ${SIG_TEL}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('It was a real pleasure meeting you at CPHI in Milan — thank you for the time at your stand.'),
        p('I have attached a one-page summary of how our marketplace, our regulatory compliance platform and our analytical testing partners fit together, since that is the model we talked about and it is easier to read than to describe.'),
        p('One thing would help us move quickly: <strong>your full product list</strong>. The complete catalogue, not only the molecules we discussed — we add demand continuously and would rather match against everything you make. Where a DMF is on file, and indicative lead times, would let us answer a buyer without coming back to you first.'),
        p('If someone else on your team handles the commercial side of API supply, I am glad to be pointed their way.'),
      ].join('\n')),
    },
    {
      step: 2, delayDays: 4, attach: false,
      subject: null,   // null = reply in-thread, Gmail shows "Re: <original>"
      text: ({ first }) => `Hi ${first},

Just making sure my note reached you — I know the week after a show is the worst week for an inbox.

The short version: we would like your full product catalogue, and confirmation of which molecules you can supply today. The summary is attached to the message below.

Best regards,
${SIG_NAME}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('Just making sure my note reached you — I know the week after a show is the worst week for an inbox.'),
        p('The short version: we would like your full product catalogue, and confirmation of which molecules you can supply today. The summary is attached to the message below.'),
      ].join('\n')),
    },
    {
      step: 3, delayDays: 12, attach: false,
      subject: null,
      text: ({ first, company }) => `Hi ${first},

Last note from me on this. If the timing is not right, no problem at all — I will keep ${company} on our list and come back when our requirements change.

If it is worth a conversation, the one thing I need is your product catalogue; I can take it from there.

Best regards,
${SIG_NAME}`,
      html: ({ first, company }) => wrap([
        p(`Hi ${first},`),
        p(`Last note from me on this. If the timing is not right, no problem at all — I will keep ${company} on our list and come back when our requirements change.`),
        p('If it is worth a conversation, the one thing I need is your product catalogue; I can take it from there.'),
      ].join('\n')),
    },
  ],
};

// ── BUYER ─────────────────────────────────────────────────────────────────────
// A standing offer, not a request. Two steps on purpose: asking twice for nothing is fine, asking
// three times for nothing is a nuisance.
const buyer = {
  key: 'buyer',
  label: 'Buyer · standing offer',
  steps: [
    {
      step: 1, delayDays: 0, attach: true,
      subject: 'From CPHI Milan — if you are ever short a molecule',
      text: ({ first }) => `Hi ${first},

Good to meet you at CPHI in Milan.

Short and useful rather than a pitch: Abiozen holds several hundred products across our supplier network, and sourcing is the thing we are fastest at. If you are ever short a molecule — a supplier slipping, a qualification falling through, a volume you cannot cover — send it to me and I will tell you honestly whether we can help and how quickly.

What we cover: research chemicals and generic APIs, and we are not limited to a single therapeutic area. Where it helps, the material arrives with its regulatory documentation, and analytical testing can be arranged through the partner laboratories we are onboarding — so it is one conversation rather than three.

I have attached a one-page summary of how those pieces fit together.

No obligation and no sales process. Keep my number for the week it is useful.

Best regards,
${SIG_NAME}
${SIG_ROLE}
${SIG_MAIL} · ${SIG_TEL}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('Good to meet you at CPHI in Milan.'),
        p('Short and useful rather than a pitch: Abiozen holds several hundred products across our supplier network, and sourcing is the thing we are fastest at. If you are ever short a molecule — a supplier slipping, a qualification falling through, a volume you cannot cover — send it to me and I will tell you honestly whether we can help and how quickly.'),
        p('What we cover: <strong>research chemicals</strong> and <strong>generic APIs</strong>, and we are not limited to a single therapeutic area. Where it helps, the material arrives with its regulatory documentation, and analytical testing can be arranged through the partner laboratories we are onboarding — so it is one conversation rather than three.'),
        p('I have attached a one-page summary of how those pieces fit together.'),
        p('No obligation and no sales process. Keep my number for the week it is useful.'),
      ].join('\n')),
    },
    {
      step: 2, delayDays: 8, attach: false,
      subject: null,
      text: ({ first }) => `Hi ${first},

Following up once, then I will leave it with you.

Would our product list be useful to have on file? Most people would rather know what we hold before the week they need it than go looking mid-shortage.

Say the word and I will send it over.

Best regards,
${SIG_NAME}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('Following up once, then I will leave it with you.'),
        p('Would our product list be useful to have on file? Most people would rather know what we hold before the week they need it than go looking mid-shortage.'),
        p('Say the word and I will send it over.'),
      ].join('\n')),
    },
  ],
};

// ── PARTNER ───────────────────────────────────────────────────────────────────
//
// THIS SEQUENCE'S JOB IS TO CREATE THE SEGMENT, NOT TO ASSUME IT.
//
// Naren wants QC-testing partners and operations/facilities partners treated as two groups, with
// facilities weighted to Europe. They are two different businesses — but nobody has told us which
// firms do which. Almac, Thermo Fisher and Cambrex said their ANALYTICAL units could support the
// model; none of them said anything about repack and relabel.
//
// Splitting the list before that fact exists would mean guessing, and a partner asked the wrong
// question in the first follow-up after a handshake is a worse outcome than a question that is
// honestly open. So one sequence asks which, and the answer is what makes the two segments.
//
// The geography asymmetry IS stated, because it is real and it shapes their answer: material
// handling has to be near the material, analytical testing has to be near the client's reviewers.
const partner = {
  key: 'partner',
  label: 'Partner · which capability',
  steps: [
    {
      step: 1, delayDays: 0, attach: true,
      subject: 'CPHI Milan follow-up — a question about your capabilities',
      text: ({ first }) => `Hi ${first},

Thank you for the conversation at CPHI in Milan.

I would like to understand which side of your capability fits what we are building, because they are two quite different things and I do not want to assume:

1. Analytical quality control — identity, assay, impurities and release testing against pharmacopoeial methods. Location matters here only in that testing should be validated where our client's own reviewers sit, so this can be anywhere we have clients: Europe, the United States, elsewhere.

2. Operations — physical handling of material: controlled storage, repackaging, relabelling, and the documentation that goes with it. This has to be near the material, and our nearest-term need is in Europe.

If you do either, I would like to know your accreditations, where the site is, and what turnaround looks like. If you do both, better still.

Assuming the capability fits, I would rather have the commercial conversation early than after a pilot: how work would reach you, what volume your site could absorb, how you would want pricing structured, and the form of agreement you normally work under. We are onboarding testing and operations partners as working relationships rather than buying one-off services, so those answers shape what we build around you.

I have attached a one-page summary of how the pieces fit together.

Best regards,
${SIG_NAME}
${SIG_ROLE}
${SIG_MAIL} · ${SIG_TEL}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('Thank you for the conversation at CPHI in Milan.'),
        p('I would like to understand which side of your capability fits what we are building, because they are two quite different things and I do not want to assume:'),
        ol([
          '<strong>Analytical quality control</strong> — identity, assay, impurities and release testing against pharmacopoeial methods. Location matters here only in that testing should be validated where our client&rsquo;s own reviewers sit, so this can be anywhere we have clients: Europe, the United States, elsewhere.',
          '<strong>Operations</strong> — physical handling of material: controlled storage, repackaging, relabelling, and the documentation that goes with it. This has to be near the material, and our nearest-term need is in Europe.',
        ]),
        p('If you do either, I would like to know your accreditations, where the site is, and what turnaround looks like. If you do both, better still.'),
        p('Assuming the capability fits, I would rather have the commercial conversation early than after a pilot: how work would reach you, what volume your site could absorb, how you would want pricing structured, and the form of agreement you normally work under. We are onboarding testing and operations partners as working relationships rather than buying one-off services, so those answers shape what we build around you.'),
        p('I have attached a one-page summary of how the pieces fit together.'),
      ].join('\n')),
    },
    {
      step: 2, delayDays: 7, attach: false,
      subject: null,
      text: ({ first }) => `Hi ${first},

Checking this reached you.

The question in one line: do you do analytical QC testing, material handling — storage, repack, relabel — or both? A one-line answer is enough and I will take it from there.

Best regards,
${SIG_NAME}`,
      html: ({ first }) => wrap([
        p(`Hi ${first},`),
        p('Checking this reached you.'),
        p('The question in one line: do you do analytical QC testing, material handling — storage, repack, relabel — or both? A one-line answer is enough and I will take it from there.'),
      ].join('\n')),
    },
  ],
};

const CAMPAIGNS = { supplier, buyer, partner };

/** The CPHI roles that feed each campaign. qc_lab and platform_partner both land in `partner`. */
const ROLE_TO_CAMPAIGN = {
  supplier: 'supplier',
  buyer: 'buyer',
  qc_lab: 'partner',
  platform_partner: 'partner',
};

/** Render one step for one contact. Throws rather than rendering a placeholder. */
function render(campaignKey, stepNumber, vars) {
  const c = CAMPAIGNS[campaignKey];
  if (!c) throw new Error(`unknown campaign "${campaignKey}"`);
  const s = c.steps.find((x) => x.step === stepNumber);
  if (!s) throw new Error(`campaign "${campaignKey}" has no step ${stepNumber}`);
  if (!vars || !vars.first || !String(vars.first).trim()) {
    // A greeting is the first thing read. "Hi ," or "Hi {{first_name}}," on a follow-up to somebody
    // met four days ago is worse than not sending at all, so this is fatal rather than defaulted.
    throw new Error('a first name is required to render a greeting');
  }
  return {
    subject: s.subject,
    text: s.text(vars),
    html: s.html(vars),
    attach: !!s.attach,
    isFollowUp: s.subject === null,
  };
}

const stepsOf = (key) => (CAMPAIGNS[key] ? CAMPAIGNS[key].steps.map((s) => s.step) : []);
const stepDef = (key, n) => (CAMPAIGNS[key] || { steps: [] }).steps.find((s) => s.step === n) || null;

module.exports = { CAMPAIGNS, ROLE_TO_CAMPAIGN, render, stepsOf, stepDef, SIG_NAME, SIG_MAIL };
