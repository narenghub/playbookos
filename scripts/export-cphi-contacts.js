#!/usr/bin/env node
// ── CPHI CONTACTS → ONE CSV PER CAMPAIGN SEGMENT, FOR APOLLO IMPORT ───────────
//
//   railway ssh 'node scripts/export-cphi-contacts.js'            → counts and warnings, no files
//   railway ssh 'node scripts/export-cphi-contacts.js --print'    → the CSVs to stdout, to copy out
//
// The contacts are in PlaybookOS and the sequences are in Apollo, and nothing joins the two. This
// is that join: it reads the cards collected on the floor, segments them the way the campaign is
// segmented, and emits Apollo-import CSVs.
//
// ── THE SEGMENT COMES FROM A JOIN THAT IS ALLOWED TO FAIL ────────────────────
//
// `cphi_exhibitor_contacts.exhibitor_match_id` is NULLABLE on purpose — a card from a firm with no
// DMF match is still a card. But the ROLE lives on cphi_exhibitor_matches, so a contact with no
// match has NO segment, and there is no honest way to guess whether the person in front of you was
// a supplier, a buyer or a partner. Those are reported as `unassigned` and excluded from every CSV.
// Putting them in the supplier campaign because most contacts are suppliers would send a sourcing
// request to someone who came to buy.
//
// ── NAMES ARE NOT SAFE TO SPLIT ─────────────────────────────────────────────
//
// Apollo wants First Name and Last Name; the table holds one `name`. A naive split on the first
// space gets "Udaya Sagar G." wrong, gets "B. Shalini Reddy" wrong, and gets "Wu Minnan" backwards,
// because Chinese names are family-name-first. The first line of a follow-up to somebody you met
// four days ago is the worst possible place to use the wrong name.
//
// So the split is attempted, and every name where it is NOT safe is flagged for a human to read
// before import. Full Name is always included so the greeting can be fixed by hand.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { EVENTS, isEvent } = require('../src/lib/events/registry');

// 'cphi' is NOT the slug — the registry calls it cphi-milan-2026, and a default of 'cphi' found
// only the twenty cards mistakenly written under that name and reported them as the whole list.
const EVENT = process.argv.find((a) => a.startsWith('--event='))
  ? process.argv.find((a) => a.startsWith('--event=')).split('=')[1] : 'cphi-milan-2026';
const PRINT = process.argv.includes('--print');
const INCLUDE_EMAILED = process.argv.includes('--include-emailed');

// The three campaigns, and which CPHI roles feed each. Roles come from src/lib/events/registry.js:
// supplier · platform_partner · qc_lab · buyer.
const SEGMENTS = {
  supplier: { roles: ['supplier'],
    ask: 'send us your full product list; we confirm which molecules we want to source' },
  buyer: { roles: ['buyer'],
    ask: 'we hold hundreds of products — tell us what you are short of' },
  partner: { roles: ['qc_lab', 'platform_partner'],
    ask: 'QC testing, or operations: storage, repack, relabel' },
};

// splitName and its reasoning now live in src/lib/campaigns/name-split.js, because the
// follow-up runner asks the same question and two copies of that answer would drift.
const { splitName } = require('../src/lib/campaigns/name-split');

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');

// Apollo maps by header name. "Full Name" is not one of its fields and rides along as a custom
// column, which is what the person fixing a flagged greeting will read.
const HEADER = ['First Name', 'Last Name', 'Full Name', 'Email', 'Company', 'Title',
                'Mobile Phone', 'Work Direct Phone', 'Website', 'Segment', 'Name Check', 'Card Note'];

async function main() {
  await initDB();

  if (!isEvent(EVENT)) {
    console.log(`✗ "${EVENT}" is not an event. Known events: ${EVENTS.map((e) => e.slug).join(', ')}\n`);
    process.exit(1);
  }

  const rows = (await query(
    `SELECT c.id, c.company, c.name, c.title, c.email, c.phone_mobile, c.phone_office,
            c.website, c.source, c.note, c.last_emailed_at, c.linkedin_connected,
            x.role, x.holder
       FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1
      ORDER BY x.role NULLS LAST, c.company, c.name`, [EVENT])).rows;

  console.log(`── ${EVENT} contacts → campaign segments\n`);
  if (!rows.length) {
    console.log(`   no contacts for event "${EVENT}". Known events: ${EVENTS.map((e) => e.slug).join(', ')}\n`);
    return;
  }

  const roleToSegment = {};
  for (const [seg, def] of Object.entries(SEGMENTS)) for (const r of def.roles) roleToSegment[r] = seg;

  const bySegment = {};
  const unassigned = [];
  const unknownRole = [];
  const noEmail = [];
  const alreadyEmailed = [];
  const nameChecks = [];

  for (const r of rows) {
    if (!r.email) { noEmail.push(r); continue; }           // nothing to send to
    if (!r.role) { unassigned.push(r); continue; }          // no match row → no segment
    const seg = roleToSegment[r.role];
    if (!seg) { unknownRole.push(r); continue; }            // a role no campaign covers
    if (r.last_emailed_at && !INCLUDE_EMAILED) { alreadyEmailed.push(r); continue; }
    (bySegment[seg] = bySegment[seg] || []).push(r);
  }

  console.log(`   ${rows.length} contact(s) on file\n`);
  for (const [seg, def] of Object.entries(SEGMENTS)) {
    const list = bySegment[seg] || [];
    console.log(`   ${seg.padEnd(9)} ${String(list.length).padStart(3)} contact(s)  · ${def.ask}`);
    for (const r of list) console.log(`                 ${r.name} — ${r.company}`);
  }

  // ── WHAT IS NOT IN ANY CSV, AND WHY ────
  if (unassigned.length) {
    console.log(`\n   ⚠ ${unassigned.length} contact(s) have NO exhibitor match, so no segment:`);
    for (const r of unassigned) console.log(`      ${r.name} — ${r.company}`);
    console.log(`      exhibitor_match_id is nullable by design — a card from a firm with no DMF`);
    console.log(`      match is still a card. But the role lives on the match, so these cannot be`);
    console.log(`      segmented. Decide supplier / buyer / partner per person; guessing would send`);
    console.log(`      a sourcing request to someone who came to buy.`);
  }
  if (unknownRole.length) {
    console.log(`\n   ⚠ ${unknownRole.length} contact(s) carry a role no campaign covers:`);
    for (const r of unknownRole) console.log(`      ${r.name} — ${r.company} [role ${r.role}]`);
  }
  if (noEmail.length) {
    console.log(`\n   ⚠ ${noEmail.length} contact(s) have no email — phone or LinkedIn only:`);
    for (const r of noEmail) console.log(`      ${r.name} — ${r.company}${r.phone_mobile ? ` · ${r.phone_mobile}` : ''}`);
  }
  if (alreadyEmailed.length) {
    console.log(`\n   ${alreadyEmailed.length} contact(s) already emailed — EXCLUDED so a re-run cannot double-send.`);
    for (const r of alreadyEmailed) {
      console.log(`      ${r.name} — ${r.company} · ${new Date(r.last_emailed_at).toISOString().slice(0, 10)}`);
    }
    console.log(`      Pass --include-emailed to override.`);
  }

  // ── NAMES THAT NEED A HUMAN BEFORE IMPORT ────
  for (const list of Object.values(bySegment)) {
    for (const r of list) {
      const s = splitName(r.name);
      if (!s.safe) nameChecks.push({ r, s });
    }
  }
  if (nameChecks.length) {
    console.log(`\n   ⚠ ${nameChecks.length} name(s) cannot be split safely — read these before import:`);
    for (const { r, s } of nameChecks) {
      console.log(`      ${JSON.stringify(r.name).padEnd(24)} → first ${JSON.stringify(s.first)}, last ${JSON.stringify(s.last)}`);
      console.log(`         ${s.why}`);
    }
    console.log(`      Apollo greets with First Name. Getting it wrong in the first line of a`);
    console.log(`      follow-up to somebody you met four days ago is worse than sending nothing.`);
  }

  // ── NOTES WORTH READING BEFORE CONTRACTING ────
  const noted = rows.filter((r) => r.note);
  if (noted.length) {
    console.log(`\n   ${noted.length} contact(s) carry a card note:`);
    for (const r of noted) console.log(`      ${r.company} — ${r.note}`);
  }

  if (!PRINT) {
    console.log(`\n   Re-run with --print to emit the CSVs.\n`);
    return;
  }

  for (const [seg, list] of Object.entries(bySegment)) {
    if (!list.length) continue;
    console.log(`\n===== BEGIN CSV: ${seg} (${list.length} rows) =====`);
    console.log(csvRow(HEADER));
    for (const r of list) {
      const s = splitName(r.name);
      console.log(csvRow([
        s.first, s.last, r.name, r.email, r.company, r.title,
        r.phone_mobile, r.phone_office, r.website, seg,
        s.safe ? '' : `CHECK: ${s.why}`, r.note || '',
      ]));
    }
    console.log(`===== END CSV: ${seg} =====`);
  }
  console.log();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('export-cphi-contacts failed:', e && e.message ? e.message : e);
  process.exit(1);
});
