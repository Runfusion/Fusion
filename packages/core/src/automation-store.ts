import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskUpdateInput,
  AutomationRunResult,
} from "./automation.js";
import { AUTOMATION_PRESETS, MAX_RUN_HISTORY } from "./automation.js";
import type { ScheduleType } from "./automation.js";

export interface AutomationStoreEvents {
  "schedule:created": [schedule: ScheduledTask];
  "schedule:updated": [schedule: ScheduledTask];
  "schedule:deleted": [schedule: ScheduledTask];
  "schedule:run": [data: { schedule: ScheduledTask; result: AutomationRunResult }];
}

export class AutomationStore extends EventEmitter<AutomationStoreEvents> {
  private automationsDir: string;
  /** Per-schedule promise chain for serializing writes. */
  private scheduleLocks: Map<string, Promise<void>> = new Map();

  constructor(private rootDir: string) {
    super();
    this.automationsDir = join(rootDir, ".kb", "automations");
  }

  /** Create the .kb/automations/ directory if it doesn't exist. */
  async init(): Promise<void> {
    await mkdir(this.automationsDir, { recursive: true });
  }

  // ── Locking ────────────────────────────────────────────────────────

  /**
   * Serialize all mutations to a given schedule's JSON file by chaining promises.
   * Concurrent callers for the same ID will queue behind each other.
   */
  private withScheduleLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.scheduleLocks.get(id) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.scheduleLocks.set(id, next);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        if (this.scheduleLocks.get(id) === next) {
          this.scheduleLocks.delete(id);
        }
        resolve!();
      }
    });
  }

  // ── File I/O ───────────────────────────────────────────────────────

  private schedulePath(id: string): string {
    return join(this.automationsDir, `${id}.json`);
  }

  private async readScheduleJson(id: string): Promise<ScheduledTask> {
    const filePath = this.schedulePath(id);
    const raw = await readFile(filePath, "utf-8");
    try {
      return JSON.parse(raw) as ScheduledTask;
    } catch (err) {
      throw new Error(
        `Failed to parse schedule JSON at ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Atomically write a schedule JSON file by writing to a temp file first,
   * then renaming it into place.
   */
  private async atomicWriteScheduleJson(id: string, schedule: ScheduledTask): Promise<void> {
    const filePath = this.schedulePath(id);
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(schedule, null, 2));
    await rename(tmpPath, filePath);
  }

  // ── Cron Computation ───────────────────────────────────────────────

  /**
   * Compute the next run time from a cron expression.
   * @param cronExpression - A valid cron expression (5 fields).
   * @param fromDate - The date to compute from. Defaults to now.
   * @returns ISO-8601 timestamp of the next run.
   */
  computeNextRun(cronExpression: string, fromDate?: Date): string {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: fromDate ?? new Date(),
    });
    const next = interval.next();
    return next.toISOString() ?? new Date(next.getTime()).toISOString();
  }

  /**
   * Validate a cron expression. Returns true if valid.
   */
  static isValidCron(cronExpression: string): boolean {
    try {
      CronExpressionParser.parse(cronExpression);
      return true;
    } catch {
      return false;
    }
  }

  // ── CRUD ───────────────────────────────────────────────────────────

  async createSchedule(input: ScheduledTaskCreateInput): Promise<ScheduledTask> {
    if (!input.name?.trim()) {
      throw new Error("Name is required and cannot be empty");
    }
    const hasSteps = input.steps && input.steps.length > 0;
    if (!hasSteps && !input.command?.trim()) {
      throw new Error("Command is required and cannot be empty");
    }

    // Resolve cron expression
    let cronExpression: string;
    if (input.scheduleType === "custom") {
      if (!input.cronExpression?.trim()) {
        throw new Error("Cron expression is required for custom schedule type");
      }
      if (!AutomationStore.isValidCron(input.cronExpression)) {
        throw new Error(`Invalid cron expression: "${input.cronExpression}"`);
      }
      cronExpression = input.cronExpression.trim();
    } else {
      cronExpression = AUTOMATION_PRESETS[input.scheduleType];
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const enabled = input.enabled !== undefined ? input.enabled : true;

    const schedule: ScheduledTask = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      scheduleType: input.scheduleType,
      cronExpression,
      command: (input.command ?? "").trim(),
      enabled,
      runCount: 0,
      runHistory: [],
      timeoutMs: input.timeoutMs,
      steps: hasSteps ? input.steps : undefined,
      nextRunAt: enabled ? this.computeNextRun(cronExpression) : undefined,
      createdAt: now,
      updatedAt: now,
    };

    await this.atomicWriteScheduleJson(id, schedule);
    this.emit("schedule:created", schedule);
    return schedule;
  }

  async getSchedule(id: string): Promise<ScheduledTask> {
    const filePath = this.schedulePath(id);
    if (!existsSync(filePath)) {
      throw Object.assign(new Error(`Schedule '${id}' not found`), { code: "ENOENT" });
    }
    return this.readScheduleJson(id);
  }

  async listSchedules(): Promise<ScheduledTask[]> {
    if (!existsSync(this.automationsDir)) return [];

    const entries = await readdir(this.automationsDir);
    const schedules: ScheduledTask[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) continue;
      const id = entry.replace(/\.json$/, "");
      try {
        schedules.push(await this.readScheduleJson(id));
      } catch {
        // skip invalid files
      }
    }

    return schedules.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateSchedule(id: string, updates: ScheduledTaskUpdateInput): Promise<ScheduledTask> {
    return this.withScheduleLock(id, async () => {
      const schedule = await this.getSchedule(id);

      if (updates.name !== undefined) {
        if (!updates.name.trim()) throw new Error("Name cannot be empty");
        schedule.name = updates.name.trim();
      }
      if (updates.description !== undefined) {
        schedule.description = updates.description?.trim() || undefined;
      }
      if (updates.command !== undefined) {
        if (!updates.command.trim()) throw new Error("Command cannot be empty");
        schedule.command = updates.command.trim();
      }
      if (updates.steps !== undefined) {
        schedule.steps = updates.steps.length > 0 ? updates.steps : undefined;
      }
      if (updates.timeoutMs !== undefined) {
        schedule.timeoutMs = updates.timeoutMs;
      }

      // Handle schedule type / cron changes
      if (updates.scheduleType !== undefined || updates.cronExpression !== undefined) {
        const newType = updates.scheduleType ?? schedule.scheduleType;
        let newCron: string;

        if (newType === "custom") {
          const customCron = updates.cronExpression ?? schedule.cronExpression;
          if (!customCron?.trim()) {
            throw new Error("Cron expression is required for custom schedule type");
          }
          if (!AutomationStore.isValidCron(customCron)) {
            throw new Error(`Invalid cron expression: "${customCron}"`);
          }
          newCron = customCron.trim();
        } else {
          newCron = AUTOMATION_PRESETS[newType as Exclude<ScheduleType, "custom">];
        }

        schedule.scheduleType = newType;
        schedule.cronExpression = newCron;
      }

      if (updates.enabled !== undefined) {
        schedule.enabled = updates.enabled;
      }

      // Recompute next run if enabled
      if (schedule.enabled) {
        schedule.nextRunAt = this.computeNextRun(schedule.cronExpression);
      } else {
        schedule.nextRunAt = undefined;
      }

      schedule.updatedAt = new Date().toISOString();
      await this.atomicWriteScheduleJson(id, schedule);
      this.emit("schedule:updated", schedule);
      return schedule;
    });
  }

  /**
   * Reorder the steps of a schedule by providing the step IDs in the desired order.
   * The `stepIds` array must contain exactly the same IDs as the current steps.
   */
  async reorderSteps(scheduleId: string, stepIds: string[]): Promise<ScheduledTask> {
    return this.withScheduleLock(scheduleId, async () => {
      const schedule = await this.getSchedule(scheduleId);
      if (!schedule.steps || schedule.steps.length === 0) {
        throw new Error("Schedule has no steps to reorder");
      }
      if (stepIds.length !== schedule.steps.length) {
        throw new Error(
          `Step ID count mismatch: expected ${schedule.steps.length}, got ${stepIds.length}`,
        );
      }

      const stepMap = new Map(schedule.steps.map((s) => [s.id, s]));
      const reordered = [];
      for (const id of stepIds) {
        const step = stepMap.get(id);
        if (!step) {
          throw new Error(`Unknown step ID: "${id}"`);
        }
        reordered.push(step);
      }

      schedule.steps = reordered;
      schedule.updatedAt = new Date().toISOString();
      await this.atomicWriteScheduleJson(scheduleId, schedule);
      this.emit("schedule:updated", schedule);
      return schedule;
    });
  }

  async deleteSchedule(id: string): Promise<ScheduledTask> {
    return this.withScheduleLock(id, async () => {
      const schedule = await this.getSchedule(id);
      const filePath = this.schedulePath(id);
      const { unlink } = await import("node:fs/promises");
      await unlink(filePath);
      this.emit("schedule:deleted", schedule);
      return schedule;
    });
  }

  /**
   * Record a run result for a schedule. Updates lastRunAt, lastRunResult,
   * nextRunAt, runCount, and appends to runHistory.
   */
  async recordRun(id: string, result: AutomationRunResult): Promise<ScheduledTask> {
    return this.withScheduleLock(id, async () => {
      const schedule = await this.getSchedule(id);

      schedule.lastRunAt = result.startedAt;
      schedule.lastRunResult = result;
      schedule.runCount += 1;

      // Prepend to history (most recent first), cap at MAX_RUN_HISTORY
      schedule.runHistory.unshift(result);
      if (schedule.runHistory.length > MAX_RUN_HISTORY) {
        schedule.runHistory = schedule.runHistory.slice(0, MAX_RUN_HISTORY);
      }

      // Recompute next run
      if (schedule.enabled) {
        schedule.nextRunAt = this.computeNextRun(schedule.cronExpression);
      }

      schedule.updatedAt = new Date().toISOString();
      await this.atomicWriteScheduleJson(id, schedule);
      this.emit("schedule:run", { schedule, result });
      return schedule;
    });
  }

  /**
   * Get all schedules that are due to run (nextRunAt <= now and enabled).
   */
  async getDueSchedules(): Promise<ScheduledTask[]> {
    const schedules = await this.listSchedules();
    const now = new Date().toISOString();

    return schedules.filter(
      (s) => s.enabled && s.nextRunAt && s.nextRunAt <= now,
    );
  }
}
