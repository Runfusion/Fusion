# @runfusion/fusion

## 0.33.0

### Minor Changes

- 1b49cbc: Surface SQLite corruption in notifications, the dashboard health API, and a persistent dashboard banner.
- 2baaad7: `fn backup` now also snapshots the central database (`~/.fusion/fusion-central.db`)
  alongside the per-project database. Scheduled and manual backups produce a paired
  `fusion-central-<timestamp>.db` file in `.fusion/backups/`; `fn backup --list`,
  `--cleanup`, and `--restore` operate on the pair. Restoring a `fusion-central-*`
  file restores only the central DB. A missing central DB is skipped silently and
  does not fail the project backup.
- b12ff26: Saving an opencode or opencode-go API key from the dashboard now immediately refreshes the opencode-go model catalog (no restart required), reports how many models were registered, and surfaces actionable errors when the local `opencode` CLI is missing or returns no models. `opencode-go` is now always listed as an API-key target in Settings, even before models are registered.
- 8a3afcf: feat(executor+engine-tests): preflight premise-stale exit and serialize reliability-interactions

  - Executor: teach the system prompt a Preflight escape hatch. When Step 0 reproduces the issue described in PROMPT.md and finds the work is already done (HEAD matches the desired state), the agent now marks Step 0 done, marks remaining steps `skipped`, and calls `fn_task_done` with a `PREMISE STALE: …` summary. Skipped steps already pass `evaluateTaskDoneRefusal`, and the merger's empty-own-diff fast-path auto-finalizes the zero-diff branch — no new tool or refusal class is needed. This stops the executor from looping through plan/review/test/doc when PROMPT.md is out of sync with HEAD (the failure mode that exhausted FN-5521 across four worktrees).

  - Engine vitest: split `packages/engine/vitest.config.ts` into two projects. `engine-default` keeps the full-parallelism layout for the bulk of the suite; `engine-reliability` scopes `src/__tests__/reliability-interactions/**` to `poolOptions.threads.singleThread: true` so the contention-sensitive event-ordering assertions (e.g. `merge-reuse-task-worktree`'s newest-first audit ordering check) no longer flake under workspace-concurrent merge-gate runs. Within-file order was already linear; this only removes inter-file parallelism for ~99 files that always shared a single git/SQLite contention surface.

- e291d86: Attribute Fusion as a `Co-authored-by` trailer on managed commits instead of overriding the primary author. The user's configured git identity now remains the author/committer of every commit Fusion produces, and the configured commit author (default `Fusion <noreply@runfusion.ai>`) is appended as a `Co-authored-by:` trailer that GitHub recognizes for shared attribution. The `commitAuthorEnabled` toggle and `commitAuthorName`/`commitAuthorEmail` settings keep their existing keys; the dashboard settings UI relabels them from "Author" to "Co-author" to match the new behavior.
- 22d59b5: Add mergeIntegrationWorktree setting (default reuse-task-worktree) to decouple auto-merge from project-root mutation. Legacy cwd-main behavior preserved as an opt-in escape hatch.
- 5f9f777: Increase default group chat context retention (`chatRoomRecentVerbatimMessages` 12 → 25, `chatRoomCompactionFetchLimit` 80 → 200, `chatRoomSummaryMaxChars` 1500 → 3000) and raise the room transcript cap from 8KB to 20KB.
- 687237b: Per-project `fusion.db` now persists the canonical `projectId` in `__meta.projectIdentity`. If the central registry loses a project row, the next startup reattaches the same id from the stored identity instead of silently minting a new one (which would hide all project-scoped data keyed to the old id). Interactive flows prompt before destructive overwrites.

### Patch Changes

- f403926: Make `fn agent import` extract `.tar.gz`/`.tgz` Agent Companies archives in-process instead of relying on a host `tar` binary.
- b7ddfc9: Layer FN-5152's near-duplicate intent guard onto the CLI `fn task create`
  direct-store path. Aligned thresholds (≥2 shared high-signal tokens AND
  title-token Jaccard ≥ 0.30 within a 7-day window), `--no-dedup` bypass,
  `source.sourceMetadata.intentSignature` stamping, and fail-open semantics
  match the dashboard `POST /api/tasks` gate. Non-TTY runs refuse with exit
  1; TTY runs prompt before creating. GitHub-import and AI-planning paths
  intentionally skip the gate (FN-5060 contract).
- 35b2971: Duplicating or restoring a task no longer fails when the source PROMPT.md
  contains legacy/invalid File Scope tokens. Invalid tokens are dropped from
  the rewritten PROMPT.md with a `[file-scope-sanitize]` log entry. Authoring
  paths (createTask, updateTask) continue to reject invalid tokens strictly.
- 8f2d5e7: Block explicit `DUPLICATE: FN-NNNN` redirect tasks from consuming planning
  cycles. The triage planning loop now short-circuits when the generated
  PROMPT.md is a one-line duplicate marker (bypassing the `fn_review_spec`
  APPROVE gate), a self-healing sweep resolves already-stuck duplicate-marker
  tasks in `triage`/`todo`, and the dashboard `POST /api/tasks` route
  surfaces a `409 duplicate_candidates` with `reason: "explicit-marker"` when
  the description is exactly a duplicate redirect. Layered on top of
  FN-4829 / FN-4918 / FN-5152; fails open.
- f6f3867: Merger Layer 2.5: auto-widen `## File Scope` for files whose branch-side commits
  are exclusively attributed to the current task before the FN-4956 scope
  partition strips them. Emits `merge:scope:auto-widen` run-audit events.
  Fail-closed against foreign commits, cross-task scope claims, and ignored paths.
- 8f5c1f9: New projects now default `directMergeCommitStrategy` to `"always-squash"` for direct merges.
  Existing projects keep their persisted setting value.
  Per-project Settings UI controls and per-task `**Direct Merge Commit Strategy:** ...` PROMPT overrides are unchanged.
- b936ab9: Apply `heartbeatMultiplier` to heartbeat unresponsive timeout calculations in `HeartbeatMonitor`.

  When heartbeat speed is slowed (for example `heartbeatMultiplier=2`), unresponsive detection/recovery and orphaned-running reconciliation now use the correspondingly scaled timeout base, preventing false unresponsive recovery for expected slower cadence. Dashboard health classifier behavior is unchanged.

- 6fdfb1a: Add a Room Coordination Notices prompt-injected advisory that fires when a
  user posts an explicit "file a task" / "create a task" request into a chat
  room with multiple agent members. Each agent is instructed to either post a
  one-line claim before calling fn_task_create (claim branch) or to defer and
  acknowledge a peer's prior claim/announcement (defer-suggested branch),
  reducing the upstream duplicate pressure on the existing FN-4918 / FN-4829
  / FN-5152 / FN-5220 dedup backstop. Emits a structured
  room:coordination:branch run-audit event per decision. Single-agent rooms
  and non-task-filing messages are unaffected.
- 025683c: Manual merge ("Merge now") no longer rejects in-review tasks that the scheduler has stamped with status: "queued". Auto-merge still honors all existing blockers.
- 4a99e3f: PR-mode merge cleanup (`cleanupMergedTaskArtifacts`) now releases the `WorktreePool` lease for the merged task worktree before removing it, preventing stranded lease bookkeeping after pull-request merges (FN-5420 / FN-4954 follow-up).
- 7a20b95: Add `session:runtime-resolved` run-audit event (FN-5544) emitted from `createResolvedAgentSession` for per-lane provider/runtime/model attribution. Additive surface; existing events unchanged. Replaces the diagnostic-log workaround introduced by FN-5206.
- 8380024: fix(executor): exempt `PREMISE STALE:` summaries from `summary-claims-incomplete` refusals

  The preflight escape hatch added in the prior commit instructs the agent to call `fn_task_done` with a summary that begins `PREMISE STALE:` when reproduction shows HEAD already matches the desired state. Natural premise-stale wording such as _"PREMISE STALE: the task has no remaining work — implementation is already done on HEAD"_ tripped `evaluateTaskDoneRefusal`'s scoped-incomplete regex (`/\b(incomplete|not implemented|not done|not finished)\b/i`) when the 40-char window contained `the task`/`this task`/first-person pronouns, refusing `fn_task_done` and deadlocking the executor — the exact failure the escape hatch was meant to prevent.

  Add a sentinel bypass: when `summary` starts (case-insensitive) with `PREMISE STALE:`, skip the dissent-pattern and scoped-incomplete summary checks. The `pending-code-review-revise` and `bulk-step-completion-without-review` guards still run unchanged, so the bypass cannot dodge real review obligations or unfinished work — only the summary-phrasing checks are relaxed.

- 1be0702: Mobile (Android Chrome edge-to-edge): the top brand header no longer sits underneath the system status bar — its mobile `padding-top` is now additive (`var(--space-md) + env(safe-area-inset-top)`) instead of `max(...)`, so the row keeps its normal breathing room _below_ the system inset. The executor status footer also no longer bleeds into the bottom-nav padding band: its `bottom` offset now uses the same `max(env(safe-area-inset-bottom), 12px)` floor that `MobileNavBar` already applies, so the two surfaces meet flush even when Chrome under-reports the bottom inset. Bare `TypeError: Failed to fetch` toasts (raised by in-flight requests aborted on tab background/resume) are now swallowed at the toast layer; toasts with additional context still surface.
- ba9d632: Mobile bottom nav no longer occasionally hides behind Android Chrome's gesture pill. Chrome under `viewport-fit=cover` intermittently reports `env(safe-area-inset-bottom)` as `0` while the address bar is visible or during URL-bar collapse; the nav now floors that inset to 12px so it always clears the gesture area. Devices that report a larger inset are unaffected.
- fbf7e2c: Dashboard no longer renders into a small upper-left rectangle on Android Chrome in multi-window/freeform/split-screen mode. The page now re-asserts its viewport meta with the live `innerWidth` on every resize and orientation change, defeating Chrome's habit of caching `device-width` at the original screen size (which left the layout viewport wider than the actual window, so normal-flow elements clipped while position-fixed elements pinned to the full window). Also drops `maximum-scale=1.0, user-scalable=no` from the viewport meta, and broadens the existing board scroll-snap stabilization from phones to all touch-primary devices so Android tablets get the same first-cards-loaded reflow that iOS Safari mobile already had.
- 5548dc5: Dashboard git pull now autostashes dirty local changes (including untracked files) before pulling and reapplies them on success. If reapplying conflicts, the stash is preserved and the operation reports `stashConflict` with the stash label so the user can resolve later from the Stashes view. Previously a dirty working tree caused the pull to fail outright with no recovery path.
- f58fb89: fix(engine-tests): eliminate full-suite temp-dir leak and harden subprocess guard against concurrent-workspace contention.

  - Two engine merger tests (`merger-no-op-fix-finalize.test.ts`, `merger-verification-fix-already-on-main.test.ts`) created `mkdtempSync` workspaces directly under `tmpdir()` with the tracked `fusion-test-` prefix. Under `pnpm -r --workspace-concurrency=2` load, transient cleanup races left orphans flagged by `check-test-isolation`. Route both through `FUSION_TEST_WORKER_ROOT` like sibling merger tests so the dirs nest inside the already-tracked worker root and never appear as top-level leaks.

  - Bump the engine vitest subprocess guard from 60 s to 120 s and the per-test timeout to 30 s. Under concurrent workspace runs, plain git commands (`git branch -d`, `git worktree remove --force`) queued behind system contention were timing out and failing reliability-interactions tests. The guard fires only on hangs, so healthy tests pay nothing for the higher ceiling.

- 97e6a0c: Skip the dependency-cycle preflight in `TaskStore.assertNoDependencyCycle` when the new task or update has no dependencies. The FN-5256 cycle-check rollout (e12adeb3f) added an unconditional `listTasks()` call on every write to build the dependency lookup, but an empty dependency list can never form a cycle so the query was wasted work. It also broke fail-open semantics in the same-agent duplicate intake path: tests that stubbed `listTasks` to throw saw the cycle check consume the rejection and propagate "boom" out of `createTask` before the duplicate-intake try/catch could swallow it.
- cf0101b: fix(FN-5256): harden three independent code paths that were losing live task worktrees mid-execution and producing `wrong_toplevel` errors.

  - Executor stale-self-owned classifier (`reconcileSelfOwnedActiveSessionForRemoval`) now requires two additional signals before dropping a same-task registry entry: a process-active probe (`executingTaskLock.has`) and a minimum-idle window (default 5s) since the entry was registered. This closes the pause/resume race where the new executor cycle hadn't repopulated `activeWorktrees` yet and the old session's registry entry was reaped under a still-live shell. The post-throw reconcile in `removeOwnWorktreeWithReconcile` and the `removeWorktree` defensive reconcile in `worktree-backend.ts` route through the same hardened path.

  - Pause-before-park now synchronously awaits agent/step/workflow session disposal via a new `awaitAbortInFlightTaskWork` method, so by the time `parkTaskAfterWorkflowStepPause` calls `moveTask("todo")` the spawned shells are already reaped and any fast re-dispatch sees a clean slate. The user-initiated pause handler on `task:updated` was collapsed onto the same await path for the same reason.

  - Self-healing `reconcileTaskWorktreeMetadata` now normalizes both sides via `realpathSync` (with ENOENT fallback) before comparing the task worktree against the registered set, fixing the macOS `/private/var/...` false-stale flag. It additionally refuses to clear `worktree`/`branch` metadata for in-progress or in-review tasks — those go through `task:auto-recover-worktree-metadata-skipped-active` audit events and leave executor-level recovery in charge.

  - The `task:moved`-away and `task:deleted` listeners now track an awaited disposal promise per task. A re-dispatch (`task:moved` → in-progress) awaits any in-flight disposal for the same task before calling `execute()`, so a fast bounce (in-progress → todo → in-progress) can no longer race the conflict-cleanup path against a still-live shell. `awaitAbortInFlightTaskWork` claims each session surface synchronously before awaiting its abort, so concurrent disposal calls dedupe naturally and the legacy fire-and-forget `abortInFlightTaskWork` has been removed.

- c824810: Fix reuse-task-worktree merge mode (FN-5279) never applying the squash commit to the project root's local integration branch. The merger detaches HEAD in the task worktree and lands the squash on the detached HEAD; previously nothing advanced the project root's local `main`, so changes never appeared on the user's `main` (and any subsequent `pushAfterMerge` would push the stale ref or fail outright because `parsePushRemoteTarget` can't resolve a branch from a detached HEAD). A new step 5c now applies the squash to the project root's integration branch via `git merge --ff-only`, falling back to a regular merge with AI conflict resolution if `main` has diverged. Push-after-merge (when enabled) now runs from the project root where the integration branch was just advanced.
- 1983dac: Engine reliability: prevent the FN-5345 in-review wedge class.

  - Fusion task worktrees now install a `prepare-commit-msg` empty-commit guard that refuses `git commit --allow-empty` and other zero-staged-diff commits, while still allowing legitimate amend / merge / squash / cherry-pick / revert / rebase paths. Amend detection scans `ps -o args=` (with `/proc/$PPID/cmdline` fallback for Alpine/busybox) tokenized, stopping at the first message-supplying flag (`-m`, `-F`, `--message`, `--file`) so a commit message containing the substring `--amend` cannot bypass the guard.
  - Merger gains an early empty-own-diff fast-path in `reuse-task-worktree` integration mode: branches with own commits but zero net tree change vs merge-base now auto-finalize as no-op BEFORE any reuse-handoff acquisition runs, preventing `registered-branch-mismatch` + `merge-deadlock-detected: verified content not on main` wedges. The fast-path best-effort cleans up the stranded worktree and `fusion/<id>` branch so empty-own-diff residuals do not accumulate.
  - `classifyOwnedLandedEvidence` also detects the empty-own-diff case and returns `proven-no-op` so downstream self-healing and post-handoff finalize paths benefit too.
  - Merger's reuse-fallback path now consults `git worktree list --porcelain` before creating a new worktree, reusing extant usable registrations of `fusion/<id>` and pruning stale ones, eliminating FN-5083-class branch-registration double-registration. The direct-reuse shortcut is guarded by FN-4811 (refuses paths owned by a different task in `activeSessionRegistry`) and FN-4954 (skipped when `recycleWorktrees=true` with a pool attached, so `WorktreePool.acquire` lease bookkeeping stays consistent). Two new audit subtypes (`merge:reuse-fallback-pruned-stale-registration`, `merge:reuse-fallback-reused-existing-registration`) replace the prior overloading of `merge:reuse-fallback-new-worktree` for these cases.

- 57dbff4: Fix `fn backup` corrupting the live database. The paired-central-backup feature opened a second `node:sqlite` connection against the live `fusion.db` and ran `PRAGMA wal_checkpoint(TRUNCATE)` before the file copy. A `node:sqlite` SIGSEGV mid-checkpoint (a known recurring crash mode for this codebase) could leave the main DB file extended-but-zeroed. Backups now copy the main DB plus any sibling `-wal`/`-shm` files via plain `cp`; SQLite replays the WAL on first open, so uncheckpointed pages are preserved without us ever opening a second connection against the live database.
- 1bffa22: fix(FN-5483): allow merger-driven commits past the identity-guard pre-commit hook (detached HEAD false-positive).

  The reuse-task-worktree merge path intentionally detaches HEAD at the integration target before running squash and verification-fix ceremonies. The identity-guard hook (`buildIdentityGuardHook`) refused every such commit because `HEAD_BRANCH=detached` never matches the owning task branch, surfacing as `merge-deadlock-detected: requires manual intervention — verified content not on main` on FN-5441 and FN-5446.

  The hook now honors a `FUSION_MERGER_BYPASS_IDENTITY_GUARD=1` env-var bypass (gated to the exact value `"1"`), set only on merger-driven `git commit` calls. The marker is placed after the `TASK_FILE` check so non-fusion worktrees stay no-op, and before `EXPECTED_BRANCH` so detached HEAD never reaches the refusal printf. Agent commits never set this env, so the guard still catches executor/reviewer misuse. `buildCommitMsgTrailerHook` and `buildPrepareCommitMsgEmptyGuardHook` are unchanged and continue to run on every merger commit, preserving FN-5089 trailer attribution and FN-5345/FN-5377 empty-commit refusal.

- 2d425b1: fix: clear scheduler-side `status='queued'`, `blockedBy`, and `overlapBlockedBy` when a task transitions into `in-review` so the merge gate is no longer permanently blocked by stale todo-dispatch markers.

  Repro: a task that picked up `status='queued'` while waiting in `todo` (e.g. file-scope overlap with a higher-priority queued peer) and then completed and was handed off to `in-review` — directly via `handoffToReview` or indirectly via stranded-completed-todo recovery — would carry the queued flag into review. Every subsequent merge attempt failed with `Cannot merge <id>: task is marked 'queued'`, and the in-review stall surface kept re-firing `[no-worktree-no-merge-confirmed]` without progress. Ghost-review → todo → scheduler re-queue → stranded → in-review formed a steady-state loop.

  Fix: `TaskStore.moveTaskInternal` now treats `queued`/`blockedBy`/`overlapBlockedBy` as todo-only dispatch state and scrubs them on every transition into `in-review`. Failed/awaiting-\* statuses are unaffected.

- d947197: Engine reliability: auto-recover merge handoff from HEAD drift when the branch ref is authoritative.

  - `acquireReuseHandoff` previously refused outright with `head-branch-mismatch / unexpected-branch` whenever the worktree's HEAD pointed at anything other than `fusion/<id>` (detached, recycled to `main`, on a sibling branch). The existing case-mismatch autocorrect did not cover these states, leaving FN-5339-class tasks wedged in review even though their branch ref still held a clean, task-attributed lineage.
  - New `isBranchAuthoritativeForTask` helper (in `branch-conflicts.ts`) confirms the expected branch ref exists, its tip carries the `Fusion-Task-Id: <id>` trailer, and the `base..branch` range has no foreign FN-attributed commits.
  - When that probe passes, the handoff now performs a plain `git checkout <branch>` (not `-B`, which would clobber the ref) inside the already-asserted-clean worktree, re-reads HEAD, and emits a `branch:auto-reattach-authoritative` audit. Refusal still fires unchanged when the branch ref itself is missing, missing a trailer, or contaminated — so the FN-5363 strict-lease and foreign-commit protections remain authoritative.

- 5c15031: Make the dashboard's "Refresh health" button actually re-run the SQLite integrity check. The background scheduler in `Database.scheduleBackgroundIntegrityCheck` only ran the check once at engine boot, so once `corruptionDetected` flipped to `true` it was sticky for the life of the process — the refresh action just re-read the same cached flag and the corruption banner could not be cleared even after the user repaired the DB (e.g. via `REINDEX`). `POST /api/health/refresh` now calls a new `TaskStore.refreshDatabaseHealth` which synchronously re-runs the integrity check and updates the cached state before responding.
- 24686ca: Stop losing uncommitted dev edits during task merges. Two fixes to the merger:

  1. The pre-merge autostash in `stashUnrelatedRootDirChanges` no longer silently proceeds when stash creation fails over a dirty working tree. It now throws `AutostashCreationFailedError`, which the merger catches and surfaces to the task feed before any destructive `git reset --hard` / `git clean -fd` runs — your edits stay in the working tree.

  2. `acquireReuseHandoff` no longer refuses the handoff on a dirty reused task worktree (the FN-5138 "Merge handoff refused (working-tree-dirty)" failure). It now autostashes the dirty content (`git add -A` → `git stash create` → `git stash store -m fusion-reuse-handoff-autostash:<taskId>:<ts>`), emits a `merge:reuse-handoff-autostash` audit event with the stash SHA and a recover command, and lets the merge proceed.

  The new failure mode `dirty-worktree-autostash-failed` is reserved for the (rare) case where stash creation itself fails — so the operator can distinguish "we tried and failed" from the old "we refused to try."

- a7ad30f: Mobile (iOS): the bottom navigation bar no longer slides up when the on-screen keyboard appears. The viewport-compensation offset that pulls fixed elements back into the visible area (intended for Android ICB quirks / pinch-zoom) was also being driven by the keyboard's shrunken `visualViewport.height` on iOS, pushing the nav bar above the keyboard. The nav now ignores that offset while `keyboardOpen` is true and stays pinned at the page bottom — the keyboard simply covers it.
- a2a5db8: Engine reliability: better diagnostics + clean-baseline reset on phantom finalize.

  - `commitOrAmendMergeWithFixes` previously swallowed all unexpected errors as `reason: "unknown-phantom"` and the two callers re-threw a `verification fix finalize failed (unknown phantom)` error with no surface area beyond the SHAs. FN-5422-class tasks wedged in review with no actionable signal in the failure message.
  - The catch now captures the original error message and runs an `isBranchAuthoritativeForTask` probe (existing branch ref carries this task's `Fusion-Task-Id` trailer + foreign-contamination check against base). When the branch ref is authoritative — meaning the AI's work is safely stored on `fusion/<id>` and only the in-merge attempt's integration worktree drifted — the catch resets rootDir to `preAttemptHeadSha` and returns `reason: "branch-ref-ahead-reset"`. The next merge attempt then starts from a known-good baseline instead of inheriting half-built squash state.
  - Verification-fix and build-verification-fix callers now include the original error and the branch-authority probe outcome in the thrown error, so operators see the actual failure cause (e.g. diff-volume regression, file-scope violation, transient git error) rather than `unknown phantom`.

- 5848606: Engine reliability: post-session branch-attribution audit catches contamination within minutes instead of days.

  - The executor already checks branch contamination at _acquisition_ time (`assertCleanBranchAtBase`) and at _reclaim_ time. The gap was the _active session window_ itself: commits added to `fusion/<id>` between acquisition and merge handoff went undetected until merge-time refusal, which is how FN-5233 ended up with two untrailered `feat(FN-5353):` commits sitting on `fusion/fn-5233`.
  - New `reportBranchAttribution(repoDir, branch, baseSha, taskId)` walks `base..branch` and classifies every commit into four buckets: `ownTrailed` (subject tag + `Fusion-Task-Id` trailer — healthy), `ownUntrailed` (subject tag but missing trailer — signals the commit-msg hook didn't fire), `foreign` (different FN-id via subject or trailer — contamination), and `unattributed` (neither — typically a hand-merge or plumbing commit).
  - Wired into the executor's post-session path (right after `captureModifiedFiles`): if any anomaly bucket is non-empty, the executor logs a structured `branch:attribution-anomaly` audit event and a task log entry. Failures in the audit itself are caught and warn-only — the audit must never destabilize a completing session. New `branch:attribution-anomaly` and `branch:auto-reattach-authoritative` git-mutation types accept the structured metadata.
  - Five new vitest cases cover the four anomaly buckets and the empty-range no-op.

- fbf7e2c: Dashboard board no longer squeezes all 6 columns into the visible width on tablet-sized viewports (769–1024px). Columns now keep a 260px minimum and the board scrolls horizontally, matching desktop behavior. Previously the tablet rule used `minmax(0, 1fr)` with `overflow-x: hidden`, collapsing columns to ~130–170px wide on Android tablets and forcing task card titles to stack one word per line.
- d90da81: Coerce `task.description` to an empty string when persisting in `TaskStore.getTaskPersistValues`. The `description` column is `NOT NULL`, so a task with a missing description previously failed insertion with a constraint error. Defaulting to `""` mirrors the existing `?? null` / `?? 0` treatment of other optional fields.
- 2d661df: fix(engine): prevent worktree-pool branch creation from inheriting a previous occupant's tip, and auto-reanchor branches that already inherited foreign commits.

  - `WorktreePool.prepareForTask` now rejects empty/`HEAD` base values and verifies post-detach HEAD matches the resolved base SHA before creating the branch. This closes the FN-5432 / FN-5255 contamination pattern where recycled worktrees branched from a stale HEAD (reflog: `branch: Created from HEAD`) and pinned the new task's tip to the previous task's commit.

  - `SelfHealingManager` now attempts a foreign-only contamination reanchor before pausing a task with `branch-conflict-unrecoverable`. When the task's branch carries only foreign commits (no own work), the branch is reset back to its base via the existing `recoverForeignOnlyContamination` path instead of stranding the task for human adjudication.

- 93b11c6: Atomic in-review handoff: introduce `TaskStore.handoffToReview` that performs the column move and `mergeQueue` enqueue inside a single transaction, and migrate every executor + self-healing site that promotes a completed task into `in-review` to use it. Direct `moveTask(taskId, "in-review")` writes now emit a `task:handoff-invariant-violation` run-audit event for forensics. Pairs with FN-5242 (queue schema) and FN-5243 (merger lease consumption).
- 9efcf93: Fix Fusion worktree pre-commit identity-guard hook to accept canonical lowercase `fusion/<id>` branches when the on-disk `fusion-task-id` metadata stores an uppercase id, eliminating spurious "refusing commit" rejections that previously required `--no-verify`.
- e908cbc: Downgrade merge-time file-scope invariant violations from task-failing errors to warning-only logs so merges can continue while still recording audit telemetry.
- 9011c21: Fix the Worktrunk integration to probe the canonical `wt` binary, point release metadata at the real `max-sixty/worktrunk` upstream, and fail closed when install metadata is still unverified. This preserves default-off behavior when `worktrunk.enabled=false` and hardens enabled setups that rely on an explicit `worktrunk.binaryPath`.
- b06cf64: Add deterministic external-integration safeguards by introducing a shared integration manifest validator, a triage-time spec evidence gate, and registry contract tests that prevent hallucinated third-party repo/binary/checksum metadata from landing.
- 232a9fe: Fix main chat composer (direct chat and rooms) so it visually grows on
  multi-paragraph paste up to the 640px cap, matching QuickChat behavior.
  The 640px cap from FN-5146 was already in place but an ancestor layout
  constraint was clipping the rendered height.
- fd202e9: Remove the `fn task branch-recovery` surface and retire orphan-branch auto-rescue wiring.

  Fusion now treats orphan `fusion/*` branches as operator-managed git state: branch conflicts still fail loudly with diagnostics, and operators resolve/reclaim/discard branches manually with standard git tooling before retrying.

- a8715ed: Self-healing: gate every backward-moving recovery stage on triple proof (dead session + unusable worktree + no recent executor activity). Stages that cannot satisfy the predicate are downgraded to observation-only, emitting task:<stage>-no-action audit events instead of lifecycle moves. Authoritative per-stage disposition lives in docs/self-healing-backward-move-audit.md. Companion to FN-5337.
- 1a5aff9: Self-healing: remove speculative auto-requeue from `recoverOrphanedExecutions`. The sweep no longer calls lease-manager recovery/reconcile, no longer writes `status: "stuck-killed"` or clears `worktree`/`branch`, no longer writes the `Auto-recovered orphaned executor task` log entry, and no longer moves tasks back to `todo`.

  `recoverOrphanedExecutions` is now observation-only and emits `task:orphan-detected-no-action` run-audit events plus `[orphan-detected]` diagnostics when stale in-progress candidates are detected. Proof-based lifecycle recovery remains owned by `recoverInProgressLimbo`, `RestartRecoveryCoordinator`, and explicit executor/merger failure paths (fixes FN-5279 false-positive class).

- 216c32b: Manual task retry now resets the full persisted retry-budget counter set (and `nextRecoveryAt`) across CLI, pi extension, and dashboard retry surfaces, so retry badges/details no longer stay inflated after a user-triggered fresh attempt.
- 8df21a6: Fix in-review merge stall under the new mergeIntegrationWorktree=reuse-task-worktree default: strict targetTaskId leasing prevents cross-task lease bleed, and missing task.worktree always triggers the reacquire fallback instead of misrouting handoff gates against the project root.
- dbccdb1: Harden cloudflared auto-install (dashboard remote-access opt-in flow): add a pinned release manifest and SHA-256 verification, mirroring the FN-5320 Worktrunk pattern. Auto-download fails closed in `upstream-pending-verification` mode; package-manager paths (`brew`, `winget`) are unchanged. Replaces the previous unverified `releases/latest/download` direct-curl install path.
- a04ba3c: Coerce null or undefined `task.description` values to an empty string when persisting TaskStore rows.
- c3890a9: Improve soft-deleted blocker recovery so blocked tasks become schedulable without manual intervention. `SelfHealingManager.clearStaleBlockedBy` now emits an explicit `soft-deleted at ...` reason when a stale blocker is a soft-deleted row, and the scheduler now reconciles downstream `blockedBy`/dependency state immediately on `task:deleted` events to reblock on remaining live deps or unblock tasks in the same tick.
- 31c71a3: Surface exhausted soft-deleted in-review blockers through opt-in visibility paths so operators can diagnose stalled dependent chains without direct DB access. `fn_task_show` now falls back to include soft-deleted task reads and prints a `[SOFT-DELETED at ...]` marker, while `fn_task_list` adds an `includeDeleted` flag for listing hidden blockers.

  Also adds dashboard/API visibility with `GET /api/tasks/exhausted-in-review` (including `?includeDeleted=true`), `GET /api/tasks/:id?includeDeleted=true`, and a ReliabilityView panel for exhausted hidden blockers plus blocked dependents.

- 3ccb132: Fix Windows worktree creation and cleanup by replacing POSIX shell `mkdir -p` / `rm -rf` calls in worktree setup paths with cross-platform Node.js filesystem APIs.

## 0.32.0

### Minor Changes

- b772881: Add a new project setting, `chatAutoCleanupDays` (default off), to automatically remove idle chat sessions and chat rooms during periodic self-healing maintenance.
- ff71746: Add a new project setting, `mailAutoCleanupDays`, to auto-prune old inbox/outbox messages during self-healing maintenance. The setting defaults to `0` (off) and supports retention windows of 7, 14, 30, 60, or 90 days.
- a34e77a: Documented Fusion secrets management across architecture, storage, settings, and agent guidance, including encrypted project/global secret stores and access-policy behavior. Added secrets subsystem reference docs plus planned integration notes for agent secret reads, worktree env materialization, and cross-node sync endpoints.
- dde2d06: Implement `.env` secrets materialization pipeline: honor `secretsEnv` project settings (enabled/filename/overwritePolicy/keyPrefix/requireGitignored), gate writes behind `git check-ignore`, emit `secret:env-write` / `secret:env-write-skipped` / `secret:env-cleanup` / `secret:env-cleanup-skipped` run-audit events, and clean up fingerprint-matching `.env` files on worktree teardown.
- e9ef40f: Add cross-node secrets sync endpoints (`POST /api/nodes/:id/secrets/push`, `POST /api/nodes/:id/secrets/pull`, `POST /api/secrets/sync-receive`, `GET /api/secrets/sync-export`) with shared-passphrase envelope (scrypt → AES-256-GCM) and Bearer-apiKey auth on inbound routes. Passphrase is stored locally encrypted under the master key (reserved `__sync_passphrase__` row, `access_policy="deny"`) and is never transmitted or echoed.
- 56a7178: Add `priority` field to `fn_task_update` MCP tool so agents can rebalance task urgency after triage.
- b078a81: Add deterministic automated follow-up dedup for verification failures and related engine-created recovery tasks.
- 75a7127: Add a "Connection → Change Launch Mode…" menu item to the Fusion desktop app so users can switch between Run Locally and Connect to Remote after the initial chooser. It resets the persisted desktop mode, stops the embedded runtime, and reloads the dashboard so the launch gate re-prompts.
- b143f6c: Add a desktop launch gate so the packaged Fusion app prompts the user to either run Fusion locally (starts the embedded runtime and points the dashboard at it via `?serverBaseUrl=…`) or connect to a remote Fusion server, instead of immediately showing a "can't reach backend" error.
- edfd6e4: Add `worktreesDir` project setting to place task worktrees outside the project root. Supports absolute paths, paths relative to the project root, `~` expansion, and the `{repo}` token. Defaults to the existing `<projectRoot>/.worktrees` behavior when unset.
- 9e87de0: Make OpenRouter a first-class provider: send HTTP-Referer/X-Title attribution headers, prefer /api/v1/models/user when an API key is configured, expose openrouterModelFilters and openrouterProviderPreferences in settings, and forward provider routing prefs into chat completion requests.
- 9574ba4: Add `worktrunk` settings group (`worktrunk.enabled`, `worktrunk.binaryPath`, `worktrunk.onFailure`) to both global (`~/.fusion/settings.json`) and project (`.fusion/config.json`) tiers, with field-level project-overrides-global precedence. CLI `fn settings set worktrunk.<field>` is supported in both scopes. This is settings plumbing only; the worktree backend that consumes these keys ships in a follow-up.
- 9ac503f: Add a settings-driven WorktreeBackend abstraction with native git as default and opt-in worktrunk create fallback behavior.
- 3d9260e: Complete worktrunk backend delegation for create/sync/prune/remove plus worktrunk-aware worktree layout resolution when `worktrunk.enabled` is on.
- 06810e4: Auto-install flow for the optional worktrunk worktree backend: when `worktrunk.enabled` is on and the binary is missing, Fusion downloads a SHA-256-verified pinned release (v0.4.2) into `~/.fusion/bin/` with a `cargo install` fallback under `network_api` approval policy. Pinned release supports `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`; Windows falls back to cargo-only. Install attempts emit run-audit `binary:install-*` events.
- 8b371ba: Fail-hard by default when a delegated worktrunk operation fails: the task is paused with `pausedReason: "worktrunk_operation_failed"` and the underlying stderr is surfaced in the dashboard. Set `worktrunk.onFailure: "fallback-native"` to instead fall back transparently to Fusion's built-in worktree-pool and receive a one-shot dashboard alert per task.
- 196b7e4: Fusion now supports an optional integration with the [worktrunk](https://github.com/max-sixty/worktrunk) CLI for per-task worktree management. It is off by default and can be enabled with `worktrunk.enabled` (global with project overrides).

  When enabled, Fusion delegates worktree create/sync/prune/remove operations to worktrunk and adopts worktrunk’s directory layout. You can set `worktrunk.binaryPath` to use a specific binary, or rely on auto-install on first use (gated by the `network_api` action gate).

  `worktrunk.onFailure` defaults to `"fail"` (pause the task on a worktrunk error), with opt-in `"fallback-native"` if you want Fusion to fall back to native worktree handling. When `worktrunk.enabled = true`, worktrunk layout takes precedence and `worktreesDir` is ignored.

- 4ce58f2: Add `sandbox.*` project settings schema, validators, and per-task PROMPT override parser (no behavior change; foundation for the SandboxBackend rollout).
- c0f9dde: Add WorktreeBackend abstraction (native default + worktrunk scaffold) selected by `worktrunk.enabled`. CLI subcommand mapping arrives in FN-4623.
- 43ae0ee: Add WorktreeBackend abstraction (native default + worktrunk scaffold) selected by `worktrunk.enabled`. Real worktrunk CLI subcommand mapping arrives in FN-4623.
- 3defcbe: Disable the worktrunk auto-install path. The pinned cognitive-engineering-lab/worktrunk v0.4.2 release is no longer reachable (see FN-4704/FN-4705), so `installWorktrunk()` now throws `WorktrunkInstallFailedError` immediately. Users who opt into `worktrunk.enabled` must set `worktrunk.binaryPath` or place `worktrunk` on `$PATH`. Auto-install will return once an authoritative upstream release source is re-established. `WORKTRUNK_PINNED_RELEASE` and the release-download helpers are removed from `@fusion/engine` exports.
- b94eae4: Add minimal Goals dashboard view (Slice 1 of Goals-as-strategic-layer mission). Lazy-loaded component renders active-goal list with soft-warning at 3 active goals and hard-error when attempting to exceed the 5-active cap. Uses mock data adapter pending the GoalStore backend slice.
- 6afd273: Goals dashboard view is now wired into the Header overflow menu and Mobile More sheet, gated by the `goalsView` experimental feature flag.
- 293441a: Chat rooms now support `/clear` and `/new` in the composer by clearing the active room transcript instead of sending those commands as normal messages. Added a new API route, `DELETE /api/chat/rooms/:id/messages`, to bulk-clear all messages in a room while preserving room identity and membership.
- 7b48387: Add Create-PR entry points across the dashboard (task detail header, task card quick action,
  in-review auto-prompt, review tab) and a new `fn pr create <task-id>` CLI command. The legacy
  `fn task pr-create` remains as an alias.
- 0338b37: Add live PR check streaming in the dashboard PR panel, including failing-check surfacing with direct GitHub details links, and introduce `GET /api/tasks/:id/pr/checks` for all check runs with required-check rollup status.
- 3e944ed: Fusion now includes a redesigned pull request creation flow with AI-generated title/description suggestions and support for repository PR templates. You can open PR creation from new dashboard entry points (task detail header, task card quick action, in-review prompt, and merge/review modal) or from the CLI with `fn pr create`. A new PR status panel shows live checks and review comments, supports merging from the dashboard, and can optionally enable auto-merge when checks are green. When a PR merges, the task auto-transitions to done; if reviewers request changes, the task is routed back to todo with that feedback visible in Fusion.
- 937bed9: Add hybrid master-key resolver (`MasterKeyManager`) backing the upcoming secrets subsystem. Tries the OS keychain via optional `keytar` dependency, falls back to a `0600` `~/.fusion/master.key` file.
- 01276d6: Quick Chat and ChatView now support sending file attachments when a chat room is active. Added room attachment upload and fetch endpoints (`POST /api/chat/rooms/:id/attachments`, `GET /api/chat/rooms/:id/attachments/:filename`) and wired room message sends to upload pending files before persisting room messages.
- 5233bc9: Add board-health self-healing levers in the engine: paused-scope decay rebound for blocked paused holders, meta-task chain auto-close for resolved/stalled recursion, and a board-stall sweep with verification-gated ntfy escalation. This adds new project settings (`pausedScopeDecayMs`, `metaTaskStallAutoCloseMs`, `boardStallSweepWindowMs`, `boardStallBlockedGrowthThreshold`) plus run-audit events for rebound/archive/stall outcomes.
- 040a909: Add dashboard UI panel and `/api/secrets/sync-passphrase` routes to configure the cross-node secrets-sync passphrase. Reserved `__sync_passphrase__` row is filtered out of the standard secrets list. Plaintext is never returned over HTTP.
- f9c0b93: Add `failureNotificationMode: "terminal-only"` to suppress ntfy/webhook
  failure notifications while the engine is still auto-retrying a task.
  Notifications fire only once the task is paused or escalated to in-review.
  Default behavior (`sticky-only`) is unchanged.
- aad1219: Dashboard PR panel now supports tasks linked to multiple GitHub PRs. `Task.prInfos` is the new canonical list; `Task.prInfo` is preserved as the primary-PR mirror for back-compat. PR refresh, unlink, and self-healing conflict reclaim all operate per-PR.

### Patch Changes

- 3ea9bbb: Add reliability stats reset support with a new `/api/health/reliability/reset` endpoint and enhance the Reliability dashboard view with drill-down details, empty-day filtering, and reset baseline visibility.
- e1bda2a: Chat rooms now show the same Latest jump-to-bottom button as direct chats.
- 73b4717: Fix Mission Manager mission detail refresh behavior so expanded milestones/slices are preserved and selected milestone acceptance criteria remain visible across live updates.
- fa9648b: Planning mode, mission interview, and milestone/slice interview AI sessions now have read-only access to `fn_task_list` and `fn_task_get` so they can reference existing backlog tasks while interviewing the user.
- 3ff683a: Add internal `SandboxBackend` abstraction to the engine command-execution path (native passthrough only; no behavior change). Foundation for FN-4637 (bubblewrap), FN-4638 (sandbox-exec), FN-4639 (settings), FN-4640 (audit), FN-4641 (action-gate), FN-4642 (container) follow-ups.
- 41ceae0: Add an opt-in Linux `bubblewrap` sandbox backend with policy-to-`bwrap` argument translation, backend availability detection, and native fallback support.
- aeada25: Add opt-in macOS `sandbox-exec` backend for the engine `SandboxBackend` abstraction. Default backend remains `native`; enable via `sandbox.backend = "sandbox-exec"`. Honors `failureMode: "fail-hard" | "fallback-native"`. Port 4040 and `.fusion/` are denied unconditionally.
- 7c15be8: Add `sandbox` run-audit domain with `sandbox:prepare`/`sandbox:run`/`sandbox:failure`/`sandbox:fallback` lifecycle events emitted from the engine's `SandboxBackend` wiring sites, and surface them through the dashboard's run-audit API (filter parser, normalized event domain, timeline `auditByDomain.sandbox` bucket).
- 7805645: Add `sandbox_provisioning` action-gate category, `sandboxProvisioning` project setting,
  `resolveSandboxProvisioningPolicy` in @fusion/core, and a
  `requireSandboxProvisioningApproval` engine helper. Lays the approval seam that future
  bubblewrap (FN-4637), sandbox-exec (FN-4638), and container (FN-4642) backends use to
  gate first-time host bootstrap.
- 5253cc1: Prototype optional rootless container `SandboxBackend` (Podman-first, Docker-compatible) behind the FN-4636 seam. Off by default; reachable only via explicit `resolveSandboxBackend({ backendId: "podman" | "docker" })`. No settings, audit, or action-gate wiring yet (FN-4639/FN-4640/FN-4641).
- cc7b9f3: Extend internal `SandboxBackend` abstraction to cover the spawn-based verification runner (`runVerificationCommand` / `execWithProcessGroup`) via a new `runStreaming` method on the backend. Native passthrough only — no behavior change. Foundation for FN-4637/FN-4638 to wrap the verification path the same way they wrap `runConfiguredCommand`.
- 939b68e: Auto-finalize in-review tasks when self-healing or merge fast-path logic can prove task content already landed on the base branch, clearing soft blockers (`paused`, stale `failed` status, and residual error) while still preserving hard-blocker guardrails for incomplete steps, awaiting-user-review states, and pre-merge workflow failures.
- 5975931: GitHub tracking issues are now created for every task-creation path (pi extension tools, CLI commands, agent delegation, and mission/feature triage), not only dashboard HTTP routes.
- 7942fb0: Gate sandbox backend settings behind `experimentalFeatures.sandbox` until the rollout completes.
- c7ba63c: Missions UI: surface per-feature acceptance criteria in the milestone Assertions panel even when the milestone itself has acceptance text. Fixes FN-4652 (refinement of FN-4613).
- df28dcf: GitHub Copilot login (Settings and Onboarding) now shows the device code and auto-copies it to the clipboard before opening the GitHub verification page — users click "Open GitHub" when ready instead of having the new tab steal focus immediately. The device-code panel now spans the full width of the provider card.
- a88857a: Persist `mergeDetails.rebaseBaseSha` whenever a rebase merge base is captured, and update self-healing landed-commit stats lookup to use rebase range shortstat (`base..sha`) when available so stale tip-only merge stats are automatically repaired.
- a27614f: Routine-runner now threads a `RunAuditor` through `resolveSandboxBackend()` so user-configured routine commands emit `sandbox:prepare`/`sandbox:run`/`sandbox:failure` lifecycle events alongside executor and merger commands, closing the FN-4640 observability gap.
- f7a7038: Ensure duplicate/refine API task creation paths also attempt GitHub tracking issue creation as best-effort behavior.
- 2739259: Suppress false `missing-evidence` warnings on verification-only / no-code follow-up tasks by classifying branch-absent no-owned-commit finalizes as benign `no-changes-finalized` and clearing stale `modifiedFiles` snapshots.
- 401094c: Right-align the linked GitHub issue chip on in-review TaskCards, matching the in-progress placement.
- 9a1c904: Add a new project setting `doneAutoArchiveDays` (default `0`) to control done-task auto-archive retention in days. When set to a value greater than `0`, it takes precedence over `autoArchiveDoneAfterMs` for periodic self-healing auto-archive sweeps.
- e5c9c7a: Annotate wake-on-message heartbeat runs whose inbox snapshot is already empty with consumed-message wake reasons, plus wake-delta inbox snapshot context.
- 7c0624c: Fix settings sync push/receive payload contract: the push endpoint now includes `sourceNodeId` so the inbound `/api/settings/sync-receive` validator no longer rejects round-trips with a 400.
- 6721005: Add a new dashboard `PrCreateModal` component with AI metadata generation, preflight checks, base-branch selection, draft mode, reviewer/assignee/label pickers, commit/file preview, and retryable PR creation errors. Also add dashboard client API wrappers for PR metadata, preflight, and options endpoints.
- 3d7e737: Sync GitHub PR reviews and review comments into Fusion task comments, expose a PR reviews API for dashboard threading, and auto-move in-review tasks back to todo when GitHub review decision changes to CHANGES_REQUESTED while preserving progress/worktree and saving reviewer feedback context.
- ae740bd: Structured surfacing of GitHub CLI / API errors with retry affordances in the dashboard PR UI and `fn pr create` CLI flow.
- db7b196: GitHub tracking-issue creation no longer blocks `POST /api/planning/create-task` and `POST /api/planning/create-tasks` responses; it now runs in the background.
- b594160: Wire `HybridExecutor` into serve/dashboard/daemon startup behind `shouldUseHybridExecutor` gating. This adds optional multi-project runtime orchestration (project runtimes + node health monitoring) while preserving default single-project local behavior unless the gate enables it.
- 11012b4: Add a triage `fn_task_search` tool that searches across task history (including done and archived tasks) and strengthen duplicate-check guidance to require keyword search before filing new tasks.
- 023a0cc: GitHub tracking-issue creation now searches the target repo (open and closed
  issues) for likely duplicates before opening a new issue, keyed on the task's
  File Scope paths and symptom keywords. Matches link the existing issue to the
  Fusion task. Opt out with project setting `githubTrackingDedupEnabled: false`.
- c6e9782: Dashboard reload no longer briefly hides the UI behind a full-screen loader when project data is already cached.
- fea0b51: Add `oauth-token-expired` notification event so users are notified when a provider OAuth token (Codex, Claude, etc.) expires and needs re-authentication.
- 7ab3f7a: Internal: add AES-256-GCM secret cipher primitive in @fusion/core (foundation for upcoming secrets subsystem; no user-visible behavior yet).
- f0df7cb: Internal: introduce `SecretAccessPolicy` vocabulary (`auto`/`prompt`/`deny`) and `resolveSecretAccessPolicy()` resolver plus a global `secretsAccessPolicy` default setting. Foundation for the upcoming secrets subsystem; no user-visible behavior yet.
- 4d5e296: Dashboard top progress bar now also reflects task list revalidation, not just project loading.
- 246609a: Dashboard Settings → Project → General → GitHub Tracking now exposes a
  toggle for `githubTrackingDedupEnabled`, so users can opt out of the
  pre-creation duplicate search without editing `.fusion/config.json`.
- 3f8a5e6: fix(FN-4806): silently recover when worktree/branch reclaimed mid-retry

  When the executor's no-`fn_task_done` retry loop detects that a task's worktree or branch was reclaimed by an engine-side housekeeping path (FN-4546 stale-active-branch reclaim, FN-4742 self-healing removals, session-start unusable-worktree), it now requeues the task to `todo` silently with preserved progress. The task is no longer marked `failed`, `taskDoneRetryCount` is no longer burned, and `onError` is no longer surfaced — this is engine self-heal, not an agent failure. The genuine "agent finished without calling fn_task_done after N retries" exhaustion path is unchanged.

- 4c26aa6: fix(FN-4811): refuse to force-remove worktrees actively bound to live sessions

  Adds a hard liveness gate to the executor's conflict-recovery paths so that
  `cleanupConflictingWorktree` and `handleBranchConflict` refuse to remove a
  worktree that is currently bound to an active executor session — either via
  the in-memory `activeWorktrees` map or via a non-done, non-paused
  `in-progress` task in the store. When the requesting task has
  `executorAllowSiblingBranchRename`, the recovery flow now falls through to
  the suffix-rename path instead of force-removing the live owner's worktree.

  This is the canonical fix for the FN-4781/FN-4804 cascade:
  "assigned worktree path disappeared mid-task", two parallel runs for the
  same task alive simultaneously, cross-task contamination, and post-merge
  "branch tip misbound but content found on main" rescues firing on every
  successful merge. The new `findActiveWorktreeOwner()` helper centralizes
  the liveness check across both gating points.

- 8bef306: fix(FN-4811): close concurrent-execute race that produced parallel runs for the same task

  `TaskExecutor.execute()` had an async race: after the synchronous `this.executing.has(task.id)` check, the code awaited `shouldDeferForHeartbeat(...)` BEFORE adding to the `executing` Set. Two concurrent `execute()` calls (scheduler dispatch + `task:moved` listener + restart-recovery) could both pass the check, both yield on the await, then both add to the Set and both proceed to create the same worktree.

  Production signature (FN-4814, FN-4811):

  ```
  01:30:56  [runA-caoe]  Worktree created at /Users/eclipxe/Projects/kb/.worktrees/bright-mesa
  01:30:56  [runB-w23q]  Worktree created at /Users/eclipxe/Projects/kb/.worktrees/bright-mesa
  01:30:58              worktree liveness assertion failed: not_usable_task_worktree
  ```

  This is the canonical source of FN-4781/FN-4804/FN-4814/FN-4811 mid-task worktree disappearance and cross-task contamination — every other guard in the stack (FN-4811 active-session gate, self-healing reclaim defer, etc.) was patching the _symptoms_ of the duplicate-run race.

  Fix: claim the executing slot synchronously immediately after the `has()` check, release it on the heartbeat-defer early return. Closes the race window entirely.

- 86237c9: fix(FN-4811): unblock `@fusion/engine` typecheck so verification bootstrap can run

  Restores `pnpm --filter @fusion/engine build` after a stack of TypeScript regressions blocked every merge. Symptoms: every task hitting pre-merge verification failed with "Verification bootstrap preamble failed — workspace dist artifact rebuild did not complete" because the bootstrap shells `pnpm --filter @fusion/engine build` and that compile was erroring on 17 type issues.

  Fixes:

  - Remove duplicate `RemovalReason` re-export in `worktree-pool.ts` (`export type` + `export` for the same identifier produced TS2300 "Duplicate identifier").
  - Add `worktree:removal-refused-active-session` and `worktree:removal-forced-over-active-session` to the `GitMutationType` union in `run-audit.ts` so the new FN-4811 audit events are accepted.
  - Update `self-healing.test.ts` `vi.mock("../worktree-pool.js")` to mirror the production `RemovalReason` const exactly (was missing keys, causing `reason: undefined` to flow into mock calls and confusing error messages).
  - Add `reason: RemovalReason.MergerCleanup` to existing `worktree-backend.test.ts` `removeWorktree` calls now that `reason` is a required parameter.

- f4aa6d7: fix(FN-4811): persist done-task integrity warnings across engine restarts

  `SelfHealingManager.reconcileDoneTaskIntegrity()` previously deduped its
  "Integrity warning: done-task finalize evidence is unproven" emissions via an
  in-memory `Set<string>` per manager instance. Every engine restart created a
  fresh manager, so the periodic sweep re-emitted the same warning for the same
  task on every cycle — producing significant log noise on done tasks legitimately
  lacking on-main evidence (often FN-4811 contamination residue).

  Adds an optional `integrityWarning: { warnedAt, reason }` field on
  `MergeDetails` and persists it on the first warning. Subsequent sweeps (within
  the same process or after restart) check the persisted reason and skip
  re-emitting an identical warning. A different classification reason still
  re-warns and updates the persisted record.

- b6df11a: fix(FN-4811): use process-wide executingTaskLock to block parallel execute() across instances

  After commit 82f80e72f added a per-instance `this.executing.add()` synchronous claim, production STILL produced two `execute()` invocations for the same task ID that both reached "Executor detected stale merge state" and both generated runIds within 1 second of each other (FN-4809: y2nb + 9gde at 02:48:17–18 UTC; FN-4814 / FN-4811 cascade). The only viable explanation is that there is more than one `TaskExecutor` instance in the process (engine restart race, multi-project hybrid runtime, etc.).

  Adds a module-level singleton `executingTaskLock` in `active-session-registry.ts` shared across all `TaskExecutor` instances. `TaskExecutor.execute()` synchronously claims the lock immediately after the `executorLog.log` entry; if `tryClaim()` returns false (someone else owns the lock), the call bails. Every existing `this.executing.delete()` site also releases the lock. Per-instance `this.executing` is kept for back-compat with the many `this.executing.has()` checks throughout `executor.ts`.

  Test setup in `executor-test-helpers.ts` clears the process-wide lock in `resetExecutorMocks()` so it doesn't leak across tests.

- a1b1f9a: fix(FN-4811): defer self-healing reclaim when worktree has an active session

  The `reclaimSelfOwnedBranchConflicts` sweep was force-pausing actively-running tasks. When a task's branch tip was already on `main` (the `tip-already-merged` inspection), the sweep tried `removeWorktree({ reason: SelfHealingBranchConflict })`. The FN-4811 active-session gate correctly refused (the worktree was still bound to a live executor session), but the outer catch escalated the thrown error to `AutoRecoveryDispatcher` with class `branch-conflict-unrecoverable`. The dispatcher's `pause` decision then marked the task `failed + paused + pausedReason="branch-conflict-unrecoverable"` — even though the executor was making real progress (FN-4819 reproduction).

  Fix: at the top of the per-task reclaim loop, check `activeSessionRegistry.isPathActive(task.worktree)` and `continue` for any task whose worktree is currently bound to a live executor/merger/step session. The reclaim retries on the next sweep when the session has finished and the worktree is genuinely free.

- 5c36c0f: fix(FN-4811): scope-leak guard always allows `.changeset/` paths

  The `[scope-leak]` warning was firing on many in-progress tasks for off-scope `.changeset/FN-XXXX-*.md` files (the reproducible signature on FN-4789, FN-4801, FN-4818). By convention every task may add its own changeset entry under `.changeset/` per AGENTS.md's "Finalizing Changes" section, so changeset files are now treated as always-allowed by the scope-leak guard regardless of the task's declared file scope. Cross-task changeset leakage is still caught by stronger downstream guards (file-scope invariant at squash, post-merge audit) at a much higher signal-to-noise ratio.

- dcd6bf6: fix(FN-4811): recover from "validation failed, cannot remove working tree" + collapse broken FN-4806 nested branches

  Two follow-ups stacked on the FN-4811 active-worktree liveness gate:

  1. **Stale conflict-path recovery (was breaking real tasks).** When `git worktree remove --force` fails with `fatal: validation failed, cannot remove working tree`, the worktree directory is missing on disk and the git admin entry is stale. `cleanupConflictingWorktree` now catches that specific error, runs `git worktree prune`, best-effort deletes the branch, and returns success — so the caller can proceed with worktree creation instead of failing 3× with "automatic cleanup failed" (FN-4813 production failure).

  2. **Collapsed broken FN-4806 nested branches.** The previous FN-4806 refactor accidentally nested the genuine "agent finished without calling fn_task_done" failure path inside the silent-recovery branch, so ordinary failures were being silently requeued instead of marked failed. Restored the clean two-branch structure: `else if (retryAbortedDueToReclaim)` silent-recovers, `else` marks failed/onError/burns budget. Also clears `baseCommitSha` on silent recovery (matches the parallel session-start-failure path).

- b2ca02f: Add multi-node coordination hardening for task execution: distributed checkout claim mutex (`tryClaimCheckout`) with node/epoch preconditions, configurable `owningNodeHandoffPolicy` behavior for unavailable owners, and a supported `transitionProjectIsolation` path that can restart project runtimes (with rollback when active-task restart is blocked). Reaffirm scheduler failover and live process migration as explicit non-goals in mesh/multi-project docs.
- 199f317: Add central `taskClaims` table (central DB schema v13) and route `AgentStore.checkoutTask` through it when a `CentralClaimStore` is configured, providing the authoritative cross-node task-claim mutex required by FN-4819 §2. Single-node behavior is unchanged when no claim store is wired.
- 8e3a635: Add a new `task:auto-recover-node-unreachable` run-audit mutation type and emit it across unreachable-owner recovery flows, including mesh lease recovery outcomes and scheduler owning-node handoff decisions.
- df998cb: Add create-time duplicate detection to dashboard task creation. The dashboard now exposes `POST /api/tasks/duplicate-check`, returns `409 duplicate_candidates` for conflicting `POST /api/tasks` requests unless callers acknowledge matches, and supports `bypassDuplicateCheck` for opt-out callers.
- 2adc9fa: GitHub Copilot now appears as logged-in in the dashboard usage dropdown when authenticated via Fusion's Settings → Authentication OAuth flow, in addition to the existing `gh` CLI detection.
- aa6d1c9: fix(FN-4847): discard foreign branch and recreate on `branch-conflict-unrecoverable`

  Branch conflicts where the existing `fusion/<task-id>` branch has stranded commits NOT attributed to the task (cross-task contamination residue from the FN-4781/FN-4804/FN-4814 worktree-race era) previously paused the task with `pausedReason: "branch-conflict-unrecoverable"` and the error message `Auto-recovery failed: branch conflict unrecoverable — Branch fusion/fn-XXX is already checked out at /.../ (tip ..., N stranded commits since ...)`. The task got stuck forever waiting for human adjudication.

  The user has explicitly opted into discard-and-recreate for this case: those stranded commits aren't this task's work, just delete them and move on.

  Changes:

  - `auto-recovery.ts:actionForMode` — in `deterministic-only` mode, `branch-conflict-unrecoverable` now returns `"retry"` (was `"pause"`), routing the failure to the handler instead of the pause path.
  - `auto-recovery-handlers/branch-worktree.ts` — `live-foreign` inspection no longer emits `irreducible-pause`. Instead: force-delete the foreign branch + worktree (safely respecting the FN-4811 active-session gate to avoid yanking live sessions), then requeue the task. The executor's next pickup creates a fresh `fusion/<task-id>` worktree with no conflict.
  - New audit event `branch-worktree:foreign-branch-discarded` records the discard with stranded-commit count and live-ownership status.

- 87bd369: Dashboard's Agents, Documents, Todos, and Chat views now hydrate from a local cache on reload, eliminating the brief empty-state flash before data arrives.
- fe2ebfb: Dashboard's Missions, Insights, Research, Evals, and Mailbox views now hydrate from a local cache on reload, eliminating the empty-state flash before data arrives.
- a3e8c8f: Reconcile docs/secrets.md and docs/architecture.md with the FN-4867 secrets sync surfaces that now ship (push/pull/receive/sync-export + fn_secret_get + secrets-env materialization), and add a reliability-interaction backstop for cross-node secrets sync route contracts.
- 2242d5b: Add intake-side auto-archive safeguards: ghost-bug preflight on triage finalize and same-agent duplicate detection at task creation. Both paths are fail-open on errors/timeouts and emit structured activity/audit events when auto-archive triggers.
- 10455b7: Normalize task titles to strip foreign embedded `FN-<id>` tokens during create/update/duplicate/refine flows while preserving duplicate/refine provenance metadata. Also adds schema version 84 migration coverage to clean existing active/archived title-ID drift rows idempotently.
- bfbdacd: Improve duplicate source traceability by preserving and surfacing canonical duplicate lineage fields (`sourceType`, `sourceParentTaskId`, and `sourceMetadata.duplicateOfTaskIds`) in task provenance flows used by CLI and dashboard task detail surfaces.
- 97d92da: Fix: ntfy notifications for `in-review` and merged task events now fire even when notification settings were enabled after the engine started.
- 307cf0c: Fix `/api/health/reliability` per-day rows silently truncating older days on busy projects. Per-day in-review entered/bounced counts and duration samples are now aggregated at the SQL layer instead of pulling up to 50,000 activity-log rows in memory, so the Reliability view shows accurate data for every day in the rolling window.
- 0046fc9: Add deterministic duplicate guard at task intake: identical-content POSTs within a 60s window are rejected with `409 duplicate_candidates` or auto-archived with a `source.sourceMetadata.deterministicDuplicateOf` lineage marker. Complements the existing FN-4829 similarity warning.
- f183186: Dashboard reload no longer shows multi-day-old cached boards. The local stale-while-revalidate cache now respects a 10-minute freshness window for list payloads (tasks, projects, agents, documents, etc.); older entries are skipped and the normal fetch path runs, surfacing the existing top progress indicator. Failed background refreshes keep the indicator visible so the user knows the data hasn't been confirmed fresh.
- 8845964: Fix "Copy code" button on the GitHub Copilot device-code panel (Settings and Onboarding) when the dashboard is served from a non-secure origin (e.g. LAN/HTTP `fn serve`). The button now falls back to a `document.execCommand("copy")` path when `navigator.clipboard` is unavailable and surfaces success/failure via a toast instead of silently no-opping. The auto-copy-on-first-show effect uses the same fallback silently.
- c87e0fc: Harden merge conflict arbitration so Layer 3 AI resolution respects task File Scope by resolving out-of-scope conflicted files to main before AI handling and emitting scope-partition audit events.
- 40ef729: Add a merger auto-prerebase policy that can rebase task branches onto local main before the existing Stage 1/2 rebase cascade when divergence from `task.baseCommitSha` crosses a threshold or touches configured shared-infra hot files. This introduces project settings `prerebaseAutoEnabled`, `prerebaseHotFiles`, and `prerebaseDivergenceThreshold`, and emits run-audit events `merge:auto-prerebase:applied`, `merge:auto-prerebase:skipped`, and `merge:auto-prerebase:failed`.
- d5ed2cd: Reconcile stale task worktree/branch metadata after orphan recovery so the dashboard Changes view shows the correct diffs.
- e0b1e6a: `fn pr create` (and the `fn task pr-create` alias) now support `--draft`, `--no-ai`, and repeatable `--reviewer <login>` flags. Adds a top-level `fn pr` subcommand router. When `--no-ai` is not set, the CLI now reuses the dashboard's AI metadata pipeline to generate the PR title/body — parity with the dashboard `PrCreateModal`. `GitHubClient.createPr` accepts `draft` and `reviewers`.
- be6279f: Fix: ntfy 'merged' notifications now fire for every merge-success path (auto-finalize no-op merges, mergeConfirmed fast-path, PR-strategy merges, and self-healing finalize).
- b9d4bd8: Aligned the no-task heartbeat system prompt and procedures with the ambient tool set injected for no-task runs, and added regression tests to prevent forbidden task-scoped tool references from reappearing.
- 68b5694: Extend the FN-4918 deterministic duplicate guard to the remaining task-creation surfaces: CLI `fn task add` (direct-store, with a new `--no-dedup` flag), engine `createAgentTask` (powers `fn_task_create` and triage subtask splits — duplicate detections now report `Linked existing ...`), and mission feature triage (links to the canonical task on duplicate). Dashboard `POST /api/tasks` now consumes the same shared helper so behavior is identical across surfaces. `InlineCreateCard` gains the duplicate-warning modal already shipped on `QuickEntryBox`.
- 6c1732d: Auto-recover stale pending/running insight runs at dashboard startup and on a periodic sweep so manual runs never hang indefinitely.
- f46629e: Make the FN-4918 deterministic duplicate pre-check fail open: transient store query errors, mutex bookkeeping failures, and leader-lock rejections no longer 500 the `POST /tasks` endpoint. Legitimate 409 `duplicate_candidates` responses are unchanged.
- cc6bd1e: Agent-filed tasks now persist `githubTracking.enabled` when tracking defaults are enabled, so pi/engine-created tasks consistently appear as tracked and trigger GitHub tracking hooks like UI-created tasks.
- 7652bbf: Add an optimistic submit lock to QuickEntryBox so Save/Enter cannot trigger duplicate task creation while duplicate checks or create requests are in flight.
- 012fb17: Soft-delete terminology cleanup: `fn_task_delete` and Fusion skill docs now describe `deleteTask` as a soft delete (row + artifacts preserved, ID reserved) and point users to archive cleanup for the actual hard-removal path.
- 2be6cf2: Add near-duplicate intent guard at task intake: dashboard `POST /api/tasks`
  now rejects new tasks whose route paths, file paths, or identifier tokens
  substantially overlap with an existing active task created in the last 7
  days, returning `409 duplicate_candidates` with `reason: "near-duplicate-intent"`.
  Triage `finalizeApprovedTask` backstops with a File-Scope-aware re-check
  after PROMPT.md is written, auto-archiving the loser with a
  `sourceMetadata.nearDuplicateOf` lineage marker. Layered on top of the
  FN-4918 deterministic and FN-4829 similarity gates; fails open on any error.
- 17eb85e: Fix Fusion pre-commit identity-guard hook leaking install-time task ID across shared git hooks dir; hook is now driven entirely by per-worktree fusion-task-id metadata (lowercased to match canonicalFusionBranchName), so a stale install no longer refuses valid sibling-worktree commits.
- f40accd: Make CLI test suite ~3× faster: add a `replyTimeoutMs` option to `runChatInteractive` so the `--once` timeout test no longer waits a real 30s for "No reply within 30s", and gate the heavyweight esbuild-bundled-plugin integration test behind `FUSION_RUN_SLOW_TESTS=1` (the same install/upgrade logic is covered by mocked unit tests in the same file).
- d467725: Fix slow `fusion` startup that hung on "Starting engine…" while every registered project's engine initialized serially in `Promise.allSettled`. Engine startup now runs in the background — the TUI proceeds immediately, and the existing reconciliation loop plus the server's on-access fast path bring each project's engine up before it's actually needed.
- e5af9c9: Fix Fusion desktop (Electron) packaged builds opening a blank window — or no window at all — on macOS. `run()` is now invoked in packaged builds (where `process.argv[1]` is unset by Electron), and the dashboard client is built with a relative `--base ./` so its `file://`-loaded `index.html` can resolve `./assets/*` from inside the asar.
- 19e2ff0: Fix activity-log triple-write caused by multiple TaskStore instances polling the same SQLite DB. When the dashboard, engine runtime, and per-project stores each `watch()` the same database, every column move was previously recorded once per instance — inflating `task:moved` rows ~3x (146k+/day) and amplifying failure noise. TaskStore now suppresses activity-log writes for events re-emitted from its polling loop, leaving the originating instance as the sole audit writer.
- c4745ca: Fix the main chat composer (ChatView) so the textarea grows in height as the message gets longer, matching QuickChat's behavior. The autosize now runs before the controlled `setMessageInput` (so the height assignment lands in the same frame as the user's keystroke), and the height clamp now has a 40px floor so a 0-scrollHeight measurement never collapses the composer to zero.
- 2d42476: Fire GitHub tracking-issue creation for duplicated and refined tasks. Previously the duplicate/refine routes returned without calling `createTrackingIssueForTask`, relying on TaskStore's hook — but mocked stores in tests (and certain race conditions) could bypass the hook, leaving the new task with no linked tracking issue. The routes now invoke tracking explicitly as a best-effort step after creation, matching the PATCH-with-githubTracking path's behavior.
- ea9ec50: QuickChat session picker now uses the themed dropdown style and includes chat rooms in the switch list.
- 0c139a4: Inline the in-review TaskCard Move dropdown into the meta row when badges are present, while preserving the existing bottom-row fallback when no meta row is rendered.
- 4d99a72: Fix Planning Mode so the loading view can show streamed thinking output during the initial question turn, including buffered SSE thinking events that arrive before the first question event.
- 018bbe4: Add run-audit events `worktree:worktrunk-{install,create,sync,prune,remove}` tied to run/task IDs, completing the worktrunk audit taxonomy alongside the existing `failure` / `fallback-native` events.
- dea319f: Add a Worktrunk integration subsection to Dashboard Settings → Worktrees, including enable/binary path/failure-mode controls and automatic disabling of custom worktrees directory overrides while worktrunk is enabled.
- 7f2412b: Make self-healing maintenance respect worktrunk-managed layouts by deferring native prune/orphan cleanup/worktree-cap sweeps to the active worktrunk backend when enabled, while keeping branch-level reclaim logic unchanged.
- 2fe5166: Add `fn settings set` support for `worktrunk.enabled`, `worktrunk.binaryPath`, and `worktrunk.onFailure`, including parsing, validation, and settings display/help updates.
- 2101740: Fix post-merge metadata consistency by capturing and reconciling landed file lists. Done-task metadata and UI now prefer the final landed diff file set, with executor `modifiedFiles` retained as the in-flight fallback.
- 22dd33c: Done-task "files changed" surfaces now use the lineage-backed `/api/tasks/:id/diff` count and clearly label execution-time/merge-commit fallbacks.
- ef1ce10: Self-healing now auto-requeues `in-review` tasks that failed at session start
  with an unusable-worktree error even when zero step progress was recorded.
  Bounded by a 3-attempt cap; persistent failures stay in `in-review` for
  human inspection.
- 6bb2431: Fix Dockerfile workspace manifest copying to match the current monorepo layout by removing the stale `packages/tui` reference and including plugin/package manifests required for `pnpm install --frozen-lockfile` during image builds. This restores successful `docker build .` behavior without changing runtime features.
- bd3809e: Finalize-to-done now requires ownership evidence: tasks only complete when a task-owned landed commit is proven or when no-op completion is proven against the merge target. Legitimate no-op finalize paths now reconcile stale metadata by clearing inherited `modifiedFiles` and stamping empty `landedFiles` markers. Unproven finalize cases are audit-logged and auto-retried by requeuing to `todo` for fresh execution instead of silently landing as done.
- 73d8cb9: Refinement tasks created via `fn_task_refine` are now prioritized in triage dispatch so they are promoted out of Planning reliably when capacity opens.
- e50a4b5: Dashboard: clicking the room title in a chat room conversation now opens a dropdown to switch to another room.
- 94a3c4f: Self-healing now detects refinement tasks stranded in Planning while the rest of the board progresses, and escalates them into the normal triage path without bypassing manual plan approval.
- 047ad6c: Adds API endpoints to surface and expedite refinement tasks stuck in Planning without bypassing plan-spec or approval gates.
- 7ff4279: Fix: chat and chat-rooms composer now grows to always show entered text.
- caf32fc: Dashboard TUI now yields after startup so the splash paints before blocking init runs, and shows a "Ready in Xs" startup-duration indicator once initialization completes.
- 08bfabd: Fix self-healing stale merge metadata repair so rebase/cherry-pick merges compute shortstat from `rebaseBaseSha..commitSha` instead of tip-only `git show`, preventing correct aggregate stats from being overwritten.
- c7a6d68: Make task worktree liveness checks language-agnostic by removing the root `package.json` requirement. Worktrees are now considered usable based on git integrity (`.git` presence, registration, and `git rev-parse --is-inside-work-tree`), fixing false `not_usable_task_worktree` failures in Python, polyglot, nested-manifest, and empty repositories.
- e1e21f6: Reconcile worktrunk backend path contract: resolve the actual worktree
  path via `git worktree list --porcelain` after `wt switch --create`
  instead of assuming worktrunk uses Fusion's `.worktrees/<task-id>`
  layout. Fixes silent `task.worktree` drift on worktrunk-enabled
  projects.
- 98c88c7: Dashboard UI for the worktrunk install approval: when worktrunk auto-install (FN-4624) is triggered from the dashboard, Fusion now creates a `network_api` approval request visible in the Approvals view. Approving the request runs the install with the gate pre-satisfied; denying it leaves the binary uninstalled.
- 8137920: Quick Chat now reflects the active room context by showing a room badge in the panel header, using a room icon in the session trigger, and updating the composer placeholder to `Message #{roomName}` when chat rooms are enabled with an active room.
- bdda0e2: Codex usage panel now falls back to the Fusion-stored `openai-codex` OAuth credential (`~/.fusion/agent/auth.json`) when the Codex CLI `auth.json` is missing, so Fusion OAuth users no longer see a spurious "run codex to login" error.
- 769afd4: Emit `worktree:worktrunk-install` run-audit events on successful worktrunk auto-install (release-binary or cargo paths), completing the worktrunk audit taxonomy started in FN-4626. Cache hits, `$PATH` resolutions, and `worktrunk.binaryPath` overrides remain silent.
- 7cb81b0: Auto-grow chat-style entry textareas in mailbox compose, planning mode, and agent onboarding so inputs expand while typing up to a max height, matching existing chat composer behavior.
- 8e8c1a2: Lock in defaults: worktrunk integration is off by default (opt-in), and the per-project worktree directory defaults to `<projectRoot>/.worktrees` when `worktreesDir` is unset. Regression tests now guard both invariants.
- 414e62d: Reliability view: headline now shows in-review success rate (e.g. 100.0% when no bounces) instead of the raw failure rate. API field `inReviewFailureRate7d` is unchanged.
- f40f2ba: Widen `resolveWorktreeBackend` to accept an optional `binaryPathResolver`, allow `WorktrunkWorktreeBackend` to be constructed with a lazy resolver in place of a literal path, and finalize the `resolveWorktrunkBinary` return contract (adds `installed-release` / `installed-cargo` source variants and an optional `actionGateContext`). Internal surface widening that unblocks FN-4681's binary-resolver wiring; no runtime behavior change for existing callers.
- dc959a7: Gate `worktrunk.enabled` behind verified binary availability. The dashboard settings API, Settings modal, and CLI now reject or prevent enabling worktrunk until the pinned/selected binary resolves and probe-verifies, while still allowing unconditional disable for recovery.
- a92f9aa: Fix duplicate GitHub tracking issues being filed when a new task is created from the dashboard with linked-issues enabled.
- cc701b2: Fix done-task Files Changed reporting for history-preserving rebase/cherry-pick merges by preferring the `rebaseBaseSha..commitSha` range when lineage aggregation is partial.
- e9403df: Add GitHub tracking indicator/toggle to the quick task entry dropdown — shows project default and overrides for the next task.
- 56f38cf: Consolidate duplicate GitHub tracking wrappers and remove redundant post-create invocations; auth-token behavior preserved via shared helper.
- c6daa5e: Defer the post-create hook (and GitHub tracking issue creation) until the title summarizer settles so linked issues use the AI-summarized title.
- 51c60fe: Settings now provide a tracking-repo picker for both project and global defaults, populated from detected GitHub remotes with a Custom fallback for manual `owner/repo` entry.
- c3651da: Fix dashboard project switching so the selected project no longer reverts to a previously saved project after background project-list polling refreshes.
- f761f77: Make file path mentions clickable in mailbox and quick chat message surfaces so path references open in the dashboard file browser.
- b1209b1: Persist GitHub tracking `enabled: true` on task records as soon as project/task settings resolve tracking to enabled, even when issue creation is deferred. This keeps API-created tasks aligned with default tracking state in dashboard UI and prevents redundant enabled-state rewrites.
- befbc51: Linked GitHub issues are now reliably closed when the corresponding Fusion task completes, including a startup reconciliation pass that catches up on previously missed completions.
- 1e02028: Settings sync diff (manual pull + sync-status) now includes keys present only locally, surfacing local-only drift in the diff output.
- dda600c: Replace dashboard `PrSection` with `PrPanel`, removing the inline PR title/description creation textbox in task details. The new panel focuses on read-only PR visibility (state, checks rollup, review decision, and comments) and keeps creation delegated to the upcoming modal flow (FN-4756/FN-4758) without changing CLI or API surfaces.
- da6598a: PR status badge on task cards now distinguishes draft PRs and surfaces a CI check rollup
  indicator (success / failure / pending) using design-token-only styling that adapts to
  all dark and light themes.
- bba945c: Detect PR merge conflicts via gh PR refresh and route affected tasks through the existing self-healing branch-reclaim path. Adds an optional `mergeable` field on `PrInfo`, a "Retry conflict reclaim" affordance in the PR section, and a new `POST /api/tasks/:id/pr/reclaim-conflict` endpoint.
- 93c3975: Fix missing spinner when creating tasks from Planning Mode. The "Create Single Task", "Break into Tasks", and "Create Tasks" buttons now show an inline loading spinner while the async create/breakdown call is in flight, instead of leaving the user staring at an unchanged button or AI-question copy.
- 424c61f: Dashboard reload now hydrates projects/current-project/tasks from a local stale-while-revalidate cache for instant first paint.
- 2f2f7de: Dashboard now preloads the last-used view's JS chunk during HTML parse for faster reloads.
- fc86c4f: Codex usage stats now prefer the Fusion-stored `openai-codex` OAuth credential and only fall back to `~/.codex/auth.json` when no usable Fusion OAuth credential is available.
- 416bd8b: Speed up Agents API startup paths by batching task-column sanitization and agent run-status aggregation. This removes per-agent task hydration and per-agent recent-run scans from initial Agents view loading.
- 4863e3b: Fix Planning Mode first-question loading so the spinner animates immediately and streamed thinking appears during the initial loading turn, even when the stream connects after early thinking events were buffered.
- 2f2198a: Add worktree teardown cleanup for Fusion-managed secrets env files by deleting only files whose fingerprint still matches the recorded write, and emit cleanup/skip audit events.
- a2710fb: Fix dashboard CLI type compatibility by aligning `hybridExecutor` initialization with `createServer`'s `HybridExecutor | undefined` expectation, and stabilize desktop auto-updater tests that run during workspace verification.
- 0b28388: Fix Quick Chat session dropdown not switching to the picked chat.
- 4691cbe: Fix Quick Chat session dropdown so picking a session option actually switches the visible chat (header label, composer placeholder, message list) and mutually excludes active chat-room selection.
- 7310642: Engine: worktree/branch reclaim during the no-fn_task_done retry loop now silently requeues to `todo` instead of surfacing a `failed` task. Genuine retry exhaustion still fails and counts against the retry cap.
- 42b8eeb: Emit per-attempt run-audit events during merge so the Reliability view's Merge Attempts panel populates.
- 7cd5554: Truncate Plan-Only scope-leak activity-log entries and `fn_task_done` blocking refusal messages to the first 10 off-scope and declared-scope entries with a `… (+N more)` suffix and explicit `total off-scope=` / `total scope=` counters, so large tasks no longer flood the activity log.
- 6fa9aef: Lease recovery is now central-claim-aware: `MeshLeaseManager.recoverAbandonedLease`
  releases the central claim before clearing local task-row lease fields, and
  reconciles split-brain state via `reconcileLeaseRow` on the next scheduler /
  self-healing tick. Owner-offline handoff policy and progress-preserving handoff
  semantics are unchanged. Single-node deployments (no central claim store) keep
  the existing local-only behavior. (FN-4823, FN-4819 §2.5 / §3.3 / §3.6)
- d4c4d6d: Define and test cross-node assignment-wake propagation contract (push / poll fallback / missed-wake reconciliation).
- 9e5a516: Structured `node:handoff:*` and `node:lease:*` run-audit events now accompany existing human-readable task logs for owning-node handoff decisions and abandoned-lease recovery paths. Scheduler dispatch and mesh-lease recovery emit machine-readable metadata for parked, reassign-local, reassign-any, and recovered outcomes so multi-node reliability analysis can query durable telemetry directly.
- 27dd927: Auto-recover native worktree-create failures caused by stale git `index.lock` files. Fusion now classifies stale vs active lock contention, retries creation once after safe stale-lock removal, and emits dedicated `worktree:stale-lock-*` run-audit events for detection and outcome visibility.
- 1e1e6f9: Preserve whitespace between streamed chat chunks so multi-sentence assistant replies render `. ` correctly between sentences in ChatView and QuickChatFAB (recurrence after FN-3817; fix at a different layer in the streaming pipeline).
- 49bc9dd: GET /api/nodes/:id/settings/sync-status now includes an `actionableDenialReason` field
  ("missing-remote-api-key" | "auth-failed" | "unreachable" | "unknown" | null) so
  dashboards can surface why a remote probe failed instead of silently reporting
  `remoteReachable: false` with no diagnosis.
- 5ca8761: Fix Quick Chat room switching so selecting a room renders that room's messages and routes sends, /clear, and /new to the room instead of the previous direct session.
- c1cbb66: Fix active-task diff endpoints to report destination paths for renamed/copied
  files. The in-progress/in-review `/tasks/:id/diff` and `/tasks/:id/file-diffs`
  handlers now pass `-M` to `git diff --name-status` so rename detection no
  longer depends on the consumer's `diff.renames` git config.
- 3ca3b5e: Guard `fn_task_done` against agent-dissent summaries, bulk auto-marking of unreviewed pending steps, and pending REVISE verdicts. These refusals share the existing requeue budget and escalate tasks to in-review when retries are exhausted.
- 248c770: Speed up Agents API boot-path loading by replacing per-request pending approval row scans with an aggregated pending-count query per requester agent. This keeps `/api/agents` responsive on large approval histories and reduces time spent on the initial "Loading agents..." state.
- e0df753: Disabling GitHub tracking on an individual task now durably turns tracking off, unlinks the local tracking issue reference, and prevents immediate re-creation in the same update request.
- 7a6a3d0: Fix Quick Entry GitHub link button: correctly reflects enabled/disabled state from project settings, reliably toggles on click, and shows an unambiguous active visual state.
- ee4652a: Heartbeat agents now detect deictic follow-ups ("create it", "yeah do that") in room threads and either echo the resolved referent before acting or post a single structured clarification reply with inferred options. A new `room:ambiguity:branch` run-audit event records which branch was taken for future tuning.
- a08e944: Inbound node settings sync (`/api/settings/sync-receive`, `/auth-receive`, `/auth-export`) now rejects requests when the local node `apiKey` is empty/missing or the Bearer token is empty, closing an `Authorization: Bearer ` bypass against unconfigured nodes. FN-4868 gap G-01.
- 96a1930: Fix bootstrap-misbinding recovery when a Fusion worktree is already bound to its task branch at the target base SHA (no more `fatal: '<branch>' is already used by worktree` errors during re-anchor).
- 3d0cce7: Self-healing now auto-disposes in-review tasks whose identical stall (same code + reason) repeats past `inReviewStallDeadlockThreshold` (default 3) by pausing the task with `pausedReason="in-review-stall-deadlock"` and emitting a `task:in-review-stall-deadlock-disposed` run-audit event, preventing infinite stall-log churn (e.g., repeated `merge-blocker: Failed to create worktree after 3 attempts` loops).
- a2caac3: Auto-recover in-review and verification-fix tasks whose branch carries only foreign-attributed commits and zero own work (the FN-4860/FN-4875 signature). The engine now classifies foreign-only contamination, re-anchors the branch via `reanchorBranchToBase`, or non-destructively discards the orphan branch/worktree, instead of requiring manual `git worktree remove`/`git branch -D`/sqlite metadata recovery.
- 72834eb: Fix `pi.promptWithFallback` recursion by removing standalone re-dispatch through `session.promptWithFallback`.
- 0dc4c9c: Fix `fn_task_show`, `fn_task_list`, and other pi-extension task tools so they resolve the canonical project root when invoked from inside a Fusion task worktree, instead of binding to a stray worktree-local `.fusion` database.
- f00d732: Expand secret audit taxonomy and harden secret audit payload handling. This adds typed secret mutation coverage (`secret:create`, `secret:update`, `secret:delete`, `secret:read`, approval events, sync events, and env lifecycle events), introduces plaintext-forbidden metadata enforcement via `assertNoSecretPlaintext`, adds non-blocking `SecretsStore` audit emitter hooks for CRUD/read operations, and ensures secret audit emission paths avoid leaking plaintext/ciphertext/nonce fields.
- 5aeb764: Prevent and auto-recover "Refusing to start coding agent in incomplete
  worktree" session-start failures. The worktree-acquisition layer now
  classifies pool-returned and resume worktrees before handing them to the
  executor, and the executor's two `createResolvedAgentSession` call sites
  catch the three `assertValidWorktreeSession` variants in `in-progress`,
  emit `worktree:incomplete-detected` + `worktree:auto-recovered` run-audit
  telemetry, and requeue the task to `todo` via the shared
  `autoRecoverWorktreeSessionStartFailure` helper instead of surfacing the
  error to the user. Bounded by `MAX_WORKTREE_SESSION_RETRIES = 3`.
- e33159e: Ensure GitHub tracking post-create hooks are registered across engine startup entrypoints so agent-created tasks (including `fn_task_create` and `fn_delegate_task`) consistently evaluate default tracking settings and link issues when configured, with improved diagnostics for skipped tracking outcomes.
- 1f8d995: Fixes a runtime crash where `fn_task_list` and `fn_task_show` could throw in heartbeat/no-task contexts when `getProjectRootFromWorktree` drifted at runtime, by adding a safe fallback project-root resolver path in the CLI extension.
- 8d9b893: Fix a daemon startup ordering regression by deferring the peer-exchange global-settings read until after the primary task store is created, resolving `TS2448`/`TS2454` typecheck failures in `packages/cli/src/commands/daemon.ts`.
- 24f5c23: Make `promptSessionAndCheck` transcript diagnostics circular-safe to prevent stack overflows on malformed message metadata.
- 3bbc507: Fix the executor's pre-session worktree liveness assertion firing on
  freshly-created worktrees (Runfusion/Fusion#601). The gate now skips when
  `acquireTaskWorktree` returns `source: "fresh"`, and legitimate failures
  are classified into `missing` / `incomplete` / `unregistered` /
  `outside-work-tree` with a canonicalized registered-paths snapshot in the
  log plus a `worktree:incomplete-detected` run-audit event. The existing
  `taskDoneRetryCount` requeue-to-`todo` contract on this gate is preserved
  unchanged.
- a651e8c: Task cards now prefer showing the clickable linked GitHub issue chip over the plain GitHub import provenance badge when both refer to the same issue.
- d41dc24: Worktree setup now removes `packages/desktop/dist` and `packages/desktop/dist-electron` from acquired task worktrees to avoid carrying stale ~900MB Electron build artifacts across recycled worktrees.
- 14c5a17: Fix contamination auto-recovery nulling `task.worktree` while leaving a live worktree mapped on disk, which triggered transient `no-worktree-no-merge-confirmed` stall signals in the dashboard. The in-line recovery in `executor.ts` now:

  - Runs `autoRecoverCrossContamination` inside the task's worktree (when one exists) so the final `git checkout <branch>` doesn't collide with the branch already being checked out elsewhere — the previous `repoDir: this.rootDir` call would silently fail for any task that had a real worktree.
  - Passes `preserveWorktree: true` when requeueing to `todo`, matching the sibling recovery paths in `auto-recovery-handlers/contamination.ts`, `tryBootstrapMisbindingRecovery`, and self-healing reclaim.

- 93e49b0: Fix desktop app launches on macOS where the process starts but no visible window appears. Window position restore now validates saved coordinates against connected display work areas and drops off-screen positions, and startup explicitly show/focuses the window with a ready-to-show path plus fallback timer.
- 9dfefc5: Closing/deleting the linked GitHub issue when deleting a tracked Fusion task now completes reliably even after the task is removed from the store, including observable success/failure signals and safe post-delete logging behavior.
- 17fafa1: GitHub tracking issues now wait for AI title summarization to settle before filing, ensuring summarized task titles are used consistently.
- 28595f5: Extend FN-4851 fn_task_done refusal guards (pending-code-review-revise, bulk-step-completion-without-review) to the implicit-completion path so agents cannot bypass them by drip-marking every step done via fn_task_update and exiting without calling fn_task_done. Implicit refusals share the existing requeue budget and escalate to in-review on exhaustion.
- c161e62: Prevent cross-branch commit contamination at the source: every task worktree now installs a pre-commit hook that refuses commits when HEAD does not match the worktree's owning task branch (with an allowlist for parallel-step branches). As defense-in-depth, contamination auto-recovery now drops `obviously-misrouted` foreign commits whose task-id attribution and changed-path namespace unambiguously belong to another task (initial heuristic: `.changeset/fn-<that-id>-*`), instead of escalating them to human adjudication.
- 287673c: Engine: `reclaim-stale-active-branches` now defers reclaim when the task has a registered active session, a recent `executionStartedAt`, or a worktree with uncommitted changes. Emits a new `branch:stale-active-reclaim-deferred` run-audit event per deferral. Fixes FN-4924-class loops where executor work was wiped because per-step commits were absent.
- f9f8ca0: Lock in default: `recycleWorktrees` is off by default (opt-in). Regression tests now guard the invariant, and dashboard/docs copy explicitly states the default.
- d856788: Hardened worktree pool leasing with explicit lease ownership tracking, double-lease invariant detection, and `worktree:pool-double-lease-detected` audit emission, plus merger cleanup ordering that detaches and clears task worktree metadata before pooled release.
- 02ba659: Scheduler now prefers runnable todo tasks that unblock the most downstream dependents within the same priority class, so root blockers like FN-4766/FN-4867 stop sitting behind unrelated same-priority work. Urgent tasks still outrank everything.
- 3a3f4ed: Normalize task titles by stripping empty placeholder bracket groups (`()`, `[]`, `{}`) left by FN-token removal and AI-generated blank template slots.
- cfe3532: Fix executor step-order corruption: `fn_review_step` off-by-one when auto-updating step status, `resetStepsIfWorkLost` now recomputes `currentStep` so execution does not resume past wiped work, and `TaskStore.updateStep` refuses out-of-order `done` writes.
- 5a1794f: Wire the redesigned Create-PR modal into the task detail modal and the merge/review tab so
  PrPanel's Create button and a new review-tab Create-PR action open the same flow. Fixes the
  FN-4758 follow-up where PrPanel was mounted with `onRequestCreatePr={undefined}`.
- e5af1f1: Suppress in-review stall surfacing and deadlock auto-disposition when autoMerge is disabled. Tasks on the PR-based review flow no longer get flagged as stalled.
- 6fc0f5c: Engine: self-heal `git worktree add` failures classified as "missing but already registered worktree" by pruning the stale registration and retrying once. Recovery is observable via new run-audit events `worktree:stale-registration-detected`, `worktree:stale-registration-recovered`, `worktree:stale-registration-recovery-failed`.
- 46d0928: Pair raw worktree directory deletions in the engine with best-effort `git worktree prune` to prevent stale admin-entry leaks.
- bed14fd: SelfHealingManager.reapUnregisteredOrphans now defers reaping paths that are bound to a live active session, restoring the FN-4811 guard lost during the auto-archive incident.
- 896ae7a: Fix malformed task titles when foreign FN-XXX tokens are stripped: dangling trailing connective words (e.g. "of", "to", "for") that would otherwise produce fragments like "Close as duplicate of" are now rejected, so token-stripped residuals never persist as task titles.
- f116953: TaskCard in-review Move dropdown is now rendered inline with the file-overlap and queued badges in the meta row, falling back to the bottom action row only when the meta row is not rendered.
- dd78e42: Add `in-review-stalled` backlog-health detector for unpaused in-review tasks quiet past the configurable `inReviewStalledThresholdMs` (default 24h).
- c51d0d9: Restrict rebase-strategy landed-files capture to task-attributable commits and annotate short-circuit/fallback metadata for downstream reconciliation and reporting.
- 6608f21: Fix chat UI losing streamed assistant text when the user leaves and returns to a session mid-generation.
- a6747c1: Tasks moved to done no longer retain stale paused metadata, and `fn task list`
  output suppresses the `(paused)` suffix for terminal (done/archived) tasks. A
  one-shot startup backfill repairs already-drifted rows.
- ba16048: Dashboard: implement missing /api/tasks/:id/pr/generate-metadata, /pr/preflight, and /pr/options routes so the Create PR dialog populates AI title/body, preflight checks, and base-branch/reviewer/label dropdowns.
- 041eb4b: Chat and QuickChat composers now grow up to 640px so pasted multi-paragraph
  text stays visible without forcing the user to scroll inside the textarea.
- bb34033: Treat in-review as terminal-until-merged when autoMerge is disabled. All lifecycle-mutating self-healing sweeps now short-circuit on autoMerge=false so PR-based review tasks are no longer kicked back to todo, marked failed, or re-finalized by recovery loops.
- 6d68c2d: Align MessageComposer, PlanningModeModal, and AgentOnboardingModal autosize
  caps to 640px (and SummaryView expanded mode to 800px) so pasted multi-paragraph
  content stays visible without internal scroll, matching the FN-5146 chat
  composer convention.
- 7dafde4: Refuse bootstrapping a nested Fusion project from a linked git worktree when the parent repository already has `.fusion/fusion.db`, and allow an explicit override with `FUSION_ALLOW_NESTED_PROJECT=1`.
- 6b24b56: Add durable mergeQueue table (schema v89) and TaskStore lease API (enqueue / acquireLease / releaseLease / recoverExpiredLeases) as the foundation for FN-5240 in-review handoff durability. No engine behavior change yet; merger/executor wiring lands in FN-5241/FN-5243.
- a164e84: Harden `fusion.db` against process crashes: switch `PRAGMA synchronous` from `NORMAL` to `FULL` and restore the default `wal_autocheckpoint = 1000` (was 100). Repeated node:sqlite SIGSEGVs inside `pager_write` had been corrupting the db; the previous settings left a wide window for torn pages whenever a writer crashed mid-checkpoint. The small fsync cost is worth the durability win.
- d9214b6: PR conflict diagnostics: capture the conflicting file list and a project-strategy-aware suggested command sequence on `PrInfo.conflictDiagnostics` at PR refresh time, and surface them in the dashboard PR panel with a copy-to-clipboard affordance and re-check button.

## 0.31.0

### Minor Changes

- 3d94b54: Persist cumulative active runtime and first-execution wall-clock anchor so
  board cards and Task Detail stats no longer "forget" earlier work when a task
  is moved back to todo and resumed (FN-4595).
- 4f3f153: Add first-class milestone acceptance criteria support across missions: persist `Milestone.acceptanceCriteria`, expose milestone create/update route handling, and add the `fn_milestone_update` tool for partial milestone patches. The dashboard now renders and edits milestone acceptance criteria separately from description/verification semantics.

### Patch Changes

- f2bd31a: Fix chat room thread freshness by loading the newest message window (`order=desc` tail fetch) while preserving ascending message order in responses, and unify dashboard scoped chat event wiring with the engine's live `ChatStore` instance so agent-posted room messages stream to SSE listeners immediately.
- 60982e6: Fix the executor no-`fn_task_done` retry race with self-healing branch/worktree reclaim by re-validating live worktree/branch bindings before retry sessions and converting missing/incomplete/unregistered worktree session-start failures into clean `todo` requeues with preserved progress.
- 5356cff: Fix GitHub Copilot OAuth login failing with "OAuth provider did not return state in auth URL" on remote (non-localhost) dashboard hosts. Copilot's device-code flow has no redirect callback, so the dashboard now passes its verification URL through unchanged like it already did for Anthropic and OpenAI Codex. The verification page now opens in a new tab and the device-code panel renders as designed.
- a3ff9d0: Add `fn_milestone_update` tool and `acceptanceCriteria` field on milestones.
- f150850: Fix Missions UI false "No assertions defined" signal on milestones whose child features already have populated acceptance criteria. The milestone view now rolls up feature-level `acceptanceCriteria` as read-only "Completion criteria (from features)" when no structured `MissionContractAssertion` rows exist; the empty-state nudge is preserved only for milestones with no completion criteria at any level.
- e0f7bb3: Dashboard: add Reliability view entry to the mobile More sheet so it is reachable on mobile, matching the desktop Header overflow menu.
- 3e9ad89: Tasks manually parked back to Todo now consistently render as paused in TaskCard and TaskDetailModal, and using Unpause clears the `userPaused` latch so scheduler dispatch can resume.
- cb0a606: Dashboard board and list views now refetch tasks once when the user navigates back from another dashboard view, so internal view switches no longer leave task data stale while task SSE was temporarily disabled.
- 268afdd: Fix agent org chart not rendering connector lines between parent and child agents.
- 065674f: Dashboard: agent and project permission editors now list the concrete tools each approval category covers (including web search and task creation) and show which coordination/messaging tools are exempt from approval by design. Project settings now expose the agent provisioning approval policy (`approvalMode`, trusted roles/agents, `alwaysApproveDelete`).
- 8da30b3: Action-gate: `fn_web_fetch` is now classified under the `network_api` approval category, matching `fn_research_run`. Projects with `network_api: require-approval` will now prompt for approval before agents fetch external URLs. Previously fell through to exempt and bypassed the policy (FN-4603).
- 236ce62: Test bootstrap (scripts/ensure-test-artifacts.mjs) now covers @fusion/engine and additional `@fusion-plugin-examples/*` packages so fresh-worktree test runs no longer fail with opaque `Failed to resolve import` errors. Adds package-level `pretest` hooks for the dashboard and dependency-graph plugin, and improves remediation output to name exact missing/stale artifact paths.

## 0.30.0

### Minor Changes

- 9db9cfe: Add `--project <id|name>` support to `fn serve` and `fn daemon` for explicit primary project binding.

  Headless startup now resolves its primary engine in this order: CLI `--project`, central `defaultProjectId`, cwd project, then first started engine from the central registry. `serve`/`daemon` no longer require cwd to be a registered project and now only exit when no engines start across the registry.

  Add central `defaultProjectId` persistence so headless nodes can select a default project across restarts.

- e1bc0c2: Add bulk Pause / Unpause / Archive actions to List View bulk edit.
- a9ed315: Add a diagnostic-only stale paused review signal (`task.stalePausedReview`) for paused in-review tasks, including a configurable `stalePausedReviewThresholdMs` setting, self-healing surfacing logs, and dashboard badge/filter/detail visibility for faster operator triage.
- 11d521b: Add a diagnostic task-age staleness signal for `in-progress` and `in-review` tasks, with configurable warning/critical thresholds. Surface stale state in the dashboard with task-card badges, task-detail diagnostics, and a new ListView "Stale only" filter. Add scheduler-side structured stale-threshold log emission and settings for per-column warning/critical thresholds.
- 7a1d39c: Add workflow-step `gateMode` support so steps can run as blocking gates or advisory polish checks.
- bbb6d9c: Fix Google Generative AI custom provider not saving after model detection. The probe endpoint accepted `google-generative-ai` but create/update routes rejected it. Also adds SSRF protection, body validation, and fixes stale type mappings.
- cfeb1f2: Chat-room transcript compaction limits (recent verbatim window, fetch limit,
  summary cap) are now configurable in project settings instead of hardcoded.
  Defaults match prior behavior.
- e1bc0c2: Auto-recover from post-merge audit blocks: programmatic per-file survival check, optional AI-driven restoration pass, and an audit-bounce loop (parallel to conflict bounces) before parking a task as failed. Governed by the new `mergeAuditAutoRecovery` setting (default: `ai-assisted`).
- 1b0f7b1: Add configurable heartbeat scope-discipline modes (`strict`, `lite`, `off`) with a project-level default setting and per-agent runtime override.

  The default remains `strict` so existing installations keep current behavior until explicitly changed.

- 9f24f1b: Add per-task token-budget alerts. Soft cap emits a single notification; hard cap pauses the task with `pausedReason: token_budget_exceeded`. New project/global setting `taskTokenBudget` with optional per-size (S/M/L) overrides; new per-task `tokenBudgetOverride` set on resume. New optional `token-budget` ntfy event.
- 940f701: Trim heartbeat execution prompt sections by template-aware caps, add per-project and per-agent `heartbeatPromptTemplate` controls, emit `prompt-size` heartbeat audit logs, and expose per-agent prompt-size history via `/api/agents/:id/prompt-sizes` with dashboard sparkline visualization.
- b63b721: Add CodeMirror-powered syntax highlighting to the dashboard file browser editor (JS/TS, CSS, JSON, Markdown).
- 216d76d: Add `fn_feature_update` extension tool to edit existing mission feature title/description/acceptance criteria without delete+re-add.
- 7730860: Add `noCommitsExpected` task-level flag so decision-only / evaluation tasks can complete cleanly without tripping the executor's `no_commits` invariant. Triage auto-detects decision-shaped tasks; the flag can also be set manually from the task detail modal and is surfaced as a badge on TaskCard. The existing merger no-op finalization path handles completion.

### Patch Changes

- ed648b2: Add experiment-session domain model (types, store, SQLite schema) for upstream pi-autoresearch parity. Additive only; no behavior change to the existing research subsystem.
- 79ea9e9: Add experiment executor runtime (init/run/log lifecycle, METRIC parser, async benchmark runner, keep/revert git policy) for upstream pi-autoresearch parity. Additive only; existing research subsystem unchanged.
- 034528c: Add experiment session finalize workflow across engine, CLI, extension, and dashboard API. The workflow previews and finalizes kept experiment runs into reviewable branches from merge-base, with typed error mapping for CLI/API consumers and rollback on partial branch creation failures.
- e5189e3: Test bootstrap (`scripts/ensure-test-artifacts.mjs`) now detects STALE example-plugin
  dist artifacts (`@fusion-plugin-examples/{hermes-runtime,openclaw-runtime,paperclip-runtime}`)
  in addition to missing ones by comparing `src/` mtimes against the oldest `dist/`
  entry artifact. When a rebuild fails, the script emits an actionable remediation
  block (FN-4232) before exiting non-zero so worktree and merger-verification flows
  no longer fail first with opaque Vite "Failed to resolve entry for package" errors.
- 7dc0276: Add a reliability metrics surface with `GET /api/health/reliability` and a new dashboard Reliability view showing in-review failure rate, duration percentiles, and merge-attempt distribution.
- e663a1d: Emit a new run_audit git-domain mutation type, `merge:audit-failure`, for dirty post-merge audit outcomes in the merger path.

  The event metadata now records the audit decision contract: `mode`, `strategy`, `action`, `reason`, `issueCount`, `duplicateSubjectCount`, `touchedFileOverlapCount`, `verificationPassed`, and `auditTargetLabel`. This covers both blocking failures and warn/verified-short-circuit pass-through outcomes so downstream reliability metrics (FN-4360) can source post-merge audit failures from `run_audit` instead of agent-log scraping.

- e964bda: Emit `git` / `merge:file-scope-violation` run_audit event when the merger's file-scope invariant aborts a squash, enabling the `fileScopeInvariantFailuresPerDay` reliability metric.
- 12bdec8: Remove `agentMemoryInclusionMode` from `ProjectSettings` and make memory inclusion mode global-only by default resolution (`agent.runtimeConfig.agentMemoryInclusionMode` → `GlobalSettings.agentMemoryInclusionMode` → default).

  Per-agent `runtimeConfig.agentMemoryInclusionMode` override behavior is unchanged, and `GlobalSettings.agentMemoryInclusionMode` remains the default source when no agent override is set.

  If you previously set `agentMemoryInclusionMode` in project `.fusion/config.json`, move that setting to global `~/.fusion/settings.json`; project-level values are now ignored.

  Also tighten heartbeat memory-mode transition log fallback to use `taskId ?? "heartbeat"`.

- 3ea3da6: Add TaskStore.getExperimentSessionStore() accessor so engine, CLI, and
  dashboard surfaces resolve the ExperimentSessionStore through a single
  canonical entry point (parallels getResearchStore()). Additive; no
  behavior change to existing research or experiment-session code paths.
- 7d67cbb: Consolidate ExperimentSessionStore resolution onto
  TaskStore.getExperimentSessionStore() across the dashboard experiment
  routes, CLI experiment finalize command, and pi-extension tool. Removes
  the temporary FN-4218 fallback shim introduced in FN-4222. Behavior
  unchanged; single canonical store-resolution path.
- b7659f9: Add executor-side scope-leak guard at fn_task_done for Plan-Only (Review Level 1) tasks. Off-scope uncommitted edits now produce a [scope-leak] activity-log entry (default warn) or refuse fn_task_done when planOnlyScopeLeakEnforcement="block". Respects task.scopeOverride and never blocks on git infrastructure failures.
- 3d19aab: Engine: when an in-review task moves to done (auto-merger, self-healing, or manual move), the engine now fans out blockedBy reconciliation and residual branch/worktree cleanup in the same pass instead of waiting for the next periodic self-healing sweep. Prevents FN-4008-class stranded-task incidents.
- c3209aa: Dependency graph view now switches to a vertical orientation on tall or narrow viewports so graph nodes stay reachable on mobile screens.
- 79dac9b: Dashboard: Agents → Org Chart now supports drag-to-pan, wheel/pinch zoom, and a unified zoom toolbar on desktop and mobile. Parent→child connectors are drawn via a measurement-based SVG overlay so they always stay attached, including asymmetric subtrees and single-child chains.
- d4f4733: Fix file browser crash (React error #31) when opening from the desktop Header Files button.
- 4adc182: Suppress false `verification fix finalize failed (fix produced no content)` failures when task content is already on main by adding a last-chance already-landed classification in merger finalize and a new self-healing sweep that recovers misbound in-review branch tips. This also avoids noisy Task Failed notifications for this recovered path and records dedicated audit events for both finalize and self-healing recovery flows.
- 458c234: Enforce `workflow_steps.toolMode="readonly"` as a hard tool allowlist at the engine's agent-session layer. Readonly workflow steps can no longer hold Edit, Write, Bash, or task/agent mutation tools. Steps that attempted to write under `toolMode="readonly"` now fail closed with a `READONLY_VIOLATION` outcome instead of silently staging files.
- 4bafbaf: Fix file browser editor toolbar collapse button so the line-number / word-wrap controls actually hide when collapsed (FN-4480).
- e1bc0c2: Fix false-positive `BranchCrossContaminationError` that paused tasks at start when their stored `baseCommitSha` was stale relative to `main`. The contamination check now computes a fresh merge-base against the integration branch instead of reusing the diff-stable `task.baseCommitSha`, and `captureBaseCommitSha` only preserves a prior stored value when resuming an existing worktree. Diff-base stability across resumed sessions is preserved (FN-4309/FN-4383 behavior unchanged).
- f9af9fc: Add explicit overlap/`blockedBy` bottleneck visibility across scheduler logs and dashboard fan-out surfaces, including de-duplicated scheduler warnings and overlap-specific footer/card/detail summaries.
- 00e2679: Self-healing now auto-promotes tasks with all steps completed out of the `todo`
  column to `in-review` (or `done` for Review Level 0 tasks), preventing finished
  work from being stranded after stuck-task timeouts, ghost-review bounces, or
  merge-failure re-queues.
- d83e4de: Add `fn chat <agent-id>` for interactive REPL conversations with an agent from the CLI. Sends messages via the project's MessageStore (so a running `fn` / `fn serve` engine wakes the agent) and polls for replies.
- ecaeaf0: Engine reliability: durable agents no longer retain a stale Current Task pointer after the task moves to done/archived/todo/triage. A new task-move listener clears agent.taskId in real time, and the self-healing sweep recovers already-drifted records on startup and periodically.
- e1bc0c2: Removed the Plan and Subtask AI-assist buttons from the New Task dialog. The same Plan/Subtask actions remain available in the board quick-entry box and other inline create surfaces.
- e4ea9bf: Harden post-merge audit deterministic short-circuit against HEAD drift by checking both the audited commit tree and task-branch tip tree against verification cache entries.
- 2838df2: Add cache-hit observability surfaces across Fusion: structured `token-cache-metrics` logs during token persistence, a new `GET /api/agents/:id/token-usage` endpoint with windowed summaries, dashboard cache-hit ratio displays, and a new `pnpm fn:cache-stats` CLI report.
- 1696c31: Canonicalize task token usage semantics across heartbeat and executor paths by treating `cachedTokens` as cache-read only, storing cache writes in new `cacheWriteTokens`, and preserving raw `inputTokens`.

  Dashboard token stats now render separate `Cache read` and `Cache write` values.

  Historical rows created before this fix may still contain mixed cache-read+cache-write values inside `cachedTokens`; existing data is not backfilled.

- e1bc0c2: Fix FN-4068 branch-conflict recovery hot loop: prevent repeated "Branch conflict recovery required" emissions and add a per-task tripwire that hard-pauses after 5 repeats.
- 85c6869: Add per-task retry observability and guardrails across core, engine, and dashboard surfaces. Tasks now expose a derived `retrySummary` breakdown (including new branch-conflict recovery, reviewer context retry, and reviewer fallback retry counters), the engine emits structured `retry-burned` logs, and retry caps can hard-fail with `RetryStormError` when `maxTotalRetriesBeforeFail` is exceeded. The dashboard now surfaces retry totals on cards, list view, and task detail breakdowns, and existing databases auto-migrate schema version `72 -> 73` on startup.
- 3869db3: Cache no-task auto-claim candidates project-wide with scheduler-driven invalidation and a 30s TTL snapshot to reduce duplicate board scans. Add `autoClaimCandidatesInPrompt` (project setting + per-agent runtime override) to cap/suppress injected candidate lines in heartbeat prompts, and add a Coordination-only preset in Agent Detail to disable auto-claim for routing-style agents.
- aa2fd6a: Fix self-owned task branch conflicts so dispatch can reclaim an existing task worktree/branch instead of hard-failing with a branch conflict. Add a self-healing sweep that reclaims stranded self-owned branch conflicts for idle todo/in-progress tasks and emits `branch:auto-reclaim` run-audit telemetry including task/branch/worktree/tip/stranded commit metadata. Cross-task (`live-foreign`) branch collisions remain blocked and still require `fn task branch-recovery`.
- 07b16d9: Fix mobile File Browser workspace selector dropdown clipping by removing header overflow clipping in the mobile modal header layout, so the menu can render fully while title/path truncation remains intact.
- e1bc0c2: Revert the Todo aging indicator added in FN-4316. The Todo column header
  no longer shows age-bucket counts or supports click-to-filter by bucket;
  Column rendering and pagination behave exactly as they did before
  FN-4316.
- 65bf8f3: Auto-recover branch cross-contamination when all foreign commits are already upstream, with per-commit classification and a single-shot guard that escalates repeat contamination to paused human adjudication.
- c003f4b: User-initiated drag/move of an in-progress task back to todo now hard-cancels the active executor session, aborts running task work before disposal, and parks the task with `userPaused: true` so scheduler dispatch does not immediately restart it.
- b9fe0f4: Self-healing now emits a `task:auto-recover-already-merged` run-audit event when `SelfHealingManager.recoverAlreadyMergedReviewTasks` finalizes a phantom-merge-guard false positive. Enables the `recoverAlreadyMergedReviewTasksRecoveriesPerDay` reliability metric to be derived from `run_audit_events`.
- 52615b6: Slim task listings now include `githubTracking`, keeping GitHub tracking badges stable on board/list cards across refreshes and updates.
- 2a2c0c9: Fix merger history-preserving cherry-pick fallback handling so empty `-X ours` / `-X theirs` picks are treated as already-on-main no-ops instead of merge conflicts that park tasks.
- 4c4f11b: Fix branch-conflict recovery to treat fully-subsumed branches (no patch-id-unique commits vs main) as safe auto-reclaim cases, and report stranded commit counts using patch-id-aware `git cherry` results instead of stale base ranges. Also preserve dirty worktree changes to `.fusion/recovery/<task>-<timestamp>.patch` before unrecoverable branch-conflict escalation.
- b565fde: Quick Chat now restores the most-recently-active non-archived chat on every open, not just the first open after page load.
- e2e2ca5: Fix dashboard file browser editor rendering both a plain textarea and the
  CodeMirror editor pane simultaneously — only the syntax-highlighted CodeMirror
  pane now renders.
- 4615c48: Self-healing now auto-reclaims paused `branch-conflict-unrecoverable` tasks when the branch/worktree is self-owned, and orphaned `fusion/*` branches with unique commits are rescued as new triage tasks instead of force-deleted.
- 2faf28e: Add editable agent permission policies with project defaults and per-agent overrides, including per-category action-gate dispositions across git writes, file writes/deletes, command execution, network/API, and task/agent mutation.
- cf4723a: Add bootstrap-time branch misbinding recovery for contamination checks. The engine now classifies foreign-only contamination ranges with zero own/non-attributed commits, re-anchors the task branch to its intended base, audits the re-anchor event, and retries safely without pausing. Acquisition now also logs a warning when a `fusion/fn-*` start point resolves to a foreign task-attributed tip so future misbinding incidents are diagnosable.
- ab0dd0e: Self-healing now auto-reclaims `fusion/<task-id>` branches that are still live-mapped to a worktree but have zero unique commits vs `main` by force-removing the stale worktree and deleting the branch, so retry can recreate a clean checkout without manual branch-recovery intervention.
- 9fe8142: Branch-conflict detection now clears stale cached task metadata (`worktree`, `branch`, `baseCommitSha`) when live branch/worktree mappings are missing, and classifies branch tips already reachable from `main` as `tip-already-merged` instead of reporting main's forward progress as stranded commits. This fixes FN-4471-class false-positive `branch-conflict-unrecoverable` parking.
- 8835c68: Auto-grow the QuickChat composer (FAB and room chat) when typed text wraps past one line, matching the full ChatView composer behavior.
- 9214052: Fix permanent-agent and action-gate classification for `fn_post_room_message` so restricted agents can post room replies without spurious approval gating.
- 779e31f: Fix done-task diff display for rebase-merged tasks: persist the rebase base SHA in `MergeDetails` and use `rebaseBaseSha..commitSha` as the diff range so the dashboard Changes tab and task-card file counts match the stored aggregate stats. Squash merges are unaffected.
- 1beb633: Show pending-approval indicator on the Mailbox Approvals tab immediately, not only after opening it.
- decfeba: Fix inconsistent "files changed" counts between TaskCard and the Task Changes tab. (1) Active tasks without a worktree now fetch the same branch-fallback diff for both surfaces. (2) Done-task lineage aggregation now unions per-lineage-commit file sets instead of sweeping the parent..HEAD range, so interleaved non-task commits no longer inflate the count. (3) Additions/deletions counting no longer drops lines that start with `++` or `--`.
- 97f6558: Fix inaccurate "files changed" counts on done tasks. Done-task lineage aggregation now unions per-lineage-commit file sets (instead of sweeping `earliestParent..latestSha`), so interleaved non-task commits no longer inflate the count, and rename/copy entries are deduplicated. Additions/deletions counting no longer drops lines that start with `++` or `--`. Add regression tests in `packages/dashboard/src/__tests__/routes-diff-done-tasks.test.ts` that compare done-task diff stats against real git shortstat outputs for lineage, rename/copy, squash-merge, and `++`/`--` patch content scenarios.
- 1a6e89c: Fix stale "files changed / insertions / deletions" on done tasks when `pushAfterMerge` is enabled. After `pushToRemoteAfterMerge` rebases HEAD, the merger now re-reads `git show --shortstat <postPushSha>` and rewrites `mergeDetails.filesChanged/insertions/deletions` alongside the refreshed `commitSha` (previously only the SHA was updated, leaving pre-rebase squash stats attached to the post-rebase commit). The `recoverDoneTaskMergeMetadata` self-healing pass also now detects and repairs stored stats that disagree with the live commit at the stored SHA, both at startup and during periodic maintenance.
- 816575c: Fix stale "files changed" counts on done task cards. The `/api/tasks/:id/diff`
  endpoint and the TaskCard done-task badge no longer fall back to the stored
  `task.mergeDetails.filesChanged` value, which can be stale after a rebase-and-
  push (see FN-4526). The endpoint now always derives stats from a live
  `git show --shortstat <commitSha>` when a merge SHA is resolvable, and the
  TaskCard treats the endpoint's response — including `0` — as authoritative.
  The stored `mergeDetails.filesChanged` is shown only as a transient placeholder
  while the live fetch is in flight.
- 581b3e7: Dashboard task diff APIs now return destination paths for renamed/copied files and count them once (instead of add+delete pairs) when serving in-progress/in-review tasks via branch-ref fallback.
- 44d9d03: Introduce AutoRecoveryDispatcher and `ProjectSettings.autoRecovery` (mode/perClass/maxRetries) for classifier-driven recovery of reliability-layer failures. Adds new run-audit event types `auto-recovery:classify-decision`, `auto-recovery:retry-issued`, `auto-recovery:ai-session-spawned`, and `auto-recovery:pause-because-destructive-ambiguity`. Default mode preserves prior behavior; `mode: "off"` is byte-identical to legacy parking.
- 71bd971: Add branch/worktree auto-recovery handler that resolves FN-4519-class incidents (ghost worktrees, branch misbinding, stale branch-conflict-unrecoverable parking) by re-running deterministic classification (FN-4499 bootstrap re-anchor, FN-4500 zero-unique-commit reclaim via inspectBranchConflict kinds `stale-resolved` / `fully-subsumed`, FN-4499 `reclaimable`-with-zero-own-commits re-anchor) against live evidence and requeueing through the FN-4534 dispatcher. Adds run-audit events branch-worktree:auto-requeue, branch-worktree:ai-session-spawned, branch-worktree:irreducible-pause. Genuine live-foreign (FN-3936-class) cases continue to pause; userPaused (FN-4429) is preserved; autoRecovery.mode === "off" behavior is byte-identical to legacy parking.
- 38341e9: Auto-recovery: contamination + message-delivery handlers. Adds ContaminationAutoRecoveryHandler (issueRetry for branch-cross-contamination, composes with FN-4499 bootstrap re-anchor and FN-4428 contamination classifier) and MessageDeliveryAutoRecoveryHandler (bounded retry-or-park for fn_send_message / fn_post_room_message inside agent-tools.ts). New ProjectSettings.autoRecovery failure class "message-delivery-failure". New run-audit event types contamination:retry-issued, contamination:irreducible-pause, message-delivery:retry-issued, message-delivery:park. Genuine destructive-ambiguity contamination still pauses; userPaused (FN-4429) is preserved; autoRecovery.mode === "off" is byte-identical to legacy behavior at every wired site.
- cfedb27: Reclaim zero-unique-commit `fusion/<task-id>` branches owned by active tasks with no live worktree (FN-4546).
- 3302612: Dependency graph: fix card overlaps in vertical orientation by laying out rows using measured node heights and anchoring edges to actual card bottoms.
- b08b8c5: Fix syntax highlighting in the dashboard file editor when running in light mode or any non-dark color theme; the editor now also reacts to live theme switches without losing cursor position or unsaved edits.
- 73c17f3: Fix GitHub Copilot OAuth login hanging in Settings and Onboarding. The dashboard now auto-answers the enterprise-domain prompt (defaulting to github.com) and surfaces the device user code + verification URL so users can complete the device-code flow end to end.
- 327c0de: Show the chat-icon unread dot when a new reply arrives in any individual chat session or any chat room (previously only the active individual chat session triggered it).
- f8520fb: Broaden unusable-worktree session-start failure recovery to auto-requeue in-review tasks when coding sessions fail with missing, incomplete, or unregistered git worktree errors.
- b86248e: Widen restart-recovery missing-worktree classification so self-healing also recovers `incomplete worktree` and `unregistered git worktree` session-start failures, matching existing handling for `missing worktree` failures.
- 54ed639: Task cards now show linked GitHub issue, retry count, and execution timing chips on one row with consistent chip sizing and a smaller GitHub icon for visual parity.
- 507a0be: TaskCard in-review Move dropdown now sits in the bottom-right corner of the card.
- 5528113: Fix Task Detail Changes tab to match Task Card file counts for done tasks that lack a merge commit SHA but still have a server-computable lineage diff, while preserving safe summary fallback when no detailed diff is available.
- 716b9ab: Migrate the six remaining built-in prompt-mode workflow step templates (documentation-review, qa-check, security-audit, performance-review, accessibility-check, browser-verification) to emit the structured {verdict, notes} JSON contract introduced in FN-4367. Fix the frontend-ux-design template's verdict enum to match the parser's accepted set (APPROVE | APPROVE_WITH_NOTES | REVISE). Ships scripts/replace-seeded-workflow-prompts.mjs as a one-off operator tool to bring already-materialized project DB rows (e.g. WS-004) onto the new prompts; the prose-fallback path remains intact for backward compatibility.
- e7348ea: Add structured verdict/notes contract for prompt-mode workflow step output, with backward-compatible prose fallback. Updates WS-006 prompt template (manual operator step to apply via scripts/replace-ws006-prompt.mjs).

## 0.29.0

### Minor Changes

- 00416c2: Add two global settings for AI thinking-log persistence: `persistAgentThinkingLogPermanent` and `persistAgentThinkingLogEphemeral`. Defaults remain unchanged (thinking persistence is still off unless enabled), and legacy `persistAgentThinkingLog` is retained as a backward-compatible fallback when granular keys are unset.
- 8201157: Add a General setting (`ephemeralAgentsEnabled`, default true) to toggle ephemeral task-worker agent usage. When disabled, the scheduler auto-assigns every dispatchable task to a permanent executor based on the agent reporting chain and refuses to spawn `executor-FN-XXXX` workers.
- 5b3c8d3: Add per-agent runtime setting `skipHeartbeatWhenIdle` that pauses scheduled (timer) heartbeats when an agent has no assigned task. Assignment-trigger and on-demand wakeups still fire. Default: off.
- 1b925f1: Add bulk Pause / Unpause / Archive actions to List View bulk edit.
- bbfb2b7: cli-printing-press: contribute script-mode workflow step templates and fix the core
  resolver so plugin-contributed workflow steps honor their declared mode, phase,
  and scriptName instead of being collapsed to prompt-mode.
- 72ccff0: Add `fn chat [agent-id]` for interactive multi-turn chat with an agent from the CLI. Connects to a running `fn dashboard` / `fn serve` over its existing chat HTTP+SSE API and streams responses incrementally. Supports `--session <id>` to resume, `--url` / `--token` / `--no-auth` to target alternate servers, and stdin piping for scripted single-turn messages.
- d4cac08: Add stalled-review detection: in-review tasks repeatedly re-enqueued for merge or hitting invalid-transition recovery loops now surface a "Stalled" badge on the board with the heuristic reason.
- 7d12b9e: Add capacity-risk warning when the Todo queue exceeds the configured threshold and no idle non-ephemeral agents are available. New project setting `capacityRiskTodoThreshold` (default 20). `GET /api/agents/stats` now also returns `idleNonEphemeralCount` and `todoTaskCount`.
- 0e7bd5c: Surface explicit in-review stall reasons. Completed-looking tasks parked in In Review without a matching recovery path now expose a machine-readable `task.inReviewStall` signal (e.g. `transient-merge-status-no-owner`, `merge-retries-exhausted`, `no-worktree-no-merge-confirmed`, `merge-blocker`) and self-healing logs the reason to the task once per stuck-timeout window.
- 076f132: Surface `task.inReviewStall` in the dashboard. In-review tasks whose state matches a known stall code (merge-blocker, transient-merge-status-no-owner, merge-retries-exhausted, no-worktree-no-merge-confirmed) now show a "Stall" badge on the task card and a code-specific diagnostic row in the task detail modal, with a deep-link to the most recent self-healing "In-review stall surfaced" log entry.
- 085c44b: Auto-recover from post-merge audit blocks: programmatic per-file survival check, optional AI-driven restoration pass, and an audit-bounce loop (parallel to conflict bounces) before parking a task as failed. Governed by the new `mergeAuditAutoRecovery` setting (default: `ai-assisted`).
- 7bc58d2: Defer "task failed" push notifications so they only fire when a failure persists. New global settings `failureNotificationDelayMs` (default 30000) and `failureNotificationMode` (default `sticky-only`) gate the behavior; set mode to `all` or delay to `0` to restore legacy immediate dispatch.
- aaed8b9: Stop the post-merge audit from parking tasks as `failed` when deterministic merge verification already proved the resulting tree. Adds `postMergeAuditMode` project setting (`"block"` | `"warn"` | `"off"`, default `"block"`):

  - A `rebase`-strategy audit that flags only touched-file overlap risks now passes through when the merged tree has a verification cache hit — silent drops are impossible by construction in that case.
  - `warn` mode logs audit findings on the agent log but auto-completes the merge.
  - `off` skips the audit entirely.

  Duplicate-subject findings still block in `block` mode and squash-strategy audits still block (no equivalent deterministic guarantee). The FN-3936 silent-drop guard is preserved.

### Patch Changes

- a35d4dc: Add an Agents Org Chart layout toggle (Horizontal, Vertical, Auto) and persist the selected layout preference per project so users can override automatic layout selection.
- 2ff2c1f: Tighten dashboard chat prompt guidance so agent replies stay short by default, and route genuinely long-form follow-ups to mailbox via `fn_send_message` (`type: "agent-to-user"`, `to_id: "dashboard"`) without duplicating chat content.
- 5225300: Clarify Fusion Research subsystem positioning vs upstream pi-autoresearch.
  Tightens user-facing copy on fn*research*\* tool descriptions, the fn
  research CLI help, and the dashboard Research view to remove false-friend
  expectations with the autonomous experiment loop. No tool, type, table,
  route, or schema renames. No behavior changes. Adds a naming decision
  record at docs/research/naming-decision-2026-05.md.
- b514ed0: Task Review tab: clicking links or code inside a review item's markdown body no longer toggles the item's selection checkbox, and the mobile header actions row now wraps instead of forcing equal-width buttons.
- 53c08b5: Fix clickable file paths reliability by ensuring `FileBrowserProvider` wraps every render branch in `AppInner`, including the loader branch.
- a51d14e: Add a deterministic terminal contract for stuck-loop retry exhaustion. Exhausted tasks are marked failed with a `STUCK_LOOP_EXHAUSTED:` error prefix, receive a final operator guidance log entry, and are untracked by the stuck detector so automatic kill/requeue churn does not continue until the task is manually recovered.
- 6f976d3: `fn serve` and `fn daemon` now auto-register the current directory as a Fusion project on first run, fixing the `No engine started for the current project — exiting` failure in CI/Docker/cron/headless environments. Pass `--no-auto-register` to preserve the previous strict behavior.
- 8e0f3d4: Clickable file path links in dashboard chat, logs, activity log, settings sync log, and task detail now inherit the color and alignment of surrounding text instead of forcing centered info-blue text. The dotted underline and hover/focus affordances are preserved.
- cd7779c: Suppress transient auto-merge failure surfacing: `failed` notifications now wait through a grace window and are dropped when self-healing confirms recovery, while persistent failures still notify. Non-conflict auto-merge failures are now logged to task history instead of persisting a hard-failure user comment.
- 09f4236: Dashboard: GitHub-import provenance in the task detail modal now renders as a compact `owner/repo#NN` link instead of dumping the full issue URL inline. Long research/finding context strings truncate with a tooltip so the header metadata stays scannable on narrow widths.
- b799a4e: Improve workflow-step scope gating for pre-merge checks. The built-in Frontend UX Design workflow step now auto-skips using both diff scope and declared `## File Scope` signals, reducing off-domain runs. Prompt-mode pre-merge workflow steps now perform end-of-step file-scope enforcement with a new `workflowStepScopeEnforcement` project setting (`block` default, `warn`, `off`) and honor task `scopeOverride` bypasses.
- 9e89c3b: Clarify that `ephemeralAgentsEnabled` defaults to `true` for both new projects and upgrades where legacy persisted settings omit the key, while preserving explicit `false` opt-outs.
- c50e152: Fix chat queued follow-up delivery so pending messages auto-send when streaming completes through recovery paths (SSE message-added recovery, polling finalization, and visibility-resume), not only fresh-send onDone/onError handlers.
- 7a9713d: Increase the Settings → Memory editor minimum height on mobile so it stays taller than desktop for easier editing.
- b71371e: Merger now treats history-preserving cherry-picks that are fully duplicated on `main` as a clean no-op: tasks auto-complete to `done` with a clear log message instead of failing as `Auto-merge failed`. Partial duplicate branches also skip only empty cherry-picks and continue landing non-empty commits.
- 95c5340: Fix executor baseCommitSha capture to use the merge-base with main instead of HEAD,
  and preserve an existing valid baseCommitSha across multi-session task work.
  Resolves false `fn_task_done` "no_commits — observed=0" failures on multi-session
  branches (FN-4309).
- 35854e0: Fix false-positive `BranchCrossContaminationError` that paused tasks at start when their stored `baseCommitSha` was stale relative to `main`. The contamination check now computes a fresh merge-base against the integration branch instead of reusing the diff-stable `task.baseCommitSha`, and `captureBaseCommitSha` only preserves a prior stored value when resuming an existing worktree. Diff-base stability across resumed sessions is preserved (FN-4309/FN-4383 behavior unchanged).
- fb50956: Fix executor worktree invariant handling so restart and stale-session recovery paths create fresh sessions correctly without tripping false liveness failures.
- 79cef01: Fix plan-review UNAVAILABLE silently stalling tasks in-progress by retrying reviewer verdict extraction once (preferring validator fallback model) and degrading plan/spec UNAVAILABLE outcomes to advisory when retries are exhausted.
- 7f86215: Add an executor durability guard that prevents silent requeue when a task worktree still has uncommitted attributable changes. Affected recovery/requeue paths now park the task as failed with stranded-worktree diagnostics (including worktree path and recovery hints) instead of dropping back to todo without operator visibility.
- e43cdd2: Engine reliability: fn_task_done now rejects completion when the executor session is not running in the task worktree/branch or has zero commits beyond base, and worktree liveness is asserted before session start. Both failure modes route through the existing auto-retry path so the task returns to todo instead of producing a ghost completion.
- b4b80ac: Keep the GitHub tracking Enable button mounted (and disabled) while a save is in flight so the header layout stays stable.
- bcc0331: Restore the mobile touch-target size on the compact GitHub tracking "Enable" button in the task detail header.
- 459ce24: Fix PluginManager detail header so long plugin error messages wrap instead of truncating to a single line.
- 539c730: Show Web Search as a locked “Always on” row in Project Research settings so the settings surface matches Research view behavior.
- 8e08891: Improve dashboard GitHub tracking UX by disabling the "Create tracking issue" action when a task has no usable title/description and showing clear helper text about when creation will occur. Also make the title summarization model more discoverable by surfacing it when GitHub tracking defaults are enabled and clarifying that the model is used for GitHub tracking issue title summarization.
- fcd70d4: Reset ChatView composer autosize when `messageInput` changes programmatically so send/clear and draft restore paths collapse or clamp textarea height correctly.
- fb50956: Fix workflow live-log pending-state rendering so "Waiting for agent output…" appears when only stale agent log entries exist from earlier runs.
- fb5bf9b: Show a spinner in place of the GitHub tracking Enable button while the linked-status request is in flight, so the row layout stays stable and the pending state is clearly indicated.
- eb1e4e6: Self-healing now clears downstream `blockedBy` fan-out when an `in-review` blocker has been stuck in `status=merging` past a configurable threshold, preventing a single hung merge-verification from freezing the todo lane.
- 86a40dd: Promote the Missions view Drafts section above persisted and standard mission rows so in-progress mission interview drafts are surfaced sooner.
- ca6fe91: Polish Mission Drafts UX by hiding the mission empty state when draft or in-progress interview items are present, and by using labeled draft-row actions (`Resume`/`Generating…`/`Retry` and `Discard`) for clearer interaction.
- e03146f: Fix overlap requeue state reconciliation so durable assigned agents are no longer left in `running` state with stale `executionTaskId` links when their task is requeued in Todo. Adds scheduler rollback plus self-healing backstops for stale running/task-column mismatches.
- 8240a29: Fixes direct-report health classification in heartbeat report summaries to use each report's configured heartbeat interval instead of heartbeat timeout budget. Reports are now marked stale only when heartbeat age exceeds `max(heartbeatIntervalMs × 4, 5 minutes)`, matching the dashboard health semantics and preventing false stale flags for agents still within their scheduled cadence.
- c8a00ad: Run task-scoped heartbeat sessions for permanent (durable) agents inside the task's git worktree, matching ephemeral-agent task execution. No-task heartbeats continue to use the project root.
- 6c0a0f4: Keep the Task Detail modal source issue chevron on the same header row as the source metadata on mobile and narrow layouts.
- b3f9a8a: Fix: enabling GitHub tracking on a task imported from GitHub now creates a tracking issue instead of silently skipping. The board task card shows the tracking-issue link unless it points at the exact same `owner/repo#number` as the imported source issue.
- b5905dc: Polish the SettingsModal research panels by grouping provider controls, clarifying advanced-provider nesting, and aligning project research limits into a responsive grid with regression coverage.
- bd7544f: Fix SettingsModal header layout on narrow phones — header now reflows so the close button stays visible and tappable.
- bb03977: Add a tree-equality fallback to already-merged review-task recovery so retry-exhausted in-review tasks can auto-finalize when task and base branches resolve to identical trees.
- ebc5f70: Reports Health Check now flags a direct report as stale only when its last heartbeat is older than `1.5 × heartbeatIntervalMs`, with a 5-minute minimum threshold floor for agents without a configured interval. This eliminates recurring false positives for long-cadence direct reports while preserving the existing fallback behavior.
- eb015bc: Add an opt-in `capacityRiskBannerEnabled` project setting for the board capacity-risk warning and make the banner dismissible per project, with dismissal reset when the setting is re-enabled or the todo threshold changes.
- 5e564cd: Fix done-task Files changed count and task-detail file list to aggregate across the full landed commit range (via task_commit_associations) instead of only the final merge commit. Restores accurate counts for tasks that land through multiple commits (e.g. rebase-merged tasks with revision commits).
- 039e9a2: Prevented merger squash commits from carrying gitignored files by unstaging ignored paths (including `.fusion/` task artifacts) before writing merge commits.
- f6744e0: Direct chat now always anchors to the latest message when the chat view becomes visible (tab refocus, pageshow, scope switch back from Rooms). Rooms and QuickChat behavior unchanged.
- 6287c14: Removed the Plan and Subtask AI-assist buttons from the New Task dialog. The same Plan/Subtask actions remain available in the board quick-entry box and other inline create surfaces.
- 954ccba: Direct chat ("main chat") now stays pinned to the latest message on mobile when content lays out asynchronously (markdown, code highlighting, attachments, iOS keyboard offset) or when returning to the tab. Rooms and QuickChat behavior unchanged.
- bb0d611: Chat now auto-reconnects when you return to the browser after the tab was suspended mid-generation, instead of showing a Load failed banner.
- 187a029: Normalize task card badge heights so planning, merging, urgent, high, and low pills render at the same height.
- c4e0e25: Fix sporadic disappearance of the GitHub linked-task badge on task cards caused by transient WebSocket null merges, render gating that ignored live/batch badge sources, and badge snapshot loss during viewport unsubscribe/resubscribe cycles.
- 1e4d146: SettingsModal mobile header: keep the GitHub Star, Help, "Settings" title, and close (×) controls on a single row at ≤768px instead of wrapping the action buttons to their own row.
- 48c6343: Prompt users for GitHub tracking issue handling when deleting a task, with explicit options to close, delete, or leave the linked issue unchanged. Also adds `githubIssueAction` plumbing through the API/store and gh-CLI-backed issue deletion support.
- 1291059: Dashboard no longer calls the GitHub API on every board load to refresh PR/issue/tracking-issue status. Cards now render from persisted task state (`prInfo`, `issueInfo`, `githubTracking.issue`) and live WebSocket badge updates, while explicit refresh via `POST /api/github/batch-status` remains available.
- bb65002: Fix FN-4068 branch-conflict recovery hot loop: prevent repeated "Branch conflict recovery required" emissions and add a per-task tripwire that hard-pauses after 5 repeats.
- 1fbfe9f: Validate File Scope entries in PROMPT.md at task-create/update time. Reject git refs (`origin/fusion/fn-4280`), URLs, SHAs, and other non-path tokens with a clear `InvalidFileScopeError`. `parseFileScopeFromPrompt` also silently drops invalid tokens at read time as defense-in-depth, so the file-scope invariant on squash merges is no longer weakened by malformed scope declarations.
- f790436: Revert the Todo aging indicator added in FN-4316. The Todo column header
  no longer shows age-bucket counts or supports click-to-filter by bucket;
  Column rendering and pagination behave exactly as they did before
  FN-4316.
- 3afc086: Quick Chat now reliably restores the most recently active non-archived conversation by session ID when reopened, instead of occasionally landing on an older thread that shares the same target.
- 9ba4ef5: Add targeted self-healing for orphan-only `FileScopeViolationError` failures: when an in-review failed task only staged out-of-scope orphan files and the task's work is positively verified as already landed on the base branch (Fusion-Task-Id lineage checks), Fusion now auto-finalizes the task as a no-op (`orphan-discard-no-op`) and discards orphan staging via worktree cleanup instead of requiring a manual retry click (FN-4350), while preserving FN-4280 guardrails by skipping recovery when landed-work evidence is absent.
- 4334900: Change default `postMergeAuditMode` from `"block"` to `"warn"`. The post-merge audit still runs and findings are still logged on every merge — only the auto-completion gate is relaxed. This avoids FN-4277-class auto-merge failure storms on verified-rebase merges with overlap-only false positives. The file-scope invariant remains a stricter floor. Users who want the previous stricter behavior can set `postMergeAuditMode: "block"` explicitly in `.fusion/config.json`.

## 0.28.1

## 0.28.0

### Minor Changes

- af39d47: Surface in-flight mission interview drafts in the dashboard Missions view, `fn mission list`, and the `fn_mission_list` pi tool. Adds Resume and Discard actions for drafts, plus `GET /api/missions/interview/drafts` and `POST /api/missions/interview/drafts/:sessionId/discard` endpoints.
- db919df: Close the linked GitHub tracking issue (with state_reason "not_planned") when a tracked Fusion task is deleted.
- be5e1fb: Route multi-substantive direct-merge task branches through a history-preserving merge path by default, with new project and per-task controls for forcing squash vs rebase-style commit preservation.
- 044b1cb: Add a new `message:room` notification event for agent assistant replies posted in chat rooms. The event is enabled by default for ntfy notifications and can be tested or toggled from Settings → Notifications alongside the existing direct-message events.
- 7e057a6: Export `DiffVolumeRegressionError`, `MergeAbortedError`, and `SquashAuditError` from `@fusion/engine` so consumers can use `instanceof` checks without deep-importing.

### Patch Changes

- ad45a23: Merger now refuses to land a squash whose staged diff has zero overlap with the
  task's declared `## File Scope`. Tasks can opt out by setting
  `task.scopeOverride = true` (with optional `task.scopeOverrideReason`).
  Violating squashes leave the task in `in-review` with a structured agent-log
  entry instead of silently shipping out-of-scope changes.
- 37063a0: fn_task_done now appends to the existing task summary when a workflow step
  forces a rerun, instead of overwriting the original completion summary.
- 239f7bf: Chat composer text is now persisted per conversation and recovered across page refreshes.
- a9e2b07: Heartbeat scheduling now auto-reaps stale active heartbeat runs so durable agents recover regular timer ticks without requiring a manual stop/start.
- 4a60568: Restore Quick Chat so reopening the dashboard resumes the most recently updated session instead of always defaulting to the first agent or default model.
- 7a982a2: Fix ntfy notifications so unicode mailbox titles deliver correctly and oversized titles/messages are truncated before publish.
- 917ffa5: Dependency graph: support trackpad/two-finger scroll and mouse wheel to pan when zoomed in. Hold Ctrl/Cmd (or use a trackpad pinch) to zoom.
- 2822781: Task detail Review tab now renders review item bodies as markdown by default, with a Markdown/Plain toggle that persists per user.
- 84ccc47: GitHub tracking 'done' comments now include the merge commit SHA, subject, branch, PR link, file-change stats, and merge timestamp when available.
- f7b12b5: Dashboard now warns before starting OAuth login for providers whose redirect can't reach the dashboard host (Anthropic / OpenAI Codex), reminding users to copy the browser address bar URL before the redirect tab navigates away.
- 056b1a9: Chat room composer now clears immediately when a message is sent and restores the typed text only if the send fails, matching standard chat UX.
- 8653a36: Fix chat room send button on mobile: first touch now sends the message instead of dismissing the keyboard.
- 4a6b561: Auto-open newly created chat rooms in the dashboard so successful room creation immediately reveals the new thread, including collapsing the mobile sidebar.
- bbd92a1: File paths in dashboard chat messages, logs, and task detail markdown are now clickable and open in the integrated file browser.
- 75fe39d: Fix `fn_task_done` failing to clear `paused`/`pausedByAgentId` when called on a paused task (FN-3964). Before this fix, a task with `task.paused=true` in `in-progress` or `todo` would land in a contradictory `todo + paused` state after completion, blocking future scheduler picks. Now the executor always clears task-level pause flags on explicit agent completion.
- acc2db9: Fix GitHub tracking issue creation under gh-cli auth mode (`gh issue create` does not support `--json`); surface tracking creation failures in the task activity log.
- 2881d86: Fix dashboard crash `undefined is not an object (evaluating 'taskIdIntegrity.status')` when the health response lacks `taskIdIntegrity` (e.g. older dashboard server). The banner gate in `App.tsx` now optional-chains `taskIdIntegrity` so the page renders cleanly when the field is missing.
- 6124535: Fix `ENOENT: ... rename 'task.json.tmp' -> 'task.json'` failures when two TaskStore instances (e.g. engine + dashboard server) write to the same task concurrently. The shared `task.json.tmp` filename caused one writer's `rename` to consume the tmp file and the other's to ENOENT. Each write now uses a unique tmp filename (`task.json.<pid>.<uuid>.tmp`) and cleans up its own tmp on rename failure.
- a79dbfc: Fix mobile Safari layout glitch where switching to the Kanban board view could render the dashboard compressed in a corner.
- 75fe39d: Make executor branch-name collisions fail loudly by default, add a legacy opt-in escape hatch, and introduce CLI branch recovery commands for reclaiming or discarding stranded task branches.
- 429bdc2: Merger now detects when the Attempt 3 `-X ours` fallback under
  `mergeConflictStrategy="smart-prefer-main"` would resolve files that main has
  recently modified, and by default prefers the branch side on those overlapping
  files to avoid silently discarding branch work (FN-3936). Configurable via the
  new `mergeStrategyOverlapBehavior` setting (`flip-to-prefer-branch` default,
  `warn-only`, or `ignore`).
- 8b037e4: Add a pre-commit diff-volume gate for auto-resolved squash merges. Fusion now compares each file's staged squash delta against the branch's net delta and blocks the merge in `in-review` when a non-allowlisted file silently loses too much branch content.

  Add three new project settings for tuning the gate: `mergeDiffVolumeMinLines` (default `20`), `mergeDiffVolumeThreshold` (default `0.2`), and `mergeDiffVolumeAllowlist` (default `[]`).

- a136dd3: Stale `blockedBy` markers no longer prevent `fn_task_done`, and self-healing now repairs stale blockers on active `in-progress` and `in-review` tasks as well as `todo` rows.
- 162f4da: Documented the `fn task branch-recovery` CLI flow and the `executorAllowSiblingBranchRename` project setting.
- 759f8f5: Mobile chat composer now renders the agent mention popup above the input.
- 24b839b: Keep chat room threads anchored to the latest message when returning to a room, switching rooms, or resuming the mobile view.
- 8737779: Show the chat sidebar search input on mobile instead of leaving an orphan search icon.
- 203cb16: Simplify the task-card fan-out badge label by dropping the trailing "(N todo)" parenthetical from the visible text while keeping the hover tooltip context intact. The badge count now inherits the same fan-out meta text color as the surrounding label.
- bc5fdd2: Fix the bundled dependency-graph plugin so it no longer lands in a phantom error state in Settings when the Graph view still works, and show the underlying plugin error message in Plugin Manager whenever a plugin is in the error state.
- b387df8: Fix zero-step in-review retry classification to route execution-side failures correctly, closing the remaining gap from PR #59 and crediting HarryCordewener's original workstream.
- 7e089e1: Recover agent/task reassignment sync from upstream PR #58 (author: HarryCordewener). TaskStore.updateTask now keeps agents.taskId aligned with task.assignedAgentId, clears stale checkout leases held by the outgoing agent, and protects against races where the outgoing agent has already moved on.
- 0f5a5b5: Lazy-load `dockerode` for Docker support, with actionable missing-package errors instead of import-time failures. Based on HarryCordewener's work in PR #58 and PR #59.
- 75fe39d: Fix the dashboard Research view layout so the sidebar, reader pane, actions, findings, and stats render cleanly without overlap on desktop and mobile.
- 2d250e6: Keep web search always enabled in the Research view and remove the `none` web-search provider option plus the per-project Web Search source toggle from settings.
- 062b5a9: Mobile swipe-back from chat conversation, mission detail, and planning session detail now returns to the corresponding list instead of escaping the view.
- f8066c4: Default the Settings modal to the General section instead of Authentication when no initial section is specified.
- 0a03ad8: Board task cards now show a GitHub icon when linked to a tracked GitHub issue.
- d899443: Fix: clear task-level pause on `fn_task_done` so explicit agent completions cannot strand tasks in a `paused` state. Hard-pause gating for deferred completion handoff now keys off `globalPause` only.
- c55494e: Add a one-click inline "Enable GitHub tracking" button to the task detail GitHub tracking header when tracking is disabled.
- 08b4af3: GitHub tracking now derives an issue title and transition-comment title from the task description (and, when configured, the AI title summarizer) instead of emitting "Untitled task" when the Fusion task has no title.
- dfb613e: Fix mobile layout of the GitHub tracking enable button on the task detail modal so it stays before the disclosure toggle and no longer overflows narrow screens.
- fd2744a: Shorten the GitHub tracking enable button text to "Enable" and reduce its size in the task detail header.
- e75274e: Fix GitHub tracking state appearing stale/inaccurate on tasks after engine restart.
- 1802fde: Make the GitHub tracking "Enable" button render as a compact header action on desktop while preserving the mobile touch target.
- cec9bcb: Align the Research view provider checklist with the always-on web search behavior from FN-4135 by keeping **Web Search** visible as a locked checked option with an **Always on** affordance.
- 12a08cb: Surface GitHub tracking project options (default on/off for new tasks, default repo) in the project General settings section.
- fbd441e: Surface pending chat-room messages during agent heartbeats and let permanent agents reply with a new `fn_post_room_message` tool.
- 8d48359: Chat rooms now intelligently compact older messages into a summary header
  when transcripts exceed the verbatim window, preserving long-running
  context for agent replies instead of silently dropping earlier turns.
- 8775267: Fix GitHub tracking disclosure icon alignment in task detail — chevron now stays on the first row when summary wraps.
- f397e71: GitHub tracking now waits until a task has a usable title before creating a tracking issue instead of publishing `[FN-XXX] Untitled task` placeholder issues.
- d084ff4: Fix mobile swipe-back from the Planning modal's "New Session" path: opening a new planning session on mobile now registers a back-stack entry so swipe-back returns to the planning sessions list instead of closing the modal.
- bbfd6a9: Raise the dashboard chat composer autosize cap so longer drafts stay readable before scrolling.
- a347871: Detect task-ID allocator integrity anomalies at startup and on demand, log them as structured errors, surface them through /api/health, and render an operator-visible dashboard banner with the affected IDs and recommended next action.
- 72453bb: Permanently-failed `in-review` tasks no longer block overlapping superseding tasks from being dispatched by the scheduler's file-scope overlap guard.
- d301f0b: Keep the GitHub tracking header actions on the same row as the label in the task detail modal.
- 4a6b561: Tighten the Task Detail modal GitHub tracking header into a compact single-row summary with the inline Enable action and disclosure toggle staying aligned across desktop and mobile layouts.
- 55eeb81: Dependency graph: double-tap a task node on mobile to open task detail.
- ac59d5c: Override task-scoped heartbeat procedure files during no-task heartbeats so ambient runs only receive tool-safe prompt guidance.
- 1d87d77: Anchor the GitHub linked/imported indicator icon to the bottom-right corner of dashboard task cards while preserving existing link behavior and accessibility metadata.

## 0.27.1

### Patch Changes

- c1035d8: Include database integrity health details on `/api/health` with `database.healthy`, `database.lastCheckedAt`, and `database.isRunning`.
- ee46b5a: Fix stale in-review session/worktree recovery so retries discard mismatched persisted session metadata, recover missing-worktree review failures into runnable state, and unblock downstream todo tasks stalled by stale review blockers.
- 4d47cb4: Improve SQLite write reliability under transient multi-connection lock contention by adding bounded recovery for outer write transactions, keeping task mutations and run-audit inserts atomic during executor-driven writes.
- 7b5ec3d: Surface task ID collision errors for task creation and delegation tools.
- fc863f6: Block auto-resolved squash merge completion when the post-squash audit flags duplicate-subject or touched-file overlap risks, while keeping the audit script available for manual follow-up.
- 1a1f60c: Fork workflow revision feedback that escapes a task's declared File Scope into dependent follow-up tasks instead of always appending it to the original task prompt.
- e390478: Add `priority` support to `fn_task_create` across runtime and published extension tool surfaces, with updated Fusion skill docs and references.
- 7ca8d5a: Add optional ntfy access-token settings support so authenticated ntfy topics receive `Authorization: Bearer <token>` on runtime and test notification publishes.
- 9c80988: Task Detail: keep Created/Updated timestamps on a single row on mobile too.
- f3a3975: FN-4082: retry oversized code reviews with a compacted request after provider context-limit errors like Kimi's `exceeded model token limit` failure.
- 06feb61: Improve SQLite write reliability under concurrent executor activity by enforcing WAL/busy-timeout setup on every disk-backed connection, using explicit immediate transactions for task+audit writes, and adding disk-backed concurrent-write regression coverage.
- 5804b86: Fix merger starvation where eligible in-review tasks looped in auto-recovery
  without ever merging. Leaked in-memory merge-queue entries are now reconciled
  automatically, and tasks whose re-enqueue is repeatedly dropped escalate to a
  clear `status=failed` with an `Auto-merge starvation:` error instead of
  looping indefinitely.
- 5bdf92b: Optimize Database.init() schema-compatibility passes: cache per-table PRAGMA results within init and short-circuit unchanged-schema opens via a `schemaCompatFingerprint` in `__meta`. Reduces repeated `db.init()` wall time substantially without weakening the FN-3879/FN-3887/FN-3898 invariant that every declared column exists after init.
- 3ac619d: Fix blank space at the bottom of the New Agent dialog on mobile by removing the inner preset-grid scroll cap so the dialog body scrolls naturally.
- bec0b34: Harden task creation so stale allocator state or colliding reservations fail safely instead of overwriting an existing task row or task directory.

## 0.27.0

### Minor Changes

- 2fa4ba9: Add plugin signature verification and publisher trust policy controls across plugin install/load workflows. Plugin status now exposes publisher identity, key fingerprint, and verification state, with new trust-management and verification commands plus project-level `pluginTrustPolicy` enforcement modes (`off`, `warn`, `enforce`).
- 7fd3ccc: Add bundled fusion-plugin-cli-printing-press plugin: a guided wizard for defining external services and generating CLIs from those definitions, plugin-owned dashboard views for managing and manually running generated CLIs, and availability of generated CLIs as pre-merge workflow steps and inside the executor runtime environment.
- bd26b24: Add room-based chat to the dashboard. Users can switch between Direct and Rooms modes in ChatView, create Slack-style rooms (for example `#engineering`) with selected agent members, and chat with multiple agents in shared persisted history. `@mentions` route directly to the named agent, while other room members can respond when relevant.
- 840cd1d: Add a global setting, `persistAgentThinkingLog` (default `false`), to control whether agent thinking/reasoning log rows are persisted. Tool output persistence remains separately controlled by `persistAgentToolOutput`.

### Patch Changes

- aa031ab: Add a bundled `fusion-plugin-cli-printing-press` plugin with a plugin-owned Create Service wizard view and draft-save API scaffold.
- 0fb9bb5: Add a plugin-owned CLI Printing Press manage view with list/inspect/edit/regenerate/delete draft actions, plus draft update and regenerate API routes backed by the interim JSON draft store.
- 36b6643: Add CLI Printing Press plugin run/test generation and execution actions, including regenerate/run/artifact endpoints, dashboard test-runner UI, and credential redaction for run output.
- 1e76f24: Define and use a canonical SQLite-backed storage/config model for the bundled CLI Printing Press plugin, including service/spec/artifact/credential/settings tables and non-OAuth credential materialization helpers.
- a04b320: Add a new `executorRuntimeEnv` plugin contribution surface so plugins can inject task-scoped runtime environment variables and PATH prepends for executor-spawned commands.

  The bundled `fusion-plugin-cli-printing-press` now contributes generated CLI artifact directories to task PATH and exports `env_var` credentials into the task environment for executor command execution.

- a39985c: Add approval-policy guards for `fn_agent_create` and `fn_agent_delete` with
  `agentProvisioning` project settings, pending-approval outcomes, and approval-route
  execution/audit handling for approved and denied provisioning requests.
- 6b55b26: Update room chat mention UX so the mention popup prioritizes room members (with a member indicator) and rendered room-message mention chips visibly flag non-members, while preserving direct-chat behavior.
- a4617be: Merger verification now runs `scripts/ensure-test-artifacts.mjs` as a preamble
  and self-heals "Failed to resolve entry for package <pkg>" failures by
  rebuilding the missing workspace package once before retrying. Unrecoverable
  environment faults no longer increment `verificationFailureCount` or bounce
  the task to `in-progress` — they remain in-review for the next sweep.
- d6da4eb: Fixes a merger/self-healing recovery loop where in-review tasks with zero commits ahead of base were repeatedly re-enqueued forever. Fusion now detects deterministic no-op merge branches, marks them as no-op merge confirmed, and finalizes them to done instead of requeueing.
- 1257155: Fix phantom-merge guard stranding tasks whose branch content is already on
  main under a different SHA (sibling-task duplication, cherry-pick, prior
  in-merge fix). The merger finalize path now recognizes ancestor and
  equivalent-patch-id branches as a no-op success instead of refusing the
  merge. The FN-1858 phantom-merge guard remains intact for the real-phantom
  case (no recoverable content anywhere).
- 6f2e8c4: Update the default heartbeat procedure to enforce bound-task scope discipline by classifying work as `executor-class`, `blocked`, or `coordination-class`, and steering executor/blocked ticks toward coordination actions instead of implementation advancement. Existing agents that already have seeded per-agent heartbeat files keep their current content until operators explicitly run the heartbeat-procedure upgrade endpoint, which re-seeds from the latest built-in default.
- d1f4d5f: Expose verificationFixRetries (0-3) in Settings → Merge so users can tune in-merge auto-fix attempts without editing JSON.
- 867c684: Fix scheduler overwriting `blockedBy` on queued todo tasks every tick, which caused unrelated work to converge on a single broad-scope in-progress task. Stamping is now sticky-when-still-valid with deterministic tiebreak.
- 3c2f1bd: Post-merge prompt workflow-step agent sessions now honor the assigned agent runtime model (`runtimeConfig.model`) when the workflow step does not provide its own model override, matching the rest of the merger session model resolution path.
- c41d49f: fix(FN-3906): auto-skip the built-in Frontend UX Design pre-merge workflow step when the task diff scope has no frontend/UI files, so non-frontend tasks no longer get stuck behind paused completion handoff deferrals for an irrelevant review gate.
- 7d67dc3: Wire dashboard approval decisions for `agent_provisioning` requests to execute deferred agent create/delete actions.

  Add focused test coverage for provisioning decision routing, policy/gating contracts, and approval request category round-trips.

- 86df0a0: Executor task runtime environment now flows through `createResolvedAgentSession()` and `createFnAgent()` into task-scoped agent subprocesses (including executor-session bash commands). Plugin-provided `executorRuntimeEnv` PATH/env contributions are available inside agent-issued subprocesses while remaining isolated per task/session with no global `process.env` mutation.
- 9b4cf90: Expose `verificationFixRetries` in Dashboard Settings → Merge so users can configure merge verification auto-fix retry attempts.
- e6e596e: Move full SQLite integrity checks off the startup critical path by running `PRAGMA integrity_check(100)` asynchronously after boot. Expose database integrity state on `/api/health` via `database.corruptionDetected`, `database.integrityCheckPending`, and `database.integrityCheckLastRunAt` while preserving existing top-level health fields.
- 0f5c086: Restore the CLI db vacuum command module wiring so tests and runtime command loading succeed.
- e4ec922: Fix `fn db --vacuum` exit handling so successful exits are not caught as VACUUM failures, and await async vacuum errors correctly.
- 6c0cf78: Skip PluginLoader loadability test when dist/index.js is absent (CI shard fix).
- 81f143d: Fix fusion startup crash caused by the roadmap plugin's main entry re-exporting `RoadmapDashboardView`, which transitively imported a `.css` file under Node's tsx ESM loader. The dashboard view is still reachable through the dedicated `./dashboard-view` subpath used by the bundled-view registry.
- 32e76c8: Expose `/api/mesh/state` as a real cluster snapshot API that aggregates peer-local mesh state and powers Nodes topology from actual `knownPeers` relationships instead of fabricated node-list links.
- 3a67c1b: Align the bundled roadmap plugin to the canonical `fusion-plugin-roadmap` runtime id, expose roadmap APIs under `/api/plugins/fusion-plugin-roadmap/...`, and restore `/api/roadmaps` compatibility routing through plugin-owned handlers during migration.
- d0a2d90: Add reports plugin HTML rendering templates, standalone offline export output, and HTML plugin route response support (`headers` + `contentType`) for attachment/preview endpoints.
- 4535db5: Add Reports plugin dashboard view with list/history, filters, detail viewer, and period comparison.
- 63fe25e: Reports plugin: add human approval/publish workflow and share-ready summary blocks (plain text, Markdown, Slack, email HTML) to the dashboard report detail viewer.
- d6d3a29: Quiet benign Claude Code CLI stderr on clean shutdown by routing it to debug-only logs in `pi-claude-cli`.

  This prevents MCP loading/initialization lines from surfacing as warning/error-level entries in the TUI Logs tab when Claude exits cleanly, while preserving warning/error surfacing for non-zero Claude CLI exits and authentication-related failures.

- ef3281b: Preserve whitespace at SSE delta boundaries in dashboard chat streaming so streamed multi-sentence assistant responses render `. ` correctly between sentences in ChatView and QuickChatFAB.
- 9b4cf90: Engine now auto-hydrates each task worktree's `.fusion/fusion.db` with the current task plus transitive dependency rows and their `task_documents` on worktree creation, pool acquire, and resume. Cross-task `sqlite3 .fusion/fusion.db` lookups in PROMPT.md no longer fail silently. Falls through with a warning on any failure; worktree creation is never blocked.
- eb14812: Add automatic recovery for board-level merge deadlocks by promoting retry-exhausted already-landed review tasks to done, clearing stale `blockedBy` references on todo tasks when blockers are terminal or deadlocked, and excluding paused in-review worktrees from scheduler overlap `activeScopes` so paused blockers cannot repeatedly re-stamp downstream tasks.
- 76c113c: Reports plugin: add interim cadence/aggregation/pipeline/runs-store seam exports so downstream tasks (FN-3780+) can plug in real implementations without scaffold churn.
- ef4aeb2: Move agent Run Now control into the agent detail header next to lifecycle buttons.
- d695201: Scheduler now auto-unblocks multi-dependency tasks when any blocker reaches done/archived; self-healing recovers stale queued status.
- d6da4eb: Restore icon on the agent card "Details" button and only hide action labels in the split sidebar when buttons would not fit.
- e4ec922: Allow durable `role: "engineer"` agents to receive explicitly routed implementation tasks via assignment and delegation flows without requiring `override=true`.
- 17ef50f: Align `fn_task_retry` retry classification for `in-review` failures across dashboard and CLI surfaces. Execution-failed review tasks (incomplete steps) now retry back to `todo` with preserved progress, while merge-only failures (all steps done) stay in `in-review` with merge retry state reset. Also removes visible mission validation board-task creation in favor of internal validator runs.
- d7980d5: Surface high fan-out blockers in the dashboard by escalating blocker badges and footer status summaries when a blocker has at least 5 active todo dependents.
- 48aea50: Prevent auto-merge loops on terminal invalid done-transition failures during merge recovery.

  When merge finalization encounters a non-recoverable state-machine error like
  `Invalid transition: 'todo' → 'done'`, auto-recovery now keeps that task parked
  in a stable failed review state instead of repeatedly re-enqueuing it for merge.

  The merge-confirmed fast path also now re-checks task ownership and skips
  finalization if the task has already left `in-review`.

- f6a1862: Add agent provisioning policy plumbing for `fn_agent_create`/`fn_agent_delete`, including
  `agent_provisioning` approval categorization and action-gate classification updates to avoid
  double-approval collisions.
- 4d2f029: Add age-based escalation for high fan-out blockers in the dashboard. High fan-out visibility still appears immediately, and blockers are now explicitly escalated only after they stay in blocking columns past the configurable stale threshold.
- a0c7c33: Expose and honor `override` on `fn_delegate_task` so intentional non-executor delegations work end-to-end for durable agents while preserving default executor-role safeguards.
- be404e5: Harden durable-agent heartbeat timer self-healing by adding scheduler-owned timer registration reconciliation and aligning dashboard dev-mode startup timer eligibility with runtime behavior.
- 858bab2: Consolidate Even Realities plugin support into `fusion-plugin-even-realities-glasses` and remove `fusion-plugin-even-cards` from the active workspace package list to avoid duplicate user-facing integrations.
- c02aade: Reclassify `fn_task_import_github` and `fn_task_import_github_issue` into action-gate task mutation tooling, while keeping permanent-agent classification aligned with task-creation coordination behavior.
- 5640316: Add dashboard support for task lineage commit associations by introducing `GET /api/tasks/:id/commit-associations`, wiring a dedicated client helper, and surfacing confidence-labeled lineage rows in the Task Changes tab.
- 5c3a1df: Memoize startup slim `listTasks` reads across dashboard/engine boot paths to reduce duplicate task-list SQL and JSON parsing work without introducing long-lived stale cache behavior.
- c501e00: Deduplicate background SQLite integrity checks per database path so multi-project dashboard startup no longer stacks repeated `PRAGMA integrity_check(100)` runs against the same `fusion.db`. Health state fanout is preserved for all participating database instances (`integrityCheckPending`, `integrityCheckLastRunAt`, `corruptionDetected`).
- a8b904c: Harden per-worktree DB hydration so missing `.fusion/` scratch state is bootstrapped and retried before degrading with `unable to open database file`.
- 03b8bdb: Add CLI Printing Press to the built-in plugin catalog in Settings so users can discover and install the bundled plugin directly from Plugin Manager.
- 12ae8f7: Improve local dashboard startup by replacing the default full workspace prebuild with a dashboard-client prebuild, adding explicit prebuild modes, and making update notices clearer for source checkouts.
- c303187: Reconcile pull-request merge tasks when GitHub reports the PR merged after a merge command failure.
- 2963923: Add one-click bundled plugin install support for Reports in Settings → Plugins.
- 4205309: Keep stuck task detection active by default with an explicit task-stuck timeout default, without coupling it to workflow step timeout settings.
- 4404c61: Unify local task creation on the distributed task-ID allocator lifecycle and remove runtime reliance on `config.nextId` as an allocation counter. Local allocator state now self-heals on startup by reconciling to existing task IDs for each prefix.

## 0.26.0

### Minor Changes

- 8c71516: Show downstream blocker fan-out count on the board so high-impact blockers are visible at a glance.

### Patch Changes

- 6240afe: Fix merger autostash lifecycle cleanup to drop primary and race-rescue stashes on terminal paths, and add startup/periodic stale autostash sweeping with a configurable max-age threshold.
- 7e8541b: Add stash recovery APIs and dashboard surface for listing, diffing, applying, and safely dropping orphaned merger autostashes.
- 6cab8f9: Create a tracking GitHub issue when a Fusion task is created with GitHub tracking enabled. Default is OFF; no GitHub calls are made when tracking is disabled.
- 56c232a: GitHub tracking issues now use the format `[FN-XXXX] Title` for the title and a short plaintext summary prefixed with `Fusion task: FN-XXXX` for the body. The full task prompt is never included and no hyperlink back to Fusion is added.
- ebab75e: Fusion now posts a short comment on the linked GitHub tracking issue when a tracked task moves to in-progress or done. Comments include the Fusion task ID as plain text and never link back to the Fusion app.
- 4450257: Fusion now closes the linked GitHub tracking issue when a tracked task moves to done, and reopens it when the task moves back to an active column. Done → archived leaves the issue closed. Failures are recorded in the task activity log and never block the move.
- 8e9cd1a: Expose per-task GitHub tracking controls in task creation/editing and task detail, including repo override handling, linked-issue display, and manual unlink flow.
- 860d183: GitHub tracking lifecycle now strictly honors the project-level `githubAuthMode`. Token mode requires `githubAuthToken` (or `GITHUB_TOKEN`); gh-cli mode requires an authenticated `gh` CLI. The previous opportunistic fallback no longer applies to tracking issue creation/comments/state sync flows (legacy PR/import flows are unchanged).
- d74197e: Generalize the SQLite schema self-heal pass to reconcile missing columns for every critical table on `Database.init()`, not just `tasks`.

  This prevents legacy or drifted databases from hitting `no such column: <X>` regressions after new column additions, and adds architecture lint coverage to ensure new `CREATE TABLE` definitions are always included in schema-compatibility coverage.

- 4051dab: Merger sessions now honor the assigned agent's `runtimeConfig.model` before falling back to project/global defaults, matching executor and planning lanes.
- d25e8cb: Research now works out of the box using the agent's built-in `WebSearch`/`WebFetch` tools. External search providers (SearXNG, Brave, Google, Tavily) are now optional advanced configuration.
- bcb79d8: Honor task-configured merge targets across CLI and merge completion paths, including PR creation base branch selection and merge metadata resolution.
- 50fdea6: Fix `fn_task_update` (and `fn_task_create`) silently failing with "Agent not found" when callers pass an empty string or the literal string `"null"` to clear a task's agent assignment. Empty/whitespace strings and `"null"` are now normalized to a clear-assignment signal, matching the dashboard `PATCH /api/tasks/:id` contract. JSON `null` continues to work as before.
- 46efd00: Add per-task GitHub tracking fields (enabled flag, optional repo override,
  linked issue metadata) to the Task contract and SQLite store. No user-visible
  behavior yet; surfaced by FN-3870+.
- 00b35b8: Restore ListView bulk-delete: select multiple tasks and delete them together, with archived selections skipped automatically and a per-task force-delete prompt for dependency conflicts.
- ff9fb55: Improve stale dependency unblocking so todo tasks are released promptly when their blocker reaches done or archived, and ensure startup recovery runs the stale `blockedBy` sweep once on boot to repair previously stuck rows. This complements the existing periodic self-heal pass, reducing unblock latency and automatically repairing incidents like dependents remaining blocked after a completed task.
- eea4def: Fix agent sidebar action buttons (Run Now, Pause, Details) overflowing on narrow agent cards by collapsing them to icon-only controls in the sidebar context.
- da101ef: Fix bundled Dependency Graph plugin reliability in the dashboard. Built-in plugin view registration now uses literal-specifier lazy imports so production bundles can resolve and load the bundled graph/roadmap dashboard views instead of falling back to an unavailable placeholder. Plugin install mode now resolves bundled plugin paths server-side when relative `./plugins/...` inputs do not exist under the current working directory, so installing built-in plugins from Settings works reliably across runtime locations.
- 4ccef83: Fix triage planning model selection so project/task planning settings are passed to runtime using the correct default model keys.
- 772c9f6: Hide Chat Rooms behind the `chatRooms` experimental flag. By default, Chat now shows direct-chat-only UI; re-enable rooms via **Settings → Experimental Features → Chat Rooms**.
- f1ece4b: Bundle and auto-install the cli-printing-press plugin with the published CLI.
- 5b15f45: Fix scheduler `blockedBy` propagation so dependency-unblocked todo tasks are not re-pointed to unrelated overlap blockers, and extend stale-blocker recovery to clear corrupted `blockedBy` rows that no longer match unresolved dependencies.

## 0.25.0

### Minor Changes

- 15e4336: Add scheduled memory backup feature: project memory (.fusion/memory) and per-agent memory (.fusion/agent-memory) are now snapshotted on a configurable cron schedule with retention pruning. New `fn memory-backup` CLI command and Settings → Backups UI controls.

### Patch Changes

- 3e64668: Auto-recover stuck merge deadlocks where task content is already on main.
- 76e6eed: Stop overwriting canonical merge commit SHAs on already-done tasks during self-healing reconciliation. Confirmed `mergeDetails.commitSha` is now preserved as authoritative; rediscovery for unconfirmed done tasks prefers the earliest owned commit so the original merge commit wins over later follow-up commits sharing the same `Fusion-Task-Id` trailer.
- 76e6eed: Add global and project settings for GitHub issue tracking: global default tracking repo, project-level default tracking repo, per-project tracking toggle for new tasks, GitHub auth mode (`gh-cli` | `token`), and optional stored personal access token. This is foundational settings work for FN-3868 → FN-3876; behavior wiring ships in downstream subtasks.
- 76e6eed: Triage: progressively compact large optional sections (subtask guidance, attachments, existing spec, user comments) of the spec prompt when the model's context window overflows, in addition to the existing project-memory compaction. Fixes failures on small-context models such as local vLLM Qwen3-30B (issue Runfusion/Fusion#62, FN-3877).
- 76e6eed: Add a compatibility self-heal for legacy task databases that report `schemaVersion >= 20` but are missing checkout lease columns (`checkedOutBy`, `checkedOutAt`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkoutLeaseEpoch`).

  On initialization, missing lease columns are now added idempotently before version-guarded migrations, matching the earlier `nodeId` mitigation pattern and preventing `no such column: checkoutNodeId` crashes in task listing paths.

- 0b69b99: Fix Dependency Graph plugin failing to enable from Settings by correcting package exports/build output and ensuring bundled CLI staging includes compiled plugin dist assets. Also surface the loader's actual enable error in Plugin Manager toast messaging when enable returns `state: "error"`.
- f9cba25: Use agent names (with ID fallback) in agent message notifications and mailbox labels across ntfy/webhook outputs and dashboard mailbox views.
- 47504ea: Fix dependency-graph plugin failing to load under real Node ESM resolution by switching to Node16 module resolution semantics and ensuring emitted relative imports include `.js` extensions. Aliased `@fusion-plugin-examples/dependency-graph` (and its `/dashboard-view` subpath) in the dashboard's vite and vitest configs so the dashboard resolves the plugin from `src/` instead of a potentially stale `dist/`, preventing "Bundled plugin view unavailable" regressions when plugin source changes without a rebuild. Added regression tests for built-entrypoint Node-ESM safety and dashboard alias wiring.
- 89acfd0: Fix agent-company imports from companies.sh monorepos by honoring the catalog subdirectory path (for example `paperclipai/companies/gstack`) instead of parsing the alphabetically first sibling package.
- 71bf70f: Wire the checkout-lease column self-heal as an unconditional startup compatibility backfill (`ensureTasksSchemaCompatibility`) so legacy or mesh-synced task databases no longer fail with `no such column: checkoutNodeId` when schemaVersion is already past migration 20.
- d942c0c: Fix in-review tasks getting stranded after pre-merge workflow completes. Two regressions piled up:

  1. The `task:moved → in-review` immediate-handoff path silently no-op'd whenever `internalEnqueueMerge` short-circuited on a leaked `mergeActive` entry — and every skip reason ("paused", "blocker", "autoMerge off", "engine paused") returned without logging, so the silence was opaque. Each branch now logs at info or warn level, the handler clears its own stale `mergeActive` entry before enqueueing, and the catch block's message identifies the task instead of pretending the failure was always a settings read.
  2. The 15s `scheduleMergeRetry` sweep ran `enqueueEligibleInReviewTasks` → `internalEnqueueMerge` blindly, so a leaked `mergeActive` entry from a wedged prior attempt would skip the same task on every poll forever. Tasks were only rescued by the 15-min maintenance recovery loop ("Auto-recovered: eligible in-review task re-enqueued for merge"). Added `reconcileStaleMergeActive()` which drops `mergeActive` entries that aren't queued and aren't the active merge target, and call it before each 15s sweep. `internalEnqueueMerge` also now warns when a leaked entry causes a skip, so the next regression is visible.

- 271166a: Change the default `verificationFixRetries` setting from 3 to 2 for new projects and fallback behavior when unset.
- 76e6eed: Add a multi-agent report review panel flow to the bundled reports plugin, including parallel reviewer orchestration, structured feedback parsing with retry, deterministic aggregation, and documented timeout/failure semantics.
- 235ba11: Add a SQLite-backed reports archive store for the bundled reports plugin, including schema initialization, status lifecycle transitions, review attachment persistence, and typed list/filter APIs with events.
- 76e6eed: Scheduler: exclude paused in-review tasks from `activeScopes`. Paused failed-merge tasks no longer block dispatch of overlapping todo tasks via `blockedBy` re-stamping. (FN-3867)
- 76e6eed: Add `recoverAlreadyMergedReviewTasks()` self-healing sweep to recover phantom-merge-guard false positives. Detects tasks whose content already landed on the integration branch (via Fusion-Task-Id trailer, branch ancestry, or git patch-id walk) and reconciles them to `done` with proper merge metadata.
- 76e6eed: Restore canonical mergeDetails.commitSha for tasks FN-3794, FN-3814, FN-3829 whose attribution had been overwritten by self-healing reconciliation prior to the FN-3862 fix. Adds an idempotent restoration script (`scripts/restore-merge-sha-fn-3878.mjs`) for operators to re-verify or repair similar drift.
- 76e6eed: Wire chat rooms UI to backend. Creating a room now persists via /api/chat/rooms, the sidebar lists real rooms, room threads load history and stream new messages over chat:room:\* SSE events, and the FN-3807 "Coming soon" placeholder is gone.
- f182aa3: Mailbox view now has a draggable resize handle between the list and detail panes (desktop only), with keyboard support and per-project persisted width.
- 2864f70: Backfill global ntfy default events to include `message:agent-to-user` and `message:agent-to-agent` so mailbox notifications are enabled by default for new settings files.
- e0d9671: Move agent Run Now control into the agent detail header next to lifecycle buttons.
- 271166a: Fix chat rooms: pressing Enter in a room now posts to the room (previously routed to a 1-on-1 session), and rooms can now be deleted from the rooms sidebar with confirmation.
- 985d51c: Tighten merger scope-warning diff base for legacy/imported tasks lacking `baseBranch`. `resolveTaskDiffBaseRef` now mirrors the dashboard's display-recovery path: when `baseBranch` is missing, it computes `merge-base(HEAD, main)` and prefers it over a stale `baseCommitSha` only when the merge-base strictly descends the recorded SHA. Previously these tasks compared against the original fork point, so a pre-merge rebase pulled every unrelated commit landed on main into the diff and produced bogus "N files changed outside declared File Scope" warnings (e.g., FN-3898 saw 17 ghost files for a 3-file change). The FN-2855 deleted-feature-branch path is preserved.
- 00c580d: Disable Corepack's interactive download prompt when spawning verification commands so non-TTY children no longer hang until the hard timeout when a repo pins `packageManager` to a version Corepack hasn't cached yet.

## 0.24.0

### Minor Changes

- 0da7aa8: Newly created non-ephemeral agents now start in `state: "active"` so they immediately participate in heartbeat scheduling without requiring a manual Start action. Ephemeral/task-worker agents still start in `state: "idle"` and are activated by the engine when work is assigned. Existing agents are unaffected; operators who want a paused-from-birth durable agent can call `fn_agent_stop` (or click Stop in the dashboard) right after creation.

  Audit note: heartbeat scheduler state handling and dashboard create-response consumption were reviewed and required no downstream code changes.

- a76f06b: Fusion now includes a plugin-first Dependency Graph top-level dashboard view that lets teams explore active task relationships visually, with host support for plugin-registered dashboard destinations and bundled graph rendering for dependency-aware planning.

  - Adds a new Graph destination in dashboard navigation (including desktop overflow/mobile surfaces) via plugin dashboard view registration.
  - Visualizes task dependencies as connected task cards with directed edges, including in-progress and in-review work while excluding done/archived tasks.
  - Adds interactive graph controls including pan, zoom, fit-to-screen, and manual node dragging for layout refinement.
  - Highlights upstream/downstream dependency chains on hover/selection and opens task details from graph cards for quick drill-in.
  - Persists per-project custom node positions using plugin-managed project-scoped storage.
  - Introduces and documents the host contract for plugin-provided top-level `dashboardViews` (`PluginDashboardViewDefinition` + loader aggregation + registry-host rendering).

- 9e6574c: Add a dedicated Task Review tab that surfaces pull-request and direct reviewer feedback with selectable items, manual refresh, and same-task AI revision flow so teams can address review comments without creating a separate refinement task.
- dca0789: Add Cursor CLI runtime plugin as a bundled installable provider, including staged plugin artifacts in the published CLI bundle and install-path resolution support.
- dcea611: WhatsApp Chat plugin now connects via the WhatsApp Web multi-device protocol (Baileys) with QR / pairing-code setup instead of Meta Cloud API webhooks. Removes the verifyToken / appSecret / accessToken / phoneNumberId / graphApiVersion settings and webhook routes; adds /status, /qr, /pair-code, and /logout plugin routes. Existing installs must re-pair after upgrade.
- 4c204c9: Enable Fusion tool-control support for the OpenClaw runtime plugin. OpenClaw sessions now derive custom tools from runtime session options, filter out built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`), configure an MCP server via supported `openclaw mcp set` profile-based CLI flow, and pass that profile into `openclaw agent` calls while preserving default embedded `--local` behavior.
- a6ec5b9: Add a new global experimental feature flag, `experimentalFeatures.evalsView`, and default it to off for Evals surfaces. When disabled, the dashboard Evals view, Settings → Scheduled Evals section, header/mobile Evals navigation entries, and in-process scheduled-eval cron execution are hidden or short-circuited. Projects already using `evalSettings.enabled` must also enable `evalsView` to expose and run scheduled eval workflows.
- 1546eaf: Add support for the standalone Even Realities glasses plugin, including on-device task cards, quick capture, polling notifications, and agent actions for local/self-hosted Fusion deployments. This expands user-facing plugin capabilities in the published CLI/runtime stack.
- e04af96: Add native `fn_web_fetch` tool for lightweight URL fetching from agent/chat sessions, with SSRF guard, timeout, and size caps. Use the `agent-browser` skill for JS-rendered pages.
- 8051bea: Add chat room storage: ChatRoom, ChatRoomMember, ChatRoomMessage entities, migration 70, and ChatStore room CRUD APIs.
- 8051bea: Add room-aware chat HTTP API and SSE events: /api/chat/rooms CRUD, member management, persist-only POST /chat/rooms/:id/messages, and chat:room:\* event fan-out on the dashboard SSE stream. AI responder selection, mention routing, and UI land in subsequent tasks.
- 3a91534: Add `fn_agent_create` and `fn_agent_delete` tools for provisioning and decommissioning non-ephemeral agents, including direct-report authorization checks and task-checkout safety handling on delete.
- 6c77915: Render mailbox message bodies as GitHub-flavored markdown. Headings, lists, bold/italic, links, inline code, fenced code blocks, and tables now display formatted in both the Mailbox view and Mailbox modal. Plain-text messages render unchanged. Raw HTML is not executed.
- 5299745: Add optional plugin AI security scan controls across install/rescan workflows.

  - `fn plugin install <path-or-package> --ai-scan` to opt into scan-on-load
  - `fn plugin rescan <id>` to run a fresh scan/reload and surface verdict details
  - Dashboard/API plugin management now supports toggling `aiScanOnLoad` and explicit rescans with persisted scan results

### Patch Changes

- b41cb84: Remove roadmap ownership from `@fusion/core` by deleting remaining roadmap type exports and keeping roadmap contracts in the roadmap plugin package (`@fusion-plugin-examples/roadmap`).
- f8a0903: Enforce executor-role assignment policy for implementation task delegation paths in the CLI and add an `override` escape hatch for intentional non-executor delegation.
- a732ebb: Stabilize CLI bundle-output test for the fusion-plugin-openclaw-runtime
  `mcp-schema-server.cjs` bridge asset on clean checkouts and fail loudly
  in tsup if the source asset is missing.
- c1ba48f: Fix agent memory lookup: the system prompt's "## Agent Memory" section and the
  heartbeat Identity Snapshot now read from the on-disk agent-memory workspace
  (`.fusion/agent-memory/{agentId}/MEMORY.md`) when the inline `agent.memory`
  field is empty, matching the documented contract.
- 9743dab: Stage `fusion-plugin-droid-runtime` (including its `mcp-schema-server.cjs`
  bridge asset) into the published CLI tarball, mirroring the
  `fusion-plugin-openclaw-runtime` build pipeline. The droid runtime plugin
  is now bundled and asserted by the bundle-output test suite.
- c93f61b: Expand mailbox reply-context rows so users can inline-expand and traverse prior replied-to messages.
- 83be577: Add a split Pull action in the Git Manager Remotes panel with a dropdown option to run `Pull --rebase`.
- d90d665: Fix: dependency graph plugin failed to load because its plugin entry imported React/dashboard modules. Split the plugin into a server-pure metadata entry and a separate `./dashboard-view` subpath so the bundled-install loader can register it without crashing.
- 955902d: Fix mobile mailbox reply: anchor MailboxView/MailboxModal to the visual viewport so the message composer stays visible when the on-screen keyboard appears.
- ceb113c: Fix mailbox composer Send button hanging when "Wake agent immediately" is checked. The /api/messages route now dispatches the wake heartbeat asynchronously so the UI returns immediately after the message is stored.
- fc34a84: Unify engine gating exemption lists into a shared source of truth.
- d633981: Fix merger autostash orphan cleanup to automatically drop closed-task stashes whose content is already fully subsumed by HEAD.
- d487eea: Fix executor step-index reconciliation so `fn_task_update` and `fn_review_step` share 0-indexed in-memory verdict/checkpoint keys. This restores correct REVISE blocking for `status="done"` and allows RETHINK rewinds to find the matching step checkpoint.
- 9c86771: Fix first chat message send hanging on "Connecting…" — the initial SSE stream now completes reliably on cold-start.
- 111ad7a: Tasks no longer strand in In Review when an in-merge verification fix only rebuilds gitignored artifacts. The merger now restores squash state and commits the original branch content when no commit exists yet, while still refusing real phantom merges with no task content.
- 18413a1: Fix /tasks/:id deep links: theme stylesheet now resolves root-absolute on sub-paths and /tasks/:id redirects/rewrites to the canonical ?task= form so the task modal opens.
- 12bad74: Add ntfy and webhook notifications for mailbox messages (agent→user and agent→agent), with deep links into the matching task or mailbox message.
- de17449: Add `TaskStore.listTasksModifiedSince` and wire `createPluginRouter` into the dashboard API so plugin-defined routes mount under `/api/plugins/{id}/...`.
- 1abbb10: Fix merge-queue auto-recovery loops caused by stale `status: "merging"` / `"merging-pr"` task states. Self-healing now clears stale transient merge statuses only when no active merger owns the task and the state is older than a safety threshold, and mergeable-review recovery now skips transient merge statuses to avoid noisy re-enqueue spam while the cross-process active-merge guard is blocked.
- 36b21af: Fix auto-merge failing when task content is already on `main` under a different commit SHA. The phantom-merge guard in `commitOrAmendMergeWithFixes` previously failed any merge where `git merge --squash` produced no diff, even when the work had legitimately landed on `main` (e.g., after an in-merge fix or rebased branch). The finalize logic now treats already-merged branches as success via a defense-in-depth chain: trailer-on-HEAD short-circuit, then merge-base ancestor short-circuit, then a hardened squash-restore fallback that detects `already up to date` reports. High-resolution diagnostics are emitted on the phantom-guard branch for any future regressions.
- ac0606d: Stop overwriting canonical merge commit SHAs on already-done tasks during self-healing reconciliation. Confirmed `mergeDetails.commitSha` is now preserved as authoritative; rediscovery for unconfirmed done tasks prefers the earliest owned commit so the original merge commit wins over later follow-up commits sharing the same `Fusion-Task-Id` trailer.
- 4b6a149: Add global and project settings for GitHub issue tracking: global default tracking repo, project-level default tracking repo, per-project tracking toggle for new tasks, GitHub auth mode (`gh-cli` | `token`), and optional stored personal access token. This is foundational settings work for FN-3868 → FN-3876; behavior wiring ships in downstream subtasks.
- 37913bc: Triage: progressively compact large optional sections (subtask guidance, attachments, existing spec, user comments) of the spec prompt when the model's context window overflows, in addition to the existing project-memory compaction. Fixes failures on small-context models such as local vLLM Qwen3-30B (issue Runfusion/Fusion#62, FN-3877).
- e7acd27: Add a compatibility self-heal for legacy task databases that report `schemaVersion >= 20` but are missing checkout lease columns (`checkedOutBy`, `checkedOutAt`, `checkoutNodeId`, `checkoutRunId`, `checkoutLeaseRenewedAt`, `checkoutLeaseEpoch`).

  On initialization, missing lease columns are now added idempotently before version-guarded migrations, matching the earlier `nodeId` mitigation pattern and preventing `no such column: checkoutNodeId` crashes in task listing paths.

- 9cc98fd: Fix task ID counter resetting to `001` on first mesh-routed task creation.

  When the dashboard's task-create route was migrated to the distributed task ID allocator, projects whose tasks had been allocated through the legacy counter (e.g. `FN-3700`) saw new tasks restart at `FN-001`, colliding with historical IDs. The allocator now seeds its sequence past any existing task for the prefix (live or archived) and past the legacy counter, so new task IDs always continue forward.

  Internal: extracted a slim type-only module for plugin dashboard view contracts so external plugin builds no longer pull in dashboard runtime sources, and dropped unused scaffolding tables (added by a previous schema migration) via an idempotent migration.

- 82fe24e: Bootstrap `@fusion/dashboard` dist before running tests so `@fusion/desktop` (which dynamically imports `@fusion/dashboard`) does not fail with "Failed to resolve entry for package @fusion/dashboard" in clean checkouts and merger verification environments.
- d90d665: Fix: dashboard board silently dropped tasks when an SSE `task:created` event was missed (e.g., during reconnect or sleep/wake). The `task:moved`, `task:updated`, and `task:merged` handlers in `useTasks` used `prev.map(...)` and skipped tasks not already in local state, so subsequent updates were no-ops. Handlers now upsert, matching `task:created`, so out-of-order or post-reconnect events make the task visible instead of dropping it.
- 97e039b: Fix tasks getting stuck in In Review with "verification fix succeeded but no merge commit could be created" even when the merge commit had already landed on main.

  Root cause: when attempt 1 of the merge hit a verification failure (test command failed) under default smart conflict resolution, the catch in `executeMergeAttempt` swallowed the error and returned `false`, triggering a redundant attempt 2. Attempt 2 captured a stale `preAttemptHeadSha` (the AI commit from attempt 1), found the branch already merged, ran the in-merge fix, and the finalizer's phantom-merge guard then saw `!hasStaged && !headMoved` against the wrong baseline — even though the task's content was already on HEAD.

  - `executeMergeAttempt` now propagates `VerificationError` directly so the in-merge fix runs once on attempt 1 with the correct baseline. Auto-conflict-resolution can't fix a verification failure, so retrying with attempt 2 was always wrong for this error.
  - `commitOrAmendMergeWithFixes` adds a defense-in-depth check: if HEAD already carries the task's `Fusion-Task-Id` trailer, treat the no-progress finalize as success rather than tripping the phantom-merge guard. The trailer match is anchored to line boundaries so unrelated task IDs in the body can't false-positive.

- d0b7506: Guard PR creation retries against missing task branches and park no-delta branches with an actionable task error.
- 68eff44: Stop the dashboard's SPA catch-all from serving `index.html` for missing asset URLs. Stale `/assets/*.js` requests after a rebuild now get a real 404, so the browser surfaces a chunk-load error (which versionCheck recovers from) instead of poisoning the page with a `text/html` module script and reloading into a blank shell.
- a9edca6: Fix dashboard step progress not advancing during task execution. Two bugs: (1) `fn_task_update` regressed in commit 491097cd6 (FN-3026) to a 1-indexed `step - 1` even though its parameter description and `fn_review_step` both use 0-indexed step numbers, so updates landed on the wrong step and `codeReviewVerdicts`/`stepCheckpoints` keys mismatched between the two tools. (2) Some agent runtimes (notably permanent-agent CEO sessions on the openai-codex transport) skip the bookkeeping `fn_task_update` call entirely, leaving the board stuck at `currentStep: 0`. `fn_review_step` now flips the step to `in-progress` on entry and to `done` on code-review `APPROVE`, so progress reflects real work without depending on the agent's follow-up call.
- 7a11a32: Fix dashboard rendering blank on first load by skipping the service worker `controllerchange` reload on initial install — the page only reloads now when an existing controller is genuinely being replaced.
- 1a0124c: Normalize dependency graph dashboard navigation so Graph resolves through a canonical `graph` task view destination and appears only in secondary navigation surfaces (desktop Header overflow and mobile More sheet). Also add TaskCard embedding support via `disableDrag` for plugin-hosted graph nodes.
- a466416: Implement dependency graph rendering with layered auto-layout, directed SVG edges, task filtering, and pan/zoom + fit-to-screen controls in the bundled dependency graph plugin.
- 21b7d41: Wire the bundled dependency graph dashboard view to host context so graph cards open the native task detail modal, and document the plugin dashboard view context contract/entrypoint alignment.
- 514e5f3: Fix dependency-graph task card activation so primary non-drag clicks open task details exactly once through the dashboard host callback, while preserving drag suppression and graph highlighting behavior.
- d20d45e: Remove the dashboard-owned `RoadmapsView`, `useRoadmaps` hook, and related CSS/tests from `@fusion/dashboard`. Roadmap planning now routes exclusively through the bundled `roadmap-planner` plugin dashboard view (`plugin:roadmap-planner:roadmaps`).
- 9d1c05a: Remove dashboard-owned roadmap backend routing and legacy `/api/roadmaps` integration so roadmap APIs are plugin-owned under `/api/plugins/roadmap-planner/...`.
- b7f68d7: Plugin management now separates global installation from project activation: installs/uninstalls are global, while enable/disable and runtime state remain project-scoped. Updated dashboard plugin lifecycle SSE payloads and Plugin Manager/CLI copy to make global vs project scope explicit.
- 12d3f0d: Treat task working branch (`branch`) and merge-target base branch (`baseBranch`) as distinct user-controlled fields across task create/edit flows, board display and filtering (including no-branch filters), and merge behavior that defaults the target branch to `main` when `baseBranch` is unset.
- ea34afa: Resolve project runtime working directories from per-node project path mappings for the routed/current node instead of falling back to `RegisteredProject.path`, and fail with clear errors when the exact mapping is missing.
- 92ca3a2: Pause permanent-agent execution when approval is required, add approve/deny API endpoints, and resume task/agent state correctly after decisions with deduped approval request handling.
- 66c66ec: Improve agent messaging responsiveness by ensuring heartbeat mailbox context is consistently processed and adding a one-off `wakeImmediately` send option in dashboard messaging. This also clarifies agent `messageResponseMode` behavior in settings and docs.
- f894bdc: Fix dashboard agent chat sessions so plugin runtimes (including Hermes) receive Fusion mailbox tools when a message store is available, enabling real `fn_send_message`/`fn_read_messages` usage with correct agent-to-dashboard recipient routing semantics.
- 66fa56b: Gate `fn_research_*` tool availability behind `experimentalFeatures.researchView` so CLI and agent sessions consistently return feature-disabled responses when Research is not experimentally enabled.
- c38b7cd: Gate research tool exposure in planning and execution sessions behind `experimentalFeatures.researchView`, including conditional prompt guidance so agents only see `fn_research_*` references when those tools are actually registered.
- a087aa4: Sync mesh auth credentials using explicit checksummed auth snapshots across node sync and mesh shared-state channels, including secure apply/export handling for API-key and OAuth provider credentials.
- bbfa5f7: Fix narrow main-screen TUI mouse behavior so selecting **Logs** enables wheel scrolling and selecting **System** switches back to native text selection mode.
- 9b19199: Align dependency-graph position persistence with the shared dashboard project storage helper and canonical key (`fusion-plugin-dependency-graph:positions`), and remove the plugin-local duplicated scoped storage helper.
- 81da75f: Enable planning-mode and research synthesis agent sessions to opt into runtime builtin `WebSearch` and `WebFetch` tools when supported, while keeping readonly defaults unchanged for other sessions.
- 8bbb734: Add a first-party WhatsApp chat plugin that can be installed from built-in plugin surfaces and staged in CLI bundles.
- 5514d3e: Agent Detail Mail tab: clicking a message now loads its full content and marks unread inbox messages as read.
- 2b8cbd1: Fix `fn plugin install` / `fn plugin add` path registration so local directory installs persist an absolute JavaScript entry file path instead of the source directory. This resolves plugin load failures on restart when loaders require a concrete JS module file.
- 45fe41c: Fix plugin installation persistence so user-installed plugins are always recorded in the shared central `plugin_installs` registry (with per-project state in `project_plugin_states`) instead of project-local legacy plugin rows. This ensures installs are visible across projects and processes as intended.
- 966368c: Fix plugin list enable/disable toggle rendering so the native checkbox is visually hidden and the custom slider reflects checked and focus-visible states.
- 9f57207: Exempt internal Fusion coordination tools (heartbeat-done, task/document/memory writes used for coordination, delegation, identity, reflection) from the permanent-agent action gate so heartbeats cannot deadlock under restrictive permission policies. Mirrors the existing action-gate exemption set onto the sibling permanent-agent gating path.
- ae7a607: Exempt internal Fusion runtime coordination tools from permanent-agent action-gate policy enforcement so heartbeat completion and engine coordination calls cannot deadlock behind approval/block rules.
- 5e94151: Define `--accent-text` across dashboard themes so content rendered on `--accent` has readable contrast. This fixes low-contrast user chat message bubbles and send-button icon color in ChatView, especially on the default and one-dark themes.
- f3164b7: Add a runtime action-gate exempt-tools reload API so operators can refresh exemptions without restarting the engine process.
- ad34cb6: Fix permanent-agent tool gating so `fn_heartbeat_done`, `fn_send_message`, and `fn_read_messages` are treated as readonly/exempt and no longer require approval under permission-policy gating.
- 6f0e167: Fix dashboard chat surfaces so ChatView and Quick Chat snap to the latest message when opened or when switching sessions, while preserving scroll-up reading state during streaming/history loads.
- 1148d29: Add scaffold for new bundled Reports plugin (manifest + settings schema, no runtime behavior yet).
- 003e51a: Add a multi-agent report review panel flow to the bundled reports plugin, including parallel reviewer orchestration, structured feedback parsing with retry, deterministic aggregation, and documented timeout/failure semantics.
- 7d20a34: Fix a multi-project collision in the bundled WhatsApp plugin by keying connections with `getRootDir() + "::" + pluginId`, so concurrent projects no longer share a single connection state.

  Update the plugin SDK hook type so `onUnload` now receives `PluginContext` (matching `onLoad`). This is backward-compatible at runtime, but plugin authors may need to update TypeScript signatures.

- de070db: Add a `dedupeRetentionDays` setting to the WhatsApp chat plugin (default 7 days) and prune old `whatsapp_chat_dedupe` rows on each inbound message to prevent unbounded dedupe-table growth.
- 12bad74: Add a mobile-first chat session switcher in the ChatView thread header so users can open the title menu and switch conversations (or start a new chat) without returning to the sidebar.
- 5bfe126: Make `fn_web_fetch` universally available to all agent roles (reviewer, merger, triage now included).
- b326385: Fix missing ntfy notifications for new mailbox messages and add a "Test message notification" button in Settings → Notifications that exercises the full dispatch pipeline.
- 94a6fe4: Document the Chat view session switcher and the `/tasks/<id>` deep-link in the dashboard guide.
- a2258b8: Main chat no longer surfaces a confusing "Load failed" error banner when the
  browser tab is backgrounded during a streaming reply. Tab-suspension network
  errors are now treated as benign interruptions and the conversation silently
  reconciles with the server on tab return.
- df6956c: Reattach to in-flight chat stream after reload so streaming responses keep rendering instead of disappearing.
- 374d7f7: Dashboard agent chats no longer also send a mailbox message by default; agents only mail the user when explicitly asked.
- 0a2f3d6: Fix low-contrast Markdown/Tools/fullscreen toggle buttons in the agent log header by replacing the undefined `--text-on-accent` CSS variable with the canonical `--accent-text` token. Also fixes the same typo in DocumentsView.
- 2a7a0b0: Remove a useless try/catch wrapper in the engine's `execute-once-then-complete` approval gate. Internal cleanup; no behavior change. Eliminates the workspace's last ESLint `no-useless-catch` warning.
- c4e0c1d: Permanent-agent heartbeats can no longer be deadlocked by an approval policy interposing on `fn_heartbeat_done`. The terminal heartbeat-completion tool now bypasses both the action gate and the permanent-agent gate by reference, so even a misconfigured policy or classification-table regression cannot strand a heartbeat run. No user-visible behavior change for correctly classified deployments.
- 90e9dde: Agent messaging via `fn_send_message` can no longer be deadlocked by an approval policy interposing on it. The messaging primitive now bypasses both the action gate and the permanent-agent gate by reference, so even a misconfigured policy or classification-table regression cannot strand inter-agent coordination, wake-on-message replies, or agent-to-user escalations. No user-visible behavior change for correctly classified deployments.
- d2d1aad: SelfHealingManager now includes a `clearStaleBlockedBy()` recovery sweep that clears `blockedBy` (and transient `status`) on todo tasks when their blocker is missing, done, archived, paused in-review, or failed in-review with merge retries exhausted. This lets the scheduler re-evaluate those tasks cleanly on subsequent ticks instead of leaving them permanently queued behind stale blockers.
- f75488d: Scheduler: exclude paused in-review tasks from `activeScopes`. Paused failed-merge tasks no longer block dispatch of overlapping todo tasks via `blockedBy` re-stamping. (FN-3867)
- 6a92d62: Add `recoverAlreadyMergedReviewTasks()` self-healing sweep to recover phantom-merge-guard false positives. Detects tasks whose content already landed on the integration branch (via Fusion-Task-Id trailer, branch ancestry, or git patch-id walk) and reconciles them to `done` with proper merge metadata.
- b47f6ff: Restore canonical mergeDetails.commitSha for tasks FN-3794, FN-3814, FN-3829 whose attribution had been overwritten by self-healing reconciliation prior to the FN-3862 fix. Adds an idempotent restoration script (`scripts/restore-merge-sha-fn-3878.mjs`) for operators to re-verify or repair similar drift.
- e7acd27: Wire chat rooms UI to backend. Creating a room now persists via /api/chat/rooms, the sidebar lists real rooms, room threads load history and stream new messages over chat:room:\* SSE events, and the FN-3807 "Coming soon" placeholder is gone.
- 1e80059: Fix chat thread bottom anchoring when reopening sessions.

  Quick Chat and Chat now scroll to the latest message every time they are reopened, even when markdown/images/tool details render after the initial paint.

- f496716: Fire pi `session_shutdown` extension events when Fusion-spawned `AgentSession` instances are disposed, so extensions registered with `pi.on("session_shutdown", …)` run cleanup handlers (including Fusion's dashboard child-process cleanup).

## 0.23.0

### Minor Changes

- 35d5590: Add host support for plugin-registered top-level dashboard views and ship a plugin-first dependency graph view with interactive navigation and project-scoped layout persistence.
- 2b7b922: Add native-shell remote connection management across desktop/mobile, including saved server profiles, optional auth token support, and shell-owned connection switching APIs used by dashboard onboarding/connection UI.
- 8f812e2: Add plugin-managed binary installation/setup lifecycle. Plugins can now declare
  setup hooks (check, install, uninstall) for required binaries/runtimes. Dashboard
  API and CLI commands support checking setup status and triggering install/uninstall.
- 6e8689a: Add a horizontal log split to the TUI's narrow single-pane main view. When
  the terminal is too narrow for the multi-pane grid, the bottom of the
  screen now shows a live log strip while the top keeps the active section
  (System, Stats, Utilities, or Settings). The split is dynamic: the top
  pane gets exactly the rows it needs to render its content without
  truncating (computed from the System chip wrap at the current width, or
  each panel's known row count for Stats/Utilities/Settings), and the log
  strip absorbs all remaining rows — maximizing log visibility without
  clipping the active section. The split disables itself if the leftover
  would give the log strip fewer than 6 rows. Down-arrow shifts sub-focus
  into
  the strip with the same key bindings as the dedicated logs section
  (j/k, Home/G, Enter to expand, w to wrap, c to copy, f to filter).
  Up-arrow at the top of the strip returns focus to the main pane; Esc
  also exits the split. Right/Left/Tab continue to cycle sections,
  including the dedicated full-screen logs view.
- 8c18b45: Add a sender-side "wake recipient immediately" override for messages. The
  message composer now offers a checkbox (when sending to an agent) that sets
  `metadata.wakeRecipient: true` on the message. When honored, the recipient
  agent is woken on receipt regardless of their own `messageResponseMode`
  setting. To prevent agents from forcing wakes on each other, only
  human-originated messages (`fromType: "user"`) trigger the override —
  agent-to-agent traffic continues to respect the recipient's configured
  behavior.

### Patch Changes

- 9be551b: Make the agent error details modal taller on mobile so the full error
  message is visible from the top, with the error pre flexing to fill the
  available height instead of capping at a small fixed height.
- 6f46ab0: Stop the dashboard from auto-marking another agent's messages as read when
  the user opens them while browsing that agent's mailbox. Previously, viewing
  a message in an agent's inbox (e.g. the CEO's mailbox) would call
  `POST /messages/:id/read`, which silently consumed the agent's unread state.
  The agent's heartbeat would then never see the message as pending, and the
  agent's `fn_read_messages` tool (which defaults to `unread_only: true`)
  returned nothing. The mark-as-read call now only fires for the dashboard
  user's own inbox tab.
- 3e68271: Fix the misleading "X active · Y running" label in the Agents overview
  dropdown. Both numbers previously counted agents whose state was either
  `active` or `running`, so the "running" tally over-reported by including
  idle-but-enabled agents. The label now counts each state distinctly:
  "active" reflects only `state === "active"` and "running" reflects only
  `state === "running"`.
- 92d40bc: Two mobile chat fixes:

  1. Tapping the ChatView send button no longer dismisses the soft
     keyboard. preventDefault now fires on `pointerdown` for touch
     pointers (before iOS blurs the textarea — the synthesized mousedown
     it previously relied on fires too late). Click still runs the send
     action so quick taps remain reliable.

  2. The bottom executor status bar is now hidden on mobile while the
     keyboard is open, mirroring `MobileNavBar`. The bar is
     `position: fixed` against the layout viewport, which iOS leaves
     anchored below the keyboard — during a swipe/pan it would slide
     over the message list.

- d791fa9: Fix chat sending silently failing on flaky networks (especially mobile).
  The SSE reader in the dashboard client now treats a closed stream without
  a terminal `done`/`error` event as an error so streaming state unwinds
  instead of getting stuck. The `useChat` and `useQuickChat` hooks also now
  show a toast when a message is queued behind an in-flight response, so
  the previous stuck state is observable rather than silent.
- 74378dc: Workaround long-standing bug where ChatView's mobile send button only
  fired on a long press — quick taps silently did nothing. The previous
  implementation used `pointerdown` + `touchstart` with `preventDefault`
  and a focus-preservation dance so the keyboard would stay up while
  sending; on iOS that path made quick taps fall through entirely. The
  button now uses plain `onClick` with `touch-action: manipulation`. The
  soft keyboard may dismiss on send, which is a minor UX regression
  compared to silent failure. QuickChat is unchanged (it already works
  on mobile).
- c9bbd7d: Fix Codex weekly usage pace calculation when the API returns `reset_at` as epoch milliseconds instead of seconds. The dashboard now parses both formats correctly so weekly reset countdowns and pace status reflect reality.
- a31c432: Restore the documented agent lifecycle by removing `terminated` as an agent state again. Agent stop flows now land on `paused`, while heartbeat run history continues to use `terminated` as a run-status value and existing persisted terminated agents migrate to `paused` on startup.
- 270823d: Fix duplicate ntfy merge notifications by ensuring `ProjectEngine` uses a single `NotificationService` listener graph and passes that shared service into the `NtfyNotifier` compatibility shim.
- a8bfb32: Fix bundled runtime plugin settings behavior for fresh installs: bundled Hermes/OpenClaw/Paperclip settings now open without a 404 before install, first save still lazy-installs, missing bundles return explicit server errors, and bundled install entry resolution now prefers workspace source entrypoints over stale build artifacts.
- 2fce7b3: Fix `scripts/check-test-isolation.mjs` false-failing when `--before` and the
  post-run check are invoked from different working directories (e.g. a worktree
  recorded the baseline, then the main repo ran the check). The shared baseline
  file in `tmpdir()` is now namespaced by a hash of the cwd so concurrent
  worktrees don't clobber each other, and protected `.fusion` dirs that were
  absent from the baseline are now skipped with a warning instead of being
  treated as `{exists: false}` (which previously flagged the entire pre-existing
  directory tree as a "test mutation").
- 85381df: Improve full Chat mobile tool-call cards by keeping collapsed summaries on a single row and tightening spacing for denser scanning without changing expand/collapse behavior.
- 8df5d26: Forward engine skill selection into runtime `skills` metadata for all session paths, and improve Hermes runtime behavior so first-turn prompts preserve Fusion system/skill context instead of silently dropping coordination capability hints on non-pi runtime runs.
- 6e38dad: Auto-install the bundled Fusion skill when the Hermes runtime plugin loads, including profile-aware Hermes skill-path resolution and safe idempotent replacement behavior. Hermes runtime startup now continues with warnings if skill mirroring fails.
- cabd6be: Fix Claude dashboard OAuth on remote hosts by using the pasted authorization-code flow instead of callback URL rewriting, while preserving callback proxy behavior for providers that still require it.
- fca8d27: Preserve agent inline memory in Agent Companies import/export flows so AGENTS manifests round-trip memory without loss.
- 3f5d01f: Fix an engine compatibility bug where reviewer/triage/executor runs could fail when a provider extension rejected both `thinking` and `reasoning_effort` together. Fusion now retries without the explicit thinking-level override for that conflict instead of marking the run unavailable.
- 4dc91ed: Wire `TaskStore` into the runtime's `AgentStore` so the heartbeat auto-claim
  path can call `claimTaskForAgent` without warning
  `TaskStore not configured for task-claim operations`. The `InProcessRuntime`
  previously built its `AgentStore` with only `rootDir`, which left task-claim,
  checkout, and release operations unconfigured even though the runtime had a
  `TaskStore` available.
- 22250eb: Manual heartbeat runs (POST /api/agents/:id/runs) now respond as soon
  as the run record is created instead of blocking on the full
  executeHeartbeat call. Long-running heartbeats no longer cause the
  dashboard to surface "Failed to start heartbeat run: load failed" when
  the client socket times out before the run completes.
- a143bcc: Convert the heartbeat executor's dynamic `import("./agent-session-helpers.js")`
  and `import("./session-skill-context.js")` calls to static imports. This makes
  missing or partial engine dist surface at module load time (matching the
  existing static `pi.js` import) instead of failing mid-heartbeat with a
  confusing `ERR_MODULE_NOT_FOUND`.
- 923411a: Fix merger subject derivation and add a race-rescue layer to the autostash.

  The deterministic fallback now prefers the lowest-numbered `complete Step N` headline (or the oldest commit) over the most-recent commit, and the AI subject/body prompts weight by commit theme instead of file size — so a small token-cleanup fixup that touches a large file no longer hijacks the squash-merge subject.

  The pre-merge autostash now re-snapshots the working tree after the primary stash is persisted but before `git reset --hard` runs, capturing any dirty paths that landed between the initial snapshot and the destructive wipe (concurrent dev edits during a long merger run, parallel merger runs interleaving, or late test/build artifacts) into a separate `race-rescue` stash so they're recoverable from `git stash list`.

  Adds an advisory `.git/.fusion-merger-active.json` written for the duration of each merger run (taskId, pid, hostname, startedAt) so dashboards / status lines / pre-Edit hooks can surface that `rootDir` is volatile. Not a lock — dev edits are never blocked. Race-rescue stashes are now also surfaced on the task feed via `store.logEntry` with the recovery command, instead of only appearing as a `mergerLog.warn`. `resetMergeWithWarn` now wraps each `git reset --merge` in a snapshot-before/after observer so any silent wipe of unrelated dirty paths emits an actionable warning instead of going unnoticed. Exports `readActiveMergerStatus(rootDir)` for consumers.

- fd7c88c: Fix race-rescue stash duplicating the primary autostash. `git add -A && git stash create` registers a stash commit but does not clean the working tree, so the rescue loop's subsequent `snapshotDirtyFiles` saw the same files the primary stash already captured and stashed them again on every merger run. Now the rescue diffs current dirty paths against the primary stash's recorded path set and only rescues paths that weren't already captured, plus a tree-SHA equality check that drops any rescue whose tree exactly matches the primary.
- e6dc3c7: Address code-review findings on the merger autostash work:

  - `parsePorcelainZ` now correctly handles rename/copy entries (`R` / `C` status), which emit two NUL-separated entries for one logical change. Previously the old name was treated as an independent dirty path, causing `runObservedDestructiveSyncOp` to emit spurious "cleared N path(s)" warnings whenever a rename was in flight.
  - The race-rescue loop in `stashUnrelatedRootDirChanges` now runs `git reset` between attempts so each `git add -A` starts from a clean index, preventing iteration-2+ stashes from drifting due to stale staging rather than genuine new writes.
  - `writeActiveMergerStatus` now writes the advisory file via temp-path + atomic `renameSync` so dashboard readers can't observe a partial write.
  - `deriveDeterministicSubjectSummary`'s Step regex switched from `[—\-:]` to `(?:—|-|:)` — same matches, but the em-dash intent is obvious to anyone auditing.

- cd845d3: Reduce redundant test/build runs during merge verification:

  - **Skip the verification re-run after a no-op in-merge fix.** When the fix
    agent doesn't actually modify the working tree (compared via a git
    `diff HEAD` + `status --porcelain` content fingerprint), there's nothing
    new to verify. The merger now logs "fix agent made no changes — skipping
    verification re-run" and records the attempt as failed without paying the
    multi-minute test/build cost.
  - **Skip `pnpm install --frozen-lockfile` when the lockfile hash hasn't
    changed since the last successful install.** A `node_modules/.fusion-install-marker`
    file records the lockfile SHA-256 after a successful install; subsequent
    merge attempts in the same worktree skip install when the lockfile content
    is unchanged, even when `package.json` is staged. Existing
    `shouldSyncDependenciesForMerge` filtering still applies as a first gate.

- 9087239: Remove the dead `reportDashboardPerf` client and its five call sites in
  `App.tsx` / `useProjects.ts`. The companion server route `/_perf/dashboard-load`
  no longer exists, so every call was a silently-swallowed 404. Also drops the
  `dashboard-perf.log` runtime ignore-list entry from
  `scripts/check-test-isolation.mjs` since nothing creates that file anymore.
  Console-side perf logging via `console.log("[App] …")` and
  `console.log("[useProjects] …")` is preserved.
- 0d15916: Fix a race in the stuck-task requeue path that could clobber a task back to
  `todo` (with all step progress reset and worktree torn down) immediately
  after `SelfHealingManager.recoverCompletedTasks` had already moved it to
  `in-review`. The executor's stuck-kill cleanup ran in `execute()`'s
  `finally` block and used a stale captured `task.column` snapshot, so it
  would happily overwrite a fresh recovery. The cleanup now re-reads the
  latest column and skips entirely when the task has moved past
  `in-progress`/`todo`.

  Also adds a new setting `preserveProgressOnStuckRequeue` (default: `true`,
  toggle in Settings → Engine, near "Stuck Task Timeout"). When enabled, the
  stuck detector's requeue passes `{ preserveProgress: true }` to `moveTask`
  so completed step statuses survive the bounce and the agent can resume
  from where it left off instead of restarting every step from pending.

- 7f90308: Stop inadvertently pausing user-facing tasks during heartbeat-unresponsive
  recovery. Adds a `cascadeToTasks` option to `pauseAgent`/`resumeAgent`
  (default `true`) and passes `false` from `recoverUnresponsiveAgent` — the
  internal pause/resume cycle there is just to set
  `pauseReason="heartbeat-unresponsive"` on the agent and shouldn't toggle
  the user's task pause state.

  Also auto-clears `paused`/`pausedByAgentId` in `updateTask` when the agent
  that paused a task is unassigned (or replaced). Previously a task could be
  left orphaned-paused with no UI affordance to recover, since the
  `Pause/Unpause` action in `TaskDetailModal` is hidden whenever an agent is
  assigned.

- 593b42e: Extend `scripts/check-test-isolation.mjs` runtime ignore list to cover live
  fusion app paths that previously tripped the merge-time check when a fusion
  instance was running on the same HOME during tests: `tasks/`, `messages/`,
  `memory-insights.md`, `test-cache.json`, `HEARTBEAT.md`, `kb.db.backup-*`,
  and `fusion.db.pre-*` snapshots. Tests still must not write to these paths;
  the filter only suppresses noise from a concurrently-running app.
- a14ef9e: scripts: make `check-test-isolation` resilient to a concurrently-running fusion app on the same HOME. Filter out paths the live app legitimately writes (databases, agent sessions/memory, plugins, automations, logs, config), sample the baseline over a longer window, and re-sample on suspected violations to avoid false positives during local `pnpm test:isolated`.
- 1100b39: Fix worktree collisions when tasks are manually moved into in-progress.

  Two related bugs caused two in-progress tasks to share a single
  `.worktrees/<name>` directory:

  1. The dashboard `POST /tasks/:id/move` route promoted tasks to
     in-progress without allocating a fresh worktree path, so a queued
     task carrying a stale `worktree` field from a prior
     `preserveResumeState` requeue could land in-progress on a directory
     already owned by another active task.

  2. `TaskStore.moveTask({ preserveResumeState: true })` kept the
     worktree pointer on requeue. When the on-disk checkout was later
     removed or reassigned, the next dispatch could collide with a
     worktree the scheduler had since handed to another task.

  Fixes:

  - `moveTask` now releases the worktree pointer on every reopen-to-todo
    hop. The `branch` field is preserved so the next run reattaches via
    `git worktree add <path> <branch>` and resumes any committed
    progress. A new `preserveWorktree: true` option opts internal
    bounces (workflow-rerun) out of the release so listeners never see
    an interim `worktree=null` state.
  - `moveTask` accepts an `allocateWorktree` callback that runs under a
    cross-task allocation lock in `TaskStore`, building `reservedNames`
    from a fresh `listTasks` snapshot so two concurrent moves cannot
    pick the same name.
  - The manual-move route and the scheduler dispatch path both flow
    through the new allocator, sharing the lock.
  - `planTaskWorktreePath` is exported from `@fusion/engine` for
    consumers that need to plan worktree paths the same way the
    scheduler does.

## 0.22.0

### Minor Changes

- e658e8e: Decouple permanent agent heartbeats from task state, and add per-agent `allowParallelExecution` setting.

  Heartbeats now run for permanent agents regardless of bound-task block state — the prior early-exit on `queued + blockedBy` is removed along with its dead state-tracking machinery. `HEARTBEAT_SYSTEM_PROMPT` is rewritten to scope heartbeats to ambient coordination (messaging, memory, finding work, delegation, surfacing/chasing blockers, status); task body work continues to run via the executor path. Ephemeral agents are unchanged — they don't run heartbeats and their blocked-task gating in the scheduler is untouched.

  New `allowParallelExecution` flag (default `true`, permanent agents only) on `AgentHeartbeatConfig`. When `false`, the heartbeat and task executor paths serialize symmetrically: a heartbeat will not start while the agent's bound task has an active executor session, and an executor session will not start while the agent has an active heartbeat run. Either side re-dispatches the other's deferred work on completion via `resumeTaskForAgent` and the in-process runtime's `onRunCompleted` hook.

  UI toggle surfaces in the agent's Heartbeat Settings tab alongside `runMissedHeartbeatOnStartup`.

- 041eb89: Per-agent setting `runMissedHeartbeatOnStartup` (default off): when enabled, the engine fires a single catch-up heartbeat at server startup if the agent's `lastHeartbeatAt` is older than its configured interval — i.e. a scheduled tick was missed because the server was down.

  The check runs in the same startup pass that arms heartbeat timers (`packages/cli/src/commands/dashboard.ts`), so agents whose state isn't `active`/`running` or who have heartbeats disabled never trigger. Catch-up runs use the existing `executeHeartbeat` path with `source="timer"` and `triggerDetail="startup-missed-heartbeat-catchup"` so per-agent serialization, budget enforcement, and missed/recovered tracking continue to apply. UI toggle lives in the agent's Heartbeat Settings tab.

- 8eb5c3d: Remove the `terminated` AgentState. The agent lifecycle now runs through `idle | active | running | paused | error`, with `paused` (carrying a `pauseReason`) absorbing every former `terminated` use case (manual stop, heartbeat run termination, spawned-child cleanup). Run status is unchanged — heartbeat runs still report `terminated` independently of the agent state.

  Migration: existing `agents` rows where `state = 'terminated'` are rewritten to `state = 'paused'` with `pauseReason: 'migrated-from-terminated'` on first store init (`__meta` key `removeTerminatedAgentState`). The dashboard "Terminated" filter option, badge, and CSS rules are gone; "Stop" buttons now transition the agent to `paused`. The `dashboard.READMEs` "Terminated agent filtering" behavior in the agents list is also dropped — paused/error agents are visible by default, and AgentListModal/AgentsView no longer hide them in "All States."

### Patch Changes

- 7d41271: Three small UX fixes on the agent list card.

  - **Optimistic Run Now**: clicking the Run Now button now flips the card's state badge to `running` immediately. The `startAgentRun` API call can take several seconds, and the prior code awaited it before any visual feedback, leaving users unsure whether the click registered. Mirrors the existing `handleStateChange` pattern — stamp the override, await the API, refresh on success, roll back on failure.
  - **Whole-card clickable**: the entire `.agent-card` body opens the agent detail view, not just the name/icon area. Clicks on action buttons (Run Now, Pause, Details, Delete), the role-edit select, and the role-icon button keep their dedicated behaviors via a target check that bails on interactive descendants. `role="button"`, `tabIndex`, and Enter/Space handling preserve keyboard access; a `--focus-ring` outline shows the focus state.
  - **Single-row card actions**: renamed "View Details" → "Details" and switched `.agent-card-actions` to `flex-wrap: nowrap` with per-button `flex-shrink: 0; white-space: nowrap` so Run Now / Pause / Details stay on one row regardless of card width.

- c76db06: Agent list color now signals run status only: `running` is green, `error` is red, and `idle` / `active` / `paused` all use the neutral gray. Previously `active` shared green with `running` and `paused` was yellow, which made the list visually busy and obscured which agents were actually executing. Applies to the badge, list card border, board card border, and org-chart node card across all agent views.
- b2aed0f: Engine stop now tears down in-progress merger and triager agent sessions
  that previously kept streaming past shutdown.

  **Triager**: `TriageProcessor.stop()` previously only halted the polling
  loop, leaving any in-flight specify session and its reviewer subagents
  streaming LLM tokens and tool calls past shutdown. It now aborts and
  disposes them via the same path the global-pause handler uses.

  **Merger**: `aiMergeTask` creates up to three distinct agent sessions
  during a merge — autostash conflict resolver, in-merge verification fix
  agent, and pull-rebase conflict resolver — but only the autostash session
  was registered via `onSession` for the engine to track. The fix-agent and
  rebase-resolver sessions are now also registered, so
  `ProjectEngine.stop()` actually disposes whichever merger session is
  running when shutdown lands.

- d47501f: Fix two related agent-lifecycle leaks and extract the coordinator into a reusable class.

  **Stuck-in-running bug.** `executeHeartbeat`'s governance-skip paths (budget exhausted, budget threshold, global pause, engine paused) called `startRun` first — flipping the agent to `running` — then short-circuited with `skipStateTransition: true`, leaving the agent permanently stuck at `running` with no active run. Removed the `skipStateTransition` flag from those four paths so they flow through the normal `running → active` transition. Added `HeartbeatMonitor.reconcileOrphanedRunningAgents()` on startup to recover any agents already trapped in this state from older versions.

  **Ephemeral task-worker pile-up.** Runtime-spawned `executor-FN-XXXX` workers leaked across runtime restarts because the in-memory `taskAgentMap` reset every process and there was no on-disk fallback. A task started in one session and completed in another would orphan its worker; over time hundreds piled up. The startup sweep also only deleted ephemerals in halt states, ignoring the no-`taskId` case that accounted for nearly every zombie. Now: spawn dedup via `findAgentByName` lookup before create, on-disk fallback in completion/error paths, and the startup sweep deletes any ephemeral not bound to an in-progress task.

  **`EphemeralWorkerManager` extraction.** The lifecycle logic is now a single class (`packages/engine/src/ephemeral-worker-manager.ts`) owning `taskAgentMap`, `pendingDeletions`, the halt-state listener, and the startup sweep. `InProcessRuntime` shrinks by ~140 lines and delegates via `workerManager.onTaskStart` / `.onTaskComplete` / `.onTaskError` / `.attachStateChangeListener` / `.reconcileOrphaned`. Future runtimes that drive `TaskExecutor` directly inherit the same lifecycle. Durable assigned agents now return to `active` after task completion (was `terminated` in the old contract).

- 12193d2: Auto-install bundled runtime plugins (Hermes / OpenClaw / Paperclip) on first Save in Settings, and ship them inside the published CLI so npx-installed Fusion can load them. Previously the runtime cards rendered but `Save` / `Save and Test` failed with `Plugin "fusion-plugin-…-runtime" not found`, and the plugins were unavailable when the CLI was installed via npm/npx because their workspace `@fusion/plugin-sdk` dependency wasn't bundled. Each runtime plugin is now bundled at CLI build time into a self-contained `dist/plugins/<id>/bundled.js`, and `PUT /api/plugins/:id/settings` lazily registers a bundled runtime via the new `ServerOptions.ensureBundledPluginInstalled` hook the first time the user saves.
- ff66c20: Clarify runtime memory guidance so agents explicitly distinguish private `scope="agent"` memory from shared `scope="project"` memory in prompts and tool metadata.
- bb6169a: Improve dashboard agent error UX by replacing inline stack-trace dumps with compact error indicators that open a shared details modal, including copy-to-clipboard and a prefilled GitHub issue shortcut.
- 12b4a4a: Expose task creator provenance in agent-facing task tools by adding source summaries to `fn_task_show` and concise `[via: …]` labels in `fn_task_list`, including agent-name preference from `sourceMetadata.agentName` with `sourceAgentId` fallback.
- 89fd7a9: Mission sidebar follow-ups for card density and CTA prominence.

  - **Wider title in the sidebar**: stack mission cards vertically inside the
    sidebar so the title row spans the full card width instead of competing
    with the action buttons. Action buttons now sit on their own row below.
  - **Activity on its own row**: the `Activity X ago` label moved out of the
    cramped stats line into its own row.
  - **Full-width progress bar**: the completion bar moved out of the stats
    row onto its own line and now scales to the full card width instead of
    competing with stat labels for horizontal space.
  - **Centered "Plan New Mission" CTA**: the sidebar header now hosts a
    full-width primary-styled button (matches the chat sidebar's "New Chat"
    affordance) with the Sparkles icon and "Plan New Mission" text — replacing
    the dashed-outline icon-only buttons. Mobile footer uses the same label.
  - **Auto-select first mission (inline desktop)**: the inline mission view
    now opens with the first mission preloaded into the detail pane instead
    of an empty placeholder. Falls back to the existing empty-pane copy when
    no missions exist. Standalone-modal usage is unchanged.
  - **Richer empty state**: when no missions exist, the list now explains
    what missions are and surfaces a primary "Plan New Mission" CTA inline.

- f04ade0: Mission view sidebar and list-card UX fixes.

  - **Resizable mission sidebar**: the desktop split sidebar is now drag-resizable via a vertical handle (also keyboard-accessible with arrow keys). Width persists to `localStorage` (`fusion:mission-sidebar-width`), bounded 220–560px, default 300px. Previously fixed at ~284px with `flex-shrink: 0`.
  - **Mission card title no longer truncates aggressively**: tags (autopilot zap, health badge, status pill) moved to a second row below the title so the title can use the full card width. Removed the redundant overflow-prone `Active: …` line that was sometimes spilling outside the card.
  - **Single AI-driven create flow**: removed the manual `+ New Mission` button from the sidebar header and bottom footer. The Sparkles button (now labeled "Create New Mission") is the only entry point — the dead `handleCreateMission` callback and unused `activeSliceLabel` were removed too.

- b312ca4: Fix terminal input/output doubling triggered by creating a new tab. The connect-effect's `contextChanged` dependency flips true→false in the same render cycle as the new connection, re-running the effect and closing the still-CONNECTING WebSocket. Because `cleanup()` and `connect()`'s pre-close paths weren't nulling `ws.onopen`/`onmessage`/`onclose`/`onerror`, the ghost socket's `onmessage` continued to fire on the shared callback Set, delivering each pty data chunk (including keystroke echo) twice to xterm.

## 0.21.0

### Minor Changes

- ac74cb0: Enable browser back-button navigation within the SPA dashboard. Previously, the back button would leave the dashboard entirely. Now it dismisses the top modal or reverts to the previous view, matching standard SPA behavior on both desktop and mobile.

### Patch Changes

- 61dac28: fix: declare node-pty as a runtime dependency so `npx runfusion.ai` can start the embedded terminal on a clean install. Previously node-pty was only present transitively via the workspace `@fusion/dashboard` devDependency, which is stripped at publish time — fresh users hit a 503 "PTY module could not be loaded" when opening the dashboard terminal. The package-config test guard has been tightened to catch this regression.
- 8a57d3f: feat(tui): up/down arrows now cycle sections on the Main page (matching ←/→), except on the Logs panel where they continue to navigate log entries. Pressing Enter on a Logs entry now also releases xterm mouse reporting while the entry is expanded, so users can click-drag to select log text for copying; closing the expanded view restores wheel scrolling automatically.

## 0.20.0

### Minor Changes

- f711019: Add agent self-improvement tools (fn_read_evaluations, fn_update_identity) and periodic self-improvement scheduling based on evaluation feedback.
- d7880c6: Add plugin dashboard view discovery and navigation integration via `GET /api/plugins/dashboard-views`, plugin view ID persistence (`plugin:${pluginId}:${viewId}`), and static host-side plugin view registry rendering.
- 995faf2: Add per-agent heartbeat auto-claim controls so identity-bearing agents can opportunistically claim relevant unowned tasks during no-task heartbeat runs.
- aab28e1: Add first-class Anthropic (Claude) OAuth login support in Settings and onboarding, including fallback detection of existing Claude credentials from local Claude installs while keeping the separate Claude CLI provider option.

### Patch Changes

- df20edb: Auto-archive sweep now skips done tasks that still have an active dependent (in triage, todo, in-progress, or in-review). Previously a stale done task could be archived while a downstream task was still pending, wiping its `.fusion/tasks/{id}/` directory and breaking the downstream agent's sibling-spec read. The agent prompt also now instructs falling back to `fn_task_show` when those sibling files aren't on disk.
- Fix agent heartbeat execution in multi-project setups. On-demand heartbeat triggers from the dashboard API now correctly route to the engine of the project the agent belongs to, instead of silently creating a zombie run record that never executes. Also auto-provisions default agents (triage, executor, reviewer, merger) when the engine starts with an empty agents table.
- 9b01c0a: Self-heal orphaned `agentRuns` rows left in `status='active'` when the dashboard process crashes mid-heartbeat. The trigger scheduler treats any active run as "still running" and silently skips every subsequent tick, so a single crashed run could leave an agent without heartbeats for hours. SelfHealingManager now reconciles these on startup and during periodic maintenance, terminating runs whose `processPid` does not match the current process or whose age exceeds 6 hours.
- b4a2e7a: Fix Quick Chat backend divergence and consolidate the chat render-mode toggle.

  - Backend: Quick Chat and regular chat now go through a single agent-creation path (`createResolvedAgentSession`), eliminating the `createFnAgent` branch where pi-ai's `cleanupSessionResources(sessionId)` could tear down resources still in use by a newer generation. The `sendMessage` `finally` only disposes the agent if it still owns the `activeGenerations` slot, so a pre-empted generation no longer rips state out from under its successor.
  - Frontend: extracted the SSE streaming-handler factory shared between `useChat` and `useQuickChat` (RAF coalescing, accumulators, tool-call dedup, fallback handling) into `createChatStreamHandlers`. Both hooks now compose it instead of duplicating ~85 LOC each.
  - UX: removed per-message Markdown/plain-text eye toggles. A single thread-level toggle now lives in the chat header and flips every assistant bubble (including the streaming one) between rendered Markdown and plain text. Model-only chats also drop their per-message agent-identity row — the model is shown once in the thread header.

- e5fc71b: Treat pi-ai Codex WebSocket transport drops (`WebSocket error`, `WebSocket closed …`, `WebSocket stream closed before response.completed`) as transient errors so the engine retries them instead of marking the task failed. Tag the model id onto the thrown error and emit a structured warn so future drops can be triaged by which provider/model is unstable.
- fdc37a3: Auto-toggle xterm mouse reporting in the dashboard TUI based on the focused panel. Default is now OFF so click-drag selection works by default (e.g. selecting the auth token straight off the System panel without needing `[c]`). Mouse reporting auto-enables when the user focuses a panel that consumes wheel events:

  - Status mode: on while Logs is focused, off elsewhere
  - Interactive views: on for Files / Git / Board (Board uses the wheel in the task-detail screen), off for Agents / Settings

  `[M]` remains a manual override but the next focus change reapplies the auto policy. The controller's `start()` now honors the initial `mouseEnabled` value rather than unconditionally writing the SGR enable sequence at boot.

- 1187ea4: Improve dashboard TUI System panel discoverability and panel navigation:

  - Default the focused panel to **System** on launch so `Enter` immediately opens the dashboard URL in the browser. Adds an inline hint row (`[Enter] open URL · [c] copy token · [M] mouse on/off`) that is only visible while System is focused.
  - Add `[c]` shortcut (when System is focused) to copy the auth token to the clipboard, with the same flash + log-line feedback used by the Logs `[c]` copy. Mouse mode normally blocks click-drag selection of the token, so this gives users a keyboard path.
  - Add `[M]` global shortcut to toggle xterm mouse reporting at runtime. Off → click-drag does native text selection (the only path that works under tmux's `mouse on`, where `Shift+drag` is intercepted by tmux before reaching the terminal). On → wheel scrolling on Logs/Files/Git list panels works as before.
  - Fix `←`/`→` panel cycling order: `SECTION_ORDER` was `[system, logs, utilities, stats, settings]`, which didn't match the visual layout. Changed to `[system, logs, stats, utilities, settings]` so left/right now matches both the on-screen left-to-right card order and the Tab/Shift+Tab cycle (`PANEL_ORDER`). From Logs going right now lands on Stats; from Settings going left now lands on Utilities.
  - Updated the help overlay with the new shortcuts.

- 4137573: Fix chat: after stopping a streaming reply, the next message would appear sent but show no Stop button or "Connecting…" indicator. The cancellation broadcast from the previous generation was leaking into the new SSE subscription, immediately marking it as errored. Each `chatManager.sendMessage` now allocates a per-generation id; `ChatStreamManager` only delivers tagged broadcasts to subscribers from the matching generation, and `sendMessage`'s cleanup no longer deletes a newer generation's `activeGenerations` slot when an older one finally unwinds.
- b85743d: Fix Quick Chat: messages would silently fail after closing the browser tab mid-response and reopening it. The backend agent kept running with no listener and left a stale `activeGenerations` slot; the next message's freshly-opened CLI session then raced against the lingering agent on the same session file. The `/messages` route now calls `chatManager.cancelGeneration` when the client disconnects before the response ended, and `beginGeneration` only aborts the previous generation's controller instead of pre-emptively disposing its agent (the previous agent's own `finally` handles dispose, so we don't tear down the CLI process under the new agent).
- b061e2b: Fix Plan Mission With AI modal: stale goal text and unable to type in textarea. The persisted-goal restoration effect depended on `handleStartInterview`, which recreates on every keystroke via `missionGoal` — causing the effect to re-fire and overwrite user input with stale localStorage data on each character typed.
- 2f40843: Fix QMD-backed agent memory behavior so search results normalize to readable agent-memory paths and dream-processing writes trigger agent-memory QMD refreshes for discoverability.
- 69c75fe: Fix fn_research_list status enum to include all valid ResearchRunStatus values and add wait_for_completion support to fn_research_run.
- f2accb7: Fix Planning Mode summary refinement so "Refine Further" reliably continues completed/resumed sessions through the backend interview flow instead of showing a blank question screen.
- 576238a: Use durable assigned agents as active task execution owners when `assignedAgentId` targets a non-ephemeral agent, instead of always creating transient `executor-FN-*` task-worker agents.
- d790854: Rename global research flat settings keys from `research*` to `researchGlobal*` to enforce settings-scope parity and avoid global/project key collisions.
- 5fb7c77: Fix Git Manager mobile Changes layout overflow so staged/unstaged file lists no longer force horizontal page scrolling. The changes panel now wraps section actions and file rows at narrow widths while preserving readable file names and usable controls.
- a0c1e5b: Give autonomous heartbeat agent sessions coding-capable workspace tools (read/write/edit/bash within worktree boundaries) while preserving heartbeat-specific custom tools and readonly safety for non-heartbeat readonly flows.
- 43dd048: Fix Droid CLI auth/status probing to resolve the effective binary path from plugin settings (including custom `droidBinaryPath`) so Settings no longer reports false "not installed" states when Droid is configured at a non-default path.
- af0bc4b: Auto-pause unresponsive agents with `pauseReason: "heartbeat-unresponsive"` and immediately auto-resume them through the shared heartbeat monitor lifecycle, including consistent assigned-task pause/unpause behavior and single on-demand restart semantics.
- 8a30b6f: Deduplicate auto-merge recovery follow-up task creation so repeated verification-cap and conflict-bounce-cap failures reuse an existing active recovery task instead of spawning duplicates.
- 59f6c84: Fix dashboard user mailbox routing to use deterministic canonical identity normalization so agent replies sent to `dashboard`, `user:dashboard`, or `User: user:dashboard` all land in the dashboard inbox while preserving reply-link metadata.
- 30f6381: Preserve complete GitHub source metadata for imported issues across CLI and extension import paths, and improve commit reference generation by falling back to `externalIssueId` when `issueNumber` is missing.
- 2b809fc: Stop the merger from wiping concurrent dev edits in `rootDir`.

  `aiMergeTask` issues several `git reset --hard` / `git reset --merge` / forced-checkout calls against `rootDir` during merge attempts. When `rootDir` is the developer's primary checkout (the common case for solo / single-host setups), those resets silently discard any unrelated unstaged or untracked changes in the working tree. We've burned developer work this way (FN-3329 retro: dashboard-tui edits were wiped mid-flight by an unrelated merge run).

  `aiMergeTask` now snapshots dirty paths at entry and, if any are present, stashes them under a labeled autostash (`fusion-merger-autostash:<taskId>:<ts>`, includes untracked files via `git stash push -u`). A try/finally around the merge body restores the stash on every exit path — success, error, or abort. If the pop conflicts (e.g. the merge committed an overlapping change), the stash is left intact and the operator gets a recovery hint in the merger log; we never silently `git stash drop`.

  Best-effort throughout: a stash failure logs and proceeds with the old behavior rather than blocking the merge — strictly worse regressions are off the table.

- d253e01: Reduce log noise: bump `checkForChanges` slow-poll warn threshold from 100ms to 750ms (the 1s poll interval + multiple SQLite queries routinely exceed 100ms without indicating a real problem), and route skill-resolver `info` diagnostics (e.g. "Requested skill: …") through `log()` instead of `warn()` so informational messages no longer surface as warnings.
- 9115130: Upgrade `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` from `^0.72.1` to `^0.73.0` across cli, engine, and dashboard. pi-ai 0.73 also extracts the underlying `ErrorEvent.error` cause for Codex WebSocket failures, complementing our local transient-retry classifier.

## 0.19.0

### Minor Changes

- 1e73863: Add first-class llama.cpp provider support with bundled extension wiring, dashboard status/auth routes, model filtering, and onboarding/settings UI for enabling llama-server models without manual `pi install` steps.
- 496c000: Add `fn update` command to check for and install the latest version of Fusion.
- df253a8: Cache merge verification by tree hash and boost test concurrency for in-review verification.

### Patch Changes

- d06475b: Harden the publish path against dockerode-class missing-dependency regressions (#33). Adds a generalized invariant test that walks `tsup.config.ts` and asserts every non-builtin `external` is either a runtime dep or in an explicit transitive-allowlist, plus a pre-publish smoke step in `pnpm release` that packs the public tarballs, installs them with plain `npm` into a clean temp dir, and invokes the bin — catching the dockerode-class bug (and others like missing `files` globs) before publish, since pnpm hoisting masks it in the workspace.
- eeab870: Store generated memory insight artifacts under `.fusion/memory/` (`memory-insights.md`, `memory-audit.md`, and `memory-audit-state.json`) instead of top-level `.fusion/` files, with compatibility migration for existing legacy files.
- d30f8a7: Allow the dashboard task-detail footer action to manually drive PR-first completion when `mergeStrategy` is `pull-request` and `autoMerge` is disabled.
- 8483a5f: Make the settings modal fill the viewport on mobile and align section headings with form-group gutters for consistent spacing across each settings page.
- df253a8: Cache per-package test results by content hash to skip unchanged packages across sequential merges.

  `scripts/test-changed.mjs` now maintains a per-project cache at `.fusion/test-cache.json`. For each package in a changed-mode run, a SHA-256 is computed from the git blob SHAs of every tracked file in the package directory plus `pnpm-lock.yaml` and `tsconfig.base.json`. If the hash matches a cache entry younger than 7 days the package is excluded from the `pnpm --filter` invocation and tests are skipped. After a successful run the passing hashes are written atomically. Cache lookups are bypassed when `FUSION_TEST_NO_CACHE=1` or `--no-cache` is passed, and never applied to full-suite runs. A new `FUSION_TEST_WORKSPACE_CONCURRENCY` env var controls `--workspace-concurrency` (default `2`).

## 0.18.1

### Patch Changes

- 89401cd: Fix `npx runfusion.ai` failing with `ERR_MODULE_NOT_FOUND: Cannot find package 'dockerode'` by declaring `dockerode` as a runtime dependency of the published CLI package (#33).
- 89401cd: Allow the dashboard task-detail footer action to manually drive PR-first completion when `mergeStrategy` is `pull-request` and `autoMerge` is disabled.

## 0.18.0

### Minor Changes

- cc5c8c6: Extend dashboard node management with managed Docker node status UI, Docker-specific detail sections, and Docker node status/logs API routes.

### Patch Changes

- 986a928: Fix dashboard task deletion failing with "still referenced as a dependency" even after the user confirms removing dependency references. The `useTasks` hook's `deleteTask` was dropping its `options` argument, so the `removeDependencyReferences` flag from the confirmation flow never reached the API.
- c00b018: Fix mobile bottom nav bar overlapping the iOS home indicator in installed PWAs and the visible gap between the nav bar and the executor status bar. The nav bar now extends its surface into the safe-area inset so icons sit above the home indicator and the bar meets the status bar flush.
- 66f85da: Treat OpenAI-compatible `finish_reason: repeat` (raised by Moonshot/Kimi when its server-side repetition detector trips) as a soft stop in the engine heartbeat instead of a fatal error, so agent runs survive the truncation and can continue on the next tick.
- 3afb62b: Fix skill name matching between Fusion's two-segment names (e.g. `web-research/SKILL.md`) and pi-coding-agent's bare directory names (e.g. `web-research`). Patterns and requested skill names now strip the `/SKILL.md` suffix before comparison, eliminating spurious "not found in discovered skills" warnings.
- 08d655a: Fix a mobile dashboard regression where closing Planning Mode after keyboard/visualViewport changes could leave board/list content shifted or clipped. Planning Mode now performs mobile viewport teardown (blur + top snap) on close so control returns cleanly to the dashboard.
- d761ea8: Hardened CLI packaging against native module build regressions by asserting `dockerode`/`ssh2`/`cpu-features` remain externalized in tsup bundle config, preventing native `.node` artifact strings from being inlined into the bundle, and declaring `dockerode` as a runtime dependency for published installs.
- 2b102af: Retrying failed `in-review` tasks now keeps them in `in-review` and only clears retry/error state so auto-merge can re-attempt without resetting task worktree state.
- 8cb8055: Agent pause now automatically pauses all assigned tasks; manual pause controls are blocked/hidden for agent-assigned tasks; tasks now show a "paused by agent" indicator.

## 0.17.2

### Patch Changes

- bacc103: Fix Codex auth interoperability, remote OAuth manual-code login flow, and chat fallback/error handling.

## 0.17.1

## 0.17.0

### Minor Changes

- 6724cf5: Add `autoReloadOnVersionChange` global setting to make the dashboard's automatic reload on version changes optional. Users can disable auto-reload in Settings → General → Updates.
- 7f3fb77: Harden research subsystem with bounded rate/concurrency limits, cancellation safety, timeout handling, bounded retries, and graceful disabled/setup/error states across dashboard, API, CLI, and agent tooling.
- fca870f: Add Docker target connectivity support for local daemon, Docker contexts, and direct host/TLS configuration with dashboard API and UI selectors.
- d812427: Add mesh configuration generation service and API routes for Docker node provisioning (FN-3111). New exports from `@fusion/core`: `MeshConfigGenerator`, `MeshConfigGeneratorInput`, `FullProvisioningInput`, `MeshConnectionConfig`, `MeshConfigResult`.

### Patch Changes

- ba893b8: Fix chat progress indicator on reload: show "Connecting…" indicator when dashboard reloads during active AI generation
- 5291a6f: Fix custom model providers (e.g., Kimi, LM Studio, Ollama) failing with "No API key" error. The auth storage proxy now reads API keys from models.json as a fallback, and a Proxy set trap ensures the ModelRegistry's fallback resolver works correctly through the proxy.
- 3db1752: Fix Planning Mode modal being pushed up when virtual keyboard opens on mobile. The modal now uses `useMobileKeyboard` to track viewport changes and adjusts its height via CSS variables instead of relying on `100dvh`.
- 85d02c8: Fix spurious "new version" reloads in the dashboard by making the build version deterministic based on git commit hash instead of a random token generated per build.
- ea5b7af: Fix mobile dashboard shifted state after closing Todo modal. The TodoModal now uses `useMobileKeyboard` to track visual viewport changes, preventing the underlying dashboard layout from becoming offset when the virtual keyboard opens and closes.
- a82c3dc: Fix project memory tools failing in fresh worktrees and bundled runtime contexts when an internal memory backend artifact is missing. `fn_memory_search` and `fn_memory_get` now resolve the backend through bundled runtime code instead of a fragile side-load import path.
- a47f319: Restore dashboard chat reply rendering for both full Chat and Quick Chat by fixing shared streaming response behavior and follow-up UX styling isolation regressions.
- 9309c8c: Fix planning mode reasoning visibility: AI thinking output is now preserved as expandable conversation history when transitioning from the loading state to the first question or summary, and when resuming persisted sessions.
- b9b5c08: Fix mobile dashboard layout offset after modal keyboard dismissal. Modal inputs no longer leak keyboard-open state into the underlying dashboard layout, preventing stale bottom-padding offsets.
- c76d138: Fix infinite todo↔in-review loop on tasks whose previous run exhausted their merge budget. The scheduler now resets `mergeRetries` to 0 when dispatching a task to in-progress, so each fresh execution gets a fresh merge budget. Without this, a task with `mergeRetries=MAX` and `status=null` would land back in in-review, the merger would refuse it (`canMergeTask` false), and the ghost-review fallback would bounce it to todo every 10 minutes — before the 30-minute merge-cooldown could elapse.
- 21504f6: Remove "install pi" references from user-facing docs and skill files. Fusion no longer requires pi as a prerequisite — all pi installation instructions and "pi extension" framing have been removed from README, docs, and AI skill files.
- a1a8d03: Fix skill and settings discovery when agent cwd is a worktree path. Previously, agents running in worktrees couldn't find skills, load project settings, or discover extensions because path resolution used the worktree directory directly instead of walking up to the project root.
- 63bb62f: Fix extension provider registration using wrong directory when project runs outside engine's working directory.
- de02fed: Improve merger verification-fix agent: detect stale/missing sibling-workspace `dist/` artifacts (e.g. `Failed to resolve import "./X.js"`, `ERR_MODULE_NOT_FOUND` into another package) and rebuild before assuming a code fix is needed. The agent may also modify files unrelated to the task's original change when needed to make pre-existing build/test breakage on the base branch pass.

## 0.16.0

### Minor Changes

- 6ae7aef: Add a project-level `completionDocumentationMode` setting (`off`, `changeset`, `changelog`) and use it during triage prompt generation so new task specs automatically require the appropriate completion release-note artifact.

  Also expose the setting in Dashboard → Settings → Project → General and document it in the settings reference.

- 5ebccc4: Add `createAiSession` to `PluginContext` so plugins can create AI sessions through an engine-injected factory without importing `@fusion/engine` directly.
- 17f5d4a: Execute plugin `onSchemaInit` hooks during startup after plugins are loaded, so plugins can register idempotent tables and indexes with the runtime database.

### Patch Changes

- 41bb6be: Cache the AgentStore SQLite connection per project so the dashboard no longer reopens the database, re-runs migrations, and re-executes `PRAGMA integrity_check` on every `/api/agents` request. On large project databases this turned a sub-100ms call into multi-second latency that bled into every dashboard view fetching the agent list.
- 9c45d24: Cap per-package Vitest worker fan-out to 6 (from `cpus().length - 1`) and lower the root `pnpm test` workspace concurrency from 4 to 2. On high-core developer machines this prevents `pnpm test` from spawning 100+ worker threads, which was saturating CPU and slowing the dashboard while agents ran tests. Override is still available via `VITEST_MAX_WORKERS`.
- 3bafc48: Fix periodic dashboard event-loop stalls caused by synchronous shell-outs and filesystem reads on hot request paths.

  Two distinct sources, both replaced with async equivalents:

  - **`pgrep -f vitest`** ran via `execSync` in `getVitestProcessIds` (`/api/system-stats`, `/api/kill-vitest`) and `killVitestProcesses` (TUI memory-pressure check). On a busy machine `pgrep` walking the process table can take 100ms+; `execSync` blocks the entire Node event loop for that duration, so every concurrent dashboard request hangs while pgrep runs. The TUI variant fired on every memory-pressure tick (every 2s when over threshold), the dashboard variant fired on every system-stats poll (every 5s while the modal is open). Both now use `execFile` with a callback wrapped in a Promise.
  - **`discoverDashboardPiExtensions`** (called from 3 `/api/settings/pi-extensions` routes) did 6+ blocking `existsSync`/`readFileSync` calls per invocation across legacy and fusion settings paths. Converted to `fs.promises.readFile`/`access` and parallelized via `Promise.all`.

- 1744534: Fix dashboard freezing for several seconds while a Fusion agent runs a long verification command (e.g. `pnpm test`).

  Root cause was in `runVerificationCommand`'s output capture (`packages/engine/src/run-verification-tool.ts`). The captured stdout/stderr buffers used a string-concat + re-encode pattern: once total output exceeded 200 KB, every subsequent line did `Buffer.from(buf.tail).subarray(...).toString("utf8")`, allocating and re-decoding the entire ~100 KB tail per line. A vitest run dumping 50k+ lines produced multiple GB of GC churn, which stalled the dashboard event loop in stop-the-world pauses (matching the symptom: occasional multi-second freezes with no CPU spike on the host).

  The buffer is now stored as a chunk array; tail compaction runs only when accumulated size grows past 2× the cap, making per-line append amortized O(1). All 12 existing `run-verification-command` tests pass unchanged.

  Two follow-on changes shipped in the same patch:

  - **Embedded terminal PTY ingestion** (`packages/dashboard/src/terminal-service.ts`) had the same anti-pattern: `outputBuffer.slice(0, 4096)` + `outputBuffer.slice(4096)` on every 4 ms flush tick. Switched to a chunk array with O(1) drain. Throttle bumped from 4 ms to 16 ms (60 fps) and per-flush cap from 4 KB to 64 KB. This was not the cause of the user-reported freeze, but the same O(N²) hazard would surface under any flood from a terminal pane.
  - **Vitest worker fan-out tightened**: per-package cap lowered from `min(6, cpus()-1)` to `min(4, cpus()-1)` in cli/dashboard/desktop/mobile/plugin-sdk/engine (engine had no cap before). Each config now explicitly pins `pool` (`forks` or `threads`) and only sets the matching `poolOptions`, removing the dual-pool declaration. Worst-case `pnpm test` fan-out: ~12 workers → ~8.

- 9619cd1: Speed up dashboard load and interaction for projects with 100+ tasks.

  Two cheap fixes that together cover the dominant hot paths:

  - **DB indexes on `tasks.column` and `tasks.updatedAt`** (migration 59 in `packages/core/src/db.ts`). `listTasks()` filters by `"column"` on every board load, and the SSE/refresh paths sort by `updatedAt`; neither column had an index, so each query did a full table scan plus a temp B-tree sort. With 100+ tasks this becomes the dominant cost on initial load.
  - **Debounce embedded detail-pane fetches** (`packages/dashboard/app/components/ListView.tsx`). `handleEmbeddedOpenDetail` previously fired a full `fetchTaskDetail` (which pulls log + comments) synchronously on every selection change, so rapid keyboard/mouse navigation through a long list would issue a burst of heavy requests. Fetches are now debounced to 200 ms and stale-target requests short-circuit before hitting the server and before applying state.

- 222e11c: Reduce dashboard stalls by clipping oversized agent tool log payloads, bounding the activity API default, and softening live WAL checkpoint behavior.
- 8ba8f63: Avoid nested `.fusion/.fusion` regressions by hardening project-root path handling and stop the CLI binary status probe from executing outdated global `fn` installs just to read their version.
- df04acd: Fix merge commits landing with the bare `feat(FN-XXXX): merge fusion/fn-xxxx` subject. Three fallback commit paths in the merger (auto-resolve-all-conflicts, `-X theirs/ours` side strategy, AI-agent-didn't-commit) now route through the same deterministic message builder as the happy path, so they pick up the AI-generated subject when available. When the AI subject summarizer returns null, the subject is now derived from the branch's first step-commit (with conventional-commit prefix stripped, plus `(+N more)` when multiple commits) instead of falling back to `merge <branch>`. Subject-summarizer timeout raised from 15s to 30s so slow-first-token providers complete instead of silently falling back.
- 2affc14: Fix planning draft sessions losing the user's typed text and model selection between draft create, sidebar reopen, and Start Planning. The agent now receives the freshest persisted `initialPlan` (not the truncated cache from when the draft was first auto-created), drafts that survive a backend restart can still be started, and the model override the user picked at draft time is restored when reopening from the sidebar and threaded through summarize. The sidebar shows the summarized title once available and falls back to a per-draft preview derived from `inputPayload` while the title is still the placeholder — so multiple drafts are distinguishable without leaking raw keystrokes into the persisted title. Titles get re-summarized on textarea blur and modal close so they reflect the final text rather than locking to the first blur snapshot, and the start path skips its own summarize when blur/close already produced a title for the same final text.
- bf7caf5: Fix planning modal final step rendering "Break into Tasks" button offscreen on mobile by stacking the summary action buttons vertically.
- 2769e4a: Fix startup sync errors for step-based automations (auto-summarize, memory dreams) by allowing empty `command` in `updateSchedule` when the schedule has steps.
- e1c1072: Add a dedicated `fallback-used` notification event that fires when Fusion recovers from a retryable model failure by switching to a configured fallback model, and expose it in global notification settings for ntfy/webhook filtering.
- 6b4f28a: Prevent malformed task titles derived from assistant/tool confirmation prose (for example, `Created task **FN-1234** ...`) from being persisted as task titles. The triage finalization/recovery flow now also prefers canonical prompt headings (`# Task: FN-XXXX - Title`) when they match the task ID, so approved specs restore the intended human-readable title in metadata.
- 44cc899: Preserve task step progress when moving tasks back to todo for recovery flows, and add dashboard confirmations that let users choose whether to keep or reset step progress during manual reset-to-todo/triage moves.
- 6bc2de9: Reordered the dashboard TUI Stats panel memory row to show memory usage percentage before absolute used/total values for faster operator scanning.
- 6c5146b: Auto-install the bundled dependency graph plugin on startup and ship its assets in CLI build artifacts so the graph view is available by default.
- 922782f: Bump `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` from 0.70.0 to 0.72.1 across cli, dashboard, and engine. This refreshes the built-in model catalog (`pi-ai/dist/models.generated.js`) that feeds Fusion's `ModelRegistry`, picking up the latest provider/model entries (Anthropic, OpenAI, Codex, Bedrock, etc.) generated from upstream `models.dev`. No Fusion-side API changes.
- adbc613: Group planning model selector and depth controls under a collapsible "Advanced planning settings" disclosure in the Planning Mode modal.
- 8f72eee: Remove the Agents page tree view mode and its associated state, hierarchy hook, and tree-specific styling. The view switcher now supports list, board, and org chart only, reducing maintenance overhead for an unused mode.
- d73070c: Fix triage finalization clobbering its own freshly-written PROMPT.md spec, and fix the older title/description-driven regen path silently dropping `## Review Level` / `## Frontend UX Criteria` and any other sections outside a fixed whitelist. Tasks have been shipping to `todo` (and through to `done`) with empty 70–200 byte specs while the executor agent only saw the original one-line user description; tasks that survived that bug could still come out of triage with their review level reset to 0 and frontend guidance dropped.

  **Root causes.**

  - FN-3056 (May 2) added `taskUpdates.title = promptDeclaredTitle` to `TriageProcessor.finalizeApprovedTask` and called `store.updateTask(task.id, taskUpdates)` while `task.column` was still `'triage'`. A pre-existing block in `TaskStore.updateTask` rewrote PROMPT.md to the bootstrap stub `# {id}: {title}\n\n{description}\n` whenever title/description changed on a triage-column task, overwriting the agent's just-written 6 KB spec with a 150-byte stub before `moveTask` ran.
  - The non-triage branch of the same regen block called `regeneratePrompt`, which rebuilt the file from a fixed section whitelist (`Dependencies`, `Steps`, `File Scope`, `Acceptance Criteria`, `Notifications`). Any section the triage prompt emits outside that whitelist — `## Review Level`, `## Frontend UX Criteria`, custom assessment scoring, anything ad-hoc — was silently dropped on every title or description edit.

  **Fixes.**

  - `packages/core/src/store.ts`: title/description sync is now wrapper-shape-exact, not content-inspecting. The bootstrap stub detector compares the on-disk file against the exact bytes `createTask` would have written for the _pre-update_ title/description (shared `buildBootstrapPrompt` helper), so it never inspects the description body. This is robust to imported issue bodies that contain `## Repro`, `**Created:**`, etc. — earlier heuristic checks (size caps, `##` header presence, `**Created:**` / `**Size:**` markers) misclassified those as real specs. Stub files keep getting fully rewritten so the displayed title/description stay in sync. Real specs get surgical edits only: title changes splice the leading `# ...` heading line and preserve the existing heading style (triage's `# Task: {id} - {title}` vs createTask's `# {id}: {title}`); description changes rewrite only the body of `## Mission`, leaving every other section verbatim. Description-only edits with no `## Mission` section are a no-op rather than a wholesale rebuild. The `regeneratePrompt` whitelist function is removed.
  - `packages/engine/src/triage.ts`: `finalizeApprovedTask` applies the prompt-declared title _after_ `moveTask("todo")` so the column transition happens before any title-driven regen could fire — defense in depth alongside the store-level guard. The `requirePlanApproval` branch folds the title into its existing `awaiting-approval` update.
  - New regression tests in `packages/core/src/__tests__/store.test.ts`: the original bug (real spec on a triage task survives a title change), the false-negative cases (long bootstrap stubs and stubs whose description body contains `##` markdown headings or `**Created:**` / `**Size:**` text are still detected and rewritten), the secondary regression (`## Review Level` and `## Frontend UX Criteria` survive a non-triage title edit), and an end-to-end test that mirrors the exact `TriageProcessor.finalizeApprovedTask` sequence (write spec → updateTask without title → moveTask("todo") → updateTask({title})) on a real `TaskStore` to catch any future regression along the actual finalize path.

## 0.15.0

### Minor Changes

- 9e52028: Add host support for plugin-registered top-level dashboard views and ship the first plugin-first Graph view surface for dependency visualization.

### Patch Changes

- ed477f8: Fix recurring SQLite instability under heavy agent logging by tuning WAL pragmas, adding startup integrity detection with non-blocking corruption signaling, batching agent log writes in transactions, and reducing default maintenance cadence to checkpoint WAL more frequently.
- 9fc5fd9: Limit unregistered project detection to the exact current working directory.

## 0.14.3

### Patch Changes

- dd291db: Tokenize `isInProcessBackupCommand` so it accepts the full canonical zero-install form `npx -y runfusion.ai backup --create` (and other npx flag combinations such as `--yes`, `-p <pkg>`, `--package=<pkg>`) and refuses commands that embed shell continuations or redirections (`&&`, `||`, `|`, `;`, `>`, `<`, backticks, `$()`). The previous regex permitted only a bare `npx` prefix and silently swallowed any tail after `--create`, which meant `npx -y runfusion.ai backup --create` still hit the legacy shell-out and `fn backup --create && notify-send done` lost its trailing side effect when intercepted. The new matcher only intercepts when the entire command is a plain in-process backup invocation; anything else continues through the shell as authored.
- 3119537: Fix pause handling so restarted or paused engines do not resume work or move recovered tasks into review until execution is resumed, including workflow-step and completion handoff paths.
- 03d0fac: Fix agent run log streaming in the dashboard so latest-run logs load lazily and live log streams stay stable while runs refresh.
- 7fec762: Fix engine startup creating a spurious `.fusion/.fusion/fusion.db` under each project root. The in-process runtime was passing the project's `.fusion` directory to PluginStore, which internally appends `.fusion` again, producing a nested empty database alongside the real one. PluginStore now receives the project root, matching every other call site.
- 24b3ded: Add a global `fnBinaryCheckEnabled` setting that lets users opt out of the dashboard's `fn`/`fusion` CLI binary probe. Default remains true (probe runs as before). When set to false, `GET /system/fn-binary/status` returns `state: "skipped"` without spawning a subprocess, the install banner stays hidden, and `POST /system/fn-binary/install` rejects with HTTP 409. Useful when the running dev process is the source of truth and shelling out to whichever globally-installed `runfusion.ai` happens to be on PATH is unwanted.
- 36d623a: Add a defensive guard in `Database` constructor that throws when opening a database at a path whose last two segments are both `.fusion`. This catches caller bugs where a `.fusion` directory is passed in place of a project root (causing `.fusion/.fusion/fusion.db` to be silently created). Future regressions of this class of bug now fail loudly at the originating call site instead of leaving stray nested directories.
- 5a41ce4: Tighten the in-process backup matcher to the `backup --create` form only and run `fn`/`fusion`/`runfusion.ai` `--version` probes from a temp directory. Previously any subcommand starting with `fn backup` (e.g. `--list`, `--cleanup`, `--restore`) was intercepted by the in-process runner that only knows how to create backups, so a scheduled list/cleanup/restore would silently execute a create instead. The interception now also applies to step-based automations, not just the legacy single-command form. The `--version` probe used by the dashboard fn-binary status route now spawns with `cwd=tmpdir()` so an outdated globally-installed CLI cannot drop a stray `.fusion/.fusion/` tree in the parent project's directory while the probe is running.
- 3119537: Demote pi-claude-cli MCP config refresh log from stderr to debug-only so it no longer surfaces as an error.
- 8592472: Run the auto-backup automation in-process instead of shelling out to whatever fusion binary happens to be on `PATH`. The cron and routine runners now intercept commands matching `fn backup`, `fusion backup`, or `npx runfusion.ai backup` and call `runBackupCommand` directly through the engine's already-open `TaskStore`. This stops the auto-backup from launching an outdated globally-installed fusion binary that could re-introduce already-fixed bugs (most recently the `pluginStore` rootDir mistake that created a stray `.fusion/.fusion/` directory each time the schedule fired). New backup automations are also written with the simpler `fn backup --create` command — existing schedules using the old `npx runfusion.ai` form keep working because both forms hit the same in-process interception.
- 66a19b5: Add mouse-wheel scrolling to the dashboard TUI. Wheel scrolls the focused pane in the task detail logs, Git view (commits/branches/worktrees lists), and Files view (tree selection or preview viewport depending on focus). Uses xterm SGR mouse reporting (`?1000h` + `?1006h`) without motion tracking so Shift+drag native text selection still works.

## 0.14.2

### Patch Changes

- 7ec394a: Keep chat and quick chat visibly in a connecting or thinking state during long Claude CLI responses, and repair missing spaces in some streamed sentence boundaries.
- b3e2b61: Hide deprecated Google Gemini CLI/Antigravity auth providers from dashboard onboarding and Settings while keeping supported Google/Gemini API-key, Google Generative AI, Vertex, and Cloud Code paths intact. Also documents the internal pi-coding-agent v0.71.x upgrade plan for follow-up dependency bump work.
- b3e2b61: Remove redundant `fn_identity` heartbeat tool and trim the inline Identity Snapshot to presence flags + content hashes. Full soul/instructions/memory content is already loaded in the system prompt's Custom Instructions section, so per-tick previews were duplicating multi-KB of context for no verification benefit. Saves prompt tokens on every heartbeat run.

## 0.14.1

### Patch Changes

- cafe986: Fix readonly `createFnAgent` sessions to preserve caller-supplied engine custom tools while still excluding host extensions. This restores delegation and memory tools for no-task heartbeat/reviewer readonly sessions without reopening host extension tool injection in summarizer flows.

## 0.14.0

### Minor Changes

- e505bad: Make the `fn` / `fusion` global CLI install discoverable and self-serve from the dashboard.

  - Settings → General now has a **CLI Binary** panel showing whether `fn` (or `fusion`) is on PATH, the resolved version, and a one-click **Install with npm** button that runs `npm install -g runfusion.ai` server-side. The panel also surfaces copy-to-clipboard install commands (`npm install -g runfusion.ai` and `curl -fsSL https://runfusion.ai/install.sh | sh`) for users with non-default npm setups, and reports a permissions hint when `npm install -g` fails with `EACCES`.
  - A first-launch banner nudges users to install when the binary is missing; dismissal is permanent (per-browser localStorage).
  - Fixed scheduled **Database Backup** automations whose persisted command was `fn backup --create` — those failed every run on hosts where the global bin was never linked. A new schema migration (v58) rewrites legacy `fn`/`kb`/`fusion` backup commands to `npx runfusion.ai backup --create`, matching the canonical seed in `syncBackupAutomation`.
  - Added `detectFnBinary()` to `@fusion/core` so server-side code can resolve the right invocation prefix (`fn` > `fusion` > `npx -y runfusion.ai`) without baking a binary name into automations or generated commands.

- 1634ea3: Ship Droid CLI provider integration in the published Fusion CLI bundle by vendoring `@fusion/droid-cli` runtime extension files, so users can enable **Factory AI — via Droid CLI** from dashboard authentication once the `droid` binary is installed and authenticated locally.
- 4231c4a: Split the Star-on-GitHub toggle, CLI Binary panel, and update-check controls into a new **Global → General** settings pane (with an inline **Updates** subsection), separate from the project-scoped Project → General pane. All three are global by nature, and grouping them under Global avoids the impression that they apply only to the active project. The standalone Global → Updates entry has been folded into this pane.

  The CLI Binary panel also drops its own outlined card background and adopts the standard `padding: 0 var(--space-xl)` indent every other top-level child of `.settings-content` uses, so it sits flush with adjacent form groups instead of bleeding to the pane edges.

  Wire `--version` / `-v` in the `fn` / `fusion` bin so it prints the package version and exits before falling through to the default `dashboard` command. Without this, the dashboard's CLI Binary panel reported the installed version as "unknown" because its `<bin> --version` probe was booting the full server instead of getting a version string.

### Patch Changes

- f0d0f8c: Fix two issues with question display in planning mode:

  - Questions sometimes stayed hidden behind the "thinking" view until the panel was closed and reopened. The live SSE `question` event could be missed (e.g. when the tab was throttled), and the only path that promoted the view was the live event. Add an 8s polling fallback that refetches the session while the view is in the `loading` state and transitions to `question`/`summary` if the server has already moved on, so a dropped event self-heals.
  - Clicking "New Session" and then typing into the textarea jumped the panel back to the previous session's questions. The "resume on open" effect listed `loadSession` in its deps; `loadSession` is recreated whenever `connectToPlanningStream` changes, and the latter depends on `initialPlan`, so each keystroke re-ran the resume effect and reloaded the dismissed session. Track dismissed `resumeSessionId`s in a ref and drop `loadSession` from the effect's deps. Also guard the SSE `onThinking`/`onQuestion`/`onSummary` handlers against late events from a stale connection so they can't overwrite the new session's view.

- 5398bc7: Fixes and a new appearance setting for the AI session notification banner and planning mode UI:

  - Planning mode question list no longer has its own inner scrollbar nested inside the right pane's scrollbar. The inner `.planning-options` `max-height: 40vh` constraint was removed so longer question lists expand naturally and the outer pane handles all scrolling.
  - After a page refresh, the "AI sessions need your input" banner briefly displayed the real session title and then flipped to the literal default "Planning session". `PlanningModeModal` was broadcasting the fallback title via the cross-tab sync channel before `initialPlan` had hydrated on a resumed session, overwriting the API title. The broadcast now omits the title field when no real title is known, so the API title is preserved.
  - Banner dismissals are now persisted to `localStorage` keyed by session `updatedAt`. A dismissed entry stays hidden across refreshes until the session advances (a new question/event arrives), at which point the dismissal is auto-pruned and the banner re-appears.
  - Added a Settings → Appearance toggle to hide the AI session notification banner entirely.

- 80b45d0: Fix per-agent filesystem defaults to use display-name-plus-id directories (for example `ceo-agent2736`) for heartbeat procedure files and managed instruction bundles, while preserving compatibility with legacy id-only and previously created display-name-based paths. Existing agent files are reused in place and are not auto-renamed or deleted during upgrades.
- fd36fbd: Fix heartbeat run prompt composition so manual and automatic runs consistently include agent identity/instructions context and autonomous heartbeat framing for both task-scoped and no-task execution.
- 8b7f20f: Clarify and harden cross-node mesh lifecycle ownership in node startup paths. Peer exchange shutdown is now deterministic (idempotent and waits for in-flight sync), and docs/tests now codify that mesh discovery + peer exchange are owned by `fn serve`/`fn dashboard` process lifecycle rather than per-project runtime startup.
- c08a872: Apply task priority across all Fusion scheduling paths so urgent work overtakes older low-priority work — including the merge queue, which previously merged tasks strictly FIFO.

  - The auto-merge queue now picks the highest-priority eligible task each iteration (`urgent → high → normal → low`, then `createdAt` ASC, then id ASC). Manual `onMerge` resolvers still run before auto-merges so awaited callers aren't starved.
  - Startup, periodic, global-unpause, and engine-unpause sweeps now sort their `listTasks` result by priority before enqueueing, so the first task picked up by `drainMergeQueue`'s single-item fast path is the highest-priority eligible one rather than the oldest. All four sweeps share a new `enqueueEligibleInReviewTasks` helper.
  - Hardened the picker against concurrent queue mutation: it now re-locates the chosen task via `indexOf` after awaiting `getTask`, so a `stop()` clear or pause-handler removal that lands during the await can't splice out the wrong sibling. Drain and picker both re-check `shuttingDown` after the awaits to avoid starting a merge whose queue entry was already cleared.
  - Triage and todo→in-progress scheduling already used the shared `sortTasksByPriorityThenAgeAndId` comparator and continue to apply dependency, overlap, and worktree constraints after the priority sort.

- 0188da7: Raise the per-IP planning session rate limit from 5/hour to 1000/hour. The previous cap was tripping for normal interactive usage during a single session.
- 4d70a9e: Always reload the selected planning session into the right pane when the planning screen is shown. Previously the reload was skipped if an SSE stream was still connected, so a stream that survived close (or one re-established before the reload effect ran) could leave the right view divergent from the sidebar selection. `loadSession` already tears down and reconnects the stream, so the guard was unnecessary; dropping it makes close+reopen — and any other show transition — deterministically refresh the detail view from the server.
- e72eff4: Fix `PATCH /tasks/:id` silently dropping task priority updates. The route handler in the dashboard server was destructuring every editable field from the request body except `priority`, so changing a task's priority via the dashboard task-detail modal had no effect on disk. The handler now accepts `priority`, validates it against the allowed values (`urgent`, `high`, `normal`, `low`) — `null` resets to the default — and forwards it to `store.updateTask`. Combined with the priority-aware merge queue and sweep ordering shipped earlier, dashboard priority changes now actually shift triage, scheduling, and merge order.
- 72ed143: Fix the dashboard usage indicator popup so the footer (Last updated timestamp, Refresh, and Close buttons) is always visible, and make the popup resizable with the size persisted across sessions.

  - Changed the modal/popover to a flex column so the scrollable provider list can shrink while the header and action footer stay pinned. Previously the inner content used `max-height: 60vh` while the popover wrapper capped at 70vh with `overflow: hidden`, which pushed the footer below the visible area on shorter viewports or when many providers were configured.
  - Added native `resize: both` to the desktop popover and modal variants, with sensible min sizes. The popover now anchors via `left` (computed from the trigger button's right edge) instead of `right`, so dragging the bottom-right resize handle behaves as expected.
  - Persist the user's chosen width/height per project in `localStorage` under a new `kb-usage-modal-size` scoped key (debounced via `ResizeObserver`). The saved size is reapplied on next open.

## 0.13.0

### Minor Changes

- d18e411: Add Droid CLI provider integration: new auth and status routes (`GET /api/providers/droid-cli/status`, `POST /api/auth/droid-cli`) plus a Settings toggle hook for enabling Droid CLI–based authentication. Wired into the onboarding provider card so users can connect Droid CLI from the same flow as the other providers.
- d18e411: Add an experimental agent onboarding modal that streamlines the handoff from first-run onboarding into the create-agent form, so new users land on a configured agent draft instead of an empty Settings page. Backed by lifecycle tests and gated behind the experimental flag documented in the onboarding docs.
- 56210e0: Planning sidebar now lists every saved planning session, not just active ones, so a session that finishes while the modal is closed remains selectable on refresh — previously the `/api/ai-sessions` listing filtered out `complete` rows and they vanished from the UI even though the result was still in SQLite. Adds the ability to archive and unarchive completed (or errored) planning sessions: a per-row archive button hides terminal sessions from the sidebar, and a "Show archived" toggle reveals them for unarchive. Backed by a new `ai_sessions.archived` column (migration 57), `POST /api/ai-sessions/:id/archive` and `/unarchive` endpoints (only terminal sessions are archivable so live agents can't be orphaned), and `?includeCompleted` / `?includeArchived` query flags on `GET /api/ai-sessions`. Existing consumers (`useBackgroundSessions`, `MissionManager`) are unchanged — they continue to see only active/retryable sessions.

### Patch Changes

- d18e411: Fix two related CLI-session issues that caused resumed sessions to balloon in size and quick chat to lose continuity:

  - Resumed pi-claude-cli and droid-cli sessions were re-sending the entire conversation transcript over stdin every iteration. `buildResumePrompt` anchored on the last user message and walked forward through preceding tool results, but the only user message stayed at index 0, so each turn duplicated the original query plus a growing stack of tool results into the on-disk session. Anchor on the last assistant message and slice forward instead, so only the genuine delta since the previous turn is sent.
  - Quick chat created a fresh CLI session per user message and faked continuity by stuffing the last 50 messages into the prompt as a "## Previous Conversation" block. Replace that with real session continuity: `chat_sessions` gains a `cliSessionFile` column (migration 56) and ChatManager now reuses the existing pi SessionManager file when present, creating a fresh one on the first turn and persisting its path. The prompt now carries only the new user content.

- 7011831: Replace dashboard runtime dynamic `@fusion/engine` imports with bundler-safe static imports and add regression coverage to prevent reintroduction. This avoids npm-installed runtime failures caused by non-static engine imports that cannot be safely inlined during bundling.

## 0.12.0

### Minor Changes

- cf0ea34: Add a new `fn research` command group for managing research runs from the CLI, including create, list, show, export, cancel, and retry flows with JSON-friendly output options.

### Patch Changes

- bdf91f8: Fix mobile chat view layout when the iOS keyboard is up so the message input stays anchored above the keyboard instead of being pushed to the top of the screen.
- 23134cf: Keep mobile chat composer focused when tapping Send so the keyboard stays open and messages send on the first tap.
- 72dffe4: Fix Quick Chat mobile send button so the first tap while keyboard is open sends the message instead of only dismissing the keyboard.
- 41e5458: Keep the mobile keyboard open in Quick Chat after tapping send so users can continue typing without an extra tap.
- 7f55dde: Preserve Quick Chat input focus on mobile send taps so the keyboard stays open.
- a16ca0a: Seal readonly AI agent sessions so summarizers (title, merge subject, merge body, merge summary) cannot reach host-injected `fn_*` mutation tools or caller-supplied custom tools. Harden all four summarizer system prompts with explicit "do not call tools / treat input as content" framing, wrap the title prompt in a `<description>` delimiter, and sanitize the AI response (strip chatty preambles, markdown emphasis, surrounding quotes, trailing punctuation) before returning. Prevents a class of incidents where the title summarizer would call `fn_task_create` mid-summary and store its chat-style reply as the title.
- ecabab8: Show task provenance as "Created by <agent name>" for agent-created tasks and make the agent name clickable to open the agent detail modal.

## 0.11.0

### Minor Changes

- 28e6819: Add first-class Research configuration and readiness workflows across settings and dashboard surfaces. This introduces scoped Research defaults/overrides, exposes Research in experimental feature toggles, and routes missing-provider/missing-credentials setup through existing Settings and Authentication flows while keeping API keys in auth storage.

### Patch Changes

- 97bb80e: Fix backup routine sync failures on legacy SQLite databases by backfilling missing `routines` columns (including `agentId`) during database initialization. Auto-backup settings now create/update the `Database Backup` routine without logging `table routines has no column named agentId` on upgraded installs.
- 451c6d8: Add read-only `fn_insight_*` pi extension tools so agents can list and inspect persisted insights and recent insight-generation runs directly from the project `InsightStore`.
- 3443aed: Ship a bundled Nerd Font symbols fallback for the dashboard terminal so patched glyphs render even when users do not have a local Nerd Font installed. The dashboard now preloads `/fonts/SymbolsNerdFontMono-Regular.ttf`, applies it first in the xterm font stack, and includes build-output regression checks for the bundled font artifact and preload reference.
- d7fdff4: Move `experimentalFeatures` and `remoteAccess` from project-scoped settings to global-scoped settings, including settings schema/type updates, save-path migration, dashboard routes/UI, and regression coverage updates.
- 13ed470: Fix the mobile QuickChat panel layout when the iOS keyboard opens. The panel now stays anchored to the visible viewport (no off-screen drift on a refocus after the keyboard was dismissed), the soft keyboard reliably comes up the moment the FAB is tapped (a stealth input claims focus inside the user gesture so iOS opens the keyboard even before the real composer is enabled), the panel snaps back to full height immediately on blur instead of trailing the keyboard slide-down, and the model name in the header pill collapses to a provider icon when it would otherwise overflow.
- 40620a9: Keep the terminal modal header on a single row on mobile. The tab bar now flexes to fill remaining width and stays scrollable, while the action cluster pins to the right edge of the same row instead of stacking onto a second row.

## 0.10.0

### Minor Changes

- 3218c05: Add support for custom OpenAI-compatible and Anthropic-compatible API providers. Users can add, edit, and remove custom providers from Settings → Authentication or during model onboarding, with automatic ModelRegistry registration and live updates without restart.
- 3fcf5f4: Detect pre-existing Tailscale funnel sessions in Remote Access settings, surface external tunnel status in `/api/remote/status`, and add a kill-external tunnel endpoint plus Settings UI actions to adopt or restart cleanly.

### Patch Changes

- f7df0d4: Improve mobile keyboard overlap detection so chat layout resizes reliably (including smaller iOS viewport shifts) without pushing fixed app chrome.
- 21402a3: Fix vitest test-harness regressions that masked correct production code as failing tests:

  - Restore `util.promisify(exec)`/`util.promisify(execFile)` to resolve with `{stdout, stderr}` inside the test child-process guard. The previous wrapper dropped the `[util.promisify.custom]` symbol, so awaited `execAsync` resolved to a raw stdout string and broke any test or runtime path that destructured the result (cli `init` git commit flow, core git-remote project-name detection, engine cron-runner / restart / worktree-pool clusters, etc.).
  - Allow cheap CLI introspection invocations (`--version`, `--help`, `which …`) through the AI-CLI block so the dashboard's claude availability probe can tell the truth about the local system. Session-launching invocations (e.g. `claude -p …`, `droid chat`) still throw.
  - Give SIGTERM'd subprocesses a short grace period in the per-test guard's `afterEach` before flagging them as "left running", fixing a race where production code that correctly killed the child was reported as leaking it.
  - Add a test-only `__registerMissionInterviewSessionForTest` helper so SSE replay/buffer tests can exercise the stream manager without spinning up a real AI agent.
  - Fix executor mock to simulate real step-transition semantics (forward moves persist; in-progress regressions on done/skipped steps get rejected) so the new `persistedStatus`-aware response text in `fn_task_update` is exercised correctly.
  - Fix the iOS last-resort path test in `useMobileKeyboard` to actually reach the `gap < 16 && viewportShrink ≥ 16` branch by setting `vv.offsetTop > 0`.
  - Convert `await import("../server.js")` in 14 dashboard route tests to static imports so first-test latency in those files drops from ~2–5s to <200ms.

- 98c3c22: Stop wiping accumulated step progress and the worktree pointer on internal task bounces. Workflow-step REVISE retries, pause→todo handoffs, and the context-overflow fresh-session requeue all moved tasks back to `todo` before returning to `in-progress`, and the default reopen-to-todo path was resetting every step to `pending` and rewriting PROMPT.md checkboxes — so each retry restarted the agent from step 0 even though earlier steps were already done. `moveTask` now accepts a `preserveResumeState` flag that the executor sets on those internal hops; user-initiated "move back to todo" still gets the clean-slate behavior. The context-overflow path additionally clears `sessionFile` synchronously so the next dispatch can no longer reopen the saturated session. `fn_task_update` no longer silently regresses a `done`/`skipped` step to `in-progress`, no longer captures a stale rewind checkpoint when it does, and tells the agent honestly when a regression is ignored. Mobile chat keyboard handling now keeps the layout adjusted on iOS even when the visual-viewport overlap reads as zero (focused input + viewport shrink).
- 491097c: Prefer a Nerd Font-capable monospace stack in the dashboard interactive terminal so powerline/private-use glyphs render correctly when patched fonts are installed, while preserving existing fallback monospace behavior.
- f118606: Stop blocking the Node event loop on every chat send. The pi-claude-cli extension factory used to run two `execSync` probes (`claude --version`, `claude auth status`) on every `createFnAgent` call, which Fusion invokes per chat message — so each send froze every other dashboard API for a few seconds while the Claude CLI cold-started. Probes now run async via `spawn` and are memoized to once per process.

## 0.9.4

### Patch Changes

- 299b66e: Fix InProcessRuntime creating a nested `.fusion/.fusion/fusion.db`. RoutineStore was being constructed with the project's `.fusion` directory, but its constructor appends `.fusion` internally. Pass the project root instead, matching AutomationStore.
- c3c8007: Add ghost-review fallback recovery to the self-healing maintenance loop. Catches any `in-review` task that fell through every more-specific recovery scan and has been idle past `taskStuckTimeoutMs`, kicks it back to `todo` with transient status cleared. Preserves human-handoff (`awaiting-user-review`, `awaiting-approval`) and active-merge (`merging`, `merging-pr`) statuses; rate-limited naturally by `updatedAt` refresh so a re-stuck task can only be kicked once per timeout window.
- 24e142d: Merge commits now get an AI-generated summary subject describing what changed (e.g. `feat(FN-XXXX): add user-invited webhook handler`) instead of the bare `feat(FN-XXXX): merge fusion/fn-XXXX`. The merger calls the existing `summarizeCommitSubject` lane alongside the body summarizer; on failure or when disabled, falls back to the legacy `merge <branch>` form.

  Default for `useAiMergeCommitSummary` is now `true` (was `false`). Existing projects that haven't explicitly set the flag will pick up the new behavior on next start. The Settings UI already exposes the toggle.

## 0.9.3

### Patch Changes

- bb9b0f1: Preserve in-progress card timers and stats across internal workflow rerun bounces.

## 0.9.2

### Minor Changes

- 9e5ac3c: Add an optional `useAiMergeCommitSummary` project setting that enables AI-generated merge commit summaries using the title summarizer model lane, with deterministic fallback when disabled or unavailable.
- 19cdf7f: Add dashboard support for managing custom OpenAI/Anthropic/Google-compatible providers via Settings and onboarding advanced sections, backed by new custom-provider API routes and models.json persistence.
- 7eec105: Heartbeat prompts now re-anchor every tick on a Wake Delta + Heartbeat Procedure (paperclip-parity) so permanent agents stop silently grinding on prior tasks. Each tick the agent receives a structured wake delta (source, wake reason, assigned task, pending messages, triggering comments) and re-runs a 7-step procedure (identity → inbox → wake delta → assignment review → pick action → persist → exit) before continuing prior work.

  The procedure is overridable per agent via a new `heartbeatProcedurePath` field pointing at a project-relative markdown file; the file is reloaded fresh each tick so operators can edit it live without restarting agents. New non-ephemeral agents default to `.fusion/HEARTBEAT.md`, and existing agents can be backfilled onto that path via `POST /api/agents/:id/upgrade-heartbeat-procedure` (also surfaced as an "Upgrade to Default Heartbeat Procedure" button in the agent detail Config tab). The default file is seeded from the built-in template on first use; subsequent edits are preserved.

### Patch Changes

- 6c051b1: Fix the update notification release notes link so it points to the repo changelog.
- 64b5f67: Register custom providers from global settings with the pi ModelRegistry at startup, so they appear as available models without restart.
- cfc8aa3: Fix TUI header overflow when a remote tunnel is configured. Between 100 and 175 columns the remote URL was pushing the left edge (logo + tabs) offscreen; the remote info now lives in a flex-shrinkable, right-justified slot that truncates instead of overflowing. Also gives the QR overlay a solid background so it no longer renders transparent over the underlying TUI.

## 0.9.1

### Patch Changes

- 76deb48: Fix Active Agents panel cards stuck on "Connecting...". Agents in `active` state without a current task have no SSE stream to attach to, so the card now shows "Idle — no task assigned" instead of misleading network copy ("Starting..." for the brief `running`-without-task race). Also fixes a related SSE multiplexer bug: subscribers joining a channel that had already opened never received an `onOpen` callback (EventSource only emits `open` once), leaving them at `isConnected: false` indefinitely whenever another component was already streaming the same task's logs.
- f6242c2: Hoist the Active Agents panel above the main agent list and surface next-heartbeat ETA. Live work now sits directly under the stats bar so it's visible without scrolling past the full agent directory. Each card footer renders "Next heartbeat in Xs" (or "Heartbeat overdue Xs" when the deadline has passed) using the agent's `runtimeConfig.heartbeatIntervalMs` with the dashboard default fallback. Cards also gain pointer cursor + hover/focus styling so the existing click-to-select behavior is discoverable.
- 7e832bb: Clear stale agent task links when tasks become terminal or are deleted, fall back to no-task heartbeat instruction runs for archived assignments, and expand built-in agent prompts with explicit heartbeat guidance.
- 118a03a: Keep experimental dashboard views off by default until project settings enable them.
- 291e156: Improve the Git Manager diff layout and file path truncation in dashboard modals.
- c6d67b9: Insights view: two-pane layout (categories sidebar + scrollable detail), full insight content (no line-clamp), larger action icons, fixed scrolling, and mobile single-row header.
- d8baa7a: Show tasks created from planning sessions on the board immediately without requiring a refresh.

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

- e46f2d4: Add pluggable notification provider system with built-in ntfy and webhook support.
- 17a072c: Add `requirePrApproval` setting (related to [#21](https://github.com/Runfusion/Fusion/issues/21)).

  When `mergeStrategy: "pull-request"`, GitHub's `required: true` flag for status checks only flows from branch protection — a Pro feature on private repos. On free private repos, `isPrMergeReady` reports every fresh PR as immediately mergeable, so `autoMerge: true` causes Fusion to auto-squash-merge the moment the PR opens with no chance for a human to review it.

  The new `requirePrApproval` setting (project-level, default `false`) makes Fusion hold the merge until at least one approving GitHub review is present (`reviewDecision === "APPROVED"`), independent of GitHub's server-side enforcement. Surfaces in the dashboard's Merge settings panel under the Pull Request strategy. Lets you use Fusion's PR mode as "open the PR, wait for me to approve and merge" on any tier.

- 1beebc0: Allow tasks to be respecified from `in-review`. `VALID_TRANSITIONS["in-review"]` now includes `triage`, so the dashboard's `Request AI Revision` and `Rebuild Spec` actions work for in-review tasks. Moving an in-review task to triage performs the same full reset as in-review → todo (clears branch/baseBranch/baseCommitSha/summary/recovery metadata and workflowStepResults) so the next run starts from scratch. The in-review card's `Move` menu also now offers `Planning` as a destination.

### Patch Changes

- 48208db: Surface live run status on Active Agent cards instead of a generic "Connecting…" placeholder. The card now polls the agent's task and shows the current step (e.g. _"Step 5/8: Write Tests"_) and executor model while the SSE log stream warms up. A new "Live logs" button on the card opens the task detail modal directly on the Logs tab.
- a654795: Prefer `merge-base` over potentially stale `baseCommitSha` when resolving task diff bases in the dashboard. Diffs no longer drift when the recorded base commit lags behind the actual divergence point.
- a654795: Show only files actually changed by the task in `ChangesDiffModal` and `TaskChangesTab`. The diff baseline is no longer flooded with files that weren't touched by the task itself.
- a654795: Close executor/merger concurrency races and reviewer pause TOCTOU. Worktree lifecycle is now synchronized more defensively across executor and merger paths, the reviewer pause/unpause flow is hardened against time-of-check/time-of-use races, and `AgentSemaphore` now guards against invalid limits (NaN, Infinity).
- 17a072c: Fix agent heartbeat scheduling so disabled agents stay disabled and active timers are not reset by unrelated agent updates.
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

## 0.8.4

### Patch Changes

- 1c4c08b: Verify and tighten npm bundle fixes from FN-2897: keep the vendored pi-claude-cli runtime on Node built-in child_process APIs (no cross-spawn dependency), confirm Claude CLI extension resolution works from the published dist/pi-claude-cli layout, and ensure prepack strips private @fusion/\* workspace devDependencies from the published package manifest.
- 3202e57: Fix SQLite project and central database validation so dashboard and desktop startup handle corrupt database files more predictably.
- 858e244: Fix the TUI startup update notice to use the same version source and cached update gating as the rest of the CLI.
- 995165e: Fix the dashboard version label so it matches the version used by update notifications.
- bd14cf8: Fix Windows path handling for worktree detection and home-directory lookups.
- 995165e: Fix worktree creation failure when git reports "already checked out at" instead of "already used by worktree at"
- 10d565e: Fix OAuth login redirect for non-localhost dashboard access (Tailscale, Cloudflare, LAN).

## 0.8.3

## 0.8.2

### Patch Changes

- 531b13e: Recover automatically from SQLite FTS5 corruption errors during task upserts by rebuilding the `tasks_fts` index and retrying once. Also adds FTS5 index rebuild/integrity helpers in core database code and extends task store health checks to validate FTS5 integrity.
- 531b13e: Add executor watchdogs to recover stuck `fn_task_done` and workflow rerun handoffs faster.

## 0.8.1

### Patch Changes

- a8dbdbc: Include linked GitHub issue references (`Ref: owner/repo#N`) in executor and merger commit message instructions and merger fallback commits when tasks are sourced from GitHub issues.

## 0.8.0

### Minor Changes

- 58510e1: Add CLI support for multi-node routing: configure project default node (`fn settings set defaultNodeId`), unavailable-node policy (`fn settings set unavailableNodePolicy`), per-task node overrides (`fn task set-node`, `fn task clear-node`), and `--node` flag for `fn task create`.
- 81c6f01: Add node routing policy enforcement: when a task is routed to a node that is offline or unhealthy, the project's `unavailableNodePolicy` setting controls whether execution is blocked (task stays in todo) or falls back to local execution. Supports `defaultNodeId` project setting for pinned default nodes and per-task `nodeId` overrides. Routing decisions are logged to task activity for visibility.
- c9241d8: Add pluggable notification provider system with built-in ntfy and webhook support.
- 22bac2d: Refactor merge conflict strategies into two `smart-*` flavors and change the default to "prefer main".

  Both smart strategies now run a best-effort `git fetch` + fast-forward of local main from `origin` before the merge cascade — a freshly-pushed sibling commit no longer gets clobbered when the fallback resolves a conflict against a stale base. They differ only in the per-file final fallback:

  - **`smart-prefer-main`** (new default): `-X ours` — main wins. Best when concurrent agents could regress just-merged sibling work.
  - **`smart-prefer-branch`**: `-X theirs` — task branch wins. Equivalent to the previous `"smart"` behavior.

  Legacy enum values are accepted for backwards compatibility and normalized at load time: `"smart"` → `"smart-prefer-branch"`, `"prefer-main"` → `"smart-prefer-main"`. Settings on disk continue to work without changes.

### Patch Changes

- f19ecac: Add dedicated POST /api/memory/dream endpoint and triggerMemoryDreams() client helper for manual dream processing.
- cc9181d: Recover automatically from SQLite FTS5 corruption during task upserts by rebuilding the `tasks_fts` index and retrying once, and add FTS5 integrity checks to database health monitoring.
- 5cc7597: Fix npm bundle reliability for the published CLI package by removing the vendored pi-claude-cli `cross-spawn` runtime dependency, validating bundled pi-claude-cli resolution from `dist/`, and preventing private `@fusion/*` workspace dev dependencies from leaking into the packed manifest.
- 2029968: Fix project-level model overrides so they take precedence over the default model fallback consistently across dashboard and engine AI flows.
- cd03c6a: Add runfusion.ai links to dashboard update-available notices in the banner and settings modal.
- 7227b87: Add a retry button to failed task error boxes on dashboard task cards so users can retry directly from the card without opening task details.
- 198f85c: Fix dashboard onboarding: the "Welcome to Fusion" setup wizard is now scrollable on short viewports (older laptops / browsers without `dvh` support), and the model-onboarding modal reliably opens after the wizard closes on a fresh install instead of racing it or being suppressed.

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

### Patch Changes

- ec09282: Add dashboard vitest process controls with a new `POST /api/kill-vitest` endpoint and System Stats modal UI for manual kills plus auto-kill settings management.
- 92b8631: Fix automation execution pipeline reliability by improving ProjectEngine automation startup diagnostics and health visibility, adding due-schedule regression coverage, and fixing manual automation runs to execute ai-prompt and create-task steps (including continueOnFailure handling) instead of command-only behavior.
- 8fbd3bd: Fix plugin-install loader taskStore compatibility by ensuring CLI plugin install paths are covered with regression tests for `getRootDir` expectations.
- 347cae8: Load enabled plugins during dashboard, serve, and daemon startup so plugin runtimes are available to agent runtime selection immediately after boot.
- 0a5dcf1: Fix `/api/system-stats` so process/system metrics still return when project resolution fails, with task and agent aggregates gracefully falling back to zero counts.
- 3c8a490: Fix `fn plugin install` failing in CLI plugin commands by adding `getRootDir()` to the mock TaskStore used by `createPluginLoader`.
- 637f435: Fix pi-claude-cli planning hangs by simplifying custom MCP tool guidance to direct `mcp__custom-tools__*` calls (no `ToolSearch` prerequisite), aligning custom-tool handling diagnostics, and adding regression coverage for `ls`/triage MCP tool mapping behavior.
- 7691bab: Respect globalPause/enginePaused in heartbeat trigger scheduler and monitor to prevent agents from running when the engine is paused at startup.

## 0.6.0

### Minor Changes

- f4d98ed: Add a `--git` flag to `fn init` to auto-initialize a git repository (including an initial commit) when the target directory is not already a git repo.
- 6caab17: Add project settings to auto-comment on imported GitHub issues when tasks move to done, plus dashboard GitHub integration support for posting issue comments.
- fdf8ca9: Reframe the CLI splash to "multi node agent orchestrator" with `runfusion.ai` and the current version, and surface the version alongside URL/host/auth/uptime in the dashboard System panel and status bar.

## 0.5.0

### Minor Changes

- b969635: v0.5.0: status terminology refresh (planning/replan), Reviewer rename, in-review pause behavior, dashboard-tui resize hardening, dev-server experimental toggle fix, and version reporting fix.

### Patch Changes

- 112ad67: Fix experimental feature save normalization so disabling Dev Server clears the legacy `devServer` alias (`null` delete) alongside canonical `devServerView`, preventing stale nav visibility after save.
- 16ec204: Fix dashboard health/version reporting to read the version from package.json instead of relying on npm_package_version with a stale hardcoded fallback.
- 79ce48c: Fix pausing behavior for in-review tasks so stop fully halts merge activity. Paused in-review tasks are now marked with paused status, removed from merge queues, active merge sessions are aborted/disposed, self-healing recovery skips paused tasks, and unpausing re-enqueues eligible review tasks for auto-merge.
- c85ffa9: Rename status values: specifying→planning, needs-respecify→needs-replan. Display label "Triage"→"Planning". Includes DB migration for existing records.
- 03a48ae: Update dashboard and CLI status strings: specifying→planning, needs-respecify→needs-replan. Update user-facing text from "triage/specify" terminology to "planning/replan" terminology.
- c1b0121: Rename "Validator" to "Reviewer" across all dashboard UI labels and descriptions.

## 0.4.1

### Patch Changes

- b5200ba: Add Cloudflare Quick Tunnel mode for Remote Access so Fusion can auto-provision an ephemeral `trycloudflare.com` URL via `cloudflared tunnel --url` without requiring a pre-created named tunnel or tunnel token.
- 8097db2: Rename status values: specifying→planning, needs-respecify→needs-replan. Display label "Triage"→"Planning". Includes DB migration for existing records.

## 0.4.0

### Minor Changes

- 9d8852e: Add project-level overlap ignore paths so teams can exempt safe shared files/directories from overlap-based task serialization while keeping overlap protection enabled for the rest of the repo.

### Patch Changes

- f560af5: Fix dashboard TUI agents view run history rendering to use readable status labels and allow opening selected run logs reliably.
- cd4cef3: Fix dashboard TUI agent run-log opening so Enter key presses sent as carriage-return/newline characters are recognized reliably.
- 7e05a20: Speed up `fn init` project-name detection by skipping git remote lookup when the target directory is not a git repository. This avoids unnecessary subprocess work and reduces timeout risk in test/CI environments.
- c818d71: Inset plugin manager cards from the modal edges on mobile. The plugins subsection panel had no horizontal padding while its heading and toggle were already inset, leaving cards flush with the modal frame on small screens.
- c818d71: Fix triage hangs when using pi-claude-cli with claude-sonnet-4-6. Parameterless custom tools (e.g. `fn_review_spec`) emit zero `input_json_delta` events from the Claude CLI, so the event bridge previously fell through to a raw empty-string fallback and pi's TypeBox validator rejected the call with "root: must be object" — looping the agent indefinitely. Defaults empty `partialJson` to `{}`. Also adds a reminder loop before the planning fallback model engages, propagates the bundled `@runfusion/fusion` extension into engine sessions so `fn_*` tools register without `pi install`, and drops the "historical" qualifier from replayed tool labels that was confusing models into treating their own prior turns as a previous session.
- ff6a68b: Fix Skills Catalog initial-load failures by preventing unauthenticated public search requests for empty or too-short queries. The dashboard now returns a successful empty catalog result for short-query unauthenticated/fallback states instead of surfacing upstream 400 errors.
- 1b3994f: Fix the dashboard terminal modal desktop width contract so large displays use a broad viewport-based layout, and harden terminal input lifecycle handling so xterm keyboard input continues forwarding reliably after rerenders.
- 1a8058f: Make agent pause/resume state transitions act immediately by stopping active heartbeat runs on pause and triggering an on-demand heartbeat on resume.
- 39622f0: Fix scheduled automations so overdue runs catch up reliably after server downtime. Startup/settings sync no longer pushes unchanged overdue schedules into the future, and memory dreams automation is now synchronized during engine startup before cron begins ticking.
- 26f9c74: Synchronize Fusion skill documentation from `extension.ts` across `SKILL.md`, `references/extension-tools.md`, and `references/fusion-capabilities.md`, and document engine session-scoped runtime tools in a new `references/engine-tools.md` reference.

## Unreleased

### Patch Changes

- FN-2501: Agent pause/resume controls now act immediately. Pausing stops an active heartbeat run right away, and resuming to `active` triggers an immediate on-demand heartbeat instead of waiting for the next timer tick.

## 0.2.7

### Patch Changes

- adbad8a: Add `fn plugin add` as a backward-compatible alias for `fn plugin install`, and update plugin command help text to advertise the alias while keeping `install` as the canonical command.

## 0.2.6

### Patch Changes

- dbc9446: Add a blocking dashboard token-recovery dialog that appears only for daemon bearer-token 401 responses, with set-token or clear-token recovery actions that reload the app.

## 0.2.5

### Patch Changes

- 69f789f: TUI: layered defenses for the resize / wrong-height-layout bug

  Materially reduces (but doesn't fully eliminate) the symptom of the header rendering off-screen or the layout taking 1-2 too many rows, especially under tmux/ssh.

  - Enter alternate-screen buffer on start; leave on stop. The TUI gets a dedicated fullscreen surface that doesn't share scrollback.
  - StatusBar Text children no longer wrap (default `wrap="wrap"` was letting long hotkey + URL strings wrap to 2 rows, throwing the row budget off by 1).
  - Controller subscribes to `process.stdout` "resize" and calls `inkInstance.clear()` to reset log-update's frame tracking.
  - App-level resize listener + key-based remount on dimension change so React rebuilds the tree from scratch with fresh bounds.
  - Root Box gets explicit width + overflow="hidden"; MainHeader outer Box too.
  - Settings + Utilities side-by-side now stretch to equal heights (UtilitiesPanel switched from `flexShrink={0}` to `flexGrow={1}`).

## 0.2.4

### Patch Changes

- 88b4ecb: TUI fixes: help overlay no longer crashes, header stays rendered

  - Help overlay (`?` / `h`) crashed with "Encountered two children with the same key" because several shortcut entries share the same display key (`[t]` for Git view AND for Toggle engine pause; `[r]` for Refresh stats AND Refresh agent detail). Switch to index-based keys — each row is unique by position, not by character.
  - Refresh the help text to reflect the unified header (`[m]` Main, `[b/a/g/t/e]` views), the Settings/Files/Agents `←/→` pane swap, the Git push/fetch shortcuts, the Files hidden-files toggle, and the Logs `G` jump-to-end.
  - Main view (status mode) header sometimes vanished after a tmux pane switch and stayed missing until a terminal resize. Two fixes: (a) drop the `rows < 10` auto-hide in `MainHeader` — tmux pane switches can briefly report stale or zero dimensions, and a transient `return null` was orphaning the header. (b) Wrap `MainHeader` and `StatusBar` in `flexShrink={0}` boxes inside `StatusModeGrid` and `StatusModeSingle` (matching the prior fix in `InteractiveMode`), so Yoga can't squeeze them to 0 rows when content pressures the row budget.

## 0.2.3

### Patch Changes

- 0f070d8: TUI header redesign and Settings ←/→ pane navigation

  - Replace the dual section + interactive tab strips with a single unified strip: `[m] Main  [b] Board  [a] Agents  [g] Settings  [t] Git  [e] Explorer`. Status mode highlights the Main pill; interactive views highlight their own. Number-key shortcuts (1–5) for status sections still work but are no longer rendered in the header chrome.
  - Width tiers now fit comfortably at every terminal size: full labels at cols ≥ 90, glyph-only at 50–89 (every shortcut still visible), FUSION + active pill only below 50. Help/quit shows at cols ≥ 110.
  - New `m` shortcut switches to status mode (Main); `s` kept as alias.
  - Settings interactive view: `←` focuses the list pane, `→` focuses the detail pane. `Tab` still cycles either way (consistent with Agents view).

## 0.2.2

### Patch Changes

- 58688fa: Keep the FUSION header from wrapping when the terminal is narrow. The `MiniLogo` and tab pills had Yoga's default `flexShrink: 1`, so the row's collective content overrunning the width was being absorbed by shrinking every child — including FUSION, which then wrapped to two lines. Pin all fixed-content header children to `flexShrink={0}`; the trailing flexGrow filler absorbs slack instead.

## 0.2.1

### Patch Changes

- 07d7bac: Add a blocking dashboard token-recovery dialog that appears only for daemon bearer-token 401 responses, with set-token or clear-token recovery actions that reload the app.

## 0.2.0

### Minor Changes

- a8f5591: Add support for an optional custom ntfy server URL in notification settings, with default fallback to `https://ntfy.sh` when unset.

## 0.1.3

### Patch Changes

- c105cfa: Automatically install the bundled Fusion skill into supported agent home directories during `fn init` (`~/.claude/skills/fusion`, `~/.codex/skills/fusion`, and `~/.gemini/skills/fusion`) when missing. Existing installs are preserved, and per-target filesystem errors now warn without failing project initialization.
- 86521e2: Fix `pnpm install -g @runfusion/fusion` failing with a 404 for `@fusion/pi-claude-cli`. The vendored pi extension is now bundled into the published package's `dist/pi-claude-cli/` and is no longer listed as an external dependency.
- 76961d4: Add a severity filter to the interactive `fn dashboard` TUI Logs tab. Users can now press `f` to cycle `all → info → warn → error` for view-only filtering while preserving the full in-memory ring buffer.
- f77dd9d: Prevent stale dashboard service workers from trapping old client bundles, and compute automation cron schedules against UTC so monthly runs stay on day 1 across timezones.
- f4d2a4b: Fix `fn dashboard` Logs tab row budgeting so log lines stay above the footer hint on short terminals, including wrapped-message cases.
- f77dd9d: Fix dashboard SSE cleanup on browser refresh so stale event streams do not exhaust per-origin browser connections.
- 31f021a: Fix dashboard TUI log severity rendering so structured `logger.log(...)` entries routed via `stderr` display with info severity/icon instead of being misclassified as errors.
- eef56af: Normalize Fusion skill-facing tool naming to the public `fn_*` namespace and clarify the boundary between extension tools and internal engine runtime tools across skill docs.
- 832c32c: Refresh the shipped Fusion skill documentation to match the current `fn_*` extension and CLI surfaces, and replace stale kb-era task/storage examples with Fusion-native `FN-*` and `.fusion` conventions.
- dce70bf: Persist `fn dashboard` bearer tokens in the existing global settings store (`~/.fusion/settings.json`) on first authenticated run, then reuse them on subsequent starts. Explicit overrides (`--token`, `FUSION_DASHBOARD_TOKEN`, `FUSION_DAEMON_TOKEN`) and `--no-auth` precedence remain intact.
- f078a4e: Add a Settings → Pi Extensions action to reinstall Fusion's bundled Pi package (`npm:@runfusion/fusion`) for self-serve recovery when local Pi skill installs are stale or broken.

## 0.1.2

### Patch Changes

- 9bf2981: Add a `planning-awaiting-input` ntfy notification event so users can opt in to alerts when planning sessions pause for user input.
- Fix the CLI init command import path for the Claude skills runner so tsup can resolve it during build.
- 94473c8: Improve dashboard shutdown observability by logging non-fatal diagnostics when `CentralCore.close()` fails during dispose, normal signal shutdown, or dev-mode shutdown cleanup.
- Fix dashboard and serve command plugin store initialization to support task store implementations that expose `getFusionDir()` without `getRootDir()`.
- c01892d: Route dashboard runtime diagnostics through the shared injected runtime logger so TTY sessions can capture server/package logs in the TUI while preserving readable non-TTY startup banner output.

## 0.1.1

### Patch Changes

- 39f7709: Dashboard TUI now surfaces engine log output in the Logs tab. Previously, the engine's `createLogger()` writes (scheduler, executor, triage, merger, PR monitor, heartbeat, etc.) went straight to `console.error` and were rendered beneath the alt-screen TUI — effectively invisible. `DashboardLogSink.captureConsole()` now intercepts `console.log/warn/error` while the TUI is running and routes each line into the ring buffer, parsing a leading `[prefix]` tag so entries carry the subsystem prefix. Originals are restored on TUI shutdown.
- 585e480: Add keyboard navigation and inspection features to the Dashboard TUI Logs tab: arrow keys and j/k to navigate entries, Enter to expand selected entry, Esc to close expanded view, and w to toggle wrap mode for long messages.
- 86fd24e: `fn dashboard` TTY mode now opens on the System tab first so users immediately see host, port, URL, and auth token access details.
- 585e480: Fix dashboard TUI log navigation: add Home/End shortcuts for jumping to first/last log entry, add Space and e keys as alternatives to Enter for expanding logs, improve word wrap to handle long unbroken tokens (URLs, stack traces) by hard-wrapping them at terminal width.
- 7d31b21: Fix iOS terminal typing in the dashboard. On touch-primary devices, tapping the terminal opened the on-screen keyboard but keystrokes were silently dropped because the bubble-phase `handleTerminalGestureFocus` handler re-focused the helper textarea and reset its selection during touchstart/pointerdown, disrupting iOS's input-event attribution. The CSS fix in commit c7266b7f already positions the textarea to receive taps natively, so the JS handler is now a no-op on `(hover: none) and (pointer: coarse)` devices and desktop retains click-to-focus.
- Fix dashboard TUI log viewport row calculation on very small terminals to prevent log lines from overlapping the footer.
- ff5df16: Fix executor model resolution precedence so project `defaultProviderOverride`/`defaultModelIdOverride` is honored before falling back to global `defaultProvider`/`defaultModelId` across execute, hot-swap, and step-session paths.
- df2836c: Fix dashboard TUI log behavior so log navigation can reach all entries still present in the ring buffer and streamed merge output is buffered into log lines instead of writing raw fragments into the interactive terminal UI.
- bbdd11a: Guard SQLite FTS5 usage so Fusion starts cleanly on Node builds whose bundled `node:sqlite` was compiled without FTS5. On affected systems, `fn dashboard` previously crashed on first run with `Error: no such module: fts5` during schema migration. The Database and ArchiveDatabase now probe for FTS5 at startup and skip the virtual table + triggers when unavailable; `TaskStore.searchTasks` and `ArchiveDatabase.search` fall back to LIKE-based scans. Set `FUSION_DISABLE_FTS5=1` to force the fallback on runtimes where FTS5 is present but undesirable.
- 0bb0100: Update dashboard TUI header branding from "fn board" to "fusion" for consistent product naming.

## 0.1.0

### Minor Changes

- 25d44e1: Add interactive TUI to `fn dashboard` with five navigable sections: logs, system, utilities, stats, and settings. Keyboard shortcuts enable quick in-terminal navigation (1-5, arrows, q, Ctrl+C, ? for help). The TUI activates automatically in interactive terminal sessions; non-TTY mode (CI, piped output) retains the existing plain-text banner/log behavior.

### Patch Changes

- a2ed6d0: Fixes for stuck merges and agent lifecycle controls.

  - `findLandedTaskCommit` now falls back to scanning all of `HEAD` when the bounded `baseCommitSha..HEAD` range returns no commits (e.g. baseCommitSha was advanced past the landed merge by a fast-forward rebase). Previously the recovery silently returned null and re-queued the merge even though the commit had already landed.
  - Agent heartbeat triggers and registration are gated by `runtimeConfig.enabled` rather than transient agent state, so paused/idle/error agents stay registered for triggers and re-arm immediately on resume without waiting for a state transition.
  - `AgentDetailView` exposes a Stop control alongside Pause/Retry for `running` and `error` states so operators can terminate stuck agents without going through the agents list.

## 0.0.6

### Patch Changes

- Re-ship three previously reverted fixes and add pre-merge remote rebase.

  - `--no-auth` flag now correctly suppresses bearer-token auth instead of being silently overridden by a stale `FUSION_DAEMON_TOKEN` in the project's `.env`.
  - Workflow-review revisions reopen only the last step rather than resetting every previously-completed step. The agent applies the feedback as an in-place fix and earlier approved work stays done. New `reopenLastStepForRevision` helper is used by `handleWorkflowRevisionRequest`, `handleWorkflowStepFailure`, and `sendTaskBackForFix`. `determineRevisionResetStart` is marked `@deprecated` and kept exported for tests.
  - Heartbeat scheduling is now driven by `agent.state` (`active`/`running` = timer armed; everything else = timer cleared), not `runtimeConfig.enabled`. Resuming a paused agent through the dashboard now re-arms the timer immediately.
  - New setting `worktreeRebaseBeforeMerge` (default `true`) and companion `worktreeRebaseRemote` (default: git's configured default). The merger fetches the remote and rebases the task branch onto the latest default-branch tip before merging; conflicts flow into the existing smart/AI resolve cascade. Dashboard Settings → Worktrees exposes a checkbox and a remote dropdown populated from `/api/git/remotes/detailed`.
  - Last/Next heartbeat labels on the agent list card now share font-size and inline-flex alignment so they line up cleanly.

## 0.0.5

### Patch Changes

- 41553a5: Harden agent lifecycle around closed tasks and heartbeat defaults.

  - `HeartbeatMonitor.executeHeartbeat()` now exits before session creation when the resolved task is done/archived (reason `task_closed`) and clears the stale `agent.taskId` linkage so the guard isn't re-tripped on every tick.
  - `HeartbeatTriggerScheduler.watchAssignments()` skips callback dispatch when the assigned task is already closed (when a `taskStore` is wired in).
  - `POST /api/agents/:id/runs` performs the same preflight check and returns 409 with a structured error naming the task id + column, keeping the existing active-run 409 precedence.
  - `AgentStore.createAgent()` now persists `runtimeConfig.heartbeatIntervalMs` (default 1h) on non-ephemeral agents so the dashboard's freshness signal matches the scheduler's effective cadence instead of depending on whether the user ever opened the heartbeat dropdown. Exports a new `DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS` constant.

## 0.0.4

### Patch Changes

- 0da498a: Fix dashboard onboarding auth token controls, keep the AI planning modal footer visible on desktop, and add better terminal PTY spawn diagnostics.

## 0.0.3

### Patch Changes

- 1fc72d1: Improve the dashboard agents list views with shared empty-state actions, token-based state styling, and clearer board/tree/org-chart presentation.
- 46b8032: Make `fn agent import` import package skills alongside agents when importing from directory or archive sources. Skills are written to `{project}/skills/imported/{company-slug}/{skill-slug}/SKILL.md` with proper frontmatter formatting. Existing skill files are skipped rather than overwritten. Single AGENTS.md file imports do not include package skills.
- c1bc5b9: Fix CLI merge regressions in test/build verification: restore gh-cli test alias resolution, ensure daemon ignores invalid env tokens, and restore required changeset config.
- 06704cf: Fix the setup wizard directory browser and make terminal session startup more resilient.

## 0.0.2

### Patch Changes

- Add `fusion` bin alias so `npx @runfusion/fusion` resolves to the CLI
  (the `fn` command is still available and unchanged).

## 0.0.1

### Initial release

First public release under the `@runfusion` scope. Package was previously
developed under the `@gsxdsm/fusion` name; it was never published to npm,
so version history resets with `0.0.1`. Pre-release notes preserved below
for reference.

---

## 0.4.0 (pre-release, unpublished)

### Minor Changes

- 2d13b82: Add pi extension. Installing `@runfusion/fusion` via `pi install` now provides native tools (`fn_task_create`, `fn_task_list`, `fn_task_show`, `fn_task_attach`, `fn_task_pause`, `fn_task_unpause`) and a `/fn` command to start the dashboard and AI engine from within a pi session.
- 494de14: Changed `autoMerge` to default to `true` for new boards.
- 50821fc: Add global pause button to stop all automated agents and scheduling
- cac10af: Split engine control into Pause (soft) and Stop (hard). The dashboard Header now shows two buttons: "Pause AI engine" stops new work from being dispatched while letting in-flight agents finish gracefully, and "Stop AI engine" (previously the only Pause button) immediately kills all active agent sessions. A new `enginePaused` setting field controls the soft-pause state alongside the existing `globalPause` hard-stop.

### Patch Changes

- d19b51f: Auto-assign random port when dashboard port is already in use instead of crashing with EADDRINUSE.
- ceb379d: Engine pause now terminates active agent sessions (matching global pause behavior) instead of letting them finish gracefully. Tasks are moved back to todo/cleared for clean resume on unpause.
- acb246a: Fix active agent glow disappearing when scheduling is soft-paused
- 43aada5: Fix scheduler to not count in-review worktrees against maxWorktrees limit. In-review tasks are idle (waiting to merge) and no longer block new tasks from starting.
- 9033a79: Fix InlineCreateCard cancelling when clicking dependency dropdown items with empty description.
- 96f1070: Fix double horizontal scrollbar on mobile board view by switching the board from a 5-column grid to a flex layout on narrow viewports (≤768px) with snap-scrolling.
- 3dc741c: Fix auto-pause on rate limit when pi-coding-agent exhausts retries. After `session.prompt()` resolves with exhausted retries, all four agent types (executor, triage, merger, reviewer) now detect the error on `session.state.error` and trigger `UsageLimitPauser` to activate global pause. Previously, rate-limit errors that pi-coding-agent handled internally were silently swallowed, causing tasks to be promoted to wrong columns with incomplete work.
- 2854553: Fix triage allowing tasks to reach executor before spec review approval
- 72a8953: Fix specifying agents not respecting maxConcurrent concurrency limit
- a2a12f9: Persist worktree pool across engine restarts. When `recycleWorktrees` is enabled, idle worktrees are rehydrated from disk on startup instead of being forgotten. When disabled, orphaned worktrees are cleaned up automatically.
- 65b9585: Add priority-based agent scheduling: merge agents are served before execution agents, which are served before specification agents, when competing for concurrency slots.
- 98ed082: Restructure README to lead with pi extension usage; move standalone CLI docs to STANDALONE.md.
- 2d13b82: Agents now declare dependencies when creating multiple related tasks during execution
- 0e0643a: Skip merger agent when squash merge stages nothing (branch already merged via dependency)
- d2e2e50: Make "Pause AI engine" a soft pause: only prevents new agents from starting while allowing currently running agents to finish their work naturally. "Stop AI engine" (global pause) still immediately terminates all active agents.
- 90764b9: Auto-pause engine when API usage limits are detected (rate limits, overloaded, quota exceeded). Prevents wasteful retries across concurrent agents.

## 0.3.1

### Patch Changes

- ae90be0: Bundle workspace packages into CLI for npm publish. The published package previously declared dependencies on private `@kb/core`, `@kb/dashboard`, and `@kb/engine` workspace packages, causing `npm install` to fail. Switched the CLI build from `tsc` to `tsup` (esbuild) to inline all `@kb/*` workspace code into a single bundled `dist/bin.js`, while keeping third-party packages (`express`, `multer`, `@mariozechner/pi-ai`) as external dependencies. Dashboard client assets are now copied into `dist/client/` so the published tarball is fully self-contained.
- 28bbcb9: Exclude Bun-compiled platform binaries from npm publish tarball, reducing package size significantly.

## 0.3.0

### Minor Changes

- fc7582d: Expand agent.log logging to all agent types, additionally capturing thinking, and agent roles
- cc999ef: RETHINK verdicts trigger git reset and conversation rewind, re-prompting the agent with feedback

### Patch Changes

- f3c7f7d: CLI `task create` now supports a `--depends <id>` flag (repeatable) to declare task dependencies at creation time.
- fc7582d: Code review REVISE verdicts are now enforced such that agents can no longer advance steps without APPROVE
- cc999ef: Plan RETHINK triggers conversation rewind with REVISE enforcement on code reviews
- cc999ef: Dependent tasks can start from in-review dependency branches instead of waiting for merge

## 0.2.1

### Patch Changes

- efdb7de: Clean up README: plain ASCII file tree, mermaid workflow diagram with column descriptions, update quick start to use `kb` CLI, add authentication section to CLI README, document cross-model review in executor description.

## 0.2.0

### Minor Changes

- b12d340: Add automated versioning pipeline using changesets. Developers now add changeset files to describe changes, and a CI workflow automatically opens version PRs that bump versions and generate changelogs.
