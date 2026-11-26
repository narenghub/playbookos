# B4.7 — The 72-hour continuous reliability run

**Status: PREPARED, NOT RUN.** Nothing in this document authorizes anything, and three of its
prerequisites need the owner's hands.

Owner's Priority 6, second directive of 2026-11-25: *"Prepare the 72-hour continuous reliability run
after these prerequisites are verified."* B4.7's acceptance, restated by the owner's correction 3:

> **(a)** cloud continuity during iMac unavailability — this must NOT depend on solving unattended
> FileVault login, and is the part that gates platform continuity; **(b)** safe hardware-task
> queueing while no node is available; **(c)** recovery after an authorized login. 72 h, zero
> unexplained gaps.

---

## 1. Why there is a sampler at all

"Zero unexplained gaps" is a claim about a three-day period, and nobody is going to watch it.

It cannot be established from the application's own logs. **A process that dies writes nothing
about having died, and a log that simply stops is indistinguishable from a quiet period** — which
is the failure this run exists to detect. The only way to measure a gap is for something *outside*
the system under test to take a reading at a known interval and record the interval it actually
achieved.

`scripts/office-reliability-sampler.js` does that, and `scripts/check-reliability-sampler-db.js`
(14 assertions, in preflight) verifies the harness **before** three days are spent on it. Verifying
the harness first already paid: the sampler's summary line — the one line that reconciles samples
against expectations — was being lost to `process.exit` truncating a buffered write. Every sample
survived, so the file looked complete right up to the part a reader would use. In a 72-hour run that
would have cost the conclusion of the three days.

## 2. Prerequisites

### Verified in development (as of `be2e373`)

| Prerequisite | Evidence |
| --- | --- |
| The scheduler runs continuously and advances runs by itself | B3.16 — `check-running-scheduler-db.js`, the real `server.js`, four successive ticks to a terminal state |
| Every phase is exactly-once under concurrency and restart | B3.17 — `check-phase-idempotency-db.js`, nine boundaries |
| Every failure is truthful, bounded, or visibly escalated | B3.18 — `check-negative-paths-db.js`, ten paths |
| The briefing rests on measured records, with missing/stale/unavailable told apart | B3.19 — `check-operational-facts-db.js` |
| An operator can see worker liveness, objective status, money and refusals | B2.9 — `check-command-center-db.js`, 26 distinctions |
| Silence is noticed and alerts deduplicate, with no external notification | B4.5 — `check-monitor-db.js` |
| The evidence harness itself is correct | `check-reliability-sampler-db.js` |

### Owner actions, outstanding

1. **A development cloud worker service** (B4.2). Until one exists, *"cloud execution continues
   while the iMac is unavailable"* is untested — the governance half is done and no service runs.
   **Incremental Railway cost must be provided before provisioning.**
2. **`OFFICE_INITIATOR_ENABLED=true` and `OFFICE_MONITOR_ENABLED=true`** on that development
   service, plus a production STOP row for `office-scheduled-initiation`, `office-cycle-advance` and
   `office-monitor` (B1.13) so each can be halted by name.
3. **An active, supervised, funded objective** in the development database for the run to carry.
   Nothing starts without one, by design.

### Deliberately NOT prerequisites

- **Live model intelligence.** The run measures continuity, not planning quality. Zero provider
  calls, and the live-model procedure (B3.15) is a separate exercise with its own authorization.
- **Unattended FileVault login.** Per the owner's correction 3, part (a) must not depend on it.
- **PRPA.** Unresolved and unwaived, and unrelated to the office cycle.

## 3. The run

Interval **60 seconds**, duration **72 hours**, against the **development** deployment.

```sh
# On the operator's machine, against the DEVELOPMENT database only.
# It refuses NODE_ENV=production outright, permits a disposable test cluster by construction, and
# otherwise requires scripts/lib/db-identity.js to POSITIVELY identify the database as development.
# unidentified and cannot_tell are refusals. A read-only tool is still a connection to production.
node scripts/office-reliability-sampler.js \
  --objective <the active development objective id> \
  --interval-seconds 60 \
  --duration-hours 72 \
  --out ~/playnexa-evidence/b4-7-$(date +%Y%m%d).jsonl
echo $?        # read it: 0 = completed, 1 = stopped early or aborted, 3 = NOT EXECUTED
```

**Why 60 seconds and not 1.** Measured: one sample is a whole Command Center snapshot and costs
about **5 seconds** against a disposable cluster. At a 1-second interval the loop cannot keep up —
which the `intervalAchievedSeconds` field reports rather than hides. 60s gives 4,320 expected
samples over 72 hours and leaves the database alone between them.

Run it under something that survives a closed laptop (`tmux`, `screen`, or a systemd user unit). A
sampler that stops when the lid closes produces a gap in the *sampler*, which the file says, and
which is three days of ambiguity nobody needs.

## 4. What the evidence file contains

JSONL, appended per sample, so a crash loses at most the sample in flight:

- `run_started` — objective, resolved company, interval, duration, the deployed commit, and
  **`permittedBy`**: which rule allowed this database to be read. A three-day file that does not say
  which database it read cannot be audited afterwards.
- `sample` — per reading: every worker's status, kind and last **authenticated** heartbeat age; live
  capabilities; work by state and the blocked backlog; run states; open alerts with their
  occurrence counts; per objective held / measured / unresolved money; fact quality; and any
  unreadable section.
- `sampler_gap` — an interval more than 3× the configured one, **named as the sampler's gap**, which
  may or may not coincide with one in the office. A laptop that slept recorded nothing about the
  server; the samples either side are what say which.
- `sample_error` — a failed read. Not an abort: a sampler that quits on one blip loses the window.
- `abort` — see below.
- `run_summary` — samples against **expected** samples, gap count and maximum, terminal runs
  observed, distinct alerts, maximum unresolved exposure, sections ever unreadable, maximum
  scheduler heartbeat age, and the stop reason.

**The summary does not compute a verdict, deliberately.** *"Zero **unexplained** gaps"* has the word
unexplained in it, and explaining a gap is a human act: a sampler cannot know that the laptop slept,
that the operator restarted the service, or that Railway moved the container. The file gives the
figures; the verdict is a judgement made against them.

## 5. Abort conditions

The sampler stops itself on one condition, and it is deliberately the only one:

- **Unresolved financial exposure above zero.** A dispatched hold whose charge nobody has reconciled
  keeps counting with no window, and only a human can close it. Continuing would be collecting
  evidence about a system that should be stopped.

A sampler that aborts easily produces a two-hour file for a 72-hour question, so a failed read, an
offline worker, a blocked backlog and an open alert are all **recorded and survived** rather than
fatal.

Stop the run by hand (SIGINT / SIGTERM — the summary is still written) if any of these appear:
an objective completing with an open exception against it; a run in a terminal state being advanced
again; duplicate employee tasks or memory rows for one run; or any external communication at all.

## 6. Judging it

A pass needs **all** of:

1. `samples` within a few of `expectedSamples`, and every shortfall accounted for by a
   `sampler_gap` with a human explanation beside it.
2. `maxSchedulerHeartbeatAgeSeconds` under the monitor's silence bound (300s by default) for the
   whole run, except where an explained sampler gap covers it.
3. `sectionsEverUnreadable` empty, or each entry explained.
4. `maxUnresolvedExposureUsd` exactly 0.
5. Terminal runs observed > 0 — a continuity run during which nothing ever completed proves only
   that nothing crashed.
6. Alerts that opened also **closed** when their conditions cleared, and no alert duplicated.
7. Part (b): a hardware-required task enqueued during the run stays PENDING with its attempts
   unconsumed and appears in the blocked backlog for the whole period.
8. Zero provider cost rows and zero external messages for the whole window.

## 7. What this run will still not prove

- **That the office did anything useful.** It measures continuity. Whether the work was worth doing
  belongs to the acceptance criteria.
- **Production.** The run is against development, and nothing here changes the production posture:
  `main` is untouched and `email.send` stays stopped.
- **Part (c)**, recovery after an authorized login, which needs the iMac and a person at it. It does
  **not** gate part (a).
~~**A gap demonstrated end to end.**~~ **This is now measured, 2026-11-26.** The entry here used to
say an end-to-end demonstration was unavailable in this container because the clock advances with CPU
time and a SIGSTOPped sampler perceives nothing. True about the clock, wrong as a conclusion: the CPU
time is not the *stopped* process's. With a sibling burning CPU the clock moves, and
`check-reliability-sampler-db.js` section 2b now stops the real sampler, resumes it, and asserts the
**15-second gap it records**, with an undisturbed control run recording none and the run summary
carrying `maxSamplerGapSeconds`. The owner's *"validate the sampler's real wall-clock gap
detection"* is satisfied by a measurement rather than by a plan to measure later.

**Still worth doing once on the real machine**, because the instrument is the whole run: `kill -STOP
<pid>`, wait longer than `interval × gap-factor` **computed from the interval in force** —
`--interval-seconds` is clamped to a 5s floor, so asking for 1 gives a 15s threshold at the default
factor, which is the arithmetic error section 2b made first — then `kill -CONT <pid>`, and confirm a
`sampler_gap` line with roughly the right duration. If it does not appear, the continuity claim has
no instrument behind it and the run is pointless.
