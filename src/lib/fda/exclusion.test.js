// Is this establishment excluded?
//
//   node --test src/lib/fda/exclusion.test.js
//
// THE BUG THIS EXISTS FOR, verbatim from the first real run of the lab import:
//
//     importable                             0
//     EXCLUDED, not imported             3,437   ← FDA exclusion flag
//
//     excluded firms (first few):
//       LIFEPharma FZE (ARE), CATALENT ARGENTINA S.A.I.C. (ARG), Glenmark Generics S.A. (ARG) …
//
// Every analytical laboratory in the FDA register was discarded by a check that read "a non-empty
// exclusion_flag means the FDA has excluded this firm". The column is populated on nearly every
// row, so the filter matched everything — and the output reported it as diligence, which is the
// part that makes this worth a test file rather than a one-line fix.

const { test } = require('node:test');
const assert = require('node:assert');
const { isExcluded, excludedSql, notExcludedSql, EXCLUDED_VALUES } = require('./exclusion');

test('A POPULATED FLAG IS NOT AN EXCLUSION', () => {
  // The exact failure. These are the shapes a mostly-populated column takes, and not one of them
  // says a firm is barred from anything.
  for (const v of ['N', 'No', 'n', '0', 'FALSE', 'NONE', '-', '.', 'NA', 'N/A', 'null', 'UNKNOWN']) {
    assert.equal(isExcluded(v), false, `'${v}' must not read as an exclusion`);
  }
});

test('an affirmative value IS an exclusion', () => {
  for (const v of ['Y', 'y', 'YES', 'Yes', 'TRUE', '1', 'EXCLUDED', 'Exclusion']) {
    assert.equal(isExcluded(v), true, `'${v}' should read as an exclusion`);
  }
  // And a sentence that contains the word, which is how a free-text column would say it.
  assert.equal(isExcluded('EXCLUDED FROM LISTING'), true);
  assert.equal(isExcluded('Excluded pending review'), true);
});

test('empty, blank and absent are all not-excluded', () => {
  for (const v of [null, undefined, '', '   ', '\t']) assert.equal(isExcluded(v), false);
});

test('it does not match EXCL inside an unrelated word', () => {
  // The guard against the bare-substring version. If this column ever shifts by one and starts
  // carrying an address or a firm name, a looser test would start excluding real companies again —
  // which is precisely the failure mode being fixed.
  assert.equal(isExcluded('EXCLUSIVE DISTRIBUTOR'), false,
    "'exclusive' is not 'excluded' — a substring match on EXCL would get this wrong");
  assert.equal(isExcluded('Exclusively licensed'), false);
});

test('THE SQL AND THE JS AGREE — they are the same rule in two languages', () => {
  // Three call sites use the SQL and one uses the function. If they disagree, the census reports a
  // different number from the import that follows it, and the discrepancy is invisible.
  const sql = excludedSql();
  for (const v of EXCLUDED_VALUES) {
    assert.ok(sql.includes(`'${v}'`), `the SQL does not list '${v}', which isExcluded accepts`);
    assert.equal(isExcluded(v), true);
  }
  assert.match(sql, /LIKE '%EXCLUD%'/, 'and the free-text case must be in the SQL too');
  // The SQL must never be the old "is not null and not empty" shape.
  assert.ok(!/btrim\([^)]*\) <> ''\)\s*$/.test(sql), 'the SQL is back to matching any populated value');
});

test('the SQL takes a column expression, so a joined query can qualify it', () => {
  assert.match(excludedSql('e.exclusion_flag'), /e\.exclusion_flag/);
  assert.ok(!excludedSql('e.exclusion_flag').includes(' exclusion_flag IS'),
    'the bare column leaked through alongside the qualified one');
  assert.equal(notExcludedSql(), 'NOT ' + excludedSql());
});

test('GUARD: the default is to INCLUDE, and that is deliberate', () => {
  // Stated as a test because it is a judgement somebody may want to reverse, and reversing it
  // should be a decision rather than a tweak.
  //
  // Excluding wrongly is invisible and total: the directory empties and the report congratulates
  // itself. Including wrongly is visible at the next step, because a lab is reviewed by a person
  // before it is ever moved to 'active', and only an 'active' lab can receive an order.
  const unknownVocabulary = ['X', 'P', '2', 'REVIEW', 'PENDING', 'SEE NOTES', 'A'];
  for (const v of unknownVocabulary) {
    assert.equal(isExcluded(v), false,
      `'${v}' is not understood, and an unknown value must not silently delete a row from the directory`);
  }
});
