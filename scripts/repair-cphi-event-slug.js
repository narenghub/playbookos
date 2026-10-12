#!/usr/bin/env node
// ── MOVE THE ROWS WRITTEN UNDER A SLUG THAT IS NOT AN EVENT ───────────────────
//
//   railway ssh 'node scripts/repair-cphi-event-slug.js'            → dry run
//   railway ssh 'node scripts/repair-cphi-event-slug.js --execute'  → moves them
//
// ── WHAT HAPPENED ────────────────────────────────────────────────────────────
//
// scripts/seed-cphi-day3-contacts.js wrote `event_slug = 'cphi'`. The event is
// `cphi-milan-2026` — that is what the registry calls it and what both earlier contact seeds use.
// So twenty cards and seventeen match rows landed under a slug nothing else uses.
//
// On its own that is a typo. What made it dangerous is that
// scripts/export-cphi-contacts.js DEFAULTED TO THE SAME WRONG SLUG. Run it and it would have found
// exactly those twenty contacts, segmented them, printed a clean table, and reported them as the
// whole list — with the sixty-one contacts already collected on days 1 and 2 silently absent. Two
// mistakes that cancelled into something that looked correct, which is the most expensive kind.
//
// Both defaults are fixed and both scripts now refuse a slug that is not a real event. This moves
// the rows that were already written.
//
// ── WHY A MOVE AND NOT A RE-SEED ─────────────────────────────────────────────
//
// Re-running the seed against the right slug would write twenty fresh rows and leave twenty
// orphans behind under 'cphi'. The orphans would then be invisible to every query that uses the
// correct slug, and present in any that does not — which is the same class of bug all over again.
// Moving is reversible in a way duplicating is not.
'use strict';

const { initDB, query } = require('../src/lib/db');
const { isEvent, EVENTS } = require('../src/lib/events/registry');

const FROM = 'cphi';
const TO = 'cphi-milan-2026';
const EXECUTE = process.argv.includes('--execute');

async function main() {
  await initDB();

  if (isEvent(FROM)) {
    console.log(`✗ "${FROM}" IS a real event now. This repair assumed it was not, so stop and look.`);
    process.exit(1);
  }
  if (!isEvent(TO)) {
    console.log(`✗ "${TO}" is not an event. Known: ${EVENTS.map((e) => e.slug).join(', ')}`);
    process.exit(1);
  }

  console.log(`── repair · move rows from "${FROM}" (not an event) to "${TO}"\n`);

  const contacts = (await query(
    `SELECT id, company, company_normalized, name, email, exhibitor_match_id
       FROM cphi_exhibitor_contacts WHERE event_slug = $1 ORDER BY company, name`, [FROM])).rows;
  const matches = (await query(
    `SELECT id, holder, holder_normalized, role FROM cphi_exhibitor_matches
      WHERE event_slug = $1 ORDER BY role, holder`, [FROM])).rows;

  console.log(`   under "${FROM}":  ${contacts.length} contact(s), ${matches.length} match row(s)`);
  const already = (await query(
    `SELECT COUNT(*)::int n FROM cphi_exhibitor_contacts WHERE event_slug = $1`, [TO])).rows[0].n;
  console.log(`   under "${TO}":  ${already} contact(s) already\n`);

  if (!contacts.length && !matches.length) {
    console.log('   nothing to move.\n');
    return;
  }

  // ── COLLISIONS, BEFORE MOVING ANYTHING ────
  // The unique keys are (event_slug, company_normalized, lower(name)) for contacts and
  // (event_slug, role, holder_normalized) for matches. A move that collides would throw mid-way
  // and leave half the rows under each slug, which is worse than either slug alone.
  const contactClash = (await query(
    `SELECT c.id, c.company, c.name
       FROM cphi_exhibitor_contacts c
      WHERE c.event_slug = $1
        AND EXISTS (SELECT 1 FROM cphi_exhibitor_contacts d
                     WHERE d.event_slug = $2
                       AND d.company_normalized = c.company_normalized
                       AND lower(d.name) = lower(c.name))`, [FROM, TO])).rows;
  const matchClash = (await query(
    `SELECT m.id, m.holder, m.role
       FROM cphi_exhibitor_matches m
      WHERE m.event_slug = $1
        AND EXISTS (SELECT 1 FROM cphi_exhibitor_matches n
                     WHERE n.event_slug = $2 AND n.role = m.role
                       AND n.holder_normalized = m.holder_normalized)`, [FROM, TO])).rows;

  if (contactClash.length) {
    console.log(`   ${contactClash.length} contact(s) ALREADY EXIST under "${TO}" — the same person`);
    console.log(`   was collected on an earlier day. These are deleted from "${FROM}" rather than`);
    console.log(`   moved, because the earlier row is the one other tables point at:`);
    for (const c of contactClash) console.log(`      ${c.name} — ${c.company}`);
    console.log();
  }
  if (matchClash.length) {
    console.log(`   ${matchClash.length} match row(s) already exist under "${TO}" for the same`);
    console.log(`   (role, company). Their contacts are repointed at the existing row:`);
    for (const m of matchClash) console.log(`      ${m.holder} [${m.role}]`);
    console.log();
  }

  if (!EXECUTE) {
    console.log(`   would move ${matches.length - matchClash.length} match row(s) and `
      + `${contacts.length - contactClash.length} contact(s), and drop ${contactClash.length} duplicate(s).`);
    console.log('\n   DRY RUN — nothing written. Re-run with --execute.\n');
    return;
  }

  // Order matters: repoint contacts at surviving match rows BEFORE moving or deleting anything,
  // so no contact is ever left pointing at a row under the wrong slug.
  let repointed = 0;
  for (const m of matchClash) {
    const keep = (await query(
      `SELECT n.id FROM cphi_exhibitor_matches n
        JOIN cphi_exhibitor_matches m ON m.id = $1
       WHERE n.event_slug = $2 AND n.role = m.role AND n.holder_normalized = m.holder_normalized
       LIMIT 1`, [m.id, TO])).rows[0];
    if (!keep) continue;
    const r = await query(
      `UPDATE cphi_exhibitor_contacts SET exhibitor_match_id = $1, updated_at = NOW()
        WHERE exhibitor_match_id = $2 RETURNING id`, [keep.id, m.id]);
    repointed += r.rowCount;
    await query(`DELETE FROM cphi_exhibitor_matches WHERE id = $1`, [m.id]);
  }

  const movedMatches = await query(
    `UPDATE cphi_exhibitor_matches SET event_slug = $2 WHERE event_slug = $1 RETURNING id`, [FROM, TO]);

  let dropped = 0;
  for (const c of contactClash) {
    const r = await query(`DELETE FROM cphi_exhibitor_contacts WHERE id = $1 RETURNING id`, [c.id]);
    dropped += r.rowCount;
  }
  const movedContacts = await query(
    `UPDATE cphi_exhibitor_contacts SET event_slug = $2, updated_at = NOW()
      WHERE event_slug = $1 RETURNING id`, [FROM, TO]);

  console.log(`   ✅ ${movedMatches.rowCount} match row(s) moved, ${movedContacts.rowCount} contact(s) moved,`);
  console.log(`      ${repointed} contact(s) repointed, ${dropped} duplicate(s) dropped.\n`);

  // Read back rather than trusting the UPDATE: the whole point of this repair is that a count
  // nobody checked is how the original mistake survived.
  const leftover = (await query(
    `SELECT (SELECT COUNT(*)::int FROM cphi_exhibitor_contacts WHERE event_slug = $1) c,
            (SELECT COUNT(*)::int FROM cphi_exhibitor_matches  WHERE event_slug = $1) m`, [FROM])).rows[0];
  if (leftover.c || leftover.m) {
    console.log(`   ✗ ${leftover.c} contact(s) and ${leftover.m} match row(s) are STILL under "${FROM}".`);
    process.exit(1);
  }
  console.log(`   nothing remains under "${FROM}".`);

  const totals = (await query(
    `SELECT COALESCE(x.role, '(no role)') role, COUNT(*)::int n
       FROM cphi_exhibitor_contacts c
       LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
      WHERE c.event_slug = $1 GROUP BY 1 ORDER BY 2 DESC`, [TO])).rows;
  console.log(`\n   ${TO} now holds:`);
  let total = 0;
  for (const t of totals) { console.log(`      ${t.role.padEnd(18)} ${t.n}`); total += t.n; }
  console.log(`      ${'TOTAL'.padEnd(18)} ${total}\n`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('repair-cphi-event-slug failed:', e && e.message ? e.message : e);
  process.exit(1);
});
