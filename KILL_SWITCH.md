# Kill switch — operating procedures

**P0.2.** Stops autonomous execution without a deploy. Design: `claude/p0-2-kill-switch-approved-design.md` in the project.

No credentials appear in this document. Every procedure assumes you are already signed in to Railway or the admin account.

---

## The one thing to know

**Any applicable stop stops the work.** There is no override, no "allow" row, and no precedence rule that lets a narrower scope re-enable something a broader stop halted. If you are unsure which scope to use, use **global** — you can narrow afterwards.

A stop takes effect in **under 2 seconds** (measured: 1011ms worst case) and needs **no redeploy**.

---

## GLOBAL STOP

### Preferred: the API

```
POST /api/autonomy/stops
Authorization: Bearer <your admin token>
Content-Type: application/json

{ "scope_type": "global", "reason": "CEO emergency stop — unexpected outbound campaign behaviour" }
```

`reason` is mandatory and must be at least 10 characters. It is what an incident review reads.

### Break-glass: when the application is unavailable

The HTTP control plane cannot be the only way to stop the thing that serves it. From the Railway Postgres console, or `railway ssh` then `psql $DATABASE_URL`:

```sql
INSERT INTO autonomy_stops (scope_type, scope_key, reason)
VALUES ('global', '', 'break-glass stop — <what you saw>');
```

This is audited exactly like the API call: a database trigger records it to `autonomy_events` and attributes it to `sql-break-glass`. It also fires the NOTIFY that propagates it immediately. **You do not need the app running, and you do not need to restart anything.**

---

## GLOBAL RESUME

### Preferred: the API

```
DELETE /api/autonomy/stops
Authorization: Bearer <your admin token>
Content-Type: application/json

{ "scope_type": "global", "reason": "investigation closed — outbound verified correct" }
```

A reason is required for a resume as well. Lifting a halt is as significant as imposing one.

### Break-glass

```sql
DELETE FROM autonomy_stops WHERE scope_type = 'global' AND scope_key = '';
```

Deleting the row does **not** erase the history. The STOP and the RESUME both remain in `autonomy_events` permanently. A break-glass resume is recorded with the reason `resumed (no reason recorded — break-glass path)`, so a resume with no explanation is visible as such.

---

## Narrower stops

`scope_type` / `scope_key`:

| scope | key | example |
|---|---|---|
| `global` | *(empty)* | everything |
| `company` | `abiozen`, `golfnex`, `favly`, `linkabl`, `aros`, `sitenex` | one business |
| `agent` | `ceo-agent`, `outreach-agent`, `inquiry-agent`, `reorder-agent`, … | one agent, all its schedules |
| `workflow` | a cron name, e.g. `weekday-910cst-outreach-agent` | one scheduled job |
| `capability` | `email.send`, `whatsapp.send`, `llm.call` | one kind of action, everywhere |

**Stopping all outbound email without stopping anything else:**

```sql
INSERT INTO autonomy_stops (scope_type, scope_key, reason)
VALUES ('capability', 'email.send', 'holding all outbound email while we check the template');
```

---

## What a stop does and does not halt

**Halted:** all 37 scheduled jobs; every outbound email; every WhatsApp message; `/api/triggers/check`; `/api/customers/engagement-event`; `/api/inquiry/receive`.

**Not halted, deliberately:**

- **Read-only reasoning.** A global stop leaves analysis available, so you can work out what happened. To stop that too: a `capability` / `llm.call` stop.
- **Cron failure alerts.** The `email.alert` channel is observability, not autonomy. Without this exemption a database outage would halt every job and also refuse the email telling you so.
- **Inbound recording** — `orders/webhook`, `events/ingest`, `inquiry/stripe-webhook`. These record facts that arrive from outside. Halting them would lose an order, an event, or a Stripe payment confirmation while stopping no outbound action.

---

## Checking state

```
GET /api/autonomy/stops        # current stops + recent STOP/RESUME/REFUSED history
```

or:

```sql
SELECT * FROM autonomy_stops;
SELECT at, action, scope_type, scope_key, actor, reason FROM autonomy_events ORDER BY at DESC LIMIT 30;
```

A **`REFUSED`** row is written every time something was actually blocked, with what was blocked in `detail`. For `/api/inquiry/receive` the full buyer enquiry is in `detail`, so a halt is **replayable** — a real enquiry refused during a stop is not lost.

---

## Fail-closed behaviour

If the switch cannot be read at all — the database is unreachable — then:

- **consequential actions are refused.** Email, WhatsApp, every scheduled job.
- **read-only reasoning continues.**
- **an alert is sent**, because nobody chose this halt. A deliberate stop is silent; an unknown kill-state is not.

So a database outage now halts scheduled work. That is intended. The alternative is agents acting while the brakes are of unknown condition.

---

## Verifying it works

```
railway ssh 'node scripts/demo-kill-switch.js'
```

Stops autonomy globally, proves the mailer and a cron refuse, proves a separate process sees it, resumes, and shows the audit trail. It **refuses to run if a stop is already in force**, so it can never lift a halt somebody put in place deliberately, and it resumes in a `finally` block — printing the exact SQL if it could not.

It halts all autonomy for a few seconds. Avoid running it at :05, :17, :25 or :45 past the hour, when the hourly jobs fire.
