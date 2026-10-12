#!/usr/bin/env node
// ── GIVE A CONTACT THE ROLE THAT DECIDES WHICH EMAIL THEY GET ─────────────────
//
//   railway ssh 'node scripts/set-contact-role.js'                          → list who has no role
//   railway ssh 'node scripts/set-contact-role.js --email=a@b.com --role=supplier'
//   railway ssh 'node scripts/set-contact-role.js --email=a@b.com --role=supplier --execute'
//
// After the slug repair, cphi-milan-2026 held 79 contacts and TWENTY of them had no role. Three
// were the day-3 cards deliberately left for a human. The other seventeen came from days 1 and 2
// and had been roleless all along — which means they were never going to receive anything from any
// campaign, silently, because export-cphi-contacts.js correctly refuses to guess.
//
// A contact with no role is not a small gap. It is a person who shook Naren's hand at CPHI and
// will hear nothing, and nothing in the system would have said so.
//
// ── WHY THE ROLE LIVES ON A MATCH ROW AND NOT ON THE CONTACT ─────────────────
//
// `cphi_exhibitor_contacts.exhibitor_match_id` points at `cphi_exhibitor_matches`, which carries
// (event, role, company). The role belongs to the COMPANY in a role, not to the person: two people
// at one firm share it, and the same firm can legitimately appear twice under different roles —
// Granules is both a supplier and, through its supply-chain VP, possibly a buyer.
//
// So setting a role means finding or creating the match row for (event, role, company) and
// pointing the contact at it. Doing that by hand in SQL is three statements and an easy way to
// leave a contact pointing at the wrong company.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { normalizeCompany } = require('../src/lib/cphi/match-company');
const { isEvent, isRoleOf, getEvent } = require('../src/lib/events/registry');

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const EVENT = arg('event', 'cphi-milan-2026');
const EMAIL = arg('email', null);
// Batch. Fifteen of the twenty roleless contacts were unambiguously suppliers, and fifteen
// separate ssh round trips is both tedious and a good way to mistype one. Every per-contact guard
// still runs for each address — this only removes the repetition, not the checking.
const EMAILS = (arg('emails', '') || '').split(',').map((e) => e.trim()).filter(Boolean);
const ROLE = arg('role', null);
const EXECUTE = process.argv.includes('--execute');

async function listUnassigned() {
  const rows = (await query(
    `SELECT c.id, c.company, c.name, c.title, c.email, c.note
       FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1 AND x.role IS NULL
      ORDER BY c.company, c.name`, [EVENT])).rows;

  console.log(`── ${EVENT} · contacts with NO role\n`);
  if (!rows.length) {
    console.log('   none — every contact is in a campaign.\n');
    return;
  }
  console.log(`   ${rows.length} contact(s) will receive NOTHING until a role is set:\n`);
  for (const r of rows) {
    console.log(`   ${r.name}  —  ${r.company}`);
    if (r.title) console.log(`      ${r.title}`);
    console.log(`      ${r.email || '(no email)'}`);
    if (r.note) console.log(`      note: ${String(r.note).slice(0, 150)}`);
    console.log(`      → node scripts/set-contact-role.js --email=${r.email || '?'} --role=<role> --execute`);
    console.log();
  }
  const ev = getEvent(EVENT);
  console.log(`   roles for ${EVENT}: ${ev.roles.map((r) => r.key).join(', ')}\n`);
}

async function main() {
  await initDB();

  if (!isEvent(EVENT)) {
    console.log(`✗ "${EVENT}" is not an event.`);
    process.exit(1);
  }
  if (!EMAIL && !EMAILS.length && !ROLE) { await listUnassigned(); return; }

  if ((!EMAIL && !EMAILS.length) || !ROLE) {
    console.log('✗ a role and at least one address are required: --role= with --email= or --emails=');
    process.exit(1);
  }
  if (!isRoleOf(EVENT, ROLE)) {
    const ev = getEvent(EVENT);
    console.log(`✗ "${ROLE}" is not a role of ${EVENT}. One of: ${ev.roles.map((r) => r.key).join(', ')}`);
    process.exit(1);
  }

  const targets = EMAILS.length ? EMAILS : [EMAIL];
  if (targets.length > 1) {
    const results = [];
    for (const addr of targets) results.push(await setOne(addr));
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    console.log(`\n   ── ${ok} of ${targets.length} set to ${ROLE}`);
    for (const f of failed) console.log(`   ✗ ${f.email}: ${f.why}`);
    const left = (await query(
      `SELECT COUNT(*)::int n FROM cphi_exhibitor_contacts c
         LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
        WHERE c.event_slug = $1 AND x.role IS NULL`, [EVENT])).rows[0].n;
    console.log(`   ${left} contact(s) still have no role.\n`);
    // A batch where ANY address failed exits non-zero: a partial run that reports success is how
    // somebody ends up thinking the list is clear when it is not.
    process.exit(failed.length ? 1 : 0);
  }
  const r = await setOne(targets[0]);
  if (!r.ok) process.exit(1);
  const remaining = (await query(
    `SELECT COUNT(*)::int n FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1 AND x.role IS NULL`, [EVENT])).rows[0].n;
  console.log(`   ${remaining} contact(s) still have no role.\n`);
}

// One contact. Returns { ok, email, why } so a batch can report per-address rather than dying on
// the first problem and leaving the rest unprocessed and unexplained.
async function setOne(EMAIL) {
  const contacts = (await query(
    `SELECT c.id, c.company, c.company_normalized, c.name, c.email, c.exhibitor_match_id,
            x.role AS current_role, x.holder AS current_holder
       FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1 AND lower(c.email) = lower($2)`, [EVENT, EMAIL])).rows;

  if (!contacts.length) {
    console.log(`✗ no contact with email ${EMAIL} under ${EVENT}.`);
    return { ok: false, email: EMAIL, why: 'no such contact' };
  }
  if (contacts.length > 1) {
    // One address, two rows is a data problem to look at rather than to pick a winner from.
    console.log(`✗ ${contacts.length} contacts share ${EMAIL}:`);
    for (const c of contacts) console.log(`   ${c.name} — ${c.company}`);
    return { ok: false, email: EMAIL, why: `${contacts.length} contacts share this address` };
  }

  const c = contacts[0];
  console.log(`── ${c.name} — ${c.company}\n`);
  console.log(`   email        ${c.email}`);
  console.log(`   current role ${c.current_role || '(none — receives nothing)'}`);
  console.log(`   new role     ${ROLE}\n`);

  if (c.current_role === ROLE) { console.log('   already set. Nothing to do.\n'); return { ok: true, email: EMAIL }; }

  // Reassigning somebody who has ALREADY been emailed under another role would land them in a
  // second sequence mid-thread. Worth stopping for.
  const sent = (await query(
    `SELECT last_emailed_at FROM cphi_exhibitor_contacts WHERE id = $1`, [c.id])).rows[0];
  if (sent && sent.last_emailed_at) {
    console.log(`   ⚠ this contact was already emailed on `
      + `${new Date(sent.last_emailed_at).toISOString().slice(0, 10)}.`);
    console.log('     Changing the role now starts a SECOND sequence to somebody already in one.');
    if (!EXECUTE) console.log('     Re-run with --execute only if that is genuinely what you want.\n');
  }

  if (!EXECUTE) { console.log('   DRY RUN — nothing written. Re-run with --execute.\n'); return { ok: true, email: EMAIL, dry: true }; }

  const holderNorm = c.company_normalized || normalizeCompany(c.company);
  const m = await query(
    `INSERT INTO cphi_exhibitor_matches
       (event_slug, holder, holder_normalized, exhibiting, role, role_note,
        review_status, met_in_person, checked_at)
     VALUES ($1,$2,$3,false,$4,$5,'entity_review',true,NOW())
     ON CONFLICT (event_slug, role, holder_normalized) DO UPDATE
       SET met_in_person = true, checked_at = NOW()
     RETURNING id, (xmax = 0) AS created`,
    [EVENT, c.company, holderNorm, ROLE, `role set by hand on ${new Date().toISOString().slice(0, 10)}`]);

  await query(
    `UPDATE cphi_exhibitor_contacts SET exhibitor_match_id = $1, updated_at = NOW() WHERE id = $2`,
    [m.rows[0].id, c.id]);

  // Read it back through the same join the export uses, rather than trusting the UPDATE.
  const after = (await query(
    `SELECT x.role, x.holder FROM cphi_exhibitor_contacts c
       JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.id = $1`, [c.id])).rows[0];
  if (!after || after.role !== ROLE) {
    console.log(`   ✗ read-back says role is ${after ? after.role : 'still none'}. Not set.`);
    return { ok: false, email: EMAIL, why: 'read-back did not confirm the role' };
  }
  console.log(`   ✅ ${c.name} is now ${after.role} (${after.holder})`
    + `${m.rows[0].created ? ' — new match row' : ''}\n`);
  return { ok: true, email: EMAIL };
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('set-contact-role failed:', e && e.message ? e.message : e);
  process.exit(1);
});
