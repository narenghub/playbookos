#!/usr/bin/env node
// ── CAN WE ACTUALLY SEND AS THE ADDRESSES THE CODE SENDS AS? ──────────────────
//
//   railway ssh 'node scripts/check-mail-senders.js'      → exit 0 = every sender is authorized
//
// READ ONLY. Lists the domains the Resend key is authorized for and compares them against every
// From address in the codebase. No email is sent.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// From src/lib/mailer.js, written when it was found:
//
//     The default sender was `PlayNexa <naren@abiozen.com>` and it had been FAILING SINCE
//     4 AUGUST 2026. The Resend key is alive and restricted to sending; it is authorized for
//     adificetechnologies.com and NOT for abiozen.com:
//         403  This API key is not authorized to send emails from abiozen.com
//     1,113 internal emails were lost to that over eight weeks — the 6pm score, the coaching
//     emails, the briefings — and nothing surfaced it.
//
// The default was moved to a domain the key holds. But two senders were deliberately left on
// abiozen.com, because they are Abiozen's and nothing else would be right:
//
//     procurement-agent.js   supplier RFQs as palash@abiozen.com
//     inquiry-agent.js       buyer replies as sales@abiozen.com
//
// Those are the only two senders in the platform that speak to people OUTSIDE the company, and
// if the domain is still unauthorized they are both still 403ing — which means every supplier RFQ
// and every buyer reply the platform has tried to send has gone nowhere.
//
// That is not something to settle by re-reading a comment written weeks ago. This asks Resend.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };

// Every From address the platform can send as, with what breaks if it cannot.
const SENDERS = [
  { addr: process.env.MAIL_FROM || 'no-reply@adificetechnologies.com',
    what: 'the default sender — every internal email: 6pm scores, coaching, briefings',
    source: 'src/lib/mailer.js DEFAULT_FROM / MAIL_FROM' },
  { addr: 'palash@abiozen.com',
    what: 'SUPPLIER RFQs — outside the company',
    source: 'src/lib/agents/procurement-agent.js' },
  { addr: 'sales@abiozen.com',
    what: 'BUYER replies — outside the company',
    source: 'src/lib/agents/inquiry-agent.js' },
  { addr: process.env.RESEND_FROM || 'naren@abiozen.com',
    what: 'RESEND_FROM, used where a sender is not set explicitly',
    source: 'Railway env RESEND_FROM' },
];

const domainOf = (addr) => {
  const m = /<?([^<>\s]+@([^<>\s]+))>?$/.exec(String(addr).trim());
  return m ? m[2].toLowerCase() : null;
};

async function resendDomains() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { error: 'RESEND_API_KEY is not set in this environment' };
  // Node 18+ has fetch. No dependency added for a read-only call.
  let res;
  try {
    res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    return { error: `could not reach api.resend.com: ${e.message}` };
  }
  const body = await res.text();
  if (!res.ok) return { error: `Resend returned ${res.status}: ${body.slice(0, 300)}` };
  let json;
  try { json = JSON.parse(body); } catch (e) { return { error: `unparseable response: ${body.slice(0, 200)}` }; }
  return { domains: json.data || json || [] };
}

async function main() {
  console.log('── mail senders · can the Resend key send as each From address?\n');

  const { domains, error } = await resendDomains();
  if (error) {
    // A key that cannot be checked is NOT a key that works. The whole point of this script is to
    // stop "probably fine" standing in for an answer.
    bad('list the authorized domains', error);
    console.log('\n   Without the domain list nothing below can be verified. Check RESEND_API_KEY,');
    console.log('   or read the domains at https://resend.com/domains and compare by hand.\n');
    process.exit(1);
  }

  const authorized = new Map();
  for (const d of domains) {
    authorized.set(String(d.name || '').toLowerCase(), d.status || 'unknown');
  }
  console.log(`   the key is attached to ${authorized.size} domain(s):`);
  for (const [name, status] of authorized) {
    const good = /verified/i.test(status);
    console.log(`      ${good ? '✓' : '✗'} ${name.padEnd(30)} ${status}`);
  }
  if (!authorized.size) {
    console.log('      — none. Every send will 403.');
  }
  console.log();

  // ── EACH SENDER ────
  for (const s of SENDERS) {
    const dom = domainOf(s.addr);
    if (!dom) { bad(`parse the sender ${JSON.stringify(s.addr)}`, s.source); continue; }
    const status = authorized.get(dom);
    if (!status) {
      bad(`${s.addr} — domain ${dom} is NOT on this key`,
        `${s.what}  ·  ${s.source}  →  403 on every send, silently`);
    } else if (!/verified/i.test(status)) {
      bad(`${s.addr} — domain ${dom} is on the key but status is "${status}"`,
        `${s.what}  ·  ${s.source}`);
    } else {
      ok(`${s.addr} — ${dom} verified  ·  ${s.what}`);
    }
  }

  // ── AND THE SILENCE, WHICH WAS THE WORSE HALF ────
  // 1,113 emails were lost because sendEmail() returns false and writes a row nobody reads. If the
  // log is reachable, say what it currently holds rather than leaving that to another script.
  try {
    const { query } = require('../src/lib/db');
    const r = await query(
      `SELECT status, COUNT(*)::int n, MAX(created_at) last
         FROM email_log
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY status ORDER BY n DESC`);
    if (r.rows.length) {
      console.log('\n   email_log, last 30 days:');
      for (const row of r.rows) {
        const when = row.last ? new Date(row.last).toISOString().slice(0, 16).replace('T', ' ') : '';
        console.log(`      ${String(row.status).padEnd(12)} ${String(row.n).padStart(5)}   last ${when}`);
      }
      const failed = r.rows.filter((x) => !/sent|ok|delivered/i.test(x.status))
        .reduce((a, x) => a + x.n, 0);
      if (failed) {
        console.log(`      ⚠ ${failed} message(s) did not send in the last 30 days.`);
      }
    }
  } catch (e) {
    console.log(`\n   (email_log not readable here: ${e.message})`);
  }

  console.log('');
  if (fail) {
    console.log(`FAIL  ${fail} sender(s) cannot send. Authorize the domain at https://resend.com/domains`);
    console.log('      — it is a dashboard task, not a code change. Until then those sends 403.');
  } else {
    console.log('PASS  every From address the platform uses is on a verified domain');
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('check-mail-senders failed:', e && e.message ? e.message : e);
  process.exit(1);
});
