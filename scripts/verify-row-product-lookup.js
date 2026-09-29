// ── row:prospects.product — REAL DATABASE verification (self-cleaning) ──
//
// The sweep test proves the MATCHER reaches this route; it stubs the lookup, so the database half is
// unproven. Traffic will not prove it either: the SiteNex screen calls /api/sitenex/prospects, NOT
// /api/prospects/:id, so clicking SiteNex rows never exercises it — somebody would have to open the
// classic Prospects page and click a row. After three days of shadow it had never been hit.
//
// That matters more than any other route in the map. GET /api/prospects/:id carries no product in the
// request at all: a guessed id reads another product's row, and PUT MODIFIES it. If the lookup is
// wrong, fail-closed hides the bug (everything 403s) or — worse — a bad lookup returns the wrong
// product and the boundary waves it through.
//
// So: insert one golfnex row and one sitenex row, resolve both through the REAL query the middleware
// uses, assert each returns its own product, and assert a missing id resolves UNRESOLVED rather than
// permitted. Rows are deleted in a finally, and their place_ids are prefixed so a leak is obvious.
//
// Run:  railway ssh 'node scripts/verify-row-product-lookup.js'

const { query } = require('../src/lib/db');
const { resolveProduct } = require('../src/lib/products/resolve-product');

const TAG = 'VERIFY-ROW-LOOKUP-' + Date.now();
let created = [];
let failures = 0;

// The SAME lookup the middleware builds (boundary.js). Deliberately duplicated here rather than
// imported through the middleware factory, so this verifies the SQL itself against a real table.
const lookupRowProduct = async (table, column, id) => {
  const r = await query(`SELECT ${column} AS product FROM ${table} WHERE id = $1`, [id]);
  return (r.rows[0] && r.rows[0].product) || null;
};

const req = (method, id) => ({
  method, originalUrl: `/api/prospects/${id}`, url: `/api/prospects/${id}`,
  params: { id: String(id) }, query: {}, body: {}, headers: {},
});

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

(async () => {
  try {
    for (const product of ['golfnex', 'sitenex']) {
      const r = await query(
        `INSERT INTO prospects (product, place_id, name, status, created_at)
         VALUES ($1, $2, $3, 'new', NOW()) RETURNING id`,
        [product, `${TAG}-${product}`, `${TAG} ${product} fixture`]);
      created.push({ id: r.rows[0].id, product });
    }
    console.log(`fixtures: ${created.map(c => `${c.product}#${c.id}`).join(', ')}\n`);

    for (const { id, product } of created) {
      for (const method of ['GET', 'PUT']) {
        const res = await resolveProduct(req(method, id), { lookupRowProduct });
        check(`${method} /api/prospects/${id} (a ${product} row) resolves to '${product}'`,
          { product: res.product, unresolved: res.unresolved }, { product, unresolved: false });
      }
    }

    // A row that does not exist must be UNRESOLVED — not permitted, and not silently allowed. Under
    // enforce this 403s, which is right: the handler would 404 anyway, and guessing "allowed" here is
    // exactly the hole this resolver value exists to close.
    const missing = await resolveProduct(req('GET', 999999999), { lookupRowProduct });
    check('GET a nonexistent id resolves UNRESOLVED (fail closed), not permitted',
      { product: missing.product, unresolved: missing.unresolved }, { product: null, unresolved: true });

    const putMissing = await resolveProduct(req('PUT', 999999999), { lookupRowProduct });
    check('PUT a nonexistent id likewise — a guessed id must not become a write',
      { product: putMissing.product, unresolved: putMissing.unresolved }, { product: null, unresolved: true });

    // A lookup that throws (DB down mid-request) must also fail closed rather than pass.
    const broken = await resolveProduct(req('GET', created[0].id), {
      lookupRowProduct: async () => { throw new Error('connection reset'); },
    });
    check('a failing lookup fails closed', { product: broken.product, unresolved: broken.unresolved },
      { product: null, unresolved: true });

    // And the cross-product case stated plainly: an sitenex holder asking for a golfnex row resolves to
    // GOLFNEX, so the middleware compares 'golfnex' against their grants and refuses. That is the
    // whole point of the row lookup.
    const golfnexRow = created.find(c => c.product === 'golfnex');
    const asSitenexUser = await resolveProduct(req('GET', golfnexRow.id), { lookupRowProduct });
    check("a golfnex row resolves to 'golfnex' regardless of who asks (so an sitenex-only user is refused)",
      asSitenexUser.product, 'golfnex');
  } catch (e) {
    failures++;
    console.error('ERROR:', e.message);
  } finally {
    for (const c of created) {
      await query(`DELETE FROM prospects WHERE id = $1 AND place_id LIKE $2`, [c.id, TAG + '%']).catch(() => {});
    }
    const leaked = (await query(`SELECT COUNT(*)::int n FROM prospects WHERE place_id LIKE $1`, [TAG + '%'])).rows[0].n;
    console.log(`\ncleanup: ${created.length} fixture row(s) deleted, ${leaked} leaked`);
    if (leaked) failures++;
    console.log(failures === 0 ? '\n✅ ALL CHECKS PASSED — the row lookup is verified against a real table'
                               : `\n❌ ${failures} CHECK(S) FAILED — do NOT switch to enforce`);
    process.exit(failures === 0 ? 0 : 1);
  }
})();
