# Region source for nationwide prospecting — report before any Places call

**Section 3 is the one that changed the plan.** The region data is settled and cheap; what the experiment
MEASURES had to be rethought, because the metric it was built on turned out to be a proxy that does not
travel between states.

---

## 1. Where the region list should come from

**Recommendation: OMB/Census CBSA delineations, metropolitan only, for Wave 1.**

REGIONS is a map of state → free-text strings that Google Places Text Search accepts (`"machine shop in
Rockford, IL"`). Each `region x subtype` is one tile, capped at 60 results. So a region list is really a
question about *coverage per query*, and there are three candidate sources:

| source | count | verdict |
|---|---|---|
| **Census CBSA** (metro + micro) | 935 CBSAs, 992 state-pairs | the right shape: official, stable, named the way people search |
| Census **Urban Areas** | ~2,600 | too granular — most are a single town and would burn a query on ten results |
| **Curated metro list** | our 13 for IL | what we have; does not scale to 50 states without a week of judgement |

CBSA wins on three grounds: it is maintained by somebody else, its titles are already
`"Rockford, IL"`-shaped, and the metro/micro split gives a natural cost dial. The file is
`list1_2023.xlsx` from census.gov, parseable with `adm-zip` (already a dependency — the FDA DMF import uses
the same trick, an xlsx is a zip of XML).

**Keep Illinois curated.** Our 13 hand-made regions subdivide Chicago into five tiles because Chicago alone
blows through the 60-result cap; CBSA has one `Chicago-Naperville-Elgin` entry and would under-collect it.
The correct rule is "CBSA everywhere, plus hand-subdivision for any metro that hits the cap", and Chicago is
so far the only one that has.

### Metro vs metro+micro

Micropolitan areas cost 2.5x and are mostly small towns. For most segments that is poor value. **For
machine shops it might be the opposite** — an unmarketed industrial supplier is more likely in a
micropolitan county than in a metro — so this is a judgement about the segment, not the data. Wave 1
metro-only answers the generalisation question for $18; micro can be added per state afterwards.

---

## 2. Cost basis — observed, not estimated

Illinois has actually run, so the arithmetic uses its output rather than an assumption:

```
13 regions x 3 subtypes = 39 tiles  →  916 rows (the three shipping subtypes)
  = 23.5 rows per tile
  = ~2.5 Places calls per tile (20 results per page, so 2 pages typical, 3 max)
  at ~$0.035 per Text Search call
```

| | regions | tiles | calls | rows | cost |
|---|---|---|---|---|---|
| Illinois, curated (today) | 13 | 39 | ~98 | ~917 | **$3.41** |
| Illinois, CBSA metro | 12 | 36 | ~90 | ~846 | $3.15 |
| Illinois, CBSA metro+micro | 33 | 99 | ~248 | ~2,327 | $8.66 |

### Wave 1 — Ohio, Michigan, Indiana, Pennsylvania, Arizona

| state | metro CBSAs | metro-only cost | rows | +micro CBSAs | all-CBSA cost | rows |
|---|---|---|---|---|---|---|
| Ohio | 15 | $3.94 | ~1,058 | 44 | $11.55 | ~3,102 |
| Michigan | 16 | $4.20 | ~1,128 | 35 | $9.19 | ~2,468 |
| Indiana | 15 | $3.94 | ~1,058 | 40 | $10.50 | ~2,820 |
| Pennsylvania | 16 | $4.20 | ~1,128 | 36 | $9.45 | ~2,538 |
| Arizona | 7 | $1.84 | ~494 | 11 | $2.89 | ~776 |
| **TOTAL** | **69** | **$18.11** | **~4,866** | **166** | **$43.58** | **~11,704** |

Metro-only lands on the ~$20 estimate. All-CBSA is $43.58 — worth knowing before it is a surprise.

### Nationwide, for scale only

| | state-pairs | tiles | calls | rows | cost |
|---|---|---|---|---|---|
| metro only | 438 | 1,314 | ~3,285 | ~30,879 | **$115** |
| metro + micro | 992 | 2,976 | ~7,440 | ~69,936 | **$260** |

The 40,000–60,000 row estimate was close: metro-only lands at ~31,000, everything at ~70,000. Scoring
70,000 rows at two fetches each and 200ms is roughly **8 hours of wall clock**, which is why it has to be a
resumable background job rather than a pass.

---

## 3. What Wave 1 compares — DECIDED 2026-09-30

The original plan compared **agency-tracked rate**. That is no longer the comparison, for a reason the
Illinois data made plain.

### The agency signal is a tiebreak, not a segment selector

| subtype | rows | scanned | no-website | agency-tracked | avg reviews |
|---|---|---|---|---|---|
| machine_shop | 306 | 306 | 24% | 11% (34/306) | 21 |
| funeral | 303 | 271 | 5% | 30% (80/271) | 62 |
| pharmacy | 307 | **0** | 14% | unmeasurable | 103 |

Three things killed it as a primary metric:

1. **It was never 0%.** Rockford machine shops are 5 of 66 flagged, not zero. So "0% here vs 20% in
   Phoenix" had nothing to separate — Illinois funeral homes are already at 30%.
2. **It is 68% one rule.** 77 of the 114 signals are `reseller_builder`, all duda. "Agency-tracked" means,
   mostly, "built on duda" — a proxy for an agency relationship, not evidence of one. A state where a
   different reseller is popular would score low for a reason that has nothing to do with agency density.
3. **It is not a property of the prospect.** "Somebody may already be paid to look after this" is a reason
   to call a row *last*. It is not a reason to include or exclude it.

**So: the primary selector is what the site says — no website, or a site that scores badly.** Both are
measured directly from the site, which is exactly why they travel: `website IS NULL` and `site_score` mean
the same thing in Rockford and in Phoenix. The agency flag now appears in the ORDER BY and nowhere in the
WHERE, as the weakest term — after `site_score`, before review count — so a badly scoring agency-tracked
site still outranks a decent unmanaged one. Pinned by
`src/lib/agents/prospecting/selector.test.js`.

**The duda detector is deliberately not being broadened.** Chasing more reseller platforms is investing in
the proxy when the real measurement already exists.

### The Wave 1 comparison

Two metrics, both site-measured:

| metric | Illinois baseline | why it travels |
|---|---|---|
| **no-website rate** | machine_shop 24%, funeral 5%, pharmacy 14% | `website IS NULL` is the same fact everywhere |
| **site_score distribution** | see below, once pharmacy is scanned | a sum of named penalties read off the HTML |

Review count stays as context, not as a test — it is a Places artefact and varies with metro size.

### The Illinois baseline — complete as of 2026-09-30

Pharmacy is scanned (307 of 307; 307 rows in 485s of fetch time, no Places calls). All three shipping
subtypes now have a baseline:

| subtype | rows | scanned | no-website | blocked | scored | avg score | P1 | P2 | agency |
|---|---|---|---|---|---|---|---|---|---|
| machine_shop | 306 | 306 | **72 (24%)** | 27 (9%) | 207 | 16 | 88 | 24 | 34 (11%) |
| pharmacy | 307 | 307 | 44 (14%) | 26 (8%) | 237 | 8 | 44 | 3 | 45 (15%) |
| funeral | 303 | 271 | 16 (5%) | **131 (48%)** | 124 | 10 | 24 | 2 | 80 (30%) |

### site_score distribution — the Wave 1 metric

| subtype | 60+ | 40–59 | 20–39 | 0–19 | scored | **≥40 (a real rebuild case)** |
|---|---|---|---|---|---|---|
| machine_shop | 11 | 13 | 53 | 130 | 207 | **11.6%** |
| pharmacy | 0 | 3 | 37 | 197 | 237 | 1.3% |
| funeral | 0 | 2 | 37 | 85 | 124 | 1.6% |

### What this says: run Wave 1 on MACHINE SHOPS ONLY

| subtype | no-website | site_score ≥40 | sellable pool (P1+P2) |
|---|---|---|---|
| **machine_shop** | **23.5%** | **11.6%** | **112 of 306 — 37%** |
| pharmacy | 14.3% | 1.3% | 47 of 307 — 15% |
| funeral | 5.3% | 1.6% | 26 of 303 — 9% |

Machine shops are **4.4x** funeral homes on website absence and **7x** on bad-site rate. Pharmacy looks
mid-range on no-website, but of the 237 with a site only **3** score 40 or above: their sites are fine, so
the sellable pool is essentially just the 44 with no site at all.

Two more things the full scan showed:

- **48% of funeral home sites block the scanner** (131 of 271). The score distribution for funeral rests on
  124 of 303 rows, so it is the least trustworthy of the three — and we decided not to evade bot protection,
  so that will not improve. Machine shops block at 9%, which is why their numbers are the ones to trust.
- **Agency-tracked runs opposite to sellability**: funeral 30%, pharmacy 15%, machine_shop 11%. The segment
  with the most agency evidence is the one with the least to sell. That is a further argument for it being a
  tiebreak and not a selector.

**Recommendation: Wave 1 = machine_shop only, CBSA metro-only, five states.** 69 CBSAs x 1 subtype = 69
tiles, ~173 calls, **~$6.04**, ~1,600 rows. A third of the cost of the three-subtype run, against the one
segment with a signal worth generalising, measured on two metrics that travel.

Micropolitan stays open, and machine shops remain the segment most likely to earn it — an unmarketed
industrial supplier really is likelier in a micro county. Decide after Wave 1, on Wave 1's numbers.

## 4. Per-state CBSA counts

Metro / micro / total, with metro-only and all-CBSA cost per state at the observed rate.

```
STATE                  MET MICR TOTAL
Alabama                13   13    26   metro-only   $3.41   all   $6.83
Alaska                  2    2     4   metro-only   $0.53   all   $1.05
Arizona                 7    4    11   metro-only   $1.84   all   $2.89
Arkansas                7   14    21   metro-only   $1.84   all   $5.51
California             25   10    35   metro-only   $6.56   all   $9.19
Colorado                7   10    17   metro-only   $1.84   all   $4.46
Connecticut             5    2     7   metro-only   $1.31   all   $1.84
Delaware                2    1     3   metro-only   $0.53   all   $0.79
District of Columbia    1    0     1   metro-only   $0.26   all   $0.26
Florida                22    6    28   metro-only   $5.78   all   $7.35
Georgia                15   24    39   metro-only   $3.94   all  $10.24
Hawaii                  2    2     4   metro-only   $0.53   all   $1.05
Idaho                   7   10    17   metro-only   $1.84   all   $4.46
Illinois               12   21    33   metro-only   $3.15   all   $8.66
Indiana                15   25    40   metro-only   $3.94   all  $10.50
Iowa                    9   15    24   metro-only   $2.36   all   $6.30
Kansas                  7   13    20   metro-only   $1.84   all   $5.25
Kentucky                9   15    24   metro-only   $2.36   all   $6.30
Louisiana              10    9    19   metro-only   $2.63   all   $4.99
Maine                   3    1     4   metro-only   $0.79   all   $1.05
Maryland                6    4    10   metro-only   $1.58   all   $2.63
Massachusetts           7    3    10   metro-only   $1.84   all   $2.63
Michigan               16   19    35   metro-only   $4.20   all   $9.19
Minnesota               9   19    28   metro-only   $2.36   all   $7.35
Mississippi             4   17    21   metro-only   $1.05   all   $5.51
Missouri                8   18    26   metro-only   $2.10   all   $6.83
Montana                 5    2     7   metro-only   $1.31   all   $1.84
Nebraska                4    9    13   metro-only   $1.05   all   $3.41
Nevada                  3    5     8   metro-only   $0.79   all   $2.10
New Hampshire           2    4     6   metro-only   $0.53   all   $1.58
New Jersey              6    0     6   metro-only   $1.58   all   $1.58
New Mexico              4   13    17   metro-only   $1.05   all   $4.46
New York               13   14    27   metro-only   $3.41   all   $7.09
North Carolina         16   23    39   metro-only   $4.20   all  $10.24
North Dakota            4    4     8   metro-only   $1.05   all   $2.10
Ohio                   15   29    44   metro-only   $3.94   all  $11.55
Oklahoma                5   17    22   metro-only   $1.31   all   $5.78
Oregon                  8   12    20   metro-only   $2.10   all   $5.25
Pennsylvania           16   20    36   metro-only   $4.20   all   $9.45
Rhode Island            1    0     1   metro-only   $0.26   all   $0.26
South Carolina         10    6    16   metro-only   $2.63   all   $4.20
South Dakota            3    9    12   metro-only   $0.79   all   $3.15
Tennessee              10   17    27   metro-only   $2.63   all   $7.09
Texas                  26   41    67   metro-only   $6.83   all  $17.59
Utah                    5    6    11   metro-only   $1.31   all   $2.89
Vermont                 1    5     6   metro-only   $0.26   all   $1.58
Virginia               11    4    15   metro-only   $2.89   all   $3.94
Washington             13   10    23   metro-only   $3.41   all   $6.04
West Virginia          10    5    15   metro-only   $2.63   all   $3.94
Wisconsin              15   14    29   metro-only   $3.94   all   $7.61
Wyoming                 2    8    10   metro-only   $0.53   all   $2.63
```

Source: `list1_2023.xlsx`, OMB/Census 2023 delineations — 935 CBSAs (393 metropolitan, 542 micropolitan),
992 state-pairs excluding Puerto Rico. A CBSA spanning states is counted once per state, because each state
run has to search it.
