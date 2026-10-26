#!/usr/bin/env node
// ── WHO GETS WHICH EMAIL, AND ON WHAT EVIDENCE ───────────────────────────────
//
//   railway ssh 'node scripts/route-outreach.js'
//   railway ssh 'node scripts/route-outreach.js --show=3'
//   railway ssh 'node scripts/route-outreach.js --need=discovery'
//
// THIS SCRIPT NEVER SENDS. It has no mailer import and no --execute flag.
//
// ── WHY A DRY RUN IS THE WHOLE POINT ─────────────────────────────────────────
//
// A dry run caught Charlotte Perrin of ACM Global Laboratories — met at SCOPE — queued to receive
// "Following up from CPHI Milan". Nothing was wrong with the code; only reading the list found it.
//
// It has since caught, in this campaign: "(running to Sun Mar)", then "(running to March 2001)";
// 22 of 25 labs silently dropped because the department check wanted "CHEMISTRY" and RePORTER
// files "Department of Chemistry"; five of our own test records queued for cold outreach; letters
// opening "your work on fundamental studies"; "Hi Nicholas," to a tenured professor; and a
// capital E in the middle of a sentence. Every one produced plausible output and no error.
//
// So it prints the need, the signal behind it and the exact opening sentence for every contact,
// plus the ones it declined and WHICH FIELD was missing. Read the evidence column. If a line is
// not true of that person, nothing should send.
//
// The queue itself comes from src/lib/campaigns/outreach-queue.js, the same module the sender
// uses — otherwise this stops being evidence about the send and becomes a second implementation
// that happens to agree today.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { needStepsOf, NEED_CAMPAIGNS, renderNeed } = require('../src/lib/campaigns/needs');
const { PATTERN_CONFIGURED } = require('../src/lib/campaigns/product-link');
const { buildQueue, varsFor } = require('../src/lib/campaigns/outreach-queue');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const SHOW = Math.max(0, parseInt(arg('show', '0'), 10) || 0);
const ONLY = arg('need', '');

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function main() {
  await initDB();
  const rows = await buildQueue(query);

  const routed = rows.filter((r) => r.route && (!ONLY || r.route.need === ONLY));
  const skipped = rows.filter((r) => !r.route);

  say('\n── outreach routing · DRY RUN · nothing is sent by this script\n');
  say(`   ${rows.length} contact(s) considered · ${routed.length} routed · ${skipped.length} not routed\n`);

  const byNeed = {};
  for (const r of routed) byNeed[r.route.need] = (byNeed[r.route.need] || 0) + 1;
  for (const k of Object.keys(NEED_CAMPAIGNS)) {
    say(`      ${pad(k, 20)} ${pad(byNeed[k] || 0, 5)} ${pad(NEED_CAMPAIGNS[k].label, 44)}`
      + `${needStepsOf(k).length} step(s)`);
  }

  say('\n   ══ WHO GETS WHAT — READ THE EVIDENCE COLUMN ════════════════════════');
  say(`      ${pad('who', 24)}${pad('greeting', 26)}${pad('need', 18)}evidence (their first line)`);
  for (const r of routed) {
    const g = NEED_CAMPAIGNS[r.route.need].formal ? `Dear Professor ${r.last}` : `Hi ${r.first}`;
    say(`      ${pad(clip(r.who, 23), 24)}${pad(clip(`${g},`, 25), 26)}${pad(r.route.need, 18)}`
      + `${clip(r.route.evidence, 62)}`);
    if (r.link) say(`             ↳ link (live, page names the molecule): ${r.link.url}`);
  }
  if (!routed.length) say('      (none)');

  if (!PATTERN_CONFIGURED) {
    say('\n      No ABIOZEN_PRODUCT_URL set, so no email carries a product link. The letters read');
    say('      correctly without one — a link is added only where the page can be confirmed live');
    say('      and about that molecule, because a 404 undoes the opening sentence.');
  } else {
    say(`\n      ${routed.filter((r) => r.link).length} of ${routed.length} would carry a verified link.`);
  }

  say('\n   ══ NOT ROUTED — NO EVIDENCE, SO NO EMAIL ═══════════════════════════');
  for (const r of skipped) {
    say(`      ${pad(clip(r.who, 23), 24)}${pad(clip(r.org, 30), 31)}${pad(r.src, 18)}${r.why || ''}`);
  }
  if (!skipped.length) say('      (none)');

  if (SHOW) {
    say('\n   ══ FULL TEXT OF THE FIRST EMAILS ═══════════════════════════════════');
    for (const r of routed.slice(0, SHOW)) {
      let m;
      try { m = renderNeed(r.route.need, 1, varsFor(r)); } catch (e) {
        say(`\n      ── ${r.who} — WOULD NOT RENDER: ${e.message}`);
        continue;
      }
      say(`\n      ── to ${r.who} <${r.email}>  ·  ${r.route.need}`);
      if (r.evidenceUrl) say(`         our source for the opening line: ${r.evidenceUrl}`);
      say(`         Subject: ${m.subject}`);
      say('');
      for (const line of m.text.split('\n')) say(`         ${line}`);
    }
  }

  // Rendering every routed contact here means one who cannot be greeted, or whose subject failed
  // to interpolate, is found now rather than mid-send.
  const broken = [];
  for (const r of routed) {
    try { renderNeed(r.route.need, 1, varsFor(r)); } catch (e) { broken.push([r, e.message]); }
  }
  if (broken.length) {
    say('\n   ══ WOULD FAIL TO RENDER ════════════════════════════════════════════');
    for (const [r, m] of broken) say(`      ${pad(clip(r.who, 23), 24)}${m}`);
    say(`\n   ⚠ ${broken.length} routed contact(s) cannot be rendered. Fix before any send.`);
  }

  say('\n   Routing and sending are separate commands on purpose. Nothing here sent anything.');
  say('   Read the evidence column: if a line is not true of that person, do not send.\n');

  if (broken.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('route-outreach failed:', e && e.message ? e.message : e);
  process.exit(1);
});
