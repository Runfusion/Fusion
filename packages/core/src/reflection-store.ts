import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentPerformanceSummary,
  AgentReflection,
  ReflectionMetrics,
  ReflectionTrigger,
} from "./types.js";

/** Events emitted by ReflectionStore. */
export interface ReflectionStoreEvents {
  /** Emitted after a reflection is created and persisted. */
  "reflection:created": (reflection: AgentReflection) => void;
  /** Emitted when a performance summary is computed. */
  "reflection:summary-computed": (summary: AgentPerformanceSummary) => void;
}

/** Constructor options for ReflectionStore. */
export interface ReflectionStoreOptions {
  /** Root fn data directory (default: .fusion). */
  rootDir?: string;
}

/** Input payload for creating a reflection. */
export interface CreateReflectionInput {
  agentId: string;
  trigger: ReflectionTrigger;
  triggerDetail?: string;
  taskId?: string;
  metrics: ReflectionMetrics;
  insights: string[];
  suggestedImprovements: string[];
  summary: string;
}

/** Options for computing a performance summary. */
export interface PerformanceSummaryOptions {
  /** Time window in milliseconds to include reflections from. Defaults to 7 days. */
  windowMs?: number;
}

interface AgentLock {
  promise: Promise<unknown>;
}

const DEFAULT_REFLECTION_LIMIT = 50;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SUMMARY_LIST_LIMIT = 10;

/**
 * ReflectionStore persists agent self-reflection records in append-only JSONL files.
 *
 * Storage layout:
 * - `.fusion/agents/{agentId}-reflections.jsonl`
 */
export class ReflectionStore extends EventEmitter {
  private rootDir: string;
  private agentsDir: string;
  private locks: Map<string, AgentLock> = new Map();

  constructor(options: ReflectionStoreOptions = {}) {
    super();

    if (!options.rootDir && process.env.VITEST === "true") {
      throw new Error(
        "ReflectionStore requires an explicit rootDir during test execution. Pass an absolute path to avoid writing to unintended locations.",
      );
    }

    this.rootDir = options.rootDir ?? resolve(".fusion");
    this.agentsDir = join(this.rootDir, "agents");
  }

  override on(event: "reflection:created", listener: ReflectionStoreEvents["reflection:created"]): this;
  override on(
    event: "reflection:summary-computed",
    listener: ReflectionStoreEvents["reflection:summary-computed"],
  ): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override emit(event: "reflection:created", reflection: AgentReflection): boolean;
  override emit(event: "reflection:summary-computed", summary: AgentPerformanceSummary): boolean;
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  /** Ensure required directories exist. */
  async init(): Promise<void> {
    await mkdir(this.agentsDir, { recursive: true });
  }

  /** Create and append a reflection for an agent. */
  async createReflection(input: CreateReflectionInput): Promise<AgentReflection> {
    if (!input.agentId?.trim()) {
      throw new Error("agentId is required");
    }

    return this.withLock(input.agentId, async () => {
      const reflection: AgentReflection = {
        id: `reflection-${randomUUID().slice(0, 8)}`,
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
        trigger: input.trigger,
        triggerDetail: input.triggerDetail,
        taskId: input.taskId,
        metrics: input.metrics,
        insights: input.insights,
        suggestedImprovements: input.suggestedImprovements,
        summary: input.summary,
      };

      const line = `${JSON.stringify(reflection)}\n`;
      await writeFile(this.reflectionsPath(input.agentId), line, { flag: "a" });

      this.emit("reflection:created", reflection);
      return reflection;
    });
  }

  /** Get recent reflections for an agent (newest first). */
  async getReflections(agentId: string, limit = DEFAULT_REFLECTION_LIMIT): Promise<AgentReflection[]> {
    if (!agentId?.trim()) {
      return [];
    }

    const reflectionPath = this.reflectionsPath(agentId);
    if (!existsSync(reflectionPath)) {
      return [];
    }

    const reflections = await this.readReflectionsFromFile(agentId);
    return reflections.slice(0, Math.max(0, limit));
  }

  /** Get the most recent reflection for an agent. */
  async getLatestReflection(agentId: string): Promise<AgentReflection | null> {
    const reflections = await this.getReflections(agentId, 1);
    return reflections[0] ?? null;
  }

  /** Compute an aggregate performance summary from recent reflections. */
  async getPerformanceSummary(
    agentId: string,
    options: PerformanceSummaryOptions = {},
  ): Promise<AgentPerformanceSummary> {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const cutoff = Date.now() - windowMs;
    const allReflections = await this.getReflections(agentId, Number.MAX_SAFE_INTEGER);

    const windowedReflections = allReflections.filter((reflection) => {
      const timestamp = Date.parse(reflection.timestamp);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });

    let totalTasksCompleted = 0;
    let totalTasksFailed = 0;

    const durations: number[] = [];
    const errorCounts = new Map<string, number>();

    for (const reflection of windowedReflections) {
      totalTasksCompleted += reflection.metrics.tasksCompleted ?? 0;
      totalTasksFailed += reflection.metrics.tasksFailed ?? 0;

      if (typeof reflection.metrics.avgDurationMs === "number") {
        durations.push(reflection.metrics.avgDurationMs);
      }

      for (const error of reflection.metrics.commonErrors ?? []) {
        const normalized = error.trim();
        if (!normalized) continue;
        errorCounts.set(normalized, (errorCounts.get(normalized) ?? 0) + 1);
      }
    }

    const avgDurationMs = durations.length > 0
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : 0;

    const totalTasks = totalTasksCompleted + totalTasksFailed;
    const successRate = totalTasks > 0 ? totalTasksCompleted / totalTasks : 0;

    const commonErrors = Array.from(errorCounts.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, SUMMARY_LIST_LIMIT)
      .map(([error]) => error);

    const strengths = this.collectRecentUnique(
      windowedReflections.flatMap((reflection) => reflection.insights),
      SUMMARY_LIST_LIMIT,
    );

    const weaknesses = this.collectRecentUnique(
      windowedReflections.flatMap((reflection) => reflection.suggestedImprovements),
      SUMMARY_LIST_LIMIT,
    );

    const summary: AgentPerformanceSummary = {
      agentId,
      totalTasksCompleted,
      totalTasksFailed,
      avgDurationMs,
      successRate,
      commonErrors,
      strengths,
      weaknesses,
      recentReflectionCount: windowedReflections.length,
      computedAt: new Date().toISOString(),
    };

    this.emit("reflection:summary-computed", summary);
    return summary;
  }

  /** Delete all persisted reflections for an agent. */
  async deleteReflections(agentId: string): Promise<void> {
    if (!agentId?.trim()) {
      return;
    }

    await this.withLock(agentId, async () => {
      try {
        await unlink(this.reflectionsPath(agentId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    });
  }

  private reflectionsPath(agentId: string): string {
    return join(this.agentsDir, `${agentId}-reflections.jsonl`);
  }

  private async readReflectionsFromFile(agentId: string): Promise<AgentReflection[]> {
    const reflectionPath = this.reflectionsPath(agentId);

    try {
      const content = await readFile(reflectionPath, "utf-8");
      const lines = content.split("\n").filter(Boolean);

      const reflections: AgentReflection[] = [];
      for (const [index, line] of lines.entries()) {
        try {
          reflections.push(JSON.parse(line) as AgentReflection);
        } catch (error) {
          console.warn(
            `[ReflectionStore] Skipping malformed reflection line ${index + 1} for ${agentId}`,
            error,
          );
        }
      }

      return reflections.reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private collectRecentUnique(items: string[], maxItems: number): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];

    for (const item of items) {
      const normalized = item.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      deduped.push(normalized);
      if (deduped.length >= maxItems) {
        break;
      }
    }

    return deduped;
  }

  private async withLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(agentId);
    if (!lock) {
      lock = { promise: Promise.resolve() };
      this.locks.set(agentId, lock);
    }

    const operation = lock.promise.then(fn, fn);
    lock.promise = operation;

    return operation as Promise<T>;
  }
}
