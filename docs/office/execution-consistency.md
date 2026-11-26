# Execution consistency: what is exactly-once, what is not, and how long we wait

Owner's Priority 1, second directive of 2026-11-26. Verified by
`scripts/check-execution-consistency-db.js` (exit 0 = the properties below hold).

This document exists because "the cycle is exactly-once" is a sentence that would be **false**, and
the directive forbids it: *"Do not describe the entire cycle as exactly-once until the remaining
properties are established."* Three different things are held by three different mechanisms, and only
the first of them is exactly-once.

---

## 1. Durable state transitions — exactly-once

A **durable state transition** is a row that says something irreversible happened: a plan minted, an
outcome recorded, an employee task filed, a memory written, a run ended.

These are exactly-once, and the arbiter is the **database**, never a caller remembering to check:

| transition | what holds it |
|---|---|
| plan minted for a run | `office_plans` primary key, derived from the run id |
| plan step enqueued | `worker_tasks.intent_key` unique index |
| outcome recorded | `out-cycle-<runId>`, the `office_outcomes` primary key |
| validation escalated | `ex-cycle-<runId>`, the `office_exceptions` primary key |
| report escalated | `ex-report-<runId>` |
| employee task filed | `daily_tasks` primary key, derived from the run id |
| memory written | `uq_agent_memory_live` on (company, subject, live) |
| delegation created | `uq_agent_runs_intent_attempt` on the derived intent key |
| run ended | `agent_runs_transition_guard`: a terminal state and its `ended_at` are immutable |

A repeated attempt collides with a key and is treated as the success it is. Nothing here depends on a
lock, a transaction spanning two phases, or a process remembering what it did before it died.

### Ordering, not transactions

Where a phase writes two related rows, **the row that marks the phase complete is written last.**

`phaseOf` derives the current phase from durable rows, so one specific row is each phase's commit.
In VALIDATE that row is the outcome: the phase is over once an outcome exists. The escalation
therefore precedes it. This was the other way round, and a process dying in between left a detected
validation failure with a `partial` outcome, **no exception**, and the next tick moving on to REPORT —
a found problem turned into no problem by a two-millisecond window.

The ordering is the atomicity. Interrupted anywhere before the commit, the next tick re-derives the
same phase, re-writes the same rows under the same derived ids (no-ops), and then commits. A
transaction would add a second mechanism over the one that already works, and would have to be
unwound around the duplicate-key error a repeated tick produces.

REPORT follows the same rule: the terminal transition is its commit, and the employee task, the
memory rows and the escalation all precede it.

---

## 2. Execution attempts — at-least-once, by design

A **execution attempt** is a tick, a claim, a dispatch, a retry, a sweep. These repeat, and that is
the recovery mechanism rather than a defect in it. Every attempt is recorded in the append-only
event ledger.

**Counting attempts is not counting completions.** That confusion was a live defect: `finish` wrote a
`RUN_ENDED` event on every call, so a per-tick repeat appended one each time and any "completed runs"
figure taken over the event ledger over-counted a single completion. It also moved `ended_at`
forward with each tick, falsifying every duration and wall-clock-progress figure derived from it —
including the one the 72-hour reliability run measures. Both are now fixed: the event is written only
when the transition actually lands, and `ended_at` is write-once at the database level.

`finish` also now **reads the state back** and returns what the row says, with `alreadyTerminal` and
`intendedState` kept separately. It used to return the state it *computed*: finishing an
already-SUCCEEDED run with an error returned `PARTIAL` while the row said `SUCCEEDED`, and REPORT put
that straight into the briefing. The guard was intact in the database and the answer was wrong in the
caller's hand.

---

## 3. External effects — **not** established as exactly-once

An **external effect** is something that leaves the system: an email, a WhatsApp message, a supplier
contact, a payment, a provider API call.

**Nothing in this repository has established that an external effect cannot repeat, and nothing here
claims it.** Outbound transmission is under the production email STOP and no message has been
transmitted, so there is at present nothing to measure. B7's transmitted-message verification is the
work that would establish it, and until it does, the honest statement is the one in the heading.

### Therefore

> The cycle's **durable state transitions** are exactly-once. **The cycle is not.**

That sentence is the scope of the claim, and it is asserted by the check so it cannot quietly widen.

---

## 4. A guard is not a gate

`office/phase-guard.js` revalidates the company, the objective and the kill switch at **every**
non-terminal phase boundary. It closes the gap between one phase and the next — minutes or hours
apart, and previously nothing re-read the company's status at all.

It **cannot** close the gap between its own answer and the write a few milliseconds later. A company
suspended in that window passes the guard and the work is enqueued anyway. Re-checking immediately
before the write would narrow the window, not close it: no amount of re-checking makes a
check-then-act atomic — the same lesson B2.5b learned about budget, and the reason a spend hold is
taken inside the statement rather than before it.

So the database states it. `office/active-company-guard.js` installs a `BEFORE INSERT` trigger on
the two tables that represent **new work being created**:

- `worker_tasks` — enqueueing work for a worker
- `office_plans` — minting a plan, which is minting authorization to act

It is enforced however the insert arrives: from the cycle, from a route, from a caller nobody has
written yet, from a `psql` session. The phase guard remains, because an operator needs the phase to
refuse **by name** with an escalation rather than discover a raw constraint error; the trigger is what
makes the refusal true rather than likely.

Deliberately **not** guarded: `office_outcomes`, `office_exceptions`, `agent_memory`, `agent_runs`.
Those are the truthful record of what happened, and a suspended company is exactly when they must
still be writable — the whole answer to a withdrawn authorization is to open an exception and record
a terminal state. A trigger that refused those would make the system unable to write down that it had
stopped, turning a governed refusal into silence.

---

## 5. The waiting policy for an unavailable worker

When a dispatched step has no worker to execute it, the cycle sits in COLLECT. The policy is a
published decision, not an incidental constant:

| | |
|---|---|
| **Grace window** | **60 minutes** from the run's `created_at` — `PHASE_GRACE_MINUTES` in `office/cycle.js`, settable by `OFFICE_PHASE_GRACE_MINUTES` and clamped to 1–1440 so a typo cannot disable the bound in either direction |
| **Inside the window** | Wait quietly. Nothing is escalated. A worker arriving two minutes later is normal operation, not an incident. |
| **At the window** | **One** exception, `ex-wait-<runId>`, severity `high`, SLA 24h — the derived id makes it one alert however many ticks pass. |
| **After the window** | The run is deliberately left **alive**. The work is still wanted; what was missing is a human knowing it is stuck. |
| **Attempts consumed** | **None.** Waiting is not an attempt. A hardware-dependent task with no eligible worker stays `PENDING` and its retry budget is untouched. |
| **Who may shorten it** | `deps.graceMinutes`, which is fail-**safe** in the only direction it moves: a shorter window escalates *sooner* and cannot authorize a phase. The production cron passes none. |

The 60 minutes is a chosen number, not a derived one. It is long enough that the iMac worker being
logged out and back in does not raise an alert, and short enough that a morning's work is not lost
silently. There is no operating evidence behind it yet — the 72-hour reliability run is the first
thing that will produce any — and the only reason it is written down here is so that changing it is a
decision somebody makes rather than a constant somebody edits.

### Visible where?

- `office_exceptions`, which the Command Center page renders under **operational alerts**
- the run stays in the Command Center's **current execution phases**, in COLLECT, with its age
- `office/monitor.js` raises `WORKER_UNAVAILABLE` when no worker has heartbeated

### Not covered

- A worker that claims a task and then dies holds a **lease**, which is a different mechanism
  (`worker/leases.js` reaps an expired lease and returns the task to `PENDING`); that path consumes
  an attempt, because something was attempted.
- A worker that is present but lacks the capability is not "unavailable": the task stays `PENDING`
  with no eligible claimant and no attempt consumed, and this is the behaviour P3 must demonstrate
  for hardware-dependent work while the iMac is offline.
