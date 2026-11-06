# Security remediation — your checklist

**Ruling 28 item 4.** Every step here is yours to perform. I have rotated nothing, and **no secret
value appears anywhere in this document, in any log, or in this session.** I have never received
one and do not need one to write this.

**This checklist gates the deployment.** Ruling 27 item 7 and ruling 28's closing paragraph both
hold it there.

---

## The order is forced, not preferred

Two facts in this codebase decide it:

1. **`src/lib/core.js` signs tokens with `expiresIn: '7d'`.** Changing a password does **not**
   invalidate tokens already minted with it. Anyone who signed in while the password was readable
   in public Git history holds a working bearer token for up to seven days. **Rotating `JWT_SECRET`
   is the only thing that revokes those.**
2. **New Railway variables need a redeploy**, which replaces the container. Anything that must
   survive the change has to be in Postgres, not on disk.

So: password first, then `JWT_SECRET`. Reversing them logs you out and leaves you signing back in
with the password you have not yet changed.

---

## Step 0 — snapshot, before touching anything

```sh
node scripts/verify-rotation.js --snapshot
echo $?
```

Writes fingerprints — **not values** — to a database row, so it survives the redeploys below. This
is what lets step 7 prove a rotation actually happened rather than assuming it.

---

## Step 1 — the admin password · **OPEN · highest priority**

| | |
|---|---|
| What | the `naren@abiozen.com` login password |
| Exposure | **public Git history** — `scripts/init-db.js` (`bc5a8e5`) and `AUTONOMY_SECURITY_REVIEW.md` (`0c6a937`) |
| Who can read it | anyone who has ever cloned, and anyone who clones now |

1. Sign in and change it to a value never used anywhere else.
2. Do **not** paste it into Railway, a file, a chat, or this session.
3. Tell me only that it is done.

**This finding stays OPEN until you confirm it.** I will not infer it from a `password_mismatch`,
from a failed login, or from anything else — a wrong password can mean a dozen things and only one
of them is "rotated".

`scripts/check-secrets.js --history` carries this as a known finding and **begins failing on
2026-11-13**. That date is a deadline, not a reminder.

---

## Step 2 — `JWT_SECRET` · **OPEN**

Immediately after step 1, and not before.

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — run it on
   your own machine, read the value from your own terminal.
2. Set it in Railway → Variables.
3. Redeploy.

**Everyone is signed out, including you.** That is the point: it is what revokes the tokens minted
under the old password.

---

## Step 3 — the GitHub PAT · **OPEN**

Exposed in the project handoff document.

1. github.com → Settings → Developer settings → Personal access tokens → **revoke the old one
   first**, then issue a replacement.
2. Store it in your password manager, not in a project document.
3. If any automation used it, update that automation.

Revoking before issuing is deliberate: a token you have replaced but not revoked is still a live
credential.

---

## Step 4 — PostgreSQL credentials · **OPEN**

Do this **together with** the ENG-003 role split (`docs/deploy/prpa-cloud-handover.md` §4) — the
same redeploy covers both, and the split is what actually reduces the blast radius.

1. Railway → Postgres → rotate the superuser password.
2. Create `playbookos_app` with a new password (statements in the handover §4).
3. Set `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (`playbookos_app`).
4. Run `node scripts/migrate.js`, read `$?`, **then** deploy.

---

## Step 5 — webhook and shared secrets · **OPEN**

`TRIGGERS_SECRET`, `PLAYBOOKOS_WEBHOOK_SECRET`, `ENGAGEMENT_SECRET` — all three appeared in the
project handoff document.

Generate each the same way as step 2, set all three, redeploy once. Anything calling those webhooks
needs the new value at the same moment, so do them together rather than one at a time.

---

## Step 6 — third-party API keys · **review, then decide**

Every one of these appeared in the handoff document. Each is a separate decision about whether it
was genuinely exposed and what rotating it costs:

| Key | Note |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `RESEND_API_KEY` | email sending |
| `ALGOLIA_API_KEY` (write key) | the search key is lower risk; the **write** key is not |
| `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | refresh token rotation re-authorises Search Console |
| `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_ACCESS_TOKEN` | the access token expires every 2 months regardless |
| `APOLLO_API_KEY` | |
| `TWILIO_AUTH_TOKEN` | |
| `OPENAI_API_KEY` | |

---

## Step 7 — prove it, and close the findings

```sh
node scripts/verify-rotation.js
echo $?

node scripts/check-secrets.js
echo $?

node scripts/check-secrets.js --history
echo $?
```

Each bare, each exit code read. `verify-rotation.js` compares against step 0's fingerprints, so it
can tell a rotation from a redeploy.

---

## Step 8 — repository visibility · **your decision**

`narenghub/playbookos` is **public**. That is why the password in history is a live exposure rather
than an internal note.

Making it private does **not** retroactively protect anything already cloned — rotation is what
does that — but it stops the next person reading it. **No history has been rewritten and no
visibility has been changed**, per ruling 19 item 3.

---

## What I have done, and what I have not

**Done:** written this; kept every finding open; built the checks that fail on them. The history
check carries the admin-password finding with its 2026-11-13 deadline.

**Not done, and not doable by me:** rotated anything, received any secret value, changed repository
visibility, rewritten history, or deployed.

**One thing to be careful about:** if you paste a secret into this conversation to "check" it, it is
then in a chat log, and the right response is to rotate it again. Don't.
