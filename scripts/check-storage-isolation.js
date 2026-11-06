#!/usr/bin/env node
// ── RULING 17 ITEM 8 — ENVIRONMENT ISOLATION, PROVED BY ATTEMPTING TO CROSS IT ────────────────
//
// No AWS account, no credentials, no network. That is the point: this is the layer of the storage
// design that can be proved before any infrastructure exists, and it is the layer that fires on
// the machine where a mistake is made rather than at the far end of an API call.
//
// Every assertion attempts what the module forbids and requires a refusal, plus positive controls
// so a wall cannot pass for a gate.
'use strict';

const S = require('../src/lib/office/document-storage-config');

let pass = 0; let fail = 0;
const ok = (m) => { pass++; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail++; console.log(`  FAIL  ${m}`); if (d) console.log(`          ${d}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

// Returns the error message if the call threw, or null if it was accepted.
const refused = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const PROD = {
  NODE_ENV: 'production',
  PRPA_S3_BUCKET: 'playnexa-prpa-documents-prod',
  PRPA_S3_REGION: 'us-east-1',
  PRPA_KMS_KEY_ID: 'arn:aws:kms:us-east-1:111122223333:key/abc',
};
const DEV = { ...PROD, NODE_ENV: 'development', PRPA_S3_BUCKET: 'playnexa-prpa-documents-dev' };

h('1. THE TWO CORRECT COMBINATIONS RESOLVE — the control is a gate, not a wall');
for (const [name, env, expectProd] of [['production→-prod', PROD, true], ['development→-dev', DEV, false]]) {
  const e = refused(() => S.resolveStorageConfig(env));
  if (e) { bad(`${name} was refused`, e); continue; }
  const c = S.resolveStorageConfig(env);
  if (c.isProduction === expectProd && c.bucket === env.PRPA_S3_BUCKET) ok(`${name} resolves`);
  else bad(`${name} resolved wrongly`, JSON.stringify(c));
}
{
  const c = S.resolveStorageConfig(PROD);
  if (c.bucketKeyEnabled === false) ok('S3 Bucket Keys are OFF — no KMS key-policy validation is skipped');
  else bad('S3 Bucket Keys were enabled');
  if (c.downloadTtlSeconds === 300) ok('the download TTL is 300s, not the 7-day ceiling AWS permits');
  else bad('unexpected download TTL', String(c.downloadTtlSeconds));
}

h('2. CROSSING ENVIRONMENTS IS REFUSED IN BOTH DIRECTIONS');
// The one that matters: a production credential and bucket in a non-production process. This is
// what happens when somebody pastes a Railway variable into a local shell to "just check
// something", and it is the case ruling 16 item 3 forbids by name.
for (const ne of ['development', 'test', '', undefined]) {
  const e = refused(() => S.resolveStorageConfig({ ...PROD, NODE_ENV: ne }));
  if (e && /IS production storage/.test(e)) ok(`NODE_ENV=${JSON.stringify(ne)} + production bucket → REFUSED`);
  else bad(`NODE_ENV=${JSON.stringify(ne)} was allowed to use production storage`, e || 'accepted');
}
{
  const e = refused(() => S.resolveStorageConfig({ ...DEV, NODE_ENV: 'production' }));
  if (e && /not a production bucket/.test(e)) ok('production + a development bucket → REFUSED');
  else bad('production was allowed to write into development storage', e || 'accepted');
}
// A config that CLAIMS to be development while pointing at production storage is the lie the
// suffix check exists to catch. There is no flag that overrides the bucket name.
{
  const e = refused(() => S.resolveStorageConfig({
    ...PROD, NODE_ENV: 'development', PRPA_ENVIRONMENT: 'development', PRPA_ALLOW_PROD: 'true',
  }));
  if (e && /IS production storage/.test(e)) ok('no flag overrides the bucket suffix');
  else bad('a flag overrode the environment check', e || 'accepted');
}

h('3. MISSING CONFIGURATION IS AN ERROR, NEVER A DEFAULT');
for (const [k, re] of [['PRPA_S3_BUCKET', /PRPA_S3_BUCKET is not set/],
  ['PRPA_S3_REGION', /is not set/], ['PRPA_KMS_KEY_ID', /refusing to write unencrypted or SSE-S3/]]) {
  const env = { ...DEV }; delete env[k]; if (k === 'PRPA_S3_REGION') delete env.AWS_REGION;
  const e = refused(() => S.resolveStorageConfig(env));
  if (e && re.test(e)) ok(`${k} absent → REFUSED (no silent fallback)`);
  else bad(`${k} absent was tolerated`, e || 'accepted');
}

h('4. OBJECT KEYS ARE SERVER-GENERATED AND CANNOT BE STEERED BY A SUBMITTER');
const CO = 'co-bbb13600-5966-4bb4-a569-2df76c5abba8';
const SHA = 'a'.repeat(64);
{
  const k = S.objectKeyFor({ companyId: CO, sha256: SHA, submittedAt: new Date('2026-11-06T12:00:00Z'), extension: 'pdf' });
  if (k === `prpa/${CO}/2026/11/${SHA}.pdf`) ok('a key is prefix/company/year/month/sha256.ext');
  else bad('unexpected key shape', k);
  // The uploader's filename appears nowhere in it. That is the property, not a side effect.
  if (!k.includes('invoice') && !k.includes(' ')) ok('no part of the key comes from the uploader');
}
for (const [what, args] of [
  ['a traversal in the extension', { companyId: CO, sha256: SHA, extension: '../../etc/passwd' }],
  ['a short hash', { companyId: CO, sha256: 'abc', extension: 'pdf' }],
  ['an upper-case hash', { companyId: CO, sha256: 'A'.repeat(64), extension: 'pdf' }],
  ['an implausible company id', { companyId: '../other', sha256: SHA, extension: 'pdf' }],
  ['an empty company id', { companyId: '', sha256: SHA, extension: 'pdf' }],
  ['an invalid date', { companyId: CO, sha256: SHA, extension: 'pdf', submittedAt: 'not-a-date' }],
]) {
  const e = refused(() => S.objectKeyFor(args));
  if (e) ok(`${what} → REFUSED`);
  else bad(`${what} produced a key`, 'accepted');
}

h('5. KEYS OUTSIDE THE PRPA PREFIX ARE REFUSED');
if (!refused(() => S.assertKeyInScope(`prpa/${CO}/2026/11/${SHA}.pdf`))) ok('an in-scope key is accepted');
else bad('an in-scope key was refused');
for (const k of ['other/thing.pdf', '/prpa/x.pdf', 'prpa/../etc/passwd', 'prpa//double.pdf', '']) {
  const e = refused(() => S.assertKeyInScope(k));
  if (e) ok(`out-of-scope key ${JSON.stringify(k)} → REFUSED`);
  else bad(`out-of-scope key ${JSON.stringify(k)} accepted`);
}

h('6. DOWNLOAD URLS STAY SHORT-LIVED');
if (S.assertDownloadTtl(300) === 300) ok('300s is accepted');
else bad('300s was refused');
if (S.assertDownloadTtl(900) === 900) ok('900s — the ceiling — is accepted');
else bad('the ceiling was refused');
for (const t of [901, 3600, 604800, 0, -1, 1.5, 'five', null]) {
  const e = refused(() => S.assertDownloadTtl(t));
  if (e) ok(`a TTL of ${JSON.stringify(t)} → REFUSED`);
  else bad(`a TTL of ${JSON.stringify(t)} was accepted`);
}
// AWS permits 7 days with long-lived signing credentials. That ceiling is AWS's, not ours, and the
// gap between the two is the whole reason this function exists.
{
  const e = refused(() => S.assertDownloadTtl(7 * 24 * 3600));
  if (e && /ceiling/.test(e)) ok("AWS's 7-day maximum is refused here — their ceiling is not our policy");
  else bad('a 7-day URL was permitted', e || 'accepted');
}

console.log(`\n${'─'.repeat(78)}`);
console.log(`  ${pass} assertion(s) passed · ${fail} failed`);
if (fail) {
  console.log('\nFAIL  environment isolation is not enforced as claimed.');
  process.exit(1);
}
console.log('\nPASS  development cannot reach production storage, keys cannot be steered, and no');
console.log('      download URL outlives its grant. None of this needed an AWS account.');
