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

console.log(`affiliation parsing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
