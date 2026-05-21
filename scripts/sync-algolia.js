// scripts/sync-algolia.js — CLI: sync active PlaybookOS SKUs to the unified Algolia index.
// Usage: DATABASE_URL=... ALGOLIA_APP_ID=... ALGOLIA_API_KEY=... [ALGOLIA_INDEX_NAME=...] node scripts/sync-algolia.js
// Index defaults to 'abiozen_products' when ALGOLIA_INDEX_NAME is unset (see src/lib/algolia-sync.js).
// Thin wrapper — sync logic lives in src/lib/algolia-sync.js so the API endpoint and this CLI share one path.
if (require('fs').existsSync(require('path').join(__dirname, '..', '.env'))) {
  try { require('dotenv').config(); } catch {}
}
const { syncPlaybookOSSkus } = require('../src/lib/algolia-sync');

syncPlaybookOSSkus()
  .then(r => {
    console.log(`Fetched ${r.fetched} active SKU${r.fetched === 1 ? '' : 's'}.`);
    console.log(`Done. ${r.indexed} record${r.indexed === 1 ? '' : 's'} indexed to "${r.index}".`);
    if (r.taskIDs && r.taskIDs.length) console.log('Algolia taskIDs: ' + r.taskIDs.join(', '));
    process.exit(0);
  })
  .catch(e => { console.error('FAIL:', e.message); process.exit(1); });
