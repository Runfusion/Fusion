---
title: "A card that vanishes before the detector exists is never reported, and the report has no owner but the operator's mailbox"
date: 2026-10-16
category: reliability
problem_type: reliability
module: "@fusion/engine / @fusion/core"
component: self-healing / notification / run-audit
tags:
  - vanished-task
  - run-audit
  - mailbox-alerting
  - soft-delete-tombstone
  - cadence-gate
  - rufu-225
  - rufu-282
  - rufu-283
  - rufu-436
symptoms:
  - "a card vanished from every board read and `task:vanished-approved-work` produced no actionable outcome for it"
  - "`fn_task_show` cannot resolve the id while `.fusion/tasks/<ID>/task.json` is still on disk"
  - "an operator asks which agent is supposed to start the salvage after a vanished-work notice and no code path answers"
root_cause: "RUFU-282's row stopped being written 7 h 48 m before `reconcile-vanished-task-dirs` existed, and by the time the sweep could look, the id was accounted for by a table — the class the detector is designed to stay quiet about (or record audit-only). The residual gap is not detection but ownership: the finding's only consumer is the operator's dashboard mailbox."
resolution_type: documentation_and_test
---

## The two questions RUFU-436 had to answer

1. Why did `reconcile-vanished-task-dirs` produce no actionable outcome for RUFU-282, when RUFU-283
   built exactly the detector for that state and RUFU-282 is the card RUFU-283 opened to salvage
   RUFU-225?
2. After a `task:vanished-approved-work` row lands, **who** starts the salvage?

The first answer is a timeline plus a presence fact, both measured. The second answer is uncomfortable
and is stated in [Who starts the salvage](#who-starts-the-salvage) rather than softened.

## Measured evidence

Everything below was read-only. No board row, mirror, branch, or database was written.

| Evidence | Measured value | Source |
| --- | --- | --- |
| RUFU-282 mirror exists on disk | `.fusion/tasks/RUFU-282/task.json` | direct read |
| Mirror `column` | `todo` | mirror |
| Mirror last write (`updatedAt`) | `2026-09-23T19:52:32.384Z` | mirror |
| Mirror gate rows | one: `plan-review` → `passed`, verdict `APPROVE_WITH_NOTES`, `reviewKind: plan`, `verdictRequired: true` | mirror |
| Mirror's own last log line | CEO-triage premise falsified: RUFU-225 was back on the board and `fusion/rufu-225` still existed | mirror |
| `fusion/rufu-282` | does not exist (`git rev-parse --verify` fails) | git |
| Detector landed on `main` | `de0b9a38563a2c87d197de19870c206771d3843d` — RUFU-283, authored `2026-09-24 05:40:12 +0200` = `2026-09-24T03:40:12Z` | git |
| Deployed daemon at measurement | `0.78.0-beta.7`, `/api/health` `uptime: 19120 s` (≈5 h 18 m), `engine.available: true`, `database.healthy: true` | live health probe |
| Sweep registration | maintenance batch 1 only (`name: "reconcile-vanished-task-dirs"`, `packages/engine/src/self-healing.ts`); **no startup leg** | code |
| Cadence | shares `GIT_WORKTREE_CHURN_INTERVAL_MS = 60 * 60 * 1000`; `lastGitWorktreeChurnAt` starts at `0`, so the first tick after start is due; the stamp advances only while un-paused | code |
| Exhaustive row-less census in production | 18 ids, all from projects `gedapp`/`stash`; **no id from the `fn` project**; recorded 2026-10-15T23:58Z | RUFU-690 task log |
| RUFU-225's salvage | delivered as `62804b4340` on `fusion/rufu-293` by RUFU-294 (`Done`, 8/8 steps); not yet an ancestor of `main` | git + board |
| The cited evidence id `985c1d18` | **not a git object in this repository** — it resolves in the audit/message store, which no agent tool reads | git |

## What the detector actually reports for RUFU-282's evidence today

This is pinned as an executable diagnostic, not prose:
`packages/engine/src/__tests__/vanished-approved-work-diagnostic.test.ts` runs the real
`detectVanishedTaskDirs` with its real `git rev-list` branch probe against a throwaway repository, over
the mirror shape above. Three results matter:

- **`state-unresolved`, not "lost"**. The card never executed, so `fusion/rufu-282` was never created,
  so the probe answers `null` (`rev-parse --verify` first — `rev-list --count <missing-ref>` exits 0
  with `0`, which would read as "no work at risk"). `unmergedCommitCount: null` and the reason is
  `state-unresolved`.
- **`gateApproved: true`**. `hasApprovedReviewGate` delegates to `requiresAuthoredReviewVerdict`, which
  is true for *any* authored review kind — `reviewKind !== undefined || verdictRequired === true` — not
  only for content review. The plan-review row satisfies it. The premise carried into this task ("a
  plan-only card cannot show an approved gate") is **refuted**; a card with zero code review is reported
  with salvage priority.
- **`salvageTarget` names a ref that does not exist.** The salvage block is always
  `taskBranchRefFor(taskId)`, so the notice's paste-able `git log main..fusion/rufu-282 --oneline` fails
  for exactly the classes where it is least useful (`state-unresolved`,
  `row-tombstoned-branch-unprobed`). The test asserts `git rev-parse --verify` fails on the target while
  a control card's target resolves.

## Timeline — the ordering that answers question 1

```
2026-09-23T19:52:32.384Z  RUFU-282's mirror is written for the last time (column todo)
2026-09-24T03:40:12Z      RUFU-283's detector reaches main (de0b9a3856)          +7 h 48 m
                          …and the sibling record states the deployed daemon still predated it
                          until the operator restarted Fusion
```

The card disappeared **before the code that could notice it existed**. `reconcile-vanished-task-dirs` is
a standing alarm over state, not a time machine: it can only classify what it finds on a later pass.

## Candidates, and which survive

| Hypothesis | Deciding artifact | Verdict |
| --- | --- | --- |
| The sweep is broken / never runs | code + live health: maintenance batch 1, churn gate due at startup, daemon up 5 h 18 m ≈ ≥5 due windows; RUFU-437 measured 42 rows/30 min on the `saneca` project | **Refuted as a general claim** for the running build |
| RUFU-282 is row-less and the sweep missed it | the only exhaustive census of row-less findings in production (RUFU-690, 2026-10-15T23:58Z) lists 18 ids, none from `fn`, while RUFU-282's mirror is provably still on disk | **Refuted** — if the id were row-less today, the current build would have named it |
| Presence said "accounted for", so silence is by design | `classifyVanishedTaskDir` returns `null` for `liveRowExists` and for `inArchive`; the diagnostic pins both for this exact mirror | **Survives** — and is the mechanism |
| It is a soft-delete tombstone: recorded, deliberately never announced | RUFU-690 gated the notice: `row-tombstoned-branch-*` writes the run-audit row and suppresses the mailbox message (the ungated version produced ~700 notices/day) | **Survives as the most probable shape** (`fn_task_show` resolves nothing in any lane, which is what a tombstone looks like from an agent session) |
| `gateApproved` was false, so it was low-priority | the diagnostic: an authored plan-review verdict satisfies the predicate | **Refuted** |
| The salvage target pointed at a real branch that got cleaned up | `fusion/rufu-282` does not exist and never did (no execution) | **Refuted** |

### Verdict (bounded)

**(a) Nothing was missed at the moment of loss:** the card's row stopped being written 7 h 48 m before
the detector existed, and the deployed build predated the detector until a restart, so no working
detector ever watched RUFU-282 vanish. **(b) Nothing is being missed now:** the one exhaustive row-less
census in production contains no `fn` id while RUFU-282's mirror is still on disk, which places the card
in the accounted-for classes — live-hidden, archive-owned, or (most likely) a soft-delete tombstone
whose notice RUFU-690 suppresses on purpose. "No notice arrived" and "nothing was wrong with it" are
therefore both true, and the absence of a notice is *not* evidence of a silent detector.

**Still unproven from an agent session, and named so it is not mistaken for settled:** which of the
three presence answers applies to `RUFU-282`, and whether `run_audit_events` holds a row targeting
`task:rufu-282` for the 2026-09-24 → 2026-10-15 window. Both need production SQL or a bearer token.
`/api/messages/inbox` answers `{"error":"Unauthorized","message":"Valid bearer token required"}`, only
`/api/health` is exempt from auth (`packages/dashboard/src/server.ts`), the project's PostgreSQL
credentials are outside agent containment, and `985c1d18` is not a git object. This is the same boundary
that made RUFU-225's presence state unprovable (`vanished-task-directory-rufu-225.md`); the operator
query that closes it is:

```sql
select created_at, agent_id, target, metadata
from run_audit_events
where mutation_type = 'task:vanished-approved-work' and target in ('task:RUFU-282', 'task:RUFU-225')
order by created_at;
```

## Who starts the salvage

**Nobody in code.** The producer is `detectVanishedTaskDirs`
(`packages/engine/src/notification/vanished-task-detection.ts`), and its complete consumer set is:

1. one `task:vanished-approved-work` run-audit row (`target: task:<ID>`), readable only through a
   durable agent's heartbeat run route or direct SQL — no executor, triage, or planner tool reads it;
2. one mailbox message with `toId: DASHBOARD_USER_ID`, i.e. **the human operator**, idempotent per
   `(taskId, reason, 6 h)` bucket.

The sweep creates no task, assigns no agent, sets no owner, and performs no column, status, step, or
branch write (by design — report-only). So the honest answer to "who must start the salvage" is: **the
operator, if they read Mailbox.** If they do not, the only escalation is a re-announce into the same
mailbox on the cooldown clock — pinned by the diagnostic's third case, which shows the notice re-arming
in the next bucket while the finding's ownership stays exactly as empty as it was in the first.

## Why this card's salvage turned out to be empty anyway

RUFU-282 owned the salvage of RUFU-225's three unmerged commits. Its own mirror records that its premise
was falsified at CEO-triage time (RUFU-225 was back on the board, the branch still existed), and the work
was later delivered by RUFU-294 as `62804b4340` on `fusion/rufu-293`. Even a perfectly-timed 2026-09-24
notice would have said: `git log main..fusion/rufu-225 --oneline` → 3 commits — the same sentence RUFU-283
already published in its own record. The missing report had nothing to contribute; **the missing consumer
did.**

## Do not conclude

- **Do not "fix" the silence.** Live-row and archive-owned presence returning no finding is correct: an
  archived card whose mirror and branch survive is normal history, and a card on a lane a query did not
  show is not lost. Making those classes alarm re-creates RUFU-690's ~700 notices/day.
- **Do not read `state-unresolved` as "work is lost"** — it means the state is unknown. It is also the
  label RUFU-690 had to reserve for ids no table holds; do not widen it back.
- **Do not resurrect the id before salvaging.** `deleteTask(id, { allowResurrection: true })` hard-deletes
  the tombstone *and* the branch (`cleanupTaskBranchForHardDelete`, `strategy: "force"`).

## Follow-ups this record argues for

- Give the finding an owner: a vanished-work notice should carry a work item (a card or an insight), not
  just a mailbox line, or the detector's output stays operator-memory-only.
- Gate `salvageCommand` on evidence: emit the `git log main..fusion/<id>` hint only when
  `unmergedCommitCount` is a number, and say "no ref to salvage; recover from the mirror" for the
  `null` classes, so the notice never hands out a command that cannot run.
- Close the agent-side blind spot: an id-scoped read of `task:vanished-approved-work` (History line or a
  coordination tool) would let the next RUFU-282 forensics answer the presence question without operator
  SQL.
