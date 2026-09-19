/**
 * TaskStore error classes and self-defeating-dependency / dependency-cycle detectors.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: the class/function bodies are byte-identical to
 * their pre-extraction form. store.ts re-imports and re-exports every symbol so
 * callers that import from "../store.js" or "@fusion/core" are unaffected.
 */
import type { Column, ColumnId } from "../types.js";
import type { TransitionRejection } from "../tasks/transition-types.js";

export class TaskHasDependentsError extends Error {
  readonly taskId: string;
  readonly dependentIds: string[];

  constructor(taskId: string, dependentIds: string[]) {
    super(
      `Cannot delete task ${taskId}: still referenced as a dependency by ${dependentIds.join(", ")}. ` +
        `Rewrite or remove these dependencies before deleting.`,
    );
    this.name = "TaskHasDependentsError";
    this.taskId = taskId;
    this.dependentIds = dependentIds;
  }
}
export class TaskSelfDeleteError extends Error {
  readonly taskId: string;
  readonly code = "TASK_SELF_DELETE";

  constructor(taskId: string) {
    super(`Task ${taskId} cannot delete itself`);
    this.name = "TaskSelfDeleteError";
    this.taskId = taskId;
  }
}

/*
FNXC:Authorization 2026-08-09-03:04:
Authorization had no typed error anywhere in @fusion/core. A denial was an HTTP status at the edge and a REGEX OVER ERROR STRINGS in the engine (see isOperatorActionableAgentError in packages/engine/src/errors/transient-error-detector.ts), so nothing downstream could tell a permission denial apart from any other failure.
Two concrete consequences this class exists to fix. First, `handleGraphFailure` in packages/engine/src/executor.ts replaces a node failure's message with a generic "Workflow graph terminated with failure at node '<n>'" string, which erased the reason an operator needs. Second, the dashboard could not distinguish "you may not do this" (403) from "your session expired" (401), so a denial fired the token-recovery flow and told the user to re-authenticate for a permission they simply do not hold.
The `code` discriminant is what makes both fixable without string matching. Shape mirrors AgentTaskRoutingPolicyError (packages/core/src/agents/agent-role-policy.ts), the existing typed-policy-error precedent in this codebase.
*/
/*
FNXC:Authorization 2026-08-09-03:04:
The discriminant is exported as a constant because it must survive SERIALIZATION, not just a
type check. A node handler's thrown error is flattened to `error.message` by the workflow graph
executor before the executor's terminal park ever sees it (packages/engine/src/workflows/workflow-graph-executor.ts,
`node:<id>:error` context patch), so the receiving side compares a plain string against this
constant rather than calling `isPermissionDeniedError` on a live Error instance.
*/
export const PERMISSION_DENIED_ERROR_CODE = "PERMISSION_DENIED" as const;

export class PermissionDeniedError extends Error {
  readonly code = PERMISSION_DENIED_ERROR_CODE;

  constructor(
    /** The actor that was denied. `null` when no actor could be resolved at all. */
    public readonly actorId: string | null,
    /** The catalog permission that was required, e.g. `tasks:delete`. */
    public readonly permission: string,
    /** Optional resource the permission was evaluated against. */
    public readonly resource?: string,
    /** Why the denial happened, when it is not simply "grant absent". */
    public readonly reason?: string,
  ) {
    const who = actorId ?? "unresolved actor";
    const where = resource ? ` on ${resource}` : "";
    const why = reason ? ` (${reason})` : "";
    super(`${who} is not permitted to ${permission}${where}${why}`);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Structural type guard for `PermissionDeniedError`.
 *
 * FNXC:Authorization 2026-08-09-03:04: Matches on the `code` discriminant rather than
 * `instanceof`, because the error crosses package boundaries (core -> engine -> dashboard)
 * where duplicate module instances would defeat a prototype check.
 */
export function isPermissionDeniedError(error: unknown): error is PermissionDeniedError {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === PERMISSION_DENIED_ERROR_CODE
  );
}

/**
 * FNXC:TaskLookup404 2026-07-26-11:20:
 * Requirement: a task-detail read for a task that does not exist must surface as
 * HTTP 404, never 500 — clients (dashboard task detail, polling widgets, CLI)
 * must be able to distinguish "this task is gone" from "the server is broken".
 *
 * `getTaskImpl` previously signalled the miss with a bare `new Error(...)`, so
 * the only thing routes could match on was an errno `code === "ENOENT"` — a
 * leftover from the file-backed storage era. In Postgres/backend mode nothing on
 * the read path sets an errno code, so EVERY missing/unknown/soft-deleted/
 * wrong-project task read returned 500 (reported repro:
 * `GET /api/tasks/FN-8610/runtime-fallback`).
 *
 * `message` is deliberately byte-identical to the legacy string
 * (`Task ${taskId} not found`) because existing code paths and tests match on
 * it; the typed class is the new primary signal, the message is back-compat.
 */
export class TaskNotFoundError extends Error {
  readonly code = "TASK_NOT_FOUND" as const;
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task ${taskId} not found`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

/**
 * FNXC:TaskLookup404 2026-07-26-11:20:
 * Type guard used by API boundaries to map a task miss to 404. Structural (name
 * + code) rather than `instanceof`-only so the check survives a duplicated
 * `@fusion/core` module instance (bundled CLI vs workspace dist) and errors that
 * crossed a serialization boundary.
 */
export function isTaskNotFoundError(error: unknown): error is TaskNotFoundError {
  if (error instanceof TaskNotFoundError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "TaskNotFoundError" || candidate.code === "TASK_NOT_FOUND";
}

export class TaskDeletedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly deletedAt: string,
  ) {
    super(`Task ${taskId} is soft-deleted (deletedAt=${deletedAt}) and cannot be read or mutated`);
    this.name = "TaskDeletedError";
  }
}

export class TombstonedTaskResurrectionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly deletedAt: string,
    public readonly allowResurrection: boolean,
  ) {
    super(
      `Task ${taskId} is soft-deleted (deletedAt=${deletedAt}) and cannot be recreated without forceResurrect: true. `
      + `Operator unlock: allowResurrection=${allowResurrection}`,
    );
    this.name = "TombstonedTaskResurrectionError";
  }
}

export class TaskHasLineageChildrenError extends Error {
  readonly taskId: string;
  readonly childIds: string[];

  constructor(taskId: string, childIds: string[]) {
    super(
      `Cannot delete task ${taskId}: still referenced as a lineage parent by ${childIds.join(", ")}. ` +
        `Pass { removeLineageReferences: true } to clear these references before deleting.`,
    );
    this.name = "TaskHasLineageChildrenError";
    this.taskId = taskId;
    this.childIds = childIds;
  }
}

export class InvalidFileScopeError extends Error {
  readonly taskId: string;
  readonly invalidEntries: string[];

  constructor(taskId: string, invalidEntries: string[]) {
    super(
      `Invalid File Scope entries in PROMPT.md for ${taskId}: ${invalidEntries.join(", ")}. ` +
        "File Scope must contain repo-relative file paths or globs (e.g. `packages/core/src/store.ts`, `packages/engine/src/**/*.ts`), not git refs or identifiers.",
    );
    this.name = "InvalidFileScopeError";
    this.taskId = taskId;
    this.invalidEntries = invalidEntries;
  }
}

export const SELF_DEFEATING_OPERATION_VERBS = [
  "finalize", // Terminalize target task state
  "diagnose", // Investigate/diagnose target task failure
  "dispose", // Dispose terminal artifacts/state for target task
  "unblock", // Remove blockers on target task
  "manual recovery", // Explicit manual recovery operation
  "recover", // Recover target task from failed/stuck state
  "recovery", // Recovery operation on target task
  "resolve", // Resolve target task conflict/failure
  "archive", // Archive target task
  "reclaim", // Reclaim target task ownership/artifacts
  "clean", // Clean target task residual state
  "cleanup", // Cleanup operation on target task
  "fix", // Fix target task issue
] as const satisfies ReadonlyArray<string>;

export class SelfDefeatingDependencyError extends Error {
  readonly code = "SELF_DEFEATING_DEPENDENCY" as const;

  constructor(
    readonly taskTitle: string,
    readonly matchedVerb: string,
    readonly operandTaskId: string,
  ) {
    super(`Task "${taskTitle}" operates on ${operandTaskId} (matched verb: "${matchedVerb}") and cannot also depend on it. A task whose job is to mutate another task into a terminal state must not be blocked by that task.`);
    this.name = "SelfDefeatingDependencyError";
  }
}

/*
FNXC:TaskExecutionTaskCreation 2026-08-21-23:16:
FN-125 prevents a task from blocking on work it spawned, independent of which
API writes the dependency edge. This store invariant protects legacy and host paths.
*/
export class SelfSpawnedDependencyError extends Error {
  readonly code = "SELF_SPAWNED_DEPENDENCY" as const;
  constructor(readonly taskId: string, readonly dependencyId: string) {
    super(`Task ${taskId} cannot depend on self-spawned task ${dependencyId}`);
    this.name = "SelfSpawnedDependencyError";
  }
}

export function detectSelfSpawnedDependency(
  taskId: string,
  candidates: ReadonlyArray<{ id: string; sourceParentTaskId?: string }>,
): { dependencyId: string } | null {
  const match = candidates.find((candidate) => candidate.sourceParentTaskId === taskId);
  return match ? { dependencyId: match.id } : null;
}

export function detectSelfDefeatingDependency(
  title: string | undefined,
  dependencies: readonly string[],
): { matchedVerb: string; operandTaskId: string } | null {
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) return null;

  const normalizedDeps = new Set(
    dependencies
      .map((dep) => dep.trim().toUpperCase())
      .filter((dep) => /^FN-\d+$/i.test(dep)),
  );
  if (normalizedDeps.size === 0) return null;

  const titleFnIds = [...trimmedTitle.matchAll(/\bFN-(\d+)\b/gi)];
  if (titleFnIds.length !== 1) return null;
  const operandTaskId = `FN-${titleFnIds[0][1]}`;

  let matchedVerb: string | null = null;
  for (const verb of SELF_DEFEATING_OPERATION_VERBS) {
    if (verb === "manual recovery") {
      if (/\bmanual\s+recovery\b/i.test(trimmedTitle)) {
        matchedVerb = verb;
        break;
      }
      continue;
    }

    const escapedVerb = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escapedVerb}\\b`, "i").test(trimmedTitle)) {
      matchedVerb = verb;
      break;
    }
  }

  if (!matchedVerb) return null;
  if (!normalizedDeps.has(operandTaskId.toUpperCase())) return null;

  return {
    matchedVerb,
    operandTaskId,
  };
}

export class DependencyCycleError extends Error {
  readonly code = "DEPENDENCY_CYCLE" as const;

  constructor(
    readonly taskId: string,
    readonly cyclePath: readonly string[],
  ) {
    super(`Dependency cycle detected for ${taskId}: ${cyclePath.join(" → ")}`);
    this.name = "DependencyCycleError";
  }
}

export function detectDependencyCycle(
  candidateTaskId: string,
  candidateDependencies: readonly string[],
  lookupDependencies: (taskId: string) => readonly string[] | undefined,
): string[] | null {
  const visited = new Set<string>();

  for (const dep of candidateDependencies) {
    if (dep === candidateTaskId) {
      return [candidateTaskId, candidateTaskId];
    }

    const initialDeps = lookupDependencies(dep);
    if (!initialDeps) continue;

    const stack: Array<{ taskId: string; deps: readonly string[]; index: number }> = [
      { taskId: dep, deps: initialDeps, index: 0 },
    ];
    const path = [candidateTaskId, dep];

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.index >= top.deps.length) {
        stack.pop();
        path.pop();
        continue;
      }

      const next = top.deps[top.index++]!;
      if (next === candidateTaskId) {
        return [...path, candidateTaskId];
      }

      if (visited.has(next)) {
        continue;
      }

      const nextDeps = lookupDependencies(next);
      if (!nextDeps) {
        visited.add(next);
        continue;
      }

      visited.add(next);
      stack.push({ taskId: next, deps: nextDeps, index: 0 });
      path.push(next);
    }
  }

  return null;
}

export class MergeQueueTaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Cannot enqueue merge queue entry for missing task ${taskId}`);
    this.name = "MergeQueueTaskNotFoundError";
  }
}

export class MergeQueueInvalidColumnError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly column: Column,
  ) {
    super(`Cannot enqueue merge queue entry for task ${taskId} in column ${column}; only in-review is allowed`);
    this.name = "MergeQueueInvalidColumnError";
  }
}

export class MergeQueueLeaseOwnershipError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly workerId: string,
    public readonly currentOwner: string | null,
  ) {
    super(
      currentOwner
        ? `Worker ${workerId} does not own merge queue lease for ${taskId}; current owner is ${currentOwner}`
        : `Worker ${workerId} cannot release merge queue lease for ${taskId}; the entry is not currently leased`,
    );
    this.name = "MergeQueueLeaseOwnershipError";
  }
}

export class InvalidMergeQueueLeaseDurationError extends Error {
  constructor(public readonly leaseDurationMs: number) {
    super(`merge queue leaseDurationMs must be > 0 (received ${leaseDurationMs})`);
    this.name = "InvalidMergeQueueLeaseDurationError";
  }
}

export class HandoffInvariantViolationError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly fromColumn: ColumnId,
    message: string,
  ) {
    super(message);
    this.name = "HandoffInvariantViolationError";
  }
}

/**
 * Thrown by the flag-ON (`workflowColumns`) `moveTaskInternal` path when a move
 * is rejected, carrying the typed {@link TransitionRejection} (KTD-3/R13). The
 * existing callers of `moveTask` catch thrown `Error`s (e.g. the dashboard move
 * route inspects `err.message`), so the rejection rides on an `Error` subclass
 * — `.message` reproduces the legacy human-readable string so flag-ON callers
 * that only read the message keep working, while `.rejection` exposes the
 * machine-stable code/messageKey/retryable for surfaces that want it.
 *
 * The FLAG-OFF path still throws the bare legacy `Error` strings unchanged
 * (zero behavior change while the flag is off — proven by the characterization
 * suite).
 */
export class TransitionRejectionError extends Error {
  readonly rejection: TransitionRejection;
  constructor(rejection: TransitionRejection, message: string) {
    super(message);
    this.name = "TransitionRejectionError";
    this.rejection = rejection;
  }
}
