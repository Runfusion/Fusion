import type { Task, TaskStore, WorkflowIr, WorkflowIrResolverStore } from "@fusion/core";
import { resolveTaskLifecycleColumns } from "@fusion/core";
import { createLogger, type Logger } from "../logger.js";

/**
 * In-memory only by design (FN-4401): 30s TTL + event invalidation are enough,
 * and filesystem persistence would couple this cache to storage/multi-project concerns.
 */
export interface AutoClaimCandidate {
  id: string;
  title: string | null;
  description: string;
  descriptionFirstLine: string;
  createdAt: string;
  columnMovedAt?: string;
  baseScore: number;
  column: Task["column"];
}

export interface AutoClaimSnapshot {
  generatedAt: number;
  tasks: ReadonlyArray<AutoClaimCandidate>;
}

interface AutoClaimSnapshotManagerOptions {
  taskStore: Pick<TaskStore, "listTasks"> & WorkflowIrResolverStore;
  ttlMs?: number;
  logger?: Logger;
  now?: () => number;
}

const autoClaimSnapshotLog = createLogger("auto-claim-snapshot");

/*
FNXC:AutoClaim 2026-06-21-10:35:
Auto-claim runnability must have one source of truth so the snapshot rebuild and canonical freshness gate exclude the same stale, assigned, checked-out, deleted, paused, and dependency-blocked tasks.

FNXC:AutoClaim 2026-06-21-16:09:
FN-6873 pins `column === "todo"` as the candidate gate after FN-6872 appeared in a heartbeat prompt while archived from a stale cache. Archived, done, triage, in-progress, in-review, soft-deleted, paused, assigned, checked-out, and dependency-blocked rows can satisfy dependencies where allowed, but must never be surfaced or claimed as auto-claim candidates.
*/
/**
 * FNXC:AutoClaimResolvedColumns 2026-07-29-14:40 (U7 / R3):
 * Lifecycle roles per task id, so this predicate can stay SYNCHRONOUS while still
 * answering per-workflow. Absent entries fall back to the legacy ids, so a
 * partially-resolvable board degrades to today's behavior rather than silently
 * emptying the candidate set.
 */
export interface AutoClaimLifecycleRoles {
  hold?: string;
  complete?: string;
}

const LEGACY_AUTO_CLAIM_ROLES: Required<AutoClaimLifecycleRoles> = {
  hold: "todo",
  complete: "done",
};

const rolesFor = (
  taskId: string,
  rolesByTask?: ReadonlyMap<string, AutoClaimLifecycleRoles>,
): Required<AutoClaimLifecycleRoles> => {
  const resolved = rolesByTask?.get(taskId);
  return {
    hold: resolved?.hold ?? LEGACY_AUTO_CLAIM_ROLES.hold,
    complete: resolved?.complete ?? LEGACY_AUTO_CLAIM_ROLES.complete,
  };
};

/**
 * FNXC:AutoClaimResolvedColumns 2026-07-29-14:40 (U7 / R3):
 * THREE lifecycle literals lived here, and they fail in opposite directions:
 *
 *   `column === "todo"` gated candidacy on the HOLD role. Keyed on the literal, a
 *   renamed workflow's candidate set was permanently EMPTY — agents were never
 *   offered its work, with no error anywhere to say so.
 *
 *   Dependency completion is the more dangerous half: a dependency that finished in a renamed Complete
 *   column was not recognised as done, so the dependent stayed blocked forever.
 *
 * Roles are resolved PER TASK, not once per pass, because a dependency may sit on a
 * DIFFERENT workflow from the claimant — a mixed board makes a single per-pass
 * answer wrong for one of them.
 */
export function isRunnableAutoClaimCandidate(
  task: Task,
  tasksById: ReadonlyMap<string, Task>,
  rolesByTask?: ReadonlyMap<string, AutoClaimLifecycleRoles>,
): boolean {
  return task.column === rolesFor(task.id, rolesByTask).hold
    && task.paused !== true
    && !task.assignedAgentId
    && !task.checkedOutBy
    && !task.deletedAt
    && task.dependencies.every((dependencyId) => {
      const dependency = tasksById.get(dependencyId);
      if (!dependency) return false;
      // The DEPENDENCY's own roles, which need not be the claimant's.
      const depRoles = rolesFor(dependencyId, rolesByTask);
      return dependency.column === depRoles.complete;
    });
}

/** Resolve lifecycle roles for every task in one pass, sharing a single IR cache. */
export async function resolveAutoClaimLifecycleRoles(
  taskStore: WorkflowIrResolverStore,
  tasks: readonly Task[],
): Promise<Map<string, AutoClaimLifecycleRoles>> {
  const irCache = new Map<string, WorkflowIr>();
  const roles = new Map<string, AutoClaimLifecycleRoles>();
  for (const task of tasks) {
    const resolved = await resolveTaskLifecycleColumns(taskStore, task.id, irCache);
    if (resolved) {
      roles.set(task.id, { hold: resolved.hold, complete: resolved.complete });
    }
  }
  return roles;
}

export function toAutoClaimCandidate(task: Task, now: number): AutoClaimCandidate {
  const reference = task.columnMovedAt ?? task.createdAt;
  const ageMs = Math.max(0, now - Date.parse(reference));
  const ageHours = ageMs / (1000 * 60 * 60);
  // One base point per day in todo, capped at +5, to keep aged tasks visible even without keyword overlap.
  const baseScore = Math.max(0, Math.min(5, Math.floor(ageHours / 24)));
  return {
    id: task.id,
    title: task.title ?? null,
    description: task.description,
    descriptionFirstLine: extractDescriptionFirstLine(task.description),
    createdAt: task.createdAt,
    columnMovedAt: task.columnMovedAt,
    baseScore,
    column: task.column,
  };
}

/*
FNXC:AutoClaim 2026-06-21-10:35:
FN-6850 requires a canonical re-resolution gate before cached candidates are displayed or claimed, because FN-6812 showed a superseded triage task could remain in the 30s cache with an old runnable title.
Use one fresh slim task list for the bounded candidate subset and rebuild survivors from current rows instead of fanning out per-candidate getTask calls.

FNXC:AutoClaim 2026-06-21-16:09:
The fresh slim list intentionally includes archived rows by default so the shared predicate, not storage filtering, proves archived-while-cached rows are dropped before heartbeat prompt rendering or winner selection.
*/
export async function resolveFreshAutoClaimCandidates(
  taskStore: Pick<TaskStore, "listTasks"> & WorkflowIrResolverStore,
  candidates: ReadonlyArray<AutoClaimCandidate>,
  now: () => number = Date.now,
): Promise<AutoClaimCandidate[]> {
  if (candidates.length === 0) {
    return [];
  }

  const allTasks = await taskStore.listTasks({ slim: true });
  const tasksById = new Map(allTasks.map((task) => [task.id, task]));
  const rolesByTask = await resolveAutoClaimLifecycleRoles(taskStore, allTasks);
  const resolvedAt = now();
  return candidates.flatMap((candidate) => {
    const canonicalTask = tasksById.get(candidate.id);
    if (!canonicalTask || !isRunnableAutoClaimCandidate(canonicalTask, tasksById, rolesByTask)) {
      return [];
    }
    return [toAutoClaimCandidate(canonicalTask, resolvedAt)];
  });
}

export class AutoClaimSnapshotManager {
  private readonly taskStore: Pick<TaskStore, "listTasks"> & WorkflowIrResolverStore;
  private readonly ttlMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private cache: AutoClaimSnapshot | null = null;
  private staleReason: "ttl" | "invalidate" = "ttl";
  private invalidatedAt = 0;
  private inFlight: Promise<AutoClaimSnapshot> | null = null;

  constructor({ taskStore, ttlMs = 30_000, logger = autoClaimSnapshotLog, now = Date.now }: AutoClaimSnapshotManagerOptions) {
    this.taskStore = taskStore;
    this.ttlMs = ttlMs;
    this.logger = logger;
    this.now = now;
  }

  invalidate(reason: string): void {
    this.cache = null;
    this.staleReason = "invalidate";
    this.invalidatedAt = this.now();
    /*
    FNXC:EngineDiagnostics 2026-08-03-05:54:
    Snapshot invalidation runs on every task create/update that changes the auto-claim
    fingerprint. Cache bookkeeping only — default TUI should not reprint it.
    */
    this.logger.debug(`invalidate reason=${reason}`);
  }

  async getSnapshot(): Promise<AutoClaimSnapshot> {
    const current = this.cache;
    if (current && this.now() - current.generatedAt < this.ttlMs) {
      return current;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const startedAt = this.now();
    this.inFlight = this.rebuild();
    try {
      const next = await this.inFlight;
      const invalidatedDuringRebuild = this.invalidatedAt > startedAt;
      this.cache = invalidatedDuringRebuild ? null : next;
      return next;
    } finally {
      this.inFlight = null;
    }
  }

  private async rebuild(): Promise<AutoClaimSnapshot> {
    const allTasks = await this.taskStore.listTasks({ slim: true });
    const tasksById = new Map(allTasks.map((candidate) => [candidate.id, candidate]));
    const rolesByTask = await resolveAutoClaimLifecycleRoles(this.taskStore, allTasks);
    const now = this.now();

    const tasks = allTasks
      .filter((candidate) => isRunnableAutoClaimCandidate(candidate, tasksById, rolesByTask))
      .sort((a, b) => {
        const aSortAt = a.columnMovedAt ?? a.createdAt;
        const bSortAt = b.columnMovedAt ?? b.createdAt;
        return aSortAt.localeCompare(bSortAt);
      })
      .slice(0, 50)
      .map((candidate) => toAutoClaimCandidate(candidate, now));

    const snapshot: AutoClaimSnapshot = {
      generatedAt: now,
      tasks,
    };

    this.logger.log(`rebuild generated=${tasks.length} reason=${this.staleReason}`);
    this.staleReason = "ttl";
    return snapshot;
  }

}

export function extractDescriptionFirstLine(description: string): string {
  const firstLine = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  return firstLine.slice(0, 160);
}
