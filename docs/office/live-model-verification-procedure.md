# Controlled live-model verification — procedure, not an authorization

**Prepared 2026-11-25 for §6.** Owner's instruction: *"Prepare a separate controlled live-model
verification procedure with an exact development spending ceiling, provider, model, call limit and
abort conditions. No live paid provider execution is authorized by this instruction."*

**This document authorizes nothing.** It is what a separate approval would approve. Nothing in it
has been executed; no paid provider call has been made at any point in this work.

---

## Why this is needed at all

Everything verified so far about governed AI is **deterministic or simulated**, and the three are
kept apart deliberately:

| Kind | What it proves | Where |
|---|---|---|
| **Deterministic** | the planner, the budget arithmetic, the gates | `check-finite-budget-db.js`, `check-office-decomposition-db.js` |
| **Simulated model** | the governed path handles a model's *output* shape | `check-office-governed-ai-db.js` (stubbed provider) |
| **Actual live model** | **nothing yet** | this procedure |

The integrated cycle (B3.10) asserts **zero provider calls** — the mailer and network spies are
fired once each first, so their silence means something. So the honest statement of the current
position is: the hold is atomic, serializes correctly under concurrency and survives a crash; the
configured limits cannot be exceeded by concurrent allocation; and **no live model has ever been
planned with under it.**

**The ceiling is not a proven bound on what a provider will charge**, and this document previously
said it was. Owner's requirement 5, 2026-11-26: *"Atomic reservations prevent concurrent allocation
beyond configured limits, but an underestimated provider charge can still exceed its reservation.
Post-call settlement does not prevent that overspend. Do not call an estimated reservation a proven
worst-case charge."* The held figure is a conservative estimate supplied by the caller before the
provider has decided what to bill. An under-estimate is a hole in the limit; since 2026-11-26 a
charge above its hold settles as `overspent` rather than `reconciled`, with both figures in the
note — which is **detection after the money is spent**, not prevention. Step 4 below is what tests
whether the estimates actually bound the charges, and it is the reason this exercise exists.

That gap is exactly what this closes, and it cannot be closed by more simulation.

---

## 1. Ceiling

| Limit | Value | Enforced by |
|---|---|---|
| **Total development spend for the whole exercise** | **US $2.00** | a named budget exception on the fixture objective, time-bounded to the window |
| Per-objective budget | $2.00 | `objectives.budget_usd` on the fixture objective |
| Per-call allowance | ≤ $0.02 | `maxChargeUsd`, held before the provider is reached. An allowance, not a proven maximum charge |
| Maximum calls | **20** | the per-call hold against the $2.00 objective ceiling makes the 21st call refuse arithmetically |
| Maximum output tokens per call | **512** | sent as `max_tokens`; the provider cannot bill more |
| Maximum input per call | ≤ 4 KB of prompt + system | so the byte-length bound stays under $0.02 at Haiku rates |

$2.00 is chosen so that **every** way the exercise can go wrong is affordable: 20 calls at the full
per-call allowance is $0.40, so the ceiling is five times the spend the allowances permit and the
refusal is demonstrated long before the money matters. Five times, rather than tight, precisely
because the allowance is an estimate: the margin is what absorbs an under-estimate, and the $2.00
objective budget is the bound that does not depend on the per-call figure being right.

**The ceiling is not advisory.** It is the same `authorizeSpend` hold every metered call now takes,
against a real objective row, so exceeding it is refused by the database rather than by someone
watching a dashboard.

## 2. Provider, model, credential

| | |
|---|---|
| Provider | Anthropic Messages API, `https://api.anthropic.com/v1/messages` |
| Model | `claude-haiku-4-5-20251001` — the cheapest tier, `$1.00/$5.00` per million |
| Capability alias | `fast` (resolves to the above) |
| Credential | a **development** `ANTHROPIC_API_KEY`, issued for this exercise and revoked after |
| Environment | `playnexa-m7-dev` only. `PLAYNEXA_WORKER_ENV=development` asserted before the first call |

**Not the production key.** A separate key means the spend is attributable and the revocation is
clean; reusing production's would make "did this exercise cost anything" unanswerable from the
provider's side.

## 3. What is being verified

Only the things simulation cannot reach:

1. **A real model's output survives `validate()`.** The planner's proposal path is exercised with
   genuine model text, including the case where the model returns prose instead of the expected
   shape — which is parsed, never evaluated, on the same code path.
2. **A proposal carrying an authorization-bearing field is refused BY NAME.** The 23 forbidden
   fields have only ever been tested with fixtures I wrote. A real model asked to produce a plan
   will sometimes volunteer `"approved": true`, and that is the case worth seeing refused.
3. **The hold is settled to a MEASURED cost.** Every settlement so far has used a fixture figure.
   This is the first time `usage.input_tokens` and `usage.output_tokens` come from the provider.
4. **Whether the estimate actually bounds the charge.** For each call: assert
   `measured cost ≤ held allowance`. This is the one thing no amount of simulation can establish,
   because it is a claim about the provider's billing and not about our arithmetic. If the
   inequality ever fails, the per-call allowance is wrong and the exercise aborts immediately —
   the single most important assertion in the procedure. Since 2026-11-26 `settleSpend` also
   records that case as `financial_state = 'overspent'`, so a failure leaves durable evidence
   rather than only a message in a transcript.
5. **A CJK prompt is bounded correctly.** One call with Japanese text, since that is the case the
   old `chars/3` heuristic got wrong by a factor of three.
6. **`cost_known: false` is reachable and handled.** If any call returns without a usage block, the
   reservation must settle as `unknown`, not zero.

## 4. Abort conditions — any one of these stops the exercise

| Condition | Why |
|---|---|
| **a measured cost exceeds its held allowance** | the estimate does not bound the charge; nothing further may be spent against allowances that do not hold. The reservation settles `overspent` |
| objective spend reaches $1.00 (half the ceiling) | a budget half consumed by an exercise sized for $0.40 means something is charging more than modelled |
| more than 20 calls attempted | the call limit is reached |
| any call returns `cost_known: false` more than twice | repeated unmeasurable spend is unreconcilable, and §4's rule is that it stays conservatively accounted |
| `PLAYNEXA_WORKER_ENV !== 'development'` | the environment is not the one authorized |
| any consequential capability is reached | the exercise is read-only planning; a consequential path means the scenario is wrong |
| an outward call to anything but the provider | the network spy fires; nothing else should leave |
| wall-clock exceeds 30 minutes | an unattended exercise is not what was approved |

On abort: the exercise stops, the development key is revoked, the fixture objective is set to
`cancelled`, and the evidence is written up including the abort reason. **An aborted run is a
result, not a failure to be retried into success.**

## 5. Procedure

Each step's exit code is read; none are chained with `&&` to a subsequent step.

1. Confirm `PLAYNEXA_WORKER_ENV=development` and that `DATABASE_URL` points at the development
   database. Abort if either is wrong.
2. Create the fixture objective with `budget_usd = 2.00`, tier `supervised`, status `active`,
   owned by a fixture company — **not** `obj-abiozen-first-governed-rfq`, which stays blocked for
   autonomous execution until a separate finite production budget is approved.
3. Record the baseline: `SELECT COALESCE(SUM(cost_usd),0) FROM office_cost_ledger WHERE
   objective_id = <fixture>`. It must be `0`.
4. Run the exercise driver with the development key. It performs at most 20 governed calls, and
   after **each** one asserts: a reservation existed, it was marked dispatched before the call, the
   measured cost is ≤ the held allowance, and the reservation settled `reconciled` — NOT
   `overspent`, which is now a distinct state and is the shape a hole in the allowance takes.
5. Assert the ledger total is ≤ $0.40 and the 21st call refuses with
   `would_exceed_objective_budget`.
6. Assert zero outward calls to any host other than the provider.
7. Revoke the development key. Set the fixture objective to `cancelled`. Delete every fixture row
   by recorded id.
8. Write up the evidence: calls made, tokens in and out, held vs measured per call, the largest
   ratio of measured to held, and any abort.

## 6. What this will NOT establish

Stated so the write-up cannot be read as more than it is.

- **It is not production acceptance.** A development key, a fixture objective and a fixture company.
- **It does not authorize autonomous production work.** `obj-abiozen-first-governed-rfq` stays
  blocked; the proposed $20 production budget for it is subject to separate approval and is not
  applied.
- **It does not prove the bound is tight**, only that it is a bound. A hold five times the measured
  cost is a correct hold and a wasteful one; the ratio is reported so tightening can be a separate,
  measured decision.
- **It does not exercise delegation or execution under a live model.** Planning only, read-only
  steps only.

## 7. Owner actions required before this can run

1. Approve this procedure, or amend the ceiling and limits.
2. Issue a **development** `ANTHROPIC_API_KEY` for the exercise, and plan to revoke it afterwards.
3. Confirm the development database and environment to use.

Until all three, this stays a document. No paid provider call has been made.
