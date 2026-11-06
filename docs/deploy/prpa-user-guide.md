# Federal Contracts — where it is and how to use it

**Ruling 28 item 7.** Two minutes of reading. Everything here is after deployment; before that the
page does not exist on the server.

---

## 1. Where it is

| | |
|---|---|
| **URL** | `https://playbookos-production.up.railway.app/#prpa-tracker` |
| **Custom domain** (once SSL is provisioned) | `https://playbook.abiozen.com/#prpa-tracker` |
| **Navigation** | sign in → left sidebar → **FEDERAL** → **Federal Contracts** |
| **Sidebar icon** | 📋, directly under **Federal Pipeline** |
| **Who can see it** | `admin` and `super_admin` only |

The `#prpa-tracker` fragment goes straight to the page, so it is worth bookmarking. Opening the bare
URL lands you on the dashboard; the sidebar gets you the rest of the way.

**If the FEDERAL section is not in your sidebar**, your account is not `admin` or `super_admin`.
That is deliberate — ruling 1 made the federal surface owner-first — and widening it is a one-line
change when you want it.

---

## 2. What you are looking at

Two banners sit above the table, and both are computed from the data rather than typed in.

**The amber banner — "DEVELOPMENT DATASET".** These are 253 real SAM.gov records, harvested once on
2026-11-06. Nothing refreshes them. The banner counts the days since the harvest and says so,
because a board of real solicitation numbers and real deadlines otherwise looks exactly like a live
feed. **Check it before you trust a deadline.**

**The red banner — "THE CAPABILITY REGISTRY IS EMPTY".** Abiozen holds zero verified capabilities,
so nothing on the board can be QUALIFIED and every feasibility verdict is UNPROVEN at best. That is
the truthful state of the registry, not an error. It is also the single thing most worth changing:
until capabilities are verified, this tool can tell you what you cannot do and never what you can.

---

## 3. The six tabs

| Tab | What is in it |
|---|---|
| **Worth working** | Nothing disqualifying found. Start here. |
| **Confirm deadline** | A deadline is on record but no human has checked it against the notice. **Nothing is biddable until one has.** |
| **Awaiting decision** | Biddable, and nobody has recorded bid or no-bid yet. |
| **Flagged** | Something specific needs settling — e.g. a blank set-aside field contradicting the notice text. |
| **Barred** | Eligible but undeliverable, closed, or sole-source. Sorted last, never hidden. |
| **All** | Everything. |

---

## 4. Reading a row

Columns, left to right: **Title · Agency · Solicitation · Deadline · Set-aside · Requested ·
Feasibility · Missing · Tier · Source · Review**.

Three things to know:

- **"not stated" in amber is not the same as blank.** It means the source did not populate that
  field. An empty cell would read as "no agency"; this says "SAM did not tell us".
- **"unconfirmed" under a deadline** means it was harvested, not verified. Confirming it is what
  makes a row biddable.
- **Hover anything coloured.** The feasibility verdict, the tier chip and the ⚠ flags all carry the
  reason behind them in a tooltip. The reason is the useful part.

---

## 5. The four things you can do

### Review an opportunity
Click the title (or **review**). The panel underneath shows the notice excerpt, the **seven
fulfilment checks** with the reason for each, every version kept, and the audit history.

### Confirm a deadline
In that panel, **✓ Confirm this deadline** — after checking it against the notice at SAM.gov. The
row becomes biddable. This is recorded against your name.

### Record a decision
Type a reason (at least 10 characters — a decision with no reason is not reviewable), then **Record
BID**, **Record NO-BID** or **Undecided**.

**A decision is recorded only.** Nothing is submitted to SAM.gov and no contracting officer is
contacted. There is no endpoint in this application that could do either.

### Download for Excel
**⬇ Export to Excel (CSV)**, top right. Downloads every row with its provenance — opens directly in
Excel with correct encoding. Nothing in it can execute.

---

## 6. Adding an opportunity by hand

**+ Import**, top right. Either paste a SAM.gov URL (`https://sam.gov/opp/<id>/view`) and press
**Fetch this notice**, or paste a SAM.gov CSV export.

Intake is attended and one notice at a time, limited to 10 per minute. There is no scheduled
harvest: the SAM.gov endpoint behind it is undocumented, and running it unattended is not
authorised.

---

## 7. If something looks wrong

| What you see | What it means |
|---|---|
| "The board could not load" + *schema is not applied* | the migration has not been run on that environment |
| Every feasibility verdict is UNPROVEN | correct — the capability registry is empty |
| A deadline in the past | the dataset has aged; nothing refreshes it. The banner says how many days |
| "not stated" everywhere in Agency | SAM's search index left it empty for those notices |
| 429 on a URL import | more than 10 imports in a minute |
