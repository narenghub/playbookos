# Ruling 24 — NO-BID recorded, ranking corrected, and the next ten prospects

**Development and local testing only.** Nothing was deployed, no migration was run against
production, no external communication was sent, and no bid was submitted. The branch is
`feat/prpa-phase2-sam-prep`; **nothing was pushed**, because a push to `main` auto-deploys on
Railway and that is the production deployment ruling 24 item 10 withholds.

| | |
|---|---|
| Ruling | 24 (items 1–10) |
| Date | 2026-11-06 |
| Corpus | 253 opportunities (wave 1: 82 · wave 2: 173, deduped) |
| Shortlist scope | **wave 1, the 80-record CSV**, as item 5 specifies |
| Abiozen verified capabilities | **0** (measured 2026-11-05, unchanged) |
| Opportunities stored as QUALIFIED | **0**, and it cannot be otherwise while the registry is empty |
| `scripts/check-opportunity-tracker.js` | 137 assertions, exit 0 |
| `scripts/preflight.sh` | see §6 |

---

## 1. The NO-BID is recorded (items 1, 2)

`evidence/36C25627Q0074/DECISION.md` holds a **human-reviewed NO-BID recommendation** for the Roche
Ventana IDIQ, with the reviewer line left open for Naresh. The bid is **not** marked formally
declined and the contracting officer has **not** been contacted.

Preserved with it: both official documents identified by sha256 (not committed — the repository is
public and the files are re-fetchable from a canonical government URL, with the exact `curl` to do
it), the full 1,500-line extracted schedule as
`evidence/36C25627Q0074/appendix-c-line-item-schedule.csv`, the five contradictions found in the
solicitation, and a correction recorded against my own earlier work: the task-order limits of
"$2,000 minimum / $400,000 maximum" I relayed appear **nowhere** in the solicitation or either
attachment, and must not be used.

---

## 2. What the ranking engine was getting wrong (items 3, 4)

Item 3 said matching NAICS, unrestricted eligibility, or a generic reagent keyword must not imply
commercial feasibility. Running the corrected engine on the real 253 found **five** defects, each
of which had been producing a confident wrong answer:

1. **"JBA Deicer IDIQ" ranked #1 on the entire wave-1 board.** It matched a chemical NAICS and
   nothing else — no product class, no description read. Technical fit is now gated on knowing what
   is actually being bought: an unresolved product class keeps a third of the fit score, not all of
   it. The deicer is now classified a facility service and barred.

2. **59 of 81 wave-1 notices had no product class at all**, because SAM's search index returns an
   empty `Description` column for every record. The full record at
   `/opps/v2/opportunities/<noticeId>` does carry the body — but **only if the request omits
   `Accept: application/json`**, which that endpoint answers with HTTP 406. With the bodies applied,
   unresolved classes fell from 59 to 39.

3. **`tip` matched the acronym "TIP"** — NSF's Directorate for Technology, Innovation and
   Partnerships — and classified a research funding announcement as a laboratory consumables buy,
   which put it in the top ten. A three-letter word was deciding a product class.

4. **A blank set-aside field was being read as "unrestricted."** SAM's index left `SetASide` empty
   for `N0010426REJ97` while the notice body carries *"NOTICE OF TOTAL SMALL BUSINESS SET-ASIDE (DEV
   2026-O0037)"*. The engine scored it as open to anyone. It now raises a
   `SET_ASIDE_UNVERIFIED` flag. **It deliberately does not dock the score**: docking it pushed the
   only direct chemical product fit on the board, closing in ten days, below a vaccine manufacturing
   RFP — the same mistake as barring sources-sought notices, where an unknown became a penalty and
   the penalty hid the thing worth looking at. An unknown is a reason to verify, and verification is
   one phone call.

5. **The date bug, fifth instance.** The demo printed `deadline Sat Nov 07`, and the sweep that
   followed found `src/lib/sitenex/contract-render.js` writing the same malformed date into the
   **payment schedule of a generated contract**. Six further instances were fixed across
   `scripts/`. Fixing these one at a time is what produced a fifth, so
   `scripts/check-date-formatting.js` now sweeps `src/` and `scripts/` on every preflight run and
   exits non-zero on any raw `String(<date>).slice(...)`.

The seven checks item 4 names are each explicit, each can return UNKNOWN, and **UNKNOWN is never a
pass**: proprietary OEM product, manufacturer authorization, supplier availability, minimum order
quantity, fulfilment lead time, required certifications, estimated gross margin. A verdict is
`NOT_FEASIBLE` on any blocker, `UNPROVEN` on any unknown, `FEASIBLE` only when all seven clear.

**Effect on the full 253:** 105 barred, of which **66 are barred on fulfilment** — eligible, and we
could not deliver them.

---

## 3. Research chemicals are not clinical diagnostic consumables (item 6)

The word that breaks this distinction is **"reagent"**: it belongs to both trades, and the
research-chemical pattern matched it. So a VA coagulation or flow-cytometry reagent buy was being
read as something ChemScene could ship.

Three product classes were added, each out of the supply channel's reach for a stated reason:

| Class | Why the channel does not reach it |
|---|---|
| `clinical_diagnostic_consumable` | Instrument-matched, validated as part of a regulated assay system. Supplied by the diagnostics OEM or its authorised distributors. **Whether or not the notice names the manufacturer** — Roche was this class with the name attached, not a different kind of problem. |
| `radiopharmaceutical` | Two independent barriers: an NRC or Agreement State radioactive materials licence, and a half-life that requires production near the point of use. |
| `facility_service` / `unrelated` | Outside every declared Abiozen business line. Not a sourcing question at all. |

On the real corpus this reclassified **16 notices** that had been sitting in the scoreable set:
5 clinical diagnostic consumables, 3 radiopharmaceuticals (FDG and general diagnostic isotopes),
6 facility services, and 7 in other industries.

Each of these is locked by an assertion built from the real misread, so a later widening of the
chemical patterns cannot quietly re-break it.

---

## 4. The next ten prospects (items 5, 7, 10)

From the 82-record wave-1 harvest, ranked by practical business feasibility. **No opportunity is
marked QUALIFIED** — the registry is empty, so none can be (item 8). Every feasibility verdict below
is `UNPROVEN`, which means *we have not shown we can deliver it*, not *we can*.

Agency, deadline and set-aside are as harvested unless marked otherwise. "Requested" is from the
notice body where one exists.

### The honest summary first

Of these ten, **one is a direct product fit** (#4, ammonium hydroxide, closing in ten days).
**One needs its attachments read before anything can be said** (#2, latanoprost). **Three are
analytical-services contracts that require laboratory accreditation Abiozen does not hold** (#3, #5,
#6). **Four are R&D, vaccine or drug-development contracts outside Abiozen's trade** (#1, #7, #9,
#10). **One needs a cylinder fleet** (#8).

That is the finding, and it is more useful than the ordering: a chemistry-targeted harvest of 82
live federal notices yielded exactly one requirement Abiozen could plausibly quote today.

### 1 · 75N94026R00008 — score 55 · WORK NOW
- **Agency** HHS / NIH / NICHD · **Closes** 2026-12-18 · **Set-aside** none · 541715 / AN12
- **Requested** Data Coordination Center for the Best Pharmaceuticals for Children Act: project
  management, data management, statistical support, clinical study monitoring, regulatory support,
  safety monitoring. Single-award **cost-reimbursement** IDIQ, ordering period up to ten years.
- **Feasibility** `cro_service` · UNPROVEN. Requires an established DCC with statisticians and
  validated clinical data systems. A **cost-reimbursement** contract additionally requires an
  accounting system the Government finds adequate for determining costs (FAR 16.301-3) — a
  threshold a company with no verified capabilities does not meet.
- **Missing** everything: no verified capability, no accounting-system determination, no past
  performance on a DCC.
- **Next action** **No bid.** Worth recording as a 2027 teaming or subcontract target.
  *(It ranks first because it is unrestricted, far out, and matches two business lines — which is
  precisely why the ranking is reported with this column and not alone.)*

### 2 · 36E79727R0039 — score 54 · REVIEW
- **Agency** Veterans Affairs · **Closes** 2026-11-17 (11 days) · **Set-aside** none · 325412 / 6505
- **Requested** Latanoprost Ophthalmic Solution, VA national contract VA-27-00006027. **The notice
  body is literally `N/A`** — the scope is in attachments that were not retrieved, so what follows
  is from the title and PSC alone and is marked as such.
- **Feasibility** `generic_api` · UNPROVEN. **A classification nuance worth stating:** latanoprost
  ophthalmic solution is a *finished dosage form*, not an API. The nearest available class
  understates the requirement — a finished generic drug normally requires an FDA-approved ANDA
  holder, labeler or authorised distributor of record, which Abiozen is not.
- **Missing** the solicitation attachments; whether offerors must be the manufacturer or ADR; TAA
  and FSS terms.
- **Next action** **Read the attachments first.** This is the one row where a document fetch
  changes the answer, and there are eleven days.

### 3 · W912ES27QA013 — score 50 · REVIEW
- **Agency** DoD / US Army Corps of Engineers, St. Paul District · **Closes** 2026-11-18 ·
  **Set-aside** Total Small Business (FAR 19.5) · 541380 / F103
- **Requested** Groundwater monitoring for the Grand Encampment dredge material placement site,
  Zumbro River near Kellogg, MN. Collect samples from **three monitoring wells and up to four
  government-selected residential wells** before, during and after the Spring 2027 unload; plus
  river upstream and standing water in the placement pit. **Analysis by a laboratory accredited
  under the Minnesota Environmental Laboratory Accreditation programme.**
- **Feasibility** `analytical_service` · UNPROVEN. Needs a field sampling crew in
  Minnesota and an MN-ELAP accredited laboratory. Abiozen holds **no accreditations of any kind**.
- **Missing** MN-ELAP accreditation (or a teaming partner holding it); field crew.
- **Next action** Viable only as a teaming arrangement. The prior question is strategic: whether
  analytical services is a line Abiozen intends to enter.

### 4 · N0010426REJ97 — score 49 · REVIEW · ⚠ `SET_ASIDE_UNVERIFIED`
- **Agency** DoD / NAVSUP · **Closes** 2026-11-16 (10 days) · **Set-aside** harvested as *none*,
  **but the notice text carries "NOTICE OF TOTAL SMALL BUSINESS SET-ASIDE (DEV 2026-O0037)"** ·
  325199 / 6810
- **Requested** Ammonium hydroxide — **and the detail matters**: the word "ammonium" appears only in
  the title. The body identifies the item by **NSN against a Navy IRPOD**, notes that *"the
  nomenclature and the NSN listed on the IRPOD take precedence"*, lists NSN 8125-01-493-7259 bottles
  and 8125-01-612-8910 screw caps at *"six bottles and six screw caps per each package purchased"*,
  and requires **production lot testing** with a submittal, plus WAWF invoicing and a stated **CMMC
  cybersecurity maturity level**.
- **Feasibility** `research_chemical` · UNPROVEN — the only class on this shortlist the supply
  channel reaches at all. But this is not a catalogue order: it is a packaged chemical to a Navy
  specification with lot testing and a CMMC requirement.
- **Missing** the set-aside status (**verify first**); the IRPOD and NSN specification; a supplier
  quote; CMMC level and whether Abiozen meets it; whether production lot testing can be satisfied.
- **Next action** **Verify the set-aside on the official notice today.** If it is a total small
  business set-aside, confirm Abiozen's small-business status qualifies; then pull the IRPOD. This
  is the single best genuine product fit on the board and it closes in ten days.

### 5 · 36C24627Q0096 — score 47 · REVIEW
- **Agency** Veterans Affairs · **Closes** 2026-11-16 (10 days) · **Set-aside** none · 541380 / F103
- **Requested** "D and D Laboratory Steam & Water Testing". **The notice body says only
  "Solicitation Extension"** — the scope is in the original notice and its attachments, not
  retrieved.
- **Feasibility** `analytical_service` · UNPROVEN. Same accreditation gap as #3.
- **Missing** the scope itself; accreditation.
- **Next action** Fetch the original notice before judging. Low priority behind #4 and #2.

### 6 · 140GG027Q0022 — score 47 · REVIEW
- **Agency** **not populated in the harvest**; the notice text names the **USGS Louisiana Water
  Science Center, Baton Rouge** (unconfirmed field) · **Closes** 2026-11-16 · **Set-aside** Total
  Small Business · 541380 / B504
- **Requested** Analysis of **SPATT samples for microcystin, anatoxin, cylindrospermopsin and
  saxitoxin congeners**. One year plus four option years. NAICS 541380 Testing Laboratories, size
  standard $19M. Award anticipated **7 days after close**.
- **Feasibility** `analytical_service` · UNPROVEN. Requires LC-MS/MS cyanotoxin congener capability
  under laboratory accreditation.
- **Missing** accreditation; the instrument capability; a partner lab.
- **Next action** No bid alone. Same strategic question as #3.

### 7 · HHS-NIH-NIAID-BAA2026-1 — score 47 · REVIEW
- **Agency** HHS / NIH / NIAID DMID · **Closes** 2026-12-08 · **Set-aside** none · 541715 / AN12
- **Requested** Omnibus Broad Agency Announcement for the **development of medical interventions**
  against infectious disease threats including drug-resistant pathogens.
- **Feasibility** `cro_service` · UNPROVEN. This is drug and vaccine development, not chemical
  supply or testing.
- **Next action** **No bid.**

### 8 · N0017424SN26 — score 44 · REVIEW
- **Agency** DoD / NAVSUP · **Closes** 2028-11-11 · **Set-aside** Total Small Business · 325199 / 6830
- **Requested** Blanket Purchase Agreement for **compressed and liquefied gases**. **No notice body
  at all** — this row is classified on its title alone, and is reported as `unknown` rather than
  guessed.
- **Feasibility** `unknown` · UNPROVEN. Industrial and medical gas supply needs a cylinder fleet and
  DOT cylinder certification, which is not a catalogue chemical channel.
- **Missing** the scope; everything downstream of it. The 2028 date suggests a standing BPA window
  rather than a live competition — **verify it is still accepting** before spending time.
- **Next action** Low priority. Confirm the window is open, then decide.

### 9 · HT9427-26-R-E020 — score 41 · REVIEW
- **Agency** Defense Health Agency (DHACA), Fort Detrick · **Closes** 2026-11-20 · **Set-aside**
  none · 541715 / AN13
- **Requested** **Prototype development** of a "Barrier Combination product" — a physical wound
  barrier with antibacterial and/or antifungal activity released from the barrier.
- **Feasibility** `unknown` · UNPROVEN. A drug-device combination product development programme.
- **Next action** **No bid.**

### 10 · 75A50126R00001_RFP_NPIVS_27 — score 41 · REVIEW
- **Agency** HHS / BARDA · **Closes** 2026-11-20 · **Set-aside** none · 541714 / AN12
- **Requested** Vaccine medical countermeasures for pandemic influenza preparedness: **produce
  antigens, adjuvants and vaccines**, furnishing facilities (US preferred), personnel and materials.
- **Feasibility** `unknown` · UNPROVEN. Requires licensed vaccine manufacturing.
- **Next action** **No bid.**

---

## 5. Limitations, stated rather than worked around

- **39 of 82 wave-1 notices still have no resolvable product class.** Their bodies say "see the
  attached documents" and nothing more. They are reported UNKNOWN and are never upgraded by
  inference; four of the ten above are in this state and are labelled so.
- **Two notices have no agency in the harvest.** The full record carries only an organisation id
  that does not resolve to a name. Where the notice text names the office I have given it and marked
  it unconfirmed.
- **Attachments were not fetched for the shortlist.** The route is proven
  (`/opps/v3/opportunities/<noticeId>/resources` then download), and it is the obvious next step for
  #2 and #5 specifically. It was not run across the shortlist because ruling 22 item 8 keeps that
  endpoint a manual, attended source.
- **No margin figure appears anywhere above.** No supplier quote exists for any of these
  requirements, and a margin with one side missing would be invented.
- **The 80-record CSV is preserved as reproducible evidence** with its harvest timestamp, sha256
  `15aa1b2b790ca2ad…`, confirmed/unconfirmed field distinction, and the route caveat that the
  endpoint is undocumented and for manual use only.

---

## 6. Verification run

| Check | Result |
|---|---|
| `scripts/check-opportunity-tracker.js` | **137 assertions, 0 failed, exit 0** |
| `scripts/check-date-formatting.js` | **604 files scanned, 0 raw date formats, exit 0** |
| `scripts/validate-export-csv.js` | **31 checks, 0 failed, exit 0** — BOM present, CRLF, 28 columns, 4 fields listed unconfirmed |
| `scripts/prpa-tracker-demo.js` | **exit 0** — 253 rows, 0 QUALIFIED on the real registry |
| `scripts/preflight.sh` | **67 checks, all executed and passed, exit 0** (was 66; the date sweep is now one of them) |

Read bare, as its own command, exit code read with `echo $?`. Nothing was piped through `head`,
`tail` or `grep` and treated as the verdict.

---

## 7. Still outstanding

**In the tracker (item 9):** the manual-intake HTTP endpoint, the review-queue API and UI, the
deadline-confirmation API, duplicate tiers 2–3 surfacing to a human, audit-history writing, and
role-based route permissions. The library and the schema are built and tested; the HTTP surface is
not.

**Carried from earlier rulings, unchanged and still yours:**
- **The admin password exposed in public Git history remains OPEN** until you confirm it has been
  changed. I have not inferred remediation from anything.
- Credential rotation per `docs/security/rotation-order.md`, in dependency order. Nothing rotated
  automatically; no secret has been printed, copied or received.
- The redacted handoff at `claude/playbookos-handoff-redacted-replacement.md` still needs pasting
  over the project description.
- Repository visibility is your decision; no history was rewritten and no visibility changed.
- **ENG-003** remains a production release blocker: ~12 DDL migrations run at boot in `server.js`,
  so a non-DDL application role cannot start the app until they move to a migrator entrypoint.
- SAM.gov registration expires **2026-12-30** — inside the performance window of several
  opportunities above.
