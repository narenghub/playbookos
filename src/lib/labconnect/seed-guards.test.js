// What the FDA import must never do.
//
//   node --test src/lib/labconnect/seed-guards.test.js
//
// These are read as SQL TEXT rather than exercised against a database, because the failures they
// guard are not failures a passing import would reveal. An import that reverts an onboarded lab to
// 'discovered' inserts and updates exactly as many rows as a correct one, reports success, and is
// only noticed when an order fails to route — or worse, when one routes somewhere it should not.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const SEED = fs.readFileSync(path.join(ROOT, 'scripts/seed-labs-from-fda.js'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'scripts/migrate-labconnect.js'), 'utf8');

// The ON CONFLICT ... DO UPDATE SET clause, which is the only part that can overwrite a row that
// already exists. Comments are stripped first: this file's whole job is to read what the SQL does,
// and a prose sentence mentioning 'status' would otherwise satisfy or fail every assertion below.
function updateSetClause(src) {
  const noComments = src.replace(/\/\/[^\n]*/g, '').replace(/--[^\n]*/g, '');
  const from = noComments.indexOf('DO UPDATE');
  assert.notEqual(from, -1, 'the import no longer has an upsert — these guards need rewriting');
  const to = noComments.indexOf('RETURNING', from);
  assert.notEqual(to, -1, 'could not find the end of the UPDATE clause');
  return noComments.slice(from, to);
}

test('a re-import cannot revert a human decision', () => {
  // THE FAILURE THIS EXISTS FOR. Rows arrive as 'discovered' and a person promotes them to
  // 'invited' and then 'active'. If the upsert refreshed `status` from the register, the next
  // import would silently demote every onboarded lab — and the lab would vanish from routing
  // while still looking present in the directory.
  const set = updateSetClause(SEED);
  for (const col of ['status', 'status_note', 'notes', 'accreditations',
                     'research_capable', 'gmp_capable']) {
    assert.ok(!new RegExp(`\\b${col}\\s*=`).test(set),
      `the upsert assigns ${col}, so re-running the import would overwrite a human decision`);
  }
});

test('a re-import does not blank a contact somebody corrected', () => {
  // The register's contact is often a registrant or a US agent. When a person has put a real one
  // in, COALESCE(labs.x, EXCLUDED.x) keeps theirs; plain EXCLUDED.x would replace it every run.
  const set = updateSetClause(SEED);
  for (const col of ['contact_name', 'contact_email']) {
    assert.match(set, new RegExp(`${col}\\s*=\\s*COALESCE\\(labs\\.${col}`),
      `${col} must be COALESCEd so a corrected value survives the next import`);
  }
});

test('the register facts DO refresh', () => {
  // The mirror image: an import that updates nothing is a snapshot that goes stale. Address,
  // country and region come from the register and must follow it.
  const set = updateSetClause(SEED);
  for (const col of ['region', 'country', 'state', 'city']) {
    assert.match(set, new RegExp(`\\b${col}\\s*=\\s*EXCLUDED\\.${col}`), `${col} should refresh from the register`);
  }
});

test('everything is imported as discovered — nothing arrives pre-approved', () => {
  // A lab in this table has not been contacted and does not know it is here. Routing an order to
  // a firm that never agreed to receive one is the worst thing this product could do, so the
  // import has no path to any other status.
  assert.match(SEED, /'discovered'/, "the INSERT must set status 'discovered' explicitly");
  for (const bad of ['active', 'onboarding', 'approved']) {
    assert.ok(!new RegExp(`status[^\\n]*'${bad}'`).test(SEED.replace(/--[^\n]*/g, '')),
      `the import must never write status '${bad}'`);
  }
});

test('excluded firms are counted and NOT imported', () => {
  // A non-empty exclusion_flag is the FDA saying something about the firm. It must not become a
  // row the agent can email, and it must not disappear silently either — a count nobody sees is
  // how an excluded firm ends up in an outreach list six months later.
  assert.match(SEED, /exclusion_flag/);
  assert.match(SEED, /stats\.excluded \+= 1/);
  assert.match(SEED, /continue;/, 'an excluded row must skip the candidate list entirely');
  assert.match(SEED, /EXCLUDED, not imported/, 'and the count must be printed');
});

test('the import refuses to run when its central assumption is wrong', () => {
  // The filter is `operations ILIKE '%ANALYSIS%'`, and ANALYSIS being the token for analytical
  // testing is an inference. If it is absent the import would write nothing and report success,
  // which reads as "there are no labs" rather than "the filter is wrong".
  assert.match(SEED, /hasAnalysis/);
  assert.match(SEED, /process\.exit\(1\)/);
  const guard = SEED.slice(SEED.indexOf('if (!hasAnalysis)'), SEED.indexOf('const noOps'));
  assert.match(guard, /process\.exit\(1\)/, 'a missing token must exit non-zero, not continue');
});

test('it is a DRY RUN unless asked otherwise', () => {
  // The first question anybody has is the count, and answering it should not write a thousand rows.
  assert.match(SEED, /const WRITE = process\.argv\.includes\('--write'\)/);
  const dryBlock = SEED.slice(SEED.indexOf('if (!WRITE)'), SEED.indexOf('// ── the write'));
  assert.match(dryBlock, /return;/, 'the dry run must return before any INSERT');
  // And the INSERT must sit after that return, not before it.
  assert.ok(SEED.indexOf('if (!WRITE)') < SEED.indexOf('INSERT INTO labs'),
    'the write happens before the dry-run guard, so a report run would mutate the database');
});

// ── the schema decisions that the CEO's instruction depends on ────────────────

test('labs is its own table, not a row in SiteNex partners', () => {
  // "This is not part of SiteNex." `sitenex_deals.partner_id` references `partners`, and the
  // SiteNex Partners page lists every row in it — so labs in that table would appear on a web
  // partner's territory screen and be scoped by partnerScopeSql, which was never written for them.
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS labs/);
  const sql = MIGRATION.replace(/\/\/[^\n]*/g, '').replace(/--[^\n]*/g, '');
  assert.ok(!/REFERENCES\s+partners/.test(sql), 'labs must not hang off the SiteNex partner table');
  assert.ok(!/partner_territories/.test(sql), 'and must not reuse SiteNex territory rows');
});

test('a test capability is NOT exclusive — the inversion from SiteNex', () => {
  // In SiteNex an exclusive patch is enforced by a partial unique index, because exclusivity
  // protects a partner's prospecting. Here many labs per test is the whole point: routing picks on
  // price, turnaround and capacity. An exclusivity constraint would be a defect, not a feature.
  const sql = MIGRATION.replace(/\/\/[^\n]*/g, '').replace(/--[^\n]*/g, '');
  assert.match(sql, /UNIQUE \(lab_id, test_code\)/, 'one price per lab per test');
  assert.ok(!/exclusive/i.test(sql), 'nothing in the LabConnect schema may be exclusive');
  // And the unique key must include lab_id, or it would permit only one lab per test.
  assert.ok(!/UNIQUE \(test_code\)/.test(sql), 'a unique key on test_code alone allows ONE lab per test');
});

test('a lab price may be NULL and must never be rendered as zero', () => {
  // The same rule the SiteNex packages screen follows: a lab that will run a test but has not
  // quoted is still routable, and NOT NULL DEFAULT 0 would turn "not priced" into "free".
  const sql = MIGRATION.replace(/--[^\n]*/g, '');
  const col = sql.slice(sql.indexOf('price_cents'), sql.indexOf('currency'));
  assert.ok(!/NOT NULL/.test(col), 'price_cents must be nullable');
  assert.ok(!/DEFAULT\s+0/.test(col), 'and must not default to zero');
});
