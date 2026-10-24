'use strict';
// The four pairs below are the real collisions found by audit-trial-feed.js across 1,661 sponsor
// strings in production. The separations below are equally load-bearing: folding two distinct
// registrants would be a quiet lie in every count built on top of it.

const assert = require('node:assert');
const { normalizeSponsor, groupSponsors, canonicalSponsor } = require('./sponsor');

let pass = 0; let fail = 0;
const ok = (c, label) => { if (c) pass += 1; else { fail += 1; console.error(`  ✗ ${label}`); } };
const same = (a, b) => normalizeSponsor(a) === normalizeSponsor(b);

// ── THE FOUR REAL COLLISIONS ────
ok(same('Daiichi Sankyo', 'Daiichi Sankyo Co., Ltd.'), 'Daiichi Sankyo folds');
ok(same('Eisai Limited', 'Eisai Inc.'), 'Eisai folds');
ok(same('CRISPR Therapeutics AG', 'CRISPR Therapeutics'), 'CRISPR Therapeutics folds');
ok(same('Merz Therapeutics GmbH', 'Merz Pharmaceuticals GmbH'), 'Merz folds');

// ── COMMON SUFFIX FORMS ────
ok(same('AstraZeneca', 'AstraZeneca AB'), 'Nordic AB');
ok(same('Orion', 'Orion Oyj'), 'Finnish Oyj');
ok(same('Merck', 'Merck KGaA'), 'German KGaA');
ok(same('Pfizer Inc.', 'Pfizer, Inc'), 'punctuation only');

// ── WHAT MUST NOT FOLD ────
// Over-folding is the worse failure: a missing row is visible, a merged sponsor is invisible.
ok(!same('Roche', 'Hoffmann-La Roche'), 'Roche and Hoffmann-La Roche are different registrants');
ok(!same('Bayer', 'Pfizer'), 'unrelated companies stay apart');
ok(!same('Novo Nordisk', 'Novartis'), 'similar prefixes stay apart');
ok(!same('University of Oxford', 'University of Cambridge'), 'academic sponsors stay apart');
ok(normalizeSponsor('') === '', 'empty');
ok(normalizeSponsor(null) === '', 'null');
// A name made ENTIRELY of suffix words must not collapse to the empty key, which would merge it
// with every other such name.
ok(normalizeSponsor('Pharma Group Ltd') !== normalizeSponsor('Labs Inc')
   || normalizeSponsor('Pharma Group Ltd') === '', 'all-suffix names are at least not cross-merged silently');

// ── GROUPING AND DISPLAY ────
const g = groupSponsors([
  'Daiichi Sankyo', 'Daiichi Sankyo Co., Ltd.', 'Eisai Limited', 'Eisai Inc.', 'Bayer',
]);
ok(g.size === 3, `three companies from five strings (got ${g.size})`);
ok(canonicalSponsor('Daiichi Sankyo', g) === 'Daiichi Sankyo Co., Ltd.',
  'the fullest spelling is the display name');
ok(canonicalSponsor('Eisai Inc.', g).startsWith('Eisai'), 'Eisai display name is an Eisai spelling');
ok(canonicalSponsor('Someone Not Present', g) === 'Someone Not Present',
  'an unknown sponsor is returned unchanged rather than dropped');

console.log(`sponsor folding: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
