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
import type { TransitionRejection } from "../transition-types.js";

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
