// ── A PROPOSAL TOOL THAT CAN APPLY IS NOT A PROPOSAL TOOL ───────────────────
//
//   node --test scripts/proposal-is-readonly.test.js
//
// Owner requirement 7: "Prepare a reviewable mapping proposal for all registered production
// workflows. Do not automatically assign production workflows to companies."
//
// The risk is not that someone writes an apply step on purpose. It is that a proposal tool grows
// a `--apply` flag six weeks from now because running two commands is tedious, and from then on
// the dry run is something nobody reads. This test is what makes that a deliberate act: adding the
// flag means deleting an assertion that says why it must not exist.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { blankCommentsOnly } = require('./js-lex');

const FILE = path.join(__dirname, 'propose-workflow-company-mappings.js');
const code = blankCommentsOnly(fs.readFileSync(FILE, 'utf8'));

test('the proposal tool contains no write to workflow_companies', () => {
  // Matched as statements, not words: this file's own prose names every one of these, and a guard
  // that fires on its own documentation is the defect pattern this repository keeps paying for.
  for (const forbidden of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+workflow_companies\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bmapWorkflowToCompany\s*\(/,
    /\bunmapWorkflow\s*\(/,
  ]) {
    assert.doesNotMatch(code, forbidden,
      `the proposal tool must not be able to assign a workflow to a company (${forbidden})`);
  }
});

test('CONTROL: the forbidden patterns DO match the accessor that is allowed to write', () => {
  // Without this, the test above would pass against an empty file, or against a regex that matches
  // nothing at all — which is the way a scanner quietly stops scanning.
  const accessor = blankCommentsOnly(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'identity', 'workflow-company.js'), 'utf8'));
  assert.match(accessor, /\bINSERT\s+INTO\b/i, 'the accessor does write, so the pattern is live');
  assert.match(accessor, /\bUPDATE\s+workflow_companies\b/i);
});

test('it says plainly that nothing was applied', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.match(src, /PROPOSAL ONLY|NOT applied|assigns nothing/i,
    'an operator reading the output must not have to infer that it changed nothing');
});

test('a workflow with no declared company is NOT proposed a default', () => {
  // The whole point of the bridge is that there is no default company. A proposal that filled the
  // gap with "the only active company" would reintroduce the guess by another route — and these
  // nine include the 7am CEO briefing and the 8am assignments, the sends this exists to restore.
  assert.match(code, /NEEDS_A_DECISION/,
    'an absent declaration must be reported as needing a decision, never filled in');
  assert.doesNotMatch(code, /\|\|\s*companies\[0\]|first\s*company|only\s*active\s*company/i,
    'no fallback to a first or only company');
});
