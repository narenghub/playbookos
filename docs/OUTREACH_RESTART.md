# Apollo Outreach — Restart Runbook

**Status as of 2026-09-17: all outbound cold email is PAUSED. Do not restart until targeting and copy change.**

This is the process for rebuilding the Apollo contact lists and turning sequences back on. Read the gap in section 1 before you build a list — it is the part that is easy to get wrong.

---

## 1. ⚠️ The per-company cap does NOT cover lists built in the Apollo UI

A per-company cap of **3 contacts** exists in code (`capPerCompany` / `addSequenceContacts` in `src/lib/agents/email-engine.js`, `APOLLO_MAX_PER_COMPANY`, default 3). It counts a recipient domain's contacts already scheduled in *any* Apollo sequence and enrolls only up to the cap. It fails closed: if it cannot read the counts, it enrolls nobody.

**It only applies to contacts enrolled through PlaybookOS**, i.e. contacts listed in `APOLLO_CONTACTS_S1`–`S4` and passed to `addSequenceContacts()`.

What that leaves unguarded:

| How a list is built | Capped? |
|---|---|
| `APOLLO_CONTACTS_S1`–`S4` → `addSequenceContacts()` | ✅ yes, at 3 per company |
| Contacts added in the Apollo UI, by CSV import, or by an Apollo list/automation | ❌ **no — Apollo has no per-company limit** |

- `APOLLO_CONTACTS_S1`–`S4` are **unset in production**. PlaybookOS has therefore never enrolled a single contact, and the cap has never capped anything.
- **All 2,902 contacts currently in S1–S4 were added through the Apollo UI** and never passed through the guard. That is how bms.com reached 413 contacts and received 334 emails to 242 people.

**So:** either enroll the rebuilt list through PlaybookOS (set `APOLLO_CONTACTS_S*` and let the guard run), or enforce the cap **before** import — dedupe the list to 3 per email domain yourself, because nothing downstream will do it for you.

---

## 2. Why it was paused (2026-09-17)

Full diagnosis of the 4 sequences S1–S4, from the Apollo API:

| Metric | Value |
|---|---|
| Unique contacts delivered | 1,685 (2,458 emails) |
| Bounced | 58 (3.3%), 43 hard. **S1 alone 7.7%** |
| Spam-blocked | 15 (0.9%) |
| Replies | **4 (0.24%)** — 2 from an existing buyer (hallandalerx), 1 unclassified, 1 "not interested" |
| Opens | Not measurable — see below |

- **Open tracking was off on 100% of delivered emails** (`enable_tracking: false`; 786 explicitly `manually_disabled`). Apollo's `unique_delivered_open_tracked` equals `unique_opened` equals 10, so the "opens" are inferences, not tracking. **The 0% open rate was a measurement artifact, not evidence about delivery.**
- Authentication is fine: SPF `include:_spf.google.com ~all`, DKIM published on the `google` selector, DMARC `p=quarantine`. Sending mailbox `sales@abiozen.com` (Google Workspace). Inbox-vs-spam placement has never been tested.
- Net-new positive replies from ~1,680 cold contacts: **zero**. The problem is targeting and copy, not plumbing.

---

## 3. Preconditions before any sequence is reactivated

- [ ] **Targeting changed** — a new list, not the paused 2,392 contacts.
- [ ] **Copy changed** — the current copy produced 0 net-new positive replies from ~1,680 contacts.
- [ ] **Cap of 3 per company enforced on the new list**, by the route in section 1 that matches how the list was built.
- [ ] **Emails re-verified by an outside service** (ZeroBounce, NeverBounce or similar). Apollo's own `email_status: "verified"` is stale data — every S1 contact that bounced was labelled "verified", and 24 more were later flagged "no longer verified". This is why S1 bounced at 7.7%. Budget roughly $3–4 per 1,000 addresses.
- [ ] **Inbox placement seed-tested** — send to Gmail/Outlook accounts you control and confirm the mail lands in the inbox, not spam. Never been done.
- [ ] **Decide on open tracking.** It is off today, so there is no open data at all. If you want opens, turn tracking on with a custom tracking domain (`tracking_domain_id` is already set on the mailbox). Reply rate stays the metric that matters.
- [ ] **Mailbox health.** `sales@abiozen.com` lost its Apollo OAuth token on 2026-08-14 and sent nothing Aug 12–19 before being reconnected. `naren@abiozen.com` is still Apollo's *default* mailbox but has been deactivated since March — check which mailbox a sequence sends from. Warmbox warm-up has been running since Aug 20.

## 4. Mechanics

Pausing and unpausing, by sequence id:

```
POST https://api.apollo.io/api/v1/emailer_campaigns/{id}/abort     # pause  → active:false, status_reason manual_pause
POST https://api.apollo.io/api/v1/emailer_campaigns/{id}/approve   # resume → active:true
```

Pausing clears the scheduled queue; the queued emails do not resume on unpause, the sequence reschedules.

Sequence ids (all paused 2026-09-17):

| Label | Sequence id | Contacts left paused |
|---|---|---|
| S1 · Compounding Pharmacy — GLP-1 Priority | `69cec4d0a628200019658bb1` | 369 |
| S2 · Research Lab Biotech | `69ceef8c41f16e0019399547` | 727 |
| S3 · Generic Manufacturer API | `69cef7ed269be20019b6a591` | 670 |
| S4 · University Research Institute | `69cefc5bf5e2cb00155b6d18` | 626 |

The ~25 weekly molecule and Reorder sequences PlaybookOS has created have **never sent an email** (no contacts were ever enrolled — see section 1). Two show `active: true` with 0 contacts and cannot send.

Useful read-only checks:

- Sequence stats: `POST /api/v1/emailer_campaigns/search` — `unique_delivered`, `unique_bounced`, `unique_delivered_open_tracked` (compare against `unique_opened` before trusting any open rate).
- What is queued right now: `POST /api/v1/emailer_messages/search` with `{"emailer_message_stats":["scheduled"]}`. Also accepts `delivered`, `bounced`, `spam_blocked`, `opened`, `replied`, `unsubscribed`. No pagination metadata is returned — page until a short page.
- Mailbox health incl. `revoked_at` and deliverability score: `GET /api/v1/email_accounts`.
- A sequence's contacts with `email_status`: `POST /api/v1/contacts/search` with `{"emailer_campaign_ids":["<id>"]}`.
