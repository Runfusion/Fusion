# Self-Healing Backward-Move Audit (FN-5335)

## Invariant
Backward lifecycle moves (in-progress → todo, in-review → in-progress/todo, in-review → paused-stuck/failed) from a maintenance sweep require **triple proof**:
1. Verified dead session — no active session registry entry for any `pathsForTask(taskId)`, no `executingTaskLock.has(taskId)`, and `this.options.isTaskActive?.(taskId) !== true`.
2. Unusable worktree — `classifyTaskWorktree(this.options.rootDir, task.worktree)` returns `{ ok: false }`, OR `task.worktree` is null and there is no registered `fusion/<id>` worktree.
3. No recent executor activity — stage staleness anchor exceeds stage grace window and there is no recent `worktree:incomplete-detected` event within the same trailing window.

Stages that cannot satisfy all three must either (a) tighten predicate to require triple proof, or (b) downgrade to annotation-only (`task:<stage>-no-action`).

## Catalog
| Method | Source line | Trigger condition | Grace source | Evidence required today | Action today | Direction | Disposition | New evidence required | New action |
|---|---:|---|---|---|---|---|---|---|---|
| recoverCompletedTasks | 1455 | in-progress + all steps terminal | n/a | step completion | move to in-review | FORWARD | keep | n/a | n/a |
| recoverStrandedCompletedTodoTasks | 1507 | todo + all steps terminal | n/a | step completion | move to in-progress (resume) | FORWARD | keep | n/a | n/a |
| recoverStaleMergingStatus | 1557 | in-review stale merging status | `staleMergingStatusMinAgeMs` | stale status + no active merge | clear status | RECONCILE-ONLY | keep | n/a | n/a |
| reclaimPrConflicts | 1606 | PR mergeable=conflicting | path-dependent | conflict inspect result | delegates to reclaimPrConflictForTask | RECONCILE/BACKWARD mix | keep | n/a | n/a |
| reclaimPrConflictForTask | 1622 | reclaimable conflicting PR branch | inspectConflict + usable worktree checks | active-session/usable-worktree checks only | may move in-review→todo | BACKWARD | tighten | triple proof on in-review→todo path | gate move; emit `task:reclaim-pr-conflict-no-action` |
| reclaimSelfOwnedBranchConflicts | 1772 | branch conflict self-owned | conflict inspector local checks | conflict classifier only | may move in-review→todo | BACKWARD | tighten | triple proof before backward move | gate move; emit `task:reclaim-self-owned-branch-conflict-no-action` |
| reclaimStaleActiveBranches | 2174 | stale active branch metadata | `STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS` | age + no active session + no local changes | metadata clear/prune | RECONCILE-ONLY | keep | n/a | n/a |
| reconcileCompletedTask | 2438 | done fanout cleanup | n/a | dependency unblock checks | blocker/status metadata updates | RECONCILE-ONLY | keep | n/a | n/a |
| reconcileInReviewBranchRebind | 2646 | in-review missing branch metadata | n/a | unique candidate branch proof | branch metadata rebind/clear | RECONCILE-ONLY | keep | n/a | n/a |
| reconcileTaskWorktreeMetadata | 2815 | stale task.worktree metadata | mixed (includes stale merge thresholds) | registered-worktree reconciliation | metadata fixes (+ targeted no-op move hygiene) | RECONCILE-ONLY | keep | n/a | n/a |
| autoReboundPausedScopeDecayDetailed | 2922 | paused in-progress scope holder stale beyond decay threshold | `settings.pausedScopeDecayMs` | age + scoped follower count | move to todo (preserve progress/worktree/resume state) | BACKWARD | tighten | triple proof + existing decay predicates | gate move; emit `task:auto-rebound-scope-decay-no-action` |
| surfaceDbCorruption | 3259 | db corruption marker | notification cooldown | db marker presence | notify/log | ANNOTATION-ONLY | keep | n/a | n/a |
| reconcileSelfDefeatingDependencies | 3499 | dependency self-loop | n/a | graph proof | dependency metadata repair | RECONCILE-ONLY | keep | n/a | n/a |
| reconcileDependencyCycles | 3557 | persisted dependency cycle | n/a | cycle detector | selective dependency edge repair | RECONCILE-ONLY | keep | n/a | n/a |
| reconcileStaleMergerStatus | 3702 | stale merger status | `staleMergingStatusMinAgeMs` | age/no active merge | clear status | RECONCILE-ONLY | keep | n/a | n/a |
| finalizeNoOpReviewTasks | 3750 | in-review already-on-main no-op | git landed proof | landed/no-op proof | mostly in-review→done; one in-review→todo remediation path | FORWARD + BACKWARD edge | tighten (backward edge only) | triple proof for fallback in-review→todo path | gate fallback; emit `task:finalize-no-op-review-no-action` |
| reconcileDoneTaskIntegrity | 3870 | done task integrity mismatch | n/a | integrity check | metadata/status hygiene | RECONCILE-ONLY | keep | n/a | n/a |
| recoverMergeableReviewTasks | 3996 | mergeable in-review task | merge blocker checks | merge readiness | queue/merge status writes | INTERNAL-RETRY | keep | n/a | n/a |
| recoverReviewTasksWithFailedPreMergeSteps | 4112 | failed pre-merge workflow step | maxFix budget | failed step + budget | revive via executor | INTERNAL-RETRY | keep | n/a | n/a |
| recoverStaleIncompleteReviewTasks | 4205 | in-review with incomplete steps stale | `settings.taskStuckTimeoutMs` | age + incomplete steps | move to todo preserveProgress | BACKWARD | tighten | triple proof + existing stale/incomplete predicates | gate move; emit `task:stale-incomplete-review-no-action` |
| surfaceInReviewStalls | 4281 | in-review stall reasons | `settings.taskStuckTimeoutMs`, `inReviewStallDeadlockThreshold` | stall signal + repetition | log; deadlock branch pauses/failed | BACKWARD branch | already-tightened (threshold + FN-5147) | keep existing | no change |
| surfaceDependencyBlockedTodos | 4390 | blocked todo report | reporter internals | blocked dependency snapshot | report/log | ANNOTATION-ONLY | keep | n/a | n/a |
| surfaceInReviewStalled | 4416 | quiet in-review backlog signal | `settings.inReviewStalledThresholdMs` | quiet-window signal | log only | ANNOTATION-ONLY | keep | n/a | n/a |
| surfaceStalePausedReviews | 4478 | stale paused in-review | `settings.stalePausedReviewThresholdMs` | age signal | log only | ANNOTATION-ONLY | keep | n/a | n/a |
| surfaceStalePausedTodos | 4529 | stale paused todo | `settings.stalePausedTodoThresholdMs` | age signal | log only | ANNOTATION-ONLY | keep | n/a | n/a |
| recoverGhostReviewTasks | 4583 | idle in-review ghost | `settings.taskStuckTimeoutMs` | idle + status filters | move to todo preserveProgress | BACKWARD | tighten | triple proof + existing ghost predicates | gate move; emit `task:ghost-review-no-action` |
| recoverInterruptedMergingTasks | 4650 | stale transient merging status | `settings.taskStuckTimeoutMs` | stale status + landed-commit detection | done finalize or status clear/requeue | FORWARD/INTERNAL-RETRY | keep | n/a | n/a |
| recoverDoneTaskMergeMetadata | 4777 | done merge metadata drift | n/a | landed evidence + metadata gap | metadata update | RECONCILE-ONLY | keep | n/a | n/a |
| recoverMergedReviewTasks | 4937 | in-review already merged | landed commit proof | landed proof | move to done | FORWARD | keep | n/a | n/a |
| recoverStuckMergeDeadlocks (landed) | 5036 | retry-exhausted merge failed but landed | cooldown + retries | landed proof | move to done + unblock deps | FORWARD | keep | n/a | n/a |
| recoverStuckMergeDeadlocks (no-landed) | 5036 | retry-exhausted merge failed and not landed | `DEADLOCK_RECOVERY_COOLDOWN_MS` | no landed proof only | `updateTask({ paused: true })` + log | BACKWARD | tighten | triple proof before pause/fail disposition | gate pause; emit `task:stuck-merge-deadlock-no-action` |
| recoverOrphanOnlyScopeViolations | 5192 | failed scope-only orphan but landed | landed proof | parsed scope payload + landed proof | move to done or failed-blocked | FORWARD/RECONCILE | keep | n/a | n/a |
| recoverAlreadyMergedReviewTasks | 5350 | retry-exhausted failed review but landed | retries threshold | landed proof | move to done | FORWARD | keep | n/a | n/a |
| recoverCompletionHandoffLimbo | 5473 | in-review no handoff state after task_done | `COMPLETION_HANDOFF_LIMBO_GRACE_MS` | done-marker age + no active task + merge blocker absent + retry cap | requeue merge or fail-exhausted | already proof-gated | already-tightened (FN-4999) | keep | no change |
| recoverBranchMisboundInReviewTasks | 5581 | in-review failed merge lineage misbound but landed | retries threshold | classifyOwnedLandedEvidence proof | move to done | FORWARD | keep | n/a | n/a |
| recoverForeignOnlyContaminatedInReviewTasks | 5692 | foreign-only contamination | retries/config gates | contamination attribution proof | reanchor/requeue or annotate | INTERNAL-RETRY | keep | n/a | n/a |
| recoverMisclassifiedFailures | 5789 | in-review failed but no merge blocker and all steps done | n/a | completed steps + no blocker | clear status/error | RECONCILE-ONLY | keep | n/a | n/a |
| recoverInProgressLimbo | 5877 | in-progress no branch + missing/none worktree + pending steps | `ORPHANED_EXECUTION_RECOVERY_GRACE_MS` | dead/no-progress proof set | move to todo preserveProgress | BACKWARD | already-tightened (FN-5219) | keep | no change |
| recoverOrphanedExecutions | 5991 | stale in-progress no active execution | `ORPHANED_EXECUTION_RECOVERY_GRACE_MS` / `ORPHANED_WITH_WORKTREE_GRACE_MS` | stale orphan candidate only | annotation event only | ANNOTATION-ONLY | already-tightened (FN-5337) | keep | no change |
| recoverAgentsRunningOnInactiveTasks | 6089 | agent runtime drift | agent heartbeat ages | agent-store runtime checks | end/restart agents | RECONCILE-ONLY | keep | n/a | n/a |
| recoverDriftedAgentTaskLinks | 6126 | agent assigned to terminal/missing task | n/a | task-link mismatch | clear assignment | RECONCILE-ONLY | keep | n/a | n/a |
| recoverOrphanedAgents | 6180 | dead parent/direct-report linkage | n/a | org topology checks | pause/delete/reparent decisions | RECONCILE-ONLY | keep | n/a | n/a |
| recoverStaleHeartbeatRuns | 6372 | stale heartbeat run records | run age thresholds | pid/age mismatch | terminate run records | RECONCILE-ONLY | keep | n/a | n/a |
| recoverNoProgressNoTaskDoneFailures | 6451 | in-progress failed no-task-done no progress | implicit (no explicit grace) | no-step-progress + no git work + not executing | clear metadata + move to todo | BACKWARD | tighten | triple proof + no-progress checks + recent liveness-audit absence | gate move; emit `task:no-progress-no-task-done-no-action` |
| recoverMissingWorktreeReviewFailures | 6516 | in-review failed OR merge-active (`merging`/`merging-pr`/`merging-fix`) session-start missing/unusable worktree | classifier-based | error classifier proof only | autoRecover requeue to todo | BACKWARD | tightened | triple proof + classifier proof + `allowsAutoMergeProcessing` + workspace-task exclusion | gate requeue; emit `task:missing-worktree-review-no-action` or `task:reconcile-missing-worktree-merge-active-no-action`; successful merge-active recovery clears `worktree`/`branch`/`sessionFile`, resets the worktree-session retry budget, increments `recoveryRetryCount` as the bounded stale-metadata clear counter, emits `task:reconcile-missing-worktree-merge-active`, and requeues to todo preserving progress |
| recoverPartialProgressNoTaskDoneFailures | 6586 | in-review failed no-task-done with partial progress | bounded by `MAX_TASK_DONE_RETRIES` | no-task-done + partial progress + retry budget | clear error + move to todo preserveProgress | BACKWARD | tighten | triple proof + retry-budget predicates | gate move; emit `task:partial-progress-no-task-done-no-action` |
| recoverApprovedTriageTasks | 6706 | triage planning specified stale | `APPROVED_TRIAGE_RECOVERY_GRACE_MS` | planning idle + valid PROMPT.md | recoverApprovedTriageTask callback | FORWARD | keep | n/a | n/a |
| recoverStarvedRefinementTriageTasks | 6827 | refinement planning stale | `STARVED_REFINEMENT_RECOVERY_GRACE_MS` | no progress idle | requeue/annotation in triage | RECONCILE-ONLY | keep | n/a | n/a |
| recoverOrphanedPlanningTasks | 6940 | planning-status tasks drifted | `APPROVED_TRIAGE_RECOVERY_GRACE_MS` | planning drift + inactive | clear planning status | RECONCILE-ONLY | keep | n/a | n/a |

## Per-stage rationale
### recoverStaleIncompleteReviewTasks
- Current evidence is age + incomplete steps only; this can race live executor/session churn.
- Tighten chosen: preserve recovery semantics but require dead-session + unusable-worktree + stale activity proof.
- Composes with FN-5147 first (autoMerge false short-circuit), then FN-5335 proof gate.

### recoverGhostReviewTasks
- Current evidence is idle age + status exclusion; no hard proof task is dead.
- Tighten chosen to avoid speculative in-review→todo regressions.

### reclaimPrConflictForTask / reclaimSelfOwnedBranchConflicts
- These can push in-review backward to todo on conflict reclaim paths.
- Tighten chosen for backward path only; forward/metadata-only branches unchanged.

### finalizeNoOpReviewTasks (fallback backward edge)
- Method is mostly forward finalize; fallback requeue path can move backward.
- Tighten only that branch.

### recoverStuckMergeDeadlocks (no-landed branch)
- Existing no-landed path pauses immediately after failed landed-proof.
- Tighten chosen: pause/fail mutation requires triple proof; otherwise annotate and leave terminal state untouched.

### recoverNoProgressNoTaskDoneFailures
- Current predicate checks progress/git cleanliness but not session/worktree/liveness triple-proof.
- Tighten to prevent reopening actively recovering tasks and to compose with FN-4935 recent liveness events.

### recoverMissingWorktreeReviewFailures
- Existing classifier proof is necessary but not sufficient for backward movement.
- Tightened: require full triple-proof before auto requeue, and keep `allowsAutoMergeProcessing` as the first lifecycle gate so `autoMerge:false` remains terminal-until-merged.
- Merge-active rows (`merging`, `merging-pr`, `merging-fix`) with the same unusable-worktree session-start signature are now owned here before interrupted/deadlocked merge sweeps can re-drive the phantom path. Workspace tasks are annotation-only in this path; per-repo land recovery remains workspace-owned.

### recoverPartialProgressNoTaskDoneFailures
- Retry-budget alone can still reopen tasks under active/residual execution races.
- Tighten: add triple-proof gate before each requeue.

### surfaceInReviewStalls deadlock branch
- Classified BACKWARD but retained as already-tightened due explicit deadlock threshold + FN-5147 terminal-until-merged guard contract.

## Stages explicitly left alone
- Forward-only: `recoverCompletedTasks`, `recoverStrandedCompletedTodoTasks`, `recoverMergedReviewTasks`, `recoverAlreadyMergedReviewTasks`, `recoverBranchMisboundInReviewTasks`, `recoverOrphanOnlyScopeViolations`.
- Already-tightened proof owners: `recoverInProgressLimbo` (FN-5219), `recoverCompletionHandoffLimbo` (FN-4999), `recoverOrphanedExecutions` (FN-5337 `task:orphan-detected-no-action`).
- RECONCILE/annotation-only stages remain unchanged.

## Step 1 self-check coverage
Executed mutation-scan `grep -nE 'moveTask\(.*"todo"|moveTask\(.*"in-progress"|updateTask\(.*paused:\s*true|status:\s*"failed"' packages/engine/src/self-healing.ts` and confirmed every mutation site is represented above with explicit direction + disposition (including `autoReboundPausedScopeDecayDetailed`, `surfaceInReviewStalls` deadlock branch, and `recoverStuckMergeDeadlocks` no-landed pause branch).

## Open questions / out-of-scope
- None discovered in Step 1 requiring separate task creation.
