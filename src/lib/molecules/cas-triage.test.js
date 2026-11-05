'use strict';
// Tests for the CAS conflict triage. The fixtures below are REAL name/CAS pairs taken from the
// production census run at cdd1201 — a triage validated only on invented data would be a triage
// validated on my own assumptions about what the data looks like.
//
// Every class that makes a SUGGESTION gets a negative control proving it does not fire on the
// shape it would be most embarrassing to mislabel.

const assert = require('assert');
const {
  triage, summarise, withinOneEdit, hasGradePhrase, isFormPair, CLASSES,
} = require('./cas-triage');

let pass = 0; let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; } catch (e) {
    fail += 1;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}
const classOf = (res, canon) => (res.find((g) => g.canonical === canon) || {}).class;

// ── withinOneEdit: the primitive under digit_adjacent ───────────────────────

t('withinOneEdit: real asciminib pair differs by one character', () => {
  assert.strictEqual(withinOneEdit('1492952-26-7', '1492952-76-7'), true);
});

t('withinOneEdit: identical numbers are not an edit', () => {
  assert.strictEqual(withinOneEdit('95058-81-4', '95058-81-4'), false);
});

t('withinOneEdit: the real enzalutamide pair differs by MORE than one character', () => {
  // 915087-27-3 vs 915095-89-5 — three positions differ. The census output groups these as
  // "digit-adjacent" to the eye; the primitive must not agree, or the class becomes a vibe.
  assert.strictEqual(withinOneEdit('915087-27-3', '915095-89-5'), false);
});

t('withinOneEdit: unrelated numbers of equal length are not adjacent', () => {
  assert.strictEqual(withinOneEdit('1802220-02-5', '1672668-24-4'), false);
});

t('withinOneEdit: a single inserted character counts', () => {
  assert.strictEqual(withinOneEdit('9505-81-4', '95058-81-4'), true);
});

t('withinOneEdit: two edits do not count', () => {
  assert.strictEqual(withinOneEdit('11111-11-1', '22211-11-1'), false);
});

// ── hasGradePhrase ─────────────────────────────────────────────────────────

t('hasGradePhrase: the three real grade wordings are detected', () => {
  assert.ok(hasGradePhrase('belzutifan reference standard'));
  assert.ok(hasGradePhrase('resmetirom usp/analytical reference standard'));
  assert.ok(hasGradePhrase('gemcitabine usp reference standard'));
});

t('hasGradePhrase: NEGATIVE CONTROL — a plain substance name is not a grade', () => {
  assert.ok(!hasGradePhrase('belzutifan'));
  assert.ok(!hasGradePhrase('gadoterate meglumine'));
  assert.ok(!hasGradePhrase('doxorubicinol'));
});

// ── isFormPair ─────────────────────────────────────────────────────────────

t('isFormPair: base + salt filed under one census group is a form pair', () => {
  assert.strictEqual(isFormPair(['gemcitabine', 'gemcitabine hcl']), true);
});

t('isFormPair: NEGATIVE CONTROL — one name alone is never a form pair', () => {
  // The ~29 single-name groups are the whole point of this exercise. If a single filed name
  // could be classed as a form pair, every one of them would be dismissed as "nothing wrong".
  assert.strictEqual(isFormPair(['gadoterate meglumine']), false);
  assert.strictEqual(isFormPair(['selumetinib hydrogen sulfate']), false);
  assert.strictEqual(isFormPair(['lutetium-177 chloride']), false);
});

t('isFormPair: NEGATIVE CONTROL — two unrelated substances are not a form pair', () => {
  assert.strictEqual(isFormPair(['doxorubicinol', 'idarubicin']), false);
});

// ── triage: the real classes, on real data ─────────────────────────────────

t('form_pair: the real gemcitabine de-salting case', () => {
  const res = triage([{
    canonical: 'gemcitabine',
    names: ['gemcitabine', 'gemcitabine hcl'],
    cas: ['95058-81-4', '122111-03-9'],
  }]);
  assert.strictEqual(res[0].class, 'form_pair');
  assert.strictEqual(res[0].needsHuman, false);
});

t('grade_duplicate: real belzutifan standard carrying its parent pair', () => {
  const res = triage([
    { canonical: 'belzutifan', names: ['belzutifan'], cas: ['1802220-02-5', '1672668-24-4'] },
    {
      canonical: 'belzutifan reference standard',
      names: ['belzutifan reference standard'],
      cas: ['1802220-02-5', '1672668-24-4'],
    },
  ]);
  assert.strictEqual(classOf(res, 'belzutifan reference standard'), 'grade_duplicate');
  assert.ok(/belzutifan/.test(
    res.find((g) => g.canonical === 'belzutifan reference standard').evidence.join(' '),
  ), 'evidence must name the parent group');
});

t('grade_duplicate: NEGATIVE CONTROL — a standard whose pair is NOT duplicated elsewhere '
  + 'is not dismissed as a duplicate', () => {
  // A grade phrase alone must not excuse a conflict. Only an identical set under another group
  // makes it a duplicate; otherwise it is a conflict in its own right and a person must see it.
  const res = triage([{
    canonical: 'someprofen reference standard',
    names: ['someprofen reference standard'],
    cas: ['11111-11-1', '22222-22-6'],
  }]);
  assert.notStrictEqual(res[0].class, 'grade_duplicate');
  assert.strictEqual(res[0].needsHuman, true);
});

t('cross_attached: the real doxorubicinol / idarubicin shared number', () => {
  const res = triage([
    { canonical: 'doxorubicinol', names: ['doxorubicinol'], cas: ['58957-92-9', '54193-28-1'] },
    { canonical: 'idarubicin', names: ['idarubicin'], cas: ['58957-92-9', '57852-57-0'] },
  ]);
  assert.strictEqual(classOf(res, 'doxorubicinol'), 'cross_attached');
  assert.strictEqual(classOf(res, 'idarubicin'), 'cross_attached');
  const ev = res.find((g) => g.canonical === 'doxorubicinol').evidence.join(' ');
  assert.ok(ev.includes('58957-92-9'), 'evidence must name the shared number');
  assert.ok(ev.includes('idarubicin'), 'evidence must name the other group');
});

t('cross_attached: the real gemcitabine / dfdu shared number', () => {
  const res = triage([
    {
      canonical: '2\' 2\'-difluorodeoxyuridine dfdu',
      names: ['2\' 2\'-difluorodeoxyuridine dfdu'],
      cas: ['95058-81-4', '114248-23-6'],
    },
    { canonical: 'gemcitabine', names: ['gemcitabine'], cas: ['95058-81-4', '122111-03-9'] },
  ]);
  assert.strictEqual(classOf(res, '2\' 2\'-difluorodeoxyuridine dfdu'), 'cross_attached');
});

t('cross_attached: NEGATIVE CONTROL — a number appearing once is not cross-attached', () => {
  const res = triage([
    { canonical: 'alpha', names: ['alpha'], cas: ['11111-11-1', '33333-33-9'] },
    { canonical: 'beta', names: ['beta'], cas: ['22222-22-6', '44444-44-2'] },
  ]);
  assert.ok(res.every((g) => g.class !== 'cross_attached'));
});

t('digit_adjacent: the real asciminib pair', () => {
  const res = triage([{
    canonical: 'asciminib', names: ['asciminib'], cas: ['1492952-26-7', '1492952-76-7'],
  }]);
  assert.strictEqual(res[0].class, 'digit_adjacent');
  assert.strictEqual(res[0].needsHuman, true);
  assert.ok(/SUGGESTS/.test(res[0].evidence.join(' ')),
    'a suggestion must be labelled as one, not asserted');
});

t('digit_adjacent: NEGATIVE CONTROL — the enzalutamide pair is NOT adjacent, so it lands '
  + 'in unexplained rather than being explained away', () => {
  const res = triage([{
    canonical: 'n-desmethyl enzalutamide',
    names: ['n-desmethyl enzalutamide'],
    cas: ['915087-27-3', '915095-89-5'],
  }]);
  assert.strictEqual(res[0].class, 'unexplained');
  assert.strictEqual(res[0].needsHuman, true);
});

t('unexplained: a real single-name multi-CAS group with no structural story', () => {
  const res = triage([{
    canonical: 'lutetium-177 chloride',
    names: ['lutetium-177 chloride'],
    cas: ['15158-54-8', '10099-54-0', '13813-23-5', '20461-71-0', '14255-04-0'],
  }]);
  assert.strictEqual(res[0].class, 'unexplained');
  assert.strictEqual(res[0].needsHuman, true);
  assert.ok(res[0].evidence.join(' ').includes('5'), 'evidence must state how many numbers');
});

// ── the ordering rule: no-action verdicts must not bury a real signal ──────

t('ORDERING: a form pair that ALSO shares a number is cross_attached, not dismissed', () => {
  // The real gemcitabine case, and the reason the order was rewritten. The group is a de-salted
  // form pair, which on its own means nothing is wrong — but 95058-81-4 also sits under dfdu.
  // Classified form_pair-first, the shared number would never have surfaced.
  const res = triage([
    {
      canonical: 'gemcitabine',
      names: ['gemcitabine', 'gemcitabine hcl'],
      cas: ['95058-81-4', '122111-03-9'],
    },
    {
      canonical: '2\' 2\'-difluorodeoxyuridine dfdu',
      names: ['2\' 2\'-difluorodeoxyuridine dfdu'],
      cas: ['95058-81-4', '114248-23-6'],
    },
  ]);
  assert.strictEqual(classOf(res, 'gemcitabine'), 'cross_attached',
    'a shared number must outrank the de-salting explanation');
  assert.strictEqual(res.find((g) => g.canonical === 'gemcitabine').needsHuman, true);
});

t('ORDERING: a form pair with no sharing and no adjacency IS still dismissed', () => {
  // The other half of the previous test. If form_pair stopped firing entirely, the backlog would
  // be inflated by every legitimate base/salt pair in the catalogue.
  const res = triage([{
    canonical: 'leuprolide',
    names: ['leuprolide', 'leuprolide acetate'],
    cas: ['53714-56-0', '74381-53-6'],
  }]);
  assert.strictEqual(res[0].class, 'form_pair');
  assert.strictEqual(res[0].needsHuman, false);
});

t('ORDERING: a grade duplicate does not make its PARENT cross_attached', () => {
  // The parent shares both numbers with its own grade variant. That is one substance filed twice,
  // not a cross-attachment, and reporting it as one would manufacture work.
  const res = triage([
    { canonical: 'belzutifan', names: ['belzutifan'], cas: ['1802220-02-5', '1672668-24-4'] },
    {
      canonical: 'belzutifan reference standard',
      names: ['belzutifan reference standard'],
      cas: ['1802220-02-5', '1672668-24-4'],
    },
  ]);
  assert.strictEqual(classOf(res, 'belzutifan reference standard'), 'grade_duplicate');
  assert.strictEqual(classOf(res, 'belzutifan'), 'unexplained',
    'the parent must not be flagged for sharing numbers with its own duplicate');
});

t('ORDERING: a grade variant sharing a number with an UNRELATED group is still escalated', () => {
  // grade_duplicate requires an IDENTICAL set. A grade variant whose numbers merely overlap
  // another group must not be excused by its name.
  const res = triage([
    {
      canonical: 'someprofen reference standard',
      names: ['someprofen reference standard'],
      cas: ['22222-22-6', '44444-44-2'],
    },
    { canonical: 'otherdrug', names: ['otherdrug'], cas: ['44444-44-2', '657-24-9'] },
  ]);
  assert.strictEqual(classOf(res, 'someprofen reference standard'), 'cross_attached');
  assert.strictEqual(classOf(res, 'otherdrug'), 'cross_attached');
});

// ── invariants over the whole classification ───────────────────────────────

t('every group receives exactly one known class', () => {
  const res = triage([
    { canonical: 'gemcitabine', names: ['gemcitabine', 'gemcitabine hcl'], cas: ['95058-81-4', '122111-03-9'] },
    { canonical: 'asciminib', names: ['asciminib'], cas: ['1492952-26-7', '1492952-76-7'] },
    { canonical: 'lutetium-177 chloride', names: ['lutetium-177 chloride'], cas: ['15158-54-8', '10099-54-0'] },
  ]);
  for (const g of res) {
    assert.ok(CLASSES.includes(g.class), `unknown class ${g.class}`);
    assert.ok(Array.isArray(g.evidence) && g.evidence.length > 0,
      `${g.canonical} has no evidence — a class with no evidence is an assertion`);
    assert.strictEqual(typeof g.needsHuman, 'boolean');
  }
});

t('triage never mutates its input', () => {
  const input = [{ canonical: 'x', names: ['x'], cas: ['11111-11-1', '22222-22-6'] }];
  const before = JSON.stringify(input);
  triage(input);
  assert.strictEqual(JSON.stringify(input), before,
    'read-only means read-only, including in memory');
});

t('no class decides WHICH number is correct', () => {
  // The one guarantee this module makes to the ruling: it produces an evidence report and
  // changes no identity. If any evidence string ever says a number is wrong or should be
  // removed, that guarantee is gone.
  const res = triage([
    { canonical: 'doxorubicinol', names: ['doxorubicinol'], cas: ['58957-92-9', '54193-28-1'] },
    { canonical: 'idarubicin', names: ['idarubicin'], cas: ['58957-92-9', '57852-57-0'] },
    { canonical: 'asciminib', names: ['asciminib'], cas: ['1492952-26-7', '1492952-76-7'] },
  ]);
  const banned = /\b(is wrong|is incorrect|should be removed|delete|correct number is|the right one)\b/i;
  for (const g of res) {
    const ev = g.evidence.join(' ');
    assert.ok(!banned.test(ev), `${g.canonical} evidence prescribes a fix: ${ev}`);
  }
});

t('summarise counts classes and the human backlog', () => {
  const res = triage([
    { canonical: 'gemcitabine', names: ['gemcitabine', 'gemcitabine hcl'], cas: ['95058-81-4', '122111-03-9'] },
    { canonical: 'asciminib', names: ['asciminib'], cas: ['1492952-26-7', '1492952-76-7'] },
  ]);
  const s = summarise(res);
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.byClass.form_pair, 1);
  assert.strictEqual(s.byClass.digit_adjacent, 1);
  assert.strictEqual(s.needsHuman, 1, 'the form pair needs nobody; the adjacency needs a person');
});

t('an empty conflict list is not an error', () => {
  const s = summarise(triage([]));
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.needsHuman, 0);
});

console.log(`\ncas-triage: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
