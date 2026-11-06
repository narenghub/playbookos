#!/usr/bin/env node
// ── AWS INTEGRATION TESTS — PREPARED, AND REFUSING TO PRETEND ────────────────
//
//   node scripts/aws-integration-tests.js --plan        → print the plan, exit 0. No AWS needed.
//   node scripts/aws-integration-tests.js --run         → execute. Requires credentials.
//
// Ruling 19 item 8. Six areas: KMS context, scanner permissions, EICAR detection,
// version-specific quarantine, unauthorized downloads, environment isolation.
//
// --run exits 3 (EXIT_NOT_EXECUTED) without credentials, because a check that did not run must
// never report a pass. That is the rule the whole repo turns on, and it matters more here than
// anywhere: these are the tests that would be cited as evidence the storage design works.
//
// Every test acts on FIXTURES IT CREATES — a fixture bucket, a fixture key, a fixture document —
// and cleans up by recorded id, per CLAUDE.md. None of them touches the production bucket, and
// there is no code path here that could: the bucket name is generated per run.
'use strict';

const EXIT_NOT_EXECUTED = 3;
const PLAN = process.argv.includes('--plan');
const RUN = process.argv.includes('--run');

const TESTS = [
  {
    id: 'T1', area: 'KMS encryption context',
    asserts: 'A PutObject under the prpa/ prefix SUCCEEDS, and a PutObject outside it is DENIED by KMS.',
    why: 'This is the test that would have caught the bug ruling 17 item 2 found by reading: the '
       + 'draft policy conditioned on the BUCKET arn while S3 (Bucket Keys off) sends the OBJECT '
       + 'arn, so every write would have been denied. A green T1 proves the condition matches '
       + 'reality rather than matching the documentation I read.',
    method: [
      'Create a fixture CMK and a fixture bucket, Bucket Keys explicitly DISABLED.',
      'Apply the key policy from docs/infra/prpa-s3-kms-policies.md with the fixture ARNs.',
      'PutObject at prpa/<fixture>/x.pdf → expect 200.',
      'PutObject at outside/x.pdf → expect AccessDenied FROM KMS, not from S3.',
      'Assert the denial message names KMS: an S3-level denial would mean the prefix is being '
        + 'enforced by the IAM policy and the KMS condition is untested.',
    ],
  },
  {
    id: 'T2', area: 'scanner permissions',
    asserts: 'The malware-scan role can GetObject and decrypt; it cannot delete, re-policy, or read another prefix.',
    why: 'The one element of the key policy that rests on inference rather than a quoted AWS '
       + 'sentence is whether the CMK key policy must ALSO name the scanner role. AWS documents '
       + 'only the role side. T2 settles it by removing the key-policy statement and observing '
       + 'whether scanning still works.',
    method: [
      'Assume the scanner role; GetObject the fixture → expect success.',
      'DeleteObject → expect AccessDenied.',
      'PutBucketPolicy → expect AccessDenied.',
      'kms:ScheduleKeyDeletion → expect AccessDenied.',
      'THE DECIDING STEP: remove the MalwareScannerMayDecryptForScanning statement from the key '
        + 'policy, upload a new object, and observe whether the scan returns ACCESS_DENIED with '
        + 'statusReason UNAUTHORIZED_TO_GET_OBJECT. Record the answer in the policy doc §7.',
    ],
  },
  {
    id: 'T3', area: 'EICAR detection',
    asserts: 'An EICAR test file produces THREATS_FOUND on the default EventBridge bus, carrying versionId.',
    why: 'The quarantine design consumes detail.s3ObjectDetails.versionId. That field is '
       + "documented, but documented is not observed, and the whole version-specific design "
       + 'collapses if the real event omits it.',
    method: [
      'Upload the EICAR test string as a fixture object.',
      'Wait for the scan result on the default event bus (no documented latency SLA — poll with a '
        + 'generous ceiling and FAIL on timeout rather than assuming it passed).',
      'Assert detail-type is "GuardDuty Malware Protection Object Scan Result".',
      'Assert scanResultStatus is THREATS_FOUND.',
      'Assert detail.s3ObjectDetails.versionId is PRESENT and equals the uploaded version.',
      'Assert the object tag GuardDutyMalwareScanStatus is set, and record WHICH version it '
        + 'landed on — AWS does not document this, and our design deliberately does not depend on it.',
      'Also upload a clean PDF and assert NO_THREATS_FOUND, so T3 proves detection and not merely '
        + 'that something was returned.',
    ],
  },
  {
    id: 'T4', area: 'version-specific quarantine',
    asserts: 'A second version of a clean object is not servable until its own verdict arrives.',
    why: 'The database already refuses to let a stale clean verdict coexist with a newer version. '
       + 'T4 checks the other half: that a real re-upload produces a real second scan, so the '
       + 'database constraint is being satisfied by evidence rather than by the worker '
       + 'conveniently copying the previous verdict forward.',
    method: [
      'Upload a clean object; ingest its verdict; confirm servable = true.',
      'Upload a NEW version of the same key.',
      'Confirm the document row goes back to pending and servable = false.',
      'Confirm a SECOND scan result arrives with the NEW versionId and a different provider_event_id.',
      'Confirm the document becomes servable only after that second result is ingested.',
    ],
  },
  {
    id: 'T5', area: 'unauthorized downloads',
    asserts: 'No presigned URL is obtainable for a quarantined document, and no object URL is public.',
    method: [
      'Attempt a download grant for a pending, infected, unsupported, failed and access_denied '
        + 'document → each refused by the database.',
      'Fetch the object URL anonymously → expect 403 (Block Public Access).',
      'Fetch it with the DEVELOPMENT identity → expect AccessDenied from the bucket policy, not '
        + 'merely from the dev IAM policy, so both layers are proven.',
      'Request a presigned URL with a 7-day expiry → refused locally by assertDownloadTtl before '
        + 'any AWS call, since AWS would have permitted it.',
      'Let a 300-second presigned URL expire, then use it → expect 403.',
    ],
  },
  {
    id: 'T6', area: 'environment isolation',
    asserts: 'The development identity cannot write to the production bucket, enforced three ways.',
    why: 'Ruling 16 item 3. Layer 3 is already tested locally with no AWS. T6 proves layers 1 and 2.',
    method: [
      'Development identity PutObject into the production bucket → AccessDenied (its own IAM Deny).',
      'Remove that Deny from the dev policy and retry → still AccessDenied, this time from the '
        + 'BUCKET policy. This is the step that proves the layers are independent rather than one '
        + 'control written twice.',
      'Restore the Deny.',
      'Confirm the production identity cannot write to the development bucket either.',
    ],
  },
];

if (PLAN || (!RUN && !PLAN)) {
  console.log('AWS integration tests — PREPARED, NOT RUN (ruling 19 item 8)\n');
  for (const t of TESTS) {
    console.log(`${t.id}  ${t.area}`);
    console.log(`    asserts: ${t.asserts}`);
    if (t.why) console.log(`    why:     ${t.why}`);
    for (const m of t.method) console.log(`      · ${m}`);
    console.log('');
  }
  console.log('Fixtures only. Every bucket, key and object is created by the run and removed by');
  console.log('recorded id. The production bucket name never appears in this file.');
  console.log('\nPrerequisites, none of which are met: the AWS account id, the deployment region,');
  console.log('bucket-name availability, and provisioned fixtures. Ruling 19 item 9 keeps');
  console.log('provisioning closed, so --run cannot succeed yet and says so rather than skipping.');
  process.exit(0);
}

// --run
const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'PRPA_S3_REGION', 'PRPA_TEST_BUCKET']
  .filter((k) => !process.env[k]);
console.log('AWS integration tests — attempting to run\n');
if (missing.length) {
  console.log(`  NOT EXECUTED: missing ${missing.join(', ')}`);
  console.log('\n  Exiting 3. A check that did not run must not report a pass, and these are');
  console.log('  precisely the tests somebody would cite as evidence the storage design works.');
  process.exit(EXIT_NOT_EXECUTED);
}
console.log('  NOT EXECUTED: no AWS resources are provisioned (ruling 19 item 9).');
console.log('  Credentials are present but the fixtures are not, and inventing them would be');
console.log('  provisioning without authorization.');
process.exit(EXIT_NOT_EXECUTED);
