#!/usr/bin/env node
// ── THE NAME THE EMAIL WILL SAY, FOR A NAME THAT CANNOT BE SPLIT ──────────────
//
//   railway ssh 'node scripts/set-greeting.js'                          → who is held, and why
//   railway ssh 'node scripts/set-greeting.js --set=201:Jiang --execute'
//   railway ssh 'node scripts/set-greeting.js --set=201:Jiang,15:Minnan,103:Yijun --execute'
//
// Seven CPHI contacts are held out of every run because `splitName()` cannot say which token is the
// given name. The sender refuses to render without one — "Hi ," to somebody who shook your hand six
// days ago is worse than sending nothing — so these people receive NOTHING until a human answers.
//
// ── WHY A SCRIPT AND NOT THREE UPDATE STATEMENTS ─────────────────────────────
//
// An UPDATE proves the column changed. What matters is that the SENDER now produces the right
// greeting, and those are different claims: the runner prefers `greeting_name` but falls back to
// `splitName()`, and it also requires the contact to have a role, an email and a live sequence. So
// this reads the result back through the same expression the runner uses
//
//     (greeting_name trimmed) || (split.safe ? split.first : null)
//
// and prints the literal line the recipient will read. On 2026-10-12 a territory grant WROTE
// successfully and then died in its own verification; the lesson was that the read-back has to
// exercise the real path, not a convenient one.
//
// Names are written verbatim, with no capitalisation or trimming beyond whitespace. "Lina" is a
// name; so is "de Souza". Guessing at case is how you get "MINNAN".
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent } = require('../src/lib/events/registry');
const { splitName } = require('../src/lib/campaigns/name-split');

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const EVENT = arg('event', 'cphi-milan-2026');
const SET = arg('set', '');
const EXECUTE = process.argv.includes('--execute');

/** The greeting the runner will actually use for a row. One expression, mirrored from cphi-runner. */
const greetingFor = (r) => {
  const split = splitName(r.name);
  return (r.greeting_name && r.greeting_name.trim()) || (split.safe ? split.first : null);
};

async function listHeld() {
  const rows = (await query(
    `SELECT c.id, c.name, c.company, c.greeting_name, x.role
       FROM cphi_exhibitor_contacts c
       JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1 AND c.email IS NOT NULL AND c.email <> ''
      ORDER BY c.company`, [EVENT])).rows;

  const held = rows.filter((r) => !greetingFor(r));
  const overridden = rows.filter((r) => r.greeting_name && r.greeting_name.trim());

  console.log(`── ${EVENT} · greetings\n`);
  if (overridden.length) {
    console.log(`   ${overridden.length} greeting(s) set by hand:`);
    for (const r of overridden) {
      console.log(`      ${String(r.id).padStart(4)}  ${r.name.padEnd(22)} → "Hi ${r.greeting_name}"  (${r.company})`);
    }
    console.log();
  }
  if (!held.length) { console.log('   nothing held — every contact has a usable greeting.\n'); return; }

  console.log(`   ${held.length} contact(s) receive NOTHING until a greeting is set:\n`);
  for (const r of held) {
    const s = splitName(r.name);
    console.log(`      id ${r.id}  ${r.name}  —  ${r.company}`);
    console.log(`         ${s.why}`);
    console.log(`         node scripts/set-greeting.js --set=${r.id}:<given name> --execute`);
    console.log();
  }
}

async function main() {
  await initDB();
  if (!isEvent(EVENT)) { console.log(`✗ "${EVENT}" is not an event.`); process.exit(1); }
  if (!SET) { await listHeld(); return; }

  // id:name pairs. A name may contain spaces; it may not contain a comma, which is the separator.
  const pairs = [];
  for (const chunk of SET.split(',')) {
    const i = chunk.indexOf(':');
    if (i < 1) { console.log(`✗ "${chunk}" is not id:name`); process.exit(1); }
    const id = parseInt(chunk.slice(0, i).trim(), 10);
    const name = chunk.slice(i + 1).trim();
    if (!Number.isInteger(id) || id < 1) { console.log(`✗ "${chunk}" has no usable id`); process.exit(1); }
    if (!name) { console.log(`✗ id ${id} has no name. To CLEAR a greeting use --clear=${id}`); process.exit(1); }
    pairs.push({ id, name });
  }

  console.log(`── setting ${pairs.length} greeting(s) · ${EXECUTE ? 'WRITING' : 'dry run'}\n`);

  const failures = [];
  for (const p of pairs) {
    const r = (await query(
      `SELECT c.id, c.name, c.company, c.greeting_name, c.email, x.role
         FROM cphi_exhibitor_contacts c
         LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
        WHERE c.id = $1 AND c.event_slug = $2`, [p.id, EVENT])).rows[0];

    if (!r) { console.log(`   ✗ id ${p.id}: no such contact under ${EVENT}`); failures.push(p); continue; }

    console.log(`   ${r.name}  —  ${r.company}`);
    console.log(`      card name   ${r.name}`);
    console.log(`      greeting    "Hi ${p.name}"${r.greeting_name ? `   (was "Hi ${r.greeting_name}")` : ''}`);

    // A greeting containing a word that is NOT on the card is worth stopping for: it is usually a
    // transposition, the family name typed where the given name goes, which is the exact mistake
    // this column exists to prevent.
    //
    // Compared word by word, because a given name can be compound. The first version of this check
    // compared the whole greeting against single tokens and so warned on "Udaya Sagar" (card:
    // "Udaya Sagar G.") — a correct greeting. A warning that fires on correct input is worse than
    // no warning at all, because it teaches the reader to ignore the next one.
    const bare = (s) => s.replace(/[.,]/g, '').toLowerCase();
    const cardTokens = r.name.split(/\s+/).map(bare).filter(Boolean);
    const unknown = p.name.split(/\s+/).map(bare).filter(Boolean)
      .filter((w) => !cardTokens.includes(w));
    if (unknown.length) {
      console.log(`      ⚠ ${unknown.map((w) => `"${w}"`).join(', ')} `
        + `${unknown.length > 1 ? 'are' : 'is'} not on the card ("${r.name}") — check it.`);
    }
    if (!r.role) console.log(`      ⚠ no role, so still no campaign — scripts/set-contact-role.js`);
    if (!r.email) console.log(`      ⚠ no email address, so still nothing to send`);

    if (!EXECUTE) { console.log(); continue; }

    await query(
      `UPDATE cphi_exhibitor_contacts SET greeting_name = $2, updated_at = NOW() WHERE id = $1`,
      [p.id, p.name]);

    // Read back through the runner's own expression, not through the column. The column changing is
    // not the claim being made; "the email will say Hi Jiang" is.
    const after = (await query(
      `SELECT id, name, greeting_name FROM cphi_exhibitor_contacts WHERE id = $1`, [p.id])).rows[0];
    const willSay = greetingFor(after);
    if (willSay !== p.name) {
      console.log(`      ✗ read-back says the email would open "Hi ${willSay}". Not set.`);
      failures.push(p);
      continue;
    }
    console.log(`      ✅ the email will open "Hi ${willSay}"\n`);
  }

  if (!EXECUTE) {
    console.log('   DRY RUN — nothing written. Re-run with --execute.\n');
    return;
  }

  const stillHeld = (await query(
    `SELECT c.id, c.name, c.greeting_name FROM cphi_exhibitor_contacts c
       JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1 AND c.email IS NOT NULL AND c.email <> ''`, [EVENT])).rows
    .filter((r) => !greetingFor(r));

  console.log(`   ${pairs.length - failures.length} of ${pairs.length} set.`);
  console.log(`   ${stillHeld.length} contact(s) still held: `
    + `${stillHeld.map((r) => `${r.name} (${r.id})`).join(', ') || 'none'}\n`);
  if (failures.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('set-greeting failed:', e && e.message ? e.message : e);
  process.exit(1);
});
