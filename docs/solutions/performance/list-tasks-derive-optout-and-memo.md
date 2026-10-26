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

It WAS **only effective alongside `derive: false`**, and that gate is gone. With derivation on, `log`
had been a derivation *input* — `stalledReview`, `inReviewStall(ed)` and `timedExecutionMs` were
computed from log entries before any wire stripping — so `excludeLog` with derivation on was a
documented no-op rather than a silent badge regression (`FNXC:TaskStoreReads 2026-07-05-15:30` is the
incident that restored the log read for exactly that reason). RUFU-615 removed the reason: those five
figures are now maintained at WRITE time into `timing_total_ms` + `log_recent`
(`task-store/task-log-projections.ts`), so a deriving caller can ask for a `log`-free row and keep
byte-identical badges. `task-log-projections.pg.test.ts` proves the identity; `slim` now implies the
drop, and the `slim` veto that used to guard it was protecting a column nothing could read (`task.log`
is assigned `[]` on both slim paths, so no slim consumer could ever have observed an entry).

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

The startup memo needs no key extension for `excludeLog` on its own: it is gated on `slim`, and `slim`
implies the drop, so within the memo's gate the effective decision is constant. It did need the
dimensions RUFU-627 added — see the read-shape key section below.

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

Both build their key from the same helper, `listReadShapeKey`. Its first six dimensions are the memo's:
`includeArchived`, `column`, `columns`, `excludeColumns`, `sort`, `derive`, `includeDeleted`. That
shared helper is the point — a key built twice is how the RUFU-201 tombstone collision happened.

**The six were the memo's complete set, not the map's.** The memo's gate pins `slim` and it never sees
`compactBoardFeed`, so those two could not diverge inside it. The in-flight map has no such gate: it
coalesces slim and full reads alike, so the memo's key let an overlapping `{slim: true}` and
`{slim: false}` read share one promise and hand the joiner a row of the wrong shape (a `slim: false`
joiner of a `slim: true` fetch received `log: []` plus a `timedExecutionMs` it never asked for).
RUFU-627 found that while adding the `fields` dimension and fixed it in the same change: the key now
carries `slim`, the EFFECTIVE log decision (`excludeLog || slim`), `compactBoardFeed`, and the
canonical spelling of `fields`. The rule is now stated over the key itself instead of inherited from
the memo — **every dimension that changes the result shape is a dimension of this key** — and the memo
merely gains segments it cannot vary within its own gate. Paginated and keyset reads stay excluded by
the gate rather than becoming dimensions: a shape key cannot describe which page a promise holds.

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

## Declared field sets (`fields`) — RUFU-627

Coalescing removes duplicate parses; it does not shrink one parse. The measured cost was in the decode:
~240 KB of heap per `Task` against ~30 KB of stored row, in a path where `rowToTask`, `DataRow` and
`fromJson` held 1.327 GiB of the production process's still-live samples. `ListTasksOptions.fields` is
the second lever: a caller names the wide fields it reads, and the SELECT stops carrying the ones it
does not.

**The rules that make it safe** (`ListTasksOptions.fields` in `reads.ts`, `TaskListReadField` in
`async/async-persistence.ts`):

- The union is **closed** — `log | description | summary | steps | attachments | workflowStepResults |
  source`. `source` is a FAMILY (`sourceType`, `sourceAgentId`, `sourceRunId`, `sourceSessionId`,
  `sourceMessageId`, `sourceParentTaskId`, `sourceMetadata`, plus the six `sourceIssue*` columns the
  `Task.sourceIssue` object is assembled from). `acceptanceCriteria` is NOT in it: there is no such
  column on `tasks` — it exists only on the archive tables — so no live list row can source it.
- Everything the union does not name stays selected: identity, lane, status, timestamps, `queueBoost`,
  `nextRecoveryAt`, `dependencies`, `timing_total_ms`, `log_recent`. A declared read is therefore a
  strict **subset** of today's row, never a different row, and absent `fields` returns the pre-existing
  projection objects by reference (`list-tasks-field-declaration.pg.test.ts` asserts `toBe`).
- A declaration also suppresses **enrichment** for an undeclared field. `slim` re-parses `PROMPT.md`
  for every card with empty persisted `steps`; a read that does not declare `steps` must not pay one
  file read per card for a value it said it does not read, so the sync is skipped and `steps` stays `[]`.
  Leaving that sync in place would have made the flag able to *add* an unbounded per-pass fan-out.
- Declaring a field set is a **read shape**, so it is a key dimension and a projection-cache key built
  from one shared spelling helper. Two overlapping reads with different sets never share a fetch.
- Column-level, not post-parse: the claim is about the executed SELECT. `log` and
  `workflow_step_results` are jsonb stored out of line and compressed (`pg_column_size` vs
  `octet_length(...::text)` in the same test), so a client-side strip would still transfer and decode
  all of it. Only the SELECT can prevent that.
- It is NOT a licence to narrow a SHARED loader. `log`, `workflow_step_results` and `source_metadata`
  stay in every undeclared projection (RUFU-615's constraint: engine self-healing reads `task.log`
  markers off list-loaded rows). Only a call site with a written field-read audit may declare.

### Sites converted to declared fields, and the rest of the `slim` census

Converted in this change, each with its audit in its own FNXC comment at the call site:

| Site | Declared | Why that set |
| --- | --- | --- |
| `triage.ts` import near-duplicate comparator | `description` | maps `id`/`title`/`description`/`column`/`createdAt` into `NearDuplicateCandidate`; `resolveTerminalColumnsForTasks` adds `id`/`column` only |
| `triage.ts` FN-5152 planning near-duplicate comparator | `description`, `source` | same candidate shape **plus** `sourceMetadata.fileScope`; `source` is declared whole because `rowToTask` also derives `Task.branchContext` from that column |
| `scheduling/auto-claim-snapshot.ts` `resolveFreshAutoClaimCandidates` | `description` | candidacy reads `column`/`status`/`paused`/`userPaused`/`assignedAgentId`/`checkedOutBy`/`deletedAt`/`dependencies` (all narrow) + `id`/`title`/`description`/`createdAt`/`columnMovedAt`/`queueBoost`; `AutoClaimCandidate` has no `steps` field, so today's PROMPT.md parse produced a value `toAutoClaimCandidate` discards |
| `scheduling/auto-claim-snapshot.ts` `rebuild` | **`[]` — zero wide fields** | Step 5 moved this one. The retained snapshot record no longer owns card text (`RetainedAutoClaimCandidate`), so this pass reads only `isRunnableAutoClaimCandidate` + queue-order + lifecycle-role columns and can declare nothing. Before Step 5 it declared `description` for the body and first line the record used to keep. |

Not converted, recorded so the decision is written down rather than re-litigated per site:

| Census group (measured on this tree) | Count | Decision |
| --- | --- | --- |
| `slim` + `excludeLog`, derivation ON (RUFU-615 tranches 3-7: `self-healing.ts`, `merger.ts`, `executor/*`, `merge/*`, `worktree/*`, `agent-heartbeat.ts`, `agent-tools.ts`, `usage-limit-detector.ts`, `eval/*`, `backlog-pressure-reporter.ts`, `plugin-trait-adapter.ts`) | ~100 | `excludeLog` already took the heaviest column. `fields` needs a per-site field audit that none of them has yet, and the remaining wide fields (`steps`, `workflowStepResults`, `attachments`, `source`) are read by some of them — converting in bulk is how RUFU-201's `description`/`attachments` loss happened. Next tranche: per-file, with the count in this table lowered as each lands. |
| `slim` + `derive: false` + `excludeLog` (`triage.ts` 1069 / 1447 / 2713, `scheduler.ts` 2576 / 2658 / 2659, `healing/gridlock-detector.ts`, `scheduling/review-dispatch-sweep.ts`, `project-engine.ts`, `task-store/lifecycle-ops.ts`) | 10 | Cheapest next conversions, but NOT mechanical: 1069/2713 feed `discoverReadyPlanningTasks`, which reads `steps` (`isTaskStillInPlanningStage`) and — at 2713 — `workflowStepResults` as the only live-agent signal, so their declared set is `description, steps, source` (plus `workflowStepResults` at 2713), not the minimal one. `gridlock-detector` names `sourceMetadata` in its own audit. Declaring them is a per-site edit with its own count line here. (`execution/hold-release.ts` is the same read WITHOUT `slim`, so it is not in this census at all — RUFU-201 converted its `derive`/`excludeLog` half.) |
| `slim` with neither `excludeLog` nor `derive: false` (`triage.ts` 5211 `fn_task_list`, `scheduler.ts` 2040, `agents/agent-reflection.ts`) | 3 | These are the sites the `list-tasks-slim-excludes-log.test.ts` ratchet is for; `excludeLog` first, `fields` after. **Ratchet status:** the census in this change measures 3 and `MAX_UNCONVERTED_SLIM_SCANS` is 2, so that test is red on `main` independently of this change — a deterministic pre-existing failure, recorded here rather than quietly widened. |
| CLI / dashboard / core non-engine `slim` reads (`cli/src/*`, `dashboard/src/*`, `core/src/*`) | ~35 | Out of RUFU-627's scope: mostly one-shot CLI reads (the memo already serves them) or single-card lookups, where a declaration costs a reviewer more attention than it saves bytes. |

### The retained auto-claim snapshot is a second shape (`RetainedAutoClaimCandidate`) — RUFU-627 Step 5

`fields` narrows what a READ carries. A cache that holds the result narrows nothing, so Step 5 gave the
auto-claim snapshot its own record type, because the two shapes answer different questions:

| Shape | Owned by | Carries card text? | Why |
| --- | --- | --- | --- |
| `AutoClaimCandidate` | a consumer, after `resolveFreshAutoClaimCandidates` | yes: `title`, `description`, `descriptionFirstLine` | `agent-heartbeat.ts:3527` scores role + soul words against `title` + full `description`, and 4763 renders `title ?? descriptionFirstLine` into the prompt |
| `RetainedAutoClaimCandidate` = `Omit<…, "title" \| "description" \| "descriptionFirstLine">` | `AutoClaimSnapshot.tasks` (30 s cache) | **no** | both consumers (`agent-heartbeat.ts:3498`, `heartbeat-wake-signals.ts:269`) hand the array to `resolveFreshAutoClaimCandidates`, which reads `id` and rebuilds the rest from the canonical row |

**Why the cache must not hold the text, not merely "does not need" it.** FN-6850 exists because a
superseded triage task reached a heartbeat prompt from this 30-second cache with its old identity text
(FN-6812). Its rule is: never render a cached card's identity text without re-resolving it. The old
shape retained exactly that text — up to 50 full card bodies, since the snapshot is bounded at 50 rows
and was measured at that bound on the live board — so the cache was storage for the one thing its own
governing rule forbids displaying. Making the cache incapable of holding it converts "I grepped, nobody
reads it" into a compile error at the field access, which is the only form of that claim that survives
the next consumer.

Dropping the three text members is also what let the **hottest** read in the file — `rebuild`, fired on
the TTL *and* on every auto-claim fingerprint invalidation — declare `fields: []`. The two auto-claim
reads still disagree about `description` on purpose: the fresh one produces the resolved candidate that
the prompt and the relevance score consume, so it must keep carrying the body.

What stays retained and why: `id`, `createdAt`, `columnMovedAt`, `baseScore`, `column`. Those are the
queue-order and lane scalars the snapshot exists to compute, and FN-509 ranks BEFORE the 50-row bound,
so removing them would change which 50 cards a snapshot may contain to save five scalars per row.

Pinned by `packages/engine/src/__tests__/auto-claim-snapshot-retention.test.ts`: the retained record's
own key set asserted on a populated board (a long `description` plus populated `workflowStepResults`),
the two reads' declarations asserted from the option bags they actually received (`[]` vs
`["description"]`), the resolved candidate still delivering body and first line, one read per TTL window
and zero reads for an empty candidate set, plus the duplicate-id and undefined-optional boards. Whether
`fields: []` removes columns from the executed SELECT is proven one layer down in
`list-tasks-field-declaration.pg.test.ts`, which reads rendered SQL; this file asserts the declaration,
and neither claim is load-bearing alone. Control run: mapping the rebuild back to the full candidate and
restoring `fields: ["description"]` reddens three of its five legs.

### Verification

- `packages/core/src/__tests__/postgres/list-tasks-field-declaration.pg.test.ts` — the SELECT-level
difference (rendered SQL text plus the returned row key set, so the reader cannot be accused of a
client-side strip), the reference-identity of the undeclared projections, TOAST evidence, the
non-coalescing pair in both directions, the `slim` / `compactBoardFeed` / `excludeLog` shape guards, and
the zero-`parseStepsFromPrompt` leg with its control.
- `packages/core/src/__tests__/postgres/list-read-projection-parity.pg.test.ts` — for every member of
the union, the declared row carries exactly that member's columns and none of any other member's, while
the narrow columns survive even `fields: []`; the assembled `Task` stops carrying the undeclared fields;
and reading a declared shape between two reads of the two board feeds' own option bags leaves those
reads byte-equal (the shared projection cache and shape key cannot leak a narrow row onto a board read).
- `packages/dashboard/src/routes/__tests__/task-list-wire-shape-never-declares-fields.test.ts` — the
HTTP boundary: `GET /tasks` (plain, lane-scoped, searched) and `GET /tasks/page` never pass a declared
set, and every field the store returned reaches the wire.

The file this task's spec named, `packages/core/src/__tests__/task-store-list-read-parity.test.ts`, does
not exist on this tree; the field-parity contract it is described as carrying lives in
`list-read-projection-parity.pg.test.ts`, which is what the first bullet above extends.

## Do not

- Do not default `derive` to `false`, and do not convert a dashboard/API board-feed caller. Board parity
  is the hard constraint.
- Do not unfreeze memo or coalesced rows to silence a `TypeError` from a mutating caller — copy the array.
- Do not give `listReadInFlight` a TTL, and do not coalesce a paginated or keyset read.
- Do not add a caller to the converted set without writing its field-read audit in its own FNXC comment.
- Do not pass `excludeLog` hoping to shed the log column while a badge still computes FROM it. That was
  the pre-RUFU-615 rule and it was right then: the five log-derived figures were computed from the
  column. They now read `timing_total_ms` + `log_recent`, so the drop is safe — but a NEW signal that
  derives from `log` must be wired to those projections too, or `excludeLog` blanks it silently.
- Do not drop `log`, `workflow_step_results` or `source_metadata` from an undeclared (shared)
  projection, and do not add a new member to `TaskListReadField` without naming the columns it owns
  and the test that proves the omission is observable only to a caller that asked for it.
- Do not declare a field set on a read whose consumers include a derivation you still need: `fields`
  narrows what the derivation sees, so `retrySummary` and `reviewBypass` come out empty when
  `workflowStepResults` is undeclared. Either declare the input or opt out of deriving — quietly
  serving a badge computed from nothing is the failure mode to avoid.
- Do not treat `ListTasksOptions.excludeColumns` as a column projection. It is a lane filter, and it
  disables the `archived` narrowing.
- Do not reach for `slim: true` when all you want is the log column dropped — `slim` bundles the drop
  with the PROMPT.md steps sync and the `timedExecutionMs` figure, and it blanks `log` on the way out.
  `excludeLog` is the narrow flag; `fields: ["description"]` is the one that also sheds the rest.
