/**
 * Engine run-audit instrumentation helpers.
 *
 * Provides a shared layer for emitting run-audit events from heartbeat execution,
 * task execution, and merge operations. Uses the core TaskStore APIs introduced
 * by FN-1403 for event persistence.
 *
 * ## Run Context
 *
 * Every active run (heartbeat, executor, merger) has an associated run context
 * that enables correlation of mutations back to the specific run that caused them:
 *
 * ```typescript
 * interface EngineRunContext {
 *   runId: string;           // Stable run identifier (heartbeat run ID, or synthetic for executor/merger)
 *   agentId: string;          // Agent performing the mutation
 *   taskId?: string;          // Task being operated on (if applicable)
 *   phase?: string;           // Execution phase: "heartbeat", "execute", "merge-attempt-N"
 *   source?: string;          // Invocation source: "timer", "on_demand", "assignment", etc.
 * }
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * // Create auditor with a run context (no-ops if context is null/undefined)
 * const auditor = createRunAuditor(store, runContext);
 *
 * // Emit audit events for different mutation domains
 * await auditor.git({ type: "branch:create", target: branchName });
 * await auditor.database({ type: "task:update", target: taskId });
 * await auditor.filesystem({ type: "file:write", target: filePath });
 * ```
 *
 * ## Backward Compatibility
 *
 * All audit functions are no-ops when:
 * - The auditor was created with a null/undefined context
 * - The TaskStore doesn't have `recordRunAuditEvent` (not yet migrated)
 *
 * This ensures manual/non-run paths are unaffected by audit instrumentation.
 */

import type { TaskStore, RunAuditEventInput } from "@fusion/core";

/** Structured context for a run correlation ID. */
export interface EngineRunContext {
  /** Stable run identifier. For heartbeat runs, this is the AgentHeartbeatRun.id.
   *  For executor/merger runs, this is a synthetic ID (e.g., "exec-{taskId}-{timestamp}" or "merge-{taskId}-{timestamp}"). */
  runId: string;
  /** Agent ID performing the mutation. */
  agentId: string;
  /** Task ID being operated on (if applicable). */
  taskId?: string;
  /** Immutable task lineage ID for durable cross-history correlation. */
  taskLineageId?: string;
  /** Execution phase for disambiguating sub-operations (e.g., "heartbeat", "execute", "merge-attempt-1"). */
  phase?: string;
  /** Invocation source for heartbeat runs (e.g., "timer", "on_demand", "assignment"). */
  source?: string;
}

// ── Git mutation types ─────────────────────────────────────────────────────────

/**
 * Additional worktree session-start recovery metadata:
 *
 * ```ts
 * // worktree:incomplete-detected
 * metadata: {
 *   classification: "missing" | "incomplete" | "unregistered" | "outside-work-tree";
 *   reason?: string;
 *   source: "pool-acquire" | "resume" | "session-start" | "executor-liveness-gate";
 *   taskId?: string;
 *   retryCount?: number;
 *   maxRetries?: number;
 *   terminalAction?: "requeue-todo" | "park-in-review";
 * }
 *
 * // worktree:auto-recovered
 * metadata: {
 *   classification: "missing" | "incomplete" | "unregistered" | "unknown";
 *   action: "requeue-todo" | "escalate-exhausted";
 *   retries: number;
 *   maxRetries: number;
 *   staleWorktree?: string;
 *   taskId?: string;
 * }
 * ```
 */
export type GitMutationType =
  | "worktree:create"
  | "worktree:remove"
  | "worktree:remove-fallback"
  | "worktree:remove-classified-harmless"
  | "worktree:remove-classification-probe-failed"
  | "worktree:remove-leaked-registered-worktree"
  | "worktree:reuse"
  /*
   * FNXC:TaskPinnedWorktrees 2026-07-16-00:00:
   * Emitted when task-pinned acquisition (`worktreeNaming: "task-id"`) corrects a `task.worktree` cache that
   * disagrees with the derived `<worktreesDir>/<task-id>` path (the FN-7996 stale/foreign-pointer shape).
   * Metadata is ids/paths-only: `{ taskId, previous, derived, source }`.
   */
  | "worktree:pin-rederived"
  | "worktree:incomplete-detected"
  | "worktree:reanchored"
  | "worktree:auto-recovered"
  // FNXC:Workspace 2026-06-21-20:10: workspace per-repo acquisition audit events (U2).
  // -busy: another task holds the same sub-repo's acquisition exclusivity lock (KTD4).
  // -failed: a sub-repo worktree acquisition threw; surfaced + audited, never swallowed.
  | "worktree:workspace-repo-acquire-busy"
  | "worktree:workspace-repo-acquire-failed"
  /**
   * worktrunk run-audit metadata shape:
   *
   * ```ts
   * metadata: {
   *   op: "install" | "create" | "sync" | "prune" | "remove" | "failure" | "fallback-native";
   *   binaryPath?: string; // resolved worktrunk binary path
   *   worktreePath?: string; // target worktree path (create/sync/remove; prune when single-target)
   *   durationMs?: number; // wall-clock duration of the worktrunk invocation
   *   exitCode?: number | null; // only on failure / fallback-native events
   *   stderrPreview?: string; // truncated to 4 KB; only on failure / fallback-native events
   *   installSource?: "release-binary" | "cargo"; // only on successful install events
   *   prunedCount?: number; // only on successful prune events when known
   * }
   *
   * For `worktree:worktrunk-install`, `target` must be the installed `binaryPath`.
   * ```
   */
  | "worktree:worktrunk-install"
  | "worktree:worktrunk-create"
  | "worktree:worktrunk-remove"
  | "worktree:worktrunk-sync"
  | "worktree:worktrunk-prune"
  | "worktree:worktrunk-fallback"
  | "worktree:worktrunk-failure"
  | "worktree:worktrunk-fallback-native"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   success: boolean;
   *   reason: string;
   *   target?: string;
   *   error?: string;
   * }
   * ```
   */
  | "worktree:admin-entry-pruned"
  | "worktree:removal-refused-active-session"
  | "worktree:removal-forced-over-active-session"
  | "worktree:active-session-reconciled"
  | "worktree:stale-lock-detected"
  | "worktree:stale-lock-recovered"
  | "worktree:stale-lock-recovery-failed"
  | "worktree:stale-lock-refused"
  | "worktree:stale-registration-detected"
  | "worktree:stale-registration-recovered"
  | "worktree:stale-registration-recovery-failed"
  | "worktree:branch-collision-recovery"
  | "branch:create"
  | "branch:delete"
  | "branch:checkout"
  | "commit:create"
  | "commit:amend"
  | "reset:hard"
  | "merge:start"
  | "merge:resolve"
  | "merge:file-scope-violation"
  | "merge:file-scope-enforcement-disabled"
  | "merge:auto-prerebase:applied"
  | "merge:auto-prerebase:skipped"
  | "merge:auto-prerebase:failed"
  | "merge:layer3:foreign-file-skipped"
  | "merge:layer3:scope-override-bypass"
  | "merge:scope:auto-widen"
  | "merge:ai-clean-room"
  | "merge:ai-no-branch"
  | "merge:ai-empty"
  | "merge:ai-review-verdict"
  | "merge:ai-review-blocked"
  | "merge:ai-review-landed-with-concerns"
  | "merge:ai-local-sync"
  | "merge:ai-landed"
  | "merge:ai-deps-sync"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   taskId: string;
   *   mergeRoot: string;
   *   phase: "git-remove" | "fs-rm";
   *   success: boolean;
   *   error?: string;
   *   code?: string;
   * }
   * ```
   */
  | "merge:ai-worktree-cleanup"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   path: string;
   *   success: boolean;
   *   reason?: "stale" | "active-session" | "git-remove-failed" | "fs-rm-failed" | "not-directory" | "stat-failed";
   *   error?: string;
   * }
   * ```
   */
  | "worktree:tempdir-sweep"
  | "merge:reuse-handoff-acquired"
  | "merge:reuse-handoff-refused"
  | "merge:reuse-handoff-released"
  | "merge:reuse-handoff-deferred-to-worktrunk"
  | "merge:reuse-handoff-autostash"
  | "merge:cwd-integration-fallback-removed"
  | "merge:reuse-fallback-new-worktree"
  | "merge:reuse-fallback-pruned-stale-registration"
  | "merge:reuse-fallback-reused-existing-registration"
  | "merge:reuse-worktree-fresh-acquire"
  | "merge:reuse-worktree-fresh-acquired"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   taskId: string;
   *   integrationBranch: string;
   *   integrationMode: "reuse-task-worktree" | "cwd-integration";
   *   integrationRootDir: string;
   *   taskWorktreePath: string | null;
   *   userCheckout: {
   *     worktreePath: string;
   *     dirty: boolean;
   *     untrackedCount: number;
   *     dirtyPathSample: string[];
   *   } | null;
   *   dirtyFingerprint: string | null;
   * }
   * ```
   */
  | "merge:integration-worktree-state"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   taskId: string;
   *   integrationBranch: string;
   *   refusedGate: string;
   *   refusedReason: string;
   *   requestedMode: "reuse-task-worktree" | "cwd-integration";
   *   taskWorktreePath: string | null;
   *   parkOutcome: "in-review-failed";
   * }
   * ```
   */
  | "merge:cwd-integration-fallback-refused"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   taskId: string;
   *   integrationBranch: string;
   *   refName: string;
   *   fromSha: string | null;
   *   toSha: string;
   *   advanceMode: "fast-forward" | "non-fast-forward" | "update-ref";
   *   aiResolved?: boolean;
   *   succeeded: boolean;
   *   error?: string;
   * }
   * ```
   */
  | "merge:integration-ref-advance"
  /**
   * Emitted by the merger's post-ref-advance auto-sync hook for each other
   * worktree it attempts to fast-forward (typically the user's project-root
   * checkout). Records the per-worktree outcome of the
   * `mergeAdvanceAutoSync` pipeline (`stash → ff → pop`, or pure `ff-only`).
   * Per-worktree `pull:fast-forward`, `stash:push`, `stash:pop`, and
   * `stash:pop-conflict` events are still emitted in addition, with
   * `metadata.autoSync = true` so downstream consumers can attribute them.
   *
   * Metadata shape:
   * ```ts
   * {
   *   taskId: string;
   *   integrationBranch: string;
   *   mode: "ff-only" | "stash-and-ff";
   *   newSha?: string;
   *   worktreePath?: string;
   *   outcome:
   *     | "clean-sync"                  // worktree was clean against previousSha; reset --hard HEAD snapped it forward
   *     | "synced-with-edits-restored"  // real edits captured as patch, snapped to HEAD, patch re-applied cleanly
   *     | "synced-with-pop-conflict"    // patch failed to reapply OR untracked file collided with newly-tracked path
   *     | "skipped-dirty"               // ff-only mode + real edits → no-op (banner surfaces for manual handling)
   *     | "skipped-not-on-branch"       // worktree's HEAD is on a different branch than integrationBranch
   *     | "skipped-head-not-at-new-sha" // concurrent advance moved HEAD past newSha between guard and reset
   *     | "failed"                      // git command exited non-zero; see stage + error
   *     | "enumeration-failed"          // `git worktree list --porcelain` failed in the project root
   *     | "exception";                  // syncWorktreeToHead threw outside its own try/catch
   *   stashedFiles?: string[];          // tracked-file edits captured into patchPath
   *   patchPath?: string;               // /tmp/fusion-worktree-sync-<id>/edits.patch (preserved when outcome surfaces a conflict)
   *   conflictedFiles?: string[];       // paths git apply --3way couldn't reconcile; falls back to patch-header parsing when the index has no unmerged entries
   *   untrackedRestored?: string[];     // untracked files copied back into the worktree after the snap
   *   untrackedSkippedAsTracked?: string[]; // untracked files whose paths collided with newly-tracked files at HEAD; left in the stage dir
   *   stage?: "snapshot" | "reset" | "apply" | "untracked-restore"; // only on outcome === "failed"
   *   error?: string;
   * }
   * ```
   *
   * Per-step `pull:fast-forward`, `stash:push`, `stash:pop`, and
   * `stash:pop-conflict` events that flow through the merger's auditor as
   * part of this auto-sync carry `metadata.autoSync = true` so consumers can
   * filter them apart from user-triggered git operations.
   */
  | "merge:auto-sync"
  /**
   * Emitted when contamination recovery detects a foreign commit attributable
   * to a `done` task that is not reachable from the integration branch — an
   * orphan produced by a pre-fix non-FF ref advance. `merger:orphan-rehome-ff`
   * fires after a successful fast-forward rehome; `merger:orphan-rehome-refused`
   * fires when the orphan diverges from the integration tip and would require
   * a cherry-pick (refused as too high-blast-radius for automated recovery).
   *
   * Metadata shape:
   * ```ts
   * {
   *   taskId: string;
   *   integrationBranch: string;
   *   orphanSha: string;
   *   integrationTipSha?: string;
   *   previousTipSha?: string;
   *   newTipSha?: string;
   *   reason?: "non-fast-forward";
   *   cherryPickHint?: string;
   * }
   * ```
   */
  | "merger:orphan-rehome-ff"
  | "merger:orphan-rehome-refused"
  | "merge:audit-failure"
  | "branch:auto-reclaim"
  | "branch:auto-canonicalize-case"
  | "branch:stale-active-reclaim"
  | "branch:stale-active-reclaim-deferred"
  | "branch:orphan-prune"
  // reserved; refusal currently thrown pre-audit
  | "project:bootstrap-refused-linked-worktree"
  | "branch:reanchor"
  | "branch:attribution-anomaly"
  | "branch:auto-reattach-authoritative"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   taskId?: string;
   *   worktreePath: string;
   *   stashSha: string;
   *   stashLabel: string;
   *   untrackedIncluded: true;
   * }
   * ```
   */
  | "stash:push"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   taskId?: string;
   *   worktreePath: string;
   *   stashSha: string;
   *   stashLabel: string;
   *   manualResolution?: boolean;
   * }
   * ```
   */
  | "stash:pop"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   taskId?: string;
   *   worktreePath: string;
   *   integrationBranch: string;
   *   remote?: string;
   *   fromSha: string;
   *   toSha: string;
   *   durationMs: number;
   *   succeeded: boolean;
   *   error?: string;
   *   behind?: number;
   *   ahead?: number;
   * }
   * ```
   */
  | "pull:fast-forward"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   integrationBranch: string;
   *   remote: "origin";
   *   localSha: string;
   *   remoteSha: string | null;
   *   aheadCount: number;
   *   behindCount: number;
   *   forceWithLease: boolean;
   *   outcome: "ok" | "rejected-non-ff" | "rejected-other" | "no-upstream" | "no-remote" | "merge-locked" | "failed";
   *   stderrPreview?: string;
   *   durationMs: number;
   * }
   * ```
   */
  | "push:origin"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   taskId?: string;
   *   worktreePath: string;
   *   stashSha: string;
   *   stashLabel: string;
   *   conflictedFiles: string[];
   *   autostashOutcome: "conflict-needs-manual" | "failed";
   *   advice?: string;
   * }
   * ```
   */
  | "stash:pop-conflict";

// ── Database mutation types ────────────────────────────────────────────────────

export type DatabaseMutationType =
  | "task:create"
  | "task:update"
  | "task:move"
  | "task:log-entry"
  | "task:comment:add"
  | "task:steering-comment:add"
  | "task:assign"
  | "task:checkout"
  | "agent:auto-recover-error-state"
  | "agent:reset-error-state-on-startup"
  | "agent:error-retry-exhausted"
  | "agent:error-parked-unrecoverable"
  /*
  FNXC:RunAudit 2026-07-15-00:00:
  FN-8004 records a heartbeat move that lost a concurrent soft-delete using identifiers and timestamps only. Never place the failed run text or agent lastError in this event because the race is benign and audit metadata must remain structured.
  */
  | "agent:heartbeat-move-skipped-soft-delete"
  | "task:release"
  | "task:pause"
  | "task:unpause"
  | "task:dependency:add"
  | "merge:request-enqueued"
  | "merge:dependency-parity-diff"
  | "merge:lease-parity-diff"
  | "merge:request-dequeued-shadow"
  | "mergeQueue:lease-target-unavailable"
  | "mergeQueue:enqueue-rejected"
  | "mergeQueue:stale-lease-on-column-exit"
  | "mergeQueue:auto-cleanup-stale-row"
  | "task:auto-recover-already-merged"
  | "task:auto-recover-finalize-already-on-main"
  /** Metadata: { taskId, previousColumn, targetColumn, commitSha, status, blockedBy, overlapBlockedBy, reason } */
  | "task:auto-merge-finalize-column-mismatch-reconciled"
  /** Metadata: { taskId, previousColumn, targetColumn, commitSha, status, blockedBy, overlapBlockedBy, reason } */
  | "task:auto-merge-finalize-column-mismatch-no-action"
  | "task:auto-merge-skipped-already-done"
  /** Metadata: { taskId, commitSha, failedCommand, exitCode, errorTail } */
  | "task:post-finalize-verification-no-op"
  /** Metadata: { kind, parentTaskId, existingTaskId, signature, rateLimited } */
  | "verification:followup-deduped"
  /** Metadata: { kind, parentTaskId, newTaskId, signature, supersedesTaskId } */
  | "verification:followup-created"
  | "mission:stranded-feature-triaged"
  | "task:auto-recover-branch-misbound"
  | "task:auto-recover-misrouted-foreign-commit"
  | "task:auto-recover-foreign-only-contamination"
  | "task:auto-recover-foreign-only-contamination-skipped"
  | "task:auto-recover-node-unreachable"
  | "task:auto-recover-worktree-metadata-rebound"
  | "task:auto-recover-worktree-metadata-cleared"
  | "task:auto-recover-worktree-metadata-skipped-active"
  // FNXC:Lifecycle FNXC_LOG 2026-06-20-00:00: FN-6782 — audit type for a global pause/resume park that was cleared and requeued by self-healing.
  | "task:auto-recover-paused-abort-park"
  // FNXC:Lifecycle FNXC_LOG 2026-06-20-00:00: audit type for reaping a leaked worktree/lease/semaphore slot whose holder left in-progress.
  | "task:reap-leaked-concurrency-slot"
  // task:auto-archived-ghost-bug metadata: { findings: Array<{ construct: { kind: string; raw: string; filePath?: string; line?: number }; matched: boolean; probeError?: string; output?: string }>; reason: string }
  // task:auto-archived-duplicate metadata: { siblingTaskIds: string[]; scores: Record<string, number> }
  | "task:auto-archived-ghost-bug"
  | "task:auto-archived-duplicate"
  | "task:auto-reconciled-self-defeating-dep"
  | "task:soft-delete-column-reconciled"
  | "task:dependency-cycle-rejected"
  | "task:dependency-cycle-detected"
  | "task:auto-reconciled-dependency-cycle"
  | "task:dependency-cycle-unrepaired"
  /**
   * Metadata shape for node:handoff:* and node:lease:* events:
   * ```ts
   * {
   *   taskId: string;
   *   ownerNodeId: string | null;        // task.checkoutNodeId at decision time
   *   ownerNodeHealth: "offline" | "error" | "online" | "unknown";
   *   localNodeId: string;
   *   handoffPolicy: "block" | "reassign-to-local" | "reassign-any-healthy" | undefined;
   *   decisionReason: string;             // HandoffDecision.reason (e.g. "handoff_blocked_by_policy")
   *   source: "scheduler.dispatch" | "mesh-lease.recover";
   *   epoch?: number;                     // for node:lease:recovered: the post-recovery checkoutLeaseEpoch
   *   recoveryReason?: string;            // for node:lease:recovered: caller-provided reason + isLeaseRecoverable reason
   * }
   * ```
   */
  | "node:handoff:parked"
  | "node:handoff:reassign-local"
  | "node:handoff:reassign-any"
  | "node:lease:recovered"
  | "task:auto-recover-lease-released"
  | "task:auto-recover-lease-already-healed"
  | "task:auto-recover-lease-foreign-owner"
  | "task:auto-recover-lease-central-unavailable"
  | "task:auto-recover-lease-partial-write"
  | "task:auto-recover-lease-reconciled"
  | "task:auto-recover-completion-fanout"
  | "task:auto-recover-completion-handoff-limbo"
  | "task:auto-recover-completion-handoff-limbo-exhausted"
  | "task:auto-recover-post-done-noncontinuable-wedge"
  | "task:auto-recover-post-done-noncontinuable-wedge-exhausted"
  | "task:auto-recover-worktree-session-exhausted"
  | "task:auto-recover-in-progress-limbo"
  /** Metadata: { taskId, branch, worktree, checkedOutBy, executionStartedAt, executionAgeMs, graceMs, liveWorktreeBoundBranch, reason } */
  | "task:auto-recover-in-progress-limbo-no-action"
  | "task:resume-limbo-escalated"
  /** Metadata: { taskId, executionAgeMs, graceMs, staleBindingAgeFloorMs, checkedOutBy, agentPresent, lastActivityMs, hasRecentRunAudit, worktree, branch, worktreeExists, signalReason } */
  | "task:reclaim-phantom-executor-binding"
  /** Metadata: { shiftedTaskIds: string[], downtimeMs, reason } */
  | "task:reconcile-engine-downtime-active-timing"
  /** Metadata: { shiftedTaskIds: [], downtimeMs, reason } */
  | "task:reconcile-engine-downtime-active-timing-no-action"
  /* FNXC:Workspace 2026-06-22-09:30 (Phase D U1) — workspace-mode self-healing run-audit events. */
  /** Metadata: { taskId, landedRepos: string[], unlandedRepos: string[], failedRepos: string[], action: "re-enqueue" | "park-failed", reason } */
  | "task:reconcile-workspace-partial-land"
  /** Metadata: { taskId, reason: "auto-merge-off" | "user-paused" | "live-worktree", livePaths: string[] } */
  | "task:reconcile-workspace-partial-land-no-action"
  /** Metadata: { taskId, path, kind: "workspace-repo-land", registeredAt, ageMs, staleBindingAgeFloorMs, ownerColumn } */
  | "task:reclaim-phantom-workspace-land-lease"
  /** Metadata: { taskId, repo, worktreePath, success, reason } */
  | "task:reconcile-orphaned-workspace-worktree"
  /**
   * FNXC:AgentTaskStateDrift 2026-06-23-08:50:
   * Self-healing must leave file-scope lease queues intact while recording when stale durable Agent.taskId/state drift is cleared. Metadata: { agentId, taskId, taskColumn, agentState, status, blockedBy, overlapBlockedBy, hadFreshRun, hadActiveExecution, reason }.
   */
  | "task:reconcile-stale-agent-assignment"
  /** Metadata: { taskId, canonicalId, canonicalColumn, canonicalDeleted, priorPausedReason } */
  | "task:reconcile-stale-duplicate-decision"
  /*
  FNXC:LegacyAdoption 2026-07-19-04:30 (U9b / R10 / KTD-8):
  Startup legacy-row adoption through the KTD-8 adoption table. Metadata is
  ids/counts/outcomes-only: { taskId, action, priorStatus, column, backfilledStepCount,
  reason }, where `reason` is a fixed adoption-table note — never row prose.
  */
  | "task:reconcile-legacy-adoption"
  /**
   * An UNMAPPABLE legacy status: the row is parked `paused` for a human with its status
   * deliberately left in place so the operator can see what it carried. Same metadata shape.
   */
  | "task:reconcile-legacy-adoption-unmappable"
  /**
   * FNXC:MergeQueue 2026-07-15-10:05:
   * Wedged single-flight merge reclaim. Metadata ids/outcomes-only:
   * { taskId, reason, silenceMs?, limitMs, status?, column? }.
   */
  | "task:reconcile-wedged-active-merge"
  /** Metadata: { taskId, branch, worktree, checkedOutBy, executionStartedAt, executionAgeMs, graceMs, liveWorktreeBoundBranch, reason } */
  | "task:reclaim-self-owned-branch-conflict-no-action"
  | "task:orphan-detected-no-action"
  | "task:reattach-orphaned-execution"
  /** Metadata: { taskId, lastReason, stuckKillCount, attemptedStuckKillCount, maxStuckKills, checkedOutBy, executionStartedAt, executionAgeMs, graceMs, liveWorktreeBoundBranch } */
  | "task:stuck-loop-exhausted-no-action"
  /** Metadata: { taskId: string; ignoredStepUpdateCount: number; stuckKillStreak: number; lastReason: "no-progress-churn" } */
  | "task:stuck-no-progress-churn-terminalized"
  /** Metadata: { taskId, cycleCount, windowMs, lastMoveSource } */
  | "task:dispatch-oscillation-terminalized"
  /** Metadata: { taskId, cycleCount, maxCycles, progressSignature, failureValue } */
  | "task:execution-dispatch-loop-terminalized"
  /** Metadata: { taskId, blocker, source, priorColumn, priorStatus } */
  | "task:completed-blocked-parked"
  /** Metadata: { taskId, priorColumn, priorStatus, source } */
  | "task:completed-blocked-advanced"
  | "task:auto-recover-starved-refinement"
  /** Metadata: { rawDiffFileCount: number; attributedFileCount: number; foreignCommitCount: number; foreignCommitShas: string[]; source: string } */
  | "task:worktree-contamination-detected"
  /** Metadata: { taskId, pausedAgeMs, blockedFollowerIds: string[], previousPausedReason: string | null } */
  | "task:auto-rebound-paused-scope-decay"
  /** Metadata: { taskId, targetTaskId, targetColumn, chainDepth: number } */
  | "task:auto-archived-meta-resolved"
  /** Metadata: { taskId, targetTaskId, targetColumn, chainDepth: number, blockedBy: string[] } */
  | "task:auto-archive-meta-resolved-skipped"
  /** Metadata: { taskId, targetTaskId, chainDepth: number, stalledMs: number } */
  | "task:auto-archived-meta-stalled"
  /** Metadata: { taskId, targetTaskId, chainDepth: number, stalledMs: number, blockedBy: string[] } */
  | "task:auto-archive-meta-stalled-skipped"
  /** Metadata: { holderIds: string[], followerCount: number, windowMs: number, blockedGrowth: number } */
  | "task:auto-board-stall-broken"
  /** Metadata: { holderIds: string[], followerCount: number, windowMs: number, ntfyDispatched: boolean } */
  | "task:auto-board-stall-unrecovered"
  /** Metadata: { errors: string[], lastCheckedAt: string | null, notificationDispatched: boolean } */
  | "task:auto-db-corruption-detected"
  /**
   * Per-lane runtime/provider/model selection telemetry, emitted once per
   * `createResolvedAgentSession` call. Target is the resolved runtime id
   * (e.g., `"pi"`, `"mock"`, `"hermes"`).
   *
   * Metadata shape:
   * ```ts
   * {
   *   sessionPurpose: SessionPurpose;        // canonical lane label
   *   runtimeId: string;                     // resolved runtime id (same as target)
   *   wasConfigured: boolean;                // runtime was explicitly configured (vs default fallback)
   *   provider: string | null;               // resolved AI provider id (null when not yet set)
   *   modelId: string | null;                // resolved model id (null when not yet set)
   *   mockProviderActive: boolean;           // isMockProviderId(provider) — convenience flag for test-mode assertions
   *   testModeActive: boolean;               // isTestModeActive(settings) at resolution time
   *   runtimeHint?: string;                  // raw runtime hint when present
   * }
   * ```
   */
  | "session:runtime-resolved"
  /**
   * FNXC:AgentReflectionTelemetry 2026-06-27-00:00:
   * Agent performance reflection attempts must emit durable telemetry for every generated, skipped, or failed outcome. Metadata carries ids, trigger taxonomy, counts, and outcomes only; never persist reflection summaries, insight strings, suggested-improvement text, triggerDetail, or prompt text.
   *
   * Metadata shape for `reflection:generated`:
   * ```ts
   * {
   *   agentId: string;
   *   trigger: "manual" | "periodic" | "post-task" | "user-requested";
   *   taskId?: string;
   *   reflectionId: string;
   *   tasksCompleted?: number;
   *   tasksFailed?: number;
   *   avgDurationMs?: number;
   *   commonErrorCount: number;
   *   insightCount: number;
   *   suggestedImprovementCount: number;
   * }
   * ```
   * Metadata shape for `reflection:skipped`:
   * ```ts
   * {
   *   agentId: string;
   *   trigger: "manual" | "periodic" | "post-task" | "user-requested";
   *   taskId?: string;
   *   reason: "no-history";
   * }
   * ```
   * Metadata shape for `reflection:failed`:
   * ```ts
   * {
   *   agentId: string;
   *   trigger: "manual" | "periodic" | "post-task" | "user-requested";
   *   taskId?: string;
   *   errorClass: string;
   * }
   * ```
   *
   * FNXC:AgentReflection 2026-07-04-00:00:
   * FN-7528 adds a deterministic, non-LLM post-task performance capture (AgentReflectionService.captureTaskPerformance),
   * distinct from the LLM-backed generateReflection above. `reflection:captured` fires once per completed task and stays
   * ids/counts/outcomes-only: no free-form verificationScopeReason text, insight/summary prose, or prompt text.
   * Metadata shape for `reflection:captured`:
   * ```ts
   * {
   *   agentId: string;
   *   trigger: "post-task";
   *   taskId?: string;
   *   reflectionId: string;
   *   retryReworkCount?: number;
   *   filesTouchedCount?: number;
   *   packagesTouchedCount?: number;
   *   verificationFileScoped?: boolean;
   *   durationMs?: number;
   * }
   * ```
   * Metadata shape for a skipped capture (emitted via `reflection:skipped` with `reason: "not-completed"` or `"no-history"`):
   * ```ts
   * {
   *   agentId: string;
   *   trigger: "post-task";
   *   taskId?: string;
   *   reason: "no-history" | "not-completed";
   * }
   * ```
   */
  | "reflection:generated"
  | "reflection:skipped"
  | "reflection:failed"
  | "reflection:captured"
  | "task:in-review-stall-deadlock-disposed"
  | "task:in-review-stall-terminal-provider-error"
  | "task:finalize-unproven-blocked"
  /**
   * FN-5490/FN-5517/FN-5526/FN-5540 lost-work guard: the merger or self-heal
   * sweep refused to finalize a task as no-op because its record claimed
   * `modifiedFiles` while no commit landed. Task is moved back to todo with
   * progress preserved instead of silently clearing modifiedFiles to [].
   * Metadata: { modifiedFilesCount, classification, baseRef? }
   */
  | "task:finalize-lost-work-blocked"
  /**
   * FNXC:Lifecycle 2026-06-14-20:16:
   * FN-6461 records every no-op finalize lane that refuses to mark a no-commits task done because incomplete/skipped steps outweigh completed work.
   * Metadata: { reason, doneCount, incompleteCount, classification?, baseRef?, lane }
   */
  | "task:no-commits-finalize-blocked-incomplete-steps"
  /**
   * FNXC:Lifecycle 2026-07-16-00:00:
   * FN-8141: the AI empty-merge lane refused to finalize a commit-expected task `done` because its
   * branch had no net changes vs the integration tip AND no positive proof the work already landed
   * (commits reverted/lost). The task is moved back to `todo` with progress preserved for operator review.
   * Metadata: { reason, branch, integrationBranch, lane, baseCommitSha?, hadPriorNoOpProof? }
   */
  | "task:empty-merge-finalize-blocked-no-landed-proof"
  | "task:integrity-reconcile-modified-files"
  | "task:integrity-warning"
  /** FN-5092 watchdog: stale `status: "merging"` / `"merging-pr"` cleared on a done/archived task. Metadata: { previousColumn, previousStatus, ageMs, mergeConfirmed?: boolean } */
  | "task:auto-recover-stale-merger-status"
  | "auto-recovery:classify-decision"
  | "auto-recovery:retry-issued"
  | "auto-recovery:ai-session-spawned"
  | "auto-recovery:pause-because-destructive-ambiguity"
  | "contamination:retry-issued"
  | "contamination:irreducible-pause"
  | "message-delivery:retry-issued"
  | "message-delivery:park"
  | "branch-worktree:auto-requeue"
  | "branch-worktree:ai-session-spawned"
  | "branch-worktree:irreducible-pause"
  | "branch-worktree:foreign-branch-discarded"
  | "document:write"
  | "workflow-step:result"
  | "agent:create:requested"
  | "agent:create:approved"
  | "agent:create:denied"
  | "agent:delete:requested"
  | "agent:delete:approved"
  | "agent:delete:denied"
  | "task:pr-conflict-reclaim"
  /**
   * Metadata shape:
   * ```ts
   * {
   *   path: string;
   *   existingHolder: string;
   *   requestingTaskId: string;
   *   phase: "acquire" | "rehydrate" | "release";
   * }
   * ```
   */
  | "worktree:pool-double-lease-detected"
  | "room:ambiguity:branch"
  | "room:coordination:branch"
  /**
   * FN-5627: Auto-merge fast-path refused to promote in-review → done because
   * `task.mergeDetails.commitSha` is not reachable from the integration branch
   * tip, indicating the merger persisted `mergeConfirmed: true` before the
   * ref-advance actually landed (TOCTOU window in merger.ts ~9762 vs ~9845).
   * Emitted on TERMINAL refusal only — when `mergeRetries` has reached
   * `MAX_AUTO_MERGE_RETRIES` and the task is parked in in-review with
   * `status: "failed"` for manual review.
   * Metadata: { taskId, commitSha, integrationBranch, reason, diagnostic, mergeRetries, budgetExhausted }
   */
  | "merger:fast-path-blocked-foreign-commit"
  /**
   * FN-5627: Auto-recoverable variant of the fast-path refusal. The gate cleared
   * the poisoned mergeDetails fields (commitSha/mergedAt/landedFiles/etc.) and
   * re-enqueued the task for a fresh `aiMergeTask` attempt. Emitted on each
   * recoverable refusal until `mergeRetries` reaches
   * `MAX_AUTO_MERGE_RETRIES`, at which point the next refusal switches to
   * `merger:fast-path-blocked-foreign-commit` and parks as failed.
   * Metadata: { taskId, commitSha, integrationBranch, reason, diagnostic, mergeRetries, maxRetries }
   */
  | "merger:fast-path-auto-recovered"
  /**
   * FN-5627 follow-up: self-healing recovered an `in-review` task that was
   * stuck at `mergeRetries >= MAX_AUTO_MERGE_RETRIES` with `status='failed'`
   * due to a TRANSIENT merge failure class (`target-not-queued` lease
   * handoff race, or spurious same-SHA concurrent-advance left over from
   * pre-FN-5627 code). The sweep reset `mergeRetries` to 0, cleared
   * `status`/`error`, incremented `mergeDetails.transientRecoveryCount`,
   * and re-enqueued the task via `requeueForAutoMerge`. Bounded by
   * `MAX_TRANSIENT_MERGE_RECOVERIES` (2). Once exhausted, the task stays
   * parked as `failed` for manual review.
   * Metadata: { taskId, transientClass, mergeRetries, recoveryCount, errorSnippet }
   */
  | "merger:transient-failure-auto-recovered"
  /** Metadata: { taskId, transientClass, recoveryCount, maxRecoveries, errorSnippet } */
  | "merger:transient-failure-budget-exhausted"
  /** Goal anchoring observability events (FN-5655). */
  | "goal:injection-applied"
  | "goal:injection-skipped"
  | "goal:retrieval-invoked"
  /**
   * Goal injection diagnostic event (FN-5658).
   * Metadata: { lane, outcome, goalCount, goalIds, truncated, reason?, errorClass?, runId?, agentId?, taskId? }
   */
  | "prompt:goal-injection"
  /**
   * FNXC:PlannerOverseer 2026-07-04-15:00:
   * FN-7514 no-action event: the planner overseer's per-task oversight loop
   * (`PlannerRecoveryController.tick`) withheld ALL action (no steering,
   * retry, targeted-fix, or pending confirmation) because the task is either
   * user-paused or ineligible for auto-merge processing per the FN-5147
   * `autoMerge:false` / PR-based human-review terminal contract
   * (`allowsAutoMergeProcessing`). Emitted at most once per
   * (taskId, withheld reason) transition — not on every poll while the
   * withheld state persists unchanged.
   * Metadata: { taskId: string; reason: "user-paused" | "auto-merge-off-human-review"; stage?: string; oversightLevel?: string }
   */
  | "overseer:oversight-withheld-human-control"
  /**
   * FNXC:Lifecycle 2026-07-16-10:30:
   * FN-8141 no-action event: a stranded-completed promoter (`recoverCompletedTasks` stuck-in-progress
   * sweep OR `recoverStrandedCompletedTodoTasks` stranded-todo sweep in self-healing.ts) withheld
   * promotion of an all-steps-done/skipped task because its most recent execution-outcome in the
   * durable task log was a failure/refusal park (`evaluateCompletedPromotionFailureProvenance`).
   * Emitted at most once per taskId while the blocking provenance persists (deduped in-memory).
   * Metadata: { taskId, reason: "failure-provenance", sweep: "stuck-in-progress" | "stranded-todo", marker?: string }
   */
  | "task:reconcile-stranded-completed-no-action"
  /**
   * FNXC:Lifecycle 2026-07-16-09:40:
   * FN-8141 no-action lifecycle event: the AI empty-merge lane vetoed a
   * zero-diff (no net changes) no-op finalize because the task's cross-stage
   * overseer memory (derived from the durable `overseer:intervention` timeline)
   * shows the MOST RECENT executor-stage signal was failed-with-incomplete-work
   * with no subsequent green completion (`evaluateNoOpFinalizeExecutorVeto`).
   * The task is moved back to `todo` with progress preserved instead of reaching
   * `done` — mirroring the FN-6461 `task:no-commits-finalize-blocked-incomplete-steps`
   * blocked lane. The move-to-todo transition takes the task out of the merge
   * lane, so the event is not re-emitted every poll (equivalent to the
   * `overseer:oversight-withheld-human-control` per-(taskId, reason) dedup).
   * Metadata (ids/outcomes-only): { reason; branch; integrationBranch; lane:
   * "ai-empty-merge"; executorSignal?; executorSignalObservedAt? }
   */
  | "overseer:no-op-finalize-vetoed-failed-executor";

// ── Filesystem mutation types ─────────────────────────────────────────────────

export const SECRET_MUTATION_TYPES = [
  "secret:read",
  "secret:create",
  "secret:update",
  "secret:delete",
  "secret:approval-requested",
  "secret:approval-granted",
  "secret:approval-denied",
  "secret:sync-push",
  "secret:sync-pull",
  "secret:env-write",
  "secret:env-write-skipped",
  "secret:env-cleanup",
  "secret:env-cleanup-skipped",
] as const;

export const SECRET_AUDIT_PLAINTEXT_FORBIDDEN_KEYS = [
  "plaintextValue",
  "value",
  "secret",
  "password",
  "ciphertext",
  "decrypted",
  "nonce",
] as const;

/**
 * Guards secret audit metadata against obvious plaintext/ciphertext payload leaks.
 *
 * This check is intentionally top-level only; nested objects are not inspected.
 */
export function assertNoSecretPlaintext(metadata?: Record<string, unknown>): void {
  if (!metadata) {
    return;
  }

  for (const key of SECRET_AUDIT_PLAINTEXT_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      throw new Error("secret audit metadata may not include plaintext fields");
    }
  }
}

/**
 * Filesystem mutation metadata contracts for env-materialization events:
 * - secret:env-write -> { filename, keyCount, fingerprint, overwritePolicy, keys: string[] }
 * - secret:env-write-skipped -> { filename, reason: "disabled"|"no-secrets"|"not-gitignored"|"skip-existing"|"invalid-filename"|"no-store"|"list-failed", overwritePolicy?, checkIgnoreError?, symlink? }
 * - secret:env-cleanup -> { filename, fingerprint, reason: "fingerprint-match"|"directory-missing" }
 * - secret:env-cleanup-skipped -> { filename, reason: "fingerprint-mismatch"|"file-missing"|"no-record"|"disabled"|"stat-failed", checkError? }
 * - worktree:copy-file / worktree:copy-file-skipped -> { path, outcome, reason?, error? } (never file contents)
 *
 * FNXC:WorktreeCopyFiles 2026-06-24-00:00:
 * Worktree copy-file audit events are filesystem-domain setup diagnostics and must carry only paths/reasons, never `.env` contents or copied file bytes.
 */
export type FilesystemMutationType =
  | "file:write"
  | "file:delete"
  | "file:capture-modified"
  | "attachment:create"
  | "attachment:delete"
  | "prompt:write"
  | "prompt:update"
  | "session:write"
  | "session:delete"
  | "binary:install-requested"
  | "binary:install-success"
  | "binary:install-failed"
  | "binary:install-denied"
  | "worktree:copy-file"
  | "worktree:copy-file-skipped"
  | (typeof SECRET_MUTATION_TYPES)[number];

export type SandboxMutationType = "sandbox:prepare" | "sandbox:run" | "sandbox:failure" | "sandbox:fallback";

/** Input for a git-domain audit event. */
export interface GitAuditInput {
  type: GitMutationType;
  /** Target of the mutation (e.g., branch name, worktree path, commit SHA). */
  target: string;
  /** Optional structured metadata (e.g., { branch: "fusion/fn-001", from: "main" }). */
  metadata?: Record<string, unknown>;
}

/** Input for a database-domain audit event. */
export interface DatabaseAuditInput {
  type: DatabaseMutationType;
  /** Target of the mutation (e.g., task ID, document key). */
  target: string;
  /** Optional structured metadata. */
  metadata?: Record<string, unknown>;
}

/** Input for a filesystem-domain audit event. */
export interface FilesystemAuditInput {
  type: FilesystemMutationType;
  /** Target of the mutation (e.g., file path). */
  target: string;
  /** Optional structured metadata (e.g., { size: 1234, mimeType: "image/png" }). */
  metadata?: Record<string, unknown>;
}

/** Input for a sandbox-domain audit event. */
export interface SandboxAuditInput {
  type: SandboxMutationType;
  /** Target of the mutation (e.g., backend id). */
  target: string;
  /** Optional structured metadata. */
  metadata?: Record<string, unknown>;
}

/** Interface for emitting run-audit events. */
export interface RunAuditor {
  /** Emit a git-domain audit event. No-op if no run context is available. */
  git(input: GitAuditInput): Promise<void>;
  /** Emit a database-domain audit event. No-op if no run context is available. */
  database(input: DatabaseAuditInput): Promise<void>;
  /** Emit a filesystem-domain audit event. No-op if no run context is available. */
  filesystem(input: FilesystemAuditInput): Promise<void>;
  /** Emit a sandbox-domain audit event. No-op if no run context is available. */
  sandbox(input: SandboxAuditInput): Promise<void>;
}

/**
 * Create a run auditor for a given run context.
 *
 * Returns an auditor that no-ops when:
 * - `context` is null/undefined
 * - The TaskStore doesn't expose `recordRunAuditEvent` (backward compatibility)
 *
 * @param store - TaskStore instance (must expose `recordRunAuditEvent`)
 * @param context - Active run context, or null/undefined for non-run paths
 */
export function createRunAuditor(store: TaskStore, context: EngineRunContext | null | undefined): RunAuditor {
  // No-op auditor for non-run paths
  if (!context) {
    return {
      git: async () => { /* no-op */ },
      database: async () => { /* no-op */ },
      filesystem: async () => { /* no-op */ },
      sandbox: async () => { /* no-op */ },
    };
  }

  // Check if the store supports audit recording
  const hasRecordAuditEvent = typeof store.recordRunAuditEvent === "function";

  if (!hasRecordAuditEvent) {
    // Store hasn't been migrated to FN-1403 yet — return no-op auditor
    return {
      git: async () => { /* no-op */ },
      database: async () => { /* no-op */ },
      filesystem: async () => { /* no-op */ },
      sandbox: async () => { /* no-op */ },
    };
  }

  return {
    git: async (input: GitAuditInput) => {
      const eventInput: RunAuditEventInput = {
        taskId: context.taskId,
        agentId: context.agentId,
        runId: context.runId,
        domain: "git",
        mutationType: input.type,
        target: input.target,
        metadata: {
          phase: context.phase,
          ...(context.source ? { source: context.source } : {}),
          ...(context.taskLineageId ? { taskLineageId: context.taskLineageId } : {}),
          ...input.metadata,
        },
      };
      await store.recordRunAuditEvent(eventInput);
    },

    database: async (input: DatabaseAuditInput) => {
      // Infer taskId from target when it looks like a task ID (FN-*, KB-*).
      // This handles cases like "task:update" where target is the task ID itself,
      // falling back to context.taskId when target is not a task ID (e.g., document keys).
      const inferredTaskId = input.target.startsWith("FN-") || input.target.startsWith("KB-")
        ? input.target
        : context.taskId;

      const eventInput: RunAuditEventInput = {
        taskId: inferredTaskId,
        agentId: context.agentId,
        runId: context.runId,
        domain: "database",
        mutationType: input.type,
        target: input.target,
        metadata: {
          phase: context.phase,
          ...(context.source ? { source: context.source } : {}),
          ...(context.taskLineageId ? { taskLineageId: context.taskLineageId } : {}),
          ...input.metadata,
        },
      };
      await store.recordRunAuditEvent(eventInput);
    },

    filesystem: async (input: FilesystemAuditInput) => {
      const eventInput: RunAuditEventInput = {
        taskId: context.taskId,
        agentId: context.agentId,
        runId: context.runId,
        domain: "filesystem",
        mutationType: input.type,
        target: input.target,
        metadata: {
          phase: context.phase,
          ...(context.source ? { source: context.source } : {}),
          ...(context.taskLineageId ? { taskLineageId: context.taskLineageId } : {}),
          ...input.metadata,
        },
      };
      await store.recordRunAuditEvent(eventInput);
    },

    sandbox: async (input: SandboxAuditInput) => {
      const eventInput: RunAuditEventInput = {
        taskId: context.taskId,
        agentId: context.agentId,
        runId: context.runId,
        domain: "sandbox",
        mutationType: input.type,
        target: input.target,
        metadata: {
          phase: context.phase,
          ...(context.source ? { source: context.source } : {}),
          ...(context.taskLineageId ? { taskLineageId: context.taskLineageId } : {}),
          ...input.metadata,
        },
      };
      await store.recordRunAuditEvent(eventInput);
    },
  };
}

/**
 * Generate a synthetic run ID for executor/merger runs that don't use AgentHeartbeatRun.
 *
 * Format: "{prefix}-{taskId}-{timestamp}-{random4chars}"
 * Example: "exec-FN-001-1712345678-a1b2"
 */
export function generateSyntheticRunId(prefix: string, taskId: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${taskId}-${timestamp}-${random}`;
}
