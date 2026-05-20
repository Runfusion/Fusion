import type { Task, TaskStore } from "@fusion/core";
import { createLogger, type Logger } from "./logger.js";

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
  taskStore: Pick<TaskStore, "listTasks">;
  ttlMs?: number;
  logger?: Logger;
  now?: () => number;
}

const autoClaimSnapshotLog = createLogger("auto-claim-snapshot");

export class AutoClaimSnapshotManager {
  private readonly taskStore: Pick<TaskStore, "listTasks">;
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
    this.logger.log(`invalidate reason=${reason}`);
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
    const now = this.now();

    const tasks = allTasks
      .filter((candidate) => (
        candidate.column === "todo"
        && candidate.paused !== true
        && !candidate.assignedAgentId
        && !candidate.checkedOutBy
        && !candidate.deletedAt
        && candidate.dependencies.every((dependencyId) => {
          const dependency = tasksById.get(dependencyId);
          return dependency?.column === "done" || dependency?.column === "archived";
        })
      ))
      .sort((a, b) => {
        const aSortAt = a.columnMovedAt ?? a.createdAt;
        const bSortAt = b.columnMovedAt ?? b.createdAt;
        return aSortAt.localeCompare(bSortAt);
      })
      .slice(0, 50)
      .map((candidate) => this.toCandidate(candidate, now));

    const snapshot: AutoClaimSnapshot = {
      generatedAt: now,
      tasks,
    };

    this.logger.log(`rebuild generated=${tasks.length} reason=${this.staleReason}`);
    this.staleReason = "ttl";
    return snapshot;
  }

  private toCandidate(task: Task, now: number): AutoClaimCandidate {
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
}

export function extractDescriptionFirstLine(description: string): string {
  const firstLine = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  return firstLine.slice(0, 160);
}
