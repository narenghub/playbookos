// ── THE FACTS SOURCE WRITES NOTHING, AND NO MODEL CAN REACH IT ──────────────
//
// Owner's Priority 4, second directive of 2026-11-25: a *"governed, company-scoped, READ-ONLY
// operational facts source using existing authorized data-access modules"*, and *"do not allow
// model-generated facts to substitute for authoritative operational records."*
//
// Both are properties of the module's SHAPE rather than of any run of it, so they are asserted on
// the source. The alternative is a scenario that happens not to write and happens not to consult a
// model, which measures one run of one path — and this repository's recurring defect is exactly
// that substitution.
//
// Comments are BLANKED before the source is scanned. Without that, this file's own prose about
// `INSERT` would satisfy the assertions it is making, which is the mistake `validate-k5` made when
// it went red over a comment explaining a removed parameter.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'operational-facts.js');

/** Strip block and line comments and string literals: what is left is code that runs. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""');
}

const CODE = codeOnly(fs.readFileSync(FILE, 'utf8'));

test('it contains no SQL of its own — every figure comes from an accessor', () => {
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'SELECT', 'TRUNCATE', 'ALTER', 'DROP']) {
    assert.equal(new RegExp(`\\b${kw}\\b`, 'i').test(CODE), false,
      `${kw} appears in executable code: a facts source that writes its own queries is a second `
      + 'copy of the company filter');
  }
});

test('it never calls a query function directly', () => {
  for (const shape of [/\bquery\s*\(/, /\bq\s*\(\s*deps\s*\)/, /withTransaction\s*\(/]) {
    assert.equal(shape.test(CODE), false, `${shape} appears: the accessors own the connection`);
  }
});

test('no model, no provider, no prompt can reach it', () => {
  for (const forbidden of ['office/ai', './ai', 'llm', 'anthropic', 'openai', 'governedCall',
    'prompt', 'completion']) {
    assert.equal(CODE.toLowerCase().includes(forbidden.toLowerCase()), false,
      `${forbidden} appears in executable code: a fact must come from a record, and the way to `
      + 'guarantee that is for the facts path to have no seam a model could reach');
  }
});

test('it requires only the two accessor modules it composes', () => {
  const requires = [...CODE.matchAll(/require\(\s*''\s*\)|require\(([^)]*)\)/g)].map((m) => m[0]);
  // The string literals were blanked above, so the assertion is on the COUNT of requires and on
  // the un-blanked source for their targets — checked separately below.
  assert.ok(requires.length <= 2, `${requires.length} require() calls in code; expected at most 2`);

  const raw = fs.readFileSync(FILE, 'utf8');
  const targets = [...raw.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(targets, ['../identity/scoped-operations', './scope']);
});

test('the four states are one closed vocabulary, decided in one place', () => {
  const M = require('./operational-facts');
  assert.deepEqual(Object.keys(M.STATUS).sort(),
    ['MEASURED', 'MEASURED_ZERO', 'MISSING', 'STALE', 'UNAVAILABLE']);
  assert.ok(Object.isFrozen(M.STATUS));
  assert.ok(Object.isFrozen(M.KINDS));
  // `classify` is the only decider, so a family cannot invent a fifth reading of zero.
  assert.equal(typeof M.classify, 'function');
});

test('classify: a zero with unattributed rows behind it is MISSING, not a measured zero', () => {
  const M = require('./operational-facts');
  const now = Date.parse('2026-11-26T12:00:00Z');
  // THE DISTINCTION THE OWNER ASKED FOR, and the one that decides whether a CEO briefing's zero
  // means anything: scoped-operations returns nothing at all until attribution is applied, so a
  // zero beside 4,000 unowned rows is a figure nobody can support.
  const hidden = M.classify(0, { unattributed: 4000, staleAfterDays: 7, now });
  assert.equal(hidden.status, M.STATUS.MISSING);
  assert.match(hidden.detail, /attribution/);

  const genuine = M.classify(0, { unattributed: 0, staleAfterDays: 7, now });
  assert.equal(genuine.status, M.STATUS.MEASURED_ZERO);
});

test('classify: a real figure whose newest record is past the bound is STALE', () => {
  const M = require('./operational-facts');
  const now = Date.parse('2026-11-26T12:00:00Z');
  const stale = M.classify(3,
    { newestIso: '2026-10-01T00:00:00Z', staleAfterDays: 7, now });
  assert.equal(stale.status, M.STATUS.STALE);
  assert.match(stale.detail, /day\(s\) old/);

  const fresh = M.classify(3,
    { newestIso: '2026-11-25T00:00:00Z', staleAfterDays: 7, now });
  assert.equal(fresh.status, M.STATUS.MEASURED);

  // An undatable family is not stale by default — absence of a date is not evidence of age.
  assert.equal(M.classify(3, { newestIso: null, staleAfterDays: 7, now }).status,
    M.STATUS.MEASURED);
});

test('collect refuses to guess the business day', async () => {
  const M = require('./operational-facts');
  await assert.rejects(() => M.collect({ companyId: 'c' }, {}, {}), /asOf/);
  await assert.rejects(() => M.collect({ companyId: 'c' }, { asOf: 'yesterday' }, {}), /asOf/);
});
