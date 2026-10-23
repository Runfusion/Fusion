---
category: performance
module: packages/core/src/task-store/reads.ts
date: 2026-09-09
problem_type: performance
severity: high
applies_when:
  - "A heap profile attributes tens or hundreds of MB to `listTasksImpl` over a few minutes"
  - "An engine timer (triage poll, scheduler tick, gridlock sweep, lane-role sweep) re-reads the whole board every few seconds"
  - "`task_workflow_selection` or `workflow_prompt_overrides` dominate `pg_stat_activity` even though the overrides table is empty"
  - "A startup/slim list memo returns correct data but costs a full deep clone on every hit"
  - "A recurring full-board sweep moves megabytes per pass while reading none of the heavy `log` column"
component: task-store
tags:
  - performance
  - listtasks
  - derive-optout
  - memo
  - gc-churn
  - board-parity
  - listtasksderiveoptout
  - excludelog
related_components:
  - task_store
  - engine_scheduler
  - engine_triage
  - engine_gridlock
  - engine_project_engine
  - engine_hold_release
---

# `listTasks` derive opt-out, the shared startup memo, and the `excludeLog` shape (RUFU-201, RUFU-202)

## Symptom

A 240 s heap profile on a live 22-project instance attributed **281.9 MB of 592.9 MB live allocations**
to `listTasksImpl` — roughly 15% of all CPU, with **~19% of CPU inside the GC**. CPU was dominated by
work that no user could see: for every one of ~1313 rows, the read parsed ~30 jsonb columns *and*
computed nine-plus UI-only board signals, and the startup memo deep-cloned the entire array on every
hit via `JSON.parse(JSON.stringify(...))`. The memo's 2.5 s TTL was shorter than the ≥10 s intervals of
the timers that were paying for it, so those callers paid the derivation cost, then paid the clone
cost, and still never got a memo hit.

The same profile showed the two tables only the derivation block touches: `task_workflow_selection` at
**31.8%** and `workflow_prompt_overrides` at **41.7%** of all in-flight statements — and the overrides
table was **empty**. Every engine tick was querying a table with no rows in it to derive a badge nobody
read.

RUFU-202 found the second, dumber half of the same problem: the hold-release sweep read the whole board
once per scheduler pass and measured **avg 10 603 ms / max 159 805 ms** live, with `prefetch` ≈ 100 % of
the sweep and `evaluate` at 0 ms. It was not deriving anything useful at that point — it was transferring
the `log` column (~11 KB/row) for ~1300 rows it never read, which starved dispatch (`todo=11
inProgress=0`) and left 489 passes budget-truncated.

## Root cause

`listTasks` was written for the dashboard board feed, which renders badges, and it grew one derived
signal after another onto that path (10 in total today). Engine timers were calling the same function
— some of them with `slim: true`, which does **not** skip derivation — because it was the only board
read available. The derivation is the only producer of the selection/overrides reads, so the query load
was pure UI-signal work executed on headless paths.

## The three levers

1. **`derive: false` opt-out** (`ListTasksOptions`, `packages/core/src/task-store/reads.ts`). Skips the
   per-row derivation block *and* its pass-level feeders (settings read, merge-queue set, IR cache,
   selection prefetch, page-local column map). Keeps the SQL fetch, row parsing, the slim
   steps-from-PROMPT.md sync, and the `log: []` output shape. **Omitted means `true`** — the opt-out is
   always caller-opt-in, because the board feed must keep every badge it renders today.
2. **Frozen, shared memo entries.** A memo hit hands out the same frozen array and the same frozen row
   objects instead of deep-cloning. A hit performs zero per-task allocation. Callers that need to mutate
   copy locally — the freeze is deliberate and must not be weakened to satisfy a mutating caller.
3. **Mutation invalidation.** A task lifecycle event or a `task.json` write clears the memo, so
   correctness does not depend on the TTL alone.

## The `derive: false` field contract

An opted-out row carries **none** of these fields — not even as an own property with an `undefined`
value, so a consumer can never mistake "derived and found nothing" for "never derived":

`inReviewStall`, `stalePausedReview`, `inReviewStalled`, `stalePausedTodo`, `ageStaleness`,
`stalledReview`, `retrySummary`, `stallReason`, `reviewBypass`, `timedExecutionMs`.

`column` itself is a **persisted** field and stays present, which is why engine sweeps are safe to
convert. Review/WIP/Hold *lanes* on a custom board are lifecycle-resolved, not persisted; a converted
caller must not take a lane from a row field but resolve it by id with `resolveTaskLifecycleColumns`
(the engine sweeps that already do this are exactly the ones converted here).

## Memo semantics and the staleness ceiling

`TaskStore.STARTUP_SLIM_LIST_MEMO_TTL_MS` is **15 s**. Within one process, a mutation invalidates the
memo immediately, so the TTL is the fallback rather than the primary bound, and it takes two seams to
cover every mutation: the store's own `task:created` / `task:updated` / `task:deleted` listeners, plus
the unconditional invalidation inside `writeTaskJsonFileImpl` that every `task.json` write passes
through. The second seam is what covers `moveTask`, because a move emits `task:moved` — an event the
memo does not listen to — so the artifact write is the invalidator there (the complete-lane move arm
emits `task:updated` as well; a same-column handoff changes no row field and needs no invalidator).

The memo key carries every dimension that changes the **result shape** — archive scope (`all`/`active`),
column filter, `columns`, `excludeColumns`, `sort`, derived vs raw (`derive`), and live vs forensic
(`includeDeleted` → `live`/`deleted`). A snapshot is never handed to a caller whose requested shape
differs from the one that filled the entry. Soft deletion stamps the historical `archived` sentinel
column, so an `active`-scope read already hides tombstones through the column filter; the reads where
`includeDeleted` genuinely changes the payload are `includeArchived: true` ones (admin/forensic
surfaces, e.g. `?includeDeleted=true`), where only the live-row filter separates the two. Sharing one
entry across that pair would hand a board read a tombstone-bearing snapshot, or starve a forensic read
of the rows it asked for, for up to one TTL. Both fill orders are pinned by
`packages/core/src/__tests__/postgres/list-tasks-derive-optout.pg.test.ts`.

**Across processes there are no events** — a second engine/dashboard process writing the same database
can leave this process serving a snapshot up to 15 s stale. That is the accepted trade-off: every
converted caller is a timer that already tolerates a one-tick-old board, and the alternative (a shorter
TTL) reintroduces the miss storm that made the memo useless. A converted caller that cannot tolerate
15 s of staleness must pass `startupMemo: false` and keep its own fresh read.

`startupMemo: false` remains deliberate on the scheduler's two tick reads for exactly that cross-process
reason — not because in-process mutations can go unseen. They cannot: `updateTask` clears the memo through
the `task:updated` listener, and `moveTask` clears it through the `task.json` write seam; both arms are
pinned by tests. What no in-process mechanism can observe is a write from **another** process, and this
tick read gates `todo → in-progress` graduation, where a card a peer process already moved would mean a
double dispatch. That read therefore keeps its guaranteed-fresh read instead of inheriting the ceiling.

## The `excludeLog` read shape (RUFU-202)

`derive: false` removes the derivation and its feeder reads, but it does **not** shrink the SQL
projection: `log` is still selected, and on the live board it is the heaviest column at ~11 KB/row. A
full-board sweep therefore still moved ~14 MB per pass. `ListTasksOptions.excludeLog` drops that column
from the projection for a caller that provably never reads it.

It is **only effective alongside `derive: false`**. With derivation on, `log` is a derivation *input* —
`stalledReview` and `timedExecutionMs` are computed from log entries before any wire stripping — so
passing `excludeLog` with derivation on is a documented no-op rather than a silent badge regression
(`FNXC:TaskStoreReads 2026-07-05-15:30` is the incident that restored the log read for exactly that
reason).

**Use `excludeLog`, not `slim`, to shed the log column.** `slim` bundles the drop with
`finalizeSlimListTask`, which re-parses `PROMPT.md` for every task whose persisted `steps` is empty, via
the unmemoised `parseStepsFromPrompt` (one `existsSync` + one `readFile` per such task, per call). It
also blanks `prInfo`/`prInfos`/`issueInfo`/`sourceIssue`/`attachments`/`review` and can newly populate
`steps`. A bandwidth change must not be able to shift a release decision, and a timer sweep that never
reads `steps` has no business paying for that parse.

Two rejections worth repeating:

- **`excludeColumns: ["log"]` is not a column projection.** `ListTasksOptions.excludeColumns` filters
  board **lanes**, and setting it also switches off `listTasksImpl`'s `excludeColumn: "archived"`
  narrowing — which puts archived cards back into a release-decision pass.
- **Widening the gate to every opted-out read is wrong too.** `project-engine.ts`'s
  `listTasksInLaneRoles` is deliberately non-slim *and* `derive: false` because `canMergeTask` →
  `hasAutoHealableVerificationBufferFailure` reads `task.log`. The drop must stay per-call-site and
  explicit.

The startup memo needs no key extension: it is gated on `slim`, so a non-slim `excludeLog` read can
never enter it, and for slim-eligible shapes the effective decision depends only on `derive`, which is
already a key component.

## Converted call sites and their field-read audit

Every conversion names the fields its consumers read inside its own `FNXC:ListTasksDeriveOptOut` comment.
The rule for accepting a conversion: no field any consumer reads may be one of the ten derived signals.

| Site | Consumers read | Note |
| --- | --- | --- |
| `triage.ts` admission-provider refresh | id, column, status, paused/userPaused, priority, dependencies | planning admission |
| `triage.ts` per-column sweep | id, column, status, priority, createdAt | planning sweep |
| `triage.ts` poll/discovery read | id, column, status, paused, dependencies | `discoverReadyPlanningTasks` |
| `scheduler.ts` both tick reads | id, column, status, paused, priority, dependencies | `startupMemo: false` retained: the graduation gate will not inherit the cross-process ceiling described above |
| `healing/gridlock-detector.ts` sweep | id, column, paused, nextRecoveryAt, sliceId, worktree, workspaceWorktrees, dependencies, deletedAt, noCommitsExpected, sourceMetadata, priority, createdAt | settings come from the sweep's own `getSettings()` call, so the derivation block's internal fast read is not needed |
| `project-engine.ts` `listTasksInLaneRoles` | id, column, status, paused, prInfo, reviewState, steps, workflowStepResults, enabledWorkflowSteps, mergeRetries, mergeDetails, log, autoMerge(+provenance), branchContext, repositoryScope, updatedAt | stays **non-slim**: `canMergeTask` → `hasAutoHealableVerificationBufferFailure` reads `task.log`, and slim sets `log: []`. Keeps the log, so **no** `excludeLog` either |
| `execution/hold-release.ts` full-board sweep (RUFU-202) | column, status, paused/userPaused/pausedReason, nextRecoveryAt, columnMovedAt, dependencies, enabledWorkflowSteps, workflowStepResults, approvedPlanFingerprint, prompt, title, description, timestamps | `derive: false` **+** `excludeLog: true`. Reads neither `log` nor `steps`, and none of the 14 `@fusion/core` helpers it calls with a task touches `task.log`, so the log column is pure transfer cost here |

The gridlock sweep additionally resolved every card's lifecycle **twice per pass** (once per
classification loop). Each uncached resolution re-issued a live workflow-selection read and re-ran
non-memoized column resolution, so a pass of N cards cost 2N of them. Both loops now share one eagerly
built, id-keyed map — which also removed a way for the two loops to disagree when a selection write
landed between them.

## Verification

`packages/core/src/__tests__/postgres/list-tasks-derive-optout.pg.test.ts` pins the contract against a
seeded PostgreSQL store: zero derivation-boundary calls and zero selection reads under
`derive: false`, non-zero and unchanged under the default options, reference-identical frozen rows on a
memo hit that additionally issues zero further derivation reads, and memo invalidation inside the TTL by
both arms — the `task:updated` event and a lane move — so neither the TTL nor a single invalidation seam
is load-bearing on its own. The tests assert state changes within the TTL window and never sleep or
poll, so the whole file runs in seconds.

The same file pins the `excludeLog` shape: the seeded row's SQL projection genuinely lacks the column
(checked on the parsed row keys, not just the `log: []` output), a non-slim `excludeLog` read performs
**zero** `parseStepsFromPrompt` calls even though the card has empty persisted `steps` and a parseable
`PROMPT.md` (the parse count is asserted against a control call that proves the file resolves),
`excludeLog` alongside derivation keeps the log column so no badge can break, and archived cards stay
off a lane-filterless `excludeLog` read.

### Measured before/after (RUFU-202)

`packages/engine/src/__tests__/hold-release-sweep-bench.pg.test.ts` (opt-in: `FUSION_HOLD_RELEASE_BENCH=1`)
seeds the deploy's shape — **4,791 cards**, ~11 KB of activity log per row, 2,911 held candidates covering
every release strategy — and measures the two shapes 20 times each against a PostgreSQL 16 server
(2026-09-09):

| Read shape | avg | p50 | p95 |
| --- | --- | --- | --- |
| pre-change (`derive` on, `log` fetched) | 2 121 ms | 2 050 ms | 2 761 ms |
| `derive: false` alone (the RUFU-201 half) | 514 ms | 502 ms | 656 ms |
| **shipped** (`derive: false` + `excludeLog: true`) | **252 ms** | 247 ms | 271 ms |

**8.4x on the read**, against a 2x acceptance gate, and the log drop is worth slightly more than the
derivation opt-out — which is what the live attribution said (`prefetch` ≈ 100 % of the sweep). Whole-sweep
medians moved **4 795 ms → 2 741 ms**, with release decisions byte-identical on all 30 passes (the bench
gates on that equivalence, plus canaries that assert each release strategy still refuses for its real
reason — otherwise an all-releases board would make equivalence trivially true).

Two honesty notes, both encoded in the bench:

- Whole-sweep wall time is **not** the ratio gate. Most of a pass is per-candidate evaluation that both
  read shapes pay identically, and on a container its spread (p50 2 741 ms / max 10 131 ms) is wider than
  the difference being measured. Gate the read; report the sweep.
- The container's sweep never reached the deploy's 10 s budget, so the bench asserts the budget claim as
  **read headroom**: the slowest shipped read (p95 271 ms) costs less than a typical pre-change read
  (p50 2 050 ms). The production-budget pass stays in the report and fires on any host that does
  reproduce deploy-scale latency (`FUSION_HOLD_RELEASE_ROWS`).

Reset discipline matters more than it looks: the per-pass board reset has to be written as
`... WHERE id IN (...) AND ("column" IS DISTINCT FROM '<lane>' OR ...)`. Rewriting all ~4 800 rows back to
their seeded lane every pass leaves that many dead row versions behind, the next pass's board scan then
reads mostly dead tuples, and the measurement becomes a function of autovacuum timing — an earlier draft
of this bench reported the pre-change and shipped sweeps as equal on a board whose reads differed by 1.7 s.

Local run (the harness needs a PostgreSQL it may create databases in — the dev box's `localhost:5432`
role is `admin-ddl-denied`, so use the dedicated test server):

```bash
export FUSION_PG_TEST_URL_BASE=postgresql://localhost:25432
pnpm pg:test:up -- --port 25432
pnpm --filter @fusion/core exec vitest run \
  src/__tests__/postgres/list-tasks-derive-optout.pg.test.ts --silent=passed-only --reporter=dot
pnpm pg:test:down -- --port 25432
```

Note: a skipped `pgDescribe` block is **not** PostgreSQL verification evidence — see `docs/testing.md`.

## In-flight coalescing of identical board reads (RUFU-627)

The memo answers one process shape: a short-lived CLI that reads the board a few times at startup
(`!store.isWatching && slim`). The production growth is the opposite shape — a long-lived server whose
`isWatching` is true, where scheduler sweeps, admission snapshots and board polling each parse the whole
board, ~0.58 GiB per parsed 2 417-row board. RUFU-627 adds the mechanism that gate cannot reach.

| Mechanism | Lives for | Gate | Consults `isWatching` | Invalidation |
| --- | --- | --- | --- | --- |
| `startupSlimListMemo` | one TTL (15 s) | `!isWatching && slim`, non-paginated | yes | TTL + `clearListReadCaches()` |
| `listReadInFlight` | exactly as long as the fetch | non-paginated, slim or full | **no** | `clearListReadCaches()`, entry dropped in `finally` |

Both build their key from the same helper, `listReadShapeKey`, whose six dimensions are the memo's:
`includeArchived`, `column`, `columns`, `excludeColumns`, `sort`, `derive`, `includeDeleted`. That
shared helper is the point — a key built twice is how the RUFU-201 tombstone collision happened.

**Why there is no TTL on the in-flight map.** A TTL makes a shared read serve stale state. An entry lives
exactly as long as the fetch it represents, so a joiner gets the same bytes the starter was already
going to get. `clearListReadCaches()` (which `clearStartupSlimListMemo()` now delegates to) drops the
entry on every `task:created|updated|deleted`, and dropping an entry never cancels the fetch — it only
stops *later* callers from joining. That is the whole correctness argument and it is the mutation test:
a caller that starts after a committed write re-issues and sees the write, while a caller already joined
resolves with the snapshot it joined.

**Read shapes that must not share.** Paginated and keyset reads (`limit`, `offset`, `afterCreatedAt`,
`afterId`, `afterQueueKey`, `afterIntakeKey`) are excluded by the gate, not by becoming key dimensions —
the shape key does not describe a page, so a promise keyed by it would serve one page to a caller that
asked for another. Callers that must observe their own just-committed write pass `coalesce: false`:
the planning claim-recovery lookups (`planning.ts`, `register-planning-subtask-routes.ts`), signal-delivery
dedupe (`register-signal-routes.ts`), and the GitHub import dedupe probes.

**A shared board is frozen.** One array is handed to N consumers, so it is `Object.freeze`d at fill, like
the memo's snapshots. A caller that wants to sort, reverse or splice copies first
(`[...rows].sort(...)`); it must not be served by unfreezing the shared rows.

## Do not

- Do not default `derive` to `false`, and do not convert a dashboard/API board-feed caller. Board parity
  is the hard constraint.
- Do not unfreeze memo or coalesced rows to silence a `TypeError` from a mutating caller — copy the array.
- Do not give `listReadInFlight` a TTL, and do not coalesce a paginated or keyset read.
- Do not add a caller to the converted set without writing its field-read audit in its own FNXC comment.
- Do not pass `excludeLog` as a way to shed the log column *while still deriving*. It is ignored, by
  design; the badges would silently go empty instead.
- Do not reach for `slim: true` when all you want is the log column dropped — `slim` adds a per-task
  PROMPT.md parse and blanks fields the caller may still be reading.
- Do not treat `ListTasksOptions.excludeColumns` as a column projection. It is a lane filter, and it
  disables the `archived` narrowing.
