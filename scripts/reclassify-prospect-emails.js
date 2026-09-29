// ── Re-classify already-extracted prospect emails (READ-MOSTLY; no re-fetching) ──
//
// The first email run classified EVERY off-domain address as a web designer's. On real data that made
// gmail.com the top "designer" domain (47 rows), because a small machine shop using gmail is using its
// OWN address. Two consequences to undo:
//   1. ~63 genuine leads were discarded (a consumer mailbox is the only address many of these publish)
//   2. those rows carry a bogus 'designer_email_on_site' agency signal, which biases the
//      "someone already looks after this site" read the call list depends on
//
// This re-classifies from what is ALREADY STORED in site_findings.emails.third_party — the address and
// its domain are both there — so it needs no HTTP at all. A full re-scan would take another 9 minutes
// and hit 577 sites again for data we already hold.
//
// Run:  railway ssh 'node scripts/reclassify-prospect-emails.js'          (add --commit to write)
// Dry run by default: it prints what it WOULD change and writes nothing.

const { query } = require('../src/lib/db');
const { isFreeMail, pickOwnerEmail, designerSignals } = require('../src/lib/agents/prospecting/site-email');

const COMMIT = process.argv.includes('--commit');
const PRODUCT = 'acbm';

(async () => {
  const rows = (await query(
    `SELECT id, name, owner_email, owner_source, site_findings
       FROM prospects
      WHERE product = $1 AND site_findings ? 'emails'
      ORDER BY id`, [PRODUCT])).rows;

  let recovered = 0, signalsCleared = 0, unchanged = 0, kept = 0;
  const samples = [];

  for (const r of rows) {
    const f = r.site_findings || {};
    const emails = f.emails || {};
    const third = emails.third_party || [];
    if (!third.length) { unchanged++; continue; }

    // Split the old third_party list the way the fixed classifier would.
    const free = third.filter(e => isFreeMail(e.domain));
    const realThird = third.filter(e => !isFreeMail(e.domain));
    if (!free.length) { kept++; continue; }         // a genuine designer address: nothing to change

    const extracted = { own: emails.own || [], freeMail: free, thirdParty: realThird };
    const newOwner = pickOwnerEmail(extracted);
    // Never overwrite a human's entry, and never replace an on-domain address we already found.
    const takeOwner = newOwner && !r.owner_email && (r.owner_source == null || r.owner_source === 'site');

    const others = (f.agency_signals || []).filter(s => s.key !== 'designer_email_on_site');
    const newAgency = [...others, ...designerSignals(extracted)];
    const hadDesigner = (f.agency_signals || []).some(s => s.key === 'designer_email_on_site');
    const hasDesigner = newAgency.some(s => s.key === 'designer_email_on_site');

    if (takeOwner) recovered++;
    if (hadDesigner && !hasDesigner) signalsCleared++;
    if (samples.length < 12) samples.push(`${(newOwner || '(none)').padEnd(34)} ${hadDesigner && !hasDesigner ? 'signal cleared' : 'signal kept  '}  ${r.name.slice(0, 30)}`);

    if (COMMIT) {
      const newFindings = { ...f, agency_signals: newAgency,
        emails: { ...emails, own: emails.own || [], free_mail: free, third_party: realThird } };
      await query(
        `UPDATE prospects SET site_findings = $2::jsonb,
           owner_email  = CASE WHEN $3::boolean THEN $4::text ELSE owner_email END,
           owner_source = CASE WHEN $3::boolean THEN 'site'   ELSE owner_source END
         WHERE id = $1`, [r.id, JSON.stringify(newFindings), !!takeOwner, newOwner]);
    }
  }

  console.log(`${COMMIT ? 'APPLIED' : 'DRY RUN (add --commit to write)'} — ${rows.length} scanned rows examined`);
  console.log(`  owner_email recovered from a consumer mailbox: ${recovered}`);
  console.log(`  bogus designer signals cleared:                ${signalsCleared}`);
  console.log(`  genuine designer addresses kept:               ${kept}`);
  console.log(`  rows with no third-party address at all:       ${unchanged}`);
  if (samples.length) { console.log('\n  samples:'); samples.forEach(s => console.log('   ' + s)); }

  if (COMMIT) {
    const after = (await query(
      `SELECT COUNT(owner_email)::int with_email,
              COUNT(*) FILTER (WHERE site_findings->'agency_signals' @> '[{"key":"designer_email_on_site"}]')::int designer_rows
         FROM prospects WHERE product = $1 AND subtype IN ('machine_shop','funeral')`, [PRODUCT])).rows[0];
    console.log(`\n  after: ${after.with_email} rows with an email · ${after.designer_rows} still flagged as designer-built`);
  }
  process.exit(0);
})().catch(e => { console.error('reclassify error:', e.message); process.exit(1); });
