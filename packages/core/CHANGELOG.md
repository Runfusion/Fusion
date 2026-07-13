# @fusion/core

## 0.60.0

## 0.59.0

## 0.58.0

## 0.57.0

## 0.56.1

## 0.56.0

## 0.55.0

## 0.54.0

## 0.53.1

## 0.53.0

## 0.52.0

## 0.51.0

## 0.50.0

## 0.49.0

## 0.48.0

## 0.47.0

## 0.46.0

## 0.45.0

### Patch Changes

- 26ebb92: Fix `reconcileOrphanedTaskDirs` silently resurrecting long-deleted tasks onto the live board after a restart ("all task IDs reset / starting over").

  The sweep re-imports `.fusion/tasks/<id>/` directories that have no DB row, to recover heartbeat-created dirs that race store init or rows lost to a recent DB corruption. But it didn't distinguish a genuinely-recent orphan from an ancient deleted-task dir that merely lingered on disk. Modern deletes leave a soft-delete tombstone (caught by `taskIdExistsAnywhere`), but legacy hard-deletes left no tombstone — so a months-old `task.json` with no DB row was re-imported as a live task, surfacing old low-numbered IDs (FN-001, FN-002, …) at the top of the board.

  Reconcile now gates recovery on a recency window (`task.json` modified within the last 7 days). Older orphan dirs are skipped with reason `stale-orphan-dir-beyond-recency-window` and left for explicit recovery (unarchive/restore) or directory cleanup, while heartbeat-race and recent-corruption recovery still work.

- 7e7eb62: Harden the orphan-worktree and stale-task-dir cleanup fixes (code-review follow-up).

  - **executor.ts (P0):** the stale-conflict recovery's `rm(worktreePath, { recursive, force })` had no bounds check. `worktreePath` can originate from a git worktree admin entry that resolves outside `.worktrees/`, so an out-of-bounds or symlinked path could be force-removed. The recovery now refuses unless the path is inside the configured worktrees dir, is not a symlink (checked via `realpathSync`), is not a registered git worktree, and is not actively owned — and it re-verifies liveness inside the catch rather than trusting the error string. It also excludes `spawn` failures (e.g. `spawn git ENOENT` when git is missing) so a missing-binary error is no longer misread as a successful stale-path cleanup.
  - **worktree-pool.ts:** `resolveGitdirPointer` is replaced by `dotGitPointerIsDangling`, which reaps **only** when a `.git` link's gitdir target is confirmed missing. A real `.git` directory, an unparseable pointer, or any read/stat failure now returns "not dangling" (conservative) so a transient read error on a live worktree's `.git` can't cause a force-remove. Removes the `string | "directory" | null` sentinel union.
  - **core store.ts:** the `reconcileOrphanedTaskDirs` recency window is now bypassed when the live task table is empty (the corruption/restore case — surviving `task.json` files keep old mtimes), and when a corrupt `fusion.db` was auto-recovered on startup, so `.recover` row loss is not stranded by the gate. Adds an `ignoreRecencyWindow` option for explicit callers.
  - Tests for all of the above: executor recovery + out-of-bounds refusal, unparseable `.git` skip, recency boundary, empty-DB/forced bypass.

## 0.44.0

## 0.43.1

## 0.43.0

## 0.42.0

## 0.41.0

## 0.40.1

## 0.40.0

## 0.39.0

## 0.38.1

## 0.38.0

## 0.37.0

## 0.36.0

## 0.35.0

## 0.34.0

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

## 0.33.0

### Minor Changes

- a201f56: feat(core): add `mergeAdvanceAutoSync` project setting (`"off" | "ff-only" | "stash-and-ff"`)

  Adds the schema for a new project setting that controls what happens in **other** worktrees still checked out on the integration branch when the merger advances the branch ref. Previously the merger only updated `refs/heads/<branch>` and left every other checkout's index and working tree pinned at the old tip, so `git status` in the user's project-root checkout reported the new commits as inverted "staged changes to be committed."

  Modes (default `"stash-and-ff"`):

  - `"off"` — preserve the legacy behavior; user must `git pull` or click the Merge Advance Notice banner Pull button.
  - `"ff-only"` — auto-fast-forward only clean worktrees; dirty worktrees stay untouched and the banner still surfaces.
  - `"stash-and-ff"` — run the Smart Pull pipeline (stash → fast-forward → pop). Pop conflicts emit `merge:auto-sync` audit events with `outcome: "stash-pop-conflict"` and surface through the existing dashboard stash-conflict modal.

  Schema-only in this changeset; the merger hook that consumes the setting lands in the follow-up engine change.

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

### Patch Changes

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

- ec6643e: fix(test-utils): cancel subprocess tracking timer for every proc in afterEach

  The vitest subprocess guard registered a 60 s "command timed out" timer for
  each tracked child process and relied on `afterEach` to cancel it. Under
  concurrent load (`pnpm` recursive test runs) the timer could outlive the
  originating test and fire during a later test's `afterEach`, surfacing as
  spurious "Test subprocess guard detected unsafe child-process usage:
  Timed out after 60000ms" failures attributed to a different test name.

  The cleanup loop now scopes "Left running" failure reporting + SIGKILL to
  processes spawned by the current test, but unconditionally clears each
  tracked subprocess's timer so the 60 s timeout cannot fire after the
  afterEach completes. The grace period before declaring a process leaked
  is also raised from 200 ms to 1 s to absorb event-loop contention from
  slow git shells under recursive test load.

- 4c31e88: feat(engine): merger auto-syncs project-root checkout after advancing integration-branch ref

  Wires `mergeAdvanceAutoSync` into the merger's post-ref-advance code path. After `advanceIntegrationBranchRef` ff-updates `refs/heads/<integrationBranch>`, the merger now enumerates other worktrees still on that branch (typically the user's project-root checkout) and reconciles each one's index + working tree to the new tip via `syncWorktreeToHead`.

  The reconciliation primitive is **not** a `git pull` — origin may still be at the previous tip (no `pushAfterMerge`), in which case `git pull --ff-only` is a no-op and a naive `stash → pull → pop` ends with the worktree restored to the old state. Instead `syncWorktreeToHead`:

  1. Diffs the worktree against the _previous_ tip to isolate real user edits from the stale-index "phantom diff" that looks like inverted commits.
  2. When the worktree is clean against the previous tip, runs `git reset --hard HEAD` to snap index + files forward.
  3. In `stash-and-ff` mode with real edits, captures them as a binary patch against the previous tip, snaps to HEAD, then `git apply --3way` to restore. Untracked files are copied to a temp dir and restored after the snap. Patch conflicts surface as `synced-with-pop-conflict` with the patch left on disk for manual recovery.

  Each per-worktree attempt emits a `merge:auto-sync` audit event (new `GitMutationType`) with the outcome; the per-step `pull:fast-forward`, `stash:push`, `stash:pop`, and `stash:pop-conflict` events that pass through the auditor are tagged `metadata.autoSync = true` so downstream consumers can attribute them.

  The user-facing effect: with the default `mergeAdvanceAutoSync: "stash-and-ff"`, after a Fusion task merges the user's `git status` in the project-root checkout becomes clean and the working tree shows the new commits' content — no manual `git reset` or Pull-button click required. Set `mergeAdvanceAutoSync: "off"` to restore the legacy behavior (the Merge Advance Notice banner still surfaces and the user pulls by hand).

  Backstopped by `merger-auto-sync.slow.test.ts` covering: clean-sync snaps both index and files forward, ff-only with real edits is a no-op, stash-and-ff preserves untracked local files across the snap, task worktrees on `fusion/fn-*` branches are correctly skipped, and an empty branch map emits nothing.

## 0.32.0

### Patch Changes

- 1f0bb7e: Stop `MasterKeyManager` from probing the real macOS/Linux keychain during tests. A new `FUSION_MASTER_KEY_DISABLE_KEYCHAIN=1` env var forces the file backend, and the core vitest setup sets it so tests no longer hang for 15s in `keytar.getPassword(...)` on machines without a usable keychain.

## 0.31.0

## 0.30.0

## 0.29.0

## 0.28.1

### Patch Changes

- 681770f: Remove false-positive `committed_reservation_for_existing_id` task-ID-integrity check. The rule flagged every committed reservation that pointed at an existing task, but that's the happy-path steady state — a reservation transitions to `committed` immediately after the task row is inserted, so it's always expected to map to an existing ID. The banner was firing on every healthy node with task history.

## 0.28.0

## 0.27.1

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.0

## 0.23.0

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

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.1

## 0.18.0

## 0.17.2

### Patch Changes

- 17a6634: Fix pre-merge workflow steps stalling on tasks with no relevant changes (FN-3327 post-mortem).

  - **`@fusion/engine`**: `executeWorkflowStep` now computes the diff scope (`git diff --name-only` plus `--shortstat` against `task.baseCommitSha`) before spawning the reviewer agent and injects a "Diff Scope" block into the system prompt. The block lists every file the task actually changed and adds explicit scoping rules: review only those files, and if none match the step's category respond immediately with a short approval line and stop. Without this, an open-ended review prompt (e.g. WS-005 "Frontend UX Design") would drift into pre-existing files matching the task description's keywords, exhaust the 360 s timeout, and trigger the auto-revive → re-finalize → re-fail loop that had FN-3327 wedged in `in-review`. Both git calls are best-effort; failures degrade to a "no modified files detected" notice rather than blocking the step.
  - **`@fusion/core`**: The built-in `frontend-ux-design` workflow step template (WS-005) now opens with a FAST-BAIL rule telling the reviewer to inspect the Diff Scope first and return an immediate one-line approval when no UI/CSS/component files are present. New installs and freshly-materialized templates pick this up automatically; existing DB rows are unaffected but are still rescued by the executor-side scope injection above.

## 0.17.1

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.3

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.0

## 0.10.0

## 0.9.4

## 0.9.3

## 0.9.2

## 0.9.1

### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.

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
- a654795: Restore task card timing and changes fallbacks (FN-2877). The dashboard task card again falls back gracefully when timing data or change summaries are missing, preventing blank states on tasks that haven't reported metrics yet.
- bb5402a: Keep task card timer live while a task is actively merging (FN-2920). The in-review timer was driven by per-step instrumented duration, which freezes during the merge phase, so a stuck merge could read "3m" indefinitely. While `status` is `merging`/`merging-pr` the card now shows live elapsed since the merger flipped the status, with a "Merging Nm" tooltip.
- a654795: Surface visible feedback when copying a log entry from the dashboard TUI. The Logs panel title now flashes a "Copied!" / "Copy failed" status so the action is no longer silent.
- a654795: Stack Utilities and Settings under Stats in the dashboard TUI wide layout (≥150 columns). Logs now fills the full right column for its full height; Stats flex-grows in the left column above fixed-height Utilities and Settings, so Stats absorbs all leftover vertical space.

## 0.8.4

## 0.8.3

## 0.8.2

## 0.8.1

## 0.8.0

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

## 0.6.0

## 0.5.0

## 0.4.1

## 0.4.0

## 0.2.7

## 0.2.6
