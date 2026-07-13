# @fusion/engine

## 0.60.0

### Patch Changes

- @fusion/core@0.60.0
- @fusion/pi-claude-cli@0.60.0

## 0.59.0

### Patch Changes

- @fusion/core@0.59.0
- @fusion/pi-claude-cli@0.59.0

## 0.58.0

### Patch Changes

- @fusion/core@0.58.0
- @fusion/pi-claude-cli@0.58.0

## 0.57.0

### Patch Changes

- @fusion/core@0.57.0
- @fusion/pi-claude-cli@0.57.0

## 0.56.1

### Patch Changes

- @fusion/core@0.56.1
- @fusion/pi-claude-cli@0.56.1

## 0.56.0

### Patch Changes

- @fusion/core@0.56.0
- @fusion/pi-claude-cli@0.56.0

## 0.55.0

### Patch Changes

- @fusion/core@0.55.0
- @fusion/pi-claude-cli@0.55.0

## 0.54.0

### Patch Changes

- @fusion/core@0.54.0
- @fusion/pi-claude-cli@0.54.0

## 0.53.1

### Patch Changes

- @fusion/core@0.53.1
- @fusion/pi-claude-cli@0.53.1

## 0.53.0

### Patch Changes

- @fusion/core@0.53.0
- @fusion/pi-claude-cli@0.53.0

## 0.52.0

### Patch Changes

- @fusion/core@0.52.0
- @fusion/pi-claude-cli@0.52.0

## 0.51.0

### Patch Changes

- @fusion/core@0.51.0
- @fusion/pi-claude-cli@0.51.0

## 0.50.0

### Patch Changes

- @fusion/core@0.50.0
- @fusion/pi-claude-cli@0.50.0

## 0.49.0

### Patch Changes

- @fusion/core@0.49.0
- @fusion/pi-claude-cli@0.49.0

## 0.48.0

### Patch Changes

- @fusion/core@0.48.0
- @fusion/pi-claude-cli@0.48.0

## 0.47.0

### Patch Changes

- @fusion/core@0.47.0
- @fusion/pi-claude-cli@0.47.0

## 0.46.0

### Patch Changes

- @fusion/core@0.46.0
- @fusion/pi-claude-cli@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [26ebb92]
- Updated dependencies [7e7eb62]
  - @fusion/core@0.45.0
  - @fusion/pi-claude-cli@0.45.0

## 0.44.0

### Patch Changes

- @fusion/core@0.44.0
- @fusion/pi-claude-cli@0.44.0

## 0.43.1

### Patch Changes

- @fusion/core@0.43.1
- @fusion/pi-claude-cli@0.43.1

## 0.43.0

### Patch Changes

- @fusion/core@0.43.0
- @fusion/pi-claude-cli@0.43.0

## 0.42.0

### Patch Changes

- 630b2a8: Allow narrowly scoped plan-only operational tasks to complete without source commits when their prompt or metadata explicitly declares no-source/no-code intent and their recorded evidence satisfies the task. The commit guard still rejects missing commits for normal implementation tasks and still enforces worktree and branch invariants before applying the no-commit exemption.
  - @fusion/core@0.42.0
  - @fusion/pi-claude-cli@0.42.0

## 0.41.0

### Patch Changes

- @fusion/core@0.41.0
- @fusion/pi-claude-cli@0.41.0

## 0.40.1

### Patch Changes

- @fusion/core@0.40.1
- @fusion/pi-claude-cli@0.40.1

## 0.40.0

### Patch Changes

- @fusion/core@0.40.0
- @fusion/pi-claude-cli@0.40.0

## 0.39.0

### Patch Changes

- @fusion/core@0.39.0
- @fusion/pi-claude-cli@0.39.0

## 0.38.1

### Patch Changes

- @fusion/core@0.38.1
- @fusion/pi-claude-cli@0.38.1

## 0.38.0

### Patch Changes

- 9112b7d: Fix scheduler overlap deferral starvation by considering only runnable queued todo tasks as higher-priority overlap competitors. Dependency-blocked queued tasks now keep their unmet-dependency queue state without reserving overlapping files from ready work, while active in-progress and eligible in-review tasks continue to hold explicit file-scope leases. Dispatch logs now distinguish unmet dependencies, active file-scope lease blocking, and higher-priority runnable queued-task deferral.
  - @fusion/core@0.38.0
  - @fusion/pi-claude-cli@0.38.0

## 0.37.0

### Patch Changes

- @fusion/core@0.37.0
- @fusion/pi-claude-cli@0.37.0

## 0.36.0

### Patch Changes

- @fusion/core@0.36.0
- @fusion/pi-claude-cli@0.36.0

## 0.35.0

### Minor Changes

- 1992049: Add opt-in RTK command rewriting for Pi bash tools via `FUSION_RTK_REWRITE`.

### Patch Changes

- @fusion/core@0.35.0
- @fusion/pi-claude-cli@0.35.0

## 0.34.0

### Minor Changes

- 97f1143: Add optional dependencies parameter to fn_task_update tool. Executors can now programmatically modify task dependency arrays during execution with `fn_task_update({ id: "FN-XXX", dependencies: ["FN-001", "FN-002"] })`. The parameter is optional and backward-compatible; omitting it preserves existing dependencies. Includes validation for self-dependency and non-existent task IDs. Eliminates the need for direct task.json editing workarounds.

### Patch Changes

- 6a6c6fd: Dashboard startup and request-storm fixes:

  - **Faster startup**: parallelized independent store inits, started CentralCore init early in background, and ran plugin loading concurrently with extension resolution. The duplicate-runtime root cause is also fixed — `shouldUseHybridExecutor` no longer auto-enables for local-only multi-project setups, where `ProjectEngineManager` already handles project lifecycle (set `FUSION_HYBRID_EXECUTOR=1` to force-enable). Eliminates ~7s of redundant self-healing pipeline work per cold start.
  - **Per-page request reduction**: added in-flight request dedupe (`packages/dashboard/app/api/dedupe.ts`) wrapped around the top API offenders. A single page load went from ~177 requests to ~101, with `/api/plugins/ui-slots` dropping from 17× to 1×.
  - **Stale-data-after-mutation hazard**: `forceFresh` option on the deduped fetchers now redirects ALL in-flight waiters to receive the fresh post-mutation response, not just the forcing caller. Generation counters in `useAgents` and `AgentListModal` provide a second layer of protection against slow polls overwriting fresh state.
  - **SSE refresh storm**: agent SSE event handler now debounces (250ms) with a trailing-edge guard, so multi-agent activity bursts coalesce to at most 2 refetches per burst instead of one per event.
  - **Live isolation-mode transition**: PATCH `/api/projects/:id` with an `isolationMode` change now returns a 503 with actionable guidance when HybridExecutor is unavailable (local-only single-node), instead of silently persisting a config that the live runtime won't honor.
  - **Error handling regression**: restored try/catch around `HybridExecutor.initialize` and `engineManager.ensureEngine` in the parallel engine setup so a paused or broken cwd project no longer aborts dashboard startup.
  - **TaskStore migration race**: sequenced the SQLite store inits (TaskStore → AutomationStore → PluginStore → AgentStore) since they all open the same `.fusion/fusion.db` and run `addColumnIfMissing` migrations with a TOCTOU `hasColumn` → `ALTER` pattern.
  - **`gh` CLI invocation storm**: `isGhAvailable()` and `isGhAuthenticated()` now memoize their results with a 60s TTL. `GitHubTrackingReconciler` was scanning up to 200 done tasks at startup and calling `hasGhAuth()` per task — each call shelled out to `gh --version` and `gh auth status` (which makes a network roundtrip), pinning the event loop for ~60s of synchronous `spawnSync` work. CPU-profile-confirmed: dropped from 71s (69% of cold-start CPU) to 2s. The cache benefits all 28+ call sites in `dashboard/src/github.ts`, the engine PR monitor, the research provider, and the API routes automatically. `resetGhAvailabilityCache()` is exported for login/logout flows that need to invalidate immediately.
  - **SQLite integrity check delay**: `PRAGMA integrity_check(100)` walks every page of the database file and was scheduled 3 seconds after init — landing right in the responsiveness-critical window for ~7s per database. Pushed the deferred-check timer to 60 seconds so the user is already interacting with the dashboard by the time it runs. The check itself is unchanged; corruption detection still works.
  - **Engine init event-loop yields**: `InProcessRuntime.start()` now awaits a `setImmediate`-based yield between major init phases (TaskStore → Plugins → WorktreePool → AgentStore → Scheduler → Executor → HeartbeatMonitor → SelfHealing) so HTTP requests can be processed between them instead of waiting on the entire stack. Same yield is now interleaved between each step of `SelfHealingManager.runStartupRecovery()` (34 steps per project) and its periodic maintenance batches.
  - **Deferred startup recovery**: `InProcessRuntime.start()` no longer awaits `resumeStartupRecoverySequence()` or `workerManager.reconcileOrphaned()` — both are correctness-preserving background operations and their git/SQLite work was blocking server-listen for several seconds.
  - **Deferred orphan-task AI agent resumption**: orphaned in-progress tasks resumed at engine restart now wait 30 seconds before spawning their AI agent session (worktree setup + pi-coding-agent session creation is heavy and saturates the event loop). Override via `FUSION_RESUME_ORPHAN_DELAY_MS=<ms>`; auto-zeroes under Vitest.
  - **Event-loop lag tracer**: opt-in debug aid for diagnosing cold-start regressions. Set `FUSION_TRACE_EL_LAG=/path/to/file.txt` to capture every block >150ms with a timestamp relative to process start.

- 4e4830f: Fix two bugs that compounded to produce bare `feat(FN-XXXX): merge fusion/fn-XXXX` merge commits in the dashboard:

  - **`Provided value cannot be bound to SQLite parameter 4` (TypeError) mid-merge**: the verification-fix finalize path called `upsertTaskCommitAssociation` with `commitSha` derived from a `git rev-parse HEAD` whose surrounding exec could reject under the parallel-attempt race, leaving `commitSha` undefined when bound to positional parameter 4. Extracted both duplicated callsites into a `recordCommitAssociationFromHead` helper that catches exec failures and validates each git output is non-empty before binding. The merge no longer fails over a denormalized lookup write when the commit itself landed cleanly.
  - **Bare-fallback subjects persisted into `mergeDetails.mergeCommitMessage`**: when `buildDeterministicMergeMessage`'s tier-3 fallback (`merge ${branch}`) made it onto a landed commit, the four `classification.commit.subject` / `landedCommit.subject` recovery sites in `self-healing.ts` and `aiMergeTask` copied that bare subject verbatim into `mergeDetails`. Added `regenerateBareMergeSubject` (in a new `merger-bare-subject.ts` module to keep self-healing's import graph narrow) which detects the bare pattern via `BARE_MERGE_SUBJECT_RE` and regenerates a descriptive subject from the landed commit's diff stat via the existing AI commit-subject summarizer. Cosmetic only — the git commit is never amended; the regenerated subject only populates the persisted `mergeDetails` and the in-process `MergeResult`. Gated by `settings.useAiMergeCommitSummary`.

- Updated dependencies [6a6c6fd]
  - @fusion/core@0.34.0
  - @fusion/pi-claude-cli@0.34.0

## 0.33.0

### Minor Changes

- 98033bc: feat(engine): guard one engine per project per machine

  Adds a per-machine singleton lock that engages before each engine
  starts, preventing two `fn` dashboard processes from running engines
  for the same project on the same host (a scenario that previously
  caused worktree corruption and task-state races for in-process
  projects).

  The guard combines two independent checks:

  - A `proper-lockfile`-backed file at `<project>/.fusion/engine.lock`
    with stale-lock recovery.
  - A loopback listener (UDS on POSIX, named pipe on Windows) on a
    hashed per-project address.

  Failures throw `EngineAlreadyRunningError`; both guards are released
  on `stopAll()` / `pauseProject()`.

- db9928a: feat(engine): export `smartPull()` library for stash-aware fast-forward of a worktree

  Standalone stash → fast-forward → pop implementation that the merger's upcoming `mergeAdvanceAutoSync` hook calls after advancing the integration-branch ref to auto-sync other worktrees still pinned at the previous tip. Returns a discriminated union (`clean-pull | stash-pull-pop | stash-pop-conflict | skipped-dirty | skipped-not-on-branch | failed`) and accepts an optional audit emitter so callers can record `pull:fast-forward`, `stash:push`, `stash:pop`, and `stash:pop-conflict` run-audit events.

  The dashboard's user-triggered Pull continues to use the existing `POST /api/git/pull` integration path (which runs the AI-aware autostash through `restoreUnrelatedRootDirChanges`) and is unchanged by this changeset — `smartPull()` is intentionally simpler so the merger's post-advance auto-sync stays free of mid-merge AI conflict resolution.

- 4c31e88: feat(engine): merger auto-syncs project-root checkout after advancing integration-branch ref

  Wires `mergeAdvanceAutoSync` into the merger's post-ref-advance code path. After `advanceIntegrationBranchRef` ff-updates `refs/heads/<integrationBranch>`, the merger now enumerates other worktrees still on that branch (typically the user's project-root checkout) and reconciles each one's index + working tree to the new tip via `syncWorktreeToHead`.

  The reconciliation primitive is **not** a `git pull` — origin may still be at the previous tip (no `pushAfterMerge`), in which case `git pull --ff-only` is a no-op and a naive `stash → pull → pop` ends with the worktree restored to the old state. Instead `syncWorktreeToHead`:

  1. Diffs the worktree against the _previous_ tip to isolate real user edits from the stale-index "phantom diff" that looks like inverted commits.
  2. When the worktree is clean against the previous tip, runs `git reset --hard HEAD` to snap index + files forward.
  3. In `stash-and-ff` mode with real edits, captures them as a binary patch against the previous tip, snaps to HEAD, then `git apply --3way` to restore. Untracked files are copied to a temp dir and restored after the snap. Patch conflicts surface as `synced-with-pop-conflict` with the patch left on disk for manual recovery.

  Each per-worktree attempt emits a `merge:auto-sync` audit event (new `GitMutationType`) with the outcome; the per-step `pull:fast-forward`, `stash:push`, `stash:pop`, and `stash:pop-conflict` events that pass through the auditor are tagged `metadata.autoSync = true` so downstream consumers can attribute them.

  The user-facing effect: with the default `mergeAdvanceAutoSync: "stash-and-ff"`, after a Fusion task merges the user's `git status` in the project-root checkout becomes clean and the working tree shows the new commits' content — no manual `git reset` or Pull-button click required. Set `mergeAdvanceAutoSync: "off"` to restore the legacy behavior (the Merge Advance Notice banner still surfaces and the user pulls by hand).

  Backstopped by `merger-auto-sync.slow.test.ts` covering: clean-sync snaps both index and files forward, ff-only with real edits is a no-op, stash-and-ff preserves untracked local files across the snap, task worktrees on `fusion/fn-*` branches are correctly skipped, and an empty branch map emits nothing.

- 51fc826: fix(engine,core): dedup heartbeat-spawned follow-ups by parent task

  Heartbeat agents create follow-up tasks via `fn_task_create`. Until
  now, the intake similarity guard scoped candidates by `sourceAgentId`
  only, so the same parent task could spawn many sibling tasks across
  heartbeats whenever triage rewrote their titles enough to dodge the
  title-fingerprint guard.

  The task-scoped heartbeat now stamps `sourceParentTaskId` (and
  `sourceRunId`) on every `fn_task_create`, and the intake duplicate
  matcher treats a candidate as a sibling when it shares either the
  caller's agent ID or the caller's parent task ID. Same-parent
  siblings with similar descriptions are auto-archived as before.

  Tool description and heartbeat prompts also now instruct agents to
  scan existing open tasks before creating, as a belt-and-suspenders
  layer above the deterministic dedup.

- d02cd38: feat(merger): scope pnpm verification to changed packages and short-circuit out-of-scope fix loop

  In a pnpm workspace, inferDefaultTestCommand now derives the set of packages touched by the branch diff and emits `pnpm --filter "<pkg>...^" test` instead of `pnpm test`. This prevents flakes in unrelated packages from blocking merges. When git context is unavailable or changes are root-only, the command falls back to the unscoped `pnpm test`.

  When the in-merge fix agent makes no changes and all failing test files are outside the branch's diff, the merger now marks the task `status: "failed"` immediately with a clear "out-of-scope flake" message rather than retrying into the limbo-recovery cycle.

### Patch Changes

- 02971ef: fix(engine): treat foreign-attributed commits already on main as promoted

  `assertCleanBranchAtBase` flagged any commit in `baseSha..branchName`
  whose `Fusion-Task-Id` trailer pointed at a different task as
  contamination. That misclassified the FN-5475 cascade: the engine
  fast-forwards local `main` with single-parent task commits, and any
  worktree created during the brief window where local `main` carried a
  sibling task's tip inherited that commit. The audit later (correctly)
  saw the commit as not-yet-on-main from its merge-base perspective and
  threw `BranchCrossContaminationError`.

  The audit now skips foreign-attributed commits that are reachable from
  local `main` (`git merge-base --is-ancestor <sha> main`). Commits on
  main were promoted through integration regardless of whose trailer
  they carry, and downstream branches that inherited them via main are
  not contaminated.

  Resume verifier (FN-5475 fix #2) and the auto-recovery handler
  fallback (FN-5475 fix #3) remain in place as defense-in-depth for
  the rarer variants (local main rewound, foreign commit not yet on
  main when the audit fires).

- 9ce26ee: fix(engine): un-deadcode the bootstrap-misbinding auto-recovery fallback

  The auto-recovery handler in `auto-recovery-handlers/branch-worktree.ts`
  called `classifyBootstrapMisbinding` with `foreignCommits: []` because it
  had no `BranchCrossContaminationError` in hand (it discovers the conflict
  via `inspectBranchConflict`). The classifier's predicate gated on
  `foreignCommits.length > 0`, so the input always resolved to
  `isBootstrapMisbinding: false` and the re-anchor block was effectively
  dead code.

  The handler also used `ctx.task.baseCommitSha` as the contamination base,
  which is deliberately preserved across sessions for diff math (FN-4417)
  and can lag local `main` by many commits — causing legitimately-merged
  landings to be classified as foreign at this layer.

  Changes:

  - `classifyBootstrapMisbinding` now derives the foreign-commit count from
    its own `git log baseSha..branchName` walk; `input.foreignCommits` is
    optional and advisory only. The result type gains `foreignCommitCount`.
  - The `branch-worktree` recovery handler stops passing an empty array and
    computes a fresh merge-base against local `main` (falling back to
    `origin/main`), mirroring the executor's primary contamination path.
  - Regression tests cover both the no-`foreignCommits` call shape and the
    `foreignCommitCount` field.

- e708870: fix(engine): verify resumed worktree branches aren't bootstrap-misbound

  `acquireTaskWorktree` short-circuited the resume path when
  `task.worktree` existed on disk and classified `ok`, handing the
  worktree back to the executor without inspecting its branch history.
  If the branch had been created from a poisoned local-main tip (a
  sibling task's commit), the executor preflight would later flag every
  intermediate landing as foreign and the task would loop through
  contamination recovery until pausing for human adjudication
  (observed in the FN-5475 cascade).

  The resume path now computes a fresh merge-base against local `main`
  (falling back to `origin/main`) and runs `classifyBootstrapMisbinding`
  on the branch. When the range is purely foreign with zero own commits,
  it re-anchors the branch inline via `reanchorBranchToBase` and emits a
  `branch:reanchor` audit event with `trigger: "resume-misbinding"`.

  Mixed contamination (own + foreign, or non-attributed commits) is
  deliberately left to the executor's existing primary path so the
  richer adjudication flow still applies.

- a3ec2e5: fix(engine): never create task branches from arbitrary HEAD in autocorrect

  `attemptBranchAutocorrect` previously fell back to `git checkout -B
<expected>` with no start point when rename was not applicable. If the
  worktree's HEAD happened to be at a previous occupant's commit (e.g. an
  orphaned tip from a different task), the new branch label silently
  captured that commit — the "branch: Created from HEAD" contamination
  pattern that the cross-contamination guard then refuses to auto-resolve.

  This is the only branch-creation site in the engine that did not thread
  a resolved base SHA; every other path (`prepareForTask`,
  `reanchorBranchToBase`) already passes the base explicitly.

  Autocorrect now verifies the expected ref exists and uses a plain
  `git checkout`, so it can only _switch to_ an already-existing branch.
  When the ref is missing it returns `failed`, letting upstream recovery
  (which knows the proper base) re-anchor with `prepareForTask` /
  `reanchorBranchToBase`.

- 408e20b: fix(merger): two root-cause fixes for tasks landing in Done with no commit on main

  **Bug 1: sibling fusion/fn-\* branch as merge target** — `resolveTaskMergeTarget`
  previously returned `task.baseBranch` unconditionally before falling back to the
  project default. When a task was dispatched as a sibling/dependent off another
  in-flight task's worktree, `baseBranch` ended up as the upstream's
  `fusion/fn-<id>` branch. The merger then detached onto that sibling, squashed
  on top of it, and advanced `refs/heads/fusion/fn-<id>` — never main. FN-5233's
  squash (`84563e549`) stranded on `fusion/fn-5339`; FN-5530's
  (`4140a3e0a`) stranded on `fusion/fn-5543`. The resolver now refuses any
  `fusion/fn-\*` candidate as a merge destination and falls through to the
  project default. The merger emits a new `merge:merge-target-rejected-fusion-sibling`
  audit event so the upstream `baseBranch`-propagation bug stays observable.

  **Bug 2: deadlock-recovery mis-attributed tasks to unrelated commits** —
  `findLandedTaskCommit` step (4) used `git log --grep=FN-XXXX` which matches the
  entire commit message (not just the subject) and blindly accepted the first
  hit. FN-5441 and FN-5446 were both marked done against `e3dbfaae` — an
  FN-5483 commit whose body merely _mentioned_ them by name in a paragraph about
  a refusal. The grep fallback now fetches each candidate's body and re-verifies
  ownership via a tightened `commitOwnedByTask`: trailers must be line-anchored
  (`(?:^|\n)Fusion-Task-Id: <id>(?:\n|$)`), and the subject fallback must match
  a conventional-commit form (`<type>(<id>):` or `<id>:`), not a substring.
  Prose mentions can no longer claim a task.

  The historical recovery for FN-5233 has been cherry-picked to main as
  `2d2e5b809`. The other 11 affected tasks (FN-5441, FN-5446, FN-5472, FN-5484,
  FN-5487, FN-5490, FN-5515, FN-5517, FN-5526, FN-5539, FN-5540, FN-5542)
  remain in Done but need separate triage — 3 look like legitimate
  verification-only no-ops, the remaining 9 likely lost real work.

- acf3502: fix(merger): refuse to finalize a task as no-op when modifiedFiles is non-empty

  Third root-cause fix for tasks marked Done with no commit on main (the first
  two — sibling-branch merge target + grep mis-attribution — landed in the
  previous commit). When the executor produced edits but the squash didn't
  land them as a commit (uncommitted in the worktree, squashed against the
  wrong branch, branch dropped by reuse-handoff churn, etc.), the merger's
  `classifyOwnedLandedEvidence` would return `proven-no-op` or
  `no-changes-finalized` and both `aiMergeTask` and `recoverNoOpReviewTasks`
  would happily move the task to Done while clearing `modifiedFiles` to `[]`
  — silently destroying the audit trail of what was lost.

  Both call sites now gate the no-op finalize on `task.modifiedFiles.length`:
  if the task claims work was done but no commit landed, move the task back
  to `todo` with progress preserved and emit a new
  `task:finalize-lost-work-blocked` audit event. The next executor run
  re-attempts the work; the operator sees the audit event in the run-audit
  timeline.

  The post-hoc `reconcileDoneTaskIntegrity` path is intentionally NOT gated —
  it cleans up tasks that are already in Done (legacy state), which is
  out-of-scope for the lost-work prevention. This matters: 9 lost-work tasks
  were already in this state at sweep time (FN-5441, FN-5446, FN-5487,
  FN-5490, FN-5517, FN-5526, FN-5539, FN-5540, FN-5542) and need to be
  re-spec'd as fresh tasks rather than auto-reconciled. See
  `docs/incidents/2026-05-23-lost-work-tasks.md` for the per-task catalog.

- dc94494: fix(engine,dashboard): close 7 code-review findings on the mergeAdvanceAutoSync hook

  Tightens the freshly-landed merger auto-sync feature based on a structured code review.

  **Data-loss fixes in `syncWorktreeToHead`:**

  - Untracked-file restore now compares against `git ls-tree -r --name-only HEAD` to detect when the new tip introduced a tracked file at the same path; collisions are reported in `untrackedSkippedAsTracked` and the user's bytes stay in the stage dir instead of clobbering the merged content.
  - When `git apply --3way` fails because a patched file was deleted/renamed at the new tip (`--diff-filter=U` returns nothing because nothing got staged), `conflictedFiles` falls back to parsing `diff --git a/<p> b/<p>` headers out of the captured patch — so the conflict surfaces with the right file names instead of `[]`.
  - `git ls-files` / `diff` calls now pass `-c core.quotePath=false` so paths with non-ASCII or special characters round-trip through `copyFileSync` instead of failing on backslash-escaped octal tokens.
  - The stash-and-ff path re-verifies `rev-parse HEAD === newSha` immediately before each destructive `reset --hard HEAD`; a concurrent merger advance now bails with `skipped-head-not-at-new-sha` (with the captured patch preserved on disk) instead of applying the patch against the wrong tree.
  - The stage dir is now tracked with a `preserveStageDir` flag in a `try/finally`: it is rm'd on all clean paths and on `skipped-head-not-at-new-sha` exits, but preserved whenever the user's edits live only in `patchPath` (pop-conflict, untracked-collides-with-tracked, reset failure, outer exception).
  - Patch is written to disk before the apply attempt, not only on failure, so a crash between snapshot and apply doesn't lose the user's edits.

  **Multi-worktree-same-branch fix:**

  - New `getRegisteredWorktreeBranches` helper in `worktree-pool.ts` returns ALL `(branch, worktreePath)` entries rather than collapsing duplicates into a `Map<branch, path>`. Multiple worktrees can legitimately share a branch when the user created secondary checkouts via `git worktree add --force -b`; the merger now syncs every one of them instead of silently skipping all but the last.

  **Contract + surfacing fixes:**

  - JSDoc on `merge:auto-sync` GitMutationType now documents the actually-emitted outcome strings (`clean-sync`, `synced-with-edits-restored`, `synced-with-pop-conflict`, `skipped-*`, `failed`, `enumeration-failed`, `exception`) and the actual `stage` enum, replacing the obsolete `smartPull`-shaped strings.
  - `GET /api/tasks/merge-advance-events` now joins `merge:auto-sync` events within a ±5min window of each advance and returns them in a new `autoSync: AutoSyncOutcome[]` field; `useMergeAdvanceNotice` exposes the same shape so the banner can surface pop-conflicts (including `patchPath` pointing at the user's saved edits) instead of leaving them in a black hole.

  **Hygiene:**

  - Merger's setting read now uses `normalizeMergeAdvanceAutoSyncMode(settings.mergeAdvanceAutoSync)` (the exported normalizer) instead of an inline equality check + `as unknown` cast that bypassed type-checking.

  **New backstop tests** in `merger-auto-sync.slow.test.ts`:

  - Untracked file colliding with a newly-tracked path is NOT overwritten and the merged content survives.
  - `git apply --3way` failure on a file deleted at the new tip populates `conflictedFiles` from the patch header.

  **Route test** asserts `autoSync` outcomes are joined onto the matching advance event within the time window.

- bf4428c: fix(merger): require fast-forward ref advances and read integration tip from refs/heads/&lt;branch&gt;

  Closes a class of "orphaned merge" bug where a subsequent merger could overwrite the integration branch tip with a sibling commit, leaving the previous squash reachable only from a feature branch.

  Two coupled fixes:

  1. `advanceIntegrationBranchRef` now refuses non-fast-forward advances. The CAS check still guards against concurrent ref movement, but the new `merge-base --is-ancestor` check additionally requires the new sha to descend from the expected current sha. Non-FF attempts return `reason: "non-fast-forward-advance"` instead of silently orphaning the prior tip.

  2. `runMerge` resolves the integration-branch tip via `git rev-parse --verify refs/heads/<integrationBranch>` instead of `git rev-parse HEAD` in `rootDir`. In reuse-task-worktree mode, `rootDir`'s HEAD can lag behind the shared ref after a sibling merger advanced it via `update-ref` without re-checking-out — using HEAD there caused the eventual squash commit to parent off an earlier sha and orphan the previously-merged tip.

  Together these uphold the invariant: local `<integrationBranch>` only advances via fast-forward, and the merger never builds a squash off a stale base sha.

- 0c0839e: fix(merger): treat non-FF ref-advance as concurrent-advance so it triggers retry

  When the merger's squash commit was built off a stale integration tip (integration moved between squash prep and `update-ref`), the FF guard in `advanceIntegrationBranchRef` correctly refused the swap with reason `non-fast-forward-advance` — but the caller in `merger.ts` only mapped `concurrent-advance` to `IntegrationBranchConcurrentAdvanceError`. The non-FF case fell through as a plain `Error`, failing the task instead of routing to the FN-4500/FN-5083 rebind/retry path. Both reasons share a root cause (integration tip moved during the merge window), so they now share the retry path. Observed on FN-5576.

- ec1269f: feat(merger): auto-rehome FF-recoverable orphan commits during contamination recovery

  Follow-up to the FF-only ref advance fix: contamination recovery now classifies a fourth bucket — `orphan-our-advance` — and fast-forwards the integration branch onto pre-fix orphan commits when safe.

  When the executor's contamination handler sees a "unique" foreign commit, it now also asks:

  - Does the commit's `Fusion-Task-Id` trailer point at a `done` task?
  - Is the commit unreachable from `refs/heads/<integrationBranch>`?

  If both, the commit is an orphan from the pre-fix non-FF ref-advance bug. Recovery attempts to fast-forward the integration branch onto the orphan:

  - **FF possible** (integration tip is an ancestor of the orphan): advance via `advanceIntegrationBranchRef`, then drop the orphan from the task branch alongside `already-upstream` commits. Emits `merger:orphan-rehome-ff`.
  - **Non-FF** (orphan diverges from integration tip — would require cherry-pick): refuse to auto-rehome. The commit stays in `genuinelyUnique` for human adjudication, but the recovery log line now includes the exact `git cherry-pick <sha>` command an operator can run to unstick it. Emits `merger:orphan-rehome-refused`.

  The non-FF refusal is intentional: cherry-pick into the integration branch from inside automated recovery introduces conflict-resolution surface that's too high blast radius for a never-event recovery path.

- Updated dependencies [408e20b]
- Updated dependencies [ec6643e]
- Updated dependencies [a201f56]
- Updated dependencies [4c31e88]
- Updated dependencies [51fc826]
  - @fusion/core@0.33.0
  - @fusion/pi-claude-cli@0.33.0

## 0.32.0

### Patch Changes

- Fixed `fn_task_done` to gracefully handle missing worktree directories. When a task's worktree has been deleted (common for documentation/coordination tasks with no code changes), `fn_task_done` previously failed with ENOENT attempting to spawn git commands in non-existent directories. The fix adds an `existsSync` check in `verifyWorktreeInvariants` before executing git commands, allowing legitimate task completions to proceed. This is safe because task completion is read-only, deliverables are stored in fusion.db (not the worktree), and if code changes were made, the worktree would exist. Resolves infinite loops where agents couldn't complete tasks without shell access to missing directories.
- Updated dependencies [1f0bb7e]
  - @fusion/core@0.32.0
  - @fusion/pi-claude-cli@0.32.0

## 0.31.0

### Patch Changes

- @fusion/core@0.31.0
- @fusion/pi-claude-cli@0.31.0

## 0.30.0

### Patch Changes

- @fusion/core@0.30.0
- @fusion/pi-claude-cli@0.30.0

## 0.29.0

### Patch Changes

- @fusion/core@0.29.0
- @fusion/pi-claude-cli@0.29.0

## 0.28.1

### Patch Changes

- Prevented squash finalization from committing gitignored artifacts by stripping staged ignored paths (for example `.fusion/`, `node_modules/`, and other `git check-ignore` matches) before merge commit creation, including the verification-fix squash-restore path.
- Updated dependencies [681770f]
  - @fusion/core@0.28.1
  - @fusion/pi-claude-cli@0.28.1

## 0.28.0

### Patch Changes

- @fusion/core@0.28.0
- @fusion/pi-claude-cli@0.28.0

## 0.27.1

### Patch Changes

- @fusion/core@0.27.1
- @fusion/pi-claude-cli@0.27.1

## 0.27.0

### Patch Changes

- @fusion/core@0.27.0
- @fusion/pi-claude-cli@0.27.0

## 0.26.0

### Patch Changes

- @fusion/core@0.26.0
- @fusion/pi-claude-cli@0.26.0

## 0.25.0

### Patch Changes

- @fusion/core@0.25.0
- @fusion/pi-claude-cli@0.25.0

## 0.24.0

### Patch Changes

- @fusion/core@0.24.0
- @fusion/pi-claude-cli@0.24.0

## 0.23.0

### Patch Changes

- @fusion/core@0.23.0
- @fusion/pi-claude-cli@0.23.0

## 0.22.0

### Minor Changes

- e658e8e: Decouple permanent agent heartbeats from task state, and add per-agent `allowParallelExecution` setting.

  Heartbeats now run for permanent agents regardless of bound-task block state — the prior early-exit on `queued + blockedBy` is removed along with its dead state-tracking machinery. `HEARTBEAT_SYSTEM_PROMPT` is rewritten to scope heartbeats to ambient coordination (messaging, memory, finding work, delegation, surfacing/chasing blockers, status); task body work continues to run via the executor path. Ephemeral agents are unchanged — they don't run heartbeats and their blocked-task gating in the scheduler is untouched.

  New `allowParallelExecution` flag (default `true`, permanent agents only) on `AgentHeartbeatConfig`. When `false`, the heartbeat and task executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run. Either side re-dispatches the other's deferred work on completion via `resumeTaskForAgent` and the in-process runtime's `onRunCompleted` hook.

  UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`.

### Patch Changes

- aecc050: Make the merger's autostash recovery robust against silent data loss. When `rootDir` is the developer's primary checkout, the merger stashes uncommitted edits before running its hard resets and applies them back at the end. Previously a pop conflict logged a single warning and silently left the stash in place — and a subsequent merge would push another autostash on top, burying the first.

  Three changes:

  1. **AI auto-resolve on apply conflict.** When the autostash apply hits a conflict, the merger now spawns a focused fix-agent (same `createResolvedAgentSession` path used for the in-merge verification fix-agent) to resolve conflict markers in the working tree. On success the stash is dropped and the resolution is recorded in `MergeResult.autostash`. On failure the stash is left intact for manual recovery.
  2. **Outcome surfaced on `MergeResult.autostash`** (new field of type `AutostashOutcome`). Consumers (dashboard, CLI, daemon) can now show the developer whether their work was reapplied cleanly, AI-resolved, or needs manual recovery — instead of relying on a buried log warning.
  3. **Deterministic stash identity via `git stash create` + `git stash store`.** Replaces the previous `git stash push` + label-grep flow that raced against any other tool stashing concurrently. The stash SHA is captured atomically with snapshot creation and used for apply/drop, so the operation is robust to stash list reordering.

  Also: orphaned `fusion-merger-autostash:*` entries from prior failed runs are now detected at merge entry and surfaced as a warning so they cannot be silently buried again.

- 6ee3225: Fix agents stuck in `state="running"` after a missed-heartbeat termination.

  The unresponsive-agent recovery path disposed the session and called `pauseAgent`, but never explicitly ended the run via `completeRun` — relying on the in-flight execution to self-complete via its catch handler, which doesn't happen when the run is genuinely hung. The run record could still be terminated through other paths (safety-net or supersede-on-startRun), but those bypass the agent-state transition, leaving the agent permanently displayed as "running" with no active run.

  Two fixes:

  - `recoverUnresponsiveAgent` now calls `completeRun(..., status: "terminated")` so the canonical state transition runs alongside the existing `pauseAgent`/`resumeAgent` sequence.
  - `reconcileOrphanedRunningAgents` is broadened to also catch agents with stale `lastHeartbeatAt` (> 3× timeout) that aren't in the in-memory tracked set, terminating their stale run record. It now runs every poll instead of only at monitor start, so any pre-existing stuck rows from older versions self-heal within one poll interval after upgrade.

- 81bf882: Route skill-selection diagnostics by their declared severity instead of always logging at warn. Info-level messages like "Requested skill: <name>" now log at info level.
- Updated dependencies [e658e8e]
- Updated dependencies [aecc050]
  - @fusion/core@0.22.0
  - @fusion/pi-claude-cli@0.22.0

## 0.21.0

### Patch Changes

- @fusion/core@0.21.0
- @fusion/pi-claude-cli@0.21.0

## 0.20.0

### Patch Changes

- @fusion/core@0.20.0
- @fusion/pi-claude-cli@0.20.0

## 0.19.0

### Patch Changes

- 54f2832: Restrict merger staging to squash + fix-agent files; refuse to commit unrelated working-tree changes

  Replaces the blanket `git add -A` in `commitOrAmendMergeWithFixes` with an explicit allowlist: only files that were squash-staged or explicitly modified by the in-merge verification fix agent are staged. Any other dirty files in the working tree are left untouched and a warning is logged naming each excluded path. Fixes a production bug where ~13 unrelated user-edited files were bundled into a task's squash commit.

  Hardened by code review: replaced all shell-interpolated `git add` calls in `commitOrAmendMergeWithFixes` and the conflict-resolution helpers (`resolveWithOurs`, `resolveWithTheirs`, `resolveTrivialWhitespace`) with `execFile` array form to eliminate path-injection surface; adopted `git -z` NUL-delimited output for all dirty-file path queries in both `snapshotDirtyFiles` and `commitOrAmendMergeWithFixes` so paths with embedded spaces round-trip correctly; truncated long allowlist debug log lines to at most 20 entries.

  - @fusion/core@0.19.0
  - @fusion/pi-claude-cli@0.19.0

## 0.18.1

### Patch Changes

- @fusion/core@0.18.1
- @fusion/pi-claude-cli@0.18.1

## 0.18.0

### Patch Changes

- @fusion/core@0.18.0
- @fusion/pi-claude-cli@0.18.0

## 0.17.2

### Patch Changes

- 17a6634: Fix pre-merge workflow steps stalling on tasks with no relevant changes (FN-3327 post-mortem).

  - **`@fusion/engine`**: `executeWorkflowStep` now computes the diff scope (`git diff --name-only` plus `--shortstat` against `task.baseCommitSha`) before spawning the reviewer agent and injects a "Diff Scope" block into the system prompt. The block lists every file the task actually changed and adds explicit scoping rules: review only those files, and if none match the step's category respond immediately with a short approval line and stop. Without this, an open-ended review prompt (e.g. WS-005 "Frontend UX Design") would drift into pre-existing files matching the task description's keywords, exhaust the 360 s timeout, and trigger the auto-revive → re-finalize → re-fail loop that had FN-3327 wedged in `in-review`. Both git calls are best-effort; failures degrade to a "no modified files detected" notice rather than blocking the step.
  - **`@fusion/core`**: The built-in `frontend-ux-design` workflow step template (WS-005) now opens with a FAST-BAIL rule telling the reviewer to inspect the Diff Scope first and return an immediate one-line approval when no UI/CSS/component files are present. New installs and freshly-materialized templates pick this up automatically; existing DB rows are unaffected but are still rescued by the executor-side scope injection above.

- Updated dependencies [17a6634]
  - @fusion/core@0.17.2
  - @fusion/pi-claude-cli@0.17.2

## 0.17.1

### Patch Changes

- c2f6dd3: Fix heartbeat and manual agent runs ignoring the agent's configured model. The dashboard saves `runtimeConfig.model` as a combined `"provider/modelId"` string, but heartbeat was reading non-existent split `modelProvider`/`modelId` fields, causing sessions to fall through to pi's default model (often `openai-codex`) and fail with "No API key for provider: openai-codex".
  - @fusion/core@0.17.1
  - @fusion/pi-claude-cli@0.17.1

## 0.17.0

### Patch Changes

- @fusion/core@0.17.0
- @fusion/pi-claude-cli@0.17.0

## 0.16.0

### Patch Changes

- @fusion/core@0.16.0
- @fusion/pi-claude-cli@0.16.0

## 0.15.0

### Patch Changes

- @fusion/core@0.15.0
- @fusion/pi-claude-cli@0.15.0

## 0.14.3

### Patch Changes

- @fusion/core@0.14.3
- @fusion/pi-claude-cli@0.14.3

## 0.14.2

### Patch Changes

- @fusion/core@0.14.2
- @fusion/pi-claude-cli@0.14.2

## 0.14.1

### Patch Changes

- @fusion/core@0.14.1
- @fusion/pi-claude-cli@0.14.1

## 0.14.0

### Patch Changes

- @fusion/core@0.14.0
- @fusion/pi-claude-cli@0.14.0

## 0.13.0

### Patch Changes

- @fusion/core@0.13.0
- @fusion/pi-claude-cli@0.13.0

## 0.12.0

### Patch Changes

- @fusion/core@0.12.0
- @fusion/pi-claude-cli@0.12.0

## 0.11.0

### Patch Changes

- @fusion/core@0.11.0
- @fusion/pi-claude-cli@0.11.0

## 0.10.0

### Patch Changes

- @fusion/core@0.10.0
- @fusion/pi-claude-cli@0.10.0

## 0.9.4

### Patch Changes

- @fusion/core@0.9.4
- @fusion/pi-claude-cli@0.9.4

## 0.9.3

### Patch Changes

- @fusion/core@0.9.3
- @fusion/pi-claude-cli@0.9.3

## 0.9.2

### Patch Changes

- @fusion/core@0.10.0
- @fusion/pi-claude-cli@0.10.0

## 0.9.1

### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- Updated dependencies [76deb48]
- Updated dependencies [f6242c2]
  - @fusion/core@0.9.1
  - @fusion/pi-claude-cli@0.9.1

## 0.9.0

### Minor Changes

- a654795: Generate richer merge commit messages via the AI summarizer. The merger now routes commit-body summarization through the consolidated `ai-summarize.ts` pipeline (using the title-summarization model), with an AI fallback cascade to guarantee non-empty merge bodies. Summarization model is configurable in settings.
- 91f9f20: Add unified multi-node task routing across CLI, dashboard, core, and engine flows.

  - **Routing model:** Tasks can set a per-task node override with project-level pinned default node fallback. `resolveEffectiveNode()` computes the effective routing target per task.
  - **Core types:** Adds `Task.nodeId`, `UnavailableNodePolicy` (`"block" | "fallback-local"`), `ProjectSettings.defaultNodeId`, and `ProjectSettings.unavailableNodePolicy`.
  - **Engine behavior:** Adds effective-node resolution (per-task override → project default → local), unavailable-node policy enforcement, and routing activity event logging.
  - **Active-task guard:** Blocks node override changes for in-progress tasks via `validateNodeOverrideChange()`.
  - **Dashboard updates:** Adds project settings controls for default node and unavailable-node policy, task detail routing summary (effective node, routing source, fallback policy, blocking reason), quick task creation node picker, bulk node override actions, and node health/status indicators in selectors.
  - **CLI updates:** Adds `fn settings set defaultNodeId <node-id>`, `fn settings set unavailableNodePolicy <block|fallback-local>`, `fn task set-node <id> <node>`, `fn task clear-node <id>`, `fn task create --node <name>`, and routing details in `fn task show`.
  - **Schema updates:** Includes tasks table migration adding the `nodeId` column.

- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- a654795: Read assistant text from session state when processing memory dreams. Dream extraction no longer misses content when the assistant message has not been flushed to the output stream yet.
- b91533c: Fix PR-mode merge flow (related to [#21](https://github.com/Runfusion/Fusion/issues/21)):

  - **PR-mode now pushes the per-task branch to origin before creating the PR.** `processPullRequestMergeTask` previously called `gh pr create --head fusion/<task-id>` without ever publishing the branch, so the PR creation failed and the task stalled in `in-review`. The branch is now pushed via `git push -u origin <branch>` immediately before `createPr` (skipped when an existing PR already covers the branch).
  - **Removed dead `autoCreatePr` setting** from the schema and `Settings` type. It was defined as a default but never read anywhere.

- 7f42c7f: Fix [#21](https://github.com/Runfusion/Fusion/issues/21): the `recover-mergeable-review` maintenance sweep no longer bypasses `autoMerge` and `mergeStrategy`. The sweep now early-returns when `autoMerge !== true` (or when the engine is paused) and routes recovery merges through the engine's merge queue so `mergeStrategy: "pull-request"` is honored — eligible in-review tasks go through `processPullRequestMerge` instead of a raw local `git merge`. Operators using a PR-based review flow with `autoMerge: false` will no longer have tasks silently merged behind their back.
- 9ce811a: Remote access (Tailscale) overhaul: the auth/scan URL now uses the live `https://<machine>.<tailnet>.ts.net/` URL captured from `tailscale funnel` instead of a constructed `http://<hostname>:<port>` from a configured label, so QR codes lead to a working public endpoint. The hostname label is no longer required (engine validation and the Settings UI both dropped it; `tailscale funnel` never used it). QR codes are now rendered with the `qrcode` library — previously the SVG was just the URL drawn as text — and a new `format=terminal` returns ASCII QR for the TUI. The Tailscale readiness parser now waits for the line containing the URL before flipping to `running`, fixing missing-URL captures. Dashboard polls remote status while `starting`/`stopping` so state updates without reopening the modal. The TUI shows a global `● tunnel` indicator with URL in the header when running, and `Ctrl+Q` opens an ASCII QR overlay anywhere in the app.
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.
- Updated dependencies [48208db]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
- Updated dependencies [91f9f20]
- Updated dependencies [b91533c]
- Updated dependencies [7f42c7f]
- Updated dependencies [17a072c]
- Updated dependencies [1beebc0]
- Updated dependencies [a654795]
- Updated dependencies [bb5402a]
- Updated dependencies [a654795]
- Updated dependencies [a654795]
  - @fusion/core@0.9.0
  - @fusion/pi-claude-cli@0.9.0

## 0.8.4

### Patch Changes

- @fusion/core@0.8.4
- @fusion/pi-claude-cli@0.8.4

## 0.8.3

### Patch Changes

- @fusion/core@0.8.3
- @fusion/pi-claude-cli@0.8.3

## 0.8.2

### Patch Changes

- @fusion/core@0.8.2
- @fusion/pi-claude-cli@0.8.2

## 0.8.1

### Patch Changes

- @fusion/core@0.8.1
- @fusion/pi-claude-cli@0.8.1

## 0.8.0

### Patch Changes

- @fusion/core@0.8.0
- @fusion/pi-claude-cli@0.8.0

## 0.7.1

### Patch Changes

- ce6dcef: fix(0.7.1): mobile polish, modal layout fixes, paperclip CLI parity, schema migration

  Mobile / dashboard:

  - ModelOnboardingModal: dialog was off-screen on phones because the desktop `min-width: 640px` won over the mobile `max-width: 100%`. Reset min-width/min-height to 0 in the mobile media query (with `!important` so persisted desktop sizes from `useModalResizePersist` cannot re-pin it). Compact provider cards: keep the icon inline beside the name + description, shrink the icon container, drop name/description font sizes, and rely on flex-wrap so the API-key actions still drop to their own row underneath. The API-key input + Save button now live on a single row at the full card width — input grows left-aligned, Save shrinks to the right with a hairline of inline padding.
  - NewAgentDialog: the dialog's top was rendering hidden behind the in-page Agents header on mobile. Render the dialog through `createPortal(..., document.body)` so the overlay escapes the `.agents-view` stacking context. Mobile media query also drops the overlay padding, fills 100vw / 100dvh with safe-area insets on header/footer for iOS notch + home indicator, and fixes the classic flex `min-height: auto` bug that prevented `overflow-y: auto` on the body from activating.
  - TerminalModal: same root cause as the onboarding modal — desktop `min-width: 480px` / `min-height: 320px` pinned the modal off-screen on phones. Reset to 0 in the mobile rule with `!important` so persisted desktop sizes can't override.
  - WorkflowStepManager: fix React error #310 ("Rendered more hooks than during the previous render") that prevented the workflow steps panel from loading. `useOverlayDismiss` was being called after an `if (!isOpen) return null` early return, so the hook count differed between open/closed renders. Moved the hook above the early return.
  - SettingsModal auth panel: tightened `.auth-panel-body` horizontal padding from `--space-xl` (24px) to `--space-md` (12px), giving each provider card more horizontal room.

  Paperclip runtime:

  - CLI parity: in the dashboard's "Local CLI" tab, Test / fetch companies / fetch agents now actually shell out to `paperclipai` instead of making HTTP calls through a derived URL. New CLI-backed variants (`probePaperclipViaCli`, `listCompaniesViaCli`, `listCompanyAgentsViaCli`, `createIssueViaCli`, `getIssueViaCli`, `agentsMeViaCli`) drive every Paperclip call that has a CLI counterpart; the runtime adapter routes through them when `transport=cli`. `getIssueComments` / `wakeAgent` / `getRunEvents` continue using HTTP (no matching `paperclipai` subcommands) but rely on the apiKey discovered from the local paperclipai config so CLI mode works end-to-end.
  - New dashboard routes `/providers/paperclip/cli-status`, `/cli-companies`, `/cli-agents` exposing the CLI helpers.

  Plugin runtime registry:

  - `GET /api/plugins/runtimes` now merges a bundled hermes/openclaw/paperclip fallback list on top of installed plugins, so the NewAgentDialog "Plugin Runtime" dropdown populates without requiring `fn plugin install` on a fresh setup. Installed plugins override the bundled entry by `runtimeId`. Coalesced the optional `version` field to `"0.0.0"` to satisfy the bundled-runtime type.

  Core:

  - Schema migration fix: bumped `SCHEMA_VERSION` from 48 → 49 so migration 49 (per-task `nodeId` column for remote-node routing) actually runs. Existing DBs at version 48 hit the early-return guard, never created the column, and `TaskStore.listTasks` crashed at startup with `no such column: nodeId` — the dashboard exited before initialization. The bump unblocks app startup on any pre-existing 0.7.0 install.

- Updated dependencies [ce6dcef]
  - @fusion/core@0.7.1
  - @fusion/pi-claude-cli@0.7.1

## 0.7.0

### Minor Changes

- b30e017: feat(runtimes): real Hermes / OpenClaw / Paperclip runtime plugins

  Replaces the stub runtime plugins with end-to-end working integrations:

  - **Hermes** runtime drives the local `hermes` CLI as a subprocess (`hermes chat -q ... -Q --source tool [--resume <id>]`), captures session ids for continuity, with profile picker (HERMES_HOME-based switching) and Nous Research co-brand.
  - **OpenClaw** runtime drives `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>`, parses the OpenAI-compatible JSON output, surfaces visible/reasoning text via callbacks; defaults to embedded mode (no daemon required).
  - **Paperclip** runtime now uses the modern `POST /api/agents/{id}/wakeup` + heartbeat-run streaming API (replaces the old issue-checkout + heartbeat-invoke flow); supports both API mode (URL + bearer) and CLI mode (auto-derives URL from `~/.paperclip/instances/default/config.json`); company + agent dropdowns; CLI key bootstrap via `paperclipai agent local-cli`.

  Engine fix: `agent-session-helpers.ts:createResolvedAgentSession` now attaches the resolved runtime's `promptWithFallback` to the session so pi's dispatch hook routes prompts through the plugin runtime instead of falling through to pi's native path.

  Dashboard adds a unified `RuntimeCardShell` component, real provider logos (caduceus, pixel-lobster, paperclip outline), Test/Save/Save & Test buttons with success/failure toasts, "Learn more →" links, and a "Runtimes" group in Settings.

  Backend adds `GET /providers/{hermes,openclaw,paperclip}/status`, `GET /providers/hermes/profiles`, `GET /providers/paperclip/{companies,agents,cli-discovery}`, `POST /providers/paperclip/cli-mint-key`.

  Plugin SDK: now ships a proper `dist/` build (was previously TS-source-only), unblocking runtime imports from compiled plugins.

### Patch Changes

- Updated dependencies [b30e017]
  - @fusion/core@0.7.0
  - @fusion/pi-claude-cli@0.7.0

## 0.6.0

### Patch Changes

- @fusion/core@0.6.0
- @fusion/pi-claude-cli@0.6.0

## 0.5.0

### Patch Changes

- @fusion/core@0.5.0
- @fusion/pi-claude-cli@0.5.0

## 0.4.1

### Patch Changes

- @fusion/core@0.4.1
- @fusion/pi-claude-cli@0.4.1

## 0.4.0

### Patch Changes

- @fusion/core@0.4.0
- @fusion/pi-claude-cli@0.4.0

## 0.2.7

### Patch Changes

- @fusion/core@0.2.7

## 0.2.6

### Patch Changes

- @fusion/core@0.2.6
