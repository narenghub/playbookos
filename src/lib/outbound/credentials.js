// PlaybookOS — Outbound credential accessor (E2 step 3, part 1)
//
// Per-product OUTBOUND secrets live in ENV for now (not a DB table): outbound needs the
// plaintext secret at call time, and plaintext-in-Postgres is a bigger, worse-guarded
// surface than Railway's env at current scale (~2 products). This thin accessor is the ONLY
// place call sites read those secrets, so graduating to an envelope-encrypted table later
// (the agreed trigger: ~5 products, or non-engineer onboarding) is a one-file change here.
//
// Env naming (per product+vendor), dual-slot to mirror event_sources.secret_hash /
// secret_hash_next rotation:
//   OUTBOUND_<PRODUCT>_<VENDOR>        primary (steady-state secret)
//   OUTBOUND_<PRODUCT>_<VENDOR>_NEXT   staged new secret during rotation
//
// Rotation (zero-downtime): (1) remote begins accepting the NEW secret; (2) stage NEW in the
// _NEXT var — the accessor PREFERS _NEXT once present, so we immediately send NEW (which the
// remote already accepts); (3) promote NEW into the primary var and clear _NEXT; (4) remote
// drops the old secret.
//
// SECURITY: callers must NEVER log the returned secret. This module never logs it, and the
// error path never includes it.

// Normalize a product/vendor to an ENV-key segment: uppercase, non-alphanumerics → '_'.
function norm(s) {
  return String(s == null ? '' : s).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// The two env var names backing a (product, vendor) credential. Exposed for ops/tests.
function envKeysFor(product, vendor) {
  const base = `OUTBOUND_${norm(product)}_${norm(vendor)}`;
  return { primaryKey: base, nextKey: base + '_NEXT' };
}

// Resolve the outbound secret to USE for (product, vendor). Prefers the _NEXT slot when
// staged (rotation cutover), else primary. Returns { secret, slot, product, vendor } or
// { error } — never throws, never puts the secret in the error.
function getOutboundCredential(product, vendor, { env = process.env } = {}) {
  if (!product || !vendor) return { error: 'product and vendor are required' };
  const { primaryKey, nextKey } = envKeysFor(product, vendor);
  const next = env[nextKey];
  const primary = env[primaryKey];
  if (next && String(next).trim()) return { secret: String(next).trim(), slot: 'next', product, vendor };
  if (primary && String(primary).trim()) return { secret: String(primary).trim(), slot: 'primary', product, vendor };
  return { error: `no outbound credential for ${product}/${vendor} (set ${primaryKey})` };
}

// Cheap presence check without surfacing the secret.
function hasOutboundCredential(product, vendor, { env = process.env } = {}) {
  return !getOutboundCredential(product, vendor, { env }).error;
}

module.exports = { getOutboundCredential, hasOutboundCredential, envKeysFor };
