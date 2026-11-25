// ── A MEMBERSHIP PROPOSAL THAT CAN GRANT IS NOT A PROPOSAL ──────────────────
//
//   node --test scripts/membership-proposal-is-readonly.test.js
//
// Owner instruction, carried since 2026-11-24: *"No automatic production grants. No membership
// inferred from domain, job title, or the approved workflow mappings."*
//
// The risk is not that somebody writes an apply step on purpose. It is that this tool grows an
// `--apply` flag six weeks from now because running two commands is tedious, and from then on the
// dry run is something nobody reads. This test makes that a deliberate act: adding the flag means
// deleting an assertion that says why it must not exist.
//
// Same shape as scripts/proposal-is-readonly.test.js, which does this for the workflow mappings.
// Deliberately a second file rather than a shared helper: the two tools forbid DIFFERENT things,
// and a generic "is read-only" helper would stop naming which.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { blankCommentsOnly } = require('./js-lex');

const FILE = path.join(__dirname, 'propose-company-memberships.js');
const raw = fs.readFileSync(FILE, 'utf8');
// Comments BLANKED, not stripped: line numbers survive, and prose about what the tool must not do
// cannot satisfy or trip an assertion about what it does. The lesson from validate-k5 grepping its
// own documentation.
const code = blankCommentsOnly(raw);

test('it contains no write to user_companies', () => {
  assert.doesNotMatch(code, /INSERT\s+INTO\s+user_companies/i);
  assert.doesNotMatch(code, /UPDATE\s+user_companies/i);
  assert.doesNotMatch(code, /DELETE\s+FROM\s+user_companies/i);
});

test('it never calls grantMembership or revokeMembership', () => {
  assert.doesNotMatch(code, /grantMembership\s*\(/);
  assert.doesNotMatch(code, /revokeMembership\s*\(/);
});

test('it has no --apply flag, and no flag that could become one', () => {
  assert.doesNotMatch(code, /--apply/);
  assert.doesNotMatch(code, /--grant/);
  assert.doesNotMatch(code, /--write/);
  assert.doesNotMatch(code, /--commit/);
});

test('it writes nothing at all: no INSERT, UPDATE or DELETE of any kind', () => {
  // Broader than the user_companies assertions on purpose. A proposal tool that wrote to some
  // OTHER table while being read-only about memberships would still be a tool that mutates
  // production while claiming to propose.
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(code, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(code, /\bTRUNCATE\b/i);
});

test('DECISIVE: it derives no membership from a domain, a title or a workflow mapping', () => {
  // The three sources the owner ruled out, asserted on the CODE rather than trusted to the prose
  // that explains them. A domain-derived backfill is the specific failure this project already
  // measured: prasanthi@adificetechnologies.com administers ABIOZEN.
  //
  // `domainOf`, `companyDomains` and `COMPANY_EMAIL_DOMAINS` are how this repository turns an
  // address into a domain, and `workflow_companies` / `CRON_SCOPES` are the workflow mappings.
  // None of them may appear.
  assert.doesNotMatch(code, /domainOf\s*\(/);
  assert.doesNotMatch(code, /companyDomains\s*\(/);
  assert.doesNotMatch(code, /COMPANY_EMAIL_DOMAINS/);
  assert.doesNotMatch(code, /workflow_companies/);
  assert.doesNotMatch(code, /CRON_SCOPES/);
  // And no split on '@', which is how a domain is extracted without naming it.
  assert.doesNotMatch(code, /split\s*\(\s*['"]@['"]/);
});

test('it proposes no company_role — guessing one would silently demote an administrator', () => {
  // The tool sets companyRole to null and says why. A proposal that guessed `member` would turn an
  // ABIOZEN administrator into an ordinary member, which is a quieter failure than no grant at all.
  assert.match(code, /companyRole:\s*null/);
  assert.doesNotMatch(code, /companyRole:\s*['"]member['"]/);
  assert.doesNotMatch(code, /companyRole:\s*['"]admin['"]/);
});

test('it exits 3 — NOT EXECUTED — rather than reporting an empty proposal it could not compute', () => {
  // A proposal nobody could compute is not an empty proposal. If this ever becomes exit 0 on an
  // unreadable database, the output reads as "nobody needs a membership", which is the opposite of
  // true and the most dangerous possible wrong answer for a backfill.
  assert.match(code, /process\.exit\(3\)/);
  assert.match(raw, /NOT EXECUTED/);
});

test('the sources it DOES consult both name a user and a company', () => {
  // objectives.created_by + objectives.company_id, and daily_tasks.user_id + daily_tasks.company_id.
  // Each is a record a person created deliberately, in the product, naming both sides — which is
  // what "reviewed assignment record" has to mean if it is to mean anything.
  assert.match(code, /objectives/);
  assert.match(code, /company_id IS NOT NULL/);
  assert.match(code, /daily_tasks/);
});
