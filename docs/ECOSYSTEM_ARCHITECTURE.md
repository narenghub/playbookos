# Abiozen Group — Ecosystem Agent Layer

Engineering reference for the cross-product agent architecture. Read this before touching the
ecosystem/MCP/community work. It records decisions already made — not options.

> **One-line model:** PlaybookOS hosts the agents and orchestrates every product over MCP.
> Products expose servers and emit events; they never talk to each other.

---

## Portfolio

| Product | What it is | Shape | Monetization |
|---|---|---|---|
| **PlaybookOS** | Internal ops platform, agent host, MCP orchestrator *(name temporary)* | Hub | — |
| **Abiozen** | Live pharma API marketplace (buyers/suppliers) | Two-sided marketplace | Transaction revenue |
| **AROS** | Regulatory compliance OS for life science | **Multi-tenant enterprise** (outlier) | Subscription |
| **GolfNex** | Booking ecosystem for golf facilities | Two-sided + community | Subscription + bookings |
| **Favly** | Booking ecosystem for service businesses | Two-sided + community | Subscription + wallet |
| **Adifice OS** | Recruiting marketplace (employers/agencies/candidates) | Two-sided + community | Tiered subscription |

**Structural read:** GolfNex, Favly, Adifice are **the same shape** — two-sided subscription
marketplace + community feed. Build one well, the other two are configurations. **AROS is the
outlier** (multi-tenant enterprise). **Abiozen is transaction, not subscription.**

---

## Plug-in contract — four interfaces

Every product implements these to join the ecosystem.

1. **Identity assertion** — accepts tokens from a shared identity service; **keeps its own
   authorization**. (Identity is federated; authz stays local to each product.)
2. **Event emission** — signed webhook to PlaybookOS, one **abstract vocabulary for every
   product**:
   `subscriber.created`, `subscriber.changed`, `revenue.recorded`, `supply.listed`,
   `demand.matched`, `support.requested`, `community.signal`
3. **MCP server** — four tool families: **query, act, publish, notify**.
   - **Every tool call carries a tenant scope**, even where it's currently constant.
     Retrofitting tenant scope later is a **breaking change across all agents** — do it from day one.
   - **Every spending or externally-visible tool is separately declarable** — same
     `cost` / `spend` / `dangerous` model as [`src/lib/permissions/registry.js`](../src/lib/permissions/registry.js).
4. **Community source declaration** — sources, taxonomy, segments, review mode.

---

## MCP topology

- PlaybookOS is the **MCP client and orchestrator**. Each product runs an **MCP server**.
- **Agents live in PlaybookOS** and reach outward.
- **Products NEVER call each other.** All cross-product coordination routes through PlaybookOS.
- **Per-product credentials, never shared.**

```
              agents
                │
         ┌──────┴───────┐
         │  PlaybookOS  │  ← MCP client / orchestrator
         └──────┬───────┘
    ┌─────┬─────┼─────┬─────┬──────┐
  Abiozen AROS GolfNex Favly Adifice   ← MCP servers (no lateral calls)
```

---

## Key insight — the community layer already exists

The **Clinical Demand Intelligence agent** ([`src/lib/agents/research-intelligence/`](../src/lib/agents/research-intelligence/))
is already the community-pipeline prototype. Generalized, the pipeline is:

```
ingest(source) → classify(LLM) → filter → compose → review → publish → amplify → measure
```

The community layer for GolfNex/Favly/Adifice is **this existing build with four configurations —
not four new builds.**

---

## Build sequence

| # | Item | Notes / dependencies |
|---|---|---|
| **E0** | **Event ingestion** — extend the existing webhook path to accept a `product` field + multiple sources | **ONLY launch-critical item.** Days of work. |
| **E1** | Shared identity service | Interface 1 backing |
| **E2** | MCP layer in PlaybookOS | **BLOCKED on permissions cutover completing** |
| **E3** | GolfNex MCP server | First product server |
| **E4** | Community pipeline generalized | GolfNex as first config (see Key insight) |
| **E5** | **AROS tenant middleware** | **INDEPENDENT, longest lead — can start now.** Blocks E6 **and** blocks selling AROS to a second customer. |
| **E6** | AROS MCP server with tenant scoping | Needs E5 |
| **E7** | Generalize | Reconcile what GolfNex and AROS each forced |
| **E8** | Favly + Adifice servers | After the contract is corrected (E7) |
| **E9** | Launcher | Needs E1 + two products on Interface 1 |

**Critical-path starters today:** E0 (launch-critical) and E5 (longest lead, independent).

---

## Rules

- **Generalize after the SECOND implementation, not before the first.**
- **Do not build four MCP servers in parallel** — the second is where the contract gets corrected.
- **Do not build the launcher first.**
- **Do not start E2 while the permissions cutover is in flight.**
- **Human-in-the-loop on anything published externally.**
- **Never-throws contracts on every module.**
- **Per-product spend budgets before any agent runs autonomously.**

---

## Open questions (unanswered)

| # | Question |
|---|---|
| Q1 | Which product launches first, and when? |
| Q2 | Do GolfNex / Favly / Adifice have APIs today? |
| Q3 | Will AROS tenants reach the agent layer, or operator-only? |
| Q4 | Who owns the identity service — inside PlaybookOS or standalone? |
| Q5 | One team building all four MCP servers, or per-product engineers? *(Most changes the plan.)* |
| Q6 | Monthly agent budget per product? |
