'use strict';
// Strings and addresses here are taken from the live probe output across three topics, not
// invented. Hand-made fixtures are why nineteen passing tests missed the pdf kerning bug: made-up
// data has the shape you were already expecting.

const {
  cleanEmail, extractEmails, institutionFrom, departmentFrom,
  normalizeInstitution, normalizePerson, attributeEmail,
} = require('./affiliation');

let pass = 0; let fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else { fail += 1; console.error(`  ✗ ${label}\n      got  ${g}\n      want ${w}`); }
};
const ok = (c, label) => { if (c) pass += 1; else { fail += 1; console.error(`  ✗ ${label}`); } };

// ── ADDRESSES OUT OF PROSE ───────────────────────────────────────────────────

// The sentence-ending period is the one that matters: left on, every address bounces and the list
// looks bought rather than parsed.
eq(cleanEmail('priyankar.paira@vit.ac.in.'), 'priyankar.paira@vit.ac.in', 'trailing period stripped');
eq(cleanEmail('  T.Tan@imperial.ac.uk;  '), 't.tan@imperial.ac.uk', 'case folded, semicolon stripped');
eq(cleanEmail('(blp@mit.edu)'), 'blp@mit.edu', 'parenthesised');
eq(cleanEmail('a@b'), null, 'no TLD is not an address');
// Leading punctuation is stripped rather than rejected: in prose a dot before an address is the
// previous sentence ending, so "...address:.a@b.com" should yield a@b.com, not nothing.
eq(cleanEmail('.a@b.com'), 'a@b.com', 'leading punctuation stripped, address kept');
// A dot INSIDE the local part is different — nothing strips it, and it cannot be valid.
eq(cleanEmail('a..b@c.com'), null, 'doubled dot in local part rejected');
eq(cleanEmail('a.@b.com'), null, 'local part cannot end with a dot');
eq(cleanEmail(''), null, 'empty');
eq(cleanEmail(null), null, 'null');

eq(extractEmails(
  'Department of Chemistry, University of Delaware, Newark, DE, USA. Electronic address: '
  + 'dwatson@udel.edu.'),
['dwatson@udel.edu'], 'Electronic address: label with trailing period');

eq(extractEmails(
  'Imperial College London, UK. e-mail: t.tan@imperial.ac.uk; j.deanfield@ucl.ac.uk.'),
['t.tan@imperial.ac.uk', 'j.deanfield@ucl.ac.uk'], 'two addresses, both cleaned');

eq(extractEmails('School of Chemistry, KMITL, Bangkok, Thailand. duangkamol.gl@kmitl.ac.th'),
  ['duangkamol.gl@kmitl.ac.th'], 'bare address at end of string');

eq(extractEmails('No contact details in this affiliation at all.'), [], 'none present');
eq(extractEmails('Centre of Chemistry of University of Minho (CQ-UM), Campus de Gualtar, Portugal'),
  [], 'ordinary affiliation yields nothing');

// ── INSTITUTION AND DEPARTMENT ───────────────────────────────────────────────

eq(institutionFrom('Department of Chemistry, University of Delaware, Newark, DE 19716, United States.'),
  'University of Delaware', 'university preferred over its department');
eq(departmentFrom('Department of Chemistry, University of Delaware, Newark, DE 19716, United States.'),
  'Department of Chemistry', 'department segment found');

// The parent body, not the sub-unit: a centre inside a university is still that university's
// purchasing. Grouping on the centre would split one customer into several.
eq(institutionFrom('Centre of Chemistry of University of Minho (CQ-UM), Campus de Gualtar, Braga, Portugal'),
  'Centre of Chemistry of University of Minho (CQ-UM)', 'single segment kept whole');

eq(institutionFrom('State Key Laboratory Basis of Xinjiang Indigenous Medicinal Plant Resource '
  + 'Utilization, Xinjiang Technical Institute of Physics and Chemistry, Chinese Academy of Sciences'),
'Chinese Academy of Sciences', 'last organisation wins — the parent academy');

eq(institutionFrom('Corporal Michael J. Crescenz Veterans Affairs Medical Center, Philadelphia, PA, USA'),
  'Corporal Michael J. Crescenz Veterans Affairs Medical Center', 'VA medical center recognised');

// The email must not leak into the institution name, or every row becomes unique.
ok(!/@/.test(institutionFrom(
  'Department of Chemistry, University of Delaware, USA. Electronic address: dwatson@udel.edu.') || ''),
'address stripped before segmenting');

eq(departmentFrom('University of Florida, Gainesville, FL, USA'), null, 'no department present');

// ── NORMALISATION ────────────────────────────────────────────────────────────

ok(normalizeInstitution('The University of Delaware') === normalizeInstitution('University of Delaware'),
  '"The" does not create a second customer');
ok(normalizeInstitution('Univ of Michigan') === normalizeInstitution('University of Michigan'),
  'Univ expands');
ok(normalizeInstitution('Texas A&M University') === normalizeInstitution('Texas A and M University'),
  'ampersand folded');
eq(normalizePerson('Donald Allen Watson'), 'donald allen watson', 'person normalised');

// ── ATTRIBUTION — EARNED, NOT ASSUMED ────────────────────────────────────────
// Every local-part shape below was observed in the probe output.

const tan = { firstName: 'Tricia', lastName: 'Tan' };
const dean = { firstName: 'John', lastName: 'Deanfield' };
eq(attributeEmail('t.tan@imperial.ac.uk', [tan, dean]), tan, 'initial + surname');
eq(attributeEmail('j.deanfield@ucl.ac.uk', [tan, dean]), dean, 'initial + longer surname');

const paira = { firstName: 'Priyankar', lastName: 'Paira' };
eq(attributeEmail('priyankar.paira@vit.ac.in', [paira]), paira, 'given + surname');

// Thai given-name-first convention: the local part leads with the GIVEN name.
const duang = { firstName: 'Duangkamol', lastName: 'Gleeson' };
eq(attributeEmail('duangkamol.gl@kmitl.ac.th', [duang]), duang, 'given name + surname initials');

// Ambiguity declines. Two authors equally consistent with "li@x.edu" means we do not know whose
// address it is, and a stranger must not receive commercial mail about someone else's paper.
const liA = { firstName: 'Chenglong', lastName: 'Li' };
const liB = { firstName: 'Wei', lastName: 'Li' };
eq(attributeEmail('li@ufl.edu', [liA, liB]), null, 'short shared surname is not evidence');
eq(attributeEmail('zhang@vcu.edu', [{ firstName: 'Yan', lastName: 'Zhang' },
  { firstName: 'Ming', lastName: 'Zhang' }]), null, 'two Zhangs — decline');

// A surname that matches nobody attributes to nobody.
eq(attributeEmail('someone.else@mit.edu', [tan, dean]), null, 'no match returns null');
eq(attributeEmail('t.tan@imperial.ac.uk', []), null, 'no authors returns null');
eq(attributeEmail('not-an-email', [tan]), null, 'invalid address returns null');

// A long surname alone IS evidence — "wendlandt@mit.edu" could not plausibly be anyone else.
const wend = { firstName: 'Alison', lastName: 'Wendlandt' };
eq(attributeEmail('wendlandt@mit.edu', [wend, tan]), wend, 'distinctive surname alone suffices');

// NOTE: no process.exit here. An early exit in the middle of a test file does not fail — it
// SKIPS everything below it and reports success, which is how the Miller tests below ran zero
// times while the suite printed "35 passed, 0 failed". One verdict, at the end of the file.

// ── THE THREE MILLERS ────────────────────────────────────────────────────────
// Real addresses returned by probe-pi-email.js while searching for Scott J Miller at Yale.
// attributeEmail accepted all three because each is a genuine author named Miller. Only one is
// the person we were looking for. Named explicitly so that loosening the rule has to delete a
// test about two real scientists who would otherwise have been mailed about a stranger's grant.
const { orgKeyword, attributeToPi } = require('./affiliation');

const SCOTT = { first: 'Scott', last: 'Miller' };
const paperAuthors = [
  { firstName: 'Scott', lastName: 'Miller' },
  { firstName: 'Sophie', lastName: 'Miller' },
  { firstName: 'Edward', lastName: 'Miller' },
];

eq(attributeToPi('scott.miller@yale.edu', paperAuthors, SCOTT),
  { firstName: 'Scott', lastName: 'Miller' }, 'the right Miller is accepted');
eq(attributeToPi('sophie.miller@sahmri.com', paperAuthors, SCOTT), null,
  'Sophie Miller (South Australia) rejected — same surname, different person');
eq(attributeToPi('edward.miller@yale.edu', paperAuthors, SCOTT), null,
  'Edward Miller (same university!) rejected — surname is not sufficient');

// A shared first initial must not rescue a mismatch: Scott and Sophie are both S.
eq(attributeToPi('s.miller@yale.edu', [{ firstName: 'Sophie', lastName: 'Miller' }], SCOTT), null,
  'initial-only local part with a contradicting author record is rejected');
eq(attributeToPi('s.miller@yale.edu', [{ firstName: 'Scott', lastName: 'Miller' }], SCOTT),
  { firstName: 'Scott', lastName: 'Miller' }, 'initial + surname accepted when the author agrees');

// Initial glued to surname — the form that actually worked for Rivera.
eq(attributeToPi('mrivera@lsu.edu', [{ firstName: 'Mario', lastName: 'Rivera' }],
  { first: 'Mario', last: 'Rivera' }), { firstName: 'Mario', lastName: 'Rivera' },
'initial+surname concatenated is accepted');

// Diminutives agree; unrelated given names do not.
eq(attributeToPi('chris.jones@ox.ac.uk', [{ firstName: 'Christopher', lastName: 'Jones' }],
  { first: 'Christopher', last: 'Jones' }), { firstName: 'Christopher', lastName: 'Jones' },
'shortened given name agrees');
eq(attributeToPi('robert.jones@ox.ac.uk', [{ firstName: 'Robert', lastName: 'Jones' }],
  { first: 'Christopher', last: 'Jones' }), null, 'different given name rejected');
eq(attributeToPi('x@y.com', paperAuthors, SCOTT), null, 'unmatchable address rejected');
eq(attributeToPi('scott.miller@yale.edu', paperAuthors, null), null, 'no target PI rejected');

// ── THE AFFILIATION KEYWORD ──────────────────────────────────────────────────
// AFF:"<RePORTER spelling>" returned 0 hits for all five PIs probed. These are the real strings.
eq(orgKeyword('LOUISIANA STATE UNIV A&M COL BATON ROUGE'), 'louisiana', 'LSU reduces to louisiana');
eq(orgKeyword('UNIVERSITY OF ILLINOIS AT URBANA-CHAMPAIGN'), 'illinois', 'Illinois');
eq(orgKeyword('UNIVERSITY OF PENNSYLVANIA'), 'pennsylvania', 'Penn');
eq(orgKeyword('YALE UNIVERSITY'), 'yale', 'Yale');
eq(orgKeyword('MASSACHUSETTS GENERAL HOSPITAL'), 'massachusetts', 'stopwords skipped');
ok(orgKeyword('UNIVERSITY OF MINNESOTA') === 'minnesota', 'Minnesota');
ok(orgKeyword('') === '', 'empty org is empty keyword');

console.log(`pi attribution: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
