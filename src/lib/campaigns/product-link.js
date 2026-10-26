// ── A LINK IN A COLD EMAIL IS A PROMISE ──────────────────────────────────────
//
// The email opens with a true fact about the recipient's own work. If it then ends in a link that
// 404s, or lands on a page for a different molecule, we have proved the opposite of what the
// opening sentence claimed: that nobody checked. A broken link is worse than no link, and the
// email reads fine without one.
//
// So this resolves a molecule to a marketplace URL and returns null unless it can CONFIRM the page
// is real and is about that molecule. Null is the normal, expected answer, not an error.
//
// ── WHY A 200 IS NOT ENOUGH ──────────────────────────────────────────────────
//
// Many storefronts render client-side and answer 200 for every path, including nonsense, leaving
// the "not found" to JavaScript. abiozen.com happens to return a real 404 today (checked:
// /this-page-does-not-exist-12345 → 404), but that is a property of the current deployment, not a
// guarantee, and the day it changes every molecule would resolve to a link that looks fine to this
// code and is empty to the reader.
//
// Two conditions, both required: the response is 200, AND the page body mentions the molecule.
// The second is what actually proves the page is about the thing we are linking to.
//
// ── WHY THE URL PATTERN IS CONFIGURED AND NEVER GUESSED ──────────────────────
//
// There is no product URL in supplier_products — those rows are what suppliers sent us, not
// marketplace listings. The listings live in the Abiozen storefront, and probing /products,
// /product, /shop and /catalog all returned 404, so the pattern is not something this module can
// infer. Guessing one would produce exactly the plausible-but-wrong behaviour this file exists to
// prevent, so with no pattern configured EVERY lookup returns null and the emails simply carry no
// link. That is a working state, and a quiet one.
'use strict';

// e.g. ABIOZEN_PRODUCT_URL="https://abiozen.com/catalogue/{slug}"
// {slug} is replaced with a slugified molecule name; {name} with the URL-encoded name.
const PATTERN = process.env.ABIOZEN_PRODUCT_URL || '';
const TIMEOUT_MS = 6000;

// ── GREEK LETTERS ARE PART OF THE COMPOUND'S IDENTITY ────────────────────────
//
// Stripping non-alphanumerics turned "β-Estradiol" into "estradiol" — which also happens to be
// what "α-Estradiol" becomes. α-tocopherol and β-tocopherol are different products with different
// prices, and under a naive squash the page for one would verify as a match for the other. The
// link would resolve, the check would pass, and a customer would be sent to the wrong compound.
//
// So Greek letters are transliterated to their names rather than deleted, which keeps them in both
// the slug and the comparison. A page spelling it "beta-estradiol" still matches; a page about the
// alpha isomer no longer does.
const GREEK = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta',
  θ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi',
  ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon',
  φ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
};
const deGreek = (s) => String(s || '').toLowerCase()
  .replace(/[α-ω]/g, (c) => (GREEK[c] ? `-${GREEK[c]}-` : c));

const slugify = (s) => deGreek(s)
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// Loose comparison for "does this page talk about this molecule": letters and digits only, so
// "Metformin Hydrochloride" matches "metformin-hydrochloride", while the Greek prefix survives as
// letters and keeps the isomers apart.
const squash = (s) => deGreek(s).replace(/[^a-z0-9]+/g, '');

/** Per-process cache. A daily batch asks about the same molecules repeatedly. */
const cache = new Map();

/**
 * Resolve a molecule to a verified marketplace URL.
 *
 * @param {string} molecule
 * @param {object} [opts]
 * @param {boolean} [opts.approved]  the catalogue row's review_status === 'approved'
 * @param {function} [opts.fetchImpl] injected for tests
 * @param {string} [opts.pattern]     overrides the env pattern
 * @returns {Promise<{url: string, verified: true}|null>} null whenever it cannot be confirmed
 */
async function resolveProductLink(molecule, opts = {}) {
  const name = String(molecule || '').trim();
  if (!name) return null;

  // An unapproved product is one nobody has signed off for sale. Linking to it invites an order we
  // may not be able to honour, which is the same broken promise by a slower route.
  if (opts.approved !== true) return null;

  const pattern = opts.pattern !== undefined ? opts.pattern : PATTERN;
  if (!pattern) return null;

  const key = `${pattern}|${name}`;
  if (cache.has(key)) return cache.get(key);

  const url = pattern
    .replace('{slug}', slugify(name))
    .replace('{name}', encodeURIComponent(name));

  const doFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) { cache.set(key, null); return null; }

  let result = null;
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    let res;
    try {
      res = await doFetch(url, ctl ? { signal: ctl.signal, redirect: 'follow' } : { redirect: 'follow' });
    } finally { if (timer) clearTimeout(timer); }

    if (res && res.status === 200) {
      const body = await res.text();
      // The page must actually name the molecule. This is the check that survives a storefront
      // which answers 200 for everything.
      if (squash(body).includes(squash(name))) result = { url, verified: true };
    }
  } catch (_) {
    // Network failure, timeout, abort, bad URL — all mean the same thing: we cannot confirm it,
    // so there is no link. Never throws: a link is a nicety and a send must not fail over one.
    result = null;
  }

  cache.set(key, result);
  return result;
}

/** Test seam. */
function _resetCache() { cache.clear(); }

module.exports = { resolveProductLink, slugify, _resetCache, PATTERN_CONFIGURED: !!PATTERN };
