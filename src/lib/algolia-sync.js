const { Pool } = require('pg');
const { query } = require('./db');
const { getAppId, getWriteKey, getRecommendationKey } = require('./algolia-keys');

// Unified marketplace catalog index. ALGOLIA_INDEX_NAME overrides; the
// hardcoded fallback is the canonical index so a missing env var still
// lands records in the right place.
const FALLBACK_INDEX = 'abiozen_products';
const indexName = () => process.env.ALGOLIA_INDEX_NAME || FALLBACK_INDEX;

const asBool = v => v === true || v === 't' || v === 'true' || v === 1 || v === '1';

async function pushToAlgolia(records) {
  const appId = getAppId();
  const apiKey = getWriteKey(); // write op — ALGOLIA_API_KEY (addObject ACL)
  if (!appId || !apiKey) throw new Error('ALGOLIA_APP_ID and ALGOLIA_API_KEY must be set');
  const index = indexName();
  const url = `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(index)}/batch`;
  const headers = {
    'X-Algolia-Application-Id': appId,
    'X-Algolia-API-Key': apiKey,
    'Content-Type': 'application/json',
  };
  const CHUNK = 1000;
  let indexed = 0;
  const taskIDs = [];
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const body = { requests: chunk.map(r => ({ action: 'addObject', body: r })) };
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Algolia batch failed: ${res.status} ${res.statusText} — ${txt.slice(0, 300)}`);
    }
    const data = await res.json();
    indexed += chunk.length;
    if (data.taskID) taskIDs.push(data.taskID);
  }
  return { indexed, index, taskIDs };
}

// ── PlaybookOS SKUs ─────────────────────────────────────────────────────────
// Runs against the server's own database via the shared pool.
function skuToRecord(s) {
  const description = [
    s.name,
    s.category,
    s.purity ? `${s.purity} purity` : null,
    s.cas_number ? `CAS ${s.cas_number}` : null,
    s.supplier ? `supplier ${s.supplier}` : null,
    asBool(s.is_gmp) ? 'GMP grade' : null,
  ].filter(Boolean).join(' · ');
  return {
    objectID: s.id,
    name: s.name,
    cas_number: s.cas_number || null,
    purity: s.purity != null ? Number(s.purity) : null,
    category: s.category || null,
    sale_price: s.sale_price != null ? Number(s.sale_price) : null,
    currency: s.currency || 'USD',
    sds_status: s.sds_status || null,
    coa_status: s.coa_status || null,
    supplier: s.supplier || null,
    is_gmp: asBool(s.is_gmp),
    description,
  };
}

async function syncPlaybookOSSkus() {
  const skus = (await query(
    `SELECT id, name, cas_number, purity, category, sale_price, currency,
            sds_status, coa_status, supplier, is_gmp
     FROM skus WHERE is_active=1 ORDER BY name`
  )).rows;
  if (skus.length === 0) {
    return { source: 'playbookos_skus', fetched: 0, indexed: 0, index: indexName(), taskIDs: [] };
  }
  const pushed = await pushToAlgolia(skus.map(skuToRecord));
  return { source: 'playbookos_skus', fetched: skus.length, ...pushed };
}

// ── Abiozen marketplace products ────────────────────────────────────────────
// Runs against the Abiozen production DB via a short-lived pool built from
// ABIOZEN_DATABASE_URL (a separate database from the PlaybookOS one).
function productToRecord(p) {
  return {
    objectID: p.id,
    name: p.name,
    cas_number: p.cas_number || null,
    purity: p.purity != null ? Number(p.purity) : null,
    category: p.category_name || null,
    price: p.price != null ? Number(p.price) : null,
    supplier_1kg_price: p.supplier_1kg_price != null ? Number(p.supplier_1kg_price) : null,
    currency: p.supplier_currency || 'USD',
    is_gmp: asBool(p.is_gmp),
    is_hazmat: asBool(p.is_hazmat),
    sds_status: p.sds_status || null,
    coa_status: p.coa_status || null,
    description: p.description || null,
    slug: p.slug || null,
  };
}

async function syncAbiozenProducts() {
  const abiozenUrl = process.env.ABIOZEN_DATABASE_URL;
  if (!abiozenUrl) throw new Error('ABIOZEN_DATABASE_URL is not configured');
  const pool = new Pool({ connectionString: abiozenUrl, ssl: { rejectUnauthorized: false } });
  let products;
  try {
    // status is VARCHAR in the Abiozen prod DB (documented schema drift) —
    // cast to text so the filter works regardless of the column's actual type.
    products = (await pool.query(`
      SELECT p.id, p.name, p.cas_number, p.purity, p.price, p.supplier_1kg_price,
             p.supplier_currency, p.is_gmp, p.is_hazmat, p.sds_status, p.coa_status,
             p.description, p.slug, c.name AS category_name
      FROM products p
      LEFT JOIN category_category c ON c.id = p.category_id
      WHERE p.status::text = '1' AND p.overall_status = 'active'
      ORDER BY p.name
    `)).rows;
  } finally {
    await pool.end();
  }
  if (products.length === 0) {
    return { source: 'abiozen_products', fetched: 0, indexed: 0, index: indexName(), taskIDs: [] };
  }
  const pushed = await pushToAlgolia(products.map(productToRecord));
  return { source: 'abiozen_products', fetched: products.length, ...pushed };
}

// Algolia Recommend API — stub. ALGOLIA_RECOMMENDATION_KEY is resolved so the
// key wiring is in place; wire the actual /1/indexes/{index}/recommendations
// call when the related-products / frequently-bought-together feature ships.
async function getRecommendations(/* objectID, model */) {
  const key = getRecommendationKey();
  return {
    skipped: true,
    reason: key
      ? 'Algolia Recommend API not yet implemented (stub)'
      : 'ALGOLIA_RECOMMENDATION_KEY not set',
  };
}

module.exports = { syncPlaybookOSSkus, syncAbiozenProducts, getRecommendations };
