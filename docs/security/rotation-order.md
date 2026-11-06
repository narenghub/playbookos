# Credential rotation — dependency order

**Ruling 19 item 4.** Nothing here is executed automatically. Every step is yours; this document
says what order they must happen in and why, and what proves each one.

The order is not a preference. It is forced by two facts in this codebase:

1. **`src/lib/core.js` signs tokens with `expiresIn: '7d'`.** Changing the admin password does
   **not** invalidate a token already minted with it. Anyone who logged in while the password was
   readable in public git history holds a valid bearer token for up to seven days afterwards.
   Rotating `JWT_SECRET` is the only thing that revokes those — so it must come **after** the
   password change, or you will log yourself out and then have to log back in with a password you
   have not yet changed.
2. **New Railway variable values require a redeploy**, which replaces the container. Anything that
   has to survive the change must be in Postgres, not on disk — which is why
   `scripts/verify-rotation.js --snapshot` writes its fingerprints to a database row.

---

## Step 0 — before anything: snapshot

```sh
railway ssh 'node scripts/verify-rotation.js --snapshot'
```

Records a salted fingerprint of each credential **as the running process currently holds it**, in a
Postgres row. It never takes a secret as input and never prints anything derived from one. Without
this, "did it rotate?" is unanswerable afterwards.

---

## Step 1 — GitHub personal access token

**First, because it has no dependencies and it is the credential that can write to the repository.**

1. github.com/settings/tokens → **revoke** the exposed token.
2. `gh auth login` locally, or create a new fine-grained token and keep it in your password manager.
3. Fix the remote so a token is never in a URL again:
   ```sh
   cd ~/Downloads/playbookos
   git remote set-url origin https://github.com/narenghub/playbookos.git
   git remote -v        # confirm no credential in the URL
   ```

**Verified at GitHub, not here.** `verify-rotation.js` deliberately does not list this credential:
it is not an environment variable of the application, so the script cannot fingerprint it and must
not pretend to. A token replaced locally and left active at GitHub is still live in whatever
document carried it.

**Breaks if skipped:** nothing immediately. That is what makes it easy to forget.

---

## Step 2 — production admin password

**Second, because step 4 locks you out until this is done.**

Change it through the application's own password-change path, with the password typed, never pasted
into a document or a chat. Then confirm you can log in with the new one.

**This is the only step that closes ruling 19 item 1.** Tell me once it is done and I will set the
history finding to `retired` and add a watch hash of the old value so it can never reappear. Until
you confirm, the finding stays open — a `password_mismatch` error is not evidence of remediation,
and I should not have offered it as any.

**Breaks if skipped:** everything else is cosmetic. The password is public.

---

## Step 3 — confirm the application is healthy on the current credentials

```sh
curl -s https://app.playnexa.ai/health
```

A checkpoint, not a formality: steps 4–6 change several things in one redeploy, and you want to
know the baseline was good before you do. If `/health` is unhappy now, fix that first — otherwise
you will be debugging two problems as one.

---

## Step 4 — one batched Railway change, then one redeploy

All of these need a redeploy to take effect, so batch them into a single variable edit and a single
restart rather than four restarts. Set each as a **sealed** variable.

| Variable | New value | Note |
|---|---|---|
| `DATABASE_URL` | rotate the Postgres password in Railway, take the new DSN | the app is briefly down during the restart |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | **logs every user out, including you** — intended; this is what revokes the 7-day tokens |
| `TRIGGERS_SECRET` | fresh random | safe to rotate alone (see below) |
| `PLAYBOOKOS_WEBHOOK_SECRET` | fresh random | **check callers first** (see below) |
| `ENGAGEMENT_SECRET` | fresh random | **check callers first** (see below) |

### Which of the three webhook secrets is safe to rotate blind

I read the code rather than assuming, and they are not alike:

- **`TRIGGERS_SECRET`** — both sides are inside this process. `server.js` reads it for the cron
  self-call and `src/api/routes.js` verifies it on `POST /api/triggers/check`. A redeploy updates
  caller and verifier simultaneously. **Safe to rotate alone.**
- **`ENGAGEMENT_SECRET`** — verified as the `X-Engagement-Secret` header on
  `POST /api/customers/engagement-event`. The caller is **external** — most likely the Abiozen
  marketplace. Rotating this **breaks that caller** until it is updated with the new value.
  **Identify and update the sender in the same window.**
- **`PLAYBOOKOS_WEBHOOK_SECRET`** — verified on two routes in `src/api/routes.js` (around lines
  1054 and 2290). Same risk: whatever posts to those routes must be updated too.

If you cannot identify the external senders right now, rotate `TRIGGERS_SECRET` and `JWT_SECRET` and
`DATABASE_URL` in this round, and hold the other two for a window where you can update both ends.
Rotating a shared secret on one side only converts a credential problem into an outage.

### Then redeploy

Railway → playbookos → Deployments → Redeploy. A variable change usually triggers this; confirm it
actually happened by checking the commit in `/health`.

---

## Step 5 — prove it rotated

```sh
railway ssh 'node scripts/verify-rotation.js --compare'
echo $?
```

Exit 0 means every credential marked for rotation now holds a different value than the snapshot. It
prints `CHANGED` or `unchanged` per name and nothing derived from any secret.

**What this proves:** the process now holds different values.
**What it does not prove:** that the old values were revoked at their providers. That is checked at
the source — which is why step 1 is verified at GitHub.

---

## Step 6 — post-rotation health

```sh
railway ssh 'node scripts/verify-rotation.js --health'
echo $?
```

This refuses to print health as post-rotation health while a snapshot is outstanding. On its first
live run it reported "all healthy after rotation" while all five credentials were still the leaked
values — nothing was false about the connectivity checks, but every word implying rotation had
happened was. The gate exists because that output is the kind somebody screenshots.

Then log in again with the new password, and confirm the agents still run on their next cycle.

---

## Step 7 — tell me

So I can set the history finding to `retired`, add the watch hash, and update
`docs/security/credential-exceptions.json` with the completed IAM-key rotation date.

---

## Separate track, not part of this round

- **`ABIOZEN_DATABASE_URL`** — the Abiozen Django production database. Same exposure, different
  system, and rotating it affects whatever else uses that database. Its own window.
- **AWS access keys for PRPA document storage** — do not exist yet. Nothing is provisioned. When
  they do, they are on a quarterly manual cycle, next due 2027-02-04, tracked in
  `credential-exceptions.json` and kept separate from KMS rotation per ruling 18 item 4.
- **Repository visibility** — I recommend making it private. Not done, and not to be done without
  your separate authorization (ruling 19 item 3). It stops further reading; it does not un-publish
  what has already been fetched or cached.
- **Git history rewrite** — my recommendation is **not** to. Changing the password makes its
  presence in history an embarrassment rather than a risk, and a rewrite invalidates every clone
  and every SHA referenced in the project's own documents.

## Credentials that do NOT need rotation on these grounds

Marked "(set)" in the handoff document and therefore never disclosed: Anthropic, Resend, Algolia,
Apollo, OpenAI, Google and LinkedIn. Their own expiries still apply — LinkedIn ~2 months, Google
refresh token ~6 months.
