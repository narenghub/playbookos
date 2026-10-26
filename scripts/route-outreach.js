#!/usr/bin/env node
// ── WHO GETS WHICH EMAIL, AND ON WHAT EVIDENCE ───────────────────────────────
//
//   railway ssh 'node scripts/route-outreach.js'                   # DRY RUN — sends nothing
//   railway ssh 'node scripts/route-outreach.js --show=3'          # print 3 full emails
//   railway ssh 'node scripts/route-outreach.js --need=discovery'
//
// THIS SCRIPT NEVER SENDS. It has no mailer import and no --execute flag. Routing and sending are
// deliberately separate commands, because the question "is this the right letter for this person"
// has to be answerable without the answer costing anything.
//
// ── WHY A DRY RUN IS THE WHOLE POINT ─────────────────────────────────────────
//
// On 13 October a dry run caught Charlotte Perrin of ACM Global Laboratories — met at SCOPE Europe
// — queued to receive "Following up from CPHI Milan, a question about your capabilities". She was
// first in the batch and four more were behind her. Nothing was wrong with the code: a role key
// shared between two shows made a sequence reachable from the wrong event, and only reading the
// list of who-gets-what found it.
//
// Need routing has the same exposure and more of it. Every sequence opens with a sentence about
// the recipient's own work — a phase, a grant number, a molecule — which is the reason the email
// is worth reading AND a claim we are making about them. A wrong one is worse than a generic
// email, because it proves we did not read anything.
//
// So this prints, for every contact: the need, the signal that produced it, and the exact evidence
// sentence that will open their email. Read the evidence column. If a line is not true of that
// person, nothing should send.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { needFor, renderNeed, needStepsOf, NEED_CAMPAIGNS } = require('../src/lib/campaigns/needs');

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

// First name for the greeting. "Scott J Miller" -> "Scott"; an ALL-CAPS filing like
// "JONATHAN A ELLMAN" -> "Jonathan", because "Hi JONATHAN," reads as a mail merge.
function firstName(full) {
  const tok = String(full || '').trim().split(/\s+/).filter(Boolean)[0] || '';
  if (!tok) return '';
  if (tok === tok.toUpperCase()) return tok.charAt(0) + tok.slice(1).toLowerCase();
  return tok;
}

async function main() {
  await initDB();

  const rows = [];

  // ── 1. FUNDED RESEARCH LABS ────
  // The only source where every field the discovery route needs is already stored and checkable:
  // the department, the grant number, the end date and the PI's published address.
  const labs = (await query(`
    SELECT l.id, l.pi_name, l.institution_name, l.department, l.focus,
           l.funding_id, l.funding_end, l.source_url,
           p.full_name, p.email,
           (SELECT value FROM research_interests ri
             WHERE ri.lab_id = l.id AND ri.kind = 'molecule' LIMIT 1) molecule
      FROM research_labs l
      JOIN research_people p ON p.lab_id = l.id
     WHERE p.email IS NOT NULL AND p.email <> ''
     ORDER BY l.institution_name, l.pi_name`)).rows;

  for (const r of labs) {
    // focus is the lab's own topic as the source wrote it; without it there is no true opening
    // sentence, and needFor() will decline rather than invent one.
    const route = needFor({
      deptType: r.department,
      researchTopic: r.focus,
      grantNumber: r.funding_id,
      grantEndsOn: r.funding_end ? String(r.funding_end).slice(0, 10) : null,
    });
    rows.push({
      who: r.full_name || r.pi_name,
      email: r.email,
      org: r.institution_name,
      src: 'research_lab',
      route,
      why: !route ? missingFor(r) : null,
      evidenceUrl: r.source_url,
    });
  }

  // What the row lacked, named precisely. "No need detected" is not actionable; "no focus
  // recorded" tells somebody which field to go and fill.
  function missingFor(r) {
    const d = String(r.department || '').toUpperCase();
    if (!d) return 'no department recorded';
    if (!(d.startsWith('CHEMISTRY') || d.startsWith('BIOCHEMISTR'))) return `department is ${clip(r.department, 18)}`;
    if (!r.focus) return 'no focus/topic recorded';
    if (!r.funding_id) return 'no grant number recorded';
    return 'no rule matched';
  }

  // ── 2. OPEN INQUIRIES ────
  // Someone who already asked us for something. Routed on whether we can source it, which is the
  // one fact that decides between two opposite letters.
  const inq = (await query(`
    SELECT i.id, i.buyer_name, i.buyer_email, i.buyer_company, i.molecule_name, i.cas_number, i.status
      FROM inquiries i
     WHERE COALESCE(i.status,'') NOT IN ('spam')
       AND i.buyer_email IS NOT NULL
       AND NULLIF(TRIM(i.molecule_name), '') IS NOT NULL
     ORDER BY i.created_at DESC`)).rows;

  const cat = (await query('SELECT product_name, cas FROM supplier_products')).rows;
  const names = new Set(cat.map((c) => String(c.product_name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
  const cases = new Set(cat.map((c) => String(c.cas || '').trim()).filter(Boolean));

  for (const r of inq) {
    const key = String(r.molecule_name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // Only pass inCatalogue when we have actually checked. Undefined routes nowhere by design.
    const inCatalogue = names.has(key) || (r.cas_number && cases.has(String(r.cas_number).trim()));
    const route = needFor({ moleculeNamed: r.molecule_name, inCatalogue: !!inCatalogue });
    rows.push({
      who: r.buyer_name || r.buyer_company,
      email: r.buyer_email,
      org: r.buyer_company,
      src: `inquiry/${r.status || '?'}`,
      route,
      why: route ? null : 'molecule present but unroutable',
    });
  }

  // ── REPORT ────
  const routed = rows.filter((r) => r.route && (!ONLY || r.route.need === ONLY));
  const skipped = rows.filter((r) => !r.route);

  say(`\n── outreach routing · DRY RUN · nothing is sent by this script\n`);
  say(`   ${rows.length} contact(s) considered · ${routed.length} routed · ${skipped.length} not routed\n`);

  const byNeed = {};
  for (const r of routed) byNeed[r.route.need] = (byNeed[r.route.need] || 0) + 1;
  for (const k of Object.keys(NEED_CAMPAIGNS)) {
    const c = NEED_CAMPAIGNS[k];
    say(`      ${pad(k, 20)} ${pad(byNeed[k] || 0, 5)} ${pad(c.label, 34)} ${needStepsOf(k).length} step(s)`);
  }

  say('\n   ══ WHO GETS WHAT — READ THE EVIDENCE COLUMN ════════════════════════');
  say(`      ${pad('who', 24)}${pad('need', 18)}${pad('signal', 24)}evidence (the first line of their email)`);
  for (const r of routed) {
    say(`      ${pad(clip(r.who, 23), 24)}${pad(r.route.need, 18)}${pad(r.route.signal, 24)}${clip(r.route.evidence, 72)}`);
  }
  if (!routed.length) say('      (none)');

  say('\n   ══ NOT ROUTED — NO EVIDENCE, SO NO EMAIL ═══════════════════════════');
  for (const r of skipped) {
    say(`      ${pad(clip(r.who, 23), 24)}${pad(clip(r.org, 30), 31)}${pad(r.src, 18)}${r.why || ''}`);
  }
  if (!skipped.length) say('      (none)');

  // ── FULL EMAILS ────
  // A table of evidence sentences is not the same as reading the letter somebody receives.
  if (SHOW) {
    say('\n   ══ FULL TEXT OF THE FIRST EMAILS ═══════════════════════════════════');
    for (const r of routed.slice(0, SHOW)) {
      const vars = { first: firstName(r.who), topic: r.route.topic, evidence: r.route.evidence };
      let m;
      try { m = renderNeed(r.route.need, 1, vars); } catch (e) {
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

  // ── WHAT WOULD BREAK ────
  // Rendering every routed contact here means a contact who cannot be greeted, or whose subject
  // fails to interpolate, is found now rather than mid-send.
  const broken = [];
  for (const r of routed) {
    try {
      renderNeed(r.route.need, 1, { first: firstName(r.who), topic: r.route.topic, evidence: r.route.evidence });
    } catch (e) { broken.push([r, e.message]); }
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
