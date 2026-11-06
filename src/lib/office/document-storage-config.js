// ── PRPA DOCUMENT STORAGE — CONFIGURATION, AND THE REFUSAL TO CROSS ENVIRONMENTS ──────────────
//
// Ruling 16 item 3: a separate development bucket and credentials, and "never allow development
// tests to write to production storage." Ruling 17 items 1 and 8 keep that and ask for the
// isolation to be tested locally.
//
// Three layers enforce it. Two of them live in AWS and are not ours to apply:
//
//   1. the development IAM policy explicitly DENIES s3:* on the production bucket
//   2. the production bucket policy DENIES every principal except the production identity
//   3. this module — which refuses at startup when the environment and the bucket disagree
//
// Layer 3 is the only one that fires on the machine where the mistake is made, before any call
// leaves it, and the only one that catches a production key pasted into a local shell. Layers 1
// and 2 refuse the request; this refuses to make it.
//
// It is deliberately a pure function of its inputs: no AWS SDK, no network, no credentials read.
// That is what makes it testable with no account, which is why it exists before the bucket does.
'use strict';

// The object-key prefix every PRPA object lives under. The IAM policies are scoped to it, so a key
// outside it would be refused by AWS anyway — but being refused here names the real reason.
const PREFIX = 'prpa/';

// Ruling 16 item 5 and ruling 17: downloads are short-lived. 5 minutes is what we ask for; 15 is
// the outer bound the database's grant constraint also enforces, so the two cannot drift apart
// without a test failing.
const DOWNLOAD_TTL_SECONDS = 300;
const DOWNLOAD_TTL_MAX_SECONDS = 900;

class StorageConfigError extends Error {
  constructor(msg) { super(msg); this.name = 'StorageConfigError'; }
}

// A bucket name ending in -prod is production storage, whatever anything else claims. The suffix is
// the single source of that judgement: a config flag saying "this is dev" while pointing at a -prod
// bucket is exactly the lie this function exists to refuse.
const isProductionBucket = (b) => typeof b === 'string' && /-prod$/.test(b.trim());

/**
 * Resolve and validate document-storage configuration. Throws rather than returning a degraded
 * config: there is no safe partial answer to "which bucket do I write to".
 *
 * @param {object} env  process.env, or a fixture
 */
function resolveStorageConfig(env) {
  const e = env || {};
  const bucket = (e.PRPA_S3_BUCKET || '').trim();
  const region = (e.PRPA_S3_REGION || e.AWS_REGION || '').trim();
  const kmsKeyId = (e.PRPA_KMS_KEY_ID || '').trim();
  const nodeEnv = (e.NODE_ENV || '').trim();

  if (!bucket) throw new StorageConfigError('PRPA_S3_BUCKET is not set; document storage cannot start');
  if (!region) throw new StorageConfigError('PRPA_S3_REGION (or AWS_REGION) is not set; document storage cannot start');
  if (!kmsKeyId) {
    // Encryption is not optional and not a default to fall back on. SSE-S3 would still be
    // encryption, which is why the absence of a CMK has to be an error rather than a downgrade.
    throw new StorageConfigError('PRPA_KMS_KEY_ID is not set; refusing to write unencrypted or SSE-S3 objects');
  }

  const bucketIsProd = isProductionBucket(bucket);
  const envIsProd = nodeEnv === 'production';

  if (envIsProd && !bucketIsProd) {
    throw new StorageConfigError(
      `NODE_ENV=production but PRPA_S3_BUCKET="${bucket}" is not a production bucket. `
      + 'Production must not write documents into development storage: the audit trail would be '
      + 'in a bucket with development retention and development access.');
  }
  if (!envIsProd && bucketIsProd) {
    throw new StorageConfigError(
      `NODE_ENV="${nodeEnv || '(unset)'}" but PRPA_S3_BUCKET="${bucket}" IS production storage. `
      + 'Refusing. This is the case where a production credential has been pasted into a local '
      + 'shell, and no test is worth a write into the production document store.');
  }

  return Object.freeze({
    bucket,
    region,
    kmsKeyId,
    prefix: PREFIX,
    isProduction: bucketIsProd,
    downloadTtlSeconds: DOWNLOAD_TTL_SECONDS,
    // S3 Bucket Keys stay OFF: at our volume they save $0.00 of KMS requests, and AWS documents
    // that requests served by a bucket-level key "do not validate access against the AWS KMS key
    // policy". Recorded here because a future reader will be tempted to enable them for cost.
    bucketKeyEnabled: false,
  });
}

/**
 * Server-generated object key. Ruling 16 item 5: no part of the name comes from the uploader.
 * The content hash IS the name, so the integrity check and the duplicate check are one operation.
 */
function objectKeyFor({ companyId, sha256, submittedAt, extension }) {
  if (!/^co-[0-9a-f-]{8,}$/.test(String(companyId || ''))) {
    throw new StorageConfigError(`refusing to build a key for an implausible company id: ${JSON.stringify(companyId)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) {
    throw new StorageConfigError('refusing to build a key without a full sha256 of the content');
  }
  const ext = String(extension || '').replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) {
    throw new StorageConfigError(`refusing an implausible extension: ${JSON.stringify(extension)}`);
  }
  const at = submittedAt instanceof Date ? submittedAt : new Date(submittedAt || Date.now());
  if (Number.isNaN(at.getTime())) throw new StorageConfigError('refusing to build a key with an invalid date');
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${PREFIX}${companyId}/${yyyy}/${mm}/${sha256}.${ext}`;
}

/** Every object key must be under the PRPA prefix and must not try to escape it. */
function assertKeyInScope(key) {
  const k = String(key || '');
  if (!k.startsWith(PREFIX)) throw new StorageConfigError(`object key "${k}" is outside ${PREFIX}`);
  if (k.includes('..') || k.includes('//')) throw new StorageConfigError(`object key "${k}" tries to traverse`);
  return k;
}

/** A download TTL we are willing to sign. Long-lived URLs are the thing being prevented. */
function assertDownloadTtl(seconds) {
  const n = Number(seconds);
  if (!Number.isInteger(n) || n <= 0) throw new StorageConfigError(`a download TTL must be a positive integer, got ${JSON.stringify(seconds)}`);
  if (n > DOWNLOAD_TTL_MAX_SECONDS) {
    throw new StorageConfigError(
      `a download TTL of ${n}s exceeds the ${DOWNLOAD_TTL_MAX_SECONDS}s ceiling. The database's `
      + 'download-grant constraint enforces the same bound, so raising one without the other '
      + 'would only move the refusal.');
  }
  return n;
}

module.exports = {
  PREFIX,
  DOWNLOAD_TTL_SECONDS,
  DOWNLOAD_TTL_MAX_SECONDS,
  StorageConfigError,
  isProductionBucket,
  resolveStorageConfig,
  objectKeyFor,
  assertKeyInScope,
  assertDownloadTtl,
};
