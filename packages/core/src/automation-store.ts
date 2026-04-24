import { EventEmitter } from "node:events";
import { join } from "node:path";
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
import { Database, fromJson } from "./db.js";

const CRON_TIMEZONE = "UTC";

export interface AutomationStoreEvents {
  "schedule:created": [schedule: ScheduledTask];
  "schedule:updated": [schedule: ScheduledTask];
  "schedule:deleted": [schedule: ScheduledTask];
  "schedule:run": [data: { schedule: ScheduledTask; result: AutomationRunResult }];
}

/** Database row shape for the automations table. */
interface ScheduleRow {
  id: string;
  name: string;
  description: string | null;
  scheduleType: string;
  cronExpression: string;
  command: string;
  enabled: number;
  timeoutMs: number | null;
  steps: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunResult: string | null;
  runCount: number;
  runHistory: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export class AutomationStore extends EventEmitter<AutomationStoreEvents> {
  /** Per-schedule promise chain for serializing writes. */
  private scheduleLocks: Map<string, Promise<void>> = new Map();
  /** SQLite database instance */
  private _db: Database | null = null;

  constructor(private rootDir: string) {
    super();
  }

  /**
   * Get the SQLite database, initializing it on first access.
   */
  private get db(): Database {
    if (!this._db) {
      const fusionDir = join(this.rootDir, ".fusion");
      this._db = new Database(fusionDir);
      this._db.init();
    }
    return this._db;
  }

  /** Initialize the store. */
  async init(): Promise<void> {
    // Ensure DB is initialized
    const _ = this.db;
  }

  // ── Row Conversion ─────────────────────────────────────────────────

  private rowToSchedule(row: ScheduleRow): ScheduledTask {
    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      scheduleType: row.scheduleType as ScheduleType,
      cronExpression: row.cronExpression,
      command: row.command,
      enabled: row.enabled === 1,
      timeoutMs: row.timeoutMs ?? undefined,
      steps: fromJson<ScheduledTask["steps"]>(row.steps),
      nextRunAt: row.nextRunAt || undefined,
      lastRunAt: row.lastRunAt || undefined,
      lastRunResult: fromJson<AutomationRunResult>(row.lastRunResult),
      runCount: row.runCount || 0,
      runHistory: fromJson<AutomationRunResult[]>(row.runHistory) || [],
      scope: (row.scope as "global" | "project") || "project",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private upsertSchedule(schedule: ScheduledTask): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO automations (
        id, name, description, scheduleType, cronExpression, command,
        enabled, timeoutMs, steps, nextRunAt, lastRunAt, lastRunResult,
        runCount, runHistory, scope, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      schedule.id,
      schedule.name,
      schedule.description ?? null,
      schedule.scheduleType,
      schedule.cronExpression,
      schedule.command,
      schedule.enabled ? 1 : 0,
      schedule.timeoutMs ?? null,
      schedule.steps ? JSON.stringify(schedule.steps) : null,
      schedule.nextRunAt ?? null,
      schedule.lastRunAt ?? null,
      schedule.lastRunResult ? JSON.stringify(schedule.lastRunResult) : null,
      schedule.runCount || 0,
      JSON.stringify(schedule.runHistory || []),
      schedule.scope ?? "project",
      schedule.createdAt,
      schedule.updatedAt,
    );
  }

  // ── Locking ────────────────────────────────────────────────────────

  /**
   * Serialize all mutations to a given schedule by chaining promises.
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

  // ── Persistence ────────────────────────────────────────────────────

  private async readScheduleJson(id: string): Promise<ScheduledTask> {
    const row = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as unknown as ScheduleRow | undefined;
    if (!row) {
      throw Object.assign(new Error(`Schedule '${id}' not found`), { code: "ENOENT" });
    }
    return this.rowToSchedule(row);
  }

  private async persistSchedule(schedule: ScheduledTask): Promise<void> {
    this.upsertSchedule(schedule);
    this.db.bumpLastModified();
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
      tz: CRON_TIMEZONE,
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
      scope: input.scope ?? "project",
      createdAt: now,
      updatedAt: now,
    };

    await this.persistSchedule(schedule);
    this.emit("schedule:created", schedule);
    return schedule;
  }

  async getSchedule(id: string): Promise<ScheduledTask> {
    return this.readScheduleJson(id);
  }

  async listSchedules(): Promise<ScheduledTask[]> {
    const rows = this.db.prepare('SELECT * FROM automations ORDER BY createdAt ASC').all() as unknown as ScheduleRow[];
    return rows.map((row) => this.rowToSchedule(row));
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
      await this.persistSchedule(schedule);
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
      await this.persistSchedule(schedule);
      this.emit("schedule:updated", schedule);
      return schedule;
    });
  }

  async deleteSchedule(id: string): Promise<ScheduledTask> {
    return this.withScheduleLock(id, async () => {
      const schedule = await this.getSchedule(id);
      // Delete from SQLite
      this.db.prepare('DELETE FROM automations WHERE id = ?').run(id);
      this.db.bumpLastModified();
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
      await this.persistSchedule(schedule);
      this.emit("schedule:run", { schedule, result });
      return schedule;
    });
  }

  /**
   * Get all schedules that are due to run (nextRunAt <= now and enabled).
   * Filters by scope: "global" or "project".
   */
  async getDueSchedules(scope: "global" | "project"): Promise<ScheduledTask[]> {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      'SELECT * FROM automations WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ? AND scope = ?'
    ).all(now, scope) as unknown as ScheduleRow[];
    return rows.map((row) => this.rowToSchedule(row));
  }

  /**
   * Get all schedules that are due to run (nextRunAt <= now and enabled) for both scopes.
   * Returns schedules from both "global" and "project" scopes.
   */
  async getDueSchedulesAllScopes(): Promise<ScheduledTask[]> {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      'SELECT * FROM automations WHERE enabled = 1 AND nextRunAt IS NOT NULL AND nextRunAt <= ?'
    ).all(now) as unknown as ScheduleRow[];
    return rows.map((row) => this.rowToSchedule(row));
  }
}
