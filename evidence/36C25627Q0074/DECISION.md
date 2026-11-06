# 36C25627Q0074 — NO-BID RECOMMENDATION (local evidence record)

**Status: RECOMMENDATION ONLY. The bid has NOT been formally declined and the contracting officer
has NOT been contacted** (ruling 24 item 1). No external communication of any kind has been sent
about this solicitation.

| | |
|---|---|
| Solicitation | 36C25627Q0074 |
| Title | 6550 — Roche Ventana Reagents IDIQ, 5 Successive 1 Year Delivery Orders |
| Agency | Department of Veterans Affairs, VISN 16 · Southeast Louisiana VHCS, New Orleans LA |
| Notice | `https://sam.gov/opp/3ff61fca2b784247b277a95215ffb586/view` |
| Quotes close | 2026-11-09 13:00 CST |
| Set-aside | **None** — "This solicitation is 100% Unrestricted" |
| Recommendation | **NO-BID** |
| Recommended by | PlaybookOS PRPA tracker, from the official notice and its attachments |
| Reviewed by | *(pending — Naresh)* |
| Recorded | 2026-11-06 |

---

## Reasons

Five, in the order they decide it. The first two are each independently sufficient.

1. **No established Roche supply channel.** Abiozen's supply partners are BLD (BLDpharm), ChemSync
   (onboarding) and ChemScene — all small-molecule and research-chemical catalogue houses. Roche
   Ventana IHC/ISH reagents are proprietary in-vitro diagnostic consumables formulated for Roche
   BenchMark instruments. The gap is categorical, not commercial: these are not products that
   exist in a chemical catalogue at any price.

2. **No acquisition pricing.** We hold no Roche price file and no dealer quote, so there is no cost
   side to any calculation.

3. **7,500 required price entries.** Appendix C holds **1,500 line items** across 17 material
   pricing groups, **1,426 carrying Roche product codes**, every price cell empty, across **five
   ordering periods**. A compliant quote prices all of them. An incomplete Price volume is
   non-responsive.

4. **Unknown demand quantities.** The schedule has **no quantity column at all**. It is a rate
   card, so there is no basis in the document for estimating revenue — and with no stated ceiling
   (see §3 below) the only contractual figure is a $10,000 guaranteed minimum **for all five
   years**.

5. **Infeasible first-delivery readiness.** First delivery is required **no later than
   2026-11-21** — twelve days after quotes close. There is no supply route to build in that time.

**What this is not.** It is not a judgement that the opportunity is bad or that the Government did
anything wrong. It is unrestricted, requires no OEM authorization letter, and would be a genuinely
good fit for a company holding a Roche channel. We are not that company today.

---

## Preserved evidence

Downloaded from SAM.gov 2026-11-06 19:09 UTC via
`sam.gov/api/prod/opps/v3/opportunities/resources/files/<resourceId>/download`.

| File | sha256 | Size |
|---|---|---|
| `36C25627Q0074.docx` (full solicitation) | `0aea5b33a4ca17a80f35f1d0faef1e229e9ad6f9e73d9cd97c5aba32e9becb87` | 243,420 B |
| `Roche Reagents Price List 2026-2031.xlsx` (Appendix C) | `d4fee4a6bb0b2b749d7223b36059c30aed5133d32b5f761bced8c4220427fa65` | 90,506 B |

**The binaries are deliberately not committed**, and the hashes above are how their identity is
preserved. Two reasons: this repository is public, and a 334 KB pair of third-party documents that
can be re-fetched from a canonical government URL is better identified than copied. The extracted
content that we actually reason over **is** committed:

- `appendix-c-line-item-schedule.csv` — all 1,500 line items with Roche material numbers, product
  codes and descriptions, and the five empty price columns exactly as published.

To re-obtain the originals:
```sh
curl -sL "https://sam.gov/api/prod/opps/v3/opportunities/3ff61fca2b784247b277a95215ffb586/resources"
# then download each resourceId and verify against the hashes above
```

---

## Contradictions found in the solicitation

Recorded here because they survive this no-bid and matter at the 2031 recompete. Full quotations
in `claude/36C25627Q0074-feasibility-report.md`.

1. **Three procurement authorities cited for one acquisition** — FAR Part 15 (line 89), FAR Part 12
   (line 1156) and FAR 13.106-2 (line 1158).
2. **Single award or multiple award — stated twice each.** "One contractor will be selected for
   award" (line 89) and "single award" (line 1156) against "awarded as Multiple Award Task Order
   Contracts (MATOC's)" (line 91) and task orders competed "among the MATOC holders only" (line 92).
3. **The questions deadline equals the quote deadline** — both 2026-11-09 13:00 CST, so no question
   can be answered before quotes are due.
4. **FAR 52.216-19 Order Limitations has four unfilled blanks** — minimum order, single-item
   maximum, combination maximum, and the order-series period. **There is therefore no stated
   ceiling for this contract.**
5. **The technical evaluation factor is from a different procurement** — Factor 1 requires
   "sufficient capacity to deliver **certification results**", in a contract that buys reagents.

### A correction I am recording against my own earlier work

An earlier pass reported task-order limits of **"$2,000 minimum / $400,000 maximum"**. Those
figures appear **nowhere** in the solicitation or either attachment — every dollar figure in the
document was searched, and the only values present are the $10,000 guaranteed minimum and FAR
boilerplate thresholds ($5,000, $15,000, $100,000, $10,000,000). They were relayed without being
checked and must not be used.

---

## What happens next

- **Nothing is sent.** No declination, no CO contact, no acknowledgement.
- **The 2031 recompete is recorded.** Ordering Period 5 ends 2031-11-15. An unrestricted IDIQ with
  no OEM requirement at a named VA facility is a real target for a company that by then holds a
  Roche channel relationship.
- **The open question this raises is strategic, not procedural.** Three of the five opportunities
  verified so far ended at the same wall. Whether proprietary IVD consumables distribution is a
  line Abiozen intends to enter is a decision that changes what the tracker should rank highly — and
  it is not a decision the tracker can make.
