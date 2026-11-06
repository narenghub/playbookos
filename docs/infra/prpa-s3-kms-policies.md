# PRPA document storage — IAM, S3 and KMS policy documents

**Status: NOT APPLIED. Nothing is provisioned.** Ruling 17 keeps production provisioning on HOLD
pending the Railway region, AWS account id and bucket-name verification.

Every `<PLACEHOLDER>` below must be substituted before these are usable. They are deliberately left
as placeholders rather than filled with a plausible value, because a policy that looks complete and
names the wrong account is worse than one that visibly refuses to be applied.

| Placeholder | Where it comes from |
|---|---|
| `<ACCOUNT>` | the AWS account id — not yet supplied |
| `<REGION>` | derived from `railway status`; `us-west2` is Railway's, **not** AWS `us-west-2` |
| `<PROD_KEY_ID>` / `<DEV_KEY_ID>` | the KMS key ids, once created |

Bucket names `playnexa-prpa-documents-prod` and `-dev` are **unverified**; S3 bucket names are
globally unique and neither has been checked for availability.

---

## 0. The correction that prompted this document

The previous draft's KMS condition was:

```json
"Condition": { "StringEquals": {
  "kms:EncryptionContext:aws:s3:arn": "arn:aws:s3:::playnexa-prpa-documents-prod" } }
```

That is wrong, and not harmlessly. AWS documents
([UsingKMSEncryption.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html),
"Encryption context"):

> "If you use SSE-KMS without enabling an S3 Bucket Key, the **object ARN** is used as the
> encryption context."
>
> "If you use SSE-KMS and enable an S3 Bucket Key, the **bucket ARN** is used as the encryption
> context."

S3 Bucket Keys are deliberately **disabled** here, so the context S3 actually sends is the object
ARN — `arn:aws:s3:::playnexa-prpa-documents-prod/prpa/...`. A `StringEquals` against the bucket ARN
would have matched nothing, so KMS would have denied every `PutObject` and `GetObject`, and the
bucket would have been inert from the first request.

The corrected condition uses `StringLike` against the object ARN pattern, which also makes the
control **tighter** than intended: KMS use is now pinned to the `prpa/` prefix, not merely to the
bucket.

---

## 1. KMS key policy — production key

```json
{
  "Version": "2012-10-17",
  "Id": "prpa-documents-prod",
  "Statement": [
    {
      "Sid": "KeyAdministrationStaysWithTheAccount",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<ACCOUNT>:root" },
      "Action": [
        "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*",
        "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*",
        "kms:TagResource", "kms:UntagResource",
        "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"
      ],
      "Resource": "*"
    },

    {
      "Sid": "ApplicationMayUseTheKeyOnlyViaS3AndOnlyForPrpaObjects",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<ACCOUNT>:user/prpa-documents-prod" },
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"],
      "Resource": "*",
      "Condition": {
        "StringEquals": { "kms:ViaService": "s3.<REGION>.amazonaws.com" },
        "StringLike": {
          "kms:EncryptionContext:aws:s3:arn":
            "arn:aws:s3:::playnexa-prpa-documents-prod/prpa/*"
        }
      }
    },

    {
      "Sid": "MalwareScannerMayDecryptForScanning",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<ACCOUNT>:role/prpa-malware-scan-prod" },
      "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "*",
      "Condition": {
        "StringEquals": { "kms:ViaService": "s3.<REGION>.amazonaws.com" }
      }
    },

    {
      "Sid": "NeitherIdentityMayEverDestroyOrRepolicyTheKey",
      "Effect": "Deny",
      "Principal": { "AWS": [
        "arn:aws:iam::<ACCOUNT>:user/prpa-documents-prod",
        "arn:aws:iam::<ACCOUNT>:role/prpa-malware-scan-prod"
      ] },
      "Action": [
        "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:PutKeyPolicy",
        "kms:CreateGrant", "kms:RetireGrant", "kms:ReplicateKey"
      ],
      "Resource": "*"
    }
  ]
}
```

Three notes.

**`kms:ViaService` without an encryption-context condition on the scanner statement is deliberate.**
AWS's documented scanner policy uses `kms:ViaService` alone, and GuardDuty also writes a validation
object (§4) which sits outside the `prpa/` prefix and would therefore carry a different encryption
context. Pinning the scanner to `prpa/*` would break that validation write. The scanner is still
confined to this key, through S3, in this region.

**`kms:CreateGrant` is denied to both identities.** AWS documents no grant requirement for Malware
Protection for S3 — the mechanism is an identity policy on the assumed role — so denying grants
costs nothing and closes a privilege-escalation route. If a future AWS change requires a grant, this
`Deny` will surface it as a clear failure rather than silently permitting one.

**This key policy statement for the scanner is the one unverified element.** AWS's IAM prerequisite
page documents only the *role* side of the permissions; it does not state whether the CMK's key
policy must additionally allow the role. Same-account KMS normally requires it, which is why it is
included — but it is included on reasoning, not on a quoted sentence, and it must be confirmed by
test before this design is called proven. See §7.

The development key policy is the same document with `-prod` → `-dev` throughout.

---

## 2. S3 bucket settings — production

| Setting | Value |
|---|---|
| Block Public Access | all four, bucket **and** account level |
| Object Ownership | Bucket owner enforced (ACLs disabled) |
| Versioning | Enabled, plus a noncurrent-version lifecycle rule (90 days) |
| Default encryption | SSE-KMS, `alias/prpa-documents-prod` |
| **S3 Bucket Keys** | **Disabled** — see §6 |
| EventBridge notifications | Enabled (GuardDuty's managed rule depends on them) |

With ACLs disabled, a `PUT` carrying any canned ACL fails with `400 AccessControlListNotSupported`.
The upload path must set no ACL at all.

---

## 3. S3 bucket policy — production

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyEveryPrincipalExceptTheTwoThatBelongHere",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::playnexa-prpa-documents-prod",
        "arn:aws:s3:::playnexa-prpa-documents-prod/*"
      ],
      "Condition": {
        "StringNotLike": {
          "aws:PrincipalArn": [
            "arn:aws:iam::<ACCOUNT>:user/prpa-documents-prod",
            "arn:aws:iam::<ACCOUNT>:role/prpa-malware-scan-prod",
            "arn:aws:iam::<ACCOUNT>:root"
          ]
        }
      }
    },
    {
      "Sid": "DenyUnencryptedOrWrongKeyUploads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::playnexa-prpa-documents-prod/*",
      "Condition": {
        "StringNotEquals": {
          "s3:x-amz-server-side-encryption-aws-kms-key-id":
            "arn:aws:kms:<REGION>:<ACCOUNT>:key/<PROD_KEY_ID>"
        }
      }
    },
    {
      "Sid": "DenyNonTls",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::playnexa-prpa-documents-prod",
        "arn:aws:s3:::playnexa-prpa-documents-prod/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

This is the second of the three enforcements of ruling 16 item 3: even a mistakenly over-granted
development identity is refused at the bucket, not merely by its own policy.

**`aws:PrincipalArn` is used rather than a `NotPrincipal` block** because `NotPrincipal` with
`Deny` is notoriously easy to get wrong and evaluates in ways few readers predict. A `Deny` with
`StringNotLike` on the principal ARN says the same thing and reads the way it behaves.

**The `DenyNonTls` statement exists because Railway is not on AWS.** The service reaches S3 over the
public internet (§5), so transport security is not implied by network position the way it would be
from inside a VPC.

---

## 4. The malware-scanning role

Ruling 17 item 3. Permissions taken verbatim from
[malware-protection-s3-iam-policy-prerequisite.html](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-iam-policy-prerequisite.html).
It is a **customer-managed role**, not a service-linked role.

### Trust policy

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "malware-protection-plan.guardduty.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
```

### Permissions policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "AllowMalwareScan",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion"],
      "Resource": "arn:aws:s3:::playnexa-prpa-documents-prod/*" },

    { "Sid": "AllowPostScanTag",
      "Effect": "Allow",
      "Action": ["s3:PutObjectTagging", "s3:GetObjectTagging",
                 "s3:PutObjectVersionTagging", "s3:GetObjectVersionTagging"],
      "Resource": "arn:aws:s3:::playnexa-prpa-documents-prod/*" },

    { "Sid": "AllowCheckBucketOwnership",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::playnexa-prpa-documents-prod" },

    { "Sid": "AllowPutValidationObject",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::playnexa-prpa-documents-prod/malware-protection-resource-validation-object" },

    { "Sid": "AllowEnableS3EventBridgeEvents",
      "Effect": "Allow",
      "Action": ["s3:PutBucketNotification", "s3:GetBucketNotification"],
      "Resource": "arn:aws:s3:::playnexa-prpa-documents-prod" },

    { "Sid": "AllowManagedRuleToSendS3EventsToGuardDuty",
      "Effect": "Allow",
      "Action": ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"],
      "Resource": "arn:aws:events:<REGION>:<ACCOUNT>:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*",
      "Condition": { "StringLike": { "events:ManagedBy": "malware-protection-plan.guardduty.amazonaws.com" } } },

    { "Sid": "AllowManagedRuleRead",
      "Effect": "Allow",
      "Action": ["events:DescribeRule", "events:ListTargetsByRule"],
      "Resource": "arn:aws:events:<REGION>:<ACCOUNT>:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*" },

    { "Sid": "AllowDecryptForMalwareScan",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:<REGION>:<ACCOUNT>:key/<PROD_KEY_ID>",
      "Condition": { "StringLike": { "kms:ViaService": "s3.<REGION>.amazonaws.com" } } },

    { "Sid": "NeverDeleteAndNeverReconfigure",
      "Effect": "Deny",
      "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutBucketPolicy",
                 "s3:PutBucketAcl", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration",
                 "s3:PutBucketPublicAccessBlock", "s3:DeleteBucket",
                 "kms:ScheduleKeyDeletion", "kms:PutKeyPolicy", "kms:CreateGrant"],
      "Resource": "*" }
  ]
}
```

### Four things about this policy worth knowing before applying it

**Two actions are not read-only, and ruling 17 item 3 asks for no administrative privileges.** I am
flagging rather than silently granting them:

- `s3:PutBucketNotification` is a bucket-configuration action. AWS requires it so the plan can
  install its EventBridge trigger. It is scoped to this one bucket and cannot touch policy,
  encryption or public-access settings. It can plausibly be removed after setup, but AWS does not
  document whether the plan re-asserts the notification configuration, so removing it may silently
  break scanning later. **Recommendation: grant it, and do not remove it without a test that
  proves scanning still fires.**
- `s3:PutObject` on one literal key, `malware-protection-resource-validation-object`.

**That validation object lands in the bucket ROOT, not under `prpa/`.** A bucket policy or key
condition scoped only to `prpa/*` would break GuardDuty's setup validation, and the failure would
look like a permissions bug rather than a scoping decision. This is why §1's scanner statement
carries no encryption-context condition and §3's policy is principal-scoped rather than
prefix-scoped.

**Bucket-level actions take the bare bucket ARN; object-level actions take `/*`.** AWS's own page
notes that getting this wrong is a common cause of `ACCESS_DENIED`. Both forms are present above
deliberately.

**`kms:DescribeKey` is absent** because AWS does not list it. If scanning returns `ACCESS_DENIED`
with `UNAUTHORIZED_TO_GET_OBJECT`, this is the first thing to try adding — but it is not added
pre-emptively, since an unnecessary permission granted "just in case" is how least privilege dies.

---

## 5. Application IAM policy — production identity

Unchanged from the previous draft except the KMS resource, and reproduced here so one document
holds the whole posture. Ruling 17 item 5: the application cannot delete objects or administer the
bucket or key.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ObjectsUnderThePrpaPrefixOnly",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectTagging"],
      "Resource": "arn:aws:s3:::playnexa-prpa-documents-prod/prpa/*" },

    { "Sid": "ListingScopedToThatPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::playnexa-prpa-documents-prod",
      "Condition": { "StringLike": { "s3:prefix": "prpa/*" } } },

    { "Sid": "UseTheKeyOnly",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey*", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:<REGION>:<ACCOUNT>:key/<PROD_KEY_ID>" },

    { "Sid": "NeverTheDevelopmentBucketOrItsKey",
      "Effect": "Deny",
      "Action": ["s3:*", "kms:*"],
      "Resource": ["arn:aws:s3:::playnexa-prpa-documents-dev",
                   "arn:aws:s3:::playnexa-prpa-documents-dev/*",
                   "arn:aws:kms:<REGION>:<ACCOUNT>:key/<DEV_KEY_ID>"] },

    { "Sid": "NeverDeleteAndNeverReconfigure",
      "Effect": "Deny",
      "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion", "s3:PutBucketPolicy",
                 "s3:PutBucketAcl", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration",
                 "s3:PutBucketPublicAccessBlock", "s3:DeleteBucket",
                 "s3:PutObjectTagging", "s3:DeleteObjectTagging"],
      "Resource": ["arn:aws:s3:::playnexa-prpa-documents-prod",
                   "arn:aws:s3:::playnexa-prpa-documents-prod/*"] }
  ]
}
```

`s3:PutObjectTagging` is **denied to the application**: the scan-status tag is the scanner's to
write, and an application that could write it could mark its own uploads clean.

The development identity is the mirror image: allow on `-dev`, explicit `Deny` on `-prod` and the
production key.

---

## 6. S3 Bucket Keys stay disabled

AWS documents that Bucket Keys reduce KMS request costs "by up to 99 percent", and also that
requests served by a bucket-level key

> "do not result in AWS KMS API requests or **validate access against the AWS KMS key policy**"
> — [bucket-key.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)

At the measured volume KMS requests sit at 600/month against a 20,000/month free tier, so the saving
is **$0.00**. Enabling them would surrender a policy-enforcement point — the very condition in §1
that pins KMS use to the `prpa/` prefix — to save nothing.

Revisit only if measured KMS requests approach the free tier, and treat it then as a security
decision with a cost benefit, not a cost decision with a security footnote.

---

## 7. What must be verified by test, not by reading

1. **Whether the CMK key policy must allow the scanner role** (§1). AWS documents the role side
   only. Test on a scratch key before relying on the §1 statement.
2. **Whether `kms:DescribeKey` is required by the scanner.** Not documented; omitted on purpose.
3. **Whether removing `s3:PutBucketNotification` after setup breaks scanning later.**
4. **Whether the scan-status tag is applied to a specific object version.** The role policy includes
   `s3:PutObjectVersionTagging` and the EventBridge event carries `versionId`, but no AWS page
   states which version the tag lands on. Our design does not depend on the tag — it consumes the
   EventBridge event, which does carry `versionId` — so this is a convenience, not a dependency.
   That was a deliberate choice: the documented field is relied on, the undocumented one is not.

---

## Sources

- [S3 SSE-KMS and encryption context](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html)
- [S3 Bucket Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)
- [Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)
- [Object Ownership](https://docs.aws.amazon.com/AmazonS3/latest/userguide/about-object-ownership.html)
- [Malware Protection for S3 — IAM role policy](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-iam-policy-prerequisite.html)
- [Malware Protection for S3 — supported S3 features](https://docs.aws.amazon.com/guardduty/latest/ug/supported-s3-features-malware-protection-s3.html)
- [Malware Protection for S3 — scan result monitoring](https://docs.aws.amazon.com/guardduty/latest/ug/monitoring-malware-protection-s3-scans-gdu.html)
- [Malware Protection for S3 — EventBridge](https://docs.aws.amazon.com/guardduty/latest/ug/monitor-with-eventbridge-s3-malware-protection.html)

---

## 8. Decisions recorded by ruling 18

**Credential model: option A, as a 90-day exception.** Railway holds long-lived static AWS access
keys in sealed variables. Granted 2026-11-06, **expires 2027-02-04**, reassess by **2027-01-21**.
The record is `docs/security/credential-exceptions.json`, and `scripts/check-storage-isolation.js`
— part of preflight — **fails once that date passes**. A 90-day window is only real if something
breaks on day 91.

Reassessment triggers for the AWS broker alternative, so the review is against criteria rather than
a mood: a second consumer of the document store; materially higher document volume or sensitivity;
or an external requirement forbidding static cloud credentials on a third-party platform.

**KMS: annual automatic rotation, both keys.** Approved 2026-11-06. AWS bills the first and second
rotation at $1/month each and caps there, so per key: $1 now, $2 after 2027-11-06, $3 after
2028-11-05, and $3 thereafter. Both keys reach a **$6/month steady state on 2028-11-05** — $4/month
above the unrotated figure, deliberately accepted.

**IAM access-key rotation is tracked separately**, per ruling 18 item 4: quarterly and manual,
because Railway documents no rotation mechanism. Next due 2027-02-04, the same date the exception
expires — deliberately, so the two land as one piece of work.

**Sealed variables cannot be read back.** Rotation therefore means minting a fresh key in AWS and
sealing the new value; the old one is unrecoverable by design. Plan the rotation as a replacement,
never as a copy.

## 9. Scan verdicts are ingested, not asserted (ruling 18 item 6)

`intake_documents.scan_status` is no longer a column the application may set. It may only reflect a
row in `document_scan_results`, which must name a provider, a delivery channel (`eventbridge` or
`guardduty_on_demand`; `application` and `ai` are not permissible values), a provider event id, and
the object version judged. The provider→internal mapping is fixed in the database as well as in
JavaScript, results are append-only, and a `THREATS_FOUND` result cannot be recorded as `clean`.

**This is structural separation, not privilege separation**, and the difference is recorded in
`docs/tickets/ENG-003`. The application connects to Postgres as a superuser, which bypasses `GRANT`
and RLS, so a code path that meant to lie could fabricate a result row and reflect it. The control
removes the accident and the casual path and leaves a row naming its channel behind. Real separation
needs a non-superuser application role and an ingestion role of its own, which is a production
change.
