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
 *   classification: "missing" | "incomplete" | "unregistered";
 *   reason?: string;
 *   source: "pool-acquire" | "resume" | "session-start";
 *   taskId?: string;
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
  | "worktree:removal-refused-active-session"
  | "worktree:removal-forced-over-active-session"
  | "worktree:stale-lock-detected"
  | "worktree:stale-lock-recovered"
  | "worktree:stale-lock-recovery-failed"
  | "worktree:stale-lock-refused"
  | "branch:create"
  | "branch:delete"
  | "branch:checkout"
  | "commit:create"
  | "commit:amend"
  | "reset:hard"
  | "merge:start"
  | "merge:resolve"
  | "merge:file-scope-violation"
  | "merge:audit-failure"
  | "branch:auto-reclaim"
  | "branch:stale-active-reclaim"
  | "branch:orphan-prune"
  | "branch:orphan-rescued"
  | "branch:reanchor"
  | "stash:push"
  | "stash:pop";

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
  | "task:auto-recover-already-merged"
  | "task:auto-recover-finalize-already-on-main"
  | "task:auto-recover-branch-misbound"
  | "task:auto-recover-node-unreachable"
  | "task:auto-reconciled-self-defeating-dep"
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
  | "task:auto-recover-worktree-session-exhausted"
  | "task:auto-recover-starved-refinement"
  | "task:in-review-stall-deadlock-disposed"
  | "task:finalize-unproven-blocked"
  | "task:integrity-reconcile-modified-files"
  | "task:integrity-warning"
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
  | "room:ambiguity:branch";

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
