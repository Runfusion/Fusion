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

import type { TaskStore, RunAuditEventInput, RunAuditDomain } from "@fusion/core";

/** Structured context for a run correlation ID. */
export interface EngineRunContext {
  /** Stable run identifier. For heartbeat runs, this is the AgentHeartbeatRun.id.
   *  For executor/merger runs, this is a synthetic ID (e.g., "exec-{taskId}-{timestamp}" or "merge-{taskId}-{timestamp}"). */
  runId: string;
  /** Agent ID performing the mutation. */
  agentId: string;
  /** Task ID being operated on (if applicable). */
  taskId?: string;
  /** Execution phase for disambiguating sub-operations (e.g., "heartbeat", "execute", "merge-attempt-1"). */
  phase?: string;
  /** Invocation source for heartbeat runs (e.g., "timer", "on_demand", "assignment"). */
  source?: string;
}

// ── Git mutation types ─────────────────────────────────────────────────────────

export type GitMutationType =
  | "worktree:create"
  | "worktree:remove"
  | "worktree:reuse"
  | "branch:create"
  | "branch:delete"
  | "branch:checkout"
  | "commit:create"
  | "commit:amend"
  | "reset:hard"
  | "merge:start"
  | "merge:resolve"
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
  | "document:write"
  | "workflow-step:result";

// ── Filesystem mutation types ─────────────────────────────────────────────────

export type FilesystemMutationType =
  | "file:write"
  | "file:delete"
  | "file:capture-modified"
  | "attachment:create"
  | "attachment:delete"
  | "prompt:write"
  | "prompt:update"
  | "session:write"
  | "session:delete";

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

/** Interface for emitting run-audit events. */
export interface RunAuditor {
  /** Emit a git-domain audit event. No-op if no run context is available. */
  git(input: GitAuditInput): Promise<void>;
  /** Emit a database-domain audit event. No-op if no run context is available. */
  database(input: DatabaseAuditInput): Promise<void>;
  /** Emit a filesystem-domain audit event. No-op if no run context is available. */
  filesystem(input: FilesystemAuditInput): Promise<void>;
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
