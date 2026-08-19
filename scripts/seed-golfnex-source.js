// ── Seed the GolfNex event-ingestion credential (E0, standalone, NOT run automatically) ──
// Generates a per-product bearer secret, stores ONLY its sha256 hash in event_sources,
// and prints the plaintext secret ONCE (out-of-band delivery to GolfNex). Run manually
// AFTER scripts/migrate-events.js:
//   node scripts/seed-golfnex-source.js
//   railway ssh 'node scripts/seed-golfnex-source.js'
//
// Refuses to overwrite an existing golfnex row (rotation is a separate, deliberate action).

const crypto = require('crypto');
const { initDB, query } = require('../src/lib/db');

const PRODUCT = 'golfnex';

async function seed() {
  await initDB();

  const existing = (await query('SELECT product FROM event_sources WHERE product = $1', [PRODUCT])).rows[0];
  if (existing) {
    console.error(`✋ '${PRODUCT}' is already registered in event_sources. Refusing to overwrite.`);
    console.error('   To rotate its secret, set secret_hash_next deliberately — do not re-seed.');
    process.exit(1);
  }

  const secret = `${PRODUCT}_live_${crypto.randomBytes(24).toString('hex')}`;
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');

  await query(
    `INSERT INTO event_sources (product, secret_hash, is_active, allowed_events)
     VALUES ($1, $2, TRUE, NULL)`,
    [PRODUCT, secretHash]
  );

  console.log('✅ Registered event source:', PRODUCT);
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────────────────────┐');
  console.log('  │  GOLFNEX INGESTION SECRET — shown ONCE. Store it in GolfNex now.          │');
  console.log('  └─────────────────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log('  ' + secret);
  console.log('');
  console.log('  Usage:  Authorization: Bearer ' + secret);
  console.log('          POST /api/events/ingest');
  console.log('  Only the sha256 hash is stored server-side; this plaintext is not recoverable.');
  process.exit(0);
}

seed().catch(e => { console.error('GolfNex seed error:', e.message); process.exit(1); });
