// ── INQUIRY TRIAGE: CLASSIFY, LABEL, AND DRAFT. NEVER SEND. ─────────────────
//
// Owner decision, 2026-11-09. Asked for an auto-responder on sales@abiozen.com, shown that
// inquiry-agent.js already does exactly that and has been stopped since 2026-11-03, the owner
// chose the narrower thing: every inbound message is classified, labelled and answered with a
// DRAFT sitting in its own thread. A human opens Gmail, reads it, edits it, and presses send.
//
// ── WHY NOT AUTO-SEND, IN ONE EXAMPLE ────────────────────────────────────────
//
// On the morning this was written a purchasing manager at a Chinese fine-chemicals manufacturer
// asked Abiozen to quote 1 kg of a chiral auxiliary, CIF Shanghai. An auto-responder would have
// answered it as an ordinary RFQ. The correct reply turned on knowing the compound is a catalogue
// item made cheaply in China, which made the inquiry most likely price benchmarking — and the
// right move was a qualifying question, not a quote. No classifier was going to see that, and the
// cost of getting it wrong is handing your pricing to a competitor.
//
// ── THIS MODULE CANNOT SEND EMAIL, AND THAT IS STRUCTURAL ───────────────────
//
// It does not import the mailer. It touches exactly three Gmail endpoints — labels, modify, and
// drafts — and never /messages/send or /drafts/*/send. inquiry-triage.test.js asserts that by
// reading this file's own source, so the guarantee survives somebody adding a convenience later.
//
// The holds stay up. capability:email.send and the two legacy workflow stops are untouched; this
// module does not check them because it never attempts the thing they stop.

'use strict';

const { getGoogleAccessToken, SCOPES } = require('../google-auth');
const { callClaude } = require('../llm');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users';
const MODEL = 'claude-haiku-4-5-20251001';

const SALES_MAILBOX = () => process.env.SALES_MAILBOX_EMAIL || 'sales@abiozen.com';

// The categories the owner asked for. `spam` is included because a triage that cannot say "this is
// junk" ends up drafting polite replies to junk, which is worse than doing nothing.
const CATEGORIES = Object.freeze(['inquiry', 'rfq', 'buyer', 'supplier', 'spam']);

// Gmail label names. Nested under one parent so they can be collapsed, coloured or filtered as a
// group, and so they never collide with a label somebody already made.
const LABEL_PREFIX = 'PlayNexa';
const labelFor = (category) => `${LABEL_PREFIX}/${category}`;

// What the drafts may and may not contain. These are the terms the owner has actually stated; a
// draft that invents a price or a lead time is worse than no draft, because it reads as checked.
const DRAFTING_RULES = `
You are drafting a reply for a human at Abiozen LLC to review, edit and send. You are NOT sending.

ABOUT ABIOZEN
- Pharmaceutical CRO and e-commerce marketplace. Procures, repackages, stores and distributes
  research chemicals and generic active pharmaceutical ingredients (APIs).
- Holds ISO 9001:2015 (certificate 300626010114, ARS Assessment Private Limited, UAF CB-MS-3923)
  and ISO/IEC 27001:2022 (certificate 300626050115). Both valid to 2029-06-29.
- Does NOT hold ISO/IEC 17025, GLP or GCP. A partner manufacturer holds those; they are the
  partner's, never Abiozen's.
- Does NOT hold FDA establishment registration, DEA registration, or a state wholesale drug
  distributor licence.

HARD RULES
- NEVER state a price, a discount, or a lead time. Abiozen sources to order and no price list
  exists. Ask what is needed to quote; do not quote.
- NEVER claim a certification, accreditation or licence not listed above. If a buyer asks for one
  Abiozen does not hold, say so plainly and offer what is held.
- NEVER promise a delivery date, a batch, or stock on hand.
- Batch-specific COA and SDS are issued on lot allocation against a confirmed order; say that
  rather than attaching or promising documents.
- First orders from new overseas counterparties are 100% advance payment by T/T.
- Do not invent a signatory. End with "Naren B / Abiozen LLC" and nothing else.
- If the message is spam, a marketing blast, or an attempt to sell TO Abiozen, draft nothing of
  substance: return a one-line note saying no reply is needed.

WHAT A GOOD DRAFT DOES
- Answers what was actually asked.
- Asks the specific questions needed before a quotation is possible: exact specification and
  purity, quantity and whether it recurs, destination and incoterms, required documentation.
- Is short. Six sentences is usually enough.
`.trim();

// ── Gmail helpers, deliberately small ───────────────────────────────────────

async function token() {
  // gmailModify covers reading, applying labels and creating drafts. gmailSend is NOT requested:
  // a token that cannot send is a stronger guarantee than code that chooses not to.
  return getGoogleAccessToken({
    subject: SALES_MAILBOX(),
    scopes: [SCOPES.gmailReadonly, SCOPES.gmailModify],
  });
}

async function gapi(path, { accessToken, method = 'GET', body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${GMAIL}/${encodeURIComponent(SALES_MAILBOX())}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`Gmail ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

function header(payload, name) {
  const h = ((payload || {}).headers || []).find(
    (x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/** Depth-first for the first text/plain part; falls back to text/html stripped. */
function bodyText(payload) {
  const decode = (d) => Buffer.from(String(d).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    .toString('utf8');
  const walk = (p, mime) => {
    if (!p) return '';
    if (p.mimeType === mime && p.body && p.body.data) return decode(p.body.data);
    for (const part of p.parts || []) {
      const got = walk(part, mime);
      if (got) return got;
    }
    return '';
  };
  const plain = walk(payload, 'text/plain');
  if (plain) return plain;
  const html = walk(payload, 'text/html');
  return html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** Ensure every category label exists; returns name → labelId. */
async function ensureLabels(accessToken, { fetchImpl = fetch } = {}) {
  const existing = await gapi('/labels', { accessToken, fetchImpl });
  const byName = new Map((existing.labels || []).map((l) => [l.name, l.id]));
  const ids = {};
  for (const c of CATEGORIES) {
    const name = labelFor(c);
    if (byName.has(name)) { ids[c] = byName.get(name); continue; }
    const made = await gapi('/labels', {
      accessToken, method: 'POST', fetchImpl,
      body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    ids[c] = made.id;
  }
  return ids;
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * A cheap, deterministic first pass. It exists so the obvious cases never cost an LLM call and
 * never depend on one being available — and so a classifier outage degrades to "unlabelled",
 * not to "everything is an inquiry".
 *
 * Returns a category or null when it is genuinely unsure, which is most of the time.
 */
function heuristicCategory({ from = '', subject = '', body = '' }) {
  const text = `${subject}\n${body}`.toLowerCase();
  const sender = String(from).toLowerCase();

  if (/\b(unsubscribe|viagra|crypto|seo services|guest post|backlink|loan offer)\b/.test(text)) {
    return 'spam';
  }
  // Someone selling TO Abiozen. "We are a manufacturer of…" is the giveaway, and it is the
  // category most often mislabelled as a buyer inquiry because it is full of product nouns.
  if (/\b(we are a (leading )?(manufacturer|supplier|factory|exporter)|our company (produces|manufactures)|we can supply you|offer you our products)\b/.test(text)) {
    return 'supplier';
  }
  if (/\b(rfq|request for quotation|quotation request|please quote|kindly quote|pricelist|price list)\b/.test(text)) {
    return 'rfq';
  }
  if (/\b(purchase order|p\.?o\.? number|proforma|pro forma invoice|payment (made|sent)|order confirmation)\b/.test(text)) {
    return 'buyer';
  }
  if (/@(abiozen|adificetechnologies)\.com$/.test(sender)) return null; // internal, leave alone
  return null;
}

/**
 * Classify with Claude when the heuristics abstain. Returns { category, confidence, why }.
 * A failed or unparseable call returns category null — unlabelled and undrafted, never guessed.
 */
async function classify(msg, { model = MODEL, claude = callClaude } = {}) {
  const quick = heuristicCategory(msg);
  if (quick) return { category: quick, confidence: 'heuristic', why: 'matched a deterministic rule' };

  const r = await claude({
    model,
    system: 'You classify inbound business email for a pharmaceutical CRO and chemical '
      + 'distributor. Answer with JSON only.',
    prompt: `Classify this email into exactly one category: ${CATEGORIES.join(', ')}.

- inquiry  : a general question about products, services or capabilities
- rfq      : a specific request to quote a named product or service
- buyer    : an existing or committed customer — orders, POs, payments, shipping
- supplier : someone selling TO Abiozen
- spam     : bulk marketing, irrelevant, or fraudulent

From: ${msg.from}
Subject: ${msg.subject}

${String(msg.body || '').slice(0, 4000)}

Reply with JSON: {"category":"...","why":"one short sentence"}`,
    maxTokens: 200,
    expectJson: true,
  });

  if (!r || r.error) return { category: null, confidence: 'failed', why: (r && r.error) || 'no response' };
  const parsed = r.json || (() => { try { return JSON.parse(r.text); } catch { return null; } })();
  const category = parsed && CATEGORIES.includes(parsed.category) ? parsed.category : null;
  return { category, confidence: category ? 'model' : 'unparsed', why: (parsed && parsed.why) || '' };
}

// ── Drafting ────────────────────────────────────────────────────────────────

/** RFC 2822 for a reply, base64url for the Gmail drafts endpoint. */
function buildRawReply({ to, subject, inReplyTo, references, bodyTextOut }) {
  const subj = /^re:/i.test(subject || '') ? subject : `Re: ${subject || '(no subject)'}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${subj}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references || inReplyTo}`] : []),
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    bodyTextOut,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function draftReply(msg, category, { model = MODEL, claude = callClaude } = {}) {
  if (category === 'spam') return { skip: true, reason: 'spam — no reply drafted' };
  const r = await claude({
    model,
    system: DRAFTING_RULES,
    prompt: `Draft a reply to this ${category} email. Plain text only, no subject line, no
markdown. End with "Best regards,\n\nNaren B\nAbiozen LLC".

From: ${msg.from}
Subject: ${msg.subject}

${String(msg.body || '').slice(0, 6000)}`,
    maxTokens: 900,
  });
  if (!r || r.error) return { skip: true, reason: `draft failed: ${(r && r.error) || 'no response'}` };
  const text = (r.text || '').trim();
  if (!text) return { skip: true, reason: 'model returned nothing' };
  return { text };
}

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * Poll, classify, label and draft.
 *
 * @returns {{ok, checked, labelled, drafted, skipped, errors, samples}}
 */
async function run({
  maxMessages = 25, query: q = 'newer_than:2d -in:chats', dryRun = false,
  fetchImpl = fetch, claude = callClaude, log = () => {},
} = {}) {
  const out = {
    ok: true, checked: 0, labelled: 0, drafted: 0, skipped: 0, errors: [], samples: [],
    mailbox: SALES_MAILBOX(), dry_run: dryRun,
  };

  const tok = await token();
  if (!tok || tok.error || !tok.access_token) {
    out.ok = false;
    out.errors.push(`google auth: ${(tok && tok.error) || 'no token'} — the service account must be `
      + `able to impersonate ${SALES_MAILBOX()} with gmail.modify`);
    return out;
  }
  const accessToken = tok.access_token;

  const labelIds = dryRun ? {} : await ensureLabels(accessToken, { fetchImpl });

  const list = await gapi(
    `/messages?q=${encodeURIComponent(q)}&maxResults=${maxMessages}`, { accessToken, fetchImpl });
  const refs = list.messages || [];
  log(`  ${refs.length} message(s) in scope`);

  for (const ref of refs) {
    try {
      const full = await gapi(`/messages/${ref.id}?format=full`, { accessToken, fetchImpl });
      const msg = {
        id: ref.id,
        threadId: full.threadId,
        from: header(full.payload, 'From'),
        subject: header(full.payload, 'Subject'),
        messageId: header(full.payload, 'Message-ID'),
        references: header(full.payload, 'References'),
        body: bodyText(full.payload) || full.snippet || '',
      };
      out.checked += 1;

      // A message this run already has our label on has been triaged before. Re-drafting it would
      // pile duplicate drafts into the thread every fifteen minutes.
      const already = (full.labelIds || []).some((id) => Object.values(labelIds).includes(id));
      if (already) { out.skipped += 1; continue; }

      const { category, confidence, why } = await classify(msg, { claude });
      if (!category) {
        out.skipped += 1;
        out.samples.push({ subject: msg.subject.slice(0, 60), category: null, note: why });
        continue;
      }

      if (!dryRun) {
        await gapi(`/messages/${msg.id}/modify`, {
          accessToken, method: 'POST', fetchImpl, body: { addLabelIds: [labelIds[category]] },
        });
      }
      out.labelled += 1;

      const draft = await draftReply(msg, category, { claude });
      if (draft.skip) {
        out.samples.push({ subject: msg.subject.slice(0, 60), category, note: draft.reason });
        continue;
      }

      if (!dryRun) {
        await gapi('/drafts', {
          accessToken, method: 'POST', fetchImpl,
          body: {
            message: {
              threadId: msg.threadId,
              raw: buildRawReply({
                to: msg.from,
                subject: msg.subject,
                inReplyTo: msg.messageId,
                references: msg.references,
                bodyTextOut: draft.text,
              }),
            },
          },
        });
      }
      out.drafted += 1;
      out.samples.push({
        subject: msg.subject.slice(0, 60), category, confidence, note: 'draft created',
      });
    } catch (e) {
      out.errors.push(`${ref.id}: ${e.message}`);
    }
  }
  return out;
}

module.exports = {
  run, classify, heuristicCategory, draftReply, ensureLabels, buildRawReply,
  bodyText, header, CATEGORIES, labelFor, SALES_MAILBOX, DRAFTING_RULES,
};
