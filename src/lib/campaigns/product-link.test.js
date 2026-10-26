// A link in a cold email is a promise. These guards are about the ways a link can look fine to
// the code and be broken to the reader.
'use strict';

const assert = require('assert');
const { resolveProductLink, slugify, _resetCache } = require('./product-link');

let pass = 0; const fails = [];
const t = (name, fn) => fn().then(() => { pass++; }).catch((e) => { fails.push(`${name}: ${e.message}`); });

const PATTERN = 'https://example.test/catalogue/{slug}';
// A fetch stand-in. `pages` maps url -> { status, body }.
const fake = (pages, log) => async (url) => {
  if (log) log.push(url);
  const p = pages[url];
  if (!p) return { status: 404, text: async () => 'Not Found' };
  if (p.throw) throw new Error('network');
  return { status: p.status, text: async () => p.body };
};

const tests = [];
const T = (n, f) => tests.push([n, f]);

// ── THE DEFAULT IS NO LINK ───────────────────────────────────────────────────

T('with no pattern configured every lookup returns null', async () => {
  _resetCache();
  const r = await resolveProductLink('Metformin Hydrochloride', { approved: true, pattern: '' });
  assert.strictEqual(r, null);
});

T('an unapproved product never gets a link', async () => {
  _resetCache();
  const url = 'https://example.test/catalogue/metformin-hydrochloride';
  const pages = { [url]: { status: 200, body: '<h1>Metformin Hydrochloride</h1>' } };
  // The page is real and correct — and the product is not signed off for sale, so no link.
  const r = await resolveProductLink('Metformin Hydrochloride', {
    approved: false, pattern: PATTERN, fetchImpl: fake(pages),
  });
  assert.strictEqual(r, null);
  const r2 = await resolveProductLink('Metformin Hydrochloride', {
    pattern: PATTERN, fetchImpl: fake(pages),   // approved omitted entirely
  });
  assert.strictEqual(r2, null);
});

T('an empty molecule name returns null', async () => {
  _resetCache();
  for (const m of ['', '   ', null, undefined]) {
    assert.strictEqual(await resolveProductLink(m, { approved: true, pattern: PATTERN }), null);
  }
});

// ── THE HAPPY PATH ───────────────────────────────────────────────────────────

T('an approved product with a real page resolves', async () => {
  _resetCache();
  const url = 'https://example.test/catalogue/metformin-hydrochloride';
  const r = await resolveProductLink('Metformin Hydrochloride', {
    approved: true,
    pattern: PATTERN,
    fetchImpl: fake({ [url]: { status: 200, body: '<h1>Metformin Hydrochloride</h1> 1115-70-4' } }),
  });
  assert.ok(r, 'a real approved page did not resolve');
  assert.strictEqual(r.url, url);
  assert.strictEqual(r.verified, true);
});

// ── THE WAYS A LINK LOOKS FINE AND IS NOT ────────────────────────────────────

T('a 404 returns null', async () => {
  _resetCache();
  const r = await resolveProductLink('Nonexistent Compound', {
    approved: true, pattern: PATTERN, fetchImpl: fake({}),
  });
  assert.strictEqual(r, null);
});

T('a storefront that answers 200 for everything still gets no link', async () => {
  // THE IMPORTANT ONE. Client-rendered shops return 200 for every path and leave "not found" to
  // JavaScript. Checking only the status would link every molecule to an empty page.
  _resetCache();
  const spa = async () => ({ status: 200, text: async () => '<div id="root"></div><script src="/app.js"></script>' });
  const r = await resolveProductLink('Metformin Hydrochloride', {
    approved: true, pattern: PATTERN, fetchImpl: spa,
  });
  assert.strictEqual(r, null, 'linked to a page that never mentions the molecule');
});

T('a page about a different molecule gets no link', async () => {
  _resetCache();
  const url = 'https://example.test/catalogue/olaparib';
  const r = await resolveProductLink('Olaparib', {
    approved: true,
    pattern: PATTERN,
    fetchImpl: fake({ [url]: { status: 200, body: '<h1>Paracetamol</h1> 103-90-2' } }),
  });
  assert.strictEqual(r, null, 'linked to a page for the wrong compound');
});

T('a network failure returns null rather than throwing', async () => {
  // A send must never fail because a nicety could not be confirmed.
  _resetCache();
  const boom = async () => { throw new Error('ECONNRESET'); };
  const r = await resolveProductLink('Metformin Hydrochloride', {
    approved: true, pattern: PATTERN, fetchImpl: boom,
  });
  assert.strictEqual(r, null);
});

T('the same molecule is fetched once per run', async () => {
  _resetCache();
  const url = 'https://example.test/catalogue/olaparib';
  const log = [];
  const f = fake({ [url]: { status: 200, body: 'Olaparib' } }, log);
  for (let i = 0; i < 4; i += 1) {
    await resolveProductLink('Olaparib', { approved: true, pattern: PATTERN, fetchImpl: f });
  }
  assert.strictEqual(log.length, 1, `fetched ${log.length} times`);
});

// ── SLUGS ────────────────────────────────────────────────────────────────────

T('molecule names slugify predictably', async () => {
  assert.strictEqual(slugify('Metformin Hydrochloride'), 'metformin-hydrochloride');
  assert.strictEqual(slugify('4-Aminopyridine'), '4-aminopyridine');
  assert.strictEqual(slugify('N,N-Dimethylformamide'), 'n-n-dimethylformamide');
  assert.strictEqual(slugify('  Olaparib  '), 'olaparib');
  // Greek letters become their names rather than vanishing — see below for why.
  assert.strictEqual(slugify('β-Estradiol'), 'beta-estradiol');
  assert.strictEqual(slugify('α-Tocopherol'), 'alpha-tocopherol');
});

T('isomers that differ only by a Greek prefix never match each other', async () => {
  // The bug this prevents: stripping non-alphanumerics turned both α-tocopherol and β-tocopherol
  // into "tocopherol", so the page for one verified as a match for the other. Different products,
  // different prices, and the customer is sent to the wrong compound by a check that passed.
  _resetCache();
  const alphaUrl = 'https://example.test/catalogue/alpha-tocopherol';
  const pages = { [alphaUrl]: { status: 200, body: '<h1>alpha-Tocopherol</h1>' } };

  const right = await resolveProductLink('α-Tocopherol', {
    approved: true, pattern: PATTERN, fetchImpl: fake(pages),
  });
  assert.ok(right, 'the alpha isomer did not resolve to its own page');
  assert.strictEqual(right.url, alphaUrl);

  // The beta isomer resolves to a different slug, and even if that page existed and said
  // "alpha-Tocopherol", the comparison would reject it.
  _resetCache();
  const betaOnAlphaPage = {
    'https://example.test/catalogue/beta-tocopherol': { status: 200, body: '<h1>alpha-Tocopherol</h1>' },
  };
  const wrong = await resolveProductLink('β-Tocopherol', {
    approved: true, pattern: PATTERN, fetchImpl: fake(betaOnAlphaPage),
  });
  assert.strictEqual(wrong, null, 'the beta isomer matched a page about the alpha isomer');
});

(async () => {
  for (const [n, f] of tests) await t(n, f);
  if (fails.length) {
    console.error(`FAIL  ${fails.length} of ${pass + fails.length}`);
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`ok  product-link — ${pass} passed`);
})();
