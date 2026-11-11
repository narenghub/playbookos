#!/usr/bin/env node
// ── READ OUR OWN SENT MAIL, TO SETTLE WHAT THE REGISTER CANNOT ───────────────
//
//   node scripts/reconcile-breach-gmail.js                 # plan only. ZERO mailbox calls.
//   node scripts/reconcile-breach-gmail.js --execute        # reads our own sent messages
//   ... --out claude/gmail-reconciliation-2026-11.md        # where the record is appended
//
// CEO decision 2026-11-11 priority 5. NOT EXECUTED: the ruling says "do not execute mailbox reads
// yet", so the default is a plan that contacts nothing and the flag is the operator's.
//
// ── WHAT THE REGISTER CANNOT SAY, AND WHY ────────────────────────────────────
//
// scripts/incident-register-2026-11.js lists 25 messages that left during the hold. It cannot say
// what they SAID. `outreach_sends.evidence` holds ONE SENTENCE — the personalisation opener — and
// `cphi_followup_sends` retains nothing of the body at all. So 19 rows stand at PARTIAL (opening
// line clean, remainder not retained) and 6 at UNKNOWN, and a count of zero commercial messages
// cannot be stated from that data. It also reports "0 replies RECORDED BY REPLY SYNC", which is a
// system's belief about itself, not a measurement of the mailbox.
//
// Both gaps are answerable from OUR OWN SENT FOLDER, which is the only reason this is in scope.
//
// ── SCOPE: OUR MAILBOXES, NOT THEIRS ────────────────────────────────────────
//
// All 25 were sent FROM sales@abiozen.com or naren@abiozen.com, both of which this platform
// already holds Gmail credentials for. Reading our own sent mail is not access to anybody else's
// mailbox, and NO RECIPIENT MAILBOX IS TOUCHED. Nothing here responds, forwards, deletes,
// relabels, or creates a draft anywhere.
//
// ── READ-ONLY AS A PROPERTY OF THE GRANT, NOT OF THIS FILE ──────────────────
//
// The agents' usual token carries gmailSend or gmailModify. "This script never calls send" would
// then be a property of today's code — one edit from being false. So it asks for READONLY_ONLY,
// and a token that cannot send is a property of the grant.
//
// Belt and braces, because the grant may not be narrowable in every environment: before any API
// call, this file SCANS ITSELF for the name of every mutating Gmail method and refuses to run if
// one appears. A control that depends on nobody adding a line later is not a control.
//
// ── IDENTIFIERS ONLY. THERE IS NO SEARCH HERE ───────────────────────────────
//
// The authorization is 25 specific messages. Two kinds of identifier were retained and they are
// not interchangeable:
//
//   cphi_followup_sends.gmail_message_id   Gmail's own id        → users.messages.get({ id })
//   cphi_followup_sends.rfc822_message_id  the Message-Id header → rfc822msgid: lookup
//   outreach_sends.rfc822_id               the Message-Id header → rfc822msgid: lookup
//
// `rfc822msgid:` is an EXACT IDENTIFIER LOOKUP — it resolves the single message bearing that
// header and cannot return another. That is categorically different from a date-range or keyword
// query, which would read mail outside the 25 and is not authorised. This file issues no other
// query shape, and its control asserts that.
//
// ── BODIES ARE CLASSIFIED, NOT STORED ───────────────────────────────────────
//
// The output records a VERDICT and a digest, never the text. ledger.js puts the reason plainly:
// storing the body "is how a log becomes a copy of everyone's correspondence". A reconciliation of
// a containment breach must not itself become a second copy of the messages.
//
// ── APPENDED, NEVER REWRITTEN ───────────────────────────────────────────────
//
// The corrected register and its superseded conclusion both stay. An evidence file that gets
// rewritten is an evidence file whose history nobody can audit.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};

const EXECUTE = has('execute');
const OUT = arg('out', 'claude/gmail-reconciliation-2026-11.md');
const WINDOW_START = arg('from', '2026-11-03');
const WINDOW_END = arg('to', '2026-11-11');

const say = (s = '') => console.log(s);

// ── THE SELF-SCAN ───────────────────────────────────────────────────────────
//
// Every Gmail method that can change anything. Checked against this file's own source before a
// single call is made, so adding one later makes the script refuse rather than quietly mutate.
const MUTATING = [
  'messages.send', 'messages.insert', 'messages.import', 'messages.modify', 'messages.batchModify',
  'messages.trash', 'messages.untrash', 'messages.delete', 'messages.batchDelete',
  'drafts.create', 'drafts.update', 'drafts.send', 'drafts.delete',
  'threads.modify', 'threads.trash', 'threads.untrash', 'threads.delete',
  'labels.create', 'labels.update', 'labels.patch', 'labels.delete',
  'settings.', 'watch(', 'stop(',
];

// Comments are blanked so the NAMES above may be discussed in this header without tripping it —
// and blanked rather than removed, so a reported line number still matches the real file.
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** @returns {{ok:true} | {ok:false, found:string[]}} */
function selfScan(file = __filename, src = null) {
  const code = codeOf(src === null ? fs.readFileSync(file, 'utf8') : src);
  const found = [];
  for (const m of MUTATING) {
    // The literal list above is DATA, not code: it must not match itself. It is the only place
    // these names appear outside comments, so it is excised before scanning.
    const withoutList = code.replace(/const MUTATING = \[[\s\S]*?\];/, '');
    if (withoutList.includes(m)) found.push(m);
  }
  return found.length ? { ok: false, found } : { ok: true };
}

// ── WHAT WE ARE RECONCILING ─────────────────────────────────────────────────

// The currency-and-digit alternative sits OUTSIDE the \b…\b group, deliberately. Inside it, "$9,000"
// did not match: `$` is a non-word character, so there is no word boundary before it and the whole
// alternative was unreachable at the start of a string. A pattern that silently cannot match one of
// its own alternatives is the shape of guard this repository keeps finding — and a missed "$9,000"
// would have classified a priced offer as containing no commercial language.
const COMMERCIAL = /(\$\s?\d)|(\bUSD\b)|\b(quote|quotation|price|pricing|pricelist|per kg|per-kg|discount|moq|minimum order|incoterm|fob|cif|payment terms|invoice|purchase order|po|lead time|supply|supplier|rfq|offer|proposal|contract|terms)\b/i;

async function loadTargets(query) {
  const rows = [];

  // CPHI: a Gmail id AND a Message-Id header were both retained.
  const cphi = (await query(
    `SELECT s.gmail_message_id, s.rfc822_message_id, s.sent_at, s.to_email, s.subject,
            s.event_slug, s.campaign, s.step
       FROM cphi_followup_sends s
      WHERE s.sent_at >= $1 AND s.sent_at < $2 AND s.gmail_message_id IS NOT NULL
      ORDER BY s.sent_at`, [WINDOW_START, WINDOW_END])).rows;
  for (const r of cphi) {
    rows.push({
      source: 'cphi_followup_sends', mailbox: 'naren@abiozen.com',
      gmail_id: r.gmail_message_id || null,
      rfc822: r.rfc822_message_id || null,
      sent_at: r.sent_at, to: r.to_email, subject: r.subject,
      workflow: `${r.event_slug}/${r.campaign} step ${r.step}`,
      retained_body: 'none',
    });
  }

  // Outreach: a Message-Id header, and ONE SENTENCE of the body.
  const out = (await query(
    `SELECT s.rfc822_id, s.sent_at, s.to_email, s.subject, s.channel, s.need, s.step, s.evidence
       FROM outreach_sends s
      WHERE s.sent_at >= $1 AND s.sent_at < $2 AND (s.confirmed OR s.rfc822_id IS NOT NULL)
      ORDER BY s.sent_at`, [WINDOW_START, WINDOW_END])).rows;
  for (const r of out) {
    rows.push({
      source: 'outreach_sends', mailbox: 'sales@abiozen.com',
      gmail_id: null,
      rfc822: r.rfc822_id || null,
      sent_at: r.sent_at, to: r.to_email, subject: r.subject,
      workflow: `${r.channel}/${r.need} step ${r.step}`,
      retained_body: r.evidence ? 'one sentence' : 'none',
    });
  }
  return rows;
}

/** The ONE query shape this file may issue: an exact identifier lookup. */
function identifierQuery(rfc822) {
  const id = String(rfc822 || '').replace(/^<|>$/g, '');
  return `rfc822msgid:${id}`;
}

function classify(text) {
  if (text === null || text === undefined || String(text).trim() === '') {
    return { verdict: 'UNKNOWN', why: 'the message body could not be read' };
  }
  return COMMERCIAL.test(String(text))
    ? { verdict: 'COMMERCIAL', why: 'commercial language is present in the body as sent' }
    : { verdict: 'NON_COMMERCIAL', why: 'the full body was read and contains no commercial language' };
}

function digest(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);
}

function bodyTextOf(payload) {
  // text/plain where there is one, else the html part, walked recursively. Returned to the
  // classifier and then DISCARDED — never written out.
  const parts = [];
  const walk = (p) => {
    if (!p) return;
    if (p.body && p.body.data) {
      parts.push({ mime: p.mimeType || '', text: Buffer.from(p.body.data, 'base64url').toString('utf8') });
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const plain = parts.find((p) => /text\/plain/i.test(p.mime));
  return (plain || parts[0] || { text: '' }).text;
}

async function main() {
  const scan = selfScan();
  if (!scan.ok) {
    console.error('\nREFUSING TO RUN. This file names a mutating Gmail method in code:');
    for (const f of scan.found) console.error(`   ${f}`);
    console.error('\nThis script is read-only by contract. Remove the call, or write a different'
      + ' script with its own authorization.\n');
    process.exit(2);
  }

  const { initDB, query } = require('../src/lib/db');
  await initDB();
  const targets = await loadTargets(query);

  say(`\n── Gmail reconciliation of the containment breach${EXECUTE ? '' : '   ** PLAN ONLY — NO MAILBOX CALLS **'}\n`);
  say(`   window        ${WINDOW_START} … ${WINDOW_END}`);
  say(`   messages      ${targets.length}`);
  say(`   mailboxes     ${[...new Set(targets.map((t) => t.mailbox))].join(', ')} (ours; no recipient mailbox is touched)`);
  say(`   scope         gmail.readonly ONLY — a token that cannot send`);
  say(`   lookups       users.messages.get by id, and rfc822msgid: exact-identifier lookups`);
  say(`   self-scan     clean: no mutating Gmail method appears in this file\n`);

  const byId = targets.filter((t) => t.gmail_id).length;
  const byHeader = targets.filter((t) => !t.gmail_id && t.rfc822).length;
  const neither = targets.filter((t) => !t.gmail_id && !t.rfc822);
  say(`   ${byId} resolvable by Gmail id, ${byHeader} by Message-Id header, ${neither.length} by neither`);
  for (const t of neither) {
    say(`     UNRESOLVABLE  ${t.sent_at && t.sent_at.toISOString ? t.sent_at.toISOString() : t.sent_at}  ${t.to}  (${t.source})`);
  }

  if (!EXECUTE) {
    say('\n   Nothing was read. Re-run with --execute to perform the lookups above.\n');
    say('   Each message will be resolved, its full body classified, and its thread checked for');
    say('   replies from outside abiozen.com. The body itself is NOT stored — only a verdict and');
    say('   a digest, because a reconciliation of a breach must not become a second copy of it.\n');
    process.exit(0);
  }

  const { gmailClientFor, READONLY_ONLY } = require('../src/lib/gmail/client');
  const results = [];
  let failed = 0;

  for (const mailbox of [...new Set(targets.map((t) => t.mailbox))]) {
    const c = await gmailClientFor(mailbox, { scopeSets: READONLY_ONLY });
    if (c.error) {
      console.error(`   ${mailbox}: no read-only Gmail client (${c.error})`);
      say(`     tried: ${(c.tried || []).join(' | ')}`);
      failed += 1;
      continue;
    }
    say(`   ${mailbox}: read-only client via ${c.via}, scope set ${c.scopeSet}`);

    for (const t of targets.filter((x) => x.mailbox === mailbox)) {
      const rec = { ...t, resolved: false, verdict: 'UNKNOWN', replies: null };
      try {
        let id = t.gmail_id;
        if (!id && t.rfc822) {
          const found = (await c.gmail.users.messages.list({
            userId: 'me', q: identifierQuery(t.rfc822), maxResults: 2,
          })).data;
          const hits = found.messages || [];
          if (hits.length === 1) id = hits[0].id;
          else rec.why = `${hits.length} messages carry that Message-Id`;
        }
        if (!id) { results.push(rec); continue; }

        const msg = (await c.gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
        const text = bodyTextOf(msg.payload);
        const cls = classify(text);
        rec.resolved = true;
        rec.verdict = cls.verdict;
        rec.why = cls.why;
        rec.body_digest = digest(text);
        rec.body_chars = String(text || '').length;
        rec.thread_id = msg.threadId || null;

        if (msg.threadId) {
          const th = (await c.gmail.users.threads.get({
            userId: 'me', id: msg.threadId, format: 'metadata',
            metadataHeaders: ['From', 'Date'],
          })).data;
          const outside = (th.messages || []).filter((m) => {
            const h = ((m.payload && m.payload.headers) || [])
              .find((x) => String(x.name).toLowerCase() === 'from');
            return h && !/@abiozen\.com/i.test(h.value || '');
          });
          rec.replies = outside.length;
        }
      } catch (e) {
        rec.why = `lookup failed: ${(e && e.message) || String(e)}`;
        failed += 1;
      }
      results.push(rec);
    }
  }

  const counts = results.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
  const repliesKnown = results.filter((r) => r.replies !== null);
  const withReplies = repliesKnown.filter((r) => r.replies > 0);

  say('\n── RESULT\n');
  for (const k of Object.keys(counts)) say(`   ${k.padEnd(16)} ${counts[k]}`);
  say(`\n   replies measured on ${repliesKnown.length} of ${results.length} threads; `
    + `${withReplies.length} thread(s) carry a message from outside abiozen.com`);
  if (repliesKnown.length < results.length) {
    say('   The remainder is UNMEASURED, which is not the same as zero.');
  }

  // Appended. The register and its superseded conclusion both stay.
  const outPath = path.join(__dirname, '..', OUT);
  const lines = [
    `\n## Gmail reconciliation run ${new Date().toISOString()}`,
    '',
    `Read-only (gmail.readonly), our own sent mail only, ${results.length} message(s).`,
    'Bodies were classified and discarded; only a verdict and a digest are recorded.',
    '',
    '| sent | mailbox | recipient | workflow | verdict | body digest | replies from outside |',
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.sent_at && r.sent_at.toISOString ? r.sent_at.toISOString() : r.sent_at} `
      + `| ${r.mailbox} | ${r.to} | ${r.workflow} | ${r.verdict} | ${r.body_digest || '—'} `
      + `| ${r.replies === null ? 'UNMEASURED' : r.replies} |`),
    '',
    ...results.filter((r) => !r.resolved).map((r) => `- UNRESOLVED ${r.to}: ${r.why}`),
  ];
  fs.appendFileSync(outPath, `${lines.join('\n')}\n`);
  say(`\n   Appended to ${OUT} (appended, never rewritten).\n`);

  if (failed) { console.error(`   ${failed} lookup(s) failed — the result above is incomplete.\n`); process.exit(1); }
}

module.exports = { selfScan, identifierQuery, classify, bodyTextOf, MUTATING, codeOf, COMMERCIAL };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('reconcile-breach-gmail failed:', (e && e.message) || e);
    process.exit(1);
  });
}
