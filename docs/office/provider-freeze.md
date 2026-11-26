# The provider freeze: what may be requested, at what price, and what bounds it

**2026-11-26, Priority 5 of the third directive:** *"Freeze provider, exact model version, pricing
and permitted billing features; disable unaccounted features; document whether provider-side
spending controls are hard limits."*

Enforced by **`scripts/provider-surface-is-frozen.test.js` — 10 tests, 0 failures**, because a
freeze is a claim about what the code *can* do and a document cannot hold one. Changing any frozen
value below fails that test, which is the point: the ceiling has to be reconsidered in the same
change.

**Paid execution remains unauthorized.** Nothing here authorizes a call. No paid provider call has
been made.

---

## 1. Provider and endpoint — frozen

| | frozen value |
|---|---|
| Provider | Anthropic |
| Endpoint | `https://api.anthropic.com/v1/messages` |
| API version header | `2023-06-01` |
| `anthropic-beta` headers | **none** — asserted absent from executable code |

The endpoint matters as much as the model: `/v1/messages/batches` is a different endpoint with
different pricing, and a beta header is the mechanism by which an unpriced feature arrives.

## 2. Model — frozen to exact ids

| alias | resolves to |
|---|---|
| `fast` | **`claude-haiku-4-5-20251001`** — the only model the live-model procedure authorizes |
| `balanced` | `claude-sonnet-5` |
| `deep` | `claude-opus-4-8` |

No alias resolves to anything containing `latest`, which is asserted: a moving target cannot have
frozen pricing, because the model that runs tomorrow would not be the one priced today.

## 3. Pricing — frozen, per million tokens

| model prefix | input | output |
|---|---|---|
| `claude-fable-5`, `claude-mythos-5` | $10.00 | $50.00 |
| `claude-opus-4` | $5.00 | $25.00 |
| `claude-sonnet` | $3.00 | $15.00 |
| `claude-haiku` | $1.00 | $5.00 |
| **anything unrecognised** | **$5.00** | **$25.00** |

Two properties are asserted rather than stated:

- **An unpriced model is estimated at the opus tier, not the cheapest.** The direction of that
  fallback is the safety property — a cheap default would under-hold for an expensive model, which
  is the one way this arithmetic loses money.
- **Output is dearer than input at every tier.** The ceiling is *exact* on the output side (the
  request sends `max_tokens`) and an *estimate* on the input side; that asymmetry only helps if the
  expensive half is the exact one, and it is.

## 4. Permitted request features — exactly four fields

`buildRequestBody` is the **only** function that constructs a request body, and the test asserts
`max_tokens:` is assigned in exactly one place in `llm.js` and that the `fetch` sends the object
that function returned. The body is:

```
model · max_tokens · messages · system   (system omitted when absent)
```

with exactly one message, whose only keys are `role` and `content`, and whose `content` is a
**string** — not a block array, because block arrays are how images, documents and `cache_control`
enter a request.

### What is disabled, and why each one is a hole in the ceiling

The spend ceiling is `maxInputTokens(buildRequestBody(...))` — a function of the request's **text
length**. Every billed feature that is not a text input token is therefore unbounded by it:

| disabled | why it would break the ceiling |
|---|---|
| `tools`, `tool_choice`, server-side tool use | billed, and the tool definitions are themselves input the ceiling never saw |
| prompt caching (`cache_control`) | a cache **write** costs more than ordinary input |
| extended thinking (`thinking`) | thinking tokens are billed as output, beyond `max_tokens`' accounting |
| images, documents | priced by pixels and pages, not by bytes |
| `stream: true` | not billed itself, but it moves where usage is reported — and usage is what settlement reconciles against |
| Batches API | different endpoint, different pricing |
| `web_search`, `code_execution`, computer use | each a separately metered server-side tool |
| `citations`, `service_tier` | change what is billed and how |

Each is asserted absent from executable code, with comments stripped first (the reasoning above is
*in* those comments, so a scanner that cannot tell a comment from a field would be measuring prose)
and with a **control** that plants each pattern and confirms it fires — otherwise a pattern that
simply never matched anything would look like a pass.

## 5. Provider-side spending controls — **not established, and I will not claim otherwise**

The owner asked that this be *documented*. The honest documentation is that **I have not established
whether Anthropic's Console spending controls are hard limits**, and here is exactly why and what
would settle it.

What I checked (2026-11-26): Anthropic's **Spend Limits API** documentation. It does what the name
suggests — per-member limits, period-to-date spend, increase requests — but its own page states it
is *"available to Claude Enterprise organizations only. It is not available to Claude Platform
(Claude Console) organizations."* PlaybookOS calls the Platform API with an `ANTHROPIC_API_KEY`, so
**that API is not the control that would apply here.** The documentation I read describes members
being *"blocked"* when they reach a cap, which is suggestive and is about a different product; a
suggestive sentence about a different product is not evidence about this one.

So the state is:

- **Unknown:** whether a Console organization's spend limit *rejects requests* at the threshold, or
  only notifies. The language in a dashboard ("limit" vs "alert") is not reliable on this point —
  Railway's own controls, checked the same day for the cloud worker, turned out to be **one of each**
  under similar names.
- **What would settle it:** the Console's billing settings read directly, and the behaviour at the
  threshold confirmed from Anthropic's own documentation for *Platform* organizations. Both need the
  owner's account.

**What this means for the live-model exercise:** its $2.00 ceiling and 20-call bound must be treated
as resting on **our own** controls — the per-objective budget, the company and platform daily caps
(B3.14), and the pre-call hold — and **not** on a provider backstop whose behaviour nobody has
verified. That is the conservative reading and it is the one the design already takes. It also means
the unverified provider control is **not** one of the reasons the exercise is safe, and should not
be listed as one.

### And the standing constraint, restated

**A conservative estimate is not a proven maximum charge, and post-call accounting does not prevent
an overspend.** The ceiling above is an *argued* estimate on its input side. The only thing that can
turn it into a measured one is **B3.15** — the per-call `held vs measured` reconciliation against
the provider's own reported usage, with the inequality as an abort condition — and **B3.15 has not
run.** Until it has, no figure in this document is a proven bound on what a call can cost.

## 6. What remains before paid execution could be proposed

| | state |
|---|---|
| Provider, model, pricing, features frozen | **done** (this document, enforced by the test) |
| Unaccounted features disabled | **done**, structurally, with controls |
| Aggregate concurrency across objectives and companies (B3.14) | **done** — `check-aggregate-spend-concurrency-db.js`, 12 assertions |
| Provider-side control characterised as hard or soft | **OPEN** — needs the owner's Console |
| Held vs measured reconciled against provider usage (B3.15) | **OPEN** — needs one paid call, which is not authorized |
| Model-generated proposals cannot expand authority | **OPEN** — Priority 5's remaining item |

The last three are not mine to close alone. Paid execution stays unauthorized until the owner
approves the completed procedure.
