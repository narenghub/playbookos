#!/usr/bin/env node
// ── IS abiozen.com ACTUALLY AUTHORISED TO SEND MAIL? ──────────────────────────
//
//   railway ssh 'node scripts/check-email-auth.js'
//   railway ssh 'node scripts/check-email-auth.js --domain=abiozen.com'
//
// Read-only: DNS lookups and nothing else. Sends no mail, writes no rows.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Of the nine CPHI bounces on 13 Oct, four were the recipient's own server refusing the mail
// rather than a bad address — Cipla, Zydus and Moehs with "5.4.1 Recipient address rejected:
// Access denied" from Microsoft 365, and Olon with "554 5.7.1 Service unavailable; Sender address
// [naren@abiozen.com] blocked". Those are not data-entry problems and no amount of re-reading
// business cards will fix them.
//
// Microsoft 365 tenants are strict about three DNS records. Without them, mail from a young domain
// is rejected at the edge or filed as junk, and the sender is told almost nothing:
//
//   SPF    which servers may send as this domain. Missing or wrong → rejected or junked.
//   DKIM   a signature proving the message was not altered. Google Workspace does NOT sign by
//          default — it has to be switched on in the Admin console, and the DNS record published.
//          This is the one most often missed, because mail flows fine until a strict tenant
//          refuses it.
//   DMARC  what to do when SPF or DKIM fails, and where to send reports. Its absence is itself a
//          negative signal to Microsoft.
//
// This reports what is published. It cannot tell you Google's own DKIM toggle is ON — only that
// the record exists — so a present record with signing disabled is still possible, and the script
// says so rather than declaring victory.
'use strict';

const dns = require('dns').promises;

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const DOMAIN = arg('domain', 'abiozen.com').trim().toLowerCase();
// Google Workspace publishes DKIM at <selector>._domainkey. "google" is its default selector.
const SELECTORS = (arg('selectors', 'google,default,selector1,s1,k1') || '').split(',').map((s) => s.trim()).filter(Boolean);

let problems = 0;
const ok = (m) => console.log(`   ✅ ${m}`);
const bad = (m) => { problems += 1; console.log(`   ✗  ${m}`); };
const warn = (m) => console.log(`   ⚠  ${m}`);

const txt = async (name) => {
  try { return (await dns.resolveTxt(name)).map((r) => r.join('')); }
  catch (e) { return { error: (e && e.code) || String(e) }; }
};

async function main() {
  console.log(`── email authentication for ${DOMAIN}\n`);

  // DNS has to work at all, or every answer below is meaningless.
  try {
    const mx = await dns.resolveMx(DOMAIN);
    if (!mx.length) bad('no MX records — this domain cannot RECEIVE mail');
    else ok(`MX: ${mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).slice(0, 3).join(', ')}`);
  } catch (e) {
    console.log(`   ✗  MX lookup failed (${(e && e.code) || e}).`);
    console.log('      If this host has no DNS at all, nothing below can be trusted — run it elsewhere.');
    process.exit(1);
  }

  // ── SPF ────
  const root = await txt(DOMAIN);
  if (root.error) {
    bad(`cannot read TXT records (${root.error})`);
  } else {
    const spf = root.filter((r) => /^v=spf1/i.test(r));
    if (!spf.length) {
      bad('NO SPF record. Microsoft tenants reject or junk unauthenticated mail from young domains.');
      console.log('      Add a TXT record at the root: "v=spf1 include:_spf.google.com ~all"');
    } else if (spf.length > 1) {
      bad(`${spf.length} SPF records. More than one is INVALID per RFC 7208 — receivers may treat`);
      console.log('      the whole domain as unauthenticated. Merge them into a single record.');
      for (const r of spf) console.log(`      ${r}`);
    } else {
      const r = spf[0];
      const hasGoogle = /include:_spf\.google\.com/i.test(r);
      const all = (r.match(/([-~?+])all\s*$/) || [])[1];
      ok(`SPF: ${r}`);
      if (!hasGoogle) {
        warn('SPF does not include _spf.google.com — mail sent through Google Workspace will FAIL SPF.');
        problems += 1;
      }
      if (all === '+') { warn('SPF ends in "+all", which authorises the whole internet. Use "~all".'); problems += 1; }
      else if (!all) { warn('SPF has no "all" mechanism — behaviour is undefined at some receivers.'); problems += 1; }
      // A lookup count over 10 is a hard SPF failure, and it is easy to exceed with several vendors.
      const lookups = (r.match(/\b(include|a|mx|ptr|exists|redirect)[:=]/gi) || []).length;
      if (lookups > 10) { warn(`SPF needs ~${lookups} DNS lookups; the limit is 10 and over it SPF FAILS.`); problems += 1; }
    }
  }

  // ── DKIM ────
  let foundSelector = null;
  for (const sel of SELECTORS) {
    const r = await txt(`${sel}._domainkey.${DOMAIN}`);
    if (!r.error && r.some((x) => /v=DKIM1|p=/i.test(x))) { foundSelector = sel; break; }
  }
  if (foundSelector) {
    ok(`DKIM published at ${foundSelector}._domainkey.${DOMAIN}`);
    console.log('      NOTE: a published record does not prove Google is SIGNING. Confirm in Admin →');
    console.log('      Apps → Google Workspace → Gmail → Authenticate email that it is switched on.');
  } else {
    bad(`NO DKIM record found (tried ${SELECTORS.join(', ')}).`);
    console.log('      Google Workspace does NOT sign outbound mail until you turn it on. This is the');
    console.log('      most common cause of a Microsoft 365 tenant refusing a young domain, and mail');
    console.log('      keeps flowing to lenient receivers so it goes unnoticed for months.');
    console.log('      Admin → Apps → Google Workspace → Gmail → Authenticate email → Generate,');
    console.log('      publish the TXT record, then Start authentication.');
  }

  // ── DMARC ────
  const dmarc = await txt(`_dmarc.${DOMAIN}`);
  if (dmarc.error || !dmarc.some((r) => /^v=DMARC1/i.test(r))) {
    bad('NO DMARC record. Its absence is itself a negative signal to Microsoft and Google.');
    console.log(`      Add TXT at _dmarc.${DOMAIN}: "v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN}"`);
    console.log('      p=none changes no delivery decisions — it only turns on reporting, which is');
    console.log('      how you find out who is refusing your mail instead of guessing.');
  } else {
    const r = dmarc.find((x) => /^v=DMARC1/i.test(x));
    ok(`DMARC: ${r}`);
    const p = (r.match(/\bp=(\w+)/i) || [])[1];
    if (!/rua=/i.test(r)) warn('DMARC has no rua= address, so no reports are sent and failures stay invisible.');
    if (/^(quarantine|reject)$/i.test(p || '')) {
      warn(`DMARC policy is p=${p}. With DKIM missing or unsigned, this makes your OWN mail fail harder.`);
    }
  }

  console.log();
  if (problems) {
    console.log(`   ${problems} problem(s). Until these are fixed, a strict recipient refusing mail is`);
    console.log('   expected behaviour rather than bad luck — and "no bounce" does not mean "inbox".');
    process.exit(1);
  }
  console.log('   Authentication looks correct. Remaining refusals are reputation and volume:');
  console.log('   a young domain that sends 74 near-identical messages with an attachment in a day');
  console.log('   looks like a blast to a filter, however genuine every one of them is.\n');
}

main().catch((e) => {
  console.error('check-email-auth failed:', e && e.message ? e.message : e);
  process.exit(1);
});
