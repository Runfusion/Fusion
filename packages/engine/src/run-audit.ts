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
  | "worktree:reuse"
  | "worktree:incomplete-detected"
  | "worktree:auto-recovered"
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
  | "branch:create"
  | "branch:delete"
  | "branch:checkout"
  | "commit:create"
  | "commit:amend"
  | "reset:hard"
  | "merge:start"
  | "merge:resolve"
  | "merge:file-scope-violation"
  | "merge:auto-prerebase:applied"
  | "merge:auto-prerebase:skipped"
  | "merge:auto-prerebase:failed"
  | "merge:layer3:foreign-file-skipped"
  | "merge:layer3:scope-override-bypass"
  | "merge:scope:auto-widen"
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
  | "task:release"
  | "task:pause"
  | "task:unpause"
  | "task:dependency:add"
  | "mergeQueue:lease-target-unavailable"
  | "mergeQueue:enqueue-rejected"
  | "mergeQueue:stale-lease-on-column-exit"
  | "mergeQueue:auto-cleanup-stale-row"
  | "task:auto-recover-already-merged"
  | "task:auto-recover-finalize-already-on-main"
  | "task:auto-merge-skipped-already-done"
  /** Metadata: { taskId, commitSha, failedCommand, exitCode, errorTail } */
  | "task:post-finalize-verification-no-op"
  /** Metadata: { kind, parentTaskId, existingTaskId, signature, rateLimited } */
  | "verification:followup-deduped"
  /** Metadata: { kind, parentTaskId, newTaskId, signature, supersedesTaskId } */
  | "verification:followup-created"
  | "task:auto-recover-branch-misbound"
  | "task:auto-recover-misrouted-foreign-commit"
  | "task:auto-recover-foreign-only-contamination"
  | "task:auto-recover-foreign-only-contamination-skipped"
  | "task:auto-recover-node-unreachable"
  | "task:auto-recover-worktree-metadata-rebound"
  | "task:auto-recover-worktree-metadata-cleared"
  | "task:auto-recover-worktree-metadata-skipped-active"
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
  | "task:auto-recover-worktree-session-exhausted"
  | "task:auto-recover-in-progress-limbo"
  | "task:orphan-detected-no-action"
  /** Metadata: { taskId: string; ignoredStepUpdateCount: number; stuckKillStreak: number; lastReason: "no-progress-churn" } */
  | "task:stuck-no-progress-churn-terminalized"
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
  | "task:in-review-stall-deadlock-disposed"
  | "task:finalize-unproven-blocked"
  /**
   * FN-5490/FN-5517/FN-5526/FN-5540 lost-work guard: the merger or self-heal
   * sweep refused to finalize a task as no-op because its record claimed
   * `modifiedFiles` while no commit landed. Task is moved back to todo with
   * progress preserved instead of silently clearing modifiedFiles to [].
   * Metadata: { modifiedFilesCount, classification, baseRef? }
   */
  | "task:finalize-lost-work-blocked"
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
  | "room:coordination:branch";

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
